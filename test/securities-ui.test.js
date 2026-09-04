// 證券交易頁純呈現層考題（S3）：securities-view.js 零 DOM 依賴，直接 import 斷言 HTML 字串
//（同 goal-tracking-ui.test.js 前例）。格式器/esc/th 由測試端注入，與正式頁的注入介面一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECURITIES_INFO, SEC_NUMERIC_SORT_KEYS, nextSecSort, datePresetRange, filterSecTrades, sortSecTrades,
  rowFees, rowNetSigned, secSummarize, secSummaryHtml, secRowHtml, secTableHtml,
  previewBodyHtml, canImportPreview, localDate, localDateTime, missingHoldingsNotice,
} from '../public/modules/securities-view.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
const amt = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const FMT = { esc, amt, qty: amt, price: amt };
const th = (key, label, cls = '') => `<th class="sortable ${cls}" data-sort="${key}">${label}</th>`;

/** 造一筆合成成交（絕不用真實資料） */
const mk = (over = {}) => ({
  id: 'id-' + (over.id || Math.abs(JSON.stringify(over).length)), tradeDate: '2026-06-10', settlementDate: '2026-06-12',
  source: 'taishin', sourceAccountLabel: '台新證券 …0001', symbol: '2330', name: '台積電',
  side: 'buy', quantity: 1000, price: 900, grossAmount: 900000, commission: 1281, tax: 0,
  netSettlement: 901281, cashDirection: 'out', currency: 'TWD', rawType: '現買',
  importBatch: 'ts-2026-06-x1', importedAt: '2026-07-01T00:00:00.000Z', ...over,
});

// ---------- 日期快選 ----------
test('datePresetRange：本月／近三月／今年（含跨年進位）', () => {
  assert.deepEqual(datePresetRange('month', '2026-07-24'), { from: '2026-07-01', to: '2026-07-24' });
  assert.deepEqual(datePresetRange('3m', '2026-07-24'), { from: '2026-05-01', to: '2026-07-24' });   // 含本月共 3 個日曆月
  assert.deepEqual(datePresetRange('year', '2026-07-24'), { from: '2026-01-01', to: '2026-07-24' });
  assert.deepEqual(datePresetRange('3m', '2026-01-15'), { from: '2025-11-01', to: '2026-01-15' });   // 跨年
  assert.equal(datePresetRange('all', '2026-07-24'), null);
  assert.equal(datePresetRange('month', '亂七八糟'), null);   // 看不懂的 today 不硬猜區間
});

// ---------- 篩選 ----------
test('filterSecTrades：日期含頭含尾、來源/帳戶/方向/幣別、搜尋不分大小寫比對代號與名稱', () => {
  const rows = [
    mk({ id: 'a', tradeDate: '2026-05-01' }),
    mk({ id: 'b', tradeDate: '2026-06-30', source: 'ibkr', sourceAccountLabel: 'IBKR …9999', symbol: 'VWRA', name: 'Vanguard FTSE All-World', side: 'sell', currency: 'USD', cashDirection: 'in' }),
    mk({ id: 'c', tradeDate: '2026-07-01' }),
  ];
  // 日期含頭含尾
  const inRange = filterSecTrades(rows, { from: '2026-05-01', to: '2026-06-30' });
  assert.deepEqual(inRange.map(t => t.id), ['a', 'b']);
  // 各維度
  assert.equal(filterSecTrades(rows, { source: 'ibkr' }).length, 1);
  assert.equal(filterSecTrades(rows, { account: 'IBKR …9999' })[0].id, 'b');
  assert.equal(filterSecTrades(rows, { side: 'sell' })[0].id, 'b');
  assert.equal(filterSecTrades(rows, { currency: 'USD' })[0].id, 'b');
  // 搜尋：代號小寫、名稱片段都要中
  assert.equal(filterSecTrades(rows, { q: 'vwra' })[0].id, 'b');
  assert.equal(filterSecTrades(rows, { q: 'all-world' })[0].id, 'b');
  assert.equal(filterSecTrades(rows, { q: '台積' }).length, 2);
  // 'all'／空字串＝不限
  assert.equal(filterSecTrades(rows, { source: 'all', account: 'all', side: 'all', currency: 'all', q: '' }).length, 3);
});

