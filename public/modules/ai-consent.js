// @ts-check
// AI 解析路線的**前端判準與文案唯一住所**（P1b-2）。純函式、零 DOM、零 app.js——
// `cashflow.js` 頂層 import `app.js`（node 載不動整頁），把判準留在那裡就永遠只能靠形狀掃描；
// 抽到這裡才有真正的行為考題（`test/ai-consent.test.js`）。只 import `esc`（鐵則 3 的承重點）。
//
// 四條硬性前提（拍板／契約，改這個檔前先讀 docs/contracts/income-expense.md「AI 解析路線 P1b」節）：
// 1. **旗標只由呼叫端明給**＝`previewBody` 只在呼叫端明給 `useAi === true` 時才放旗標；
//    本模組**不持有任何狀態**（無模組層變數、無 storage）。
//    ⚠️ 「要不要先問」是**設定**（`aiAskBeforeSend`），不是本模組的前提：William 2026-08-13
//    把預設翻成**不問、直接送**（取代 2026-08-12 的「每次都問」）。判準在 `shouldAskBeforeSend`，
//    讀不到設定時當成「要問」（fail-closed）。
// 2. **AI 入口只給「範本認不得」**（`code:'bank_unrecognized'`）——對帳閘紅（★6 禁止匯入）刻意無 code，
//    `shouldOfferAi` 必須對它回 false，否則 UI 會在「數字對不上」的畫面上請 AI 重試一次。
// 3. **票只活在單次預覽的閉包**：`applyBody` 從 preview 回應讀 `aiTicket`，本模組不存、呼叫端也不許存
//    （A 帳單的票被 B 帳單的 apply 撿去用＝後端完全不看你送的檔案，把 A 的數字寫進去還回 200）。
// 4. **文案不得誇大、且必須模式中立**（r1#2）：不寫「不會上傳／已限速／保證正確」；費用一律講級距並
//    註明不是報價。⚠️ 同意窗在雲端版**也會開**（停止線是按下去之後才擋），所以窗裡**一個字都不可以
//    假設資料落在使用者自己的電腦上**——「留在你這台電腦的資料庫裡」在雲端版是假的。
import { esc } from './html-escape.js';

/** 同意窗的標題／送出鈕／供應商標籤／費用級距（文案單一住所）。 */
/** 送 AI 之前要不要先跳確認窗？
 *
 * ⚠️ **預設不問**（William 2026-08-13 拍板，取代 2026-08-12 的「每次都問」）：他的方向是
 * 「介面簡單、好用、好理解」，而這條路用的是他自己的鑰匙、自己的資料、單機自用。
 * 設定頁留一個開關可以打開——**能力沒有被拿掉，只是預設翻面**（多人版要恢復詢問時有現成的地方）。
 *
 * ⚠️ **欄位讀不到 vs 讀不到設定，是兩件事**：
 * ・欄位不存在（舊資料庫還沒有這個欄）＝照新預設「不問」。
 * ・**整包設定拿不到**＝當成「問」——那時我們**不知道**使用者選了什麼，
 *   而猜錯的代價是「沒問就把帳單送出去、還花了錢」。不知道的時候往保守那邊倒。
 *
 * ⚠️ **兩層都守**（2026-08-14）：原本只有呼叫端 `askBeforeSendAi` 的 `catch` 在守，
 * 那擋得住「API 丟例外」，擋不住「API 好端端地回了 `null`／回了不是物件的東西」——
 * 那時 `settings?.x === true` 是 `false`＝直接送。兩種都是「不知道使用者選了什麼」，
 * 應該同一個答案，所以判準自己也 fail-closed。
 * @param {any} settings
 */
export function shouldAskBeforeSend(settings) {
  // 不是物件＝根本沒拿到設定（null／undefined／字串／數字）⇒ 保守：問。
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return true;
  const v = settings.aiAskBeforeSend;
  // ⚠️ 三分法（r1#2）：欄位**缺席**＝還沒改過設定＝新預設（不問）；明確 false＝不問；
  //    明確 true＝問；**欄位在、卻不是布林**＝資料壞了、不知道使用者要什麼 ⇒ 保守：問。
  //    上一版把「壞型別」與「缺席」混成同一個 false——壞資料變成「直接外送」，方向錯。
  if (v === undefined) return false;
  if (v === true) return true;
  if (v === false) return false;
  return true;
}

