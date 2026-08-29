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
//   ・「密碼解析時只進記憶體；預設用完即丟，勾記住才依 LOCAL/HOSTED 機密規則儲存（P0.5）」是收支契約寫明的
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
  BANK_PW_NOTICE_LOCAL, BANK_PW_NOTICE_HOSTED, bankPasswordLabel, bankUploadGate, runBankUpload, runCardUpload, openWhenOnPage,
  BANK_UPLOAD_FILE_LABEL, BANK_UPLOAD_SUBMIT_LABEL, BANK_UPLOAD_BUSY_LABEL,
  bankPreviewFootnote,
  bankBlockedWarningHtml,
  bankSimilarWarningHtml,
  bankSimilarTagHtml,
  bankApplyLabel,
  bankApplyDoneText,
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
    withTimeout: (w) => w, timeoutMs: 5, navSeq: () => 7,
  });
  assert.deepEqual([r.label, r.stale, calls], [BANK_PW_NOTICE_LOCAL, false, 1]);
  // 連不上／被拒絕：不炸、走保守雲端句。
  r = await bankUploadGate({
    fetchMode: () => Promise.reject(new Error('斷線')),
    withTimeout: (w) => w, timeoutMs: 5, navSeq: () => 7,
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
        timeoutMs: 5, navSeq: () => 7,
      }),
      new Promise((_res, rej) => { raceTimer = setTimeout(() => rej(new Error('把關把「永不回應」原樣往上等＝等待上限沒接')), 1000); }),
    ]);
  } finally { clearTimeout(raceTimer); }
  assert.deepEqual([r.label, sawMs], [BANK_PW_NOTICE_HOSTED, 5], '逾時上限要真的交給計時器，逾時＝保守');
  // 等待期間路由序號變了 ⇒ 回報 stale（真的不開窗＝runBankUpload 那組題的射程）。
  let seq = 1;
  r = await bankUploadGate({
    fetchMode: async () => { seq = 2; return { hosted: false }; },
    withTimeout: (w) => w, timeoutMs: 5, navSeq: () => seq,
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
  assert.match(src, /navSeq:\s*currentNavSeq/, '作廢判準要接真的**換頁**序號（不是重繪序號）');
  assert.match(src, /openUploadForm:\s*\(label\)\s*=>/, '開窗端要收把關挑出的那句');
  assert.match(src, /key: 'password', label,/, '密碼欄 label 只能來自把關結果，不可另寫一句');
  assert.doesNotMatch(src, /只在這台電腦解密、不會上傳/,
    '舊文案逐字回歸＝雲端版把「不會上傳」講給正在上傳的人聽');
  assert.doesNotMatch(src, /對帳單密碼（/,
    'cashflow.js 裡不准再出現手寫的密碼欄告知句——兩句與挑句判準只住 cashflow-model.js 一處');
  // r4：切頁作廢改用 openWhenOnPage（排程＋執行兩次核對，行為由下面的單元題直測）——
  //   這裡鎖「每個 deferred 開窗點都經 openWhenOnPage、且不再有裸 setTimeout(()=>showBankPreview)」。
  assert.match(src, /const seq0 = currentNavSeq\(\);/, '銀行上傳窗要在開窗當下存下**換頁**序號（r9：接成重繪序號時密碼窗會靜靜不開）');
  // r18/r21：判準從 onPage 升級成 canOpenNext＝**還在同一頁 且（還沒關窗／或這次是送出成功的交棒）**
  //   ——使用者按取消也是「自己關的」，但那是撤銷、不放行。
  // ⚠️ 計數而非 match（P1b-2）：銀行線現在有**三個** onSubmit（上傳窗／密碼窗／同意窗），
  //   每一個都要自己算 canOpenNext——少一個，那條路的窗就會被同頁重繪判成已切頁而靜靜不開。
  assert.equal((src.match(/const canOpenNext = \(\) => onPage\(\) && ctx\.owns\.handoff\(\);/g) || []).length, 3,
    '排下一窗的判準要同時看換頁與彈窗格擁有權（r18 產線競態）；三個 onSubmit（上傳窗／密碼窗／同意窗）各一份');
  // ⚠️ 這一行的字面在**密碼窗成功**與**同意窗成功**兩處完全相同——用 match 只要有一處在就綠，
  //   移除另一處照樣過（r5#3 同型的假綠）。改成計數：少一條就紅。
  assert.equal((src.match(/openWhenOnPage\(canOpenNext, \(\) => showBankPreview\(r, b64, pw, onPage\)\)/g) || []).length, 3,
    '★密碼窗成功／同意窗成功／**直接送 AI 成功**各要開一次預覽窗（走 openWhenOnPage＋canOpenNext）——'
    + '少一條＝那條路的切頁作廢被拆掉了。第三條是 2026-08-13「預設不問、直接送」新增的 sendToAi。');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => showBankPreview\(r, b64, '', onPage\)\)/, '免密碼路徑開預覽窗要走 openWhenOnPage＋canOpenNext');
  // P1b-2：密碼窗多收一個 fileName——它後面還會開同意窗，而檔名必須來自「按下預覽當時」的快照
  //（讀可變的 file 會讓同意窗顯示 B、實際送出 A）
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => openPasswordWindow\(b64, snap\.fileName\)\)/, '池全敗跳密碼窗要走 openWhenOnPage＋canOpenNext，並帶上快照檔名');
  assert.doesNotMatch(src, /setTimeout\(\(\) => showBankPreview/, '不准有裸 setTimeout 開預覽窗（繞過切頁作廢）');
  assert.doesNotMatch(src, /setTimeout\(\(\) => openPasswordWindow/, '不准有裸 setTimeout 開密碼窗');
});

