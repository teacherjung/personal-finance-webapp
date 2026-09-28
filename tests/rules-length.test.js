// 守本文 K2：規矩正文不得超過 7,000 字（哪些字算、哪些不算只寫在 MACHINES.md 的 K2 那一列）。
//
// 裁示者 2026-09-12 先定「一頁，約三千字」，同日再裁：**只數規矩本身**——
// 節標題、開頭那句指路、條號、執行者標籤都不算，因為那些是標示、不是規矩。
// 裁示者 2026-09-25 放寬到四千、09-26 再放寬到七千，同時拿掉「加一條要先砍一條」、改成新條要過進門五問。
// 版面（擁有者定案的 A1 範本）：條號【X1】在最前面、子點攤開成清單、標籤獨立在最後一行；
// 主句、子點、標籤裡只放行兩種登記記號——**登記的角色名**與成對反引號的灰底框。
//
// ⚠️ 這一題前七版都在自己判斷「RULES.md 的哪幾行算規矩」，等於用土法重做 Markdown
//    的呈現規則，**連七輪被複審者用不同寫法繞過去**：換星號、換有序清單、縮排、
//    Tab、不換行空白、引言記號、七個井號、CR 換行。每一次我都補一種寫法，每一次都
//    撐不到下一輪。實作者在自問表裡寫下停損線：再有一種新的漏算，就不再補寫法、改成
//    「規矩存成資料、本文由它產生」。第七輪的 CR 換行觸發了它。
//
// **所以現在沒有「哪幾行算規矩」這個問題**：規矩住在 rules.json，一則一筆；RULES.md 是產物。
//
// ⚠️ 但只有「由資料產生」還不夠。第八輪實測出下一層：**不計字的欄位會跑出它該待的位置**——
//    小節標題裡塞一個換行，後面那段就變成獨立的正文段落、完全不計字；標籤裡先關括號再換行，
//    就能長出一整條沒人數的新規矩。兩種都不必動本文、產物也照樣同步。所以真正的收口是
//    **資料契約**（build-rules.js 的 validate）：每個會被輸出的欄位（含每一個子點）都要是單行純文字，
//    標籤不准帶全形括號，不計字的欄位不准帶條號記號【】，記號以外不准有落單的星號或反引號。
//    契約只有那一份，考題與產生器共用。
//
// 這一題守六件，全部量得到、不必猜任何呈現規則：
//   ①資料合契約（單行、非空、前後不帶空白，欄位不會跑出自己的位置；記號只有登記的那兩種）；
//   ②**字面編碼是完整的**：每個欄位編出去以後，拿掉合格記號，不留任何未跳脫的 ASCII 標點，
//     而且解回來與原文逐字元相同（語法只能由固定範本與兩種記號提供，文字本身不會被改掉）；
//   ③整份本文解回來就是「範本填上原文」（plain(build) === buildRaw），多不出任何東西——
//     射程：build 與 buildRaw 共用同一份範本，這一件只證明 build 沒在範本之外多／少東西，
//     證明不了範本本身對不對；範本的形狀由 tests/data-contract.test.js 的形狀題釘；
//   ④字數：由 countRules 直接對資料算（主句＋子點、去空白、只扣合格記號）；
//   ⑤每條的執行者標籤以一個**已定義**的名字開頭，那份定義的正本在 MACHINES.md，這裡跟它對帳；
//   ⑥**RULES.md 必須與產生結果逐字元相同**——手改本文就紅。
//
// ⚠️ 守不到的照實說：第⑥件只證明**本文與資料同步**，不能單靠它推出前面幾件（早一版的註解
//    這樣寫，被實測推翻）。還有一整類機器永遠看不到：作者把語意上的新規矩寫成一個仍然合格的
//    小節標題或射程說明——那要靠人與複審者。版面約定（角色兩旁留空、每處角色都粗體、
//    標籤裡不框）也刻意不檢查：留空純屬版面，不留空也呈現成粗體——CommonMark 的 `**`（不像 `__`）
//    允許貼著字用，角色名值域只有字母數字、兩個記號緊貼又由契約擋掉，所以每個 `**` 都能開或關
//    （照規格推的，本機沒有呈現器可驗）。這一題也不宣稱「任何未來的改法都繞不過」。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, buildRaw, read, validate, inline, literal, plain, countRules, MARK, dataFile, outFile, MIN_RULES } = require('../tools/build-rules.js');

