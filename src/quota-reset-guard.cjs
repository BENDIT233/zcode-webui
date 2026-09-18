// Quota-reset auto-use guard for the official runtime ("重置机会" optimizer).
//
// The coding plan occasionally grants reset chances ("获得 N 次重置额度"):
// one kind refills the 5-hour prompt pool, the other the weekly quota. Each
// chance has its own expiry. The official UI only uses them when a human
// clicks. Policy implemented here (per the operator's rules):
//
//   - no reset while idle and the chance is not about to expire (pointless);
//   - FIVE_HOUR: reset when a task is actively running AND the 5h pool is
//     almost exhausted (remaining ratio at/below the threshold);
//   - WEEK: same, with its own thresholds (chances live longer, so the
//     expiry-rescue window is wider);
//   - expiry rescue: a chance about to lapse is used anyway when the pool has
//     enough usage for the reset to matter (else it is still wasted);
//   - never twice for the same pool without a fresh /status confirming the
//     previous use; cooldown between uses; hard daily cap.
//
// Mechanism (all inside the host process, preloaded via NODE_OPTIONS):
//   observe  — fetch is wrapped; responses for coding-plan/reset/status and
//              the billing/quota endpoints are cloned and parsed (chances +
//              pool buckets). Requests carrying BOTH auth headers have those
//              headers captured for replay (this is exactly the header set the
//              runtime itself sends; credentials never touch the disk).
//   refresh  — with captured headers younger than HEADER_MAX_AGE, GET
//              .../reset/status on a slow cadence (read-only) so the engine
//              keeps working while no UI is attached.
//   decide   — pure decide() below; inputs: chances, pool buckets, task
//              activity (read-only query on the official tasks index, same
//              access pattern as the webui server's reaper), exhaustion
//              signals appended by the child-process observers.
//   act      — POST .../reset/use with a fresh idempotency key, then poll
//              /status until the chance count drops (confirm). In dry-run the
//              decision is logged and nothing is sent.
//
// Everything lands on stderr ("[zcode-webui] quota-reset-guard: …") and in
// ${ZCODE_WEBUI_GUARD_STATS_DIR}/quota-reset-guard.json (surfaced in
// /api/health → guards.quotaReset).
//
// Knobs (env): ZCODE_WEBUI_QUOTA_RESET=on|dry-run|off (default on),
// _TICK_MS, _STATUS_REFRESH_MS, _FIVE_HOUR_MIN_RATIO, _WEEK_MIN_RATIO,
// _EXPIRY_SOON_FIVE_HOUR_MS, _EXPIRY_SOON_WEEK_MS, _RESCUE_MIN_USED,
// _COOLDOWN_MS, _MAX_USES_PER_DAY, _HEADER_MAX_AGE_MS, _ACTIVITY_WINDOW_MS.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_KEY = Symbol.for('zcode-webui.quota-reset-guard');
const RESET_BASE = '/api/v1/coding-plan/reset';
const OBSERVED_URL_RE = /\/api\/v1\/coding-plan\/reset\/(status|opportunity)|\/api\/v1\/zcode-plan\/billing\/(balance|current)|\/api\/monitor\/usage\/quota\/limit/;
const AUTH_HEADER = 'authorization';
const PLAN_AUTH_HEADER = 'x-bigmodel-authorization';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const envNum = (name, dflt) => {
  const v = num(process.env[name]);
  return v === null || v < 0 ? dflt : v;
};

