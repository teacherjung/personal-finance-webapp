// @ts-check
// 信用卡消費明細頁（三層重構 stage 1，使用者定 2026-07-20）：**只顯示信用卡帳本（ledger:'card'）**。
// 用途＝消費分析＋查帳＋和「收支頁的繳卡費」核對應繳金額；**不進現金流加總**（收支頁才是現金流真相）。
// 手動記帳與收入請走「銀行收支」頁（cashflow.js）；這頁是帳單匯入 + 編輯既有卡消費——
// 帳單匯入工作流已歸戶 transactions-import.js（系統優化階段二①），本檔只留頁面本體（列表/編輯/店家檔案）。
import { api, view, byId, money, esc, monthKey, todayStr, daysUntil, openForm, openInfo, confirmDelete, toast, stmtOrig, currentRouteSeq } from '../app.js';
import { CHART } from './theme.js';
import { icon } from './icons.js';
import { isCardTx } from './categories.js';
import { sortRows, thBuilder, bindSortClicks } from './tx-sort.js';
import { deriveMonths, fallbackMonth, monthOptionsHtml } from './month-select.js';
import { refundLookups, consumptionCategoryTotals, topSpendCategories, unmatchedRefundsForMonth, rewardsForMonth } from './refund-attribution.js';
import { subcategoryOptionsHtml } from './form-options.js';
import { openStatementUpload, openBatchManager } from './transactions-import.js';

// 支出分類樹：每次 render 從 /api/categories 取目前生效的樹（缺→後端回內建預設）。信用卡明細只有支出，
// 表單分類＝支出大類（收入在收支頁、走 incomeTree）。
/** @type {Record<string, string[]>} */
let expTree = {};
// export＝給 transactions-import.js 的預覽窗畫分類下拉（階段二①接縫；呼叫時取用、TDZ 安全）
export const expenseParents = () => Object.keys(expTree);
const allCategories = () => expenseParents();
// 子類 <option>s（含「不分子類」空選項）。
// ⚠️ 這個下拉是編輯彈窗的 onMount **事後重建**的，走不到 openForm 那條（form-options.js）——所以直接呼叫
// 同一支產生器。原本這裡自己 map、而且**漏了「保留清單外的現值」**（settings.js 與 cashflow.js 的同族實作
// 都有 unshift）⇒ 子類被刪掉或改名後，編輯任一筆就被靜靜清成空白、按儲存寫進去（#409 自審抓到，舊病）。
const subOptions = (parent, cur = '') =>
  // hasOwn（Codex r8#3）：分類叫 toString 且不在樹裡時會展開到原型函式而 TypeError
  subcategoryOptionsHtml(['', ...((Object.hasOwn(expTree, parent) && expTree[parent]) || [])], cur);

let monthFilter = monthKey();
// 匯入後跳到「筆數最多」的月份要改這個頁面狀態——匯入工作流搬走後由這個接縫代寫
//（import 綁定唯讀、不能直接賦值；階段二①）
/** @param {string} m */
export function setMonthFilter(m) { monthFilter = m; }
// 排序（使用者定 2026-07-21：所有欄位皆可點表頭排序）——共用 tx-sort.js（絕對值排序 r9#2＋日期次鍵 r8#2 封在那）。
const listSort = { key: 'date', dir: 'desc' };

