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
// ## 判準演化史（每一輪都是 Codex 實測打穿的，留著免得有人「簡化」回去）
//
// r2：`lineWith()` 收集所有命中的行、**join 起來**再比對 ⇒「任何一處對就算過」。
//     打穿方式＝另加一行錯的、或把正確值藏進 HTML 註解。
// r3：改成逐行斷言＋剝註解。還是被打穿四種——
//     ①**未閉合**的 `<!--`（後半份文件整片隱藏，剝「完整註解」看不見）
//     ②同一行先寫對的、再補一句「現況其實是 300」
//     ③`ＵＳ＄０`／`&#49;2MB` 這類全形與 HTML 實體
//     ④把裁決措辭改成等價的「Pro 已啟用」⇒ `if (!includes('已升 Pro')) return` **靜默退場**
// r4（現在）：判準換成三條，每條都是「關門」而不是「補洞」——
//     ①讀檔時剝註解，**剝完不准有殘留的 `<!--`／`-->`**
//     ②「有沒有寫對」換成「**每一個賦值／每一個金額都對嗎**」（順便解掉 r3 的誤紅：
//       只是提到常數的補充說明沒有賦值，本來就不該被當成狀態列）
//     ③讀不出狀態時**紅**，不是靜默跳過
//
// 誠實劃界：擋得住「數字漂移」與「已完成卻標未完成」，**擋不住「整節停在舊世界」**
//（那種沒有數字可以對，只能靠人讀——r3 的 Medium 1／2 就是）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_IB_XML_CHARS } from '../lib/parse-limits.js';
import { LEN_SHORT, LEN_LONG } from '../lib/schema.js';
import { KEEP_DAYS } from '../lib/services/backup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 讀檔並**正規化**——判準要看的是「文件實際主張的值」，不是它的排版。
 *
 * 三道處理，每一道都對應一個 Codex 實測過的假綠：
 *   ①剝 HTML 註解（r2：正文寫 40MB、正確值藏在註解裡 ⇒ 全綠）
 *   ②剝完之後**不准有殘留的 `<!--`／`-->`**（r3：加一個未閉合的 `<!--`，
 *     Markdown 後半整份被隱藏，考題照樣全綠）
 *   ③解 HTML 實體 ＋ NFKC（r3：`&#49;2MB`／`US&#36;0`／`ＵＳ＄０`／`１２MB`）
 * @param {string} p
 */
function read(p) {
  const raw = readFileSync(join(ROOT, p), 'utf8');
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(
    !stripped.includes('<!--') && !stripped.includes('-->'),
    `${p} 有沒閉合（或巢狀走樣）的 HTML 註解。\n`
    + '⚠️ 一個未閉合的 `<!--` 會讓 Markdown 後面整片內容在畫面上消失，'
    + '而考題如果只剝「完整的註解」就看不見這件事。',
  );
  return stripped
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    ;
}

/**
 * 全形英數與符號折成半形——**只在「要讀數字」的地方用**，不是整份文件先折。
 *
 * ⚠️ 兩個實際踩到的坑：
 *   ①`normalize('NFKC')` 會把這兩份文件到處在用的 `①②③` 折成 `1 2 3`，
 *     錨點（`| ① | Supabase 方案`）當場全部失效。
 *   ②整份先折的話，`（Auth＋Postgres）` 會變成 `(Auth+Postgres)`，同樣讓錨點失效。
 * 所以：**錨點用原文比對，數字用折過的比對。**
 * @param {string} s
 */
const fold = (s) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

const PLAN = 'docs/多人上線-施工計畫.md';
const MAP = 'docs/安全與健壯性-待辦地圖.md';

/**
 * 抓出文件裡**每一個**「常數 = 數字」的主張，逐一驗證。
 *
 * ⚠️ 判準從「含錨點的那一行寫對了嗎」換成「**每一個賦值都對嗎**」——這一步同時解掉兩件事：
 *   ・r3 假綠：同一行裡先寫對的、再補一句「現況其實是 300」⇒ 舊判準只看「有沒有出現對的」
 *   ・r3 誤紅：只是**提到**常數的補充說明（沒有賦值）不該被當成狀態列
 * @param {string} md @param {string} name @param {string} where
 */
