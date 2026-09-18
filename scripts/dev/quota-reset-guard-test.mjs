// Offline tests for the quota-reset guard. NOTHING here talks to the real API:
// the module is loaded against a mock globalThis.fetch and a temp stats dir.
//
//   node scripts/dev/quota-reset-guard-test.mjs
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!cond) failures++;
};

const statsDir = mkdtempSync(path.join(tmpdir(), 'quota-reset-test-'));
process.env.ZCODE_WEBUI_GUARD_STATS_DIR = statsDir;
process.env.ZCODE_WEBUI_QUOTA_RESET = 'on';

// ---------- mock upstream (installed BEFORE the guard so it wraps ours) ----------
const calls = [];
const upstream = {
  status: { fiveHour: [], week: [], lastFiveHourUsedAt: 0, lastWeekUsedAt: 0 },
  useResult: { code: 0, data: { used: true } },
};
const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const method = (init && init.method) || 'GET';
  calls.push({ url, method, headers: init && init.headers, body: init && init.body });
  if (url.includes('/api/v1/coding-plan/reset/status')) {
    return jsonResponse({
      code: 0, data: {
        available_five_hour_resets: upstream.status.fiveHour.map((expireAt) => ({ expire_at: expireAt })),
        available_week_resets: upstream.status.week.map((expireAt) => ({ expire_at: expireAt })),
        latest_five_hour_reset_history: upstream.status.lastFiveHourUsedAt ? { used_at: upstream.status.lastFiveHourUsedAt } : null,
        latest_week_reset_history: upstream.status.lastWeekUsedAt ? { used_at: upstream.status.lastWeekUsedAt } : null,
        has_unread_history: false,
      },
    });
  }
  if (url.includes('/api/v1/coding-plan/reset/use')) {
    return jsonResponse(upstream.useResult);
  }
  if (url.includes('/api/v1/zcode-plan/billing/balance')) {
    return jsonResponse({
      code: 0, data: {
        balances: upstream.balances || [],
        plans: [], server_time: Math.floor(Date.now() / 1000),
      },
    });
  }
  if (url.includes('/chat/completions')) {
    return new Response('{"error":"payment required"}', { status: 402 });
  }
  return jsonResponse({ code: 0, data: null });
};

const guard = require(path.join(ROOT, 'src', 'quota-reset-guard.cjs'));
const { decide, __state: S } = guard;
const now = Date.now();
const H = 3600_000;

// ---------- 1. decision matrix (pure) ----------
const base = {
  now, mode: 'on', busy: false,
  fiveHourResets: [now + 5 * H], weekResets: [now + 24 * H],
  fiveHourBucket: { total: 100, remaining: 50 }, weekBucket: { total: 1000, remaining: 500 },
  exhaustedSignalAt: 0, headersAgeMs: 60_000,
  usesToday: 0, cooldownLeftMs: 0, dailyCapLeft: 6, confirmed: true,
  fiveHourMinRatio: 0.05, weekMinRatio: 0.05,
  expirySoonFiveHourMs: 30 * 60_000, expirySoonWeekMs: 2 * H,
  rescueMinUsed: 0.30, headerMaxAgeMs: 12 * H,
};
const d = (over) => decide({ ...base, ...over });

check('off → never fires', d({ mode: 'off' }).fired === false);
check('no auth headers → never fires', d({ headersAgeMs: null }).fired === false);
check('stale auth headers → never fires', d({ headersAgeMs: 13 * H }).fired === false);
check('daily cap reached → never fires', d({ dailyCapLeft: 0 }).fired === false);
check('unconfirmed previous use → never fires', d({ confirmed: false }).fired === false);
check('cooldown → never fires', d({ cooldownLeftMs: 60_000 }).fired === false);
check('no chances → never fires', d({ fiveHourResets: [], weekResets: [] }).fired === false);
check('idle + healthy pool + chance not expiring → NO reset (the core "don\'t waste" rule)', d({}).fired === false);
check('busy + 5h pool ≤ threshold → fires FIVE_HOUR', d({ busy: true, fiveHourBucket: { total: 100, remaining: 3 } }).type === 'FIVE_HOUR');
check('idle + 5h pool ≤ threshold + chance not expiring → holds', d({ fiveHourBucket: { total: 100, remaining: 3 } }).fired === false);
check('idle + hard exhaustion + chance lapsing soon → salvages', d({ exhaustedSignalAt: now, fiveHourResets: [now + 10 * 60_000] }).type === 'FIVE_HOUR');
check('idle + hard exhaustion + chance NOT lapsing → holds', d({ exhaustedSignalAt: now, fiveHourResets: [now + 3 * H] }).fired === false);
check('chance lapsing + pool sufficiently used → rescue fires', d({ fiveHourResets: [now + 20 * 60_000], fiveHourBucket: { total: 100, remaining: 40 } }).type === 'FIVE_HOUR');
check('chance lapsing + nearly fresh pool → holds (reset would be wasted)', d({ fiveHourResets: [now + 20 * 60_000], fiveHourBucket: { total: 100, remaining: 95 } }).fired === false);
check('busy + WEEK pool ≤ threshold (5h healthy) → fires WEEK', d({ busy: true, weekBucket: { total: 1000, remaining: 20 } }).type === 'WEEK');
check('week chance lapsing (≤2h) + used enough → rescue fires', d({ weekResets: [now + H], weekBucket: { total: 1000, remaining: 300 } }).type === 'WEEK');
check('week chance lapsing + fresh pool → holds', d({ weekResets: [now + H], weekBucket: { total: 1000, remaining: 950 } }).fired === false);
check('both pools critical → FIVE_HOUR wins (checked first)', d({ busy: true, fiveHourBucket: { total: 100, remaining: 1 }, weekBucket: { total: 1000, remaining: 1 } }).type === 'FIVE_HOUR');
check('unknown pool + busy → only exhaustion/expiry paths apply', d({ busy: true, fiveHourBucket: null, weekBucket: null }).fired === false);

