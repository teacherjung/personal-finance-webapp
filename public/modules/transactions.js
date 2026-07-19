// @ts-check
import { api, view, byId, wan, money, esc, monthKey, todayStr, daysUntil, openForm, openInfo, confirmDelete, toast, modalSizeClass } from '../app.js';
import { CHART } from './theme.js';
import { icon } from './icons.js';
import { INCOME_CATEGORIES } from './categories.js';

// 支出分類樹改為「使用者可自訂」：每次 render 從 /api/categories 取目前生效的樹（缺→後端回內建預設），
// 存這個 module 變數供表單/匯入預覽的下拉共用。收入分類仍固定（INCOME_CATEGORIES）。
/** @type {Record<string, string[]>} */
let expTree = {};
const expenseParents = () => Object.keys(expTree);
// 表單分類選單＝收入類＋支出大類；type 由所選分類自動推導
const allCategories = () => [...INCOME_CATEGORIES, ...expenseParents()];
// 子類 <option>s（含「不分子類」空選項）
const subOptions = (parent, cur = '') => ['', ...(expTree[parent] || [])]
  .map(s => `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${s === '' ? '（不分子類）' : esc(s)}</option>`).join('');

let monthFilter = monthKey();
let listSort = 'date';   // 收支列表排序：'date'（日期新→舊，預設）｜'note-asc'｜'note-desc'（依說明/店名）

export async function renderTransactions() {
  const [all, accounts, cards, tree] = await Promise.all([api('/transactions'), api('/accounts'), api('/cards'), api('/categories')]);
  expTree = tree && typeof tree === 'object' ? tree : {};
  const months = [...new Set(all.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  if (!months.includes(monthFilter) && months.length) monthFilter = months[0];

  const byDate = (a, b) => (b.date || '').localeCompare(a.date || '');
  const listSorters = {
    'date': byDate,
    'note-asc': (a, b) => (a.note || '').localeCompare(b.note || '', 'zh-Hant') || byDate(a, b),
    'note-desc': (a, b) => (b.note || '').localeCompare(a.note || '', 'zh-Hant') || byDate(a, b)
  };
  const rows = all.filter(t => t.date?.slice(0, 7) === monthFilter).sort(listSorters[listSort] || byDate);
  const noteSortInd = listSort === 'note-asc' ? '▲' : listSort === 'note-desc' ? '▼' : '⇅';
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
      <table><thead><tr><th>消費日</th><th>分類</th><th>帳戶 / 信用卡</th><th id="sortNote" style="cursor:pointer;user-select:none" title="點擊依店名／說明排序">說明 <span class="muted">${noteSortInd}</span></th><th class="num">金額</th><th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="6" class="empty">尚無記錄，點右上角新增。</td></tr>`}</tbody></table>
    </div>
  `;

  byId('addTx').onclick = () => openTxForm(null, accounts, cards);
  byId('uploadStmt').onclick = () => openStatementUpload();
  const batchBtn = byId('stmtBatches');
  if (batchBtn) batchBtn.onclick = () => openBatchManager();
  byId('monthSel').onchange = (e) => { monthFilter = e.target.value; renderTransactions(); };
  // 說明欄排序：日期 → 店名 A→Z → 店名 Z→A → 日期（循環）
  byId('sortNote').onclick = () => {
    listSort = listSort === 'note-asc' ? 'note-desc' : listSort === 'note-desc' ? 'date' : 'note-asc';
    renderTransactions();
  };
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openTxForm(all.find(t => t.id === b.dataset.edit), accounts, cards, all));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const t = all.find(x => x.id === b.dataset.del);
    confirmDelete(`${t.category} ${money(t.amount)}`, () => api('/transactions/' + t.id, { method: 'DELETE' }));
  });
  view().querySelectorAll('[data-store]').forEach(el => el.addEventListener('click', () => {
    const t = all.find(x => x.id === /** @type {HTMLElement} */ (el).dataset.store);
    if (t) openStoreProfile(t, all);
  }));
}

