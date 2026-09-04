// @ts-check
// 證券交易頁的純呈現層（S3，藍圖 §二/§九）：只做「篩選、排序、分幣別合計、產 HTML 字串」——
// 不碰 DOM、不打 API、**不重算任何來源金額**（所有數字都是後端存好的原幣值；忠實呈現，不判斷投資好壞）。
// esc 與格式器由呼叫端注入（fmt 參數）：本檔零依賴，node --test 可直接匯入（同 goal-tracking.js 前例）。
//
// ⚠️ 幣別牆（藍圖 §二）：不同幣別**絕不相加**——合計一律分幣別；IB 手續費幣別與成交幣別不同時，
// 手續費歸它自己的幣別、不硬加進成交幣別（見 rowFees / secSummarize）。

// 就地白話解釋（使用者鐵則 2026-07-22：「懂了才不會把正常數字當算錯」的概念一律放網頁上）。
// 文案 Claude 起草、老師審改。data-sec-info 接線在 securities.js。
export const SECURITIES_INFO = Object.freeze({
  currency: {
    title: '為什麼金額分幣別，不加總成一個數字？',
    html: '<p>台新的交易是台幣、IBKR 的交易多是美元。<b>不同幣別的錢不能直接相加</b>——加了等於偷偷假設一個匯率，數字就不再是對帳單上的數字，對帳會對不起來。</p><p>所以這頁的合計<b>一個幣別一張卡</b>：買進總額、賣出總額＝該幣別各筆「應收付金額」的合計（已含費稅），和對帳單一致。要看全部換成台幣的總值，請到「投資組合」頁——那裡才做匯率換算。</p>',
  },
  net: {
    title: '「淨應收付」的 ＋／− 代表什麼？',
    html: '<p>淨應收付＝這筆交易<b>實際進出你帳戶的錢</b>（已含手續費與稅）。</p><p><b>買進＝付錢出去，顯示 −（紅）</b>；<b>賣出＝收錢進來，顯示 ＋（綠）</b>。</p><p>台新的金額以<b>對帳單印的「應收付金額」為準</b>——系統只核對、不改寫；核對不符的對帳單會在上傳時整份擋下。</p>',
  },
  fees: {
    title: '「費稅」合計包含哪些錢？',
    html: '<p>費稅＝<b>手續費＋證交稅＋其他費用</b>（與上傳預覽的口徑相同）。<b>折讓</b>（券商退你的手續費）不混進合計——點開該筆明細可看到。</p><p>IBKR 偶爾手續費的幣別和成交幣別不同（例：英股用 GBP 成交、手續費收 USD）。這種手續費<b>不會硬加</b>進成交幣別的合計，會在該筆單獨標出、並歸到它自己幣別的合計卡。</p>',
  },
  dedup: {
    title: '重複上傳同一份對帳單會變兩筆嗎？',
    html: '<p>不會。系統用「帳戶＋成交日＋代號＋類別＋數量＋價格＋金額」辨認同一筆交易：<b>同一份對帳單重傳＝0 筆新增</b>；兩份對帳單涵蓋同一個月份，也不會重複入帳。</p><p>反過來，<b>同一天、同代號、同價格的兩筆真交易會都保留</b>（這是合法的），不會被誤當重複刪掉。</p><p>IBKR 同步也一樣：用官方交易識別碼去重，重複同步不會加倍；同步期間縮短時，舊紀錄也不會消失。</p>',
  },
  boundary: {
    title: '這頁會影響投資組合或收支嗎？',
    // A′ 裁決（William 2026-07-24）：保留唯一一套完整同步、文案講明會動投組；出清確認/刪除留在投組頁
    html: '<p>這一頁<b>自己</b>不會改任何東西：成交紀錄只用來查帳，不計入銀行收支與淨值；頁面上也沒有任何編輯持股的功能。台新對帳單只進查帳集合，第一頁的資產概況<b>不會</b>寫進投資組合（一份月結概況不等於完整交易歷史，直接覆蓋會失真）。</p><p>唯一的例外是「<b>同步 IBKR</b>」：它和投資組合頁是<b>同一套完整同步</b>，按下去除了抓成交紀錄，也會一併更新投資組合的持股與各幣別現金（在哪一頁按，效果相同）。若同步後發現有持股可能已出清，這裡只會<b>提醒你</b>、不會自動移除——確認與移除請到「投資組合」頁做。</p>',
  },
});

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
/** ISO 時間戳 → 本地日期 YYYY-MM-DD（Codex S3r2#5：importedAt 存 UTC ISO，直接 slice 台灣會慢 8 小時，
 * 凌晨匯入甚至顯示前一天）。看不懂的輸入回空字串。 @param {any} iso */
