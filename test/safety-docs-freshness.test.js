// @ts-check
// 兩份「安全判斷輸入」文件的過期考題（2026-08-02，PR #381 r2 補）。
//
// 病因：這兩份文件不是說明書，是**做安全決策時會拿來當依據的東西**。它們一旦過期，
// 讀的人會用錯誤的前提做判斷——而畫面上完全看不出來。本輪實際抓到的失真：
//   ・XML 上限文件寫 40MB、程式是 12MB——**而 40MB 正是實測會 OOM 死掉的線**
//   ・「異常輸入防線」標成已排程，其實 #297 早就上線
//   ・「每日滾動備份」標成未開工，其實 #295 早就上線
//   ・環境變數文件叫 `HOSTED_MODE`、程式叫 `NOTEASY_HOSTED`
//   ・裁決①已寫「升 Pro」，成本表還停在 Free US$0
//
// 這支考題的分工：**只鎖「文件抄寫的數字／名字，與程式的單一真相相符」**。
// 判準刻意是「從程式抽值、代進文件比對」，不是「文件裡有沒有出現某串字」——
// 本專案的招牌假綠就是「斷言文字出現過」（#379 角色表被「**不**複審」滿足、
// #382 CI 那題被檔頭註解裡的路徑滿足）。**斷言的對象要是行為**：
// 改了程式常數而沒回頭改文件，這裡就要紅。
//
// fail-closed：找不到被錨定的那句話**也算紅**（訊息會說「文件改寫了，請一起更新考題」）。
// 「查不到」不等於「沒問題」——那正是這兩份文件過期時的樣子。
//
// 誠實劃界：擋得住「數字漂移」與「已完成卻標未完成」，擋不住「文件整段沒寫」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_IB_XML_CHARS } from '../lib/parse-limits.js';
import { LEN_SHORT, LEN_LONG } from '../lib/schema.js';
import { KEEP_DAYS } from '../lib/services/backup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

const PLAN = 'docs/多人上線-施工計畫.md';
const MAP = 'docs/安全與健壯性-待辦地圖.md';

/**
 * 抓出「含有某個錨點字串」的那一行。找不到就是紅——文件被改寫時要有人回來看。
 * @param {string} md
 * @param {string} anchor
 * @param {string} where
 */
function lineWith(md, anchor, where) {
  const hits = md.split('\n').filter((l) => l.includes(anchor));
  assert.ok(
    hits.length > 0,
    `${where}：找不到錨點「${anchor}」。文件被改寫了 ⇒ 請一起更新這支考題，不要直接刪掉斷言。`,
  );
  return hits.join('\n');
}

/**
 * 待辦地圖的項目狀態＝**條列開頭那個記號**，不是「整行有沒有出現某個詞」。
 *
 * ⚠️ 這裡踩過一次：原本寫「整行不得出現『未開工』」，但**誠實的校正註記本身就會寫
 * 『原標「未開工」，實際 #297 已上線』**——正確的文件反而被判紅。
 * 狀態是行首那一格，就只看那一格。
 * @param {string} line
 * @param {string} where
 */
function assertDone(line, where) {
  const m = /^\s*[-*]\s*\*\*(.+?)\*\*/.exec(line);
  assert.ok(m, `${where}：這一條的開頭不再是「- **狀態**」的格式 ⇒ 請一起更新這支考題`);
  assert.ok(
    m[1].startsWith('✅'),
    `${where}：這一項已經上線，狀態記號卻是「${m[1]}」而不是 ✅`,
  );
}

