#!/usr/bin/env node
// 禁區攔截器的固定複本（規矩 B1；裁示 6a＋7b；Claude 側釘指紋＝裁示者 2026-09-18 裁）：從專案**已合併進主幹**的一個版本
// 抽出攔截器跑起來會讀到的那幾個檔，寫進一個版本控制以外的目錄，算出指紋。兩種接線讀的都是這種複本、指令裡都寫死指紋：
//   Codex 全域層＝印出一組貼進 Codex 全域鉤子檔的接線（複本路徑與指紋都寫死在指令裡）；
//   Claude 側釘指紋裝法＝那一行住在進版控的專案設定檔裡、跨機器共用，所以只寫指紋、不寫任何一台機器的路徑；
//     複本的位置固定是 <家目錄>/.local/share/ai-collab-kit/guard/<指紋>（內容定址：目錄名就是那一行拿來找它的鍵）。
//
// 為什麼：Codex 的全域鉤子套到每一個 session，不能靠「當下在哪個專案」找攔截器，所以讀一份固定複本（裁示 6a）。
// 但 Codex 的「信任」只記鉤子那一行指令的雜湊，指令引用的檔案不在信任範圍內——複本被改＝不必重按信任就生效，
// 而且沒有人看得到。所以指令裡寫死指紋：複本的指紋對不上就退 2（所有 mcp__ 工具都擋、看得見的失敗），
// 要改清單＝重抽複本＋換一行新指令＋裁示者重按信任，負擔跟今天一樣（裁示 7b）。
// Claude 側為什麼也釘：活讀裝法（templates/hook-claude.json）每次呼叫都讀當下那棵樹的清單——在樹裡把清單改弱、或切到弱清單的分支，
// 下一次呼叫就照弱的判。釘指紋那一行不看所在目錄、不碰 git，只照倉庫外那一份判：樹裡的清單怎麼改都沒有用。
// 那一行在同一支變更裡換了、而這台機器還沒補那一份複本＝那一行找不到複本＝所有 mcp__ 工具全擋（看得見）；
// 改了那四個檔卻沒重印那一行＝那一行照舊指紋找到舊複本、**靜靜照舊清單判**（收緊不生效、沒有訊號），唯一會紅的是等式題 tests/claude-pin.test.js
//（這個情境與「換了、沒補＝全擋」的對照，tests/guard-copy-claude.test.js ⑬ 真的跑過）。
//
// 分工：指令的**文字**每種接線各只有一份＝templates/hook-codex-global.json、templates/hook-claude-pinned.json
//（--from／--claude **從同一個版本讀**範本、--claude-line 讀工作樹的範本；這支只把佔位換掉）；
// 判斷只有一份＝tools/forbidden-tools.js。這支**不碰**家目錄的 .codex 或 .claude（不讀、不寫；複本也不准放在那兩個目錄底下）、
// 也不碰專案的 .claude/settings.json：貼上與按信任是人的事。
//
// 用法（四種，不能混用）：
//   node tools/guard-copy.js --from <已合併進主幹的版本> --to <絕對路徑的空目錄> [--deny-probe <照清單該擋的假工具名>]
//     Codex 全域層。標準輸出＝要貼的那一組接線（JSON）；標準錯誤＝人讀的摘要。
//     退 0＝寫好而且自我試跑過；退 2＝拒絕（什麼都沒寫）；
//     退 1＝寫了東西但沒成功（自我試跑沒過、或寫到一半出錯）：標準輸出是空的、沒有東西可以貼，目的地可能留有複本或半份，
//     這一種用法不刪它——看完自己刪，下次換一個新的空目錄。
//   node tools/guard-copy.js --claude [--from <已合併進主幹的版本>] [--deny-probe <照清單該擋的假工具名>]
//     Claude 側補複本（不給 --from＝抽這棵樹設定的 origin/<主幹>）。要落地的話，先用這個家跑一次 /bin/sh -lc ':'：標準輸出不是空的
//     （登入設定往標準輸出印字）＝不落地、退 1。再寫進基底目錄裡一個暫存骨架、把 HOME 指到骨架真的跑那一行，
//     過了才改名落地成 <家目錄>/.local/share/ai-collab-kit/guard/<指紋>；落地之後把 HOME 指到這個家、照「已經在」那條路再跑一次
//     （這一次才讀得到這個人的登入設定），沒過＝把這一次自己落地的那一份撤掉、退 1。
//     暫存骨架（基底目錄裡 .staging- 開頭的目錄）試跑過不過都由這支自己清掉——清不掉時訊息照實說「暫存骨架沒清掉：<路徑>」；
//     這支被中途殺掉的話它也會留著。兩種都可以直接刪，那一行不會去讀它。
//     **落地之後、第二次試跑跑完之前被中斷（例如 Ctrl-C）＝那一份留著**、沒有在這個人的登入設定下驗過；下一次再跑走「已經在」那條路：
//     試跑沒過只退 1、不撤它（訊息寫明那一行現在就照用這一份：讓登入設定安靜，或 --retire <指紋>，之後全擋、看得見）。
//     那個目錄已經在、而且自洽（是真的目錄、剛好那四個檔、沒有連結、每個檔小於 1 MiB、重算的指紋＝目錄名）＝不寫，照樣試跑（HOME＝這個家）；
//     在、但不自洽＝退 2，不覆寫也不刪它。
//     標準輸出＝指紋一行；退 0＝那一份在而且試跑過；退 2＝拒絕（沒有落地任何東西）；
//     退 1＝試跑沒過或途中出錯：這一次沒有留下落地的東西（落地後才沒過的撤掉了；撤不掉時訊息照實說它還在），原本就在的那一份不動；
//     例外＝上面那一種「落地後試跑途中被中斷」：那一份留著。
//   node tools/guard-copy.js --claude-line
//     只印：讀**工作樹**的四個檔與工作樹的範本（改清單的那一支變更還沒合併，也要能在同一支裡產出新的那一行），
//     標準輸出＝要放進專案 .claude/settings.json 的兩組（PreToolUse 釘指紋那一行、ConfigChange 設定變更攔截）。不寫任何檔、不需要 git。
//   node tools/guard-copy.js --retire <64 碼指紋>
//     退役一份舊的 Claude 側複本：只刪名字是 64 碼十六進位、而且自洽的目錄（這支工具唯一會刪別人看得到的東西的用法）；
//     別種名字的目錄（Codex 全域層那種人取的短名字）一律不碰；名字對、內容不自洽＝不刪，看過之後自己處理。
//     基底目錄（或它的上層）是連結、解開之後在家目錄的 .claude／.codex 底下＝退 2、不碰（跟 --claude 同一個檢查）；
//     讀不了基底（例如有一層不給進）＝退 2、照實說確認不了、不刪；只有基底確實不存在才說「沒有東西可以退役」。
//
// Codex 全域層：裝與換只有一條順序（專案裡要看得到：套件的 README 不跟著搬進專案；README 第 3 步是同一份順序的抄本）：
//   ⓪先確認禁區清單（settings.json 的 forbidden.deny）裡有一個刻意放的無害測試工具：它要是 Codex 連得到的伺服器上真的存在的 mcp__ 工具，就算真的執行了也不會動到禁區、不會造成任何改變，而且不可以是禁區連接器（forbidden.servers）上的任何工具——連唯讀的查詢也不行；原本還有別的攔截組並存時，挑一個只有這份清單擋、別組不擋的名字。套件帶了一支現成的＝tools/canary-server.js（掛上去只回一句 pong，什麼都不做），工具名 mcp__guard_canary__ping，兩家 AI 各登記一次的做法見 templates/canary-install.md。清單上還沒有就先加、合併，再從①開始——沒有就停下來，不可以拿任何別的工具代替。
//   ①先 git fetch，在專案裡跑 node tools/guard-copy.js --from <已合併進主幹的版本> --to <新的空目錄>（建議家目錄底下固定的地方，例如 ~/.local/share/ai-collab-kit/guard/<版本碼前幾碼>）。
//   ②關掉所有 Codex 視窗（改鉤子檔到按下信任之間，改過的那一組是停用的：Codex 對沒信任的鉤子一聲不吭地跳過，這段時間不能有 Codex 在跑）。
//   ③編輯家目錄 .codex/hooks.json：第一次裝＝把印出的那一組加到 hooks.PreToolUse 最後面（原本有別的攔截組就讓它們並存）；換新複本＝在原位置換掉舊複本那一組。
//   ④開 Codex、按信任。
//   ⑤在 Codex 叫⓪那個無害測試工具：要看到被擋，而且擋的理由是這一組的（理由含「在拒絕清單上」；「固定複本不在、被改過…（指紋對不上）」那一句不算，那是複本壞了）。叫一般工具照常能用證明不了什麼（鉤子沒跑時它也能用）。
//   ⑥⑤沒看到這一組的拒絕＝關掉 Codex、把原來那一組放回去（換新複本時舊複本目錄還在）、按信任，再查原因；⑤過了、而且是換新複本，這時才刪舊的複本目錄（先 chmod -R u+w；先刪會讓舊那一組把所有 mcp__ 工具全擋）。
//   之後要拆掉並存的別的攔截組：同樣先關 Codex、刪那一組、對剩下的按信任（位置變了），再做一次⑤。
//   要重抽的時候＝settings.json 的 forbidden 那一塊、tools/forbidden-tools.js、tools/settings-data.js、tools/package.json、或 templates/hook-codex-global.json 那一組合併了改動：照⓪〜⑥重做；不重抽＝Codex 照抽的那個版本判，沒有機器提醒。
//   ⚠️ 任何會動到禁區的真工具，不論在不在清單上、不論攔截器擋不擋得住，一律絕不可以叫來試；驗收只准用⓪那個無害測試工具。
//
// Claude 側釘指紋裝法：裝與換的順序（跟活讀那份範本 templates/hook-claude.json 二擇一；⓪同上——清單上要先有那個無害測試工具，下面叫它「測試鈕」）：
//   第一次裝：
//   ①先補複本：git fetch，在專案裡跑 node tools/guard-copy.js --claude。這時接線還沒換——試跑沒過就停在這裡，不會有全擋的空窗。
//     不要用檔案管理程式打開複本目錄：它可能在裡面放東西（例如 .DS_Store；沒量），放了＝那一行全擋（看得見）；
//     補救＝看過之後把那個目錄整個移走（mv）再跑 --claude（--retire 不收多了東西的目錄）。
//   ②跑 node tools/guard-copy.js --claude-line，把印出的那兩組放進專案的 .claude/settings.json（釘指紋那一組換掉活讀那一組；
//     專案原有的 permissions.deny 不動），走一支變更、審查、合併。不要手改那一行。
//   ③合併後：更新→關掉所有 Claude 對話重開→按測試鈕，要看到拒絕理由含「在拒絕清單上」才算數。
//     看到的是「…（指紋對不上）」那一句＝這台機器沒有那一行要的那一份（①抽的版本跟合併後的四個檔不是同一份內容）：再跑一次 --claude、再按。
//   之後每次改到那四個檔（settings.json 的 forbidden 那一塊、tools/forbidden-tools.js、tools/settings-data.js、tools/package.json）：
//   ④同一支變更裡重跑 --claude-line 把那兩組換掉→審查、合併。沒換＝那一行照舊指紋找到舊複本、靜靜照舊清單判（收緊不生效、沒有訊號）；
//     唯一會紅的是等式題 tests/claude-pin.test.js（使用專案要有那一題，而且不能跳過）。
//   ⑤每台機器：更新→關掉所有 Claude 對話重開→按測試鈕。**這一下應該先看到「…（指紋對不上）」、沒有 pong**——複本還沒補；
//     補複本刻意不自動（裁示者 2026-09-18）：這一下等於順便重量一次「複本不在＝全擋」這條路還有沒有效
//     （只量到 PreToolUse 那一行；ConfigChange 那一組不在這一下量得到的範圍裡，見下面誠實劃界）。
//   ⑥git fetch、跑 --claude 補複本→再按一次，要看到「在拒絕清單上」。收緊清單的時候多一步：舊的那一份用 --retire <舊指紋> 退役。
//   ⚠️ 同上：驗收只准用測試鈕，任何會動到禁區的真工具一律絕不可以叫來試。
//
// 誠實劃界：指紋只蓋複本裡的檔，不蓋 node 本身、shasum 本身、PATH 找到哪一支 node（登入設定改了 PATH 就換了一支）；
// 檢查與執行之間的極短空檔被換檔擋不住（防的是漂移與誤改，不是本機有人蓄意競速；Claude 側那一行的 find 查完、shasum 讀檔之前
// 被換成具名管道＝那一行掛到平台逾時（官方鉤子文件寫 PreToolUse 的指令鉤子逾時不擋），也屬於這一條）；
// 「已合併」看的是本機的 origin/<主幹> 追蹤參照（先 fetch）；自我試跑是在這支的環境裡跑，Codex 起鉤子的環境不一定一樣。
// Claude 側釘指紋另外要知道的（只寫量到的；量測＝2026-09-18，Claude Code 2.1.275 桌面版，第一個使用專案的拋棄式樹）：
//   ・量到的：鉤子退 2＋錯誤輸出真的擋工具；鉤子的環境有 HOME、用 /bin/sh 起、node 在 PATH 上找得到、shasum 是 /usr/bin/shasum；
//     那一場（從專案根開的對話）工作目錄是專案根——釘指紋那一行不靠它（先 cd 進複本）。
//   ・Claude 起鉤子是不是登入 shell 沒量，一律當成可能是：拒絕走標準輸出的 JSON，登入設定往標準輸出印字＝拒絕形狀被弄髒＝平台讀不出來＝放行。
//     所以試跑 /bin/sh -c 與 -lc 各一遍、兩種都要過；新落地時先用這個家跑一次 /bin/sh -lc ':'（標準輸出不是空的＝不落地），
//     再跑兩次試跑——落地前 HOME 指到暫存骨架（讀不到這個人的登入設定），
//     改名落地之後照「已經在」那條路用這個家再跑一次，沒過＝撤掉這一次落地的那一份、退 1（別的工作階段先落地的那一份不動；
//     第二次跑完之前被中斷＝那一份留著，見上面用法那一段）。
//     試跑仍是在這支的環境裡跑：PATH 等等跟 Claude 起鉤子時的環境不一定一樣。
//   ・**鉤子的環境被塞變數（SHELLOPTS、匯入的 shell 函式、PATH）這一類擋不住，那一行裡關不完；ConfigChange 那一條一樣擋不住**
//     （SHELLOPTS=noexec＝那一條也退 0：tests/guard-copy-claude.test.js ⑪）——這一類在場時，本檔說的「退 2」「全擋」都不成立。
//     SHELLOPTS=noexec＝整行不執行、退 0；匯入的函式（BASH_FUNC_名字%%）換得掉 cd、echo（換成 exit 0＝退 0＝放行）；PATH 決定跑哪一支 node。
//     那一行做了的只有：shasum、find、node 包進清空的環境（量過 NODE_OPTIONS、PERL5OPT 兩個進不來）、指紋比對用 case（保留字；
//     匯入名為 [ 的函式影響不到它：⑩）、設定變更攔截只剩 exit 2——在 /bin/sh（POSIX 模式；2026-09-18 量到鉤子的 $0 是 /bin/sh）下、
//     而且環境沒被塞 SHELLOPTS 之類的變數時，匯入名為 exit 的函式換不掉這個特殊內建（⑩）；非 POSIX 模式的 bash 換得掉（⑪ 用 /bin/bash 跑＝退 0）。
//     官方鉤子文件寫 shell 欄位預設「bash」、量到的是 /bin/sh：這個落差守不到（MACHINES.md B1）。那一行做了的還有一樣：
//     複本裡只准有那四個檔（一般檔、各小於 CLAUDE_MAX_FILE_BYTES）與 tools 目錄（PATH 的相對項目從當下目錄＝複本目錄算：
//     解到複本裡的（. 、node_modules/.bin）放一支假 node＝多一支檔＝退 2；解到複本外的（..）擋不住，屬於「PATH 決定跑哪一支 node」），
//     查到多的東西就不去算指紋（具名管道、極大的檔不會讓那一行掛到平台逾時：tests/guard-copy-claude.test.js ⑭）。
//     這一道查的是 cd 進去之後的複本裡面，看不到 <指紋> 那一層本身：那一層換成指向內容相同目錄的連結，那一行照用
//     （內容仍要對上指紋、換不成弱清單：⑯）；那一層是連結由 --claude（copyProblem）與 --retire 拒絕。
//     本機與專案設定檔的 env 鍵會不會傳進鉤子的環境沒量，當成會：絆線看它（tools/claude-pin.js）。考題＝tests/guard-copy-claude.test.js ⑦⑩⑪（⑪斷言放行＝照實的對照）。
//   ・**複本不是鎖**：內容定址的目錄，誰照同一個算法都造得出自洽的一份。它擋的是漂移與誤改（樹裡改清單、切分支、走進別棵樹都沒有用），
//     不是蓄意在倉庫外造一份弱複本、再把那一行指過去的人——那要動到專案的設定檔：提交了才進審查；只改工作樹不提交的話沒有人審，
//     而量到的是同回合就生效（見下一點）。Claude 側沒有「人按信任」那一下。
//   ・釘住的是清單與判斷程式（照倉庫外那一份判），**不是設定檔那一行**：量到對話中往專案 .claude/settings.json 多加一條鉤子同回合就生效；
//     原本那一行被換掉的情況沒量，一律當成會生效。所以範本同時帶一組 ConfigChange（設定變更攔截，matcher 只掛 project_settings，指令只有 exit 2）。
//     它量到的只有這些（量的時候那一組是對話中途裝上的）：退 2＝那一次專案設定檔的改動不被那個對話載入；磁碟上的檔照樣改得進去；
//     那個對話裡的 AI 沒有收到任何提示文字（官方文件也寫這個事件擋下時不顯示訊息；使用者畫面那一場沒記）；裝上它的那一次改動本身沒有觸發它；
//     本機設定檔（.claude/settings.local.json）與使用者層兩個來源沒量（matcher 刻意不掛 local_settings——推論、沒量：若跟專案設定檔同一個行為，
//     平台自己寫進那個檔的「以後不要再問」會在那個對話裡不生效）。
//     ConfigChange 在平台上擋不擋：2026-09-18 在 2.1.275 量過一次；裝上時的驗收要再量一次（這裡沒有寫怎麼量；照①〜⑥做的驗收量不到它）；
//     之後沒有任何例行動作重量它（測試鈕只走 PreToolUse 那一行）——平台改版後它若不再擋，不會有訊號。
//     平台改版後要重量的還有：起鉤子時清不清環境、用哪一種 shell 起、會不會把設定檔的 env 傳進來（考題都在跑考卷這台機器的 shell 上跑，看不到平台）。
//   ・本機設定檔量到可以在對話中加鉤子（同回合生效）；它能不能關掉整組鉤子沒量（那是往鬆的方向試），一律當成能。
//     那個檔不進版控，tests/claude-pin.test.js 那一題只是絆線、不是閘。
//   ・落後的樹與開著的舊對話照舊那一行找舊複本判（舊複本還在就是靜靜的）；任何合併過的舊版本都抽得回來，--retire 只能減輕。
//     **收緊變慢**：新清單要等合併、每台機器補複本、重開對話之後才生效。
//   ・那一行把 shasum 與 find 也包進清空的環境（shasum 是 perl 腳本，環境變數能讓它印出任意字串）；Codex 全域層那一行沒有包
//    （改它＝每個使用專案要重抽複本、重按信任，這次沒動），兩份範本驗指紋那一截因此不同字。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('./git-env.js');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_REL = 'templates/hook-codex-global.json';
const CLAUDE_TEMPLATE_REL = 'templates/hook-claude-pinned.json';
/**
 * 攔截器跑起來會讀到的每一個檔，照位元組順序排好（shasum 照這個順序算，這裡也照這個順序算）。
 * settings.json 在複本裡只留 forbidden 那一塊（攔截器只讀那一塊；別的欄位改了不必重抽、也不必重按信任）。
 * tools/package.json 是 Node 自己讀的（決定照 CommonJS 載入），程式層追蹤看不到，所以考題另外用行為證明。
 * 「讀到的＝這一份」由 tests/guard-copy.test.js 的載入追蹤盯著：攔截器多 require 一支檔，那題就紅。
 */
