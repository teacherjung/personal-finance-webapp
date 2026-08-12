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
  // ★r2#1：實作是「不論有沒有設鑰匙都會先問」（收支頁拿不到 aiApiKeySet；裁決 6 刻意讓後端講），
  //   文案寫成「有鑰匙才會多出這個選項」與實際流程不符。
  assert.doesNotMatch(ALL_COPY, /有鑰匙才會多出|沒鑰匙就不會問|設定後才會出現這個選項/,
    '沒設鑰匙時同意窗照樣會開（按下才回 ai_no_key）——文案不可宣稱看得到入口＝已設定');
  assert.match(ALL_COPY, /都會問|都會先問|有沒有設鑰匙/, '要講清楚「沒設鑰匙也會問，只是送不出去」');
});

test('G4｜AI_KEY_INFO：四把鑰匙齊全、都有標題與內容，且是凍結常數（零插值＝openInfo 不 esc 也安全）', () => {
  assert.deepEqual(Object.keys(AI_KEY_INFO).sort(), ['cost', 'skip', 'what', 'where']);
  for (const [k, v] of Object.entries(AI_KEY_INFO)) {
    assert.ok(v.title && v.title.length > 4, `${k} 要有標題`);
    assert.ok(v.html && v.html.includes('<p>'), `${k} 要有內容`);
    assert.doesNotMatch(v.html, /\$\{/, `${k} 不可有插值（openInfo 不跳脫）`);
  }
  assert.ok(Object.isFrozen(AI_KEY_INFO));
});

test('G5｜settings.js 接線：鑰匙不回顯、清除入口由投影布林把關、判準走純函式、換頁序號', () => {
  assert.match(src, /<input id="aiApiKey" type="password" value="" placeholder=/, '★value 硬寫空字串＝鑰匙永遠不回顯');
  assert.doesNotMatch(src, /s\.aiApiKey(?!Set)/, '★前端只准讀 aiApiKeySet 布林，不可讀鑰匙本身');
  assert.match(src, /\$\{s\.aiApiKeySet \? `<div class="full"><label[^`]*clearAiApiKey/, '清除入口要由投影布林把關（沒設定就不該出現）');
  assert.match(src, /aiKeyPatch\(\{ value: val\('aiApiKey'\)/, '判準要真的走純函式（複製回 settings.js＝行為沒被考題守住）');
  assert.match(src, /byId\('clearAiApiKey'\)\)\?\.checked === true/, '可選鏈：沒設定時那個 checkbox 根本不存在');
  assert.match(src, /if \(!patch\) return toast\(AI_KEY_NOCHANGE_TEXT, true\);/, '沒有變更＝紅字提示、不送 PUT');
  assert.match(src, /const seq = currentNavSeq\(\);[\s\S]{0,400}?saveAiApiKey|saveAiApiKey[\s\S]{0,400}?const seq = currentNavSeq\(\);/,
    '★問的是「還在設定頁嗎」＝換頁序號；接成 currentRouteSeq 時開機背景重繪會讓儲存成功卻不提示、清除入口不出現');
  assert.doesNotMatch(src, /saveAiApiKey[\s\S]{0,400}?currentRouteSeq/, '同上：這個區塊不可用重繪序號');
  assert.match(src, /await renderSettings\(\);/, '成功後重繪＝清除入口當場出現，不必切頁再回來');
  assert.equal(count(/data-ai-info="/g), 4, '四顆就地解釋按鈕都要在（泛化 regex 只蓋一顆就假綠）');
  for (const k of ['what', 'cost', 'where', 'skip']) {
    assert.match(src, new RegExp(`data-ai-info="${k}"`), `就地解釋「${k}」要掛上去`);
  }
  assert.match(src, /Object\.hasOwn\(AI_KEY_INFO, key\)/, '只認自有鍵（直接索引會讓 constructor 之類撈到原型）');
});
