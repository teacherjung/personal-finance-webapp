// @ts-check
// 信用卡帳單匯入工作流（系統優化階段二①，2026-07-24 從 transactions.js 搬出、搬家不裝修）：
// 上傳 PDF/XLSX → 後端解密解析分類 → 預覽確認（可改卡/改分類/勾選）→ 寫入記帳 → 匯入完成摘要，
// 加上「匯入紀錄」批次管理（改期別/整批改卡/整批刪除）。transactions.js 只留頁面本體（列表/編輯/店家檔案）。
// 接線方式＝與 transactions.js 相同的直接 import（**不採 portfolio-*-actions 的 deps 工廠**：那要把
// 每一行 api/esc/money 改寫成 deps.xxx，textual churn 違反搬家不裝修；本檔為逐字搬移＋三個最小接縫）。
// 循環 import 安全：本檔 ↔ transactions.js ↔ app.js 成環，所有 import 綁定一律只在函式內取用
//（勿在檔案頂層取用＝TDZ 陷阱，見 theme.js 註記）；transactions.js 的三個接縫
//（renderTransactions／expenseParents／setMonthFilter）皆為呼叫時取用。
import { api, byId, money, esc, monthKey, openForm, confirmDelete, toast, currentNavSeq, watchModalRoot } from '../app.js';
import { icon } from './icons.js';
import { fileToBase64 } from './file-util.js';
import { openModalShell } from './modal-shell.js';
import { renderTransactions, expenseParents, setMonthFilter } from './transactions.js';
import { gateSummaryHtml } from './reconcile-summary.js';
// 密碼窗文案與開窗編排借銀行那套（單一住所 cashflow-model.js；P0.5＝兩條匯入線同一種體驗、同一份句子與時序防線）
import { REMEMBER_PW_LABEL, runCardUpload, bankUploadGate, openWhenOnPage } from './cashflow-model.js';
import { defaultWithTimeout, MODE_TIMEOUT_MS } from './backup-export.js';

// 卡片上傳的連點鎖＝模組層級（不掛按鈕元素，同銀行 #438 r3 教訓：重繪換掉按鈕鎖會蒸發）
let cardUploadBusy = false;

// ---- 信用卡帳單匯入（上傳 PDF → 後端解密解析分類 → 預覽確認 → 寫入記帳）----
// fileToBase64 已歸戶 file-util.js（系統優化 U1）
export async function openStatementUpload() {
  // 開窗前時序（連點鎖／載卡片時切頁作廢／finally 解鎖）收進 runCardUpload（cashflow-model.js，行為題可直測）
  const result = await runCardUpload({
    busy: { get: () => cardUploadBusy, set: (v) => { cardUploadBusy = v; } },
    navSeq: currentNavSeq,
    watchModal: watchModalRoot,   // r16：載卡片期間使用者開了別的窗＝這一窗不可蓋掉它
    loadCards: async () => (await api('/cards')).filter((/** @type {any} */ c) => (c.type || 'credit') === 'credit'),
    openUploadForm: (cards) => openCardUploadForm(cards),
  });
  if (result === 'nocards') toast('請先到「卡片追蹤」新增一張信用卡', true);
}

