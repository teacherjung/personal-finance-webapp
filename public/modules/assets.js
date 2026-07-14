// @ts-check
import { api, view, byId, wan, money, moneyCur, pct, esc, openForm, confirmDelete, toast, modalSizeClass } from '../app.js';
import { PALETTE, CHART, AXIS } from './theme.js';
import { icon } from './icons.js';
import { rebalancePlan } from './rebalance.js';
const ACCOUNT_TYPES = [
  { value: 'cash', label: '現金 / 存款' }, { value: 'investment', label: '投資（股票/ETF/IB）' },
  { value: 'property', label: '房地產' }, { value: 'insurance-cv', label: '保單現金價值' },
  { value: 'other', label: '其他資產' }, { value: 'mortgage', label: '房貸（負債）' },
  { value: 'loan', label: '其他貸款（負債）' }
];
let chart;

export async function renderAssets() {
  const [db, alloc] = await Promise.all([api('/db'), api('/summary')]);
  const accounts = db.accounts || [];
  const a = alloc.allocation;
  if (chart) { chart.destroy(); chart = null; }

  view().innerHTML = `
    <div class="page-head">
      <div><h1>資產配置</h1><p>各帳戶餘額、實際 vs 目標配置，偏離時提醒再平衡</p></div>
      <div class="page-actions"><button class="btn-ghost" id="rebalBtn">${icon('repeat', 16)}再平衡計算</button><button class="btn-ghost" id="editTargets">${icon('settings', 16)}設定目標配置</button><button class="btn" id="addAcc">${icon('plus', 16)}新增帳戶</button></div>
    </div>

    <div class="hint">股票／債券的金額由「投資組合」的持股<b>自動換算併入</b>（含外幣→台幣），這裡只需要記現金、黃金等帳戶，不用重複記投資部位。</div>

    <div class="cards">
      <div class="card"><h3>總資產</h3><div class="stat sm pos">${wan(alloc.assets)}</div></div>
      <div class="card"><h3>總負債</h3><div class="stat sm neg">${wan(alloc.liabilities)}</div></div>
      <div class="card"><h3>淨資產</h3><div class="stat sm">${wan(alloc.netWorth)}</div></div>
    </div>

    <div class="two-col">
      <div class="chart-card"><h3>資產配置圓餅圖</h3><div class="chart-box"><canvas id="pie"></canvas></div></div>
      <div class="chart-card"><h3>資產配置 vs 目標 <span class="stat-sub" style="font-weight:400;margin:0">（現金・股・債・金・房地產等資產類別）</span></h3>
        ${a.rows.filter(r => r.value > 0 || r.targetPct > 0).map(r => {
          const off = Math.abs(r.diff) >= (db.settings.allocationDriftPct || 5);
          const fromPf = ['股票', '債券'].includes(r.class);
          return `<div style="margin-bottom:13px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
              <span>${esc(r.class)}${fromPf ? ` <a href="#ib" class="drill-link" title="此數字由投資組合的持股自動換算，點此看明細">投資組合 →</a>` : ''} ${off ? `<span class="tag amber">偏離 ${r.diff > 0 ? '+' : ''}${r.diff.toFixed(1)}%</span>` : ''}</span>
              <span class="muted">${r.actualPct.toFixed(1)}% / 目標 ${r.targetPct}%</span>
            </div>
            <div class="pill-bar" style="height:9px;position:relative">
              <div style="width:${Math.min(r.actualPct, 100)}%;background:${off ? CHART.orange : CHART.green}"></div>
              <div style="position:absolute;top:-2px;bottom:-2px;left:${Math.min(r.targetPct, 100)}%;width:2px;background:var(--text)" title="目標"></div>
            </div></div>`;
        }).join('') || '<p class="empty">尚未設定目標配置。</p>'}
        <p class="muted" style="font-size:11px;margin-top:6px">深色直線＝目標比例</p>
      </div>
    </div>

    <div class="section-title">帳戶明細</div>
    <div class="tbl-wrap">
      <table><thead><tr><th>帳戶</th><th>類別</th><th>資產類別</th><th class="num">餘額</th><th></th></tr></thead>
      <tbody>${accounts.map(accRow).join('') || `<tr><td colspan="5" class="empty">尚無帳戶</td></tr>`}</tbody></table>
    </div>
  `;

  drawPie(alloc.byClass);
  byId('addAcc').onclick = () => openAccForm();
  byId('editTargets').onclick = () => openTargets(db.assetTargets || []);
  byId('rebalBtn').onclick = () => openRebalance(a.rows);
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openAccForm(accounts.find(x => x.id === b.dataset.edit)));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const x = accounts.find(y => y.id === b.dataset.del);
    confirmDelete(x.name, () => api('/accounts/' + x.id, { method: 'DELETE' }));
  });
}

