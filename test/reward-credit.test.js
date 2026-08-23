// @ts-check
// 回饋（點數折抵帳單）判準的考題。
//
// ⚠️ **字面清單是刻意的**：斷言裡把 REWARD_CREDIT_WORDS 的內容一個字一個字寫死，而不是迴圈跑那個清單。
//    迴圈版是「拿實作驗實作」——實作是 `WORDS.some(w => s.includes(w))`，對清單裡的任何 w 恆為真，
//    刪掉一個字樣時斷言也跟著消失，全綠。寫死才逼得動清單的人回來這裡，順便被迫想「會不會誤中」。
//    （同型解法的既有前例：test/contract-split.test.js 用集合相等釘 titles↔manifest。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRewardCredit, REWARD_CREDIT_WORDS } from '../public/modules/categories.js';
import { isCardPayment } from '../lib/statement.js';

test('回饋判準｜字樣清單就是全部（字面釘死，加減字樣一定得回來改這題）', () => {
  assert.deepEqual([...REWARD_CREDIT_WORDS], ['折帳單', '點數折抵']);
  // 每個字面字樣各自單獨命中（不是靠迴圈跑清單）
  assert.equal(isRewardCredit('折帳單'), true);
  assert.equal(isRewardCredit('點數折抵'), true);
});

test('回饋判準｜正例＝使用者真帳單上的原文（兩種取字串的來源都要認得）', () => {
  // stmtRef 第四段的帳單原文（實際存在於 db：c1|2025-09-14|-365|折帳單_信用卡點數折抵消費）
  assert.equal(isRewardCredit('折帳單_信用卡點數折抵消費'), true);
  // 顯示名版本（手動記帳或使用者改過說明時，呼叫端會退回 t.note）
  assert.equal(isRewardCredit('折帳單（信用卡點數折抵消費）'), true);
});

test('回饋判準｜負例＝使用者卡片帳本裡真實存在的其他負數列，一個都不可以被吃掉', () => {
  // 這七種都是真退款或拿回自己的錢，全部取自 db 的實際原文（金額與日期不留存＝PII 不進版控）
  for (const desc of [
    '悠遊卡掛失贖回餘額退款',
    '停車費退費（新北市）',
    'Klook',
    '富邦ｍｏｍｏ－ＥＣ',
    '統一超商（東學）',
    '新北市林口國民運動中心',
    'LinkedIn',
  ]) assert.equal(isRewardCredit(desc), false, `「${desc}」被誤判成回饋`);
});

test('回饋判準｜負例＝含「回饋」二字但不是點數折抵的說明（字樣刻意窄，不用寬泛的「回饋」兩字）', () => {
  // 前三種是使用者銀行帳本裡真實存在的說明；它們是**正數**列，正式路徑的正負分流本來就查不到判準，
  // 這裡釘的是「就算有人把判準搬到分流之前，也不會誤中」。
  for (const desc of [
    '現金轉入・消費回饋',
    '現金轉入・消費回饋簽帳卡',
    '現金轉出・其他代繳取消回饋',
    '現金存入・交割折讓',
    '回饋鍋物',            // 店名含「回饋」
    '饗饗餐廳',            // 含「饋」的相近字形
    '紅利點數查詢費',      // 有「點數」沒有「折抵」
  ]) assert.equal(isRewardCredit(desc), false, `「${desc}」被誤判成回饋`);
});

test('回饋判準｜邊界值回真布林、不丟例外', () => {
  for (const v of ['', '   ', undefined, null, 0, 123, {}, []]) {
    assert.strictEqual(isRewardCredit(/** @type {any} */ (v)), false, `${JSON.stringify(v)} 沒有回 false`);
  }
});

test('回饋判準｜與繳款判準互不搶：同一段文字不會兩邊都認', () => {
  assert.equal(isCardPayment('折帳單_信用卡點數折抵消費'), false, '回饋被繳款判準吃掉了');
  assert.equal(isRewardCredit('自動轉帳扣繳信用卡款'), false, '繳款被回饋判準吃掉了');
  assert.equal(isRewardCredit('感謝您繳款'), false);
});