function rowHtml(t) {
  const isIn = t.type === 'income';
  // 滑到顯示名＝看帳單原文（使用者定 2026-07-18：只放原文本身，不加前綴、不加點擊說明）；
  // 原文＝stmtRef 第 4 段（與後端整理/對照表同口徑）；手動記帳無原文＝無 tooltip（hover 變色已示意可點）
  const parts = String(t.stmtRef || '').split('|');
  const orig = (t.source === 'stmt' && parts.length >= 4) ? parts.slice(3).join('|').trim() : '';
  const tip = orig ? ` title="${esc(orig)}"` : '';
  // 支出且有店名 → 店名可點（開「店家消費檔案」彈窗）；收入或空說明維持純文字
  const noteCell = (!isIn && String(t.note || '').trim())
    ? `<span class="store-open" data-store="${t.id}"${tip}>${esc(t.note)}</span>`
    : esc(t.note || '');
  return `<tr>
    <td>${esc(t.date)}</td>
    <td>${esc(t.category)}</td>
    <td class="muted">${esc(t.account || '—')}</td>
    <td class="muted">${noteCell}</td>
    <td class="num ${isIn ? 'pos' : 'neg'}">${isIn ? '+' : '−'}${money(t.amount)}</td>
    <td><div class="row-actions"><button class="btn-link btn-sm" data-edit="${t.id}" title="編輯">${icon('edit', 15)}</button><button class="btn-danger btn-sm" data-del="${t.id}" title="刪除">${icon('trash', 15)}</button></div></td>
  </tr>`;
}

// ---------- 店家消費檔案（點收支列表的店名開啟；使用者定 2026-07-18） ----------
// 「同一家店」以身分鑰匙聚合：帳單交易用 storeKey（品牌層級，「麥味登（FP）」與「麥味登（林口感恩店）」
// 合併計算、彈窗內各列小計）；手動記帳沒有 storeKey → 用說明文字，與品牌同名會自然併入。
/** @param {any} x @returns {string} */
const storeIdOf = (x) => String(x.storeKey || x.note || '').trim();
// 外送標記（顯示名尾巴）：與後端 DELIVERY_PREFIXES 的 tag 對齊——加平台時兩邊都要補（Codex#10）
const DELIVERY_TAG_RE = /（(?:FP|UE)）/;
/** 彈窗金額格式（使用者定 2026-07-18：「358 NT」；僅此彈窗，全站其他地方仍用 money() 的「元」） @param {number} n */
const fmtNT = (n) => Math.round(n).toLocaleString('en-US') + ' NT';

