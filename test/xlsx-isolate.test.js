// XLSX 走行程隔離的考題（2026-08-02；取代 #342 那道 266 行的手寫 ZIP 掃描牆）。
//
// ## 為什麼換掉那道牆
//
// #342 的路是「自己先掃一遍 ZIP 判斷這份貴不貴」，**被打穿四次**——每一次都是同一類病：
// 牆與 SheetJS 對格式的理解差了一點（枚舉方式、欄位偏移、信不信宣告值）。最後一次差在
// 「牆讀 EOCD +10、SheetJS 讀 +8」＝兩個位元組。而且它讀第三方原始碼的特性，讓審查
// **連續三次被內容過濾器整份切斷**（白燒約 50 萬 tokens）。
//
// **隔離不需要看懂格式**：把解析關進子行程，怎麼死都不影響父行程。這是 #350 已審過四輪的機制，
// 這裡只是多接一種 kind。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'k';
process.env.SITE_ORIGIN = 'http://127.0.0.1';
process.env.NOTEASY_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const { PDF_ISOLATE_KINDS, extractXlsxIsolated, setPdfTimeoutForTest, resetPdfQueueForTest }
  = await import('../lib/pdf-isolate.js');
const { readXlsxForIsolation, parseStatement } = await import('../lib/statement.js');

/** @param {Promise<any>} p */
const errOf = (p) => p.then(() => null, (/** @type {any} */ e) => e);

/** 最小的合法 .xlsx（一張表、幾列資料）——用真的 ZIP 結構，不是假的位元組。 */
function makeXlsx(rows) {
  const files = new Map();
  files.set('[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  files.set('_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files.set('xl/workbook.xml',
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  files.set('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const cells = rows.map((r, ri) => '<row r="' + (ri + 1) + '">'
    + r.map((v, ci) => `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')
    + '</row>').join('');
  files.set('xl/worksheets/sheet1.xml',
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${cells}</sheetData></worksheet>`);
  return zipOf(files);
}

/** 用 stored（不壓縮）打包成合法 ZIP。 @param {Map<string,string>} files */
function zipOf(files, { compressEntry = null } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (/** @type {Buffer} */ buf) => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const useDeflate = compressEntry === name;
    const body = useDeflate ? deflateSync(raw, { level: 9 }).subarray(2, -4) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    parts.push(lh, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc32(raw), 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.size, 8); eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, eocd]));
}

test('種類清單｜xlsx 已納入隔離（漏掉＝那條路悄悄不隔離）', () => {
  assert.ok(PDF_ISOLATE_KINDS.includes('xlsx'), 'xlsx 不在 PDF_ISOLATE_KINDS');
});

test('正確性｜正常 XLSX 穿過行程邊界之後**逐項相同**（不是「兩邊都失敗」就算過）', async () => {
  const data = makeXlsx([['2026/01/05', '2026/01/07', '測試商店', 'TWD', '1234'],
    ['2026/01/06', '2026/01/08', '另一家店', 'TWD', '5678']]);
  const direct = readXlsxForIsolation(data);            // 行程內
  const isolated = await extractXlsxIsolated(readXlsxForIsolation, data);   // 穿過子行程
  assert.ok(direct.rows.length >= 2, '前提：行程內版本要真的讀到列（否則本題等於沒測）');
  assert.deepEqual(isolated.rows, direct.rows, '列資料穿過行程邊界後不一致');
  assert.equal(isolated.allText, direct.allText, '全表文字穿過行程邊界後不一致');
});

/**
 * 攻擊檔的內容（3,000 格 × 每格 13 萬字 ≒ 解壓後 390MB，壓縮後只有幾百 KB）。
 * 這個函式會被 `.toString()` 丟到**另一個行程**執行——所以它不可以引用外部變數。
 */