test('接線｜transactions-import.js 卡片上傳把模組層級鎖／路由序號／真開窗接進 runCardUpload（P0.5 r1#5）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/transactions-import.js'), 'utf8'));
  assert.match(src, /runCardUpload\(\{/, '卡片開窗要走共用編排（時序防線在 cashflow-model.js，行為題直測）');
  assert.match(src, /^let cardUploadBusy = false;/m, '卡片連點鎖要住模組層級（重繪換鈕不蒸發）');
  assert.match(src, /busy:\s*\{ get:\s*\(\)\s*=>\s*cardUploadBusy, set:\s*\(v\)\s*=>\s*\{ cardUploadBusy = v; \} \}/,
    '編排的鎖要接那顆模組層級變數（接成恆 false＝鎖形同虛設）');
  assert.match(src, /navSeq:\s*currentNavSeq/, '作廢判準要接真的**換頁**序號（不是重繪序號）');
  // r2#4：不只驗「有呼叫 runCardUpload」——loadCards 要真的載 /cards、openUploadForm 要真的開窗，
  //   否則把 openUploadForm 接成空函式＝正式 UI 一個窗都不開、形狀題卻全綠。
  assert.match(src, /loadCards:\s*async\s*\(\)\s*=>\s*\(await api\('\/cards'\)\)\.filter/,
    'loadCards 要真的打 /cards 再篩信用卡');
  assert.match(src, /openUploadForm:\s*\(cards\)\s*=>\s*openCardUploadForm\(cards\)/,
    'openUploadForm 要真的接開窗函式（接成空函式＝不開窗）');
  // r2#2：密碼窗問 /mode 期間切頁要作廢——挑句＋作廢走 bankUploadGate（不另抄一份 /mode 挑句）。
  assert.match(src, /bankUploadGate\(\{ fetchMode:\s*\(\)\s*=>\s*api\('\/mode'\)/,
    '卡片密碼窗的挑句＋作廢要走 bankUploadGate');
  assert.match(src, /const modalOk = watchModalRoot\(\);/,
    '問 /mode 之前要先唯讀觀察 #modal-root（r16：不可用 claim——那會搶走現在那個窗的擁有權）');
  assert.match(src, /if \(g\.stale \|\| !onPage\(\) \|\| !modalOk\(\)\) return;/,
    '問 /mode 期間切頁**或別人接管了彈窗格**（使用者關掉上傳窗改開別的窗）＝都不開密碼窗（r16 產線 bug）');
  // r4/r5#3：卡片線每個 deferred 開窗點（含選卡/改卡）都經 openWhenOnPage、無裸 setTimeout 開窗——
  //   **兩條 handlePreviewResult 各自斷言**（免密碼的空字串路徑＋密碼窗成功的 pw 路徑），泛化 regex
  //   只鎖一條時、移除另一條守門會假綠（r5#3 實測）。
  assert.match(src, /const seq0 = currentNavSeq\(\);/, '卡片上傳窗要在開窗當下存下**換頁**序號（r9：接成重繪序號時後續窗會靜靜不開）');
  // r18：同銀行線，四個後續開窗點都要走 canOpenNext（換頁＋彈窗格被接管都作廢）
  assert.equal((src.match(/const canOpenNext = \(\) => onPage\(\) && ctx\.owns\.handoff\(\);/g) || []).length, 4,
    '四個會排下一窗的 onSubmit（密碼窗／上傳窗／選卡窗／AI 同意窗）都要有 canOpenNext');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => handlePreviewResult\(r, b64, cards, '', onPage\)\)/, '免密碼路徑開後續窗要走 canOpenNext');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => handlePreviewResult\(r, b64, cards, pw, onPage\)\)/, '密碼窗成功路徑開後續窗要走 canOpenNext');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => openPasswordWindow\(b64, snap\.fileName\)\)/,
    '池全敗跳密碼窗要走 canOpenNext（且把快照檔名一路帶進去——密碼後備的同意窗才不會顯示「未命名」）');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => openStatementPreview\(/, '選卡重解析後開預覽窗要走 canOpenNext');
  // Codex r1#3（批二）：`file` 是 onchange 會改寫的外層變數——第一個 await 之前要凍快照，
  //   之後所有路只認 snap（晚讀 file?.name 會在「請求在途時改選 B」時顯示 B 的名字、實際送出 A）。
  assert.match(src, /const snap = snapshotUpload\(file\);[\s\S]{0,300}?await fileToBase64\(snap\.file\)/,
    '快照要在第一個 await 之前凍好、b64 從快照讀');
  assert.doesNotMatch(src, /file\?\.name/, '快照之後不准再讀可變的 file?.name（同意窗顯示與實際送出會分家）');
  // Codex r1#5（批二）：卡片線的送出中字樣與預覽徽章不可借銀行版——單讀沒有仲裁、也沒跑餘額鏈
  assert.match(src, /busyLabel: AI_CONSENT_BUSY_LABEL_CARD/, '卡片同意窗要用卡片版送出中字樣');
  assert.match(src, /aiCardPreviewBadgeHtml\(curR\)/, '卡片預覽要畫卡片版 AI 徽章');
  assert.doesNotMatch(src, /\baiPreviewBadgeHtml\(/, '銀行版徽章（餘額鏈／仲裁文案）不准出現在卡片線');
  // 改卡重解析（previewCard.onchange）＝直接 await 後 draw()，非 setTimeout；draw 前要有 onPage 核對（去註解後只剩裸 guard）
  assert.match(src, /const pr = await api\(`\/cards\/\$\{newId\}\/statement\/preview`[\s\S]{0,200}?if \(!onPage\(\)\) return;/,
    '改卡重解析 await 後、draw 前要核對切頁');
  assert.doesNotMatch(src, /setTimeout\(\(\) => (handlePreviewResult|openPasswordWindow|openStatementPreview)/, '不准有裸 setTimeout 開後續窗');
});

test('切頁作廢排程｜openWhenOnPage：同頁才開、排程前切頁不排、排完到執行前切頁不開', () => {
  // 這是 r4 把散寫 if(!onPage()) 收成的可測 helper——兩處核對（排程當下＋callback 執行當下）。
  let opened = 0;
  // ① 同頁：排程且執行都開
  {
    /** @type {(() => void)[]} */ const q = [];
    openWhenOnPage(() => true, () => { opened++; }, (fn) => q.push(fn));
    assert.equal(q.length, 1, '同頁＝有排程'); q[0](); assert.equal(opened, 1, '執行時仍同頁＝開');
  }
  // ② 排程前已切頁：根本不排、不開
  { let n = 0; /** @type {(() => void)[]} */ const q = []; openWhenOnPage(() => false, () => { n++; }, (fn) => q.push(fn));
    assert.deepEqual([q.length, n], [0, 0], '排程前切頁＝不排也不開'); }
  // ③ 排程時同頁、執行前切頁：排了但不開（callback 內第二次核對）
  { let onp = true; let n = 0; /** @type {(() => void)[]} */ const q = [];
    openWhenOnPage(() => onp, () => { n++; }, (fn) => q.push(fn));
    assert.equal(q.length, 1); onp = false; q[0](); assert.equal(n, 0, '執行時已切頁＝不開'); }
});

// ---------- 信用卡上傳的開窗編排（P0.5 r1#5：卡片線也要連點鎖／切頁作廢／finally 解鎖） ----------

// ⭐ r16（Codex 抓到的真實產線 bug）：開窗前的 await 期間，使用者可能關掉眼前的窗、改開別的窗——
// 晚回來的上傳／密碼窗不可以蓋上去。行為直測兩個編排函式（形狀題證明不了「真的沒開」）。
test('⭐ 編排｜等待期間別人接管了彈窗格＝一個窗都不開（銀行與卡片兩條線都要）', async () => {
  const mkBusy = () => { let v = false; return { get: () => v, set: (/** @type {boolean} */ x) => { v = x; }, value: () => v }; };

  // 銀行線：問 /mode 期間彈窗格被接管
  {
    const busy = mkBusy(); let opened = 0, taken = false;
    const r = await runBankUpload({
      busy,
      watchModal: () => () => !taken,                       // 觀察時還沒被接管；回來時已被接管
      gate: async () => { taken = true; return { label: 'L', stale: false }; },
      openUploadForm: () => { opened++; },
    });
    assert.equal(r, 'stale', '彈窗格被接管＝回報 stale');
    assert.equal(opened, 0, '不可以開窗蓋掉後開的那個窗');
    assert.equal(busy.value(), false, 'finally 仍要解鎖');
  }
  // 銀行線：沒被接管＝照常開
  {
    const busy = mkBusy(); let opened = 0;
    const r = await runBankUpload({
      busy, watchModal: () => () => true,
      gate: async () => ({ label: 'L', stale: false }),
      openUploadForm: () => { opened++; },
    });
    assert.deepEqual([r, opened], ['opened', 1], '沒人動過＝照常開窗（不可假性擋掉正常流程）');
  }
  // 卡片線：載卡片期間彈窗格被接管
  {
    const busy = mkBusy(); let opened = 0, taken = false;
    const r = await runCardUpload({
      busy, navSeq: () => 1,
      watchModal: () => () => !taken,
      loadCards: async () => { taken = true; return [{ id: 'c1' }]; },
      openUploadForm: () => { opened++; },
    });
    assert.equal(r, 'stale', '卡片線同理：彈窗格被接管＝stale');
    assert.equal(opened, 0, '不可以開窗蓋掉後開的那個窗');
    assert.equal(busy.value(), false, 'finally 仍要解鎖');
  }
  // 兩條線都要相容「沒注入 watchModal」（預設不擋，維持既有呼叫端不壞）
  {
    const busy = mkBusy(); let opened = 0;
    const r = await runCardUpload({ busy, navSeq: () => 1, loadCards: async () => [{ id: 'c1' }], openUploadForm: () => { opened++; } });
    assert.deepEqual([r, opened], ['opened', 1], '沒給 watchModal＝維持原行為');
  }
});

test('卡片編排｜連點只開一窗、鎖權屬第一條流程、載卡片時切頁作廢不開窗、finally 解鎖——執行驗不靠字面', async () => {
  const mkBusy = () => { let v = false; return { get: () => v, set: (/** @type {boolean} */ x) => { v = x; }, value: () => v }; };

  // ① 正常：opened、開一次、事後鎖已解
  {
    const busy = mkBusy(); let opened = 0;
    const r = await runCardUpload({ busy, navSeq: () => 1, loadCards: async () => [{ id: 'c1' }], openUploadForm: () => { opened++; } });
    assert.equal(r, 'opened'); assert.equal(opened, 1); assert.equal(busy.value(), false, 'finally 要解鎖');
  }
  // ② 連點：第一條還在載卡片時，第二下立刻被 busy 擋、且不碰鎖、不開窗
  {
    const busy = mkBusy(); let opened = 0;
    let release; const gate = new Promise((res) => { release = res; });
    const first = runCardUpload({ busy, navSeq: () => 1, loadCards: () => gate.then(() => [{ id: 'c1' }]), openUploadForm: () => { opened++; } });
    const second = await runCardUpload({ busy, navSeq: () => 1, loadCards: async () => [{ id: 'c1' }], openUploadForm: () => { opened++; } });
    assert.equal(second, 'busy', '第二下被鎖擋'); release();
    assert.equal(await first, 'opened'); assert.equal(opened, 1, '只開一窗');
    assert.equal(busy.value(), false);
  }
  // ③ 載卡片期間切頁（navSeq 變）＝stale、不開窗
  {
    const busy = mkBusy(); let opened = 0; let seq = 1;
    const r = await runCardUpload({ busy, navSeq: () => seq, loadCards: async () => { seq = 2; return [{ id: 'c1' }]; }, openUploadForm: () => { opened++; } });
    assert.equal(r, 'stale'); assert.equal(opened, 0, '切頁後一個窗都不准開'); assert.equal(busy.value(), false);
  }
  // ④ 沒有信用卡＝nocards（呼叫端提示去新增）、不開窗、鎖已解
  {
    const busy = mkBusy(); let opened = 0;
    const r = await runCardUpload({ busy, navSeq: () => 1, loadCards: async () => [], openUploadForm: () => { opened++; } });
    assert.equal(r, 'nocards'); assert.equal(opened, 0); assert.equal(busy.value(), false);
  }
  // ⑤ 載卡片丟錯也要解鎖（否則上傳鈕永久啞掉）
  {
    const busy = mkBusy();
    await assert.rejects(runCardUpload({ busy, navSeq: () => 1, loadCards: async () => { throw new Error('網路炸'); }, openUploadForm: () => {} }));
    assert.equal(busy.value(), false, 'finally 在丟錯時也要解鎖');
  }
});

test('文案｜上傳窗只留最少的字（William 2026-08-13）', () => {
  // ⚠️ 這一題**取代**了原本守 BANK_UPLOAD_NOTICE 的那組斷言。William 的方向：
  //    「介面簡單、好用、好理解；詳細說明放進 ⓘ」——上傳窗那段說明整塊移除。
  //    ⚠️ 隨之消失的是「沒按同意不會送出至 AI 公司」這句預告——因為同意窗本身也拿掉了
  //    （改成預設直接送、設定頁可開回詢問）。告知點因此移到**設定頁**與**預覽窗徽章**。
  assert.doesNotMatch(BANK_UPLOAD_FILE_LABEL, /台新|綜合對帳單/, '欄位名不可寫死單一銀行');
  assert.equal(BANK_UPLOAD_FILE_LABEL, '對帳單 PDF');
  assert.doesNotMatch(BANK_UPLOAD_SUBMIT_LABEL, /儲存/, '寫「儲存」會讓人以為當場寫進帳本了');
  assert.match(BANK_UPLOAD_SUBMIT_LABEL, /預覽|讀取/, '要講出下一步是預覽');
  // ★「按下去畫面不會像當掉」這個保證換了承載點：原本靠 toast，現在靠上傳鈕自己變字
  assert.match(BANK_UPLOAD_BUSY_LABEL, /稍候|請稍等/, '★送出後鈕要講「請稍候」（解析要好幾秒，只變灰看起來像當掉）');
  assert.doesNotMatch(BANK_UPLOAD_BUSY_LABEL, /讀取中|正在讀取/,
    '★按下去的第一件事是「上傳」，不是「讀取」——寫讀取會讓人以為已經在解析了');
});

test('接線｜上傳窗的三處文案都走 cashflow-model 的常數（不可在 cashflow.js 就地寫死）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(src, /label: BANK_UPLOAD_FILE_LABEL/, '欄位名走常數');
  assert.match(src, /busyLabel: BANK_UPLOAD_BUSY_LABEL/, '★上傳中的鈕字要真的接上（沒接＝畫面看起來像當掉）');
  assert.match(src, /submitLabel: BANK_UPLOAD_SUBMIT_LABEL/, '送出鈕文字走常數');
  assert.doesNotMatch(src, /台新綜合對帳單/, '★cashflow.js 不得再有寫死單一銀行的畫面文字');
});

