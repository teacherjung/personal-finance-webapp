// @ts-check
// 規則卡出生紀錄（2026-08-19；體檢 R2）——**這支只做記錄與顯示，不改出生判準**。
//
// 為什麼要有它：規則卡是「同版面第二次起零 AI」那條省錢路的全部指望，但它的七種失敗原因原本
// 完全不留痕（沒寫 db、沒 log、畫面只有一句通稱）。於是「到底誕生過沒有、卡在哪一關」對使用者
// 與維護者都是黑箱——要放寬哪一關得先有證據，這支就是那個證據來源。
//
// 三條界線各自有題：
//   Ａ**封閉鍵集合**：只認 BIRTH_CODES 八個代碼，未知代碼歸「生成失敗」而不是長出新鍵（這張表放在
//     settings 裡，會膨脹就是 DoS 面）。
//   Ｂ**機密**：只記結果代碼＋機構名＋日期。帳單內容、配方內容、原文一律不入。
//   Ｃ**成功也記**：沒有分母就看不出失敗率（「試了 5 次學會 0 次」和「試了 1 次沒學會」是兩件事）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { BIRTH_CODES, recordBirth, sanitizeBirthStats, birthSummary } = await import('../lib/recipe-birth.js');
const { birthText, birthTextCodes, birthStatsHtml, birthSummary: feSummary } = await import('../public/modules/recipe-birth-text.js');
const { sanitizeSettings, sanitizeSettingsDeep } = await import('../lib/schema.js');
const ROOT = join(import.meta.dirname, '..');
const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);

// ---- Ａ 封閉鍵集合 ----
test('界線Ａ｜未知代碼不得長出新鍵（這張表住在 settings，會膨脹就是 DoS 面）', () => {
  const s1 = recordBirth({}, '我自己編的代碼', '台新', '2026-08-19');
  assert.deepEqual(Object.keys(s1), ['recipe_gen_failed'], '★未知代碼歸到「生成失敗」');
  const s2 = recordBirth(s1, '__proto__', '台新', '2026-08-19');
  assert.deepEqual(Object.keys(s2), ['recipe_gen_failed'], '★原型名同樣不長鍵');
  assert.equal(/** @type {any} */ ({}).n, undefined, '★沒有汙染 Object.prototype');
  for (const c of BIRTH_CODES) assert.equal(typeof birthText(c), 'string');
});

test('界線Ａ｜壞資料進來不炸畫面：非物件、負數、超大數、壞日期都被消毒', () => {
  // ⚠️ 回傳是 null-prototype 物件（使用者文字當鍵的家規），所以比鍵集合而不是 deepEqual 空物件
  for (const v of [null, 'x', { ok: 'x' }, { ok: { n: -3 } }]) assert.deepEqual(Object.keys(sanitizeBirthStats(v)), [], `壞資料＝空表：${JSON.stringify(v)}`);
  assert.equal(sanitizeBirthStats({ ok: { n: 1e12, lastAt: 'x', lastBank: 'A'.repeat(80) } }).ok.n, 100000, '★數字有上限');
  assert.equal(sanitizeBirthStats({ ok: { n: 2, lastAt: '2026/08/19' } }).ok.lastAt, '', '★壞日期格式＝丟掉，不是照收');
  assert.equal(sanitizeBirthStats({ ok: { n: 2, lastBank: 'A'.repeat(80) } }).ok.lastBank.length, 20, '★機構名截短');
  assert.deepEqual(Object.keys(sanitizeBirthStats({ ok: { n: 1 }, 不認識的: { n: 9 } })), ['ok'], '★白名單外整格丟');
});

