// @ts-check
// 正本詞表 ⟷ 探針矩陣的涵蓋題（裁示者 2026-09-29 裁 a：「加一道題，斷言複本必須涵蓋正本；
//   以後正本加字、複本沒跟上就變紅」）。
//
// 為什麼要有這一題：錢的詞表正本＝根目錄 settings.json 的 forbidden（verbs／nouns）。
//   `test/helpers/money-family-probes.js` 為了機械生成探針，另外抄了一份承重字表複本。
//   2026-09-29 量到那份複本已經落後：套件 #17 的預設字彙表把正本加到 verbs 38／nouns 30，
//   複本停在 25／18，而**沒有任何考題會因為正本長大而轉紅**——
//     ・`tests/forbidden-defaults.test.js` ① 只擋「專案的清單比空白範本少」（縮水方向）；
//     ・`test/money-family-probes-integrity.test.js` 只比複本自己的位元組（複本沒動就是綠的）；
//     ・走夾具的家族網矩陣題只斷言 `FORBIDDEN_FAMILY.length` 等於字面釘，那個釘跟正本無關。
//   ⇒ 正本 ⟷ 空白範本 ⟷ 專案設定這三環都有考題鎖著，唯獨「探針複本」這一環沒鎖。本題補的就是這一環。
//
// 判準＝**行為**不是字串：對正本的每一個詞，把它從清單裡拿掉再讓 decide() 重判整批探針——
//   有探針從「擋」翻成「放行」＝那個詞被探針扣著（承重）；沒有任何一個翻＝沒有探針扣著它。
//   為什麼不用字串比對（「探針名字裡有沒有出現這個詞」）：名字裡出現不等於扣得住。
//   實測反例＝`cash`／`money`／`securities` 在 `withdrawCash`／`send_money`／`move_securities` 裡都出現過，
//   但把它們從正本拿掉，那些探針照樣被擋（兩張樣式表先接住）＝字串層看起來有涵蓋、行為層沒有。
//
// 守得到的：
//   ①正本加了新詞、探針矩陣沒跟上 ⇒ 那個詞出現在「沒有探針扣著」那一組 ⇒ 與下面的字面釘對不上、紅；
//   ②反方向也抓：某個詞本來扣得住、後來**被第二條路接住了**（＝判斷變鬆）⇒ 它移進「扣不住」那一組 ⇒ 紅；
//   ③某個詞的第二條路消失（＝判斷變嚴）⇒ 它移出那一組 ⇒ 紅，提醒把字面釘一起改；
//   ④有人刪掉探針 ⇒ 它扣的那個詞掉進「扣不住」 ⇒ 紅；
//   ⑤判準自己（②b／②c 兩個對照組）：往正本塞一個誰都接不住的假詞要被抓到、
//     拿掉某個詞唯一的那支探針也要被抓到——證明這一題不是空包彈。
//
// 證不到的（照實寫）：
//   ・**正本自己對不對**：正本少一個該有的詞（例如某天出現新的出入金說法），本題不會紅——
//     那是 `tests/forbidden-defaults.test.js` ①（不准少於空白範本）與正本文件
//     `docs/money-guard-two-pattern-tables.md`「預設字彙表」那一節的射程。
//   ・**readPrefixes／patterns／patternsReadSafe 三欄沒驗**：本題只涵蓋 verbs 與 nouns（探針生成規則只吃這兩欄）。
//     唯讀前綴由 `test/money-boundary.test.js` 的 `EXPECTED_READ_VERBS_COUNT` 那一題以字面數字釘著。
//   ・**扣不住的那 13 個詞不是缺口**：它們的探針被兩張樣式表先接住＝雙重涵蓋（冗餘），
//     不是「沒有在擋」。本題基準那一段已經斷言整批探針一個都沒漏擋。
//   ・這一題跑的是行程內 `decide()`，**不是**真的鉤子：鉤子那一層在 `test/money-kit-hook.test.js`
//     與 `test/codex-global-hook.test.js`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FORBIDDEN_FAMILY, familyNetFixture } from './helpers/money-family-probes.js';
import forbiddenTools from '../tools/forbidden-tools.js';

const { decide } = forbiddenTools;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 正本＝根目錄 settings.json 的 forbidden 那一塊（跟攔截器真的讀的是同一份）。 */
function projectForbidden() {
  return JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8')).forbidden;
}

/** 本題只涵蓋這兩欄（探針生成規則只吃它們）；理由見檔頭「證不到的」。 */
const FIELDS = /** @type {const} */ (['verbs', 'nouns']);

/**
 * 沒有任何探針扣著的詞：把 word 從 forbidden[field] 拿掉，整批探針裡沒有任何一個從「擋」翻成「放行」。
 * @param {any} forbidden 正本
 * @param {readonly string[]} probes 探針名字
 * @returns {Record<string, string[]>} 逐欄的清單（順序照正本，方便跟字面釘逐字比）
 */