test('文案｜「餘額不更新」提醒：不可要帳單內容、不可謊稱整份被擋（r1#1／r3#1／r5#2／#453）', () => {
  // ⚠️ 這題**直接考文案本身**（純函式），不是掃 cashflow.js 的拼字——形狀掃描守不住
  //    `r["blocked"]`、隱藏的前置分支這類等價寫法（r5#2 Codex 實測示範）。
  const warn = bankBlockedWarningHtml();
  assert.doesNotMatch(warn, /截圖|把帳單.*傳給|帳單內容傳/,
    '★不可要求使用者把帳單內容／截圖傳出來——回報只需要「哪一家銀行、哪一種版面」');
  assert.match(warn, /不用傳帳單內容|不需要傳帳單/, '★要主動講「不用傳帳單內容」');
  assert.match(warn, /哪一家銀行|哪一種版面/, '要講清楚回報時給什麼就夠了');
  // ★2026-08-13 行為改了：讀不到現值參考日不再整份擋下——餘額不更新、**交易照樣匯入**。
  //   文案必須跟著改，否則使用者會以為這份帳單完全不能用（那才是真正的損失：他會去手動記帳）。
  assert.doesNotMatch(warn, /整份已經被擋下|什麼都不會寫進去|整份失敗/,
    '★不可再說整份被擋——那已經不是事實，會嚇得使用者放棄這份帳單');
  assert.match(warn, /不會更新帳戶餘額|不更新.*餘額/, '★要講明真正受影響的是「帳戶餘額不更新」');
  assert.match(warn, /交易明細照樣匯入|交易照樣匯入/, '★也要講明交易還是會進來（不然使用者不知道能不能按確認）');
  assert.match(warn, /現值參考日/, '要講出是哪個欄位讀不到');
  assert.match(warn, /^<p [^>]*>[\s\S]*<\/p>$/, '回傳整段 <p>＝呼叫端不必再包一層');
});