/** 卡片上傳的表單本體（onSubmit 流程與密碼窗都住這裡；時序防線在 runCardUpload）。 @param {any[]} cards */
function openCardUploadForm(cards) {
  let file = null;
  // ⚠️ preview／remember 都有 await，回來時可能已切頁（r3#2）——存開窗當下的路由序號，
  //   每個後續窗（選卡/預覽/密碼窗）開啟前都核對；序號變了＝一個都不開。
  const seq0 = currentNavSeq();
  const onPage = () => seq0 === currentNavSeq();   // 整條卡片匯入流程共用（含選卡/改卡重解析）——r4 逐條路都要守
  // 第二窗（P0.5）：已存密碼池（各卡＋記住的）全敗＝後端回 code:'pdf_password' 才開。
  // 告知句依模式分流（借銀行同一份挑句；問不到＝保守當雲端講）、勾「記住」預設不勾。
  // typedPw＝使用者這次輸入的密碼，往後選卡/改卡重解析要沿用（r1#3：沒勾記住時正確密碼不在任何池裡）。
  const openPasswordWindow = async (/** @type {string} */ b64) => {
    // 挑句＋切頁作廢都走 bankUploadGate（r2#2：問 /mode 期間切頁＝不開密碼窗，補上這條非同步縫；
    // 挑句判準與保守方向沿用同一份，不另抄）。
    const modalOk = watchModalRoot();   // r16：問 /mode 之前先看一眼共用彈窗格（唯讀，不可用 claim——那會搶走現在那個窗的擁有權）
    const g = await bankUploadGate({ fetchMode: () => api('/mode'), withTimeout: defaultWithTimeout, timeoutMs: MODE_TIMEOUT_MS, navSeq: currentNavSeq });
    // 等 /mode（或更早的 preview）時切了頁、或**別人接管了 #modal-root**（使用者關掉上傳窗、改開別的窗）
    // ＝這一窗不屬於眼前畫面，開下去會蓋掉後開的窗並毀掉未存輸入（r16）
    if (g.stale || !onPage() || !modalOk()) return;
    openForm({
      title: '這份帳單需要密碼',
      fields: [
        { key: 'password', label: g.label, type: 'password', full: true, placeholder: '通常是身分證字號' },
        { key: 'remember', label: REMEMBER_PW_LABEL, type: 'checkbox', full: true },
      ],
      onSubmit: async (/** @type {any} */ data, /** @type {any} */ ctx) => {
        // r18/r21：排下一窗的判準＝還在同一頁**且**（還沒關窗／或這次是送出成功的交棒）——
        //   使用者按取消也是「自己關的」，但那是撤銷、不放行。
        const canOpenNext = () => onPage() && ctx.owns.handoff();
        const pw = data.password || '';
        const r = await api('/statement/preview', { method: 'POST', body: { data: b64, password: pw } });
        if (data.remember && pw) {
          try { await api('/statement/password/remember', { method: 'POST', body: { password: pw } }); }
          catch { if (onPage()) toast('密碼記不進去（匯入不受影響），可稍後再試', true); }
        }
        openWhenOnPage(canOpenNext, () => handlePreviewResult(r, b64, cards, pw, onPage));   // 切頁／被接管都作廢（排程＋執行兩次核對）
      },
    });
  };
  openForm({
    title: '上傳信用卡帳單',
    fields: [
      { key: 'file', label: '帳單檔案（PDF 或 XLSX；系統自動辨識銀行與卡片，認不出才會請你選）', type: 'file', full: true }
    ],
    onMount: (/** @type {any} */ root) => {
      const inp = root.querySelector('#f_file');
      if (inp) { inp.accept = '.pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; inp.onchange = () => { file = inp.files?.[0] || null; }; }
    },
    onSubmit: async (/** @type {any} */ _data, /** @type {any} */ ctx) => {
      if (!file) throw new Error('請先選擇帳單檔案（PDF 或 XLSX）');
      const canOpenNext = () => onPage() && ctx.owns.handoff();   // r18：同上
      const b64 = await fileToBase64(file);
      try {
        const r = await api('/statement/preview', { method: 'POST', body: { data: b64 } });
        // openForm 送出後會清空 #modal-root，後續彈窗也在 #modal-root，故延到關閉之後再畫（切頁作廢）
        openWhenOnPage(canOpenNext, () => handlePreviewResult(r, b64, cards, '', onPage));
      } catch (e) {
        if (/** @type {any} */ (e).code !== 'pdf_password') throw e;   // 非密碼問題照舊：toast＋留窗重試
        openWhenOnPage(canOpenNext, () => openPasswordWindow(b64));   // 池全敗＝跳密碼窗（切頁／被接管都作廢）
      }
    }
  });
}

// 自動預覽結果：判得出卡片就直接預覽；認不出就請使用者從候選（或全部卡）選一張。
// typedPw＝使用者這次在密碼窗輸入的密碼（免選卡失敗才有值）；選卡/改卡重解析要沿用（r1#3）。
// onPage＝整條流程共用的切頁作廢判準（r4：選卡/改卡那條 await 也要守，不只前段）；未傳＝恆 true（相容）。
function handlePreviewResult(r, b64, cards, typedPw = '', onPage = () => true) {
  if (r.resolvedCard) return openStatementPreview(r.resolvedCard.id, r, b64, cards, typedPw, onPage);
  openCardChoice(r, b64, cards, typedPw, onPage);
}

// 認不出卡片時請使用者選（候選優先，無候選則列全部信用卡），選後用該卡重新解析預覽。
function openCardChoice(r, b64, cards, typedPw = '', onPage = () => true) {
  const pick = (r.candidates && r.candidates.length) ? r.candidates : cards;
  const detail = `${r.bank ? r.bank + '帳單' : '這份帳單'}${r.lastFour ? `（末四碼 ${esc(r.lastFour)}）` : ''}`;
  openForm({
    title: '選擇要記到哪張卡片',
    size: 'sm',
    fields: [
      { key: 'cardId', label: `${detail}，系統無法確定是哪張卡，請選：`, type: 'select',
        options: pick.map(c => ({ value: c.id, label: c.name + (c.lastFour ? `（${c.lastFour}）` : '') })) }
    ],
    onSubmit: async (data, /** @type {any} */ ctx) => {
      // 沿用使用者輸入的密碼（r1#3）：後端 previewForCard 會把它排在池最前；不帶＝沒勾記住時又失敗
      const canOpenNext = () => onPage() && ctx.owns.handoff();   // r18：同上
      const pr = await api(`/cards/${data.cardId}/statement/preview`, { method: 'POST', body: { data: b64, password: typedPw } });
      openWhenOnPage(canOpenNext, () => openStatementPreview(data.cardId, pr, b64, cards, typedPw, onPage));   // r4：重解析期間切頁／被接管＝不開
    }
  });
}

// 預覽確認：頂部可改「記到哪張卡」（改了就用該卡重新解析＝重算重複標記）；只選「分類」（子類自動判斷用）；
// 可勾選；重複預設不勾、真正繳款不可匯入、退款可匯入。b64=原始檔（改卡重新解析用）、cards=所有信用卡。
function openStatementPreview(cardId, r, b64, cards, typedPw = '', onPage = () => true) {
  const root = byId('modal-root');
  let curCard = cardId, curR = r, previewSort = 'none';   // 'none'（原始順序）｜'asc'｜'desc'（依店名）
  const detected = `${curR.bank ? curR.bank : '未知'}${curR.lastFour ? ` · 末四碼 ${curR.lastFour}` : ''}`;   // 原文即可——標題由外殼負責 esc（防雙重跳脫）
  const close = () => { root.innerHTML = ''; };
  // 重繪前把目前的勾選與分類選擇存回資料，排序後不遺失
  const syncEdits = () => curR.transactions.forEach((t, i) => {
    const cb = root.querySelector(`input[data-row="${i}"]`);
    if (cb) t._checked = cb.checked;
    const cat = /** @type {any} */ (root.querySelector(`select[data-cat="${i}"]`));
    // data-autocat/autosub 是「這筆的原始自動判斷」＝固定基準，不可被使用者選值覆蓋（自主體檢）：
    // 選回原分類時，子類要能還原成原本的 autosub（存 t._autoSub 一次、往後都拿它比）
    if (cat) {
      if (t._autoCat === undefined) { t._autoCat = cat.dataset.autocat; t._autoSub = cat.dataset.autosub || ''; }
      t.category = cat.value;
      t.subcategory = (cat.value === t._autoCat) ? t._autoSub : '';
    }
  });
  const applyPreviewSort = () => {
    const key = (t) => (t.store || t.desc || '');
    if (previewSort === 'asc') curR.transactions.sort((a, b) => key(a).localeCompare(key(b), 'zh-Hant'));
    else if (previewSort === 'desc') curR.transactions.sort((a, b) => key(b).localeCompare(key(a), 'zh-Hant'));
    else curR.transactions.sort((a, b) => (a._ord || 0) - (b._ord || 0));   // 還原原始順序
  };
  const catSelHtml = (i, cat, sub) => `<select data-cat="${i}" data-autocat="${esc(cat)}" data-autosub="${esc(sub || '')}">${expenseParents().map(c =>
    `<option value="${esc(c)}" ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
  const cardOpts = () => cards.map(c => `<option value="${esc(c.id)}" ${c.id === curCard ? 'selected' : ''}>${esc(c.name)}${c.lastFour ? `（${esc(String(c.lastFour))}）` : ''}</option>`).join('');

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
      // 帳單期別由後端從帳單表頭讀出（curR.statementMonth），跟著匯入一起存進每一筆（使用者定 2026-07-19）
      const out = await api(`/cards/${curCard}/statement/import`, { method: 'POST', body: { transactions: picked, statementMonth: curR.statementMonth || '', statementDue: curR.statementDue ?? null } });
      if (!onPage()) return;   // r5#1：匯入（含寫入）完成後切頁＝不動月份、不開完成窗、不重繪舊頁（資料已存）
      // 匯入後跳到「筆數最多」的月份：信用卡帳單主體常落在前一個月，避免停在幾乎空的最新月
      const mc = {};
      picked.forEach(t => { const m = (t.date || '').slice(0, 7); if (m) mc[m] = (mc[m] || 0) + 1; });
      const topMonth = Object.entries(mc).sort((a, b) => b[1] - a[1])[0];
      if (topMonth) setMonthFilter(topMonth[0]);
      if (out.imported > 0) openImportDone(out);
      else { close(); toast(`沒有新增任何項目${out.skipped ? `（略過 ${out.skipped} 筆重複或不可匯入）` : ''}`); }
      renderTransactions();
    } catch (e) { if (onPage()) toast('匯入失敗：' + e.message, true); }   // r5#2：切頁後不報過期錯誤
  };

  const draw = () => {
    curR.transactions.forEach((t, i) => { if (t._ord === undefined) t._ord = i; });   // 記原始順序（供「取消排序」還原）
    const sortInd = previewSort === 'asc' ? '▲' : previewSort === 'desc' ? '▼' : '⇅';
    const rowsHtml = curR.transactions.map((t, i) => {
      const dis = t.isPayment;                       // 只有真正繳款不可匯入；退款是要保留的消費抵減
      const isRefund = t.isRefund || (Number(t.amount) < 0 && !t.isPayment);
      const checked = t._checked !== undefined ? t._checked : (!dis && !t.duplicate);   // 沿用使用者勾選，否則重複預設不勾
      const status = t.isPayment ? '<span class="tag">繳款</span>'
        : t.duplicate ? '<span class="tag amber">已存在</span>'
          : isRefund ? '<span class="tag amber">退款</span>' : '<span class="tag green">新</span>';
      return `<tr class="${dis ? 'muted' : ''}">
        <td><input type="checkbox" data-row="${i}" ${checked ? 'checked' : ''} ${dis ? 'disabled' : ''}></td>
        <td class="nowrap">${esc(t.date || '')}</td>
        <td title="${esc(t.desc)}">${esc(t.store || t.desc)}</td>
        <td>${dis ? '—' : catSelHtml(i, t.category, t.subcategory)}</td>
        <td class="num ${isRefund ? 'pos' : ''}">${isRefund ? '+' : ''}${money(Math.abs(t.amount))}</td>
        <td>${status}</td>
      </tr>`;
    }).join('');
    // 外殼歸戶（U3 擴大②）：backdrop:false＝保留原「無背景點擊關閉」語意——這窗滿是勾選與
    // 分類編輯，背景誤點不可毀掉編輯（同 openRulePreview 級的保護，原程式本來就沒掛）
    openModalShell({
      title: `帳單預覽（${detected}）`, size: 'xl', backdrop: false,
      bodyHtml: `
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <label style="margin:0;display:flex;align-items:center;gap:8px">記到卡片
            <select id="previewCard">${cardOpts()}</select></label>
          <span class="muted" style="font-size:12.5px">共 ${curR.transactions.length} 筆。判斷錯了可在此改卡片；分類可逐筆改；「已存在」＝之前匯過（預設不重記）；真正繳款不匯入，退款會保留為消費抵減。</span>
        </div>
        ${gateSummaryHtml(curR.reconcile, 'card')}
        <div class="tbl-wrap" style="max-height:48vh;overflow-y:auto">
          <table><thead><tr><th></th><th>消費日</th><th id="pvSortNote" style="cursor:pointer;user-select:none" title="依店名排序">說明 <span class="muted">${sortInd}</span></th><th>分類</th><th class="num">金額</th><th>狀態</th></tr></thead>
          <tbody>${rowsHtml}</tbody></table>
        </div>
        <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button>
          <button type="button" class="btn" id="doImport">匯入勾選項目</button></div>`,
    });
    root.querySelector('[data-cancel]').onclick = close;
    root.querySelector('#doImport').onclick = doImport;
    root.querySelector('#pvSortNote').onclick = () => {   // 說明欄排序：原始 → 店名 A→Z → Z→A → 原始
      syncEdits();
      previewSort = previewSort === 'asc' ? 'desc' : previewSort === 'desc' ? 'none' : 'asc';
      applyPreviewSort();
      draw();
    };
    root.querySelector('#previewCard').onchange = async (e) => {
      const newId = e.target.value;
      try {
        // 沿用使用者輸入的密碼（r1#3）：改卡重解析時 typedPw 排在池最前，沒勾記住也開得了
        const pr = await api(`/cards/${newId}/statement/preview`, { method: 'POST', body: { data: b64, password: typedPw } });
        if (!onPage()) return;   // r4：改卡重解析 await 期間切頁＝不重建舊預覽窗
        curCard = newId; curR = pr; previewSort = 'none'; draw();   // 換卡＝重算重複標記、排序回原始
      } catch (err) { if (!onPage()) return; toast('改卡片重新解析失敗：' + err.message, true); e.target.value = curCard; }   // r5#2：切頁後不報過期錯誤、不動舊 select
    };
  };

  draw();
}

