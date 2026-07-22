// @ts-check
// 投資組合：核心–衛星架構儀表板
// 頁面順序：紀律檢查 → 幣別曝險 → IB現金流 → 交易摘要 → 持股曝險(區域) → 投資分層 → 持股佔比(圓環) → 持股表 → 願望清單 → CAPE → 投入vs市值 → 個股研究卡
import { api, view, byId, esc, moneyCur, todayStr, parseLocalDate, openForm, openInfo, openPrintWindow, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { CHART, AXIS, GRID, ACCENT, ACCENT_SOFT } from './theme.js';
import { icon } from './icons.js';
import { portfolioXirr } from './portfolio-calculations.js';
import { compOf } from './portfolio-exposure.js';
import { buildPortfolioModel } from './portfolio-model.js';
import { portfolioCaps, portfolioFreeze } from './portfolio-risk.js';
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
import { capeBodyHtml, capeInfoOf, signalsBodyHtml, SIGNALS_INFO_HTML } from './portfolio-valuation.js';
import { holdingsTableHtml, watchlistSectionHtml } from './portfolio-tables.js';

const fmtPct = (n, d = 1) => (Number(n) || 0).toFixed(d) + '%';
// 千（K）與萬：>=10 單位取整；<10 單位保留一位小數（2.4 K／6.5 萬）
const kNum = (n) => { const v = n / 1000; return Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1); };
const wanNum = (n) => { const v = n / 10000; return Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1); };

