// @ts-check
// 卡片「發卡銀行／機構」的**可選清單**＝零 DOM／零 API 純模組（卡片表單與 `lib/card-identity.js` 共用同一份）。
//
// ## 為什麼要有這一支（William 2026-08-28 指派）
//
// `card.issuer` 原本是**自由文字**，而自由文字**本身就無法消歧**：
//   - 香港富邦官方自稱「富邦銀行」（<https://www.fubonbank.com.hk/tc/home.html>），
//     台北富邦官方沿革同樣記載「富邦銀行」這個簡稱。
//   - 所以使用者把**香港富邦卡**的發卡行填成精確的「富邦」是**合理且可達**的輸入。
//   - `lib/card-identity.js` 的 `issuerBank()` 原本有一條「完全相等於正規短名就算數」的相容規則，
//     於是那張香港卡會被當成台北富邦 ⇒ **台北富邦的帳單自動歸到香港卡上**（錢記到錯的卡）。
//     ⚠️ 這條錯配在 base 就存在（原本更寬鬆＝`String(issuer).includes(bank)`），不是 #518 引入的；
//     #518 選擇「接受短名＋把歧義照實記載」，並把結構解留給本支。
//
// 結構解＝**讓使用者從清單裡挑一個法人**，而不是自己打字。挑「台北富邦銀行」與挑「富邦銀行（香港）」
// 是兩個不同的選項，歧義在**輸入的當下**就消掉了——這是打字消不掉的。
//
// ## 機構代號 `id`（2026-09-02，William 裁示「照舊自動＋提示升級」）
//
// #520 讓使用者從清單挑，但**存進 DB 的仍然是顯示用的名字字串**，身分照樣靠文字比對算出來。
// 本支多存一個 `card.issuerId`＝**這一筆的代號**，於是「這張卡是哪一家」對**有代號的卡**以代號為準。
// ⚠️ **不是「一個字元都不比」**（那句是本支第一版寫的，被 Codex #547 r1／r2 兩輪打穿後撤回）：
//    顯示名仍有**確認**的角色（判準與理由＝`cardCode` 檔頭），但它只能**確認或不確認**，
//    不能參與「是哪一家」的推導 ⇒ **有代號的卡只會判成它自己那一家或判不出來，不可能判成別家**。
//    `card.issuer` 因此是「顯示＋確認」，不是純顯示。
//
// ⚠️ **`id` 是會落進資料庫的持久值，不是給人看的縮寫**：它一旦發出去就**永遠不可以改名或刪除**
//    （改了＝那些卡的代號查不到東西 ⇒ 退回文字那條路 ⇒ 身分可能就此不同）。所以它刻意寫成
//    不帶語意包袱的 ASCII 短碼，**不宣稱**是任何一家的官方英文名或官方縮寫——它只需要唯一且不變。
//    `test/card-issuers.test.js` 有一題把**整組代號當精確集合**釘住：刪一個或改一個字都會轉紅，
//    新增一家要先去那一題把代號寫上去（那是刻意的摩擦——這是持久資料，不該順手加）。
//
// ⚠️ **代號沒有讓文字那條路消失**（William 2026-09-02 裁示的射程，誠實劃界）：
//    沒有代號的卡（清單化之前的舊卡、選「其他」自己打的機構、銀行匯入自動建的簽帳金融卡）
//    **照舊走文字比對**、照舊可以自動歸卡。所以文字那條路的兩個已知洞
//    （①改 `issuerNameKey` 可以偷偷授予身分 ②`OWN_ISSUERS` 沒有結尾錨，「台北富邦銀行（香港）」
//    前綴命中成富邦）**對沒有代號的卡仍然存在**。本支關掉的是**有代號的那些卡**，
//    不是整條路——要整條關掉＝「只認代號」，那會讓每一張還沒重挑過的卡退成手選，是另案。
//
// ## 資料形狀
//
// 每一筆＝**一個法人**：`id`（存進 `card.issuerId` 的代號，見上）、`name`（存進 `card.issuer` 的正式
// 寫法，也是清單上顯示的字）、`bank`（對應到哪一支內建範本；`''`＝我們沒有它的範本）、
// `aka`（同一個法人的其他寫法）。
//
// ⚠️ **`aka` 不是別名對照表**（`lib/bank-alias.js` 刻意不留那種表，理由見它的檔頭：把「寫法不同」
//    壓成「同一家」的通用規則，會在共用品牌的不同法人上撞成同一個字串）。這裡的 `aka` 只做兩件事：
//    ①讓**既有的自由文字**（使用者早就填好的「台新」「台北富邦」）仍然對得上內建範本；
//    ②**兩家以上都自稱同一個寫法時，那個寫法就不判身分**（見 `issuersNamed`）——歧義是
//    **從資料算出來的**，不是另外手寫一張「歧義清單」（手寫的那張自己會漂）。
// ⚠️ **`aka` 兩條路都會被讀到**：沒有代號的卡靠它認出機構；**有代號的卡也靠它做「顯示名確認了代號嗎」
//    的判定**（`cardCode` 走 `issuersNamed`，而 `issuersNamed` 讀 `aka`）——所以既有卡片的
//    `issuer:'台新'` 配上 `issuerId:'taishin'` 才算得上「確認」。⚠️ 這句 2026-09-02 改口過：
//    原本寫「有代號就直接查表、`aka` 一個字都不會被讀到」，Codex #547 r3 第 3 條抓到它與實作相反。
// ⚠️ **只寫「會改變結果」的別名**。⚠️ **誠實劃界：這一條大部分靠人，不是靠機器**——
//    工作流對抗驗證 2026-08-28 實測：替 `bank: ''` 的機構（清單絕大多數——有內建範本的只有兩家）補純裝飾別名
//    （`aka: ['國泰','Cathay','HSBC']`），**全卷一題都不紅**。兩道集合閘各自只看一側：
//    「判得出機構的白名單」那題只收得到 `issuerBank(t) !== ''` 的寫法，`bank` 是 `''` 就永遠落選。
//    機器擋得住的只有三種：①別名讓某個寫法**判得出機構** ②別名讓某個寫法**變成共用（歧義）**
//    ③別名在樣式那條路上**指向別家**。裝飾別名掛在沒有內建範本的機構上，三種都不是 ⇒ 沒人擋。
//    「HSBC」「Rakuten」「星展」這種全球品牌短名看起來很順手，但它們正是本支要消掉的那種東西——
//    同一個品牌在不同法域是不同法人（`lib/bank-alias.js` 自己就記著「日本樂天 vs 台灣樂天」）。
//    寫下去等於**替使用者猜他指的是哪一個法人**，而清單存在的理由就是不要猜。
//    判準：一個 `aka` 只有在**兩家以上宣稱它**（＝製造歧義，香港富邦那兩筆就是）或**樣式那條路對不出
//    這一家**（＝收既有短名，「台新」「台北富邦」就是）時才留。其餘一律刪——沒有 `bank` 的機構本來就
//    不會自動歸卡，替它們補別名一個結果都改不了，只是多一句沒人驗的宣稱。
//
// ## ⚠️ 誠實劃界（這一份**不**保證什麼）
//
// - **清單不完整是可以接受的、而且必然**：台灣的發卡行不只這幾家，app 的目標是「任何銀行的任何帳單
//   都能正確讀取」⇒ 表單一定要留「其他（自行輸入）」。清單漏一家的後果是**那家要自己打字**
//   （回到自由文字的既有行為），不是那張卡填不了發卡行。
// - **`bank: ''` 的那些機構不會因為列在這裡就被自動歸卡**：自動歸卡只認 `bank` 非空的那幾家
//   （＝我們真的有內建範本的）。⚠️ **但「其餘一律走請使用者自己選卡」是錯的**（Codex #520 r4#2）：
//   那句漏了「解析器要先成功抽出明細」這個前提——兩支內建解析器都讀不到列時，`lib/statement.js`
//   會先丟 `card_unrecognized`，**根本走不到選卡窗**——批二（#528）起這個錯誤會改開
//   「請 AI 讀一次」的入口（`shouldOfferAi`）；AI 讀成功、過驗算閘之後才會回到選卡窗。
//   列進來只為了①清單挑得到 ②把「這個寫法被誰宣稱過」記下來，好算出歧義。
// - **代號不會讓那些沒有範本的機構突然讀得懂帳單**：`issuerId: 'esun'` 只是說「這張卡是玉山發的」，
//   它讓玉山卡**確定不是台新**（不再擋台新的自動歸），但玉山自己的帳單照樣沒有內建範本。
// - **這份清單不進 `lib/bank-alias.js` 的身分尺**：那把尺管的是「去重鍵／帳戶機構戳／定存鍵」，
//   撞了會**餘額蓋到別家帳戶、真交易被當重複吞掉**（不可逆）。它今天只認得台新，
//   要讓第二家進去是**另案裁決**。本支只影響「信用卡帳單要歸到哪張卡」，**刻意不碰那條路**。
//   ⇒ 代價：簽帳金融卡那條路（`lib/services/bank-import.js` 用 `sameBank` 比對 `card.issuer`）
//   對非台新機構仍然要求**兩邊字面正規化後相等**，而且**它讀的是 `issuer` 字串、不讀 `issuerId`**
//   （代號沒有修好它、也不宣稱修好；那條路上自動建的卡因此也不帶代號）。
// - **這裡不驗「這家銀行今天還存不存在」**：合併／改名過的機構（日盛、花旗台灣消金）仍留在清單上，
//   因為使用者手上的舊卡與舊帳單還在。留著的代價是清單長一點，拿掉的代價是那些卡填不了名字。

