#!/usr/bin/env node
// 三關執行器（規矩 E2、E3）：照專案設定登記的順序跑三關，任一非零就停。推送前鉤子與雲端範本都呼叫它。
//
// 為什麼要有一支：鉤子（sh）與雲端（yml）各自寫一遍三關，兩份就會漂。三關命令的正本只有一份（settings.json
// 的 checks.commands），這支讀它、兩邊都呼叫這支。
//
// 兩件事夾在三關前後（原專案的裸倉庫事故）：跑之前與跑完之後各驗一次「這棵樹還是不是工作樹、根目錄是不是這裡、索引在不在」，
// 外加「倉庫設定前後內容有沒有不同」（比對設定檔的位元組）——考題各跑各的子行程、順序不保證，某一題把倉庫寫壞
// 這件事只有跑完再驗一次才抓得到；而寫壞共用設定時從這棵樹看生效值可能照樣健康，所以直接比「前後內容有沒有不同」。
// 專案另外登記了才驗的兩項（checks 底下兩個選填鍵；一樣前後各驗一次）：
//   checks.mainWorktree＝「一般工作樹」：從連結工作樹跑時，主目錄有沒有被 Git 判成裸倉庫、打不打得開（mainProblem）。
//   checks.indexAnchors＝一串檔案路徑：每一個都要在這棵樹的索引裡（anchorProblem）。
//   沒寫或寫「未設定」＝不驗（跟沒有這兩鍵時一樣放行），全綠那一行會寫出哪幾項沒驗；寫了別的值＝退 2、一關都不跑。
//   登記了、但這台這次驗不到（錨點：HEAD 解析不到；主目錄：共用目錄不叫 .git）＝放行，全綠那一行另外寫出「登記了、這次沒驗」。
//   例外：登記了錨點、跑之前 HEAD 解析得到、跑完解析不到＝擋（有一題把這棵樹切到還沒有提交的分支，錨點就被跳過了）。
//   反過來（跑之前解析不到、跑完解析得到）：三關後那一次照驗，不對＝退 1，訊息用三關前那一套判斷（跑之前沒驗過，不能說「跑之前都在」）。
//   為什麼要登記、不自己猜：「主目錄本來就是裸儲存庫」「有意暫存刪除全部檔案」跟壞掉的樣子，從 Git 看起來一模一樣；
//   意圖只能由專案說（搬家前準備 r2 B1、B2 的審查者自己給的路）。
// 既有狀態擋下時也說壞在哪：這棵樹自己被判成裸倉庫＝列 core.bare 出處；true 那一筆在「名叫 .git 的共用目錄底下的 config」或
//   「這棵樹自己的 config.worktree（連結樹的，或共用目錄名叫 .git 時）」才給一行還原，其餘說為什麼不給（共用目錄不叫 .git＝可能本來就是裸儲存庫；見 treeBare）；
//   git 打不開（not-a-repo）或索引讀不了＝印 Git 自己的錯誤訊息原文，不給還原（要定位是哪一個檔就得自己解讀
//   Git 的設定規則與倉庫布局——.git 指標檔、commondir、哪一層設定生效——那是重做 Git，搬家前準備 r2〜r3 的教訓）。
// 所有外部指令的環境先清掉 GIT_ 那一族（規矩 E4）。
// git 呼叫一律輸出有界（rev-parse、cat-file -t、symbolic-ref、core.bare 與 core.sparseCheckout 那一格；ls-files 只看退出碼、
//   不收輸出，要知道索引是不是整份空的那一次輸出上限設很小），不然就明設 maxBuffer：
//   spawnSync 預設只收 1 MiB，超過就回錯誤，會把健康的大倉庫判成壞（原本收 ls-files 全部輸出：輸出超過 1 MiB——
//   檔名平均 50 位元組時約兩萬個追蹤檔——就被判成索引讀不了）。
// Git 印的路徑只去掉最後那個換行、不整串 trim：資料夾名字結尾可以是空白。
//
// 退出碼：0＝全綠／1＝有一關紅（或跑完樹壞了、設定變了）／2＝三關沒登記、設定形狀錯、不在工作樹裡、
//   登記了的主目錄布局或索引錨點在三關前就不對、指令起不來。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { read: readSettings } = require('./settings-data.js');
const { gitEnv } = require('./git-env.js');

const UNSET = '未設定';
const MAIN_NORMAL = '一般工作樹';
/**
 * 錨點不准有的字：控制字元（U+0000〜U+001F、U+007F）與分行符號（U+0085、U+2028、U+2029）——有了它訊息會換行、照貼會斷掉。
 * 涵蓋 build-settings 的 plain() 擋的每一個字（它只擋換行類與空字元），其餘控制字元也一起擋。不寫成正規式：風格檢查不准正規式裡有控制字元。
 */
const hasControl = (s) => Array.from(s).some((c) => {
  const n = c.codePointAt(0);
  return n < 0x20 || n === 0x7f || n === 0x85 || n === 0x2028 || n === 0x2029;
});
/** 錨點那一次 ls-files 的輸出上限：錨點若寫成目錄，會列出整個目錄（填目錄的訊息見 anchorRestoreLines）。 */
const ANCHOR_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * 問「索引是不是整份空的」那一次的輸出上限：只要知道有沒有一筆，超過上限＝有東西。
 * 刻意設得很小（不是隨手寫的數字）：這一問只需要分辨「空的」跟「不是空的」，早一點被截斷就少讀一點進記憶體。
 * 量到的（macOS、Node v26.0.0）：子行程印的東西超過 maxBuffer 時，spawnSync 用 SIGTERM 把它殺掉，
 * 回的 error.code 是 ENOBUFS、status 是 null、signal 是 'SIGTERM'；它仍然等那支子行程收場，
 * 只是不等子行程把原定的事做完。這裡的判斷寫成「有 error 就不算空的」，所以不必分辨是哪一種錯。
 * 「很小」由 tests/run-checks.test.js ⑭ 釘住（那一題錄下這一次呼叫實際用的上限與回傳）。
 * ⚠️ 釘的粒度：那一題的樣本印 1536 位元組，所以**這個上限改成 1536 以上才會紅**，1025〜1535 之間照樣綠（量過）。
 * 它證的是「這個上限比 1536 小」，不是精確釘死 1024。
 */
const EMPTY_PROBE_BUFFER = 1024;
/** Git 的錯誤訊息最多印幾行（例如索引壞了時 Git 可能先印 error 那一行、再印 fatal 那一行；整份只剩幾個位元組的亂碼時只印一行 fatal）。 */
const GIT_SAYS_MAX = 3;
const MAIN_SKIP = '主目錄是不是一般工作樹（checks.mainWorktree；共用目錄不叫 .git，主目錄在哪 Git 說不出來）';
const ANCHOR_SKIP = '索引錨點（checks.indexAnchors；HEAD 解析不到：剛 init、或目前在還沒有提交的分支上）';

