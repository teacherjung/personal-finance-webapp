// AI 同意路線的前端考題（P1b-2）。零網路、零鑰匙、零 DOM。
//
// 家規核可劃界（三段，比照 test/cashflow-bank-upload.test.js 與 test/reconcile-summary.test.js）：
// ①**為什麼准掃形狀**：`public/modules/cashflow.js` 頂層 `import … from '../app.js'`，而 `app.js`
//   模組層就碰 `document`／`localStorage`——node 載不進整頁，接線層只能去註解後掃原始碼。
//   判準與文案已盡量抽進 `ai-consent.js`（純函式），所以掃描只用來釘「接線真的接上去了」。
// ②**守得住什麼**：判準與文案的行為（A–E 群，真的執行）＋接線的形狀（F 群：三條 preview 路徑、
//   apply 走 applyBody、徽章插值、兩條 fallback、防重入）。
// ③**守不住什麼**：接線層在拿到回傳值之後另外蓋掉結果（例如把 previewBody 的結果丟掉自己組物件、
//   把同意窗改用別的開窗函式）——那要靠複審看 diff，已列進 PR 的誠實劃界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ROOT 用 fileURLToPath（不用 new URL(...).pathname）：專案路徑含空白與中文，pathname 會是 percent-encoded
// ⇒ ENOENT（2026-08-08 實際踩過）。與鄰居 cashflow-bank-upload.test.js／reconcile-summary.test.js 同慣例。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const {
  snapshotUpload, shouldOfferAi, shouldAskBeforeSend, askToggleDisplayAfterSaveFailure, previewBody, applyBody, isAiTicketDeadCode,
  aiConsentBodyHtml, aiPreviewBadgeHtml, modelDisplayName, aiErrorText, runAiFallback,
  AI_CONSENT_TITLE, AI_CONSENT_SUBMIT_LABEL, AI_CONSENT_BUSY_LABEL, AI_PREVIEW_LOST_TEXT,
} = await import('../public/modules/ai-consent.js');

/** 去註解後的原始碼（形狀題一律掃這份：註解裡的字不算數）。 @param {string} rel */
const srcOf = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
/** @param {string} s @param {RegExp} re */
const count = (s, re) => (s.match(re) || []).length;

// ---- A 群：shouldOfferAi（AI 入口的唯一判準）----

test('A｜shouldOfferAi：只認 bank_unrecognized，對帳閘紅（400 無 code）一律 false', () => {
  assert.equal(shouldOfferAi({ code: 'bank_unrecognized', status: 400 }), true);
  assert.equal(shouldOfferAi({ code: 'pdf_password', status: 400 }), false, '密碼錯要跳密碼窗，不是送 AI');
  // ★承重：對帳閘紅＝★6 裁決「禁止匯入」，絕不可讓 AI 撿去重試一次
  assert.equal(shouldOfferAi({ status: 400, message: '帳戶 ****3302 在 2026-06-02 接不上…' }), false,
    '無 code 的 400＝對帳閘紅（範本讀得懂、數字對不上）——提供 AI 入口就違反 ★6');
  assert.equal(shouldOfferAi(null), false);
  assert.equal(shouldOfferAi(undefined), false);
  assert.equal(shouldOfferAi({}), false);
  assert.equal(shouldOfferAi('bank_unrecognized'), false, '字串不是錯誤物件');
  // 鐵則 3.5：只認自有屬性——原型鏈上的 code 不算數
  assert.equal(shouldOfferAi(Object.create({ code: 'bank_unrecognized' })), false,
    'Object.hasOwn 換成 in／直接讀屬性＝原型鏈上的值也會開出 AI 入口');
});

test('A2｜r1#1 快照：檔名與檔案內容綁在同一份、事後改選別的檔案不會污染它', () => {
  // Codex r1 反例的行為版：選 A →（await 期間）改選 B → 同意窗顯示 B、實際送 A
  let picked = { name: 'A-對帳單.pdf', body: 'AAA' };
  const snap = snapshotUpload(picked);
  picked = { name: 'B-對帳單.pdf', body: 'BBB' };   // 使用者在請求在途時改選了別的檔案
  assert.equal(picked.name, 'B-對帳單.pdf', '（前提）外部那個可變變數確實已經換人了');
  assert.equal(snap.fileName, 'A-對帳單.pdf', '★同意窗要顯示的是「當初按下預覽的那一份」');
  assert.equal(snap.file.body, 'AAA', '★送出去的內容也必須是同一份（檔名與內容不可分家）');
  assert.ok(Object.isFrozen(snap), '快照要凍結：拿到它的人不可以偷改檔名');
  assert.equal(snapshotUpload(null), null, '沒選檔案＝沒有快照');
  assert.equal(snapshotUpload({}).fileName, '', '沒有檔名也要開得起來（不可炸掉整條路）');
});

// ---- B 群：previewBody（「沒明確要求 AI＝零外送」的行為證明；useAi＝要求旗標不是同意旗標）----

test('B｜previewBody：useAi 嚴格布林——沒明確要求 AI 就連 key 都不放；password 含空字串照放（複製 P0.5 現況）', () => {
  const plain = previewBody({ data: 'b64' });
  assert.deepEqual(plain, { data: 'b64' });
  assert.equal('useAi' in plain, false, '★沒同意＝body 裡連 useAi 這個 key 都不該有（零 AI 呼叫）');
  assert.equal('password' in plain, false);
  for (const v of [false, 'true', 1, {}, [], null, undefined]) {
    assert.equal('useAi' in previewBody({ data: 'b64', useAi: /** @type {any} */ (v) }), false,
      `useAi=${JSON.stringify(v)} 不是布林 true＝不可放旗標（寫成 !!useAi 就會讓每次上傳都外送）`);
  }
  assert.equal(previewBody({ data: 'b64', useAi: true }).useAi, true);
  assert.equal(previewBody({ data: 'b64', password: '' }).password, '', '空字串密碼照放＝完全複製既有行為');
  assert.equal(previewBody({ data: 'b64', password: 'pw' }).password, 'pw');
});

// ---- C 群：applyBody（票制承重）----

