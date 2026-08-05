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
//    三道關卡：①HTTP 狀態 ②內容 parse 得出 JSON ③長得像備份——③自己還有三小關（不是自帶
//    `error`／`errors` 的錯誤信封、頂層有 `settings` 物件、頂層至少有一個陣列），見 `summarizeBackup`。
//
// ⚠️ **不重新序列化**：落檔用的是 `res.text()` 拿到的那串文字本身，不是 `JSON.stringify(JSON.parse(...))`
//    ——伺服器怎麼排版就照樣存下去（縮排、空白、鍵序全部保留），因為這個檔案的用途是「原封不動還原」。
//    ⚠️ 但它**不是位元組層級的一模一樣**（這句話原本寫成「原始位元組」，是誇大，2026-08-06 改掉）：
//    `res.text()` 已經把位元組解碼成字串（依規格會**吃掉開頭的 UTF-8 BOM**、壞位元組會變成 U+FFFD），
//    再由 `Blob` 重新編成 UTF-8。今天的 `/api/export` 走 Express 的 `res.json()`＝不帶 BOM 的 UTF-8，
//    所以這個差別在現行部署上咬不到人；要真的位元組級一致得改用 `arrayBuffer()`，代價是 `saveFile`
//    的介面與整族考題的假回應都要改，今天不值得。
//
// ⚠️ 這一檔刻意零 DOM、零 import（相依全部注入）——`public/app.js` 在 node 裡 import 不進來
//    （頂層碰 document／localStorage），純模組才能寫行為級考題。考題：test/backup-export.test.js。
//
// ── 誠實劃界（這一支**擋不住**什麼）─────────────────────────────────────────────
// 1. **右鍵「另存連結」仍會退回舊的靜靜失敗**。那顆 `<a>` 的 `href="/api/export"` 刻意留著
//    （右鍵另存的退路＋別的考題以這個字面定位它），而右鍵走的是瀏覽器自己的下載、根本不進這支模組。
//    這一支保證的是**左鍵按下去會說話**——那是使用者實際會走的那條路；右鍵那條沒有守。
// 2. **不保證備份「內容完整」**。這裡只認「長得像備份」（有頂層 `settings`、有陣列、沒有錯誤鍵）
//    與筆數，不檢查該有哪些集合、欄位對不對、機密該不該剝。那些由伺服器端的考題守
//    （`test/server.test.js` 的 export→import 來回、
//    `test/hosted-secrets.test.js` 的機密投影）。⇒ 本模組全綠**不等於**那個檔還原得回來。
// 3. **判準綁在「`settings` 與集合都放在頂層」這個現況上**。若將來 `/api/export` 改成包一層
//    （`{ data: { settings: {...}, transactions: [...] } }`），這支會判定「不像備份」而**拒絕落檔**
//    （實測 `ok:false`）——那是誤擋、不是靜靜失敗（使用者會看到出聲），但改格式的人必須一起改這裡。
//    ⚠️ 這**不是**第二份集合清單（沒有列舉任何集合名），而是同一份契約的另一端：後端
//    `lib/schema.js` 的 `sanitizeDbForWrite` 本來就以「缺 `settings` 就丟錯」為前提。但耦合是真的，
//    所以講明白：頂層 `settings` 這件事哪天不成立，這裡要跟著改。
// 4. 接線那一題讀的是**原始碼文字**，擋不住刻意混淆（把名字拼接起來之類）。它守的是「下一個人順手
//    改壞」，不是防惡意。它切出 `exportBtn` 的 handler 區塊、在**那一段裡面**要求 `runExport`／
//    `preventDefault`／不得自己 `fetch`＋`createObjectURL`／不得自己 `location.assign('/api/export')`，
//    並要求注入的 `toast` 真的會被呼叫、注入的 `saveFile` 真的會**觸發**下載——但這一切仍然只是
//    「文字長得對」，不是跑起來對。⚠️ **已知還繞得過去的一條**：把 `runExport(...)` 藏進 handler 裡
//    一個沒人呼叫的閉包（`const dead = () => runExport({...})`），文字上樣樣齊全、實際上一次也沒跑。
//    列舉繞法補不完（這是本專案認過的病型），所以這裡關門：**這一題只是提醒，不是保證**；
//    真正保證「按下去會說話」的只有 `runExport` 自己那一族行為題。
// 5. **`toast` 自己丟錯就沒人接得住**。落檔那一步已經包了 try（丟錯會改口說「存檔那一步出錯」），
//    但如果連 `toast` 都丟錯，那條路上沒有第二個出聲的管道可用——不假裝守得住。
// 6. **不保證「檔案真的落到硬碟」**。這一支只到「把下載交給瀏覽器」為止：使用者按取消、瀏覽器把下載
//    擋掉、下載中途失敗，`<a>` 這條路**都不會回報**（能等待完成的 `showSaveFilePicker` 超出本支範圍）。
//    所以成功那句話**刻意不宣稱結果**，只說「已開始下載」並叫他去下載夾確認——本支存在的理由就是
//    「沒有證據時不要宣告成功」，那條規矩對我自己也一樣適用。
// 7. **內容被截斷、但形狀完全正確的備份擋不住**：有頂層 `settings`、有頂層陣列、沒有 `error` 鍵的東西，
//    這三道關卡都會放行（它們認的是形狀，不是完整性）。使用者唯一的線索是提示裡那個筆數。

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
 * 從錯誤信封裡撈一句人看得懂的原因；不是錯誤信封就回 `''`。
 *
 * ⚠️ 認的是**鍵名**（`error`／`errors`），不是內容：一包東西自己宣告「我裡面有錯誤」，就不可以被當成
 *    完整備份存起來。這一條擋的是 `200 {"errors":[{"message":"JWT expired"}]}` 這一型——各家閘道
 *    （Supabase／GraphQL 風格的中間層）很常這樣回，而**部分成功**（有資料也有 errors）比整包失敗更毒：
 *    那個檔案看起來完好，還原回去卻少東西。
 * ⚠️ 代價講明白（兩個，都是**會出聲的誤擋**、不是靜靜失敗）：
 *    ①哪天備份真的多一個叫 `error`／`errors` 的頂層集合，這裡會誤擋
 *      （今天實測 `emptyDb()` 的 21 個頂層鍵裡沒有這兩個名字）。
 *    ②連 `errors: []`（有欄位、內容是空的）也不收——若哪天有中間層「成功時也一律附一個空 errors」，
 *      匯出會整條不能用。刻意選這一邊：判準看鍵名才守得住「部分成功」，而誤擋看得見、靜靜落檔看不見。
 * @param {Record<string, unknown>} obj
 * @returns {string} 空字串＝不是錯誤信封
 */