/** 「其他（自行輸入）」那一項的選項值。
 * ⚠️ 它只在 `resolveIssuerFields` 的 **selected 欄**當分流哨兵（「等於它＝改讀自訂欄」）；
 *    **custom 欄可以合法地是同一個字串**——使用者在自訂欄真的打 `__other__` 就會存 `__other__`
 *    （`resolveIssuerFields(ISSUER_OTHER, ISSUER_OTHER).issuer === '__other__'`，Codex #520 r5#3 實測），
 *    CRUD／備份匯入也送得進來。⚠️ 所以**不要**把這個常數說成「永遠不會被存進 `card.issuer`」——
 *    我寫過那句、被推翻了。存進去之後它與一般自由文字同路——**有考題撐著的**是：round-trip 原字不動、
 *    `issuersNamed('__other__')` 查不到 ⇒ 不參與歸卡（`test/card-issuers.test.js` 的下拉選項題斷言
 *    哨兵不是任何一家的名字、別名或**代號**）。「全 repo 沒有別處拿存下來的值與哨兵比對」是**清點時的現況**，
 *    沒有考題撐——日後誰新增那種比對，這句話不會替你轉紅。 */
export const ISSUER_OTHER = '__other__';
/** 「其他（自行輸入）」的選項文字。 */
export const ISSUER_OTHER_LABEL = '其他（自行輸入）';
/** 「（未設定）」那一項的選項文字——發卡行不是必填欄。 */
export const ISSUER_UNSET_LABEL = '（未設定）';