function wordsNoProbeCarries(forbidden, probes) {
  const full = familyNetFixture(forbidden, probes);
  const blocked = probes.map((p) => decide(p, full).deny);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const field of FIELDS) {
    out[field] = forbidden[field].filter((/** @type {string} */ word) => {
      const less = { ...forbidden, [field]: forbidden[field].filter((/** @type {string} */ w) => w !== word) };
      const lessFixture = familyNetFixture(less, probes);
      return !probes.some((p, i) => blocked[i] && !decide(p, lessFixture).deny);
    });
  }
  return out;
}

/**
 * 沒有探針扣得住的詞（字面釘，順序照正本）——**這不是缺口是冗餘**：
 * 這些詞的探針（`{動詞}_order`／`place_{名詞}`）被 `patterns`／`patternsReadSafe` 那兩張樣式表先接住，
 * 所以把詞從正本拿掉，探針照樣被擋 ⇒ 探針天生扣不住它們。2026-09-29 逐一實測。
 * ⚠️ 這張表要縮短（某個詞變成扣得住了）只有兩種可能：補了新探針，或**判斷變嚴了**；
 *    要變長＝正本加了新詞沒補探針，或**判斷變鬆了**（某個詞多出第二條路）。兩個方向都該有人看一眼。
 */
const UNCARRIABLE = Object.freeze({
  // 出入金那一族：`patterns` 第一張（transfer|withdraw(al)?|deposit|remit(tance)?|payout|disburse(ment)?|payment|wire）整族接住
  verbs: ['withdraw', 'withdrawal', 'transfer', 'deposit', 'remit', 'wire', 'disburse'],
  // security／securities 由 `patternsReadSafe` 接住；其餘四個同上那張 `patterns`
  nouns: ['security', 'securities', 'transfer', 'withdrawal', 'payment', 'payout'],
});

test('基準：整批探針在夾具下一個都沒漏擋（漏擋的話下面的涵蓋量測沒有意義）', () => {
  const forbidden = projectForbidden();
  const fixture = familyNetFixture(forbidden, FORBIDDEN_FAMILY);
  const leaked = FORBIDDEN_FAMILY.filter((p) => !decide(p, fixture).deny);
  assert.deepEqual(leaked, [],
    `這幾個探針在家族網夾具下沒有被擋：${leaked.join('、')}`
    + '——涵蓋題靠「拿掉一個詞就從擋翻成放行」量承重，基準先漏擋的探針量不出東西');
});

test('涵蓋：正本 verbs／nouns 的每一個詞都有探針扣著，扣不住的那幾個逐字等於字面釘', () => {
  const forbidden = projectForbidden();
  const measured = wordsNoProbeCarries(forbidden, FORBIDDEN_FAMILY);
  for (const field of FIELDS) {
    assert.deepEqual(measured[field], UNCARRIABLE[field],
      `正本 forbidden.${field} 裡「沒有任何探針扣著」的詞跟本題的字面釘對不上。\n`
      + `  量到：${JSON.stringify(measured[field])}\n`
      + `  釘的：${JSON.stringify(UNCARRIABLE[field])}\n`
      + '  多出來的詞＝正本加了字、test/helpers/money-family-probes.js 的 FAMILY_VERBS／FAMILY_NOUNS 沒跟上'
      + '（補進去、EXPECTED_FORBIDDEN_FAMILY 跟著改、那個 helper 的位元組絆線 sha256 也要重算）；'
      + '也可能是判斷變鬆了（那個詞多出第二條路）——先分清是哪一種再改這張表');
  }
});

test('②b 判準自己：往正本塞一個誰都接不住的假詞，要被抓到（對照組）', () => {
  const forbidden = projectForbidden();
  const FAKE_WORD = 'zzzznobodycatchesthis';
  for (const field of FIELDS) {
    const salted = { ...forbidden, [field]: [...forbidden[field], FAKE_WORD] };
    const measured = wordsNoProbeCarries(salted, FORBIDDEN_FAMILY);
    assert.ok(measured[field].includes(FAKE_WORD),
      `塞進 forbidden.${field} 的假詞「${FAKE_WORD}」沒有被量成「沒有探針扣著」`
      + '——量測失效（例如改成字串比對、或把整欄當成一定有涵蓋），這一題會變成空包彈');
  }
});

test('②c 判準自己：拿掉某個詞唯一的那支探針，那個詞要掉進「扣不住」（對照組）', () => {
  const forbidden = projectForbidden();
  // `xfer` 只有 `xfer_order` 這一支探針扣著（2026-09-29 補進來的那批之一）
  const carrier = FORBIDDEN_FAMILY.filter((p) => p.endsWith('__xfer_order'));
  assert.equal(carrier.length, 1, `預期只有一支探針以 xfer_order 結尾，實際 ${carrier.length} 支：${carrier.join('、')}`);
  const without = FORBIDDEN_FAMILY.filter((p) => p !== carrier[0]);

  assert.ok(!wordsNoProbeCarries(forbidden, FORBIDDEN_FAMILY).verbs.includes('xfer'),
    '對照組的前提壞了：完整探針表下 xfer 本來就該是扣得住的');
  assert.ok(wordsNoProbeCarries(forbidden, without).verbs.includes('xfer'),
    `拿掉唯一扣著 xfer 的探針（${carrier[0]}）之後，xfer 沒有掉進「沒有探針扣著」`
    + '——這一題量的不是探針表，刪探針不會紅');
});
