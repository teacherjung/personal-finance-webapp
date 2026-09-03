// @ts-check
// 集合定義、欄位白名單、與「型別驗證」（B2＋Codex 三輪）：
// 新增/更新/匯入資料時，只接受白名單內的欄位，且數值欄位必須是數字——
// 否則像 holdings.price:'oops' 會讓 derive 的 Number() 變 NaN、污染 netWorth/槓桿（顯示 null）。
// ⚠️ 同步點：前端表單新增欄位→補進 WRITABLE_FIELDS；新增數值欄位→同時補進 NUMERIC_FIELDS。
//（伺服器會在 console 警告被剝掉的欄位名，方便發現漏加。）

import { sanitizeStoreRules } from './store-rules.js';
import { sanitizeBirthStats } from './recipe-birth.js';   // 規則卡出生統計（封閉鍵集合；服務層欄位、不進通用白名單）
import { emptyMap, isProtoKey } from './safe-map.js';
import { MAX_REMEMBERED as PW_MAX_N, MAX_PW_LEN as PW_MAX_LEN } from './statement-password-policy.js';   // 密碼池上限（P0.5 r2#5：與讀取端共用同一組數字，不再硬編碼）
import { normalizeSecSymbol } from './stock-fundamentals.js';
import { normalizePortfolioSymbol } from '../public/modules/portfolio-symbol.js';

/** 可自由增刪改的集合（通用 CRUD 開放）。 */
export const COLLECTIONS = ['accounts', 'assetTargets', 'transactions', 'subscriptions', 'insurance', 'cards', 'history',
  'holdings', 'watchlist', 'research'];

/** 只由專屬服務寫入，前端唯讀；有自訂 API 的集合不開通用 GET。 */
export const READONLY_COLLECTIONS = ['portfolioSnapshots', 'ibTrades', 'dailyValues', 'securityTrades', 'stockFundamentals', 'parseRecipes'];   // securityTrades＝證券交易共同集合（S2）；stockFundamentals＝SEC 官方資料每租戶快取；parseRecipes＝帳單配方快取（P2-2；bank-import 服務專寫）

// 系統實際支援的幣別（lib/derive.js fxRates 只認這四種；表外幣別＝缺匯率、不計入並標註——「乙」口徑，不再猜）。
export const CURRENCIES = ['TWD', 'USD', 'GBP', 'JPY'];

// ---- 異常輸入防線（階段四 B，裁決 2026-07-24／William 2026-07-27 定不降級：未來多人使用）----
// 分兩級、不設全站單一數字：短欄位（名稱/分類/代號…）＝合理上限；長內容（備註/論點/帳單原文）＝
// 極寬鬆技術上限——**不干涉正常寫作**（兩萬字≈一篇長論文，正常使用碰不到）。
// 行為：CRUD／匯入＝明確 400 點名（**絕不靜默截斷**——截斷會默默改變使用者的資料）；
// 櫃檯 throw 模式＝tripwire（寫入端漏了驗證）；**strip 模式＝warn 放行**（搬家/舊資料：
// 合法舊資料不可因升級被刪——裁決原文；超長舊資料留著無害，只是之後改不了要先修短）。
export const LEN_SHORT = 200;
export const LEN_LONG = 20000;
/** 長內容欄位名單（自由寫作／匯入原文；**匯入內容不得被一般表單上限誤傷**＝stmtRef/bankRef 在列）。
 * 未列名的字串欄位一律 LEN_SHORT。 @type {Record<string, string[]>} */
export const LONG_TEXT_FIELDS = {
  transactions: ['note', 'stmtRef', 'autoNote', 'bankRef', 'bankSummary', 'bankNote'],   // bankSummary/bankNote＝帳單原文留底（Stage 2）：跟 bankRef 同級——它們是匯入內容，不可被一般表單的短上限誤傷（超長舊備份必須還原得回來）
  cards: ['benefits', 'note'],
  insurance: ['coverage'],
  watchlist: ['note'],
  research: ['thesis', 'metrics', 'risks', 'catalysts', 'thesisBreakers', 'watchMetrics'],
};
/** 超長＝回錯誤字串（點名欄位＋上限＋實際長度，使用者看得懂哪裡出事）；合規＝null。
 * @param {string} col @param {string} key @param {any} v @returns {string|null} */
export function lengthErrorOf(col, key, v) {
  if (typeof v !== 'string') return null;
  const max = (LONG_TEXT_FIELDS[col] || []).includes(key) ? LEN_LONG : LEN_SHORT;
  return v.length > max ? `${key}(超過 ${max} 字上限，目前 ${v.length} 字)` : null;
}

/** 各集合允許寫入的欄位（依前端表單與匯入流程盤點，2026-07-13）。 @type {Record<string, string[]>} */
export const WRITABLE_FIELDS = {
  // ibCashCur 移除（Codex#6-3）：它是 IB 同步「擁有」的欄位（標記帳戶為 IB 現金/融資），
  // 前端表單不送、只由 lib/services/ib-sync.js 寫。放行會讓人手動塞非 IB 帳戶偽裝成 IB 融資、污染槓桿。
  accounts: ['name', 'type', 'class', 'currency', 'balance', 'accountNo'],   // accountNo＝完整帳號（PII，前端可填、GET 剝除只回 set/last4；供銀行對帳單末碼比對，stage 2）
  assetTargets: ['class', 'targetPct'],
  // autoCat/autoSub＝匯入當下的「完整自動判斷」（第二帖，2026-07-19）：留底才能日後精確分辨
  // 「這個分類是人改的還是舊規則判的」（體檢的分類漂移偵測靠它）。**不在 CRUD 白名單**
  // （r2-Codex#8）：它們是匯入服務層「擁有」的欄位，前端可寫的話留底就失真、D4 判斷跟著失準；
  // 服務層直接 push＋saveDb 不經 pickWritable，照樣寫得進去，型別由 FIELD_SCHEMA 驗。
  // stmtRef/storeKey/source/importBatch/importedAt 同理移除（Codex r11）：都是帳單匯入服務層
  // 「擁有」的衍生欄位（importRows/reassignBatch/normalizeBranches 寫），前端表單從不送——
  // 放行會讓 PUT 挾帶假 storeKey 劫持 learnFromStmtEdit 的學習鑰匙（毒化學習表、劫持未來匯入）、
  // 讓手動記帳偽裝 source:'stmt' 混進學習/批次/體檢。備份還原不受影響（/api/import 走
  // validateImportItem、櫃檯走 sanitizeDbForWrite，兩者只驗 FIELD_SCHEMA 型別、不剝白名單外欄位）。
  transactions: ['date', 'type', 'category', 'subcategory', 'amount', 'account', 'note'],
  subscriptions: ['name', 'category', 'amount', 'cycle', 'card', 'email', 'status', 'active',
    'nextCharge', 'endsOn', 'expiryDate', 'since', 'order', 'considerCancel'],
  insurance: ['policyName', 'insurer', 'policyholder', 'insured', 'beneficiary', 'coverage',
    'cashValue', 'premium', 'premiumCycle', 'nextPayment', 'startDate', 'endDate'],
  cards: ['name', 'type', 'issuer', 'issuerId', 'network', 'lastFour', 'level', 'memberId',
    'statementDay', 'dueDay', 'annualFee', 'expiry', 'benefits', 'note', 'pdfPassword'],   // issuerId＝發卡機構代號（2026-09-02）：卡片表單寫、身分判準讀（`cardIssuerBank`）；**沒有可解析的代號**才退回 issuer 字串那條路，**有代號但顯示名沒確認它＝說不清楚、不退回文字**（三態＝`cardCode`）。⚠️ 兩欄是同一個身分的兩半，跨欄規則見下方 pickWritable
  history: ['month', 'amount'],
  // source 移除（Codex#6-2）：source==='ib' 決定槓桿計算，是 IB 同步擁有的欄位。前端表單不送，
  // 放行會讓 source:'ibx' 之類把 IB 持股偽裝成非 IB、把融資風險藏掉。
  holdings: ['symbol', 'name', 'layer', 'currency', 'quantity', 'price', 'avgCost', 'cost', 'quoteSymbol'],
  watchlist: ['symbol', 'name', 'targetPrice', 'currency', 'quoteSymbol', 'note', 'lastPrice', 'lastAt'],
  research: ['symbol', 'thesis', 'metrics', 'risks', 'checkpoints', 'status', 'lastReviewedAt',
    'scorecard', 'valuationScenarios', 'catalysts', 'thesisBreakers', 'watchMetrics', 'sources', 'scoreHistory']
};

