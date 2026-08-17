// @ts-check
// 定存分開列管（William 2026-08-18 裁示：外幣與台幣定存每筆各自一個帳戶）的行為卷。
// 背景＝真實形（合成假值重現）：台新綜合對帳單「外幣帳戶概要區」把同一帳戶印成多列——活存一列＋
// 每筆定存各一列；「存單號碼」欄**空白**、兩筆定存可完全同值（期間/利率/金額全同）＝沒有現成唯一鍵。
// 身分鍵＝機構|末碼|幣別|起迄日|金額|#序（金額進身分＝不同額不吃列印順序；同值才靠序、互換無感）。
// 假資料鐵則：帳號一律 900100/900200/900300 前綴合成值。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseBankSummary } = await import('../lib/bank-statement.js');
const { applyBalancesToDb, previewBalancesForDb } = await import('../lib/services/bank-import.js');
const { reconcileBankStatement } = await import('../lib/statement-reconcile.js');

const L = (/** @type {any[][]} */ pairs) => ({ y: 0, cells: pairs.map((p) => ({ x: p[0], s: p[1] })) });
/** 概要（外幣定存三筆：101.88＋兩筆同值 50.94；活存 JPY/USD）＋台幣區含定存列。 */
const summaryLines = () => [
  L([[47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/01/31']]),
  L([[78, '帳號類別'], [163, '帳戶號碼'], [300, '定存/專案起迄日'], [433, '帳戶餘額'], [509, '備註']]),
  L([[50, '新臺幣活存'], [150, '900100****3301'], [473, '$9,000']]),
  L([[50, '新臺幣定存'], [150, '900100****3301'], [300, '2026/01/10~2026/07/10'], [380, '1.600%'], [473, '$20,000']]),
  L([[47, '合計'], [445, '$29,000']]),
  L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/01/31']]),
  L([[367, 'JPY']]),
  L([[56, '外幣活存'], [108, '900300****162'], [436, '$0'], [491, '$0'], [513, 'Richart']]),
  L([[366, 'USD']]),
  L([[56, '外幣活存'], [108, '900300****162'], [436, '$0.02'], [491, '$1'], [513, 'Richart']]),
  L([[56, '外幣定存'], [108, '900300****162'], [250, '2026/01/25~2026/04/25'], [330, '1.850%'], [436, '$101.88'], [491, '$3,207'], [513, 'Richart']]),
  L([[56, '外幣定存'], [108, '900300****162'], [250, '2026/01/25~2026/04/25'], [330, '1.850%'], [436, '$50.94'], [491, '$1,603'], [513, 'Richart']]),
  L([[56, '外幣定存'], [108, '900300****162'], [250, '2026/01/25~2026/04/25'], [330, '1.850%'], [436, '$50.94'], [491, '$1,603'], [513, 'Richart']]),
  L([[47, '合計'], [490, '0']]),
];
const parsedOf = (/** @type {string|null} */ ref = '2026-01-31') => {
  const r = parseBankSummary(summaryLines());
  return { bank: '台新', referenceDate: ref ?? r.referenceDate, accounts: r.accounts, accountCurrency: r.accountCurrency };
};
const dbOf = (/** @type {any[]} */ accounts = []) => ({ accounts });

test('解析｜定存列結構化：kind=time＋period 抓到；同值兩筆各自保留（不塌列）', () => {
  const r = parseBankSummary(summaryLines());
  const cds = r.accounts.filter((a) => a.kind === 'time');
  assert.equal(cds.length, 4, '台幣 1＋外幣 3（含同值兩筆）');
  assert.equal(cds[0].period, '2026/01/10~2026/07/10', '台幣定存期間');
  assert.deepEqual(cds.slice(1).map((a) => a.period), Array(3).fill('2026/01/25~2026/04/25'));
  assert.deepEqual(cds.slice(1).map((a) => a.balance), [101.88, 50.94, 50.94], '★同值兩筆都在（分開列管的前提）');
  const demand = r.accounts.filter((a) => a.kind === 'demand');
  assert.ok(demand.every((a) => a.period === ''), '活存列無期間');
});

test('套用｜每筆定存各自建帳戶：同值兩筆＝第1筆/第2筆；不同額自成一戶不帶序；活存照舊', () => {
  const db = dbOf();
  const r = applyBalancesToDb(db, /** @type {any} */ (parsedOf()));
  assert.equal(r.created, 7, '台幣活存＋台幣定存＋JPY 活存＋USD 活存＋三筆 USD 定存（JPY 0 也建＝既有行為）');
  const names = db.accounts.map((a) => a.name);
  assert.ok(names.includes('台新 USD 定存 2026/01/25〜2026/04/25・$101.88'), `不同額＝不帶序（實得 ${JSON.stringify(names)}）`);
  assert.ok(names.includes('台新 USD 定存 2026/01/25〜2026/04/25・$50.94（第1筆）'), '★同值第 1 筆');
  assert.ok(names.includes('台新 USD 定存 2026/01/25〜2026/04/25・$50.94（第2筆）'), '★同值第 2 筆（舊版被 first-wins 吃掉的那筆）');
  assert.ok(names.includes('台新 定存 2026/01/10〜2026/07/10・$20000'), '台幣定存也分開列管');
  const cdAccs = db.accounts.filter((a) => a.cdKey);
  assert.equal(cdAccs.length, 4);
  assert.ok(cdAccs.every((a) => a.type === 'cash' && a.balanceAsOf === '2026-01-31'), '定存＝cash 型（緊急預備金分子「活存定存都算」＝derive 既有語意）');
});

test('套用｜次月同帳單重匯＝精確更新既有定存帳戶、不重複建；到期（列消失）＝不動不刪不歸零', () => {
  const db = dbOf();
  applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-01-31')));
  const afterFirst = db.accounts.length;
  const r2 = applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-02-28')));
  assert.equal(db.accounts.length, afterFirst, '★同批定存全部配回原帳戶（cdKey 精確配對）——重建＝配對壞了');
  assert.equal(r2.created, 0);
  assert.ok(db.accounts.filter((a) => a.cdKey).every((a) => a.balanceAsOf === '2026-02-28'), '每筆定存的餘額更新日都跟上');
  // 到期：帳單不再印定存列（只剩活存）——定存帳戶原樣留著（餘額更新日停在最後一期＝使用者一眼可辨）
  const noCd = /** @type {any} */ (parsedOf('2026-03-31'));
  noCd.accounts = noCd.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
  applyBalancesToDb(db, noCd);
  const cds = db.accounts.filter((a) => a.cdKey);
  assert.equal(cds.length, 4, '★到期不刪');
  assert.ok(cds.every((a) => a.balanceAsOf === '2026-02-28'), '★到期不動（不歸零、更新日停格）——錢的紀錄留給使用者處理');
});

test('保護｜活存列絕不配到定存帳戶（cdKey 帳戶不進泛用比對）——同末碼同幣別也不行', () => {
  const db = dbOf([{ id: 'cd1', name: '台新 定存', type: 'cash', bank: '台新', currency: 'TWD', balance: 20000, accountNo: '900100****3301', cdKey: '台新|3301|TWD|2026/01/10~2026/07/10|20000|#1', balanceAsOf: '2025-12-31' }]);
  const parsed = /** @type {any} */ (parsedOf());
  parsed.accounts = parsed.accounts.filter((/** @type {any} */ a) => a.kind === 'demand' && a.currency === 'TWD');
  const r = applyBalancesToDb(db, parsed);
  assert.equal(db.accounts.find((a) => a.id === 'cd1')?.balance, 20000, '★活存 9,000 不可蓋進定存帳戶（matchAccount 的 cdKey 護欄）');
  assert.equal(r.created, 1, '活存自己新建一戶');
});

test('預覽＝套用：定存列各自成列（含名稱）、去重與套用同一套（舊版 preview 不去重＝所見≠所得的縫）', () => {
  const db = dbOf();
  const pv = previewBalancesForDb(db, /** @type {any} */ (parsedOf()));
  const apply = applyBalancesToDb(dbOf(), /** @type {any} */ (parsedOf()));
  const actionable = pv.rows.filter((r) => r.action === 'create').length;
  assert.equal(actionable, apply.created, `★預覽 create 筆數＝套用 created（實得 ${actionable} vs ${apply.created}）`);
  const cdLabels = pv.rows.map((r) => r.label).filter((l) => /定存/.test(String(l)));
  assert.ok(cdLabels.includes('台新 USD 定存 2026/01/25〜2026/04/25・$50.94（第2筆）'), '預覽就看得到「第2筆」＝所見即所得');
  // 同批重複活存列（同遮罩同幣別）＝預覽也去重（與套用一致）
  const dup = /** @type {any} */ (parsedOf());
  dup.accounts = [...dup.accounts, dup.accounts.find((/** @type {any} */ a) => a.kind === 'demand' && a.currency === 'TWD')];
  const pv2 = previewBalancesForDb(dbOf(), dup);
  const apply2 = applyBalancesToDb(dbOf(), dup);
  assert.equal(pv2.rows.length, pv.rows.length, '★重複列在預覽就被去掉');
  assert.equal(apply2.created, apply.created);
});

test('對帳閘｜台幣定存列不進「末筆對概要」（定存沒有明細；同遮罩會拿活存末筆去對定存金額＝合法帳單整份誤擋）', () => {
  const parsed = /** @type {any} */ (parsedOf());
  // 活存明細：末筆餘額 9,000＝對得上活存概要；若定存列也被拿去對＝9,000 vs 20,000 必炸
  parsed.transactions = [
    { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-01-05', summary: '存入', direction: 'in', amount: 100, balance: 8900, note: '' },
    { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-01-06', summary: '存入', direction: 'in', amount: 100, balance: 9000, note: '' },
  ];
  const rec = reconcileBankStatement(parsed);
  assert.ok(!rec.problems.some((/** @type {any} */ p) => p.code === 'bank-end-balance'), `★定存列要跳過末筆對概要（實得 ${JSON.stringify(rec.problems.map((/** @type {any} */ p) => p.code))}）`);
  // 活存概要本身仍被守著：把活存概要改錯＝照樣紅（skip 只限定存列、不是把整道拆了）
  const bad = /** @type {any} */ (parsedOf());
  bad.transactions = parsed.transactions;
  const twd = bad.accounts.find((/** @type {any} */ a) => a.kind === 'demand' && a.currency === 'TWD');
  twd.balance = 7777;
  const rec2 = reconcileBankStatement(bad);
  assert.ok(rec2.problems.some((/** @type {any} */ p) => p.code === 'bank-end-balance'), '★活存列照樣進末筆對概要');
});
