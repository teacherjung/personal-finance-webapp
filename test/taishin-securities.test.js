// 台新證券對帳單解析器考題（證券交易 S1）。解析器餵**合成 x/y 座標列**（不需真 PDF、零真實資料）；
// 帳號一律用明顯假值（AGENTS：合成測試絕不用真實遮罩末碼）。涵蓋藍圖 §十一 必考的 S1 份額：
// 跨兩行成一筆／共用交割日／同日同價兩筆都留／法規數字不當交易／未知類別不猜／跨月年份／彙總核對。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseTaishinSecurities, extractSecStatementMonth, resolveSecDate, isSecuritiesStatement, taishinSideHint } =
  await import('../lib/taishin-securities.js');

/** 合成一列。 @param {number} y @param {[number,string][]} pairs */
const L = (y, pairs) => ({ y, cells: pairs.map(([x, s]) => ({ x, w: 0, s })) });

// 雙層表頭（上層＝每筆第一行的欄名、下層＝第二行的欄名）；x 同欄上下對齊
const HEADER_A = /** @type {[number,string][]} */ ([[40, '成交日'], [95, '交割日'], [150, '證券代號'], [240, '數量'], [300, '成交價'], [360, '手續費'], [430, '應收付金額']]);
const HEADER_B = /** @type {[number,string][]} */ ([[40, '交易類別'], [150, '證券名稱'], [240, '成交金額'], [300, '折讓'], [360, '證交稅'], [430, '幣別']]);

/** 標準前置：年月＋假帳號＋雙層表頭。 */
const preamble = () => [
  L(900, [[40, '台新綜合證券'], [300, '115年1月 對帳單']]),
  L(880, [[40, '帳號：9001-900100']]),          // 明顯假值
  L(860, [[40, '成交明細']]),
  L(840, HEADER_A),
  L(830, HEADER_B),
];

test('雙層表頭＋一筆跨兩行 → 只產生一筆，欄位各就各位（含 ROC 日期、千分位）', () => {
  const r = parseTaishinSecurities([
    ...preamble(),
    L(800, [[40, '115/01/13'], [95, '115/01/15'], [150, '0050'], [240, '1,000'], [300, '104.00'], [360, '148'], [430, '104,148']]),
    L(790, [[40, '現買'], [150, '元大台灣50'], [240, '104,000'], [300, '0'], [360, '0'], [430, 'TWD']]),
  ]);
  assert.equal(r.stmtMonth, '2026-01');
  assert.equal(r.accountRaw, '9001-900100');
  assert.equal(r.trades.length, 1, '跨兩行仍只有一筆');
  const t = r.trades[0];
  assert.equal(t.tradeDate, '2026-01-13');
  assert.equal(t.settlementDate, '2026-01-15');
  assert.equal(t.symbol, '0050');
  assert.equal(t.name, '元大台灣50');
  assert.equal(t.rawType, '現買');
  assert.equal(t.quantity, 1000);
  assert.equal(t.price, 104);
  assert.equal(t.grossAmount, 104000);
  assert.equal(t.commission, 148);
  assert.equal(t.tax, 0);
  assert.equal(t.netSettlement, 104148);
  assert.equal(t.currency, 'TWD');
});

test('兩筆成交共用一個交割彙總列 → 兩筆都回填交割日，且合計核對相符', () => {
  const r = parseTaishinSecurities([
    ...preamble(),
    // 兩筆都沒有交割日欄位值 → 由彙總列回填
    L(800, [[40, '115/01/13'], [150, '0050'], [240, '1,000'], [300, '104.00'], [430, '104,148']]),
    L(790, [[40, '現買'], [150, '元大台灣50'], [240, '104,000'], [360, '0']]),
    L(770, [[40, '115/01/13'], [150, '2330'], [240, '100'], [300, '600.00'], [430, '60,085']]),
    L(760, [[40, '現買'], [150, '台積電'], [240, '60,000'], [360, '0']]),
    L(740, [[40, '應收付日期 115/01/15'], [240, '合計'], [430, '164,233']]),
  ]);
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[0].settlementDate, '2026-01-15');
  assert.equal(r.trades[1].settlementDate, '2026-01-15');
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].date, '2026-01-15');
  assert.equal(r.groups[0].tradeCount, 2);
  assert.equal(r.groups[0].sumMatches, true, '兩筆買 104,148+60,085=164,233 ＝彙總合計');
});

