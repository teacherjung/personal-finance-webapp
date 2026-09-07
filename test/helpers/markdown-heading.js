// @ts-check
// **判一行是不是「會讓後面的內容換一個爸爸」的標題**——給 `test/collab-invariant-docs.test.js`
// 的祖先標題鏈用。抽成獨立檔案的理由：#578 r11 Low⑤ 指出那幾條修正沒有任何固定夾具守著，
// 退回去也不會有考題叫。抽出來之後就能用一張正反例表直接釘住它（見同名的 .test.js）。
//
// ⚠️ **這不是 Markdown 剖析器，也不打算變成**。它要防的是「整理文件時手滑，把本節收進新的小節」，
// 用戶是未來的自己人，不是攻擊者（沒有任何東西釘住那道考題本身要存在，有寫入權的人直接刪它更省事）。
// 所以判準往「**寧可漏判，不要誤擋**」那一邊倒：誤擋會讓正常編修文件被卡住，是每天都會付的代價；
// 漏判的那些形狀寫在 collab-invariant-docs 那題開頭的「擋不到」清單裡，由複審的眼睛接。

/** 水平分隔線：`***`／`---`／`___`（≥3 個，中間可夾空白）。 @param {string} l */
export const isThematicBreak = (l) => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(l);

/** GFM 的表格分隔列：每一格都是 `:?-+:?`，而且整行有 `|`（沒有 `|` 的 `---` 是水平線）。 @param {string} l */
export const isDelimRow = (l) => l.includes('|')
  && l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').every((x) => /^ *:?-+:? *$/.test(x));

/**
 * 第 j 行是不是某個表格的一部分。往上走找分隔列；**分隔列自己上面要有表頭列**，
 * 否則那不是表格——`--- | ---` 開頭、上面沒有表頭時，GitHub 會把後面的 `---` 當成 Setext 標題
 * 而不是水平線（#578 r11 High③：少了這個條件會靜默放過一個真的 H2）。
 * @param {string[]} arr @param {number} j
 */
export function inPipeTable(arr, j) {
  for (let k = j; k >= 0 && arr[k].trim() !== '' && arr[k].includes('|'); k -= 1) {
    if (isDelimRow(arr[k])) return k > 0 && arr[k - 1].trim() !== '' && arr[k - 1].includes('|');
  }
  return false;
}

/**
 * 每一行有沒有被**行內程式碼**（單一組反引號，可跨行）碰到。
 * 只看同一行的反引號不夠：`` ` `` 開在上一行、`</h4>` 在中間那行、`` ` `` 收在下一行時，
 * 中間那行自己乾乾淨淨，卻仍在 `<code>` 裡（#578 r11 High②）。
 * ⚠️ 圍欄的內容先清成空行再算，免得圍欄的反引號跟行內的混在一起。
 * @param {string[]} lines @param {boolean[]} fenced
 */
export function codeSpanMap(lines, fenced) {
  const safe = lines.map((l, i) => (fenced[i] ? '' : l));
  const text = safe.join('\n');
  const touched = lines.map(() => false);
  const starts = [0];
  for (const l of safe) starts.push(starts[starts.length - 1] + l.length + 1);
  const lineOf = (/** @type {number} */ pos) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= pos) k += 1;
    return k;
  };
  for (const m of text.matchAll(/(`+)(?:(?!\1)[\s\S])+?\1/g)) {
    const from = lineOf(m.index ?? 0);
    const to = lineOf((m.index ?? 0) + m[0].length - 1);
    for (let k = from; k <= to; k += 1) touched[k] = true;
  }
  return touched;
}

/** 每一行是不是在圍欄程式碼區塊裡（含圍欄那兩行本身）。 @param {string[]} lines */
export function fenceMap(lines) {
  let open = false;
  return lines.map((l) => {
    const marker = /^ {0,3}(?:```|~~~)/.test(l);
    if (marker) { open = !open; return true; }
    return open;
  });
}

/**
 * 第 i 行開啟的標題層級；不是標題回 0。
 * 認三種寫法：ATX、Setext、**同一行內**的 raw HTML `<h1>`～`<h6>`。
 *
 * ⚠️ **含反引號或反斜線的行一律不看 raw HTML**。理由是誤擋的代價：
 * `` ``<h4>只是程式碼</h4>`` ``（行內程式碼）與 `\<h4>只是程式碼\</h4>`（跳脫）在 GitHub 都只是普通文字，
 * 而正確判斷它們要跟著實作 CommonMark 的行內規則——那條路 #578 r8〜r11 已經證明會一直生出假紅。
 * 代價（列在「擋不到」清單裡）：真的想插一個 `<h4>` 的人，只要在同一行別處放一個反引號就能躲過。
 * 那是刻意寫成的**對抗方向射程外**，不是漏掉。
 * @param {string[]} arr @param {number} i @param {boolean[]} [fenced] `fenceMap(arr)` 的結果；省略＝不看圍欄
 * @param {boolean[]} [inCode] `codeSpanMap(arr, fenced)` 的結果；省略＝只看同一行的反引號
 */
export function headingAt(arr, i, fenced, inCode) {
  if (fenced && fenced[i]) return 0;
  const line = arr[i];
  const atx = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line);
  if (atx) return atx[1].length;
  if (!line.includes('`') && !line.includes('\\') && !(inCode && inCode[i])) {
    // 標籤名後面必須是空白、`/` 或 `>`，不然 `<h4@example.com>` 這種 email 自動連結會被當成 H4。
    const html = [...line.matchAll(/<h([1-6])(?=[\s/>])[^>]*>/gi)].map((x) => Number(x[1]));
    if (html.length > 0) return Math.min(...html);
  }
  // Setext：只有**段落**的下一行畫 = 或 - 才是標題。
  if (i === 0 || !/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) return 0;
  const prev = arr[i - 1];
  const notParagraph = prev.trim() === ''
    || /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(prev)   // 清單項
    || /^ {0,3}>/.test(prev)                                   // 引用
    || /^ {0,3}\|/.test(prev)                                  // 前導 `|` 的表格列
    || inPipeTable(arr, i - 1)                                 // 沒有前導 `|` 的表格列
    || /^ {0,3}(?:```|~~~)/.test(prev)                         // 圍欄
    || isThematicBreak(prev)                                   // 前一行自己就是水平線
    || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(prev);                  // 標題
  if (notParagraph) return 0;
  return line.trimStart().startsWith('=') ? 1 : 2;
}
