// @ts-check
// **文件的名字要對得起內容**（William 2026-08-03 定）。
//
// ## 起因
//
// 合併程序寫在一份叫 `CODEX-REVIEW.md` 的檔案裡，而 `AGENTS.md` 有 13 處叫**任何人**
// （包括 Claude）「照它的合併六步驟走」。William 問：
//
//   「為什麼 Claude 要照一份叫 Codex 的檔案做事？這樣很奇怪。」
//
// 他問得對。那份檔案裡只有一小段是 Codex 專屬的，其餘（合併六步驟、審查循環、
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
// 擋得住「名字掛錯人」「標題與檔名不一致」「改名之後有連結沒跟著改」。
// **擋不住**「內容寫得爛」「該拆成兩份卻擠在一份」——那是人的判斷。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/** 三方協作裡的角色名。文件名字掛上其中一個，就等於宣告「只有這一方要讀」。 */
/** repo 追蹤中的檔案。未追蹤檔（本機工具、暫存筆記）不是 repo 的一部分。 */
const trackedFiles = () => execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'],
  { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

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
  '審查與合併程序.md': { readers: 'all', title: '審查與合併程序' },
  'PROJECT.md': { readers: 'all', title: '個人理財中心（榮祥森）— 專案共同記憶' },
  'README.md': { readers: 'all', title: '個人理財中心' },
};

test('⭐ 三方都要照做的文件，名字不可以只掛一方（除非是工具規定的檔名）', () => {
  for (const [file, spec] of Object.entries(DOCS)) {
    if (spec.readers !== 'all' || spec.toolFixedName) continue;
    const upper = file.toUpperCase();
    for (const role of ROLE_NAMES) {
      assert.ok(!upper.includes(role),
        `「${file}」是三方共用的文件，檔名卻掛著「${role}」。\n`
        + '⚠️ 起因：合併六步驟原本寫在 `CODEX-REVIEW.md`，而 AGENTS.md 有 13 處叫**任何人**照它做——\n'
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
 * **允許提到舊檔名的地方**——每一處都要有理由（比照 #384 的 exempt：豁免必須有名有姓）。
 * ⚠️ 這是宣告，不是推導：允許「解釋改名歷史」，不允許「還指著它當現行文件」。
 */
const HISTORICAL_MENTIONS = {
  '審查與合併程序.md': '檔頭要說明自己原本叫什麼、為什麼改名',
  'test/doc-naming.test.js': '這支考題自己要提到舊名才講得清楚',
};

test('⭐ 改名之後不可以有死連結（只有宣告過的地方可以提到舊名）', () => {
  // ⚠️ 改名最常見的失敗不是改錯，是**有地方沒跟著改**——那會變成一條指不到的連結。
  // ⚠️ 只看**追蹤中的檔案**：未追蹤檔（本機工具、暫存）不是 repo 的一部分。
  const stale = trackedFiles().filter((f) => /\.(md|js|yml|yaml)$/.test(f)
    && !Object.hasOwn(HISTORICAL_MENTIONS, f)
    && read(f).includes('CODEX-REVIEW'));
  assert.deepEqual(stale, [],
    `這些檔案還指著已改名的 CODEX-REVIEW.md：\n${stale.map((f) => `  ・${f}`).join('\n')}\n`
    + '⚠️ 改名最常見的失敗不是改錯，是**有地方沒跟著改**。\n'
    + '   如果那一處是刻意保留的歷史說明，請加進 HISTORICAL_MENTIONS 並寫理由。');
});

test('檔案真的存在（宣告的每一份都要在）', () => {
  for (const file of Object.keys(DOCS)) {
    assert.ok(existsSync(join(ROOT, file)), `DOCS 宣告了「${file}」但檔案不存在`);
  }
});
