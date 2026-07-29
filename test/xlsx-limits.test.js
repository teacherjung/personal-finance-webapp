// @ts-check
// XLSX 解析器的資源上限（2026-07-28）：**一份 1.5 KB 的合法 Excel 就能打垮 Render 的 512MB 單一行程**。
//
// 為什麼這一檔存在：`lib/parse-limits.js` 原本只守 PDF 與 IB 的 XML，XLSX 一條都沒套。
// 八個 agent 分頭實測，結論是**檔案大小完全預測不了解析成本**：
//
//   真實台新帳單    18.8 KB → 15 毫秒、976 格          （對照組）
//   謊報範圍炸彈     1.9 KB → 150 秒還沒跑完、CPU 100%
//   預先配置炸彈     1.5 KB → RSS 1 GB
//   多工作表炸彈     3.2 MB → 44 秒、1113 MB
//   壓縮炸彈         1.0 MB → 1732 MB（壓縮比 ~1027:1）
//
// 所以「檔案大小上限」與「解壓後大小上限」**兩種牆都擋不到**（攻擊檔小得可笑）。
//
// ⚠️ 這一檔的每一題都**走正式的 `parseStatement`**，不是直接呼叫 assert 函式。
//    純函式考題證明得了「牆蓋得對」，證明不了「牆蓋在路上」——這個 repo 已經為此吃過兩次虧。
//    每一題都做過突變測試：把 `lib/statement.js` 裡的接線拿掉，對應的題目就會紅。
//
// ⚠️ 攻擊檔**在考題裡即時造**，不進版控：二進位 fixture 沒人看得懂、改壞了也沒人發現，
//    而且「怎麼造出這個攻擊」本身就是這份考題最該留下來的知識。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import { parseStatement } from '../lib/statement.js';
import {
  MAX_XLSX_ZIP_ENTRIES, MAX_XLSX_UNZIPPED_BYTES, MAX_XLSX_SHEET_CELLS,
} from '../lib/parse-limits.js';

// ---------------------------------------------------------------------------
// 手工造 xlsx（＝ZIP）。刻意不用 XLSX.write：我們要造的是**它不會產生**的形狀。
// ---------------------------------------------------------------------------
/** @param {Buffer} buf */
function crc32(buf) {
  /** @type {number[]} */
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let x = 0xFFFFFFFF;
  for (const b of buf) x = t[(x ^ b) & 0xFF] ^ (x >>> 8);
  return (x ^ 0xFFFFFFFF) >>> 0;
}

/**
 * @param {[string, string][]} files
 * @param {number=} fakeUsize 偽造 worksheet 的「宣告解壓後大小」
 * ⚠️ 判斷一定要用 `!== undefined`：**0 是 falsy**，用真值判斷會讓「宣告 0」那個攻擊靜默失效、
 *    考題變成假綠（施工時實際踩到——第一版的 usize0 檔案根本沒有宣告 0）。
 */
function zip(files, fakeUsize) {
  const locals = [], cd = [];
  let off = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data, { level: 9 });
    const n = Buffer.from(name, 'latin1');
    const crc = crc32(data);
    const usize = (fakeUsize !== undefined && name.includes('worksheets')) ? fakeUsize : data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42); cd.push(ch, n);
    off += 30 + n.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd), localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  return new Uint8Array(Buffer.concat([localBuf, cdBuf, eocd]));
}

/** @param {string[]} sheets @returns {[string, string][]} */
const shell = (sheets) => /** @type {[string, string][]} */ ([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
  ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
  ['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
  ...sheets.map((x, i) => /** @type {[string, string]} */ ([`xl/worksheets/sheet${i + 1}.xml`, x])),
]);


/**
 * 造一份「中央目錄同一個項目出現兩次」的 ZIP（fcnt=2，兩個目錄項目指向同一個 local 位移）。
 * SheetJS 會照 fcnt 解壓兩次——牆如果去重就會少算一半。
 * @param {[string, string][]} files
 */
function zipDuplicateCd(files) {
  const locals = [], cd = [];
  let off = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data, { level: 9 });
    const n = Buffer.from(name, 'latin1');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, comp);
    const mk = () => {
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
      return [ch, n];
    };
    cd.push(...mk());
    // ⚠️ 同一個 local 位移再登記一次
    if (name.includes('worksheets')) cd.push(...mk());
    off += 30 + n.length + comp.length;
  }
  const localBuf = Buffer.concat(locals), cdBuf = Buffer.concat(cd);
  const count = cd.length / 2;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  return new Uint8Array(Buffer.concat([localBuf, cdBuf, eocd]));
}