test('C｜applyBody：AI 分支只送 useAi＋aiTicket；模板分支不得出現 aiTicket 這個 key', () => {
  const ai = applyBody({ engine: 'ai', aiModel: 'm', aiTicket: 't1' }, { data: 'b64', password: 'pw' });
  assert.deepEqual(ai, { useAi: true, aiTicket: 't1' });
  assert.equal('data' in /** @type {any} */ (ai), false, '憑票寫入＝後端不解析檔案，送 data 讓契約字面不成立');
  assert.equal('password' in /** @type {any} */ (ai), false, 'AI apply 不碰密碼池');
  // ★承重：String(undefined)==='undefined' 是 truthy ⇒ 後端 `opts.aiTicket && !ticket` 會把正常匯入 400 擋死
  const tpl = applyBody({ rows: [] }, { data: 'b64', password: 'pw' });
  assert.deepEqual(tpl, { data: 'b64', password: 'pw' });
  assert.equal('aiTicket' in /** @type {any} */ (tpl), false, '模板路線帶 aiTicket＝把自己的正常匯入擋死');
  assert.equal(applyBody(null, { data: 'b64' }).data, 'b64', '缺席的 preview＝當模板路線');
  // 票不見＝null（呼叫端引導重新預覽，不可退回「送 data 自己再解一次」）
  assert.equal(applyBody({ engine: 'ai' }, { data: 'b64' }), null);
  assert.equal(applyBody({ engine: 'ai', aiTicket: '' }, { data: 'b64' }), null);
  assert.equal(applyBody({ engine: 'ai', aiTicket: 123 }, { data: 'b64' }), null, '非字串票＝當作沒有');
});

test('C2｜isAiTicketDeadCode：票類錯誤才算「這份沒救了」', () => {
  assert.equal(isAiTicketDeadCode('ai_ticket_invalid'), true);
  assert.equal(isAiTicketDeadCode('ai_ticket_required'), true);
  assert.equal(isAiTicketDeadCode('ai_unavailable'), false, '服務暫時不通＝可以再試，鈕要解鎖');
  assert.equal(isAiTicketDeadCode(undefined), false);
});

// ---- D 群：runAiFallback（編排行為，相依全注入）----

/** @param {{err:any, canOpen?:() => boolean}} o */
function fallbackProbe({ err, canOpen = () => true }) {
  const calls = { consent: 0 };
  /** @type {(() => void)[]} */
  const scheduled = [];
  const out = runAiFallback({
    err, canOpenNext: canOpen,
    openConsent: () => { calls.consent++; },
    schedule: (fn) => scheduled.push(fn),
  });
  return { out, calls, runScheduled: () => scheduled.forEach((fn) => fn()) };
}

test('D｜runAiFallback：閘紅／密碼錯＝rethrow 且零呼叫；認不得＝直接排程開同意窗（不再吐紅字）', () => {
  // ★★ 最重的一條：對帳閘紅不可長出 AI 入口
  const gateRed = fallbackProbe({ err: Object.assign(new Error('帳戶 ****3302 …接不上'), { status: 400 }) });
  assert.equal(gateRed.out, 'rethrow');
  assert.equal(gateRed.calls.consent, 0, '對帳閘紅＝★6 禁止匯入，連問都不該問');
  const pw = fallbackProbe({ err: Object.assign(new Error('密碼不對'), { code: 'pdf_password' }) });
  assert.equal(pw.out, 'rethrow');
  assert.equal(pw.calls.consent, 0);
  // 認不得＝offered，而且**一句紅字都不發**（William 2026-08-12：那句是多餘的重複資訊、還寫死台新）
  const ok = fallbackProbe({ err: Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { code: 'bank_unrecognized' }) });
  assert.equal(ok.out, 'offered');
  assert.equal(ok.calls.consent, 0, '排程之前不可直接開窗');
  ok.runScheduled();
  assert.equal(ok.calls.consent, 1);
});

test('D2｜runAiFallback：切頁的兩顆競態——排程當下與 callback 執行時各驗一次', () => {
  const staleNow = fallbackProbe({ err: { code: 'bank_unrecognized', message: 'x' }, canOpen: () => false });
  assert.equal(staleNow.out, 'stale');
  assert.equal(staleNow.calls.consent, 0);
  // 排程時還在、執行時已切頁（#445 ②號競態）
  let onPage = true;
  const later = fallbackProbe({ err: { code: 'bank_unrecognized', message: 'x' }, canOpen: () => onPage });
  assert.equal(later.out, 'offered');
  onPage = false;
  later.runScheduled();
  assert.equal(later.calls.consent, 0, '★排程後才切頁＝callback 內也要再驗一次，否則窗會開在別的頁面上');
});

// ---- E 群：文案與錯誤訊息 ----