/** 開關存檔**失敗後**，畫面該顯示什麼（#455 r5#1）。
 *
 * ⚠️ 不可用「!want」推定資料庫還是舊值：後端是先寫入再回應——寫入可能已成功、
 * 只是回應沒回來。唯一誠實的做法＝**向後端重新核對**。
 *
 * ⚠️ 方向與 `shouldAskBeforeSend` **相反、而且應該相反**：送出路徑的保守＝「問」
 * （保住錢）；**顯示路徑的保守＝「不宣稱受保護」**（checked=false）——畫面寫著
 * 「會先問你」而資料庫其實不會問，是最糟的假保證。核對不到（再度失敗）＝顯示 false。
 * @param {() => Promise<any>} fetchSettings
 * @returns {Promise<boolean>} checkbox 該顯示的狀態
 */
export async function askToggleDisplayAfterSaveFailure(fetchSettings) {
  try { return (await fetchSettings())?.aiAskBeforeSend === true; }
  catch { return false; }
}

export const AI_CONSENT_TITLE = '要請 AI 幫忙讀這份帳單嗎？';
export const AI_CONSENT_SUBMIT_LABEL = '同意，送出去讀';
/** 送出後鈕上的字（AI 解析實測要 5–6 秒；只把鈕變灰看起來像當掉）。 */
export const AI_CONSENT_BUSY_LABEL = '正在送出…（需要 AI 讀取時通常一分鐘內，遇到仲裁會再久一點）';   // r1#2：未來式——HOSTED 停止線/未設鑰匙的路零 AI 呼叫，「AI 讀取中」＝#455 那型假進度；G21：雙模式皆真
export const AI_PROVIDER_LABEL = 'Anthropic（做 Claude 的 AI 公司）';
/** ⚠️ 費用級距的唯一住所。出處＝`docs/parser-generalization-plan.md` §六 的計算基礎（該處自己標
 * 「正式數字待 ★3 實測」）。⏰ 絆線：**真的用 AI 跑過幾份帳單、看到 Anthropic 帳單上的實際金額之後**，回頭校準這句。⚠️ P1b-3（攔截率）**不是**那個實測——它是零成本的故障注入，一個 token 都沒花，校準不了費用。
 * 不寫「每百萬 token 幾美元」「模型名」「至多兩發」——那些常數不回前端（鐵則 10：寫死的數字自己會漂）。 */
export const AI_COST_HINT = '費用記在你自己的 Anthropic 帳戶裡（實際金額以他們的帳單為準）';
/** 預覽窗過期／已用過時的白話（票是一次性＋短效）。 */
export const AI_PREVIEW_LOST_TEXT = '這份 AI 預覽已經過期或已經匯入過了——請重新上傳預覽一次，確認內容無誤再匯入。';

/**
 * **上傳檔案的不可變快照**（r1#1）。`cashflow.js` 的 `file` 是 onchange 會改寫的外層變數：
 * 選了 A 按預覽、**請求在途時改選 B**，b64 已經綁定 A，但之後任何 `file?.name` 讀到的是 B——
 * 同意窗於是顯示「送出 B」、按下去送的卻是 A。使用者從未對「把 A 送出去」表示同意。
 * 修法＝在第一次 await **之前**把「檔案物件＋檔名」一起凍進同一個快照，之後三條路只認它。
 * @param {any} fileLike @returns {{file:any, fileName:string}|null}
 */
export function snapshotUpload(fileLike) {
  if (!fileLike) return null;
  return Object.freeze({ file: fileLike, fileName: String(fileLike.name || '') });
}

/**
 * 這個錯誤可不可以提供「請 AI 讀一次」的入口？
 * ⚠️ **只認 `bank_unrecognized`**（前提 2）：對帳閘紅是 400 **無 code**，寫成 `!err.code` 或
 * `err.code !== 'pdf_password'` 都會讓「數字對不上」的帳單長出 AI 入口＝違反 ★6。
 * ⚠️ `Object.hasOwn`＝只認自有屬性（鐵則 3.5，同 `bankPasswordLabel`／`exportNotice` 前例）。
 * @param {any} err @returns {boolean}
 */
export function shouldOfferAi(err) {
  if (!err || typeof err !== 'object') return false;
  return Object.hasOwn(err, 'code') && err.code === 'bank_unrecognized';
}

