/**
 * 「不准有藏身處」考題（2026-08-03，Codex #387 r4 Medium 之後補）
 *
 * 病因：AGENTS.md 立了規則「沒用到的程式直接刪」，同一天我卻在 `.gitignore` 加了
 * `/retired/`、在 `eslint.config.js` 加了 `retired/**` 豁免——**一邊說不准藏，
 * 一邊把藏身處做得比刪除更順手**。規則於是變成裝飾：機制在反方向使力。
 *
 * 為什麼要做成考題而不是寫一行「別加回來」：這個專案已經證明寫著的提醒會被忘記
 * （#374／#375／#376 連三支忘掉同一條），而 #388 rebase 時 `/retired/` 就在它的樹裡，
 * 忘記拿掉是**這週就會發生**的事，不是假設。
 *
 * ⚠️ **判準是「宣告」不是「推導」**：我不列「哪些資料夾名字是壞的」——
 * `retired/`、`archive/`、`old/`、`attic/`、`_dead/` 列不完，**列舉繞法補不完**。
 * 改成把**准許的豁免逐條寫死在下面**，任何新增／改動一律轉紅，改的人被迫回答一次
 * 「這是工具／別人產生的東西，還是我自己寫的死程式碼？」——後者的答案永遠是刪掉。
 *
 * ⚠️ **這道閘抓不到什麼（誠實劃界）**：
 *   - 它只看這兩個檔案。死程式碼**沒有**被忽略、大方躺在 `lib/` 裡，這道閘看不見
 *     （那是人的判斷，AGENTS.md 的規則管，本檔不假裝能機械判斷）。
 *   - 它不判斷豁免「合不合理」，只判斷**有沒有人偷偷改**。理由要人寫在下面的註解裡。
 *   - `.gitignore` 只比對 repo 根目錄這一份；子目錄若另有 `.gitignore`，本檔看不到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 逐條宣告：每一行後面的註解要說明「為什麼這不是我寫的死程式碼」。 */
const ALLOWED_GITIGNORE = [
  'data/store.json',                    // 使用者真實資料
  'data/store.json.bak',                // 同上
  'data/store.db',                      // 同上
  'data/store.db.bak',                  // 同上
  'data/*.db',                          // 同上
  'data/*.db-wal',                      // 同上
  'data/*.db-shm',                      // 同上
  'data/store.manual-backup-*.json',    // 同上
  'data/*backup*',                      // 同上
  '*.bak',                              // 備份檔
  '.claude/settings.local.json',        // 工具產生的本機設定
  'node_modules',                       // 相依套件（別人的程式碼）
  '.codex-reviews/',                    // 審查工具的殘留輸出
  'tmp/',                               // 暫存
  'output/',                            // 產生的檔案
  '*.log',                              // 執行紀錄
  '.DS_Store',                          // macOS 產生的
  '**/.DS_Store',                       // 同上
  '/.agents/',                          // 工具產生的本機設定
  '/skills-lock.json',                  // 同上
  '/meeting.sh',                        // William 個人的檔案（他明說不收）
  '/meeting_0724_1414.md',              // 同上
];

/**
 * ESLint 的 `ignores` 有**兩種意思**，本考題按原始碼順序逐組宣告：
 *   ①「整組只有 ignores」＝**全域**不糾察，那些檔案 ESLint 完全不看（最危險的藏身處）。
 *   ②「跟 files 同一組」＝只是**那一組規則**不適用，檔案本身照樣被糾察（危險度低，但仍是例外）。
 * ⚠️ 我第一版只讀第一組、還在訊息裡叫人「把豁免收攏成一組」——那是錯的建議：
 *    兩種意思不能合併，而漏讀第二組就是個看不見的洞（本考題第一次跑就抓到自己這個毛病）。
 */
const ALLOWED_ESLINT_IGNORES = [
  { 用途: '全域不糾察（ESLint 完全不看這些檔案）',
    patterns: [
      'node_modules/**',      // 別人的程式碼
      'public/vendor/**',     // 別人的程式碼
      'data/**',              // 資料檔，不是程式碼
    ] },
  { 用途: 'xlsx 引入限制的例外（檔案照樣被糾察，只是這條規則不適用）',
    patterns: [
      'lib/statement.js',     // 唯一准許讀 xlsx 的地方（隔離子行程入口）
      'test/**',              // 考題本來就要引入被限制的東西來驗證
    ] },
];

/** 去掉註解與空行，留下真正生效的樣式。 */
function activePatterns(text) {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

test('.gitignore 的忽略樣式跟宣告清單一字不差', () => {
  const actual = activePatterns(readFileSync(join(ROOT, '.gitignore'), 'utf8'));
  assert.deepEqual(actual, ALLOWED_GITIGNORE,
    '`.gitignore` 生效的樣式跟本考題宣告的清單不一致。\n'
    + '⛔ **先回答一個問題再改這裡**：你要忽略的東西是「工具／別人產生的」，\n'
    + '   還是「我們自己寫了但沒在用的程式碼」？\n'
    + '   後者的規則是**直接刪**（AGENTS.md「沒用到的程式直接刪」），\n'
    + '   **不可以靠加一條忽略規則把它藏起來**——2026-08-03 加過 `/retired/`，\n'
    + '   等於一邊立規則說不准藏、一邊把藏身處做得比刪除更順手（Codex #387 r4）。\n'
    + '   如果答案是前者，把新的一行加進 ALLOWED_GITIGNORE 並在後面註明理由。');
});

test('eslint.config.js 的每一組豁免都跟宣告清單一字不差', () => {
  const src = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');

  // 讀**全部**的 `ignores: [...]`，按原始碼順序。少讀一組＝那一組變成看不見的洞。
  const groups = [...src.matchAll(/\bignores\s*:\s*\[([\s\S]*?)\]/g)]
    .map((m) => [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]));

  // 樣式字串裡若出現 `]`（例如字元類），上面的非貪婪比對會提早收尾 ⇒ 讀到半組。
  // 這種情況要當場停下來修考題，不可以讓它靜靜通過。
  assert.ok(!/\bignores\s*:\s*\[[^\]]*\[/.test(src),
    'eslint.config.js 的 ignores 陣列裡出現巢狀 `[`——本考題的比對會讀到半組而靜靜失效，先修考題。');
  assert.ok(groups.length > 0,
    'eslint.config.js 找不到任何 `ignores: [...]`——格式變了，這道閘會靜靜失效，先修考題。');

  assert.deepEqual(groups, ALLOWED_ESLINT_IGNORES.map((g) => g.patterns),
    'ESLint 的豁免清單跟本考題宣告的不一致（含組數與順序）。\n'
    + '本考題宣告的是：\n'
    + ALLOWED_ESLINT_IGNORES.map((g, i) => `  ${i + 1}. ${g.用途}：${g.patterns.join('、')}`).join('\n')
    + '\n⛔ **不可以對「退役／封存資料夾」開豁免**：糾察照不到那裡，\n'
    + '   「藏起來」在機制上就變得比「刪掉」容易（2026-08-03 加過 `retired/**`，Codex #387 r4 拆掉）。\n'
    + '   合法的新豁免（例如又一批第三方程式碼）請加進 ALLOWED_ESLINT_IGNORES 並註明理由與用途。');
});
