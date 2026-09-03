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
//
// 涵蓋**兩個**同步點（都是正式程式自己標明「改其一要改兩處」的複本）：
//   ① `COMPOSITION` 穿透表（`lib/derive.js` ↔ `public/modules/portfolio-exposure.js`）——
//      逐鍵比對＋動態探針＋非正規形，能守到什麼／守不到什麼見下方 `SYMBOLS` 的 docblock。
//   ② 負債型別白名單 `LIABILITY_TYPES`（後端 `lib/derive.js` ↔ 前端 `public/modules/accounts-model.js`）——
//      前端由 `fxExposure` 那題守、後端由 `buildSummary` 那題守；那兩題各釘「自己那一邊的四個成員」，
//      **單邊新增第五個型別**（後端多收 'carloan'、前端沒抄）由「成員必須一模一樣」＋「動態探針」
//      兩題守（#409 r7）。
//      ⚠️ **這一族有幾份複本，本檔刻意不寫數字**——寫下來的每一個數字都漂過：
//      原始註解寫「改其一要改兩處」，r5 補成「三處」（`lib/schema.js` 的 `FIELD_SCHEMA.accounts.type`
//      枚舉＝寫入牆），r8 Codex 又用實測打穿：前端當時還藏著**第四份**
//      （`public/modules/assets.js` 手寫的 `isLiab`，而且**已經漏掉 creditcard**——信用卡帳戶在
//      淨資產與幣別曝險都算負債，資產頁卻畫成藍標籤、餘額不標紅）與**第五份**（帳戶表單的型別選項，
//      漏掉 liability／creditcard ⇒ 使用者打開那種帳戶只改個名字按儲存，就靜靜 PUT `type:'cash'`，
//      50 萬負債變 50 萬資產）。
//      ⇒ r8 的處置分兩層，都不再依賴「記得改幾處」：
//        ・**收斂**：前端三份收成一份（`public/modules/accounts-model.js`），表單選項與資產頁的
//          負債判準都從那份 Set 長出來——不是抄，是讀同一個物件（動態探針題證明）。
//        ・**機械認定**：最後一題全站掃描 `public/` 與 `lib/`，只准三個宣告過的檔案出現這些型別字串
//          （擋不住什麼寫在那題自己的劃界裡）；另有「表單選項 == 寫入牆枚舉」與「幣別選項 == CURRENCIES」
//          兩題守住「存得進去的一定選得到」——這是上面那個 `type:'cash'` 靜靜改值的病根。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compOf as feCompOf, fxExposure, COMPOSITION as FE_TABLE } from '../public/modules/portfolio-exposure.js';
import { LIABILITY_TYPES as FE_LIABILITY, LIABILITY_TYPE_LABELS, accountTypeOptions, isLiabilityAccount, ACCOUNT_CURRENCIES } from '../public/modules/accounts-model.js';
import { compOf as beCompOf, buildSummary, COMPOSITION as BE_TABLE, LIABILITY_TYPES as BE_LIABILITY } from '../lib/derive.js';
import { sanitizeDbForWrite, FIELD_SCHEMA, CURRENCIES } from '../lib/schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 兩份白名單的聯集＝「這一族目前有哪些型別」的唯一來源（手抄清單就是空包彈，見上方 v1 的教訓）。 */
const LIABILITY_MEMBERS = [...new Set([...BE_LIABILITY, ...FE_LIABILITY])].sort();

/**
 * 代號清單＝**直接從 `compOf` 真正使用的那張表取鍵**（兩邊都 export 表本身）。
 * ⚠️ 這裡被 Codex 抓過兩次，兩次都是「中間層可以被繞過」：
 *    v1 我**手抄** 22 個代號 ⇒ 漏了 GOOGL／GOOG／TSLA／SPACEX／SPCX、還多寫一個兩邊都沒有的 MSFT
 *       ⇒ 單邊改 GOOGL 的區域照樣全綠（#409 r1 H①）。
 *    v2 改成兩邊各 export 一個 `COMPOSITION_SYMBOLS` **投影陣列** ⇒ 把那個 export 改成寫死的
 *       26 鍵陣列、再單邊往正式表新增 VT，兩邊 export 都聲稱沒有 VT ⇒ 又全綠（#409 r2 H①）。
 *    v3 改成**export 正式表本身**、考題自己 `Object.keys()` ⇒ 但比對的只是「已列舉鍵的內容」，
 *       `compOf` 改讀一份私表、export 留舊表，既有鍵答案相同就又全綠（#409 r4）。
 *    v4：補一題**動態探針**——往 export 表塞一個新代號，要求 `compOf` 立刻答得出它的內容。
 *       「export 的是不是 compOf 真正讀的那張表」（表身分）到這一步才真的被守住（v3 那招在探針題會紅）。
 *    v5（現在）：鍵拿對了、物件身分守住了，**餵進去的代號形狀**仍然全是正規形（`Object.keys` 出來的
 *       都是 trim 過的大寫），所以把 `compOf` 的 `normalizePortfolioSymbol` 拿掉照樣全綠（#409 r5）。
 *       ⇒ 每一處餵代號的地方都改成同時餵 `sym` / `sym.toLowerCase()` / ` sym `（見下方 `formsOf`）。
 * ⚠️ 這句話的**邊界**（#409 r3 收窄過一次，r4、r5 各再收窄一次；之前寫成「沒有中間層可以說謊」是 overclaim）：
 *    下面三題各守一段，合起來能守到什麼、守不到什麼要講清楚——
 *    ①「逐鍵比對」題只證明：**對 export 表目前可列舉的每一個鍵**（且含其非正規形），
 *       `compOf` 的答案不與 export 值走散。
 *       它**證明不了表身分**——`compOf` 若改讀一份私表、export 留舊表，既有鍵答案相同就照樣全綠（r4 指出的洞）。
 *    ②「動態探針」題補上表身分：往 export 表塞一個原本不存在的代號，`compOf` 必須立刻答得出它的內容。
 *       私表＋舊 export 這招在這裡會紅（探針鍵只寫進 export 表，讀私表的 `compOf` 找不到）。
 *       ⚠️ 探針比的是**內容**（deepEqual）不是**參考**（strictEqual）：要守的是「讀的是這張表」，
 *          不是「不准複製回傳值」；理由與重放證據寫在該題內文（#409 r5）。
 *    ③「非正規形」（`formsOf`）補上代號身分：同一支標的的大小寫／前後空白必須回同一件事，
 *       兩邊都要。少了正規化的那一邊會退回 fallback ⇒ 逐鍵題、be/fe 對照題、最後一題的 reminder 都會紅。
 *    三題合起來仍**擋不住**的是「`compOf` 在 export 表之外**多認得**的代號」：
 *    私表兜底（`PRIVATE[s] || COMPOSITION[s]`，探針鍵仍能從 export 表命中所以照樣綠）、
 *    `enumerable: false` 定義的鍵、Proxy 的 `ownKeys` 藏鍵——這些 `Object.keys()` 走不到，逐鍵比對就走不到。
 *    另外要講清楚**誰守誰**（實測，不是推測）：正規化被拿掉時，紅的是①逐鍵題與最後一題（走 buildSummary），
 *    「be/fe 對照題」只在**單邊**被拿掉時會紅；`normalizePortfolioSymbol` 本身被閹掉（拿掉 `.trim()`
 *    或 `.toUpperCase()`）時兩邊一起退回 fallback、對照題照樣綠——所以對照題不是這顆突變的守門人，①才是。
 *    真要封死得把兩份表收斂成單一共用來源（＝改正式資料流，非本支範圍）。
 */
