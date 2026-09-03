// @ts-check
import { api, view, byId, wan, money, pct, esc, currentRouteSeq, openInfo, toast, bootSettled } from '../app.js';
import { CHART, PALETTE, AXIS, GRID, ACCENT, ACCENT_SOFT } from './theme.js';
import { icon } from './icons.js';
import { TIER_LABELS } from './signal-tiers.js';   // 估值檔位標籤（跳檔卡顯示「常態→加碼」用）
import { MONTHLY_REVIEW_INFO, monthlyReviewCardHtml, monthlyReviewChartConfig, unmatchedRefundInfoHtml, rewardInfoHtml } from './monthly-review-card.js';
import { GOAL_TRACKING_INFO, goalTrackingHtml } from './goal-tracking.js';
import { MISSING_FX_INFO_TITLE, MISSING_FX_INFO_HTML } from './portfolio-info.js';   // 缺匯率說明（乙）與投資頁共用同一份
import {
  dashboardCashflowSeries,
  dashboardGuideState,
  dashboardMonthLabel,
  dashboardNetWorthChange,
  dashboardSnapshotSeries,
} from './dashboard-forest.js';

let chartRefs = [];
let monthlyReviewChart = null;
let monthlyReviewRequest = 0;
function destroyCharts() { chartRefs.forEach(c => c.destroy()); chartRefs = []; monthlyReviewChart = null; }

// 每日洞察（D4）：**一次 app-open 只抓一次 /insights**，且**等開機序列（bootSettled：報價+快照）落定後才抓**。
// - 一次只抓：讀取＝更新書籤（看過了），開機重繪若每次重抓會把剛冒出的 🆕 秒吸收掉——快取整個 Promise，書籤只更新一次。
// - 等 boot 落定（Codex r14#1/#2）：①不擋總覽首屏——總覽用 /summary 即時出畫面，洞察慢慢補（不被外部估值 API 卡住）；
//   ②反映最新資料——在報價更新＋今天日線寫入之後才算差異，才不會「舊洞察＋新總覽」混用。抓失敗＝退回舊「需要處理」。
// 重新整理頁面（真正的「再次開啟」）＝模組重載→快取重置→重抓，語意正確。
let insightsPromise = null;
function fetchInsightsOnce() {
  if (!insightsPromise) insightsPromise = bootSettled.then(() => api('/insights')).catch(() => ({ error: true }));
  return insightsPromise;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** @param {any} change */
function netWorthChangeHtml(change) {
  if (change.status === 'missing-current') {
    return `<div class="forest-change waiting">尚待本月快照</div>
      <p>本月有快照後，才會與上月最後一次快照比較。</p>`;
  }
  if (change.status === 'missing-previous') {
    return `<div class="forest-change waiting">尚無上月基準</div>
      <p>已記下 ${esc(snapshotLabel(change.current, change.currentMonth))}；上個月沒有可比快照。</p>`;
  }
  const amount = Number(change.amount || 0);
  const direction = amount > 0 ? '增加' : amount < 0 ? '減少' : '持平';
  const cls = amount > 0 ? 'pos' : amount < 0 ? 'neg' : 'flat';
  const amountText = `${amount > 0 ? '+' : ''}${wan(amount)}`;
  const pctText = change.pct == null ? '' : `（${change.pct > 0 ? '+' : ''}${pct(change.pct)}）`;
  const previousLabel = snapshotLabel(change.previous, change.previousMonth);
  const note = change.status === 'zero-base'
    ? `${previousLabel}的淨資產為 0，百分比沒有可解讀的基準，因此只顯示金額。`
    : amount === 0 ? `與 ${previousLabel}相同。` : `相較 ${previousLabel}${direction} ${wan(Math.abs(amount))}。`;
  return `<div class="forest-change ${cls}">${amountText}<span>${pctText}</span></div><p>${esc(note)}</p>`;
}

/** @param {any} row @param {string} month */
function snapshotLabel(row, month) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || ''))
    ? `${row.date} 快照`
    : `${dashboardMonthLabel(month)}的快照`;
}

