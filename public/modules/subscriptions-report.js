// @ts-check
// 訂閱追蹤 A4 列印報表（系統優化階段二③，2026-07-24 從 subscriptions.js 搬出、搬家不裝修）：
// 只把已算好的資料組成 A4 HTML 交給 openPrintWindow——報表版面與金額公式是不同責任
//（前例＝portfolio-report.js 的角色）。攤提數學一律來自 subscriptions-model.js（零依賴純函式）；
// 時間相依/頁面共用件（subStatus、timelinePoints、cardLabel、fmtFee、分類常數）由 subscriptions.js 匯出。
// 循環 import 安全：本檔 ↔ subscriptions.js ↔ app.js 成環，所有 import 綁定一律只在函式內取用
//（勿在檔案頂層取用＝TDZ 陷阱，見 theme.js 註記；本檔頂層只有常數字面量與函式宣告）。
import { esc, todayStr, openPrintWindow } from '../app.js';
import { CHART } from './theme.js';
import {
  CYCLE_LABELS, isLifetimeSub, feeMonthVal, costForMonth, activeInMonth, amortizedForMonth, costDetailRows,
} from './subscriptions-model.js';
import { subStatus, timelinePoints, cardLabel, fmtFee, CATEGORIES, CAT_COLOR } from './subscriptions.js';

const STATUS_LABELS = { active: '使用中', ending: '即將停用', ended: '已停用' };

