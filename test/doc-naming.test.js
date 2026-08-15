// @ts-check
// **文件的名字要對得起內容**（William 2026-08-03 定）。
//
// ## 起因
//
// 合併程序寫在一份叫 `CODEX-REVIEW.md` 的檔案裡，而 `AGENTS.md` 有 13 處叫**任何人**
// （包括 Claude）「照它的合併步驟走」。William 問：
//
//   「為什麼 Claude 要照一份叫 Codex 的檔案做事？這樣很奇怪。」
//
// 他問得對。那份檔案裡只有一小段是 Codex 專屬的，其餘（合併步驟、審查循環、
// 唯讀紀律／PII／對抗式自審）**誰在做就適用誰**。名字只描述了其中一小塊。
//
// ## 這支守什麼
//
// 判準是**宣告**，不是推導（今晚 #384 學到的：從文字推導的清單永遠不知道自己漏了什麼）：
// 下面的 `DOCS` 手寫每一份根目錄文件「**誰該讀**」，考題再驗三件事：
//   ①三方都要照做的文件，**名字不可以只掛一方**
//   ②文件的 H1 標題要對得上檔名（不能檔名叫 A、內容講 B）
//   ③全 repo 不可以有指向已改名檔案的死連結
//
// ## 誠實劃界
//
// 擋得住「名字掛錯人」「**偏離宣告的**標題配對」「改名之後有連結沒跟著改（超過宣告的次數）」。
// ⚠️ **它不會判斷語意**（Codex #387 r1 要求改的措辭）：`title` 是**手動宣告的配對**，
// 這一題偵測的是「有人改了內容卻沒回來重想檔名」，**不是**「檔名與內容意思相符」。
// **擋不住**：內容寫得爛、該拆成兩份卻擠在一份、宣告本身就寫錯——那些是人的判斷。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../lib/git-env.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/** 三方協作裡的角色名。文件名字掛上其中一個，就等於宣告「只有這一方要讀」。 */
/**
 * repo 追蹤中的檔案。未追蹤檔（本機工具、暫存筆記）不是 repo 的一部分。
 *
 * ⚠️ **`env: gitEnv()` 不可省**：`GIT_DIR` 一旦被繼承（從連結工作樹 push 時 hook 環境本來就有），
 *    `cwd: ROOT` 形同無效 ⇒ 清單變成別棵樹的內容或空的，下面的死連結／標題配對就全部空掃而通過。
 *    機制在 lib/git-env.js；行為題＝本檔題名關鍵字「清單與 git grep 不可被繼承的 GIT_*」那題。
 */
const trackedFiles = () => execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'],
  { cwd: ROOT, encoding: 'utf8', env: gitEnv() }).split('\n').filter(Boolean);

/**
 * 全 repo（追蹤中的文字檔）提到舊檔名的每一處，取前後 30 字當窗格。
 *
 * ⚠️ **搜尋詞在執行時才拼出來，窗格裡的舊名換成 `⟨舊名⟩`**：
 * 不這樣做的話，下面那份宣告自己就含有舊名字面 ⇒ `git grep` 又找到它們 ⇒
 * 宣告與實際永遠對不起來（**自我指涉的爆炸**，2026-08-03 實際踩到）。
 */
function oldNameContexts() {
  const term = ['CODEX', 'REVIEW'].join('-');
  // ⚠️ `env: gitEnv()` 的理由同 trackedFiles()：GIT_DIR 會讓 git 去搜**別棵樹**，
  //    死連結一條都找不到而這一題全綠。
  const out = execFileSync('git', ['grep', '-I', '-n', term],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e8, env: gitEnv() }).split('\n').filter(Boolean);
  /** @type {Record<string, string[]>} */ const found = {};
  for (const l of out) {
    const i1 = l.indexOf(':');
    const text = l.slice(l.indexOf(':', i1 + 1) + 1);
    // ⚠️ **同一行的每一個命中都要算**（Codex #387 r3 Medium①）：`git grep` 每行只輸出一次，
    //    而上一版只取 `indexOf` 的第一個 ⇒ 在合法歷史說明後面隔 60 字再加一條死連結，
    //    兩次命中產生**完全相同的窗格** ⇒ 考題照樣綠。
    for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
      const win = text.slice(Math.max(0, at - 30), at + 42).trim().split(term).join('⟨舊名⟩');
      (found[l.slice(0, i1)] ||= []).push(win);
    }
  }
  return found;
}

const ROLE_NAMES = ['CODEX', 'CLAUDE', 'WILLIAM'];