const COPY_FILES = ['settings.json', 'tools/forbidden-tools.js', 'tools/package.json', 'tools/settings-data.js'];
const PLACEHOLDERS = ['{copyDir}', '{files}', '{fingerprint}'];
/** Claude 側釘指紋那一行的佔位：沒有複本路徑——那一行進版控、跨機器共用，複本的位置固定從 $HOME 算。 */
const CLAUDE_PLACEHOLDERS = ['{files}', '{fingerprint}'];
/** Claude 側複本的基底目錄（相對家目錄）；範本的指令裡寫的是同一串（對不上＝試跑找不到複本＝不落地）。 */
const CLAUDE_BASE = ['.local', 'share', 'ai-collab-kit', 'guard'];
/**
 * Claude 側複本裡每個檔都要**小於**這個位元組數（1 MiB；第二輪審查 M）。範本那一行的 find 寫的是同一個數（-size -1048576c＝小於它），
 * 查到不小於它的檔＝當成多出來的東西、不去算指紋、直接退 2；copyProblem（--claude 認「自洽」、--retire 認可以刪）也用它。
 * 兩邊同一個邊界：收＝小於 1048576 位元組（find 的 -size -1048576c＝小於；copyProblem 的 size >= 上限＝不收），剛好 1048576＝兩邊都不收
 *（tests/guard-copy-claude.test.js ⑲ 對 settings.json 與 tools 底下的檔各跑剛好上限與少 1 位元組）。
 * 為什麼要上限：shasum 要讀完整個檔才比得出對不上，極大的檔會讓那一行拖到平台逾時，而 PreToolUse 的指令鉤子逾時不擋。
 * 為什麼是 1 MiB：2026-09-19 四個檔最大的是 tools/forbidden-tools.js，不到 10 KB，上限是它的 100 倍以上（清單與程式再長也夠）；
 * 那一天這台機器用 shasum 讀一個 1 GiB 的稀疏檔約 3.6 秒，讀四個 1 MiB 以內的檔不會拖到逾時。
 * 改這個數＝範本那一行跟著改（tests/guard-copy-claude.test.js ①對兩邊）＝使用專案要重印那一行（指紋不變，那一行的字變了：等式題會紅）。
 */
