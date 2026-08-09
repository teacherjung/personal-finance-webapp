// @ts-check
// 匯出備份：**按下去會說話**（William 2026-08-05 裁決另開一支修，不用文案打補丁）。
//
// 為什麼要有這一檔：一顆純 `<a href="/api/export" download>` 的鈕，瀏覽器直接把回應存成檔案——
// **成功失敗都不出聲**。雲端版若剛好 session 過期，`GET /api/export` 會回錯誤（或被導去登入頁），
// 瀏覽器照樣安安靜靜存下一個內容是錯誤訊息／HTML 的檔案，而使用者以為自己有備份了。
// ⚠️ 這顆鈕要會說話的理由**不依賴任何一段指路文案**：不可逆操作前的自動備份是本專案刻意不做的
//    （設計註解在 `lib/services/backup.js`），所以使用者按得出來的備份就只有這一顆鈕——
//    它靜靜失敗，等於他在毫無安全網的狀態下按下不可逆的整批改名。
//
// ⚠️ **「這包東西像不像備份」的判斷一律靠回應本身、不靠模式**：那三道關卡（狀態／JSON／骨架）
//    兩種模式完全相同，不需要也不可以為此分流。
// ⚠️ 但**匯出前那句告知**是例外，而且是 William 2026-08-08 明確授權的最小分流：
//    `/api/export` 兩種模式刻意相反（LOCAL 含機密／HOSTED 剝除），一句話講不對兩邊，
//    講錯方向會害使用者把含 IB 憑證的檔案轉寄出去（r4 阻擋①）。做法＝後端一支唯讀端點
//    `GET /api/mode` 只回 `{hosted:boolean}`，由 {@link exportNotice} 挑句子；
//    **問不到／形狀不合法一律回「含機密」那句**（往安全的方向錯）。
//    ⚠️ 授權範圍就到這裡：**不可以**把它擴張成「前端什麼環境資訊都能問」——完整契約見
//    docs/contracts/cloud-security.md「匯出前告知的模式分流」節。
//    三道關卡：①HTTP 狀態 ②內容 parse 得出 JSON ③長得像備份——③自己還有三小關（不是自帶
//    `error`／`errors` 的錯誤信封、頂層有 `settings` 物件、頂層至少有一個陣列），見 `summarizeBackup`。
//
// ⚠️ **不重新序列化**：落檔用的是 `res.text()` 拿到的那串文字本身，不是 `JSON.stringify(JSON.parse(...))`
//    ——伺服器怎麼排版就照樣存下去（縮排、空白、鍵序全部保留），因為這個檔案的用途是「原封不動還原」。
//    ⚠️ 但它**不是位元組層級的一模一樣**，所以這裡不可以寫「原始位元組」那種話（誇大比缺口更糟）：
//    `res.text()` 已經把位元組解碼成字串（依規格會**吃掉開頭的 UTF-8 BOM**、壞位元組會變成 U+FFFD），
//    再由 `Blob` 重新編成 UTF-8。`/api/export` 的輸出契約＝Express 的 `res.json()`（`lib/routes/core.js`
//    的 export 路由）＝不帶 BOM 的 UTF-8，因此這條路不受這個差別影響；契約一旦換成會帶 BOM 的寫法，
//    這裡要跟著改。要真的位元組級一致得改用 `arrayBuffer()`，代價是 `saveFile` 的介面與整族考題的
//    假回應都要改，換來的東西不值這個價。
//
// ⚠️ 這一檔刻意零 DOM、零 import（相依全部注入）——`public/app.js` 在 node 裡 import 不進來
//    （頂層碰 document／localStorage），純模組才能寫行為級考題。考題：test/backup-export.test.js。
//
// ── 誠實劃界（本模組**擋不住**什麼）─────────────────────────────────────────────
// 1. **右鍵「另存連結」仍會退回舊的靜靜失敗**。那顆 `<a>` 的 `href="/api/export"` 刻意留著
//    （右鍵另存的退路＋別的考題以這個字面定位它），而右鍵走的是瀏覽器自己的下載、根本不進這支模組。
//    `runExport` 保證的是**左鍵按下去會說話**——那是使用者實際會走的那條路；右鍵那條沒有守。
// 2. **不保證備份「內容完整」**。這裡只認「長得像備份」（有頂層 `settings`、有陣列、沒有錯誤鍵）
//    與筆數，不檢查該有哪些集合、欄位對不對、機密該不該剝。那些由伺服器端的考題守
//    （`test/server.test.js` 的 export→import 來回、
//    `test/hosted-secrets.test.js` 的機密投影）。⇒ 本模組全綠**不等於**那個檔還原得回來。
// 3. **判準綁在「`settings` 與集合都放在頂層」這份契約上**。若將來 `/api/export` 改成包一層
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
// 5. **`toast` 自己丟錯就沒人接得住**。落檔那一步已經包了 try（丟錯會改口走 {@link saveFailMsg}），
//    但如果連 `toast` 都丟錯，那條路上沒有第二個出聲的管道可用——不假裝守得住。
// 6. **不保證「檔案真的落到硬碟」**。本模組只到「把下載交給瀏覽器」為止：使用者按取消、瀏覽器把下載
//    擋掉、下載中途失敗，`<a>` 這條路**都不會回報**（能等待完成的 `showSaveFilePicker` 不在本模組的
//    責任範圍內）。
//    所以成功那句話**不宣稱檔案落地**：連「已存好／下載完成」都不說（黑名單在
//    test/backup-export.test.js 那題的 `已存下|已存好` 黑名單），只把「去下載夾確認檔案在不在」這個下一步交給他
//    （字面的單一真相＝{@link okMsg} 那一行）。
//    ⚠️ 誠實記著：句首那個「匯出成功」講的是**我們這一端做完了**，不是檔案已經在硬碟上——下載被
//    瀏覽器擋掉或使用者按取消時，畫面仍是同一句話。
// 7. **內容被截斷、但形狀完全正確的備份擋不住**：有頂層 `settings`、有頂層陣列、沒有 `error` 鍵的東西，
//    這三道關卡都會放行（它們認的是形狀，不是完整性）。使用者唯一的線索是提示裡那個筆數。
// 8. **提示終究會消失，而且事後查不到**。這幾句話全靠右下角的 toast 投遞，而固定停留時間會讓
//    「會出聲」這個保證整個押在使用者剛好在看畫面——長一點的句子還沒讀完就消失，等於沒說。
//    所以停留時間照長度給、滑鼠停在上面暫停、可以選字複製（`public/modules/toast-timing.js`
//    ＋`public/app.js` 的 `toast()`，考題 `test/toast-timing.test.js`）。
//    ⚠️ 成功那句沒有長度上限（尾巴掛著檔名與筆數，見 {@link okMsg}），失敗那幾句有（考題釘的界＝
//    test/backup-export.test.js 的 `msg.length <= 20`）——所以「停留時間照字數給」對兩邊都還是必要的。
//    **仍然守不住的**：他沒看畫面的那段時間（切到別的視窗、離開位子）＝等於沒說，而這個 app 沒有
//    提示紀錄本，訊息消失就真的沒了。要「事後查得到」得換地方講（例如卡片裡一塊固定區域），
//    那不在本模組的責任範圍內。

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
  // ⚠️ 用「」包住伺服器的原話：這一句**只進 `runExport` 的回傳 `reason`、不進畫面**（見 {@link failMsg}
  //    的說明）。原話自己常帶標點，用引號才看得出「哪一段是對方說的」。
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
 * ✅ 三道關卡都過了、下載交給瀏覽器之後說的那一句。
 * ⚠️ 考題釘的**不是逐字**（見 test/backup-export.test.js 的〈文案〉那一族）：句首、口徑（不得出現
 *    「已存下／已存好／已完成／下載完成」、要有「下載」或「確認」）、要有檔名、要有千分位、
 *    筆數要在括號裡。括號裡的措辭、順序與整句長度沒有考題守，改措辭前先去那一族確認自己踩到哪一條。
 *
 * ⚠️⚠️ **不說「已存下」，也不說「已開始下載」**：這條路只做到 `a.click()`，使用者按取消、
 *    瀏覽器擋下載、下載中途失敗，`<a>` 這條路**一個訊號都不會回來**——連「開始」都可能沒發生。
 *    在沒有證據的情況下宣告成功，正是 `runExport` 要消滅的病；所以只講**我們真的知道的事**
 *    （我們這一端做完了），結果交給他去下載夾確認。
 *    要真的知道結果得換成可等待完成的 `showSaveFilePicker`，那不在本模組的責任範圍內。
 *
 * 筆數加千分位：這個數字是他**唯一**用來判斷「這份備份是不是空的」的線索，四位數以上不分節很難讀
 * （`3214` 與 `321` 掃過去差不多）。這一檔零 import，所以用內建的 `toLocaleString`、不借 app.js 的工具。
 *
 * ⚠️ 這個數字是**所有頂層陣列的元素數總和**（帳戶／交易／持股／每日淨值／快照／歷史…），
 *    跟他在收支頁看到的筆數差很多（dailyValues、snapshots、history 通常遠大於交易數）。
 * ⚠️ **刻意接受的代價**：句子要短，就沒有空間解釋這個差別，所以他若拿這個數字去跟收支頁對帳，
 *    可能以為程式算錯。要補的是畫面上的提示，不是把這段話寫回句子裡
 *    （test/backup-export.test.js 的筆數那格註解記著同一筆代價）。
 * @param {number} total @param {string} filename
 */