const BE_SYMBOLS = Object.keys(BE_TABLE);
const FE_SYMBOLS = Object.keys(FE_TABLE);
const SYMBOLS = [...new Set([...BE_SYMBOLS, ...FE_SYMBOLS])].sort();

/**
 * 同一個代號的「非正規形」：小寫、前後帶空白、**以及兩者的組合**。
 * ⚠️ 這不是假想輸入——`public/modules/portfolio-symbol.js` 開宗明義寫「前後空白不屬於代號、
 *    大小寫也不應拆成不同標的」，`test/derive-reminders.test.js` 也已釘死 `' tsla '` 這種真實資料形狀。
 * ⚠️ 為什麼非有不可（#409 r5 的實測）：本檔原本只餵正規形（SYMBOLS 全來自 `Object.keys`），
 *    於是把 `lib/derive.js` 的 `COMPOSITION[normalizePortfolioSymbol(h.symbol)]` 改成 `COMPOSITION[h.symbol]`，
 *    本檔 9 題與全套 1496 題**靜靜全綠**；而同一份 db 走 `buildSummary`、holding 的 symbol 是 `' kweb '` 時，
 *    後端回 `{其他:1}`、前端回 `{中國:1}`，`conc-country-中國` 整條消失——
 *    正是本檔開頭宣稱要治的那個病（兩邊對同一個代號答不一樣、中國軟上限無聲失效）。
 * ⚠️ **「小寫＋空白」那一種非有不可**（#409 r5 Codex 實測，r6 補上）：只有「小寫」與「大寫加空白」兩種時，
 *    把 `fxExposure` 的 `exposureCurrency` 改成「沒有空白才 `.toUpperCase()`、有空白只 `.trim()`」，
 *    三種形狀全部照樣正確 ⇒ 本檔與全套仍全綠，但 `' 00719b '`（使用者手打／匯入真的長這樣，
 *    小寫又前後帶空白）會落進 TWD 桶、美元曝險被低估。
 *    正規化是 trim 與大寫**兩件事**，只餵「各缺一半」的形狀就測不到「兩件事都要做」。
 * @param {string} sym
 */
const formsOf = (sym) => [...new Set([sym, sym.toLowerCase(), ` ${sym} `, ` ${sym.toLowerCase()} `])];

test('區域表｜export 表可列舉的每個鍵（含大小寫／前後空白的非正規形），compOf 的答案都不可與 export 值走散', () => {
  // ⚠️ 這一題防的是「export 一份內容已經走散的複本」（#409 r2 H① 的病）：對表裡的每一個鍵，
  //    compOf 回傳的內容必須與表內容逐一相等。
  //    界線（r4）：這裡**只**證明「已列舉鍵的內容相等」，不證明物件身分——物件身分由下一題的探針守。
  //    r5 補上代號形狀：正規形與非正規形都要回同一件事，任一邊少了 normalizePortfolioSymbol 就會紅
  //    （非正規形查不到 ⇒ 退回 fallback ⇒ 與 export 值不相等）。
  for (const [table, compOf, side] of /** @type {const} */ ([
    [BE_TABLE, beCompOf, '後端'], [FE_TABLE, feCompOf, '前端'],
  ])) {
    for (const sym of Object.keys(table)) {
      for (const form of formsOf(sym)) {
        assert.deepEqual(compOf({ symbol: form, layer: 'core' }), /** @type {any} */ (table)[sym],
          `${side}：export 的表與 compOf 對 ${JSON.stringify(form)} 的答案不一致——`
          + 'export 的一定要是 compOf 讀的那張表，而且代號要先正規化（前後空白與大小寫不是不同標的）');
      }
    }
  }
});

test('區域表｜動態探針：往 export 表新增一個代號，compOf 必須立刻讀到它（表身分）', () => {
  // ⚠️ 這一題專治 #409 r4 點名的繞法：「compOf 改讀一份模組內私表、export 留舊表」——
  //    既有鍵的答案一模一樣，所以上一題的逐鍵比對抓不到。
  //    探針做法：把一個**正式資料裡不會出現**的代號寫進 export 表，再問 compOf。
  //    export 表若不是 compOf 真正讀的那張表，compOf 找不到這個鍵 ⇒ 走 fallback ⇒ 這裡紅。
  //    界線：這證明的是「export 表在 compOf 的讀取路徑上，且探針鍵沒被別處遮蔽」；
  //    不證明「compOf 沒有在 export 表之外多認得別的代號」（私表兜底／不可列舉鍵／Proxy 藏鍵，見檔頭）。
  const PROBE = '__PROBE_NOT_A_REAL_SYMBOL__';   // normalizePortfolioSymbol 只做 trim+大寫，這串原樣通過
  for (const [table, compOf, side] of /** @type {const} */ ([
    [BE_TABLE, beCompOf, '後端'], [FE_TABLE, feCompOf, '前端'],
  ])) {
    const t = /** @type {Record<string, any>} */ (table);
    const before = Object.keys(t).sort();
    assert.ok(!(PROBE in t), `${side}：探針代號不該事先存在（測試自己髒了）`);
    // 探針的內容刻意與 fallback（equity／{其他:1}）完全不同，compOf 沒讀到它就一定對不上。
    // ⚠️ 用 deepEqual 不用 strictEqual（#409 r5 Codex 指出，本輪改）：這一題要守的是
    //    「compOf 讀的是**這張** export 表」，不是「compOf 不准複製回傳值」。
    //    ①deepEqual 仍守得住 r4 那顆繞法——私表是模組載入時就複製好的，**測試執行期**才塞進去的
    //      探針鍵不會出現在裡面，compOf 退回 fallback ⇒ 照樣紅（本輪重放確認）。
    //    ②strictEqual 額外要求「回傳同一個參考」，那是實作細節不是使用者行為契約：
    //      所有正式呼叫端（regionExposure／fxExposure／companyExposure／derive 的 computeAssets）
    //      都只讀 type/regions。將來 compOf 若改成回傳防禦性副本（避免呼叫端誤改共用表），
    //      行為完全沒變卻會被這題擋下＝假紅。假紅會讓下一個人「為了讓考題過」而放棄正確的寫法。
    const probe = { type: 'bond', regions: { 探針國: 1 } };
    try {
      t[PROBE] = probe;
      assert.deepEqual(compOf({ symbol: PROBE, layer: 'core' }), probe,
        `${side}：往 export 的 COMPOSITION 新增代號後 compOf 看不到 ⇒ compOf 讀的是另一份表（私表／複本），`
        + '兩份表的比對會全部落空——export 的必須是 compOf 真正讀的那個物件');
    } finally {
      delete t[PROBE];   // 不可污染同檔其他考題（SYMBOLS 在模組載入時就算好了，但表本身是共用的）
    }
    assert.deepEqual(Object.keys(t).sort(), before, `${side}：探針沒還原乾淨——後面的考題會被污染`);
    assert.deepEqual(compOf({ symbol: PROBE, layer: 'core' }), { type: 'equity', regions: { 其他: 1 } },
      `${side}：探針還原後應該退回未知代號的 fallback`);
  }
});