/**
 * 預覽請求的 body。**`useAi` 嚴格布林**：只有呼叫端明給 `true` 才放這個 key——
 * 寫成 `{ useAi: !!useAi }` 會讓每一次上傳都帶旗標（後端只認 `=== true`，但那時「有沒有同意」
 * 就變成後端在判、前端的確認窗形同虛設）。缺席＝零 AI 呼叫。
 * `password` 只要是字串就放（**含空字串**＝完全複製 P0.5 的既有行為，不趁機改判準）。
 * @param {{data:string, password?:string, useAi?:boolean}} o
 */
export function previewBody({ data, password, useAi }) {
  /** @type {Record<string, any>} */
  const body = { data };
  if (typeof password === 'string') body.password = password;
  if (useAi === true) body.useAi = true;
  return body;
}

/**
 * 套用請求的 body。兩條路刻意不同：
 * - **AI 路線**（preview 回 `engine:'ai'`）＝只送 `{useAi:true, aiTicket}`：**不送 data、不送 password**
 *   （後端憑票取回 preview 那份已驗收答案，不解析檔案也不碰密碼池——契約字面在前端也要成立）。
 *   票不見＝回 `null`，呼叫端要引導重新預覽，**絕不可退回「送 data 讓它自己再解一次」**。
 * - **配方路線**（preview 回 `engine:'recipe'`，P2-2）＝只送 `{aiTicket}`：同 AI 的「所見即所得」
 *   紀律（憑票取回 preview 那份答案與選版）；票不見＝回 `null` 引導重新預覽。不送 useAi。
 * - **模板路線**＝照舊 `{data, password}`，且**不得出現 `aiTicket` 這個 key**：
 *   `String(undefined)==='undefined'` 是 truthy，後端 `opts.aiTicket && !ticket` 會把正常匯入 400 擋死。
 * `skipSimilar`＝「這次跳過疑似重複」（William 2026-08-14）：**嚴格 true 才放 key**——
 * 同 useAi 的紀律，undefined/'true' 這類值一律不出現在 body（後端也只認 === true，雙層嚴格）。
 * @param {any} preview 預覽回應 @param {{data:string, password?:string, skipSimilar?:boolean}} o
 * @returns {Record<string, any>|null}
 */
export function applyBody(preview, { data, password, skipSimilar }) {
  if (preview && preview.engine === 'ai') {
    const ticket = preview.aiTicket;
    if (typeof ticket !== 'string' || !ticket) return null;
    /** @type {Record<string, any>} */
    const ai = { useAi: true, aiTicket: ticket };
    if (skipSimilar === true) ai.skipSimilar = true;
    return ai;
  }
  // 配方路線（P2-2 預審 G2）：帶票＝「所見即所得」對配方同樣成立（後端憑票取回 preview 那份
  // parsed 與選版，不重跑選版）。票不見＝回 null 引導重新預覽（與 AI 路線同紀律；配方雖零元，
  // 重解可能因 db 已變而選到**另一版**——那正是票要擋的病）。不帶 useAi（沒有要同意 AI 的事）。
  if (preview && preview.engine === 'recipe') {
    const ticket = preview.aiTicket;
    if (typeof ticket !== 'string' || !ticket) return null;
    /** @type {Record<string, any>} */
    const body = { aiTicket: ticket };
    if (skipSimilar === true) body.skipSimilar = true;
    return body;
  }
  /** @type {Record<string, any>} */
  const body = { data };
  if (typeof password === 'string') body.password = password;
  if (skipSimilar === true) body.skipSimilar = true;
  return body;
}

/** 這個錯誤碼代表「這份預覽已經沒救了」＝套用鈕不可解鎖（解鎖只會讓使用者再撞一次同樣的牆）。
 * @param {any} code */
export function isAiTicketDeadCode(code) {
  return code === 'ai_ticket_invalid' || code === 'ai_ticket_required';
}

/**
 * 同意窗的內文。⚠️ 彈窗裡**絕不可放 `.info-link`**（`#modal-root` 只有一格，開說明窗會把同意窗
 * 整個蓋掉）——要展開的細節一律用 `<details>`。`fileName` 是使用者的檔名＝必經 `esc`。
 * @param {{fileName?: string}} o
 */
