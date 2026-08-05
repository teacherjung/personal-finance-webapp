// @ts-check
// 匯出備份「按下去會說話」的考題（William 2026-08-05 裁決另開一支修）。
//
// 這一族守的是一個**靜靜失敗**：舊版那顆鈕是純 `<a href="/api/export" download>`，
// 瀏覽器把回應直接存成檔案，成功失敗都不出聲。雲端版 session 過期時，存下來的是一個
// 內容是錯誤訊息（或登入頁 HTML）的 `.json`，而使用者以為自己有備份了——
// 而 PR #410 剛把他的自保完全押在這顆鈕上（分類管理與店名規則的文案都叫人先按它）。
//
// ⚠️ 每一條都要問「弄壞它，我這條會紅嗎」。三道關卡各自有專屬的紅：
//    ①HTTP 狀態沒看 ②內容 parse 不出 JSON 沒看 ③parse 出來但不是備份（錯誤信封）沒看。
//    突變清單寫在 commit 訊息裡，審查者可自行重放。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runExport, summarizeBackup, filenameFromDisposition, okMsg, FALLBACK_FILENAME } from '../public/modules/backup-export.js';

const ROOT = new URL('..', import.meta.url).pathname;

/** 造一個假回應。 @param {{status?:number, statusText?:string, body?:string, headers?:Record<string,string>, textThrows?:boolean}} o */
function res(o = {}) {
  const status = o.status ?? 200;
  const headers = o.headers || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: o.statusText || '',
    headers: { get: (/** @type {string} */ n) => headers[n] ?? headers[n.toLowerCase()] ?? null },
    text: async () => { if (o.textThrows) throw new Error('連線中斷'); return o.body ?? ''; },
  };
}

/** 跑一次匯出，把落檔與提示都錄下來。 @param {any} response @param {{fetchThrows?:string}} [opt] */
async function run(response, opt = {}) {
  const saved = /** @type {{filename:string, body:string}[]} */ ([]);
  const toasts = /** @type {{msg:string, isErr:boolean}[]} */ ([]);
  const out = await runExport({
    fetchFn: async () => { if (opt.fetchThrows) throw new Error(opt.fetchThrows); return response; },
    saveFile: (filename, body) => saved.push({ filename, body }),
    toast: (msg, isErr = false) => toasts.push({ msg, isErr }),
  });
  return { out, saved, toasts };
}

const GOOD_BODY = JSON.stringify({
  settings: { currency: 'TWD' },
  transactions: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
  accounts: [{ id: 'a1' }],
  holdings: [],
});
const GOOD_HEADERS = { 'Content-Disposition': 'attachment; filename="finance-backup-2026-08.json"' };

test('匯出｜成功：檔案落下去、而且真的出聲說存了幾筆', async () => {
  const { out, saved, toasts } = await run(res({ body: GOOD_BODY, headers: GOOD_HEADERS }));
  assert.equal(out.ok, true);
  assert.equal(out.saved, true);
  assert.equal(saved.length, 1, '成功時必須真的落一個檔');
  assert.equal(saved[0].filename, 'finance-backup-2026-08.json',
    '檔名要用伺服器 Content-Disposition 給的那個——前端自己算月份就是第二份會漂的複本');
  // ⚠️ 落下去的必須是**原始文字**、不是重新序列化的：備份的用途是原封不動還原。
  assert.equal(saved[0].body, GOOD_BODY,
    '落檔內容必須與伺服器回的位元組完全相同（不可 JSON.stringify(parse(...)) 重新排版）');
  assert.equal(toasts.length, 1, '成功也要出聲——「靜靜成功」下一次就分不出它到底有沒有做事');
  assert.equal(toasts[0].isErr, false);
  assert.match(toasts[0].msg, /4/, '提示要講「幾筆」（3 筆交易 ＋ 1 個帳戶 ＝ 4），使用者才有辦法察覺備份是空的');
  assert.match(toasts[0].msg, /finance-backup-2026-08\.json/, '提示要講存成什麼檔名，他才找得到那個檔');
  // 真實的備份是幾千筆，四位數以上要分節才讀得出量級（他就是靠這個數字判斷備份不是空的）
  assert.match(okMsg(3214, 'x.json'), /3,214/, '筆數要有千分位');
});

