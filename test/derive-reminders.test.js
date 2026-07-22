// 「錢的大腦」深度考題：每一條總覽提醒規則、槓桿/斷頭距離邊角、多幣別資產、投組權重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, computeAssets, computeIb, computeLeverage } from '../lib/derive.js';

const base = { settings: { usdTwd: 32, emergencyFundMonths: 6, allocationDriftPct: 5 }, accounts: [], holdings: [], transactions: [], subscriptions: [] };
const remind = (over) => buildSummary({ ...base, ...over, settings: { ...base.settings, ...(over.settings || {}) } }).reminders;
const hasTitle = (over, re) => remind(over).some(r => re.test(r.title));

test('提醒｜本月現金流為負', () => {
  assert.ok(hasTitle({ transactions: [{ date: '2026-07-05', type: 'expense', amount: 1000 }, { date: '2026-07-06', type: 'income', amount: 100 }] }, /現金流為負/));
});

test('提醒｜緊急預備金不足（現金撐不到目標月數）', () => {
  assert.ok(hasTitle({
    accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 }],
    transactions: [{ date: '2026-06-05', type: 'expense', amount: 2000 }],
  }, /緊急預備金不足/));
});

test('提醒｜單一個股超過上限（凍結加碼）', () => {
  const db = { settings: { usdTwd: 1, ibConcentrationPct: 5 }, accounts: [], holdings: [{ id: 'h', symbol: 'TSLA', layer: 'stock', currency: 'TWD', quantity: 1, price: 100, source: 'ib' }], transactions: [], subscriptions: [] };
  assert.ok(buildSummary(db).reminders.some(r => /TSLA.*個股上限/.test(r.title)));
});

test('提醒｜IB 融資槓桿超上限', () => {
  const db = { settings: { usdTwd: 1, ib: { lastEquity: { stock: 100, cash: -60 } }, levCapPct: 1.3, ibMaintenancePct: 25 }, accounts: [], holdings: [], transactions: [], subscriptions: [] };
  assert.ok(buildSummary(db).reminders.some(r => /融資槓桿.*超過上限/.test(r.title)));
});

test('提醒｜匯率進入分批區（高/低各一）', () => {
  assert.ok(hasTitle({ settings: { usdTwd: 33, fxHigh: 32, fxLow: 28 } }, /美元\/台幣.*已達/));
  assert.ok(hasTitle({ settings: { usdTwd: 27, fxHigh: 32, fxLow: 28 } }, /美元\/台幣.*已低於/));
});

test('提醒｜正常狀態（現金充足、無投資、平衡）→ 不亂報', () => {
  const rs = remind({ accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 5_000_000 }] });
  assert.ok(!rs.some(r => /緊急預備金|現金流為負|槓桿/.test(r.title)), '不該有緊急/現金流/槓桿提醒');
});

test('computeLeverage｜斷頭距離：借款越多、距離越近', () => {
  const mk = (cash) => computeLeverage({ settings: { usdTwd: 1, ib: { lastEquity: { stock: 100, cash } }, ibMaintenancePct: 25 }, holdings: [], accounts: [] }, { positions: [] });
  const light = mk(-30), heavy = mk(-60);
  assert.ok(heavy.mcDist < light.mcDist, '借更多→斷頭距離更近');
  assert.ok(light.mcDist > 0 && light.mcDist <= 100);
});

test('computeLeverage｜淨值≤0（跌破本金）→ leverage=Infinity、mcDist=0（前端須同步顯示危險）', () => {
  const db = { settings: { usdTwd: 1, ib: { lastEquity: { stock: 100, cash: -150 } }, ibMaintenancePct: 25 }, holdings: [], accounts: [] };
  const lev = computeLeverage(db, { positions: [] });
  assert.equal(lev.leverage, Infinity, '有借款且淨值≤0 不可算成有限值（更不可是 1）');
  assert.equal(lev.hasLoan, true);
  assert.equal(lev.mcDist, 0, '已在強平線上');
});

