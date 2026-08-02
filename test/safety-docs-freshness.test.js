// @ts-check
// 兩份「安全判斷輸入」文件的過期考題（2026-08-02，PR #381 r2 起；r3 依 Codex r2 重寫判準）。
//
// 病因：這兩份文件不是說明書，是**做安全決策時會拿來當依據的東西**。它們一旦過期，
// 讀的人會用錯誤的前提做判斷——而畫面上完全看不出來。本輪實際抓到的失真：
//   ・XML 上限文件寫 40MB、程式是 12MB——**而 40MB 正是實測會 OOM 死掉的線**
//   ・「異常輸入防線」「每日滾動備份」標成未開工，其實 #297／#295 早就上線
//   ・環境變數文件叫 `HOSTED_MODE`、程式叫 `NOTEASY_HOSTED`
//   ・裁決①已寫「升 Pro」，成本表還停在 Free US$0
//   ・整節「留給多人化」停在只有 LOCAL 的世界，把已上線的帳號隔離寫成未來式
//
// 這支考題的分工：**只鎖「文件抄寫的數字／名字，與程式的單一真相相符」**。
// 判準刻意是「從程式抽值、代進文件比對」，不是「文件裡有沒有出現某串字」。
//
// ## r2 的兩個實測假綠（Codex 抓的，判準因此重寫）
//
// r2 版用 `lineWith()`：收集所有命中的行、**join 起來**再比對 ⇒ 語意變成「**任何一處對就算過**」。
//   ①留著正確的 LEN 行，另外再加一行錯的（`LEN_SHORT=300`）⇒ 5/5 全綠
//   ②正文改回 XML 40MB，把正確值藏進 **HTML 註解** ⇒ 5/5 全綠
// 這正好放過本題最想防的「同一份文件一對一錯」。
//
// r3 的兩條修法（都是**關門**，不是補洞）：
//   ①先剝掉 HTML 註解——註解不是給讀者看的現況
//   ②**每一個**命中的行都必須成立（`linesWith` 回陣列、逐行斷言），不是任一行成立
//
// 誠實劃界：擋得住「數字漂移」與「已完成卻標未完成」，**擋不住「整節停在舊世界」**
//（r2 的 Medium 1／2 就是那種——沒有數字可以對，只能靠人讀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_IB_XML_CHARS } from '../lib/parse-limits.js';
import { LEN_SHORT, LEN_LONG } from '../lib/schema.js';
import { KEEP_DAYS } from '../lib/services/backup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 讀檔並**剝掉 HTML 註解**——註解裡的值不是現況，不該替文件擔保。 @param {string} p */
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const PLAN = 'docs/多人上線-施工計畫.md';
const MAP = 'docs/安全與健壯性-待辦地圖.md';

/**
 * 抓出**每一個**含錨點的行。找不到就是紅——文件被改寫時要有人回來看。
 *
 * ⚠️ 回陣列、由呼叫端逐行斷言。r2 版把命中的行 join 起來再比對，
 * 語意就變成「任何一處對就算過」——留著正確的行、另外再加一行錯的，考題全綠。
 * @param {string} md @param {string} anchor @param {string} where
 */
function linesWith(md, anchor, where) {
  const hits = md.split('\n').filter((l) => l.includes(anchor));
  assert.ok(
    hits.length > 0,
    `${where}：找不到錨點「${anchor}」。文件被改寫了 ⇒ 請一起更新這支考題，不要直接刪掉斷言。`,
  );
  return hits;
}

/**
 * 待辦地圖的項目狀態＝**條列開頭那個記號**，不是「整行有沒有出現某個詞」。
 *
 * ⚠️ 這裡踩過一次：原本寫「整行不得出現『未開工』」，但**誠實的校正註記本身就會寫
 * 『原標「未開工」，實際 #297 已上線』**——正確的文件反而被判紅。
 * ⚠️ 也接受 `- ✅ **已完成**` 這種等價排版（Codex r2 指出原版會誤紅）。
 * @param {string} line @param {string} where
 */
function assertDone(line, where) {
  assert.match(
    line,
    /^\s*[-*]\s*(?:\*\*\s*)?✅/u,
    `${where}：這一項已經上線，條列開頭的狀態記號卻不是 ✅。\n實得：${line.slice(0, 80)}`,
  );
}

test('XML 上限：文件抄的數字＝lib/parse-limits.js 的 MAX_IB_XML_CHARS', () => {
  const mb = MAX_IB_XML_CHARS / (1024 * 1024);
  assert.ok(Number.isInteger(mb), `MAX_IB_XML_CHARS 不再是整數 MB（${MAX_IB_XML_CHARS}），考題要改寫`);
  // 錨在文件自己宣告的單一真相那一列——不是全檔掃「XML \d+MB」
  //（同一列還寫著「不是 40MB」，全檔掃會把那個歷史對照也當成宣稱值）。
  for (const row of linesWith(read(PLAN), 'MAX_IB_XML_CHARS', PLAN)) {
    assert.match(
      row,
      new RegExp(`XML\\s*${mb}\\s*MB`),
      `${PLAN} 有一列點名了 MAX_IB_XML_CHARS 卻沒寫成 XML ${mb}MB（程式現在是 ${mb}MB）。\n`
      + '⚠️ 這個數字不是裝飾——40MB 是實測會讓行程 OOM 死掉的線。\n'
      + `實得：${row.slice(0, 120)}`,
    );
  }
});