test('接線｜「餘額不更新」提醒走 bankBlockedWarningHtml，cashflow.js 不可就地寫死（r5#2）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(src, /bankBlockedWarningHtml\(\)/, '★要真的接上（算了不用＝畫面看不到）');
  // 只禁**警語專屬**的句子：「現值參考日」在同一頁的資訊列是正當用字，不能一律禁。
  assert.doesNotMatch(src, /不用傳帳單內容|已經被擋下來了|哪一種版面/,
    '★警語文案不可留在 cashflow.js（就地寫死＝又回到「守拼字」那種考題守不住的狀態）');
});

test('接線｜預覽的「會匯入」清單要排除外幣列（r1#2）', () => {
  // 畫面那句是「以上 N 筆就是按下確認會匯入的全部內容」——正式匯入對非 TWD 直接跳過，
  // 外幣列若列在裡面，這句就是假的（互扣的另一半＝bank-statement.test.js 用真的 import 結果對數）。
  // 腳註本身已收成 cashflow-model 的 bankPreviewFootnote＝由本檔下面那兩題守（r2#1）。
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  const decl = (src.match(/const previewTx = [^\n]*/) || [''])[0];
  assert.ok(decl, '要有 previewTx 這份「會匯入」清單');
  assert.match(decl, /!x\.duplicate/, '已匯入過的不列進去');
  assert.match(decl, /!x\.foreign/, '★外幣列正式匯入會被跳過——列進「會匯入」等於畫面說謊');
});

