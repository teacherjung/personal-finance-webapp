// @ts-check
// 收支記帳頁（三層重構 stage 1，使用者定 2026-07-20）：**現金流真相**——只顯示現金流帳本
//（!isCardTx：手動記帳 + 未來的銀行對帳單匯入）。信用卡刷卡消費不在這裡（在「信用卡消費明細」頁）；
// 銀行帳單裡的「繳卡費」那筆才是刷卡消費的現金流出，計入這裡。
// 三層分類：金流（收入/支出/內轉）→ 分類 → 子分類。金流用顏色/正負＋頂部篩選呈現；收入走 incomeTree、
// 支出沿用信用卡的 expenseTree（統計合得起來）、內轉固定 內轉出/內轉入（無分類樹）。
import { api, view, byId, wan, money, esc, monthKey, todayStr, openForm, openInfo, confirmDelete, toast, currentRouteSeq, modalSizeClass } from '../app.js';
import { icon } from './icons.js';
import { isCardTx } from './categories.js';
import { sortRows, thBuilder, bindSortClicks } from './tx-sort.js';

/** @type {Record<string, string[]>} */ let expTree = {};    // 支出樹（沿用信用卡的）
/** @type {Record<string, string[]>} */ let incTree = {};    // 收入樹（獨立）
const TRANSFER_SUBS = ['內轉出', '內轉入', '交割'];   // 內轉無分類樹：帳戶出/入＋證券劃撥交割（使用者定 2026-07-21）

let monthFilter = monthKey();
let flowFilter = 'all';   // 金流篩選：all / income / expense / transfer
const listSort = { key: 'date', dir: 'desc' };

/** 金流別（顯示/篩選用）：income/expense/transfer → 中文＋顏色 class。 @param {any} t */
function flowOf(t) {
  if (t.type === 'income') return { label: '收入', cls: 'pos', sign: '+' };
  if (t.type === 'transfer') return { label: '內轉', cls: 'muted', sign: '' };
  return { label: '支出', cls: 'neg', sign: '−' };
}