export const okMsg = (total, filename) => `匯出成功 - 請至下載確認檔案（${filename}，共 ${total.toLocaleString('zh-TW')} 筆）`;
/**
 * ⏳ 文案（William 2026-08-08 定案的句型）：`匯出失敗 - <一句下一步>`。
 *
 * 🧑‍⚖️ **為什麼全部縮短**：舊稿每一句都把「為什麼」與「怎麼辦」寫足（三到四行），
 * William 讀完後裁決「太長」，改成**一行、只留下一步**。所以這裡的規矩是：
 *   ・成功＝`匯出成功 - 請至下載確認檔案`（＋檔名與筆數放括號，量級資訊不佔句子）
 *   ・失敗＝`匯出失敗 - ` 接**一件事**（要他做什麼／哪裡壞了），不解釋原理。
 * ⚠️ 縮短**不可以動到口徑**（那是文案，不是保證）：①成功仍**不敢說「已存好」**——落檔結果
 * 瀏覽器不回音，只能叫他去下載夾確認②**只有 401 才叫他重新登入**（其餘不猜；猜錯他會反覆登入）。
 * ⚠️ 伺服器原話與狀態碼**不進畫面**了，只留在 `runExport` 的回傳 `reason` 裡。
 * ⚠️ 誠實劃界：正式路徑（`public/modules/settings.js` 的 `await runExport({…})`）**沒有接住這個回傳值**，
 *    也沒有 log、沒有提示紀錄本（見 `public/app.js` 的 `toast()` 註解）——今天只有考題與 devtools
 *    斷點看得到 `reason`，**事後排查看不到**。要真的排查得到，得先讓呼叫端接住它（那是行為改動）。
 * @param {string} next
 */