test('腳註｜四種情況都要交代排掉的筆數——尤其「一筆都不匯入」那兩種（r2#1）', () => {
  // ① 有東西可匯入：講清楚「以上 N 筆就是全部」，排掉的另外交代
  const both = bankPreviewFootnote({ shown: 3, duplicate: 2, foreign: 1 });
  assert.match(both, /以上 3 筆/);
  assert.match(both, /2 筆之前已匯入過/);
  assert.match(both, /1 筆外幣明細不會匯入/);

  // ② ★整份只有外幣：舊版會落到「帳單裡沒有新交易」，使用者以為程式讀漏了
  const onlyForeign = bankPreviewFootnote({ shown: 0, foreign: 4 });
  assert.doesNotMatch(onlyForeign, /帳單裡沒有新交易/,
    '★「沒有新交易」是假的——有 4 筆，只是外幣不匯入；這樣講會讓人以為程式讀漏了');
  assert.match(onlyForeign, /4 筆外幣明細不會匯入/, '★要說出那 4 筆去哪了');

  // ③ ★整份只有重複：同理
  const onlyDup = bankPreviewFootnote({ shown: 0, duplicate: 5 });
  assert.doesNotMatch(onlyDup, /帳單裡沒有新交易/, '★這份有 5 筆，只是之前匯過了');
  assert.match(onlyDup, /5 筆之前已匯入過/);

  // ④ 真的一筆都沒有：那句才成立
  assert.equal(bankPreviewFootnote({ shown: 0 }), '帳單裡沒有新交易。');
  assert.equal(bankPreviewFootnote({ shown: 0, duplicate: 0, foreign: 0 }), '帳單裡沒有新交易。');
});