function assertEveryAssignment(md, name, expected, where) {
  const re = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'g');
  const hits = [...fold(md).matchAll(re)];
  assert.ok(hits.length > 0,
    `${where}：找不到任何 \`${name} = 數字\` 的主張。文件被改寫了 ⇒ 請一起更新這支考題，不要直接刪掉斷言。`);
  for (const h of hits) {
    assert.equal(Number(h[1]), expected,
      `${where}：\`${name} = ${h[1]}\` 與程式不符（程式＝${expected}）。\n`
      + `⚠️ 文件裡**每一處**賦值都要對——同一行先寫對的、再補一句錯的，讀者拿到的是錯的那個。`);
  }
}

/**
 * 待辦地圖的項目狀態＝**條列開頭那個記號**，不是「整行有沒有出現某個詞」。
 *
 * ⚠️ 踩過一次：原本寫「整行不得出現『未開工』」，但**誠實的校正註記本身就會寫
 * 『原標「未開工」，實際 #297 已上線』**——正確的文件反而被判紅。
 * 接受 `- **✅ …**` 與 `- ✅ **…**` 兩種等價排版。
 * @param {string} line @param {string} where
 */
function assertDone(line, where) {
  assert.match(
    line,
    /^\s*[-*]\s*(?:\*\*\s*)?✅/u,
    `${where}：這一項已經上線，條列開頭的狀態記號卻不是 ✅。\n實得：${line.slice(0, 80)}`,
  );
}

/** 找出「帶著某個賦值」的那一條——狀態記號只對它負責。 @param {string} md */
const bulletWith = (md, /** @type {RegExp} */ re) => md.split('\n').filter((l) => re.test(l));

test('XML 上限：文件抄的數字＝lib/parse-limits.js 的 MAX_IB_XML_CHARS', () => {
  const mb = MAX_IB_XML_CHARS / (1024 * 1024);
  assert.ok(Number.isInteger(mb), `MAX_IB_XML_CHARS 不再是整數 MB（${MAX_IB_XML_CHARS}），考題要改寫`);
  const md = read(PLAN);
  // 錨在文件自己宣告的單一真相那一列——不是全檔掃「XML \d+MB」
  //（同一列還寫著「不是 40MB」，全檔掃會把那個歷史對照也當成宣稱值）。
  const rows = md.split('\n').filter((l) => l.includes('MAX_IB_XML_CHARS'));
  assert.ok(rows.length > 0, `${PLAN}：找不到點名 MAX_IB_XML_CHARS 的那一列 ⇒ 請一起更新這支考題`);
  for (const row of rows) {
    assert.match(fold(row), new RegExp(`XML\\s*${mb}\\s*MB`),
      `${PLAN} 有一列點名了 MAX_IB_XML_CHARS 卻沒寫成 XML ${mb}MB（程式現在是 ${mb}MB）。\n`
      + '⚠️ 這個數字不是裝飾——40MB 是實測會讓行程 OOM 死掉的線。\n'
      + `實得：${row.slice(0, 120)}`);
  }
});

test('異常輸入防線：文件抄的長度上限＝lib/schema.js 的常數', () => {
  const md = read(MAP);
  assertEveryAssignment(md, 'LEN_SHORT', LEN_SHORT, MAP);
  assertEveryAssignment(md, 'LEN_LONG', LEN_LONG, MAP);
  for (const line of bulletWith(md, /LEN_SHORT\s*=\s*\d+/)) {
    assertDone(line, `${MAP}（異常輸入防線 #297）`);
  }
});

test('每日滾動備份：文件抄的保留天數＝lib/services/backup.js 的 KEEP_DAYS', () => {
  const md = read(MAP);
  assertEveryAssignment(md, 'KEEP_DAYS', KEEP_DAYS, MAP);
  for (const line of bulletWith(md, /KEEP_DAYS\s*=\s*\d+/)) {
    assert.match(fold(line), new RegExp(`保留\\s*${KEEP_DAYS}\\s*天`),
      `${MAP} 的白話說明沒跟著 KEEP_DAYS=${KEEP_DAYS} 一起改：${line.slice(0, 100)}`);
    assertDone(line, `${MAP}（每日滾動備份 #295）`);
  }
});

