import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const diskHint = "核對 scripts/grok-disk-snapshots.js 的快照／帳核對；重跑 node --test test/grok-disk-snapshots.test.js";


const project = ['lib/git-env.js', 'lib/is-main.js', 'scripts/audit-grok-scan.js',
  'scripts/grok-auth-refresh.js', 'scripts/grok-disk-snapshots.js', 'scripts/grok-final-reply.js',
  'scripts/grok-relay.js', 'scripts/grok-review.js', 'scripts/grok-sandbox-canary.js',
  'scripts/grok-sandbox.sb', 'scripts/grok-scan.js'];
const kit = ['tools/gates/check-collab-fields.js', 'tools/gates/check-review-verdicts.js',
  'tools/pending-rulings.js', 'tools/platform.js', 'tools/review-launch.js', 'tools/risk-tier.js'];
const names = [...project, ...kit].sort();
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'disk-snapshot-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), name === 'scripts/grok-disk-snapshots.js'
      ? readFileSync(new URL('../scripts/grok-disk-snapshots.js', import.meta.url)) : 'fixture ' + name);
  }
  const api = await import(pathToFileURL(join(root, 'scripts/grok-disk-snapshots.js')).href);
  const provider = () => api.finishDiskLedger('provider', [
    api.captureDiskSnapshot('provider', 'before-preparation'),
    api.captureDiskSnapshot('provider', 'before-provider-output'),
  ]);
  const runner = () => api.finishDiskLedger('runner', [
    api.captureDiskSnapshot('runner', 'before-box'),
    api.captureDiskSnapshot('runner', 'before-relay-spawn'),
    api.captureDiskSnapshot('runner', 'before-runner-result'),
  ]);
  return { root, ...api, provider, runner };
}

test('有限磁碟帳來自記帳模組所在來源，列名、角色及自身位元組可核', async t => {
  const f = await fixture(t);
  for (const scope of ['provider', 'runner']) {
    const ledger = f[scope]();
    assert.deepEqual(ledger.snapshots[0].files.map(x => x.path), names, diskHint);
    for (const row of ledger.snapshots[0].files) {
      const bytes = readFileSync(join(f.root, row.path));
      assert.equal(row.sha256, hash(bytes), diskHint); assert.equal(row.bytes, bytes.length, diskHint);
      assert.equal(row.role, kit.includes(row.path) ? 'listed-kit-entry' : 'project-source', diskHint);
    }
    assert.equal(f.diskLedgerSha256(ledger, scope), hash(JSON.stringify(ledger)), diskHint);
    assert.ok(!JSON.stringify(ledger).includes(f.root), diskHint);
  }
});

for (const name of ['scripts/grok-disk-snapshots.js', 'scripts/grok-sandbox.sb', 'tools/review-launch.js']) {
  test('固定宣告來源缺失不得悄悄省略：' + name, async t => {
    const f = await fixture(t);
    rmSync(join(f.root, name));
    assert.throws(() => f.captureDiskSnapshot('provider', 'before-preparation'), /有限磁碟來源/u, diskHint);
  });
  test('已觀測來源變動使後置核對拒收：' + name, async t => {
    const f = await fixture(t), before = f.captureDiskSnapshot('provider', 'before-preparation');
    writeFileSync(join(f.root, name), 'changed fixture');
    const after = f.captureDiskSnapshot('provider', 'before-provider-output');
    assert.throws(() => f.finishDiskLedger('provider', [before, after]), /有限磁碟來源/u, diskHint);
  });
}

test('profile 在建盒與 relay 啟動前改變，前置核對立即拒收', async t => {
  const f = await fixture(t), before = f.captureDiskSnapshot('runner', 'before-box');
  writeFileSync(join(f.root, 'scripts/grok-sandbox.sb'), 'changed profile');
  const next = f.captureDiskSnapshot('runner', 'before-relay-spawn');
  assert.throws(() => f.verifyDiskProgress('runner', [before, next]), /有限磁碟來源/u, diskHint);
});

test('實際 relay 替身有獨立角色與位元組，改動不可由固定 relay 原檔代打', async t => {
  const f = await fixture(t), relay = join(f.root, 'fake-relay.js');
  writeFileSync(relay, 'test relay');
  const before = f.captureDiskSnapshot('runner', 'before-box', relay);
  assert.deepEqual(before.actualRelay, { role: 'test-substitute', sha256: hash('test relay'), bytes: 10 }, diskHint);
  writeFileSync(relay, 'different test relay');
  const next = f.captureDiskSnapshot('runner', 'before-relay-spawn', relay);
  assert.throws(() => f.verifyDiskProgress('runner', [before, next]), /有限磁碟來源/u, diskHint);
});

test('固定來源的捷徑不當成普通檔案接受', async t => {
  const f = await fixture(t), path = join(f.root, 'lib/git-env.js'), other = join(f.root, 'replacement.js');
  writeFileSync(other, 'other source'); rmSync(path); symlinkSync(other, path);
  assert.throws(() => f.captureDiskSnapshot('provider', 'before-preparation'), /有限磁碟來源/u, diskHint);
});

