// @ts-check
// IBKR Flex Query 同步（B2 服務層）：持倉合併進 holdings、現金更新到帳戶、
// 官方淨值/現金流/成交紀錄寫入 settings.ib 與 ibTrades。失敗直接 throw（路由層轉 400）。
import { getDb, saveDb, uid } from '../repo.js';
import { fetchFlex } from '../ib.js';
import { CURRENCIES } from '../schema.js';

// 新代號的預設分層（找不到就歸「區域衛星」，之後可在編輯裡改）。
// ⚠️ 同步點（AGENTS.md）：新增代號時，兩份 COMPOSITION（portfolio.js/derive.js）也要有。
export const DEFAULT_LAYER = {
  CSPX: 'core', QQQM: 'core', VUAA: 'core', SPY: 'core', VOO: 'core',
  EIMI: 'satellite', XUSE: 'satellite', EXUS: 'satellite', ICHN: 'satellite',
  KWEB: 'satellite', CSKR: 'satellite', SJPA: 'satellite', SMH: 'satellite',
  GOOGL: 'stock', GOOG: 'stock', AAPL: 'stock',
  TSLA: 'stock', SPCX: 'stock',
  SGLD: 'gold', GLD: 'gold', IAU: 'gold'
};

/**
 * 執行同步；成功回傳前端要的摘要物件、失敗 throw Error。
 * @param {typeof fetchFlex=} fetchImpl 測試用注入點（考題餵合成 Flex 資料；正常執行用預設 fetchFlex）
 */