test('雙模式開關：文件用的環境變數名＝lib/hosted.js 真正認的那個', () => {
  // 從程式抽名字，不是把名字寫死在考題裡——程式改名，這裡會跟著要求文件改名。
  const src = readFileSync(join(ROOT, 'lib/hosted.js'), 'utf8');
  const m = /process\.env\.([A-Z0-9_]+)\s*===/.exec(src);
  assert.ok(m, 'lib/hosted.js 的 isHosted() 判準改寫了 ⇒ 請一起更新這支考題');
  const envName = m[1];

  // ⚠️ 判準是**整個 token**，不是子字串（r2 實測：全改成 NOTEASY_HOSTED_WRONG，
  //    `includes()` 版照樣全綠——它是子字串命中）。token 兩端也要吃掉底線，
  //    否則 `_NOTEASY_HOSTED_WRONG` 會被 `\b` 切成合法的一段（r3 實測）。
  const tokensOf = (/** @type {string} */ s) =>
    [...s.matchAll(/[A-Za-z0-9_]+/g)].map((x) => x[0]).filter((t) => /^[A-Z][A-Z0-9_]{3,}$/.test(t));

  for (const p of [PLAN, MAP]) {
    for (const line of read(p).split('\n')) {
      const toks = tokensOf(line);
      const wrong = toks.filter((t) => t.includes('HOSTED') && t.includes('_') && t !== envName);
      if (!wrong.length) continue;
      // 允許「舊名 X 已廢棄，現用 <envName>」這種誠實的沿革註記：同一行要點出現行名。
      assert.ok(toks.includes(envName),
        `${p} 出現不是 ${envName} 的模式開關名：${wrong.join('、')}\n`
        + `（若是沿革註記，請在同一行寫出現行的 ${envName}）\n實得：${line.slice(0, 120)}`);
    }
  }
  assert.ok(tokensOf(read(PLAN)).includes(envName), `${PLAN} 沒有提到程式真正認的環境變數 ${envName}`);
});

test('成本估算不得停在已被推翻的方案（裁決①已升 Supabase Pro）', () => {
  const md = read(PLAN);
  const verdict = md.split('\n').filter((l) => l.includes('| ① | Supabase 方案'));
  assert.equal(verdict.length, 1, `${PLAN} 的裁決①不是唯一一列`);

  // ⚠️ r3 假綠：原本寫 `if (!includes('已升 Pro')) return`——把裁決正常改寫成
  //    「Pro 已啟用」，整題就**靜默退場**，成本表改回 Free 也全綠。
  //    判準改成：裁決列必須讓機器讀得出 Pro 狀態，讀不出來就是**紅**（不是跳過）。
  const isPro = /Pro/.test(fold(verdict[0])) && !/\bFree\b/.test(fold(verdict[0]));
  assert.ok(isPro,
    `${PLAN} 的裁決①讀不出「現行方案是 Pro」。\n`
    + '若真的改回 Free，請連成本表與這支考題一起改——不可以讓這一題靜默退場。\n'
    + `實得：${verdict[0].slice(0, 160)}`);

  const costRows = md.split('\n').filter((l) => l.includes('| Supabase（Auth＋Postgres）'));
  assert.ok(costRows.length > 0, `${PLAN}：成本估算表找不到 Supabase 那一列`);
  for (const row of costRows) {
    assert.ok(!/\bFree\b/.test(fold(row)), `${PLAN}：裁決①寫 Pro，成本估算表卻還把 Supabase 算成 Free`);
    assert.ok(/Pro/.test(fold(row)), `${PLAN}：成本估算表的 Supabase 那列沒寫出現行方案 Pro`);
    // ⚠️ 判準是「金額 > 0」，不是「不含 US$0 這串字」——後者被 `US&#36;0`／`ＵＳ＄０` 繞過（r3 實測，
    //    現在 read() 已正規化）。逐一驗證那一列出現的**每個金額**。
    const amounts = [...fold(row).matchAll(/US\$\s*(\d+)/g)].map((x) => Number(x[1]));
    assert.ok(amounts.length > 0, `${PLAN}：Supabase 那列沒有寫出金額`);
    for (const a of amounts) {
      assert.ok(a > 0, `${PLAN}：Supabase 已升 Pro，那一列卻還有 US$${a} 的金額。\n實得：${row.slice(0, 140)}`);
    }
  }
  for (const total of md.split('\n').filter((l) => l.includes('| **合計**'))) {
    const amounts = [...fold(total).matchAll(/US\$\s*(\d+)/g)].map((x) => Number(x[1]));
    for (const a of amounts) {
      assert.ok(a > 0, `${PLAN}：合計裡還有 US$${a}——那是升 Pro 之前的數字。\n實得：${total.slice(0, 140)}`);
    }
  }
});
