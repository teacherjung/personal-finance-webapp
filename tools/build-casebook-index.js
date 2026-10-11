#!/usr/bin/env node
// 從 cases/ 底下的案例檔產生 cases/README.md（案例簿索引）。**索引是產物、不要手改。**
//
// 為什麼要產生：索引原本是手寫、靠考題去「找出那張表格」來對帳，而那等於在解讀 Markdown
// 的呈現規則——連四輪被複審者繞過（把整列搬進 HTML 註解、搬進三反引號範例、刪掉表頭與
// 分隔列、把整張表包進圍欄或 `<pre>` 變成範例）。每一次我都再多驗一種上下文，每一次都撐不到
// 下一輪。本文那一族早就換過做法了：資料存起來、文件是產物、比對逐字元相同。索引照做。
//
// ⚠️ 但只把文件改成產物還不夠（第十三輪實測）：**產生器自己的輸入也要有契約與字面編碼**，
// 否則同樣一個壞結構可以從來源資料送進來，產生器穩定地產出錯的文件，考題再穩定地確認兩份相同。
// 所以這裡跟 build-rules.js 用同一套：
//   ①契約：每個會被輸出的欄位都是單行、非空、前後不帶空白、不含空字元的字串，
//     檔名與條號另有固定寫法；不合就丟例外，不產生半成品。
//   ②字面編碼：所有 ASCII 標點一律跳脫（沿用 build-rules.js 的 literal），
//     Markdown 的語法只能由下面這個固定範本提供。
//   ⚠️ 代價照實說：索引裡的散文因此是純文字，不能用粗體或反引號之類的排版。
//
// 索引裡不是表格的那幾段（開頭說明、末尾的方法示例）住在 cases/index.json。
//
// 另產一份 cases/DIGEST.md（每條規矩為什麼存在的摘要；擁有者 2026-10-07 第 10 題裁「做。（建議）」）：
// 不帶案例簿的專案（套件私有、案例可能含私人紀錄）讀得到規矩「要這樣做」、讀不到「為什麼」；這一份每條規矩一行，
// 跟用語對照表同待遇：不算 K2 字數、跟規矩一起搬進每個專案（不帶案例簿的也帶這一份，共用檔清單釘著它）。
// 每條預設列**最早**指著它的那一則（日期、檔名比字碼）——那一則多半就是它訂下來的原因；教訓只取第一個「；」或「。」之前。
// 規矩後來改過意思的（例如 A4 從「實作者不按合併鍵」改成「實作者跑合併指令」），最早那一則講的是已退役的做法，照抄會把舊制當成現行規矩的理由
// 送進不帶案例簿的專案（#59 r1 R1）：這幾條在 cases/index.json 的 digest.pick 指定改挑哪一則（附為什麼），產生器驗那一則在、而且指著那條規矩，不然丟錯。
// ⚠️ 代價：挑哪一則貼不貼切、規矩再改意思時 pick 要不要跟著改，都靠人（複審必驗清單第 18 項動到 rules.json 時順手看）；它也不判斷那一則撐不撐得住那條規矩（字面引用≠事件支撐，同案例簿考題）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { literal } = require('./build-rules.js');

const root = path.join(__dirname, '..');
const casesDir = path.join(root, 'cases');
const notesFile = path.join(casesDir, 'index.json');
const outFile = path.join(casesDir, 'README.md');
const digestFile = path.join(casesDir, 'DIGEST.md');
const NOT_CASES = new Set(['README.md', 'DIGEST.md']);

const FIELDS = ['日期', '本文條號', '發生什麼', '代價', '教訓', '來源'];

/**
 * 帶不帶案例簿的**登記**（裁示 2a：公開的專案可以不帶 cases/）。登記住在設定的機器表這一列：已啟用＝帶、未移植＝不帶。
 * ⚠️ 帶不帶只看登記、**不看 cases/ 在不在**——「找不到就跳過」會讓套件自己的倉庫誤刪案例簿時照樣全綠（靜靜通過）。
 * cases/ 在不在只拿來跟登記對帳：對不上一律紅、而且照跑檢查；唯一跳過的情況是「登記不帶，而且 cases/ 確實不在」。
 * 考題看得到的只有磁碟上的 cases/，分不出自己在套件還是在專案裡，所以訊息兩種情況都要講清楚。
 */
const MACHINE = '案例簿考題＋索引產生器';
const NOT_CARRIED_REASON = `settings.json 把「${MACHINE}」登記成未移植（本專案不帶案例簿），cases/ 裡也確實沒有摘要以外的東西`;

/**
 * @param {unknown} machines 設定的機器表
 * @param {boolean} casesPresent 磁碟上有沒有 cases/
 * @returns {{ run: boolean, problem: string|null }}
 */
