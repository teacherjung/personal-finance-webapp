// @ts-check
// 個人理財中心 — 前端主程式
import { renderDashboard } from './modules/dashboard.js';
import { renderCashflow } from './modules/cashflow.js';
import { renderTransactions } from './modules/transactions.js';
import { renderAssets, renderBankAccounts } from './modules/assets.js';
import { renderPortfolio } from './modules/portfolio.js';
import { renderSecurities } from './modules/securities.js';
import { renderSubscriptions } from './modules/subscriptions.js';
import { renderCards } from './modules/cards.js';
import { renderInsurance } from './modules/insurance.js';
import { renderSettings } from './modules/settings.js';
import { createStockResearchPage } from './modules/stock-research-page.js';
import { hydrateIcons, icon } from './modules/icons.js';
import { backupAlertView } from './modules/backup-alert.js';
import { toastMs } from './modules/toast-timing.js';   // 提示停留時間＝照長度給（零依賴純模組，考題撐得住）
import { esc } from './modules/html-escape.js';
import { makeModalOwnership } from './modules/modal-ownership.js';   // #modal-root 世代擁有權（純邏輯，r6）
import { selectOptionsHtml } from './modules/form-options.js';

// ---------- 共用工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);
export const view = () => $('#view');
// 取 id 元素（頁面自己渲染的、一定存在）。回傳 any：這個 codebase 以 innerHTML 樣板為主，
// 元素層級逐處標型別是噪音；DOM 正確性靠「10 頁 reload 無錯」驗證，型別檢查主力放在資料邏輯。
/** @param {string} id @returns {any} */
export const byId = (id) => document.getElementById(id);

/** 呼叫後端 API（自動帶 JSON）。 @param {string} path 例 '/transactions' @param {{method?:string, body?:any}=} opts @returns {Promise<any>} */
export async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    let msg = res.statusText, code;
    try { const b = await res.json(); msg = b.error || msg; code = b.code; } catch {}
    // code＝後端的機器判準（P0.5 起，如 'pdf_password'）：呼叫端據它決定行為，不 regex 訊息字面
    throw Object.assign(new Error(msg), code ? { code: String(code) } : {});
  }
  return res.status === 204 ? null : res.json();
}

