// @ts-check
// AI 解析路線的**前端判準與文案唯一住所**（P1b-2）。純函式、零 DOM、零 app.js——
// `cashflow.js` 頂層 import `app.js`（node 載不動整頁），把判準留在那裡就永遠只能靠形狀掃描；
// 抽到這裡才有真正的行為考題（`test/ai-consent.test.js`）。只 import `esc`（鐵則 3 的承重點）。
//
// 四條硬性前提（拍板／契約，改這個檔前先讀 docs/contracts/income-expense.md「AI 解析路線 P1b」節）：
// 1. **每次送 AI 前都要問過使用者**（William 2026-08-12 拍板，不記住同意）＝`previewBody` 只在
//    呼叫端明給 `useAi === true` 時才放旗標；本模組**不持有任何狀態**（無模組層變數、無 storage）。
// 2. **AI 入口只給「範本認不得」**（`code:'bank_unrecognized'`）——對帳閘紅（★6 禁止匯入）刻意無 code，
//    `shouldOfferAi` 必須對它回 false，否則 UI 會在「數字對不上」的畫面上請 AI 重試一次。
// 3. **票只活在單次預覽的閉包**：`applyBody` 從 preview 回應讀 `aiTicket`，本模組不存、呼叫端也不許存
//    （A 帳單的票被 B 帳單的 apply 撿去用＝後端完全不看你送的檔案，把 A 的數字寫進去還回 200）。
// 4. **文案不得誇大、且必須模式中立**（r1#2）：不寫「不會上傳／已限速／保證正確」；費用一律講級距並
//    註明不是報價。⚠️ 同意窗在雲端版**也會開**（停止線是按下去之後才擋），所以窗裡**一個字都不可以
//    假設資料落在使用者自己的電腦上**——「留在你這台電腦的資料庫裡」在雲端版是假的。
import { esc } from './html-escape.js';

/** 同意窗的標題／送出鈕／供應商標籤／費用級距（文案單一住所）。 */
export const AI_CONSENT_TITLE = '要請 AI 幫忙讀這份帳單嗎？';
export const AI_CONSENT_SUBMIT_LABEL = '同意，送出去讀';
/** 送出後鈕上的字（AI 解析實測要 5–6 秒；只把鈕變灰看起來像當掉）。 */
export const AI_CONSENT_BUSY_LABEL = '正在讀取…請稍候';
/** 送出當下的提示（鈕在彈窗裡、視線不一定在那；toast 補一句「還在跑、別重按」）。
 * ⚠️ **不可寫「已送出／AI 正在讀」**（r7）：這句是在**發請求之前**吐的，而 HOSTED 停止線與
 * 「還沒設鑰匙」都會在**任何 AI 呼叫之前**就把整條路擋下（`aiBankRoute` 前兩道）——
 * 那時使用者會同時看到「AI 正在讀」和「尚未設定鑰匙」，等於**謊稱帳單已經外送出去**。
 * 這條線的整個價值就是「畫面說的＝實際發生的」，這句尤其不能破例。 */
export const AI_SENDING_TEXT = '處理中……接下來會把帳單文字送去給 AI 讀，通常幾秒鐘，請稍候（不用重按）';
export const AI_PROVIDER_LABEL = 'Anthropic（做 Claude 的 AI 公司）';
/** ⚠️ 費用級距的唯一住所。出處＝`docs/parser-generalization-plan.md` §六 的計算基礎（該處自己標
 * 「正式數字待 ★3 實測」）。⏰ 絆線：P1b-3 攔截率實測後回頭校準這句。
 * 不寫「每百萬 token 幾美元」「模型名」「至多兩發」——那些常數不回前端（鐵則 10：寫死的數字自己會漂）。 */
export const AI_COST_HINT = '通常是幾塊台幣以內（記在你自己的 Anthropic 帳戶裡；這是級距、不是報價，實際金額以他們的帳單為準）';
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
 * - **模板路線**＝照舊 `{data, password}`，且**不得出現 `aiTicket` 這個 key**：
 *   `String(undefined)==='undefined'` 是 truthy，後端 `opts.aiTicket && !ticket` 會把正常匯入 400 擋死。
 * @param {any} preview 預覽回應 @param {{data:string, password?:string}} o
 * @returns {Record<string, any>|null}
 */
