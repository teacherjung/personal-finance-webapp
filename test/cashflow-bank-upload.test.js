// @ts-check
// 上傳銀行對帳單：密碼欄告知文案的模式分流（#437 r2 審查者抓到的 main 既有問題）。
//
// 病根：openBankUpload 的密碼欄舊文案寫「只在這台電腦解密、不會上傳、不會儲存」，
// 但預覽／套用都是把 PDF 與密碼 POST 給 app 伺服器——LOCAL 那台伺服器就是這台電腦、
// 句子成立；HOSTED 是營運方的遠端伺服器＝「不會上傳」是反方向誤導。
// 修法＝比照匯出告知（backup-export.js exportNotice）：`GET /api/mode` 分流兩句，
// 保守預設方向相反（問不到＝當雲端講；理由見 cashflow-model.js bankPasswordLabel 註解）。
// r1 複審後把「問模式→挑句→切頁作廢」收進可注入的 bankUploadGate（阻擋①③），
// 挑句改認**自有**欄位（阻擋②），所以判準與時序都是行為題、不是文字題。
//
// ⚠️ 誠實劃界：
//   ・「/api/mode 回應只有 hosted、HOSTED 掛在 authGate 後面」由 test/server.test.js 那組守；
//   ・「密碼在伺服器端只進記憶體、不落檔」是收支契約「帳戶完整帳號與餘額匯入」節寫明的
//     lib 層規矩，本檔不驗後端；
//   ・接線題掃的是去註解後的原始碼**形狀**（cashflow.js 頂層 import app.js，node 載不動整頁）：
//     擋得住「改回寫死／拆掉把關／拆掉 busy 鎖」這類形狀走樣，**擋不住「把關之後又蓋一手」**
//     （r1 阻擋③的示範：查完模式再硬寫 mode——現在同型繞法是硬蓋 gate.label）——那一類靠
//     複審看 diff；挑句與作廢的**判準本身**已由上面的行為題執行、不再只是文字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BANK_PW_NOTICE_LOCAL, BANK_PW_NOTICE_HOSTED, bankPasswordLabel, bankUploadGate,
} from '../public/modules/cashflow-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('挑句｜只有「自有」欄位明確 hosted:false 才講「這台電腦」，其他一律當雲端講（保守方向與匯出相反）', () => {
  assert.equal(bankPasswordLabel({ hosted: false }), BANK_PW_NOTICE_LOCAL, 'LOCAL 明確回 false ⇒ 才可以講本機那句');
  assert.equal(bankPasswordLabel({ hosted: true }), BANK_PW_NOTICE_HOSTED, 'HOSTED 明確回 true ⇒ 雲端那句');
  // 問不到／形狀不合法＝一律雲端那句：這裡猜錯若是「以為沒上傳」＝把密碼騙上雲（正是要修的病）；
  // 反過來只是把本機使用者多嚇一跳。方向與 exportNotice 相反、原則相同（往安全的方向錯）。
  assert.equal(bankPasswordLabel(null), BANK_PW_NOTICE_HOSTED, '問不到模式 ⇒ 當雲端講');
  assert.equal(bankPasswordLabel(undefined), BANK_PW_NOTICE_HOSTED, '同上');
  assert.equal(bankPasswordLabel({}), BANK_PW_NOTICE_HOSTED, '回應沒有 hosted 欄位 ⇒ 同樣保守');
  assert.equal(bankPasswordLabel({ hosted: 'false' }), BANK_PW_NOTICE_HOSTED, '字串 "false" 不算 false（型別鬆掉就會講反）');
  assert.equal(bankPasswordLabel({ hosted: 0 }), BANK_PW_NOTICE_HOSTED, '0 也不算 false——只認布林');
  // r1 阻擋②：hosted:false 掛在原型鏈上（Object.create）曾經騙出本機句——鐵則 3.5 查表一律自有屬性。
  assert.equal(bankPasswordLabel(Object.create({ hosted: false })), BANK_PW_NOTICE_HOSTED,
    '繼承來的 hosted:false 不算數（Object.hasOwn）：原型鏈上的值不可以放行本機句');
});

