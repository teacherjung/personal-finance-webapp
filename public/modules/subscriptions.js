// @ts-check
import { api, view, byId, esc, money, daysUntil, monthKey, todayStr, openForm, openInfo, openPrintWindow, confirmDelete, toast } from '../app.js';
import { CHART, AXIS, GRID } from './theme.js';
import { icon } from './icons.js';
import { renderHistorySection } from './history.js';

const CATEGORIES = ['工具', '學習', '生活', '娛樂', '健康'];
const CAT_COLOR = { '工具': CHART.blue, '健康': CHART.red, '學習': CHART.green, '娛樂': CHART.orange, '生活': CHART.yellow, '未分類': CHART.gray };
const EMAIL_OPTIONS = ['Yahoo', 'Gmail', 'iCloud', 'EIEI'];
const RECORD_START = '2026-06';   // 從這個月開始記錄訂閱費

const fmtFee = (n) => money(n);   // 明細/表格/報表金額：整數 +「元」（app.js 統一格式器；延遲取值避免循環 import TDZ）
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12, lifetime: 1 };
const CYCLE_LABELS = { monthly: '月繳', quarterly: '季繳', semiannual: '半年', yearly: '年繳', lifetime: '終身' };
const CYCLE_FEE_LABELS = { monthly: '月費', quarterly: '季費', semiannual: '半年費', yearly: '年費', lifetime: '終身' };
const STATUS_LABELS = { active: '使用中', ending: '即將停用', ended: '已停用' };
// 月費 / 年費 換算（四捨五入到整數）
const cycleMonths = (s) => CYCLE_MONTHS[s.cycle] || 1;
const isLifetimeSub = (s) => s.cycle === 'lifetime';
const feeMonthVal = (s) => isLifetimeSub(s) ? 0 : Math.round(Number(s.amount || 0) / cycleMonths(s));
const feeYearVal = (s) => isLifetimeSub(s) ? 0 : Math.round(Number(s.amount || 0) * 12 / cycleMonths(s));
const categoryRank = (s) => {
  const i = CATEGORIES.indexOf(s.category || '未分類');
  return i >= 0 ? i : CATEGORIES.length;
};

