// 「錢的大腦」的自動考試：淨資產、訂閱計算、槓桿，以及修過的兩個 bug（回歸保護）。
// 跑法：npm test（Node 內建測試工具，零相依）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthKey, computeAssets, computeCashflowHistory, computeIb, computeLeverage, buildSummary } from '../lib/derive.js';

test('monthKey：日期字串取到正確月份（不受時區影響）', () => {
  assert.equal(monthKey('2026-07-15'), '2026-07');
  assert.equal(monthKey('2026-12-31'), '2026-12');
  assert.equal(monthKey('2026-01-01'), '2026-01');   // 修過的時區 bug：不會變成前一個月
});

test('computeAssets：淨資產＝資產−負債', () => {
  const db = {
    settings: { usdTwd: 32 },
    accounts: [
      { id: 'a', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 },
      { id: 'b', type: 'loan', currency: 'TWD', balance: -300 },
    ],
    holdings: [],
  };
  const r = computeAssets(db);
  assert.equal(r.assets, 1000);
  assert.equal(r.liabilities, 300);
  assert.equal(r.netWorth, 700);
});

test('總覽 12 月現金流：沿用現金流帳本口徑，記帳前不補零、開始後的空月保留', () => {
  const db = /** @type {any} */ ({ transactions: [
    { date: '2025-06-01', type: 'income', amount: 999 },
    { date: '2026-03-01', type: 'income', amount: 100 },
    { date: '2026-03-02', type: 'expense', amount: 40 },
    { date: '2026-04-01', type: 'expense', amount: 999, ledger: 'card' },
    { date: '2026-05-01', type: 'transfer', amount: 500 },
    { date: '2026-06-01', type: 'expense', amount: 30 },
    { date: '2026-13-01', type: 'income', amount: 999 },
  ] });
  assert.deepEqual(computeCashflowHistory(db, '2026-06', 6), [
    { month: '2026-03', income: 100, expense: 40, net: 60 },
    { month: '2026-04', income: 0, expense: 0, net: 0 },
    { month: '2026-05', income: 0, expense: 0, net: 0 },
    { month: '2026-06', income: 0, expense: 30, net: -30 },
  ]);
});

test('總覽 12 月現金流：視窗內沒有有效銀行收支時回空序列', () => {
  const db = /** @type {any} */ ({ transactions: [
    { date: '2026-06-01', type: 'expense', amount: 200, ledger: 'card' },
    { date: '2026-06-02', type: 'transfer', amount: 300 },
  ] });
  assert.deepEqual(computeCashflowHistory(db, '2026-06'), []);
});

test('總覽 12 月現金流：最後一筆記帳後維持無資料，不用 0 冒充確定零收支', () => {
  const db = /** @type {any} */ ({ transactions: [
    { date: '2026-03-01', type: 'income', amount: 100 },
    { date: '2026-04-01', type: 'expense', amount: 40 },
  ] });
  assert.deepEqual(computeCashflowHistory(db, '2026-06', 6), [
    { month: '2026-03', income: 100, expense: 0, net: 100 },
    { month: '2026-04', income: 0, expense: 40, net: -40 },
  ]);
});

test('訂閱項數：已停用的不算（總覽與訂閱頁同口徑）', () => {
  const db = {
    settings: { usdTwd: 32 },
    accounts: [], holdings: [], transactions: [],
    subscriptions: [
      { id: 's1', name: '使用中', amount: 100, cycle: 'monthly' },                                  // 無停用日→算
      { id: 's2', name: '已停用', amount: 200, cycle: 'monthly', status: 'ending', active: true, endsOn: '2020-01-01' }, // 停用日已過→不算
    ],
  };
  assert.equal(buildSummary(db).subscriptions.count, 1);
});

