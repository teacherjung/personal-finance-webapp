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
//   有探針從「擋」翻成「放行」＝那個詞被那支探針扣著（承重）；沒有任何一支翻＝沒有探針扣著它。
//   為什麼不用字串比對（「探針名字裡有沒有出現這個詞」）：名字裡出現不等於扣得住。
//   實測反例＝`cash`／`money`／`securities` 在 `withdrawCash`／`send_money`／`move_securities` 裡都出現過，
//   但把它們從正本拿掉，那些探針照樣被擋（別的判斷路徑先接住）＝字串層看起來有涵蓋、行為層沒有。
//
// 現況＝**沒有例外**：正本 verbs 38/38、nouns 30/30 每一個詞都有探針扣著。
//   ⚠️ 上一版這裡放了一張 13 個詞的「扣不住」例外名單，說它們「天生不可承重、兩張樣式表永遠先接住、
//   補探針也不承重」。**那是錯的，複審 r1 #1 反駁掉了**：那 13 個詞只是在原本兩種探針形狀
//   （`{動詞}_order`／`place_{名詞}`）下不承重，換個形狀各自都承重得起來；而且原因不只樣式表一種——
//   `withdrawal` 在動詞位是被**更短的同族動詞 `withdraw`** 接走（詞表互相涵蓋），把兩張樣式表都清空也一樣。
//   13 支換形狀的探針已補在 helper 的 `FORBIDDEN_FAMILY` 底部，例外名單因此整張刪掉。
//   教訓：量到的是「現有矩陣沒扣住」，不可以寫成「不可能扣住」。
//
// 守得到的：
//   ①正本加了新詞、探針矩陣沒跟上 ⇒ 那個詞變成沒有探針扣著 ⇒ 紅；
//   ②有人刪掉某個詞**所有**承重探針 ⇒ 紅；
//   ③出現第二條拒絕路徑把某個詞的承重探針接走（新增一條樣式、或詞表多一個更短的同族詞）⇒ 紅；
//   ④判準自己（三個對照組）：
//     ・②b 往正本塞一個誰都接不住的假詞要被抓到；
//     ・②c 拿掉某個詞的所有承重探針要被抓到；
//     ・②d **把判準退化成「名字裡有沒有出現這個詞」要被抓到**——這一個是 r2 #1 之後補的：
//       r2 實測把 `carriersOf` 換成 `probes.filter((p) => p.includes(word))`，那時候四題**全綠**
//       （因為兩欄的期望都是空集合、而每個詞都在某支探針名字裡出現過，字串查找跟行為量測剛好同答案）。
//       ②d 用一個「名字裡有、行為上不承重」的案例把那個反差重新做出來，所以那種突變會紅。
//       2026-09-29 自己在暫存複本做過這兩個突變、看的是 node --test 的退出碼（不是管線尾端的）：
//         ・換成字串查找 ⇒ 5 題裡只有 ②d 紅（基準／涵蓋／②b／②c 全綠），退出碼 1；
//         ・讓量測永遠回一支（每個詞都算「有涵蓋」）⇒ ②b／②c／②d 三題都紅，退出碼 1。
//       ⇒ 三個對照組抓的是不同的東西，②d 是唯一擋得住「退化成字串查找」的那一個。
//
// ⚠️ **這一題紅了不可以解讀成「攔截器變鬆」或「變嚴」**（r1 #2 抓到上一版把方向寫反）：
//   紅的意思只有一個——**某個詞的承重關係變了，去看為什麼**。可能的原因不只一種（r2 #4 抓到上一版
//   把原因寫得太窄，只列了「第二條拒絕路徑新增或消失」）：
//     ・正本加了新詞、探針沒跟上；
//     ・某個詞的承重探針被刪掉（r2 實測：只刪 `xfer_security` 一支，樣式表與判斷程式都沒動，
//       `security` 的承重集合就從一支變成空集合）；
//     ・出現或消失一條第二拒絕路徑（新增樣式、詞表多一個更短的同族詞）。
//   ⚠️ 而且「第二條拒絕路徑多一條」不等於整體變鬆、「少一條」不等於整體變嚴。r1 的實測反例：
//     ・臨時加一條樣式 `(^|_)xfer_[a-z]+(_|$)` ⇒ `xfer` 在**當時 102 支的矩陣下**變成未承重，
//       可是 `xfer_widget` 是**放行→拒絕**（更嚴）；
//     ・移除 patternsReadSafe 那兩條 securit 樣式 ⇒ `security` 在**當時 102 支的矩陣下**變成承重，
//       可是 `place_securitization` 是**拒絕→放行**（更鬆）。
//     （r2 提醒：這兩例的「承重變化」是 102 支那一版的狀態，本版 115 支下 `security` 本來就由
//      `xfer_security` 承重——所以這兩例要當歷史反例讀，不是本版的狀態轉換。方向那個結論不受影響。）
//
// 證不到的（照實寫）：
//   ・**正本自己對不對**：正本少一個該有的詞（例如某天出現新的出入金說法），本題不會紅——
//     那是 `tests/forbidden-defaults.test.js` ①（不准少於空白範本）與正本文件
//     `docs/money-guard-two-pattern-tables.md`「預設字彙表」那一節的射程。
//   ・**只涵蓋 verbs 與 nouns**：`readPrefixes` 由 `test/money-boundary.test.js` 的字面數字釘著，
//     `patterns`／`patternsReadSafe` 兩欄本題沒驗。
//   ・**不窮舉工具名**：每個詞只要有一支探針扣著就算涵蓋，不保證那個詞在所有寫法下都擋得住。
//   ・**多支承重探針**：對**那個詞**來說，只要還剩一支承重探針，就不會因為「那個詞沒涵蓋」而紅。
//     ⚠️ 但**整題仍可能紅**——被刪的那一支可能同時是**別的詞**唯一的承重探針。
//     r2 #1 實測：`xfer` 有三支（`xfer_order`、`xfer_security`、`xfer_securities`），只刪 `xfer_security`
//     雖然 xfer 還剩兩支，涵蓋題立刻紅、訊息指的是 `nouns: ["security"]`；只刪 `xfer_order` 才全綠。
//     上一版這裡寫「刪掉其中一支本題不會紅（只有全刪才紅）」，那是被本版資料直接反駁的全稱。
//   ・這一題跑的是行程內 `decide()`，**不是**真的鉤子：鉤子那一層在 `test/money-kit-hook.test.js`
//     與 `test/codex-global-hook.test.js`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FORBIDDEN_FAMILY, familyNetFixture, FAKE_UUID } from './helpers/money-family-probes.js';
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
 * 量承重：回傳每一欄「哪些詞沒有任何探針扣著」，以及每個詞的承重探針。
 * @param {any} forbidden 正本
 * @param {readonly string[]} probes 探針名字
 */