// ---------- 金額格式（全站統一：卡片大數字用「萬」、明細用「元」）----------
// 負號一律 U+2212「−」；正號由呼叫端視情況加 ASCII「+」。
const withSign = (n, body) => { const v = Number(n || 0); return (v < 0 ? '−' : '') + body(Math.abs(v)); };
// 明細金額：整數 + 千分位 +「元」後綴（1,234,567 元）
/** @param {number|string|null|undefined} n */
export const money = (n) => withSign(n, v => Math.round(v).toLocaleString('en-US') + ' 元');
// 明細原幣：非台幣顯示原幣後綴（2,500 USD、5.4 USD）；<10 保留一位小數
/** @param {number|string|null|undefined} n @param {string=} cur */
export const moneyCur = (n, cur) => (!cur || cur === 'TWD') ? money(n)
  : withSign(n, v => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US')) + ' ' + cur);
// 統計卡片大數字：以「萬」為單位（≥10 萬取整、<10 萬一位小數），不加「元」（2,134 萬、6.5 萬）
/** @param {number|string|null|undefined} n */
export const wan = (n) => withSign(n, v => { const w = v / 10000; return (w >= 10 ? Math.round(w).toLocaleString('en-US') : w.toFixed(1)) + ' 萬'; });
/** @param {number|string|null|undefined} n */
export const pct = (n) => (Number(n || 0)).toFixed(1) + '%';
// 插入 innerHTML 前必過（XSS 鐵則）。實作搬到零依賴的 `modules/html-escape.js`——
// 純模組（form-options.js…）也要用同一份，而它們 import 不進 app.js（本檔頂層碰 document／localStorage）。
// 這裡原樣 re-export：全站 `import { esc } from '../app.js'` 一行都不用改。
export { esc };

// ---------- 日期工具（全站共用）----------
// 解析 YYYY-MM-DD 為「本地時區」的 Date：new Date('YYYY-MM-DD') 會被當 UTC，在 UTC 以西時區差一天。
export const parseLocalDate = (d) => {
  if (d instanceof Date) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
};
// 幾天後（負數＝已過期）；無日期回 Infinity
export const daysUntil = (d) => { if (!d) return Infinity; const t = parseLocalDate(d); t.setHours(0, 0, 0, 0); const n = new Date(); n.setHours(0, 0, 0, 0); return Math.round((t.getTime() - n.getTime()) / 86400000); };
// 月份鍵 YYYY-MM（可帶日期字串，預設本月）；日期字串直接取前 7 碼，免受時區影響
export function monthKey(d) { if (typeof d === 'string') { const m = /^(\d{4})-(\d{2})/.exec(d); if (m) return `${m[1]}-${m[2]}`; } const t = d ? parseLocalDate(d) : new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; }
// 今天 YYYY-MM-DD
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// stmtRef（卡id|消費日|金額|原始說明）取回帳單原文：與後端 origFromStmtRef 同口徑——**剝掉去重序號 |#N**
// （同帳單同店同額的第 2+ 筆才有；Codex r10#5：漏剝會把「星巴克|#2」當原文，改名/分組/tooltip 全對不上）。
// 前端 import 不到 lib/，故此處複製一份（改 stmtRef 格式要連動這裡＋後端 origFromStmtRef，AGENTS 同步點）。
export function stmtOrig(stmtRef) {
  const parts = String(stmtRef || '').split('|');
  if (parts.length >= 5 && /^#\d+$/.test(parts[parts.length - 1])) parts.pop();   // 末段 #N＝序號，剝掉
  return parts.length >= 4 ? parts.slice(3).join('|').trim() : '';   // 原文可能含「|」→ 第 3 個分隔後全取
}

// 圖表色（CHART/PALETTE/AXIS/GRID）定義在零依賴的 modules/theme.js，各模組直接 import——
// 不從 app.js 轉手：模組在檔案頂層就取用色票，經由 app.js 會踩循環 import 的 TDZ。

/**
 * 右下角提示訊息。
 *
 * ⚠️⚠️ **停留時間照訊息長度給**（r1 審查者實測抓到，2026-08-06 改）：原本固定 3.2 秒，
 *    ⚠️ **2026-08-08 訂正**：以下描述的是**縮短之前**的匯出文案（William 兩輪縮短後已是一行、
 *    12–18 字，且「把這句話整句告訴我」那個指令整句拿掉了）。這一段留作沿革；**機制的價值不變**
 *    ——停留時間照字數給（成功那句尾巴掛長檔名時仍可能偏長），而「短句 3.2 秒夠」是縮短後的下限。
 *    而長訊息（匯出失敗那幾句是 40–100 字上下）在 3.2 秒內根本讀不完——「會出聲」那個保證
 *    整個押在使用者讀得到，卻被投遞機制否決。短句的時間**沒有變**（下限仍是 3.2 秒），
 *    算法在零依賴的 `modules/toast-timing.js`（考題撐得住的地方；app.js 在 node 裡 import 不進來）。
 * ⚠️ 滑鼠停在上面就**不會消失**：長訊息要讓他讀完，而且要能選字複製——匯出失敗的文案叫他
 *    「把這句話整句告訴我」，那個指令得做得到才算數。
 * ⚠️ 誠實劃界：訊息消失之後**沒有任何地方可以回看**（這個 app 沒有提示紀錄本）。
 *    要事後查得到的東西，不可以只靠 toast 講。
 * @param {string} msg @param {boolean=} isErr 紅色錯誤樣式
 */
export function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  const ms = toastMs(msg);
  let timer = setTimeout(() => t.remove(), ms);
  t.addEventListener('mouseenter', () => clearTimeout(timer));            // 讀到一半不要被抽走
  t.addEventListener('mouseleave', () => { timer = setTimeout(() => t.remove(), ms); });
  // 讀完了想立刻收掉就點一下。⚠️ **正在選字時不收**：他為了複製而按下滑鼠，訊息就消失＝白做。
  t.addEventListener('click', () => {
    if ((window.getSelection()?.toString() || '') !== '') return;
    clearTimeout(timer); t.remove();
  });
}

const MODAL_SIZES = new Set(['sm', 'md', 'lg', 'xl']);
export function modalSizeClass(size = 'sm') {
  const safeSize = MODAL_SIZES.has(size) ? size : 'sm';
  return `modal modal-${safeSize}`;
}

/** 彈窗表單的一個欄位。
 * @typedef {Object} FormField
 * @property {string} key
 * @property {string} label
 * @property {string} [type]        'text'(預設)|'number'|'date'|'select'|'textarea'|'checkbox'|'file'
 * @property {Array<string|{value:string, label:string}>} [options]  select 專用
 * @property {boolean} [full]       佔滿整列
 * @property {boolean} [required]
 * @property {string} [placeholder]
 * @property {string} [step]        number 專用
 * @property {*} [default]
 */
/**
 * 點背景關閉彈窗：只有「按下」與「放開」都落在背景上才關。
 * 不能只看 click 的 e.target——瀏覽器把 click 算在「按下處與放開處的共同祖先」上，
 * 所以在彈窗內選取文字、滑鼠拖到彈窗外才放開時，click 會落在 .modal-bg 而誤關（使用者回報的 bug）。
 * @param {Element} root 內含 .modal-bg 的容器 @param {() => void} close
 */
export function bindBackdropClose(root, close) {
  const bg = root.querySelector('.modal-bg');
  if (!bg) return;
  let downOnBg = false, upOnBg = false;
  bg.addEventListener('mousedown', (e) => { downOnBg = e.target === bg; });
  bg.addEventListener('mouseup', (e) => { upOnBg = e.target === bg; });
  bg.addEventListener('click', () => { if (downOnBg && upOnBg) close(); });
}

// #modal-root 是全站表單/彈窗共用的一格（r6→r9）。表單 onSubmit 有 await，回來時可能已換頁或開了新彈窗——
// 舊的成功 continuation 若無條件 close() 會清掉**後開的**彈窗、毀掉未存輸入；舊的失敗會報過期錯誤。
// 世代擁有權的**純邏輯**在 modal-ownership.js（可測）；這裡只把它接到 #modal-root 的 dataset 與換頁序號。
// ⚠️ 吃的是 currentNavSeq（**換頁**世代）不是 currentRouteSeq（重繪世代）——r7 接錯那個，開機報價更新
//    這種同頁背景重繪就把擁有權撤掉，害存檔成功卻不關窗、儲存鈕永遠灰。兩個序號的分工見下面路由段。
// readNav 用箭頭包一層（不是直接傳 currentNavSeq）＝避開 TDZ：currentNavSeq 在本行之後才宣告，
// 直接引用會在載入時就求值而炸；包一層的話識別名只在 owns() 執行（runtime）時才解析。
const _claimModalRoot = makeModalOwnership({
  readGen: () => Number($('#modal-root')?.dataset.modalGen || 0),
  writeGen: (g) => { const r = $('#modal-root'); if (r) r.dataset.modalGen = String(g); },
  readNav: () => currentNavSeq(),
});
/**
 * 宣告接管 #modal-root（蓋新世代章＋記住當下換頁世代）。**所有直接開窗點都要 claim**。
 * 回傳 `owns()`＝這一份是否仍擁有它；`owns.release()`＝關窗時撤銷（有主才撤，不會洗掉後開那個窗的章）。
 */
export function claimModalRoot() { return _claimModalRoot(); }

// 通用彈窗表單。
/** @param {{title:string, fields:FormField[], values?:Record<string,any>, onSubmit:(out:Record<string,any>)=>any, onMount?:(root:HTMLElement)=>void, size?:string}} cfg */
export function openForm({ title, fields, values = {}, onSubmit, onMount, size = 'md' }) {
  const root = $('#modal-root');
  const owns = claimModalRoot();   // r6：async onSubmit 回來時只在仍擁有 modal-root 才 close/toast（切頁或開新窗都作廢）
  const fieldHtml = fields.map(f => {
    const v = values[f.key] ?? f.default ?? '';
    const id = 'f_' + f.key;
    let input;
    if (f.type === 'select') {
      // 選項一律由 modules/form-options.js 產（**不要在這裡再抄一份**）：它負責「忘給 options 時顯示空下拉、
      // 不整頁掛掉」，也負責「現在的值不在選項裡時保留它」——沒有那道保留，瀏覽器會自動選第一項，
      // 使用者只改別的欄位按儲存就會把這欄靜靜改掉（帳戶型別踩過：50 萬負債變 50 萬資產）。
      input = `<select id="${id}">${selectOptionsHtml(f.options, v)}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea id="${id}" rows="2" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
    } else if (f.type === 'checkbox') {
      // ⚠️ 這個自製下拉**刻意不套用 form-options.js 的「保留現值」機制**，理由是它沒有那個病
      //（#409 逐條查證，不是憑印象）：①它的值域只有是／否兩項，而送出時 `val = raw === 'true'`
      // 只會產生布林，所以**不存在「現在的值不在選項裡」的狀態**；②全部五個使用點
      //（transactions／cashflow／settings 的 applyAll、cards 的 clearPdfPassword、assets 的 clearAccountNo）
      // 都是**不落資料庫的一次性旗標**，`values` 從不帶值 ⇒ 這裡的 v 永遠是 ''（空值本來就不算「值」）。
      // 預設「否」（自主體檢，高）：只有明確 v===true 才選「是」——否則新表單的 applyAll（同時套用整店分類）
      // 會預設勾選，編輯單筆就默默整店改分類＋種品牌學習。opt-in 型旗標寧可預設關。
      input = `<select id="${id}"><option value="true" ${v === true ? 'selected' : ''}>是</option><option value="false" ${v !== true ? 'selected' : ''}>否</option></select>`;
    } else {
      input = `<input id="${id}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${f.step ? `step="${f.step}"` : ''} />`;
    }
    return `<div class="${f.full ? 'full' : ''}"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>${input}</div>`;
  }).join('');

  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass(size)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x-close">×</button></div>
    <div class="modal-body"><form id="modalForm"><div class="form-grid">${fieldHtml}</div>
      <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button>
      <button type="submit" class="btn">儲存</button></div></form></div>
  </div></div>`;

  const close = () => { root.innerHTML = ''; owns.release(); };   // r9：關窗即撤銷擁有權（有主才撤）——關窗後舊 async 不再誤 close/toast
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  bindBackdropClose(root, close);
  root.querySelector('#modalForm').onsubmit = async (e) => {
    e.preventDefault();
    const submitBtn = /** @type {HTMLButtonElement|null} */ (root.querySelector('#modalForm button[type="submit"], #modalForm .btn'));
    if (submitBtn?.disabled) return;                       // 已在送出中（防雙擊建兩筆，自主體檢）
    const out = {};
    for (const f of fields) {
      const raw = root.querySelector('#f_' + f.key).value;
      // required 真的驗（自主體檢：以前只畫星號，金額留空可送出寫進 amount=null）
      if (f.required && String(raw).trim() === '') { toast(`「${f.label}」不能空白`, true); return; }
      let val = raw;
      if (f.type === 'number') val = raw === '' ? null : Number(raw);
      if (f.type === 'checkbox') val = raw === 'true';
      out[f.key] = val;
    }
    if (submitBtn) submitBtn.disabled = true;
    // r6：onSubmit 有 await，回來時只在**仍擁有 modal-root** 時才動 UI——切頁或期間開了新彈窗＝
    //   舊 continuation 不可 close（會清掉後開的彈窗）也不可報過期錯誤。owns() false＝這一格已不是我們的。
    try { await onSubmit(out); if (owns()) close(); }
    catch (err) { if (owns()) { if (submitBtn) submitBtn.disabled = false; toast(err.message, true); } }   // 失敗才解鎖重試；成功已 close
  };
  if (onMount) onMount(root);
}

// 純說明彈窗（無表單）。bodyHtml 為受信任的作者內容（不 esc）。
/** @param {string} title @param {string} bodyHtml @param {{size?:string}=} opts */
export function openInfo(title, bodyHtml, opts = {}) {
  const root = $('#modal-root');
  const owns = claimModalRoot();   // r6：接管 modal-root＝蓋新世代章，任何舊表單的 async close 就作廢（不會清掉這個資訊窗）
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass(opts.size || 'sm')}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x-close">×</button></div>
    <div class="modal-body"><div class="info-body">${bodyHtml}</div>
      <div class="form-actions"><button type="button" class="btn" data-close>了解</button></div></div>
  </div></div>`;
  const close = () => { root.innerHTML = ''; owns.release(); };   // r9：同 openForm，關窗即撤銷擁有權（有主才撤）
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-close]').onclick = close;
  bindBackdropClose(root, close);
}