const CLAUDE_MAX_FILE_BYTES = 1048576;
/** 設定變更攔截只掛量過的那一個來源（2026-09-18；本機設定檔與使用者層沒量，local_settings 刻意不掛的推論見檔頭）。 */
const CONFIG_CHANGE_MATCHER = 'project_settings';
/** Claude 側複本的目錄名＝指紋：64 碼十六進位小寫。Codex 全域層那種人取的短名字不符合＝--retire 碰不到。 */
const FP_NAME = /^[0-9a-f]{64}$/u;
const UNSET = '未設定';
/** 自我試跑用的無害假名：依序試，有一個被乾淨地放行就算過（專案清單剛好擋到其中一個也不會誤判安裝失敗）。 */
const ALLOW_PROBES = ['mcp__guard_copy_selftest__noop', 'mcp__guard_copy_selftest__ping', 'mcp__kit_selftest_zz__hello'];
/** 暫存區：作業系統會清，複本放那裡哪天被清掉＝所有 mcp__ 工具突然全擋。 */
const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];
/** 放不進單引號的字元：單引號本身與控制字元（會把指令切壞）。 */
const unquotable = (p) => [...p].some((ch) => ch === "'" || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 指紋＝對「每個檔一行：<該檔的 sha256>兩個空白<相對路徑>換行」整段再取 sha256。
 * 這正是 `shasum -a 256 <檔…> | shasum -a 256` 印出的東西（前半段），所以鉤子指令不必信任 node 就能自己算。
 * @param {(rel: string) => Buffer} readFile
 */
function fingerprint(readFile) {
  return sha256(Buffer.from(COPY_FILES.map((rel) => `${sha256(readFile(rel))}  ${rel}\n`).join(''), 'utf8'));
}

const fingerprintDir = (dir) => fingerprint((rel) => fs.readFileSync(path.join(dir, rel)));

class Refusal extends Error {}

/**
 * 最近一層已存在的上層目錄的真實路徑，接回還不存在的那一截（/tmp 與 /private/tmp 這類別名要先解開再比）。
 * 用 native 版：不分大小寫的磁碟上 ~/.CODEX 跟 ~/.codex 是同一個目錄，native 會還原成磁碟上的寫法。
 */
function realish(p) {
  let existing = p;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  return path.join(fs.realpathSync.native(existing), path.relative(existing, p));
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
/**
 * 不分大小寫比：不分大小寫的磁碟上 ~/.CODEX 就是 ~/.codex，而還不存在的那一截 native 版還原不了大小寫
 * （裁示批 r1 B3：第一次建立 .CODEX 就擋不住）。分大小寫的磁碟上多擋了 ~/.CODEX 這種名字，無害。
 */
const insideAnyCase = (child, parent) => inside(child.toLowerCase(), parent.toLowerCase());
/**
 * 真實路徑 real 在不在這個家的 .codex／.claude 底下（大小寫不同、別名、還不存在的那一截都算：realish＋insideAnyCase）；在＝回那個名字。
 * checkTarget（--to、--claude）與 retire（--retire；Codex r1 第 2 條）共用這一支。
 */
function platformDirOf(real, home) {
  for (const d of ['.codex', '.claude']) {
    if (insideAnyCase(real, realish(path.join(home, d)))) return d;
  }
  return null;
}

/** 工具名的合法字元（跟攔截器同一套）：不合法的名字攔截器本來就一律擋，拿來當試跑的「該擋的名字」證明不了清單。 */
const PROBE_NAME = /^mcp__[A-Za-z0-9_.-]{1,195}$/u;

/**
 * 目的地的檢查；回真實路徑。任何一條不過就拒絕（此時什麼都還沒寫）。
 * shared＝Claude 側那個共用的基底目錄：路徑不進指令（不必放得進單引號）、本來就會有別的複本在（不要求空的）；其餘檢查一樣。
 */
function checkTarget(to, { home = os.homedir(), allowTemp = false, shared = false } = {}) {
  if (typeof to !== 'string' || !path.isAbsolute(to)) throw new Refusal('--to 要給絕對路徑（鉤子在任何目錄執行，相對路徑沒有意義）');
  const real = realish(path.normalize(to));
  if (!shared && unquotable(real)) throw new Refusal('複本路徑含單引號或控制字元，放不進鉤子指令');
  const platformDir = platformDirOf(real, home);
  if (platformDir) throw new Refusal(`複本不可以放在家目錄的 ${platformDir} 底下：那是 AI 平台自己的設定目錄，這支工具不碰`);
  if (!allowTemp) {
    for (const t of [os.tmpdir(), ...TEMP_ROOTS]) {
      if (fs.existsSync(t) && insideAnyCase(real, realish(t))) {
        throw new Refusal(`複本不可以放在暫存區（${t}）：作業系統會清，清掉那天所有 mcp__ 工具會突然全擋。建議放在家目錄底下一個固定的地方，例如 ~/.local/share/ai-collab-kit/guard/<版本碼前幾碼>`);
      }
    }
  }
  if (!shared && fs.existsSync(real) && (!fs.statSync(real).isDirectory() || fs.readdirSync(real).length)) {
    throw new Refusal('目的地已經有東西：這支從不覆寫。每抽一次就給一個新的空目錄（舊的複本在新指令按下信任之前還在擋）');
  }
  let existing = real;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  // 只有 git 明確說「不是倉庫」才算在倉庫以外；其餘任何錯（叫不起、權限、擁有者不符）一律拒絕
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], { cwd: existing, env: { ...gitEnv(), LC_ALL: 'C' }, encoding: 'utf8' });
  if (git.error) throw new Refusal(`叫不起 git，無法確認目的地不在版本控制目錄裡（${git.error.code}）`);
  if (git.status === 0) throw new Refusal('目的地在版本控制目錄裡：固定複本要放在任何倉庫以外（切分支、拉新版會改到它）');
  if (!/not a git repository/u.test(git.stderr)) throw new Refusal(`無法確認目的地不在版本控制目錄裡（${git.stderr.trim().slice(0, 200)}）`);
  return real;
}

