// 設定頁「AI 解析鑰匙」卡的考題（P1b-2）。零網路、零 DOM。
// 家規核可劃界同 test/ai-consent.test.js：`settings.js` 頂層 import `app.js`（node 載不動整頁），
// 所以判準與文案抽成純函式直測，接線只掃去註解後的形狀；接線層另外蓋掉結果＝靠複審看 diff。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));   // 含空白/中文的專案路徑：不可用 new URL().pathname

const { aiKeyPatch, AI_KEY_INFO, AI_KEY_CARD_NOTE, AI_KEY_COST_LINE, AI_KEY_NOCHANGE_TEXT } =
  await import('../public/modules/ai-key-settings.js');

const src = readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
/** @param {RegExp} re */
const count = (re) => (src.match(re) || []).length;
/** 四個說明窗＋卡片說明＋費用句的全文（文案題一次掃完，漏一處就抓不到）。 */
const ALL_COPY = [AI_KEY_CARD_NOTE, AI_KEY_COST_LINE, ...Object.values(AI_KEY_INFO).map((i) => `${i.title}\n${i.html}`)].join('\n');

test('G｜aiKeyPatch：留空＝不變更（不會把已存鑰匙清掉）、勾清除＝送空字串、清除優先', () => {
  // ★這一條就是「留空不會清掉鑰匙」的證明：寫成無條件送 val() 會讓使用者一按儲存就清空
  assert.equal(aiKeyPatch({ value: '', clear: false }), null, '沒打字也沒勾清除＝沒有變更，不可送 PUT');
  assert.equal(aiKeyPatch({}), null);
  assert.equal(aiKeyPatch({ value: '   \n ', clear: false }), null, '只有空白＝視同沒打（不是清除）');
  assert.deepEqual(aiKeyPatch({ value: 'sk-ant-synthetic', clear: false }), { aiApiKey: 'sk-ant-synthetic' });
  assert.deepEqual(aiKeyPatch({ value: '', clear: true }), { aiApiKey: '' }, '勾清除＝明確送空字串');
  assert.deepEqual(aiKeyPatch({ value: 'sk-ant-synthetic', clear: true }), { aiApiKey: '' }, '清除優先（同 flexToken／台新密碼的既有順序）');
  assert.deepEqual(aiKeyPatch({ value: '  sk-ant-x \n', clear: false }), { aiApiKey: 'sk-ant-x' },
    'trim：從網頁複製的 key 常帶尾端換行——不 trim 不會當場報錯，會等到下次上傳才炸成 ai_auth');
  assert.deepEqual(aiKeyPatch({ value: 'sk', clear: 'true' }), { aiApiKey: 'sk' }, "clear 只認布林 true（字串 'true' 不算勾選＝不可誤清）");
  assert.deepEqual(aiKeyPatch({ value: 'sk', clear: 1 }), { aiApiKey: 'sk' }, 'truthy 但非 true＝不算勾選');
  assert.equal(typeof AI_KEY_NOCHANGE_TEXT, 'string');
});