const shq = (s) => `'${String(s).replace(/'/gu, `'\\''`)}'`;
/** Git 印的一個路徑：只去掉最後那個換行（整串 trim 會把資料夾名字結尾的空白一起切掉）。 */
const pathOut = (r) => String((r && r.stdout) || '').replace(/\n$/u, '');
const short = (sha) => String(sha).slice(0, 12);
const isDir = (p) => { try { return p !== '' && fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
/**
 * 站在主目錄問 Git 的環境：清 GIT_ 之後，再請 Git 不要往主目錄的上層找倉庫。這只是第一道（見 mainProblem）：
 * GIT_CEILING_DIRECTORIES 是冒號分隔的清單、而且 Git 比對上層路徑時分大小寫（git 2.39.5 量過）——主目錄的上層路徑含冒號、
 * 或上層只改了大小寫（大小寫不分的檔案系統上，這棵樹記的還是舊的大小寫）時，它就不代表那個目錄、擋不住；判準是身分比對。
 */
const mainEnv = (main) => ({ ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(main) });
/**
 * 兩個路徑是不是同一個目錄：裝置與 inode 都相同才算（stat 會先解開符號連結）。不比路徑字串：大小寫不分的檔案系統上，
 * 主目錄只改了大小寫時兩個字串不同、其實是同一個目錄，比字串會誤擋。
 * 回 true／false；有一邊 stat 失敗回 null＝問不到（呼叫端當成不是同一個、照實說問不到）。
 */
const samePath = (a, b) => {
  let x;
  let y;
  try { x = fs.statSync(a, { bigint: true }); y = fs.statSync(b, { bigint: true }); } catch { return null; }
  return x.dev === y.dev && x.ino === y.ino;
};
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '沒有訊息';
/**
 * 一次 git 呼叫失敗時 Git 自己說了什麼：{ lines（標準錯誤輸出的非空行，照原文、只去掉行尾空白）, status, signal }；
 * Node 那一層就出錯、沒拿到 Git 的回答（例如這個目錄不存在或被刪掉、git 不在 PATH 上、輸出超過上限）＝{ spawn: Node 的錯誤代碼 }——
 *   不猜是哪一種、也不冒稱是 Git 說的。寫成訊息見 gitSaysLines。
 */
const gitSays = (r) => (r.error
  ? { spawn: r.error.code || r.error.message }
  : { lines: String(r.stderr || '').split('\n').map((l) => l.replace(/\s+$/u, '')).filter(Boolean), status: r.status, signal: r.signal });
/** 設定值寫進訊息：JSON 字面，再把 JSON 不跳脫的 DEL 與分行符號也寫成 \\uXXXX（訊息要維持一行）。 */
const show = (v) => String(JSON.stringify(v)).replace(/[\u007f\u0085\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function runCommand(argv, cwd) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
  return { status: r.error ? null : r.status, error: r.error ? r.error.message : '' };
}

/** 錨點的形狀（封閉的一行）：從根目錄算起的最簡相對檔案路徑。驗的是我們自己的設定，不是 Git 的。 */
function anchorShapeOk(a) {
  return typeof a === 'string' && a !== '' && a !== UNSET && a !== '.' && a !== '..'
    && !a.startsWith('/') && !a.startsWith('../') && !a.endsWith('/')
    && path.posix.normalize(a) === a && !hasControl(a);
}

/**
 * 讀 checks 底下兩個選填登記，回 { mainNormal, anchors }（anchors＝null＝沒登記）或 { error }。
 * 沒寫、或寫「未設定」＝沒登記（寬：跟跨變更試合併閘對 prepareWorktree 的先例一樣）。
 * 其他值逐筆驗、不濾掉（跟 commands 同一條理由）：寫錯就不放行，不把寫錯當成沒登記。
 */
function treeOptions(checks) {
  const c = checks || {};
  const m = c.mainWorktree;
  if (m !== undefined && m !== UNSET && m !== MAIN_NORMAL) {
    return { error: `專案設定 checks.mainWorktree 只收「${MAIN_NORMAL}」或「${UNSET}」，現在是 ${show(m)}：不放行。` };
  }
  const a = c.indexAnchors;
  let anchors = null;
  if (a !== undefined && !(Array.isArray(a) && a.length === 1 && a[0] === UNSET)) {
    if (!Array.isArray(a) || !a.length) return { error: `專案設定 checks.indexAnchors 要是一串檔案路徑（或只寫一筆「${UNSET}」）：不放行。` };
    const bad = a.findIndex((x) => !anchorShapeOk(x));
    if (bad !== -1) {
      return { error: `專案設定 checks.indexAnchors 的第 ${bad + 1} 筆（${show(a[bad])}）不是從根目錄算起的檔案路徑（不能以 / 或 ./ 開頭、不能以 / 結尾、不能有 .. 或多餘的 /、不能有換行等控制字元，「${UNSET}」不能跟路徑混寫）：不放行。` };
    }
    anchors = a;
  }
  return { mainNormal: m === MAIN_NORMAL, anchors };
}

/**
 * 主目錄那一邊（只在登記了「一般工作樹」時問）。回 null＝沒事、{ skipped }＝這台驗不到（射程外），
 * 否則回 { state: 'main-bare'|'main-unreadable', … }。
 * 為什麼要問：原專案 08-09 事故的形狀之一——共用設定被寫進 core.bare=true，這棵連結工作樹自己的設定蓋住了、
 *   從這裡看一切正常，主目錄那邊卻 git status／add／commit 全部 fatal。這棵樹的生效值看不出來，只能去主目錄問 Git。
 * 射程（整句照實）：**共用目錄叫 .git 才問；只問「在主目錄問到的是不是這個倉庫」「主目錄裸不裸」
 *   「Git 給不給得出主目錄的工作樹根、那個根是不是存在的目錄」**（照這個順序）。
 *   不驗：共用目錄不叫 .git 的布局（store.git 這種裸儲存庫、--separate-git-dir、子模組的 .git/modules/<名>）——
 *   主目錄在哪 Git 說不出來；其中 --separate-git-dir 的主目錄被寫壞是真的壞，這裡看不到（全綠那一行會說這次沒驗）。
 *   主目錄的工作樹根被指到「存在的別處」：跟合法地用 core.worktree 搬家分不開。別棵連結樹。
 *   登記是整個專案共用一個值：有一份複本用「proj/.git 是裸儲存庫＋連結樹」的布局，那一份會被擋（看得見，考題釘著）。
 * 布林、include、擴充何時生效、最後一筆，全部交給 Git 開主目錄時自己判（問的子行程站在主目錄、一樣清 GIT_）；
 *   這裡不讀任何設定檔（搬家前準備 r2〜r3 直讀設定連兩輪誤擋的教訓，見 treeState）。
 * 問到的必須是這個倉庫：主目錄自己那份 .git 壞了（例如 HEAD 不見）、上層又剛好是別的倉庫時，Git 會改去開上層那個、回報一切正常。
 *   第一道＝GIT_CEILING_DIRECTORIES（不准往主目錄的上層找；它代表得了上層時，Git 在主目錄直接退非零＝打不開）。
 *   判準＝身分比對：站在主目錄問到的共用目錄，要跟這棵樹的共用目錄是同一個目錄（裝置與 inode 都相同，見 samePath）；
 *   不是＝打不開，訊息說問到的是另一個倉庫；有一邊讀不到＝一樣不放行（記成打不開那一類），訊息照實說問不到是不是這個倉庫。
 *   第一道失效的兩種（上層路徑含冒號、上層只改了大小寫）由身分比對接住（考題跟第一道擋得住的那種成對釘著）。
 *   身分比對是站在主目錄的**第一問**，通過了才問裸不裸、工作樹根：問到的若是別的倉庫（例如上層剛好是裸儲存庫），
 *   後面兩問的答案與還原指令講的都是那個倉庫（會叫人去改上層的設定檔），所以先確認、不先問。
 *   （git 2.39.5 量過：主目錄的 core.worktree 指到「只有最後一層不存在」或一個檔案時，身分那一問成功、回的是主目錄自己那份 .git，
 *   照舊由工作樹根那一問擋；指到「上層也不存在」時身分那一問就退非零，錯誤訊息跟裸不裸那一問會給的相同。）
 */
function mainProblem(git) {
  const d = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (d.error || d.status !== 0) return { state: 'not-a-repo', said: gitSays(d) };
  const common = pathOut(d);
  if (path.basename(common) !== '.git') return { skipped: MAIN_SKIP };   // 主目錄在哪 Git 說不出來的布局：不驗（射程外）
  const main = path.dirname(common);
  const ask = (...a) => spawnSync('git', a, { cwd: main, encoding: 'utf8', env: mainEnv(main) });
  const unreadable = (err) => ({ state: 'main-unreadable', main, common, err });
  const failed = (r) => unreadable(firstLine(r.error ? r.error.message : r.stderr));
  const who = ask('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (who.error || who.status !== 0) return failed(who);
  const seen = pathOut(who);
  const same = samePath(seen, common);
  if (same === null) return { ...unreadable(`在主目錄問到的共用目錄 ${shq(seen)} 或這棵樹的共用目錄讀不到`), unknown: true };
  if (!same) return { ...unreadable(`在主目錄問到的是另一個倉庫（${shq(seen)}）`), other: true };
  const bare = ask('rev-parse', '--is-bare-repository');
  if (bare.error || bare.status !== 0) return failed(bare);
  if (bare.stdout.trim() !== 'false') {
    return { state: 'main-bare', main, common, origins: bareOrigins(main), own: ['config', 'config.worktree'].map((f) => path.join(common, f)) };
  }
  const top = ask('rev-parse', '--show-toplevel');
  const root = pathOut(top);
  // 退非零時輸出是空的、isDir('') 也是 false，所以一句就夠；給得出而且是存在的目錄＝不管它在哪（合法搬家分不開）。
  // 指到一個存在的「檔案」也算打不開（主目錄的 git status 會 fatal）。
  if (!isDir(root)) return !top.error && top.status === 0 ? unreadable(`Git 說它的工作樹根在 ${shq(root)}，那裡不存在或不是目錄`) : failed(top);
  return null;
}

/**
 * 站在 dir（主目錄、或被判成裸倉庫的這棵樹本身——裸的也問得到設定）問 Git「core.bare 每一筆從哪裡來」：
 * 回 [{ origin, value }]（值已由 Git 換成 true／false）；Git 說一筆都沒有（退 1、沒有輸出）回 []；問不到回 null。
 * 出處是相對路徑時（Git 對倉庫自己的設定印 file:.git/config）相對於問的那個目錄，這裡換成絕對路徑，只用在訊息
 * （git 2.39.5 量過：站在主目錄問印相對的，站在連結工作樹問印絕對的；考題在兩邊都照貼跑過還原）。
 */
function bareOrigins(dir) {
  const r = spawnSync('git', ['config', '-z', '--show-origin', '--bool', '--get-all', 'core.bare'], { cwd: dir, encoding: 'utf8', env: gitEnv() });
  if (!r.error && r.status === 1 && r.stdout === '') return [];
  if (r.error || r.status !== 0) return null;
  const parts = r.stdout.split('\0');
  parts.pop();
  if (!parts.length || parts.length % 2) return null;
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const origin = parts[i].startsWith('file:') ? `file:${path.resolve(dir, parts[i].slice(5))}` : parts[i];
    out.push({ origin, value: parts[i + 1] });
  }
  return out;
}

/**
 * 這棵樹自己被 Git 判成裸倉庫（既有的 bare 狀態）：一併問 core.bare 每一筆的出處（站在這棵樹問），訊息照主目錄那一套列出處。
 * 還原指令射程比主目錄那一路窄（內部審查中①、裁示者收窄 b1d）：只有 true 那一筆在「名叫 .git 的共用目錄底下的 config」、
 *   或「這棵樹自己的 config.worktree——連結樹的（位於 <共用目錄>/worktrees/<名>/ 底下），或共用目錄名叫 .git 時」才給（fixable）。
 *   這個倉庫自己的設定檔、但共用目錄不叫 .git 的（gated：共用設定檔；站在裸儲存庫裡面時它自己的 config.worktree）只列出處：
 *   它可能本來就是裸儲存庫（store.git＋連結工作樹、站在裸儲存庫裡面跑、裸儲存庫把 core.bare 放在自己的 config.worktree）——
 *   從 Git 看跟壞掉的一模一樣，照貼會把合法的裸儲存庫改成非裸；跟主目錄那一路「共用目錄叫 .git 才問」同一個射程。
 *   「連結樹」只拿 Git 說的兩個路徑比（這棵樹的 config.worktree 往上兩層、跟 <共用目錄>/worktrees 是不是同一個目錄），不讀布局檔。
 *   ⚠️ 守不到（刻意維持）：名叫 .git 的裸儲存庫（proj/.git 那種）從 Git 看跟事故形狀一模一樣，照樣給還原（照做會把它改成非裸；
 *   提醒放在指令之前）。
 * 不新增判準：擋不擋照舊只看 rev-parse --is-bare-repository。
 */
function treeBare(git, cwd) {
  const fixable = [];
  const gated = [];
  let commonDir = null;
  let commonIsDotGit = false;
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common.error && common.status === 0) {
    commonDir = pathOut(common);
    commonIsDotGit = path.basename(commonDir) === '.git';
    (commonIsDotGit ? fixable : gated).push(path.join(commonDir, 'config'));
  }
  const perTree = git('rev-parse', '--path-format=absolute', '--git-path', 'config.worktree');
  if (!perTree.error && perTree.status === 0) {
    const own = pathOut(perTree);
    const linked = commonDir !== null && samePath(path.dirname(path.dirname(own)), path.join(commonDir, 'worktrees')) === true;
    (commonIsDotGit || linked ? fixable : gated).push(own);
  }
  return { state: 'bare', origins: bareOrigins(cwd), fixable, gated, commonDir: commonIsDotGit ? commonDir : null };
}

/**
 * 索引錨點（只在登記了錨點、而且 HEAD 解析得到時問；剛 init、或目前在還沒有提交的分支上都不問）。
 * 回 null＝都在，否則 { state: 'anchor-missing', … }。
 * 為什麼要問：索引被清空（read-tree --empty、rm -r --cached .）、少了一筆、或某一筆的路徑位元組被改掉時，
 *   索引檔還在、git ls-files 也不報錯——靠它掃全樹的考題會少掃（清空時掃到零個檔）然後回報沒有違規。
 * 判定只有一句：ls-files -z 的輸出裡有沒有**逐位元組相同**的那一筆。錨點當 pathspec 只用來縮小輸出；
 *   --literal-pathspecs 讓 : 開頭的名字不被當成特殊語法，`--` 讓 - 開頭的名字不被當成選項，-z 讓非 ASCII 與含引號的名字
 *   照原樣印（不加引號、不跳脫）。
 * 刻意不做：比對三關前後的索引（會誤擋同一棵樹上別的工作階段 git add）；驗索引檔尾巴的檢查碼或 fsck
 *   （普通的 git status 會把壞掉的檢查碼重算、把損毀封進去）。
 * 還原要看最新提交裡它是什麼：是檔案（blob）＝整份換回最新提交；是目錄（tree）或沒有＝重建索引也不會好，不給指令
 *   （三關前、或跑之前 HEAD 解析不到而三關後才驗到＝錨點填錯了或登記跟專案對不上；
 *   三關後、跑之前驗過都在＝它是只暫存、還沒提交的檔，見 anchorRestoreLines）。
 */
function anchorProblem(git, anchors, cwd, tree) {
  const r = spawnSync('git', ['--literal-pathspecs', 'ls-files', '-z', '--', ...anchors], { cwd, encoding: 'utf8', env: gitEnv(), maxBuffer: ANCHOR_MAX_BUFFER });
  if (r.error || r.status !== 0) return { state: 'index-unusable', said: gitSays(r) };
  const listed = new Set(r.stdout.split('\0'));
  const missing = anchors.filter((a) => !listed.has(a));
  if (!missing.length) return null;
  // 登記的全部不見時，訊息要分「索引整份是空的」還是只是沒有這幾筆：只要知道有沒有一筆，所以輸出上限設很小
  // （EMPTY_PROBE_BUFFER；超過上限＝Node 把那支 git 殺掉、回 ENOBUFS）。判斷是「沒有 error、退 0、而且輸出是空的」
  // 才說整份是空的——超過上限與其他任何問不到的情形都不說
  let indexEmpty = false;
  if (missing.length === anchors.length) {
    const e = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: EMPTY_PROBE_BUFFER });
    indexEmpty = !e.error && e.status === 0 && e.stdout === '';
  }
  const typeOf = (a) => { const t = git('cat-file', '-t', `HEAD:${a}`); return t.status === 0 ? t.stdout.trim() : ''; };
  const types = new Map(missing.map((a) => [a, typeOf(a)]));
  const inHead = missing.filter((a) => types.get(a) === 'blob');
  const dirs = missing.filter((a) => types.get(a) === 'tree');
  // 稀疏 checkout 的樹：read-tree HEAD 會清掉稀疏範圍外那些檔的標記，要再 reapply（訊息多給一行）
  const sparse = inHead.length > 0 && git('config', '--bool', '--get', 'core.sparseCheckout').stdout.trim() === 'true';
  return { state: 'anchor-missing', tree, anchors, missing, inHead, dirs, indexEmpty, sparse };
}

/**
 * 這棵樹還是工作樹嗎？回 { state, …細節 }；state＝'ok'／'bare'／'not-a-repo'／'wrong-tree'／'index-unusable'，
 * 登記了才會出現的 'main-bare'／'main-unreadable'（mainProblem）、'anchor-missing'（anchorProblem）。
 * 'ok' 另外帶 head（HEAD 的提交；解析不到＝null）、branch（登記了錨點、而且在分支上時的完整 ref 名）、tree（根目錄）、
 *   skipped（登記了、這次驗不到的項目）：runChecks 拿三關前後兩次比 HEAD（見 headGone）。
 * 'bare' 另外帶 core.bare 的出處（treeBare）；'not-a-repo'、'index-unusable' 在 git 失敗時另外帶 said（Git 自己說了什麼，見 gitSays）。
 * 只回第一個問題（這棵樹 → 主目錄 → 錨點）：先修完再跑一次才看得到下一個。
 * wrong-tree＝版本控制認的工作樹根目錄不是這裡：樹被指到別處（例如設定裡的 core.worktree），或不在專案根目錄跑。
 * 搬家驗屋 09-13：原本只查裸倉庫；樹被指到別處時照樣回報三關全綠，而依賴版本控制的考題量的是另一棵樹。
 * index-unusable＝HEAD 解析得到（不是剛 init、也不在還沒有提交的分支上），這棵樹自己的**索引檔卻不存在**，或 git 讀不了索引：
 *   索引不見時 git ls-files 不報錯、只回空清單，靠它掃全樹的考題會掃到零個檔然後回報零違規。
 *   **索引存在但是空的**（例如暫存刪除了全部檔案）是合法狀態
 *   （搬家前準備 r2 B2）——專案要擋「索引被清空」就登記錨點（checks.indexAnchors）。
 * ⚠️ 這裡只問 Git 怎麼判（生效值；登記了才加問主目錄），不自己解讀設定檔：搬家前準備 r2〜r3 試過直讀共用設定判「別棵樹會不會壞」，
 *   連兩輪都在重做 Git 讀設定的規則（擴充何時生效、include、最後一筆、條件式 include）而且每輪都誤擋正常形狀。
 *   「三關跑的時候有沒有把共用設定寫壞」改由 configFingerprint 前後比對直接量（見 runChecks）。
 */
function treeState(run, cwd, { mainNormal = false, anchors = null } = {}) {
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  const bare = git('rev-parse', '--is-bare-repository');
  if (bare.error || bare.status !== 0) return { state: 'not-a-repo', said: gitSays(bare) };
  if (bare.stdout.trim() !== 'false') return treeBare(git, cwd);
  const top = git('rev-parse', '--show-toplevel');
  if (top.error || top.status !== 0) return { state: 'not-a-repo', said: gitSays(top) };
  // 兩邊都解開符號連結再比（暫存目錄常經過一層連結）；根目錄不存在＝被指到不存在的地方
  let here;
  let root;
  try { here = fs.realpathSync(cwd); } catch { return { state: 'not-a-repo' }; }
  try { root = fs.realpathSync(pathOut(top)); } catch { return { state: 'wrong-tree' }; }
  if (root !== here) return { state: 'wrong-tree' };
  // HEAD 解析得到才要求這棵樹自己的索引檔存在、而且 git 讀得了（剛 init、還沒提交的倉庫本來就沒有索引；空索引是合法的）。
  // 有提交、但目前在還沒有提交的分支上時 HEAD 也解析不到：索引檔這一項與錨點都不驗（錨點會寫進「登記了、這次沒驗」）
  const headRev = git('rev-parse', '--verify', '-q', 'HEAD');
  const head = headRev.status === 0 ? headRev.stdout.trim() : null;
  if (head) {
    const indexPath = git('rev-parse', '--path-format=absolute', '--git-path', 'index');
    if (indexPath.status !== 0) return { state: 'index-unusable', said: gitSays(indexPath) };
    if (!fs.existsSync(indexPath.stdout.trim())) return { state: 'index-unusable' };
    // 只看退出碼、不收輸出：追蹤檔多的倉庫輸出好幾 MiB，收了會超過 spawnSync 預設的 1 MiB、把健康的大倉庫判成讀不了
    const ls = spawnSync('git', ['ls-files'], { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    if (ls.error || ls.status !== 0) return { state: 'index-unusable', said: gitSays(ls) };
  }
  const skipped = [];
  if (mainNormal) {
    const p = mainProblem(git);
    if (p && p.skipped) skipped.push(p.skipped);
    else if (p) return p;
  }
  let branch = null;
  if (anchors && !head) skipped.push(ANCHOR_SKIP);
  else if (anchors) {
    const p = anchorProblem(git, anchors, cwd, here);
    if (p) return p.state === 'anchor-missing' ? { ...p, head } : p;
    const sym = git('symbolic-ref', '-q', 'HEAD');
    if (sym.status === 0 && sym.stdout.startsWith('refs/heads/')) branch = sym.stdout.trim();
  }
  return { state: 'ok', head, branch, tree: here, skipped };
}

/**
 * 登記了錨點、跑之前 HEAD 解析得到、跑完解析不到（例如有一題 git switch --orphan）：錨點那一項被跳過了，當成壞了擋。
 * 還原：原本的分支還指在跑之前那一顆＝切回那個分支；不然（分離的 HEAD、分支被移動或刪掉）＝切回那一顆提交。
 *   git switch 遇到會被蓋掉的工作區改動會拒絕、什麼都不動，所以給它、不給會蓋檔的指令。
 */
function headGone(cwd, before) {
  let branch = null;
  if (before.branch) {
    const r = spawnSync('git', ['rev-parse', '--verify', '-q', `${before.branch}^{commit}`], { cwd, encoding: 'utf8', env: gitEnv() });
    if (r.status === 0 && r.stdout.trim() === before.head) branch = before.branch.slice('refs/heads/'.length);
  }
  return { state: 'head-gone', tree: before.tree, head: before.head, was: before.branch ? before.branch.slice('refs/heads/'.length) : null, branch };
}

/**
 * 倉庫設定的指紋：**共用設定檔**與**這棵樹自己的 config.worktree** 的原始位元組（不存在記成 null）。
 * 三關前後各取一次、內容不一樣＝擋（原專案 08-09 事故：考題帶著推送前鉤子的 GIT_DIR
 * 跑 git init，把 bare = true 寫進共用設定——那一刻從這棵樹看生效值可能照樣健康，別的樹卻全部打不開）。
 * 只比前後內容，不判讀內容合不合 Git 的規則（那是 Git 的事，重做它追不上；搬家前準備 r3）。
 * ⚠️ 守不到的：三關開始之前就已經壞掉的共用設定（這棵樹生效值健康時看不出來；登記了 checks.mainWorktree 才會去問主目錄）；
 *   include 引進的其他檔被改；中途改了又完整還原（前後內容一樣）；只改檔案中繼資料；物件、refs、鉤子等設定以外的損壞（這不是 fsck）；
 *   同一段時間有別的工作階段改了倉庫設定（會紅，訊息照實說去查是誰改的）。
 *   ⚠️ 會改 Git 設定的**合法**準備步（例如安裝鉤子的工具會設 core.hooksPath、初次 submodule／稀疏設定）放進三關裡跑，第一次會紅：
 *   那類準備要在三關之外先做完（搬家前準備 r4 T2）。
 */
function configFingerprint(cwd) {
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const perTree = git('rev-parse', '--path-format=absolute', '--git-path', 'config.worktree');
  if (common.status !== 0 || perTree.status !== 0) return null;
  const read = (file) => { try { return fs.readFileSync(file).toString('base64'); } catch { return null; } };
  return JSON.stringify({ shared: read(path.join(common.stdout.trim(), 'config')), worktree: read(perTree.stdout.trim()) });
}

/**
 * 被判成裸倉庫（主目錄 main-bare、這棵樹自己 bare）的後半段：Git 列的出處，能給還原就給。
 * 還原指令一筆 true 一行、獨佔一行、後面不接字（照貼才不會斷）；要人先想一下的話（reminder 與那兩句提醒）一律放在指令之前。
 * 每一筆 true 都改掉＝不必判斷哪一筆生效（不重做「最後一筆生效」那條規則）。
 * 不給還原的時候也不給自查指令：Git 列的全部出處已經印在訊息裡（原本那一行自查在 Git 一筆都列不出來時，照貼自己就退 1）。
 * 這棵樹那一路（st.fixable 有值）：只有落在 fixable 裡的 true 給還原（射程見 treeBare），其餘照實說為什麼不給；主目錄那一路照舊
 *   （它只在共用目錄叫 .git 時才問），include 引進的也給、先提醒。
 * 檔案的比對一律看裝置與 inode（站在這棵樹問時，出處換成絕對路徑用的基準可能經過符號連結，比字串會對不上）。
 */
function bareRestoreLines(st, reminder) {
  const list = st.origins;
  if (!list) return ['  問不到 core.bare 的出處：這裡不給還原指令。'];
  if (!list.length) {
    return ['  Git 列不出任何一筆 core.bare：判成裸倉庫的依據不是這個設定（例如這個目錄本身就是版本控制的資料夾），這裡不給還原指令。'];
  }
  const lines = ['  Git 列的 core.bare 出處（每一筆都列）：', ...list.map((o) => `    ${o.origin}  ${o.value}`)];
  const trues = list.filter((o) => o.value === 'true');
  if (!trues.length || list.some((o) => !o.origin.startsWith('file:'))) {
    return [...lines, '  出處裡有不是檔案的，或沒有一筆是 true：這裡不給還原指令。'];
  }
  const is = (list2, o) => list2.some((f) => samePath(f, o.origin.slice(5)) === true);
  const fixes = st.fixable ? trues.filter((o) => is(st.fixable, o)) : trues;
  const held = trues.filter((o) => !fixes.includes(o));
  const gated = st.gated || [];
  if (held.some((o) => is(gated, o))) {
    lines.push('  共用目錄不叫 .git，所以這個倉庫自己的設定檔那幾筆不給還原：這可能本來就是裸儲存庫（例如裸儲存庫加連結工作樹、或站在裸儲存庫裡面跑），從 Git 看跟壞掉的一模一樣，照做會把它改成非裸的。');
  }
  if (held.some((o) => !is(gated, o))) {
    lines.push('  不是這個倉庫自己的設定檔的那幾筆（include 引進的、或家目錄那一份）不給還原：它們可能也被別的倉庫共用。');
  }
  if (!fixes.length) return lines;
  lines.push('  還原之前先看一眼是誰寫的：已知的機制是環境變數 GIT_DIR 指向 .git/worktrees/<名> 時跑了 git init。');
  if (reminder) lines.push(reminder);
  const foreign = st.fixable ? [] : fixes.filter((o) => !is(st.own || [], o));
  if (foreign.length) {
    lines.push(`  下面有 ${foreign.length} 行改的不是這個倉庫自己的設定檔（include 引進的、或家目錄那一份），它可能也被別的倉庫共用：先確認再改。`);
  }
  lines.push(`  還原（${held.length ? '上面說不給的以外，' : ''}每一筆 true 各改回 false；在哪個目錄跑都可以）：`);
  for (const o of fixes) lines.push(`git config --file ${shq(o.origin.slice(5))} --replace-all core.bare false`);
  return lines;
}

/** not-a-repo、index-unusable 的後半段：Git 自己說了什麼（照原文，最多 GIT_SAYS_MAX 行）。 */
function gitSaysLines(said) {
  if (!said) return [];
  if (said.spawn) return [`  沒拿到 Git 的回答（Node：${said.spawn}）。`];
  if (!said.lines.length) {
    return [`  Git 沒有印錯誤訊息（${said.status === null ? `被訊號 ${said.signal || '（不明）'} 結束` : `退出碼 ${said.status}`}）。`];
  }
  const shown = said.lines.slice(0, GIT_SAYS_MAX);
  const rest = said.lines.length - shown.length;
  return ['  Git 的原話：', ...shown.map((l) => `    ${l}`), ...(rest > 0 ? [`    （後面還有 ${rest} 行沒印）`] : [])];
}

/**
 * anchor-missing 的後半段。before＝用三關前那一套判斷（三關前；或三關後、但跑之前那一次沒驗錨點，見 explain）。
 * 三關後（跑之前驗過）HEAD 被移動了＝先找回原本那一顆（只給看紀錄的指令、不給會丟提交的指令）；
 * 其餘看最新提交裡它是什麼：檔案＝整份換回最新提交；目錄或沒有＝不給指令。
 *   三關前那一套：目錄＝錨點填錯了（要填檔案）、沒有＝登記跟專案對不上，兩種都說在同一支變更裡改登記。
 *   三關後（跑之前驗過錨點、都在）：目錄或沒有都一樣＝跑之前它在索引裡，是只暫存、還沒提交的檔（例如 HEAD 裡的目錄被換成同名的檔），
 *   有一題把它從索引拿掉了：叫人把它重新暫存回去，不叫人改登記（改登記就是把登記改成配合被弄壞的樣子）。
 *   跑之前驗過沒有，看三關前那一次的 HEAD 就分得出來（解析不到＝錨點那一次沒驗），所以只有驗過的才用三關後這一套。
 */
function anchorRestoreLines(st, before, prior) {
  if (!before && prior && prior.head && st.head !== prior.head) {
    return [
      `  三關中途這棵樹的 HEAD 被移動了（跑之前在 ${short(prior.head)}，現在在 ${short(st.head)}；提交或切換過）。不要改登記；先看最近幾次 HEAD 移動、找回跑之前那一顆，再查是哪一題：`,
      `git -C ${shq(st.tree)} reflog -n 5`,
    ];
  }
  const lines = [];
  const notInHead = st.missing.filter((a) => !st.inHead.includes(a) && !st.dirs.includes(a));
  if (notInHead.length) {
    lines.push(before
      ? `  最新提交裡也沒有：${notInHead.join('、')}。登記跟專案對不上：有意刪除或改名錨點，就在同一支變更裡改 settings.json 的 checks.indexAnchors。`
      : `  最新提交裡本來就沒有：${notInHead.join('、')}（跑之前在索引裡＝只暫存、還沒提交）：有一題把它從索引拿掉了。不要改登記，把它重新暫存回去（git add）。`);
  }
  if (st.dirs.length) {
    lines.push(before
      ? `  在最新提交裡是目錄：${st.dirs.join('、')}。錨點要填檔案、不能填目錄（重建索引也不會好）：在同一支變更裡改 settings.json 的 checks.indexAnchors。`
      : `  最新提交裡它是目錄：${st.dirs.join('、')}（跑之前索引裡是檔案＝只暫存、還沒提交）：有一題把它從索引拿掉了。不要改登記，把原本暫存的檔案重新暫存回去（git add）。`);
  }
  if (st.inHead.length) {
    // 三關前多半是人有意暫存的；三關後（跑之前都在）多半是某一題動的，也可能是同一段時間別的工作階段有意的暫存
    lines.push(before
      ? '  有意暫存刪除或改名錨點的話不要照做，改成在同一支變更裡改 settings.json 的 checks.indexAnchors。不是的話：'
      : '  如果是同一段時間別的工作階段有意暫存刪除或改名錨點，不要照做（那是它的工作）。不是的話：');
    lines.push(`  把索引整份換回最新提交（會把暫存的改動全部變回未暫存，工作區的檔案內容不動）${st.sparse ? '；這棵樹是稀疏 checkout，下面兩行都要照貼（第二行把稀疏範圍外的檔重新標回不在工作區）' : ''}：`);
    lines.push(`git -C ${shq(st.tree)} read-tree HEAD`);
    if (st.sparse) lines.push(`git -C ${shq(st.tree)} sparse-checkout reapply`);
  }
  return lines;
}

/** head-gone 的訊息：切回跑之前那一顆；被拒絕時（索引被清空、檔案還在工作區）改成只把 HEAD 指回去。 */
function headGoneLines(st) {
  const t = shq(st.tree);
  const lines = [`三關跑完之後，這棵樹的 HEAD 解析不到了（跑之前在 ${short(st.head)}，${st.was ? `分支 ${st.was}` : '分離的 HEAD'}）：有一題把這棵樹切到還沒有提交的分支（例如 git switch --orphan）或刪掉了它所在的分支（或是不是同一段時間有別的工作階段在動這棵樹），專案登記的索引錨點（checks.indexAnchors）因此沒驗到。不要改登記，先把這棵樹切回去、再查是哪一題。`];
  if (st.was && !st.branch) lines.push(`  分支 ${st.was} 已經不指在跑之前那一顆上（被移動或刪掉了）：下面先回到那一顆提交（分離的 HEAD），分支由你決定怎麼接回。`);
  lines.push('  切回跑之前那一顆（工作區有會被蓋掉的檔或改動時 Git 會拒絕、什麼都不動）：');
  lines.push(st.branch ? `git -C ${t} switch ${shq(st.branch)}` : `git -C ${t} switch --detach ${st.head}`);
  const pointer = st.branch ? `symbolic-ref HEAD ${shq(`refs/heads/${st.branch}`)}` : `update-ref --no-deref HEAD ${st.head}`;
  lines.push(`  Git 拒絕、說未追蹤的檔會被蓋掉的話（索引被清空、檔案還在工作區）：改用 git -C ${t} ${pointer} 只把 HEAD 指回去（索引與工作區都不動），再跑一次三關執行器、照它的訊息重建索引。`);
  return lines;
}

const BEFORE = {
  bare: '這棵樹在跑三關之前就已經是裸倉庫了：先還原再推。',
  'wrong-tree': '版本控制認的工作樹根目錄不是這裡（樹被指到別處，或不是在專案根目錄跑）：三關量到的會是別棵樹，不放行。',
  'index-unusable': 'HEAD 解析得到（不是剛 init、也不在還沒有提交的分支上），這棵樹的索引檔卻不見了或 git 讀不了：靠它掃全樹的考題會掃到零個檔然後回報零違規，不放行。索引檔不見時用 git read-tree HEAD 重建（索引在但壞了，先備份再處理）。',
};
const AFTER = {
  'wrong-tree': '三關跑完之後這棵樹被指到別處了（跑之前是好的）：有一題改了倉庫設定，先還原、再查是哪一題。',
  'index-unusable': '三關跑完之後這棵樹的索引檔不見了或讀不了（跑之前是好的）：有一題弄壞了索引，先重建、再查是哪一題。',
};
const NOT_A_REPO = '這裡不是版本控制的工作樹。';
const AFTER_BROKEN = '三關跑完之後這棵樹不是工作樹了（跑之前是好的）：有一題把倉庫弄壞了，先還原、再查是哪一題。';
/** 三關後的索引那一句：跑之前 HEAD 解析不到＝索引那一項沒驗，不能說「跑之前是好的」。 */
const AFTER_INDEX_UNCHECKED = '三關跑完之後這棵樹的索引檔不見了或讀不了（跑之前 HEAD 解析不到、這一項沒驗；三關跑完 HEAD 解析得到了）：先重建索引、再查是哪一題。';
/** git 打不開時為什麼不給還原：成因各在不同的檔，要定位就得自己解讀 Git 的設定與倉庫布局。 */
const NO_RESTORE = '  這裡只印 Git 的原話、不給還原指令：如果有東西壞了，要從 Git 的原話找出是哪一個檔（替你找就得自己解讀 Git 的設定規則與倉庫布局，這支不做）。Git 原話裡若附了建議的指令，這裡沒有驗過。';
const TREE_BARE_REMINDER = '  先看這個目錄底下原本有沒有專案的檔：本來就是裸儲存庫的話不要照做（三關要在工作樹裡跑）。';
/**
 * 共用目錄名叫 .git 時那句提醒要指名 .git 的上一層：從連結工作樹跑時「這個目錄」是工作樹、本來就有專案的檔，
 * 提醒會指向「可以照做」；要看的是 .git 的上一層——一般 checkout 的主目錄有專案的檔，proj/.git 那種裸儲存庫的上一層沒有（PFW #622 複審後掃）。
 */
const treeBareReminder = (commonDir) => (commonDir
  ? `  先看 ${shq(path.dirname(commonDir))} 底下原本有沒有專案的檔（.git 的上一層，不一定是你現在站的這棵樹）：本來就是裸儲存庫的話不要照做（三關要在工作樹裡跑）。`
  : TREE_BARE_REMINDER);
/** 這棵樹被判成裸倉庫、三關前、一行還原都不給的時候的開頭（不說「先還原再推」：後面說的是為什麼不給）。 */
const BEFORE_BARE_NO_FIX = '這棵樹在跑三關之前就被 Git 判成裸倉庫了（沒有工作樹）：三關要在工作樹裡跑，不放行。';
const MAIN_BARE_REMINDER = '  先看主目錄底下原本有沒有專案的檔：本來就是裸儲存庫的話不要照做，這份登記不適用這台（見 MACHINES.md 的 E2、E3 那一列）。';

/**
 * 把 treeState 的結果寫成給人看的幾行；before＝三關前（退 2），否則是三關後（退 1），prior＝三關前那一次的結果。
 * 三關後、跑之前是好的那幾種新訊息（主目錄判成裸、主目錄打不開、錨點、HEAD 解析不到）都說「多半是某一題、也可能是同一段時間別的工作階段」：
 *   兩者從這裡分不出來。主目錄「問不到是不是這個倉庫」那一句不這樣說（它沒量到壞，只是驗不到）。跑之前錨點沒驗、三關後才驗到的那一種不說（它用三關前那一套判斷）；
 *   既有的三關後那幾句（樹被指到別處、索引、不是工作樹了）不加這一句。
 * 既有狀態：這棵樹被判成裸倉庫＝後面接出處與還原（射程見 treeBare；三關前一行還原都不給時開頭不說「先還原再推」）；
 *   git 打不開、索引讀不了＝後面接 Git 的原話。
 *   三關後的索引那一句：跑之前 HEAD 解析不到（索引那一項沒驗）就不說「跑之前是好的」。
 */
function explain(st, before, prior) {
  const main = st.main && shq(st.main);
  const orOther = '（或是不是同一段時間有別的工作階段在動）';
  if (st.state === 'head-gone') return headGoneLines(st);
  if (st.state === 'bare') {
    const rest = bareRestoreLines(st, before ? treeBareReminder(st.commonDir) : null);
    const fixes = rest.some((l) => l.startsWith('git '));
    return [before ? (fixes ? BEFORE.bare : BEFORE_BARE_NO_FIX) : AFTER_BROKEN, ...rest];
  }
  if (st.state === 'not-a-repo') {
    return [before ? NOT_A_REPO : AFTER_BROKEN, ...gitSaysLines(st.said), ...(st.said && st.said.lines && st.said.lines.length ? [NO_RESTORE] : [])];
  }
  if (st.state === 'index-unusable') {
    const text = before ? BEFORE['index-unusable'] : prior && prior.head === null ? AFTER_INDEX_UNCHECKED : AFTER['index-unusable'];
    return [text, ...gitSaysLines(st.said)];
  }
  if (st.state === 'main-bare') {
    const head = before
      ? `主目錄 ${main} 被 Git 判成裸倉庫了：從這棵連結工作樹看一切正常，主目錄裡的 git status／add／commit 卻會回 fatal: this operation must be run in a work tree。專案設定登記了主目錄是一般工作樹（checks.mainWorktree），不放行。`
      : `三關跑完之後，主目錄 ${main} 被 Git 判成裸倉庫了（跑之前是好的）：有一題改了主目錄讀的設定${orOther}。先還原、再查是哪一題。`;
    return [head, ...bareRestoreLines(st, before ? MAIN_BARE_REMINDER : null)];
  }
  if (st.state === 'main-unreadable') {
    // 問到的是另一個倉庫：在主目錄下一般的 git 指令（不像這裡擋著不准往上層找）會落到那個倉庫（Codex r2 那一條低）；
    // 那個倉庫是裸的時，git status、git log 照樣會失敗（git 2.39.5 量到都退 128），所以這裡不說會不會失敗。
    // 其餘：這裡擋著不准往上層找所以打不開；一般的 git 指令在主目錄放在別的倉庫底下時同樣會落到那個倉庫，不一定失敗
    const where = st.other
      ? '在主目錄下一般的 git 指令卻會落到那個倉庫、碰不到這個專案'
      : '在主目錄下的 git 指令卻碰不到這個倉庫（會失敗；主目錄放在別的倉庫底下的話，會落到那個倉庫）';
    let head = before
      ? `主目錄 ${main} 的 git 打不開（${st.err}）：從這棵連結工作樹看一切正常，${where}。專案設定登記了主目錄是一般工作樹（checks.mainWorktree），不放行。`
      : `三關跑完之後，主目錄 ${main} 的 git 打不開（${st.err}）（跑之前是好的）：有一題動了主目錄的 .git 或它讀的設定${orOther}。先看、還原，再查是哪一題。`;
    // 身分比對讀不到（stat 失敗）：沒量到打不開，只是驗不到——照實說問不到，一樣不放行
    if (st.unknown) head = `${before ? '' : '三關跑完之後，'}主目錄 ${main} 問不到是不是這個倉庫（${st.err}）${before ? '' : '（跑之前是好的）'}：專案設定登記了主目錄是一般工作樹（checks.mainWorktree），驗不到就不放行。`;
    // 成因不只一種（core.bare、core.worktree、include…），精準的還原要自己解讀設定檔：這裡只給自查。
    // 主目錄自己的 config.worktree 存在才給那一行（檔不存在時 git config --file 會退非零，照貼就斷）
    const own = path.join(st.common, 'config.worktree');
    const hasOwn = isFile(own);
    // 問到的是另一個倉庫＝主目錄自己那份 .git 沒被 Git 認出來（例如 HEAD 不見），多半不是設定：照實先說這一句
    const cause = st.other
      ? ['  這一種多半不是設定：主目錄自己那份 .git 壞了（例如 HEAD 不見），Git 才改去開了別的倉庫。先看主目錄的 .git 底下的檔還完不完整；設定檔也站在倉庫外面讀得到，一起看：']
      : [];
    return [
      head,
      ...cause,
      ...(st.other ? [] : [hasOwn
        ? '  原因多半在共用設定檔或主目錄自己的 config.worktree；兩個都站在倉庫外面讀得到，先看它們：'
        : '  原因多半在共用設定檔；站在倉庫外面也讀得到，先看它：']),
      `git config --file ${shq(path.join(st.common, 'config'))} --show-origin --list`,
      ...(hasOwn ? [`git config --file ${shq(own)} --show-origin --list`] : []),
    ];
  }
  if (st.state === 'anchor-missing') {
    // 三關後的說法（跑之前都在、有一題拿掉了、不要改登記）只在三關前那一次真的驗過錨點時成立：那一次 HEAD 解析得到才驗。
    // 跑之前 HEAD 解析不到（這一項沒驗）、三關後才驗到的，退出碼照舊是三關後的 1，判斷改用三關前那一套。
    const checkedBefore = !before && Boolean(prior && prior.head);
    const asBefore = !checkedBefore;
    const all = st.missing.length === st.anchors.length;
    const notes = [];
    if (all) notes.push(st.indexEmpty ? '登記的全部不見：索引整份是空的' : '登記的全部不見');
    if (checkedBefore) notes.push('跑之前都在');
    const list = `${st.missing.join('、')}${notes.length ? `（${notes.join('；')}）` : ''}`;
    let head = `這棵樹的索引裡找不到專案登記的錨點檔（checks.indexAnchors）：${list}。`;
    if (checkedBefore) head = `三關跑完之後，這棵樹的索引裡找不到專案登記的錨點檔（checks.indexAnchors）：${list}：有一題動了這棵樹的索引${orOther}。先還原、再查是哪一題。`;
    else if (!before) head = `專案登記的索引錨點（checks.indexAnchors）跑之前 HEAD 解析不到、這一項沒驗；三關跑完之後才驗到，找不到：${list}。`;
    // 「索引少了這幾筆」只在真的是索引丟了東西時說；用三關前那一套而且全都是登記填錯（目錄、最新提交裡也沒有）時不說
    const lost = checkedBefore || st.inHead.length > 0;
    return [
      head,
      ...(lost ? ['  索引檔還在、git ls-files 也不報錯，只是少了這幾筆：靠 git ls-files 掃全樹的考題會少掃（清空時掃到零個檔），然後回報沒有違規。'] : []),
      ...anchorRestoreLines(st, asBefore, prior),
    ];
  }
  if (before) return [BEFORE[st.state] || NOT_A_REPO];
  return [AFTER[st.state] || AFTER_BROKEN];
}

function runChecks({ settings = readSettings(), run = runCommand, cwd = process.cwd(), tree = treeState, fingerprint = configFingerprint } = {}) {
  const lines = [];
  const raw = settings.checks && settings.checks.commands;
  if (!Array.isArray(raw) || !raw.length) return { code: 2, lines: ['專案設定裡沒有登記三關指令：什麼都沒跑就放行，比不跑更危險。'] };
  // 逐筆驗、不濾掉（r1 Medium⑪）：登記裡有一條是「未設定」、空陣列或形狀錯，代表有一關還沒接好——
  // 靜靜濾掉等於讓那一關消失。要停用某一關就把它從登記拿掉，不要用壞資料代表停用。
  const badAt = raw.findIndex((x) => !Array.isArray(x) || !x.length || x.some((a) => typeof a !== 'string' || !a) || x[0] === UNSET);
  if (badAt !== -1) return { code: 2, lines: [`三關登記的第 ${badAt + 1} 條是「未設定」、空的或形狀不對：有一關還沒接好，不放行（要停用就從登記拿掉）。`] };
  const cmds = raw;
  const opts = treeOptions(settings.checks);
  if (opts.error) return { code: 2, lines: [opts.error] };
  const before = tree(run, cwd, opts);
  if (before.state !== 'ok') return { code: 2, lines: explain(before, true) };
  const printBefore = fingerprint(cwd);
  for (const [i, cmd] of cmds.entries()) {
    lines.push(`第 ${i + 1} 關：${cmd.join(' ')}`);
    const r = run(cmd, cwd);
    if (r.status === null) return { code: 2, lines: [...lines, `第 ${i + 1} 關起不來（${r.error || '沒有退出碼'}）：拿不到判決，不放行。`] };
    if (r.status !== 0) return { code: 1, lines: [...lines, `第 ${i + 1} 關紅了（退出碼 ${r.status}）。修好再推。`] };
  }
  // 三關後樹的狀態與設定指紋兩段都印（先修哪一個由人決定）；樹的狀態只回第一個問題（見 treeState），先修完再跑一次才看得到下一個
  let after = tree(run, cwd, opts);
  if (after.state === 'ok' && opts.anchors && before.head && !after.head) after = headGone(cwd, before);
  const broken = after.state === 'ok' ? [] : explain(after, false, before);
  const printAfter = fingerprint(cwd);
  if (printAfter === null && printBefore !== null) {
    // 讀不到不等於被改了（例如這棵樹的 .git 檔被刪掉）：照實說沒辦法比對
    broken.push('三關跑完之後 git 讀不到這棵樹的設定在哪裡，沒辦法比對倉庫的共用設定或這棵樹自己的設定有沒有被改：先看共用設定檔。');
  } else if (printAfter !== printBefore) {
    broken.push('三關跑的過程中，倉庫的共用設定或這棵樹自己的設定被改了：從這棵樹看也許還健康，別的樹（含主目錄）可能已經打不開。先看設定檔改了什麼、還原，再查是哪一題（或是不是同一段時間有別的工作階段在改）。');
  }
  if (broken.length) return { code: 1, lines: [...lines, ...broken] };
  const unchecked = [];
  if (!opts.mainNormal) unchecked.push('主目錄是不是一般工作樹（checks.mainWorktree）');
  if (!opts.anchors) unchecked.push('索引錨點（checks.indexAnchors）');
  const skipped = [...new Set([...(before.skipped || []), ...(after.skipped || [])])];
  const note = (unchecked.length ? `沒登記、所以沒驗：${unchecked.join('、')}。` : '')
    + (skipped.length ? `登記了、這次沒驗：${skipped.join('、')}。` : '');
  return { code: 0, lines: [...lines, `三關全綠（${cmds.length} 關）。${note}`] };
}

if (require.main === module) {
  let result;
  try { result = runChecks(); } catch (e) { result = { code: 2, lines: [`三關執行器：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——不放行。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { runChecks, runCommand, treeState, configFingerprint, MAIN_NORMAL };