/**
 * 複本裡 settings.json 的位元組：只留 forbidden 那一塊、固定的寫法（縮排 2、結尾一個換行）。
 * 「從已合併版本抽」與「讀工作樹算那一行的指紋」兩條路都走這一支：兩邊只要差一個空白，那一行的指紋就永遠找不到複本＝每台機器全擋。
 * 改這個寫法＝每台機器上現有的複本全部對不上（Codex 要重抽重按信任、Claude 要重補），所以 tests/guard-copy-claude.test.js 逐位元組釘著。
 * @param {unknown} settings 解析過的整份設定
 * @param {string} unfilled 清單沒填時的拒絕訊息（兩條路的下一步不同）
 */
function forbiddenOnly(settings, unfilled) {
  const f = settings && settings.forbidden;
  if (!f || typeof f !== 'object' || Array.isArray(f) || !f.name || f.name === UNSET) throw new Refusal(unfilled);
  return Buffer.from(`${JSON.stringify({ forbidden: f }, null, 2)}\n`, 'utf8');
}

/**
 * 從版本控制讀出複本內容與接線範本（不讀工作樹：沒提交的改動不可能進複本、也不可能改到要按信任的那一行）。
 * 那個版本必須已經在 origin/<主幹> 裡：只要求「提交過」的話，本機沒推、沒審的提交照樣進得來。
 */
function extract(ref, root = ROOT, templateRel = TEMPLATE_REL) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Refusal('--from 要給一個版本（分支名或提交碼）');
  const git = (args, encoding) => spawnSync('git', args, { cwd: root, env: gitEnv(), encoding, maxBuffer: 64 * 1024 * 1024 });
  const rev = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 'utf8');
  if (rev.error) throw new Refusal(`叫不起 git（${rev.error.code}）`);
  if (rev.status !== 0) throw new Refusal(`「${ref}」不是這個倉庫裡的一個版本`);
  const commit = rev.stdout.trim();
  const show = (rel) => {
    const r = git(['show', `${commit}:./${rel}`], 'buffer');
    if (r.status !== 0) throw new Refusal(`版本 ${commit.slice(0, 12)} 裡沒有 ${rel}`);
    return r.stdout;
  };
  const files = new Map(COPY_FILES.map((rel) => [rel, show(rel)]));
  let settings;
  try { settings = JSON.parse(files.get('settings.json').toString('utf8')); } catch { throw new Refusal('那個版本的 settings.json 不是合法的 JSON'); }
  const main = settings && settings.mainBranch;
  if (typeof main !== 'string' || !main || main === UNSET) throw new Refusal('那個版本的設定沒填主幹分支名：確認不了它合併了沒有');
  const tracking = `refs/remotes/origin/${main}`;
  if (git(['rev-parse', '--verify', '--quiet', tracking], 'utf8').status !== 0) throw new Refusal(`本機沒有 origin/${main}：先 git fetch 再抽`);
  if (git(['merge-base', '--is-ancestor', commit, tracking], 'utf8').status !== 0) {
    throw new Refusal(`版本 ${commit.slice(0, 12)} 還不在 origin/${main} 裡：只抽已經合併的版本（先 git fetch；還沒合併就等合併）`);
  }
  files.set('settings.json', forbiddenOnly(settings, '那個版本的禁區清單還沒填：裝上去只會把所有 mcp__ 工具全部擋掉，先填清單、合併之後再抽'));
  return { commit, files, template: show(templateRel).toString('utf8'), tracking: `origin/${main}` };
}

/**
 * 讀**工作樹**的那四個檔（沒提交的改動也算在內；不需要 git）。回跟 extract() 的 files 同一種形狀。
 * 給 --claude-line 與等式題用：比的是「這棵樹」，不是某個已合併的版本。
 */
function treeFiles(root = ROOT) {
  const files = new Map();
  for (const rel of COPY_FILES) {
    try { files.set(rel, fs.readFileSync(path.join(root, rel))); } catch (e) { throw new Refusal(`這棵樹讀不到 ${rel}（${(e && e.code) || '不明'}）`); }
  }
  let settings;
  try { settings = JSON.parse(files.get('settings.json').toString('utf8')); } catch { throw new Refusal('這棵樹的 settings.json 不是合法的 JSON'); }
  files.set('settings.json', forbiddenOnly(settings, '這棵樹的禁區清單還沒填：釘上去只會把所有 mcp__ 工具全部擋掉，先填清單'));
  return files;
}

/** 這棵樹四個檔的指紋（跟同一份內容抽成複本之後的目錄名是同一個值）。 */
function treeFingerprint(root = ROOT) {
  const files = treeFiles(root);
  return fingerprint((rel) => files.get(rel));
}

/** 範本裡某一種鉤子的那一組：要剛好一組、matcher 逐字相符、剛好一條指令型鉤子。回那一組與它的指令。 */
function soleGroup(templateText, event, matcher) {
  let doc;
  try { doc = JSON.parse(templateText); } catch { throw new Refusal('接線範本不是合法的 JSON'); }
  const list = doc && doc.hooks && doc.hooks[event];
  const group = list && list[0];
  const command = group && group.hooks && group.hooks[0] && group.hooks[0].command;
  if (typeof command !== 'string') throw new Refusal('接線範本裡找不到那一條指令');
  // 整組的形狀也要對：matcher 不對、不是指令型、多出別的組或別的鉤子＝印出來的那一組不會照預期攔（裁示批 r1 T2）
  if (list.length !== 1 || group.matcher !== matcher || group.hooks.length !== 1 || group.hooks[0].type !== 'command') {
    throw new Refusal(`接線範本那一組的形狀不對（要剛好一組、matcher 是 ${matcher}、剛好一條指令型鉤子）`);
  }
  return { group, command };
}

/** 把佔位換掉；範本的佔位不是剛好各一個＝範本壞了，拒絕。 */
function fill(command, values) {
  for (const ph of Object.keys(values)) {
    if (command.split(ph).length !== 2) throw new Refusal(`範本的指令裡「${ph}」不是剛好一個`);
  }
  return Object.keys(values).reduce((c, ph) => c.replace(ph, () => values[ph]), command);
}

/** Codex 全域層範本的那一組接線，三個佔位換掉。 */
function hookGroup({ copyDir, fp }, templateText) {
  const { group, command } = soleGroup(templateText, 'PreToolUse', '^mcp__');
  const filled = fill(command, { '{copyDir}': copyDir, '{files}': COPY_FILES.join(' '), '{fingerprint}': fp });
  return { matcher: group.matcher, hooks: [{ ...group.hooks[0], command: filled }] };
}

/**
 * Claude 側那兩組的組與鉤子物件只准有這幾個鍵（第二輪審查 J）。官方鉤子文件（https://code.claude.com/docs/en/hooks 的
 * Common fields 與 Command hook fields 兩張表，2026-09-19 讀；是文件、不是量測）另外列了會改變那一組怎麼跑的欄位：
 * async＝在背景跑、不擋；if＝只有工具呼叫符合那一條權限規則時才跑；args＝不經 shell、把 command 當執行檔直接跑；
 * timeout＝到時間就取消，而 PreToolUse 的指令鉤子逾時不擋；另有 asyncRewake、shell、once、statusMessage。
 * 多一個鍵就拒絕，不逐一判斷它是不是無害的。Codex 全域層共用的 soleGroup 刻意不動（那一層的輸出不變）。
 */
const CLAUDE_GROUP_KEYS = ['hooks', 'matcher'];
const CLAUDE_HOOK_KEYS = ['command', 'type'];
/** 一個物件裡不在允許清單上的鍵（照原本的順序）。不是物件＝回一個說明。 */
const extraKeys = (obj, allowed) => (obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj).filter((k) => !allowed.includes(k)) : ['（不是物件）']);
/** 一組的多餘鍵：組本身的、每一個鉤子物件的（寫成 hooks[序號].鍵名）。 */
const groupExtraKeys = (group) => [
  ...extraKeys(group, CLAUDE_GROUP_KEYS),
  ...(group && Array.isArray(group.hooks) ? group.hooks.flatMap((h, i) => extraKeys(h, CLAUDE_HOOK_KEYS).map((k) => `hooks[${i}].${k}`)) : []),
];

/**
 * Claude 側釘指紋範本的兩組，佔位換掉：PreToolUse＝釘指紋那一行；ConfigChange＝設定變更攔截（沒有佔位，原樣）。
 * 那一行不可以有複本路徑的佔位：它進版控、跨機器共用，寫死任何一台機器的路徑都是錯的。
 */
function claudeGroups(fp, templateText) {
  if (typeof fp !== 'string' || !FP_NAME.test(fp)) throw new Refusal('指紋要是 64 碼十六進位小寫');
  const pre = soleGroup(templateText, 'PreToolUse', '^mcp__');
  if (pre.command.includes('{copyDir}')) throw new Refusal('Claude 側釘指紋的範本不可以有 {copyDir}：那一行跨機器共用，複本的位置固定從 $HOME 算');
  const filled = fill(pre.command, { '{files}': COPY_FILES.join(' '), '{fingerprint}': fp });
  const change = soleGroup(templateText, 'ConfigChange', CONFIG_CHANGE_MATCHER);
  for (const ph of PLACEHOLDERS) {
    if (change.command.includes(ph)) throw new Refusal(`設定變更攔截那一條指令不可以有佔位（${ph}）`);
  }
  for (const [event, { group }] of [['PreToolUse', pre], ['ConfigChange', change]]) {
    const extra = groupExtraKeys(group);
    if (extra.length) {
      throw new Refusal(`接線範本 ${event} 那一組多了鍵（${extra.join('、')}）：組只准有 matcher、hooks，鉤子物件只准有 type、command——官方鉤子文件列的 async、if、args、timeout 等欄位任一個都可能讓那一組不擋`);
    }
  }
  return {
    PreToolUse: { matcher: pre.group.matcher, hooks: [{ ...pre.group.hooks[0], command: filled }] },
    ConfigChange: { matcher: change.group.matcher, hooks: [{ ...change.group.hooks[0] }] },
  };
}

