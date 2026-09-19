// @ts-check
// settings.json 的 checks.mainWorktree／checks.indexAnchors（套件三關執行器 tools/run-checks.js 的兩個選填登記）釘值題——
// 2026-09-19 從套件 87e4edb 同步時加。
// 為什麼要有這一題：套件的執行器對這兩格是寬的——拿掉或改回「未設定」＝不驗、照舊放行，只在全綠那一行說哪幾項沒驗；
//   推送前鉤子與雲端都不會因此紅。本專案登記它們，是為了讓套件那支也擋住本專案那支工作樹體檢
//   （scripts/check-worktree-integrity.js）擋得住的四種壞法（William 2026-09-19 裁 a：
//   https://github.com/teacherjung/personal-finance-webapp/pull/617#issuecomment-5739129893 ），所以值被改掉只有這一題會紅。
// 錨點跟那支工作樹體檢的 REQUIRED_TRACKED 逐項相同：兩支一起跑的期間兩邊不會漂；拿掉那一支時改成釘字面清單。
// ⚠️ 證不到的：執行器真的照這兩格驗（那是套件 tests/run-checks.test.js ⑩⑪ 的射程）；這三個檔在最新提交裡存在
//   （推送前鉤子與雲端每次跑執行器時會驗）。
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