// 匯入完成：確認記到哪張卡，選錯可當場整批改（其餘晚點也能從「匯入紀錄」改）。
// 匯入完成摘要（使用者定 2026-07-19）：把「這批有什麼需要你看一眼」講出來——第一次見到的店家
// （名字/分類可能還沒學好）與落在「其他」的筆數。非阻斷：只是提示，不擋匯入流程。
/** @param {any} out */
function importSummaryHtml(out) {
  const news = Array.isArray(out.newStores) ? out.newStores : [];
  const un = Number(out.uncategorized || 0);
  if (!news.length && !un) return '';
  const shown = news.slice(0, 6).map(s => esc(s)).join('、');
  return `<div class="hint" style="margin:10px 0 0">
    ${news.length ? `<div>🆕 第一次見到 <b>${news.length}</b> 家店：${shown}${news.length > 6 ? ` 等${news.length}家` : ''}<br>
      <span style="font-size:11.5px">名字或分類不對的話，到「設定 → 帳單說明／分類學習」改一次，以後就記住了。</span></div>` : ''}
    ${un ? `<div style="${news.length ? 'margin-top:8px' : ''}">📂 有 <b>${un}</b> 筆落在「其他／未分類」——在收支列表點該筆編輯，勾「同時套用到這家店的其他筆」一次搞定。</div>` : ''}
  </div>`;
}

