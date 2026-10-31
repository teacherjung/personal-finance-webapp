// @ts-check
// #modal-root 世代擁有權（P0.5 r6→r9）：純邏輯行為題（DOM 無關）＋ 全站開窗點的接線形狀題。
// 為什麼要它：全站表單 onSubmit 有 await，回來時可能 (1) 使用者已換頁、或 (2) 期間開了新彈窗——
// 舊的成功 continuation 不可 close() 掉後開的彈窗、也不可在新頁報過期錯誤。
// owns() 用兩個判準判「這一格還是不是我的」：世代章（開窗/關窗都蓋章）＋**換頁**序號。
// ⚠️ r9 的核心教訓：判準②吃的必須是「換頁」序號，不是「重繪」序號。r7 接成重繪序號（routeSeq），
//   開機報價更新這種**同頁背景重繪**就把擁有權撤掉了——存檔成功卻不關窗、儲存鈕永遠灰。
/* global document, KeyboardEvent */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeModalOwnership } from '../public/modules/modal-ownership.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('擁有權｜新 claim 讓舊持有者的 owns() 立刻變 false；最新的一份 owns() 為 true', () => {
  let cell = 0;   // 假的共用格（＝真實碼裡 #modal-root 的 dataset.modalGen）
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const ownsA = claim();
  assert.equal(ownsA(), true, '剛 claim＝擁有');
  const ownsB = claim();   // 第二個彈窗接管
  assert.equal(ownsA(), false, '被後來的 claim 蓋章＝舊的不再擁有（舊 async close 就作廢）');
  assert.equal(ownsB(), true, '最新的一份擁有');
  const ownsC = claim();
  assert.deepEqual([ownsA(), ownsB(), ownsC()], [false, false, true], '永遠只有最新那一份 owns');
});

test('擁有權｜owns() 讀的是「當下」的章（外部把格清成 0 也不再擁有）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true);
  cell = 0;   // 例如 modal-root 被清空、dataset 沒了
  assert.equal(owns(), false, '章不見了＝不擁有（不會誤 close 空格或別人的內容）');
});

test('擁有權｜release() 撤銷擁有權：關窗後舊持有者的 owns() 立刻變 false（不再誤 close/toast）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true, '剛 claim＝擁有');
  owns.release();   // 關窗＝撤銷
  assert.equal(owns(), false, '關窗後舊 async 回來時 owns() 為 false＝不會對已關的窗 close/toast');
});

// ⭐ r9（Codex r8 Medium①的「本 PR 新種下」那半）：release 必須**有主才撤**。
// 舊窗的 close 若無條件蓋章，會把**後開那個窗**的擁有權一起洗掉——等於幫下一個 stale continuation 開門。
test('⭐ 擁有權｜release 有主才撤：不是主人時呼叫 release，不可洗掉現任的擁有權', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const ownsOld = claim();
  const ownsNew = claim();            // 新窗接管
  assert.deepEqual([ownsOld(), ownsNew()], [false, true]);
  ownsOld.release();                  // 舊窗的 close 這時才跑（stale）
  assert.equal(ownsNew(), true, '舊窗 release 不可把現任的章洗掉（否則新窗立刻變成無主、任人 close）');
  ownsNew.release();
  assert.equal(ownsNew(), false, '現任自己 release 才算數');
});

// ⭐ r9 核心回歸題：同頁重繪 ≠ 換頁。這一題直接鎖住 r7 那顆「存檔成功卻不關窗、儲存鈕永遠灰」的 bug。
test('⭐ 擁有權｜同一頁的背景重繪不可撤銷擁有權；使用者真的換頁才失效', () => {
  let cell = 0, nav = 3;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; }, readNav: () => nav });
  const owns = claim();
  assert.equal(owns(), true, '同一頁、章沒動＝擁有');
  // 開機報價更新／自動快照／帳戶對齊都會在同一頁呼叫 router()：重繪序號會跳，但**換頁序號不動**。
  assert.equal(owns(), true, '同頁重繪不影響擁有權（r7 接成重繪序號時這裡會是 false＝送出成功卻不關窗）');
  nav = 4;   // 使用者真的換頁
  assert.equal(owns(), false, '換頁後舊 async 的 close/toast 才作廢');
});

// ⭐ r18（Codex 抓到的第二顆真實產線 bug）：密碼窗**送出後**等 preview，再開下一窗（預覽窗）。
// 難點：正常交接本來就會蓋兩次章（自己關窗時 release、下一窗 claim），所以不能用 owns()／watch() 判
// ——那會把正常流程整個誤擋。⚠️ handoff() 分辨的**不是**「動這一格的是不是我自己」（取消也是自己關的）
// ——而是**這次關窗有沒有帶交接授權**：只放行①還沒關窗 ②以 handoff:true 成功交棒之後。
test('⭐ 擁有權｜handoff()：**送出成功**的自動關窗要放行；別人接管要擋', () => {
  // 正常路徑：密碼窗送出 → 送出成功的自動關窗（release({handoff:true})）→ 排程的預覽窗要開得成
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns.handoff(), true, '還沒關窗＝當然可以排下一窗（onSubmit 裡排程的當下）');
  owns.release({ handoff: true });       // openForm 的 closeAfterSubmit()
  assert.equal(owns(), false, '關了就不再擁有');
  assert.equal(owns.handoff(), true, '⚠️ 帶了交接授權的關窗＝正常交接，必須放行（取消版的關窗則不行，見下一題）');

  // 壞路徑①：使用者關掉密碼窗、又開了別的窗 → 舊 preview 不可以蓋掉它
  const later = claim();
  assert.equal(owns.handoff(), false, '別人接管了＝舊 preview 不可以開');
  assert.equal(later(), true, '新窗自己仍是主人');

  // 壞路徑②：等待期間就被搶走（我的 close 因為 owns() 已 false 而整個沒跑）
  let cell2 = 0;
  const claim2 = makeModalOwnership({ readGen: () => cell2, writeGen: (g) => { cell2 = g; } });
  const mine = claim2();
  claim2();                              // 別人接管
  mine.release({ handoff: true });       // 有主才撤＝這次是空操作
  assert.equal(mine.handoff(), false, '被搶走之後 release 是空操作，不可以因此誤判成「我自己交棒」');
});

// ⭐ r20（Codex 抓到的第三顆）：使用者按 ×／取消／背景關窗**不是交接、是撤銷**。
// 他都把窗關掉了，在途的 preview 回來還把下一窗彈出來＝把他剛丟掉的東西又推回他面前。
test('⭐ 擁有權｜使用者取消（release 不帶 handoff）＝撤銷，之後不准再開下一窗', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  owns.release();                        // ×／取消／背景關窗走的是這一條（預設不帶交接授權）
  assert.equal(owns(), false);
  assert.equal(owns.handoff(), false, '使用者取消之後，晚回來的 preview 不可以再彈下一窗');

  // 預設值就是保守的：新呼叫端忘了指名 handoff 時，寧可少開一個窗
  let cell2 = 0;
  const claim2 = makeModalOwnership({ readGen: () => cell2, writeGen: (g) => { cell2 = g; } });
  const o2 = claim2();
  o2.release({});                        // 給了物件但沒指名
  assert.equal(o2.handoff(), false, 'handoff 預設 false＝沒指名就當撤銷（保守預設）');
});

test('⭐ 擁有權｜handoff() 也看換頁：送出成功關窗但使用者已換頁＝不開', () => {
  let cell = 0, nav = 1;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; }, readNav: () => nav });
  const owns = claim();
  owns.release({ handoff: true });
  assert.equal(owns.handoff(), true, '同一頁、送出成功關的＝可以開下一窗');
  nav = 2;
  assert.equal(owns.handoff(), false, '換頁後下一窗不屬於眼前畫面');
});

// ⭐ r16（Codex 抓到的真實產線 bug）：開窗**之前**還有 await 的地方（先問 /api/mode 再開密碼窗），
// 等待期間使用者可能關掉眼前的窗、改開別的窗——晚回來的那一窗不可以蓋上去。
// watch() 是**唯讀**版：只回報「從我看的那一刻起沒人動過這一格」，不蓋章、不搶擁有權。
test('⭐ 擁有權｜watch() 唯讀觀察：期間有人接管或撤銷就變 false，且**不可**搶走現任的擁有權', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const ownsOpen = claim();                 // 眼前開著一個窗（例如上傳帳單窗）
  const unchanged = claim.watch();          // 問 /mode 之前看一眼
  assert.equal(unchanged(), true, '沒人動過＝可以開下一窗');
  assert.equal(ownsOpen(), true, '⚠️ watch 不可以蓋章：現在那個窗必須還是自己的（否則它連自己都關不掉）');

  ownsOpen.release();                       // 使用者按了 × 關掉上傳窗
  assert.equal(unchanged(), false, '眼前那個窗被關掉＝晚回來的密碼窗不可以再開');

  let cell2 = 0;
  const claim2 = makeModalOwnership({ readGen: () => cell2, writeGen: (g) => { cell2 = g; } });
  const watch2 = claim2.watch();
  claim2();                                 // 期間別人開了新窗
  assert.equal(watch2(), false, '別人接管了這一格＝晚回來的窗不可以蓋掉它');
});