test('異常輸入防線：文件抄的長度上限＝lib/schema.js 的常數', () => {
  for (const row of linesWith(read(MAP), 'LEN_SHORT', MAP)) {
    assert.match(row, new RegExp(`LEN_SHORT\\s*=\\s*${LEN_SHORT}\\b`), `${MAP} 有一行的 LEN_SHORT 與程式不符（程式＝${LEN_SHORT}）：${row.slice(0, 100)}`);
    assert.match(row, new RegExp(`LEN_LONG\\s*=\\s*${LEN_LONG}\\b`), `${MAP} 有一行的 LEN_LONG 與程式不符（程式＝${LEN_LONG}）：${row.slice(0, 100)}`);
    assertDone(row, `${MAP}（異常輸入防線 #297）`);
  }
});

test('每日滾動備份：文件抄的保留天數＝lib/services/backup.js 的 KEEP_DAYS', () => {
  for (const row of linesWith(read(MAP), 'KEEP_DAYS', MAP)) {
    assert.match(row, new RegExp(`KEEP_DAYS\\s*=\\s*${KEEP_DAYS}\\b`), `${MAP} 有一行的 KEEP_DAYS 與程式不符（程式＝${KEEP_DAYS}）：${row.slice(0, 100)}`);
    assert.match(row, new RegExp(`保留\\s*${KEEP_DAYS}\\s*天`), `${MAP} 的白話說明沒跟著 KEEP_DAYS=${KEEP_DAYS} 一起改：${row.slice(0, 100)}`);
    assertDone(row, `${MAP}（每日滾動備份 #295）`);
  }
});

test('雙模式開關：文件用的環境變數名＝lib/hosted.js 真正認的那個', () => {
  // 從程式抽名字，不是把名字寫死在考題裡——程式改名，這裡會跟著要求文件改名。
  const src = readFileSync(join(ROOT, 'lib/hosted.js'), 'utf8');
  const m = /process\.env\.([A-Z0-9_]+)\s*===/.exec(src);
  assert.ok(m, 'lib/hosted.js 的 isHosted() 判準改寫了 ⇒ 請一起更新這支考題');
  const envName = m[1];

  // ⚠️ 判準是**整個 token**，不是子字串（Codex r2 實測：把文件裡的 NOTEASY_HOSTED
  //    全改成 NOTEASY_HOSTED_WRONG，`includes()` 版照樣全綠——它是子字串命中）。
  const tokensOf = (/** @type {string} */ s) =>
    [...s.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)].map((x) => x[0]);

  for (const p of [PLAN, MAP]) {
    const lines = read(p).split('\n');
    for (const line of lines) {
      // 只看**長得像環境變數**的 token（含底線）——「HOSTED」單獨出現時是模式的名字
      //（「HOSTED 匯入」「兩種模式都套」），不是變數名，不該被當成寫錯。
      const wrong = tokensOf(line).filter((t) => t.includes('HOSTED') && t.includes('_') && t !== envName);
      if (!wrong.length) continue;
      // 允許「舊名 X 已廢棄，現用 <envName>」這種誠實的沿革註記：同一行要點出現行名。
      assert.ok(
        tokensOf(line).includes(envName),
        `${p} 出現不是 ${envName} 的模式開關名：${wrong.join('、')}\n`
        + `（若是沿革註記，請在同一行寫出現行的 ${envName}）\n實得：${line.slice(0, 120)}`,
      );
    }
  }
  assert.ok(tokensOf(read(PLAN)).includes(envName), `${PLAN} 沒有提到程式真正認的環境變數 ${envName}`);
});

test('成本估算不得停在已被推翻的方案（裁決①已升 Supabase Pro）', () => {
  const md = read(PLAN);
  // 只有當裁決速查表真的寫著「已升 Pro」時才檢查——裁決若改回去，這題自動退場。
  const verdict = linesWith(md, '| ① | Supabase 方案', PLAN);
  assert.equal(verdict.length, 1, `${PLAN} 的裁決①不是唯一一列`);
  if (!verdict[0].includes('已升 Pro')) return;

  const costRows = linesWith(md, '| Supabase（Auth＋Postgres）', PLAN);
  for (const row of costRows) {
    assert.ok(!row.includes('Free'),
      `${PLAN}：裁決①寫「已升 Pro」，成本估算表卻還把 Supabase 算成 Free。\n`
      + '同一份文件同時說兩件相反的事＝讀的人一定會拿到錯的那個。');
    assert.ok(row.includes('Pro'), `${PLAN}：成本估算表的 Supabase 那列沒寫出現行方案 Pro`);
    // ⚠️ Codex r2 實測：只查 Pro／Free 字樣的話，「Pro ／ US$0」照樣全綠。價格也要對得起方案。
    assert.ok(!/US\$\s*0\b/.test(row),
      `${PLAN}：Supabase 已升 Pro，那一列的費用卻還是 US$0。\n實得：${row.slice(0, 140)}`);
  }
  for (const total of linesWith(md, '| **合計**', PLAN)) {
    assert.ok(!/US\$0[–-]7/.test(total),
      `${PLAN}：合計還是升 Pro 之前的 US$0–7。\n實得：${total.slice(0, 140)}`);
  }
});
