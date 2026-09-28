// 守三支產生器的**資料契約本身**（2026-09-13 稽核補的）。
//
// 為什麼要另立一支：原本每支產生器只有「產物跟重新產生的結果逐字元相同」那一題。
// 那題證明的是「今天的資料配今天的檢查，產出今天的檔」——**檢查本身被拿掉也照樣成立**。
// 稽核把三支的契約逐條短路掉（validate 開頭直接回空、值域檢查刪掉、正則放寬），二十四發突變
// 全部存活、全卷仍然全綠。所以這一支反過來考：**餵壞資料進去，一定要丟例外或列出問題**。
//
// 守得到的：每一條契約檢查各有一發壞資料釘著；產生器拿到壞資料不產生半成品。
// 規矩本文的**範本形狀**（條號在最前、子點縮排與編號、標籤前後空行、記號原樣保住、記號外跳脫）
// 也在這裡用一份最小資料正向釘住：rules-length 那題的 plain(build)===buildRaw 與 build 共用同一份範本，
// 證明不了範本本身對不對；真資料有沒有子點、有沒有記號是資料碰巧決定的，不能靠它撐。量過（r1、r2）：拿掉形狀題，子點縮排、子點編號、子點與標籤之間的空行就沒有別題釘；條號格式與標籤後的空行仍由產物逐字元題釘（真資料沒有子點、但每條都有標籤）、角色粗體仍由 inline 題釘——所以形狀題是子點結構唯一的直接輸出樣本，不是整個範本的唯一一張網。
// ⚠️ 守不到的：資料填的內容對不對（合格不代表那條規矩寫得好）；也不宣稱這些檢查涵蓋了所有壞寫法。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../tools/build-rules.js');
const settings = require('../tools/build-settings.js');
const casebook = require('../tools/build-casebook-index.js');

const NUL = '\u0000';
const LINE_SEP = '\u2028';

/**
 * 一份最小的合格規矩資料；改一格就拿去當壞資料。A 節最後一條帶子點與兩種記號（對照組：合格的記號真的放行）。
 * 主句、第一個子點、標籤三處各放一個記號外的 ASCII 標點：真資料記號外帶不帶 ASCII 標點是資料碰巧決定的，
 * 換一批資料「記號以外走 literal」就可能沒有考題守；三處都放，主句、子點、標籤各自用哪個編碼器才各有一發釘著。
 * 最後一個子點是「回到第一層之後的第二層編號」：釘住第二層計數在換父項時歸零（不歸零會產出從 2 起數的清單）。
 */
const ROLES = ['擁有者', '裁示者', '實作者', '複審者', '掃描者', '掃描發射者'];
function goodRules() {
  const section = (letter, n) => ({
    letter,
    title: `第 ${letter} 節`,
    rules: Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `這是 ${letter}${i + 1} 的正文`, tag: '靠自覺' })),
  });
  const rich = {
    n: 11,
    text: '**擁有者** 說 `沒有` 就是沒有；見 K2-3',
    items: [
      { text: '第一點，**實作者** 照做 (不問)' },
      { text: '第二層一', level: 2 },
      { text: '第二層二', level: 2, numbered: true },
      { text: '編號一', numbered: true },
      { text: '編號二', numbered: true },
      { text: '編號下的第二層', level: 2, numbered: true },
    ],
    tag: '雲端：只驗 **實作者** 那一欄；照抄 `未執行：<原因>`；見 K2-3',
  };
  // 寬位數父項（「10. 」四格）底下的第二層、連續的第二層編號、明寫 level:1：單位數樣本釘不住可變寬度（r1 第 2 條）。
  const wide = {
    n: 12,
    text: '寬位數',
    items: [
      ...Array.from({ length: 10 }, () => ({ text: '項', numbered: true })),
      { text: '子', level: 2, numbered: true },
      { text: '丑', level: 2, numbered: true },
      { text: '明寫一層', level: 1 },
    ],
    tag: '靠自覺',
  };
  const a = section('A', 10);
  a.rules.push(rich, wide);
  return { title: '標題', preamble: '指路那一句', roles: ROLES.slice(), sections: [a, section('B', 10)] };
}
const mutate = (fn) => { const d = goodRules(); fn(d); return d; };
/** 那條帶子點與記號的規矩（A11）。 */
const richRule = (d) => d.sections[0].rules[10];

