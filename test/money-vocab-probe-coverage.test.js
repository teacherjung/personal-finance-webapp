// @ts-check
// 錢的詞表正本 ⟷ 探針矩陣的涵蓋題（裁示者 2026-09-29 裁 a）。
//
// 為什麼：詞表正本＝`settings.json` 的 `forbidden`。`test/helpers/money-family-probes.js` 為了機械生成
//   探針另抄了一份承重字表，而那份複本落後正本時**沒有任何考題會紅**——`tests/forbidden-defaults.test.js` ①
//   只擋「專案比空白範本少」，`test/money-family-probes-integrity.test.js` 只比複本自己的位元組，
//   走夾具的矩陣題只比 `FORBIDDEN_FAMILY.length` 等於字面釘（那個釘跟正本無關）。本題補這一環。
//
// 判準＝行為，不是字串：把某個詞從正本拿掉、重判整批探針，有探針從「擋」翻成「放行」＝那個詞被它扣著。
//   不用字串比對的理由：名字裡出現不等於扣得住（`cash` 出現在 `withdrawCash` 裡，但刪掉 `cash` 那支照樣擋）。
//
// 守得到的：某個詞失去**最後一支**承重探針就紅——正本加了新詞而探針沒跟上、探針被刪、或那支探針被別的
//   拒絕路徑接走，都會走到這裡。⚠️ 紅的意思只有一個：**某個詞的承重關係變了，去看為什麼**；
//   不可以從它推論攔截器整體變鬆或變嚴（那兩件事無關，2026-09-29 r1 #2 有實測反例）。
//
// 證不到的（照實寫）：
//   ・**不驗正本自己對不對**：正本少一個該有的新說法本題不會紅（那是 `forbidden-defaults` ① 與
//     `docs/money-guard-two-pattern-tables.md`「預設字彙表」那一節的射程）。
//   ・**只涵蓋 `verbs` 與 `nouns`**（探針生成規則只吃這兩欄）；另三欄不驗。
//   ・**不窮舉工具名**：每個詞有一支探針扣著就算涵蓋，不保證它在所有寫法下都擋得住。
//   ・**多支承重探針時**：對**那個詞**只要還剩一支就不紅；整題仍可能紅，因為被刪的那支可能是**別的詞**
//     最後一支（實測：`xfer` 有三支，只刪 `xfer_security` 就紅、報的是 `security`）。
//   ・**對照組不是量測不會被換掉的保證**：②b／②c／②d 各鎖一組固定輸入輸出。已知仍放行的退化有兩類
//     ——把 ②d 那支證人特判掉的字串查找、以及量測時把同一個詞從兩欄一起刪（`transfer`／`withdrawal`
//     兩欄都有）。兩類都是 2026-09-29 掃描量到的，本題不宣稱擋得住它們。
//   ・跑的是行程內 `decide()`，**不是**真的鉤子（鉤子那層在 `money-kit-hook`／`codex-global-hook`）。
//
// 沿革（三輪複審與掃描的逐條對帳）在變更 647 的 PR 說明，這裡不重述。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FORBIDDEN_FAMILY, familyNetFixture, FAKE_UUID } from './helpers/money-family-probes.js';
import forbiddenTools from '../tools/forbidden-tools.js';

const { decide } = forbiddenTools;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 正本＝根目錄 settings.json 的 forbidden 那一塊（跟攔截器讀的是同一份）。 */
function projectForbidden() {
  return JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8')).forbidden;
}

/** 本題只涵蓋這兩欄（探針生成規則只吃它們）。 */
const FIELDS = /** @type {const} */ (['verbs', 'nouns']);

/**
 * 點名例外（2026-10-10 整批同步；R2 照 a 先做、等 William 本人裁）：這幾個詞沒有任何探針扣得住，因為它們整條被遮住——
 * 帶底線的寫法被「唯讀開頭也不脫罪」那一張樣式（forbidden.patternsReadSafe；套件 #55，William 10/08 裁 a）先接走，
 * 連寫的寫法被比它短的詞先接走（withdrawal 裡有 withdraw）。它們照樣擋，只是量不到承重。
 * 下面那一題證明確實被遮；哪一天它又扣得住了（例如那條樣式拿掉），例外就要拿掉——那時「例外清單的詞要量得出沒有承重」那一句會紅。
 */
const SHADOWED = /** @type {Record<'verbs' | 'nouns', string[]>} */ ({ verbs: ['withdrawal'], nouns: [] });

