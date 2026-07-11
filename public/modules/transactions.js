import { api, view, wan, money, esc, monthKey, todayStr, openForm, confirmDelete, toast, router, modalSizeClass } from '../app.js';
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
      <div class="page-actions">
        <button class="btn-ghost" id="uploadStmt">${icon('upload', 16)}上傳信用卡帳單</button>
        <button class="btn" id="addTx">${icon('plus', 16)}新增一筆</button>
      </div>
    </div>

    <div class="cards">
      <div class="card"><h3>本月收入</h3><div class="stat sm pos">${wan(income)}</div></div>
      <div class="card"><h3>本月支出</h3><div class="stat sm neg">${wan(expense)}</div></div>
      <div class="card"><h3>本月結餘</h3><div class="stat sm ${income - expense >= 0 ? 'pos' : 'neg'}">${income - expense >= 0 ? '+' : ''}${wan(income - expense)}</div></div>
    </div>

    <div class="two-col" style="margin:18px 0">
      <div>
        <label>月份</label>
        <select id="monthSel">${months.map(m => `<option value="${esc(m)}" ${m === monthFilter ? 'selected' : ''}>${esc(m)}</option>`).join('') || `<option>${monthFilter}</option>`}</select>
      </div>
      <div class="chart-card" style="padding:14px 18px">
        <h3 style="margin-bottom:10px">本月支出分類</h3>
        ${topCats.length ? topCats.map(([c, v]) => `
          <div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${esc(c)}</span><span class="muted">${money(v)}</span></div>
            <div class="pill-bar"><div style="width:${(v / maxCat * 100).toFixed(0)}%;background:${CHART.red}"></div></div>
          </div>`).join('') : '<p class="empty">本月尚無支出。</p>'}
      </div>
    </div>

    <div class="tbl-wrap">
      <table><thead><tr><th>日期</th><th>類型</th><th>分類</th><th>帳戶</th><th>備註</th><th class="num">金額</th><th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="7" class="empty">尚無記錄，點右上角新增。</td></tr>`}</tbody></table>
    </div>
  `;

  document.getElementById('addTx').onclick = () => openTxForm();
  document.getElementById('uploadStmt').onclick = () => openStatementUpload();
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
      { key: 'date', label: '日期', type: 'date', required: true, default: todayStr() },   // 用本地時區（UTC 版在台灣早上 8 點前會差一天）
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

// ---- 信用卡帳單匯入（上傳 PDF → 後端解密解析分類 → 預覽確認 → 寫入記帳）----
const EXPENSE_CATEGORIES = CATEGORIES.filter(c => !['薪資', '獎金', '其他收入', '投資'].includes(c));

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('讀取檔案失敗'));
    fr.readAsDataURL(file);
  });
}

async function openStatementUpload() {
  const cards = (await api('/cards')).filter(c => (c.type || 'credit') === 'credit');
  if (!cards.length) return toast('請先到「卡片追蹤」新增一張信用卡', true);
  let file = null;
  openForm({
    title: '上傳信用卡帳單（PDF）',
    fields: [
      { key: 'cardId', label: '卡片（密碼自動取用卡片的「帳單 PDF 密碼」）', type: 'select',
        options: cards.map(c => ({ value: c.id, label: c.pdfPassword ? c.name : `${c.name}（未設定 PDF 密碼）` })) },
      { key: 'file', label: '帳單 PDF 檔案', type: 'file', full: true }
    ],
    onMount: (root) => {
      const inp = root.querySelector('#f_file');
      if (inp) { inp.accept = 'application/pdf'; inp.onchange = () => { file = inp.files?.[0] || null; }; }
    },
    onSubmit: async (data) => {
      if (!file) throw new Error('請先選擇帳單 PDF 檔案');
      const b64 = await fileToBase64(file);
      const r = await api(`/cards/${data.cardId}/statement/preview`, { method: 'POST', body: { data: b64 } });
      openStatementPreview(data.cardId, r);
    }
  });
}

// 預覽確認：分類可改、可勾選；重複與繳款/退款預設不匯入
function openStatementPreview(cardId, r) {
  const root = document.getElementById('modal-root');
  const catSel = (i, cur) => `<select data-cat="${i}">${EXPENSE_CATEGORIES.map(c =>
    `<option value="${esc(c)}" ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
  const rowsHtml = r.transactions.map((t, i) => {
    const dis = t.isPayment;                       // 繳款/退款不可匯入
    const checked = !dis && !t.duplicate;          // 重複預設不勾
    const status = t.isPayment ? '<span class="tag">繳款/退款</span>'
      : t.duplicate ? '<span class="tag amber">已存在</span>' : '<span class="tag green">新</span>';
    return `<tr class="${dis ? 'muted' : ''}">
      <td><input type="checkbox" data-row="${i}" ${checked ? 'checked' : ''} ${dis ? 'disabled' : ''}></td>
      <td class="nowrap">${esc(t.date || '')}</td>
      <td>${esc(t.desc)}</td>
      <td>${dis ? '—' : catSel(i, t.category)}</td>
      <td class="num ${t.amount < 0 ? 'pos' : ''}">${money(Math.abs(t.amount))}${t.amount < 0 ? '（負）' : ''}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('xl')}">
    <div class="modal-head"><h2>帳單預覽：${esc(r.card?.name || '')}（${esc(r.bank || '')}）</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p class="muted" style="font-size:12.5px;margin-bottom:10px">共 ${r.transactions.length} 筆。分類是自動判斷的初稿，可逐筆修改；「已存在」＝之前匯入過（預設不重複記）；繳款/退款不列入支出。按「匯入」才會寫進記帳。</p>
      <div class="tbl-wrap" style="max-height:50vh;overflow-y:auto">
        <table><thead><tr><th></th><th>消費日</th><th>說明</th><th>分類</th><th class="num">金額</th><th>狀態</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table>
      </div>
      <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button>
        <button type="button" class="btn" id="doImport">匯入勾選項目</button></div>
    </div>
  </div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  root.querySelector('#doImport').onclick = async () => {
    const picked = [];
    root.querySelectorAll('input[data-row]:checked').forEach(cb => {
      const t = r.transactions[Number(cb.dataset.row)];
      const sel = root.querySelector(`select[data-cat="${cb.dataset.row}"]`);
      picked.push({ ...t, category: sel ? sel.value : t.category });
    });
    if (!picked.length) return toast('沒有勾選任何項目', true);
    try {
      const out = await api(`/cards/${cardId}/statement/import`, { method: 'POST', body: { transactions: picked } });
      close();
      toast(`已匯入 ${out.imported} 筆${out.skipped ? `，略過 ${out.skipped} 筆（重複或不可匯入）` : ''}`);
      renderTransactions();
    } catch (e) { toast('匯入失敗：' + e.message, true); }
  };
}