// ---- 幣別 ----
const CURRENCIES = ['USD', 'TWD', 'GBP', 'JPY'];
// 雙計價顯示：TWD（台幣計價，單位「萬」）或 USD（美元計價，單位「K」），記在 localStorage
let viewCur = localStorage.getItem('pf_viewCur') || 'TWD';
let usdRate = 32;
// 投資原則凍結名單（每次 render 重算；供「編輯持股」加碼警告用）
let FREEZE = { symbols: new Set(), regions: new Set(), equity: false };
const MONEY = (twd) => {   // 負號一律 U+2212（鐵則 5）
  const n = Number(twd || 0), sign = n < 0 ? '−' : '', v = Math.abs(n);
  return viewCur === 'USD' ? sign + kNum(v / usdRate) + ' K USD' : sign + wanNum(v) + ' 萬';
};
// app.js 與頁面模組互相 import；要到使用時才讀 esc，避免頂層循環 import 的 TDZ 白屏。
const detailFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY });
const activityOptions = () => ({ escapeHtml: esc, viewCurrency: viewCur, usdRate });
const visualFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY, formatPercent: fmtPct });
const tableFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY, formatPercent: fmtPct });

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
  const shr = (v) => allBase ? Math.round(v / allBase * 100) : 0;

  // 分層
  /** @type {Record<string, number>} */
  const layerV = {};
  rows.forEach(r => { const l = r.layer && LAYERS[r.layer] ? r.layer : 'satellite'; layerV[l] = (layerV[l] || 0) + r.valueTwd; });

  // QQQM 佔美股核心
  const vOf = (sym) => rows.filter(r => (r.symbol || '').toUpperCase() === sym).reduce((s, r) => s + r.valueTwd, 0);
  const qqqm = vOf('QQQM'), cspx = vOf('CSPX');
  const qqqmShare = (qqqm + cspx) > 0 ? qqqm / (qqqm + cspx) * 100 : 0;
  const qqqmMax = Number(settings.qqqmMaxPct || 30);

  // 投資原則（口徑 % 淨資產、穿透；軟上限）：上限值與凍結名單
  const netWorth = Number(summary?.netWorth || 0);
  const CAPS = portfolioCaps(settings);
  FREEZE = portfolioFreeze(rows, regionMap, eqV, netWorth, CAPS);

  // 資金加權年化報酬（XIRR）——資料齊了在此同步計算，直接嵌進模板
  const xr = portfolioXirr(psnaps, totalCost, total, ibTrades, fx.USD, parseLocalDate, settings);

  view().innerHTML = `
    <div class="page-head">
      <div><h1>投資組合</h1><p>核心–衛星架構：掌握配置、留意風險、等待機會。</p></div>
      <div class="page-actions">
        <span class="muted" style="font-size:12px">計價
          <span class="fee-tog ${viewCur === 'TWD' ? 'on' : ''}" data-cur="TWD">NT</span><span class="muted">/</span><span class="fee-tog ${viewCur === 'USD' ? 'on' : ''}" data-cur="USD">US</span>
        </span>
        <button class="btn-ghost icon-btn" id="printPortfolio" title="列印 / 匯出 PDF（依目前計價輸出）" aria-label="列印 / 匯出 PDF">${icon('print', 16)}</button>
        <button class="btn-ghost" id="ibSync" title="從 IBKR Flex Query 同步持倉與現金（唯讀）">${icon('download', 16)}IBKR 同步</button>
        <button class="btn-ghost" id="refreshQuotes">${icon('refresh', 16)}更新報價</button>
        <button class="btn" id="addHolding">${icon('plus', 16)}新增持股</button>
      </div>
    </div>

    <div class="cards">
      <div class="card"><h3><button type="button" class="info-link" id="totalValueInfo">總市值</button></h3><div class="stat sm">${MONEY(total)}</div><div class="stat-sub"><button type="button" class="info-link" id="totalCostInfo">成本</button> ${MONEY(totalCost)}｜<span class="${totalPnl >= 0 ? 'pos' : 'neg'}" style="font-weight:700">未實現損益 ${totalPnl >= 0 ? '+' : ''}${MONEY(totalPnl)}</span></div></div>
      <div class="card"><h3><button type="button" class="info-link" id="assetStockInfo">股票</button> / <button type="button" class="info-link" id="assetBondInfo">債券</button> / <button type="button" class="info-link" id="assetCashInfo">現金</button> / <button type="button" class="info-link" id="assetGoldInfo">黃金</button></h3><div class="stat sm">${shr(eqV)} / ${shr(bondV)} / ${shr(cashV)} / ${shr(goldAll)}</div>
        <div class="stat-sub">含黃金存摺與現金</div>
        <div class="split-bar"><div style="width:${allBase ? eqV / allBase * 100 : 0}%;background:${CHART.blue}"></div><div style="width:${allBase ? bondV / allBase * 100 : 0}%;background:${CHART.green}"></div><div style="width:${allBase ? cashV / allBase * 100 : 0}%;background:${CHART.gray}"></div><div style="flex:1;background:${CHART.brown}"></div></div></div>
      <div class="card"><h3>IB 融資槓桿</h3><div class="stat sm ${leverage > CAPS.lev ? 'neg' : ''}">${isFinite(leverage) ? leverage.toFixed(2) + ' 倍' : '⚠️ 淨值已為負'}</div>
        <div class="stat-sub">IB 淨值 ${MONEY(netEquity)}｜<span class="neg" style="font-weight:700">IB 融資 ${MONEY(loanTwd)}</span></div>
        <div class="mini-bar"><div style="width:${Math.min((leverage - 1) * 100, 100)}%;background:${leverage > CAPS.lev + 0.15 ? CHART.red : leverage > CAPS.lev ? CHART.orange : CHART.green}"></div></div></div>
    </div>

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

    <div class="chart-card" style="margin-bottom:16px" id="signalsCard">
      <h3><button type="button" class="info-link" id="signalsInfo">估值訊號儀表</button> <span class="stat-sub" style="font-weight:400;margin:0">（五市場檔位 → 動態股債比；每月檢視）</span>
        <button class="btn-link btn-sm" id="signalsEdit" style="float:right">更新區域數值</button></h3>
      <div id="signalsBody"><p class="muted small" style="margin-top:8px">讀取中…</p></div>
    </div>

    <div class="chart-card" style="margin-bottom:16px" id="capeCard">
      <h3>Shiller PE（CAPE）估值儀表 <span class="stat-sub" style="font-weight:400;margin:0">（CSPX ⇄ QQQM 輪動的紀律閘門）</span></h3>
      <div id="capeBody"><p class="muted small" style="margin-top:8px">讀取中…</p></div>
    </div>

    <div class="chart-card" style="margin-bottom:16px">
      <h3><button type="button" class="info-link" id="xirrInfo">投入 vs 市值</button> <span class="stat-sub" style="font-weight:400;margin:0">（每月快照，按左下「記錄本月快照」累積）</span>
        <span style="float:right;font-size:13px">${xr.ok
          ? `年化報酬（XIRR）<b class="${(xr.rate ?? 0) >= 0 ? 'pos' : 'neg'}">${(xr.rate ?? 0) >= 0 ? '+' : ''}${(xr.rate ?? 0).toFixed(1)}%</b>${(xr.years ?? 0) < 1 ? ' <span class="muted small">未滿 1 年僅供參考</span>' : ''}${xr.estimated ? ' <span class="muted small">含匯率估算</span>' : ''}`
          : `<span class="muted small">XIRR：${xr.why}</span>`}</span></h3>
      <div class="chart-box" style="height:240px"><canvas id="investChart"></canvas></div>
      <p class="muted small" style="margin-top:8px">兩線的差距＝未實現損益。市值線的波動是市場的事；投入線持續墊高，才是你能控制的事。年化報酬（XIRR）按你每筆投入的時間點計算，點標題看說明。</p>
    </div>

    <div class="section-title">個股研究卡</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr));margin-bottom:8px">
      ${rows.filter(r => r.layer === 'stock').map(r => researchCard(r, research)).join('') || '<div class="empty">尚無個股研究卡——把持股的「層」設為「個股」即可出現。</div>'}
    </div>
  `;

  // ---- handlers ----
  byId('addHolding').onclick = () => openHoldingForm(null);
  byId('refreshQuotes').onclick = (e) => refreshQuotes(e.currentTarget, holdings, watchlist, settings);   // currentTarget＝按鈕本身（e.target 可能是內層圖示，disabled 會設錯對象，自主體檢）
  byId('printPortfolio').onclick = () => printPortfolioReport({
    rows, accounts, fx, settings, ibTrades, total, totalCost, totalPnl,
    layerV, regionMap, eqV, bondV, goldAll,
    loanTwd, netEquity, leverage
  });
  byId('ibSync').onclick = async (/** @type {any} */ e) => {
    const seqAtStart = currentRouteSeq();
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'IBKR 同步中…（最多約 15 秒）';
    try {
      const r = await api('/ib/sync', { method: 'POST' });
      const cashTxt = r.cash && Object.keys(r.cash).length
        ? '；現金 ' + Object.entries(r.cash).map(([c, v]) => moneyCur(v, c)).join('、') : '';
      toast(`IBKR 同步完成：更新 ${r.updated} 檔、新增 ${r.created} 檔${cashTxt}`);
      // 未支援幣別被跳過（系統僅支援 TWD/USD/GBP/JPY）→ 明確告知，不默默吞掉（看得見的退化）
      if (r.skippedCurrencies && r.skippedCurrencies.length) {
        toast(`注意：這些項目因幣別尚未支援而跳過：${r.skippedCurrencies.join('、')}`, true);
      }
      // 現金資料異常（Codex r5#7）：後端保留舊值/歸零時本來只寫 server console，前端卻無條件
      // 報「同步完成」＝使用者不知道淨值裡的 IB 現金可能是過期的。三種情況都要說出來：
      if (r.cashReportMissing) {
        toast('注意：這份報表沒有 Cash Report 區塊——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 確認 Flex Query 有勾 Cash Report。', true);
      }
      if (r.cashDetailMissing) {
        toast('注意：Cash Report 只有彙總列、且無法判定基準幣別——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 的 Flex Query 勾選 Account Information。', true);
      }
      if (r.cashFromSummary) {
        toast('說明：這份報表的現金只有彙總列——已用基準幣別總額入帳' + (r.cashCollapsed ? `（${r.cashCollapsed} 個其他幣別帳戶已併入彙總顯示）` : '') + '。');
      }
      if (r.cashBaseUnsupported) {
        toast(`注意：報表現金只有彙總列、且基準幣別 ${r.cashBaseUnsupported} 尚未支援——IB 現金沿用上次的舊值（可能過期）。`, true);
      }
      if (r.cashDetailIncomplete) {
        toast('注意：部分幣別的現金金額讀不到——讀得到的已更新，讀不到的沿用舊值（不歸零）。請到 IBKR 確認 Cash Report 有勾 Ending Cash。', true);
      }
      if (r.cashSummaryMissing) {
        toast('注意：報表現金只有彙總列、且彙總列沒有可用金額——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 確認 Cash Report 有勾 Ending Cash。', true);
      }
      if (r.cashZeroed) {
        toast(`提醒：${r.cashZeroed} 個 IB 現金帳戶這次報表已無該幣別，餘額已歸零（現金提領/轉走後的正常結果）。`);
      }
      // IBKR 報表中已消失的持股（可能已出清）→ 確認後移除
      if (r.missing && r.missing.length) {
        const names = r.missing.map(m => m.symbol).join('、');
        if (confirm(`這些持股在 IBKR 報表中已找不到（可能已出清）：\n\n${names}\n\n要從投資組合移除嗎？`)) {
          for (const m of r.missing) await api('/holdings/' + m.id, { method: 'DELETE' });
          toast(`已移除 ${r.missing.length} 檔已出清持股`);
        }
      }
      if (seqAtStart === currentRouteSeq()) renderPortfolio();   // 同步期間可能切走了頁（自主體檢）
    } catch (err) {
      toast('IBKR 同步失敗：' + err.message, true);
      btn.disabled = false; btn.innerHTML = icon('download', 16) + 'IBKR 同步';
    }
  };
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
  // ⏸ 休眠中：#fxBandEdit 只有在 fxGaugeSection（目前停放、未插入頁面）渲染時才存在；
  //   等匯率儀表決定放回頁面時，這段與 openFxBands() 一起恢復作用。
  //   註：fxHigh/fxLow 的「調整入口」現已改由設定頁「提醒門檻」管理（換匯提醒即時生效），
  //   停放的 openFxBands 若日後恢復，屬儀表上的便捷入口、非唯一調整途徑。
  const fxEdit = byId('fxBandEdit');
  if (fxEdit) fxEdit.onclick = () => openFxBands(settings);
  view().querySelectorAll('.info-link[data-info]').forEach(b => b.onclick = () => {
    const info = INCOME_INFO[b.dataset.info];
    if (info) openInfo(info[0], info[1]);
  });
  const tradesFullBtn = byId('tradesFull');
  if (tradesFullBtn) tradesFullBtn.onclick = () => openInfo('完整交易明細', tradesModalHtml(ibTrades, { escapeHtml: esc }), { size: 'xl' });
  const totalValueInfo = byId('totalValueInfo');
  if (totalValueInfo) totalValueInfo.onclick = () => openInfo('總市值', `
    <p><b>總市值 ＝ 股票市值 + 債券市值 + 黃金市值</b></p>
    <p style="font-family:var(--serif);font-size:20px;margin-top:10px">${MONEY(total)} ＝ 股票 ${MONEY(eqV)} + 債券 ${MONEY(bondV)} + 黃金 ${MONEY(goldV)}</p>
    <p class="muted small" style="margin-top:10px">這裡只計算投資持股市值，不包含現金，也不扣除融資。</p>
  `, { size: 'md' });
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
  if (dInfo) dInfo.onclick = () => openInfo('紀律檢查', `
    <p><b>口徑</b>：所有上限以「<b>% 淨資產</b>」衡量（不是投組市值——有融資時淨資產較小，規則自動更嚴格）。國家曝險採<b>穿透</b>計算：ETF 內含成分（如 EIMI 裡的中國、台灣）都拆進對應國家一起計。</p>
    <p><b>軟上限</b>：超標＝<b>凍結加碼</b>（禁止再買進），但不強制賣出，讓部位隨時間自然稀釋。在「編輯持股」把凍結中的標的加碼時，會跳出確認提醒。</p>
    <p><b>怎麼看圖</b>：黑色刻度＝上限位置；長條＝目前部位，<span style="color:var(--pos)">綠色</span>＝上限內、<span style="color:var(--neg)">紅色</span>＝超出上限的部分。</p>
    <p><b>目前上限</b>：單一個股 ${CAPS.stock}%・股票總曝險 ${CAPS.equity}%・單一國家 ${CAPS.country}%（中國 ${CAPS.china}%）・IB 融資槓桿 ${CAPS.lev}x（<b>任何時期適用</b>；估值訊號期加碼只用新資金與現金，不舉新債）。到「設定 → 投資原則」即可調整。</p>
    <p><b>斷頭距離</b>：市場跌時借款不會跟著縮水，跌到「淨值 ÷ 持倉」低於 IB 維持保證金率（${CAPS.maint}%，設定頁可調）的那一刻，IB 會<b>即時自動強制平倉，不打電話、無寬限期</b>。這個數字＝從現在起市場還能跌多少。它是假設全部持倉維持率一致的近似值；IB 在危機時會調高維持率（2020 年 3 月發生過），所以旁邊附了壓力情境。最高指導原則：<b>要一個在所有環境都活著的系統，而不是在多數環境賺更多的系統</b>。</p>`);
  view().querySelectorAll('[data-edit-h]').forEach(b => b.onclick = () => openHoldingForm(holdings.find(h => h.id === b.dataset.editH)));
  view().querySelectorAll('[data-del-h]').forEach(b => b.onclick = () => {
    const h = holdings.find(x => x.id === b.dataset.delH);
    confirmDelete(h.symbol, () => api('/holdings/' + h.id, { method: 'DELETE' }));
  });
  const addW = byId('addWatch');
  if (addW) addW.onclick = () => openWatchForm(null);
  view().querySelectorAll('[data-edit-w]').forEach(b => b.onclick = () => openWatchForm(watchlist.find(w => w.id === b.dataset.editW)));
  view().querySelectorAll('[data-del-w]').forEach(b => b.onclick = () => {
    const w = watchlist.find(x => x.id === b.dataset.delW);
    confirmDelete(w.symbol, () => api('/watchlist/' + w.id, { method: 'DELETE' }));
  });
  view().querySelectorAll('[data-edit-r]').forEach(b => b.onclick = () => openResearchForm(b.dataset.editR, research));
  view().querySelectorAll('[data-add-cp]').forEach(b => b.onclick = () => addCheckpoint(b.dataset.addCp, research));

  drawInvestChart(psnaps, totalCost, total);
  loadCape(settings, qqqmShare, qqqmMax);
  loadSignals(settings);
  const sInfo = byId('signalsInfo');
  if (sInfo) sInfo.onclick = () => openInfo('估值訊號儀表', SIGNALS_INFO_HTML, { size: 'md' });
  const sEdit = byId('signalsEdit');
  if (sEdit) sEdit.onclick = () => openSignalsForm(settings);
}