// ---------- 排序 ----------
test('sortSecTrades：主鍵反轉時第二鍵固定日期新→舊（tx-sort 鐵則 r8#2），不動原陣列', () => {
  const rows = [
    mk({ id: 'old', tradeDate: '2026-06-01', quantity: 500 }),
    mk({ id: 'new', tradeDate: '2026-06-20', quantity: 500 }),   // 與 old 同數量：考第二鍵
    mk({ id: 'big', tradeDate: '2026-06-10', quantity: 2000 }),
  ];
  const asc = sortSecTrades(rows, { key: 'quantity', dir: 'asc' });
  assert.deepEqual(asc.map(t => t.id), ['new', 'old', 'big']);   // 同量 500：新日期在前
  const desc = sortSecTrades(rows, { key: 'quantity', dir: 'desc' });
  assert.deepEqual(desc.map(t => t.id), ['big', 'new', 'old']);  // 反轉主鍵後，同量仍是新→舊（第二鍵不反轉）
  assert.equal(rows[0].id, 'old');   // 原陣列不動
  // 未知鍵（含 __proto__ 竄改）退回成交日排序，不撈原型
  const weird = sortSecTrades(rows, { key: '__proto__', dir: 'desc' });
  assert.deepEqual(weird.map(t => t.id), ['new', 'big', 'old']);
});

// ---------- 費稅與淨應收付口徑 ----------
test('rowFees：手續費＋稅＋其他費用；外幣手續費不混入（幣別牆）', () => {
  assert.equal(rowFees(mk({ commission: 100, tax: 30, otherFees: 5 })), 135);
  assert.equal(rowFees(mk({ commission: 2.5, commissionCurrency: 'USD', currency: 'GBP', tax: 0, otherFees: 0 })), 0);   // USD 手續費不算進 GBP 這筆
  assert.equal(rowFees(mk({ commission: null, tax: null, otherFees: null })), 0);
});

test('rowNetSigned：賣＝＋、買＝−；缺應收付回 null（不是 0——0 和沒讀到是兩回事）', () => {
  assert.equal(rowNetSigned(mk({ netSettlement: 901281, cashDirection: 'out' })), -901281);
  assert.equal(rowNetSigned(mk({ netSettlement: 5000, cashDirection: 'in' })), 5000);
  assert.equal(rowNetSigned(mk({ netSettlement: null })), null);
  assert.equal(rowNetSigned({}), null);
});

// ---------- 分幣別合計 ----------
test('secSummarize：幣別絕不相加；外幣手續費歸自己的幣別桶；net 帶方向累計', () => {
  const rows = [
    mk({ side: 'buy', netSettlement: 901281, cashDirection: 'out', tax: 0, commission: 1281 }),                       // TWD 買
    mk({ id: 's', side: 'sell', netSettlement: 500000, cashDirection: 'in', commission: 700, tax: 1500 }),           // TWD 賣
    mk({ id: 'g', currency: 'GBP', side: 'buy', netSettlement: 1000, cashDirection: 'out', commission: 3, commissionCurrency: 'USD', tax: 0 }),  // GBP 買、USD 手續費
  ];
  const sum = secSummarize(rows);
  assert.deepEqual(Object.keys(sum).sort(), ['GBP', 'TWD', 'USD']);
  assert.equal(sum.TWD.count, 2);
  assert.equal(sum.TWD.buy, 901281);
  assert.equal(sum.TWD.sell, 500000);
  assert.equal(sum.TWD.fees, 1281 + 700 + 1500);
  assert.equal(sum.TWD.net, -901281 + 500000);
  assert.equal(sum.GBP.fees, 0);          // USD 手續費沒混進 GBP
  assert.equal(sum.USD.fees, 3);          // 歸到自己的幣別桶
  assert.equal(sum.USD.count, 0);         // USD 沒有成交、只有費用
});

test('secSummaryHtml：一幣別一張卡、費用專屬幣別標「只有費用」；空資料回空字串', () => {
  const html = secSummaryHtml(secSummarize([
    mk({}), mk({ id: 'u', currency: 'USD', side: 'sell', cashDirection: 'in', netSettlement: 100 }),
  ]), FMT);
  assert.match(html, /TWD 合計 · 1 筆/);
  assert.match(html, /USD 合計 · 1 筆/);
  const feeOnly = secSummaryHtml(secSummarize([mk({ currency: 'GBP', commission: 3, commissionCurrency: 'USD' })]), FMT);
  assert.match(feeOnly, /USD · 只有費用/);
  assert.equal(secSummaryHtml(secSummarize([]), FMT), '');
});