function reportTable(headers, rows, empty = '無資料') {
  const body = rows.length ? rows.map(row => `<tr>${row.map((cell, i) => `<td class="${i === row.length - 1 ? 'num' : ''}">${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted center">${esc(empty)}</td></tr>`;
  return `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}


function sortByMonthlyCost(rows) {
  return rows.slice().sort((a, b) => feeMonthVal(b) - feeMonthVal(a) || (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
}

function sortByStatusThenCost(rows) {
  const rank = { active: 0, ending: 1, ended: 2 };
  return rows.slice().sort((a, b) => (rank[subStatus(a)] ?? 9) - (rank[subStatus(b)] ?? 9)
    || feeMonthVal(b) - feeMonthVal(a)
    || (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
}

function reportCostTable(subs, mk, label) {
  const detail = costDetailRows(subs, mk);
  const rows = detail.map(r => [esc(r.service), esc(r.cycle), esc(r.formula), fmtFee(r.amount)]);
  const total = detail.reduce((sum, r) => sum + r.amount, 0);
  const body = rows.length ? rows.map(row => `<tr>${row.map((cell, i) => `<td class="${i === row.length - 1 ? 'num' : ''}">${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="4" class="muted center">這個月份沒有計入訂閱費用</td></tr>`;
  return `<section><h2>${esc(mk)} （${esc(label)}） <span>${fmtFee(total)}</span></h2>
    <table class="cost-calc-table">
      <colgroup><col class="service-col"><col class="cycle-col"><col class="formula-col"><col class="amount-col"></colgroup>
      <thead><tr><th>服務</th><th>週期</th><th>計算方式</th><th>計入金額</th></tr></thead>
      <tbody>${body}</tbody>
    </table></section>`;
}

function reportStatusTable(headers, rows, empty) {
  const body = rows.length ? rows.map(row => `<tr>${row.map((cell, i) => `<td class="${i >= 2 ? 'center' : ''}">${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted center">${esc(empty)}</td></tr>`;
  return `<table class="status-overview-table">
    <colgroup>
      <col class="status-service-col">
      <col class="status-meta-col">
      <col class="status-cycle-col">
      <col class="status-month-col">
      <col class="status-date-col">
    </colgroup>
    <thead><tr>${headers.map((h, i) => `<th class="${i >= 2 ? 'center' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function reportBreakdown(subs, mk) {
  const active = subs.filter(s => activeInMonth(s, mk));
  // Object.create(null)（Codex r5#5）：分類/卡片名是使用者文字，撞原生屬性名時普通物件會算錯
  const byCat = Object.create(null), byCard = Object.create(null);
  active.forEach(s => {
    const cost = costForMonth(s, mk);
    byCat[s.category || '未分類'] = (byCat[s.category || '未分類'] || 0) + cost;
    byCard[cardLabel(s.card || '未指定')] = (byCard[cardLabel(s.card || '未指定')] || 0) + cost;
  });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const total = catRows.reduce((sum, [, v]) => sum + v, 0);
  const stops = [];
  let acc = 0;
  for (const [cat, val] of catRows) {
    const start = total ? acc / total * 100 : 0;
    acc += val;
    const end = total ? acc / total * 100 : 0;
    stops.push(`${((Object.hasOwn(CAT_COLOR, cat) && CAT_COLOR[cat]) || CHART.gray)} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
  }
  const donut = stops.length ? `<div class="report-donut" style="background:conic-gradient(${stops.join(',')})"></div>` : '<div class="report-donut empty"></div>';
  const catList = catRows.map(([cat, val]) => `<div><i style="background:${((Object.hasOwn(CAT_COLOR, cat) && CAT_COLOR[cat]) || CHART.gray)}"></i><b>${esc(cat)}</b><span>${total ? Math.round(val / total * 100) : 0}%</span><span>${fmtFee(val)}</span></div>`).join('');
  const cardRows = Object.entries(byCard).sort((a, b) => b[1] - a[1]).map(([card, val]) => [esc(card), fmtFee(val)]);
  return `<section><h2>本月統計</h2><div class="report-grid">
    <div class="report-panel"><h3>依類別佔比</h3><div class="report-donut-wrap">${donut}<div class="report-legend">${catList || '<p class="muted">無資料</p>'}</div></div></div>
    <div class="report-panel"><h3>依信用卡合計</h3>${reportTable(['信用卡', '金額'], cardRows, '無資料')}</div>
  </div></section>`;
}

// 續費時間線（列印報表版，佈局與頁面卡片共用 timelinePoints）
function reportTimeline(subs) {
  const { upcoming, points, timelineHeight } = timelinePoints(subs, {
    pos: (d) => Math.max(5, Math.min(95, 5 + d / 30 * 90)),
    topLevels: [12, 44], bottomLevels: [122, 154, 186], labelH: 40, minHeight: 210
  });
  if (!upcoming.length) return `<section><h2>未來 30 天續費時間線</h2><p class="muted">未來 30 天沒有預定續費。</p></section>`;
  const pointsHtml = points.map(p => `<div class="report-tl-point ${p.side}" style="left:${p.left.toFixed(2)}%;--label-top:${p.labelTop}px;--line-top:${p.lineTop}px;--line-height:${p.lineHeight}px;--dot-top:${p.dotY}px">
      <div class="report-tl-label">
        <b>${esc(p.name)}</b>
        <span>（${fmtFee(p.amount)}）</span>
        <small>${p.days === 0 ? '今天' : `${p.days} 天後`}</small>
      </div>
      <em></em>
      <i style="background:${(Object.hasOwn(CAT_COLOR, p.cat) && CAT_COLOR[p.cat]) || CHART.gray}"></i>
    </div>`).join('');
  return `<section><h2>未來 30 天續費時間線</h2>
    <div class="report-timeline" style="--report-timeline-height:${timelineHeight}px">
      <div class="report-tl-axis"></div>
      <div class="report-tl-tick start">今天</div>
      <div class="report-tl-tick end">+30 天</div>
      ${pointsHtml}
    </div>
  </section>`;
}

function reportStatusLists(subs) {
  const statusDate = (s) => isLifetimeSub(s) ? '終身' : (subStatus(s) === 'active' ? (s.nextCharge || '—') : (s.endsOn || '—'));
  const toRows = (rows) => rows.map(s => [esc(s.name), esc(s.category || '未分類'), esc(CYCLE_LABELS[s.cycle] || '月繳'), fmtFee(feeMonthVal(s)), esc(statusDate(s))]);
  const statusText = (s) => STATUS_LABELS[subStatus(s)] || '使用中';
  const categorySections = CATEGORIES.map(cat => {
    const rows = sortByStatusThenCost(subs.filter(s => (s.category || '未分類') === cat))
      .map(s => [esc(s.name), esc(statusText(s)), esc(CYCLE_LABELS[s.cycle] || '月繳'), fmtFee(feeMonthVal(s)), esc(statusDate(s))]);
    return `<h3>${esc(cat)}類</h3>${reportStatusTable(['服務', '狀態', '週期', '月攤提', '日期'], rows, `無${cat}類訂閱`)}`;
  }).join('');
  return `<section><h2>訂閱狀態總覽</h2>
    <h3>使用中</h3>${reportStatusTable(['服務', '類別', '週期', '月攤提', '續費日'], toRows(sortByMonthlyCost(subs.filter(s => subStatus(s) === 'active'))), '無使用中訂閱')}
    <h3>即將停用</h3>${reportStatusTable(['服務', '類別', '週期', '月攤提', '停用日'], toRows(sortByMonthlyCost(subs.filter(s => subStatus(s) === 'ending'))), '無即將停用訂閱')}
    <h3>已停用</h3>${reportStatusTable(['服務', '類別', '週期', '月攤提', '停用日'], toRows(sortByMonthlyCost(subs.filter(s => subStatus(s) === 'ended'))), '無已停用訂閱')}
    <h2 class="subsection-title">依類別檢視</h2>
    ${categorySections}</section>`;
}

function reportSuggestions(subs, mk) {
  const active = subs.filter(s => activeInMonth(s, mk));
  const topCosts = active.slice().sort((a, b) => costForMonth(b, mk) - costForMonth(a, mk)).slice(0, 5)
    .map(s => `<li><b>${esc(s.name)}</b>：${fmtFee(costForMonth(s, mk))} / 月，可優先檢視使用頻率。</li>`);
  const ending = subs.filter(s => subStatus(s) === 'ending').sort((a, b) => (a.endsOn || '').localeCompare(b.endsOn || '')).slice(0, 5)
    .map(s => `<li><b>${esc(s.name)}</b>：${esc(s.endsOn || '—')} 停用，確認是否需要續留。</li>`);
  const marked = subs.filter(s => s.considerCancel).map(s => `<li><b>${esc(s.name)}</b>：已標記考慮停用。</li>`);
  return `<section><h2>檢視建議</h2><div class="report-grid">
    <div class="report-panel"><h3>優先檢查高費用</h3><ul>${topCosts.join('') || '<li>目前沒有可檢查的使用中訂閱。</li>'}</ul></div>
    <div class="report-panel"><h3>停用與取捨</h3><ul>${[...marked, ...ending].join('') || '<li>目前沒有標記停用或即將停用的服務。</li>'}</ul></div>
  </div></section>`;
}

export function printSubscriptionReport(subs, curMk, nextMk) {
  const thisMonth = amortizedForMonth(subs, curMk);
  const nextMonth = amortizedForMonth(subs, nextMk);
  const generated = todayStr();
  const extraCss = `
      h1, h2, h3 { margin: 0; font-weight: 600; }
      h1 { font-size: 26px; letter-spacing: .02em; }
      h2 { font-size: 17px; margin: 0 0 10px; display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #ded8cc; padding-bottom: 8px; }
      h2 span { font-size: 14px; color: #c96442; }
      h3 { font-size: 13px; margin: 12px 0 8px; color: #5d574f; }
      .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
      .metric { border: 1px solid #ded8cc; border-radius: 8px; padding: 12px; }
      .metric span { color: #8a887f; display: block; margin-bottom: 6px; }
      .metric b { font-size: 20px; font-family: Georgia, "Times New Roman", serif; font-weight: 500; }
      section { break-inside: avoid; margin: 0 0 18px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
      th, td { text-align: left; border-bottom: 1px solid #ebe6dc; padding: 7px 8px; vertical-align: top; }
      th { color: #777167; background: #f5f1e8; font-size: 11px; font-weight: 600; }
      td.num, th.num, .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .cost-calc-table { table-layout: fixed; }
      .cost-calc-table .service-col { width: 34%; }
      .cost-calc-table .cycle-col { width: 16%; }
      .cost-calc-table .formula-col { width: 30%; }
      .cost-calc-table .amount-col { width: 20%; }
      .cost-calc-table th:nth-child(2), .cost-calc-table td:nth-child(2),
      .cost-calc-table th:nth-child(3), .cost-calc-table td:nth-child(3),
      .cost-calc-table th:last-child, .cost-calc-table td:last-child { text-align: center; }
      .status-overview-table { table-layout: fixed; }
      .status-overview-table .status-service-col { width: 34%; }
      .status-overview-table .status-meta-col { width: 18%; }
      .status-overview-table .status-cycle-col { width: 14%; }
      .status-overview-table .status-month-col { width: 17%; }
      .status-overview-table .status-date-col { width: 17%; }
      .status-overview-table th:nth-child(n+3),
      .status-overview-table td:nth-child(n+3) { text-align: center; }
      .center { text-align: center; }
      .report-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .report-panel { border: 1px solid #ded8cc; border-radius: 8px; padding: 10px; break-inside: avoid; }
      .report-donut-wrap { display: grid; grid-template-columns: 120px 1fr; gap: 12px; align-items: center; }
      .report-donut { width: 118px; height: 118px; border-radius: 50%; position: relative; }
      .report-donut::after { content: ""; position: absolute; inset: 34px; background: #fff; border-radius: 50%; }
      .report-donut.empty { background: #eee8dd; }
      .report-legend { display: grid; gap: 6px; }
      .report-legend div { display: grid; grid-template-columns: 10px 1fr auto auto; gap: 7px; align-items: center; }
      .report-legend i { width: 10px; height: 10px; border-radius: 2px; }
      .subsection-title { margin-top: 16px; }
      .report-timeline { position: relative; height: var(--report-timeline-height, 210px); margin: 8px 4px 2px; }
      .report-tl-axis { position: absolute; left: 5%; right: 5%; top: 98px; height: 2px; background: #ded8cc; border-radius: 2px; }
      .report-tl-tick { position: absolute; top: 108px; font-size: 10px; color: #8a887f; }
      .report-tl-tick.start { left: 5%; transform: translateX(-50%); }
      .report-tl-tick.end { right: 5%; transform: translateX(50%); }
      .report-tl-point { position: absolute; top: 0; height: var(--report-timeline-height, 210px); }
      .report-tl-point i { position: absolute; left: 0; top: var(--dot-top); transform: translateX(-50%); width: 13px; height: 13px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #cfc7ba; }
      .report-tl-point em { position: absolute; left: 0; top: var(--line-top); height: var(--line-height); width: 1px; background: #ded8cc; transform: translateX(-50%); }
      .report-tl-label { position: absolute; left: 0; width: 96px; transform: translateX(-50%); text-align: center; line-height: 1.25; }
      .report-tl-point .report-tl-label { top: var(--label-top); }
      .report-tl-label b { display: block; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .report-tl-label span { display: block; font-size: 9.5px; color: #8a887f; }
      .report-tl-label small { display: block; font-size: 9.5px; color: #8a887f; }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 0 0 6px; }
`;
  openPrintWindow(`訂閱追蹤報表 ${curMk}`, extraCss, `
      <div class="preview-bar">
        <div><strong>訂閱追蹤報表預覽</strong></div>
        <button onclick="window.print()">列印 / 另存</button>
      </div>
      <main class="preview-shell"><article class="paper">
        <header class="cover"><div><h1>「訂閱追蹤」報表</h1><p class="muted">產生日期：${esc(generated)}｜本月：${esc(curMk)}</p></div></header>
        <div class="summary">
          <div class="metric"><span>本月費用</span><b>${fmtFee(thisMonth)}</b></div>
          <div class="metric"><span>下月預估</span><b>${fmtFee(nextMonth)}</b></div>
          <div class="metric"><span>每年估算</span><b>${fmtFee(thisMonth * 12)}</b></div>
          <div class="metric"><span>追蹤項目</span><b>${subs.length} 項</b></div>
        </div>
        ${reportCostTable(subs, curMk, '費用計算方式')}
        ${reportCostTable(subs, nextMk, '費用預估方式')}
        ${reportTimeline(subs)}
        ${reportBreakdown(subs, curMk)}
        ${reportSuggestions(subs, curMk)}
        ${reportStatusLists(subs)}
      </article></main>`);
}
