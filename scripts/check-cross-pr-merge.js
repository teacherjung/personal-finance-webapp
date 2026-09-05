#!/usr/bin/env node
// @ts-check
// **跨 PR 試合併閘**（William 2026-08-03 定）。
//
// ## 這支在解什麼
//
// 「兩支 PR 各自全綠」**不等於**「合起來全綠」。2026-08-03 一個晚上就撞了兩次，
// 而且兩次都是同一個形狀——**一支的規則，禁止了另一支的內容**：
//
// | | #384 加的規則 | #385 的內容 | 結果 |
// |---|---|---|---|
// | 第一次 | AGENTS.md 標題只准 `##`／`###` | 它寫了 `#### 兩條規則` | 各自綠、合起來紅 |
// | 第二次 | AGENTS.md 一個 `<` 都不准 | 它寫了 `🤖 <角色>｜來源：<哪個 session>` | 同上 |
//
// 兩次都**沒有改到同一個檔案的同一行**，所以：
//   ・GitHub 不顯示衝突（文字上合得起來）
//   ・兩支的 CI 都是綠的（各自跑各自的）
//   ・**合併第二支的當下，`main` 就紅了**
//
// 現有機制一個都抓不到：分支保護的 `strict` 只檢查「跟 `main` 同步」，
// 不檢查「跟另一支**開著的** PR 相容」；「預計修改的共享檔案」預約制查的是
// 檔案重疊，而這種撞法**沒有檔案重疊**。
//
// ## 為什麼做成閘，不是寫進 AGENTS.md
//
// 因為這個專案自己有證據：PR 說明的五個必填欄位是寫在規則書裡、大家都同意的規則，
// 而 2026-08-02 實測**連續三支（#374／#375／#376）漏填**。
// 「記得在合併前做試合併」是完全同一種規則——要在正確的時機、由記得的人、手動執行，
// 而**被忘記的那一次不會有任何徵兆**。
//
// 做成閘之後，AGENTS.md 只需要多一個**名字**（自報的 `MERGE_GATE` 會強迫兩處摘要點名它），
// 不需要多一條要記住的規則。照 AGENTS.md 自己那句話：**摘要會落後，名字不會。**
//
// 用法：node scripts/check-cross-pr-merge.js <PR 編號>
// 退出碼：0＝沒有其他 open PR，或每一支試合併之後三關都綠
//         1＝有一支合起來會壞（文字衝突／測試紅）→ 停下來，先處理相容性
//         2＝查不清楚（gh 失敗／不是 git repo／發起樹沒有可用的 node_modules／
//             合併後的 package-lock.json 跟已裝的套件對不上／
//             試合併或三關「執行不起來」（git merge 失敗但沒有未合併檔案／spawn 失敗／被訊號終止／126／127）／
//             建不出臨時工作區）→ fail-closed
//
// ## 紅了怎麼辦
//
// 這道閘量到的不只是相容性，還有機器忙不忙（量時間／記憶體的考題在多支審查併行時會假紅，
// 而執行合併的人自己就是負載）。退出碼 1 可以重跑一次、附帶限制——規則正本在
// REVIEW-AND-MERGE.md 跨 PR 試合併那一步，限制句與退出碼 1 的訊息共用 `RERUN_LIMITS` 這一串。
// 這裡只講它跟下一節的關係：**lock 對不上那種退 2 不適用重跑**——重跑一百次結果都一樣。
//
// ## 誠實劃界
//
// 擋得住：**測試看得到**的互相破壞（一支的護欄擋掉另一支的內容、型別對不上、行為衝突）。
// **擋不住**：兩支合起來語意上矛盾、但測試沒有覆蓋到的地方——那還是要人看。
// 它也**不保證**合併之後 `main` 一定是綠的：它試的是「這兩支的 head」，
// 而真正合併時 `main` 可能已經又前進了（那一段由 `strict` 與 CI 接手）。
// 「執行不起來」＝**試合併或三關沒有取得可判讀的結果**：沒有合併判決（git merge 失敗、也沒留下未合併
// 檔案——不確定是不是兩支撞行）或沒有測試判決（spawn 失敗／被訊號終止／126／127），成因這裡不推定
// ——實際出現過的至少有四種：環境（node_modules 殘缺——#441）、兩支合壞了 scripts 呼叫的追蹤檔案
// （#446 r2 Codex 造出來）、測試自己以 127 收場（#446 r3 Codex 造出來）、merge 本身失敗（#566 r1／r2）。
// 所以這一族一律退 2「查不清楚」，只擋下來要人查；
// node_modules 殘缺到「跑得起來但缺套件」的灰色地帶：lock 有列的缺套件會被下一段的 lock 核對先擋成 2；
// lock 沒列的殘缺（.bin 斷了、套件內少檔）三關仍會以紅（1）收場——那時死因欄裡的 stderr 尾巴就是人工判讀的依據。
// **它不會安裝套件**：三關用發起樹已裝好的 `node_modules`（symlink 指回去，多半是主目錄那份）。
// 在途 PR 動了 `package-lock.json`（例：2026-09-02 #548 加 devDependency）時，三關其實是
// 拿舊套件在跑——結果可能假紅、也可能假綠。所以合併之後先核對：lock 要求的每一個套件，
// 已裝的名字、版本與安裝紀錄的來源／指紋對不對得上（`lockMismatches`）；對不上一律退 2 並明說，不進三關。
// 核對的射程：「lock 要的有沒有裝、套件名對不對、版本對不對、來源（resolved）與內容指紋（integrity）
// 對不對」——後兩項對照 npm 自己寫的 `node_modules/.package-lock.json`（隱藏 lock＝npm 的安裝紀錄；
// 經 npm 換過的同名同版 tarball——#566 r2 Codex 用本機 tarball 實作出來——它記得）；讀不到隱藏 lock＝
// 核對不了來源與內容，算對不上。⚠️ **這整段核對的是中繼資料的一致，不是磁碟內容的證明**：
// 半途被殺的 npm install（磁碟已換、兩份 lock 都留舊）、手動複製同名同版的套件內容——這些發起樹自己的
// 完整性問題本閘看不到（#566 r3 Codex 實作出來），也不打算看：要證明內容就得在乾淨樹 `npm ci`
// 物化整棵相依樹，那是手動路徑，不是本閘的射程。Node 實際載入誰也不看：多裝的頂層套件遮蔽巢狀的、
// `.bin` 指向誰、`NODE_OPTIONS` 注入——這些都不在核對裡（Grok #566 掃 #2）。**多裝的套件看不到**（拿掉
// 相依的那支若程式仍引用它，這裡不會紅；CI 的 `npm ci` 會）；`optional` 的套件沒裝不算（平台
// 專屬二進位本來就只裝自己那一個）；workspace 連結（`link`）核對不了指向哪一版、lock 結構壞掉
// （packages 不是物件、沒有根項目、項目不是物件）核對不了——這兩種一律當對不上（#566 r1 Codex
// 用 link／alias／`packages: []` 三個反例證明「跳過」會假綠）。刻意不自動安裝：本機 npm 的 `ci`
// 會順著 symlink 逐項清掉主目錄的 node_modules（CLAUDE.md 的禁區）。處置寫在 verdict 的 lock
// 訊息裡（哪一側動了 lock 決定該做什麼），這裡不重抄。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync, unlinkSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isMainModule } from '../lib/is-main.js';
import { gitEnv } from '../lib/git-env.js';

