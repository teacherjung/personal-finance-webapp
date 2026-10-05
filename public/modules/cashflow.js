// @ts-check
// 銀行收支頁（三層重構 stage 1，使用者定 2026-07-20）：**現金流真相**——只顯示現金流帳本
//（!isCardTx：手動記帳 + 未來的銀行對帳單匯入）。信用卡刷卡消費不在這裡（在「信用卡消費明細」頁）；
// 銀行帳單裡的「繳卡費」那筆才是刷卡消費的現金流出，計入這裡。
// 三層分類：金流（收入/支出/內轉）→ 分類 → 子分類。收入走 incomeTree、
// 支出沿用信用卡的 expenseTree（統計合得起來）、內轉固定 內轉出/內轉入（無分類樹）。
import { api, apiStream, view, byId, wan, money, esc, monthKey, todayStr, openForm, openInfo, confirmDelete, toast, currentRouteSeq, currentNavSeq, watchModalRoot } from '../app.js';
import { progressText } from './progress-text.js';   // 上傳進度：後端推代碼、句子住這支純模組（可行為測）
import { icon } from './icons.js';
import { isCardTx } from './categories.js';
import { sortRows, thBuilder, bindSortClicks } from './tx-sort.js';
import { fileToBase64 } from './file-util.js';
import { deriveMonths, deriveYears, fallbackMonth, monthNumbersForYear, monthNumberOptionsHtml, yearOptionsHtml } from './month-select.js';
import { openModalShell } from './modal-shell.js';
import { cashflowDateLabel, cashflowDescriptionLines, cashflowTextKey, cashflowMonthSummary, cashflowPeriodLabel, bankUploadGate, runBankUpload, REMEMBER_PW_LABEL, openWhenOnPage, BANK_UPLOAD_FILE_LABEL, BANK_UPLOAD_SUBMIT_LABEL, BANK_UPLOAD_BUSY_LABEL, bankPreviewFootnote, bankBlockedWarningHtml, bankApplyLabel, bankApplyDoneText, bankSimilarWarningHtml, bankSimilarTagHtml, bankSkipSimilarOptionHtml, bankCardLedgerNote, bankBatchCountText, bankBatchDeleteConfirmText } from './cashflow-model.js';
import { selectOptionsHtml, effectiveSelectValue, subcategoryOptionsHtml } from './form-options.js';
import { gateSummaryHtml } from './reconcile-summary.js';
import { snapshotUpload, previewBody, applyBody, runAiFallback, shouldOfferAi, shouldAskBeforeSend, aiErrorText, isAiTicketDeadCode, aiConsentBodyHtml, aiPreviewBadgeHtml, recipePreviewBadgeHtml, AI_CONSENT_TITLE, AI_CONSENT_SUBMIT_LABEL, AI_CONSENT_BUSY_LABEL, AI_PREVIEW_LOST_TEXT } from './ai-consent.js';   // AI 同意路線（P1b-2）：判準與文案的家
// 問模式的等待上限與計時器住在匯出模組（第一個需要問 /api/mode 的畫面）；第二個消費者直接借用、不另抄一份。
import { defaultWithTimeout, MODE_TIMEOUT_MS } from './backup-export.js';

/** @type {Record<string, string[]>} */ let expTree = {};    // 支出樹（沿用信用卡的）
/** @type {Record<string, string[]>} */ let incTree = {};    // 收入樹（獨立）
/** @type {string[]} */ let transferSubs = ['內轉出', '內轉入', '交割'];   // 內轉子分類（可全編輯，使用者定 2026-07-21）；renderCashflow 從 /transfer-subcategories 載入現行清單

let monthFilter = monthKey();
let flowFilter = 'all';   // 金流篩選：all / income / expense / transfer
let renderGeneration = 0;
const listSort = { key: 'date', dir: 'desc' };
const FLOW_INFO = [
  ['income', '收入', `<p>這裡的收入，是所選月份在銀行收支中列為「收入」的紀錄，例如薪資、股息或利息。</p>
    <p>自己的帳戶互相轉入的錢屬於「內轉」，不算收入。</p>`],
  ['expense', '支出', `<p>這裡的支出，是所選月份在銀行收支中列為「支出」的紀錄，例如房租、生活費或繳信用卡帳單。</p>
    <p>信用卡刷卡消費另列在信用卡帳本；銀行實際扣繳卡費時，才計入這裡的支出，避免把同一筆錢算兩次。</p>`],
  ['transfer', '內轉', `<p>內轉是自己的帳戶之間移動資金，例如銀行帳戶互轉，或銀行與證券帳戶間的劃撥。內轉不列入收入與支出，也不影響淨現金流。</p>
    <p>內轉摘要卡只計轉出金額；內轉列表則同時顯示轉入與轉出。例如轉出 1 萬元、另一個帳戶轉入 1 萬元，摘要卡只算 1 萬元。</p>
    <p>如果舊紀錄或手動記帳無法確認是轉出，就不計入內轉摘要金額。</p>`],
];

/** 金流別（顯示/篩選用）：income/expense/transfer → 中文＋顏色 class。 @param {any} t */
function flowOf(t) {
  if (t.type === 'income') return { label: '收入', cls: 'pos', sign: '+' };
  if (t.type === 'transfer') return { label: '內轉', cls: 'muted', sign: '' };
  return { label: '支出', cls: 'neg', sign: '−' };
}

