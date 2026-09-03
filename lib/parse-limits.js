// @ts-check
// 解析器與大型外部回應的資源上限（可用性第一層，2026-07-28；C0 威脅模型「解析器 DoS」那一列）。
//
// 白話：三個 PDF 解析器與 IB 的 XML 解析器，都是「拿一份檔案、跑很久、吃很多記憶體」的操作。
// 上傳大小已經被 `lib/http-body.js` 擋在 15MB／50MB，但**檔案小不代表解析便宜**——
// 一份 200KB 的 PDF 可以有幾萬頁、或幾十萬個文字節點（壓縮炸彈），解析時把記憶體吃光。
//
// **兩種模式都套**（與速率限制不同）：這一類防的是「畸形／惡意的檔案」，而你在本機一樣會
// 從銀行或券商下載檔案。這與階段四 B 的異常輸入防線同一個邏輯（那一層 LOCAL 也套）。
//
// 上限訂在「比真實帳單大一個數量級」：
//   真實信用卡帳單 ≈ 2–6 頁、銀行綜合對帳單 ≈ 6–15 頁、證券對帳單 ≈ 2–10 頁。
//   200 頁＝就算你一次匯一整年也綽綽有餘，但擋得住「幾萬頁」那種。
// **超過上限＝明確拒絕並說原因**（不是靜默截斷——截斷會讓你以為匯完了，其實少了半年）。

/** PDF 頁數上限。 */
export const MAX_PDF_PAGES = 200;
/** 整份 PDF 的文字節點總數上限（防「頁數不多但每頁塞十萬個字元節點」）。 */
export const MAX_PDF_TEXT_ITEMS = 300_000;
/**
 * SEC 單一 HTTP 回應的位元組上限。
 *
 * Company Facts 會先收完整 body、解碼，再 JSON.parse；原始回應大小不是最終記憶體成本。
 * #371 的隔離量測顯示 25MiB 路徑約增加 118MiB RSS，而全站重型名額已限制同時只跑一件；
 * 現行 25MiB 因此保留，避免誤殺約 5–15MiB 的正常公司資料。調整前要重新量測 Render
 * 512MiB 容器的 app 底噪、完整解析峰值與重型名額，不可只憑檔案大小猜。
 */
export const MAX_SEC_RESPONSE_BYTES = 25 * 1024 * 1024;
/**
 * IB Flex XML 的原始字元數上限（fast-xml-parser 解析前先擋）。
 *
 * ⚠️ **2026-07-28 從 40MB 降到 12MB**（Codex 收官審查 #1 引出的實測）。
 *    40MB 這個數字當初是憑「XML 展開成物件是原文數倍」的直覺訂的，沒有任何量測背書。
 *    實測（真實 IB Flex 排版，Trade 帶 50 個屬性，`--max-old-space-size=400`）：
 *
 *      12 MB → 峰值 RSS 254 MB
 *      24 MB → 峰值 RSS 387 MB
 *      40 MB → **行程直接死（OOM）**
 *
 *    也就是說**舊上限本身就是死亡線**：一份完全合法、完全被列數牆數到的報表
 *    （38,805 筆 Trade，離 50,000 的列數上限還很遠）就足以打死 Render 的 512MB 單一行程。
 *    Codex 說的「白名單漏了標籤」是真的，但**把更多標籤加進白名單修不好記憶體**——
 *    真正的病是這個數字。
 *
 *    12MB 怎麼來的：目標是把「解析多出來的記憶體」壓在 150MB 以內
 *    （Render 512MB − app 底噪約 148MB，還要留給同時進來的其他請求）。
 *    實測斜率約每 1MB XML 吃 12MB RSS → 150 ÷ 12 ≈ 12.5MB。
 *
 *    ⚠️ **已知代價**：重度交易者的 365 天報表可能超過 12MB，會被要求縮短期間分批同步。
 *    這是刻意的取捨——「同步失敗但有明確指示」遠好過「全站被打掛」。
 */
