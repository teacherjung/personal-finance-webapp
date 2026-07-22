// @ts-check
// 月度回顧卡片的純呈現層：只接已算好的 API 資料，整理 HTML 與 Chart.js 設定。
// 不碰 DOM/API，也不重算退款或現金流；money-critical 單一真相仍在 lib/derive.js。
import { CHART, PALETTE, AXIS, GRID, ACCENT } from './theme.js';

export const MONTHLY_REVIEW_INFO = Object.freeze({
  settled: {
    title: '為什麼沒有「本月」？',
    html: '<p>刷卡消費通常要等帳單來了才看得到。本月資料還不齊，現在算容易失真，所以這張圖只放<b>已經結清</b>的月份，每一根都比較實在。</p>',
  },
  lens: {
    title: '「消費」和「現金流支出」差在哪？',
    html: '<p><b>消費</b>＝你買了多少東西，不管刷卡或現金，但不含繳卡費那一筆。</p><p><b>現金流支出</b>＝銀行帳戶這個月實際流出多少，含繳卡費、不含刷卡明細。</p><p>同一件事從兩個角度看，數字本來就可能不同，兩個都對：想知道「錢花在哪」看消費；想知道「這個月現金夠不夠」看現金流。</p>',
  },
  overdraft: {
    title: '「透支」是什麼意思？',
    html: '<p>這裡的透支說的是<b>現金週轉</b>：這個月從帳戶流出的錢比流入的多。</p><p>其中很可能包含上個月的卡費，所以「這個月透支」不一定代表這個月亂花。想看這個月花在哪，請看上面的消費分類。</p>',
  },
  refund: {
    title: '退款是怎麼算的？',
    html: '<p>退款會自動尋找對應的消費，把錢退回<b>當初購買的月份</b>，這樣每個月的花費才準。</p><p>如果找不到對應消費，例如舊帳單還沒匯入，就先不計入，免得某個月憑空多一筆退款、看起來像多賺錢。補匯原消費月份的帳單後，它會自動歸位。</p>',
  },
  incomplete: {
    title: '這個月花很少？',
    html: '<p>這個月看起來特別低，可能是那個月的帳單還沒匯入，<b>不一定是真的省</b>。補匯之後，月度回顧會自動更新。</p>',
  },
});

/** @param {string} mk @param {boolean=} withYear */
export function monthlyReviewMonthLabel(mk, withYear = false) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mk || ''));
  if (!m) return String(mk || '');
  return withYear ? `${m[1]} 年 ${Number(m[2])} 月` : `${Number(m[2])} 月`;
}

/**
 * @param {any} review
 * @param {{esc:(v:unknown)=>string, money:(v:any)=>string, wan:(v:any)=>string, pct:(v:any)=>string}} fmt
 */
export function monthlyReviewSummary(review, fmt) {
  const selected = review?.selected || {};
  const months = Array.isArray(review?.months) ? review.months : [];
  const idx = months.findIndex((/** @type {any} */ row) => row.month === review?.selectedMonth);
  const current = idx >= 0 ? Number(months[idx].total || 0) : Number(selected.total || 0);
  const previous = idx > 0 ? Number(months[idx - 1].total || 0) : null;
  const comparison = previous == null
    ? ''
    : `，比 ${monthlyReviewMonthLabel(months[idx - 1].month)}${current >= previous ? '多' : '少'} ${fmt.money(Math.abs(current - previous))}`;
  const top = Array.isArray(selected.categories) && selected.categories.length ? selected.categories[0] : null;
  const topText = top ? `；最大宗是 ${fmt.esc(top.name)} ${fmt.pct(top.pct)}` : '';
  const net = Number(selected.cashflow?.net || 0);
  const netText = `；當月${net < 0 ? '透支' : '結餘'} ${net >= 0 ? '+' : ''}${fmt.money(net)}`;
  return `${monthlyReviewMonthLabel(review?.selectedMonth)}花了 ${fmt.wan(current)}${comparison}${topText}${netText}。`;
}

