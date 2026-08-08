// @ts-check
// 匯出備份「按下去會說話」的考題（William 2026-08-05 裁決另開一支修）。
//
// 這一族守的是一個**靜靜失敗**：舊版那顆鈕是純 `<a href="/api/export" download>`，
// 瀏覽器把回應直接存成檔案，成功失敗都不出聲。雲端版 session 過期時，存下來的是一個
// 內容是錯誤訊息（或登入頁 HTML）的 `.json`，而使用者以為自己有備份了——
// 而 PR #410 剛把他的自保完全押在這顆鈕上（分類管理與店名規則的文案都叫人先按它）。
//    ⚠️ 2026-08-08 訂正：**分類管理已經不指向匯出**（只留「儲存後無法復原」一句警告，
//    William 2026-08-06 拍板）；店名規則那兩處的指路也在 #422 一併拿掉。這裡留作沿革。
//
// ⚠️ 每一條都要問「弄壞它，我這條會紅嗎」。三道關卡各自有專屬的紅：
//    ①HTTP 狀態沒看 ②內容 parse 不出 JSON 沒看 ③parse 出來但不是備份（錯誤信封）沒看。
//    突變清單寫在 commit 訊息裡，審查者可自行重放。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runExport, summarizeBackup, filenameFromDisposition, okMsg, FALLBACK_FILENAME,
  BUSY_MSG, EXPORT_NOTICE_LOCAL, EXPORT_NOTICE_HOSTED, exportNotice, EXPORT_TIMEOUT_MS, timeoutFailMsg, defaultWithTimeout,
  authFailMsg, networkFailMsg, serverFailMsg, notBackupMsg, saveFailMsg,
} from '../public/modules/backup-export.js';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * 去掉 JS 註解——**被註解掉的接線等於不存在**（r5 阻擋②：複驗者把接線改成註解，本檔的形狀題全綠）。
 * ⚠️ 行註解只在 `//` 前面不是 `:`／引號／反斜線／文字時才剝：否則 `https://`、`split('//')`、
 *    正規式 `/\/\//` 會被誤剝半行（那會讓真程式憑空消失＝另一種假綠）。
 * ⚠️ 與 test/vault-and-backup-integrity.test.js 的同名函式**同一份寫法**（那支是先例）。
 * @param {string} s @returns {string}
 */
const stripJsComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"`\w\\])\/\/[^\n]*/g, '$1');


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
  // ⚠️ #417 r4 起**每次都會先有一句「匯出中…」**（William 要的即時回饋／審查者 r3 阻擋的那一項）。
  //    所以各題要看的是**結果那一句**＝最後一句；`busy` 另外拉出來給專門那一題驗。
  return { out, saved, toasts, busy: toasts[0], result: toasts[toasts.length - 1] };
}

const GOOD_BODY = JSON.stringify({
  settings: { currency: 'TWD' },
  transactions: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
  accounts: [{ id: 'a1' }],
  holdings: [],
});
const GOOD_HEADERS = { 'Content-Disposition': 'attachment; filename="finance-backup-2026-08.json"' };

test('匯出｜成功：檔案落下去、而且真的出聲說存了幾筆', async () => {
  const { out, saved, toasts, result } = await run(res({ body: GOOD_BODY, headers: GOOD_HEADERS }));
  assert.equal(out.ok, true);
  assert.equal(out.saved, true);
  assert.equal(saved.length, 1, '成功時必須真的落一個檔');
  assert.equal(saved[0].filename, 'finance-backup-2026-08.json',
    '檔名要用伺服器 Content-Disposition 給的那個——前端自己算月份就是第二份會漂的複本');
  // ⚠️ 落下去的必須是**原始文字**、不是重新序列化的：備份的用途是原封不動還原。
  //    但這一格**擋不住重新序列化**——`GOOD_BODY` 是緊湊 canonical 的 JSON，
  //    `JSON.stringify(JSON.parse(x)) === x` 對它剛好成立。真正守那件事的是下一題（排版過的 JSON）。
  assert.equal(saved[0].body, GOOD_BODY, '落檔內容必須與伺服器回的那串文字完全相同');
  assert.equal(toasts.length, 2, '應有兩句：先「匯出中…」再結果——成功也要出聲，「靜靜成功」下一次就分不出它到底有沒有做事');
  assert.equal(result.isErr, false);
  // ⚠️⚠️ **不可宣稱已完成**（r1 審查者抓到，2026-08-06 補）：這條路只做到 `a.click()`——使用者按取消、
  //    瀏覽器把下載擋掉、下載中途失敗，`<a>` 這條路**一個訊號都不會回來**。原本寫「已存下備份：…」
  //    就是在沒有證據時宣告成功，而那正是這一整支要消滅的病（我自己犯的同一種）。
  //    這一格要求的是**口徑**：只講我們真的知道的（連結交出去了、這份東西幾筆），結果交給他去確認。
  // ⚠️ `已開始下載` 也在黑名單裡（r2 審查者抓到，2026-08-06 補）：程式只做到「把連結交出去」，
  //    瀏覽器把下載擋掉、或使用者在存檔對話框按取消時，「開始」**並沒有發生**。這一檔的 JSDoc
  //    早就寫著「沒丟錯只代表交出去了」，文案卻多講一步＝口徑沒收乾淨。只准講交出去了。
  assert.doesNotMatch(result.msg, /已存下|已存好|備份完成|已完成|已開始下載|下載完成/,
    '不可以宣稱「已存下／已完成／已開始下載」——把連結交給瀏覽器之後，成功與否這裡收不到任何回音');
  assert.match(result.msg, /匯出成功/,
    '要講出我們唯一有證據的那件事：備份已經**交給瀏覽器**下載（做到哪裡就講到哪裡）');
  assert.match(result.msg, /下載|確認/,
    '既然結果不知道，就要把「去下載夾確認檔案在不在」這個下一步交給他');
  assert.match(result.msg, /4\s*筆/, '提示要講「幾筆」（3 筆交易 ＋ 1 個帳戶 ＝ 4），使用者才有辦法察覺備份是空的');
  assert.match(result.msg, /finance-backup-2026-08\.json/, '提示要講存成什麼檔名，他才找得到那個檔');
  // 真實的備份是幾千筆，四位數以上要分節才讀得出量級（他就是靠這個數字判斷備份不是空的）
  assert.match(okMsg(3214, 'x.json'), /3,214/, '筆數要有千分位');
  // ⚠️ 這個數字是**所有頂層陣列的元素數總和**（實測 17 個集合：帳戶／交易／持股／每日淨值／快照／歷史…），
  //    跟他在收支頁看得到的筆數差很多。舊版提示會加一句「全部加起來」把這件事講明，
  //    **William 2026-08-08 裁決「太長」**之後那句話拿掉了——現在筆數與檔名一起放在括號裡當
  //    「量級參考」，句子主體只講下一步（請至下載確認檔案）。
  //    ⚠️ 所以這一題的斷言也跟著收窄：只釘「有筆數、有千分位、有檔名」，不再釘那句解釋。
  //    代價誠實記著：他若拿這個數字去對收支頁的筆數，畫面上沒有東西提醒他兩者不同。
  assert.match(result.msg, /（.*4\s*筆/, '筆數與檔名放在括號裡（量級參考），句子主體留給下一步');
});

