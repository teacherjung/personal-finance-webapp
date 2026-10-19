// @ts-check
// 磁碟快照只能比較觀測時點；不證明已載入映像、遞迴相依或中途未被替換。
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY = 'scripts/grok-relay.js';
const PROJECT = [
  'lib/git-env.js', 'lib/is-main.js', 'scripts/audit-grok-scan.js',
  'scripts/grok-auth-refresh.js', 'scripts/grok-disk-snapshots.js',
  'scripts/grok-final-reply.js', RELAY, 'scripts/grok-review.js',
  'scripts/grok-sandbox-canary.js', 'scripts/grok-sandbox.sb', 'scripts/grok-scan.js',
];
const KIT = [
  'tools/gates/check-collab-fields.js', 'tools/gates/check-review-verdicts.js',
  'tools/pending-rulings.js', 'tools/platform.js', 'tools/review-launch.js', 'tools/risk-tier.js',
];
const DECLARATION = Object.freeze([
  ...PROJECT.map(path => Object.freeze({ path, role: 'project-source' })),
  ...KIT.map(path => Object.freeze({ path, role: 'listed-kit-entry' })),
].sort((a, b) => a.path.localeCompare(b.path, 'en')));
const PHASES = Object.freeze({
  provider: Object.freeze(['before-preparation', 'before-provider-output']),
  runner: Object.freeze(['before-box', 'before-relay-spawn', 'before-runner-result']),
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** @returns {never} */
const fail = () => { throw new Error('有限磁碟來源快照缺失、無法讀取或不一致；請核對 scripts/grok-disk-snapshots.js 的固定清單與檔案，再重跑本輪發審指令'); };
const demand = condition => { if (!condition) fail(); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === expected.slice().sort().join('|');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
/** @typedef {{ phase: string, observedAt: string, files: {path: string, role: string, sha256: string, bytes: number}[], actualRelay?: {role: string, sha256: string, bytes: number} }} DiskSnapshot */

function readSource(path) {
  try {
    const st = lstatSync(path);
    demand(st.isFile() && !st.isSymbolicLink());
    const bytes = readFileSync(path);
    return { sha256: digest(bytes), bytes: bytes.length };
  } catch { fail(); }
}

// 來源根由本模組位置決定；受審 repo 及材料不能提供同名檔來代替執行來源。
export function captureDiskSnapshot(scope, phase, actualRelayPath = join(ROOT, RELAY)) {
  demand(Object.hasOwn(PHASES, scope) && PHASES[scope].includes(phase));
  /** @type {DiskSnapshot} */
  const snapshot = {
    phase, observedAt: new Date().toISOString(),
    files: DECLARATION.map(item => ({ ...item, ...readSource(join(ROOT, item.path)) })),
  };
  if (scope === 'runner') snapshot.actualRelay = {
    role: resolve(actualRelayPath) === join(ROOT, RELAY) ? 'project-source' : 'test-substitute',
    ...readSource(actualRelayPath),
  };
  return snapshot;
}

function validateSnapshot(snapshot, scope, phase) {
  demand(keys(snapshot, scope === 'runner' ? ['phase', 'observedAt', 'files', 'actualRelay'] : ['phase', 'observedAt', 'files']));
  demand(snapshot.phase === phase && typeof snapshot.observedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(snapshot.observedAt)
    && Number.isFinite(Date.parse(snapshot.observedAt)));
  demand(Array.isArray(snapshot.files) && snapshot.files.length === DECLARATION.length);
  for (let i = 0; i < snapshot.files.length; i++) {
    demand(Object.hasOwn(snapshot.files, i));
    const file = snapshot.files[i];
    demand(keys(file, ['path', 'role', 'sha256', 'bytes']));
    demand(file.path === DECLARATION[i].path && file.role === DECLARATION[i].role
      && isHash(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0);
  }
  if (scope === 'runner') {
    const relay = snapshot.actualRelay;
    demand(keys(relay, ['role', 'sha256', 'bytes']) && ['project-source', 'test-substitute'].includes(relay.role)
      && isHash(relay.sha256) && Number.isSafeInteger(relay.bytes) && relay.bytes >= 0);
    if (relay.role === 'project-source') {
      const declared = snapshot.files.find(file => file.path === RELAY);
      demand(relay.sha256 === declared.sha256 && relay.bytes === declared.bytes);
    }
  }
}

export function verifyDiskProgress(scope, snapshots) {
  demand(Object.hasOwn(PHASES, scope));
  demand(Array.isArray(snapshots) && snapshots.length > 0 && snapshots.length <= PHASES[scope].length);
  for (let i = 0; i < snapshots.length; i++) {
    demand(Object.hasOwn(snapshots, i));
    validateSnapshot(snapshots[i], scope, PHASES[scope][i]);
  }
  const first = snapshots[0];
  for (const [i, snapshot] of snapshots.slice(1).entries()) {
    demand(JSON.stringify(snapshot.files) === JSON.stringify(first.files));
    demand(Date.parse(snapshot.observedAt) >= Date.parse(snapshots[i].observedAt));
    if (scope === 'runner') demand(JSON.stringify(snapshot.actualRelay) === JSON.stringify(first.actualRelay));
  }
  return snapshots;
}

export function verifyDiskLedger(ledger, scope) {
  demand(Object.hasOwn(PHASES, scope));
  demand(keys(ledger, ['schema', 'scope', 'snapshots']) && ledger.schema === 'grok-disk-snapshots/v1' && ledger.scope === scope);
  demand(Array.isArray(ledger.snapshots) && ledger.snapshots.length === PHASES[scope].length);
  verifyDiskProgress(scope, ledger.snapshots);
  return ledger;
}

export function finishDiskLedger(scope, snapshots) {
  return verifyDiskLedger({ schema: 'grok-disk-snapshots/v1', scope, snapshots }, scope);
}

export function diskLedgerSha256(ledger, scope) {
  verifyDiskLedger(ledger, scope);
  return digest(JSON.stringify(ledger));
}

/** @param {DiskSnapshot} snapshot @param {string} path */
export function diskFileSha256(snapshot, path) {
  const file = snapshot.files.find(item => item.path === path);
  if (!file || !isHash(file.sha256)) fail();
  return file.sha256;
}
