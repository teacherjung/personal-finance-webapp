// @ts-check
// 規則卡出生紀錄（2026-08-19；體檢 R2）——**這支只做記錄與顯示，不改出生判準**。
//
// 為什麼要有它：規則卡是「同版面第二次起可以不花 AI」那條省錢路的指望，而它的出生會在七個關卡的
// 任一關失敗。這份統計就是那些關卡的證據來源——「該放寬哪一關」不能用猜的。
//
// 三條界線各自有題：
//   Ａ**封閉鍵集合**：只認 BIRTH_CODES 八個代碼，未知代碼歸「生成失敗」而不是長出新鍵（這張表放在
//     settings 裡，會膨脹就是 DoS 面）。
//   Ｂ**機密**：只記結果代碼＋機構名＋日期。帳單內容、配方內容、原文一律不入。
//   Ｃ**成功也記**：沒有分母就看不出失敗率（「試了 5 次學會 0 次」和「試了 1 次沒學會」是兩件事）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ **必須在任何會載入 repo/store 的 import 之前**（Codex #489 r2#1 的 High）：本卷有走正式
//    applyBankStatement 與 /api/import 的行為題，會清空集合並覆寫整庫——沒有先把 STORE_FILE 指到
//    暫存目錄，在主目錄跑 `npm test` 就會直接操作**真實的 data/store.db**（鐵則 1）。
process.env.STORE_FILE = join(mkdtempSync(join(tmpdir(), 'finance-recipe-birth-')), 'store.db');

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
  /** @type {string[]} */ const putBad = [];
  const put = sanitizeSettings({ recipeBirthStats: { ok: { n: 3, lastAt: '2026-08-19', lastBank: '台新' } } }, { badOut: putBad });
  assert.ok(!('recipeBirthStats' in put), '★PUT 路徑：整欄不收（server-owned）');
  assert.ok(putBad.includes('settings.recipeBirthStats'), 'PUT 路徑要照實回報剝掉了什麼');
  // ★匯入路徑保留時**不得**同時回報「已剝掉」（r2#4：資料留著卻警告說剝掉＝診斷說謊，
  //   未來呼叫端（例如 /api/import 的 wiped 判斷）會把合法備份誤判成壞檔）
  /** @type {string[]} */ const impBad = [];
  const impKeep = sanitizeSettings({ recipeBirthStats: { ok: { n: 3, lastAt: '2026-08-19', lastBank: '台新' } } }, { allowIbSyncFields: true, badOut: impBad });
  assert.equal(impKeep.recipeBirthStats?.ok?.n, 3, '★匯入路徑：資料留下');
  assert.ok(!impBad.includes('settings.recipeBirthStats'), '★留下來就不能同時說它被剝掉');
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
  // ★外形對但不是真日期（r1#5：2026-99-99／2026-02-31 原本會被收下並顯示）
  for (const fake of ['2026-99-99', '2026-02-31', '2026-13-01', '2026-00-10']) {
    assert.equal(recordBirth({}, 'ok', '台新', fake).ok.lastAt, '', `★不是真日期＝不收：${fake}`);
    assert.equal(sanitizeBirthStats({ ok: { n: 1, lastAt: fake } }).ok.lastAt, '', `★讀取端同樣不收：${fake}`);
  }
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
  assert.match(src, /recordBirth\(cur, code, bank, today\)/,
    '★呼叫點只帶「fresh 統計、結果代碼、機構名、日期」四樣（不得把 parsed／candidate 塞進來）');
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
  // ★髒鍵情境也要一致（前端顯示層自己要守封閉鍵；db 被別的路徑寫髒時不得灌進總數）
  const dirty = { ...s, 亂鍵: { n: 99, lastAt: '2026-08-19', lastBank: 'X' } };
  assert.deepEqual(feSummary(dirty), birthSummary(dirty), '★髒鍵不得讓前後端數字分家');
  assert.equal(feSummary(dirty).total, feSummary(s).total, '★髒鍵不得灌進總數');
  assert.ok(!birthStatsHtml(dirty, feSummary(dirty), esc).includes('亂鍵'), '★髒鍵不得被當文案畫出來');
});