test('computeLeverage｜無融資時 leverage=1、hasLoan=false', () => {
  const lev = computeLeverage({ settings: { usdTwd: 1, ib: { lastEquity: { stock: 100, cash: 50 } } }, holdings: [], accounts: [] }, { positions: [] });
  assert.equal(lev.leverage, 1);
  assert.equal(lev.hasLoan, false);
  assert.ok(!(lev.loan > 0), '無融資時借款不為正');
});

test('computeLeverage｜無 lastEquity 時自算（source:ib 持倉 ÷ 淨值）', () => {
  const db = {
    settings: { usdTwd: 1, ibMaintenancePct: 25 },
    holdings: [{ symbol: 'CSPX', currency: 'TWD', quantity: 1, price: 100, source: 'ib' }],
    accounts: [{ id: 'x', ibCashCur: 'TWD', currency: 'TWD', balance: -50 }],
  };
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.hasLoan, true);
  assert.equal(lev.loan, 50);
  assert.ok(Math.abs(lev.leverage - 2) < 1e-9, '100 ÷ (100−50) = 2');
});

test('computeIb｜權重加總 100%、依市值排序', () => {
  const ib = computeIb({ settings: { usdTwd: 1 }, holdings: [{ symbol: 'A', currency: 'TWD', quantity: 1, price: 40 }, { symbol: 'B', currency: 'TWD', quantity: 1, price: 60 }] });
  assert.equal(ib.positions[0].symbol, 'B');   // 市值大的在前
  assert.equal(Math.round(ib.positions.reduce((s, p) => s + p.weight, 0)), 100);
});

test('computeAssets｜多幣別換算台幣（USD/GBP）', () => {
  const r = computeAssets({
    settings: { usdTwd: 30, fxTwd: { GBP: 40 } },
    accounts: [
      { id: 'a', type: 'cash', class: '現金', currency: 'USD', balance: 10 },
      { id: 'b', type: 'cash', class: '現金', currency: 'GBP', balance: 10 },
    ],
    holdings: [],
  });
  assert.equal(r.assets, 700);   // 10×30 + 10×40
  assert.equal(r.netWorth, 700);
});

test('computeAssets｜負餘額帳戶算負債', () => {
  const r = computeAssets({ settings: { usdTwd: 32 }, accounts: [{ id: 'a', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 }, { id: 'b', currency: 'TWD', balance: -400 }], holdings: [] });
  assert.equal(r.liabilities, 400);
  assert.equal(r.netWorth, 600);
});

test('自審｜持股缺 currency 預設台幣、不被當美元灌 32 倍', () => {
  const usd = computeAssets({ settings: { usdTwd: 32 }, accounts: [], holdings: [{ symbol: 'CSPX', currency: 'USD', quantity: 1, price: 500 }] });
  assert.equal(usd.assets, 16000, '有標 USD → ×32');
  const noCur = computeAssets({ settings: { usdTwd: 32 }, accounts: [], holdings: [{ symbol: '0050', quantity: 1000, price: 180 }] });
  assert.equal(noCur.assets, 180000, '缺 currency → 台幣（非 5,760,000）');
});

test('自審｜緊急預備金：現金分散在「現金」與「cash」兩種 class 都要算', () => {
  const db = {
    settings: { usdTwd: 32 },
    accounts: [{ type: 'cash', class: '現金', currency: 'TWD', balance: 120000 }, { type: 'cash', currency: 'TWD', balance: 900000 }],
    holdings: [], subscriptions: [], transactions: [{ date: '2026-06-05', type: 'expense', amount: 30000 }],
  };
  assert.ok(!buildSummary(db).reminders.some((x) => /緊急預備金/.test(x.title)), '總現金 102 萬≈34 個月，不該誤報不足');
});