// ---------- 2. observation through the patched fetch ----------
// authorized status request → headers captured + chances parsed
upstream.status.fiveHour = [now + 5 * H];
upstream.status.week = [now + 48 * H];
await globalThis.fetch('https://zcode.z.ai/api/v1/coding-plan/reset/status', {
  headers: {
    'Authorization': 'Bearer zcode-jwt-test',
    'X-Bigmodel-Authorization': 'Bearer plan-jwt-test',
    'Bigmodel-Target-Type': 'PERSONAL',
  },
});
check('auth headers captured from the runtime\'s own request',
  S.headers && S.headers.Authorization === 'Bearer zcode-jwt-test' && S.headers.XBigmodelAuthorization === 'Bearer plan-jwt-test');
check('/status parsed into chances', S.status && S.status.fiveHourResets.length === 1 && S.status.weekResets.length === 1);

// Headers-instance style capture
await globalThis.fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
  headers: new Headers({ 'Authorization': 'Bearer zj2', 'x-bigmodel-authorization': 'Bearer pj2' }),
});
check('Headers-object style auth also captured', S.headers.XBigmodelAuthorization === 'Bearer pj2');

// balance parsing → bucket classification (5h by name, week by name, fallback by window)
upstream.balances = [
  { show_name: '5 小时 Prompt 池', total_units: 100, used_units: 96, remaining_units: 4, expires_at: Math.floor((now + 2 * H) / 1000) },
  { show_name: '周额度', total_units: 1000, used_units: 100, remaining_units: 900, expires_at: Math.floor((now + 3 * 86400_000) / 1000) },
  { show_name: 'mystery', total_units: 10, used_units: 1, remaining_units: 9, expires_at: Math.floor((now + 45 * 60_000) / 1000) },
];
await globalThis.fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', { headers: { Authorization: 'Bearer zj3', 'X-Bigmodel-Authorization': 'Bearer pj3' } });
check('5h bucket classified by name + numbers recorded', S.buckets.FIVE_HOUR && S.buckets.FIVE_HOUR.remaining === 4 && S.buckets.FIVE_HOUR.total === 100);
check('week bucket classified by name', S.buckets.WEEK && S.buckets.WEEK.remaining === 900);
check('named 5h bucket outranks the unnamed short-window bucket', S.buckets.FIVE_HOUR.remaining === 4 && S.buckets.FIVE_HOUR.showName.includes('5 小时'));
// fallback heuristics only fill kinds with no named bucket
upstream.balances = [
  { show_name: '', total_units: 50, used_units: 10, remaining_units: 40, expires_at: Math.floor((now + 90 * 60_000) / 1000) },
];
await globalThis.fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', { headers: { Authorization: 'Bearer zj4', 'X-Bigmodel-Authorization': 'Bearer pj4' } });
check('unnamed short-window bucket fills FIVE_HOUR when no named one exists', S.buckets.FIVE_HOUR && S.buckets.FIVE_HOUR.remaining === 40,
  'remaining=' + (S.buckets.FIVE_HOUR && S.buckets.FIVE_HOUR.remaining));

// 402 model call → exhaustion signal file appended (child observer path)
await globalThis.fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer x' } });
const signalFile = path.join(statsDir, 'quota-reset-signals.log');
check('402 model response appends an exhaustion signal', existsSync(signalFile) && /quota-exhausted/.test(readFileSync(signalFile, 'utf8')));

// pass-through integrity: unobserved URL returns the exact response untouched
const passthrough = await globalThis.fetch('https://example.com/none');
check('unrelated traffic passes through untouched', passthrough.ok && (await passthrough.json()).code === 0);

// ---------- 3. executor: header replay + idempotency + confirmation ----------
calls.length = 0;
upstream.status.fiveHour = [now + 5 * H];
await guard.__fetchStatus();
upstream.status.fiveHour = [now + 5 * H];   // consume below
const useCallCountBefore = calls.filter((c) => c.url.includes('/reset/use')).length;
const result = await guard.__useReset('FIVE_HOUR');
const useCalls = calls.filter((c) => c.url.includes('/reset/use'));
check('/use sent exactly once', useCalls.length === useCallCountBefore + 1);
const useBody = JSON.parse(useCalls[useCalls.length - 1].body);
check('idempotency key is a ≤64-char uuid', /^[0-9a-f-]{36}$/.test(useBody.idempotency_key) && useBody.idempotency_key.length <= 64);
check('reset_type relayed', useBody.reset_type === 'FIVE_HOUR');
const uh = useCalls[useCalls.length - 1].headers;
check('auth headers replayed for /use', uh.Authorization === 'Bearer zj4' && uh['X-Bigmodel-Authorization'] === 'Bearer pj4' && uh['Bigmodel-Target-Type'] === 'PERSONAL');
check('content-type json on /use', (uh['content-type'] || uh['Content-Type'] || '').includes('application/json'));
check('use accepted', result.ok === true);