// ---- 文案與畫面 ----
test('文案｜每個代碼都有白話句（互扣：後端新增代碼沒補文案＝這裡紅）', () => {
  assert.deepEqual(birthTextCodes(), [...BIRTH_CODES].sort(), '★代碼表與文案表逐一對應');
  assert.equal(birthText('沒這個代碼'), '', '未知＝不畫');
  // ★原型保留字（家規 3.5；r3#2 實測 birthText('toString') 會回傳內建函式，完成提示就把它印出來）
  for (const k of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
    assert.equal(birthText(k), '', `★保留字也要回空字串：${k}`);
  }
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
  assert.match(empty, /<b>用 AI 讀過一次帳單並按下套用之後<\/b>/, '★用 HTML 粗體（r2#3：這裡是 innerHTML，Markdown 星號會原樣顯示成 ****）');
  assert.ok(!empty.includes('**'), '★輸出不得殘留 Markdown 標記');
  const s = recordBirth({}, 'recipe_birth_match', '<img src=x>', '2026-08-19');
  const html = birthStatsHtml(s, feSummary(s), esc);
  assert.match(html, /找不到它說的定位詞/);
  assert.match(html, /1<\/b> 次/);
  assert.match(html, /最後一次 2026-08-19/);
  assert.ok(!/<img/i.test(html), '★機構名要逃逸');
  assert.match(html, /&lt;img/, '★esc 後的輸出真的在（整段被剝掉也算失敗）');
});

// ---- 接線與行為（r1#4：原本只掃原始碼有沒有 try/catch＝把整段搬到 saveDb 前也會綠）----
test('行為｜統計寫入失敗**不連坐**：匯入照樣成功、資料已落盤、票仍消耗（走正式 applyBankStatement）', async () => {
  const { previewBankStatement, applyBankStatement } = await import('../lib/services/bank-import.js');
  const { getDb, saveDb } = await import('../lib/repo.js');
  const { clearAiTicketsForTest, aiTicketCountForTest } = await import('../lib/ai-confirm-ticket.js');
  const { AI_BANK_MODELS } = await import('../lib/ai-parse.js');
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  delete db.settings.aiDualRead;
  await saveDb(db);
  const M = '900200****3301';
  const answer = {
    bank: '合成第一銀行', referenceDate: '2026-07-31',
    accountCurrencies: [{ masked: M, currency: 'TWD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [{ masked: M, balance: 5500, currency: 'TWD', label: '台幣活存', note: '', kind: 'demand', period: '' }],
    transactions: [{ acctMasked: M, date: '2026-07-05', direction: 'in', amount: 500, balance: 5500, summary: '薪資入帳', note: '' }],
  };
  const engine = () => ({ models: AI_BANK_MODELS, parseOnce: async () => structuredClone(answer) });
  const notRecognized = async () => { throw Object.assign(new Error('不是內建範本認得的版面'), { status: 400, code: 'bank_unrecognized' }); };
  const extract = async () => [
    { y: 10, cells: [{ x: 40, s: '合成第一銀行 存款對帳單' }] },
    { y: 30, cells: [{ x: 40, s: M }, { x: 200, s: 'TWD' }, { x: 320, s: '5,500' }] },
    { y: 50, cells: [{ x: 40, s: '2026/07/05' }, { x: 140, s: '薪資入帳' }, { x: 280, s: '500' }, { x: 320, s: '5,500' }] },
  ];
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engine, aiExtract: extract });
  const before = aiTicketCountForTest();
  // ★統計寫入直接爆炸——匯入已經 commit、票已消耗，這裡失敗不得把成功變成失敗
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, {
    useAi: true, aiTicket: /** @type {any} */ (pv).aiTicket, aiEngineFactory: engine, aiExtract: extract,
    aiRecipeGen: async () => ({ saved: false, reason: 'recipe_birth_reproduce' }),
    birthWrite: async () => { throw new Error('統計寫入爆炸'); },
  });
  assert.equal(/** @type {any} */ (res).ok, true, '★匯入仍回成功');
  const after = await getDb();
  assert.equal(after.transactions.length, 1, '★交易真的落盤了（不是回滾）');
  assert.ok(before > 0, '前提：preview 真的發了票（before=0 會讓下一句變空包彈）');
  assert.ok(aiTicketCountForTest() < before, '★票仍維持消耗（不因統計失敗而放回）');
});

