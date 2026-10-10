# 專案設定（每個使用這套架構的專案填一份；規矩本文與機器都從這裡取值）

這是產物：值住在 settings.json，改完跑 node tools/build-settings.js。搬進專案後把每個「未設定」填掉；沒填的欄位＝那條規矩的機器退化成靠自覺。「填了設定」和「機器已啟用」是兩件事，最後一節逐支登記。

本檔裡的指令是**展示**：一格一格用空白隔開，含空白、引號、反斜線或換行的那一格用 JSON 字串寫（例如換行寫成 \n）。不要把展示文字直接貼進終端機跑——那樣 \n 會變成字面的反斜線加 n；執行一律用 settings.json 裡的陣列、經工具入口。

## 一、參與者識別值

PR說明的「實作者」「複審者」兩欄、結論標頭與自評的角色格，填的是這裡的識別值，不是職稱。參與者可以登記三個以上：多一位就在下表多加一列（例如第三個 AI）。

值域：現階段只准純拉丁字母：結論標頭的正則只收 A 到 Z 的字母，協作欄位閘收得寬，兩道機器值域不同——要放寬就得標頭、欄位閘整族一起改。

| 參與者 | 識別值 | 貼文帳號 |
|---|---|---|
| 裁示者（人） | William | teacherjung |
| AI 甲 | Claude | teacherjung |
| AI 乙 | Codex | teacherjung |

貼文帳號資格：只採計登記在參與者表裡的貼文帳號貼的 ❓／⚖️／🚫；沒登記的帳號貼的不採計為有效留痕——它貼的 ❓ 不入待裁，它貼的 ⚖️／🚫 不能替已採計的問題收口（原題繼續待裁），形狀合規的會另列成疑似。⚖️ 另外要由裁示者那一位的帳號貼。結論閘只認識別值、不認帳號。多方共用同一個帳號時，機器分不出是誰親自貼的——那是這套機制的邊界，不是保證。

預設分工（規矩 A1；裁示者沒有逐支指定時，PR說明的「實作者」「複審者」兩欄照這個填）：實作者＝Claude；複審者＝Codex

擁有者（規矩 A1；文字快速通道由他當複審者，F12，結論閘認他的「通過」不要求固定小標）：William

## 二、來源字串標準表（結論標頭的來源欄；寫作義務：跨輪次一字不改、不含會變的東西）

| 審查工具或工作階段 | 逐字來源字串 |
|---|---|
| 本機 codex CLI 起的審查 session | codex CLI |
| Claude Code CLI 起的審查 session | Claude CLI |
| Codex 桌面 session | Codex 桌面 |
| Claude 桌面 session | Claude 桌面 |
| William 本人（畫面驗收／產品裁決） | William 本人 |

## 三、清單與正本的位置