function serviceNameHtml(s) {
  return `<b class="service-name">${esc(s.name)}</b>`;
}
function cardLabel(name) {
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

const monthlyCost = (s) => isLifetimeSub(s) ? 0 : Number(s.amount || 0) / cycleMonths(s);

// ---- 月份工具（monthKey 由 app.js 提供）----
function addMonths(mk, n) { let [y, m] = mk.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; }

// ---- 狀態：使用中 / 即將停用 / 已停用 ----
function subStatus(s) {
  if (s.status === 'ended' || s.active === false) return 'ended';
  if (s.status === 'ending' || s.endsOn) return daysUntil(s.endsOn) > 0 ? 'ending' : 'ended';
  return 'active';
}

function dayOfMonth(dateStr) {
  const n = Number(String(dateStr || '').slice(8, 10));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 某訂閱在指定月份應計入的金額（月繳用月費；季/年繳攤提到每月，停用當月按天數比例）
function costForMonth(s, mk) {
  if (isLifetimeSub(s)) return 0;
  const since = s.since || RECORD_START;
  if (mk < since) return 0;
  const base = monthlyCost(s);
  const endsOn = s.endsOn || '';
  if (!endsOn) return s.active === false || s.status === 'ended' ? 0 : base;
  const endMk = endsOn.slice(0, 7);
  if (endMk < mk) return 0;
  if (s.cycle === 'monthly') return endMk === mk ? 0 : base;
  if (endMk === mk) return base * Math.min(dayOfMonth(endsOn), 30) / 30;
  return base;
}

// 某訂閱在指定月份是否仍需付費
function activeInMonth(s, mk) {
  return costForMonth(s, mk) > 0;
}

// 某月份的訂閱攤提總額。依「當下所有訂閱狀態」即時計算
function amortizedForMonth(subs, mk) {
  return subs.reduce((t, s) => t + costForMonth(s, mk), 0);
}

// 月份結束後，把「已完成月份」的實際攤提凍結到歷史紀錄（只補尚未紀錄的）
async function freezeCompletedMonths(subs) {
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
}

function normalizeSortKey(k) {
  if (k === 'fee') return 'feeMonth';
  if (k === 'name') return 'category';
  if (k === 'status') return 'when';
  return k || 'when';
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
  const out = rows.slice().sort(SORTERS[s.key] || SORTERS.when);
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

export async function renderSubscriptions() {
  const [raw, cards] = await Promise.all([api('/subscriptions'), api('/cards')]);
  if (await autoExpire(raw)) return renderSubscriptions();   // 停用日背景作業有更新→重新載入
  const creditCards = cards.filter(c => (c.type || 'credit') === 'credit').map(c => c.name);
  const validSet = new Set(creditCards);
  freezeCompletedMonths(raw).catch(() => {});   // 月份結束後自動凍結到歷史紀錄
  const subs = raw.slice();
  const mainSubs = sortTableRows(subs.filter(s => subStatus(s) === 'active'), 'active');
  const endingSubs = sortTableRows(subs.filter(s => subStatus(s) === 'ending'), 'ending');
  const endedSubs = sortTableRows(subs.filter(s => subStatus(s) === 'ended'), 'ended');
  const staleSubs = subs.filter(s => s.card && !validSet.has(s.card));
  destroyCharts();

  const curMk = monthKey();
  const nextMk = addMonths(curMk, 1);
  const sumMonth = (mk) => amortizedForMonth(subs, mk);
  const thisMonth = sumMonth(curMk);
  const nextMonth = sumMonth(nextMk);
  const delta = nextMonth - thisMonth;
  const activeThis = subs.filter(s => activeInMonth(s, curMk));
  const endingCount = subs.filter(s => subStatus(s) === 'ending').length;

  view().innerHTML = `
    <div class="page-head">
      <div><h1>訂閱追蹤</h1><p>訂閱不可怕，可怕的是忘了自己有訂閱。</p></div>
      <div class="page-actions">
        <button class="btn-ghost icon-btn" id="printSubs" title="列印 / 匯出 PDF" aria-label="列印 / 匯出 PDF">${icon('print', 16)}</button>
        <button class="btn" id="addSub">${icon('plus', 16)}新增訂閱</button>
      </div>
    </div>

    ${staleSubs.length ? `<div class="reminders" style="margin-bottom:18px"><div class="reminder danger">
      <span class="r-tag">卡片</span>
      <div><div class="r-title">續費卡已失效</div><div class="r-detail">有 <b>${staleSubs.length}</b> 筆訂閱的續費卡已不在「卡片追蹤」中（${esc([...new Set(staleSubs.map(s => cardLabel(s.card)))].join('、'))}），可能該卡已換發或停用。請編輯這些訂閱、改用有效的卡片。</div></div>
    </div></div>` : ''}

    <div class="cards">
      <div class="card cost-summary-card"><h3>本月費用（${curMk}）</h3><div class="stat sm">${fmtFee(thisMonth)}</div><button class="btn-ghost btn-sm cost-method-btn" data-cost-detail="${curMk}">計算方式</button></div>
      <div class="card cost-summary-card"><h3>下月費用（${nextMk}）</h3><div class="stat sm">${fmtFee(nextMonth)}</div><div class="stat-sub ${delta < 0 ? 'pos' : delta > 0 ? 'neg' : ''}">較本月 ${delta === 0 ? '持平' : (delta > 0 ? '+' : '−') + fmtFee(Math.abs(delta))}</div><button class="btn-ghost btn-sm cost-method-btn" data-cost-detail="${nextMk}">計算方式</button></div>
      <div class="card"><h3>每年總額</h3><div class="stat sm">${fmtFee(thisMonth * 12)}</div></div>
      <div class="card"><h3>即將停用</h3><div class="stat sm">${endingCount} 項</div></div>
    </div>

    <div class="active-subscription-group">
      ${subscriptionsTableHtml(mainSubs, validSet, { listKey: 'active', whenHeader: '續費日', emptyText: '尚無使用中的訂閱' })}
      ${chargeTimelineHtml(subs)}
    </div>
    ${subscriptionsTableHtml(endingSubs, validSet, { listKey: 'ending', serviceHeader: '即將停用', whenHeader: '停用日', emptyText: '尚無即將停用的服務', extraClass: 'ending-list' })}
    ${subscriptionsTableHtml(endedSubs, validSet, { listKey: 'ended', serviceHeader: '已停用', whenHeader: '停用日', emptyText: '尚無已停用的服務', extraClass: 'ended-list' })}

    <div class="section-title">訂閱分析</div>
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

    <div id="historySection"></div>
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
    renderSubscriptions();
  });
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openSubForm(subs.find(s => s.id === b.dataset.edit), creditCards));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const s = subs.find(x => x.id === b.dataset.del);
    confirmDelete(s.name, () => api('/subscriptions/' + s.id, { method: 'DELETE' }));
  });
  view().querySelectorAll('[data-record]').forEach(b => b.onclick = () => recordToAccounting(subs.find(s => s.id === b.dataset.record)));
  view().querySelectorAll('[data-flag]').forEach(b => b.onclick = () => toggleCancel(subs.find(s => s.id === b.dataset.flag)));
  wireDragAndDrop();
  syncSubscriptionColumnWidths();

  drawBreakdown(activeThis, curMk);
  renderHistorySection(byId('historySection'));
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
  await Promise.all(ids.map((id, i) => api('/subscriptions/' + id, { method: 'PUT', body: { order: i } })));
  setListSort(listKey, 'manual', 'asc');
  renderSubscriptions();
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

function costFormula(s, mk) {
  const endMk = (s.endsOn || '').slice(0, 7);
  const day = dayOfMonth(s.endsOn);
  if (s.cycle === 'monthly') return '月費';
  const base = `${CYCLE_FEE_LABELS[s.cycle] || '月費'} ÷ ${cycleMonths(s)}`;
  if (s.endsOn && endMk === mk) return `${base} × ${Math.min(day, 30)} / 30`;
  return base;
}

function costDetailRows(subs, mk) {
  return subs.map(s => ({
    service: s.name,
    cycle: CYCLE_LABELS[s.cycle] || '月繳',
    formula: costFormula(s, mk),
    amount: costForMonth(s, mk)
  })).filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.service.localeCompare(b.service, 'zh-Hant'));
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

function reportTable(headers, rows, empty = '無資料') {
  const body = rows.length ? rows.map(row => `<tr>${row.map((cell, i) => `<td class="${i === row.length - 1 ? 'num' : ''}">${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted center">${esc(empty)}</td></tr>`;
  return `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}


function sortByMonthlyCost(rows) {
  return rows.slice().sort((a, b) => feeMonthVal(b) - feeMonthVal(a) || (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
}

function sortByStatusThenCost(rows) {
  const rank = { active: 0, ending: 1, ended: 2 };
  return rows.slice().sort((a, b) => (rank[subStatus(a)] ?? 9) - (rank[subStatus(b)] ?? 9)
    || feeMonthVal(b) - feeMonthVal(a)
    || (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
}

function reportCostTable(subs, mk, label) {
  const detail = costDetailRows(subs, mk);
  const rows = detail.map(r => [esc(r.service), esc(r.cycle), esc(r.formula), fmtFee(r.amount)]);
  const total = detail.reduce((sum, r) => sum + r.amount, 0);
  const body = rows.length ? rows.map(row => `<tr>${row.map((cell, i) => `<td class="${i === row.length - 1 ? 'num' : ''}">${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="4" class="muted center">這個月份沒有計入訂閱費用</td></tr>`;
  return `<section><h2>${esc(mk)} （${esc(label)}） <span>${fmtFee(total)}</span></h2>
    <table class="cost-calc-table">
      <colgroup><col class="service-col"><col class="cycle-col"><col class="formula-col"><col class="amount-col"></colgroup>
      <thead><tr><th>服務</th><th>週期</th><th>計算方式</th><th>計入金額</th></tr></thead>
      <tbody>${body}</tbody>
    </table></section>`;
}

function reportStatusTable(headers, rows, empty) {
  const body = rows.length ? rows.map(row => `<tr>${row.map((cell, i) => `<td class="${i >= 2 ? 'center' : ''}">${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted center">${esc(empty)}</td></tr>`;
  return `<table class="status-overview-table">
    <colgroup>
      <col class="status-service-col">
      <col class="status-meta-col">
      <col class="status-cycle-col">
      <col class="status-month-col">
      <col class="status-date-col">
    </colgroup>
    <thead><tr>${headers.map((h, i) => `<th class="${i >= 2 ? 'center' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function reportBreakdown(subs, mk) {
  const active = subs.filter(s => activeInMonth(s, mk));
  // Object.create(null)（Codex r5#5）：分類/卡片名是使用者文字，撞原生屬性名時普通物件會算錯
  const byCat = Object.create(null), byCard = Object.create(null);
  active.forEach(s => {
    const cost = costForMonth(s, mk);
    byCat[s.category || '未分類'] = (byCat[s.category || '未分類'] || 0) + cost;
    byCard[cardLabel(s.card || '未指定')] = (byCard[cardLabel(s.card || '未指定')] || 0) + cost;
  });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const total = catRows.reduce((sum, [, v]) => sum + v, 0);
  const stops = [];
  let acc = 0;
  for (const [cat, val] of catRows) {
    const start = total ? acc / total * 100 : 0;
    acc += val;
    const end = total ? acc / total * 100 : 0;
    stops.push(`${((Object.hasOwn(CAT_COLOR, cat) && CAT_COLOR[cat]) || CHART.gray)} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
  }
  const donut = stops.length ? `<div class="report-donut" style="background:conic-gradient(${stops.join(',')})"></div>` : '<div class="report-donut empty"></div>';
  const catList = catRows.map(([cat, val]) => `<div><i style="background:${((Object.hasOwn(CAT_COLOR, cat) && CAT_COLOR[cat]) || CHART.gray)}"></i><b>${esc(cat)}</b><span>${total ? Math.round(val / total * 100) : 0}%</span><span>${fmtFee(val)}</span></div>`).join('');
  const cardRows = Object.entries(byCard).sort((a, b) => b[1] - a[1]).map(([card, val]) => [esc(card), fmtFee(val)]);
  return `<section><h2>本月統計</h2><div class="report-grid">
    <div class="report-panel"><h3>依類別佔比</h3><div class="report-donut-wrap">${donut}<div class="report-legend">${catList || '<p class="muted">無資料</p>'}</div></div></div>
    <div class="report-panel"><h3>依信用卡合計</h3>${reportTable(['信用卡', '金額'], cardRows, '無資料')}</div>
  </div></section>`;
}

// 續費時間線（列印報表版，佈局與頁面卡片共用 timelinePoints）
function reportTimeline(subs) {
  const { upcoming, points } = timelinePoints(subs, {
    pos: (d) => Math.max(5, Math.min(95, 5 + d / 30 * 90)),
    topLevels: [12, 44], bottomLevels: [122, 154, 186], labelH: 40
  });
  if (!upcoming.length) return `<section><h2>未來 30 天續費時間線</h2><p class="muted">未來 30 天沒有預定續費。</p></section>`;
  const pointsHtml = points.map(p => `<div class="report-tl-point ${p.side}" style="left:${p.left.toFixed(2)}%;--label-top:${p.labelTop}px;--line-top:${p.lineTop}px;--line-height:${p.lineHeight}px;--dot-top:${p.dotY}px">
      <div class="report-tl-label">
        <b>${esc(p.name)}</b>
        <span>（${fmtFee(p.amount)}）</span>
        <small>${p.days === 0 ? '今天' : `${p.days} 天後`}</small>
      </div>
      <em></em>
      <i style="background:${(Object.hasOwn(CAT_COLOR, p.cat) && CAT_COLOR[p.cat]) || CHART.gray}"></i>
    </div>`).join('');
  return `<section><h2>未來 30 天續費時間線</h2>
    <div class="report-timeline">
      <div class="report-tl-axis"></div>
      <div class="report-tl-tick start">今天</div>
      <div class="report-tl-tick end">+30 天</div>
      ${pointsHtml}
    </div>
  </section>`;
}

function reportStatusLists(subs) {
  const statusDate = (s) => isLifetimeSub(s) ? '終身' : (subStatus(s) === 'active' ? (s.nextCharge || '—') : (s.endsOn || '—'));
  const toRows = (rows) => rows.map(s => [esc(s.name), esc(s.category || '未分類'), esc(CYCLE_LABELS[s.cycle] || '月繳'), fmtFee(feeMonthVal(s)), esc(statusDate(s))]);
  const statusText = (s) => STATUS_LABELS[subStatus(s)] || '使用中';
  const categorySections = CATEGORIES.map(cat => {
    const rows = sortByStatusThenCost(subs.filter(s => (s.category || '未分類') === cat))
      .map(s => [esc(s.name), esc(statusText(s)), esc(CYCLE_LABELS[s.cycle] || '月繳'), fmtFee(feeMonthVal(s)), esc(statusDate(s))]);
    return `<h3>${esc(cat)}類</h3>${reportStatusTable(['服務', '狀態', '週期', '月攤提', '日期'], rows, `無${cat}類訂閱`)}`;
  }).join('');
  return `<section><h2>訂閱狀態總覽</h2>
    <h3>使用中</h3>${reportStatusTable(['服務', '類別', '週期', '月攤提', '續費日'], toRows(sortByMonthlyCost(subs.filter(s => subStatus(s) === 'active'))), '無使用中訂閱')}
    <h3>即將停用</h3>${reportStatusTable(['服務', '類別', '週期', '月攤提', '停用日'], toRows(sortByMonthlyCost(subs.filter(s => subStatus(s) === 'ending'))), '無即將停用訂閱')}
    <h3>已停用</h3>${reportStatusTable(['服務', '類別', '週期', '月攤提', '停用日'], toRows(sortByMonthlyCost(subs.filter(s => subStatus(s) === 'ended'))), '無已停用訂閱')}
    <h2 class="subsection-title">依類別檢視</h2>
    ${categorySections}</section>`;
}

function reportSuggestions(subs, mk) {
  const active = subs.filter(s => activeInMonth(s, mk));
  const topCosts = active.slice().sort((a, b) => costForMonth(b, mk) - costForMonth(a, mk)).slice(0, 5)
    .map(s => `<li><b>${esc(s.name)}</b>：${fmtFee(costForMonth(s, mk))} / 月，可優先檢視使用頻率。</li>`);
  const ending = subs.filter(s => subStatus(s) === 'ending').sort((a, b) => (a.endsOn || '').localeCompare(b.endsOn || '')).slice(0, 5)
    .map(s => `<li><b>${esc(s.name)}</b>：${esc(s.endsOn || '—')} 停用，確認是否需要續留。</li>`);
  const marked = subs.filter(s => s.considerCancel).map(s => `<li><b>${esc(s.name)}</b>：已標記考慮停用。</li>`);
  return `<section><h2>檢視建議</h2><div class="report-grid">
    <div class="report-panel"><h3>優先檢查高費用</h3><ul>${topCosts.join('') || '<li>目前沒有可檢查的使用中訂閱。</li>'}</ul></div>
    <div class="report-panel"><h3>停用與取捨</h3><ul>${[...marked, ...ending].join('') || '<li>目前沒有標記停用或即將停用的服務。</li>'}</ul></div>
  </div></section>`;
}

function printSubscriptionReport(subs, curMk, nextMk) {
  const thisMonth = amortizedForMonth(subs, curMk);
  const nextMonth = amortizedForMonth(subs, nextMk);
  const generated = todayStr();
  const extraCss = `
      h1, h2, h3 { margin: 0; font-weight: 600; }
      h1 { font-size: 26px; letter-spacing: .02em; }
      h2 { font-size: 17px; margin: 0 0 10px; display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #ded8cc; padding-bottom: 8px; }
      h2 span { font-size: 14px; color: #c96442; }
      h3 { font-size: 13px; margin: 12px 0 8px; color: #5d574f; }
      .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
      .metric { border: 1px solid #ded8cc; border-radius: 8px; padding: 12px; }
      .metric span { color: #8a887f; display: block; margin-bottom: 6px; }
      .metric b { font-size: 20px; font-family: Georgia, "Times New Roman", serif; font-weight: 500; }
      section { break-inside: avoid; margin: 0 0 18px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
      th, td { text-align: left; border-bottom: 1px solid #ebe6dc; padding: 7px 8px; vertical-align: top; }
      th { color: #777167; background: #f5f1e8; font-size: 11px; font-weight: 600; }
      td.num, th.num, .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .cost-calc-table { table-layout: fixed; }
      .cost-calc-table .service-col { width: 34%; }
      .cost-calc-table .cycle-col { width: 16%; }
      .cost-calc-table .formula-col { width: 30%; }
      .cost-calc-table .amount-col { width: 20%; }
      .cost-calc-table th:nth-child(2), .cost-calc-table td:nth-child(2),
      .cost-calc-table th:nth-child(3), .cost-calc-table td:nth-child(3),
      .cost-calc-table th:last-child, .cost-calc-table td:last-child { text-align: center; }
      .status-overview-table { table-layout: fixed; }
      .status-overview-table .status-service-col { width: 34%; }
      .status-overview-table .status-meta-col { width: 18%; }
      .status-overview-table .status-cycle-col { width: 14%; }
      .status-overview-table .status-month-col { width: 17%; }
      .status-overview-table .status-date-col { width: 17%; }
      .status-overview-table th:nth-child(n+3),
      .status-overview-table td:nth-child(n+3) { text-align: center; }
      .center { text-align: center; }
      .report-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .report-panel { border: 1px solid #ded8cc; border-radius: 8px; padding: 10px; break-inside: avoid; }
      .report-donut-wrap { display: grid; grid-template-columns: 120px 1fr; gap: 12px; align-items: center; }
      .report-donut { width: 118px; height: 118px; border-radius: 50%; position: relative; }
      .report-donut::after { content: ""; position: absolute; inset: 34px; background: #fff; border-radius: 50%; }
      .report-donut.empty { background: #eee8dd; }
      .report-legend { display: grid; gap: 6px; }
      .report-legend div { display: grid; grid-template-columns: 10px 1fr auto auto; gap: 7px; align-items: center; }
      .report-legend i { width: 10px; height: 10px; border-radius: 2px; }
      .subsection-title { margin-top: 16px; }
      .report-timeline { position: relative; height: 210px; margin: 8px 4px 2px; }
      .report-tl-axis { position: absolute; left: 5%; right: 5%; top: 98px; height: 2px; background: #ded8cc; border-radius: 2px; }
      .report-tl-tick { position: absolute; top: 108px; font-size: 10px; color: #8a887f; }
      .report-tl-tick.start { left: 5%; transform: translateX(-50%); }
      .report-tl-tick.end { right: 5%; transform: translateX(50%); }
      .report-tl-point { position: absolute; top: 0; height: 210px; }
      .report-tl-point i { position: absolute; left: 0; top: var(--dot-top); transform: translateX(-50%); width: 13px; height: 13px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #cfc7ba; }
      .report-tl-point em { position: absolute; left: 0; top: var(--line-top); height: var(--line-height); width: 1px; background: #ded8cc; transform: translateX(-50%); }
      .report-tl-label { position: absolute; left: 0; width: 96px; transform: translateX(-50%); text-align: center; line-height: 1.25; }
      .report-tl-point .report-tl-label { top: var(--label-top); }
      .report-tl-label b { display: block; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .report-tl-label span { display: block; font-size: 9.5px; color: #8a887f; }
      .report-tl-label small { display: block; font-size: 9.5px; color: #8a887f; }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 0 0 6px; }
`;
  openPrintWindow(`訂閱追蹤報表 ${curMk}`, extraCss, `
      <div class="preview-bar">
        <div><strong>訂閱追蹤報表預覽</strong></div>
        <button onclick="window.print()">列印 / 另存</button>
      </div>
      <main class="preview-shell"><article class="paper">
        <header class="cover"><div><h1>「訂閱追蹤」報表</h1><p class="muted">產生日期：${esc(generated)}｜本月：${esc(curMk)}</p></div></header>
        <div class="summary">
          <div class="metric"><span>本月費用</span><b>${fmtFee(thisMonth)}</b></div>
          <div class="metric"><span>下月預估</span><b>${fmtFee(nextMonth)}</b></div>
          <div class="metric"><span>每年估算</span><b>${fmtFee(thisMonth * 12)}</b></div>
          <div class="metric"><span>追蹤項目</span><b>${subs.length} 項</b></div>
        </div>
        ${reportCostTable(subs, curMk, '費用計算方式')}
        ${reportCostTable(subs, nextMk, '費用預估方式')}
        ${reportTimeline(subs)}
        ${reportBreakdown(subs, curMk)}
        ${reportSuggestions(subs, curMk)}
        ${reportStatusLists(subs)}
      </article></main>`);
}

// ---- 未來 30 天續費時間線：頁面卡片與列印報表共用的佈局演算法 ----
// 上下交錯放標籤；同側水平距離 <14% 時自動換到下一層，避免重疊
function timelinePoints(subs, { pos, topLevels, bottomLevels, labelH }) {
  const upcoming = subs.filter(s => subStatus(s) === 'active' && !isLifetimeSub(s))
    .map(s => ({ name: s.name, amount: Number(s.amount || 0), days: daysUntil(s.nextCharge), date: s.nextCharge, cat: s.category }))
    .filter(c => isFinite(c.days) && c.days >= 0 && c.days <= 30)
    .sort((a, b) => a.days - b.days);
  const axisY = 98, dotY = axisY - 6;
  /** @type {{top:number[], bottom:number[]}} */
  const lastBySide = { top: [], bottom: [] };
  const points = upcoming.map((c, i) => {
    const left = pos(c.days);
    const side = i % 2 === 0 ? 'top' : 'bottom';
    const levels = side === 'top' ? topLevels : bottomLevels;
    let level = 0;
    while (lastBySide[side][level] != null && left - lastBySide[side][level] < 14 && level < levels.length - 1) level++;
    lastBySide[side][level] = left;
    const labelTop = levels[level];
    const labelBottom = labelTop + labelH;
    return { ...c, left, side, labelTop, dotY,
      lineTop: side === 'top' ? labelBottom : axisY,
      lineHeight: side === 'top' ? Math.max(0, dotY - labelBottom) : Math.max(0, labelTop - axisY) };
  });
  return { upcoming, points };
}

// 續費時間線卡片（頁面版）
function chargeTimelineHtml(subs) {
  const PAD = 7;
  const pos = (d) => PAD + (Math.max(0, Math.min(30, d)) / 30) * (100 - PAD * 2);
  const { upcoming, points } = timelinePoints(subs, { pos, topLevels: [10, 42], bottomLevels: [122, 154, 186], labelH: 42 });
  const total = upcoming.reduce((t, c) => t + c.amount, 0);
  const ticks = [0, 10, 20, 30].map(d => `<div class="tl-tick" style="left:${pos(d).toFixed(2)}%">${d === 0 ? '今天' : '+' + d + '天'}</div>`).join('');

  if (!upcoming.length) {
    return `<div class="chart-card timeline-card"><h3>續費時間線</h3>
      <p class="muted" style="font-size:12.5px;margin-top:6px">未來 30 天內沒有預定續費 🎉</p></div>`;
  }

  const pointsHtml = points.map(p => `<div class="tl-point ${p.side}" style="left:${p.left.toFixed(2)}%;--label-top:${p.labelTop}px;--line-top:${p.lineTop}px;--line-height:${p.lineHeight}px;--dot-top:${p.dotY}px">
      <div class="tl-label">
        <div class="tl-name">${esc(p.name)}</div>
        <div class="tl-amt">（${fmtFee(p.amount)}）</div>
        <div class="tl-day">${p.days === 0 ? '今天' : p.days + ' 天後'}</div>
      </div>
      <div class="tl-stem"></div>
      <div class="tl-dot" style="background:${(Object.hasOwn(CAT_COLOR, p.cat) && CAT_COLOR[p.cat]) || CHART.gray}"></div>
    </div>`).join('');
  

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
  const dateColor = st === 'ending' ? 'color:var(--accent)' : (st === 'ended' || isLifetimeSub(s)) ? 'color:var(--text-dim)' : '';
  const dateSuffix = isLifetimeSub(s) ? '' : st === 'active' ? '續' : (st === 'ending' || st === 'ended') ? '止' : '';
  const dateStr = `<span style="${dateColor}">${esc(whenDateVal || '—')}${whenDateVal && dateSuffix ? ` <span class="date-suffix ${st}">${dateSuffix}</span>` : ''}</span>`;
  const whenCell = `<div class="when-date">${dateStr}</div>`;

  return `<tr data-id="${s.id}" style="${off ? 'opacity:.5' : ''}">
    <td class="grip-col"><span class="drag-handle" style="color:${((Object.hasOwn(CAT_COLOR, cat) && CAT_COLOR[cat]) || CHART.gray)}" title="拖曳調整順序">${icon('grip', 15, true)}</span></td>
    <td class="nowrap">${serviceNameHtml(s)}<span class="cancel-dot${s.considerCancel ? ' on' : ''}"></span></td>
    <td class="num">${fmtFee(feeMonthVal(s))}</td>
    <td class="num">${fmtFee(feeYearVal(s))}</td>
    <td class="nowrap">${CYCLE_LABELS[s.cycle] || '月繳'}</td>
    <td class="nowrap">${whenCell}</td>
    <td class="muted nowrap">${esc(cardLabel(s.card))}${staleCard ? ' <span class="tag amber">卡片已失效</span>' : ''}</td>
    <td class="muted nowrap">${esc(email || '—')}</td>
    <td><div class="row-actions">
      <button class="btn-link btn-sm" data-record="${s.id}" title="記一筆到收支記帳">${icon('record', 15)}</button>
      <button class="btn-link btn-sm flag-action${s.considerCancel ? ' flag-on' : ''}" data-flag="${s.id}" title="${s.considerCancel ? '已標記考慮停用' : '標記考慮停用'}">${icon(s.considerCancel ? 'box-x' : 'box', 15)}</button>
      <button class="btn-link btn-sm" data-edit="${s.id}" title="編輯">${icon('edit', 15)}</button>
      <button class="btn-danger btn-sm" data-del="${s.id}" title="刪除">${icon('trash', 15)}</button>
    </div></td>
  </tr>`;
}

// 訂閱自身類別 → 收支記帳的兩層分類（新分類已無「訂閱」分類）
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
  if (!confirm(`要把這筆記入「收支記帳」嗎？\n\n${s.name}（${cycleLbl}） ${fmtFee(amt)}\n續費卡：${cardLabel(s.card)}\n日期：${todayStr()}`)) return;
  const [cat, subcat] = (Object.hasOwn(SUB_CAT_TO_EXPENSE, s.category) && SUB_CAT_TO_EXPENSE[s.category]) || ['生活', '其他生活雜支'];   // hasOwn（Codex r7#4）：舊資料分類叫 toString 會解構到原型函式而 TypeError
  try {
    await api('/transactions', { method: 'POST', body: {
      date: todayStr(), type: 'expense', category: cat, subcategory: subcat, amount: amt,
      account: s.card || '', note: `${s.name}（訂閱${cycleLbl}）`
    }});
    toast(`已記入收支記帳：${fmtFee(amt)} ✅`);
  } catch (e) { toast(e.message, true); }
}

async function toggleCancel(s) {
  try {
    await api('/subscriptions/' + s.id, { method: 'PUT', body: { considerCancel: !s.considerCancel } });
    toast(s.considerCancel ? '已取消「考慮停用」標記' : '已標記為考慮停用');
    renderSubscriptions();
  } catch (e) { toast(e.message, true); }
}

function drawBreakdown(activeThis, curMk) {
  // 依類別彙總（每月攤提）。Object.create(null)：同 reportBreakdown（Codex r5#5）
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
      toast('已儲存'); renderSubscriptions();
    }
  });
}
