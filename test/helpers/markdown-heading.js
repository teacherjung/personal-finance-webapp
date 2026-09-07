// @ts-check
// **判一行是不是「會讓後面的內容換一個爸爸」的標題**——給 `test/collab-invariant-docs.test.js`
// 的祖先標題鏈用。抽成獨立檔案是為了能用一張正反例表直接釘住它（見同名的 .test.js）。
//
// ## 只認 ATX（William 2026-09-07 裁，原話逐字「照你新講的做」，落點＝#578 裡他的留言）
//
// 這裡**只偵測 ATX 標題**（`## 標題`）。Setext（下一行畫 `---`）與 raw HTML `<h1>`～`<h6>`
// **明講擋不到**，由「⭐ 作廢字眼絆線」那一題接住有寫「作廢／廢止」的那些。
//
// 為什麼這樣切：#578 r9〜r12 一共八條 High 全部出在後兩種寫法上，**沒有一條跟 ATX 有關**；
// 而實測專案五份規則文件（AGENTS／REVIEW-AND-MERGE／CLAUDE／PROJECT／COLLAB-MAP）裡
// **ATX 標題 53 個、Setext 0 個、raw HTML 標題 0 個**。也就是說後兩種偵測沒擋到任何我們
// 實際會寫的東西，卻是每一個假紅與漏判的來源——而假紅會擋住正常的文件編修，是天天在付的代價。
// 要正確判斷那兩種，等於要在測試裡實作整套 CommonMark 行內規則；十二輪的實證是那條路不會收斂。
//
// ⚠️ **這不是 Markdown 剖析器，也不打算變成**。它防的是「整理文件時手滑，把安全契約那一節
// 收進一個新的小節」——用戶是未來的自己人，不是攻擊者（沒有任何東西釘住那道考題本身要存在，
// 有寫入權的人直接刪掉它更省事）。手滑最可能產生的正是 ATX。
// ⚠️ 代價照實寫：**刻意用 Setext 或 raw HTML 標題**的人繞得過去。那不是漏掉，是上面那筆裁示的內容。

/**
 * 哪幾行「不算數」——圍欄程式碼區塊、縮排式程式碼區塊、跨行的 HTML 註解。
 * 這三種裡面的 `#` 在 GitHub 上都不會變成標題，當成標題就是假紅。
 * @param {string[]} lines
 */
export function hiddenMap(lines) {
  const hidden = lines.map(() => false);
  /** @type {{ch: string, len: number}|null} */
  let fence = null;
  let inComment = false;
  let inIndented = false;
  let prevBlank = true;
  lines.forEach((line, i) => {
    if (inComment) {
      hidden[i] = true;
      if (line.includes('-->')) inComment = false;
      return;
    }
    // 圍欄：關門要**同種字元、長度不短於開門**、後面只能有空白。只看「有沒有三個反引號」的話，
    // 外層四反引號包內層三反引號這種正常的「展示一段 fence」寫法會被內層提早關掉（#578 r12）。
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      hidden[i] = true;
      if (marker && marker[1][0] === fence.ch && marker[1].length >= fence.len && marker[2].trim() === '') fence = null;
      return;
    }
    if (marker) { fence = { ch: marker[1][0], len: marker[1].length }; hidden[i] = true; return; }
    const blank = line.trim() === '';
    const indent = (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
    if (inIndented) {
      if (blank || indent >= 4) { hidden[i] = true; return; }
      inIndented = false;
    }
    if (!blank && prevBlank && indent >= 4) { inIndented = true; hidden[i] = true; return; }
    if (line.includes('<!--') && !line.includes('-->')) { inComment = true; hidden[i] = true; return; }
    prevBlank = blank;
  });
  return hidden;
}

/**
 * 第 i 行開啟的 ATX 標題層級；不是 ATX 標題回 0。
 * @param {string[]} arr @param {number} i @param {boolean[]} [hidden] `hiddenMap(arr)` 的結果；省略＝不看程式碼與註解
 */
export function headingAt(arr, i, hidden) {
  if (hidden && hidden[i]) return 0;
  const m = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(arr[i]);
  return m ? m[1].length : 0;
}
