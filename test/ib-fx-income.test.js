// IB 同步的換匯與收益寫回考題（階段三缺口 M3）：syncIb 的兩段錢路原本零考題——
// ①fxToBase closure：把非 USD 現金流用設定或預設匯率換算成 USD 基準（分子分母寫反＝股息估算差 ~10 倍，照樣寫入）
// ②data.income 寫回 settings.ib.income（前端「投資活動｜IB 現金流」顯示的就是這份）。
// 隔離：STORE_FILE 指 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-ibfx-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { syncIb } = await import('../lib/services/ib-sync.js');

after(() => { for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

beforeEach(() => {
  const db = store.emptyDb();
  db.settings = { ...db.settings, usdTwd: 32, fxTwd: { GBP: 40, JPY: 0.2 }, ib: { flexToken: 'test-token', flexQueryId: 'q1' } };
  store.save(db);
});

/** 最小合成 Flex 彙整（其他區塊清空；照 securities-sync.test.js 的 feed 形狀） @param {any=} extra */
const feed = (extra = {}) => ({
  positions: [], cashByCurrency: {}, hasCashReport: false, hasCashDetail: false, cashDetailIncomplete: false,
  baseCurrency: 'USD', baseSummaryCash: null, statementCount: 1, accountCount: 1,
  equity: null, income: null, trades: [], rawTrades: [], period: { from: '2026-01-01', to: '2026-06-30' }, ...extra,
});

test('fxToBase：TWD/GBP/JPY 用設定匯率換 USD 基準（curTwd/usdTwd）；不支援的幣別回 null 不猜（支援的幣別沒抓到 ⇒ 預設值，見丙-2 題）', async () => {
  /** @type {any} */ let captured = null;
  await syncIb(async (_t, _q, fxToBase) => { captured = fxToBase; return feed(); });
  assert.ok(captured, 'fetchImpl 要拿到 fxToBase');
  assert.equal(captured('USD'), 1, 'USD 基準＝1');
  assert.equal(captured('TWD'), 1 / 32, 'TWD→USD＝1/usdTwd（分子分母反了會差 ~1000 倍）');
  assert.equal(captured('GBP'), 40 / 32, 'GBP→USD＝gbpTwd/usdTwd');
  assert.equal(captured('JPY'), 0.2 / 32, 'JPY→USD＝jpyTwd/usdTwd');
  assert.equal(captured('CHF'), null, '不支援的幣別不猜、回 null（上游列入 skippedNoFx）');
  assert.equal(captured(''), 1, '空幣別依口徑當 USD');
});

test('income 寫回：逐欄 r2 四捨五入、from/to 從 period 帶入；null 收益＝寫 null 不是殘骸', async () => {
  await syncIb(async () => feed({ income: {
    dividends: 12.344, paymentInLieu: 0, withholdingTax: 1.006, interestPaid: -3.216,
    interestReceived: 2, other: 0.004, count: 7, skippedNoFx: 1, estimatedNoFx: 2, estimatedCurrencies: ['JPY'],
  } }));
  const inc = store.load().settings.ib.income;
  assert.equal(inc.dividends, 12.34, '逐欄 r2（分→角落地）');
  assert.equal(inc.withholdingTax, 1.01);
  assert.equal(inc.interestPaid, -3.22, '負值（付出的利息）也照 r2');
  assert.equal(inc.other, 0, '0.004 → 0');
  assert.equal(inc.count, 7);
  assert.equal(inc.skippedNoFx, 1);
  assert.deepEqual(inc.estimatedCurrencies, ['JPY']);
  assert.equal(inc.from, '2026-01-01');
  assert.equal(inc.to, '2026-06-30', 'from/to 讓前端能標示「這段期間」——缺了會誤當終身總額');
  // 第二次同步沒有 income 區塊 → 寫 null（看得見的退化），不可留上次舊值假裝最新
  await syncIb(async () => feed({ income: null }));
  assert.equal(store.load().settings.ib.income, null, '缺席＝清空，不留過期舊值');
});

test('丙-2｜fxToBase：支援的幣別沒抓到匯率 → 用預設值估（GBP 41/32、JPY 0.2/32），不再回 null；不支援的 CHF 仍回 null', async () => {
  { const db = store.emptyDb(); db.settings = { ...db.settings, usdTwd: 32, fxTwd: {}, ib: { flexToken: 'test-token', flexQueryId: 'q1' } }; store.save(db); }
  /** @type {any} */ let captured = null;
  await syncIb(async (_t, _q, fxToBase) => { captured = fxToBase; return feed(); });
  assert.ok(Math.abs(captured('GBP') - 41 / 32) < 1e-12, 'GBP 沒抓到 ⇒ 預設 41 ÷ 32');
  assert.ok(Math.abs(captured('JPY') - 0.2 / 32) < 1e-12);
  assert.equal(captured('CHF'), null, '不支援的幣別才回 null');
});

test('丙-2｜真實 fxToBase＋parseStatement：GBP 股息缺 IBKR 匯率、也沒抓到 GBP 匯率 → 進 estimatedNoFx（用預設 41/32 估）而不是 skippedNoFx', async () => {
  const { parseStatement } = await import('../lib/ib.js');
  { const db = store.emptyDb(); db.settings = { ...db.settings, usdTwd: 32, fxTwd: {}, ib: { flexToken: 'test-token', flexQueryId: 'q1' } }; store.save(db); }
  /** @type {any} */ let captured = null;
  await syncIb(async (_t, _q, fxToBase) => { captured = fxToBase; return feed(); });
  const flex = { FlexQueryResponse: { FlexStatements: { FlexStatement: { accountId: 'U-TEST', AccountInformation: { currency: 'USD' },
    CashTransactions: { CashTransaction: [{ type: 'Dividends', currency: 'GBP', amount: '10' }] } } } } };
  const inc = parseStatement(flex, captured).income;
  assert.equal(inc?.estimatedNoFx, 1, '沒抓到 GBP 匯率 ⇒ 用預設值估、計入 estimatedNoFx');
  assert.equal(inc?.skippedNoFx, 0, '不可再落 skippedNoFx');
  assert.deepEqual(inc?.estimatedCurrencies, ['GBP']);
  assert.ok(Math.abs((inc?.dividends || 0) - 10 * 41 / 32) < 1e-9, `股息＝10 × 41 ÷ 32（實際 ${inc?.dividends}）`);
});