test('行為｜統計真的會被記進去（成功路徑走正式 applyBankStatement）', async () => {
  const { previewBankStatement, applyBankStatement } = await import('../lib/services/bank-import.js');
  const { getDb, saveDb } = await import('../lib/repo.js');
  const { clearAiTicketsForTest } = await import('../lib/ai-confirm-ticket.js');
  const { AI_BANK_MODELS } = await import('../lib/ai-parse.js');
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  delete db.settings.recipeBirthStats;
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  await saveDb(db);
  const M = '900200****3302';
  const answer = {
    bank: '合成第一銀行', referenceDate: '2026-07-31',
    accountCurrencies: [{ masked: M, currency: 'TWD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [{ masked: M, balance: 5500, currency: 'TWD', label: '台幣活存', note: '', kind: 'demand', period: '' }],
    transactions: [{ acctMasked: M, date: '2026-07-05', direction: 'in', amount: 500, balance: 5500, summary: '薪資入帳', note: '' }],
  };
  const engine = () => ({ models: AI_BANK_MODELS, parseOnce: async () => structuredClone(answer) });
  const notRecognized = async () => { throw Object.assign(new Error('不是內建範本認得的版面'), { status: 400, code: 'bank_unrecognized' }); };
  const extract = async () => [
    { y: 10, cells: [{ x: 40, s: '合成第一銀行 存款對帳單' }] },
    { y: 30, cells: [{ x: 40, s: M }, { x: 200, s: 'TWD' }, { x: 320, s: '5,500' }] },
    { y: 50, cells: [{ x: 40, s: '2026/07/05' }, { x: 140, s: '薪資入帳' }, { x: 280, s: '500' }, { x: 320, s: '5,500' }] },
  ];
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engine, aiExtract: extract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, {
    useAi: true, aiTicket: /** @type {any} */ (pv).aiTicket, aiEngineFactory: engine, aiExtract: extract,
    aiRecipeGen: async () => ({ saved: false, reason: 'recipe_birth_strict' }),
  });
  const after = await getDb();
  const stats = after.settings.recipeBirthStats || {};
  assert.equal(stats.recipe_birth_strict?.n, 1, `★正式路真的記了一筆（實得 ${JSON.stringify(stats)}）`);
  assert.equal(stats.recipe_birth_strict?.lastBank, '合成第一', '★機構名記得對（記的是正規短名：「合成第一銀行」剝掉通用後綴＝同一家不分兩列）');
  assert.match(String(stats.recipe_birth_strict?.lastAt), /^\d{4}-\d{2}-\d{2}$/);
});

test('行為｜並行兩次出生不掉筆（r1#2：先讀再算好整包交出去＝後寫者蓋掉前一筆）', async () => {
  const { updateRecipeBirthStats, getDb, saveDb } = await import('../lib/repo.js');
  const db = await getDb();
  db.settings.recipeBirthStats = { ok: { n: 5, lastAt: '2026-08-19', lastBank: '台新' } };
  await saveDb(db);
  await Promise.all([
    updateRecipeBirthStats((cur) => recordBirth(cur, 'ok', '台新', '2026-08-20')),
    updateRecipeBirthStats((cur) => recordBirth(cur, 'ok', '台新', '2026-08-20')),
  ]);
  const after = await getDb();
  assert.equal(after.settings.recipeBirthStats.ok.n, 7, '★兩次都要算到（掉筆＝這支的價值歸零）');
});

test('接線｜三個顯示入口都接上了（設定頁卡片／完成提示／文案模組）', () => {
  const done = readFileSync(join(ROOT, 'public/modules/cashflow-model.js'), 'utf8');
  assert.match(done, /birthText\(recipe\.reason \|\| ''\)/, '★完成提示會講出是哪一關');
  const set = readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8');
  assert.match(set, /birthStatsHtml\(s\?\.recipeBirthStats, birthSummary\(s\?\.recipeBirthStats\), esc\)/, '★設定頁真的畫這張表');
});

test('文案｜三個入口都不得承諾「一定免費／下次就會成功」（r1#3：規則卡讀不過會退回 AI）', () => {
  const files = ['public/modules/recipe-birth-text.js', 'public/modules/cashflow-model.js', 'public/modules/settings.js'];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/[^\n]*規則卡[^\n]*/g)) {
      const line = m[0];
      if (/^\s*(\/\/|\*)/.test(line)) continue;   // 註解不掃（可以寫「不得承諾…」這種禁令說明）
      assert.doesNotMatch(line, /免費自動讀|不再花 ?AI|下次(應該|就)會|一定/, `★${f} 過度承諾：${line.trim().slice(0, 80)}`);
    }
  }
  assert.match(birthText('ok'), /讀不過會自動退回 AI/, '★成功那句要講清楚條件');
});