function declaration(machines, casesPresent) {
  const rows = Array.isArray(machines) ? machines.filter((m) => m && m.name === MACHINE) : [];
  if (rows.length !== 1) return { run: true, problem: `機器表裡「${MACHINE}」要剛好一列（現在 ${rows.length} 列）` };
  const { state } = rows[0];
  if (state === '已啟用') {
    return casesPresent ? { run: true, problem: null }
      : { run: true, problem: `「${MACHINE}」登記已啟用（帶案例簿），cases/ 卻不在。在套件自己的倉庫＝案例簿被誤刪，還原它；在不帶案例簿的專案（多半是同步時設定被蓋回已啟用）＝把這一列改回未移植，不要把 cases/ 複製進來` };
  }
  if (state === '未移植') {
    return casesPresent ? { run: true, problem: `「${MACHINE}」登記未移植（不帶案例簿），cases/ 裡卻有摘要以外的東西：不帶就把 cases/ 裡摘要以外的檔刪掉（cases/DIGEST.md 要留著，它在共用檔清單裡、刪了那一題會紅）；要帶就改登記已啟用` }
      : { run: false, problem: null };
  }
  return { run: true, problem: `「${MACHINE}」只能登記已啟用（帶案例簿）或未移植（不帶），現在是「${state}」：這一列是開關，不只是紀錄` };
}
/**
 * 「cases/ 在不在」＝底下有摘要以外的東西。不帶案例簿的專案也帶 cases/DIGEST.md（共用檔清單釘著），
 * 只有那一份不算帶了案例簿；不然那種專案的登記（未移植）永遠對不上。
 */
function casebookPresent(dir = casesDir) {
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f !== 'DIGEST.md');
}
const LINE_BREAK = /[\n\r\u0085\u2028\u2029\v\f]/u;
const EDGE_SPACE = /^\s|\s$|\t/u;
const hasNul = (s) => String(s).includes('\u0000');
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SLUG = /^[a-z0-9-]+$/u;
const RULE_IDS = /^[A-Z]\d+(?:、[A-Z]\d+)*$/u;

function checkPlain(value, what) {
  if (typeof value !== 'string') throw new Error(`${what} 不是字串`);
  if (value.trim() === '') throw new Error(`${what} 是空的`);
  if (LINE_BREAK.test(value)) throw new Error(`${what} 裡有換行：它會跑出自己該待的位置`);
  if (EDGE_SPACE.test(value)) throw new Error(`${what} 的前後有空白、或裡面有定位字元`);
  if (hasNul(value)) throw new Error(`${what} 裡有空字元`);
  return value;
}

function caseFiles() {
  return fs
    .readdirSync(casesDir)
    .filter((f) => f.endsWith('.md') && !NOT_CASES.has(f))
    .sort();
}

/**
 * 解析一則案例的內容。形狀不合就丟例外，不要產生半成品的索引。
 * ⚠️ 跟讀檔分開，是為了讓考題能直接餵壞形狀進來考這些檢查——原本整段綁在讀檔裡，
 *    要考就得把壞檔寫進 cases/（會污染倉庫），結果是這些檢查一條考題都沒有（2026-09-13 稽核抓到：
 *    把每一條檢查逐一短路掉，全卷仍然全綠）。
 */
function parseCase(text, file) {
  const lines = String(text).split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines[0] || !lines[0].startsWith('# ')) throw new Error(`${file} 第一行不是標題`);
  const fields = { slug: file.slice(0, -3), 標題: lines[0].slice(2).trim() };
  FIELDS.forEach((name, i) => {
    const head = `- ${name}：`;
    const line = lines[i + 2];
    if (typeof line !== 'string' || !line.startsWith(head)) {
      throw new Error(`${file} 第 ${i + 3} 行應該是「${head}…」`);
    }
    fields[name] = line.slice(head.length).trim();
  });
  checkPlain(fields.標題, `${file} 的標題`);
  checkPlain(fields.日期, `${file} 的日期`);
  checkPlain(fields['本文條號'], `${file} 的本文條號`);
  if (!SLUG.test(fields.slug)) throw new Error(`${file} 的檔名不是小寫英數與連字號`);
  if (!DATE.test(fields.日期)) throw new Error(`${file} 的日期不是 YYYY-MM-DD`);
  if (!RULE_IDS.test(fields['本文條號'])) throw new Error(`${file} 的本文條號寫法不合（要像 A1 或 A1、B2）`);
  return fields;
}

/** 讀一則案例。解析與檢查都在 parseCase。 */
function readCase(file) {
  return parseCase(fs.readFileSync(path.join(casesDir, file), 'utf8'), file);
}