export const failMsg = (next) => `匯出失敗 - ${next}`;
/** ⏳ 網路層斷掉（fetch reject／讀回應途中斷線）。 */
export const networkFailMsg = () => failMsg('請檢查網路連線');
/** ⏳ **401 專用**（伺服器自己說「請先登入」）；403／404／5xx 一律不走這條。 */
export const authFailMsg = () => failMsg('請重新登入再按匯出');
/**
 * ⏳ 伺服器那一端的狀況（5xx／403／404…）。
 * ⚠️ **與 {@link timeoutFailMsg} 逐字相同是刻意的**（William 2026-08-08 第二輪縮短）：
 * 「伺服器出錯」與「伺服器不回話」對使用者而言下一步一樣（等一下再試），畫面不必分。
 * 兩者的差別只留在 `runExport` 回傳的 `reason`（劃界見 {@link failMsg}：正式呼叫端沒接住它）。
 * **不要因為看起來重複就去分化它們。**
 */
export const serverFailMsg = () => failMsg('請稍後再試');
/** ⏳ 狀態 200 但內容不像備份（登入頁 HTML／錯誤信封／包一層的怪格式）。 */
export const notBackupMsg = () => failMsg('請重新整理後再試');
/** ⏳ 驗都過了、落檔那一步自己丟錯——刻意不斷言「沒存下」（可能存了一半）。 */
export const saveFailMsg = () => failMsg('存檔未完成，請再試一次');