test('區域表｜兩份 COMPOSITION 的「鍵集合」必須完全相等（單邊新增/刪除代號就紅）', () => {
  // 這一題與下一題分工：這裡守**集合**（有沒有多一個/少一個），下一題守**內容**（type 與權重）。
  assert.deepEqual([...BE_SYMBOLS].sort(), [...FE_SYMBOLS].sort(),
    '後端與前端的 COMPOSITION 收錄代號不一致——單邊新增一支 ETF 就會讓穿透計算兩邊打架');
  assert.ok(SYMBOLS.length >= 20, `union 至少該有 20 個代號（實際 ${SYMBOLS.length}）——清單被清空的話下面每一題都會變成空轉`);
});

test('區域表｜前後端兩份 COMPOSITION 對每一個代號回傳完全相同的 type 與區域權重', () => {
  // ⚠️ 這一題是「中國 15% 上限」等所有穿透規則的地基：兩份走散＝後端擋不到的東西前端照樣顯示，
  //    或反過來。夜班實測 27 個代號裡只有約 8 個被既有考題走到，其餘改型別或改權重全綠。
  // r5：連非正規形一起對照——單邊拿掉 normalizePortfolioSymbol 時，
  //     ' kweb ' 在後端變「其他」、前端仍是「中國」，正是「兩邊對同一個代號答不一樣」的原形。
  for (const symbol of SYMBOLS) {
    for (const form of formsOf(symbol)) {
      const fe = feCompOf({ symbol: form, layer: 'core' });
      const be = beCompOf({ symbol: form, layer: 'core' });
      assert.equal(be.type, fe.type,
        `${JSON.stringify(form)} 的資產型別兩邊不一致（後端 ${be.type}／前端 ${fe.type}）——`
        + '股債比與上限判斷會與畫面對不起來');
      assert.deepEqual(be.regions, fe.regions,
        `${JSON.stringify(form)} 的區域權重兩邊不一致（後端 ${JSON.stringify(be.regions)}／`
        + `前端 ${JSON.stringify(fe.regions)}）——國家上限會無聲失效`);
    }
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

test('區域表｜帶中國曝險的代號與權重釘死（中國軟上限的地基）', () => {
  // ⚠️ 這一題補的是 #409 minor②：最後一題只**順便**釘住 KWEB（KWEB→美國 會紅），
  //    ICHN 與 EIMI 的中國權重原本不在任何斷言裡。實測把 ICHN 的 { 中國: 1 } **前後端同步**改成
  //    { 美國: 1 }（＝維護註解教的「兩處一起改」正確做法，所以上面每一條「兩邊相等」都照樣綠），
  //    全套 1496 題全綠——而「美國」是國家上限的豁免區，中國曝險與中國軟上限
  //    （投資原則 v1 預設 15%：超標＝提醒凍結加碼、不強制賣）就此無聲蒸發。EIMI 的 中國:0.25 改 0 同理。
  //    分工同「債與金清單」那題：這裡走後端取值，前端由「兩份 COMPOSITION 逐一相等」那題連坐。
  /** @type {Record<string, number>} */
  const china = {};
  for (const symbol of SYMBOLS) {
    const weight = beCompOf({ symbol, layer: 'core' }).regions['中國'] || 0;
    if (weight > 0) china[symbol] = weight;
  }
  assert.deepEqual(china, { EIMI: 0.25, ICHN: 1, KWEB: 1 },
    '帶中國曝險的代號或權重改了＝中國軟上限跟著變（權重歸零或改到豁免區＝上限無聲失效），要一起改這條考題');
});

test('幣別曝險｜00719B 與 00720B 兩支台幣交易的美元債 ETF 都要歸到美元桶（含非正規形）', () => {
  // ⚠️ 逐字列出這兩支代號的是 **AGENTS.md 的同步點清單**（「`portfolio-exposure.js` `fxExposure`
  //    寫死的台幣掛牌美債 ETF 清單（00719B/00720B）」那一列，另見台股報價那條）——
  //    本題原本寫成「契約 docs/contracts/investment-sec.md 逐字列出」，那是引錯檔案：
  //    docs/ 底下 grep 不到 00719B／00720B 任何一次（#409 minor④）。
  //    既有考題只給 00719B，少一支的後果是 00720B 的美元曝險被記到 TWD 桶，
  //    幣別曝險表（分散度判斷的依據）默默偏掉。
  // ⚠️ 代號同時走非正規形（#409 minor①）：`fxExposure` 的 `exposureCurrency` **自己也做一次**
  //    `normalizePortfolioSymbol`，是這一族的第二個落點（第一個是 `compOf`）。只餵大寫代號時，
  //    把那裡改成 `String(r.symbol || '')` 全套仍全綠——而使用者手打／匯入的 ' 00719b ' 就會退回
  //    `r.currency`＝TWD 桶，正是上一段講的「幣別曝險表默默偏掉」。
  for (const symbol of ['00719B', '00720B']) {
    for (const form of formsOf(symbol)) {
      const ex = fxExposure([{ symbol: form, layer: 'bond', currency: 'TWD', valueTwd: 100000 }], [], {});
      assert.ok(ex.USD, `${JSON.stringify(form)} 應該產生 USD 桶（台幣交易的美元債 ETF，曝險歸美元）`);
      assert.equal(ex.USD.bondTwd, 100000, `${JSON.stringify(form)} 的金額要進 USD 桶的債券欄`);
      assert.ok(!ex.TWD || ex.TWD.bondTwd === 0,
        `${JSON.stringify(form)} 不可留在 TWD 桶——那會讓幣別曝險表低估美元集中度`);
    }
  }
});

test('幣別曝險｜四種負債型別的正數餘額都要變成「負的現金曝險」（方向不可反）', () => {
  // ⚠️ 註解自己寫明：「不兜住的話幣別曝險會把房貸當 +690 萬現金曝險，方向整個反掉（自主體檢實測）」。
  //    白名單有四個成員，既有考題只走到 loan 與 mortgage 兩個 ⇒ liability／creditcard 是白吃的：
  //    未來有人「清理」前端這份白名單，方向反掉但全綠。
  // ⚠️ 這一題只碰**前端**那份白名單（#409 minor③ 的修正）：前端的單一真相是
  //    `public/modules/accounts-model.js` 的 LIABILITY_TYPES（`portfolio-exposure.js` 讀它、
  //    帳戶表單與資產頁也讀它），與 `lib/derive.js` 是同步點；本題整題只呼叫 `fxExposure`，
  //    碰不到後端那份——後端那半由下一題（走 `buildSummary`）守，兩題合起來的劃界寫在下一題。
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

test('淨資產｜四種負債型別的正數餘額在後端也要算成負債（LIABILITY_TYPES 同步點的另一半）', () => {
  // ⚠️ 這一題補的是 #409 minor③：上一題的註解把「後端新增型別漏抄前端」列為它要治的病，
  //    但整題只呼叫前端 `fxExposure`，碰不到 `lib/derive.js` 的那份 LIABILITY_TYPES。
  //    實測後端那份被「清理」成 new Set(['loan','mortgage']) 之後：type='creditcard'、balance=+500000
  //    的帳戶在後端算成 assets=500000／netWorth=+500000（負債 0），前端同一筆算 cashTwd=−500000
  //    ——淨資產與幣別曝險表方向相反，而全套 1496 題照樣全綠。
  // ⚠️ 餘額為什麼一定要填**正數**：後端的判斷是「型別在白名單 || 餘額<0」，負數餘額走的是後半段，
  //    白名單被清空也照樣綠——`test/derive.test.js` 既有那題用的就是 balance:-300，走不到白名單。
  // ⚠️ 劃界（這兩題各自的界線）：這兩題釘死的都只是「自己那一邊的這四個成員」，
  //    所以「單邊**新增**第五個型別」（例如後端多收 'carloan'、前端沒抄）在**這兩題**不會紅——
  //    那顆突變由下面「兩份白名單成員必須一模一樣」與「動態探針」兩題守（作法與 COMPOSITION 同一招：
  //    兩邊 export 正式判準本身＋比對集合＋動態探針，#409 r7 補上）。
  for (const type of ['loan', 'liability', 'mortgage', 'creditcard']) {
    const db = /** @type {any} */ ({
      settings: { usdTwd: 1 }, transactions: [], subscriptions: [], holdings: [],
      accounts: [{ id: 'a1', name: '負債帳戶', type, currency: 'TWD', balance: 500000 }],
    });
    const s = buildSummary(db);
    assert.equal(s.liabilities, 500000, `type=${type} 的正數餘額是「欠出去的錢」，後端必須算成負債`);
    assert.equal(s.assets, 0, `type=${type} 不可被當成資產計入——那會讓淨資產憑空多出一整筆`);
    assert.equal(s.netWorth, -500000,
      `type=${type} 的方向算反時淨資產會從 −50 萬翻成 +50 萬`
      + '（同一筆帳戶前端 fxExposure 算 −50 萬現金曝險，兩邊對不起來也沒有紅燈）');
  }
  // 反面：真正的現金帳戶要照樣算成資產（避免整段白名單被關掉也綠）。
  const cash = /** @type {any} */ ({
    settings: { usdTwd: 1 }, transactions: [], subscriptions: [], holdings: [],
    accounts: [{ id: 'a2', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 50000 }],
  });
  assert.equal(buildSummary(cash).netWorth, 50000, '現金帳戶要照樣算成正的資產');
});

test('負債白名單｜兩份 LIABILITY_TYPES 的成員必須一模一樣（單邊新增第五個型別要紅）', () => {
  // ⚠️ 這一題補的是 #409 r6 留下的洞：上面兩題各釘各的四個成員，
  //    「單邊**新增**」（後端多收 'carloan'、前端沒抄）兩邊都不會紅，全套 1498 題靜靜全綠（實測）。
  //    那顆突變的實害：房貸型的新型別在後端算負債（淨資產 −），前端 fxExposure 不認得 ⇒ 算成 + 現金曝險，
  //    兩張表方向相反而沒有紅燈——與 COMPOSITION 走散是同一個病。
  //    作法也與 COMPOSITION 同一招：兩邊 export 正式判準本身（不是投影陣列），考題比對集合。
  //    界線：這裡只證明「兩份 export 的成員相同」，不證明它們就是正式程式讀的那兩個物件——
  //    物件身分由下一題的動態探針守。
  assert.deepEqual([...BE_LIABILITY].sort(), [...FE_LIABILITY].sort(),
    '後端 lib/derive.js 與前端 public/modules/accounts-model.js 的 LIABILITY_TYPES 走散了——'
    + '這是正式程式自己標明的同步點（前端不能 import lib/，所以後端那份仍是刻意的複本），'
    + '只改一邊會讓淨資產與幣別曝險表方向相反');
  // 反面：白名單不可以被整個清空也綠（空集合彼此相等）。
  assert.ok(BE_LIABILITY.size >= 4, '白名單被清空／縮編時上面那句相等就成了空話');
});

test('負債白名單｜動態探針：往兩份 export 的 Set 各塞一個型別，正式程式必須立刻當成負債（物件身分）', () => {
  // ⚠️ 專治「export 一份複本、正式程式讀另一份」的繞法（COMPOSITION 那邊 #409 r4 已踩過一次）：
  //    成員比對題對複本照樣綠，探針題才會紅（探針型別只寫進 export 的 Set，讀私表的那邊不認得）。
  //    界線：這證明的是「export 的 Set 在 fxExposure／computeAssets／帳戶表單／資產頁四條讀取路徑上」，
  //    不證明「正式程式沒有在這兩個 Set 之外多認得別的型別」（另一份兜底判斷、正則比對等抓不到）。
  // ⚠️ r8 加測前端另外兩條路徑（`accountTypeOptions()` 與 `isLiabilityAccount()`）：它們原本是
  //    `public/modules/assets.js` 裡的兩份手抄複本，改回手抄之後這一題就會紅
  //    （手抄的清單不會因為 Set 多一個成員而長出探針型別）。
  const PROBE = '__PROBE_NOT_A_REAL_ACCOUNT_TYPE__';
  const beBefore = [...BE_LIABILITY].sort();
  const feBefore = [...FE_LIABILITY].sort();
  assert.ok(!BE_LIABILITY.has(PROBE) && !FE_LIABILITY.has(PROBE), '探針型別不該事先存在（測試自己髒了）');
  /** @param {number} balance */
  const beNetWorth = (balance) => buildSummary(/** @type {any} */ ({
    settings: { usdTwd: 1 }, transactions: [], subscriptions: [], holdings: [],
    accounts: [{ id: 'p1', name: '探針帳戶', type: PROBE, currency: 'TWD', balance }],
  })).netWorth;
  /** @param {number} balance */
  const feCashTwd = (balance) => fxExposure([], [{ type: PROBE, currency: 'TWD', balance }], {}).TWD.cashTwd;
  try {
    BE_LIABILITY.add(PROBE);
    FE_LIABILITY.add(PROBE);
    assert.equal(beNetWorth(100), -100,
      '往後端 export 的 LIABILITY_TYPES 加型別後 computeAssets 沒當成負債 ⇒ 它讀的是另一份 Set（複本），'
      + '成員比對題會整個落空——export 的必須是正式程式真正讀的那個物件');
    assert.equal(feCashTwd(100), -100,
      '往前端 export 的 LIABILITY_TYPES 加型別後 fxExposure 沒翻成負的現金曝險 ⇒ 同上，它讀的是另一份 Set');
    assert.ok(accountTypeOptions().some(o => o.value === PROBE),
      '往前端 LIABILITY_TYPES 加型別後，帳戶表單的型別下拉沒長出它 ⇒ 選項是另一份手抄清單。'
      + '後果：那種帳戶存得進資料庫卻選不到，只能靠改資料庫才設得上去'
      + '（#409 之後現值至少不會再被靜靜改成 cash，但「選不到」這一半還在）');
    assert.equal(isLiabilityAccount({ type: PROBE, balance: 500000 }), true,
      '往前端 LIABILITY_TYPES 加型別後，資產頁的 isLiabilityAccount 不認得它 ⇒ 它讀的是另一份手抄清單，'
      + '那種帳戶會被畫成藍標籤、餘額不標紅（畫面與淨資產說法相反）');
  } finally {
    BE_LIABILITY.delete(PROBE);
    FE_LIABILITY.delete(PROBE);
  }
  assert.deepEqual([...BE_LIABILITY].sort(), beBefore, '後端探針沒還原乾淨——後面的考題會被污染');
  assert.deepEqual([...FE_LIABILITY].sort(), feBefore, '前端探針沒還原乾淨——後面的考題會被污染');
  // 反面：還原之後探針型別要退回「普通帳戶」（正數餘額＝資產／正的現金曝險），
  // 否則上面兩個 −100 可能只是「什麼型別都算負債」而不是白名單真的生效。
  assert.equal(beNetWorth(100), 100, '探針還原後，未知型別的正數餘額應該退回資產');
  assert.equal(feCashTwd(100), 100, '探針還原後，未知型別的正數餘額應該退回正的現金曝險');
  assert.ok(!accountTypeOptions().some(o => o.value === PROBE), '探針還原後，型別下拉不該還留著它');
  assert.equal(isLiabilityAccount({ type: PROBE, balance: 500000 }), false,
    '探針還原後，未知型別的正數餘額在資產頁應該退回「不是負債」——'
    + '否則上面那個 true 只是「什麼型別都算負債」，白名單根本沒生效');
});

test('負債白名單｜每個成員都要過得了寫入牆（lib/schema.js 的 accounts.type 枚舉）——算得出來還要存得進去', () => {
  // ⚠️ 這一題補的是 #409 r5 Codex 指出的洞：上面每一題都停在**計算層**（`buildSummary`／`fxExposure`），
  //    證明的是「算出來的方向對」。但使用者真正按下儲存時，帳戶得先過 `lib/schema.js` 的櫃檯
  //    `sanitizeDbForWrite`，而 `FIELD_SCHEMA.accounts.type` 是**枚舉**、那行註解自己寫明
  //    「合法值＝表單的型別選項…」——**那是同一件事的另一份複本**（r5 當時寫「第三份」，
  //    r8 發現不只，所以本檔已改成不數數，見檔頭）。
  // ⚠️ 實測（r7 逐字重放 Codex 的繞法）：前後端兩份 Set **同步**加入 'carloan'（＝維護註解教的
  //    正確做法），本檔上面每一題含成員比對與動態探針**全綠**；
  //    但同一個帳戶送進 `sanitizeDbForWrite` 就過不去：throw 模式（HOSTED 寫入，`lib/store-pg.js`）
  //    炸「accounts[0].type 值不合法」＝根本寫不進去；strip 模式（LOCAL 讀檔／還原，`lib/store.js`）
  //    **默默把 type 剝掉**，帳戶變成無型別 ⇒ 正數餘額落到 computeAssets 的 else 分支＝當成資產
  //    （實測：50 萬負債算成 netWorth +500000，方向整個翻過去）。
  //    「中間層一致、正式入口不一致」比兩邊走散更難發現，因為畫面上算得出來。
  const MEMBERS = LIABILITY_MEMBERS;
  /** @param {string} type */
  const dbWith = (type) => /** @type {any} */ ({
    settings: { usdTwd: 1 },
    accounts: [{ id: 'w1', name: '負債帳戶', type, currency: 'TWD', balance: 500000 }],
  });
  for (const type of MEMBERS) {
    assert.doesNotThrow(() => sanitizeDbForWrite(dbWith(type), { mode: 'throw' }),
      `type='${type}' 是 LIABILITY_TYPES 的成員，卻過不了 lib/schema.js 的寫入牆——`
      + 'FIELD_SCHEMA.accounts.type 的枚舉沒跟著加，這個型別算得出負債卻存不進資料庫');
    for (const mode of /** @type {const} */ (['throw', 'strip'])) {
      const out = sanitizeDbForWrite(dbWith(type), { mode });
      assert.equal(out.accounts[0].type, type,
        `type='${type}' 在櫃檯 ${mode} 模式被剝掉了——`
        + '無型別的帳戶在 derive 會退回「不是負債」，正數餘額當場翻成資產（淨資產方向相反）');
    }
  }
  // 反面①：枚舉若被整個拿掉（或改成自由字串），上面那圈就成了空話——壞值必須照樣被擋。
  assert.throws(() => sanitizeDbForWrite(dbWith('mortgagex'), { mode: 'throw' }), /accounts\[0\]\.type/,
    'accounts.type 不再是枚舉了——錯值（mortgagex）會讓負債被當資產，這是寫入牆存在的理由');
  // 反面②：白名單被清空時上面那圈會空轉（零次迴圈也「全過」）。
  assert.ok(MEMBERS.length >= 4, `LIABILITY_TYPES 至少該有 4 個成員（實際 ${MEMBERS.length}）——清空的話這題就變成空轉`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 以下五題＝#409 r8 補的「前端那一半」。上面每一題都在證明「算得出負債」，
// Codex r8 用兩條實測繞法指出還缺兩件事：**選得到**（存得進資料庫的型別要在表單裡選得到）
// 與**畫得對**（資產頁的橘標籤與紅字要跟淨資產同一個口徑）。
// 這兩件事原本各有一份手抄複本住在 `public/modules/assets.js`，零考題看著——
// 把 `isLiab` 改成 `['loan']`（連房貸都不算負債）全套 1501 題全綠，就是那個洞的樣子。
//
// ⚠️ **這五題守的範圍到哪裡為止（別讀成「這個病全站治好了」）**：
//   ・**病根那一刀已經補上了**（#409；本段原本寫「本支沒有動那一刀」，那句話現在會誤導）：
//     `openForm` 產生選項的職責搬進零 DOM 的 `public/modules/form-options.js`——現在的值不在選項裡時
//     **保留它並標 selected**，不再被瀏覽器靜靜換成第一項。行為級考題＝`test/form-options.test.js`。
//   ・**但下面五題沒有因此變成多餘**，兩層守的是不同的事：保留只擋住「值被靜靜改掉」，
//     使用者仍然**選不到**那些型別／幣別（要設上去只能改資料庫），而且保留下來的那一項顯示的是
//     資料裡的原始代碼＋通用提示，不是「房貸（負債）」這種看得懂的中文標籤。
//   ・本檔仍只保證**帳戶表單的型別與幣別兩個下拉**與枚舉精確相等——`accounts-model.js` 是純模組、
//     import 得進來。別的表單（`public/modules/portfolio-forms.js` 的 `PORTFOLIO_CURRENCIES`、
//     `subscriptions.js` 的 cycle／status 選項…）**沒有**這種「選項 == 枚舉」的考題，這裡不假裝有：
//     它們現在只有 `form-options.js` 那一層通用保護（值不會被靜靜改掉，但仍可能選不到）。
// ──────────────────────────────────────────────────────────────────────────────

test('帳戶表單｜型別下拉的選項值必須與寫入牆枚舉（lib/schema.js 的 accounts.type）精確相等', () => {
  // ⚠️ 這一題治的是 Codex r8 抓到的**活著的病**：`liability` 與 `creditcard` 都是合法的
  //    accounts.type（枚舉有、LIABILITY_TYPES 也有），卻不在帳戶表單的七個選項裡。
  //    當時 `public/app.js` 的下拉只在值完全相同時才加 `selected`、送出時讀 `select.value`——
  //    沒有 option 命中時瀏覽器選第一個（`cash`）⇒ 在資產頁打開這種帳戶、只改個名字按儲存，
  //    就靜靜 PUT `type:'cash'`：50 萬負債變成 50 萬資產，淨資產一次跳 100 萬。
  //    ⚠️ 那個「靜靜換成第一項」的機制已於 #409 修掉（見上方劃界）；**本題守的是另一半**：
  //    存得進資料庫的型別，使用者要在下拉裡選得到。
  // ⚠️ 為什麼是**精確相等**而不是「選項 ⊇ 枚舉」：兩個方向各有一種病。
  //    枚舉有、表單沒有＝那種型別選不到（只能改資料庫）；表單有、枚舉沒有＝使用者選得到卻存不進去
  //    （HOSTED throw 當場報錯、LOCAL strip 默默把 type 剝掉 ⇒ 又變成資產）。
  const enumValues = /** @type {string[]} */ (FIELD_SCHEMA.accounts.type);
  assert.ok(Array.isArray(enumValues),
    'FIELD_SCHEMA.accounts.type 不再是枚舉了（改成自由字串）——那樣壞值也存得進去，這題與寫入牆那題都成了空話');
  assert.deepEqual(accountTypeOptions().map(o => o.value).sort(), [...enumValues].sort(),
    '帳戶表單的型別選項與 lib/schema.js 的寫入牆枚舉對不起來——'
    + '枚舉有而表單沒有的型別，使用者根本選不到（只能靠改資料庫設上去；'
    + '#409 之後既有帳戶的現值會被保留、不再靜靜翻成資產，但下拉裡看到的是原始代碼不是中文標籤）；'
    + '表單有而枚舉沒有的型別則是選得到卻存不進去');
});

test('帳戶表單｜每個負債型別都要選得到，而且要有中文標籤', () => {
  // 上一題已釘死「選項 == 枚舉」，這一題釘的是另一半：**枚舉本身不可以漏掉負債型別**
  //（兩題合起來＝每個 LIABILITY_TYPES 成員都選得到）。少了標籤不會讓人選不到，
  // 但下拉會露出英文代碼（`carloan`），所以標籤只釘「有沒有人幫新型別寫中文」。
  const options = accountTypeOptions();
  for (const type of LIABILITY_MEMBERS) {
    const opt = options.find(o => o.value === type);
    assert.ok(opt, `負債型別 '${type}' 在帳戶表單的型別下拉裡選不到——`
      + '它算得出負債、也存得進資料庫，卻只能靠改資料庫才設得上去；'
      + '而既有的這種帳戶雖然值會被保留（#409），下拉裡也只看得到原始代碼、不是中文標籤');
    assert.ok(/負債/.test(opt.label), `'${type}' 的選項標籤「${opt.label}」看不出是負債——`
      + '使用者要在下拉裡分得出「這一項填了會變成負的」');
  }
  assert.deepEqual(Object.keys(LIABILITY_TYPE_LABELS).sort(), [...LIABILITY_MEMBERS].sort(),
    'LIABILITY_TYPE_LABELS 的鍵與負債白名單走散了——'
    + '多的是刪型別忘了刪標籤（死程式），少的是新型別沒人寫中文（下拉露出英文代碼）');
  // 反面：資產型別不可以被吃掉（只剩負債選項時上面每一句都還是成立）。
  for (const type of ['cash', 'investment']) {
    assert.ok(options.some(o => o.value === type), `資產型別 '${type}' 從下拉消失了`);
  }
});

test('資產頁｜每個負債型別的正數餘額都要被畫成負債（isLiabilityAccount 與淨資產同口徑）', () => {
  // ⚠️ 這一題直接對著 Codex r8 的重放繞法：`public/modules/assets.js` 原本自己寫
  //    `['mortgage','loan','liability'].includes(x.type) || Number(x.balance) < 0`——
  //    **已經漏掉 creditcard**，把它再縮成只剩房貸以外的一項，全套 1501 題照樣全綠。
  //    實害不是計算錯（淨資產走 derive、幣別曝險走 fxExposure，兩邊都對），而是**畫面說反話**：
  //    信用卡／其他負債帳戶在資產頁掛藍標籤、餘額不標紅，看起來像資產。
  //    現在判準已收斂到 accounts-model 的同一份 Set，這題是行為級的看門人。
  for (const type of LIABILITY_MEMBERS) {
    assert.equal(isLiabilityAccount({ type, balance: 500000 }), true,
      `type='${type}'、餘額 +50 萬（負債帳戶填正數是允許的資料形狀）在資產頁沒被當成負債——`
      + '同一筆在淨資產是 −50 萬、在幣別曝險是 −50 萬現金曝險，只有畫面說它是資產');
  }
  // 反面①：一般帳戶的正數餘額不是負債（否則上面整圈只是「什麼都算負債」）。
  assert.equal(isLiabilityAccount({ type: 'cash', balance: 50000 }), false, '現金帳戶的正數餘額不是負債');
  // 反面②：餘額為負一律算負債（與 derive 的 `白名單 || bal < 0` 同口徑；只留白名單那一半會漏掉透支帳戶）。
  assert.equal(isLiabilityAccount({ type: 'cash', balance: -300 }), true, '餘額是負的就是負債，與型別無關');
});

test('帳戶表單｜幣別下拉的選項必須與 lib/schema.js 的 CURRENCIES 精確相等', () => {
  // 同一族的第三個下拉（病因與型別下拉完全相同，只是走樣的是匯率不是方向）：
  // 枚舉多一個幣別而表單沒有 ⇒ 使用者根本選不到那個幣別；#409 之前更糟——既有的那種帳戶
  // 一被打開儲存就靜靜變成第一個選項 TWD，之後每次換算都用錯匯率（100 USD 變 100 TWD）。
  // 現值靜靜被換掉那一半已由 `public/modules/form-options.js` 擋住，「選不到」這一半由本題守。
  // 反方向：表單多一個 ⇒ 選得到卻存不進去。
  assert.deepEqual([...ACCOUNT_CURRENCIES].sort(), [...CURRENCIES].sort(),
    '帳戶表單的幣別選項與 lib/schema.js 的 CURRENCIES 走散了——同一族的「存得進去卻選不到」，'
    + '受害的是金額換算：那個幣別的帳戶只能靠改資料庫才設得上去');
});

/**
 * 去註解掃描器（堆疊式；字串／樣板字串／樣板插值裡的 `//` 不算註解）。
 *
 * 演算法與 `test/hosted-auth.test.js`、`test/form-options.test.js` 那兩支同源——本 repo 的考題
 * **不共用 helper 檔**（`test/` 底下任何 .js 都會被 `node --test` 當考題跑），所以這裡是刻意的區域副本。
 * @param {string} src
 */
function stripComments(src) {
  let out = ''; let prev = '';
  /** @type {string[]} */ const stack = ['code'];
  /** @type {number[]} */ const interp = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const n = src[i + 1];
    const st = stack[stack.length - 1];
    if (st === 'code' || st === 'interp') {
      if (c === '/' && n === '/' && prev !== '\\') { stack.push('line'); prev = ''; i++; continue; }
      if (c === '/' && n === '*' && prev !== '\\') { stack.push('block'); prev = ''; i++; continue; }
      if (c === '\'') stack.push('s1');
      else if (c === '"') stack.push('s2');
      else if (c === '`') stack.push('tpl');
      else if (st === 'interp') {
        if (c === '{') interp[interp.length - 1]++;
        else if (c === '}') {
          if (interp[interp.length - 1] === 0) { stack.pop(); interp.pop(); out += c; prev = c; continue; }
          interp[interp.length - 1]--;
        }
      }
      out += c; prev = c;
    } else if (st === 'line') {
      if (c === '\n') { stack.pop(); out += c; prev = ''; }
    } else if (st === 'block') {
      if (c === '*' && n === '/') { stack.pop(); i++; prev = ''; }
      else if (c === '\n') out += c;
    } else if (st === 'tpl') {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && n === '{') { stack.push('interp'); interp.push(0); out += n; i++; }
      prev = c;
    } else {   // s1 / s2
      out += c;
      if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
      if ((st === 's1' && c === '\'') || (st === 's2' && c === '"')) stack.pop();
      else if (c === '\n') stack.pop();   // 一般字串不跨行＝未終結防呆
      prev = c;
    }
  }
  return out;
}

test('負債白名單｜全站只准宣告過的檔案出現這些型別字串（第四份手抄複本會被抓到）', () => {
  // ⚠️ 這一題是「還有沒有下一份複本」的機械認定，不靠人記——r8 的教訓正是「數字自己會漂」：
  //    註解從「兩處」漂到「三處」，而前端當時還藏著第四份（assets.js 的 isLiab）與
  //    第五份（表單的型別選項），兩份都零考題、兩份都已經與白名單走散。
  // ⚠️ 判準是**宣告**不是推導（同 test/no-hiding-places.test.js 的作法）：下面逐條寫死
  //    「哪個檔案有資格持有這份清單、為什麼」。任何新增一律轉紅，逼改的人回答一次
  //    「這是刻意的同步點，還是又一份會漂的手抄複本？」
  // ⚠️ **先去註解再掃**（#409 r6（2026-08-06）Codex 抓到的假紅；而 AGENTS.md「掃原始碼的形狀考題**要先去掉註解**」
  //    這條硬規則早就寫著，是我沒照做）：上一版直接掃原始碼，於是在任何檔案寫一行**無害的說明註解**
  //    （例如 `// 負債型別的字串住在 accounts-model.js（例：'loan'）`）就會轉紅。那種紅與正式行為
  //    完全無關——假紅會逼下一個人「為了讓考題閉嘴而不敢寫註解」，而本 repo 的紀律正好相反
  //    （解釋要寫在就地）。實測：注入那一行 → 本題紅 1；改成先去註解 → 綠，而真的抄一份仍然紅。
  // ⚠️ 誠實劃界——這一題**擋不住**什麼：
  //    ・它看的是**去註解之後、文字裡的帶引號字串**，所以任何「湊出同樣的字」都掃不到。已知三類：
  //      ①拼接 `['mor' + 'tgage']` ②先塞進變數／用 RegExp 組字串
  //      ③**完全不用引號**：`Object.keys({ loan: 1, liability: 1, mortgage: 1, creditcard: 1 })`
  //        ——這一條是 #409 r6（2026-08-06）Codex **實測全綠**、我逐字重放確認過的繞法：第四份手抄複本一字不差地重建出來，
  //        而檔案裡沒有任何 `'loan'` 這種帶引號的字串。⇒ 文字掃描本來就擋不住混淆；
  //        **這一題只擋「照正常寫法又抄一份」**，而那才是真實會發生的維護手滑（r8 抓到的兩份都是）。
  //      為什麼只有這一題退到文字層：本檔其他每一題都是「呼叫正式程式看結果」，
  //      但 `public/modules/assets.js` 一 import 就會拉進 `public/app.js`，那是瀏覽器模組、
  //      模組頂層就碰 document/localStorage，node 裡起不來（所以它才會零考題那麼久）。
  //    ・它只掃 `lib/` 與 `public/` 的 .js（正式程式）；考題、文件、seed 資料不掃。
  //    ・它不判斷「出現得合不合理」，只判斷「有沒有人偷偷長出下一份」。
  const ALLOWED = new Map([
    ['lib/derive.js', '後端的白名單本尊（前端不能 import lib/，所以後端這份是刻意的複本）'],
    ['lib/schema.js', '寫入牆枚舉：刻意手寫的棘輪，不從表單推導——刪掉一個表單選項不可以讓既有資料變非法'],
    ['public/modules/accounts-model.js', '前端的單一真相：表單選項與資產頁的負債判準都從這份 Set 長出來'],
  ]);
  /** @param {string} dir @returns {string[]} */
  const jsFiles = (dir) => readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? jsFiles(p) : (name.endsWith('.js') ? [p] : []);
  });
  const files = [...jsFiles(join(ROOT, 'lib')), ...jsFiles(join(ROOT, 'public'))].map(f => relative(ROOT, f));
  // 反面①：掃描器要真的走到檔案——路徑打錯或副檔名過濾寫壞時會靜靜掃 0 個檔案（空包彈）。
  assert.ok(files.length >= 50, `掃描器只看到 ${files.length} 個 .js，正式程式沒這麼少——掃描範圍壞了`);
  // 反面②：這一題存在的理由就是 assets.js，它一定要在受掃範圍內。
  assert.ok(files.includes('public/modules/assets.js'), '受掃清單裡沒有 public/modules/assets.js——這題就白做了');
  // 反面③：**去註解器的自檢，餵考題自己控制的 fixture**——註解要消失、帶引號字串要留下。
  //   一旦剝離器吃過頭（把真程式碼也吃掉），下面那圈就變成「什麼都沒掃卻通過」；
  //   一旦吃不夠（註解沒清乾淨），一行無害的說明註解就會被當成第四份手抄複本（r6 修掉的那個假紅）。
  //   ⚠️ 上一版（r6）把這道自檢押在**正式程式的字面字串**上（要求 `lib/derive.js` 與
  //      `public/modules/accounts-model.js` 去註解後仍逐字含 `'loan'`）。那本身就是假紅來源，
  //      而且紅的方向正好是**本題家族一直在追求的方向**：把手抄複本收成一份
  //      （例如 `lib/schema.js` 出一份 `LIABILITY_TYPE_CODES`、`lib/derive.js` 改成
  //      `new Set(LIABILITY_TYPE_CODES)` ⇒ **行為完全相同、只是少一份手抄**）會讓它轉紅，
  //      訊息卻說「剝離器把正式程式吃掉了」＝**歸因完全錯**，下一個人會跑去 debug stripComments。
  //      （#409 r7（2026-08-06）Codex 實測。）fixture 由考題自己控制，正式程式怎麼收斂都不會誤紅。
  //   ⚠️ fixture 三種引號都放，與下面那圈的 `quote` 迴圈對齊：少認一種就是多一個盲區
  //      （AGENTS.md「掃原始碼的形狀考題要先去掉註解、不可只認得一種寫法」）。
  const probe = [
    '// 行註解裡的 \'loan\' 不算複本',
    '/* 區塊註解裡的 "loan" 也不算 */',
    'const real = [\'loan\', "creditcard", `mortgage`];   // 尾註裡的 \'liability\' 不算',
  ].join('\n');
  const stripped = stripComments(probe);
  assert.deepEqual(['\'loan\'', '"creditcard"', '`mortgage`'].filter((s) => !stripped.includes(s)), [],
    '去註解器把正式程式的帶引號字串吃掉了（單／雙／反引號至少漏一種）——本題會變成「什麼都沒掃卻通過」');
  assert.deepEqual(['\'liability\'', '不算'].filter((s) => stripped.includes(s)), [],
    '去註解器沒把註解清掉——本題會把一行無害的說明註解（例：`// …（例：\'loan\'）`）當成第四份手抄複本');
  /** @type {string[]} */
  const hits = [];
  for (const rel of files) {
    if (ALLOWED.has(rel)) continue;
    const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    for (const type of LIABILITY_MEMBERS) {
      for (const quote of ['\'', '"', '`']) {
        if (src.includes(`${quote}${type}${quote}`)) hits.push(`${rel} ← ${quote}${type}${quote}`);
      }
    }
  }
  assert.deepEqual(hits, [], '這些檔案自己寫死了負債型別的字串＝又一份會漂的複本'
    + `（有資格持有的只有：${[...ALLOWED.keys()].join('、')}）：\n${hits.join('\n')}`);
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
  // ⚠️ 代號同時走正規形與非正規形（#409 r5）：使用者手打／匯入的資料真的長 ' kweb ' 這樣，
  //    後端 compOf 少了 normalizePortfolioSymbol 時它會退回「其他」＝殘差桶豁免，
  //    整條 conc-country-中國 消失（實測 reminders 只剩 conc-equity-total）——中國軟上限無聲失效。
  //    這一題是本檔唯一走完整 buildSummary 的行為級證據，所以形狀必須在這裡也釘住。
  for (const symbol of ['KWEB', ' kweb ']) {
    const cn = {
      ...db,
      holdings: [{ id: 'h2', symbol, layer: 'satellite', currency: 'TWD', quantity: 1, price: 1000000, source: 'ib' }],
    };
    const cnKeys = buildSummary(cn).reminders.map((/** @type {any} */ r) => r.key);
    assert.ok(cnKeys.includes('conc-country-中國'),
      `${JSON.stringify(symbol)} 全額中國、佔淨資產 100% ⇒ 中國上限提醒必須出現`
      + '（這也順便釘住後端 KWEB 的區域是中國，以及代號要先正規化）');
  }
});