/** flag：Codex 用 -lc 起鉤子；Claude 量到的是 /bin/sh、是不是登入 shell 沒量到。env 不給＝沿用這支自己的環境。 */
const runHook = (command, tool, { flag = '-lc', env } = {}) =>
  spawnSync('/bin/sh', [flag, command], { cwd: os.tmpdir(), env, input: JSON.stringify({ tool_name: tool }), encoding: 'utf8' });

/** Codex 全域層試跑認的拒絕形狀（錯誤輸出那一段）。Codex r1 第 1 條只改 Claude 側：這一支一個字不動（那一層的判準與輸出不變）。 */
const isDenyShape = (text) => {
  try { return JSON.parse(text.trim()).hookSpecificOutput.permissionDecision === 'deny'; } catch { return false; }
};

/**
 * Claude 側試跑認的拒絕形狀（Codex r1 第 1 條：原本跟 Codex 共用上面那一支、只看 permissionDecision）。回不符的地方；符合＝null。
 *   ・標準輸出**整段**解析得出一個 JSON 物件（被別的輸出弄髒＝平台讀不出來＝放行）；
 *   ・最上層**只有** hookSpecificOutput 這一個鍵：tools/forbidden-tools.js 的 hookOutput 只印這一個；官方文件另外列了別的最上層欄位，
 *     多一個就不認、不逐一判斷它是不是無害的（跟 CLAUDE_GROUP_KEYS 同一個做法）；
 *   ・hookEventName＝'PreToolUse'：官方鉤子文件 JSON output 段（https://code.claude.com/docs/en/hooks#json-output，2026-09-19 讀；
 *     是文件、不是量測）寫 hookSpecificOutput 裡要有 hookEventName，也寫 exit 0 的輸出解析得出來、結構驗證沒過＝不擋、動作照做；
 *   ・permissionDecision＝'deny'；permissionDecisionReason 是非空字串（驗收看的就是這一句：要含「在拒絕清單上」）。
 * 平台拿到缺欄位的形狀實際怎麼做沒有量（沒有叫任何 mcp__ 工具去試），這裡照文件的格式往嚴的一邊認。
 */
/** hookSpecificOutput 裡只准這三個鍵（Codex r2 第 1 條）：官方文件在 PreToolUse 另列了 additionalContext 等欄位、各有型別，
 *  型別不對＝結構驗證沒過＝不擋；這裡跟最上層同一個做法——多一個就不認，不逐一驗它的型別（攔截器本來就只印這三個）。 */
const CLAUDE_DENY_INNER_KEYS = ['hookEventName', 'permissionDecision', 'permissionDecisionReason'];
function claudeDenyProblem(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return '標準輸出整段不是一個 JSON'; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return '標準輸出不是一個 JSON 物件';
  const top = Object.keys(doc);
  if (top.length !== 1 || top[0] !== 'hookSpecificOutput') return `最上層要剛好只有 hookSpecificOutput（有的是：${top.join('、') || '沒有任何鍵'}）`;
  const h = doc.hookSpecificOutput;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return 'hookSpecificOutput 不是物件';
  if (h.hookEventName !== 'PreToolUse') return `hookEventName 不是 PreToolUse（是 ${JSON.stringify(h.hookEventName) || '缺'}）`;
  if (h.permissionDecision !== 'deny') return `permissionDecision 不是 deny（是 ${JSON.stringify(h.permissionDecision) || '缺'}）`;
  if (typeof h.permissionDecisionReason !== 'string' || h.permissionDecisionReason === '') return `permissionDecisionReason 不是非空字串（是 ${JSON.stringify(h.permissionDecisionReason) || '缺'}）`;
  const inner = Object.keys(h).filter((k) => !CLAUDE_DENY_INNER_KEYS.includes(k));
  if (inner.length) return `hookSpecificOutput 裡要剛好只有 ${CLAUDE_DENY_INNER_KEYS.join('、')}（多了：${inner.join('、')}）`;
  return null;
}

/**
 * 試跑的擺法：同一套三項檢查，兩種接線各自「怎麼把那一行指令對到某一份複本」與「拒絕長什麼樣」。
 * root＝擺複本的那個根：Codex 是複本目錄自己（路徑寫死在指令裡＝換指令裡的路徑）；
 * Claude 是一個家目錄（指令不變、換 HOME；複本要擺成 <HOME>/.local/share/ai-collab-kit/guard/<指紋>）。
 */
const codexRig = ({ fp, template }) => ({
  flags: ['-lc'],
  copyDirIn: (root) => root,
  aim: (root) => ({ command: hookGroup({ copyDir: root, fp }, template).hooks[0].command, env: undefined }),
  denied: (r) => r.status === 2 && r.stdout === '' && isDenyShape(r.stderr),
  deniedAs: '擋成退 2',
});
const claudeRig = ({ fp, template }) => {
  const command = claudeGroups(fp, template).PreToolUse.hooks[0].command;
  return {
    flags: ['-c', '-lc'],
    copyDirIn: (root) => path.join(root, ...CLAUDE_BASE, fp),
    aim: (root) => ({ command, env: { ...process.env, HOME: root } }),
    // Claude 側量過的那條路：退 0、標準輸出**整段**就是完整的拒絕形狀（claudeDenyProblem；被別的輸出弄髒＝平台讀不出來＝放行）
    denied: (r) => r.status === 0 && claudeDenyProblem(r.stdout) === null,
    deniedAs: '擋下（退 0、標準輸出整段是完整的拒絕形狀）',
    whyNot: (r) => (r.status === 0 ? claudeDenyProblem(r.stdout) : `退 ${r.status}`),
    deniedHint: '攔截器被改成什麼都放、印的拒絕形狀不完整、或清單沒有有效規則',
  };
};

/**
 * 照鉤子的起法真的跑那一行指令（Codex＝/bin/sh -lc；Claude＝-c 與 -lc 各跑一遍），任一項不符就回失敗原因：
 *   ①無害假名要**放行**：退 0、兩個輸出都空的（依序試幾個，有一個過就算；清單壞到什麼都擋、登入設定往輸出印字，都在這裡露出來）；
 *   ②照清單該擋的假名要**擋**：Codex＝退 2、錯誤輸出是拒絕的形狀；Claude＝退 0、標準輸出整段是完整的拒絕形狀（claudeDenyProblem）
 *    （依序試幾個；攔截器被改成什麼都放、Claude 側印的拒絕形狀缺欄位，這裡露出來）；
 *   ③指紋檢查要真的在：同一行指令對到一份改過一個位元組的副本，要退 2 而且是指紋那一句。
 * 全程只跑指令、不把複本裡的程式載進這支（驗的就是鉤子實際會走的那一條路）。
 */
function selfTest({ copyDir, fp, template, forbidden, denyProbe = null, rig = codexRig({ fp, template }), root = copyDir }) {
  const from = rig.copyDirIn(root);
  const show = (r) => `退 ${r.status}；標準輸出「${r.stdout.slice(0, 120)}」；錯誤輸出「${r.stderr.slice(0, 200)}」`;
  for (const flag of rig.flags) {
    const tag = rig.flags.length > 1 ? `/bin/sh ${flag}：` : '';
    const { command, env } = rig.aim(root);

    let allowName = null;
    let lastAllow = null;
    for (const name of ALLOW_PROBES) {
      lastAllow = runHook(command, name, { flag, env });
      if (lastAllow.status === 0 && lastAllow.stdout === '' && lastAllow.stderr === '') { allowName = name; break; }
    }
    if (!allowName) return `${tag}無害的假名一個都沒有被乾淨地放行（最後一次：${show(lastAllow)}）——清單壞到什麼都擋、或登入設定往標準輸出印字（要先讓它安靜）`;

    // 有給 --deny-probe 就只試那一個（給了卻不擋＝失敗，不改試別的）；沒給就從清單自動產生
    const denyCandidates = denyProbe ? [denyProbe] : autoDenyProbes(forbidden);
    let denied = false;
    let lastDeny = null;
    for (const name of denyCandidates) {
      lastDeny = runHook(command, name, { flag, env });
      if (rig.denied(lastDeny)) { denied = true; break; }
    }
    // whyNot、deniedHint 只有 Claude 側有（Codex 全域層這一句的字不變）
    const whyNot = rig.whyNot && lastDeny ? `；不符的地方：${rig.whyNot(lastDeny)}` : '';
    if (!denied) return `${tag}照清單該擋的假名沒有一個被${rig.deniedAs}（試了 ${denyCandidates.length} 個${lastDeny ? `；最後一次：${show(lastDeny)}` : ''}${whyNot}）——${rig.deniedHint || '攔截器被改成什麼都放、或清單沒有有效規則'}`;

    const dupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-copy-selftest-'));
    try {
      const dup = rig.copyDirIn(dupRoot);
      for (const rel of COPY_FILES) {
        fs.mkdirSync(path.dirname(path.join(dup, rel)), { recursive: true });
        fs.copyFileSync(path.join(from, rel), path.join(dup, rel));
        fs.chmodSync(path.join(dup, rel), 0o644);
      }
      fs.appendFileSync(path.join(dup, 'settings.json'), ' ');
      const aimed = rig.aim(dupRoot);
      const tampered = runHook(aimed.command, allowName, { flag, env: aimed.env });
      if (tampered.status !== 2 || !/指紋對不上/u.test(tampered.stderr)) return `${tag}指紋檢查沒有作用：改過一個位元組的副本沒有被擋（${show(tampered)}）`;
    } finally {
      fs.rmSync(dupRoot, { recursive: true, force: true });   // 只刪自己剛建的試跑副本
    }
  }
  return null;
}

