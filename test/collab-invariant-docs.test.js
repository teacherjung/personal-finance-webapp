// 協作不變量的**落地**考題（2026-08-02 文件體檢）。
//
// ## 這個檔案在防什麼
//
// ⚠️ **2026-09-09 起本檔多了一個宗旨：合併閘的盤點**（William 裁示第 10 題選 a 時搬進來的）。
//    「幽靈閘兜底」那一題原本寄居在協作規矩路由表的考題檔裡，但它守的是**「自報是閘的東西，
//    有沒有被寫進合併步驟的標準指令行」**（⚠️ 不是「有人執行過」，也不是「執行了會擋」）、
//    跟路由無關。**它不是寄居在這裡，它就住這裡**——它補的正是本檔盤點題的窄射程。
//    要刪它之前，請先讀題名關鍵字「幽靈閘兜底」那一題上方的互補說明。
//
// 「沒有任何一份產出，由寫它的人做正式複審與放行」是三方協作的唯一不變量。
// 但它原本**只寫在 `REVIEW-AND-MERGE.md`**，而 `CLAUDE.md` 給 Claude 的指示是「先讀 AGENTS.md」——
// **規則在一份檔案、執行在另一份檔案 ⇒ 規則等於不存在**。
//
// 這個病 `test/merge-procedure-docs.test.js` 的檔頭已經診斷過一次（刪分支規則失效十九天、
// 兩次事故）。本檔就是不讓它換一條規則重演：**規則要在讀者會讀的那份檔案裡，而且要有考題釘著。**
//
// 另一半是「寫下來 ≠ 會被遵守」：40 支已合併 PR 的 `mergedBy` 全部是同一個帳號、
// GitHub reviews 全部 0 筆，唯一還看得見分工的地方是 PR 說明的欄位——而它靠記憶維持，
// 2026-08-02 實測已經斷了（#374／#375／#376 連續三支漏填）。所以另加一道機械閘
// （`scripts/check-pr-collab-fields.js`），本檔也把那支腳本的判斷釘住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingAt } from './helpers/markdown-heading.js';
import { ruleItemRange } from './helpers/agents-rule-item.js';
import ts from 'typescript';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { problemsOf, fieldValue, canonicalRole, REQUIRED_FIELDS }
  from '../scripts/check-pr-collab-fields.js';
import { gatesRunInMergeSteps, scriptFiles } from './helpers/merge-gates.js';
import { visible } from './helpers/markdown-visible.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

const INVARIANT = '沒有任何一份產出，由寫它的人做「正式複審與放行」。';

test('不變量必須寫在 AGENTS.md 裡（只寫在 REVIEW-AND-MERGE.md ＝ 只讀 AGENTS 的人看不到）', () => {
  const agents = read('AGENTS.md');
  assert.ok(agents.includes(INVARIANT),
    'AGENTS.md 找不到唯一不變量的原句。\n'
    + '它若只留在 REVIEW-AND-MERGE.md，一個照 CLAUDE.md 指示「先讀 AGENTS.md」的 Claude 完全不會知道'
    + '自己審自己的提案是違規的——這正是 merge-procedure-docs.test.js 診斷過的同一種病。');
  assert.ok(agents.includes('作者自查仍然必須做'),
    'AGENTS.md 少了「這不是禁止自審」的但書——沒有它，這條不變量會跟「轉 ready 前對抗式自審」互相否定');
});

test('五步驟循環的第⑤步不可以寫死「Codex」（模式③下會變成 Codex 審自己）', () => {
  const agents = read('AGENTS.md');
  assert.ok(/⑤ 審實作 \| \*\*實作者以外的那一方\*\*/.test(agents),
    'AGENTS.md 的第⑤步不是「實作者以外的那一方」。寫死 Codex 的話，'
    + 'William 指派 Codex 實作時（模式③）就變成 Codex 複審自己的產出＝違反唯一不變量');
});

// ⚠️ **這一題的做法 2026-09-10 換成「逐字釘住整塊」（William 裁「1. 乙」，落點＝#596 那則 ⚖️）**。
//    之前四輪各換一種做法守「那句話還在那張表的那一格裡」：找關鍵字（r1）→ 切豎線取欄（r1）→ 綁表＋整條逐字比對（r2）
//    → 自己讀 GFM 表格文法（r3／r4）。第四輪被「表頭前四個空白」「分隔列裡一個不換行空白」打穿：GitHub 渲染成**零張表**，
//    考題照樣全綠。**根因＝我在手寫一個 Markdown 解析器**——那條路 2026-08-03 走過（`test/contract-split.test.js:74-84`，
//    連五輪、其中一輪的洞就是「`trim()` 連 NBSP 都吃掉」），當時的結論逐字是「要嘛寫一個真正的 parser，要嘛不要走」。
//    ⇒ 換一個容易回答的問題：**不問「它會怎麼呈現」，問「有沒有人動過這幾行」**。跟本檔「審查回饋處置」那一節同一套做法。
// ⚠️ **射程逐條寫死（每一種都實跑過突變）**：
//    **擋得住**＝手伸進被釘的那幾行的任何改法（逐行等值，不做正規化）：整句被刪／少一個動詞／語意改寫／外層再否定／
//      整句進註解（⚠️ 被**逐行等值**擋住，不是被下面陣列上那道 doesNotMatch——Grok #596 掃後改口）／禁令搬到別欄／
//      表頭欄數或欄序改動／分隔列被刪或寫壞／**表頭前加空白、分隔列放 NBSP**（r4 那兩招）／資料列前插空行／
//      那一列被搬走／**在表格正下方接一列**（CI 列與尾端空行都釘在裡面，所以會紅；⚠️ **尾端空行之後**再接就是下面②）／擁有標題被改／
//      用標題換爸爸（⚠️ **只認 ATX**——Setext 與 raw HTML `<hN>` 擋不到，理由在 `test/helpers/markdown-heading.js` 檔頭）。
//    **擋不住**（實測全綠，照實列）：①**在這 11 行之外**把整張表用 HTML 註解包起來——這一種由全卷另一道接
//      （`test/contract-split.test.js` 禁止 AGENTS 出現 HTML 註解）②**在尾端空行之後另建一張影子表**或另起一段
//      否定句（兄弟段落，不經過標題也不在這 11 行裡）③在旁邊用白話宣告「以上作廢」——由「⭐ 作廢字眼絆線」接，
//      但它只認字面那兩個字。⚠️ **三種裡只有③連真正的解析器也擋不住**；①②用真正的解析器分得出來（Codex #596 r5 Low 收窄：
//      上一版寫「三種都擋不住」，說過頭）。**Grok #596 掃後再補一類**（不碰被釘的行、也不在旁邊加東西）：
//      ④**跨檔覆寫效力**——畫面上那句仍在，但合併手冊或 CLAUDE.md 叫按鍵的人做相反的事，本題不讀那兩份。
//      ⚠️ Grok 另提的「行中開啟、遠處才關的 raw HTML 容器」**沒有證成**（Codex #596 r6 實測：`<span>`／`<div>` 從角色表前
//        開到例外之後才關，GitHub 照樣渲染出兩張正常的表、禁令仍在原格；`hidden`／`display:none` 也被 GitHub 清掉）——
//        **綠燈本身不等於繞得過去**，所以不列進「擋不住」。**真正在看這四種的是複審的眼睛。**
//    ⚠️ **這是文字守門、不是語意守門**，也**不是身分守門**：兩道機械閘驗得到「PR 自報的角色不同」與「自報為指定
//      審查者的那一位對目前 head 有通過」，驗不了身分、也沒有東西在看實際按合併鍵的是誰（#596 r2 用假 gh 實測）。
// ⚠️ **代價量過**：角色表這一塊 48 天內改過 12 次＝**平均**每四天要回來同步一次陣列（⚠️ 是平均不是節奏——先例那 9 次擠在四天內，
//    是爆發；而且成本落在被釘的**每一列**，不只那半句。Grok #596 掃後收窄）；既有那個釘 32 行的先例四天內被迫同步 9 次、
//    143 顆 commit 從沒紅過（沒假紅、也沒抓到過東西——它的產出是「動一個字不可能靜靜發生」，本題同理）。
const ROLE_TABLE = [
    '**角色分工（含「不負責」邊界）**：',
    '',
    '| 角色 | 主要責任 | 不負責 |',
    '|---|---|---|',
    '| William | 產品決定、需求優先序、畫面驗收、合併裁決；**審查回饋的例外**（清單刻意不複述在這裡——見「審查回饋處置」） | 不需判斷程式實作細節；**一般的審查回饋修不修不必問他**（2026-08-14 起由**在磨的那一方（＝這一支的實作者）**判斷；⚠️ 2026-09-10 對稱化前這裡寫死 Claude） |',
    '| Claude | **被 William 明確指派時實作**（⚠️ 他**習慣**指派 Claude，但「習慣」不是「預設授權」——**空檔≠自動啟動**，與 Codex 那一列同一條；2026-09-10 補，此前這一格只寫「主要實作」、沒有任何指派的限定詞，是全專案最鬆的一份）、考題、PR、自審、技術文件更新；**複審 Codex 實作的 PR 並代執行合併**（2026-07-30 對稱常設授權）；**判斷審查回饋修不修——⚠️ 只在他自己是這一支的實作者時**（2026-08-14 立、2026-09-10 改成「在磨的那一方」；Codex 實作的支換成 Codex 判斷；例外見「審查回饋處置」） | 不自行推翻已拍板的產品規則；**不複審、不放行自己實作的支**；**「審查回饋處置」列的例外一律不自行拍板**——那些即使是 Codex 提的也要問 William（清單刻意不複述在這裡：漏抄一條就等於多給自己一塊權限；問了他沒回怎麼辦＝該節「問法與逾時預設」那顆——**等他**；⚠️ 2026-09-10 之前這裡寫「那是暫定、不是拍板」，時限拿掉之後**沒有「暫定」這條路**了，Codex #595 r2 Medium 抓到） |',
    '| Codex | 獨立複審、對抗測試、同步點檢查、風險分析；**被 William 明確指派時實作**（模式③；⚠️ 兩邊的實作都要他指派，他習慣指派 Claude） | **三模式邊界（見下）以外的一切**——尤其不得把審查／代合併權限自行膨脹成實作權限；**不複審、不放行自己實作的支** |',
    '| Grok | 教學線「外部記者」三職：腳本查核／每集開工時的選題雷達／就地解釋文案的零基礎讀者測試；程式線＝**複審後掃（常設；2026-08-16 畢業、2026-08-18 由「預審」改序為複審通過後才掃）**＋**唯讀顧問（個案）**（完整邊界＝「Grok 的邊界」節） | 一切實作、正式複審與合併執行；**沙箱條款落地前不進任何 repo 樹**（主目錄／實作樹／審查樹——一律材料制，見該節）；X 輿情不得用於投資決策線 |',
    '| 工讀生×2（教學線，人類；2026-08-17 入列） | 教學影片的**製作與營運**：詞彙短片量產線（圖卡／配音合成／剪輯／品檢／YouTube 上架／頻道數據）＋EPxx 正片線的剪輯與上架＋生產看板（Notion 財金詞彙庫）維護（完整邊界與治理＝教學影片 repo（`../teaching-videos/`，GitHub `teacherjung/teaching-videos`） 的 `AGENTS.md`「治理」節，此處不重抄——**該線 2026-08-25 已分家獨立，規矩層不在本 repo**） | 一切程式實作、正式複審與合併；**不進 repo、無 GitHub 權限**（**與本 repo 的接點一律經 `docs/learning-hub-contract.md`**——它涵蓋 EPxx 與詞彙短片兩條產線，不只詞彙牆 metadata；2026-08-25 分家後這句原本仍寫舊的窄射程，`Grok 掃 #3` 抓到）；不接觸真實財務資料（`data/store.db`）與券商帳號憑證；語音合成與分身生成有閘（判準全文＝該檔「治理」節，**此處刻意不重抄**——重抄過一次就漂成較鬆的一份，`Codex #487 r2 High②`）；分身素材僅 EPxx |',
    '| CI | 型別、格式、考題的自動守門 | 不判斷產品是否好用、金額口徑是否符合使用者的意思 |',
    '',
];
/** 三模式邊界表（William 2026-09-10 裁「我選乙」的主物）：標題行→表格→表外具名例外→尾端空行。 */
const MODES_TABLE = [
    '**三模式邊界**（⚠️ **不分是哪一方——誰進入這個模式，這一列就管誰**；2026-07-30 定、**2026-09-10 改成角色中立**（William 裁，原話逐字「我選乙」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/595#issuecomment-5618876611 ；⚠️ 改制前這張表只寫 Codex 一邊，而**他現在可以隨時指派任一方實作**——Claude 那側的等價約束是散在各處、要繞兩手才推得到的，其中兩條**在這張表與角色表上沒有寫到 Claude 頭上**（⚠️ Grok #596 複審後掃改口：上一版寫「根本沒有明文」，那是假的——規則本身在別處都有：「要指派」在審查循環表的④實作那一格／一句話總綱／CLAUDE.md；「代合併不修碼」在 `REVIEW-AND-MERGE.md` 三種模式那句。**缺的是第一眼那張權威表上的字，不是規則**）：代合併時不准順手改程式、以及「有空檔不等於自動啟動實作」）；此前角色表寫「**原則上**不修改」＝弱版、審查分工節寫「不改檔、不 commit」＝絕對版，兩種強度並存——而 Codex 手上已有代合併授權，「一邊擴權一邊留著模糊邊界」是這批文件對齊裡最危險的一處。三模式方案由 Codex 自己在重整案第三輪提出）：',
    '',
    '| 模式 | 能做什麼 | 不能做什麼 | 誰啟動 |',
    '|---|---|---|---|',
    '| **①常態審查**（預設＝**對某一支 PR 而言、你不是它的實作者時**；⚠️ Grok #596 掃後補、Codex r6／r7 兩輪收斂：這一格管的是「當你在審那一支」的行為，**不是你的常設座位**。⚠️ **禁的是三件（定義，不是例外清單）**：①改動**受審的產出**（A 的程式、考題、文件——**放在哪一棵樹都一樣**，不可以藉路徑搬家替 A 實作）②把修正**併進 A**③動到**審查樹本身**（那棵樹只讀，見協作流程節）。**也不可以自己切換成實作**。⚠️ **其餘按任務範圍判斷、不受 ① 約束**：在自己的暫存目錄寫重現腳本、突變材料、結果日誌與要貼的審查意見——**那就是這一輪審查**；另一件已獲 William 指派的實作任務（在自己的實作樹裡做、跟 A 無關）；`CLAUDE.md` 那條「發現 Codex 未 commit 的改動先審查再 commit」的交接。⚠️ 記憶檔按**內容、用途與既有授權**判斷，不因為「不在 repo」就一概允許、也不因為「不在上面那幾種」就一概禁止。〔2026-09-11 之前這裡寫「不受 ① 約束的**只有兩種**」——那是封閉的例外清單，把審查自己要寫的暫存材料也關在外面（Codex #596 r7 Medium）；本專案記過「列舉補不完就關門」，正解是**定義禁什麼**，不是數有幾種例外〕） | 讀、跑三關、提意見（附重現與 `檔案:行`） | **絕對唯讀：不改檔、不 commit、不 push**；在該 PR 的拋棄式審查樹工作、不 checkout 任何分支 | 常設（**PR 進行中每一輪＋每批合併後**）或 William 隨時 |',
    '| **②代合併** | 照 `REVIEW-AND-MERGE.md` 的**合併步驟**（步數以那份為準）執行「**對方實作、自己審過**」的合併（授權範圍就這麼窄——**第三者實作的支不在內**；**對方＝Claude／Codex 這兩位 AI 中的另一位**（**先鎖人、再套職務**：你審＝它實作、你實作＝它審），**第三者＝這兩位以外的任何人**，含 William、Grok、工讀生、將來入列的第四位——所以 William 自己實作的支，**兩邊都不代合併**。Grok #596 掃後補定義、Codex r6 修正：上一版用「這一支上與你相對的那一位」定義對方，會讓 William 實作的支同時算對方又算第三者，自相矛盾） | **不含修碼**——發現問題**回報這一支的實作者**修，不得順手改；不合自己實作的支（見「實作者不按自己的合併鍵」） | 常設授權（Codex 2026-07-27；Claude 2026-07-30 對稱授權） |',
    '| **③實作** | 在**自己那棵常設實作樹**走分支與 PR（Claude＝`-claude`、Codex＝`-codex`；三條件：獨立施工計畫（**只限被指派做獨立功能時**——中低風險 PR 免施工計畫那條不受影響，正本＝`REVIEW-AND-MERGE.md`「實作模式」節；Grok #596 掃後補）／不碰他人預約檔案〔讓道例外＝「重疊 PR 讓道」段〕／**審查與實作不可以是同一方**） | 不得在審查樹 commit；高風險 PR **未經對方複審**不得合併 | **僅 William 明確指派**——空檔≠自動啟動（⚠️ **兩邊都一樣**：他習慣指派 Claude，但「習慣」不是「預設授權」） |',
    '',
    '⚠️ **表外的具名例外（這兩件不隨實作者對調；規則用角色寫，人名只出現在現況句）**：**不論誰實作，「發射 Grok 複審後掃」由**掃描發射者**（＝起得了掃描器的那一方；跟發射審查的那個「發射者」是**兩個角色、別混**）做；「把草稿 `gh pr ready` 轉正式」由掃描發射者做**（William 2026-09-11 裁「甲」＝改成角色寫法、現況照舊，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/601#issuecomment-5632426208；⚠️ 若兩邊都起得了掃描器，這兩句選不出人——那時要補一條平手規則（本專案今天沒有這個情況、刻意不預寫）；**本專案的現況寫在這一塊下面那一行、刻意不釘**——改那一行不必動本行的釘本；⚠️ 其他文件與 PR 範本裡的現況句（程序那份、開工檔）**沒有從那一行取值**，換現況時要自己逐處同步核對）。⚠️ **兩件的理由不同等級**（Grok #596 掃後拆開）：**掃**＝技術限制（本檔「Grok 的邊界」那三件扣起來：外層沙箱、第二層套不上、金絲雀 fail-closed——方向無關誰實作）；**轉正式**＝跟著掃描發射者走（William 2026-09-10 裁，原話逐字「維持你轉。」，落點＝#592；「為了少一次交接」是 Claude 在 #592 寫的操作化理由、不是他的話；**不是**掃描器起不來；2026-09-11 裁「甲」改成角色寫法時這一點照舊）。⚠️ **這兩件都不是改檔／commit／push**，所以**坐在 ① 審查時做這兩件不違反 ①**。⚠️ `REVIEW-AND-MERGE.md`「實作模式」第三層 2026-09-11 起也是角色寫法、與這裡同寬（改之前只寫「即使 Codex 實作」那個方向）；掃描發射者自己實作時由它轉正式是既有預設。那一節自己也寫著「**不可以整節把人名對調**」。⚠️ **這一行與上表 2026-09-11 起都被逐字釘住**（`test/collab-invariant-docs.test.js` 的 `MODES_TABLE`；改一個字就紅）。⚠️ **逐字釘只保證文字沒被動，不保證這兩件在實務上被遵守**——沒有任何機器在看「是誰發射掃描、是誰轉正式」，也沒有機器在判「誰起得了掃描器」（那要用本檔「Grok 的邊界」那種實測證明、不是自報），那一半靠角色紀律。',
    '',
];
/** 三方協作框架那個 H3 底下的直屬內文共用同一條祖先鏈（「審查回饋處置」那一節也是）。 */
const ANCESTOR_CHAIN = [
  '# AGENTS.md — 給所有 AI 協作者（Codex / Claude / 其他）的專案規則書',
  '## 協作流程',
  '### 三方協作框架（William 2026-07-24 裁決定稿；Codex 起草＋Claude 三處修訂＝流程分級適用／預約表內容校正／低風險仍過三關。本節已**整併**同日稍早的裁決補則，為唯一版本）',
];
/** 逐字釘一整塊＋錨點唯一＋祖先標題鏈。回傳區塊起點行號（給後面的斷言用）。 */
function pinBlock(/** @type {string[]} */ lines, /** @type {string[]} */ block, /** @type {string} */ name) {
  const first = lines.findIndex((l) => l === block[0]);
  assert.ok(first >= 0, `找不到逐字相同的「${name}」第一行：\n  ${block[0].slice(0, 60)}…`);
  assert.equal(lines.filter((l) => l === block[0]).length, 1, `「${name}」的第一行出現不只一次`);
  block.forEach((canon, k) => {
    assert.equal(lines[first + k], canon,
      `「${name}」的第 ${k + 1} 行對不上（多一行、少一行、或改了字）：\n  預期：${canon.slice(0, 60)}…\n  實得：${String(lines[first + k]).slice(0, 60)}…\n`
      + '⚠️ 這一塊任何位置插字、加一列、改表頭、前面加空白，都會讓這題紅——要改條文，先來改這裡（變更必經考題）。');
  });
  const at = ANCESTOR_CHAIN.map((canon, k) => {
    const hits = lines.reduce((/** @type {number[]} */ acc, l, i) => (l === canon ? [...acc, i] : acc), []);
    assert.equal(hits.length, 1, `祖先標題鏈第 ${k + 1} 層在檔案裡出現 ${hits.length} 次（要剛好 1 次，逐字）：\n  ${canon.slice(0, 60)}…`);
    return hits[0];
  });
  assert.equal(at[0], lines.findIndex((_, i) => headingAt(lines, i) > 0), '檔頭那個 H1 不是全檔第一個標題');
  at.forEach((idx, k) => {
    const last = k + 1 === at.length;
    const next = last ? first : at[k + 1];
    assert.ok(idx < next, `祖先標題鏈第 ${k + 1} 層跑到下一層後面去了＝「${name}」已經不屬於它`);
    const forbidUpTo = last ? 6 : k + 1;
    for (let i = idx + 1; i < next; i += 1) {
      const level = headingAt(lines, i);
      assert.ok(level === 0 || level > forbidUpTo,
        `第 ${i + 1} 行插了一個 H${level} 標題（「${lines[i].slice(0, 40)}」），它會把「${name}」切到別的小節去`);
    }
  });
  const text = block.join('\n');
  assert.doesNotMatch(text, /<!--|-->/, `「${name}」裡出現 HTML 註解——規則不可以被藏成不可見內容`);
  assert.doesNotMatch(text, /^ *\[[^\]]+\]:\s/mu, `「${name}」裡出現 Markdown 參考定義——那在畫面上不顯示`);
  return first;
}

test('角色表與三模式表：各整塊逐字釘住，兩邊的「不放行自己實作的支」都在陣列裡', () => {
  const lines = read('AGENTS.md').split('\n');
  pinBlock(lines, ROLE_TABLE, '角色分工表');
  // ⚠️ **三模式表也釘**（Grok #596 掃後：這支的主物是三模式表與表外例外，上一版卻只釘了幾乎沒改的角色表——
  //    對調例外裡的人名、放寬②，考題整段安靜）。同一套三層，範圍＝標題行→表格→表外具名例外→尾端空行。
  //    代價同上：那一塊也會變，變了就回來同步。
  pinBlock(lines, MODES_TABLE, '三模式邊界表');
  // ⚠️ 下面兩條看的是**陣列本身**：逐字釘住之後，能靜靜改壞那句話的人只剩「來同步陣列的那個人」。
  //    這兩條讓「同步時順手把那半句拿掉」也會紅——它們守的是陣列，不是文件（文件由上面那道守）。
  const rowOf = (/** @type {string} */ who) => ROLE_TABLE.find((l) => l.startsWith(`| ${who} |`)) || '';
  assert.ok(/複審\s*Codex\s*實作/.test(rowOf('Claude')),
    '角色表的 Claude 那一列沒有「複審 Codex 實作」——這張表是新人第一眼看的權威表，照舊表理解會不知道 Codex 開的 PR 該誰審');
  const CLAUSE = '**不複審、不放行自己實作的支**';
  for (const who of ['Claude', 'Codex']) {
    assert.ok(rowOf(who).includes(`；${CLAUSE}`),
      `角色表 ${who} 那一列裡找不到「；${CLAUSE}」——那是唯一不變量在權威表上的落點，同步陣列時不可以順手拿掉`);
  }
});

