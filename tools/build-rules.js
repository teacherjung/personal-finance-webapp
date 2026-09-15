#!/usr/bin/env node
// 從 rules.json 產生 RULES.md。**本文是產物、不要手改**：手改會被 tests/rules-length.test.js 抓到。
//
// 為什麼要產生：字數上限那道考題原本得自己判斷「RULES.md 的哪幾行算規矩」，等於用土法重做
// Markdown 的呈現規則——連七輪被獨立審查者用不同寫法繞過（項目符號、有序清單、縮排、Tab、
// 不換行空白、引言記號、七個井號、CR 換行）。改成由資料產生之後，就沒有「哪幾行算規矩」
// 這個問題：字數直接對資料算，本文只要跟產生結果逐字元相同即可。
//
// ⚠️ 但「由資料產生」本身不夠，而且不夠的地方有兩層：
//   第八輪：**不計字的欄位可以跑出它該待的位置**——小節標題裡塞一個換行，後面那段就變成
//   獨立的正文段落、完全不計字；句尾標籤裡先關括號再換行，就長出一整條沒人數的新規矩。
//   第九輪：**「單行」不等於「純文字」**——同一個欄位不必換行，只要塞原始 HTML
//   （`</h2><p>…</p><h2>`）、字元參照（`&#65289;`）或三個反引號，一樣能開出新的區塊、
//   關掉既有的位置、甚至把後面整份本文吃進程式碼區塊。
//   第十輪：只換掉**幾個**危險字元也還是黑名單——有序清單、縮排圍欄、連結語法照樣有效，
//   而且我在行首多加的那一層反斜線會把文字本身改掉、解回來就不是原文。
//
// 所以收口是兩件一起做，缺一不可：
//   ①**資料契約**（validate）：每個會被輸出的欄位都要是單行、非空、前後不帶空白的字串；
//   ②**輸出時把資料編成字面文字**（literal）：**所有 ASCII 標點一律加反斜線跳脫**——
//     這不是「危險字元黑名單」，是 Markdown 規格說了算的完整集合（反斜線加 ASCII 標點＝
//     那個字元的字面值）。標點全部失去語法能力，語法就只能由下面這個固定範本提供；
//     而且解回來（plain）與原文逐字元相同，不會像上一版那樣把文字改掉。
//     ⚠️ 這個「逐字元相同」只保證**本地解回來**：呈現器對空字元另有規定的替換，所以空字元
//     由契約直接擋掉；別的呈現差異不在這一支的保證範圍內。
// 契約與編碼都在這一支，產生器與考題共用，兩邊不會各寫各的。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataFile = path.join(root, 'rules.json');
const outFile = path.join(root, 'RULES.md');

