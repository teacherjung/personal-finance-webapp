// @ts-check
// 回歸考題：**HTML 屬性裡的 id 一律要過 `esc()`**（鐵則 3 的一個具體缺口，2026-07-28 修）。
//
// 病根：還原備份時，備份檔裡的 `id` 是**刻意原樣保留**的（lib/schema.js 的 FIELD_SCHEMA 不驗 id，
// 註解明寫「其餘含 id 原樣保留」——不然還原就不忠實了）。但六個頁面把那個 id 直接插進
// `data-edit="…"` 這類屬性而沒有消毒，於是一個像
//   `"><img src=x onerror="…"><button data-tail="`
// 的 id 會提前關掉屬性、把 `<img>` 變成真正的元素——`innerHTML` 插入 `<img onerror>` 會**立刻執行**。
//
// 為什麼嚴重：全站沒有 CSP，那段程式碼是用「這一頁的身分」跑的，可以去讀 `/api/db`
//（裡面有卡片的 pdfPassword＝身分證字號、settings.ib.flexToken＝IBKR 憑證）再送出去；
// 而且它**存在資料裡**，每次打開那一頁都會再跑一次。
//
// 為什麼修在**渲染端**而不是匯入端：`lib/schema.js` 有一段刻意寫下的裁決——「異常輸入防線刻意不驗匯入，
// 合法舊資料不可因升級被刪」。在匯入端改寫或拒收 id 會撞上那條原則，也會撞
// `test/server.test.js` 那票「export→import 原樣保留」的考題。渲染端消毒沒有這些副作用：
// `uid()` 產出的真實 id 只有 `[0-9a-z-]`，`esc()` 對它們是 no-op，畫面一個像素都不會變。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');

/** 遞迴列出 public/ 底下所有 .js。 @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('全站掃描：HTML 屬性值裡不得有「未消毒的 id」（下一個人加新頁面時也會被抓到）', () => {
  // 只找「屬性值＝某物件的 .id」這一類；querySelector 之類的 JS 字串不在此列（那不是 HTML）。
  const risky = /="\$\{\s*(?!esc\(|h\.e\()[^}]*\.id\b[^}]*\}"/;
  /** @type {string[]} */
  const hits = [];
  for (const file of jsFiles(PUBLIC_DIR)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (risky.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], `這些地方把 id 直接插進 HTML 屬性、沒有過 esc()：\n${hits.join('\n')}`);
});

test('六個修過的頁面確實都用了 esc(x.id)（避免有人「修好又改回去」）', () => {
  const expected = {
    'public/modules/cards.js': 2,
    'public/modules/subscriptions.js': 5,
    'public/modules/insurance.js': 2,
    'public/modules/transactions.js': 3,
    'public/modules/cashflow.js': 2,
    'public/modules/assets.js': 4,
  };
  for (const [file, count] of Object.entries(expected)) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const found = (text.match(/="\$\{esc\([A-Za-z_$][A-Za-z0-9_$]*\.id\)\}"/g) || []).length;
    assert.ok(found >= count, `${file} 只找到 ${found} 處 esc(x.id)，應至少 ${count} 處`);
  }
});

test('esc() 真的擋得住這個 payload（驗的是 app.js 裡跑在正式環境的那一行）', () => {
  // 直接 import public/app.js 會失敗（它是瀏覽器模組、模組頂層就碰 document），
  // 所以把那一行原始碼抓出來現場跑——**驗到的是正式環境真正用的實作**，不是另外抄一份。
  const appSrc = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const line = appSrc.split('\n').find(l => l.includes('export const esc'));
  assert.ok(line, 'app.js 找不到 esc 的定義（改名了？那要一起更新本考題）');
  const esc = /** @type {(s: any) => string} */ (
    new Function(`${String(line).replace('export const', 'const')}; return esc;`)());

  // Codex（gpt-5.6-sol）重審時實際重現用的那一串
  const payload = '"><img src=x onerror="document.body.dataset.x=1"><button data-tail="';
  const html = `<button data-edit="${esc(payload)}" title="編輯"></button>`;
  assert.ok(!html.includes('<img '), '消毒後不可以還有真正的 <img> 元素');
  assert.ok(!/onerror=/.test(html.replace(/&quot;/g, '')) || !html.includes('<img'), '不可以出現可執行的 onerror 元素');
  assert.match(html, /&lt;img src=x/, '角括號要被轉成實體');
  assert.match(html, /&quot;/, '雙引號要被轉成實體（否則提前關掉屬性）');

  // 真實 id（uid() 產的）過 esc 之後必須**一模一樣**——這條保證畫面零變化、既有考題不會壞
  for (const realId of ['ms3fzgxn-1', 'abc123-9', '2026-07-01']) {
    assert.equal(esc(realId), realId, `真實 id「${realId}」不該被 esc 改動`);
  }
});