/**
 * **這支是合併程序的一道機械閘**——`test/collab-invariant-docs.test.js` 靠這個標記
 * 反查「現在到底有幾道閘」，再要求文件把每一道都點名得出來。
 */
export const MERGE_GATE = {
  name: '跨 PR 試合併',
  why: '兩支各自全綠不代表合起來全綠——一支的規則可能禁止另一支的內容',
};

/**
 * 「紅了重跑一次」的限制句——退出碼 1 的訊息與 REVIEW-AND-MERGE.md 正本共用同一串，
 * 考題釘兩邊都逐字含它：正本漂了、訊息漂了，都會紅。這一串本身不承載「幾個」——
 * 它就是全部的限制；「重跑前先看是哪一題紅」是動作指示，不是第四個限制。
 */
export const RERUN_LIMITS = '只限這一道閘、只限一次、第二次紅照擋';

/**
 * 從「考試」那關的 stdout 撈出 spec reporter 的失敗題名（`✖ 題名 (…ms)` 那些行）。
 * 為什麼要另外撈：`redDetail` 的視窗只留首行與末幾行，題名多半在中段——沒有它，
 * 「重跑前先看是哪一題紅」照字面做不到（預審實跑證實）。排除「✖ failing tests:」那個
 * 摘要標題、去重（spec reporter 會印兩次）、最多留幾條——條數是調校值不承重。
 * @param {string | undefined} stdout
 * @returns {string[]}
 */
export function failingTestNames(stdout) {
  const seen = new Set();
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!/^✖ /.test(line) || /^✖ failing tests:/.test(line)) continue;
    const name = line.replace(/^✖ /, '').replace(/\s*\(\d+(\.\d+)?ms\)$/, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 要拿來試合併的其他 PR。
 *
 * ⚠️ 判準只有兩條，刻意不多：**base 是 `main`**、**不是自己**。
 * 草稿（draft）也算——它一樣會被合併，而且草稿階段正是最容易寫出互斥內容的時候。
 * @param {{number: number, headRefOid: string, headRefName: string, baseRefName: string, isDraft?: boolean}[]} list
 * @param {number} self
 */
export function othersToTry(list, self) {
  return list
    .filter((p) => p.number !== self && p.baseRefName === 'main')
    .sort((a, b) => a.number - b.number);
}

/**
 * 「執行不起來」訊息列出的成因可能——**資料，不是散文**：考題驗這份資料的結構
 * （環境與非環境的成因必須同時存在），訊息再由它組出來。散文式的內文被實測過
 * 「把三種可能全改寫成環境歸因、保留關鍵字」照樣全綠（#446 r4）——關鍵字守不住語意，
 * 結構守得住。kind：'env'＝發起樹／執行環境的問題；'cross-pr'＝兩支合出來的破壞；
 * 'self-exit'＝受測內容自己以 126／127 收場；'merge'＝試合併本身失敗、沒有合併判決（#566 r1／r2）。
 * ⚠️ 誠實劃界：考題擋得住「改結構」（刪掉非環境成因、拔 kind、資料與訊息斷線），
 * **擋不住**「kind 留著、把 text 改寫到失真」——散文的真實性只能靠審查的人讀；
 * 往散文語意無限逼近的字串斷言＝過擬合，正當改寫時反而誤紅。
 */
export const CANT_RUN_CAUSES = [
  { kind: 'env', text: '發起樹的 node_modules 殘缺（空的、.bin 斷了）或 npm 不可用（#441 實際發生的形狀）' },
  { kind: 'cross-pr', text: '兩支合起來弄壞了 scripts 會呼叫的**追蹤檔案**（一支開始呼叫、另一支刪檔或拔執行位——#446 r2 的反例）' },
  { kind: 'self-exit', text: '測試或指令自己以 126／127 收場（#446 r3 的反例）' },
  { kind: 'merge', text: '試合併本身失敗、也沒有留下未合併的檔案——**沒有取得可判讀的衝突結果**，不確定是不是兩支撞行：沒有 committer 身分、hook 拒絕、git 執行錯誤、merge 中途被訊號終止（#566 r1／r2 Codex 各實作出一種）' },
];

/**
 * verdict 輸入的形狀檢查——回「哪一筆哪個欄壞了」的清單（空＝形狀正確）。只描述索引與欄名，不帶值。
 * 判準：整包陣列；每筆非陣列物件；number 正整數；why 字串；ok 布林；ok:true 不得帶 kind（矛盾）；
 * ok:false 的 kind 若有寫要是字串（合法值由 verdict 的下一道驗）。
 * @param {unknown} results
 * @returns {string[]}
 */
export function resultShapeProblems(results) {
  if (!Array.isArray(results)) return ['整包不是陣列'];
  const out = [];
  // ⚠️ 用索引走完每一格、不用 forEach：稀疏陣列的空槽 forEach 會跳過（#566 r7 Codex：verdict(Array(1)) 退 0）；
  //    「帶不帶 kind」看 own property，不看值是不是 undefined（顯式 kind: undefined 也是帶了）。
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) { out.push(`第 ${i} 筆：不是物件`); continue; }
    const x = /** @type {Record<string, unknown>} */ (r);
    const hasKind = Object.prototype.hasOwnProperty.call(x, 'kind');
    const bad = [];
    if (!(typeof x.number === 'number' && Number.isInteger(x.number) && x.number > 0)) bad.push('number 不是正整數');
    if (typeof x.ok !== 'boolean') bad.push('ok 不是布林');
    if (typeof x.why !== 'string') bad.push('why 不是字串');
    if (x.ok === true && hasKind) bad.push('ok:true 卻帶 kind（矛盾）');
    if (x.ok === false && hasKind && typeof x.kind !== 'string') bad.push('kind 不是字串');
    if (bad.length) out.push(`第 ${i} 筆：${bad.join('、')}`);
  }
  return out;
}

