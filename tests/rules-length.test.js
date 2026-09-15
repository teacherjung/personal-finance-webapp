// 守「本文一頁」這條：規矩正文去掉空白後不得超過 3,000 字。
//
// 裁示者 2026-09-12 先定「一頁，約三千字」，同日再裁：**只數規矩本身**——
// 節標題、開頭那句指路、條號、句尾的執行者標籤都不算，因為那些是標示、不是規矩。
//
// ⚠️ 這一題前七版都在自己判斷「RULES.md 的哪幾行算規矩」，等於用土法重做 Markdown
//    的呈現規則，**連七輪被獨立審查者用不同寫法繞過去**：換星號、換有序清單、縮排、
//    Tab、不換行空白、引言記號、七個井號、CR 換行。每一次我都補一種寫法，每一次都
//    撐不到下一輪。實作者在自問表裡寫下停損線：再有一種新的漏算，就不再補寫法、改成
//    「規矩存成資料、本文由它產生」。第七輪的 CR 換行觸發了它。
//
// **所以現在沒有「哪幾行算規矩」這個問題**：規矩住在 rules.json，一則一筆；RULES.md 是產物。
//
// ⚠️ 但只有「由資料產生」還不夠。第八輪實測出下一層：**不計字的欄位會跑出它該待的位置**——
//    小節標題裡塞一個換行，後面那段就變成獨立的正文段落、完全不計字；句尾標籤裡先關括號再換行，
//    就能長出一整條沒人數的新規矩。兩種都不必動本文、產物也照樣同步。所以真正的收口是
//    **資料契約**（build-rules.js 的 validate）：每個會被輸出的欄位都要是單行純文字，
//    標籤不准帶全形括號。契約只有那一份，考題與產生器共用。
//
// 這一題守五件，全部量得到、不必猜任何呈現規則：
//   ①資料合契約（單行、非空、前後不帶空白，欄位不會跑出自己的位置）；
//   ②**字面編碼是完整的**：每個欄位編出去以後不留任何未跳脫的 ASCII 標點，而且解回來
//     與原文逐字元相同（語法只能由固定範本提供，文字本身不會被改掉）；
//   ③字數：直接加總資料裡每一條的正文；
//   ④每條的執行者標籤以一個**已定義**的名字開頭；
//   ⑤那份定義的正本在 MACHINES.md，這裡跟它對帳，兩邊不可以各寫各的；
//   ⑥**RULES.md 必須與產生結果逐字元相同**——手改本文就紅。
//
// ⚠️ 守不到的照實說：第⑥件只證明**本文與資料同步**，不能單靠它推出前面幾件（早一版的註解
//    這樣寫，被實測推翻）。還有一整類機器永遠看不到：作者把語意上的新規矩寫成一個仍然合格的
//    小節標題或射程說明——那要靠人與獨立審查者。這一題也不宣稱「任何未來的改法都繞不過」。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, read, validate, literal, plain, dataFile, outFile, MIN_RULES } = require('../tools/build-rules.js');

const LIMIT = 3000;
const machinesFile = path.join(__dirname, '..', 'MACHINES.md');
// MACHINES.md 裡那張定義表的開頭，用來定位（標籤的正本只有那一份）。
const LABEL_TABLE_ANCHOR = '句尾的執行者標籤，定義在這裡、只在這裡';

/** 從 MACHINES.md 抽出已定義的執行者名字；抽不到就讓這題紅，不要默默放行。 */
function definedLabels() {
  const text = fs.readFileSync(machinesFile, 'utf8');
  const at = text.indexOf(LABEL_TABLE_ANCHOR);
  assert.ok(at >= 0, `MACHINES.md 找不到執行者標籤定義表的開頭（「${LABEL_TABLE_ANCHOR}」）：抽不到名單就不能判標籤合不合法`);
  const labels = [];
  for (const line of text.slice(at).split('\n')) {
    if (!line.startsWith('|')) {
      if (labels.length) break;
      continue;
    }
    const first = line.split('|')[1].trim();
    if (!first || first.startsWith('---') || first === '標籤') continue;
    labels.push(first);
  }
  assert.ok(labels.length >= 2, `MACHINES.md 的執行者標籤表只抽到 ${labels.length} 個名字：表的形狀變了`);
  return labels;
}

