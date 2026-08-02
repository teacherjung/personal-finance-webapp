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

test('攻擊｜解壓後極大的合法 XLSX → 子行程被收掉、父行程活著（400、不是整個服務死掉）', async () => {
  setPdfTimeoutForTest(4_000);
  resetPdfQueueForTest();
  try {
    // 一份**結構完全合法**的 .xlsx：worksheet 解壓後約 80MB，壓縮後只有幾十 KB。
    // #342 的牆要靠掃 ZIP 宣告值才擋得住這種；隔離則完全不必看懂格式。
    // 解壓後約 400MB（3,000 格 × 每格 13 萬字）——壓縮率極高，檔案本身只有幾百 KB。
    // 這正是「檔案大小預測不了成本」：兩道既有的牆（body 15MB、頁數）都看到「正常」。
    const bigCells = '<row r="1">' + Array.from({ length: 3_000 },
      (_, i) => `<c r="A${i}" t="inlineStr"><is><t>${'X'.repeat(130_000)}</t></is></c>`).join('') + '</row>';
    const files = new Map();
    files.set('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    files.set('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    files.set('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
    files.set('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    files.set('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + bigCells + '</sheetData></worksheet>');
    const data = zipOf(files, { compressEntry: 'xl/worksheets/sheet1.xml' });
    assert.ok(data.length < 2 * 1024 * 1024,
      `攻擊檔要遠小於解壓後的量才有說服力（實際 ${Math.round(data.length / 1024)}KB）`);

    const rssBefore = process.memoryUsage().rss;
    const err = await errOf(parseStatement(data));
    const grew = (process.memoryUsage().rss - rssBefore) / 1048576;

    assert.ok(err, '攻擊檔竟然整份解析成功了');
    assert.equal(err.status, 400,
      `這是使用者層錯誤（他的檔案太貴），不是 500。實得 status=${err.status} code=${err.code} msg=${String(err.message).slice(0, 80)}`);
    assert.ok(grew < 120, `父行程長了 ${grew.toFixed(0)}MB——成本沒有被擋在子行程裡`);
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

test('架構｜statement.js 不可再出現第二個 XLSX.read（繞過隔離層就白做）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib/statement.js'), 'utf8');
  const hits = src.split('\n').filter((l) => /XLSX\.read\s*\(/.test(l) && !l.trim().startsWith('//'));
  assert.equal(hits.length, 1,
    `XLSX.read 出現 ${hits.length} 次——只能有一個收斂點（readXlsxForIsolation），否則新的那個不經隔離：\n${hits.join('\n')}`);
});