test('E｜同意窗內文：四件事都講到、危險句一句都不准出現、檔名要跳脫', () => {
  const html = aiConsentBodyHtml({ fileName: '2026-06 對帳單.pdf' });
  assert.match(html, /送出內容/, '要講清楚送出去的是哪一份');
  assert.match(html, /2026-06 對帳單\.pdf/, '要顯示送的是哪一份檔案');
  assert.match(html, /Anthropic/, '要講送去哪裡');
  assert.match(html, /費用|多少/, '要交代費用這件事');
  assert.doesNotMatch(html, /幾塊|幾元|[0-9]+ ?元/,
    '★不給金額數字（William 2026-08-13：只說「記在你自己的 Anthropic 帳戶」——實測數字要等 P1b-3 之後才有）');
  assert.match(html, /大概多少/, '費用那一列的標題');
  assert.match(html, /不是報價|以他們的帳單為準/, '費用要標明是級距不是報價');
  assert.match(html, /不同意/, '要講不同意會怎樣（手動記帳、其他功能照常）');
  // ⚠️ r6：這個窗有**兩條**進場路——設定打開、或設定「讀不到」（fail-closed 保守問）。
  //    第二條路上使用者根本沒開設定，文案寫「你打開了設定…每一次都會出現」＝宣稱不存在的
  //    長期保護（下次讀取恢復就直接送）。窗的文案是靜態的、不知道自己為什麼被開 ⇒
  //    **一律不得推定開關狀態、不得承諾未來必問**，只講「這一次」＋指路到設定。
  assert.match(html, /只確認<b>這一次<\/b>/u, '★只承諾這一次');
  assert.match(html, /沒打開＝之後直接送/u, '★要講清楚沒開設定的後果（不是每次都會問）');
  assert.doesNotMatch(html, /你打開了設定|每一次上傳都會出現|每次都會問/u,
    '★不得推定使用者開了設定、不得承諾未來必問——設定讀不到的保守開窗也用同一份文案');
  assert.match(html, /同意只算這一次|不會被記住/, '★拍板：不記住同意');
  // ★r4#2：AI 讀出來的結果不是直接進資料庫——先回畫面核對、暫存伺服器記憶體，按下匯入才寫進去。
  //   scoped 斷言（不是全文找「資料庫」字樣，那會被別句冒充）
  const resultLine = (html.split('\n').find((l) => l.includes('讀出來的結果')) || '');
  assert.ok(resultLine, '要有一句交代「讀出來的結果」去哪裡');
  assert.match(resultLine, /先回到畫面|讓你核對/, '★要先講「回到畫面讓你核對」');
  assert.match(resultLine, /記憶體/, '★要講中間那份暫存在伺服器記憶體');
  assert.match(resultLine, /按下匯入|你按下/, '★要講「按下匯入之後才寫進去」');
  assert.doesNotMatch(html, /不會上傳|不會外送|已限速|保證正確|免費/,
    '⚠️ 這幾句在 AI 路線都是假的（帳單內文真的會送出去；LOCAL 沒有 runtime 限速；閘不保證讀對）');
  // ★r1#2：同意窗在**雲端版也會開**（停止線是按下去之後才擋）——窗裡一個字都不可以假設資料落在
  //   使用者自己的電腦上。原本只禁「只在這台電腦」，而實際句子是「只會留在你這台電腦的資料庫裡」
  //   ⇒ regex 沒咬到、完整測試照綠（Codex 用反例探針證實）。改成整個詞都不准出現。
  assert.doesNotMatch(html, /這台電腦/,
    '同意窗文案必須模式中立：雲端版的資料庫不在使用者電腦上，「留在你這台電腦」是假的');
  // ★William 2026-08-12 審稿時提出的版本，我糾正了三處與事實不符——這三條把糾正釘住：
  assert.doesNotMatch(html, /AI 那邊不會保留|AI那邊不會保留|不會留一份/,
    '★與上一行「會在一段時間後刪除」矛盾：留存一段時間＝有保留，不可寫成「不保留」');
  assert.doesNotMatch(html, /William/, '★程式碼裡不寫死使用者名字（未來多人版會變錯字）');
  // ★r1#1：「不拿去訓練／會刪除」是**供應商的預設政策**，不是我們能保證的事——這條路用的是使用者
  //   自己的 API 帳戶，那個帳戶另外同意過什麼我們看不到。所以那句必須是**有條件的**。
  //   範圍鎖在承載保證的那顆 <li>：整份掃到「預設」兩字不算數（別處出現也會過）。
  const policyLi = (html.match(/<li>[^]*?<\/li>/g) || []).find((/** @type {string} */ x) => /訓練/.test(x)) || '';
  assert.ok(policyLi, '要有一句交代「會不會被拿去訓練」');
  assert.match(policyLi, /預設政策|預設值/, '★要講明這是供應商的「預設政策」，不是我們給的保證');
  const caveatLi = (html.match(/<li>[^]*?<\/li>/g) || []).find((/** @type {string} */ x) => /不是我們能保證/.test(x)) || '';
  assert.ok(caveatLi, '★要有一句把「這是預設值、不是我們的保證」講死');
  assert.match(caveatLi, /你自己的 API 帳戶|自己的帳戶/, '要點明用的是使用者自己的帳戶（我們看不到那邊同意過什麼）');
  assert.match(caveatLi, /官方公告|以你自己的帳戶設定/, '★要把最終依據指回供應商官方公告，不要停在我們的說法');
  assert.doesNotMatch(html, /讀取不出這份帳單的內容|讀不出.*內容/,
    '★文字有讀到（下一行就說「抽出來的文字」）——認不出的是**版面**，不是讀不到內容');
  assert.match(html, /認不出這份帳單的版面|認不出.*版面/, '要講清楚是版面認不出來');
  assert.doesNotMatch(html, /帳號未碼/, '錯字：是「末碼」');
  assert.match(html, /帳號末碼/, '要列出送出去的欄位');
  // 跳脫：檔名是使用者給的
  const evil = aiConsentBodyHtml({ fileName: '<img src=x onerror=alert(1)>.pdf' });
  assert.match(evil, /&lt;img/);
  assert.doesNotMatch(evil, /<img src=x/);
  assert.match(aiConsentBodyHtml({}), /未命名檔案/, '沒檔名也要開得起來');
  // ⚠️ 這是 HTML 不是 markdown：`**粗體**` 會把星號原樣顯示給使用者看（要粗體請用 <b>）
  assert.doesNotMatch(html, /\*\*/, '畫面文案不可留 markdown 星號');
  assert.doesNotMatch(aiPreviewBadgeHtml({ engine: 'ai', aiModel: 'm' }), /\*\*/, '徽章同上');
  assert.ok(AI_CONSENT_TITLE.includes('AI') && AI_CONSENT_SUBMIT_LABEL.includes('同意'));
  assert.match(AI_CONSENT_BUSY_LABEL, /稍候|讀取中|正在/, '送出中的鈕文字要看得出「還在跑」');
  // ⚠️ 送出當下那則 toast 已於 2026-08-13 移除（William：「可以不用顯示」）。
  //    「按下去不像當掉」的保證改由**上傳鈕的 busyLabel** 承載＝考題在 cashflow-bank-upload.test.js。
});