/** @typedef {{ id: string, name: string, bank: string, aka?: string[] }} CardIssuer */

/**
 * 發卡機構清單。**順序＝清單上的順序**（常見的排前面，不排字母序——使用者找的是自己那一家）。
 *
 * ⚠️ **`id` 是持久資料、永不改名**（理由與精確集合閘見檔頭）。
 * ⚠️ **`bank` 只有兩個非空值**（`'台新'`／`'富邦'`），因為內建範本只有這兩支。要新增第三支範本才會有
 *    第三個值——`test/card-issuers.test.js` 有一題機械檢查「每一筆的 `bank` 都對得上
 *    `lib/card-identity.js` 的 `OWN_ISSUERS`／`issuerBank`」，所以在這裡亂填 `bank` 會轉紅。
 * ⚠️ **「富邦」與「富邦銀行」被兩家同時宣稱**（台北富邦與香港富邦）——這就是本支存在的理由，
 *    照實記下來；`issuersNamed` 會因此回兩筆 ⇒ `issuerBank` 判「歧義、不猜」。
 *    ⚠️ 不可以為了「讓既有的『富邦』卡繼續自動歸卡」把其中一邊的宣稱刪掉：刪掉就是**回去猜**，
 *    而猜錯的代價是錢記到香港那張卡上。不認的代價只是使用者多按一次選卡。
 *    ⚠️ **代號沒有讓這個歧義消失，它是繞過歧義**：`issuerId: 'fubon-taipei'` 說得清楚是哪一家，
 *    但只有**重新挑過清單**的卡才有代號；`issuer` 還是「富邦」兩個字的舊卡照舊判不出身分。
 * @type {readonly CardIssuer[]}
 */
export const CARD_ISSUERS = Object.freeze([
  // ── 有內建範本的兩家（`bank` 非空＝帳單認得出來時可以自動歸卡）──
  // 「台新」要靠 aka 收：`OWN_ISSUERS` 的樣式要求行名後面跟佐證詞（`台新銀行`／`Taishin`／`Richart`
  // 都直接命中樣式），只有裸的短名對不上——而既有卡片與 repo 既有考題就是這樣填的。
  // ⚠️ 這裡曾寫「**唯一**要靠 aka 收的寫法」——與下面「台北富邦」那一筆自相矛盾（工作流 2026-08-28）：
  //    裸的「台北富邦」同樣對不上樣式、同樣只能靠 aka 收。要靠 aka 收的短名是**兩個**，不是一個。
  { id: 'taishin', name: '台新銀行', bank: '台新', aka: ['台新'] },
  // 「台北富邦」＝樣式要求「台北富邦…銀行」，裸的四個字對不上；「富邦」「富邦銀行」＝台北富邦官方沿革
  // 記載的簡稱，**同時也被下面那家宣稱** ⇒ 這兩個寫法從此判不出身分（那正是本支要的結果）。
  { id: 'fubon-taipei', name: '台北富邦銀行', bank: '富邦', aka: ['台北富邦', '富邦', '富邦銀行'] },
  // ── 消歧用的那一筆：同集團、不同法人 ──
  // ⚠️ 這一筆是本支的主角。它與上面那一筆**共用「富邦」「富邦銀行」兩個寫法**，所以那兩個寫法從此
  //    判不出身分（歧義）；挑清單上這一項或上面那一項，才是說得清楚的輸入。
  { id: 'fubon-hk', name: '富邦銀行（香港）', bank: '', aka: ['富邦', '富邦銀行'] },
  // ── 其餘台灣常見發卡機構（`bank: ''`＝沒有內建範本，只提供清單挑選）──
  { id: 'cathay-united', name: '國泰世華銀行', bank: '', aka: [] },
  { id: 'ctbc', name: '中國信託銀行', bank: '', aka: [] },
  { id: 'esun', name: '玉山銀行', bank: '', aka: [] },
  { id: 'sinopac', name: '永豐銀行', bank: '', aka: [] },
  { id: 'union', name: '聯邦銀行', bank: '', aka: [] },
  { id: 'far-eastern', name: '遠東商銀', bank: '', aka: [] },
  { id: 'dbs-tw', name: '星展銀行（台灣）', bank: '', aka: [] },
  { id: 'hsbc-tw', name: '匯豐銀行（台灣）', bank: '', aka: [] },
  { id: 'sc-tw', name: '渣打銀行（台灣）', bank: '', aka: [] },
  { id: 'citi-tw', name: '花旗銀行（台灣）', bank: '', aka: [] },
  { id: 'mega', name: '兆豐銀行', bank: '', aka: [] },
  { id: 'first', name: '第一銀行', bank: '', aka: [] },
  { id: 'hua-nan', name: '華南銀行', bank: '', aka: [] },
  { id: 'chang-hwa', name: '彰化銀行', bank: '', aka: [] },
  { id: 'yuanta', name: '元大銀行', bank: '', aka: [] },
  { id: 'kgi', name: '凱基銀行', bank: '', aka: [] },
  { id: 'shin-kong', name: '新光銀行', bank: '', aka: [] },
  { id: 'entie', name: '安泰銀行', bank: '', aka: [] },
  { id: 'o-bank', name: '王道銀行', bank: '', aka: [] },
  { id: 'bank-of-taiwan', name: '台灣銀行', bank: '', aka: [] },
  { id: 'tcb', name: '合作金庫銀行', bank: '', aka: [] },
  { id: 'land-bank', name: '土地銀行', bank: '', aka: [] },
  { id: 'scsb', name: '上海商業儲蓄銀行', bank: '', aka: [] },
  { id: 'tbb', name: '台灣企銀', bank: '', aka: [] },
  { id: 'taichung', name: '台中銀行', bank: '', aka: [] },
  { id: 'bok', name: '高雄銀行', bank: '', aka: [] },
  { id: 'sunny', name: '陽信銀行', bank: '', aka: [] },
  { id: 'panhsin', name: '板信銀行', bank: '', aka: [] },
  { id: 'cota', name: '三信商業銀行', bank: '', aka: [] },
  { id: 'rising', name: '瑞興銀行', bank: '', aka: [] },
  { id: 'hwatai', name: '華泰銀行', bank: '', aka: [] },
  { id: 'jih-sun', name: '日盛銀行', bank: '', aka: [] },
  { id: 'rakuten-tw', name: '樂天國際商業銀行', bank: '', aka: [] },
  { id: 'next-bank', name: '將來銀行', bank: '', aka: [] },
  { id: 'line-bank', name: '連線商業銀行', bank: '', aka: [] },
]);