export const MAX_IB_XML_CHARS = 12 * 1024 * 1024;
/**
 * 整份 XML 的**元素總數**上限。
 *
 * 為什麼位元組上限不夠（實測，同樣 12MB）：
 *      真實 IB 排版   18,289 個元素 → 254 MB
 *      極小元素 `<Z/>` 3,145,728 個 → **472 MB**
 *    同樣的位元組數，元素多寡讓峰值差了將近兩倍——**兩道牆量的是不同的東西，缺一不可**。
 *
 * 而且這一道是**不分標籤**的：`IB_ROW_TAGS` 那份白名單只數四種標籤，
 * IB 官方還有 CorporateAction／Transfer／InterestAccrual 等十幾種區段完全不受約束
 * （Codex #1 實測：50,001 筆 `<CorporateAction/>` 原封不動通過）。
 * 改成數總元素數之後，**任何未來新增的 Flex 區段自動被涵蓋**，不必再維護白名單。
 *
 * 50 萬怎麼來的：實測 50 萬個極小元素 → 188MB（約比底噪多 83MB），是安全水位；
 * 100 萬 → 256MB 就開始逼近。對照組：真實 12MB 報表只有 18,289 個元素＝**27 倍餘裕**。
 */
export const MAX_IB_XML_ELEMENTS = 500_000;
/** 一份報表可接受的最大交易列數（IB 成交紀錄／現金交易）。 */
export const MAX_IB_ROWS = 50_000;
/** 同一個上限的「位元組」版本：HTTP 回應是先有位元組才有字串，要擋就得擋在解碼之前。
 * UTF-8 的位元組數永遠 ≥ 字元數，所以用同一個數字當位元組上限只會更嚴、不會放水。 */
export const MAX_IB_XML_BYTES = MAX_IB_XML_CHARS;

