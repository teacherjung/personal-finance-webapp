// @ts-check
// 收支記帳頁（三層重構 stage 1，使用者定 2026-07-20）：**現金流真相**——只顯示現金流帳本
//（!isCardTx：手動記帳 + 未來的銀行對帳單匯入）。信用卡刷卡消費不在這裡（在「信用卡消費明細」頁）；
// 銀行帳單裡的「繳卡費」那筆才是刷卡消費的現金流出，計入這裡。
// 三層分類：金流（收入/支出/內轉）→ 分類 → 子分類。金流用顏色/正負＋頂部篩選呈現；收入走 incomeTree、
// 支出沿用信用卡的 expenseTree（統計合得起來）、內轉固定 內轉出/內轉入（無分類樹）。
import { api, view, byId, wan, money, esc, monthKey, todayStr, openForm, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { icon } from './icons.js';
import { isCardTx } from './categories.js';
import { sortRows, thBuilder, bindSortClicks } from './tx-sort.js';

/** @type {Record<string, string[]>} */ let expTree = {};    // 支出樹（沿用信用卡的）
/** @type {Record<string, string[]>} */ let incTree = {};    // 收入樹（獨立）
const TRANSFER_SUBS = ['內轉出', '內轉入'];   // 內轉無分類樹，固定兩個子類（哪個帳戶出/入）

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
      <table><thead><tr>${th('date', '存提日')}${th('account', '銀行帳戶')}${th('note', '收支說明')}${th('category', '分類')}${th('subcategory', '子分類')}${th('amount', '金額', 'num')}<th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="7" class="empty">本月尚無記錄，點右上角「記一筆」，或到「信用卡消費明細」上傳帳單。</td></tr>`}</tbody></table>
    </div>
  `;

  byId('addCf').onclick = () => openCashflowForm(null, accounts);
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
    <td>${esc(t.date)}</td>
    <td class="muted">${esc(t.account || '—')}</td>
    <td class="muted">${esc(t.note || '—')}</td>
    <td><span class="flow-tag ${f.cls}">${f.label}</span> ${esc(t.category || '—')}</td>
    <td class="muted">${esc(t.subcategory || '—')}</td>
    <td class="num ${f.cls}">${f.sign}${money(t.amount)}</td>
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