test('緊急預備金：已停用訂閱不該灌進去（Codex #39 修正）', () => {
  const db = {
    settings: { usdTwd: 32, emergencyFundMonths: 6 },
    accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 3000 }],
    holdings: [], transactions: [],
    subscriptions: [
      { id: 's', name: '已停用月繳', amount: 1000, cycle: 'monthly', status: 'ending', active: true, endsOn: '2020-01-01' },
    ],
  };
  const reminders = buildSummary(db).reminders;
  // 修前：已停用訂閱被當成每月 1000 → 3000/1000=3 個月<6 → 誤報「緊急預備金不足」
  assert.ok(!reminders.some(r => /緊急預備金/.test(r.title)), '不應誤報緊急預備金不足');
});

test('訂閱提醒：status ended（旗標未寫回）不該再跳續費提醒（Codex 第三輪 #4）', () => {
  const d = new Date(); d.setDate(d.getDate() + 3);   // 三天後（在 7 天提醒窗內）
  const soon = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const db = {
    settings: { usdTwd: 32 },
    accounts: [], holdings: [], transactions: [],
    subscriptions: [{ id: 's', name: '已停用但旗標未寫回', amount: 100, cycle: 'monthly', status: 'ended', active: true, nextCharge: soon }],
  };
  const reminders = buildSummary(db).reminders;
  assert.ok(!reminders.some(r => /續費/.test(r.title)), '已停用訂閱不應出現續費提醒');
});

test('computeLeverage：用 IB 官方淨值算融資槓桿', () => {
  const db = { settings: { usdTwd: 32, ib: { lastEquity: { stock: 100, cash: -50 } } }, holdings: [], accounts: [] };
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.leverage, 2);       // 持倉 100 ÷ 淨值(100−50)=50 → 2 倍
  assert.equal(lev.loan, 1600);        // 借款 50 × 匯率 32
  assert.equal(lev.hasLoan, true);
});

test('buildSummary：用 seed 範例資料能正常算出總覽（結構檢查）', () => {
  const db = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
  const s = buildSummary(db);
  assert.equal(typeof s.netWorth, 'number');
  assert.ok(s.netWorth > 0);
  assert.equal(typeof s.subscriptions.count, 'number');
  assert.ok(Array.isArray(s.reminders));
  assert.ok(Array.isArray(s.snapshots));
  assert.ok(Array.isArray(s.cashflowHistory));
});

test('自主體檢｜淨值歸零：summary 不輸出 Infinity（equityWiped 旗標）、提醒不印 Infinityx', async () => {
  const { buildSummary } = await import('../lib/derive.js');
  const db = /** @type {any} */ ({ settings: { usdTwd: 32, ib: { lastEquity: { stock: 100000, cash: -150000 } } },
    holdings: [{ id: 'h1', symbol: 'CSPX', currency: 'USD', quantity: 1, price: 100, source: 'ib' }] });
  const s = buildSummary(db);
  assert.equal(s.ib.leverage, null, 'Infinity 不可流進 JSON（會變 null 被前端當 0.00x）');
  assert.equal(s.ib.equityWiped, true, '要給前端明確訊號');
  const t = s.reminders.find(r => r.title.includes('淨值已為負'));
  assert.ok(t, '要有危險級提醒');
  assert.equal(t.level, 'danger');
  assert.ok(!s.reminders.some(r => r.title.includes('Infinity')), '不可出現 Infinityx 字樣');
});

// ============================================================================
// 「乙」（William 2026-09-03 裁）：GBP／JPY 沒設匯率＝缺匯率，不計入並標註；前後端同口徑。
// 每題各釘一個消費端；突變＝把 fxRates 的 GBP 改回 `|| 40.8`、拿掉任一個 `continue`／fxMissing、拿掉提醒——各自有題會紅。
// ============================================================================