test('匯出｜伺服器怎麼排版就照樣落檔（不重新序列化；換成排版過的 JSON 也原封不動）', async () => {
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
    '落下去的必須是伺服器回的那串文字本身，不可以 JSON.stringify(parse(...)) 重新排版');
  // ⚠️ 這一題守的是「文字層一模一樣」，**不是位元組層**：`res.text()` 已經把位元組解碼過
  //    （依規格會吃掉開頭的 UTF-8 BOM），再由 Blob 重新編碼。檔頭原本寫「原始位元組」是誇大，
  //    2026-08-06 改成事實。現行 `/api/export`（Express `res.json()`）不帶 BOM，所以咬不到人。
});

test('匯出｜HTTP 狀態不 ok（雲端版 session 過期）：不可落檔，而且要明講沒存下任何東西', async () => {
  // ⚠️ 這是舊版最致命的那條路：舊版 <a download> 根本沒看狀態，401 的內容照樣被存成「備份」。
  const { out, saved, toasts, result } = await run(res({ status: 401, statusText: 'Unauthorized',
    body: JSON.stringify({ error: '請先登入' }), headers: GOOD_HEADERS }));
  assert.equal(out.ok, false);
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0, '失敗時一個檔都不可以落下去——落了就是「他以為自己有備份」');
  assert.equal(toasts.length, 2);   // 「匯出中…」＋結果
  assert.equal(result.isErr, true);
  assert.match(out.reason, /請先登入/, '伺服器講的原因要留在回傳 reason 裡（排查用；畫面只給下一步——William 2026-08-08「太長」的裁決）');
  assert.match(result.msg, /匯出失敗/, '必須明講失敗，否則他會以為存好了');
  // ⚠️ 這一格是補洞補上的：原本伺服器一給文字原因就把狀態碼**換掉**，而我們自己的 HOSTED 5xx
  //    一定帶 JSON 原因（`lib/routes/auth.js` 的 wrap catch）＝最需要狀態碼的那條路剛好丟掉它。
  assert.match(out.reason, /401/, '狀態碼要留在 reason 裡：那是他來問我時唯一能定位的線索（畫面上不放）');
});

test('匯出｜狀態不 ok、而錯誤內容剛好有頂層陣列 ⇒ 只有關卡①攔得住（上一題攔不住這種）', async () => {
  // ⚠️ 這一題是補洞補上去的：上一題（401 + `{ error: '請先登入' }`）**證不到關卡①是必要的**——
  //    實測把 `if (!res.ok)` 整段拿掉，上一題照樣全綠，因為那個錯誤信封會被關卡③接住。
  //    但關卡③的判準刻意寬鬆（「有頂層陣列就算像備份」），所以閘道回的
  //    `{"errors":[{"message":"JWT expired"}]}` 這一型（Supabase／各家 gateway 很常見）
  //    會直接通過②③——**只剩狀態碼攔得住它**。少了關卡①，使用者就會拿到一個
  //    寫著「已存下備份：1 筆資料」的 JWT 過期訊息，而他以為自己有備份了。
  const { out, saved, result } = await run(res({ status: 401, statusText: 'Unauthorized',
    body: JSON.stringify({ errors: [{ message: 'JWT expired' }] }), headers: GOOD_HEADERS }));
  assert.equal(out.saved, false, '狀態 401 就是失敗，內容長得再像備份都不可以落檔');
  assert.equal(saved.length, 0);
  assert.equal(result.isErr, true);
  assert.match(out.reason, /401/, '伺服器沒給文字原因時，狀態碼至少要留在 reason 裡');
  assert.match(result.msg, /匯出失敗/);
  assert.match(result.msg, /重新登入/, '401 就是認證問題，要給他「重新登入再按匯出」這個下一步');
});

