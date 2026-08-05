// 曝險與區域表的「兩份複本不可走散」考題（夜班稽核第二批C，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢的最要緊發現之一：ETF 的區域組成表在**後端 `lib/derive.js`
// 與前端 `public/modules/portfolio-exposure.js` 各有一份**（前端不能 import lib/，所以是
// 刻意的複本、註解也寫明「改其一要改兩處」），但**零考題比對兩份**。
// 實測把後端的 KWEB 從「中國」改成「美國」，1487 題全綠——
// William 在投資原則 v1 拍板的**中國軟上限（預設 15%，超標＝提醒凍結加碼、不強制賣）就此無聲失效**，
// 而投組頁還照樣顯示中國曝險，兩邊數字對不起來也不會有紅燈。
//
// 這一檔用**行為級**比對（兩邊的 `compOf` 都真的呼叫），不是比對原始碼文字：
// 文字比對追不上等價改寫，而「兩邊對同一個代號回同一件事」才是真正的承重契約。
import test from 'node:test';
import assert from 'node:assert/strict';

import { compOf as feCompOf, fxExposure, COMPOSITION_SYMBOLS as FE_SYMBOLS } from '../public/modules/portfolio-exposure.js';
import { compOf as beCompOf, buildSummary, COMPOSITION_SYMBOLS as BE_SYMBOLS } from '../lib/derive.js';

/**
 * 代號清單＝**兩份正式表的真 union**（不手抄）。
 * ⚠️ 第一版我手抄了 22 個代號＝空包彈（Codex #409 r1 H① 抓到）：實際漏了 GOOGL／GOOG／TSLA／
 *    SPACEX／SPCX，還多寫一個兩邊都沒有的 MSFT ⇒ 單邊把 GOOGL 的區域改成中國、或單邊新增
 *    一個代號，六題照樣全綠——直接打穿「任一邊少一個鍵就轉紅」這個主承諾。
 *    改成兩邊各自 export 真實 key、這裡取聯集，**未來新增代號自動納入**。
 */
const SYMBOLS = [...new Set([...BE_SYMBOLS, ...FE_SYMBOLS])].sort();

test('區域表｜兩份 COMPOSITION 的「鍵集合」必須完全相等（單邊新增/刪除代號就紅）', () => {
  // 這一題與下一題分工：這裡守**集合**（有沒有多一個/少一個），下一題守**內容**（type 與權重）。
  assert.deepEqual([...BE_SYMBOLS].sort(), [...FE_SYMBOLS].sort(),
    '後端與前端的 COMPOSITION 收錄代號不一致——單邊新增一支 ETF 就會讓穿透計算兩邊打架');
  assert.ok(SYMBOLS.length >= 20, `union 至少該有 20 個代號（實際 ${SYMBOLS.length}）——清單被清空的話下面每一題都會變成空轉`);
});

test('區域表｜前後端兩份 COMPOSITION 對每一個代號回傳完全相同的 type 與區域權重', () => {
  // ⚠️ 這一題是「中國 15% 上限」等所有穿透規則的地基：兩份走散＝後端擋不到的東西前端照樣顯示，
  //    或反過來。夜班實測 27 個代號裡只有約 8 個被既有考題走到，其餘改型別或改權重全綠。
  for (const symbol of SYMBOLS) {
    const fe = feCompOf({ symbol, layer: 'core' });
    const be = beCompOf({ symbol, layer: 'core' });
    assert.equal(be.type, fe.type,
      `${symbol} 的資產型別兩邊不一致（後端 ${be.type}／前端 ${fe.type}）——`
      + '股債比與上限判斷會與畫面對不起來');
    assert.deepEqual(be.regions, fe.regions,
      `${symbol} 的區域權重兩邊不一致（後端 ${JSON.stringify(be.regions)}／`
      + `前端 ${JSON.stringify(fe.regions)}）——國家上限會無聲失效`);
  }
});

test('區域表｜未知代號的 fallback 也要兩邊一致（layer 決定型別、區域落「其他」）', () => {
  // 未知代號走 fallback：layer bond→bond、gold→gold、其餘→equity，區域一律「其他」。
  // 兩邊的 fallback 若不同，一檔沒收錄的新標的會在後端算成債、前端算成股。
  for (const layer of ['core', 'satellite', 'stock', 'bond', 'gold']) {
    const h = { symbol: 'NOT-IN-TABLE', layer };
    assert.deepEqual(beCompOf(h), feCompOf(h), `layer=${layer} 的 fallback 兩邊不一致`);
  }
});