export function localDate(iso) {
  const d = new Date(String(iso || ''));
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** ISO 時間戳 → 本地「YYYY-MM-DD HH:MM」。 @param {any} iso */
export function localDateTime(iso) {
  const d = new Date(String(iso || ''));
  if (!Number.isFinite(d.getTime())) return '';
  return `${localDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 同步後「可能已出清」提示文（A′ 裁決：查帳頁只提醒、不刪持股——確認與移除到投資組合頁）。
 * 沒有缺漏回 null（呼叫端不彈提示）。 @param {any[]|undefined} missing @returns {string|null}
 */
export function missingHoldingsNotice(missing) {
  if (!Array.isArray(missing) || !missing.length) return null;
  const names = missing.map(h => String(h?.symbol || '')).filter(Boolean).join('、');
  return `有 ${missing.length} 檔持股在這次報表中已找不到（可能已出清）${names ? `：${names}` : ''}。這頁不會動持股——請到「投資組合」頁按同步確認是否移除。`;
}

/**
 * 日期快選 → {from, to}（含頭含尾的 YYYY-MM-DD 字串區間）。
 * 近三月＝含本月往前共 3 個日曆月。'all'／'custom'／看不懂的 today 回 null（呼叫端自帶區間）。
 * @param {string} preset 'month'|'3m'|'year'|其他
 * @param {string} today YYYY-MM-DD
 * @returns {{from:string, to:string}|null}
 */
export function datePresetRange(preset, today) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(today || ''));
  if (!m) return null;
  const [, y, mo] = m;
  if (preset === 'month') return { from: `${y}-${mo}-01`, to: today };
  if (preset === '3m') {
    const d = new Date(Number(y), Number(mo) - 1 - 2, 1);   // 往前兩個月的 1 號（跨年自動進位）
    return { from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`, to: today };
  }
  if (preset === 'year') return { from: `${y}-01-01`, to: today };
  return null;
}

/**
 * 篩選（全部條件 AND；'all'／空字串＝不限）。搜尋比對代號與名稱、不分大小寫。
 * @param {any[]} rows
 * @param {{from?:string, to?:string, source?:string, account?:string, side?:string, currency?:string, q?:string}} f
 */
