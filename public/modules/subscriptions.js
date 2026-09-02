// @ts-check
// 訂閱追蹤頁（頁面協調層）：攤提數學已歸戶 subscriptions-model.js（系統優化階段二②，零依賴純函式＋
// 前後端對照考題）；A4 列印報表已歸戶 subscriptions-report.js（階段二③）。本檔留 DOM/圖表/表單。
// subStatus 留此（吃 daysUntil＝依「今天」而變）；帶 export 的常數/函式＝報表模組的接縫（呼叫時取用、TDZ 安全）。
import { api, view, byId, esc, money, daysUntil, monthKey, todayStr, openForm, openInfo, toast, currentRouteSeq } from '../app.js';
import { CHART, AXIS, GRID } from './theme.js';
import { icon } from './icons.js';
import { renderHistorySection } from './history.js';
import {
  RECORD_START, CYCLE_LABELS, CYCLE_FEE_LABELS, isLifetimeSub, feeMonthVal, feeYearVal,
  addMonths, costForMonth, activeInMonth, amortizedForMonth, costDetailRows,
} from './subscriptions-model.js';
import { printSubscriptionReport } from './subscriptions-report.js';

export const CATEGORIES = ['工具', '學習', '生活', '娛樂', '健康'];
export const CAT_COLOR = { '工具': CHART.blue, '健康': CHART.red, '學習': CHART.green, '娛樂': CHART.orange, '生活': CHART.yellow, '未分類': CHART.gray };
const EMAIL_OPTIONS = ['Yahoo', 'Gmail', 'iCloud', 'EIEI'];

export const fmtFee = (n) => money(n);   // 明細/表格/報表金額：整數 +「元」（app.js 統一格式器；延遲取值避免循環 import TDZ）
const categoryRank = (s) => {
  const i = CATEGORIES.indexOf(s.category || '未分類');
  return i >= 0 ? i : CATEGORIES.length;
};

function serviceNameHtml(s) {
  return `<b class="service-name">${esc(s.name)}</b>`;
}
export function cardLabel(name) {
  // hasOwn（Codex r6#3）：name='toString' 時裸查表撈到原型上的函式（truthy）→ 標籤變函式原始碼、總額算成字串
  const MAP = { '台新': '台新卡', '富邦': '富邦卡', '遠銀': '遠銀卡' };
  return (Object.hasOwn(MAP, name) ? MAP[name] : '') || name || '—';
}
function normEmail(e) {
  if (!e) return '';
  if (EMAIL_OPTIONS.includes(e)) return e;
  const s = e.toLowerCase();
  if (s.includes('gmail')) return 'Gmail';
  if (s.includes('icloud') || s.includes('me.com')) return 'iCloud';
  if (s.includes('yahoo')) return 'Yahoo';
  return e;
}

// ---- 狀態：使用中 / 即將停用 / 已停用 ----
//（不在 subscriptions-model.js：daysUntil 依「今天」而變＝非固定輸入輸出，攤提純函式不收）
export function subStatus(s) {
  if (s.status === 'ended' || s.active === false) return 'ended';
  if (s.status === 'ending' || s.endsOn) return daysUntil(s.endsOn) > 0 ? 'ending' : 'ended';
  return 'active';
}

// 月份結束後，把「已完成月份」的實際攤提凍結到歷史紀錄（只補尚未紀錄的）
let freezeInFlight = null;
async function freezeCompletedMonths(subs) {
  if (freezeInFlight) return freezeInFlight;   // 防重入（自主體檢）：雙 render 併發會各讀到「還沒寫」的 history、各寫一份重複月份列
  freezeInFlight = (async () => {
  const hist = await api('/history');
  const have = new Set(hist.map(h => h.month));
  const lastDone = addMonths(monthKey(), -1);   // 上個（已結束）月份
  const added = [];
  let mk = RECORD_START;
  while (mk <= lastDone) {
    if (!have.has(mk)) added.push({ month: mk, amount: Math.round(amortizedForMonth(subs, mk)) });
    mk = addMonths(mk, 1);
  }
  for (const rec of added) await api('/history', { method: 'POST', body: rec });
  return added.length;
  })();
  try { return await freezeInFlight; } finally { freezeInFlight = null; }
}

const VALID_SORT_KEYS = ['manual', 'feeMonth', 'feeYear', 'when', 'card', 'email', 'category'];   // 與 SORTERS 同步
function normalizeSortKey(k) {
  if (k === 'fee') return 'feeMonth';
  if (k === 'name') return 'category';
  if (k === 'status') return 'when';
  // 白名單（Codex r9#3）：localStorage 的值可被手改成 hasOwnProperty 之類的原型名，
  // 裸查 SORTERS[key] 會拿到原型函式、.sort() 直接 TypeError、整頁掛掉
  return VALID_SORT_KEYS.includes(k) ? k : 'when';
}
const legacySortKey = normalizeSortKey(localStorage.getItem('sub_sortKey') || 'when');
const legacySortDir = localStorage.getItem('sub_sortDir') || 'asc';
const listSorts = {
  active: {
    key: normalizeSortKey(localStorage.getItem('sub_activeSortKey') || legacySortKey),
    dir: localStorage.getItem('sub_activeSortDir') || legacySortDir
  },
  ending: {
    key: normalizeSortKey(localStorage.getItem('sub_endingSortKey') || legacySortKey),
    dir: localStorage.getItem('sub_endingSortDir') || legacySortDir
  },
  ended: {
    key: normalizeSortKey(localStorage.getItem('sub_endedSortKey') || legacySortKey),
    dir: localStorage.getItem('sub_endedSortDir') || legacySortDir
  }
};
function getListSort(listKey) { return listSorts[listKey] || listSorts.active; }
function setListSort(listKey, k, d) {
  const s = getListSort(listKey);
  s.key = normalizeSortKey(k); s.dir = d;
  try {
    localStorage.setItem(`sub_${listKey}SortKey`, s.key);
    localStorage.setItem(`sub_${listKey}SortDir`, s.dir);
  } catch {}
}
let charts = [];
function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }
/** @type {any} */ let syncColsTimer = 0;   // setTimeout 的代號（瀏覽器是數字、Node 型別是物件，標 any 兩邊都通）
let subscriptionNotice = '';

