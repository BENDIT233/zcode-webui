// Billing/quota request coalescer for the official runtime ("套餐查询失败" fix).
//
// Background — the renderer keeps the plan/quota panels fresh by polling the same read-only
// endpoints over and over (the runtime alone called
// GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance dozens of times per hour on this
// box). When the vendor rate-limits that endpoint the client surfaces it verbatim: the plan
// entry shows "套餐查询失败，重试" (purchase.entry.retry), because every non-`no_plan`
// failure marks the whole entry as error. Observed here: 12 x HTTP 429 on the z.ai balance
// endpoint inside ~3h, against 698 successful calls.
//
// This guard is preloaded into the host process (NODE_OPTIONS --require, injected by
// src/host.mjs, alongside src/repo-snapshot-guard.cjs) and makes that polling cheap and
// resilient:
//   - identical GET responses are cached for TTL ms (default 30s) and replayed, so UI polls
//     do not each become an upstream request;
//   - concurrent identical GETs are coalesced into one upstream call;
//   - when upstream answers 429, the guard enters exponential backoff (60s doubling, capped
//     at 10min): during the window it serves the last good body if it has one (the UI keeps
//     working and reports "ready"), otherwise it returns the 429 without hammering upstream;
//   - only read-only plan/quota paths are touched; everything else passes straight through.
//
// Everything is logged to stderr ("[host:stderr] [zcode-webui] api-cache-guard: ...") so the
// behaviour stays auditable. Escape hatch: ZCODE_WEBUI_BILLING_CACHE_TTL_MS=0 disables it,
// ZCODE_WEBUI_BILLING_CACHE_PATTERN overrides which paths are cached.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_KEY = Symbol.for('zcode-webui.api-cache-guard');
const TTL_MS = Number.isFinite(Number(process.env.ZCODE_WEBUI_BILLING_CACHE_TTL_MS))
  ? Math.max(0, Number(process.env.ZCODE_WEBUI_BILLING_CACHE_TTL_MS))
  : 30_000;
const ENABLED = TTL_MS > 0;
const PATTERN = new RegExp(process.env.ZCODE_WEBUI_BILLING_CACHE_PATTERN
  || '/api/v1/zcode-plan/billing/(balance|current)|/api/monitor/usage/quota/limit|/api/biz/subscription/list');
const BACKOFF_BASE_MS = Number(process.env.ZCODE_WEBUI_BILLING_BACKOFF_BASE_MS) > 0
  ? Number(process.env.ZCODE_WEBUI_BILLING_BACKOFF_BASE_MS)
  : 60_000;
const BACKOFF_MAX_MS = Math.max(BACKOFF_BASE_MS, 600_000);

const STATS = { hits: 0, misses: 0, coalesced: 0, backoffSkips: 0, errors: 0 };
const cache = new Map(); // url -> { at, status, contentType, body: Uint8Array }
const inflight = new Map(); // url -> Promise<{status, contentType, body, ok}>
let backoffUntil = 0;
let backoffMs = BACKOFF_BASE_MS;

// The guard runs inside host processes, not the webui server, so it reports its
// stats through a JSON file the server reads for /api/health. Best-effort only.
const STATS_FILE = process.env.ZCODE_WEBUI_GUARD_STATS_DIR
  ? path.join(process.env.ZCODE_WEBUI_GUARD_STATS_DIR, 'api-cache-guard.json')
  : '';
function writeStats() {
  if (!STATS_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    const tmp = STATS_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), pid: process.pid, ...STATS }));
    fs.renameSync(tmp, STATS_FILE);
  } catch (_e) { /* never disturb the guarded process over observability */ }
}

function log(message) {
  try { process.stderr.write('[zcode-webui] api-cache-guard: ' + message + '\n'); } catch (_e) { /* ignore */ }
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

function methodOf(input, init) {
  const method = (init && init.method) || (input && input.method) || 'GET';
  return String(method).toUpperCase();
}

function isCacheable(url, method) {
  return ENABLED && method === 'GET' && PATTERN.test(url);
}

function replay(entry, label) {
  const headers = new Headers();
  if (entry.contentType) headers.set('content-type', entry.contentType);
  headers.set('x-zcode-webui-cache', label);
  return new Response(entry.body, { status: entry.status, headers });
}

async function readEntry(response) {
  let body = new Uint8Array(0);
  try { body = new Uint8Array(await response.arrayBuffer()); } catch (_e) { /* empty body */ }
  return {
    at: Date.now(),
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    body,
    ok: response.ok,
  };
}

function install() {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  globalThis.fetch = async function cachedFetch(input, init) {
    const url = urlOf(input);
    const method = methodOf(input, init);
    if (!isCacheable(url, method)) return original(input, init);

    const now = Date.now();
    const cached = cache.get(url);
    if (cached && now - cached.at < TTL_MS) {
      STATS.hits += 1;
      return replay(cached, 'hit');
    }
    if (now < backoffUntil) {
      STATS.backoffSkips += 1;
      if (cached) return replay(cached, 'backoff');
      return new Response(JSON.stringify({ code: 429, msg: 'rate limited (backoff, no cached body)', success: false }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-zcode-webui-cache': 'backoff' },
      });
    }
    const pending = inflight.get(url);
    if (pending) {
      STATS.coalesced += 1;
      return replay((await pending).entry, 'coalesced');
    }

    STATS.misses += 1;
    const promise = (async () => {
      try {
        const response = await original(input, init);
        const entry = await readEntry(response);
        if (entry.status === 429) {
          backoffUntil = Date.now() + backoffMs;
          log('upstream 429 — backing off ' + Math.round(backoffMs / 1000) + 's'
            + (cached ? ' (serving the last cached body)' : ' (no cached body yet)'));
          backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
          writeStats();
          return cached ? { entry: cached, label: 'stale' } : { entry, label: 'error' };
        }
        backoffMs = BACKOFF_BASE_MS;
        backoffUntil = 0;
        if (entry.ok) cache.set(url, entry);
        return { entry, label: 'miss' };
      } catch (error) {
        STATS.errors += 1;
        if (cached) return { entry: cached, label: 'stale' };
        throw error;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, promise);
    const settled = await promise;
    return replay(settled.entry, settled.label);
  };
  log('armed — caching plan/quota GETs for ' + TTL_MS + 'ms with 429 backoff (pattern: ' + PATTERN.source + ')');
  const timer = setInterval(() => {
    if (STATS.hits + STATS.misses + STATS.coalesced + STATS.backoffSkips === 0) return;
    log('stats hits=' + STATS.hits + ' misses=' + STATS.misses + ' coalesced=' + STATS.coalesced
      + ' backoffSkips=' + STATS.backoffSkips + ' errors=' + STATS.errors);
    writeStats();
  }, 15 * 60_000);
  if (timer.unref) timer.unref();
}

if (globalThis[STATE_KEY]) {
  log('already installed in this process, nothing to do');
} else {
  globalThis[STATE_KEY] = { ttlMs: TTL_MS, stats: STATS };
  if (ENABLED) install();
  else log('skipped — ZCODE_WEBUI_BILLING_CACHE_TTL_MS=0');
}

module.exports = { ttlMs: TTL_MS, pattern: PATTERN, stats: STATS };
