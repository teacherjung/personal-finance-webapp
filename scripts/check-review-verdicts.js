#!/usr/bin/env node
// @ts-check
// **複審結論的聯集閘**（William 2026-08-02 定）。
//
// ## 這支在解什麼
//
// 2026-08-02 實測：#383 上出現**兩份都自稱「Claude 複審」的結論，而且相反**——
// 一份寫「通過，可以合併」，一份寫「需修改後再審」。GitHub 上兩則都顯示 `teacherjung`，
// **沒有任何辦法分辨誰寫的**（三方共用同一個帳號，而且每邊的桌面 session 還會各自
// 用 CLI 起另一個 session：Claude 桌面／Claude CLI／Codex 桌面／Codex CLI 至少四個）。
//
// 兩份其實都對，只是**照的地方不同**：一份查版面與結構（手機 flex、selector、sticky），
// 一份查金額口徑與資料列格數。危險的不是有兩份，是**看起來一樣有效而結論相反**，
// 於是「最後一則說通過」就變成事實上的放行。
//
// ## 三條規則（自報來歷／取聯集／重述——重述是 2026-08-06 補的救濟，見 RESTATE 一節）
//
// ①**自報來歷**：每一則帶結論的複審留言，第一行必須是機器讀得懂的來歷標頭。
// ②**取聯集**：任何審查者的阻擋結論，在**同一個審查者**用更新的 commit 撤銷之前都有效。
//    「通過」**不會**抵銷另一個審查者的「需修改」——沒有「最後一則說了算」這種事。
//
// ## 誠實劃界
//
// 它讀的是**留言裡的自我宣告**，不是身分證明。一個要繞過它的協作者，
// 直接改頭標裡的 `來源` 就好——那要靠獨立 GitHub 帳號才擋得住（見
// `docs/GitHub分支保護-設定與驗證.md` 的「第二步：分身分」）。
// 它防的是**混淆與遺漏**，不是惡意。
//
// 退出碼：
//   0＝複審結論通過（有人對目前 head 說「通過」，且沒有未撤銷的阻擋）
//   1＝**複審結論未通過**——三種情形：①有未撤銷的阻擋 ②沒有任何針對目前 head 的正式通過
//      ③有留言用了 🤖 但標頭寫壞。（原本只寫「有未回應阻擋」，那是失真的——Codex #385 r2 Low）
//      ⚠️ 「疑似結論卻沒帶標頭」**只印提醒、不影響退出碼**（r11 起，理由見 looksLikeVerdict）
//   2＝查不清楚（fail-closed，比照協作欄位閘）
import { execFileSync } from 'node:child_process';
import { fieldValue, canonicalRole } from './check-pr-collab-fields.js';
import { isMainModule } from '../lib/is-main.js';
import { gitEnv } from '../lib/git-env.js';

/**
 * **這支是合併程序的一道機械閘**——`test/collab-invariant-docs.test.js` 靠這個標記
 * 反查「現在到底有幾道閘」，再要求文件把每一道都點名得出來。
 *
 * ⚠️ 別把清單手寫在考題裡（Codex #385 r9／r10）：手寫的漂過一次（加了第四道閘、
 * 文件仍寫三道，考題全綠看不見），改成從散文反查又被證明可繞（lazy continuation、
 * 檔名含數字、乾脆不寫進步驟）。**真相放在閘自己身上**，加一支就一定被數到。
 */
export const MERGE_GATE = { name: '複審結論取聯集', why: '任一審查者的阻擋未被同一位撤銷前都有效' };

/** 結論用詞 → 是不是阻擋。**只認這三種**，寫別的等於沒下結論（→ 查不清楚）。 */
export const VERDICTS = {
  通過: false,
  需修改後再審: true,
  不可合併: true,
};

/**
 * 來歷標頭。**刻意是可見的一行，不是 HTML 註解**——
 * 註解在畫面上看不見，而今晚已經有三次「藏在註解裡就繞過去了」的實例。
 *
 * 格式（逐字）：
 *   🤖 <角色>｜來源：<哪個 session>｜審 `<短 sha>`｜r<輪次>｜結論：<三選一>
 */
// ⚠️ **不接受 `>` 引用與 `-` 列表前綴**（Codex #385 r1 Medium④）：
//    引用別人的標頭不該被算成一則新結論。只容許粗體包裝與水平空白。
// ⚠️ **維護邊界**（Codex #385 r12 記錄用，今天三個角色都不受影響）：
//    角色用 `[A-Za-z]+` 抓，所以未來若出現含數字、連字號或非拉丁字母的角色名，
//    這裡會先擋掉（而不是交給 `canonicalRole()` 判）。新增角色時要一起看這個字元集。
//    另外 trailer 的文件與考題目前硬驗 `William`，還沒有從 `ROLES` 雙向同步。
const HEADER = /^[^\S\n]*(?:\*\*|__)?[^\S\n]*🤖\s*([A-Za-z]+)｜來源：([^｜]+)｜審\s*`?([0-9a-fA-F]{7,40})`?｜r(\d+)｜結論：(\S+?)(?:\*\*|__)?\s*$/mu;

/**
 * **重述行**（2026-08-06，William 裁決 B）：清除「標頭寫壞」那種永久阻擋的唯一合規途徑。
 *
 * ## 它在解什麼
 * 標頭寫壞（結論寫成「要求修改」「通過（無阻擋）」之類）會觸發 `hasBotMark` 的阻擋，而那個阻擋
 * **沒有任何辦法清除**——補一則新的合規留言也沒用，因為壞的那則永遠在留言區裡。2026-08-06 實測
 * 五支 PR 全部卡死在這裡（起因＝發射提示沒把三個合規字串列出來，是發射者的錯，但一個錯字能把
 * 一支 PR 永久鎖死，這個脆弱性本身要修）。
 *
 * ## 格式（逐字；寫在**帶合規標頭**的留言內文裡，一行一則）
 *   重述 r<輪次>｜審 `<短 sha>`｜結論：<三選一>｜原第一行：「<壞掉那則的第一行，逐字引用>」
 *
 * ## 七條保守規則（**重述唯一的新權力是「把讀不懂的翻譯成讀得懂的」，判定規則一格都沒放寬**）
 * ⓪**位置**（#418 r3 收斂，審查者建議的方向）：重述行必須**緊跟在合規標頭後面**（中間只准空行），
 *   碰到第一行別的內容就停止收件。這一條讓「範例會不會生效」整族問題消失——fence、清單、HTML 註解、
 *   引用、lazy continuation……**任何容器都在標頭與重述行之間放不進去**，所以不需要 Markdown 解析器
 *   （v2／v3 各被打穿一輪之後的教訓：解析器做不完，位置規則做得完）。
 *   出現在其他位置的「重述 r…」樣子的行＝**不生效但要出聲**（用寬鬆剝除後掃描，只給警告）。
 * ①「原第一行」必須**逐字**對上某一則壞標頭留言的第一行（只容許頭尾空白差異，trim 比對）——引不中就不清除。
 * ②壞掉那行裡讀得出的角色與來源，必須**等於重述者自己**（同一位審查者才能重述自己的壞留言；
 *   讀不出角色來源的壞留言**不可重述**，維持阻擋——fail-closed）。
 * ③重述出來的結論照樣進聯集**留檔**，但因規則④它永遠不會是該審查者的最新結論——
 *   重述**唯一**能改變的判定＝把壞標頭的阻擋降為可稽核的警告（那正是它存在的目的）；
 *   它**造不出放行票**、也**清不掉任何合規結論的阻擋**（合規的阻擋只能靠同一位審查者的更新輪次撤銷）。
 * ④重述的輪次必須**小於**這則留言自己標頭的輪次——不然可以用重述行造出一個比自己現在結論
 *   更高輪的「通過」。
 * ⑤**sha 與輪次要綁引文**（#418 r3 High①）：重述行自報的 `審 sha｜r<n>` 必須**等於**引文裡讀得出的
 *   那組——不綁的話，壞留言是「r8 對目前 head 的阻擋」，重述卻填 r1＋舊 sha，規則④攔不到
 *   （1 < 7），低輪重述就把高輪阻擋洗掉了。引文裡讀不出 sha 或輪次＝不可重述（fail-closed）。
 * ⑥**只能接管更早的壞留言**（#418 r3 High①後半）：重述那則留言必須出現在壞留言**之後**——
 *   不然可以「預先授權」一則還沒出現的壞留言。
 * ⑦重述行只在帶合規標頭的留言裡有效（標頭本身就是重述者的身分與當前結論）。
 *
 * ## 誠實劃界（#418 r4 起明寫）
 * ・一則合規重述會接管**所有**第一行完全相同、且出現在它之前的壞留言（同一句話蓋歪兩次＝同一次事故）。
 * ・「空行」用 trim() 判定＝**全形空白（U+3000）等 Unicode 空白也算空行**——藏在「空行」裡的全形空白
 *   不會讓收件截止。它藏不了內容（一行全空白什麼都寫不了），列在這裡是講清楚，不是漏洞。
 * ・引文的字元走**白名單**（文字／數字／空白／🤖／全形標點／反引號；`<`、`[`、`!` 等能開隱形容器的
 *   一律不在名單上），反引號要配對、sha 長相的字只准一個——出界的壞留言**不可重述**，
 *   寧可留著阻擋，請改用關掉重開 PR 或問 William。名單放寬要連著這裡與考題一起改。
 * ・整行含 Unicode「預設不顯示」碼位＝不可重述（藏指紋的原料）；sha 歧義在 NFKC 正規化副本上數
 *   （全形 hex 現形），逐字比對仍用原字串。
 * 放行判準完全不變：仍然要指定審查者對**目前 head** 有一則真的「通過」。
 *
 * ## 誠實劃界
 * 與整道閘相同：它讀的是自我宣告，不是身分證明（三方共用同一個 GitHub 帳號，惡意者本來就能
 * 直接偽造整個合規標頭）。重述防的是**打錯字把 PR 鎖死**，不是防惡意。
 */