export function aiConsentBodyHtml({ fileName = '' } = {}) {
  const name = esc(String(fileName || '（未命名檔案）'));
  return `
<p>本 app 認不出這份帳單的版面，你想請 AI 幫忙讀讀看嗎？</p>
<ul style="margin:10px 0 12px;padding-left:18px;line-height:1.9">
  <li><b>送出內容</b>：${name}（抽出來的文字，不是 PDF 檔本身）</li>
  <li><b>送去哪裡</b>：${AI_PROVIDER_LABEL}</li>
  <li><b>大概多少</b>：${AI_COST_HINT}</li>
</ul>
<details>
  <summary>這到底送出去什麼？會留多久？</summary>
  <ul style="margin:8px 0 0;padding-left:18px;line-height:1.9">
    <li>送出去的是：
      <ul style="margin:4px 0 0;padding-left:18px">
        <li>帳單裡的帳號末碼</li>
        <li>每一筆的日期／金額／摘要／餘額</li>
      </ul>
      <div style="margin:4px 0 0">等於把對帳單影印一份、寄去請人幫忙看——內容就是你帳單上本來就有的那些。</div>
    </li>
    <li>不會送出：
      <ul style="margin:4px 0 0;padding-left:18px">
        <li>PDF 檔本身</li>
        <li>帳單密碼</li>
        <li>這個 app 裡的任何其他資料</li>
      </ul>
    </li>
    <li>依供應商目前的<b>商用 API 預設政策</b>：送過去的內容不會被拿去訓練模型，也會在一段時間後刪除。</li>
    <li>⚠️ 但這是<b>預設值、不是我們能保證的事</b>——這條路用的是<b>你自己的 API 帳戶</b>，如果那個帳戶另外同意過資料使用、或有另外的合約條款，實際情形可能不一樣。以你自己的帳戶設定與供應商官方公告為準。</li>
    <li>讀出來的結果會<b>先回到畫面上讓你核對</b>；那份暫時放在伺服器的記憶體裡（程式重開就沒了），要等你按下匯入，才寫進這個 app 自己的資料裡。</li>
    <li>預設會讓<b>兩個 AI 各自獨立讀一遍</b>互相核對（費用兩發起跳；讀出來不一致會再請第三個 AI 仲裁、多一發）。在設定頁關掉「雙讀」的話則是先讀一次、對不平才換更強的模型再讀一次。</li>
    <li>這個問句只確認<b>這一次</b>——同意只算這一次，不會被記住。之後每次上傳要不要先問，由設定裡的「送給 AI 之前先問我一次」決定（<b>沒打開＝之後直接送、不再問</b>）。</li>
    <li>不同意完全沒關係：這份改成手動記帳就好，其他功能一切照常。</li>
  </ul>
</details>`;
}

/**
 * 預覽窗頂端的「這份是 AI 讀的」徽章。模板路線回空字串（形狀不對／缺席也回空，不炸畫面）。
 * ⚠️ **盲點清單（「驗不到什麼」）目前就在 `<details>` 收合區裡**（William 2026-08-13：介面少字、
 * 想知道再點開）。⚠️ 但**「這一份是 AI 讀的」與「請確認哪幾欄」必須留在收合區外**——那兩句是
 * 「要不要相信這份預覽」的前提，藏起來等於沒講。盲點清單則是細節，收起來合理。
 */
/** 模型代號 → 人看得懂的名字（畫面只給人看；代號留在後端與 log）。查不到就原樣顯示。 @param {string} id */
export function modelDisplayName(id) {
  const raw = String(id || '');
  if (!raw) return '';
  const m = raw.match(/^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d+))?/);
  if (!m) return raw;
  const family = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }[m[1]] || m[1];
  return `Claude ${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** 配方徽章（P2-3）：engine:'recipe' 的預覽——講「誰讀的、為什麼免費、驗算照跑」。
 * 與 AI 徽章互斥（engine 只會是一種）；文案鐵則同 AI（不得出現保證正確/免費以外的誇大）。
 * @param {any} preview */
export function recipePreviewBadgeHtml(preview) {
  if (!preview || typeof preview !== 'object' || preview.engine !== 'recipe') return '';
  return `
<div class="card" style="margin-bottom:12px;padding:12px 14px">
  <p style="margin:0 0 6px"><b>這一份是「版面規則卡」讀出來的帳單預覽。</b>（這個版面之前用 AI 讀過一次、規則卡是那次順手學下來的——本次<b>零費用、內容零外送</b>）</p>
  <p class="muted" style="margin:0;font-size:12px;line-height:1.8">驗算照跑、標準與 AI 讀的一樣嚴（整份數學軋不平就不會給你看）。規則卡若跟不上版面改版，會自動退回上一版重讀；都讀不動才會再請 AI。</p>