// 各集合「非自由字串」欄位的型別（其餘欄位＝自由字串，寬鬆放行）。這些是會影響 derive 計算的欄位，
// 錯型別會 NaN 污染（數值）或算錯月費/停用（布林/枚舉）。值＝'number'｜'boolean'｜'array'｜string[]（枚舉合法值）。
// ⚠️ 註：transactions.type 刻意不設枚舉——除 income/expense 外還有「轉帳等其他型別」，cashflow 已安全忽略（derive.js）。
// 型別代碼：number｜boolean｜array｜object｜str（必須是字串）｜date（YYYY-MM-DD 或空）｜datetime（ISO instant）
//          ｜month（YYYY-MM 或空）｜monthreq／datereq（必填版，空值也算壞資料）｜string[]（枚舉）。
// str/date/month（自審 r2，高）：這些欄位在 derive 會被 .slice()/.toUpperCase()/monthKey() 處理——
// 塞成數字會讓 buildSummary 永久崩潰（例：endsOn:20991231 → endsOn.slice is not a function 炸掉總覽）、
// 壞格式日期會讓該筆默默不被計入月現金流。非法值＝拒絕（400/tripwire），不剝除（剝掉會默默改變語意）。
/** @type {Record<string, Record<string, 'number'|'boolean'|'array'|'object'|'str'|'date'|'datetime'|'month'|'monthreq'|'datereq'|string[]>>} */
export const FIELD_SCHEMA = {
  // accounts.type 是枚舉：錯值（'mortgagex'）會讓負債被當資產、淨資產方向相反（Codex 高severity）。
  // 合法值＝帳戶表單的型別選項（public/modules/accounts-model.js 的 accountTypeOptions()），
  // 而那份選項本身涵蓋每一個 LIABILITY_TYPES 成員（涵蓋 IB/舊資料），確保合法資料不被誤拒。
  // ⚠️ 是**精確相等**不是「聯集就好」（#409 r8 改口，原本寫「∪」）：兩個方向各有一種病——
  //    枚舉有、表單沒有 ⇒ 那種帳戶選不到，只能靠改資料庫設上去（#409 之前更糟：一打開儲存就
  //    靜靜變成第一個選項 cash、50 萬負債變 50 萬資產，Codex 實測的活著的病——那一半現在由
  //    public/modules/form-options.js 保留現值擋住）；表單有、枚舉沒有 ⇒ 選得到卻存不進去。
  // ⚠️ 這份清單刻意**手寫、不從表單推導**：它是棘輪——有人刪掉一個表單選項時，
  //    既有資料裡那個型別不可以跟著變非法（strip 模式會默默剝掉 type ⇒ 負債翻成資產）。
  //    相等由考題（test/exposure-sync-integrity.test.js）盯著，刪選項就會紅、逼人先想資料。
  // currency 是枚舉（Codex#6-1）：錯幣別（'TWDx'）在 derive 會 fallback 到 USD 匯率、把 100 TWD 算成 3200。
  // ibCashCur 也驗幣別（雖已從 CRUD 白名單移除，匯入仍會保留、需擋壞值）。
  accounts: { balance: 'number', currency: CURRENCIES, ibCashCur: CURRENCIES, balanceAsOf: 'date', bank: 'str', cdKey: 'str', accountNoSuffixOnly: 'boolean', type: ['cash', 'investment', 'property', 'insurance-cv', 'other', 'mortgage', 'loan', 'liability', 'creditcard'] },   // balanceAsOf＝餘額現值參考日（服務層寫、非 CRUD；銀行對帳單「較新才覆蓋」的依據，stage 2）；bank＝開戶機構戳（P1a 機構維度：matchAccount 憑它擋跨行誤配——服務層寫、非 CRUD，但備份匯入會保留、需擋非字串（truthy 錯型會永久硬擋正確比對、falsy 錯型繞過護欄，r1#3）；cdKey＝定存身分鍵（2026-08-18 分開列管：機構|末碼|幣別|起迄日|金額|#序——存單號帳單不印、同值定存靠列印序分辨；服務層寫、非 CRUD；**有 cdKey＝這顆是一筆定存、不進 matchAccount 泛用比對**）
  assetTargets: { targetPct: 'number' },
  // ledger＝帳本歸屬（三層重構 stage 1，使用者定 2026-07-20）：'card'＝信用卡消費明細（分析用、不進現金流）、
  // 'cashflow'＝收入支出（現金流真相）。服務層/遷移寫入，**不進 CRUD 白名單、不進 REQUIRED_FIELDS**
  //（必填會讓遷移前的舊列在下次寫檔被整筆濾除）；讀取端一律用 derive.js isCardLedger「排除 card」
  //  而非「只收 cashflow」（缺值＝cashflow，遷移期/還原舊備份不掉帳）。
  transactions: { amount: 'number', date: 'date', autoCat: 'str', autoSub: 'str', stmtMonth: 'month', stmtDue: 'number',
    stmtRef: 'str', storeKey: 'str', source: 'str', importBatch: 'str', importedAt: 'str', refundOf: 'str', isAdjustment: 'boolean', ledger: ['card', 'cashflow'], bankRef: 'str', bankKey: 'str', dir: ['in', 'out'], autoNote: 'str', bankSummary: 'str', bankNote: 'str', bankBatch: 'str' },   // refundOf＝帳單匯入服務層寫的退款配對標記（P0 先存 null；不進 CRUD 白名單）；isAdjustment＝AI 帳單具名調整列（#529 Codex r11：不驗型別的話，還原把 "false" 字串原樣收回＝truthy，pairRefunds 會把普通自動繳款改列成未對應退款）；bankRef＝銀行對帳單交易去重鍵；bankKey＝銀行學習鑰匙（Codex r14#4：漏驗型別→物件/陣列 bankKey 能穿過匯入牆、被 String() 成 "[object Object]" 而多筆撞成同鑰匙、「同類一起改」誤改別筆）；dir＝金流方向（Codex r13#2）；autoNote＝預設自動顯示名（清空自訂說明時回復用，使用者定 2026-07-21）；bankSummary/bankNote＝帳單原文留底（Stage 2：摘要與備註各自存，非字串會讓顯示層 bankRawText 拿錯東西當原文）——皆服務層寫、非 CRUD 白名單   // 服務層擁有的欄位（非 CRUD）仍須驗型別（r2-Codex#8、r11）：數字型會讓 origFromStmtRef 的 .split／批次聚合走樣
  subscriptions: {
    amount: 'number', order: 'number', active: 'boolean', considerCancel: 'boolean',
    nextCharge: 'date', endsOn: 'date', expiryDate: 'date', since: 'month',
    chargeAnchorDay: 'number',   // 續費日自動推進的號數錨點（服務層擁有、不進 CRUD 白名單；2026-07-26）
    cycle: ['monthly', 'quarterly', 'semiannual', 'yearly', 'lifetime'], status: ['active', 'ending', 'ended']
  },
  insurance: { premium: 'number', cashValue: 'number', nextPayment: 'date', startDate: 'date', endDate: 'date',
    premiumCycle: ['yearly', 'semiannual', 'quarterly', 'monthly', 'single'] },
  cards: { statementDay: 'number', dueDay: 'number', annualFee: 'number', expiry: 'str', type: ['credit', 'membership', 'debit'] },   // debit＝簽帳金融卡（Stage 5b）：刷卡消費明細記到它的卡片帳本、沒有結帳／繳款；銀行匯入可自動建   // expiry 只驗「須為字串」（格式寬鬆相容舊資料；數字會讓 cards 頁 .slice 崩，Codex#10-1）
  // ⚠️ **`issuer` 刻意連型別都不加**（#520 r3#2 加過、r4#1 撤回；理由不是疏忽）：
  //   ①**枚舉不行**——發卡行是「可選清單＋其他（自行輸入）」，封閉了清單以外的機構就填不進去。
  //   ②**連 `'str'` 也不行**——`'str'` 是 `reject` 級規格，而櫃檯（`store.js` 的 `save`／`store-pg.js` 的
  //     `saveKv`）用 `{ mode: 'throw' }`：**升級前庫裡若已有非字串 issuer，升級後每一次整庫寫入都會炸**
  //     （記帳、匯入、設定全 500，訊息還叫使用者「請修程式」）。三份獨立實測都重現了，且對照組證實是這一行造成的。
  //     載入路徑一個字都不清（`store.js` 的 `load()` 是純 JSON.parse；strip 模式只在 store.json 搬家與空庫餵 seed 時跑），
  //     HOSTED 更沒有任何搬家掛勾。⚠️ 而它**買不到對應的好處**——撤回當時逐一看過 `card.issuer` 的
  //     消費端（`issuerBank`／`cardMatchesBank`／`bank-import.js` 的 `sameBank(String(c.issuer),…)`／
  //     卡片頁的 `esc(c.issuer)`／表單的 `issuerFormFields`），都先 `String()` 再用；有**行為考題**釘住的
  //     是 `issuerBank` 與 `issuerFormFields` 兩支（`test/card-issuers.test.js` 的容忍界線題），
  //     其餘靠當時的逐點檢查——**日後新增的讀取端不在這句話的射程裡**，新讀取端要自己 `String()`。
  //     而且 `issuerBank(['台新'])` 在**加了型別之前之後都回 `'台新'`**——型別牆對「錢會記到哪張卡」
  //     一個結果都改不了。要收緊就得先安排搬家，那是另案。
  //   ⇒ **誠實劃界**：`issuer` 因此仍可經 CRUD 與備份匯入收到非字串（實測 200 落庫、零警告）。
  //     後果＝那張卡顯示 `[object Object]`、身分判不出來；使用者一按儲存就被 `String()` 定型。
  // ⚠️ **`issuerId` 同樣不加型別**（2026-09-02 新欄，理由與上面**不同**，不是照抄）：
  //   上面那三條講的是「升級前庫裡已經有壞值」，新欄沒有那個歷史包袱——所以真正的理由只有一條：
  //   **加了買不到任何行為改變**。讀它的唯一入口是 `public/modules/card-issuers.js` 的 `issuerById`，
  //   而它用 `typeof id !== 'string'` 硬判、非字串一律當作「沒有代號」⇒ 壞型別走的是**退回 issuer
  //   字串**那條路，與升級前逐字相同。加 `'str'` 只是把「安全地被忽略」換成「整庫寫入炸掉」
  //   （`'str'` 是 reject 級規格，而櫃檯用 `{ mode: 'throw' }`），代價一面倒。
  //   ⇒ **誠實劃界**：`issuerId` 因此也可經 CRUD 與備份匯入收到非字串或不認得的代號；
  //     後果＝那張卡**退回文字判準**（不是判不出身分），使用者一按儲存就被寫成清單上的代號或清空。
  // ⚠️ **上面那句「壞型別一律安全」只涵蓋 `issuerId`，不涵蓋 `issuer`**（Codex #547 r3 第 3 條）：
  //   `issuer` 收得到 `{toString:null}` 這族**連 `String()` 都炸**的值（同 `lastFour` 的 #541 病歷）。
  //   對它們裸跑 `String()` 會丟 `TypeError` ⇒ 一張壞卡炸掉整份帳單預覽。判準側已用
  //   `public/modules/card-issuers.js` 的安全字串化收口（炸不出＝認不出機構／說不清楚，不是丟例外），
  //   ⚠️ 但**這裡沒有型別牆**＝其他讀 `card.issuer` 的地方仍要自己保護（同 #541 對 `lastFour` 的劃界）。
  history: { amount: 'number', month: 'monthreq' },   // 必填：history 頁以 month 為主鍵做 .slice/.startsWith（Codex#10-2）
  // layer 枚舉：錯值會讓個股逃過「單一個股上限」等集中度守門（生存守則）。
  // source 枚舉（Codex#6-2）：source==='ib' 決定融資槓桿，'ibx' 會把 IB 持股藏起來、隱藏融資風險。
  holdings: { symbol: 'str', quantity: 'number', price: 'number', avgCost: 'number', cost: 'number', currency: CURRENCIES, source: ['ib', 'manual'], layer: ['core', 'satellite', 'stock', 'bond', 'gold'] },
  watchlist: { symbol: 'str', targetPrice: 'number', lastPrice: 'number', lastAt: 'date', currency: CURRENCIES },   // lastAt＝報價更新日（前端「更新報價」寫 YYYY-MM-DD）——補型別驗證（護欄 G5，防壞值讓觀察清單 .slice 崩）
  research: {
    symbol: 'str', thesis: 'str', metrics: 'str', risks: 'str', lastReviewedAt: 'date',
    status: ['unreviewed', 'watching', 'valid', 'needs-review', 'broken']
  },
  // 唯讀集合也要有內層規格（Codex#10-3）：雖只由 snapshot/ib-sync 寫入，但匯入備份也會經過這裡——
  // 數字型 month/date 會讓投組頁 .split()/.localeCompare() 崩。ibTrades 來源是 XML（天生字串），寬鬆驗 str 即可。
  portfolioSnapshots: { month: 'monthreq', cost: 'number', value: 'number' },
  snapshots: { month: 'monthreq', date: 'date', netWorth: 'number', assets: 'number', liabilities: 'number' },
  // 日線（D0）：date 是主鍵欄（一天一行，同日覆寫），必填且必須是合法 YYYY-MM-DD——
  // 壞 date 會讓差異引擎的排序/「最接近的既有日」比對錯亂（比沒有資料更糟）。
  dailyValues: { date: 'datereq', netWorth: 'number', assets: 'number', liabilities: 'number',
    pfCost: 'number', pfValue: 'number', usdTwd: 'number', gbpTwd: 'number', jpyTwd: 'number' },
  ibTrades: { date: 'str', symbol: 'str' },
  // 證券交易共同集合（S2，藍圖 §四）：服務層寫（IB 同步雙寫＋台新匯入）、前端唯讀。
  // side/cashDirection 是枚舉——入庫的一定是已判定方向的交易（未知類別在預覽 fail-closed 擋下，
  // 絕不落庫）；金額全部原幣、netSettlement＝絕對值（方向看 cashDirection）。tradeDate 必填真日曆、
  // sourceRef＝去重鍵必填（identifier-first；缺了 upsert 冪等就毀）。
  securityTrades: { tradeDate: 'datereq', settlementDate: 'date', source: ['ibkr', 'taishin'],
    side: ['buy', 'sell'], cashDirection: ['in', 'out'], currency: CURRENCIES,
    symbol: 'str', name: 'str', market: 'str', rawType: 'str', sourceRef: 'str',
    sourceAccountId: 'str', sourceAccountLabel: 'str', importBatch: 'str', importedAt: 'str',
    commissionCurrency: CURRENCIES,   // 手續費幣別（IB ibCommissionCurrency；與交易幣別不同才存，Codex S2r1#3）
    quantity: 'number', price: 'number', grossAmount: 'number', commission: 'number',
    tax: 'number', feeDiscount: 'number', otherFees: 'number', netSettlement: 'number' },
  // SEC 快取由 stock-fundamentals service 專寫。data／lastError 先擋非物件，深層契約由 ROW_RULES 驗。
  stockFundamentals: {
    symbol: 'str', lastAttemptAt: 'datetime', fetchedAt: 'datetime', data: 'object', lastError: 'object'
  },
  // 配方快取（P2-2）：bank-import 服務專寫、前端唯讀且不開通用 GET。
  // current/previous＝格式 A 配方物件（深層合法性由**出生三關**在寫入前把關（P2-3 的
  // validateRecipeStrict＋against-statement＋reproduces）；這裡只守形狀層——schema.js 不能
  // import parse-recipe.js（會經 bank-statement 繞成循環），誠實劃界記在收支契約）。
  // 版本欄位＝裁示④細部：留 1 版（current＋previous）、回滾自動；計數欄餵畢業（連 5）與
  // 內建化候選訊號（重生累計 5）。
  parseRecipes: {
    id: 'str',   // r1#2：id 是票與記帳的列身分——型別進形狀牆（數字 id 會與字串票號隱式碰撞）
    bank: 'str', kind: ['bank', 'card'],   // kind＝種類標籤（批四）＝**封閉枚舉**（r3#4：它是兩櫃唯一的分流鍵，拼錯值靜默通過＝靜默改櫃）；缺席＝銀行
    current: 'object', previous: 'object',
    graduateStreak: 'number', graduated: 'boolean', suspect: 'boolean', rebirths: 'number',
    createdAt: 'datetime', updatedAt: 'datetime', lastUsedAt: 'datetime'
  }
};