test('乙｜computeAssets：GBP 帳戶沒設匯率 → 不計入淨資產、missingFx 列出 GBP；設了匯率 → 照算、missingFx 空', () => {
  const base = { accounts: [
    { id: 't', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 },
    { id: 'g', type: 'cash', class: '現金', currency: 'GBP', balance: 100 },
  ] };
  const without = computeAssets(/** @type {any} */ ({ ...base, settings: { usdTwd: 32 } }));
  assert.equal(without.netWorth, 1000, '沒匯率的 GBP 不可用猜的數算進去（以前會加 100×40.8）');
  assert.deepEqual(without.missingFx, [{ currency: 'GBP', count: 1, liabilities: 0 }], '要標註少算了哪個幣別、幾筆（資產、不是負債）');
  const withRate = computeAssets(/** @type {any} */ ({ ...base, settings: { usdTwd: 32, fxTwd: { GBP: 40 } } }));
  assert.equal(withRate.netWorth, 1000 + 100 * 40, '對照：設了匯率就照算');
  assert.deepEqual(withRate.missingFx, [], '對照：沒有缺匯率就不標註');
});

test('乙｜computeAssets：表上沒有的幣別（EUR）也算缺匯率——不再 `|| 1` 當台幣；缺 currency 仍預設台幣（既有判準）', () => {
  const r = computeAssets(/** @type {any} */ ({ settings: { usdTwd: 32 }, accounts: [
    { id: 'e', type: 'cash', class: '現金', currency: 'EUR', balance: 500 },
    { id: 'n', type: 'cash', class: '現金', balance: 7 },
  ] }));
  assert.equal(r.netWorth, 7, 'EUR 不可被當成台幣 500；缺 currency 的 7 元照舊當台幣');
  assert.deepEqual(r.missingFx, [{ currency: 'EUR', count: 1, liabilities: 0 }]);
});

test('乙｜computeIb：JPY 持股沒設匯率 → 市值／成本記 0、帶 fxMissing、不進 totalValue；missingFx 列出 JPY', () => {
  const db = /** @type {any} */ ({ settings: { usdTwd: 32 }, holdings: [
    { id: 'u', symbol: 'VT', currency: 'USD', quantity: 10, price: 100, avgCost: 90, source: 'ib' },
    { id: 'j', symbol: '7203', currency: 'JPY', quantity: 100, price: 3000, avgCost: 2500, source: 'manual' },
  ] });
  const ib = computeIb(db);
  const jp = ib.positions.find(p => p.id === 'j');
  assert.ok(jp && jp.fxMissing === true && jp.marketValue === 0 && jp.costBasis === 0, '缺匯率的持股要標 fxMissing、金額 0');
  assert.equal(ib.totalValue, 10 * 100 * 32, 'totalValue 只含有匯率的持股');
  assert.deepEqual(ib.missingFx, [{ currency: 'JPY', count: 1, liabilities: 0 }]);
  const withRate = computeIb({ ...db, settings: { usdTwd: 32, fxTwd: { JPY: 0.2 } } });
  assert.equal(withRate.totalValue, 10 * 100 * 32 + 100 * 3000 * 0.2, '對照：設了匯率就照算');
  assert.equal(withRate.positions.find(p => p.id === 'j')?.fxMissing, false);
});

test('乙｜computeLeverage：ibCashCur 的 GBP 負現金沒匯率 → 不計入融資（不是當台幣、也不是猜匯率）', () => {
  const holdings = [{ id: 'u', symbol: 'VT', currency: 'USD', quantity: 10, price: 100, avgCost: 90, source: 'ib' }];
  const accounts = [
    { id: 'usd', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: -200 },
    { id: 'gbp', type: 'cash', class: '現金', currency: 'GBP', ibCashCur: 'GBP', balance: -50 },
  ];
  const without = /** @type {any} */ ({ settings: { usdTwd: 32 }, holdings, accounts });
  const lev = computeLeverage(without, computeIb(without));
  assert.equal(lev.loan, 200 * 32, 'GBP 那筆沒匯率就不計入融資（以前會用猜的 40.8 加進來）');
  const withRate = /** @type {any} */ ({ ...without, settings: { usdTwd: 32, fxTwd: { GBP: 40 } } });
  assert.equal(computeLeverage(withRate, computeIb(withRate)).loan, 200 * 32 + 50 * 40, '對照：設了匯率就照算');
});

