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
// 「丙」（William 2026-09-04 裁，取代 09-03 的「乙」）：不管哪種外幣，缺匯率都同一條規則——上次抓到的 → 預設值（照常計入、標註）；
// 只有不支援的幣別才無法換算（不計入、標註）。匯率表唯一實作＝public/modules/fx-rates.js（前後端共用）。
// 突變逐點：預設值改掉／不登記 defaultFx／不支援幣別當台幣／提醒拿掉／日線記 0——各有題會紅。
// ============================================================================
import { FX_DEFAULT_TWD } from '../public/modules/fx-rates.js';
import { readFileSync as readSrc } from 'node:fs';
import { findFxLiteralFallbacks } from './helpers/fx-literal-fallbacks.js';

test('丙｜computeAssets：GBP 帳戶沒抓到匯率 → 用預設值 41 照常計入淨資產、defaultFx 標 GBP；抓到匯率 → 用即時值、defaultFx 空', () => {
  const base = { accounts: [
    { id: 't', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 },
    { id: 'g', type: 'cash', class: '現金', currency: 'GBP', balance: 100 },
  ] };
  const dflt = computeAssets(/** @type {any} */ ({ ...base, settings: { usdTwd: 32 } }));
  assert.equal(dflt.netWorth, 1000 + 100 * FX_DEFAULT_TWD.GBP, '沒抓到匯率＝用預設值照算（不可排除）');
  assert.equal(FX_DEFAULT_TWD.GBP, 41, 'William 2026-09-04 裁的預設值（改常數要連這裡一起改，避免默默漂）');
  assert.deepEqual(dflt.defaultFx, [{ currency: 'GBP', count: 1, rate: FX_DEFAULT_TWD.GBP }], '要標註哪個幣別、幾筆、用了什麼預設值');
  assert.deepEqual(dflt.missingFx, [], '支援的幣別不算「缺」');
  const live = computeAssets(/** @type {any} */ ({ ...base, settings: { usdTwd: 32, fxTwd: { GBP: 40 } } }));
  assert.equal(live.netWorth, 1000 + 100 * 40, '對照：抓到匯率就用即時值');
  assert.deepEqual(live.defaultFx, [], '對照：沒有用預設值就不標');
});

test('丙｜所有外幣同一條規則：美元沒設 usdTwd 也是「用預設值 31 並標註」，與英鎊／日圓一致', () => {
  const r = computeAssets(/** @type {any} */ ({ settings: {}, accounts: [
    { id: 'u', type: 'cash', class: '現金', currency: 'USD', balance: 10 },
    { id: 'j', type: 'cash', class: '現金', currency: 'JPY', balance: 1000 },
  ] }));
  assert.equal(r.netWorth, 10 * FX_DEFAULT_TWD.USD + 1000 * FX_DEFAULT_TWD.JPY);
  assert.deepEqual(r.defaultFx, [{ currency: 'USD', count: 1, rate: FX_DEFAULT_TWD.USD }, { currency: 'JPY', count: 1, rate: FX_DEFAULT_TWD.JPY }]);
});

test('丙｜不支援的幣別（EUR）才無法換算：不計入、missingFx 標註；不可再 `|| 1` 當台幣；缺 currency 仍預設台幣（既有判準）', () => {
  const r = computeAssets(/** @type {any} */ ({ settings: { usdTwd: 32 }, accounts: [
    { id: 'e', type: 'cash', class: '現金', currency: 'EUR', balance: 500 },
    { id: 'n', type: 'cash', class: '現金', balance: 7 },
  ] }));
  assert.equal(r.netWorth, 7, 'EUR 不可被當成台幣 500；缺 currency 的 7 元照舊當台幣');
  assert.deepEqual(r.missingFx, [{ currency: 'EUR', count: 1, liabilities: 0 }]);
  assert.deepEqual(r.defaultFx, []);
});