/**
 * 把每一支的試合併結果彙整成退出碼與訊息。
 *
 * ⚠️ 分類一律看**結構化的 `kind`**（tryMerge 在知道死法的當下標的），不嗅 `why` 的散文
 * ——`why` 裡包著測試自己的輸出，內容剛好出現「文字衝突」「紅了」字樣不代表它是那種
 * 死法（#446 r5 實測：真測試紅的錯誤文字提到「文字衝突」，嗅字串的版本把它分類成衝突）。
 *
 * `kind: 'cantRun'`（試合併或三關「執行不起來」）＝**拿不到可信的合併判決或測試判決**，一律轉成
 * 退出碼 2「查不清楚」，不可以混進「合起來會壞」（1）——但也**不宣稱一定是環境**：126／127
 * 兩支各自全綠的 PR 也造得出來（見 `cantRunSignal` 檔頭）；merge 失敗沒留下未合併檔案也造得出來
 * （#566 r1／r2）。只要有一筆 cantRun，整輪就以 2 收場（三關共用同一份發起樹的 node_modules、
 * merge 走同一個 git——它們若真的壞了，同輪其他結果的可信度也存疑）；同輪若另有已確定的阻擋（衝突／測試紅），訊息要照 kind 點名保留
 * ——下不了定論的是 cantRun 那幾筆，不是整輪的事實。
 *
 * ⚠️ 型別的分工（#446 r6）：**產出端**（tryMerge）用 discriminated union 鎖
 * 「失敗必帶 kind」——從失敗出口拔掉 kind，校對當場紅。**本函式**是 exported 純函式，
 * 執行期什麼都可能被餵進來（型別擋不了 runtime），所以「kind 缺席／不認得」有專屬的
 * 前置防線：**不論跟誰混輪、或單獨出現，一律整輪退 2**——不冒充衝突、不冒充測試紅，
 * 也不讓「合起來會壞」（1）替它背書（#446 r7：舊版的保守分支只在混到 cantRun 時生效，
 * 單獨缺席仍以 1 收場、還被測試紅的 footer 籠罩）。
 * `kind: 'lock'`（合併後的 package-lock.json 跟已裝的套件對不上）也是 2：三關還沒跑、或跑了也是拿舊
 * 套件在跑，同樣拿不到可信的判決；跟 cantRun 的差別是**成因已知、處置明確、重跑無效**，
 * 所以訊息分開寫。
 * @param {{number: number, ok: boolean, why: string, kind?: 'conflict' | 'red' | 'cantRun' | 'lock'}[]} results
 */
export function verdict(results) {
  // ⚠️ 前置防線的第一道是**形狀**（射程＝普通 JSON／JS 值，不管 Proxy／getter）：整包是陣列、每筆是非陣列物件、
  //    number 是正整數、why 是字串、ok 是布林，而且 ok:true 不得帶失敗 kind、ok:false 的 kind 由下一道驗。
  //    「false」字串在 truthiness 下是「綠」（#566 r5 Codex 實跑得到 0）、NaN 編號會印 #NaN、矛盾形狀會被宣告全綠
  //    （r6）——形狀不對＝這一輪的資料不可信，整輪退 2。診斷只列索引與壞的欄名，**不回聲 payload**：這條分支的
  //    敘事就是「有別的東西在餵結果」，把未知內容整包印出來是另一個洞。
  const shapeProblems = resultShapeProblems(results);
  if (shapeProblems.length) {
    return {
      code: 2,
      message: '跨 PR 試合併：**查不清楚——有結果的形狀不對，這一輪的分類不可信**\n'
        + shapeProblems.map((p) => `  ・${p}`).join('\n')
        + '\n\n⚠️ 正式路徑（tryMerge）產出的每一筆都是固定形狀——出現別的形狀＝有別的東西在餵結果、或程式被改壞。'
        + 'fail-closed 擋下，先查結果是哪來的。',
    };
  }
  const bad = results.filter((r) => r.ok === false);
  const unlabeled = bad.filter((r) => r.kind !== 'conflict' && r.kind !== 'red' && r.kind !== 'cantRun' && r.kind !== 'lock');
  if (unlabeled.length) {
    return {
      code: 2,
      message: '跨 PR 試合併：**查不清楚——有結果沒有標記死法（kind），這一輪的分類不可信**\n'
        + bad.map((r) => `  ・#${r.number}：${unlabeled.includes(r) ? '【死法未標記】' : ''}${r.why}`).join('\n')
        + '\n\n⚠️ 正式路徑（tryMerge）的每一筆失敗都帶 kind（型別鎖著）——出現未標記＝'
        + '有別的東西在餵結果、或程式被改壞。不推定它是衝突、測試紅還是執行不起來，'
        + 'fail-closed 擋下，先查結果是哪來的。',
    };
  }
  if (bad.some((r) => r.kind === 'lock')) {
    const confirmed = bad.filter((r) => r.kind === 'conflict' || r.kind === 'red');
    const kinds = [...new Set(confirmed.map((r) => (r.kind === 'conflict' ? '文字衝突' : '跑得起來的測試紅')))];
    return {
      code: 2,
      message: '跨 PR 試合併：**查不清楚——合併後的套件清單跟已裝的套件對不上，三關若照跑是拿舊套件當結果，這一輪不算數**\n'
        + bad.map((r) => `  ・#${r.number}：${r.why}`).join('\n')
        + '\n\n⚠️ 這種結果**重跑一百次都一樣，不適用「紅了重跑一次」**。'
        + '三關要在跟合併後 package-lock.json 一致的套件上跑才算數；先看上面「哪一側動了 lock」：\n'
        + '   ・兩側都「否」且合併後的 lock 跟 main 的**一樣**＝發起樹的套件沒跟上 lock：發起樹是主目錄時，在**主目錄本身**跑 npm install'
        + '（主目錄不是 worktree、不在 CLAUDE.md 禁區；用 install 不用 ci，ci 會先整個刪掉 node_modules）後重跑本閘。\n'
        + '   ・兩側都「否」但合併後的 lock 跟 main 的**不一樣**＝兩支都落後 main（合併後的 lock 是舊的、發起樹是新的）：'
        + '先讓兩支跟上 main（rebase）再跑本閘，重裝發起樹沒有用。\n'
        + '   ・對方那側「是」＝先合併那一支、發起樹裝好後再跑本閘。\n'
        + '   ・本支那側「是」（本支自己動了 lock）＝發起樹裝不到它：開一棵**沒掛 symlink 的全新臨時樹**'
        + '（git worktree add 到本支 head 之後不掛連結）npm ci，然後**從那棵樹重跑本閘、拿到退出碼 0 才算數**'
        + '（不是手動跑三關——REVIEW 的「退出碼 0 才可進下一步」只認本閘的 0）；PR 留言附那棵樹的路徑與 lock sha，用完收樹前確認 node_modules 是真目錄再刪。\n'
        + '   ・兩側都「是」＝先合併對方那一支、發起樹裝好之後，本支仍要走上一條的手動路徑。\n'
        + '   ・側別印「查不到」＝本機沒有 main 目前那顆 commit（沒 fetch）或 git 查不出來：先 git fetch origin main 再跑本閘；查不到不等於沒動。\n'
        + '   ⚠️ 本閘造的臨時樹掛著 symlink，不可以在那裡裝；不要在掛著 symlink 的 worktree 裡動 node_modules（CLAUDE.md 的禁區）。'
        + (confirmed.length
          ? `\n   ⚠️ 上列另有**本輪已確定的阻擋**（${kinds.join('、')}）——那些不因本輪下不了定論而失效。`
          : ''),
    };
  }
  if (bad.some((r) => r.kind === 'cantRun')) {
    const confirmed = bad.filter((r) => r.kind !== 'cantRun');
    const kinds = [...new Set(confirmed.map((r) => (r.kind === 'conflict' ? '文字衝突' : '跑得起來的測試紅')))];
    return {
      code: 2,
      message: '跨 PR 試合併：**查不清楚——有步驟「執行不起來」（試合併或三關），這一輪下不了定論**\n'
        + bad.map((r) => `  ・#${r.number}：${r.why}`).join('\n')
        + '\n\n⚠️ 「執行不起來」（spawn 失敗如 ENOENT／EACCES、被訊號終止、退出碼 126／127、或 git merge 失敗卻沒有未合併的檔案）'
        + '＝**沒有取得可直接判讀的正常結果**，這裡不推定成因。實際出現過的可能至少有這幾種：\n'
        + CANT_RUN_CAUSES.map((c) => `   ・${c.text}`).join('\n') + '\n'
        + '   排查起點：從主目錄重跑一次這道閘作對照，再照上面的死因欄逐條查。'
        + (confirmed.length
          ? `\n   ⚠️ 上列另有**本輪已確定的阻擋**（${kinds.join('、')}）——那些不因本輪下不了定論而失效。`
          : ''),
    };
  }
  if (!bad.length) {
    return {
      code: 0,
      message: results.length
        ? `跨 PR 試合併：與 ${results.length} 支 open PR 合起來都是綠的（#${results.map((r) => r.number).join('、#')}）。`
        : '跨 PR 試合併：目前沒有其他 open PR，不需要試。',
    };
  }
  return {
    code: 1,
    message: '跨 PR 試合併：**合起來會壞**\n'
      + bad.map((r) => `  ・#${r.number}：${r.why}`).join('\n')
      // ⚠️ 兩種壞法要分開講，不可以混為一談（實跑第一次就發現我原本的訊息不準）：
      //    文字衝突 GitHub **會**顯示；測試紅 GitHub **不會**——後者才是這道閘存在的理由。
      //    判準看 kind，不嗅 why（理由見本函式檔頭——測試輸出裡可能剛好有這些字樣）。
      + (bad.some((r) => r.kind === 'conflict')
        ? '\n\n⚠️ **文字衝突**：這種 GitHub 自己就看得到（合併鍵會變灰）。'
          + '這道閘的價值在於**現在**就告訴你，而不是等到要合併的那一刻。'
        : '')
      + (bad.some((r) => r.kind === 'red')
        ? '\n\n⚠️ **合起來測試紅**：這種 GitHub **不會**顯示——兩支各自的 CI 都是綠的、'
          + '也沒有檔案衝突，**合併第二支的當下 `main` 就紅了**。\n'
          + '   通常是其中一支的護欄擋掉了另一支的內容。先讓兩支相容再合併。\n'
          + '   量時間／記憶體的考題在機器忙時會假紅——先看上面「紅的考題」是不是那種題（只有「考試」那關會列題名，校對／糾察紅了看死因欄）；'
          + `可以重跑**一次**（${RERUN_LIMITS}；規則正本在 REVIEW-AND-MERGE.md 跨 PR 試合併那一步）。`
        : ''),
  };
}