// 必填欄位（Codex#11-1）：monthreq 只驗「有傳進來的值」，欄位完全缺席會整個繞過——
// 而 month 是這三個集合的主鍵欄，缺了會讓 history 頁 .slice、投組頁 .split、快照排序全崩。
// 強制點：CRUD 新增（400）、匯入逐筆（400）、櫃檯寫入牆（throw/strip）。PUT 部分更新天然安全
//（pickWritable 只帶「有送的欄位」、updateItem 合併保留舊值，欄位不可能被「更新成缺席」）。
/** @type {Record<string, string[]>} */
export const REQUIRED_FIELDS = {
  history: ['month'],
  research: ['symbol'],
  portfolioSnapshots: ['month'],
  snapshots: ['month'],
  dailyValues: ['date'],
  stockFundamentals: ['symbol', 'lastAttemptAt'],
  parseRecipes: ['id', 'current'],   // id＝票與記帳的列身分（Grok GH3：沒 id 對不到列＝改錯列/漏標）；沒有現行配方＝這列無意義
  // 查帳不可缺的合約欄位全列必填（Codex S2r1#5：只驗兩欄＝殘缺列可穿過備份還原牆）：
  // 身分（source/symbol）、方向（side/cashDirection）、數量、幣別缺了＝查帳表無法呈現、金額語意不明。
  // 三個核心金額也必填（Codex S3r2#4：缺 price/grossAmount/netSettlement 的列會讓買進總額被當成 0
  // ——服務路（匯入 blocker、IB missingCore）本就保證有值，備份牆漏了＝壞備份可塞進「沒有錢的交易」）。
  securityTrades: ['tradeDate', 'sourceRef', 'source', 'symbol', 'side', 'quantity', 'cashDirection', 'currency',
    'price', 'grossAmount', 'netSettlement']
};
const missingRequired = (/** @type {string} */ col, /** @type {any} */ item) =>
  (REQUIRED_FIELDS[col] || []).filter(f => !(f in item) || item[f] === '' || item[f] == null);

// 跨欄位不變式（Codex S3r2#4）：單欄枚舉各自合法、合起來卻說謊的列——buy＋in 會顯示「買進」
// 卻把淨應收付算成正流入（方向由 cashDirection 決定，見 securities-view rowNetSigned）。
// 正規化器天生守恆（side 推導 cashDirection），這裡是防備份/未來新寫入路徑的最後一道牆。
// 回傳 null＝合法；字串＝人話病因（throw 模式炸出、strip 模式整筆濾除、匯入逐筆 400）。
/** @type {Record<string, (o: any) => string | null>} */
export const ROW_RULES = {
  securityTrades: (o) =>
    (o.side === 'buy' && o.cashDirection !== 'out') ? '買進(buy)的現金方向必須是 out（付錢）'
    : (o.side === 'sell' && o.cashDirection !== 'in') ? '賣出(sell)的現金方向必須是 in（收錢）' : null,
  stockFundamentals: (o) => stockFundamentalsRowError(o),
};
const rowRuleError = (/** @type {string} */ col, /** @type {any} */ item) =>
  Object.hasOwn(ROW_RULES, col) ? ROW_RULES[col](item) : null;

// ---- 日期／月份的「真實日曆」驗證（Codex r3#9）----
// 長期以來只驗長相（\d{4}-\d{2}）：2026-13、2026-99-99、2026-02-31 全都過得了關。
// 後果不是崩潰而是**默默算錯**——月份排序（localeCompare 把 2026-13 排在 2026-02 後面）、
// 提醒天數、費用攤提、日線的「找最接近的既有日」全會偏掉，而且看起來一切正常。
// 四種日期型別（date／datereq／month／monthreq）共用這一套判準，不可各寫一份。
export const isRealMonth = (/** @type {any} */ v) => {
  if (typeof v !== 'string') return false;
  const m = v.match(/^(\d{4})-(\d{2})$/);
  if (!m) return false;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12;
};
export const isRealDate = (/** @type {any} */ v) => {
  if (typeof v !== 'string') return false;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  // 用 UTC 建構再比對，避開本地時區在月初/月底的位移（這裡只驗「這個日子存不存在」）
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
};

/** 服務只寫 Date#toISOString 的標準形式，避免模糊時區字串讓 24h 新鮮度算錯。 @param {any} v */
export const isRealInstant = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
};

const isNum = (/** @type {any} */ v) => typeof v === 'number' && isFinite(v);
const isObj = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v);

/** SEC 解析結果是可丟進 JSONB 的有限 JSON；拒絕原型鍵、過深或異常巨大容器。 @param {any} value @param {number} [depth] */
function isSafeFundamentalsJson(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= LEN_LONG;
  if (Array.isArray(value)) {
    return value.length <= 5000 && value.every(item => isSafeFundamentalsJson(item, depth + 1));
  }
  if (!isObj(value) || Object.keys(value).length > 5000) return false;
  return Object.entries(value).every(([key, item]) => (
    !isProtoKey(key) && isSafeFundamentalsJson(item, depth + 1)
  ));
}

/** @param {any} object @param {string[]} allowed */
function onlyKeys(object, allowed) {
  return isObj(object) && Object.keys(object).every(key => !isProtoKey(key) && allowed.includes(key));
}

/** @param {any} row @returns {string|null} */
function stockFundamentalsRowError(row) {
  const normalized = normalizeSecSymbol(row.symbol);
  if (!normalized || row.symbol !== normalized) return 'symbol 必須是正規化的 SEC 股票代號';
  const hasData = Object.hasOwn(row, 'data');
  const hasError = Object.hasOwn(row, 'lastError');
  if (!hasData && !hasError) return '至少要有最後成功資料或最後錯誤';
  if (hasData && !Object.hasOwn(row, 'fetchedAt')) return '成功資料必須附 fetchedAt';
  if (Object.hasOwn(row, 'fetchedAt') && !hasData) return '沒有成功資料時不可有 fetchedAt';

  if (hasData) {
    const data = row.data;
    if (!onlyKeys(data, ['symbol', 'market', 'company', 'periods', 'metrics', 'warnings'])
      || data.symbol !== normalized || data.market !== 'US') return 'data 公司身分不一致';
    if (!onlyKeys(data.company, ['cik', 'name', 'sic', 'fiscalYearEnd'])
      || !/^\d{10}$/.test(data.company.cik)
      || typeof data.company.name !== 'string' || !data.company.name.trim()) return 'data.company 不完整';
    if (!onlyKeys(data.periods, ['annual', 'latestQuarter', 'latestQuarterBasis'])
      || !Array.isArray(data.periods.annual)
      || (Object.hasOwn(data.periods, 'latestQuarterBasis')
        && data.periods.latestQuarterBasis !== 'per-metric')
      || !isObj(data.metrics)
      || !Array.isArray(data.warnings)
      || !isSafeFundamentalsJson(data)) return 'data 不是合法的 SEC 解析結果';
  }

  if (hasError) {
    const error = row.lastError;
    if (!onlyKeys(error, ['at', 'code', 'stage', 'status', 'message'])
      || !isRealInstant(error.at)
      || typeof error.code !== 'string' || !error.code
      || typeof error.stage !== 'string' || !error.stage
      || typeof error.status !== 'number' || !Number.isFinite(error.status)
      || typeof error.message !== 'string' || !error.message
      || !isSafeFundamentalsJson(error)) return 'lastError 形狀不合法';
  }
  return null;
}

// ---- 個股研究深層資料契約（P2）----
// research 是舊集合擴充：舊筆只有 symbol/thesis/metrics/risks/checkpoints 仍合法；新巢狀欄位一旦出現，
// 就必須逐層驗證。只標 FIELD_SCHEMA 的泛用 array 不夠——它只知道「是陣列」，不知道元素內的狀態、
// 日期、分數、URL 是否可信。這組 sanitizer 由 CRUD、備份匯入與 store.save 最後櫃檯共用。
const RESEARCH_SCORE_KEYS = ['business', 'financial', 'valuation', 'evidence', 'risk'];
const RESEARCH_STATUS = ['unreviewed', 'watching', 'valid', 'needs-review', 'broken'];
const CATALYST_STATUS = ['watching', 'happened', 'expired'];
const BREAKER_STATUS = ['watching', 'triggered', 'cleared'];

/** @param {any} v @returns {boolean} */
const isHttpUrl = (v) => {
  if (typeof v !== 'string' || v === '') return typeof v === 'string';
  try { return ['http:', 'https:'].includes(new URL(v).protocol); }
  catch { return false; }
};

/**
 * 只讓已定義的巢狀鍵進下一層；未知鍵（含 JSON 可造出的自有 __proto__）明確列錯。
 * @param {any} input @param {string} path @param {string[]} allowed @param {string[]} errors
 */
function researchObject(input, path, allowed, errors) {
  if (!isObj(input)) { errors.push(path); return null; }
  for (const key of Object.keys(input)) {
    if (isProtoKey(key) || !allowed.includes(key)) errors.push(`${path}.${key}`);
  }
  return input;
}

/**
 * @param {any} src @param {Record<string, any>} out @param {string} key @param {string} path
 * @param {string[]} errors @param {{values?:string[], date?:boolean, monthOrDate?:boolean, url?:boolean, protoValue?:boolean, long?:boolean}} [opts]
 */
// 異常輸入防線的巢狀開關：**長度 400 只擋新輸入**（pickWritable＝嚴格），備份還原與櫃檯＝寬容
//（「合法舊資料不可因升級被刪」——超長舊研究還原時不可被巢狀驗證 400/炸掉）。
// 模組級 flag 而非參數傳染：sanitizeResearchItem 內部十幾處 researchString 呼叫，逐一傳參數＝瑣碎失控；
// 全同步無 await，flag 不會跨請求汙染。
let lenEnforced = true;
/** @param {any} item @returns {{item: any, errors: string[]}} 還原/櫃檯用的寬容版（長度不擋，其餘驗證照舊） */
function sanitizeResearchItemLenient(item) {
  lenEnforced = false;
  try { return sanitizeResearchItem(item); } finally { lenEnforced = true; }
}

function researchString(src, out, key, path, errors, opts = {}) {
  if (!(key in src)) return;
  const value = src[key];
  const ok = typeof value === 'string'
    && (!opts.values || opts.values.includes(value))
    && (!opts.date || value === '' || isRealDate(value))
    && (!opts.monthOrDate || value === '' || isRealMonth(value) || isRealDate(value))
    && (!opts.url || isHttpUrl(value))
    && (!opts.protoValue || !isProtoKey(value.trim()))
    && (!lenEnforced || value.length <= (opts.long ? LEN_LONG : LEN_SHORT));   // 異常輸入防線：巢狀同一道牆（寫作欄 long；還原路關閉＝lenEnforced）
  if (ok) out[key] = value;
  else errors.push(`${path}.${key}`);
}

/**
 * @param {any} src @param {Record<string, any>} out @param {string} key @param {string} path
 * @param {string[]} errors @param {{min?:number,max?:number,integer?:boolean,nullable?:boolean}} [opts]
 */
function researchNumber(src, out, key, path, errors, opts = {}) {
  if (!(key in src)) return;
  const value = src[key];
  if (value === null && opts.nullable) { out[key] = null; return; }
  const ok = typeof value === 'number' && Number.isFinite(value)
    && (!opts.integer || Number.isInteger(value))
    && (opts.min === undefined || value >= opts.min)
    && (opts.max === undefined || value <= opts.max);
  if (ok) out[key] = value;
  else errors.push(`${path}.${key}`);
}

