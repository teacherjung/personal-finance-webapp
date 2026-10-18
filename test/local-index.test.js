// 只用本題私有 TMPDIR；父題核子程序 exit 之後的產物，再清自己的殘留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TARGET = '<div class="foot-note">資料存於本機<br><code>data/store.db</code></div>';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'finance-index-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), outside = join(root, 'outside.txt');
  fs.mkdirSync(source); fs.writeFileSync(outside, 'outside marker ' + root);
  fs.writeFileSync(join(source, 'index.html'), '<header>synthetic</header>' + TARGET + '<footer>v1</footer>');
  return { root, source, outside };
}
function run(c, phase, file = join(c.root, '合成定位 #?%.sqlite')) {
  const r = spawnSync(process.execPath, [join(ROOT, 'test/helpers/local-index-case.js')], {
    cwd: c.root, env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: file, TMPDIR: c.root, TMP: c.root, TEMP: c.root, LOCAL_INDEX_CASE: phase, LOCAL_INDEX_SOURCE: c.source },
    encoding: 'utf8', timeout: 30000, maxBuffer: 2e6,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(c.outside), true, '清理不得移除本題外部對照');
  assert.equal(fs.readFileSync(c.outside, 'utf8'), 'outside marker ' + c.root, '清理不得移除本題外部對照');
  return JSON.parse(r.stdout);
}
for (const shape of ['absolute', 'relative', 'non-db']) {
  test(`LOCAL 真 HTTP｜${shape} 同環境來源入口、投影 Buffer／Range／快取與其他資產保存`, t => {
    const c = fixture(t), file = shape === 'relative' ? 'relative 指引/store.db' : join(c.root, shape === 'non-db' ? 'private.data' : 'private.db');
    const r = run(c, 'http', file);
    assert.equal(r.created.length, 1); assert.deepEqual(r.presentBeforeExit, [true]);
    assert.equal(r.exitListenersAdded, 1); assert.equal(fs.existsSync(r.created[0]), false, '真 exit 清自己的產物');
    assert.equal(fs.existsSync(join(c.root, 'relative 指引')), false);
    assert.equal(fs.existsSync(join(c.root, 'private.db')), false); assert.equal(fs.existsSync(join(c.root, 'private.data')), false);
    assert.ok(r.steps.includes('206/shifted')); assert.ok(r.steps.includes('repeat-listen'));
  });
}
test('LOCAL 投影生命週期｜重啟依新來源重建、只含 index、正常 exit 清自身產物', t => {
  const c = fixture(t);
  for (const version of ['v1', 'v2']) {
    const source = '<header>synthetic</header>' + TARGET + '<footer>' + version + '</footer>';
    fs.writeFileSync(join(c.source, 'index.html'), source);
    const r = run(c, 'create'); assert.equal(r.error, null); assert.equal(r.created.length, 1);
    assert.deepEqual(r.files, ['index.html']);
    assert.equal(r.contents, source.replace('data/store.db', 'SQLite 資料庫'));
    assert.deepEqual(r.presentBeforeExit, [true]); assert.equal(fs.existsSync(r.created[0]), false);
    assert.equal(r.exitListenersAdded, 1);
    if (process.platform !== 'win32') assert.equal(r.mode, 0o700);
  }
});
for (const shape of ['missing', 'duplicate']) {
  test(`LOCAL 投影目標｜${shape} 可觀察地拒絕、不建立半份產物`, t => {
    const c = fixture(t); fs.writeFileSync(join(c.source, 'index.html'), shape === 'missing' ? '<p>none</p>' : TARGET + TARGET);
    const r = run(c, 'create'); assert.match(r.error, /恰有一處/); assert.deepEqual(r.created, []); assert.equal(r.exitListenersAdded, 0);
  });
}
for (const cleanupFails of [false, true]) {
  test(`LOCAL 投影初始化｜寫入真故障，${cleanupFails ? '清理也失敗仍保留原錯' : '立即清理自己已建目錄'}`, t => {
    const c = fixture(t), r = run(c, cleanupFails ? 'write-failure-cleanup-failure' : 'write-failure');
    assert.equal(r.error, 'synthetic projected write failure'); assert.equal(r.created.length, 1);
    assert.deepEqual(r.presentBeforeExit, [cleanupFails]); assert.equal(fs.existsSync(r.created[0]), cleanupFails);
    assert.deepEqual(r.cleaned, r.created); assert.equal(r.exitListenersAdded, 0);
  });
}