</div>`;
}

export function aiPreviewBadgeHtml(preview) {
  if (!preview || typeof preview !== 'object' || preview.engine !== 'ai') return '';
  const model = esc(modelDisplayName(preview.aiModel));
  // P2-4 雙讀徽章句（裁示⑦）：只講事實、不加保證——「一致」只代表兩份獨立答案在錢欄位上相同，
  // 驗算照跑；仲裁＝兩讀不一致、由第三讀決定採用哪份。
  const dual = preview.dualRead === 'agree'
    ? '<p class="muted" style="margin:0 0 6px;font-size:12px">🔁 雙讀一致：兩個 AI 各自獨立讀了一遍，會影響錢的欄位全部相同。</p>'
    : preview.dualRead === 'arbitrated'
      ? '<p class="muted" style="margin:0 0 6px;font-size:12px">🔁 三讀仲裁：前兩讀不一致，第三個 AI 獨立讀後，<b>會影響錢的欄位</b>與這一份完全一致（文字欄寫法可能仍不同，見下）——仍請你照下面清單核對一次。</p>'
      : preview.dualRead === 'attested'
        ? '<p class="muted" style="margin:0 0 6px;font-size:12px">🔁 三讀仲裁：其中一讀沒讀出合法答案，第三個 AI 獨立讀後，<b>會影響錢的欄位</b>與這一份完全一致——仍請你照下面清單核對一次。</p>'
        : '';
  // P2-4b（William 2026-08-17 裁示）：文字欄寫法差異不觸發仲裁、採中選那份（一致路＝Opus、仲裁路可能＝Sonnet
  //  ——寫死「採 Opus」＝r2#2 的畫面說謊）——要誠實註明（列欄位不列值、動態模型名）
  // 仲裁差異欄名現形（2026-08-18）：兩份初讀在錢欄位差在哪幾欄——這是「請特別核對哪幾處」的素材，
  // 依家規放收合區外。只列欄名不列值（後端 diffs 本來就只帶欄位路徑）；仲裁已裁定＝訊息是「請核對」
  // 不是「有錯」。attested 不會有這個欄位（沒有第二份答案可比）。
  // ⚠️ 畫面自己也守（Grok r0）：①只在 dualRead==='arbitrated' 才畫——句子講的是「兩份初讀不一致、
  //   第三讀裁定」，來源若誤把 diffs 掛到 agree/attested，沒有這道閘畫面就跟著說謊；②非字串濾掉
  //   （join 會把物件唸成 [object Object] 的怪句）；③單一欄名截長（esc 只賭了逃逸、沒賭長度——
  //   後端理論上只給短白名單欄名，畫面不賭這件事）。
  const ddList = preview.dualRead === 'arbitrated' && Array.isArray(preview.dualReadDiffs)
    ? [...new Set(preview.dualReadDiffs.filter((/** @type {any} */ x) => typeof x === 'string' && x))].map((x) => x.length > 24 ? `${x.slice(0, 24)}⋯` : x)
    : [];
  const dd = ddList.length
    ? `<p class="muted" style="margin:0 0 6px;font-size:12px">⚠️ 兩份初讀不一致的欄位：<b>${esc(ddList.slice(0, 6).join('、'))}</b>${ddList.length > 6 ? `⋯等 ${ddList.length} 處` : ''}——第三讀已裁定採用這一份，請在下方預覽<b>特別核對這幾處</b>。</p>`
    : '';
  const tv = Array.isArray(preview.dualReadTextVariance) && preview.dualReadTextVariance.length
    ? `<p class="muted" style="margin:0 0 6px;font-size:12px">✏️ 兩讀在文字欄寫法不同（${esc([...new Set(preview.dualReadTextVariance)].slice(0, 5).join('、'))}${preview.dualReadTextVariance.length > 5 ? '⋯' : ''}）——不影響金額核對，已採用${esc(modelDisplayName(preview.aiModel) || '中選那份')}的寫法。</p>`
    : '';
  return `
