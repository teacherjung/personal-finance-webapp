// 哨兵匯率（William 2026-09-04 裁示，#558 r5 之後）：
// 「三個檔不可自己寫死匯率」原本只靠 test/derive.test.js 的結構考題看程式形狀，連三輪被審查者用新形狀戳穿
// （正規式假綠假紅 → missing 豁免太寬 → `Boolean(f.missing)` 躲末端名字）。形狀列舉補不完，所以改成**行為**考題：
// 把不可能被寫死的匯率餵進設定，lib/derive.js、lib/services/snapshot.js、public/modules/portfolio-model.js
// **每一處**換算都必須用到它——任何寫死的 31／41／0.2 會算出別的數字而被抓，不必再跟形狀軍備競賽
// （結構考題留著當第二道網：抓「有匯率卻不用、退路寫死」的死程式）。
// **兩組哨兵、分別落在每個預設值的上方與下方**（#558 r6：只有高哨兵時 `Math.max(rate, 31)` 這種下限夾制抓不到，
// 而它在正式路徑會算錯金額）：高組 12345／23456／34567，低組 2.5／3.75／0.125（都是二進位精確數、乘積不會有浮點誤差）；
// 任何把匯率夾在預設值一側的寫法，兩組至少一組會紅；低組同時走到換匯區間的「已低於」分支。
//
// 覆蓋的換算點（逐點突變過：每一處換成 `* 31`／`: 31`／`÷ 31`／`Math.max(…, 31)`／`Math.min(…, 31)` 本檔都轉紅）：
//   derive.js          computeAssets 帳戶×匯率、持股×匯率；computeIb 市值／成本×匯率；computeLeverage 官方淨值×USD 兩處、
//                      本機 ibCashCur 帳戶×匯率；提醒：融資利息×USD、閒置現金（×匯率、÷USD）、換匯區間的 usdTwd
//   snapshot.js        日線的 usdTwd／gbpTwd／jpyTwd（pfValue／netWorth 經 derive）
//   portfolio-model.js 持股×匯率、帳戶×匯率（accTwd）、官方淨值×USD 兩處
// ⚠️ 絆線（最後一題）：釘住三個檔「用到匯率的地方」各有幾處——新增一處那題會紅，提醒來這裡補哨兵斷言；
//    這是列舉不是通則：新寫法若不長 `f.rate`／`rates.USD`／`fx.USD`／`fxTable.rates.` 這幾種樣子，絆線看不到。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';

