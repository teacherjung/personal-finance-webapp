// 守三支產生器的**資料契約本身**（2026-09-13 稽核補的）。
//
// 為什麼要另立一支：原本每支產生器只有「產物跟重新產生的結果逐字元相同」那一題。
// 那題證明的是「今天的資料配今天的檢查，產出今天的檔」——**檢查本身被拿掉也照樣成立**。
// 稽核把三支的契約逐條短路掉（validate 開頭直接回空、值域檢查刪掉、正則放寬），二十四發突變
// 全部存活、全卷仍然全綠。所以這一支反過來考：**餵壞資料進去，一定要丟例外或列出問題**。
//
// 守得到的：每一條契約檢查各有一發壞資料釘著；產生器拿到壞資料不產生半成品。
// ⚠️ 守不到的：資料填的內容對不對（合格不代表那條規矩寫得好）；也不宣稱這些檢查涵蓋了所有壞寫法。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../tools/build-rules.js');
const settings = require('../tools/build-settings.js');
const casebook = require('../tools/build-casebook-index.js');

const NUL = '\u0000';
const LINE_SEP = '\u2028';

/** 一份最小的合格規矩資料；改一格就拿去當壞資料。 */
function goodRules() {
  const section = (letter, n) => ({
    letter,
    title: `第 ${letter} 節`,
    rules: Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `這是 ${letter}${i + 1} 的正文`, tag: '靠自覺' })),
  });
  return { title: '標題', preamble: '指路那一句', sections: [section('A', 10), section('B', 10)] };
}
const mutate = (fn) => { const d = goodRules(); fn(d); return d; };

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
    identityDomain: '值域', accountRule: '資格', mainBranch: 'main', mergeAuthorization: '預授權',
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
