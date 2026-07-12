import { api, view, wan, money, esc, monthKey, todayStr, openForm, confirmDelete, toast, router, modalSizeClass } from '../app.js';
import { CHART } from './theme.js';
import { icon } from './icons.js';
import { EXPENSE_TREE, EXPENSE_PARENTS, INCOME_CATEGORIES, subsOf } from './categories.js';

// 表單分類選單＝收入類＋11 個支出分類；type 由所選分類自動推導
const ALL_CATEGORIES = [...INCOME_CATEGORIES, ...EXPENSE_PARENTS];
// 子類 <option>s（含「不分子類」空選項）
const subOptions = (parent, cur = '') => ['', ...subsOf(parent)]
  .map(s => `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${s === '' ? '（不分子類）' : esc(s)}</option>`).join('');

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
        ${all.some(t => t.source === 'stmt' && t.importBatch) ? `<button class="btn-ghost" id="stmtBatches">${icon('card', 16)}帳單批次</button>` : ''}
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
  const batchBtn = document.getElementById('stmtBatches');
  if (batchBtn) batchBtn.onclick = () => openBatchManager();
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
      { key: 'category', label: '分類', type: 'select', options: ALL_CATEGORIES, default: '飲食' },
      { key: 'subcategory', label: '子類（支出才有，可留白）', type: 'select', options: [] },   // 由 onMount 依分類連動
      { key: 'amount', label: '金額', type: 'number', required: true, placeholder: '0' },
      { key: 'account', label: '帳戶 / 信用卡', type: 'text', placeholder: '例：台新活存、富邦卡' },
      { key: 'note', label: '備註', type: 'text', full: true }
    ],
    values: tx || {},
    onMount: (root) => {
      const catSel = root.querySelector('#f_category');
      const subSel = root.querySelector('#f_subcategory');
      const fill = (parent, cur) => { subSel.innerHTML = subOptions(parent, cur); subSel.disabled = INCOME_CATEGORIES.includes(parent); };
      fill(catSel.value, tx?.subcategory || '');
      catSel.onchange = () => fill(catSel.value, '');
    },
    onSubmit: async (data) => {
      const type = INCOME_CATEGORIES.includes(data.category) ? 'income' : 'expense';
      const body = { ...data, type, subcategory: type === 'income' ? '' : (data.subcategory || '') };
      if (tx) await api('/transactions/' + tx.id, { method: 'PUT', body });
      else await api('/transactions', { method: 'POST', body });
      toast('已儲存'); renderTransactions();
    }
  });
}

// ---- 信用卡帳單匯入（上傳 PDF → 後端解密解析分類 → 預覽確認 → 寫入記帳）----
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
    title: '上傳信用卡帳單',
    fields: [
      { key: 'file', label: '帳單檔案（PDF 或 XLSX；系統自動辨識銀行與卡片，認不出才會請你選）', type: 'file', full: true }
    ],
    onMount: (root) => {
      const inp = root.querySelector('#f_file');
      if (inp) { inp.accept = '.pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; inp.onchange = () => { file = inp.files?.[0] || null; }; }
    },
    onSubmit: async (data) => {
      if (!file) throw new Error('請先選擇帳單檔案（PDF 或 XLSX）');
      const b64 = await fileToBase64(file);
      const r = await api('/statement/preview', { method: 'POST', body: { data: b64 } });
      // openForm 送出後會清空 #modal-root，後續彈窗也在 #modal-root，故延到關閉之後再畫
      setTimeout(() => handlePreviewResult(r, b64, cards), 0);
    }
  });
}

// 自動預覽結果：判得出卡片就直接預覽；認不出就請使用者從候選（或全部卡）選一張。
function handlePreviewResult(r, b64, cards) {
  if (r.resolvedCard) return openStatementPreview(r.resolvedCard.id, r, b64, cards);
  openCardChoice(r, b64, cards);
}

// 認不出卡片時請使用者選（候選優先，無候選則列全部信用卡），選後用該卡重新解析預覽。
function openCardChoice(r, b64, cards) {
  const pick = (r.candidates && r.candidates.length) ? r.candidates : cards;
  const detail = `${r.bank ? r.bank + '帳單' : '這份帳單'}${r.lastFour ? `（末四碼 ${esc(r.lastFour)}）` : ''}`;
  openForm({
    title: '選擇要記到哪張卡片',
    size: 'sm',
    fields: [
      { key: 'cardId', label: `${detail}，系統無法確定是哪張卡，請選：`, type: 'select',
        options: pick.map(c => ({ value: c.id, label: c.name + (c.lastFour ? `（${c.lastFour}）` : '') })) }
    ],
    onSubmit: async (data) => {
      const pr = await api(`/cards/${data.cardId}/statement/preview`, { method: 'POST', body: { data: b64 } });
      setTimeout(() => openStatementPreview(data.cardId, pr, b64, cards), 0);
    }
  });
}