/**
 * 邊收邊數地抽一頁的文字節點——**取代 `page.getTextContent()`**（2026-07-29）。
 *
 * ⚠️ 為什麼非換不可（自審抓到的兩個 blocking，都已重現）：
 *    `getTextContent()` 會把**整頁**的節點材料化之後才回來，所以 `countTextItems`
 *    無論擺在哪裡都是**事後才數**——單頁塞爆就整個繞過：
 *      ・138KB 的一頁 PDF（約 200 萬個 Tj）→ **行程死掉**（峰值 612MB）
 *      ・207KB 的一頁 PDF（內容串流解壓後 83MB）→ **行程死掉**（峰值 704MB）
 *    ⚠️ **2026-08-29 更正**：這裡原本寫「死法不只 OOM——也可能是 pdfjs 卡死在解壓、promise 永不
 *      settle，那條路接不到、要靠行程隔離的逾時」。**那個「卡死」不是 pdfjs 的脾氣，是本函式
 *      自己造成的**：下面的 `cancelStream` 少帶一個理由，取消從沒生效（完整機制見該函式的註解）。
 *      修好之後，同一顆 207KB 炸彈檔由這道牆**當場擋下**、不再需要逾時去收
 *      （⚠️ 這裡刻意不寫秒數：沒有考題會因為那個數字漂掉而轉紅——Grok 掃描 #3。
 *       量到的數字與條件留在 `docs/pdf-cancel-reason-fix-proposal.md`，那是有日期的證據）。
 *      逾時仍然留著，但它守的是**未知**的卡死，不是這一個。
 *    「逐頁累加」當初就是為了避免「等整份讀完才檢查」，但它在**單頁之內**仍然是事後才數。
 *    牆的形狀對，位置差一層。
 *
 * ✅ 改用 `streamTextContent()` 邊收邊數、超標就 `cancel(new Error(...))` 當場中止
 *    （⚠️ **理由不可省**，見 `cancelStream`）：
 *      ・138KB 那份 → 擋下（2026-07-29 當時量到峰值 254MB，原本 612MB 崩潰）
 *      ・207KB 那份 → 擋下（2026-07-29 當時量到峰值 316MB，原本 704MB 崩潰）
 *    ⚠️ **這組數字目前活在四個地方**（本處、`test/parse-limits.test.js`、
 *      `docs/contracts/cloud-security.md`，以及 `lib/heavy-admission.js` 用 316MB 推「同時只能一顆」）
 *      ——**沒有任何閘盯著它們一致**。改這裡就要一起改那三處。
 *      ⚠️ 我原本在這裡寫「這裡是單一真相」：那是一句**沒人執法的現況話**，正是本支在修的那一族
 *      （#538 自審 r3 抓到）。要嘛把四處收成一處並補掃描器，要嘛照實寫「這四處要一起改」——選後者，
 *      因為為了一組歷史數字寫掃描器不划算，而說謊比列清單貴。
 *    ⚠️ **取消修好之後（2026-08-29）我重量過一次**，兩顆都由這道牆擋下、回乾淨的 400，成本仍留在
 *      子行程。**確切數字刻意不寫進註解**：量測條件（機器／Node／pdfjs 版本／heap 上限）與
 *      2026-07-29 那組完全不同，寫進來只會多一份對不起來的抄本；數字與條件留在
 *      `docs/pdf-cancel-reason-fix-proposal.md`（有日期的證據，不是活的宣稱）。
 *
 * 📌 **AGENTS.md 曾經記載「`streamTextContent` 實測零收益（640MB vs 640MB）」——那句話是錯的**
 *    （或至少不適用於這兩種形狀）。這次重新實測後推翻，數字如上。
 *
 * 📌 **正確性也實測過**：拿一份擬真帳單（6 頁 × 120 列、多字級、FlateDecode）兩種方式各抽一次，
 *    抽取器真的會用到的欄位（`str` / `transform[4]` / `transform[5]` / `width`）**逐項完全相同**。
 *    （只有 `fontName` 的 `g_d0_` / `g_d1_` 前綴不同，那是「本行程載入的第幾份文件」的計數器，
 *     不是兩種方式的差異；三個抽取器都沒有用到 `fontName`。）
 *
 * @param {any} page pdfjs 的 page @param {number} soFar 之前累計的節點數 @param {string} what 給訊息用
 * @returns {Promise<{items: any[], count: number}>}
 */
export async function readPageTextCapped(page, soFar, what) {
  const reader = page.streamTextContent().getReader();
  /** @type {any[]} */
  const items = [];
  let n = soFar;
  let overCap = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value?.items || [];
      n += chunk.length;
      // ⚠️ **先檢查再收下**：收下去才檢查就又變回「事後才數」，那正是要修的病。
      if (n > MAX_PDF_TEXT_ITEMS) {
        overCap = true;
        parseDiag.add(PARSE_DIAG.CAP_HIT);
        throw Object.assign(
          new Error(`${what}的文字內容太多（超過 ${MAX_PDF_TEXT_ITEMS.toLocaleString()} 個文字節點），無法安全解析。`
            + '請確認這是一份正常的對帳單；如果檔案很大，請改用該期單獨的帳單檔。'),
          { status: 400, code: 'pdf_too_many_text_items' });
      }
      for (const it of chunk) items.push(it);
    }
  } finally {
    // ⚠️ **取消只有這一個呼叫點**（Codex #538 r1）：超標分支原本自己先 cancel 一次再 throw，
    //    但 throw 會立刻走到這個 finally——同一個 tick 內再取消一次，等於**雙重取消、雙份日誌**，
    //    而且兩條路沒有任何考題分得出來（他實測把超標分支那次刪掉，根因考題照樣全綠）。
    //    「當場中止」的語意由這裡承擔：throw 與這次取消之間沒有任何 await。
    await cancelStream(reader, overCap ? '超過文字節點上限，中止 pdfjs 串流' : '抽取結束，放掉 pdfjs 串流');
  }
  return { items, count: n };
}

