// 手工造**最小合法 PDF** 的共用工具——給需要「端到端走真 PDF」的考題用。
//
// ⚠️ 這支存在的理由（2026-08-27）：`test/statement-parsers.test.js` 曾寫下劃界
//    「PDF 合成不了，所以只驗判準零件」——**那句話是錯的**，而它掩護了一整條沒有考題的接線：
//    把 `parseStatement` 裡 `if (parsedAuto.noRows) throw noRowsError(totals)` 整行刪掉，
//    全套 2792 題照樣全綠（讀不動的帳單會靜靜回報「成功、0 筆」）。三份獨立預審都指名這一條。
//    `test/pdf-extract-integrity.test.js` 檔頭③也早就記過同一句話被推翻一次。
//
// 中文怎麼來：Type0 / Identity-H ＋ ToUnicode CMap。**不需要嵌入真字型檔**——
// pdfjs 抽文字時走的是 ToUnicode 對照表，字形長什麼樣它不在乎（我們也不在乎，我們只要文字層）。
//
// ⚠️ 這裡造出來的 PDF **不能拿來當「版面」的考題**：它沒有真實帳單的座標與欄位幾何，
//    只證明「文字層有這些字」。要驗座標相關行為請用既有的合成座標列（見 pdf-extract-integrity 檔頭③）。

/**
 * 把物件與串流組成合法 PDF（含 xref 與 trailer）。objs[0] 不用，物件編號從 1 開始。
 * @param {string[]} objs 每個元素是該物件的字典/內容（不含 `N 0 obj` 與 `endobj`）
 * @param {Record<number, Buffer>=} streams 物件編號 → 串流位元組
 * @param {string=} extraTrailer 追加到 trailer 字典裡的內容（例如加密字典）
 * @returns {Uint8Array}
 */
export function build(objs, streams = {}, extraTrailer = '') {
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

const hex4 = (/** @type {number} */ n) => n.toString(16).toUpperCase().padStart(4, '0');

/**
 * 造一份**含任意 Unicode 文字（含中文）**的一頁 PDF。
 *
 * 每一列在頁面上由上而下排，同一列的各格由左而右——這樣抽出來會是 `string[][]` 的列/格結構。
 * 座標是等寬近似（每字 12pt），**不是真實帳單的幾何**：夠讓「同一列的東西被歸到同一列」，
 * 不足以驗欄位對齊那類行為（見檔頭警告）。
 *
 * @param {string[][]} rows 每一列的各個格子
 * @param {{ startY?: number, lineGap?: number, colGap?: number, fontSize?: number }=} opts
 * @returns {Uint8Array}
 */
export function cjkPdf(rows, opts = {}) {
  // ⚠️ colGap 預設 60 是**量出來的**，不是隨手挑的：24 時 pdfjs 會把「日期 日期 店名」併成同一格
  //（extractLines 依水平間距分格），120 時最後一格被推出 612pt 的頁寬而整格消失。
  //  改這個數字之前先跑一次 `extractLinesForIsolation` 看分格結果。
  const { startY = 740, lineGap = 20, colGap = 60, fontSize = 12 } = opts;

  // 每個出現過的字元配一個 CID（從 1 開始；0 保留給 .notdef）
  /** @type {Map<string, number>} */
  const cid = new Map();
  for (const row of rows) for (const cell of row) for (const ch of String(cell)) {
    if (!cid.has(ch)) cid.set(ch, cid.size + 1);
  }

  // 內容串流：一列一個 Td，格與格之間留 colGap
  let content = '';
  rows.forEach((row, r) => {
    let x = 40;
    const y = startY - r * lineGap;
    for (const cell of row) {
      const s = String(cell);
      if (s) {
        const hex = [...s].map((ch) => hex4(/** @type {number} */ (cid.get(ch)))).join('');
        content += `BT /F1 ${fontSize} Tf ${x} ${y} Td <${hex}> Tj ET\n`;
      }
      x += s.length * fontSize + colGap;
    }
  });
  const stream = Buffer.from(content, 'latin1');

  // ToUnicode CMap：CID → Unicode（pdfjs 抽字靠這張表）
  const entries = [...cid.entries()].map(([ch, id]) => {
    const u = [...ch].map((c) => hex4(/** @type {number} */ (c.codePointAt(0)))).join('');
    return `<${hex4(id)}> <${u}>`;
  });
  // bfchar 每段上限 100 筆（PDF 規格），超過要分段
  let bf = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    bf += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
  }
  const cmap = Buffer.from(
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
    + '/CMapName /A-Identity-UCS def\n/CMapType 2 def\n'
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
    + '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
    + bf
    + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n',
    'latin1',
  );

  const widths = `/W [1 ${cid.size} ${fontSize * 100}]`;   // 所有 CID 同寬（等寬近似）
  /** @type {string[]} */
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>';
  objs[3] = `<< /Length ${stream.length} >>`;
  objs[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R '
    + '/Resources << /Font << /F1 5 0 R >> >> >>';
  objs[5] = '<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H '
    + '/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>';
  objs[6] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic '
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> '
    + `/FontDescriptor 8 0 R /DW 1000 ${widths} >>`;
  objs[7] = `<< /Length ${cmap.length} >>`;
  objs[8] = '<< /Type /FontDescriptor /FontName /Synthetic /Flags 4 /FontBBox [0 -200 1000 900] '
    + '/ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>';

  return build(objs, { 3: stream, 7: cmap });
}

/** 造一份**只有拉丁字母、完全不像任何帳單**的一頁 PDF（給「認不得的版面」用）。 */
export function nonStatementPdf(text = 'hello world this is not a statement') {
  const stream = Buffer.from(`BT /F1 12 Tf 40 700 Td (${text.replace(/[()\\]/g, '')}) Tj ET\n`, 'latin1');
  /** @type {string[]} */
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>';
  objs[3] = `<< /Length ${stream.length} >>`;
  objs[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R '
    + '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>';
  return build(objs, { 3: stream });
}