export function filterSecTrades(rows, f) {
  const q = String(f.q || '').trim().toLowerCase();
  return (rows || []).filter(t => {
    if (f.from && String(t.tradeDate || '') < f.from) return false;
    if (f.to && String(t.tradeDate || '') > f.to) return false;
    if (f.source && f.source !== 'all' && t.source !== f.source) return false;
    if (f.account && f.account !== 'all' && String(t.sourceAccountLabel || '') !== f.account) return false;
    if (f.side && f.side !== 'all' && t.side !== f.side) return false;
    if (f.currency && f.currency !== 'all' && t.currency !== f.currency) return false;
    if (q && !(`${t.symbol || ''} ${t.name || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

/**
 * 這一筆的「費稅」合計＝手續費＋證交稅＋其他費用（與後端預覽摘要 byCurrency.fees 同口徑；
 * 折讓在展開明細單列，不混進合計）。手續費幣別與成交幣別不同時，手續費**不算進**這筆的合計
 * ——由 secSummarize 歸到它自己的幣別（幣別牆）。
 * @param {any} t
 */
export function rowFees(t) {
  const commission = (t.commissionCurrency && t.commissionCurrency !== t.currency) ? 0 : (Number(t.commission) || 0);
  return commission + (Number(t.tax) || 0) + (Number(t.otherFees) || 0);
}

/**
 * 淨應收付帶方向：賣出（cashDirection:'in'）＝收錢（＋）、買進（'out'）＝付錢（−）。
 * 缺應收付金額回 null（畫面顯示 —，不畫 0——0 和「沒讀到」是兩回事）。
 * @param {any} t @returns {number|null}
 */
export function rowNetSigned(t) {
  const n = Number(t?.netSettlement);
  if (t?.netSettlement == null || !Number.isFinite(n)) return null;
  return t.cashDirection === 'in' ? Math.abs(n) : -Math.abs(n);
}

const strCmp = (/** @type {string} */ k) => (/** @type {any} */ a, /** @type {any} */ b) => String(a[k] || '').localeCompare(String(b[k] || ''));
const numCmp = (/** @type {string} */ k) => (/** @type {any} */ a, /** @type {any} */ b) => (Number(a[k]) || 0) - (Number(b[k]) || 0);
/** @type {Record<string, (a:any, b:any) => number>} 各欄位主鍵比較器（升冪） */
const SORTERS = {
  tradeDate: strCmp('tradeDate'),
  settlementDate: strCmp('settlementDate'),
  source: strCmp('source'),
  account: (a, b) => String(a.sourceAccountLabel || '').localeCompare(String(b.sourceAccountLabel || ''), 'zh-Hant'),
  symbol: strCmp('symbol'),
  side: strCmp('side'),
  quantity: numCmp('quantity'),
  price: numCmp('price'),
  grossAmount: numCmp('grossAmount'),
  fees: (a, b) => rowFees(a) - rowFees(b),
  net: (a, b) => Math.abs(rowNetSigned(a) ?? 0) - Math.abs(rowNetSigned(b) ?? 0),   // 金額欄口徑＝絕對大小（找「大筆」，同 tx-sort 鐵則）
  currency: strCmp('currency'),
};
/** 換欄時預設降冪（新／大在前）的欄位；其餘文字欄預設升冪。 */
export const SEC_NUMERIC_SORT_KEYS = new Set(['tradeDate', 'settlementDate', 'quantity', 'price', 'grossAmount', 'fees', 'net']);

/**
 * 表頭點擊後的排序狀態（就地改 listSort 並回傳它）：同欄再點＝反轉；換欄＝日期/數字欄預設降冪（新/大在前）、文字欄升冪。
 * 抽成純函式是為了能直接考（內嵌在頁面 onclick 裡考不到）；鍵集合與 tx-sort 不同，故住這裡。
 * @param {{key: string, dir: string}} listSort（與 sortSecTrades 同形；dir 只會是 'asc'／'desc'）@param {string} key
 */
export function nextSecSort(listSort, key) {
  if (listSort.key === key) listSort.dir = listSort.dir === 'asc' ? 'desc' : 'asc';
  else { listSort.key = key; listSort.dir = SEC_NUMERIC_SORT_KEYS.has(key) ? 'desc' : 'asc'; }
  return listSort;
}

// 第二鍵**固定**成交日新→舊＋代號＋id，不跟主鍵一起反轉（tx-sort 鐵則 Codex r8#2：
// 把整個比較器乘 -1 會把第二鍵一起反轉，降冪時同值資料變舊→新）。
const tieBreak = (/** @type {any} */ a, /** @type {any} */ b) =>
  String(b.tradeDate || '').localeCompare(String(a.tradeDate || ''))
  || String(a.symbol || '').localeCompare(String(b.symbol || ''))
  || String(a.id || '').localeCompare(String(b.id || ''));

/** 依 listSort 排序（回傳新陣列，不動原陣列）。 @param {any[]} rows @param {{key:string, dir:string}} listSort */
export function sortSecTrades(rows, listSort) {
  const cmp = Object.hasOwn(SORTERS, listSort.key) ? SORTERS[listSort.key] : SORTERS.tradeDate;   // hasOwn：data-sort 竄改成 __proto__ 時不撈原型
  return (rows || []).slice().sort((a, b) => (listSort.dir === 'desc' ? -cmp(a, b) : cmp(a, b)) || tieBreak(a, b));
}

/**
 * 分幣別合計（藍圖 §二第一列）：每幣別 {count, buy, sell, fees, net}。
 * 買進總額／賣出總額＝該幣別各筆**應收付金額**合計（與後端預覽 byCurrency 同口徑、與對帳單一致）；
 * 手續費歸它自己的幣別（t.commissionCurrency，缺省＝成交幣別）；net＝帶方向合計（收＋付−）。
 * @param {any[]} rows @returns {Record<string, {count:number, buy:number, sell:number, fees:number, net:number}>}
 */
export function secSummarize(rows) {
  /** @type {Record<string, {count:number, buy:number, sell:number, fees:number, net:number}>} */
  const sum = Object.create(null);
  const bucket = (/** @type {string} */ cur) => sum[cur] || (sum[cur] = { count: 0, buy: 0, sell: 0, fees: 0, net: 0 });
  for (const t of rows || []) {
    const cur = String(t.currency || '？');
    const g = bucket(cur);
    g.count++;
    if (t.side === 'buy') g.buy += Number(t.netSettlement) || 0;
    else if (t.side === 'sell') g.sell += Number(t.netSettlement) || 0;
    g.fees += (Number(t.tax) || 0) + (Number(t.otherFees) || 0);
    bucket(String(t.commissionCurrency || cur)).fees += Number(t.commission) || 0;
    const net = rowNetSigned(t);
    if (net != null) g.net += net;
  }
  return sum;
}

/**
 * 分幣別合計卡列。只有費用、沒有成交的幣別（外幣手續費）標「只有費用」。
 * @param {ReturnType<typeof secSummarize>} sum @param {{esc:(s:any)=>string, amt:(n:any)=>string}} fmt
 */
export function secSummaryHtml(sum, fmt) {
  const curs = Object.keys(sum);
  if (!curs.length) return '';
  const card = (/** @type {string} */ cur) => {
    const g = sum[cur];
    const netCls = g.net >= 0 ? 'pos' : 'neg';
    return `<article class="securities-summary-card"><h3>${fmt.esc(cur)}${g.count ? ` 合計 · ${g.count} 筆` : ' · 只有費用'}</h3>
      <div class="sec-sum-rows">
        <div class="row"><span>買進總額</span><b class="num">${fmt.amt(g.buy)}</b></div>
        <div class="row"><span>賣出總額</span><b class="num">${fmt.amt(g.sell)}</b></div>
        <div class="row"><span>費稅合計</span><b class="num">${fmt.amt(g.fees)}</b></div>
        <div class="row"><span>淨應收付</span><b class="num ${netCls}">${g.net >= 0 ? '+' : '−'}${fmt.amt(Math.abs(g.net))}</b></div>
      </div></article>`;
  };
  return `<div class="securities-summary-grid">${curs.map(card).join('')}</div>`;
}

/** 展開明細（每列第二個 tr）：折讓、費用細項、批次——主表安靜、細節要看才展開（藍圖 §二）。 @param {any} t @param {any} fmt */
function secDetailHtml(t, fmt) {
  const pair = (/** @type {string} */ label, /** @type {string} */ v) =>
    v === '' ? '' : `<span><span class="lbl">${label}</span><b>${v}</b></span>`;
  const amtOr = (/** @type {any} */ v, /** @type {string} */ suffix = '') => v == null ? '' : fmt.amt(v) + suffix;
  const foreignComm = t.commissionCurrency && t.commissionCurrency !== t.currency;
  return `<div class="sec-detail-grid">
    ${pair('原始類別', fmt.esc(t.rawType || ''))}
    ${pair('市場', fmt.esc(t.market || ''))}
    ${pair('手續費', amtOr(t.commission, foreignComm ? ' ' + fmt.esc(t.commissionCurrency) : ''))}
    ${pair('折讓', amtOr(t.feeDiscount))}
    ${pair('證交稅', amtOr(t.tax))}
    ${pair('其他費用', amtOr(t.otherFees))}
    ${pair('匯入批次', fmt.esc(t.importBatch || ''))}
    ${pair('匯入時間', fmt.esc(localDate(t.importedAt)))}
  </div>`;
}

/** 主表一列＋緊跟的明細列。 @param {any} t @param {number} i @param {{esc:(s:any)=>string, amt:(n:any)=>string, qty:(n:any)=>string, price:(n:any)=>string}} fmt */
export function secRowHtml(t, i, fmt) {
  const esc = fmt.esc;
  const net = rowNetSigned(t);
  const foreignComm = t.commissionCurrency && t.commissionCurrency !== t.currency;
  const src = t.source === 'ibkr' ? 'IBKR' : t.source === 'taishin' ? '台新證券' : esc(t.source || '—');
  return `<tr class="sec-row" data-sec-row="${i}" title="點擊展開明細">
    <td class="nowrap">${esc(t.tradeDate)}</td>
    <td class="nowrap muted">${esc(t.settlementDate || '—')}</td>
    <td class="muted">${src}</td>
    <td class="muted nowrap">${esc(t.sourceAccountLabel || '—')}</td>
    <td><b>${esc(t.symbol)}</b>${t.name ? ` <span class="muted">${esc(t.name)}</span>` : ''}</td>
    <td><span class="flow-tag ${t.side === 'buy' ? 'neg' : 'pos'}">${t.side === 'buy' ? '買進' : t.side === 'sell' ? '賣出' : '？'}</span></td>
    <td class="num">${fmt.qty(t.quantity)}</td>
    <td class="num">${t.price == null ? '—' : fmt.price(t.price)}</td>
    <td class="num">${t.grossAmount == null ? '—' : fmt.amt(t.grossAmount)}</td>
    <td class="num">${fmt.amt(rowFees(t))}${foreignComm ? ` <span class="muted">＋${fmt.amt(t.commission || 0)} ${esc(t.commissionCurrency)}</span>` : ''}</td>
    <td class="num ${net == null ? '' : net >= 0 ? 'pos' : 'neg'}">${net == null ? '—' : (net >= 0 ? '+' : '−') + fmt.amt(Math.abs(net))}</td>
    <td class="muted">${esc(t.currency)}</td>
  </tr>
  <tr class="sec-detail"><td colspan="12">${secDetailHtml(t, fmt)}</td></tr>`;
}

/** 主表（12 欄＋展開明細；空狀態文案照藍圖 §二）。 @param {any[]} rows @param {(key:string, label:string, cls?:string)=>string} th @param {any} fmt */
export function secTableHtml(rows, th, fmt) {
  const head = `<tr>${th('tradeDate', '成交日')}${th('settlementDate', '交割日')}${th('source', '來源')}${th('account', '帳戶')}${th('symbol', '證券')}${th('side', '買賣')}${th('quantity', '數量', 'num')}${th('price', '成交價', 'num')}${th('grossAmount', '成交金額', 'num')}${th('fees', '費稅', 'num')}${th('net', '淨應收付', 'num')}${th('currency', '幣別')}</tr>`;
  const body = (rows || []).map((t, i) => secRowHtml(t, i, fmt)).join('')
    || '<tr><td colspan="12" class="empty">尚無證券交易。可同步 IBKR，或上傳台新證券對帳單。</td></tr>';
  return `<div class="tbl-wrap securities-ledger-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** 預覽可否確認匯入：無 blocker 且有可新增的筆數（fail-closed，藍圖 §七）。 @param {any} p */
export function canImportPreview(p) {
  return !!p && !(p.blockers || []).length && ((p.counts && p.counts.importable) || 0) > 0;
}

/**
 * 上傳預覽的彈窗內容（藍圖 §七）：年月＋帳戶、blockers（紅牌＝整份擋下）、新增/已存在筆數與白話說明、
 * 分幣別小計、明細表。確認按鈕由呼叫端（securities.js）依 canImportPreview 決定要不要畫。
 * ⚠️ 說明用內文不用 info-link：彈窗共用 #modal-root，開說明窗會蓋掉預覽、使用者得重傳。
 * @param {any} p @param {{esc:(s:any)=>string, amt:(n:any)=>string, qty:(n:any)=>string, price:(n:any)=>string}} fmt
 */
export function previewBodyHtml(p, fmt) {
  const esc = fmt.esc;
  const c = p.counts || { total: 0, duplicate: 0, importable: 0 };
  const blockers = (p.blockers || []).length ? `
    <div class="reminders" style="margin-bottom:10px">${p.blockers.map((/** @type {string} */ b) => `<div class="reminder danger">⛔ ${esc(b)}</div>`).join('')}</div>
    <p class="muted" style="font-size:12px;margin-bottom:12px">為了保護帳目，這份對帳單先不匯入（規則：不猜買賣方向、不改對帳單數字）。請把上面的訊息回報給 Claude 調整解析。</p>` : '';
  const byCur = Object.entries(p.byCurrency || {}).map(([cur, /** @type {any} */ a]) =>
    `<div class="row"><span>${esc(cur)}</span><span>買進 ${a.buyCount} 筆 ${fmt.amt(a.buy)}｜賣出 ${a.sellCount} 筆 ${fmt.amt(a.sell)}｜費稅 ${fmt.amt(a.fees)}</span></div>`).join('');
  const rows = (p.rows || []).map((/** @type {any} */ t) => `<tr${t.duplicate ? ' class="muted"' : ''}>
    <td class="nowrap">${esc(t.tradeDate)}</td>
    <td class="muted">${esc(t.rawType || '')}</td>
    <td><b>${esc(t.symbol)}</b>${t.name ? ` <span class="muted">${esc(t.name)}</span>` : ''}</td>
    <td>${t.side === 'buy' ? '買進' : t.side === 'sell' ? '賣出' : '？'}</td>
    <td class="num">${fmt.qty(t.quantity)}</td>
    <td class="num">${t.price == null ? '—' : fmt.price(t.price)}</td>
    <td class="num">${t.netSettlement == null ? '—' : fmt.amt(t.netSettlement)}</td>
    <td>${t.duplicate ? '<span class="tag">已存在</span>' : '<span class="tag blue">新</span>'}</td>
  </tr>`).join('');
  return `
    <p style="margin-bottom:10px">對帳單年月 <b>${esc(p.stmtMonth || '（讀不到）')}</b> · ${esc(p.accountLabel || '')}</p>
    ${blockers}
    <p style="margin-bottom:6px">共 ${c.total} 筆：<b>新增 ${c.importable}</b>・已存在 ${c.duplicate}</p>
    <p class="muted" style="font-size:12px;margin-bottom:10px">「已存在」＝之前匯入過的同一筆（帳戶＋日期＋代號＋數量＋價格＋金額都相同），不會重複入帳；同天同價的多筆真交易則會分開保留。</p>
    ${byCur ? `<div class="sec-sum-rows" style="margin-bottom:12px">${byCur}</div>` : ''}
    <div class="tbl-wrap" style="max-height:46vh;overflow:auto"><table>
      <thead><tr><th>成交日</th><th>類別</th><th>證券</th><th>買賣</th><th class="num">數量</th><th class="num">成交價</th><th class="num">應收付</th><th>狀態</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="empty">這份對帳單沒有讀到任何成交明細。</td></tr>'}</tbody>
    </table></div>`;
}