test('兩份規則書要互相指得到（指標死掉＝又變成兩份各說各話）', () => {
  const agents = read('AGENTS.md');
  const codexReview = read('REVIEW-AND-MERGE.md');
  assert.ok(agents.includes('REVIEW-AND-MERGE.md'), 'AGENTS.md 沒有指向 REVIEW-AND-MERGE.md（展開版與操作細節在那裡）');
  assert.ok(codexReview.includes('AGENTS.md'), 'REVIEW-AND-MERGE.md 沒有指回 AGENTS.md');
});

test('2026-07-10 那節過期的「審查分工」不可以再出現（它擺在最像結論的位置）', () => {
  const agents = read('AGENTS.md');
  for (const stale of ['使用者＝守門者', '把 Codex 的審查**原文**交給 Claude']) {
    assert.ok(!agents.includes(stale),
      `AGENTS.md 仍有已過期的舊分工敘述「${stale}」。\n`
      + '2026-07-27 起 Claude 自己跑 codex CLI（#294），沒有「使用者轉交審查原文」這一步了。'
      + '舊規則用完整、絕對的語氣寫在最後一節＝讀起來像總結，讀者沒有理由懷疑。');
  }
});

// ── PR 協作欄位的機械閘 ──────────────────────────────────────

test('⭐ PR 模板的協作欄位區段＝REQUIRED_FIELDS 逐行逐字（多一行少一行、順序不同都紅）', () => {
  // ⚠️ **不要再手寫第二份欄位行的解析器**（#583 r1→r2→r3 連三輪：先是只認一種寫法而漏算，
  //    放寬之後換成欄名含 `_` 又漏算，再放寬就連「請注意：…」這種說明也被當成欄位＝假紅）。
  //    「哪一行是欄位、哪一行是說明」本來就不是用一條正規式判得準的。改成**逐行逐字比對**：
  //    那一段**只准**有 REQUIRED_FIELDS 那幾行、順序也要一樣。模板本來就是這樣長的
  //    （所有填寫說明都住在 HTML 註解裡），所以這不是新規定，是把現況釘住。
  // ⚠️ 誠實劃界：這守的是「repo 裡的模板」。它管不到「某個人在自己的 PR 說明裡多寫幾行」——
  //    那由閘自己判（多的行它不讀），本題不宣稱擋得住。
  const tpl = read('.github/pull_request_template.md').replace(/<!--[\s\S]*?-->/g, '');
  const lines = tpl.split('\n');
  // ⚠️ **「這一行是不是標題」一律用 `headingAt()`，不要自己再寫一條正規式**（#583 r5 Low：
  //    自寫的那條要求井號在第 0 欄，於是下一節的標題只要縮排一格就不算標題、被當成本節的內容）。
  //    那支 helper 是 #578 為同一件事抽出來的單一真相（ATX 可有 0〜3 格前導空白）。
  const at = lines.findIndex((l, i) => headingAt(lines, i) === 2 && /協作欄位\s*$/u.test(l));
  assert.ok(at >= 0, 'PR 模板裡找不到可見的「## 協作欄位」標題——模板改寫法了，這一題要跟著改');
  // ⚠️ **章節的結尾是「同級或更高級」的標題，不是任何標題**（#583 r4）：上一版遇到任何 `#` 就停，
  //    於是在那一段裡開一個 `### 子標題` 再往下放欄位，子節整段被切掉、根本沒進比對。
  const level = headingAt(lines, at);
  const next = lines.findIndex((l, i) => {
    const lv = headingAt(lines, i);
    return i > at && lv > 0 && lv <= level;
  });
  const body = lines.slice(at + 1, next < 0 ? undefined : next).filter((l) => l.trim() !== '');
  assert.deepEqual(body, REQUIRED_FIELDS.map((f) => `- **${f}**：`),
    '模板的「協作欄位」區段跟 REQUIRED_FIELDS 對不上（多一行、少一行、順序不同、寫法不同都會紅）。\n'
    + '  ⚠️ 要在那一段寫說明，請寫進 HTML 註解裡——模板的填寫說明本來就都在註解裡，'
    + '可見區只放欄位行；註解會先被剝掉，不影響這一題。');
});

test('⭐ 欄位定位｜八種常見寫法都讀得到同一個值（合法裝飾不可誤擋、註解裡的同名字串不算）', () => {
  // ⚠️ 這一族原本只住在一支 2026-09-08 被刪掉的考題檔裡（那支專驗一個已經拿掉的欄位）。
  //    搬過來換成「實作者」再釘一次：`fieldValue()` 的三個分支（項目符號／粗體包住／有序清單）
  //    是**實作者與獨立審查者兩欄共用的**，沒有它，那兩欄從此會被靜靜誤擋而沒人發現。
  for (const [body, want, why] of /** @type {[string, string, string][]} */ ([
    ['- **實作者**：Claude', 'Claude', '模板的標準寫法'],
    ['* __實作者__: Claude', 'Claude', '另一種項目符號＋底線粗體＋半形冒號'],
    ['1. **實作者**：`Claude`', '`Claude`', '有序清單（反引號原樣留著，值由呼叫端自己正規化）'],
    ['2) 實作者：Claude', 'Claude', '有序清單的另一種括號、欄名不加粗'],
    ['實作者：**Claude**', 'Claude', '行首直接寫欄名（值外層的粗體記號會被剝掉，反引號不會——照實釘住現行行為）'],
    ['  - **實作者** ：  Claude  ', 'Claude', '前後空白與全形冒號前的空白都要吃掉'],
    ['<!--\n- **實作者**：例如 Claude 或 Codex\n-->\n- **實作者**：Codex', 'Codex', 'HTML 註解裡的同名字串不算（模板原封不動送出去要能被擋）'],
    ['- **實作者**：', '', '欄位留空＝空字串（⚠️ 這一格只有一行，抓不到「冒號後改吃換行」那種突變——那由空模板那一題守）'],
  ])) {
    assert.equal(fieldValue(body, '實作者'), want, `${why}\n說明：\n${body}`);
  }
});

test('欄位閘｜必填欄位齊全且實作者 ≠ 審查者 → 通過', () => {
  const body = [
    '## 協作欄位', '',
    '- **實作者**：Claude',
    '- **獨立審查者**：Codex',
    '- **預計修改的共享檔案**：AGENTS.md',
    '- **這支若完全失敗，最糟失去什麼**：文件回到今天早上的樣子',
  ].join('\n');
  assert.deepEqual(problemsOf(body), []);
});

test('欄位閘｜**模板原封不動送出去必須不通過**（填寫說明都在 HTML 註解裡）', () => {
  // ⚠️ 這題是這道閘的核心：不剝註解的話，空模板也會「找得到欄位名」而放行＝閘等於沒有。
  //    同型的病：#353 r1 的考題只掃文件關鍵字，被「把指令搬進 HTML 註解」直接繞過（3/3 綠）。
  const tpl = read('.github/pull_request_template.md');
  const problems = problemsOf(tpl);
  assert.ok(problems.length >= REQUIRED_FIELDS.length,
    `空模板應該被判每一欄皆缺，實得 ${problems.length} 條：${problems.join('；')}`);
});

test('欄位閘｜實作者與審查者是同一個人 → 不通過（這是它存在的全部理由）', () => {
  const body = [
    '- **實作者**：Codex',
    '- **獨立審查者**：Codex',
    '- **預計修改的共享檔案**：無',
    '- **這支若完全失敗，最糟失去什麼**：無',
  ].join('\n');
  const problems = problemsOf(body);
  assert.ok(problems.some((p) => p.includes('沒有任何一份產出可以由寫它的人放行')),
    `實作者自審沒有被擋下，實得：${problems.join('；') || '（零條）'}`);
});

test('欄位閘｜缺任何一欄都要被點名（不是只看有沒有欄位名）', () => {
  const body = ['- **實作者**：Claude', '- **獨立審查者**：Codex'].join('\n');
  const problems = problemsOf(body);
  for (const f of ['預計修改的共享檔案', '這支若完全失敗，最糟失去什麼']) {
    assert.ok(problems.some((p) => p.includes(f)), `沒有點名缺少的「${f}」`);
  }
});

test('欄位閘｜角色寫成看不懂的字串要被點名（避免「已填」但填了廢話）', () => {
  const body = [
    '- **實作者**：某人',
    '- **獨立審查者**：Codex',
    '- **預計修改的共享檔案**：無',
    '- **這支若完全失敗，最糟失去什麼**：無',
  ].join('\n');
  assert.ok(problemsOf(body).some((p) => p.includes('看不出是')), '角色填成「某人」沒有被點名');
});

test('欄位抽取｜HTML 註解裡的同名字串不算數', () => {
  const body = '<!-- - **實作者**：Codex -->\n- **實作者**：Claude';
  assert.equal(fieldValue(body, '實作者'), 'Claude',
    '註解沒有被剝掉——註解裡的值會蓋過真正填的值');
});

// ── 角色解析不可 fail-open（Codex #379 r1 High①）─────────────────

/** @param {string} impl @param {string} rev */
const bodyWith = (impl, rev) => [
  `- **實作者**：${impl}`,
  `- **獨立審查者**：${rev}`,
  '- **預計修改的共享檔案**：無',
  '- **這支若完全失敗，最糟失去什麼**：無',
].join('\n');

test('欄位閘｜**加註文字不可以讓同一人變成兩個人**（第一版就是這樣被繞過的）', () => {
  // ⚠️ 第一版用原字串比對是否同一人，於是「Claude」與「Claude（已看過）」被當成不同人 → 通過。
  //    這道閘最核心的那一條（沒有人可以放行自己的產出）當場失效。
  for (const decorated of ['Claude（已看過）', 'Claude (reviewed)', '`Claude`', '**Claude**', ' Claude ']) {
    const problems = problemsOf(bodyWith('Claude', decorated));
    assert.ok(problems.some((x) => x.includes('沒有任何一份產出可以由寫它的人放行')),
      `「Claude」對上「${decorated}」沒有被判成同一人——加註／格式就能繞過自審檢查。實得：${problems.join('；') || '（零條）'}`);
  }
});

test('欄位閘｜含有角色名 ≠ 就是那個角色（NotClaude／多人並列都要擋）', () => {
  for (const bogus of ['NotClaude', 'Claude and Codex', 'Claude/Codex', '不是 Claude', 'Claudia']) {
    const problems = problemsOf(bodyWith(bogus, 'Codex'));
    assert.ok(problems.some((x) => x.includes('必須剛好是')),
      `「${bogus}」被當成合法角色放行了——用 includes 判斷等於把 fail-open 寫進閘裡。實得：${problems.join('；') || '（零條）'}`);
  }
});

test('欄位閘｜合法的裝飾寫法不可以誤擋（粗體、反引號、前後空白）', () => {
  for (const [impl, rev] of [['`Claude`', 'Codex'], ['**Claude**', '**Codex**'], [' Claude ', 'Codex ']]) {
    assert.deepEqual(problemsOf(bodyWith(impl, rev)), [],
      `合法寫法「${impl}／${rev}」被誤擋了——噪音型誤擋會讓人繞過這道閘`);
  }
});

test('角色正規化｜看不出來就回 null，不猜', () => {
  assert.equal(canonicalRole('Claude'), 'Claude');
  assert.equal(canonicalRole('**Codex**'), 'Codex');
  assert.equal(canonicalRole('William（產品）'), 'William');
  for (const bad of ['', '某人', 'NotClaude', 'Claude and Codex', 'AI']) {
    assert.equal(canonicalRole(bad), null, `「${bad}」不該被猜成某個角色`);
  }
});

// ── 本檔不可以重述合併步驟（重述的摘要會落後）─────────────────

/**
 * **自報是合併閘的腳本**：`scripts/` **第一層**、`check-` 開頭、`.js` 的檔案裡，import 得到
 * `MERGE_GATE` 匯出的那些。這一步只讀**模組匯出**，不讀合併步驟。
 * 「合併步驟裡登記了哪幾支」是**另一步**——`test/helpers/merge-gates.js` 的 `gatesRunInMergeSteps()`
 * 從 `REVIEW-AND-MERGE.md` 的合併步驟區塊反查（登記 ≠ 執行，定義見該檔頭）——題名關鍵字「每一道自報的合併閘」那一題再把兩個集合雙向對帳。
 * （#587 r6 更正：這裡原本寫「合併程序實際用到的機械閘，從合併步驟反查」，來源與能力都寫錯了。）
 *
 * ⚠️ **不要在這裡手寫名單**（Codex #385 r9 抓的）：原本寫死三個名字，
 * 於是 #385 加了第四道閘（`check-review-verdicts.js`）之後，AGENTS.md 兩處
 * 仍叫讀者「只記住三道守門」，而**考題把舊名單當契約，44 題全綠也看不見**。
 * 這正是本節在修的那個病，我在修它的同一支 PR 裡又犯一次。
 * ⇒ 真相只有一個地方：合併步驟本身。它提到幾道，AGENTS 的摘要就要點名幾道。
 */
async function selfDeclaredGates() {
  const files = readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.startsWith('check-') && f.endsWith('.js'));
  const gates = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(ROOT, 'scripts', f)).href);
    if (!mod.MERGE_GATE) continue;
    const g = mod.MERGE_GATE;
    // ⚠️ 形狀要驗（Codex #385 r11）：`MERGE_GATE = true` 原本也能通過，
    //    那等於「自報」這件事本身沒有內容。
    assert.equal(typeof g, 'object', `scripts/${f} 的 MERGE_GATE 不是物件（要 { name, why }）`);
    for (const k of ['name', 'why']) {
      assert.ok(typeof g[k] === 'string' && g[k].trim(),
        `scripts/${f} 的 MERGE_GATE.${k} 要是非空字串——自報沒有內容就不算自報`);
    }
    gates.push({ file: `scripts/${f}`, ...g });
  }
  return gates;
}


// ## ⚠️ 誠實劃界：這份註冊表只管**盤點**，不管閘**有沒有用**
//
// 它保證的是「有幾道閘」這件事在腳本、合併步驟、AGENTS 摘要三邊一致。
// 它**證明不了**某一道閘真的會擋——一支自報、文件同步、但實際永遠 `return 0` 的假閘照樣通過這題。
// 閘的行為要靠各自的端到端考題（`merge-gate.test.js`／`review-verdicts-cli.test.js` 的假 `gh` 出口題）。
// 這一點是 Codex #385 r11 要求寫明的，因為「有註冊表」很容易被誤讀成「閘都有效」。

test('⭐ 每一道自報的合併閘，都必須出現在合併步驟與 AGENTS 的兩處摘要裡（#379 r1／#385 r9・r10・r11）', async () => {
  // ⚠️ **雙向集合相等**（Codex #385 r11）：只驗「自報者 → 步驟」的話，
  //    複製一支真的閘、拿掉 `MERGE_GATE`、把指令加進步驟、文件完全不更新 ⇒ 34/34 全綠。
  //    （原本還有一條 `gates.length >= 3` 的地板：加進第四支之後，
  //      拿掉既有某支的標記照樣過——**會隨著新增而自己失效的下限，不是判準**。）
  const gates = await selfDeclaredGates();
  const declared = gates.map((g) => g.file).sort();
  const run = gatesRunInMergeSteps().sort();
  assert.deepEqual(declared, run,
    '「自報是合併閘的腳本」與「合併步驟裡以標準指令登記的閘」對不起來。\n'
    + `  自報：${declared.join('、') || '（無）'}\n`
    + `  步驟裡登記的：${run.join('、') || '（無）'}\n`
    + '⚠️ 兩個方向都要擋：自報卻沒登記＝「有腳本」會讓人以為守住了；\n'
    + '   登記了卻沒自報＝沒有人數得到它，文件漂了也不會紅。');
  const names = gates.map((g) => g.file.replace('scripts/', ''));
  const agents = read('AGENTS.md');
    // ⚠️ 錨點**不可以含數字**（Codex #385 r12 Medium）：原本寫死「但四道不可跳過的守門」，
  //    於是新增第五道之後，文件仍寫「四道」照樣全綠——**數字本身就是會漂的東西**。
  for (const anchor of ['不論誰執行，一律走', '不可跳過的守門要在這裡點名得出來']) {
    const i = agents.indexOf(anchor);
    assert.ok(i > 0, `AGENTS.md 找不到指標段落：「${anchor}」`);
    const block = agents.slice(i, i + 900);
    for (const must of [...names, 'Reviewed-By', 'Merged-By']) {
      assert.ok(block.includes(must),
        `AGENTS.md 的「${anchor}」段落沒有點名「${must}」。\n`
        + '⚠️ 這一段刻意不重述步驟（重述的摘要會落後，讀者照 AGENTS 執行就剛好跳過新加的關卡——\n'
        + '   那正是這一節在修的病），但**每一道守門的名字必須在**，否則指標等於沒有內容。\n'
        + `   目前自報的閘：${names.join('、')}`);
    }
  }
});

// ⚠️ **題名關鍵字「每一道自報的合併閘」那一題的窄射程留下一條縫，下面這題補它**
//    （2026-09-09 從 `test/collab-map.test.js` 搬來）。
//    `selfDeclaredGates()` 只 import `scripts/` **第一層**、**`check-` 開頭**、**`.js`** 的檔，
//    所以「子目錄裡的」「`.mjs`／`.cjs`」「不叫 check-* 的」自報閘，它**看不到**（不會進 declared）。
//    ⚠️ **但「看不到」不等於「沒人叫」**（#587 r3 實測更正）：那種腳本若**已經用標準指令登記進合併步驟**，
//    它會進 run 那一邊，**雙向集合比較當場就紅**。本題真正補的縫窄得多——
//    **既沒被 import、也沒被標準指令收進來**的那一種：兩邊集合都沒有它，兩邊照樣相等、照樣全綠。
//
// ⚠️ **兜底自己的射程（原本寫在 `collab-map.test.js` 檔頭，跟著題一起搬過來）**：
//    ・它寬到「`scripts/` **遞迴**底下的 `.js`／`.mjs`／`.cjs` 只要**提到** `MERGE_GATE`，
//      就要在合併步驟已登記的那一組裡」。
//    ・**副檔名以外的檔案不掃**——`.ts`、`.sh`、無副檔名的可執行檔**都不在內**。
//    ・**兩題都只認 `MERGE_GATE` 這個名字**：改用別的 export 名開一道閘，**在「沒登記進合併步驟」
//      的前提下**兩邊都看不到；若它已用標準指令登記，盤點那一題會因為 run 有、declared 沒有而紅。
//    ・「已登記的那一組」怎麼認（**登記 ≠ 執行**，定義與反例見同一個檔頭）（只認 bash fence 裡逐字相符的標準指令行、
//      路徑限 `scripts/<名>.js`）＝`test/helpers/merge-gates.js` 的 `gatesRunInMergeSteps()` 檔頭。
//
// ⚠️ **兩題是互補，不是誰涵蓋誰——反向也要講**（Grok #587 掃後點名：只講一邊會誘發錯誤的合併）：
//    ・題名關鍵字「每一道自報的合併閘」那一題做**這一題不做**的事：雙向集合相等、驗匯出的形狀
//      （`{ name, why }` 非空字串）、對帳規則書兩處摘要點名。它讀的是**模組匯出**。
//    ・這一題做**那一題不做**的事：遞迴、寬副檔名、**看原始文字**（`export { x as MERGE_GATE }`、
//      只在註解裡提到，都算）。
//    ⇒ **就算有人把那一題加寬（例如拿 `scriptFiles()` 去餵它），也不准把這一題刪掉**：
//      加寬之後失去的是「原文提到就算」這條寬網，而那正是本題唯一的判準。
//      要刪，請先證明「原文提到但模組匯不出」那一族已經有別的東西接。
// ⚠️ **為什麼搬過來**：它守的是「自稱是閘的東西有沒有登記進合併步驟」，跟協作規矩路由表**一點關係都沒有**，
//    卻寄居在那張表的考題檔裡。William 2026-09-09 裁示保留路由表但把這題搬走，
//    理由是：真正值錢的護欄不該跟一張隨時可能退役的索引表綁在一起。
//    ⚠️ **可證的是**：`scriptFiles()` 的函式本體與原本那條「原文提到就算」的判準**逐字保留**。
//    **不可以說整題逐字未改**（#587 r3）——本題現在多了 fail-closed 地板，失敗訊息也改寫過。

test('⭐ scripts/ 底下每一支提到 MERGE_GATE 的 js/mjs/cjs，都要以標準指令登記在合併步驟裡（幽靈閘兜底）', () => {
  const running = new Set(gatesRunInMergeSteps());
  // ⚠️ **先擋「掃到空集合」**（Grok #587 掃後點名的**搬運新造的洞**）：`scriptFiles()` 用
  //    **helper 自己的位置**往上推倉庫根，本檔的 `read()` 用**本檔的位置**推——現在碰巧同一點，
  //    但只要有一邊搬家或改層數，列檔就**可能**回空陣列，而**下面那個迴圈一個斷言都不會執行＝靜靜全綠**。
  //    搬家前兩個動作共用同一個根，沒有這條分叉。
  // ⚠️ **這道地板實際擋得到什麼、擋不到什麼（#587 r4 逐案實測，照實列）**：
  //    ・**擋得到**：列到空集合（根指到存在但沒有那些檔的目錄）；列得到東西、卻漏掉任何一支
  //      「已登記的閘」。
  //    ・**用不到就先炸**：根指到不存在的目錄 ⇒ `readdirSync` 直接 ENOENT（也是紅，但不是這道地板攔的）。
  //    ・**擋不到**：根指到**另一棵剛好有同名閘的樹**——非空、五支都在，地板全部滿意，
  //      而它掃的其實不是這個 repo。所以**不要說「根算錯就會紅」**，要說「空的或缺既有閘會紅」。
  const files = scriptFiles();
  assert.ok(files.length > 0,
    '`scriptFiles()` 一支腳本都沒列到——不是 scripts/ 空了，就是它推算的倉庫根跟本檔不一樣。'
    + '空集合會讓下面的迴圈完全不執行＝什麼都沒檢查卻回報通過。');
  for (const g of running) {
    assert.ok(files.includes(g),
      `合併步驟裡登記了 ${g}，但 \`scriptFiles()\` 沒有列到它。`
      + '兩邊的倉庫根或射程對不上了——在這種狀態下這一題的結果不可信。');
  }
  for (const f of files) {
    if (!read(f).includes('MERGE_GATE')) continue;
    assert.ok(running.has(f),
      `${f} 提到 MERGE_GATE，但它**不在合併步驟已登記的那一組**裡。\n`
      + '⚠️ 這就是幽靈閘：自報自己是閘，卻**不在合併步驟反查得到的那一組**裡。留著它，盤點會給錯的安全感。\n'
      + '   ⚠️ 照實劃界（Grok #587）：本題證的是「**不在反查出的那一組**」，**不是**「沒有任何執行路徑」——\n'
      + '   它也證明不了那道閘跑起來真的會擋（那要靠各自的端到端考題）。\n'
      + '   要嘛把它寫進 REVIEW-AND-MERGE.md 合併步驟的標準指令行（`node scripts/<名>.js <N>`，\n'
      + '   限第一層、限 .js——那是 gatesRunInMergeSteps() 刻意的窄射程），要嘛不要自報 MERGE_GATE。\n'
      + '⚠️ 這裡刻意寬到「提到就算」：`export const`／`export { }`／子目錄／.mjs／.cjs 拼法列舉不完，\n'
      + '   所以認名字不認寫法。');
  }
});