// ---- r1#1 的承重：真的走 /api/import（原本只直呼消毒器＝假綠） ----
test('行為｜備份還原**經正式 HTTP 入口**要帶回出生紀錄（匯出→匯入不得靜靜清空）', async () => {
  const { once } = await import('node:events');
  const { app } = await import('../server.js');
  const store = await import('../lib/store.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = /** @type {any} */ (server.address()).port;
  try {
    const stats = { ok: { n: 3, lastAt: '2026-08-19', lastBank: '台新' }, recipe_birth_strict: { n: 2, lastAt: '2026-08-18', lastBank: '第一銀行' } };
    const backup = { ...store.emptyDb(), settings: { ...store.emptyDb().settings, recipeBirthStats: stats } };
    const res = await fetch(`http://127.0.0.1:${port}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup),
    });
    assert.equal(res.status, 200, '匯入要成功');
    const after = store.load();
    assert.equal(after.settings.recipeBirthStats?.ok?.n, 3, `★還原後紀錄還在（不在＝匯出匯入一趟就靜靜清空；實得 ${JSON.stringify(after.settings.recipeBirthStats)}）`);
    assert.equal(after.settings.recipeBirthStats?.recipe_birth_strict?.n, 2);
    // 髒資料照樣過消毒器（白名單外的鍵不得跟著進來）
    const dirty = { ...store.emptyDb(), settings: { ...store.emptyDb().settings, recipeBirthStats: { ok: { n: 1, lastAt: '2026-08-19', lastBank: 'A' }, 亂鍵: { n: 9 } } } };
    const res2 = await fetch(`http://127.0.0.1:${port}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dirty),
    });
    assert.equal(res2.status, 200);
    assert.deepEqual(Object.keys(store.load().settings.recipeBirthStats || {}), ['ok'], '★白名單外的鍵不得跟著還原進來');
  } finally { server.close(); }
});

