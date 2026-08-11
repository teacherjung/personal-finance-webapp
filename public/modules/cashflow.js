// @ts-check
// 銀行收支頁（三層重構 stage 1，使用者定 2026-07-20）：**現金流真相**——只顯示現金流帳本
//（!isCardTx：手動記帳 + 未來的銀行對帳單匯入）。信用卡刷卡消費不在這裡（在「信用卡消費明細」頁）；
// 銀行帳單裡的「繳卡費」那筆才是刷卡消費的現金流出，計入這裡。
// 三層分類：金流（收入/支出/內轉）→ 分類 → 子分類。金流用顏色/正負＋頂部篩選呈現；收入走 incomeTree、
// 支出沿用信用卡的 expenseTree（統計合得起來）、內轉固定 內轉出/內轉入（無分類樹）。
import { api, view, byId, wan, money, esc, monthKey, todayStr, openForm, openInfo, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { icon } from './icons.js';
import { isCardTx } from './categories.js';
import { sortRows, thBuilder, bindSortClicks } from './tx-sort.js';
import { fileToBase64 } from './file-util.js';
import { deriveMonths, fallbackMonth, monthOptionsHtml } from './month-select.js';
import { openModalShell } from './modal-shell.js';
import { cashflowMonthSummary, cashflowPeriodLabel, bankUploadGate, runBankUpload, REMEMBER_PW_LABEL } from './cashflow-model.js';
import { selectOptionsHtml, effectiveSelectValue, subcategoryOptionsHtml } from './form-options.js';
import { gateSummaryHtml } from './reconcile-summary.js';
// 問模式的等待上限與計時器住在匯出模組（第一個需要問 /api/mode 的畫面）；第二個消費者直接借用、不另抄一份。
import { defaultWithTimeout, MODE_TIMEOUT_MS } from './backup-export.js';

/** @type {Record<string, string[]>} */ let expTree = {};    // 支出樹（沿用信用卡的）
/** @type {Record<string, string[]>} */ let incTree = {};    // 收入樹（獨立）
/** @type {string[]} */ let transferSubs = ['內轉出', '內轉入', '交割'];   // 內轉子分類（可全編輯，使用者定 2026-07-21）；renderCashflow 從 /transfer-subcategories 載入現行清單

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
  const [allRaw, accounts, expTreeRes, incTreeRes, transferRes] = await Promise.all([
    api('/transactions'), api('/accounts'), api('/categories'), api('/income-categories'), api('/transfer-subcategories')]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別覆蓋新頁面（Codex r10#6）
  expTree = expTreeRes && typeof expTreeRes === 'object' ? expTreeRes : {};
  incTree = incTreeRes && typeof incTreeRes === 'object' ? incTreeRes : {};
  if (Array.isArray(transferRes) && transferRes.length) transferSubs = transferRes.map(s => s.label).filter(Boolean);
  const all = allRaw.filter(t => !isCardTx(t));   // 只吃現金流帳本
  const months = deriveMonths(all);
  monthFilter = fallbackMonth(monthFilter, months);

  const th = thBuilder(listSort);
  // 所選月份摘要（內轉不進收入/支出加總，只影響帳戶間流動——與後端 derive.computeCashflow 同口徑）
  const { monthRows, income, expense, net } = cashflowMonthSummary(all, monthFilter);
  const periodLabel = cashflowPeriodLabel(monthFilter);
  // 篩選金流後再排序
  const rows = sortRows(monthRows.filter(t => flowFilter === 'all'
    || (flowFilter === 'transfer' ? t.type === 'transfer' : t.type === flowFilter)), listSort);

  const flowTab = (val, label) => `<button class="chip${flowFilter === val ? ' active' : ''}" data-flow="${val}" aria-pressed="${flowFilter === val}">${label}</button>`;

  view().innerHTML = `
    <div class="cashflow-workspace">
      <div class="page-head cashflow-head">
        <div><h1>銀行收支</h1><p>以銀行對帳單為準的真實現金流：收入、支出、帳戶互轉</p></div>
        <div class="page-actions">
          ${all.some(t => t.source === 'bank') ? `<button class="btn-ghost btn-eq" id="bankBatches">${icon('history', 16)}匯入紀錄</button>` : ''}
          <button class="btn btn-upload" id="uploadBank">${icon('upload', 16)}上傳銀行對帳單</button>
          <button class="btn btn-eq" id="addCf">${icon('plus', 16)}記一筆</button>
        </div>
      </div>

      <section class="cashflow-controls" aria-label="銀行收支篩選">
        <div class="cashflow-control">
          <label for="monthSel">月份</label>
          <select id="monthSel">${monthOptionsHtml(months, monthFilter, esc)}</select>
        </div>
        <div class="cashflow-control cashflow-flow-control">
          <span class="cashflow-control-label">明細金流</span>
          <div class="chip-row" role="group" aria-label="金流篩選">${flowTab('all', '全部')}${flowTab('income', '收入')}${flowTab('expense', '支出')}${flowTab('transfer', '內轉')}</div>
        </div>
      </section>

      <section class="cashflow-summary" aria-label="${esc(periodLabel)}銀行收支摘要">
        <div class="cashflow-summary-head">
          <div><span>收支期間</span><strong>${esc(periodLabel)}</strong></div>
          <p>以銀行對帳單為準；內轉不列入收入與支出</p>
        </div>
        <div class="cashflow-summary-grid">
          <div class="cashflow-stat" data-kind="income"><h3>收入</h3><div class="stat sm pos">${wan(income)}</div><p>匯入與手動記錄</p></div>
          <div class="cashflow-stat" data-kind="expense"><h3>支出</h3><div class="stat sm neg">${wan(expense)}</div><p>不含帳戶內轉</p></div>
          <div class="cashflow-stat" data-kind="net"><h3>結餘</h3><div class="stat sm ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${wan(net)}</div><p>收入減支出</p></div>
        </div>
      </section>

      <section class="cashflow-ledger-section" aria-labelledby="cashflow-ledger-title">
        <div class="cashflow-ledger-head">
          <div class="cashflow-ledger-title"><h2 id="cashflow-ledger-title">收支明細</h2><span aria-live="polite">${rows.length} 筆</span></div>
        </div>
        <div class="tbl-wrap cashflow-ledger">
          <table><thead><tr>${th('date', '收支日')}${th('account', '銀行帳戶')}${th('note', '收支說明')}${th('category', '分類')}${th('subcategory', '子分類')}${th('amount', '金額', 'num')}<th></th></tr></thead>
          <tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="7" class="empty"><div class="cashflow-empty-state"><img src="assets/guide-return-neutral.webp" alt=""><div><strong>${esc(periodLabel)}尚無銀行收支</strong><span>可用右上角「記一筆」手動新增，或上傳銀行對帳單。</span></div></div></td></tr>`}</tbody></table>
        </div>
      </section>
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
  view().querySelectorAll('[data-edit]').forEach(b => /** @type {HTMLElement} */ (b).onclick = () => openCashflowForm(all.find(t => t.id === /** @type {HTMLElement} */ (b).dataset.edit), accounts, all));
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
    <td><div class="row-actions"><button class="btn-link btn-sm" data-edit="${esc(t.id)}" title="編輯">${icon('edit', 15)}</button><button class="btn-danger btn-sm" data-del="${esc(t.id)}" title="刪除">${icon('trash', 15)}</button></div></td>
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
  if (flow === 'transfer') subs = transferSubs;
  else if (flow === 'income') subs = (Object.hasOwn(incTree, parent) && incTree[parent]) || [];
  else subs = (Object.hasOwn(expTree, parent) && expTree[parent]) || [];
  // 內轉一般要選子分類；但「刪掉某內轉子分類後既有交易會變空白」是合法狀態（對抗審查 2026-07-21）——
  // 現值是空白或不在清單內時要放行空白，否則編輯這種交易會被 <select> 默默選成第一項而改錯。
  const allowBlank = flow !== 'transfer' || cur === '' || !subs.includes(cur);
  // 「保留清單外的現值」與拼 <option> 都交給 form-options.js（#409 自審：原本三個檔各抄一份，
  // transactions.js 那份漏了保留 ⇒ 收成一份，漏掉只可能發生在有考題的那一處）。
  return subcategoryOptionsHtml([...(allowBlank ? [''] : []), ...subs], cur);
}

