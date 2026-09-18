// Lab check for the pin interception on the HTTP long-poll relay path
// (the transport that bypassed writeToHost before the fix).
//
// Usage: node scripts/dev/pin-relay-probe.mjs <port> <taskId> <workspacePath> <0|1>
import WebSocket from 'ws';

const port = Number(process.argv[2] || 3199);
const taskId = process.argv[3];
const workspacePath = process.argv[4];
const pinned = process.argv[5] === '1' || process.argv[5] === 'true';
const channel = process.argv[6] || 'zcodeTaskService';

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
const origin = 'http://127.0.0.1:' + port;

// 1) open an HTTP relay (its own host pipe)
const opened = await (await fetch(origin + '/bridge/open?id=pin-relay-' + Date.now(), { method: 'POST' })).json();
console.log('bridge/open -> ' + JSON.stringify(opened));
if (!opened.ok) process.exit(2);
const rid = opened.id;

// 2) wait for the host's Initialize frame on the poll channel
let initSeen = false;
for (let i = 0; i < 40 && !initSeen; i++) {
  const res = await fetch(origin + '/bridge/poll?id=' + rid);
  const buf = Buffer.from(await res.arrayBuffer());
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const payload = buf.subarray(off, off + len); off += len;
    let d; try { d = decode(payload); } catch (e) { d = { header: 'undecodable' }; }
    if (Array.isArray(d.header) && d.header[0] === 200) { initSeen = true; console.log('init frame received'); }
  }
}

// 3) send the pin call through the HTTP relay
const payload = Buffer.concat([
  serialize([100, 7, channel, 'setTaskPinned']),
  serialize({ taskId, workspacePath, pinned }),
]);
const sent = await (await fetch(origin + '/bridge/send?id=' + rid, { method: 'POST', body: payload })).json();
console.log('bridge/send (pinned=' + pinned + ') -> ' + JSON.stringify(sent));

// 4) read what came back: synthetic 201 = intercepted, 202/203/error = forwarded
let verdict = 'no response (forwarded to host?)';
for (let i = 0; i < 12 && verdict.indexOf('no response') === 0; i++) {
  const res = await fetch(origin + '/bridge/poll?id=' + rid);
  const buf = Buffer.from(await res.arrayBuffer());
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const pl = buf.subarray(off, off + len); off += len;
    let d; try { d = decode(pl); } catch (e) { d = { header: 'undecodable' }; }
    console.log('rx  ' + JSON.stringify(d).slice(0, 200));
    if (Array.isArray(d.header) && d.header[0] >= 201 && d.header[0] <= 203) verdict = 'response type ' + d.header[0];
  }
  if (verdict.indexOf('no response') === 0) await new Promise((r) => setTimeout(r, 400));
}
console.log('VERDICT ' + verdict);
await fetch(origin + '/bridge/close?id=' + rid, { method: 'POST' });
process.exit(0);