// ---------- 列印報表共用外殼（訂閱/投組報表） ----------
// A4 預覽視窗的共通 CSS（預覽列、紙張、封面列、列印媒體規則）；各報表把自己的內容 CSS 接在後面
const PRINT_SHELL_CSS = `
      @page { size: A4; margin: 14mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #2f2b27; background: #ebe6dc; font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", sans-serif; font-size: 12px; }
      .preview-bar { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 20px; background: rgba(47,43,39,.92); color: #fff; box-shadow: 0 8px 24px rgba(47,43,39,.18); }
      .preview-bar strong { font-size: 14px; }
      .preview-bar span { color: rgba(255,255,255,.72); font-size: 12px; margin-left: 8px; }
      .preview-bar button { border: 1px solid rgba(255,255,255,.28); background: #fff; color: #2f2b27; border-radius: 8px; padding: 8px 13px; font: inherit; cursor: pointer; }
      .preview-shell { min-height: 100vh; padding: 24px 18px 42px; }
      .paper { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm; background: #fff; box-shadow: 0 18px 60px rgba(47,43,39,.24); }
      .cover { display: flex; justify-content: space-between; gap: 20px; align-items: flex-end; border-bottom: 2px solid #2f2b27; padding-bottom: 16px; margin-bottom: 16px; }
      .muted { color: #8a887f; }
      @media (max-width: 900px) { .paper { width: 100%; min-height: auto; } .preview-shell { padding: 14px; } }
      @media print {
        body { background: #fff; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        .preview-bar { display: none; }
        .preview-shell { padding: 0; }
        .paper { width: auto; min-height: auto; margin: 0; padding: 0; box-shadow: none; }
      }`;