// ---- 美元/台幣匯率儀表（暫時從頁面移除，之後再決定位置；要放回頁面時把 ${fxGaugeSection(fx, settings)} 插進 render 即可）----
// eslint-disable-next-line no-unused-vars -- 刻意停放（見上行註解），要恢復時插回 render 即可
function fxGaugeSection(fx, settings) {
  const lo = Number(settings.fxLow || 28), hi = Number(settings.fxHigh || 32);
  const MIN = 26, MAX = 34;
  const rate = fx.USD;
  const marker = Math.min(Math.max(rate, MIN), MAX);
  const seg = (a, b) => ((b - a) / (MAX - MIN) * 100).toFixed(1);
  const pos = (x) => ((x - MIN) / (MAX - MIN) * 100).toFixed(1);   // 匯率值 → 軸上百分比位置
  return `<div class="chart-card" style="margin-bottom:16px">
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
      <span class="muted" style="font-size:12.5px">美元／台幣</span>
      <span class="stat sm">${rate.toFixed(2)}</span>
      <button class="btn-link btn-sm" id="fxBandEdit">區間調整</button>
    </div>
    <div class="gauge-wrap">
      <div class="gauge">
        <div style="width:${seg(MIN, lo)}%;background:${CHART.blue};opacity:.55"></div>
        <div style="width:${seg(lo, hi)}%;background:#bdb8ab;opacity:.55"></div>
        <div style="width:${seg(hi, MAX)}%;background:${CHART.green};opacity:.55"></div>
        <div class="gauge-marker" style="left:${((marker - MIN) / (MAX - MIN) * 100).toFixed(1)}%"></div>
      </div>
      <div class="fx-scale">
        <span class="fx-num fx-end-l">${MIN}</span>
        <span class="fx-num" style="left:${pos(lo)}%">${lo}</span>
        <span class="fx-num" style="left:${pos(hi)}%">${hi}</span>
        <span class="fx-num fx-end-r">${MAX}</span>
        <span class="fx-zone" style="left:${pos((MIN + lo) / 2)}%">（換美元區）</span>
        <span class="fx-zone" style="left:${pos((hi + MAX) / 2)}%">（換台幣區）</span>
      </div>
    </div>
  </div>`;
}

