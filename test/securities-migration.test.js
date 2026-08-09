// 證券合約收緊的一次性載入清掃（store.migrateSecTradesContractIfNeeded）端到端考題。
// 情境＝真實升級路徑：庫裡躺著「收緊前寫入的違約列」（缺核心金額）→ 若沒有清掃，r2 之後
// 每次 saveDb 都會在櫃檯 throw＝整個 app 寫不了（磚掉）。用子行程模擬「上一版寫入 → 注入舊列
// → 新版重新開機」三步（store 是行程內單例，重新載入必須換行程）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 子行程原始碼要用的 **ESM specifier**。
 * ⚠️ 絕對路徑不可以原樣塞進 `import … from`（Codex #433 r2 阻擋②，實體
 * 「07 專案#a/榮祥森（投資理財）100%」路徑上實測）：`import` 的字串是 **URL**，路徑裡的 `#`
 * 被當成 fragment 起點 ⇒ Node 只拿 `#` 前面那一截去找檔案，`ERR_MODULE_NOT_FOUND`。
 * ⇒ 一律 `pathToFileURL()`（`#`／`%`／空白／中文都會被編成安全的 file URL）。
 */
const REPO_URL = pathToFileURL(join(ROOT, 'lib/repo.js')).href;
const STORE = join(tmpdir(), `finance-sec-migrate-${process.pid}.db`);
const BAK = STORE + '.pre-sec-contract.bak';
const run = (/** @type {string} */ code) => execFileSync(process.execPath, ['--input-type=module', '-e', code],
  { env: { ...process.env, STORE_FILE: STORE }, encoding: 'utf8' });

test('升級清掃：違約舊列開機時濾除＋備份，合法列存活，app 寫入不磚', () => {
  try {
    // ① 「上一版」：正常寫入一筆合法列（過現行櫃檯）
    run(`
      import { getDb, saveDb } from ${JSON.stringify(REPO_URL)};
      const db = await getDb();
      db.securityTrades = [{ id: 'good', source: 'taishin', sourceRef: 'ts|f|ok|#1', tradeDate: '2026-01-13',
        side: 'buy', cashDirection: 'out', quantity: 10, currency: 'TWD', symbol: '0050',
        price: 40, grossAmount: 400, netSettlement: 401 }];
      await saveDb(db);
    `);
    // ② 直接改庫模擬「收緊前寫入的違約列」＋清掉一次性旗標。兩種病：
    //    legacy-bad＝缺三個核心金額；sneaky-bad＝price 存了非數字（對抗驗證抓到的狡猾款——
    //    validateImportItem 對它只默默剝欄不記 errors，判準若不是「真櫃檯」就會漏掃）
    {
      const d = new DatabaseSync(STORE);
      const row = /** @type {any} */ (d.prepare("SELECT data FROM kv WHERE key='securityTrades'").get());
      const rows = JSON.parse(row.data);
      rows.push({ id: 'legacy-bad', source: 'ibkr', sourceRef: 'ib|txn|fp|OLD-1', tradeDate: '2026-01-10',
        side: 'buy', cashDirection: 'out', quantity: 5, currency: 'USD', symbol: 'CSPX' });   // 無 price/grossAmount/netSettlement
      rows.push({ id: 'sneaky-bad', source: 'ibkr', sourceRef: 'ib|txn|fp|OLD-2', tradeDate: '2026-01-11',
        side: 'buy', cashDirection: 'out', quantity: 5, currency: 'USD', symbol: 'EIMI',
        price: 'not-a-number', grossAmount: 500, netSettlement: 501 });   // 必填數字欄存了非數字
      d.prepare("INSERT INTO kv(key,data) VALUES('securityTrades',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify(rows));
      d.prepare("DELETE FROM kv WHERE key='__secTradesContractAt'").run();
      d.close();
    }
    // ③ 「新版開機」：載入清掃應濾除違約列，且之後的 saveDb（含無關寫入）完全正常
    const out = run(`
      import { getDb, saveDb } from ${JSON.stringify(REPO_URL)};
      const db = await getDb();
      db.transactions.push({ id: 't1', date: '2026-06-01', amount: 100, category: '其他', type: 'expense', ledger: 'cashflow' });
      await saveDb(db);   // 沒清掃的話：這裡就在櫃檯炸掉（磚掉重現）
      console.log(JSON.stringify((await getDb()).securityTrades.map(r => r.id)));
    `);
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop() || '[]'), ['good'], '兩種違約列（缺核心金額／數字欄非數字）都在開機被濾除、合法列存活');
    assert.ok(existsSync(BAK), '清掃前先備份 pre-sec-contract.bak');
  } finally {
    for (const f of [STORE, STORE + '.bak', STORE + '-wal', STORE + '-shm', BAK]) { try { rmSync(f); } catch { /* 不存在 */ } }
  }
});