// 開啟列印預覽視窗（popup 被擋時提示）；bodyHtml 需含 .preview-bar 與 .paper 內容
/** @param {string} title @param {string} extraCss @param {string} bodyHtml */
export function openPrintWindow(title, extraCss, bodyHtml) {
  const win = window.open('', '_blank');
  if (!win) return toast('瀏覽器阻擋了列印視窗，請允許彈出視窗後再試一次。', true);
  win.document.open();
  win.document.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>${PRINT_SHELL_CSS}
${extraCss}
    </style></head><body>${bodyHtml}</body></html>`);
  win.document.close();
}

/** 確認後執行刪除並重繪。 @param {string} name @param {() => any} fn */
export async function confirmDelete(name, fn) {
  if (!window.confirm(`確定要刪除「${name}」嗎？此動作無法復原。`)) return;
  try { await fn(); toast('已刪除'); router(); }
  catch (e) { toast(e.message, true); }
}

// ---------- 路由 ----------
// ⚠️ 這裡有**兩個**序號，回答的是兩個不同問題——混用會出事（r9 用兩個真實 bug 換來的教訓）：
//   routeSeq＝**重繪世代**：router() 每跑一次就前進（含同一頁的重繪）。用途是「我這次算完的東西
//     還該不該寫進 #view」——同頁重繪也讓舊的寫入作廢，所以**每次都前進才是對的**。
//   navSeq ＝**換頁世代**：只有**使用者眼前的完整 hash**（含 `?symbol=`／`?tab=` 這類 query）變了
//     才前進。用途是「使用者還在同一頁嗎」——彈窗擁有權、匯入流程的 onPage、清除帳單密碼都問這個。
//     ⚠️ 鑰匙不是「去掉 query 的 route」：個股研究頁的身分本來就含 query，只比 route 的話「換一支股票」
//     不算換頁（r10 抓到）。用完整 hash 反而更單純——背景重繪不會動到網址，所以照樣不前進。
// 為什麼要分家：router() 的呼叫點裡**只有 hashchange 是真的換頁**（刻意不寫死有幾個——鐵則 10）；
// 開機報價更新、自動快照、帳戶改名對齊、店名規則整理、刪除後重繪都會在**同一頁**呼叫 router()。拿 routeSeq 當「換頁」用，
// 這些背景重繪就會被誤判成切頁，而 router() 根本不碰 #modal-root（彈窗還在畫面上）：
//   ①彈窗擁有權被誤撤 → 存檔成功卻不關窗、儲存鈕永遠卡在灰色（r7 我自己種的）。
//   ②匯入流程 onPage 變 false → 密碼窗**靜靜不開**，使用者上傳完什麼都沒發生（P0.5 自己的頭號功能）。
let routeSeq = 0;
export const currentRouteSeq = () => routeSeq;   // 重繪世代：長流程（ibSync/refreshQuotes）寫 DOM 前的自主體檢
let navSeq = 0;
let lastNavKey = /** @type {string|null} */ (null);
export const currentNavSeq = () => navSeq;   // 換頁世代：只有真的換頁才前進（彈窗擁有權／匯入 onPage 用這個）
const renderStockResearch = createStockResearchPage({
  api,
  getView: view,
  getHash: () => location.hash,
  getRouteSeq: currentRouteSeq,
  getViewCurrency: () => {
    try { return localStorage.getItem('pf_viewCur') || 'TWD'; }
    catch { return 'TWD'; }
  },
  esc,
  openForm,
  openInfo,
  toast,
  today: todayStr
});

const ROUTES = {
  dashboard: renderDashboard,
  cashflow: renderCashflow,
  transactions: renderTransactions,
  assets: renderAssets,
  bank: renderBankAccounts,
  ib: renderPortfolio,
  securities: renderSecurities,
  subscriptions: renderSubscriptions,
  cards: renderCards,
  insurance: renderInsurance,
  settings: renderSettings,
  stock: renderStockResearch
};

export async function router() {
  const seq = ++routeSeq;   // 序號防護：快速切頁時，舊頁的 async fn 完成後不可覆蓋新頁面（同頁重繪也算）
  const route = location.hash.replace(/^#/, '').split('?')[0] || 'dashboard';
  // 換頁世代只在**使用者眼前的網址變了**才前進：鑰匙用完整 hash，不是去掉 query 的 route。
  //   r10 訂正：個股研究頁的身分本來就含 query（`#stock?symbol=AAPL&tab=…`），只比 route 的話，
  //   從 AAPL 上一頁跳到 GOOGL 不算換頁，AAPL 表單的舊 continuation 會在 GOOGL 畫面上關窗／報錯。
  //   用完整 hash 反而更單純：背景重繪不會動到網址，所以同頁重繪照樣不前進（原本要防的事沒破）。
  const navKey = location.hash;
  if (navKey !== lastNavKey) { lastNavKey = navKey; navSeq++; }
  document.body.classList.toggle('stock-research-route', route === 'stock');
  document.querySelectorAll('#nav a').forEach((/** @type {HTMLElement} */ a) => a.classList.toggle('active', a.dataset.route === route));
  const fn = Object.hasOwn(ROUTES, route) ? ROUTES[route] : renderDashboard;   // hasOwn（Codex r7#4）：#toString 這種網址會撈到原型函式、頁面卡在「載入中」
  view().innerHTML = '<div class="loading">載入中…</div>';
  try { await fn(); }
  catch (e) { if (seq === routeSeq) view().innerHTML = `<div class="hint">載入失敗：${esc(e.message)}</div>`; }
  if (seq !== routeSeq) return;   // 期間又切了頁＝這次結果已過期，不覆蓋新頁面
  hydrateIcons(view());
}

