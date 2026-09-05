// @ts-check
// `lib/git-env.js` 的考題。**這一支只守純函式本身**；「每一個呼叫端真的走了它」是**行為題**，
// 貼在各自那一支（拿掉 `env:` 那一行，對應的行為題必須紅）：
//   ・`test/worktree-integrity.test.js`   ← 體檢腳本 `scripts/check-worktree-integrity.js`
//   ・`test/xlsx-isolate.test.js`         ← `productionFiles()`
//   ・`test/hosted-store-pg.test.js`      ← `libFiles()`
//   ・`test/hosted-auth.test.js`          ← `trackedFiles()`（secret 掃描的清單）
//   ・`test/doc-naming.test.js`           ← `trackedFiles()`／`oldNameContexts()`
//   ・`test/cross-pr-merge.test.js`       ← `scripts/check-cross-pr-merge.js` 的 `runIn()`
//                                          ＋**會叫 `gh` 的閘**（不寫死幾支）（`gh` 會自己再去 spawn git）
//   ・`test/acceptance-tier.test.js`      ← `scripts/acceptance-tier.js` 的 `originRepo()`＋它叫的 `gh`；考題自己的 `trackedFiles()`
// ⚠️ 為什麼要分開：純函式對了，不代表有人在用它。本專案認過這個病型
// （護欄什麼都沒做卻回報通過），所以兩層都要有題。
// ⚠️ 而且每個呼叫端要**兩種**題（#463 r1 的教訓，射程對照表在 `test/helpers/dirty-git-env.js` 檔頭）：
//    ①「答案仍然正確」＝**代理指標**，只涵蓋「剛好會改變這個指令的變數」——光靠它，
//      把清法退化成「只刪 `GIT_DIR`」的列名版仍會全綠（**我自己做過一次這種假綠**）。
//    ②「子行程實際收到什麼」＝**直接斷言**，未來冒出沒人見過的家族也涵蓋得到。
//
// **例外：shell 那兩份的題就在本檔下半部**（`scripts/git-hooks/pre-push`、`mutate.sh`）。
// 它們不經過 Node ⇒ `gitEnv()` 完全管不到，是**另外兩份實作**；放在這裡是為了讓「這條規矩
// 一共有幾份實作」一眼看得完。⚠️ pre-push 另有一題**真的跑一次整支 hook**
// （在 `test/worktree-integrity.test.js`），那一題管的是關卡順序與 fail-closed，射程不同。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitEnv } from '../lib/git-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('⭐ 按 GIT_ 前綴整族清：沒列過名的也要走，非 GIT_ 前綴不受傷', () => {
  const cleaned = gitEnv({
    PATH: '/usr/bin', LANG: 'zh_TW.UTF-8', GITHUB_TOKEN: 'keep-me',
    GIT_DIR: '/fake', GIT_WORK_TREE: '/fake', GIT_PREFIX: 'x',
    // 這一族是列名補不完的證據：`git -c` 會生出來、名單永遠追不上。
    GIT_CONFIG_PARAMETERS: "'a.b=c'", GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b',
    GIT_BOGUS_FUTURE_THING: 'unlisted',   // 未來才會出現的名字＝前綴關門存在的理由
  });
  for (const key of Object.keys(cleaned)) {
    assert.ok(!key.startsWith('GIT_'), `${key} 沒被清掉——前綴這扇門有縫`);
  }
  assert.equal(cleaned.PATH, '/usr/bin', 'PATH 被清掉的話 git 執行檔就找不到，全部呼叫端一起紅');
  assert.equal(cleaned.LANG, 'zh_TW.UTF-8', '不該動到無關的變數');
  assert.equal(cleaned.GITHUB_TOKEN, 'keep-me',
    'GITHUB_* 不是 GIT_ 前綴（第四個字元是 H 不是底線），不可以被誤殺——CI 環境靠它');
});