// ---------- 主表 ----------
test('secTableHtml：空狀態文案照藍圖；有資料時含展開明細列與批次資訊', () => {
  const empty = secTableHtml([], th, FMT);
  assert.match(empty, /尚無證券交易。可同步 IBKR，或上傳台新證券對帳單。/);
  const html = secTableHtml([mk({})], th, FMT);
  assert.match(html, /sec-detail/);
  assert.match(html, /ts-2026-06-x1/);      // 批次在明細
  assert.match(html, /現買/);               // 原始類別在明細
  assert.match(html, /台新證券 …0001/);
  assert.match(html, /−901,281/);           // 買進＝付錢顯示 −（U+2212）
});

test('secRowHtml：使用者字串一律 esc；外幣手續費單獨標示不併數字', () => {
  const html = secRowHtml(mk({ name: '<b>惡意</b>', symbol: 'A&B' }), 0, FMT);
  assert.doesNotMatch(html, /<b>惡意<\/b>/);
  assert.match(html, /&lt;b&gt;惡意&lt;\/b&gt;/);
  assert.match(html, /A&amp;B/);
  const gb = secRowHtml(mk({ currency: 'GBP', commission: 2.5, commissionCurrency: 'USD', tax: 0, otherFees: null }), 0, FMT);
  // 第二輪稽核（2026-09-02）securities-ui：原本 `/>0</` 中的是展開明細裡的證交稅 `<b>0</b>`、`/—/` 中任何一個 —＝釘錯格；
  // 費稅格併入外幣手續費、缺價畫成 0 都仍綠。改釘到格子本身。
  assert.ok(gb.includes('<td class="num">0 <span class="muted">＋2.5 USD</span></td>'), '費稅合計格＝本幣費稅 0，外幣手續費另列在同格的小字（不併進數字）：\n' + gb);
  assert.ok(!gb.includes('<td class="num">2.5</td>'), '外幣手續費不可被當本幣費稅加總');
  // 缺價格/成交金額顯示 —（不是 0）；淨應收付缺值也是 —
  const missing = secRowHtml(mk({ price: null, grossAmount: null, netSettlement: null }), 0, FMT);
  assert.ok(missing.includes('<td class="num">—</td>\n    <td class="num">—</td>'), '價格與成交金額兩格相鄰都是 —：\n' + missing);
  assert.ok(missing.includes('<td class="num ">—</td>'), '淨應收付缺值＝—（不帶正負 class）');
  assert.ok(!missing.includes('<td class="num">0</td>'), '缺值不可畫成 0');
});

// ---------- 上傳預覽 ----------
const previewFx = (over = {}) => ({
  stmtMonth: '2026-06', accountLabel: '台新證券 …0001', blockers: [],
  rows: [{ ...mk({}), duplicate: false }, { ...mk({ id: 'd' }), duplicate: true }],
  byCurrency: { TWD: { buy: 901281, sell: 0, fees: 1281, buyCount: 1, sellCount: 0 } },
  counts: { total: 2, duplicate: 1, importable: 1 }, ...over,
});

test('canImportPreview：有 blocker 或無可新增筆數都不可匯（fail-closed）', () => {
  assert.equal(canImportPreview(previewFx()), true);
  assert.equal(canImportPreview(previewFx({ blockers: ['讀不到對帳單年月'] })), false);
  assert.equal(canImportPreview(previewFx({ counts: { total: 2, duplicate: 2, importable: 0 } })), false);
  assert.equal(canImportPreview(null), false);
});

test('previewBodyHtml：blockers 紅牌照列、新增/已存在計數與白話說明、分幣別小計、重複列標「已存在」', () => {
  const html = previewBodyHtml(previewFx(), FMT);
  assert.match(html, /對帳單年月 <b>2026-06<\/b>/);
  assert.match(html, /新增 1<\/b>・已存在 1/);
  assert.match(html, /「已存在」＝之前匯入過的同一筆/);   // 就地白話解釋（彈窗內用內文，不用會蓋窗的 info-link）
  assert.match(html, /買進 1 筆 901,281/);
  assert.match(html, /已存在<\/span>/);
  const blocked = previewBodyHtml(previewFx({ blockers: ['有 1 筆交易類別無法判定買賣方向'] }), FMT);
  assert.match(blocked, /⛔ 有 1 筆交易類別無法判定買賣方向/);
  assert.match(blocked, /不猜買賣方向、不改對帳單數字/);
});