document.querySelectorAll('#nav a').forEach((/** @type {HTMLElement} */ a) => {
  a.addEventListener('click', () => { location.hash = a.dataset.route || ''; });
});
window.addEventListener('hashchange', router);

$('#snapshotBtn').addEventListener('click', async () => {
  try { await api('/snapshot', { method: 'POST' }); toast('已記錄本月淨資產快照 📸'); router(); }
  catch (e) { toast(e.message, true); }
});

hydrateIcons(document);
router();

// 開機序列落定信號（每日洞察引擎 D3/D4，Codex r14#1/#2）：報價自動更新＋月快照/日線跑完才 resolve。
// **洞察引擎要在這之後才抓 /insights**——否則會用開機前的舊淨值/舊日線算差異，跟重繪後的總覽對不上（#2）；
// 而且抓 /insights 要等外部估值 API（最長各 8 秒），若擋在總覽首屏會卡「載入中」（#1）。故：總覽先用 /summary
// 即時出畫面，洞察在 bootSettled 之後非阻塞地補上。**finally 保證即使開機流程出錯也會 resolve**（不會永遠卡住）。
/** @type {() => void} */
let _bootResolve = () => {};
/** @type {Promise<void>} */
export const bootSettled = new Promise(res => { _bootResolve = () => res(); });