test('基準：這份最小資料真的合格（對照組，證明下面的紅不是因為資料本來就壞）', () => {
  assert.deepEqual(rules.validate(goodRules()), []);
  assert.doesNotThrow(() => rules.build(goodRules()));
});

test('規矩資料的每一條契約，各有一發壞資料釘著', () => {
  const cases = [
    ['最外層不是物件', null],
    ['最外層是陣列', []],
    ['標題不是字串', mutate((d) => { d.title = 42; })],
    ['標題是空的', mutate((d) => { d.title = '   '; })],
    ['指路那句有換行', mutate((d) => { d.preamble = '前\n後'; })],
    ['指路那句有分行符號', mutate((d) => { d.preamble = `前${LINE_SEP}後`; })],
    ['正文前後有空白', mutate((d) => { d.sections[0].rules[0].text = ' 前面有空白'; })],
    ['正文裡有定位字元', mutate((d) => { d.sections[0].rules[0].text = '有\t定位字元'; })],
    ['正文裡有空字元', mutate((d) => { d.sections[0].rules[0].text = `有${NUL}空字元`; })],
    ['標籤裡有全形括號', mutate((d) => { d.sections[0].rules[0].tag = '考題（其實會提早關掉標籤）'; })],
    ['小節代號不是單一大寫字母', mutate((d) => { d.sections[0].letter = 'aa'; })],
    ['小節代號重複', mutate((d) => { d.sections[1].letter = 'A'; })],
    ['小節標題是空的', mutate((d) => { d.sections[0].title = ''; })],
    ['條號不連號', mutate((d) => { d.sections[0].rules[3].n = 99; })],
    ['條號不是整數', mutate((d) => { d.sections[0].rules[3].n = 3.5; })],
    ['沒有任何小節', mutate((d) => { d.sections = []; })],
    ['小節沒有規矩清單', mutate((d) => { delete d.sections[0].rules; })],
    ['規矩總數低於下限（整份變形時字數會算成零）', mutate((d) => { d.sections = [d.sections[0]]; d.sections[0].rules = d.sections[0].rules.slice(0, 3); })],
  ];
  for (const [name, data] of cases) {
    assert.ok(rules.validate(data).length > 0, `「${name}」應該被契約擋下來`);
    assert.throws(() => rules.build(data), /不合資料契約/u, `「${name}」不可以產生半成品`);
  }
});