test('把關｜問一次模式、逾時走保守、等待期間切頁＝作廢不開窗', async () => {
  // 正常 LOCAL：模式只問一次、拿本機句、不作廢。
  let calls = 0;
  let r = await bankUploadGate({
    fetchMode: async () => { calls++; return { hosted: false }; },
    withTimeout: (w) => w, timeoutMs: 5, routeSeq: () => 7,
  });
  assert.deepEqual([r.label, r.stale, calls], [BANK_PW_NOTICE_LOCAL, false, 1]);
  // 連不上／被拒絕：不炸、走保守雲端句。
  r = await bankUploadGate({
    fetchMode: () => Promise.reject(new Error('斷線')),
    withTimeout: (w) => w, timeoutMs: 5, routeSeq: () => 7,
  });
  assert.deepEqual([r.label, r.stale], [BANK_PW_NOTICE_HOSTED, false], '問不到＝保守，不可把錯誤往上丟');
  // 上限真的有接上：掛住的 fetch 要被注入的計時器打斷（匯出 r5 阻擋①同款病——沒上限＝開不出窗）。
  // ⚠️ 本題自帶一秒競速：把關若把「永不回應」原樣往上等（＝丟掉 withTimeout），這題要在一秒內
  //    確定紅，不可以跟著吊死——吊死的紅在本機像當機、在 CI 要等 runner 超時才看得到。
  let sawMs = 0;
  /** @type {any} */ let raceTimer;
  try {
    r = await Promise.race([
      bankUploadGate({
        fetchMode: () => new Promise(() => { /* 永不回應 */ }),
        withTimeout: (_w, ms) => { sawMs = ms; return Promise.reject(new Error('逾時')); },
        timeoutMs: 5, routeSeq: () => 7,
      }),
      new Promise((_res, rej) => { raceTimer = setTimeout(() => rej(new Error('把關把「永不回應」原樣往上等＝等待上限沒接')), 1000); }),
    ]);
  } finally { clearTimeout(raceTimer); }
  assert.deepEqual([r.label, sawMs], [BANK_PW_NOTICE_HOSTED, 5], '逾時上限要真的交給計時器，逾時＝保守');
  // r1 阻擋①（切頁那一半）：等待期間路由序號變了 ⇒ stale，晚回的視窗不可以開在別的頁面上。
  let seq = 1;
  r = await bankUploadGate({
    fetchMode: async () => { seq = 2; return { hosted: false }; },
    withTimeout: (w) => w, timeoutMs: 5, routeSeq: () => seq,
  });
  assert.equal(r.stale, true, '等待期間切頁要回報作廢——呼叫端據此不開窗');
});

test('文案｜雲端那句要坦白「會上傳」，而且不可殘留本機的宣稱', () => {
  // 這幾條鎖的是「誠實的骨架」，不是逐字措辭——William 改字不會誤紅，換回舊謊話一定紅。
  assert.match(BANK_PW_NOTICE_HOSTED, /上傳/, '雲端那句必須明講會上傳');
  assert.match(BANK_PW_NOTICE_HOSTED, /伺服器/, '雲端那句必須講去了伺服器');
  assert.doesNotMatch(BANK_PW_NOTICE_HOSTED, /只在這台電腦|不會上傳|不會傳上網路/, '雲端那句殘留任何本機宣稱＝舊病復發');
  assert.match(BANK_PW_NOTICE_LOCAL, /這台電腦/, '本機那句才可以講這台電腦');
  // 「不會儲存」兩句都講＝照收支契約寫明的伺服器端規矩下的文案（後端本身不歸本檔驗，劃界見檔頭）。
  // 這兩條同時是絆線：#437 計畫 P0.5 若開放儲存銀行密碼，文案必須跟那支 PR 一起改、這裡會先紅。
  assert.match(BANK_PW_NOTICE_LOCAL, /不會儲存/);
  assert.match(BANK_PW_NOTICE_HOSTED, /不會儲存/);
  assert.notEqual(BANK_PW_NOTICE_LOCAL, BANK_PW_NOTICE_HOSTED, '兩句相同＝分流白做');
});

/** 去註解（接線題讀原始碼文字，照 AGENTS 的硬規則先把註解拿掉）。抄自 backup-export.test.js。 @param {string} raw */
function stripComments(raw) {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

test('接線｜cashflow.js 走 bankUploadGate、busy 鎖住 await 窗口、切頁作廢、舊謊話絕跡', () => {
  // ⚠️ 先去註解：把接線改成註解就等於沒接，掃原始字面會給假綠（backup-export.test.js r5 阻擋②同款）。
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(src, /await bankUploadGate\(\{/,
    '開窗前要走共用把關——判準散寫回 cashflow.js 的話，行為題就打不到正式那一份');
  assert.match(src, /fetchMode:\s*\(\)\s*=>\s*api\('\/mode'\)/, '把關要真的問 /api/mode');
  assert.match(src, /withTimeout:\s*defaultWithTimeout/, '等待上限要接匯出模組那顆共用計時器');
  assert.match(src, /timeoutMs:\s*MODE_TIMEOUT_MS/, '上限用共用常數，不可另抄一個數字');
  assert.match(src, /routeSeq:\s*currentRouteSeq/, '作廢判準要接真的路由序號');
  assert.match(src, /if \(gate\.stale\) return;/, '切頁作廢要真的擋住開窗（r1 阻擋①）');
  assert.match(src, /dataset\.busy === '1'\) return;/, 'busy 鎖要在 await 之前擋住連點（r1 阻擋①）');
  assert.match(src, /finally \{ if \(btn\) btn\.dataset\.busy = ''; \}/, 'busy 要 finally 解鎖——丟錯不解鎖＝按鈕永久啞掉');
  assert.match(src, /label:\s*gate\.label/, '密碼欄 label 只能來自把關結果');
  assert.doesNotMatch(src, /只在這台電腦解密、不會上傳/,
    '舊文案逐字回歸＝雲端版把「不會上傳」講給正在上傳的人聽');
  assert.doesNotMatch(src, /對帳單密碼（/,
    'cashflow.js 裡不准再出現手寫的密碼欄告知句——兩句與挑句判準只住 cashflow-model.js 一處');
});
