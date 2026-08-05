// @ts-check
// 匯出備份：**按下去會說話**（William 2026-08-05 裁決另開一支修，不用文案打補丁）。
//
// 為什麼要有這一檔：原本那顆鈕是純 `<a href="/api/export" download>`，瀏覽器直接把回應存成檔案——
// **成功失敗都不出聲**。雲端版若剛好 session 過期，`GET /api/export` 會回錯誤（或被導去登入頁），
// 瀏覽器照樣安安靜靜存下一個內容是錯誤訊息／HTML 的檔案，而使用者以為自己有備份了。
// 而**店名規則**那兩段文案（設定頁的卡片＋規則面板）正是叫人「動手前先到『資料與備份』按『匯出備份』
// 存一份」——那條自保路徑押在這顆鈕上，所以「靜靜失敗」的後果被放大到「他在毫無安全網的狀態下
// 按下不可逆的整批改名」。（那兩段文案來自尚未合併的 #410；同一支把分類管理的指路收成只留
// 「儲存後無法復原」警告，所以這裡不寫「分類管理也叫人按它」——那已經不是事實。）
//
// ⚠️ **判斷一律靠回應本身、不靠模式**：前端根本拿不到「現在是本機還是雲端」——`public/` 底下沒有
//    任何模式旗標（除了這行說明本身，`public/` 全樹沒有出現過 HOSTED／APP_MODE／isHosted 任何一個），
//    所以這裡不分流，也**不可以**為了分流去新增一個旗標——那會多一份會漂的模式真相。
//    三道關卡：①HTTP 狀態 ②內容 parse 得出 JSON ③長得像備份（不是錯誤信封、不是登入頁）。
//
// ⚠️ **不重新序列化**：存下去的是伺服器回的**原始位元組**（`res.text()`），不是 `JSON.stringify(parse(...))`。
//    重新序列化會改變格式，而這個檔案的用途是「原封不動還原」。
//
// ⚠️ 這一檔刻意零 DOM、零 import（相依全部注入）——`public/app.js` 在 node 裡 import 不進來
//    （頂層碰 document／localStorage），純模組才能寫行為級考題。考題：test/backup-export.test.js。
//
// ── 誠實劃界（這一支**擋不住**什麼）─────────────────────────────────────────────
// 1. **右鍵「另存連結」仍會退回舊的靜靜失敗**。那顆 `<a>` 的 `href="/api/export"` 刻意留著
//    （右鍵另存的退路＋別的考題以這個字面定位它），而右鍵走的是瀏覽器自己的下載、根本不進這支模組。
//    這一支保證的是**左鍵按下去會說話**——那是使用者實際會走的那條路；右鍵那條沒有守。
// 2. **不保證備份「內容完整」**。這裡只認「長得像備份」（有頂層陣列）與筆數，不檢查該有哪些集合、
//    欄位對不對、機密該不該剝。那些由伺服器端的考題守（`test/server.test.js` 的 export→import 來回、
//    `test/hosted-secrets.test.js` 的機密投影）。⇒ 本模組全綠**不等於**那個檔還原得回來。
// 3. **判準綁在「集合放在頂層」這個現況上**。若將來 `/api/export` 改成把集合包一層
//    （`{ data: { transactions: [...] } }`），這支會判定「不像備份」而**拒絕落檔**（實測 `ok:false`）——
//    那是誤擋、不是靜靜失敗（使用者會看到出聲），但改格式的人必須一起改這裡。
// 4. 接線那一題讀的是**原始碼文字**，擋不住刻意混淆（把名字拼接起來之類）。它守的是「下一個人順手
//    改壞」，不是防惡意。它切出 `exportBtn` 的 handler 區塊、在**那一段裡面**要求 `runExport`／
//    `preventDefault`／不得自己 `fetch`＋`createObjectURL`，並要求注入的 `toast` 是原封傳進去的、
//    注入的 `saveFile` 真的會落檔——但這一切仍然只是「文字長得對」，不是跑起來對。
// 5. **`toast` 自己丟錯就沒人接得住**。落檔那一步已經包了 try（丟錯會改口說「存檔那一步出錯」），
//    但如果連 `toast` 都丟錯，那條路上沒有第二個出聲的管道可用——不假裝守得住。
// 6. **狀態 200 ＋ 錯誤信封剛好有頂層陣列 ⇒ 三道關卡都攔不住**。例如某些閘道回
//    `200 {"errors":[{"message":"JWT expired"}]}`：關卡①看狀態（200 過）、②parse 得出 JSON（過）、
//    ③有頂層陣列＝「像備份」（過），於是會落檔並說「已存下備份：共 1 筆紀錄」。
//    401 那一型有關卡①擋（`test/backup-export.test.js` 有專題），但**200 那一型沒有**。
//    為什麼不修：要擋它就得列舉「真備份該有哪些集合」，而那就是抄一份 `lib/schema.js` 的
//    `ALL_COLLECTIONS`＝第二份會漂的複本（本專案為這個病型付過很多代價）。這裡選擇誠實劃界：
//    寧可在這個罕見形狀上寬鬆，也不要多一份會漂的真相。⇒ 使用者仍要靠「筆數看起來對不對」自保。