test('⭐ 擁有權｜watch() 也看換頁：等待期間使用者換頁＝不開', () => {
  let cell = 0, nav = 1;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; }, readNav: () => nav });
  const unchanged = claim.watch();
  assert.equal(unchanged(), true);
  nav = 2;
  assert.equal(unchanged(), false, '換頁後晚回來的窗不屬於眼前畫面');
});

test('擁有權｜沒給 readNav 時退化成純世代章判準（相容不看換頁的呼叫端）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true, '沒有 readNav＝不看換頁，只看章');
});

/** 去註解（接線題掃原始碼形狀，先拿掉註解）。 @param {string} raw */
function strip(raw) { return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }

test('接線｜openForm 的 async onSubmit 只在 owns() 時 close/toast；關窗即 release；ownership 吃換頁序號', () => {
  const app = strip(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
  assert.match(app, /export function claimModalRoot\(\)/, 'claimModalRoot 存在');
  assert.match(app, /readNav: \(\) => currentNavSeq\(\)/, 'ownership 要吃**換頁**序號 currentNavSeq；且包一層箭頭避 TDZ');
  assert.doesNotMatch(app, /readNav: \(\) => currentRouteSeq\(\)/, '不可接回重繪序號 routeSeq（r7 的 bug 來源）');
  assert.match(app, /const owns = claimModalRoot\(\);/, 'openForm 要在開窗當下 claim 並留 owns');
  // 2026-08-18（進度串流）起 ctx 多一把 setProgress——擁有權語意不變：仍是同一個 owns、仍只在
  // owns() 時才關窗。斷言放寬到「ctx 帶 owns」而非整串字面，但**保留 owns() 守門那半段**。
  assert.match(app, /await onSubmit\(out, \{ owns[^)]*\}\); if \(owns\(\)\) closeAfterSubmit\(\);/,
    'onSubmit 後只在仍擁有時才關窗；並把自己的擁有權把手交給 onSubmit（r18：後續開窗要據它判斷有沒有被接管）');
  assert.match(app, /const setProgress = \([\s\S]{0,200}?if \(!progressEl \|\| !owns\(\) \|\| !text\) return;/,
    '★進度筆也吃 owns()：切頁／被接管之後不得再往別人的窗寫字（同 r6 的理由）');
  // r20：兩種關窗必須分開——使用者按 ×／取消／背景＝撤銷（不留交接授權），送出成功才交棒
  assert.match(app, /const close = \(\) => \{ root\.innerHTML = ''; owns\.release\(\); \};/,
    '使用者關窗走 owns.release()（不帶交接授權）');
  assert.match(app, /const closeAfterSubmit = \(\) => \{ root\.innerHTML = ''; owns\.release\(\{ handoff: true \}\); \};/,
    '送出成功的自動關窗才帶 handoff:true');
  assert.match(app, /\[data-cancel\]'\)\.onclick = close;/, '取消鈕要接**撤銷**版的 close（不可接成交棒版）');
  assert.match(app, /catch \(err\) \{ if \(owns\(\)\)/, '失敗也只在仍擁有時才 toast（不報過期錯誤）');
  assert.ok((app.match(/owns\.release\(\);/g) || []).length >= 2, 'openForm/openInfo 的 close 都要 owns.release()（有主才撤）');
  const shell = strip(readFileSync(join(ROOT, 'public/modules/modal-shell.js'), 'utf8'));
  assert.match(shell, /const owns = claimModalRoot\(\)/, 'openModalShell 也要 claim 並留 owns');
  assert.match(shell, /owns\.release\(\)/, 'openModalShell 的 close 也要 owns.release()');
});

// ⭐ r9→r10：換頁序號本身的定義題——只有**使用者眼前的完整 hash** 變了才前進。
//   接成「每次 router() 都前進」＝退化成重繪序號、bug 原地復活；接成「只比去掉 query 的 route」
//   ＝個股頁換股票不算換頁，舊表單的 continuation 會跑到新股票的畫面上（r10）。
test('⭐ 接線｜navSeq 只在使用者眼前的網址改變時才前進（同頁重繪不動它）', () => {
  const app = strip(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
  assert.match(app, /export const currentNavSeq = \(\) => navSeq;/, 'currentNavSeq 存在且回傳換頁序號');
  assert.match(app, /const navKey = location\.hash;/,
    '換頁鑰匙要用**完整 hash**（r10：個股頁的身分含 ?symbol=&tab=，只比 route 會漏掉換股票）');
  assert.match(app, /const navChanged = navKey !== lastNavKey;/,
    '是否換頁要留下單一判定，供換頁序號與手機導覽共用');
  assert.match(app, /if \(navChanged\) \{ lastNavKey = navKey; navSeq\+\+; \}/,
    'navSeq 只在使用者眼前的網址變了才前進（背景重繪不動網址＝照樣不前進）');
  assert.match(app, /if \(navChanged\) keepActiveNavVisible\(activeNav\);/,
    '手機導覽只在真的換頁時露出目前項目，同頁重繪不可搶回手動捲動位置');
  // routeSeq 仍要每次前進——它管的是「別覆蓋新頁面的畫面」，同頁重繪也該作廢舊寫入。
  assert.match(app, /const seq = \+\+routeSeq;/, 'routeSeq 維持每次 router() 都前進（重繪世代，勿一起改掉）');
});

// ⭐ r9：匯入流程的 onPage 也必須吃換頁序號——接成重繪序號時密碼窗會**靜靜不開**（使用者上傳完什麼都沒發生）。
test('⭐ 接線｜匯入流程的 onPage 吃 currentNavSeq（接成 routeSeq 時密碼窗會靜靜不開）', () => {
  for (const rel of ['public/modules/cashflow.js', 'public/modules/transactions-import.js']) {
    const src = strip(readFileSync(join(ROOT, rel), 'utf8'));
    assert.match(src, /const seq0 = currentNavSeq\(\);/, `${rel}：onPage 的基準要用換頁序號`);
    assert.match(src, /const onPage = \(\) => seq0 === currentNavSeq\(\);/, `${rel}：onPage 比的要是換頁序號`);
    assert.doesNotMatch(src, /onPage = \(\) => seq0 === currentRouteSeq\(\)/, `${rel}：不可用重繪序號當 onPage`);
  }
});

// ⭐ r10（Codex Medium①）：本 PR 新增的「全部清除帳單密碼」也是「使用者還在這一頁嗎」的問題。
// 接成重繪序號時：開機背景重繪一發生，清除**會成功**但提前 return——沒有成功提示、也不重讀，
// 畫面還顯示舊組數與清除鈕（看起來像沒清掉）。這一題鎖住它。
test('⭐ 接線｜「清除記住的帳單密碼」吃 currentNavSeq（同頁重繪不可吃掉成功提示與重讀）', () => {
  const src = strip(readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8'));
  const m = /const btn = byId\('clearStmtPws'\);[\s\S]*?\n {4}\};/.exec(src);
  assert.ok(m, '找不到「清除記住的帳單密碼」的接線區塊（改寫時要同步這一題）');
  const block = m[0];
  assert.doesNotMatch(block, /currentRouteSeq\(\)/,
    '清除流程不可用重繪序號判「還在不在設定頁」——背景重繪會讓成功提示與重讀被吃掉');
  assert.equal((block.match(/currentNavSeq\(\)/g) || []).length, 3,
    '基準一處＋成功分支一處＋失敗分支一處，三處都要用換頁序號');
});

// ⭐ 關門題（r7 要求盤點／r8 只比總數不夠／r10 中央三窗沒逐一驗／r12 箭頭函式假綠）：
// 任何**開窗點**（把 modal-bg 外殼寫進 #modal-root）都必須在**那次寫入之前**先 claimModalRoot()。
// 五次修訂換來的掃法。⚠️ **先講清楚它守得住什麼**（本檔末有完整的誠實劃界，別再宣稱「逐函式切段」）：
//   ①**最硬的一半＝釘住開窗寫入點的總數**：**偵測面內**多一個就轉紅，不管寫成哪種形狀
//     （偵測面＝原始碼直接看得到 `class=…modal-bg`；動態組字／變數 class／className／public 外都在面外）。
//   ②六個開窗點**逐一點名**驗「claim 在寫入之前」（r10：否則 openInfo 的 claim 會被 openForm 代打）。
//   ③段落以**頂層大括號深度**切、**刻意不辨識任何函式寫法**（r12：只認 `function` 宣告時，塞在兩個
//     開窗函式之間的**箭頭函式**開窗會被前一段吸收而假綠）。但**頂層以下切不開**——物件／class 的兩個
//     方法、同一外層函式裡的兩個巢狀函式仍共用一段（r14 實測），attribution 會錯；那時靠①先轉紅。
//   ④開窗記號認 `class=…modal-bg`（任何引號、不綁 `innerHTML =` 同一行；r16：單引號版曾整個繞過）。
const OPENERS = [
  ['public/app.js', 'openForm'],
  ['public/app.js', 'openInfo'],
  ['public/modules/modal-shell.js', 'openModalShell'],
  ['public/modules/assets.js', 'openRebalance'],
  ['public/modules/assets.js', 'openTargets'],
  ['public/modules/settings-store-rules.js', 'openRulePreview'],
];

// 開窗記號：把 `modal-bg` 當 class **寫進標記**就算一個開窗寫入點——**不綁引號種類、不綁 innerHTML**
// （r16：單引號的 `class='modal-bg'` 配 insertAdjacentHTML 曾整個繞過雙引號版的比對）。
// 刻意只認 `class=…modal-bg`，不認 `querySelector('.modal-bg')` 那種**讀取**（bindBackdropClose 會用到）。
// ⚠️ 偵測面＝原始碼裡直接看得到這個字樣；動態組字串（`'modal-' + 'bg'`）、用變數帶 class 名、
//   `className` 指派、或 public/ 以外的開窗仍在偵測面外——見本檔末的誠實劃界。
const MODAL_BG = /class\s*=\s*["'`]?[^"'`>]*modal-bg/;

/**
 * 把**註解／字串／樣板／正則字面值**的內容換成空白，**保留換行**（行號不跑掉）。
 * 只為了兩件事可信：①數大括號時不被字面值裡的括號騙 ②`class="modal-bg"`／`claimModalRoot()`
 * 的比對不會命中註解裡的字。
 * ⚠️ 不共用檔案上方的 `strip()`：那一份會把區塊註解連換行一起吃掉（行號會漂），也不處理正則。
 * @param {string} src
 * @param {boolean} [keepStrings] true＝保留字串/樣板**內容**（找 `class="modal-bg"` 這種寫在樣板裡的記號用），
 *   註解與正則照樣清掉；false（預設）＝連字串內容一起清（數大括號與找 `claimModalRoot()` 用）。
 * @returns {string}
 */
function blankNonCode(src, keepStrings = false) {
  const keepNl = (/** @type {string} */ ch) => (ch === '\n' ? '\n' : ' ');
  let out = '', i = 0;
  const n = src.length;
  // 正則字面值的判定：`/` 前面最近的一個有意義字元決定它是除號還是正則開頭（標準啟發式）
  const RX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'new', 'delete', 'void', 'throw']);
  const regexOk = () => {
    let k = out.length - 1;
    while (k >= 0 && (out[k] === ' ' || out[k] === '\n' || out[k] === '\t')) k--;
    if (k < 0) return true;   // 檔案開頭
    if ('(,=:[!&|?{};+-*%~^'.includes(out[k])) return true;
    // 關鍵字後面的 `/` 也是正則開頭：`return /[}]/.test(x)` 只看前一個字元會被當成除號（r14 抓到）
    if (/[A-Za-z0-9_$]/.test(out[k])) {
      let w = '';
      while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) { w = out[k] + w; k--; }
      return RX_KEYWORDS.has(w);
    }
    return false;
  };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && c2 === '*') { out += '  '; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += keepNl(src[i]); i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { out += keepStrings ? src.slice(i, i + 2) : '  '; i += 2; continue; }
        out += keepStrings ? src[i] : keepNl(src[i]); i++;
      }
      if (i < n) { out += c; i++; }
      continue;
    }
    if (c === '/' && regexOk()) {
      out += '/'; i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        out += ' '; i++;
      }
      if (i < n && src[i] === '/') { out += '/'; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * 依**頂層大括號深度**切段：深度回到 0 之後的下一個有內容的行＝下一段開始。
 * **刻意不辨識任何函式寫法**——arrow／function／method 都各自成段，claim 跨不過段界（r12 那一刀的解法）。
 * @param {string} src @returns {{name:string, from:number, to:number}[]}
 */
function topLevelSegments(src) {
  const raw = src.split('\n');
  const flat = blankNonCode(src).split('\n');
  /** @type {{name:string, from:number, to:number}[]} */ const segs = [];
  let depth = 0;
  flat.forEach((line, i) => {
    if (depth === 0 && line.trim() !== '') {
      const head = raw[i];
      const m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(head)
        || /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)/.exec(head);
      segs.push({ name: m ? m[1] : `line${i + 1}`, from: i, to: raw.length });
    }
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  });
  // 大括號沒收平＝掃法被字面值/註解騙了：**大聲失敗**，不可以靜靜當成掃過了（靜靜通過最危險）
  assert.equal(depth, 0, '大括號深度沒有回到 0——blankNonCode 漏處理了某種字面值/註解，這道關門題已不可信');
  segs.forEach((sg, i) => { if (segs[i + 1]) sg.to = segs[i + 1].from; });
  return segs;
}

/**
 * 掃出每個「含開窗寫入」的段落，並判斷該段是否**在每次寫入之前**都已 claim。
 * @param {string} src @returns {{name:string, line:number, ok:boolean}[]}
 */
function scanOpeners(src) {
  const code = blankNonCode(src).split('\n');            // 清掉字串＝`claimModalRoot()` 不會命中註解/字串裡的字
  const marked = blankNonCode(src, true).split('\n');    // 留字串＝樣板裡的 modal-bg 記號才看得到
  /** @type {{name:string, line:number, ok:boolean}[]} */ const found = [];
  for (const sg of topLevelSegments(src)) {
    let claimed = false, ok = true, writes = 0, firstWrite = -1;
    for (let i = sg.from; i < sg.to; i++) {
      if (/claimModalRoot\(\)/.test(code[i])) claimed = true;
      if (MODAL_BG.test(marked[i])) {
        writes++; if (firstWrite < 0) firstWrite = i;
        if (!claimed) ok = false;
      }
    }
    if (writes) found.push({ name: sg.name, line: firstWrite + 1, ok });
  }
  return found;
}

// ⭐ r12：先驗**掃描器本身**擋不擋得住 Codex 那一刀（沒 claim 的頂層箭頭函式開窗）。
// 掃描器自己就是保證的承重點——它假綠的話，下面兩題再漂亮也守不到東西。
test('⭐ 關門題的掃描器自身：沒 claim 的箭頭函式開窗必須被抓出來（r12 那一刀）', () => {
  const claimedFn = `function openA() {\n  const root = byId('modal-root');\n  claimModalRoot();\n  root.innerHTML = \`<div class="modal-bg">A</div>\`;\n}\n`;
  const sneakyArrow = `const openSneaky = () => {\n  const root = byId('modal-root');\n  root.innerHTML = \`<div class="modal-bg">偷開的</div>\`;\n};\n`;
  const claimedArrow = `const openB = () => {\n  claimModalRoot();\n  byId('modal-root').innerHTML = \`<div class="modal-bg">B</div>\`;\n};\n`;

  const good = scanOpeners(claimedFn);
  assert.deepEqual(good.map(o => [o.name, o.ok]), [['openA', true]], '有 claim 的 function 開窗＝通過');

  // 這就是 r12 的突變：把箭頭函式塞在已 claim 的 function **後面**
  const mutated = scanOpeners(claimedFn + sneakyArrow);
  assert.equal(mutated.length, 2, '箭頭函式開窗要被當成獨立的開窗點（不可被前一段吸收）');
  assert.deepEqual(mutated.map(o => [o.name, o.ok]), [['openA', true], ['openSneaky', false]],
    '前一個函式的 claim 不可以跨段替箭頭函式背書');

  assert.deepEqual(scanOpeners(claimedArrow).map(o => o.ok), [true], '箭頭函式自己有 claim＝通過（不可假紅）');
  // 合法但順序刁鑽：先 claim 再宣告別名再寫入（r8 以別名切段的舊寫法會誤判成紅）
  const aliasAfterClaim = `function openC() {\n  claimModalRoot();\n  const root = byId('modal-root');\n  root.innerHTML = \`<div class="modal-bg">C</div>\`;\n}\n`;
  assert.deepEqual(scanOpeners(aliasAfterClaim).map(o => o.ok), [true], '先 claim 再宣告別名＝合法，不可假紅');
});

test('⭐ 接線｜六個開窗點**逐一**驗「先 claim 再寫入」（中央三窗不可被彼此代打）', () => {
  for (const [rel, fnName] of OPENERS) {
    const found = scanOpeners(readFileSync(join(ROOT, rel), 'utf8'));   // 傳原始碼：scanOpeners 自己有 blankNonCode（用 strip 會二次處理、行號還會漂）
    const hit = found.find(o => o.name === fnName);
    assert.ok(hit, `${rel}：掃不到開窗點 ${fnName}（改名或改寫法要同步點名表，否則這題會假綠）`);
    assert.ok(hit.ok, `${rel}:${fnName}（第 ${hit.line} 行）在寫入 #modal-root 之前沒有 claimModalRoot()`);
  }
});

test('⭐ 接線｜六個開窗點都接上同一份鍵盤與焦點管理，不可只修中央外殼', () => {
  for (const [rel, fnName] of OPENERS) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const segment = topLevelSegments(src).find(s => s.name === fnName);
    assert.ok(segment, `${rel}：找不到 ${fnName} 的頂層段落`);
    const block = blankNonCode(src).split('\n').slice(segment.from, segment.to).join('\n');
    assert.match(block, /bindModalAccessibility\(/,
      `${rel}:${fnName} 要接 bindModalAccessibility，否則手刻彈窗會漏掉 Esc、Tab 與焦點歸還`);
  }
});

/** 遞迴列出 public/ 底下所有 .js。 @param {string} dir @returns {string[]} */
function listJs(dir) {
  /** @type {string[]} */ const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// 開窗寫入點的**總數**（`class=…modal-bg` 出現在正式碼的次數）。釘死它是這道關門題**最硬的一半**：
// **偵測面內**不管新開窗點寫成什麼形狀（頂層函式／箭頭／物件方法／class 方法／巢狀函式、單雙引號、
// innerHTML 或 insertAdjacentHTML），只要多一個，這個數字就對不上、直接轉紅，逼人來這裡登記並補 claim。
// ⚠️ **偵測面＝原始碼裡直接看得到 `class=…modal-bg`**；動態組字串、變數帶 class 名、`className` 指派、
//   或 `public/` 以外開的窗都在偵測面外（r16/r18 誠實劃界，別再寫成「任何形狀」）。
const EXPECTED_OPEN_WRITES = 6;

test('⭐ 接線｜全站開窗寫入點的**總數**被釘住（**偵測面內**任何形狀的新開窗點都會讓它轉紅）', () => {
  let total = 0;
  /** @type {string[]} */ const where = [];
  for (const f of listJs(join(ROOT, 'public'))) {
    const rel = relative(ROOT, f).split('\\').join('/');
    blankNonCode(readFileSync(f, 'utf8'), true).split('\n').forEach((line, i) => {
      if (MODAL_BG.test(line)) { total++; where.push(`${rel}:${i + 1}`); }
    });
  }
  assert.equal(total, EXPECTED_OPEN_WRITES,
    `開窗寫入點的數量變了（現在是 ${total}）：${where.join('、')}\n` +
    '新增開窗點請①在該處 claimModalRoot() ②加進 OPENERS 點名表 ③更新 EXPECTED_OPEN_WRITES。');
});

test('⭐ 接線｜全站掃描：掃得到的開窗段落都要「先 claim 再寫入」，且要在點名表裡', () => {
  const roster = new Set(OPENERS.map(([rel, fn]) => `${rel}:${fn}`));
  for (const f of listJs(join(ROOT, 'public'))) {
    const rel = relative(ROOT, f).split('\\').join('/');
    for (const o of scanOpeners(readFileSync(f, 'utf8'))) {
      assert.ok(o.ok, `${rel}:${o.name}（第 ${o.line} 行）在寫入 #modal-root 之前沒有 claimModalRoot()——手刻彈窗一律要先宣告接管`);
      assert.ok(roster.has(`${rel}:${o.name}`),
        `${rel}:${o.name} 是新的開窗點，請加進 OPENERS 點名表（逐一驗證那題才守得到它）`);
    }
  }
});

// ⚠️⚠️ **這道關門題的誠實劃界（r14，別再誇大它）**：
//   **守得住的**：①開窗寫入點的總數（上面那題，**偵測面內**任何形狀都逃不掉）②點名表上這六個開窗點的
//     「claim 在寫入之前」（名字錨定，改名或拿掉 claim 都會紅）③頂層函式／頂層箭頭函式的新開窗點。
//   **守不住的（已知盲點，Codex r14 實測）**：段落切法只看**頂層**大括號深度，所以
//     **物件字面值／class 裡的兩個方法**、或**同一個外層函式裡的兩個巢狀函式**會共用同一段——
//     前一個的 claim 會替後一個未 claim 的開窗背書（attribution 錯，但**總數那題仍會先轉紅**）。
//   真正的解法是 AST（依函式節點掃）或把 #modal-root 收斂成唯一寫入 API＝候選 8-16；
//   在那之前**不要**在契約或題名上宣稱「逐函式切段」這種撐不住的保證（誇大比缺口更糟）。
test('關門題的已知盲點（characterization）：同一段裡的第二個未 claim 開窗會被前一個背書', () => {
  const twoMethods = [
    'const windows = {',
    '  openA() {',
    '    claimModalRoot();',
    '    byId(\'modal-root\').innerHTML = `<div class="modal-bg">A</div>`;',
    '  },',
    '  openB() {',
    '    byId(\'modal-root\').innerHTML = `<div class="modal-bg">B 沒 claim</div>`;',
    '  },',
    '};',
  ].join('\n');
  const scanned = scanOpeners(twoMethods);
  assert.deepEqual(scanned.map(o => o.ok), [true],
    '⚠️ 已知盲點：物件方法共用一段，第二個未 claim 的開窗掃不出來。' +
    '改成 AST／唯一寫入 API（候選 8-16）之後，這一題會轉紅——那時請把它改寫成 ok:false 的正向斷言。');
});

let accessibilityApp;
async function bootAccessibilityApp() {
  if (accessibilityApp) return accessibilityApp;
  const dom = new JSDOM(`<!doctype html><html><body>
    <nav id="nav"><a href="#dashboard" data-route="dashboard">總覽</a></nav>
    <button id="modalOpener">開啟說明</button><button id="snapshotBtn"></button>
    <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
  </body></html>`, { url: 'http://localhost/#dashboard', pretendToBeVisual: true });
  const win = dom.window;
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  for (const key of ['document', 'window', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event',
    'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) {
    set(key, win[key]);
  }
  set('fetch', async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  accessibilityApp = await import('../public/app.js');
  await accessibilityApp.bootSettled;
  await new Promise(resolve => setTimeout(resolve, 0));
  return accessibilityApp;
}

test('主導覽｜路由只標目前頁並在手機溢位時把目前項目捲進可見範圍', async () => {
  const app = await bootAccessibilityApp();
  const nav = /** @type {HTMLElement} */ (document.getElementById('nav'));
  nav.innerHTML = `<a href="#dashboard" data-route="dashboard" class="active" aria-current="page">總覽</a>
    <a href="#settings" data-route="settings">設定</a>`;
  const dashboard = /** @type {HTMLElement} */ (nav.querySelector('[data-route="dashboard"]'));
  const settings = /** @type {HTMLElement} */ (nav.querySelector('[data-route="settings"]'));
  Object.defineProperties(nav, {
    scrollWidth: { value: 600, configurable: true },
    clientWidth: { value: 300, configurable: true },
    scrollLeft: { value: 0, writable: true, configurable: true },
  });
  nav.getBoundingClientRect = () => /** @type {any} */ ({ left: 0, right: 300 });
  settings.getBoundingClientRect = () => /** @type {any} */ ({ left: 400, right: 500 });
  let scrolledTo = null;
  nav.scrollTo = (/** @type {{left:number}} */ options) => {
    scrolledTo = options.left;
    nav.scrollLeft = options.left;
  };

  globalThis.window.history.replaceState(null, '', '#settings');
  await app.router();
  await new Promise(resolve => setTimeout(resolve, 30));

  const current = [...nav.querySelectorAll('[aria-current="page"]')];
  assert.equal(current.length, 1, '切頁後只准目前頁保留 aria-current，離開的頁面要移除');
  assert.equal(current[0], settings, 'aria-current 與 active 都要落在真正的目前頁');
  assert.ok(settings.classList.contains('active'));
  assert.equal(nav.querySelector('[data-route="dashboard"]')?.classList.contains('active'), false);
  assert.equal(scrolledTo, 234, '目前項目在右側可視區外時，要把它捲回右側保留區之內');

  nav.scrollLeft = 0;
  scrolledTo = null;
  await app.router();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(scrolledTo, null, '同一頁背景重畫時，不可把使用者手動捲開的導覽拉回目前項目');

  nav.scrollLeft = 234;
  scrolledTo = null;
  dashboard.getBoundingClientRect = () => /** @type {any} */ ({ left: -228, right: -128 });
  globalThis.window.history.replaceState(null, '', '#dashboard');
  await app.router();
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(document.querySelector('#nav [aria-current="page"]'), dashboard,
    '從深層頁回到左側頁面時，aria-current 也要跟著換回來');
  assert.equal(scrolledTo, 0, '目前項目在左側可視區外時，要把導覽捲回最左邊');
});

test('共用彈窗｜有 dialog 語意、焦點進入、Tab 不逸出、Esc 關閉並把焦點還給開窗按鈕', async () => {
  const app = await bootAccessibilityApp();
  const opener = document.getElementById('modalOpener');
  opener.focus();
  app.openInfo('鍵盤測試', '<p>說明內容 <a id="insideLink" href="#help">延伸說明</a></p>', {
    actionsHtml: '<span style="display:none"><button type="button" id="hiddenAction">隱藏操作</button></span>',
  });
  await Promise.resolve();

  const dialog = document.querySelector('#modal-root .modal');
  const close = dialog.querySelector('.x-close');
  const confirm = dialog.querySelector('[data-close]');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const labelledBy = dialog.getAttribute('aria-labelledby');
  assert.ok(labelledBy, '彈窗要由標題提供可讀名稱');
  assert.equal(document.getElementById(labelledBy)?.textContent, '鍵盤測試');
  assert.equal(close.getAttribute('aria-label'), '關閉');
  assert.equal(document.activeElement, dialog,
    '資訊窗沒有明確標記初始目標時，焦點要停在有名稱的對話框，不可從連結或按鈕猜語意');

  confirm.focus();
  confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, close, '隱藏容器裡的控制項不算 Tab 順序；最後一格按 Tab 要回到第一格');
  close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, confirm, '在第一個控制項按 Shift+Tab 要回到最後一個控制項');

  confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));   // 等 MutationObserver 看見 root 真的關空後歸還焦點
  assert.equal(document.querySelector('#modal-root .modal'), null, 'Esc 要關閉目前彈窗');
  assert.equal(document.activeElement, opener, '關窗後焦點要回到原本的開窗按鈕');

  app.openForm({
    title: '隱藏欄位測試',
    fields: [{ key: 'hidden', label: '隱藏' }, { key: 'visible', label: '可見' }],
    onSubmit: async () => {},
    onMount: root => { root.querySelector('#f_hidden').parentElement.style.display = 'none'; },
  });
  await Promise.resolve();
  assert.equal(document.activeElement?.id, 'f_visible', '第一個欄位若被 onMount 隱藏，焦點要跳到下一個可見欄位');
  document.querySelector('#modal-root .x-close').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.activeElement, opener, '表單關閉後也要把焦點還給開窗按鈕');

  app.openInfo('第一窗', '<p>先預覽</p>', { actionsHtml: '<button type="button" id="openNext">下一窗</button>' });
  await Promise.resolve();
  document.getElementById('openNext').focus();
  app.openInfo('第二窗', '<p>已接管第一窗</p>');
  await Promise.resolve();
  document.querySelector('#modal-root [data-close]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.activeElement, opener, '彈窗接管鏈全部結束後，要回到最初的頁面按鈕，不是已移除的上一窗按鈕');
});

