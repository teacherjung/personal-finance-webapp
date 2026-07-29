// @ts-check
// 合併程序的文件一致性考題（2026-07-30）。
//
// 病因：「堆疊 PR 不可用 `--delete-branch`」這條規則從 2026-07-10 就寫在 AGENTS.md，
// 但**真正被照著執行的檔案是 `CODEX-REVIEW.md`**，而那裡寫的是無條件的
// 「`gh pr merge <N> --squash --delete-branch`（**一律** Squash and merge）」，一個字都沒提例外。
// 規則在一個檔案、執行在另一個檔案 ⇒ 規則等於不存在。實際後果兩次，畫面上都是「Merged」＋CI 全綠、零錯誤訊息：
//   ・2026-07-10 #3/#5 被 `--delete-branch` 連帶關閉
//   ・2026-07-28 #311/#312 各自合進自己的 base，main 只拿到最底層那支
//
// 誠實劃界（照 deploy-config.test.js 的慣例）：這是**靜態考題**。
// 它證明得了「repo 裡寫的合併程序自帶堆疊閘」，證明不了「執行的人真的跑了那道檢查」。
// 但**把例外從執行檔案裡「簡化」掉**這個最常見的失誤，這裡擋得住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 抓出 CODEX-REVIEW.md 裡「合併由 Codex 代執行」那個 blockquote 區塊。
 * 只認以 `>` 開頭的連續行——避免把後面的正文一起吃進來當成「有寫到」。
 * @param {string} md
 */
function mergeBlock(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith('>') && l.includes('合併') && l.includes('Codex 代執行'));
  assert.notEqual(start, -1, 'CODEX-REVIEW.md 找不到「合併由 Codex 代執行」的區塊——合併程序被搬走或改寫了，這道考題要跟著更新');
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].startsWith('>')) end++;
  return lines.slice(start, end + 1).join('\n');
}

test('合併程序：CODEX-REVIEW 的合併步驟必須自帶「堆疊 PR」機械檢查', () => {
  const block = mergeBlock(read('CODEX-REVIEW.md'));

  // 這一條是**承重**的斷言：`baseRefName` 只出現在真正的檢查指令裡，
  // 不會出現在解釋病因的文字中。把檢查步驟刪掉、只留敘述，這裡就會紅。
  assert.ok(
    block.includes('baseRefName'),
    '合併步驟裡沒有用 `gh pr list ... baseRefName` 查「本支是不是別支 PR 的基底」的指令。'
      + '光寫「注意堆疊 PR」不算——判斷失敗過兩次，必須是可機械執行的檢查。'
  );
  assert.ok(
    block.includes('gh pr list'),
    '堆疊檢查必須是可以直接複製執行的 `gh pr list` 指令，不是要人自己回想有沒有堆疊'
  );

  // `--delete-branch` 可以留（非堆疊時本來就該刪分支），但必須是**有條件**的。
  if (block.includes('--delete-branch')) {
    assert.ok(
      block.includes('堆疊'),
      '合併步驟寫了 `--delete-branch` 卻沒有提到堆疊 PR 例外——'
        + '刪基底分支會讓上層 PR 被 GitHub 直接關閉為 MERGED 且無法重開（2026-07-10 #3/#5 實際發生）'
    );
    assert.ok(
      /僅限|例外|非堆疊|不可/.test(block),
      '`--delete-branch` 必須明寫適用條件（僅限非堆疊），不可維持「一律」的無條件寫法'
    );
  }
});

test('合併程序：AGENTS 的堆疊規則要指向 CODEX-REVIEW 的機械檢查（跨檔指標不可死掉）', () => {
  const agents = read('AGENTS.md');
  const idx = agents.indexOf('堆疊 PR（base 指向另一個 PR 分支）合併時');
  assert.notEqual(idx, -1, 'AGENTS.md 找不到堆疊 PR 的 `--delete-branch` 規則');

  // 只看該規則往後一小段，避免掃到全檔其他地方剛好提過 CODEX-REVIEW.md
  const near = agents.slice(idx, idx + 800);
  assert.ok(
    near.includes('CODEX-REVIEW.md'),
    'AGENTS 的堆疊規則沒有指向 CODEX-REVIEW.md 的機械檢查。'
      + '規則寫在這裡、執行的人卻讀另一份檔案——那正是這條規則失效十九天的原因'
  );
});

test('合併程序：PROJECT 的「勾 delete branch」不可寫成無條件', () => {
  const project = read('PROJECT.md');
  const idx = project.indexOf('delete branch');
  if (idx === -1) return; // 那句被拿掉了也可以，這裡只擋「留著但沒有例外」
  const near = project.slice(Math.max(0, idx - 200), idx + 400);
  assert.ok(
    near.includes('堆疊'),
    'PROJECT.md 的合併寫法提到「勾 delete branch」卻沒提堆疊例外——三份文件必須一致，不然又是一次規則漂移'
  );
});