/**
 * ⏳ 文案（William 2026-08-08 定案，**逐字**）：按下〈匯出備份〉先跳窗告知這件事，
 * 按「確認匯出」才真的開始下載。
 *
 * 🧑‍⚖️ 為什麼要有這一窗：雲端版匯出**刻意剝掉** IB 憑證與帳單密碼（`lib/secret-fields.js`
 * 的 `stripSecretsForBackup`），所以拿這份備份還原之後那兩樣要重新輸入。以前這件事畫面上
 * 一個字都沒有——使用者會在真的需要還原時才發現，那時已經來不及了。
 * ⚠️ 這是**告知**、不是警告：不擋、不需要理由，按下確認就走。
 */
export const EXPORT_NOTICE_HOSTED = '匯出檔案不含 IB 憑證與帳單密碼，之後使用備份還原需要重新輸入。';
/**
 * ⏳ 文案（William 2026-08-08 第二輪：「要講準，跟著模式分流」）：**本機版相反**——
 * `/api/export` 在 LOCAL **完整含機密**（缺了密碼就永久還原不回來，見 lib/routes/core.js 與
 * docs/contracts/cloud-security.md「兩種模式刻意相反」）。
 *
 * ⚠️⚠️ 這一句是 r4 審查者抓到的**反方向誤導**：上一版兩種模式都寫「不含機密」，本機版使用者
 * 會以為檔案不敏感而隨手轉寄／丟雲端硬碟——**裡面其實有他的 IB 憑證與帳單密碼**。
 * 畫面什麼都不講反而沒有這個風險，所以「講錯方向」比「不講」更糟。
 */
export const EXPORT_NOTICE_LOCAL = '匯出檔案含 IB 憑證與帳單密碼，請當成機密檔案保管。';
/**
 * 依模式挑那一句。⚠️ **問不到模式時一律回「含機密」那一句**（往安全的方向錯）：
 * 猜錯的方向若是「以為不含」，代價是機密外洩；反過來只是多一句提醒。
 * @param {{hosted?: unknown} | null | undefined} mode `GET /api/mode` 的回應（拿不到就傳 null）
 */
export const exportNotice = (mode) => (mode && mode.hosted === true ? EXPORT_NOTICE_HOSTED : EXPORT_NOTICE_LOCAL);
/** ⏳ 文案：按下確認之後、還沒拿到資料時的即時回饋（#417 r3 阻擋：卡住時畫面一句話都沒有）。 */
export const BUSY_MSG = '匯出中…';
/** 等多久算「伺服器不回話」（毫秒）。⚠️ 這個數字是**上限不是預期**：正常匯出零點幾秒就回來。 */
export const EXPORT_TIMEOUT_MS = 30_000;
/**
 * 問「哪一種模式」的等待上限（毫秒）。⚠️ 比匯出短很多（r5 阻擋①）：這只是一次極小的問答，
 * 而它卡住的代價是**連確認窗都不會出現**——「按下去沒聲音」那個病被搬到匯出前一步。
 * 逾時就當「問不到」＝走保守文案（含機密），不是等下去。
 */