/** @param {any} change @param {string} month */
function netWorthChangeBasisText(change, month) {
  if (change.current && change.previous) {
    return `比較區間 ${snapshotLabel(change.previous, change.previousMonth)} → ${snapshotLabel(change.current, change.currentMonth)}；不等同投資報酬。`;
  }
  if (change.current) return `${snapshotLabel(change.current, change.currentMonth)}；上個月尚無快照基準，不等同投資報酬。`;
  return `${dashboardMonthLabel(month)}尚無快照；不等同投資報酬。`;
}

// 資產配置長條＋圖例（取代原本的甜甜圈；類別走 byClass，顏色固定對應）
const CLASS_COLOR = { 股票: CHART.blue, 債券: CHART.yellow, 現金: CHART.gray, 黃金: CHART.green };
function allocSection(byClass) {
  const entries = Object.entries(byClass || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p class="empty">尚無資產資料。</p>';
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const colorOf = (k, i) => (Object.hasOwn(CLASS_COLOR, k) && CLASS_COLOR[k]) || PALETTE[i % PALETTE.length];   // hasOwn（Codex r7#4）：自由輸入的資產類別撞原生屬性名會查到原型函式
  const bar = entries.map(([k, v], i) => `<i style="width:${(v / total * 100).toFixed(2)}%;background:${colorOf(k, i)}"></i>`).join('');
  const legend = entries.map(([k, v], i) => `<div class="dalloc-lg">
    <span class="dot" style="background:${colorOf(k, i)}"></span>${esc(k)}
    <span class="pc">${pct(v / total * 100)}</span><span class="amt">${wan(v)}</span></div>`).join('');
  return `<div class="dalloc-bar">${bar}</div><div class="dalloc-legend">${legend}</div>`;
}

// 提醒 → 「需要處理」清單（依嚴重度排序：高→中→訊）
const SEV = { danger: ['高', 'hi'], warn: ['中', 'mid'], info: ['訊', 'info'] };
const SEV_RANK = { danger: 0, warn: 1, info: 2 };
function actionList(reminders) {
  if (!reminders.length) return `<div class="dact-empty">${icon('check', 16)} 目前沒有需要處理的事項，財務狀況穩定。</div>`;
  const sorted = [...reminders].sort((a, b) => (SEV_RANK[a.level] ?? 3) - (SEV_RANK[b.level] ?? 3));
  return sorted.map(r => {
    const [lab, cls] = SEV[r.level] || ['訊', 'info'];
    return `<div class="dact ${cls}">
      <span class="dact-sev">${lab}</span>
      <div class="dact-body"><div class="dact-t">${esc(r.title)}</div><div class="dact-d">${esc(r.detail)}</div></div>
      <span class="dact-tag">${esc(r.module)}</span>
    </div>`;
  }).join('');
}

// ---- 每日洞察引擎（D4）：把 /api/insights 的差異渲染成「總覽新聞牆」 ----
const MARKET_NAMES = { us: '美股', china: '中股', japan: '日股', korea: '韓股', taiwan: '台股' };

/** Δ chip（百分比；null 不顯示）。淨值向上是好事用低調 up/down，不做盯盤式紅綠轟炸（呼應原則1解讀優先）。 */
function pctChip(label, p) {
  if (p == null || !isFinite(Number(p))) return '';
  const up = Number(p) >= 0;
  return `<span class="dh-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${label} ${up ? '+' : ''}${Number(p).toFixed(1)}%</span>`;
}
/** 自上次 Δ（金額 chip；0 或缺不顯示）。 */
function sinceChip(ins) {
  const v = ins && ins.sinceLast ? Number(ins.sinceLast.netWorth) : 0;
  if (!v || !isFinite(v)) return '';
  return `<span class="dh-delta ${v >= 0 ? 'up' : 'down'}">自上次 ${v >= 0 ? '+' : ''}${wan(v)}</span>`;
}
/** 上次開啟 N 天前（首次/無 prevSeenAt 不顯示）。 */
function lastSeenText(ins) {
  if (!ins || ins.firstRun || !ins.prevSeenAt) return '';
  const t = Date.parse(ins.prevSeenAt);
  if (!t) return '';
  const days = Math.max(0, Math.round((Date.now() - t) / 86400000));
  return days === 0 ? '上次開啟：今天' : `上次開啟：${days} 天前`;
}
/** 跳檔白話解釋（openInfo 內容）。 @param {string} market @param {number} from @param {number} to */
function tierExplainHtml(market, from, to) {
  const name = MARKET_NAMES[market] || market;
  const dir = to > from ? '更便宜了（估值下降＝往後預期報酬變高）' : '更貴了（估值上升＝往後預期報酬變低）';
  const zone = to === 2 ? '<b>重壓區</b>——但軟上限只放行新資金與現金、不舉新債（生存優先）'
    : to === 1 ? '<b>加碼區</b>——可依紀律把衛星部位往這裡傾斜'
      : '<b>常態區</b>——回到基準配置，不特別加減';
  return `<p>${name} 的估值檔位從「${TIER_LABELS[from] ?? from}」變成「${TIER_LABELS[to] ?? to}」。</p>
    <p>規則說：這代表 ${name} ${dir}，目前落在 ${zone}。</p>
    <p class="muted small">檔位是「指標換檔」不是憑感覺——門檻與五市場詳情見投資組合頁的估值訊號儀表。</p>`;
}

/**
 * 動態洞察區（新聞牆）：🆕 新出現 → ✓ 已解除（報喜）→ 跳檔卡 → 持續中（收合）。平靜日只剩一行。
 * 當前提醒清單以 **summary.reminders 為準**（永遠有、含 detail），用 insights 的 key 集合分「新/持續」；
 * insights 抓不到（degraded/error）就整段退回舊「需要處理」平清單（原則5，不擋畫面）。
 * @param {any} ins @param {any[]} summaryReminders @returns {string}
 */
function insightSection(ins, summaryReminders) {
  if (!ins || ins.error) {
    return `<div class="dash-h">需要處理 <span class="dash-ct">${summaryReminders.length}</span></div>
      <div class="dact-list">${actionList(summaryReminders)}</div>`;
  }
  const newKeys = new Set((ins.reminders?.new || []).map((/** @type {any} */ r) => r.key));
  const newR = summaryReminders.filter(r => newKeys.has(r.key));
  const ongoing = summaryReminders.filter(r => !newKeys.has(r.key));
  const cleared = ins.reminders?.cleared || [];
  const tiers = ins.tierChanges || [];
  const hasNews = newR.length || cleared.length || tiers.length;
  const ongoingBlock = ongoing.length
    ? `<details class="dins-ongoing"><summary>持續中 ${ongoing.length} 項</summary><div class="dact-list">${actionList(ongoing)}</div></details>`
    : '';

  if (ins.calm && !hasNews) {   // 平靜日：一行安心，持續中收合
    return `<div class="dash-h">今日洞察</div>
      <div class="dcalm">${icon('check', 16)} 今天市場平靜，一切正常 ✓</div>
      ${ongoingBlock}`;
  }
  const newHtml = newR.map(r => `<div class="dins-item new">🆕 <div class="dins-body"><div class="dins-t">${esc(r.title)}</div>${r.detail ? `<div class="dins-d">${esc(r.detail)}</div>` : ''}</div></div>`).join('');
  const clearedHtml = cleared.map((/** @type {any} */ r) => `<div class="dins-item cleared">✓ <div class="dins-body"><div class="dins-t">已解除：${esc(r.title)} 👍</div></div></div>`).join('');
  const tierHtml = tiers.map((/** @type {any} */ c, /** @type {number} */ i) => `<div class="dins-item tier">🔀 <div class="dins-body"><div class="dins-t">${MARKET_NAMES[c.market] || c.market} 估值 ${TIER_LABELS[c.from] ?? c.from} → ${TIER_LABELS[c.to] ?? c.to}</div></div><button class="dins-info info-link" data-tier="${i}">白話</button></div>`).join('');
  return `<div class="dash-h">${ins.firstRun ? '今日洞察' : '📬 自從你上次看'}</div>
    <div class="dins-list">${newHtml}${clearedHtml}${tierHtml}</div>
    ${ongoingBlock}`;
}

// 跳檔卡「白話」按鈕事件掛載（patch 進洞察區後重掛）。
function wireTierButtons(ins) {
  const tiers = (ins && ins.tierChanges) || [];
  view().querySelectorAll('.dins-info[data-tier]').forEach(b => {
    const el = /** @type {HTMLElement} */ (b);
    el.onclick = () => {
      const c = tiers[Number(el.dataset.tier)];
      if (c) openInfo(`${MARKET_NAMES[c.market] || c.market} 估值跳檔`, tierExplainHtml(c.market, c.from, c.to), { size: 'sm' });
    };
  });
}

// 洞察抓到後**就地補上**（不阻塞首屏）：hero Δ chips／上次開啟／投組自上次 Δ／動態三段。seq 過期＝已切頁，不動 DOM。
function patchInsights(ins, s, seq) {
  if (seq !== currentRouteSeq()) return;
  const deltas = byId('dhDeltas');
  if (deltas) deltas.innerHTML = pctChip('今天', ins?.windows?.today?.pct) + pctChip('本週', ins?.windows?.week?.pct) + sinceChip(ins);
  const last = byId('dhLastSeen'), lastSeen = lastSeenText(ins);
  if (last) last.innerHTML = lastSeen ? `<span class="dchip subtle">${lastSeen}</span>` : '';
  const pfDelta = ins && ins.sinceLast ? Number(ins.sinceLast.pfValue) : NaN;
  const kpiPf = byId('kpiPfDelta');
  if (kpiPf) kpiPf.innerHTML = (isFinite(pfDelta) && pfDelta) ? `・<span class="${pfDelta >= 0 ? 'pos' : 'neg'}">自上次 ${pfDelta >= 0 ? '+' : ''}${wan(pfDelta)}</span>` : '';
  const block = byId('insightBlock');
  if (block) { block.innerHTML = insightSection(ins, s.reminders); wireTierButtons(ins); }
}

function wireMonthlyReviewInfo(review) {
  const block = byId('monthlyReviewBlock');
  if (!block) return;
  block.querySelectorAll('[data-mr-info]').forEach(button => {
    const el = /** @type {HTMLElement} */ (button);
    el.onclick = () => {
      const key = String(el.dataset.mrInfo || '');
      const info = Object.hasOwn(MONTHLY_REVIEW_INFO, key) ? MONTHLY_REVIEW_INFO[key] : null;
      if (!info) return;
      const html = key === 'refund' ? unmatchedRefundInfoHtml(review, { esc, money })
        : key === 'cashback' ? rewardInfoHtml(review, { esc, money })
        : info.html;
      openInfo(info.title, html, { size: key === 'refund' ? 'md' : 'sm' });
    };
  });
}

function drawMonthlyReview(review, seq) {
  if (monthlyReviewChart) {
    monthlyReviewChart.destroy();
    chartRefs = chartRefs.filter(c => c !== monthlyReviewChart);
    monthlyReviewChart = null;
  }
  const ctx = byId('monthlyReviewChart');
  if (!ctx || !review?.months?.length) return;
  monthlyReviewChart = new Chart(ctx, monthlyReviewChartConfig(review, {
    money,
    onSelect: (month) => selectMonthlyReview(month, seq),
  }));
  chartRefs.push(monthlyReviewChart);
}

function renderMonthlyReview(review, seq) {
  if (seq !== currentRouteSeq()) return;
  const block = byId('monthlyReviewBlock');
  if (!block) return;
  block.removeAttribute('aria-busy');
  block.innerHTML = monthlyReviewCardHtml(review, { esc, money, wan, pct });
  wireMonthlyReviewInfo(review);
  drawMonthlyReview(review, seq);
}

async function selectMonthlyReview(month, seq) {
  const request = ++monthlyReviewRequest;
  const block = byId('monthlyReviewBlock');
  if (block) block.setAttribute('aria-busy', 'true');
  try {
    const review = await api(`/monthly-review?month=${encodeURIComponent(month)}`);
    if (seq !== currentRouteSeq() || request !== monthlyReviewRequest) return;
    renderMonthlyReview(review, seq);
  } catch {
    if (seq === currentRouteSeq() && request === monthlyReviewRequest) {
      if (block) block.removeAttribute('aria-busy');
      toast('月度回顧切換失敗，請稍後再試。', true);
    }
  }
}

export async function renderDashboard() {
  const seq = currentRouteSeq();
  ++monthlyReviewRequest;   // 讓上一代總覽仍在路上的月份切換結果失效。
  // /summary 與本機月度回顧並行；外部資料較慢的 /insights 仍在 bootSettled 後非阻塞補上。
  const [s, review] = await Promise.all([api('/summary'), api('/monthly-review').catch(() => null)]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別動 DOM/圖表（Codex r10#6：router 事後檢查太晚，寫入在 render 內部）
  destroyCharts();

  const cf = s.cashflow;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(cf?.month || '')) ? String(cf.month) : currentMonthKey();
  const snapshots = dashboardSnapshotSeries(s.snapshots, month);
  const cashflowRows = dashboardCashflowSeries(s.cashflowHistory, month);
  const netWorthChange = dashboardNetWorthChange(s.snapshots, month);
  const guide = dashboardGuideState(s.reminders);
  const goalHtml = goalTrackingHtml(s.goalTrack, { wan, pct });
  const cfSub = (cf.income || cf.expense) ? `收入 ${wan(cf.income)}・支出 ${wan(cf.expense)}` : '本月尚未記帳';
  const pnl = s.ib.totalPnl;
  const warnCount = s.reminders.filter(r => r.level === 'warn' || r.level === 'danger').length;

  // 融資槓桿 KPI（後端 summary 已提供 leverage / mcDist / hasLoan）
  const lev = s.ib || {};
  const levOver = s.reminders.some(r => r.title.includes('融資槓桿') && (r.level === 'warn' || r.level === 'danger'));
  let levVal, levSub, levCls = '';
  if (!lev.hasLoan) { levVal = '無融資'; levSub = '目前未使用槓桿'; }
  else if (lev.equityWiped || !Number.isFinite(Number(lev.leverage)) || lev.leverage == null) {
    levVal = '⚠️ 淨值為負'; levSub = '借款已超過持股市值，請立即確認 IBKR'; levCls = 'warn';
  } else {
    levVal = `${Number(lev.leverage).toFixed(2)}x`;
    levCls = levOver ? 'warn' : '';
    levSub = levOver ? '超過上限，停借新錢' : `斷頭距離約 ${Math.round(lev.mcDist)}%`;
  }

  view().innerHTML = `
    <section class="forest-overview" aria-label="理財中心總覽">
      <div class="forest-message-stage">
        <span class="forest-message-kicker">理財中心</span>
        <h1 id="forestDashboardTitle" aria-live="polite" aria-atomic="true">
          <span class="forest-quote-mark" aria-hidden="true">“</span>
          <span id="forestDashboardMessage">看清資產全貌，再決定今天要處理什麼。</span>
          <span class="forest-quote-mark" aria-hidden="true">”</span>
        </h1>
      </div>
      <div class="forest-scene-summary">
        <div class="forest-networth">
          <span>淨資產</span>
          <strong>${wan(s.netWorth)}</strong>
          <div class="dh-deltas" id="dhDeltas"></div>
        </div>
        <div class="forest-month-change">
          <span>本月淨資產變動</span>
          ${netWorthChangeHtml(netWorthChange)}
          <small>${esc(netWorthChangeBasisText(netWorthChange, month))}</small>
        </div>
        <div class="forest-balance-facts">
          <span>資產 <b>${wan(s.assets)}</b></span>
          <span>負債 <b>${wan(s.liabilities)}</b></span>
          <span class="${warnCount ? 'needs-attention' : 'steady'}">${warnCount ? `${warnCount} 項紀律需注意` : '目前紀律正常'}</span>
          ${missingFxFactHtml(s.missingFx)}
          <span id="dhLastSeen"></span>
        </div>
      </div>
    </section>

    ${goalHtml ? `<section class="dash-block forest-goal">${goalHtml}</section>` : ''}

    <div class="kpi-row">
      <div class="kpi"><div class="kpi-lab">本月現金流</div>
        <div class="kpi-v ${cf.net >= 0 ? 'pos' : 'neg'}">${cf.net >= 0 ? '+' : ''}${wan(cf.net)}</div>
        <div class="kpi-d">${cfSub}</div></div>
      <div class="kpi"><div class="kpi-lab">投資組合</div>
        <div class="kpi-v">${wan(s.ib.totalValue)}</div>
        <div class="kpi-d"><span class="${pnl >= 0 ? 'pos' : 'neg'}">未實現 ${pnl >= 0 ? '+' : ''}${wan(pnl)}</span>・${s.ib.count} 檔<span id="kpiPfDelta"></span></div></div>
      <div class="kpi"><div class="kpi-lab">融資槓桿</div>
        <div class="kpi-v ${levCls}">${levVal}</div>
        <div class="kpi-d ${levCls}">${levSub}</div></div>
      <div class="kpi"><div class="kpi-lab">每月固定訂閱</div>
        <div class="kpi-v">${wan(s.subscriptions.monthly)}</div>
        <div class="kpi-d">${s.subscriptions.count} 項・年化 ${wan(s.subscriptions.yearly)}</div></div>
    </div>

    <div class="forest-trends">
      <section class="dash-block forest-chart-panel">
        <div class="forest-panel-head"><div><span>資產軌跡</span><h2>近 12 月淨資產</h2></div><p>每月快照</p></div>
        <div class="forest-chart-box"><canvas id="trendChart" role="img" aria-label="近 12 月淨資產趨勢圖">近 12 月淨資產趨勢</canvas></div>
      </section>
      <section class="dash-block forest-chart-panel">
        <div class="forest-panel-head"><div><span>收支軌跡</span><h2>近 12 月收入、支出與淨現金流</h2></div><p>銀行收支帳本</p></div>
        <div class="forest-chart-box"><canvas id="cashflowTrendChart" role="img" aria-label="近 12 月收入支出與淨現金流趨勢圖">近 12 月收入支出與淨現金流趨勢</canvas></div>
      </section>
    </div>

    <div class="dash-two forest-insight-row">
      <section class="dash-block forest-guide-panel">
        <div class="forest-guide-intro">
          <img src="assets/guide-return-${guide.mood}.webp" alt="小森森嚮導">
          <div><span>小森森提醒</span><h2>${guide.title}</h2><p>${guide.detail}</p></div>
        </div>
        <div class="forest-insight-content" id="insightBlock">${insightSection(null, s.reminders)}</div>
      </section>
      <section class="dash-block forest-allocation-panel">
        <div class="dash-h">資產配置</div>
        <div class="dalloc-card">${allocSection(s.byClass)}</div>
      </section>
    </div>

    <div id="monthlyReviewBlock">${monthlyReviewCardHtml(review, { esc, money, wan, pct })}</div>
  `;

  drawTrend(snapshots);
  drawCashflowTrend(cashflowRows);
  wireGoalTrackingInfo();
  wireMissingFxInfo();
  wireMonthlyReviewInfo(review);
  drawMonthlyReview(review, seq);
  // 洞察在開機序列（報價+快照）落定後才抓、抓到就地補上 hero Δ／KPI Δ／動態三段（不阻塞首屏、反映最新資料）。
  fetchInsightsOnce().then(ins => patchInsights(ins, s, seq));
}

/** 缺匯率就地標註（乙）：外幣資產沒匯率＝不算進淨資產，要讓人一眼看到「少算了幾筆」與怎麼補。 @param {any} missingFx */
function missingFxFactHtml(missingFx) {
  if (!Array.isArray(missingFx) || !missingFx.length) return '';
  const n = missingFx.reduce((sum, m) => sum + Number(m?.count || 0), 0);
  const curs = missingFx.map(m => esc(String(m?.currency || ''))).join('、');
  return `<span class="needs-attention">${n} 筆外幣資產（${curs}）沒有匯率、未計入 <button type="button" class="info-link" id="missingFxInfo">為什麼？</button></span>`;
}

function wireMissingFxInfo() {
  const el = byId('missingFxInfo');
  if (el) el.onclick = () => openInfo(MISSING_FX_INFO_TITLE, MISSING_FX_INFO_HTML, { size: 'sm' });
}

function wireGoalTrackingInfo() {
  view().querySelectorAll('[data-goal-info]').forEach(button => {
    const el = /** @type {HTMLElement} */ (button);
    el.onclick = () => {
      const key = String(el.dataset.goalInfo || '');
      const info = Object.hasOwn(GOAL_TRACKING_INFO, key) ? GOAL_TRACKING_INFO[key] : null;
      if (info) openInfo(info.title, info.html, { size: 'sm' });
    };
  });
}

function drawTrend(snaps) {
  const ctx = byId('trendChart');
  const hasData = snaps.some(row => typeof row.netWorth === 'number' && Number.isFinite(row.netWorth));
  if (!ctx || !hasData) { if (ctx) ctx.parentElement.innerHTML = '<p class="empty">近 12 個月尚無淨資產快照；記錄後，這裡會顯示每月走勢。</p>'; return; }
  chartRefs.push(new Chart(ctx, {
    type: 'line',
    data: {
      labels: snaps.map(s => s.month),
      datasets: [{
        label: '淨資產', data: snaps.map(s => s.netWorth),
        borderColor: ACCENT, backgroundColor: ACCENT_SOFT,
        fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: ACCENT, spanGaps: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} ${wan(c.parsed.y)}` } } },
      scales: {
        x: { ticks: { color: AXIS, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } },
        y: { ticks: { color: AXIS, callback: (v) => (v / 10000).toFixed(0) + '萬' }, grid: { color: GRID } }
      },
      animation: { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280 }
    }
  }));
}

function drawCashflowTrend(rows) {
  const ctx = byId('cashflowTrendChart');
  const hasData = rows.some(row => typeof row.net === 'number' && Number.isFinite(row.net));
  if (!ctx || !hasData) {
    if (ctx) ctx.parentElement.innerHTML = '<p class="empty">近 12 個月尚無銀行收支紀錄；有資料後，這裡會顯示每月收入、支出與淨現金流。</p>';
    return;
  }
  chartRefs.push(new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(row => row.month),
      datasets: [
        { label: '收入', data: rows.map(row => row.income), borderColor: CHART.green, backgroundColor: CHART.green, tension: .28, pointRadius: 2, borderWidth: 2 },
        { label: '支出', data: rows.map(row => row.expense), borderColor: CHART.red, backgroundColor: CHART.red, tension: .28, pointRadius: 2, borderWidth: 2 },
        { label: '淨現金流', data: rows.map(row => row.net), borderColor: CHART.blue, backgroundColor: CHART.blue, tension: .28, pointRadius: 3, borderWidth: 2 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: AXIS, boxWidth: 9, boxHeight: 9, usePointStyle: true } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} ${money(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: AXIS, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } },
        y: { ticks: { color: AXIS, callback: (v) => (Number(v) / 10000).toFixed(0) + '萬' }, grid: { color: GRID } },
      },
      animation: { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280 }
    }
  }));
}