test('G2｜文案：該講的都講了（辦鑰匙／兩套帳／級距不是報價／驗算／不設定會怎樣）', () => {
  assert.match(ALL_COPY, /platform\.claude\.com/, '要講去哪辦');
  assert.match(ALL_COPY, /訂閱/, '要講與 Claude 訂閱的關係');
  assert.match(ALL_COPY, /兩套帳|另外綁|不會折抵/, '★要講清楚是分開計費');
  assert.match(ALL_COPY, /幾塊台幣/, '要講大概多少錢');
  assert.match(ALL_COPY, /不是報價|以 Anthropic 那邊的帳單為準|實際金額以他們的帳單為準/, '費用要標明是級距');
  assert.match(ALL_COPY, /驗算/, '★要講「設了鑰匙也不是什麼帳單都吃得下」');
  // ★r4#1：skip 窗的驗算描述也要收在實作射程內（只驗台幣、首筆驗不到、外幣不在內）
  // ⚠️ **scope 到承擔保證的那一段**（r5#1）：整窗掃描會被「下一段的盲區說明」滿足——
  //    我在上一輪就是這樣：前一段留著絕對保證、後一段自認驗不到，考題卻全綠。
  const skipParas = AI_KEY_INFO.skip.html.split('</p>');
  const gateePara = skipParas.find((x) => x.includes('驗算')) || '';
  const blindPara = skipParas.find((x) => x.includes('驗不到')) || '';
  assert.ok(gateePara && blindPara && gateePara !== blindPara, 'skip 窗要有「驗什麼」與「驗不到什麼」兩段');
  assert.match(gateePara, /台幣/, '★承擔保證的那一段就要講清楚只驗台幣帳戶');
  assert.doesNotMatch(gateePara, /沒驗算過的數字|每一筆數字都驗|全部驗過|都驗過才/,
    '★這一段不可留任何「凡是進帳本的都驗過」等義的絕對保證——首筆與外幣本來就驗不到');
  assert.doesNotMatch(gateePara, /整份連得起來才收/, '不可寫成整份逐筆都驗');
  assert.match(blindPara, /第一筆|首筆/, '★每個帳戶的第一筆驗不到');
  assert.match(blindPara, /外幣/, '★外幣明細不在這道驗算裡');
  // ⚠️ 同 E2 的理由（r7#1）：三件事分開釘，條件詞不接受單獨的「概要」二字
  assert.match(blindPara, /沒有往來|一筆都沒有|只出現在概要/, '①情境：這期沒往來、只出現在概要的帳戶');
  assert.match(blindPara, /餘額仍會|仍會照帳單更新|新建/, '②★它的餘額仍然會被寫進去');
  assert.match(blindPara, /沒有(任何)?明細可以驗|沒有明細可以驗它|沒有明細可驗/, '③★那個數字沒有明細可以驗');
  assert.match(gateePara, /如果也印了|有印.{0,6}概要餘額/, '★末筆對概要是**有條件**的（只出現「概要」二字不算數）');
  assert.match(ALL_COPY, /完全可以不設定|不設定也完全可以/, '要講不設定會怎樣');
  assert.match(ALL_COPY, /只會顯示一次/, '辦 key 的實務提醒');
});