test('正式帳拒收缺列、重複列、錯角色、壞雜湊與不完整階段', async t => {
  const f = await fixture(t);
  const changes = [
    ['missing-row', x => x.snapshots.forEach(s => s.files.pop())],
    ['duplicate-row', x => x.snapshots.forEach(s => { s.files[1] = structuredClone(s.files[0]); })],
    ['declared-role-mismatch', x => x.snapshots.forEach(s => { s.files[0].role = 'listed-kit-entry'; })],
    ['unknown-role', x => x.snapshots.forEach(s => { s.files[0].role = 'loaded-source'; })],
    ['invalid-hash', x => x.snapshots.forEach(s => { s.files[0].sha256 = ''; })],
    ['extra-key', x => x.snapshots.forEach(s => { s.files[0].extra = true; })],
    ['negative-bytes', x => x.snapshots.forEach(s => { s.files[0].bytes = -1; })],
    ['missing-phase', x => x.snapshots.pop()],
    ['phase-order', x => x.snapshots.reverse()],
    ['wrong-scope', x => { x.scope = 'provider'; }],
    ['wrong-schema', x => { x.schema = 'other-schema'; }],
    ['relay-difference', x => { x.snapshots[1].actualRelay.sha256 = 'a'.repeat(64); }],
    ['time-reversal', x => { x.snapshots[1].observedAt = '1900-01-01T00:00:00.000Z'; }],
  ];
  for (const [label, change] of changes) {
    const ledger = f.runner(); change(ledger);
    assert.throws(() => f.verifyDiskLedger(ledger, 'runner'), /有限磁碟來源/u, (label + '；請查 scripts/grok-disk-snapshots.js 並重跑本檔') + '；' + diskHint);
  }
});

test('建盒前或啟動前的部分核對，不可作為完整 runner 帳', async t => {
  const f = await fixture(t), snapshots = [f.captureDiskSnapshot('runner', 'before-box')];
  assert.equal(f.verifyDiskProgress('runner', snapshots), snapshots, diskHint);
  assert.throws(() => f.finishDiskLedger('runner', snapshots), /有限磁碟來源/u, diskHint);
});

test('雜湊取值沿原快照，缺列明確拒收', async t => {
  const f = await fixture(t), snapshot = f.captureDiskSnapshot('provider', 'before-preparation');
  const expected = hash(readFileSync(join(f.root, 'scripts/grok-scan.js')));
  writeFileSync(join(f.root, 'scripts/grok-scan.js'), 'later source');
  assert.equal(f.diskFileSha256(snapshot, 'scripts/grok-scan.js'), expected, diskHint);
  assert.throws(() => f.diskFileSha256(snapshot, 'unlisted.js'), /有限磁碟來源/u, diskHint);
});


for (const position of ['first', 'last']) test('files 缺自有槽位且長度不變仍拒收：' + position, async t => {
  const f = await fixture(t), ledger = f.provider();
  f.verifyDiskLedger(ledger, 'provider');
  const size = ledger.snapshots[0].files.length, index = position === 'first' ? 0 : size - 1;
  for (const snapshot of ledger.snapshots) {
    delete snapshot.files[index];
    assert.equal(snapshot.files.length, size, diskHint);
    assert.equal(Object.hasOwn(snapshot.files, index), false, diskHint);
  }
  assert.throws(() => f.verifyDiskLedger(ledger, 'provider'), /有限磁碟來源/u, diskHint);
});

test('單槽 sparse progress 不可跳過階段驗證', async t => {
  const f = await fixture(t), snapshots = [f.captureDiskSnapshot('runner', 'before-box')];
  assert.equal(f.verifyDiskProgress('runner', snapshots), snapshots, diskHint);
  delete snapshots[0];
  assert.equal(snapshots.length, 1, diskHint);
  assert.equal(Object.hasOwn(snapshots, 0), false, diskHint);
  assert.throws(() => f.verifyDiskProgress('runner', snapshots), /有限磁碟來源/u, diskHint);
});

function inheritOwnSlot(array, index) {
  const value = array[index], prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, index, { value });
  Object.setPrototypeOf(array, prototype);
  delete array[index];
  return value;
}

test('files 由私有原型補合法列仍不算自有元素', async t => {
  const f = await fixture(t), ledger = f.provider();
  f.verifyDiskLedger(ledger, 'provider');
  const index = ledger.snapshots[0].files.length - 1;
  for (const snapshot of ledger.snapshots) {
    const row = inheritOwnSlot(snapshot.files, index);
    assert.equal(snapshot.files[index], row, diskHint);
    assert.equal(Object.hasOwn(snapshot.files, index), false, diskHint);
  }
  assert.throws(() => f.verifyDiskLedger(ledger, 'provider'), /有限磁碟來源/u, diskHint);
});

test('snapshots 由私有原型補合法階段仍不算自有元素', async t => {
  const f = await fixture(t), ledger = f.runner();
  f.verifyDiskLedger(ledger, 'runner');
  const index = 1, snapshot = inheritOwnSlot(ledger.snapshots, index);
  assert.equal(ledger.snapshots[index], snapshot, diskHint);
  assert.equal(Object.hasOwn(ledger.snapshots, index), false, diskHint);
  assert.throws(() => f.verifyDiskLedger(ledger, 'runner'), /有限磁碟來源/u, diskHint);
});

for (const position of ['middle', 'last']) test('完整 snapshots 缺自有階段走明確拒收：' + position, async t => {
  const f = await fixture(t), ledger = f.runner();
  f.verifyDiskLedger(ledger, 'runner');
  const size = ledger.snapshots.length, index = position === 'middle' ? 1 : size - 1;
  delete ledger.snapshots[index];
  assert.equal(ledger.snapshots.length, size, diskHint);
  assert.equal(Object.hasOwn(ledger.snapshots, index), false, diskHint);
  assert.throws(() => f.verifyDiskLedger(ledger, 'runner'), /有限磁碟來源/u, diskHint);
});