test('A1 範本加進來的每一條契約（子點、兩種記號、白名單、角色名單、條號記號），各有一發壞資料釘著', () => {
  const cases = [
    ['子點清單不是陣列', mutate((d) => { richRule(d).items = { text: '子點' }; })],
    ['子點有換行', mutate((d) => { richRule(d).items[0].text = '前\n後'; })],
    ['子點的層級是 3', mutate((d) => { richRule(d).items[1].level = 3; })],
    ['第二層排在第一個', mutate((d) => { richRule(d).items[0].level = 2; })],
    ['numbered 不是布林（字串）', mutate((d) => { richRule(d).items[0].numbered = 'yes'; })],
    ['numbered 不是布林（數字）', mutate((d) => { richRule(d).items[0].numbered = 1; })],
    ['規矩有不認得的欄位（items 打成 item＝整批子點靜靜不產出）', mutate((d) => { const r = richRule(d); r.item = r.items; delete r.items; })],
    ['子點有不認得的欄位', mutate((d) => { richRule(d).items[0].lvl = 2; })],
    ['小節有不認得的欄位', mutate((d) => { d.sections[0].rule = []; })],
    ['最外層有不認得的欄位', mutate((d) => { d.role = ROLES.slice(); })],
    ['粗體包的不是角色名', mutate((d) => { richRule(d).text = '**外人** 說話'; })],
    // 粗體內容「等於」角色名是 **…** 與原始 HTML 之間唯一的一道牆：比對鬆成「包含」或「開頭／結尾是」，
    // 藏在角色名旁邊的字就原樣落地。下面四發各釘一種鬆法（後面多字、前面多字、帶空白、只是角色名的一部分）。
    ['粗體含角色名但後面多字', mutate((d) => { richRule(d).text = '**擁有者甲** 說'; })],
    ['粗體含角色名但前面多字', mutate((d) => { richRule(d).text = '**甲擁有者** 說'; })],
    ['粗體含角色名但帶著空白', mutate((d) => { richRule(d).text = '**擁有者 說**'; })],
    ['粗體只是角色名的一部分', mutate((d) => { richRule(d).text = '**擁有** 說'; })],
    ['粗體包的是角色名，但沒有登記角色名單', mutate((d) => { delete d.roles; })],
    ['記號外落單的 *', mutate((d) => { richRule(d).text = '3 * 4 ＝ 12'; })],
    ['記號外兩個 *', mutate((d) => { richRule(d).text = '**擁有者** 之後多了 **'; })],
    ['落單的反引號', mutate((d) => { richRule(d).text = '一個 ` 反引號'; })],
    ['空的框', mutate((d) => { richRule(d).text = '`` 空的'; })],
    ['三個反引號', mutate((d) => { richRule(d).text = '```'; })],
    ['框內有反斜線', mutate((d) => { richRule(d).text = '照抄 `a\\b`'; })],
    ['框內前後帶空白', mutate((d) => { richRule(d).text = '照抄 ` 沒有 `'; })],
    ['兩個粗體緊貼', mutate((d) => { richRule(d).text = '**擁有者****實作者**'; })],
    ['粗體與框緊貼', mutate((d) => { richRule(d).text = '**擁有者**`沒有`'; })],
    ['子點裡記號外的 *', mutate((d) => { richRule(d).items[0].text = '子點 * 星號'; })],
    ['標籤裡粗體包的不是角色名', mutate((d) => { richRule(d).tag = '雲端：**外人**'; })],
    ['角色名單不是陣列', mutate((d) => { d.roles = '擁有者'; })],
    // 壞角色名用 push 一個沒人引用的名字：改 roles[0] 的話 A11 的 **擁有者** 會同時被「沒登記」擋下，
    // 角色名值域那道檢查拿掉考題照綠。三發各釘一種：全形標點（值域是字母數字、不是「非 ASCII」）、
    // ASCII 標點（拼得出原始 HTML）、空白。
    ['角色名帶標點（全形）', mutate((d) => { d.roles.push('外人。'); })],
    ['角色名帶標點（ASCII，拼得出原始 HTML）', mutate((d) => { d.roles.push('外<b>人'); })],
    ['角色名帶空白', mutate((d) => { d.roles.push('外 人'); })],
    ['角色名重複', mutate((d) => { d.roles.push('擁有者'); })],
    ['開頭指路帶【】', mutate((d) => { d.preamble = '【Z9】看起來像一條規矩、卻不計字'; })],
    ['本文標題帶【】', mutate((d) => { d.title = '標題【Z9】'; })],
    ['小節標題帶【】', mutate((d) => { d.sections[0].title = '第 A 節【Z9】'; })],
    ['標籤帶【】', mutate((d) => { richRule(d).tag = '靠自覺【Z9】'; })],
  ];
  for (const [name, data] of cases) {
    assert.ok(rules.validate(data).length > 0, `「${name}」應該被契約擋下來`);
    assert.throws(() => rules.build(data), /不合資料契約/u, `「${name}」不可以產生半成品`);
    assert.throws(() => rules.countRules(data), /不合資料契約/u, `「${name}」不可以算字數`);
  }
});

