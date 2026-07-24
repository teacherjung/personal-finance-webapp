// @ts-check
// 證券交易頁（S3，藍圖 §二/§七/§八）：集中查閱與對帳 IBKR＋台新證券的歷史成交。
// 分工（藍圖 §九）：這頁忠實呈現與搜尋歷史成交，**不改持股、不做績效分析、不計入收支**——分析在投資組合頁。
// 呈現邏輯（篩選/排序/合計/HTML 字串）都在 securities-view.js 純函式（node --test 直測）；本檔只做 DOM 接線與 API。
import { api, view, byId, esc, toast, moneyCur, todayStr, currentRouteSeq, openForm, openInfo, modalSizeClass, bindBackdropClose } from '../app.js';
import { icon } from './icons.js';
import { thBuilder } from './tx-sort.js';
import { ibSyncFeedback } from './portfolio-ib-sync.js';
import {
  SECURITIES_INFO, SEC_NUMERIC_SORT_KEYS, datePresetRange, filterSecTrades, sortSecTrades,
  secSummarize, secSummaryHtml, secTableHtml, previewBodyHtml, canImportPreview,
  localDateTime, missingHoldingsNotice,
} from './securities-view.js';

// 金額格式：**原幣數字**＋千分位、不掛幣別後綴（幣別自己一欄／一卡，掛了 12 欄會擠爆）。
// 小數位「來源要多少留多少」：金額上限 2 位（台新 TWD 整數、IB USD 常見 2 位）、價格 4 位、數量 6 位（IB 有碎股）。
const fmtAmt = (/** @type {any} */ n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtQty = (/** @type {any} */ n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 6 });
const fmtPrice = (/** @type {any} */ n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
// ⚠️ esc 包一層箭頭延遲取用：app.js ↔ 本模組是循環 import，檔案頂層直接寫 `{ esc }` 會踩 TDZ
//（app.js 還沒初始化完就取它的 binding → 整個 app 掛在載入中；同 theme.js 註記的教訓）
const FMT = { esc: (/** @type {any} */ s) => esc(s), amt: fmtAmt, qty: fmtQty, price: fmtPrice };

// 頁面狀態（模組層物件、就地改欄位，同 transactions/cashflow 的 listSort 慣例；排序預設成交日新→舊）
const filters = { preset: 'all', from: '', to: '', source: 'all', account: 'all', side: 'all', currency: 'all', q: '' };
const listSort = { key: 'tradeDate', dir: 'desc' };

export async function renderSecurities() {
  const seq = currentRouteSeq();
  const [secRes, settings] = await Promise.all([api('/securities'), api('/settings')]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別覆蓋新頁面
  const all = secRes.trades || [];
  const pwSet = !!settings.taishinSecPdfPasswordSet;

  // 篩選選項來自資料本身；目前選的值就算已無資料也保留在選單（防默默改條件，同 settings catOpts 前例）
  const accounts = [...new Set(all.map((/** @type {any} */ t) => String(t.sourceAccountLabel || '')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  if (filters.account !== 'all' && !accounts.includes(filters.account)) accounts.unshift(filters.account);
  const curs = [...new Set(all.map((/** @type {any} */ t) => String(t.currency || '')).filter(Boolean))].sort();
  if (filters.currency !== 'all' && !curs.includes(filters.currency)) curs.unshift(filters.currency);

  const range = filters.preset === 'custom' ? { from: filters.from, to: filters.to }
    : (datePresetRange(filters.preset, todayStr()) || { from: '', to: '' });
  const rows = sortSecTrades(filterSecTrades(all, { ...filters, from: range.from, to: range.to }), listSort);
  const th = thBuilder(listSort);
  const chip = (/** @type {string} */ v, /** @type {string} */ label) => `<button class="chip${filters.preset === v ? ' active' : ''}" data-sec-preset="${v}">${label}</button>`;
  const sel = (/** @type {string} */ id, /** @type {string[][]} */ opts, /** @type {string} */ cur) =>
    `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  view().innerHTML = `
    <div class="page-head">
      <div><h1>證券交易</h1><p>集中查閱 IBKR 與台新證券的買賣紀錄，方便搜尋與對帳（成交紀錄只用於查帳，不計入收支）</p></div>
      <div class="page-actions">
        <button class="btn-ghost" id="secBatches">${icon('history', 16)}匯入紀錄</button>
        <button class="btn-ghost" id="secIbSync" title="與投資組合頁同一套完整同步：會一併更新持股與各幣別現金">${icon('download', 16)}同步 IBKR</button>
        <button class="btn" id="secUpload">${icon('upload', 16)}上傳台新證券對帳單</button>
      </div>
    </div>
    ${secSummaryHtml(secSummarize(rows), FMT)}
    <div class="sec-info-row">
      <button type="button" class="info-link" data-sec-info="currency">ⓘ 為什麼金額分幣別？</button>
      <button type="button" class="info-link" data-sec-info="net">ⓘ 淨應收付的 ＋／−</button>
      <button type="button" class="info-link" data-sec-info="fees">ⓘ 費稅包含什麼？</button>
      <button type="button" class="info-link" data-sec-info="dedup">ⓘ 重複匯入會怎樣？</button>
      <button type="button" class="info-link" data-sec-info="boundary">ⓘ 會影響投資組合嗎？</button>
    </div>
    <div class="sec-toolbar">
      <div><label>期間</label><div class="chip-row">${chip('all', '全部')}${chip('month', '本月')}${chip('3m', '近三月')}${chip('year', '今年')}${chip('custom', '自訂')}</div></div>
      ${filters.preset === 'custom' ? `<div><label>從</label><input type="date" id="secFrom" value="${esc(filters.from)}" /></div>
      <div><label>到</label><input type="date" id="secTo" value="${esc(filters.to)}" /></div>` : ''}
      <div><label>來源</label>${sel('secSource', [['all', '全部'], ['ibkr', 'IBKR'], ['taishin', '台新證券']], filters.source)}</div>
      <div><label>帳戶</label>${sel('secAccount', [['all', '全部'], ...accounts.map(a => [a, a])], filters.account)}</div>
      <div><label>買賣</label>${sel('secSide', [['all', '全部'], ['buy', '買進'], ['sell', '賣出']], filters.side)}</div>
      <div><label>幣別</label>${sel('secCurrency', [['all', '全部'], ...curs.map(c => [c, c])], filters.currency)}</div>
      <div><label>搜尋</label><input id="secSearch" value="${esc(filters.q)}" placeholder="代號或名稱，按 Enter" /></div>
    </div>
    ${secTableHtml(rows, th, FMT)}
    ${rows.length ? `<p class="muted" style="font-size:12px;margin-top:10px">共 ${rows.length} 筆（點任一列可展開費稅與批次明細）</p>` : ''}
  `;

  // ---- 接線 ----
  view().querySelectorAll('[data-sec-preset]').forEach((/** @type {any} */ b) => b.onclick = () => {
    filters.preset = b.dataset.secPreset || 'all';
    renderSecurities();
  });
  const bindSel = (/** @type {string} */ id, /** @type {'source'|'account'|'side'|'currency'} */ key) => {
    const el = byId(id);
    if (el) el.onchange = () => { filters[key] = el.value; renderSecurities(); };
  };
  bindSel('secSource', 'source'); bindSel('secAccount', 'account'); bindSel('secSide', 'side'); bindSel('secCurrency', 'currency');
  const from = byId('secFrom'), to = byId('secTo');
  if (from) from.onchange = () => { filters.from = from.value; renderSecurities(); };
  if (to) to.onchange = () => { filters.to = to.value; renderSecurities(); };
  // 失焦（change）或按 Enter（keydown）套用搜尋——不用 oninput：整頁重繪會吃掉輸入焦點。
  // ⚠️ Enter 要自己接：#secSearch 不在 <form> 裡，純 input 按 Enter 瀏覽器不會發 change（自審 r1#1）
  const search = byId('secSearch');
  search.onchange = (/** @type {any} */ e) => { filters.q = e.target.value; renderSecurities(); };
  search.onkeydown = (/** @type {any} */ e) => { if (e.key === 'Enter') { filters.q = e.target.value; renderSecurities(); } };
  // 表頭排序：同欄再點＝反轉；換欄＝日期/數字欄預設降冪（新/大在前）、文字欄升冪（鍵集合與 tx-sort 不同，故本地綁）
  view().querySelectorAll('th.sortable').forEach((/** @type {any} */ el) => el.onclick = () => {
    const key = el.dataset.sort || 'tradeDate';
    if (listSort.key === key) listSort.dir = listSort.dir === 'asc' ? 'desc' : 'asc';
    else { listSort.key = key; listSort.dir = SEC_NUMERIC_SORT_KEYS.has(key) ? 'desc' : 'asc'; }
    renderSecurities();
  });
  // 點列展開明細（點到列內按鈕/連結不觸發）
  view().querySelectorAll('tr.sec-row').forEach((/** @type {any} */ r) => r.onclick = (/** @type {any} */ e) => {
    if (e.target.closest('button, a, input, select')) return;
    r.nextElementSibling?.classList.toggle('open');
  });
  wireSecInfo();
  byId('secUpload').onclick = () => openSecUpload(pwSet);
  byId('secBatches').onclick = () => openSecBatches();
  byId('secIbSync').onclick = (/** @type {any} */ e) => syncIbFromSecurities(e.currentTarget);
}

/** 就地解釋接線（data-sec-info → openInfo；同 goal-tracking 的 data-goal-info 前例）。 */
function wireSecInfo() {
  view().querySelectorAll('[data-sec-info]').forEach((/** @type {any} */ b) => b.onclick = () => {
    const key = String(b.dataset.secInfo || '');
    const info = Object.hasOwn(SECURITIES_INFO, key) ? SECURITIES_INFO[/** @type {keyof typeof SECURITIES_INFO} */ (key)] : null;
    if (info) openInfo(info.title, info.html, { size: 'sm' });
  });
}

// 「同一套同步」（藍圖 §二＋A′ 裁決 2026-07-24）：呼叫與投資組合頁**相同的** POST /api/ib/sync＋共用
// 回報翻譯 ibSyncFeedback（按鈕文案已講明會一併更新持股與現金）。「可能已出清」只提醒＋指路投組頁
//（Codex S3r2#3）——刪持股的動作留在投資組合頁，查帳頁不做（A′：不自打「頁面上沒有編輯持股功能」）。
async function syncIbFromSecurities(/** @type {any} */ btn) {
  const seqAtStart = currentRouteSeq();
  btn.disabled = true;
  btn.textContent = 'IBKR 同步中…（最多約 15 秒）';
  try {
    const result = await api('/ib/sync', { method: 'POST' });
    for (const f of ibSyncFeedback(result, moneyCur)) toast(f.message, f.error);
    const notice = missingHoldingsNotice(result.missing);
    if (notice) toast(notice, true);
    if (seqAtStart === currentRouteSeq()) renderSecurities();
  } catch (err) {
    toast('IBKR 同步失敗：' + /** @type {any} */ (err).message, true);
    btn.disabled = false;
    btn.innerHTML = icon('download', 16) + '同步 IBKR';
  }
}

// ---- 台新對帳單上傳（藍圖 §五/§七）：選檔＋密碼 → 預覽 → 確認匯入（伺服器端重新解析，不信前端列）----
/** 檔案 → base64（同 transactions.js 前例；PDF 只在記憶體、不落地）。 @param {File} file @returns {Promise<string>} */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('讀取檔案失敗'));
    fr.readAsDataURL(file);
  });
}

function openSecUpload(/** @type {boolean} */ pwSet) {
  /** @type {File|null} */
  let file = null;
  openForm({
    title: '上傳台新證券對帳單',
    fields: [
      { key: 'file', label: '對帳單檔案（台新證券寄的電子對帳單 PDF）', type: 'file', full: true },
      { key: 'password', type: 'password', full: true,
        label: pwSet ? 'PDF 密碼（已存過：留空＝用已存的）' : 'PDF 密碼（通常是身分證字號；到「設定」存起來可免每次輸入）' },
    ],
    onMount: (/** @type {any} */ root) => {
      const inp = root.querySelector('#f_file');
      if (inp) { inp.accept = '.pdf,application/pdf'; inp.onchange = () => { file = inp.files?.[0] || null; }; }
    },
    onSubmit: async (d) => {
      if (!file) throw new Error('請先選擇對帳單 PDF');
      const b64 = await fileToBase64(file);
      const pw = String(d.password || '');
      const p = await api('/securities/preview', { method: 'POST', body: pw ? { file: b64, password: pw } : { file: b64 } });
      setTimeout(() => openSecPreview(p, b64, pw), 0);   // openForm 成功後清 #modal-root，預覽窗延到關閉之後再畫（同 transactions 前例）
    },
  });
}

/** 預覽彈窗：blockers 存在＝不畫確認鈕（fail-closed）；確認＝把**原始檔**再送 import（後端重解析）。 */
function openSecPreview(/** @type {any} */ p, /** @type {string} */ b64, /** @type {string} */ password) {
  const root = byId('modal-root');
  const ok = canImportPreview(p);
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('xl')}">
    <div class="modal-head"><h2>台新證券對帳單預覽</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      ${previewBodyHtml(p, FMT)}
      <div class="form-actions">
        <button type="button" class="btn-ghost" data-cancel>取消</button>
        ${ok ? `<button type="button" class="btn" id="secDoImport">確認匯入 ${p.counts.importable} 筆</button>` : ''}
      </div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  bindBackdropClose(root, close);
  const btn = byId('secDoImport');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;   // 防雙擊重複送
    const seqAtStart = currentRouteSeq();   // 守門（自審 r1#2）：等待匯入期間使用者可能切走頁（modal 擋不住上一頁/hash），回來不可蓋掉新頁面
    try {
      const out = await api('/securities/import', { method: 'POST', body: password ? { file: b64, password } : { file: b64 } });
      close();
      toast(`已匯入 ${out.imported} 筆證券交易${out.skippedDup ? `（略過已存在 ${out.skippedDup} 筆）` : ''}`);
      if (seqAtStart === currentRouteSeq()) renderSecurities();
    } catch (err) { btn.disabled = false; toast('匯入失敗：' + /** @type {any} */ (err).message, true); }
  };
}

// ---- 匯入紀錄與後悔機制（藍圖 §八）：台新批次可整批刪除重匯；IBKR 批次不提供刪除 ----
async function openSecBatches() {
  let batches;
  try { batches = (await api('/securities/batches')).batches || []; }
  catch (err) { return toast('讀取匯入紀錄失敗：' + /** @type {any} */ (err).message, true); }
  const root = byId('modal-root');
  const srcName = (/** @type {string} */ s) => s === 'ibkr' ? 'IBKR' : s === 'taishin' ? '台新證券' : (s || '—');
  const rowHtml = (/** @type {any} */ b) => `<tr>
    <td>${esc(srcName(b.source))}</td>
    <td class="muted">${esc(b.account || '—')}</td>
    <td class="nowrap">${esc(b.minDate || '')}${b.maxDate && b.maxDate !== b.minDate ? `〜${esc(b.maxDate)}` : ''}</td>
    <td class="num">${b.count} <span class="muted">（買 ${b.buyCount}／賣 ${b.sellCount}）</span></td>
    <td class="muted nowrap">${esc(localDateTime(b.importedAt))}</td>
    <td>${b.source === 'taishin'
      ? `<button class="btn-danger btn-sm" data-delbatch="${esc(b.batchId)}" title="整批刪除（刪掉後可重新上傳同一份對帳單）">${icon('trash', 15)}</button>`
      : '<span class="muted" title="IBKR 同步批次不提供整批刪除（避免誤刪長期歷史）；資料有誤請重新同步同一期間覆寫">—</span>'}</td>
  </tr>`;
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('lg')}">
    <div class="modal-head"><h2>匯入紀錄</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p class="muted" style="font-size:12px;margin-bottom:10px">台新批次可整批刪除後重新上傳（後悔藥）；IBKR 同步批次不提供刪除——資料有誤時重新同步同一期間即可覆寫，歷史不會消失。</p>
      <div class="tbl-wrap"><table>
        <thead><tr><th>來源</th><th>帳戶</th><th>期間</th><th class="num">筆數</th><th>匯入時間</th><th></th></tr></thead>
        <tbody>${batches.map(rowHtml).join('') || '<tr><td colspan="6" class="empty">還沒有任何匯入或同步。</td></tr>'}</tbody>
      </table></div>
      <div class="form-actions"><button type="button" class="btn" data-close>關閉</button></div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-close]').onclick = close;
  bindBackdropClose(root, close);
  root.querySelectorAll('[data-delbatch]').forEach((/** @type {any} */ btn) => btn.onclick = async () => {
    const id = btn.dataset.delbatch || '';
    const b = batches.find((/** @type {any} */ x) => x.batchId === id);
    if (!window.confirm(`確定整批刪除這 ${b ? b.count : ''} 筆台新交易（${b ? b.minDate : ''}〜${b ? b.maxDate : ''}）嗎？\n刪除後可重新上傳同一份對帳單補回。`)) return;
    const seqAtStart = currentRouteSeq();   // 守門（自審 r1#2）：同確認匯入——切走頁後不可蓋畫面、也不可把關掉的窗彈回來
    try {
      const out = await api('/securities/batch/delete', { method: 'POST', body: { batchId: id } });
      toast(`已刪除 ${out.deleted} 筆`);
      if (seqAtStart === currentRouteSeq()) {
        openSecBatches();      // 重畫紀錄窗（重抓最新）
        renderSecurities();    // 背後頁面同步更新
      }
    } catch (err) { toast('刪除失敗：' + /** @type {any} */ (err).message, true); }
  });
}
