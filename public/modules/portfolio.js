// @ts-check
// 投資組合：核心–衛星架構儀表板
// 頁面順序：紀律檢查 → 幣別曝險 → IB現金流 → 交易摘要 → 持股曝險(區域) → 投資分層 → 持股佔比(圓環) → 持股表 → 願望清單 → CAPE → 投入vs市值 → 個股研究卡
import { api, view, byId, esc, moneyCur, todayStr, parseLocalDate, openForm, openInfo, openPrintWindow, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { buildPortfolioModel } from './portfolio-model.js';
import { buildPortfolioPageState } from './portfolio-state.js';
import { buildPortfolioReport } from './portfolio-report.js';
import {
  assetAccountDetailHtml,
  assetGoldDetailHtml,
  assetHoldingDetailHtml,
  costDetailHtml,
  tradesModalHtml
} from './portfolio-details.js';
import { incomeActivityHtml, INCOME_INFO, tradesActivityHtml } from './portfolio-activity.js';
import {
  companiesSection,
  disciplineSection,
  fxSection,
  holdingsDonut,
  layerSection,
  LAYERS,
  LAYER_ORDER,
  regionSection
} from './portfolio-visuals.js';
import { capeInfoOf } from './portfolio-valuation.js';
import { holdingsTableHtml, watchlistSectionHtml } from './portfolio-tables.js';
import { researchFormModel, researchSectionHtml } from './portfolio-research.js';
import {
  portfolioHeaderHtml,
  portfolioSummaryHtml,
  valuationPlaceholdersHtml,
  xirrSectionHtml,
  XIRR_INFO_HTML
} from './portfolio-overview.js';
import { investmentChartConfig } from './portfolio-chart.js';
import { createPortfolioEditors } from './portfolio-editors.js';
import { createPortfolioRemoteActions } from './portfolio-remote-actions.js';
import { createPortfolioValuationActions } from './portfolio-valuation-actions.js';
import { formatPercent, formatPortfolioMoney } from './portfolio-format.js';
import { disciplineInfoHtml, totalValueInfoHtml } from './portfolio-info.js';

// 雙計價顯示：TWD（台幣計價，單位「萬」）或 USD（美元計價，單位「K」），記在 localStorage
let viewCur = localStorage.getItem('pf_viewCur') || 'TWD';
let usdRate = 32;
// 投資原則凍結名單（每次 render 重算；供「編輯持股」加碼警告用）
let FREEZE = { symbols: new Set(), regions: new Set(), equity: false };
const MONEY = (twd) => formatPortfolioMoney(twd, { viewCurrency: viewCur, usdRate });
// app.js 與頁面模組互相 import；要到使用時才讀 esc，避免頂層循環 import 的 TDZ 白屏。
const detailFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY });
const activityOptions = () => ({ escapeHtml: esc, viewCurrency: viewCur, usdRate });
const visualFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY, formatPercent });
const tableFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY, formatPercent });

let lineChart = null;

// 持股表排序（分組內排序，市值/損益/報酬率/佔比）
let hSortKey = localStorage.getItem('pf_hSortKey') || 'value';
let hSortDir = localStorage.getItem('pf_hSortDir') || 'desc';

