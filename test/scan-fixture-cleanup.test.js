// @ts-check
// 不清歷史暫存；子行程回報自己實際建立的根，外層在驗殘留後才收本場對照物。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../lib/git-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OBSERVER = join(ROOT, 'test/helpers/temp-root-lifecycle-observer.js');
const REPORTER = join(ROOT, 'test/helpers/temp-root-lifecycle-reporter.js');
const FILES = [
  'test/audit-grok-scan.test.js',
  'test/grok-scan-flow-credentials.test.js',
  'test/grok-scan-flow-breach.test.js',
  'test/grok-scan-flow-preflight.test.js',
  'test/grok-scan-flow-incident.test.js',
];

/** 突變可能留下不可列舉的目錄；量完殘留後仍須收回本場夾具。 @param {string} dir */
function restoreFixtureAccess(dir) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreFixtureAccess(join(dir, entry.name));
  }
}

/** @param {string} file @param {Record<string,string|undefined>} env */
function run(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--import', OBSERVER, '--test-reporter', REPORTER, file], { cwd: ROOT, env });
    let output = '';
    let report = '';
    child.stdout.on('data', (part) => { output += part; report += part; });
    child.stderr.on('data', (part) => { output += part; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output, report }));
  });
}

/** @param {any} result @param {any[]} events @param {string} value
 * @param {{failure: boolean|string, temporary: string}} options @param {{diagnostic: (message: string) => void}} t */
function verifyLifecycle(result, events, value, { failure, temporary }, t) {
  assert.equal(result.signal, null, '正常或故意斷言失敗必須走完收尾，不能被終止');
  const reports = result.report.trim().split('\n').map((/** @type {string} */ line) => JSON.parse(line));
  const summary = reports.filter((/** @type {any} */ e) => e.type === 'test:summary').at(-1);
  assert.ok(summary?.counts, '官方考題摘要沒有回報，不能把缺少 hook 當作全部跳過');
  const allSkipped = summary.success === true && summary.counts.tests > 0
    && summary.counts.skipped === summary.counts.tests;
  const roots = events.filter((e) => e.root).map((e) => e.root);
  assert.ok(roots.length, '未觀察到任何實際 mkdtemp；不能當作清理成功');
  assert.deepEqual(roots.filter((root) => existsSync(root)), [], '考題完成後仍留有實際建立的根');
  assert.ok(events.some((e) => e.afterEachObserved) || allSkipped,
    '考題生命週期 hook 沒有執行，且官方事件未證明全部跳過');
  const control = events.find((e) => e.control);
  assert.ok(control, '沒有獨立未登記對照');
  assert.ok(existsSync(control.control), '收尾刪掉了未登記對照根');
  assert.equal(readFileSync(control.sentinel, 'utf8'), value, '收尾傷到本題專屬的捷徑目標內容');
  const skips = reports.filter((/** @type {any} */ e) => (e.type === 'test:pass' || e.type === 'test:fail') && e.skip);
  assert.equal(skips.length, summary.counts.skipped, '官方跳過數量必須有逐題明細，不能靜默漏題');
  const link = events.find((e) => e.link);
  let unverifiedReason;
  if (failure === 'victim-write' && !roots.some((p) => p.startsWith(join(temporary, 'victim-')))) {
    assert.equal(result.code, 0, result.output);
    unverifiedReason = '本平台未執行 victim 初始化路徑，未驗證該故障收尾';
  } else if (!events.some((e) => e.fixtureRootsPresent > 0)) {
    // 一建就清掉的根不能證明受保護路徑走過；夾具須在場才有收尾機會。
    assert.equal(result.code, 0, result.output);
    unverifiedReason = '本平台未執行留下自有夾具的路徑，未驗證該路徑的收尾';
  } else {
    assert.ok(link, '實際夾具已建立，但收尾前的捷徑探針沒有執行；不能算驗證成功');
    if (failure) {
      assert.ok(events.some((e) => e.failureAfterRoots > 0), '故意失敗沒有發生在夾具出現後');
      assert.match(result.output, /Deliberate fixture lifecycle failure after creation/);
    }
    assert.equal(result.code, failure ? 1 : 0, result.output);
    assert.equal(existsSync(link.linkedRoot), false, '放過捷徑的自有根沒有被收掉');
  }
  // runner 的跳過標記不代表題內完全沒執行；先驗已建立根與對照，再報原始標記。
  for (const skip of skips) t.diagnostic(`runner 標記跳過，不計通過：${skip.name}｜skip=${JSON.stringify(skip.skip)}｜${typeof skip.skip === 'string' ? skip.skip : '未提供原因'}`);
  return { summary, skips, unverifiedReason };
}