// ---- 上傳銀行對帳單（三層重構 stage 2：概要區→更新/建立帳戶餘額）----
// fileToBase64 已歸戶 file-util.js（系統優化 U1）
// 上傳窗的連點鎖＝模組層級（不掛在按鈕元素上：月份／金流篩選會同路由重繪整頁、
// 換掉 #uploadBank 元素，掛在元素上的鎖會跟著蒸發——審查 r3 實測兩顆新舊按鈕各開一窗）。
let bankUploadBusy = false;

function openBankUpload() {
  // 為什麼開窗前要先問模式、為什麼有連點鎖與切頁作廢＝runBankUpload／bankUploadGate 的註解
  // （cashflow-model.js）。這裡只把真的鎖、真的把關、真的開窗接進那個編排函式——
  // 開窗前時序的考題都打得到 model 那一份，這裡的形狀由接線題掃；表單內容仍歸本檔。
  return runBankUpload({
    busy: { get: () => bankUploadBusy, set: (v) => { bankUploadBusy = v; } },
    gate: () => bankUploadGate({
      fetchMode: () => api('/mode'), withTimeout: defaultWithTimeout,
      timeoutMs: MODE_TIMEOUT_MS, routeSeq: currentRouteSeq,
    }),
    openUploadForm: (label) => {
      let file = null;
      // ⚠️ preview／remember 都有 await，回來時使用者可能已切頁（r3#2：把關只顧了「問 /mode」那一段，
      //   preview 那段沒顧到）。存下開窗當下的路由序號，**每個後續窗（預覽窗／密碼窗）開啟前都核對**——
      //   序號變了＝這些窗不屬於眼前畫面，一個都不開。
      const seq0 = currentRouteSeq();
      const onPage = () => seq0 === currentRouteSeq();
      // 第二窗（P0.5）：已存密碼池全敗（後端回 code:'pdf_password'）才開——密碼欄＋「記住」勾選
      //（預設不勾＝使用者拍板）。label＝把關挑出的模式分流告知句（單一住所 cashflow-model.js）。
      const openPasswordWindow = (/** @type {string} */ b64) => openForm({
        title: '這份對帳單需要密碼',
        fields: [
          { key: 'password', label, type: 'password', full: true, placeholder: '通常是身分證字號' },
          { key: 'remember', label: REMEMBER_PW_LABEL, type: 'checkbox', full: true },
        ],
        onSubmit: async (/** @type {any} */ data) => {
          const pw = data.password || '';
          const r = await api('/bank-statement/preview', { method: 'POST', body: { data: b64, password: pw } });
          // 預覽成功才記（記一個開不了檔的密碼沒有意義）；記不進去不擋匯入、只提示
          if (data.remember && pw) {
            try { await api('/statement/password/remember', { method: 'POST', body: { password: pw } }); }
            catch { toast('密碼記不進去（匯入不受影響），可稍後再試', true); }
          }
          if (!onPage()) return;   // r3#2：preview/remember 等待期間切頁＝不開預覽窗
          setTimeout(() => showBankPreview(r, b64, pw), 0);   // 待 openForm 清空 modal-root 後再開預覽窗
        },
      });
      openForm({
        title: '上傳銀行對帳單',
        fields: [
          { key: 'file', label: '對帳單 PDF（台新綜合對帳單）', type: 'file', full: true },
        ],
        onMount: (/** @type {any} */ root) => {
          const inp = root.querySelector('#f_file');
          if (inp) { inp.accept = '.pdf,application/pdf'; inp.onchange = () => { file = inp.files?.[0] || null; }; }
        },
        onSubmit: async () => {
          if (!file) throw new Error('請先選擇對帳單 PDF');
          const b64 = await fileToBase64(file);
          try {
            // P0.5：先不帶密碼＝後端自動試統一密碼池（''→各卡→記住的）；多數情況一發就過、全程免輸入
            const r = await api('/bank-statement/preview', { method: 'POST', body: { data: b64 } });
            if (!onPage()) return;   // r3#2：preview 等待期間切頁＝不開預覽窗
            setTimeout(() => showBankPreview(r, b64, ''), 0);   // 待 openForm 清空 modal-root 後再開預覽窗
          } catch (e) {
            if (/** @type {any} */ (e).code !== 'pdf_password') throw e;   // 非密碼問題照舊：toast＋留窗重試
            if (!onPage()) return;   // r3#2：preview 等待期間切頁＝不跳密碼窗
            setTimeout(() => openPasswordWindow(b64), 0);   // 池全敗＝跳密碼窗（等 modal-root 清空）
          }
        }
      });
    },
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
    ${gateSummaryHtml(r.reconcile, 'bank')}
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
    // 外殼歸戶（U3 擴大②）：backdrop:false＝原程式本來就沒有背景點擊關閉（搬家不裝修）
    const { close } = openModalShell({
      title: '銀行對帳單匯入紀錄', size: 'lg', backdrop: false,
      bodyHtml: `
        <ul class="muted batch-help" style="font-size:12.5px;margin:0 0 12px 18px;line-height:1.9;padding:0">
          <li>每一列代表<b class="hl">「一次對帳單上傳」</b>匯入的現金流交易。</li>
          <li>分箱判斷不對、或想換一份帳單重來，可整批<b class="hl">「刪除」</b>後重新上傳。</li>
          <li>刪除只移除這批<b class="hl">「收支交易」</b>；<b class="hl">帳戶餘額不動</b>（重新上傳同一份帳單會自動重設）。</li>
        </ul>
        <div class="tbl-wrap"><table>
          <thead><tr><th>日期範圍</th><th class="num">筆數</th><th class="num">收入</th><th class="num">支出</th><th class="num">內轉</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">尚無銀行對帳單匯入批次。</td></tr>'}</tbody>
        </table></div>
        <div class="form-actions"><button type="button" class="btn" data-close>關閉</button></div>`,
    });
    root.querySelector('[data-close]').onclick = close;
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

/** @param {any=} tx @param {any[]=} accounts @param {any[]=} all 全部現金流交易（算「同類還有幾筆」用） */
function openCashflowForm(tx, accounts = [], all = []) {
  // 金流別由既有 type 推導（編輯）或預設收入（新增）
  const initFlow = tx ? (tx.type === 'income' ? 'income' : tx.type === 'transfer' ? 'transfer' : 'expense') : 'income';
  // 同類一起改（Q2乙）：編輯銀行交易時，若同一把學習鑰匙（摘要＋對方帳號）還有別筆，給勾選框整批一起改。
  const bankKey = tx?.source === 'bank' ? String(tx.bankKey || '') : '';
  // 只算「方向可安全套用」的同類（Codex r13#2）：收入/支出只可套用到同方向的同類（後端逐筆方向護欄會擋反向、
  // 免把出帳誤標成收入），內轉方向中性可套兩向。方向優先用不可竄改的 tx.dir（缺→從 type 推）。
  const dirOf = (/** @type {any} */ x) => (x?.dir === 'in' || x?.dir === 'out') ? x.dir : (x?.type === 'income' ? 'in' : x?.type === 'expense' ? 'out' : null);
  const txDir = dirOf(tx);
  const siblings = bankKey ? (all || []).filter(x => x.id !== tx.id && x.source === 'bank' && String(x.bankKey || '') === bankKey) : [];
  // 內轉＝全部同類可套；收入/支出＝同方向（或方向不明的舊資料，交給後端護欄判）者才算
  const applicable = tx?.type === 'transfer' ? siblings : siblings.filter(x => { const d = dirOf(x); return d == null || d === txDir; });
  const propagable = applicable.length;
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
      ...(propagable ? [{ key: 'applyAll', label: `同時套用到其他 ${propagable} 筆同類（同摘要＋對方帳號）`, type: 'checkbox', full: true }] : []),
    ],
    values: tx ? { ...tx, flow: initFlow } : {},
    onMount: (/** @type {any} */ root) => {
      const flowSel = root.querySelector('#f_flow');
      const catSel = root.querySelector('#f_category');
      const subSel = root.querySelector('#f_subcategory');
      const fillCats = (flow, curCat, curSub) => {
        const parents = parentsForFlow(flow);
        // ⚠️ 這個下拉是 onMount **事後重建**的，走不到 openForm 那條（form-options.js）——所以直接呼叫
        // 同一支產生器，「現值不在清單裡就保留它」才在這裡也成立。舊寫法是
        // `parents.includes(curCat) ? curCat : (parents[0] || '')`：使用者事後刪過分類、或匯入資料帶著
        // 舊分類時，一打開表單就被靜靜換成第一個父分類，按儲存就寫進去（#409 自審抓到，舊病）。
        catSel.innerHTML = selectOptionsHtml(parents, curCat);
        const chosen = effectiveSelectValue(parents, curCat);   // 連動子類要用「真正選中的那個值」，判準與上一行同源
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
      if (tx) {
        // 同類一起改（Q2乙）原子化（護欄 G3）：勾了就把 applyAll 併進 PUT，後端一次寫檔完成編輯（含學習）＋傳播——
        // 不再前端第二次呼叫（原本第二次失敗只能靠 try/catch 補救成「已儲存但套用失敗」的半套用狀態）
        if (data.applyAll && bankKey) body.applyAll = true;
        const r = await api('/transactions/' + tx.id, { method: 'PUT', body });   // PUT 會觸發 learnFromBankEdit（銀行交易）＋同鑰匙傳播
        if (r.applied) toast(`已儲存，並把其他 ${r.applied.changed} 筆同類一起改了${r.applied.skipped ? `（${r.applied.skipped} 筆方向不符，未動）` : ''}`);
        else toast('已儲存');
      } else {
        await api('/transactions', { method: 'POST', body });
        toast('已儲存');
      }
      renderCashflow();
    }
  });
}