/**
 * ⚠️ **`gh` 也走 `runIn`**（#463 r1 High）：它會**自己再去 spawn git**——實測
 * `env GIT_DIR=<不存在的路徑> gh pr view <N>` 回 `failed to run git: fatal: not a git repository`。
 * ⚠️ 它一度繞過 `runIn`（`fd054dc`），於是下面那句「所有外部指令的唯一入口」曾經是**撐不住的保證**
 *   ——#463 r1 複審抓到。留著這個落點是因為那句宣稱還在，下一個人要知道它靠什麼成立。
 * 漏清的後果分兩種：指到不存在的路徑＝假阻擋；指到另一個**有效** repo＝這道閘去讀
 * **那個** repo 的 PR 與 open PR 清單，而輸出看起來完全正常。
 * @param {string[]} args
 */
function gh(args) {
  return runIn(['gh', ...args], process.cwd(), { maxBuffer: 1e8 });
}

/**
 * **這支腳本所有外部指令的唯一入口**——一律在清乾淨的環境下跑（見 `lib/git-env.js`）。
 *
 * ⚠️ 為什麼這一支特別要緊：它不是唯讀的。它會 `git worktree add`／`git merge`／
 *    `git worktree remove`，而**繼承來的 `GIT_DIR` 會讓 git 完全不看 `cwd`**
 *    ⇒ 這些「建立」與「移除」有可能落在**別的 repo** 上。
 *
 * ⚠️ **`npm run …` 也走這裡，不是順手**：那條路會在臨時工作區跑整套考題，
 *    而 2026-08-09 的事故正是「考題在帶著 `GIT_DIR` 的環境下跑」造成的
 *    （機制在 `scripts/check-worktree-integrity.js` 檔頭）。這道閘自己就是一個
 *    「從別處繼承環境、再去跑考題」的入口，不清等於把那個前提條件重新製造一次。
 *
 * ⚠️ **`gh` 也走這裡**（#463 r1 High）：它會自己再去 spawn git，理由與實測在 `gh()` 上方。
 *
 * @param {string[]} argv 指令與參數（`argv[0]` 是執行檔）
 * @param {string} cwd 明確指定工作目錄——**不可省**，省了就只剩 `process.cwd()` 這個隱含前提
 * @param {{ maxBuffer?: number }} [opts] 額外的 `execFileSync` 選項（⚠️ **不接受 `env`**：
 *   環境是本函式存在的理由，開放覆寫等於留一道繞過清理的門）
 * @returns {string} stdout（`stdio: 'pipe'`＝不把子行程的輸出混進本閘的訊息）
 */
export function runIn(argv, cwd, opts = {}) {
  return execFileSync(argv[0], argv.slice(1),
    { ...opts, cwd, encoding: 'utf8', stdio: 'pipe', env: gitEnv() });
}

/**
 * 把三關失敗的 execFileSync 錯誤壓成一行死因。
 *
 * ⚠️ **stderr 的尾巴一定要帶**：只截 stdout 的話，127「指令找不到」這種環境錯誤
 * 完全看不見——stdout 只有 npm 的執行橫幅，「command not found」與 npm 的錯誤碼
 * 整段都在 stderr（2026-08-11 #441 誤報時，訊息裡只有橫幅，看的人分不出
 * 「測試紅」跟「環境壞」）。兩邊都空（如 spawn 本身失敗）就退回 message。
 * @param {{stdout?: string, stderr?: string, message?: string} | null | undefined} err
 */
export function redDetail(err) {
  // 太長時**頭尾都留、截中段**——行的層級與字元的層級各做一次：死因可能在頭
  // （sh 的「command not found」是 stderr 第一行），也可能在尾（npm 的錯誤碼、最後
  // 一行斷言）。只留開頭的寫法裁掉過末行死因（#446 r1）；只取末 N 行的寫法在輸出
  // 超過 N 行時把首行整行丟掉（#446 r7）——所以行數超窗時**首行永遠保留**。
  // 窗寬（3／8）是調校值不是承重點；承重的是「首行與末行都活著」。
  const clip = (/** @type {string} */ s) =>
    s.length <= 300 ? s : `${s.slice(0, 150)} …（截掉中段）… ${s.slice(-150)}`;
  const tail = (/** @type {string | undefined} */ s, /** @type {number} */ n) => {
    const lines = String(s || '').split('\n').filter(Boolean);
    const kept = lines.length <= n
      ? lines
      : [lines[0], `…（略 ${lines.length - n} 行）…`, ...lines.slice(-(n - 1))];
    return clip(kept.join(' / '));
  };
  const out = tail(err?.stdout, 3);
  const errOut = tail(err?.stderr, 8);
  return [out, errOut && `stderr：${errOut}`].filter(Boolean).join('｜')
    || String(err?.message || '').slice(0, 300) || '（子行程沒有留下任何輸出）';
}