/**
 * **宣告**：每一份根目錄文件是給誰讀的。
 *
 * - `readers`: `'all'`＝三方都要照做；`'claude'`／`'codex'`＝只有那一方。
 * - `toolFixedName`: **工具規定的檔名**，改了就失效 ⇒ 不受「名字不可掛一方」那條限制。
 *   （William 2026-08-03 明確要求留這個例外。）
 * - `title`: **宣告目前的 H1**（必須以它開頭）。
 *   ⚠️ 它不是「從檔名推出來的規則」——`PROJECT.md` 的標題是中文的「專案共同記憶」，
 *   意思一致、字面不同，硬要求字面相符只會逼人改一個本來就對的標題。
 *   它鎖的是**配對**：有人把這份文件改寫成別的主題時，H1 會變，這一題就會紅，
 *   於是「那檔名還對嗎？」變成一個必須回答的問題，而不是沒有人注意到的漂移。
 */
const DOCS = {
  'AGENTS.md': { readers: 'all', title: 'AGENTS.md' },
  'CLAUDE.md': {
    readers: 'claude',
    title: 'CLAUDE.md',
    // ⚠️ 這個檔名是 Claude Code **工具自動載入**的固定名稱，改掉整份規則就不會被讀到。
    //    它掛 Claude 的名字是**正確的**——它本來就只給 Claude 讀。
    toolFixedName: true,
  },
  'REVIEW-AND-MERGE.md': { readers: 'all', title: '審查與合併程序' },   // 檔名英文、標題中文：意思一致（同 PROJECT.md）
  'PROJECT.md': { readers: 'all', title: '個人理財中心（榮祥森）— 專案共同記憶' },
  'README.md': { readers: 'all', title: '個人理財中心' },
};

test('⭐ 三方都要照做的文件，名字不可以只掛一方（除非是工具規定的檔名）', () => {
  for (const [file, spec] of Object.entries(DOCS)) {
    // ⚠️ **`toolFixedName` 只有 `CLAUDE.md` 能用**（Codex #387 r1）：
    //    它現在其實用不到（`CLAUDE.md` 的 `readers` 是 `'claude'`，本來就跳過），
    //    但留著會變成一個「未來任何共用文件都能自稱工具固定檔名」的後門。
    if (spec.toolFixedName) {
      assert.equal(file, 'CLAUDE.md',
        `只有 CLAUDE.md 可以用 toolFixedName（那是 Claude Code 工具自動載入的固定檔名）。\n`
        + `「${file}」不是——不要用這個旗標繞過「共用文件不可只掛一方」。`);
    }
    if (spec.readers !== 'all' || spec.toolFixedName) continue;
    const upper = file.toUpperCase();
    for (const role of ROLE_NAMES) {
      assert.ok(!upper.includes(role),
        `「${file}」是三方共用的文件，檔名卻掛著「${role}」。\n`
        + '⚠️ 起因：合併步驟原本寫在 `CODEX-REVIEW.md`，而 AGENTS.md 有 13 處叫**任何人**照它做——\n'
        + '   一個 Claude 照 CLAUDE.md 指示去讀 AGENTS.md，會被指到一份掛 Codex 名字的檔案。\n'
        + '   **名字會決定誰覺得「這關我的事」。**\n'
        + `   如果它其實是工具規定的固定檔名（像 CLAUDE.md），請在 DOCS 標 toolFixedName: true。`);
    }
  }
});