export async function renderCashflow() {
  const seq = currentRouteSeq();
  const generation = ++renderGeneration;
  let responses;
  try {
    responses = await Promise.all([
      api('/transactions'), api('/accounts'), api('/categories'), api('/income-categories'), api('/transfer-subcategories')]);
  } catch (e) {
    if (seq === currentRouteSeq() && generation === renderGeneration) {
      if (view().querySelector('.cashflow-workspace')) toast(`載入失敗：${e.message}`, true);
      else view().innerHTML = `<div class="hint" role="alert">載入失敗：${esc(e.message)}</div>`;
    }
    return;
  }
  if (seq !== currentRouteSeq() || generation !== renderGeneration) return;
  const [allRaw, accounts, expTreeRes, incTreeRes, transferRes] = responses;
  expTree = expTreeRes && typeof expTreeRes === 'object' ? expTreeRes : {};
  incTree = incTreeRes && typeof incTreeRes === 'object' ? incTreeRes : {};
  if (Array.isArray(transferRes) && transferRes.length) transferSubs = transferRes.map(s => s.label).filter(Boolean);
  const all = allRaw.filter(t => !isCardTx(t));   // 只吃現金流帳本
  const months = deriveMonths(all);
  monthFilter = fallbackMonth(monthFilter, months);
  const selectedYear = monthFilter.slice(0, 4);
  const selectedMonth = monthFilter.slice(5, 7);
  const years = deriveYears(months);
  const monthsInYear = monthNumbersForYear(months, selectedYear);

  const th = thBuilder(listSort);
  // 所選月份摘要（內轉不進收入/支出加總，只影響帳戶間流動——與後端 derive.computeCashflow 同口徑）
  const { monthRows, income, expense, transfer, net } = cashflowMonthSummary(all, monthFilter, Array.isArray(transferRes) ? transferRes : []);
  const netTone = net >= 0 ? 'pos' : 'neg';
  const periodLabel = cashflowPeriodLabel(monthFilter);
  // 篩選金流後再排序
  const filteredRows = monthRows.filter(t => flowFilter === 'all'
    || (flowFilter === 'transfer' ? t.type === 'transfer' : t.type === flowFilter));
  // 排序鍵跟著顯示文字，避免另存摘要後仍按帳單原文排序。
  const sortableRows = listSort.key === 'note'
    ? filteredRows.map(t => ({ ...t, note: cashflowDescriptionLines(t).summary }))
    : filteredRows;
  const rows = sortRows(sortableRows, listSort);

  const flowTab = (val, label) => `<button class="chip${flowFilter === val ? ' active' : ''}" data-flow="${val}" aria-pressed="${flowFilter === val}">${label}</button>`;
  const statAction = (flow, label) => `<button type="button" class="cashflow-stat-action" data-flow="${flow}" aria-label="${flow === 'all' ? '淨現金流，顯示全部明細' : `顯示${label}明細`}" title="${flow === 'transfer' ? '內轉只計轉出；內轉不列入收入與支出。顯示全部內轉明細' : `顯示${label}明細`}" aria-pressed="${flowFilter === flow}">${icon('search', 22)}</button>`;

  // 在換掉 DOM 前才取焦點，避免等待資料期間使用者已移到別處卻被拉回。
  const active = document.activeElement;
  const focusedControl = active instanceof HTMLElement && view().contains(active)
    && active.matches('#yearSel, #monthSel, #yearSelDesktop, #monthSelDesktop, .cashflow-stat-action, .cashflow-flow-control .chip, .cashflow-flow-info')
    ? active : null;
  const infoButtons = [...view().querySelectorAll('.cashflow-flow-info')];

  view().innerHTML = `
    <div class="cashflow-workspace">
      <div class="page-head cashflow-head">
        <div><h1>銀行收支</h1><p class="cashflow-desktop-only">掌握每月的真實現金流（${FLOW_INFO.map(([flow, label]) => `<button type="button" class="info-link cashflow-flow-info" id="cashflowInfo-${flow}" aria-haspopup="dialog">${label}</button>`).join('、')}）</p><p class="cashflow-mobile-only">以銀行對帳單為準的真實現金流：收入、支出、內轉</p></div>
        <div class="page-actions">
          ${all.some(t => t.source === 'bank') ? `<button class="btn-ghost btn-eq" id="bankBatches">${icon('history', 16)}匯入紀錄</button>` : ''}
          <button class="btn btn-eq" id="addCf">${icon('plus', 16)}記一筆</button>
          <button class="btn btn-upload" id="uploadBank">${icon('upload', 16)}上傳銀行對帳單</button>
        </div>
      </div>

      <section class="cashflow-summary" aria-label="${esc(periodLabel)}銀行收支摘要">
        <div class="cashflow-summary-head">
          <div class="cashflow-period-mobile"><strong>${esc(periodLabel)}</strong></div>
          <p class="cashflow-mobile-only">內轉不列入收入與支出</p>
          <div class="cashflow-period-desktop">
            <div class="cashflow-period-selects" role="group" aria-label="收支月份">
              <div class="cashflow-select cashflow-period-year"><select id="yearSelDesktop" aria-label="年份">${yearOptionsHtml(years, selectedYear, esc)}</select><span class="cashflow-select-arrow" aria-hidden="true">${icon('chevron-down', 14)}</span></div>
              <div class="cashflow-select cashflow-period-month"><select id="monthSelDesktop" aria-label="月份">${monthNumberOptionsHtml(monthsInYear, selectedMonth, esc)}</select><span class="cashflow-select-arrow" aria-hidden="true">${icon('chevron-down', 14)}</span></div>
            </div>
          </div>
        </div>
        <div class="cashflow-summary-grid">
          <div class="cashflow-stat" data-kind="net" data-tone="${netTone}"><h3 class="cashflow-desktop-only">淨現金流</h3><h3 class="cashflow-mobile-only">結餘</h3><div class="stat sm ${netTone}">${net >= 0 ? '+' : ''}${wan(net)}</div>${statAction('all', '全部')}</div>
          <div class="cashflow-stat" data-kind="income"><h3>收入</h3><div class="stat sm pos">${wan(income)}</div>${statAction('income', '收入')}</div>
          <div class="cashflow-stat" data-kind="expense"><h3>支出</h3><div class="stat sm neg">${wan(expense)}</div>${statAction('expense', '支出')}</div>
          <div class="cashflow-stat" data-kind="transfer"><h3>內轉 <small class="cashflow-mobile-only">只計轉出</small></h3><div class="stat sm">${wan(transfer)}</div>${statAction('transfer', '內轉')}</div>
        </div>
      </section>

      <section class="cashflow-ledger-section" aria-label="銀行收支列表">
        <section class="cashflow-controls" aria-label="銀行收支篩選">
          <div class="cashflow-control">
            <label for="yearSel">年份</label>
            <div class="cashflow-select"><select id="yearSel">${yearOptionsHtml(years, selectedYear, esc)}</select><span class="cashflow-select-arrow" aria-hidden="true">${icon('chevron-down', 14)}</span></div>
          </div>
          <div class="cashflow-control">
            <label for="monthSel">月份</label>
            <div class="cashflow-select"><select id="monthSel">${monthNumberOptionsHtml(monthsInYear, selectedMonth, esc)}</select><span class="cashflow-select-arrow" aria-hidden="true">${icon('chevron-down', 14)}</span></div>
          </div>
          <div class="cashflow-control cashflow-flow-control">
            <span class="cashflow-control-label">金流</span>
            <div class="chip-row" role="group" aria-label="金流篩選">${flowTab('all', '全部')}${flowTab('income', '收入')}${flowTab('expense', '支出')}${flowTab('transfer', '內轉')}</div>
          </div>
        </section>
        <div class="cashflow-ledger-head cashflow-mobile-only">
          <div class="cashflow-ledger-title"><h2 id="cashflow-ledger-title">收支明細</h2><span aria-live="polite">${rows.length} 筆</span></div>
        </div>
        <div class="tbl-wrap cashflow-ledger">
          <table><thead><tr>${th('date', '日期')}${th('account', '銀行帳戶')}${th('note', '摘要＋備註')}${th('category', '分類')}${th('subcategory', '子分類')}${th('amount', '金額', 'num')}<th></th></tr></thead>
          <tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="7" class="empty"><div class="cashflow-empty-state"><img src="assets/guide-return-neutral.webp" alt=""><div><strong>${esc(periodLabel)}尚無銀行收支</strong><span>可用右上角「記一筆」手動新增，或上傳銀行對帳單。</span></div></div></td></tr>`}</tbody></table>
        </div>
      </section>
    </div>
  `;

  // 說明窗保存開窗元素的參照；保留節點，背景重繪後關窗才找得到歸還焦點的目標。
  for (const button of infoButtons) byId(button.id)?.replaceWith(button);
  byId('addCf').onclick = () => openCashflowForm(null, accounts);
  for (const [flow, label, body] of FLOW_INFO) {
    byId(`cashflowInfo-${flow}`).onclick = () => {
      openInfo(label, body);
      byId('modal-root').querySelector('.modal')?.classList.add('cashflow-flow-info-modal');
    };
  }
  byId('uploadBank').onclick = () => openBankUpload();
  { const bb = byId('bankBatches'); if (bb) bb.onclick = () => openBankBatchManager(); }
  for (const id of ['yearSel', 'yearSelDesktop']) {
    byId(id).onchange = (e) => {
      const year = /** @type {HTMLSelectElement} */ (e.target).value;
      const availableMonths = monthNumbersForYear(months, year);
      const month = availableMonths.includes(selectedMonth) ? selectedMonth : (availableMonths[0] || selectedMonth);
      monthFilter = `${year}-${month}`;
      renderCashflow();
    };
  }
  for (const id of ['monthSel', 'monthSelDesktop']) {
    byId(id).onchange = (e) => {
      monthFilter = `${selectedYear}-${/** @type {HTMLSelectElement} */ (e.target).value}`;
      renderCashflow();
    };
  }
  view().querySelectorAll('[data-flow]').forEach(b => /** @type {HTMLElement} */ (b).onclick = () => {
    flowFilter = /** @type {HTMLElement} */ (b).dataset.flow || 'all'; renderCashflow();
  });
  bindSortClicks(view(), listSort, renderCashflow);
  view().querySelectorAll('[data-edit]').forEach(b => /** @type {HTMLElement} */ (b).onclick = () => openCashflowForm(all.find(t => t.id === /** @type {HTMLElement} */ (b).dataset.edit), accounts, all));
  view().querySelectorAll('[data-del]').forEach(b => /** @type {HTMLElement} */ (b).onclick = () => {
    const t = all.find(x => x.id === /** @type {HTMLElement} */ (b).dataset.del);
    confirmDelete(`${flowOf(t).label} ${money(t.amount)}`, () => api('/transactions/' + t.id, { method: 'DELETE' }));
  });
  if (focusedControl) {
    const selector = focusedControl.classList.contains('cashflow-stat-action') ? '.cashflow-stat-action' : '.cashflow-flow-control .chip';
    const replacement = focusedControl.id ? byId(focusedControl.id)
      : [...view().querySelectorAll(selector)].find(el => /** @type {HTMLElement} */ (el).dataset.flow === focusedControl.dataset.flow);
    replacement?.focus({ preventScroll: true });
  }
}

function rowHtml(t) {
  const f = flowOf(t);
  const description = cashflowDescriptionLines(t);
  const descriptionTitle = [description.summary, description.note].filter(Boolean).join('｜');
  return `<tr>
    <td class="nowrap">${esc(cashflowDateLabel(t.date))}</td>
    <td class="muted nowrap cashflow-account-cell" title="${esc(t.account || '')}">${esc(t.account || '—')}</td>
    <td class="muted cashflow-description-cell"><div class="cf-note" title="${esc(descriptionTitle)}"><span class="cf-note-summary">${esc(description.summary || '—')}</span><span class="cf-note-remark">${esc(description.note || '—')}</span></div></td>
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
    watchModal: watchModalRoot,   // r16：問 /mode 期間使用者關掉這窗、改開別的窗＝晚回來的上傳窗不可蓋掉它
    gate: () => bankUploadGate({
      fetchMode: () => api('/mode'), withTimeout: defaultWithTimeout,
      timeoutMs: MODE_TIMEOUT_MS, navSeq: currentNavSeq,
    }),
    openUploadForm: (label) => {
      let file = null;
      // ⚠️ preview／remember 都有 await，回來時使用者可能已換頁（r3#2/r4：把關只顧了「問 /mode」那段）。
      //   存下開窗當下的**換頁**序號，**每個後續窗（預覽窗／密碼窗）都經 openWhenOnPage 排程**——排程當下與
      //   callback 執行當下都核對序號，序號變了＝這些窗不屬於眼前畫面，一個都不開。
      // ⚠️⚠️ 這裡必須是 currentNavSeq（換頁）**不是** currentRouteSeq（重繪）——r9 抓到的真實 bug：
      //   開機的報價更新／自動快照／帳戶對齊會在**同一頁**呼叫 router()，routeSeq 就前進了。
      //   接成 routeSeq 時 onPage() 變 false，密碼窗**靜靜不開**：使用者上傳完加密帳單，畫面什麼都沒發生。
      const seq0 = currentNavSeq();
      const onPage = () => seq0 === currentNavSeq();
      // 第二窗（P0.5）：已存密碼池全敗（後端回 code:'pdf_password'）才開——密碼欄＋「記住」勾選
      //（預設不勾＝使用者拍板）。label＝把關挑出的模式分流告知句（單一住所 cashflow-model.js）。
      // 第三窗（P1b-2）：內建範本認不得這份版面（後端 code:'bank_unrecognized'）才開。
      // ⚠️ 同意窗開的時候**每一次都問、不記住同意**（2026-08-13 起窗只在 aiAskBeforeSend 打開時出現，
      //    預設不問直接送）＝這裡不寫任何持久化，也不快取答案。
      // ⚠️ `pw` 必須一路帶進來：AI 路線自己會再抽一次字，沒帶密碼＝加密帳單打不開→回 pdf_password→
      //    前端又跳密碼窗＝無限迴圈。

  /** 送 AI 之前要不要先問？判準住 ai-consent.js；⚠️ **設定讀不到就當成「要問」**——
   *  那時我們不知道使用者選了什麼，而猜錯的代價是「沒問就把帳單送出去、還花了錢」。 */
  const askBeforeSendAi = async () => {
    try { return shouldAskBeforeSend(await api('/settings')); } catch { return true; }
  };
  /** 直接送 AI 解讀（不開同意窗）。⚠️ 刻意留在**上傳表單的 onSubmit 裡** await：
   *  送出鈕的「正在上傳…請稍候」會一路顯示到預覽窗開起來，不需要另外吐 toast。 */
  /** 串流版預覽（2026-08-18）：body 帶 stream:true → 後端逐階段推代碼 → progressText 翻成句子。
   * ⚠️ 沒有 setProgress（例如呼叫端不是表單）＝照樣走串流、只是不顯示，結果與錯誤契約完全相同。
   * ⚠️ 進度句只在**收到後端 frame** 時才更新——這裡沒有任何計時器／預設清單（假進度禁令）。 */
  const previewWithProgress = (/** @type {any} */ bodyArgs, /** @type {((t:string)=>void)|undefined} */ setProgress) =>
    apiStream('/bank-statement/preview', { ...previewBody(bodyArgs), stream: true }, (f) => { const t = progressText(f); if (t && setProgress) setProgress(t); });

  const sendToAi = async (/** @type {string} */ b64, /** @type {string} */ pw,
    /** @type {() => boolean} */ onPage, /** @type {() => boolean} */ canOpenNext,
    /** @type {((t:string)=>void)|undefined} */ setProgress) => {
    // ⚠️ r1#1：呼叫端在 await「要不要先問」設定的期間，使用者可能已關窗、切頁、或彈窗被接管
    //    ——那時**連請求都不可以發**（發了就把帳單送出去、花他的錢，canOpenNext 只擋得住
    //    預覽窗、擋不住已出門的請求）。放在函式第一行＝兩條呼叫路與未來新增的都自動受保護。
    if (!canOpenNext()) return;
    try {
      const r = await previewWithProgress({ data: b64, password: pw, useAi: true }, setProgress);
      openWhenOnPage(canOpenNext, () => showBankPreview(r, b64, pw, onPage));
    } catch (e) {
      throw new Error(aiErrorText(/** @type {any} */ (e).code, /** @type {any} */ (e).message), { cause: e });
    }
  };

  const openAiConsentWindow = (/** @type {string} */ b64, /** @type {string} */ pw, /** @type {string} */ fileName) => openForm({
        title: AI_CONSENT_TITLE,
        fields: [],
        bodyHtml: aiConsentBodyHtml({ fileName }),
        submitLabel: AI_CONSENT_SUBMIT_LABEL,
        busyLabel: AI_CONSENT_BUSY_LABEL,   // 鈕上的字（AI 要跑 5–6 秒，只變灰看起來像當掉）
        onSubmit: async (/** @type {any} */ _data, /** @type {any} */ ctx) => {
          const canOpenNext = () => onPage() && ctx.owns.handoff();
          try {
            const r = await previewWithProgress({ data: b64, password: pw, useAi: true }, ctx?.setProgress);
            openWhenOnPage(canOpenNext, () => showBankPreview(r, b64, pw, onPage));
          } catch (e) {
            // 錯誤碼→白話（含「下一步」）的唯一住所在 ai-consent.js；openForm 的 catch 會 toast 並留窗重試
            throw new Error(aiErrorText(/** @type {any} */ (e).code, /** @type {any} */ (e).message), { cause: e });   // 保留原因鏈（專案 lint 規則）：除錯時追得回後端的 ai_* code
          }
        },
      });
      const openPasswordWindow = (/** @type {string} */ b64, /** @type {string} */ fileName) => openForm({
        title: '這份對帳單需要密碼',
        fields: [
          { key: 'password', label, type: 'password', full: true, placeholder: '通常是身分證字號' },
          { key: 'remember', label: REMEMBER_PW_LABEL, type: 'checkbox', full: true },
        ],
        onSubmit: async (/** @type {any} */ data, /** @type {any} */ ctx) => {
          // r18/r21：排下一窗的判準＝還在同一頁**且**（還沒關窗／或這次是送出成功的交棒）——
          //   使用者按取消也是「自己關的」，但那是撤銷、不放行。
          const canOpenNext = () => onPage() && ctx.owns.handoff();
          const pw = data.password || '';
          /** @type {any} */ let r;
          try {
            r = await previewWithProgress({ data: b64, password: pw }, ctx?.setProgress);
          } catch (e) {
            // 密碼對了、但範本認不得這個版面＝可以問要不要送 AI（加密帳單也走得到這條路）
            if (!shouldOfferAi(e)) throw e;
            if (await askBeforeSendAi()) {   // 設定頁打開了「送出前先問我」
              if (runAiFallback({ err: e, canOpenNext, openConsent: () => openAiConsentWindow(b64, pw, fileName) }) === 'rethrow') throw e;
              return;
            }
            await sendToAi(b64, pw, onPage, canOpenNext, ctx?.setProgress);   // 預設：直接送（William 2026-08-13）
            return;
          }
          // 預覽成功才記（記一個開不了檔的密碼沒有意義）；記不進去不擋匯入、只提示
          if (data.remember && pw) {
            try { await api('/statement/password/remember', { method: 'POST', body: { password: pw } }); }
            catch { if (onPage()) toast('密碼記不進去（匯入不受影響），可稍後再試', true); }
          }
          openWhenOnPage(canOpenNext, () => showBankPreview(r, b64, pw, onPage));   // 待 openForm 清空 modal-root 後再開；切頁／被接管都作廢
        },
      });
      openForm({
        title: '上傳銀行對帳單',
        submitLabel: BANK_UPLOAD_SUBMIT_LABEL,
        busyLabel: BANK_UPLOAD_BUSY_LABEL,
        fields: [
          { key: 'file', label: BANK_UPLOAD_FILE_LABEL, type: 'file', full: true },
        ],
        onMount: (/** @type {any} */ root) => {
          const inp = root.querySelector('#f_file');
          if (inp) { inp.accept = '.pdf,application/pdf'; inp.onchange = () => { file = inp.files?.[0] || null; }; }
        },
        onSubmit: async (/** @type {any} */ _data, /** @type {any} */ ctx) => {
          if (!file) throw new Error('請先選擇對帳單 PDF');
          const canOpenNext = () => onPage() && ctx.owns.handoff();   // r18：同上
          // ⚠️ 不可變快照（r1#1）：`file` 是 onchange 會改寫的外層變數——等 await 期間使用者還能改選別的檔案，
          //    之後任何 `file?.name` 讀到的就是新那份，同意窗會顯示 B 而實際送出 A（使用者沒對 A 同意過）。
          //    往下三條路（預覽／密碼窗／同意窗）一律只認這一份快照。
          const snap = snapshotUpload(file);
          if (!snap) throw new Error('請先選擇對帳單 PDF');
          const b64 = await fileToBase64(snap.file);
          try {
            // P0.5：先不帶密碼＝後端自動試統一密碼池（''→各卡→記住的）；多數情況一發就過、全程免輸入
            const r = await previewWithProgress({ data: b64 }, ctx?.setProgress);   // 串流：後端逐階段推、收到才寫（不做假動畫）
            openWhenOnPage(canOpenNext, () => showBankPreview(r, b64, '', onPage));   // 待 modal-root 清空後再開；切頁／被接管都作廢
          } catch (e) {
            if (/** @type {any} */ (e).code === 'pdf_password') { openWhenOnPage(canOpenNext, () => openPasswordWindow(b64, snap.fileName)); return; }   // 池全敗＝跳密碼窗（切頁／被接管都作廢）
            // 範本認不得＝**只排同意窗、不吐原錯誤**（William 2026-08-12：那句紅字是多餘的——同意窗第一行
            // 已經說了「範本認不得這個版面」，而且它還寫死單一銀行名。判準與競態防線都在 runAiFallback；
            // 其他錯誤照舊 toast＋留窗重試）
            if (!shouldOfferAi(e)) throw e;
            if (await askBeforeSendAi()) {
              if (runAiFallback({ err: e, canOpenNext, openConsent: () => openAiConsentWindow(b64, '', snap.fileName) }) === 'rethrow') throw e;
              return;
            }
            await sendToAi(b64, '', onPage, canOpenNext, ctx?.setProgress);
          }
        }
      });
    },
  });
}