/**
 * 三關的失敗屬不屬於「執行不起來」（＝拿不到可信的測試判決）。是＝回症狀字串（給死因欄），
 * 不是＝回 null（那是「跑得起來的紅」，照舊算紅）。
 *
 * 錯誤形狀（execFileSync，2026-08-11 實測）：正常非零退出＝`status` 是數字；
 * spawn 失敗（ENOENT／EACCES…）＝`status: null`＋`code` 是 errno 字串；
 * 被訊號終止＝`status: null`＋`signal`。所以判準是「**拿不到數字退出碼**」＋ shell 的
 * 126（不可執行）／127（找不到指令）。⚠️ 列舉 errno 名單在這裡是錯的寫法——
 * #446 r2 Codex 實測 EACCES（npm 存在但不可執行）就漏在 r2 的 ENOENT 名單外。
 *
 * ⚠️ 這一族**判定不了成因**，也不推定：環境（node_modules 殘缺）、兩支合壞了追蹤檔案
 * （#446 r2 Codex 造出 126／127 的兩支全綠反例）、甚至測試自己印完輸出再以 127 收場
 * （#446 r3 Codex 實測 status 一樣是 127）——三種都真實存在。誠實語意只有「沒有取得
 * 可直接判讀的正常結果」，由 verdict 整輪退 2，不宣稱是誰的錯。
 * 跑得起來的紅（含 eslint 的退出碼 2＝可能是合出來的壞設定）刻意不歸這裡。
 * @param {{status?: number | null, code?: string, signal?: string | null} | null | undefined} err
 * @returns {string | null}
 */
export function cantRunSignal(err) {
  if (!err || typeof err.status !== 'number') {
    return String(err?.code ?? (err?.signal ? `被 ${err.signal} 終止` : '沒有退出碼'));
  }
  return (err.status === 126 || err.status === 127) ? `退出碼 ${err.status}` : null;
}

/**
 * 一筆試合併的結果。⚠️ **失敗必帶 kind**（discriminated union，#446 r6 的鎖）：
 * 分類全靠它，從失敗出口拔掉或漏標＝校對（typecheck）當場紅，
 * 不會靜靜滑進 verdict 的「未標記」保守分支。
 * @typedef {{number: number, ok: true, why: string}
 *   | {number: number, ok: false, why: string, kind: 'conflict' | 'red' | 'cantRun' | 'lock'}} MergeTry
 */

/**
 * 合併後的 `package-lock.json` 要求的每一個套件，已裝的是不是同名同版。回對不上的清單（空＝對得上）。
 *
 * 判準，刻意只有這幾條：①`packages` 表要是物件、要有根項目 `""`、每個項目要是物件——否則無法核對，
 * 算對不上（fail-closed；`packages: []`／`{}`／項目 `null` 都是 #566 r1 的反例）；②每個套件都要裝著、
 * **名字**（alias 用 `name` 欄、否則取路徑最後一段）與版本逐字相同——同版號不同套件也算對不上；
 * ③`optional: true` 的沒裝不算（平台專屬二進位只裝自己那一個，其餘的本來就不裝）；④workspace 連結
 * （`link: true`）核對不了 node_modules 裡那條連結指向哪一版（發起樹的連結指回發起樹，不是合併後的樹），
 * 一律算對不上。**多裝的看不到**（劃界在檔頭）。
 * ⑤同名同版還要**來源與內容指紋**相同：lock 項目有 `resolved`／`integrity` 時，對照 npm 寫在
 * `node_modules/.package-lock.json`（隱藏 lock＝npm 的安裝紀錄）裡的那一筆；隱藏 lock 讀不到或沒那一筆＝
 * 核對不了，算對不上；兩個欄位都沒寫（bundled 子套件常只有 version）就只比到名字版本。這一項擋的是
 * 「經 npm 換過的同名同版內容」（#566 r2 的反例）；**它不是磁碟內容的證明**（半途被殺的安裝、手動換內容，
 * 兩份 lock 都會留舊——#566 r3 的反例），劃界在檔頭。
 * 純函式：檔案系統由呼叫端用 `installed` 與 `hidden` 注入，考題直接餵資料。
 * @param {any} lock 解析後的 package-lock.json
 * @param {(key: string) => {name: string, version: string} | null} installed 讀 `<key>/package.json` 的 name 與 version；不存在或讀不了回 null
 * @param {any} hidden 隱藏 lock 的 packages 表（`node_modules/.package-lock.json`）；讀不到給 null
 * @param {{platform?: string, arch?: string, pkgJson?: any}} [opts] platform／arch＝這台機器（optional 缺套件時看 os／cpu 是不是本機該裝的）；
 *   pkgJson＝合併後的 package.json（有給就驗它宣告的相依都在 lock 的 packages 裡——git 三方合併 lock 可能合出合法 JSON 卻少了套件，Grok #566 掃 #7）
 * @returns {string[]}
 */
/** lock 的套件路徑合法形狀：`node_modules/` 開頭、只有一般路徑段（不含 `.`／`..`／空段）、不含反斜線與空字元。 @param {string} key */
const LOCK_KEY_OK = (key) => typeof key === 'string' && key.startsWith('node_modules/') && !/[\\\0]/.test(key)
  && key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');

/** lock 項目的承重欄位與它們該有的型別（有寫才驗；沒寫走預設）。 */
const LOCK_ENTRY_FIELDS = /** @type {const} */ ([['version', 'string'], ['name', 'string'], ['link', 'boolean'], ['optional', 'boolean'], ['resolved', 'string'], ['integrity', 'string']]);