const isLiab = (x) => ['mortgage', 'loan', 'liability'].includes(x.type) || Number(x.balance) < 0;

function accRow(x) {
  const liab = isLiab(x);
  const cur = x.currency || 'TWD';
  return `<tr>
    <td>${esc(x.name)}</td>
    <td><span class="tag ${liab ? 'amber' : 'blue'}">${esc(typeLabel(x.type))}</span></td>
    <td class="muted">${esc(x.class || '—')}</td>
    <td class="num ${liab ? 'neg' : ''}">${moneyCur(x.balance, cur)}</td>
    <td><div class="row-actions"><button class="btn-link btn-sm" data-edit="${x.id}" title="編輯">${icon('edit', 15)}</button><button class="btn-danger btn-sm" data-del="${x.id}" title="刪除">${icon('trash', 15)}</button></div></td>
  </tr>`;
}
function typeLabel(t) { return (ACCOUNT_TYPES.find(a => a.value === t) || {}).label || t; }

function drawPie(byClass) {
  const ctx = byId('pie');
  const labels = Object.keys(byClass);
  if (!labels.length) { ctx.parentElement.innerHTML = '<p class="empty">尚無資產資料。</p>'; return; }
  chart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: labels.map(l => byClass[l]), backgroundColor: PALETTE, borderColor: '#ffffff', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: { legend: { position: 'right', labels: { color: AXIS, boxWidth: 12, padding: 10 } },
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.parsed)} (${pct(c.parsed / c.dataset.data.reduce((x, y) => x + y, 0) * 100)})` } } } }
  });
}

function openAccForm(acc) {
  openForm({
    title: acc ? '編輯帳戶' : '新增帳戶',
    fields: [
      { key: 'name', label: '帳戶名稱', type: 'text', required: true, placeholder: '例：台新銀行 活存' },
      { key: 'type', label: '帳戶類型', type: 'select', options: ACCOUNT_TYPES },
      { key: 'currency', label: '幣別', type: 'select', options: ['TWD', 'USD', 'GBP', 'JPY'] },
      { key: 'class', label: '資產類別（用於配置圓餅圖）', type: 'text', placeholder: '例：現金、黃金', full: true },
      { key: 'balance', label: '目前餘額（原幣，負債請填負數）', type: 'number', required: true }
    ],
    values: acc || { currency: 'TWD' },
    onSubmit: async (data) => {
      if (acc) await api('/accounts/' + acc.id, { method: 'PUT', body: data });
      else await api('/accounts', { method: 'POST', body: data });
      toast('已儲存'); renderAssets();
    }
  });
}

// 再平衡計算器（3-13）：唯讀試算、不改任何資料。預設「只買不賣」（符合投資原則：加碼只用新資金）。
function openRebalance(allocRows) {
  const root = byId('modal-root');
  let buyOnly = true;
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('md')}">
    <div class="modal-head"><h2>再平衡計算器</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <button type="button" class="btn btn-sm" id="modeBuy">只買不賣</button>
        <button type="button" class="btn-ghost btn-sm" id="modeBoth">允許買賣</button>
        <span id="cashWrap" style="display:flex;gap:6px;align-items:center;margin-left:auto">
          <label class="muted" style="font-size:12px">新資金（台幣）</label>
          <input id="rebCash" type="number" step="1000" min="0" placeholder="例：50000" style="width:120px" />
        </span>
      </div>
      <div id="rebOut"></div>
      <p class="muted" style="font-size:11px;margin-top:10px">「只買不賣」＝新資金優先補低配類別（符合「加碼只用新資金、不舉新債」原則）；「允許買賣」＝恢復目標配置的完整買賣清單。此為試算，<b>不會改動任何資料</b>；目標％依比例自動正規化。</p>
    </div></div></div>`;
  const close = () => root.innerHTML = '';
  root.querySelector('.x-close').onclick = close;
  root.querySelector('.modal-bg').onclick = (e) => { if (/** @type {any} */ (e.target).classList.contains('modal-bg')) close(); };
  const render = () => {
    const cash = Number(/** @type {any} */ (byId('rebCash')).value || 0);
    const plan = rebalancePlan(allocRows, { buyOnly, cash });
    byId('modeBuy').className = buyOnly ? 'btn btn-sm' : 'btn-ghost btn-sm';
    byId('modeBoth').className = buyOnly ? 'btn-ghost btn-sm' : 'btn btn-sm';
    byId('cashWrap').style.display = buyOnly ? 'flex' : 'none';
    if (!plan.rows.length) { byId('rebOut').innerHTML = '<p class="empty">尚未設定目標配置（先按「設定目標配置」）。</p>'; return; }
    const need = buyOnly && !(cash > 0);
    byId('rebOut').innerHTML = `
      <div class="tbl-wrap"><table>
        <thead><tr><th>類別</th><th class="num">目前</th><th class="num">目標</th><th class="num">${buyOnly ? '建議加碼' : '動作'}</th><th class="num">調整後</th></tr></thead>
        <tbody>${plan.rows.map(r => {
          const act = need ? '<span class="muted">—</span>'
            : Math.abs(r.delta) < 1 ? '<span class="muted">—</span>'
            : r.delta > 0 ? `<b class="pos">買 ${money(r.delta)}</b>`
            : `<b class="neg">賣 ${money(-r.delta)}</b>`;
          return `<tr>
            <td>${esc(r.class)}</td>
            <td class="num">${money(r.value)}<br><span class="muted" style="font-size:11px">${r.currentPct.toFixed(1)}%</span></td>
            <td class="num">${r.targetPctNorm.toFixed(1)}%</td>
            <td class="num">${act}</td>
            <td class="num muted">${need ? '—' : r.afterPct.toFixed(1) + '%'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      ${need ? '<p class="hint" style="margin-top:8px">輸入這次要投入的新資金金額，就會算出各類別建議加碼多少。</p>' : ''}
      ${plan.excluded.length ? `<p class="muted" style="font-size:11px;margin-top:8px">未設目標、不參與計算：${plan.excluded.map(esc).join('、')}</p>` : ''}`;
  };
  byId('modeBuy').onclick = () => { buyOnly = true; render(); };
  byId('modeBoth').onclick = () => { buyOnly = false; render(); };
  byId('rebCash').oninput = render;
  render();
}

function openTargets(targets) {
  const root = byId('modal-root');
  const rows = () => targets.map((t, i) => `<div class="form-grid" style="margin-bottom:8px" data-i="${i}">
    <input data-k="class" value="${esc(t.class || '')}" placeholder="類別 (例：股票)" />
    <div style="display:flex;gap:8px"><input data-k="targetPct" type="number" value="${esc(t.targetPct ?? '')}" placeholder="目標 %" />
    <button type="button" class="btn-danger btn-sm" data-rm="${i}" title="刪除">${icon('trash', 15)}</button></div>
  </div>`).join('');
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('md')}">
    <div class="modal-head"><h2>設定目標資產配置</h2><button class="x-close">×</button></div>
    <div class="modal-body"><div id="tRows">${rows()}</div>
      <button type="button" class="btn-ghost btn-sm" id="addRow">${icon('plus', 15)}新增類別</button>
      <div class="form-actions"><button class="btn-ghost" data-cancel>取消</button><button class="btn" id="saveT">儲存</button></div>
    </div></div></div>`;
  const close = () => root.innerHTML = '';
  const collect = () => [...root.querySelectorAll('#tRows [data-i]')].map(r => ({
    class: r.querySelector('[data-k="class"]').value,
    targetPct: Number(r.querySelector('[data-k="targetPct"]').value || 0)
  })).filter(x => x.class);
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  root.querySelector('#addRow').onclick = () => { targets = collect(); targets.push({ class: '', targetPct: 0 }); root.querySelector('#tRows').innerHTML = rows(); bind(); };
  function bind() { root.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { targets = collect(); targets.splice(Number(b.dataset.rm), 1); root.querySelector('#tRows').innerHTML = rows(); bind(); }); }
  bind();
  root.querySelector('#saveT').onclick = async () => {
    const next = collect();
    const cur = await api('/assetTargets');
    for (const t of cur) await api('/assetTargets/' + t.id, { method: 'DELETE' });
    for (const t of next) await api('/assetTargets', { method: 'POST', body: t });
    toast('目標配置已更新'); close(); renderAssets();
  };
}