// ⏸ 休眠中：只被停放的 fxGaugeSection 的「區間調整」鈕呼叫；隨儀表一起恢復。
function openFxBands(settings) {
  openForm({
    title: '調整換匯分批區間',
    fields: [
      { key: 'fxLow', label: '低於此值＝台幣→美元 分批區', type: 'number', required: true, step: '0.1' },
      { key: 'fxHigh', label: '高於此值＝美元→台幣 分批區', type: 'number', required: true, step: '0.1' }
    ],
    values: { fxLow: settings.fxLow || 28, fxHigh: settings.fxHigh || 32 },
    onSubmit: async (data) => {
      await api('/settings', { method: 'PUT', body: { fxLow: Number(data.fxLow), fxHigh: Number(data.fxHigh) } });
      toast('已更新換匯區間'); renderPortfolio();
    }
  });
}

async function loadSignals(settings) {
  const body = byId('signalsBody');
  if (!body) return;
  let cape = null, ry = null;
  try { [cape, ry] = await Promise.all([api('/cape'), api('/realyield')]); } catch {}
  body.innerHTML = signalsBodyHtml(settings, cape, ry, { escapeHtml: esc });
}

function openSignalsForm(settings) {
  const sig = settings.signals || {};
  openForm({
    title: '更新估值訊號（區域市場，每月一次）',
    size: 'md',
    fields: [
      { key: 'china', label: '中股 滬深300 本益比', type: 'number', step: '0.1', placeholder: '例：12.3' },
      { key: 'japan', label: '日股 整體 P/B', type: 'number', step: '0.01', placeholder: '例：1.25' },
      { key: 'korea', label: '韓股 KOSPI P/B', type: 'number', step: '0.01', placeholder: '例：0.95' },
      { key: 'taiwanPE', label: '台股 大盤本益比', type: 'number', step: '0.1', placeholder: '例：17.5' },
      { key: 'taiwanYield', label: '台股 大盤殖利率（%）', type: 'number', step: '0.1', placeholder: '例：3.2' },
      { key: 'realYieldManual', label: '美10年實質利率手動值（%，FRED 失敗時才需填）', type: 'number', step: '0.01', full: true }
    ],
    values: sig,
    onSubmit: async (data) => {
      await api('/settings', { method: 'PUT', body: { signals: { ...sig, ...data } } });
      toast('估值訊號已更新'); renderPortfolio();
    }
  });
}