/** 匯不出來時的檔名退路（伺服器沒給 Content-Disposition 時用）。 */
export const FALLBACK_FILENAME = 'finance-backup.json';

/**
 * 從 `Content-Disposition` 取檔名——**單一真相在伺服器**（`lib/routes/core.js` 的
 * `attachment; filename="finance-backup-YYYY-MM.json"`）。前端自己算月份＝第二份會漂的複本。
 * @param {string | null | undefined} header
 * @returns {string} 取不到就回 {@link FALLBACK_FILENAME}
 */
export function filenameFromDisposition(header) {
  const raw = String(header || '');
  // 先認 RFC 5987 的 filename*=UTF-8''…（可能被 URL 編碼），再退回一般的 filename="…"
  const star = raw.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (star) {
    try { return sanitizeFilename(decodeURIComponent(star[1].trim())); } catch { /* 壞編碼＝當沒給 */ }
  }
  const plain = raw.match(/filename\s*=\s*"([^"]+)"/i) || raw.match(/filename\s*=\s*([^;]+)/i);
  if (plain) return sanitizeFilename(plain[1].trim());
  return FALLBACK_FILENAME;
}

/**
 * 檔名消毒：伺服器的標頭理論上可信，但**下載檔名會落到使用者的硬碟**，所以路徑分隔符與上層參照一律剝掉。
 *
 * ⚠️ 先剝殘留的引號：`filename=""` 會被上面那條寬鬆的正則抓成兩個引號字元（不是空字串），
 *    不剝就會落出一個名字叫 `""` 的檔——考題〈檔名從 Content-Disposition 取〉抓到的就是這個。
 * @param {string} name
 */
function sanitizeFilename(name) {
  const base = name.trim().replace(/^"+|"+$/g, '').trim()
    .replace(/[\\/]/g, '_')     // 路徑分隔符：不可讓伺服器決定檔案落在哪個目錄
    .replace(/^\.+/, '')        // 開頭的點：`..` 是上層參照、單一個 `.` 會變隱藏檔
    .trim();
  return base === '' ? FALLBACK_FILENAME : base;
}

/**
 * 「這團東西長得像備份嗎」——**刻意不列舉集合名稱**。
 *
 * ⚠️ 為什麼不列舉：前端不能 import `lib/schema.js` 的 `ALL_COLLECTIONS`，抄一份過來就是第二份會漂的
 *    複本（本專案為這個病型付過很多代價）。所以判準改成**性質**：頂層至少要有一個「值是陣列」的鍵。
 *    錯誤信封 `{ error: '...' }`、登入頁 HTML、純字串、陣列本身，全部過不了這一關。
 * @param {unknown} data 已 parse 的回應
 * @returns {{ ok: boolean, reason: string, total: number }} total＝所有頂層陣列的元素數總和
 */
export function summarizeBackup(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    // ⚠️ 不寫「回應不是一包資料」：「一包資料」是我們自己腦內的說法，他讀不出那是什麼意思。
    return { ok: false, reason: '伺服器回來的東西不是一份備份檔', total: 0 };
  }
  const obj = /** @type {Record<string, unknown>} */ (data);
  let arrays = 0, total = 0;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) { arrays++; total += v.length; }
  }
  if (arrays === 0) {
    // 這一支專門認「錯誤信封」：`{ error: '請先登入' }` 之類，沒有任何一個集合。
    // ⚠️ 用「」包住伺服器的原話、不用第二個冒號：失敗文案本身已經有一個冒號
    //    （「沒有存下任何檔案：伺服器說：…」兩個冒號讀起來會斷句斷錯）。
    const hint = typeof obj.error === 'string' && obj.error.trim() !== '' ? `伺服器說「${obj.error}」` : '裡面沒有任何一筆資料';
    return { ok: false, reason: hint, total: 0 };
  }
  return { ok: true, reason: '', total };
}

/**
 * ⏳ 文案（Claude 起草、**待 William 審改**）：成功。
 *
 * 筆數加千分位：這個數字是他**唯一**用來判斷「這份備份是不是空的」的線索，四位數以上不分節很難讀
 * （`3214` 與 `321` 掃過去差不多）。這一檔零 import，所以用內建的 `toLocaleString`、不借 app.js 的工具。
 *
 * ⚠️ 為什麼寫「筆紀錄（…全部加起來）」而不是「筆資料」：這個數字是**所有頂層陣列的元素數總和**
 *    （實測 17 個集合：帳戶／交易／持股／每日淨值／快照／歷史…），跟他在收支頁看到的筆數差很多
 *    （dailyValues、snapshots、history 通常遠大於交易數）。寫「N 筆資料」他會拿去對收支頁、
 *    然後以為程式算錯了。把「全部加起來」講明白，這個數字才只被當成它真正能當的東西：量級。
 * @param {number} total @param {string} filename
 */