/** 從清單自動產生「照清單該擋」的試跑名字：連接器、第一組動詞＋名詞、逐字拒絕清單。只有樣式規則的清單產不出來（要 --deny-probe）。 */
function autoDenyProbes(forbidden) {
  const f = forbidden;
  return [
    ...(Array.isArray(f.servers) ? f.servers.map((srv) => `mcp__${srv}__guard_copy_selftest_probe`) : []),
    ...(Array.isArray(f.verbs) && Array.isArray(f.nouns) && f.verbs[0] && f.nouns[0] ? [`mcp__guard_copy_selftest__${f.verbs[0]}_${f.nouns[0]}`] : []),
    ...(Array.isArray(f.deny) ? f.deny : []),
  ].filter((n) => typeof n === 'string' && PROBE_NAME.test(n));
}

function checkDenyProbe(denyProbe) {
  if (denyProbe !== null && (typeof denyProbe !== 'string' || !PROBE_NAME.test(denyProbe))) {
    throw new Refusal('--deny-probe 要是合法的假工具名（mcp__ 開頭、只用英數與 _ . -）：不合法的名字攔截器本來就擋，證明不了清單');
  }
}

/** 試跑要有「照清單該擋」的名字可以用：只靠樣式規則的清單產不出來，沒給 --deny-probe 就拒絕（此時什麼都還沒寫）。 */
function requireDenySource(f, { runSelfTest, denyProbe }) {
  // 只看「清單有沒有這幾種欄位」，不看合不合文法：壞掉的清單要走到試跑，由「無害名字也被擋、設定壞掉」那一句露出來
  const hasAutoSource = (Array.isArray(f.servers) && f.servers.length) || (Array.isArray(f.verbs) && f.verbs[0] && Array.isArray(f.nouns) && f.nouns[0]) || (Array.isArray(f.deny) && f.deny.length);
  if (runSelfTest && !denyProbe && !hasAutoSource) {
    throw new Refusal('這份清單只靠樣式規則（沒有連接器、動詞＋名詞、逐字拒絕清單），工具自己想不出該擋的試跑名字：用 --deny-probe 給一個照清單該擋的假工具名（只當字串餵給攔截器）');
  }
}

function build({ from, to, root = ROOT, home, allowTemp = false, runSelfTest = true, denyProbe = null }) {
  checkDenyProbe(denyProbe);
  const copyDir = checkTarget(to, { home, allowTemp });
  const { commit, files, template, tracking } = extract(from, root);
  const forbiddenBlock = JSON.parse(files.get('settings.json').toString('utf8')).forbidden;
  requireDenySource(forbiddenBlock, { runSelfTest, denyProbe });
  hookGroup({ copyDir, fp: '0'.repeat(64) }, template);   // 先驗範本，範本壞了就什麼都不寫
  fs.mkdirSync(copyDir, { recursive: true });
  for (const rel of COPY_FILES) {
    fs.mkdirSync(path.dirname(path.join(copyDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(copyDir, rel), files.get(rel), { flag: 'wx', mode: 0o444 });
  }
  const fp = fingerprintDir(copyDir);   // 從磁碟讀回來算：算的就是鉤子會看到的位元組
  const group = hookGroup({ copyDir, fp }, template);
  const failure = runSelfTest ? selfTest({ copyDir, fp, template, forbidden: forbiddenBlock, denyProbe }) : null;
  return { commit, tracking, copyDir, fp, group, failure };
}

/**
 * 一份 Claude 側複本自不自洽：是真的目錄（不是連結）、裡面剛好那四個檔（不多不少、沒有連結、沒有別種東西）、
 * 每個檔小於 CLAUDE_MAX_FILE_BYTES、從磁碟重算的指紋＝目錄名。回問題描述；自洽＝回 null。全程只讀。
 */
function copyProblem(dir, fp) {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return `讀不到（${(e && e.code) || '不明'}）`; }
  if (st.isSymbolicLink()) return '那個名字是一個連結（不順著連結走）';
  if (!st.isDirectory()) return '那個名字不是目錄';
  const found = [];
  const odd = [];
  const visit = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { found.push(`${at}/`); visit(at); } else if (e.isFile()) found.push(at); else odd.push(at);
    }
  };
  try { visit(''); } catch (e) { return `裡面有讀不到的目錄（${(e && e.code) || '不明'}）`; }
  if (odd.length) return `裡面有連結或不是一般檔案的東西（${odd[0]}）`;
  const expected = [...new Set(COPY_FILES.flatMap((rel) => (rel.includes('/') ? [`${path.posix.dirname(rel)}/`, rel] : [rel])))].sort();
  if (JSON.stringify(found.sort()) !== JSON.stringify(expected)) return '裡面不是剛好那四個檔（多了或少了東西）';
  // 大小上限跟那一行的 find 同一個數：先查大小，極大的檔不必讀完就知道不收
  for (const rel of COPY_FILES) {
    let size;
    try { size = fs.statSync(path.join(dir, rel)).size; } catch (e) { return `檔案讀不到（${(e && e.code) || '不明'}）`; }
    if (size >= CLAUDE_MAX_FILE_BYTES) return `${rel} 不小於 ${CLAUDE_MAX_FILE_BYTES} 位元組（那一行把它當成多出來的東西）`;
  }
  try { if (fingerprintDir(dir) !== fp) return '內容重算的指紋跟目錄名不一樣'; } catch (e) { return `檔案讀不到（${(e && e.code) || '不明'}）`; }
  return null;
}

/**
 * 落地前先用這個家跑一次 /bin/sh -lc ':'（第二輪審查 L）：標準輸出不是空的＝登入設定往標準輸出印字——拒絕走標準輸出，
 * 會被弄髒＝放行。回失敗原因；安靜＝null。落地之後照樣用這個家再試跑一次（這一步只是把「落地了才發現」的機會縮到
 * 「登入設定在兩次之間改了」）。
 */
function loginShellNoise(home) {
  const r = spawnSync('/bin/sh', ['-lc', ':'], { cwd: os.tmpdir(), env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.error) return `落地前用這個家跑 /bin/sh -lc ':' 叫不起來（${r.error.code}）`;
  if (r.stdout !== '') return `落地前用這個家跑 /bin/sh -lc ':'，標準輸出不是空的（「${r.stdout.slice(0, 120)}」）——登入設定往標準輸出印字：拒絕走標準輸出，會被弄髒＝放行；先讓登入設定安靜再補`;
  return null;
}

/** 不給 --from 時抽哪個版本：這棵樹設定的 origin/<主幹>（extract() 照樣驗它真的在主幹裡）。 */
function defaultRef(root) {
  let main;
  try { main = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).mainBranch; } catch { main = null; }
  if (typeof main !== 'string' || !main || main === UNSET) throw new Refusal('這棵樹的設定沒填主幹分支名：用 --from 給一個已合併進主幹的版本');
  return `origin/${main}`;
}

/**
 * Claude 側補複本：抽已合併的版本→（要落地的話）先用這個家跑一次 /bin/sh -lc ':'，標準輸出不是空的就不落地（loginNoisy）
 * →在基底目錄裡的暫存骨架試跑（HOME 指到骨架）→過了才改名落地成 <基底>/<指紋>
 * →落地之後用這個家（home）再試跑一次，沒過就撤掉這一次落地的那一份（landedThenFailed；withdrawn＝撤掉了沒有）。
 * 暫存骨架跟基底同一個目錄＝同一個檔案系統，改名才不會失敗；不論成敗都由這支自己清掉（只刪自己剛建的）；
 * 清不掉＝結果多帶 stagingLeft（丟出的錯也帶），不蓋掉已經算好的結果。
 * 落地之後、第二次試跑跑完之前這支被中斷（例如 Ctrl-C）＝那一份留著；下一次再跑走「已經在」那條路：試跑沒過只退 1、不撤它。
 * beforeLand 只給考題用：落地前一刻叫它，模擬另一個工作階段搶先落地同一份。
 */
