#!/usr/bin/env node
// 從 cases/ 底下的案例檔產生 cases/README.md（案例簿索引）。**索引是產物、不要手改。**
//
// 為什麼要產生：索引原本是手寫、靠考題去「找出那張表格」來對帳，而那等於在解讀 Markdown
// 的呈現規則——連四輪被獨立審查者繞過（把整列搬進 HTML 註解、搬進三反引號範例、刪掉表頭與
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
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { literal } = require('./build-rules.js');

const root = path.join(__dirname, '..');
const casesDir = path.join(root, 'cases');
const notesFile = path.join(casesDir, 'index.json');
const outFile = path.join(casesDir, 'README.md');

const FIELDS = ['日期', '本文條號', '發生什麼', '代價', '教訓', '來源'];

/**
 * 帶不帶案例簿的**登記**（裁示 2a：公開的專案可以不帶 cases/）。登記住在設定的機器表這一列：已啟用＝帶、未移植＝不帶。
 * ⚠️ 帶不帶只看登記、**不看 cases/ 在不在**——「找不到就跳過」會讓套件自己的倉庫誤刪案例簿時照樣全綠（靜靜通過）。
 * cases/ 在不在只拿來跟登記對帳：對不上一律紅、而且照跑檢查；唯一跳過的情況是「登記不帶，而且 cases/ 確實不在」。
 * 考題看得到的只有磁碟上的 cases/，分不出自己在套件還是在專案裡，所以訊息兩種情況都要講清楚。
 */
const MACHINE = '案例簿考題＋索引產生器';
const NOT_CARRIED_REASON = `settings.json 把「${MACHINE}」登記成未移植（本專案不帶案例簿），cases/ 也確實不在`;

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
    return casesPresent ? { run: true, problem: `「${MACHINE}」登記未移植（不帶案例簿），cases/ 卻在：不帶就刪掉 cases/；要帶就改登記已啟用` }
      : { run: false, problem: null };
  }
  return { run: true, problem: `「${MACHINE}」只能登記已啟用（帶案例簿）或未移植（不帶），現在是「${state}」：這一列是開關，不只是紀錄` };
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
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
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

/** 由案例檔與 index.json 產生索引的完整內容（換行一律用 \n）。 */
function build() {
  const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
  const rows = caseFiles()
    .map(readCase)
    .sort((a, b) => (a.日期 === b.日期 ? a.slug.localeCompare(b.slug) : a.日期.localeCompare(b.日期)));
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

if (require.main === module) {
  fs.writeFileSync(outFile, build(), 'utf8');
  process.stdout.write(`寫好 cases/README.md：${caseFiles().length} 則\n`);
}

module.exports = { build, outFile, notesFile, caseFiles, readCase, parseCase, checkPlain, FIELDS, MACHINE, NOT_CARRIED_REASON, declaration };
