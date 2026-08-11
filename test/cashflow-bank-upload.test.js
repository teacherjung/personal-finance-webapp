// @ts-check
// 上傳銀行對帳單：密碼欄告知文案的模式分流＋開窗編排（#437 r2 審查者抓到的 main 既有問題）。
//
// 病根：openBankUpload 的密碼欄舊文案寫「只在這台電腦解密、不會上傳、不會儲存」，
// 但預覽／套用都是把 PDF 與密碼 POST 給 app 伺服器——LOCAL 那台伺服器就是這台電腦、
// 句子成立；HOSTED 是營運方的遠端伺服器＝「不會上傳」是反方向誤導。
// 修法＝比照匯出告知（backup-export.js exportNotice）：`GET /api/mode` 分流兩句，
// 保守預設方向相反（問不到＝當雲端講；理由見 cashflow-model.js bankPasswordLabel 註解）。
//
// 分工（誰守什麼）：
//   ・挑句判準（bankPasswordLabel）、問模式與作廢回報（bankUploadGate）、**開窗前的時序**
//     （runBankUpload：連點鎖→把關→作廢不開窗→開窗→解鎖）都住 cashflow-model.js——
//     零 app／DOM import、相依注入的編排函式（有副作用、不是純函式）＝本檔的**行為題
//     直接執行**，不靠字面。
//   ・cashflow.js 負責接真的鎖／API／openForm，並擁有表單內容與上傳流程＝接線題掃
//     去註解後的原始碼**形狀**（cashflow.js 頂層 import app.js，node 載不動整頁）。
//
// ⚠️ 誠實劃界：
//   ・「/api/mode 回應只有 hosted、HOSTED 掛在 authGate 後面」由 test/server.test.js 那組守；
//   ・「密碼在伺服器端只進記憶體、不落檔」是收支契約「帳戶完整帳號與餘額匯入」節寫明的
//     lib 層規矩，本檔不驗後端；
//   ・接線題只驗「真的把正式相依接進 runBankUpload」這個形狀：在接線層另外蓋掉結果
//     （例如把 openUploadForm 換成無視 label 參數的實作）這一類，形狀掃描擋不住＝
//     靠複審看 diff；時序與判準的行為本身由上面的行為題執行、不依賴字面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BANK_PW_NOTICE_LOCAL, BANK_PW_NOTICE_HOSTED, bankPasswordLabel, bankUploadGate, runBankUpload, runCardUpload,
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
  // hosted:false 掛在原型鏈上（Object.create）不可以放行本機句——鐵則 3.5 查表一律自有屬性
  //（審查 r1 抓到：讀原型鏈的寫法會被這種輸入騙出本機句）。
  assert.equal(bankPasswordLabel(Object.create({ hosted: false })), BANK_PW_NOTICE_HOSTED,
    '繼承來的 hosted:false 不算數（Object.hasOwn）：原型鏈上的值不可以放行本機句');
});

test('把關｜問一次模式、逾時走保守、等待期間切頁＝回報作廢', async () => {
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
  // 等待期間路由序號變了 ⇒ 回報 stale（真的不開窗＝runBankUpload 那組題的射程）。
  let seq = 1;
  r = await bankUploadGate({
    fetchMode: async () => { seq = 2; return { hosted: false }; },
    withTimeout: (w) => w, timeoutMs: 5, routeSeq: () => seq,
  });
  assert.equal(r.stale, true, '等待期間切頁要回報作廢');
});