test('共用彈窗｜焦點落在彈窗本體時，Shift+Tab 仍留在窗內', async () => {
  const app = await bootAccessibilityApp();
  app.openInfo('焦點本體', '<p>滑鼠點過的內文</p>');
  await Promise.resolve();
  const dialog = /** @type {HTMLElement} */ (document.querySelector('#modal-root .modal'));
  const last = document.querySelector('#modal-root [data-close]');
  dialog.focus();
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, last, '彈窗本體也算焦點陷阱的邊界，Shift+Tab 要回最後一格');
  document.querySelector('#modal-root .x-close')?.click();
});

test('共用彈窗｜焦點意外跑到背景時，下一次 Tab 立即收回窗內', async () => {
  const app = await bootAccessibilityApp();
  const opener = /** @type {HTMLElement} */ (document.getElementById('modalOpener'));
  app.openInfo('背景回收', '<p>焦點不可留在遮罩後面</p>');
  await Promise.resolve();
  const first = document.querySelector('#modal-root .x-close');
  opener.focus();
  opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, first, '窗開著時，背景元素送出的 Tab 也要由共用陷阱接回來');
  document.querySelector('#modal-root .x-close')?.click();
});

test('共用彈窗｜沒有明確標記時，初始焦點留在對話框本體', async () => {
  await bootAccessibilityApp();
  const { openModalShell } = await import('../public/modules/modal-shell.js');
  const { root } = openModalShell({
    title: '匯入完成',
    bodyHtml: '<button type="button" data-reassign>改到其他卡片</button><button type="button" data-done>完成</button>',
  });
  await Promise.resolve();
  const dialog = /** @type {HTMLElement} */ (root.querySelector('.modal'));
  assert.equal(document.activeElement, dialog,
    '沒有明確初始焦點標記時，不可把 Enter 預設導向第一個一般操作');
  root.querySelector('.x-close')?.click();
});