/**
 * **兩家以上都自稱的寫法**——逐組列名的**宣告**（不是從 `CARD_ISSUERS` 推導出來的複本）。
 *
 * 為什麼要多這一份宣告（Codex #520 r2#1）：r1 的閘只問「共用者裡有沒有一家有內建範本」，
 * 於是替**台新**與**國泰世華**同補一個 `HSBC` 就通過了——`HSBC` 從頭到尾都回 `''`，那一筆是純裝飾。
 * 改成**精確集合相等**之後，清單裡只要多出一個共用寫法（不論補在誰身上）就會轉紅，
 * 逼人先來這裡宣告它、寫下它為什麼是真的共用。
 *
 * ⚠️ 這一份**不參與判準**（`issuersNamed` 一個字都不讀它）——判準只看 `CARD_ISSUERS`。
 *    它純粹是給 `test/card-issuers.test.js` 對照用的審批點，走樣就紅。
 * @type {readonly {name: string, claimedBy: readonly string[], why: string}[]}
 */
export const SHARED_ISSUER_NAMES = Object.freeze([
  { name: '富邦', claimedBy: ['台北富邦銀行', '富邦銀行（香港）'], why: '集團短名，兩家官方都在用' },
  { name: '富邦銀行', claimedBy: ['台北富邦銀行', '富邦銀行（香港）'], why: '香港富邦官方自稱；台北富邦官方沿革亦記載此簡稱' },
]);

/**
 * 文字比對形：NFKC → 去所有空白 → 臺換台 → 小寫。
 *
 * ⚠️ 為什麼要正規化而不是逐字相等：這一欄的來源是**使用者打的字**（既有資料）與**清單**（我們寫的字），
 *    兩邊的全形／半形括號、空白、臺／台、英文大小寫都不由我們決定。逐字相等會讓
 *    「台新銀行 」（尾巴一個空白）靜靜掉進「其他」。
 * ⚠️ 這是**放寬**：正規化後相等的字串會被當成同一家 ⇒ 更多字串對得上 `bank` 非空的那兩家
 *    ⇒ 自動歸卡的面積變大。所以 `aka` 一律**只寫那個法人真的自稱過的寫法**，不加推測的變體。
 * ⚠️ **代號那條路一個字都不過這裡**（見 `issuerById`：代號是我們自己發的機器值，逐字相等）。
 *
 * ## ⚠️ 這一支是「誰有資格當台新／富邦」的**真正入口**（Codex #520 r3#1）——**對沒有代號的卡**
 *
 * `test/card-issuers.test.js` 的兩道集合閘管的是**清單資料**（宣告過的寫法與共用組），
 * 它們**管不到這裡**：在這個函式裡多加一條對映（例如把 `hsbc` 抹成 `台新`），
 * 那兩題與整卷考題都照樣綠，而 `issuerBank('HSBC')` 會變成 `'台新'`（Codex 實測）。
 * ⇒ **改這個函式等於改身分判準**，要當成錢類改動看待；等價類造成的行為差異由
 *   `test/card-identity.test.js` 的「相對 base 的行為改變逐項釘住」那一題列名。
 * ⇒ 2026-09-02 起，**有 `issuerId` 的卡走不到這裡**（`cardIssuerBank` 查表就回來了）⇒ 這條通道
 *   對它們關上了。但**沒有代號的卡照舊走這裡**（William 裁示「照舊自動＋提示升級」），
 *   所以這一段**不是歷史**——它今天仍然承重。要整條關掉＝「只認代號」，那是另案。
 * @param {unknown} s
 */
export const issuerNameKey = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase();