test('編排｜連點只開一窗且鎖權在第一條流程、作廢不開窗、把關丟錯也解鎖——時序用執行驗、不靠字面', async () => {
  // 鎖＝注入的讀寫對（呼叫端掛在模組層級，不掛按鈕元素——同頁重繪換掉元素時鎖才不會蒸發）。
  const mkBusy = () => { let v = false; return { get: () => v, set: (/** @type {boolean} */ x) => { v = x; }, value: () => v }; };
  const mkForm = () => { const opened = /** @type {string[]} */ ([]); return { opened, open: (/** @type {string} */ label) => opened.push(label) }; };

  // 連點＋第三下：第一條流程還在等把關，第二、三下都必須立刻被 busy 擋掉——只開一窗、只問一次模式。
  // ⚠️ 被擋下的那幾下**不可以動到鎖**（鎖的所有權屬於第一條流程）：把 busy 檢查搬進 try/finally
  //    這種寫法，第二下會在自己的 finally 順手解鎖、第三下就闖進來——所以第二下之後要先斷言
  //    「鎖還在」，再送第三下驗證照樣被擋。
  // ⚠️ 每次 await 都帶一秒競速：上鎖若失效，後面那幾下會走進「等自己的把關」而永遠不回——
  //    這題要一秒內確定紅，不可以跟著吊死（同把關那題的競速理由）。
  {
    const busy = mkBusy(); const form = mkForm();
    /** @type {(v: {label: string, stale: boolean}) => void} */ let release = () => {};
    let gateCalls = 0;
    const gate = () => { gateCalls++; return new Promise((/** @type {any} */ res) => { release = res; }); };
    /** @type {any[]} */ const timers = [];
    const capped = (/** @type {Promise<any>} */ p, /** @type {string} */ why) =>
      Promise.race([p, new Promise((res) => { timers.push(setTimeout(() => res(why), 1000)); })]);
    try {
      const first = runBankUpload({ busy, gate, openUploadForm: form.open });
      const second = await capped(runBankUpload({ busy, gate, openUploadForm: form.open }),
        '（一秒沒回＝第二下沒被鎖住、卡在等自己的把關）');
      assert.equal(second, 'busy', '第二下要在 await 之前就被鎖住');
      assert.equal(busy.value(), true, '被擋下的第二下不可以動到鎖——鎖還得是第一條流程的');
      const third = await capped(runBankUpload({ busy, gate, openUploadForm: form.open }),
        '（一秒沒回＝第三下沒被鎖住）');
      assert.equal(third, 'busy', '第三下照樣要被擋（第二下若順手解鎖，這裡會闖進來）');
      release({ label: BANK_PW_NOTICE_HOSTED, stale: false });
      assert.equal(await capped(first, '（一秒沒回＝第一條流程沒收尾）'), 'opened');
      assert.deepEqual([form.opened.length, gateCalls, busy.value()], [1, 1, false],
        '三連點只准開一窗、只問一次模式，收尾要解鎖——上鎖那行被刪掉時這裡會抓到');
    } finally { for (const t of timers) clearTimeout(t); }
  }
  // 作廢：把關回報 stale ⇒ 一個窗都不准開（作廢檢查若搬到開窗之後，這裡會數到 1）。
  {
    const busy = mkBusy(); const form = mkForm();
    const r = await runBankUpload({
      busy,
      gate: async () => ({ label: BANK_PW_NOTICE_LOCAL, stale: true }),
      openUploadForm: form.open,
    });
    assert.deepEqual([r, form.opened.length, busy.value()], ['stale', 0, false], '作廢＝不開窗＋解鎖');
  }
  // 把關丟錯：錯誤往上傳（接線端看得見），但 finally 一定解鎖——不解鎖＝按鈕永久啞掉。
  {
    const busy = mkBusy(); const form = mkForm();
    await assert.rejects(
      () => runBankUpload({ busy, gate: () => Promise.reject(new Error('把關壞了')), openUploadForm: form.open }),
      /把關壞了/);
    assert.deepEqual([form.opened.length, busy.value()], [0, false], '丟錯不開窗、照樣解鎖');
  }
  // 開窗拿到的就是把關挑出的那句。
  {
    const busy = mkBusy(); const form = mkForm();
    const r = await runBankUpload({
      busy,
      gate: async () => ({ label: BANK_PW_NOTICE_LOCAL, stale: false }),
      openUploadForm: form.open,
    });
    assert.deepEqual([r, form.opened], ['opened', [BANK_PW_NOTICE_LOCAL]], 'label 逐字交給開窗端');
  }
});