/**
 * @param {any} review
 * @param {{esc:(v:unknown)=>string, money:(v:any)=>string, wan:(v:any)=>string, pct:(v:any)=>string}} fmt
 */
export function monthlyReviewCardHtml(review, fmt) {
  if (!review) {
    return `<section class="monthly-review dash-block"><div class="mr-head"><div><div class="dash-h">月度回顧</div><h2>最近花錢的樣子</h2></div></div><p class="empty">月度回顧暫時無法載入，其他總覽資料仍可正常使用。</p></section>`;
  }
  const months = Array.isArray(review.months) ? review.months : [];
  if (!months.length || !review.selectedMonth) {
    return `<section class="monthly-review dash-block"><div class="mr-head"><div><div class="dash-h">月度回顧</div><h2>最近花錢的樣子</h2></div><button type="button" class="info-link" data-mr-info="settled">為什麼沒有本月？</button></div><p class="empty">尚無已結清月份的收支資料，匯入帳單或開始記帳後，這裡會顯示近六個月回顧。</p></section>`;
  }

  const categories = Array.isArray(review.selected?.categories) ? review.selected.categories : [];
  const categoryHtml = categories.length ? categories.map((/** @type {any} */ cat, /** @type {number} */ i) => {
    const color = PALETTE[i % PALETTE.length];
    const subs = Array.isArray(cat.subcategories) ? cat.subcategories : [];
    const subHtml = subs.map((/** @type {any} */ sub) => `<div class="mr-sub-row"><span>${fmt.esc(sub.name)}</span><span class="num">${fmt.money(sub.amount)}</span><span class="num muted">${fmt.pct(sub.pct)}</span></div>`).join('');
    return `<details class="mr-category"><summary><span class="mr-cat-name"><i style="background:${color}"></i>${fmt.esc(cat.name)}</span><span class="mr-cat-bar"><i style="width:${Math.max(0, Math.min(100, Number(cat.pct) || 0)).toFixed(2)}%;background:${color}"></i></span><span class="num">${fmt.money(cat.amount)}</span><span class="num muted">${fmt.pct(cat.pct)}</span></summary><div class="mr-sub-list">${subHtml || '<p class="empty">尚無子分類。</p>'}</div></details>`;
  }).join('') : '<p class="empty">這個月尚無可分類的消費。</p>';

  const cf = review.selected?.cashflow || {};
  const net = Number(cf.net || 0);
  const unmatched = review.unmatchedRefunds || { count: 0, total: 0, items: [] };
  const hasIncomplete = months.some((/** @type {any} */ row) => row.possiblyIncomplete);

  return `<section class="monthly-review dash-block">
    <div class="mr-head"><div><div class="dash-h">月度回顧</div><h2>最近花錢的樣子</h2></div><button type="button" class="info-link" data-mr-info="settled">為什麼沒有本月？</button></div>
    <p class="mr-summary">${monthlyReviewSummary(review, fmt)}</p>
    <div class="mr-grid">
      <div class="mr-chart-panel">
        <div class="mr-section-head"><h3>近六個月消費</h3><button type="button" class="info-link" data-mr-info="lens">消費怎麼算？</button></div>
        <div class="mr-chart-box"><canvas id="monthlyReviewChart"></canvas></div>
        ${hasIncomplete ? '<button type="button" class="mr-incomplete info-link" data-mr-info="incomplete">標示「資料可能未齊」的月份，金額不一定是真的低</button>' : ''}
      </div>
      <div class="mr-category-panel">
        <div class="mr-section-head"><h3>${fmt.esc(monthlyReviewMonthLabel(review.selectedMonth, true))}消費分類</h3><button type="button" class="info-link" data-mr-info="lens">兩種支出為何不同？</button></div>
        <div class="mr-category-head"><span>大分類</span><span></span><span class="num">金額</span><span class="num">佔比</span></div>
        <div class="mr-category-list">${categoryHtml}</div>
      </div>
    </div>
    <div class="mr-cashflow">
      <div class="mr-section-head"><h3>現金流</h3>${cf.overdraft ? '<button type="button" class="info-link" data-mr-info="overdraft">透支是什麼？</button>' : '<button type="button" class="info-link" data-mr-info="lens">和消費有何不同？</button>'}</div>
      <div class="mr-cf-values"><div><span>收入</span><b>${fmt.money(cf.income)}</b></div><div><span>支出</span><b>${fmt.money(cf.expense)}</b></div><div><span>淨額</span><b class="${net < 0 ? 'neg' : 'pos'}">${net >= 0 ? '+' : ''}${fmt.money(net)}</b></div>${cf.overdraft ? `<div class="mr-overdraft"><span>本月透支</span><b class="neg">${fmt.money(-Number(cf.overdraftAmount || 0))}</b></div>` : ''}</div>
    </div>
    ${Number(unmatched.count || 0) > 0 ? `<div class="mr-refund-note">另有 ${Number(unmatched.count)} 筆退款（共 ${fmt.money(unmatched.total)}）找不到對應消費、未計入。 <button type="button" class="info-link" data-mr-info="refund">查看與說明</button></div>` : ''}
  </section>`;
}