test('接線｜預覽的腳註走 bankPreviewFootnote，cashflow.js 不可自己再拼一句（r2#1）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(src, /bankPreviewFootnote\(\{ shown: previewTx\.length/, '★要把「真的會匯入的筆數」交給它算');
  assert.match(src, /duplicate: c\.duplicate, foreign: c\.foreign/, '排掉的兩種筆數都要餵進去');
  // 收成單一實作＝兩個分支不可能各說各話：就地寫死的版本必須絕跡
  assert.doesNotMatch(src, /帳單裡沒有新交易/, '★空狀態那句要由腳註函式決定（就地寫死＝只有外幣時又會說謊）');
  assert.doesNotMatch(src, /以上 \$\{previewTx\.length\} 筆/, '★「以上 N 筆」也不可再就地拼');
});

test('腳註｜blocked 不再改口，但確認鈕要回來（2026-08-13 行為變更）', () => {
  // ⚠️ 舊行為：讀不到現值參考日＝整份失敗 ⇒ 腳註要改口、確認鈕要拿掉（r3#1）。
  //    新行為：只有**餘額**不更新、交易照樣匯入 ⇒ 那兩件事都要**改回來**，
  //    否則畫面又會與實際發生的事不一致（只是這次是往「太悲觀」的方向錯）。
  assert.match(bankPreviewFootnote({ shown: 3 }), /以上 3 筆/, '★交易照樣匯入 ⇒ 腳註照常講「以上 N 筆會匯入」');
  const modelSrc = readFileSync(join(ROOT, 'public/modules/cashflow-model.js'), 'utf8');
  assert.doesNotMatch(modelSrc, /blocked = false|blocked\?: boolean/,
    '★`blocked` 參數已連同改口一起拿掉——留著沒人用的參數會讓下一個人以為它還有意義');

  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(src, /openInfo\('銀行對帳單預覽', body, \{ size: 'xl',\s*\n?\s*actionsHtml:/,
    '★確認鈕要一律給——按下去真的有事情發生（交易會匯入）');
  assert.doesNotMatch(src, /r\.blocked \? \{\} : \{ actionsHtml:/, '★不可再依 blocked 拿掉確認鈕');
});

test('文案｜疑似重複警語：講清楚原因與下一步，而且不可寫成「不會匯入」（r1#3）', () => {
  // ⚠️ 直接考文案本身：形狀掃描守不住「加個 hidden 就看不見」這種等價繞法（審查者實測）。
  const warn = bankSimilarWarningHtml(3);
  assert.match(warn, /3/, '要說出是幾筆');
  assert.match(warn, /兩種版面|版面/, '★要講出最可能的原因（同期間匯了兩種版面）');
  assert.match(warn, /收支頁|了解/, '要給下一步');
  assert.doesNotMatch(warn, /不會匯入|不匯入|已略過/,
    '★只提醒不擋：那幾筆照樣會匯入，寫成「不會匯入」是假的');
  for (const html of [warn, bankSimilarTagHtml()]) {
    assert.doesNotMatch(html, /\bhidden\b|display\s*:\s*none/,
      '★不可自己把自己藏起來（看不見的警語等於沒有警語）');
  }
  // ★r2#3：搬進純函式時我把樣板尾巴的 `' : '` 一起搬了進來＝**畫面真的印出多餘字元**。
  //   「含關鍵字」這種斷言抓不到尾端垃圾——要把整段的形狀釘住。
  const tag = bankSimilarTagHtml();
  assert.match(tag, /疑似重複/, '列標記要看得懂');
  assert.match(tag.trim(), /^<span [^>]*>[^<>]*<\/span>$/, '★整段就是一個 span，前後不可有殘留字元');
  assert.match(warn.trim(), /^<p [^>]*>[\s\S]*<\/p>$/, '★整段就是一個 p，前後不可有殘留字元');
  // ⚠️ 只用 ^…$ 還不夠（r3#2 實測）：在後面再接一個 <p>碎片</p>，貪婪比對照樣從第一個 <p 咬到
  //    最後一個 </p>＝全綠。要**數**頂層標籤，才是真的「就是一個」。
  // ⚠️ **要忽略大小寫**（r4#2 實測）：HTML 標籤名不分大小寫，`</P><P>碎片</P></p>` 在瀏覽器
  //    眼裡是三個頂層 P、碎片看得見，但區分大小寫的計數只數到一個 ⇒ 全綠。
  const countOf = (/** @type {string} */ h, /** @type {RegExp} */ re) => (h.match(re) || []).length;
  assert.equal(countOf(warn, /<p[\s>]/gi), 1, '★警語只准有一個 <p>（多接一段碎片也是畫面上的垃圾）');
  assert.equal(countOf(warn, /<\/p>/gi), 1, '★收尾標籤也只准一個');
  assert.equal(countOf(tag, /<span[\s>]/gi), 1, '★列標記只准有一個 <span>');
  assert.equal(countOf(tag, /<\/span>/gi), 1, '★收尾標籤也只准一個');
  for (const html of [warn, tag]) {
    assert.doesNotMatch(html, /['"`]\s*:\s*['"`]/, '★不可殘留樣板三元運算子的碎片（實測印在畫面上過）');
  }
});

test('接線｜疑似重複走純函式，而且**一律顯示**（#453 r1#2：交易照樣匯入，壓掉＝重複無聲入帳）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  // ⚠️ 要從 `${` 咬起（r2#3）：不錨定的話，在前面加個 `false &&` 讓警語**永久隱藏**，考題照樣綠。
  // ⚠️ 兩端都要咬（r3#2 實測）：只咬到函式呼叫的話，接一個 `.slice(0, 0)` 讓輸出永遠是空字串，
  //    考題照樣綠。所以從 `${` 咬到 `: ''}`——中間不准夾任何東西。
  // ⚠️ **2026-08-13 行為變更後這一題整個反過來**：`blocked` 現在只代表「餘額不更新」，
  //    交易**照樣會進帳本** ⇒ 壓掉疑似重複提醒＝跨版式的重複交易**無聲入帳**。
  //    舊版考題還主動鎖著「整份都不會寫進去」那個已經不成立的理由——那比沒有考題更糟。
  assert.match(src, /\$\{c\.similar \? bankSimilarWarningHtml\(c\.similar\) : ''\}/,
    '★疑似重複警語不可被壓掉——交易照樣會匯入，壓掉等於讓重複無聲進帳');
  assert.match(src, /\$\{x\.similar \? bankSimilarTagHtml\(\) : ''\}/, '★逐列標記同樣要一律顯示');
  assert.doesNotMatch(src, /!r\.blocked && [cx]\.similar/, '★不可再用 blocked 壓掉疑似重複');
  assert.doesNotMatch(src, /疑似重複/, '★文案不可留在 cashflow.js（就地寫死＝又回到守拼字的考題）');
  // ★r4#1：兩個插值本身沒被動，整份 body 卻可以在送進 openInfo 之前被截掉（`body.slice(0, 0)`）
  //   ⇒ 使用者看到一片空白而考題全綠。把送出那一手也釘死：只准原封不動地交出去。
  assert.match(src, /openInfo\('銀行對帳單預覽', body, \{/,
    '★body 要原封不動交給 openInfo（中途轉換＝畫面可以被整份掏空而考題看不到）');
});

test('型別契約｜previewBankTxForDb 的 @param 要緊貼函式本身（r3#3）', () => {
  // ⚠️ 這條**不能交給 typecheck**：中間插一個**沒有註解**的宣告時 TS 會喊 TS8024（會被抓到），
  //    但插一個**有 JSDoc 的 helper**時它一聲不吭——註解變成孤兒、`parsed` 悄悄退化成 `any`，
  //    整條金流預覽路徑的欄位拼錯從此不再被型別檢查攔下（我在 a83488a 就是這樣弄壞的，
  //    三關全綠、審查者用 tsc 的解析結果量出來才發現）。所以用形狀題把「緊貼」釘死。
  // ⚠️ **不可用「掃到這個樣子就算」**（r4#3 實測）：在中間插 helper、再放一行含相同字樣的普通
  //    註解當誘餌，正則照樣命中。改成**位置**判定：那段字只准出現一次，且它的註解收尾之後
  //    **緊接著**就必須是那個函式（中間只准空白）。
  const src = readFileSync(join(ROOT, 'lib/services/bank-import.js'), 'utf8');
  // 錨點用**這個函式獨有**的說明句（`@param {any} db @param {ParsedBankFull} parsed` 這串
  // 本身同檔有兩個函式合法共用，拿它當唯一性錨點會誤紅）。
  const anchor = '交易明細分箱預覽（純函式、不寫檔）';
  assert.notEqual(src.indexOf(anchor), -1, '要有那段文件註解');
  assert.equal(src.indexOf(anchor), src.lastIndexOf(anchor), '★這句只准出現一次（第二份就是誘餌）');
  const after = src.slice(src.indexOf(anchor));
  const head = after.match(/^[\s\S]{0,400}?@param \{any\} db @param \{ParsedBankFull\} parsed\s*\*\//);
  assert.ok(head, '★型別註解要跟這段說明在同一個註解區塊裡，而且正常收尾');
  assert.ok(after.slice(head[0].length).trimStart().startsWith('export function previewBankTxForDb'),
    '★收尾之後必須立刻就是 previewBankTxForDb（helper 請放在註解之前）');
});

test('文案｜讀不到現值參考日時，鈕上與完成提示都不可說「更新餘額」（r1#3）', () => {
  // ⚠️ 這條線一路在修的同一種病：**畫面說的跟實際做的不一樣**。
  //    鈕上寫「更新餘額＋匯入交易」但那次不更新餘額；完成提示照報「更新 0、新建 0」
  //    看起來像「有跑過但沒東西可更新」，其實是「根本沒試」。
  assert.match(bankApplyLabel(false), /更新餘額/, '正常情況照舊');
  // ⚠️ 不能直接禁「更新餘額」四個字——「**不**更新餘額」裡也有它。要禁的是**承諾**要更新。
  assert.doesNotMatch(bankApplyLabel(true), /(?<!不)更新餘額/, '★不更新餘額時鈕上不可承諾要更新');
  assert.match(bankApplyLabel(true), /只匯入交易|不更新餘額/, '★要講明這次只匯交易');

  const done = bankApplyDoneText({ updated: 0, created: 0, balancesSkipped: true }, { imported: 3 });
  assert.match(done, /沒有更新|沒更新/, '★完成提示要主動說「餘額沒更新」');
  assert.match(done, /現值參考日/, '★要講原因（不然使用者不知道為什麼）');
  assert.match(done, /匯入 3/, '★交易的數字照報');
  assert.doesNotMatch(done, /更新 0、新建 0/, '★不可報成「更新 0」——那看起來像試過了但沒東西可更新');

  const ok = bankApplyDoneText({ updated: 2, created: 1, balancesSkipped: false }, { imported: 5, skipped: 1 });
  assert.match(ok, /更新 2、新建 1/); assert.match(ok, /匯入 5/); assert.match(ok, /略過重複 1/);
  // 第二種「沒更新餘額」＝這份帳單根本沒有可更新的帳戶（簽帳金融卡明細只印末四碼那條路）
  const none = bankApplyDoneText({ updated: 0, created: 0, noAccounts: true }, { imported: 48 });
  assert.match(none, /沒有可更新的帳戶/, '★不可印「更新 0、新建 0」讓人以為壞了');
  assert.doesNotMatch(none, /更新 0/, '★零就不要報數字');
  assert.equal(bankApplyLabel(false, true), '確認：只匯入交易（這次不更新餘額）',
    '★鈕上的字要跟畫面上「只匯入交易明細」那句一致（r1#2：兩句原本互相矛盾）');
  assert.equal(bankApplyLabel(false, false), '確認：更新餘額＋匯入交易', '一般情況不變');
});

test('接線｜鈕字與完成提示都要真的接上（算了不用＝畫面看不到）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  // ⚠️ 第二個參數＝「這份帳單沒有可更新的帳戶」（Codex #492 r1#2）：只吃 blocked 會讓
  //    簽帳金融卡明細那條路上面寫「只匯入交易明細」、鈕卻寫「更新餘額＋匯入交易」。
  // Grok #494 掃 G3：ambiguous 列讓 rows 非空、舊判準 !rows.length 會讓鈕謊稱「更新餘額」——
  // 判準改成「有沒有任何真的會動餘額的列」（update/create/mature-zero）。
  assert.match(src, /bankApplyLabel\(!!r\.blocked, !rows\.some\(/, '★鈕字要看「會不會真的動餘額」，不是「有沒有列」');
  assert.doesNotMatch(src, /bankApplyLabel\(!!r\.blocked, !rows\.length\)/, '★舊判準不可回來（全歧義時它說謊）');
  assert.match(src, /from '\.\/cashflow-model\.js'/);
  assert.match(src, /toast\(bankApplyDoneText\(res, t, .*\.recipe\)\)/, '★完成提示要走那個函式且第三參數釘到 res.recipe（塞 undefined/錯欄位＝這裡紅）');
  assert.doesNotMatch(src, /確認：更新餘額＋匯入交易/, '★鈕字不可再就地寫死');
});