/** 把資料攤平成一條一筆。契約由 build-rules.js 的 validate 說了算，這裡不另寫一份。 */
function allRules(data) {
  const rules = [];
  for (const section of data.sections) {
    for (const rule of section.rules) {
      rules.push({ id: `${section.letter}${rule.n}`, text: rule.text, tag: rule.tag });
    }
  }
  return rules;
}

test('rules.json 合資料契約（欄位不會跑出自己的位置）', () => {
  assert.deepEqual(validate(read()), [], '資料不合契約');
});

function everyField(data) {
  const fields = [
    ['本文標題', data.title],
    ['開頭那句指路', data.preamble],
  ];
  for (const section of data.sections) {
    fields.push([`小節 ${section.letter} 的標題`, section.title]);
    for (const rule of section.rules) {
      fields.push([`${section.letter}${rule.n} 的正文`, rule.text]);
      fields.push([`${section.letter}${rule.n} 的標籤`, rule.tag]);
    }
  }
  return fields;
}

test('每個欄位都被編成字面文字：沒有漏跳脫的標點，而且解回來與原文相同', () => {
  const data = read();
  assert.deepEqual(validate(data), [], '資料不合契約，編碼檢查不算數');
  for (const [what, value] of everyField(data)) {
    const encoded = literal(value);
    assert.equal(plain(encoded), value, `${what} 編過再解回來跟原文不一樣：編碼把文字改掉了`);
    const leaked = encoded.replace(/\\[!-/:-@[-`{-~]/gu, '').match(/[!-/:-@[-`{-~]/u);
    assert.equal(leaked, null, `${what} 編出去之後還留著沒跳脫的標點「${leaked && leaked[0]}」：它在本文裡還有語法能力`);
  }
});

test('本文裡的每一條解回來，就是資料裡的那一條', () => {
  const data = read();
  const lines = build(data).split('\n').filter((l) => l.startsWith('- '));
  const expected = [];
  for (const section of data.sections) {
    for (const rule of section.rules) expected.push(`- ${section.letter}${rule.n} ${rule.text}（${rule.tag}）`);
  }
  assert.deepEqual(lines.map(plain), expected, '產出的規矩行解回來跟資料對不上');
});

test('規矩正文不超過 3,000 字（標題、條號、句尾標籤不算）', () => {
  const data = read();
  assert.deepEqual(validate(data), [], '資料不合契約，字數算出來不算數');
  const rules = allRules(data);
  assert.ok(rules.length >= MIN_RULES, `只找到 ${rules.length} 條規矩：契約的地板是 ${MIN_RULES}`);
  const count = rules.reduce((n, r) => n + Array.from(r.text.replace(/\s+/g, '')).length, 0);
  assert.ok(
    count <= LIMIT,
    `規矩正文現在 ${count} 字（${rules.length} 條），上限 ${LIMIT}：加一條要先砍一條`,
  );
});

test('每條規矩的執行者標籤都以一個已定義的名字開頭', () => {
  const labels = definedLabels();
  const data = read();
  assert.deepEqual(validate(data), [], '資料不合契約，標籤檢查不算數');
  for (const rule of allRules(data)) {
    assert.ok(
      labels.some((l) => rule.tag.startsWith(l)),
      `${rule.id} 的標籤「${rule.tag}」沒有以已定義的執行者名字開頭（${labels.join('／')}）`,
    );
  }
});

test('RULES.md 與 rules.json 產生的結果逐字元相同（本文是產物、不要手改）', () => {
  const onDisk = fs.readFileSync(outFile, 'utf8');
  assert.equal(
    onDisk,
    build(read()),
    `RULES.md 跟 ${path.basename(dataFile)} 對不上：本文是產物，要改規矩請改資料再跑 node tools/build-rules.js`,
  );
});