test('共用彈窗｜只有明確標記可接初始焦點，而且 autofocus 優先', async () => {
  await bootAccessibilityApp();
  const { openModalShell } = await import('../public/modules/modal-shell.js');
  let opened = openModalShell({
    title: '明確標記',
    bodyHtml: '<input id="declaredFocus" data-modal-initial><button id="nativeFocus" autofocus>原生優先</button>',
  });
  await Promise.resolve();
  assert.equal(document.activeElement?.id, 'nativeFocus', 'autofocus 要優先於專案自己的初始焦點標記');
  opened.root.querySelector('.x-close')?.click();

  opened = openModalShell({
    title: '專案標記',
    bodyHtml: '<button type="button" id="unmarkedAction">未標記</button><input id="declaredOnly" data-modal-initial>',
  });
  await Promise.resolve();
  assert.equal(document.activeElement?.id, 'declaredOnly', '沒有 autofocus 時，只接明確的 data-modal-initial');
  opened.root.querySelector('.x-close')?.click();
});

test('共用彈窗｜openForm 四種欄位都明確標記，動作按鈕一律不冒充初始焦點', async () => {
  const app = await bootAccessibilityApp();
  app.openForm({
    title: '欄位標記',
    fields: [
      { key: 'kind', label: '類型', type: 'select', options: ['甲', '乙'] },
      { key: 'note', label: '備註', type: 'textarea' },
      { key: 'applyAll', label: '全部套用', type: 'checkbox' },
      { key: 'name', label: '名稱' },
    ],
    onSubmit: async () => {},
  });
  await Promise.resolve();

  assert.deepEqual(
    [...document.querySelectorAll('#modalForm [data-modal-initial]')].map(el => el.id),
    ['f_kind', 'f_note', 'f_applyAll', 'f_name'],
    'select、textarea、是／否下拉與一般 input 都要標記，且只有真正編輯欄位可帶標記',
  );
  assert.equal(document.activeElement?.id, 'f_kind', '第一個可見的明確標記欄位仍是開窗焦點');
  assert.equal(document.querySelector('#modalForm [type="submit"]')?.hasAttribute('data-modal-initial'), false);
  assert.equal(document.querySelector('#modalForm [data-cancel]')?.hasAttribute('data-modal-initial'), false);
  document.querySelector('#modal-root .x-close')?.click();
});