const ACTION_LABEL = { update: '更新餘額', create: '新建帳戶', 'skip-stale': '跳過（帳單同期或較舊）', unsupported: '跳過（不支援幣別）', blocked: '無法更新（讀不到參考日）', 'mature-zero': '定存已到期 → 餘額歸零', ambiguous: '不動（認不出是哪一個帳戶：同末碼有多個、或登記的遮罩帳號與帳單印的完整帳號對不起來——請到資產頁把帳號補完整再匯）' };
/** @param {any} r 預覽結果 @param {string} b64 @param {string} pw */
function showBankPreview(r, b64, pw, onPage = () => true) {
  const rows = r.rows || [];
  const willUpdate = rows.filter((/** @type {any} */ x) => x.action === 'update').length;
  const willCreate = rows.filter((/** @type {any} */ x) => x.action === 'create').length;
  const tx = r.transactions || { rows: [], counts: {} };
  const c = tx.counts || {};
  // 交易明細預覽（**全部即將匯入的筆數**，William 2026-08-12：只給前 12 筆看不出這次會匯入什麼；
  // 表格自帶捲動，筆數多也不會把窗撐爆）。已匯入過的重複筆不列（它們不會再進帳本），只在上面計數。
  const flowCls = (/** @type {string} */ t) => t === 'income' ? 'pos' : t === 'transfer' ? 'muted' : 'neg';
  // ⚠️ **外幣也要排除**（r1#2）：正式匯入對非 TWD 直接跳過（bank-import 的 importBankTxToDb），
  //    把它算進「會匯入的全部內容」＝畫面說會進 N 筆、實際只進 N−外幣筆數，使用者會以為漏記。
  const previewTx = (tx.rows || []).filter((/** @type {any} */ x) => !x.duplicate && !x.foreign);
  const body = `
    ${r.blocked ? bankBlockedWarningHtml() : ''}
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

    <div class="section-title">交易明細</div>
    <p class="bank-preview-flow-counts"><span class="pos">收入 <b>${c.income || 0}</b> 筆</span>・<span class="neg">支出 <b>${c.expense || 0}</b> 筆</span>・<span class="bank-preview-transfer-count">內轉 <b>${c.transfer || 0}</b> 筆</span></p>
    ${c.similar ? bankSimilarWarningHtml(c.similar) : ''}
    ${previewTx.length ? `<div class="tbl-wrap" style="max-height:46vh;overflow:auto"><table><thead><tr><th>日期</th><th>銀行帳戶</th><th>摘要＋備註</th><th>分類</th><th class="num">金額</th></tr></thead>
    <tbody>${previewTx.map((/** @type {any} */ x) => {
      const description = cashflowDescriptionLines(x);
      const descriptionTitle = [description.summary, description.note].filter(Boolean).join('｜');
      const learnedBadge = x.learned ? '<span class="flow-tag" title="用你之前教過的金流與分類自動套用">已學</span>' : '';
      const amountSign = x.type === 'income' ? '+' : x.type === 'transfer' ? '' : '−';
      return `<tr>
        <td class="nowrap">${esc(cashflowDateLabel(x.date))}</td>
        <td class="muted nowrap cashflow-account-cell" title="${esc(x.account || '')}">${esc(x.account || '—')}</td>
        <td class="muted cashflow-description-cell"><div class="cf-note" title="${esc(descriptionTitle)}"><span class="cf-note-summary">${x.similar ? bankSimilarTagHtml() : ''}${x.similar ? ' ' : ''}${learnedBadge}${learnedBadge ? ' ' : ''}${esc(description.summary || '—')}</span><span class="cf-note-remark">${esc(description.note || '—')}</span></div></td>
        <td>${esc(x.category || '（不分類）')}${x.subcategory ? '<span class="muted">・' + esc(x.subcategory) + '</span>' : ''}</td>
        <td class="num nowrap ${flowCls(x.type)}">${amountSign}${money(x.amount)}</td>
      </tr>`;
    }).join('')}</tbody></table></div>` : ''}
    <p id="bankPreviewFootnote" class="${previewTx.length ? 'muted' : 'empty'}"${previewTx.length ? ' style="font-size:11px;margin-top:6px"' : ''}>${esc(bankPreviewFootnote({ shown: previewTx.length, duplicate: c.duplicate, foreign: c.foreign, similar: c.similar, skipSimilarChecked: !!c.similar }))}</p>
    ${bankCardLedgerNote(/** @type {any} */ (r).cardLedger) ? `<p class="muted" style="font-size:11px;margin-top:6px">${esc(bankCardLedgerNote(/** @type {any} */ (r).cardLedger))}</p>` : ''}

    <!-- ⚠️ 說明區在**最下面**（William 2026-08-13）：窗一打開先看到帳戶餘額與交易明細，
         想知道「這是誰讀的、驗到什麼程度」再往下看。徽章裡那句「請確認…有沒有讀錯」
         因此移到核對之後——這是 William 明示的取捨，不是漏掉。 -->
    <div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--line)">
    ${aiPreviewBadgeHtml(r)}${recipePreviewBadgeHtml(r)}
    <p class="muted" style="margin-bottom:10px">${r.bank ? `銀行：<b>${esc(r.bank)}</b>　` : ''}現值參考日：<b>${esc(r.referenceDate || '—')}</b>　餘額只有帳單較新時才覆蓋。</p>
    ${gateSummaryHtml(r.reconcile, 'bank')}
    </div>
`;
  // 確認鈕放**底部動作列**（與「了解」同一排、在它右邊＝主要動作在最右；William 2026-08-12）——
  // 原本埋在內容最下方，捲到底才看得到，而且與關窗鈕分屬兩處。
  // ⚠️ **確認鈕一律給**（2026-08-13）：讀不到現值參考日不再是「整份擋下」——餘額不更新、
  //    交易照樣匯入，所以那顆鈕按下去真的有事情發生。r3#1 當初拿掉它是對的（那時按了必失敗），
  //    行為改了就要跟著改回來，不然使用者會以為這份帳單完全不能用。
  openInfo('銀行對帳單預覽', body, { size: 'xl',
    actionsHtml: `${bankSkipSimilarOptionHtml(c.similar)}<button class="btn" id="bankApply">${icon('check', 16)}${esc(bankApplyLabel(!!r.blocked, !rows.some((/** @type {any} */ x) => ['update', 'create', 'mature-zero'].includes(x.action))))}</button>` });

  setTimeout(() => {
    const btn = /** @type {HTMLButtonElement|null} */ (byId('bankApply'));
    // 勾選一動＝腳註跟著改口（r4：勾著時「以上 N 筆都會匯入」是假話——57 標示、實匯 9）。
    // 重算用同一支純函式，不手拼第二句。
    const skipChk = /** @type {HTMLInputElement|null} */ (byId('skipSimilarChk'));
    if (skipChk) skipChk.onchange = () => {
      const fn = byId('bankPreviewFootnote');
      if (fn) fn.textContent = bankPreviewFootnote({ shown: previewTx.length, duplicate: c.duplicate,
        foreign: c.foreign, similar: c.similar, skipSimilarChecked: skipChk.checked === true });
    };
    if (btn) btn.onclick = async () => {
      // 防重入（P1b-2）：AI 路線的票是**一次性**，按第二次必得 ai_ticket_invalid——而第一次其實已經寫進去了，
      // 使用者會看到「失敗」卻以為沒匯入。模板路線一樣受惠（不會送兩次）。
      if (btn.disabled) return;
      btn.disabled = true;
      // AI 路線＝憑票寫入（不重送檔案與密碼）；模板路線＝照舊送 data+password。判準住 ai-consent.js
      // 勾選＝這次跳過「疑似重複」（沒有勾選框＝similar 為 0＝照舊）。
      // ⚠️ 語意講準（r1 待辦）：跳過集合是 apply 當下用 fresh db **重算**的（判準同預覽）——
      //    預覽到按下確認之間若又匯了別批銀行交易，集合會跟著變；**手動記的帳不參與判準**
      //    （similarTxIndex 只索引 source:'bank' 的既有交易，手動帳沒有機構＋帳號可比）。
      const skipSimilar = /** @type {HTMLInputElement|null} */ (document.getElementById('skipSimilarChk'))?.checked === true;
      const payload = applyBody(r, { data: b64, password: pw, skipSimilar });
      if (!payload) { if (onPage()) toast(AI_PREVIEW_LOST_TEXT, true); return; }   // 票不見＝不解鎖，引導重新預覽
      try {
        const res = await api('/bank-statement/apply', { method: 'POST', body: payload });
        if (!onPage()) return;   // r5#1：套用（含寫入）完成後切頁＝不清 modal、不重繪舊頁、不報舊 toast（資料已存，下次進頁自見）
        const t = res.transactions || {};
        toast(bankApplyDoneText(res, t, /** @type {any} */ (res).recipe));   // ⚠️ 餘額沒更新一定要講；P2-3 配方生成結果也講一句
        document.querySelector('#modal-root')?.replaceChildren();
        renderCashflow();
      } catch (e) {
        if (!onPage()) return;   // r5#2：切頁後不報過期錯誤
        const code = /** @type {any} */ (e).code;
        toast(aiErrorText(code, /** @type {any} */ (e).message) || '更新失敗', true);
        if (!isAiTicketDeadCode(code)) btn.disabled = false;   // 票類錯誤＝這份沒救了，解鎖只會讓使用者再撞一次
      }
    };
  }, 0);
}