test('r3#1｜出生紀錄用**本地**日曆日：台北 00:00–07:59 不得記成前一天', async () => {
  const { nowLocal } = await import('../lib/services/snapshot.js');
  const src = readFileSync(join(ROOT, 'lib/services/bank-import.js'), 'utf8');
  assert.match(src, /const today = nowLocal\(\)\.date;/, '★用本地日曆日（toISOString 是 UTC）');
  assert.doesNotMatch(src.slice(src.indexOf('recordBirth')), /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/, '★這條路上不得再出現 UTC 取日（空白/換行都算）');
  // 行為面：nowLocal 對「台北清晨」這個時刻，回的是本地日而不是 UTC 日
  const d = new Date();
  const localYmd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(nowLocal().date, localYmd, '★nowLocal 回本地日');
  assert.equal(recordBirth({}, 'ok', '台新', nowLocal().date).ok.lastAt, localYmd, '★記進去的就是本地日');
});

// ---- Grok 複審後掃：三處「拿掉保護仍綠」的補強 ----
test('G高｜機密行為題：只有「機構名」那一格會進統計，帳單內容不會（不是只掃呼叫點字串）', async () => {
  const { previewBankStatement, applyBankStatement } = await import('../lib/services/bank-import.js');
  const { getDb, saveDb } = await import('../lib/repo.js');
  const { clearAiTicketsForTest } = await import('../lib/ai-confirm-ticket.js');
  const { AI_BANK_MODELS } = await import('../lib/ai-parse.js');
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  delete db.settings.recipeBirthStats;
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  await saveDb(db);
  const M = '900200****7788';
  const answer = {
    bank: '合成銀行', referenceDate: '2026-07-31',
    accountCurrencies: [{ masked: M, currency: 'TWD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [{ masked: M, balance: 5500, currency: 'TWD', label: '台幣活存', note: '', kind: 'demand', period: '' }],
    transactions: [{ acctMasked: M, date: '2026-07-05', direction: 'in', amount: 500, balance: 5500, summary: '機密摘要不可外流', note: '' }],
  };
  const engine = () => ({ models: AI_BANK_MODELS, parseOnce: async () => structuredClone(answer) });
  const notRecognized = async () => { throw Object.assign(new Error('不是內建範本認得的版面'), { status: 400, code: 'bank_unrecognized' }); };
  const extract = async () => [
    { y: 10, cells: [{ x: 40, s: '合成銀行 存款對帳單' }] },
    { y: 30, cells: [{ x: 40, s: M }, { x: 200, s: 'TWD' }, { x: 320, s: '5,500' }] },
    { y: 50, cells: [{ x: 40, s: '2026/07/05' }, { x: 140, s: '機密摘要不可外流' }, { x: 280, s: '500' }, { x: 320, s: '5,500' }] },
  ];
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engine, aiExtract: extract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, {
    useAi: true, aiTicket: /** @type {any} */ (pv).aiTicket, aiEngineFactory: engine, aiExtract: extract,
    aiRecipeGen: async () => ({ saved: false, reason: 'recipe_birth_match' }),
  });
  const stats = (await getDb()).settings.recipeBirthStats || {};
  const blob = JSON.stringify(stats);
  assert.match(blob, /"lastBank":"合成"/, '機構名有進去（這是刻意記的那一格；記正規短名＝「合成銀行」剝掉「銀行」）');
  assert.doesNotMatch(blob, /7788|\*{2,}|機密摘要|5,?500|2026-07-05/,
    `★帳單內容（帳號、遮罩、摘要、金額、交易日）一格都不得進統計；實得 ${blob}`);
});

test('G中｜成功分支（ok）也走過正式 apply（三元反過來就得紅）', async () => {
  const { previewBankStatement, applyBankStatement } = await import('../lib/services/bank-import.js');
  const { getDb, saveDb } = await import('../lib/repo.js');
  const { clearAiTicketsForTest } = await import('../lib/ai-confirm-ticket.js');
  const { AI_BANK_MODELS } = await import('../lib/ai-parse.js');
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  delete db.settings.recipeBirthStats;
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  await saveDb(db);
  const M = '900200****7799';
  const answer = {
    bank: '合成銀行', referenceDate: '2026-07-31',
    accountCurrencies: [{ masked: M, currency: 'TWD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [{ masked: M, balance: 5500, currency: 'TWD', label: '台幣活存', note: '', kind: 'demand', period: '' }],
    transactions: [{ acctMasked: M, date: '2026-07-05', direction: 'in', amount: 500, balance: 5500, summary: '薪資', note: '' }],
  };
  const engine = () => ({ models: AI_BANK_MODELS, parseOnce: async () => structuredClone(answer) });
  const notRecognized = async () => { throw Object.assign(new Error('不是內建範本認得的版面'), { status: 400, code: 'bank_unrecognized' }); };
  const extract = async () => [
    { y: 10, cells: [{ x: 40, s: '合成銀行 存款對帳單' }] },
    { y: 30, cells: [{ x: 40, s: M }, { x: 200, s: 'TWD' }, { x: 320, s: '5,500' }] },
    { y: 50, cells: [{ x: 40, s: '2026/07/05' }, { x: 140, s: '薪資' }, { x: 280, s: '500' }, { x: 320, s: '5,500' }] },
  ];
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engine, aiExtract: extract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, {
    useAi: true, aiTicket: /** @type {any} */ (pv).aiTicket, aiEngineFactory: engine, aiExtract: extract,
    aiRecipeGen: async () => ({ saved: true, recipeId: 'rcp-x', rebirth: false }),   // ★出生成功
  });
  const stats = (await getDb()).settings.recipeBirthStats || {};
  assert.equal(stats.ok?.n, 1, `★成功也要記（分母；實得 ${JSON.stringify(stats)}）`);
  assert.equal(stats.recipe_gen_failed, undefined, '成功不得同時記成失敗');
});

test('G中｜PUT /settings **真 HTTP** 寫不進來；匯出→匯入**真的走兩個端點**要帶得回來', async () => {
  const { once } = await import('node:events');
  const { app } = await import('../server.js');
  const store = await import('../lib/store.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = /** @type {any} */ (server.address()).port;
  const url = (/** @type {string} */ p2) => `http://127.0.0.1:${port}/api${p2}`;
  try {
    const seeded = { ok: { n: 4, lastAt: '2026-08-19', lastBank: '台新' } };
    const base = store.load();
    store.save({ ...base, settings: { ...base.settings, recipeBirthStats: seeded } });
    // ★真 HTTP PUT：偽造寫不進來、既有值原封不動（r1#1 那課：只直呼消毒器＝假綠）
    const put = await fetch(url('/settings'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipeBirthStats: { ok: { n: 999, lastAt: '2026-08-19', lastBank: '偽造' } } }),
    });
    assert.ok(put.ok, 'PUT 本身仍回成功（只是這一欄不收）');
    assert.equal(store.load().settings.recipeBirthStats?.ok?.n, 4, '★前端寫不進來、既有值不被蓋');
    // ★真的走匯出端點再匯入（原本手組 emptyDb＝匯出若剝掉這欄仍會綠）
    const exp = await fetch(url('/export'));
    assert.ok(exp.ok, '匯出要成功');
    const backup = await exp.json();
    assert.equal(backup?.settings?.recipeBirthStats?.ok?.n, 4, '★匯出檔裡要有這份紀錄（沒有＝還原一定丟）');
    store.save({ ...store.load(), settings: { ...store.load().settings, recipeBirthStats: {} } });
    const imp = await fetch(url('/import'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
    assert.equal(imp.status, 200, '匯入要成功');
    assert.equal(store.load().settings.recipeBirthStats?.ok?.n, 4, '★還原之後紀錄回來了');
  } finally { server.close(); }
});

test('G中｜完成提示的**呼叫端**真的把整包 recipe 傳進去（只驗 model 端＝reason 永遠空也會綠）', () => {
  const caller = readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8');
  assert.match(caller, /bankApplyDoneText\(res, t,[\s\S]{0,80}?\.recipe\)/, '★呼叫端傳的是整包 recipe（含 reason），不是只有 saved/rebirth');
});