const RESTATE = /^ {0,3}重述\s*r(\d+)｜審\s*`?([0-9a-fA-F]{7,40})`?｜結論：([^｜\n]+?)｜原第一行：「(.+)」[^\S\n]*$/u;
/** 從壞掉的第一行盡量讀出「誰寫的」（規則②用）。讀不出＝回 null＝那則不可重述。 */
// ⚠️ **錨定行首、身分與 metadata 一次綁定**（#418 r1 阻擋②＋r4 High②）：分開抓的話，
//    壞行可以在中段再塞一組「審 sha｜r<n>」，重述綁到第一組＝低輪又能洗掉高輪。
//    所以角色、來源、sha、輪次用**同一支**錨定行首的正則一次讀出——引文的前四欄長什麼樣，
//    重述就必須照著講。前綴容許粗體，與 HEADER 同一套。
const QUOTED_HEAD = /^[^\S\n]*(?:\*\*|__)?[^\S\n]*🤖\s*([A-Za-z]+)｜來源：([^｜]+)｜審\s*`?([0-9a-fA-F]{7,40})`?｜r(\d+)｜/u;
/**
 * **缺 sha 型**壞行的錨定解析器（規則⑤的唯一例外；2026-08-17 William 裁「兩個都做」之一）。
 *
 * ## 它在解什麼
 * 標頭之所以壞、常常正是**缺了四欄之一**（實例 #475：shell 引號錯誤產出「審 ｜r3」＝sha 欄空白）
 * ——四欄解析器永遠讀不出它，重述機制對這型形同虛設（第二例；首例 #461 只能靠 William
 * 特准刪留言收場）。「打錯字把 PR 鎖死」正是重述要解的病，這型卻被排除在救濟外。
 *
 * ## 例外的邊界（其餘規則一格不放寬）
 * ・只接受「sha 欄**空白**」這一種殘缺——角色、來源、輪次仍要在行首連著讀得出
 *   （規則②的身分綁定、規則④的輪次上限、輪次綁引文照舊）。缺其他欄＝身分讀不出＝仍不可重述
 *   （那型走豁免宣告，見 EXEMPT）。
 * ・引文**全行**（NFKC 副本上數）不得出現任何 sha 長相的字＝零歧義——四欄型容許「恰一個」，
 *   這裡收緊為**零**：空欄位＋別處冒出的指紋＝讀不準它在講哪個版本。
 * ・版本由重述行**自報**（引文裡沒有可對帳的 sha）；洗白路徑仍被規則④（輪次必須小於自己）
 *   與規則②（只能重述自己的）擋住。
 */
const QUOTED_HEAD_NOSHA = /^[^\S\n]*(?:\*\*|__)?[^\S\n]*🤖\s*([A-Za-z]+)｜來源：([^｜]+)｜審\s*(?:``|`\s*`)?\s*｜r(\d+)｜/u;
/**
 * **豁免宣告**（2026-08-17 William 裁「兩個都做」之二＝把「特准存檔後刪」前例機械化）。
 *
 * ## 它在解什麼
 * 重述救不了的壞法（引文連角色／來源／輪次都讀不出＝規則② fail-closed 擋死）過去只有一條路：
 * William 特准刪留言（#461、#475 兩例）——刪除本身傷稽核軌跡，逐字存檔還會把 🤖 抄成
 * 新的壞標頭（#475 實踩：存檔留言自己變毒丸）。改為：**壞留言原地保留**，由一行豁免宣告
 * （寫在帶合規標頭留言的收件區，與重述行同一位置規則）把那條阻擋降為警告。
 *
 * ## 格式（逐字；一行一則）
 *   豁免留言 <留言編號>｜William 特准 <YYYY-MM-DD>｜原第一行：「<壞掉那則的第一行，逐字引用>」
 *
 * ## 規則（比重述更窄：它**只會中和、不會產生**）
 * ・三重指認缺一不可＝留言編號（該留言 issuecomment 網址尾碼）＋逐字引文（trim 比對）＋特准日期。
 * ・只能中和「用了 🤖 但標頭寫壞」那條阻擋——**合規結論（含阻擋）豁免不掉**（豁免只查
 *   malformed 名單，結構上碰不到聯集）、也**不產生任何結論進聯集**（沒有洗白或放行路徑）。
 * ・豁免宣告必須出現在壞留言**之後**（同重述規則⑥：不可預先授權未來的壞留言）。
 * ・引文守則與重述同一套（隱形字元拒收、白名單、反引號配對）。
 * ・誠實劃界＝與整道閘相同：「William 特准」是自我宣告、閘不驗 William 本人（這支防的是
 *   打錯字鎖死，不防惡意——惡意者本來就能偽造整個合規標頭）；日期讓 William 事後可抽查對帳。
 */
const EXEMPT = /^ {0,3}豁免留言\s*(\d{6,})｜William 特准\s*(\d{4}-\d{2}-\d{2})｜原第一行：「(.+)」[^\S\n]*$/u;
/**
 * 引文裡 sha 長相的字（7–40 位十六進位）出現幾個。**多於一個＝讀不準它在講哪個版本 ⇒ 不可重述**。
 * ⚠️ 不用「審 sha｜r<n>｜」整組去數（#418 r5 High①）：攻擊者少打一個 ｜（`r8 結論：`）就不成組，
 *    人眼看到兩組、程式只數到一組。sha 長相的字是**性質**——正常的壞標頭只會有一個版本指紋，
 *    第二個 hex 長字不管用什麼分隔符包裝都是歧義。
 * ⚠️ 刻意**不數 r<n>**：真實的壞標頭尾巴常有輪次字樣（實例：「需修正（1 Medium；r2 兩個 High 已關閉）」
 *    ——那個 r2 是在講歷史，不是第二組 metadata）。輪次沒有 sha 就指不到版本，不構成洗白路徑。
 */