| 項目 | 規矩 | 位置 |
|---|---|---|
| 禁區工具與能力清單（含攔截器安裝在哪一方） | B1 | 規則正本＝AGENTS\.md「🛑 錢的絕對邊界」節（William 2026\-08\-03 拍板）；攔截器裝在哪幾層、各層怎麼驗、Claude 側改清單的手續＝docs\/money\-guard\-operations\.md 的機械層說明；專案內的攔截器＝\.claude\/settings\.json（進版控：permissions\.deny 兩支全名＋PreToolUse 剛好一組＝釘指紋那一行、ConfigChange 剛好一組＝設定變更攔截；兩組逐字等於 node tools\/guard\-copy\.js \-\-claude\-line 印的那兩組＝範本 templates\/hook\-claude\-pinned\.json 填上這棵樹四個檔的指紋，test\/money\-kit\-hook\.test\.js ① 釘），家目錄與平台層的設定不在 repo、也不寫在這裡。清單現況：只有一份＝根目錄 settings\.json 的 forbidden；2026\-09\-19 起 Claude 側那一行不讀這棵樹的清單，讀的是 tools\/guard\-copy\.js \-\-claude 從已合併版本抽出、放在每台機器家目錄 \.local\/share\/ai\-collab\-kit\/guard\/\<指紋\> 的固定複本（在那之前是每次呼叫重讀那棵樹的活讀那一行＝templates\/hook\-claude\.json）——改了清單要照機械層說明的手續在同一支重印那一行、合併後每台機器補複本，才會生效；測試鈕 mcp\_\_guard\_canary\_\_ping 只在 forbidden\.deny 上。搬家第 3 步 B 支（2026\-09\-16）到第 8 步（2026\-09\-18）之間曾與寫死詞表的 python v6 那組並存，第 8 步照第 15 題 a 拆掉 python 那組、照第 14 題 a 刪掉 Codex 專案層副本 \.codex\/hooks\.json。Codex 全域層讀的是 tools\/guard\-copy\.js 從已合併版本抽出、放在倉庫外的固定複本（哪個版本＝重抽時的合併紀錄），登記與信任不在 repo。其他層怎麼讀清單不寫在這裡。受管設定層（2026\-09\-21 William 裁 a）＝本機系統目錄的 managed\-settings\.json，裡面只放那兩支下單工具的拒絕清單、不放鉤子；它不在 repo、沒有任何考題或閘看得到，裝法與驗收＝套件範本 templates\/managed\-deny\-install\.md，哪一台裝了與驗收結果記在 PROJECT\.md。 |
| 真實資料檔清單 | B4 | AGENTS\.md 鐵則「敏感資料絕不進版控」那一條（列 data\/store\.json、\*\.bak、data\/\*backup\*）＋ \.gitignore 開頭「個人實際資料與憑證」那一節（最完整的一份）；scripts\/grok\-scan\.js 建盒子後的禁區檢查另帶一份（多 \.env、\.env\.local）——三份不一致、尚無單一正本（2026\-10\-10 整批同步：\.gitignore 尾端補了 \.env、\.env\.local，跟掃描那一份對上；AGENTS\.md 鐵則那一條沒列 \.env，三份仍未統一成單一正本） |
| 忽略清單、檢查豁免允許清單 | E7 | 忽略＝\.gitignore 與 prototype\/forest\-ui\-lab\/\.gitignore（兩份的生效樣式都由 settings\.json 的 ignoreLists 登記、套件的 tests\/ignore\-lists\.test\.js 逐字比對——搬家第 2 步起在本專案三關裡跑；根目錄那份另由 test\/no\-hiding\-places\.test\.js 的 ALLOWED\_GITIGNORE 再釘一份。所以改任何一份忽略檔，要同一支改 ignoreLists、ALLOWED\_GITIGNORE（根目錄那份時），並跑 node tools\/build\-settings\.js）；檢查豁免＝eslint\.config\.js 的兩組 ignores（全域一組＋xlsx 引入限制那組；test\/no\-hiding\-places\.test\.js 的 ALLOWED\_ESLINT\_IGNORES 以 import 讀實際值釘住）；型別檢查射程＝jsconfig\.json 的 include（test\/ 刻意不在；test\/ts\-check\-coverage\.test\.js 只釘 lib、public、scripts、test\-doubles、prototype 五個目錄與 server\.js 必須直接納入，不釘還排除了什麼）；版控外的 \.git\/info\/exclude 不在射程；檢查豁免另有 kit\-lock\.json 的 exceptions（tests\/kit\-lock\.test\.js 比對；2026\-10\-10 整批同步起） |
| 路標考題掃描的目錄範圍 | K3 | test\/comment\-test\-refs\.test\.js：掃 test\/ 第一層的 \*\.test\.js 與 test\/helpers\/ 第一層的 \.js，更深的子目錄不在射程（套件的 tests\/signposts\.test\.js 目錄寫死 tests\/、不讀這一格） |
| 三關的實際命令、執行環境版本、稽核等級（或唯一設定檔位置） | E2、E3 | 搬家第 4 步（2026\-09\-17）起＝settings\.json 的 checks 是三關命令的正本：本機門 scripts\/git\-hooks\/pre\-push 與雲端 \.github\/workflows\/ci\.yml「上線用的 Node（\.node\-version）」job 都呼叫 tools\/run\-checks\.js（三關前後的工作樹、主目錄布局與索引錨點由執行器自己驗；鉤子只叫執行器、本專案不再有第二支工作樹體檢＝William 2026\-09\-20 裁 a（拿掉本專案那支 scripts\/check\-worktree\-integrity\.js、只留套件那支，分兩支），落點＝https\:\/\/github\.com\/teacherjung\/personal\-finance\-webapp\/pull\/622\#issuecomment\-5743466843 ；執行順序照同一支的 https\:\/\/github\.com\/teacherjung\/personal\-finance\-webapp\/pull\/622\#issuecomment\-5743476335 調整，兩支都已合併：第一支 \#623（7612485）拿掉鉤子前後那兩次呼叫、把 08\-09 事故的病理與證據鏈搬到 docs\/bare\-repo\-incident\.md；第二支 \#624（7fdb8fe）刪掉那支腳本與只考它的考題（事故的原地重現題留著，改成不依賴它）。沿革：William 2026\-09\-18 裁搬家第 13 題 a＝兩支一起跑到搬家完工驗收、再拿掉本專案那支，落點＝https\:\/\/github\.com\/teacherjung\/personal\-finance\-webapp\/pull\/614\#issuecomment\-5724981414；2026\-09\-19 再裁 a＝先不拿：套件那支補上這支擋得住、它原本放行的四種壞法，本專案登記 checks\.mainWorktree＝一般工作樹、checks\.indexAnchors＝package\.json、AGENTS\.md、server\.js〔當時的依據是那支的 REQUIRED\_TRACKED；那支 2026\-09\-20 刪掉之後，改由 test\/kit\-check\-registration\.test\.js 直接釘這三個字面值〕，同步之後在暫存倉庫把同一批壞法各造一次、兩支結果一致才拿〔結果一致＝照套件 ai\-collab\-kit issue \#6 本文事先寫好的期待表：兩支不是逐一等價，表上登記的差異（這支多擋的，例如共用 core\.bare\=true 而每棵樹連主目錄都覆寫 false、store\.git 裸儲存庫；套件守不到的，例如 \-\-separate\-git\-dir 布局）之外逐列相同；跑出表上沒有的差異＝不拿〕，落點＝https\:\/\/github\.com\/teacherjung\/personal\-finance\-webapp\/pull\/617\#issuecomment\-5739129893；照期待表的對照結果＝套件 ai\-collab\-kit issue \#6 留言 5741036750）；跨PR試合併閘＝tools\/gates\/check\-cross\-merge\.js：在臨時樹先跑 checks\.prepareWorktree（npm ci；臨時樹已有 node\_modules 就退 3、不跑）再跑同一份 checks\.commands（舊的 scripts\/check\-cross\-pr\-merge\.js 已於 2026\-09\-18 搬家第 7 步刪除）；執行環境版本＝\.node\-version（CI 與 Render 部署同讀；package\.json 的 engines 是 start\.command 啟動時驗的下限；本機門不驗版本）；稽核等級＝ci\.yml 上線用 Node 那個 job 的 npm audit \-\-audit\-level\=high（只在雲端跑） |
| 必要檢查名單與分支保護設定（指向平台上的設定正本與驗證入口，不另抄一份會漂的名單） | E3、H3 | 正本在 GitHub：main 分支保護的 required\_status\_checks（唯讀重讀：gh api repos\/teacherjung\/personal\-finance\-webapp\/branches\/main\/protection）；紀錄與驗證入口＝docs\/github\-branch\-protection\-setup\.md；檢查名逐字對應 \.github\/workflows\/ci\.yml 與 \.github\/workflows\/collab\-fields\.yml 的 job 名 |
| 合併步驟登記正本（閘登記對帳題讀它） | H1 | settings\.json 的 gates（登記；每筆＝name／rules／command／args／state）；各閘腳本＝tools\/gates\/\*\.js；對帳考題＝tests\/settings\.test\.js（磁碟上的閘 vs 登記的閘）；合併指令 tools\/merge\.js 只跑登記為已啟用的閘、任一非零就停。切換日（2026\-09\-17）之前＝舊程序文件的合併步驟清單＋scripts\/check\-\*\.js 自報的 MERGE\_GATE；舊閘腳本已於 2026\-09\-18 搬家第 7 步（\#614）刪除；切換日到刪除之間不在任何合併路徑上 |
| 「按合併鍵」前要查的三種例外（裁示者叫停、本支還沒回的待裁、改到禁區清單的PR要擁有者點頭） | A5 | 靠自覺、沒有專屬清單：叫停＝看對話與本支PR的留言；本支還沒回的待裁＝node tools\/pending\-rulings\.js 列出、掛在本支的那幾題；改到禁區清單的PR＝先等擁有者點頭（本專案算「改到禁區清單」的：settings\.json 的 forbidden 那一塊、判斷程式 tools\/forbidden\-tools\.js、同一份指紋的 tools\/settings\-data\.js 與 tools\/package\.json、整份 \.claude\/settings\.json、抽複本的 tools\/guard\-copy\.js、四份 templates\/hook\-\*\.json、測試鈕 tools\/canary\-server\.js 與 \.mcp\.json、同步時套件空白範本 tests\/helpers\/unfilled\-settings\.json 的 forbidden 那一塊（專案清單的地板）有變、AGENTS\.md「🛑 錢的絕對邊界」那一節及搬出的 docs\/money\-guard\-operations\.md；清單本身見 B1 那一列）。三種都沒有＝按合併鍵前不用問裁示者；高風險與新功能也不在合併前另做實測（裁示者 2026\-09\-28 裁 ④ 第 D2 題 b：合併後照 H6 那一列分級驗收、驗不過就退回；某一支要先測就叫停） |
| 合併後驗收分級與動作的正本（路徑家族表＋各級動作） | H6 | settings\.json 的 acceptance（路徑家族表＋每一級的動作；由 tools\/acceptance\-tier\.js 讀、合併後跑；每條家族的級別由 test\/acceptance\-table\.test\.js 逐條釘住、F 排第一照 William 2026\-09\-15 搬家第 3 題 a；第 6 步 2026\-09\-17 起，舊的 scripts\/acceptance\-tier\.js 已退役） |
| 「指示檔」與「常設指示」寫在哪（兩方每次開工都會自動整份讀進去的那一份） | K6 | CANDIDATE\-K6 |
| 「進度摘要」放在哪、已結束的留幾天（各方共用一份） | J5 | CANDIDATE\-J5 |

待辦清單（開工印待辦 tools/backlog-touch.js 讀它；規矩 F6）：PROJECT\.md 的「\#\# 待辦（依優先序；已完結主線的結案紀錄在\[完工紀錄\]\(docs\/archive\/project\-completion\-log\.md\)）」那一節

