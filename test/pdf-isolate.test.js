// @ts-check
// PDF 行程隔離（HOSTED 專用，2026-07-29）：**一份小檔不可以把共用主機打掛**。
//
// 病根（自審抓到的兩個 blocking，都已重現）：
//     138 KB 的**一頁** PDF（約 200 萬個文字節點）→ 行程死掉，峰值 612MB
//     207 KB 的**一頁** PDF（內容串流解壓後 83MB）→ 行程死掉，峰值 704MB
// 兩份都**結構完全合法**，而**當時**那兩道牆（頁數、事後才數的 `countTextItems`）都看到「正常」。
// ⚠️ 「都看到正常」講的是 2026-07-29 之前；之後文字節點牆改成邊收邊數，這兩顆現在**會**被它擋下
//    （前提是取消真的生效——那正是 2026-08-29 修的東西）。
//
// ⚠️ **死法不只 OOM**：也可能是「跑不完」——子行程沒有輸出，父行程只好靠逾時收回。
//
// ⚠️ **這一段的成因被寫錯過兩次，第二次 2026-08-29 才追到底**（起因＝CI 間歇紅）：
//    v1 全寫成 OOM；v2 寫成「pdfjs 卡死在解壓、promise 永不 settle」，於是炸彈題改驗 `pdf_timeout`
//    ——**那個綠燈也是為了錯的理由**。真因是 `lib/parse-limits.js` 的取消少帶一個 `Error` 理由
//   （pdfjs 會 assert 它），取消從沒生效、pdfjs 生產端永遠等下去＝**卡住是我們自己造成的**。
//    修好之後炸彈由文字節點牆當場擋下（約 1.9 秒的乾淨 400），本檔的炸彈題因此改驗
//    `pdf_too_many_text_items`；「逾時／提早死」那一族改用**行為確定的假子行程**測（見「一之二」節）。
//
// ⚠️ **本檔學到最貴的一課：替身比本尊寬鬆＝假綠。** 假的 pdfjs 頁面寫成 `async cancel() {…}`
//   （不收參數、不驗理由），收下了真 pdfjs 會拒絕的呼叫，於是三題「邊收邊數」測的是一個
//    不存在的世界，而 production 的取消一年來從沒生效過。**替身要照抄本尊會拒絕什麼。**
//
// 為什麼是隔離而不是再蓋一道牆：蓋牆就得自己先掃一遍 PDF 判斷「這份貴不貴」，
// 而那正是今晚在 XLSX 上被打穿**四次**的模式——牆與解析器對格式的理解只要差一點
// （枚舉方式、欄位偏移、信不信宣告值），就從那個縫鑽過去。
// PDF 的物件結構比 ZIP 難得多，自己寫掃描器幾乎一定會犯同一個錯。
// **隔離不需要看懂格式**：把成本關進子行程，怎麼死都不影響父行程（heap 上限管 OOM、
// keep-alive＋父行程逾時管卡死）。
//
// ⚠️ **LOCAL 刻意不套**（William 2026-07-29 裁決）：這道防線保護的是「多人共用的那台機器」，
//    本機只有自己在用、檔案都是自己從銀行下載的，不值得付每次 250ms 的代價。
//    **這代表 LOCAL 仍然帶著這個洞——那是明知的取捨，不是漏掉的。**
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SITE_ORIGIN = 'https://example.com';
process.env.NOTEASY_MASTER_KEY = Buffer.alloc(32, 3).toString('base64');

const { parseStatement } = await import('../lib/statement.js');
const { parseBankStatement } = await import('../lib/bank-statement.js');
const { PDF_ISOLATE_KINDS, PDF_CHILD_HEAP_MB, PDF_QUEUE_MAX_DEPTH, setPdfTimeoutForTest,
  setPdfChildScriptForTest, resetPdfQueueForTest, pdfQueueDepthForTest, extractPdfLines,
  throughPdfQueueForTest } = await import('../lib/pdf-isolate.js');

