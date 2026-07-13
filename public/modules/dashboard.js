// @ts-check
import { api, view, byId, wan, pct, esc } from '../app.js';
import { CHART, PALETTE, AXIS, GRID, ACCENT, ACCENT_SOFT } from './theme.js';
import { icon } from './icons.js';

let chartRefs = [];
function destroyCharts() { chartRefs.forEach(c => c.destroy()); chartRefs = []; }

// 淨資產走勢迷你線（hero 內，取自真實月快照）
function sparklineSvg(snaps) {
  const pts = (snaps || []).map(s => Number(s.netWorth) || 0);
  if (pts.length < 2) return '<div class="dh-spark-empty">每月按左下「記錄本月快照」，這裡會長出淨資產走勢。</div>';
  const w = 240, h = 40, pad = 4;
  const min = Math.min(...pts), max = Math.max(...pts), range = (max - min) || 1;
  const step = w / (pts.length - 1);
  const xy = pts.map((v, i) => [+(i * step).toFixed(1), +(h - pad - ((v - min) / range) * (h - 2 * pad)).toFixed(1)]);
  const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ');
  const area = `M${xy[0][0]},${h} ` + xy.map(p => 'L' + p[0] + ',' + p[1]).join(' ') + ` L${xy[xy.length - 1][0]},${h} Z`;
  const last = xy[xy.length - 1];
  return `<svg class="dh-spark-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="dhSpark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity=".2"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#dhSpark)"/>
    <path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="2"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3" fill="${ACCENT}"/>
  </svg>`;
}

// 資產配置長條＋圖例（取代原本的甜甜圈；類別走 byClass，顏色固定對應）
const CLASS_COLOR = { 股票: CHART.blue, 債券: CHART.yellow, 現金: CHART.gray, 黃金: CHART.green };
function allocSection(byClass) {
  const entries = Object.entries(byClass || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p class="empty">尚無資產資料。</p>';
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const colorOf = (k, i) => CLASS_COLOR[k] || PALETTE[i % PALETTE.length];
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

export async function renderDashboard() {
  const s = await api('/summary');
  destroyCharts();

  const cf = s.cashflow;
  const cfSub = (cf.income || cf.expense) ? `收入 ${wan(cf.income)}・支出 ${wan(cf.expense)}` : '本月尚未記帳';
  const pnl = s.ib.totalPnl;
  const warnCount = s.reminders.filter(r => r.level === 'warn' || r.level === 'danger').length;

  // 融資槓桿 KPI（後端 summary 已提供 leverage / mcDist / hasLoan）
  const lev = s.ib || {};
  const levOver = s.reminders.some(r => r.title.includes('融資槓桿') && (r.level === 'warn' || r.level === 'danger'));
  let levVal, levSub, levCls = '';
  if (!lev.hasLoan) { levVal = '無融資'; levSub = '目前未使用槓桿'; }
  else {
    levVal = `${Number(lev.leverage).toFixed(2)}x`;
    levCls = levOver ? 'warn' : '';
    levSub = levOver ? '超過上限，停借新錢' : `斷頭距離約 ${Math.round(lev.mcDist)}%`;
  }

  view().innerHTML = `
    <div class="page-head"><div><h1>總覽</h1><p>你的財務全貌與本月提醒</p></div></div>

    <div class="dash-hero">
      <div class="dh-main">
        <div class="dh-lab">淨資產</div>
        <div class="dh-net">${wan(s.netWorth)}</div>
        <div class="dh-spark">${sparklineSvg(s.snapshots)}</div>
      </div>
      <div class="dh-chips">
        <span class="dchip">資產 ${wan(s.assets)}</span>
        <span class="dchip">負債 ${wan(s.liabilities)}</span>
        ${warnCount
          ? `<span class="dchip bad">⚠ ${warnCount} 項紀律需注意</span>`
          : `<span class="dchip good">✓ 紀律正常</span>`}
      </div>
    </div>

    <div class="kpi-row">
      <div class="kpi"><div class="kpi-lab">本月現金流</div>
        <div class="kpi-v ${cf.net >= 0 ? 'pos' : 'neg'}">${cf.net >= 0 ? '+' : ''}${wan(cf.net)}</div>
        <div class="kpi-d">${cfSub}</div></div>
      <div class="kpi"><div class="kpi-lab">投資組合</div>
        <div class="kpi-v">${wan(s.ib.totalValue)}</div>
        <div class="kpi-d"><span class="${pnl >= 0 ? 'pos' : 'neg'}">未實現 ${pnl >= 0 ? '+' : ''}${wan(pnl)}</span>・${s.ib.count} 檔</div></div>
      <div class="kpi"><div class="kpi-lab">融資槓桿</div>
        <div class="kpi-v ${levCls}">${levVal}</div>
        <div class="kpi-d ${levCls}">${levSub}</div></div>
      <div class="kpi"><div class="kpi-lab">每月固定訂閱</div>
        <div class="kpi-v">${wan(s.subscriptions.monthly)}</div>
        <div class="kpi-d">${s.subscriptions.count} 項・年化 ${wan(s.subscriptions.yearly)}</div></div>
    </div>

    <div class="dash-two">
      <div class="dash-block">
        <div class="dash-h">需要處理 <span class="dash-ct">${s.reminders.length}</span></div>
        <div class="dact-list">${actionList(s.reminders)}</div>
      </div>
      <div class="dash-block">
        <div class="dash-h">資產配置</div>
        <div class="dalloc-card">${allocSection(s.byClass)}</div>
      </div>
    </div>

    <div class="section-title">淨資產走勢</div>
    <div class="chart-card"><div class="chart-box"><canvas id="trendChart"></canvas></div></div>
  `;

  drawTrend(s.snapshots);
}

function drawTrend(snaps) {
  const ctx = byId('trendChart');
  if (!ctx || !snaps.length) { if (ctx) ctx.parentElement.innerHTML = '<p class="empty">尚無歷史快照，按左下角「記錄本月快照」開始累積。</p>'; return; }
  chartRefs.push(new Chart(ctx, {
    type: 'line',
    data: {
      labels: snaps.map(s => s.month),
      datasets: [{
        label: '淨資產', data: snaps.map(s => s.netWorth),
        borderColor: ACCENT, backgroundColor: ACCENT_SOFT,
        fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: ACCENT
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => ' ' + (c.parsed.y / 10000).toFixed(0) + ' 萬' } } },
      scales: {
        x: { ticks: { color: AXIS }, grid: { color: GRID } },
        y: { ticks: { color: AXIS, callback: (v) => (v / 10000).toFixed(0) + '萬' }, grid: { color: GRID } }
      }
    }
  }));
}
