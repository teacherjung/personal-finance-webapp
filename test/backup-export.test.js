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

/**
 * 造一個假回應。
 *
 * ⚠️ `headers.get` **一律小寫比對**——真實 `fetch` 的 `Headers` 依 WHATWG 規格把名稱 byte-lowercase
 *    再查，`get('content-disposition')` 與 `get('Content-Disposition')` 拿到同一個值。
 *    舊版的假 headers 是 `headers[n] ?? headers[n.toLowerCase()]`，fixture 的鍵又是大寫的
 *    `'Content-Disposition'`，於是正式程式把標頭名改成小寫（生產環境**純等價**）就會讓成功題紅在
 *    檔名斷言＝假紅。這裡改成建構時就把鍵 lowercase，那才是模擬真的 Headers。
 * @param {{status?:number, statusText?:string, body?:string, headers?:Record<string,string>, textThrows?:boolean}} o
 */
function res(o = {}) {
  const status = o.status ?? 200;
  const headers = Object.fromEntries(Object.entries(o.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: o.statusText || '',
    headers: { get: (/** @type {string} */ n) => headers[String(n).toLowerCase()] ?? null },
    text: async () => { if (o.textThrows) throw new Error('連線中斷'); return o.body ?? ''; },
  };
}

/** 跑一次匯出，把落檔與提示都錄下來。 @param {any} response @param {{fetchThrows?:string, saveThrows?:string}} [opt] */
async function run(response, opt = {}) {
  const saved = /** @type {{filename:string, body:string}[]} */ ([]);
  const toasts = /** @type {{msg:string, isErr:boolean}[]} */ ([]);
  const out = await runExport({
    fetchFn: async () => { if (opt.fetchThrows) throw new Error(opt.fetchThrows); return response; },
    saveFile: (filename, body) => {
      if (opt.saveThrows) throw new Error(opt.saveThrows);
      saved.push({ filename, body });
    },
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
  //    但這一格**擋不住重新序列化**——`GOOD_BODY` 是緊湊 canonical 的 JSON，
  //    `JSON.stringify(JSON.parse(x)) === x` 對它剛好成立。真正守那件事的是下一題（排版過的 JSON）。
  assert.equal(saved[0].body, GOOD_BODY, '落檔內容必須與伺服器回的位元組完全相同');
  assert.equal(toasts.length, 1, '成功也要出聲——「靜靜成功」下一次就分不出它到底有沒有做事');
  assert.equal(toasts[0].isErr, false);
  assert.match(toasts[0].msg, /4\s*筆/, '提示要講「幾筆」（3 筆交易 ＋ 1 個帳戶 ＝ 4），使用者才有辦法察覺備份是空的');
  assert.match(toasts[0].msg, /finance-backup-2026-08\.json/, '提示要講存成什麼檔名，他才找得到那個檔');
  // 真實的備份是幾千筆，四位數以上要分節才讀得出量級（他就是靠這個數字判斷備份不是空的）
  assert.match(okMsg(3214, 'x.json'), /3,214/, '筆數要有千分位');
  // ⚠️ 這個數字是**所有頂層陣列的元素數總和**（實測 17 個集合：帳戶／交易／持股／每日淨值／快照／歷史…），
  //    跟他在收支頁看得到的筆數差很多（dailyValues、snapshots、history 通常遠大於交易數）。
  //    只寫「N 筆資料」他會拿去對收支頁、然後以為程式算錯了——所以提示必須自己收攏這個數字的意思。
  assert.match(okMsg(3214, 'x.json'), /全部加起來|全部相加|全算/,
    '筆數要講明是「所有集合加起來」——只寫「N 筆資料」他會拿去對收支頁的筆數，以為算錯了');
});

test('匯出｜落檔的是伺服器回的**原始位元組**（伺服器換成排版過的 JSON 也照樣原封不動）', async () => {
  // ⚠️ 這一題是補洞補上的：上面那題用的 `GOOD_BODY` 是緊湊、鍵序 canonical 的 JSON，而
  //    `JSON.stringify(JSON.parse(x)) === x` 對那種字串**剛好成立**——實測把落檔改成
  //    `saveFile(filename, JSON.stringify(parsed))`，整份考題照樣全綠＝檔頭那條「不重新序列化」
  //    的保證根本沒有考題撐著。
  //    今天的 `/api/export` 走 `res.json()` 確實是緊湊的（repo 沒有設 `json spaces`），
  //    但只要有人 `app.set('json spaces', 2)`、或前面擺一個會重排的代理，重新序列化就會**靜靜改掉**
  //    備份檔的內容——而這個檔案的用途正是「原封不動還原」。
  const pretty = JSON.stringify({ settings: { currency: 'TWD' }, transactions: [{ id: 't1' }] }, null, 2);
  const { saved } = await run(res({ body: pretty, headers: GOOD_HEADERS }));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].body, pretty,
    '落下去的必須是伺服器回的那串位元組本身，不可以 JSON.stringify(parse(...)) 重新排版');
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
  // ⚠️ 這一格是補洞補上的：原本伺服器一給文字原因就把狀態碼**換掉**，而我們自己的 HOSTED 5xx
  //    一定帶 JSON 原因（`lib/routes/auth.js` 的 wrap catch）＝最需要狀態碼的那條路剛好丟掉它。
  assert.match(toasts[0].msg, /401/, '有文字原因時狀態碼也要留：那是他來問我時唯一能定位的線索');
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
  // ⚠️ 這一格是補洞補上的：舊稿在 500 只講「伺服器回 500 Internal Server Error」就停住——
  //    他不懂 500 是什麼、也不知道要幹嘛。有線索不等於有下一步。
  assert.match(toasts[0].msg, /再試|告訴我/,
    '光把狀態碼丟給他不算幫到他：500 要給下一步（等一下再試／把這句話告訴我）');
});