test('明細應收付加總與彙總不符 → sumMatches:false（S2 據此阻擋，不偷改來源數字）', () => {
  const r = parseTaishinSecurities([
    ...preamble(),
    L(800, [[40, '115/01/13'], [150, '0050'], [240, '1,000'], [300, '104.00'], [430, '104,148']]),
    L(790, [[40, '現買'], [150, '元大台灣50'], [240, '104,000']]),
    L(740, [[40, '應收付日期 115/01/15'], [240, '合計'], [430, '999,999']]),
  ]);
  assert.equal(r.groups[0].sumMatches, false);
  assert.equal(r.trades[0].netSettlement, 104148, '來源數字原封不動，只標不符');
});

test('同日同代號同數量同價的兩筆真交易 → 都保留（不去重）', () => {
  const rowA = /** @type {[number,string][]} */ ([[40, '115/01/13'], [150, '0056'], [240, '500'], [300, '40.00'], [430, '20,028']]);
  const rowB = /** @type {[number,string][]} */ ([[40, '現買'], [150, '元大高股息'], [240, '20,000']]);
  const r = parseTaishinSecurities([
    ...preamble(),
    L(800, rowA), L(790, rowB),
    L(770, rowA), L(760, rowB),
  ]);
  assert.equal(r.trades.length, 2, '兩筆一模一樣的真交易都要活');
});

test('頁尾法規文字（含數字）不被當交易；法規之後的內容全部停止解析', () => {
  const r = parseTaishinSecurities([
    ...preamble(),
    L(800, [[40, '115/01/13'], [150, '0050'], [240, '1,000'], [300, '104.00'], [430, '104,148']]),
    L(790, [[40, '現賣'], [150, '元大台灣50'], [240, '104,000']]),
    L(700, [[40, '注意事項：受託買賣有價證券，最低手續費 20 元，詳細費率 0.1425% 請詳閱公開說明。']]),
    L(680, [[40, '115/01/20'], [150, '9999'], [240, '99,999'], [300, '99.00'], [430, '9,899,901']]),   // 法規後的殘影
  ]);
  assert.equal(r.trades.length, 1, '法規之後的數字列不可變成交易');
});

test('未知交易類別 → rawType 原文保留、sideHint 回 null（不猜方向）；彙總核對回 null 不亂判', () => {
  const r = parseTaishinSecurities([
    ...preamble(),
    L(800, [[40, '115/01/13'], [150, '0050'], [240, '1,000'], [300, '104.00'], [430, '104,148']]),
    L(790, [[40, '興櫃申購'], [150, '某某公司'], [240, '104,000']]),
    L(740, [[40, '應收付日期 115/01/15'], [240, '合計'], [430, '104,148']]),
  ]);
  assert.equal(r.trades[0].rawType, '興櫃申購');
  assert.equal(taishinSideHint('興櫃申購'), null);
  assert.equal(r.groups[0].sumMatches, null, '方向未知＝核對不了，回 null 而非 false/true');
});

test('前一月交易出現在下一月對帳單（MM/DD 無年份）→ 年份正確落在去年', () => {
  assert.equal(resolveSecDate('12/28', '2026-01'), '2025-12-28', '1 月帳單裡的 12 月交易＝去年 12 月');
  assert.equal(resolveSecDate('01/13', '2026-01'), '2026-01-13', '同月交易＝當年');
  assert.equal(resolveSecDate('115/01/13', '2026-01'), '2026-01-13', 'ROC 完整日期不受帳單月影響');
  assert.equal(resolveSecDate('13/45', '2026-01'), null, '假日期整筆拒收');
});

test('對帳單年月：民國與西元兩款都認得；缺年月由主入口擋（這裡驗抽取本身）', () => {
  assert.equal(extractSecStatementMonth([L(900, [[40, '115年1月 對帳單']])]), '2026-01');
  assert.equal(extractSecStatementMonth([L(900, [[40, '2026/01 月結單']])]), '2026-01');
  assert.equal(extractSecStatementMonth([L(900, [[40, '沒有年月']])]), null);
});

test('isSecuritiesStatement：證券對帳單認得；銀行綜合對帳單（帳戶概要區）不誤認', () => {
  assert.equal(isSecuritiesStatement([L(900, [[40, '台新綜合證券 成交明細']])]), true);
  assert.equal(isSecuritiesStatement([L(900, [[40, '帳戶概要區 交易往來明細 證券劃撥']])]), false);
});