/**
 * **解析過程的診斷代碼**——封閉集合，**只記「發生了什麼」、不記任何內容**。
 *
 * ⚠️ 為什麼需要它（Codex #538 r3 High）：`cancelStream` 的 `console.error` 在 **HOSTED 是靜默的**。
 *    抽取跑在子行程裡，它的 stderr 只進父行程的私有字串；父行程**只有**在「沒有 stdout 且不是
 *    資源／逾時」或子行程回報 5xx 時才會把它記進日誌。取消失敗剛好兩種都不是
 *   （原本的 400 還是會正常回來）⇒ **這一層最需要出聲的那個環境，反而聽不見。**
 * ⚠️ **刻意不轉印整段子行程 stderr**：那會把 PDF 內容（金額、帳號）帶進日誌。
 *    只傳這一組封閉代碼，子行程把它放進回傳的 JSON，父行程照代碼記日誌。
 *    同款做法在 `lib/recipe-birth.js`／`lib/progress-stages.js`（封閉代碼、只記結果不記內容）。
 */
export const PARSE_DIAG = /** @type {const} */ ({
  /** 取消 pdfjs 串流失敗——本支的主角，HOSTED 唯一聽得見它的方式。 */
  CANCEL_FAILED: 'pdf_cancel_failed',
  /** 文字節點牆擋下了一份檔案。
   *  ⚠️ 兩個理由，缺一我都不會加它：
   *  ①**營運上真的有用**：HOSTED 的父行程原本對使用者層 400 完全不記錄，
   *    連續有人踩到這道牆**可能**是有人在探邊界、**也可能**是正當的超大檔一直重試——
   *    兩種都值得聚合起來看（內容一個字都不帶）。⚠️ 不要把意圖寫死（Codex #538 r5 Low）。
   *  ②**它讓這條通道有端到端的考題**（Codex #538 r4 High）：`CANCEL_FAILED` 沒有任何
   *    真實輸入做得出來（實測連壞掉的內容串流 pdfjs 都容忍），所以「正式子行程真的會把
   *    非空診斷送到父行程」這件事本來無法用真的子行程證明——這個代碼可以。 */
  CAP_HIT: 'pdf_cap_hit',
});
/** @type {Set<string>} */
const parseDiag = new Set();
/** 取走目前累積的診斷代碼（取完就清空）。子行程在寫回 JSON 之前呼叫。 @returns {string[]} */
export function drainParseDiag() {
  const out = [...parseDiag];
  parseDiag.clear();
  return out;
}