test('匯出｜403：不落檔，而且**不可以**叫他重新登入（GET 不可能因登入被擋）', async () => {
  // ⚠️ 這一題是補洞補上的：舊版把 403 跟 401 綁在一起給「可能是登入過期了——重新登入再試一次」，
  //    那是**假的下一步**。本專案唯一會回 403 的地方是 `csrfOriginGuard`（lib/routes/auth.js），
  //    而它 `GET/HEAD/OPTIONS` 直接放行——`/api/export` 是 GET，所以我們自己的程式不可能因為
  //    登入狀態回 403（真回 403 是前面的代理／CDN 擋掉）。叫他登入他會反覆登入、以為是自己的問題。
  const { saved, toasts } = await run(res({ status: 403, statusText: 'Forbidden',
    body: JSON.stringify({ error: '請求來源不被允許' }), headers: GOOD_HEADERS }));
  assert.equal(saved.length, 0);
  assert.equal(toasts[0].isErr, true);
  assert.match(toasts[0].msg, /請求來源不被允許/, '伺服器講的原因要傳達給使用者');
  assert.match(toasts[0].msg, /沒有存下/);
  assert.doesNotMatch(toasts[0].msg, /登入/,
    '403 不是登入問題（GET 不經 CSRF 牆）——給「重新登入」是假的下一步');
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
  // ⚠️ 這一格是補洞補上的：這條路的 `err.message` 在真瀏覽器裡是「Failed to fetch」，對他毫無意義，
  //    而這**正是本機版最常見的失敗**（後端沒開／改完程式忘了重啟）。原因看不懂又沒有下一步＝等於沒說。
  assert.match(toasts[0].msg, /後端|網路/,
    '連不上要給下一步：本機版八成是後端沒在跑（「連線中斷」四個字他看不出要去做什麼）');
});

