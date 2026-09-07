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
// 要正確判斷那兩種，等於要在測試裡實作整套 CommonMark 行內規則；#578 從 r5 起每一輪都證明那條路不會收斂。
//
// ⚠️ **這不是 Markdown 剖析器，也不打算變成**。它防的是「整理文件時手滑，把安全契約那一節
// 收進一個新的小節」——用戶是未來的自己人，不是攻擊者（沒有任何東西釘住那道考題本身要存在，
// 有寫入權的人直接刪掉它更省事）。手滑最可能產生的正是 ATX。
// ⚠️ 代價照實寫：**刻意用 Setext 或 raw HTML 標題**的人繞得過去。那不是漏掉，是上面那筆裁示的內容。

/**
 * 哪幾行「不算數」——**成對的**圍欄程式碼區塊、**成對的**跨行 HTML 註解。
 * 這兩種裡面的 `#` 在 GitHub 上不會變成標題，當成標題就是假紅。
 *
 * ⚠️ **只有成對的才算**：落單的開門記號**不吃掉後面的內容**。這是刻意的 fail-closed——
 * 舊寫法一遇到 ``` 就翻轉狀態，於是文件裡多一個落單的圍欄記號，**它後面所有的標題偵測就整片靜音**
 * （實測：落單 ``` 之後插 `#### 以下整節已作廢`，判成 0＝靜靜放過）。那是「靜靜通過」型的失敗，
 * 比誤擋貴得多；落單記號造成的誤擋是紅的、看得見、當場能改。
 *
 * ⚠️ **刻意不處理縮排式程式碼區塊**：ATX 標題最多三格前導空白，四格以上的行本來就不可能是 ATX，
 * 所以那條規則對本判準是 no-op——寫了等於一句沒有考題撐得住的保證（鐵則 10）。
 * 縮排式程式碼裡的 Setext／raw HTML 標題本來就已經在「擋不到」清單裡。
 * @param {string[]} lines
 */
export function hiddenMap(lines) {
  const hidden = lines.map(() => false);
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  let i = 0;
  while (i < lines.length) {
    const open = FENCE.exec(lines[i]);
    // 反引號圍欄的**資訊字串不得含反引號**（GFM），`` ```lang`bad `` 不是開門（#578 r13 High③）。
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      // 關門要同種字元、長度不短於開門、後面只能有空白（資訊字串只准出現在開門行）。
      // 只看「有沒有三個反引號」的話，外層四反引號包內層三反引號這種「展示一段圍欄」的正常寫法
      // 會被內層提早關掉（#578 r12）。
      let j = i + 1;
      while (j < lines.length) {
        const close = FENCE.exec(lines[j]);
        if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length && close[2].trim() === '') break;
        j += 1;
      }
      if (j < lines.length) {
        for (let k = i; k <= j; k += 1) hidden[k] = true;
        i = j + 1;
        continue;
      }
    }
    // 行內程式碼裡的 `<!--` 只是文字（`維護語法：\`<!--\`` 是正常寫法），不可以拿來開門（#578 r13 High③）
    const noCode = lines[i].replace(/(`+)(?:(?!\1)[^\n])+?\1/g, '');
    const at = noCode.indexOf('<!--');
    if (at >= 0 && !noCode.slice(at).includes('-->')) {
      let j = i + 1;
      while (j < lines.length && !lines[j].includes('-->')) j += 1;
      if (j < lines.length) {
        // 開門那一行本身不標：`<!--` 前面的內容照樣會渲染。
        for (let k = i + 1; k <= j; k += 1) hidden[k] = true;
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return hidden;
}

/**
 * 第 i 行開啟的 ATX 標題層級；不是 ATX 標題回 0。
 * ⚠️ 井號後面一定要接空白、tab 或行尾——`#348（2026-08-02 合併）…` 這種「井號緊接數字」
 * 是 AGENTS.md 的真實內文（而且就坐在鏈最嚴格的那一段裡），少了這個條件就是當場假紅。
 * @param {string[]} arr @param {number} i @param {boolean[]} [hidden] `hiddenMap(arr)` 的結果；省略＝不看程式碼與註解
 */
export function headingAt(arr, i, hidden) {
  if (hidden && hidden[i]) return 0;
  const m = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(arr[i]);
  return m ? m[1].length : 0;
}
