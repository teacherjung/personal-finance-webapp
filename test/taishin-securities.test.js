// 台新證券對帳單解析器考題（證券交易 S1）。解析器餵**合成 x/y 座標列**（不需真 PDF、零真實資料）；
// 帳號一律用明顯假值（AGENTS：合成測試絕不用真實遮罩末碼）。涵蓋藍圖 §十一 必考的 S1 份額：
// 跨兩行成一筆／共用交割日／同日同價兩筆都留／法規數字不當交易／未知類別不猜／跨月年份／彙總核對。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseTaishinSecurities, extractSecStatementMonth, resolveSecDate, isSecuritiesStatement, taishinSideHint } =
  await import('../lib/taishin-securities.js');

/** 合成一列（w=0，左緣定位）。 @param {number} y @param {[number,string][]} pairs */
const L = (y, pairs) => ({ y, cells: pairs.map(([x, s]) => ({ x, w: 0, s })) });
/** 合成一列（帶真實寬度 w，測右對齊金額的右緣分欄）。 @param {number} y @param {[number,number,string][]} triples */
const LW = (y, triples) => ({ y, cells: triples.map(([x, w, s]) => ({ x, w, s })) });

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

// ==== 以下為對抗式自審（4 攻擊手＋逐條驗證）確認的 bug 之回歸考題 ====

test('自審回歸｜真實寬度 w>0：右對齊金額用 band 分欄不串欄；名稱數字尾碼不併進成交金額；數字代號不漂進數量', () => {
  // 每個右對齊金額右緣貼近「下一欄表頭左緣」（過相鄰中線但落在 band 內）——中線法會整欄右移串接，band 法正確。
  const r = parseTaishinSecurities([
    LW(900, [[40, 0, '台新綜合證券'], [300, 0, '115年1月 對帳單']]),
    LW(880, [[40, 0, '帳號：9001-900100']]),
    LW(860, [[40, 0, '成交明細']]),
    LW(840, [[40, 0, '成交日'], [95, 0, '交割日'], [150, 0, '證券代號'], [240, 0, '數量'], [300, 0, '成交價'], [360, 0, '手續費'], [430, 0, '應收付金額']]),
    LW(830, [[40, 0, '交易類別'], [150, 0, '證券名稱'], [240, 0, '成交金額'], [300, 0, '折讓'], [360, 0, '證交稅'], [430, 0, '幣別']]),
    // A 行：0050 代號帶寬（右緣 200，中線法會漂進數量）；1,000 右緣 295（中線法漂進成交價）；148 右緣 425（中線法漂進應收付）
    LW(800, [[40, 0, '115/01/13'], [95, 0, '115/01/15'], [150, 50, '0050'], [260, 35, '1,000'], [320, 35, '104.00'], [395, 30, '148'], [430, 60, '104,148']]),
    // B 行：名稱拆成「元大台灣」＋數字尾碼「50」（右緣 212，中線法會併進成交金額）；成交金額右對齊
    LW(790, [[40, 0, '現買'], [150, 48, '元大台灣'], [200, 12, '50'], [250, 45, '104,000'], [430, 0, 'TWD']]),
  ]);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.symbol, '0050', '數字代號右緣過中線也不漂進數量');
  assert.equal(t.quantity, 1000, '數量不漂進成交價');
  assert.equal(t.price, 104);
  assert.equal(t.commission, 148, '手續費不漂進應收付');
  assert.equal(t.netSettlement, 104148);
  assert.equal(t.name, '元大台灣50', '名稱數字尾碼 50 不被併進成交金額');
  assert.equal(t.grossAmount, 104000, '成交金額不被名稱尾碼污染（否則 50104000，錯 483 倍）');
});

test('自審回歸｜對帳單年月：西元「2026年1月」不被民國 regex 咬成 1937（連帶 MM/DD 全偏移 89 年）', () => {
  assert.equal(extractSecStatementMonth([L(900, [[40, '2026年1月 對帳單']])]), '2026-01');
  assert.equal(extractSecStatementMonth([L(900, [[40, '2026年01月']])]), '2026-01');
  assert.equal(extractSecStatementMonth([L(900, [[40, '115年1月']])]), '2026-01', '民國仍認得');
});

test('自審回歸｜交易表跨頁：第 1 頁頁尾法規小字不砍第 2 頁成交（法規→退出模式、次頁表頭重印續收）', () => {
  const r = parseTaishinSecurities([
    ...preamble(),
    L(800, [[40, '115/01/13'], [150, '0050'], [240, '1,000'], [300, '104.00'], [430, '104,148']]),
    L(790, [[40, '現買'], [150, '元大台灣'], [240, '104,000']]),
    L(700, [[40, '手續費率請詳閱公開說明書 第1頁/共2頁']]),   // 每頁頁尾常見法規小字
    // 第 2 頁（extractSecuritiesLines 的 pageBase 位移 -100000）：表頭重印＋第 2 筆
    L(840 - 100000, HEADER_A), L(830 - 100000, HEADER_B),
    L(800 - 100000, [[40, '115/01/14'], [150, '2330'], [240, '100'], [300, '600.00'], [430, '60,085']]),
    L(790 - 100000, [[40, '現買'], [150, '台積電'], [240, '60,000']]),
  ]);
  assert.equal(r.trades.length, 2, '第 2 頁的 2330 不因第 1 頁頁尾法規被靜默砍掉');
  assert.equal(r.trades[1].symbol, '2330');
});

test('自審回歸｜表頭被逐字拆 → headerFound=false、trades 空（主入口據此 throw 400，不靜默回 0 筆）', () => {
  const r = parseTaishinSecurities([
    L(900, [[40, '台新綜合證券'], [300, '115年1月']]),
    L(860, [[40, '成交明細']]),
    L(840, [[40, '成'], [52, '交'], [64, '日'], [150, '代'], [162, '號'], [240, '數'], [252, '量']]),   // 逐字拆＝湊不到完整 token
    L(800, [[40, '115/01/13'], [150, '0050'], [240, '1,000'], [300, '104.00'], [430, '104,148']]),
  ]);
  assert.equal(r.headerFound, false);
  assert.equal(r.trades.length, 0);
});

test('自審回歸｜混合買賣同交割群組 → sumMatches:null（合計語意未經真實版面校準，不押注淨額/加總）', () => {
  const r = parseTaishinSecurities([
    ...preamble(),
    L(800, [[40, '115/01/13'], [150, '0050'], [240, '1,000'], [300, '104.00'], [430, '104,148']]),
    L(790, [[40, '現買'], [150, '元大台灣'], [240, '104,000']]),
    L(770, [[40, '115/01/13'], [150, '2330'], [240, '100'], [300, '600.00'], [430, '60,085']]),
    L(760, [[40, '現賣'], [150, '台積電'], [240, '60,000']]),
    L(740, [[40, '應收付日期 115/01/15'], [240, '合計'], [430, '44,063']]),
  ]);
  assert.equal(r.groups[0].sumMatches, null, '一買一賣＝核對不了、回 null 而非 true/false');
});

test('自審回歸｜MM/DD 前向跨年：12 月帳單裡的隔年 1 月交割日 → 明年（不落成同年往回跳 11 個月）', () => {
  assert.equal(resolveSecDate('01/02', '2026-12'), '2027-01-02', '12 月帳單的 1 月交割＝隔年 1 月');
  assert.equal(resolveSecDate('12/28', '2026-12'), '2026-12-28', '同月不受影響');
});