test('字數函式：主句與子點都算、只扣合格記號的 ** 與反引號、「」照算、空白不算', () => {
  // 把 A11 換成指定的主句與子點，再減掉「A11 只有一個字、沒有子點」的基準，得到的就是那一條自己的字數。
  const base = rules.countRules(mutate((d) => { const r = richRule(d); r.text = '字'; delete r.items; })) - 1;
  const charsOf = (text, items) => rules.countRules(mutate((d) => { const r = richRule(d); r.text = text; if (items) r.items = items; else delete r.items; })) - base;
  assert.equal(charsOf('主句'), 2, '對照組：主句自己');
  assert.equal(charsOf('主句', [{ text: '子點一' }, { text: '子點二', level: 2 }, { text: '子點三', numbered: true }]), 2 + 3 + 3 + 3, '子點要算進去');
  assert.equal(charsOf('**擁有者** 說 `沒有`'), 6, '合格記號的 ** 與反引號不算字、中間的空白不算');
  assert.equal(charsOf('「擁有者」說「沒有」'), 10, '「」照算');
  assert.equal(charsOf('a b c'), 3, '空白不算');
  assert.equal(charsOf('主句', [{ text: '**實作者** 照做' }]), 2 + 5, '子點裡的記號一樣只扣記號');
  // r1 第 1 條：只扣「合格記號」——灰底框裡的星號是要照抄的正文，不是記號。少了這兩發，把 join 之後再把 ** 全部拿掉的錯法照樣全綠，
  // 一個裝滿星號的框就能把超長本文算成沒超過。
  assert.equal(charsOf('`**外人**`'), 6, '灰底框裡的 ** 是正文，照算');
  assert.equal(charsOf('主句', [{ text: '`****`' }]), 2 + 4, '子點的灰底框裡只有星號，四個都算');
  assert.equal(charsOf('𝟘𝟙'), 2, '算的是碼位不是 UTF-16 單元（一個非 BMP 字算 1）');
});

test('字數函式：標題、開頭指路、小節標題、條號、標籤都不算（不靠相減——相減時這幾欄兩邊相同會抵消）', () => {
  // A1〜A10、B1〜B10 各 7 字（A10、B10 各 8 字）＝142；A11 主句 16、子點 13＋4＋4＋3＋3＋7＝50；A12 主句 3、子點 10×1＋1＋1＋4＝16。手算，不由程式重算一次。
  const expected = 142 + 16 + 13 + 4 + 4 + 3 + 3 + 7 + 3 + 10 + 1 + 1 + 4;
  assert.equal(rules.countRules(goodRules()), expected, '對照組：這份最小資料的字數');
  const longer = '拉得很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長';
  assert.equal(rules.countRules(mutate((d) => { d.title = `標題${longer}`; })), expected, '本文標題不算');
  assert.equal(rules.countRules(mutate((d) => { d.preamble = `指路${longer}`; })), expected, '開頭指路不算');
  assert.equal(rules.countRules(mutate((d) => { d.sections[0].title = `第 A 節${longer}`; })), expected, '小節標題不算');
  assert.equal(rules.countRules(mutate((d) => { for (const r of d.sections[0].rules) r.tag = `靠自覺${longer}`; })), expected, '標籤不算');
  assert.equal(rules.countRules(mutate((d) => { richRule(d).tag = `雲端：${longer} **實作者** \`${longer}\``; })), expected, '標籤裡的記號也不算');
});

test('inline：記號以外的每個 ASCII 標點都跳脫、記號原樣放行、粗體裡的字也跳脫（不靠資料剛好帶標點）', () => {
  assert.equal(rules.inline('a-b **擁有者** `x.y`', ROLES), 'a\\-b **擁有者** `x.y`');
  // 全部 ASCII 標點扣掉 * 與反引號（那兩個在記號外由契約擋、進不了 inline）
  const punct = '!"#$%&\'()+,-./:;<=>?@[\\]^_{|}~';
  assert.equal(rules.inline(`${punct} **擁有者** ${punct}`, ROLES), `${rules.literal(punct)} **擁有者** ${rules.literal(punct)}`);
  // 框內再扣掉反斜線：框內不跳脫，帶反斜線的框解回來就不是原文——那正是契約擋它的理由
  const inBox = punct.replace('\\', '');
  assert.equal(rules.plain(rules.inline(`${punct} **擁有者** \`${inBox}\``, ROLES)), `${punct} **擁有者** \`${inBox}\``, '解回來與原文相同');
  // 保險：粗體內容也走 literal。合格角色名只有字母數字、這一步對它零改動；「粗體內容＝登記角色名」那道比對
  // 哪天鬆掉，塞在角色名旁邊的語法至少不會原樣落地。這裡直接餵帶標點的名單，不經 validate。
  assert.equal(rules.inline('**a<b>** 說', ['a<b>']), '**a\\<b\\>** 說');
  assert.equal(rules.plain(rules.inline('**a<b>** 說', ['a<b>'])), '**a<b>** 說');
});

