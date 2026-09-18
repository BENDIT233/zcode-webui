// Unit tests for the shared pin guard (src/pin.mjs): a renderer-shaped pin call
// must be swallowed, everything else must pass through, and the synthetic ack
// must look like a normal 201 response to the caller.
//
// Usage: node scripts/dev/pin-guard-test.mjs
import { interceptPinRpc, pinAckFor } from '../../src/pin.mjs';
import { decodeRpc } from '../../src/rpclog.mjs';

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
const msg = (header, body) => Buffer.concat([serialize(header), serialize(body)]);

const cases = [
  // host wire shape: channel 'zcode-task', args wrapped in an array
  ['pin=true', msg([100, 7, 'zcode-task', 'setTaskPinned'], [{ taskId: 'sess_x', workspacePath: '/w', pinned: true }]), true],
  ['pin=1 (numeric, not boolean)', msg([100, 7, 'zcode-task', 'setTaskPinned'], [{ pinned: 1 }]), false],
  ['pin=true without args array', msg([100, 7, 'zcode-task', 'setTaskPinned'], { pinned: true }), true],
  ['unpin=false', msg([100, 7, 'zcode-task', 'setTaskPinned'], [{ taskId: 'sess_x', workspacePath: '/w', pinned: false }]), false],
  ['other method', msg([100, 7, 'zcode-task', 'setTaskUnread'], [{ pinned: true }]), false],
  ['client-side alias (never on the wire)', msg([100, 7, 'zcodeTaskService', 'setTaskPinned'], [{ pinned: true }]), false],
  ['other channel', msg([100, 7, 'other', 'setTaskPinned'], [{ pinned: true }]), false],
  ['event frame', msg([102, 7, 'zcode-task', 'setTaskPinned'], [{ pinned: true }]), false],
  ['flow-control json', Buffer.from('{"kind":"zcode-webui-port-ready"}'), false],
];

let bad = 0;
for (const [name, buf, want] of cases) {
  const got = interceptPinRpc(buf) !== null;
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  intercepted=' + got + ' expected=' + want);
}

const hdr = interceptPinRpc(cases[0][1]);
const ack = pinAckFor(hdr, 42);
const d = decodeRpc(ack);   // {type, id, channel, method, body}
const ackOk = d.type === 201 && d.id === 42
  && d.channel === 'zcode-task' && d.method === 'setTaskPinned'
  && d.body === undefined;
if (!ackOk) bad++;
console.log((ackOk ? 'PASS' : 'FAIL') + '  synthetic ack is a 201 response with the caller id  (' + JSON.stringify(d) + ')');

console.log(bad === 0 ? '\nall pin guard checks passed' : '\n' + bad + ' check(s) failed');
process.exit(bad ? 1 : 0);