/** @param {any} input @param {string} path @param {string[]} errors */
function sanitizeScorecard(input, path, errors) {
  if (input === null) return null;
  const src = researchObject(input, path, [...RESEARCH_SCORE_KEYS, 'reasons'], errors);
  if (!src) return undefined;
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of RESEARCH_SCORE_KEYS) researchNumber(src, out, key, path, errors, { min: 0, max: 5, integer: true });
  if ('reasons' in src) {
    const reasons = researchObject(src.reasons, `${path}.reasons`, RESEARCH_SCORE_KEYS, errors);
    if (reasons) {
      /** @type {Record<string, any>} */
      const clean = {};
      for (const key of RESEARCH_SCORE_KEYS) researchString(reasons, clean, key, `${path}.reasons`, errors, { long: true });
      out.reasons = clean;
    }
  }
  return out;
}

/** @param {any} input @param {string} path @param {string[]} errors */
function sanitizeValuationScenarios(input, path, errors) {
  if (input === null) return null;
  const allowed = ['currency', 'asOf', 'method', 'bear', 'base', 'bull', 'assumptions'];
  const src = researchObject(input, path, allowed, errors);
  if (!src) return undefined;
  /** @type {Record<string, any>} */
  const out = {};
  researchString(src, out, 'currency', path, errors, { values: CURRENCIES });
  researchString(src, out, 'asOf', path, errors, { date: true });
  researchString(src, out, 'method', path, errors);
  researchString(src, out, 'assumptions', path, errors, { long: true });   // 假設＝寫作欄
  for (const key of ['bear', 'base', 'bull']) researchNumber(src, out, key, path, errors);
  return out;
}

/**
 * @param {any} input @param {string} path @param {string[]} errors
 * @param {(item:any,path:string,errors:string[])=>Record<string,any>} mapper
 */
function sanitizeResearchArray(input, path, errors, mapper) {
  if (!Array.isArray(input)) { errors.push(path); return undefined; }
  /** @type {Record<string, any>[]} */
  const out = [];
  input.forEach((item, index) => {
    if (!isObj(item)) { errors.push(`${path}[${index}]`); return; }
    out.push(mapper(item, `${path}[${index}]`, errors));
  });
  return out;
}

/** @param {any} item @param {string} path @param {string[]} errors */
function sanitizeCheckpoint(item, path, errors) {
  const src = researchObject(item, path, ['date', 'note'], errors) || {};
  /** @type {Record<string, any>} */
  const out = {};
  researchString(src, out, 'date', path, errors, { monthOrDate: true });
  researchString(src, out, 'note', path, errors, { long: true });   // 檢查點筆記＝寫作欄
  return out;
}

/** @param {any} item @param {string} path @param {string[]} errors */
function sanitizeCatalyst(item, path, errors) {
  const src = researchObject(item, path, ['id', 'text', 'horizon', 'status'], errors) || {};
  /** @type {Record<string, any>} */
  const out = {};
  researchString(src, out, 'id', path, errors, { protoValue: true });
  researchString(src, out, 'text', path, errors, { long: true });   // 敘述＝寫作欄
  researchString(src, out, 'horizon', path, errors);
  researchString(src, out, 'status', path, errors, { values: CATALYST_STATUS });
  return out;
}

/** @param {any} item @param {string} path @param {string[]} errors */
function sanitizeThesisBreaker(item, path, errors) {
  const src = researchObject(item, path, ['id', 'text', 'status'], errors) || {};
  /** @type {Record<string, any>} */
  const out = {};
  researchString(src, out, 'id', path, errors, { protoValue: true });
  researchString(src, out, 'text', path, errors, { long: true });   // 敘述＝寫作欄
  researchString(src, out, 'status', path, errors, { values: BREAKER_STATUS });
  return out;
}

/** @param {any} item @param {string} path @param {string[]} errors */
function sanitizeWatchMetric(item, path, errors) {
  const src = researchObject(item, path, ['id', 'label', 'unit', 'value', 'period', 'source'], errors) || {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of ['id', 'label', 'unit', 'period', 'source']) researchString(src, out, key, path, errors, { protoValue: key === 'id' });
  researchNumber(src, out, 'value', path, errors, { nullable: true });
  return out;
}

/** @param {any} item @param {string} path @param {string[]} errors */
function sanitizeSource(item, path, errors) {
  const src = researchObject(item, path, ['id', 'label', 'url', 'asOf'], errors) || {};
  /** @type {Record<string, any>} */
  const out = {};
  researchString(src, out, 'id', path, errors, { protoValue: true });
  researchString(src, out, 'label', path, errors);
  researchString(src, out, 'url', path, errors, { url: true });
  researchString(src, out, 'asOf', path, errors, { date: true });
  return out;
}

/** @param {any} item @param {string} path @param {string[]} errors */
function sanitizeScoreHistory(item, path, errors) {
  const src = researchObject(item, path, ['date', 'total', 'scores'], errors) || {};
  /** @type {Record<string, any>} */
  const out = {};
  researchString(src, out, 'date', path, errors, { date: true });
  researchNumber(src, out, 'total', path, errors, { min: 0, max: 100 });
  if ('scores' in src) {
    const scores = researchObject(src.scores, `${path}.scores`, RESEARCH_SCORE_KEYS, errors);
    if (scores) {
      /** @type {Record<string, any>} */
      const clean = {};
      for (const key of RESEARCH_SCORE_KEYS) researchNumber(scores, clean, key, `${path}.scores`, errors, { min: 0, max: 5, integer: true });
      out.scores = clean;
    }
  }
  return out;
}

/**
 * 清理一筆 research；保留未知頂層欄位以相容既有備份／服務欄位，但巢狀物件只收明定契約。
 * errors 非空＝CRUD／匯入必須 400、store throw；strip 搬家模式則保留合法部分並大聲警告。
 * @param {any} input @returns {{item:Record<string,any>, errors:string[]}}
 */
export function sanitizeResearchItem(input) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, any>} */
  const out = isObj(input) ? { ...input } : {};
  if (!isObj(input)) return { item: out, errors: ['research'] };
  for (const key of Object.keys(out)) {
    if (isProtoKey(key)) { errors.push(`research.${key}`); delete out[key]; }
  }
  if ('symbol' in out) {
    const raw = out.symbol;
    if (typeof raw !== 'string' || isProtoKey(raw.trim())) {
      errors.push('symbol');
      delete out.symbol;
    } else {
      out.symbol = normalizePortfolioSymbol(raw);
      if (!out.symbol) { errors.push('symbol'); delete out.symbol; }
    }
  }
  for (const key of ['thesis', 'metrics', 'risks']) {
    if (key in out && out[key] !== null && typeof out[key] !== 'string') { errors.push(key); delete out[key]; }
  }
  if ('status' in out && !RESEARCH_STATUS.includes(out.status)) { errors.push('status'); delete out.status; }
  if ('lastReviewedAt' in out) {
    if (out.lastReviewedAt === null || out.lastReviewedAt === '') out.lastReviewedAt = '';
    else if (!isRealDate(out.lastReviewedAt)) { errors.push('lastReviewedAt'); delete out.lastReviewedAt; }
  }
  if ('scorecard' in out) out.scorecard = sanitizeScorecard(out.scorecard, 'scorecard', errors);
  if ('valuationScenarios' in out) out.valuationScenarios = sanitizeValuationScenarios(out.valuationScenarios, 'valuationScenarios', errors);
  /** @type {[string, (item:any,path:string,errors:string[])=>Record<string,any>][]} */
  const arrays = [
    ['checkpoints', sanitizeCheckpoint],
    ['catalysts', sanitizeCatalyst],
    ['thesisBreakers', sanitizeThesisBreaker],
    ['watchMetrics', sanitizeWatchMetric],
    ['sources', sanitizeSource],
    ['scoreHistory', sanitizeScoreHistory],
  ];
  for (const [key, mapper] of arrays) {
    if (!(key in out)) continue;
    out[key] = sanitizeResearchArray(out[key], key, errors, mapper);
  }
  return { item: out, errors };
}

/** 同代號只能一筆研究；Map/Set 不走物件原型鏈。 @param {any[]} items */
export function duplicateResearchSymbols(items) {
  const seen = new Set(), duplicates = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const symbol = normalizePortfolioSymbol(item?.symbol);
    if (!symbol) continue;
    if (seen.has(symbol)) duplicates.add(symbol); else seen.add(symbol);
  }
  return [...duplicates];
}

/** @param {any[]} items @param {any} symbol @param {any} [exceptId] */
export function researchSymbolExists(items, symbol, exceptId = null) {
  const wanted = normalizePortfolioSymbol(symbol);
  return Boolean(wanted) && (Array.isArray(items) ? items : []).some(item =>
    normalizePortfolioSymbol(item?.symbol) === wanted && (exceptId == null || String(item?.id || '') !== String(exceptId)));
}

/**
 * 數值欄位驗證：接受 finite number、null（清空，openForm 空白時送 null）、或數字字串（轉成 number）；
 * 其餘（'oops'、NaN、空字串）視為不合法。 @param {any} v @returns {{ok: boolean, value?: any}}
 */
function coerceNum(v) {
  if (v === null) return { ok: true, value: null };
  if (typeof v === 'number') return isFinite(v) ? { ok: true, value: v } : { ok: false };
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return { ok: true, value: Number(v) };
  return { ok: false };
}

/**
 * 依欄位型別驗證/轉換一個值。回傳 { ok, value?, reject? }：
 * ok＝合法（value＝清理後值）；ok:false＋reject:true＝必須拒絕（枚舉/布林非法值，剝掉會留下危險預設）；
 * ok:false＋reject:false＝可安全剝掉（數值壞值→預設 0；非陣列→預設 []）。
 * @param {'number'|'boolean'|'array'|'object'|'str'|'date'|'datetime'|'month'|'monthreq'|'datereq'|string[]|undefined} spec @param {any} v
 * @returns {{ok: boolean, value?: any, reject?: boolean}}
 */
function validateField(spec, v) {
  if (spec === undefined) return { ok: true, value: v };                 // 自由字串：放行
  if (Array.isArray(spec)) {                                             // 枚舉：非法→拒絕（剝掉會落到危險預設，如 cycle→月繳、type→資產）
    return (typeof v === 'string' && spec.includes(v)) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'number') { const r = coerceNum(v); return r.ok ? r : { ok: false, reject: false }; }   // 數值壞值→安全剝掉（→0）
  if (spec === 'boolean') {                                             // 布林：擋 'false' 字串被當 truthy；非法→拒絕
    if (typeof v === 'boolean') return { ok: true, value: v };
    if (v === 'true') return { ok: true, value: true };
    if (v === 'false') return { ok: true, value: false };
    return { ok: false, reject: true };
  }
  if (spec === 'array') {                                               // 非陣列→安全剝掉（→[]）；陣列→過濾掉非物件元素（擋 [null] 讓讀取端崩）
    return Array.isArray(v) ? { ok: true, value: v.filter(isObj) } : { ok: false, reject: false };
  }
  if (spec === 'object') return isObj(v) ? { ok: true, value: v } : { ok: false, reject: true };
  if (spec === 'str') {                                                 // 必須是字串（null＝清空可）；數字代號會讓 .toUpperCase() 崩
    return (typeof v === 'string' || v === null) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'date') {                                                // YYYY-MM-DD 或空（未設）；null 矯正為 ''（Codex#10-2：讀取端 .slice/.startsWith 遇 null 會崩）
    if (v === null || v === '') return { ok: true, value: '' };
    return isRealDate(v) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'datetime') return isRealInstant(v) ? { ok: true, value: v } : { ok: false, reject: true };
  if (spec === 'month') {                                               // YYYY-MM 或空；null 矯正為 ''
    if (v === null || v === '') return { ok: true, value: '' };
    return isRealMonth(v) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'monthreq') {                                            // 必填月份（history/快照的主鍵欄，空值也是壞資料）
    return isRealMonth(v) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'datereq') {                                             // 必填日期（日線的主鍵欄，空值/壞格式都是壞資料）
    return isRealDate(v) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  return { ok: true, value: v };
}

// 估值訊號的手動輸入（openForm number 欄位→送 number 或 null；預設值為空字串）——
// 接受 null／空字串／finite number／數字字串，擋掉 'oops'（capeManual 會餵 Number() 算 ECY）。
const okManual = (/** @type {any} */ v) => v === null || v === '' || isNum(v)
  || (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)));