/**
 * 取消 pdfjs 的文字串流。**理由（一個 `Error`）不是裝飾品，是 pdfjs 的硬性要求。**
 *
 * ⚠️ **這裡曾經只寫 `reader.cancel()`，於是這道牆的收尾動作從沒生效過**（2026-08-29 追出，
 *    起因是 CI 間歇紅）。pdfjs `sendWithStream` 的來源物件第一行就是
 *    `assert(reason instanceof Error, "cancel must have a valid reason")`——**它排在
 *    「標記 isClosed」與「送 CANCEL 給生產端」之前**，所以少一個參數會同時造成三件事：
 *      ①WHATWG 的 `cancel()` 是「先關閉串流、再問來源」⇒ **我們這端的 controller 已經關了**
 *      ②pdfjs 的 `isClosed` 還是 false、CANCEL 訊息從沒送出 ⇒ **它完全不知道對方走了**
 *      ③`.catch()` 把 rejection 吞掉 ⇒ **沒有人知道取消失敗**
 *    後果是三種死法（都實測過，見 `docs/pdf-cancel-reason-fix-proposal.md` 第三節）：
 *    生產端永遠等一個不會排空的 sink ⇒ `task.destroy()` **永不回來**（行程隔離那層要靠逾時才收得回，
 *    訊息還把原因說成「解析太久」）；事件迴圈因此空掉 ⇒ 子行程 **`code 0` 靜默退出**
 *   （2026-08-01 曾被誤診成「pdfjs 卡在解壓」）；取消當下若有 ENQUEUE 還在路上，落地時會對
 *    已關的 controller `enqueue()` ⇒ **未捕捉的 `ERR_INVALID_STATE`、子行程 `code 1`**（CI 紅的指紋）。
 *    帶了理由之後實測：`cancel ok` → `destroy` 立刻完成、207KB 的炸彈檔回一個乾淨的 400
 *   （秒數見提案文件；活註解不寫死沒有考題撐的數字）。
 *
 * ⚠️ **失敗要出聲、不可以純吞**：取消失敗會把「牆擋下了」靜靜變成「卡死」，
 *    而靜靜通過比沒有護欄更糟。（⚠️ 這裡原本還寫「一年也走不到幾次，沒有噪音成本」——
 *    那是**沒有量測撐著的宣稱**，Codex #538 r3 Low，拿掉。）
 * ⚠️ **界線（說到做得到為止，r3／r4 各修一次）**：
 *    ①**我們讀出來的 PDF 內容，逐字不進日誌**（chunk／items 都不印；考題用罕見字哨兵做字元級比對）。
 *    ②**pdfjs 丟出來的例外訊息會印**（診斷的本體，已截到 200 字）。
 *    ③⚠️ **編碼過或衍生的形不在射程內**（Codex #538 r4：把內容轉 base64／hex／雜湊再印，
 *      字面比對抓不到）。**這裡不宣稱關門**——真正結構性的保證在父行程那一側：
 *      子行程回去的診斷只收封閉代碼（`lib/pdf-isolate.js` 的 `KNOWN_DIAG`），
 *      所以「內容經由診斷通道流到營運日誌」這條路是關著的；本函式的 console.error
 *      只在**本機行程**看得到（LOCAL 是使用者自己的終端機、HOSTED 是子行程的 stderr，不轉印）。
 * @param {any} reader @param {string} why
 */
async function cancelStream(reader, why) {
  try {
    await reader.cancel(new Error(why));
  } catch (e) {
    parseDiag.add(PARSE_DIAG.CANCEL_FAILED);
    // ⚠️ 措辭要準（#538 自審 r3）：串流**自己**先壞掉時，cancel 也會被拒——那時上游其實已經沒了，
    //    寫死「資源不會被釋放」會把一個回聲講成新的災情。只說事實：取消沒有正常完成。
    console.error('[parse-limits] 取消 pdfjs 串流沒有正常完成'
      + '（串流本身若已經出錯，這通常是那個錯的回聲；否則上游資源可能不會被釋放）：',
      String(e?.message || e).slice(0, 200));
  }
}

/**
 * 檢查頁數。超過就 throw 帶 400 的錯（＝使用者層錯誤，路由會回原味訊息）。
 * @param {number} pages @param {string} what 檔案種類（給訊息用）
 */
export function assertPageLimit(pages, what) {
  if (Number(pages) > MAX_PDF_PAGES) {
    throw Object.assign(
      new Error(`${what}有 ${pages} 頁，超過可解析上限 ${MAX_PDF_PAGES} 頁。請確認檔案正確；正常的對帳單不會這麼多頁。`),
      { status: 400, code: 'pdf_too_many_pages' });
  }
}

/**
 * 累加文字節點數並在超標時 throw。回傳新的累計值，呼叫端自己保存。
 * ⚠️ 要在**逐頁迴圈裡**呼叫——等整份讀完才檢查就沒有意義了（記憶體早就吃光）。
 * @param {number} sofar @param {number} add @param {string} what @returns {number}
 */
