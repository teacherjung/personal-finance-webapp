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
 * ⚠️ **兩邊的讀法不一樣，因為兩邊的檔案性質不一樣**：
 *   - `.gitignore` 是純文字 ⇒ 讀文字（去掉註解與空行）。
 *   - `eslint.config.js` 是 **JavaScript** ⇒ **import 進來讀真正的值，不解析文字**。
 *     這是 Codex #387 r5 逼出來的：上一版用正則抽 `'…'`／`"…"`，把樣式寫成
 *     **反引號模板字串**就整個繞過去。看文字就得列舉寫法，看結果就不必。
 *
 * ⚠️ **這道閘抓不到什麼（誠實劃界）**：
 *   - 它只看這兩個檔案。死程式碼**沒有**被忽略、大方躺在 `lib/` 裡，這道閘看不見
 *     （那是人的判斷，AGENTS.md 的規則管，本檔不假裝能機械判斷）。
 *   - 它不判斷豁免「合不合理」，只判斷**有沒有人偷偷改**。理由要人寫在下面的註解裡。
 *   - `.gitignore` 只比對 repo 根目錄這一份；子目錄若另有 `.gitignore`，本檔看不到。
 *   - `.git/info/exclude`、`core.excludesFile` 這種**不在版控裡**的忽略機制看不到，
 *     也不打算看——repo 的考題只能對 repo 裡的東西作保證（Codex #387 r5 同意這樣劃界）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * ESLint 的 `ignores` 有**兩種意思**，本考題按設定檔順序逐組宣告：
 *   ①「整組只有 ignores」＝**全域**不糾察，那些檔案 ESLint 完全不看（最危險的藏身處）。
 *   ②「跟 files 同一組」＝只是**那一組規則**不適用，檔案本身照樣被糾察（危險度低，但仍是例外）。
 * 兩者的差別是 ESLint 自己定的（「只有 ignores、沒有別的鍵」才是全域），所以 `全域` 這欄
 * 也要宣告——把第二組偷偷改成全域，也是一種開藏身處。
 *
 * ⚠️ 我第一版只讀第一組、還在訊息裡叫人「把豁免收攏成一組」——那是錯的建議：
 *    兩種意思不能合併，而漏讀第二組就是個看不見的洞（本考題第一次跑就抓到自己這個毛病）。
 */
const ALLOWED_ESLINT_IGNORES = [
  { 用途: '全域不糾察（ESLint 完全不看這些檔案）', 全域: true,
    patterns: [
      'node_modules/**',      // 別人的程式碼
      'public/vendor/**',     // 別人的程式碼
      'data/**',              // 資料檔，不是程式碼
    ] },
  { 用途: 'xlsx 引入限制的例外（檔案照樣被糾察，只是這條規則不適用）', 全域: false,
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

test('eslint.config.js 的每一組豁免都跟宣告清單一字不差', async () => {
  // ⚠️ **這裡刻意不解析原始碼文字**（Codex #387 r5 Medium）：
  //    上一版用正則抽 `'…'` 與 `"…"` 兩種字串，於是把 `retired/**` 寫成
  //    **反引號模板字串**就整個繞過去，考題照樣 2/2 全綠——
  //    **又一次列舉：我列了兩種寫字串的方式，而 JS 有三種**（還不算變數、
  //    字串相接、`...` 展開、`.concat()`…）。
  //    正解是**不看文字、看結果**：把設定檔 import 進來，讀 ESLint 真正拿到的值。
  //    那些寫法全部一次收工，因為它們最後都變成同一個陣列。
  const config = (await import(pathToFileURL(join(ROOT, 'eslint.config.js')).href)).default;

  assert.ok(Array.isArray(config),
    'eslint.config.js 的 default export 不是陣列——格式變了，這道閘會靜靜失效，先修考題。');

  // ESLint 的規矩：**整組只有 `ignores` 一個鍵**才是「全域忽略」；跟 `files` 等鍵放在一起
  // 就只是那一組規則的例外。把第二組偷偷改成全域也是一種開藏身處，所以這欄一起比對。
  const groups = config
    .filter((c) => c && Array.isArray(c.ignores))
    .map((c) => ({ 全域: Object.keys(c).length === 1, patterns: c.ignores }));

  assert.ok(groups.length > 0,
    'eslint.config.js 裡找不到任何 `ignores`——格式變了，這道閘會靜靜失效，先修考題。');

  assert.deepEqual(groups, ALLOWED_ESLINT_IGNORES.map((g) => ({ 全域: g.全域, patterns: g.patterns })),
    'ESLint 的豁免清單跟本考題宣告的不一致（含組數、順序、是不是全域）。\n'
    + '本考題宣告的是：\n'
    + ALLOWED_ESLINT_IGNORES.map((g, i) =>
      `  ${i + 1}. ${g.用途}${g.全域 ? '【全域】' : '【只影響該組規則】'}：${g.patterns.join('、')}`).join('\n')
    + '\n⛔ **不可以對「退役／封存資料夾」開豁免**：糾察照不到那裡，\n'
    + '   「藏起來」在機制上就變得比「刪掉」容易（2026-08-03 加過 `retired/**`，Codex #387 r4 拆掉）。\n'
    + '   合法的新豁免（例如又一批第三方程式碼）請加進 ALLOWED_ESLINT_IGNORES 並註明理由與用途。');
});