test('區域表｜債與金的分類清單釘死（哪些代號算債、算金）', () => {
  // 型別直接決定股債比（ECY 動態 70:30↔90:10）與「債券不計入區域穿透」。
  // 這一題把清單釘住：把某支債改成股、或把黃金改成股，兩邊都會紅。
  const bonds = SYMBOLS.filter(s => beCompOf({ symbol: s, layer: 'core' }).type === 'bond').sort();
  const golds = SYMBOLS.filter(s => beCompOf({ symbol: s, layer: 'core' }).type === 'gold').sort();
  assert.deepEqual(bonds, ['00719B', '00720B'], '債券清單改了＝股債比會跟著變，要一起改這條考題');
  assert.deepEqual(golds, ['GLD', 'IAU', 'SGLD'], '黃金清單改了＝資產配置分層會跟著變');
});

test('幣別曝險｜00719B 與 00720B 兩支台幣交易的美元債 ETF 都要歸到美元桶', () => {
  // ⚠️ 契約 docs/contracts/investment-sec.md 逐字列出這兩支代號；既有考題只給 00719B，
  //    少一支的後果是 00720B 的美元曝險被記到 TWD 桶，幣別曝險表（分散度判斷的依據）默默偏掉。
  for (const symbol of ['00719B', '00720B']) {
    const ex = fxExposure([{ symbol, layer: 'bond', currency: 'TWD', valueTwd: 100000 }], [], {});
    assert.ok(ex.USD, `${symbol} 應該產生 USD 桶（台幣交易的美元債 ETF，曝險歸美元）`);
    assert.equal(ex.USD.bondTwd, 100000, `${symbol} 的金額要進 USD 桶的債券欄`);
    assert.ok(!ex.TWD || ex.TWD.bondTwd === 0,
      `${symbol} 不可留在 TWD 桶——那會讓幣別曝險表低估美元集中度`);
  }
});

test('幣別曝險｜四種負債型別的正數餘額都要變成「負的現金曝險」（方向不可反）', () => {
  // ⚠️ 註解自己寫明：「不兜住的話幣別曝險會把房貸當 +690 萬現金曝險，方向整個反掉（自主體檢實測）」。
  //    白名單有四個成員，既有考題只走到 loan 與 mortgage 兩個 ⇒ liability／creditcard 是白吃的：
  //    未來有人「清理」白名單或後端新增型別漏抄前端，方向反掉但全綠。
  for (const type of ['loan', 'liability', 'mortgage', 'creditcard']) {
    const ex = fxExposure([], [{ type, currency: 'TWD', balance: 6900000 }], {});
    assert.ok(ex.TWD, `type=${type} 應該產生 TWD 桶`);
    assert.equal(ex.TWD.cashTwd, -6900000,
      `type=${type} 的正數餘額是「欠出去的錢」，必須算成負的現金曝險`
      + '（算成正的＝房貸被當成 690 萬現金，分散度判斷整個反掉）');
  }
  // 反面：真正的現金帳戶要照樣是正的（避免整段被關掉也綠）。
  const cash = fxExposure([], [{ type: 'cash', currency: 'TWD', balance: 50000 }], {});
  assert.equal(cash.TWD.cashTwd, 50000, '現金帳戶要照樣算成正的現金曝險');
});

test('國家上限｜「其他」是殘差桶不是國家：不可冒出假的「其他超過國家上限」提醒', () => {
  // ⚠️ 投資原則 v1 明訂「各國曝險（穿透，美國與『其他』不設限）」。
  //    「其他」是 EIMI/XUSE 等 ETF 的殘差權重、不是一個國家；豁免拿掉之後會冒出一條
  //    「其他 xx%（超過國家上限，凍結加碼）」——把**不存在的規則違反**講給使用者聽，
  //    而使用者無法「減少對其他的曝險」（那不是一個可操作的標的）。國家上限本身有考題，這條豁免沒有。
  const db = {
    settings: { usdTwd: 1, countryCapPct: 15, chinaCapPct: 15 },   // 鍵名照 derive.js 的 riskCaps（寫錯鍵會退回預設值＝考題僥倖過）
    accounts: [], transactions: [], subscriptions: [],
    // XUSE 的區域權重全落「其他」；佔淨資產 100% ⇒ 遠超 15%
    holdings: [{ id: 'h1', symbol: 'XUSE', layer: 'core', currency: 'TWD', quantity: 1, price: 1000000, source: 'ib' }],
  };
  const keys = buildSummary(db).reminders.map((/** @type {any} */ r) => r.key);
  assert.ok(!keys.includes('conc-country-其他'),
    '「其他」是殘差桶、不設上限——冒出這條提醒＝把不存在的違規講給使用者聽');

  // 反面（避免整段豁免被關掉也綠）：真正的國家超標仍然要出現。
  const cn = {
    ...db,
    holdings: [{ id: 'h2', symbol: 'KWEB', layer: 'satellite', currency: 'TWD', quantity: 1, price: 1000000, source: 'ib' }],
  };
  const cnKeys = buildSummary(cn).reminders.map((/** @type {any} */ r) => r.key);
  assert.ok(cnKeys.includes('conc-country-中國'),
    'KWEB 全額中國、佔淨資產 100% ⇒ 中國上限提醒必須出現（這也順便釘住後端 KWEB 的區域是中國）');
});