<div class="card" style="margin-bottom:12px;padding:12px 14px">
  <p style="margin:0 0 6px"><b>這一份是 AI 幫你讀出來的帳單預覽。</b>${model ? `（使用的模型：${model}）` : ''}</p>
  ${dual}${dd}${tv}
  <p class="muted" style="margin:0;font-size:12px;line-height:1.8">請確認「機構名」、「帳號」、「日期」、「摘要」有沒有讀錯。</p>
  <details style="margin-top:8px">
    <summary style="font-size:12px">AI 讀的，跟平常讀的差在哪？</summary>
    <ul class="muted" style="margin:8px 0 0;padding-left:18px;font-size:12px;line-height:1.9">
      <li>一樣要通過驗算才准匯入：拿<b>台幣帳戶</b>的明細，把相鄰兩筆的餘額扣起來看接不接得上；帳單上如果也印了那個帳戶的概要餘額，最後一筆會再跟它對一次。對不上就整份退回。</li>
      <li>⚠️ <b>這道驗算看不到的（不只這些）</b>——不過現在多了兩道幫手（<b>接地檢查</b>＝答案上的每個<b>金額、餘額、合計</b>數字都要在帳單上找得到（日期刻意不查——帳單印的日期格式（例如民國年）轉成標準寫法後字面就不同了，逐字對不起來）；<b>合計交叉驗證</b>＝帳單自己印的筆數與出入合計要對得上），哪幾種擋得住、什麼情況仍看不到，寫在各條後面：①每個帳戶的<b>第一筆</b>——驗算是拿它的<b>餘額</b>去比下一筆，它的<b>金額與方向</b>都沒有被驗到（方向讀反＝<b>收入被記成支出</b>）；<b>整筆漏掉也一樣</b>→<b>金額</b>抄錯：錯的數字不在帳單上＝接地擋、帳單有印合計＝合計也擋；<b>方向讀反與整筆漏掉</b>：只有合計擋得住——沒印合計＝仍看不到 ②<b>外幣</b>明細（本來就不計入台幣收支；外幣帳戶餘額仍會照帳單更新）→金額抄錯、錯的數字不在帳單上＝會被接地擋下 ③<b>這期沒有往來的帳戶</b>（只出現在概要、沒有明細可驗，但餘額仍會更新或新建帳戶）→概要餘額抄錯、錯的數字不在帳單上＝會被接地擋下 ④金額和餘額<b>一起</b>被抄成剛好自洽的另一組數字→湊出來的數字不在帳單上＝接地擋下；<b>恰好都是帳單他處印過的數字、而且帳單沒印合計（或合計也被一起抄成自洽）＝仍看不到</b> ⑤某筆金額抄錯、<b>而且同一筆的餘額是空白</b>→同④ ⑥一筆支出和一筆收入被<b>併成一筆淨額</b>（餘額照樣接得上，但收入與支出的總額都錯了）→淨額數字不在帳單上、或帳單有印合計＝擋下；兩個條件都不成立＝仍看不到 ⑦<b>整個帳戶被漏讀</b>（沒讀到的東西沒有數字可以驗）→帳單有印整份合計＝擋下；沒印＝仍看不到 ⑧台幣與外幣<b>互相認錯</b>——認成外幣＝那個帳戶的交易<b>一筆都不會進帳</b>；認成台幣＝<b>外幣數字被當成台幣入帳</b>。兩種畫面都會說驗算通過，<b>三道防線都看不到＝最重的已知盲點</b> ⑨<b>摘要或日期讀錯</b>——金額是對的，但那兩欄是「這筆有沒有匯過」的辨識依據，<b>下次重匯同一份帳單時會被當成新的一筆再記一次</b>；開著「雙讀」時兩個 AI 讀得不一樣會被比對器抓到，<b>兩個都錯得一模一樣才會漏過去</b>。<br>⚠️ <b>這份清單不保證完整</b>——⑤～⑧是 2026-08-13 覆審時才發現的，往後可能還有。所以下面兩張表還是請你自己看一眼，尤其是上面那張「帳戶餘額」。</li>
      <li>台幣帳戶如果<b>有明細卻整組驗不動</b>（例如帳單上根本沒印每一筆的餘額），這一份也不收。這點比內建範本更嚴：內建範本驗不到會照舊放行，AI 讀的驗不到就整份退回。</li>
      <li>你現在看到的這一份，就是按下確認會寫進去的那一份——不會再讀一次、也不會換成別份。這份預覽擺太久、或已經按過一次確認，就會失效；那時請重新上傳預覽一次，數字會重新算。</li>
    </ul>
  </details>