const CFG = {
  mode: (process.env.ZCODE_WEBUI_QUOTA_RESET || 'on').trim().toLowerCase(),
  tickMs: envNum('ZCODE_WEBUI_QUOTA_RESET_TICK_MS', 60_000),
  statusRefreshMs: envNum('ZCODE_WEBUI_QUOTA_RESET_STATUS_REFRESH_MS', 10 * 60_000),
  fiveHourMinRatio: envNum('ZCODE_WEBUI_QUOTA_RESET_FIVE_HOUR_MIN_RATIO', 0.05),
  weekMinRatio: envNum('ZCODE_WEBUI_QUOTA_RESET_WEEK_MIN_RATIO', 0.05),
  expirySoonFiveHourMs: envNum('ZCODE_WEBUI_QUOTA_RESET_EXPIRY_SOON_FIVE_HOUR_MS', 30 * 60_000),
  expirySoonWeekMs: envNum('ZCODE_WEBUI_QUOTA_RESET_EXPIRY_SOON_WEEK_MS', 2 * 3600_000),
  rescueMinUsed: envNum('ZCODE_WEBUI_QUOTA_RESET_RESCUE_MIN_USED', 0.30),
  cooldownMs: envNum('ZCODE_WEBUI_QUOTA_RESET_COOLDOWN_MS', 10 * 60_000),
  maxUsesPerDay: envNum('ZCODE_WEBUI_QUOTA_RESET_MAX_USES_PER_DAY', 6),
  headerMaxAgeMs: envNum('ZCODE_WEBUI_QUOTA_RESET_HEADER_MAX_AGE_MS', 12 * 3600_000),
  activityWindowMs: envNum('ZCODE_WEBUI_QUOTA_RESET_ACTIVITY_WINDOW_MS', 10 * 60_000),
};

const STATS_DIR = process.env.ZCODE_WEBUI_GUARD_STATS_DIR || '';
const STATE_FILE = STATS_DIR ? path.join(STATS_DIR, 'quota-reset-guard.json') : '';
const SIGNALS_FILE = STATS_DIR ? path.join(STATS_DIR, 'quota-reset-signals.log') : '';
// balance snapshots older than this are ignored for the predictive trigger
const BUCKET_MAX_AGE_MS = envNum('ZCODE_WEBUI_QUOTA_RESET_BUCKET_MAX_AGE_MS', 2 * 3600_000);

const STATS = { statusFetches: 0, statusObservations: 0, balanceObservations: 0, signals: 0, usesAttempted: 0, usesConfirmed: 0, usesFailed: 0 };

function log(message) {
  try { process.stderr.write('[zcode-webui] quota-reset-guard: ' + message + '\n'); } catch (_e) { /* ignore */ }
}

// ---------- state ----------
const S = {
  headers: null,          // { at, Authorization, XBigmodelAuthorization, targetType, organization, project }
  status: null,           // { at, fiveHourResets: [ms], weekResets: [ms], lastFiveHourUsedAt, lastWeekUsedAt }
  buckets: null,          // { at, FIVE_HOUR?: {remaining, total, ratio, usedRatio, expiresAt}, WEEK?: {...} }
  exhaustionAt: 0,        // last 402-style signal from a model call (children append, host drains)
  lastUsedAt: 0,
  lastUsedType: null,
  usesDay: '',            // YYYY-MM-DD for the daily cap
  usesToday: 0,
  wantStatusRefreshAt: 0, // bump to pull a fresh /status sooner than the cadence
  lastDecision: null,     // { at, fired, type, reason } for observability
  busyCheckedAt: 0,
  busy: false,
  confirmed: true,        // false after a use until /status confirms it landed
};