/**
 * 量承重：回傳漏擋的探針、每一欄沒有任何探針扣著的詞，以及查某個詞的承重探針。
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
    + '——涵蓋題靠「拿掉一個詞就從擋翻成放行」量承重，基準先漏擋就量不出東西');
});

test('涵蓋：正本 verbs／nouns 的每一個詞都有探針扣著，沒有例外', () => {
  const forbidden = projectForbidden();
  const { uncarried } = measure(forbidden, FORBIDDEN_FAMILY);
  for (const field of FIELDS) {
    // 點名例外（見 SHADOWED）：只准是這幾個、而且它們要真的沒有承重（又扣得住了＝例外要拿掉）
    for (const w of SHADOWED[field]) {
      assert.ok(forbidden[field].includes(w), `點名例外的「${w}」已經不在正本 forbidden.${field}——例外要拿掉`);
      assert.ok(uncarried[field].includes(w), `點名例外的「${w}」現在有探針扣得住了——把它從 SHADOWED 拿掉`);
      const delimited = `${FAKE_UUID}request_${w}`;
      const lessWord = familyNetFixture({ ...forbidden, [field]: forbidden[field].filter((/** @type {string} */ x) => x !== w) }, [delimited]);
      assert.ok(decide(delimited, lessWord).deny, `點名例外的「${w}」：拿掉這個詞，帶底線的寫法 ${delimited} 照樣要擋（被樣式遮住的證明）`);
      const noReadSafe = familyNetFixture({ ...forbidden, [field]: forbidden[field].filter((/** @type {string} */ x) => x !== w), patternsReadSafe: [] , patterns: [] }, [delimited]);
      assert.ok(!decide(delimited, noReadSafe).deny, `點名例外的「${w}」：連詞帶兩張樣式都拿掉，${delimited} 要放行——不然遮住它的不是樣式`);
    }
    uncarried[field] = uncarried[field].filter((w) => !SHADOWED[field].includes(w));
    assert.deepEqual(uncarried[field], [],
      `正本 forbidden.${field} 的這幾個詞沒有任何探針扣著：${JSON.stringify(uncarried[field])}\n`
      + `  （這一欄共 ${forbidden[field].length} 個詞）\n`
      + '  補法：先試 test/helpers/money-family-probes.js 的 FAMILY_VERBS／FAMILY_NOUNS'
      + '（生成 {動詞}_order／place_{名詞}）；那兩種形狀量不出承重的，照 FORBIDDEN_FAMILY 底部那一段換形狀。\n'
      + '  改完要一起改 EXPECTED_FORBIDDEN_FAMILY 與 test/money-family-probes-integrity.test.js 的 sha256。\n'
      + '  ⚠️ 也可能是那支探針被別的拒絕路徑接走了——先查是哪一條，不要從這一題推攔截器的鬆緊。');
  }
});

test('②b 判準自己：往正本塞一個誰都接不住的假詞，要被抓到（對照組）', () => {
  const forbidden = projectForbidden();
  const FAKE_WORD = 'zzzznobodycatchesthis';
  for (const field of FIELDS) {
    const salted = { ...forbidden, [field]: [...forbidden[field], FAKE_WORD] };
    assert.ok(measure(salted, FORBIDDEN_FAMILY).uncarried[field].includes(FAKE_WORD),
      `塞進 forbidden.${field} 的假詞「${FAKE_WORD}」沒有被量成「沒有探針扣著」——量測失效`);
  }
});

test('②d 判準自己：判準退化成「名字裡有沒有出現這個詞」要被抓到（對照組）', () => {
  const forbidden = projectForbidden();
  // 一個「名字裡有、行為上不承重」的案例：只給一支 place_security。名字裡有 security，
  // 但刪掉 nouns.security 之後它仍被擋（換別條路徑接住）⇒ 行為量測說沒涵蓋、字串查找說有。
  const PROBE = [`${FAKE_UUID}place_security`];
  assert.ok(PROBE[0].toLowerCase().includes('security'), '對照組的前提壞了：名字裡要真的出現 security');

  const { leaked, uncarried } = measure(forbidden, PROBE);
  assert.deepEqual(leaked, [], '對照組的前提壞了：那一支探針在夾具下要先被擋');
  assert.ok(uncarried.nouns.includes('security'),
    '行為量測沒有把 security 判成「沒有探針扣著」——判準可能已經退化成「名字裡有沒有出現這個詞」');
});

test('②c 判準自己：拿掉某個詞的所有承重探針，那個詞要變成沒有探針扣著（對照組）', () => {
  const forbidden = projectForbidden();
  const { carriersOf } = measure(forbidden, FORBIDDEN_FAMILY);
  // 不釘「剛好一支」（xfer 就有三支，釘死會在補探針時假紅）：量出來有幾支就拿掉幾支。
  const carriers = carriersOf('verbs', 'cash_out');
  assert.ok(carriers.length > 0, '對照組的前提壞了：完整探針表下 cash_out 本來就該有探針扣著');

  const without = FORBIDDEN_FAMILY.filter((p) => !carriers.includes(p));
  assert.equal(without.length, FORBIDDEN_FAMILY.length - carriers.length, '拿掉承重探針時算錯了張數');
  assert.ok(measure(forbidden, without).uncarried.verbs.includes('cash_out'),
    `拿掉扣著 cash_out 的那 ${carriers.length} 支探針之後，cash_out 沒有變成「沒有探針扣著」`);
});