// ---- 銀行對帳單匯入紀錄（比照信用卡帳單的「匯入紀錄」）：列出每次上傳匯入的批次，可整批刪除後重新上傳。----
// 刪除移除該批「現金流交易」＋（金融卡帳單）連帶記到卡片的刷卡消費明細、不動帳戶餘額（餘額是當前快照；重新上傳同帳單會依現值參考日重設）。
async function openBankBatchManager() {
  const batches = await api('/bank-statement/batches');
  const root = byId('modal-root');
  const render = (/** @type {any[]} */ list) => {
    const rows = list.map(b => `<tr>
      <td class="nowrap" title="存提日範圍">${esc(b.minDate || '')} ~ ${esc(b.maxDate || '')}</td>
      <td class="num">${esc(bankBatchCountText(b))}</td>
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
          <li>刪除會移除這批<b class="hl">「收支交易」</b>，金融卡帳單那一批也會一起拿掉<b class="hl">連帶記到卡片的刷卡消費明細</b>（筆數格括號裡那個數字）；<b class="hl">帳戶餘額不動</b>（重新上傳同一份帳單會自動重設）。</li>
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
      confirmDelete(bankBatchDeleteConfirmText(b), async () => {
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
  const description = tx ? cashflowDescriptionLines(tx) : { summary: '', note: '' };
  const summaryKey = tx ? cashflowTextKey(tx, 'summary') : '';
  const remarkKey = tx ? cashflowTextKey(tx, 'remark') : '';
  const sameTextCount = (part, key) => key.trim() ? (all || []).filter(x => x.id !== tx.id && !isCardTx(x)
    && cashflowTextKey(x, part) === key).length : 0;
  const sameSummaryCount = tx ? sameTextCount('summary', summaryKey) : 0;
  const sameRemarkCount = tx ? sameTextCount('remark', remarkKey) : 0;
  openForm({
    title: tx ? '編輯收支' : '記一筆收支',
    fields: [
      { key: 'flow', label: '金流', type: 'select', options: [
        { value: 'income', label: '收入' }, { value: 'expense', label: '支出' }, { value: 'transfer', label: '內轉（帳戶互轉）' }], default: initFlow },
      { key: 'date', label: '日期', type: 'date', required: true, default: todayStr() },
      { key: 'account', label: '銀行帳戶', type: 'select', options: accountOptions(accounts, tx?.account) },
      { key: 'amount', label: '金額', type: 'number', required: true, placeholder: '0' },
      { key: 'category', label: '分類', type: 'select', options: [] },       // onMount 依金流連動
      { key: 'subcategory', label: '子分類', type: 'select', options: [] },   // onMount 依分類連動
      { key: 'summary', label: '摘要', type: 'text', full: true, required: !tx, placeholder: '例：房租、薪水、利息' },
      ...(summaryKey.trim() ? [{ key: 'applySameSummary', label: `相同摘要是否一起修改（目前 ${sameSummaryCount} 筆）`, type: 'checkbox', full: true }] : []),
      { key: 'remark', label: '備註', type: 'text', full: true, placeholder: '可留空' },
      ...(remarkKey.trim() ? [{ key: 'applySameRemark', label: `相同備註是否一起修改（目前 ${sameRemarkCount} 筆）`, type: 'checkbox', full: true }] : []),
      ...(propagable ? [{ key: 'applyAll', label: `將金流與分類套用到其他 ${propagable} 筆同類（摘要、備註不包含）`, type: 'checkbox', full: true }] : []),
    ],
    values: tx ? { ...tx, flow: initFlow, summary: description.summary, remark: description.note } : {},
    onMount: (/** @type {any} */ root) => {
      for (const key of ['summary', 'remark']) {
        root.querySelector('#f_' + key)?.parentElement?.classList.add('cashflow-text-divider');
      }
      for (const select of root.querySelectorAll('#modalForm select')) {
        const wrap = document.createElement('div');
        wrap.className = 'cashflow-select';
        select.before(wrap);
        wrap.append(select);
        wrap.insertAdjacentHTML('beforeend', `<span class="cashflow-select-arrow" aria-hidden="true">${icon('chevron-down', 14)}</span>`);
      }
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
      /** @type {Record<string, any>} */ const body = {
        type, date: data.date, account: data.account || '',
        category: flow === 'transfer' ? '內轉' : (data.category || ''),
        subcategory: data.subcategory || '', amount: data.amount,
      };
      if (!tx || typeof tx.summary === 'string' || data.summary !== description.summary) body.summary = data.summary || '';
      if (!tx || typeof tx.remark === 'string' || data.remark !== description.note) body.remark = data.remark || '';
      if (tx) {
        // 同類一起改（Q2乙）原子化（護欄 G3）：勾了就把 applyAll 併進 PUT，後端一次寫檔完成編輯（含學習）＋傳播——
        // 不再前端第二次呼叫（原本第二次失敗只能靠 try/catch 補救成「已儲存但套用失敗」的半套用狀態）
        if (data.applyAll && bankKey) body.applyAll = true;
        if (data.applySameSummary && data.summary !== description.summary) body.applySameSummary = true;
        if (data.applySameRemark && data.remark !== description.note) body.applySameRemark = true;
        const r = await api('/transactions/' + tx.id, { method: 'PUT', body });   // PUT 會觸發 learnFromBankEdit（銀行交易）＋同鑰匙傳播
        // 舊版服務會靜默略過新欄位；HTTP 200 不代表摘要與備註真的存進去。
        if (['summary', 'remark'].some(key => Object.hasOwn(body, key) && r?.[key] !== body[key])) {
          throw new Error('摘要或備註未儲存；目前可能仍在使用舊版預覽，請開啟新版網址。');
        }
        const changes = [];
        if (r.applied) changes.push(`分類同步 ${r.applied.changed} 筆${r.applied.skipped ? `（${r.applied.skipped} 筆方向不符）` : ''}`);
        const hasBankOriginal = typeof tx.bankSummary === 'string' && typeof tx.bankNote === 'string';
        if (r.appliedText && body.applySameSummary) changes.push(`摘要同步 ${r.appliedText.summary} 筆${hasBankOriginal ? '，未來相同帳單原文匯入也適用' : ''}`);
        if (r.appliedText && body.applySameRemark) changes.push(`備註同步 ${r.appliedText.remark} 筆${hasBankOriginal ? '，未來相同帳單原文匯入也適用' : ''}`);
        toast(changes.length ? `已儲存；${changes.join('；')}` : '已儲存');
      } else {
        await api('/transactions', { method: 'POST', body });
        toast('已儲存');
      }
      renderCashflow();
    }
  });
}