使用這個套件的專案（下游落後 tools/downstream-lag.js 讀它、開工時手動跑、只列不擋；只有套件倉庫要填，使用專案留空）：（沒有登記）

主幹分支名（原閘寫死 main，規矩 H2、H3、H4）：main

## 四、掃描發射者（規矩 A1、G1、G4）

- 掃描者：Grok CLI（xAI）：一律經 node scripts\/grok\-scan\.js \-\-base \<sha\> \-\-head \<sha\> \-\-prompt \<指示檔\> \-\-out \<回覆檔\> 發射（呼叫紀律與三個失效條件＝scripts\/grok\-scan\.js 檔頭）、不准手動啟動它的 CLI；執行檔版本與 sha256 釘在該腳本；grok 自己會升版（裁示者 2026\-09\-22 裁「auto\_update 維持開著」），升版＝在倉庫根目錄跑 \`npm run grok\:bump\`（重驗必要字串→改釘值與考題 fixture；不 commit、不 push；重驗不過就退 2 不寫），細節與劃界＝\`scripts\/grok\-bump\.js\` 檔頭（沒有掃描者＝照風險級別要掃的那幾支，掃描紀錄寫「未執行：本專案無掃描者」，由下面指定的那一方記錄並轉正式；表定不掃的照規矩 G1）
- 誰指派、登記在哪：掃描發射者＝起得了掃描者的那一方（William 2026\-09\-11 裁「甲」改成角色寫法）；定義＝RULES A1、G4；現況登記在本格；本專案現況＝Claude（照現行方式起的 Codex 帶外層沙箱、實測套不上第二層、金絲雀 fail\-closed）；要換現況＝想換的那一方自己實測、貼出可重跑的結果，再問 William
- 兩方都起得了時：實作者（裁示者 2026\-09\-25 裁、第二輪 A1：兩方都起得了掃描者時，預設是實作者；原本這一格寫「出現兩方都起得了時要補一條」，這就是那一條）；本專案今天只有一方起得了（見 assignedBy），這一格要到兩方都起得了才用得到
- 沒有合格者時，誰記錄未執行、誰轉正式：實作者（第二輪 G4：專案沒有掃描者、或沒有任何一方起得了時，由實作者寫未執行並轉正式）；掃得起但掃不成時，一律由掃描發射者（現況 Claude）在PR說明固定小標「\#\#\# 複審後掃」下逐字寫「未執行：\<原因\>」、不擋合併，轉正式也由掃描發射者做
- 掃描用的最強模型（規矩 G1；換新模型只改這裡）：grok\-4\.7；最高推理：xhigh

隔離（規矩 G2；裁示者 2026-09-12 裁「丙」：隔離本身不在套件裡，由這裡指定誰提供；套件只帶掃前檢查與掃後檢查兩支小工具）：

- 由誰提供：專案自建（「無」或「未設定」＝不掃，掃描紀錄寫「未執行：無隔離」）
- 從盒內跑一條指令的前綴（{box} 會換成盒子路徑、{projectRoot} 會換成專案根目錄）：\/usr\/bin\/sandbox\-exec \-f \{projectRoot\}\/scripts\/grok\-sandbox\.sb \-D SCAN\_DIR\=\{box\} \-D RELAY\_PORT\=18765
- 盒子建在：\/private\/tmp（未設定＝系統暫存區）
- 盒內必須讀不到也寫不進的目錄（~ 代表家目錄；掃前檢查在每一個各埋一個假機密）：\~、\/private\/tmp、\/private\/var\/tmp、\/Users\/Shared、\~\/\.grok
- 整條鏈（每一步退非零就停，掃描紀錄寫未執行）：
  1. node tools/scan-probe.js：任一禁區用它的讀寫機制碰得到＝隔離是假的，不掃；連試探都做不成（含盒內起不了那個機制）＝不掃。
  2. node tools/scan-probe.js --plant <清單檔>：在每個禁區埋一個掃描期間才有的假機密。清單檔不要貼進任何紀錄。
  3. 起掃描者（本套件不代跑）。
  4. node tools/scan-postmortem.js --secrets <清單檔> --reply <回覆檔> --logs <日誌目錄>：假機密或未給盒子的真值出現在任何輸出（含檔名）＝事故。
  5. node tools/scan-probe.js --sweep <清單檔>：把埋下去的收掉。這一步一定要跑。

## 五、平台介面（規矩 E5、H1；閘要問平台的每一件事都走這裡）

套件只定「問什麼」與「答案長什麼樣」，每個動作填一條指令，指令要把答案印成約定形狀的 JSON。翻譯是這個專案的事，套件不碰任何平台的語彙。沒登記的動作被問到時一律不放行，不會回一個空答案假裝問過了。

平台：GitHub；倉庫身分（指令裡的 {project}）：teacherjung\/personal\-finance\-webapp；問平台前要清掉的選倉環境變數：GH\_REPO、GH\_HOST

| 動作 | 要問什麼 | 登記的指令 |
|---|---|---|
| change | 讀一支PR的基本資料 | gh pr view \{change\} \-R \{project\} \-\-json number\,title\,body\,baseRefName\,headRefName\,headRefOid\,state\,isDraft\,isCrossRepository\,autoMergeRequest\,changedFiles\,author \-\-jq \{id\:\(\.number\|tostring\)\,title\:\.title\,body\:\.body\,baseBranch\:\.baseRefName\,headBranch\:\.headRefName\,headSha\:\.headRefOid\,state\:\.state\,isDraft\:\.isDraft\,isCrossRepo\:\.isCrossRepository\,autoMergeOn\:\(\.autoMergeRequest\!\=null\)\,changedFileCount\:\(\.changedFiles\|tostring\)\,author\:\.author\.login\} |
| openChanges | 列出目前開著的每一支PR（⚠️ 必須是全部，分頁要在這條指令裡處理完；套件驗不到少給了幾支） | gh api \-\-paginate repos\/\{project\}\/pulls\?state\=open\&per\_page\=100 \-\-jq \[\.\[\]\|\{id\:\(\.number\|tostring\)\,baseBranch\:\.base\.ref\,headBranch\:\.head\.ref\,headSha\:\.head\.sha\,isDraft\:\.draft\,author\:\.user\.login\}\] |
| comments | 讀一支PR底下的留言（結論、裁示、撤回都靠它） | gh api \-\-paginate repos\/\{project\}\/issues\/\{change\}\/comments\?per\_page\=100 \-\-jq \[\.\[\]\|\{id\:\(\.id\|tostring\)\,author\:\.user\.login\,body\:\.body\,createdAt\:\.created\_at\}\] |
| allComments | 讀整個專案的每一則一般留言，各帶它所屬的PR編號（⚠️ 必須是全部、含已關的PR，分頁要在這條指令裡處理完） | gh api \-\-paginate repos\/\{project\}\/issues\/comments\?per\_page\=100 \-\-jq \"\[\.\[\]\|\{id\:\(\.id\|tostring\)\,author\:\.user\.login\,body\:\.body\,createdAt\:\.created\_at\,change\:\(\.issue\_url\|split\(\\\"\/\\\"\)\|last\)\}\]\" |
| changedFiles | 讀一支PR動了哪些檔 | gh api \-\-paginate repos\/\{project\}\/pulls\/\{change\}\/files\?per\_page\=100 \-\-jq \"\[\.\[\]\|\{path\:\.filename\,status\:\.status\,previousPath\:\(\.previous\_filename \/\/ null\)\}\]\" |
| checks | 讀某一顆版本上跑過的檢查場次（⚠️ 必須是全部，分頁要在這條指令裡處理完） | gh api \-\-paginate repos\/\{project\}\/commits\/\{sha\}\/check\-runs\?per\_page\=100 \-\-jq \"\[\.check\_runs\[\]\|\{name\:\.name\,status\:\.status\,conclusion\:\.conclusion\,completedAt\:\.completed\_at\,producer\:\(if \.app then \(\.app\.id\|tostring\) else null end\)\}\]\" |
| requiredChecks | 讀主幹設了哪些必過檢查（名單的正本在平台上，不另抄一份會漂的） | gh api repos\/\{project\}\/branches\/\{branch\}\/protection\/required\_status\_checks \-\-jq \"\[\.checks\[\]\|\{name\:\.context\,producer\:\(if \(\.app\_id \/\/ \-1\) \< 0 then null else \(\.app\_id\|tostring\) end\)\}\]\" |
| branchSha | 讀一個分支現在指到哪一顆 | gh api repos\/\{project\}\/git\/ref\/heads\/\{branch\} \-\-jq \{sha\:\.object\.sha\} |
| repoTree | 讀別的倉庫某一條分支上的每一個檔（路徑與內容雜湊；⚠️ 必須是全部，平台把清單截斷時這條指令要失敗） | gh api repos\/\{repo\}\/git\/trees\/\{ref\}\?recursive\=1 \-\-jq \"if \.truncated then error\(\\\"平台把檔案清單截斷了\\\"\) else \[\.tree\[\]\|select\(\.type\=\=\\\"blob\\\"\)\|\{path\:\.path\,sha\:\.sha\}\] end\" |
| repoFile | 讀別的倉庫某一條分支上一個檔的內容（原文） | gh api repos\/\{repo\}\/contents\/\{path\}\?ref\=\{ref\} \-\-jq \{content\:\(\.content\|\@base64d\)\} |
| markReady | 把一支PR從草稿轉成正式 | node \-e \"process\.stderr\.write\(\'實跑：這個平台動作刻意封住，合併一律走 mergeCommand\\\\n\'\)\;process\.exit\(97\)\" \{change\} |
| merge | 按下合併鍵 | node \-e \"process\.stderr\.write\(\'實跑：這個平台動作刻意封住，合併一律走 mergeCommand\\\\n\'\)\;process\.exit\(97\)\" \{change\} |

## 六、三關（規矩 E2、E3、H4；跨PR試合併閘在臨時工作資料夾（樹）裡跑的就是這幾條）

- 臨時工作資料夾（樹）的準備指令（在新開的那一份裡跑一次，例如安裝相依；沒有就填「無」）：sh \-c \"if \[ \-e node\_modules \] \|\| \[ \-L node\_modules \]\; then echo \\\"臨時樹裡已經有 node\_modules（可能是被 commit 進來的連結）：不跑 npm ci，免得它順著連結清掉別棵樹的套件\\\" \>\&2\; exit 3\; fi\; exec npm ci \-\-prefer\-offline \-\-no\-audit \-\-no\-fund\"
- 三關指令（依序跑、任一非零＝紅；每一條要自己保證執行環境跟合併後的工作資料夾（樹）一致——套件驗不到這件事）：
  1. npm run typecheck
  2. npm run lint
  3. npm test
- 主目錄布局（只有三關執行器看；填「一般工作樹」＝從連結工作樹跑三關時，前後各問一次主目錄有沒有被判成裸倉庫、打不打得開；未設定＝不問）：一般工作樹
- 索引錨點（只有三關執行器看；填一串從根目錄算起的檔案路徑＝每一個都要在跑三關那棵樹的索引裡，前後各驗一次；未設定＝不驗）：package\.json、AGENTS\.md、server\.js

## 七、禁區（規矩 B1；攔截器的判斷讀這裡，程式裡不寫任何禁區的名字）

- 禁區叫什麼：錢（未設定＝攔截器一律拒絕）
- 會動到禁區的連接器（白名單制；兩欄的登記名＝工具名 mcp__ 後面、下一個 __ 前面那一段，一個連接器一筆、逐字、沒有萬用字元）：deda1d5d\-1ccc\-4551\-9617\-156b9658d236
- 不會動到禁區的連接器（整個放行；登記制：mcp__ 開頭的名字所屬的連接器兩欄都沒登記＝一律拒絕，兩欄都空＝全擋）：12dbf356\-cefb\-4f87\-9b92\-870114879406、1765aa98\-7cc3\-47ce\-8c73\-1c9859ff4ced、1a59c906\-04da\-521d\-bda7\-7f71b9f9e01c、6f616b42\-0ed8\-571e\-823f\-ee4aca6b7ce9、a3d22476\-476d\-4ed9\-bc5f\-9b649571fcda、c60d4cf2\-a841\-43c3\-97bc\-7f3ee9023a1b、terminal、visualize、scheduled\-tasks、mcp\-registry、Claude\_Browser、claude\-in\-chrome、Claude\_Code\_iOS\_Simulator、ccd\_session、ccd\_view、ccd\_pr、ccd\_settings、ccd\_host、ccd\_connectors、ccd\_directory、ccd\_session\_mgmt、ccd\_sidebar、ccd\_window、node\_repl、computer\-use、openaiDeveloperDocs
- 那些連接器上准用的唯讀工具：get\_account\_balances、get\_account\_orders、get\_account\_positions、get\_account\_summary、get\_account\_trades、get\_alert、get\_alerts、get\_combo\_identifier、get\_company\_connections、get\_company\_themes、get\_option\_data、get\_option\_parameters、get\_order\_instructions、get\_pa\_allocation、get\_pa\_performance\_all\_periods、get\_price\_history、get\_price\_snapshot、get\_theme\_details、get\_watchlist、get\_watchlists、search\_contracts、search\_futures、search\_investment\_topics、whats\_new、provide\_customer\_feedback、create\_alert、update\_alert、delete\_alert、set\_alert\_status、create\_watchlist、edit\_watchlist、delete\_watchlist
- 逐字拒絕的工具名：mcp\_\_deda1d5d\-1ccc\-4551\-9617\-156b9658d236\_\_create\_order\_instruction、mcp\_\_deda1d5d\-1ccc\-4551\-9617\-156b9658d236\_\_delete\_order\_instruction、mcp\_\_guard\_canary\_\_ping
- 家族網的動詞：create、place、submit、send、stage、preview、prepare、draft、amend、modify、edit、update、cancel、delete、execute、close、open、buy、sell、purchase、exercise、liquidate、replace、redeem、pay、withdraw、withdrawal、transfer、xfer、deposit、remit、wire、disburse、cash\_out、cashout、encash、sweep、repay；名詞：order、trade、position、instruction、stock、share、security、securities、etf、option、future、bond、asset、fund、crypto、coin、locate、invoice、bill、cash、money、transfer、withdrawal、payment、payout、wallet、cheque、payee、loan、settlement；唯讀前綴（豁免到哪一道、代價與射程＝「兩張樣式表」，正本＝`docs/money-guard-two-pattern-tables.md`，本檔不重述）：get、list、search、fetch、read、query、view、show、describe、has、check、retrieve、export、download
- 兩張樣式表的條數：額外樣式 2 條、patternsReadSafe 5 條（分工＝見「兩張樣式表」）
- 額外樣式（patterns）：\(\^\|\_\)\(transfer\|withdraw\(al\)\?\|deposit\|remit\(tance\)\?\|payout\|disburse\(ment\)\?\|payment\|wire\)s\?\(\_\|\$\)、\(\^\|\_\)\(convert\|exchange\|swap\)\_\\w\*\?\(currenc\|fund\|money\|cash\|asset\|crypto\|coin\|stock\|share\|securit\)
- 額外樣式（patternsReadSafe）：\(\^\|\_\)\(move\|send\)\_\(fund\|money\|cash\|asset\|securit\[a\-z\]\*\|stock\|share\|crypto\|coin\)s\?\(\_\|\$\)、\(\^\|\_\)\(create\|place\|submit\|send\|stage\|preview\|prepare\|draft\|amend\|modify\|edit\|update\|cancel\|delete\|execute\|close\|open\|buy\|sell\|purchase\|exercise\|liquidate\|replace\|redeem\|pay\)\_\?\\w\*\?securit\[a\-z\]\*s\?\(\_\|\$\)、\(\^\|\_\)securit\[a\-z\]\*s\?\_\(create\|place\|submit\|send\|stage\|preview\|prepare\|draft\|amend\|modify\|edit\|update\|cancel\|delete\|execute\|close\|open\|buy\|sell\|purchase\|exercise\|liquidate\|replace\|redeem\|pay\)\(\_\|\$\)、\(\^\|\_\)\(convert\|swap\)\_\(currenc\[a\-z\]\*\|fund\|money\|cash\|asset\|crypto\|coin\|stock\|share\|securit\[a\-z\]\*\)s\?\(\_\|\$\)、\(\^\|\_\)\(transfer\|withdraw\(al\)\?\|deposit\|remit\(tance\)\?\|payout\|disburse\(ment\)\?\|payment\|wire\)s\?\(\_\|\$\)

## 八、合併後驗收分級（規矩 H6；分級工具讀這裡，只算不擋）

| 級別（從最重到最輕） | 動作 |
|---|---|
| F（工具安全設定） | 不是重啟，是 docs\/money\-guard\-operations\.md 機械層那幾件事：\.claude\/settings\.json＝Claude Code 權限層正本（permissions\.deny 兩支全名＋PreToolUse 剛好一組＝釘指紋那一行、ConfigChange 剛好一組＝設定變更攔截；兩組逐字等於 node tools\/guard\-copy\.js \-\-claude\-line 印的＝templates\/hook\-claude\-pinned\.json 填上這棵樹四個檔的指紋，test\/money\-kit\-hook ① 釘逐字與組數、不准跳過）——那兩組不要手改：四個檔或那份範本一改，就在同一支重跑 \-\-claude\-line 換進來；合併後重開 Claude Code 對話讓新設定載入（設定變更攔截量到的是：2026\-09\-18、只量過專案設定檔這個來源，對話中途的專案設定改動不被那個對話載入；裝上時的驗收與「之後沒有例行重量」見 docs\/money\-guard\-operations\.md 機械層②），並確認家目錄 \~\/\.claude\/settings\.json 的 deny 仍在；Codex 側沒有專案層副本（2026\-09\-18 第 8 步刪了 \.codex\/hooks\.json），改 Codex 側＝下面①的重抽。｜協作套件那幾份（驗過沒有＝看 PROJECT\.md 與機器表的日期，這段只寫長期有效的步驟）：分三類——①執行時會讀的（settings\.json 的 forbidden 那一塊、tools\/forbidden\-tools\.js、tools\/settings\-data\.js、tools\/package\.json）：兩側都讀固定複本、都不讀這棵樹。Claude 側（2026\-09\-19 起；順序＝docs\/money\-guard\-operations\.md 機械層「Claude 側改清單的手續」與 tools\/guard\-copy\.js 檔頭；第一次換上那一次不同：先在每台機器補複本再更新重開，第一下測試鈕就該看到「在拒絕清單上」）：同一支裡重跑 node tools\/guard\-copy\.js \-\-claude\-line、把印出的那兩組換進 \.claude\/settings\.json（沒換＝真的對話裡那一行照舊指紋找到舊複本、靜靜照舊清單判，執行期沒有訊號；考卷裡會紅的有兩類：兩支等式題 test\/money\-kit\-hook ①、tests\/claude\-pin ①（訊息叫你重跑 \-\-claude\-line），以及每一題在暫存家裡實跑那一行的考題（money\-boundary 的探針、money\-kit\-hook ⓪②與③裡實跑那一行的題），錯誤輸出是「指紋對不上」那一句——在考卷裡它的意思是那一行沒跟著重印，不必轉給裁示者）→審查、合併→每台機器：更新→關掉所有 Claude 對話、開一個新的→叫測試鈕（下面說的同一個無害測試工具），這一下應該先看到「…（指紋對不上）」那一句、沒有 pong（還沒補複本；補複本刻意不自動＝William 2026\-09\-18 裁）→請 AI 在已合併的主幹上跑 node tools\/guard\-copy\.js \-\-claude 補複本→再叫一次，要看到拒絕理由含「在拒絕清單上」→需要時（例如收緊清單）node tools\/guard\-copy\.js \-\-retire \<舊指紋\> 退役舊的那一份。Codex 全域層讀的是固定複本，要在合併後的主幹上跑 node tools\/guard\-copy\.js 重抽、關掉所有 Codex 視窗、在原位置換上新印出的那一組、William 重按信任（\*\*重抽＝新複本的路徑與指紋都寫進那一行＝那一行必變＝信任雜湊必變、一律重按\*\*；刪掉並存的別組、或那一組的位置變了＝也重按；沒有任何一種換法可以免重按——複本內容改了而那一行沒動，不是免重按、是指紋對不上＝所有 mcp\_\_ 工具全擋；順序＝tools\/guard\-copy\.js 檔頭⓪〜⑥）、叫清單上刻意放的那個無害測試工具（＝mcp\_\_guard\_canary\_\_ping，本體 tools\/canary\-server\.js，照第 8 題 a 永久留在 forbidden\.deny：它真的存在、就算真的執行了也不會碰到禁區、不會造成任何改變，\*\*而且不是禁區連接器（forbidden\.servers）上的工具——那上面的每一支，連唯讀的查詢、提醒、觀察清單，都不可以拿來試\*\*；驗收只准用它，不可以拿任何別的工具代替），要看到這一組的拒絕理由（含「在拒絕清單上」）——任何會碰到禁區的真工具（包括禁區連接器上的每一支），不論在不在清單上、不論攔截器擋不擋得住，一律絕不可以叫來試；驗收只准用那個無害測試工具，最後才刪舊複本。②只在安裝時用的（templates\/hook\-claude\.json、templates\/hook\-claude\-pinned\.json、templates\/hook\-codex\.json、templates\/hook\-codex\-global\.json、tools\/guard\-copy\.js）：已裝好的鉤子不會重讀它們——範本的指令有改，就要把新指令換進\*\*已經裝了那份範本的地方\*\*（哪一側裝了哪一份＝看 PROJECT\.md 搬家那一段，這裡不寫；沒裝的範本改了＝沒有東西要換）：hook\-claude\-pinned\.json 已裝在專案 \.claude\/settings\.json（2026\-09\-19 起）：範本的指令改了＝同一支用 node tools\/guard\-copy\.js \-\-claude\-line 換那兩組→審查、合併→每台機器：更新（桌面捷徑）→跑 node tools\/guard\-copy\.js \-\-claude（四個檔沒動＝指紋不變、那一份已經在，照樣試跑一次）→關掉所有 Claude 對話重開（更新之後才重開）→叫測試鈕看到「在拒絕清單上」。只改範本時四個檔沒動、指紋不變，新舊兩行讀同一份複本、印同一句拒絕——這一下只證明載入的那一行擋得住、分不出新舊；新那一行有沒有載入靠的是「更新之後才重開」；hook\-claude\.json（活讀那一份）2026\-09\-19 起本專案沒裝——改了沒有東西要換；hook\-codex\.json 是 Codex 專案層那份——本專案沒裝（Codex 側走全域層），改了沒有東西要換，哪天要裝＝放進 \.codex\/hooks\.json、William 按信任；hook\-codex\-global\.json＝照①重抽並換組、重按信任。只改 tools\/guard\-copy\.js 而範本沒改，已安裝的不受影響，下次抽複本才用到。不做＝繼續跑舊指令或舊清單，沒有機器提醒。③測試鈕（tools\/canary\-server\.js、\.mcp\.json）：本體或登記一改，Claude 側要開新對話、Codex 側要關掉所有視窗再開，然後再叫一次測試鈕——要看到\*\*那一組\*\*的拒絕理由（含「在拒絕清單上」）才算數；\*\*看到 pong 一律不算通過\*\*：任一側看到 pong＝那一組沒載入或沒在跑，停下來查、回報，不改設定（它是驗收攔截器的唯一合法方式，壞了等於沒有驗收工具；裝法＝templates\/canary\-install\.md）。步驟與目的地規則＝tools\/guard\-copy\.js 檔頭與 templates\/hook\-codex\-global\.json 的說明。補複本（\-\-claude）與重抽（\-\-from … \-\-to …）一律用已更新那棵樹的 tools\/guard\-copy\.js（2026\-09\-27 起它從 forbidden\.safeServers 產試跑用的放行假名：safeServers 是空的＝拒絕完成安裝；舊版拿新清單自我試跑不過、同樣拒絕完成安裝）。 |
| A（資料庫結構） | 重啟套不上：照 docs\/c6\-deploy\-and\-adversarial\-review\-runbook\.md 在 Supabase SQL Editor 重跑整份 db\/supabase\-schema\.sql（冪等），再照那份手冊驗；同支若也命中 C，本機 LOCAL 照 C 做。 |
| B（相依套件） | 先裝再重啟：桌面捷徑「重啟理財網頁\.command」（住桌面、不在 repo）pull 到動 package\*\.json 的版本時會自動 npm install；走 repo 裡的 start\.command（不 pull、只在沒有 node\_modules 時裝）或主目錄已是最新版（沒有 pull 可做）就要在主目錄手動 npm install；裝完不可以停在這裡，接著照做：擁有者 重啟 App、以實際操作走完最核心的一條流程（PR 說明「怎麼驗收」那三句）；HOSTED 等 Render 重新部署後在線上走同一條。 |
| C（要重啟＋走核心流程） | 擁有者 重啟 App、以實際操作走完最核心的一條流程（PR 說明「怎麼驗收」那三句）；HOSTED 等 Render 重新部署後在線上走同一條。 |
| D（只動前端） | 重新整理頁面、看一眼「怎麼驗收」三句寫的畫面即可，不必重啟（沒有 service worker，express\.static 直接供應）。 |
| P（原型） | prototype\/ 不由 server\.js 供應：要看就開原型自己的預覽，不重啟理財 App。 |
| E（不需驗收） | 這一級的路徑本身不需驗收：同支若另列了其他級的動作，照那些做、這一行不算數；只有這一級（或只另有 F）時，回報寫「不需驗收：只動了 …」。 |

| 路徑家族（正規式） | 級別 |
|---|---|
| \^\\\.codex\/hooks\\\.json\$ | F（工具安全設定） |
| \^\\\.claude\/settings\\\.json\$ | F（工具安全設定） |
| \^settings\\\.json\$ | F（工具安全設定） |
| \^tools\/\(forbidden\-tools\|settings\-data\|guard\-copy\)\\\.js\$ | F（工具安全設定） |
| \^tools\/package\\\.json\$ | F（工具安全設定） |
| \^templates\/hook\-\(claude\|claude\-pinned\|codex\|codex\-global\)\\\.json\$ | F（工具安全設定） |
| \^\\\.mcp\\\.json\$ | F（工具安全設定） |
| \^tools\/canary\-server\\\.js\$ | F（工具安全設定） |
| \^db\/ | A（資料庫結構） |
| \^package\(\-lock\)\?\\\.json\$ | B（相依套件） |
| \^lib\/ | C（要重啟＋走核心流程） |
| \^server\\\.js\$ | C（要重啟＋走核心流程） |
| \^start\\\.command\$ | C（要重啟＋走核心流程） |
| \^\\\.node\-version\$ | C（要重啟＋走核心流程） |
| \^render\\\.yaml\$ | C（要重啟＋走核心流程） |
| \^scripts\/check\-node\-version\\\.js\$ | C（要重啟＋走核心流程） |
| \^public\/ | D（只動前端） |
| \^public\-site\/ | D（只動前端） |
| \^prototype\/ | P（原型） |
| \^test\/ | E（不需驗收） |
| \^test\-doubles\/ | E（不需驗收） |
| \^docs\/ | E（不需驗收） |
| \^\[\^\/\]\+\\\.md\$ | E（不需驗收） |
| \^\\\.github\/ | E（不需驗收） |
| \^data\/seed\\\.json\$ | E（不需驗收） |
| \^scripts\/\(check\-ci\-really\-ran\|check\-cross\-pr\-merge\|check\-pr\-collab\-fields\|check\-pr\-merge\-gate\|check\-review\-verdicts\|check\-worktree\-integrity\|audit\-grok\-scan\|grok\-scan\|grok\-bump\|grok\-relay\|grok\-auth\-refresh\|grok\-sandbox\-canary\|c6\-adversarial\|acceptance\-tier\|pending\-rulings\)\\\.js\$ | E（不需驗收） |
| \^scripts\/grok\-sandbox\\\.sb\$ | E（不需驗收） |
| \^scripts\/git\-hooks\/ | E（不需驗收） |
| \^\(eslint\\\.config\\\.js\|jsconfig\\\.json\|mutate\\\.sh\|\\\.gitignore\)\$ | E（不需驗收） |
| \^\\\.claude\/launch\\\.json\$ | E（不需驗收） |
| \^tools\/ | E（不需驗收） |
| \^tests\/ | E（不需驗收） |
| \^templates\/ | E（不需驗收） |
| \^rules\\\.json\$ | E（不需驗收） |
| \^kit\-lock\\\.json\$ | E（不需驗收） |
| \^cases\/DIGEST\\\.md\$ | E（不需驗收） |

沒列到的路徑一律當：C（要重啟＋走核心流程）

## 九、風險分級（規矩 D4；合併前算，跟第八節合併後的驗收是兩張不同的表）

| 路徑家族（正規式） | 風險級別 |
|---|---|
| \^public\/\[\^\/\]\+\\\.css\$ | 低 |
| \^public\-site\/\[\^\/\]\+\\\.css\$ | 低 |
| \^public\/\.\*\\\.\(js\|html\|ts\)\$ | 中 |
| \^public\-site\/\.\*\\\.html\$ | 中 |
| \^test\/ | 低 |
| \^docs\/ | 低 |
| \^\(README\|PROJECT\)\\\.md\$ | 低 |
| \^docs\/contracts\/ | 高 |
| \^docs\/\(project\-collaboration\|money\-guard\-operations\|money\-guard\-two\-pattern\-tables\|github\-branch\-protection\-setup\)\\\.md\$ | 高 |

沒列到的路徑算高（規矩 D4：判不出＝高）。

升級條件（內容碰到任一條，整支就算高）：

- 改到「金額」、「資料存取」、「機密」、「判準」、「禁區」或「閘」的做法（只是提到這些字不算）
- 刪掉或放寬「既有考題」的行為檢查
- 改到「契約」規定的行為或契約文件本身的做法（只是提到這個詞不算）
- 改到兩頁以上共用的畫面程式的做法（只是提到不算）
- 前端開始讀新的後端欄位

## 十、複審與掃描分級（規矩 F2、G1；複審者的模型與推理見第十一節、掃描者的見第四節）

| 風險級別 | 全審 | 只核差異 | 通過後照 F6 回頭改的那一輪 | 掃描 |
|---|---|---|---|---|
| 高 | 每一輪 | 不適用 | 全審 | 掃 |
| 中 | 第 1〜7 輪 | 第 8 輪起 | 只核差異 | 掃 |
| 低 | 第 1〜3 輪 | 第 4 輪起 | 只核差異 | 不掃 |

## 十一、複審者的模型與怎麼起（規矩 F1、F11；每個 AI 一列，換新模型改這裡——有釘值題的專案連釘值題一起改，套件倉庫自己的是 kit-only/settings-pin.test.js）

| 複審者 | 最強模型 | 次強模型（額度用完才用） | 最高推理 | 不開的自動模式 |
|---|---|---|---|---|
| Claude | claude\-fable\-5\-1 | claude\-opus\-5\-5 | max | Ultracode |
| Codex | gpt\-6\-astra | gpt\-6\-sol | max | ultra（這一檔會自動派助手） |

| 複審者 | 怎麼起（含放行哪些考題指令） | 機器擋得住的 | 只靠提示的、已知缺口 | 驗過的日期 |
|---|---|---|---|---|
| Claude | 送審產生器 node tools\/review\-launch\.js \<編號\> \-\-reviewer \<識別值\> 照下一格的樣板印出填好的那一行；為什麼這樣寫見 README\.md「本倉庫自己怎麼合併」的「送審」那一項 | 放行清單以外的指令一律被拒（不跳出詢問）；Edit 工具改不了審查樹、只准改突變副本；不讀主目錄的本機設定檔 | 放行的指令仍可能寫檔（例如 git diff 的 \-\-output），副本裡改了程式再跑考題＝能跑任意程式，所以審查樹唯讀靠提示；讀檔的禁令管不到考題程式自己讀檔；助手被拒時最後的輸出看不到，要逐筆搜「has been denied」 |  |
| Codex | 送審產生器 node tools\/review\-launch\.js \<編號\> \-\-reviewer \<識別值\> 照下一格的樣板印出填好的那一行；為什麼這樣寫見 README\.md「本倉庫自己怎麼合併」的「送審」那一項 | 幾乎沒有：審查樹與系統暫存區都寫得進；使用者層放行規則命中的指令在沙箱外跑；樣板帶 approval\_policy＝never，申請提權一律不准（不帶就照本機設定檔自動核准） | 唯讀、不轉正式、不合併、只貼一則留言，全靠提示；退出 0 不代表通過、也不代表留言已貼成功（啟動失敗會退非零），發審的一方要自己去 PR 看留言在不在；設定檔預設推理是 low，指令漏帶就靜默降級；唯讀沙箱配 \-\-add\-dir 突變副本（2026\-10\-07 實測）連副本、暫存區、網路都被擋，不能拿來讓審查樹唯讀 |  |

| 複審者 | 結論標頭的來源字串 | 啟動指令樣板（送審產生器替換記號後印出） |
|---|---|---|
| Claude | Claude CLI | cd \{reviewTree\} \&\& claude \-p \"\$\(cat \{promptFile\}\)\" \-\-model \{model\} \-\-effort \{effort\} \-\-permission\-mode dontAsk \-\-setting\-sources user\,project \-\-add\-dir \{mutationCopy\} \-\-verbose \-\-output\-format json \-\-allowedTools \'Read\,Grep\,Glob\,Bash\(node \-\-test \*\)\,Bash\(npm \-\-prefix \{mutationCopy\} test \*\)\,Bash\(git diff \*\)\,Bash\(git log \*\)\,Bash\(git show \*\)\,Bash\(git rev\-parse HEAD\)\,Bash\(git \-C \{mutationCopy\} rev\-parse HEAD\)\,Bash\(git \-C \{mutationCopy\} status \-\-porcelain\)\,Bash\(git \-C \{mutationCopy\} diff\)\,Bash\(gh pr view \*\)\,Bash\(gh pr diff \*\)\,Bash\(gh pr checks \*\)\,Bash\(gh run view \*\)\,Bash\(gh run list \*\)\,Bash\(gh pr comment \{change\} \*\)\,Edit\(\/\{mutationCopy\}\/\*\*\)\,Workflow\' \-\-disallowedTools \'Write\,NotebookEdit\,WebFetch\,WebSearch\,Edit\(\/\{reviewTree\}\/\*\*\)\,Bash\(gh pr merge \*\)\,Bash\(gh pr edit \*\)\,Bash\(gh pr close \*\)\,Bash\(gh pr review \*\)\,Bash\(gh pr ready \*\)\,Bash\(git push \*\)\,Bash\(git commit \*\)\,Bash\(git checkout \*\)\,Bash\(git switch \*\)\,Bash\(git stash \*\)\,Bash\(git worktree \*\)\,Bash\(git fetch \*\)\,Bash\(npm install \*\)\,Bash\(npm ci \*\)\,Bash\(npx \*\)\,Bash\(node \-e \*\)\' \< \/dev\/null \> \{outFile\} |
| Codex | codex CLI | codex exec \-m \{model\} \-c model\_reasoning\_effort\=\'\"\{effort\}\"\' \-c approval\_policy\=\'\"never\"\' \-s workspace\-write \-c sandbox\_workspace\_write\.network\_access\=true \-C \{reviewTree\} \- \< \{promptFile\} \> \{outFile\} 2\>\&1 |

送審產生器另外要的：PR 網址樣板 https\:\/\/github\.com\/\{project\}\/pull\/\{change\}；留言網址樣板 https\:\/\/github\.com\/\{project\}\/pull\/\{change\}\#issuecomment\-\{comment\}；複審者貼結論的指令 gh pr comment \{change\} \-R \{project\} \-\-body\-file \<你寫好的結論檔\>；在突變副本裡跑考題 npm \-\-prefix \{mutationCopy\} test \-\- \<考題檔\>

## 十二、忽略清單登記（規矩 B4、E7；考題比對每一份的生效樣式）

- \.gitignore：data\/store\.json、data\/store\.json\.bak、data\/store\.db、data\/store\.db\.bak、data\/\*\.db、data\/\*\.db\-wal、data\/\*\.db\-shm、data\/store\.manual\-backup\-\*\.json、data\/\*backup\*、\*\.bak、\.claude\/settings\.local\.json、node\_modules、\.codex\-reviews\/、tmp\/、output\/、\*\.log、\.DS\_Store、\*\*\/\.DS\_Store、\/\.agents\/、\/skills\-lock\.json、\/meeting\.sh、\/meeting\_0724\_1414\.md、\*\.grok\-bump\-tmp、\/lib\/\_xlsx\_guard\_probes\/、\/public\/\_xlsx\_guard\_probes\/、\.env、\.env\.local
- prototype\/forest\-ui\-lab\/\.gitignore：assets\/\*\.png、assets\/\*\.jpg

## 十三、合併步驟登記（規矩 H1；合併指令照這個順序跑，任一道紅就停）

| 順序 | 閘 | 規矩 | 指令 | 狀態 |
|---|---|---|---|---|
| 1 | 待裁（本支貼的 ❓ 都配到 ⚖️ 或 🚫） | A5 | node tools\/gates\/check\-pending\-rulings\.js | 已安裝未啟用 |
| 2 | 協作欄位（四欄齊全、實作者不等於複審者） | A2、E1 | node tools\/gates\/check\-collab\-fields\.js | 已啟用 |
| 3 | 複審結論聯集（有沒有未撤銷的阻擋、有沒有對目前版本的通過） | A2、F4、F5 | node tools\/gates\/check\-review\-verdicts\.js | 已啟用 |
| 4 | 真考卷（必要檢查最新場次真的跑過且成功） | H3 | node tools\/gates\/check\-checks\-really\-ran\.js | 已啟用 |
| 5 | 堆疊（底是主幹、上面沒有疊別支） | H2 | node tools\/gates\/check\-stacked\.js | 已啟用 |
| 6 | 跨PR試合併（與每支以主幹為底的開著PR真合起來跑三關） | H4 | node tools\/gates\/check\-cross\-merge\.js | 已啟用 |

全綠之後執行的合併指令：gh pr merge \{change\} \-R \{project\} \-\-squash \-\-delete\-branch \-\-match\-head\-commit \{sha\} \-\-body \"Reviewed\-By\: \{reviewer\}\\nMerged\-By\: \{merger\}\"

合併指令認得的記號：{change}（PR編號）、{sha}（按鍵前核過的版本）、{project}（platform.project）、{reviewer}（PR說明「複審者」欄那一位）、{merger}（跑 node tools/merge.js <編號> --merger <識別值> 自報的那一位）。帶上 {reviewer}／{merger} 合併紀錄才留得下誰複審、誰按合併鍵（H5）；帶上 {sha} 平台才會替你擋最後一刻被推上來的新版本。認不得的記號＝不放行。

⚠️ 沒有任何一道閘登記成「已啟用」時，合併指令不放行：一支什麼都沒檢查就按合併鍵的指令比沒有更危險。

## 十四、機器啟用狀態（逐支登記；「已啟用」以外的一律當靠自覺）

| 機器 | 規矩 | 狀態 | 驗過的日期 |
|---|---|---|---|
| 平台介面（閘、待裁清單與下游落後問平台的十二個動作，答案形狀不合就不放行） | E5、H1 | 已啟用 | 2026\-09\-14 |
| 合併指令（依序跑完登記的閘，任一道紅就停） | H1 | 已啟用 | 2026\-09\-14 |
| 協作欄位閘（四欄齊全、實作者不等於複審者） | A2、D3、E1 | 已啟用 | 2026\-09\-14 |
| 結論聯集閘（阻擋只有同一位能解除、放行只認指定那一位對目前版本的通過） | F4、F5、F7 | 已啟用 | 2026\-09\-14 |
| 禁區攔截器（判斷一份，兩家 AI 的鉤子都呼叫它） | B1 | 已啟用 | 2026\-09\-17 |
| 忽略清單一致考題（登記的每一份忽略檔跟生效的樣式一字不差） | B4、E7 | 已啟用 | 2026\-09\-15 |
| 推送前鉤子範本＋三關執行器（讀設定的三關、前後驗工作資料夾（樹）） | E2 | 已啟用 | 2026\-09\-17 |
| 雲端三關與協作欄位閘的範本 | E3 | 已啟用 | 2026\-09\-17 |
| 清版本控制環境變數的共用實作（GIT\_ 前綴整族清） | E4 | 已啟用 | 2026\-09\-15 |
| 閘的退出路徑與進入點行為題（每一道閘的考題各有「真的跑一遍指令」與「問不到＝退 2」） | E5 | 已啟用 | 2026\-09\-15 |
| 檔名考題（已追蹤路徑只用可見 ASCII；例外名單寫死、只出不進） | E6 | 已啟用 | 2026\-09\-15 |
| 掃描前試探（禁區各埋一個假機密，從盒內試讀試寫；隔離本身由專案設定指定誰提供） | G2 | 已啟用 |  |
| 掃描後比對（假機密與未給盒子的真值不得出現在回覆、日誌、檔名） | G2 | 已啟用 |  |
| 合併閘登記對帳題（磁碟上的閘 vs 設定登記的閘） | H1 | 已啟用 | 2026\-09\-15 |
| 堆疊閘（底必須是主幹、不可以有別支疊在上面） | H2 | 已啟用 | 2026\-09\-14 |
| 真考卷閘（必過檢查在那顆版本上真的跑過且成功） | H3 | 已啟用 | 2026\-09\-14 |
| 跨PR試合併閘（與每支以主幹為底的開著PR真合起來跑三關） | H4 | 已啟用 | 2026\-09\-18 |
| 驗收分級工具（路徑家族表住設定；只算不擋） | H6 | 已啟用 | 2026\-09\-17 |
| 本文長度考題 | K2 | 已啟用 | 2026\-09\-15 |
| 案例簿考題＋索引產生器 | K1、K2 | 未移植 |  |
| 共用檔清單（釘住套件版本；專案改到套件的檔要記例外） | E7、K1 | 已安裝未啟用 |  |
| 專案設定產生器 | K1 | 已啟用 | 2026\-09\-15 |
| 範本存在與固定小標考題 | E1、G3 | 已啟用 | 2026\-09\-15 |
| 路標考題（帶記號的引號路標要指得到） | K3 | 已啟用 | 2026\-09\-15 |
| 待裁清單工具（掃整個專案的留言；只列不擋） | D1、I3 | 已啟用 | 2026\-09\-17 |
| 待裁閘（本支貼的 ❓ 還沒配到 ⚖️ 或 🚫 就不放行；判斷用待裁清單工具那一份） | A5 | 已安裝未啟用 |  |
| 風險分級工具（合併前依檔案算風險級別、印出複審與掃描分級表那一列，只算不擋） | D4 | 已安裝未啟用 |  |
| 舊文字掃描（列出這支刪掉或改掉的字串還出現在哪，只列不擋） | K5 | 已安裝未啟用 |  |
| 開工印待辦（列出待辦清單裡提到這支改到的檔的那幾條，只列不擋） | F6 | 已安裝未啟用 |  |
| 進度摘要檢查（摘要每則的形狀、兩個時間、沒動的線、附件條號、已合併對不對得上平台，只列不擋） | J5 | 已安裝未啟用 |  |
| 本週成果產生器（最近七天合併進主幹的 PR 照日期列成摘要那一節，\-\-write 才換掉那一節） | J5 | 已安裝未啟用 |  |
| 下游落後（套件這一邊印出登記的使用專案落後幾支、哪些共用檔不同、設定少哪些欄位與機器列，只列不擋） | K1 | 已安裝未啟用 |  |