test('匯出｜伺服器自己掛了（500）：照樣不落檔，但**不可以**叫他重新登入', async () => {
  // ⚠️ 這一題守的是「別把他推往錯的方向」：500／502／503 掛的是伺服器那一端，
  //    跟他的登入狀態無關。若這裡也附上「可能是登入過期了——重新登入再試一次」，
  //    他會反覆登入、以為是自己的問題，而真正該做的是等一下再試／來問我。
  const { out, saved, result } = await run(res({ status: 500, statusText: 'Internal Server Error',
    body: '<html>oops</html>', headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(result.isErr, true);
  assert.match(out.reason, /500/, '狀態碼要留在 reason 裡——那是他來問我時唯一有用的線索');
  assert.match(result.msg, /匯出失敗/);
  assert.doesNotMatch(result.msg, /登入/,
    '500 不可以叫他重新登入：那是伺服器那一端掛了，叫他登入只會讓他在錯的地方繞');
  // ⚠️ 這一格是補洞補上的：舊稿在 500 只講「伺服器回 500 Internal Server Error」就停住——
  //    他不懂 500 是什麼、也不知道要幹嘛。有線索不等於有下一步。
  assert.match(result.msg, /再試|告訴我/,
    '光把狀態碼丟給他不算幫到他：500 要給下一步（等一下再試／把這句話告訴我）');
});

test('匯出｜403：不落檔，而且**不可以**叫他重新登入（GET 不可能因登入被擋）', async () => {
  // ⚠️ 這一題是補洞補上的：舊版把 403 跟 401 綁在一起給「可能是登入過期了——重新登入再試一次」，
  //    那是**假的下一步**。本專案唯一會回 403 的地方是 `csrfOriginGuard`（lib/routes/auth.js），
  //    而它 `GET/HEAD/OPTIONS` 直接放行——`/api/export` 是 GET，所以我們自己的程式不可能因為
  //    登入狀態回 403（真回 403 是前面的代理／CDN 擋掉）。叫他登入他會反覆登入、以為是自己的問題。
  const { out, saved, result } = await run(res({ status: 403, statusText: 'Forbidden',
    body: JSON.stringify({ error: '請求來源不被允許' }), headers: GOOD_HEADERS }));
  assert.equal(saved.length, 0);
  assert.equal(result.isErr, true);
  assert.match(out.reason, /請求來源不被允許/, '伺服器講的原因要留在 reason 裡（畫面只給下一步）');
  assert.match(result.msg, /匯出失敗/);
  assert.doesNotMatch(result.msg, /登入/,
    '403 不是登入問題（GET 不經 CSRF 牆）——給「重新登入」是假的下一步');
});

test('匯出｜狀態 ok 但回的是登入頁 HTML：parse 不出 JSON ⇒ 不可落檔', async () => {
  // ⚠️ 這條比 401 更陰：有些部署會把未登入的請求 302 導去登入頁，fetch 跟著轉址後拿到的是
  //    **狀態 200 的 HTML**。舊版會存下一個副檔名是 .json、內容是網頁的檔案。
  const { out, saved, result } = await run(res({ body: '<!doctype html><html><body>請登入</body></html>', headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(result.isErr, true);
  assert.match(out.reason, /不是備份內容/);   // 原因留在 reason，畫面只給下一步
  // ⚠️⚠️ **口徑改了**（r1 審查者抓到，2026-08-06）：舊版對**所有**「狀態 200 但內容不像備份」的情形
  //    都說「可能是登入過期，重新登入」，連 `200 {"error":"權限不足"}` 也一樣。指定口徑是
  //    **只有 401 走登入文案**（那一條是伺服器自己講「你沒登入」）——其餘不猜，猜錯他會反覆登入、
  //    以為是自己的問題。而且本機版根本沒有登入這件事（`authRoutes` 只在 isHosted 掛載）。
  assert.doesNotMatch(result.msg, /登入/,
    '狀態 200 就不是認證問題（沒有人講「你沒登入」）——只有 401 那條路可以叫他重新登入');
  assert.match(result.msg, /重新整理|再試/,
    '不猜原因也要給下一步（William 2026-08-08 定案的字：「伺服器回的不是備份檔，請重新整理再試」）');
});

test('匯出｜狀態 ok、是 JSON，但是錯誤信封（沒有任何集合）⇒ 不可落檔', async () => {
  const { out, saved, result } = await run(res({ body: JSON.stringify({ error: '權限不足' }), headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.match(out.reason, /權限不足/);   // 同上
  // ⚠️ 這一格是 r1 補的：這一條就是審查者點名的例子——「權限不足」跟登入沒關係，卻被舊版
  //    一句「可能是登入過期，重新登入」推去錯的方向。
  assert.doesNotMatch(result.msg, /登入/, '伺服器講的是權限不足，不是沒登入——不可以叫他去登入');
});

test('匯出｜200 ＋ 錯誤信封 `{"errors":[…]}`（JWT 過期那一型）⇒ 不可落檔、要出聲', async () => {
  // ⚠️⚠️ 這是 r1 的 High：舊版關卡③只要求「頂層有任一陣列」，而 `errors` 自己就是陣列——
  //    於是這一包會**落檔**並顯示「已存下備份：共 1 筆紀錄」，使用者以為自己有備份了，
  //    硬碟上那個 .json 其實寫著「JWT expired」。各家閘道（Supabase／GraphQL 風格中間層）
  //    很常這樣回，而且它回的是 200，關卡①攔不到。
  //    修法**不需要**列舉集合：①帶 error／errors 鍵的一律不收 ②頂層必須有 settings 物件。
  const { out, saved, toasts, result } = await run(res({
    body: JSON.stringify({ errors: [{ message: 'JWT expired' }] }), headers: GOOD_HEADERS }));
  assert.equal(out.ok, false);
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0, '一個檔都不可以落下去——落了就是「他以為自己有備份」');
  assert.equal(toasts.length, 2);   // 「匯出中…」＋結果
  assert.equal(result.isErr, true);
  assert.match(out.reason, /JWT expired/, '閘道講的原因要留在 reason（他來問我時就靠這行字）');
  assert.match(result.msg, /匯出失敗/, '必須明講失敗');
  assert.doesNotMatch(result.msg, /筆紀錄/, '不可以順口報一個筆數——那正是舊版騙人的那句');
  assert.doesNotMatch(result.msg, /登入/, '狀態 200 不走登入文案（只有 401 走）');
});

test('匯出｜200 ＋ 表面完好但自帶 `errors` 的「部分成功」⇒ 不可落檔（只有錯誤信封那條擋得住）', async () => {
  // ⚠️ 這一題釘的是**兩條防線裡的第①條**：這一包有頂層 `settings`、有頂層陣列，形狀完全合格——
  //    只有「自帶 error／errors 鍵就不是備份」這條擋得住它。GraphQL 風格的中間層真的會這樣回
  //    （部分資料 ＋ 一則錯誤），而**部分成功比整包失敗更毒**：檔案看起來完好，還原回去卻少東西。
  const { out, saved, result } = await run(res({
    body: JSON.stringify({ settings: { currency: 'TWD' }, transactions: [{ id: 't1' }],
      errors: [{ message: '資料只回了一半' }] }), headers: GOOD_HEADERS }));
  assert.equal(saved.length, 0, '自己宣告有錯的東西不可以被當成完整備份存下來');
  assert.equal(result.isErr, true);
  assert.match(out.reason, /資料只回了一半/);   // 同上
  assert.match(result.msg, /匯出失敗/);
});

test('匯出｜200 ＋ 有陣列但沒有頂層 settings（別的東西回的一包 JSON）⇒ 不可落檔', async () => {
  // ⚠️ 這一題釘的是**兩條防線裡的第②條**：沒有 error 鍵、有頂層陣列，只差「不是這個 app 的備份」。
  //    判準不是抄一份集合名單，而是後端契約的另一端：`lib/schema.js` 的 `sanitizeDbForWrite`
  //    開頭就是「缺 settings 直接丟錯」——所以沒有頂層 settings 的東西，本來就還原不回去。
  //    實測 `emptyDb()` 與 `stripSecretsForBackup(emptyDb())`（HOSTED 匯出走的那條）都有頂層 settings。
  const { out, saved, result } = await run(res({
    body: JSON.stringify({ items: [{ id: 1 }, { id: 2 }], page: 1 }), headers: GOOD_HEADERS }));
  assert.equal(saved.length, 0, '還原不回去的東西不可以被叫做備份');
  assert.equal(result.isErr, true);
  assert.match(out.reason, /不是一份備份檔/, 'reason 要講「格式不對」，不可以講成「裡面沒有資料」');
  assert.equal(result.msg, notBackupMsg(),
    '走的是「不像備份」那條路（畫面只給下一步：請重新整理後再試——William 2026-08-08 第二輪縮短；'
    + '「是哪一種失敗」留在 reason，畫面上不再講）');
  assert.doesNotMatch(result.msg, /筆紀錄/, '不可以報筆數（它有 2 個元素，但那不是備份）');
});

test('匯出｜連不上伺服器（fetch reject）⇒ 出聲、不落檔、不炸掉頁面', async () => {
  // ⚠️ 這條在本機版是**最常見**的一條：後端沒開著（或改完程式忘了重啟）。
  const { out, saved, result } = await run(res({}), { fetchThrows: '連線中斷' });
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(result.isErr, true);
  assert.match(out.reason, /連線中斷/);   // 同上
  // ⚠️ 這一格是補洞補上的：原本只有 401 那兩題釘「沒有存下」，而它們走的是 notBackupMsg——
  //    實測把 failMsg 的「沒有存下任何檔案」刪掉，整份考題照樣全綠（＝這條路沒人守）。
  assert.match(result.msg, /匯出失敗/, '連不上也要明講失敗，否則他不知道要不要重做一次');
  assert.match(result.msg, /網路/, '這一條的下一步是「檢查網路連線」（William 2026-08-08 定案的字）');
  // ⚠️ 這一格是補洞補上的：這條路的 `err.message` 在真瀏覽器裡是「Failed to fetch」，對他毫無意義，
  //    而這**正是本機版最常見的失敗**（後端沒開／改完程式忘了重啟）。原因看不懂又沒有下一步＝等於沒說。
  assert.match(result.msg, /後端|網路/,
    '連不上要給下一步：本機版八成是後端沒在跑（「連線中斷」四個字他看不出要去做什麼）');
});

test('匯出｜讀回應途中斷線（text() 丟錯）⇒ 出聲、不落檔', async () => {
  const { out, saved, result } = await run(res({ textThrows: true, headers: GOOD_HEADERS }));
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(result.isErr, true);
  assert.match(result.msg, /匯出失敗/, '半路斷線最需要明講失敗——「存了一半」是這裡最傷人的誤解');
  assert.match(result.msg, /後端|網路/, '這也是網路層斷掉，下一步跟「連不上」同一種');
});

test('匯出｜三關全過、但落檔那一步自己丟錯 ⇒ 一定要改口出聲，絕不可以說「已存下」', async () => {
  // ⚠️ 這一題是補洞補上的：原本 `saveFile` 丟錯會讓整個 `runExport` reject，**一句話都不會出現**
  //    ——靜靜失敗發生在最後一步，正是這一支存在的理由。而且畫面上若先說了「已存下備份」、
  //    硬碟上卻一個檔都沒有，那比舊版更糟（舊版至少沒騙他）。
  const { out, saved, toasts, result } = await run(res({ body: GOOD_BODY, headers: GOOD_HEADERS }), { saveThrows: '磁碟空間不足' });
  assert.equal(out.ok, false);
  assert.equal(out.saved, false);
  assert.equal(saved.length, 0);
  assert.equal(toasts.length, 2, '只能有「匯出中…」＋一句結果：不可以先報成功再報失敗（他會不知道要相信哪一句）');
  assert.equal(result.isErr, true, '落檔失敗就是失敗，要用錯誤的樣子出聲');
  // ⚠️ 這一格改成拿**成功那句話本身**來比（2026-08-06）：原本只釘字面「已存下」，而成功文案已經改口
  //    兩次（「已開始下載…」→「已經把備份交給瀏覽器下載…」）——只釘舊字面的話，這條路重新吐出
  //    成功句也不會紅（假綠）。下面那條字面黑名單是第二層，跟著現行文案走。
  assert.notEqual(result.msg, okMsg(4, 'finance-backup-2026-08.json'),
    '不可以吐出成功那句話（不管那句話怎麼寫）：畫面報好消息、實際一個檔都沒有');
  assert.doesNotMatch(result.msg, /已存下|交給瀏覽器|筆紀錄/,
    '這是最傷人的一種騙：畫面說「檔案下載了」，硬碟上一個檔都沒有');
  assert.match(out.reason, /磁碟空間不足/, '原因要留在 reason，他來問我時看得到是硬碟滿了不是程式壞了');
});

test('判準｜「長得像備份」認的是性質（頂層 settings ＋ 有陣列 ＋ 沒有錯誤鍵），不是寫死的集合名單', () => {
  // ⚠️ 刻意**不列舉**集合名稱：前端不能 import lib/schema.js 的 ALL_COLLECTIONS，
  //    抄一份過來就是第二份會漂的複本（本專案為這個病型付過很多代價）。
  assert.equal(summarizeBackup({ settings: {}, whateverNewCollection: [{ a: 1 }] }).ok, true,
    '將來新增的集合不必回來改這裡——判準是「有頂層陣列」而不是「叫什麼名字」');
  assert.equal(summarizeBackup({ settings: {}, transactions: [] }).ok, true, '空集合是合法備份（新使用者）');
  assert.equal(summarizeBackup({ error: '請先登入' }).ok, false, '錯誤信封沒有任何集合 ⇒ 不是備份');
  assert.equal(summarizeBackup({}).ok, false);
  // ── r1 的 High：狀態 200 的錯誤信封（原本只要求「有頂層陣列」，`errors` 自己就是陣列 ⇒ 過關落檔）──
  //    兩條防線都不必列舉集合：①自帶 error／errors 鍵 ②頂層必須有 settings 物件。
  assert.equal(summarizeBackup({ errors: [{ message: 'JWT expired' }] }).ok, false,
    '`{"errors":[…]}` 有頂層陣列，但它是錯誤信封、不是備份（舊版會落檔並報「1 筆紀錄」）');
  assert.match(summarizeBackup({ errors: [{ message: 'JWT expired' }] }).reason, /JWT expired/,
    '閘道講的原因要撈出來給使用者看');
  assert.match(summarizeBackup({ errors: ['請先登入'] }).reason, /請先登入/, '字串陣列的形狀也要撈');
  assert.equal(summarizeBackup({ settings: {}, transactions: [{ id: 't1' }], errors: [{ message: '一半' }] }).ok, false,
    '形狀再完好，只要自己宣告有錯就不可以當成完整備份（部分成功比整包失敗更毒）');
  // ⚠️ 這兩格改過（突變 M4 抓到我自己寫了一格**證不倒的斷言**）：原本寫 `{errors:[]}` 並允許原因
  //    落在「不是一份備份檔」上——那句話是**下一關**（缺 settings）給的，所以把撈不出人話時的出聲
  //    整段刪掉，考題照樣全綠。改成「形狀完好、只差自帶一個空的 errors 欄位」：這時只有錯誤信封
  //    那條防線在，證得倒。
  assert.equal(summarizeBackup({ settings: {}, transactions: [{ id: 't1' }], errors: [] }).ok, false,
    '自帶 errors 欄位就不收（判準是鍵名，不是內容）——撈不出人話也一樣不收');
  assert.match(summarizeBackup({ settings: {}, transactions: [{ id: 't1' }], errors: [] }).reason, /錯誤/,
    '講不出原因也要說「這是一則錯誤訊息」，不可以回空原因（畫面會變成「匯出失敗，沒有存下任何檔案：」後面沒字）');
  assert.equal(summarizeBackup({ transactions: [{ id: 't1' }] }).ok, false,
    '沒有頂層 settings 就還原不回去（lib/schema.js 的 sanitizeDbForWrite 缺 settings 直接丟錯）');
  assert.match(summarizeBackup({ transactions: [{ id: 't1' }] }).reason, /不是一份備份檔/,
    '這是「格式不對」，不是「裡面沒有資料」——兩者的下一步不同');
  assert.equal(summarizeBackup({ settings: [], transactions: [{ id: 't1' }] }).ok, false,
    'settings 必須是物件：陣列或字串都不是這個 app 的備份骨架');
  assert.equal(summarizeBackup({ data: { settings: {}, transactions: [{ id: 't1' }] } }).ok, false,
    '包一層的格式判定為「不像備份」＝拒絕落檔（誠實劃界 3：改格式的人要一起改這裡）');
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
  // ⚠️⚠️ **這一題是提醒、不是保證**（r1 之後關門，2026-08-06）：審查者一輪就找到四條文字形狀的繞法，
  //    這一輪修掉三條（只刪 `a.click()`／`toast: () => toast`／另外用 `location.assign('/api/export')`
  //    再抓一次），**還剩一條明知擋不住**：把 `runExport(...)` 藏進 handler 裡一個沒人呼叫的閉包
  //    （`const dead = () => runExport({...})`）——文字樣樣齊全、實際一次也沒跑。
  //    列舉繞法補不完（本專案認過的病型），所以講明白：真正保證「按下去會說話」的是上面那一族
  //    行為題（它們跑真的 `runExport`）；這一題只保證「下一個人順手改壞時會有人喊一聲」。
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
  //    ⚠️ `location.assign`／`location.href =`／`window.open` 是 r1 審查者實測的第四條繞法：
  //       handler 照樣呼叫 runExport（三道關卡都跑、也出聲），**另外**再讓瀏覽器自己去抓一次
  //       `/api/export` ⇒ 使用者同時得到「一個沒驗過的檔」與「一個提示」，比舊版更糟。
  for (const [banned, what] of [[/\bfetch\s*\(/, 'fetch'], [/createObjectURL/, 'createObjectURL'],
    [/\bnew\s+Blob\b/, 'new Blob'], [/\.download\s*=/, '設定 a.download'],
    [/location\s*\.\s*(?:assign|replace|href)/, '用 location 直接跳 /api/export'],
    [/window\s*\.\s*open\s*\(/, 'window.open']]) {
    assert.doesNotMatch(outside, /** @type {RegExp} */ (banned),
      `handler 自己不可以做 ${what}——要下載請走注入給 runExport 的 saveFile，`
      + '在 handler 裡自己抄一套等於三道關卡形同不存在（審查者實測過這條繞法）');
  }

  // ── ③注入的相依必須是真的東西，不是啞巴 ────────────────────────────────────────
  //    這是本支存在的唯一理由（說了已存下就是真的存下），卻是最容易被「換成啞巴」悄悄拆掉的地方。
  const fetchProp = sliceProp(args, 'fetchFn');
  // ⚠️ `fetch.bind(globalThis)` 也算（r2 審查者實測到的**假紅**）：它跟 `(url) => fetch(url)` 語意等價、
  //    甚至更通用（連第二個 init 參數一起轉發），只是字面上沒有 `fetch(`。這與同一輪已經放寬過的
  //    `dispatchEvent`／`addEventListener` 是同一類漏放寬——等價改寫不可以讓考題紅。
  assert.match(fetchProp, /\bfetch\s*\(|fetch\s*\.\s*bind/,
    'fetchFn 必須是真的 fetch（直接呼叫或 fetch.bind(...) 都算）——餵它假回應等於整支模組在驗一份不存在的備份');

  const toastProp = sliceProp(args, 'toast');
  assert.notEqual(toastProp, '', 'runExport 必須拿到 toast，否則成功失敗都不出聲');
  const toastVal = toastProp.replace(/^toast\s*:?/, '').trim();
  // ⚠️ 收緊過（r1 審查者實測，2026-08-06）：舊版只問「這一段裡有沒有出現 toast 這個字」，於是
  //    `toast: () => toast` 就過關了——它把 toast 當回傳值、**一次也沒呼叫**，使用者依舊聽不到一聲。
  //    所以改成問「是不是原封傳進去（`toast,`／`toast: toast`）或**真的呼叫**了 toast(…)」。
  assert.ok(toastVal === '' || toastVal === 'toast' || /\btoast\s*\(/.test(toastVal),
    '傳進去的必須是**真的那個 toast**（簡寫 `toast,`、`toast: toast`、或包一層但真的呼叫 `toast(...)`）——'
    + '實測 `toast: () => {}` 與 `toast: () => toast` 三道關卡照樣跑、全樹照樣全綠，但使用者按下匯出後'
    + '成功失敗都聽不到一聲＝這一支要修的病灶原封不動回來');

  const saveProp = sliceProp(args, 'saveFile');
  assert.notEqual(saveProp, '', 'runExport 必須拿到 saveFile');
  assert.match(saveProp, /createObjectURL|showSaveFilePicker|msSaveBlob|data:application\/json/,
    'saveFile 必須真的把檔案交給瀏覽器下載（Blob 網址／檔案系統 API／data: 網址都算）——'
    + '實測改成 `saveFile: () => {}` 也全綠，而畫面會說「已經把備份交給瀏覽器下載：…3,214 筆紀錄」'
    + '而下載根本沒發生，'
    + '那比舊版更糟（舊版至少沒騙他）');
  // ⚠️ 這一格原本把「有設定 `.download`」也當成「觸發了下載」＝誤判（r1 審查者實測：只刪掉
  //    `a.click()` 這一行，這一題照樣全綠，而按下匯出什麼都不會下載）。設定屬性不是動作，
  //    所以現在只認**真的會動作的東西**：`click()`／`write`／`showSaveFilePicker`／`msSaveBlob`。
  //    ⚠️ `dispatchEvent` 也算（`a.dispatchEvent(new MouseEvent('click'))` 是等價寫法，
  //       不列進來會讓那種改寫假紅）。
  assert.match(saveProp, /\bclick\s*\(|dispatchEvent|\bwrite\b|showSaveFilePicker|msSaveBlob/,
    'saveFile 光把網址與檔名準備好不算下載（設定 a.download 只是屬性），要真的觸發下載／寫檔');
});

test('文案｜「資料備份」卡的說明不可以宣稱「整包／全部／完整」——雲端版匯出刻意剝掉機密欄位', () => {
  // ⚠️ 為什麼有這一題（r2 審查者抓到）：這張卡的說明改過兩次，兩次都**在雲端版是假的**。
  //    第一版說「所有資料只存在本機 `data/store.db`」——錯在「資料放哪」（雲端資料在 Supabase）。
  //    第二版改成中性版，卻寫「把你的資料**整包**匯出成一個檔案」——錯在「檔案裡有什麼」：
  //    HOSTED 的 `/api/export` 走 `stripSecretsForBackup(db)`（`lib/routes/core.js` 的 export 路由
  //    ＋ `lib/secret-fields.js`），**刻意**剝掉 IB flexToken／信用卡帳單 PDF 密碼／證券對帳單密碼／
  //    完整帳號（C5 裁決⑤）。使用者讀到「整包」會以為「我有備份」，而那幾樣還原之後全都不在。
  // ⚠️ 誠實劃界：這是**字面黑名單**，守的是「下一個人（或我自己）把那個詞寫回去」，
  //    **不是**「這句話在兩種模式都成立」——語意沒有辦法用考題證明（settings.js 的 DOM 路徑在
  //    node 裡跑不起來）。列舉補不完的東西不假裝是保證。
  // ✅ 那句「雲端版匯出不含 IB 憑證與帳單密碼」**已經實作**（William 2026-08-08 裁決「要講準」）：
  //    匯出前的告知窗依模式分流，見 EXPORT_NOTICE_HOSTED／EXPORT_NOTICE_LOCAL 與
  //    docs/contracts/cloud-security.md「匯出前告知的模式分流」節。這裡不再是欠帳。
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8'));
  const at = src.indexOf('BACKUP_CARD_NOTE');
  assert.ok(at >= 0, '找不到 BACKUP_CARD_NOTE（改名了？那要一起更新本考題）');
  const note = src.slice(at, src.indexOf(';', at));
  for (const banned of ['整包', '全部', '所有資料', '完整', '一字不漏']) {
    assert.ok(!note.includes(banned),
      `備份卡的說明不可以出現「${banned}」——雲端版的備份檔刻意不含 IB 憑證／帳單密碼／完整帳號，`
      + '宣稱內容完整會讓他以為「我有備份」，那幾樣其實還原不回來');
  }
  // 卡片必須真的用這個常數渲染——否則把那句話直接寫回樣板裡就繞過上面的黑名單了。
  const cardAt = src.indexOf('資料備份');
  assert.ok(cardAt >= 0, '找不到「資料備份」那張卡（改字了？那要一起更新本考題）');
  assert.ok(src.slice(cardAt, cardAt + 400).includes('${BACKUP_CARD_NOTE}'),
    '「資料備份」卡的說明必須用 BACKUP_CARD_NOTE 這個常數（樣板裡自己寫一句就繞過黑名單了）');
});

// ─────────────────────────────────────────────────────────────────────────────
// #417 r4：William 2026-08-08 的兩件事（文案縮短／匯出前先跳窗）＋審查者 r3 阻擋（卡住要出聲）
// ─────────────────────────────────────────────────────────────────────────────

test('⭐ 匯出｜按下去**立刻**出聲「匯出中…」，不必等伺服器（r3 阻擋：卡住時畫面一句話都沒有）', async () => {
  // ⚠️ 這一題盯的是**順序**，不是有沒有那句話：舊版是「等到有結果才說第一句」，
  //    所以伺服器不回話時使用者面對的是完全靜止的畫面（他會以為鈕壞了、反覆按）。
  /** @type {{msg:string, isErr:boolean}[]} */
  const toasts = [];
  let resolveFetch = /** @type {(v:any)=>void} */ (() => {});
  const pending = new Promise((r) => { resolveFetch = r; });
  const p = runExport({
    fetchFn: () => pending,
    saveFile: () => {},
    toast: (msg, isErr = false) => toasts.push({ msg, isErr }),
    withTimeout: (work) => work,          // 這一題不驗上限，只驗「先出聲」
  });
  await Promise.resolve();                 // 讓 runExport 跑到 fetch 之前那一句
  assert.equal(toasts.length, 1, '按下去就要有一句（伺服器還沒回話時畫面不可以是靜止的）');
  assert.equal(toasts[0].msg, BUSY_MSG);
  assert.equal(toasts[0].isErr, false, '「匯出中…」不是錯誤');
  resolveFetch(res({ body: GOOD_BODY, headers: GOOD_HEADERS }));
  await p;
});

test('⭐ 匯出｜伺服器一直不回話 ⇒ 等超過上限就放棄、出聲、不落檔（r3 阻擋的第一條路）', async () => {
  /** @type {{msg:string, isErr:boolean}[]} */
  const toasts = [];
  const saved = /** @type {any[]} */ ([]);
  const out = await runExport({
    fetchFn: () => new Promise(() => {}),           // 永遠不 settle
    saveFile: (f, b) => saved.push({ f, b }),
    toast: (msg, isErr = false) => toasts.push({ msg, isErr }),
    // 立刻判定超時（考題不必真的等 30 秒）——形狀與正式那顆一致
    withTimeout: () => Promise.reject(Object.assign(new Error('等超過上限'), { name: 'ExportTimeout' })),
  });
  assert.equal(out.ok, false);
  assert.equal(saved.length, 0, '沒拿到資料就不可以落檔');
  assert.equal(toasts.length, 2, '「匯出中…」＋一句超時');
  assert.equal(toasts[toasts.length - 1].msg, timeoutFailMsg());
  assert.notEqual(toasts[toasts.length - 1].msg, networkFailMsg(),
    '超時**不可以**講成網路斷線（那兩件事的下一步不同：一個等、一個去看網路）');
  assert.match(out.reason, /上限|沒有回應/,
    '畫面那句與「伺服器出錯」逐字相同（William 第二輪縮短的決定），所以「這是超時」只靠 reason 分辨');
  assert.equal(toasts[toasts.length - 1].isErr, true);
});

test('⭐ 匯出｜讀回應讀到卡住 ⇒ 同樣放棄並出聲（r3 阻擋的第二條路）', async () => {
  /** @type {{msg:string, isErr:boolean}[]} */
  const toasts = [];
  const saved = /** @type {any[]} */ ([]);
  let call = 0;
  const out = await runExport({
    fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: () => new Promise(() => {}) }),
    saveFile: (f, b) => saved.push({ f, b }),
    toast: (msg, isErr = false) => toasts.push({ msg, isErr }),
    // 第一次（fetch）照過，第二次（text）判超時——證明**兩條路都有上限**
    withTimeout: (work) => (++call === 1 ? work
      : Promise.reject(Object.assign(new Error('等超過上限'), { name: 'ExportTimeout' }))),
  });
  assert.equal(out.ok, false);
  assert.equal(saved.length, 0);
  assert.equal(toasts[toasts.length - 1].msg, timeoutFailMsg());
  assert.equal(call, 2, '兩處都要走過 withTimeout（少包一處就是留一條卡住的路）');
});

test('⭐ 匯出｜等待上限的預設實作：工作先完成就照常回值、逾時才丟 ExportTimeout', async () => {
  assert.equal(await defaultWithTimeout(Promise.resolve('ok'), 50), 'ok');
  await assert.rejects(defaultWithTimeout(new Promise(() => {}), 5), (/** @type {any} */ e) => e.name === 'ExportTimeout');
  // 原本的錯誤要原樣傳出去（不可以被包成超時，那會給錯的下一步）
  await assert.rejects(defaultWithTimeout(Promise.reject(new Error('連線中斷')), 50), /連線中斷/);
  assert.ok(EXPORT_TIMEOUT_MS >= 10_000, '上限太短會讓大備份或慢網路誤判成「沒有回應」');
});

test('⭐ 文案｜六句都收成「一行、只給下一步」（William 2026-08-08：太長），而且口徑沒被改壞', () => {
  // 🧑‍⚖️ 他逐字定案三句：成功／401／連線；其餘三句照同一句型縮短。
  assert.match(okMsg(4, 'x.json'), /^匯出成功 - 請至下載確認檔案/, '成功那句的開頭是他定的字');
  assert.equal(authFailMsg(), '匯出失敗 - 請重新登入再按匯出');
  assert.equal(networkFailMsg(), '匯出失敗 - 請檢查網路連線');
  // ⚠️ 縮短不可以動到口徑（那是保證，不是文案）：
  assert.doesNotMatch(okMsg(4, 'x.json'), /已存下|已存好|已完成|下載完成/,
    '成功仍**不可以**宣稱「已存好」——落檔結果瀏覽器不回音（這一條是保證，縮短也不能鬆）');
  assert.match(okMsg(4, 'x.json'), /下載|確認/, '仍要叫他去下載夾確認');
  for (const [name, msg] of [['serverFailMsg', serverFailMsg()], ['notBackupMsg', notBackupMsg()],
    ['saveFailMsg', saveFailMsg()], ['timeoutFailMsg', timeoutFailMsg()]]) {
    assert.match(msg, /^匯出失敗 - /, `${name} 要照同一個句型`);
    assert.doesNotMatch(msg, /登入/, `${name} 不可以叫他重新登入——只有 401 那條路可以`);
    assert.ok(msg.length <= 20, `${name} 一行為限（實際 ${msg.length} 字）：長訊息就是被裁掉的那個病`);
  }
  // 🧑‍⚖️ **兩句逐字相同是刻意的**（William 2026-08-08 第二輪縮短）：「伺服器出錯」與「伺服器不回話」
  //    對使用者的下一步一樣（等一下再試），畫面不必分；差別留在 reason。
  //    這一條釘住它，免得下一個人看到重複就「順手分化」——那會多出一句他不需要的字。
  assert.equal(serverFailMsg(), timeoutFailMsg(),
    '這兩句刻意相同（見 backup-export.js serverFailMsg 上方的裁決註解）；真要分化先問 William');
});

test('⭐ 匯出前告知｜兩句逐字釘住＋**問不到模式時往「含機密」猜**（r4 阻擋①：講反方向會害他外洩）', () => {
  assert.equal(EXPORT_NOTICE_HOSTED, '匯出檔案不含 IB 憑證與帳單密碼，之後使用備份還原需要重新輸入。',
    '雲端版那句是 William 逐字定的');
  assert.match(EXPORT_NOTICE_LOCAL, /含 IB 憑證與帳單密碼/, '本機版要講「含」——LOCAL 匯出刻意完整含機密');
  assert.match(EXPORT_NOTICE_LOCAL, /機密/, '本機版要叫他當機密保管（他可能會想轉寄給我）');
  // ⚠️ 這是本題的靈魂：**猜錯的方向必須是安全的那一邊**。
  //    r4 前的版本兩種模式都講「不含機密」——本機版使用者會以為檔案不敏感而隨手轉寄，
  //    而那個檔案裡有他的 IB 憑證與帳單密碼。「講錯方向」比「不講」更糟。
  assert.equal(exportNotice(null), EXPORT_NOTICE_LOCAL, '問不到模式 ⇒ 講「含機密」（往安全的方向錯）');
  assert.equal(exportNotice(undefined), EXPORT_NOTICE_LOCAL, '同上');
  assert.equal(exportNotice({}), EXPORT_NOTICE_LOCAL, '回應沒有 hosted 欄位 ⇒ 同樣保守');
  assert.equal(exportNotice({ hosted: 'true' }), EXPORT_NOTICE_LOCAL, '字串 "true" 不算 true（型別鬆掉就會講反）');
  assert.equal(exportNotice({ hosted: false }), EXPORT_NOTICE_LOCAL, 'LOCAL 明確回 false ⇒ 含機密那句');
  assert.equal(exportNotice({ hosted: true }), EXPORT_NOTICE_HOSTED, '只有明確 true 才講「不含」');
  // ⚠️ **先去註解**（r5 阻擋②）：把接線改成註解就等於沒接，掃原始字面會給假綠。
  const src = stripJsComments(readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8'));
  // 接線三件事：用共用文案（不自己抄一句）、先問再匯出、取消就什麼都不做
  assert.match(src, /exportNotice\(/, '設定頁要用共用的挑選函式（各寫一句的話 William 審改只會改到一邊、而且模式判斷會走散）');
  // ⚠️ 引號形式不綁死（r6 阻擋①：只換等價引號就誤紅＝合法寫法被誤殺）
  assert.match(src, /api\(\s*['"`]\/mode['"`]\s*\)/, '要真的去問模式（不問就只能猜，而猜錯方向會害他外洩）');
  // ⚠️ 引號無關（r7 阻擋①）：上一版用字面 indexOf("byId('exportBtn')…")，只要換成雙引號就切不到、
  //    整題誤紅——而那是行為完全相同的等價寫法。
  const btnAt = src.match(/byId\(\s*['"`]exportBtn['"`]\s*\)\s*\.onclick/);
  assert.ok(btnAt && btnAt.index !== undefined, '找不到匯出鈕的接線＝本題空轉');
  const at = /** @type {number} */ (btnAt.index);
  const handler = src.slice(at, at + 900);
  assert.match(handler, /confirmExport\(\)/, '按下去要先問過（跳窗），不可以直接開始匯出');
  assert.ok(handler.indexOf('confirmExport()') < handler.indexOf('runExport'),
    '順序不可對調：要先問、再匯出（反過來就是「先做了才問」）');
  assert.match(handler, /if \(!await confirmExport\(\)\) return;/,
    '取消就要**什麼都不做**（不打 API、不落檔）');
  assert.match(src, /確認匯出/, '確認鈕的字是他指定的「確認匯出」');
  // ⚠️ **三條退出路都要接到同一個 cancel**（r4 阻擋③的另一半）：真 DOM 那題證明「這種接法會 settle」，
  //    但沒有人保證 settings.js 真的用了那種接法——M9 突變（拿掉 bindBackdropClose 那一行）
  //    在補這條之前**全綠**，正是「掃得到寫法 ≠ 行為正確」的反面：這裡連寫法都沒掃。
  const cf = src.slice(src.indexOf('const confirmExport'), at);
  assert.ok(cf.length > 200, '找不到 confirmExport 的本體＝本題空轉');
  assert.match(cf, /backdrop:\s*false/,
    'openModalShell 內建的點背景關窗只呼叫 close、**不會**收掉那顆 Promise ⇒ 必須關掉它、自己接');
  // ⚠️ **三條退出路各自的那一句裡要出現取消的處理**——判準刻意寬（r6 阻擋①）：
  //    `= cancel`、`= () => cancel()`、包一層別名都算；換引號、換空白、包裝轉交都不該誤紅。
  //    這一題只證明「三條路都有接到取消」；**行為（真的 settle）由上面那題真 DOM 守**。
  // ⚠️ 片段抓到「**下一個分號**」、而且允許跨行（r7 阻擋①）：這個判準演化過三次，每次都是被
  //    等價寫法誤殺才發現——①`[^)]*` 遇到 `() =>` 的第一個 `)` 就停②`[^;\n]*` 把換行誤當敘述結束
  //    （合法的多行寫法因此誤紅）。現在只認語言真正的敘述結尾。
  for (const [what, re] of [
    ['點背景', /bindBackdropClose\([\s\S]*?;/],
    ['×', /['"`]\.x-close['"`]\s*\)[\s\S]*?;/],
    ['取消鈕', /\[data-cancel\][\s\S]*?;/],
  ]) {
    const m = cf.match(/** @type {RegExp} */ (re));
    assert.ok(m, `找不到「${what}」那條退出路的接線＝本題對它空轉`);
    assert.match(m[0], /cancel/i,
      `「${what}」那一句沒有接到取消——窗關了但呼叫端會永遠在等（每走一次漏一顆 Promise）`);
  }
});

test('⭐ 匯出｜**非 2xx** 的錯誤 body 讀到卡住也不可以沒聲音（r4 阻擋②：第三條 pending 路徑）', async () => {
  /** @type {{msg:string, isErr:boolean}[]} */
  const toasts = [];
  const saved = /** @type {any[]} */ ([]);
  let call = 0;
  const out = await runExport({
    fetchFn: async () => ({ ok: false, status: 500, statusText: 'Internal Server Error',
      headers: { get: () => null }, text: () => new Promise(() => {}) }),   // 錯誤 body 永不 settle
    saveFile: (f, b) => saved.push({ f, b }),
    toast: (msg, isErr = false) => toasts.push({ msg, isErr }),
    // 第一次（fetch）照過，第二次（讀錯誤 body）才超時——探針要精準打在那一處
    withTimeout: (work) => (++call === 1 ? work
      : Promise.reject(Object.assign(new Error('等超過上限'), { name: 'ExportTimeout' }))),
  });
  assert.equal(out.ok, false);
  assert.equal(saved.length, 0);
  assert.equal(call, 2, '錯誤 body 那次讀取也要包上限（少包這一處就留一條卡住的路）');
  assert.equal(toasts.length, 2, '「匯出中…」＋一句結果——不可以卡在「匯出中…」不動');
  assert.equal(toasts[toasts.length - 1].msg, serverFailMsg(),
    '讀不到原話就用狀態碼給下一步（500 ⇒ 請稍後再試），不是把畫面留在原地');
  assert.match(out.reason, /500/, '狀態碼仍要留在 reason');
});

// ─────────────────────────────────────────────────────────────────────────────
// r4 阻擋③：三條退出路都要「真的取消」——用**真 DOM**（jsdom）驗，不是掃原始碼
//
// ⚠️ 為什麼一定要真 DOM：上一版這件事只有「掃 settings.js 有沒有寫 confirmExport()」的字串題，
//    而複驗者實測發現**點背景**那條路窗關了、API 0 次、落檔 0 次，但呼叫端的 Promise 永遠不 settle
//    ——每點一次背景就漏一顆懸空 Promise，而字串題全綠。這正是本專案「靜靜通過最危險」的形狀：
//    掃得到寫法 ≠ 行為正確。
// ⚠️ 這裡重建的是**確認窗那一段邏輯的骨架**（openModalShell 的三顆退出路＋bindBackdropClose 的
//    mousedown/mouseup/click 三段判斷），不是 settings.js 原檔——settings.js 整支在 node 裡跑不起來
//    （它 import 了十幾支頁面模組）。誠實劃界：本題證明「這個接法會 settle」，
//    而「settings.js 真的用這個接法」由上面那條原始碼題（confirmExport()／bindBackdropClose）守。
test('⭐ 確認窗｜取消鈕／×／**點背景** 三條路都要真的收掉那顆 Promise（r4 阻擋③，真 DOM）', async () => {
  const { JSDOM } = await import('jsdom');
  for (const exitPath of ['取消鈕', '×', '點背景']) {
    const dom = new JSDOM('<!doctype html><body><div id="modal-root"></div></body>');
    const doc = dom.window.document;
    const root = doc.getElementById('modal-root');
    // 與正式那顆窗同構：一顆背景、兩顆鈕、一個關閉叉
    root.innerHTML = `<div class="modal-bg"><div class="modal-sm">
      <div class="modal-head"><h2>匯出備份</h2><button class="x-close">×</button></div>
      <div class="modal-body"><p>${EXPORT_NOTICE_LOCAL}</p>
        <div class="form-actions">
          <button type="button" class="btn-ghost" data-cancel>取消</button>
          <button type="button" class="btn" id="exportConfirmBtn">確認匯出</button>
        </div></div></div></div>`;
    let decided = false;
    /** @type {boolean | 'pending'} */
    let answer = 'pending';
    const p = new Promise((resolve) => {
      const done = (/** @type {boolean} */ ok) => { if (!decided) { decided = true; resolve(ok); } };
      const close = () => { root.innerHTML = ''; };
      const cancel = () => { close(); done(false); };
      root.querySelector('[data-cancel]').onclick = cancel;
      root.querySelector('.x-close').onclick = cancel;
      // bindBackdropClose 的正式邏輯（mousedown 與 mouseup 都要落在背景上才算）
      const bg = root.querySelector('.modal-bg');
      let downOnBg = false, upOnBg = false;
      bg.addEventListener('mousedown', (e) => { downOnBg = e.target === bg; });
      bg.addEventListener('mouseup', (e) => { upOnBg = e.target === bg; });
      bg.addEventListener('click', () => { if (downOnBg && upOnBg) cancel(); });
      root.querySelector('#exportConfirmBtn').onclick = () => { close(); done(true); };
    }).then((v) => { answer = /** @type {any} */ (v); return v; });

    const bg = root.querySelector('.modal-bg');
    const ev = (/** @type {string} */ type, /** @type {any} */ target) =>
      target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true }));
    if (exitPath === '取消鈕') root.querySelector('[data-cancel]').click();
    else if (exitPath === '×') root.querySelector('.x-close').click();
    else { ev('mousedown', bg); ev('mouseup', bg); ev('click', bg); }

    const raced = await Promise.race([p, new Promise((r) => setTimeout(() => r('still-pending'), 50))]);
    assert.notEqual(raced, 'still-pending',
      `走「${exitPath}」這條路之後，那顆 Promise 還沒 settle——呼叫端會永遠等下去（每次都漏一顆）`);
    assert.equal(answer, false, `走「${exitPath}」要回「取消」（回 true 就等於偷偷幫他按了確認）`);
    assert.equal(root.innerHTML, '', `走「${exitPath}」要把窗關掉`);
    dom.window.close();
  }
});

test('⭐ 確認窗｜按〈確認匯出〉才回 true（真 DOM）', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="modal-root"></div></body>');
  const root = dom.window.document.getElementById('modal-root');
  root.innerHTML = '<div class="modal-bg"><div><button id="exportConfirmBtn">確認匯出</button></div></div>';
  const p = new Promise((resolve) => {
    root.querySelector('#exportConfirmBtn').onclick = () => { root.innerHTML = ''; resolve(true); };
  });
  root.querySelector('#exportConfirmBtn').click();
  assert.equal(await p, true);
  dom.window.close();
});