/** @param {any} t 被點的那筆 @param {any[]} all 全部交易 */
function openStoreProfile(t, all) {
  const key = storeIdOf(t);
  if (!key) return;
  /** @param {any} x */
  const isExp = (x) => x.type === 'expense' && Number(x.amount) > 0;
  const grp = all.filter(x => isExp(x) && storeIdOf(x) === key)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (!grp.length) return;
  const total = grp.reduce((s, x) => s + Number(x.amount || 0), 0);
  const count = grp.length;
  const last = String(grp[0].date || ''), first = String(grp[count - 1].date || '');
  // 排行：所有店家（同聚合口徑）依「總消費」排序，讓數字有份量感
  /** @type {Record<string, number>} */
  const totals = {};
  for (const x of all) { if (!isExp(x)) continue; const k = storeIdOf(x); if (k) totals[k] = (totals[k] || 0) + Number(x.amount || 0); }
  const rank = Object.entries(totals).sort((a, b) => b[1] - a[1]).findIndex(([k]) => k === key) + 1;
  // 頻率＋近況（白話）：只有一筆就不算平均間隔
  const since = -daysUntil(last);
  const sinceTxt = since <= 0 ? '今天' : since === 1 ? '昨天' : `${since} 天前`;
  const firstTxt = `${first.slice(0, 4)}/${Number(first.slice(5, 7))}`;
  let freqLine;
  if (count === 1) {
    freqLine = `目前只有一筆：${sinceTxt}（${esc(last)}）`;
  } else {
    const span = Math.max(1, -daysUntil(first) - since);
    const gap = Math.max(1, Math.round(span / (count - 1)));
    const gapTxt = gap >= 45 ? `約 ${Math.round(gap / 30)} 個月來一次` : `約 ${gap} 天來一次`;
    freqLine = `平均${gapTxt}，最近一次是 <b>${sinceTxt}</b>（${esc(last)}）· 從 ${esc(firstTxt)} 消費至今`;
  }
  // 近 6 個月長條＋「本月 vs 月平均」解讀（月平均不含本月，本月還沒過完）
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  /** @type {Record<string, number>} */
  const byMonth = {};
  for (const x of grp) { if (!x.date) continue; const m = monthKey(x.date); byMonth[m] = (byMonth[m] || 0) + Number(x.amount || 0); }
  const curM = monthKey();
  const maxM = Math.max(...months.map(m => byMonth[m] || 0), 1);
  const bars = months.map(m => {
    const v = byMonth[m] || 0;
    const h = v > 0 ? Math.max(Math.round(v / maxM * 100), 5) : 0;
    return `<div class="store-bar-col" title="${m}：${fmtNT(v)}"><div class="store-bar${m === curM ? ' cur' : ''}" style="height:${h}%"></div><span>${Number(m.slice(5))}月</span></div>`;
  }).join('');
  // 比較基準＝圖上「前 5 個完整月」的平均，沒消費的月份算 0（Codex#7）：原本只平均「有消費的月份」
  // 又不限於圖表區間，會拿三年前的月份跟本月比，且偶爾才來的店平均被灌高。標籤也寫明區間，免得誤讀。
  const winMonths = months.slice(0, 5);
  const histAvg = winMonths.reduce((s, m) => s + (byMonth[m] || 0), 0) / winMonths.length;
  const curV = byMonth[curM] || 0;
  let monthTxt = curV > 0 ? `本月 <b>${fmtNT(curV)}</b>` : '本月還沒來過';
  if (curV > 0 && histAvg > 0) {
    const pct = Math.round((curV - histAvg) / histAvg * 100);
    monthTxt += pct === 0 ? ` · 與前 5 個月平均（${fmtNT(histAvg)}）差不多` : ` · 比前 5 個月平均（${fmtNT(histAvg)}）${pct > 0 ? '多' : '少'} ${Math.abs(pct)}%`;
  }
  // 同店不同寫法（外送／分店）小計：只有一種寫法就不顯示這區
  /** @type {Record<string, {count: number, total: number}>} */
  const variants = {};
  for (const x of grp) { const n = String(x.note || '（無說明）'); const v = (variants[n] ||= { count: 0, total: 0 }); v.count++; v.total += Number(x.amount || 0); }
  const vEntries = Object.entries(variants).sort((a, b) => b[1].total - a[1].total);
  const variantHtml = vEntries.length > 1 ? `
    <div class="store-sec"><div class="store-sec-title">包含哪些店（分店／不同寫法）</div>
      ${vEntries.map(([n, v]) => `<div class="store-line"><span>${esc(n)}${DELIVERY_TAG_RE.test(n) ? ' <span class="muted">外送</span>' : ''}</span><span class="muted">${v.count} 次 · ${fmtNT(v.total)}</span></div>`).join('')}
    </div>` : '';
  const recentHtml = grp.slice(0, 5).map(x =>
    `<div class="store-line"><span class="muted">${esc(String(x.date || '').slice(5).replace('-', '/'))}</span><span>${fmtNT(Number(x.amount || 0))}</span></div>`).join('');
  openInfo(key, `
    <div class="store-top"><span class="muted">${esc(t.category || '')}</span><span class="store-rank">店家消費排行 第 ${rank} 名</span></div>
    <div class="store-stats">
      <div><div class="muted">總共花了</div><div class="stat sm">${fmtNT(total)}</div></div>
      <div><div class="muted">來過</div><div class="stat sm">${count} 次</div></div>
      <div><div class="muted">平均每次</div><div class="stat sm">${fmtNT(total / count)}</div></div>
    </div>
    <p class="store-freq">${freqLine}</p>
    <div class="store-sec"><div class="store-sec-head"><span class="store-sec-title">近 6 個月</span><span class="muted">${monthTxt}</span></div>
      <div class="store-bars">${bars}</div></div>
    ${variantHtml}
    <div class="store-sec"><div class="store-sec-title">最近 ${Math.min(5, count)} 筆</div>${recentHtml}</div>
  `, { size: 'md' });
}