const QUOTED_SHA_LIKE = /[0-9a-fA-F]{7,40}/g;
/**
 * 引文的**字元白名單**（#418 r5 High② 的性質收口）。r4 封了 `<!--` 與未配對反引號，r5 就來
 * `<details>` 與 `![`——黑名單軍備賽輸定了（本專案的老教訓：列舉補不完）。改成白名單：
 * 引文只准出現「壞標頭合理會有的字」＝文字、數字、空白、🤖、全形標點、反引號。
 * **`<`、`[`、`!` 這些能開啟隱形容器（raw HTML／圖片／連結）的字元通通不在名單上**——
 * 含名單外字元的壞留言＝不可重述（fail-closed；留著阻擋，走關掉重開或問 William）。
 * 實測五則真實壞標頭（「要求修改」「通過（無阻擋）」「退回修改（1 個 High）」「不通過（有假綠）」
 * 「需修正（1 Medium；r2 兩個 High 已關閉）」）全部在名單內。
 */
const QUOTE_ALLOWED = /^[\p{L}\p{N}\p{Zs}\t🤖｜：:（）()、，,；;。．.…—－\-_'’‘"”“`／/]*$/u;   // ⚠️✅❌ 這類組合字元刻意不收（lint no-misleading-character-class；含它們的壞留言走 fail-closed）
/**
 * **隱形字元一律拒收**（#418 r6 High）：Unicode 有一族「預設不顯示」的碼位
 * （Default_Ignorable_Code_Point，例：U+115F 韓文填充字元）——它們同時歸類為字母（\p{L}），
 * 所以擠得進白名單，卻能把第二個 sha 切碎藏起來（每六碼插一個，畫面看是同一串指紋、
 * 計數器數不到）。性質收口：整行含任何一個這族字元＝不可重述。
 */
const HIDDEN_CP = /\p{Default_Ignorable_Code_Point}/u;
/** 空白摺疊：**只用在身分（來源）比對**——與 headerOf 的 source 正規化同一個理由。
 *  ⚠️ 引文比對**不用它**（#418 r1 阻擋③）：引文是「逐字」，摺疊空白＝在 🤖 後多打一個空白
 *  也算引中，那就不是逐字了。引文只容許**頭尾**空白差異（trim），中間每一個空白都要一樣。 */
const collapse = (/** @type {string} */ t) => String(t || '').trim().replace(/\s+/gu, ' ');

/**
 * **寬鬆正規化**（三步，逐字對應下面那行實作）：
 *   ①`NFKC`（全形英數與括號折成半形：`Ｃｏｄｅｘ ＣＬＩ` → `Codex CLI`）
 *   ②轉小寫
 *   ③**只保留 Unicode Letter（`\p{L}`）與 Number（`\p{N}`）**，其餘一律刪掉
 * `CLI（gpt-5.6-sol xhigh）` → `cligpt56solxhigh`
 *
 * ⚠️ 第③步的精確說法是「只保留字母與數字」，不是「拿掉標點」（Codex #456 r4 Medium②）：
 * emoji、連字號、以及**未被 NFKC 合成**的 combining mark 都會被刪；combining mark 若先被
 * NFKC 合成為字母則保留。差別看得見——把連字號留下來的話，`codex-CLI` 與 `codexCLI`
 * 就不再相等（考題釘住這個邊界）。
 *
 * ⚠️ **它只餵給 `sourceLookalike()` 出聲提醒，判定路徑一個字都不用它**——
 * 身分比對仍然是 `headerOf()` 那條「只摺疊空白」的逐字規則。理由見 `sourceLookalike()`。
 * @param {string} s
 */
function looseSource(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 正規化後短於這個長度就不比——兩個字互相包含沒有指示性（`桌面` vs `桌面版`）。
 * ⚠️ `CLI` 正好**在門檻上**（3 個字）＝要比，因為 `CLI` vs `codex CLI` 正是 #453 的漂法之一。
 *    改這個數字會靜靜關掉那一族提醒 ⇒ 考題兩個方向都釘住（Codex #456 r1 Medium③：
 *    改成 4 時 86 題全綠、`CLI` 那族卻已經不提醒了）。
 */
const LOOSE_MIN = 3;

/**
 * 兩個來源字串**看起來像不像同一位審查者**？像就回一句原因，不像回 `null`。
 *
 * ## 它在解什麼（2026-08-14 #453 實際踩到）
 *
 * 身分＝`角色`＋`來源`，而來源**只摺疊空白**（見 `headerOf()`）——全形／半形括號、
 * 有沒有 `codex` 前綴、有沒有逗號，通通算不同的人。那天同一個 codex CLI，來源在不同輪次
 * 被打成 `CLI（gpt-5.6-sol xhigh）` 與 `codex CLI (gpt-5.6-sol, xhigh)`，於是閘把**同一位**
 * 審查者拆成兩個身分：r8 的「需修改後再審」掛在其中一個身分底下，他自己從來沒撤銷過它
 * （新留言掛到另一個身分）⇒ 合併被擋；補了那一半，另一半又停在舊 sha ⇒ 再擋一次。
 *
 * 兩次都不是規則出錯，是**打字漂掉而現場沒有人看得出來**——閘的輸出只列出兩個名字，
 * 沒有任何一句話說「這兩個可能是同一位」。這個函式就是補那句話。
 *
 * ## ⚠️ 誠實劃界：**這是警告，不是自動合併身分**
 *
 * ・偵測到也**不會**把兩個身分併成一位。不同 session 本來就該是不同審查者
 *   （#383 的病根正是「兩份都自稱 Claude 複審、結論相反」），自動正規化等於把兩位悄悄
 *   變成一位——那是**削弱這道閘**，方向剛好相反。判定規則一格都沒放寬。
 * ・**邊界就是演算法本身**（講性質、不列清單）：任一個名字正規化後短於 `LOOSE_MIN`
 *   （＝JS `length`／UTF-16 編碼單位，不是 Unicode 字元數：`𠮷a` 是兩個字元卻算 3），
 *   或兩者正規化後既不相等、也不互相包含 ⇒ **不提醒**。
 *   正規化＝NFKC → 小寫 → **只保留 Unicode Letter／Number**（三步的細節見 `looseSource()`）。
 *   ⚠️ r1 我寫成「抓不到的有三族」，r2 Codex 當場又找出三族不在名單上（換序、中間打錯一個字、
 *   共同後綴不同前綴）——**列舉補不完**，這是本專案認過很多次的病型，我在自己的劃界裡又犯一次。
 *   例示（不是清單）：`CLI` vs `第二輪複審`／`codex CLI (…, xhigh)` vs `codex CLI (…, medium)`
 *   ／`本機 codex CLI` vs `桌面 codex CLI`／`codex CLI xhigh` vs `xhigh codex CLI`
 *   ／`codex CLI xhigh` vs `codex CLl xhigh`／`桌面` vs `桌面版`。
 *   第二例正是文件禁止「把 effort 寫進來源」要防的漂法——**規矩比提醒可靠**。
 * ・反方向會多嘴一次：真的有兩個 session、名字剛好一個包住另一個（`codex CLI` 與
 *   `codex CLI 版面`）會被點名。代價是一句提醒，處方是取兩個不互相包含的名字
 *   （標準字串表＝`REVIEW-AND-MERGE.md`「發審查提示」節）。
 * @param {string} a @param {string} b
 * @returns {string|null}
 */
export function sourceLookalike(a, b) {
  const x = looseSource(a);
  const y = looseSource(b);
  if (x.length < LOOSE_MIN || y.length < LOOSE_MIN) return null;
  // ⚠️ 理由字串要把**三步都講到**（Codex #456 r4 Medium②）：原本漏了「轉小寫」，
  //    於是純大小寫漂移時，終端印出的原因是錯的（說成標點或全形半形的差別）。
  if (x === y) return '折全形、轉小寫、只留字母與數字之後**完全相同**';
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // 包含關係才是 #453 那個真實形狀（`cligpt56solxhigh` 整個包在 `codexcligpt56solxhigh` 裡）——
  // 只比「正規化後相等」的話，漏掉工具名前綴的那次就抓不到。
  if (long.includes(short)) return '折全形、轉小寫、只留字母與數字之後，其中一個**整個包在另一個裡面**（多半是工具名前綴打了一次、漏了一次）';
  return null;
}

/**
 * 從一則留言抽出來歷標頭。抓不到就回 null（呼叫端決定那算不算問題）。
 * @param {string} body
 */
export function headerOf(body) {
  const first = String(body || '').split('\n').find((l) => l.trim()) || '';
  const m = HEADER.exec(first);
  if (!m) return null;
  const verdict = m[5].replace(/[。．.]$/u, '');
  // ⚠️ `in` 會命中原型鍵（`toString`／`constructor` 都會被當成合法的第四種結論）——
  //    本專案的原型鍵鐵則，我在自己的新腳本裡又犯一次（Codex #385 r1 Medium⑤）。
  if (!Object.hasOwn(VERDICTS, verdict)) return null;
  // ⚠️ **來源不可以是空白**（Codex #385 r4 High①）：兩個 session 都漏填來源時，
  //    正規化後都變成 `Codex（）`＝同一位審查者 ⇒ 第二個 session 的「通過」
  //    就撤銷了第一個的阻擋——**#383 的核心病原樣重現**。
  if (!m[2].trim()) return null;
  // ⚠️ **角色要走 `canonicalRole()`，不能收任意英文字**（Codex #385 r11）：
  //    原本 `[A-Za-z]+` 照單全收，於是打錯字的 `Codeex` 會被當成**另一位正式審查者**——
  //    它喊的停，正確的 `Codex` 說「通過」永遠撤銷不掉（同一位審查者才能撤銷），
  //    變成一條**幽靈阻擋**；而且因為標頭「合法」，連 `hasBotMark()` 都不會點名它是壞標頭。
  const role = canonicalRole(m[1]);
  if (!role) return null;
  return {
    role,
    // 來源做 collapse whitespace：多打一個空白不該變成「另一個審查者」（那會多出一條永遠撤不掉的阻擋）
    source: m[2].trim().replace(/\s+/gu, ' '),   // 非空由下方 headerOf 尾端把關
    sha: m[3].toLowerCase(),
    round: Number(m[4]),
    verdict,
    blocking: VERDICTS[/** @type {keyof typeof VERDICTS} */ (verdict)],
  };
}

/** 「結論」這件事的各種叫法。這一組**小而穩定**，不是在列舉結論的內容。 */
const MARKER = '(?:結論|審查結果|複審結果|審查結論|複審結論|複審完成|審查完成)';
/** 「結論三選一：」「三選一結論：」「結論（三選一）：」——**引出**結論的標籤句型。 */
const LABEL = new RegExp(`${MARKER}[^：:\\n]{0,6}[：:]`, 'u');
/** 標題裡光是提到「結論」就算在下結論（標題不需要冒號）。 */
const MARKER_RE = new RegExp(MARKER, 'u');
/**
 * **對「合併」下許可判斷**。
 * 尾端的 `(?![：:])` 是關鍵：`不可合併：兩個 state 要分開存` 是在**替某個狀態命名**，不是結論。
 */
const MODALITY = '(?:可以|可否|能否|不能|不可以|不可|不宜|不建議|建議|暫不可|暫不|尚不可|還不能|可)';
// ⚠️ `(?!…)` 裡的 `\s*` 是 Codex #385 r9 補的：`不可合併 two reviewer states` 的受詞前有空格，
//    原本只擋「緊接著」的受詞，隔一個空格就繞過去了——**又是同一種邊界漏洞**。
const MERGE_RULING = new RegExp(`${MODALITY}\\s*(?:直接\\s*)?合併(?![：:]|\\s*[\\p{L}\\p{N}])`, 'u');
/** 某一行**以結論用詞開頭**、之後句子就結束或接標點（冒號除外——那是標籤句型）。 */
const STARTS_WITH_VERDICT = new RegExp(
  // ⚠️ `／`、`、`、`/` 不算「句子結束的標點」（Codex #385 r10）：
  //    `通過／失敗：25／0` 是每份測試報告都會寫的統計句，不是結論。
  `^(?:${Object.keys(VERDICTS).join('|')})(?:\\s*$|\\s*[^\\p{L}\\p{N}\\s：:／、/])`, 'u');

/**
 * 這則留言**想用來歷標頭但寫壞了**——判準是出現 `🤖`（剝掉引用與 code 之後）。
 *
 * ⚠️ 這是**唯一還留在阻擋路徑上的文字判斷**，因為它的誤判面極小：
 * 一則正文出現 `🤖` 的留言，幾乎不可能不是在試這個格式。
 * 而它擋的是真實會發生的事——標頭打錯一個字，整則結論就被無視。
 * @param {string} body
 */
export function hasBotMark(body) {
  return stripFencesLoose(String(body || ''))
    .replace(/^[^\S\n]*>.*$/gm, '')
    .split('\n')
    .some((l) => /🤖/u.test(l.replace(/(`+)[^`]*\1/gu, '')));
}

/**
 * 一則留言看起來是不是「有人在下結論」——用來抓「下了結論卻沒有合規標頭」的漏網。
 *
 * ## ⚠️ 先講清楚它在這道閘裡的位置：**它不是判準，是提示**
 *
 * 放行的判準只有一條，而且**不依賴這個函式**：
 * 「對目前 head，有一則**合規標頭**的『通過』，來自 PR 指定的獨立審查者，且沒有未撤銷的阻擋。」
 * 沒有標頭的留言對這道閘**沒有效力**——既不能放行，也不算撤銷。
 * 所以就算這個函式一個字都沒抓到，#383 那個場景（兩則相反的無標頭複審）照樣被擋
 * ——擋它的是「沒有任何合規標頭的通過」，不是這個函式。
 *
 * 這個函式要防的是另一件事：**有人以為自己喊了停，但因為沒帶標頭而被無視。**
 * 它命中時**只印一則提醒，不影響退出碼**——r11 起刻意如此，理由是兩個方向的代價完全不對稱：
 *   ・**漏抓**：不會讓無標頭的留言取得任何效力，只是少掉一句提醒。**不是安全問題。**
 *   ・**誤擋**：會機械性擋住合併，**相對 `main` 是實質退步**（原本人工確認不會卡住那些留言）。
 * 而它連兩輪被 Codex 實測出誤擋正常留言（`## 如何合併兩個 reviewer state`、`通過／失敗：25／0`…），
 * 其中三個還是我上一輪「修誤擋」時新造出來的。
 * ⇒ **一個零安全價值、卻持續製造退步的阻擋條件，不該是阻擋條件。**
 * 唯一還留在阻擋路徑上的文字判斷是 `hasBotMark()`（見上）。
 *
 * ## 判準倒過來：偵測「下結論這個動作」，不是比對「結論寫成什麼字」
 *
 * Codex 拿**它自己寫過的 25 份報告**當語料，連兩輪打穿：r7 抓到 9/25、r8 抓到 14/25。
 * 漏掉的全是它前一天寫的正常措辭（「三選一結論：⚠️ 修正後再審。」「目前不建議合併」
 * 「4. 不可以合併。」「可以合併。」）。**那是同一個錯的第七、第八次：我在列舉措辭。**
 *
 * 現在的五種訊號都是**結構**，跟措辭無關：
 *   (1) 出現 `🤖`——想用這個格式卻寫錯
 *   (2) **標題**提到結論或合併：標題問「可以合併嗎？」＝這則要回答它（內文問才是真的在問人）
 *   (3) `結論…：` 這種**引出**結論的標籤句型
 *   (4) 對「合併」下**許可判斷**（可以／不可以／不建議／暫不可…），且前面沒有別的標籤引出它
 *   (5) 某一行**以結論用詞開頭**、之後句子就結束或接標點（冒號除外＝標籤句型）
 *
 * ## 誠實劃界
 *
 * 現在對 `test/fixtures/review-verdict-corpus.json` 是 **25/25 正例、0 誤擋**——
 * 那份語料是真的（25 份報告原文＋3 則真實非結論留言），不是我挑的代表例
 * （**r8 的題目寫「25 份」卻只放 6 個代表例，那本身就是假綠**）。
 * 擋不住的：完全不提「合併」也不寫「結論」的結論（例如只寫「LGTM」）。
 * 那種漏抓**不會造成 #383**（判準那條還在），只會少一句提醒。
 * 反方向：討論這道閘本身時，若在標題寫「結論」或在內文寫「可以合併」，會被要求補標頭
 * ——Codex 自己評估這個代價可以接受（#385 r8），改個字或補標頭即可。
 * @param {string} body
 */
export function looksLikeVerdict(body) {
  const text = stripFencesLoose(String(body || ''))
    .replace(/^[^\S\n]*>.*$/gm, '');       // 引用別人的話不是自己的結論

  /** 去掉行內 code：**任意長度的反引號**都算。 */
  const noCode = (/** @type {string} */ l) => l.replace(/(`+)[^`]*\1/gu, '');
  // ⚠️ 粗體要在判斷前剝掉（真實語料抓到的）：#383 那則「## Claude 第二輪獨立複審」
  //    把結論寫成 `**結論：通過，可以合併。**`，前面是 `**` 而不是行首 ⇒ 邊界對不上就整則看不見。
  //    **那正是造成 #383 的兩份相反複審之一。**
  const lines = text.split('\n').map((l) => noCode(l).replace(/[*_]/gu, ''));

  if (hasBotMark(body)) return true;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 標題：**不要求冒號**（`## 三題結論` 是真實原文），問句也算
    //（`## 3. 可以合併嗎？` 後面接的就是答案——標題在問，等於這則要回答它）
    // ⚠️ 標題不可以只看「有沒有合併兩個字」（Codex #385 r9）：
    //    `## 如何合併兩個 reviewer state` 是正常的技術標題，被擋掉會真的卡住合併。
    //    標題也要吃「後面接受詞」那道分辨（Codex #385 r10）：
    //    `## 為什麼不可合併兩個 reviewer state` 是技術標題，不是結論。
    if (/^#{1,6}\s/u.test(line)
      && (MARKER_RE.test(line) || MERGE_RULING.test(line) || /合併(?:嗎|與否)/u.test(line))) return true;
    if (/[？?]\s*$/u.test(line)) continue;   // 內文的問句是在問人，不是在下結論
    // ⚠️ 引號裡的裁決**通常**是在講那個詞，但**不是絕對**（Codex #385 r9 兩個方向都給了例子）：
    //    「腳本遇到『不可合併』要回 exit 1」是在講那個詞；
    //    「結論是『通過，可合併』」則是真的在下結論。分界＝**同一行有沒有「結論」這個標記**。
    if (MARKER_RE.test(line) && MERGE_RULING.test(line)) return true;
    //    引號要連 ASCII 的一起剝——只排除中文引號，`"不可合併"` 就繞過去了。
    const bare = line.replace(/[「『][^」』]*[」』]|"[^"]*"|“[^”]*”|'[^']*'/gu, '');
    if (LABEL.test(bare)) return true;
    // ⚠️ 被**別的標籤引出**的裁決是在舉例：「範例：不可合併。」「退出碼說明：不可合併，回 1。」
    //    判準是冒號在裁決**前面**，不是「這行有冒號」——
    //    「2. 暫不可合併。 仍有一條假綠：」的冒號在後面，那是正式結論（#384 r9 真實原文）。
    //    （`結論：…` 不受影響：上一行的 LABEL 已經先回 true。）
    const ruling = MERGE_RULING.exec(bare);
    //    冒號要在**同一個子句**裡才算標籤引出（Codex #385 r9）：
    //    `不通過：1 個 blocking。PR #358 暫不可合併。` 的冒號隔了一個句號，那是兩件事。
    const labelIntro = ruling && /[：:][^。！？；!?;]*$/u.test(bare.slice(0, ruling.index));
    if (ruling && !labelIntro) return true;
    // (5) 某一行**以結論用詞開頭**、後面句子就結束或接標點。
    //     排掉冒號：「通過：1395/1395 題」是標籤句型，不是結論。
    const stripped = bare.replace(/^[\s>#*+_-]*(?:\d+[.)]\s*)?/u, '').trim();
    if (STARTS_WITH_VERDICT.test(stripped)) return true;
  }
  return false;
}


/**
 * 寬鬆版的 fence 剝除（縮排 0–3、``` 與 ~~~ 都認）。
 *
 * ⚠️ 這裡刻意**不做完整的 CommonMark 文法**（那份在 `test/contract-split.test.js`）：
 * 這支要的是「別把範例裡的字當成結論」，寧可多剝一點也不要漏——
 * 和契約護欄那支「寧可紅也不要放過」的方向相反，因為這裡誤擋的代價比較高。
 * @param {string} md
 */
function stripFencesLoose(md) {
  let open = null;
  const out = [];
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) { open = open && open === m[1][0] ? null : (open || m[1][0]); continue; }
    if (!open) out.push(line);
  }
  return out.join('\n');
}

/**
 * 聯集判定。
 *
 * ⚠️ **撤銷只能由同一個審查者做，而且要用更新（或相同）的 commit**：
 * A 說「需修改」之後，B 說「通過」**不會**解除 A 的阻擋——那正是 #383 的情境。
 * 同一個審查者身分＝`角色 + 來源`（不是只有角色：兩個 Claude session 是兩個審查者）。
 *
 * ⚠️ **所以來源字串是機械身分，不是描述文字**——同一個審查工具跨輪次改寫法（多一個前綴、
 * 換成全形括號）就會被拆成兩位（2026-08-14 #453）。標準字串表與補救程序＝
 * `REVIEW-AND-MERGE.md`「發審查提示」節；長得像的兩個來源由 `sourceLookalike()` 出聲提醒。
 *
 * @param {{body: string}[]} comments
 * @param {string} head
 * @param {string|null} [reviewerRole] PR 說明指定的獨立審查者角色；`null`＝讀不出來（退回「任何一位都算」）
 * @returns {{ problems: string[], warnings: string[], reviewers: Record<string, any> }}
 */
export function verdictProblems(comments, head, reviewerRole = null) {
  /** @type {string[]} */ const problems = [];
  /** @type {string[]} */ const warnings = [];
  /** @type {Record<string, any>} */ const latest = {};
  /** 聯集更新（原本內聯在迴圈裡；重述行也要走**同一條路**，所以抽出來共用）。 @param {any} h */
  const applyEntry = (h) => {
    const who = `${h.role}（${h.source}）`;
    const cur = latest[who];
    if (!cur || h.round > cur.round) { latest[who] = { ...h, who }; return; }
    // ⚠️ **同輪次出現相反結論 → fail-closed**（Codex #385 r1 High①）：
    //    原本用 `>=`，於是同為 r2 時「需修改」後貼「通過」就放行、反過來就阻擋
    //    ——**結果取決於留言順序**，那正是這支要根治的病，我卻在自己的實作裡犯了。
    //    契約寫的是「**更新的**輪次才能撤銷」，同輪次不算撤銷。
    if (h.round === cur.round && h.blocking !== cur.blocking) {
      latest[who] = { ...cur, conflict: true, blocking: true,
        verdict: `同一輪（r${h.round}）出現相反結論：${cur.verdict} vs ${h.verdict}` };
    }
  };
  /** 合規重述（鑰匙＝逐字引文；idx＝重述那則留言的位置，規則⑥用）。 @type {{key: string, who: string, idx: number}[]} */
  const restated = [];
  /** 壞標頭留言：先收集、**掃完全部留言再判**（重述通常出現在壞留言之後）。`id`＝issuecomment 網址尾碼（豁免宣告的指認鍵；讀不到＝null＝那則不可豁免，fail-closed）。 */
  const malformed = /** @type {{key: string, excerpt: string, idx: number, id: string|null}[]} */ ([]);
  /** 豁免宣告（規則見 EXEMPT）。 @type {{id: string, date: string, key: string, who: string, idx: number}[]} */
  const exempts = [];
  let idx = -1;
  for (const c of comments) {
    idx++;
    const h = headerOf(c.body);
    if (!h) {
      const excerpt = `「${String(c.body).replace(/\s+/g, ' ').slice(0, 60)}…」`;
      const shape = `（第一行要長成「🤖 角色｜來源：…｜審 \`sha\`｜r<n>｜結論：${Object.keys(VERDICTS).join('／')}」）`;
      if (hasBotMark(c.body)) {
        const first = String(c.body).split('\n').find((l) => l.trim()) || '';
        const cid = (String(/** @type {any} */ (c).url || '').match(/#issuecomment-(\d+)$/) || [])[1] || null;
        malformed.push({ key: first.trim(), excerpt: `${shape}：${excerpt}`, idx, id: cid });
      } else if (looksLikeVerdict(c.body)) {
        // **只警告，不阻擋**——理由見 `looksLikeVerdict()` 上方那節。
        warnings.push(`這則留言看起來在下結論，但沒有來歷標頭 ⇒ **這道閘不會採計它**${shape}：${excerpt}`);
      }
      continue;
    }
    // 重述行（#418 r3 位置規則）：**緊跟在標頭後面**（中間只准空行），碰到第一行別的內容就停收。
    // 這讓 fence／清單／HTML 註解／引用……任何容器都插不進「標頭與重述行之間」——不需要解析器。
    const lines = String(c.body || '').replace(/\r\n?/g, '\n').split('\n');
    const headerIdx = lines.findIndex((l) => l.trim());
    let cursor = headerIdx + 1;
    const restateIdxs = [];
    const exemptIdxs = [];
    for (; cursor < lines.length; cursor++) {
      const raw = lines[cursor];
      if (!raw.trim()) continue;                                    // 空行可以隔開（含全形空白，見劃界）
      const shapeRestate = /^ {0,3}重述\s*r\d+｜/u.test(raw);
      const shapeExempt = /^ {0,3}豁免留言\s*\d/u.test(raw);        // 豁免宣告與重述共用收件區（同一套位置規則）
      if (!shapeRestate && !shapeExempt) break;                     // 第一行別的內容＝收件截止
      // ⚠️ **整行合規才延續收件**（#418 r4 High①）：前綴像重述、整行不合規的行（例：`重述 r0｜<!--`）
      //    以前會被跳過而讓收件區繼續往下——它夾帶的 `<!--` 把下一行真生效的重述藏進 HTML 註解，
      //    機器算數、人看不見＝可稽核性破功。現在這種行＝出聲＋收件截止。豁免宣告同一標準。
      if (shapeRestate ? !RESTATE.test(raw) : !EXEMPT.test(raw)) {
        warnings.push(`一行${shapeRestate ? '重述' : '豁免宣告'}**格式不合規、且讓收件當場截止**（它之後的重述／豁免行一律不生效）：`
          + `「${collapse(raw).slice(0, 80)}…」`);
        break;
      }
      // ⚠️ 合規的行也可能在**引文裡**夾隱形容器把下一行藏出畫面（r4 抓到 <!--、r5 抓到
      //    <details> 與 ![ ——黑名單補不完）。性質收口＝引文只准白名單字元＋反引號要配對；
      //    出界＝那一則壞留言不可重述／豁免（fail-closed 劃界），同樣收件截止。
      const quoteM = shapeRestate ? RESTATE.exec(raw) : EXEMPT.exec(raw);
      const quoteTxt = quoteM ? quoteM[shapeRestate ? 4 : 3] : '';
      if (HIDDEN_CP.test(raw)) {
        warnings.push(`一行${shapeRestate ? '重述' : '豁免宣告'}含**隱形字元**（Unicode 預設不顯示的碼位）——那是把指紋或內容藏出`
          + `畫面的原料，不生效且收件截止：「${collapse(raw).slice(0, 80)}…」`);
        break;
      }
      if (!QUOTE_ALLOWED.test(quoteTxt) || (raw.split('`').length - 1) % 2 !== 0) {
        warnings.push(`一行${shapeRestate ? '重述' : '豁免宣告'}的引文含白名單外的字元（例如 <、[、! 這類能開啟隱形容器的）`
          + `或未配對的反引號——不生效且收件截止：「${collapse(raw).slice(0, 80)}…」`);
        break;
      }
      (shapeRestate ? restateIdxs : exemptIdxs).push(cursor);
    }
    for (const li of restateIdxs) {
      const line = lines[li];
      const m = RESTATE.exec(line);
      const bad = (/** @type {string} */ why) => { warnings.push(`一行重述**無效、不生效**（${why}）：「${collapse(line).slice(0, 80)}…」`); };
      if (!m) { bad('格式不合規——要長成「重述 r<n>｜審 `sha`｜結論：三選一｜原第一行：「…」」'); continue; }
      const verdict = m[3].trim().replace(/[。．.]$/u, '');
      if (!Object.hasOwn(VERDICTS, verdict)) { bad(`結論「${verdict}」不是三選一`); continue; }
      const round = Number(m[1]);
      // 規則④：重述輪次必須小於自己標頭的輪次——否則可以用重述行造出更高輪的「通過」。
      if (round >= h.round) { bad(`重述的輪次 r${round} 不小於這則留言自己的 r${h.round}`); continue; }
      // 規則②＋⑤（#418 r4 High②：**一支錨定解析器一次綁定**）：角色、來源、sha、輪次都從引文
      // **行首**讀出；讀不出＝不可重述（fail-closed）。**唯一例外＝缺 sha 型**（規則見
      // QUOTED_HEAD_NOSHA）：sha 欄空白、其餘三欄照舊讀得出，才走例外。
      const q4 = QUOTED_HEAD.exec(m[4]);
      const qn = q4 ? null : QUOTED_HEAD_NOSHA.exec(m[4]);
      if (!q4 && !qn) { bad('引用的第一行讀不出「誰寫的、審哪個 sha、第幾輪」（四欄要在行首連著；唯一例外＝sha 欄空白而其餘讀得出的缺 sha 型）——讀不出就不可重述，維持阻擋'); continue; }
      // 引文裡的 sha 歧義（#418 r5 High①）：四欄型＝第二個 sha 長相的字就讀不準它在講哪個版本；
      // 缺 sha 型＝**必須零個**（空欄位＋別處冒出的指紋＝同樣讀不準）。
      // ⚠️ 在 **NFKC 正規化副本**上數（#418 r6 High）：全形的 hex 字（ｄｅａｄｂｅｅ）在 \p{L}/\p{N}
      //    白名單內、原字串數不到，但畫面上就是一串指紋——正規化後現形。逐字比對仍用原字串。
      const shaLikeCount = ((m[4].normalize('NFKC')).match(QUOTED_SHA_LIKE) || []).length;
      if (q4 && shaLikeCount > 1) {
        bad('引用的第一行出現第二個 sha 長相的字——讀不準它在講哪個版本，不可重述，維持阻擋');
        continue;
      }
      if (qn && shaLikeCount !== 0) {
        bad('缺 sha 型重述要求引文**全行零個** sha 長相的字——空欄位加上別處的指紋＝讀不準版本，不可重述，維持阻擋');
        continue;
      }
      const qRole = q4 ? q4[1] : /** @type {RegExpExecArray} */ (qn)[1];
      const qSrc = q4 ? q4[2] : /** @type {RegExpExecArray} */ (qn)[2];
      const qRound = Number(q4 ? q4[4] : /** @type {RegExpExecArray} */ (qn)[3]);
      if (canonicalRole(qRole) !== h.role || collapse(qSrc) !== h.source) {
        bad(`只能重述**自己**的壞留言：引用裡是 ${qRole}（${collapse(qSrc)}），重述者是 ${h.role}（${h.source}）`);
        continue;
      }
      if (q4 ? (q4[3].toLowerCase() !== m[2].toLowerCase() || Number(q4[4]) !== round) : qRound !== round) {
        bad(q4
          ? `重述自報的（審 ${m[2].slice(0, 7)}｜r${round}）與引文裡的（審 ${/** @type {RegExpExecArray} */ (q4)[3].slice(0, 7)}｜r${/** @type {RegExpExecArray} */ (q4)[4]}）不一致`
          : `缺 sha 型重述的輪次 r${round} 與引文裡的 r${qRound} 不一致（版本由重述行自報，輪次仍要綁引文）`);
        continue;
      }
      // 規則①的鑰匙＝逐字引用（trim-only）；規則⑥的順序綁定在收尾那一段做（要知道壞留言的位置）。
      restated.push({ key: m[4].trim(), who: `${h.role}（${h.source}）`, idx });
      applyEntry({ role: h.role, source: h.source, sha: m[2].toLowerCase(), round, verdict,
        blocking: VERDICTS[/** @type {keyof typeof VERDICTS} */ (verdict)] });
    }
    for (const li of exemptIdxs) {
      const em = EXEMPT.exec(lines[li]);
      if (!em) continue;   // 收件迴圈已驗過整行合規；這裡只是型別保險
      exempts.push({ id: em[1], date: em[2], key: em[3].trim(), who: `${h.role}（${h.source}）`, idx });
    }
    // 位置不對的「重述 r…」／「豁免留言 …」樣子的行＝不生效，但要出聲（#418 r3 Medium：不然
    // 真心想重述／豁免的人把行放錯位置，會以為清掉了）。只給警告，所以用寬鬆剝除（範例不吵）。
    const loose = stripFencesLoose(String(c.body || '')).replace(/^[^\S\n]*>.*$/gm, '').split('\n');
    for (let i2 = 0; i2 < loose.length; i2++) {
      if (!/^ {0,3}(?:重述\s*r\d+｜|豁免留言\s*\d)/u.test(loose[i2])) continue;
      if (restateIdxs.some((ri) => lines[ri] === loose[i2])) continue;   // 已生效的那幾行不吵
      if (exemptIdxs.some((ri) => lines[ri] === loose[i2])) continue;
      warnings.push('有一行長得像重述或豁免宣告、但**不在生效位置**（必須緊跟在標頭後面，中間只准空行）'
        + `⇒ 不生效：「${collapse(loose[i2]).slice(0, 80)}…」`);
    }
    applyEntry(h);
  }
  // 壞標頭：被合規重述接管的降為警告（歷史留在原地、GitHub 可稽核）；其餘照舊**阻擋**。
  // 規則⑥：重述那則留言必須出現在壞留言**之後**——不然可以「預先授權」一則還沒出現的壞留言。
  for (const m of malformed) {
    const taker = restated.find((r) => r.key === m.key && r.idx > m.idx);
    const early = !taker && restated.find((r) => r.key === m.key);
    // 豁免（規則見 EXEMPT）：三重指認（編號＋逐字引文＋日期在宣告行裡）＋順序（宣告在壞留言之後）。
    // `m.id == null`（留言物件沒有 url 可解）＝不可豁免——fail-closed。
    const ex = !taker && exempts.find((e) => e.key === m.key && e.idx > m.idx && m.id != null && e.id === m.id);
    if (taker) {
      warnings.push(`一則壞標頭留言已被 ${taker.who} 的重述行接管（重述的結論已照常進聯集）：「${m.key.slice(0, 60)}…」`);
    } else if (ex) {
      warnings.push(`一則壞標頭留言已被**豁免**（William 特准 ${ex.date}，由 ${ex.who} 宣告；`
        + `壞留言原地保留＝稽核軌跡不動，僅「標頭寫壞」這條阻擋中和、不產生任何結論）：「${m.key.slice(0, 60)}…」`);
    } else {
      // **阻擋**：出現 🤖 就是在試這個格式，寫壞了要當場說——誤判面極小。
      problems.push(`有一則留言用了 🤖 記號、但標頭格式不合規${m.excerpt}\n`
        + (early ? '    ⚠️ 有一行引文對得上的重述，但它出現在這則壞留言**之前**（重述不可以預先授權未來的壞留言）。\n' : '')
        + '    ↳ 修復：**同一位審查者**在新留言（帶合規標頭）加一行'
        + '「重述 r<n>｜審 `sha`｜結論：三選一｜原第一行：「＜逐字引用壞掉那行＞」」（規則見腳本 RESTATE 一節；'
        + 'sha 欄空白、其餘三欄讀得出的壞行走**缺 sha 例外**＝重述行自報版本）。\n'
        + '    ↳ 連角色／來源／輪次都讀不出的型＝重述救不了：經 **William 特准**後，帶合規標頭的留言'
        + '收件區加一行「豁免留言 <留言編號>｜William 特准 <YYYY-MM-DD>｜原第一行：「＜逐字引用＞」」'
        + '（編號＝該留言 issuecomment 網址尾碼；壞留言**原地保留**、不再刪留言——規則見腳本 EXEMPT 一節）。');
    }
  }
  // **同一位審查者被打成兩種來源寫法 → 閘會把他拆成兩個身分**（2026-08-14 #453 實際踩到，
  // 完整病歷與劃界＝`sourceLookalike()`）。⚠️ **只出聲、不併身分**：不同 session 本來就該是
  // 不同審查者，自動正規化會削弱這道閘。
  const ids = Object.values(latest);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      // 角色不同＝本來就是不同審查者（Claude 與 Codex 各有一個叫「CLI」的 session 很正常），不比。
      if (ids[i].role !== ids[j].role) continue;
      const why = sourceLookalike(ids[i].source, ids[j].source);
      if (!why) continue;
      warnings.push(`「${ids[i].who}」與「${ids[j].who}」的來源${why}`
        + ' ⇒ **這兩個可能是同一位審查者被打成兩種寫法**（身分＝角色＋來源，只摺疊空白）。\n'
        + '    ・這道閘**不會**自動把它們併成一位——所以兩邊的結論各自算數，'
        + '其中一邊的阻擋，另一邊說「通過」也解不掉。\n'
        // ⚠️ 處方以**身分**為單位，不可寫死「兩個」（Codex #456 r4 Medium①）：第三個別名、
        //    重述產生的身分、中途換掉的審查角色都算，而「現況：」那行就是完整名單。
        + '    ↳ 若真的是同一次審查：**現況列出的每一個身分**各自對目前 head 補一則合規結論，'
        + '**輪次要大於「那個身分自己」現有的最高輪次**'
        + '（照原輪次補發撤銷不掉——同輪相反結論＝照樣阻擋、同輪同結論＝不取代舊 sha）。\n'
        + '    ⚠️ **這些身分在這支 PR 裡會一直存在**（留言歷史刪不掉）：之後 head 每動一次，'
        + '**全部都要再跟一次**；「只用固定的那一個字串」是**下一支 PR** 才開始'
        + '（標準字串表與補救程序＝REVIEW-AND-MERGE.md「發審查提示」節）。\n'
        + '    ⛔ **不要用編輯舊留言的方式修**——改審查紀錄會洗掉稽核軌跡。');
    }
  }
  // 重述行引用的第一行若對不上任何壞留言＝空轉，要出聲（不然打錯引文會以為清掉了）。
  for (const r of restated) {
    if (!malformed.some((m) => m.key === r.key)) {
      warnings.push(`${r.who} 的一行重述引用的第一行**對不上任何壞標頭留言**（引文要逐字）：「${r.key.slice(0, 60)}…」`);
    }
  }
  // ⚠️ **沒有任何針對目前 head 的正式結論＝不可合併**（Codex #385 r1 High②）。
  //    我原本讓它放行，理由是「沒有人下結論不等於有人說不行」——**那是退步**：
  //    `main` 原本的合併步驟 2 就要求「確認審查結論」，而協作欄位閘只證明
  //    **有人被寫成審查者**，證明不了**審查真的發生過**。
  // ⚠️ **放行的那則「通過」必須來自 PR 指定的獨立審查者**（Codex #385 r3 High①）。
  //    原本只要求「有人說通過」——於是：實作者 Claude／獨立審查者 Codex，
  //    而留言是 **Claude 自己的「通過」**，兩道閘都零問題 ⇒ **實作者自己放行了自己的 PR**。
  //    那是唯一不變量的正面違反，而這支腳本的存在理由就是守它。
  //    阻擋仍然取**所有人**的聯集（誰都可以喊停），但**放行**只認指定的那一位。
  const passers = Object.values(latest).filter((h) => !h.blocking && head.startsWith(h.sha));
  const passedByReviewer = reviewerRole
    ? passers.some((h) => h.role === reviewerRole)
    : passers.length > 0;
  if (!passedByReviewer) {
    problems.push(passers.length && reviewerRole
      ? `對目前 head 說「通過」的是 ${passers.map((h) => h.who).join('、')}，`
        + `但 PR 說明指定的獨立審查者是「${reviewerRole}」。\n`
        + '    ⚠️ **放行只認指定的那一位**——否則實作者自己說一句「通過」就放行了自己的 PR。\n'
        + '    （阻擋不受此限：任何人都可以喊停，一律進聯集。）'
      : `沒有${reviewerRole ? `「${reviewerRole}」` : '任何一位審查者'}對目前的 head（${head.slice(0, 7)}）`
        + '下過「通過」的正式結論。\n'
        + '    ⚠️ 協作欄位閘只證明「有人被寫成審查者」，證明不了「審查真的發生過」。\n'
        + '    請獨立審查者用來歷標頭給出結論（格式見 AGENTS.md「一支 PR 上可能有好幾個審查者」節）。');
  }
  for (const h of Object.values(latest)) {
    if (!h.blocking) continue;
    problems.push(`${h.who} 在 r${h.round}（審 ${h.sha}）的結論是「${h.verdict}」，還沒有被同一位審查者撤銷。\n`
      + '    ⚠️ **取聯集，不取最後一則**：別人說「通過」不會解除這一條。'
      + '請那位審查者針對目前的 head 重新給結論。');
  }
  // 有結論的審查者都應該審到目前的 head（否則那個「通過」是對舊版本說的）
  for (const h of Object.values(latest)) {
    if (!h.blocking && !head.startsWith(h.sha)) {
      problems.push(`${h.who} 的「${h.verdict}」是對 ${h.sha} 說的，但目前 head 是 ${head.slice(0, 7)}——`
        + '分支被推過之後，那個結論不再適用。');
    }
  }
  return { problems, warnings, reviewers: latest };
}

/** @param {string} pr */
function fetchPr(pr) {
  // ⚠️ **`env: gitEnv()` 不可省**（AGENTS.md 鐵則 11；#463 r1 High）：`gh` 會**自己再去 spawn git**
  //    ——實測 `env GIT_DIR=<不存在的路徑> gh pr view <N>` 回 `failed to run git: fatal: not a git repository`。
  //    繼承來的 GIT_DIR 指到另一個**有效** repo 時，這道閘會去讀**那個** repo 的 PR 與留言，
  //    而輸出看起來完全正常。行為題＝test/cross-pr-merge.test.js「四支會叫 gh 的閘」。
  const out = execFileSync('gh', ['pr', 'view', pr, '--json', 'comments,headRefOid,body'], { encoding: 'utf8', env: gitEnv() });
  const p = JSON.parse(out);
  if (!Array.isArray(p?.comments)) throw new Error('gh 回傳的形狀不對（comments）');
  if (typeof p.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(p.headRefOid)) {
    throw new Error('gh 沒有回傳合法的 headRefOid');
  }
  if (typeof p.body !== 'string') throw new Error('gh 回傳的形狀不對（body）');
  return { comments: p.comments, head: p.headRefOid, body: p.body };
}

/** @param {string[]} argv */
export function main(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('用法：node scripts/check-review-verdicts.js <PR 編號>');
    return 2;
  }
  let data;
  try { data = fetchPr(pr); }
  catch (e) {
    console.error(`複審聯集閘 PR #${pr}：查不清楚（${/** @type {any} */ (e)?.message}）——一律當成未通過。`);
    return 2;   // fail-closed
  }
  // PR 說明指定的獨立審查者——讀不出來就是 null，那時退回「任何一位都算」並在訊息裡說明
  //（協作欄位閘會另外擋「欄位不齊」，這裡不重複擋，但也不假裝知道）。
  const reviewerRole = canonicalRole(fieldValue(data.body, '獨立審查者'));
  const { problems, warnings, reviewers } = verdictProblems(data.comments, data.head, reviewerRole);
  const who = Object.values(reviewers).map((r) => `${r.who}=${r.verdict}`).join('、') || '（沒有任何帶標頭的結論）';
  // ⚠️ 警告**不影響退出碼**：它只是提醒「這則沒被採計」，不是判準（見 looksLikeVerdict 的說明）。
  if (warnings.length) {
    console.error(`複審聯集閘 PR #${pr}：${warnings.length} 則提醒（**不影響本閘結果**）\n`
      + warnings.map((w) => `  ・${w}`).join('\n') + '\n');
  }
  if (problems.length === 0) {
    console.log(`複審聯集閘 PR #${pr}：沒有未回應的阻擋結論。現況：${who}`);
    return 0;
  }
  console.error(`複審聯集閘 PR #${pr}：**未通過**\n` + problems.map((p) => `  ・${p}`).join('\n')
    + `\n\n現況：${who}`);
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