// ---- ③ CAPE 儀表 ----
async function loadCape(settings, qqqmShare, qqqmMax) {
  let cape = null;
  try { cape = await api('/cape'); } catch {}
  const body = byId('capeBody');
  if (!body) return;
  body.innerHTML = capeBodyHtml(cape, qqqmShare, qqqmMax, { escapeHtml: esc, formatPercent: fmtPct });
  const b = byId('capeManualBtn');
  if (b) b.onclick = () => openCapeManual(settings);
}

function openCapeManual(settings) {
  openForm({
    title: '手動設定 Shiller PE',
    fields: [{ key: 'capeManual', label: '目前 CAPE 值（multpl.com 可查）', type: 'number', required: true }],
    values: { capeManual: settings.capeManual || '' },
    onSubmit: async (data) => {
      await api('/settings', { method: 'PUT', body: { capeManual: data.capeManual } });
      toast('已更新 CAPE 手動值'); renderPortfolio();
    }
  });
}

// ---- 資金加權年化報酬（XIRR）----
// 現金流（台幣）：期初＝第一筆快照市值流出、每月＝快照投入增量流出、
// IB 賣出已實現損益逐筆按成交日流入（pnlBase USD × 今日匯率）、期末＝今日市值流入。
// 不含股息利息（略低估）；台股手動賣出的已實現損益無紀錄、未納入。
const XIRR_INFO_HTML = `
  <p><b>XIRR（資金加權年化報酬）</b>：把每一筆投入與拿回的錢、連同發生的時間點一起解出的年化報酬率——「你的錢實際上長多快」。與只看漲跌幅的報酬率不同，它會反映你進出場時點的效果：同樣的市場，早投入多投入的人 XIRR 較高。</p>
  <p><b>資料來源</b>：每月「記錄本月快照」的投入增量＝流出；IB 賣出的已實現損益逐筆按成交日計入；今日市值＝期末流入。口徑為台幣。</p>
  <p class="muted">限制：不含股息與利息（結果略為低估）；台股手動賣出的已實現損益未納入；快照為月頻、時點以月底近似；IB 交易紀錄僅涵蓋同步期間。外幣賣出缺 IBKR 匯率時以設定匯率估算（標示「含匯率估算」）。歷史未滿 1 年時，年化會放大短期波動，僅供參考。</p>`;