function buildClaude({ from = null, root = ROOT, home = os.homedir(), allowTemp = false, runSelfTest = true, denyProbe = null, beforeLand = null } = {}) {
  checkDenyProbe(denyProbe);
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Refusal('家目錄不是絕對路徑：算不出複本該放哪裡');
  const base = checkTarget(path.join(home, ...CLAUDE_BASE), { home, allowTemp, shared: true });
  const { commit, files, template, tracking } = extract(from === null ? defaultRef(root) : from, root, CLAUDE_TEMPLATE_REL);
  const forbiddenBlock = JSON.parse(files.get('settings.json').toString('utf8')).forbidden;
  requireDenySource(forbiddenBlock, { runSelfTest, denyProbe });
  const fp = fingerprint((rel) => files.get(rel));
  const rig = claudeRig({ fp, template });   // 先驗範本，範本壞了就什麼都不寫
  const copyDir = path.join(base, fp);
  const test = (testRoot) => (runSelfTest ? selfTest({ fp, template, forbidden: forbiddenBlock, denyProbe, rig, root: testRoot }) : null);
  /** 那個名字已經在：自洽＝不寫、就地試跑（HOME＝真的那個家目錄）；不自洽＝拒絕，不覆寫也不刪。 */
  const existing = () => {
    const problem = copyProblem(copyDir, fp);
    if (problem) throw new Refusal(`${copyDir} 已經在、但不是一份自洽的複本（${problem}）：這支不覆寫、也不刪它。不要手工修它——原句轉給裁示者，看過之後整個目錄移走再重跑`);
    return { commit, tracking, copyDir, fp, existed: true, failure: test(home) };
  };
  if (fs.lstatSync(copyDir, { throwIfNoEntry: false })) return existing();   // lstat：名字是壞掉的連結也算「已經在」
  if (runSelfTest) {
    const noise = loginShellNoise(home);
    if (noise) return { commit, tracking, copyDir, fp, existed: false, loginNoisy: true, failure: noise };   // 什麼都還沒寫
  }

  fs.mkdirSync(base, { recursive: true });
  const staging = fs.mkdtempSync(path.join(base, '.staging-'));
  let result;
  let thrown = null;
  try {
    result = landVia(staging);
  } catch (e) {
    thrown = e;
  }
  // 清掉暫存骨架（只刪自己剛建的）。清不掉不可以蓋掉已經算好的結果（例如「撤不掉：那一份還在」）：另外照實說
  let stagingLeft = null;
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { stagingLeft = staging; }
  if (thrown) {
    if (stagingLeft && thrown && typeof thrown === 'object') thrown.stagingLeft = stagingLeft;
    throw thrown;
  }
  return stagingLeft ? { ...result, stagingLeft } : result;

  /** 在暫存骨架裡寫、試跑、改名落地、落地後用這個家再試跑（沒過＝撤回）。回結果；清骨架由外面做。 */
  function landVia(stagingDir) {
    const stagingHome = path.join(stagingDir, 'home');
    const staged = path.join(stagingHome, ...CLAUDE_BASE, fp);
    for (const rel of COPY_FILES) {
      fs.mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
      fs.writeFileSync(path.join(staged, rel), files.get(rel), { flag: 'wx', mode: 0o444 });
    }
    // 從磁碟讀回來算：落地的位元組要真的是算過指紋的那一份（目錄名是那一行拿來找它的鍵，不可以名實不符）
    if (fingerprintDir(staged) !== fp) throw new Error('寫出來的位元組重算的指紋跟目錄名不一樣');
    const failure = test(stagingHome);
    if (failure) return { commit, tracking, copyDir, fp, existed: false, failure };
    if (beforeLand) beforeLand(copyDir);
    try { fs.renameSync(staged, copyDir); } catch (e) {
      // 別的工作階段搶先落地了同一個名字：它自洽就是同一份內容（內容定址），照「已經在」那條路走；不自洽照樣拒絕
      if (!e || !['ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e;
      return existing();
    }
    // 落地之後照「已經在」那條路、用這個家再試跑一次：落地前那一次 HOME 指到暫存骨架，讀不到這個人的登入設定
    //（拒絕走標準輸出，登入設定往標準輸出印字＝拒絕形狀被弄髒＝放行）。沒過＝把這一次自己落地的那一份撤掉
    //（改名回暫存骨架、下面一起清掉）；別的工作階段先落地的那一份走的是上面 existing()，這裡碰不到它
    let atHome;
    try { atHome = test(home); } catch (e) { atHome = `試跑途中出錯（${(e && (e.code || e.message)) || '不明'}）`; }
    if (!atHome) return { commit, tracking, copyDir, fp, existed: false, failure: null };
    let withdrawn = true;
    try { fs.renameSync(copyDir, path.join(stagingDir, 'withdrawn')); } catch { withdrawn = false; }
    return { commit, tracking, copyDir, fp, existed: false, landedThenFailed: true, withdrawn, failure: atHome };
  }
}

/** 這棵樹的那兩組（--claude-line）：純讀工作樹，不寫檔、不試跑、不需要 git。 */
function claudeLine(root = ROOT) {
  const fp = treeFingerprint(root);
  let template;
  try { template = fs.readFileSync(path.join(root, CLAUDE_TEMPLATE_REL), 'utf8'); } catch (e) { throw new Refusal(`這棵樹讀不到 ${CLAUDE_TEMPLATE_REL}（${(e && e.code) || '不明'}）`); }
  return { fp, groups: claudeGroups(fp, template) };
}

/**
 * 退役一份舊的 Claude 側複本。只刪：名字是 64 碼十六進位、是真的目錄、而且自洽的那一種——
 * 別種名字（Codex 全域層那種人取的短名字、路徑片段）一律不收；名字對但內容不自洽＝不刪（那不是這支造出來的樣子，要人看過）。
 * 基底目錄（或它的上層）是連結、解開之後在這個家的 .claude／.codex 底下＝拒絕，什麼都不讀、不改、不刪；
 * 基底或那一份讀不了（EACCES、ELOOP…）＝照實說確認不了、不刪；只有確實不存在（ENOENT、ENOTDIR）才說沒有。
 */
function retire({ fp, home = os.homedir() }) {
  if (typeof fp !== 'string' || !FP_NAME.test(fp)) {
    throw new Refusal('--retire 只收 64 碼十六進位小寫的指紋（Claude 側內容定址的複本）；別種名字的目錄（例如 Codex 全域層用版本碼取名的）這支不刪');
  }
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Refusal('家目錄不是絕對路徑：算不出複本在哪裡');
  let base;
  try { base = fs.realpathSync.native(path.join(home, ...CLAUDE_BASE)); } catch (e) {
    // 只有「確實不存在」才說沒有（Codex r1 第 3 條）：ENOENT＝路徑上有一段不存在；ENOTDIR＝路徑上有一段是一般檔、不是目錄，
    // 那個基底不可能存在。其餘（EACCES＝有一層不給進、ELOOP＝連結繞圈…）照實說確認不了
    const code = (e && e.code) || '不明';
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Refusal('這台機器沒有 Claude 側複本的基底目錄：沒有東西可以退役');
    throw new Refusal(`讀不了 Claude 側複本的基底目錄（${code}）：確認不了那一份在不在`);
  }
  // 基底（或它的上層）是連結、解開之後落在這個家的 .claude／.codex 底下＝不碰（Codex r1 第 2 條；跟 --claude 同一支 platformDirOf）。
  // 在讀複本內容、改權限、刪除之前就拒絕
  const copyDir = path.join(base, fp);
  for (const at of [base, realish(copyDir)]) {
    const platformDir = platformDirOf(at, home);
    if (platformDir) throw new Refusal(`${copyDir} 解開連結之後在家目錄的 ${platformDir} 底下（${at}）：那是 AI 平台自己的設定目錄，這支工具不碰`);
  }
  let st;
  try { st = fs.lstatSync(copyDir, { throwIfNoEntry: false }); } catch (e) { throw new Refusal(`讀不了 ${copyDir}（${(e && e.code) || '不明'}）：確認不了那一份在不在`); }
  if (!st) throw new Refusal(`沒有這一份：${copyDir}`);
  const problem = copyProblem(copyDir, fp);
  if (problem) throw new Refusal(`${copyDir} 不是一份自洽的複本（${problem}）：不刪。看過之後自己處理`);
  for (const p of [copyDir, ...new Set(COPY_FILES.filter((rel) => rel.includes('/')).map((rel) => path.join(copyDir, path.dirname(rel))))]) fs.chmodSync(p, 0o755);
  fs.rmSync(copyDir, { recursive: true });
  return { copyDir };
}

const USAGE = [
  '用法：node tools/guard-copy.js --from <已合併進主幹的版本> --to <絕對路徑的空目錄> [--deny-probe <照清單該擋的假工具名>]',
  '　或：node tools/guard-copy.js --claude [--from <已合併進主幹的版本>] [--deny-probe <照清單該擋的假工具名>]　（Claude 側：補複本）',
  '　或：node tools/guard-copy.js --claude-line　（Claude 側：只印要放進 .claude/settings.json 的那兩組，不寫檔）',
  '　或：node tools/guard-copy.js --retire <64 碼指紋>　（Claude 側：退役一份舊複本）',
  '',
].join('\n');

/** 回 { mode, from, to, denyProbe, retire }；不合用法＝null。四種用法不能混用；每個旗標最多一次。 */
function parseArgs(argv) {
  const takesValue = { '--from': 'from', '--to': 'to', '--deny-probe': 'denyProbe', '--retire': 'retire' };
  const bare = { '--claude': 'claude', '--claude-line': 'claudeLine' };
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const key = takesValue[k] || bare[k];
    if (!key || out[key] !== undefined) return null;
    if (bare[k]) { out[key] = true; continue; }
    i += 1;
    if (argv[i] === undefined) return null;
    out[key] = argv[i];
  }
  const given = Object.keys(out).sort().join(' ');
  if (out.claudeLine) return given === 'claudeLine' ? { mode: 'claude-line' } : null;
  if (out.retire !== undefined) return given === 'retire' ? { mode: 'retire', retire: out.retire } : null;
  if (out.claude) return out.to === undefined ? { mode: 'claude', from: out.from === undefined ? null : out.from, denyProbe: out.denyProbe } : null;
  return out.from && out.to ? { mode: 'codex', from: out.from, to: out.to, denyProbe: out.denyProbe } : null;
}

function mainClaude(args, env) {
  const leftNote = (p) => `暫存骨架沒清掉：${p}（可以直接刪，那一行不會去讀它）`;
  let r;
  try { r = buildClaude({ from: args.from, denyProbe: args.denyProbe === undefined ? null : args.denyProbe, allowTemp: env.KIT_GUARD_COPY_ALLOW_TEMP === '1' }); } catch (e) {
    const left = e && e.stagingLeft ? `；${leftNote(e.stagingLeft)}` : '';
    if (e instanceof Refusal) { process.stderr.write(`拒絕：${e.message}（沒有落地任何東西${left}）\n`); return 2; }
    process.stderr.write(`寫入或試跑途中出錯（${(e && (e.code || e.message)) || '不明'}）：沒有落地任何東西${left || '（暫存骨架若已經建了，這支自己清掉了）'}。\n`);
    return 1;
  }
  const left = r.stagingLeft ? [leftNote(r.stagingLeft)] : [];
  const summary = [`來源版本：${r.commit}（已在 ${r.tracking} 裡）`, `複本：${r.copyDir}（${r.existed ? '原本就在、自洽，沒有動它' : '新落地'}）`, `指紋：${r.fp}`];
  if (r.failure) {
    let where;
    if (r.existed) {
      where = `${r.copyDir} 原本就在，這支沒有動它——指紋是這一個的那一行現在就照用這一份；沒過的原因若是登入設定往標準輸出印字：讓它安靜，`
        + `或 node tools/guard-copy.js --retire ${r.fp}（之後那一行全擋、看得見）`;
    } else if (r.loginNoisy) where = '沒有落地任何東西';
    else if (!r.landedThenFailed) where = r.stagingLeft ? '沒有落地' : '沒有落地（暫存骨架這支自己清掉了）';
    else if (r.withdrawn) where = `落地前的試跑（HOME 指到暫存骨架）過了，落地之後用這個家再試跑沒過＝在這個人的登入設定下試跑沒過：這一次落地的那一份已經撤掉${r.stagingLeft ? '（改名進暫存骨架）' : '，沒有留下任何東西'}`;
    else where = `落地前的試跑（HOME 指到暫存骨架）過了，落地之後用這個家再試跑沒過＝在這個人的登入設定下試跑沒過，而且撤不掉：${r.copyDir} 還在，指紋是這一個的那一行現在就照用這一份——看過之後自己處理（先 chmod -R u+w）`;
    process.stderr.write([`來源版本：${r.commit}（已在 ${r.tracking} 裡）`, `指紋：${r.fp}`,
      `自我試跑沒過（${r.failure}）：${where}。不要手工造複本——原句轉給裁示者。`, ...left, ''].join('\n'));
    return 1;
  }
  let sameAsTree = null;
  try { sameAsTree = treeFingerprint() === r.fp; } catch { /* 這棵樹算不出指紋：下面照實說 */ }
  // 改過一個位元組的副本是擺在另開的暫存目錄、HOME 指到那裡跑的（selfTest 的 dupRoot），不是這個家
  const tried = r.existed
    ? '自我試跑：過（/bin/sh -c 與 -lc 各一遍：無害假名放行、該擋的假名印出拒絕（HOME 指到這個家）；改過一個位元組的副本退 2（HOME 指到另開的暫存目錄））。'
    : '自我試跑：過（落地前先用這個家跑 /bin/sh -lc \':\'，標準輸出是空的；之後兩次，每次 /bin/sh -c 與 -lc 各一遍：無害假名放行、該擋的假名印出拒絕'
      + '（第一次 HOME 指到暫存骨架、落地後第二次 HOME 指到這個家）；改過一個位元組的副本退 2（HOME 指到另開的暫存目錄））。';
  process.stdout.write(`${r.fp}\n`);
  process.stderr.write([...summary, tried, ...left,
    sameAsTree === true ? '這棵樹現在的四個檔：同一個指紋。' : `這棵樹現在的四個檔：${sameAsTree === false ? '不是這個指紋' : '算不出指紋'}（樹落後、或有還沒合併的改動）——專案 .claude/settings.json 那一行要的是哪一份，以那一行寫的指紋為準。`,
    '接下來（人做；完整順序＝本檔檔頭）：關掉所有 Claude 對話重開，叫禁區清單上刻意放的無害測試工具（裝法見 templates/canary-install.md），要看到拒絕理由含「在拒絕清單上」才算數；看到「…（指紋對不上）」那一句＝那一行要的不是這一份。⚠️ 任何會動到禁區的真工具，不論在不在清單上、不論攔截器擋不擋得住，一律絕不可以叫來試。', ''].join('\n'));
  return 0;
}

function mainClaudeLine() {
  let r;
  try { r = claudeLine(); } catch (e) {
    if (e instanceof Refusal) { process.stderr.write(`拒絕：${e.message}\n`); return 2; }
    throw e;
  }
  process.stdout.write(`${JSON.stringify({ hooks: { PreToolUse: [r.groups.PreToolUse], ConfigChange: [r.groups.ConfigChange] } }, null, 2)}\n`);
  process.stderr.write([`指紋：${r.fp}（這棵樹現在的四個檔；還沒提交的改動也算在內）`,
    '上面那兩組放進專案的 .claude/settings.json：PreToolUse 那一組換掉原本的攔截器那一組（活讀的、或舊指紋的），ConfigChange 那一組原樣放；專案原有的 permissions.deny 不動。走一支變更，不要手改那一行。',
    '這支什麼都沒寫。合併之後每台機器各跑一次 node tools/guard-copy.js --claude 補複本；順序見本檔檔頭。', ''].join('\n'));
  return 0;
}

function mainRetire(args) {
  let treeFp = null;
  try { treeFp = treeFingerprint(); } catch { /* 算不出來就不提醒 */ }
  let r;
  try { r = retire({ fp: args.retire }); } catch (e) {
    if (e instanceof Refusal) { process.stderr.write(`拒絕：${e.message}（什麼都沒刪）\n`); return 2; }
    process.stderr.write(`刪到一半出錯（${(e && (e.code || e.message)) || '不明'}）：那個目錄可能只剩一部分，看過之後自己處理。\n`);
    return 1;
  }
  process.stderr.write([`已退役：${r.copyDir}`,
    ...(treeFp === args.retire ? ['注意：這一份就是這棵樹現在四個檔的指紋——那一行指到它的對話，下一次呼叫 mcp__ 工具會全擋；要恢復就再跑一次 --claude。'] : []), ''].join('\n'));
  return 0;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (args.mode === 'claude') return mainClaude(args, env);
  if (args.mode === 'claude-line') return mainClaudeLine();
  if (args.mode === 'retire') return mainRetire(args);
  let r;
  // 暫存區放行只給考題用（考題只能在暫存區裡建目錄）；實際安裝不要設它
  try { r = build({ ...args, allowTemp: env.KIT_GUARD_COPY_ALLOW_TEMP === '1' }); } catch (e) {
    if (e instanceof Refusal) { process.stderr.write(`拒絕：${e.message}（什麼都沒寫）\n`); return 2; }
    process.stderr.write(`寫入或試跑途中出錯（${(e && (e.code || e.message)) || '不明'}）：目的地可能留有半份，看完自己刪，下次換一個新的空目錄。沒有東西可以貼。\n`);
    return 1;
  }
  const summary = [`來源版本：${r.commit}（已在 ${r.tracking} 裡）`, `複本：${r.copyDir}`, `指紋：${r.fp}`];
  if (r.failure) {
    // 沒過就不印接線：標準輸出是空的，沒有東西可以貼
    process.stderr.write([...summary, `自我試跑沒過（${r.failure}）：不印接線。複本留著給人看，看完自己刪（先 chmod -R u+w 再刪）。`, ''].join('\n'));
    return 1;
  }
  process.stdout.write(`${JSON.stringify(r.group, null, 2)}\n`);
  process.stderr.write([...summary, '自我試跑：過（/bin/sh -lc：無害假名放行、該擋的假名退 2、改過一個位元組的副本退 2）。',
    '接下來（人做，這支不碰家目錄的 .codex；完整順序＝本檔檔頭⓪〜⑥）：先確認禁區清單裡有刻意放的無害測試工具（真的存在、執行了也無害、不可以是禁區連接器上的工具——連唯讀的也不行；套件帶了一支現成的：tools/canary-server.js，名字 mcp__guard_canary__ping，裝法見 templates/canary-install.md；沒有就停下來先加、合併、重抽，不可以拿別的工具代替）→ 關掉所有 Codex 視窗 → 第一次裝＝把上面那一組加到家目錄 .codex/hooks.json 的 hooks.PreToolUse 最後面；換新複本＝在原位置換掉舊複本那一組 → 開 Codex 按信任 → 叫那個無害測試工具，要看到這一組的拒絕理由（含「在拒絕清單上」）→ 沒看到就先關掉所有 Codex 視窗、把原來那一組放回去、開 Codex 按信任、再查；看到了、而且是換新複本，才刪舊的複本目錄。⚠️ 任何會動到禁區的真工具，不論在不在清單上、不論攔截器擋不擋得住，一律絕不可以叫來試；驗收只准用清單上刻意放的無害測試工具，沒有就停下來先加。', ''].join('\n'));
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  COPY_FILES, PLACEHOLDERS, ALLOW_PROBES, TEMP_ROOTS, autoDenyProbes, fingerprint, fingerprintDir, checkTarget, extract, hookGroup, selfTest, build, main, Refusal,
  CLAUDE_TEMPLATE_REL, CLAUDE_PLACEHOLDERS, CLAUDE_BASE, CLAUDE_MAX_FILE_BYTES, CONFIG_CHANGE_MATCHER, CLAUDE_GROUP_KEYS, CLAUDE_HOOK_KEYS, groupExtraKeys,
  treeFingerprint, claudeGroups, claudeLine, copyProblem, buildClaude, retire, parseArgs,
};