</div>`;
}

/** 錯誤碼 → 前端要補的「下一步」。⚠️ 後端已經白話的句子**原句放行**（同一句寫兩份必漂）；
 * 這裡只補後端不該知道的東西（「去設定頁哪張卡」這種畫面知識）。 */
const AI_ADVICE = Object.freeze({
  ai_no_key: '請到「設定」頁的「AI 解析鑰匙」卡片貼上 API key，再重新上傳一次。',
  ai_auth: '這把鑰匙可能被停用或打錯了，請到「設定」頁的「AI 解析鑰匙」卡片換一把。',
  ai_hosted_off: '這份請改用手動記帳。',
  ai_unavailable: '這是對方服務那邊的狀況，不是你的操作；等幾分鐘再上傳一次就好。',
  ai_truncated: '這份太長了，先用手動記帳；想調整上限的話跟我說一聲。',
  ai_refusal: '換更強的模型也一樣。這份請改用手動記帳。',
  ai_disagree: '訊息裡列的欄位就是幾份答案對不上的地方——這份請改用手動記帳（後端訊息只列欄位、不會回聲你的帳單數字）。',
});
/** 這幾個 code 的後端訊息太技術，整句換成白話（其餘一律原句放行）。 */
const AI_REPLACE = Object.freeze({
  ai_bad_answer: 'AI 交回來的內容不合格式，這份沒有匯入（換更強的模型也一樣）。可以再上傳一次重試；還是不行就先手動記帳。',
  ai_engine_missing: 'AI 這條路沒有接好，這是程式的問題、不是你的操作——請回報給我。',
});

/**
 * 錯誤碼 → 給使用者看的訊息。三條紀律：
 * ①**未知 code／無 code ＝原句照丟**（絕不用「發生錯誤」吃掉訊息——對帳閘紅那句帶著使用者要核對的
 *   數字，吃掉它等於拆掉 ★6 的核對體驗）②後端白話句原句放行、只在後面補「下一步」
 * ③advice **不得**回聲任何帳單欄值（`ai_reconcile_failed` 與答案卷驗收刻意只講欄名與序號）。
 * @param {any} code @param {any} serverMessage
 */
export function aiErrorText(code, serverMessage) {
  const msg = String(serverMessage || '').trim();
  const key = typeof code === 'string' ? code : '';
  if (key && Object.hasOwn(AI_REPLACE, key)) return AI_REPLACE[/** @type {keyof typeof AI_REPLACE} */ (key)];
  const advice = key && Object.hasOwn(AI_ADVICE, key) ? AI_ADVICE[/** @type {keyof typeof AI_ADVICE} */ (key)] : '';
  if (!msg) return advice || '更新失敗';
  return advice ? `${msg}　${advice}` : msg;
}

/**
 * 「範本認不得 → 提供 AI 入口」的編排（相依全注入＝可直接考行為，形狀比照 `cashflow-model.js`
 * 的 `runBankUpload`）。回傳字串是考題的把手：
 * - `'rethrow'`＝不是可以走 AI 的錯（對帳閘紅／密碼錯／其他）⇒ 呼叫端原樣往上丟
 * - `'stale'`＝使用者已經切頁／彈窗換人 ⇒ 什麼都不做
 * - `'offered'`＝排程開同意窗；**排程前與 callback 內各驗一次 `canOpenNext()`**（#445 的兩顆競態：
 *   排程當下還在、執行時已切頁）。
 *
 * ⚠️ **刻意不吐紅字**（William 2026-08-12 裁示）：初版會先 toast 模板的原錯誤（「這份 PDF 看起來
 * 不是台新銀行綜合對帳單」）再開同意窗，但那句是**多餘的重複資訊**——同意窗第一行已經寫「內建的
 * 讀取範本認不得這份對帳單的版面」，而且那句訊息**寫死台新**、在多銀行時代本身就過期了。
 * 按取消＝使用者自己決定不用 AI，不需要再被紅字補一刀。（後端那句訊息保留：它仍是 API 的錯誤內容，
 * 只是不再被搬到畫面上。）
 * @param {{err:any, canOpenNext:() => boolean,
 *          openConsent:() => void, schedule?:(fn:() => void) => void}} o
 * @returns {'rethrow'|'stale'|'offered'}
 */
export function runAiFallback({ err, canOpenNext, openConsent, schedule = (fn) => setTimeout(fn, 0) }) {
  if (!shouldOfferAi(err)) return 'rethrow';
  if (!canOpenNext()) return 'stale';
  schedule(() => { if (canOpenNext()) openConsent(); });
  return 'offered';
}