export function applyBody(preview, { data, password }) {
  if (preview && preview.engine === 'ai') {
    const ticket = preview.aiTicket;
    if (typeof ticket !== 'string' || !ticket) return null;
    return { useAi: true, aiTicket: ticket };
  }
  /** @type {Record<string, any>} */
  const body = { data };
  if (typeof password === 'string') body.password = password;
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
    <li>萬一第一次讀出來的數字對不平，系統會自動換更強的模型再讀一次，那次的費用會多一些。</li>
    <li>這個問句<b>每一次上傳都會出現</b>——同意只算這一次，不會被記住。</li>
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

export function aiPreviewBadgeHtml(preview) {
  if (!preview || typeof preview !== 'object' || preview.engine !== 'ai') return '';
  const model = esc(modelDisplayName(preview.aiModel));
  return `
<div class="card" style="margin-bottom:12px;padding:12px 14px">
  <p style="margin:0 0 6px"><b>這一份是 AI 幫你讀出來的帳單預覽。</b>${model ? `（使用的模型：${model}）` : ''}</p>
  <p class="muted" style="margin:0;font-size:12px;line-height:1.8">請確認「機構名」、「帳號」、「日期」、「摘要」有沒有讀錯。</p>
  <details style="margin-top:8px">
    <summary style="font-size:12px">AI 讀的，跟平常讀的差在哪？</summary>
    <ul class="muted" style="margin:8px 0 0;padding-left:18px;font-size:12px;line-height:1.9">
      <li>一樣要通過驗算才准匯入：拿<b>台幣帳戶</b>的明細，把相鄰兩筆的餘額扣起來看接不接得上；帳單上如果也印了那個帳戶的概要餘額，最後一筆會再跟它對一次。對不上就整份退回。</li>
      <li>⚠️ <b>這道驗算看不到的（不只這些）</b>：①每個帳戶的<b>第一筆</b>——驗算是拿它的<b>餘額</b>去比下一筆，它的<b>金額與方向</b>都沒有被驗到（方向讀反＝<b>收入被記成支出</b>，月收支同時失真）；<b>整筆漏掉也一樣</b>（後面的鏈與期末仍然對得上）②<b>外幣</b>明細（本來就不計入台幣收支；外幣帳戶餘額仍會照帳單更新）③<b>這期沒有往來的帳戶</b>（只出現在概要、沒有明細可驗，但餘額仍會更新或新建帳戶）④金額和餘額<b>一起</b>被抄成剛好自洽的另一組數字 ⑤某筆金額抄錯、<b>而且同一筆的餘額是空白</b>⑥一筆支出和一筆收入被<b>併成一筆淨額</b>（餘額照樣接得上，但收入與支出的總額都錯了）⑦<b>整個帳戶被漏讀</b>（沒讀到的東西沒有數字可以驗）⑧台幣與外幣<b>互相認錯</b>——認成外幣＝那個帳戶的交易<b>一筆都不會進帳</b>；認成台幣＝<b>外幣數字被當成台幣入帳</b>。兩種畫面都會說驗算通過 ⑨<b>摘要或日期讀錯</b>——金額是對的，但那兩欄是「這筆有沒有匯過」的辨識依據，<b>下次重匯同一份帳單時會被當成新的一筆再記一次</b>。<br>⚠️ <b>這份清單不保證完整</b>——⑤～⑧是 2026-08-13 覆審時才發現的，往後可能還有。所以下面兩張表還是請你自己看一眼，尤其是上面那張「帳戶餘額」。</li>
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
  ai_unavailable: '這是對方服務那邊的狀況，不是你的操作；等幾分鐘再按一次「同意」就好。',
  ai_truncated: '這份太長了，先用手動記帳；想調整上限的話跟我說一聲。',
  ai_refusal: '換更強的模型也一樣。這份請改用手動記帳。',
});
/** 這幾個 code 的後端訊息太技術，整句換成白話（其餘一律原句放行）。 */
const AI_REPLACE = Object.freeze({
  ai_bad_answer: 'AI 交回來的內容不合格式，這份沒有匯入（換更強的模型也一樣）。可以再按一次「同意」重試；還是不行就先手動記帳。',
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