export async function renderTransactions() {
  const seq = currentRouteSeq();
  // 退款配對表（唯讀）：分類統計與「本月消費」改用**消費歸屬**口徑（使用者定 2026-07-27，與月度回顧一致）。
  // 抓不到就退回帳面口徑並在畫面明說——靜默降級會讓兩種口徑長得一模一樣、看不出數字換過。
  const [allRaw, accounts, cards, tree, refundData] = await Promise.all([
    api('/transactions'), api('/accounts'), api('/cards'), api('/categories'),
    api('/refund-pairs').then(r => (r && Array.isArray(r.pairs)) ? r : null).catch(() => null),
  ]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別覆蓋新頁面（Codex r10#6）
  expTree = tree && typeof tree === 'object' ? tree : {};
  // 只吃信用卡帳本（三層重構）：下游月加總、店家檔案、byCat 全部因此天然只算卡消費、不會混入現金流。
  const all = allRaw.filter(isCardTx);
  const months = deriveMonths(all);
  monthFilter = fallbackMonth(monthFilter, months);

  const th = thBuilder(listSort);
  const rows = sortRows(all.filter(t => t.date?.slice(0, 7) === monthFilter), listSort);

  // 退款歸屬（使用者定 2026-07-27，口徑與月度回顧一致）＝純函式積木 refund-attribution.js，
  // 這裡只負責接線：兩端標記的查詢表、本月分類加總、本月未對應清單。
  const pairs = refundData?.pairs || [];
  const { purchaseDateOf, refundDateOf } = refundLookups(pairs);
  const byCat = consumptionCategoryTotals(rows, all, pairs, monthFilter, Boolean(refundData));
  const expense = Object.values(byCat).reduce((s, v) => s + Number(v || 0), 0);
  const unmatchedThisMonth = unmatchedRefundsForMonth(refundData?.unmatchedRefunds, all, monthFilter);
  const unmatchedTotal = unmatchedThisMonth.reduce((s, /** @type {any} */ u) => s + Math.abs(Number(u.amount) || 0), 0);
  const rewardsThisMonth = rewardsForMonth(refundData?.rewards, all, monthFilter);
  const rewardTotal = rewardsThisMonth.reduce((s, /** @type {any} */ u) => s + Math.abs(Number(u.amount) || 0), 0);
  const topCats = topSpendCategories(byCat, 6);   // 淨額 0 的分類不畫（Codex 複審 2026-07-27，與月度回顧同口徑）
  const maxCat = Math.max(...topCats.map(([, v]) => Math.abs(v)), 1);

  view().innerHTML = `
    <div class="credit-workspace">
      <div class="page-head credit-head">
        <div><h1>信用卡費</h1><p>信用卡帳單的每一筆消費，做分類統計與查帳（不計入現金流，收支見「銀行收支」）</p></div>
        <div class="page-actions">
          ${all.some(t => t.importBatch) ? `<button class="btn-ghost btn-eq" id="stmtBatches">${icon('history', 16)}匯入紀錄</button>` : ''}
          <button class="btn btn-upload" id="uploadStmt">${icon('upload', 16)}上傳信用卡帳單</button>
        </div>
      </div>

      <section class="credit-controls" aria-label="信用卡帳單月份">
        <div class="credit-control">
          <label for="monthSel">月份</label>
          <select id="monthSel">${monthOptionsHtml(months, monthFilter, esc)}</select>
        </div>
        <p>消費統計依消費發生月歸屬；下方明細保留帳單上的原始日期。</p>
      </section>

      <section class="credit-overview-grid" aria-label="本月信用卡摘要與分類">
        <div class="card credit-stat" data-kind="spend">
          <h3>本月消費</h3>
          <div class="stat sm ${expense < 0 ? 'pos' : 'neg'}">${money(expense)}</div>
          <p>${refundData ? '已配對退款回到原消費月抵減' : '目前暫用帳面口徑'}</p>
        </div>
        <div class="card credit-stat" data-kind="count">
          <h3>本月筆數</h3>
          <div class="stat sm">${rows.length}</div>
          <p>帳單原貌，包含退款</p>
        </div>
        <div class="chart-card credit-category-panel">
          <div class="credit-category-head">
            <div><h2>本月消費分類</h2><p>依淨額由高到低，最多六類</p></div>
            <button type="button" class="info-link" id="lensInfo">退款算在哪個月？</button>
          </div>
          ${topCats.length ? topCats.map(([c, v]) => `
            <div class="credit-category-row">
              <div class="credit-category-label"><span>${esc(c)}</span><span class="muted">${money(v)}</span></div>
              <div class="pill-bar credit-category-bar"><div style="width:${(Math.abs(v) / maxCat * 100).toFixed(0)}%;background:${v < 0 ? CHART.green : CHART.red}"></div></div>
            </div>`).join('') : '<p class="empty credit-category-empty">本月尚無消費。</p>'}
          ${!refundData ? '<p class="credit-category-note">退款歸屬暫時讀不到，這裡先用帳面口徑（退款與點數折抵都算在發生當月）。重新整理可再試一次。</p>' : ''}
          ${unmatchedThisMonth.length ? `<p class="credit-category-note">本月另有 ${unmatchedThisMonth.length} 筆退款（共 ${money(unmatchedTotal)}）找不到對應消費，未計入上面的統計。 <button type="button" class="info-link" id="unmatchedInfo">為什麼？</button></p>` : ''}
          ${rewardsThisMonth.length ? `<p class="credit-category-note">本月另有 ${rewardsThisMonth.length} 筆回饋（共 ${money(rewardTotal)}）是點數折抵帳單，未計入上面的統計。 <button type="button" class="info-link" id="rewardInfo">為什麼？</button></p>` : ''}
        </div>
      </section>

      <section class="credit-ledger-section" aria-labelledby="credit-ledger-title">
        <div class="credit-ledger-head">
          <div><h2 id="credit-ledger-title">帳單明細</h2><p>目前顯示 ${rows.length} 筆，包含退款</p></div>
        </div>
        <div class="tbl-wrap credit-ledger">
          <table><thead><tr>${th('date', '消費日')}${th('account', '信用卡')}${th('note', '消費說明')}${th('category', '分類')}${th('subcategory', '子分類')}${th('amount', '金額', 'num')}<th></th></tr></thead>
          <tbody>${rows.map(t => rowHtml(t, { purchaseDateOf, refundDateOf })).join('') || `<tr><td colspan="7" class="empty"><div class="credit-empty-state"><img src="assets/guide-return-neutral.webp" alt=""><div><strong>本月尚無信用卡消費</strong><span>可用右上角「上傳信用卡帳單」匯入本月明細。</span></div></div></td></tr>`}</tbody></table>
        </div>
      </section>
    </div>
  `;

  byId('uploadStmt').onclick = () => openStatementUpload();
  const batchBtn = byId('stmtBatches');
  if (batchBtn) batchBtn.onclick = () => openBatchManager();
  byId('monthSel').onchange = (e) => { monthFilter = e.target.value; renderTransactions(); };
  // 文案＝使用者 2026-07-27 親自改寫的版本（逐字採用，勿順手潤飾）：條列式、關鍵詞標色。
  byId('lensInfo').onclick = () => openInfo('退款算在哪個月？', `
    <ul>
      <li>本月收到的<b class="hl">「退款」</b>不會計算到「本月消費」及「本月消費分類」。</li>
      <li><b class="hl">「退款」</b>收到的金額會回去抵掉「當初刷卡月」的消費支出。
        <div class="info-eg">例：1 月刷 Klook 1,700元｜3 月收到退款 → 1 月的消費會減 1,700｜3 月消費則不受影響</div></li>
      <li>「明細列表」是銀行帳單上印的東西，日期照帳單走，才對得起帳單。</li>
      <li>所以「本月消費分類」圖表金額不會等於「明細列表」的加總，這是刻意的。</li>
      <li>「本月消費」及「本月消費分類」看<b class="hl">當月真實花費</b>｜「明細列表」看<b class="hl">帳單原貌</b>。</li>
      <li>退款要「同一張卡＋同一家店＋同一個金額＋消費日比退款日早」才配得起來。</li>
      <li>配不到的一律不計入（寧可少抵，也不亂抵到別家店），並列在分類統計下方。</li>
    </ul>`, { size: 'md' });
  const unmatchedBtn = byId('unmatchedInfo');
  if (unmatchedBtn) unmatchedBtn.onclick = () => openInfo('這些退款為什麼沒被計入？', `
    <p>它們找不到能證明是「同一筆消費被退回」的對象，常見原因：</p>
    <ul>
      <li><b>原始消費那個月的帳單還沒匯入</b>——補匯之後會自動接上，不用手動修。</li>
      <li><b>部分退款</b>：退的金額和原始消費對不起來（v1 只做金額完全相同的精準配對）。</li>
      <li><b>本來就沒有對應消費</b>：儲值贖回這類，天然不會有配對。（點數折抵已另外歸成「回饋」，不在這份清單裡。）</li>
    </ul>
    <p>配不到就不猜，寧可少抵也不要亂抵到別家店的消費上。</p>
    <div class="table-wrap"><table class="summary-table"><thead><tr><th>退款日</th><th>店家</th><th class="num">金額</th></tr></thead>
      <tbody>${unmatchedThisMonth.map((/** @type {any} */ u) =>
    `<tr><td>${esc(u.date)}</td><td>${esc(u.store)}</td><td class="num">${money(Math.abs(Number(u.amount) || 0))}</td></tr>`).join('')}</tbody></table></div>`, { size: 'md' });
  const rewardBtn = byId('rewardInfo');
  if (rewardBtn) rewardBtn.onclick = () => openInfo('回饋為什麼不算進消費？', `
    <p>這幾筆是<b>用點數折抵帳單</b>：帳單上印成負數，長得很像退款，但它不是把某一筆消費的錢退還給你。</p>
    <ul>
      <li>退款＝那筆東西你沒買成，錢退回來 ⇒ 要回頭把<b>當初那個月</b>的花費減掉。</li>
      <li>回饋＝東西你照買了、錢照花了，只是這次帳單用點數少收你一些 ⇒ 減掉當月花費會讓你以為那個月比較省。</li>
    </ul>
    <p>所以它單獨列在這裡，不進上面的分類統計。不過它確實讓你這期要繳的卡費變少，「緊急預備金可以撐幾個月」那個提醒仍然把它算進去。</p>
    <div class="table-wrap"><table class="summary-table"><thead><tr><th>折抵日</th><th>帳單說明</th><th class="num">金額</th></tr></thead>
      <tbody>${rewardsThisMonth.map((/** @type {any} */ u) =>
    `<tr><td>${esc(u.date)}</td><td>${esc(u.store)}</td><td class="num">${money(Math.abs(Number(u.amount) || 0))}</td></tr>`).join('')}</tbody></table></div>`, { size: 'md' });
  bindSortClicks(view(), listSort, renderTransactions);   // 共用排序 infra（tx-sort.js）
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

/**
 * @param {any} t
 * @param {{purchaseDateOf?: Map<string,string>, refundDateOf?: Map<string,string>}} [ctx]
 *   退款配對標記（使用者定 2026-07-27，兩端都標**日期**）：退款列標「（消費：原消費日）」、
 *   消費列標「（退款：退款日）」。標日期不標月份＝同一個月可能有好幾筆，日期才指得出是哪一筆；
 *   金額不重複標＝同一列的金額欄已經印著。
 *   ⚠️ 純呈現：只加在畫面上，**絕不寫進 note／storeKey**——寫進去會被當成分店括號，下次整理店名就切爛了。
 */
function rowHtml(t, ctx = {}) {
  const isIn = t.type === 'income';
  const isRefund = t.type === 'expense' && Number(t.amount) < 0;
  const isCredit = isIn || isRefund;
  const purchaseDate = isRefund ? (ctx.purchaseDateOf?.get(String(t.id)) || '') : '';
  const refundDate = !isRefund ? (ctx.refundDateOf?.get(String(t.id)) || '') : '';
  const pairTag = purchaseDate
    ? ` <span class="muted nowrap" title="這筆退款抵減的是這一天的消費">（消費：${esc(purchaseDate)}）</span>`
    : (refundDate ? ` <span class="muted nowrap" title="這筆消費在這一天收到退款，已從消費當月的統計扣除">（退款：${esc(refundDate)}）</span>` : '');
  // 滑到顯示名＝看帳單原文（使用者定 2026-07-18：只放原文本身，不加前綴、不加點擊說明）；
  // 原文＝stmtRef 第 4 段（與後端整理/對照表同口徑，剝去重序號 |#N，Codex r10#5）；手動記帳無原文＝無 tooltip
  const orig = t.source === 'stmt' ? stmtOrig(t.stmtRef) : '';
  const tip = orig ? ` title="${esc(orig)}"` : '';
  // 支出且有店名 → 店名可點（開「店家消費檔案」彈窗）；收入或空說明維持純文字
  const noteCell = ((!isIn && String(t.note || '').trim())
    ? `<span class="store-open" data-store="${esc(t.id)}"${tip}>${esc(t.note)}</span>`
    : esc(t.note || '')) + pairTag;
  return `<tr>
    <td class="nowrap">${esc(t.date)}</td>
    <td class="muted nowrap">${esc(t.account || '—')}</td>
    <td class="muted">${noteCell}</td>
    <td>${esc(t.category)}</td>
    <td class="muted">${esc(t.subcategory || '—')}</td>
    <td class="num ${isCredit ? 'pos' : 'neg'}">${isCredit ? '+' : '−'}${money(Math.abs(Number(t.amount) || 0))}</td>
    <td><div class="row-actions"><button class="btn-link btn-sm" data-edit="${esc(t.id)}" title="編輯">${icon('edit', 15)}</button><button class="btn-danger btn-sm" data-del="${esc(t.id)}" title="刪除">${icon('trash', 15)}</button></div></td>
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
  // 排行：所有店家（同聚合口徑）依「總消費」排序，讓數字有份量感。
  // Object.create(null)（Codex r5#5）：店家鑰匙來自帳單文字，撞到原生屬性名時普通物件會算錯（見 byCat）。
  /** @type {Record<string, number>} */
  const totals = Object.create(null);
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
  const variants = Object.create(null);   // 備註是使用者/帳單文字：普通物件遇「__proto__」時 ||= 撈到的是 Object.prototype 本尊（truthy 不重新賦值）→ 直接在全域原型上 count++（Codex r6#3 實測）
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

// 「帳戶 / 卡片」下拉選項＝現有帳戶＋信用卡＋簽帳金融卡的名稱（account 存的就是名稱字串，與帳單匯入同口徑）。
// 簽帳金融卡在列的理由：金融卡帳單匯入的卡片列 account＝簽帳卡名，不在清單裡就只能靠「保留現值」unshift
// 撐著＝看起來像清單外孤兒；會員卡不收（不是消費的家、沒有消費列會掛在它名下）。
// ⚠️ 保留現有值：若這筆的 account 不在清單裡（卡片改名/刪除、或舊資料），要補進選項——
// 否則 select 找不到相符項會自動跳到第一項，一存檔就把使用者的資料默默改掉。
/** @param {any[]} accounts @param {any[]} cards @param {string=} current */
function accountOptions(accounts, cards, current) {
  const names = [
    ...(accounts || []).map(a => a.name),
    ...(cards || []).filter(c => ['credit', 'debit'].includes(c.type || 'credit')).map(c => c.name)
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
  // 國外交易服務費不支援整批改（分類跟隨所屬消費，r2-Codex#3；後端 lib/statement.js isServiceFee 為單一真相）
  // → 不給「同店一起改」勾選框：勾了後端也會略過傳播，顯示框只會誤導（G3 對抗審查 confirmed）。
  const isFeeKey = /國外交易服務費/.test(sk);
  const siblings = (sk && !isFeeKey) ? (all || []).filter(x => x.id !== tx.id && x.source === 'stmt' && String(x.storeKey || '') === sk) : [];
  const propagable = siblings.length;
  openForm({
    title: '編輯消費',   // 信用卡明細＝匯入 + 編輯；手動新增走收支頁
    fields: [
      { key: 'date', label: '消費日', type: 'date', required: true, default: todayStr() },   // 用本地時區（UTC 版在台灣早上 8 點前會差一天）
      { key: 'category', label: '分類', type: 'select', options: allCategories(), default: expTree['飲食'] ? '飲食' : (expenseParents()[0] || '其他') },
      { key: 'subcategory', label: '子類（可留白）', type: 'select', options: [] },   // 由 onMount 依分類連動
      { key: 'amount', label: '金額', type: 'number', required: true, placeholder: '0' },
      { key: 'account', label: '信用卡／簽帳卡', type: 'select', options: accountOptions(accounts, cards, tx?.account) },
      // 標籤與列表表頭一致（使用者定）；「店名／品項」＝這欄也常拿來記買了什麼（LG 18升除濕機（momo）），
      // 不是只有店名（使用者定 2026-07-19）
      { key: 'note', label: '消費說明（店名／品項）', type: 'text', full: true, placeholder: '例：全聯、星巴克、LG 除濕機（momo）' },
      ...(propagable ? [{ key: 'applyAll', label: `同時套用分類到「${sk}」的其他 ${propagable} 筆記錄`, type: 'checkbox', full: true }] : []),
    ],
    values: tx || {},
    onMount: (/** @type {any} */ root) => {
      const catSel = root.querySelector('#f_category');
      const subSel = root.querySelector('#f_subcategory');
      const fill = (parent, cur) => { subSel.innerHTML = subOptions(parent, cur); };
      fill(catSel.value, tx?.subcategory || '');
      catSel.onchange = () => fill(catSel.value, '');
    },
    onSubmit: async (data) => {
      const { applyAll, ...rest } = data;
      const fields = /** @type {any} */ (rest);
      const body = { ...fields, type: 'expense', subcategory: fields.subcategory || '' };   // 信用卡明細一律支出（ledger:'card' 由後端保留，前端不送）
      if (tx) {
        // 「同店一起改」原子化（護欄 G3）：勾了就把 applyAll 併進同一個 PUT，後端一次寫檔完成編輯＋傳播——
        // 不再前端「PUT 再另呼 apply-category」兩次寫（中途失敗會半套用、且這條原本沒接錯誤）
        if (applyAll && sk) body.applyAll = true;
        const r = await api('/transactions/' + tx.id, { method: 'PUT', body });
        if (r.applied) toast(`已儲存，並把「${sk}」的其他 ${r.applied.changed} 筆一起改成 ${body.category}${body.subcategory ? `·${body.subcategory}` : ''}`);
        // 學習是隱形的＝使用者不知道系統記住了什麼（今天「改一筆以為修好了」的一半原因）→ 說出來
        else if (sk) toast(`已儲存。以後「${sk}」的消費會自動歸到 ${body.category}${body.subcategory ? `·${body.subcategory}` : ''}`);
        else toast('已儲存');
      } else {
        await api('/transactions', { method: 'POST', body });
        toast('已儲存');
      }
      renderTransactions();
    }
  });
}
