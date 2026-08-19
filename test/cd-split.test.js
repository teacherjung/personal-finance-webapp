// @ts-check
// 定存分開列管（William 2026-08-18 裁示：外幣與台幣定存每筆各自一個帳戶）的行為卷。
// 背景＝真實形（合成假值重現）：台新綜合對帳單「外幣帳戶概要區」把同一帳戶印成多列——活存一列＋
// 每筆定存各一列；「存單號碼」欄**空白**、兩筆定存可完全同值（期間/利率/金額全同）＝沒有現成唯一鍵。
// 身分鍵＝機構|末碼|幣別|起迄日|金額|#序（金額進身分＝不同額不吃列印順序；同值才靠序、互換無感）。
// 假資料鐵則：帳號一律 900100/900200/900300 前綴合成值。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 2026-08-18（#488 r1#1）：到期歸零只吃**確定性解析**（內建範本）——本卷量的就是模板路線，一律帶旗標。
// 機率性路線（AI／配方）一律不歸零，承重在 test/ai-time-deposit.test.js。
const DET = { deterministic: true };

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
  const r = applyBalancesToDb(db, /** @type {any} */ (parsedOf()), DET);
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

test('套用｜次月同帳單重匯＝精確更新既有定存帳戶、不重複建；到期（列消失＋過迄日）＝歸零加註「已到期」（William 2026-08-18 裁示 b 改版）', () => {
  const db = dbOf();
  applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-01-31')), DET);
  const afterFirst = db.accounts.length;
  const r2 = applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-02-28')), DET);
  assert.equal(db.accounts.length, afterFirst, '★同批定存全部配回原帳戶（cdKey 精確配對）——重建＝配對壞了');
  assert.equal(r2.created, 0);
  assert.ok(db.accounts.filter((a) => a.cdKey).every((a) => a.balanceAsOf === '2026-02-28'), '每筆定存的餘額更新日都跟上');
  // 到期：帳單不再印定存列（只剩活存）＋現值參考日已過迄日（外幣定存迄日 2026/04/25、台幣 2026/07/10）
  const noCd = /** @type {any} */ (parsedOf('2026-05-31'));
  noCd.accounts = noCd.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
  const r3 = applyBalancesToDb(db, noCd, DET);
  const cds = db.accounts.filter((a) => a.cdKey);
  assert.equal(cds.length, 4, '★到期不刪（帳戶留著＝歷史與掛名不斷線）');
  const usd = cds.filter((a) => a.currency === 'USD');
  assert.equal(r3.matured, 3, '★三筆外幣定存過了迄日＝歸零（裁示 b）');
  assert.ok(usd.every((a) => a.balance === 0 && /（已到期）/.test(String(a.name))), '★歸零＋名稱加「已到期」');
  assert.ok(usd.every((a) => a.balanceAsOf === '2026-05-31'), '歸零那一刻的參考日');
  const twd = cds.find((a) => a.currency === 'TWD');
  assert.equal(twd?.balance, 20000, '★台幣定存迄日 2026/07/10 還沒到＝不動（只有過了迄日才歸零）');
  assert.ok(!/（已到期）/.test(String(twd?.name)), '沒到期不加註');
});