export const okMsg = (total, filename) =>
  `已存下備份：${filename}，共 ${total.toLocaleString('zh-TW')} 筆紀錄（交易、帳戶、快照…全部加起來）`;
/** ⏳ 文案（待審）：失敗——重點是**明講「沒有存下任何檔案」**，否則使用者會以為存了一半。 @param {string} why */
export const failMsg = (why) => `匯出失敗，沒有存下任何檔案：${why}`;
/**
 * ⏳ 文案（待審）：**網路層斷掉**（fetch reject／讀回應途中斷線）——伺服器連話都沒說完。
 *
 * ⚠️ 這是本機版**最常見**的一條（後端沒開、或改完程式忘了重啟），而 `err.message` 給的是
 *    「Failed to fetch」之類的字（各家瀏覽器措辭還不一樣），對他毫無意義。所以下一步必須自己講出來。
 * @param {string} why
 */
export const networkFailMsg = (why) =>
  `${failMsg(why)}（連線斷在半路：本機版先確認後端有沒有在跑、改完程式有沒有重啟；雲端版檢查一下網路。）`;
/**
 * ⏳ 文案（待審）：**401 專用**——這一條是真的登入問題（HOSTED 未登入時 `/api/export` 回 401
 * `{error:'請先登入'}`，見 `lib/routes/auth.js`），所以可以理直氣壯叫他去登入。
 *
 * ⚠️ **403 不走這一條**：本專案唯一會回 403 的地方是 `csrfOriginGuard`，而它 `GET/HEAD/OPTIONS` 直接放行
 *    ——`/api/export` 是 GET，所以我們自己的程式**不可能**因為登入狀態回 403（真回 403 是前面的
 *    代理／CDN 擋掉）。叫他「重新登入」是假的下一步：他會反覆登入、以為是自己的問題。
 * @param {string} why
 */
export const authFailMsg = (why) => `${failMsg(why)}（這是登入的問題：重新登入一次再按匯出。）`;
/**
 * ⏳ 文案（待審）：**伺服器那一端的狀況**（5xx／403／404…都走這條）。
 *
 * ⚠️ 為什麼一定要有下一步：舊稿在 500 只講「伺服器回 500 Internal Server Error」就停住——
 *    他不知道 500 是什麼、也不知道要幹嘛。狀態碼要留（那是他來問我時唯一有用的線索），
 *    但光有線索不叫下一步。「把這句話整句告訴我」永遠成立，不管伺服器有沒有給文字原因。
 * @param {string} why
 */
export const serverFailMsg = (why) =>
  `${failMsg(why)}（這是伺服器那一端的問題，不是你做錯什麼：等一下再試一次，還是不行就把這句話整句告訴我。）`;
/**
 * ⏳ 文案（待審）：回應不像備份（狀態 200 卻拿到登入頁／錯誤信封／怪東西）。
 *
 * ⚠️ 兩種模式的下一步**完全不同**，所以兩邊都講出來：這一條在雲端幾乎都是 session 過期被導去登入頁，
 *    但**本機版根本沒有登入這件事**（`authRoutes` 只在 isHosted 掛載）。舊稿只寫「如果是雲端版，
 *    可能是登入過期了」，William 在本機看到會讀成在怪他沒登入，而他真正該查的是後端——
 *    這條路走到這裡表示後端**有回應**（不然是 fetch reject），所以本機那句講的是「回的東西不對」，
 *    最常見的原因是改完後端忘了重啟。
 * @param {string} why
 */
export const notBackupMsg = (why) =>
  `${failMsg(why)}（雲端版：可能是登入過期了，重新登入再試一次。本機版：檢查後端是不是沒重啟。）`;
/**
 * ⏳ 文案（待審）：**驗都過了、落檔那一步自己丟錯**。
 *
 * ⚠️ 這一條是補洞補上的：原本 `saveFile` 丟錯會讓整個 `runExport` reject，**一句話都不會出現**
 *    ——那正是這一支要消滅的病（靜靜失敗），卻發生在最後一步。
 * ⚠️ 措辭刻意**不敢斷言「沒有存下」**：走到這裡資料已經抓到、落檔動作已經開始
 *    （Blob 建好了、`a.click()` 可能已經送出），檔案到底有沒有落下去我們不知道。
 *    誠實講「可能沒有、去看一下」比替他猜任何一邊都好。
 * @param {string} why
 */