test('HOME 刻意留著（誠實劃界：清了也關不起來，見 lib/git-env.js）', () => {
  // ⚠️ 這一題釘的是**刻意的取捨**，不是疏漏。`~/.gitconfig` 的 core.excludesFile 確實是一條
  //    影響 ignore 規則的通道，但同族的 `.git/info/exclude` 是固定路徑、連 `git -c` 都蓋不掉
  //    ⇒ 清 HOME 只買得到部分保護，代價是多一個入口讓呼叫端挑錯。
  //    哪天決定要清，請連同 `lib/git-env.js` 的劃界一起改，並回答「未追蹤檔那一族怎麼辦」。
  assert.equal(gitEnv({ HOME: '/Users/x' }).HOME, '/Users/x');
});

// ── shell 那兩份 ─────────────────────────────────────────────────────────────
// ⚠️ `gitEnv()` 管不到 shell：`scripts/git-hooks/pre-push` 與 `mutate.sh` 各自有一行同語意的
//    `unset` 迴圈（hook 由 git 直接執行、mutate.sh 是 zsh 腳本，兩者都不經過 Node）。
//    ⇒ 那兩行是**另外兩份實作**，必須自己有題，否則「清乾淨了」在 shell 那半邊是沒人證明的。
/** @type {{rel: string, why: string}[]} */
const SHELL_COPIES = [
  { rel: 'scripts/git-hooks/pre-push', why: 'git 直接執行它，而且它會跑 npm test（整套考題的環境從這裡來）' },
  { rel: 'mutate.sh', why: '它的每一道保護都建立在 git status 上——量錯樹＝防假綠的工具自己假綠' },
];

/** 從 shell 檔裡取出那一行 unset 迴圈。@param {string} rel */
function unsetLineOf(rel) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  const line = lines.find((l) => l.startsWith('for _gitvar in '));
  assert.ok(line, `${rel} 找不到清 GIT_* 的那一行迴圈——它是 AGENTS.md 鐵則 11 在 shell 這半邊的落點`);
  return line;
}

/**
 * 這一行要在**哪些 shell 底下**驗。
 *
 * ⚠️⚠️ **不可以只挑那支腳本 shebang 上的那一個**（2026-08-15 CI 實測打臉）：上一版照
 *    `mutate.sh` 的 `#!/bin/zsh` 去挑 `/bin/zsh`，在 macOS 永遠綠、**在 CI（Ubuntu，沒有 zsh）
 *    永遠紅**——而且 `spawnSync` 拿不到執行檔時 `status` 是 `undefined`，訊息只會說
 *    「跑不起來：undefined」，看的人根本不知道是機器上沒有那支 shell。
 *    這正是本專案 #417 的病型：**開發者機器上綠，不代表別的機器上綠**。
 * ⇒ 改成「這台機器上**有**的都跑一遍」。那一行是 POSIX 寫法，三種 shell 都該成立
 *   （分詞規則在 zsh 與 sh 不同，所以有 zsh 的機器上一定要跑到它——`mutate.sh` 實際只在
 *   William 的 Mac 上執行，那台一定有）。
 * ⚠️ **誠實劃界**：沒有 zsh 的機器（CI）驗不到 zsh 的分詞語意，那一格由 macOS 這邊守。
 */
const CANDIDATE_SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh'];

for (const { rel, why } of SHELL_COPIES) {
  test(`⭐ ${rel} 的清法真的清得掉（行為題：拿真的 shell 跑那一行）`, () => {
    // ⚠️ **只跑那一行，不跑整支腳本**：mutate.sh 會真的突變檔案，考題不可以去碰它。
    //    ⇒ 誠實劃界：本題證明「那一行有效」，**不證明**它在腳本裡的位置對
    //      （位置由題名關鍵字「mutate.sh 必須先清 GIT_*」那題單獨釘；pre-push 的位置由
    //       `test/worktree-integrity.test.js` 實際跑一次 hook 驗）。
    const shells = CANDIDATE_SHELLS.filter((s) => existsSync(s));
    assert.ok(shells.length > 0,
      `這台機器上 ${CANDIDATE_SHELLS.join('／')} 一個都沒有 ⇒ 本題無法下判斷，不可以當成通過`);
    const probe = `${unsetLineOf(rel)}\nenv | grep '^GIT_' | cut -d= -f1 | tr '\\n' ' '\n`
      + 'printf ":: gh=%s" "${GITHUB_TOKEN:-MISSING}"\n';
    for (const shell of shells) {
      const r = spawnSync(shell, ['-c', probe], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          GIT_DIR: '/fake', GIT_WORK_TREE: '/fake',
          // 沒列過名的一族（`git -c` 生出來、會長）——列名的清法會在這裡漏網
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/fake',
          GIT_BOGUS_FUTURE_THING: 'unlisted',
          GITHUB_TOKEN: 'keep-me',
        },
      });
      assert.equal(r.status, 0,
        `${shell} 跑不起來那一行（status=${r.status}／error=${r.error?.message ?? '無'}）：${r.stderr}`);
      const [leftover, gh] = String(r.stdout).split('::');
      assert.equal(leftover.trim(), '',
        `${rel} 的清法在 ${shell} 底下還留著：${leftover.trim()}\n理由：${why}`);
      assert.equal(gh.trim(), 'gh=keep-me',
        `${rel} 在 ${shell} 底下把 GITHUB_TOKEN 也殺了——前綴寫成 GIT 而不是 GIT_ 就會這樣，CI 靠它`);
    }
  });
}