export function countTextItems(sofar, add, what) {
  const total = sofar + add;
  if (total > MAX_PDF_TEXT_ITEMS) {
    throw Object.assign(
      new Error(`${what}的內容量異常龐大（文字節點超過 ${MAX_PDF_TEXT_ITEMS.toLocaleString('en-US')} 個），已停止解析以免拖垮服務。請確認檔案正確。`),
      { status: 400, code: 'pdf_too_many_items' });
  }
  return total;
}

/**
 * IB Flex XML 的原始大小上限。
 * ⚠️ 為什麼不靠 body 上限就好：XML 解析後的物件通常是原文的數倍大，
 * 15MB 的 XML 展開成物件可能要幾百 MB——**擋在解析之前**才有意義。
 * @param {string} xml
 */
export function assertXmlSize(xml) {
  const len = String(xml || '').length;
  if (len > MAX_IB_XML_CHARS) {
    throw Object.assign(
      new Error(`IBKR 報表過大（${Math.round(len / 1024 / 1024)} MB），超過可解析上限。請把 Flex Query 的期間縮短再同步。`),
      { status: 400, code: 'xml_too_large' });
  }
}

/**
 * 列數上限（IB 成交紀錄／現金交易）。**只在超過時 throw**，不截斷——
 * 截斷會讓使用者以為同步完整，其實少了一段（靜默失真是本專案的頭號禁忌）。
 * @param {number} rows @param {string} what
 */
export function assertRowLimit(rows, what) {
  if (Number(rows) > MAX_IB_ROWS) {
    throw Object.assign(
      new Error(`IBKR 報表的${what}有 ${rows} 筆，超過單次可處理上限 ${MAX_IB_ROWS.toLocaleString('en-US')} 筆。請把 Flex Query 的期間縮短、分批同步。`),
      { status: 400, code: 'ib_too_many_rows' });
  }
}

/** 回應過大的統一錯誤（400＝使用者層，路由會回原味訊息）。 @param {number} bytes */
function xmlTooLarge(bytes) {
  return Object.assign(
    new Error(`IBKR 報表過大（${Math.round(bytes / 1024 / 1024)} MB），超過可解析上限。請把 Flex Query 的期間縮短再同步。`),
    { status: 400, code: 'xml_too_large' });
}

/**
 * 把 fetch 的回應讀成字串，**邊收邊數、超標立刻中止**。
 *
 * ⚠️ 為什麼不能用 `await res.text()`（原本就是）：那會把「任意大小」的回應先整包放進記憶體，
 * 之後 `assertXmlSize` 才有機會看到它——**檢查得太晚**。實測 1GB 的回應：
 *   `res.text()` → 行程 RSS 1.8GB，而且丟出來的是 V8 的
 *                  「Cannot create a string longer than 0x1fffffe8 characters」（沒有 status、沒有原因）
 *   本函式       → 56ms、RSS 157MB、乾淨的 400
 *
 * ⚠️ 解碼要用 `new TextDecoder()`：`res.text()` 的語意是「一律 UTF-8 解碼**並吃掉開頭的 BOM**」。
 * `Buffer.concat(...).toString('utf8')` 不會吃掉 BOM，BOM 留在字串最前面會害 XML 解析失敗。
 *
 * @param {any} res @param {AbortController=} ctrl 有的話超標時順便中斷連線
 * @returns {Promise<string>}
 */
