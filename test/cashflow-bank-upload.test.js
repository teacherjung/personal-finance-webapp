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
  BANK_UPLOAD_FILE_LABEL, BANK_UPLOAD_NOTICE, BANK_UPLOAD_SUBMIT_LABEL,
  bankPreviewFootnote,
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
  assert.equal((src.match(/openWhenOnPage\(canOpenNext, \(\) => showBankPreview\(r, b64, pw, onPage\)\)/g) || []).length, 2,
    '密碼窗成功與同意窗成功各要開一次預覽窗（走 openWhenOnPage＋canOpenNext）——少一條＝那條路的切頁作廢被拆掉也全綠');
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
  assert.equal((src.match(/const canOpenNext = \(\) => onPage\(\) && ctx\.owns\.handoff\(\);/g) || []).length, 3,
    '三個會排下一窗的 onSubmit（密碼窗／上傳窗／選卡窗）都要有 canOpenNext');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => handlePreviewResult\(r, b64, cards, '', onPage\)\)/, '免密碼路徑開後續窗要走 canOpenNext');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => handlePreviewResult\(r, b64, cards, pw, onPage\)\)/, '密碼窗成功路徑開後續窗要走 canOpenNext');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => openPasswordWindow\(b64\)\)/, '池全敗跳密碼窗要走 canOpenNext');
  assert.match(src, /openWhenOnPage\(canOpenNext, \(\) => openStatementPreview\(/, '選卡重解析後開預覽窗要走 canOpenNext');
  // 改卡重解析（previewCard.onchange）＝直接 await 後 draw()，非 setTimeout；draw 前要有 onPage 核對（去註解後只剩裸 guard）
  assert.match(src, /const pr = await api\(`\/cards\/\$\{newId\}\/statement\/preview`[\s\S]{0,120}?if \(!onPage\(\)\) return;/,
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

test('文案｜上傳窗不寫死單一銀行，但誠實講「內建範本認得什麼、認不得會怎樣」（William 2026-08-12）', () => {
  // 原文「對帳單 PDF（台新綜合對帳單）」已過期——AI 路線存在的理由正是不再侷限單一銀行。
  assert.doesNotMatch(BANK_UPLOAD_FILE_LABEL, /台新|綜合對帳單/, '欄位名不可寫死單一銀行');
  // ⚠️ William 2026-08-12 逐點裁示：**不提台新**（未來內建讀取不會只有一家，點名會再過期一次）；
  //    但也不可反過來吹成「支援各家銀行」——用「認不出這個版面時會怎樣」來表達，不宣稱支援範圍。
  assert.doesNotMatch(BANK_UPLOAD_NOTICE, /台新|綜合對帳單/, '說明也不點名單一銀行');
  assert.doesNotMatch(BANK_UPLOAD_NOTICE, /支援各家銀行|支援所有銀行|任何銀行都|都讀得懂/, '不可吹成全面支援');
  assert.match(BANK_UPLOAD_NOTICE, /認不出|認不得/, '要講「認不出這個版面」的情況');
  assert.match(BANK_UPLOAD_NOTICE, /AI/, '要預告會問「要不要交給 AI 讀」——使用者才知道那個窗為什麼跳出來');
  // ★預設收起來（William 裁示）：真正的隱私把關在同意窗，這裡只是預告
  assert.match(BANK_UPLOAD_NOTICE, /<details>[\s\S]*<summary>/, '★說明要收合，想知道的人自己點開');
  // ★「沒同意就不送」是這一句在上傳階段唯一要守死的保證（William 2026-08-12 版）。
  //   「送的是抽出來的文字、不是 PDF 檔」等細節已移到**同意窗**（那裡才是真正的告知點，
  //   由 test/ai-consent.test.js 的 E 群守）——這裡不重複，避免同一句話兩處維護而走鐘。
  assert.match(BANK_UPLOAD_NOTICE, /沒按同意不會送出|沒按同意.*不會送/, '★沒按同意＝不會送出，要講死');
  assert.match(BANK_UPLOAD_NOTICE, /AI 公司|AI公司/, '要點明送去的是外部 AI 公司');
  assert.doesNotMatch(BANK_UPLOAD_NOTICE, /有可能傳給|可能會傳給|系統會自動送/,
    '★不可寫成「有可能傳給」——會讓人以為系統可能背著他送，比事實更嚴重（拍板是每次都問）');
  // 送出鈕：這個窗按下去是上傳並預覽，不是存檔
  assert.doesNotMatch(BANK_UPLOAD_SUBMIT_LABEL, /儲存/, '寫「儲存」會讓人以為當場寫進帳本了');
  assert.match(BANK_UPLOAD_SUBMIT_LABEL, /預覽|讀取/, '要講出下一步是預覽');
});

test('接線｜上傳窗的三處文案都走 cashflow-model 的常數（不可在 cashflow.js 就地寫死）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(src, /label: BANK_UPLOAD_FILE_LABEL/, '欄位名走常數');
  assert.match(src, /bodyHtml: BANK_UPLOAD_NOTICE/, '★說明句要真的交給 openForm 渲染（算了不用＝畫面看不到）');
  assert.match(src, /submitLabel: BANK_UPLOAD_SUBMIT_LABEL/, '送出鈕文字走常數');
  assert.doesNotMatch(src, /台新綜合對帳單/, '★cashflow.js 不得再有寫死單一銀行的畫面文字');
});

test('文案｜擋下的警語不可叫使用者把帳單內容傳給我（r1#1）', () => {
  const src = readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8');
  // 範圍鎖在那段警語本身：整份檔案掃字串會被別處的句子矇混過去。
  const warn = (src.match(/r\.blocked \? `[^`]*`/) || [''])[0];
  assert.ok(warn, '要有「讀不到現值參考日」的擋下警語');
  assert.doesNotMatch(warn, /截圖|把帳單.*傳給|帳單內容傳/,
    '★不可要求使用者把帳單內容／截圖傳出來——回報只需要「哪一家銀行、哪一種版面」');
  assert.match(warn, /不用傳帳單內容|不需要傳帳單/, '★要主動講「不用傳帳單內容」');
  assert.match(warn, /哪一家銀行|哪一種版面/, '要講清楚回報時給什麼就夠了');
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