// 預覽確認：頂部可改「記到哪張卡」（改了就用該卡重新解析＝重算重複標記）；只選「分類」（子類自動判斷用）；
// 可勾選；重複與繳款/退款預設不匯入。b64=原始檔（改卡重新解析用）、cards=所有信用卡。
function openStatementPreview(cardId, r, b64, cards) {
  const root = document.getElementById('modal-root');
  let curCard = cardId, curR = r;
  const detected = `${curR.bank ? esc(curR.bank) : '未知'}${curR.lastFour ? ` · 末四碼 ${esc(curR.lastFour)}` : ''}`;
  const close = () => { root.innerHTML = ''; };
  const catSelHtml = (i, cat, sub) => `<select data-cat="${i}" data-autocat="${esc(cat)}" data-autosub="${esc(sub || '')}">${EXPENSE_PARENTS.map(c =>
    `<option value="${esc(c)}" ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
  const cardOpts = () => cards.map(c => `<option value="${c.id}" ${c.id === curCard ? 'selected' : ''}>${esc(c.name)}${c.lastFour ? `（${esc(String(c.lastFour))}）` : ''}</option>`).join('');

  const doImport = async () => {
    const picked = [];
    root.querySelectorAll('input[data-row]:checked').forEach(cb => {
      const i = cb.dataset.row;
      const t = curR.transactions[Number(i)];
      const cat = root.querySelector(`select[data-cat="${i}"]`);
      const category = cat ? cat.value : t.category;
      // 分類沒改→沿用自動子類；改了→子類清空（原子類不屬於新分類）
      const subcategory = cat ? (cat.value === cat.dataset.autocat ? cat.dataset.autosub : '') : t.subcategory;
      picked.push({ ...t, category, subcategory });
    });
    if (!picked.length) return toast('沒有勾選任何項目', true);
    try {
      const out = await api(`/cards/${curCard}/statement/import`, { method: 'POST', body: { transactions: picked } });
      // 匯入後跳到「筆數最多」的月份：信用卡帳單主體常落在前一個月，避免停在幾乎空的最新月
      const mc = {};
      picked.forEach(t => { const m = (t.date || '').slice(0, 7); if (m) mc[m] = (mc[m] || 0) + 1; });
      const topMonth = Object.entries(mc).sort((a, b) => b[1] - a[1])[0];
      if (topMonth) monthFilter = topMonth[0];
      if (out.imported > 0) openImportDone(out);
      else { close(); toast(`沒有新增任何項目${out.skipped ? `（略過 ${out.skipped} 筆重複或不可匯入）` : ''}`); }
      renderTransactions();
    } catch (e) { toast('匯入失敗：' + e.message, true); }
  };

  const draw = () => {
    const rowsHtml = curR.transactions.map((t, i) => {
      const dis = t.isPayment;                       // 繳款/退款不可匯入
      const checked = !dis && !t.duplicate;          // 重複預設不勾
      const status = t.isPayment ? '<span class="tag">繳款/退款</span>'
        : t.duplicate ? '<span class="tag amber">已存在</span>' : '<span class="tag green">新</span>';
      return `<tr class="${dis ? 'muted' : ''}">
        <td><input type="checkbox" data-row="${i}" ${checked ? 'checked' : ''} ${dis ? 'disabled' : ''}></td>
        <td class="nowrap">${esc(t.date || '')}</td>
        <td title="${esc(t.desc)}">${esc(t.store || t.desc)}</td>
        <td>${dis ? '—' : catSelHtml(i, t.category, t.subcategory)}</td>
        <td class="num ${t.amount < 0 ? 'pos' : ''}">${money(Math.abs(t.amount))}${t.amount < 0 ? '（負）' : ''}</td>
        <td>${status}</td>
      </tr>`;
    }).join('');
    root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('xl')}">
      <div class="modal-head"><h2>帳單預覽（${detected}）</h2><button class="x-close">×</button></div>
      <div class="modal-body">
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <label style="margin:0;display:flex;align-items:center;gap:8px">記到卡片
            <select id="previewCard">${cardOpts()}</select></label>
          <span class="muted" style="font-size:12.5px">共 ${curR.transactions.length} 筆。判斷錯了可在此改卡片；分類可逐筆改；「已存在」＝之前匯過（預設不重記）；繳款/退款不列入。</span>
        </div>
        <div class="tbl-wrap" style="max-height:48vh;overflow-y:auto">
          <table><thead><tr><th></th><th>消費日</th><th>說明</th><th>分類</th><th class="num">金額</th><th>狀態</th></tr></thead>
          <tbody>${rowsHtml}</tbody></table>
        </div>
        <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button>
          <button type="button" class="btn" id="doImport">匯入勾選項目</button></div>
      </div>
    </div></div>`;
    root.querySelector('.x-close').onclick = close;
    root.querySelector('[data-cancel]').onclick = close;
    root.querySelector('#doImport').onclick = doImport;
    root.querySelector('#previewCard').onchange = async (e) => {
      const newId = e.target.value;
      try {
        const pr = await api(`/cards/${newId}/statement/preview`, { method: 'POST', body: { data: b64 } });
        curCard = newId; curR = pr; draw();   // 重算該卡的重複標記
      } catch (err) { toast('改卡片重新解析失敗：' + err.message, true); e.target.value = curCard; }
    };
  };

  draw();
}

// 匯入完成：確認記到哪張卡，選錯可當場整批改（其餘晚點也能從「帳單批次」改）。
function openImportDone(out) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('sm')}">
    <div class="modal-head"><h2>匯入完成</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p>已匯入 <b>${out.imported}</b> 筆到「<b>${esc(out.cardName || '')}</b>」${out.skipped ? `<span class="muted">，略過 ${out.skipped} 筆（重複或不可匯入）</span>` : ''}。</p>
      <p class="muted" style="font-size:12.5px;margin-top:6px">記錯卡片了嗎？可以現在整批改到別張卡（之後也能從右上「帳單批次」改）。</p>
      <div class="form-actions">
        <button type="button" class="btn-ghost" data-reassign>改到其他卡片</button>
        <button type="button" class="btn" data-done>完成</button>
      </div>
    </div>
  </div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-done]').onclick = close;
  root.querySelector('[data-reassign]').onclick = () =>
    openReassignPicker({ batchId: out.batchId, fromCardId: out.cardId, cardName: out.cardName }, () => { close(); renderTransactions(); });
}

// 帳單批次管理：列出每次匯入（卡片／日期範圍／筆數／金額），可整批改卡片。
async function openBatchManager() {
  const [batches, cards] = await Promise.all([api('/statement/batches'), api('/cards')]);
  const root = document.getElementById('modal-root');
  const render = (list) => {
    const rows = list.map(b => `<tr>
      <td>${esc(b.cardName || '—')}</td>
      <td class="nowrap muted">${esc(b.minDate || '')} ~ ${esc(b.maxDate || '')}</td>
      <td class="num">${b.count}</td>
      <td class="num">${money(b.amount)}</td>
      <td><div class="row-actions">
        <button class="btn-link btn-sm" data-reassign="${esc(b.batchId)}">改卡片</button>
        <button class="btn-danger btn-sm" data-delbatch="${esc(b.batchId)}" title="刪除整批">${icon('trash', 15)}</button>
      </div></td>
    </tr>`).join('');
    root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('lg')}">
      <div class="modal-head"><h2>帳單匯入批次</h2><button class="x-close">×</button></div>
      <div class="modal-body">
        <p class="muted" style="font-size:12.5px;margin-bottom:10px">每一列是一次帳單匯入。若當初選錯卡片，按「改卡片」整批改到正確的卡。</p>
        <div class="tbl-wrap"><table>
          <thead><tr><th>卡片</th><th>消費日範圍</th><th class="num">筆數</th><th class="num">金額</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">尚無匯入批次。</td></tr>'}</tbody>
        </table></div>
        <div class="form-actions"><button type="button" class="btn" data-close>關閉</button></div>
      </div>
    </div></div>`;
    root.querySelector('.x-close').onclick = () => { root.innerHTML = ''; };
    root.querySelector('[data-close]').onclick = () => { root.innerHTML = ''; };
    root.querySelectorAll('[data-reassign]').forEach(btn => btn.onclick = () => {
      const b = list.find(x => x.batchId === btn.dataset.reassign);
      openReassignPicker({ batchId: b.batchId, cardName: b.cardName }, openBatchManager, cards);
    });
    root.querySelectorAll('[data-delbatch]').forEach(btn => btn.onclick = () => {
      const b = list.find(x => x.batchId === btn.dataset.delbatch);
      confirmDelete(`整批 ${b.count} 筆（${b.cardName}，${b.minDate}~${b.maxDate}）`, async () => {
        const r = await api('/statement/batch/delete', { method: 'POST', body: { batchId: b.batchId } });
        toast(`已刪除 ${r.removed} 筆`);
        setTimeout(() => { openBatchManager(); renderTransactions(); }, 0);
      });
    });
  };
  render(batches);
}

// 改卡片選擇器：挑目標卡片 → 呼叫 reassign。cardsCache 可省一次請求。
async function openReassignPicker({ batchId, fromCardId, cardName }, onDone, cardsCache) {
  const cards = (cardsCache || await api('/cards')).filter(c => (c.type || 'credit') === 'credit' && c.id !== fromCardId);
  if (!cards.length) return toast('沒有其他信用卡可改（請先到「卡片追蹤」新增）', true);
  openForm({
    title: '整批改到其他卡片',
    size: 'sm',
    fields: [
      { key: 'toCardId', label: `目前記在「${cardName || '—'}」，改到：`, type: 'select',
        options: cards.map(c => ({ value: c.id, label: c.name })) }
    ],
    onSubmit: async (data) => {
      const r = await api('/statement/reassign', { method: 'POST', body: { batchId, toCardId: data.toCardId } });
      toast(`已改到「${r.cardName}」，${r.moved} 筆${r.dropped ? `（${r.dropped} 筆與該卡重複已略過）` : ''}`);
      if (onDone) setTimeout(onDone, 0);   // 待 openForm 關閉清空 modal-root 後再重繪，避免被 close() 蓋掉
    }
  });
}