export const MODE_TIMEOUT_MS = 5_000;
/** ⏳ 文案：等超過上限。 */
export const timeoutFailMsg = () => failMsg('請稍後再試');

/**
 * 「等太久就放棄」的預設實作：把工作與一顆計時器賽跑，計時器先到就丟一個 `name:'ExportTimeout'` 的錯。
 * ⚠️ 做成**可注入**（`runExport` 的 `withTimeout`）而不是寫死：考題要能不等 30 秒就驗到這條路。
 * ⚠️ 只放棄「等待」，不假裝取消伺服器那一端——我們無法保證對方沒有在做事，所以只有**回傳的 `reason`**
 *    說「等超過上限，伺服器沒有回應」；畫面那句是 {@link timeoutFailMsg}，與 {@link serverFailMsg} 逐字相同。
 * @template T @param {Promise<T>} work @param {number} ms @returns {Promise<T>}
 */
export function defaultWithTimeout(work, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('等超過上限'), { name: 'ExportTimeout' })), ms);
    work.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * 匯出流程本體。**先驗再存**：三道關卡都過了才把下載交出去，任何一關失敗都不會產生檔案、而且一定出聲。
 *
 * @param {object} deps 相依注入（考題用假的，正式環境用真的）
 * @param {(url: string) => Promise<{ ok: boolean, status: number, statusText?: string,
 *          headers: { get(name: string): string | null }, text(): Promise<string> }>} deps.fetchFn
 * @param {(filename: string, body: string) => void} deps.saveFile 把下載交給瀏覽器（正式環境＝Blob ＋暫時
 *        連結）。⚠️ 它**丟錯才叫失敗**；沒丟錯只代表「交出去了」，檔案有沒有真的落地收不到回音。
 * @param {(msg: string, isErr?: boolean) => void} deps.toast
 * @param {(work: Promise<any>, ms: number) => Promise<any>} [deps.withTimeout]
 *        「等太久就放棄」的實作（預設 {@link defaultWithTimeout}；
 *        考題注入自己的版本才不必真的等 30 秒）。
 * @returns {Promise<{ ok: boolean, saved: boolean, reason: string, total: number, filename: string }>}
 *          ⚠️ `saved: true` ＝**下載已經交給瀏覽器**，不是「檔案確定在硬碟上」（見 {@link okMsg} 的說明）。
 */
