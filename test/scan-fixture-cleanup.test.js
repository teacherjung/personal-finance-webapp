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
const CONTAINED_TEST = '外層限制寫入時仍可載入能力夾具並執行純本地題';
const CONTAINED_HINT = '；核對 test/scan-fixture-cleanup.test.js 的 contained 判讀與原生反例；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js';
const FILES = [
  'test/audit-grok-scan.test.js',
  'test/grok-scan-flow-credentials.test.js',
  'test/grok-scan-flow-breach.test.js',
  'test/grok-scan-flow-preflight.test.js',
  'test/grok-scan-flow-incident.test.js',
  'test/grok-scan-flow-repo.test.js',
  'test/grok-scan-flow-redaction.test.js',
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

/** @param {any[]} events @param {any[]} skips @param {string} temporary
 * @param {{diagnostic: (message: string) => void}} t */
function verifyContainedLifecycle(events, skips, temporary, t) {
  const prefix = join(temporary, 'grok-fixture-host-');
  const parents = events.filter(e => typeof e.root === 'string' && e.root.startsWith(prefix)).map(e => e.root);
  const contained = events.find(e => e.testName === CONTAINED_TEST);
  if (!contained) {
    assert.equal(parents.length, 0, '實際父根曾建立卻沒有該題 hook，不能當作未執行' + CONTAINED_HINT);
  } else {
    assert.deepEqual(contained.createdRoots.filter((/** @type {string} */ p) => p.startsWith(prefix)), parents,
      '該題 hook 的父根必須對得上實際建立記錄' + CONTAINED_HINT);
  }
  if (!contained || !parents.length) {
    assert.ok(skips.some(e => e.name === CONTAINED_TEST && e.skip),
      '缺少父根或 hook 時須有精確同題官方跳過證據' + CONTAINED_HINT);
    t.diagnostic('未驗證 contained 子程序：本平台未建立其私有父根；不擴稱已觀察子程序每次建立');
  }
}

/** @param {any} result @param {any[]} events @param {string} value
 * @param {{failure: boolean|string, temporary: string, contained?: boolean}} options @param {{diagnostic: (message: string) => void}} t */
function verifyLifecycle(result, events, value, { failure, temporary, contained = false }, t) {
  assert.equal(result.signal, null, '正常或故意斷言失敗必須走完收尾，不能被終止');
  const reports = result.report.split('\n').filter((/** @type {string} */ line) => line.trim()).map((/** @type {string} */ line) => JSON.parse(line));
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
  } else if (failure === 'settings-write' && !roots.some((p) => p.startsWith(join(temporary, 'fake-scan-settings-')))) {
    assert.equal(result.code, 0, result.output);
    unverifiedReason = '本平台未執行假設定初始化路徑，未驗證該故障收尾';
  } else if (!events.some((e) => e.fixtureRootsPresent > 0)) {
    // 一建就清掉的根不能證明受保護路徑走過；夾具須在場才有收尾機會。
    assert.equal(result.code, 0, result.output);
    unverifiedReason = '本平台未執行留下自有夾具的路徑，未驗證該路徑的收尾';
  } else {
    assert.ok(link, '實際夾具已建立，但收尾前的捷徑探針沒有執行；不能算驗證成功');
    if (failure) {
      assert.ok(events.some((e) => e.failureAfterRoots > 0), '故意失敗沒有發生在夾具出現後');
      assert.match(result.output, /Deliberate fixture lifecycle failure after creation/);
      if (failure === 'settings-write') {
        const injected = events.filter((e) => e.failureMode === failure);
        assert.equal(injected.length, 1, '假設定初始化故障必須在本場只注入一次；核對 test/helpers/temp-root-lifecycle-observer.js 的 settings-write 與 test/helpers/grok-scan-flow-fixtures.js 的 isolated 假設定根；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
        assert.equal(injected[0].targetRootPresent, true, '初始化故障必須在目標根確已建立後發生；核對 test/helpers/temp-root-lifecycle-observer.js 的 settings-write 與 test/helpers/grok-scan-flow-fixtures.js 的 isolated 假設定根；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
        assert.ok(roots.includes(injected[0].failureRoot), '初始化失敗根必須來自實際建立觀察；核對 test/helpers/temp-root-lifecycle-observer.js 的 settings-write 與 test/helpers/grok-scan-flow-fixtures.js 的 isolated 假設定根；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
        assert.equal(injected[0].failureTarget, join(injected[0].failureRoot, 'settings.json'));
      }
    }
    assert.equal(result.code, failure ? 1 : 0, result.output);
    assert.equal(existsSync(link.linkedRoot), false, '放過捷徑的自有根沒有被收掉');
  }
  // runner 的跳過標記不代表題內完全沒執行；先驗已建立根與對照，再報原始標記。
  for (const skip of skips) t.diagnostic(`runner 標記跳過，不計通過：${skip.name}｜skip=${JSON.stringify(skip.skip)}｜${typeof skip.skip === 'string' ? skip.skip : '未提供原因'}`);
  if (contained) verifyContainedLifecycle(events, skips, temporary, t);
  return { summary, skips, unverifiedReason };
}

describe('掃描考題自有夾具的生命週期', { concurrency: 2 }, () => {
  for (const file of FILES) for (const failure of (file.includes('preflight') ? [false, true, 'victim-write']
    : /flow-(repo|redaction)\.test\.js$/.test(file) ? [false, true, 'settings-write'] : [false, true])) {
    const mode = failure === 'victim-write' ? '既有 finally 前初始化寫檔失敗'
      : failure === 'settings-write' ? '假設定根登記後初始化寫檔失敗' : failure ? '夾具出現後考題失敗' : '正常完成';
    test(`${file}｜${mode}仍收尾並保留未登記對照`, async (t) => {
      const scope = mkdtempSync(join(tmpdir(), 'fixture-lifecycle-'));
      const temporary = join(scope, 'tmp');
      mkdirSync(temporary);
      const log = join(scope, 'created.jsonl');
      const value = randomUUID();
      const env = { ...gitEnv(), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        FIXTURE_LIFECYCLE_SCOPE: temporary, FIXTURE_LIFECYCLE_LOG: log,
        FIXTURE_LIFECYCLE_FAIL: typeof failure === 'string' ? failure : failure ? '1' : '0', FIXTURE_LIFECYCLE_CONTROL_VALUE: value };
      delete env.NODE_TEST_CONTEXT;
      let events = /** @type {any[]} */ ([]);
      try {
        const result = await run(file, env);
        assert.ok(existsSync(log), '觀察器沒有回報實際建立結果');
        events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const injected = events.find(e => e.failureMode === 'settings-write');
        if (injected) t.diagnostic('假設定初始化故障證據：' + JSON.stringify({
          mode: injected.failureMode, targetRootPresent: injected.targetRootPresent,
          rootObserved: events.some(e => e.root === injected.failureRoot),
        }));
        const { unverifiedReason } = verifyLifecycle(result, events, value, { failure, temporary, contained: file === 'test/grok-scan-flow-repo.test.js' }, t);
        if (unverifiedReason) t.skip(unverifiedReason);
        if (file === 'test/grok-scan-flow-repo.test.js') {
          const wrapped = events.find(e => e.testName?.startsWith('正式預設設定：'));
          assert.ok(wrapped?.createdRoots.some((/** @type {string} */ p) => p.startsWith(join(temporary, 'scan-decoy-cwd-'))),
            '局部包裝考題建立的自有根必須進實際觀察；核對 test/grok-scan-flow-repo.test.js 的「正式預設設定：」題及 test/helpers/temp-root-lifecycle-observer.js 的建立記錄；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
          assert.equal(wrapped.observerRestored, true, '局部包裝還原後必須仍接回生命週期觀察器；核對 test/grok-scan-flow-repo.test.js 的「正式預設設定：」題及 test/helpers/temp-root-lifecycle-observer.js 的建立記錄；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
          const later = events.slice(events.indexOf(wrapped) + 1).find(e => e.createdRoots?.length);
          assert.ok(later, '局部包裝還原後須有另一條實際建立路徑作正控；核對 test/grok-scan-flow-repo.test.js 的「正式預設設定：」題及 test/helpers/temp-root-lifecycle-observer.js 的建立記錄；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
          assert.equal(later.observerRestored, true);
        }
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
    const eventLines = result.report.trim().split('\n');
    assert.ok(eventLines.length > 1 && eventLines.every((line) => line.trim()),
      '內部空白反例須先取得不同的非空事件行；核對 test/scan-fixture-cleanup.test.js 的合成回報；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
    assert.doesNotThrow(() => {
      const interspersed = verifyLifecycle({ ...result, report: eventLines.join('\n\n \n\t\n') }, events, value, options,
        { diagnostic: () => {} });
      assert.deepEqual(interspersed, verified);
    }, '事件之間的空行與全空白行須保留原摘要及判斷；核對 test/scan-fixture-cleanup.test.js 的 verifyLifecycle 及合成回報；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
    for (const report of ['', ' \n\t\n']) {
      assert.throws(() => verifyLifecycle({ ...result, report }, events, value, options, t),
        { name: 'AssertionError', message: /官方考題摘要沒有回報/ }, '空回報須由缺摘要守門明確拒收；核對 test/scan-fixture-cleanup.test.js 的 verifyLifecycle 及合成回報反例；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
    }
    assert.throws(() => verifyLifecycle({ ...result, report: '\nnot-json\n' }, events, value, options, t),
      SyntaxError, '非空壞 JSON 不能當成空行忽略；核對 test/scan-fixture-cleanup.test.js 的 verifyLifecycle 及合成回報反例；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
    const padded = verifyLifecycle({ ...result, report: '\n \n' + result.report + '\n\t\n' }, events, value, options,
      { diagnostic: () => {} });
    assert.deepEqual(padded.summary, verified.summary, '空行不改合法摘要的原值與判斷；核對 test/scan-fixture-cleanup.test.js 的 verifyLifecycle 及合成回報反例；在專案根目錄重跑 node --test test/scan-fixture-cleanup.test.js');
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

for (const mode of ['option', 'body', 'active', 'body-root', 'no-parent']) {
  test(`contained 原生反例｜${mode}｜官方跳過不能遮住清理或保存失敗`, async () => {
    const scope = mkdtempSync(join(tmpdir(), 'fixture-contained-'));
    const temporary = join(scope, 'tmp');
    mkdirSync(temporary);
    const log = join(scope, 'created.jsonl');
    const actions = join(scope, 'actions.jsonl');
    const fixture = join(scope, 'contained.test.mjs');
    const value = randomUUID();
    writeFileSync(fixture, `import { test, after } from 'node:test';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mode = ${JSON.stringify(mode)};
const root = mkdtempSync(join(tmpdir(), 'active-control-'));
after(() => rmSync(root, { recursive: true, force: true }));
const record = (name) => appendFileSync(${JSON.stringify(actions)}, JSON.stringify({ name, value: ${JSON.stringify(value)} }) + '\\n');
test('active control', () => record('active control'));
test('other option skip', { skip: 'other reason' }, () => { throw new Error('skipped body ran'); });
test(${JSON.stringify(CONTAINED_TEST)}, { skip: mode === 'option' ? 'contained option reason' : false }, t => {
  if (mode === 'body') { t.skip('contained body reason'); record('body after skip'); return; }
  if (mode === 'no-parent') { record('active without parent'); return; }
  const parent = mkdtempSync(join(tmpdir(), 'grok-fixture-host-'));
  try {
    if (mode === 'body-root') t.skip('contained body with parent');
    record('parent operation');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
`);
    const env = { ...gitEnv(), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      FIXTURE_LIFECYCLE_SCOPE: temporary, FIXTURE_LIFECYCLE_LOG: log,
      FIXTURE_LIFECYCLE_FAIL: '0', FIXTURE_LIFECYCLE_CONTROL_VALUE: value };
    delete env.NODE_TEST_CONTEXT;
    let events = /** @type {any[]} */ ([]);
    try {
      const result = await run(fixture, env);
      assert.equal(result.code, 0, result.output);
      events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const records = readFileSync(actions, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const expected = [{ name: 'active control', value }];
      if (mode !== 'option') expected.push({ name: mode === 'body' ? 'body after skip'
        : mode === 'no-parent' ? 'active without parent' : 'parent operation', value });
      assert.deepEqual(records, expected, '須有本場合成 child 的實際操作見證' + CONTAINED_HINT);
      const messages = /** @type {string[]} */ ([]);
      const t = { diagnostic: (/** @type {string} */ message) => messages.push(message) };
      const options = { failure: false, temporary, contained: true };
      const check = (observed = events, actual = result) => verifyLifecycle(actual, observed, value, options, t);
      const withoutHook = events.filter(e => e.testName !== CONTAINED_TEST);
      const parent = events.find(e => e.root?.startsWith(join(temporary, 'grok-fixture-host-')));
      const hook = events.find(e => e.testName === CONTAINED_TEST);
      if (mode === 'no-parent') {
        assert.throws(() => check(), /精確同題官方跳過證據/, '有 hook 無父根不能借別題跳過' + CONTAINED_HINT);
        assert.throws(() => check(withoutHook), /精確同題官方跳過證據/, '缺 hook 不能借別題跳過' + CONTAINED_HINT);
        assert.throws(() => check(withoutHook, { ...result, output: result.output + CONTAINED_TEST + ' skip=true' }),
          /精確同題官方跳過證據/, 'stderr 文字不能代替官方逐題事件' + CONTAINED_HINT);
        return;
      }
      if (parent && !hook) assert.throws(() => check(), /實際父根曾建立卻沒有該題 hook/);
      else check();
      // 保留受測 child 與本題唯一值，故意破壞它完成操作後應保留的狀態。
      const root = events.find(e => e.root).root;
      mkdirSync(root);
      assert.throws(() => check(), /考題完成後仍留有實際建立的根/,
        '官方跳過不能提前返回放過本場殘留' + CONTAINED_HINT);
      rmSync(root, { recursive: true, force: true });
      const control = events.find(e => e.control);
      writeFileSync(control.sentinel, value + '-damaged');
      assert.throws(() => check(), /收尾傷到本題專屬的捷徑目標內容/,
        '官方跳過不能提前返回放過本場對照損傷' + CONTAINED_HINT);
      writeFileSync(control.sentinel, value);
      if (parent) {
        assert.equal(existsSync(parent.root), false, '反例須先完成父根收尾' + CONTAINED_HINT);
        assert.throws(() => check(withoutHook), /實際父根曾建立卻沒有該題 hook/,
          '已清掉的實際父根也不能借跳過掩蓋缺 hook' + CONTAINED_HINT);
        if (hook) assert.throws(() => check(events.map(e => e === hook ? { ...e, createdRoots: [] } : e)),
          /該題 hook 的父根必須對得上實際建立記錄/);
      } else {
        assert.doesNotThrow(() => check(withoutHook), '本場合成移除 hook 仍須採精確官方跳過' + CONTAINED_HINT);
        assert.ok(messages.some(message => message.startsWith('未驗證 contained 子程序：')),
          '未建立父根的路徑不能寫成已驗證' + CONTAINED_HINT);
      }
      const reports = result.report.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      const report = (/** @type {any[]} */ items) => items.map(e => JSON.stringify(e)).join('\n') + '\n';
      assert.throws(() => check(events, { ...result, report: report(reports.filter(e => e.type !== 'test:summary')) }),
        /官方考題摘要沒有回報/, 'contained 路徑仍須先有官方摘要' + CONTAINED_HINT);
      assert.throws(() => check(events, { ...result, report: report(reports.filter(e => e.name !== 'other option skip')) }),
        /官方跳過數量必須有逐題明細/, 'contained 路徑不得漏掉別題 skip 對帳' + CONTAINED_HINT);
    } finally {
      for (const event of events) if (event.root) {
        restoreFixtureAccess(event.root);
        rmSync(event.root, { recursive: true, force: true });
      }
      restoreFixtureAccess(scope);
      rmSync(scope, { recursive: true, force: true });
    }
  });
}