test('乙｜buildSummary 帶 missingFx；提醒 fx-missing 在缺匯率時出現（warn、講怎麼補）、有匯率時不出現', () => {
  const base = { accounts: [{ id: 'g', type: 'cash', class: '現金', currency: 'GBP', balance: 100 }] };
  const s = buildSummary(/** @type {any} */ ({ ...base, settings: { usdTwd: 32 } }));
  assert.deepEqual(s.missingFx, [{ currency: 'GBP', count: 1, liabilities: 0 }], '總覽要拿得到缺匯率的清單才能就地標註');
  const r = s.reminders.find(x => x.key === 'fx-missing');
  assert.ok(r && r.level === 'warn' && /GBP/.test(r.title) && /低估/.test(r.title) && /更新報價/.test(r.detail), `只有資產缺匯率＝warn、要講「淨值被低估」並告訴人怎麼補（實際 ${JSON.stringify(r)}）`);
  const ok = buildSummary(/** @type {any} */ ({ ...base, settings: { usdTwd: 32, fxTwd: { GBP: 40 } } }));
  assert.deepEqual(ok.missingFx, []);
  assert.equal(ok.reminders.find(x => x.key === 'fx-missing'), undefined, '對照：有匯率就不該有這則提醒');
});

test('乙｜前後端同口徑（持股側）：同一份持股，後端 computeIb 與前端 buildPortfolioModel 對缺匯率的 GBP 都不計入、missingFx 相同；設了匯率兩邊總市值相同', async () => {
  const { buildPortfolioModel } = await import('../public/modules/portfolio-model.js');
  const holdings = [
    { id: 'u', symbol: 'VT', currency: 'USD', quantity: 10, price: 100, avgCost: 90, source: 'ib' },
    { id: 'g', symbol: 'ISF', currency: 'GBP', quantity: 5, price: 8, avgCost: 7, source: 'manual' },
  ];
  for (const settings of [{ usdTwd: 32 }, { usdTwd: 32, fxTwd: { GBP: 40 } }]) {
    const be = computeIb(/** @type {any} */ ({ settings, holdings }));
    const fe = buildPortfolioModel(/** @type {any} */ (holdings), [], /** @type {any} */ (settings));
    assert.equal(fe.total, be.totalValue, `設定 ${JSON.stringify(settings)}：前後端持股總市值要相同`);
    assert.deepEqual(fe.missingFx, be.missingFx, `設定 ${JSON.stringify(settings)}：前後端 missingFx 要相同`);
  }
});

test('乙｜缺匯率的負債（GBP 負現金／負債型帳戶）：不計入、missingFx 標 liabilities，提醒升 danger 並講明負債被低估、淨值可能被高估（槓桿只用條件句講）', () => {
  const db = /** @type {any} */ ({ settings: { usdTwd: 32 }, holdings: [{ id: 'u', symbol: 'VT', currency: 'USD', quantity: 10, price: 100, avgCost: 90, source: 'ib' }], accounts: [
    { id: 'gbpCash', type: 'cash', class: '現金', currency: 'GBP', ibCashCur: 'GBP', balance: -50 },
    { id: 'gbpLoan', type: 'loan', currency: 'GBP', balance: 1000 },
    { id: 'gbpAsset', type: 'cash', class: '現金', currency: 'GBP', balance: 20 },
  ] });
  const a = computeAssets(db);
  assert.equal(a.liabilities, 0, '缺匯率的負債不計入（乙口徑允許的退化——所以下面要用 danger 講出來）');
  assert.deepEqual(a.missingFx, [{ currency: 'GBP', count: 3, liabilities: 2 }], '負現金與負債型帳戶都算負債，資產那筆不算');
  const r = buildSummary(db).reminders.find(x => x.key === 'fx-missing');
  assert.ok(r && r.level === 'danger', `有負債缺匯率＝danger（實際 ${JSON.stringify(r)}）`);
  assert.match(String(r?.title), /2 筆是負債/, '要講出幾筆負債');
  assert.match(String(r?.title), /負債被低估/, '要講方向：負債被低估');
  assert.match(String(r?.title), /淨值可能被高估/, '要講方向：淨值可能被高估（不可寫死「被高估」——資產也缺時推不出方向）');
  assert.match(String(r?.detail), /槓桿也會被低估/, '槓桿那半句只能用條件句講（IB 有官方淨值時不成立）');
});