test('匯出｜HTTP 狀態不 ok（雲端版 session 過期）：不可落檔，而且要明講沒存下任何東西', async () => {
  // ⚠️ 這是舊版最致命的那條路：舊版 <a download> 根本沒看狀態，401 的內容照樣被存成「備份」。
  const { out, saved, toasts } = await run(res({ status: 401, statusText: 'Unauthorized',
    body: JSON.stringify({ error: '請先登入' }), headers: GOOD_HEADERS }));
  assert.equal(out.ok, false);
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0, '失敗時一個檔都不可以落下去——落了就是「他以為自己有備份」');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].isErr, true);
  assert.match(toasts[0].msg, /請先登入/, '伺服器講的原因要傳達給使用者，不要只說「失敗」');
  assert.match(toasts[0].msg, /沒有存下/, '必須明講「沒有存下任何檔案」，否則他會以為存了一半');
});

test('匯出｜狀態不 ok、而錯誤內容剛好有頂層陣列 ⇒ 只有關卡①攔得住（上一題攔不住這種）', async () => {
  // ⚠️ 這一題是補洞補上去的：上一題（401 + `{ error: '請先登入' }`）**證不到關卡①是必要的**——
  //    實測把 `if (!res.ok)` 整段拿掉，上一題照樣全綠，因為那個錯誤信封會被關卡③接住。
  //    但關卡③的判準刻意寬鬆（「有頂層陣列就算像備份」），所以閘道回的
  //    `{"errors":[{"message":"JWT expired"}]}` 這一型（Supabase／各家 gateway 很常見）
  //    會直接通過②③——**只剩狀態碼攔得住它**。少了關卡①，使用者就會拿到一個
  //    寫著「已存下備份：1 筆資料」的 JWT 過期訊息，而他以為自己有備份了。
  const { out, saved, toasts } = await run(res({ status: 401, statusText: 'Unauthorized',
    body: JSON.stringify({ errors: [{ message: 'JWT expired' }] }), headers: GOOD_HEADERS }));
  assert.equal(out.saved, false, '狀態 401 就是失敗，內容長得再像備份都不可以落檔');
  assert.equal(saved.length, 0);
  assert.equal(toasts[0].isErr, true);
  assert.match(toasts[0].msg, /401/, '伺服器沒給文字原因時，至少要把狀態碼講出來（他才有東西可以問）');
  assert.match(toasts[0].msg, /沒有存下/);
  assert.match(toasts[0].msg, /登入/, '401 就是認證問題，要給他「重新登入再試一次」這個下一步');
});