// 會讓一個欄位跑出它該待的位置的字元：各種換行與分段。
const LINE_BREAK = /[\n\r\u0085\u2028\u2029\v\f]/u;
// Markdown 規格允許用反斜線跳脫的字元集合：所有 ASCII 標點。逐一跳脫之後，
// 區塊語法（井號、減號、大於、數字加點、圍欄）與行內語法（連結、強調、程式碼、原始 HTML、
// 字元參照）全部失去作用，而且文字解回來與原文相同。
const ASCII_PUNCT = /[!-/:-@[-`{-~]/gu;
const ESCAPED_ASCII_PUNCT = /\\([!-/:-@[-`{-~])/gu;
// 前後空白與定位字元也要擋：縮排四格就會變成程式碼區塊。
const EDGE_SPACE = /^\s|\s$|\t/u;
// 空字元不是標點、跳脫不了，而 Markdown 規格明定呈現時會把它換成別的字元——
// 也就是說本地解回來雖然一樣，讀者看到的卻不是原文。直接擋掉。
const hasNul = (s) => String(s).includes('\u0000');
// 規矩至少要有幾條，才算「這份資料還是一份規矩清單」（不是實際條數，寫死會漂）。
const MIN_RULES = 20;

function checkPlain(value, what, problems) {
  if (typeof value !== 'string') {
    problems.push(`${what} 不是字串（是 ${Array.isArray(value) ? '陣列' : typeof value}）：非字串會被硬轉成字串，可能夾帶換行`);
    return false;
  }
  if (value.trim() === '') {
    problems.push(`${what} 是空的`);
    return false;
  }
  if (LINE_BREAK.test(value)) {
    problems.push(`${what} 裡有換行：它會跑出自己該待的位置，在本文裡變成一段沒人數的正文`);
    return false;
  }
  if (EDGE_SPACE.test(value)) {
    problems.push(`${what} 的前後有空白、或裡面有定位字元：縮排會讓它變成程式碼區塊`);
    return false;
  }
  if (hasNul(value)) {
    problems.push(`${what} 裡有空字元：呈現時會被換成別的字元，讀者看到的就不是原文`);
    return false;
  }
  return true;
}

/** 資料契約。回傳問題清單；空陣列＝合格。產生器與考題共用這一份。 */
function validate(data) {
  const problems = [];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return ['rules.json 的最外層不是一個物件'];
  }
  checkPlain(data.title, '本文標題 title', problems);
  checkPlain(data.preamble, '開頭那句指路 preamble', problems);
  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    problems.push('rules.json 沒有任何小節');
    return problems;
  }
  const seenLetters = new Set();
  const seenIds = new Set();
  let count = 0;
  for (const section of data.sections) {
    const letter = section && section.letter;
    if (typeof letter !== 'string' || !/^[A-Z]$/u.test(letter)) {
      problems.push(`小節代號「${letter}」不是單一個大寫英文字母`);
      continue;
    }
    if (seenLetters.has(letter)) problems.push(`小節代號 ${letter} 重複了`);
    seenLetters.add(letter);
    checkPlain(section.title, `小節 ${letter} 的標題 title`, problems);
    if (!Array.isArray(section.rules)) {
      problems.push(`小節 ${letter} 沒有規矩清單`);
      continue;
    }
    section.rules.forEach((rule, i) => {
      const id = `${letter}${rule && rule.n}`;
      if (!Number.isInteger(rule && rule.n) || rule.n !== i + 1) {
        problems.push(`${id} 的編號不對：同一節裡要從 1 開始連號`);
      }
      if (seenIds.has(id)) problems.push(`條號 ${id} 重複了`);
      seenIds.add(id);
      checkPlain(rule && rule.text, `${id} 的正文 text`, problems);
      if (checkPlain(rule && rule.tag, `${id} 的執行者標籤 tag`, problems) && /[（）]/u.test(rule.tag)) {
        problems.push(`${id} 的執行者標籤裡有全形括號：標籤本來就被包在括號裡，再帶一個就能提早關掉它、後面長出沒人數的內容`);
      }
      count += 1;
    });
  }
  if (count < MIN_RULES) {
    problems.push(`只找到 ${count} 條規矩（至少要 ${MIN_RULES} 條）：資料整份變形的話字數會算成零、考題就變成永遠綠的空包彈`);
  }
  return problems;
}

/** 把一個欄位編成字面文字：語法由範本提供，資料不准有語法能力。 */
function literal(value) {
  return value.replace(ASCII_PUNCT, (ch) => `\\${ch}`);
}

/** 把字面文字解回原文。literal 與 plain 必須互為反函式，這一點由考題守。 */
function plain(value) {
  return value.replace(ESCAPED_ASCII_PUNCT, '$1');
}

/** 由資料產生本文的完整內容（換行一律用 \n）。資料不合契約就直接丟例外，不產生半成品。 */
function build(data) {
  const problems = validate(data);
  if (problems.length) {
    throw new Error(`rules.json 不合資料契約，沒有產生任何東西：\n- ${problems.join('\n- ')}`);
  }
  const out = [`# ${literal(data.title)}`, '', literal(data.preamble), ''];
  for (const section of data.sections) {
    out.push(`## ${section.letter}、${literal(section.title)}`);
    for (const rule of section.rules) {
      out.push(`- ${section.letter}${rule.n} ${literal(rule.text)}（${literal(rule.tag)}）`);
    }
    out.push('');
  }
  return out.join('\n');
}

function read() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

if (require.main === module) {
  const data = read();
  fs.writeFileSync(outFile, build(data), 'utf8');
  const n = data.sections.reduce((s, x) => s + x.rules.length, 0);
  process.stdout.write(`寫好 RULES.md：${data.sections.length} 節、${n} 條\n`);
}

module.exports = { build, read, validate, literal, plain, dataFile, outFile, MIN_RULES };
