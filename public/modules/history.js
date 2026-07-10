import { api, esc, wan, money, monthKey, openForm, confirmDelete, toast } from '../app.js';
import { CHART, AXIS, GRID } from './theme.js';
import { icon } from './icons.js';
const MONTH_LABELS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
let histChart = null;
let selectedYear = null;
let sectionRoot = null;

// 把「歷史紀錄」渲染到指定容器（嵌在訂閱追蹤頁裡）
export async function renderHistorySection(root) {
  sectionRoot = root;
  const hist = await api('/history');
  if (histChart) { histChart.destroy(); histChart = null; }

  const years = [...new Set(hist.map(h => h.month.slice(0, 4)))].sort();
  const curYear = monthKey().slice(0, 4);
  if (!years.includes(curYear)) years.push(curYear);
  years.sort();
  if (!selectedYear || !years.includes(selectedYear)) selectedYear = years.includes(curYear) ? curYear : years[years.length - 1];

  const byMonth = {};
  hist.filter(h => h.month.startsWith(selectedYear)).forEach(h => { byMonth[Number(h.month.slice(5, 7))] = h; });
  const monthsData = Array.from({ length: 12 }, (_, i) => byMonth[i + 1]);
  const yearTotal = monthsData.reduce((t, h) => t + (h ? Number(h.amount || 0) : 0), 0);
  const recordedCount = monthsData.filter(Boolean).length;

  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin:32px 0 14px">
      <div class="section-title" style="margin:0">歷史紀錄</div>
      <select id="histYearSel" style="width:auto">${years.map(y => `<option value="${esc(y)}" ${y === selectedYear ? 'selected' : ''}>${esc(y)} 年</option>`).join('')}</select>
    </div>

    <div class="cards" style="margin-bottom:16px">
      <div class="card"><h3>${esc(selectedYear)} 年訂閱費合計</h3><div class="stat sm">${wan(yearTotal)}</div><div class="stat-sub">已紀錄 ${recordedCount} 個月</div></div>
      <div class="card"><h3>平均每月</h3><div class="stat sm">${wan(recordedCount ? yearTotal / recordedCount : 0)}</div></div>
    </div>

    <div class="chart-card" style="margin-bottom:16px">
      <h3>${esc(selectedYear)} 年每月訂閱費（1–12 月）</h3>
      <div class="chart-box" style="height:260px"><canvas id="histChart"></canvas></div>
      <p class="muted" style="font-size:11px;margin-top:8px">每個月結束後，系統會自動把該月的實際訂閱攤提（年費 ÷12）凍結到這裡。</p>
    </div>

    <div class="tbl-wrap">
      <table><thead><tr><th>月份</th><th class="num">訂閱費</th><th>狀態</th><th></th></tr></thead>
      <tbody>${MONTH_LABELS.map((lbl, i) => rowHtml(selectedYear, i + 1, lbl, byMonth[i + 1])).join('')}</tbody></table>
    </div>
  `;

  root.querySelector('#histYearSel').onchange = (e) => { selectedYear = e.target.value; renderHistorySection(root); };
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openHistForm(b.dataset.edit, byMonth[Number(b.dataset.m)]));
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const h = byMonth[Number(b.dataset.m)];
    confirmDelete(`${h.month} 的紀錄`, async () => { await api('/history/' + h.id, { method: 'DELETE' }); renderHistorySection(root); });
  });

  drawChart(monthsData, monthKey());
}

function rowHtml(year, m, lbl, rec) {
  const mk = `${year}-${String(m).padStart(2, '0')}`;
  const isFuture = mk > monthKey();
  const isCurrent = mk === monthKey();
  if (rec) {
    return `<tr>
      <td>${lbl}</td><td class="num">${money(rec.amount)}</td>
      <td><span class="tag green">已紀錄</span></td>
      <td><div class="row-actions">
        <button class="btn-link btn-sm" data-edit="${mk}" data-m="${m}" title="修正">${icon('edit', 15)}</button>
        <button class="btn-danger btn-sm" data-del="${mk}" data-m="${m}" title="刪除">${icon('trash', 15)}</button>
      </div></td></tr>`;
  }
  const tag = isCurrent ? '<span class="tag amber">本月進行中</span>' : isFuture ? '<span class="tag">未到</span>' : '<span class="tag">未紀錄</span>';
  return `<tr style="opacity:.55"><td>${lbl}</td><td class="num muted">—</td><td>${tag}</td><td></td></tr>`;
}

function drawChart(monthsData, curMk) {
  const ctx = document.getElementById('histChart');
  if (!ctx) return;
  const data = monthsData.map(h => h ? Number(h.amount || 0) : 0);
  const colors = monthsData.map((h, i) => {
    const mk = `${selectedYear}-${String(i + 1).padStart(2, '0')}`;
    if (!h) return 'rgba(189,184,171,.25)';
    return mk === curMk ? CHART.red : CHART.green;
  });
  histChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: MONTH_LABELS, datasets: [{ data, backgroundColor: colors, borderRadius: 6, maxBarThickness: 40 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.y ? ' ' + money(c.parsed.y) : ' 未紀錄' } } },
      scales: { x: { ticks: { color: AXIS }, grid: { display: false } },
        y: { ticks: { color: AXIS, callback: v => v.toLocaleString('en-US') }, grid: { color: GRID }, beginAtZero: true } } }
  });
}

function openHistForm(mk, rec) {
  openForm({
    title: `修正 ${mk} 訂閱費`,
    fields: [{ key: 'amount', label: '該月訂閱費（已分攤）', type: 'number', required: true }],
    values: { amount: rec ? rec.amount : 0 },
    onSubmit: async (data) => {
      if (rec) await api('/history/' + rec.id, { method: 'PUT', body: { amount: data.amount } });
      else await api('/history', { method: 'POST', body: { month: mk, amount: data.amount } });
      toast('已更新'); if (sectionRoot) renderHistorySection(sectionRoot);
    }
  });
}