test('共用彈窗｜沒有欄位的 openForm 停在對話框，不把同意送出鈕當初始焦點', async () => {
  const app = await bootAccessibilityApp();
  app.openForm({
    title: 'AI 同意確認',
    fields: [],
    submitLabel: '同意，送出去讀',
    onSubmit: async () => {},
  });
  await Promise.resolve();

  const dialog = /** @type {HTMLElement} */ (document.querySelector('#modal-root .modal'));
  assert.equal(
    document.querySelectorAll('#modalForm [autofocus], #modalForm [data-modal-initial]').length,
    0,
    '沒有編輯欄位時，取消與送出都不可自行取得初始焦點標記',
  );
  assert.equal(document.activeElement, dialog,
    '沒有欄位的同意窗要先停在 dialog，避免第一個 Enter 直接送出');
  document.querySelector('#modal-root .x-close')?.click();
});

test('共用彈窗｜返回型叉叉可用明確名稱覆寫預設的關閉語意', async () => {
  const app = await bootAccessibilityApp();
  const root = /** @type {HTMLElement} */ (document.getElementById('modal-root'));
  const owns = app.claimModalRoot();
  root.innerHTML = '<div class="modal-bg"><div class="modal"><div class="modal-head"><h2>預覽</h2><button class="x-close">×</button></div></div></div>';
  const close = () => { root.innerHTML = ''; owns.release(); };
  root.querySelector('.x-close').onclick = close;
  app.bindModalAccessibility(root, close, document.getElementById('modalOpener'), '回去繼續編輯');
  await Promise.resolve();
  assert.equal(root.querySelector('.x-close')?.getAttribute('aria-label'), '回去繼續編輯');
  root.querySelector('.x-close')?.click();
});