test('G3｜文案：在 HOSTED 下為假的句子一句都不准出現；不得宣稱 P3 才有的護欄', () => {
  // ★台新那半句「只存這台電腦、永不上傳」對 AI 鑰匙兩重不成立：HOSTED 加密落庫；鑰匙本來就會送到供應商
  assert.doesNotMatch(ALL_COPY, /只存這台電腦|永不上傳|不會離開這台電腦|絕不外傳/,
    'AI 鑰匙在雲端版會加密落庫，而且它本來就會以 x-api-key 送到供應商——照抄台新那句就是說謊');
  assert.doesNotMatch(ALL_COPY, /已限速|每日次數上限|單張費用上限|自動停用超額/,
    'LOCAL 路線目前沒有 runtime 限速，成本護欄是 P3——契約明文不得宣稱');
  assert.doesNotMatch(ALL_COPY, /免費|不用錢|保證讀對|保證正確|一定正確|進不了你的帳本/, '不可誇大');
  assert.doesNotMatch(ALL_COPY, /\*\*/, '這是 HTML 不是 markdown：`**粗體**` 會把星號原樣顯示給使用者（要粗體用 <b>）');
  // ★r3#1：本機版的「匯出備份」刻意回完整未投影資料（cloud-security C5 裁決⑤），設定頁那顆下載鈕
  //   正是經瀏覽器取得它——所以「永遠不會再送回瀏覽器」是假的，必須講出這個例外。
  assert.doesNotMatch(AI_KEY_INFO.where.html, /永遠不會再送回瀏覽器|永遠不會離開|絕不會送回瀏覽器/,
    '本機版備份下載會含這把鑰匙——不可寫成「永遠」不回瀏覽器');
  assert.match(AI_KEY_INFO.where.html, /例外/, '要點出例外存在');
  assert.match(AI_KEY_INFO.where.html, /備份|匯出/, '★要講清楚例外是「匯出備份」，使用者才知道那個檔案要保管好');
  // ★r3#2：HOSTED 的停止線排在鑰匙檢查**之前**（bank-import 先回 ai_hosted_off）——
  //   「沒鑰匙會指路、設了就送得出去」只對 LOCAL 成立，寫成無條件句在雲端版是假的。
  assert.match(AI_KEY_INFO.skip.html, /雲端版|網頁版/, '★按下同意之後的行為要分模式講（雲端版整條停用）');
  assert.match(AI_KEY_INFO.skip.html, /自己電腦上的版本|本機版/, '要標明「設了才送得出去」是哪一種版本的行為');
  // ⚠️ **這一段在 2026-08-13 翻面了**（William 拍板：預設不問、直接送）。
  //   舊版文案保證「沒同意就完全不送／有沒有設鑰匙都會問」——那兩句現在是**假話**，
  //   而且是關於「你的帳單會不會被送出去」的假話，比沒寫更糟。
  //   ⚠️ 舊考題用的是 `/都會問|都會先問|有沒有設鑰匙/` 這種**交替式**：文案改成假話之後
  //   它照樣綠（被雲端版那句「不論有沒有設鑰匙」撞上）＝守拼字不守語意。改成兩面都釘：
  //   假話一個字都不准出現，真話必須講到。
  assert.doesNotMatch(ALL_COPY, /沒同意就完全不送|有沒有設鑰匙都會問|每一次要送出前都得由你按過同意|按過確認之後|確認之後才|同意之後才/u,
    '★預設已經是「不問、直接送」——這些句子（含 r1#4 抓到的同義句「按過確認之後」）'
    + '現在是假的，留著等於騙使用者他一定會被問');
  assert.match(AI_KEY_INFO.where.html, /預設是直接送/u,
    '★要明講預設會直接送出去（使用者有權知道他的帳單什麼時候會離開這台機器）');
  for (const [key, info] of Object.entries(AI_KEY_INFO)) {
    if (!/送到|送出|送去/u.test(info.html)) continue;
    assert.match(info.html, /送給 AI 之前先問我一次|上面那個開關/u,
      `★「${key}」講到帳單會送出去，就要順帶指出「怎麼改成每次先問」——`
      + '只講預設不給出路，等於告訴使用者這件事他管不著');
  }
});

