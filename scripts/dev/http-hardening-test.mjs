// Hardening + caching behavior test for the zcode-webui HTTP surface.
//
// Spawns two throwaway server instances (127.0.0.1:3198 without a token,
// 127.0.0.1:3199 with ZCODE_WEBUI_ACCESS_TOKEN) and verifies:
//   - the service binds loopback by default and reports it in /api/health;
//   - content-hashed renderer assets are served immutable, everything else
//     revalidates via ETag (If-None-Match → 304);
//   - /api/fs/list refuses paths outside the workspace/home roots and clamps
//     upward navigation at a root;
//   - with a token configured: HTML requests get the gate page in place (200,
//     not a redirect — must survive prefix-stripping proxies), api/bridge get
//     401, /api/health stays minimal, the cookie flow unlocks everything, and
//     WS upgrades without the cookie are rejected.
//
// Run: node scripts/dev/http-hardening-test.mjs

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'src', 'server.mjs');
const TOKEN = 'test-token-2f9c1d7a';

let failures = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!cond) failures++;
}

function startServer(port, env = {}) {
  return spawn(process.execPath, [SERVER, '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function waitFor(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/health');
      if (r.ok) return;
    } catch (_e) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server on :' + port + ' did not come up');
    await new Promise((r) => setTimeout(r, 250));
  }
}

function rawUpgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
    });
    sock.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); sock.destroy(); });
    sock.once('error', reject);
    setTimeout(() => { reject(new Error('upgrade timeout')); sock.destroy(); }, 5000);
  });
}

const kill = (child) => { try { child.kill('SIGKILL'); } catch (_e) { /* ignore */ } };

const plain = startServer(3198);
const gated = startServer(3199, { ZCODE_WEBUI_ACCESS_TOKEN: TOKEN });
try {
  await waitFor(3198);
  await waitFor(3199);
  const home = os.homedir();

  // ---- no-token server ----
  {
    const health = await (await fetch('http://127.0.0.1:3198/api/health')).json();
    check('binds loopback by default', health.bindHost === '127.0.0.1', 'bindHost=' + health.bindHost);
    check('no gate when no token configured', health.accessGate === false);

    const asset = readdirSync(path.join(ROOT, 'vendor', 'renderer', 'assets')).find((f) => f.endsWith('.js'));
    const a1 = await fetch('http://127.0.0.1:3198/assets/' + asset);
    check('hashed asset serves immutable',
      /immutable/.test(a1.headers.get('cache-control') || ''), a1.headers.get('cache-control'));

    const s1 = await fetch('http://127.0.0.1:3198/__zcode_webui/zcode-bridge.js');
    const etag = s1.headers.get('etag');
    check('webui script carries an ETag', !!etag, etag);
    const s2 = await fetch('http://127.0.0.1:3198/__zcode_webui/zcode-bridge.js', { headers: { 'If-None-Match': etag } });
    check('If-None-Match revalidation → 304', s2.status === 304, 'status=' + s2.status);

    const outside = await fetch('http://127.0.0.1:3198/api/fs/list?path=' + encodeURIComponent('/etc'));
    check('fs/list refuses /etc', outside.status === 403, 'status=' + outside.status);
    const inside = await (await fetch('http://127.0.0.1:3198/api/fs/list?path=' + encodeURIComponent(home))).json();
    check('fs/list allows home', inside.ok === true);
    const rootListing = await (await fetch('http://127.0.0.1:3198/api/fs/list?path=' + encodeURIComponent(home))).json();
    check('fs/list clamps upward navigation at the root', rootListing.parent === home,
      'parent=' + rootListing.parent);
  }

  // ---- token-gated server ----
  {
    const page = await fetch('http://127.0.0.1:3199/');
    const pageBody = await page.text();
    check('gate serves the access page IN PLACE (200, no redirect)',
      page.status === 200 && pageBody.includes('访问令牌'), 'status=' + page.status);
    check('gate page is no-store', /no-store/.test(page.headers.get('cache-control') || ''));

    const health = await (await fetch('http://127.0.0.1:3199/api/health')).json();
    check('gated /api/health stays minimal', health.ok === true && health.authRequired === true && !('sessions' in health));

    const api = await fetch('http://127.0.0.1:3199/api/fs/list?path=' + encodeURIComponent(home));
    check('api without cookie → 401', api.status === 401, 'status=' + api.status);

    const asset = await fetch('http://127.0.0.1:3199/assets/index-doesnotexist.js');
    check('asset without cookie → 401', asset.status === 401, 'status=' + asset.status);

    const wsLine = await rawUpgrade(3199, '/ws?token=whatever', { 'Sec-WebSocket-Key': 'x', 'Sec-WebSocket-Version': '13' });
    check('ws upgrade without cookie → 403', /403/.test(wsLine), wsLine);

    const bad = await fetch('http://127.0.0.1:3199/api/access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }),
    });
    check('wrong token → 401', bad.status === 401, 'status=' + bad.status);

    const good = await fetch('http://127.0.0.1:3199/api/access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
    });
    const setCookie = good.headers.get('set-cookie') || '';
    check('correct token → cookie issued', good.status === 200 && /zwebui_access=/.test(setCookie), setCookie.slice(0, 40) + '…');
    const cookie = setCookie.split(';')[0];

    const health2 = await (await fetch('http://127.0.0.1:3199/api/health', { headers: { Cookie: cookie } })).json();
    check('cookie unlocks full /api/health', health2.ok === true && 'sessions' in health2 && health2.accessGate === true);
    const page2 = await fetch('http://127.0.0.1:3199/', { headers: { Cookie: cookie } });
    const page2Body = await page2.text();
    check('cookie unlocks the real page', page2.status === 200 && page2Body.includes('__ZCODE_WEBUI_CONFIG__'));
  }
} finally {
  kill(plain);
  kill(gated);
}

console.log(failures === 0 ? '\nall http-hardening checks passed' : '\n' + failures + ' check(s) FAILED');
process.exit(failures === 0 ? 0 : 1);