test('自審｜沒有日期的交易不算進當月現金流', () => {
  const db = { settings: { usdTwd: 32 }, accounts: [], holdings: [], subscriptions: [], transactions: [{ type: 'expense', amount: 9999 }] };
  assert.equal(buildSummary(db).cashflow.expense, 0, '缺日期的支出不歸入當月');
});

test('自主體檢 Q2｜保險/訂閱繳費日已過未更新 → 出「已過期」提醒（不再無聲消失）', async () => {
  const { buildSummary } = await import('../lib/derive.js');
  const iso = (delta) => { const d = new Date(); d.setDate(d.getDate() + delta); return d.toISOString().slice(0, 10); };
  const db = /** @type {any} */ ({ settings: {},
    insurance: [{ id: 'p1', policyName: '壽險A', nextPayment: iso(-3), premium: 1000, premiumCycle: 'yearly' }],
    subscriptions: [{ id: 's1', name: 'Netflix', cycle: 'monthly', amount: 390, nextCharge: iso(-2), status: 'active' }] });
  const r = buildSummary(db).reminders;
  const ins = r.find(x => x.title.includes('壽險A') && x.title.includes('已過'));
  assert.ok(ins, '保險過期要出提醒');
  assert.equal(ins.level, 'danger');
  const sub = r.find(x => x.title.includes('Netflix') && x.title.includes('已過'));
  assert.ok(sub, '訂閱過期要出提醒');
  assert.equal(sub.level, 'warn');
  // 逾越視窗（保險 60 天、訂閱 30 天）不再洗
  const old = /** @type {any} */ ({ settings: {},
    insurance: [{ id: 'p2', policyName: '壽險B', nextPayment: iso(-100), premium: 1, premiumCycle: 'yearly' }], subscriptions: [] });
  assert.ok(!buildSummary(old).reminders.some(x => x.title.includes('壽險B')), '過期太久（舊資料）不再狂洗');
});

test('自主體檢 Q4｜停用當月攤提用該月實際天數：2/28 滿月停用＝算滿月（不再打 93 折）', async () => {
  const { subCostForMonth } = await import('../lib/derive.js');
  const sub = { cycle: 'yearly', amount: 1200, since: '2020-01', status: 'active' };   // 年繳 1200 → 月攤 100
  // 2/28（二月最後一天）停用 → 滿月 100（舊寫死 30 天會算成 28/30≈93.3）
  assert.equal(subCostForMonth({ ...sub, endsOn: '2027-02-28' }, '2027-02'), 100, '滿月停用＝算滿額');
  assert.equal(subCostForMonth({ ...sub, endsOn: '2028-02-29' }, '2028-02'), 100, '閏年 2/29 滿月也算滿額');
  // 1/30（31 天的一月，少用最後一天）→ 30/31，略少於滿月（舊寫死 30 會誤算成滿月 100）
  const jan = subCostForMonth({ ...sub, endsOn: '2027-01-30' }, '2027-01');
  assert.ok(jan > 96 && jan < 100, `1/30 應為 30/31≈96.8，實得 ${jan}`);
  // 月中停用照常按比例
  assert.equal(subCostForMonth({ ...sub, endsOn: '2027-04-15' }, '2027-04'), 50, '4/15＝15/30 滿月半額');
});

// ---------- D2：提醒穩定鑰匙（每日洞察引擎差異引擎的地基）----------
// 一組會觸發多條「日期無關」提醒的狀態（免受測試當天日期影響）：股票超上限＋股票總曝險超上限＋
// 融資槓桿＋匯率高。key 必須穩定、含實體識別、同次互異，且**不隨標題金額變動**。
const keyDb = (over = {}) => ({
  settings: { usdTwd: 33, fxHigh: 32, fxLow: 28, ibConcentrationPct: 5, equityCapPct: 90, ibMaintenancePct: 25, ib: { lastEquity: { stock: 100, cash: -60 } }, ...over },
  accounts: [], transactions: [], subscriptions: [],
  holdings: [{ id: 'h', symbol: 'TSLA', layer: 'stock', currency: 'TWD', quantity: 1, price: over.price || 100, source: 'ib' }],
});

