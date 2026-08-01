// @ts-check
// PDF 行程隔離（HOSTED 專用，2026-07-29）：**一份小檔不可以把共用主機打掛**。
//
// 病根（自審抓到的兩個 blocking，都已重現）：
//     138 KB 的**一頁** PDF（約 200 萬個文字節點）→ 行程死掉，峰值 612MB
//     207 KB 的**一頁** PDF（內容串流解壓後 83MB）→ 行程死掉，峰值 704MB
// 兩份都**結構完全合法**，既有的兩道牆（頁數、文字節點）都看到「正常」。
//
// ⚠️ **死法不只 OOM（2026-08-02 追出）**：更常見的是 pdfjs 卡死在解壓、promise 永不 settle
//    ——子行程 1.4 秒 `code 0` 靜默退出、stdout/stderr 全空。舊敘述把兩種都寫成 OOM，
//    害父行程把「沒有 stdout」當成「使用者的檔案太貴」。本檔的炸彈題現在驗的是 `pdf_timeout`。
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
import { test } from 'node:test';
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
  resetPdfQueueForTest, pdfQueueDepthForTest, extractPdfLines, throughPdfQueueForTest } = await import('../lib/pdf-isolate.js');

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

// ============================================================================
// 一、攻擊：子行程死掉，**父行程必須活著**
// ============================================================================

test('內容串流炸彈：一頁的小 PDF 讓子行程卡住 → 父行程逾時收回 400，而不是整個服務死掉', async () => {
  // ⚠️ **這題的真相曾經被誤解**（2026-08-01 追出來）：炸彈**不是**讓子行程 OOM，而是讓
  //    pdfjs 卡在解壓——那個 promise 永不 settle。舊版子行程的事件迴圈一空就 code 0 靜默結束、
  //    什麼都不寫，父行程只看到「沒有 stdout」，於是把它當成「資源耗盡」。**綠燈是為了錯的理由**。
  //    現在：子行程 keep-alive 不准安靜退出 → 父行程逾時 SIGKILL → 誠實的 pdf_timeout。
  setPdfTimeoutForTest(3_000);
  try {
    const data = bombPdf(3_000_000);
    assert.ok(data.length < 300 * 1024,
      `攻擊檔要小得可笑才有說服力（實際 ${Math.round(data.length / 1024)}KB）——這就是「檔案大小預測不了成本」`);
    const t0 = Date.now();
    const err = await errOf(parseStatement(data));
    assert.ok(err, '攻擊檔竟然通過了');
    assert.equal(err.code, 'pdf_timeout', '要誠實說是「卡太久」，不可假裝知道是資源耗盡');
    assert.equal(err.status, 400, '這是使用者層錯誤（他的檔案太貴），不是 500');
    assert.match(String(err.message), /太久|上限|正常的對帳單/, '訊息要讓使用者知道該做什麼');
    assert.ok(Date.now() - t0 >= 2_500, '必須是「等到逾時」才收回，不是子行程安靜死掉就當成攻擊');
  } finally { setPdfTimeoutForTest(null); }
});

test('連打五次攻擊檔，父行程的記憶體不可以往上爬（沒有洩漏、也沒有累積）', async () => {
  setPdfTimeoutForTest(1_500);
  const data = bombPdf(2_000_000);
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 5; i++) {
    const err = await errOf(parseStatement(data));
    assert.equal(err?.code, 'pdf_timeout', `第 ${i + 1} 次沒被擋下`);
  }
  setPdfTimeoutForTest(null);
  const grew = (process.memoryUsage().rss - before) / 1048576;
  // 這一題守的是「隔離有沒有真的把成本擋在子行程裡」——父行程幾乎不該長。
  assert.ok(grew < 60, `父行程在五次攻擊後長了 ${grew.toFixed(0)}MB——成本沒有被擋在子行程裡`);
});

test('三個抽取器都走同一層隔離（不是只修了信用卡那條）', async () => {
  setPdfTimeoutForTest(1_500);
  try {
    const data = bombPdf(3_000_000);
    const err = await errOf(parseBankStatement(data));
    assert.equal(err?.code, 'pdf_timeout', '銀行對帳單那條沒接上隔離');
  } finally { setPdfTimeoutForTest(null); }
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
  const state = { cancelled: false, delivered: 0 };
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
            async cancel() { state.cancelled = true; },
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
  assert.equal(page.state.cancelled, true, '正常讀完也要 cancel，否則 pdfjs 那邊的 stream 留著');
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
        async cancel() {},
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