test('G4｜AI_KEY_INFO：五把鑰匙齊全、都有標題與內容，且是凍結常數（零插值＝openInfo 不 esc 也安全）', () => {
  assert.deepEqual(Object.keys(AI_KEY_INFO).sort(), ['ask', 'cost', 'skip', 'what', 'where']);
  for (const [k, v] of Object.entries(AI_KEY_INFO)) {
    assert.ok(v.title && v.title.length > 4, `${k} 要有標題`);
    assert.ok(v.html && v.html.includes('<p>'), `${k} 要有內容`);
    assert.doesNotMatch(v.html, /\$\{/, `${k} 不可有插值（openInfo 不跳脫）`);
  }
  assert.ok(Object.isFrozen(AI_KEY_INFO));
});

test('G6｜「先問我」開關：存檔失敗必須把開關退回、不能畫面開著資料庫關著（r1#3）', () => {
  const src = readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8');
  // ⚠️ 不可走 saveSettings（它吞錯誤只 toast）：PUT 失敗＝畫面顯示已開、下一次上傳直接外送。
  assert.match(src, /ask\.onchange = async \(\) => \{/u, '★開關存檔要等結果（async），不是射後不理');
  assert.match(src, /ask\.checked = !want;/u,
    '★失敗要退回 checkbox——開關的樣子必須等於資料庫的真相，不然使用者以為自己受保護');
  assert.match(src, /儲存失敗，開關已退回/u, '★失敗要出聲說「已退回」，不是靜靜恢復');
  assert.doesNotMatch(src, /saveSettings\(\{ aiAskBeforeSend/u, '★不可繞回吞錯誤的 saveSettings');
});

test('G5｜settings.js 接線：鑰匙不回顯、清除入口由投影布林把關、判準走純函式、換頁序號', () => {
  assert.match(src, /<input id="aiApiKey" type="password" value="" placeholder=/, '★value 硬寫空字串＝鑰匙永遠不回顯');
  assert.doesNotMatch(src, /s\.aiApiKey(?!Set)/, '★前端只准讀 aiApiKeySet 布林，不可讀鑰匙本身');
  assert.match(src, /\$\{s\.aiApiKeySet \? `<div class="full"><label[^`]*clearAiApiKey/, '清除入口要由投影布林把關（沒設定就不該出現）');
  assert.match(src, /aiKeyPatch\(\{ value: val\('aiApiKey'\)/, '判準要真的走純函式（複製回 settings.js＝行為沒被考題守住）');
  assert.match(src, /byId\('clearAiApiKey'\)\)\?\.checked === true/, '可選鏈：沒設定時那個 checkbox 根本不存在');
  assert.match(src, /if \(!patch\) return toast\(AI_KEY_NOCHANGE_TEXT, true\);/, '沒有變更＝紅字提示、不送 PUT');
  // ★r8#1：把斷言 scope 到**這個 handler 自己**——否則 `await renderSettings()` 會被同檔既有的
  //   「清除記住的帳單密碼」那條路冒充；而「算出 patch 卻沒送出去」更是整條路白做（Codex 實測：
  //   把 body 改成 {} 仍 1959/1959 全綠＝畫面說儲存成功、鑰匙其實沒送到後端）。
  const aiStart = src.indexOf("byId('saveAiApiKey')");
  const aiEnd = src.indexOf('data-ai-info', aiStart);
  assert.ok(aiStart > 0 && aiEnd > aiStart, 'AI 鑰匙 handler 要找得到（找不到就別假裝在守它）');
  const aiBlock = src.slice(aiStart, aiEnd);
  assert.match(aiBlock, /body: patch/, '★算出來的 patch 要真的成為 request body（送 {} 的話畫面照樣說成功、鑰匙沒存到）');
  assert.match(aiBlock, /await renderSettings\(\);/, '★這個 handler 自己要重繪（讓清除入口當場出現）——不可靠別條路的重繪冒充');
  assert.match(src, /const seq = currentNavSeq\(\);[\s\S]{0,400}?saveAiApiKey|saveAiApiKey[\s\S]{0,400}?const seq = currentNavSeq\(\);/,
    '★問的是「還在設定頁嗎」＝換頁序號；接成 currentRouteSeq 時開機背景重繪會讓儲存成功卻不提示、清除入口不出現');
  assert.doesNotMatch(src, /saveAiApiKey[\s\S]{0,400}?currentRouteSeq/, '同上：這個區塊不可用重繪序號');
  assert.match(src, /await renderSettings\(\);/, '成功後重繪＝清除入口當場出現，不必切頁再回來');
  assert.equal(count(/data-ai-info="/g), 5, '五顆就地解釋按鈕都要在（第五顆＝「什麼時候會送出去？」，2026-08-13 隨『預設不問』一起加）');
  for (const k of ['what', 'cost', 'where', 'skip', 'ask']) {
    assert.match(src, new RegExp(`data-ai-info="${k}"`), `就地解釋「${k}」要掛上去`);
  }
  assert.match(src, /Object\.hasOwn\(AI_KEY_INFO, key\)/, '只認自有鍵（直接索引會讓 constructor 之類撈到原型）');
  // ★r9#1：查到了還要真的拿去開窗——保留查表與 openInfo 呼叫、卻顯示固定占位內容，三關照樣全綠
  //   （四顆 ⓘ 都看不到既定說明）。
  assert.match(src, /openInfo\(info\.title, info\.html/, '★查到的說明要真的成為視窗的標題與內容');
});