/** @param {any} out */
function openImportDone(out) {
  // 外殼歸戶（U3 擴大②）：backdrop:false＝原程式本來就沒有背景點擊關閉（搬家不裝修）
  const { root, close } = openModalShell({
    title: '匯入完成', size: 'sm', backdrop: false,
    bodyHtml: `
      <p>已匯入 <b>${out.imported}</b> 筆到「<b>${esc(out.cardName || '')}</b>」${out.skipped ? `<span class="muted">，略過 ${out.skipped} 筆（重複或不可匯入）</span>` : ''}。</p>
      ${importSummaryHtml(out)}
      <p class="muted" style="font-size:12.5px;margin-top:6px">記錯卡片了嗎？可以現在整批改到別張卡（之後也能從右上「匯入紀錄」改）。</p>
      <div class="form-actions">
        <button type="button" class="btn-ghost" data-reassign>改到其他卡片</button>
        <button type="button" class="btn" data-done>完成</button>
      </div>`,
  });
  root.querySelector('[data-done]').onclick = close;
  root.querySelector('[data-reassign]').onclick = () =>
    openReassignPicker({ batchId: out.batchId, fromCardId: out.cardId, cardName: out.cardName }, () => { close(); renderTransactions(); });
}

// 帳單批次管理：列出每次匯入（卡片／日期範圍／筆數／金額），可整批改卡片。
export async function openBatchManager() {
  const [batches, cards] = await Promise.all([api('/statement/batches'), api('/cards')]);
  const root = byId('modal-root');
  const render = (list) => {
    const rows = list.map(b => `<tr>
      <td>${esc(b.cardName || '—')}</td>
      <td class="nowrap" title="消費日範圍：${esc(b.minDate || '')} ~ ${esc(b.maxDate || '')}">
        <span class="store-open" data-setmonth="${esc(b.batchId)}" data-cur="${esc(b.stmtMonth || '')}" title="點擊修正帳單年月">${esc(b.stmtMonth || monthKey(b.maxDate || ''))}</span>
        ${b.stmtMonth ? '' : '<span class="muted" style="font-size:11px" title="帳單表頭讀不出期別，這是用最後一筆消費日推估的；點左邊可修正">（推估）</span>'}</td>
      <td class="num">${b.count}</td>
      <td class="num">${money(b.amount)}</td>
      <td class="num" title="帳單自己印的「本期應繳總金額」。與匯入金額本就不同：應繳會含上期未繳、分期、年費與利息；匯入金額是本批消費扣掉本批退款後的淨額，不含真正繳款">${b.stmtDue != null ? money(b.stmtDue) : '<span class="muted">—</span>'}</td>
      <td><div class="row-actions">
        <button class="btn-link btn-sm" data-reassign="${esc(b.batchId)}">改卡片</button>
        <button class="btn-danger btn-sm" data-delbatch="${esc(b.batchId)}" title="刪除整批">${icon('trash', 15)}</button>
      </div></td>
    </tr>`).join('');
    // 外殼歸戶（U3 擴大②）：backdrop:false＝原程式本來就沒有背景點擊關閉（搬家不裝修）
    const { close } = openModalShell({
      title: '匯入紀錄', size: 'lg', backdrop: false,
      bodyHtml: `
        <ul class="muted batch-help" style="font-size:12.5px;margin:0 0 12px 18px;line-height:1.9;padding:0">
          <li>每一列都代表<b class="hl">「一份帳單」</b>的匯入。</li>
          <li>帳單年月 → 由帳單<b class="hl">「結帳日」</b>決定；讀取失敗時會依<b class="hl">「最後一筆消費日」</b>推估。</li>
          <li>點擊<b class="hl">「帳單年月」</b>可手動修改<b class="hl">「年月」</b>。</li>
          <li>若有分期，消費紀錄會歸到<b class="hl">「消費日」</b>當月。</li>
          <li>匯入金額 ＝ 該帳單匯入的<b class="hl">「消費扣掉退款後的淨額」</b>，不含真正繳款。</li>
          <li>應繳金額 ＝ 帳單上的<b class="hl">「本期應繳總金額」</b>。<br>（可能包含上期未繳、分期、年費、利息，因此通常不會等於匯入金額。）</li>
          <li>若匯入時選錯信用卡，可按<b class="hl">「改卡片」</b>，一次將整批帳單移至正確的卡片。</li>
        </ul>
        <div class="tbl-wrap"><table>
          <thead><tr><th>卡片</th><th>帳單年月</th><th class="num">筆數</th><th class="num">匯入金額</th><th class="num">應繳金額</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">尚無匯入批次。</td></tr>'}</tbody>
        </table></div>
        <div class="form-actions"><button type="button" class="btn" data-close>關閉</button></div>`,
    });
    root.querySelector('[data-close]').onclick = close;
    root.querySelectorAll('[data-setmonth]').forEach(el => el.addEventListener('click', async () => {
      const b = /** @type {HTMLElement} */ (el);
      const v = prompt('這份帳單是哪一期？請輸入年月（YYYY-MM，例：2026-01）。留白＝清除、退回用消費日推估。', b.dataset.cur || '');
      if (v === null) return;
      try {
        await api('/statement/batch/month', { method: 'POST', body: { batchId: b.dataset.setmonth, month: v.trim() } });
        toast(v.trim() ? `已設為 ${v.trim()}` : '已清除，退回推估值');
        openBatchManager();
      } catch (e) { toast('設定失敗：' + e.message, true); }
    }));
    root.querySelectorAll('[data-reassign]').forEach(btn => btn.onclick = () => {
      const b = list.find(x => x.batchId === btn.dataset.reassign);
      // 補上 fromCardId（由卡名反查）：候選清單才會排除原卡，不會「改到同一張」做白工
      const fromCardId = cards.find(c => c.name === b.cardName)?.id;
      openReassignPicker({ batchId: b.batchId, fromCardId, cardName: b.cardName }, openBatchManager, cards);
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
/** @param {{batchId:string, fromCardId?:string, cardName?:string}} src 來源批次（fromCardId 有給才能從候選排除原卡） @param {(() => void)=} onDone @param {any[]=} cardsCache */
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
