// Pin (置顶) guard shared by every renderer->host transport.
//
// A pinned task is moved into the renderer's "已置顶" group, which this web shell
// does not render next to the workspace list — one stray click on the tiny
// hover-only pin icon therefore makes the session disappear from the task list
// for good (the host serves pinned tasks from a separate listPinnedTasks /
// listPinnedTaskIds bucket, so they leave listTasks entirely). Pinning calls are
// answered with a synthetic success so the host-side pinned flag never flips;
// un-pin calls still reach the host, so a session that is pinned anyway can be
// restored from the UI.
//
// The guard must run on EVERY transport: the WS bridge (writeToHost) and the
// HTTP long-poll fallback (/bridge/send), which pushes straight into its own
// host pipe and would otherwise bypass writeToHost.
//
// Wire facts (verified against the 3.11.2 host runtime: the channel name and the
// args-array shape were read off a live zcode-task call — see the e2e notes in
// scripts/dev/pin-relay-probe.mjs; re-verify when the runtime is upgraded):
//   channel : "zcode-task"   — the renderer's ServiceChannels.ZCodeTask. The
//             client-side service object is merely NAMED zcodeTaskService, so
//             matching that name never fires on real traffic.
//   method  : setTaskPinned
//   args    : the host calls `handler.apply(ctx, arg)`, so params must arrive as
//             a one-element array: [{ taskId, workspacePath, pinned }]
import { decodeRpc, decodeRpcHeader, encodeRpcHeader } from './rpclog.mjs';

export const PIN_CHANNELS = ['zcode-task'];
export const PIN_METHOD = 'setTaskPinned';

// Decode a renderer call; returns { type, id, channel, method, params } or null.
export function decodePinCall(payload) {
  let header;
  try { header = decodeRpcHeader(payload); } catch (_e) { return null; }
  if (!header) return null;
  let body;
  try { body = decodeRpc(payload).body; } catch (_e) { body = null; }
  const params = Array.isArray(body) ? body[0] : body;   // host args array
  return { type: header.type, id: header.id, channel: header.channel, method: header.method, params: params };
}

// Returns the decoded call when it must be swallowed, or null when it may go
// through to the host.
export function interceptPinRpc(payload) {
  const call = decodePinCall(payload);
  if (!call) return null;
  if (call.type !== 100) return null;                             // 100 = call
  if (PIN_CHANNELS.indexOf(call.channel) < 0) return null;
  if (call.method !== PIN_METHOD) return null;
  if (!call.params || call.params.pinned !== true) return null;    // un-pin passes
  return call;
}

// Synthetic "ok" answer a swallowed call resolves with (201 = response).
export function pinAckFor(call, id) {
  return Buffer.concat([
    encodeRpcHeader([201, id, call.channel, call.method]),
    Buffer.from([0]),                     // body: preset 0 (undefined)
  ]);
}