// ---------- 就地解釋齊備（使用者鐵則 2026-07-22） ----------
test('SECURITIES_INFO：五個必懂概念（分幣別/淨應收付/費稅/去重/邊界）都有標題與白話內文', () => {
  for (const key of ['currency', 'net', 'fees', 'dedup', 'boundary']) {
    const info = SECURITIES_INFO[key];
    assert.ok(info && info.title && info.html, `缺就地解釋：${key}`);
  }
  assert.match(SECURITIES_INFO.currency.html, /不能直接相加/);
  assert.match(SECURITIES_INFO.net.html, /買進＝付錢/);
  assert.match(SECURITIES_INFO.dedup.html, /0 筆新增/);
  // A′ 裁決（2026-07-24）：誠實講明同步是同一套完整同步、會動投組；出清只提醒不自動移除
  assert.match(SECURITIES_INFO.boundary.html, /同一套完整同步/);
  assert.match(SECURITIES_INFO.boundary.html, /不會自動移除/);
});

// ---------- Codex S3r2 修正 ----------
test('S3r2#5：匯入時間用本地時區顯示（UTC ISO 直接 slice 台灣會慢 8 小時）', () => {
  // 用本地時間分量造 ISO（測試在任何時區都成立）：本地 2026-06-15 01:30 → toISOString 的 UTC 字串
  // slice 在台灣會變成 06-14——localDate 必須還原回本地日期
  const iso = new Date(2026, 5, 15, 1, 30).toISOString();
  assert.equal(localDate(iso), '2026-06-15');
  assert.equal(localDateTime(iso), '2026-06-15 01:30');
  assert.equal(localDate('亂七八糟'), '');
  assert.equal(localDateTime(''), '');
});

test('S3r2#3：可能已出清 → 只提醒＋指路投資組合頁（A′：查帳頁不刪持股）', () => {
  assert.equal(missingHoldingsNotice([]), null);
  assert.equal(missingHoldingsNotice(undefined), null);
  const msg = missingHoldingsNotice([{ id: 'h1', symbol: 'VWRA' }, { id: 'h2', symbol: 'EIMI' }]);
  assert.match(msg, /2 檔/);
  assert.match(msg, /VWRA、EIMI/);
  assert.match(msg, /投資組合/);
  assert.match(msg, /不會動持股/);
});

test('SEC_NUMERIC_SORT_KEYS：日期與數字欄的集合完整（換欄方向的行為在下一題）', () => {
  for (const k of ['tradeDate', 'settlementDate', 'quantity', 'price', 'grossAmount', 'fees', 'net']) {
    assert.ok(SEC_NUMERIC_SORT_KEYS.has(k), k);
  }
  assert.ok(!SEC_NUMERIC_SORT_KEYS.has('symbol'));
});

// 第二輪稽核（2026-09-02）securities-ui：換欄方向原本內嵌在 securities.js 的表頭 onclick，全 repo 零考題（改成一律升冪仍全綠）。
// 抽成純函式 nextSecSort 直測；頁面接線由 securities-states-ui 的接線題釘。
test('nextSecSort：同欄再點＝反轉；換欄＝日期/數字欄預設降冪（新/大在前）、文字欄升冪', () => {
  const s = { key: 'tradeDate', dir: 'desc' };
  assert.deepEqual(nextSecSort(s, 'quantity'), { key: 'quantity', dir: 'desc' }, '換到數字欄：大的在前');
  assert.deepEqual(nextSecSort(s, 'quantity'), { key: 'quantity', dir: 'asc' }, '同欄再點：反轉');
  assert.deepEqual(nextSecSort(s, 'symbol'), { key: 'symbol', dir: 'asc' }, '換到文字欄：升冪');
  assert.deepEqual(nextSecSort(s, 'symbol'), { key: 'symbol', dir: 'desc' });
  assert.deepEqual(nextSecSort(s, 'net'), { key: 'net', dir: 'desc' }, '換回數字欄：仍是降冪（不是沿用上一欄的方向）');
});