export async function readCappedText(res, ctrl) {
  if (!res.body) return '';
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IB_XML_BYTES) {   // 最便宜的那一刀：連 body 都不用讀
    await res.body.cancel().catch(() => {});
    throw xmlTooLarge(declared);
  }
  /** @type {Uint8Array[]} */
  const chunks = [];
  let bytes = 0;
  for await (const chunk of /** @type {any} */ (res.body)) {
    bytes += chunk.byteLength;
    if (bytes > MAX_IB_XML_BYTES) { ctrl?.abort(); throw xmlTooLarge(bytes); }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** IB Flex 報表裡「一列資料」的標籤，與它在錯誤訊息裡的名字。
 * 只列**會隨期間線性長大**的節點——這些才是「報表變大」的來源。 */
const IB_ROW_TAGS = /** @type {[string, string][]} */ ([
  ['Trade', '成交紀錄'],
  ['CashTransaction', '現金交易'],
  ['OpenPosition', '持倉'],
  ['CashReportCurrency', '現金彙總列'],
]);

/**
 * 在原始 XML 字串上數列數。`<Trade` 後面不一定是空白（也可能換行或直接 `/>`），
 * 所以用字元類別 `[\s/>]` 收尾——只認 `<Trade ` 會在 IB 換一種排版時**默默數不到**，
 * 上限就等於沒設（靜默失真是本專案的頭號禁忌）。
 * `<Trades>` 這種容器標籤不會被誤數（`Trade` 之後是 `s`，不符合字元類別）。
 * @param {string} xml @param {string} name @returns {number}
 */
export function countXmlRows(xml, name) {
  const re = new RegExp(`<${name}[\\s/>]`, 'g');   // 線性掃描，沒有回溯爆炸的可能
  let n = 0;
  while (re.exec(xml) !== null) n++;
  return n;
}

/**
 * **在 parse 之前**用原始 XML 檢查列數上限。
 *
 * ⚠️ 為什麼不能等 `parser.parse()` 跑完再數（原本就是這樣）：
 *  ① fast-xml-parser 沒有串流模式，`parse()` 會把整份 XML 展開成 JS object——展開後通常是原文的數倍大，
 *     等我們拿到陣列 `.length` 時記憶體已經吃下去了（實測 38.5MB 的 XML → RSS 491MB）。
 *  ② 原本只數 `CashTransaction`／`Trade`，**`OpenPosition` 完全沒數**：20 萬筆持倉（20.7MB XML）暢行無阻。
 *  ③ 原本是**每份 statement 各自數**：10 份 × 各 3 萬筆 Trade ＝總量 30 萬筆，每一份都沒超過 5 萬，
 *     全部放行。這裡數的是**整份報表的總量**。
 * @param {string} xml
 */
/**
 * 數整份 XML 的元素總數（開標籤的個數）。線性掃描、不用正規表示式（沒有回溯爆炸風險）。
 * 只認 `<` 後面接字母的位置——`</close>`、`<?xml`、`<!--` 都不算。
 * @param {string} xml @returns {number}
 */
export function countXmlElements(xml) {
  let n = 0;
  for (let i = 0; i < xml.length; i++) {
    if (xml.charCodeAt(i) !== 60) continue;          // '<'
    const c = xml.charCodeAt(i + 1);
    // A-Z(65-90) / a-z(97-122) / '_'(95)：XML 名稱的合法開頭
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) n++;
  }
  return n;
}

/**
 * 元素總數上限——**與標籤名無關**，所以任何未來新增的 Flex 區段自動被涵蓋。
 * @param {string} xml
 */
export function assertXmlElementLimit(xml) {
  const n = countXmlElements(xml);
  if (n > MAX_IB_XML_ELEMENTS) {
    throw Object.assign(
      new Error(`這份 IB 報表的內容太多（${n.toLocaleString()} 個項目，上限 ${MAX_IB_XML_ELEMENTS.toLocaleString()}）。` +
        '請把 Flex Query 的期間縮短，分批同步。'),
      { status: 400, code: 'ib_too_many_elements' });
  }
  return n;
}

export function assertXmlRowLimits(xml) {
  const s = String(xml || '');
  for (const [tag, what] of IB_ROW_TAGS) assertRowLimit(countXmlRows(s, tag), what);
}