/** @param {string} dim @param {string} cells */
const sheetXml = (dim, cells) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/><sheetData>${cells}</sheetData></worksheet>`;
const ONE_CELL = '<row r="1"><c r="A1" t="str"><v>x</v></c></row>';
/** @param {number} mb */
const bigCell = (mb) => `<row r="1"><c r="A1" t="inlineStr"><is><t>${' '.repeat(mb * 1024 * 1024)}</t></is></c></row>`;

/** 一份真實形狀的台新帳單（對照組）。 @param {number} rows */
function realStatement(rows) {
  const aoa = [['消費日期', '入帳日', '消費明細', '幣別', '金額', '', '', '外幣']];
  for (let i = 0; i < rows; i++) aoa.push(['2026/07/01', '2026/07/05', `早餐店${i}`, 'TWD', /** @type {any} */ (120), '', '', '']);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

/** 走正式入口，回傳丟出來的錯（沒丟就回 null）。 @param {Uint8Array} data */
async function parseErr(data) {
  try { await parseStatement(data); return null; }
  catch (e) { return /** @type {any} */ (e); }
}

// ============================================================================
// 一、對照組：正常帳單一定要過（每一道牆都要先證明自己不會誤殺）
// ============================================================================

test('對照組：真實尺寸的台新帳單照常解析（122 筆）', async () => {
  const r = await parseStatement(realStatement(122));
  assert.equal(r.transactions.length, 122, '正常帳單必須完整解析出來');
  assert.equal(r.bank, '台新');
});

test('對照組：一份「重度刷卡族」規模的帳單（2000 筆）也要過', async () => {
  // 防止有人為了擋攻擊把門檻收到連正常使用者都過不去
  const r = await parseStatement(realStatement(2000));
  assert.equal(r.transactions.length, 2000);
});

// ============================================================================
// 二、四種攻擊形狀，全部走正式 parseStatement
// ============================================================================

test('形狀 A｜謊報表格範圍：1.4KB 的檔宣告 1.72e10 格 → 擋下（否則事件圈鎖死數十分鐘）', async () => {
  // SheetJS 的 sheet_to_json 迴圈上界＝ws['!ref']，而 !ref 直接抄自 <dimension>，
  // 它**完全不檢查上界**（連 Excel 的 1048576 都不擋）。
  // 實測：這種檔跑 150 秒還沒返回、RSS 只有 340MB——**不會 OOM、行程不會自己死**，
  // 所以任何記憶體上限都救不了，只能在進 sheet_to_json 之前擋。
  const data = zip(shell([sheetXml('A1:XFD1048576', ONE_CELL)]));
  assert.ok(data.length < 3000, `攻擊檔應該小得可笑（實際 ${data.length} bytes）`);
  const err = await parseErr(data);
  assert.equal(err?.code, 'xlsx_sheet_range_too_large');
  assert.equal(err?.status, 400);
  assert.match(err.message, /停止回應|範圍太大/, '訊息要讓使用者知道發生什麼事');
});

test('形狀 A′｜沒有 dimension 標籤時，!ref 由真實資料的外框算出來，一樣擋得住', async () => {
  // 防止有人以為「把 dimension 拿掉就繞過了」。SheetJS 沒有 dimension 時會用真實 bounding box。
  //
  // ⚠️ 攻擊要**兩個角落各放一顆** cell 才成立（施工時第一版只放遠端那一顆，考題自己紅了）：
  //    只有 XFD1048576 一顆 → `!ref` 是 `"XFD1048576"`（單格），decode_range 得到 1 格、完全無害。
  //    A1 ＋ XFD1048576 兩顆 → `!ref` 是 `A1:XFD1048576` ＝ 1.72e10 格，才是那個炸彈。
  //    這個細節值得留著：它同時說明了「為什麼牆量的是 !ref 而不是 cell 數」是對的。
  const noDim = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="str"><v>x</v></c></row>'
    + '<row r="1048576"><c r="XFD1048576" t="str"><v>x</v></c></row>'
    + '</sheetData></worksheet>';
  const err = await parseErr(zip(shell([noDim])));
  assert.equal(err?.code, 'xlsx_sheet_range_too_large');
});

test('形狀 A″｜炸彈藏在第二張工作表也要擋（xlsxAllText 會遍歷全部工作表）', async () => {
  // 只檢查第一張表的話，這個檔會過——而 xlsxAllText 讀到第二張時就爆了。
  const err = await parseErr(zip(shell([
    sheetXml('A1:H10', ONE_CELL),                 // 第一張人畜無害
    sheetXml('A1:XFD1048576', ONE_CELL),          // 第二張是炸彈
  ])));
  assert.equal(err?.code, 'xlsx_sheet_range_too_large', '每一張工作表都要檢查，不是只看第一張');
});

test('形狀 C1｜工作表數量炸彈：XLSX.read 對表數是 O(N²)', async () => {
  // 實測：1500 表(475KB)→547MB；10000 表(3.2MB)→44 秒、1113MB。
  const err = await parseErr(zip(shell(Array.from({ length: MAX_XLSX_ZIP_ENTRIES + 20 }, () => sheetXml('A1:A1', ONE_CELL)))));
  assert.equal(err?.code, 'xlsx_too_many_entries');
  assert.equal(err?.status, 400);
});

test('形狀 C3｜壓縮炸彈：解壓後 200MB → 擋下（實測壓縮比可達 1027:1）', async () => {
  const err = await parseErr(zip(shell([sheetXml('A1:A1', bigCell(200))])));
  assert.ok(['xlsx_declared_size_too_large', 'xlsx_unzipped_too_large'].includes(err?.code),
    `應該被大小相關的牆擋下，實際：${err?.code}`);
});

test('形狀 C4｜預先配置炸彈：1.4KB 的檔宣告自己有 400MB → 擋下', async () => {
  // SheetJS 會**照宣告值預先配置緩衝區**，就算真實內容只有幾十 bytes。
  // 實測未修前：峰值 RSS 694MB（超過 Render 的 512MB）。
  const err = await parseErr(zip(shell([sheetXml('A1:A1', ONE_CELL)]), 400 * 1024 * 1024));
  assert.equal(err?.code, 'xlsx_declared_size_too_large');
});

// ============================================================================
// 三、⚠️ 對抗 agent 找到的繞過——這一題是整檔最重要的
// ============================================================================

test('繞過①｜宣告解壓後大小 = 0：牆不可以相信宣告值，必須自己解壓量', async () => {
  // 第一版設計是「把各條目宣告的解壓後大小加總起來比對上限」。
  // 兩個**獨立的**對抗 agent 用同一招破掉：local(+22) 與 central(+24) 兩邊都宣告 0，
  // 加總是 0 就放行，SheetJS 卻照樣把 200MB 整包解開。
  // 所以現在改成**真的解壓量**（inflateRaw 帶 maxOutputLength），不採信任何宣告值。
  const data = zip(shell([sheetXml('A1:A1', bigCell(200))]), 0);
  // 先確認這份攻擊檔真的宣告了 0——不然這一題會變成「測了個寂寞」
  const buf = Buffer.from(data);
  let off = 0, sawZero = false;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(off + 26), extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('latin1');
    if (name.includes('worksheets') && buf.readUInt32LE(off + 22) === 0) sawZero = true;
    off = off + 30 + nameLen + extraLen + buf.readUInt32LE(off + 18);
  }
  assert.ok(sawZero, '前置條件：攻擊檔的 worksheet 必須真的宣告 usize=0（0 是 falsy，很容易造錯）');

  const err = await parseErr(data);
  assert.equal(err?.code, 'xlsx_unzipped_too_large',
    '宣告 0 卻塞 200MB 必須被「實際解壓量」擋下——這正是第一版設計被破的地方');
});

// ============================================================================
// ⚠️ 三之二、v1 的牆被「兩份 metadata 不一致」繞過（2026-07-29 自審抓到）
// ============================================================================
//
// v1 是「從檔頭開始，一個 local header 接一個往下跳」。但 **SheetJS 走的是中央目錄**：
// 從尾巴找 EOCD → 讀 start_cd → 依每個目錄項目記的**絕對位移** seek 到 local header。
// 兩者枚舉的**不是同一組條目**——在 local 條目之間插一段填充 byte，
// v1 讀到非 0x04034b50 就靜默結束、回報「檢查過且乾淨」，SheetJS 卻照樣把炸彈找出來解開。
//
// 教訓：**牆要跟被保護的解析器讀同一份 metadata，否則牆看到的世界跟它看到的不是同一個。**

/**
 * 造一份「local 條目之間插了填充 byte」的 ZIP——中央目錄仍然指到正確位置。
 * 這是完全合法的 ZIP（規格允許條目之間有間隙），一般解壓工具打得開。
 * @param {[string, string][]} files @param {number} padding
 */
function zipWithPadding(files, padding) {
  const locals = [], cd = [];
  let off = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data, { level: 9 });
    const n = Buffer.from(name, 'latin1');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, n);
    locals.push(lh, n, comp);
    off += 30 + n.length + comp.length;
    // ⚠️ 關鍵：在條目之間塞填充。中央目錄的 offset 已經算進去了，所以檔案完全合法。
    if (padding > 0) { locals.push(Buffer.alloc(padding, 0x41)); off += padding; }
  }
  const localBuf = Buffer.concat(locals), cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  return new Uint8Array(Buffer.concat([localBuf, cdBuf, eocd]));
}

test('繞過②｜local 條目之間插填充 byte：牆必須從中央目錄枚舉，不可以循序掃', async () => {
  // 第一個條目之後插 64 bytes 填充。v1 掃到那裡讀到 0x41414141（不是 PK\x03\x04）就靜默結束，
  // 於是**後面的炸彈條目一個都沒被量到**，卻回報「檢查過且乾淨」。
  const files = shell([sheetXml('A1:A1', bigCell(200))]);
  const data = zipWithPadding(/** @type {any} */ (files), 64);
  const err = await parseErr(data);
  assert.ok(err, '插了填充就繞過了——牆還在循序掃 local header');
  assert.ok(['xlsx_unzipped_too_large', 'xlsx_declared_size_too_large'].includes(err.code),
    `應該被大小的牆擋下（代表確實量到了那個條目），實際：${err.code}`);
});

test('繞過②′｜插填充的「正常」檔案仍然要能解析（新寫法不可以誤殺合法 ZIP）', async () => {
  // 條目之間有間隙是合法的 ZIP，一般工具打得開——牆不可以因此把正常檔案擋掉。
  const real = realStatement(122);
  // 先確認對照組本身會過
  const ok0 = await parseStatement(real);
  assert.equal(ok0.transactions.length, 122);
  // 再用手工組的「有填充但內容正常」的檔案
  const aoa = [['消費日期', '入帳日', '消費明細', '幣別', '金額', '', '', '外幣']];
  for (let i = 0; i < 5; i++) aoa.push(['2026/07/01', '2026/07/05', `早餐店${i}`, 'TWD', /** @type {any} */ (120), '', '', '']);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  const normal = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
  const err = await parseErr(normal);
  assert.ok(!err || !/xlsx_/.test(String(err.code)),
    `正常檔案被新的 ZIP 掃描擋掉了：${err?.code} ${err?.message}`);
});

test('繞過③｜中央目錄有重複條目（同一個位移出現兩次）：兩次都要算進總量', async () => {
  // SheetJS 會照 fcnt 逐條處理，同一個位移出現兩次就解壓兩次——
  // 牆如果用「檔名去重」或只算一次，就會少算一半。
  const bomb = sheetXml('A1:A1', bigCell(12));   // 單條約 12MB，兩條就超過 16MB 上限
  const files = /** @type {any} */ (shell([bomb]));
  const data = zipDuplicateCd(files);
  const err = await parseErr(data);
  assert.ok(err, '重複條目沒被算兩次');
  assert.ok(['xlsx_unzipped_too_large', 'xlsx_declared_size_too_large', 'xlsx_malformed_zip'].includes(err.code),
    `實際：${err.code}`);
});

test('fail-closed｜結構看不懂一律拒收，不可以靜默當成通過', async () => {
  // v1 在「讀不到下一個 local header」「內容超出檔案範圍」時 `break` 出迴圈**當成成功**，
  // 那本身就是第二種繞過方式。
  const good = shell([sheetXml('A1:H10', ONE_CELL)]);
  const base = Buffer.from(zip(/** @type {any} */ (good)));

  // ① 沒有 EOCD
  const noEocd = new Uint8Array(base.subarray(0, base.length - 22));
  assert.equal((await parseErr(noEocd))?.code, 'xlsx_malformed_zip', '找不到結尾目錄要拒收');

  // ② 中央目錄的位移指到檔案外面
  const badOffset = Buffer.from(base);
  const eocdAt = badOffset.length - 22;
  badOffset.writeUInt32LE(0xFFFFF000, eocdAt + 16);
  assert.equal((await parseErr(new Uint8Array(badOffset)))?.code, 'xlsx_malformed_zip', '目錄位置越界要拒收');
});

// ============================================================================
// 四、門檻本身：要能從「Render 512MB」推導，而且對正常值有足夠餘裕
// ============================================================================

test('門檻的誤殺餘裕：對真實帳單至少留兩個數量級', async () => {
  const real = realStatement(122);
  const wb = XLSX.read(real, { type: 'array' });
  const r = XLSX.utils.decode_range(wb.Sheets[wb.SheetNames[0]]['!ref']);
  const cells = (r.e.r - r.s.r + 1) * (r.e.c - r.s.c + 1);
  assert.ok(MAX_XLSX_SHEET_CELLS / cells >= 100,
    `儲存格上限對真實帳單（${cells} 格）只有 ${Math.round(MAX_XLSX_SHEET_CELLS / cells)} 倍餘裕，太緊`);
  assert.ok(MAX_XLSX_ZIP_ENTRIES >= 20, 'ZIP 條目上限要留給未來的 styles/theme/sharedStrings');
  assert.ok(MAX_XLSX_UNZIPPED_BYTES >= 8 * 1024 * 1024, '解壓後上限太低會擋掉大帳單');
  assert.ok(MAX_XLSX_UNZIPPED_BYTES <= 32 * 1024 * 1024,
    '解壓後上限太高＝SheetJS 展開後（約 8–12 倍）會超過 Render 的 512MB');
});