// 1-1：開 app 自動刷新報價（D1）＋記錄本月快照。順序：先刷報價（>1 小時舊才抓，失敗靜默用舊價），
// 日線才反映新價；再記月快照/日線。真的寫入了或報價有更新才提示＋刷新目前頁面；失敗不打擾（手動鈕仍可用）。
(async () => {
  let refreshed = false;
  try { const q = await api('/quotes/refresh-auto', { method: 'POST' }); refreshed = !!(q && q.refreshed); } catch { /* 報價自動更新失敗靜默：用舊價 */ }
  // ↑ 用 q.refreshed（不是 q.updated）：只更新匯率、沒動持股價時 updated 為 0，但外幣持股的台幣估值仍變了、要重繪
  try {
    const r = await api('/snapshot/auto', { method: 'POST' });
    if (r && r.recorded) toast('已自動記錄本月快照 📸');
    // 續費日自動推進（Codex 複審 2026-07-26）：資料庫已經改了，畫面也要跟上——
    // 今天已記過快照、報價也還新鮮時，原本兩個條件都不成立，訂閱頁會停在舊日期直到切頁。
    const rolled = Array.isArray(r?.subsRolled) ? r.subsRolled.length : 0;
    if (rolled) toast(`已把 ${rolled} 筆訂閱的續費日更新到下一期 🔄`);
    if ((r && r.recorded) || refreshed || rolled) router();   // 月快照寫入／報價更新／續費日推進 → 重繪反映最新
  } catch { if (refreshed) router(); /* 自動快照失敗靜默略過，不影響 app 使用 */ }
  finally { _bootResolve(); }   // 開機序列落定 → 洞察引擎現在抓才反映最新報價/日線
})();

