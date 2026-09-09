// @ts-check
// **把 markdown 裡「畫面上看不到的東西」剝掉**——HTML 註解與 fenced code block。
//
// 這一份原本住在 `test/grok-scan-docs.test.js` 裡。`test/collab-invariant-docs.test.js` 需要**同一把尺**
// （2026-09-10 #591：新加的「兩份不可單邊消失」那題被 Grok／Codex 實測用 HTML 註解與圍欄繞過），
// 兩處各寫一份就是兩份會漂的複本，所以搬出來共用。**判準與射程一字未改**，逐字保留在下面。
//
// ⚠️ 引用本函式時**不要說「隱藏區都剝得掉」**：射程就是下面那四條 fence 判準＋HTML 註解，
//    縮排式程式碼區塊看不出來（下面第三段已寫明），raw HTML 也不處理。

/**
 * 剝掉本函式辨識得到的 HTML 註解與 fenced code；這不是「哪些字仍在發號施令」的判定器。剝兩種：
 * ①HTML 註解——`merge-procedure-docs` r1 實測：只搜關鍵字的考題，用註解就繞得過。
 * ②fenced code——把一段規則包進 fence，畫面上它就從「你要照做的規則」變成「程式碼範例」，
 *   字面卻一個沒少（2026-08-19 Codex r1 實測 6/6 假綠）。
 *
 * ⚠️ fence 這一段的歷史：r1 用一條「欄首三個反引號」的正則 → r2 被「blockquote 裡的 fence」
 * 繞過去（那種每行前面有 `>`，欄首根本不是反引號）→ 補成狀態機 → r3 又被
 * 「四個反引號包三個反引號、收尾帶尾字」繞過去（`grok-scan-docs` r3，Codex 實測 GitHub
 * 渲染後那句已是程式碼範例，而狀態機提早收了 fence，把它當成還在發號施令）。
 *
 * **一次補一種形狀補不完**（本 repo `test/contract-split.test.js` r7–r12 同型的結論：
 * 要嘛照規格做完整、要嘛老實說看不出來）。r4 曾把下面四條當成「封閉集合、沒有第五條」——
 * ⚠️ **那句話是錯的，Codex r4 當場用三種容器語法推翻**（list item 裡的 fence／Setext 標題／
 * 沒收尾的 `<!--`）。真正的「做完整」＝一整套會互相巢狀的 block grammar，那要真正的解析器。
 * William 2026-08-21 裁示**停戰**：下面四條留著（它們確實擋掉了幾種常見形狀），
 * 但**不再往下補**，射程照實寫在檔頭。四條是：
 *   ①開頭＝連續 3 個以上的 ` 或 ~（前面最多 3 個空白）
 *   ②反引號框的資訊字串裡不准再有反引號，否則它根本不算開頭
 *   ③收尾必須是**同款**記號
 *   ④收尾的長度要**大於等於**開頭，而且後面只能是空白
 * 這四條是**本函式採用的 fence 判準**，不是「再補一種繞法」。
 * ⚠️ 不要讀成「這四條就是規格本身」——完整的 block grammar 比它大得多（見上一段），
 * 那句話 2026-08-21 Codex r11 點名，已改口。
 *
 * ⚠️ 只剝 fenced，**不剝行內反引號**——條文本來就用行內 code 標指令與固定字串，剝掉會把承重的字一起剝掉。
 * ⚠️ **已知不涵蓋、也不打算涵蓋：縮排式程式碼區塊（四個空白起跳）。** 在這幾份檔案裡它跟
 * 一般的縮排續行長得一樣（條文大量使用 2–4 空白續行），硬要分會誤殺真規則。
 * 這一格照實劃界：**這種寫法本檔看不出來**，不假裝守得住。
 */
export function visible(/** @type {string} */ md) {
  const out = [];
  let fence = null;   // { ch, len }；null＝不在 fence 裡
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    // 剝掉 blockquote 標記再看——`> ``` ` 在畫面上一樣是 fence（r2 的繞法）
    const line = raw.replace(/^(\s*>)+\s?/, '');
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      // ②反引號框的資訊字串不准含反引號（``` x` 之類根本不是開頭）
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = { ch: m[1][0], len: m[1].length }; continue; }
      out.push(raw);
    } else if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') {
      fence = null;   // ③同款 ④長度夠且後面只有空白
    }
  }
  return out.join('\n');
}
