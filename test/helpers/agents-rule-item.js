// @ts-check
// **一條頂層編號清單項（AGENTS.md 的「鐵則 N」）從哪一行開始、到哪一行結束。**
// 給 `test/collab-invariant-docs.test.js` 的保存題用：那些題要證明「承重句在**它自己那一條**裡」，
// 而不是「這幾個字在整份檔案的某處」——後者是本專案認過的假綠（文字存在、結構失效）。
// 抽成獨立檔案是為了能用一張正反例表直接釘住它（見 `test/agents-rule-item.test.js`）。
//
// ## 為什麼不是一張「下一條長什麼樣」的清單（#585 r2）
//
// 第一版用 `/^\d+(?:\.\d+)?\. /` 找下一條。獨立審查者實測**四種合法寫法它都認不得**：
// `13.` 前面一格空白、點號後接 tab、三格縮排、以及 `13)`。認不得＝邊界往後跑到下一個標題，
// 於是**隔壁那一條的文字被借來充數**，承重句搬去第 13 條照樣全綠。
// 這是本專案認過的跑步機：**列舉補不完就關門**（同族＝`test/helpers/markdown-heading.js` 的檔頭）。
// 所以這裡不列舉記號形狀，改用 CommonMark 自己的那一條規則：
//
//   **清單項的內容從「內容欄」開始；後面的行要留在這一項裡，縮排必須 ≥ 內容欄。**
//   （內容欄＝記號前的縮排 ＋ 記號長度 ＋ 記號後的空白數；空白多於四格時算一格。）
//
// 於是「下一條」不必被認出來——**任何**縮排小於內容欄的非空行都結束這一項：別條清單項、標題、
// 兄弟散文，一律如此。記號寫成 `13.`／`13)`／前面幾格空白／點號後 tab 都一樣擋得住。
//
// ⚠️ **誠實劃界（照實列，不是漏掉）**：
// ・**懶續行（lazy continuation）算在外面**。GFM 允許段落的續行不縮排，那種行在這裡會被當成邊界，
//   於是它後面的內容不算在這一項裡。方向是安全的（把那一行縮排四格就好），而且 AGENTS.md 的鐵則內文
//   一向縮排四格；反過來做（把不縮排的行都收進來）換到的是靜靜放過。
//   ⚠️ 在**目前唯一的消費者**（保存題的逐行白名單）底下，這種情形不是「可能假紅」而是**一定紅**
//   （切短之後跟白名單對不上）——原本這句寫得太鬆，Grok #585 掃後點名。
// ・**tab 縮排的續行**也會被當成邊界（這裡只數空白）。方向同樣安全：行首空白與 tab 混用時，
//   這裡數到的縮排只會**偏少**＝只會早切、不會晚切，所以假綠不從這裡來。
// ・**記號後接的是 tab、或記號獨佔一行（內文從下一行才開始）**：CommonMark 允許，但這裡的定位
//   正規式要求「記號後有空白再接非空白」，那兩種會變成 `hits` 不是 1。呼叫端因此紅——方向安全，
//   但要知道那是**連清單項都沒認出來**，不是內容欄推論的結果。
// ・這支只回答「**哪些行屬於這一條**」。它**不**回答「這一條有沒有被別的文字宣告作廢」——
//   在隔壁條末尾補一句「以下僅供歷史參考」、用 Setext／raw HTML 造標題、把內文包進一層引言，
//   或**從這一條外面**開一個會把整條吞掉的區塊，在畫面上都讀得成「已作廢／不存在」而這支照樣算它還在。
//   ⚠️ **不要讀成「那幾種都有別的東西接」**：呼叫端的劃界逐條寫明哪些真的有人接、哪些沒有
//   （有幾種是被別的考題**順帶**接住的，那不是穩定的保證）。

/** 行首空白數（只數空白；tab 見檔頭的劃界）。 @param {string} l */
const indentOf = (l) => (/^ */u.exec(l) || [''])[0].length;

/**
 * 找頂層編號清單項 `n.`／`n)` 的範圍。
 * @param {string[]} lines 整份檔案切成行
 * @param {number} n 要找的編號
 * @returns {{ hits: number, start: number, end: number, col: number }}
 *   `hits` 不是 1 時 `start`／`end`／`col` 一律 -1（呼叫端要自己出訊息）；
 *   `end` 是**不含**的結尾行號。
 */
export function ruleItemRange(lines, n) {
  // ⚠️ 記號前最多三格空白＝CommonMark 的上限；第四格起就是縮排區塊、不再是清單記號。
  const marker = /^( {0,3})(\d{1,9})([.)])( +)(?=\S)/u;
  /** @type {number[]} */
  const starts = [];
  lines.forEach((l, i) => {
    const m = marker.exec(l);
    if (m && Number(m[2]) === n) starts.push(i);
  });
  if (starts.length !== 1) return { hits: starts.length, start: -1, end: -1, col: -1 };

  const start = starts[0];
  const m = /** @type {RegExpExecArray} */ (marker.exec(lines[start]));
  // 記號後空白多於四格時，CommonMark 只算一格（多的算內容的縮排）
  const after = m[4].length > 4 ? 1 : m[4].length;
  const col = m[1].length + m[2].length + m[3].length + after;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // ⚠️ **空行的定義照 CommonMark：只有空格與 tab**（#585 r3 Medium）。用 `trim()` 會把
    //    只含全形空白（U+3000）或 NBSP 的行也當成空行——那種行在 CommonMark 眼裡是**有內容**的、
    //    縮排 0 ⇒ 它就是邊界。略過它＝繼續收後面的四格縮排行＝**把條外的字算進條內**（實測假綠）。
    if (/^[ \t]*$/u.test(lines[i])) continue;   // 空行不結束清單項
    if (indentOf(lines[i]) < col) { end = i; break; }
  }
  return { hits: 1, start, end, col };
}