// 每日滾動備份（階段四 A）：開 app 檢查今天備份過沒有，沒有就備一份、保留 30 天。
// **失敗不影響 app 使用**（後端自己吞例外），但畫面要明顯警告、連續失敗提高強度（裁決 2026-07-24）。
// 抓不到回應（伺服器沒開/網路錯）＝**不警告**：分不出是備份壞了還是連不上，硬報會變狼來了。
(async () => {
  let status = null;
  try { status = await api('/backup/daily', { method: 'POST' }); }
  catch { /* 連不上就當沒這回事，下次開 app 再說 */ }
  const v = backupAlertView(status);
  const box = document.getElementById('backup-alert');
  if (!box) return;
  box.hidden = !v.show;
  box.innerHTML = v.show ? `<div class="backup-alert ${v.level}">
    ${icon('alert', 18)}
    <div><b>${esc(v.title)}</b><div>${esc(v.body)}</div>${v.why ? `<div class="backup-alert-why">錯誤訊息：${esc(v.why)}</div>` : ''}</div>
  </div>` : '';
})();

// 開 app 自動對齊帳戶名（使用者定 2026-07-21「改一次、處處同步」）：修「帳戶改名後、既有交易顯示名沒跟上」的舊資料。
// 零操作、有變動才重繪；失敗靜默（帳戶儲存時的 beforeSave 仍會對齊）。
(async () => {
  try { const r = await api('/accounts/reconcile-names', { method: 'POST' }); if (r?.changed) router(); }
  catch { /* 靜默：自動對齊失敗不影響 app 使用 */ }
})();