test('共用彈窗｜動作列的保護選項不是初始焦點', async () => {
  const app = await bootAccessibilityApp();
  app.openInfo('銀行對帳單預覽', '<p>請先核對內容</p>', {
    actionsHtml: '<label><input id="skipSimilarChk" type="checkbox" checked> 這次不匯入疑似重複</label><button type="button" id="bankApply">確認匯入</button>',
  });
  await Promise.resolve();

  const dialog = /** @type {HTMLElement} */ (document.querySelector('#modal-root .modal'));
  assert.equal(document.activeElement, dialog,
    '預覽窗未明確標記初始目標時要停在 dialog，不可把動作列勾選框當成主要欄位');
  document.querySelector('#modal-root .x-close')?.click();
});

test('共用彈窗｜輸入法組字中的兩種 Esc 訊號都不關窗、不丟掉尚未儲存的輸入', async () => {
  const app = await bootAccessibilityApp();
  app.openForm({
    title: '組字測試',
    fields: [{ key: 'note', label: '備註' }],
    values: { note: '已經打好的字' },
    onSubmit: async () => {},
  });
  await Promise.resolve();
  const input = /** @type {HTMLInputElement} */ (document.getElementById('f_note'));
  const dialog = document.querySelector('#modal-root .modal');
  const composingEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  Object.defineProperty(composingEscape, 'isComposing', { value: true });
  input.dispatchEvent(composingEscape);
  assert.equal(document.querySelector('#modal-root .modal'), dialog, '正在組字的 Esc 不可觸發關窗');
  assert.equal(input.value, '已經打好的字');

  const legacyComposingEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  Object.defineProperty(legacyComposingEscape, 'keyCode', { value: 229 });
  input.dispatchEvent(legacyComposingEscape);
  assert.equal(document.querySelector('#modal-root .modal'), dialog,
    '只回報舊式 keyCode 229 的組字事件也不可觸發關窗');
  assert.equal(input.value, '已經打好的字');
  document.querySelector('#modal-root .x-close')?.click();
});

test('共用彈窗外殼｜呼叫端覆寫叉叉為取消後，Esc 要走最新語意並收掉等待中的 Promise', async () => {
  await bootAccessibilityApp();
  const { openModalShell } = await import('../public/modules/modal-shell.js');
  /** @type {boolean|'pending'} */ let answer = 'pending';
  let finish;
  const settled = new Promise(resolve => { finish = resolve; }).then(value => {
    answer = /** @type {boolean} */ (value);
    return value;
  });
  const { root, close } = openModalShell({
    title: '匯出備份', size: 'sm', backdrop: false,
    bodyHtml: '<button type="button" data-cancel>取消</button><button type="button">確認匯出</button>',
  });
  const cancel = () => { close(); finish(false); };
  root.querySelector('[data-cancel]').onclick = cancel;
  root.querySelector('.x-close').onclick = cancel;
  await Promise.resolve();

  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const raced = await Promise.race([settled, new Promise(resolve => setTimeout(() => resolve('still-pending'), 30))]);
  assert.equal(raced, false, 'Esc 不可只清空外殼，必須走呼叫端最新的取消處理把 Promise 收掉');
  assert.equal(answer, false);
  assert.equal(root.innerHTML, '');
});

const settleModalFocus = () => new Promise(resolve => setTimeout(resolve, 0));

async function prepareReturnFocusCase() {
  const app = await bootAccessibilityApp();
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  await settleModalFocus();
  const view = document.getElementById('view');
  view.innerHTML = '<h1 id="returnHeading">目前頁面</h1><button id="returnOpener">開窗</button><button id="chosenFocus">其他操作</button>';
  document.getElementById('nav').innerHTML = '<a href="#settings" data-route="settings" aria-current="page">設定</a>';
  const opener = document.getElementById('returnOpener');
  opener.focus();
  app.openInfo('回復焦點', '<p>合成說明</p>');
  await Promise.resolve();
  return { app, root, view, opener, heading: document.getElementById('returnHeading') };
}

async function renderFocusRoute(app, hash) {
  const originalFetch = globalThis.fetch;
  const originalChart = Object.getOwnPropertyDescriptor(globalThis, 'Chart');
  // 焦點題需要正式路由的 DOM；圖表繪圖由其領域考題驗證。
  Object.defineProperty(globalThis, 'Chart', { configurable: true, value: class { destroy() {} } });
  globalThis.fetch = async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const data = /\/(transactions|subscriptions|cards|history)$/.test(path) ? []
      : /\/health$/.test(path) ? { items: [], dismissed: 0 }
        : /orphans/.test(path) ? { items: [] } : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    globalThis.window.history.replaceState(null, '', hash);
    await app.router();
    await settleModalFocus();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChart) Object.defineProperty(globalThis, 'Chart', originalChart);
    else delete globalThis.Chart;
  }
}

test('關窗回焦｜原入口仍可用時優先，標題不新增 tabindex', async () => {
  const { root, opener, heading } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click();
  await settleModalFocus();
  assert.equal(document.activeElement, opener);
  assert.equal(heading.hasAttribute('tabindex'), false);
});

test('關窗回焦｜同頁替換入口後回目前標題，離焦收回臨時 tabindex', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  view.innerHTML = '<h1 id="replacementHeading">重畫後的頁面</h1><button id="afterReturn">下一個操作</button>';
  assert.equal(opener.isConnected, false);
  const heading = document.getElementById('replacementHeading');
  root.querySelector('.x-close').click();
  await settleModalFocus();
  assert.equal(document.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1');
  document.getElementById('afterReturn').focus();
  assert.equal(heading.hasAttribute('tabindex'), false);
});

for (const [name, nextHash] of [['同頁 router 重畫', '#settings'], ['真正換頁', '#subscriptions']]) {
  test(`關窗回焦｜${name} 移除入口後採當下頁面標題`, async () => {
    const { app, root, view } = await prepareReturnFocusCase();
    root.querySelector('.x-close').click();
    await settleModalFocus();
    await renderFocusRoute(app, '#settings');
    const opener = document.createElement('button');
    opener.textContent = '本題入口';
    view.append(opener); opener.focus();
    app.openInfo('路由測試', '<p>本題內容</p>');
    await Promise.resolve();
    const beforeNav = app.currentNavSeq();
    await renderFocusRoute(app, nextHash);
    const heading = view.querySelector('h1');
    assert.ok(heading, '合成 API 要讓正式頁面確實渲染標題');
    assert.equal(opener.isConnected, false);
    assert.equal(app.currentNavSeq() === beforeNav, nextHash === '#settings');
    root.querySelector('.x-close').click();
    await settleModalFocus();
    assert.equal(document.activeElement, heading);
  });
}

for (const kind of ['disabled', 'hidden', 'ancestor-hidden', 'inert']) {
  test(`關窗回焦｜原入口 ${kind} 時退回標題`, async () => {
    const { root, view, opener, heading } = await prepareReturnFocusCase();
    if (kind === 'disabled') opener.disabled = true;
    if (kind === 'hidden') opener.hidden = true;
    if (kind === 'ancestor-hidden' || kind === 'inert') {
      const wrapper = document.createElement('div');
      view.append(wrapper); wrapper.append(opener);
      if (kind === 'inert') wrapper.setAttribute('inert', '');
      else wrapper.style.display = 'none';
    }
    root.querySelector('.x-close').click();
    await settleModalFocus();
    assert.equal(document.activeElement, heading);
  });
}

test('關窗回焦｜隱藏標題略過，沒有可用標題才回目前導航', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  opener.remove();
  view.innerHTML = '<div hidden><h1>不可見標題</h1></div>';
  const nav = document.querySelector('#nav [aria-current="page"]');
  root.querySelector('.x-close').click();
  await settleModalFocus();
  assert.equal(document.activeElement, nav);
});

