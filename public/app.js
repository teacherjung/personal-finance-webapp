// @ts-check
// 個人理財中心 — 前端主程式
import { renderDashboard } from './modules/dashboard.js';
import { renderTransactions } from './modules/transactions.js';
import { renderAssets } from './modules/assets.js';
import { renderPortfolio } from './modules/portfolio.js';
import { renderSubscriptions } from './modules/subscriptions.js';
import { renderCards } from './modules/cards.js';
import { renderInsurance } from './modules/insurance.js';
import { renderSettings } from './modules/settings.js';
import { hydrateIcons } from './modules/icons.js';

// ---------- 共用工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);
export const view = () => $('#view');
// 取 id 元素（頁面自己渲染的、一定存在）。回傳 any：這個 codebase 以 innerHTML 樣板為主，
// 元素層級逐處標型別是噪音；DOM 正確性靠「8 頁 reload 無錯」驗證，型別檢查主力放在資料邏輯。
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
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
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
/** 插入 innerHTML 前必過（XSS 鐵則）。 @param {unknown} s @returns {string} */
// 連單引號一起跳脫（&#39;）：目前全站屬性都用雙引號、尚未被利用，但補上後單/雙引號屬性都安全（多人化前的預防）
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

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

// 圖表色（CHART/PALETTE/AXIS/GRID）定義在零依賴的 modules/theme.js，各模組直接 import——
// 不從 app.js 轉手：模組在檔案頂層就取用色票，經由 app.js 會踩循環 import 的 TDZ。

/** 右下角提示訊息。 @param {string} msg @param {boolean=} isErr 紅色錯誤樣式 */
export function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), 3200);
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

// 通用彈窗表單。
/** @param {{title:string, fields:FormField[], values?:Record<string,any>, onSubmit:(out:Record<string,any>)=>any, onMount?:(root:HTMLElement)=>void, size?:string}} cfg */
export function openForm({ title, fields, values = {}, onSubmit, onMount, size = 'md' }) {
  const root = $('#modal-root');
  const fieldHtml = fields.map(f => {
    const v = values[f.key] ?? f.default ?? '';
    const id = 'f_' + f.key;
    let input;
    if (f.type === 'select') {
      input = `<select id="${id}">${(f.options || []).map(o => {   // 忘給 options 時顯示空下拉、不整頁掛掉
        const ov = typeof o === 'string' ? o : o.value;
        const ol = typeof o === 'string' ? o : o.label;
        return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`;
      }).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea id="${id}" rows="2" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
    } else if (f.type === 'checkbox') {
      input = `<select id="${id}"><option value="true" ${v !== false ? 'selected' : ''}>是</option><option value="false" ${v === false ? 'selected' : ''}>否</option></select>`;
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

  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  bindBackdropClose(root, close);
  root.querySelector('#modalForm').onsubmit = async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      let val = root.querySelector('#f_' + f.key).value;
      if (f.type === 'number') val = val === '' ? null : Number(val);
      if (f.type === 'checkbox') val = val === 'true';
      out[f.key] = val;
    }
    try { await onSubmit(out); close(); }
    catch (err) { toast(err.message, true); }
  };
  if (onMount) onMount(root);
}

// 純說明彈窗（無表單）。bodyHtml 為受信任的作者內容（不 esc）。
/** @param {string} title @param {string} bodyHtml @param {{size?:string}=} opts */
export function openInfo(title, bodyHtml, opts = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass(opts.size || 'sm')}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x-close">×</button></div>
    <div class="modal-body"><div class="info-body">${bodyHtml}</div>
      <div class="form-actions"><button type="button" class="btn" data-close>了解</button></div></div>
  </div></div>`;
  const close = () => { root.innerHTML = ''; };
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
const ROUTES = {
  dashboard: renderDashboard,
  transactions: renderTransactions,
  assets: renderAssets,
  ib: renderPortfolio,
  subscriptions: renderSubscriptions,
  cards: renderCards,
  insurance: renderInsurance,
  settings: renderSettings
};

export async function router() {
  const route = location.hash.replace('#', '') || 'dashboard';
  document.querySelectorAll('#nav a').forEach((/** @type {HTMLElement} */ a) => a.classList.toggle('active', a.dataset.route === route));
  const fn = ROUTES[route] || renderDashboard;
  view().innerHTML = '<div class="loading">載入中…</div>';
  try { await fn(); }
  catch (e) { view().innerHTML = `<div class="hint">載入失敗：${esc(e.message)}</div>`; }
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

// 1-1：開 app 自動記錄本月快照（每個本地日曆日至多一次；同日重開不重複寫）。
// 靜默進行——真的寫入了才提示＋刷新目前頁面；失敗不打擾（手動「記錄本月快照」鈕仍可用）。
(async () => {
  try {
    const r = await api('/snapshot/auto', { method: 'POST' });
    if (r && r.recorded) { toast('已自動記錄本月快照 📸'); router(); }
  } catch { /* 自動快照失敗靜默略過，不影響 app 使用 */ }
})();

// 店名規則更新後自動整理（使用者定 2026-07-19）：規則住在程式碼裡，以前要「合併→重啟→**記得手動按整理**」，
// 少一步就沒生效（使用者實際踩過）。改成開 app 自動比對規則指紋，同一版只跑一次；有動到才出聲。
(async () => {
  try {
    const r = await api('/statement/normalize-auto', { method: 'POST' });
    if (!r?.ran) return;
    const bits = [r.changed && `${r.changed} 筆說明`, r.keyChanged && `${r.keyChanged} 筆店家身分`,
      r.learnedNamesFixed && `${r.learnedNamesFixed} 筆學過的舊名`].filter(Boolean);
    if (bits.length) { toast(`店名規則已更新，自動整理了 ${bits.join('、')} ✨`); router(); }
  } catch { /* 自動整理失敗靜默略過；設定頁的手動「整理店名格式」仍可用 */ }
})();