// ---------- 4. state file written for /api/health ----------
guard.__tick().catch?.(() => {});   // fire-and-forget is fine; state also written on decisions
await new Promise((r) => setTimeout(r, 300));
// force a state write via a decision change
S.lastDecision = null;
await guard.__tick();
const stateFile = path.join(statsDir, 'quota-reset-guard.json');
check('state file written for /api/health', existsSync(stateFile));
const stateJson = JSON.parse(readFileSync(stateFile, 'utf8'));
check('state file carries chances + decision', stateJson.status && Array.isArray(stateJson.status.fiveHourResets) && stateJson.lastDecision && typeof stateJson.lastDecision.fired === 'boolean');

// ---------- 5. mode behaviours via fresh subprocesses ----------
const probe = (env, script) => new Promise((resolve) => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env, ZCODE_WEBUI_GUARD_STATS_DIR: statsDir },
    encoding: 'utf8', timeout: 30000,
  });
  resolve({ status: r.status, out: (r.stdout || '') + (r.stderr || '') });
});

const dryHome = mkdtempSync(path.join(tmpdir(), 'quota-reset-home-'));
mkdirSync(path.join(dryHome, 'v2'), { recursive: true });
{
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dryHome, 'v2', 'tasks-index.sqlite'));
  db.exec('CREATE TABLE tasks (task_status TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO tasks VALUES (?, ?)').run('running', Date.now());
  db.close();
}
const dry = await probe({
  ZCODE_WEBUI_QUOTA_RESET: 'dry-run', ZCODE_WEBUI_QUOTA_RESET_ROLE: 'host',
  ZCODE_WEBUI_QUOTA_RESET_TICK_MS: '3600000', ZCODE_HOME: dryHome,
}, `
  const g = require(${JSON.stringify(path.join(ROOT, 'src', 'quota-reset-guard.cjs'))});
  const S = g.__state;
  const now = Date.now();
  S.headers = { at: now, Authorization: 'Bearer a', XBigmodelAuthorization: 'Bearer b', targetType: 'PERSONAL' };
  S.status = { at: now - 60000, fiveHourResets: [now + 3600000], weekResets: [], lastFiveHourUsedAt: 0, lastWeekUsedAt: 0 };
  S.buckets = { at: now, FIVE_HOUR: { total: 100, remaining: 2 } };
  S.busy = true; S.confirmed = true; S.usesToday = 0; S.lastUsedAt = 0;
  // hard network isolation: every fetch the engine makes is answered locally
  globalThis.__sent = [];
  globalThis.fetch = async (u) => {
    const s = String(u);
    globalThis.__sent.push(s);
    const hdrs = { 'content-type': 'application/json' };
    if (s.includes('/reset/use')) return new Response('{"code":0,"data":{"used":true}}', { status: 200, headers: hdrs });
    if (s.includes('/reset/status')) return new Response(JSON.stringify({ code: 0, data: { available_five_hour_resets: [], available_week_resets: [], latest_five_hour_reset_history: null, latest_week_reset_history: null, has_unread_history: false } }), { status: 200, headers: hdrs });
    return new Response('{}', { status: 200, headers: hdrs });
  };
  g.__tick().then(() => {
    console.log('DECISION=' + JSON.stringify(S.lastDecision));
    console.log('SENT=' + JSON.stringify(globalThis.__sent.filter((u) => u.includes('/reset/use'))));
    console.log('BUSY=' + S.busy);
  });
`);
check('dry-run decides to fire but sends NOTHING to /use', /DECISION=\{"at":\d+,"fired":true/.test(dry.out) && /SENT=\[\]/.test(dry.out), dry.out.split('\n').filter((l) => /DECISION|SENT|BUSY/.test(l)).join(' | ').slice(0, 200));
check('task activity read from the (synthetic) tasks index', /BUSY=true/.test(dry.out));

const off = await probe({ ZCODE_WEBUI_QUOTA_RESET: 'off' }, `
  const g = require(${JSON.stringify(path.join(ROOT, 'src', 'quota-reset-guard.cjs'))});
  console.log('DISABLED=' + (globalThis[Symbol.for('zcode-webui.quota-reset-guard')].disabled === true));
`);
check('off mode: guard marked disabled, no crash', off.status === 0 && /DISABLED=true/.test(off.out));

// ---------- cleanup ----------
rmSync(statsDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall quota-reset guard checks passed' : '\n' + failures + ' check(s) FAILED');
process.exit(failures === 0 ? 0 : 1);
