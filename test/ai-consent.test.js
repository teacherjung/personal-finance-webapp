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
  snapshotUpload, shouldOfferAi, previewBody, applyBody, isAiTicketDeadCode,
  aiConsentBodyHtml, aiPreviewBadgeHtml, aiErrorText, runAiFallback,
  AI_CONSENT_TITLE, AI_CONSENT_SUBMIT_LABEL, AI_PREVIEW_LOST_TEXT,
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

// ---- B 群：previewBody（「沒同意＝零外送」的行為證明）----

test('B｜previewBody：useAi 嚴格布林——沒同意就連 key 都不放；password 含空字串照放（複製 P0.5 現況）', () => {
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
  const calls = { notify: /** @type {string[]} */ ([]), consent: 0 };
  /** @type {(() => void)[]} */
  const scheduled = [];
  const out = runAiFallback({
    err, canOpenNext: canOpen,
    notify: (m) => calls.notify.push(m),
    openConsent: () => { calls.consent++; },
    schedule: (fn) => scheduled.push(fn),
  });
  return { out, calls, runScheduled: () => scheduled.forEach((fn) => fn()) };
}

test('D｜runAiFallback：閘紅／密碼錯＝rethrow 且零呼叫；認不得＝先吐原句再排程開窗', () => {
  // ★★ 最重的一條：對帳閘紅不可長出 AI 入口
  const gateRed = fallbackProbe({ err: Object.assign(new Error('帳戶 ****3302 …接不上'), { status: 400 }) });
  assert.equal(gateRed.out, 'rethrow');
  assert.equal(gateRed.calls.consent, 0, '對帳閘紅＝★6 禁止匯入，連問都不該問');
  assert.equal(gateRed.calls.notify.length, 0, 'rethrow 的路要讓呼叫端原樣丟，不可自己先吐訊息');
  const pw = fallbackProbe({ err: Object.assign(new Error('密碼不對'), { code: 'pdf_password' }) });
  assert.equal(pw.out, 'rethrow');
  assert.equal(pw.calls.consent, 0);
  // 認不得＝offered：原句先講（按取消後仍看得到，所以不必給 openForm 加 onCancel）
  const ok = fallbackProbe({ err: Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { code: 'bank_unrecognized' }) });
  assert.equal(ok.out, 'offered');
  assert.deepEqual(ok.calls.notify, ['這份 PDF 看起來不是台新銀行綜合對帳單'], '要吐模板的**原句**，不是改寫版');
  assert.equal(ok.calls.consent, 0, '排程之前不可直接開窗');
  ok.runScheduled();
  assert.equal(ok.calls.consent, 1);
});

test('D2｜runAiFallback：切頁的兩顆競態——排程當下與 callback 執行時各驗一次', () => {
  const staleNow = fallbackProbe({ err: { code: 'bank_unrecognized', message: 'x' }, canOpen: () => false });
  assert.equal(staleNow.out, 'stale');
  assert.equal(staleNow.calls.consent, 0);
  assert.equal(staleNow.calls.notify.length, 0, '已經切頁就別再吐 toast');
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
  assert.match(html, /送出哪一份/);
  assert.match(html, /2026-06 對帳單\.pdf/, '要顯示送的是哪一份檔案');
  assert.match(html, /Anthropic/, '要講送去哪裡');
  assert.match(html, /幾塊台幣/, '要講大概多少錢');
  assert.match(html, /不是報價|以他們的帳單為準/, '費用要標明是級距不是報價');
  assert.match(html, /不同意/, '要講不同意會怎樣（手動記帳、其他功能照常）');
  assert.match(html, /每一次都會先問過你/, '★拍板：每次都問、不記住同意');
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
  // 跳脫：檔名是使用者給的
  const evil = aiConsentBodyHtml({ fileName: '<img src=x onerror=alert(1)>.pdf' });
  assert.match(evil, /&lt;img/);
  assert.doesNotMatch(evil, /<img src=x/);
  assert.match(aiConsentBodyHtml({}), /未命名檔案/, '沒檔名也要開得起來');
  // ⚠️ 這是 HTML 不是 markdown：`**粗體**` 會把星號原樣顯示給使用者看（要粗體請用 <b>）
  assert.doesNotMatch(html, /\*\*/, '畫面文案不可留 markdown 星號');
  assert.doesNotMatch(aiPreviewBadgeHtml({ engine: 'ai', aiModel: 'm' }), /\*\*/, '徽章同上');
  assert.ok(AI_CONSENT_TITLE.includes('AI') && AI_CONSENT_SUBMIT_LABEL.includes('同意'));
});

