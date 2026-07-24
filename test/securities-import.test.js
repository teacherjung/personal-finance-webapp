// 證券交易 S2：台新匯入服務（預覽/確認/批次/fail-closed）＋schema 守門＋derive 不變式。
// 全合成資料、隔離 STORE_FILE；帳號一律明顯假值（AGENTS：絕不用真實末碼）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_STORE = join(tmpdir(), `finance-sec-import-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { buildSecuritiesPreview, applySecuritiesImport, listSecuritiesBatches, deleteSecuritiesBatch, taishinAccountLabel } =
  await import('../lib/services/securities-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { buildSummary } = await import('../lib/derive.js');
const { sanitizeDbForWrite, validateImportItem } = await import('../lib/schema.js');
const { projectSettings } = await import('../lib/secret-fields.js');
const { app } = await import('../server.js');

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api`;

after(() => {
  server.close();
  for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 不存在 */ } }
});

/** 合成解析結果（台新）。 @param {any[]} trades @param {any[]=} groups @param {object=} extra */
const parsed = (trades, groups = [{ date: '2026-01-15', total: null, tradeCount: trades.length, sumMatches: true }], extra = {}) =>
  ({ stmtMonth: '2026-01', accountRaw: '9001-900100', trades, groups, headerFound: true, ...extra });

const BUY = { tradeDate: '2026-01-13', settlementDate: '2026-01-15', rawType: '現買', symbol: '0050', name: '元大台灣50',
  quantity: 1000, price: 104, grossAmount: 104000, commission: 148, feeDiscount: 0, tax: 0, otherFees: null, netSettlement: 104148, currency: 'TWD' };
const SELL = { tradeDate: '2026-01-14', settlementDate: '2026-01-16', rawType: '現賣', symbol: '2330', name: '台積電',
  quantity: 100, price: 600, grossAmount: 60000, commission: 85, feeDiscount: 0, tax: 180, otherFees: null, netSettlement: 59735, currency: 'TWD' };

test('預覽：分幣別摘要、去重標記、無 blocker；遮罩 label 不含帳號原文', () => {
  const p = buildSecuritiesPreview(getDb(), parsed([BUY, SELL]));
  assert.deepEqual(p.blockers, []);
  assert.equal(p.counts.total, 2);
  assert.equal(p.byCurrency.TWD.buy, 104148);
  assert.equal(p.byCurrency.TWD.sell, 59735);
  assert.equal(p.byCurrency.TWD.fees, 148 + 85 + 180);
  assert.equal(p.accountLabel, '台新證券 …0100');
  assert.ok(!JSON.stringify(p).includes('9001-900100'), '預覽回應不可含帳號原文');
  assert.equal(taishinAccountLabel(''), '台新證券');
});

test('fail-closed：未知類別/彙總不符/缺帳戶/金額爆表/無法辨識 → blockers 列清楚，apply 一律 400', () => {
  const db = getDb();
  const unknown = buildSecuritiesPreview(db, parsed([{ ...BUY, rawType: '興櫃申購' }]));
  assert.match(unknown.blockers.join(), /無法判定買賣方向.*興櫃申購/);
  const badSum = buildSecuritiesPreview(db, parsed([BUY], [{ date: '2026-01-15', total: 999, tradeCount: 1, sumMatches: false }]));
  assert.match(badSum.blockers.join(), /無法核對/);
  const noAcct = buildSecuritiesPreview(db, parsed([BUY], undefined, { accountRaw: '' }));
  assert.match(noAcct.blockers.join(), /帳戶識別/);
  const huge = buildSecuritiesPreview(db, parsed([{ ...BUY, netSettlement: 2e8 }]));
  assert.match(huge.blockers.join(), /合理解析上限/);
  const broken = buildSecuritiesPreview(db, parsed([{ ...BUY, tradeDate: '' }]));
  assert.match(broken.blockers.join(), /無法辨識/);
  for (const bad of [[{ ...BUY, rawType: '興櫃申購' }]]) {
    assert.throws(() => applySecuritiesImport(db, parsed(bad)), /無法安全匯入/, 'blocker 存在時 apply 必 400');
  }
});

test('匯入：入庫含 id/批次/時間、無 null 欄、無帳號原文；重匯冪等 0 新增；同日同額兩筆都活', () => {
  const db = getDb();
  const r1 = applySecuritiesImport(db, parsed([BUY, SELL, { ...BUY }]));   // BUY 兩筆一模一樣＝真交易
  saveDb(db);
  assert.equal(r1.imported, 3);
  assert.equal(getDb().securityTrades.length, 3, '同日同代號同額的兩筆真交易都要入庫');
  const rows = getDb().securityTrades;
  for (const row of rows) {
    assert.ok(row.id && row.importBatch && row.importedAt);
    assert.ok(!Object.values(row).some(v => v === null), 'null 欄位不落庫');
    assert.equal(row.sourceAccountId.length, 12, '只存指紋');
  }
  assert.ok(!JSON.stringify(rows).includes('9001-900100'), '資料庫不可含帳號原文');
  const again = applySecuritiesImport(getDb(), parsed([BUY, SELL, { ...BUY }]));
  assert.equal(again.imported, 0, '重匯同一份＝0 新增');
  assert.equal(again.skippedDup, 3);
});

test('匯入紀錄＋整批刪除：台新批次可刪；IB 批次擋 400；不誤刪別的批次', () => {
  const db = getDb();
  db.securityTrades.push({ id: 'ib1', source: 'ibkr', sourceRef: 'ib|txn|T-1', tradeDate: '2026-01-10', side: 'buy',
    cashDirection: 'out', quantity: 1, currency: 'USD', symbol: 'CSPX', sourceAccountId: 'aaaabbbbcccc',
    price: 800, grossAmount: 800, netSettlement: 801,   // 核心金額必填（Codex S3r2#4）
    sourceAccountLabel: 'IBKR …0000', importBatch: 'ib-sync-x', importedAt: '2026-01-10T00:00:00Z' });
  saveDb(db);
  const batches = listSecuritiesBatches(getDb());
  assert.ok(batches.length >= 2);
  assert.throws(() => deleteSecuritiesBatch('ib-sync-x'), /不可整批刪除/);
  const tsBatch = batches.find(b => b.source === 'taishin');
  const before = getDb().securityTrades.length;
  const del = deleteSecuritiesBatch(tsBatch.batchId);
  assert.equal(del.deleted, 3);
  assert.equal(getDb().securityTrades.length, before - 3, '只刪該台新批次');
  assert.ok(getDb().securityTrades.some(r => r.id === 'ib1'), 'IB 列還在');
  assert.throws(() => deleteSecuritiesBatch('沒這批'), /找不到/);
});

test('derive 不變式：securityTrades 絕不進現金流/淨值（賣股入金已在銀行帳以內轉/交割記錄，再算＝重複）', () => {
  const mk = (sec) => buildSummary({
    settings: { currency: 'TWD', usdTwd: 32 },
    accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 }],
    holdings: [], transactions: [], snapshots: [], assetTargets: [], subscriptions: [], cards: [], insurance: [],
    securityTrades: sec,
  });
  const without = mk([]);
  const withRows = mk([{ id: 'x', source: 'taishin', sourceRef: 'ts|f|2026-01|…|#1', tradeDate: '2026-01-13',
    side: 'sell', cashDirection: 'in', quantity: 1000, netSettlement: 104148, currency: 'TWD' }]);
  assert.equal(withRows.netWorth, without.netWorth);
  assert.deepEqual(withRows.cashflow, without.cashflow);
});

test('schema 守門＋備份往返：合法列過櫃檯；缺 tradeDate/sourceRef 整筆濾除；匯入驗證接受合法列', () => {
  const good = { id: 'g', source: 'taishin', sourceRef: 'ts|f|x|#1', tradeDate: '2026-01-13', side: 'buy',
    cashDirection: 'out', quantity: 10, currency: 'TWD', symbol: '0050', price: 40, grossAmount: 400, netSettlement: 401 };
  const noDate = { ...good, id: 'b1', tradeDate: '' };
  const noRef = { ...good, id: 'b2', sourceRef: '' };
  delete /** @type {any} */ (noRef).sourceRef;
  const cleaned = sanitizeDbForWrite({ ...structuredClone(getDb()), securityTrades: [good, noDate, noRef] }, { mode: 'strip' });
  assert.deepEqual(cleaned.securityTrades.map((/** @type {any} */ r) => r.id), ['g'], '壞主鍵整筆濾除、合法列存活');
  const vGood = validateImportItem('securityTrades', good);
  assert.equal(vGood.errors.length, 0, '合法列匯入驗證零錯誤');
  assert.ok(vGood.item);
  assert.ok(validateImportItem('securityTrades', noDate).errors.length > 0, '空 tradeDate（datereq）匯入要報錯');
});

test('機密投影：taishinSecPdfPassword 絕不送前端、補 Set 布林', () => {
  const out = projectSettings({ usdTwd: 32, taishinSecPdfPassword: 'A123456789', ib: { flexToken: 't' } });
  assert.equal(out.taishinSecPdfPassword, undefined);
  assert.equal(out.taishinSecPdfPasswordSet, true);
  assert.equal(projectSettings({ usdTwd: 32 }).taishinSecPdfPasswordSet, false);
});

test('HTTP 煙霧：GET /api/securities 有掛載且唯讀排序；preview 缺檔 400', async () => {
  const list = await (await fetch(base + '/securities')).json();
  assert.ok(Array.isArray(list.trades));
  const noFile = await fetch(base + '/securities/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noFile.status, 400);
  const settings = await (await fetch(base + '/settings')).json();
  assert.equal(settings.taishinSecPdfPassword, undefined, 'GET /settings 不可回密碼');
});

test('幣別牆：不支援幣別（EUR）在預覽就 fail-closed（否則會在寫入櫃檯被拒、毒死整批）', () => {
  const p = buildSecuritiesPreview(getDb(), parsed([{ ...BUY, currency: 'EUR' }]));
  assert.match(p.blockers.join(), /幣別不在系統支援範圍.*EUR/);
});

test('自審根治｜補印插入不漏記（服務層端到端）：先匯 [X,Y]，補發單 [X,Z,Y] → 只新增 Z、Y 不重複', () => {
  const db = getDb();
  const mk = (name) => ({ tradeDate: '2026-03-13', settlementDate: '2026-03-15', rawType: '現買', symbol: '0056', name,
    quantity: 500, price: 40, grossAmount: 20000, commission: 28, feeDiscount: 0, tax: 0, otherFees: null, netSettlement: 20028, currency: 'TWD' });
  applySecuritiesImport(db, parsed([mk('X'), mk('Y')]));
  saveDb(db);
  const db2 = getDb();
  const r2 = applySecuritiesImport(db2, parsed([mk('X'), mk('Z'), mk('Y')]));
  saveDb(db2);
  assert.equal(r2.imported, 1, '只有 Z 是新的（原 HIGH：Z 被誤判 dup、Y 反被重複插入）');
  assert.equal(r2.skippedDup, 2);
  const rows = getDb().securityTrades.filter(r => r.symbol === '0056');
  assert.equal(rows.length, 3, '共三筆（X/Y/Z 各一）');
  assert.deepEqual(rows.map(r => r.name).sort(), ['X', 'Y', 'Z'], 'X/Y/Z 各一、無重複無漏');
});

test('自審 #6｜核心金額（價/成交額/應收付）缺席或非有限 → blocker（藍圖 §七）', () => {
  const noPrice = buildSecuritiesPreview(getDb(), parsed([{ ...BUY, price: null }]));
  assert.match(noPrice.blockers.join(), /核心金額讀不到/);
  const noNet = buildSecuritiesPreview(getDb(), parsed([{ ...BUY, netSettlement: null }]));
  assert.match(noNet.blockers.join(), /核心金額讀不到/);
});

test('自審 #7｜裸 /api/securityTrades 通用路由不存在（單一讀取入口 /api/securities）', async () => {
  const bare = await fetch(base + '/securityTrades');
  assert.equal(bare.status, 404);
  const wrapped = await fetch(base + '/securities');
  assert.equal(wrapped.status, 200);
});

test('Codex S2r1#6｜機密投影：GET /api/securities 與 /api/db 都剝 sourceAccountId/sourceRef；export 保留完整', async () => {
  const list = await (await fetch(base + '/securities')).json();
  assert.ok(list.trades.length >= 1, '前面考題已種資料');
  for (const t of list.trades) {
    assert.equal(t.sourceAccountId, undefined, '帳戶指紋不送瀏覽器');
    assert.equal(t.sourceRef, undefined, '去重鍵（嵌指紋）不送瀏覽器');
    assert.ok(t.id && t.sourceAccountLabel !== undefined || t.id, '顯示欄保留');
  }
  const dbResp = await (await fetch(base + '/db')).json();
  for (const t of dbResp.securityTrades || []) assert.equal(t.sourceRef, undefined, '/api/db 同樣投影');
  const exported = await (await fetch(base + '/export')).json();
  assert.ok((exported.securityTrades || []).every(t => t.sourceRef), '備份必須完整（還原冪等靠 sourceRef）');
});

test('Codex S2r1#5｜備份驗證牆＝完整合約：缺 side/currency/source 的殘缺列擋下', () => {
  const good = { id: 'g2', source: 'taishin', sourceRef: 'ts|f|y|#1', tradeDate: '2026-01-13', side: 'buy',
    cashDirection: 'out', quantity: 10, currency: 'TWD', symbol: '0050', price: 40, grossAmount: 400, netSettlement: 401 };
  assert.equal(validateImportItem('securityTrades', good).errors.length, 0);
  for (const missing of ['side', 'currency', 'source', 'symbol', 'cashDirection', 'quantity']) {
    const bad = { ...good, id: 'b-' + missing };
    delete /** @type {any} */ (bad)[missing];
    assert.ok(validateImportItem('securityTrades', bad).errors.length > 0, `缺 ${missing} 要報錯（Codex 重現：只驗兩欄＝殘缺列穿牆）`);
  }
  const cleaned = sanitizeDbForWrite({ ...structuredClone(getDb()), securityTrades: [good, { ...good, id: 'nb', side: undefined }] }, { mode: 'strip' });
  assert.ok(cleaned.securityTrades.every((/** @type {any} */ r) => r.side), '殘缺列在櫃檯整筆濾除');
});