test('丙｜computeIb：JPY 持股沒抓到匯率 → 用預設值 0.2 照算、position 帶 fxSource=default、defaultFx 標 JPY；抓到 → live', () => {
  const db = /** @type {any} */ ({ settings: { usdTwd: 32 }, holdings: [
    { id: 'u', symbol: 'VT', currency: 'USD', quantity: 10, price: 100, avgCost: 90, source: 'ib' },
    { id: 'j', symbol: '7203', currency: 'JPY', quantity: 100, price: 3000, avgCost: 2500, source: 'manual' },
  ] });
  const ib = computeIb(db);
  const jp = ib.positions.find(p => p.id === 'j');
  assert.ok(jp && jp.fxSource === 'default' && jp.fxMissing === false, `預設匯率的持股要標 fxSource=default（實際 ${JSON.stringify({ s: jp?.fxSource, m: jp?.fxMissing })}）`);
  assert.equal(ib.totalValue, 10 * 100 * 32 + 100 * 3000 * FX_DEFAULT_TWD.JPY, '預設匯率的持股照常進 totalValue');
  assert.deepEqual(ib.defaultFx, [{ currency: 'JPY', count: 1, rate: FX_DEFAULT_TWD.JPY }]);
  const live = computeIb({ ...db, settings: { usdTwd: 32, fxTwd: { JPY: 0.2 } } });
  assert.equal(live.positions.find(p => p.id === 'j')?.fxSource, 'live');
  assert.deepEqual(live.defaultFx, []);
});

test('丙｜computeLeverage：ibCashCur 的 GBP 負現金沒抓到匯率 → 用預設值計入融資（不可排除、也不可當台幣）', () => {
  const holdings = [{ id: 'u', symbol: 'VT', currency: 'USD', quantity: 10, price: 100, avgCost: 90, source: 'ib' }];
  const accounts = [
    { id: 'usd', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: -200 },
    { id: 'gbp', type: 'cash', class: '現金', currency: 'GBP', ibCashCur: 'GBP', balance: -50 },
  ];
  const db = /** @type {any} */ ({ settings: { usdTwd: 32 }, holdings, accounts });
  assert.equal(computeLeverage(db, computeIb(db)).loan, 200 * 32 + 50 * FX_DEFAULT_TWD.GBP, '負債用預設匯率照算（看得見的負債最重要）');
  // 不支援的幣別（EUR）的負現金：無法換算 ⇒ 不計入融資（不可當台幣 `|| 1` 混進去）；它會由 computeAssets 的 missingFx 走 danger 提醒
  const withEur = /** @type {any} */ ({ ...db, accounts: [...accounts, { id: 'eur', type: 'cash', class: '現金', currency: 'EUR', ibCashCur: 'EUR', balance: -50 }] });
  assert.equal(computeLeverage(withEur, computeIb(withEur)).loan, 200 * 32 + 50 * FX_DEFAULT_TWD.GBP, 'EUR 負現金不可以 1:1 當台幣算進融資');
});

test('丙｜buildSummary 帶 defaultFx；提醒 fx-default 是 info、講出預設值與怎麼抓即時匯率；抓到匯率就沒有這則', () => {
  const base = { accounts: [{ id: 'g', type: 'cash', class: '現金', currency: 'GBP', balance: 100 }] };
  const s = buildSummary(/** @type {any} */ ({ ...base, settings: { usdTwd: 32 } }));
  assert.deepEqual(s.defaultFx, [{ currency: 'GBP', count: 1, rate: FX_DEFAULT_TWD.GBP }]);
  const r = s.reminders.find(x => x.key === 'fx-default');
  assert.ok(r && r.level === 'info', `用預設匯率只提示、不警告（實際 ${JSON.stringify(r)}）`);
  assert.match(String(r?.title), /GBP 41/, '要講出用了什麼預設值');
  assert.match(String(r?.detail), /更新報價/, '要告訴人怎麼抓即時匯率');
  assert.doesNotMatch(String(r?.title) + String(r?.detail), /未計入|不計入/, '預設匯率的部位是計入的，不可講成沒算');
  const live = buildSummary(/** @type {any} */ ({ ...base, settings: { usdTwd: 32, fxTwd: { GBP: 40 } } }));
  assert.equal(live.reminders.find(x => x.key === 'fx-default'), undefined);
});