// 「帳戶 / 信用卡」下拉選項＝現有帳戶＋信用卡的名稱（account 存的就是名稱字串，與帳單匯入同口徑）。
// ⚠️ 保留現有值：若這筆的 account 不在清單裡（卡片改名/刪除、或舊資料），要補進選項——
// 否則 select 找不到相符項會自動跳到第一項，一存檔就把使用者的資料默默改掉。
/** @param {any[]} accounts @param {any[]} cards @param {string=} current */
function accountOptions(accounts, cards, current) {
  const names = [
    ...(accounts || []).map(a => a.name),
    ...(cards || []).filter(c => (c.type || 'credit') === 'credit').map(c => c.name)
  ].filter(Boolean);
  const uniq = [...new Set(names)];
  if (current && !uniq.includes(current)) uniq.unshift(current);
  return [{ value: '', label: '（不指定）' }, ...uniq.map(n => ({ value: n, label: n }))];
}

/** @param {any=} tx @param {any[]=} accounts @param {any[]=} cards @param {any[]=} all 全部交易（算「同店還有幾筆」用） */
function openTxForm(tx, accounts = [], cards = [], all = []) {
  // 傳播提示（使用者定 2026-07-19：解「改一筆以為修好了」的錯覺）：帳單交易若同一把身分鑰匙
  // 還有別筆分類不同，給一個勾選框整店一起改——不然使用者要逐筆點，或誤以為已經全改好。
  const sk = tx?.source === 'stmt' ? String(tx.storeKey || '') : '';
  const siblings = sk ? (all || []).filter(x => x.id !== tx.id && x.source === 'stmt' && String(x.storeKey || '') === sk) : [];
  const propagable = siblings.length;
  openForm({
    title: tx ? '編輯記錄' : '新增收支',
    fields: [
      { key: 'date', label: '日期', type: 'date', required: true, default: todayStr() },   // 用本地時區（UTC 版在台灣早上 8 點前會差一天）
      { key: 'category', label: '分類', type: 'select', options: allCategories(), default: expTree['飲食'] ? '飲食' : (expenseParents()[0] || '其他') },
      { key: 'subcategory', label: '子類（支出才有，可留白）', type: 'select', options: [] },   // 由 onMount 依分類連動
      { key: 'amount', label: '金額', type: 'number', required: true, placeholder: '0' },
      { key: 'account', label: '帳戶 / 信用卡', type: 'select', options: accountOptions(accounts, cards, tx?.account) },
      // 標籤與列表表頭一致（使用者定）；「店名／品項」＝這欄也常拿來記買了什麼（LG 18升除濕機（momo）），
      // 不是只有店名（使用者定 2026-07-19）
      { key: 'note', label: '說明（店名／品項）', type: 'text', full: true, placeholder: '例：全聯、星巴克、LG 除濕機（momo）' },
      ...(propagable ? [{ key: 'applyAll', label: `同時套用分類到「${sk}」的其他 ${propagable} 筆記錄`, type: 'checkbox', full: true }] : []),
    ],
    values: tx || {},
    onMount: (/** @type {any} */ root) => {
      const catSel = root.querySelector('#f_category');
      const subSel = root.querySelector('#f_subcategory');
      const fill = (parent, cur) => { subSel.innerHTML = subOptions(parent, cur); subSel.disabled = INCOME_CATEGORIES.includes(parent); };
      fill(catSel.value, tx?.subcategory || '');
      catSel.onchange = () => fill(catSel.value, '');
    },
    onSubmit: async (data) => {
      const { applyAll, ...rest } = data;
      const fields = /** @type {any} */ (rest);
      const type = INCOME_CATEGORIES.includes(fields.category) ? 'income' : 'expense';
      const body = { ...fields, type, subcategory: type === 'income' ? '' : (fields.subcategory || '') };
      if (tx) await api('/transactions/' + tx.id, { method: 'PUT', body });
      else await api('/transactions', { method: 'POST', body });
      if (applyAll && sk) {
        const r = await api('/statement/apply-category', { method: 'POST',
          body: { storeKey: sk, category: body.category, subcategory: body.subcategory } });
        toast(`已儲存，並把「${sk}」的其他 ${r.changed} 筆一起改成 ${body.category}${body.subcategory ? `·${body.subcategory}` : ''}`);
      } else if (sk) {
        // 學習是隱形的＝使用者不知道系統記住了什麼（今天「改一筆以為修好了」的一半原因）→ 說出來
        toast(`已儲存。以後「${sk}」的消費會自動歸到 ${body.category}${body.subcategory ? `·${body.subcategory}` : ''}`);
      } else toast('已儲存');
      renderTransactions();
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
    onMount: (/** @type {any} */ root) => {
      const inp = root.querySelector('#f_file');
      if (inp) { inp.accept = '.pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; inp.onchange = () => { file = inp.files?.[0] || null; }; }
    },
    onSubmit: async () => {
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
  const root = byId('modal-root');
  let curCard = cardId, curR = r, previewSort = 'none';   // 'none'（原始順序）｜'asc'｜'desc'（依店名）
  const detected = `${curR.bank ? esc(curR.bank) : '未知'}${curR.lastFour ? ` · 末四碼 ${esc(curR.lastFour)}` : ''}`;
  const close = () => { root.innerHTML = ''; };
  // 重繪前把目前的勾選與分類選擇存回資料，排序後不遺失
  const syncEdits = () => curR.transactions.forEach((t, i) => {
    const cb = root.querySelector(`input[data-row="${i}"]`);
    if (cb) t._checked = cb.checked;
    const cat = root.querySelector(`select[data-cat="${i}"]`);
    if (cat) { t.subcategory = (cat.value === cat.dataset.autocat) ? cat.dataset.autosub : ''; t.category = cat.value; }
  });
  const applyPreviewSort = () => {
    const key = (t) => (t.store || t.desc || '');
    if (previewSort === 'asc') curR.transactions.sort((a, b) => key(a).localeCompare(key(b), 'zh-Hant'));
    else if (previewSort === 'desc') curR.transactions.sort((a, b) => key(b).localeCompare(key(a), 'zh-Hant'));
    else curR.transactions.sort((a, b) => (a._ord || 0) - (b._ord || 0));   // 還原原始順序
  };
  const catSelHtml = (i, cat, sub) => `<select data-cat="${i}" data-autocat="${esc(cat)}" data-autosub="${esc(sub || '')}">${expenseParents().map(c =>
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
      // 帳單期別由後端從帳單表頭讀出（curR.statementMonth），跟著匯入一起存進每一筆（使用者定 2026-07-19）
      const out = await api(`/cards/${curCard}/statement/import`, { method: 'POST', body: { transactions: picked, statementMonth: curR.statementMonth || '', statementDue: curR.statementDue ?? null } });
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
    curR.transactions.forEach((t, i) => { if (t._ord === undefined) t._ord = i; });   // 記原始順序（供「取消排序」還原）
    const sortInd = previewSort === 'asc' ? '▲' : previewSort === 'desc' ? '▼' : '⇅';
    const rowsHtml = curR.transactions.map((t, i) => {
      const dis = t.isPayment;                       // 繳款/退款不可匯入
      const checked = t._checked !== undefined ? t._checked : (!dis && !t.duplicate);   // 沿用使用者勾選，否則重複預設不勾
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
          <table><thead><tr><th></th><th>消費日</th><th id="pvSortNote" style="cursor:pointer;user-select:none" title="依店名排序">說明 <span class="muted">${sortInd}</span></th><th>分類</th><th class="num">金額</th><th>狀態</th></tr></thead>
          <tbody>${rowsHtml}</tbody></table>
        </div>
        <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button>
          <button type="button" class="btn" id="doImport">匯入勾選項目</button></div>
      </div>
    </div></div>`;
    root.querySelector('.x-close').onclick = close;
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
        const pr = await api(`/cards/${newId}/statement/preview`, { method: 'POST', body: { data: b64 } });
        curCard = newId; curR = pr; previewSort = 'none'; draw();   // 換卡＝重算重複標記、排序回原始
      } catch (err) { toast('改卡片重新解析失敗：' + err.message, true); e.target.value = curCard; }
    };
  };

  draw();
}

// 匯入完成：確認記到哪張卡，選錯可當場整批改（其餘晚點也能從「帳單批次」改）。
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
  const root = byId('modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('sm')}">
    <div class="modal-head"><h2>匯入完成</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p>已匯入 <b>${out.imported}</b> 筆到「<b>${esc(out.cardName || '')}</b>」${out.skipped ? `<span class="muted">，略過 ${out.skipped} 筆（重複或不可匯入）</span>` : ''}。</p>
      ${importSummaryHtml(out)}
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
  const root = byId('modal-root');
  const render = (list) => {
    const rows = list.map(b => `<tr>
      <td>${esc(b.cardName || '—')}</td>
      <td class="nowrap" title="消費日範圍：${esc(b.minDate || '')} ~ ${esc(b.maxDate || '')}">
        <span class="store-open" data-setmonth="${esc(b.batchId)}" data-cur="${esc(b.stmtMonth || '')}" title="點擊修正帳單年月">${esc(b.stmtMonth || monthKey(b.maxDate || ''))}</span>
        ${b.stmtMonth ? '' : '<span class="muted" style="font-size:11px" title="帳單表頭讀不出期別，這是用最後一筆消費日推估的；點左邊可修正">（推估）</span>'}</td>
      <td class="num">${b.count}</td>
      <td class="num">${money(b.amount)}</td>
      <td class="num" title="帳單自己印的「本期應繳總金額」。與匯入金額本就不同：應繳＝上期未繳＋本期新增＋分期本期＋年費利息−已繳款/退款，而匯入金額只算這次記進帳的消費">${b.stmtDue != null ? money(b.stmtDue) : '<span class="muted">—</span>'}</td>
      <td><div class="row-actions">
        <button class="btn-link btn-sm" data-reassign="${esc(b.batchId)}">改卡片</button>
        <button class="btn-danger btn-sm" data-delbatch="${esc(b.batchId)}" title="刪除整批">${icon('trash', 15)}</button>
      </div></td>
    </tr>`).join('');
    root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('lg')}">
      <div class="modal-head"><h2>帳單匯入批次</h2><button class="x-close">×</button></div>
      <div class="modal-body">
        <p class="muted" style="font-size:12.5px;margin-bottom:10px">每一列是一次帳單匯入。<b>帳單年月</b>讀自帳單表頭（期別／結帳日）；讀不出來會標「推估」（用最後一筆消費日推的），<b>點年月可手動修正</b>。滑上去可看完整消費日範圍——分期會把範圍拉到很早（分期每期都掛回原始消費日），屬正常。<b>匯入金額</b>＝這次記進帳的消費總和；<b>應繳金額</b>＝帳單自己印的「本期應繳總金額」——兩者本來就不同（應繳還含上期未繳、分期本期、年費利息，並扣掉已繳款）。若當初選錯卡片，按「改卡片」整批改到正確的卡。</p>
        <div class="tbl-wrap"><table>
          <thead><tr><th>卡片</th><th>帳單年月</th><th class="num">筆數</th><th class="num">匯入金額</th><th class="num">應繳金額</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">尚無匯入批次。</td></tr>'}</tbody>
        </table></div>
        <div class="form-actions"><button type="button" class="btn" data-close>關閉</button></div>
      </div>
    </div></div>`;
    root.querySelector('.x-close').onclick = () => { root.innerHTML = ''; };
    root.querySelector('[data-close]').onclick = () => { root.innerHTML = ''; };
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