// ---- ⑥ 投入 vs 市值 ----
function drawInvestChart(psnaps, curCost, curValue) {
  const ctx = byId('investChart');
  if (!ctx) return;
  const conv = (twd) => viewCur === 'USD' ? Math.round(twd / usdRate) : Math.round(twd);
  const labels = [...psnaps.map(s => s.month), '本月（現在）'];
  const costs = [...psnaps.map(s => conv(s.cost)), conv(curCost)];
  const values = [...psnaps.map(s => conv(s.value)), conv(curValue)];
  const yTick = (v) => viewCur === 'USD' ? (v / 1000).toFixed(0) + ' K' : (v / 10000).toFixed(0) + ' 萬';
  const tipVal = (v) => viewCur === 'USD' ? kNum(v) + ' K USD' : wanNum(v) + ' 萬';
  lineChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: '投入成本', data: costs, borderColor: AXIS, backgroundColor: AXIS, borderDash: [5, 4], borderWidth: 2, pointRadius: 3, fill: false, tension: .25 },
      { label: '市值', data: values, borderColor: ACCENT, backgroundColor: ACCENT_SOFT, borderWidth: 2, pointRadius: 3, fill: true, tension: .25 }
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { color: AXIS, boxWidth: 14, padding: 12 } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${tipVal(c.parsed.y)}` } } },
      scales: { x: { ticks: { color: AXIS }, grid: { color: GRID } },
        y: { ticks: { color: AXIS, callback: yTick }, grid: { color: GRID } } } }
  });
}

// ---- ⑤ 研究卡 ----
function researchCard(holding, research) {
  const r = research.find(x => (x.symbol || '').toUpperCase() === (holding.symbol || '').toUpperCase());
  const cps = (r?.checkpoints || []).slice().reverse().slice(0, 4);
  const block = (title, txt) => txt ? `<div class="rc-block"><b>${title}</b>${esc(txt)}</div>` : '';
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <div class="item-title">${esc(holding.symbol)} <span class="muted" style="font-weight:400;font-size:12px">${esc(holding.name || '')}</span></div>
      <span class="tag ${holding.pnlTwd >= 0 ? 'green' : 'amber'}">${holding.pnlTwd >= 0 ? '+' : ''}${fmtPct(holding.costTwd ? holding.pnlTwd / holding.costTwd * 100 : 0)}</span>
    </div>
    <div style="margin-top:11px;display:flex;flex-direction:column;gap:8px;font-size:12.5px">
      ${block('投資論點：', r?.thesis) || '<div class="rc-block muted">還沒寫投資論點——寫下「為什麼買」，之後漲跌都能對照檢驗。</div>'}
      ${block('關鍵指標：', r?.metrics)}
      ${block('風險：', r?.risks)}
    </div>
    ${cps.length ? `<div style="margin-top:10px"><b style="font-size:12px">檢查點</b>
      <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">
        ${cps.map(c => `<div class="muted" style="font-size:12px"><span style="color:var(--text)">${esc(c.date)}</span>　${esc(c.note)}</div>`).join('')}
      </div></div>` : ''}
    <div style="display:flex;gap:6px;margin-top:12px;align-items:center">
      <input type="text" id="cp_${esc(holding.symbol)}" placeholder="新增檢查點筆記…" style="flex:1;font-size:12px;padding:6px 9px">
      <button class="btn-ghost btn-sm" data-add-cp="${esc(holding.symbol)}">記一筆</button>
      <button class="btn-link btn-sm" data-edit-r="${esc(holding.symbol)}" title="編輯研究卡">${icon('edit', 15)}</button>
    </div>
  </div>`;
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
  const r = research.find(x => (x.symbol || '').toUpperCase() === symbol.toUpperCase());
  openForm({
    title: `${symbol} 研究卡`,
    fields: [
      { key: 'thesis', label: '投資論點（為什麼買？想驗證什麼？）', type: 'textarea', full: true },
      { key: 'metrics', label: '關鍵指標（每季對照）', type: 'textarea', full: true },
      { key: 'risks', label: '風險清單', type: 'textarea', full: true }
    ],
    values: r || {},
    onSubmit: async (data) => {
      if (r) await api('/research/' + r.id, { method: 'PUT', body: data });
      else await api('/research', { method: 'POST', body: { symbol, ...data, checkpoints: [] } });
      toast('已儲存'); renderPortfolio();
    }
  });
}