/**
 * 通用 CRUD 白名單＋數值型別過濾。只保留白名單內的欄位；數值欄位驗證型別（壞值剝掉、保留原值）。
 * @param {string} col @param {Record<string, any>} body @returns {Record<string, any>}
 */
export function pickWritable(col, body) {
  const allow = WRITABLE_FIELDS[col];
  if (!allow || !isObj(body)) return { value: {}, errors: [] };
  const schema = FIELD_SCHEMA[col] || {};
  /** @type {Record<string, any>} */
  const out = {};
  const dropped = [];
  /** @type {string[]} */
  const errors = [];
  for (const [k, v] of Object.entries(body)) {
    if (!allow.includes(k)) { dropped.push(k); continue; }
    const r = validateField(schema[k], v);
    if (r.ok) {
      const lenBad = lengthErrorOf(col, k, r.value);   // 異常輸入防線：超長＝400 點名，不靜默截斷
      if (lenBad) { errors.push(lenBad); continue; }
      out[k] = r.value;
    }
    else if (r.reject) errors.push(k);       // 枚舉/布林非法：呼叫端回 400（不可靜默落到危險預設）
    else dropped.push(`${k}(型別)`);          // 數值/陣列壞值：安全剝掉
  }
  // ⚠️ **`issuer` 與 `issuerId` 是同一個身分的兩半**（2026-09-02，Codex #547 r1 第 1 條，高、阻擋）：
  //    櫃檯把它們當兩個獨立欄位收，而 `PUT` 是部分更新、`lib/repo.js` 淺合併 ⇒ **只送 `issuer`、
  //    不送 `issuerId` 的寫入會留下前一次的代號**，那張卡從此「畫面寫甲、代號是乙」。
  //    ⚠️ 這不是只有手改資料庫才做得到：使用者升級後**沒有重新整理的舊分頁**跑的是舊版 `cards.js`，
  //    它只送 `issuer` ⇒ 按一次儲存就產生一張矛盾的卡。所以在櫃檯就把它接起來：**送了顯示名、
  //    卻沒送代號 ⇒ 代號一起清掉**（＝退回文字判準，與升級前逐字相同的行為）。
  //    ⚠️ **只做這一個方向**：反過來「只送 `issuerId` 不送 `issuer`」**不補顯示名**——櫃檯替使用者
  //    編一段畫面文字，等於讓卡片上出現他沒打過的字（這個 repo 的規矩是不可靜靜改掉使用者資料）。
  //    那個方向的安全由判準側收口：顯示名沒有確認代號時 `cardCode` 回 `unconfirmed`，
  //    身分是「說不清楚」而不是「照代號算」。⚠️ 這一格有考題釘住**不可以反向補值**。
  //    ⚠️ 只在**真的有送 `issuer`** 時才動：只改卡片名稱的 PUT 不可以順手把代號清掉。
  if (col === 'cards' && 'issuer' in out && !('issuerId' in out)) out.issuerId = '';
  if (col === 'research') {
    const deep = sanitizeResearchItem(out);
    Object.assign(out, deep.item);
    for (const key of Object.keys(out)) if (!(key in deep.item)) delete out[key];
    errors.push(...deep.errors);
  }
  if (dropped.length) console.warn(`[schema] ${col} 寫入剝掉了白名單外/型別不符的欄位：${dropped.join(', ')}（若是新功能欄位，記得補進 lib/schema.js）`);
  return { value: out, errors };
}

/**
 * 匯入用：驗一筆資料。回傳 { item, errors }——item＝清理後物件（數值/陣列壞值剝掉、陣列過濾壞元素，
 * 其餘含 id 原樣保留）；非物件回 item:null（呼叫端過濾）；errors＝枚舉/布林非法欄位（呼叫端拒絕整份匯入）。
 * @param {string} col @param {any} item @returns {{item: any|null, errors: string[]}}
 */
export function validateImportItem(col, item) {
  if (!isObj(item)) return { item: null, errors: [] };
  const schema = FIELD_SCHEMA[col];
  if (!schema) return { item, errors: [] };
  let out = { ...item };
  /** @type {string[]} */
  const errors = [];
  for (const f of missingRequired(col, out)) errors.push(`${f}(缺必填)`);
  for (const [k, spec] of Object.entries(schema)) {
    if (!(k in out)) continue;
    const r = validateField(spec, out[k]);
    if (r.ok) out[k] = r.value;
    else if (r.reject) errors.push(k);
    else {
      // 必填欄位「有填但格式不合法」不可只默默剝欄（Codex r2 收官複審#1：剝完 errors 仍空、
      // 匯入放行 → 到寫入櫃檯才因缺必填炸出＝備份還原變不精準的 500，應在這裡就 400 點名病因）
      if ((REQUIRED_FIELDS[col] || []).includes(k)) errors.push(`${k}(必填值格式不合法)`);
      delete out[k];
    }
  }
  if (col === 'research') {
    const deep = sanitizeResearchItemLenient(out);   // 還原路＝長度寬容（舊研究不可被 400 擋在門外）
    out = deep.item;
    errors.push(...deep.errors);
    for (const f of missingRequired(col, out)) errors.push(`${f}(缺必填)`);
  }
  // 異常輸入防線**刻意不驗匯入**（撞既有考題後想清楚的決定）：/api/import＝備份還原＝舊資料回家的
  // 唯一一條路，裁決明定「合法舊資料不可因升級被刪」——防線上線前寫入的超長欄位若在這裡 400，
  // 舊備份就永遠救不回來（#201 的 >1MB 還原考題正是釘這件事）。長度 400 只擋**新輸入**（pickWritable）；
  // 還原進來的超長資料由櫃檯 warn 留紀錄，之後被編輯時自然會被 400 要求修短。
  const ruleBad = rowRuleError(col, out);
  if (ruleBad) errors.push(ruleBad);   // 跨欄不變式（Codex S3r2#4）：匯入逐筆收集錯誤→整份 400
  return { item: out, errors };
}

/**
 * 匯入用：清理 learnedCategories map（value 非物件就丟棄；category/subcategory/name 非字串就丟該鍵）。
 * 避免 { bad: null } 讓設定頁讀 v.name 崩。 @param {any} lc @returns {Record<string, any>}
 */
export function sanitizeLearned(lc) {
  if (!isObj(lc)) return emptyMap();
  // null prototype ＋ 丟掉原型名的鍵（Codex r4#1）：這裡是學習表進出資料庫的必經之路，
  // 在這裡擋住，既有資料被污染過也會在下次寫入時清乾淨。
  const out = emptyMap();
  for (const [key, v] of Object.entries(lc)) {
    if (isProtoKey(key)) { console.warn(`[schema] 學習表丟棄保留字 key：${key}`); continue; }
    if (!isObj(v)) continue;
    /** @type {Record<string, any>} */
    const e = {};
    for (const f of ['category', 'subcategory', 'name']) if (typeof v[f] === 'string') e[f] = v[f];
    out[key] = e;
  }
  return out;
}

/**
 * 清理 learnedBank map（銀行對帳單收支學習：{ bankKey → {type, category, subcategory, name?} }）。
 * value 非物件丟棄；type 只收 income/expense/transfer（缺／壞值就丟該筆——沒有 type 無法定收支方向、
 * 套用會出錯，資料安全優先）；category/subcategory/name 非字串就丟該欄。 @param {any} lb @returns {Record<string, any>}
 */
export function sanitizeLearnedBank(lb) {
  if (!isObj(lb)) return emptyMap();
  const out = emptyMap();
  for (const [key, v] of Object.entries(lb)) {
    if (isProtoKey(key)) { console.warn(`[schema] 銀行學習表丟棄保留字 key：${key}`); continue; }
    if (!isObj(v)) continue;
    if (!['income', 'expense', 'transfer'].includes(v.type)) continue;   // 無合法 type ＝壞筆，整筆丟（免套用時方向錯）
    /** @type {Record<string, any>} */
    const e = { type: v.type };
    for (const f of ['category', 'subcategory', 'name']) if (typeof v[f] === 'string') e[f] = v[f];
    out[key] = e;
  }
  return out;
}

// 內轉子分類（使用者定 2026-07-21，「全部都能改」）：每項 {label, role?}，role＝out/in/settle 三個系統角色
// （自動分類的內轉出/內轉入/交割靠 role 跟著改名走）。預設放這裡讓「效力/清理」都指向同一份。
/** @type {{label:string, role?:'out'|'in'|'settle'}[]} */
export const DEFAULT_TRANSFER_SUBS = [
  { label: '內轉出', role: 'out' }, { label: '內轉入', role: 'in' }, { label: '交割', role: 'settle' },
];
const TRANSFER_ROLES = ['out', 'in', 'settle'];
/**
 * 清理內轉子分類清單：每項 label＝非空字串（去重、去保留字），role 只收 out/in/settle（每個角色至多一項）。
 * 空／全壞 → 回預設（避免內轉沒有任何子分類可選）。 @param {any} input @returns {{label:string, role?:'out'|'in'|'settle'}[]}
 */
export function sanitizeTransferSubs(input) {
  const arr = Array.isArray(input) ? input : [];
  /** @type {{label:string, role?:'out'|'in'|'settle'}[]} */
  const out = [];
  const seenLabel = new Set(), seenRole = new Set();
  for (const it of arr) {
    const label = (it && typeof it.label === 'string') ? it.label.trim() : '';
    if (!label || isProtoKey(label) || seenLabel.has(label)) continue;
    seenLabel.add(label);
    const role = (it && TRANSFER_ROLES.includes(it.role) && !seenRole.has(it.role))
      ? /** @type {'out'|'in'|'settle'} */ (it.role) : undefined;
    if (role) seenRole.add(role);
    out.push(role ? { label, role } : { label });
  }
  return out.length ? out : DEFAULT_TRANSFER_SUBS.map(x => ({ ...x }));
}

const INSIGHT_TIER_MARKETS = ['us', 'china', 'japan', 'korea', 'taiwan'];
/**
 * 清理 insightState 書籤（每日洞察引擎 D3；**單一物件、非 map**）。服務層 getInsights 專寫、非 CRUD 白名單。
 * 形狀：lastSeenAt/prevSeenAt＝字串；netWorth/pfValue/usdTwd＝finite number；reminders＝[{key,title,module,level}
 * 皆字串、key 非空]；tiers＝{us,china,japan,korea,taiwan}＝number 或 null。壞欄位丟棄；非物件→{}（＝視為首次執行，
 * getInsights 對空書籤安全降級）。防「還原壞備份/手改 store」讓差異引擎讀到壞形狀而崩。 @param {any} st @returns {Record<string, any>}
 */
export function sanitizeInsightState(st) {
  if (!isObj(st)) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const f of ['lastSeenAt', 'prevSeenAt']) if (typeof st[f] === 'string') out[f] = st[f];
  for (const f of ['netWorth', 'pfValue', 'usdTwd']) if (typeof st[f] === 'number' && Number.isFinite(st[f])) out[f] = st[f];
  if (Array.isArray(st.reminders)) {
    out.reminders = st.reminders.filter(isObj).map((/** @type {any} */ r) => ({
      key: typeof r.key === 'string' ? r.key : '',
      title: typeof r.title === 'string' ? r.title : '',
      module: typeof r.module === 'string' ? r.module : '',
      level: typeof r.level === 'string' ? r.level : '',
    })).filter((/** @type {any} */ r) => r.key);
  }
  if (isObj(st.tiers)) {
    /** @type {Record<string, any>} */
    const t = {};
    for (const m of INSIGHT_TIER_MARKETS) t[m] = (typeof st.tiers[m] === 'number' && Number.isFinite(st.tiers[m])) ? st.tiers[m] : null;
    out.tiers = t;
  }
  return out;
}

// ---- 櫃檯級整包驗證（B3「驗證入櫃檯」：唯一寫入口 store.save() 每次過這裡）----
// 七輪審查的病根＝「新寫入路徑繞過驗證牆」（CRUD→settings→匯入→IB 同步各補一次）。
// 結構性根治：把驗證裝在唯一的門上——任何路徑寫入都自動過牆，未來新程式想繞也繞不過。
// 兩種模式：'throw'（平時；枚舉/布林非法＝程式有 bug，當場炸出來讓考試抓）
//          'strip'（搬家/匯入舊資料；剝掉壞值＋大聲警告，不讓舊資料卡死系統）。