test('E2｜預覽徽章：模板回空字串；AI 版要講「誰讀的」與「驗不到什麼」，模型名要跳脫', () => {
  assert.equal(aiPreviewBadgeHtml({ rows: [] }), '', '模板路線不可長出徽章');
  assert.equal(aiPreviewBadgeHtml(null), '');
  assert.equal(aiPreviewBadgeHtml(undefined), '');
  assert.equal(aiPreviewBadgeHtml({ engine: 'template' }), '');
  const html = aiPreviewBadgeHtml({ engine: 'ai', aiModel: 'claude-haiku-4-5-20251001' });
  assert.match(html, /AI 幫你讀出來的/);
  assert.match(html, /claude-haiku-4-5-20251001/);
  // ★誠實劃界的白話版：這句必須在畫面上（不可只藏在 <details> 裡）
  const firstDetails = html.indexOf('<details');
  const visible = firstDetails >= 0 ? html.slice(0, firstDetails) : html;
  assert.match(visible, /驗算|扣不扣得起來/, '驗算的射程要講');
  assert.match(visible, /機構名|帳號|摘要/, '★「驗不到什麼」必須在畫面上，不可只藏在展開區');
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

test('F｜cashflow.js 接線：三條 preview 路徑各自正確、apply 走 applyBody、徽章真的插進畫面', () => {
  const src = srcOf('public/modules/cashflow.js');
  // 三條 preview 路徑：上傳窗（無密碼）／密碼窗／同意窗（唯一帶 useAi 的那條）
  assert.equal(count(src, /body: previewBody\(\{/g), 3, '三條 preview 路徑都要走 previewBody（漏一條＝那條路的判準沒被守住）');
  assert.match(src, /previewBody\(\{ data: b64, password: pw, useAi: true \}\)/, '★同意窗那條才帶 useAi');
  assert.match(src, /previewBody\(\{ data: b64 \}\)/, '上傳窗那條不帶旗標');
  assert.match(src, /previewBody\(\{ data: b64, password: pw \}\)/, '密碼窗那條不帶旗標');
  assert.equal(count(src, /useAi: true/g), 1, '★全檔只有同意窗那一處帶旗標——多一處＝有帳單沒問過就外送');
  // apply 走 applyBody（插值形，不是只出現函式名）
  assert.match(src, /const payload = applyBody\(r, \{ data: b64, password: pw \}\);/, 'apply 的 body 要由 applyBody 產（AI 走票、模板走檔案）');
  assert.match(src, /body: payload/, '算出來的 payload 要真的送出去（算了不用＝白算）');
  assert.match(src, /if \(!payload\) \{[^}]*AI_PREVIEW_LOST_TEXT/, '票不見＝引導重新預覽，不可退回「送 data 讓它自己再解一次」');
  assert.doesNotMatch(src, /body: \{ data: b64, password: pw \}/, 'apply 的裸物件要被換掉，否則 AI 路線的票永遠帶不出去');
  // 徽章：插值形（只鎖呼叫名的話，`${(f(r), '')}` 會過）
  assert.match(src, /\$\{aiPreviewBadgeHtml\(r\)\}/, '徽章要真的插進 body 字串');
  // 兩條 fallback：上傳窗與密碼窗各一（少一條＝加密帳單走不到 AI）
  assert.equal(count(src, /runAiFallback\(\{ err: e, canOpenNext, notify:/g), 2, '上傳窗與密碼窗都要有 AI 救援路徑');
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