// ---- 連線層逾時（slowloris 防線，2026-07-28）--------------------------------
// slowloris＝「慢速連線攻擊」：不送大量資料，而是**故意送得很慢**——宣告一個很大的
// Content-Length 卻每幾秒才滴一個位元組，或把 HTTP header 分成幾百次送。
// 每一條這種連線幾乎不花頻寬，卻會佔住伺服器一個連線與一份緩衝區；開幾百條就把服務癱瘓。
// Node 內建的 `headersTimeout`(60s)／`requestTimeout`(300s) 太寬鬆，HOSTED 收緊。
//
// ⚠️ **只收緊 HOSTED**：LOCAL 只聽 127.0.0.1、只有你自己在用，收緊只會在「上傳一份大備份
// 剛好硬碟很慢」時誤殺自己。

/** 送完 HTTP header 的寬限（秒→毫秒）。header 本來就該一次送完，20 秒非常寬鬆。
 * **這一條才是真正的 slowloris 防線**（把 header 拆成幾百次慢慢送）；它與 body 的傳輸速度無關，
 * 所以可以收得很緊而不會誤殺任何人。⚠️ 必須小於 requestTimeout，否則 Node 會用大的那個當實際上限。 */
export const HOSTED_HEADERS_TIMEOUT_MS = 20_000;

/** 我們願意支援的**最慢上傳速度**。requestTimeout 不該憑感覺訂，它是這個數字除出來的結果。
 * 200 KiB/s ≈ 1.6 Mbit/s ＝ 訊號不好的行動網路／飯店 Wi-Fi 大致的下限。 */
export const MIN_UPLOAD_BYTES_PER_SEC = 200 * 1024;

/**
 * 整個請求（含 body）送完的寬限。
 *
 * ⚠️ **這不是 idle timeout，是「收完整個 request 的總時間」**——連線全程都有資料在流也照殺。
 * 所以它其實是一條「隱形的最低上傳速度規定」：`最大 body ÷ requestTimeout`。
 * 舊值 120 秒配上 50MB 的備份上限＝要求持續 437 KB/s（3.5 Mbit/s）；實測 300 KB/s 的上傳
 *（50MB 需要 171 秒）在 **120.0 秒**被切斷、只收到 36MB 回 408——**正當的大備份還原被誤殺**。
 *
 * 新值＝`50MiB ÷ MIN_UPLOAD_BYTES_PER_SEC(200KiB/s)` ＝ 256 秒，取整到 270 秒（4.5 分）。
 * 放寬它為什麼可以接受：
 *  ① slowloris 的本體是 header，由 `HOSTED_HEADERS_TIMEOUT_MS`(20s) 擋著，不受影響。
 *  ② 會吃記憶體的大 body 端點在 HOSTED 都在 **authGate 之後**，未登入流量根本進不到 parser。
 *  ③ 再加上每帳號 5 分鐘 30 次的速率限制——**尖峰記憶體是「速率上限 × body 上限」決定的，
 *     跟 requestTimeout 無關**；放寬只延長「佔著連線」的時間，不會讓尖峰變高。
 *
 * 註：Node 是在 `connectionsCheckingInterval`（預設 30 秒）的巡邏裡才檢查，
 * 所以實際切斷落在 [270s, 300s) ——只會比帳面更寬鬆，不會更緊。
 */
export const HOSTED_REQUEST_TIMEOUT_MS = 270_000;
/** 閒置的 keep-alive 連線多久後關閉。 */
export const HOSTED_KEEPALIVE_TIMEOUT_MS = 10_000;

/**
 * 對 http.Server 套用 HOSTED 的連線逾時。**回傳實際套用的值供考題檢查**。
 * @param {any} server @returns {{headersTimeout: number, requestTimeout: number, keepAliveTimeout: number}}
 */
export function applyHostedTimeouts(server) {
  server.headersTimeout = HOSTED_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HOSTED_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = HOSTED_KEEPALIVE_TIMEOUT_MS;
  return {
    headersTimeout: server.headersTimeout,
    requestTimeout: server.requestTimeout,
    keepAliveTimeout: server.keepAliveTimeout,
  };
}