/** 全部集合（含無 FIELD_SCHEMA 的 snapshots——仍過「每筆須為物件」關）。 */
export const ALL_COLLECTIONS = [...COLLECTIONS, ...READONLY_COLLECTIONS, 'snapshots'];

/**
 * 寫入前驗證/清理整包資料庫物件。回傳清理後的新物件；結構性錯誤（不是物件、集合不是陣列）一律 throw。
 * @param {any} input
 * @param {{mode?: 'throw'|'strip'}} [opts]
 * @returns {Record<string, any>}
 */
export function sanitizeDbForWrite(input, opts = {}) {
  const mode = opts.mode || 'throw';
  if (!isObj(input) || !isObj(input.settings)) throw new Error('[schema] 寫入的不是合法資料庫物件（缺 settings）');
  /** @type {Record<string, any>} */
  const out = { ...input };
  /** @type {string[]} */
  const warns = [];
  for (const col of ALL_COLLECTIONS) {
    if (!(col in out)) continue;
    if (!Array.isArray(out[col])) throw new Error(`[schema] 集合 ${col} 必須是陣列（寫入端程式有誤）`);
    const schema = FIELD_SCHEMA[col];
    const cleaned = [];
    out[col].forEach((/** @type {any} */ item, /** @type {number} */ i) => {
      if (!isObj(item)) { warns.push(`${col}[${i}] 非物件已濾除`); return; }
      if (!schema) { cleaned.push(item); return; }
      let o = { ...item };
      const miss = missingRequired(col, o);
      if (miss.length) {
        if (mode === 'throw') throw new Error(`[schema] ${col}[${i}] 缺必填欄位 ${miss.join('/')}——寫入端漏了驗證，請修程式`);
        warns.push(`${col}[${i}] 缺必填 ${miss.join('/')} 已整筆濾除`);
        return;
      }
      const required = REQUIRED_FIELDS[col] || [];
      let dropItem = false;
      for (const [k, spec] of Object.entries(schema)) {
        if (!(k in o)) continue;
        const r = validateField(spec, o[k]);
        if (r.ok) { o[k] = r.value; continue; }
        if (r.reject && mode === 'throw') throw new Error(`[schema] ${col}[${i}].${k} 值不合法（${JSON.stringify(o[k])}）——寫入端漏了驗證，請修程式`);
        // 必填欄位格式不合法（Codex#12-1，高）：strip 模式不能只刪該欄位——會留下「缺主鍵」的壞筆
        //（month='bad' 或數字 month → 刪掉 month 後 history/投組/快照讀取端 .slice/.split 仍崩）。整筆濾除才安全。
        if (required.includes(k)) { warns.push(`${col}[${i}].${k} 必填值格式不合法（${JSON.stringify(o[k])}）已整筆濾除`); dropItem = true; break; }
        warns.push(`${col}[${i}].${k} 壞值已剝除`);
        delete o[k];
      }
      if (dropItem) return;
      if (col === 'research') {
        const deep = sanitizeResearchItemLenient(o);   // 櫃檯＝長度寬容（同上；型別/枚舉/URL 驗證照舊）
        o = deep.item;
        if (deep.errors.length) {
          if (mode === 'throw') throw new Error(`[schema] ${col}[${i}] 巢狀欄位不合法：${deep.errors.join('/')}——寫入端漏了驗證，請修程式`);
          warns.push(`${col}[${i}] 巢狀壞值已清理：${deep.errors.join('/')}`);
        }
        const deepMiss = missingRequired(col, o);
        if (deepMiss.length) {
          if (mode === 'throw') throw new Error(`[schema] ${col}[${i}] 缺必填欄位 ${deepMiss.join('/')}——寫入端漏了驗證，請修程式`);
          warns.push(`${col}[${i}] 深層清理後缺必填 ${deepMiss.join('/')} 已整筆濾除`);
          return;
        }
      }
      const ruleBad = rowRuleError(col, o);
      if (ruleBad) {
        if (mode === 'throw') throw new Error(`[schema] ${col}[${i}] ${ruleBad}——寫入端漏了驗證，請修程式`);
        warns.push(`${col}[${i}] ${ruleBad}，已整筆濾除`);
        return;
      }
      // 異常輸入防線：櫃檯對超長**兩種模式都只 warn、不 throw 不剝不截**——超長能走到這裡的
      // 唯一合法來源是「備份還原／搬家的舊資料」（新輸入已被 pickWritable 400 擋在門外），
      // 而裁決明定合法舊資料不可因升級被刪；throw 會把還原變成 500（Codex r2 收官複審#1 同款教訓）。
      for (const [k, v] of Object.entries(o)) {
        const lenBad = typeof v === 'string' ? lengthErrorOf(col, k, v) : null;
        if (lenBad) warns.push(`${col}[${i}].${k} ${lenBad}（舊資料放行、不剝不截）`);
      }
      cleaned.push(o);
    });
    // r1#2（P2-2）：parseRecipes 的 id 是票與記帳的列身分——**集合級唯一**才有意義（重複 id＝
    // route 可命中後列、記帳只 find 前列＝計數打錯人、疑似標記整族全標）。保留先到者、後到濾除。
    if (col === 'parseRecipes') {
      const seen = new Set();
      const unique = cleaned.filter((/** @type {any} */ r) => {
        if (seen.has(r.id)) { warns.push(`${col} 重複 id「${r.id}」的後到列已濾除`); return false; }
        seen.add(r.id); return true;
      });
      if (unique.length !== cleaned.length && mode === 'throw') throw new Error('[schema] parseRecipes 有重複 id——寫入端漏了驗證，請修程式');
      out[col] = unique;
    } else {
      out[col] = cleaned;
    }
  }
  const duplicateResearch = duplicateResearchSymbols(out.research || []);
  if (duplicateResearch.length) {
    // 即使是 strip 搬家模式也不能任選一筆丟掉：兩份研究都可能含唯一的人工作業，必須由使用者決定如何合併。
    throw new Error(`[schema] research 有重複代號：${duplicateResearch.join('、')}——請合併研究後再寫入`);
  }
  if ('learnedCategories' in out) out.learnedCategories = sanitizeLearned(out.learnedCategories);
  if ('learnedBank' in out) out.learnedBank = sanitizeLearnedBank(out.learnedBank);
  if ('transferSubs' in out) out.transferSubs = sanitizeTransferSubs(out.transferSubs);
  if ('insightState' in out) out.insightState = sanitizeInsightState(out.insightState);
  // settings 也要過櫃檯（Codex#8-2：漏了這塊＝usdTwd:'oops' 仍可繞過 /api/settings 與匯入的防線直接寫入）
  const sres = sanitizeSettingsDeep(out.settings);
  if (sres.bad.length) {
    if (mode === 'throw') throw new Error(`[schema] settings 含非法值：${sres.bad.join(', ')}——寫入端漏了驗證，請修程式`);
    warns.push(...sres.bad.map(b => b + ' 壞值已剝除'));
  }
  out.settings = sres.value;
  if (warns.length) console.warn(`[schema] 櫃檯寫入清理（${mode}）：${warns.slice(0, 10).join('；')}${warns.length > 10 ? `…共 ${warns.length} 筆` : ''}`);
  return out;
}

/**
 * settings 的「整包深度驗證」（櫃檯用，與路由層 sanitizeSettings 的差別：這裡驗「已存在的完整 settings」，
 * 已知欄位驗型別、巢狀 signals/fxTwd/ib（含 IB 同步欄位內層）都驗；未知頂層欄位放行（不參與計算、無害，
 * 且未來新欄位不會被櫃檯默默吃掉）。回傳 { value: 清理後(壞值已移除), bad: 壞欄位清單 }。
 * @param {any} input @returns {{value: Record<string, any>, bad: string[]}}
 */
/**
 * 一個設定值合不合法。**兩個消毒器共用這一份**（`sanitizeSettingsDeep` 走訪已知欄位、
 * `sanitizeSettings` 走訪前端送來的鍵）——它們原本各自手抄一份 `kind === …` 的長三元式，
 * 而 2026-08-14 加第一個 `'bool'` 欄位（`aiAskBeforeSend`）時**只有一份學會**：
 * PUT /api/settings 靜靜把它剝掉、畫面照樣回報「已儲存」⇒ 那顆開關永遠打不開。
 * 這不是打字失誤，是「同一份判準有兩個複本」必然會發生的事，所以收成一份。
 * ⚠️ 認不得的 kind 一律 `false`（fail-closed）：新型別沒登記就存不進去，
 * 比「靜靜當成 manual 放行」安全——後者會讓沒驗過的值進資料庫。
 * @param {string|undefined} kind `SETTINGS_FIELD_TYPES` 裡登記的型別；不在白名單＝undefined
 * @param {any} v
 */
function settingValueOk(kind, v) {
  switch (kind) {
    case 'number': return isNum(v);
    case 'posnum': return isNum(v) && v > 0;
    case 'posnumopt': return v === null || (isNum(v) && v > 0);
    case 'string': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'manual': return okManual(v);
    default: return false;
  }
}