test('丙｜不支援的幣別：有負債 → fx-missing 升 danger 並講明「負債被低估、淨值可能被高估」；只有資產 → warn', () => {
  const db = /** @type {any} */ ({ settings: { usdTwd: 32 }, accounts: [
    { id: 'eurCash', type: 'cash', class: '現金', currency: 'EUR', balance: -50 },
    { id: 'eurLoan', type: 'loan', currency: 'EUR', balance: 1000 },
    { id: 'eurAsset', type: 'cash', class: '現金', currency: 'EUR', balance: 20 },
  ] });
  const a = computeAssets(db);
  assert.equal(a.liabilities, 0, '不支援的幣別無法換算（丙③）——所以要用 danger 講出來');
  assert.deepEqual(a.missingFx, [{ currency: 'EUR', count: 3, liabilities: 2 }]);
  const r = buildSummary(db).reminders.find(x => x.key === 'fx-missing');
  assert.ok(r && r.level === 'danger', `有負債＝danger（實際 ${JSON.stringify(r)}）`);
  assert.match(String(r?.title), /2 筆是負債/); assert.match(String(r?.title), /負債被低估/); assert.match(String(r?.title), /淨值可能被高估/);
  const warn = buildSummary(/** @type {any} */ ({ settings: { usdTwd: 32 }, accounts: [{ id: 'e', type: 'cash', class: '現金', currency: 'EUR', balance: 20 }] })).reminders.find(x => x.key === 'fx-missing');
  assert.equal(warn?.level, 'warn');
});

test('丙｜零餘額帳戶／零股數持股不算曝險：defaultFx 與 missingFx 都空、不提醒（前後端同口徑）', async () => {
  const db = /** @type {any} */ ({ settings: {},
    accounts: [{ id: 'g0', type: 'cash', class: '現金', currency: 'GBP', balance: 0 }, { id: 'e0', type: 'cash', class: '現金', currency: 'EUR', balance: 0 }],
    holdings: [{ id: 'j0', symbol: '7203', currency: 'JPY', quantity: 0, price: 3000, avgCost: 2500, source: 'manual' }] });
  assert.deepEqual(computeAssets(db).defaultFx, []); assert.deepEqual(computeAssets(db).missingFx, []);
  assert.deepEqual(computeIb(db).defaultFx, []);
  assert.equal(buildSummary(db).reminders.find(x => x.key === 'fx-default' || x.key === 'fx-missing'), undefined);
  const { buildPortfolioModel } = await import('../public/modules/portfolio-model.js');
  const fe = buildPortfolioModel(db.holdings, db.accounts, db.settings);
  assert.deepEqual(fe.defaultFx, []); assert.deepEqual(fe.missingFx, []);
});