test('舊的「五步驟合併」說法不可以再出現（掃法要夠廣——只掃三個字串已經漏掉一處）', () => {
  // ⚠️ 這題的第一版只掃三個固定字串，結果**漏掉 `五步驟＝確認審查結論…` 那種寫法**
  //    （Codex #379 r2 High②，同一種漂移的第三次）。改成掃「五步驟」出現在合併語境裡的**任何**形式。
  for (const f of ['AGENTS.md', 'REVIEW-AND-MERGE.md']) {
    const txt = read(f);
    for (const [i, line] of txt.split('\n').entries()) {
      // 「五步驟審查循環」是另一件事，五步是對的——只放行明確講「審查循環」的那些
      const mentionsFive = /五步驟|五個步驟/.test(line);
      if (!mentionsFive) continue;
      const isReviewCycle = /五步驟審查循環|五步驟表|審查循環/.test(line);
      assert.ok(isReviewCycle,
        `${f}:${i + 1} 在合併語境提到「五步驟」：\n  ${line.trim().slice(0, 160)}\n`
        + '合併步驟清單不得稱為五步（實際步數以 REVIEW-AND-MERGE.md 合併步驟的清單為準，這裡刻意不寫死）。'
        + '⚠️ 別跟「五步驟**審查循環**」搞混——那是另一件事，五步是對的。');
    }
  }
});

test('AGENTS.md 不可以再有「重述合併步驟」的摘要（重述的摘要注定落後）', () => {
  // Codex r1 High② 抓到一處、r2 High② 又抓到第二處——判準改成「有沒有把步驟串起來寫」，
  // 而不是「有沒有出現某個字串」。
  const agents = read('AGENTS.md');
  const arrowChains = agents.split('\n').filter((l) =>
    /gh pr merge/.test(l) && /→|->/.test(l));
  assert.deepEqual(arrowChains.map((l) => l.trim().slice(0, 100)), [],
    'AGENTS.md 又出現把合併步驟串起來的摘要。\n'
    + '這一段刻意只留指標＋各道守門的名字（幾道刻意不寫死）：摘要會落後，名字不會。');
});

test('欄位閘｜**假欄位名不可以冒充真欄位**（`非實作者` 也曾被判成「實作者」）', () => {
  // ⚠️ Codex #379 r2 High①：欄位抽取沒有錨定在行首，於是整份 PR 說明一個真欄位都沒有，
  //    卻被判「欄位齊全」＝機械閘 fail-open。
  const fake = REQUIRED_FIELDS.map((f) => `- **非${f}**：Claude`).join('\n');
  const problems = problemsOf(fake);
  assert.ok(problems.length >= REQUIRED_FIELDS.length,
    `全部是假欄位名卻通過了（實得 ${problems.length} 條問題）——欄位抽取沒有錨定行首`);
});

test('欄位閘｜括號裡藏第二個角色 → 看不出是誰（含全形與零寬藏法）', () => {
  // ⚠️ r2 只擋得住半形寫法：括號內的檢查用**原字串**，於是全形 `（Ｃｏｄｅｘ）` 與
  //    零寬 `（Co\u200bdex）` 都溜過去——括號被整段剝掉，剩下乾淨的 `Claude`（Codex #379 r3）。
  //    根因是「同一個字串有兩種形式在流動」。現在 NFKC ＋ 去除 \p{Cf} 做在**最前面、只做一次**。
  for (const sneaky of [
    'Claude（Codex）', 'Claude (Codex)', 'Codex（Claude 也看了）',
    'Claude（Ｃｏｄｅｘ）',          // 全形
    'Claude（Co\u200bdex）',        // 零寬空白插在中間
    'Ｃｌａｕｄｅ（Ｃｏｄｅｘ）',    // 兩邊都全形
    // ── Codex #379 r4 的四種：\p{Cf} 擋不住的那一群 ──
    'Claude（Co\u034Fdex）',       // U+034F 組合接合符（Mn，不在 Cf 裡——r4 就是這樣繞過 r3）
    'Claude（Co\uFE0Fdex）',       // U+FE0F 變體選擇符（default-ignorable）
    'Claude（Co\u0301dex）',       // U+0301 組合重音（NFKD＋去 Mark 才折得掉）
    'Claude（\u0421odex）',        // 西里爾 С——螢幕上跟拉丁 C 一樣；混用文字系統整欄 fail-closed
    // ⚠️ U+2065（未指派、保留給未來格式字元）＝**只有 Default_Ignorable 那層擋得住**：
    //    不是 Mark、不是 Cf、也不是字母（所以 mixed-script 不觸發）。突變實測拿掉 DI 層時
    //    上面四種全部照樣被 M 層擋住——沒有這個探針，DI 層是一層沒有考題盯著的防線。
    'Claude（Co\u2065dex）',
  ]) {
    const problems = problemsOf(bodyWith(sneaky, 'William'));
    assert.ok(problems.length > 0,
      `「${sneaky}」被剝成單一角色而通過——括號內的檢查必須看**正規化後**的字串`);
  }
});

test('欄位閘｜正規化之後，換個字形不能變成另一個人（自審檢查才是重點）', () => {
  // 把 NFKC 提前的副作用：裸全形 `Ｃｌａｕｄｅ` 現在會被接受（r2 版是 fail-closed 擋掉）。
  // **那是刻意的**——擋掉只是「看不懂所以擋」，接受並正規化才能認出「這兩欄其實是同一個人」。
  for (const [impl, rev, label] of [
    ['Ｃｌａｕｄｅ', 'Claude', '全形 vs 半形'],
    ['Cla\u200bude', 'Claude', '零寬 vs 乾淨'],
    ['ＣＬＡＵＤＥ', 'claude', '全形大寫 vs 半形小寫'],
  ]) {
    const problems = problemsOf(bodyWith(impl, rev));
    assert.ok(problems.some((x) => x.includes('由寫它的人放行')),
      `「${label}」沒有被判成同一人——換個字形就能自審放行`);
  }
  assert.deepEqual(problemsOf(bodyWith('Ｃｌａｕｄｅ', 'Codex')), [],
    '全形寫法配上不同角色被誤擋了——噪音型誤擋會讓人乾脆繞過這道閘');
});

test('欄位閘｜有序清單是合法填法，引用範例不是', () => {
  const rows = (bullet) => REQUIRED_FIELDS
    .map((f, i) => `${bullet(i)} **${f}**：${f === '實作者' ? 'Claude' : f === '獨立審查者' ? 'Codex' : '無'}`)
    .join('\n');
  assert.deepEqual(problemsOf(rows((i) => `${i + 1}.`)), [],
    '有序清單 `1. **實作者**：` 被誤擋了——用 1. 而不是 - 顯然不是想規避什麼，'
    + '而噪音型誤擋會讓人乾脆繞過這道閘');
  assert.ok(problemsOf(rows(() => '> -')).length >= REQUIRED_FIELDS.length,
    '引用區塊（`> - **實作者**：`）被當成真的填寫了——那是引用範例，不該滿足這道閘');
});

test('trailer 格式要涵蓋三個角色（模板允許 William 當審查者，格式卻不允許＝逼人寫假的）', () => {
  const cr = read('REVIEW-AND-MERGE.md');
  const i = cr.indexOf('Reviewed-By:');
  assert.ok(i > 0, 'REVIEW-AND-MERGE.md 找不到 Reviewed-By trailer 的格式說明');
  const line = cr.slice(i, cr.indexOf('\n', i));
  assert.ok(line.includes('William'),
    `Reviewed-By 的格式沒有列 William，但模板與 check-pr-collab-fields.js 都允許他當獨立審查者。\n`
    + '格式與規則不一致會逼人在「照實寫」與「照格式寫」之間二選一，兩種選擇都讓稽核軌跡失真。\n'
    + `實得：${line}`);
});

test('欄位閘｜混用文字系統 fail-closed，但純中文註記不可誤擋', () => {
  // 西里爾 С 這類同形字**正規化折不掉**（它就是另一個字母）。不做 confusable 對照表
  //（表列不完——r1 列字串、r2 列形狀、r3 列名字，同型病不犯第四次），改成劃界：
  // 角色名全是拉丁字母，欄位裡「拉丁詞夾非拉丁、非漢字的字母」沒有正當理由 → 整欄看不出是誰。
  const cyr = problemsOf(bodyWith('Сlaude', 'Codex'));   // 整個字用西里爾 С 開頭
  assert.ok(cyr.length > 0, '西里爾同形字冒充角色名沒有被擋');
  assert.deepEqual(problemsOf(bodyWith('Claude（已看過）', 'Codex')), [],
    '中文括號註記被誤擋——噪音型誤擋會讓人乾脆繞過這道閘');
});

// ── CI 的協作欄位閘（2026-08-02）─────────────────────────────


const GATE_WF = '.github/workflows/collab-fields.yml';
const WF_DIR = '.github/workflows';


/**
 * `.github/workflows/collab-fields.yml` 的**逐行複本**。
 *
 * ⚠️ **這是字面複本，不是結構描述**（Grok #586 掃後點名）：現行斷言是「檔案逐行等於這個陣列」，
 *    **沒有任何一段程式在辨識 `if:`／`needs:`／`shell:`／`|| true` 這些寫法**。
 *    失敗訊息裡列那些寫法，是說明**為什麼要釘整份**，不是考題認得它們。
 *    照舊檔頭（「整份 deepEqual 形狀」「比對原始 flow sequence 字串」）去改，會用錯模型。
 * ⚠️ **它擋的是**「那份檔案被靜靜改掉」；**它擋不到**「有人把失效寫法連同這個常數一起改」——
 *    那要靠複審的眼睛。
 * ⚠️ 這個陣列必須是**手寫的字串字面量**。題名關鍵字「把逐行複本一行改成」那一題擋住**一步**的摺法
 *    （把宣告改成從檔案再切一次行 ⇒ 斷言變恒真、題名與註解照樣說「釘死」）。
 *    ⚠️ 它**擋不到多寫幾行的做法**（改成 import 再留一個不會執行的同名字面量、或宣告後用 `splice`
 *    在執行期換掉內容）——考題檔自己可被編輯，那一族的下限是複審的眼睛，見那一題的檔頭。
 */
const GATE_WF_LINES = [
  '# 協作欄位閘（雲端門）：擋「實作者＝獨立審查者」與必填欄位沒填齊的 PR。',
  '#',
  '# ⚠️ **為什麼自己一個檔案、不併進 ci.yml**（Codex #382 r1 抓到的 High）：',
  '#   觸發條件不一樣。ci.yml 的三關看的是**程式碼**（commit 一動才需要重跑）；',
  '#   這道閘看的是**PR 說明**——而 GitHub 的 `pull_request:` 預設事件是',
  '#   `opened / synchronize / reopened`，**不含 `edited`**。',
  '#   後果很具體：先用填齊的欄位開 PR 拿到綠燈 → 再編輯說明把欄位刪掉／把實作者',
  '#   與審查者改成同一人 → **commit SHA 沒變、workflow 不重跑、綠燈還在**',
  '#   ⇒ 分支保護照樣放行。反方向也一樣痛：紅燈後補好說明，不會自動轉綠。',
  '#   所以這裡必須明寫 `types:` 加上 `edited`。',
  '#   而 ci.yml **刻意不加 `edited`**——改幾個字的說明不該重跑 1300+ 題兩輪。',
  '#',
  '# ⚠️ job 的 `name:` 是分支保護 required check 的比對字串（**逐字**）。',
  '#    改這裡就要同步改 GitHub 設定與 docs/GitHub分支保護-設定與驗證.md，',
  '#    否則 GitHub 會一直等一個永遠不會出現的 check ＝**永遠卡住合併**。',
  'name: 協作欄位',
  '',
  'on:',
  '  pull_request:',
  '    types: [opened, edited, reopened, synchronize]',
  '',
  'jobs:',
  '  collab-fields:',
  '    name: 協作欄位（實作者 ≠ 獨立審查者）',
  '    runs-on: ubuntu-latest',
  '    # ⚠️ **必須明寫 pull-requests: read**（2026-08-02 第一次上工就踩到）：',
  '    #    預設的 GITHUB_TOKEN 讀不到 PR 內容，`gh pr view` 會回',
  '    #    `Resource not accessible by integration (repository.pullRequest)`，',
  '    #    腳本 fail-closed 判「查不清楚」→ 退出碼 2 → 每一支 PR 都紅。',
  '    #    （fail-closed 本身是對的：查不到不等於安全。錯的是沒給權限。）',
  '    permissions:',
  '      contents: read',
  '      pull-requests: read',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: actions/setup-node@v4',
  '        with:',
  '          node-version-file: .node-version',
  '      - name: 協作欄位閘（必填欄位齊全＋實作者 ≠ 獨立審查者）',
  '        env:',
  '          # gh CLI 在 runner 上已預裝；它讀 GH_TOKEN 才查得到 PR 說明',
  '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  '        # ⚠️ 這一行**不可以**接 `|| true`／`; true`，也不可以在 job 上加',
  '        #    `continue-on-error`——那會讓閘永遠放行，而考題原本看不出來',
  '        #    （#382 r1 實測：加了 `|| true`，28/28 全綠）。現在有考題盯著。',
  '        run: node scripts/check-pr-collab-fields.js ${{ github.event.pull_request.number }}',
];

/**
 * workflow 檔裡第一個「不准出現」的字元；沒有就回 null。**只准 SPACE、TAB、LF。**
 *
 * ⚠️ **這一條現在守的是什麼**：`collab-fields.yml` 已改成**逐行逐字**比對，所以對它而言這條是
 *    **額外的格式政策**（本 repo 只收 LF）；對**其他 workflow**（例如 `ci.yml`）而言，這條是它們
 *    僅有的字元集合防線。
 * ⚠️ **舊版病史（判準的由來，不是現行原因）**：本條出生時，那道比對是先用一支迷你讀取器解析——
 *    它用 `text.split('\n')` 切行、又把「以 `#` 開頭的行」整行丟掉。只要讓它「看不見」一段內容，
 *    那段就不在比對範圍裡。兩條實測過的路（**兩個實測都在本機**，沒有在 GitHub 上驗過服務端解析器）：
 *    ①**換行類**（CR／NEL／LS／PS）：比對只認 LF。把它們夾在一行註解裡、後面接
 *      `continue-on-error: true` ⇒ 比對只看到一行註解、整行丟掉，**四種都靜靜通過**（2026-09-09）。
 *    ②**YAML 不認的空白**（NBSP／全形空白／各種 EN・EM SPACE）：JS 的 `\s` 認它們、YAML 只認
 *      SPACE 與 TAB。所以 `<NBSP># || true` 在 YAML 眼裡是上一個 `run:` 純量的**續行**，
 *      比對卻把它當註解丟掉——#586 r1 High：獨立審查者用真的 YAML 解析器＋真的腳本驗到
 *      **注入版 exit 0**（本機路徑；沒有在 GitHub 上推攻擊 workflow，也沒量服務端解析器）。
 * ⚠️ **不去猜下游怎麼解析，直接拒收**（這是本條的核心）：CR 在 YAML 規格裡就是換行；
 *    NEL／LS／PS 在 YAML 1.1 是換行、1.2 拿掉了，而**我沒有量過 GitHub Actions 用的是哪一版**
 *    （本機沒有 YAML 解析器可驗）。「不知道下游怎麼解讀」的正確反應是**拒收輸入**，不是猜。
 * ⚠️ **「只准這三個空白」用 JS 自己的 Unicode 空白定義（`\s`）表達，不是我列一張表**——列舉補不完。
 *    另外一律拒收 C0、DEL、C1、LS、PS。
 * ⚠️ **這扇門關到哪為止（Grok #586 掃後收窄）**：它對「**JS 空白 ∪ 控制字元區間**」是關起來的，
 *    **不是**對「凡是會讓註解起始符不再位於空白之後的字元」關起來——**格式類（`\p{Cf}`）與零寬類
 *    不在射程內**。`collab-fields.yml` 有逐行複本擋著，走不進去；**`ci.yml` 只靠這把尺**。
 *    沒有順手把那兩類也拒收，是因為本 repo 的 workflow 註解用得到變體選擇符與表情符號，
 *    一律拒收會誤擋正常編輯。⇒ **記為待辦**，不在本支收。
 * ⚠️ **照實說代價**：這條會拒收 **CRLF 行尾**，而 CRLF 本身是合法 YAML——本 repo 只收 LF，
 *    所以那是**本 repo 的格式限制**、不是 YAML 錯。踩到時處置分兩種，**別一律說「改成 LF」**：
 *    行尾問題＝在編輯器轉行尾；其餘（意外貼進來的控制字元、NBSP、全形空白）＝刪掉或換成普通空白，
 *    真的要那個字元當內容就用 YAML 的跳脫寫法。**「正常編輯不會產生這些字元」是假話**
 *    （Windows／某些編輯器很容易存成 CRLF），#586 r1 點名，已改口。
 * ⚠️ 這跟 `test/comment-test-refs.test.js` 的控制字元掃描器**不是同一把尺**（⚠️ 那支在**別的檔案**，
 *    所以這裡點檔名、不用「題名關鍵字」記號——那個記號的機械閘只認同檔的題名，我先寫錯過一次、被它擋下）：
 *    那一組掃的是考題檔、而且**放行 CR**（一般文字檔有 CRLF 很正常），也不管 LS／PS 與各種空白。
 *    workflow 這裡必須更嚴，所以另立一把。
 *
 * @param {string} text @returns {{ at: number, code: number } | null}
 */
function firstBadWorkflowChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') continue;   // 僅有的三個例外
    // ⚠️ **只准這三個空白**。判準借 JS 自己的 Unicode 空白定義（`\s`），不是我列一張表——
    //    列舉補不完。YAML 的分隔空白只有 SPACE 與 TAB，所以 NBSP、全形空白、各種 EN／EM SPACE
    //    在 YAML 眼裡都**不是**空白；而 JS 的 `\s` 認它們，兩邊一分岔就是 #586 r1 那個 High。
    const bad = /\s/u.test(ch)
      || code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
      || code === 0x2028 || code === 0x2029;
    if (bad) return { at: i, code };
  }
  return null;
}

/**
 * 掃一組來源，回報「不該出現的字元」**與「實際掃過哪些檔」**。**純函式。**
 * ⚠️ 回傳形狀是物件、不是陣列——#586 r5 抓到這裡的 JSDoc 還寫著 `string[]`。
 *    `jsconfig.json` 沒有把 `test/` 納入型別檢查，所以這種錯**不會被三關的 typecheck 叫**。
 * @param {{ name: string, source: string }[]} sources
 * @returns {{ problems: string[], scanned: string[] }}
 */
function scanWorkflowChars(sources) {
  /** @type {string[]} */
  const problems = [];
  /** ⚠️ **`scanned` 一定要在迴圈裡累積**（#586 r4 Medium）：上一版是從輸入陣列 `map` 出來的，
   *  於是「讀進來了、但送進迴圈前被切掉」或「迴圈自己 `slice` 掉前面幾筆」都照樣回報成掃過。
   *  記錄要來自**實際處理過的那一筆**，才擋得住那段接縫。
   *  @type {string[]} */
  const scanned = [];
  for (const { name, source } of sources) {
    scanned.push(name);
    const hit = firstBadWorkflowChar(source);
    if (hit) {
      problems.push(`  ${name}:${source.slice(0, hit.at).split('\n').length} 有 `
        + `U+${hit.code.toString(16).padStart(4, '0').toUpperCase()}`);
    }
  }
  return { problems, scanned: scanned.sort() };
}

/**
 * 列出一個目錄裡的 workflow 檔並讀進來。
 * @param {string} dir @param {string} label 訊息裡顯示的路徑前綴
 * @returns {{ name: string, source: string }[]}
 */
const workflowSources = (dir = join(ROOT, WF_DIR), label = WF_DIR) => readdirSync(dir)
  .filter((x) => /\.ya?ml$/.test(x))
  .map((f) => ({ name: `${label}/${f}`, source: readFileSync(join(dir, f), 'utf8') }));

/**
 * **正式入口**：一律掃真的 workflow 目錄；`extra` 是額外要一起掃的目錄。
 * ⚠️ **真檢查與誘餌題共用這一支**（#586 r3 Medium①）：上一版把誘餌搬去只掃暫存目錄，
 *    結果「真目錄那一條呼叫」被切成 `[]` 時誘餌照樣通過——兩條呼叫各自獨立，誰斷了另一邊都不知道。
 *    共用同一支、且 `scanned` 由**實際處理過的每一筆**累積之後，這支被掏空、真來源**從名單裡**漏掉、
 *    或在送進掃描迴圈前後被 `slice` 掉，誘餌題都會叫（#586 r3／r4 逐刀驗過）。
 * ⚠️ **照實劃界（Grok #586 掃後點名）**：`scanned` 記的是「**進了迴圈**」，不是「判準看完了這份內容」；
 *    而且真 workflow 平常是乾淨的——所以「只對真檔跳過判準、照樣掃暫存樣本」這種改法**不會**被叫。
 *    ⚠️ **這一族目前沒有東西擋**（#586 r9 Low 更正：我原本寫「位置 × 家族全掃那一題擋得到」，
 *    那是錯的——矩陣的違規字元只種在暫存樣本裡，真檔被特判跳過時它照樣綠）。
 *    「位置 × 家族全掃」守的是**固定暫存樣本經共用路徑的回報**，不是「真檔有沒有被判準看過」。
 * @param {[string, string][]} extra
 * @returns {{ problems: string[], scanned: string[] }}
 */
const scanWorkflows = (extra = []) => {
  const sources = [
    ...workflowSources(),
    ...extra.flatMap(([dir, label]) => workflowSources(dir, label)),
  ];
  // ⚠️ **連「掃了哪些檔」也回報**（#586 r3 Medium①）：只回報「找到幾個問題」的話，
  //    把真來源整組漏掉也是「零個問題」＝零個問題，兩邊都綠。掃了誰要能被斷言。
  //    ⚠️ 那份名單由 `scanWorkflowChars` **在迴圈裡**累積，不是從這裡的輸入 map 出來（#586 r4）。
  return scanWorkflowChars(sources);
};

/** 真 workflow 一定要在被掃的名單裡（每一題都斷言，漏掉整組會在這裡紅）。 */
const REAL_WF_NAMES = [`${WF_DIR}/ci.yml`, `${WF_DIR}/collab-fields.yml`];

test('⭐ workflow 的檔案清單與內容要原樣讀進來（漏檔、截斷、只讀首行都要紅）', () => {
  // ⚠️ 為什麼要單獨釘這一層（#586 r3 Medium②）：只斷言「掃出零個問題」的話，
  //    列檔或讀檔少讀了什麼**也是零個問題**。所以這裡直接釘「列到哪些檔」與「讀進來的內容
  //    等於檔案本身」。新增一支 workflow 要同時改這裡＝那是刻意的動作。
  const sources = workflowSources();
  assert.deepEqual(sources.map((x) => x.name).sort(),
    [`${WF_DIR}/ci.yml`, `${WF_DIR}/collab-fields.yml`],
    'workflow 的檔案清單跟釘住的不一樣（新增／改名／被過濾掉了）');
  for (const { name, source } of sources) {
    assert.equal(source, read(name), `${name} 沒有被原樣讀進來（截斷或只讀首行都會落在這裡）`);
  }
});