/**
 * @param {any} review
 * @param {{esc:(v:unknown)=>string, money:(v:any)=>string}} fmt
 */
export function unmatchedRefundInfoHtml(review, fmt) {
  const items = Array.isArray(review?.unmatchedRefunds?.items) ? review.unmatchedRefunds.items : [];
  const rows = items.map((/** @type {any} */ row) => `<tr><td>${fmt.esc(row.date)}</td><td>${fmt.esc(row.store)}</td><td class="num">${fmt.money(row.amount)}</td></tr>`).join('');
  return `${MONTHLY_REVIEW_INFO.refund.html}${rows ? `<div class="table-wrap"><table class="summary-table"><thead><tr><th>退款日</th><th>店家</th><th class="num">金額</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
}

/**
 * @param {any} review
 * @param {{money:(v:any)=>string, onSelect:(month:string)=>void}} options
 */
export function monthlyReviewChartConfig(review, options) {
  const months = Array.isArray(review?.months) ? review.months : [];
  const selected = String(review?.selectedMonth || '');
  return {
    type: 'bar',
    data: {
      labels: months.map((/** @type {any} */ row) => monthlyReviewMonthLabel(row.month)),
      datasets: [{
        label: '消費',
        data: months.map((/** @type {any} */ row) => Number(row.total || 0)),
        backgroundColor: months.map((/** @type {any} */ row) => row.possiblyIncomplete ? CHART.gray : (row.month === selected ? ACCENT : CHART.blue)),
        borderColor: months.map((/** @type {any} */ row) => row.month === selected ? ACCENT : 'transparent'),
        borderWidth: months.map((/** @type {any} */ row) => row.month === selected ? 2 : 0),
        borderRadius: 4,
        minBarLength: 3,
        maxBarThickness: 52,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_event, elements) => {
        const index = elements?.[0]?.index;
        const month = index == null ? '' : String(months[index]?.month || '');
        if (month && month !== selected) options.onSelect(month);
      },
      onHover: (event, elements) => { if (event?.native?.target) event.native.target.style.cursor = elements?.length ? 'pointer' : 'default'; },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: (items) => monthlyReviewMonthLabel(months[items?.[0]?.dataIndex]?.month, true),
          label: (ctx) => ` 消費 ${options.money(ctx.parsed.y)}`,
          afterLabel: (ctx) => months[ctx.dataIndex]?.possiblyIncomplete ? ' 資料可能未齊，金額不一定是真的低' : '',
        } },
      },
      scales: {
        x: { ticks: { color: AXIS }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: AXIS, callback: (v) => {
          const n = Number(v);
          if (n < 10000) return n.toLocaleString('en-US');
          return `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}萬`;
        } }, grid: { color: GRID } },
      },
    },
  };
}