/**
 * 清單裡**有哪些法人自稱這個寫法**（比對 `name` 與 `aka`，都過 `issuerNameKey`）。
 *
 * 回傳筆數就是答案的可信度：`0`＝清單沒有這個寫法（呼叫端自己決定怎麼辦）、`1`＝說得清楚是哪一家、
 * `2` 以上＝**歧義**（「富邦」「富邦銀行」今天就是這種）。
 * ⚠️ 刻意回**陣列**而不是「一家或 null」：把歧義壓成 null，呼叫端就分不出「沒這個寫法」與
 *    「兩家都叫這個」——而這兩件事的正確處置不同（前者可以退回樣式比對，後者不可以）。
 * ⚠️ 它**只認名字與別名，不認代號**——`issuersNamed('taishin')` 是 0 筆。代號查表走 `issuerById`。
 * @param {unknown} text @returns {CardIssuer[]}
 */
export function issuersNamed(text) {
  const key = issuerNameKey(text);
  if (!key) return [];
  return CARD_ISSUERS.filter(o => issuerNameKey(o.name) === key || (o.aka || []).some(a => issuerNameKey(a) === key));
}

/**
 * 代號查表——**身分的新入口**（2026-09-02）。
 *
 * ⚠️ **逐字相等，刻意不過 `issuerNameKey`**：代號是我們自己發出去的機器值，不是使用者打的字，
 *    所以沒有「全形／空白／臺台」要抹平的問題。過了正規化反而會開一條新通道
 *    （`'TAISHIN '` 或 `'ｔａｉｓｈｉｎ'` 憑空取得身分），而那正是本支要關掉的東西。
 * ⚠️ **非字串一律當作沒有代號**（`typeof` 硬判，不 `String()`）：`issuerId` 從來不是使用者手打的欄位，
 *    它只由表單從清單寫入 ⇒ 非字串代表資料是別的路徑塞進來的、不是我們發的代號。
 *    ⚠️ 這與 `issuer` 那一欄的既有裁定（#520：「壞型別的答案＝它字串化之後的答案」）**刻意不同**，
 *    因為兩欄的來源不同：`issuer` 是使用者打的字（字串化＝照他打的字面判，合理），
 *    `issuerId` 是機器值（字串化＝替一個我們沒發過的東西編出身分，不合理）。這不是走鐘、是有理由的分岔。
 * ⚠️ **查不到就是查不到，不會落回文字**——落回是呼叫端（`cardIssuerBank`）的事，而且它落回的是
 *    「這張卡視同沒有代號」，不是「代號與文字兩把尺比一比」。同一張卡永遠只有一把尺。
 * @param {unknown} id @returns {CardIssuer|null}
 */
export function issuerById(id) {
  if (typeof id !== 'string' || id === '') return null;
  return CARD_ISSUERS.find(o => o.id === id) || null;
}

/**
 * 這張卡的**代號**能不能用——三態，呼叫端三條路各自不同（`state` 刻意不壓成 boolean）。
 *
 * - `{ state: 'none' }`＝沒有可解析的代號（缺席／空／非字串／不認得）⇒ 呼叫端**退回文字判準**。
 * - `{ state: 'ok', issuer }`＝代號可用 ⇒ 身分就是它。
 * - `{ state: 'unconfirmed' }`＝**有代號、但顯示名沒有確認它** ⇒ **說不清楚**：
 *   既不採信代號，**也不退回文字**（退回文字＝讓顯示名去指定另一家，那正是下面要擋的事）。
 *
 * ## 為什麼要有這一層（Codex #547 r1 第 1 條與 r2 第 1／3 條，兩輪都是高、阻擋）
 *
 * `card.issuer` 與 `card.issuerId` 是**同一個身分的兩半**，但櫃檯把它們當兩個欄位收
 * （`PUT` 是部分更新、`lib/repo.js` 淺合併）⇒ 兩欄可以走散。走散的卡有兩種危害，**方向相反**：
 *   ・**r1**：`{issuer:'台北富邦銀行', issuerId:'taishin'}`（升級後沒重新整理的**舊分頁**只送 `issuer`
 *     就會造出來）。無條件相信代號 ⇒ 這張卡被判「確定不是富邦」而出局 ⇒ 另一張富邦卡成了
 *     唯一同行卡 ⇒ **富邦帳單自動歸到它**。
 *   ・**r2**：`{issuer:'美國運通', issuerId:'taishin'}`（POST／PUT 同時送兩欄、備份匯入都做得到）。
 *     r1 的修法只否決「清單認得、但認成別家」的顯示名，**清單認不得的另一家被當成「沒有反對證據」**
 *     ⇒ 代號照樣算數 ⇒ Codex 端到端重現：唯一候選卡畫面寫著「美國運通」，台新帳單自動歸過去。
 *
 * ## 判準：**顯示名必須確認代號那一家**（空白＝沒有東西可以牴觸）
 *
 * ・顯示名是空白 ⇒ `ok`（沒有相反證據）。
 * ・`issuersNamed(顯示名)` **包含代號那一家** ⇒ `ok`（正式名稱、別名、以及「富邦」這種歧義寫法
 *   含它在內都算確認——歧義寫法配上代號正是清單化要達成的消歧）。
 * ・其餘（清單認得但認成別家／清單根本認不得的字）⇒ `unconfirmed`。
 *
 * ⚠️ **`unconfirmed` 刻意不退回文字**（r1 的修法就是退回文字，被 r2 第 3 條打穿）：退回文字會讓
 *    「畫面寫甲、代號寫乙」的卡最後被判成**甲**，於是「有效代號的卡不受顯示字串影響」這句宣稱為假
 *    ——Codex 實測：把 `issuerNameKey` 改壞讓 `HSBC` 抹成台新，`{issuerId:'esun', issuer:'HSBC'}`
 *    就被歸成台新，而全卷 37 題照樣綠。改成 `unconfirmed` 之後，這句話變成**真的**：
 *
 *    > **有代號的卡，只會判成「它自己那一家」或「判不出來」，不可能判成別家。**
 *
 *    （`test/card-issuers.test.js` 有一題對清單 × 一組刁鑽顯示名做全組合檢查釘住它。）
 *    代價＝那張卡退成手選，而它本來就是一張說不清楚的卡；**這是安全方向**。
 * ⚠️ **只影響有代號的卡**：`state:'none'` 一路退回文字判準 ⇒ 沒有代號的舊卡零回歸（J12）。
 * ⚠️ 住在這一支（不是 `lib/card-identity.js`）是因為**卡片表單也要用同一份**：表單若把
 *    說不清楚的代號預選起來，使用者按個儲存就把它寫死了。前端 import 不到 `lib/`，
 *    所以判準本體放這裡、`lib` 那邊 import 過去——同一件事只有一個實作。
 * @param {{ issuer?: unknown, issuerId?: unknown } | null | undefined} card
 * @returns {{ state: 'none' } | { state: 'ok', issuer: CardIssuer } | { state: 'unconfirmed' }}
 */