export const saveFailMsg = (why) =>
  `匯出失敗，存檔那一步出錯：${why}（下載夾裡可能沒有那個檔，去看一下，然後再按一次匯出。）`;

/**
 * 匯出流程本體。**先驗再存**：三道關卡都過了才真的落檔，任何一關失敗都不會產生檔案、而且一定出聲。
 *
 * @param {object} deps 相依注入（考題用假的，正式環境用真的）
 * @param {(url: string) => Promise<{ ok: boolean, status: number, statusText?: string,
 *          headers: { get(name: string): string | null }, text(): Promise<string> }>} deps.fetchFn
 * @param {(filename: string, body: string) => void} deps.saveFile 真的落檔（正式環境＝Blob + 暫時連結）
 * @param {(msg: string, isErr?: boolean) => void} deps.toast
 * @returns {Promise<{ ok: boolean, saved: boolean, reason: string, total: number, filename: string }>}
 */
export async function runExport({ fetchFn, saveFile, toast }) {
  /** @param {string} why @param {(w: string) => string} fmt */
  const fail = (why, fmt = failMsg) => {
    toast(fmt(why), true);
    return { ok: false, saved: false, reason: why, total: 0, filename: '' };
  };

  let res;
  try {
    res = await fetchFn('/api/export');
  } catch (err) {
    // 連不上（離線、伺服器沒開）——`fetch` 只有網路層失敗才 reject，HTTP 4xx/5xx 不會。
    return fail(/** @type {any} */ (err)?.message || '連不上伺服器', networkFailMsg);
  }

  if (!res.ok) {
    // 關卡①：HTTP 狀態。這是舊版最致命的漏洞——舊版根本沒看，401 的內容照樣被存成「備份」。
    let why = `伺服器回 ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
    try {
      const parsed = JSON.parse(await res.text());
      // ⚠️ 伺服器給了文字原因也**要把狀態碼留著**（`［401］`）：狀態碼是他來問我時唯一能定位的線索，
      //    而我們自己的 HOSTED 500 一定帶 JSON 原因（`lib/routes/auth.js` 的 wrap catch）——
      //    只留「伺服器發生錯誤」等於把那個線索丟掉。用全形方括號而不是第二個冒號／第二組括號：
      //    失敗文案本身已經有一個冒號、後面還要接一組括號的下一步，再疊會斷句斷錯。
      if (parsed && typeof parsed.error === 'string' && parsed.error.trim() !== '') why = `${parsed.error}［${res.status}］`;
    } catch { /* 回的不是 JSON（例如登入頁 HTML）＝維持狀態碼的說法 */ }
    // ⚠️ **只有 401 才叫他去登入**：500／502／503 掛的是伺服器那一端，403／404 也不是登入問題
    //    （本專案唯一的 403 來自 csrfOriginGuard，而它放行 GET＝`/api/export` 不可能因登入回 403），
    //    叫他重新登入是把他推往錯的方向（他會反覆登入、以為是自己的問題）。
    //    其餘一律走 serverFailMsg——有狀態碼、也有下一步。
    return fail(why, res.status === 401 ? authFailMsg : serverFailMsg);
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    // 也是網路層斷掉（body 讀到一半連線掉了）——跟 fetch reject 同一種下一步。
    return fail(/** @type {any} */ (err)?.message || '讀不到伺服器的回應', networkFailMsg);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 關卡②：parse 不出 JSON。最常見＝被導去登入頁（HTML）。這種情況舊版會存下一個 .json 的 HTML 檔。
    return fail('伺服器回的不是備份內容', notBackupMsg);
  }

  const sum = summarizeBackup(parsed);
  if (!sum.ok) return fail(sum.reason, notBackupMsg);   // 關卡③：長得像備份嗎

  // 標頭名稱**大小寫無所謂**：真實 `fetch` 的 `Headers.get()` 依 WHATWG 規格把名稱 byte-lowercase
  // 再查，`'content-disposition'` 與 `'Content-Disposition'` 完全等價（考題的假回應也照這個規則做）。
  const filename = filenameFromDisposition(res.headers.get('content-disposition'));
  // ⚠️ 落檔用**原始文字** `text`，不是 `JSON.stringify(parsed)`——備份要能原封不動還原。
  // ⚠️ 包 try：`saveFile` 丟錯（Blob 建不起來、DOM 被擋…）原本會讓整個 runExport reject，
  //    **一句話都不出現**＝靜靜失敗發生在最後一步，正是這一支要消滅的病。
  try {
    saveFile(filename, text);
  } catch (err) {
    return fail(/** @type {any} */ (err)?.message || '瀏覽器沒能把檔案存下來', saveFailMsg);
  }
  toast(okMsg(sum.total, filename));
  return { ok: true, saved: true, reason: '', total: sum.total, filename };
}