export async function syncIb(fetchImpl = fetchFlex) {
  const db = getDb();
  const { flexToken, flexQueryId } = db.settings.ib || {};
  // 現金流缺 IBKR 匯率時，用設定匯率估算為 USD 基準（與交易摘要同口徑，AGENTS.md 優先序）
  const fxToBase = (/** @type {string} */ cur) => {
    const c = String(cur || 'USD').toUpperCase();
    if (c === 'USD') return 1;
    const usdTwd = Number(db.settings.usdTwd || 32);
    const curTwd = c === 'TWD' ? 1 : Number(/** @type {any} */ (db.settings.fxTwd)?.[c] || 0);
    return (curTwd > 0 && usdTwd > 0) ? curTwd / usdTwd : null;
  };
  let data;
  try { data = await fetchImpl(flexToken, flexQueryId, fxToBase); }
  catch (e) {   // IB 連線/token/Query ID 類＝使用者層預期錯誤 → 標 400（路由原味回應）；其後的內部錯誤不標、交全域中介（Codex#11-2）
    throw Object.assign(new Error(String(/** @type {any} */ (e).message || 'IB 同步失敗')), { status: 400, cause: e });
  }
  db.holdings = db.holdings || [];
  const r2 = (/** @type {any} */ x) => Math.round(Number(x || 0) * 100) / 100;   // 金額統一到小數點後兩位
  // 幣別牆（Codex 第七輪，高）：IB 同步不可繞過 schema 的幣別枚舉——系統只支援 CURRENCIES 四種，
  // 未支援幣別（EUR/HKD…）寫進去會被 derive 用錯匯率計價（淨值/槓桿偏掉）。
  // 遇到就「跳過＋回報」（看得見的退化勝過默默算錯）；要支援新幣別＝同步擴充 fxRates/fxTable/schema（AGENTS 同步點）。
  /** @type {string[]} */
  const skippedCurrencies = [];
  const curOk = (/** @type {any} */ c) => !c || CURRENCIES.includes(String(c).toUpperCase());
  let updated = 0, created = 0;
  for (const p of data.positions) {
    const sym = String(p.symbol || '').toUpperCase().trim();
    if (!sym) continue;
    if (!curOk(p.currency)) { skippedCurrencies.push(`${sym}(${p.currency})`); continue; }
    const h = db.holdings.find(x => String(x.symbol || '').toUpperCase().trim() === sym);   // 兩邊都 trim，避免夾帶空白的符號比不中→重複建立
    if (h) {
      h.quantity = p.quantity;
      if (p.marketPrice) h.price = r2(p.marketPrice);
      if (p.avgCost) h.avgCost = r2(p.avgCost);
      if (p.currency) h.currency = p.currency;
      h.source = 'ib';
      updated++;
    } else {
      // 新持股與既有持股同口徑：價格/均價「有值才設」（缺市價時不寫入誤導性的 0，避免靜默把市值算成 0）
      /** @type {any} */
      const nh = {
        id: uid(), symbol: sym, name: p.description || sym,
        layer: /** @type {any} */ (DEFAULT_LAYER)[sym] || 'satellite',
        currency: p.currency || 'USD', quantity: p.quantity, quoteSymbol: '', source: 'ib'
      };
      if (p.marketPrice) nh.price = r2(p.marketPrice);
      if (p.avgCost) nh.avgCost = r2(p.avgCost);
      db.holdings.push(nh);
      created++;
    }
  }
  // 各幣別現金 → 更新（或建立）帶 ibCashCur 標記的現金帳戶（同樣過幣別牆）
  for (const [cur, cash] of Object.entries(data.cashByCurrency || {})) {
    if (!isFinite(cash)) continue;
    if (!curOk(cur)) { skippedCurrencies.push(`現金(${cur})`); continue; }
    let acc = (db.accounts || []).find(a => a.ibCashCur === cur);
    if (!acc) {
      acc = { id: uid(), name: `IBKR ${cur} 現金`, type: 'cash', class: '現金', currency: cur, ibCashCur: cur, balance: 0 };
      (db.accounts = db.accounts || []).push(acc);
    }
    acc.balance = r2(cash);
    acc.currency = cur;
  }
  // 曾由 IB 同步、但這次報表已找不到的持股 → 可能已出清，回報給前端確認
  const seen = new Set(data.positions.map(p => String(p.symbol || '').toUpperCase().trim()));
  const missing = db.holdings
    .filter(h => h.source === 'ib' && !seen.has(String(h.symbol || '').toUpperCase().trim()))
    .map(h => ({ id: h.id, symbol: h.symbol }));
  // 缺席的區塊要「清空」而不是留舊值：看得見的退化（fallback/卡片消失）勝過
  // 默默拿過期的官方淨值算槓桿與斷頭距離。必要的 Flex 區塊清單見設定頁說明。
  // 深層驗證 stock/cash 為數字（與 /api/import 同標準）：壞值→丟棄 lastEquity 走 fallback 自算，
  // 而不是讓 NaN cash 使 computeLeverage 誤判「無融資」、把融資風險藏起來。
  const eq = data.equity;
  db.settings.ib.lastEquity = (eq && Number.isFinite(eq.stock) && Number.isFinite(eq.cash)) ? eq : null;
  db.settings.ib.income = data.income ? {
    dividends: r2(data.income.dividends), paymentInLieu: r2(data.income.paymentInLieu),
    withholdingTax: r2(data.income.withholdingTax), interestPaid: r2(data.income.interestPaid),
    interestReceived: r2(data.income.interestReceived), other: r2(data.income.other),
    count: data.income.count, skippedNoFx: data.income.skippedNoFx || 0,
    estimatedNoFx: data.income.estimatedNoFx || 0, estimatedCurrencies: data.income.estimatedCurrencies || [],
    from: data.period?.from || '', to: data.period?.to || ''
  } : null;
  db.ibTrades = Array.isArray(data.trades) ? data.trades : [];   // 交易摘要與 XIRR 已實現損益修正使用中
  db.settings.ib.lastSync = new Date().toISOString();
  saveDb(db);
  if (skippedCurrencies.length) console.warn(`[ib-sync] 跳過未支援幣別（系統僅支援 ${CURRENCIES.join('/')}）：${skippedCurrencies.join(', ')}——要支援請擴充 fxRates/fxTable/schema（AGENTS 同步點）`);
  return { ok: true, updated, created, missing, skippedCurrencies, cash: data.cashByCurrency, equity: data.equity, account: data.account };
}