function measure(forbidden, probes) {
  const full = familyNetFixture(forbidden, probes);
  const blocked = probes.map((p) => decide(p, full).deny);
  /** @param {string} field @param {string} word @returns {string[]} */
  const carriersOf = (field, word) => {
    const less = familyNetFixture(
      { ...forbidden, [field]: forbidden[field].filter((/** @type {string} */ w) => w !== word) },
      probes,
    );
    return probes.filter((p, i) => blocked[i] && !decide(p, less).deny);
  };
  /** @type {Record<string, string[]>} */
  const uncarried = {};
  for (const field of FIELDS) {
    uncarried[field] = forbidden[field].filter((/** @type {string} */ w) => carriersOf(field, w).length === 0);
  }
  return { leaked: probes.filter((p, i) => !blocked[i]), uncarried, carriersOf };
}

test('基準：整批探針在夾具下一個都沒漏擋（漏擋的話下面的涵蓋量測沒有意義）', () => {
  const { leaked } = measure(projectForbidden(), FORBIDDEN_FAMILY);
  assert.deepEqual(leaked, [],
    `這幾個探針在家族網夾具下沒有被擋：${leaked.join('、')}`
    + '——涵蓋題靠「拿掉一個詞就從擋翻成放行」量承重，基準先漏擋的探針量不出東西');
});