test('E2｜預覽徽章：模板回空字串；AI 版要講「誰讀的」與「驗不到什麼」，模型名要跳脫', () => {
  assert.equal(aiPreviewBadgeHtml({ rows: [] }), '', '模板路線不可長出徽章');
  assert.equal(aiPreviewBadgeHtml(null), '');
  assert.equal(aiPreviewBadgeHtml(undefined), '');
  assert.equal(aiPreviewBadgeHtml({ engine: 'template' }), '');
  const html = aiPreviewBadgeHtml({ engine: 'ai', aiModel: 'claude-haiku-4-5-20251001' });
  assert.match(html, /AI 幫你讀出來的/);
  assert.match(html, /Claude Haiku 4\.5/, '模型名要人看得懂（代號留給後端與 log）');
  // ★誠實劃界的白話版：這句必須在畫面上（不可只藏在 <details> 裡）
  const firstDetails = html.indexOf('<details');
  const visible = firstDetails >= 0 ? html.slice(0, firstDetails) : html;
  // ★William 2026-08-12 改版：第一眼那句從「它驗不到 X」改成「**請確認** X 有沒有讀錯」——
  //   同樣是誠實劃界的白話版，但改成**行動指示**（更能讓人真的去看那四欄）。
  //   完整的驗算射程與盲區改由展開區承擔（下方 blindItem 的三條斷言）。
  assert.match(visible, /請確認/, '★第一眼要有行動指示，不能只講「AI 讀的」就沒了');
  for (const field of ['機構名', '帳號', '日期', '摘要']) {
    assert.ok(visible.includes(field), `★要逐項點名要核對什麼（缺「${field}」＝使用者不知道該看哪裡）`);
  }
  assert.doesNotMatch(visible, /都驗過|保證|放心/, '第一眼不可出現任何讓人放鬆核對的字眼');
  // ★r2#1：**全文**層級的射程（原本只掃第一個展開區之前的片段，展開區裡的過頭話完全看不到）
  assert.match(html, /自洽|剛好.*平|扣不起來/, '要照實講「擋得住扣不起來的錯、擋不住剛好自洽的錯」（契約 §八 的誠實劃界）');
  // ★r4#1：驗算的真實射程＝**只驗台幣**（外幣整組 skip）、**每個帳戶首筆驗不到**（沒有前一筆可比）。
  //   把它講成「每一筆都驗、驗不到就不收」是超過實作的保證。三條各自獨立斷言（不互相冒充）。
  // ⚠️ **scope 到各自承擔的那一個 <li>**（r5#2）：整份 html 掃「台幣」會被別句（「不計入台幣收支」）
  //    滿足——Codex 實測把驗算對象從「台幣帳戶」改成「帳戶」，整份掃描仍全綠。
  const items = html.split('<li>');
  const gateeItem = items.find((x) => x.includes('通過驗算才准匯入')) || '';
  const blindItem = items.find((x) => x.includes('看不到的')) || '';   // 條數會隨誠實劃界增加，錨在「看不到的」不錨數字（鐵則 10）
  assert.ok(gateeItem && blindItem, '徽章要有「驗什麼」與「看不到什麼」兩條');
  assert.match(gateeItem, /台幣帳戶/, '★講驗算對象的那一條就要指名台幣帳戶（整份掃描會被別句冒充）');
  assert.match(blindItem, /第一筆|首筆/, '★要講清楚每個帳戶的第一筆驗不到');
  assert.match(blindItem, /外幣/, '★要講清楚外幣明細不在這道驗算裡');
  // ★r6#1：概要有、明細一筆都沒有的台幣帳戶（本期無往來，很常見）——**它的餘額仍會照帳單更新或
  //   新建帳戶，卻沒有任何明細可以驗**。Codex 走正式 preview→票→apply 重現：那個帳戶真的被建出來、
  //   餘額 777 真的寫進去，而 twdAccountsUnverified 仍是 0（它只算「有交易列」的帳戶）。
  // ⚠️ 揭露要**分三件事各自釘住**（r7#1）：只認情境名詞的話，把「餘額仍會寫入」與「沒有明細可驗」
  //    整段刪掉仍然全綠——那正是 Codex 實測的假綠面。
  assert.match(blindItem, /沒有往來|一筆都沒有|只出現在概要/, '①要點出情境：這期沒往來、只出現在概要的帳戶');
  assert.match(blindItem, /餘額仍會|仍會照帳單更新|新建帳戶/, '②★要講「它的餘額仍然會被寫進去」（不然使用者以為沒驗算就不會動）');
  assert.match(blindItem, /沒有(任何)?明細可以驗|沒有明細可驗/, '③★要講「那個數字沒有明細可以驗」');
  assert.match(gateeItem, /如果也印了|有印.{0,6}概要餘額/, '★末筆對概要是**有條件**的——只出現「概要」二字不算數（沒印時那一關會被跳過）');
  assert.doesNotMatch(html, /把每一筆的餘額前後扣起來/, '不可寫成「每一筆」——首筆沒有前一筆可比');
  assert.doesNotMatch(html, /進不了你的帳本|不會記錯|保證正確|一定正確|完全正確/,
    '★閘只保證擋住「造成不一致」的錯——金額與餘額一起抄成自洽的另一組數字仍可能通過，不可講成數值正確性保證');
  assert.doesNotMatch(html, /這台電腦/, '徽章同樣要模式中立（雲端版也看得到它）');
  const evil = aiPreviewBadgeHtml({ engine: 'ai', aiModel: '<b>x</b>' });
  assert.match(evil, /&lt;b&gt;/);
  assert.doesNotMatch(evil, /<b>x/);
  // ★模型名要人看得懂（William 2026-08-12）：代號留在後端與 log，畫面給人名
  assert.match(html, /Claude Haiku 4\.5/, '畫面要顯示人看得懂的模型名');
  assert.doesNotMatch(html, /claude-haiku-4-5-20251001/, '不給使用者看內部代號');
});

test('E2c｜合計交叉驗證**不是每份都跑得起來**：說明不可再無條件講「帳單有印合計＝擋得住」（William 2026-08-19：他自己的帳單正是混幣）', () => {
  const html = aiPreviewBadgeHtml({ engine: 'ai', aiModel: 'claude-sonnet-5' });
  const blindItem = (html.split('<li>').find((x) => x.includes('看不到的'))) || '';
  assert.ok(blindItem, '要有「看不到什麼」那一條');
  assert.match(blindItem, /台幣[^。]{0,24}外幣/, '★要點名條件是台幣與外幣混合（不講條件＝這份帳單的使用者被誤導）');
  assert.match(blindItem, /整道關閉|沒跑|沒有跑/, '★要講那道檢查會整個關掉，不是「比較弱」');
  assert.match(blindItem, /帳單數學驗算/, '★要指路：這一份到底跑了沒有，看畫面上那一段');
  assert.doesNotMatch(blindItem, /帳單有印合計＝合計也擋/, '★舊的無條件講法（①）不可留');
  assert.doesNotMatch(blindItem, /帳單有印整份合計＝擋下/, '★舊的無條件講法（⑦）不可留');
  assert.doesNotMatch(blindItem, /或帳單有印合計＝擋下/, '★舊的無條件講法（⑥）不可留');
});