test('文案｜雲端那句要坦白「會上傳」，而且不可殘留本機的宣稱', () => {
  // 這幾條鎖的是「誠實的骨架」，不是逐字措辭——William 改字不會誤紅，換回舊謊話一定紅。
  assert.match(BANK_PW_NOTICE_HOSTED, /上傳/, '雲端那句必須明講會上傳');
  assert.match(BANK_PW_NOTICE_HOSTED, /伺服器/, '雲端那句必須講去了伺服器');
  assert.doesNotMatch(BANK_PW_NOTICE_HOSTED, /只在這台電腦|不會上傳|不會傳上網路/, '雲端那句殘留任何本機宣稱＝舊病復發');
  assert.match(BANK_PW_NOTICE_LOCAL, /這台電腦/, '本機那句才可以講這台電腦');
  // P0.5 兌現 #438 埋的絆線（2026-08-11 使用者拍板銀行密碼改「可選儲存」）：舊承諾「不會儲存」
  // 從此是假話——句子改講「勾『記住』才會儲存」。鎖語意骨架：①兩句都要把儲存跟「記住」的
  // 勾選綁在一起（不勾＝不存）②無條件的「不會儲存」不得復活（那會反過來騙選了記住的人）
  // ③HOSTED 的儲存要講「加密」（機密待遇比照卡密＝拍板內容）。
  assert.match(BANK_PW_NOTICE_LOCAL, /記住/, '本機句要把儲存綁在「記住」勾選上');
  assert.match(BANK_PW_NOTICE_HOSTED, /記住/, '雲端句要把儲存綁在「記住」勾選上');
  assert.doesNotMatch(BANK_PW_NOTICE_LOCAL, /不會儲存/, '無條件「不會儲存」＝對勾了記住的人說謊');
  assert.doesNotMatch(BANK_PW_NOTICE_HOSTED, /不會儲存/);
  assert.match(BANK_PW_NOTICE_HOSTED, /加密/, '雲端儲存必須講加密（機密待遇＝拍板內容）');
  assert.notEqual(BANK_PW_NOTICE_LOCAL, BANK_PW_NOTICE_HOSTED, '兩句相同＝分流白做');
});