test('到期歸零｜三個條件缺一不可：別家帳單／這期還印著／迄日未到／讀不出迄日＝一律不歸零（不誤歸零）', () => {
  const base = () => [{ id: 'x', name: '台新 USD 定存 A', type: 'cash', bank: '台新', currency: 'USD', balance: 100,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|100|#1', balanceAsOf: '2026-01-31' }];
  const noCdParsed = (/** @type {string} */ ref, /** @type {any} */ over = {}) => {
    const p = /** @type {any} */ (parsedOf(ref));
    p.accounts = p.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
    return { ...p, ...over };
  };
  // ①別家帳單（機構不同）＝不判它死活
  const d1 = dbOf(base());
  applyBalancesToDb(d1, /** @type {any} */ ({ ...noCdParsed('2026-05-31'), bank: '一銀' }), DET);
  assert.equal(d1.accounts[0].balance, 100, '★別家帳單不得歸零本行定存');
  // ②這張帳單沒涵蓋這個末碼＝不判（帳號集合裡沒有 162）
  const d2 = dbOf(base());
  const p2 = noCdParsed('2026-05-31');
  p2.accounts = p2.accounts.filter((/** @type {any} */ a) => a.suffix !== '162');
  p2.accountCurrency = Object.fromEntries(Object.entries(p2.accountCurrency).filter(([k]) => !k.endsWith('162')));
  applyBalancesToDb(d2, /** @type {any} */ (p2), DET);
  assert.equal(d2.accounts[0].balance, 100, '★帳單沒涵蓋該帳號＝不判死活');
  // ③迄日未到
  const d3 = dbOf(base());
  applyBalancesToDb(d3, /** @type {any} */ (noCdParsed('2026-03-31')), DET);
  assert.equal(d3.accounts[0].balance, 100, '★迄日 4/25 未到＝不歸零');
  // ④讀不出迄日（舊帳戶 cdKey 無期間）＝fail-safe 不歸零
  const d4 = dbOf([{ ...base()[0], cdKey: '台新|162|USD||100|#1' }]);
  applyBalancesToDb(d4, /** @type {any} */ (noCdParsed('2026-05-31')), DET);
  assert.equal(d4.accounts[0].balance, 100, '★讀不出迄日＝不歸零（fail-safe）');
  // ⑤這期還印著（正常在存）＝不歸零：帳戶的 cdKey 用**帳單真的會產生**的那把（金額 101.88），
  //   餘額先設成舊值 1 來驗「有被更新、沒被歸零」。
  const d5 = dbOf([{ id: 'y', name: '台新 USD 定存 B', type: 'cash', bank: '台新', currency: 'USD', balance: 1,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|101.88|#1', balanceAsOf: '2026-01-31' }]);
  applyBalancesToDb(d5, /** @type {any} */ (parsedOf('2026-05-31')), DET);
  const still = d5.accounts.find((a) => a.cdKey === '台新|162|USD|2026/01/25~2026/04/25|101.88|#1');
  assert.equal(still?.balance, 101.88, '★這期還印著＝照常更新、不歸零（雖然過了迄日）');
  assert.ok(!/（已到期）/.test(String(still?.name)), '還印著就不加註');
});

test('到期歸零｜預覽就看得到（所見即所得）＋完成提示會講；已歸零的不重複動', async () => {
  const { bankApplyDoneText } = await import('../public/modules/cashflow-model.js');
  const db = dbOf([{ id: 'x', name: '台新 USD 定存 A', type: 'cash', bank: '台新', currency: 'USD', balance: 100,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|100|#1', balanceAsOf: '2026-01-31' }]);
  const p = /** @type {any} */ (parsedOf('2026-05-31'));
  p.accounts = p.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
  const pv = previewBalancesForDb(db, p, DET);
  const row = pv.rows.find((r) => r.action === 'mature-zero');
  assert.ok(row, '★預覽要列出到期歸零那一列（不能匯入後才發現餘額被清成 0）');
  assert.equal(row.balance, 0);
  assert.equal(row.oldBalance, 100);
  assert.match(String(row.label), /（已到期）/);
  const r = applyBalancesToDb(db, p, DET);
  assert.equal(r.matured, 1);
  assert.match(bankApplyDoneText(/** @type {any} */ (r), /** @type {any} */ ({ imported: 0 })), /1 筆定存已到期歸零/, '★完成提示要講（餘額被清了卻不說＝畫面說謊）');
  const again = applyBalancesToDb(db, /** @type {any} */ ({ ...p, referenceDate: '2026-06-30' }), DET);
  assert.equal(again.matured, undefined, '★已歸零的不重複動（不重寫日期、不重複加註）');
  assert.equal(db.accounts[0].name.match(/（已到期）/g)?.length, 1, '「已到期」只加一次');
});

test('保護｜活存列絕不配到定存帳戶（cdKey 帳戶不進泛用比對）——同末碼同幣別也不行', () => {
  const db = dbOf([{ id: 'cd1', name: '台新 定存', type: 'cash', bank: '台新', currency: 'TWD', balance: 20000, accountNo: '900100****3301', cdKey: '台新|3301|TWD|2026/01/10~2026/07/10|20000|#1', balanceAsOf: '2025-12-31' }]);
  const parsed = /** @type {any} */ (parsedOf());
  parsed.accounts = parsed.accounts.filter((/** @type {any} */ a) => a.kind === 'demand' && a.currency === 'TWD');
  const r = applyBalancesToDb(db, parsed, DET);
  assert.equal(db.accounts.find((a) => a.id === 'cd1')?.balance, 20000, '★活存 9,000 不可蓋進定存帳戶（matchAccount 的 cdKey 護欄）');
  assert.equal(r.created, 1, '活存自己新建一戶');
});

test('預覽＝套用：定存列各自成列（含名稱）、去重與套用同一套（舊版 preview 不去重＝所見≠所得的縫）', () => {
  const db = dbOf();
  const pv = previewBalancesForDb(db, /** @type {any} */ (parsedOf()), DET);
  const apply = applyBalancesToDb(dbOf(), /** @type {any} */ (parsedOf()), DET);
  const actionable = pv.rows.filter((r) => r.action === 'create').length;
  assert.equal(actionable, apply.created, `★預覽 create 筆數＝套用 created（實得 ${actionable} vs ${apply.created}）`);
  const cdLabels = pv.rows.map((r) => r.label).filter((l) => /定存/.test(String(l)));
  assert.ok(cdLabels.includes('台新 USD 定存 2026/01/25〜2026/04/25・$50.94（第2筆）'), '預覽就看得到「第2筆」＝所見即所得');
  // 同批重複活存列（同遮罩同幣別）＝預覽也去重（與套用一致）
  const dup = /** @type {any} */ (parsedOf());
  dup.accounts = [...dup.accounts, dup.accounts.find((/** @type {any} */ a) => a.kind === 'demand' && a.currency === 'TWD')];
  const pv2 = previewBalancesForDb(dbOf(), dup, DET);
  const apply2 = applyBalancesToDb(dbOf(), dup, DET);
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

test('Grok 補強｜kind 負向：「定期定額」不當定存；period 分隔符變體（〜/至/-）都抓得到', () => {
  const lines = [
    L([[47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/01/31']]),
    L([[50, '定期定額'], [150, '900100****3301'], [473, '$5,000']]),
    L([[50, '新臺幣定存'], [150, '900100****3301'], [300, '2026/01/10〜2026/07/10'], [473, '$1,000']]),
    L([[50, '新臺幣定存'], [150, '900100****3301'], [300, '2026/01/10至2026/07/10'], [473, '$2,000']]),
    L([[50, '定期存款'], [150, '900100****3301'], [300, '2026/01/10-2026/07/10'], [473, '$3,000']]),
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.accounts[0].kind, 'demand', '★「定期定額」是投資申購、誤中＝建假定存戶＋末筆閘卸甲');
  assert.deepEqual(r.accounts.slice(1).map((a) => a.kind), ['time', 'time', 'time']);
  assert.ok(r.accounts.slice(1).every((a) => a.period === '2026/01/10~2026/07/10'), `★三種分隔符都抓到**且正規化成同一表示**（r1#1：原樣入鍵＝換分隔符就裂戶；實得 ${JSON.stringify(r.accounts.map((a) => a.period))}）`);
});

test('Grok 補強｜次月列印順序打亂＝異值定存照樣精確配回（金額進身分的承重；同值互換＝無感）', () => {
  const db = dbOf();
  applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-01-31')), DET);
  const n = db.accounts.length;
  const m2 = /** @type {any} */ (parsedOf('2026-02-28'));
  const cds = m2.accounts.filter((/** @type {any} */ a) => a.kind === 'time');
  m2.accounts = [...m2.accounts.filter((/** @type {any} */ a) => a.kind !== 'time'), ...cds.reverse()];   // 101.88 移到最後
  const r = applyBalancesToDb(db, m2, DET);
  assert.equal(r.created, 0, '★順序打亂不得裂戶（金額在身分裡）');
  assert.equal(db.accounts.length, n);
  const big = db.accounts.find((a) => /101\.88/.test(String(a.name)));
  assert.equal(big?.balanceAsOf, '2026-02-28', '101.88 那顆真的被更新到');
});

test('Grok 補強（釘現況）｜同值兩筆只到期一筆＝殘存列重編第1筆、第2筆停格——已知殘餘（無存單號機械無解）', () => {
  const db = dbOf();
  applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-01-31')), DET);
  const m2 = /** @type {any} */ (parsedOf('2026-02-28'));
  const c51 = m2.accounts.filter((/** @type {any} */ a) => a.kind === 'time' && a.balance === 50.94);
  m2.accounts = m2.accounts.filter((/** @type {any} */ a) => a !== c51[1]);   // 拿掉一筆 50.94
  const r = applyBalancesToDb(db, m2, DET);
  assert.equal(r.created, 0, '★不裂新戶');
  const first = db.accounts.find((a) => /50\.94（第1筆）/.test(String(a.name)));
  const second = db.accounts.find((a) => /50\.94（第2筆）/.test(String(a.name)));
  assert.equal(first?.balanceAsOf, '2026-02-28', '殘存那筆更新到 #1（同值互換無感＝可接受）');
  assert.equal(second?.balanceAsOf, '2026-01-31', '#2 停格（迄日 4/25 未到＝fail-safe 不歸零）');
  assert.equal(second?.balance, 50.94, '迄日前不歸零');
  // 過迄日之後：#2（被當成不再印的那顆）會歸零加註＝契約殘餘①現在的真行為（r1#3：原題只證迄日前）
  const m3 = /** @type {any} */ (parsedOf('2026-05-31'));
  const c51b = m3.accounts.filter((/** @type {any} */ a) => a.kind === 'time' && a.balance === 50.94);
  m3.accounts = m3.accounts.filter((/** @type {any} */ a) => a !== c51b[1]);
  applyBalancesToDb(db, m3, DET);
  const second2 = db.accounts.find((a) => /50\.94（第2筆）/.test(String(a.name)) || /50\.94（第2筆）（已到期）/.test(String(a.name)));
  assert.equal(second2?.balance, 0, '★過迄日＋這期不再印它＝歸零（契約殘餘①的新行為）');
  assert.match(String(second2?.name), /（已到期）/);
});

test('Grok 補強（釘現況）｜中途變額＝新鍵新戶、舊戶停格雙戶並列（可見不錯配；契約紅字殘餘②）', () => {
  const db = dbOf();
  applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-01-31')), DET);
  const n = db.accounts.length;
  const m2 = /** @type {any} */ (parsedOf('2026-02-28'));
  const big = m2.accounts.find((/** @type {any} */ a) => a.kind === 'time' && a.balance === 101.88);
  big.balance = 102.5;   // 本息合印＝金額變
  const r = applyBalancesToDb(db, m2, DET);
  assert.equal(r.created, 1, '★變額＝新戶（寧可雙戶可見、不錯配）');
  assert.equal(db.accounts.length, n + 1);
  assert.equal(db.accounts.find((a) => /101\.88/.test(String(a.name)))?.balanceAsOf, '2026-01-31', '舊戶停格（迄日 4/25 未到）');
  // 過迄日之後：舊鍵那顆歸零加註＝契約殘餘②的真行為
  const m3 = /** @type {any} */ (parsedOf('2026-05-31'));
  const big3 = m3.accounts.find((/** @type {any} */ a) => a.kind === 'time' && a.balance === 101.88);
  big3.balance = 102.5;
  applyBalancesToDb(db, m3, DET);
  const old101 = db.accounts.find((a) => /101\.88/.test(String(a.name)));
  assert.equal(old101?.balance, 0, '★過迄日的舊鍵戶歸零（不再是永久雙戶並列）');
  assert.match(String(old101?.name), /（已到期）/);
});

test('Grok 補強｜交易掛名繞開定存戶（accountNameForTx 直測；「轉入到」的承重在下一題）', async () => {
  const db = dbOf([
    { id: 'cd1', name: '台新 定存 X', type: 'cash', bank: '台新', currency: 'TWD', balance: 20000, accountNo: '900100****3301', cdKey: '台新|3301|TWD|p|20000|#1' },
    { id: 'demand1', name: '台新活儲', type: 'cash', bank: '台新', currency: 'TWD', balance: 9000, accountNo: '900100****3301' },
  ]);
  const parsed = /** @type {any} */ (parsedOf());
  const tx = { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-01-05', summary: 's', direction: 'in', amount: 1, balance: null, note: '' };
  const { accountNameForTxForTest } = await import('../lib/services/bank-import.js');
  assert.equal(accountNameForTxForTest(db, tx, parsed), '台新活儲', '★同末碼下交易掛名要挑活存戶、不可掛到定存戶');
});

test('r1#1｜跨月只變分隔符（~→至）＝照樣配回原戶、不裂戶雙計（期間正規化的承重）', () => {
  const db = dbOf();
  applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-01-31')), DET);
  const n = db.accounts.length;
  const linesAlt = summaryLines().map((l) => ({ y: l.y, cells: l.cells.map((c) => ({ x: c.x, s: String(c.s).replace(/~/g, '至') })) }));
  const r2p = parseBankSummary(linesAlt);
  const r = applyBalancesToDb(db, /** @type {any} */ ({ bank: '台新', referenceDate: '2026-02-28', accounts: r2p.accounts, accountCurrency: r2p.accountCurrency }), DET);
  assert.equal(r.created, 0, '★分隔符變體不得裂戶（Codex r1#1 的探針形）');
  assert.equal(db.accounts.length, n);
});

test('r1#2｜掛名概要退路繞開定存列：定存列印在活存前＋db 無帳戶＝掛名不得取定存名', async () => {
  const { accountNameForTxForTest } = await import('../lib/services/bank-import.js');
  const parsed = /** @type {any} */ (parsedOf());
  // 把台幣定存列移到最前（版面順序對掛名退路的影響＝r1#2 的形）
  const cdRow = parsed.accounts.find((/** @type {any} */ a) => a.kind === 'time' && a.currency === 'TWD');
  parsed.accounts = [cdRow, ...parsed.accounts.filter((/** @type {any} */ a) => a !== cdRow)];
  const tx = { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-01-05', summary: 's', direction: 'in', amount: 1, balance: null, note: '' };
  const name = accountNameForTxForTest(/** @type {any} */ ({ accounts: [] }), tx, parsed);
  // ⚠️ 斷言要**精確等於活存列的命名**——首版只斷言「不含定存」＝假綠（定存列的 autoName 取 note
  //（期間＋利率）當 tag、名字裡根本沒有「定存」二字，拔掉繞開照樣過＝P77 第一刀實測沒咬）。
  assert.equal(String(name), '台新 3301（新臺幣活存）', `★退路必須取活存列（實得 ${name}——帶期間利率＝取到定存列）`);
});

test('r1#3｜「轉入到」顯示繞開定存戶（ownAccountNameByAcct 的承重——首版只考了掛名一讀端＝敘事綠）', async () => {
  const { ownAccountNameByAcctForTest } = await import('../lib/services/bank-import.js');
  const db = dbOf([
    { id: 'cd1', name: '台新 定存 X', type: 'cash', bank: '台新', currency: 'TWD', balance: 20000, accountNo: '900100****3301', cdKey: 'k#1' },
    { id: 'd1', name: '台新活儲', type: 'cash', bank: '台新', currency: 'TWD', balance: 9000, accountNo: '900100****3301' },
  ]);
  assert.equal(ownAccountNameByAcctForTest(db, '900100****3301', '台新'), '台新活儲', '★同末碼下「轉入到」要顯示活存名');
});

test('r2#1｜跨月只變日期補零印法（2026/01/10→2026/1/10）＝照樣配回原戶不裂戶（期間固定表示的承重）', () => {
  const db = dbOf();
  applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-01-31')), DET);
  const n = db.accounts.length;
  const linesAlt = summaryLines().map((l) => ({ y: l.y, cells: l.cells.map((c) => ({ x: c.x, s: String(c.s).replace(/2026\/01\/10/g, '2026/1/10').replace(/2026\/07\/10/g, '2026/7/10') })) }));
  const r2p = parseBankSummary(linesAlt);
  const r = applyBalancesToDb(db, /** @type {any} */ ({ bank: '台新', referenceDate: '2026-02-28', accounts: r2p.accounts, accountCurrency: r2p.accountCurrency }), DET);
  assert.equal(r.created, 0, '★同一天的兩種合法印法不得裂戶（Codex r2#1 合成重現的形）');
  assert.equal(db.accounts.length, n);
});

test('Grok 補強｜參考日非 ISO（2026/03/31）：正式路在上游就 blocked＝不歸零也不更新（誠實：Grok 那條「高」不可達）＋正規化縱深直測', async () => {
  const { maturedCdAccountsForTest } = await import('../lib/services/bank-import.js');
  const acc = () => [{ id: 'x', name: '台新 USD 定存 A', type: 'cash', bank: '台新', currency: 'USD', balance: 100,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|100|#1', balanceAsOf: '2026-01-31' }];
  const noCd = (/** @type {string} */ ref) => {
    const p = /** @type {any} */ (parsedOf('2026-01-31'));
    p.accounts = p.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
    return { ...p, referenceDate: ref };
  };
  // ①正式路：非 ISO 參考日＝整份 balancesSkipped（既有行為）＝定存也不會被誤歸零
  const db = dbOf(acc());
  const r = applyBalancesToDb(db, /** @type {any} */ (noCd('2026/03/31')), DET);
  assert.equal(r.balancesSkipped, true, '★非 ISO 參考日在上游就擋（不是靠歸零這段防）');
  assert.equal(db.accounts[0].balance, 100);
  // ②縱深防禦直測：就算有呼叫端不先驗 ref，兩端正規化後也不得反向（迄日 4/25 未到＝不歸零）
  const early = maturedCdAccountsForTest(acc(), noCd('2026/03/31'), '台新', new Set(), '2026/03/31', true);
  assert.equal(early.length, 0, '★字串序陷阱（「/」>「-」）不得讓未到期定存進歸零名單');
  const late = maturedCdAccountsForTest(acc(), noCd('2026/05/31'), '台新', new Set(), '2026/05/31', true);
  assert.equal(late.length, 1, '★正規化後照樣認得出已過迄日');
});

test('Grok 補強｜迄日當天（ref === 迄日）＝仍算在存、不歸零；隔天才歸零（邊界釘死）', () => {
  const acc = () => [{ id: 'x', name: '台新 USD 定存 A', type: 'cash', bank: '台新', currency: 'USD', balance: 100,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|100|#1', balanceAsOf: '2026-01-31' }];
  const noCd = (/** @type {string} */ ref) => {
    const p = /** @type {any} */ (parsedOf('2026-01-31'));
    p.accounts = p.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
    return { ...p, referenceDate: ref };
  };
  const sameDay = dbOf(acc());
  applyBalancesToDb(sameDay, /** @type {any} */ (noCd('2026-04-25')), DET);
  assert.equal(sameDay.accounts[0].balance, 100, '★迄日當天不歸零（當天才解約、錢可能還在）');
  const nextDay = dbOf(acc());
  assert.equal(applyBalancesToDb(nextDay, /** @type {any} */ (noCd('2026-04-26')), DET).matured, 1, '★隔天＝歸零');
});

test('Grok 補強｜沒有機構戳的定存戶＝不歸零（fail-safe；與 matchAccount 的「無戳寬鬆」刻意相反）', () => {
  const db = dbOf([{ id: 'x', name: '手動建的定存', type: 'cash', currency: 'USD', balance: 100,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|100|#1', balanceAsOf: '2026-01-31' }]);
  const p = /** @type {any} */ (parsedOf('2026-05-31'));
  p.accounts = p.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
  applyBalancesToDb(db, p, DET);
  assert.equal(db.accounts[0].balance, 100, '★無戳＝不敢判它是不是這家的＝不歸零（猜錯就是把還在的定存清成 0）');
});

test('Grok 補強｜台幣定存過了迄日也會歸零（正向覆蓋，不是只有外幣）；多筆時預覽列數＝套用筆數', () => {
  const db = dbOf();
  applyBalancesToDb(db, /** @type {any} */ (parsedOf('2026-01-31')), DET);
  const late = /** @type {any} */ (parsedOf('2026-08-31'));   // 台幣迄日 2026/07/10、外幣 04/25 都過了
  late.accounts = late.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
  const pv = previewBalancesForDb(db, late, DET);
  const pvCount = pv.rows.filter((r) => r.action === 'mature-zero').length;
  const r = applyBalancesToDb(db, late, DET);
  assert.equal(r.matured, 4, '★台幣＋三筆外幣全部歸零');
  assert.equal(pvCount, r.matured, '★預覽列數＝實際歸零筆數（多筆時最容易漂）');
  assert.ok(db.accounts.filter((a) => a.cdKey).every((a) => a.balance === 0));
});

test('Grok 補強｜半形「(已到期)」也算已加註（手改過的名字不得被追加第二截）', () => {
  const db = dbOf([{ id: 'x', name: '台新 USD 定存 A(已到期)', type: 'cash', bank: '台新', currency: 'USD', balance: 100,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|100|#1', balanceAsOf: '2026-01-31' }]);
  const p = /** @type {any} */ (parsedOf('2026-05-31'));
  p.accounts = p.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
  applyBalancesToDb(db, p, DET);
  assert.equal(db.accounts[0].name, '台新 USD 定存 A(已到期)', '★不重複加註（半形也認）');
  assert.equal(db.accounts[0].balance, 0, '照樣歸零');
});

test('r1#1｜AI／配方形狀（accounts 無 kind）＝不判定存死活：明明還印著的定存不得被歸零', () => {
  const db = dbOf([{ id: 'x', name: '台新 USD 定存 A', type: 'cash', bank: '台新', currency: 'USD', balance: 100,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|100|#1', balanceAsOf: '2026-01-31' }]);
  // AI/配方輸出：同銀行、同末碼、同餘額、參考日已過迄日，但 accounts 沒有 kind/period 欄
  const aiLike = { bank: '台新', referenceDate: '2026-05-31',
    accounts: [{ suffix: '162', masked: '900300****162', balance: 100, currency: 'USD', label: '外幣', note: '' }],
    accountCurrency: { '900300****162': 'USD' } };
  const pv = previewBalancesForDb(db, /** @type {any} */ (aiLike), DET);
  assert.ok(!pv.rows.some((r) => r.action === 'mature-zero'), '★無結構化欄位＝不判死活（預覽就不得出現歸零列）');
  const r = applyBalancesToDb(db, /** @type {any} */ (aiLike), DET);
  assert.equal(r.matured, undefined, '★AI/配方路線照舊（契約明文）');
  assert.equal(db.accounts[0].balance, 100, '★還印著的定存不得被清成 0（審查者可達情境）');
});

test('r1#2｜倒序匯入：舊帳單不得把較新的定存餘額清成 0（到期分支也吃 stale guard）', () => {
  const db = dbOf([{ id: 'x', name: '台新 USD 定存 A', type: 'cash', bank: '台新', currency: 'USD', balance: 100,
    accountNo: '900300****162', cdKey: '台新|162|USD|2026/01/25~2026/04/25|100|#1', balanceAsOf: '2026-06-30' }]);
  const older = /** @type {any} */ (parsedOf('2026-05-31'));
  older.accounts = older.accounts.filter((/** @type {any} */ a) => a.kind !== 'time');
  const pv = previewBalancesForDb(db, older, DET);
  assert.ok(!pv.rows.some((r) => r.action === 'mature-zero'), '★預覽也不得顯示歸零（所見即所得）');
  const r = applyBalancesToDb(db, older, DET);
  assert.equal(r.matured, undefined);
  assert.equal(db.accounts[0].balance, 100, '★舊帳單不得覆蓋較新的餘額');
  assert.equal(db.accounts[0].balanceAsOf, '2026-06-30', '★日期不得倒退');
});
