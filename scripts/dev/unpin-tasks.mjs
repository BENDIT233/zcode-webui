// Un-pin tasks through the real host channel (zcode-task.setTaskPinned with the
// host's args-array wire shape) and report the pinned ids before/after.
//
// Usage: node scripts/dev/unpin-tasks.mjs <port> <workspacePath> <taskId> [taskId...]
import WebSocket from 'ws';

const port = Number(process.argv[2]);
const workspacePath = process.argv[3];
const taskIds = process.argv.slice(4);
if (!port || !workspacePath || taskIds.length === 0) {
  console.error('usage: node unpin-tasks.mjs <port> <workspacePath> <taskId> [taskId...]');
  process.exit(2);
}

function writeVQL(value) {
  const bytes = [];
  if (value === 0) return Buffer.from([0]);
  let v = value;
  while (v !== 0) { bytes.push(v & 127); v = v >>> 7; }
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 128;
  return Buffer.from(bytes);
}
function serialize(data) {
  if (data === undefined) return Buffer.from([0]);
  if (typeof data === 'string') { const b = Buffer.from(data, 'utf8'); return Buffer.concat([Buffer.from([1]), writeVQL(b.length), b]); }
  if (Array.isArray(data)) { const p = [Buffer.from([4]), writeVQL(data.length)]; for (const el of data) p.push(serialize(el)); return Buffer.concat(p); }
  if (typeof data === 'number') return Buffer.concat([Buffer.from([6]), writeVQL(data)]);
  if (data && typeof data === 'object') { const b = Buffer.from(JSON.stringify(data), 'utf8'); return Buffer.concat([Buffer.from([5]), writeVQL(b.length), b]); }
  throw new Error('unsupported ' + data);
}
function decode(buf) {
  let off = 0;
  const readVQL = () => { let v = 0, n = 0; for (;;) { const b = buf[off++]; v |= (b & 127) << n; if (!(b & 128)) return v >>> 0; n += 7; } };
  function de() {
    const t = buf[off++];
    if (t === 0) return undefined;
    if (t === 1) { const len = readVQL(); const s = buf.subarray(off, off + len).toString('utf8'); off += len; return s; }
    if (t === 2 || t === 3) { const len = readVQL(); const s = buf.subarray(off, off + len); off += len; return s; }
    if (t === 4) { const len = readVQL(); const a = []; for (let i = 0; i < len; i++) a.push(de()); return a; }
    if (t === 5) { const len = readVQL(); const s = JSON.parse(buf.subarray(off, off + len).toString('utf8')); off += len; return s; }
    if (t === 6) return readVQL();
    return '<preset ' + t + '>';
  }
  const h = de();
  let b; try { b = de(); } catch (e) { b = '<undecodable>'; }
  return { header: h, body: b };
}

const html = await (await fetch('http://127.0.0.1:' + port + '/')).text();
const token = /wsToken":"([^"]+)"/.exec(html)[1];
// no client cookie: the server spawns/adopts the credential-keyed host, the same
// one the browser session uses, without displacing anyone's own tab id
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=' + token + '&tab=unpin-' + Date.now() + Math.random().toString(36).slice(2, 6));
const waiters = new Map();
let nextId = 9000;

ws.on('message', (data, isBinary) => {
  if (!isBinary) return;
  const d = decode(Buffer.from(data));
  if (Array.isArray(d.header) && typeof d.header[1] === 'number' && waiters.has(d.header[1])) {
    const w = waiters.get(d.header[1]);
    waiters.delete(d.header[1]);
    w(d);
  }
});
await new Promise((r) => ws.on('open', r));
await new Promise((r) => { const t = setTimeout(r, 10000); ws.on('message', (d, bin) => { if (bin) { clearTimeout(t); r(); } }); });

function call(method, arg) {
  const id = nextId++;
  const payload = Buffer.concat([serialize([100, id, 'zcode-task', method]), serialize(arg)]);
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    ws.send(payload);
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); resolve({ timeout: true }); } }, 8000);
  });
}

const before = await call('listPinnedTaskIds', undefined);
console.log('pinned before : ' + JSON.stringify(before.body));

for (const taskId of taskIds) {
  // un-pin passes the guard and reaches the host, which flips the index row
  const res = await call('setTaskPinned', [{ taskId, workspacePath, pinned: false }]);
  const ok = res.body && res.body.taskId === taskId && !res.body.pinned;
  console.log((ok ? 'OK   ' : 'FAIL ') + taskId + ' -> ' + JSON.stringify(res.body).slice(0, 160));
}

const after = await call('listPinnedTaskIds', undefined);
console.log('pinned after  : ' + JSON.stringify(after.body));
try { ws.close(4000, 'done'); } catch (e) { /* ignore */ }
process.exit(0);