/** 去註解（接線題讀原始碼文字，照 AGENTS 的硬規則先把註解拿掉）。抄自 backup-export.test.js。 @param {string} raw */
function stripComments(raw) {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

test('接線｜cashflow.js 把模組層級的鎖／真把關／真開窗接進 runBankUpload，舊謊話絕跡', () => {
  // ⚠️ 先去註解：把接線改成註解就等於沒接，掃原始字面會給假綠（backup-export.test.js r5 阻擋②同款）。
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(src, /return runBankUpload\(\{/,
    '開窗要走共用編排——時序散寫回 cashflow.js 的話，行為題就打不到正式那一份');
  // 鎖必須是模組層級變數、不掛按鈕元素：同路由重繪（改月份／金流篩選）會換掉 #uploadBank，
  // 掛在元素上的鎖跟著蒸發＝新舊按鈕各開一窗。
  assert.match(src, /^let bankUploadBusy = false;/m, '連點鎖要住在模組層級（重繪換掉按鈕也不蒸發）');
  assert.match(src, /busy:\s*\{ get:\s*\(\)\s*=>\s*bankUploadBusy, set:\s*\(v\)\s*=>\s*\{ bankUploadBusy = v; \} \}/,
    '編排的鎖要接那顆模組層級變數——接成別的（例如恆 false）＝連點鎖形同虛設');
  assert.match(src, /fetchMode:\s*\(\)\s*=>\s*api\('\/mode'\)/, '把關要真的問 /api/mode');
  assert.match(src, /withTimeout:\s*defaultWithTimeout/, '等待上限要接匯出模組那顆共用計時器');
  assert.match(src, /timeoutMs:\s*MODE_TIMEOUT_MS/, '上限用共用常數，不可另抄一個數字');
  assert.match(src, /routeSeq:\s*currentRouteSeq/, '作廢判準要接真的路由序號');
  assert.match(src, /openUploadForm:\s*\(label\)\s*=>/, '開窗端要收把關挑出的那句');
  assert.match(src, /key: 'password', label,/, '密碼欄 label 只能來自把關結果，不可另寫一句');
  assert.doesNotMatch(src, /只在這台電腦解密、不會上傳/,
    '舊文案逐字回歸＝雲端版把「不會上傳」講給正在上傳的人聽');
  assert.doesNotMatch(src, /對帳單密碼（/,
    'cashflow.js 裡不准再出現手寫的密碼欄告知句——兩句與挑句判準只住 cashflow-model.js 一處');
});

test('接線｜transactions-import.js 卡片上傳把模組層級鎖／路由序號／真開窗接進 runCardUpload（P0.5 r1#5）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/transactions-import.js'), 'utf8'));
  assert.match(src, /runCardUpload\(\{/, '卡片開窗要走共用編排（時序防線在 cashflow-model.js，行為題直測）');
  assert.match(src, /^let cardUploadBusy = false;/m, '卡片連點鎖要住模組層級（重繪換鈕不蒸發）');
  assert.match(src, /busy:\s*\{ get:\s*\(\)\s*=>\s*cardUploadBusy, set:\s*\(v\)\s*=>\s*\{ cardUploadBusy = v; \} \}/,
    '編排的鎖要接那顆模組層級變數（接成恆 false＝鎖形同虛設）');
  assert.match(src, /routeSeq:\s*currentRouteSeq/, '作廢判準要接真的路由序號');
});

// ---------- 信用卡上傳的開窗編排（P0.5 r1#5：卡片線也要連點鎖／切頁作廢／finally 解鎖） ----------

test('卡片編排｜連點只開一窗、鎖權屬第一條流程、載卡片時切頁作廢不開窗、finally 解鎖——執行驗不靠字面', async () => {
  const mkBusy = () => { let v = false; return { get: () => v, set: (/** @type {boolean} */ x) => { v = x; }, value: () => v }; };

  // ① 正常：opened、開一次、事後鎖已解
  {
    const busy = mkBusy(); let opened = 0;
    const r = await runCardUpload({ busy, routeSeq: () => 1, loadCards: async () => [{ id: 'c1' }], openUploadForm: () => { opened++; } });
    assert.equal(r, 'opened'); assert.equal(opened, 1); assert.equal(busy.value(), false, 'finally 要解鎖');
  }
  // ② 連點：第一條還在載卡片時，第二下立刻被 busy 擋、且不碰鎖、不開窗
  {
    const busy = mkBusy(); let opened = 0;
    let release; const gate = new Promise((res) => { release = res; });
    const first = runCardUpload({ busy, routeSeq: () => 1, loadCards: () => gate.then(() => [{ id: 'c1' }]), openUploadForm: () => { opened++; } });
    const second = await runCardUpload({ busy, routeSeq: () => 1, loadCards: async () => [{ id: 'c1' }], openUploadForm: () => { opened++; } });
    assert.equal(second, 'busy', '第二下被鎖擋'); release();
    assert.equal(await first, 'opened'); assert.equal(opened, 1, '只開一窗');
    assert.equal(busy.value(), false);
  }
  // ③ 載卡片期間切頁（routeSeq 變）＝stale、不開窗
  {
    const busy = mkBusy(); let opened = 0; let seq = 1;
    const r = await runCardUpload({ busy, routeSeq: () => seq, loadCards: async () => { seq = 2; return [{ id: 'c1' }]; }, openUploadForm: () => { opened++; } });
    assert.equal(r, 'stale'); assert.equal(opened, 0, '切頁後一個窗都不准開'); assert.equal(busy.value(), false);
  }
  // ④ 沒有信用卡＝nocards（呼叫端提示去新增）、不開窗、鎖已解
  {
    const busy = mkBusy(); let opened = 0;
    const r = await runCardUpload({ busy, routeSeq: () => 1, loadCards: async () => [], openUploadForm: () => { opened++; } });
    assert.equal(r, 'nocards'); assert.equal(opened, 0); assert.equal(busy.value(), false);
  }
  // ⑤ 載卡片丟錯也要解鎖（否則上傳鈕永久啞掉）
  {
    const busy = mkBusy();
    await assert.rejects(runCardUpload({ busy, routeSeq: () => 1, loadCards: async () => { throw new Error('網路炸'); }, openUploadForm: () => {} }));
    assert.equal(busy.value(), false, 'finally 在丟錯時也要解鎖');
  }
});