export function lockMismatches(lock, installed, hidden, opts = {}) {
  const isObj = (/** @type {any} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const packages = isObj(lock) ? lock.packages : undefined;
  if (!isObj(packages) || !Object.prototype.hasOwnProperty.call(packages, '') || !isObj(packages[''])) {
    return ['package-lock.json 的 packages 表缺席、不是物件、沒有根項目、或根項目不是物件（lockfileVersion 1、格式不對、或讀不到），無法核對'];
  }
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const out = [];
  // package.json 宣告的相依都要在 lock 的 packages 裡：git 三方合併 package-lock.json 可能合出合法 JSON 卻少了
  // 一支加的套件（Grok #566 掃 #7）——少掉＝沒宣告＝核對掃不到它，三關若沒碰到就是假綠。
  if (isObj(opts.pkgJson)) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = opts.pkgJson[field];
      if (!isObj(deps)) continue;
      for (const name of Object.keys(deps)) {
        if (!isObj(packages[`node_modules/${name}`])) out.push(`${name}：package.json 的 ${field} 有宣告，lock 的 packages 卻沒有這一筆（lock 跟 package.json 不一致）`);
      }
    }
  }
  let hiddenMissingSaid = false;
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue;
    if (!isObj(entry)) { out.push(`${key}：lock 項目不是物件，無法核對`); continue; }
    // key 是拿去讀檔的路徑：必須是 `node_modules/…` 的相對路徑，不含 `..` 段、反斜線、空字元、絕對路徑——
    // 否則 `..` 會逃出臨時樹、借樹外的 package.json 讓核對假綠（#566 r8 Codex 實作出來）。格式錯＝無法核對。
    if (!LOCK_KEY_OK(key)) { out.push(`${key}：lock 的套件路徑不合法（不是 node_modules/… 相對路徑、或含 ..），無法核對`); continue; }
    // 承重欄位「有寫就要是對的型別」（#566 r5／r6 Codex：optional:'false'、link:0、name:0、resolved:0 在 truthiness 或
    // typeof 退路下都變成「沒寫」而放行）——型別錯＝lock 壞掉，無法核對；沒寫才走各自的預設。
    const typeBad = LOCK_ENTRY_FIELDS.filter(([f, t]) => entry[f] !== undefined && typeof entry[f] !== t).map(([f]) => f);
    if (typeBad.length) { out.push(`${key}：lock 項目的 ${typeBad.join('／')} 欄型別不對，無法核對`); continue; }
    if (entry.link === true) { out.push(`${key}：workspace 連結（link）核對不了指向哪一版，視為對不上`); continue; }
    const want = String(entry.version ?? '');
    // name 有寫就用（空字串也算「有寫」——空字串跟已裝的名字對不上，是 lock 壞掉，不是「沒寫」）
    const wantName = entry.name !== undefined ? entry.name : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const have = installed(key);
    if (have === null) {
      if (entry.optional !== true) { out.push(`${key}：lock 要 ${wantName}@${want}，沒有裝`); continue; }
      // optional 缺套件：只有「這台機器本來就不該裝」（os／cpu 清單排除本機）才放行；本機該裝的 optional 缺了
      // 一樣對不上——原生二進位沒裝、三關沒碰到就是假綠（Grok #566 掃 #1）。libc 不看（劃界）。
      if (platformWanted(entry.os, platform) && platformWanted(entry.cpu, arch)) out.push(`${key}：optional 但這台機器（${platform}／${arch}）該裝的沒有裝`);
      continue;
    }
    if (have.name !== wantName) { out.push(`${key}：lock 要的是 ${wantName}，裝的是 ${have.name}（同版號也不算）`); continue; }
    if (have.version !== want) { out.push(`${key}：lock 要 ${want}，裝的是 ${have.version}`); continue; }
    // 同名同版還不夠：來源（resolved）與內容指紋（integrity）要跟 npm 的安裝紀錄（隱藏 lock，
    // node_modules/.package-lock.json）一致。lock 有寫才比；隱藏 lock 讀不到或沒有這一筆＝核對不了，
    // 算對不上（經 npm 換過的同名同版內容＝#566 r2 的反例）。不是磁碟內容證明——劃界在檔頭。
    const wantsProvenance = typeof entry.resolved === 'string' || typeof entry.integrity === 'string';
    if (!wantsProvenance) continue;
    if (!isObj(hidden)) {
      if (!hiddenMissingSaid) { out.push('node_modules/.package-lock.json 讀不到或格式不對，核對不了套件的來源與內容指紋'); hiddenMissingSaid = true; }
      continue;
    }
    const h = hidden[key];
    if (!isObj(h)) { out.push(`${key}：隱藏 lock 沒有這一筆，核對不了來源與內容指紋`); continue; }
    if ((h.resolved !== undefined && typeof h.resolved !== 'string') || (h.integrity !== undefined && typeof h.integrity !== 'string')) { out.push(`${key}：隱藏 lock 那一筆的 resolved／integrity 欄型別不對，無法核對`); continue; }
    if (typeof entry.integrity === 'string' && h.integrity !== entry.integrity) { out.push(`${key}：內容指紋（integrity）根 lock 與隱藏 lock 的中繼紀錄不同（同名同版換了內容、或安裝紀錄沒跟上）`); continue; }
    if (typeof entry.resolved === 'string' && h.resolved !== entry.resolved) out.push(`${key}：來源（resolved）根 lock 與隱藏 lock 的中繼紀錄不同：lock 要 ${entry.resolved}，隱藏 lock 記的是 ${h.resolved ?? '（未記錄）'}`);
  }
  return out;
}

/** 讀某棵樹 `node_modules/.package-lock.json` 的 packages 表（npm 的安裝紀錄：它上次裝的來源與指紋——中繼紀錄，不是磁碟內容證明）；讀不到回 null。 @param {string} root */
function hiddenLockIn(root) {
  try {
    const h = JSON.parse(readFileSync(join(root, 'node_modules', '.package-lock.json'), 'utf8'));
    return h && typeof h === 'object' && !Array.isArray(h) && h.packages && typeof h.packages === 'object' && !Array.isArray(h.packages) ? h.packages : null;
  } catch { return null; }
}

/**
 * 量「哪一側動了 lock」要用的 main 參考點。回 null＝查不到。理由與順序寫在呼叫處。
 * @param {string} wt @param {string} [mainSha]
 * @returns {string | null}
 */
function resolveMainRef(wt, mainSha) {
  const has = (/** @type {string} */ ref) => { try { runIn(['git', 'cat-file', '-e', `${ref}^{commit}`], wt); return true; } catch { return false; } };
  const originMain = () => { try { return runIn(['git', 'rev-parse', '--verify', 'origin/main^{commit}'], wt).trim(); } catch { return null; } };
  // gh 給了 baseRefOid：本機有那顆 commit 才用；沒有＝查不到。**不拿 origin/main 替代**——ref 指得到的 commit
  // 本機必然有，所以「baseRefOid 本機沒有、origin/main 卻是同一顆」不存在；前綴比對（r2 版）更會把
  // 「完整 sha 多一個字元」這種壞值當成同一顆（#566 r3 Codex 實作出來）。
  if (mainSha) return has(mainSha) ? mainSha : null;
  return originMain();
}

/**
 * npm 的 os／cpu 清單語意：沒寫或空＝都算；有寫＝正向項目要包含本機值、`!x` 排除。不是字串的項目略過。
 * @param {unknown} list @param {string} value
 */
function platformWanted(list, value) {
  if (!Array.isArray(list)) return true;
  const strs = list.filter((x) => typeof x === 'string');
  if (!strs.length) return true;
  const neg = strs.filter((x) => x.startsWith('!')).map((x) => x.slice(1));
  const pos = strs.filter((x) => !x.startsWith('!'));
  if (neg.includes(value)) return false;
  return pos.length === 0 || pos.includes(value);
}

/** 從某棵樹讀 `<key>/package.json` 的 name 與 version（key 形如 `node_modules/a/node_modules/b`）。 @param {string} root */
function installedIn(root) {
  const fence = resolve(root) + sep;
  return (/** @type {string} */ key) => {
    try {
      // 第二層圍籬（第一層是 lockMismatches 的 key 格式驗）：解析後的路徑一定要還在樹內，逸出＝當沒裝
      const file = resolve(root, key, 'package.json');
      if (!file.startsWith(fence)) return null;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      return { name: String(pkg?.name ?? ''), version: String(pkg?.version ?? '') };
    } catch { return null; }
  };
}

/**
 * 在拋棄式的工作區裡把 `base` 與 `other` 合起來，跑三關。
 *
 * ⚠️ **`node_modules` 用 symlink 指回發起樹，而且只用 `unlink` 拆掉**（不是 `rm -rf`）：
 * 新建的 worktree 沒有 `node_modules`，三關會全部 127 錯誤退出（2026-08-03 踩過，
 * 而且我當時把「指令沒找到」看成「三關通過」）。
 * 另一半的前提「**發起樹自己有 node_modules**」由 `main()` 在進迴圈前把關——
 * 從沒有 node_modules 的樹發起時這條連結是懸空的，三關照樣全 127，
 * 2026-08-11 #441 就這樣被誤報成「合起來會壞」（退出碼 1）；那要以 2 退出，不進到這裡。
 * 但 CLAUDE.md 有一條鐵則：**不要在 worktree 裡刪除 `node_modules`**——那個 symlink
 * 指回主目錄，動到它會讓 William 的 app 起不來。所以拆的時候用 `unlinkSync`：
 * 它只刪得掉連結本身，如果哪天那裡變成真的目錄，它會直接失敗而不是遞迴刪除。
 * @param {string} repoRoot @param {string} baseSha @param {string} otherSha @param {number} otherNumber
 * @param {string} [mainSha] base 分支（main）目前的 head——量「哪一側動了 lock」用（各支自己相對 main 的改動）
 * @returns {MergeTry}
 */
function tryMerge(repoRoot, baseSha, otherSha, otherNumber, mainSha) {
  const wt = mkdtempSync(join(tmpdir(), `cross-pr-${otherNumber}-`));
  try {
    runIn(['git', 'worktree', 'add', '--detach', '-q', wt, baseSha], repoRoot);
    const nm = join(wt, 'node_modules');
    if (!existsSync(nm)) symlinkSync(join(repoRoot, 'node_modules'), nm);
    try {
      runIn(['git', 'merge', '--no-edit', '-q', otherSha], wt);
    } catch (e) {
      // ⚠️ merge 失敗 ≠ 文字衝突：沒有 committer 身分、hook 拒絕、git 本身的錯也會失敗（#566 r1 Codex 在
      //    乾淨 Linux runner 實跑到）。判準看**有沒有未合併的檔案**（git ls-files -u），不看退出碼；
      //    沒有＝拿不到可信的合併結果，走 cantRun 整輪退 2，不冒充「合起來會壞」（那種可以重跑一次）。
      //    ⚠️ 「沒有未合併檔案」只證明 index 裡沒有建立衝突，證明不了兩支不撞（merge 中途被訊號終止就是
      //    這樣——#566 r2 Codex 用會等待的 merge driver 實作出來），所以措辭一律寫「沒有取得可判讀的衝突結果」。
      let unmerged = '';
      try { unmerged = runIn(['git', 'ls-files', '-u'], wt).trim(); } catch { unmerged = ''; }
      if (unmerged) {
        const files = [...new Set(unmerged.split('\n').map((l) => l.split('\t').pop()))].slice(0, 5).join('、');
        return { number: otherNumber, ok: false, kind: 'conflict', why: `文字衝突，git merge 就過不去（${files}）` };
      }
      return {
        number: otherNumber, ok: false, kind: 'cantRun',
        why: `「試合併」執行不起來（git merge 失敗、也沒有留下未合併的檔案——沒有取得可判讀的衝突結果，不確定是不是兩支撞行）：${redDetail(/** @type {any} */ (e))}`,
      };
    }
    // ⚠️ 三關之前先核對 lock（劃界與理由在檔頭「它不會安裝套件」那段）：對不上就不進三關——
    //    進了也是拿舊套件跑，紅綠都不可信（考題用記號檔釘住「真的沒進」）。
    //    哪一側動了 lock 一併印出來，量的是**各支自己相對 main 的改動**（merge-base(main, head)→head，
    //    跟 GitHub 顯示的 PR diff 同一個口徑）：兩顆 head 直接比、或只從兩支的共同祖先量，都會把
    //    main 在分岔之間的變動算到某一支頭上（預審與 #566 r1 各實跑到一種）。main 的 head 由 gh 的
    //    baseRefOid 給：本機有那顆 commit 才用、沒有就印「查不到」；gh 沒給 OID 才退回 origin/main。
    //    兩側都「否」＝發起樹的套件本來就沒跟上 lock（主目錄還沒重裝）；處置寫在 verdict 的訊息裡。
    const lockPath = join(wt, 'package-lock.json');
    let lock = null;
    try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { lock = null; }
    let pkgJson = null;
    try { pkgJson = JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8')); } catch { pkgJson = null; }
    const mism = lockMismatches(lock, installedIn(wt), hiddenLockIn(wt), { pkgJson });
    if (mism.length) {
      let selfTouched = '查不到'; let otherTouched = '查不到'; let sameAsMain = '查不到';
      const own = (/** @type {string} */ mainRef, /** @type {string} */ head) => {
        const mb = runIn(['git', 'merge-base', mainRef, head], wt).trim();
        return runIn(['git', 'diff', '--name-only', mb, head, '--', 'package-lock.json'], wt).trim() ? '是' : '否';
      };
      // main 的 head：gh 給的 baseRefOid 本機有那顆 commit 才用，沒有＝「查不到」（不拿可能過時的 origin/main
      //   替代——#566 r2 Codex：那樣側別會答錯、處置指錯）；gh 沒給 OID 才退回 origin/main（可能過時，訊息裡的
      //   側別因此只當線索）。「查不到」的處置在訊息裡。
      const mainRef = resolveMainRef(wt, mainSha);
      if (mainRef) {
        try { selfTouched = own(mainRef, baseSha); otherTouched = own(mainRef, otherSha); } catch { selfTouched = '查不到'; otherTouched = '查不到'; }
        // 兩側都「否」有兩種相反的歷史（Grok #566 掃 #3）：發起樹沒跟上 lock、或兩支都落後 main（合併後的 lock 是舊的、
        // 發起樹是新的）——處置相反，所以再印「合併後的 lock 跟 main 的一不一樣」讓人分得出來。
        try { runIn(['git', 'diff', '--quiet', mainRef, 'HEAD', '--', 'package-lock.json'], wt); sameAsMain = '是'; } catch { sameAsMain = '否'; }
      }
      return {
        number: otherNumber, ok: false, kind: 'lock',
        why: `合併後的 package-lock.json 跟已裝的套件對不上（${mism.length} 處；各支相對 main 的改動：本支那側動了 package-lock.json：${selfTouched}，#${otherNumber} 那側動了：${otherTouched}；合併後的 lock 跟 main 的一樣：${sameAsMain}）：`
          + mism.slice(0, 5).join('；') + (mism.length > 5 ? '；…' : ''),
      };
    }
    for (const [label, script] of [['校對', 'typecheck'], ['糾察', 'lint'], ['考試', 'test']]) {
      try {
        runIn(['npm', 'run', script === 'test' ? 'test' : script], wt);
      } catch (e) {
        const err = /** @type {any} */ (e);
        // ⚠️ 「執行不起來」≠「跑完是紅的」——分界與「為什麼不判定成因」寫在
        //    cantRunSignal 檔頭（#441 誤報＋#446 r1／r2 Codex 的兩輪反例都在那裡）。
        const sig = cantRunSignal(err);
        if (sig !== null) {
          return {
            number: otherNumber, ok: false, kind: 'cantRun',
            why: `「${label}」執行不起來（症狀：${sig}）：${redDetail(err)}`,
          };
        }
        const names = script === 'test' ? failingTestNames(err?.stdout) : [];
        return {
          number: otherNumber, ok: false, kind: 'red',
          why: `合起來之後「${label}」紅了${names.length ? `（紅的考題：${names.join(' ／ ')}）` : ''}：${redDetail(err)}`,
        };
      }
    }
    return { number: otherNumber, ok: true, why: '' };
  } finally {
    // ⚠️ 先拆 symlink 再移除 worktree——`unlink` 只動得了連結，動不到主目錄的 node_modules
    const nm = join(wt, 'node_modules');
    try { unlinkSync(nm); } catch { /* 不在或不是連結都不要緊 */ }
    try { runIn(['git', 'worktree', 'remove', '--force', wt], repoRoot); }
    catch { try { rmSync(wt, { recursive: true, force: true }); } catch { /* 盡力清乾淨 */ } }
  }
}

/** 發起樹的 node_modules 要「是目錄」才算可用（statSync 跟隨 symlink；不存在／懸空＝throw）。 @param {string} p */
function isUsableNodeModulesDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** @param {string[]} argv */
export function main(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('用法：node scripts/check-cross-pr-merge.js <PR 編號>');
    return 2;
  }
  let repoRoot; let self; let list;
  try {
    // ⚠️ 這一句決定後面所有 worktree 操作**動到哪一個 repo**。繼承來的 `GIT_DIR` 會讓它回答
    //    別的 repo（git 有 GIT_DIR 時不看 cwd）⇒ 這道閘會跑去別棵樹上建立與移除工作樹。
    repoRoot = runIn(['git', 'rev-parse', '--show-toplevel'], process.cwd()).trim();
    self = JSON.parse(gh(['pr', 'view', pr, '--json', 'number,headRefOid,baseRefName,baseRefOid']));
    list = JSON.parse(gh(['pr', 'list', '--state', 'open', '--base', 'main',
      '--json', 'number,headRefOid,headRefName,baseRefName,isDraft', '--limit', '100']));
  } catch (e) {
    console.error(`跨 PR 試合併 PR #${pr}：查不清楚（${/** @type {any} */ (e)?.message}）——一律當成未通過。`);
    return 2;   // fail-closed
  }
  // ⚠️ 清單每一筆的承重欄位都要在（number 正整數、headRefOid 非空字串、baseRefName 字串）：缺了 baseRefName
  //    的那一筆會被 othersToTry 的 `=== 'main'` 靜靜濾掉，整輪變成「沒有其他 open PR」退 0（#566 r9 Codex 實跑）。
  //    指令本身已用 --base main 查，缺欄位不能當成「證明它不是 main」——形狀不對一律 2。
  const listBad = Array.isArray(list) ? list.filter((p) => !p || typeof p !== 'object'
    || !(typeof p.number === 'number' && Number.isInteger(p.number) && p.number > 0)
    || typeof p.headRefOid !== 'string' || !p.headRefOid || typeof p.baseRefName !== 'string') : [];
  if (!self?.headRefOid || !Array.isArray(list) || listBad.length) {
    console.error(`跨 PR 試合併 PR #${pr}：gh 回傳的形狀不對${listBad.length ? `（open PR 清單有 ${listBad.length} 筆缺承重欄位：number／headRefOid／baseRefName）` : ''}——一律當成未通過。`);
    return 2;
  }
  const others = othersToTry(list, Number(pr));
  // ⚠️ 試合併前先驗發起樹的 node_modules（2026-08-11 #441 實踩）：臨時工作區的
  //    node_modules 是 symlink 指回發起樹（見 tryMerge 檔頭），發起樹自己沒有
  //    （例如 /private/tmp 的代合併樹）＝懸空連結，三關全部「指令找不到」，
  //    被誤報成「#442 合起來之後『校對』紅了」退出碼 1——但那支只動了兩個 .md。
  //    環境問題的誠實語意是「查不清楚」（2），不是「兩支相斥」（1）。
  //    零支其他 PR 時刻意不驗：那個結論不需要跑三關，#438 的代合併正是這樣安全通過的
  //    ——把它也擋下來＝誤傷本來就正確的用法。
  //    先驗用 statSync 驗到「是目錄」為止——existsSync 只驗「存在」，node_modules 是
  //    普通檔案（或 symlink 指到檔案）時照樣 true（#446 r1 Codex 抓的洞）。
  //    「存在但殘缺」先驗驗不了，由三關的「執行不起來」分類接手（見 tryMerge 的 catch）。
  const nmSrc = join(repoRoot, 'node_modules');
  if (others.length && !isUsableNodeModulesDir(nmSrc)) {
    console.error(
      `跨 PR 試合併 PR #${pr}：查不清楚——發起樹沒有可用的 node_modules（${nmSrc} 不存在、不是目錄、或是懸空連結）。\n`
      + '  請從主目錄跑這道閘，或先把 node_modules symlink 掛進發起樹再跑一次。');
    return 2;
  }
  const results = [];
  for (const o of others) {
    try {
      results.push(tryMerge(repoRoot, self.headRefOid, o.headRefOid, o.number, typeof self.baseRefOid === 'string' ? self.baseRefOid : undefined));
    } catch (e) {
      console.error(`跨 PR 試合併 PR #${pr}：建不出臨時工作區（${/** @type {any} */ (e)?.message}）。`);
      return 2;
    }
  }
  const v = verdict(results);
  (v.code === 0 ? console.log : console.error)(v.message);
  return v.code;
}

// 只有直接執行才跑（考題 import 純函式；端到端考題用假 gh 跑整支）。
// 判斷一律走 `lib/is-main.js`——symlink 與百分號編碼兩個坑寫在那裡，
// 這裡不重述（重述的說明會漂）。它答錯的後果：`main()` 從來沒跑而退出碼是 0，
// **一道閘「什麼都沒做卻回報通過」比它不存在更危險**。考題 `test/entry-guard.test.js` 盯著。
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