test('乙｜零餘額帳戶／零股數持股缺匯率不算「有曝險」：missingFx 空、不提醒（前後端同口徑）', async () => {
  const db = /** @type {any} */ ({ settings: { usdTwd: 32 },
    accounts: [{ id: 'g0', type: 'cash', class: '現金', currency: 'GBP', balance: 0 }],
    holdings: [{ id: 'j0', symbol: '7203', currency: 'JPY', quantity: 0, price: 3000, avgCost: 2500, source: 'manual' }] });
  assert.deepEqual(computeAssets(db).missingFx, [], '沒有曝險就不該報缺匯率');
  assert.deepEqual(computeIb(db).missingFx, []);
  assert.equal(buildSummary(db).reminders.find(x => x.key === 'fx-missing'), undefined, '不該提醒');
  const { buildPortfolioModel } = await import('../public/modules/portfolio-model.js');
  assert.deepEqual(buildPortfolioModel(db.holdings, db.accounts, db.settings).missingFx, [], '前端同口徑');
});

test('乙｜前後端同口徑（帳戶側）：同一份持股＋帳戶（負餘額現金＋正餘額負債型＋資產），後端 computeAssets 與前端 buildPortfolioModel 的 missingFx 逐欄相同（含 liabilities）', async () => {
  const { buildPortfolioModel } = await import('../public/modules/portfolio-model.js');
  const holdings = /** @type {any} */ ([
    { id: 'u', symbol: 'VT', currency: 'USD', quantity: 10, price: 100, avgCost: 90, source: 'ib' },
    { id: 'g', symbol: 'ISF', currency: 'GBP', quantity: 5, price: 8, avgCost: 7, source: 'manual' },
  ]);
  const accounts = /** @type {any} */ ([
    { id: 'gbpCash', type: 'cash', class: '現金', currency: 'GBP', ibCashCur: 'GBP', balance: -50 },
    { id: 'gbpLoan', type: 'loan', currency: 'GBP', balance: 1000 },
    { id: 'gbpAsset', type: 'cash', class: '現金', currency: 'GBP', balance: 20 },
    { id: 'gbpZero', type: 'cash', class: '現金', currency: 'GBP', balance: 0 },
  ]);
  const settings = { usdTwd: 32 };
  const be = computeAssets(/** @type {any} */ ({ settings, holdings, accounts })).missingFx;
  const fe = buildPortfolioModel(holdings, accounts, /** @type {any} */ (settings)).missingFx;
  assert.deepEqual(be, [{ currency: 'GBP', count: 4, liabilities: 2 }], '後端：持股 1＋帳戶 3（零餘額不算），其中負餘額現金與正餘額 loan 是負債');
  assert.deepEqual(fe, be, '前端要與後端逐欄相同（count 與 liabilities）——前端把 liabilities 記成 0 這裡會紅');
  const okBe = computeAssets(/** @type {any} */ ({ settings: { usdTwd: 32, fxTwd: { GBP: 40 } }, holdings, accounts })).missingFx;
  const okFe = buildPortfolioModel(holdings, accounts, /** @type {any} */ ({ usdTwd: 32, fxTwd: { GBP: 40 } })).missingFx;
  assert.deepEqual(okBe, []); assert.deepEqual(okFe, []);
});