export async function renderCashflow() {
  const seq = currentRouteSeq();
  const [allRaw, accounts, expTreeRes, incTreeRes] = await Promise.all([
    api('/transactions'), api('/accounts'), api('/categories'), api('/income-categories')]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別覆蓋新頁面（Codex r10#6）
  expTree = expTreeRes && typeof expTreeRes === 'object' ? expTreeRes : {};
  incTree = incTreeRes && typeof incTreeRes === 'object' ? incTreeRes : {};
  const all = allRaw.filter(t => !isCardTx(t));   // 只吃現金流帳本
  const months = [...new Set(all.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  if (!months.includes(monthFilter) && months.length) monthFilter = months[0];

  const th = thBuilder(listSort);
  const monthRows = all.filter(t => t.date?.slice(0, 7) === monthFilter);
  // 本月三張卡（內轉不進收入/支出加總，只影響帳戶間流動——與後端 derive.computeCashflow 同口徑）
  const income = monthRows.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount || 0), 0);
  const expense = monthRows.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount || 0), 0);
  // 篩選金流後再排序
  const rows = sortRows(monthRows.filter(t => flowFilter === 'all'
    || (flowFilter === 'transfer' ? t.type === 'transfer' : t.type === flowFilter)), listSort);

  const flowTab = (val, label) => `<button class="chip${flowFilter === val ? ' active' : ''}" data-flow="${val}">${label}</button>`;

  view().innerHTML = `
    <div class="page-head">
      <div><h1>收支記帳</h1><p>以銀行對帳單為準的真實現金流：收入、支出、帳戶互轉</p></div>
      <div class="page-actions">
        ${all.some(t => t.source === 'bank') ? `<button class="btn-ghost btn-eq" id="bankBatches">${icon('history', 16)}匯入紀錄</button>` : ''}
        <button class="btn-ghost btn-eq" id="uploadBank">${icon('upload', 16)}上傳銀行對帳單</button>
        <button class="btn btn-eq" id="addCf">${icon('plus', 16)}記一筆</button>
      </div>
    </div>

    <div class="cards">
      <div class="card"><h3>本月收入</h3><div class="stat sm pos">${wan(income)}</div></div>
      <div class="card"><h3>本月支出</h3><div class="stat sm neg">${wan(expense)}</div></div>
      <div class="card"><h3>本月結餘</h3><div class="stat sm ${income - expense >= 0 ? 'pos' : 'neg'}">${income - expense >= 0 ? '+' : ''}${wan(income - expense)}</div></div>
    </div>

    <div class="two-col" style="margin:18px 0;align-items:end">
      <div>
        <label>月份</label>
        <select id="monthSel">${months.map(m => `<option value="${esc(m)}" ${m === monthFilter ? 'selected' : ''}>${esc(m)}</option>`).join('') || `<option>${monthFilter}</option>`}</select>
      </div>
      <div>
        <label>金流</label>
        <div class="chip-row">${flowTab('all', '全部')}${flowTab('income', '收入')}${flowTab('expense', '支出')}${flowTab('transfer', '內轉')}</div>
      </div>
    </div>

    <div class="tbl-wrap">
      <table><thead><tr>${th('date', '收支日')}${th('account', '銀行帳戶')}${th('note', '收支說明')}${th('category', '分類')}${th('subcategory', '子分類')}${th('amount', '金額', 'num')}<th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="7" class="empty">本月尚無記錄，點右上角「記一筆」，或到「信用卡消費明細」上傳帳單。</td></tr>`}</tbody></table>
    </div>
  `;

  byId('addCf').onclick = () => openCashflowForm(null, accounts);
  byId('uploadBank').onclick = () => openBankUpload();
  { const bb = byId('bankBatches'); if (bb) bb.onclick = () => openBankBatchManager(); }
  byId('monthSel').onchange = (e) => { monthFilter = /** @type {any} */ (e.target).value; renderCashflow(); };
  view().querySelectorAll('[data-flow]').forEach(b => /** @type {HTMLElement} */ (b).onclick = () => {
    flowFilter = /** @type {HTMLElement} */ (b).dataset.flow || 'all'; renderCashflow();
  });
  bindSortClicks(view(), listSort, renderCashflow);
  view().querySelectorAll('[data-edit]').forEach(b => /** @type {HTMLElement} */ (b).onclick = () => openCashflowForm(all.find(t => t.id === /** @type {HTMLElement} */ (b).dataset.edit), accounts));
  view().querySelectorAll('[data-del]').forEach(b => /** @type {HTMLElement} */ (b).onclick = () => {
    const t = all.find(x => x.id === /** @type {HTMLElement} */ (b).dataset.del);
    confirmDelete(`${flowOf(t).label} ${money(t.amount)}`, () => api('/transactions/' + t.id, { method: 'DELETE' }));
  });
}

function rowHtml(t) {
  const f = flowOf(t);
  return `<tr>
    <td class="nowrap">${esc(t.date)}</td>
    <td class="muted">${esc(t.account || '—')}</td>
    <td class="muted"><div class="cf-note" title="${esc(t.note || '')}">${esc(t.note || '—')}</div></td>
    <td>${esc(t.category || '—')}</td>
    <td class="muted">${esc(t.subcategory || '—')}</td>
    <td class="num nowrap ${f.cls}">${f.sign}${money(t.amount)}</td>
    <td><div class="row-actions"><button class="btn-link btn-sm" data-edit="${t.id}" title="編輯">${icon('edit', 15)}</button><button class="btn-danger btn-sm" data-del="${t.id}" title="刪除">${icon('trash', 15)}</button></div></td>
  </tr>`;
}

// 銀行帳戶下拉＝資產配置的現金帳戶（三層重構：收支的帳戶與帳戶明細連動）＋保留現有值。
/** @param {any[]} accounts @param {string=} current */
function accountOptions(accounts, current) {
  const names = (accounts || []).map(a => a.name).filter(Boolean);
  const uniq = [...new Set(names)];
  if (current && !uniq.includes(current)) uniq.unshift(current);
  return [{ value: '', label: '（不指定）' }, ...uniq.map(n => ({ value: n, label: n }))];
}

/** 依金流別回傳分類選單來源。 @param {string} flow */
function parentsForFlow(flow) {
  if (flow === 'income') return Object.keys(incTree);
  if (flow === 'transfer') return ['內轉'];
  return Object.keys(expTree);
}
/** 依金流別＋分類回傳子類 <option>s（含不分子類）。 @param {string} flow @param {string} parent @param {string} cur */
function subOptionsFor(flow, parent, cur = '') {
  let subs;
  if (flow === 'transfer') subs = TRANSFER_SUBS;
  else if (flow === 'income') subs = (Object.hasOwn(incTree, parent) && incTree[parent]) || [];
  else subs = (Object.hasOwn(expTree, parent) && expTree[parent]) || [];
  const allowBlank = flow !== 'transfer';   // 內轉一定要選出/入；收支可不分子類
  return [...(allowBlank ? [''] : []), ...subs]
    .map(s => `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${s === '' ? '（不分子類）' : esc(s)}</option>`).join('');
}

// ---- 上傳銀行對帳單（三層重構 stage 2：概要區→更新/建立帳戶餘額）----
/** 檔案 → base64（同 transactions.js 的做法；密碼只在記憶體、隨請求送、不落檔）。 @param {File} file */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('讀取檔案失敗'));
    fr.readAsDataURL(file);
  });
}

async function openBankUpload() {
  let file = null;
  openForm({
    title: '上傳銀行對帳單',
    fields: [
      { key: 'file', label: '對帳單 PDF（台新綜合對帳單）', type: 'file', full: true },
      { key: 'password', label: '對帳單密碼（只在這台電腦解密、不會上傳、不會儲存）', type: 'password', full: true, placeholder: '通常是身分證字號' },
    ],
    onMount: (/** @type {any} */ root) => {
      const inp = root.querySelector('#f_file');
      if (inp) { inp.accept = '.pdf,application/pdf'; inp.onchange = () => { file = inp.files?.[0] || null; }; }
    },
    onSubmit: async (/** @type {any} */ data) => {
      if (!file) throw new Error('請先選擇對帳單 PDF');
      const b64 = await fileToBase64(file);
      const pw = data.password || '';
      const r = await api('/bank-statement/preview', { method: 'POST', body: { data: b64, password: pw } });
      setTimeout(() => showBankPreview(r, b64, pw), 0);   // 待 openForm 清空 modal-root 後再開預覽窗
    }
  });
}

const ACTION_LABEL = { update: '更新餘額', create: '新建帳戶', 'skip-stale': '跳過（帳單同期或較舊）', unsupported: '跳過（不支援幣別）', blocked: '無法更新（讀不到參考日）' };
/** @param {any} r 預覽結果 @param {string} b64 @param {string} pw */
function showBankPreview(r, b64, pw) {
  const rows = r.rows || [];
  const willUpdate = rows.filter((/** @type {any} */ x) => x.action === 'update').length;
  const willCreate = rows.filter((/** @type {any} */ x) => x.action === 'create').length;
  const tx = r.transactions || { rows: [], counts: {} };
  const c = tx.counts || {};
  // 交易分箱預覽（前 12 筆；金流用顏色）：讓使用者匯入前看到自動分箱，之後可在收支列表逐筆改
  const flowCls = (/** @type {string} */ t) => t === 'income' ? 'pos' : t === 'transfer' ? 'muted' : 'neg';
  const flowLbl = (/** @type {string} */ t) => t === 'income' ? '收入' : t === 'transfer' ? '內轉' : '支出';
  const previewTx = (tx.rows || []).filter((/** @type {any} */ x) => !x.duplicate).slice(0, 12);
  const body = `
    <p class="muted" style="margin-bottom:10px">現值參考日：<b>${esc(r.referenceDate || '—')}</b>　餘額只有帳單較新時才覆蓋。</p>
    <div class="section-title" style="margin-top:0">帳戶餘額</div>
    <div class="tbl-wrap"><table><thead><tr><th>帳戶</th><th>幣別</th><th class="num">帳單餘額</th><th class="num">目前餘額</th><th>動作</th></tr></thead>
    <tbody>${rows.map((/** @type {any} */ x) => `<tr>
      <td>${esc(x.matchedName || x.label || '')}<span class="muted">・末${esc(x.suffix)}</span></td>
      <td class="muted">${esc(x.currency)}</td>
      <td class="num">${money(x.balance)}</td>
      <td class="num muted">${x.oldBalance == null ? '—' : money(x.oldBalance)}</td>
      <td>${esc(ACTION_LABEL[x.action] || x.action)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">帳單裡沒有可更新的帳戶。</td></tr>'}</tbody></table></div>
    <p class="muted" style="margin:8px 0 18px;font-size:12px">將更新 ${willUpdate} 個、新建 ${willCreate} 個帳戶（反映在「資產配置」）。</p>

    <div class="section-title">交易分箱（自動判斷，匯入後可在收支列表逐筆改）</div>
    <p class="muted" style="margin-bottom:8px">收入 <b class="pos">${c.income || 0}</b> 筆・支出 <b class="neg">${c.expense || 0}</b> 筆・內轉 <b>${c.transfer || 0}</b> 筆${c.duplicate ? `・重複略過 ${c.duplicate} 筆` : ''}。內轉（帳戶互轉、證券劃撥）不計入收支。</p>
    ${previewTx.length ? `<div class="tbl-wrap"><table><thead><tr><th>日期</th><th>帳戶</th><th>說明</th><th>金流・分類</th><th class="num">金額</th></tr></thead>
    <tbody>${previewTx.map((/** @type {any} */ x) => `<tr>
      <td>${esc(x.date)}</td><td class="muted">${esc(String(x.account || '').slice(0, 10))}</td>
      <td class="muted">${x.learned ? '<span class="flow-tag" title="用你之前教過的分類／名稱自動套用">已學</span> ' : ''}${esc(String((x.learned && x.note) ? x.note : (x.summary || '')))}</td>
      <td><span class="flow-tag ${flowCls(x.type)}">${flowLbl(x.type)}</span> ${esc(x.category || '（不分類）')}${x.subcategory ? '・' + esc(x.subcategory) : ''}</td>
      <td class="num ${flowCls(x.type)}">${money(x.amount)}</td>
    </tr>`).join('')}</tbody></table></div>${(tx.rows || []).filter((/** @type {any} */ x) => !x.duplicate).length > 12 ? `<p class="muted" style="font-size:11px;margin-top:6px">…只顯示前 12 筆，共 ${(tx.rows || []).filter((/** @type {any} */ x) => !x.duplicate).length} 筆</p>` : ''}` : '<p class="empty">帳單裡沒有新交易。</p>'}
    <div class="page-actions" style="margin-top:16px"><button class="btn" id="bankApply">${icon('check', 16)}確認：更新餘額＋匯入交易</button></div>`;
  openInfo('銀行對帳單預覽', body, { size: 'xl' });
  setTimeout(() => {
    const btn = byId('bankApply');
    if (btn) btn.onclick = async () => {
      try {
        const res = await api('/bank-statement/apply', { method: 'POST', body: { data: b64, password: pw } });
        const t = res.transactions || {};
        toast(`帳戶：更新 ${res.updated}、新建 ${res.created}${res.skipped ? `、跳過 ${res.skipped}` : ''}${res.unsupported ? `、略過 ${res.unsupported} 個不支援幣別` : ''}；交易：匯入 ${t.imported || 0}${t.skipped ? `、去重 ${t.skipped}` : ''}`);
        document.querySelector('#modal-root')?.replaceChildren();
        renderCashflow();
      } catch (e) { toast(/** @type {any} */ (e).message || '更新失敗', true); }
    };
  }, 0);
}

// ---- 銀行對帳單匯入紀錄（比照信用卡帳單的「匯入紀錄」）：列出每次上傳匯入的批次，可整批刪除後重新上傳。----
// 刪除只移除該批「現金流交易」、不動帳戶餘額（餘額是當前快照；重新上傳同帳單會依現值參考日重設）。
async function openBankBatchManager() {
  const batches = await api('/bank-statement/batches');
  const root = byId('modal-root');
  const render = (/** @type {any[]} */ list) => {
    const rows = list.map(b => `<tr>
      <td class="nowrap" title="存提日範圍">${esc(b.minDate || '')} ~ ${esc(b.maxDate || '')}</td>
      <td class="num">${b.count}</td>
      <td class="num pos">${b.income ? '+' + money(b.income) : '<span class="muted">—</span>'}</td>
      <td class="num neg">${b.expense ? '−' + money(b.expense) : '<span class="muted">—</span>'}</td>
      <td class="num muted">${b.transfer ? money(b.transfer) : '—'}</td>
      <td><button class="btn-danger btn-sm" data-delbatch="${esc(b.batchId)}" title="刪除整批">${icon('trash', 15)}</button></td>
    </tr>`).join('');
    root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('lg')}">
      <div class="modal-head"><h2>銀行對帳單匯入紀錄</h2><button class="x-close">×</button></div>
      <div class="modal-body">
        <ul class="muted batch-help" style="font-size:12.5px;margin:0 0 12px 18px;line-height:1.9;padding:0">
          <li>每一列代表<b class="hl">「一次對帳單上傳」</b>匯入的現金流交易。</li>
          <li>分箱判斷不對、或想換一份帳單重來，可整批<b class="hl">「刪除」</b>後重新上傳。</li>
          <li>刪除只移除這批<b class="hl">「收支交易」</b>；<b class="hl">帳戶餘額不動</b>（重新上傳同一份帳單會自動重設）。</li>
        </ul>
        <div class="tbl-wrap"><table>
          <thead><tr><th>日期範圍</th><th class="num">筆數</th><th class="num">收入</th><th class="num">支出</th><th class="num">內轉</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">尚無銀行對帳單匯入批次。</td></tr>'}</tbody>
        </table></div>
        <div class="form-actions"><button type="button" class="btn" data-close>關閉</button></div>
      </div>
    </div></div>`;
    root.querySelector('.x-close').onclick = () => { root.innerHTML = ''; };
    root.querySelector('[data-close]').onclick = () => { root.innerHTML = ''; };
    root.querySelectorAll('[data-delbatch]').forEach(btn => /** @type {HTMLElement} */ (btn).onclick = () => {
      const b = list.find(x => x.batchId === /** @type {HTMLElement} */ (btn).dataset.delbatch);
      confirmDelete(`整批 ${b.count} 筆（${b.minDate}~${b.maxDate}）`, async () => {
        const r = await api('/bank-statement/batch/delete', { method: 'POST', body: { batchId: b.batchId } });
        toast(`已刪除 ${r.removed} 筆，可重新上傳`);
        const rest = await api('/bank-statement/batches');   // 刪光了就關視窗（不留「尚無批次」的死巷，因入口鈕也一併消失）；還有批次才重繪
        setTimeout(() => { if (rest.length) render(rest); else root.innerHTML = ''; }, 0);
      });
    });
  };
  render(batches);
}

/** @param {any=} tx @param {any[]=} accounts */
function openCashflowForm(tx, accounts = []) {
  // 金流別由既有 type 推導（編輯）或預設收入（新增）
  const initFlow = tx ? (tx.type === 'income' ? 'income' : tx.type === 'transfer' ? 'transfer' : 'expense') : 'income';
  openForm({
    title: tx ? '編輯收支' : '記一筆收支',
    fields: [
      { key: 'flow', label: '金流', type: 'select', options: [
        { value: 'income', label: '收入' }, { value: 'expense', label: '支出' }, { value: 'transfer', label: '內轉（帳戶互轉）' }], default: initFlow },
      { key: 'date', label: '存提日', type: 'date', required: true, default: todayStr() },
      { key: 'account', label: '銀行帳戶', type: 'select', options: accountOptions(accounts, tx?.account) },
      { key: 'category', label: '分類', type: 'select', options: [] },       // onMount 依金流連動
      { key: 'subcategory', label: '子分類', type: 'select', options: [] },   // onMount 依分類連動
      { key: 'amount', label: '金額', type: 'number', required: true, placeholder: '0' },
      { key: 'note', label: '收支說明', type: 'text', full: true, placeholder: '例：房租、William 鐘點、統一發票中獎' },
    ],
    values: tx ? { ...tx, flow: initFlow } : {},
    onMount: (/** @type {any} */ root) => {
      const flowSel = root.querySelector('#f_flow');
      const catSel = root.querySelector('#f_category');
      const subSel = root.querySelector('#f_subcategory');
      const fillCats = (flow, curCat, curSub) => {
        const parents = parentsForFlow(flow);
        catSel.innerHTML = parents.map(p => `<option value="${esc(p)}" ${p === curCat ? 'selected' : ''}>${esc(p)}</option>`).join('');
        const chosen = parents.includes(curCat) ? curCat : (parents[0] || '');
        catSel.value = chosen;
        subSel.innerHTML = subOptionsFor(flow, chosen, curSub);
      };
      fillCats(flowSel.value, tx?.category || '', tx?.subcategory || '');
      flowSel.onchange = () => fillCats(flowSel.value, '', '');
      catSel.onchange = () => { subSel.innerHTML = subOptionsFor(flowSel.value, catSel.value, ''); };
    },
    onSubmit: async (data) => {
      const flow = data.flow;
      const type = flow === 'income' ? 'income' : flow === 'transfer' ? 'transfer' : 'expense';
      const body = {
        type, date: data.date, account: data.account || '', note: data.note || '',
        category: flow === 'transfer' ? '內轉' : (data.category || ''),
        subcategory: data.subcategory || '', amount: data.amount,
      };
      if (tx) await api('/transactions/' + tx.id, { method: 'PUT', body });
      else await api('/transactions', { method: 'POST', body });
      toast('已儲存');
      renderCashflow();
    }
  });
}
