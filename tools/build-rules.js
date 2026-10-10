#!/usr/bin/env node
// 從 rules.json 產生 RULES.md。**本文是產物、不要手改**：手改會被 tests/rules-length.test.js 抓到。
//
// 為什麼要產生：字數上限那道考題原本得自己判斷「RULES.md 的哪幾行算規矩」，等於用土法重做
// Markdown 的呈現規則——連七輪被複審者用不同寫法繞過（項目符號、有序清單、縮排、Tab、
// 不換行空白、引言記號、七個井號、CR 換行）。改成由資料產生之後，就沒有「哪幾行算規矩」
// 這個問題：字數直接對資料算，本文只要跟產生結果逐字元相同即可。
//
// ⚠️ 但「由資料產生」本身不夠，而且不夠的地方有兩層：
//   第八輪：**不計字的欄位可以跑出它該待的位置**——小節標題裡塞一個換行，後面那段就變成
//   獨立的正文段落、完全不計字；標籤裡先關括號再換行，就長出一整條沒人數的新規矩。
//   第九輪：**「單行」不等於「純文字」**——同一個欄位不必換行，只要塞原始 HTML
//   （`</h2><p>…</p><h2>`）、字元參照（`&#65289;`）或三個反引號，一樣能開出新的區塊、
//   關掉既有的位置、甚至把後面整份本文吃進程式碼區塊。
//   第十輪：只換掉**幾個**危險字元也還是黑名單——有序清單、縮排圍欄、連結語法照樣有效，
//   而且我在行首多加的那一層反斜線會把文字本身改掉、解回來就不是原文。
//
// 所以收口是兩件一起做，缺一不可：
//   ①**資料契約**（validate）：每個會被輸出的欄位都要是單行、非空、前後不帶空白的字串；
//   ②**輸出時把資料編成字面文字**（literal）：**記號以外的所有 ASCII 標點一律加反斜線跳脫**——
//     這不是「危險字元黑名單」，是 Markdown 規格說了算的完整集合（反斜線加 ASCII 標點＝
//     那個字元的字面值）。標點全部失去語法能力，語法就只能由固定範本＋兩種登記記號提供：
//     粗體 **…** 只放行登記在 roles 裡的角色名、灰底框 `…` 只放行成對的單反引號（tokenize／inline），
//     記號以外的字元照舊全部跳脫；而且解回來（plain）與原文逐字元相同，不會像上一版那樣把文字改掉。
//     ⚠️ 這個「逐字元相同」只保證**本地解回來**：呈現器對空字元另有規定的替換，所以空字元
//     由契約直接擋掉；別的呈現差異不在這一支的保證範圍內。
//   換成 A1 範本（條號在最前、子點攤開、標籤獨立一行、兩種記號）之後，十輪攻擊各自靠什麼保住：
//     第八輪：每個會輸出的欄位（含每一個子點）照舊單行；標籤照舊禁全形括號；【】禁入 title、preamble、
//       小節標題、標籤這幾個不計字的欄位——條號記號是全形字、literal 不跳脫它，放行的話開頭指路
//       就能寫成外觀像規矩、卻不計字的段落。
//     第九輪：記號以外照舊全跳脫；粗體內容只剩字母數字（角色名的值域）；框內的字 CommonMark
//       不認 HTML、字元參照、跳脫；記號以外的反引號一律擋、不偷偷跳脫（三個反引號因此開不了圍欄）。
//     第十輪：literal／plain 一字不動；考題逐欄證明 plain(inline(s)) === s，整份證明
//       plain(build(data)) === buildRaw(data)（解回來的本文就是「範本填上原文」，多不出任何東西）。
//       ⚠️ 那道整份等式的射程：build 與 buildRaw 共用同一份範本，它只證明 build 沒在範本之外多／少東西，
//       證明不了範本本身對不對（標籤前有沒有空行、子點縮幾格、粗體有沒有保住）——範本的形狀由
//       tests/data-contract.test.js 的形狀題用最小資料釘、不依賴正式資料剛好含有哪些形狀：拿掉它，子點縮排、子點編號、
//       子點與標籤之間的空行就沒有別題釘；條號格式與標籤後的空行仍有產物逐字元題、角色粗體仍有 inline 題
//       （2026-09 原專案複審時量的，限當時那一版的資料），所以它不是規格外加、也不是整個範本唯一的網。
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
// 條號記號是全形字、literal 不會跳脫它：不計字的欄位裡放行的話，開頭指路就能寫成外觀像規矩的段落。
const RULE_MARK = /[【】]/u;
// 角色名的值域：只剩字母與數字，粗體記號裡就放不進任何有語法能力的字元。
const ROLE_NAME = /^[\p{L}\p{N}]+$/u;
// 兩種登記記號：粗體 **…**（內容不含星號與反引號）、成對的單反引號框（內容不含反引號）。
// 這裡只切出形狀；內容合不合格（角色有沒有登記、框裡有沒有反斜線或前後空白）由 tokenize 判。
// 拿它去掃**編過的**文字也安全：記號以外的星號與反引號已經被 literal 跳脫、拼不出這兩種形狀。
const MARK = /\*\*([^*`]+)\*\*|`([^`]+)`/gu;
// 規矩至少要有幾條，才算「這份資料還是一份規矩清單」（不是實際條數，寫死會漂）。
const MIN_RULES = 20;
// 每一層物件准許的欄位。欄名打錯（items 寫成 item）不會報錯、只會讓整批子點靜靜不產出也不計字，
// 所以不認得的鍵一律當問題。
const KEYS = {
  top: ['title', 'preamble', 'roles', 'sections'],
  section: ['letter', 'title', 'rules'],
  rule: ['n', 'text', 'items', 'tag'],
  item: ['text', 'level', 'numbered'],
};

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

/** 不計字的欄位不准帶條號記號：那幾個欄位輸出時只走 literal，【】會原樣落地、外觀跟一條規矩沒兩樣。 */
function checkNoRuleMark(value, what, problems) {
  if (RULE_MARK.test(value)) {
    problems.push(`${what} 裡有【】：條號記號不跳脫，這個欄位不計字，放行就能寫出外觀像規矩、卻沒人數的段落`);
  }
}

function checkKeys(obj, allowed, what, problems) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      problems.push(`${what} 有不認得的欄位「${key}」（只准 ${allowed.join('、')}）：欄名打錯的話那一欄會靜靜不產出、也不計字`);
    }
  }
}

/**
 * 把一個欄位切成「記號以外的文字／角色粗體／灰底框」三種段落。
 * 合格的記號只有兩種形狀；形狀對了內容還要合格，不合格的一律列進 problems、不偷偷跳脫——
 * 落單的星號或反引號如果只是被跳脫掉，作者看到的本文會跟他寫的意思不一樣、卻沒有任何機器出聲。
 */
function tokenize(value, roles, what, problems) {
  const segments = [];
  let last = 0;
  let prevEnd = -1;
  for (const m of value.matchAll(MARK)) {
    if (m.index > last) segments.push({ kind: 'text', value: value.slice(last, m.index) });
    if (m.index === prevEnd) {
      problems.push(`${what}：兩個記號緊貼（「${m[0]}」直接接在上一個記號後面）：呈現器會把它們讀成別的東西`);
    }
    if (m[1] !== undefined) {
      if (!roles.includes(m[1])) {
        problems.push(`${what}：粗體「${m[1]}」不是登記的角色名（roles 只有 ${roles.length ? roles.join('、') : '空'}）：粗體只放行角色名，別的字不進記號`);
      }
      segments.push({ kind: 'role', value: m[1] });
    } else {
      if (/^\s|\s$/u.test(m[2])) {
        problems.push(`${what}：灰底框「${m[0]}」的內容前後帶空白：呈現器會把那個空白吃掉，讀者照抄的就不是資料裡的字`);
      }
      if (m[2].includes('\\')) {
        problems.push(`${what}：灰底框「${m[0]}」裡有反斜線：框內不跳脫，解回來會跟原文不同`);
      }
      segments.push({ kind: 'code', value: m[2] });
    }
    last = m.index + m[0].length;
    prevEnd = last;
  }
  if (last < value.length) segments.push({ kind: 'text', value: value.slice(last) });
  for (const seg of segments) {
    if (seg.kind === 'text' && /[*`]/u.test(seg.value)) {
      problems.push(`${what}：記號以外有星號或反引號（「${seg.value}」）：落單的記號不放行、也不偷偷跳脫`);
    }
  }
  return segments;
}

/** 資料契約。回傳問題清單；空陣列＝合格。產生器與考題共用這一份。 */
function validate(data) {
  const problems = [];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return ['rules.json 的最外層不是一個物件'];
  }
  checkKeys(data, KEYS.top, 'rules.json 的最外層', problems);
  if (checkPlain(data.title, '本文標題 title', problems)) checkNoRuleMark(data.title, '本文標題 title', problems);
  if (checkPlain(data.preamble, '開頭那句指路 preamble', problems)) checkNoRuleMark(data.preamble, '開頭那句指路 preamble', problems);
  const roles = [];
  if (data.roles !== undefined) {
    if (!Array.isArray(data.roles)) {
      problems.push('roles 不是陣列：角色名單讀不到，所有粗體都會被當成沒登記');
    } else {
      data.roles.forEach((role, i) => {
        if (typeof role !== 'string' || !ROLE_NAME.test(role)) {
          problems.push(`第 ${i + 1} 個角色名「${role}」不合法：只准字母與數字（不帶標點、空白），粗體記號裡才放不進語法`);
        } else if (roles.includes(role)) {
          problems.push(`角色名「${role}」重複登記`);
        } else {
          roles.push(role);
        }
      });
    }
  }
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
    checkKeys(section, KEYS.section, `小節 ${letter}`, problems);
    if (checkPlain(section.title, `小節 ${letter} 的標題 title`, problems)) checkNoRuleMark(section.title, `小節 ${letter} 的標題 title`, problems);
    if (!Array.isArray(section.rules)) {
      problems.push(`小節 ${letter} 沒有規矩清單`);
      continue;
    }
    section.rules.forEach((rule, i) => {
      const id = `${letter}${rule && rule.n}`;
      if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
        problems.push(`小節 ${letter} 的第 ${i + 1} 條不是一個物件`);
        return;
      }
      checkKeys(rule, KEYS.rule, `${id}`, problems);
      if (!Number.isInteger(rule.n) || rule.n !== i + 1) {
        problems.push(`${id} 的編號不對：同一節裡要從 1 開始連號`);
      }
      if (seenIds.has(id)) problems.push(`條號 ${id} 重複了`);
      seenIds.add(id);
      if (checkPlain(rule.text, `${id} 的正文 text`, problems)) tokenize(rule.text, roles, `${id} 的正文 text`, problems);
      if (rule.items !== undefined) {
        if (!Array.isArray(rule.items)) {
          problems.push(`${id} 的子點 items 不是陣列：不是陣列就沒有任何子點會產出、也不計字`);
        } else {
          rule.items.forEach((item, k) => {
            const what = `${id} 的第 ${k + 1} 個子點`;
            if (item === null || typeof item !== 'object' || Array.isArray(item)) {
              problems.push(`${what} 不是一個物件`);
              return;
            }
            checkKeys(item, KEYS.item, what, problems);
            if (checkPlain(item.text, `${what} 的正文 text`, problems)) tokenize(item.text, roles, `${what} 的正文 text`, problems);
            if (item.level !== undefined && item.level !== 1 && item.level !== 2) {
              problems.push(`${what} 的層級 level 是 ${item.level}：只准 1 或 2（省略＝1），再深的層級本文不收`);
            }
            if (k === 0 && item.level === 2) {
              problems.push(`${what} 就是第二層：沒有父項可縮進去，縮排四格會變成程式碼區塊`);
            }
            if (item.numbered !== undefined && typeof item.numbered !== 'boolean') {
              problems.push(`${what} 的 numbered 不是布林：真假以外的值會讓「有沒有編號」憑猜`);
            }
          });
        }
      }
      if (checkPlain(rule.tag, `${id} 的執行者標籤 tag`, problems)) {
        if (/[（）]/u.test(rule.tag)) {
          problems.push(`${id} 的執行者標籤裡有全形括號：標籤本來就被包在括號裡，再帶一個就能提早關掉它、後面長出沒人數的內容`);
        }
        checkNoRuleMark(rule.tag, `${id} 的執行者標籤 tag`, problems);
        tokenize(rule.tag, roles, `${id} 的執行者標籤 tag`, problems);
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

/**
 * 主句、子點、標籤的編碼：記號原樣放行、記號以外走 literal。
 * 只在資料已經過 validate 之後才有意義（這裡不再判內容合不合格）；記號本身沒有反斜線，
 * 所以 plain 解回來仍然是原文——這一點由考題逐欄證明。
 * 粗體裡的角色名也走 literal：合格角色名只有字母數字、literal 對它是零改動，但 tokenize 那句
 * 「粗體內容＝登記角色名」是 **…** 與原始 HTML 之間唯一的一道牆；比對哪天鬆成「包含」，
 * 塞在角色名旁邊的 <b>、連結、字元參照就會原樣落地，而外洩檢查把整個記號連內容一起拿掉、看不見它。
 * 框內不跳脫：CommonMark 在行內程式碼裡不認反斜線，跳脫了解回來就不是原文（框內反斜線由契約擋）。
 */
function inline(value, roles = []) {
  return tokenize(value, roles, '', [])
    .map((seg) => (seg.kind === 'role' ? `**${literal(seg.value)}**` : seg.kind === 'code' ? `\`${seg.value}\`` : literal(seg.value)))
    .join('');
}

function throwIfInvalid(data, doing) {
  const problems = validate(data);
  if (problems.length) {
    throw new Error(`rules.json 不合資料契約，${doing}：\n- ${problems.join('\n- ')}`);
  }
}

/**
 * 規矩正文的字數，照 MACHINES.md 的 K2 那一列寫的數法算（數法只寫在那裡）。資料不合契約就丟例外：
 * 不合格的記號會不會被扣、子點是不是陣列，都不該由字數函式自己猜。
 */
function countRules(data) {
  throwIfInvalid(data, '字數不算數');
  const roles = data.roles || [];
  const chars = (value) => Array.from(tokenize(value, roles, '', []).map((seg) => seg.value).join('').replace(/\s+/gu, '')).length;
  let count = 0;
  for (const section of data.sections) {
    for (const rule of section.rules) {
      count += chars(rule.text);
      for (const item of rule.items || []) count += chars(item.text);
    }
  }
  return count;
}

/**
 * 子點的行。編號在同一層、同一種類裡連號，種類換了就重數（換了種類呈現器本來就會開新清單）；
 * 回到第一層時第二層的計數也歸零：下一個父項底下的第二層是另一份清單，有序清單的起始號＝
 * 第一項寫的數字，續數的話讀者會看到一份從 2 起數的清單。
 * 第二層縮排＝父項記號的寬度，因為呈現器認的是父項內容的起始欄，少一格就掉出父項、變成頂層清單。
 */
function itemLines(items, rich) {
  const lines = [];
  const counters = { 1: 0, 2: 0 };
  const kinds = { 1: null, 2: null };
  let parentMark = '';
  for (const item of items) {
    const level = item.level || 1;
    const kind = item.numbered ? 'ordered' : 'bullet';
    if (level === 1) {
      counters[2] = 0;
      kinds[2] = null;
    }
    if (kinds[level] !== kind) counters[level] = 0;
    kinds[level] = kind;
    counters[level] += 1;
    const mark = kind === 'ordered' ? `${counters[level]}. ` : '- ';
    if (level === 1) {
      parentMark = mark;
      lines.push(`${mark}${rich(item.text)}`);
    } else {
      lines.push(`${' '.repeat(parentMark.length)}${mark}${rich(item.text)}`);
    }
  }
  return lines;
}

/**
 * A1 範本（擁有者定案的版面）。build 與 buildRaw 只差編碼器，範本只有這一份：
 * 考題拿 plain(build(data)) === buildRaw(data) 證明本文解回來就是「範本填上原文」。
 * 標籤前一定空一行，否則它會被當成上一個子點的續行；標籤後也空一行，否則下一條的主句會黏成同一段。
 */
function render(data, codec) {
  const roles = data.roles || [];
  const field = (value) => codec.field(value);
  const rich = (value) => codec.rich(value, roles);
  const out = [`# ${field(data.title)}`, '', field(data.preamble), ''];
  for (const section of data.sections) {
    out.push(`## ${section.letter}、${field(section.title)}`, '');
    for (const rule of section.rules) {
      out.push(`【${section.letter}${rule.n}】${rich(rule.text)}`, '');
      const items = rule.items || [];
      if (items.length) out.push(...itemLines(items, rich), '');
      out.push(`（${rich(rule.tag)}）`, '');
    }
  }
  return out.join('\n');
}

/** 由資料產生本文的完整內容（換行一律用 \n）。資料不合契約就直接丟例外，不產生半成品。 */
function build(data) {
  throwIfInvalid(data, '沒有產生任何東西');
  return render(data, { field: literal, rich: inline });
}

/** 同一份範本、識別編碼（欄位原樣放進去）：只給考題當對照，不寫檔。 */
function buildRaw(data) {
  throwIfInvalid(data, '沒有對照可產');
  return render(data, { field: (value) => value, rich: (value) => value });
}

function read() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

if (require.main === module) {
  const data = read();
  fs.writeFileSync(outFile, build(data), 'utf8');
  const n = data.sections.reduce((s, x) => s + x.rules.length, 0);
  process.stdout.write(`寫好 RULES.md：${data.sections.length} 節、${n} 條、規矩正文 ${countRules(data)} 字\n`);
}

module.exports = { build, buildRaw, read, validate, tokenize, inline, literal, plain, countRules, MARK, dataFile, outFile, MIN_RULES };
