// 設定值的型別判準：**每一種 kind 都要能真的存進去**。
//
// 這族考題的由來（2026-08-14，#455 預審抓到、實測坐實）：
// `aiAskBeforeSend` 是全 app 第一個 `'bool'` 設定，而消毒器有**兩份手抄的型別分派**——
// `sanitizeSettingsDeep`（走訪已知欄位）認得 bool，`sanitizeSettings`（PUT /api/settings 走的那條）
// 不認得，落到 `: false` ⇒ **前端存檔靜靜被剝掉、畫面照樣回報「已儲存」**。
// 後果不是體感問題：那顆開關是「送帳單給 AI 之前先問我一次」，永遠打不開
// ⇒ 使用者想要被問，卻永遠不會被問。
//
// ⚠️ 這裡**不逐一列舉型別名字**（列舉會漂、而且漏掉的那一個正是會出事的那一個）：
// 考題直接讀 `SETTINGS_FIELD_TYPES`，對**表裡出現過的每一種 kind** 都拿一個合法樣本走完整條寫入路徑。
// 新增型別而只教會其中一個消毒器＝這題轉紅。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_FIELD_TYPES, sanitizeSettings, sanitizeSettingsDeep } from '../lib/schema.js';

/** 每一種 kind 的「一定合法」與「一定不合法」樣本。缺樣本＝這題自己失敗（不可以靜靜跳過） */
const SAMPLES = {
  number: { ok: 12, bad: 'x' },
  posnum: { ok: 3.5, bad: 0 },
  posnumopt: { ok: null, bad: -1 },
  string: { ok: '合成字串', bad: 42 },
  bool: { ok: true, bad: 'true' },          // ★字串 'true' 必須被擋：truthy 會讓「要問」變成永遠成立
  manual: { ok: 20, bad: 'x' },             // okManual＝null／空字串／數字／數得出來的字串
};

const kindsInUse = [...new Set(Object.values(SETTINGS_FIELD_TYPES))];

test('設定型別｜表裡的每一種 kind，合法值都要能通過 PUT 那條路（不可以靜靜被剝掉）', () => {
  assert.ok(kindsInUse.length > 0, 'SETTINGS_FIELD_TYPES 是空的？先查那份表');
  for (const kind of kindsInUse) {
    const sample = SAMPLES[kind];
    assert.ok(sample, `新的 kind「${kind}」沒有樣本——請在本題補上，不要讓它沒人驗`);
    const key = Object.keys(SETTINGS_FIELD_TYPES).find(k => SETTINGS_FIELD_TYPES[k] === kind);
    const out = sanitizeSettings({ [key]: sample.ok });
    assert.ok(Object.hasOwn(out, key),
      `★kind「${kind}」的合法值被 sanitizeSettings 剝掉了（欄位 ${key}）——`
      + '前端存了會回報成功、實際沒存進去。多半是又多了一份沒學會這個型別的分派。');
    assert.deepEqual(out[key], sample.ok, `kind「${kind}」的值被改動了`);
  }
});

test('設定型別｜每一種 kind 的不合法值都要被擋（兩個消毒器同一個答案）', () => {
  for (const kind of kindsInUse) {
    const key = Object.keys(SETTINGS_FIELD_TYPES).find(k => SETTINGS_FIELD_TYPES[k] === kind);
    const bad = SAMPLES[kind].bad;
    assert.ok(!Object.hasOwn(sanitizeSettings({ [key]: bad }), key),
      `★kind「${kind}」的不合法值溜進去了（欄位 ${key}）`);
    const deep = sanitizeSettingsDeep({ [key]: bad });
    assert.ok(!Object.hasOwn(deep.value, key),
      `★sanitizeSettingsDeep 對 kind「${kind}」的判準與 PUT 那條不一致（欄位 ${key}）`);
  }
});

test('設定型別｜兩個消毒器對同一個值不可以給出不同答案（單一判準的行為級證明）', () => {
  const key = Object.keys(SETTINGS_FIELD_TYPES).find(k => SETTINGS_FIELD_TYPES[k] === 'bool');
  assert.ok(key, '型別表裡沒有 bool 欄位了？那本題要跟著改，不是刪掉');
  for (const v of [true, false, 'true', 1, 0, null, undefined, {}]) {
    const viaPut = Object.hasOwn(sanitizeSettings({ [key]: v }), key);
    const viaDeep = Object.hasOwn(sanitizeSettingsDeep({ [key]: v }).value, key);
    assert.equal(viaPut, viaDeep,
      `★兩個消毒器對 ${JSON.stringify(v)} 的答案不同（PUT=${viaPut}／Deep=${viaDeep}）——`
      + '判準又分家了，而分家的那一次不會有任何徵兆');
  }
});

test('設定型別｜認不得的欄位一律擋掉（fail-closed，不是靜靜放行）', () => {
  // 判準的 default 分支若改成放行，沒登記型別的東西就會直接進資料庫——**沒驗過的值**。
  // 這一題就是那句「認不得的 kind 一律 false」的保證本身（沒有它，那句話沒人撐）。
  for (const key of ['沒登記的欄位', 'aiApiKeySet', 'quotesLastAt', 'lastSync']) {
    const out = sanitizeSettings({ [key]: 'x' });
    assert.ok(!Object.hasOwn(out, key),
      `★「${key}」不在 SETTINGS_FIELD_TYPES 裡，卻通過了消毒——判準的 default 變成放行了`);
  }
  assert.deepEqual(sanitizeSettings({ 沒登記的欄位: 1, allocationDriftPct: 5 }), { allocationDriftPct: 5 },
    '★合法的要留下、沒登記的要走人（只驗其中一半會漏掉「全部放行」那種寫法）');
});

test('設定型別｜「送 AI 前先問我一次」這顆開關真的存得起來（這族考題的起因）', () => {
  assert.equal(SETTINGS_FIELD_TYPES.aiAskBeforeSend, 'bool');
  assert.deepEqual(sanitizeSettings({ aiAskBeforeSend: true }), { aiAskBeforeSend: true },
    '★打開之後存不起來＝使用者想被問卻永遠不會被問（2026-08-14 實際發生過）');
  assert.deepEqual(sanitizeSettings({ aiAskBeforeSend: false }), { aiAskBeforeSend: false },
    '★關掉也要存得起來（只驗 true 會漏掉「只認 truthy」那種寫法）');
});