describe('掃描考題自有夾具的生命週期', { concurrency: 2 }, () => {
  for (const file of FILES) for (const failure of (file.includes('preflight') ? [false, true, 'victim-write'] : [false, true])) {
    const mode = failure === 'victim-write' ? '既有 finally 前初始化寫檔失敗' : failure ? '夾具出現後考題失敗' : '正常完成';
    test(`${file}｜${mode}仍收尾並保留未登記對照`, async (t) => {
      const scope = mkdtempSync(join(tmpdir(), 'fixture-lifecycle-'));
      const temporary = join(scope, 'tmp');
      mkdirSync(temporary);
      const log = join(scope, 'created.jsonl');
      const value = randomUUID();
      const env = { ...gitEnv(), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        FIXTURE_LIFECYCLE_SCOPE: temporary, FIXTURE_LIFECYCLE_LOG: log,
        FIXTURE_LIFECYCLE_FAIL: failure === 'victim-write' ? failure : failure ? '1' : '0', FIXTURE_LIFECYCLE_CONTROL_VALUE: value };
      delete env.NODE_TEST_CONTEXT;
      let events = /** @type {any[]} */ ([]);
      try {
        const result = await run(file, env);
        assert.ok(existsSync(log), '觀察器沒有回報實際建立結果');
        events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const { unverifiedReason } = verifyLifecycle(result, events, value, { failure, temporary }, t);
        if (unverifiedReason) t.skip(unverifiedReason);
      } finally {
        // 突變拿掉權限還原時，先讓上面的生命週期斷言紅，再收這次自己的殘留。
        for (const event of events) if (event.root) {
          restoreFixtureAccess(event.root);
          rmSync(event.root, { recursive: true, force: true });
        }
        restoreFixtureAccess(scope);
        rmSync(scope, { recursive: true, force: true });
      }
    });
  }
});

test('原生混合跳過｜保留逐題原值與操作證據，跳過不遮住殘留或對照損傷', async () => {
  const scope = mkdtempSync(join(tmpdir(), 'fixture-lifecycle-mixed-'));
  const temporary = join(scope, 'tmp');
  mkdirSync(temporary);
  const log = join(scope, 'created.jsonl');
  const actions = join(scope, 'actions.jsonl');
  const fixture = join(scope, 'mixed.test.mjs');
  const value = randomUUID();
  writeFileSync(fixture, `import { test, after, describe } from 'node:test';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'mixed-run-'));
after(() => rmSync(root, { recursive: true, force: true }));
const record = (name) => appendFileSync(${JSON.stringify(actions)}, JSON.stringify({name, value:${JSON.stringify(value)}}) + '\\n');
describe('synthetic suite', () => {
  test('active operation', () => record('active'));
  test('option skip', { skip: 'option reason' }, () => { throw new Error('option skip body ran'); });
  test('body skip', (t) => { t.skip('body reason'); record('body'); });
  test('boolean skip', { skip: true }, () => { throw new Error('boolean skip body ran'); });
});
`);
  const env = { ...gitEnv(), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    FIXTURE_LIFECYCLE_SCOPE: temporary, FIXTURE_LIFECYCLE_LOG: log,
    FIXTURE_LIFECYCLE_FAIL: '0', FIXTURE_LIFECYCLE_CONTROL_VALUE: value };
  delete env.NODE_TEST_CONTEXT;
  let events = /** @type {any[]} */ ([]);
  try {
    const result = await run(fixture, env);
    events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const messages = /** @type {string[]} */ ([]);
    const t = { diagnostic: (/** @type {string} */ message) => messages.push(message) };
    const options = { failure: false, temporary };
    const verified = verifyLifecycle(result, events, value, options, t);
    assert.equal(verified.unverifiedReason, undefined, '混合夾具必須實際走過收尾機會');
    assert.equal(verified.summary.counts.tests, 4, 'suite 不可併入官方 test 數');
    assert.equal(verified.summary.counts.passed, 1);
    assert.equal(verified.summary.counts.skipped, 3);
    const rawSkips = result.report.trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.skip);
    assert.equal(rawSkips.length, 3, '回報器不可重收 test:complete 的同題跳過事件');
    assert.deepEqual(verified.skips.map((/** @type {any} */ e) => ({ name: e.name, skip: e.skip })), [
      { name: 'option skip', skip: 'option reason' },
      { name: 'body skip', skip: 'body reason' },
      { name: 'boolean skip', skip: true },
    ], '官方跳過題名與原始值必須完整保留且不重複');
    assert.deepEqual(messages, [
      'runner 標記跳過，不計通過：option skip｜skip="option reason"｜option reason',
      'runner 標記跳過，不計通過：body skip｜skip="body reason"｜body reason',
      'runner 標記跳過，不計通過：boolean skip｜skip=true｜未提供原因',
    ]);
    assert.deepEqual(readFileSync(actions, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
      { name: 'active', value }, { name: 'body', value },
    ], '必須有本題實際操作證據，t.skip 不能被當成題內未執行');
    const root = events.find((e) => e.root).root;
    mkdirSync(root);
    assert.throws(() => verifyLifecycle(result, events, value, options, t),
      /考題完成後仍留有實際建立的根/, '部分跳過不得提前返回放過根殘留');
    rmSync(root, { recursive: true, force: true });
    const control = events.find((e) => e.control);
    writeFileSync(control.sentinel, 'damaged');
    assert.throws(() => verifyLifecycle(result, events, value, options, t),
      /收尾傷到本題專屬的捷徑目標內容/, '部分跳過不得遮住對照內容損傷');
    writeFileSync(control.sentinel, value);
    assert.equal(messages.length, 3, '保護斷言失敗前不得先回報跳過');
  } finally {
    for (const event of events) if (event.root) {
      restoreFixtureAccess(event.root);
      rmSync(event.root, { recursive: true, force: true });
    }
    restoreFixtureAccess(scope);
    rmSync(scope, { recursive: true, force: true });
  }
});