test('關窗回焦｜沒有可用入口標題與導航時，不猜其他按鈕', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  opener.remove(); view.querySelector('h1').remove();
  document.getElementById('nav').hidden = true;
  try {
    root.querySelector('.x-close').click();
    await settleModalFocus();
    assert.equal(document.activeElement, document.body);
  } finally { document.getElementById('nav').hidden = false; }
});

for (const value of ['-1', '0', '3']) {
  test(`關窗回焦｜標題既有 tabindex=${value} 在回焦與離焦後保持`, async () => {
    const { root, opener, heading } = await prepareReturnFocusCase();
    opener.remove(); heading.setAttribute('tabindex', value);
    root.querySelector('.x-close').click();
    await settleModalFocus();
    assert.equal(document.activeElement, heading);
    assert.equal(heading.getAttribute('tabindex'), value);
    document.getElementById('chosenFocus').focus();
    assert.equal(heading.getAttribute('tabindex'), value);
  });
}

test('關窗回焦｜標題不能接焦點時收回臨時 tabindex，改回導航', async () => {
  const { root, opener, heading } = await prepareReturnFocusCase();
  opener.remove(); heading.focus = () => {};
  root.querySelector('.x-close').click();
  await settleModalFocus();
  assert.equal(heading.hasAttribute('tabindex'), false);
  assert.equal(document.activeElement, document.querySelector('#nav [aria-current="page"]'));
});

test('關窗回焦｜使用者已選其他有效焦點時不搶回原入口', async () => {
  const { root } = await prepareReturnFocusCase();
  const chosen = document.getElementById('chosenFocus');
  root.querySelector('.x-close').click(); chosen.focus();
  await settleModalFocus();
  assert.equal(document.activeElement, chosen);
});

test('關窗回焦｜排程等待期間使用者選了焦點，執行時仍尊重選擇', async () => {
  const { root } = await prepareReturnFocusCase();
  const nativeQueue = globalThis.queueMicrotask;
  const queued = [];
  globalThis.queueMicrotask = callback => { queued.push(callback); };
  try {
    root.querySelector('.x-close').click();
    await Promise.resolve();
    assert.equal(queued.length, 1);
    const chosen = document.getElementById('chosenFocus');
    chosen.focus();
    queued.shift()();
    assert.equal(document.activeElement, chosen);
  } finally {
    globalThis.queueMicrotask = nativeQueue;
    while (queued.length) queued.shift()();
  }
});

test('關窗回焦｜目前焦點已停用，不當作有效的使用者選擇', async () => {
  const { root, opener } = await prepareReturnFocusCase();
  const chosen = document.getElementById('chosenFocus');
  chosen.focus(); chosen.disabled = true;
  assert.equal(document.activeElement, chosen);
  root.querySelector('.x-close').click();
  await settleModalFocus();
  assert.equal(document.activeElement, opener);
});

test('關窗回焦｜原入口仍連線但 focus 無效時改回標題', async () => {
  const { root, opener, heading } = await prepareReturnFocusCase();
  opener.focus = () => {};
  root.querySelector('.x-close').click();
  await settleModalFocus();
  assert.equal(document.activeElement, heading);
});

test('關窗回焦｜先略過隱藏標題，再選可見標題', async () => {
  const { root, view, opener, heading } = await prepareReturnFocusCase();
  opener.remove();
  const hidden = document.createElement('h1');
  hidden.hidden = true; hidden.textContent = '隱藏的標題';
  view.prepend(hidden);
  root.querySelector('.x-close').click();
  await settleModalFocus();
  assert.equal(document.activeElement, heading);
});

test('關窗回焦｜聚焦後有其他程式調整 tabindex，離焦不覆蓋新值', async () => {
  const { root, opener, heading } = await prepareReturnFocusCase();
  opener.remove();
  root.querySelector('.x-close').click();
  await settleModalFocus();
  assert.equal(document.activeElement, heading);
  heading.setAttribute('tabindex', '0');
  document.getElementById('chosenFocus').focus();
  assert.equal(heading.getAttribute('tabindex'), '0');
});

for (const closeNext of [false, true]) {
  test(`關窗回焦｜新窗${closeNext ? '開過且已關空' : '仍開著'}時，舊排程不得呼叫 focus`, async () => {
    const { app, root, opener } = await prepareReturnFocusCase();
    const nativeQueue = globalThis.queueMicrotask;
    const queued = [];
    let focuses = 0;
    const nativeFocus = opener.focus.bind(opener);
    opener.focus = options => { focuses++; nativeFocus(options); };
    globalThis.queueMicrotask = callback => { queued.push(callback); };
    try {
      root.querySelector('.x-close').click();
      await Promise.resolve();
      assert.equal(queued.length, 1, '先保留第一窗實際排出的回焦工作');
      const oldRestore = queued.shift();
      app.openInfo('新窗', '<p>後來的窗</p>');
      assert.equal(queued.length, 1);
      queued.shift()();
      if (closeNext) { root.querySelector('.x-close').click(); await Promise.resolve(); }
      oldRestore();
      assert.equal(focuses, 0, '不可由後來合法回焦掩蓋舊排程曾搶過焦點');
      if (!closeNext) { root.querySelector('.x-close').click(); await Promise.resolve(); }
      while (queued.length) queued.shift()();
      assert.equal(document.activeElement, opener);
    } finally {
      globalThis.queueMicrotask = nativeQueue;
      while (queued.length) queued.shift()();
      root.innerHTML = '';
      await settleModalFocus();
    }
  });
}

test('共用彈窗外殼｜舊 close 不清掉新窗與本題專屬未儲存輸入', async () => {
  const { root } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  const { openModalShell } = await import('../public/modules/modal-shell.js');
  const old = openModalShell({ title: '先前的窗', bodyHtml: '<p>舊內容</p>' });
  const fresh = openModalShell({ title: '新的窗', bodyHtml: '<input id="freshUnsavedValue" data-modal-initial>' });
  const input = document.getElementById('freshUnsavedValue');
  input.value = '本題獨有且尚未儲存的內容';
  const dialog = root.querySelector('.modal');
  old.close();
  assert.equal(root.querySelector('.modal'), dialog);
  assert.equal(document.getElementById('freshUnsavedValue'), input);
  assert.equal(input.value, '本題獨有且尚未儲存的內容');
  fresh.close(); await settleModalFocus();
});

test('共用彈窗外殼｜目前窗真正換頁後仍可由本人關閉', async () => {
  const { app, root } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  const { openModalShell } = await import('../public/modules/modal-shell.js');
  const current = openModalShell({ title: '跨頁保留的窗', bodyHtml: '<p>仍是目前窗</p>' });
  await renderFocusRoute(app, '#settings?case=current-close');
  assert.ok(root.querySelector('.modal'));
  current.close(); await settleModalFocus();
  assert.equal(root.querySelector('.modal'), null);
});

test('關窗回焦｜已回原入口後，同頁稍晚重畫移除入口，補回新標題一次', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, opener);
  view.innerHTML = '<h1 id="lateHeading">儲存後的新畫面</h1>';
  await settleModalFocus();
  const heading = document.getElementById('lateHeading');
  assert.equal(document.activeElement, heading);
  view.innerHTML = '<h1>另一回重畫</h1>';
  await settleModalFocus();
  assert.equal(document.activeElement, document.body);
});

for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
  test(`關窗回焦｜回焦後收到 ${type}，稍晚重畫不再補償`, async () => {
    const { root, view, opener } = await prepareReturnFocusCase();
    root.querySelector('.x-close').click(); await settleModalFocus();
    assert.equal(document.activeElement, opener);
    opener.dispatchEvent(new globalThis.window.Event(type, { bubbles: true }));
    view.innerHTML = '<h1>操作之後的畫面</h1>';
    await settleModalFocus();
    assert.equal(document.activeElement, document.body);
  });
}

test('關窗回焦｜其他焦點接管後即使也被移除，舊補償不得復活', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, opener);
  document.getElementById('chosenFocus').focus();
  view.innerHTML = '<h1>外部焦點接管後的畫面</h1>';
  await settleModalFocus();
  assert.equal(document.activeElement, document.body);
});

for (const type of ['blur', 'hashchange']) {
  test(`關窗回焦｜視窗收到 ${type} 後撤銷稍晚重畫補償`, async () => {
    const { root, view, opener } = await prepareReturnFocusCase();
    root.querySelector('.x-close').click(); await settleModalFocus();
    assert.equal(document.activeElement, opener);
    globalThis.window.dispatchEvent(new globalThis.window.Event(type));
    view.innerHTML = '<h1>視窗狀態已變</h1>';
    await settleModalFocus();
    assert.equal(document.activeElement, document.body);
  });
}