// ---- 表單：持股 / 願望清單 ----
function openHoldingForm(h) {
  openForm({
    title: h ? '編輯持股' : '新增持股',
    fields: [
      { key: 'symbol', label: '代號', type: 'text', required: true, placeholder: '例：CSPX' },
      { key: 'name', label: '說明（一眼看懂持有什麼）', type: 'text', placeholder: '例：美國指數' },
      { key: 'layer', label: '層（核心–衛星）', type: 'select', options: LAYER_ORDER.map(k => ({ value: k, label: LAYERS[k].label })) },
      { key: 'currency', label: '計價幣別', type: 'select', options: CURRENCIES },
      { key: 'quantity', label: '股數', type: 'number', required: true },
      { key: 'avgCost', label: '購買均價（原幣，自動算投入成本）', type: 'number', step: '0.01' },
      { key: 'price', label: '現價（原幣）', type: 'number', required: true, step: '0.01' },
      { key: 'quoteSymbol', label: 'Yahoo 報價代號（留空＝手動報價）', type: 'text', placeholder: '例：CSPX.L、00719B.TWO、QQQM' }
    ],
    values: h ? { ...h, avgCost: h.avgCost != null ? Math.round(Number(h.avgCost) * 100) / 100 : (Number(h.quantity) ? Math.round(Number(h.cost || 0) / Number(h.quantity) * 100) / 100 : '') } : { currency: 'USD', layer: 'core' },
    onSubmit: async (data) => {
      // 投資原則：凍結名單加碼警告（軟上限——確認後仍可儲存；減碼/改備註不受影響）
      const oldQty = h ? Number(h.quantity || 0) : 0;
      const newQty = Number(data.quantity || 0);
      if (newQty > oldQty) {
        const sym = String(data.symbol || '').toUpperCase().trim();
        const comp = compOf({ symbol: sym, layer: data.layer });
        const reasons = [];
        if (FREEZE.symbols.has(sym)) reasons.push('單一個股上限');
        for (const rg of Object.keys(comp.regions || {})) if (FREEZE.regions.has(rg)) reasons.push(`${rg}上限`);
        if (comp.type === 'equity' && FREEZE.equity) reasons.push('股票總曝險上限');
        if (reasons.length && !window.confirm(`⚠️ ${sym} 目前凍結加碼（超過：${reasons.join('、')}）。\n依投資原則不應加碼，確定仍要儲存？`)) {
          throw new Error('已取消：該標的凍結加碼中');
        }
      }
      data.avgCost = Math.round(Number(data.avgCost || 0) * 100) / 100;   // 均價統一兩位小數
      data.price = Math.round(Number(data.price || 0) * 100) / 100;
      data.cost = Math.round((data.avgCost * Number(data.quantity || 0)) * 100) / 100;  // 投入成本＝均價×股數
      if (h) await api('/holdings/' + h.id, { method: 'PUT', body: data });
      else await api('/holdings', { method: 'POST', body: data });
      toast('已儲存'); renderPortfolio();
    }
  });
}