test('⭐ workflow 的空白只准 SPACE／TAB／LF', () => {
  const { problems, scanned } = scanWorkflows();
  assert.deepEqual(scanned, REAL_WF_NAMES, '真的 workflow 沒有全部進到被掃的名單裡');
  assert.deepEqual(problems, [],
    'workflow 裡出現不該有的字元（位置見上）。\n'
    + '⚠️ 這不是潔癖，是兩個實測過的情形——**兩個實測都在本機**（本機 YAML 解析器＋本機 shell），\n'
    + '   **沒有在 GitHub 上驗過服務端解析器**：\n'
    + '  ①**換行類**（CR／NEL／LS／PS）：曾經的比對用 LF 切行，看不見它們。\n'
    + '  ②**YAML 不認的空白**（NBSP／全形空白／各種 EN・EM SPACE）：JS 的 `\\s` 認它們、YAML 只認\n'
    + '    SPACE 與 TAB，所以那種行在 YAML 是上一個純量的**續行**，當時的比對卻當註解丟掉。\n'
    + '    #586 r1：獨立審查者用本機 YAML 解析器＋本機 shell 驗到「該版本的腳本回傳 0」。\n'
    + '⚠️ **這一題現在守的是什麼**：`collab-fields.yml` 已經改成**逐行逐字**比對，所以對它而言\n'
    + '   這條是**額外的格式政策**（本 repo 只收 LF）；對**其他 workflow**（例如 `ci.yml`）而言，\n'
    + '   這條是它們僅有的字元集合防線。\n'
    + '⚠️ **處置分兩種，別一律說「改成 LF」**：\n'
    + '  ・**行尾**是 CRLF ⇒ 在編輯器把行尾轉成 LF（CRLF 本身是合法 YAML，是本 repo 只收 LF）。\n'
    + '  ・**其餘**（意外貼進來的控制字元、NBSP、全形空白）⇒ **刪掉或換成普通空白**；\n'
    + '    真的需要那個字元當內容，請用 YAML 的跳脫寫法。');
});