// ---------------------------------------------------------------------------
// 手工造 PDF（同 test/pdf-limits-wiring.test.js 的手法：不進版控、造得出來就看得懂）
// ---------------------------------------------------------------------------
/** @param {string[]} objs @param {Record<number, Buffer>} streams @param {string=} extraTrailer */
function build(objs, streams = {}, extraTrailer = '') {
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  /** @type {number[]} */
  const off = [];
  let pos = parts[0].length;
  for (let i = 1; i < objs.length; i++) {
    off[i] = pos;
    const h = Buffer.from(`${i} 0 obj\n${objs[i]}\n`, 'latin1'); parts.push(h); pos += h.length;
    if (streams[i]) {
      const s = Buffer.concat([Buffer.from('stream\n', 'latin1'), streams[i], Buffer.from('\nendstream\n', 'latin1')]);
      parts.push(s); pos += s.length;
    }
    const t = Buffer.from('endobj\n', 'latin1'); parts.push(t); pos += t.length;
  }
  const x0 = pos;
  let x = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) x += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length} /Root 1 0 R ${extraTrailer} >>\nstartxref\n${x0}\n%%EOF\n`;
  parts.push(Buffer.from(x, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
const PAGE = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R '
  + '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>';

/** 一頁、內容串流解壓後極大的 PDF——**結構完全合法**，只是解析它很貴。 @param {number} reps */
function bombPdf(reps) {
  const raw = Buffer.from('BT /F1 1 Tf 1 1 Td (A) Tj ET\n'.repeat(reps), 'latin1');
  const comp = deflateSync(raw, { level: 9 });
  /** @type {string[]} */
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Count 1 /Kids [4 0 R] >>';
  objs[3] = `<< /Length ${comp.length} /Filter /FlateDecode >>`;
  objs[4] = PAGE;
  return build(objs, { 3: comp });
}
/** 正常的小 PDF（有文字、可抽得出來）。 */
function normalPdf() {
  const body = Buffer.from('BT /F1 12 Tf 72 720 Td (hello world) Tj ET', 'latin1');
  /** @type {string[]} */
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Count 1 /Kids [4 0 R] >>';
  objs[3] = `<< /Length ${body.length} >>`;
  objs[4] = PAGE;
  return build(objs, { 3: body });
}

/**
 * 造一份**會讓 pdfjs 丟 `PasswordException` 的 PDF**（736 bytes）。
 *
 * ⚠️ 我原本自陳「沒有真的加密 PDF 可測」——**那是錯的**（Codex 定向複審指出）。
 *    不需要真的加密內容：trailer 有 `/Encrypt` 指到一個標準安全處理器字典，
 *    pdfjs 在開檔階段就會走密碼分支。
 *    這一題非有不可：**跨行程之後最容易壞掉的就是「錯誤訊息被換成通用訊息」**，
 *    而使用者該看到的是「PDF 密碼錯誤／這份 PDF 有加密」，不是「伺服器錯誤」。
 */
function encryptedPdf() {
  /** @type {string[]} */
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Count 1 /Kids [4 0 R] >>';
  objs[3] = '<< /Length 20 >>';
  objs[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R >>';
  objs[5] = `<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -1 >>`;
  return build(objs, { 3: Buffer.from('BT /F1 12 Tf ET', 'latin1') },
    `/Encrypt 5 0 R /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>]`);
}

/** @param {Promise<any>} p */
const errOf = (p) => p.then(() => null, (/** @type {any} */ e) => e);

// ⚠️ **集中還原，不靠每題自己記得**（Codex #538 r1 實測的缺口）：兩個測試接縫都是 module-global，
//    而「漏還原」不會被下一題抓到——下一題只要自己也設了值，就把污染靜靜蓋過去
//   （他刪掉某一題的還原，22 題照樣全綠）。所以這裡是**共同兜底**：不管哪一題漏了、或中途
//    斷言失敗提早離開，接縫都會被還原；拿掉這個 hook 就會有題轉紅（突變驗過）。
// ⚠️ **不是「各題都不准有自己的 finally」**（Codex #538 r2：那句話與同檔現況不符）——
//    炸彈題就有自己的 `finally { setPdfTimeoutForTest(null); }`。兜底與局部清理是兩件事，不衝突：
//    局部清理讓「這一題自己的意圖」看得見，afterEach 保證**漏掉的那次不會污染下一題**。
afterEach(() => { setPdfTimeoutForTest(null); setPdfChildScriptForTest(null); });

// ============================================================================
// 一、攻擊：子行程死掉，**父行程必須活著**
// ============================================================================

test('內容串流炸彈：一頁的小 PDF **由文字節點牆當場擋下 400**，父行程活著', async () => {
  // ⚠️ **這題的真相被誤解過兩次**（第二次 2026-08-29 追出）：
  //    v1 以為炸彈讓子行程 OOM；v2 改寫成「pdfjs 卡在解壓、promise 永不 settle，靠父行程逾時收回」，
  //    於是本題期待 `pdf_timeout`——**那個綠燈也是為了錯的理由**。真相是
  //    `readPageTextCapped` 的 `reader.cancel()` 沒帶 Error 理由（pdfjs 會 assert 後拒絕、
  //    `.catch()` 又把拒絕吞掉）⇒ 取消從沒生效 ⇒ `task.destroy()` 永不回來。
  //    **卡住是我們自己造成的，不是 pdfjs 的脾氣。** 修好之後這顆炸彈由牆在約 1.9 秒當場擋下。
  // ⚠️ 逾時在這裡只是**絆索**：牆若又失效，20 秒收場而不是 30 秒。它不該是本題的通過條件——
  //    收到 `pdf_timeout` 就代表牆沒接住、只是被行程隔離兜住（那正是本題以前的樣子）。
  setPdfTimeoutForTest(20_000);
  try {
    const data = bombPdf(3_000_000);
    assert.ok(data.length < 300 * 1024,
      `攻擊檔要小得可笑才有說服力（實際 ${Math.round(data.length / 1024)}KB）——這就是「檔案大小預測不了成本」`);
    const err = await errOf(parseStatement(data));
    assert.ok(err, '攻擊檔竟然通過了');
    assert.equal(err.code, 'pdf_too_many_text_items',
      `要由文字節點牆當場擋下（實際 ${err.code}）——收到 pdf_timeout＝牆又沒接住、只是被行程隔離兜住`);
    assert.equal(err.status, 400, '這是使用者層錯誤（他的檔案太貴），不是 500');
    assert.match(String(err.message), /文字節點|正常的對帳單/, '訊息要讓使用者知道該做什麼');
    // ⚠️ **這裡刻意沒有時間斷言**（Codex #538 r6 Medium）：我上一版寫了 `< 15_000`，
    //    結果它自己在一次完整 `npm test` 裡以 20.19 秒轉紅、重跑又綠——**正是本支要消滅的那個病**
    //   （同一顆 commit 一次紅一次綠），而且它量的其實是「整台機器跑全套時有多忙」。
    //    「是牆擋的、不是逾時兜的」這件事由上面那條 `code` 斷言證明就夠了：逾時會是 `pdf_timeout`。
  } finally { setPdfTimeoutForTest(null); }
});

test('連打五次攻擊檔，父行程的記憶體不可以往上爬（沒有洩漏、也沒有累積）', async () => {
  // ⚠️ 逾時要**寬鬆**：訂太緊會變成跟「牆多快擋下」競速（本題以前正是靠逾時才綠的）。
  setPdfTimeoutForTest(20_000);
  const data = bombPdf(310_000);   // 剛好超過 30 萬節點的最小攻擊檔（22KB、約 1.5 秒到達門檻）
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 5; i++) {
    const err = await errOf(parseStatement(data));
    assert.equal(err?.code, 'pdf_too_many_text_items', `第 ${i + 1} 次沒被擋下（實際 ${err?.code}）`);
  }
  setPdfTimeoutForTest(null);
  const grew = (process.memoryUsage().rss - before) / 1048576;
  // 這一題守的是「隔離有沒有真的把成本擋在子行程裡」——父行程幾乎不該長。
  assert.ok(grew < 60, `父行程在五次攻擊後長了 ${grew.toFixed(0)}MB——成本沒有被擋在子行程裡`);
});

// ============================================================================
// 一之二、父行程對子行程死法的**歸類**（用行為確定的假子行程，不靠時間競速）
//
// ⚠️ 這三題取代了「餵一顆讓 pdfjs 卡住的 PDF」那種寫法。舊寫法在 CI 上失敗耗時
//    2.91／2.98／3.02 秒、逾時 3.00 秒＝**餘裕 3%**，同一顆 commit 一次紅一次綠
//   （2026-08-28〜09-01 共紅 10 場，指紋逐字相同）。假子行程的行為是確定的。
// ============================================================================

/** @param {string} name */
const fakeChild = (name) => join(ROOT, 'test-doubles', name);

test('歸類｜子行程**真的卡住** → 等到逾時才 SIGKILL、回誠實的 400 pdf_timeout', async () => {
  setPdfChildScriptForTest(fakeChild('pdf-child-hang.js'));
  setPdfTimeoutForTest(500);
  {
    const t0 = Date.now();
    const err = await errOf(parseStatement(normalPdf()));
    assert.ok(err, '子行程卡住竟然還回了結果');
    assert.equal(err.code, 'pdf_timeout', `卡住要說「卡太久」（實際 ${err.code}）`);
    assert.equal(err.status, 400, '卡太久是使用者層錯誤（他的檔案太貴）');
    assert.match(String(err.message), /太久|上限/, '訊息要讓使用者知道該做什麼');
    assert.ok(Date.now() - t0 >= 500,
      '必須是「等到逾時」才收回——提早回來代表它是被別的原因判掉的，不是真的等過');
  }
});

test('歸類｜子行程**提早死（未捕捉例外、code 1）** → 500，**絕不可以假裝成 400**', async () => {
  // ⚠️ 這是 2026-08-28〜09-01 CI 那十場紅的真實形狀（pdfjs 的 ERR_INVALID_STATE 沒人接）。
  //    當時本檔的炸彈題就是**因為收到 500 才紅的**——那個 500 是對的，紅的是題目寫錯了期待。
  //    把 500 併進「可接受的結果」＝重新放行 #350 r2 修掉的那個病：
  //    child 入口打錯、相依壞掉、程式例外一樣沒有 stdout，全判 400 會**責怪使用者、藏起我們的故障**。
  setPdfChildScriptForTest(fakeChild('pdf-child-crash.js'));
  setPdfTimeoutForTest(5_000);   // 給得很寬：本題要看的是「它自己死」，不是逾時
  {
    const t0 = Date.now();
    const err = await errOf(parseStatement(normalPdf()));
    assert.ok(err, '子行程炸了竟然還回了結果');
    assert.equal(err.status, 500, `我們這邊的故障是 500（實際 ${err.status}）`);
    assert.equal(err.code, 'pdf_isolate_child_failed', `實際 ${err.code}`);
    assert.notEqual(err.code, 'pdf_timeout', '提早死不是「卡太久」——它根本沒等到逾時');
    assert.notEqual(err.code, 'pdf_resource_exhausted', '也不可以猜成資源耗盡：我們並不知道它為什麼死');
    assert.ok(!/太久|文字節點/.test(String(err.message)), '對外訊息不可以說成使用者的檔案有問題');
    assert.ok(Date.now() - t0 < 4_000, '它是自己死的，不該等到逾時');
  }
});

test('歸類｜子行程**安靜退出（code 0、零輸出）** → 一樣是 500，不可以猜成資源耗盡', async () => {
  // 這是 2026-08-01 看到、被誤診成「pdfjs 卡在解壓」的形狀（真因見 parse-limits 的 cancelStream）。
  // 正式子行程掛 keep-alive 就是為了不長成這樣；父行程這一側則要**照實說不知道**。
  setPdfChildScriptForTest(fakeChild('pdf-child-silent.js'));
  setPdfTimeoutForTest(5_000);
  {
    const err = await errOf(parseStatement(normalPdf()));
    assert.ok(err, '子行程什麼都沒回，竟然還當成成功');
    assert.equal(err.status, 500, `沒有輸出＝我們不知道發生什麼事，只能是 500（實際 ${err.status}）`);
    assert.equal(err.code, 'pdf_isolate_child_failed', `實際 ${err.code}`);
  }
});

test('三個抽取器都走同一層隔離（不是只修了信用卡那條）', async () => {
  // ⚠️ 換掉舊寫法的理由（2026-08-29）：舊版餵炸彈檔、等 `pdf_timeout`，證明力來自「pdfjs 會卡住」。
  //    修好 cancel 之後炸彈由牆擋下，而**牆在兩種模式下都會動**（`readPageTextCapped` 在抽取器裡），
  //    所以 `pdf_too_many_text_items` **證明不了走過子行程**。
  //    改法：裝上「一定會卡住」的假子行程，餵一份**正常的小 PDF**——
  //      ・有走隔離 ⇒ 假子行程卡住 ⇒ pdf_timeout
  //      ・沒走隔離 ⇒ 它自己在行程內把這份正常 PDF 解析成功 ⇒ 本題紅
  //    順帶補上證券那條（舊版只測了銀行）。
  const { parseTaishinSecuritiesPdf } = await import('../lib/taishin-securities.js');
  setPdfChildScriptForTest(fakeChild('pdf-child-hang.js'));
  setPdfTimeoutForTest(500);
  {
    /** @type {[string, (d: Uint8Array) => Promise<any>][]} */
    const entries = [
      ['信用卡帳單', parseStatement],
      ['銀行對帳單', parseBankStatement],
      ['證券對帳單', parseTaishinSecuritiesPdf],
    ];
    for (const [name, parse] of entries) {
      const err = await errOf(parse(normalPdf()));
      assert.equal(err?.code, 'pdf_timeout',
        `${name}那條沒接上隔離——它自己在行程內解析了這份正常 PDF（實際 ${err?.code ?? '成功回傳'}）`);
    }
  }
});

test('診斷｜子行程回報的**封閉代碼**要進父行程日誌（HOSTED 唯一的出聲管道）', async () => {
  // ⚠️ Codex #538 r3 High：取消失敗時「原本的 400 照樣回得去」⇒ 父行程走 parsed 4xx 分支、
  //    完全不看子行程 stderr ⇒ 在 HOSTED（最需要聽見的那個環境）是**靜默**的。
  //    修法＝封閉代碼隨 JSON 帶回來、父行程照代碼記日誌（不轉印 stderr——那會把帳單內容帶進日誌）。
  const logged = [];
  const real = console.error;
  console.error = (/** @type {any[]} */ ...a) => { logged.push(a.map(String).join(' ')); };
  setPdfChildScriptForTest(fakeChild('pdf-child-diag.js'));
  setPdfTimeoutForTest(5_000);
  let err;
  try {
    err = await errOf(parseStatement(normalPdf()));
  } finally { console.error = real; }
  assert.equal(err?.code, 'pdf_too_many_text_items', '前提：這支假子行程回的是使用者層 400');
  assert.ok(logged.some((m) => /子行程診斷/.test(m) && m.includes('pdf_cancel_failed')),
    `取消失敗的診斷沒有進父行程日誌（實際：${JSON.stringify(logged).slice(0, 200)}）`
    + '——那正是本支在修的「靜靜失效」的另一種形狀');
});

test('診斷｜**真的**子行程回傳的 JSON 要帶 diag 欄位（成功與失敗兩條路都要）', async () => {
  // ⚠️ 上面兩題用的是假子行程，證明不了「正式子行程真的會帶」——拿掉 `diag: await takeDiag()`
  //    那兩題照樣全綠（實測）。這一題直接跑正式子行程、看它吐出來的原始 JSON。
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  /** @param {Uint8Array} pdf */
  const runChild = async (pdf) => {
    const child = run(process.execPath, [join(ROOT, 'lib/pdf-isolate-child.js'), 'statement'],
      { env: { ...process.env, NOTEASY_HOSTED: '1' }, maxBuffer: 32 * 1024 * 1024 });
    child.child.stdin?.end(`${JSON.stringify({ password: '' })}\n${Buffer.from(pdf).toString('base64')}`);
    return JSON.parse((await child).stdout);
  };
  const ok = await runChild(normalPdf());
  assert.equal(ok.ok, true, '前提：正常 PDF 這條路要走得通');
  assert.ok(Array.isArray(ok.diag), '成功那條路沒有帶 diag 欄位——父行程就永遠收不到診斷');
  const bad = await runChild(new Uint8Array([0x25, 0x50, 0x44, 0x46]));   // 只有 "%PDF"
  assert.equal(bad.ok, false, '前提：畸形 PDF 這條路要失敗');
  assert.ok(Array.isArray(bad.diag), '失敗那條路沒有帶 diag 欄位——取消失敗剛好都走這條');
});

test('診斷｜**真的**子行程跑真的攻擊檔，非空診斷要一路到父行程日誌', async () => {
  // ⚠️ Codex #538 r4 High：上一版只驗「有 diag 欄位」，把子行程的 takeDiag() 改成永遠回空陣列
  //    整檔照樣全綠——這條通道可以再次整條靜默而守門不紅。
  //    這一題走**真的子行程＋真的攻擊檔**：文字節點牆擋下時會留 `pdf_cap_hit`，
  //    它必須穿過子行程的 JSON、通過父行程的白名單、出現在日誌裡。
  const logged = [];
  const real = console.error;
  console.error = (/** @type {any[]} */ ...a) => { logged.push(a.map(String).join(' ')); };
  setPdfTimeoutForTest(20_000);
  let err;
  try {
    err = await errOf(parseStatement(bombPdf(310_000)));
  } finally { console.error = real; }
  assert.equal(err?.code, 'pdf_too_many_text_items', '前提：這份檔要被牆擋下');
  assert.ok(logged.some((m) => /子行程診斷/.test(m) && m.includes('pdf_cap_hit')),
    `牆擋下了，但診斷沒有到父行程日誌（實際：${JSON.stringify(logged).slice(0, 200)}）`
    + '——通道斷在哪一段都會讓 HOSTED 重新變回靜默');
});

test('診斷｜正常 PDF 不可以留下任何診斷代碼（不然這個訊號就沒有意義了）', async () => {
  const logged = [];
  const real = console.error;
  console.error = (/** @type {any[]} */ ...a) => { logged.push(a.map(String).join(' ')); };
  try {
    await parseStatement(normalPdf()).catch(() => {});   // 正常小 PDF：抽得到東西、走不到任何診斷
  } finally { console.error = real; }
  assert.ok(!logged.some((m) => /子行程診斷/.test(m)),
    `正常解析竟然也留下診斷代碼（${JSON.stringify(logged).slice(0, 160)}）——那會讓真正的訊號被淹掉`);
});

test('診斷｜父行程只收**白名單內**的代碼（子行程回什麼都不能決定日誌長什麼樣）', async () => {
  // ⚠️ Codex #538 r4 High：上一版只掃 `KNOWN_DIAG.has(` 這個字樣，把回傳值丟掉、全部放行
  //    照樣全綠。改成**行為題**：餵一堆不該被信任的東西進來，看父行程實際記了什麼。
  const { PARSE_DIAG } = await import('../lib/parse-limits.js');
  const logged = [];
  const real = console.error;
  console.error = (/** @type {any[]} */ ...a) => { logged.push(a.map(String).join(' ')); };
  setPdfChildScriptForTest(fakeChild('pdf-child-diag-junk.js'));
  setPdfTimeoutForTest(5_000);
  let err;
  try {
    err = await errOf(parseStatement(normalPdf()));
  } finally { console.error = real; }
  assert.equal(err?.code, 'pdf_too_many_text_items', '前提：這支假子行程回的是使用者層 400');
  const line = logged.find((m) => /子行程診斷/.test(m)) || '';
  assert.ok(line.includes(PARSE_DIAG.CANCEL_FAILED), '白名單內的代碼被過濾掉了');
  for (const c of [...'龘䶵鱻麤龗厵']) {
    assert.ok(!line.includes(c), `未知代碼裡的 PII 哨兵「${c}」進了日誌——白名單沒有真的在過濾`);
  }
  assert.ok(!/pdf_flood_/.test(line), '超量的未知代碼進了日誌');
  assert.ok(!/object|42|null/.test(line), '非字串的項目進了日誌');
  assert.ok(line.length < 200, `診斷那一行長 ${line.length} 字——子行程可以決定日誌長度就是一種放大器`);
});

test('連打五次**逾時**：反覆 SIGKILL 收回子行程之後，父行程記憶體不可以往上爬', async () => {
  // ⚠️ Codex #538 r3 Medium：main 的記憶體題原本五次都走 timeout／SIGKILL，我改成走文字節點牆
  //    之後，**反覆強制收回**那條路就沒人測了（那是「未經裁決的既有保證弱化」）。
  //    牆那一題保留（在上面），這一題把 SIGKILL 那條補回來，用行為確定的假子行程、不靠 pdfjs 脾氣。
  setPdfChildScriptForTest(fakeChild('pdf-child-hang.js'));
  setPdfTimeoutForTest(400);
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 5; i++) {
    const err = await errOf(parseStatement(normalPdf()));
    assert.equal(err?.code, 'pdf_timeout', `第 ${i + 1} 次沒有走到逾時（實際 ${err?.code}）`);
  }
  const grew = (process.memoryUsage().rss - before) / 1048576;
  assert.ok(grew < 60, `父行程在五次逾時收回後長了 ${grew.toFixed(0)}MB——被 SIGKILL 的子行程沒有被清乾淨`);
});

// ============================================================================
// 二、正確性：隔了一層行程，結果與錯誤都要**原味**過得來
// ============================================================================

test('正常 PDF 的抽取結果穿過行程邊界之後**逐項相同**（不是「兩邊都失敗」就算過）', async () => {
  // ⚠️ 這一題 v1 是**假考題**（Codex 定向複審抓到）：它只驗「兩邊都走到『找不到明細』」，
  //    沒有真的比對抽出來的資料。Codex 用正確的保存型突變（子行程回傳前刪掉第一列）
  //    → **7/7 照樣全綠**。
  //    「隔離有沒有把資料弄壞」比「有沒有擋住攻擊」更容易被忽略，
  //    而它壞掉的樣子是**帳單少了幾筆卻沒有人發現**——比整個失敗嚴重得多。
  const { extractPdfLines } = await import('../lib/pdf-isolate.js');
  const { extractLinesForIsolation } = await import('../lib/statement.js');
  const data = normalPdf();

  const direct = await extractLinesForIsolation(data);                                  // 行程內
  const viaChild = await extractPdfLines('statement', extractLinesForIsolation, data);  // 走子行程（HOSTED）

  assert.ok(direct.length > 0, '前置條件：抽得到東西（不然這題等於沒測）');
  assert.deepEqual(viaChild, direct,
    '跨行程之後抽出來的資料不一樣了——隔離層把資料弄壞了');
});

test('**加密 PDF** 的密碼訊息要原味穿過行程邊界（不可以被換成「伺服器錯誤」）', async () => {
  // ⚠️ 這是這一層最容易搞砸的地方：使用者該看到「這份 PDF 有加密，請設定密碼」，
  //    卻因為錯誤在行程邊界被吞掉／改寫，變成「伺服器錯誤」——他就完全不知道該做什麼。
  // ⚠️ v1 用畸形 `%PDF` 測，**根本沒走到密碼分支**（Codex 定向複審抓到）。
  //    我原本自陳「沒有真的加密 PDF 可測」也是錯的——736 bytes 就造得出來。
  const err = await errOf(parseStatement(encryptedPdf()));
  assert.ok(err, '加密 PDF 沒給密碼應該失敗');
  assert.equal(err.status, 400, '這是使用者層錯誤（要他去設密碼），不是 500');
  assert.match(String(err.message), /加密|密碼/,
    `要是抽取器自己的密碼訊息，不是隔離層的通用訊息（實際：${err.message}）`);
  assert.ok(!/\/Users\/|node_modules|at Object\./.test(String(err.message)), '不可洩漏路徑或堆疊');
});

test('畸形 PDF 的錯誤也要原味帶回來（另一條錯誤路徑）', async () => {
  const junk = new Uint8Array([0x25, 0x50, 0x44, 0x46]);   // 只有 "%PDF"
  const err = await errOf(parseStatement(junk));
  assert.ok(err, '畸形 PDF 應該失敗');
  assert.equal(err.status, 400, '畸形輸入是使用者層錯誤');
  assert.match(String(err.message), /PDF 無法開啟/, '要是抽取器自己的訊息，不是隔離層的通用訊息');
  assert.ok(!/\/Users\/|node_modules|at Object\./.test(String(err.message)), '不可洩漏路徑或堆疊');
});

// ============================================================================
// 三、契約：兩個檔案的種類清單必須一致
// ============================================================================

test('**PDF 密碼絕不可進 argv／env**（＝身分證字號；`ps` 就讀得到）——Codex #350 r1 抓到的 PII 洩漏', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join, dirname } = await import('node:path');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const parent = readFileSync(join(ROOT, 'lib/pdf-isolate.js'), 'utf8');
  const child = readFileSync(join(ROOT, 'lib/pdf-isolate-child.js'), 'utf8');

  // ① 父端：spawn 的 argv 陣列裡不准出現 password
  const m = parent.match(/spawn\(process\.execPath,\s*\n?\s*\[([^\]]*)\]/);
  assert.ok(m, '找不到 spawn 的 argv 陣列（結構變了就要重寫本題）');
  assert.ok(!/password/i.test(m[1]),
    `spawn 的 argv 出現 password：${m[1].trim()}\n` +
    'PDF 密碼＝身分證字號，argv 會出現在 `ps` 的行程清單裡、同機任何程式都讀得到。改走 stdin 首行標頭。');

  // ② 父端：也不准用環境變數（/proc/<pid>/environ 一樣讀得到）
  assert.ok(!/env\s*:\s*\{[^}]*password/i.test(parent), 'spawn 的 env 出現 password（environ 讀得到）');

  // ③ 子端：密碼只能從 stdin 標頭來，不准讀 argv／env
  assert.ok(!/process\.argv\[\d\]\s*\|\|?[^\n]*[Pp]assword/.test(child) && !/PASSWORD\s*=\s*process\.argv/.test(child),
    '子行程從 argv 讀密碼');
  assert.ok(!/process\.env\.[A-Z_]*PASSWORD/.test(child), '子行程從 env 讀密碼');
  assert.match(child, /header\.password/, '子行程應從 stdin 首行標頭取密碼');
});

test('`PDF_ISOLATE_KINDS` 與子行程的 EXTRACTORS 必須一一對應（漏一個＝那條路悄悄不隔離）', () => {
  const child = readFileSync(join(ROOT, 'lib/pdf-isolate-child.js'), 'utf8');
  const inChild = [...child.matchAll(/^\s{2}(\w+):\s*async \(\)/gm)].map(m => m[1]);
  assert.deepEqual([...PDF_ISOLATE_KINDS].sort(), inChild.sort(),
    '兩邊的種類清單對不上——父行程送一個子行程不認得的 kind，會變成 500');
  assert.ok(PDF_CHILD_HEAP_MB >= 128 && PDF_CHILD_HEAP_MB <= 320,
    `子行程 heap 上限 ${PDF_CHILD_HEAP_MB}MB 不合理：太小會誤殺大帳單、太大就失去隔離的意義`);
});

test('架構｜接縫護欄必須還掛在 eslint.config.js 上（規則被拿掉＝lint 從此安靜全綠）', async () => {
  const cfg = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');
  const { SEAM_SELECTORS } = await import('../eslint.config.js');
  assert.ok(SEAM_SELECTORS.length >= 2,
    '接縫護欄的選擇器清單被縮短了——識別字與字串兩種形都要有，少一種就開一個門');
  // ⚠️ flat config 的同名規則是**整組覆蓋不是合併**（eslint.config.js 檔頭有這條病歷）：
  //    有人把接縫護欄另開一組，lint 會全綠、而護欄其實沒在跑。所以這裡驗它接在同一個陣列裡。
  assert.match(cfg, /'no-restricted-syntax': \['error',[\s\S]*?\.\.\.SEAM_SELECTORS,[\s\S]*?\],/,
    '接縫護欄沒有接在主組那個 no-restricted-syntax 陣列裡——同名規則會整組覆蓋，等於沒裝');
  // 正式程式碼的豁免只准有一個：宣告處
  assert.ok(cfg.includes("files: ['lib/pdf-isolate.js']"),
    '宣告處的豁免組不見了——那組沒了的話 lib/pdf-isolate.js 自己會被自己的護欄擋下（lint 紅）');
  // ⚠️ 這題**不宣稱**「正式碼豁免只有一個」（Codex #538 r3：上一版那樣寫，但它算出來的東西
  //    根本沒證明這件事）。真正關門的是執行期那道（下一題），本題只負責「執法者還掛著」。
});

test('架構｜**執行期**的門：不在測試行程呼叫接縫一定要丟錯（ESLint 擋不住算出來的成員存取）', async () => {
  // ⚠️ 這一題是 Codex #538 r3 High 的收法。靜態規則有天花板：
  //    `m[`模板字串`](…)` 與 `m['setPdfChild' + 'ScriptForTest'](…)` 都是合法 JS，ESLint 零錯。
  //    ⇒ 門改放在執行期：不在測試行程就丟錯，**不管用什麼語法呼叫**。
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // 刻意用「算出來的成員存取」呼叫＝ESLint 擋不住的那一種，證明第二層真的接得住
  const code = 'const m = await import(process.argv[1]);'
    + " const name = 'setPdfChild' + 'ScriptForTest';"
    + " try { m[name]('/tmp/evil.js'); console.log('NO_THROW'); }"
    + " catch (e) { console.log('THREW:' + e.message.slice(0, 30)); }";
  // ⚠️ 一定要把 NODE_TEST_CONTEXT 拿掉：本題自己就跑在測試行程裡，不清掉等於在測自己
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await run(process.execPath,
    ['--input-type=module', '-e', code, join(ROOT, 'lib/pdf-isolate.js')], { env });
  assert.match(stdout, /^THREW:/,
    `正式行程裡呼叫接縫竟然成功了（${stdout.trim()}）——那表示子行程腳本在正式環境是可以被換掉的`);
});

test('架構｜執行期那道門：偽造環境值／目錄外／連結／目錄要擋；目錄內的一般檔要放行且釘住原檔', async () => {
  // ⚠️ Codex #538 r4/r5/r6：這道門是**防誤用**的，不是安全邊界（環境變數誰都能設）。
  //    它買到的是「**設定當下**，指到的必須是 test-doubles/ 裡的一般檔案，而且之後 spawn 的
  //    就是那一個」。⚠️ 它**不防**驗完之後把檔案換掉（TOCTOU）、目錄內 hardlink 到外部、
  //    或整個 test-doubles/ 根目錄被換成連結——那些都要有「能改 checkout」的同等權限，
  //    而有那個權限的人本來就能直接改正式程式碼（r6 判定：不必再加固，照實寫下來即可）。
  //    r5 實證上一版擋不住：目錄內放一個指向 /bin/echo 的符號連結就過關了，
  //    而且驗的是算出來的絕對路徑、交給 spawn 的卻是原字串（相對路徑遇上 cwd 改變就對不上）。
  // ⚠️ **只准碰自己建的路徑**（Codex #538 r7 Medium）：上一版用固定名稱建了五個路徑再遞迴刪掉，
  //    他實測預先放辨識檔進去 → 兩題都顯示通過、**五個檔案全被刪掉**。`npm test` 是 push 前必跑的，
  //    考題把開發者未追蹤的檔案清掉是「工具自己破壞工作樹」。改用 mkdtemp 取唯一目錄。
  const { symlinkSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { setPdfChildScriptForTest: seam } = await import('../lib/pdf-isolate.js');
  const doubles = join(ROOT, 'test-doubles');
  const probeDir = mkdtempSync(join(doubles, '_probe_'));      // test-doubles/ 內的唯一目錄
  const link = join(probeDir, 'link.js');
  const sibling = mkdtempSync(join(ROOT, 'test-doubles-evil-'));   // 前綴相同的兄弟目錄（唯一名）
  try {
    // ① 偽造的環境值
    const saved = process.env.NODE_TEST_CONTEXT;
    try {
      process.env.NODE_TEST_CONTEXT = 'not-a-real-test-context';
      assert.throws(() => seam(fakeChild('pdf-child-hang.js')), /只能在 Node 測試執行器/,
        '偽造的環境值被放行了——那等於「設個環境變數就開門」');
    } finally { process.env.NODE_TEST_CONTEXT = saved; }

    // ② 目錄外的絕對路徑
    assert.throws(() => seam('/bin/echo'), /test-doubles/, '目錄外的腳本被放行了');
    // ③ 不存在的檔案
    assert.throws(() => seam(join(doubles, '_不存在_.js')), /找不到子行程腳本|test-doubles/,
      '不存在的檔案要給看得懂的錯，不是原始的 ENOENT');
    // ④ `..` 跳出去
    assert.throws(() => seam(join(doubles, '..', 'lib', 'pdf-isolate-child.js')), /test-doubles/,
      '用 .. 跳出目錄被放行了');
    // ⑤ 前綴相同的**兄弟目錄**（test-doubles-evil-XXXX/）
    writeFileSync(join(sibling, 'x.js'), '// probe\n');
    assert.throws(() => seam(join(sibling, 'x.js')), /test-doubles/,
      '前綴相同的兄弟目錄被放行了（字串前綴比對的經典洞）');
    // ⑥ **目錄內的符號連結指到外面**（r5 實證的那一個）
    symlinkSync('/bin/echo', link);
    assert.throws(() => seam(link), /test-doubles|一般檔案/,
      '目錄內的符號連結指到 /bin/echo 竟然被接受——真實路徑沒有被走到底');
    // ⑦ 目錄本身（或指向目錄的連結）不是一般檔案——spawn 一個目錄只會得到看不懂的錯
    assert.throws(() => seam(probeDir), /一般檔案/, '目錄被當成子行程腳本收下了');
    // ⑧ 目錄內的一般檔案要**放行**，而且保存的是 canonical 路徑——用行為證明，不是讀原始碼
    //    ⚠️ 上一版在這裡讀 `lib/pdf-isolate.js` 再用 regex 找 `childScriptOverride = real;`
    //    ——那是「斷言文字出現過」，留著那行當誘餌、實際 spawn 另一個相對路徑，題目照樣綠
    //   （Codex #538 r6 Medium）。改成：用相對路徑設定 → 改回原本的 cwd → **真的跑一次解析**。
    //    跑得到那支「會卡住」的假替身 ⇒ pdf_timeout（＝執行的是設定當下那個檔）；
    //    若保存的是相對字串，從別的 cwd 去 spawn 會找不到檔案 ⇒ 500 pdf_isolate_child_failed。
    const cwd = process.cwd();
    try {
      process.chdir(doubles);
      assert.doesNotThrow(() => seam('./pdf-child-hang.js'), '目錄內的一般檔案（相對路徑）應該放行');
    } finally { process.chdir(cwd); }
    setPdfTimeoutForTest(500);
    const viaRelative = await errOf(parseStatement(normalPdf()));
    assert.equal(viaRelative?.code, 'pdf_timeout',
      `改了 cwd 之後跑的不是原本那個檔（實際 ${viaRelative?.code}）——保存的不是驗證過的 canonical 路徑，`
      + '就是「驗 A 跑 B」');
    assert.doesNotThrow(() => seam(null), '傳 null 還原不可以被路徑檢查擋下');
  } finally {
    // 只刪本題自己建的那兩個唯一目錄（mkdtemp 保證不會撞到別人的東西）
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
    seam(null);
  }
});

test('架構｜正式程式碼碰接縫的**各種寫法**都要被 lint 擋下（regex 版曾漏掉三種普通寫法）', async () => {
  // ⚠️ 這一題取代了原本自己寫 regex 逐行掃的架構題。那一版宣稱「加一個呼叫者就轉紅」，
  //    但實測**別名 import／換行呼叫／`.call`** 三種都照樣全綠——同 xlsx 那條的教訓：
  //    用正規表示式解析一門語言補不完，執法者要換成看語法樹的 ESLint。
  //    本題的職責因此改成**盯著執法者真的會開火**（下面列舉的寫法只是證據，不是護欄本體）。
  // ⚠️ 同上（r7 Medium）：唯一目錄、只刪自己建的
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const probeDir = mkdtempSync(join(ROOT, 'lib', '_seam_probe_'));
  const pubProbeDir = mkdtempSync(join(ROOT, 'public', '_seam_probe_'));
  const IMP = "import { setPdfChildScriptForTest } from '../pdf-isolate.js';\n";
  const FORMS = [
    ['直接呼叫', `${IMP}export function a() { setPdfChildScriptForTest('/tmp/x.js'); }\n`],
    ['別名 import', "import { setPdfChildScriptForTest as install } from '../pdf-isolate.js';\n"
      + "export function b() { install('/tmp/x.js'); }\n"],
    ['換行呼叫', `${IMP}export function c() {\n  setPdfChildScriptForTest\n    ('/tmp/x.js');\n}\n`],
    ['.call', `${IMP}export function d() { setPdfChildScriptForTest.call(null, '/tmp/x.js'); }\n`],
    ['.apply', `${IMP}export function e() { setPdfChildScriptForTest.apply(null, ['/tmp/x.js']); }\n`],
    ['存進變數再呼叫', `${IMP}const f = setPdfChildScriptForTest;\nexport function g() { f('/tmp/x.js'); }\n`],
    ['namespace 引入＋成員存取', "import * as iso from '../pdf-isolate.js';\n"
      + "export function h() { iso.setPdfChildScriptForTest('/tmp/x.js'); }\n"],
    ['動態引入＋成員存取', "export async function i() {\n"
      + "  const m = await import('../pdf-isolate.js');\n  m.setPdfChildScriptForTest('/tmp/x.js');\n}\n"],
    ['字串形的成員存取', "export async function j() {\n"
      + "  const m = await import('../pdf-isolate.js');\n  m['setPdfChildScriptForTest']('/tmp/x.js');\n}\n"],
    ['re-export（把接縫轉手出去）', "export { setPdfChildScriptForTest } from '../pdf-isolate.js';\n"],
  ];
  try {
    const paths = FORMS.map(([name, src], k) => {
      const f = join(probeDir, `p${k}.js`);
      writeFileSync(f, src);
      return [name, f, src];
    });
    // ⚠️ **前端也要有探針**：全部放 lib/ 的話，有人把護欄的 files 縮成只掃 lib/**，
    //    這題仍然全綠、public/ 靜默失守（同 xlsx 那題踩過的坑）。
    const pubFile = join(pubProbeDir, 'probe.js');
    writeFileSync(pubFile, "import { setPdfChildScriptForTest } from '../../lib/pdf-isolate.js';\n"
      + "export function k() { setPdfChildScriptForTest('/tmp/x.js'); }\n");
    const byFile = new Map([...(await eslintSeamFindings(probeDir)), ...(await eslintSeamFindings(pubProbeDir))]);
    for (const [name, f, src] of paths) {
      assert.ok((byFile.get(f) || []).length > 0,
        `「${name}」這種寫法沒有被擋下——它是合法 JS，正式程式碼可以照這樣換掉 PDF 子行程腳本。\n原始碼：\n${src}`);
    }
    assert.ok((byFile.get(pubFile) || []).length > 0,
      'public/ 底下碰接縫沒有被擋下——護欄的 files 範圍被縮窄了');
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(pubProbeDir, { recursive: true, force: true });
  }
});

/** 跑真的 eslint，只收接縫護欄報的那些。（一次掃一個目錄——一個樣本 spawn 一次太慢） @param {string} dir */
async function eslintSeamFindings(dir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const stdout = await run('npx', ['eslint', '--format', 'json', dir], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })
    .then((r) => r.stdout, (/** @type {any} */ e) => String(e?.stdout || '[]'));
  const out = new Map();
  for (const r of JSON.parse(stdout)) {
    out.set(r.filePath, (r.messages || []).filter((m) => /setPdfChildScriptForTest/.test(String(m.message || ''))));
  }
  return out;
}

test('三個抽取器都真的呼叫了 extractPdfLines（架構題：不准有人繞過隔離層）', () => {
  for (const f of ['lib/statement.js', 'lib/bank-statement.js', 'lib/taishin-securities.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.match(src, /await extractPdfLines\(/, `${f} 沒有走隔離層`);
  }
});

// ============================================================================
// 四、Codex #350 r1 點名的缺口（拿掉核心修法，舊考題 26 題全綠＝假綠）
// ============================================================================

const { readPageTextCapped, MAX_PDF_TEXT_ITEMS } = await import('../lib/parse-limits.js');

/** 假的 pdfjs 頁面：用可控的 chunk 序列餵 streamTextContent，並記錄有沒有被 cancel。
 * @param {number[]} chunkSizes 每個 chunk 幾個節點 */
function fakePage(chunkSizes) {
  /** @type {{cancelled: boolean, delivered: number, reason: any}} */
  const state = { cancelled: false, delivered: 0, reason: null };
  return {
    state,
    streamTextContent() {
      let i = 0;
      return {
        getReader() {
          return {
            async read() {
              if (i >= chunkSizes.length) return { done: true, value: undefined };
              const n = chunkSizes[i++];
              state.delivered += n;
              return { done: false, value: { items: Array.from({ length: n }, (_, k) => ({ str: `x${k}` })) } };
            },
            // ⚠️ **替身要照抄本尊會「拒絕」什麼**（2026-08-29 的教訓）：這裡原本寫
            //    `async cancel() { ... }`，不收參數、不驗理由——於是它收下了**真的 pdfjs 會拒絕**
            //    的呼叫，三題「邊收邊數」測的是一個不存在的世界，而 production 的取消一年來從沒生效。
            // ⚠️ 這裡刻意用 `throw` 而不是 `assert`：production 有 `.catch()`，
            //    在替身裡斷言會被吞掉、考題照樣綠。讓它**拒絕**，現成的 `state.cancelled` 斷言才會轉紅。
            async cancel(reason) {
              if (!(reason instanceof Error)) throw new Error('cancel must have a valid reason');
              state.cancelled = true; state.reason = reason;
            },
          };
        },
      };
    },
  };
}

test('邊收邊數｜多個 chunk 累加，正常讀完也要 cancel（不留 stream）', async () => {
  const page = fakePage([10, 20, 30]);
  const r = await readPageTextCapped(/** @type {any} */ (page), 0, '測試檔');
  assert.equal(r.count, 60, '三個 chunk 要累加');
  assert.equal(r.items.length, 60);
  // ⚠️ 誠實劃界：真 pdfjs 的串流讀完之後已經關閉，依 WHATWG 規範 cancel() 不會再問來源
  //    ＝那一次實質上是 no-op。本題（用替身）釘的是「收尾只有一條路」，不是「這次真的取消了什麼」。
  assert.equal(page.state.cancelled, true, '正常讀完也要走同一條收尾（不留兩條路）');
});

test('邊收邊數｜跨頁累計：soFar 帶進來的數量算在同一個上限裡', async () => {
  const page = fakePage([100]);
  const r = await readPageTextCapped(/** @type {any} */ (page), 5_000, '測試檔');
  assert.equal(r.count, 5_100, '要從 soFar 接著數，不是每頁各自從 0 開始');
});

test('邊收邊數｜超標當場 cancel、**不把超標那批收下**（這才是「邊收邊數」的本體）', async () => {
  const half = Math.ceil(MAX_PDF_TEXT_ITEMS / 2);
  // 第三個 chunk 會讓總數超過上限
  const page = fakePage([half, half, 100]);
  const err = await errOf(readPageTextCapped(/** @type {any} */ (page), 0, '測試檔'));
  assert.ok(err, '超標竟然沒 throw');
  assert.equal(err.code, 'pdf_too_many_text_items');
  assert.equal(err.status, 400);
  assert.equal(page.state.cancelled, true, '超標要當場 cancel 上游，不能繼續讓它產生節點');
  assert.ok(page.state.reason instanceof Error,
    'cancel 一定要帶一個 Error 當理由——真的 pdfjs 會 assert 它、不帶就當場拒絕，取消等於沒發生（2026-08-29 實測：整條路會卡死到逾時）');
  assert.equal(page.state.delivered, half * 2 + 100,
    '只該讀到觸發超標的那個 chunk 就停——再多讀就不是「邊收邊數」了');
  // ⚠️ Codex r3 Low：上一版邊界題是**假綠**——把 `items.push` 移到檢查前它照樣通過，
  //    因為它只看「剛好上限會回傳／多一個會 throw」，沒有觀察超標那批**有沒有被迭代收下**。
  //    改用 Proxy 讓「元素被讀取」變成可觀測：`for (const it of chunk) items.push(it)` 會逐個讀，
  //    所以超標批的 touched 必須是 0。
  const touched = { n: 0 };
  const spyChunk = (/** @type {number} */ size) => new Proxy(
    Array.from({ length: size }, (_, k) => ({ str: `y${k}` })),
    { get(t, k) { if (typeof k === 'string' && /^\d+$/.test(k)) touched.n += 1; return (/** @type {any} */ (t))[k]; } });
  const spyPage = {
    streamTextContent() {
      const chunks = [Array.from({ length: MAX_PDF_TEXT_ITEMS }, (_, k) => ({ str: `x${k}` })), spyChunk(5)];
      let i = 0;
      return { getReader: () => ({
        async read() { return i >= chunks.length ? { done: true, value: undefined } : { done: false, value: { items: chunks[i++] } }; },
        async cancel(/** @type {any} */ reason) {
          if (!(reason instanceof Error)) throw new Error('cancel must have a valid reason');
        },
      }) };
    },
  };
  const over = await errOf(readPageTextCapped(/** @type {any} */ (spyPage), 0, '測試檔'));
  assert.equal(over.code, 'pdf_too_many_text_items', '多一個 chunk 就要 throw');
  assert.equal(touched.n, 0,
    `超標那批被讀了 ${touched.n} 個元素——代表「先收下再檢查」，那就不是邊收邊數（記憶體照樣爆）`);
  // 邊界另一側：剛好等於上限要全部收下
  const okPage = fakePage([half, MAX_PDF_TEXT_ITEMS - half]);
  const okRes = await readPageTextCapped(/** @type {any} */ (okPage), 0, '測試檔');
  assert.equal(okRes.items.length, MAX_PDF_TEXT_ITEMS, '剛好等於上限要全部收下（邊界）');
});

test('邊收邊數｜**改回 getTextContent 就會紅**：本題直接打 readPageTextCapped，不經 PDF', async () => {
  // 這一題存在的理由（Codex #350 r1）：舊考題只驗「子行程最後會死」，分不出用哪種讀法，
  // 所以把 readPageTextCapped 改回 page.getTextContent() 仍然 26 題全綠。直測就擋得住。
  const page = fakePage([1, 1]);
  const r = await readPageTextCapped(/** @type {any} */ (page), 0, '測試檔');
  assert.equal(r.count, 2);
  assert.ok(typeof page.streamTextContent === 'function');
  assert.equal(page.state.cancelled, true);
});

test('邊收邊數｜取消**失敗**時：原本的 400 不可以被蓋掉，而且要出聲、不可印出帳單內容', async () => {
  // ⚠️ 這一題是 Codex #538 r1 抓到的缺口：`cancelStream` 的 catch 改成 rethrow，22 題照樣全綠。
  //    而 `finally` 正是最容易把原錯換掉的地方——真正到使用者眼前的會變成一個看不懂的錯，
  //    「你的帳單文字太多」那句就不見了。這是**保存型**考題：破壞保存機制（catch 改 rethrow）就轉紅。
  // ⚠️ 也順便釘住「出聲但不洩內容」：帳單內容含真實金額與帳號，日誌只能有錯誤訊息。
  // ⚠️ **哨兵用罕見字、比對用字元級**（Codex #538 r3 Medium）：上一版比對「連續 6 字」，
  //    把內容切成 5 字以下的片段再印就整批溜過去（帳號與金額切碎了一樣是洩漏）。
  //    改成：哨兵的每一個字都是診斷文字不可能出現的罕見字 ⇒ **任何一個字出現在日誌就算洩漏**，
  //    不管它被切成幾段。⚠️ **它只關掉「原文字元切片」這一種繞法**（Codex #538 r5 Low）：
  //    轉成 base64／hex／雜湊再印一樣看不到——那條界線寫在 `lib/parse-limits.js` 的 cancelStream，
  //    這裡不宣稱無限定的關門。
  const SECRET = '龘䶵鱻麤龗厵';
  const delivered = { n: 0 };
  const stubborn = {
    streamTextContent() {
      let i = 0;
      return { getReader: () => ({
        // ⚠️ 兩批：第一批**會被收進 `items`**（n 剛好等於上限），第二批才超標。
        //    這樣「日誌印出 chunk」與「日誌印出 items」兩種洩法都在本題射程內
        //   （只送一批的話 items 是空的，印 items 的洩法會從斷言底下溜過去——本題第一版就是這樣）。
        //    soFar 帶到上限−1，所以兩個節點就夠，不必造 30 萬筆。
        async read() {
          i += 1;
          if (i > 2) return { done: true, value: undefined };
          delivered.n += 1;
          return { done: false, value: { items: [{ str: SECRET }] } };
        },
        // 帶了正確理由**還是**拒絕（pdfjs 未來改行為、或串流已經壞掉都可能這樣）
        async cancel() { throw new Error('串流已經壞掉'); },
      }) };
    },
  };
  // ⚠️ **不可以先 `String()` 再檢查**（Codex #538 r2 抓到的假綠）：`console.error(msg, items)` 這種
  //    洩法會被 `String()` 壓成 `[object Object]`，機密就從斷言底下溜過去——他實測插入這一刀，
  //    舊寫法照樣全綠。所以這裡**留原始參數**，再遞迴把所有字串挖出來看。
  // ⚠️ **不是只攔 console.error**（自審 r3）：這一題宣告要守的是「**日誌**不可以有帳單內容」，
  //    而日誌不只一個出口。改用 console.warn／log 或 process.stderr.write 印出節點，
  //    只攔 error 的版本會照樣全綠——而且子行程的 stderr 會被父行程原樣記進日誌，
  //    那正是這題要防的路。所以整排都攔下來。
  /** @type {{via: string, args: any[]}[]} */
  const loggedArgs = [];
  /** @type {[any, string][]} */
  const patched = [];
  for (const name of /** @type {const} */ (['error', 'warn', 'log', 'info', 'debug'])) {
    patched.push([console[name], name]);
    console[name] = (/** @type {any[]} */ ...a) => { loggedArgs.push({ via: `console.${name}`, args: a }); };
  }
  const realStderr = process.stderr.write.bind(process.stderr);
  const realStdout = process.stdout.write.bind(process.stdout);
  process.stderr.write = (/** @type {any} */ ...a) => { loggedArgs.push({ via: 'stderr', args: a }); return true; };
  process.stdout.write = (/** @type {any} */ ...a) => { loggedArgs.push({ via: 'stdout', args: a }); return true; };
  let err;
  try {
    err = await errOf(readPageTextCapped(/** @type {any} */ (stubborn), MAX_PDF_TEXT_ITEMS - 1, '測試檔'));
  } finally {
    for (const [fn, name] of patched) console[name] = fn;
    process.stderr.write = realStderr;
    process.stdout.write = realStdout;
  }
  const logged = loggedArgs.map((e) => `${e.via}: ${deepStrings(e.args).join(' | ')}`);

  assert.equal(err?.code, 'pdf_too_many_text_items',
    `取消失敗把原本的錯換掉了（實際 ${err?.code}）——使用者會看到一個他無法處理的錯誤`);
  assert.equal(err?.status, 400, '仍然是使用者層錯誤');
  assert.ok(logged.some((m) => /取消 pdfjs 串流沒有正常完成/.test(m)),
    '取消失敗要出聲——靜靜失效會讓「牆擋下了」變成「卡死」，而那正是本支在修的病');
  // ⚠️ 劃界要準（本題第一版自己踩到）：**我們手上的東西**（抽到的文字節點）一律不進日誌——
  //    那是帳單內容，含真實金額與帳號。至於例外訊息本身是 pdfjs 產生的，印它是診斷所需；
  //    這一題守的是前者：有人日後改成 `console.error(..., chunk)` 或把 items 帶進訊息就轉紅。
  const { drainParseDiag, PARSE_DIAG } = await import('../lib/parse-limits.js');
  const codes = drainParseDiag();
  assert.ok(codes.includes(PARSE_DIAG.CANCEL_FAILED),
    `取消失敗沒有留下封閉診斷代碼（實際 ${JSON.stringify(codes)}）——HOSTED 的子行程 stderr 不會進`
    + '父行程日誌，這個代碼是它唯一的出聲管道（Codex #538 r3 High）');
  assert.ok(codes.includes(PARSE_DIAG.CAP_HIT), '超標本身也要留代碼（本題走的就是超標那條路）');
  assert.equal(delivered.n, 2,
    '前提沒成立：第一批必須先被收進 items（否則「印出 items」那種洩法根本不在本題射程內，'
    + '這一題會變成只驗「印出 chunk」——自審 r3 抓到的假前提）');
  const chars = [...SECRET];
  const leaked = logged.find((m) => chars.some((c) => m.includes(c)));
  assert.equal(leaked, undefined,
    `日誌出現了抽到的文字節點內容（${String(leaked).slice(0, 120)}）——帳單含真實金額與帳號，`
    + '一個字都不可以進日誌（切成片段、包進容器、只印預覽都算）');
});

/**
 * 把一個結構裡**看得到的字串**盡量挖出來（給「日誌不可以有帳單內容」那題用）。
 *
 * ⚠️ 為什麼不用 `String(x)`／`JSON.stringify`／`util.inspect`（Codex #538 r2＋自審 r3）：
 *    `String()` 把物件壓成 `[object Object]`＝洩漏溜過斷言；`JSON.stringify` 遇循環參照會丟錯；
 *    `util.inspect` 有 `maxArrayLength`／`maxStringLength` 截斷，**被截掉的部分正好是洩漏最可能藏身處**。
 * ⚠️ 自審 r3 補的三個容器（原本只走 `Object.values`，這三種都挖不到）：
 *    `Map`／`Set`（`Object.values(new Map(...))` 回空陣列）、`Buffer`／TypedArray
 *   （會被逐位元組拆成數字、字串永遠拼不回來）、`Symbol` 與非列舉的鍵（`{...err}` 看不到 `stack`／`cause`）。
 * ⚠️ **誠實劃界**：這仍然不是「任意結構」的完備解（getter 會被讀到、但 Proxy 陷阱、WeakMap
 *    這類容器仍看不到）。它守的是**實務上會發生的洩法**：把 chunk／items／Buffer／Error 丟進日誌。
 * @param {any} v @param {Set<any>=} seen @returns {string[]}
 */
function deepStrings(v, seen = new Set()) {
  if (typeof v === 'string') return [v];
  if (typeof v === 'symbol') return [v.description || ''];
  if (v === undefined || v === null) return [];
  if (typeof v !== 'object') return [String(v)];
  if (seen.has(v)) return [];
  seen.add(v);
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    return [Buffer.from(v instanceof ArrayBuffer ? v : v.buffer, 0).toString('utf8')];
  }
  if (v instanceof Map) return [...v.entries()].flatMap(([k, val]) => [...deepStrings(k, seen), ...deepStrings(val, seen)]);
  if (v instanceof Set) return [...v].flatMap((x) => deepStrings(x, seen));
  /** @type {string[]} */
  const out = [];
  if (v instanceof Error) out.push(String(v.message), String(v.stack || ''));
  // Reflect.ownKeys＝含 Symbol 鍵與非列舉屬性（Object.values 兩種都看不到）
  for (const k of Reflect.ownKeys(v)) {
    out.push(...deepStrings(k, seen));
    try { out.push(...deepStrings(/** @type {any} */ (v)[k], seen)); } catch { /* getter 丟錯就跳過 */ }
  }
  return out;
}

test('邊收邊數｜**取消要真的生效**：超標之後 pdfjs 的 task.destroy() 必須回得來（本案的本體）', async () => {
  // ⚠️ 這一題是 2026-08-29 那個 bug 的正對面，**用真的 pdfjs**（上面那幾題都是替身）。
  //    `reader.cancel()` 少帶理由時：pdfjs 拒絕 → 它不知道消費端走了 → 生產端永遠等一個
  //    不會排空的 sink → **`task.destroy()` 永不回來**（實測 40 秒仍未 resolve）。
  //    帶了理由：cancel ok → destroy 2ms 完成。
  //    端到端那題（炸彈題）證明不了這一點——未來有人把 destroy 拿掉，它照樣綠。
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bombPdf(310_000), verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const err = await errOf(readPageTextCapped(page, 0, '測試檔'));
  assert.equal(err?.code, 'pdf_too_many_text_items', `前提：這份檔要超標（實際 ${err?.code}）`);

  const raced = await Promise.race([
    task.destroy().then(() => 'ok', (/** @type {any} */ e) => `destroy 被拒：${e?.message}`),
    new Promise((r) => setTimeout(() => r('卡住'), 10_000)),
  ]);
  assert.equal(raced, 'ok',
    'task.destroy() 沒有在 10 秒內完成——代表取消沒有真的傳到 pdfjs，'
    + '上游還在跑（HOSTED 會被逾時當成「解析太久」、LOCAL 則是那次請求永遠不結束）');
});

test('LOCAL 零改動契約｜不是 HOSTED 就**直接呼叫原函式、不 spawn**（Codex #350 r1：這條契約原本零考題）', async () => {
  const { isHosted } = await import('../lib/hosted.js');
  // 本檔預設 HOSTED（第 28 行）才測得了隔離；LOCAL 契約要在同一支檔案驗，就暫時切回去。
  // isHosted() 是即時讀 env 的，所以切換立刻生效、不必重新 import。
  const saved = process.env.NOTEASY_HOSTED;
  delete process.env.NOTEASY_HOSTED;
  try {
    assert.equal(isHosted(), false, '前提：這一題要在 LOCAL 下跑');
    let called = 0;
    /** @type {any} */
    let gotData = null;
    const inProcess = async (/** @type {any} */ d, /** @type {any} */ p) => {
      called += 1; gotData = { d, p }; return [{ y: 1, cells: [] }];
    };
    const before = pdfQueueDepthForTest();
    const data = new Uint8Array([1, 2, 3]);
    const out = await extractPdfLines('statement', inProcess, data, 'pw');
    assert.equal(called, 1, 'LOCAL 必須直接呼叫傳進來的函式（不 spawn 子行程）');
    assert.equal(gotData.d, data, '原封不動把 data 傳給原函式');
    assert.equal(gotData.p, 'pw', '密碼也要原樣傳（LOCAL 不經行程邊界）');
    assert.deepEqual(out, [{ y: 1, cells: [] }], '結果要原樣回傳');
    assert.equal(pdfQueueDepthForTest(), before, 'LOCAL 不該碰到 HOSTED 的佇列（連 250ms 都不付）');
  } finally {
    if (saved === undefined) delete process.env.NOTEASY_HOSTED; else process.env.NOTEASY_HOSTED = saved;
  }
});

test('併發上限｜佇列深度滿了立刻 503（不讓等待者持續占住已收下的 body）', async () => {
  resetPdfQueueForTest();
  // ⚠️ 釋放要用「共用旗標」而不是收集 resolver：佇列是序列的，**只有第一個真的開始跑**，
  //    其餘還沒呼叫 fn。收集 resolver 只會拿到第一個，放掉後第二個又卡住＝整個測試掛死。
  let open = false;
  const slow = () => new Promise((res) => {
    const tick = setInterval(() => { if (open) { clearInterval(tick); res([]); } }, 5);
  });
  const runs = [];
  try {
    for (let i = 0; i < PDF_QUEUE_MAX_DEPTH; i++) runs.push(throughPdfQueueForTest(slow));
    assert.equal(pdfQueueDepthForTest(), PDF_QUEUE_MAX_DEPTH, '深度要算「排隊中＋執行中」');
    // ⚠️ 要驗「**立刻** 503」＝fail-fast。用 race 設 500ms 上限：深度上限一旦失效，
    //    第 7 個會安靜排隊等到天荒地老——那時候本題該**紅**，不該掛住（實測突變踩過）。
    const err = await errOf(Promise.race([
      throughPdfQueueForTest(slow),
      new Promise((_r, rej) => setTimeout(
        () => rej(Object.assign(new Error('沒有立刻回 503（深度上限失效，請求被安靜排隊）'), { code: 'no_fail_fast' })), 500)),
    ]));
    assert.ok(err, '滿了竟然還收');
    assert.equal(err.code, 'pdf_busy', String(err.message));
    assert.equal(err.status, 503);
  } finally {
    open = true;
    await Promise.allSettled(runs);
    resetPdfQueueForTest();
  }
});

test('併發上限｜同時只有一顆在跑（序列化＝上限 1，兩顆 256MB 會撐爆 512MB）', async () => {
  resetPdfQueueForTest();
  let running = 0, peak = 0;
  const work = () => new Promise((res) => {
    running += 1; peak = Math.max(peak, running);
    setTimeout(() => { running -= 1; res([]); }, 30);
  });
  await Promise.all([throughPdfQueueForTest(work), throughPdfQueueForTest(work), throughPdfQueueForTest(work)]);
  assert.equal(peak, 1, `同時跑了 ${peak} 顆——行程隔離只防得住一顆，兩顆就撐爆容器`);
  resetPdfQueueForTest();
});

test('併發上限｜**production 的 extractPdfLines 真的走佇列**（繞過去就白搭——Codex r2 Low）', async () => {
  // 前兩題只驗 helper；若有人把 extractPdfLines 改成直接呼叫 runInChild，那兩題照樣綠。
  // 這題從 production 入口進去，證明深度真的被算到。
  const saved = process.env.NOTEASY_HOSTED;
  process.env.NOTEASY_HOSTED = '1';
  resetPdfQueueForTest();
  try {
    let seenDepth = 0;
    let release = () => {};
    const blocked = new Promise((res) => { release = () => res([]); });
    // 用一個永遠不會被呼叫的 inProcess：HOSTED 走子行程，我們只看深度有沒有被算到
    const p = extractPdfLines('statement', async () => [], new Uint8Array([1, 2, 3]), undefined);
    seenDepth = pdfQueueDepthForTest();
    assert.equal(seenDepth, 1, 'production 入口沒有把請求算進佇列深度＝有人繞過了佇列');
    release();
    await Promise.allSettled([p, blocked]);
  } finally {
    if (saved === undefined) delete process.env.NOTEASY_HOSTED; else process.env.NOTEASY_HOSTED = saved;
    resetPdfQueueForTest();
  }
});

test('錯誤契約｜子行程「沒帶 status 的例外」＝我們的問題（500、對外不洩內情、detail 進日誌）', async () => {
  // Codex r3 Low：這個契約原本零考題——把 child 的預設值改回 400，17 題照樣全綠。
  // ⚠️ 要餵**真正沒帶 status 的例外**才測得到預設值：協定缺換行那條自己帶了 status 500，
  //    改預設值它不會變（第一版就踩到）。用「有換行但標頭不是合法 JSON」→ SyntaxError。
  const { spawn } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const CHILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib/pdf-isolate-child.js');
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [CHILD, 'statement'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (b) => { o += b; });
    c.on('close', () => resolve(o));
    c.stdin.end('這不是合法JSON\nQUJD');   // 有換行、但標頭 JSON.parse 會丟 SyntaxError（無 status）
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 500, '沒帶 status 的內部例外預設必須是 500——400 會說成「使用者的檔案有問題」');
  assert.match(String(parsed.message), /伺服器暫時無法解析/, '對外只給通用訊息，不洩內情');
  assert.ok(!/JSON|SyntaxError|token/i.test(String(parsed.message)), '內部細節不可出現在對外訊息');
  assert.ok(String(parsed.detail || '').length > 0, 'detail 要留真正原因（只進伺服器日誌）');
});