export async function runExport({ fetchFn, saveFile, toast, withTimeout = defaultWithTimeout }) {
  // ⚠️ `why`（伺服器原話／狀態碼）**只進回傳值不進畫面**（William 2026-08-08「太長」的裁決）：
  //    畫面一行給下一步，細節只留在回傳的 `reason`（劃界見 {@link failMsg}）。
  /** @param {string} why @param {() => string} fmt */
  const fail = (why, fmt = () => failMsg('請再試一次')) => {
    toast(fmt(), true);
    return { ok: false, saved: false, reason: why, total: 0, filename: '' };
  };

  // ⚠️ 進到這裡就**立刻**出聲（#417 r3 阻擋）：舊版是等到有結果才說第一句，伺服器不回話時畫面一句話
  //    都沒有，使用者會以為鈕壞了、反覆按。這一句是「我收到了」，不是保證會成功。
  // ⚠️ 界線講清楚：使用者按〈匯出備份〉那一下**還沒到這裡**——先問 `/api/mode`（上限 MODE_TIMEOUT_MS
  //    ＝5 秒，這段沒有 toast）再跳告知窗，按〈確認匯出〉才進來（見 settings.js 的 confirmExport）。
  toast(BUSY_MSG);
  let res;
  try {
    res = await withTimeout(fetchFn('/api/export'), EXPORT_TIMEOUT_MS);
  } catch (err) {
    // 連不上（離線、伺服器沒開）——`fetch` 只有網路層失敗才 reject，HTTP 4xx/5xx 不會。
    // 等超過上限＝另一條路（伺服器活著但不回話），下一步跟「網路斷」不同。
    if (/** @type {any} */ (err)?.name === 'ExportTimeout') return fail('等超過上限，伺服器沒有回應', timeoutFailMsg);
    return fail(/** @type {any} */ (err)?.message || '連不上伺服器', networkFailMsg);
  }

  if (!res.ok) {
    // 關卡①：HTTP 狀態。這是舊版最致命的漏洞——舊版根本沒看，401 的內容照樣被存成「備份」。
    let why = `伺服器回 ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
    try {
      // ⚠️ 這裡也要有上限（r4 阻擋②）：500 的 body 若永不 settle，整條路就卡在「匯出中…」不動了
      //    ——與成功路徑同一個病，只是走在錯誤分支上（複驗者用合成探針證明過）。
      const parsed = JSON.parse(await withTimeout(res.text(), EXPORT_TIMEOUT_MS));
      // ⚠️ 伺服器給了文字原因也**要把狀態碼留著**（`［401］`）：狀態碼是他來問我時唯一能定位的線索，
      //    而 `/api/export` 這條路的 500 走 `server.js` 的全域錯誤中介（`app.use((err, …))`）＝帶 JSON `error`
      //    （⚠️ 不是全站保證：`lib/routes/route-helpers.js` 的 `sendRouteError` 對帶 `status` 的錯自己
      //    回應、不進中介；中介自己在 `res.headersSent` 時也會交還 Express 預設 handler＝HTML。
      //    本模組只管 `/api/export` 這一條路。）
      //    ——只留「伺服器發生錯誤」等於把那個線索丟掉。
      //    ⚠️ 帶 `status:500` 的內部錯（如 `lib/store-pg.js` 的 kv_backend）在那道中介會被換成
      //    「請求格式不正確」，所以 `error` 未必講出真正的原因，狀態碼才是唯一穩定的線索。
      //    （`lib/routes/auth.js` 的 wrap catch 只管 `/api/auth/*`；`/api/export` 走 `asyncRoute`＝不經它。）
      //    ⚠️ 這一串**只進 `reason` 不進畫面**（見 {@link failMsg} 的劃界）。
      if (parsed && typeof parsed.error === 'string' && parsed.error.trim() !== '') why = `${parsed.error}［${res.status}］`;
    } catch { /* 回的不是 JSON（登入頁 HTML）**或讀 body 超時**＝維持狀態碼的說法：狀態碼本身已經
                 足夠給下一步（401 去登入／其餘等一下再試），不必為了讀不到原話而讓畫面卡住 */ }
    // ⚠️ **只有 401 才叫他去登入**：500／502／503 掛的是伺服器那一端，403／404 也不是登入問題
    //    （本專案唯一的 403 來自 csrfOriginGuard，而它放行 GET＝`/api/export` 不可能因登入回 403），
    //    叫他重新登入是把他推往錯的方向（他會反覆登入、以為是自己的問題）。
    //    其餘一律走 serverFailMsg——有狀態碼、也有下一步。
    return fail(why, res.status === 401 ? authFailMsg : serverFailMsg);
  }

  let text;
  try {
    // 讀回應也要有上限：卡在這裡跟卡在 fetch 一樣是「畫面沒反應」（r3 阻擋點名的第二條路）。
    text = await withTimeout(res.text(), EXPORT_TIMEOUT_MS);
  } catch (err) {
    if (/** @type {any} */ (err)?.name === 'ExportTimeout') return fail('讀回應等超過上限', timeoutFailMsg);
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
  // ⚠️ 包 try：`saveFile` 丟錯（Blob 建不起來、DOM 被擋…）不接住就會讓整個 `runExport` reject，
  //    **一句話都不出現**＝靜靜失敗發生在最後一步，正是 `runExport` 要消滅的病。
  try {
    saveFile(filename, text);
  } catch (err) {
    return fail(/** @type {any} */ (err)?.message || '瀏覽器沒能把檔案存下來', saveFailMsg);
  }
  toast(okMsg(sum.total, filename));
  return { ok: true, saved: true, reason: '', total: sum.total, filename };
}