export function cardCode(card) {
  const listed = issuerById(ownProp(card, 'issuerId'));
  if (!listed) return { state: 'none' };
  const shown = issuerText(ownProp(card, 'issuer'));
  if (shown === null) return { state: 'unconfirmed' };   // 字串化都炸得出來＝證明不了確認 ⇒ fail-closed
  if (shown.trim() === '') return { state: 'ok', issuer: listed };
  return issuersNamed(shown).includes(listed) ? { state: 'ok', issuer: listed } : { state: 'unconfirmed' };
}

/**
 * **只讀卡片自己身上的欄位**——原型鏈上的不算（Codex #547 r3 第 1 條）。
 *
 * ⚠️ 沒有這一道，`Object.create({ issuerId: 'taishin' })` 這種形狀會讓一張**自己沒有代號**的卡
 *    憑空取得機構身分（實測 `cardCode` 回 `ok`、`cardIssuerBank` 回「台新」）。原型污染要製造它
 *    只需要把 `issuerId` 掛上 `Object.prototype`；JSON 裡的 `__proto__` 是另一條常見來源。
 * ⚠️ `issuer` 與 `issuerId` **都**走這一道：兩欄一個讀自己、一個讀原型＝同一件事兩把尺。
 * @param {unknown} o @param {string} k
 */
const ownProp = (o, k) => (o != null && Object.prototype.hasOwnProperty.call(o, k) ? /** @type {any} */ (o)[k] : undefined);

/**
 * 顯示名的**安全字串化**——炸不出來回 `null`。
 *
 * ⚠️ **`null`（炸不出）與 `''`（空的）刻意分得開**，因為兩者的處置**相反**：空字串＝「沒有東西
 *    可以牴觸代號」⇒ `ok`；炸不出＝「證明不了顯示名確認了代號」⇒ `unconfirmed`（fail-closed）。
 * ⚠️ 為什麼需要它：`cards.issuer` 在 CRUD 白名單、`FIELD_SCHEMA` 刻意不收斂型別
 *    （理由見 `lib/schema.js`）⇒ `{toString:null}` 這族「連 `String()` 都炸」的值可經櫃檯**原樣落庫**。
 *    Codex #547 r3 實測：對它裸跑 `String()` 會丟 `TypeError`，**一張壞卡就炸掉整份帳單預覽**。
 *    這與 `public/modules/card-last-four.js` 是同一個病、同一種解（#541 為 `lastFour` 做過一次）。
 * ⚠️ **這會讓一種行為與 base 不同**（本支唯一的零回歸例外，照實記）：base 對這族值是丟 500
 *    炸掉預覽，head 是「認不出這張卡是哪一家」⇒ 退成請使用者選。安全方向，且與 #541 同一個裁定。
 * @param {unknown} v @returns {string|null}
 */
const issuerText = (v) => { try { return String(v ?? ''); } catch { return null; } };

/**
 * 顯示名的安全字串化（給 `lib/card-identity.js` 的文字退路用——**兩條路同一把尺**）。
 * 炸不出＝`''`＝認不出任何機構（不是丟例外）。
 * @param {unknown} card @returns {string}
 */
export function cardIssuerText(card) {
  return issuerText(ownProp(card, 'issuer')) ?? '';
}

/**
 * 卡片表單「發卡銀行 / 機構」下拉的選項。
 * 順序＝（未設定）→ 清單 → 其他（自行輸入）。「其他」擺最後：它是退路，不是預設。
 * ⚠️ **選項的 `value` 是代號、不是名字**（2026-09-02）：下拉送回來的就是要存進 `card.issuerId` 的值，
 *    中間不再有「名字 → 代號」的翻譯步驟（多一步翻譯＝多一個會走鐘的地方）。
 *    顯示給人看的 `label` 才是名字。
 * @returns {{ value: string, label: string }[]}
 */
export function issuerOptions() {
  return [
    { value: '', label: ISSUER_UNSET_LABEL },
    ...CARD_ISSUERS.map(o => ({ value: o.id, label: o.name })),
    { value: ISSUER_OTHER, label: ISSUER_OTHER_LABEL },
  ];
}

