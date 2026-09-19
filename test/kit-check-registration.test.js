// @ts-check
// settings.json 的 checks.mainWorktree／checks.indexAnchors（套件三關執行器 tools/run-checks.js 的兩個選填登記）釘值題——
// 2026-09-19 從套件 87e4edb 同步時加。
// 為什麼要有這一題：套件的執行器本身允許這兩格寫「未設定」或拿掉（＝不驗、照舊放行，只在全綠那一行說哪幾項沒驗）。
//   本專案登記它們，是為了讓套件那支也擋住本專案原本那支工作樹體檢擋得住的四種壞法
//   （William 2026-09-19 裁 a：https://github.com/teacherjung/personal-finance-webapp/pull/617#issuecomment-5739129893 ）。
//   兩支不是逐一等價：差異照套件 ai-collab-kit issue #6 本文事先寫好的期待表（那支多擋的幾種、套件守不到的幾種）。
//   本專案那支 2026-09-20 照 William 裁 a 拿掉（https://github.com/teacherjung/personal-finance-webapp/pull/622#issuecomment-5743466843 ），
//   現在三關前後只剩套件那一道：這兩格改回「未設定」，套件執行器就不問主目錄、也不驗錨點（原本還有本專案那支在擋）。
//   這一題直接釘住本專案必須登記的值。套件的設定考題（tests/settings.test.js）只驗形狀與產物一致：連同產物（PROJECT-SETTINGS.md）
//   一起改回「未設定」時它照樣綠（2026-09-19 #621 r1 實測；只改 settings.json 不重產的話，產物一致那一題會紅），擋得住的是這一題。
// 錨點釘字面清單（逐項、同順序）：這三個檔一定在版控裡（package.json＝相依套件與指令、AGENTS.md＝規則書、server.js＝App 入口），
//   登記它們＝要執行器在索引被清空或少了其中一筆時擋下。原本跟本專案那支工作樹體檢的錨點清單對帳，那支刪掉之後改成直接寫在這裡。
// ⚠️ 證不到的：執行器真的照這兩格驗（那是套件 tests/run-checks.test.js ⑩⑪ 的射程）。執行器前後驗的是這三個檔
//   在不在跑三關那棵樹的**索引**裡（HEAD 解析得到時），不保證它們已經提交（只暫存的也算在）——照套件執行器既有的劃界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const checks = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8')).checks;

test('主目錄布局登記＝「一般工作樹」（本專案的主目錄是一般 checkout，不是裸儲存庫）', () => {
  assert.equal(checks?.mainWorktree, '一般工作樹',
    `settings.json 的 checks.mainWorktree 不是「一般工作樹」：${JSON.stringify(checks?.mainWorktree)}——改回「未設定」或拿掉＝套件執行器不再問主目錄打不打得開`);
});

/** 索引錨點：本專案一定在版控裡的三個檔（字面清單；理由見檔頭）。 */
const INDEX_ANCHORS = ['package.json', 'AGENTS.md', 'server.js'];

test('索引錨點＝package.json、AGENTS.md、server.js（逐項、同順序）', () => {
  assert.deepEqual(checks?.indexAnchors, INDEX_ANCHORS,
    `settings.json 的 checks.indexAnchors 不是 ${JSON.stringify(INDEX_ANCHORS)}：${JSON.stringify(checks?.indexAnchors)}`
    + '——改回「未設定」或拿掉＝套件執行器不再驗索引有沒有被清空；要換錨點，這一題跟檔頭一起改');
});