test('丙｜資產換算同一份實作：derive.js／snapshot.js／portfolio-calculations.js 直接 import fx-rates.js，portfolio-model.js 經 portfolio-calculations 轉口（結構檢查；交易損益與 IB 現金流的估算不在射程），且持股側與帳戶側數字逐欄相同', async () => {
  const root = new URL('../', import.meta.url);
  for (const f of ['lib/derive.js', 'lib/services/snapshot.js', 'public/modules/portfolio-calculations.js']) {
    const src = readSrc(new URL(f, root), 'utf8');
    assert.match(src, /from '(\.\.\/)*(public\/modules\/)?(\.\/)?fx-rates\.js'/, `${f} 必須 import fx-rates.js（唯一實作），不可自己另寫一份匯率表`);
  }
  { const src = readSrc(new URL('public/modules/portfolio-model.js', root), 'utf8');
    assert.match(src, /import \{[^}]*\bresolveFxTable\b[^}]*\} from '\.\/portfolio-calculations\.js'/, 'portfolio-model.js 的匯率表必須經 portfolio-calculations 轉口自 fx-rates.js');
    assert.deepEqual(findFxLiteralFallbacks(src, 'public/modules/portfolio-model.js'), [], 'portfolio-model.js 不可自己另算匯率（任何被數字字面量當退路的匯率算式都算；判準見 test/helpers/fx-literal-fallbacks.js）');
    assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ''), /\bfxTwd\b\s*\??\.?\s*\[/, 'portfolio-model.js 不可直接翻 settings.fxTwd 的表（要經 resolveFxTable）'); }
  // 資產換算這一側不可再有自己的預設匯率寫死在算式裡（fxHigh／fxLow 的 32 是分批區門檻、不在此列）。
  // ⚠️ 分工（William 2026-09-04 裁示，#558 r3–r5 連三輪被新形狀戳穿之後）：**主網是 test/fx-sentinel.test.js 的哨兵匯率行為題**
  //    （餵 12345／23456／34567，每一處換算都必須吃到它，寫死的數字會算錯而被抓）；這裡的結構題只當第二道網，
  //    抓「有匯率卻不用、退路寫死」的死程式——它列舉形狀、列舉補不完，不再為新形狀加輪。
  // 射程刻意不含 portfolio-calculations.js 的 tradePnlBase：它（與 ib-sync fxToBase）自丙-2 起也走同一份 fx-rates.js（分母是 USD→TWD 的比值），由 test/portfolio-calculations.test.js／test/ib-fx-income.test.js 的行為題釘住，不用結構檢查。
  for (const f of ['lib/derive.js', 'lib/services/snapshot.js']) {
    const src = readSrc(new URL(f, root), 'utf8');
    assert.deepEqual(findFxLiteralFallbacks(src, f), [], `${f} 不可再有自己的預設匯率寫死在算式裡（任何被數字字面量當退路的匯率算式都算，不只舊值 32／40.8／0.215；判準見 test/helpers/fx-literal-fallbacks.js）`);
  }
  assert.match(readSrc(new URL('public/modules/portfolio-calculations.js', root), 'utf8'), /export const fxTable = \(settings\) => resolveFxTable\(settings\)\.rates;/, '前端 fxTable 必須是 resolveFxTable 的投影，不可自己另算');
  const { buildPortfolioModel } = await import('../public/modules/portfolio-model.js');
  const holdings = /** @type {any} */ ([
    { id: 'u', symbol: 'VT', currency: 'USD', quantity: 10, price: 100, avgCost: 90, source: 'ib' },
    { id: 'g', symbol: 'ISF', currency: 'GBP', quantity: 5, price: 8, avgCost: 7, source: 'manual' },
  ]);
  const accounts = /** @type {any} */ ([
    { id: 'gbpCash', type: 'cash', class: '現金', currency: 'GBP', ibCashCur: 'GBP', balance: -50 },
    { id: 'eurLoan', type: 'loan', currency: 'EUR', balance: 1000 },
    { id: 'eurAsset', type: 'cash', class: '現金', currency: 'EUR', balance: 20 },
    { id: 'gbpZero', type: 'cash', class: '現金', currency: 'GBP', balance: 0 },
  ]);
  for (const settings of [{ usdTwd: 32 }, { usdTwd: 32, fxTwd: { GBP: 40 } }]) {
    const beIb = computeIb(/** @type {any} */ ({ settings, holdings }));
    const be = computeAssets(/** @type {any} */ ({ settings, holdings, accounts }));
    const fe = buildPortfolioModel(holdings, accounts, /** @type {any} */ (settings));
    assert.equal(fe.total, beIb.totalValue, `設定 ${JSON.stringify(settings)}：持股總市值前後端相同`);
    assert.deepEqual(fe.defaultFx, be.defaultFx, `設定 ${JSON.stringify(settings)}：defaultFx 逐欄相同`);
    assert.deepEqual(fe.missingFx, be.missingFx, `設定 ${JSON.stringify(settings)}：missingFx 逐欄相同（含 liabilities）`);
  }
  const be = computeAssets(/** @type {any} */ ({ settings: { usdTwd: 32 }, holdings, accounts }));
  assert.deepEqual(be.defaultFx, [{ currency: 'GBP', count: 2, rate: FX_DEFAULT_TWD.GBP }], '對照：持股 1＋負現金 1 用預設值（零餘額不算）');
  assert.deepEqual(be.missingFx, [{ currency: 'EUR', count: 2, liabilities: 1 }], '對照：EUR 兩筆不支援、其中 loan 是負債');
});