function errorEnvelopeReason(obj) {
  const hasError = Object.hasOwn(obj, 'error'), hasErrors = Object.hasOwn(obj, 'errors');
  if (!hasError && !hasErrors) return '';
  // ⚠️ 用「」包住伺服器的原話、不用第二個冒號：失敗文案本身已經有一個冒號
  //    （「沒有存下任何檔案：伺服器說：…」兩個冒號讀起來會斷句斷錯）。
  for (const raw of [obj.error, ...(Array.isArray(obj.errors) ? obj.errors : [obj.errors])]) {
    // `{error:'請先登入'}`、`{errors:['請先登入']}`、`{errors:[{message:'JWT expired'}]}` 三種形狀都撈
    const msg = typeof raw === 'string' ? raw
      : (raw && typeof raw === 'object' && typeof (/** @type {any} */ (raw).message) === 'string') ? /** @type {any} */ (raw).message
        : '';
    if (msg.trim() !== '') return `伺服器說「${msg.trim()}」`;
  }
  // 有 error 鍵卻撈不出人話（`{errors:[]}`、`{error:{code:42}}`）：也要出聲，只是講不出原因
  return '伺服器回的是一則錯誤訊息，不是備份';
}

/**
 * 「這團東西長得像備份嗎」——**刻意不列舉集合名稱**，但要求備份該有的**骨架**。
 *
 * 三個問題（任一不過就不是備份）：
 *  ①不是自己宣告有錯的信封（`error`／`errors`，見 {@link errorEnvelopeReason}）
 *  ②頂層有 `settings` 物件
 *  ③頂層至少有一個「值是陣列」的鍵
 *
 * ⚠️ 為什麼不列舉集合：前端不能 import `lib/schema.js` 的 `ALL_COLLECTIONS`，抄一份過來就是第二份
 *    會漂的複本（本專案為這個病型付過很多代價）。所以判準是**性質**，不是名單。
 * ⚠️ 為什麼②不算「第二份會漂的複本」：`settings` 不是清單裡的一項，而是**後端契約本身**——
 *    `lib/schema.js` 的 `sanitizeDbForWrite` 開頭就是「缺 `settings` 直接丟錯」，所以「沒有頂層
 *    `settings` 的東西不是這個 app 的備份」是同一份契約的兩端，不是我這裡另立的名單。
 *    實測 `emptyDb()` 與 `stripSecretsForBackup(emptyDb())`（HOSTED 匯出走的那條）都有頂層 `settings`。
 * ⚠️ ②③缺一不可（歷史）：只有③的那一版讓 `200 {"errors":[{"message":"JWT expired"}]}` 通關，
 *    落下一個內容是「JWT 過期」的 .json、畫面還說「已存下備份：共 1 筆紀錄」——r1 審查者實測抓到。
 *    當時檔頭寫著「要修只能抄一份 ALL_COLLECTIONS，所以不修」，那句話是**假的**（誇大自己的無能）：
 *    ①②兩條路都不必列舉任何集合。
 * @param {unknown} data 已 parse 的回應
 * @returns {{ ok: boolean, reason: string, total: number }} total＝所有頂層陣列的元素數總和
 */