function subscriptionsPageHeadHtml({ showPrint = true, showAdd = true } = {}) {
  return `<div class="page-head subscriptions-page-head">
    <div><span class="page-eyebrow">固定支出管理</span><h1>訂閱追蹤</h1><p>掌握每月固定支出、下一次扣款與準備停用的服務。</p></div>
    <div class="page-actions">
      ${showPrint ? `<button class="btn-ghost icon-btn" id="printSubs" title="列印 / 匯出 PDF" aria-label="列印 / 匯出 PDF">${icon('print', 16)}</button>` : ''}
      ${showAdd ? `<button class="btn" id="addSub">${icon('plus', 16)}新增訂閱</button>` : ''}
    </div>
  </div>`;
}

function subscriptionNoticeHtml(message) {
  if (!message) return '';
  return `<div class="subscriptions-notice" role="status" aria-live="polite">${icon('check', 17)}<span>${esc(message)}</span></div>`;
}

function subscriptionsLoadingHtml() {
  return `<div class="subscriptions-page">
    ${subscriptionsPageHeadHtml({ showPrint: false, showAdd: false })}
    <section class="subscriptions-state subscriptions-loading-state" aria-live="polite" aria-busy="true">
      <span class="subscriptions-state-icon subscriptions-loading-icon">${icon('refresh', 30)}</span>
      <div><h2>正在整理訂閱狀態</h2><p>讀取清單後，系統會依停用日期校正狀態，完成後再顯示固定支出與近期扣款。</p></div>
    </section>
  </div>`;
}

function subscriptionsLoadErrorHtml(message) {
  const detail = message ? `<details><summary>查看技術資訊</summary><code>${esc(String(message))}</code></details>` : '';
  return `<div class="subscriptions-page">
    ${subscriptionsPageHeadHtml({ showPrint: false, showAdd: false })}
    <section class="subscriptions-state subscriptions-error-state" role="alert">
      <img src="assets/guide-return-neutral.webp" alt="" />
      <div><span class="subscriptions-state-kicker">這次沒有完成</span><h2>訂閱狀態暫時無法載入</h2>
        <p>若你剛完成新增、修改、刪除，或系統正在更新停用狀態，部分操作可能已經成功。請先重新載入確認，避免重複操作。</p>
        <button class="btn" id="retrySubscriptions">${icon('refresh', 16)}重新載入</button>${detail}
      </div>
    </section>
  </div>`;
}

function subscriptionsEmptyHtml(notice) {
  return `<div class="subscriptions-page">
    ${subscriptionsPageHeadHtml({ showPrint: false })}
    ${subscriptionNoticeHtml(notice)}
    <section class="subscriptions-state subscriptions-empty-state">
      <img src="assets/guide-return-neutral.webp" alt="" />
      <div><span class="subscriptions-state-kicker">從第一筆固定支出開始</span><h2>尚無訂閱紀錄</h2>
        <p>加入經常使用的服務後，這裡會整理每月攤提、下一次扣款、續費卡片與停用進度。</p>
        <button class="btn" id="emptyAddSub">${icon('plus', 16)}新增第一筆訂閱</button>
      </div>
    </section>
    <div id="historySection"></div>
  </div>`;
}

function rerenderSubscriptionsAfterAction(seq, message) {
  if (seq !== currentRouteSeq()) return;
  subscriptionNotice = message;
  renderSubscriptions({ showLoading: false });
}

// 排序用的「續費/停用」生效日期
const effDate = (s) => isLifetimeSub(s) ? '9999-12-31' : (subStatus(s) === 'active' ? s.nextCharge : s.endsOn) || s.nextCharge || '';

// 基礎升冪比較器（降冪時整體反轉）
const SORTERS = {
  manual: (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9),
  feeMonth: (a, b) => feeMonthVal(a) - feeMonthVal(b),
  feeYear: (a, b) => feeYearVal(a) - feeYearVal(b),
  when: (a, b) => effDate(a).localeCompare(effDate(b)),
  card: (a, b) => (a.card || '').localeCompare(b.card || '', 'zh-Hant'),
  email: (a, b) => normEmail(a.email).localeCompare(normEmail(b.email), 'zh-Hant'),
  category: (a, b) => categoryRank(a) - categoryRank(b)
    || (a.name || '').localeCompare(b.name || '', 'zh-Hant')
};
// 標題的排序三角形
function triHtml(listKey, key) {
  const s = getListSort(listKey);
  if (s.key === key) return `<span class="sort-tri active">${s.dir === 'asc' ? '▲' : '▼'}</span>`;
  return `<span class="sort-tri">▾</span>`;
}

function sortTableRows(rows, listKey) {
  const s = getListSort(listKey);
  const out = rows.slice().sort((Object.hasOwn(SORTERS, s.key) && SORTERS[s.key]) || SORTERS.when);
  if (s.dir === 'desc') out.reverse();
  if (listKey === 'active') out.sort((a, b) => Number(isLifetimeSub(a)) - Number(isLifetimeSub(b)));
  return out;
}

window.addEventListener('resize', () => {
  clearTimeout(syncColsTimer);
  syncColsTimer = setTimeout(syncSubscriptionColumnWidths, 120);
});

