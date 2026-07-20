// Codex r10 修正的回歸考題（實測確認過的真 bug）。隔離：STORE_FILE 指向 os 暫存檔，絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-r10-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { computeLeverage, computeIb, buildSummary } = await import('../lib/derive.js');
const { syncIb } = await import('../lib/services/ib-sync.js');
const { renameStoreDisplay } = await import('../lib/services/statement-import.js');
const { parseFubon } = await import('../lib/statement.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

// ---- [1] 全平倉只剩欠款（stock=0, cash<0）：官方資料不可被 stock>0 的門擋掉 ----
test('r10#1｜IB 持股歸零、只剩欠款：判為淨值為負（斷頭）、觸發危險提醒，不可顯示成無融資', () => {
  const db = { settings: { usdTwd: 32, ib: { lastEquity: { stock: 0, cash: -1000 } } },
    holdings: [], accounts: [], transactions: [], subscriptions: [], insurance: [], snapshots: [] };
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.hasLoan, true, '有欠款就是有融資（不再要求 ibValue>0）');
  assert.equal(Number.isFinite(lev.leverage), false, '淨值為負 → leverage=Infinity（不可 fallback 成 1）');
  assert.equal(lev.loan, 1000 * 32, '欠款金額要算出來（換算台幣）');
  const s = buildSummary(db);
  assert.equal(s.ib.equityWiped, true, 'buildSummary 要標 equityWiped');
  assert.equal(s.ib.leverage, null, '序列化後 Infinity→null（前端據 equityWiped 顯示危險，不會畫成 0.00x）');
  assert.ok(s.reminders.some(r => r.level === 'danger' && r.title.includes('淨值')), '要有「IB 淨值已為負」危險提醒');
});

test('r10#1｜回歸：持股>0 且無欠款仍是 leverage=1、hasLoan=false（沒把正常狀態弄壞）', () => {
  const db = { settings: { usdTwd: 32, ib: { lastEquity: { stock: 100, cash: 500 } } }, holdings: [], accounts: [] };
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.hasLoan, false);
  assert.equal(lev.leverage, 1);
});

// ---- [4] Cash Report 明細列全部讀不到：不可進彙總折疊流程把其他幣別歸零 ----
test('r10#4｜現金明細「全部讀失敗」→ 保留舊值、不折疊歸零（r9 護欄只裝在部分失敗那條）', async () => {
  store.save({ ...store.emptyDb(), accounts: [
    { id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 },
    { id: 'a2', name: 'IBKR GBP 現金', type: 'cash', class: '現金', currency: 'GBP', ibCashCur: 'GBP', balance: 50 }] });
  // 明細列在場但全部讀不到金額（cashDetailIncomplete）＋有效基準幣別彙總 2000
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: true, hasCashDetail: false, cashDetailIncomplete: true,
    baseCurrency: 'USD', baseSummaryCash: 2000, equity: null, income: null, trades: [], account: 'T', period: {} })));
  const db = store.load();
  assert.equal(db.accounts.find(a => a.ibCashCur === 'GBP')?.balance, 50, 'GBP 現金不可被折疊歸零');
  assert.equal(db.accounts.find(a => a.ibCashCur === 'USD')?.balance, 1000, 'USD 現金保留舊值（不被彙總 2000 蓋掉）');
  assert.equal(r.cashCollapsed, 0, '沒有任何幣別被折疊');
  assert.equal(r.cashFromSummary, false, 'cashFromSummary 不成立（沒走彙總入帳）');
  assert.equal(r.cashDetailIncomplete, true, '回報「資料不完整、沿用舊值」——與實際行為一致（不再自相矛盾）');
});

test('r10#4｜回歸：真的只有彙總列（無任何明細、cashDetailIncomplete=false）仍照走彙總入帳', async () => {
  store.save({ ...store.emptyDb(), accounts: [
    { id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 10 }] });
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: true, hasCashDetail: false,
    baseCurrency: 'USD', baseSummaryCash: 2000, equity: null, income: null, trades: [], account: 'T', period: {} })));
  assert.equal(store.load().accounts.find(a => a.ibCashCur === 'USD')?.balance, 2000, '合法的只有彙總列 → 以彙總入帳');
  assert.equal(r.cashFromSummary, true);
});

// ---- [5] 去重序號 |#N：renameStoreDisplay 要一起改到帶序號的那筆 ----
test('r10#5｜renameStoreDisplay 要改到帶去重序號 |#2 的第二筆（用 origFromStmtRef 剝序號）', () => {
  store.save({ ...store.emptyDb(), transactions: [
    { id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', subcategory: '飲料／咖啡',
      amount: 150, note: '星巴克', storeKey: '星巴克', source: 'stmt', stmtRef: 'c1|2026-07-01|150|星巴克' },
    { id: 't2', date: '2026-07-01', type: 'expense', category: '飲食', subcategory: '飲料／咖啡',
      amount: 150, note: '星巴克', storeKey: '星巴克', source: 'stmt', stmtRef: 'c1|2026-07-01|150|星巴克|#2' }] });
  const r = renameStoreDisplay('星巴克', '星巴克咖啡');
  assert.equal(r.changed, 2, '同店兩筆都要改（含帶 |#2 的那筆）');
  const notes = store.load().transactions.map(t => t.note);
  assert.deepEqual(notes, ['星巴克咖啡', '星巴克咖啡'], '第二筆不可因 |#2 被當成別的原文而漏改');
});

// ---- [7] 富邦換行店名：頁尾摘要列（最低應繳金額/應繳總額/信用額度）不可被吸成店名 ----
test('r10#7｜富邦續行守門要涵蓋摘要列標籤，且不誤傷末格帶數字的合法店名', () => {
  for (const label of ['最低應繳金額', '應繳總額', '信用額度', '本期應繳總金額']) {
    const r = parseFubon([['115/06/02', '115/06/03', 'TWD', '1,234'], [label, '5,678']]);
    assert.equal(r.length, 0, `頁尾摘要「${label}」不可被吸成店名、也不可產生幽靈交易`);
  }
  // 回歸：合法的末格數字店名（全聯福利中心1758）不受排除清單擴充影響
  const legit = parseFubon([['115/06/02', '115/06/03', 'TWD', '1,234'], ['全聯福利中心', '1758']]);
  assert.equal(legit.length, 1, '合法店名的續行不可被誤擋');
  assert.ok(legit[0].desc.includes('全聯福利中心'));
});