test('關窗回焦｜完整網址在觀察器送達前改變也不補償', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, opener);
  const hash = globalThis.location.hash;
  globalThis.window.history.replaceState(null, '', '#settings?case=after-return');
  view.innerHTML = '<h1>另一個網址的畫面</h1>';
  await settleModalFocus();
  assert.equal(document.activeElement, document.body);
  globalThis.window.history.replaceState(null, '', hash);
});

test('關窗回焦｜新窗取得焦點後，舊目標移除不穿過新窗補償', async () => {
  const { app, root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, opener);
  app.openInfo('後來的新窗', '<p>焦點由本窗管理</p>');
  await Promise.resolve();
  const fresh = root.querySelector('.modal');
  view.innerHTML = '<h1>重畫不能穿透新窗</h1>';
  await settleModalFocus();
  assert.equal(document.activeElement, fresh);
  root.querySelector('.x-close').click(); await settleModalFocus();
});

test('關窗回焦｜原入口的 focus 事件另交焦點，不再嘗試標題', async () => {
  const { root, opener } = await prepareReturnFocusCase();
  const chosen = document.getElementById('chosenFocus');
  opener.addEventListener('focus', () => chosen.focus(), { once: true });
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, chosen);
});

test('關窗回焦｜標題的 focus 事件另交焦點，不再嘗試導航', async () => {
  const { root, opener, heading } = await prepareReturnFocusCase();
  opener.remove();
  const chosen = document.getElementById('chosenFocus');
  heading.addEventListener('focus', () => chosen.focus(), { once: true });
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, chosen);
  assert.equal(heading.hasAttribute('tabindex'), false);
});

for (const closeNext of [false, true]) {
  test(`關窗回焦｜focus 事件開新窗${closeNext ? '並立即關空' : ''}，舊嘗試不回焦標題`, async () => {
    const { app, root, view, opener, heading } = await prepareReturnFocusCase();
    let headingFocuses = 0;
    heading.addEventListener('focus', () => { headingFocuses++; });
    opener.addEventListener('focus', () => {
      app.openInfo('focus 事件開的新窗', '<p>後來的工作</p>');
      if (closeNext) root.querySelector('.x-close').click();
    }, { once: true });
    root.querySelector('.x-close').click(); await settleModalFocus();
    assert.equal(headingFocuses, 0);
    if (closeNext) {
      assert.equal(document.activeElement, opener);
      view.innerHTML = '<h1>舊嘗試不可留下觀察</h1>';
      await settleModalFocus();
      assert.equal(document.activeElement, document.body);
    }
    else {
      assert.equal(document.activeElement, root.querySelector('.modal'));
      root.querySelector('.x-close').click(); await settleModalFocus();
    }
  });
}

test('關窗回焦｜聚焦標題被移除時還原臨時屬性，補償不連鎖', async () => {
  const { root, view, opener, heading } = await prepareReturnFocusCase();
  opener.remove();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, heading);
  view.innerHTML = '<h1 id="compensatedHeading">一次補償</h1>';
  await settleModalFocus();
  assert.equal(heading.hasAttribute('tabindex'), false);
  const next = document.getElementById('compensatedHeading');
  assert.equal(document.activeElement, next);
  view.innerHTML = '<h1>不再補焦</h1>';
  await settleModalFocus();
  assert.equal(next.hasAttribute('tabindex'), false);
  assert.equal(document.activeElement, document.body);
});

for (const type of ['pagehide', 'visibilitychange']) {
  test(`關窗回焦｜${type} 解除後不補焦`, async () => {
    const { root, view, opener } = await prepareReturnFocusCase();
    root.querySelector('.x-close').click(); await settleModalFocus();
    assert.equal(document.activeElement, opener);
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    try {
      if (type === 'visibilitychange') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new globalThis.window.Event('visibilitychange'));
      } else globalThis.window.dispatchEvent(new globalThis.window.Event(type));
      view.innerHTML = '<h1>解除之後不接管</h1>';
      await settleModalFocus();
      assert.equal(document.activeElement, document.body);
    } finally {
      if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
      else delete document.hidden;
    }
  });
}

test('關窗回焦｜主動 blur 與移除同回合不可區分，按一次移除補償處理', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, opener);
  opener.blur();
  view.innerHTML = '<h1 id="ambiguousBlurHeading">同回合移除的退路</h1>';
  await settleModalFocus();
  assert.equal(document.activeElement, document.getElementById('ambiguousBlurHeading'));
  view.innerHTML = '<h1>不得連鎖</h1>';
  await settleModalFocus();
  assert.equal(document.activeElement, document.body);
});

test('關窗回焦｜主動 blur 完成微任務後才重畫，取消一次補償', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, opener);
  opener.blur();
  await Promise.resolve();
  view.innerHTML = '<h1>明確讓焦之後的畫面</h1>';
  await settleModalFocus();
  assert.equal(document.activeElement, document.body);
});

test('關窗回焦｜只撤銷補償時保留仍持焦標題的暫時屬性，離焦才還原', async () => {
  const { root, opener, heading } = await prepareReturnFocusCase();
  opener.remove();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, heading);
  heading.dispatchEvent(new globalThis.window.Event('keydown', { bubbles: true }));
  assert.equal(heading.getAttribute('tabindex'), '-1');
  document.getElementById('chosenFocus').focus();
  assert.equal(heading.hasAttribute('tabindex'), false);
});

test('關窗回焦｜共用表單先提交關窗，再完成非同步重畫仍回標題', async () => {
  const { app, root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  let finishRead;
  const read = new Promise(resolve => { finishRead = resolve; });
  let submissions = 0;
  app.openForm({
    title: '晚完成重畫的合成表單',
    fields: [{ key: 'name', label: '本題內容' }],
    values: { name: '尚未送出的合成值' },
    onSubmit: async () => {
      submissions++;
      void read.then(() => { view.innerHTML = '<h1 id="formReadHeading">提交後完成的畫面</h1>'; });
    },
  });
  await Promise.resolve();
  root.querySelector('form').dispatchEvent(new globalThis.window.Event('submit', { bubbles: true, cancelable: true }));
  await settleModalFocus();
  assert.equal(submissions, 1);
  assert.equal(root.querySelector('.modal'), null);
  assert.equal(document.activeElement, opener);
  finishRead();
  await settleModalFocus();
  assert.equal(document.activeElement, document.getElementById('formReadHeading'));
  assert.equal(submissions, 1);
});

for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'focusin', 'hashchange']) {
  test(`關窗回焦｜blur 分類等待時出現 ${type}，舊微任務不得恢復補償`, async () => {
    const { root, view, opener } = await prepareReturnFocusCase();
    root.querySelector('.x-close').click(); await settleModalFocus();
    assert.equal(document.activeElement, opener);
    opener.blur();
    if (type === 'focusin') document.getElementById('chosenFocus').focus();
    else if (type === 'hashchange') globalThis.window.dispatchEvent(new globalThis.window.Event(type));
    else opener.dispatchEvent(new globalThis.window.Event(type, { bubbles: true }));
    view.innerHTML = '<h1>接管訊號優先</h1>';
    await settleModalFocus();
    assert.equal(document.activeElement, document.body);
  });
}

test('關窗回焦｜blur 微任務晚於新窗開過且關空，不干擾新窗合法回焦', async () => {
  const { app, root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, opener);
  const nativeQueue = globalThis.queueMicrotask;
  const queued = [];
  globalThis.queueMicrotask = callback => { queued.push(callback); };
  try {
    opener.blur();
    assert.equal(queued.length, 1);
    const oldBlur = queued.shift();
    app.openInfo('blur 排程後的新窗', '<p>獨立的合法回焦</p>');
    root.querySelector('.x-close').click(); await Promise.resolve();
    view.innerHTML = '<h1 id="newOwnerHeading">新窗的退路</h1>';
    const heading = document.getElementById('newOwnerHeading');
    let focuses = 0;
    heading.addEventListener('focus', () => { focuses++; });
    oldBlur();
    assert.equal(focuses, 0);
    while (queued.length) queued.shift()();
    assert.equal(document.activeElement, heading);
    assert.equal(focuses, 1);
  } finally {
    globalThis.queueMicrotask = nativeQueue;
    while (queued.length) queued.shift()();
  }
});

test('關窗回焦｜root 被移除後，不對仍存在的頁面補焦', async () => {
  const { root, view, opener } = await prepareReturnFocusCase();
  root.querySelector('.x-close').click(); await settleModalFocus();
  assert.equal(document.activeElement, opener);
  try {
    root.remove();
    view.innerHTML = '<h1>根節點失效後的畫面</h1>';
    await settleModalFocus();
    assert.equal(document.activeElement, document.body);
  } finally { document.body.append(root); }
});
