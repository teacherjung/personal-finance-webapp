import { api, view, wan, money, esc, monthKey, openForm, confirmDelete, toast, router } from '../app.js';
import { CHART } from './theme.js';
import { icon } from './icons.js';

const CATEGORIES = ['薪資', '投資', '獎金', '其他收入', '房貸', '飲食', '保險', '子女教育', '交通', '生活雜支', '醫療', '娛樂', '訂閱', '稅務', '其他支出'];

let monthFilter = monthKey();

export async function renderTransactions() {
  const all = await api('/transactions');
  const months = [...new Set(all.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  if (!months.includes(monthFilter) && months.length) monthFilter = months[0];

  const rows = all.filter(t => t.date?.slice(0, 7) === monthFilter)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const income = rows.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount || 0), 0);
  const expense = rows.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount || 0), 0);

  // 本月支出分類
  const byCat = {};
  rows.filter(t => t.type === 'expense').forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount || 0); });
  const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxCat = topCats[0]?.[1] || 1;

  view().innerHTML = `
    <div class="page-head">
      <div><h1>收支記帳</h1><p>記錄每一筆收入與支出，掌握現金流</p></div>
      <button class="btn" id="addTx">${icon('plus', 16)}新增一筆</button>
    </div>

    <div class="cards" style="margin-bottom:8px">
      <div class="card"><h3>本月收入</h3><div class="stat sm pos">${wan(income)}</div></div>
      <div class="card"><h3>本月支出</h3><div class="stat sm neg">${wan(expense)}</div></div>
      <div class="card"><h3>本月結餘</h3><div class="stat sm ${income - expense >= 0 ? 'pos' : 'neg'}">${income - expense >= 0 ? '+' : ''}${wan(income - expense)}</div></div>
    </div>

    <div class="two-col" style="margin:18px 0">
      <div>
        <label>月份</label>
        <select id="monthSel">${months.map(m => `<option value="${m}" ${m === monthFilter ? 'selected' : ''}>${m}</option>`).join('') || `<option>${monthFilter}</option>`}</select>
      </div>
      <div class="chart-card" style="padding:14px 18px">
        <h3 style="margin-bottom:10px">本月支出分類</h3>
        ${topCats.length ? topCats.map(([c, v]) => `
          <div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${esc(c)}</span><span class="muted">${money(v)}</span></div>
            <div class="pill-bar"><div style="width:${(v / maxCat * 100).toFixed(0)}%;background:${CHART.red}"></div></div>
          </div>`).join('') : '<p class="muted">本月尚無支出。</p>'}
      </div>
    </div>

    <div class="tbl-wrap">
      <table><thead><tr><th>日期</th><th>類型</th><th>分類</th><th>帳戶</th><th>備註</th><th class="num">金額</th><th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="7" class="empty">尚無記錄，點右上角新增。</td></tr>`}</tbody></table>
    </div>
  `;

  document.getElementById('addTx').onclick = () => openTxForm();
  document.getElementById('monthSel').onchange = (e) => { monthFilter = e.target.value; renderTransactions(); };
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openTxForm(all.find(t => t.id === b.dataset.edit)));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const t = all.find(x => x.id === b.dataset.del);
    confirmDelete(`${t.category} ${money(t.amount)}`, () => api('/transactions/' + t.id, { method: 'DELETE' }));
  });
}

function rowHtml(t) {
  const isIn = t.type === 'income';
  return `<tr>
    <td>${esc(t.date)}</td>
    <td><span class="tag ${isIn ? 'green' : 'amber'}">${isIn ? '收入' : '支出'}</span></td>
    <td>${esc(t.category)}</td>
    <td class="muted">${esc(t.account || '—')}</td>
    <td class="muted">${esc(t.note || '')}</td>
    <td class="num ${isIn ? 'pos' : 'neg'}">${isIn ? '+' : '−'}${money(t.amount)}</td>
    <td><div class="row-actions"><button class="btn-link btn-sm" data-edit="${t.id}" title="編輯">${icon('edit', 15)}</button><button class="btn-danger btn-sm" data-del="${t.id}" title="刪除">${icon('trash', 15)}</button></div></td>
  </tr>`;
}

function openTxForm(tx) {
  openForm({
    title: tx ? '編輯記錄' : '新增收支',
    fields: [
      { key: 'date', label: '日期', type: 'date', required: true, default: new Date().toISOString().slice(0, 10) },
      { key: 'type', label: '類型', type: 'select', options: [{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }] },
      { key: 'category', label: '分類', type: 'select', options: CATEGORIES },
      { key: 'amount', label: '金額', type: 'number', required: true, placeholder: '0' },
      { key: 'account', label: '帳戶 / 卡別', type: 'text', placeholder: '例：台新活存、信用卡' },
      { key: 'note', label: '備註', type: 'text', full: true }
    ],
    values: tx || {},
    onSubmit: async (data) => {
      if (tx) await api('/transactions/' + tx.id, { method: 'PUT', body: data });
      else await api('/transactions', { method: 'POST', body: data });
      toast('已儲存'); renderTransactions();
    }
  });
}