test('XML 上限：文件抄的數字＝lib/parse-limits.js 的 MAX_IB_XML_CHARS', () => {
  const mb = MAX_IB_XML_CHARS / (1024 * 1024);
  assert.ok(Number.isInteger(mb), `MAX_IB_XML_CHARS 不再是整數 MB（${MAX_IB_XML_CHARS}），考題要改寫`);
  // 錨在文件自己宣告的單一真相那一列——不是全檔掃「XML \d+MB」
  //（同一列還寫著「不是 40MB」，全檔掃會把那個歷史對照也當成宣稱值）。
  const row = lineWith(read(PLAN), 'MAX_IB_XML_CHARS', PLAN);
  assert.match(
    row,
    new RegExp(`XML\\s*${mb}\\s*MB`),
    `${PLAN} 的「解析器資源上限」那列沒有寫成 XML ${mb}MB（程式現在是 ${mb}MB）。`
      + '⚠️ 這個數字不是裝飾——40MB 是實測會讓行程 OOM 死掉的線。',
  );
});

test('異常輸入防線：文件抄的長度上限＝lib/schema.js 的常數', () => {
  const md = read(MAP);
  const row = lineWith(md, 'LEN_SHORT', MAP);
  assert.match(row, new RegExp(`LEN_SHORT\\s*=\\s*${LEN_SHORT}\\b`), `${MAP} 的 LEN_SHORT 與程式不符（程式＝${LEN_SHORT}）`);
  assert.match(row, new RegExp(`LEN_LONG\\s*=\\s*${LEN_LONG}\\b`), `${MAP} 的 LEN_LONG 與程式不符（程式＝${LEN_LONG}）`);
  // 已完成的東西不可以還掛在「未開工」——這正是本輪抓到的失真型態。
  assertDone(row, `${MAP}（異常輸入防線 #297）`);
});

test('每日滾動備份：文件抄的保留天數＝lib/services/backup.js 的 KEEP_DAYS', () => {
  const md = read(MAP);
  const row = lineWith(md, 'KEEP_DAYS', MAP);
  assert.match(row, new RegExp(`KEEP_DAYS\\s*=\\s*${KEEP_DAYS}\\b`), `${MAP} 的 KEEP_DAYS 與程式不符（程式＝${KEEP_DAYS}）`);
  assert.match(row, new RegExp(`保留\\s*${KEEP_DAYS}\\s*天`), `${MAP} 的白話說明沒跟著 KEEP_DAYS=${KEEP_DAYS} 一起改`);
  assertDone(row, `${MAP}（每日滾動備份 #295）`);
});

test('雙模式開關：文件用的環境變數名＝lib/hosted.js 真正認的那個', () => {
  // 從程式抽名字，不是把名字寫死在考題裡——程式改名，這裡會跟著要求文件改名。
  const src = read('lib/hosted.js');
  const m = /process\.env\.([A-Z0-9_]+)\s*===/.exec(src);
  assert.ok(m, 'lib/hosted.js 的 isHosted() 判準改寫了 ⇒ 請一起更新這支考題');
  const envName = m[1];

  for (const p of [PLAN, MAP]) {
    const md = read(p);
    assert.ok(
      !md.includes('HOSTED_MODE') || envName === 'HOSTED_MODE',
      `${p} 還在用舊名 HOSTED_MODE，程式認的是 ${envName}`,
    );
  }
  assert.ok(read(PLAN).includes(envName), `${PLAN} 沒有提到程式真正認的環境變數 ${envName}`);
});

test('成本估算不得停在已被推翻的方案（裁決①已升 Supabase Pro）', () => {
  const md = read(PLAN);
  // 只有當裁決速查表真的寫著「已升 Pro」時才檢查——裁決若改回去，這題自動退場。
  const verdict = lineWith(md, '| ① | Supabase 方案', PLAN);
  if (!verdict.includes('已升 Pro')) return;

  const costRow = lineWith(md, '| Supabase（Auth＋Postgres）', PLAN);
  assert.ok(
    !costRow.includes('Free'),
    `${PLAN}：裁決①寫「已升 Pro」，成本估算表卻還把 Supabase 算成 Free。`
      + '同一份文件同時說兩件相反的事＝讀的人一定會拿到錯的那個。',
  );
  assert.ok(costRow.includes('Pro'), `${PLAN}：成本估算表的 Supabase 那列沒寫出現行方案 Pro`);
});
