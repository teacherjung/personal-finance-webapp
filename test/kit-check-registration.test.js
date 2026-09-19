// @ts-check
// settings.json 的 checks.mainWorktree／checks.indexAnchors（套件三關執行器 tools/run-checks.js 的兩個選填登記）釘值題——
// 2026-09-19 從套件 87e4edb 同步時加。
// 為什麼要有這一題：套件的執行器本身允許這兩格寫「未設定」或拿掉（＝不驗、照舊放行，只在全綠那一行說哪幾項沒驗）。
//   本專案登記它們，是為了讓套件那支也擋住本專案那支工作樹體檢（scripts/check-worktree-integrity.js）擋得住的四種壞法
//   （William 2026-09-19 裁 a：https://github.com/teacherjung/personal-finance-webapp/pull/617#issuecomment-5739129893 ）。
//   這一題直接釘住本專案必須登記的值。套件的設定考題（tests/settings.test.js）只驗形狀與產物一致：連同產物（PROJECT-SETTINGS.md）
//   一起改回「未設定」時它照樣綠（2026-09-19 #621 r1 實測；只改 settings.json 不重產的話，產物一致那一題會紅），擋得住的是這一題。
// 錨點跟那支工作樹體檢的 REQUIRED_TRACKED 逐項相同：兩支一起跑的期間兩邊不會漂；拿掉那一支時改成釘字面清單。
// ⚠️ 證不到的：執行器真的照這兩格驗（那是套件 tests/run-checks.test.js ⑩⑪ 的射程）。執行器前後驗的是這三個檔
//   在不在跑三關那棵樹的**索引**裡（HEAD 解析得到時），不保證它們已經提交（只暫存的也算在）——照套件執行器既有的劃界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_TRACKED } from '../scripts/check-worktree-integrity.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const checks = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8')).checks;

test('主目錄布局登記＝「一般工作樹」（本專案的主目錄是一般 checkout，不是裸儲存庫）', () => {
  assert.equal(checks?.mainWorktree, '一般工作樹',
    `settings.json 的 checks.mainWorktree 不是「一般工作樹」：${JSON.stringify(checks?.mainWorktree)}——改回「未設定」或拿掉＝套件執行器不再問主目錄打不打得開`);
});

test('索引錨點＝工作樹體檢的 REQUIRED_TRACKED（逐項、同順序）', () => {
  assert.deepEqual(checks?.indexAnchors, REQUIRED_TRACKED,
    `settings.json 的 checks.indexAnchors 跟 scripts/check-worktree-integrity.js 的 REQUIRED_TRACKED 不同：${JSON.stringify(checks?.indexAnchors)}`);
});