export function sanitizeSettingsDeep(input) {
  /** @type {string[]} */
  const bad = [];
  if (!isObj(input)) return { value: {}, bad: ['settings(非物件)'] };
  /** @type {Record<string, any>} */
  const out = { ...input };
  for (const [k, kind] of Object.entries(SETTINGS_FIELD_TYPES)) {
    if (!(k in out)) continue;
    const v = out[k];
    const ok = settingValueOk(kind, v);
    if (!ok) { bad.push('settings.' + k); delete out[k]; }
  }
  // quotesLastAt（D1）＝報價上次更新時間，**server-owned**（refreshQuotesIfStale 寫，仿 ib.lastSync）：不在
  // SETTINGS_FIELD_TYPES 故前端 PUT /settings 收不進（sanitizeSettings 白名單外自動丟）；這裡只驗字串放行 server 寫入。
  if ('quotesLastAt' in out && typeof out.quotesLastAt !== 'string') { bad.push('settings.quotesLastAt'); delete out.quotesLastAt; }
  // 規則卡出生統計（2026-08-19）：**server-owned**（前端 PUT 寫不進來）。寫入門有兩個：服務層的
  // `repo.updateRecipeBirthStats`（applyBankStatement 在配方生成之後呼叫）與**備份還原**（下面那段，
  // 照樣過消毒器）——不列進 SETTINGS_FIELD_TYPES ⇒ 前端 PUT /settings 自動丟掉（同 quotesLastAt
  // 的既有作法）。這裡是**匯入備份**那條路的消毒：手改過的備份不得把壞形狀（或膨脹的鍵）帶進 db。
  if ('recipeBirthStats' in out) {
    const cleanBirth = sanitizeBirthStats(out.recipeBirthStats);
    if (Object.keys(cleanBirth).length) out.recipeBirthStats = cleanBirth;
    else {
      // ⚠️ **空表是合法狀態**（還沒學過任何版面、或使用者剛清空）——只有「整欄根本不是物件」才算壞值。
      //   把空表當非法會讓 sanitizeDbForWrite 的 throw 模式直接擋掉一次正常寫入（我自己的新考題當場踩到）。
      if (out.recipeBirthStats != null && typeof out.recipeBirthStats !== 'object') bad.push('settings.recipeBirthStats');
      delete out.recipeBirthStats;
    }
  }
  if ('signals' in out) {
    if (!isObj(out.signals)) { bad.push('settings.signals'); delete out.signals; }
    else {
      const sig = { ...out.signals };
      for (const k of SIGNALS_WRITABLE_FIELDS) if (k in sig && !okManual(sig[k])) { bad.push('signals.' + k); delete sig[k]; }
      out.signals = sig;
    }
  }
  if ('fxTwd' in out) {
    if (!isObj(out.fxTwd)) { bad.push('settings.fxTwd'); delete out.fxTwd; }
    else {
      const fx = { ...out.fxTwd };
      for (const [c, r] of Object.entries(fx)) if (!(isNum(r) && r > 0)) { bad.push('fxTwd.' + c); delete fx[c]; }
      out.fxTwd = fx;
    }
  }
  if ('ib' in out) {
    if (!isObj(out.ib)) { bad.push('settings.ib'); out.ib = {}; }
    else {
      const ib = { ...out.ib };
      for (const f of IB_WRITABLE_FIELDS) if (f in ib && typeof ib[f] !== 'string') { bad.push('ib.' + f); delete ib[f]; }
      if ('lastSync' in ib && !(ib.lastSync === null || typeof ib.lastSync === 'string')) { bad.push('ib.lastSync'); delete ib.lastSync; }
      if ('lastEquity' in ib) {
        const le = ib.lastEquity;
        if (!(le === null || (isObj(le) && isNum(le.stock) && isNum(le.cash) && (le.date === undefined || typeof le.date === 'string')))) {
          bad.push('ib.lastEquity'); delete ib.lastEquity;   // 壞的官方淨值→丟棄走 fallback 自算（不可讓 NaN 藏融資）
        }
      }
      if ('income' in ib && ib.income !== null) {
        if (!isObj(ib.income)) { bad.push('ib.income'); delete ib.income; }
        else {
          const inc = { ...ib.income };
          for (const nf of ['dividends', 'paymentInLieu', 'withholdingTax', 'interestPaid', 'interestReceived', 'other', 'count', 'skippedNoFx', 'skippedNoCurrency', 'estimatedNoFx']) {
            if (nf in inc && !isNum(inc[nf])) { bad.push('ib.income.' + nf); delete inc[nf]; }
          }
          if ('estimatedCurrencies' in inc && !Array.isArray(inc.estimatedCurrencies)) { bad.push('ib.income.estimatedCurrencies'); delete inc.estimatedCurrencies; }
          ib.income = inc;
        }
      }
      out.ib = ib;
    }
  }
  // 自訂分類欄（expenseTree/incomeTree/categoryAliases/subAliases）：與 sanitizeSettings 共用同一驗證器（Codex#1，勿兩處走鐘）。
  // 非物件的整欄剝除；逐項壞值剝除並記 bad（throw 模式會當場炸出，strip 模式警告）。
  const catBad = [];
  const cat = sanitizeCategorySettings(out, catBad);
  for (const f of ['expenseTree', 'incomeTree', 'categoryAliases', 'subAliases', 'incomeCategoryAliases', 'incomeSubAliases']) {
    if (!(f in out)) continue;
    if (f in cat) out[f] = cat[f]; else delete out[f];   // 整欄非物件→剝除
  }
  bad.push(...catBad);
  // 使用者自訂店名規則（第三帖）：同款處理——壞條目剝除、整欄非物件則整欄剝除
  const ruleBad = [];
  const rules = pickStoreRules(out, ruleBad);
  if ('storeRules' in out) { if ('storeRules' in rules) out.storeRules = rules.storeRules; else delete out.storeRules; }
  bad.push(...ruleBad);
  // 記住的帳單密碼池（P0.5 r1#2）：櫃檯寫入端也套上限（見 statement-password-policy 的常數），一個超大值進不了 db
  const pwPick = pickRememberedStatementPasswords(out, bad);
  if ('rememberedStatementPasswords' in out) {
    if ('rememberedStatementPasswords' in pwPick) out.rememberedStatementPasswords = pwPick.rememberedStatementPasswords;
    else delete out.rememberedStatementPasswords;
  }
  return { value: out, bad };
}

// ---- settings 白名單＋型別驗證（Codex 三輪：擋未知欄位、擋錯型別、擋 IB 同步欄位內層壞值）----
// 頂層欄位型別：number＝finite number；string＝字串；manual＝估值手動輸入（數字/空/數字字串）。
// 錯型別會讓 derive 的 Number(s.usdTwd||32) 變 NaN、污染核心計算（Codex 高severity 實測）。
// posnum＝必須為正數（Codex#6-4）：匯率/門檻是「乘數」，負數或 0 會讓資產變負或除以 0。
// posnumopt＝正數或 null：可選金額需用 null 明確清除；若只把空字串剝掉，部分更新會保留舊值、永遠清不掉。
// bool＝必須是真布林（不收 'true'／1——設定頁送的是 checkbox 的 boolean，字串會讓判準永遠為真）。
/** @type {Record<string, 'number'|'posnum'|'posnumopt'|'string'|'bool'|'manual'>} */
export const SETTINGS_FIELD_TYPES = {
  currency: 'string', usdTwd: 'posnum', emergencyFundMonths: 'number', allocationDriftPct: 'number',
  ibConcentrationPct: 'number', equityCapPct: 'number', countryCapPct: 'number', chinaCapPct: 'number',
  levCapPct: 'number', ibMaintenancePct: 'number', ibIdleCashAlert: 'number', qqqmMaxPct: 'number',
  capeManual: 'manual', fxHigh: 'posnum', fxLow: 'posnum', netWorthTarget: 'posnumopt',
  taishinSecPdfPassword: 'string',   // 台新證券對帳單 PDF 密碼（使用者 2026-07-23 拍板：比照信用卡 pdfPassword 存本機＋機密投影；空字串＝清除）
  aiAskBeforeSend: 'bool',          // AI 送出前要不要先問（William 2026-08-13 拍板＝**預設不問、直接送**；
                                    // 設定頁可打開。原 ★1 子項「每次都問」由這個開關取代——不是拿掉那個能力，
                                    // 是把預設從「問」翻成「不問」。HOSTED 停止線不受影響（那條路本來就不啟用）。
  aiDualRead: 'bool',               // 新版式雙讀（裁示⑦ 2026-08-16 拍板＝預設開）：Sonnet＋Opus 各自獨立
                                    // 解一次、程式逐欄比對錢欄位；不一致送 Fable 三讀仲裁。讀不到／壞型別＝開
                                    //（dualReadWanted；fail 方向與 aiAskBeforeSend 相反＝多驗證）。
  aiApiKey: 'string',               // AI 解析鑰匙（P1b-1，★3 拍板＝Anthropic）：使用者在設定頁貼入；比照 taishinSecPdfPassword（機密投影剝除、空字串＝清除）
  aiCapPerBill: 'posnum',           // 成本護欄 C1（William 2026-08-26）：單張帳單最多幾發 AI 呼叫（預設 6＝ai-budget.js AI_BUDGET_DEFAULTS；讀取端 capOf 取整＋至少 1，posnum 只擋型別）
  aiCapPerDay: 'posnum'             // 同上：單日最多幾發（預設 20＝防暴走保險絲，不是日常預算）
  // ⚠️ 記住的帳單密碼池（P0.5）**刻意不列在這裡**：型別 'string' 白名單＝通用 PUT/匯入可寫任意長度字串＝DoS
  //（池大小＝每次上傳的解析次數，r1#2）。改由 `pickRememberedStatementPasswords`（寫入端上限＝policy 常數）
  //   在 sanitizeSettings／sanitizeSettingsDeep 顯式接（同 storeRules 的服務層欄位模式）；讀取端另有 fail-safe 上限。
  //   JSON.stringify(string[]) 存單一字串——陣列逐元素加密走不通（AAD 用索引＝重排解不開、塌路徑＝撞 C6 不救名單）。
};
// ib 底下只有這兩個由前端寫（字串）；lastEquity／income／lastSync 是 IB 同步「擁有」的內部資料，
// 前端不可覆寫（否則能偽造官方淨值→影響槓桿/斷頭距離/提醒）。匯入備份時可保留（見 allowIbSyncFields）。
export const IB_WRITABLE_FIELDS = ['flexToken', 'flexQueryId'];
// 估值訊號的手動輸入（前端 openForm number 欄位，送 number 或 null）。
export const SIGNALS_WRITABLE_FIELDS = ['realYieldManual', 'china', 'japan', 'korea', 'taiwanPE', 'taiwanYield'];

/**
 * settings 白名單＋型別過濾。只保留「名稱在白名單、且型別正確」的欄位；其餘剝掉（console 警告）。
 * PUT /api/settings 用預設（不含 IB 同步欄位）；/api/import 用 allowIbSyncFields:true 保留備份的
 * lastEquity/income/lastSync——但深層驗型別：lastEquity.stock/cash 必須是數字，否則整個 lastEquity
 * 丟棄讓 computeLeverage 走 fallback（安全）；income 的數值欄位逐一驗、estimatedCurrencies 須陣列。
 * @param {Record<string, any>} input
 * @param {{allowIbSyncFields?: boolean, badOut?: string[]}} [opts] badOut＝把剝掉的欄位名回報給呼叫端
 *   ⚠️ allowIbSyncFields 同時也保留**其他 server-owned 欄位**（recipeBirthStats 與 aiUsage——加第三個時：顯式保留塊＋下面迴圈的 skip 名單**兩處都要**，漏了迴圈那處＝資料留了、警告說剝掉（#489 r2#4））：
 *   它們一律不在 SETTINGS_FIELD_TYPES（前端 PUT 寫不進來），但**備份還原必須帶得回來**，否則匯出→匯入
 *   會回 200 卻靜靜丟掉整份紀錄（Codex #489 r1#1 實測）。保留時照樣過 sanitizeBirthStats。
 *   （匯入端據此對自訂分類/店名規則做 fail-closed，見 routes/core.js 的 /api/import，Codex r10#3）
 * @returns {Record<string, any>}
 */