function dayKey(now) {
  const d = new Date(now);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function writeState(extra = {}) {
  if (!STATE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      at: Date.now(), mode: CFG.mode, pid: process.pid, stats: STATS,
      headersAt: S.headers ? S.headers.at : null,
      status: S.status, buckets: S.buckets, busy: S.busy,
      usesToday: S.usesToday, lastUsedAt: S.lastUsedAt, lastUsedType: S.lastUsedType,
      confirmed: S.confirmed, lastDecision: S.lastDecision,
      ...extra,
    }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (_e) { /* observability only */ }
}

// ---------- decision engine (pure; unit-tested directly) ----------
//
// inputs:
//   now                     ms epoch
//   fiveHourResets/weekResets  [expireAt ms] (may be empty)
//   fiveHourBucket/weekBucket  { total, remaining } or null (unknown pool)
//   busy                    a task streamed an update inside the activity window
//   exhaustedSignalAt       ms of the last hard quota-exhaustion signal (0 = none)
//   headersAgeMs            age of the captured auth headers (null = none)
//   usesToday, cooldownLeftMs, dailyCapLeft, confirmed, now
function decide(i) {
  const no = (reason) => ({ fired: false, reason });
  if (i.mode === 'off') return no('mode off');
  if (i.headersAgeMs === null || i.headersAgeMs > i.headerMaxAgeMs) return no('no fresh auth headers (open the UI once / keep HEADER_MAX_AGE)');
  if (i.dailyCapLeft <= 0) return no('daily cap reached');
  if (!i.confirmed) return no('waiting for /status to confirm the previous use');
  if (i.cooldownLeftMs > 0) return no('cooldown ' + Math.round(i.cooldownLeftMs / 1000) + 's');

  const pools = [
    {
      type: 'FIVE_HOUR', resets: i.fiveHourResets || [], bucket: i.fiveHourBucket,
      minRatio: i.fiveHourMinRatio, expirySoonMs: i.expirySoonFiveHourMs,
    },
    {
      type: 'WEEK', resets: i.weekResets || [], bucket: i.weekBucket,
      minRatio: i.weekMinRatio, expirySoonMs: i.expirySoonWeekMs,
    },
  ];
  for (const p of pools) {
    if (!p.resets.length) continue;
    const nextExpire = Math.min(...p.resets);
    const expiringIn = nextExpire - i.now;
    const ratio = p.bucket && p.bucket.total > 0 ? p.bucket.remaining / p.bucket.total : null;
    const used = ratio === null ? null : 1 - ratio;
    const exhaustedHard = i.exhaustedSignalAt > 0 && i.now - i.exhaustedSignalAt < 15 * 60_000;

    // main rule: pool almost gone (predicted) or already gone (hard signal),
    // AND something is running that needs the quota right now
    if ((ratio !== null && ratio <= p.minRatio) || exhaustedHard) {
      if (i.busy) return { fired: true, type: p.type, reason: (ratio !== null ? 'pool remaining ' + Math.round(ratio * 100) + '%' : 'quota-exhausted signal') + ' with an active task' };
      // idle but the pool is empty AND the chance would lapse before it can help:
      // use it when the chance is the only thing standing between "empty now" and
      // "empty later" — still bounded by expiry urgency below to stay conservative
      if (exhaustedHard && expiringIn <= p.expirySoonMs) {
        return { fired: true, type: p.type, reason: 'quota-exhausted and chance expires in ' + Math.round(expiringIn / 60_000) + 'min' };
      }
    }
    // expiry rescue: the chance lapses soon and the pool has enough usage that a
    // reset is worth something (a nearly-full pool would waste it)
    if (expiringIn <= p.expirySoonMs && (used === null || used >= i.rescueMinUsed)) {
      return { fired: true, type: p.type, reason: 'chance expires in ' + Math.round(expiringIn / 60_000) + 'min' + (used === null ? '' : ', pool ' + Math.round(used * 100) + '% used') };
    }
  }
  return no('nothing urgent (idle/pool healthy/chances not expiring)');
}

// ---------- observation ----------
function headerFrom(init, input, name) {
  const sources = [init && init.headers, input && typeof input.headers !== 'undefined' && input.headers];
  for (const h of sources) {
    if (!h) continue;
    if (typeof h.get === 'function') { const v = h.get(name); if (v) return v; continue; }
    if (typeof h === 'object') {
      for (const [k, v] of Object.entries(h)) {
        if (k.toLowerCase() === name && typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

function captureHeaders(url, init, input) {
  if (!/zcode\.z\.ai\//.test(url)) return;
  const auth = headerFrom(init, input, AUTH_HEADER);
  const plan = headerFrom(init, input, PLAN_AUTH_HEADER);
  if (!auth || !plan) return;
  const prevAt = S.headers ? S.headers.at : 0;
  S.headers = {
    at: Date.now(),
    Authorization: auth,
    XBigmodelAuthorization: plan,
    targetType: headerFrom(init, input, 'bigmodel-target-type'),
    organization: headerFrom(init, input, 'bigmodel-organization'),
    project: headerFrom(init, input, 'bigmodel-project'),
  };
  // quiet confirmation that the capture path works in the field (first time and
  // after long gaps only — this runs on every authorized request)
  if (!prevAt || S.headers.at - prevAt > 6 * 3600_000) {
    log('auth headers captured from the runtime\'s own request (' + url.slice(0, 80) + ')');
  }
}

function classifyNamed(b) {
  const label = `${b.show_name || ''} ${Array.isArray(b.capabilities) ? b.capabilities.join(' ') : ''}`;
  if (/5\s*小时|5h|five[- ]?hour/i.test(label)) return 'FIVE_HOUR';
  if (/周|week/i.test(label)) return 'WEEK';
  return null;
}

function classifyByWindow(b, now) {
  const exp = num(b.expires_at);
  if (exp === null) return null;
  const win = exp * (exp > 1e11 ? 1 : 1000) - now;   // balances are unix SECONDS
  if (win > 0 && win <= 6 * 3600_000) return 'FIVE_HOUR';
  if (win > 6 * 3600_000 && win <= 8 * 86400_000) return 'WEEK';
  return null;
}

function classifyBucket(b, now) {
  return classifyNamed(b) || classifyByWindow(b, now);
}

async function observeResponse(url, res) {
  let json = null;
  try { json = await res.clone().json(); } catch (_e) { return; }
  const data = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : null;
  if (!data) return;
  if (url.indexOf(RESET_BASE + '/status') >= 0 && Array.isArray(data.available_five_hour_resets)) {
    STATS.statusObservations++;
    S.status = {
      at: Date.now(),
      fiveHourResets: data.available_five_hour_resets.map((o) => num(o && o.expire_at) || 0).filter(Boolean),
      weekResets: (data.available_week_resets || []).map((o) => num(o && o.expire_at) || 0).filter(Boolean),
      lastFiveHourUsedAt: num(data.latest_five_hour_reset_history && data.latest_five_hour_reset_history.used_at),
      lastWeekUsedAt: num(data.latest_week_reset_history && data.latest_week_reset_history.used_at),
    };
    // a fresh status after a use is the confirmation the engine waits for
    if (S.lastUsedAt && S.status.at > S.lastUsedAt) S.confirmed = true;
  }
  // coding-plan pools: GET /api/monitor/usage/quota/limit → data.limits[] with
  // {type, number(total), usage, remaining, nextResetTime} — nextResetTime rolls
  // in ≤6h for the 5h pool and ≤7d for the weekly one, which is the classifier.
  // limits carry explicit types and outrank the balance heuristics below.
  if (Array.isArray(data.limits)) {
    STATS.balanceObservations++;
    const now = Date.now();
    if (!S.buckets) S.buckets = { at: 0 };
    for (const L of data.limits) {
      if (!L || typeof L.type !== 'string') continue;
      const total = num(L.number);
      let remaining = num(L.remaining);
      if (remaining === null && total !== null && num(L.usage) !== null) remaining = Math.max(0, total - num(L.usage));
      if (total === null || remaining === null) continue;
      const nextRaw = num(L.nextResetTime);
      const nextMs = nextRaw === null ? null : nextRaw * (nextRaw > 1e11 ? 1 : 1000);
      let kind = null;
      if (/five|5h|hour/i.test(L.type)) kind = 'FIVE_HOUR';
      else if (/week|周/i.test(L.type)) kind = 'WEEK';
      else if (nextMs !== null) {
        const win = nextMs - now;
        if (win > 0 && win <= 6 * 3600_000) kind = 'FIVE_HOUR';
        else if (win > 6 * 3600_000 && win <= 8 * 86400_000) kind = 'WEEK';
      }
      if (!kind) continue;
      S.buckets[kind] = { total, remaining, expiresAt: nextMs, showName: 'limit:' + L.type, src: 'limit', at: now };
    }
    S.buckets.at = now;
  }
  if (Array.isArray(data.balances)) {
    STATS.balanceObservations++;
    const now = Date.now();
    // Named classifications win over window heuristics; within the same kind the
    // bucket expiring SOONEST is the binding constraint.
    const picked = {};
    const consider = (b, named) => {
      const kind = named ? classifyNamed(b) : classifyByWindow(b, now);
      if (!kind) return;
      const total = num(b.total_units), remaining = num(b.remaining_units);
      if (total === null || remaining === null) return;
      const expRaw = num(b.expires_at);
      const expMs = expRaw === null ? null : expRaw * (expRaw > 1e11 ? 1 : 1000);
      const fields = { total, remaining, expiresAt: expMs, showName: typeof b.show_name === 'string' ? b.show_name : '' };
      const prev = picked[kind];
      if (!prev) { picked[kind] = { ...fields, named }; return; }
      if (prev.named && !named) return;   // a named bucket outranks a heuristic one
      if (named === prev.named && (fields.expiresAt ?? Infinity) < (prev.expiresAt ?? Infinity)) picked[kind] = { ...fields, named };
    };
    for (const b of data.balances) consider(b, true);
    for (const b of data.balances) consider(b, false);
    if (!S.buckets) S.buckets = { at: 0 };
    for (const [kind, fields] of Object.entries(picked)) {
      const existing = S.buckets[kind];
      // a fresh limits[] entry (explicit type) is only displaced by newer limits data
      if (existing && existing.src === 'limit' && now - (existing.at || 0) <= 30 * 60_000) continue;
      const { named: _drop, ...rest } = fields;
      S.buckets[kind] = { ...rest, src: 'balance', at: now };
    }
    S.buckets.at = now;
  }
}

// ---------- authorized calls (header replay — same headers the runtime sent) ----------
function replayHeaders() {
  const h = S.headers;
  if (!h) return null;
  const out = {
    'Authorization': h.Authorization,
    'X-Bigmodel-Authorization': h.XBigmodelAuthorization,
    'Bigmodel-Target-Type': h.targetType || 'PERSONAL',
  };
  if (h.organization) out['Bigmodel-Organization'] = h.organization;
  if (h.project) out['Bigmodel-Project'] = h.project;
  return out;
}

function apiUrl(p) {
  const m = /(https:\/\/[^/]*zcode\.z\.ai)/.exec(process.env.ZCODE_BASE_URL || '') ;
  return (m ? m[1] : 'https://zcode.z.ai') + p;
}

async function fetchStatus() {
  const h = replayHeaders();
  if (!h) return;
  STATS.statusFetches++;
  const res = await fetch(apiUrl(RESET_BASE + '/status'), { method: 'GET', headers: h, signal: AbortSignal.timeout(15_000) });
  await observeResponse(apiUrl(RESET_BASE + '/status'), res);
}

async function useReset(type) {
  const h = replayHeaders();
  if (!h) return { ok: false, error: 'no headers' };
  const idempotencyKey = crypto.randomUUID();
  STATS.usesAttempted++;
  const res = await fetch(apiUrl(RESET_BASE + '/use'), {
    method: 'POST',
    headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotency_key: idempotencyKey, reset_type: type }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 0 || !json.data || json.data.used !== true) {
    throw new Error('use failed: HTTP ' + res.status + ' code=' + (json && json.code) + ' msg=' + (json && json.msg));
  }
  // confirm: the chance must leave the status list (a few slow polls)
  for (let delay of [4000, 8000, 15000]) {
    await new Promise((r) => setTimeout(r, delay));
    const before = S.status ? (type === 'FIVE_HOUR' ? S.status.fiveHourResets : S.status.weekResets).length : null;
    await fetchStatus().catch(() => {});
    const list = S.status ? (type === 'FIVE_HOUR' ? S.status.fiveHourResets : S.status.weekResets) : [];
    const hist = S.status ? (type === 'FIVE_HOUR' ? S.status.lastFiveHourUsedAt : S.status.lastWeekUsedAt) : null;
    if ((before !== null && list.length < before) || (hist && hist > S.lastUsedAt)) return { ok: true, confirmed: true };
  }
  return { ok: true, confirmed: false };
}

// ---------- task activity (read-only, same access pattern as the webui reaper) ----------
function refreshBusy() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const zhome = process.env.ZCODE_HOME ? path.join(process.env.ZCODE_HOME) : path.join(require('node:os').homedir(), '.zcode');
    const db = new DatabaseSync(path.join(zhome, 'v2', 'tasks-index.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE task_status = ? AND updated_at > ?')
        .get('running', Date.now() - CFG.activityWindowMs);
      S.busy = (row && row.n) > 0;
    } finally { db.close(); }
    S.busyCheckedAt = Date.now();
  } catch (_e) {
    S.busy = false;   // conservative for the main rule; expiry rescue does not need it
  }
}

function drainSignals() {
  if (!SIGNALS_FILE) return;
  try {
    const lines = fs.readFileSync(SIGNALS_FILE, 'utf8').trim();
    if (!lines) return;
    fs.writeFileSync(SIGNALS_FILE, '');
    for (const line of lines.split('\n')) {
      try {
        const j = JSON.parse(line);
        if (j && j.kind === 'quota-exhausted' && num(j.at)) { S.exhaustionAt = Math.max(S.exhaustionAt, j.at); STATS.signals++; }
      } catch (_e) { /* malformed line */ }
    }
  } catch (_e) { /* no signals file yet */ }
}

// ---------- engine loop (host process only) ----------
let engineRunning = false;
async function tick() {
  if (engineRunning) return;
  engineRunning = true;
  try {
    drainSignals();
    refreshBusy();
    const now = Date.now();
    const headersOk = S.headers && now - S.headers.at <= CFG.headerMaxAgeMs;
    const statusStale = !S.status || now - S.status.at > CFG.statusRefreshMs
      || (S.wantStatusRefreshAt && now >= S.wantStatusRefreshAt);
    if (headersOk && statusStale) {
      S.wantStatusRefreshAt = 0;
      await fetchStatus().catch((e) => log('status refresh failed: ' + (e && e.message)));
    }

    if (S.usesDay !== dayKey(now)) { S.usesDay = dayKey(now); S.usesToday = 0; }
    const d = decide({
      now, mode: CFG.mode,
      fiveHourResets: S.status ? S.status.fiveHourResets : [],
      weekResets: S.status ? S.status.weekResets : [],
      // stale balance data must not drive the predictive trigger — with no UI
      // attached nobody refreshes billing, and an old "5% left" may be long gone
      fiveHourBucket: (S.buckets && now - S.buckets.at <= BUCKET_MAX_AGE_MS && S.buckets.FIVE_HOUR) || null,
      weekBucket: (S.buckets && now - S.buckets.at <= BUCKET_MAX_AGE_MS && S.buckets.WEEK) || null,
      busy: S.busy,
      exhaustedSignalAt: S.exhaustionAt,
      headersAgeMs: S.headers ? now - S.headers.at : null,
      usesToday: S.usesToday,
      cooldownLeftMs: S.lastUsedAt ? Math.max(0, CFG.cooldownMs - (now - S.lastUsedAt)) : 0,
      dailyCapLeft: CFG.maxUsesPerDay - S.usesToday,
      confirmed: S.confirmed,
      fiveHourMinRatio: CFG.fiveHourMinRatio, weekMinRatio: CFG.weekMinRatio,
      expirySoonFiveHourMs: CFG.expirySoonFiveHourMs, expirySoonWeekMs: CFG.expirySoonWeekMs,
      rescueMinUsed: CFG.rescueMinUsed, headerMaxAgeMs: CFG.headerMaxAgeMs,
    });
    const changed = !S.lastDecision || S.lastDecision.fired !== d.fired || S.lastDecision.reason !== d.reason
      || (now - (S.lastDecision.at || 0) > 30 * 60_000);
    S.lastDecision = { at: now, fired: d.fired, type: d.type || null, reason: d.reason };
    if (changed) {
      log((d.fired ? 'DECISION use ' + d.type + ' — ' : 'decision: ') + d.reason
        + ' (chances 5h=' + ((S.status && S.status.fiveHourResets || []).length) + ' week=' + ((S.status && S.status.weekResets || []).length) + ')'
        + (CFG.mode === 'dry-run' ? ' [dry-run: not sending]' : ''));
    }
    if (d.fired) {
      if (CFG.mode === 'dry-run') { writeState(); return; }
      S.lastUsedAt = now;
      S.lastUsedType = d.type;
      S.confirmed = false;
      S.usesToday++;
      log('using ' + d.type + ' reset chance (' + d.reason + ') — idempotent POST ' + RESET_BASE + '/use');
      try {
        const r = await useReset(d.type);
        if (r.ok) { STATS.usesConfirmed++; log('use ' + d.type + ' accepted' + (r.confirmed ? ' and confirmed via /status' : ' (status confirmation pending)')); }
      } catch (e) {
        STATS.usesFailed++;
        // Ambiguous outcome: a fresh /status decides whether a chance was really
        // consumed before the engine may consider another use.
        S.wantStatusRefreshAt = Date.now() + 20_000;
        log('use ' + d.type + ' FAILED: ' + (e && e.message) + ' — pausing until the next /status confirms nothing was consumed');
      }
      writeState();
    } else if (changed) {
      writeState();
    }
  } catch (e) {
    log('tick error: ' + (e && e.message));
  } finally {
    engineRunning = false;
  }
}

// ---------- child-process observation (append-only signal sink) ----------
function appendSignal(kind) {
  if (!SIGNALS_FILE) return;
  try {
    fs.mkdirSync(path.dirname(SIGNALS_FILE), { recursive: true });
    fs.appendFileSync(SIGNALS_FILE, JSON.stringify({ kind, at: Date.now(), pid: process.pid }) + '\n');
  } catch (_e) { /* signals are best-effort */ }
}

// ---------- install ----------
function install() {
  const downstream = globalThis.fetch;
  if (typeof downstream !== 'function') return;
  globalThis.fetch = async function quotaResetGuardedFetch(input, init) {
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && typeof input.url === 'string') url = input.url;
    else if (input instanceof URL) url = input.href;
    try { captureHeaders(url, init, input && typeof input === 'object' ? input : null); } catch (_e) { /* never break traffic */ }
    const res = await downstream(input, init);
    try {
      if (OBSERVED_URL_RE.test(url)) await observeResponse(url, res);
      else if (res && res.status === 402 && /bigmodel|z\.ai/.test(url)) { STATS.signals++; appendSignal('quota-exhausted'); }
    } catch (_e) { /* observation must never break traffic */ }
    return res;
  };
}

function start() {
  const isHost = process.argv.some((a) => /zcode-server\.cjs$/.test(a))
    || (process.env.ZCODE_WEBUI_QUOTA_RESET_ROLE || '') === 'host';
  if (globalThis[STATE_KEY]) { log('already installed in this process, nothing to do'); return; }
  globalThis[STATE_KEY] = { cfg: CFG, stats: STATS };
  install();
  if (isHost) {
    log('armed (' + CFG.mode + ') — observes reset/billing traffic, decides every '
      + Math.round(CFG.tickMs / 1000) + 's; thresholds: 5h≤' + CFG.fiveHourMinRatio + ' busy, week≤' + CFG.weekMinRatio
      + ' busy, rescue≤' + Math.round(CFG.expirySoonFiveHourMs / 60000) + 'min/' + Math.round(CFG.expirySoonWeekMs / 60000)
      + 'min with ≥' + CFG.rescueMinUsed + ' used; cap ' + CFG.maxUsesPerDay + '/day'
      + (CFG.mode === 'off' ? ' (disabled)' : ''));
    const t = setInterval(() => { tick(); }, CFG.tickMs);
    if (t.unref) t.unref();
    const s = setInterval(() => { writeState(); }, 5 * 60_000);
    if (s.unref) s.unref();
  } else {
    log('observer mode (child process ' + process.pid + ') — captures quota-exhaustion signals only');
  }
}

if (CFG.mode === 'off') {
  log('skipped — ZCODE_WEBUI_QUOTA_RESET=off');
  globalThis[STATE_KEY] = { cfg: CFG, stats: STATS, disabled: true };
} else {
  start();
}

module.exports = {
  cfg: CFG, stats: STATS, decide, classifyBucket, apiUrl,
  __state: S, __captureHeaders: captureHeaders, __observeJson: observeResponse,
  __tick: tick, __useReset: useReset, __fetchStatus: fetchStatus,
};
