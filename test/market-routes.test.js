import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

// 獨立行程讓未接住的 rejection 真正使本題失敗；服務、資料庫與派生檔只用本場暫存根。
const helper = fileURLToPath(new URL('./helpers/market-routes-case.js', import.meta.url));
const cases = [
  ['input', '合法 CSV、重複參數及單層陣列原樣送服務'],
  ['invalid', '異常物件與巢狀參數先回 400，服務不執行'],
  ['reject-quotes', '報價 rejection 交真錯誤中介，下一次查詢仍可用'],
  ['reject-cape', 'CAPE rejection 交真錯誤中介，下一次查詢仍可用'],
  ['reject-realyield', '實質利率 rejection 交真錯誤中介，下一次查詢仍可用'],
  ['downgrade', '自動報價與洞察的受控失敗保留原 200 降級'],
  ['real', '真服務的無值、手動值退路及成功查詢不改合成帳本'],
];
for (const [scenario, description] of cases) test('市場真 HTTP｜' + description, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'finance-market-route-test-')));
  try {
    const result = spawnSync(process.execPath, [helper], {
      cwd: root,
      env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'store.db'), TMPDIR: root, TMP: root, TEMP: root, MARKET_ROUTE_CASE: scenario },
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    const evidence = result.stdout + result.stderr;
    assert.equal(result.error, undefined, evidence);
    assert.equal(result.signal, null, evidence);
    assert.equal(result.status, 0, evidence);
    const reports = result.stdout.split('\n').filter(line => line.startsWith('MARKET_ROUTE_RESULT '));
    assert.equal(reports.length, 1, '核對 test/helpers/market-routes-case.js 的實際執行回報；重跑 node --test test/market-routes.test.js');
    const report = JSON.parse(reports[0].slice('MARKET_ROUTE_RESULT '.length));
    assert.equal(report.scenario, scenario);
    assert.ok(report.requests > 0);
    assert.equal(report.closed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, '核對本題自有根清理；重跑 node --test test/market-routes.test.js');
  }
});