// 店名規則更新後自動整理（使用者定 2026-07-19）：規則住在程式碼裡，以前要「合併→重啟→**記得手動按整理**」，
// 少一步就沒生效（使用者實際踩過）。改成開 app 自動比對規則指紋，同一版只跑一次；有動到才出聲。
(async () => {
  try {
    // 會動到「學過的分類/自訂名」＝不可逆，先問過再套用：平時無感自動跑，
    // 只有這種會覆蓋心血的情況才停下來確認——呼應「平靜日不造噪音，有事才出聲」。
    // ⚠️ 迴圈而不是單次 if：後端的 needsConfirmation 是**單一個 truthy 旗標**（形狀與理由見
    // lib/services/statement-import.js 的 normalizeIfRulesChanged），這裡照著它的通則接——
    // 認得的原因問完再送一次，不認得的走下面的 else 出聲，不會靜靜掉進「沒事發生」。
    // ⚠️ 不要在這裡接「備份沒存成也要繼續」那一類確認：不可逆操作前的自動備份是本專案刻意不做的
    // （理由見 lib/services/backup.js 的設計註解），test/vault-and-backup-integrity.test.js
    // 的〈裁決〉那一題釘著這條路不得認那種旗標。
    /** @type {{force?: boolean}} */
    const answers = {};
    let r = await api('/statement/normalize-auto', { method: 'POST' });
    for (let asked = 0; r?.needsConfirmation && asked < 3; asked++) {
      if (r.needsConfirmation === true) {
        const cf = r.learnedConflicts || [], nc = r.learnedNameChanges || [];
        // 真實總數：明細只截 50 筆，計數必須用 Total——否則會把截斷後的筆數冒充成完整總數
        const total = (r.learnedConflictTotal ?? cf.length) + (r.learnedNameChangeTotal ?? nc.length);
        const lines = [
          ...cf.slice(0, 4).map((/** @type {any} */ c) => `・「${c.key}」的設定：留下 ${c.kept}，捨棄 ${c.dropped}`),
          ...nc.slice(0, 4).map((/** @type {any} */ c) => `・你取的店名「${c.before}」→ ${c.after || '清除'}`)];
        const ok = confirm('店名規則有更新，套用後會蓋掉以下你教過／取過的東西（刪掉規則也救不回來）：\n\n'
          + lines.join('\n') + `\n\n共 ${total} 項。要現在套用嗎？（選取消可稍後到設定頁處理）`);
        if (!ok) return;
        answers.force = true;
      } else {
        // 不認得的原因＝前後端版本走散。**不替使用者猜、也不安靜跳過**：什麼都沒做要說出來。
        return toast('店名規則這次沒有套用（伺服器回了一個目前看不懂的狀況），資料沒有變動', true);
      }
      r = await api('/statement/normalize-auto', { method: 'POST', body: answers });
    }
    if (r?.needsConfirmation) return toast('店名規則這次沒有套用（確認過了仍被擋下），資料沒有變動', true);
    if (!r?.ran) return;
    const bits = [r.changed && `${r.changed} 筆說明`, r.keyChanged && `${r.keyChanged} 筆店家身分`,
      r.learnedNamesFixed && `${r.learnedNamesFixed} 筆學過的舊名`].filter(Boolean);
    // ⚠️ 問過使用者就**一定要回話**（他剛按下的是不可逆的那一步）：
    // 只有學習表衝突、沒有其他變動時 bits 是空的，靜靜結束會讓剛按下「確定」的人不知道到底做了沒。
    if (bits.length) { toast(`店名規則已更新，自動整理了 ${bits.join('、')} ✨`); router(); }
    else if (answers.force) { toast('店名規則已更新並套用 ✨'); router(); }
  } catch { /* 自動整理失敗靜默略過；設定頁的手動「整理店名格式」仍可用 */ }
})();