// 隔離：STORE_FILE 指向 os 暫存檔（同 daily-values.test.js 規矩），絕不碰真實 data/；所以全部用動態 import（先設環境變數）。
const TEST_STORE = join(tmpdir(), `finance-fx-sentinel-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;
const store = await import('../lib/store.js');
const { recordDailyValue } = await import('../lib/services/snapshot.js');
const { computeAssets, computeIb, computeLeverage, buildSummary } = await import('../lib/derive.js');
const { buildPortfolioModel } = await import('../public/modules/portfolio-model.js');
after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

const any = (/** @type {any} */ x) => x;
const SETS = [
  { label: '高組（預設值上方）', USD: 12345, GBP: 23456, JPY: 34567 },   // 不是任何預設值、彼此不成整數倍、一眼認得出
  { label: '低組（預設值下方）', USD: 2.5, GBP: 3.75, JPY: 0.125 },      // 全部低於 31／41／0.2；二進位精確
];
const { FX_DEFAULT_TWD } = await import('../public/modules/fx-rates.js');
for (const cur of /** @type {const} */ (['USD', 'GBP', 'JPY'])) {
  assert.ok(SETS[0][cur] > FX_DEFAULT_TWD[cur] && SETS[1][cur] < FX_DEFAULT_TWD[cur], `夾具前提：${cur} 的兩組哨兵要分別落在預設值 ${FX_DEFAULT_TWD[cur]} 兩側（改預設值時來對一下）`);
}

for (const { label, USD, GBP, JPY } of SETS) {
const S = Object.freeze({ usdTwd: USD, fxTwd: { GBP, JPY } });
/** @type {any[]} */
const holdingsFx = [
  { id: 'hu', symbol: 'VT', currency: 'USD', price: 1, quantity: 1, avgCost: 1, source: 'ib' },
  { id: 'hg', symbol: 'ISF', currency: 'GBP', price: 1, quantity: 1, avgCost: 1 },
];
/** @type {any[]} */
const accountsFx = [
  { id: 'au', name: '美元', type: 'cash', class: '現金', currency: 'USD', balance: 1 },
  { id: 'ag', name: '英鎊', type: 'cash', class: '現金', currency: 'GBP', balance: 1 },
  { id: 'aj', name: '日圓', type: 'cash', class: '現金', currency: 'JPY', balance: 1 },
];
const fmtTwd = (/** @type {number} */ n) => Math.round(n).toLocaleString('en-US') + ' 元';   // 同 derive.js 的 fmt

test(`哨兵｜${label}｜derive.computeAssets：帳戶餘額與持股市值每一筆都用設定裡的匯率換算`, () => {
  const r = computeAssets(any({ settings: S, accounts: accountsFx, holdings: holdingsFx }));
  assert.equal(r.assets, 2 * USD + 2 * GBP + JPY, '三個帳戶＋兩筆持股，全部乘哨兵匯率');
  assert.equal(r.netWorth, r.assets);
  assert.deepEqual(r.defaultFx, [], '哨兵是「抓到的」匯率，不該標成預設值');
  assert.deepEqual(r.missingFx, []);
});

test(`哨兵｜${label}｜derive.computeIb：市值與成本都乘設定裡的匯率`, () => {
  const ib = computeIb(any({ settings: S, holdings: holdingsFx }));
  assert.equal(ib.totalValue, USD + GBP);
  assert.equal(ib.totalCost, USD + GBP);
  assert.deepEqual(ib.positions.map(p => p.fxSource), ['live', 'live']);   // USD 市值較大排前面
});

test(`哨兵｜${label}｜derive.computeLeverage：官方淨值摘要的持股與欠款都乘 USD 哨兵`, () => {
  const db = any({ settings: { ...S, ib: { lastEquity: { stock: 2, cash: -1 } } }, holdings: [], accounts: [] });
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.ibValue, 2 * USD);
  assert.equal(lev.loan, USD);
  assert.equal(lev.leverage, 2);
});

test(`哨兵｜${label}｜derive.computeLeverage：沒有官方摘要時，本機 ibCashCur 欠款用該幣別的哨兵換算`, () => {
  const db = any({ settings: S,
    holdings: [{ id: 'hu', symbol: 'VT', currency: 'USD', price: 2, quantity: 1, avgCost: 1, source: 'ib' }],
    accounts: [{ id: 'ibc', name: 'IB GBP', type: 'cash', class: '現金', currency: 'GBP', balance: -1, ibCashCur: true }] });
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.ibValue, 2 * USD, 'IB 持股市值經 computeIb 乘 USD 哨兵');
  assert.equal(lev.loan, GBP, '英鎊欠款乘 GBP 哨兵');
  assert.equal(lev.leverage, (2 * USD) / (2 * USD - GBP));
});

test(`哨兵｜${label}｜derive.buildSummary 提醒：融資利息、閒置現金、換匯區間三處都用設定裡的匯率`, () => {
  const db = any({
    settings: { ...S, ibIdleCashAlert: 1, ib: { lastEquity: { stock: 2, cash: -1 }, income: { interestPaid: 4 } } },
    accounts: [{ id: 'idle', name: 'IB GBP', type: 'cash', class: '現金', currency: 'GBP', balance: 4 * USD, ibCashCur: true }],
    holdings: [],
  });
  const by = Object.fromEntries(buildSummary(db).reminders.map(r => [r.key, r]));
  assert.ok(by['ib-leverage'], '槓桿 2x ≥ 1.1 應有提醒');
  assert.ok(by['ib-leverage'].detail.includes(`近一年融資利息 ${fmtTwd(4 * USD)}`), `利息 4 USD × 哨兵：${by['ib-leverage'].detail}`);
  assert.ok(by['ib-idle-cash'], '閒置現金超過門檻應有提醒');
  assert.equal(by['ib-idle-cash'].title, `IB 閒置現金約 ${(4 * GBP).toLocaleString('en-US')} USD`, 'GBP 餘額 4×USD × GBP 哨兵 ÷ USD 哨兵＝4×GBP USD（×與÷各吃一個哨兵）');
  // 換匯區間：高組 ≥ 預設門檻 32 走「已達」、低組 ≤ 28 走「已低於」——兩支都要吃到哨兵（來源是「抓到的」才會判）
  const fxKey = USD >= 32 ? 'fx-usd-high' : 'fx-usd-low';
  assert.ok(by[fxKey], `${fxKey} 應出現（哨兵 ${USD}）`);
  assert.equal(by[fxKey].title, USD >= 32 ? `美元/台幣 ${USD} 已達 32 以上` : `美元/台幣 ${USD} 已低於 28`);
});

test(`哨兵｜${label}｜snapshot.recordDailyValue：日線記的三個匯率與投組市值都是設定裡的值`, async () => {
  const base = store.emptyDb();
  store.save({ ...base, settings: { ...(base.settings || {}), ...S },
    accounts: [{ id: 'au', name: '美元', type: 'cash', class: '現金', currency: 'USD', balance: 4 }],
    holdings: [{ id: 'hu', symbol: 'VT', currency: 'USD', price: 1, quantity: 4, avgCost: 1 }] });   // ×4：低組 2.5 的倍數才是整數（日線會四捨五入）
  const row = await recordDailyValue();
  assert.ok(row, '時鐘沒倒退就該寫入');
  assert.equal(row.usdTwd, USD); assert.equal(row.gbpTwd, GBP); assert.equal(row.jpyTwd, JPY);
  assert.equal(row.pfValue, 4 * USD, '持股市值經 computeIb 乘 USD 哨兵');
  assert.equal(row.netWorth, 8 * USD, '帳戶＋持股');
});

test(`哨兵｜${label}｜portfolio-model：持股、現金帳戶、官方淨值、本機欠款每一處都用設定裡的匯率`, () => {
  const m = buildPortfolioModel(holdingsFx, accountsFx, any(S));
  assert.deepEqual(m.rows.map(r => r.valueTwd), [USD, GBP]);
  assert.equal(m.total, USD + GBP); assert.equal(m.totalCost, USD + GBP);
  assert.equal(m.cashV, USD + GBP + JPY, '三個現金帳戶經 accTwd 各乘自己的哨兵');
  assert.deepEqual(m.defaultFx, []);
  const official = buildPortfolioModel([], [], any({ ...S, ib: { lastEquity: { stock: 2, cash: -1 } } }));
  assert.equal(official.ibValTwd, 2 * USD); assert.equal(official.loanTwd, USD); assert.equal(official.leverage, 2);
  const local = buildPortfolioModel(
    [{ id: 'hu', symbol: 'VT', currency: 'USD', price: 2, quantity: 1, avgCost: 1, source: 'ib' }],
    [{ id: 'ibc', name: 'IB GBP', type: 'cash', class: '現金', currency: 'GBP', balance: -1, ibCashCur: true }], any(S));
  assert.equal(local.ibValTwd, 2 * USD); assert.equal(local.loanTwd, GBP, '英鎊欠款經 accTwd 乘 GBP 哨兵');
});

}   // for SETS

test('哨兵｜絆線：三個檔「用到匯率的地方」各有幾處——多一處來補斷言、少一處拿掉斷言', () => {
  const root = new URL('../', import.meta.url);
  const count = (/** @type {string} */ f, /** @type {RegExp} */ re) => (readFileSync(new URL(f, root), 'utf8').match(re) || []).length;
  const msg = '換算點數目變了：去本檔頭的清單對一下，新增的那一處要有哨兵斷言（並逐點突變證明它會紅）';
  assert.equal(count('lib/derive.js', /\bf\.rate\b|rates\.USD\b/g), 10, msg);
  assert.equal(count('lib/services/snapshot.js', /fxTable\.rates\./g), 3, msg);
  assert.equal(count('public/modules/portfolio-model.js', /\bf\.rate\b|\bfx\.USD\b/g), 4, msg);
});