export function summarizeBackup(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    // ⚠️ 不寫「回應不是一包資料」：「一包資料」是我們自己腦內的說法，他讀不出那是什麼意思。
    return { ok: false, reason: '伺服器回來的東西不是一份備份檔', total: 0 };
  }
  const obj = /** @type {Record<string, unknown>} */ (data);
  const envelope = errorEnvelopeReason(obj);   // 關卡③-①：自己宣告有錯的，不管長得多像備份都不收
  if (envelope) return { ok: false, reason: envelope, total: 0 };
  if (obj.settings === null || typeof obj.settings !== 'object' || Array.isArray(obj.settings)) {
    // 關卡③-②：備份的骨架。錯誤信封、包一層的格式、隨便一包 JSON 都過不了這一關。
    return { ok: false, reason: '伺服器回來的東西不是一份備份檔（少了「設定」那一段）', total: 0 };
  }
  let arrays = 0, total = 0;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) { arrays++; total += v.length; }
  }
  // 關卡③-③：一個集合都沒有＝不是這個 app 匯出的東西（真備份至少帶著 17 個空陣列）
  if (arrays === 0) return { ok: false, reason: '裡面沒有任何一筆資料', total: 0 };
  return { ok: true, reason: '', total };
}

/**
 * ⏳ 文案（Claude 起草、**待 William 審改**）：三道關卡都過了、下載已經交給瀏覽器。
 *
 * ⚠️⚠️ **刻意不說「已存下」**（r1 審查者抓到，2026-08-06 改）：這條路只做到 `a.click()`，
 *    使用者按取消、瀏覽器擋下載、下載中途失敗，`<a>` 這條路**一個訊號都不會回來**。
 *    原本寫「已存下備份：…」＝在沒有證據的情況下宣告成功，那正是這一整支要消滅的病
 *    （而且我自己犯了）。所以改成只講**我們真的知道的事**（下載已經開始、這份東西有幾筆），
 *    結果由他去下載夾確認。要真的知道結果得換成可等待完成的 `showSaveFilePicker`，超出本支範圍。
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
  `已開始下載：${filename}，共 ${total.toLocaleString('zh-TW')} 筆紀錄（交易、帳戶、快照…全部加起來）。`
  + '請到下載夾確認檔案在不在——下載有沒有真的完成，程式這邊看不到。';
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
 * ⏳ 文案（待審）：狀態 200、但內容不像備份（登入頁 HTML／錯誤信封／包一層的怪格式）。
 *
 * ⚠️⚠️ **這一條不可以叫他去登入**（r1 審查者抓到，2026-08-06 改）：舊稿對**所有** 200-不像備份的情形
 *    都寫「雲端版：可能是登入過期了，重新登入再試一次」，包含 `200 {"error":"權限不足"}` 這種明明
 *    跟登入無關的。口徑定死：**只有 401 走登入文案**（{@link authFailMsg}）——那一條是伺服器自己
 *    講「你沒登入」，其餘一律不猜。猜錯的代價是他反覆登入、以為是自己的問題。
 * ⚠️ 那要給什麼下一步？走到這裡表示後端**有回應**（不然是 fetch reject），所以問題在「回的東西不對」：
 *    先重新整理再按一次（暫時性的怪回應會消失），還是一樣就把整句話拿來問我。本機版另外加一句
 *    「後端改完有沒有重啟」——那是本機最常見的原因，而且它對雲端使用者只是一句用不到的話，不會誤導。
 * @param {string} why
 */
export const notBackupMsg = (why) =>
  `${failMsg(why)}（重新整理頁面再按一次；還是一樣就把這句話整句告訴我。本機版順便看一下後端改完有沒有重啟。）`;
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
 * 匯出流程本體。**先驗再存**：三道關卡都過了才把下載交出去，任何一關失敗都不會產生檔案、而且一定出聲。
 *
 * @param {object} deps 相依注入（考題用假的，正式環境用真的）
 * @param {(url: string) => Promise<{ ok: boolean, status: number, statusText?: string,
 *          headers: { get(name: string): string | null }, text(): Promise<string> }>} deps.fetchFn
 * @param {(filename: string, body: string) => void} deps.saveFile 把下載交給瀏覽器（正式環境＝Blob ＋暫時
 *        連結）。⚠️ 它**丟錯才叫失敗**；沒丟錯只代表「交出去了」，檔案有沒有真的落地收不到回音。
 * @param {(msg: string, isErr?: boolean) => void} deps.toast
 * @returns {Promise<{ ok: boolean, saved: boolean, reason: string, total: number, filename: string }>}
 *          ⚠️ `saved: true` ＝**下載已經交給瀏覽器**，不是「檔案確定在硬碟上」（見 {@link okMsg} 的說明）。
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
