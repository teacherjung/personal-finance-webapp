// @ts-check
// 不清歷史暫存；子行程回報自己實際建立的根，外層在驗殘留後才收本場對照物。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

/** 外層失敗時仍只處理本場記錄的根；不跟捷徑進入目標。 @param {string} dir */
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
        assert.equal(result.signal, null, '正常或故意斷言失敗必須走完收尾，不能被終止');
        assert.ok(existsSync(log), '觀察器沒有回報實際建立結果');
        events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const summaries = result.report.trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.type === 'test:summary');
        const summary = summaries.at(-1);
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
        const link = events.find((e) => e.link);
        if (failure === 'victim-write' && !roots.some((p) => p.startsWith(join(temporary, 'victim-')))) {
          assert.equal(result.code, 0, result.output);
          t.skip('本平台未執行 victim 初始化路徑，未驗證該故障收尾');
          return;
        }
        // 能力探測在模組載入時建立且立即清掉；它不證明受保護的考題夾具走過。
        if (!events.some((e) => e.fixtureRootsPresent > 0)) {
          assert.equal(result.code, 0, result.output);
          t.skip('本平台未執行留下自有夾具的路徑，未驗證該路徑的收尾');
          return;
        }
        assert.ok(link, '實際夾具已建立，但收尾前的捷徑探針沒有執行；不能算驗證成功');
        if (failure) {
          assert.ok(events.some((e) => e.failureAfterRoots > 0), '故意失敗沒有發生在夾具出現後');
          assert.match(result.output, /Deliberate fixture lifecycle failure after creation/);
        }
        assert.equal(result.code, failure ? 1 : 0, result.output);
        assert.equal(existsSync(link.linkedRoot), false, '放過捷徑的自有根沒有被收掉');
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