test('丙｜「寫死匯率」判斷器本身：#558 r3 的假綠與假紅各留一題，射程邊界也寫成題', () => {
  const hit = (code) => findFxLiteralFallbacks(code, 'probe.js').map((h) => h.name);
  // 假綠（r3 實測正規式抓不到）：名單沒 USD、兩個空白
  assert.deepEqual(hit('const u = ratesLev.rates.USD ||  31;'), ['USD']);
  // 假紅（r3 實測正規式誤殺）：GBP 筆數退路不是匯率
  assert.deepEqual(hit('const n = t.defaultFx().GBP.count || 0;'), []);
  // 其他該抓的形狀：??／動態鍵／包裝函式／三元式／鏈／字串鍵／呼叫／負數／給 missing 塞預設值
  for (const code of [
    'const u = s.usdTwd ?? 31;', 'const g = settings.fxTwd?.[cur] || 41;', 'const j = Number(s.fxTwd.JPY) || 0.2;',
    'const u = s.usdTwd > 0 ? s.usdTwd : 31;', 'const u = ok ? fxFor(t, c).rate : 31;', 'const u = (s.usdTwd || s.legacyUsd) || 32;',
    "const g = fxTwd['GBP'] || 41;", 'const r = usdRate(s) || -31;', 'const r = f.missing ? 31 : f.rate;',
    'const z = bal * f.rate || 0;', 'const t = `${fmt(Math.abs(x) * ratesLev.rates.USD ||  31)}`;',   // 乘積的 NaN 防呆＝把缺匯率靜靜蓋掉
    // r4 實測：複合條件把 31 藏在豁免後面（條件裡「出現」missing ≠ 條件「就是」missing）；兩支都是數字也不能放
    'const idleUsd = total / (fxFor(ratesLev, "USD").missing && ratesLev.rates.USD > 0 ? 0 : 31);',
    'const r = f.missing ? 0 : 31;', 'const r = f.missing || bad ? 0 : f.rate;', 'const r = f.missing ? f.rate : 31;',
    // r5 實測：把 missing 包進呼叫／比較裡躲過「末端名字」；解析器的四個欄位在條件裡任何位置都算
    'const idleUsd = total / (Boolean(fxFor(ratesLev, "USD").missing) ? 0 : 31);', 'const r = !!f.missing ? 0 : 31;',
    "const r = f.source === 'unsupported' ? 0 : 31;", "const r = f['missing'] ? 0 : 31;", 'const r = [f].some((x) => x.missing) ? 0 : 41;',
  ]) assert.equal(hit(code).length, 1, `該抓沒抓：${code}`);
  // 不該抓的（都是三個真檔裡實際存在的形狀）：分批門檻、數量／餘額、動態鍵累加、乘積防呆、缺匯率不計入
  for (const code of [
    'const fxHigh = Number(s.fxHigh || 32);', 'const q = Number(h.quantity || 0);', 'const x = byClass[cls] || 0;',
    'const v = f.missing ? 0 : Number(account.balance || 0) * f.rate;', 'const r = f.missing ? 0 : f.rate;', 'const r = !f.missing ? f.rate : 0;',
  ]) assert.deepEqual(hit(code), [], `誤殺：${code}`);
  // 射程之外（誠實劃界）：不長那三種形狀的寫法抓不到——這一題釘住「它不保證什麼」
  for (const code of ['const u = Math.max(s.usdTwd, 31);', 'let u = s.usdTwd; if (!u) u = 31;', 'const v = ok ? qty * f.rate : 0;']) assert.deepEqual(hit(code), [], `射程外卻命中：${code}`);
  // 壞語法要丟例外（TS 解析器不會自己丟；半棵樹會靜靜漏抓）
  assert.throws(() => findFxLiteralFallbacks('const u = s.usdTwd || ;', 'bad.js'), /解析失敗/);
});
test('丙｜換匯區間提醒（fx-usd-high／low）只看「抓到的」美元匯率：沒抓到時預設值落在門檻上也不可假報「已達高點」', () => {
  const dflt = buildSummary(/** @type {any} */ ({ settings: { fxHigh: FX_DEFAULT_TWD.USD }, accounts: [] })).reminders;   // 門檻＝預設值：沒有守門就會 >= 而誤報
  assert.equal(dflt.find(r => r.key === 'fx-usd-high' || r.key === 'fx-usd-low'), undefined, '預設匯率不是市場匯率，不可觸發換匯區間提醒');
  const live = buildSummary(/** @type {any} */ ({ settings: { usdTwd: 33, fxHigh: 32, fxLow: 28 }, accounts: [] })).reminders;
  assert.ok(live.find(r => r.key === 'fx-usd-high'), '對照：抓到的 33 ≥ 32 要提醒');
});