test('A1 範本的形狀：條號在最前、子點攤開、第二層縮排＝父項記號寬度、編號換種類就重數、換父項第二層歸零、標籤獨立一行且前後各空一行、主句子點標籤記號外跳脫', () => {
  const md = rules.build(goodRules());
  assert.ok(md.startsWith('# 標題\n\n指路那一句\n\n## A、第 A 節\n\n【A1】這是 A1 的正文\n\n（靠自覺）\n\n【A2】'), '開頭與沒有子點的那一條');
  const rich = [
    '【A11】**擁有者** 說 `沒有` 就是沒有；見 K2\\-3',
    '',
    '- 第一點，**實作者** 照做 \\(不問\\)',
    '  - 第二層一',
    '  1. 第二層二',
    '1. 編號一',
    '2. 編號二',
    '   1. 編號下的第二層',
    '',
    '（雲端：只驗 **實作者** 那一欄；照抄 `未執行：<原因>`；見 K2\\-3）',
    '',
    '【A12】寬位數',
  ].join('\n');
  assert.ok(md.includes(rich), `帶子點的那一條產出來不是預期的形狀：\n${md.slice(md.indexOf('【A11】'), md.indexOf('【A12】'))}`);
  const wide = [
    '【A12】寬位數',
    '',
    ...Array.from({ length: 10 }, (_, i) => `${i + 1}. 項`),
    '    1. 子',
    '    2. 丑',
    '- 明寫一層',
    '',
    '（靠自覺）',
    '',
    '## B、第 B 節',
  ].join('\n');
  assert.ok(md.includes(wide), `寬位數父項那一條產出來不是預期的形狀（第二層要縮「10. 」的四格、連續編號、明寫 level:1 仍是第一層）：\n${md.slice(md.indexOf('【A12】'), md.indexOf('## B、'))}`);
  assert.ok(md.endsWith('（靠自覺）\n'), '結尾是最後一條的標籤加一個換行');
  assert.equal(rules.plain(md), rules.buildRaw(goodRules()), '解回來就是範本填上原文');
});

test('字面編碼與解碼互為反函式，而且每一個 ASCII 標點都真的被跳脫', () => {
  const punct = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  const encoded = rules.literal(punct);
  assert.equal(rules.plain(encoded), punct, '解回來要跟原文一樣');
  for (const ch of punct) {
    assert.ok(encoded.includes(`\\${ch}`), `${ch} 沒有被跳脫`);
  }
  assert.equal(rules.literal('沒有標點的字'), '沒有標點的字');
});

/** 一份最小的合格設定；改一格就拿去當壞資料。 */
function goodSettings() {
  return {
    identityDomain: '值域', accountRule: '資格', mainBranch: 'main', defaultDivision: { implementer: 'A', reviewer: 'B' },
    participants: [{ role: '裁示者', id: 'W', account: 'w' }],
    sources: [{ tool: '工具', string: '來源' }],
    locations: [{ item: '項目', rules: 'A1', where: '位置' }],
    scanner: { tool: '未設定', assignedBy: '未設定', tieBreak: '未設定', fallback: '未設定', isolation: { provider: '未設定', wrap: [], boxRoot: '未設定', forbidden: [] } },
    gates: [{ name: '閘', rules: 'H1', command: 'node', args: ['g.js'], state: '未移植' }],
    mergeCommand: { command: '未設定', args: [] },
    machines: [{ name: '機器', rules: 'A1', state: '未移植', verified: '' }],
  };
}
const mutateS = (fn) => { const d = goodSettings(); fn(d); return d; };