test('匯出｜伺服器自己掛了（500）：照樣不落檔，但**不可以**叫他重新登入', async () => {
  // ⚠️ 這一題守的是「別把他推往錯的方向」：500／502／503 掛的是伺服器那一端，
  //    跟他的登入狀態無關。若這裡也附上「可能是登入過期了——重新登入再試一次」，
  //    他會反覆登入、以為是自己的問題，而真正該做的是等一下再試／來問我。
  const { out, saved, toasts } = await run(res({ status: 500, statusText: 'Internal Server Error',
    body: '<html>oops</html>', headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(toasts[0].isErr, true);
  assert.match(toasts[0].msg, /500/, '狀態碼要講出來——那是他來問我時唯一有用的線索');
  assert.match(toasts[0].msg, /沒有存下/);
  assert.doesNotMatch(toasts[0].msg, /登入/,
    '500 不可以叫他重新登入：那是伺服器那一端掛了，叫他登入只會讓他在錯的地方繞');
});

test('匯出｜狀態 ok 但回的是登入頁 HTML：parse 不出 JSON ⇒ 不可落檔', async () => {
  // ⚠️ 這條比 401 更陰：有些部署會把未登入的請求 302 導去登入頁，fetch 跟著轉址後拿到的是
  //    **狀態 200 的 HTML**。舊版會存下一個副檔名是 .json、內容是網頁的檔案。
  const { out, saved, toasts } = await run(res({ body: '<!doctype html><html><body>請登入</body></html>', headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(toasts[0].isErr, true);
  assert.match(toasts[0].msg, /不是備份內容/);
  assert.match(toasts[0].msg, /登入/, '這種情況最常見的原因是登入過期，提示要給他下一步');
});

test('匯出｜狀態 ok、是 JSON，但是錯誤信封（沒有任何集合）⇒ 不可落檔', async () => {
  const { out, saved, toasts } = await run(res({ body: JSON.stringify({ error: '權限不足' }), headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.match(toasts[0].msg, /權限不足/);
});

test('匯出｜連不上伺服器（fetch reject）⇒ 出聲、不落檔、不炸掉頁面', async () => {
  // ⚠️ 這條在本機版是**最常見**的一條：後端沒開著（或改完程式忘了重啟）。
  const { out, saved, toasts } = await run(res({}), { fetchThrows: '連線中斷' });
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(toasts[0].isErr, true);
  assert.match(toasts[0].msg, /連線中斷/);
  // ⚠️ 這一格是補洞補上的：原本只有 401 那兩題釘「沒有存下」，而它們走的是 notBackupMsg——
  //    實測把 failMsg 的「沒有存下任何檔案」刪掉，整份考題照樣全綠（＝這條路沒人守）。
  assert.match(toasts[0].msg, /沒有存下/, '連不上也要明講「沒有存下任何檔案」，否則他不知道要不要重做一次');
});

test('匯出｜讀回應途中斷線（text() 丟錯）⇒ 出聲、不落檔', async () => {
  const { out, saved, toasts } = await run(res({ textThrows: true, headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(toasts[0].isErr, true);
  assert.match(toasts[0].msg, /沒有存下/, '半路斷線最需要明講沒存下——「存了一半」是這裡最傷人的誤解');
});

test('判準｜「長得像備份」認的是性質（有頂層陣列），不是寫死的集合名單', () => {
  // ⚠️ 刻意**不列舉**集合名稱：前端不能 import lib/schema.js 的 ALL_COLLECTIONS，
  //    抄一份過來就是第二份會漂的複本（本專案為這個病型付過很多代價）。
  assert.equal(summarizeBackup({ settings: {}, whateverNewCollection: [{ a: 1 }] }).ok, true,
    '將來新增的集合不必回來改這裡——判準是「有頂層陣列」而不是「叫什麼名字」');
  assert.equal(summarizeBackup({ settings: {}, transactions: [] }).ok, true, '空集合是合法備份（新使用者）');
  assert.equal(summarizeBackup({ error: '請先登入' }).ok, false, '錯誤信封沒有任何集合 ⇒ 不是備份');
  assert.equal(summarizeBackup({}).ok, false);
  assert.equal(summarizeBackup([]).ok, false, '陣列本身不是備份');
  assert.equal(summarizeBackup(null).ok, false);
  assert.equal(summarizeBackup('unauthorized').ok, false, '純字串不是備份');
  // ⚠️ 這三格釘的是**原因文字**，不只是 ok=false：不然「不是一包資料」那道型別守衛就沒人撐著
  //    （實測拿掉 `Array.isArray(data)` 之後只看 ok 的話全綠——因為兩條路都回 false）。
  //    而原因會原封不動出現在使用者眼前，「格式不對」與「裡面沒有資料」是兩種不同的下一步。
  for (const notAPack of [[], 'unauthorized', 42]) {
    assert.match(summarizeBackup(notAPack).reason, /不是一包資料/,
      `${JSON.stringify(notAPack)} 連「一包資料」都不是——原因要講格式不對，`
      + '不可以講成「裡面沒有任何一筆資料」（那會害他以為自己的資料不見了）');
  }
  assert.equal(summarizeBackup({ settings: {}, a: [1, 2], b: [3] }).total, 3, '筆數＝所有頂層陣列的元素數總和');
  // 錯誤信封的原因要傳出去（不然使用者只看到「失敗」）
  assert.match(summarizeBackup({ error: '權限不足' }).reason, /權限不足/);
});

test('判準｜檔名從 Content-Disposition 取，取不到才退回預設；路徑分隔符一律剝掉', () => {
  assert.equal(filenameFromDisposition('attachment; filename="finance-backup-2026-08.json"'), 'finance-backup-2026-08.json');
  assert.equal(filenameFromDisposition('attachment; filename=plain.json'), 'plain.json');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E5%82%99%E4%BB%BD.json"), '備份.json');
  assert.equal(filenameFromDisposition(null), FALLBACK_FILENAME, '伺服器沒給就用預設，不要落一個沒有名字的檔');
  assert.equal(filenameFromDisposition('attachment; filename=""'), FALLBACK_FILENAME);
  // ⚠️ 這一格是安全面：檔名會落到使用者的硬碟，路徑分隔符與上層參照不可以照抄。
  //    先釘**性質**（沒有分隔符、不是隱藏檔）再釘字面——性質才是要守的東西，字面只是順手把行為釘住。
  const evil = filenameFromDisposition('attachment; filename="../../etc/passwd"');
  assert.doesNotMatch(evil, /[\\/]/, '路徑分隔符不可留在下載檔名裡（否則等於讓伺服器決定檔案落到哪個目錄）');
  assert.doesNotMatch(evil, /^\./, '不可落成隱藏檔——使用者在下載夾裡看不到，會以為根本沒存成功');
  assert.equal(evil, '_.._etc_passwd', '兩道都作用過的樣子：分隔符換成 _、開頭剩下的點再剝掉');
  assert.equal(filenameFromDisposition('attachment; filename=".hidden"'), 'hidden');
});

test('接線｜設定頁那顆匯出鈕真的走這支模組（不是又自己抄一份下載）', () => {
  // ⚠️ 為什麼需要這一題：純模組再怎麼正確，只要正式頁面沒有接上就等於沒做——本專案被審查者
  //    抓過好幾次「考題驗中間層、使用者走的是另一條路」。
  // ⚠️ 這一題讀的是**原始碼文字**，所以照 AGENTS 的硬規則**先去註解**、而且不只認一種寫法。
  //    它擋不住刻意混淆（例如把名字拼接起來）——那條寫在檔頭的誠實劃界裡。
  const raw = readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.match(src, /import\s*\{[^}]*\brunExport\b[^}]*\}\s*from\s*['"]\.\/backup-export\.js['"]/,
    '設定頁必須從 ./backup-export.js import runExport——自己另寫一套下載就繞過了三道關卡');
  assert.match(src, /\brunExport\s*\(/, 'import 了卻沒呼叫＝等於沒接上');
  const i = src.indexOf("id=\"exportBtn\"");
  assert.ok(i > 0, '那顆鈕要有 id="exportBtn" 才接得到 onclick');
  assert.match(src, /exportBtn['"]\s*\)\s*\.onclick/, '匯出鈕要綁 onclick（沒綁的話瀏覽器會直接下載＝退回舊的靜靜失敗）');
  assert.match(src, /preventDefault\s*\(\s*\)/,
    '必須 preventDefault——不擋的話瀏覽器會照 href 直接下載一份未經檢查的檔案，'
    + '使用者會同時得到「一個沒驗過的檔」與「一個提示」，比舊版更糟');
});