function bombFiles() {
  const files = new Map();
  files.set('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  files.set('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files.set('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  files.set('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const cells = '<row r="1">' + Array.from({ length: 3000 },
    (_, i) => '<c r="A' + i + '" t="inlineStr"><is><t>' + 'X'.repeat(130000) + '</t></is></c>').join('') + '</row>';
  files.set('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + cells + '</sheetData></worksheet>');
  return files;
}

/**
 * 在**另一個行程**產生攻擊檔（Codex #373 r1 Medium：原本這道題是假綠）。
 *
 * 原本的寫法在測試行程裡就地組出那條 390MB 的 XML，才記 `rssBefore`——基準線裡
 * 早就含了攻擊內容，等它被回收，「增量」還會是負數，`< 120MB` 幾乎必過：**這題
 * 量的是垃圾回收，不是隔離**。改成子行程產生後，父行程從頭到尾只碰得到幾百 KB
 * 的成品，量出來的增量才真的是「解析這份檔案讓父行程付出的代價」。
 *
 * 用 `.toString()` 把 `zipOf`／`bombFiles` 送過去，是為了讓兩邊**只有一份實作**——
 * 子行程若跟本檔的打包方式漂開，攻擊檔就不再是這裡描述的那一份。
 */
function makeBombInChildProcess() {
  const src = [
    "const { deflateSync } = require('node:zlib');",
    zipOf.toString(),
    bombFiles.toString(),
    "process.stdout.write(Buffer.from(zipOf(bombFiles(), { compressEntry: 'xl/worksheets/sheet1.xml' })));",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=commonjs', '--max-old-space-size=2048', '-e', src],
    { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0,
    `產生攻擊檔的子行程失敗（status=${r.status} signal=${r.signal}）：${String(r.stderr).slice(0, 300)}`);
  return new Uint8Array(r.stdout);
}

/**
 * 對照組：在子行程裡走**沒有隔離**的路（直接呼叫 `readXlsxForIsolation`），回報它自己的 RSS 增量。
 * 沒有這組，「父行程只長了 N MB」就只是一個孤零零的數字——說不定這份檔案本來就不貴。
 * 回傳 `{ grewMB }`；若那個行程直接被記憶體壓死，回 `{ died: true }`（那同樣證明代價是真的）。
 */
function measureWithoutIsolation(/** @type {Uint8Array} */ data) {
  const src = `
    const b64 = process.argv[1];
    const data = new Uint8Array(Buffer.from(b64, 'base64'));
    import('${new URL('../lib/statement.js', import.meta.url).href}').then((m) => {
      const before = process.memoryUsage().rss;
      m.readXlsxForIsolation(data);
      process.stdout.write(JSON.stringify({ grewMB: (process.memoryUsage().rss - before) / 1048576 }));
    }).catch((e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message).slice(0, 120) })); });
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '--max-old-space-size=3072', '-e', src,
    Buffer.from(data).toString('base64')], { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  if (r.status !== 0 || !r.stdout?.length) return { died: true };
  try { return JSON.parse(String(r.stdout)); } catch { return { died: true }; }
}

test('攻擊｜解壓後極大的合法 XLSX → 子行程被收掉、父行程活著（400、不是整個服務死掉）', async () => {
  setPdfTimeoutForTest(8_000);
  resetPdfQueueForTest();
  try {
    // 一份**結構完全合法**的 .xlsx：解壓後約 390MB，壓縮後只有幾百 KB。
    // 這正是「檔案大小預測不了成本」：兩道既有的牆（body 15MB、頁數）都看到「正常」。
    // #342 的牆要靠掃 ZIP 宣告值才擋得住這種；隔離則完全不必看懂格式。
    const data = makeBombInChildProcess();
    assert.ok(data.length < 2 * 1024 * 1024,
      `攻擊檔要遠小於解壓後的量才有說服力（實際 ${Math.round(data.length / 1024)}KB）`);

    // 對照組先跑：確認這份檔案在**沒有隔離**時真的很貴，下面那個「父行程只長一點點」才有意義。
    const control = measureWithoutIsolation(data);
    assert.ok(control.died || control.grewMB > 150,
      `對照組（不隔離）只長了 ${Number(control.grewMB).toFixed(0)}MB——這份攻擊檔根本不貴，`
      + '本題等於沒測。請把格數／每格字數調大，或確認 xlsx 版本是否改了解析策略。');

    const rssBefore = process.memoryUsage().rss;
    const err = await errOf(parseStatement(data));
    const grew = (process.memoryUsage().rss - rssBefore) / 1048576;

    assert.ok(err, '攻擊檔竟然整份解析成功了');
    assert.equal(err.status, 400,
      `這是使用者層錯誤（他的檔案太貴），不是 500。實得 status=${err.status} code=${err.code} msg=${String(err.message).slice(0, 80)}`);
    assert.ok(grew < 80,
      `父行程長了 ${grew.toFixed(0)}MB，對照組（不隔離）是 ${control.died ? '直接被壓死' : Number(control.grewMB).toFixed(0) + 'MB'}`
      + '——成本沒有被擋在子行程裡。');
  } finally { setPdfTimeoutForTest(null); resetPdfQueueForTest(); }
});

test('LOCAL 零改動｜不是 HOSTED 就直接在行程內讀（連 spawn 的 250ms 都不付）', async () => {
  const saved = process.env.NOTEASY_HOSTED;
  delete process.env.NOTEASY_HOSTED;
  try {
    let called = 0;
    const spy = (/** @type {Uint8Array} */ d) => { called += 1; return readXlsxForIsolation(d); };
    const data = makeXlsx([['2026/01/05', '2026/01/07', '店', 'TWD', '100']]);
    const out = await extractXlsxIsolated(spy, data);
    assert.equal(called, 1, 'LOCAL 必須直接呼叫傳進來的函式');
    assert.ok(out.rows.length >= 1, '結果要原樣回傳');
  } finally {
    if (saved === undefined) delete process.env.NOTEASY_HOSTED; else process.env.NOTEASY_HOSTED = saved;
  }
});

/**
 * 正式程式碼的檔案清單（給架構考題掃）。
 *
 * ⚠️ **一律走 `git ls-files`，不可自己走訪檔案樹**（2026-08-02 實測踩到）：
 *    原本自己 `readdirSync` 遞迴，結果在老師的機器上把 `.claude/worktrees/<副本>/lib/statement.js`
 *    ——兩份 repo 副本——也掃了進來，考題**假紅**。CI 是乾淨 checkout 所以全綠，
 *    只有真正在用的那台會紅：**最糟的一種紅**（擋住 push，而且看起來像程式壞了）。
 *    `--others` 是刻意的：違規的**新檔在 `git add` 之前**就要被抓到，否則護欄會在最需要它的那一刻失效。
 *    同一寫法見 `test/hosted-store-pg.test.js` 的 `libFiles`。
 * @returns {string[]}
 */
async function productionFiles() {
  const { execFileSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const listed = execFileSync('git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'lib', 'server.js'],
    { encoding: 'utf8', cwd: root }).trim();
  return (listed ? listed.split('\n') : []).filter((f) => /\.(js|mjs|cjs)$/.test(f) && !f.endsWith('.test.js'));
}

/**
 * xlsx 收斂點護欄的**真正執法者是 ESLint**（`eslint.config.js` 的 `no-restricted-imports`
 * ＋ `no-restricted-syntax`），不是這裡。
 *
 * ⚠️ **為什麼不自己掃字串**（Codex #374 r1 High）：註解在 JS 語法上等同空白，
 *    「import XLSX from ⟨註解⟩ 'xlsx'」、「import 'xlsx'」、「await import ⟨註解⟩ ('xlsx')」
 *   （⟨註解⟩＝真正的區塊註解，這裡不寫出結束符是因為它會把這段註解本身關掉）
 *    全是合法寫法。我先前手寫的 regex 七種寫法**漏掉五種**——用正規表示式解析一門語言，
 *    補到死也補不完。parser 看的是語法樹，這些寫法對它是同一件事。
 *
 * 那這裡還做什麼？**盯著執法者還在不在**：有人把 eslint.config.js 那幾條規則刪掉、
 * 或把 `lib/statement.js` 以外的檔案加進 ignores，lint 就會安靜地全綠。下面兩題守這個。
 */
async function eslintFindingsByFile(dir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const run = promisify(execFile);
  // ⚠️ **一次跑完所有樣本**：本來一個樣本 spawn 一次 eslint，15 個要 11 秒；
  //    eslint 啟動成本佔了幾乎全部。一次掃一個目錄再依檔名分組，同樣的涵蓋、不到 1 秒。
  const stdout = await run('npx', ['eslint', '--format', 'json', dir], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    .then((r) => r.stdout, (e) => String(e?.stdout || '[]'));   // eslint 有錯時 exit code 非 0
  const out = new Map();
  for (const r of JSON.parse(stdout)) {
    out.set(r.filePath, (r.messages || []).filter((m) => String(m.ruleId || '').startsWith('no-restricted-')));
  }
  return out;
}

test('架構｜xlsx 收斂點護欄必須還掛在 eslint.config.js 上（規則被拿掉＝lint 從此安靜全綠）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cfg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'eslint.config.js'), 'utf8');
  for (const needle of [
    "'no-restricted-imports'",
    "'no-restricted-syntax'",
    'patterns:',
    "ImportExpression[source.value=/^xlsx(\\\\/|$)/]",
    "CallExpression[callee.name='require'][arguments.0.value=/^xlsx(\\\\/|$)/]",
    "ImportExpression:not([source.type='Literal'])",
    "CallExpression[callee.name='createRequire']",
  ]) {
    assert.ok(cfg.includes(needle),
      `eslint.config.js 少了 ${needle}——xlsx 收斂點護欄被拆掉了，別的檔案可以直接引入 xlsx 而不經子行程隔離。`);
  }
  assert.ok(/ignores:\s*\['lib\/statement\.js',\s*'test\/\*\*'\]/.test(cfg),
    'xlsx 護欄的 ignores 清單被改動了——允許名單只能有 lib/statement.js（test/** 是考題自己要合成 XLSX）。');
});

test('架構｜二十六種合法的引入寫法都要被 lint 擋下（列舉了三次都漏，最後改成整個模組禁掉）', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const probeDir = join(root, 'lib', '_xlsx_guard_probes');
  const long = 'x'.repeat(90);
  const FORMS = [
    ["靜態", "import XLSX from 'xlsx';\nconsole.log(XLSX);\n"],
    ["靜態＋註解", "import XLSX from /* c */ 'xlsx';\nconsole.log(XLSX);\n"],
    ["純副作用", "import 'xlsx';\n"],
    ["改名", "import * as Y from 'xlsx';\nconsole.log(Y);\n"],
    ["export-from", "export { read } from 'xlsx';\n"],
    ["export *", "export * from 'xlsx';\n"],
    ["子路徑（SheetJS 自己也這樣發佈）", "import X from 'xlsx/xlsx.mjs';\nconsole.log(X);\n"],
    ["子路徑＋純副作用", "import 'xlsx/dist/xlsx.full.min.js';\n"],
    ["動態", "const X = await import('xlsx');\nconsole.log(X);\n"],
    ["動態＋註解在括號內", "const X = await import(/* c */ 'xlsx');\nconsole.log(X);\n"],
    ["動態＋註解在括號外", "const X = await import /* c */ ('xlsx');\nconsole.log(X);\n"],
    ["動態＋超長註解", `const X = await import(/* ${long} */ 'xlsx');\nconsole.log(X);\n`],
    ["動態＋子路徑", "const X = await import('xlsx/xlsx.mjs');\nconsole.log(X);\n"],
    ["動態＋非字面量（靜態判不出模組名，所以連非字面量本身都禁）",
      "const s = 'xlsx';\nconst X = await import(s);\nconsole.log(X);\n"],
    ["createRequire 直呼", "import { createRequire } from 'node:module';\n"
      + "const r = createRequire(import.meta.url);\nconst X = r /* c */ ('xlsx');\nconsole.log(X);\n"],
    // ── Codex #374 r2 抓到的六種：改用 AST 選擇器之後我又在打同一種地鼠 ──
    ["createRequire 引入時取別名", "import { createRequire as cr } from 'node:module';\n"
      + "const req = cr(import.meta.url);\nconst X = req('xlsx');\nconsole.log(X);\n"],
    ["namespace 引入 node:module", "import * as mod from 'node:module';\n"
      + "const req = mod.createRequire(import.meta.url);\nconst X = req('xlsx');\nconsole.log(X);\n"],
    ["先存進變數再呼叫", "import { createRequire } from 'node:module';\n"
      + "const makeRequire = createRequire;\nconst req = makeRequire(import.meta.url);\n"
      + "const X = req('xlsx');\nconsole.log(X);\n"],
    ["動態引入 node:module", "const mod = await import('node:module');\n"
      + "const req = mod.createRequire(import.meta.url);\nconst X = req('xlsx');\nconsole.log(X);\n"],
    ["module.require", "const X = globalThis.module.require('xlsx');\nconsole.log(X);\n"],
    ["process.getBuiltinModule", "const m = process.getBuiltinModule('module');\n"
      + "const X = m.createRequire(import.meta.url)('xlsx');\nconsole.log(X);\n"],
    // ── Codex #374 r3 抓到的第七類：只禁 createRequire 這個「名字」，門其實還開著 ──
    ["default 引入 node:module", "import mod from 'node:module';\n"
      + "const req = mod.createRequire(import.meta.url);\nconst X = req('xlsx');\nconsole.log(X);\n"],
    ["default 引入 module", "import mod from 'module';\n"
      + "const req = mod.createRequire(import.meta.url);\nconst X = req('xlsx');\nconsole.log(X);\n"],
    ["具名引入 Module 類別", "import { Module } from 'node:module';\n"
      + "const X = Module.createRequire(import.meta.url)('xlsx');\nconsole.log(X);\n"],
    ["具名引入 Module 再取別名", "import { Module as M } from 'node:module';\n"
      + "const X = M.createRequire(import.meta.url)('xlsx');\nconsole.log(X);\n"],
    ["default specifier 寫法", "import { default as mod } from 'node:module';\n"
      + "const X = mod.createRequire(import.meta.url)('xlsx');\nconsole.log(X);\n"],
  ];
  try {
    mkdirSync(probeDir, { recursive: true });
    const paths = FORMS.map(([name, src], i) => {
      const f = join(probeDir, `p${i}.js`);
      writeFileSync(f, src);
      return [name, f, src];
    });
    const byFile = await eslintFindingsByFile(probeDir);
    for (const [name, f, src] of paths) {
      const hits = byFile.get(f) || [];
      assert.ok(hits.length > 0,
        `「${name}」這種寫法沒有被擋下——它是合法 JS，會讓 xlsx 繞過子行程隔離。\n原始碼：\n${src}`);
    }
  } finally { rmSync(probeDir, { recursive: true, force: true }); }
});

test('架構｜production 不可以有 .cjs（CJS 的 require 別名在語法上堵不住）', async () => {
  const files = await productionFiles();
  const cjs = files.filter((f) => f.endsWith('.cjs'));
  assert.deepEqual(cjs, [],
    `production 出現 .cjs：${cjs.join('、')}\n`
    + '本專案是純 ESM。CJS 裡 `const r = require; r("xlsx")` 這種寫法**語法規則堵不住**'
    + '（require 被當成值傳來傳去，AST 上看不出來），所以 xlsx 收斂點護欄在 .cjs 檔裡是破的。\n'
    + '真的需要 CJS 時：先想清楚那個檔會不會碰到 xlsx，並在這裡開例外寫明理由。');
});

test('護欄本身｜檔案清單不可把 worktree 副本算進去（本題**自己造誘餌**，才不會只在某些機器上有效）', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  // ⚠️ **誘餌是這題的重點**：假紅是在「repo 底下有 worktree 副本」的機器上發生的，
  //    CI 是乾淨 checkout 所以本來就不會踩到。若只斷言「現在沒掃到副本」，
  //    那有人把作法改回 readdirSync 時 CI 照樣全綠——**這題就只在出事的那台有效**，
  //    等於沒有防線。所以這裡自己造一份副本結構出來，逼它現形（實測：改回走訪就會紅）。
  const decoyDir = join(root, '.claude', 'worktrees', '_guard_probe', 'lib');
  try {
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(join(decoyDir, 'statement.js'),
      '// 這是考題造的誘餌：repo 副本，不該被正式程式碼的掃描清單撿走\n');
    const files = await productionFiles();
    const strays = files.filter((f) => /(^|\/)(node_modules|\.claude|\.git)\//.test(f) || f.startsWith('..'));
    assert.deepEqual(strays, [],
      `掃到了不該掃的路徑：${strays.join('、')}\n`
      + '自己走訪檔案樹就會掃到 repo 副本（.claude/worktrees 底下那些），造成只有本機會紅的假紅。'
      + '請用 git ls-files --cached --others --exclude-standard <production 路徑>。');
    assert.ok(files.includes('lib/statement.js'), '清單裡連收斂點本身都沒有——pathspec 錯了，護欄等於沒掃');
    assert.ok(files.length > 20, `只掃到 ${files.length} 個檔，正式程式碼不可能這麼少——pathspec 可能錯了`);
  } finally {
    rmSync(join(root, '.claude', 'worktrees', '_guard_probe'), { recursive: true, force: true });
  }
});

test('架構｜收斂模組內只能有一個 XLSX.read（第二個就是繞過隔離的入口）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib/statement.js'), 'utf8');
  // 同樣不剝註解：註解裡寫 `XLSX.read(` 會誤報（吵，但安全），漏掉才是災難。
  const hits = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /XLSX\.read\s*\(/.test(String(l)));
  assert.equal(hits.length, 1,
    `XLSX.read 出現 ${hits.length} 次——只能有一個收斂點（readXlsxForIsolation）：\n`
    + hits.map(([n, l]) => `  statement.js:${n}: ${String(l).trim()}`).join('\n'));
});

// ── 錯誤歸因：5xx 不可以被洗成「你的檔案有問題」（Codex #373 r1 Medium）──

const { rethrowParseError } = await import('../lib/services/statement-import.js');

/** @param {() => any} fn */
const throwsWith = (fn) => { try { fn(); return null; } catch (e) { return /** @type {any} */ (e); } };

test('錯誤歸因｜子行程的 500 原樣往上（含 code/cause），不得降成 400', () => {
  const internal = Object.assign(new Error('伺服器暫時無法解析Excel檔，請稍後再試'),
    { status: 500, code: 'pdf_child_internal_error', cause: new Error('spawn ENOENT') });
  const out = throwsWith(() => rethrowParseError(internal));
  assert.equal(out.status, 500, '500 被降成 400＝把「我們壞了」說成「你的檔案有問題」');
  assert.equal(out.code, 'pdf_child_internal_error', 'code 掉了＝日誌與監控看不出真因');
  assert.ok(out.cause, 'cause 掉了＝追不到原始堆疊');
});

test('錯誤歸因｜back-pressure 的 503 原樣往上（使用者要看到「請稍後再試」）', () => {
  const busy = Object.assign(new Error('目前有多份檔案正在解析中，請稍後再試。'),
    { status: 503, code: 'pdf_busy' });
  const out = throwsWith(() => rethrowParseError(busy));
  assert.equal(out.status, 503, '503 被降成 400＝叫使用者去改他的檔案，其實只是要他等一下');
  assert.equal(out.code, 'pdf_busy');
});

test('錯誤歸因｜使用者層錯誤仍是 400，且訊息原味（密碼錯不可變成「伺服器錯誤」）', () => {
  const pw = Object.assign(new Error('PDF 密碼錯誤'), { status: 400 });
  assert.equal(throwsWith(() => rethrowParseError(pw)).status, 400);
  assert.equal(throwsWith(() => rethrowParseError(pw)).message, 'PDF 密碼錯誤');
  const bare = new Error('這份 XLSX 找不到消費明細');            // 沒帶 status 的解析器錯誤
  assert.equal(throwsWith(() => rethrowParseError(bare)).status, 400, '解析器的一般錯誤預設仍是 400');
  assert.equal(throwsWith(() => rethrowParseError(bare)).message, '這份 XLSX 找不到消費明細');
});

test('架構｜兩個預覽入口都不可以繞過 rethrowParseError 自己包 400', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
    'lib/services/statement-import.js'), 'utf8');
  // 解析失敗那兩處若又寫回 `apiError(400, …)`，5xx 就再一次被洗掉——這題盯著它。
  const bypass = src.split('\n').map((l, i) => [i + 1, l])
    .filter(([, l]) => /apiError\(\s*400\s*,[^)]*解析失敗/.test(String(l)));
  assert.equal(bypass.length, 0,
    `有人繞過 rethrowParseError 直接包 400：\n${bypass.map(([n, l]) => `  statement-import.js:${n}: ${String(l).trim()}`).join('\n')}`);
});

test('回歸｜損毀的 .xlsx 仍是 400 使用者層錯誤（隔離不可以把它變成「伺服器壞了」）', async () => {
  // PK 開頭（會被判成 xlsx 走隔離），但後面是垃圾＝讀不開。
  const junk = new Uint8Array(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 0x41)]));
  const err = await errOf(parseStatement(junk));
  assert.ok(err, '垃圾檔竟然解析成功');
  assert.equal(err.status, 400,
    `損毀檔是使用者層錯誤（叫他重載），不是 500（叫他等一下再試，其實試一百次都一樣）。`
    + `實得 status=${err.status} code=${err.code} msg=${String(err.message).slice(0, 80)}`);
  assert.match(String(err.message), /Excel|xlsx|明細/,
    `訊息要講得出「這是 Excel 檔的問題」，實得：${String(err.message).slice(0, 120)}`);
});