test('shell 的兩份清法逐字相同（防兩邊各改各的）', () => {
  // ⚠️ 誠實劃界：這是**字面比對**，射程只到「兩行有沒有漂開」。
  //    「真的清得掉」由上面兩題各自用跑的驗，這裡不重複宣稱。
  const [a, b] = SHELL_COPIES.map((c) => unsetLineOf(c.rel));
  assert.equal(a, b,
    `${SHELL_COPIES[0].rel} 與 ${SHELL_COPIES[1].rel} 的清法不一致了。\n`
    + '兩邊各改各的＝其中一邊會停在舊語意，而它照樣看起來有在清。');
});

test('⭐ mutate.sh 必須先清 GIT_*、才輪到它的 git status 檢查', () => {
  // ⚠️ 順序就是這一題的全部：那些 `git status --porcelain` 是它「開跑前樹乾淨／還原後沒殘留」
  //    兩道斷言的底料。清在後面的話，第一次 status 已經量了別棵樹——**保護措施要先於它保護的動作生效**
  //    （同一個順序教訓，該檔檔頭記著它 2026-08-03 親手踩過一次）。
  // ⚠️ **先去掉註解**（鐵則 9；本題第一版就栽在這裡）：這個檔案的說明文字裡本來就寫著
  //    `git status --porcelain`，不剝註解的話比到的是**註解**、不是程式，於是永遠判定「順序錯了」
  //    ——一條永遠紅的假紅，會逼下一個人把護欄關掉。射程劃界：只剝**整行註解**，
  //    行尾註解不剝（本檔沒有把這兩個字樣寫在行尾註解裡的情形；真有的話這題會誤判，請回來改）。
  const lines = readFileSync(join(ROOT, 'mutate.sh'), 'utf8').split('\n')
    .map((l) => (l.trimStart().startsWith('#') ? '' : l));
  const unsetAt = lines.findIndex((l) => l.startsWith('for _gitvar in '));
  const statusAt = lines.findIndex((l) => l.includes('git status --porcelain'));
  assert.notEqual(unsetAt, -1, 'mutate.sh 沒有清 GIT_* 的那一行');
  assert.notEqual(statusAt, -1, 'mutate.sh 找不到 git status --porcelain——本題的前提沒了，請重寫');
  assert.ok(unsetAt < statusAt,
    'mutate.sh 的第一句 git status 跑在清 GIT_* 之前 ⇒ 它可能量的是別棵樹，'
    + '而「工作樹乾淨」與「還原後沒殘留」這兩道斷言就都不成立了。');
});

test('不帶參數時讀 process.env，而且不動到原本那一份', () => {
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = '/fake-for-this-test';
  try {
    assert.equal('GIT_DIR' in gitEnv(), false, '預設參數沒接到 process.env ⇒ 呼叫端以為清了其實沒清');
    assert.equal(process.env.GIT_DIR, '/fake-for-this-test',
      'gitEnv() 動到了 process.env 本尊——它必須回傳新的一份，否則會波及同行程的其他考題');
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
});