function openWatchForm(w) {
  openForm({
    title: w ? '編輯願望清單' : '新增願望清單',
    fields: [
      { key: 'symbol', label: '代號', type: 'text', required: true },
      { key: 'name', label: '說明', type: 'text', placeholder: '例：中國網路' },
      { key: 'targetPrice', label: '目標買價（原幣）', type: 'number', required: true, step: '0.01' },
      { key: 'currency', label: '幣別', type: 'select', options: CURRENCIES },
      { key: 'quoteSymbol', label: 'Yahoo 報價代號', type: 'text', placeholder: '例：KWEB、ICHN.L' },
      { key: 'note', label: '備註（為什麼等這個價位）', type: 'text', full: true }
    ],
    values: w || { currency: 'USD' },
    onSubmit: async (data) => {
      if (w) await api('/watchlist/' + w.id, { method: 'PUT', body: data });
      else await api('/watchlist', { method: 'POST', body: data });
      toast('已儲存'); renderPortfolio();
    }
  });
}

// ---- 更新報價（持股＋願望清單共用）----
async function refreshQuotes(btn, holdings, watchlist, settings) {
  const seqAtStart = currentRouteSeq();
  const FX_SYMS = { 'TWD=X': 'USD', 'GBPTWD=X': 'GBP', 'JPYTWD=X': 'JPY' };   // Yahoo 匯率代號 → 幣別
  const syms = [...new Set([
    ...holdings.map(h => h.quoteSymbol).filter(Boolean),
    ...watchlist.map(w => w.quoteSymbol).filter(Boolean),
    ...Object.keys(FX_SYMS)
  ])];
  if (!syms.length) return toast('沒有可更新的報價代號', true);
  btn.disabled = true; btn.textContent = '更新中…';
  try {
    const quotes = await api('/quotes?symbols=' + encodeURIComponent(syms.join(',')));
    // 匯率自動更新（美元/英鎊/日幣 兌台幣）
    const fxBody = {};
    if (quotes['TWD=X']?.price) fxBody.usdTwd = Math.round(quotes['TWD=X'].price * 1000) / 1000;
    const fxTwd = { ...(settings.fxTwd || {}) };
    if (quotes['GBPTWD=X']?.price) fxTwd.GBP = Math.round(quotes['GBPTWD=X'].price * 1000) / 1000;
    if (quotes['JPYTWD=X']?.price) fxTwd.JPY = Math.round(quotes['JPYTWD=X'].price * 10000) / 10000;
    fxBody.fxTwd = fxTwd;
    if (fxBody.usdTwd || quotes['GBPTWD=X'] || quotes['JPYTWD=X']) await api('/settings', { method: 'PUT', body: fxBody });
    let ok = 0, skip = 0;
    for (const h of holdings) {
      const q = h.quoteSymbol && quotes[h.quoteSymbol];
      if (!q || q.price == null) { if (h.quoteSymbol) skip++; continue; }
      // 防呆：報價幣別與持股幣別不符（例如 GBp）就跳過。缺幣別預設 TWD（Codex r10#8，與估值端 h.currency||'TWD'
      // 同口徑）——原本這裡預設 USD，害缺幣別的台股收到 Yahoo 的 TWD 報價被誤判「幣別不符」而不更新。
      if (q.currency && q.currency.toUpperCase() !== (h.currency || 'TWD').toUpperCase()) { skip++; continue; }
      await api('/holdings/' + h.id, { method: 'PUT', body: { price: Math.round(q.price * 100) / 100 } });
      ok++;
    }
    for (const w of watchlist) {
      const q = w.quoteSymbol && quotes[w.quoteSymbol];
      if (!q || q.price == null) continue;
      await api('/watchlist/' + w.id, { method: 'PUT', body: { lastPrice: Math.round(q.price * 100) / 100, lastAt: todayStr() } });
    }
    toast(`已更新 ${ok} 檔報價與匯率${skip ? `，${skip} 檔略過（無資料或幣別不符）` : ''}`);
    if (seqAtStart === currentRouteSeq()) renderPortfolio();   // 更新期間可能切走了頁（自主體檢）
  } catch (e) {
    toast('更新失敗：' + e.message, true);
    btn.disabled = false; btn.innerHTML = icon('refresh', 16) + '更新報價';
  }
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
