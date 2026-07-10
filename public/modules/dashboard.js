import { api, view, wan, money, pct, esc } from '../app.js';
import { PALETTE, AXIS, GRID } from './theme.js';
import { icon } from './icons.js';

let chartRefs = [];
function destroyCharts() { chartRefs.forEach(c => c.destroy()); chartRefs = []; }

export async function renderDashboard() {
  const s = await api('/summary');
  destroyCharts();

  const cf = s.cashflow;
  const remindersHtml = s.reminders.length
    ? s.reminders.map(r => `<div class="reminder ${r.level}">
        <span class="r-tag">${esc(r.module)}</span>
        <div><div class="r-title">${esc(r.title)}</div><div class="r-detail">${esc(r.detail)}</div></div>
      </div>`).join('')
    : `<div class="empty-good">${icon('check', 16)} 目前沒有需要注意的提醒，財務狀況穩定。</div>`;

  view().innerHTML = `
    <div class="page-head">
      <div><h1>總覽</h1><p>你的財務全貌與本月提醒</p></div>
    </div>

    <div class="cards">
      <div class="card">
        <h3>淨資產</h3>
        <div class="stat sm">${wan(s.netWorth)}</div>
        <div class="stat-sub">資產 ${wan(s.assets)}・負債 ${wan(s.liabilities)}</div>
      </div>
      <div class="card">
        <h3>本月現金流</h3>
        <div class="stat sm ${cf.net >= 0 ? 'pos' : 'neg'}">${cf.net >= 0 ? '+' : ''}${wan(cf.net)}</div>
        <div class="stat-sub">收入 ${wan(cf.income)}・支出 ${wan(cf.expense)}</div>
      </div>
      <div class="card">
        <h3>投資組合</h3>
        <div class="stat sm">${wan(s.ib.totalValue)}</div>
        <div class="stat-sub ${s.ib.totalPnl >= 0 ? 'pos' : 'neg'}">未實現損益 ${s.ib.totalPnl >= 0 ? '+' : ''}${wan(s.ib.totalPnl)}・${s.ib.count} 檔</div>
      </div>
      <div class="card">
        <h3>每月固定訂閱</h3>
        <div class="stat sm">${wan(s.subscriptions.monthly)}</div>
        <div class="stat-sub">${s.subscriptions.count} 項・年化 ${wan(s.subscriptions.yearly)}</div>
      </div>
    </div>

    <div class="section-title">${icon('alert', 18)} 提醒事項（${s.reminders.length}）</div>
    <div class="reminders">${remindersHtml}</div>

    <div class="section-title">財務變化趨勢</div>
    <div class="two-col">
      <div class="chart-card"><h3>淨資產走勢</h3><div class="chart-box"><canvas id="trendChart"></canvas></div></div>
      <div class="chart-card"><h3>資產配置</h3><div class="chart-box"><canvas id="allocChart"></canvas></div></div>
    </div>
  `;

  drawTrend(s.snapshots);
  drawAlloc(s.byClass);
}

function drawTrend(snaps) {
  const ctx = document.getElementById('trendChart');
  if (!ctx || !snaps.length) { if (ctx) ctx.parentElement.innerHTML = '<p class="muted">尚無歷史快照，按左下角「記錄本月快照」開始累積。</p>'; return; }
  chartRefs.push(new Chart(ctx, {
    type: 'line',
    data: {
      labels: snaps.map(s => s.month),
      datasets: [{
        label: '淨資產', data: snaps.map(s => s.netWorth),
        borderColor: '#c96442', backgroundColor: 'rgba(201,100,66,.10)',
        fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: '#c96442'
      }]
    },
    options: baseOpts(true)
  }));
}

function drawAlloc(byClass) {
  const ctx = document.getElementById('allocChart');
  const labels = Object.keys(byClass);
  if (!ctx || !labels.length) { if (ctx) ctx.parentElement.innerHTML = '<p class="muted">尚無資產資料。</p>'; return; }
  chartRefs.push(new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: labels.map(l => byClass[l]), backgroundColor: PALETTE, borderColor: '#ffffff', borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: { legend: { position: 'right', labels: { color: AXIS, boxWidth: 12, padding: 10 } },
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.parsed)} (${pct(c.parsed / c.dataset.data.reduce((a, b) => a + b, 0) * 100)})` } } }
    }
  }));
}

function baseOpts(isMoney = false) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false },
      tooltip: { callbacks: { label: (c) => isMoney ? ' ' + money(c.parsed.y ?? c.parsed) : ' ' + (c.parsed.y ?? c.parsed) } } },
    scales: {
      x: { ticks: { color: AXIS }, grid: { color: GRID } },
      y: { ticks: { color: AXIS, callback: (v) => isMoney ? (v / 10000).toFixed(0) + '萬' : v }, grid: { color: GRID } }
    }
  };
}