/**
 * 這張卡打開表單時，發卡行那兩欄要**顯示成什麼**（下拉挑哪一項＋自訂文字框填什麼）。
 *
 * ⚠️ 吃的是**卡片物件**（要 `issuerId` 與 `issuer` 兩欄），不是 `issuer` 字串。
 *    傳字串進來會丟例外——這一支 2026-09-02 從 `issuerFormValues(issuer)` 改名而來，
 *    改名是為了讓沒跟上的呼叫端**當場炸掉**而不是靜靜回一組空值（那會讓使用者按個儲存就把發卡行清空）。
 *    留這道 `typeof` 是為了擋「新寫的呼叫端手滑傳 `c.issuer`」——改名擋不到那一種。
 *
 * 判準（由上而下，第一個命中就回）：
 *   ①**代號查得到** ⇒ 預選那一項。這是有代號的卡唯一走的路，`issuer` 字串一個字都不看。
 *   ②代號查不到（沒有／空／非字串／不認得的代號）⇒ **視同沒有代號**，照 #520 的字串判準走：
 *     ・正規化後等於清單上的 `name` ⇒ 預選那一項。
 *     ・其餘（別名、自訂文字）⇒ 落到「其他」並**原字**填進文字框。
 *
 * ⚠️ **`aka` 命中刻意不預選**（#520 起的規矩）：預選會讓使用者只是打開表單改個別的欄位按儲存，
 *    `issuer` 就從「台新」被靜靜改寫成「台新銀行」。這個 repo 有專門的前例
 *    （`public/modules/form-options.js` 檔頭：帳戶型別被靜靜換掉、50 萬負債變 50 萬資產），
 *    規矩是**不可靜靜改掉使用者資料**。（`aka` 仍然有用：它讓那些既有寫法在 `issuerBank`
 *    那條路照樣認得出來。）
 * ⚠️ **不認得的代號在儲存時會被換掉**（第四種 round-trip）：它落到②，使用者按儲存就寫成
 *    「這一項的代號」或「沒有代號」。
 *    ⚠️ 我第一版在這裡寫「`issuer` 顯示字串原樣保留」與「留著它會讓那張卡永遠判不出身分」，
 *    **兩句都不對**（Codex #547 r1 第 4 條）：①顯示字串同樣照②的規則走，可能被收斂成清單正式寫法
 *    （`{issuer:'臺新銀行', issuerId:'zzz'}` → `{issuer:'台新銀行', issuerId:'taishin'}`）；
 *    ②不認得的代號**不會**讓卡片判不出身分——`cardIssuerBank` 對它「視同沒有代號」、退回文字判準，
 *    所以一張「台新銀行」的卡照樣自動歸卡（`test/statement-pipeline.test.js` 的 J12 就是釘這件事）。
 *    正確的逐條列名在下面 `resolveIssuerFields` 的檔頭。
 * @param {{ issuer?: unknown, issuerId?: unknown } | null | undefined} card
 * @returns {{ issuerPick: string, issuerOther: string }}
 */
export function issuerFormFields(card) {
  if (typeof card === 'string') {
    throw new TypeError('issuerFormFields 吃的是卡片物件（要 issuer 與 issuerId 兩欄），不是 issuer 字串');
  }
  // ⚠️ 只有代號**可用**時才預選它（`cardCode` 檔頭）：說不清楚的卡要落回文字那條路，
  //    讓使用者看到畫面上的那個名字、自己挑一次——按儲存就把兩欄修成一致（自我修復）。
  const code = cardCode(card);
  if (code.state === 'ok') return { issuerPick: code.issuer.id, issuerOther: '' };
  // ⚠️ 與判準側同一把尺：只讀卡片自己身上的 `issuer`，而且字串化炸不出來時當成空
  //    （`{toString:null}` 這族會讓裸的 `String()` 丟 TypeError＝整張表單開不起來；Codex #547 r3 第 1 條）。
  const raw = cardIssuerText(card);
  if (!raw.trim()) return { issuerPick: '', issuerOther: '' };
  const key = issuerNameKey(raw);
  const listed = CARD_ISSUERS.find(o => issuerNameKey(o.name) === key);
  return listed ? { issuerPick: listed.id, issuerOther: '' } : { issuerPick: ISSUER_OTHER, issuerOther: raw };
}