export async function renderPortfolio() {
  const seq = currentRouteSeq();
  const [holdings, watchlist, research, settings, psnaps, accounts, ibTrades, summary] = await Promise.all([
    api('/holdings'), api('/watchlist'), api('/research'), api('/settings'), api('/portfolioSnapshots'), api('/accounts'), api('/ibTrades'), api('/summary')
  ]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別動 DOM/圖表（Codex r10#6）——初次渲染以前沒守，只有背景 ibSync 有守
  if (lineChart) { lineChart.destroy(); lineChart = null; }
  const {
    fx, rows, total, totalCost, totalPnl,
    bondV, goldV, eqV, ibValTwd, loanTwd, netEquity, leverage,
    goldAll, cashV, allBase, stockRows, bondRows, goldRows,
    cashAccounts, goldAccounts, regionMap
  } = buildPortfolioModel(holdings, accounts, settings);
  usdRate = fx.USD;
  const {
    layerValues: layerV, qqqmShare, qqqmMax, netWorth,
    caps: CAPS, freeze, xirr: xr
  } = buildPortfolioPageState({
    rows, regionMap, equityValue: eqV, summary, settings,
    snapshots: psnaps, totalCost, totalValue: total,
    ibTrades, usdRate: fx.USD, parseLocalDate, layers: LAYERS
  });
  FREEZE = freeze;
  const editors = createPortfolioEditors({
    api,
    openForm,
    toast,
    rerender: renderPortfolio,
    confirmFreeze: message => window.confirm(message),
    getFreeze: () => FREEZE,
    layers: LAYERS,
    layerOrder: LAYER_ORDER
  });
  const remoteActions = createPortfolioRemoteActions({
    api,
    toast,
    rerender: renderPortfolio,
    getRouteSeq: currentRouteSeq,
    today: todayStr,
    formatOriginalMoney: moneyCur,
    confirmMissing: message => window.confirm(message)
  });
  const valuationActions = createPortfolioValuationActions({
    api,
    getElement: byId,
    openForm,
    openInfo,
    toast,
    rerender: renderPortfolio,
    escapeHtml: esc,
    formatPercent
  });

  view().innerHTML = `
    ${portfolioHeaderHtml(viewCur)}
    ${portfolioSummaryHtml({ total, totalCost, totalPnl, eqV, bondV, cashV, goldAll, allBase, leverage, netEquity, loanTwd, levCap: CAPS.lev }, { formatMoney: MONEY })}

    ${disciplineSection(rows, regionMap, eqV, netWorth, leverage, CAPS, ibValTwd, loanTwd, visualFormatters())}
    ${fxSection(rows, accounts, fx, visualFormatters())}
    ${incomeActivityHtml(settings, activityOptions())}
    ${tradesActivityHtml(ibTrades, settings, activityOptions())}
    ${regionSection(regionMap, eqV, visualFormatters())}
    ${companiesSection(rows, eqV, visualFormatters())}
    ${layerSection(layerV, total, visualFormatters())}
    ${holdingsDonut(rows, total, visualFormatters())}
    ${holdingsTableHtml(rows, total, { sortKey: hSortKey, sortDir: hSortDir, formatters: tableFormatters() })}
    ${watchlistSectionHtml(watchlist, tableFormatters())}

    ${valuationPlaceholdersHtml()}
    ${xirrSectionHtml(xr, { escapeHtml: esc })}

    ${researchSectionHtml(rows, research, { escapeHtml: esc, formatPercent })}
  `;

  // ---- handlers ----
  byId('addHolding').onclick = () => editors.openHolding(null);
  byId('refreshQuotes').onclick = (e) => remoteActions.refreshQuotes(e.currentTarget, holdings, watchlist, settings);   // currentTarget＝按鈕本身（e.target 可能是內層圖示，disabled 會設錯對象，自主體檢）
  byId('printPortfolio').onclick = () => printPortfolioReport({
    rows, accounts, fx, settings, ibTrades, total, totalCost, totalPnl,
    layerV, regionMap, eqV, bondV, goldAll,
    loanTwd, netEquity, leverage
  });
  byId('ibSync').onclick = (/** @type {any} */ e) => remoteActions.syncIb(e.currentTarget);
  view().querySelectorAll('.fee-tog[data-cur]').forEach(t => t.onclick = () => {
    if (viewCur !== t.dataset.cur) { viewCur = t.dataset.cur; try { localStorage.setItem('pf_viewCur', viewCur); } catch {} renderPortfolio(); }
  });
  view().querySelectorAll('th[data-hsort]').forEach(th => th.onclick = () => {
    const k = th.dataset.hsort;
    if (hSortKey === k) hSortDir = hSortDir === 'asc' ? 'desc' : 'asc';
    else { hSortKey = k; hSortDir = 'desc'; }
    try { localStorage.setItem('pf_hSortKey', hSortKey); localStorage.setItem('pf_hSortDir', hSortDir); } catch {}
    renderPortfolio();
  });
  // ⏸ 休眠中：#fxBandEdit 只有在 fxGaugeHtml（目前停放、未插入頁面）渲染時才存在；
  //   等匯率儀表決定放回頁面時，控制器內的 openFxBands() 會一起恢復作用。
  //   註：fxHigh/fxLow 的「調整入口」現已改由設定頁「提醒門檻」管理（換匯提醒即時生效），
  //   控制器內停放的 openFxBands 若日後恢復，屬儀表上的便捷入口、非唯一調整途徑。
  view().querySelectorAll('.info-link[data-info]').forEach(b => b.onclick = () => {
    const info = INCOME_INFO[b.dataset.info];
    if (info) openInfo(info[0], info[1]);
  });
  const tradesFullBtn = byId('tradesFull');
  if (tradesFullBtn) tradesFullBtn.onclick = () => openInfo('完整交易明細', tradesModalHtml(ibTrades, { escapeHtml: esc }), { size: 'xl' });
  const totalValueInfo = byId('totalValueInfo');
  if (totalValueInfo) totalValueInfo.onclick = () => openInfo('總市值', totalValueInfoHtml({
    total, equity: eqV, bond: bondV, gold: goldV
  }, { formatMoney: MONEY }), { size: 'md' });
  const totalCostInfo = byId('totalCostInfo');
  if (totalCostInfo) totalCostInfo.onclick = () => openInfo('成本', costDetailHtml(rows, totalCost, detailFormatters()), { size: 'sm' });
  const assetStockInfo = byId('assetStockInfo');
  if (assetStockInfo) assetStockInfo.onclick = () => openInfo('股票', assetHoldingDetailHtml('股票', stockRows, eqV, allBase, detailFormatters()), { size: 'sm' });
  const assetBondInfo = byId('assetBondInfo');
  if (assetBondInfo) assetBondInfo.onclick = () => openInfo('債券', assetHoldingDetailHtml('債券', bondRows, bondV, allBase, detailFormatters()), { size: 'sm' });
  const assetCashInfo = byId('assetCashInfo');
  if (assetCashInfo) assetCashInfo.onclick = () => openInfo('現金', assetAccountDetailHtml('現金', cashAccounts, cashV, detailFormatters()), { size: 'sm' });
  const assetGoldInfo = byId('assetGoldInfo');
  if (assetGoldInfo) assetGoldInfo.onclick = () => openInfo('黃金', assetGoldDetailHtml(goldRows, goldAccounts, goldAll, allBase, detailFormatters()), { size: 'sm' });
  const xInfo = byId('xirrInfo');
  if (xInfo) xInfo.onclick = () => openInfo('年化報酬（XIRR）', XIRR_INFO_HTML, { size: 'md' });
  const dInfo = byId('disciplineInfo');
  if (dInfo) dInfo.onclick = () => openInfo('紀律檢查', disciplineInfoHtml(CAPS));
  view().querySelectorAll('[data-edit-h]').forEach(b => b.onclick = () => editors.openHolding(holdings.find(h => h.id === b.dataset.editH)));
  view().querySelectorAll('[data-del-h]').forEach(b => b.onclick = () => {
    const h = holdings.find(x => x.id === b.dataset.delH);
    confirmDelete(h.symbol, () => api('/holdings/' + h.id, { method: 'DELETE' }));
  });
  const addW = byId('addWatch');
  if (addW) addW.onclick = () => editors.openWatch(null);
  view().querySelectorAll('[data-edit-w]').forEach(b => b.onclick = () => editors.openWatch(watchlist.find(w => w.id === b.dataset.editW)));
  view().querySelectorAll('[data-del-w]').forEach(b => b.onclick = () => {
    const w = watchlist.find(x => x.id === b.dataset.delW);
    confirmDelete(w.symbol, () => api('/watchlist/' + w.id, { method: 'DELETE' }));
  });
  view().querySelectorAll('[data-edit-r]').forEach(b => b.onclick = () => openResearchForm(b.dataset.editR, research));
  view().querySelectorAll('[data-add-cp]').forEach(b => b.onclick = () => addCheckpoint(b.dataset.addCp, research));

  drawInvestChart(psnaps, totalCost, total);
  valuationActions.bind(settings, qqqmShare, qqqmMax);
}

// 美元／台幣匯率儀表目前刻意停放；純 HTML 組裝已移到 portfolio-valuation.js 的 fxGaugeHtml。
// 要恢復時再 import 並插入 render；區間調整表單保留在下方，設定頁也有正式入口。

// ---- ⑥ 投入 vs 市值 ----
function drawInvestChart(psnaps, curCost, curValue) {
  const ctx = byId('investChart');
  if (!ctx) return;
  lineChart = new Chart(ctx, investmentChartConfig(psnaps, curCost, curValue, {
    viewCurrency: viewCur,
    usdRate
  }));
}

async function addCheckpoint(symbol, research) {
  const input = byId('cp_' + symbol);
  const note = (input?.value || '').trim();
  if (!note) return toast('先輸入筆記內容', true);
  const r = research.find(x => (x.symbol || '').toUpperCase() === symbol.toUpperCase());
  const cp = { date: todayStr(), note };
  try {
    if (r) await api('/research/' + r.id, { method: 'PUT', body: { checkpoints: [...(r.checkpoints || []), cp] } });
    else await api('/research', { method: 'POST', body: { symbol, thesis: '', metrics: '', risks: '', checkpoints: [cp] } });
    toast('已記錄檢查點'); renderPortfolio();
  } catch (e) { toast(e.message, true); }
}

function openResearchForm(symbol, research) {
  const form = researchFormModel(symbol, research);
  openForm({
    title: form.title,
    fields: form.fields,
    values: form.values,
    onSubmit: async (data) => {
      if (form.existing) await api('/research/' + form.existing.id, { method: 'PUT', body: data });
      else await api('/research', { method: 'POST', body: { symbol, ...data, checkpoints: [] } });
      toast('已儲存'); renderPortfolio();
    }
  });
}

// ---- 列印報表：投資組合（跟隨目前計價：台幣→元/萬、美元→USD/K，A4）----
async function printPortfolioReport(data) {
  let cape = null;
  try { cape = await api('/cape'); } catch {}
  const capeInfo = capeInfoOf(cape);
  const report = buildPortfolioReport({ ...data, capeInfo }, {
    viewCurrency: viewCur,
    generated: todayStr(),
    sortKey: hSortKey,
    sortDir: hSortDir,
    layers: LAYERS,
    layerOrder: LAYER_ORDER,
    escapeHtml: esc
  });
  openPrintWindow(report.title, report.extraCss, report.html);
}