test('涵蓋：正本 verbs／nouns 的每一個詞都有探針扣著，沒有例外', () => {
  const forbidden = projectForbidden();
  const { uncarried } = measure(forbidden, FORBIDDEN_FAMILY);
  for (const field of FIELDS) {
    assert.deepEqual(uncarried[field], [],
      `正本 forbidden.${field} 的這幾個詞沒有任何探針扣著：${JSON.stringify(uncarried[field])}\n`
      + `  （這一欄共 ${forbidden[field].length} 個詞，承重 ${forbidden[field].length - uncarried[field].length} 個）\n`
      + '  最常見的原因＝正本加了字、test/helpers/money-family-probes.js 的探針沒跟上：\n'
      + '    先試 FAMILY_VERBS／FAMILY_NOUNS（生成 {動詞}_order／place_{名詞}）；那兩種形狀不承重的，\n'
      + '    照 FORBIDDEN_FAMILY 底部那一段換形狀（加唯讀前綴、換動詞、名詞位倒裝都量過可行）。\n'
      + '  改完要一起改：EXPECTED_FORBIDDEN_FAMILY 的字面釘，以及 test/money-family-probes-integrity.test.js 的 sha256。\n'
      + '  ⚠️ 也可能是某個詞的承重探針被第二條拒絕路徑接走了（新增一條樣式、或詞表多一個更短的同族詞）。\n'
      + '     那**不代表攔截器變鬆**（也不代表變嚴）——先去看是哪一條路徑接走的，不要從這一題推鬆緊。');
  }
});

test('②b 判準自己：往正本塞一個誰都接不住的假詞，要被抓到（對照組）', () => {
  const forbidden = projectForbidden();
  const FAKE_WORD = 'zzzznobodycatchesthis';
  for (const field of FIELDS) {
    const salted = { ...forbidden, [field]: [...forbidden[field], FAKE_WORD] };
    assert.ok(measure(salted, FORBIDDEN_FAMILY).uncarried[field].includes(FAKE_WORD),
      `塞進 forbidden.${field} 的假詞「${FAKE_WORD}」沒有被量成「沒有探針扣著」`
      + '——量測失效（例如把整欄當成一定有涵蓋），這一題會變成空包彈');
  }
});

test('②d 判準自己：判準退化成「名字裡有沒有出現這個詞」要被抓到（對照組）', () => {
  const forbidden = projectForbidden();
  // 一個「名字裡有、行為上不承重」的案例——這個反差就是抓字串查找的鑰匙（r2 #1 之後補的）：
  //   ・探針名字裡出現 "security" ⇒ 換成字串查找會說 security 有涵蓋；
  //   ・但刪掉 nouns.security 之後這一支改由 patternsReadSafe 那張備援接住、照樣被擋
  //     ⇒ 行為量測說 security 沒有探針扣著。兩邊答案相反。
  const PROBE = [`${FAKE_UUID}place_security`];
  assert.ok(PROBE[0].toLowerCase().includes('security'),
    '對照組的前提壞了：探針名字裡要真的出現 security，字串查找才會給出相反的答案');

  const { leaked, uncarried } = measure(forbidden, PROBE);
  assert.deepEqual(leaked, [], '對照組的前提壞了：那一支探針在家族網夾具下要先被擋');
  assert.ok(uncarried.nouns.includes('security'),
    '行為量測沒有把 security 判成「沒有探針扣著」——判準可能已經退化成「名字裡有沒有出現這個詞」'
    + '（r2 #1：那種退化在補完探針之後不會被涵蓋題本身抓到，要靠這一題）');
});

test('②c 判準自己：拿掉某個詞的所有承重探針，那個詞要變成沒有探針扣著（對照組）', () => {
  const forbidden = projectForbidden();
  const { carriersOf } = measure(forbidden, FORBIDDEN_FAMILY);
  // 挑 cash_out：2026-09-29 補進來的字之一，量到只有 cash_out_order 這一支扣著它。
  // 這裡不釘「剛好一支」（xfer 就有三支，釘死會在補探針時假紅），改成把量到的全部拿掉。
  const carriers = carriersOf('verbs', 'cash_out');
  assert.ok(carriers.length > 0, '對照組的前提壞了：完整探針表下 cash_out 本來就該有探針扣著');

  const without = FORBIDDEN_FAMILY.filter((p) => !carriers.includes(p));
  assert.equal(without.length, FORBIDDEN_FAMILY.length - carriers.length, '拿掉承重探針時算錯了張數');
  assert.ok(measure(forbidden, without).uncarried.verbs.includes('cash_out'),
    `拿掉扣著 cash_out 的那 ${carriers.length} 支探針（${carriers.map((p) => p.split('__').pop()).join('、')}）之後，`
    + 'cash_out 沒有變成「沒有探針扣著」——這一題量的不是探針表，刪探針不會紅');
});