test('界線Ａ｜這是 server-owned 診斷資料：前端 PUT 寫不進來，匯入備份要過消毒器', () => {
  // ★前端 PUT：不在 SETTINGS_FIELD_TYPES ⇒ 整欄丟掉（同 quotesLastAt 的既有作法）。
  //   前端能寫＝使用者（或壞掉的備份還原）可以偽造「學會了 999 次」，診斷資料就沒有意義了。
  const put = sanitizeSettings({ recipeBirthStats: { ok: { n: 3, lastAt: '2026-08-19', lastBank: '台新' } } }, []);
  assert.ok(!('recipeBirthStats' in put), '★PUT 路徑：整欄不收（server-owned）');
  // ★匯入備份：好資料留下、壞形狀與白名單外的鍵剝除
  const imp = sanitizeSettingsDeep({ recipeBirthStats: { ok: { n: 2, lastAt: '2026-08-19', lastBank: '台新' }, 亂鍵: { n: 5 } } }).value;   // 回 {value, bad}
  assert.deepEqual(Object.keys(imp.recipeBirthStats || {}), ['ok'], '★匯入路徑：白名單外剝除、好資料留下');
  assert.equal(imp.recipeBirthStats.ok.n, 2);
  const imp2 = sanitizeSettingsDeep({ recipeBirthStats: '整欄不是物件' }).value;
  assert.ok(!('recipeBirthStats' in imp2), '★整欄壞掉＝整欄剝除');
});

test('界線Ａ｜recordBirth 自己的契約（不是只靠讀取端消毒）：上限、壞日期、機構名長度', () => {
  // 上限：已經在上限再記一次仍是上限（便宜地測到 clamp——不必真的跑十萬次）
  const atMax = recordBirth({ ok: { n: 100000, lastAt: '2026-08-19', lastBank: '台新' } }, 'ok', '台新', '2026-08-20');
  assert.equal(atMax.ok.n, 100000, '★寫入端自己也要夾上限');
  // 壞日期：不覆蓋既有的「最後一次」（寧可停在舊時間，也不要寫進一個假日期）
  const badDate = recordBirth({ ok: { n: 1, lastAt: '2026-08-19', lastBank: '台新' } }, 'ok', '台新', '八月十九');
  assert.equal(badDate.ok.lastAt, '2026-08-19', '★壞日期不覆蓋既有值');
  assert.equal(recordBirth({}, 'ok', '台新', '亂寫').ok.lastAt, '', '★沒有舊值就留空，不寫假日期');
  // 機構名：寫入端截短（不是等讀取端救）
  assert.equal(recordBirth({}, 'ok', '銀'.repeat(80), '2026-08-19').ok.lastBank.length, 20, '★寫入端自己截短');
});

// ---- Ｂ 機密 ----
test('界線Ｂ｜只記代碼＋機構＋日期：任何一格都不得夾帶帳單內容', () => {
  const s = recordBirth({}, 'recipe_birth_reproduce', '台新', '2026-08-19');
  const row = s.recipe_birth_reproduce;
  assert.deepEqual(Object.keys(row).sort(), ['lastAt', 'lastBank', 'n'], '★欄位就這三格（多一格＝多一條外洩面）');
  const blob = JSON.stringify(s);
  assert.doesNotMatch(blob, /900\d{3}|\*{2,}|餘額|摘要/, '★不得出現帳號、遮罩、金額欄名');
  // 記錄端的呼叫點只餵得進這三樣（形狀掃描：防未來有人把 parsed 或 candidate 塞進來）
  const src = readFileSync(join(ROOT, 'lib/services/bank-import.js'), 'utf8');
  assert.match(src, /recordBirth\(db2\?\.settings\?\.recipeBirthStats, code, bank, today\)/,
    '★呼叫點只帶「既有統計、結果代碼、機構名、日期」四樣');
});

// ---- Ｃ 成功也記 ----
test('界線Ｃ｜成功也記（沒有分母就看不出失敗率）；摘要算得對', () => {
  let s = recordBirth({}, 'ok', '台新', '2026-08-19');
  s = recordBirth(s, 'ok', '台新', '2026-08-19');
  s = recordBirth(s, 'recipe_birth_reproduce', '第一銀行', '2026-08-20');
  s = recordBirth(s, 'recipe_birth_reproduce', '第一銀行', '2026-08-21');
  s = recordBirth(s, 'recipe_birth_strict', '第一銀行', '2026-08-21');
  const sum = birthSummary(s);
  assert.deepEqual(sum, { total: 5, ok: 2, failed: 3, top: { code: 'recipe_birth_reproduce', n: 2 } });
  assert.equal(s.ok.n, 2);
  assert.equal(s.recipe_birth_reproduce.lastAt, '2026-08-21', '★最後一次時間會更新');
  assert.equal(s.recipe_birth_reproduce.lastBank, '第一銀行');
});