test('⭐ 列檔→讀檔→掃描整條路：暫存目錄裡的違規檔要抓到，近似副檔名不可誤抓', () => {
  // ⚠️ 這一題與題名關鍵字「workflow 的空白只准 SPACE」那一題**走同一支 `scanWorkflows`**，
  //    所以正式入口被掏空時這裡也會紅。
  // ⚠️ 涵蓋 #586 r3 Medium② 點名的四種退化：只認 `.yml`（漏 `.yaml`）、列檔被截斷、
  //    讀檔被截斷（違規字元在後段）、過濾正則掉了尾端 `$`（誤抓 `.yaml.txt`）。
  const dir = mkdtempSync(join(tmpdir(), 'wf-probe-'));
  try {
    // ⚠️ 暫存目錄開在系統 tmp、**不開在 repo 裡**：開在 repo 裡會被別的掃描器數到（併發假紅）。
    const CR = String.fromCharCode(0x0d);
    writeFileSync(join(dir, 'a-bad.yml'), `name: x\n# probe${CR}continue-on-error: true\n`);
    writeFileSync(join(dir, 'b-late.yaml'), `name: y\n${'# filler\n'.repeat(40)}tail${CR}\n`);
    writeFileSync(join(dir, 'zz-last.yml'), `name: z\nrun: ok${CR}\n`);
    writeFileSync(join(dir, 'c-good.yml'), 'name: fine\n  run: ok\n');
    writeFileSync(join(dir, 'd-ignored.txt'), `not a workflow${CR}\n`);
    writeFileSync(join(dir, 'e-probe.yaml.txt'), `also not one${CR}\n`);
    // ⚠️ 沒有副檔名：把過濾正則裡的 `\.` 寫成 `.`（萬用字元）就會把它誤算成 workflow（#586 r4 Low）
    writeFileSync(join(dir, 'f-probe-yaml'), `no extension${CR}\n`);
    // ── 下面三支是 #586 r5 點名的「讀進來之後、送進判準之前」那段接縫，每支各釘一種退化 ──
    const NBSP = String.fromCharCode(0xa0);
    // ⚠️ 違規字元是**整個檔案的最後一個字元、後面沒有換行**：`source.slice(0, -1)` 會漏掉它
    writeFileSync(join(dir, 'g-eof.yml'), `name: g\n# probe${CR}`);
    // ⚠️ 違規字元在**很後面**（超過 8 KiB）：任何 `slice(0, 8192)` 之類的截斷都會漏掉它
    writeFileSync(join(dir, 'h-far.yml'), `name: h\n# ${'x'.repeat(9000)}${NBSP}\n`);
    // ⚠️ 違規字元**不是 CR**：只回報 CR 的過濾、或送判準前把 NBSP 換成普通空白，都會漏掉它
    writeFileSync(join(dir, 'i-nbsp.yml'), `name: i\n# note${NBSP}\n`);
    // ⚠️ 大寫副檔名：本 repo 的政策是**只收小寫** `.yml`／`.yaml`；過濾正則加上 `i` 旗標
    //    就會把它列進來（#586 r5 Low）。它含違規字元，所以誤收會讓問題清單多一筆。
    writeFileSync(join(dir, 'j-UPPER.YAML'), `name: j\n# upper${CR}\n`);
    // ⚠️ 違規字元在**第 0 個位置**（檔案第一個字元）：判準迴圈從 1 開始、送判準前 `slice(1)`、
    //    或把命中判成 `if (hit?.at)`（位置 0 是 falsy）都會漏掉它。碼位同時 **> U+00FF**，
    //    所以「只回報 U+00FF 以內」「把非 Latin-1 換成空白」「只認已出現過的碼位」也一起釘住。
    writeFileSync(join(dir, 'k-bom.yml'), `${String.fromCharCode(0xfeff)}name: k\n`);
    // ⚠️ 另一個 > U+00FF 的違規字元，而且**不在第 0 個位置**（跟上一支分開釘，失敗訊息才看得出是哪一種）
    writeFileSync(join(dir, 'l-wide.yml'), `name: l\n# probe${String.fromCharCode(0x2003)}\n`);
    const { problems, scanned } = scanWorkflows([[dir, 'probe']]);
    assert.deepEqual(scanned, [...REAL_WF_NAMES, 'probe/a-bad.yml', 'probe/b-late.yaml',
      'probe/c-good.yml', 'probe/g-eof.yml', 'probe/h-far.yml', 'probe/i-nbsp.yml',
      'probe/k-bom.yml', 'probe/l-wide.yml', 'probe/zz-last.yml'].sort(),
      '被掃的名單不對：真 workflow 漏掉了，或把不是 workflow 的檔也列進來');
    assert.deepEqual(problems.sort(), [
      '  probe/a-bad.yml:2 有 U+000D',
      '  probe/b-late.yaml:42 有 U+000D',
      '  probe/g-eof.yml:2 有 U+000D',
      '  probe/h-far.yml:2 有 U+00A0',
      '  probe/i-nbsp.yml:2 有 U+00A0',
      '  probe/k-bom.yml:1 有 U+FEFF',
      '  probe/l-wide.yml:2 有 U+2003',
      '  probe/zz-last.yml:2 有 U+000D',
    ], '列檔／讀檔／掃描這條路上有一段沒做事（或把命中結果過濾掉了）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 位置 × 家族全掃：違規字元插在**每一個位置**，走完整條路都要回報得一模一樣', () => {
  // ⚠️ **為什麼要有這一題（#586 r1〜r6 的收斂點）**：前六輪每一輪都是「誘餌少了某一種形狀」——
  //    位置 0、檔尾沒換行、超過 8 KiB、不是 CR、碼位大於 U+00FF…**形狀是無窮的，列不完**。
  //    所以這裡不再加形狀，改成**把位置掃完**：拿一份乾淨的小 workflow，把一個違規字元插進
  //    **每一個可能的位置**（含最前面與最後面），每次都走**正式入口**（列檔→讀檔→掃描→回報），
  //    斷言問題清單逐字相符。**在這份固定樣本與這組代表字元的矩陣內**，「某個位置被切掉／換掉／濾掉」
  //    這一族就關門了。
  // ⚠️ **照實寫兩題的證據範圍**（#586 r7 Low：我原本說得太滿）：
  //    ・題名關鍵字「整個家族都要拒收」那一題：C0 與 C1 是**逐碼位**掃過的，
  //      **Unicode 空白只取代表值**——U+2001／U+2002／U+2004／U+2006〜U+2009 就沒進到那一題。
  //    ・本題：**固定樣本的每一個插入位置**，各家族代表字元，走完整入口比對回報。
  //    ⇒ 兩題是**互補**，不是「射程不同、不重複」：那一題本身也測位置與檔尾，兩者有重疊。
  const base = 'name: probe\n# comment\nrun: ok\n';
  const FAMILIES = [0x00, 0x0d, 0x7f, 0x85, 0xa0, 0x2003, 0x2028, 0xfeff];
  const dir = mkdtempSync(join(tmpdir(), 'wf-sweep-'));
  try {
    for (const code of FAMILIES) {
      const label = `U+${code.toString(16).padStart(4, '0').toUpperCase()}`;
      for (let at = 0; at <= base.length; at += 1) {
        const text = base.slice(0, at) + String.fromCharCode(code) + base.slice(at);
        writeFileSync(join(dir, 'probe.yml'), text);
        const { problems, scanned } = scanWorkflows([[dir, 'sweep']]);
        const line = text.slice(0, at).split('\n').length;
        assert.deepEqual(problems, [`  sweep/probe.yml:${line} 有 ${label}`],
          `${label} 插在第 ${at} 個位置（第 ${line} 行）沒有被原樣回報——`
          + '這條路上有一段把它切掉、換掉或濾掉了');
        assert.ok(scanned.includes('sweep/probe.yml') && scanned.length === REAL_WF_NAMES.length + 1,
          `${label} 插在第 ${at} 個位置時，被掃的名單不對：${scanned.join('｜')}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 判準本身：整個家族都要拒收、位置要報對、正常內容要放行', () => {
  const ok = 'name: x\n  run: y\t# 註解\n中文與 emoji 🚦 都正常\n';
  assert.equal(firstBadWorkflowChar(ok), null, 'SPACE／TAB／LF／一般文字被誤擋了');

  // ── 逐一點名的（每一個都是實測過或規格上的夾帶路徑）
  for (const [label, code] of /** @type {[string, number][]} */ ([
    ['CR U+000D', 0x0d], ['NEL U+0085', 0x85], ['LS U+2028', 0x2028], ['PS U+2029', 0x2029],
    ['NBSP U+00A0', 0xa0], ['EM SPACE U+2003', 0x2003], ['IDEOGRAPHIC SPACE U+3000', 0x3000],
    ['NUL U+0000', 0x00], ['VT U+000B', 0x0b], ['FF U+000C', 0x0c], ['DEL U+007F', 0x7f],
    ['ZWNBSP U+FEFF', 0xfeff],
  ])) {
    const hit = firstBadWorkflowChar(`# 註解${String.fromCharCode(code)}continue-on-error: true\n`);
    assert.ok(hit && hit.code === code, `${label} 沒有被拒收——那就是夾帶進來的那條路`);
  }

  // ── **整個家族**，不是只有點名的那幾個（#586 r1 Medium：把區間改成只判 0x85 也全綠）
  for (const [label, codes] of /** @type {[string, number[]][]} */ ([
    ['C0（0x00–0x1F，扣掉 TAB／LF）', [...Array(0x20).keys()].filter((c) => c !== 0x09 && c !== 0x0a)],
    ['C1（0x80–0x9F，含兩端）', [...Array(0x20).keys()].map((c) => c + 0x80)],
    ['Unicode 空白分隔（含兩端與中間）', [0x1680, 0x2000, 0x2005, 0x200a, 0x202f, 0x205f]],
  ])) {
    for (const code of codes) {
      const hit = firstBadWorkflowChar(`a${String.fromCharCode(code)}b`);
      assert.ok(hit && hit.code === code, `${label} 裡的 U+${code.toString(16).toUpperCase()} 沒被拒收`);
    }
  }

  // ── 位置要對，而且**最後一個字元**也要掃到（把迴圈寫成 length - 1 就會漏）
  assert.deepEqual(firstBadWorkflowChar('ab\r'), { at: 2, code: 0x0d }, '檔尾的違規字元漏掃了');
  assert.deepEqual(firstBadWorkflowChar(`ab${String.fromCharCode(0xa0)}cd`), { at: 2, code: 0xa0 },
    '回報的位置不對——訊息會指到錯的行');
  assert.equal(firstBadWorkflowChar(`${'x'.repeat(9000)}\r`)?.at, 9000, '晚位置的違規字元漏掃了');
});

test('⭐ 把逐行複本一行改成「從檔案算出來」會紅（擋一步摺成恒真；擋不到多寫幾行的做法）', () => {
  // ⚠️ **這一題證得到什麼、證不到什麼，先講清楚**（#586 Grok 掃後提出、r9／r10 兩度收窄）：
  //
  //  **為什麼要有它**：`GATE_WF_LINES` 的內容跟被守的檔案一模一樣，所以把宣告改成
  //  `read(GATE_WF).split('\n')` **只要一步**，逐行比對就變成「檔案等於自己」＝恒真，
  //  而題名、註解、失敗訊息**通通還寫著「釘死」**。那是本專案認過最糟的一型。
  //  這一題擋的就是**那一步**。
  //
  //  **證不到的（照實列，r10 逐一實測過）**：它看的是**原始碼裡那個宣告的長相**，
  //  不是「比對時真正用到的值」。所以多寫幾行就繞得過——
  //  ・把真值改成 `import`，另外在一個**不會被執行的函式**裡留一個同名的字面量宣告；
  //  ・宣告原封不動，後面補一句 `GATE_WF_LINES.splice(0, …, ...read(GATE_WF)…)` 在執行期換掉內容。
  //  兩種 r10 都實測全綠。**考題檔自己是可以被編輯的，所以沒有任何「在同檔加一段程式」的做法擋得住**——
  //  這一族的下限本來就是複審的眼睛，不是這一題。
  //  ⇒ 所以本題的宣稱是「**擋一步摺成恒真**」，**不是**「保證比對時用的值來自字面量」。
  //
  // ⚠️ **用解析器看語法樹，不用正規式**（#558 r3 立的規矩；#586 r9 又證了一次）：
  //    第一版用正規式掃原始碼，只證明得了「這串陣列文字在檔案裡出現過」——把舊陣列包進註解、
  //    留在樣板字串、或把宣告搬去別檔 import，三種都全綠。**文字出現過 ≠ 它就是那個宣告。**
  const src = read('test/collab-invariant-docs.test.js');
  const sf = ts.createSourceFile('t.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // ⚠️ TS 解析器對壞語法不丟例外（會給半棵樹、靜靜漏抓）——這裡 fail-closed。
  assert.equal(/** @type {any} */ (sf).parseDiagnostics?.length ?? 0, 0,
    '本檔解析不出乾淨的語法樹；解析器會給半棵樹，這一題就形同虛設');
  /** @type {import('typescript').VariableDeclaration[]} */
  const decls = [];
  const walk = (/** @type {import('typescript').Node} */ n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'GATE_WF_LINES') decls.push(n);
    n.forEachChild(walk);
  };
  sf.forEachChild(walk);
  assert.equal(decls.length, 1,
    `本檔裡名為 GATE_WF_LINES 的宣告有 ${decls.length} 個（要剛好 1 個）。`
    + '⚠️ 0 個＝它被搬去別檔再 import 回來；2 個以上＝有一份是幌子。兩種都請改回「本檔一個手寫宣告」。');
  const init = decls[0].initializer;
  assert.ok(init && ts.isArrayLiteralExpression(init),
    'GATE_WF_LINES 的宣告不是「一個陣列字面量」——它被改成從檔案（或別處）算出來的了嗎？'
    + '那樣「檔案逐行等於這個陣列」就變成恒真。');
  assert.ok(init.elements.length > 0 && init.elements.every((e) => ts.isStringLiteral(e)),
    'GATE_WF_LINES 陣列裡有元素不是字串字面量（樣板字串、變數、展開、呼叫都算）');
  assert.equal(init.elements.length, GATE_WF_LINES.length,
    '語法樹數到的元素數與實際陣列長度對不上');
});

test('協作欄位閘｜整份 workflow 逐行逐字釘死（擋「被靜靜改掉」，不擋「連常數一起改」）', () => {
  // ⚠️ **為什麼是逐行逐字、不是解析後比對形狀**（#586 r2 Medium）：
  //    原本用同檔一支迷你 YAML 讀取器解析再比對。但那支讀取器**不是 YAML**，兩邊只要有一處
  //    認定不同，檔案的真實語意就跑出比對的射程。實測到的分岔至少四種：冒號後不留空白
  //    （`- uses:actions/checkout@v4` 真 YAML 讀成一個字串、它讀成一組 key/value）、縮排裡的 TAB、
  //    清單記號後多一個空白而後續行不動、重複的 key。**補一種就會冒出下一種**，
  //    而它每一種的後果都一樣：這個檔案的實際內容有一部分不在比對範圍裡。
  //    （它提供的是一道平台強制的必要檢查；下游會不會照那段內容執行，本機證不了。）
  //    ⇒ 改成不解析：**這個檔案必須逐行等於 `GATE_WF_LINES` 釘死的那幾行**。任何差異都會紅。
  // ⚠️ **代價（刻意接受）**：以後動到那個檔案的任何一個字元（含加一行註解）都會紅，
  //    要同時更新 `GATE_WF_LINES`。⚠️ 這只保證**那次改動會在 diff 上留下痕跡、且不能靜靜發生**；
  //    **保證不了有人真的看過**（那要靠複審）——#586 r3 點名，原本寫「一定會有人看一眼」是誇大。
  const actual = read(GATE_WF).split('\n');
  assert.equal(actual.pop(), '', `${GATE_WF} 必須以換行結尾`);
  assert.deepEqual(actual, GATE_WF_LINES,
    `${GATE_WF} 的內容變了。`
    + '⚠️ **這一題只比對「逐行等於 GATE_WF_LINES」，沒有任何一段程式在辨識下面那些寫法**——\n'
    + '   列出來是說明**為什麼要釘整份**（那一族列舉不完），不是考題認得它們（Grok #586 掃後點名）：\n'
    + '  ・job 或 step 加 `if: ${{ false }}`（被 skip 的 job 在 required check 上回報 **Success**）\n'
    + '  ・`needs:` 一個會失敗的前置 job\n'
    + '  ・step 自訂 `shell`、或**根層 `defaults.run.shell`** 在外層吞掉退出碼\n'
    + '  ・更早的 step 用 `actions/github-script` 把腳本覆寫成 `process.exit(0)`\n'
    + '  ・`run:` 尾端接 `|| true`\n'
    + '⚠️ `types` 少了 `edited` 也會在這裡紅——`pull_request:` 預設事件**不含 edited**，\n'
    + '   少了它就能「欄位填齊拿綠燈 → 編輯說明撤掉欄位 → commit 沒變、綠燈還在」。\n'
    + '要改這道閘，請連同 `GATE_WF_LINES` 一起改——那是刻意的動作。');
});


test('分支保護｜job 名稱跨 workflow 唯一，且與文件逐字相同', () => {
  // ⚠️ 這題防兩個會「永遠卡住合併」的坑：
  //    ①required check 按**名稱字串**比對——改了 name 沒改分支保護＝等一個永遠不會出現的 check。
  //    ②GitHub 要求 required job name 在所有 workflow 之間唯一，否則有歧義（Codex #382 r2 Low）。
  const doc = read('docs/GitHub分支保護-設定與驗證.md');
  // ⚠️ **這裡刻意不解析 YAML**（Codex #382 r4 Low；那支迷你讀取器已於 #586 刪除）：它只夠讀我們自己寫的
  //    `collab-fields.yml`（不支援 `run: |` 多行純量、anchor…）。拿它去掃**所有** workflow，
  //    等於哪天有人在無關的 workflow 寫了一個 `run: |`，整套測試就紅——
  //    考題不該對它管不著的檔案設下格式限制。名稱盤點只要「job 層的 name:」，用正則就夠。
  /** @type {string[]} */
  const names = [];
  for (const f of readdirSync(join(ROOT, WF_DIR)).filter((f) => /\.ya?ml$/.test(f))) {
    // 縮排不寫死四格（Codex #382 r5 Low）：合法 YAML 可以用別的縮排。
    // `- name:`（step 的名字）因為 `name:` 前面有 `-` 而自然不會命中——只有 job 層的 key 會。
    for (const m of read(`${WF_DIR}/${f}`).matchAll(/^[ \t]{2,8}name:\s*(.+)$/gm)) names.push(m[1].trim());
  }
  assert.ok(names.length >= 3, `只解析到 ${names.length} 個 job 名稱，預期至少 3 個：${names.join('｜')}`);
  assert.deepEqual([...new Set(names)].sort(), [...names].sort(),
    `有跨 workflow 撞名的 job：${names.join('｜')}\nGitHub 的 required check 按名稱比對，撞名會產生歧義並可能卡住合併。`);
  for (const n of names) {
    assert.ok(doc.includes(n),
      `分支保護文件裡找不到 job 名稱「${n}」。\n`
      + '兩邊名稱走散時，required check 會變成「等一個永遠不會出現的 check」＝永遠卡住合併。');
  }
});

test('分支保護文件要記下「enforce_admins 必須開」與它的理由', () => {
  const doc = read('docs/GitHub分支保護-設定與驗證.md');
  assert.ok(doc.includes('enforce_admins'), '文件沒提 enforce_admins');
  assert.ok(/逃生門.*強制力|強制力.*逃生門/.test(doc),
    '文件沒記下那一課：**單一身分下，逃生門與強制力是同一個開關**。\n'
    + '關掉 enforce_admins 不只 William 能繞過——三方共用同一個 token，'
    + '等於我們每天的每一次操作都在繞過，規則零強制力。實測當場打臉過（兩個空 commit 直接進 main）。');
});

test('工作區方案（實作常設／審查拋棄）：白名單句庫＋出現次數（改任何一份複本都會紅）＋第 6 題「問法與逾時預設」的承重句', () => {
  // 三代被打穿史：v1 關鍵字→覆寫假綠＋誤擋（r2）；v2/v3 解析式→位置顛倒／逃逸／重複-b／
  // 分號注入／續行覆寫（r3/r4，劃界：解析追不上變體空間）；v4 白名單→r5 抓「只驗存在」：
  // 同一句活兩處、改壞一處由另一處滿足 includes ⇒ v5 改**出現次數精確比對**。
  // ⇒ 特性不是缺陷：改這些指令或承重句＝必先來改本考題（變更必經考題）。
  // ⚠️ 誠實劃界：它證明「白名單句在兩份文件各出現規定次數」，證明不了「別處沒有另立
  //    覆寫段落」（歸審查制度）、也證明不了「執行者真的照做」（歸事後稽核與指派詞）。
  const docs = { 'AGENTS.md': read('AGENTS.md'), 'REVIEW-AND-MERGE.md': read('REVIEW-AND-MERGE.md'), 'CLAUDE.md': read('CLAUDE.md') };
  const count = (hay, needle) => hay.split(needle).length - 1;
  const PINS = [
    ['AGENTS.md', '實作＝常設樹、審查＝拋棄式樹、絕不動主目錄', 1],
    ['AGENTS.md', '一句白話問題＋最多三個選項＋我建議的預設', 1],   // ⚠️ 2026-09-10 拿掉句尾的「＋時限」（William 裁「問了就等我」）   // 第 6 題：問法正本只住一處
    ['CLAUDE.md', '「問法與逾時預設」那顆', 1],
    // ⚠️ **這一段的理由 2026-09-10 換了**（Grok #595 複審後掃）：原本寫「第 6 題最危險的邊界：一條
    //    『沉默就能導致實作甚至合併』的授權」——**那條授權已經不存在了**（William 裁「問了就等我」）。
    //    現在要守的相反：**沉默什麼都不會發生**，所以下面每一句消失都要紅，是為了防「那條授權被偷偷寫回來」。
    // ⚠️ 2026-09-10 拿掉時限之後，「時限＝三天」只活在沿革括號裡、不再是承重句（William 裁「問了就等我」）。
    //    接上來守的是現行那句：
    ['AGENTS.md', '沒有時限、也沒有逾時預設——問了就等他', 1],
    // ⚠️ **這一條 2026-09-10 換掉了**（Grok #595 複審後掃抓到）：舊承重句「不套逾時預設、永遠等他的」
    //    現在**只活在沿革括號裡**，白名單的「恰好 1 次」變成被**歷史句**滿足——那是結構失效：
    //    把現行標題改回舊制、沿革仍引用一次，次數照樣是 1、全綠。⇒ 改釘現行那個標題。
    ['AGENTS.md', '⚠️ **這幾類要特別注意**', 1],
    ['AGENTS.md', '③**任何會讓閘變鬆的事**', 1],
    ['AGENTS.md', '沒有「時限內沒回就當綠」', 1],
    ['AGENTS.md', '⑦**本顆自己的射程與例外清單**', 1],
    ['AGENTS.md', '題目本文中他未反對的前提', 1],
    ['AGENTS.md', '**❓ 貼出後不可編輯**', 1],
    ['AGENTS.md', '不准寫「William 拍板／裁示」', 1],
    // 永遠等他的五類各自獨立釘一句（#577 r2：只釘總標籤與③⑦時，其餘五類同時消失考題仍綠）
    ['AGENTS.md', '①「錢的絕對邊界」整節（含規則 4 的通報：沒回也不得試用）', 1],   // ① 錢的絕對邊界
    ['AGENTS.md', '②**金額口徑**——射程＝下方界線表那一列', 1],   // ② 金額口徑
    ['AGENTS.md', '④「明確指派／指名／特准」型授權', 1],   // ④ 指派型授權
    ['AGENTS.md', '⑤畫面驗收與「他點頭」——不是問句，沒有預設可套', 1],   // ⑤ 驗收點頭
    ['AGENTS.md', '⑥事故通報 ⑦', 1],   // ⑥ 事故通報
    // ⚠️ 這兩顆零次釘的意思 2026-09-10 變了（Grok #595 複審後掃）：正本**已經沒有現行天數**，
    //    「三天」只活在沿革括號裡。所以它們現在擋的是「別的檔案寫沿革時把天數抄過去」，
    //    不再是原本的「正本天數漂到兩處」。
    ['CLAUDE.md', '三天', 0],
    ['REVIEW-AND-MERGE.md', '三天', 0],
    ['AGENTS.md', '`git fetch origin && git checkout -B codex/<分支> origin/main`', 1],
    ['AGENTS.md', '功能分支（`git checkout -B codex/<分支> origin/main`）', 1],
    ['AGENTS.md', '`/private/tmp/codex-review-pr<N>`／`/private/tmp/claude-review-pr<N>`', 1],
    ['AGENTS.md', '釘住受審 commit', 2],
    ['AGENTS.md', '在該 PR 的拋棄式審查樹工作、不 checkout 任何分支', 1],
    // ⚠️ 2026-09-10 三模式表改成角色中立（William 裁「我選乙」）：實作樹那句不再點名 Codex 一邊。
    ['AGENTS.md', '在**自己那棵常設實作樹**走分支與 PR', 1],
    ['REVIEW-AND-MERGE.md', '`git fetch origin && git checkout -B codex/<分支> origin/main`', 1],
    ['REVIEW-AND-MERGE.md', '`git worktree add --detach /private/tmp/<角色>-review-pr<N> <受審commit>`', 1],
    ['REVIEW-AND-MERGE.md', '-C "/private/tmp/codex-review-pr<N>"', 1],
    ['REVIEW-AND-MERGE.md', '先 `git check-ignore -v "<審查樹>/node_modules"` 確認', 1],
    ['REVIEW-AND-MERGE.md', '必須等於**提示詞釘選的受審 SHA**', 1],
    ['REVIEW-AND-MERGE.md', 'git diff origin/main...HEAD', 2],
    ['REVIEW-AND-MERGE.md', '不帶斜線＝只刪 symlink', 1],
    ['REVIEW-AND-MERGE.md', '絕不動主目錄', 1],
    // 審查模型＝William 的裁示（2026-09-07）。**這一列守的是「全檔出現幾次」，不是「出現在哪裡」**——
    // 下面那三處只是說明「為什麼現在是三」，不要讀成本題在守它們各自的位置（Grok #580 掃後 6）：
    // 發射指令那一行、「審查模型＝」那一條、以及**他的原話逐字**那一句。
    // ⚠️ 哪天換模型要做**兩步**（少做第二步＝新模型的發射指令從此沒有絆線）：
    //   ①把這一列改成 `['REVIEW-AND-MERGE.md', 'gpt-6-astra', 1]`——只剩他的原話那一處，
    //     守的是「不要去竄改他說過的話」；②另加一列 `['REVIEW-AND-MERGE.md', '<新模型名>', 2]`。
    ['REVIEW-AND-MERGE.md', 'gpt-6-astra', 3],
    // 舊名是 #453 的歷史現場字串（同一位審查者被拆成兩個身分的實例）：**不是活指令、不要跟著改**。
    // ⚠️ **這一列只守「全檔的字面次數」**，射程就到這裡（#580 r1 Medium 實測）：它**不驗那兩處在哪一段**、
    //    也**不驗原話的其他字**。把發射指令換回舊名、同時把歷史字串換成新名，兩邊次數都還對＝本題全綠；
    //    只改歷史字串的 `xhigh`、或改動他原話裡模型名以外的字，也全綠。位置與原話逐字**靠複審的眼睛**，
    //    不靠這一列。它買到的是：單純增刪任一個模型名一定會紅。
    ['REVIEW-AND-MERGE.md', 'gpt-5.6-sol', 2],
    // 「引用網址要寫在最外層」2026-09-08 從合併手冊搬進 AGENTS「留痕」那一顆，**只准住一處**。
    // 這兩顆零次釘就是擋「第二份搬回去」的網（同 `三天` 那兩顆的機制與理由）。
    // ⚠️ 釘共同尾巴而不是新版全句：搬回去的多半是舊措辭（沒有 ❓ 那個字），釘全句會漏掉最可能的那一種。
    ['REVIEW-AND-MERGE.md', '最外層才算數', 0],
    ['CLAUDE.md', '最外層才算數', 0],
    ['AGENTS.md', '審查樹由發射者備與收、**審查者不得自建其他 worktree**', 1],
    ['AGENTS.md', '**審查與實作不可以是同一方**', 1],
    ['REVIEW-AND-MERGE.md', '**審查者不得自建其他 worktree**', 1],
    ['REVIEW-AND-MERGE.md', '**要參考另一支 PR＝請發射者另備一棵釘選的審查樹**', 1],
    ['REVIEW-AND-MERGE.md', '**缺＝備樹失敗，停下回報、不要自行 `npm install`**', 1],
    ['AGENTS.md', '由發射者備樹時建、收尾時 unlink，審查者不得自行建立／安裝／移除', 1],
    ['CLAUDE.md', '正式審查的 symlink 一律由發射者備樹時處理', 1],
  ];
  for (const [file, pin, expected] of PINS) {
    const got = count(docs[file], pin);
    assert.equal(got, expected,
      `${file} 的白名單句「${pin}」出現 ${got} 次（規定 ${expected}）——`
      + '要改指令或承重句，先來改本考題的句庫與次數（變更必經考題）');
  }
});

// ⚠️ 為什麼要有這一題：「⭐ 逾時預設那一顆」那道結構考題擋的是「用標題把本節換一個爸爸」，
//    而它**最便宜的漏洞是兄弟段落**——在界線表正下方寫一句可見的粗體「以上整節已作廢」。
//    那一刀不經過標題、也不是祖先容器，所以結構掃描擋不到，**換一個 Markdown 解析器也擋不到**
//    （它在 DOM 上是兄弟，不是祖先）。#578 r6／r9 各實測過一次，全綠。
//    ⇒ 換一條軸：**不看結構，只數字眼**。把「作廢／廢止」在規則書裡的出現次數釘成定值，
//    次數一改就叫一聲，訊息請人去看那個字是不是指著「問法與逾時預設」那一節。
test('⭐ 作廢字眼絆線：規則書裡「作廢／廢止」的次數釘成定值，**次數一改**就要有人看一眼', () => {
  // ⚠️ 這是**絆線，不是閘**：
  //   ・它**不判斷**那個字指的是哪一節——判不出來，也不該在這裡長出第二份判斷。
  //   ・它**擋不住換句話說**：實測「本節僅為歷史紀錄」「已不再適用」都不含這兩個詞，照樣全綠。
  //   ・它**擋不住純 `<blockquote>`／`<details>` 包起來**（那兩種可以一個作廢字都不寫）。
  //   ・它數的是**字面字元**：用 HTML entity 寫的 `&#x4F5C;&#x5EE2;` 在畫面上是「作廢」，這裡數不到（#578 r10）。
  //   以上四項是**照實列的射程邊界**，不是漏掉。它買到的是：最常見、最便宜的那一刀會出聲。
  // ⚠️ 判準是 `assert.equal`＝**次數改變**就紅，不只是變多：少一次代表有人刪掉了現有的作廢語句，
  //   那同樣值得看一眼（Codex #578 r10 Low：題名原本寫「多一次就紅」，與實作不符）。
  // ⚠️ 誤叫的代價很低而且看得見：正常編修真的多寫一次「作廢」時，就是回來把數字加一，
  //   那一行改動會出現在 diff 裡讓複審看到——這正是絆線該有的樣子。
  //   刻意只收這兩個詞：同族的「失效／舊制／舊版」在本檔出現得更頻繁，收進來只會把誤叫變多。
  //   ⚠️ **不可以再說「反正那道結構考題會擋住」**（#578 r16 Low③）：實測在界線表**後面**插一句可見的
  //   兄弟散文（例如宣告整節失效），逐字釘住那一段一字未動、祖先鏈也全對，結構考題照樣全綠。
  //   ⇒ 換句話說的那一族**兩道考題都擋不到**，真正在守它的是複審者的眼睛。這是照實劃界，不是漏掉。
  const agents = read('AGENTS.md');
  const count = (/** @type {string} */ hay, /** @type {string} */ needle) => hay.split(needle).length - 1;
  for (const [word, expected] of [['作廢', 12], ['廢止', 5]]) {
    const got = count(agents, word);
    assert.equal(got, expected,
      `AGENTS.md 裡「${word}」出現 ${got} 次，本題釘的是 ${expected} 次——`
      + '請去看那個字是不是在講「問法與逾時預設」那一節（例如「以上整節已作廢」這種句子）。'
      + '確認無關就把這裡的數字改成新的次數，改動會留在 diff 裡讓複審看到。');
  }
});

test('⭐ 逾時預設那一顆：**整節逐字**（從「審查回饋處置」那行到界線表整張表的末尾，一行不差）＋**整條祖先標題鏈**逐字——節內插一句「以下作廢」、往界線表插一列作廢、改擁有標題自己的後半、或在鏈上任何一段插標題把整節收進作廢小節，都會紅', () => {
  // 這一族被反覆打穿，每一輪的修法都只把釘的邊界往外挪一格，下一刀就站到新邊界外面：
  //   數子字串（#578 r1）→ 比一小段（r2）→ 切掉左前綴（r3）→ 只釘規則那一顆（Grok 掃後：末尾補一句、參考定義）
  //   → 釘那一顆＋前後緊鄰（r5：節內更前面插一顆「以下作廢」的同層項目、把界線表那行的後半改成作廢宣告）
  //   → 釘整節（r6：界線表那行與它的表格之間插一句可見的粗體作廢句；本節前面插 `#### 以下整節已作廢`）
  //   → 釘到表頭分隔行、只逐字比對直接的擁有標題（r7：改擁有標題自己的括號後半、擁有標題**上面**插 H2、往表格插一列）。
  // 前七輪每一次修法都只把邊界往外推一格，於是下一刀就站到新邊界外面。這裡改成兩件事：
  //   ①**一段連續的字**：從「**審查回饋處置（」那一行到界線表整張表的末尾（含收尾空行）逐行等值、依序、無增無減
  //     ——那張表就是「判準／金額口徑／架構」三個詞的定義，本來就是這份安全契約的一半，往裡面插一列、改一列都會紅；
  //   ②**整條祖先標題鏈**（見下面 CHAIN）：鏈上每一行逐字、H1 是全檔第一個標題、鏈上每一段不得插進會搶走下一層的標題。
  //
  // ⚠️ **射程逐條列出來，不宣稱完整（同族連續多輪之後，射程在此封頂）**。
  //   上一版寫著「ATX／Setext／raw HTML 三種是**完整集合**」「這一項是**封閉**的論證」——那兩句撐不住，
  //   #578 r9 各用一刀打掉：跨行的 `<h4\n class="x">`（單行正規式抓不到）、`<blockquote>` 把整節包起來（**完全不經過標題**）。
  //   撐不住的保證比缺口更糟，所以改成逐條寫清楚：
  //   **擋得到**：節內任何一個字改動／往界線表插一列或改一列／節前插 `#### …`／擁有標題**上面**插 `## …`／
  //     改擁有標題自己的括號後半／檔頭上面再插一個 `# …`。（標題只認 ATX，見下。）
  //   **擋不到**（實測全綠，照實列）：①界線表正下方插一句可見的粗體「以上整節已作廢」（**兄弟段落**，
  //     不是祖先容器，所以連換 Markdown 解析器也擋不到；這一種由「⭐ 作廢字眼絆線」接，但只接**字面**那兩個字）
  //     ②`<details><summary>已作廢</summary>` 把整節收摺 ③`<blockquote>` 把整節包起來
  //     ④**Setext 標題**（下一行畫 `---`）與 ⑤**raw HTML `<hN>` 標題**——**William 2026-09-07 裁示明講擋不到**
  //       （原話逐字「照你新講的做」，落點＝#578 裡他的留言；依據＝量過這幾份規則文件的現況：ATX 是唯一在用的標題寫法，那兩種**一個都沒有**（量法：逐行掃三種標題形狀；數字會漂所以不寫），
  //        而 #578 那幾輪**關於標題解析**的 High 出在那兩種上，沒有一條跟 ATX 有關——其餘 High 是別的形狀
  //        （不經標題的容器、HTML entity、未結待裁），不在這句的射程裡；上一版寫「全部」是把它們一起算進來了，
  //        那句話不成立（#580 r1 Low）
  //     ⑥**行中開啟的 raw HTML 容器**（`<div>`／`<span>` 在本節前開、本節後才關——不是標題，鏈看不到）
  //     ⑦**用 HTML entity 寫出來的字**（`&#x4F5C;&#x5EE2;` 在畫面上就是「作廢」，但絆線數的是字面字元）
  //     ⑧**容器裡的 ATX**（`- #### …`／`> #### …`）——它其實會渲染成標題，但**容器裡的標題只能
  //       重新分配那個容器內部的內容**，而本節不在任何容器裡，所以它換不走本節的爸爸（#578 r13）
  //     ⑨離本節更遠的散文。
  //   **反方向（可能假紅，一併照實列）**：判準**刻意不做隱藏區掃描**，所以圍欄或 HTML 註解裡
  //     長得像 ATX 的行會被當成標題。理由與量測在 `test/helpers/markdown-heading.js` 的檔頭：
  //     那些例外規則在這份檔案的整部歷史上守到的量是 0，卻是幾乎每一條 High 的來源
  //     （「看起來像隱藏區、其實不是」與「落單記號讓後面整片靜音」）。**假紅是紅的、看得見、
  //     一行就能修；靜靜放過不是。** 清單續行裡縮排 1〜3 格的 ATX 同理（歷史 0 次）。
  //   ⇒ 這一族**到此封頂**：再出現新形狀一律進待辦，不再往外補。理由不是它們不重要，是那幾輪的實證顯示
  //     「猜 GitHub 會怎麼渲染」這條路不會收斂，而每補一格都同時帶進假紅的風險。
  // ⚠️ 但**不要把「擋不到」讀成「沒人在看」**：上面那些刀**每一刀都是複審抓到的**，機械閘一刀都沒抓到。
  //   真正在守這件事的是複審者的眼睛；本題守的是它看不到的那一半——**用標題換爸爸**那一類在 diff 裡
  //   只會顯示不相干的前後文，安全契約一個字都不出現，人最容易滑過去。這正是它值得留著的理由。
  //   ⇒ 上一版寫「文件層級的整份作廢要靠人在 diff 裡看見」——方向講反了，一併改口。
  // ⚠️ 另一半的網在「⭐ 作廢字眼絆線」那一題（不看結構、只數字眼），專接①②③這種兄弟散文。
  // 代價：這一節的任何一個字改動都要回來改這裡。這一節是安全契約（誰拍板／值不值得改／怎麼問與沒回怎麼辦），那正是要的。
  // 歸屬：William 2026-09-06 的兩項裁示（「先做」含合進 main、判準與架構都在射程內；落點＝#578 裡他的留言）
  //   寫在「問法與逾時預設」那一顆的前兩行；正本裡「弱化會進三關／CI 的考題通過條件仍屬③」那一句寫明它是 Claude 的劃界、不是他的話。
  const lines = read('AGENTS.md').split('\n');
  const SECTION = [
    '**審查回饋處置（誰拍板／值不值得改／怎麼問與沒回怎麼辦，2026-08-05 立、2026-08-14 補上「誰拍板」那一半、2026-09-06 補上「問法與逾時預設」）**：這些是**分開的判斷**，混在一起講會走回無限迴圈。',
    '',
    '- **誰拍板＝在磨的那一方（＝這一支的實作者）**。**不是**「審查者說了就改」，也不再是「每一項都先問 William」。〔2026-09-10 之前這裡寫死「Claude」。⚠️ **不要寫成「因為一直都是他實作」**（#594 r1 Low 用紀錄反證：#357、#370 早在 2026-07／08 就是 Codex 實作、Claude 複審，那兩支還是模式③的前例）——照實說：**舊條文是照 Claude 的常態分工寫的，沒有涵蓋 Codex 實作**；當初為什麼寫死那個名字，紀錄裡查不到。William 2026-09-10 裁（原話逐字）「如果Codex 實作，Claude審查，那應該由Codex判斷要不要接那審查結果。」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/594#issuecomment-5614886728。〕⚠️ **這不是「被審的人可以不理會審查」**：作者只決定「這一條要不要動手」，決定不了「這一支能不能過」——合併前那道複審結論閘要的是**針對目前這一版的「通過」、而且沒有未撤銷的阻擋**，審查者維持阻擋就合不了。⚠️ **但這一句只管那道閘的輸入，不等於「審查意見不會被忽略」**（Grok #594 複審後掃收窄）：**有三條路機器完全不擋**——①意見寫在「通過」裡、沒下阻擋（那張通過對這一版仍有效，作者不跟也不必再審一輪）②「通過」之後才發現的問題（除非審查者回頭改下阻擋）③照下面「值不值得改」判成待辦、**而審查者沒有因此維持阻擋**（⚠️ **這個但書是必要條件**——Codex #594 r7 Low 直接餵正式判斷函式證過：作者留言說「這條判成待辦、本支不修」**不會**消掉既有的阻擋，只有同一位審查者在更高輪次改下「通過」才會清空。所以③不是「判成待辦就不擋」）。⇒ **這一句證得到的是「作者的處置自己撤不掉阻擋」**；審查意見會不會被落實，仍取決於審查者要不要繼續擋，不取決於這一句自己。⚠️ **Codex 實作時，它自己在它的桌面 session 直接問 William**（他用 Codex 桌面派工，有直接管道；2026-09-10 他講的，Claude 不轉述）——但**留痕仍要照下面「留痕」那一段貼到該 PR 上**，因為開工時印「問了還沒回」的那支工具掃的是 PR 留言、**看不到桌面上的對話**。',
    '  ⚠️ **例外——這三種情況一律停下來問 William，不可自己拍板**（William 2026-08-14 裁示；**怎麼問、他沒回怎麼辦＝下方「問法與逾時預設」那顆**（⚠️ 2026-09-10 起答案是「等他」，沒有時限））：',
    '  1. **在磨的那一方自己不確定**該不該照審查者的建議改',
    '  2. 動到**判準**或**金額口徑**',
    '  3. 動到**架構**',
    '',
    '  ⚠️ **上面這三條是唯一真相，repo 其他地方一律指過來、不複述。**',
    '  （這條規則起初在六個地方各寫了一份，`Codex #457` 連三輪抓到不同份各自漏了不同的一項——',
    '  第 2、3 條寫了卻漏掉第 1 條，是其中最危險的一種漏法：**看起來完整，實際上少一個守備範圍**。）',
    '  第 2、3 條的兩個詞哪些算、哪些不算＝下方**界線表**。',
    '- **值不值得改**：**審查回饋不無條件全改**。只有三種情況才回頭改——①**考題其實沒在守它宣稱的東西**（假綠）②**註解／題名說了撐不住的保證** ③**真的產線 bug**。其餘一律寫進待辦，**不再為它多開一輪審查**。',
    '  ⚠️ 理由是實際踩過的跑步機：一改就推翻上一輪結論、再送審又生出新意見，輪數自己會長。判斷的問法是**「這一輪提的，是使用者會受害，還是考題可以更漂亮？」**——後者就收手、寫待辦、放行。',
    '  ⚠️ **審查磨太久時回頭問自己的兩款（一條兩款）**（William 2026-09-11 裁，原話逐字「如果沒有錯，就幫我併成一條兩款，內容不動。」——「如果沒有錯」指他先確認的兩件：自評是第 7 輪過後才貼（規則原文＝第 8 輪起、每 7 輪一則）；自問表是同一件事的第三輪、跟整支審到第幾輪無關——兩件都對；落點＝https://github.com/teacherjung/personal-finance-webapp/pull/599#issuecomment-5630627683）：兩款**各有各的鐘、各管各的事**——**第一款看整支的輪次：第 8 輪起，在磨的那一方在 PR 上公開留一則自評，問的是「還要不要繼續」**；**第二款看同一件事的連續輪次：第三輪起，動手改之前私下答五題，寫進下一顆修正的說明或逐條處置，問的是「做法要不要換」**。第二款正文裡的「本表」＝第三輪自問表。兩款正文照併列前的兩段原文搬入，改的只有款名標籤與互相指路的字（逐字清單在 #599 的說明裡）；款序照原本的段落順序；**兩款各依自己的條件觸發、沒有固定先後**（同一句話若整支第 8 輪才第一次被抓，第一款先到、第二款要到第 10 輪；Codex #599 r1／r3 的反例）。',
    '  **第一款・整支第 8 輪起＝公開自評**：⚠️ 反向的停損也有：**輪數本身不是問題**，磨到有價值可以繼續；但**超過 7 輪就要自己回頭問「是不是方向走偏了」**，而且**在磨的那一方要在該 PR 留一則公開的自評留言**（William 2026-09-10 裁，原話逐字「a＝誰在磨誰貼」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/592#issuecomment-5608775187：**查找鍵＝貼文當下 PR 說明「實作者」欄那一位**（Grok #592 掃後補、Codex r2 收斂：原本只寫兩個例子、不是封閉判準。**中途換人時＝現任實作者承接全部還沒貼的格子**，補貼一律看**貼文當下**那一欄；⚠️ 上一版寫「換手前後各自負責自己那幾格」，那和查找鍵**互相打架**——r8 漏貼、r9 換人之後補 r8，兩條規則會給出兩個不同的人）。常見兩側＝Claude 實作的支 Claude 貼、Codex 實作的支（模式③）Codex 貼，另一方是審查者、照固定維度那一條核——⚠️ **這兩側是 Claude 的操作化**，他裁的只有「誰在磨誰貼」那幾個字。⚠️ **沒有任何機器在看「是誰貼的」**——固定維度那一條的第一款只看**有沒有**對應輪次的留言，**審查者代貼一則也會過**（⚠️ 事後用眼睛翻紀錄仍看得到那則的內容，只是機器不看；原句寫「沒有任何東西」過寬，Grok #592 掃後收窄）。〔沿革：#592 當時**還沒加**角色欄，理由寫成「多釘一個欄位只是把形式再加一層」——Grok #592 掃後推翻（結論留言的標頭本來就在用「角色＋來源」自報，同樣是自報、同樣擋不住冒名，卻仍然要求寫），當時記成待辦；**2026-09-10 William 裁 a，已經加上去了**——就是本條的第一行格式（Codex #593 r2：原本寫「上面那個」，方向指反了，那個格式在本句後面）〕）（第一行固定「🧭 自評｜<角色>｜r<輪次>」；內容＝為什麼還要繼續、方向有沒有偏、還剩什麼沒收、預計再幾輪）⚠️ **角色欄 2026-09-10 才加**（William 裁 a，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/593#issuecomment-5613221375）：**合法值沿用結論留言標頭的那一組角色**（單一真相＝`scripts/check-pr-collab-fields.js` 的 `ROLES`，此處刻意不抄名單——⚠️ 沒有任何東西在守這個**指路**還活著，那個名字改掉之後這句會靜靜指空，Grok #593 掃後照實記）。⚠️ **「沿用」＝沿用那一組合法角色的寫法，不是去抄某一則結論留言的值**——抄值會讓自評系統性地自稱成審查者。⚠️ **這一格答的是「誰貼的」，不是職稱**（同結論標頭那節踩過的洞：「獨立審查者」「複審者」都不是角色）。**為什麼加**：這一則以前**第一行**看不出是誰貼的（內文本來就看得到）——審查者代貼一則，核對照樣過。加了之後**事後翻紀錄時，第一行就掃得出「自稱」是誰**。⚠️ **它換到的是「可掃的自稱」，不是「可驗證的身分」**（Grok #593 掃後收窄，原寫「零新欄位」也不成立——第一行確實多了一格；沒有新增的是**機械欄位與閘**）。⚠️ **跟結論標頭那一格不同**：那一格會進解析器（不是合法角色、整則標頭作廢），**自評這一格沒有任何解析器在檢查它填得合不合法**（⚠️ 但**不等於「填錯不會有東西叫」**——Codex #593 r5 實測：角色格填成職稱之類的字，會命中待裁清單工具的近似標頭偵測，它會印「形狀不合、我沒算進去的」，退出碼仍 0）。⚠️ **也別讀成「填什麼都不影響」**（r3／r4／r5 連三輪實測，每一輪都是我把話說寬）：複審結論閘的壞標頭偵測**掃的是整則、不是第一行**——它用**逐行正則**刪掉它認得的 fenced 區塊、`>` 引用行與行內反引號，**剩下的文字裡出現 🤖 就會咬住**（在「已有正式通過」的情況下退出碼由 0 變 1）。⚠️ **那個剝除是簡化辨識、不是完整 Markdown**：雙反引號包住而裡面又有反引號、引用的續行、巢狀圍欄，實測**都仍然咬得住**——所以「包起來就沒事」是假的。⇒ **自評裡不要放那個記號**——這是**寫作要求、比機器嚴**，不是機械保證。⚠️ **擋不住冒名**：三方共用同一個 GitHub 帳號；**也沒有任何機器在比對**它跟 PR 說明「實作者」欄一不一致，**代貼一則照樣算有貼**（Grok #592 掃出、William 2026-09-10 裁加欄，理由與劃界都照實留在這裡）——**第 8 輪起、每 7 輪一則**：**應貼的輪次＝除以 7 餘 1 且 ≥ 8 的那些**（8、15、22、29…）。⚠️ **格子固定、不隨實際貼文移動**：漏貼晚補、或自願多貼，都**不順延**下一格；「輪次」＝結論留言標頭那個 `r` 值（William 2026-09-10 裁 a，原話逐字「a＝每再超過七輪就再留一則（第 8、15、22 輪；我建議）」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/590#issuecomment-5605696747 ；⚠️ **餘數寫法、往後無限延、以及「不順延」都是 Claude 的操作化**——他的原話只到那三個序數；本句原本還有一句「一則只交代到貼它的那一輪為止」，Grok #590 掃後判定那是**修辭**（沒有可違反的行為、沒有下游），而且它自帶第二套起算點、與上面的固定格子打架，已刪）⚠️ **這條不是剎車，照實說**：**沒有任何東西要求後一則與前一則有實質差異**——把上一則改個輪次再貼一次，字面上仍然合規；而且「輪數本身不是問題」仍在上面那半句，所以**每 7 輪貼一則、輪數照樣長到三十輪，全程都可以合規**。它保證的只有一件事：**那則留言**在紀錄上定期出現（⚠️ Grok #591 掃後收窄：原寫「『有沒有停下來想』定期出現」——出現在紀錄上的是一則有固定開頭的留言，不是思考本身）——William 2026-09-09 裁（原話逐字）「要，而且必要，我們避免耗費資源做沒有意義的審查」，落點＝#589 裡他的裁示留言 https://github.com/teacherjung/personal-finance-webapp/pull/589#issuecomment-5603974572 ；沒留＝違反本條——**後果只有紀錄上看得出來**（沒有機器擋、審查者也不會因此下阻擋結論；Grok #589 掃後改口：原句「沒留＝當沒問過自己」是空話，沒有任何下游）。⚠️ 這一則**不是問他、不等他回**：**這一個問題（還要不要繼續磨）仍由**在磨的那一方**自己下判斷、不可以丟回給 William**——他明講過「為什麼一直過不了」不是問他、是問自己；留言只是讓他事後看得到我想過、想了什麼。⚠️ **沒有任何閘用輪次去執行這條義務、也沒有閘去看這則留言**（Grok #591 掃後收窄：原寫「沒有任何閘在數輪數」過寬——複審結論聯集閘**確實**會讀結論標頭那個 `r` 值，拿來比誰新、判同輪相反結論、擋低輪重述洗白，那是**別的用途**）。⚠️ **仍然是自律**（原寫「唯一在看的是審查者」，Grok #591 掃後收窄：那句跟同一句的「全靠自律」自相矛盾）——審查者這一層**沒有簽到**：跨過門檻之後「有跑且都貼了」與「根本沒跑」在紀錄上長得一樣，只有「缺了且被寫進發現」那一種能反證他跑過。**下面這一條加的是機會，不是保證**：`REVIEW-AND-MERGE.md`「固定維度」那節有一條，要它在受審輪次 ≥ 8 時逐一核對每個應貼輪次有沒有對應的自評留言、缺了就列成一條發現（William 2026-09-10 裁「丙 加進發任務單的固定清單。現在做」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/591#issuecomment-5606162871；⚠️ 落在**固定維度**而不是每輪客製那份，是 Claude 的操作化：客製那份要我自己每輪寫進去，會漏）。⚠️ 它（那一列的第一款）**只看有沒有貼**，看不出內容是不是照抄上一則；缺貼也**不是阻擋理由**〔2026-09-09〜10 的沿革：原句寫「請審查者順手核」，Grok #589 掃後改口成「固定核對清單目前沒有這一項」——那兩句先後都是真的，現在這一項真的加進去了〕。',
    '  **第二款・同一件事的第三輪＝答五題**：⚠️ **第三輪自問表（William 2026-09-10 裁，原話逐字「2. 甲」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/596#issuecomment-5621280390 ；他先前原話逐字「我贊成乙。只是我們要怎麼立規矩幫助判斷：審核是不是軍備競賽？何時該換個方法？」「我們是不是該列出一些問題，當超過3輪的時候就問自己一遍，及時糾偏。」）**：⚠️ **先把兩件事分開，這是本表最重要的一句**（Grok #597 複審後掃的總結原話：「這張表攔軍備競賽的力，和拿它擋掉該修的意見的力，**是同一組字**」）——**本表只決定「我的做法要不要換」，不決定「這條意見要不要處理」**。後者照上面「值不值得改」那三種、以及審查者的阻擋，**兩件事不可以混用**。**觸發＝同一道檢查（或同一句話）連續第三輪被審查者抓到**。⚠️ **觸發權不只在我**：審查者說「這是同一件事的第三輪」就算觸發，我**不可以**用「這是新問題」把它拆開躲掉（掃後補：「同一道／同一句話」沒有客觀判準，只給我一個人認定＝我可以隨意併或拆）。**動手改之前先答五題**——①我這一輪是在「多補一種寫法」，還是「換一個問題來回答」？補寫法＝**先停下來重新判斷做法**。②我的檢查是不是在**重做別人已經做好的東西**（畫面怎麼呈現、某語言怎麼讀、某服務怎麼判斷）？是＝永遠追不上，換一個自己量得到的東西。③我想證明的是「**所有**情況都不會…」嗎？有限取樣證明不了「所有」——直接量那個東西本身，或把量到的範圍寫死、其餘照實說不保證。④審查者這一輪要我知道的，是**一件新的事**，還是只是「再想一種」？只是再想一種＝**先停下來重新判斷做法**。⑤我**真正在乎的是什麼**？我的檢查量的是不是那個？⚠️ **「停」停的是這種補法，不是這個問題**（Codex #597 r1 Medium，附歷史反例 #454 r20：上一輪宣告了四個函式、行內路徑卻只查三個，**補齊那一個是正當處置**）。⚠️ **凡是用本表把一條審查意見降級或不處理，不論用哪一題，理由都要寫進逐條處置讓審查者核**（掃後從「只有①④」擴到五題全部——②⑤同樣可以拿來把有效反例講成不必補）；**他可以反駁並維持阻擋**。**常見的四種做法**：**直接量事實**（含「做法本身可行、只是漏了已承諾集合裡的一項」——補齊、並提出能閉合的證據）／**改規則書的寫法讓檢查變簡單**／**整段逐字釘住**／**把守得住的寫死、其餘照實說**。⚠️ **這不是封閉清單**（掃後改；上一版寫「答完只有四種動作」，把本來就正當的處置關在外面）：照審查者的具體修法改、整題拿掉、拆出去另開一支、不改而等審查者自己撤阻擋、**以及寫進待辦**——都照舊可用；**「不屬那三種情況就寫進待辦、不再為它多開一輪」是「值不值得改」的預設，不必問 William**。⚠️ **本表不新增「必問 William」的情況**（掃後改；上一版寫「四個都不適用＝問他要不要繼續」，那與第一款直接打架）：**「還要不要繼續磨」由在磨的那一方自己判斷、不可以丟回給 William**（同第一款）；**一定要問他的清單仍以上面那三條例外為唯一真相**，本表一條都不加。⚠️ **留痕＝寫進下一顆修正的說明**（「第三輪自問：答了第②題，所以換做法」）；**若結論是不改或寫進待辦，就寫進那一輪給審查者的逐條處置**（掃後補：那兩條路上沒有「下一顆修正」，上一版等於在最需要留下判斷的地方沒有落點）。**不另貼留言。**⚠️ **與第一款是兩件事**：本表管第三輪、私下答、寫進 commit 訊息或逐條處置；第一款管第八輪起、公開貼在 PR 上。⚠️ **本表不新增機械閘**：沒有機器依它計數或檢查答案，漏答、漏留痕本身不構成審查阻擋。**真正會擋下合併的是審查者維持阻擋**（掃後補：上一版漏了這條主路徑，只列了兩件不相干的）；既有的複審結論閘讀的是結論標頭那個輪次值、與本表無關；而「問他」那條路走的是「問法與逾時預設」那一顆，**那一顆自己就寫明它不是閘**。⚠️ **`REVIEW-AND-MERGE.md`「固定維度」那一列的第二款**，要審查者核「用本表降級的那幾條，理由有沒有寫進逐條處置」——掃後補：不加的話，審查者跑固定維度不會被要求去核，而三輪之後搬出這張正式的表，社交上會讓他更難繼續擋。〔⚠️ **下面是事後推論，不是「一定會叫停」的保證**（Codex #597 r1 Low 收窄，它逐支去讀了留言核對）：#454（審到 r23）第①題在 r10 前後**可能**叫停——但 r10 本身是從畫面文字換到另一條通道，照①④我**也可能**判成「新的一件事」；#578（**取樣 r1〜r7，整支到 r16**）事後看得出第③題的症狀在 r2 就有；#596（**取樣 r1〜r4，整支到 r8**）事後看得出第②⑤題的症狀在 r2 就有。⚠️ **本表第三輪才觸發**，所以「第二輪就會叫停」是說錯的。⚠️ **真正的限制**：新問題若不符合「同一道／連續第三輪」，本表**不強制啟動**；**不是**「這些問題幫不上忙」（#596 r7 那次封閉例外清單，事後看①⑤似乎問得到）。⚠️ 另外更正一筆歸因：#596 r8 的那條 Low 是**前一輪的同步尾項沒做完**（落點＝https://github.com/teacherjung/personal-finance-webapp/pull/596#issuecomment-5622393190 ），不是「修正又引入一個新問題」。〕⚠️ **本表沒有考題撐著**：逐字釘住這一段的考題釘的是**文字沒被改**，不是「五題真的問得出問題」、也不是「常見那四種真的窮盡正當處置」——那兩件沒有機器在看（鐵則 10：撐不住的保證不要寫）。',
    '  ⚠️ **但這兩款管的只有「還要不要繼續」與「做法要不要換」**，不影響上面的**第 1 條**：**單一條建議該不該照著改，不確定時照樣要問 William**。兩邊管的是不同的問題。',
    '- **問法與逾時預設（William 2026-09-06 協作系統體檢第 6 題選 a，落點＝#577 裡他的留言；本顆是唯一正本，repo 其他地方只指過來、不複述）**：凡是要「停下來問 William」的**選項題**（上面三條例外、界線表外說不準的、本檔與 `REVIEW-AND-MERGE.md` 其他地方寫「問 William／交 William 裁決」的程序題），一律用**固定形狀**問：**一句白話問題＋最多三個選項＋我建議的預設**。⚠️ **沒有時限、也沒有逾時預設——問了就等他**（William 2026-09-10 裁，原話逐字「a＝拿掉時限，問了就等我」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/595#issuecomment-5617637892）。〔沿革：2026-09-06〜09-10 之間這裡寫的是「**時限＝三天＝連續 72 小時**（用兩則留言的 UTC 建立時間相減、不看日曆日）；**時限內他沒回＝照我建議的預設先做、留痕、他隨時可翻案**」，而「先做」含照常設授權合進 main（William 2026-09-06 裁，原話逐字「「先做」含不含合併：含」，落點＝#578 裡他的留言；問這一題的 ❓ 在 #577）。**他 2026-09-10 把整個機制拿掉**，理由是他自己講的：那是**多一件我要留意的事**，會讓做事分心。⚠️ **所以這一顆的重點不是把天數改大，是「沒回就算同意」這回事從此不存在。**⚠️ **已經貼出去的 `⏳ 逾時暫定` 留言仍然有效、仍然算數**，待裁清單工具照舊讀得懂它們（否則那些早就處理完的題目會整批冒回「還沒回」）；改的是**從今以後不再產生新的**。⚠️ 這一改**只縮不放**：以前「沒回」有兩種下場（等他／照預設先做），現在只剩「等他」——**任何原本要等他的事，改完照樣等他。**〕；翻案＝他一句話（由**問這一題的那一方**轉貼成 ⚖️ 留言；⚠️ 2026-09-10 之前寫死 Claude，而同一顆已經改成兩邊都自己問、自己貼、自己署名——Codex #594 r7 Medium），正本照沿革分層改口，規則與程式裡的「逾時暫定」落款由翻案那支 PR 一併掃掉改口。',
    '  他的原話（對話中，Claude 轉述；逐字）：「**第 6 題：a／一句白話問題＋但最多可以三個選項＋你的建議預設；如果我在時限內沒回，就照你建議的先做、留下紀錄，我之後隨時可以翻案。**」——體檢頁那題的**題目本文**寫「最多兩個選項」「照較保守的預設（維持現狀）」，他改了兩處：**選項上限三個**、**逾時預設＝我建議的那個**；題目本文寫「錢與金額口徑永遠等你」，他選 a 時沒反對（＝**題目本文的前提**，不是他的原話）。⚠️ 上面 08-14 三條例外裡的**判準**與**架構都在射程內**——William 2026-09-06 裁，原話逐字「判準與架構適用」，落點＝#578 裡他的留言；問這一題的 ❓ 在 #577。⚠️ **這一句是 Claude 的劃界、不是他的話**：界線表把「考題的通過條件」也算在**判準**裡，而下面③已經把「弱化會進三關／CI 的考題通過條件」留給他——**那一塊照③、等他**；其餘判準與架構**也一樣等他**（⚠️ 2026-09-10 之前這裡寫「照逾時預設」——時限拿掉之後**沒有逾時預設可照**，所以這一句只剩「等他」一種下場，Codex #595 r1 Medium 抓到），且**照樣要過下面①〜⑦整份清單**（判不出就等他），本句不放寬任何一項。',
    '  ⚠️ **這幾類要特別注意**（⚠️ **2026-09-10 之前這一段的標題是「不套逾時預設、永遠等他的」**——時限拿掉之後「等他」已經是**通則**，所以這張清單不再是「例外」；它留下來的作用有兩個：**③⑤⑥ 說明這幾類連「選項題」都不是**，不要硬套三選一的形狀；**①②④⑦ 是強調**，不是例外。原本的歸屬照記：①②＝題目本文中他未反對的前提；③〜⑦＝Claude 的保守劃界、他可放寬）：①「錢的絕對邊界」整節（含規則 4 的通報：沒回也不得試用）②**金額口徑**——射程＝下方界線表那一列（含「純顯示格式也算」），不另寫定義 ③**任何會讓閘變鬆的事**：機械閘紅了＝「停下來回報」，不是選項題，沒有「時限內沒回就當綠」；放寬、關掉、豁免任何一道閘、弱化會進三關／CI 的考題通過條件、或**關掉重開 PR 以脫離閘的阻擋**（壞標頭長到平台上限那條已裁的最後手段除外，見「三條規則」節），同樣等他 ④「明確指派／指名／特准」型授權（模式③實作、Grok 承接新工作、豁免宣告）——沒回＝沒授權 ⑤畫面驗收與「他點頭」——不是問句，沒有預設可套 ⑥事故通報 ⑦**本顆自己的射程與例外清單**——沒回＝維持現狀（體檢頁明寫這是授權擴張、要他親口同意；⚠️ 2026-09-10 之前這一項還含「時限」，時限已經拿掉了——而**拿掉它本身就是他親口裁的**，符合本項要求的門檻）。判不出屬不屬於上面任一項＝當它屬於、等他（同界線表架構列的兜底方向）。',
    '  **留痕（可查證的形狀，鐵則 10 之下；前例＝#571／#573／#576 的裁示留言）**：問的當下貼一則留言到**這個問題所屬的 PR**（沒有所屬 PR 的題＝貼在提出它的那支 PR；沒貼＝沒起算，不為了起算時鐘開新 PR——上方「授權仍不含」那句照舊），第一行固定 `## ❓ 待裁（YYYY-MM-DD）：〈一句白話問題〉`，內文＝選項／我建議的預設／類別聲明（非錢、非金額口徑；屬上面哪一類）〔⚠️ 2026-09-10 之前這裡還有一欄「／時限」，已經拿掉——Codex #595 r1 Medium 抓到〕——GitHub 的建立時間就是發問時間（伺服器蓋章，不手寫）；**❓ 貼出後不可編輯**（改題＝另貼一則新 ❓、重新起算；複審核對時看 `includesCreatedEdit`／`lastEditedAt`，有編輯痕跡＝那則不算起算）；六段「要你裁示的」照常問他、並把 ❓ 的網址寫在那一點裡（他不看 GitHub，留言是給查證用的；六段問的當天貼，貼在已關閉或不相干的 PR 不算起算）。結局**兩選一，外加一個只讀不寫的舊類**（⚠️ 2026-09-10 之前是三選一；拿掉時限之後 ② 不再產生新的，只保留讀舊的能力）：①他回了＝貼 `## ⚖️ William 裁示（YYYY-MM-DD）：〈標題〉`，內文第一段**逐字照下面那一行填**（⚠️ 只換角括號裡的字，**前後不要再加任何字**——Codex #594 r2〜r4 連三輪實測：角色包粗體／包底線／包反引號、或在整行前面多一個字、多一個引用符號，解析器都會判成形狀不合，那則裁示就永遠留在「還沒回」；⚠️ **下面那一行樣板才是這一欄的唯一正本**——本括號只講「為什麼」與踩過的形狀，形狀本身一律以那一行為準。Grok #594 複審後掃指出：同一節裡有兩處在描述同一欄，兩處走散時沒有任何東西會叫）（⚠️ 2026-09-10 #594 r1 之前這裡寫死 Claude；**Codex 實作的支由 Codex 自己問、自己貼、自己署名**，解析器改成收合法角色——**如實署名，不要為了過解析器假稱是別人轉述的**——⚠️ **這是寫作要求、比機器嚴**：三方共用同一個 GitHub 帳號，解析器只驗**形狀**，驗不了署名的是不是本人（同結論標頭那一格的老問題）。**「改成收合法角色」證到的只有「這三個名字都填得進去、別的名字填不進去」**，證不到「只有實作者該署名」——那一半沒有任何機器在看，Grok #594 複審後掃照實記）、**貼的那一方**的附註另段（⚠️ 同上，2026-09-10 之前寫死 Claude）；②**（已停用，只讀不寫）**`## ⏳ 逾時暫定（YYYY-MM-DD）：〈同一句問題〉`——⚠️ **2026-09-10 起不准再貼新的**（他把時限拿掉了：沒回就是等他，沒有「先做」這條路）。**舊的仍然有效、仍然算數**：待裁清單工具的**解析器**照舊認得 ⏳ 這個形狀（把它從解析器拿掉，那些早就處理完的題目會整批冒回「還沒回」——所以不准拿掉）。⚠️ **但解析器沒有在驗日期**：今天貼一則合規的 ⏳ 照樣會被收下。**「不再有新的」是這條規則在保證，不是機器擋得住**（Codex #595 r1 Low 實測後照實寫）。舊格式照記，供讀舊留言與翻案時對照：內文＝授權依據（本顆＋#577 那則 ⚖️ 留言的連結）／❓ 留言的連結／逾時判定（兩則留言的建立時間相差 ≥ 時限，不手寫時刻）／照哪個預設做了什麼（PR 編號，或「維持現狀、沒動」）／「William 未裁、隨時可翻案」；③**題目已經沒有對象可以回答**＝貼 `## 🚫 撤回（YYYY-MM-DD）：〈同一句問題〉`，內文＝`撤回理由：` 加上**三種之一**（`題目依附的東西沒了`／`問題本身問錯了`／`跟另一則 ❓ 重複`），類別後面**必須**接一個全形括號的說明、而且括號裡要有字（**寫具體依據**：關掉的是哪一支、跟哪一則重複——那正是他用來推翻這次撤回的材料，報告會連同類別一起印出來）／自報一句 `<撤回者> 撤回、William 未回；他隨時可以要我重問`（⚠️ **只換角括號裡的角色、其餘逐字**；合法角色沿用上面原話欄那一組——2026-09-10 Grok #594 複審後掃補：原本這裡逐字寫死 Claude，而發問與貼 ⚖️ 已經改成兩邊都做得到，於是 Codex 實作的支只剩兩條路——**假稱是 Claude 撤的**，或**撤了不算數、那題永遠掛在「還沒回」**）／❓ 留言的連結。⚠️ **撤回是三種結局裡唯一由發問的那一方單方面發動的**，所以只准用在「已經沒有對象可以回答」；**不可以**用在「我自己決定了」「等太久了」「我覺得不重要了」——那幾種一律**繼續等**（⚠️ 2026-09-10 之前這裡寫「一律走 ⏳ 或繼續等」；⏳ 已經不准再貼新的，所以只剩「繼續等」，Codex #595 r1 Medium 抓到）。挑不出上面三種理由的，就不是撤回，回去問他。撤回過的題目**照樣印在開工清單上**（自成一段、附理由），他隨時可以叫發問的那一方重問；他若直接貼一則 ⚖️（**網址一樣要寫在最外層才配得上**），那一題就是已結——**他的話比我的撤回大**；配不上的結尾留言，**只要它原文裡出現過某一題的網址**，就會另外印成一段「配不到任何一題」；⚠️ 連網址都沒寫的那種我無從得知，不會出現在任何一段——那是照實劃界，不是保證。（第三種結局＝William 2026-09-08 裁，原話逐字「補「這題不用問了」這種收法」；三種理由、「不可以用在哪裡」與那兩句固定字樣是 Claude 的操作化、不是他的話。）⚠️ **引用 ❓ 網址必須寫在留言最外層才算數**——William 2026-09-07 裁，原話逐字「a」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/579#issuecomment-5570875993 。**他裁的就是這一句**；下面「哪些寫法算最外層」是 Claude 依既有工具行為做的操作化、不是他的話：頂層那一行算（行首有 `- ` 清單記號的那一行本身也算）；放進引言（含引言底下那種零縮排的續行）、縮排區塊（含清單項底下的續行）、圍欄或 HTML 註解都**不**算。認不得的後果是那題留在「還沒回」，不會誤判成已結；⚖️／⏳／🚫 都適用。⚠️ ❓／⏳／⚖️／🚫 **整則留言不得出現 🤖**（複審聯集閘剝掉 fence、`>` 引用與行內反引號後掃整則、不分作者；引 Codex 的發現一律放 `>` 引用或反引號、去掉標頭——閘若哪天連引用裡的也算，這條要跟著改）。**規則正本與程式註解的落款一律寫「逾時暫定（依 William 2026-09-06 體檢第 6 題授權，落點＝#577；未經他裁、可翻案；留言＝〈⏳ 留言網址〉）」，不准寫「William 拍板／裁示」**（鐵則 10）。逾時暫定**不進** `PROJECT.md`「重要決定（已拍板，勿重議）」；逐筆紀錄只住 PR 留言、不另養清單。**❓ 未結且影響本支＝本支不合**（⚠️ **沒有出口**——2026-09-10 之前這裡寫「時限到了才依 ⏳ 走」，時限拿掉之後那條出口沒了：影響本支的 ❓ 沒結，本支就是不合，等他。Codex #595 r1 Medium 抓到）。⚠️ **這一條贏過合併的常設授權**（Grok #595 複審後掃抓到兩套現行指示撞車：以前它們是靠逾時那條路接起來的——等滿、貼 ⏳、「先做」含合併；出口沒了，接縫就露出來）：**常設授權的意思是「不必再問他要不要合」，不是「可以當那一題不存在」**。影響本支的 ❓ 只要沒結，**就算獨立審查者已經給了通過、掃也做完了，也不合併**。⚠️ **「未結」是什麼意思，寫清楚**（Codex #595 r6 Medium：不寫的話有兩種相反讀法）：**未結＝那一題沒有拿到任何一種有效處置**。有效處置有三種——①他回了（⚖️）②合規的撤回（🚫）③**停用前依舊制合法成立的 ⏳**。⚠️ **第③種的效力這一顆不回頭收回**：那是他當時**預先授權**過的，照那個預設做掉的事（含當時那條「先做」含合併）**維持有效**；這一顆改的是**從今以後不再有這條路**，不是追溯撤銷已經走完的。⚠️ **2026-09-10 之後才問的題只剩 ①② 兩種處置**——沒有 ⏳ 可用，所以對新題而言「沒結」就真的只有等他。⚠️ **不要拿工具印的數字代替這個判斷**（Codex #595 r6 明講）：那支工具會把**停用後才貼的** ⏳ 一樣收進「照預設先做過」那一堆（它沒在驗日期），所以「工具說沒有還沒回的」不等於「沒有未結的題」。〔照實記一筆現況：2026-09-10 拿掉時限的當下實跑，「還沒回」與「照預設先做過」**都是零則**——這是事實紀錄，不是上面那條規則的理由。〕⚠️ **照實說後果**：這代表一支 PR 可能因為一題沒回而**無限期掛著**——那正是「問了就等他」這條裁示的直接結果，不是漏洞。（⚠️ 但**不是必然永久無解**，Codex #595 r6 核過：合規的撤回、把範圍調整到那題不再影響本支、或他回了，都解得開；解不開的只有「等太久了」「我覺得不重要了」那幾種——那幾種本來就不准。）⚠️ **也照實說機器**：**沒有任何閘在看這件事**（沒有東西讀 ❓ 有沒有結），全靠按合併鍵的人自己記得；開工時那支印「問了還沒回」的工具是唯一的提醒，而它**不是閘、不擋任何事**。；不影響本支的（純進待辦型）照常。',
    '  **⚖️ 原話欄樣板（逐字照填）**：',
    '  原話（對話中，<轉述者> 轉述）：**「逐字」**',
    '  ⚠️ **誠實劃界**：留言有沒有貼、類別有沒有分對——**沒有任何閘在看**（⚠️ 2026-09-10 之前這裡還列了「時限有沒有數到」；**新問題沒有時限可數了**——但**舊的 ⏳ 仍要核對**：查證舊案時，照那一則自己內文寫的逾時判定去核（格式見留痕段的 ② 舊格式）。Codex #595 r2 Medium 要求把射程講清楚），全靠自律＋發射複審時請審查者核對 ❓／⏳ 留言與授權連結；⚖️ 落點本身是**轉述的那一方**從共用帳號貼的、不是他手寫的（既有前例都是 Claude 貼的、Codex 已接受為可查證落點；⚠️ 2026-09-10 之前這裡寫死 Claude，而同一顆已改成兩邊都能署名——Codex #594 r7 Medium。這裡照實寫）。本顆**不是**把決策權移轉（⚠️ **理由 2026-09-10 r8 收窄過**：上一版寫的是「角色表 William 那一列一字不動」，而本支**確實改了那一列**（把一般回饋的判斷權從 Claude 換成「在磨的那一方」並補沿革）⇒ 那項文字證據已經不成立，Codex #594 r8 Low 抓到。**結論仍成立，但改用實際保留的權責當理由**：產品決定、需求優先序、畫面驗收、合併裁決、以及審查回饋那三種例外，一項都沒有移出他身上——動的只有「一般回饋由誰拍板」那一格裡的名字）、**不改變**上方「授權仍不含」那句（依審查結果自行開新題目、按合併鍵）；與下方重述留言「不可預先授權」那句**射程不同**：那句管重述的時序，本顆管的是**怎麼問他、以及沒回怎麼辦**（⚠️ 2026-09-10 之前這裡寫「本顆是他預先授權的逾時規則」——那份預先授權**已經被他自己收回**了：現在沒回就是等他，沒有預先授權可言。Codex #595 r1 Medium 抓到）。',
    '',
    '**界線表（William 2026-08-14 裁定；管上面第 2、3 條）**：只有「判準／金額口徑／架構」三個詞是不夠的——**「不確定就問」擋不住 AI 很有把握地分錯類**（分錯的當下不會覺得自己不確定）。所以界線寫出來：',
    '',
    '| 詞 | **算**（停下來問 William） | **不算**（**在磨的那一方**自己判斷；⚠️ 2026-09-10 之前這一格寫死 Claude） |',
    '|---|---|---|',
    '| **判準** | 「什麼算什麼」的規則本身：分類判準、門檻數字、**考題的通過條件** | 把程式**修回既有契約**——那是修實作，判準本身沒動 |',
    '| **金額口徑** | 金額怎麼算出來、怎麼呈現：元／萬、正負號、四捨五入、含不含稅。**純顯示格式也算** | 與金額無關的文案與樣式 |',
    '| **架構** | ①**模組邊界／資料流向／欄位歸屬，任一有改就算**——新增、移動、**刪除、縮減**都在內（抽成新模組、把函式從模組 A 搬到 B、刪掉一個沒人用的模組、收掉一個 exported 邊界，全部算）②**三維之外，任何改變「程式怎麼跑」的也算**：執行方式、部署、併發、排程、快取層…③⚠️ **判不出來屬不屬於架構時，一律當作「算」** | ①②那些**都沒變**的純內部修改才不算。純搬移只是最常見的例子（同檔搬函式、同模組內拆區塊） |',
    '',
  ];
  const first = lines.findIndex((l) => l === SECTION[0]);
  assert.ok(first >= 0, `找不到逐字相同的「審查回饋處置」那一行：\n  ${SECTION[0].slice(0, 60)}…`);
  assert.equal(lines.filter((l) => l === SECTION[0]).length, 1, '「審查回饋處置」那一行出現不只一次');
  SECTION.forEach((canon, k) => {
    assert.equal(lines[first + k], canon,
      `這一節的第 ${k + 1} 行對不上（多一行、少一行、或改了字）：\n  預期：${canon.slice(0, 60)}…\n  實得：${String(lines[first + k]).slice(0, 60)}…\n`
      + '⚠️ 節內任何位置插字、加一句「以下作廢」、改界線表那行的後半，都會讓這題紅——要改條文，先來改這裡（變更必經考題）。');
  });
  // 用標題把整節收進「已作廢」小節：這一類 r6／r7 各中一輪，形狀一次比一次高——
  //   先是節前插 `#### 以下整節已作廢`，再是**改擁有標題自己的後半**、以及在擁有標題**上面**插一個 H2。
  // 所以這裡不再只釘直接的擁有標題，改釘**整條祖先標題鏈**：`# 檔頭` → `## 協作流程` → `### 三方協作框架（…）` → 本節。
  //   每一段都要求：那一行**逐字**相符、而且它與下一層之間**不得有同層或更高層的標題**。
  // ⚠️ 這條鏈擋的是「用**標題**把本節換一個爸爸」。它**不是**封閉的論證——不經過標題的容器
  //   （`<blockquote>`、`<details>`）與兄弟段落都繞得過去（#578 r7／r9 實測）。完整射程見本題開頭那份清單。
  // **標題只認 ATX**（William 2026-09-07 裁）。Setext 與 raw HTML `<hN>` 明講擋不到，理由與代價
  //   寫在 `test/helpers/markdown-heading.js` 的檔頭；那支另有一張正反例表直接釘住判準。
  // 判準本體抽到 `test/helpers/markdown-heading.js`，那裡有一張正反例表直接釘住它
  //   （#578 r11 Low⑤：原本那幾條修正沒有任何固定夾具守著，退回去也不會有考題叫）。
  const CHAIN = ANCESTOR_CHAIN;   // 與角色分工表共用同一條鏈（同一個 H3 的直屬內文）
  const at = CHAIN.map((canon, k) => {
    const hits = lines.reduce((/** @type {number[]} */ acc, l, i) => (l === canon ? [...acc, i] : acc), []);
    assert.equal(hits.length, 1,
      `祖先標題鏈第 ${k + 1} 層在檔案裡出現 ${hits.length} 次（要剛好 1 次，逐字）：\n  ${canon.slice(0, 60)}…\n`
      + '⚠️ 改了這一行的任何一個字（含在括號裡補一句「以下已作廢」）都會讓這題紅——那正是要擋的（#578 r7）。');
    return hits[0];
  });
  assert.equal(at[0], lines.findIndex((_, i) => headingAt(lines, i) > 0),
    '檔頭那個 H1 不是全檔第一個標題＝它前面被插了東西，本節的歸屬就不是原來那一條鏈了');
  at.forEach((idx, k) => {
    const last = k + 1 === at.length;
    const next = last ? first : at[k + 1];
    assert.ok(idx < next, `祖先標題鏈第 ${k + 1} 層跑到下一層後面去了＝本節已經不屬於它`);
    // 這一段裡什麼樣的標題會「把下一層搶走」？Markdown 的小節從一個標題開始，到**同層或更高層**的下一個標題為止。
    //   ⇒ 中間出現層級 ≤ 本層的標題，本層的小節就在那裡結束，下一層（乃至本節）就不再屬於它。
    //   同層以下的兄弟標題（例如 `## 協作流程` 前面那些 `## …`）不會搶走任何東西，放行。
    // ⇒ 最後一段是特例：本節是那個 H3 的**直屬內文**，所以那一段裡**任何**標題都會把本節切出去（r6 的 `####` 就是）。
    const forbidUpTo = last ? 6 : k + 1;
    for (let i = idx + 1; i < next; i += 1) {
      const level = headingAt(lines, i);
      assert.ok(level === 0 || level > forbidUpTo,
        `第 ${i + 1} 行插了一個 H${level} 標題（「${lines[i].slice(0, 40)}」），`
        + `它會讓「${CHAIN[k].replace(/^#+ /, '').slice(0, 18)}」的小節在那裡結束——`
        + '逐字釘住的那一段一字未動、鏈上每一行也都逐字相符，照樣能在畫面上把本節收進作廢的小節。'
        + '⚠️ **已知的假紅**：如果那一行是**清單項底下縮排 1〜3 格**的標題，它其實在清單容器裡、'
        + '換不走本節的爸爸——這時把那一行改成粗體（或別的不是標題的寫法）即可。'
        + '⚠️ **改成零縮排沒有用**：零縮排的 `#### …` 一樣是標題、一樣被禁（#578 r16 Low①）。'
        + '理由與量測見 `test/helpers/markdown-heading.js` 的檔頭。');
    }
  });
  const section = SECTION.join('\n');
  assert.doesNotMatch(section, /<!--|-->/, '這一節裡出現 HTML 註解——規則不可以被藏成不可見內容');
  assert.doesNotMatch(section, /^ *\[[^\]]+\]:\s/mu, '這一節裡出現 Markdown 參考定義——那在畫面上不顯示，藏得下一句否定'
    + '（真正的參考定義在畫面上不顯示、藏得下一句否定；#585 r3 Medium：原本只收行首 0〜3 格，'
    + '而清單項內容至少縮排四格＝正好躲過，所以不限縮排。'
    + '⚠️ 代價：這裡一律拒收＝比規格嚴——**被拒收的不一定是隱藏的**：縮排夠深的那種會渲染成可見的程式碼文字'
    + '（要縮排到達**相對所在容器**的程式碼縮排才算；清單容器會先吃掉一段縮排，所以光看行首有四格不準——'
    + '#585 r8 實測清單內文裡四格縮排的那種仍然是真正的參考定義）。'
    + '哪天這一節真的需要那種寫法，處置是改這道禁令、不是繞過它——Grok #585 掃後點名）');
});

test('⭐ 第 6 題正本在正式位置：「問法與逾時預設」那顆要在「審查回饋處置」節裡、「界線表」之前，而且承重句都在那顆裡（逐字搬到沿革節＝規則降成沿革，要紅；#577 r3）', () => {
  // 題名關鍵字「工作區方案（實作常設／審查拋棄）」那題只在整份檔案計次——把整顆逐字搬到「### 審查分工的沿革」底下，次數不變、規則卻已經失效（固定維度 2 的「文字存在、結構失效」假綠）。
  const agents = read('AGENTS.md');
  const ruleStart = agents.indexOf('**審查回饋處置（');
  const blockStart = agents.indexOf('- **問法與逾時預設（');
  const historyStart = agents.indexOf('### 審查分工的沿革');
  assert.ok(ruleStart >= 0 && blockStart >= 0 && historyStart >= 0, '三個定位字串都要在');
  assert.ok(ruleStart < blockStart && blockStart < historyStart, '那顆不在「審查回饋處置」與沿革節之間＝被搬走了');
  // ⚠️ **標題的判準全檔只有一份**＝`test/helpers/markdown-heading.js`（William 2026-09-07 裁：只認 ATX）。
  //   這裡原本另外寫了一份（還認 Setext），兩套定義互相矛盾、而且那一份會對正常編修假紅（#578 r13 High①）。
  const hasMarkdownHeading = (/** @type {string} */ text) => {
    const lines = text.split('\n');
    return lines.some((_, i) => headingAt(lines, i) > 0);
  };
  assert.ok(!hasMarkdownHeading(agents.slice(ruleStart, blockStart)), '「審查回饋處置」到那顆之間不可以隔著 ATX 標題——那顆必須還在同一節（判準只認 ATX，見 markdown-heading helper 的誠實劃界）');
  const blockEnd = agents.indexOf('\n**界線表（', blockStart);
  assert.ok(blockEnd > blockStart, '那顆之後要接著「界線表」（同一節的下一顆）');
  const block = agents.slice(blockStart, blockEnd);
  assert.ok(!hasMarkdownHeading(block), '那顆到「界線表」之間也不可以插進 ATX 標題（#577 r4／r5：插一個假標題就把章節關係切斷、把「永遠等他」的例外切出正本）');
  for (const line of [
    // ⚠️ 2026-09-10 拿掉時限（William 裁「a＝拿掉時限，問了就等我」）：句尾的「＋時限」沒了、
    //    「時限＝**三天**」降成沿革（不再是承重句）、「不套逾時預設、永遠等他的」那個小標改寫了。
    //    接上來的承重句是「沒有時限、也沒有逾時預設——問了就等他」。
    '一句白話問題＋最多三個選項＋我建議的預設', '沒有時限、也沒有逾時預設——問了就等他',
    '①「錢的絕對邊界」整節（含規則 4 的通報：沒回也不得試用）', '②**金額口徑**——射程＝下方界線表那一列', '③**任何會讓閘變鬆的事**',
    '④「明確指派／指名／特准」型授權', '⑤畫面驗收與「他點頭」——不是問句，沒有預設可套', '⑥事故通報 ⑦', '⑦**本顆自己的射程與例外清單**',
    '沒有「時限內沒回就當綠」', '題目本文中他未反對的前提', '**❓ 貼出後不可編輯**', '不准寫「William 拍板／裁示」',
    '**❓ 未結且影響本支＝本支不合**', '**整則留言不得出現 🤖**',   // 待裁流程與合併授權的接縫、留痕留言與壞標頭閘的接縫（#577 r4）
    '不為了起算時鐘開新 PR', '逾時暫定**不進**', '建立時間相差 ≥ 時限',   // Grok #577 掃後
  ]) {
    assert.equal(block.split(line).length - 1, 1, `承重句「${line}」不在那顆裡（或不只一次）——在檔案別處出現不算`);
  }
});

// ⚠️ 為什麼要有這一題：鐵則 10（註解寫「為什麼」不寫「現在是」）是 #417 燒掉七輪換來的，
//    而它守的東西**沒有機械閘**（「這句註解會不會過期」機器判不出來）。沒有本題的話，
//    這條規矩就是一段可以被任何人靜靜刪掉的散文——本專案已認過的病型：護欄什麼都沒做卻回報通過。
//    ⇒ 本題的射程只有一件事：**那條規矩還在 AGENTS.md 上、而且三種禁令都沒被抽掉**。
//    本題**不**證明任何人真的照做（那要靠審查者的眼睛）——這是誠實劃界，不是缺口。
test('鐵則 10「註解寫為什麼、不寫現在是」不可被靜靜刪掉（#417 換來的規矩）', () => {
  const agents = read('AGENTS.md');
  assert.ok(agents.includes('註解寫「為什麼」，不寫「現在是」'),
    'AGENTS.md 少了鐵則 10 的標題句。這條規矩是 #417 r7–r13 七輪退回換來的：'
    + '註解裡每一句「現在的狀況是…」都會過期、會誇大、會被下一個人當事實引用。');
  // ⚠️ 只斷言標題會假綠：把三種禁令抽掉、只留標題，規矩就空了（同族突變 2026-08-02 實測過）
  for (const ban of ['別處的現況', '時態相對的敘述', '沒有考題撐著的保證']) {
    assert.ok(agents.includes(ban),
      `AGENTS.md 鐵則 10 少了「${ban}」這一類禁令——`
      + '三種缺任何一種，那一族就會從下一支 PR 開始復發（#417 三種都踩過）');
  }
  // ⚠️ 這裡**不可以**只斷言「誠實劃界」四個字：AGENTS.md 別處（錢邊界那節）本來就有這四個字，
  //    把鐵則 10 的 ✅ 整段刪掉照樣全綠——我自己第一版就是這樣寫的，突變當場抓到（2026-08-08）。
  //    ⇒ 改成斷言鐵則 10 專屬的那句原文。
  assert.ok(agents.includes('唯一鼓勵寫長的一類'),
    '鐵則 10 少了「✅ 可以寫的」那一半。只留禁令會讓下一個人不敢寫誠實劃界，'
    + '而劃界正是本專案唯一鼓勵寫長的一類註解——把它一起禁掉會製造真的缺口。');
});

// ⚠️ 為什麼要有這一題：鐵則 12 是 2026-09-08 從鐵則 7 的**後半**獨立出來的——它會被獨立出來，
//    正是因為躲在一個開頭寫著「已改列下方…」的**空樁**裡，讀的人很容易以為整條都搬走了。
//    獨立之後如果沒有東西釘著，下一次整理清單的人照樣可能把它跟樁一起收掉。
// ⚠️ **只斷言「這幾句話在檔案裡」不夠**：整條逐字搬進沿革節、或在它前面插一個沿革標題，都會全綠
//    ——本專案認過的病型「文字存在、結構失效」（同族＝題名關鍵字「問法與逾時預設」那題）。
//    所以這一題釘的是**結構位置＋逐行逐字**。
//
// ⚠️ **誠實劃界。** 這一段每一句都要為真，所以只寫**這一題自己**做得到與做不到的；
//    這幾代做法怎麼被打穿、為什麼選現在這個、哪些路走不通，全部在 PR #585 的說明裡，**這裡不複述**。
//
//    **擋得到**：整條被搬走、或被切進別的小節；承重句被抽掉、或搬去隔壁那一條；指路離開本節；
//      **任何改動到第 12 條自己那幾行的寫法**（藏進參考定義、腳註、連結 title、圖片 alt、行中 HTML
//      都算——那些都會讓那幾行對不上）。
//
//    **擋不到**（照實列；除非另有註明，都是「本題接不到，也沒有別的東西接」）：
//    ・**這一題讀的是原始檔的文字，證不了那些字在畫面上看得見。** 前後行可以改變解析上下文，
//      讓逐字相同的一行整行不顯示；把承重正文改寫成不顯示的形式並**同步更新** `RULE_12` 也一樣。
//    ・**在白名單最後一行之後追加一行「條界會早切」的內容**（零縮排的懶續行、tab 起頭）：
//      條界在那一行切開，比對到的仍是原來那幾行 ⇒ 規則被悄悄加長而沒有人叫。
//      ⚠️ **不是「追加內容一概接不到」**：追加**縮排四格**的內容會被逐行比對拒收（r10 實測）。
//      同一條劃界也寫在 `test/helpers/agents-rule-item.js` 檔頭。
//    ・**從條外開一個會把整條吞掉的區塊**（程式碼圍欄、行首 raw HTML）：這一條每一行都沒被動到。
//      ⇒ **這一種有別的防線**：`test/contract-split.test.js` 的兩道禁令（AGENTS.md 不得出現
//      code fence／行首 raw HTML）在讀檔那一步就會拒收。
//    ・**Setext 造的「歷史紀錄」標題**：判準只認 ATX（見 markdown-heading 檔頭），上面那兩道也接不到。
//    ・**在別條末尾補一句散文說「以下僅供歷史參考」**：寫了「作廢／廢止」字面時，由題名關鍵字
//      「作廢字眼絆線」那題接；其餘沒有。
//
// ⚠️ **威脅模型**：主要防**誤刪與誤搬**（用戶是未來的自己人，不是會去改考題的攻擊者）。
//    ⚠️ 不可以由此推出「沒擋到的都只會是蓄意」——上面「擋不到」裡的 Setext 標題與別條末尾補散文，
//    正是一般整理文件會用的寫法。**未覆蓋的形式仍可能出現在正常編修中，那份殘餘風險交給複審辨識。**
//    本題也**不**證明任何人真的照做（那要靠複審與 William 驗收）。
test('⭐ 鐵則 12「必須懂的概念要在網頁上就地白話解釋」要留在正式鐵則區、承重句在它自己那一條裡（搬成沿革要紅；William 2026-07-22 定、2026-09-08 獨立）', () => {
  const agents = read('AGENTS.md');
  const lines = agents.split('\n');
  // ⚠️ **「這一行是不是標題」一律用 `headingAt()`**（判準只認 ATX，正反例表在 test/helpers/markdown-heading.js）。
  //    這裡不要再手寫第二條正規式——同檔已經因為那個踩過（#583 r5 Low、#578 r13 High①）。
  const once = (/** @type {string} */ canon) => {
    const hits = lines.reduce((/** @type {number[]} */ acc, l, i) => (l === canon ? [...acc, i] : acc), []);
    assert.equal(hits.length, 1,
      `AGENTS.md 裡「${canon.slice(0, 30)}…」出現 ${hits.length} 次（要剛好 1 次、逐字）——`
      + '改掉這一行的任何一個字（含在括號裡補一句「以下已作廢」）都會讓這題紅，那正是要擋的。');
    return hits[0];
  };
  const h1 = once('# AGENTS.md — 給所有 AI 協作者（Codex / Claude / 其他）的專案規則書');
  const rules = once('## 鐵則（違反會壞事）');
  const ui = once('## UI 現行慣例（預設值；UI 主線迭代中——2026-08-04 William 拍板兩級制）');
  assert.equal(h1, lines.findIndex((_, i) => headingAt(lines, i) > 0),
    '檔頭那個 H1 不是全檔第一個標題＝它前面被插了東西，「鐵則」節的歸屬就不是原來那一條鏈了');

  // ⚠️ 「第 12 條從哪裡到哪裡」一律問 `ruleItemRange()`（判準＝CommonMark 的內容欄，正反例表在
  //    `test/agents-rule-item.test.js`）。**不要在這裡自己寫一條「下一條長什麼樣」的正規式**——
  //    第一版就是那樣寫的，#585 r2 用四種合法寫法（一格空白／點號後 tab／三格縮排／`13)`）全部打穿。
  const range12 = ruleItemRange(lines, 12);
  assert.equal(range12.hits, 1,
    `AGENTS.md **整份檔案**裡、定位函式認出的**編號 12 的頂層清單項**有 ${range12.hits} 個（要剛好 1 個）——`
    + '⚠️ 認的是「編號等於 12」，不是字面的「12.」：`12)`、`012.` 一樣算（helper 用 `[.)]` 與數值比較）。'
    + '⚠️ 定位函式掃的是整份檔、不是只掃鐵則那一節：別的章節合法用到同一個編號也會讓這裡紅（假紅）。'
    + '真的碰到時，處置是把定位改成先切出鐵則節、而不是放寬這個計次。'
    + '它 2026-09-08 才從鐵則 7 的後半獨立出來——獨立的理由就是「躲在空樁後半會被當成一起搬走了」，'
    + '所以它需要一個自己的號碼與這一題。');
  const item12 = range12.start;
  assert.match(lines[item12], /^ {0,3}12\. \*\*必須懂的概念要在網頁上就地白話解釋\*\*/u,
    `AGENTS.md 第 ${item12 + 1} 行的第 12 條標題句被改了（現在是「${lines[item12].slice(0, 40)}」）——`
    + '這一條的號碼被別的規則佔走，或標題句被改寫了。');
  assert.ok(h1 < rules && rules < item12 && item12 < ui,
    '鐵則 12 不在「鐵則」節與「UI 現行慣例」節之間＝它被搬走了（逐字搬到沿革節也算，那是規則降成沿革）');

  // ① 檔頭 H1 到「鐵則」那一行之間，不可以再有 H1——有的話「鐵則」整節就換了爸爸（可以是一個作廢小節）
  for (let i = h1 + 1; i < rules; i += 1) {
    const level = headingAt(lines, i);
    assert.ok(level === 0 || level > 1,
      `第 ${i + 1} 行插了一個 H${level}（「${lines[i].slice(0, 40)}」），它會讓「鐵則」節改掛在它底下`);
  }
  // ② 「鐵則」那一行到第 12 條之間，**任何**標題都不行——那正是 Codex 實測用的那一刀
  //    （在第 12 條前面插「### 沿革（已不再適用）」，第 12 條就被切進沿革小節裡了）
  for (let i = rules + 1; i < item12; i += 1) {
    const level = headingAt(lines, i);
    assert.equal(level, 0,
      `第 ${i + 1} 行插了一個 H${level} 標題（「${lines[i].slice(0, 40)}」），`
      + '它會讓第 12 條落進那個小節、不再是「鐵則」節的直屬內容——'
      + '整條一字未動也照樣能在畫面上把它收進作廢／沿革區（#585 r1 Medium 實測）。'
      + '⚠️ **已知的假紅**：清單項底下縮排 1〜3 格的標題其實在清單容器裡，'
      + '這時把那一行改成粗體即可（理由見 test/helpers/markdown-heading.js 的檔頭）。');
  }
  // ③ 承重句要在**第 12 條自己那一段**裡——在檔案別處出現不算（會被下一條或別節借去充數）
  const blockEnd = Math.min(range12.end, ui);
  const block = lines.slice(item12, blockEnd).join('\n');
  assert.ok(!lines.slice(item12, blockEnd).some((_, i) => headingAt(lines, item12 + i) > 0 && i > 0),
    '第 12 條自己那一段裡插了 ATX 標題——後半會被切出去，承重句就不在同一條規則裡了');
  assert.doesNotMatch(block, /<!--|-->/u, '第 12 條裡出現 HTML 註解——規則不可以被藏成不可見內容');
  // ⚠️ **這道禁令在逐行白名單之後是第二層，不是門**（Grok #585 掃後點名）：白名單已經擋住所有
  //    改動到這幾行的寫法。**不要把白名單「簡化」掉、只留這一道**——它要求冒號後有空白，而少了
  //    空白的參考定義同樣合法、它認不得（#585 r4 實測）。留著只是為了給更精確的失敗訊息。
  assert.doesNotMatch(block, /^ *\[[^\]]+\]:\s/mu, '第 12 條裡出現**長得像 Markdown 參考定義**的行——本題一律拒收'
    + '（#585 r3 Medium 實測：四格縮排的 `[x]: /unused "…"` 可以把三個承重片段全部藏進去，'
    + '渲染後連 textContent 都找不到，考題卻全綠——因為條界要求縮排 ≥ 四格、禁令卻只收 0〜3 格）');
  // ⚠️ **承重內容一律逐行逐字比對，不可以用「這幾個字在這一段裡」**（#585 r4 兩條 Medium）。
  //    子字串比對擋不住「字還在原始檔、畫面上卻不顯示」：獨立審查者用四格縮排的參考定義
  //    （`[r12]:/unused "…"`，冒號後不留空白也合法）、引言／清單容器裡的定義、跳脫過的
  //    `[r\]12]:`、未被引用的腳註 `[^r12]:`、以及連結 title／圖片 alt／`<span title="…">`
  //    各載一次三個承重片段——**每一種都全綠，而渲染後那些字連 `document.body.textContent`
  //    都找不到**。禁令是黑名單，補一種就冒出下一種（本專案認過的跑步機：列舉補不完就關門）。
  //    ⇒ 改成**白名單**：這一條的內容必須逐行等於下面釘死的那幾行。任何夾帶都會改變行的內容＝紅。
  //    這也是第 6 題那一題（題名關鍵字「問法與逾時預設」）用的封閉做法。
  // ⚠️ **代價（刻意接受，照實列）**：**改動這一條已經被釘住的任何一個字元**（改字、改縮排），
  //    或**新增會被條界收進來的非空內容**，都會紅，要同時更新下面的 `RULE_12`。
  //    ⚠️ 這只保證那次改動**會在 diff 上留下痕跡、不能靜靜發生**，**保證不了有人真的看過**（#586 r3）。
  //    ⚠️ 反過來說**不是無條件的**：在末行之後追加零縮排或 tab 起頭的散文，條界會早切、比對照樣過
  //    ——那是檔頭已經寫明的例外（#585 r10／r11），不要在這裡又寫成無條件保證。
  //    這正是保存題要的。⚠️ 其中「整條多縮排一格」在 #585 r2 曾被列為要修掉的假紅、r3 也修掉了；
  //    改成逐行釘之後它**又會紅，而且是刻意的**（那是動到內容，不是定位失準）：
  //    `ruleItemRange()` 仍然定位得到縮排 1〜3 格的第 12 條，紅的是逐行比對、訊息會直接說是哪一種。
  //    不動這一條的編修（新增第 13 條、UI 第 5 點在節內搬位置）照樣綠。
  const RULE_12 = [
    '12. **必須懂的概念要在網頁上就地白話解釋**（William 定 2026-07-22，兩級制拍板時明確留下的例外）：',
    '    「懂了才不會把正常數字當算錯」的概念**必須在網頁上就地白話解釋**——用 `.info-link`＋`openInfo`',
    '    或未來任何等效機制（機制與樣式可實驗，**解釋本身不可省**）；文案 Claude 起草、William 審改。',
    '',
    '    ⚠️ **為什麼獨立成一條**（William 2026-09-08 裁，原話逐字「另外，把第 7 條剩下的那半條獨立成一條新鐵則',
    '    （給它自己的編號），第 7 就變成純路牌（指路）」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/584#issuecomment-5581991626 ）：',
    '    它原本擠在鐵則 7 那個**空樁**的後半，而樁的開頭寫著「已改列下方…」——讀的人很容易以為整條都搬走了。',
    '    給它自己的編號之後，第 7 條變成純路牌，這一條也不再被路牌的外觀淹掉。',
    '    ⚠️ **它不隨「UI 現行慣例」那一節放寬**：那一節是可以偏離的預設值，這一條是鐵則（見該節第 5 點）。',
  ];
  const UI_SIGNPOST = '> 5. 就地白話解釋是**鐵則 12**（2026-09-08 從鐵則 7 的後半獨立出來），**不隨本節放寬**（見鐵則 12）。';

  // ⚠️ **反方向也要釘**：只比對「檔案 = 釘住的那幾行」的話，有人把兩邊一起改成空殼照樣全綠
  //    （#584 那支學到的雙向釘法）。所以承重部分改成斷言**釘住的常數自己**還帶著它們。
  // ⚠️ **這一段只防「字面被刪掉」，不保證那三句話在畫面上看得見**（#585 r5 Medium 收窄）：
  //    把正文改寫成 `[補充](/unused "三句話")` 並**同步更新** `RULE_12`，三個片段在字串裡各還有
  //    一次，這一圈全部通過，而渲染後那三句只活在一個連結的 title 裡。可見性要 renderer 才證得了，
  //    見本題開頭的劃界。
  for (const [part, why] of /** @type {[string, string][]} */ ([
    ['懂了才不會把正常數字當算錯', '判準：哪一種概念非解釋不可'],
    ['解釋本身不可省', '機制與樣式可以換，但解釋不可省——少了這句就會被讀成「有做就好」'],
    ['文案 Claude 起草、William 審改', '誰寫、誰審；少了它會變成「Claude 自己說了算」'],
  ])) {
    assert.equal(RULE_12.join('\n').split(part).length - 1, 1,
      `本題釘住的那幾行裡少了「${part}」（${why}），或它出現不只一次——`
      + '⚠️ 這是在檢查**考題自己**：把 AGENTS.md 與這裡一起改成空殼，逐行比對照樣會綠，'
      + '所以承重部分要釘在常數上。要改這一條的內容，這三樣必須還在。');
  }
  assert.equal(UI_SIGNPOST.includes('鐵則 12') && UI_SIGNPOST.includes('不隨本節放寬'), true,
    '本題釘住的指路行不再說「鐵則 12」或「不隨本節放寬」——同上，這是在檢查考題自己');

  const got = lines.slice(item12, blockEnd);
  // 尾端的空行不算內容（`ruleItemRange()` 會把它們收在條內）。
  // ⚠️ **空行的認定要跟 helper 同一把尺**（Grok #585 掃後實測）：這裡本來用 `trim()`，
  //    而它把只含全形空白／NBSP 的行也當成空的——那種行縮排夠深時會被收進條內，再被這裡丟掉，
  //    於是「逐行等於白名單」在尾巴不成立（塞一行進去，考題照樣綠）。兩處必須用同一個定義。
  const blankLine = (/** @type {string} */ l) => /^[ \t]*$/u.test(l);
  while (got.length && blankLine(got[got.length - 1])) got.pop();
  assert.deepEqual(got, RULE_12,
    'AGENTS.md 的鐵則 12 跟本題釘住的內容逐行對不上。\n'
    + '⚠️ **這一題是逐字釘的**（#585 r4）：改動這一條**自己那幾行**的任何一個字——包含把字藏進'
    + '參考定義、腳註、連結 title、圖片 alt 或行中 HTML——都會讓它紅。\n'
    + '要正當地修改這一條：把新的內容同步更新到本題的 `RULE_12`，'
    + '**並且確認上面那三個承重部分還在**（那是這一條的意義所在）。');

  // ④ 指路要在**真正的**「UI 現行慣例」節裡（那一節是可以偏離的預設值，這一條不隨它放寬）
  //    ⚠️ 同樣是逐行等式：r4 實測把整行塞進 `[補充](/unused "原行")` 的 title、
  //    或換成 `[ui]: /unused "原行"`／未引用的 `[^ui]: 原行`，指路在畫面上消失而子字串比對全綠。
  const uiEnd = lines.findIndex((_, i) => i > ui && headingAt(lines, i) > 0 && headingAt(lines, i) <= 2);
  const uiLines = lines.slice(ui, uiEnd === -1 ? lines.length : uiEnd);
  assert.equal(uiLines.filter((l) => l === UI_SIGNPOST).length, 1,
    '「UI 現行慣例」那一節裡找不到**逐字**的那一行指路（或它出現不只一次）：\n'
    + `  ${UI_SIGNPOST}\n`
    + '⚠️ 指路搬到那一節外面、或把**這一行本身**改寫成 title／參考定義／腳註，都算沒有：'
    + '那一節自己要指得到它，才擋得住「這一條隨本節一起放寬」的誤讀。\n'
    + '⚠️ 但它只保證「這一行逐字還在本節裡」，**不保證它在畫面上看得見**——前後行可以改變解析'
    + '上下文把它包成不顯示的東西（#585 r5 實測）。理由與待辦見本題開頭的劃界。');
});

// ⚠️ **兩份文件可以單邊消失**（Grok #591 掃出）：`AGENTS.md` 那句自評條說「程序那份的固定維度
//    有一條在核它」，但那一列**沒有任何考題守著**——有人把它刪掉，規則書照樣宣稱有人在核。
//    ⇒ 這題把兩份綁在一起：規則書指過去，程序那份的**那一節裡**就必須真的有那一列。
// ⚠️ **反方向不歸本題**（r3 點名的責任界線）：本題只讀 `AGENTS.md` 的**裸字串**，所以那句被刪或改寫會紅，
//    但把它整行包進 HTML 註解、或刪掉正文只在檔尾註解留同樣的字，本題**照樣綠**——規則書**正文**的保存
//    是題名關鍵字「問法與逾時預設」那一顆整節逐字題在守（實測那幾刀它都紅）。兩題合起來才是雙向。
// ⚠️ **`headingAt()` 的已知假紅這題會踩到**（那支檔頭第 12〜18 行寫著）：清單項底下縮排 1〜3 格的 `## …`
//    會被當成節尾，後面的真表格就被切出視窗 ⇒ 這題假紅。踩到時是**紅的、看得見**，改法一行（把那行改成粗體）。
//    ⚠️ 那支檔頭寫「訊息會直接說這是已知的假紅」是**它自己那個呼叫端**的事，本題的訊息沒有那一句——所以寫在這裡。
//
// ⚠️ **七輪自評那半的判準刻意只認一個記號**（Codex #591 r2／r3 三條 Medium 換來的）：認的是**剝掉隱藏區之後、
//    那一節裡去掉行首空白後以 `|` 開頭、而且含自評留言固定開頭**的**文字行**。不認列名、不認格數——
//    r2 實測：把列名改寫、多一格空白、表頭與資料列一起換欄，原本那版全部假紅，而那些改動都沒有把
//    核對義務拿掉。
// ⚠️ **第三輪自問那半不一樣：它認的是固定的片段**「第三輪自問的降級理由」——2026-09-11 兩列併成一列兩款之後，
//    這個片段住在第 9 列第三格的第二款標題裡，**不是列名**；列名本身沒有任何考題守（把列名整個改掉這題仍綠，#599 預審實測）。
//    改掉那個片段這題會紅（Codex #597 r3 在還是兩列時實測：第 9 列改名仍綠、第 10 列改名就紅；併列後同一刀打在第二款標題上）。
//    （上一版這段註解寫「判準只認一個記號、不認列名」，擴成兩個片段之後對第二款是假話，r3 抓到；併列後又寫成「列名片段」，#599 預審抓到。）
// ⚠️ **這不是表格判定，別把它讀成「有效的表格列」**（r3 換來的照實劃界）：GFM 允許資料列**省略行首管線**，
//    那樣寫這題會**假紅**；反過來把表格的分隔行（`|---|---|`）刪掉，GitHub 那邊已經**不是表格**了，
//    這題照樣**綠**。⇒ **行首管線是本題要求的固定寫法**，不是 markdown 的規定；要它真的懂表格就得寫
//    第二個 markdown 解析器，那條路本 repo 走過、不走（r3 也明說不要求）。
//
// ⚠️ **章節邊界用 `headingAt()` 真的切**，不用「距離節首幾個字」那種上限（那是原本那版的兩個洞：
//    把整列搬進**相鄰**的下一節仍然綠＝假綠；只是在表格前面多寫幾行說明就超過上限＝假紅）。
//    節的範圍＝那行二級標題起、到下一個**同級或更高級**標題止；找不到唯一一個二級「固定維度」就紅
//    （所以把整節降成三級塞進別節底下也會紅）。
//
// ⚠️ **看得見才算**：整段先過 `visible()`（HTML 註解與 fenced code block 剝掉）——r2 實測原本那版
//    把整列包進註解或圍欄仍然綠。射程＝那支 helper 檔頭寫的那四條 fence 判準＋HTML 註解，
//    **縮排式程式碼區塊看不出來**，不假裝守得住。
//
// ⚠️ **它證不到的**（照實列）：審查者有沒有真的跑那一條、自評內容有沒有更新、那一列的「具體要做的事」
//    有沒有被改成別的意思——只要兩個固定片段還在那一節**同一條**看得見、以 `|` 開頭的表格列裡，這題就是綠的
//    （2026-09-11 掃後加了「同一列」這個條件，整體通過條件比之前嚴；Codex #599 r3 抓到這段沒同步）。那幾件事本來就沒有機器在看
//    （規則書該段已照實劃界，本題不冒充補上）。
test('⭐ 規則書指著固定維度那一列的兩款，程序那份的那一節裡就要真的有那一列、而且兩款在同一列（兩份不可單邊消失）', () => {
  const MARK = '🧭 自評';
  // ⚠️ **2026-09-11 起守兩個片段**（同日稍後兩列併成一列兩款，兩個片段落在同一列——併列當下判準不變，掃後另加「同一列」的斷言在下方）：原本只守「七輪自評」那一列；同一天的「第三輪自問表」也在 AGENTS 裡
  //    宣稱「`REVIEW-AND-MERGE.md`「固定維度」那一列的第二款」（併列前寫「新增一列」）——那句話同樣會因為那一列被刪而變成假話
  //    （Grok #597 複審後掃指出：不加那一列，審查者跑完下限也不會被要求去核降級理由）。
  for (const [claim, why] of /** @type {[string, string][]} */ ([
    ['「固定維度」那節有一條', '自評款（第一款）'],
    ['「固定維度」那一列的第二款', '第三輪自問表（第二款）'],
  ])) {
    assert.ok(read('AGENTS.md').includes(claim),
      `AGENTS.md 的${why}不再指向程序那份的固定維度（找不到「${claim}」）。\n`
      + '⚠️ 改寫那句沒問題，但**這一題要跟著改**——否則它會繼續守一句沒人在說的話。');
  }
  const lines = visible(read('REVIEW-AND-MERGE.md')).split('\n');
  const heads = lines
    .map((l, i) => (headingAt(lines, i) === 2 && l.includes('固定維度') ? i : -1))
    .filter((i) => i !== -1);
  assert.equal(heads.length, 1,
    `REVIEW-AND-MERGE.md 裡二級標題「固定維度」有 ${heads.length} 個（要恰好 1）。\n`
    + '⚠️ 0 個＝那一節被改名、降級（塞進別節底下）或整節不見了；2 個以上＝有副本，這題會分不出守哪一個。');
  let end = heads[0] + 1;
  while (end < lines.length && !(headingAt(lines, end) > 0 && headingAt(lines, end) <= 2)) end += 1;
  const section = lines.slice(heads[0], end);
  // 第三輪自問表那一款：只認「以 | 開頭且含這個片段」（併列後片段住在第二款標題裡，不是維度名）——同上，只看有沒有，不判內容
  const hit10 = section.filter((l) => l.trimStart().startsWith('|') && l.includes('第三輪自問的降級理由'));
  assert.ok(hit10.length > 0,
    'REVIEW-AND-MERGE.md「固定維度」那一節裡，沒有任何一行「以 | 開頭且提到『第三輪自問的降級理由』」，'
    + '但 AGENTS.md 的第三輪自問表（第二款）正在告訴讀者「固定維度那一列的第二款」。\n'
    + '⚠️ 那一列在守的事：作者用那張表把一條發現降級時，理由有沒有寫進逐條處置——'
    + '沒有它，審查者跑完下限也不會被要求去核。兩份任一邊要拿掉，另一邊要一起改。');
  const hit = section.filter((l) => l.trimStart().startsWith('|') && l.includes(MARK));
  assert.ok(hit.length > 0,
    `REVIEW-AND-MERGE.md「固定維度」那一節裡，沒有任何一行「以 | 開頭且提到『${MARK}』」，`
    + '但 AGENTS.md 的自評條正在告訴讀者「審查者在核它」。\n'
    + '⚠️ 四種情形長這樣：那一列被刪、被搬出這一節、被包進 HTML 註解／圍欄（看不見的不算）、\n'
    + '   或那一行**省略了行首的 `|`**（GFM 允許，本題不允許——這是本題要求的固定寫法，不是表格判定）。\n'
    + '⚠️ 兩份任一邊要拿掉，另一邊要一起改——只拿掉一邊＝規則書在說一件已經不存在的事。\n'
    + `   目前這一節有 ${section.length} 行、其中 ${section.filter((l) => l.trimStart().startsWith('|')).length} 行以 | 開頭。`);
  // 2026-09-11 起兩款要在**同一列**（排在自評記號斷言之後：先確認記號在、再確認同一列；Codex #599 r3 抓到上一版順序反了，害「拿掉記號」紅在錯的訊息）（Grok #599 掃：只認「節內任一列」的話，把兩款拆回兩列、或把第二款搬去沒人跑的列，這題照樣綠——
  //    那正好是這支 PR 說自己做成的形狀沒有被守住）。判準仍是片段：含自評記號的那一列，同一行也要含第二款的片段。
  const sameRow = hit.filter((l) => l.includes('第三輪自問的降級理由'));
  assert.ok(sameRow.length > 0,
    'REVIEW-AND-MERGE.md「固定維度」那一節裡，含自評記號的列沒有一列同時含『第三輪自問的降級理由』——兩款被拆開了（或第二款被搬去別列）。\n'
    + '⚠️ AGENTS 那一條說的是「一條兩款、程序那份一列兩款」；要拆回兩列＝兩份一起改，這題跟著改。');
});