/**
 * 表單送出時把兩個欄位合回**要存的兩欄**：`{ issuer, issuerId }`。
 *
 * ⚠️ 這一支 2026-09-02 從 `resolveIssuerInput` 改名、回傳從字串改成物件。**改名是刻意的**：
 *    沒跟上的呼叫端會丟 `is not a function` 當場炸掉，而不是把一個物件塞進 `data.issuer`、
 *    存成 `"[object Object]"`（那條路上是錢——發卡行決定帳單歸哪張卡）。
 *
 * 判準：
 *   ・選了「其他」⇒ `issuer` 用文字框的字、`issuerId` 空（自訂機構不在清單上，沒有代號可發）。
 *   ・選了清單上的某一項（`value` ＝代號）⇒ `issuer` 寫**清單上的正式名稱**、`issuerId` 寫該代號。
 *   ・選了「（未設定）」⇒ 兩欄都空。
 *   ・下拉送回一個**不認得的值**（正常操作走不到；`form-options.js` 保留清單外現值的機制、
 *     或日後有人改壞選項才會發生）⇒ `issuer` 原樣保留那個字、`issuerId` 空——保留使用者看得到的字，
 *     不憑空發一個代號。
 *
 * ⚠️ **自訂文字刻意不 `trim()`**（Codex #520 r1#1）：第一版無條件 trim，於是既有的
 *    `card.issuer = ' 某某會員俱樂部 '` 打開表單、**什麼都不改按儲存**就被存成去掉空白的版本
 *    ——那正是本檔開頭宣稱要避免的「靜靜改掉使用者資料」，宣稱與實作對不上。
 *    不 trim 也不會弄壞比對：`issuerNameKey` 本來就把空白全部去掉，前後空白不影響認不認得出機構。
 *    同一張表單的 `name`／`note` 也都不 trim ⇒ 這一欄跟著同一個慣例。
 * ⚠️ **本函式唯一的例外＝整串都是空白**：那視同「沒填」（回 `''`）。不這樣做的話卡片頁的
 *    `c.issuer || '未設定'` 會判成「有填」而印出一串看不見的空白。
 *
 * ## ⚠️ 誠實劃界：「原字保存」到底保證到哪裡（Codex #520 r2#3／r3#2／r4#1，2026-09-02 補第四條）
 *
 * 我原本在這裡寫「這是這支唯一還會動到既有值的路徑」——**那句不準**。
 * ⚠️ **前提：`card.issuer` 本來就是字串。** 非字串的舊值（可經 CRUD 與備份匯入進來——
 *    `lib/schema.js` 那一格寫了為什麼刻意不加型別驗證）會在 `issuerFormFields` 被 `String()` 定型，
 *    使用者一按儲存就寫成 `"[object Object]"` 之類——那是**第五條**、而且是不可逆的。
 *    本支**刻意不擋**（擋的代價是升級前有壞值的人整個寫不進去，理由見 `lib/schema.js`）。
 * 在 `issuer` 是字串的前提下，既有值會不會變要看它落在哪一格（每一種都要按下儲存才會發生）：
 *   ・**自訂值／別名**（落到「其他」的那些）＝**原字保存**，一個字元都不動。
 *   ・**正規化後等於清單正式名稱**的（`issuerFormFields` 的 `name` 命中）＝存回**清單上的正式寫法**：
 *     「臺新銀行」→「台新銀行」、「台 新 銀 行」→「台新銀行」、「富邦銀行(香港)」→「富邦銀行（香港）」。
 *     那是同一家的同一個名字換個字形（`issuerNameKey` 判定），**刻意保留**——清單的價值就是收斂寫法。
 *     ⚠️ 2026-09-02 起這一格**同時補上代號**（`issuerId`）——那是本支的升級路徑：既有的
 *     「台新銀行」卡打開按儲存就從此走代號那條路。身分不變（本來就判成台新），只是不再靠文字算。
 *   ・**整串空白** ＝ 清成 `''`（本函式這一格）。
 * ⚠️ **上面三條的前提是「這張卡沒有（可用的）代號」**——預審 2026-09-02 抓到我把這份清單寫成了窮舉，
 *    漏了代號在場時的那一格，而且把「不認得的代號」那一格寫錯了。照實補：
 *   ・**代號可用**（`cardCode` 回 `ok`：顯示名確認了它，或顯示名是空的）⇒ 儲存時 `issuer` 被寫成
 *     **該代號的正式名稱**。既然顯示名已經確認過是同一家，這只是「同一家換個字形」。
 *   ・**代號說不清楚**（`unconfirmed`：顯示名沒有確認它）⇒ 落回上面三條，於是按儲存＝
 *     **把代號修正成顯示名那一家**（`{issuer:'玉山銀行', issuerId:'taishin'}` → `{issuer:'玉山銀行', issuerId:'esun'}`）。
 *     ⚠️ **方向是「代號跟著畫面走」，不是「畫面跟著代號走」**（2026-09-02 r2 起改成這樣）：
 *     這種不一致最常見的來源是「舊分頁只送了 `issuer`」，那時**使用者看到的、要的就是顯示名那一家**；
 *     反過來改會讓一張畫面寫著甲的卡靜靜變成乙。
 *   ・**不認得的代號** ⇒ 視同沒有代號、落回上面三條，所以**兩半都不是「原樣不動」**：
 *     代號會被寫成「這一項的代號」或 `''`，而 `issuer` 同時照上面三條處理
 *     （`{issuer:'臺新銀行', issuerId:'zzz'}` → `{issuer:'台新銀行', issuerId:'taishin'}`）。
 * 每一條都由 `test/card-issuers.test.js` 的 round-trip 題釘住——⚠️ 這句 2026-09-02 之前是假的
 * （那一題的 helper 只餵 `{issuer: x}`、從不餵 `issuerId`），已補上帶代號的 round-trip 題。
 * @param {unknown} selected 下拉的值（代號／`''`／`ISSUER_OTHER`）
 * @param {unknown} custom 自訂文字框
 * @returns {{ issuer: string, issuerId: string }}
 */
export function resolveIssuerFields(selected, custom) {
  const sel = String(selected ?? '');
  if (sel === ISSUER_OTHER) {
    const text = String(custom ?? '');
    return { issuer: text.trim() === '' ? '' : text, issuerId: '' };
  }
  if (sel === '') return { issuer: '', issuerId: '' };
  const listed = issuerById(sel);
  return listed ? { issuer: listed.name, issuerId: listed.id } : { issuer: sel, issuerId: '' };
}