test('界線Ｃ｜前後端的摘要口徑一致（前端不 import lib/，各自一份＝必須互扣）', () => {
  const s = recordBirth(recordBirth(recordBirth({}, 'ok', 'A', '2026-08-19'), 'recipe_birth_parse', 'B', '2026-08-19'), 'recipe_birth_parse', 'B', '2026-08-20');
  assert.deepEqual(feSummary(s), birthSummary(s), '★兩邊算出來要一模一樣（不然畫面上的數字跟後端不同）');
});

// ---- 文案與畫面 ----
test('文案｜每個代碼都有白話句（互扣：後端新增代碼沒補文案＝這裡紅）', () => {
  assert.deepEqual(birthTextCodes(), [...BIRTH_CODES].sort(), '★代碼表與文案表逐一對應');
  assert.equal(birthText('沒這個代碼'), '', '未知＝不畫');
  assert.match(birthText('recipe_birth_reproduce'), /跟你剛才確認過的那份對不起來/);
});

test('文案｜不得承諾「下次就會成功」（能不能學會取決於兩發 AI 對不對得上，不是我們控制得了的）', () => {
  const src = readFileSync(join(ROOT, 'public/modules/recipe-birth-text.js'), 'utf8');
  const table = src.slice(src.indexOf('const TEXT'), src.indexOf('});', src.indexOf('const TEXT')));
  const sentences = [...table.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(sentences.length >= 8, `抓得到句子（實得 ${sentences.length}）`);
  for (const line of sentences) assert.doesNotMatch(line, /下次(應該|就)會|很快就|馬上/, `★不得承諾：「${line}」`);
});

test('畫面｜沒紀錄＝講清楚要怎樣才會有；有紀錄＝列出次數與最後一次，且欄值逃逸', () => {
  const empty = birthStatsHtml({}, feSummary({}), esc);
  assert.match(empty, /還沒有紀錄/);
  assert.match(empty, /按下套用之後/, '★要講清楚什麼時候才會開始累積（不然使用者以為壞了）');
  const s = recordBirth({}, 'recipe_birth_match', '<img src=x>', '2026-08-19');
  const html = birthStatsHtml(s, feSummary(s), esc);
  assert.match(html, /找不到它說的定位詞/);
  assert.match(html, /1<\/b> 次/);
  assert.match(html, /最後一次 2026-08-19/);
  assert.ok(!/<img/i.test(html), '★機構名要逃逸');
  assert.match(html, /&lt;img/, '★esc 後的輸出真的在（整段被剝掉也算失敗）');
});

// ---- 接線 ----
test('接線｜apply 之後真的會記一筆，且記錄失敗不連坐（匯入已完成、票已消耗）', () => {
  const src = readFileSync(join(ROOT, 'lib/services/bank-import.js'), 'utf8');
  assert.match(src, /const code = [^\n]*saved \? 'ok' : String\([^\n]*reason \|\| 'recipe_gen_failed'\)/, '★成功記 ok、失敗記原因');
  assert.match(src, /try \{[\s\S]{0,400}?recordBirth[\s\S]{0,200}?\} catch \{/, '★整段包 catch：診斷資料寫不進去不得影響已完成的匯入');
  const done = readFileSync(join(ROOT, 'public/modules/cashflow-model.js'), 'utf8');
  assert.match(done, /birthText\(recipe\.reason \|\| ''\)/, '★完成提示會講出是哪一關（原本只有通稱）');
  const set = readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8');
  assert.match(set, /birthStatsHtml\(s\?\.recipeBirthStats, birthSummary\(s\?\.recipeBirthStats\), esc\)/, '★設定頁真的畫這張表');
});