// 背景作業：依「訂閱停用日」自動更新狀態（停用前一個月內→即將停用、已過期→已停用）
async function autoExpire(subs) {
  const updates = [];
  for (const s of subs) {
    if (s.status === 'lifetime') {
      updates.push([s.id, { status: 'active', active: true, cycle: 'lifetime', nextCharge: '', endsOn: '', expiryDate: '' }]);
      continue;
    }
    if (!s.expiryDate) continue;
    const d = daysUntil(s.expiryDate);
    const st = subStatus(s);
    if (isLifetimeSub(s)) continue;
    if (d < 0) {
      if (st !== 'ended') updates.push([s.id, { status: 'ended', active: false, endsOn: s.expiryDate }]);
    } else if (d <= 30) {
      if (st === 'active') updates.push([s.id, { status: 'ending', active: true, endsOn: s.expiryDate }]);
    }
  }
  if (!updates.length) return false;
  await Promise.all(updates.map(([id, body]) => api('/subscriptions/' + id, { method: 'PUT', body })));
  return true;
}

export async function renderSubscriptions({ showLoading = true } = {}) {
  const seq = currentRouteSeq();
  const notice = subscriptionNotice;
  subscriptionNotice = '';
  destroyCharts();
  if (showLoading) view().innerHTML = subscriptionsLoadingHtml();

  let raw;
  let cards;
  try {
    [raw, cards] = await Promise.all([api('/subscriptions'), api('/cards')]);
    if (seq !== currentRouteSeq()) return;   // fetch 期間切走了頁（Codex r10#6）
    const expired = await autoExpire(raw);
    if (seq !== currentRouteSeq()) return;   // autoExpire 的 PUT 往返期間切走了頁——含下面的遞迴分支都別再動
    if (expired) {
      subscriptionNotice = notice;
      return renderSubscriptions({ showLoading: false });   // 沿用目前畫面／首次載入卡，不讓內部校正造成頁面高度跳動
    }
  } catch (e) {
    if (seq !== currentRouteSeq()) return;
    view().innerHTML = subscriptionsLoadErrorHtml(e?.message);
    const retry = byId('retrySubscriptions');
    if (retry) retry.onclick = () => renderSubscriptions();
    return;
  }

  const creditCards = cards.filter(c => (c.type || 'credit') === 'credit').map(c => c.name);
  const validSet = new Set(creditCards);
  freezeCompletedMonths(raw).catch(() => {});   // 月份結束後自動凍結到歷史紀錄
  if (!raw.length) {
    view().innerHTML = subscriptionsEmptyHtml(notice);
    byId('addSub').onclick = () => openSubForm(null, creditCards);
    byId('emptyAddSub').onclick = () => openSubForm(null, creditCards);
    renderHistorySection(byId('historySection'));
    return;
  }
  const subs = raw.slice();
  const mainSubs = sortTableRows(subs.filter(s => subStatus(s) === 'active'), 'active');
  const endingSubs = sortTableRows(subs.filter(s => subStatus(s) === 'ending'), 'ending');
  const endedSubs = sortTableRows(subs.filter(s => subStatus(s) === 'ended'), 'ended');
  const staleSubs = subs.filter(s => s.card && !validSet.has(s.card));
  const curMk = monthKey();
  const nextMk = addMonths(curMk, 1);
  const sumMonth = (mk) => amortizedForMonth(subs, mk);
  const thisMonth = sumMonth(curMk);
  const nextMonth = sumMonth(nextMk);
  const delta = nextMonth - thisMonth;
  const activeThis = subs.filter(s => activeInMonth(s, curMk));
  const endingCount = subs.filter(s => subStatus(s) === 'ending').length;

  view().innerHTML = `
    <div class="subscriptions-page">
    ${subscriptionsPageHeadHtml()}
    ${subscriptionNoticeHtml(notice)}

    ${staleSubs.length ? `<div class="subscriptions-attention danger">
      <span class="subscriptions-attention-mark">卡片</span>
      <div><strong>續費卡已失效</strong><p>有 <b>${staleSubs.length}</b> 筆訂閱的續費卡已不在「卡片追蹤」中（${esc([...new Set(staleSubs.map(s => cardLabel(s.card)))].join('、'))}），可能該卡已換發或停用。請編輯這些訂閱、改用有效的卡片。</p></div>
    </div>` : ''}

    <div class="subscriptions-summary">
      <div class="subscriptions-summary-item"><span>本月費用</span><strong>${fmtFee(thisMonth)}</strong><small>${curMk}</small><button class="cost-method-btn" data-cost-detail="${curMk}">查看計算方式</button></div>
      <div class="subscriptions-summary-item"><span>下月費用</span><strong>${fmtFee(nextMonth)}</strong><small class="${delta < 0 ? 'pos' : delta > 0 ? 'neg' : ''}">較本月 ${delta === 0 ? '持平' : (delta > 0 ? '+' : '−') + fmtFee(Math.abs(delta))}</small><button class="cost-method-btn" data-cost-detail="${nextMk}">查看 ${nextMk}</button></div>
      <div class="subscriptions-summary-item"><span>年化固定支出</span><strong>${fmtFee(thisMonth * 12)}</strong><small>以本月費用換算</small></div>
      <div class="subscriptions-summary-item"><span>即將停用</span><strong>${endingCount} 項</strong><small>${endingCount ? '已排入停用流程' : '目前沒有待停用服務'}</small></div>
    </div>

    <section class="subscriptions-section subscriptions-workspace">
      <div class="subscriptions-section-head"><div><span>使用中</span><h2>訂閱與近期扣款</h2></div><p>排序、記帳與停用標記都在這裡處理</p></div>
    <div class="active-subscription-group">
      ${subscriptionsTableHtml(mainSubs, validSet, { listKey: 'active', whenHeader: '續費日', emptyText: '尚無使用中的訂閱' })}
      ${chargeTimelineHtml(subs)}
    </div>
    </section>

    <section class="subscriptions-section subscriptions-lifecycle">
      <div class="subscriptions-section-head"><div><span>異動管理</span><h2>停用中的服務</h2></div><p>分開查看即將停用與已停止扣款的項目</p></div>
    ${subscriptionsTableHtml(endingSubs, validSet, { listKey: 'ending', serviceHeader: '即將停用', whenHeader: '停用日', emptyText: '尚無即將停用的服務', extraClass: 'ending-list' })}
    ${subscriptionsTableHtml(endedSubs, validSet, { listKey: 'ended', serviceHeader: '已停用', whenHeader: '停用日', emptyText: '尚無已停用的服務', extraClass: 'ended-list' })}
    </section>

    <section class="subscriptions-section subscriptions-analysis">
    <div class="subscriptions-section-head"><div><span>支出結構</span><h2>訂閱分析</h2></div><p>同時比較類別占比、金額與扣款卡片</p></div>
    <div class="two-col">
      <div class="chart-card"><h3>依類別佔比（本月）</h3>
        <div class="cat-donut-layout">
          <div class="chart-box cat-chart-box"><canvas id="catChart"></canvas></div>
          <div class="cat-legend">
            ${CATEGORIES.map(cat => `<div><span style="background:${CAT_COLOR[cat]}"></span><b>${cat}</b></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="chart-card"><h3>依類別金額（本月）</h3><div class="chart-box cat-bar-chart-box"><canvas id="catBarChart"></canvas></div></div>
    </div>
    <div class="chart-card card-total-card"><h3>本月各信用卡訂閱總額</h3><div id="cardTotalsTable"></div></div>
    </section>

    <div id="historySection"></div>
    </div>
  `;

  byId('addSub').onclick = () => openSubForm(null, creditCards);
  byId('printSubs').onclick = () => printSubscriptionReport(subs, curMk, nextMk);
  view().querySelectorAll('[data-cost-detail]').forEach(b => b.onclick = () => openCostDetailModal(subs, b.dataset.costDetail));
  view().querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    const listKey = th.closest('.tbl-wrap')?.dataset.listKey || 'active';
    const s = getListSort(listKey);
    if (!k) return;
    if (s.key === k) setListSort(listKey, k, s.dir === 'asc' ? 'desc' : 'asc');
    else setListSort(listKey, k, 'asc');
    renderSubscriptions({ showLoading: false });
  });
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openSubForm(subs.find(s => s.id === b.dataset.edit), creditCards));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const s = subs.find(x => x.id === b.dataset.del);
    deleteSubscription(s);
  });
  view().querySelectorAll('[data-record]').forEach(b => b.onclick = () => recordToAccounting(subs.find(s => s.id === b.dataset.record)));
  view().querySelectorAll('[data-flag]').forEach(b => b.onclick = () => toggleCancel(subs.find(s => s.id === b.dataset.flag)));
  wireDragAndDrop();
  syncSubscriptionColumnWidths();

  drawBreakdown(activeThis, curMk);
  renderHistorySection(byId('historySection'));
}

async function deleteSubscription(s) {
  if (!window.confirm(`確定要刪除「${s.name}」嗎？此動作無法復原。`)) return;
  const seq = currentRouteSeq();
  try {
    await api('/subscriptions/' + s.id, { method: 'DELETE' });
    rerenderSubscriptionsAfterAction(seq, '訂閱已刪除');
  } catch (e) { toast(e.message, true); }
}

function syncSubscriptionColumnWidths() {
  requestAnimationFrame(() => {
    const tables = [...view().querySelectorAll('.subs-table')];
    const base = tables[0];
    if (!base) return;
    tables.forEach(table => table.querySelectorAll('col').forEach(col => { col.style.width = ''; }));
    const widths = [...base.querySelectorAll('thead th')].map(th => Math.ceil(th.getBoundingClientRect().width));
    tables.forEach(table => {
      table.querySelectorAll('col').forEach((col, i) => {
        if (widths[i]) col.style.width = `${widths[i]}px`;
      });
    });
  });
}

function subscriptionsTableHtml(rows, validSet, opts = {}) {
  const listKey = opts.listKey || 'active';
  const serviceHeader = opts.serviceHeader || '訂閱服務';
  const whenHeader = opts.whenHeader || '續費日';
  const emptyText = opts.emptyText || '尚無訂閱';
  const extraClass = opts.extraClass ? ` ${opts.extraClass}` : '';
  return `<div class="tbl-wrap${extraClass}" data-list-key="${listKey}">
    <table class="subs-table">
    <colgroup><col><col><col><col><col><col><col><col><col></colgroup>
    <thead><tr>
      <th class="grip-col"></th>
      <th class="sortable" data-sort="category">${serviceHeader} ${triHtml(listKey, 'category')}</th>
      <th class="sortable" data-sort="feeMonth">費用（月）${triHtml(listKey, 'feeMonth')}</th>
      <th class="sortable" data-sort="feeYear">費用（年）${triHtml(listKey, 'feeYear')}</th>
      <th>週期</th>
      <th class="sortable" data-sort="when">${whenHeader} ${triHtml(listKey, 'when')}</th>
      <th class="sortable" data-sort="card">信用卡 ${triHtml(listKey, 'card')}</th>
      <th class="sortable" data-sort="email">信箱 ${triHtml(listKey, 'email')}</th><th></th>
    </tr></thead>
    <tbody>${rows.map(s => subRow(s, validSet)).join('') || `<tr><td colspan="9" class="empty">${emptyText}</td></tr>`}</tbody></table>
  </div>`;
}

// 拖曳排序：放開後依新順序寫回每筆的 order，並切換成手動排序
let draggedId = null;
async function applyOrder(ids, listKey) {
  const seq = currentRouteSeq();
  await Promise.all(ids.map((id, i) => api('/subscriptions/' + id, { method: 'PUT', body: { order: i } })));
  setListSort(listKey, 'manual', 'asc');
  if (seq !== currentRouteSeq()) return;
  renderSubscriptions({ showLoading: false });
}
function onDrop(dragId, targetRow, placeAfter = false) {
  const targetId = targetRow?.dataset.id;
  if (!dragId || dragId === targetId) return;
  const ids = [...targetRow.closest('tbody').querySelectorAll('tr')].map(tr => tr.dataset.id).filter(Boolean);
  const from = ids.indexOf(dragId);
  if (from < 0) return;
  ids.splice(from, 1);
  const to = ids.indexOf(targetId);
  ids.splice(to < 0 ? ids.length : to + (placeAfter ? 1 : 0), 0, dragId);
  applyOrder(ids, targetRow.closest('.tbl-wrap')?.dataset.listKey || 'active');
}
function wireDragAndDrop() {
  view().querySelectorAll('.subs-table .drag-handle').forEach(h => {
    h.addEventListener('mousedown', () => h.closest('tr').setAttribute('draggable', 'true'));
    h.addEventListener('mouseup', () => h.closest('tr').removeAttribute('draggable'));
  });
  view().querySelectorAll('.subs-table tbody tr').forEach(tr => {
    tr.addEventListener('dragstart', () => { draggedId = tr.dataset.id; tr.classList.add('dragging'); });
    tr.addEventListener('dragend', () => {
      tr.removeAttribute('draggable'); tr.classList.remove('dragging');
      view().querySelectorAll('.drag-before,.drag-after').forEach(x => x.classList.remove('drag-before', 'drag-after'));
    });
    tr.addEventListener('dragover', (e) => {
      e.preventDefault();
      const r = tr.getBoundingClientRect();
      tr.classList.toggle('drag-after', e.clientY > r.top + r.height / 2);
      tr.classList.toggle('drag-before', e.clientY <= r.top + r.height / 2);
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drag-before', 'drag-after'));
    tr.addEventListener('drop', (e) => {
      e.preventDefault();
      const r = tr.getBoundingClientRect();
      onDrop(draggedId, tr, e.clientY > r.top + r.height / 2);
    });
  });
}

function openCostDetailModal(subs, mk) {
  const rows = costDetailRows(subs, mk);
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const tbody = rows.length ? rows.map(r => `<tr>
    <td>${esc(r.service)}</td>
    <td>${esc(r.cycle)}</td>
    <td class="muted">${esc(r.formula)}</td>
    <td class="num">${fmtFee(r.amount)}</td>
  </tr>`).join('') : `<tr><td colspan="4" class="muted" style="text-align:center;padding:26px">這個月份沒有計入訂閱費用</td></tr>`;

  openInfo(`${mk} 計算方式`, `
    <div class="cost-detail-total"><span>合計</span><b>${fmtFee(total)}</b></div>
    <div class="cost-detail-table-wrap"><table class="cost-detail-table">
      <thead><tr><th>服務</th><th>週期</th><th>計算方式</th><th class="num">計入金額</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table></div>`, { size: 'lg' });
}

// ---- 未來 30 天續費時間線：頁面卡片與列印報表共用的佈局演算法 ----
// 同日先合成一個節點；否則再多的垂直層級也無法分開完全相同的 x 座標。
export function timelinePoints(subs, { pos, topLevels, bottomLevels, labelH, groupLabelH = labelH }) {
  const upcoming = subs.filter(s => subStatus(s) === 'active' && !isLifetimeSub(s))
    .map(s => ({ name: s.name, amount: Number(s.amount || 0), days: daysUntil(s.nextCharge), date: s.nextCharge, cat: s.category }))
    .filter(c => isFinite(c.days) && c.days >= 0 && c.days <= 30)
    .sort((a, b) => a.days - b.days || String(a.date).localeCompare(String(b.date)));
  const events = [];
  for (const charge of upcoming) {
    const previous = events.at(-1);
    if (previous?.date === charge.date) {
      previous.items.push(charge);
      previous.amount += charge.amount;
      previous.name = `${previous.items.length} 筆續費`;
    } else {
      events.push({ ...charge, items: [charge] });
    }
  }
  const groupedDays = events.filter(event => event.items.length > 1).map(event => event.days);
  const axisY = 98, dotY = axisY - 6;
  /** @type {{top:{left:number, grouped:boolean}[], bottom:{left:number, grouped:boolean}[]}} */
  const lastBySide = { top: [], bottom: [] };
  const points = events.map((c, i) => {
    const left = pos(c.days);
    const grouped = c.items.length > 1;
    const topHasNearbyGroup = grouped && lastBySide.top.some(last => last.grouped && left - last.left < 28);
    const nearGroupedDay = !grouped && groupedDays.some(days => Math.abs(days - c.days) <= 8);
    const side = grouped ? (topHasNearbyGroup ? 'bottom' : 'top') : (nearGroupedDay ? 'bottom' : (i % 2 === 0 ? 'top' : 'bottom'));
    const levels = side === 'top' ? topLevels : bottomLevels;
    let level = 0;
    while (lastBySide[side][level] != null
      && left - lastBySide[side][level].left < (grouped || lastBySide[side][level].grouped ? 24 : 14)
      && level < levels.length - 1) level++;
    lastBySide[side][level] = { left, grouped };
    const labelTop = levels[level];
    const labelBottom = labelTop + (grouped ? groupLabelH : labelH);
    return { ...c, grouped, left, side, labelTop, dotY,
      lineTop: side === 'top' ? labelBottom : axisY,
      lineHeight: side === 'top' ? Math.max(0, dotY - labelBottom) : Math.max(0, labelTop - axisY) };
  });
  return { upcoming, points };
}

// 續費時間線卡片（頁面版）
function chargeTimelineHtml(subs) {
  const PAD = 7;
  const pos = (d) => PAD + (Math.max(0, Math.min(30, d)) / 30) * (100 - PAD * 2);
  const { upcoming, points } = timelinePoints(subs, {
    pos, topLevels: [10, 42], bottomLevels: [122, 154, 186], labelH: 42, groupLabelH: 72
  });
  const total = upcoming.reduce((t, c) => t + c.amount, 0);
  const ticks = [0, 10, 20, 30].map(d => `<div class="tl-tick" style="left:${pos(d).toFixed(2)}%">${d === 0 ? '今天' : '+' + d + '天'}</div>`).join('');

  if (!upcoming.length) {
    return `<div class="chart-card timeline-card"><h3>續費時間線</h3>
      <p class="muted" style="font-size:12.5px;margin-top:6px">未來 30 天內沒有預定續費 🎉</p></div>`;
  }

  const pointsHtml = points.map(p => {
    const visibleItems = p.items.slice(0, 3);
    const hiddenCount = p.items.length - visibleItems.length;
    const label = p.grouped ? `<div class="tl-label tl-group-card ${p.left >= 80 ? 'edge-right' : p.left <= 20 ? 'edge-left' : ''}">
        <div class="tl-group-head"><strong>${p.days === 0 ? '今天' : p.days + ' 天後'} · ${p.items.length} 筆</strong><b>${fmtFee(p.amount)}</b></div>
        <div class="tl-group-list">${visibleItems.map(item => `<div class="tl-group-row"><span>${esc(item.name)}</span><b>${fmtFee(item.amount)}</b></div>`).join('')}${hiddenCount ? `<div class="tl-group-more">另 ${hiddenCount} 筆</div>` : ''}</div>
      </div>` : `<div class="tl-label">
        <div class="tl-name">${esc(p.name)}</div>
        <div class="tl-amt">（${fmtFee(p.amount)}）</div>
        <div class="tl-day">${p.days === 0 ? '今天' : p.days + ' 天後'}</div>
      </div>`;
    return `<div class="tl-point ${p.side} ${p.grouped ? 'grouped' : ''}" style="left:${p.left.toFixed(2)}%;--label-top:${p.labelTop}px;--line-top:${p.lineTop}px;--line-height:${p.lineHeight}px;--dot-top:${p.dotY}px">
      ${label}
      <div class="tl-stem"></div>
      <div class="tl-dot ${p.grouped ? 'grouped' : ''}" ${p.grouped ? '' : `style="background:${(Object.hasOwn(CAT_COLOR, p.cat) && CAT_COLOR[p.cat]) || CHART.gray}"`}>${p.grouped ? `<span class="tl-dot-count">${p.items.length}</span>` : ''}</div>
    </div>`;
  }).join('');
  

  return `<div class="chart-card timeline-card">
    <h3>續費時間線 <span class="stat-sub" style="font-weight:400;margin:0">（合計 <b>${money(total)}</b>）</span></h3>
    <div class="timeline">
      <div class="tl-axis"></div>
      ${pointsHtml}
      ${ticks}
    </div>
  </div>`;
}

function subRow(s, validSet) {
  const st = subStatus(s);
  const off = st === 'ended';
  const cat = s.category || '未分類';
  const email = normEmail(s.email);
  const staleCard = s.card && validSet && !validSet.has(s.card);

  // 續費 / 停用 欄：主表格只顯示日期，剩餘天數留給時間線與提醒區。
  const whenDateVal = isLifetimeSub(s) ? '終身訂閱' : ((st === 'active') ? (s.nextCharge || '') : (s.endsOn || ''));
  const dateColor = st === 'ending' ? 'color:var(--accent-ink)' : (st === 'ended' || isLifetimeSub(s)) ? 'color:var(--text-dim)' : '';
  const dateSuffix = isLifetimeSub(s) ? '' : st === 'active' ? '續' : (st === 'ending' || st === 'ended') ? '止' : '';
  const dateStr = `<span style="${dateColor}">${esc(whenDateVal || '—')}${whenDateVal && dateSuffix ? ` <span class="date-suffix ${st}">${dateSuffix}</span>` : ''}</span>`;
  const whenCell = `<div class="when-date">${dateStr}</div>`;

  return `<tr data-id="${esc(s.id)}" style="${off ? 'opacity:.5' : ''}">
    <td class="grip-col"><span class="drag-handle" style="color:${((Object.hasOwn(CAT_COLOR, cat) && CAT_COLOR[cat]) || CHART.gray)}" title="拖曳調整順序">${icon('grip', 15, true)}</span></td>
    <td class="nowrap">${serviceNameHtml(s)}<span class="cancel-dot${s.considerCancel ? ' on' : ''}"></span></td>
    <td class="num">${fmtFee(feeMonthVal(s))}</td>
    <td class="num">${fmtFee(feeYearVal(s))}</td>
    <td class="nowrap">${CYCLE_LABELS[s.cycle] || '月繳'}</td>
    <td class="nowrap">${whenCell}</td>
    <td class="muted nowrap">${esc(cardLabel(s.card))}${staleCard ? ' <span class="tag amber">卡片已失效</span>' : ''}</td>
    <td class="muted nowrap">${esc(email || '—')}</td>
    <td><div class="row-actions">
      <button class="btn-link btn-sm" data-record="${esc(s.id)}" title="記一筆到銀行收支">${icon('record', 15)}</button>
      <button class="btn-link btn-sm flag-action${s.considerCancel ? ' flag-on' : ''}" data-flag="${esc(s.id)}" title="${s.considerCancel ? '已標記考慮停用' : '標記考慮停用'}">${icon(s.considerCancel ? 'box-x' : 'box', 15)}</button>
      <button class="btn-link btn-sm" data-edit="${esc(s.id)}" title="編輯">${icon('edit', 15)}</button>
      <button class="btn-danger btn-sm" data-del="${esc(s.id)}" title="刪除">${icon('trash', 15)}</button>
    </div></td>
  </tr>`;
}

// 訂閱自身類別 → 銀行收支的兩層分類（新分類已無「訂閱」分類）
const SUB_CAT_TO_EXPENSE = {
  '娛樂': ['娛樂', 'Netflix及影音串流'],
  '學習': ['學習', '學習型訂閱服務'],
  '工具': ['工作', '其他工作成本'],
  '生活': ['生活', '其他生活雜支'],
  '健康': ['健康', '運動課程']
};
async function recordToAccounting(s) {
  const amt = Number(s.amount || 0);
  const cycleLbl = CYCLE_FEE_LABELS[s.cycle] || '月費';
  if (!confirm(`要把這筆記入「銀行收支」嗎？\n\n${s.name}（${cycleLbl}） ${fmtFee(amt)}\n續費卡：${cardLabel(s.card)}\n日期：${todayStr()}`)) return;
  const [cat, subcat] = (Object.hasOwn(SUB_CAT_TO_EXPENSE, s.category) && SUB_CAT_TO_EXPENSE[s.category]) || ['生活', '其他生活雜支'];   // hasOwn（Codex r7#4）：舊資料分類叫 toString 會解構到原型函式而 TypeError
  try {
    await api('/transactions', { method: 'POST', body: {
      date: todayStr(), type: 'expense', category: cat, subcategory: subcat, amount: amt,
      account: s.card || '', note: `${s.name}（訂閱${cycleLbl}）`
    }});
    toast(`已記入銀行收支：${fmtFee(amt)} ✅`);
  } catch (e) { toast(e.message, true); }
}

async function toggleCancel(s) {
  const seq = currentRouteSeq();
  try {
    await api('/subscriptions/' + s.id, { method: 'PUT', body: { considerCancel: !s.considerCancel } });
    const message = s.considerCancel ? '已取消「考慮停用」標記' : '已標記為考慮停用';
    rerenderSubscriptionsAfterAction(seq, message);
  } catch (e) { toast(e.message, true); }
}

function drawBreakdown(activeThis, curMk) {
  // 依類別彙總（每月攤提）。Object.create(null)：同 subscriptions-report.js 的 reportBreakdown（Codex r5#5）
  const byCat = Object.create(null);
  activeThis.forEach(s => { const c = s.category || '未分類'; byCat[c] = (byCat[c] || 0) + costForMonth(s, curMk); });
  const catLabels = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  const catTotal = catLabels.reduce((t, l) => t + Number(byCat[l] || 0), 0);

  // 依類別佔比（甜甜圈）
  const catCtx = byId('catChart');
  const catValues = catLabels.map(l => Math.round(byCat[l]));
  const percentLabels = {
    id: 'percentLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const data = chart.data.datasets[0].data;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = '700 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      meta.data.forEach((arc, i) => {
        const value = Number(data[i] || 0);
        if (!value) return;
        const pct = catTotal ? Math.round(value / catTotal * 100) : 0;
        const text = `${pct}%`;
        const midRadius = (arc.innerRadius + arc.outerRadius) / 2;
        const arcLength = Math.abs(arc.endAngle - arc.startAngle) * midRadius;
        const textWidth = ctx.measureText(text).width + 10;
        const fitsInside = arcLength >= textWidth && arc.outerRadius - arc.innerRadius >= 14;
        if (fitsInside) {
          const pos = arc.tooltipPosition();
          ctx.fillStyle = '#fff';
          ctx.shadowColor = 'rgba(0,0,0,.22)';
          ctx.shadowBlur = 3;
          ctx.fillText(text, pos.x, pos.y);
          return;
        }
        const angle = (arc.startAngle + arc.endAngle) / 2;
        const radius = arc.outerRadius + 13;
        const x = arc.x + Math.cos(angle) * radius;
        const y = arc.y + Math.sin(angle) * radius;
        ctx.fillStyle = '#5d574f';
        ctx.shadowBlur = 0;
        ctx.fillText(text, Math.max(12, Math.min(chart.width - 12, x)), Math.max(12, Math.min(chart.height - 12, y)));
      });
      ctx.restore();
    }
  };
  if (catLabels.length) charts.push(new Chart(catCtx, {
    type: 'doughnut',
    data: { labels: catLabels, datasets: [{ data: catValues, backgroundColor: catLabels.map(l => ((Object.hasOwn(CAT_COLOR, l) && CAT_COLOR[l]) || CHART.gray)), borderColor: '#fff', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true, callbacks: {
          title: (items) => items[0]?.label || '',
          label: (c) => fmtFee(c.parsed)
        }, displayColors: false }
      } },
    plugins: [percentLabels]
  })); else catCtx.parentElement.innerHTML = '<p class="empty">本月尚無使用中訂閱。</p>';

  // 依類別金額（水平長條）：同樣依金額由高到低，補足圓環不易比較金額差距的弱點。
  const catBarCtx = byId('catBarChart');
  const barValueLabels = {
    id: 'barValueLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const data = chart.data.datasets[0].data;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = '700 11px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textBaseline = 'middle';
      meta.data.forEach((bar, i) => {
        const value = Number(data[i] || 0);
        if (!value) return;
        const text = fmtFee(value);
        const props = bar.getProps(['x', 'y', 'base'], true);
        const barWidth = Math.abs(props.x - props.base);
        const textWidth = ctx.measureText(text).width + 18;
        if (barWidth >= textWidth) {
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'right';
          ctx.shadowColor = 'rgba(0,0,0,.22)';
          ctx.shadowBlur = 3;
          ctx.fillText(text, props.x - 9, props.y);
          return;
        }
        ctx.fillStyle = '#5d574f';
        ctx.textAlign = 'left';
        ctx.shadowBlur = 0;
        const x = Math.min(props.x + 8, chart.chartArea.right - ctx.measureText(text).width);
        ctx.fillText(text, Math.max(chart.chartArea.left, x), props.y);
      });
      ctx.restore();
    }
  };
  if (catLabels.length && catBarCtx) charts.push(new Chart(catBarCtx, {
    type: 'bar',
    data: { labels: catLabels, datasets: [{ data: catValues, backgroundColor: catLabels.map(l => ((Object.hasOwn(CAT_COLOR, l) && CAT_COLOR[l]) || CHART.gray)), borderRadius: 6, maxBarThickness: 24 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: (items) => items[0]?.label || '',
        label: (c) => fmtFee(c.parsed.x)
      }, displayColors: false } },
      scales: {
        x: { ticks: { color: AXIS, callback: v => Math.round(v).toLocaleString('en-US') }, grid: { color: GRID }, beginAtZero: true },
        y: { ticks: { color: AXIS }, grid: { display: false } }
      } },
    plugins: [barValueLabels]
  }));

  // 各信用卡總額。Object.create(null)：卡片名是使用者文字（Codex r6#3——r5#5 那輪漏了這一份）
  const byCard = Object.create(null);
  activeThis.forEach(s => { const c = cardLabel(s.card || '未指定'); byCard[c] = (byCard[c] || 0) + costForMonth(s, curMk); });
  const cardRows = Object.entries(byCard).sort((a, b) => b[1] - a[1]);
  const cardTable = byId('cardTotalsTable');
  if (!cardTable) return;
  cardTable.innerHTML = cardRows.length ? `<table class="summary-table">
    <thead><tr><th>信用卡</th><th class="num">扣款金額</th></tr></thead>
    <tbody>${cardRows.map(([card, amount]) => `<tr><td>${esc(card)}</td><td class="num">${fmtFee(amount)}</td></tr>`).join('')}</tbody>
  </table>` : '<p class="empty">本月尚無信用卡訂閱扣款。</p>';
}

function openSubForm(sub, creditCards = []) {
  const seq = currentRouteSeq();
  const cardOptions = creditCards.map(n => ({ value: n, label: cardLabel(n) }));
  if (sub && sub.card && !creditCards.includes(sub.card)) cardOptions.unshift({ value: sub.card, label: cardLabel(sub.card) + '（已失效，請更新）' });
  if (!cardOptions.length) cardOptions.push({ value: '', label: '（請先到「卡片追蹤」新增信用卡）' });
  const initStatus = sub ? subStatus(sub) : 'active';
  const dateLabel = (st, cycle) => cycle === 'lifetime' ? '終身（不需續費日）' : st === 'active' ? '下次續費日' : '停用日（這天起不再續費）';
  const whenVal = sub ? (isLifetimeSub(sub) ? '' : (subStatus(sub) === 'active' ? sub.nextCharge : sub.endsOn)) : '';
  openForm({
    title: sub ? '編輯訂閱' : '新增訂閱',
    fields: [
      { key: 'name', label: '服務名稱', type: 'text', required: true, placeholder: '例：Netflix' },
      { key: 'category', label: '類別', type: 'select', options: CATEGORIES, default: '娛樂' },
      { key: 'card', label: '續費信用卡', type: 'select', options: cardOptions },
      { key: 'amount', label: '費用', type: 'number', required: true },
      { key: 'cycle', label: '週期', type: 'select', options: [{ value: 'monthly', label: '月繳' }, { value: 'quarterly', label: '季繳' }, { value: 'semiannual', label: '半年' }, { value: 'yearly', label: '年繳' }, { value: 'lifetime', label: '終身' }] },
      { key: 'status', label: '狀態', type: 'select', options: [{ value: 'active', label: '使用中' }, { value: 'ending', label: '即將停用' }, { value: 'ended', label: '已停用' }], default: 'active' },
      { key: 'whenDate', label: dateLabel(initStatus, sub?.cycle), type: 'date' },
      { key: 'expiryDate', label: '訂閱停用日', type: 'date', full: true },
      { key: 'email', label: '使用的信箱', type: 'select', options: EMAIL_OPTIONS, default: 'Gmail' }
    ],
    values: sub ? { ...sub, status: initStatus, email: normEmail(sub.email), whenDate: whenVal } : { status: 'active' },
    onMount: (/** @type {any} */ root) => {
      // 狀態切換時，把日期欄的標籤在「下次續費日 / 停用日」之間切換
      const statusSel = root.querySelector('#f_status');
      const cycleSel = root.querySelector('#f_cycle');
      const dateInput = root.querySelector('#f_whenDate');
      const dateLbl = dateInput.closest('div').querySelector('label');

      // 訂閱停用日：旁邊加「同下次續費日」小選框＋說明
      const expInput = root.querySelector('#f_expiryDate');
      const expLbl = expInput.closest('div').querySelector('label');
      expLbl.insertAdjacentHTML('beforeend', `<label class="inline-check"><input type="checkbox" id="sameExpiry"> 同下次續費日</label><div class="field-hint">不顯示於列表；停用前一個月會自動轉「即將停用」</div>`);
      const cb = root.querySelector('#sameExpiry');
      const syncLifetimeFields = () => {
        const isLifetime = cycleSel.value === 'lifetime';
        dateLbl.textContent = dateLabel(statusSel.value, cycleSel.value);
        if (isLifetime) statusSel.value = 'active';
        dateInput.readOnly = isLifetime;
        expInput.readOnly = isLifetime || cb.checked;
        cb.disabled = isLifetime;
        if (isLifetime) {
          dateInput.value = '';
          expInput.value = '';
          cb.checked = false;
        }
      };
      const sync = () => { if (cb.checked) expInput.value = dateInput.value; };
      statusSel.addEventListener('change', syncLifetimeFields);
      cycleSel.addEventListener('change', syncLifetimeFields);
      cb.addEventListener('change', () => { expInput.readOnly = cb.checked; sync(); });
      dateInput.addEventListener('change', sync);
      if (expInput.value && expInput.value === dateInput.value) { cb.checked = true; expInput.readOnly = true; }
      syncLifetimeFields();
    },
    onSubmit: async (data) => {
      const date = data.whenDate || '';
      delete data.whenDate;
      if (data.cycle === 'lifetime') { data.status = 'active'; data.nextCharge = ''; data.endsOn = ''; data.expiryDate = ''; }
      else if (data.status === 'active') { data.nextCharge = date; data.endsOn = ''; }
      else { data.endsOn = date; data.nextCharge = date; }   // 停用日 = 不再續費的那天
      data.active = data.status !== 'ended';
      if (!data.since) data.since = (sub && sub.since) || monthKey();   // 新訂閱從「當月」起算，避免回填先前月份歷史
      if (sub) await api('/subscriptions/' + sub.id, { method: 'PUT', body: data });
      else await api('/subscriptions', { method: 'POST', body: data });
      const message = sub ? '訂閱資料已更新' : '訂閱已新增';
      rerenderSubscriptionsAfterAction(seq, message);
    }
  });
}