test('設定資料的每一條契約，各有一發壞資料釘著', () => {
  assert.doesNotThrow(() => settings.build(goodSettings()), '基準：這份設定應該產得出來');
  const cases = [
    ['欄位不是字串', mutateS((d) => { d.participants[0].id = 7; })],
    ['欄位是空的', mutateS((d) => { d.participants[0].role = ''; })],
    ['欄位有換行', mutateS((d) => { d.accountRule = '前\n後'; })],
    ['欄位有空字元', mutateS((d) => { d.identityDomain = `有${NUL}空字元`; })],
    ['隔離提供者不在值域裡', mutateS((d) => { d.scanner.isolation.provider = '隨便寫的'; })],
    ['閘的狀態不在三種裡', mutateS((d) => { d.gates[0].state = '大概好了'; })],
    ['機器的狀態不在三種裡', mutateS((d) => { d.machines[0].state = '應該可以'; })],
    ['預設分工整欄不見（產生器要明寫這一欄：不認得的欄位它不會自己排出來）', mutateS((d) => { delete d.defaultDivision; })],
    ['預設分工的複審者是空的', mutateS((d) => { d.defaultDivision.reviewer = ''; })],
  ];
  for (const [name, data] of cases) {
    assert.throws(() => settings.build(data), undefined, `「${name}」應該被契約擋下來`);
  }
});

test('設定的值域清單本身沒有被偷偷放寬', () => {
  assert.deepEqual(settings.STATES, ['未移植', '已安裝未啟用', '已啟用']);
  assert.deepEqual(settings.PROVIDERS, ['未設定', '無', '工具自帶', '專案自建']);
});

/** 一則最小的合格案例；改一行就拿去當壞資料。 */
const GOOD_CASE = [
  '# 這是標題',
  '',
  '- 日期：2026-09-13',
  '- 本文條號：A1、B2',
  '- 發生什麼：一句話',
  '- 代價：一句話',
  '- 教訓：一句話',
  '- 來源：一句話',
  '',
].join('\n');

test('案例形狀的每一條契約，各有一發壞資料釘著', () => {
  assert.doesNotThrow(() => casebook.parseCase(GOOD_CASE, 'good-case.md'), '基準：這則案例應該讀得過');
  const swap = (i, line) => { const l = GOOD_CASE.split('\n'); l[i] = line; return l.join('\n'); };
  const cases = [
    ['第一行不是標題', swap(0, '這是標題'), 'good-case.md'],
    ['六欄的順序被換掉', swap(2, '- 本文條號：A1'), 'good-case.md'],
    // ⚠️ 這一格只有「欄位在不在它該在的位置」那道檢查抓得到：兩欄都是合格的散文，
    //    日期、條號、檔名的正則全都過得去。上面那一格其實是被日期正則順手擋下來的（突變驗過）。
    ['兩個散文欄對調（其餘檢查一律過得去）', (() => {
      const l = GOOD_CASE.split('\n');
      [l[4], l[6]] = [l[6], l[4]];
      return l.join('\n');
    })(), 'good-case.md'],
    ['少一欄', GOOD_CASE.split('\n').filter((l) => !l.startsWith('- 來源')).join('\n'), 'good-case.md'],
    ['標題是空的', swap(0, '# '), 'good-case.md'],
    ['日期不是 YYYY-MM-DD', swap(2, '- 日期：2026/9/13'), 'good-case.md'],
    ['日期是空的', swap(2, '- 日期：'), 'good-case.md'],
    ['條號寫法不合', swap(3, '- 本文條號：A1,B2'), 'good-case.md'],
    ['條號小寫', swap(3, '- 本文條號：a1'), 'good-case.md'],
    ['檔名有大寫', GOOD_CASE, 'Good-Case.md'],
    ['檔名有底線', GOOD_CASE, 'good_case.md'],
  ];
  for (const [name, text, file] of cases) {
    assert.throws(() => casebook.parseCase(text, file), undefined, `「${name}」應該被契約擋下來`);
  }
});

test('案例索引的散文欄位也走同一份契約', () => {
  for (const bad of [42, '', '   ', '前\n後', `有${NUL}空字元`, ' 前後有空白 ']) {
    assert.throws(() => casebook.checkPlain(bad, '測試欄位'), undefined, `${JSON.stringify(bad)} 應該被擋下來`);
  }
  assert.equal(casebook.checkPlain('正常的一句話', '測試欄位'), '正常的一句話');
});
