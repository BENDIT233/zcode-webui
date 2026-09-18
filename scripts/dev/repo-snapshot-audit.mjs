// Audit the vendor runtime's repo-snapshot ("workspace checkpoint") records that live
// under ~/.zcode/v2/checkpoints/<workspace-hash>/.
//
// What the records mean (read off zcode-server.cjs 3.12.3):
//   state.json            per-workspace state; `lastAcceptedManifestHash` is written only
//                         after the server confirmed an upload, `failureCount` counts
//                         rejected/retried capture attempts;
//   manifests/*.json      PLAINTEXT file list of the last snapshot (path + sizeBytes) —
//                         this is what actually left the box;
//   extra-manifests/*     the same, for global configs (settings/skills/mcp/memory...);
//   pending/*.tar.gz.enc  ciphertext not yet accepted (resumes as soon as the server
//                         issues a new credential);
//   tmp/                  scratch space of the packer.
//
// Usage: node scripts/dev/repo-snapshot-audit.mjs [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(process.env.ZCODE_HOME ? path.join(process.env.ZCODE_HOME, 'v2') : path.join(os.homedir(), '.zcode', 'v2'), 'checkpoints');
const asJson = process.argv.includes('--json');
const RISK = /(^|\/)\.env(\..*)?$|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519|credential|secret|\.npmrc$|\.netrc$/i;

function human(bytes) {
  if (!bytes) return '0';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return value.toFixed(value >= 100 || unit === 0 ? 0 : 1) + units[unit];
}

function listFiles(dir) {
  try { return fs.readdirSync(dir); } catch (_e) { return []; }
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch (_e) { return 0; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; }
}

const rows = [];
for (const dir of fs.existsSync(ROOT) ? fs.readdirSync(ROOT).sort() : []) {
  const base = path.join(ROOT, dir);
  if (!fs.statSync(base).isDirectory()) continue;
  const state = readJson(path.join(base, 'state.json')) || {};
  const manifests = listFiles(path.join(base, 'manifests'));
  const pending = listFiles(path.join(base, 'pending'));
  const extra = listFiles(path.join(base, 'extra-manifests'));

  let latest = null;
  if (manifests.length > 0) {
    const manifest = readJson(path.join(base, 'manifests', manifests[manifests.length - 1]));
    const files = (manifest && manifest.files) || [];
    let total = 0;
    let gitBytes = 0;
    let gitEntries = 0;
    const risky = [];
    for (const entry of files) {
      const size = entry.sizeBytes || 0;
      total += size;
      if (entry.path === '.git' || entry.path.startsWith('.git/')) { gitBytes += size; gitEntries++; }
      else if (RISK.test(entry.path)) risky.push(entry.path + ' (' + size + ')');
    }
    latest = {
      createdAt: manifest && manifest.createdAt ? new Date(manifest.createdAt).toISOString() : null,
      entries: files.length,
      totalBytes: total,
      gitBytes,
      gitEntries,
      gitPercent: total ? +((gitBytes * 100) / total).toFixed(1) : 0,
      risky,
    };
  }

  rows.push({
    workspace: state.workspacePath || '(unknown)',
    hash: dir,
    uploadAccepted: Boolean(state.lastAcceptedManifestHash),
    lastSnapshotAt: state.lastCompressedSize && state.lastCompressedSize.recordedAt
      ? new Date(state.lastCompressedSize.recordedAt).toISOString()
      : null,
    encryptedSizeBytes: state.lastCompressedSize ? state.lastCompressedSize.encryptedSizeBytes : null,
    workspaceSizeBytes: state.lastCompressedSize ? state.lastCompressedSize.workspaceSizeBytes : null,
    failureCount: state.failureCount || 0,
    pendingBytes: pending.reduce((sum, file) => sum + sizeOf(path.join(base, 'pending', file)), 0),
    extraManifestCount: extra.length,
    latest,
  });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('repo-snapshot records under ' + ROOT + '\n');
  const head = ['workspace', 'last snapshot', 'accepted', '.git share', 'encrypted', 'pending'];
  const table = rows.map((row) => [
    row.workspace,
    row.lastSnapshotAt || '-',
    row.uploadAccepted ? 'UPLOADED' : 'not accepted',
    row.latest ? row.latest.gitPercent + '% (' + human(row.latest.gitBytes) + ')' : '-',
    row.encryptedSizeBytes ? human(row.encryptedSizeBytes) : '-',
    row.pendingBytes ? human(row.pendingBytes) : '-',
  ]);
  const widths = head.map((title, index) => Math.max(title.length, ...table.map((line) => line[index].length)));
  const render = (line) => line.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  console.log(render(head));
  console.log(render(widths.map((width) => '-'.repeat(width))));
  for (const line of table) console.log(render(line));

  const uploaded = rows.filter((row) => row.uploadAccepted);
  const acceptedBytes = uploaded.reduce((sum, row) => sum + (row.encryptedSizeBytes || 0), 0);
  const pendingBytes = rows.reduce((sum, row) => sum + row.pendingBytes, 0);
  console.log('\ntotals: ' + rows.length + ' workspaces tracked, ' + uploaded.length + ' with an accepted upload ('
    + human(acceptedBytes) + ' ciphertext), ' + human(pendingBytes) + ' ciphertext still pending locally');

  // Ciphertext moved out of checkpoints/ by hand (see AGENTS.md: the 2026-09-18 quarantine)
  // is no longer reachable by the runtime, but it is still on disk — report it here so the
  // local footprint stays visible.
  const v2Root = path.dirname(ROOT);
  const quarantined = fs.existsSync(v2Root)
    ? fs.readdirSync(v2Root).filter((name) => name.startsWith('repo-snapshot-quarantine-'))
    : [];
  for (const dir of quarantined) {
    const files = listFiles(path.join(v2Root, dir));
    const bytes = files.reduce((sum, file) => sum + sizeOf(path.join(v2Root, dir, file)), 0);
    console.log('quarantined: ' + dir + ' — ' + files.length + ' file(s), ' + human(bytes) + ' (safe to delete)');
  }
  console.log('note: pending ciphertext resumes as soon as the vendor API hands out a new credential, and');
  console.log('      .git/ is exempt from both the secret-name filter and the size cap in the vendor scanner.');
}

process.exit(0);