const LIMIT = 7000;
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

/** 把資料攤平成一條一筆（子點跟著）。契約由 build-rules.js 的 validate 說了算，這裡不另寫一份。 */
function allRules(data) {
  const rules = [];
  for (const section of data.sections) {
    for (const rule of section.rules) {
      rules.push({ id: `${section.letter}${rule.n}`, text: rule.text, items: (rule.items || []).map((item) => item.text), tag: rule.tag });
    }
  }
  return rules;
}

test('rules.json 合資料契約（欄位不會跑出自己的位置）', () => {
  assert.deepEqual(validate(read()), [], '資料不合契約');
});

/**
 * 每個會被輸出的欄位，配上產生器對它用的那一個編碼器：標題那幾欄只走 literal（沒有記號可拿掉）；
 * 主句、子點、標籤走 inline（第三格＝true，外洩檢查前先拿掉合格記號）。
 */
function everyField(data) {
  const fields = [
    ['本文標題', data.title, false],
    ['開頭那句指路', data.preamble, false],
  ];
  for (const section of data.sections) {
    fields.push([`小節 ${section.letter} 的標題`, section.title, false]);
    for (const rule of section.rules) {
      fields.push([`${section.letter}${rule.n} 的正文`, rule.text, true]);
      (rule.items || []).forEach((item, k) => fields.push([`${section.letter}${rule.n} 的第 ${k + 1} 個子點`, item.text, true]));
      fields.push([`${section.letter}${rule.n} 的標籤`, rule.tag, true]);
    }
  }
  return fields;
}

test('每個欄位都被編成字面文字：拿掉合格記號後沒有漏跳脫的標點，而且解回來與原文相同', () => {
  const data = read();
  assert.deepEqual(validate(data), [], '資料不合契約，編碼檢查不算數');
  const roles = data.roles || [];
  for (const [what, value, rich] of everyField(data)) {
    const encoded = rich ? inline(value, roles) : literal(value);
    assert.equal(plain(encoded), value, `${what} 編過再解回來跟原文不一樣：編碼把文字改掉了`);
    // 合格記號只在走 inline 的欄位裡；資料已過契約，編過的文字裡拼得出記號形狀的就只有它們
    const outside = rich ? encoded.replace(MARK, '') : encoded;
    const leaked = outside.replace(/\\[!-/:-@[-`{-~]/gu, '').match(/[!-/:-@[-`{-~]/u);
    assert.equal(leaked, null, `${what} 編出去之後還留著沒跳脫的標點「${leaked && leaked[0]}」：它在本文裡還有語法能力`);
  }
});

test('整份本文解回來，就是範本填上資料裡的原文（多不出任何東西）', () => {
  const data = read();
  assert.equal(plain(build(data)), buildRaw(data), '本文解回來跟「範本填上原文」對不上：本文裡多了或少了東西');
});

test('規矩正文不超過 7,000 字（數法見 MACHINES.md 的 K2 那一列）', () => {
  const data = read();
  assert.deepEqual(validate(data), [], '資料不合契約，字數算出來不算數');
  const rules = allRules(data);
  assert.ok(rules.length >= MIN_RULES, `只找到 ${rules.length} 條規矩：契約的地板是 ${MIN_RULES}`);
  const count = countRules(data);
  assert.ok(
    count <= LIMIT,
    `規矩正文現在 ${count} 字（${rules.length} 條），上限 ${LIMIT}（本文 K2）：先瘦身；新條要過進門五問（問法在協作套件倉庫 README.md 的「進門規則」）`,
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