test('E2b｜modelDisplayName：代號→人看得懂的名字；認不得的原樣顯示（不吃掉資訊）', () => {
  assert.equal(modelDisplayName('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5');
  assert.equal(modelDisplayName('claude-sonnet-5'), 'Claude Sonnet 5');
  assert.equal(modelDisplayName('claude-opus-4-8-20260101'), 'Claude Opus 4.8');
  assert.equal(modelDisplayName('gpt-x-99'), 'gpt-x-99', '認不得的原樣顯示——不可回空字串（那會讓畫面看不出用了什麼）');
  assert.equal(modelDisplayName(''), '');
  assert.equal(modelDisplayName(undefined), '');
});

test('E3｜aiErrorText：後端白話句原句放行＋補下一步；未知 code 不吃訊息；不回聲帳單數字', () => {
  // 原句放行＋補 advice
  const noKey = aiErrorText('ai_no_key', '還沒有設定 AI 解析鑰匙——請先到設定頁存入你的 API key，再試一次。');
  assert.ok(noKey.startsWith('還沒有設定 AI 解析鑰匙'), '後端已經白話＝原句放行（同一句寫兩份必漂）');
  assert.match(noKey, /設定.*AI 解析鑰匙.*卡片/, '前端補的是畫面知識：去哪張卡');
  assert.match(aiErrorText('ai_auth', '鑰匙無效'), /換一把/);
  assert.match(aiErrorText('ai_unavailable', '服務繁忙'), /等幾分鐘/);
  assert.match(aiErrorText('ai_hosted_off', '雲端版尚未開放'), /手動記帳/);
  // 這兩個後端訊息本來就完整白話＝不補、不改
  const weak = 'AI 讀不到這份帳單的逐筆餘額（或其中有帳戶整組讀不到）…這份請改用手動記帳。';
  assert.equal(aiErrorText('ai_weak_refused', weak), weak, '★6 的白話句已經完整，前端不可再寫第二份');
  const recon = 'AI 翻譯後帳仍軋不平（升級到第二個模型也一樣）…不用貼帳單內容。';
  assert.equal(aiErrorText('ai_reconcile_failed', recon), recon);
  assert.doesNotMatch(aiErrorText('ai_reconcile_failed', recon), /\d{3,}/, '不可回聲帳單數字');
  // 整句替換（後端訊息太技術）
  assert.match(aiErrorText('ai_bad_answer', 'AI 答案卷不是有效的 JSON'), /不合格式/);
  assert.doesNotMatch(aiErrorText('ai_bad_answer', 'AI 答案卷不是有效的 JSON'), /JSON/, '技術詞不給使用者看');
  assert.match(aiErrorText('ai_engine_missing', 'AI 引擎未接上'), /程式的問題/);
  // ★未知／無 code：原句照丟，絕不用罐頭句吃掉（對帳閘紅那句帶著要核對的數字）
  const gateRed = '帳戶 ****3302 在 2026-06-02「CD提款」接不上：前一筆餘額 1,000…';
  assert.equal(aiErrorText(undefined, gateRed), gateRed);
  assert.equal(aiErrorText('zzz_unknown', gateRed), gateRed);
  assert.match(aiErrorText('ai_no_key', ''), /設定.*AI 解析鑰匙/, '沒訊息時至少回 advice（不可回空字串讓畫面沒東西）');
  assert.equal(aiErrorText(undefined, ''), '更新失敗', '完全沒資訊時才用罐頭句');
});

// ---- F 群：cashflow.js 接線形狀 ----

test('A3｜shouldAskBeforeSend：只有明確設成 true 才問；讀不到設定當成「要問」（fail-closed）', () => {
  // 這支判準決定「帳單要不要先問過你才送出去」。它原本**一條考題都沒有**（2026-08-14 預審抓到），
  // 而它 JSDoc 承諾的「拿不到設定就當成要問」也沒人守。
  // ⚠️ 方向為什麼是這樣：猜錯「不用問」＝沒問就把帳單送出去、還花了使用者的錢；
  //    猜錯「要問」＝最多多一個窗。代價不對稱，所以往「問」的方向倒。
  assert.equal(shouldAskBeforeSend({ aiAskBeforeSend: true }), true, '打開了就要問');
  assert.equal(shouldAskBeforeSend({ aiAskBeforeSend: false }), false, '明確關著＝直接送');
  assert.equal(shouldAskBeforeSend({}), false, '欄位缺席＝還沒改過設定＝用預設（不問）');
  // ⚠️ 三分法（r1#2 修正）：上一版把「壞型別」跟「缺席」混成同一個 false——
  //    備份還原塞進來的 'true' 字串會變成「直接外送」，方向錯。**欄位在、卻不是布林
  //    ＝資料壞了、不知道使用者要什麼 ⇒ 保守：問**（跟「整包設定拿不到」同一個答案）。
  for (const junk of ['true', 'false', 1, 0, {}, [], 'yes', null]) {
    assert.equal(shouldAskBeforeSend({ aiAskBeforeSend: junk }), true,
      `★欄位存在但不是布林（${JSON.stringify(junk)}）＝保守要問——壞資料不可以往「外送」倒`);
  }
  for (const bad of [null, undefined, 'x', 0]) {
    assert.equal(shouldAskBeforeSend(bad), true,
      `★拿不到設定物件（${JSON.stringify(bad)}）＝不知道使用者選了什麼 ⇒ 當成要問`);
  }
});

test('命名｜useAi 不可再叫「同意旗標」——那個名字誤示每次都問過（r3）', () => {
  // 2026-08-13 預設翻成直接送之後，「同意」這個名字本身就是假保證：旗標代表的是
  // 「前端明確要求 AI」，同意窗只在 aiAskBeforeSend 打開時出現。歷史紀錄（計畫文件的
  // 變更紀錄行）不在射程——它記的是當時，不是現在。
  // ⚠️ 不可用 srcOf（它剝註解，而這個名字全住在註解裡＝守衛永遠看不到）——用原始檔。
  for (const f of ['server.js', 'lib/routes/statement.js', 'lib/services/bank-import.js',
    'public/modules/cashflow.js', 'public/modules/ai-consent.js',
    'docs/contracts/income-expense.md', 'AGENTS.md',
    'docs/parser-generalization-plan.md']) {   // r5#2：現行規格也在射程（變更紀錄行用棄用標記）
    // ⚠️ r4：不可用「檔裡有標記就整檔豁免」——那是檔案級放行，標記後面再塞一個
    //    未標示的舊名照樣綠。**逐一出現**驗證：把合法的「舊名『同意旗標』」整串剝掉，
    //    殘餘裡再出現舊名＝紅。
    const residual = readFileSync(join(ROOT, f), 'utf8')
      .replaceAll('舊名「同意旗標」', '').replaceAll('時稱「同意旗標」', '');
    assert.ok(!residual.includes('同意旗標'),
      `★${f} 有未標示的「同意旗標」——每一次出現都要嘛改名、要嘛長成「舊名『同意旗標』」`);
  }
});

test('A4｜開關存檔失敗後的顯示：向後端核對，核對不到＝不得宣稱受保護（r5#1）', async () => {
  // ⚠️ 「!want 退回」是猜測：後端先寫入再回應，寫入可能已成功、回應沒回來——
  //    使用者關掉詢問、寫入成功、回應斷線 ⇒ 畫面退回「會先問你」＝假保證，下一張直接外送。
  assert.equal(await askToggleDisplayAfterSaveFailure(async () => ({ aiAskBeforeSend: true })), true,
    '核對到 true＝照實顯示「會先問」');
  assert.equal(await askToggleDisplayAfterSaveFailure(async () => ({ aiAskBeforeSend: false })), false,
    '核對到 false＝照實顯示「直接送」');
  assert.equal(await askToggleDisplayAfterSaveFailure(async () => { throw new Error('斷線'); }), false,
    '★核對不到＝顯示「直接送」——畫面寫著「會先問你」而資料庫其實不會問，是最糟的假保證');
  for (const junk of [{ aiAskBeforeSend: 'true' }, {}, null]) {
    assert.equal(await askToggleDisplayAfterSaveFailure(async () => junk), false,
      `★${JSON.stringify(junk)}：讀不出明確的 true＝不得宣稱受保護`
      + '（注意：這與送出路徑的 shouldAskBeforeSend 方向相反、而且應該相反——'
      + '送出的保守＝問（保住錢）、顯示的保守＝不宣稱（不給假安全感））');
  }
});

test('F｜cashflow.js 接線：三條 preview 路徑各自正確、apply 走 applyBody、徽章真的插進畫面', () => {
  const src = srcOf('public/modules/cashflow.js');
  // 三條 preview 路徑：上傳窗（無密碼）／密碼窗／同意窗（唯一帶 useAi 的那條）
  // ⚠️ 形狀在 2026-08-18（進度串流）又變一次：四條路徑改**經由單一出口** previewWithProgress，
  //    由它一處呼叫 previewBody（比原本「四處各自呼叫」更嚴：判準不可能在某一條路被繞過）。
  //    因此改釘：①出口自己走 previewBody ②四條路徑都走出口 ③各自的旗標形狀不變。
  assert.match(src, /const previewWithProgress = [\s\S]{0,400}?previewBody\(bodyArgs\)/,
    '★單一出口自己要走 previewBody（繞過它＝useAi 嚴格布林等判準全失守）');
  assert.equal(count(src, /previewWithProgress\(\{/g), 4,
    '★四條 preview 路徑都要走那個出口（漏一條＝那條路沒有判準也沒有進度）——'
    + '第四條＝`sendToAi`（William 2026-08-13「預設不問、直接送」新增的那一條）');
  assert.match(src, /previewWithProgress\(\{ data: b64, password: pw, useAi: true \}/, '★同意窗那條才帶 useAi');
  assert.match(src, /previewWithProgress\(\{ data: b64 \}/, '上傳窗那條不帶旗標');
  assert.match(src, /previewWithProgress\(\{ data: b64, password: pw \}/, '密碼窗那條不帶旗標');
  // ⚠️ **這條保證的形狀在 2026-08-13 變了**（William 拍板：預設不問、直接送）。
  //    舊版：`useAi: true` 全檔只准出現一次（同意窗）＝「沒問過就不外送」。
  //    新版：兩處——同意窗（設定打開時）與 sendToAi（預設路徑）。**兩處都必須在
  //    `askBeforeSendAi()` 的分流之後**，否則「打開開關卻仍不問」就會發生而沒人擋。
  assert.equal(count(src, /useAi: true/g), 2, '★只有這兩條路帶旗標——多一處＝有條路繞過了設定分流');
  // ⚠️ r2#1：一條 regex 守兩條路＝另一條的比對結果會冒充它——把密碼路徑改成
  //    `if (false && await askBeforeSendAi())`，免密碼那條照樣讓單一 regex 過。
  //    兩條路**各自 scoped**：ask 分支 → 開自己的同意窗（引數不同＝身分）→ return → 自己的 sendToAi。
  for (const [label, consentArgs, sendArgs] of [
    // 2026-08-18：sendToAi 多收一把 setProgress（進度筆）——身分引數（b64/pw）不變，尾參數放寬。
    ['密碼窗路', 'openAiConsentWindow\\(b64, pw, fileName\\)', "sendToAi\\(b64, pw, onPage, canOpenNext[^)]*\\)"],
    ['上傳窗路（免密碼＝最常走）', "openAiConsentWindow\\(b64, '', snap\\.fileName\\)", "sendToAi\\(b64, '', onPage, canOpenNext[^)]*\\)"],
  ]) {
    assert.match(src, new RegExp(
      'if \\(await askBeforeSendAi\\(\\)\\) \\{[\\s\\S]{0,300}?' + consentArgs
      + "[\\s\\S]{0,120}?return;\\n\\s*\\}\\n\\s*await " + sendArgs),
      `★${label}：ask 分支→自己的同意窗→return→自己的 sendToAi，四件事同一段——`
      + '任何一條被 false&& 掉，這條 scoped 斷言就找不到完整形狀');
  }
  // ⚠️ **兩個呼叫點都要釘**（2026-08-14 預審抓到）：原本只釘了密碼窗那一條，
  //    把**上傳窗那條**（免密碼帳單＝最常走的路）整行刪掉，整包考題照樣全綠——
  //    使用者上傳一份系統不認得的帳單，畫面什麼都不會發生，而沒有任何一條考題會紅。
  assert.equal(count(src, /await sendToAi\(/g), 2,
    '★兩條「不問就直接送」的路都要在：上傳窗（免密碼）與密碼窗。少一條＝那條路按下去沒反應');
  // 2026-08-18：尾參數多一把進度筆（setProgress）——身分引數（b64/pw）照舊釘死。
  assert.match(src, /await sendToAi\(b64, pw, onPage, canOpenNext[^)]*\)/,
    '★密碼窗那條必須真的送出（沒接＝認不出版面就什麼都不會發生）');
  assert.match(src, /await sendToAi\(b64, '', onPage, canOpenNext[^)]*\)/,
    '★上傳窗那條也必須真的送出——它是**最常走的那條**（帳單沒設密碼時就走這裡）');
  // ⚠️ r1#1：等「要不要先問」設定的 await 期間使用者可能已離開——重新驗證必須是
  //    sendToAi 的**第一個語句**（收進函式本身＝兩條路＋未來新增的呼叫者自動受保護，
  //    同 #454 r6「唯一性收進取值函式」同一課）。
  // 2026-08-18：簽名尾端多一個 setProgress 參數（可能換行）——重新驗證仍必須是**第一個語句**。
  assert.match(src, /canOpenNext,?\n?[^)]*\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(!canOpenNext\(\)\) return;/u,
    '★sendToAi 第一個語句必須是 canOpenNext 重新驗證——沒有它，關窗切頁後帳單照樣送出去、照樣花錢');
  // apply 走 applyBody（插值形，不是只出現函式名）
  assert.match(src, /const payload = applyBody\(r, \{ data: b64, password: pw, skipSimilar \}\);/,
    'apply 的 body 要由 applyBody 產（AI 走票、模板走檔案；skipSimilar＝勾選值一路帶進去）');
  assert.match(src, /getElementById\('skipSimilarChk'\)\)\?\.checked === true/,
    '★勾選值只認嚴格 true——沒有勾選框（similar=0）＝undefined＝不帶 key');
  assert.match(src, /body: payload/, '算出來的 payload 要真的送出去（算了不用＝白算）');
  assert.match(src, /if \(!payload\) \{[^}]*AI_PREVIEW_LOST_TEXT/, '票不見＝引導重新預覽，不可退回「送 data 讓它自己再解一次」');
  assert.doesNotMatch(src, /body: \{ data: b64, password: pw \}/, 'apply 的裸物件要被換掉，否則 AI 路線的票永遠帶不出去');
  // 徽章：插值形（只鎖呼叫名的話，`${(f(r), '')}` 會過）
  assert.match(src, /\$\{aiPreviewBadgeHtml\(r\)\}/, '徽章要真的插進 body 字串');
  // 兩條 fallback：上傳窗與密碼窗各一（少一條＝加密帳單走不到 AI）
  assert.equal(count(src, /runAiFallback\(\{ err: e, canOpenNext, openConsent:/g), 2, '上傳窗與密碼窗都要有 AI 救援路徑');
  // ★William 2026-08-12 裁示：不再把模板的原錯誤搬到畫面上——同意窗第一行已經講了「範本認不得這個
  //   版面」，那句紅字是重複資訊，而且它寫死「台新銀行綜合對帳單」、在多銀行時代本身就過期。
  assert.doesNotMatch(src, /runAiFallback\(\{[^}]*notify:/, '★AI 救援路徑不可再吐原錯誤紅字（多餘且過期）');
  // ★r9#1：呼叫了還不夠——回傳 'rethrow' 必須真的把原錯誤丟回去。只把密碼窗那條 throw 改成 return，
  //   非 bank_unrecognized 的錯誤會被當成成功（表單關掉、什麼都不顯示），而三關全綠（Codex 實測）。
  assert.equal(count(src, /=== 'rethrow'\) throw e;/g), 2, "★兩條 fallback 都要以 === 'rethrow' 控制把原錯誤丟回（吞掉＝使用者看不到任何錯誤）");
  // ★r9#1：aiErrorText 的兩個**畫面輸出端**都要釘住——只驗翻譯函式本身，繞過它直接顯示原始
  //   e.message 照樣全綠（技術訊息與「下一步」就不會出現在畫面上）。
  assert.match(src, /throw new Error\(aiErrorText\(/, '同意窗的錯誤要經 aiErrorText 翻譯後才丟給 openForm 顯示');
  assert.match(src, /toast\(aiErrorText\(code, /, '套用鈕的錯誤也要經 aiErrorText（票類/服務類的下一步就在那裡）');
  assert.match(src, /openConsent: \(\) => openAiConsentWindow\(b64, pw, fileName\)/, '★密碼要一路帶進同意窗，否則 AI 抽字打不開檔案→又跳密碼窗→無限迴圈');
  // ★r1#1：檔名與內容必須同源。快照在第一次 await 之前取，之後全檔不得再讀可變的 file
  assert.match(src, /const snap = snapshotUpload\(file\);/, '第一次 await 之前要先凍住「這一次上傳的是哪一份」');
  assert.match(src, /await fileToBase64\(snap\.file\)/, '送出的內容要從快照拿（不是從可變的 file）');
  assert.match(src, /openAiConsentWindow\(b64, '', snap\.fileName\)/, '同意窗顯示的檔名要從同一份快照拿');
  assert.match(src, /openPasswordWindow\(b64, snap\.fileName\)/, '密碼窗也要把快照檔名帶下去（它後面還會開同意窗）');
  assert.doesNotMatch(src, /file\?\.name/, '★不得再讀可變的 file——那正是「同意窗顯示 B、實際送 A」的來源');
  // 彈窗世代：同意窗的 onSubmit 也要用 onPage() && ctx.owns.handoff()
  assert.equal(count(src, /const canOpenNext = \(\) => onPage\(\) && ctx\.owns\.handoff\(\);/g), 3,
    '上傳窗／密碼窗／同意窗三個 onSubmit 都要有（少一個＝那條路的窗會被同頁重繪判成已切頁而靜靜不開）');
  // 防重入與票類錯誤不解鎖
  assert.match(src, /btn\.disabled = true;/, '票是一次性：按兩次的第二次必得 ai_ticket_invalid，而第一次其實已寫入');
  assert.match(src, /if \(!isAiTicketDeadCode\(code\)\) btn\.disabled = false;/, '票類錯誤不可解鎖（解了只會再撞一次）');
  // ★票只活在閉包：cashflow.js 全檔不得出現 aiTicket 字樣
  assert.doesNotMatch(src, /aiTicket/, '★票不可被 cashflow.js 持有（模組層變數／dataset／storage 都不行）——A 帳單的票被 B 帳單的 apply 撿去用，後端不看你送的檔案就把 A 的數字寫進去');
  assert.doesNotMatch(src, /setTimeout\(\(\) => openAiConsentWindow/, '排程開窗要走 runAiFallback（它自帶兩道切頁檢查）');
  assert.ok(AI_PREVIEW_LOST_TEXT.includes('重新上傳'), '票掉了要引導重新預覽');
  // 同意窗的鈕不可寫「儲存」——這是「送出去讀」的決定，不是存檔
  assert.match(src, /submitLabel: AI_CONSENT_SUBMIT_LABEL/, '同意窗要指定送出鈕文字');
  // ★等待回饋（William 2026-08-12 回報：按下同意後畫面停 5–6 秒，看起來像當掉）
  assert.match(src, /busyLabel: AI_CONSENT_BUSY_LABEL/, '★送出中要換鈕文字（只變灰看起來像沒反應）');
  assert.doesNotMatch(src, /AI_SENDING_TEXT/, '★那則 toast 已移除（William 2026-08-13），不可順手復活');
  const appSrc2 = srcOf('public/app.js');
  assert.match(appSrc2, /if \(submitBtn && busyLabel\) submitBtn\.textContent = busyLabel;/, '★openForm 要真的把 busyLabel 寫上按鈕');
  assert.match(appSrc2, /if \(busyLabel\) submitBtn\.textContent = submitLabel;/, '★失敗解鎖時要把鈕文字換回來（否則鈕永遠停在「正在讀取…」）');
  // ★r1#5：只把按鈕搬到動作列還不夠——.modal 是 max-height:90vh + overflow-y:auto，長預覽仍要捲到最底
  assert.match(appSrc2, /form-actions\$\{opts\.actionsHtml \? ' sticky-actions' : ''\}/, '有動作按鈕的資訊窗要套固定動作列');
  // ⚠️ CSS 形狀題的三個坑，三個都踩過（r3#3、r4#1 由 Codex 實測示範）：
  //    ①**註解**：把正確宣告寫進註解、正式宣告改壞 ⇒ 先剝掉 /* */
  //    ②**重複宣告**：`position: sticky; position: static` ⇒ 後面覆寫前面，只看第一個等於沒看
  //    ③**多寫一條同名規則**：後面那條覆寫前面那條 ⇒ 只取第一條等於沒看
  //    所以這裡不用「掃到就算」，而是**解析出宣告、取最後生效的那個值**。
  //    ⚠️ 誠實劃界：只認 `.form-actions.sticky-actions {…}` 這個**單獨**選擇器；寫成群組選擇器
  //    （`.a, .form-actions.sticky-actions {…}`）或用其他選擇器隔空覆寫，這題看不到。
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.match(/\.form-actions\.sticky-actions\s*\{[^}]*\}/g) || [];
  assert.equal(rules.length, 1, '★只准有一條 .sticky-actions 規則（第二條會覆寫第一條）');
  const decls = rules[0].slice(rules[0].indexOf('{') + 1, -1).split(';')
    .map((/** @type {string} */ d) => d.trim()).filter(Boolean)
    .map((/** @type {string} */ d) => ({ prop: d.slice(0, d.indexOf(':')).trim(), val: d.slice(d.indexOf(':') + 1).trim() }));
  // ⚠️ `!` 與 `important` 之間**允許空白**、關鍵字**不分大小寫**（css-cascade-4 §important：
  //    最後兩個非空白非註解的 token）。只認 `!important` 連寫小寫＝`! important` 照樣打穿（r6 實測）。
  const IMPORTANT_RE = /\s*!\s*important\s*$/i;
  /** 取**實際生效**的那個值：`!important` 贏過一般宣告，同級才比誰後寫（r5#1：只比先後的話，
   *  `position: static !important; position: sticky;` 會被讀成 sticky，瀏覽器算出來卻是 static）。
   *  @param {string} prop */
  const lastOf = (prop) => {
    const hit = decls.filter((/** @type {any} */ d) => d.prop === prop);
    if (!hit.length) return null;
    const imp = hit.filter((/** @type {any} */ d) => IMPORTANT_RE.test(d.val));
    const chosen = (imp.length ? imp : hit).at(-1);
    return String(chosen.val).replace(IMPORTANT_RE, '').trim();
  };
  assert.equal(lastOf('position'), 'sticky', '★最後生效的 position 要是 sticky（沒有它，按鈕照樣沉在捲動內容最底）');
  assert.equal(lastOf('bottom'), '0', '★停靠點要 bottom:0（負值＝停在窗底外面，實測按鈕滑出 8px＝白做）');
  assert.match(String(lastOf('background')), /var\(--card\)/, '要不透明背景（否則捲動的表格會從按鈕底下透出來）');
  // 有效下邊距＝`margin` 簡寫的第三個值與 `margin-bottom` 之中**最後寫的那個**
  const mDecls = decls.filter((/** @type {any} */ d) => d.prop === 'margin' || d.prop === 'margin-bottom');
  assert.ok(mDecls.length, '要寫出 margin（滿版靠左右負邊距）');
  const impM = mDecls.filter((/** @type {any} */ d) => IMPORTANT_RE.test(d.val));
  const lastM = (impM.length ? impM : mDecls).at(-1);
  const vals = String(lastM.val).replace(IMPORTANT_RE, '').trim().split(/\s+/);
  const effBottom = lastM.prop === 'margin-bottom' ? lastM.val : (vals.length >= 3 ? vals[2] : vals[0]);
  assert.doesNotMatch(effBottom, /^-/,
    '★下邊距不可為負：sticky 對齊的是 margin box，負的下邊距會把停靠點往下推（左右負邊距做滿版沒問題）');
  // ★r8#1：光有「產物」不夠，要釘住**產物真的被正式路徑用掉**——否則 openForm 忽略 bodyHtml 時，
  //   同意窗只剩一顆「同意，送出去讀」的按鈕、四件事（送哪份／去哪／費用／不同意會怎樣）全都不見，
  //   而所有考題照樣全綠（Codex 實測）。
  assert.match(src, /bodyHtml: aiConsentBodyHtml\(\{ fileName \}\)/, '同意窗要把揭露內文交給 openForm');
  const appSrc = srcOf('public/app.js');
  assert.match(appSrc, /\$\{esc\(submitLabel\)\}<\/button>/,
    'openForm 的送出鈕要吃 submitLabel（寫死「儲存」的話，同意窗的鈕會變成「儲存」——使用者以為只是存個設定，其實是把帳單送出去）');
  assert.match(appSrc, /\$\{bodyHtml \? `<div class="info-body">\$\{bodyHtml\}<\/div>` : ''\}/,
    '★openForm 必須真的把 bodyHtml 渲染進畫面——忽略它＝同意窗變成沒有告知的空白確認框');
});

test('applyBody｜配方路線（P2-2）＝只送 {aiTicket}：所見即所得同紀律、不送 useAi；票不見＝null 引導重新預覽', () => {
  const body = applyBody({ engine: 'recipe', aiTicket: 't-rcp' }, { data: 'x', password: 'p' });
  assert.deepEqual(body, { aiTicket: 't-rcp' }, '★不送 data/password/useAi——後端憑票、不重跑選版');
  const withSkip = applyBody({ engine: 'recipe', aiTicket: 't-rcp' }, { data: 'x', skipSimilar: true });
  assert.deepEqual(withSkip, { aiTicket: 't-rcp', skipSimilar: true });
  assert.equal(applyBody({ engine: 'recipe' }, { data: 'x' }), null, '★票不見＝不可退回自己再解一次');
});
