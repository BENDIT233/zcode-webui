// Unit tests for the billing/quota request coalescer (src/api-cache-guard.cjs).
//
// The guard is a preload, so the test drives it the way the host loads it: a child Node
// process started with `--require <guard>`. The mock upstream runs INSIDE that child —
// putting it in the parent would deadlock, because spawnSync blocks the parent's event loop
// and the parent's HTTP server could then never answer.
//
// Usage: node scripts/dev/api-cache-guard-test.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'api-cache-guard.cjs');
const TTL_MS = 800;
const BACKOFF_MS = 600;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok || detail === undefined ? '' : '  [' + detail + ']'));
}

const child = `
const http = require('node:http');
const hits = new Map();
let failBalance = false;
const bump = (key) => hits.set(key, (hits.get(key) || 0) + 1);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/control/fail-on') { failBalance = true; res.end('ok'); return; }
  if (url.pathname === '/control/fail-off') { failBalance = false; res.end('ok'); return; }
  if (url.pathname.includes('/zcode-plan/billing/balance') && failBalance) {
    bump(url.pathname);
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 429, msg: 'rate limited' }));
    return;
  }
  bump(url.pathname);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 0, data: { ok: true, path: url.pathname } }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const balancePath = '/api/v1/zcode-plan/billing/balance';
  const balance = base + balancePath + '?app_version=test';
  const current = base + '/api/v1/zcode-plan/billing/current?app_version=test';
  const steps = [];
  const step = async (name, fn) => {
    const out = await fn();
    steps.push({ name, upstreamBalance: hits.get(balancePath) || 0, upstreamCurrent: hits.get('/api/v1/zcode-plan/billing/current') || 0, upstreamHealth: hits.get('/health') || 0, ...out });
  };
  const call = async (url) => {
    const res = await fetch(url);
    return { status: res.status, cache: res.headers.get('x-zcode-webui-cache'), body: await res.text() };
  };
  try {
    await step('first', () => call(balance));
    await step('second', () => call(balance));
    await step('parallel', async () => ({ labels: (await Promise.all([1, 2, 3, 4, 5].map(() => call(current)))).map((p) => p.cache) }));
    await sleep(${TTL_MS} + 150);
    await step('afterTtl', () => call(balance));
    await sleep(${TTL_MS} + 150);          // let the entry go stale so the next call really hits upstream
    await call(base + '/control/fail-on');
    await step('on429', () => call(balance));
    await step('duringBackoff', () => call(balance));
    await call(base + '/control/fail-off');
    await sleep(${BACKOFF_MS} + 250);
    await step('afterBackoff', () => call(balance));
    await step('passthrough', async () => ({ results: [await call(base + '/health'), await call(base + '/health')] }));
  } catch (error) {
    steps.push({ name: 'error', error: String((error && error.message) || error) });
  }
  console.log('RESULT ' + JSON.stringify({ steps }));
  process.exit(0);
});
`;

const res = spawnSync(process.execPath, ['--require', GUARD, '-e', child], {
  encoding: 'utf8',
  timeout: 30_000,
  env: {
    ...process.env,
    ZCODE_WEBUI_BILLING_CACHE_TTL_MS: String(TTL_MS),
    ZCODE_WEBUI_BILLING_BACKOFF_BASE_MS: String(BACKOFF_MS),
  },
});
const line = (res.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
const parsed = line ? JSON.parse(line.slice('RESULT '.length)) : { steps: [] };
const step = (name) => parsed.steps.find((s) => s.name === name) || {};

check('child ran to completion', Boolean(line), (res.stderr || '').trim().split('\n').slice(-2).join(' | '));
const first = step('first');
check('first call reaches upstream', first.cache === 'miss' && first.upstreamBalance === 1, JSON.stringify(first));
const second = step('second');
check('second call is served from cache', second.cache === 'hit' && second.upstreamBalance === 1, JSON.stringify(second));
const parallel = step('parallel');
check('parallel calls collapse into one upstream request',
  parallel.upstreamCurrent === 1 && (parallel.labels || []).filter((c) => c === 'coalesced').length >= 4,
  'upstream=' + parallel.upstreamCurrent + ' labels=' + JSON.stringify(parallel.labels));
const afterTtl = step('afterTtl');
check('cache expires after the TTL', afterTtl.cache === 'miss' && afterTtl.upstreamBalance === 2, JSON.stringify(afterTtl));
const on429 = step('on429');
check('upstream 429 serves the last good body instead of the error',
  on429.status === 200 && /"ok":true/.test(on429.body || '') && on429.cache === 'stale' && on429.upstreamBalance === 3, JSON.stringify(on429));
const duringBackoff = step('duringBackoff');
check('during backoff nothing is sent upstream',
  duringBackoff.cache === 'backoff' && duringBackoff.upstreamBalance === 3, JSON.stringify(duringBackoff));
const afterBackoff = step('afterBackoff');
check('after backoff upstream is used again', afterBackoff.cache === 'miss' && afterBackoff.upstreamBalance === 4, JSON.stringify(afterBackoff));
const passthrough = step('passthrough');
check('non-matching paths are never cached',
  (passthrough.results || []).every((p) => p.cache === null) && passthrough.upstreamHealth === 2,
  'upstream=' + passthrough.upstreamHealth + ' labels=' + JSON.stringify((passthrough.results || []).map((p) => p.cache)));

const off = spawnSync(process.execPath, ['--require', GUARD, '-e', 'console.log("child-ok")'], {
  encoding: 'utf8',
  timeout: 15_000,
  env: { ...process.env, ZCODE_WEBUI_BILLING_CACHE_TTL_MS: '0' },
});
check('TTL=0 disables the guard', /child-ok/.test(off.stdout) && /skipped/.test(off.stderr),
  (off.stderr || '').trim().split('\n').slice(-1)[0]);

console.log(failures === 0 ? '\nall api-cache-guard checks passed' : '\n' + failures + ' check(s) failed');
process.exit(failures ? 1 : 0);