test('D2 提醒 key｜每條都有非空字串 key，同一次計算內互異', () => {
  const rs = buildSummary(keyDb()).reminders;
  assert.ok(rs.length >= 3, '這組狀態要觸發多條提醒');
  for (const r of rs) assert.ok(typeof r.key === 'string' && r.key.length > 0, `每條提醒要有 key（${r.title}）`);
  const keys = rs.map(r => r.key);
  assert.equal(new Set(keys).size, keys.length, '同一次計算內 key 不可重複');
});

test('D2 提醒 key｜同狀態兩次計算 → key 集合完全相同（穩定、不漂移）', () => {
  const a = buildSummary(keyDb()).reminders.map(r => r.key).sort();
  const b = buildSummary(keyDb()).reminders.map(r => r.key).sort();
  assert.deepEqual(a, b, '同一份資料算兩次，key 必須一致');
  assert.ok(a.includes('conc-stock-TSLA'), 'key 含實體識別（個股用 symbol）');
  assert.ok(a.includes('fx-usd-high') && a.includes('ib-leverage'), '規則代號 key 就位');
});

test('D2 提醒 key｜不隨標題數字變動：同一底層狀況（匯率不同但都達區間）key 相同', () => {
  const k1 = buildSummary(keyDb({ usdTwd: 33 })).reminders.find(r => r.key === 'fx-usd-high');
  const k2 = buildSummary(keyDb({ usdTwd: 40 })).reminders.find(r => r.key === 'fx-usd-high');
  assert.ok(k1 && k2, '兩種匯率（都 ≥ fxHigh）都應觸發分批換匯提醒');
  assert.notEqual(k1.title, k2.title, '標題含匯率數字，確實不同（33 vs 40）');
  assert.equal(k1.key, k2.key, '但 key 不含數字 → 相同（差異引擎才能判「持續中」而非「新出現」）');
});

test('D2 提醒 key｜per-entity 用穩定 id：兩張卡的繳款提醒 key 各含卡 id', () => {
  // 用「今天」當繳款日 → daysUntilDayOfMonth=0，穩定觸發（不論測試當天幾號）
  const today = new Date();
  const dueDay = today.getDate();
  const db = { settings: {}, accounts: [], holdings: [], transactions: [], subscriptions: [],
    cards: [{ id: 'cardA', type: 'credit', name: '卡A', dueDay }, { id: 'cardB', type: 'credit', name: '卡B', dueDay }] };
  const keys = buildSummary(db).reminders.filter(r => r.module === '卡片').map(r => r.key);
  assert.ok(keys.includes('card-due-cardA') && keys.includes('card-due-cardB'), '每張卡的提醒 key 各含自己的 id');
});

// D2 自審修正：個股集中度按 symbol 彙總（同一檔多筆手動持股）
test('D2 提醒 key｜個股集中度按 symbol 彙總：同一檔多筆手動持股→單一提醒（key 唯一）＋彙總%', () => {
  const db = { settings: { usdTwd: 1, ibConcentrationPct: 5 }, accounts: [], transactions: [], subscriptions: [],
    holdings: [
      { id: 'h1', symbol: 'TSLA', layer: 'stock', currency: 'TWD', quantity: 1, price: 8, source: 'manual' },
      { id: 'h2', symbol: 'TSLA', layer: 'stock', currency: 'TWD', quantity: 1, price: 8, source: 'manual' },
    ] };
  const hits = buildSummary(db).reminders.filter(r => r.key === 'conc-stock-TSLA');
  assert.equal(hits.length, 1, '同 symbol 兩筆只出一則提醒（key 唯一、不撞）');
  assert.match(hits[0].title, /100\.0%/, '兩筆彙總＝100%（非各 50%）');
});