test('文件的 H1 標題要對得上檔名（不能檔名叫 A、內容講 B）', () => {
  for (const [file, spec] of Object.entries(DOCS)) {
    if (!spec.title) continue;
    const h1 = read(file).split('\n')[0].replace(/^#\s*/, '');
    assert.ok(h1.startsWith(spec.title),
      `「${file}」的第一行標題是「${h1.slice(0, 40)}」，對不上宣告的「${spec.title}」。\n`
      + '⚠️ 檔名與標題各說各話，讀者要打開才知道裡面是什麼——那正是改名要修的病。');
  }
});

test('DOCS 必須涵蓋每一份根目錄文件（新增一份就要在這裡宣告它給誰讀）', () => {
  // ⚠️ 只看**追蹤中的**檔案：本機的暫存筆記（`meeting_0724_1414.md` 之類）不是 repo 的文件，
  //    把它們算進來只會逼人替不該進版控的東西寫宣告。
  const onDisk = trackedFiles().filter((f) => f.endsWith('.md') && !f.includes('/'));
  assert.deepEqual([...onDisk].sort(), Object.keys(DOCS).sort(),
    '根目錄的 .md 檔與 DOCS 的宣告不一致。\n'
    + '⚠️ 新增一份根目錄文件就要在 DOCS 登記「誰該讀」——\n'
    + '   沒登記的話，這三題完全看不到它（**驗不出沒宣告的東西**，同 #384 的教訓）。');
});

/**
 * **允許提到舊檔名的地方：逐字列出命中處前後 30 字的窗格**。
 *
 * ⚠️ **次數不等於位置**（Codex #387 r2 Medium）：上一版只鎖「這個檔可以出現幾次」，
 * 於是把合法的那一次刪掉、在別處加一條**真的死連結**，總數不變 ⇒ 照樣全綠。
 * 現在比對的是**命中處的上下文**：換了地方就對不上，多一處也對不上。
 * ⚠️ 用窗格不用整行，是因為語料 fixture 那一行是 5KB 的 JSON——整行比對不可讀也不可維護。
 */
const HISTORICAL_CONTEXTS = {
  'REVIEW-AND-MERGE.md': [
    '> **這份檔案原本叫 `⟨舊名⟩.md`，2026-08-03 改名。**',
  ],
  'test/doc-naming.test.js': [
    '// 合併程序寫在一份叫 `⟨舊名⟩.md` 的檔案裡，而 `AGENTS.md` 有 13 處',
    '+ \'⚠️ 起因：合併步驟原本寫在 `⟨舊名⟩.md`，而 AGENTS.md 有 13 處叫**任何人*',
    '\'提到舊檔名 ⟨舊名⟩.md 的**位置**與宣告的不一致。\\n\'',
  ],
  'test/fixtures/review-verdict-corpus.json': [
    'eck-review-verdicts.js:29` 與 `⟨舊名⟩.md:44` 仍寫「1＝有未回應阻擋」，但現在零正式通過、',
  ],
};

test('⭐ 改名之後不可以有死連結（比對命中處的上下文，不靠副檔名白名單）', () => {
  // ⚠️ **不要用副檔名白名單**（Codex #387 r2 Medium）：上一版只掃 `.md/.js/.json/.yml`，
  //    `.txt`／`.html`／`.sh`／`.cjs` 全部自動免疫。補一個 `.json` 只補了這次撞到的洞。
  //    改用 `git grep -I`——它自己判斷哪些是文字檔，**不需要我列清單**。
  assert.deepEqual(oldNameContexts(), HISTORICAL_CONTEXTS,
    '提到舊檔名 CODEX-REVIEW.md 的**位置**與宣告的不一致。\n'
    + '⚠️ 改名最常見的失敗不是改錯，是**有地方沒跟著改**。\n'
    + '   如果那一處是刻意保留的歷史說明，請把新的窗格加進 HISTORICAL_CONTEXTS。');
});

/**
 * **既有的非 ASCII 路徑**（2026-08-03 起凍結，只出不進）。
 * ⚠️ 逐一列出，不是「`docs/` 底下放行」——那樣新增 `docs/新規格.md` 也會過（Codex #387 r2 High②）。
 * 要改名得同步更新本名單與每一個實際引用處（引用自己 grep，別靠印象——凍結名單只有一部分
 * 被 AGENTS 引用，mutate.sh 也不是每份契約都引用；誰有實際引用就同步誰，#399 三檔改名即一例）。
 */
const LEGACY_NON_ASCII_PATHS = [
  'docs/C6-部署與對抗審查-操作手冊.md',
  'docs/GitHub分支保護-設定與驗證.md',
  'docs/archive/PROJECT-完工紀錄.md',
  'docs/archive/個股研究頁-P1-交接.md',
  'docs/archive/月度回顧-施工計畫.md',
  'docs/archive/目標追蹤-施工計畫.md',
  'docs/archive/證券交易-設計藍圖.md',
  'docs/archive/階段B-骨架改建-施工計畫.md',
  'docs/個股基本面研究-施工計畫.md',
  'docs/個股研究頁-施工計畫.md',
  'docs/個股研究頁-裁決與審查回覆.md',
  'docs/功能候選清單.md',
  'docs/多人上線-施工計畫.md',
  'docs/安全與健壯性-待辦地圖.md',
  'docs/帳單匯入與分類-運作說明.md',
  'docs/教學影片/EP01-生存優先-腳本.md',
  'docs/教學影片/製作流程與分工.md',
  'docs/文案審稿-雲端版的九句假話.md',
  'docs/每日洞察引擎-施工計畫.md',
  'docs/測試覆蓋率地圖.md',
  'docs/系統優化-施工計畫.md',
];

test('⭐ 檔名一律用英文（William 2026-08-03 定）——既有名單凍結，只出不進', () => {
  // ⚠️ 上一版只掃根目錄與 `test/`，於是新增 `docs/新的規格.md`、`lib/中文.js`、
  //    `scripts/中文.sh` 全部照樣綠（Codex #387 r2 High②）。**掃全部 tracked path。**
  // ⚠️ **擋全部非 ASCII，不是只擋基本漢字**（Codex #387 r3 Medium②）：
  //    上一版用 `[\u4e00-\u9fff]`，於是 `かな.md`、`한국어.js`、CJK 擴充字、emoji、
  //    `résumé.md` 全部照樣過。契約是「檔名一律用英文」，判準就該是「只准 ASCII」——
  //    **又一次列舉：我列了一種文字，而檔名可以用任何文字。**
  const nonAscii = /[^\x20-\x7e]/u;
  const now = trackedFiles().filter((f) => nonAscii.test(f)).sort();
  assert.deepEqual(now, LEGACY_NON_ASCII_PATHS,
    '非 ASCII 檔名的清單變了。\n'
    + '⚠️ **新增的檔名一律用英文**——判準是「只准 ASCII」，中文、日文、韓文、\n'
    + '   emoji、`résumé` 這種帶重音的拉丁字母，一律算違規（訊息以前只說「中文」，\n'
    + '   跟實際判準不符，Codex #387 r4 抓到）。\n'
    + '   理由：非 ASCII 檔名在 shell、git、URL 裡都要跳脫，\n'
    + '   `git status` 會印成 `\\346\\234\\210…` 那種八進位，出事時很難對照。\n'
    + '   如果是**刪掉**了既有的非 ASCII 檔，請把它從 LEGACY_NON_ASCII_PATHS 一起移除。');
});

test('檔案真的存在（宣告的每一份都要在）', () => {
  for (const file of Object.keys(DOCS)) {
    assert.ok(existsSync(join(ROOT, file)), `DOCS 宣告了「${file}」但檔案不存在`);
  }
});

test('⭐ 清單與 git grep 不可被繼承的 GIT_* 帶走（拿掉 env: gitEnv() 要紅）', () => {
  // ⚠️ 本檔每一題的底料都是這兩個 git 呼叫。`cwd: ROOT` **隔離不了 `GIT_DIR`**——有它時 git 不看 cwd，
  //    而從連結工作樹 push 時 git 自己會把它塞進 hook 環境、`pre-push` 又會跑 `npm test`。
  //    清單被換走 ⇒ 非 ASCII 檔名那一題空掃、死連結一條都找不到，而整支全綠。
  const baseline = { files: trackedFiles().length, contexts: Object.keys(oldNameContexts()).length };
  assert.ok(baseline.files > 100, `基準清單只有 ${baseline.files} 支＝這一題在空轉`);

  // ⚠️ **這一題是代理指標，射程有限**：注入的 `GIT_DIR` 是實測唯一「四種呼叫形狀通吃」的變數
  //    （對照表在 test/helpers/dirty-git-env.js 檔頭），它證明的是真實情境下結果沒被帶偏。
  //    ⚠️ 它**擋不住**「把清法退化成只刪 GIT_DIR 的列名版」——那一族由同檔的
  //    「交給 git 的環境裡不可以有任何 GIT_*」那題（直接讀子行程收到什麼）守。
  const restore = injectDirtyGitEnv();
  try {
    const files = trackedFiles();
    assert.ok(files.includes('AGENTS.md'),
      '注入髒 GIT_* 之後清單裡就沒有 AGENTS.md 了＝環境沒被隔離，本檔每一題都會掃錯對象');
    assert.equal(files.length, baseline.files, '注入髒 GIT_* 之後清單長度變了＝隔離失效');
    assert.equal(Object.keys(oldNameContexts()).length, baseline.contexts,
      '注入髒 GIT_* 之後 git grep 的命中檔數變了＝死連結那一題會搜到別棵樹');
  } finally {
    restore();
  }
});

test('⭐ 列檔與 git grep 交給 git 的環境裡不可以有任何 GIT_*（直接斷言，不靠代理指標）', () => {
  // ⚠️ 題名關鍵字「清單與 git grep 不可被繼承的 GIT_*」那題是代理指標，只涵蓋「剛好會改變這個指令的變數」；
  //    這一題直接問子行程收到什麼。
  assertChildGitEnvClean(assert, 'doc-naming 的 trackedFiles()', () => trackedFiles());
  assertChildGitEnvClean(assert, 'doc-naming 的 oldNameContexts()', () => oldNameContexts());
});