export function sanitizeSettings(input, opts = {}) {
  if (!isObj(input)) return {};
  const allowIbSyncFields = opts.allowIbSyncFields || false;
  /** @type {Record<string, any>} */
  const out = {};
  const dropped = [];
  // server-owned 欄位（不在 SETTINGS_FIELD_TYPES ⇒ 下面的白名單迴圈會丟掉）：**只有匯入備份**這條路
  // 保留，且照樣過各自的消毒器。前端 PUT 仍寫不進來（allowIbSyncFields 只有 /api/import 會傳）。
  if (allowIbSyncFields && 'recipeBirthStats' in input) {
    const cleanBirth = sanitizeBirthStats(input.recipeBirthStats);
    if (Object.keys(cleanBirth).length) out.recipeBirthStats = cleanBirth;
    else if (input.recipeBirthStats != null) dropped.push('settings.recipeBirthStats');
  }
  // aiUsage（成本護欄 C1 的單日發數）同款：備份還原保留＝保險絲跨還原仍在；消毒＝只收 {date:字串, n:有限數}
  if (allowIbSyncFields && 'aiUsage' in input) {
    const u = input.aiUsage;
    if (isObj(u) && typeof u.date === 'string' && Number.isFinite(Number(u.n)) && Number(u.n) >= 0) {
      out.aiUsage = { date: u.date, n: Math.floor(Number(u.n)) };
    } else if (u != null) dropped.push('settings.aiUsage');
  }
  // 頂層：number／string／manual
  for (const [k, v] of Object.entries(input)) {
    if (k === 'signals' || k === 'fxTwd' || k === 'ib' || k === 'expenseTree' || k === 'incomeTree' || k === 'categoryAliases' || k === 'subAliases' || k === 'incomeCategoryAliases' || k === 'incomeSubAliases' || k === 'storeRules' || k === 'rememberedStatementPasswords') continue;   // 巢狀/自訂分類/店名規則/密碼池，下面處理
    // server-owned 且**上面已顯式處理過**的鍵：不要再被當成未知欄位報一次「已剝掉」（Codex #489 r2#4：
    // 匯入時資料明明保留了、警告卻說被剝掉＝診斷說謊，未來呼叫端會把合法備份誤判成壞檔）。
    // ⚠️ 只在 allowIbSyncFields（/api/import）時跳過；PUT 路徑照舊落進 dropped＝前端仍寫不進來。
    if ((k === 'recipeBirthStats' || k === 'aiUsage') && allowIbSyncFields) continue;
    const kind = SETTINGS_FIELD_TYPES[k];
    const ok = settingValueOk(kind, v);
    if (ok) out[k] = v; else dropped.push('settings.' + k);
  }
  // signals：白名單內、估值手動輸入型別
  if (isObj(input.signals)) {
    /** @type {Record<string, any>} */
    const sig = {};
    for (const [k, v] of Object.entries(input.signals)) {
      if (SIGNALS_WRITABLE_FIELDS.includes(k) && okManual(v)) sig[k] = v; else dropped.push('signals.' + k);
    }
    out.signals = sig;
  }
  // fxTwd：幣別→匯率 map，只收「正數」匯率（Codex#6-4：負匯率會讓外幣資產變負、竄改負債）
  if (isObj(input.fxTwd)) {
    /** @type {Record<string, any>} */
    const fx = {};
    for (const [cur, rate] of Object.entries(input.fxTwd)) {
      if (isNum(rate) && rate > 0) fx[cur] = rate; else dropped.push('fxTwd.' + cur);
    }
    out.fxTwd = fx;
  }
  // ib：前端只 flexToken/flexQueryId（字串）；匯入另可保留 IB 同步欄位（深層驗型別）
  if (isObj(input.ib)) {
    /** @type {Record<string, any>} */
    const ib = {};
    for (const f of IB_WRITABLE_FIELDS) if (typeof input.ib[f] === 'string') ib[f] = input.ib[f];
    if (allowIbSyncFields) {
      if ('lastSync' in input.ib && (input.ib.lastSync === null || typeof input.ib.lastSync === 'string')) ib.lastSync = input.ib.lastSync;
      if ('lastEquity' in input.ib) {
        const le = input.ib.lastEquity;
        // 深層驗證：stock/cash 必須是數字（date 若有須字串）。不合法→丟棄整個 lastEquity，
        // computeLeverage 改走 fallback 自算（看得見的安全退化，勝過用壞值低估槓桿風險）。
        if (le === null) ib.lastEquity = null;
        else if (isObj(le) && isNum(le.stock) && isNum(le.cash) && (le.date === undefined || typeof le.date === 'string')) ib.lastEquity = le;
        else dropped.push('ib.lastEquity(內層型別)');
      }
      if ('income' in input.ib) {
        const inc = input.ib.income;
        if (inc === null) ib.income = null;
        else if (isObj(inc)) {
          const clean = { ...inc };   // 逐一剝掉非數字的數值欄位、非陣列的 estimatedCurrencies
          for (const nf of ['dividends', 'paymentInLieu', 'withholdingTax', 'interestPaid', 'interestReceived', 'other', 'count', 'skippedNoFx', 'estimatedNoFx']) {
            if (nf in clean && !isNum(clean[nf])) { delete clean[nf]; dropped.push('ib.income.' + nf); }
          }
          if ('estimatedCurrencies' in clean && !Array.isArray(clean.estimatedCurrencies)) { delete clean.estimatedCurrencies; dropped.push('ib.income.estimatedCurrencies'); }
          ib.income = clean;
        } else dropped.push('ib.income(型別)');
      }
    }
    out.ib = ib;
  }
  // 自訂分類欄（Codex#1＋收入別名 r13#3）：匯入備份必須保留 expenseTree/incomeTree/categoryAliases/subAliases/
  // incomeCategoryAliases/incomeSubAliases，否則還原後分類退回預設、改名別名消失、帳單重新歸錯類。
  // 與 sanitizeSettingsDeep 同口徑（共用 sanitizeCategorySettings：只收合法形狀、壞值剝除）。
  Object.assign(out, sanitizeCategorySettings(input, dropped));
  Object.assign(out, pickStoreRules(input, dropped));   // 店名規則同理（第三帖）：手做的規則不可因還原備份而消失
  Object.assign(out, pickRememberedStatementPasswords(input, dropped));   // 記住的帳單密碼池（P0.5）：LOCAL 匯入要保留、且寫入端上限（r1#2）
  if (dropped.length) console.warn(`[schema] settings 剝掉名稱/型別不符的欄位：${dropped.join(', ')}（IB 同步欄位 lastEquity/income/lastSync 前端本就不可寫）`);
  if (Array.isArray(opts.badOut)) opts.badOut.push(...dropped);   // 回報給呼叫端（匯入端據此 fail-closed，Codex r10#3）
  return out;
}

/**
 * 驗證/清理 settings 的自訂分類三欄（expenseTree／categoryAliases／subAliases），只保留合法形狀。
 * 供 `sanitizeSettings`（匯入白名單）與 `sanitizeSettingsDeep`（櫃檯）共用，避免兩處走鐘（Codex#1）。
 * expenseTree＝{大類:string→子類:string[]}；categoryAliases＝{string→string}；subAliases＝{string→{string→string}}。
 * @param {any} src @param {string[]=} bad 壞欄位名收集（有給才記，供呼叫端警告/櫃檯 throw）
 * @returns {Record<string, any>} 只含存在且合法的欄位（沒給就不放，維持「缺欄位＝不動」）
 */
/**
 * 驗證/清理 settings 的 `storeRules`（使用者自訂店名規則，第三帖）。與自訂分類三欄同款：
 * 供 `sanitizeSettings`（**匯入備份必須保留**——手做的規則丟了等於白做）與 `sanitizeSettingsDeep`
 *（櫃檯）共用同一個驗證器 `sanitizeStoreRules`（形狀與編譯器住同一個檔，兩者不可能走鐘）。
 * 缺欄位＝不動（維持「沒設定過就是只有內建規則」）。
 * @param {any} src @param {string[]=} bad @returns {Record<string, any>}
 */
export function pickStoreRules(src, bad) {
  if (!isObj(src) || !('storeRules' in src)) return {};
  if (!isObj(src.storeRules)) { bad?.push('settings.storeRules'); return {}; }
  return { storeRules: sanitizeStoreRules(src.storeRules, bad) };
}

/** 驗證/清理 `settings.rememberedStatementPasswords`（P0.5 匯入密碼池，機密）。
 * ⚠️ **刻意不進 `SETTINGS_FIELD_TYPES`**（r1#2 防 DoS）：那張白名單型別是 'string'＝通用 PUT/匯入可寫**任意長度
 * 字串**，而池大小＝每次上傳的解析嘗試次數，一個超大值就能讓上傳跑大量重型 PDF 解析。改走這道**寫入端上限**
 * ＝解析成 ≤`PW_MAX_N` 組、每組 ≤`PW_MAX_LEN` 字的 JSON 字串再存（讀取端 `rememberedPasswords` 另有同款 fail-safe 上限）。
 * 只在欄位存在時回 `{欄位}`，缺席回 `{}`（沿用「留空＝不變更」＝更新其他設定不誤清這欄）。
 * @param {any} src @param {string[]=} bad */
export function pickRememberedStatementPasswords(src, bad) {
  if (!isObj(src) || !('rememberedStatementPasswords' in src)) return {};
  const raw = src.rememberedStatementPasswords;
  if (raw === '') return { rememberedStatementPasswords: '' };   // 明確清除
  let arr;
  try { arr = JSON.parse(String(raw)); } catch { bad?.push('settings.rememberedStatementPasswords(非 JSON)'); return {}; }
  if (!Array.isArray(arr)) { bad?.push('settings.rememberedStatementPasswords(非陣列)'); return {}; }
  const clean = arr.filter((x) => typeof x === 'string' && x && x.length <= PW_MAX_LEN).slice(0, PW_MAX_N);
  return { rememberedStatementPasswords: clean.length ? JSON.stringify(clean) : '' };
}

export function sanitizeCategorySettings(src, bad) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!isObj(src)) return out;
  if ('expenseTree' in src) {
    if (!isObj(src.expenseTree)) { bad?.push('settings.expenseTree'); }
    else {
      /** @type {Record<string, any>} */
      const t = {};
      // __proto__ 丟棄並回報（Codex r5#4）：JSON.parse 做得出「自有 __proto__ 鍵」，
      // `t[k]=v` 對它不是寫鍵、是把 t 的原型換掉——匯入備份這條路也得設防。
      // 只丟這一個（與 sanitizeTree 同口徑）：toString 等其他原生名賦值是安全的自有鍵，舊資料容忍。
      for (const [k, v] of Object.entries(src.expenseTree)) {
        if (k === '__proto__') { bad?.push('expenseTree.__proto__（程式保留字，已丟棄）'); continue; }
        if (typeof k === 'string' && k.trim() && Array.isArray(v) && v.every(x => typeof x === 'string')) t[k] = v;
        else bad?.push('expenseTree.' + k);
      }
      out.expenseTree = t;
    }
  }
  // incomeTree（三層重構 stage 1）：收入兩層樹，形狀與 expenseTree 同款（{分類→子類[]}）、同一套防線。
  if ('incomeTree' in src) {
    if (!isObj(src.incomeTree)) { bad?.push('settings.incomeTree'); }
    else {
      /** @type {Record<string, any>} */
      const t = {};
      for (const [k, v] of Object.entries(src.incomeTree)) {
        if (k === '__proto__') { bad?.push('incomeTree.__proto__（程式保留字，已丟棄）'); continue; }
        if (typeof k === 'string' && k.trim() && Array.isArray(v) && v.every(x => typeof x === 'string')) t[k] = v;
        else bad?.push('incomeTree.' + k);
      }
      out.incomeTree = t;
    }
  }
  if ('categoryAliases' in src) {
    if (!isObj(src.categoryAliases)) { bad?.push('settings.categoryAliases'); }
    else {
      /** @type {Record<string, any>} */
      const a = {};
      for (const [k, v] of Object.entries(src.categoryAliases)) {
        if (k === '__proto__') { bad?.push('categoryAliases.__proto__（程式保留字，已丟棄）'); continue; }   // 同 expenseTree：賦值陷阱鍵
        if (typeof v === 'string') a[k] = v; else bad?.push('categoryAliases.' + k);
      }
      out.categoryAliases = a;
    }
  }
  if ('subAliases' in src) {
    if (!isObj(src.subAliases)) { bad?.push('settings.subAliases'); }
    else {
      /** @type {Record<string, any>} */
      const a = {};
      for (const [p, m] of Object.entries(src.subAliases)) {
        if (p === '__proto__') { bad?.push('subAliases.__proto__（程式保留字，已丟棄）'); continue; }   // 同上：外層 a[p]=mm 的賦值陷阱
        if (!isObj(m)) { bad?.push('subAliases.' + p); continue; }
        /** @type {Record<string, any>} */
        const mm = {};
        for (const [k, v] of Object.entries(m)) {
          if (k === '__proto__') { bad?.push('subAliases.' + p + '.__proto__（程式保留字，已丟棄）'); continue; }
          if (typeof v === 'string') mm[k] = v; else bad?.push('subAliases.' + p + '.' + k);
        }
        a[p] = mm;
      }
      out.subAliases = a;
    }
  }
  // 收入分類器別名（Codex r13#3，形狀同 categoryAliases/subAliases）：銀行匯入會自動分類收入，改名須沿用新名，
  // 故匯入備份也要保留這兩欄，否則還原後收入自動分類退回舊名／落「其他」。
  if ('incomeCategoryAliases' in src) {
    if (!isObj(src.incomeCategoryAliases)) { bad?.push('settings.incomeCategoryAliases'); }
    else {
      /** @type {Record<string, any>} */
      const a = {};
      for (const [k, v] of Object.entries(src.incomeCategoryAliases)) {
        if (k === '__proto__') { bad?.push('incomeCategoryAliases.__proto__（程式保留字，已丟棄）'); continue; }
        if (typeof v === 'string') a[k] = v; else bad?.push('incomeCategoryAliases.' + k);
      }
      out.incomeCategoryAliases = a;
    }
  }
  if ('incomeSubAliases' in src) {
    if (!isObj(src.incomeSubAliases)) { bad?.push('settings.incomeSubAliases'); }
    else {
      /** @type {Record<string, any>} */
      const a = {};
      for (const [p, m] of Object.entries(src.incomeSubAliases)) {
        if (p === '__proto__') { bad?.push('incomeSubAliases.__proto__（程式保留字，已丟棄）'); continue; }
        if (!isObj(m)) { bad?.push('incomeSubAliases.' + p); continue; }
        /** @type {Record<string, any>} */
        const mm = {};
        for (const [k, v] of Object.entries(m)) {
          if (k === '__proto__') { bad?.push('incomeSubAliases.' + p + '.__proto__（程式保留字，已丟棄）'); continue; }
          if (typeof v === 'string') mm[k] = v; else bad?.push('incomeSubAliases.' + p + '.' + k);
        }
        a[p] = mm;
      }
      out.incomeSubAliases = a;
    }
  }
  return out;
}