test('守門補洞｜拆單逃避個股上限：TSLA 3%+3%=6%>5% 現在會被抓（per-position 曾各 3% 漏掉）', () => {
  const db = { settings: { usdTwd: 1, ibConcentrationPct: 5 }, transactions: [], subscriptions: [],
    accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 94 }],
    holdings: [
      { id: 'h1', symbol: 'TSLA', layer: 'stock', currency: 'TWD', quantity: 1, price: 3, source: 'manual' },
      { id: 'h2', symbol: 'TSLA', layer: 'stock', currency: 'TWD', quantity: 1, price: 3, source: 'manual' },
    ] };
  // netWorth = 94(現金) + 6(2×TSLA3) = 100；TSLA 合計 6% > 5% → 該抓（生存級守門，拆單不可逃）
  assert.ok(buildSummary(db).reminders.some(r => r.key === 'conc-stock-TSLA' && /6\.0%/.test(r.title)), '拆單合計超標要抓到');
});

test('投資原則同步｜同代號大小寫不同仍合併成一則個股提醒', () => {
  const db = { settings: { usdTwd: 1, ibConcentrationPct: 5 }, transactions: [], subscriptions: [],
    accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 94 }],
    holdings: [
      { id: 'h1', symbol: 'TSLA', layer: 'stock', currency: 'TWD', quantity: 1, price: 3 },
      { id: 'h2', symbol: ' tsla ', layer: 'stock', currency: 'TWD', quantity: 1, price: 3 },
    ] };
  const hits = buildSummary(db).reminders.filter(r => r.key === 'conc-stock-TSLA');
  assert.equal(hits.length, 1);
  assert.match(hits[0].title, /6\.0%/);
});

test('投資原則同步｜上限設為 0 就是零容忍，不被後端改回預設值', () => {
  const baseDb = { settings: { usdTwd: 1, ibConcentrationPct: 0, equityCapPct: 0, countryCapPct: 0 }, transactions: [], subscriptions: [],
    accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 99 }],
    holdings: [{ id: 'h', symbol: '0050', layer: 'stock', currency: 'TWD', quantity: 1, price: 1 }] };
  const keys = buildSummary(baseDb).reminders.map(r => r.key);
  assert.ok(keys.includes('conc-stock-0050'), '單一個股 0% 上限要生效');
  assert.ok(keys.includes('conc-equity-total'), '股票總曝險 0% 上限要生效');
  assert.ok(keys.includes('conc-country-台灣'), '國家 0% 上限要生效');

  const lev = buildSummary({ ...baseDb, settings: { usdTwd: 1, levCapPct: 0, ib: { lastEquity: { stock: 100, cash: -10 } } }, holdings: [] })
    .reminders.find(r => r.key === 'ib-leverage');
  assert.match(lev?.title || '', /超過上限 0x/, '槓桿 0x 上限要生效');
});

// D3 自審#1：升級提醒（將至→已過）共用穩定 key（差異引擎才判「持續中」而非「已解除＋新出現」）
test('D3 自審#1｜訂閱/保險「已過」與「將至」共用 <base>-<id>，不用 -overdue- 另一把 key', () => {
  const iso = (delta) => { const d = new Date(); d.setDate(d.getDate() + delta); return d.toISOString().slice(0, 10); };
  const rs = buildSummary({ settings: {}, accounts: [], holdings: [], transactions: [],
    subscriptions: [{ id: 's9', name: 'X', cycle: 'monthly', amount: 100, nextCharge: iso(-2), status: 'active' }],
    insurance: [{ id: 'p9', policyName: 'Y', nextPayment: iso(-2), premium: 100, premiumCycle: 'yearly' }] }).reminders;
  assert.ok(rs.some(r => r.key === 'sub-charge-s9'), '訂閱已過用 sub-charge-<id>');
  assert.ok(rs.some(r => r.key === 'ins-pay-p9'), '保險已過用 ins-pay-<id>');
  assert.ok(!rs.some(r => /-overdue-/.test(r.key)), '不再有 -overdue- 分裂 key');
});
