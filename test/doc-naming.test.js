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
  // 檔案 → { 允許出現幾次, 為什麼 }
  //
  // ⚠️ **是「次數」不是「整檔放行」**（Codex #387 r1 High②）：
  //    上一版把整個檔案豁免掉，於是在這兩個檔裡**再加一條真的死連結也全綠**。
  //    豁免要窄到「剛好夠用」——多一次就紅，逼人回來說明為什麼又多一處。
  'REVIEW-AND-MERGE.md': { times: 1, why: '檔頭要說明自己原本叫什麼、為什麼改名' },
  'test/doc-naming.test.js': { times: 5, why: '這支考題自己要提到舊名才講得清楚' },
  'test/fixtures/review-verdict-corpus.json': {
    times: 1,
    why: '25 份審查報告的**原文**，寫於改名之前——那是歷史紀錄，改掉就不是原文了',
  },
};

test('⭐ 改名之後不可以有死連結（只有宣告過的地方可以提到舊名）', () => {
  // ⚠️ 改名最常見的失敗不是改錯，是**有地方沒跟著改**——那會變成一條指不到的連結。
  // ⚠️ 只看**追蹤中的檔案**：未追蹤檔（本機工具、暫存）不是 repo 的一部分。
  // ⚠️ **副檔名清單要含 `.json`**（Codex #387 r1）：語料 fixture 裡的舊名原本整個繞過掃描——
  //    「靠副檔名決定要不要看」等於讓沒列到的格式自動免疫。
  const scanned = trackedFiles().filter((f) => /\.(md|js|json|yml|yaml)$/.test(f));
  const problems = [];
  for (const f of scanned) {
    const n = (read(f).match(/CODEX-REVIEW/g) || []).length;
    const allowed = HISTORICAL_MENTIONS[f]?.times ?? 0;
    if (n > allowed) {
      problems.push(`${f}：出現 ${n} 次，只允許 ${allowed} 次`
        + (allowed ? `（理由：${HISTORICAL_MENTIONS[f].why}）` : ''));
    }
  }
  assert.deepEqual(problems, [],
    `這些檔案提到已改名的 CODEX-REVIEW.md 的次數超過宣告：\n`
    + `${problems.map((x) => `  ・${x}`).join('\n')}\n`
    + '⚠️ 改名最常見的失敗不是改錯，是**有地方沒跟著改**。\n'
    + '   如果那一處是刻意保留的歷史說明，請調整 HISTORICAL_MENTIONS 的次數並寫理由。');
  // ⚠️ **沒用到的豁免要當場刪掉**：留著的話，下次真的多出一處死連結時它會靜靜吸收掉。
  for (const [f, spec] of Object.entries(HISTORICAL_MENTIONS)) {
    const n = scanned.includes(f) ? (read(f).match(/CODEX-REVIEW/g) || []).length : 0;
    assert.equal(n, spec.times,
      `HISTORICAL_MENTIONS 宣告「${f}」有 ${spec.times} 次舊名，實際 ${n} 次。\n`
      + '⚠️ 豁免要剛好夠用——多的額度會在下次真的漏改時把它吸收掉，不會有人發現。');
  }
});

test('⭐ 新增的檔名一律用英文（William 2026-08-03 定）', () => {
  // ⚠️ **只管根目錄與 `test/`**——`docs/` 底下還有 24 個既有中文檔名（含三份領域契約），
  //    那是另一件事，要改的話得連 AGENTS 的 36 條索引連結一起動，應該獨立成一支 PR。
  //    這一題先把**新增的**擋住，不讓中文檔名繼續長出來。
  const cjk = /[\u4e00-\u9fff]/u;
  const scope = trackedFiles().filter((f) => !f.includes('/') || f.startsWith('test/'));
  const bad = scope.filter((f) => cjk.test(f));
  assert.deepEqual(bad, [],
    `這些檔名有中文：\n${bad.map((f) => `  ・${f}`).join('\n')}\n`
    + '⚠️ 檔名一律用英文（William 2026-08-03 定）。中文檔名在 shell、git、URL 裡都要跳脫，\n'
    + '   `git status` 會印成 `\\346\\234\\210…` 那種看不懂的八進位，出事時很難對照。');
});

test('檔案真的存在（宣告的每一份都要在）', () => {
  for (const file of Object.keys(DOCS)) {
    assert.ok(existsSync(join(ROOT, file)), `DOCS 宣告了「${file}」但檔案不存在`);
  }
});