/** 比字碼（不跟著機器的語系走：同一份輸入在每台機器都排成一樣；索引與摘要都用這一個）。 */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 由案例檔與 index.json 產生索引的完整內容（換行一律用 \n）。 */
function build() {
  const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
  const rows = caseFiles()
    .map(readCase)
    .sort((a, b) => byCode(a.日期, b.日期) || byCode(a.slug, b.slug));
  const out = [`# ${literal(checkPlain(notes.title, '索引標題'))}`, ''];
  for (const line of notes.intro) out.push(literal(checkPlain(line, '索引導言')));
  out.push('', `共 ${rows.length} 則。`, '', '| 日期 | 案例 | 本文條號 |', '|---|---|---|');
  for (const row of rows) {
    out.push(`| ${row.日期} | [${literal(row.標題)}](${row.slug}.md) | ${row['本文條號']} |`);
  }
  out.push('');
  for (const section of notes.sections) {
    out.push(`## ${literal(checkPlain(section.title, '索引小節標題'))}`, '');
    for (const line of section.lines) out.push(literal(checkPlain(line, '索引小節內容')));
    out.push('');
  }
  return out.join('\n');
}

/**
 * 由案例檔、index.json 與規矩資料檔產生摘要的完整內容：本文每一條一行，照本文的順序。
 * 有一條規矩沒有任何案例指著＝丟例外（案例簿考題的進門規則同一件事；不產生缺行的摘要）。
 */
function buildDigest({ rules = require('./build-rules.js').read(), rows = caseFiles().map(readCase), notes = JSON.parse(fs.readFileSync(notesFile, 'utf8')) } = {}) {
  const d = notes.digest || {};
  // pick 整份先驗（#59 r2 R1）：寫壞的設定不可以默默當成「沒指定」而退回最早那一則——那正是 r1 要修掉的舊制摘要，逐字比對還會接受它
  const ids = rules.sections.flatMap((s) => s.rules.map((r) => `${s.letter}${r.n}`));
  let pick = {};
  if (d.pick !== undefined) {
    if (!d.pick || typeof d.pick !== 'object' || Array.isArray(d.pick)) throw new Error('index.json 的 digest.pick 要是物件（條號 → { slug, why }）');
    for (const [id, p] of Object.entries(d.pick)) {
      if (!ids.includes(id)) throw new Error(`index.json 的 digest.pick 有「${id}」：本文沒有這一條（打錯條號會讓那一條默默退回最早那一則）`);
      if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.slug !== 'string' || typeof p.why !== 'string') throw new Error(`index.json 的 digest.pick.${id} 要是 { slug, why }`);
      checkPlain(p.slug, `digest.pick.${id}.slug`);
      checkPlain(p.why, `digest.pick.${id}.why`);
    }
    pick = d.pick;
  }
  const out = [`# ${literal(checkPlain(d.title, '摘要標題'))}`, ''];
  for (const line of d.intro || []) out.push(literal(checkPlain(line, '摘要導言')), '');
  for (const section of rules.sections) {
    for (const rule of section.rules) {
      const id = `${section.letter}${rule.n}`;
      const hit = rows.filter((r) => r['本文條號'].split('、').includes(id)).sort((a, b) => byCode(a.日期, b.日期) || byCode(a.slug, b.slug));
      if (!hit.length) throw new Error(`本文 ${id} 沒有任何案例指著：摘要產不出那一行`);
      let first = hit[0];
      if (Object.hasOwn(pick, id)) {
        const p = pick[id];
        first = hit.find((r) => r.slug === p.slug);
        if (!first) throw new Error(`index.json 的 digest.pick.${id} 指的「${p.slug}」不在案例簿、或它的本文條號沒有 ${id}：摘要產不出那一行`);
      }
      const lesson = checkPlain(first.教訓, `${first.slug} 的教訓`).split(/[；。]/u)[0].trim();
      out.push(`- ${id}｜${literal(first.標題)}（${first.日期}）——${literal(checkPlain(lesson, `${first.slug} 的教訓前半句`))}`);
    }
  }
  out.push('');
  return out.join('\n');
}

if (require.main === module) {
  fs.writeFileSync(outFile, build(), 'utf8');
  fs.writeFileSync(digestFile, buildDigest(), 'utf8');
  process.stdout.write(`寫好 cases/README.md：${caseFiles().length} 則；cases/DIGEST.md：本文每條一行\n`);
}

module.exports = { build, buildDigest, casebookPresent, outFile, digestFile, notesFile, caseFiles, readCase, parseCase, checkPlain, FIELDS, MACHINE, NOT_CARRIED_REASON, declaration };