test('匯出｜讀回應途中斷線（text() 丟錯）⇒ 出聲、不落檔', async () => {
  const { out, saved, toasts } = await run(res({ textThrows: true, headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(toasts[0].isErr, true);
  assert.match(toasts[0].msg, /沒有存下/, '半路斷線最需要明講沒存下——「存了一半」是這裡最傷人的誤解');
  assert.match(toasts[0].msg, /後端|網路/, '這也是網路層斷掉，下一步跟「連不上」同一種');
});

test('匯出｜三關全過、但落檔那一步自己丟錯 ⇒ 一定要改口出聲，絕不可以說「已存下」', async () => {
  // ⚠️ 這一題是補洞補上的：原本 `saveFile` 丟錯會讓整個 `runExport` reject，**一句話都不會出現**
  //    ——靜靜失敗發生在最後一步，正是這一支存在的理由。而且畫面上若先說了「已存下備份」、
  //    硬碟上卻一個檔都沒有，那比舊版更糟（舊版至少沒騙他）。
  const { out, saved, toasts } = await run(res({ body: GOOD_BODY, headers: GOOD_HEADERS }), { saveThrows: '磁碟空間不足' });
  assert.equal(out.ok, false);
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(toasts.length, 1, '只能出現一句：不可以先報成功再報失敗（他會不知道要相信哪一句）');
  assert.equal(toasts[0].isErr, true, '落檔失敗就是失敗，要用錯誤的樣子出聲');
  assert.doesNotMatch(toasts[0].msg, /已存下/,
    '這是最傷人的一種騙：畫面說「已存下備份」，硬碟上一個檔都沒有');
  assert.match(toasts[0].msg, /磁碟空間不足/, '原因要傳出去，他才知道是硬碟滿了不是程式壞了');
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
  // ⚠️ 這三格釘的是**原因文字**，不只是 ok=false：不然「不是一份備份檔」那道型別守衛就沒人撐著
  //    （實測拿掉 `Array.isArray(data)` 之後只看 ok 的話全綠——因為兩條路都回 false）。
  //    而原因會原封不動出現在使用者眼前，「格式不對」與「裡面沒有資料」是兩種不同的下一步。
  // ⚠️ 措辭：不用「一包資料」——那是我們自己腦內的說法，使用者讀不出那是什麼意思。
  for (const notAPack of [[], 'unauthorized', 42]) {
    assert.match(summarizeBackup(notAPack).reason, /不是一份備份檔/,
      `${JSON.stringify(notAPack)} 連一份備份檔都不是——原因要講格式不對，`
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
  //    這裡**只釘性質、不釘某一版的字面輸出**：原本釘 `assert.equal(evil, '_.._etc_passwd')`，
  //    結果消毒改**更嚴**（例如連中間殘留的 `..` 也剝）就會紅——下一個想加強消毒的人會先以為
  //    自己弄壞了東西。消毒變嚴是好事，不該被考題擋，所以這裡問的是「危險的部分沒了、檔名還在」。
  const evil = filenameFromDisposition('attachment; filename="../../etc/passwd"');
  assert.doesNotMatch(evil, /[\\/]/, '路徑分隔符不可留在下載檔名裡（否則等於讓伺服器決定檔案落到哪個目錄）');
  assert.doesNotMatch(evil, /^\./, '不可落成隱藏檔——使用者在下載夾裡看不到，會以為根本沒存成功');
  assert.match(evil, /passwd$/,
    '剝掉的要是危險的部分、不是整個檔名——整段砍光會退回預設檔名，'
    + '兩次匯出就互相覆蓋（他以為有兩份備份，其實只有一份）');
  assert.equal(filenameFromDisposition('attachment; filename=".hidden"'), 'hidden');
});

/** 去註解（接線題讀原始碼文字，照 AGENTS 的硬規則先把註解拿掉）。 @param {string} raw */
function stripComments(raw) {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

/**
 * 從 `from`（必須正好是 `open`）起抓出配對到的那一段，含頭尾括號。
 * ⚠️ 純字元計數，不懂字串裡的括號——這是原始碼文字題的既有限制（抓不到會讓考題紅，不會假綠）。
 * @param {string} src @param {number} from @param {string} open @param {string} close
 */
function matchedSpan(src, from, open, close) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(from, i + 1);
  }
  return '';
}

/**
 * 從物件字面的原始碼裡切出某個屬性那一段（到同層的逗號或收尾為止）。
 * 簡寫（`toast,`）回 `'toast'`；`toast: () => {}` 回整段。
 * @param {string} objSrc @param {string} name
 */
function sliceProp(objSrc, name) {
  const m = objSrc.match(new RegExp(`\\b${name}\\b`));
  if (!m || m.index === undefined) return '';
  let depth = 0;
  for (let i = m.index + name.length; i < objSrc.length; i++) {
    const c = objSrc[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return objSrc.slice(m.index, i); depth--; }
    else if (c === ',' && depth === 0) return objSrc.slice(m.index, i);
  }
  return objSrc.slice(m.index);
}

test('接線｜設定頁那顆匯出鈕真的走這支模組，而且注入的相依不是啞巴', () => {
  // ⚠️ 為什麼需要這一題：純模組再怎麼正確，只要正式頁面沒有接上就等於沒做——本專案被審查者
  //    抓過好幾次「考題驗中間層、使用者走的是另一條路」。
  // ⚠️ **這一題整個重寫過**（審查者實測抓到）：舊版的五條斷言是**各自獨立的字面**
  //    （import 一行／任一處 `runExport(`／`id="exportBtn"`／`exportBtn').onclick`／任一處
  //    `preventDefault()`），沒有一條把它們綁在同一條路徑上。實測繞法：留著 import、在別處放一個
  //    沒人按的 `const deadExport = () => runExport({...})`，然後讓 `exportBtn` 的 onclick 自己
  //    `fetch` ＋ Blob 落檔 ＋ 出聲——**全樹一根寒毛都不動**，三道關卡完全被繞過。
  //    所以現在改成：先把 `exportBtn` 的 handler 區塊切出來，在**那一段裡面**問。
  // ⚠️ 讀的是原始碼文字，擋不住刻意混淆（把名字拼接起來之類）——寫在檔頭的誠實劃界裡。
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8'));

  assert.match(src, /import\s*\{[^}]*\brunExport\b[^}]*\}\s*from\s*['"]\.\/backup-export\.js['"]/,
    '設定頁必須從 ./backup-export.js import runExport——自己另寫一套下載就繞過了三道關卡');
  assert.ok(src.includes('id="exportBtn"'), '那顆鈕要有 id="exportBtn" 才接得到 click');

  // ── ①切出 exportBtn 的 handler 區塊：從綁定處到下一個 byId(...) 綁定為止 ────────────────
  //    綁定寫法**不只認一種**：`.onclick` 與 `addEventListener('click')` 都算
  //    （後者其實更好，不會蓋掉別人綁的 handler；舊版硬綁 `.onclick` 會讓這種等價改寫假紅）。
  const bind = src.match(/byId\(\s*['"]exportBtn['"]\s*\)\s*(?:\.onclick|\.addEventListener\s*\(\s*['"]click)/);
  assert.ok(bind && bind.index !== undefined,
    '匯出鈕要綁 click（.onclick 或 addEventListener 都可以）——沒綁的話瀏覽器會照 href 直接下載＝退回舊的靜靜失敗');
  const after = src.slice(bind.index + bind[0].length);
  const nextBindAt = after.search(/byId\(\s*['"][^'"]+['"]\s*\)\s*(?:\.on[a-z]+|\.addEventListener)/);
  const block = nextBindAt < 0 ? after : after.slice(0, nextBindAt);   // 是最後一個綁定就延伸到檔尾

  assert.match(block, /preventDefault\s*\(\s*\)/,
    '必須在**這顆鈕自己的 handler 裡**preventDefault——不擋的話瀏覽器會照 href 直接下載一份未經檢查的'
    + '檔案，使用者會同時得到「一個沒驗過的檔」與「一個提示」，比舊版更糟');
  const callAt = block.search(/\brunExport\s*\(/);
  assert.ok(callAt >= 0,
    'runExport 要在**這顆鈕的 handler 裡**被呼叫——擺在別處、沒人按得到的 runExport（死函式）不算接上');

  const span = matchedSpan(block, block.indexOf('(', callAt), '(', ')');
  assert.ok(span.length > 2, 'runExport(...) 的參數括號沒配對成功（原始碼文字題的限制，寫法太特殊就抓不到）');
  const args = span.slice(1, -1);
  const outside = block.split(span).join('');   // handler 裡「不在 runExport(...) 參數內」的部分

  // ── ②handler 自己不可以再抓一份／再落一份檔（那就是繞過三道關卡） ──────────────────
  for (const [banned, what] of [[/\bfetch\s*\(/, 'fetch'], [/createObjectURL/, 'createObjectURL'],
    [/\bnew\s+Blob\b/, 'new Blob'], [/\.download\s*=/, '設定 a.download']]) {
    assert.doesNotMatch(outside, /** @type {RegExp} */ (banned),
      `handler 自己不可以做 ${what}——要下載請走注入給 runExport 的 saveFile，`
      + '在 handler 裡自己抄一套等於三道關卡形同不存在（審查者實測過這條繞法）');
  }

  // ── ③注入的相依必須是真的東西，不是啞巴 ────────────────────────────────────────
  //    這是本支存在的唯一理由（說了已存下就是真的存下），卻是最容易被「換成啞巴」悄悄拆掉的地方。
  const fetchProp = sliceProp(args, 'fetchFn');
  assert.match(fetchProp, /\bfetch\s*\(/,
    'fetchFn 必須是真的 fetch——餵它假回應等於整支模組在驗一份不存在的備份');

  const toastProp = sliceProp(args, 'toast');
  assert.notEqual(toastProp, '', 'runExport 必須拿到 toast，否則成功失敗都不出聲');
  const toastVal = toastProp.replace(/^toast\s*:?/, '').trim();
  assert.ok(toastVal === '' || /\btoast\b/.test(toastVal),
    '傳進去的必須是**真的那個 toast**（簡寫 `toast,`、`toast: toast`、包一層再呼叫 toast 都算）——'
    + '實測改成 `toast: () => {}` 三道關卡照樣跑、全樹照樣全綠，但使用者按下匯出後成功失敗都聽不到'
    + '一聲＝這一支要修的病灶原封不動回來');

  const saveProp = sliceProp(args, 'saveFile');
  assert.notEqual(saveProp, '', 'runExport 必須拿到 saveFile');
  assert.match(saveProp, /createObjectURL|showSaveFilePicker|msSaveBlob|data:application\/json/,
    'saveFile 必須真的把檔案落到硬碟（Blob 網址／檔案系統 API／data: 網址都算）——'
    + '實測改成 `saveFile: () => {}` 也全綠，而畫面會說「已存下備份：3,214 筆紀錄」而硬碟上一個檔都沒有，'
    + '那比舊版更糟（舊版至少沒騙他）');
  assert.match(saveProp, /\.download\b|\bclick\s*\(|\bwrite\b/,
    'saveFile 光把網址建出來不算落檔，要真的觸發下載／寫檔');
});
