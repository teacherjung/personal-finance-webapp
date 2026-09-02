# 修法提案：`reader.cancel()` 沒帶理由——一個參數，三種死法

> **五步驟審查循環的第②步**（提修法，先不寫程式）。
> ①找問題＝William（2026-08-28 回報 CI 間歇性紅）／②提修法＝Claude（本檔）／③審修法＝發現者那一方。
> **本檔所有數字都是實測**，指令附在各節，可重跑。量測機器：macOS、Node v26.0.0、pdfjs-dist 6.1.200。

---

> ⚠️ **這份文件是「有日期的證據」，不是活的規格**（2026-09-02 補）。它在 PR #538 的審查過程中
> 被推翻過幾句話，全部保留原文＋就地標注，不要只讀被推翻的那一句：
> ①「漏還原會被後面的題抓到」——**假的**（Codex r1 實測，見第九節）
> ②「各題不再自己 finally」——**假的**（Codex r2；正確說法是 afterEach 共同兜底、局部清理照留）
> ③ 我為了消除數字矛盾而補的那組重量（子行程峰值 317MB／349MB，macOS／Node 26／pdfjs 6.1.200／
> 子行程 heap 256MB）**刻意沒有寫進程式註解**：它與 2026-07-29 那組（612→254／704→316，
> 行程內直跑、heap 400MB）條件完全不同，寫進去只會多一份對不起來的抄本。
> ⚠️ 那組舊數字也**沒有任何閘盯著**，現在活在四個地方（`lib/parse-limits.js`、
> `test/parse-limits.test.js`、`docs/contracts/cloud-security.md`、`lib/heavy-admission.js`）。
> ④ 第六節 C 段落引用的行號是提案當時（`b6e8947`）的，實作之後已經移動——**看程式以現況為準**。

## 一、一句話結論

`lib/parse-limits.js` 的 `readPageTextCapped` 呼叫 **`reader.cancel()` 沒有帶理由**，而 pdfjs 的串流來源
對理由做 `assert(reason instanceof Error)`——**這個 cancel 從第一天起就沒有生效過**，
`.catch(() => {})` 把證據吞掉了。它是**三個現象的同一個根**：

| 現象 | 何時被看見 | 當時的解釋 | 真正的原因 |
|---|---|---|---|
| 子行程 1.4 秒 `code 0` 靜默退出、stdout 全空 | 2026-08-01（#350 r2） | 「pdfjs 卡死在解壓、promise 永不 settle」 | cancel 沒生效 → pdfjs 生產端永遠等一個不會再排空的 sink → 事件迴圈跑乾 → 靜默退出 |
| 炸彈題常態綠 | 每天 | 「炸彈讓 pdfjs 卡住，父行程逾時收回」 | 同一條路卡在 `await task.destroy()`，父行程逾時 SIGKILL＝**綠燈又一次是為了錯的理由** |
| CI 間歇紅 `pdf_isolate_child_failed` | 2026-08-28 | 「CI 負載重、子行程先被資源壓死」 | 消費端 controller 已關、pdfjs 不知道，**在途的 ENQUEUE 落地時炸掉**（`ERR_INVALID_STATE`），子行程 code 1 |

**修法本體是兩行**（cancel 帶一個 `Error`）。其餘的工作量全部在「把靠這個 bug 撐著的綠燈換成真的綠燈」，
以及把**四個程式檔＋兩份契約**裡照抄了三次的誤診改口（⚠️ 這裡原本寫「一份契約」，與第六節 D 的清單
對不起來——Codex #538 r3 Low）。

---

## 二、病灶

### 2-1 程式路徑

`lib/parse-limits.js:104` `readPageTextCapped`：

```js
if (n > MAX_PDF_TEXT_ITEMS) {
  await reader.cancel().catch(() => {});     // ← :117  沒帶理由
  throw Object.assign(new Error(`${what}的文字內容太多…`), { status: 400, code: 'pdf_too_many_text_items' });
}
…
} finally {
  await reader.cancel().catch(() => {});     // ← :127  同一個病
}
```

`node_modules/pdfjs-dist/legacy/build/pdf.mjs:14842`（`sendWithStream` 的來源物件）：

```js
cancel: reason => {
  assert(reason instanceof Error, "cancel must have a valid reason");   // ← 先炸
  …
  this.streamControllers[streamId].isClosed = true;                     // ← 所以這行沒跑到
  comObj.postMessage({ …, stream: StreamKind.CANCEL, … });              // ← 這行也沒跑到
}
```

於是同時發生三件事：

1. **消費端**：WHATWG 規範的 `cancel()` 是「**先關閉串流**，再呼叫來源的 cancel」。所以我們這一端的
   controller **已經關了**。
2. **pdfjs 端**：`isClosed` 還是 `false`、CANCEL 訊息**從來沒送出去**——它完全不知道對方已經走了。
3. **我們這邊**：`.catch(() => {})` 把 rejection 吞掉，程式繼續往下 throw 400，**沒有任何人知道取消失敗了**。

### 2-2 三種死法怎麼從這裡長出來

- **卡死**：pdfjs 的生產端下一次 `enqueue` 時 `desiredSize <= 0`，就 `await sink.ready`——
  而 ready 只有在消費端繼續讀時才會 resolve，消費端已經走了 ⇒ **永遠等下去**。
  三個抽取器的 `finally { await task.destroy(); }`（`lib/statement.js:910`／`bank-statement.js:73`／
  `taishin-securities.js:96`）會等這個任務結束 ⇒ **destroy 永不回來**。
- **靜默退出**：上面那個「等下去」不是計時器、不是 handle，**只是一個沒人會 resolve 的 promise**。
  事件迴圈因此是空的 ⇒ Node 直接乾淨退出（子行程裡是 `code 0`、什麼都沒寫）。
  ——這正是 2026-08-01 看到的畫面，當時被解釋成「pdfjs 卡在解壓」。
- **炸掉**：`pdf.mjs:14993` 的 ENQUEUE 分支只看 pdfjs 自己的 `streamController.isClosed`
  （＝那個沒被設起來的旗標），所以它會對**已經關閉的 controller** 呼叫 `enqueue()`
  ⇒ `TypeError [ERR_INVALID_STATE]: Controller is already closed`，丟在 pdfjs 的訊息回呼裡＝**沒人接**
  ⇒ 子行程 `code 1`。**會不會炸，取決於取消的那一刻有沒有訊息還在路上**（`LoopbackPort` 的
  `postMessage` 是 microtask 投遞）——這就是「同一顆 commit 一次紅一次綠」的來源。

---

## 三、證據（全部可重跑）

### 3-1 CI 那次紅的完整 stderr（不是記憶體，是 JS 例外）

```bash
gh api /repos/teacherjung/personal-finance-webapp/actions/runs/33198453138/attempts/1/logs > a1.zip
```

`開發機的 Node（最新版）` job，`18:15:58.999`（＝該題起跑後約 2.88 秒、逾時 3.0 秒**之前**）：

```
[pdf-isolate] 子行程異常結束（非資源上限）： signal=null code=1 stderr=node:internal/webstreams/readablestream:1190
      throw new ERR_INVALID_STATE.TypeError('Controller is already closed');
TypeError [ERR_INVALID_STATE]: Invalid state: Controller is already closed
    at ReadableStreamDefaultController.enqueue (node:internal/webstreams/readablestream:…
```

`signal=null code=1`＝子行程**自己**帶著 JS 例外死掉，不是被殺、不是 OOM
（OOM 會是 `SIGABRT`／code 134／stderr 有 `heap out of memory`，那條路早就被 `oomMarks` 判成 400 了）。
**推測的「CI 負載重把子行程壓死」不成立**：ubuntu-latest 是 4 vCPU／16GB，而且壓死會留下訊號或 OOM 字樣。

同一次 run 的 `上線用的 Node（.node-version）` job（Node 22.23.1）**同一題綠、耗時 3410ms**
——那不是「Node 22 沒事」，那是**卡死那條路贏了競速**（見 3-2）。

### 3-2 本機實測：把每一種死法各釘一次

| # | 做的事 | 結果 |
|---|---|---|
| 1 | 現行程式，`bombPdf(3_000_000)` 丟給真的子行程，父行程給 120 秒 | **120 秒零輸出**，最後被硬砍。不是「解析很慢」，是卡死 |
| 2 | 現行程式，`bombPdf(400_000)`（剛過 30 萬節點門檻，28KB） | 同樣**卡死** |
| 3 | 拆開來看：超標時呼叫 `reader.cancel()` | **`cancel 拒絕：cancel must have a valid reason`**（2.4 秒時） |
| 4 | 接著照 production 呼叫 `task.destroy()` | **40 秒沒回來** |
| 5 | 同上，但 `reader.cancel(new Error('超過文字節點上限'))` | `cancel ok` → **`destroy 完成`，耗時 2ms** |
| 6 | 拿掉撐住行程的計時器再跑第 3–4 步 | 行程**自己安靜結束**（本例 exit 13＝top-level await；在子行程裡是 `code 0`）＝2026-08-01 看到的那個畫面 |
| 7 | 修好版子行程（`cancel` 帶理由），`bombPdf(3_000_000)` | **1914ms 回傳 `{"ok":false,"status":400,"code":"pdf_too_many_text_items"}`**，`code 0` 正常退出 |
| 8 | 修好版，未超標的正常 PDF（5 萬節點） | `{"ok":true …}`，與現行版逐字相同＝**正常路徑不受影響** |

第 7 步的完整訊息（＝使用者會看到的）：

> 信用卡帳單 PDF的文字內容太多（超過 300,000 個文字節點），無法安全解析。請確認這是一份正常的對帳單；如果檔案很大，請改用該期單獨的帳單檔。

**「那顆炸彈」根本不需要行程隔離就擋得住**——文字節點牆本來就會在 1.9 秒攔下它，
是我們自己的 cancel 讓它變成一場 30 秒的逾時。

### 3-3 時間餘裕（決定新考題怎麼寫）

| 情境 | 到達 30 萬節點門檻的時間 |
|---|---|
| `bombPdf(3_000_000)`，單獨跑 ×5 次 | 1820 / 1709 / 1712 / 1714 / 1817 ms |
| `bombPdf(3_000_000)`，4 個同時跑（模擬 CI 併發） | 3828 / 3915 / 3978 / 3916 ms |
| `bombPdf(310_000)`（最小超標檔，22KB） | 1475 ms |

**現行考題的逾時是 3000ms，而 CI 上到達門檻的時間就落在 2.9–3.4 秒**——
紅綠取決於「門檻先到」還是「SIGKILL 先到」，餘裕約 3%。這就是它間歇的原因，
**跟修不修 bug 無關的部分也必須重寫**。

---

## 四、為什麼 1300 多題全綠、卻沒有一題看見它

兩層假綠疊在一起：

**① 假替身收下了真貨會拒絕的呼叫。** `test/pdf-isolate.test.js:279`／`:326` 的假頁面：

```js
async cancel() { state.cancelled = true; },      // 不收參數、不驗理由
```

三題「邊收邊數」全部打在這個替身上，於是「超標要當場 cancel」永遠是綠的。
**真的 pdfjs 會拒絕這個呼叫**——替身比本尊寬鬆，測的就是一個不存在的世界。

**② 唯一走真 PDF 的那三題，靠這個 bug 造出來的卡死拿到綠燈。**
炸彈題（`:124`）、連打五次（`:144`）、三個抽取器（`:158`）等的都是 `pdf_timeout`，
而那個 timeout 正是 destroy 卡死換來的。修好之後**這三題會全部變紅**——它們必須重寫。

> 這是本 repo 第八次同型：**護欄自己說謊、替身比本尊寬鬆、綠燈為了錯的理由**。
> 前例見 memory 的〈我自己的護欄與註解說謊七輪〉。

---

## 五、影響範圍（誠實劃界）

| 環境 | 現在會發生什麼 | 修好之後 |
|---|---|---|
| **HOSTED** | 超過 30 萬文字節點的 PDF：①多數情況子行程卡死 → **30 秒**後父行程 SIGKILL → 400「解析太久」（訊息把原因說錯，使用者不知道該怎麼辦）②競速輸的時候子行程 code 1 → **500「伺服器暫時無法解析」**＝把我們這邊的缺陷說成伺服器故障 | 1.9 秒回 400「文字內容太多」，並告訴他改用單期帳單 |
| **LOCAL** | 沒有子行程可以兜。同一份 PDF ⇒ **那次解析永遠不會結束**，pdfjs 的任務與已配置資源到重啟前都放不掉（實測 destroy 40 秒不回、RSS 停在 79MB）。Linux 上若走到炸掉那條路，**沒有 `uncaughtException` 處理器＝整個 server 行程死掉**（全樹 grep 零個處理器） | 與 HOSTED 相同：乾淨的 400 |
| **上線那顆 Node 22.23.1** | 一樣中招（3-1 的 Node 22 job 就是卡死那條路）。這個 bug 在**我們的呼叫**與 **pdfjs 的 assert**，與 Node 版本無關 | 同上 |

⚠️ **劃界**：LOCAL 那個「Linux 上會打死整個 server」是**推理**（機制在 3-1／2-2 已證，但我沒有在 Linux 上重現整支 server 崩潰）；
macOS 上我試了三種時機都只重現到卡死、沒重現到炸掉。**HOSTED 那條炸掉的路有 CI 日誌實證。**

⚠️ 真實帳單離 30 萬節點很遠（正常對帳單一頁幾百個節點），所以**這不是每天都在發生的災情**；
但「牆一啟動就換來卡死或 500」意味著**這道牆從來沒有真正完成過它的工作**。

---

## 六、修法

### A. 根因（2 行，`lib/parse-limits.js`）

```js
// :117 與 :127 兩處
await reader.cancel(new Error('超過文字節點上限，主動中止 pdfjs 串流')).catch(…);
```

⚠️ **`.catch(() => {})` 不要留成純吞**：改成把失敗**印出來**（`console.error`，只印訊息不印內容）。
理由就是本案——取消失敗會靜靜地把「牆擋下了」變成「卡死」，
而**靜靜通過比沒有護欄更糟**（memory〈靜靜通過最危險〉）。（⚠️ 這裡原本還寫「一年也走不到幾次，沒有噪音成本」——那是**沒有量測撐著的宣稱**，實作時已拿掉，見 `lib/parse-limits.js`。）

### B. 讓替身不再比本尊寬鬆（`test/pdf-isolate.test.js`）

假頁面的 `cancel` 照抄 pdfjs 的契約：

```js
async cancel(reason) {
  if (!(reason instanceof Error)) { throw new Error('cancel must have a valid reason'); }  // 與 pdfjs 同字
  state.cancelled = true;
},
```

⚠️ **不可以在替身裡用 `assert`**：production 的 `.catch()` 會把它吞掉、考題照樣綠。
要讓它**拒絕**，這樣既有的 `assert.equal(page.state.cancelled, true)` 才會轉紅——
**讓現成的斷言去做工，而不是加一句新的斷言**。

### C. 考題重設計（把「卡住」與「提早死」分開講）

現行三題把三件事綁在一起：牆有沒有擋下、逾時有沒有作用、三個抽取器有沒有走隔離。
綁在一起就只能靠「炸彈剛好卡住」來測，那既不真也不穩。拆成四塊：

**C1｜牆擋下炸彈（取代 `:124`）** — 走真的 PDF、端到端。

```js
setPdfTimeoutForTest(20_000);   // 只當絆索：牆若又失效，20 秒收場而不是 30 秒
const err = await errOf(parseStatement(bombPdf(3_000_000)));
assert.equal(err.code, 'pdf_too_many_text_items',
  '要由文字節點牆當場擋下。收到 pdf_timeout＝牆又沒接住、只是被行程隔離兜住（本題原本就是這樣綠的）');
assert.equal(err.status, 400);
assert.ok(Date.now() - t0 < 15_000, '牆是「當場」擋，不是等逾時');
```
> ⚠️ **實作時把 `assert.ok(Date.now() - t0 < 15_000)` 那條拿掉了**（Codex #538 r6 Medium）：
> 它自己在一次完整 `npm test` 裡以 **20.19 秒**轉紅、重跑又綠——**正是本支要消滅的那個病**，
> 而且它量的其實是「整台機器跑全套時有多忙」。「是牆擋的、不是逾時兜的」由 `code` 斷言證明就夠。
> 下面這段餘裕分析仍然有效（它決定的是**絆索**要設多久），但不要再寫成考題的通過條件。

餘裕：實測 1.7 秒（單獨）／3.9 秒（4 個併發），對 20 秒的絆索有 **5 倍以上**，
且**方向是安全的**——機器再慢也只是更慢，不會反過來讓牆失效。

**C2｜逾時退路（新，取代原本靠炸彈製造的卡死）** — 用**確定會卡住**的假子行程，不再靠 pdfjs 的脾氣。

需要一個測試接縫：`lib/pdf-isolate.js` 加 `setPdfChildScriptForTest(path)`
（與現有的 `setPdfTimeoutForTest`／`resetPdfQueueForTest`／`throughPdfQueueForTest` 同一種東西，約 4 行）。
三支假子行程放 `test-doubles/`：

| 假子行程 | 行為 | 斷言 |
|---|---|---|
| `pdf-child-hang.js` | 掛計時器、永不輸出 | `code === 'pdf_timeout'`、`status === 400`、**等待時間 ≥ 逾時值**（證明是等到逾時才收回） |
| `pdf-child-crash.js` | 非同步 throw（＝ 8/28 CI 那個形狀），stdout 全空、`code 1` | **`status === 500`、`code === 'pdf_isolate_child_failed'`**，並明確斷言 **`!== 'pdf_timeout'` 且 `status !== 400`** |
| `pdf-child-silent.js` | 什麼都不做、`code 0` 退出（＝ 2026-08-01 那個形狀） | 同上：**500，不可以假裝是使用者的檔案有問題** |

這正面回答了「不要把 `pdf_isolate_child_failed` 也當成可接受的結果」：
**它不是被放行，它被升格成一條有名有姓的考題**——子行程提早死**必須**是 500，
而 400 `pdf_timeout` **只有**真的等到逾時才配得上。兩件事從此在斷言上分開，
而且都不靠時間競速（假子行程的行為是確定的，逾時可以設 500ms，全部三題約 1.5 秒跑完）。

**C3｜三個抽取器都走隔離（取代 `:158`，順便補上證券那條）** —
裝上 `pdf-child-hang.js`，然後餵**一份正常的小 PDF**給三個入口
（`parseStatement`／`parseBankStatement`／`parseTaishinSecuritiesPdf`）：

- 有走隔離 ⇒ 假子行程卡住 ⇒ `pdf_timeout`
- 沒走隔離 ⇒ 它自己在行程內把這份正常 PDF **解析成功** ⇒ 考題紅

比現行版**更強**（現行版只有信用卡與銀行兩條，且證明力來自炸彈）、更快（每條約 0.5 秒）、且完全確定。

**C4｜連打五次不長記憶體（改 `:144`）** — 期待值改成 `pdf_too_many_text_items`，
逾時改回寬鬆值（否則會與 C1 撞上同一個競速），攻擊檔換成最小超標檔 `bombPdf(310_000)`（22KB、1.5 秒）。
父行程 RSS 的斷言原封不動保留。
⚠️ 成本誠實記錄：五次 × 1.5–3.5 秒 ≈ **7.5–17 秒**（現行是 7.8 秒）。要更省的話可以降成三次，
但那是**削弱**，需要點頭。

**C5｜釘住根因本身（新，最小的一題）** — 用真的 pdfjs：超標的 PDF 跑 `readPageTextCapped`，
斷言 ①丟出 `pdf_too_many_text_items` ②**接著 `task.destroy()` 在 1 秒內 resolve**。
第②條就是本案的本體：cancel 一旦回到沒帶理由，這題**立刻紅**，而且紅得看得懂。
（C1 是端到端，未來若有人把 destroy 拿掉，C1 仍會綠；C5 不會。）

### D. 誠實改口（同一支 PR，不可延後）

誤診被照抄到 4 個程式檔＋2 份契約，全部要改：

| 檔案 | 現在寫著 | 要改成 |
|---|---|---|
| `lib/pdf-isolate.js:11-15, 32-35, 61-64` | 「更常見的是 pdfjs 卡死在解壓、promise 永遠不 settle」 | 那不是 pdfjs 的脾氣，是我們的 cancel 沒生效（本檔第二節）。**逾時仍然保留**，但它守的是**未知**的卡死，不是這一個 |
| `lib/pdf-isolate-child.js:48-52` | keep-alive 的理由＝「pdfjs 卡在解壓」 | 已知的那一個已在源頭修掉；**計時器留著**（防未知），但它的保證要縮到撐得住的範圍：父行程對「安靜退出」的歸類是 500，那條有 C2 的考題釘著 |
| `lib/parse-limits.js:76-102` | 「超標當場 cancel」（做不到） | 補上：cancel **必須**帶 `Error`，以及為什麼（pdfjs 的 assert 在設 `isClosed` 與送 CANCEL **之前**） |
| `test/pdf-isolate.test.js:1-23, 124-130` | 檔頭病歷第二段 | 補第三段：**綠燈第二次為了錯的理由**，以及替身比本尊寬鬆這一課 |
| `docs/contracts/cloud-security.md:60-61` | 同一段誤診（契約正本） | 照上表改；契約變更＝當支 PR 同步 |
| `docs/contracts/investment-sec.md:63-65` | 「反方向的同一件事在 pdf-isolate-child」的括號 | 理由更新（計時器留、但它防的是什麼要說對） |

⚠️ **保證要有考題撐著**：改口之後，「子行程不會安靜退出」這句話**沒有考題能撐**
（修掉根因之後我們沒有任何已知輸入做得到它）。所以那句要降級成
「防未知；父行程把安靜退出判成 500，那一半有 C2 釘著」，不要繼續寫成一個做不到的保證。

---

## 七、刻意不做的（劃界）

1. **不動 `MAX_PDF_TEXT_ITEMS = 300_000`**：這道牆的數字沒有問題，壞的是它的收尾動作。
2. **不動行程隔離、佇列、heap 上限、keep-alive**：它們沒有錯，只是被誤診的說明綁在一起。逾時從 30 秒起仍然需要——**未知**的卡死還是要有人接。
3. **不在 server 加 `uncaughtException` 兜底**：那會把「程式炸了」變成看不見。若要做，屬於獨立題目、要 William 裁。
4. **不給 `await task.destroy()` 加逾時**：本案的卡死已在源頭修掉；替未知的 pdfjs 卡死加保險是另一個題目（見下）。

---

## 八、要 William 裁的兩件事

**（甲）C4 的五次要不要降成三次**——省 5–10 秒 CI 時間，代價是削弱一題既有考題。
建議：**維持五次**（那題守的是累積洩漏，次數就是它的本體）。

**（乙）LOCAL 那個洞要不要順手補**——`finally { await task.destroy(); }` 目前是**無上限地等**。
本案的卡死修掉之後，剩下的是「未知的 pdfjs 卡死會讓 LOCAL 的那次請求永遠不結束」。
選項：①什麼都不做（維持 2026-07-29「LOCAL 明知帶洞」的裁決）②給 destroy 一個上限
③把行程隔離也套到 LOCAL（推翻舊裁決，每次付 250ms）。
建議：**①**，並把它記進 `docs/安全與健壯性-待辦地圖.md`——本案已經證明「替未知加保險」很容易
變成下一個說謊的護欄，而 LOCAL 帶洞是**已經拍過板**的取捨。

---

## 九、驗收清單（實作那一步要拿這張表對）

- [ ] `bombPdf(3_000_000)` 端到端回 400 `pdf_too_many_text_items`，**5 秒內**（現況：卡死 → 30 秒逾時）
- [ ] 正常 PDF 的抽取結果與修改前**逐項相同**（既有的跨行程比對題不動、必須維持綠）
- [ ] 把 `new Error(...)` 拿掉 ⇒ **C5 紅、C1 紅、B 的三題紅**（＝突變測試，不是「改完全綠就算過」）
- [x] ~~把 `setPdfChildScriptForTest` 的還原漏掉 ⇒ 同檔後面的題會紅（接縫自己會抓漏）~~
      ⚠️ **這句被反證了**（Codex #538 r1 實測：刪掉一處還原，22 題照樣全綠——下一題自己也設值，
      把污染靜靜蓋過去）。改法＝`afterEach` **共同兜底**（各題的局部清理照留——「各題不再自己
      finally」這句我在 r2 又寫錯一次，同檔的炸彈題就有自己的 finally）；
      **拿掉那個 hook 就會有三題轉紅**（已突變驗過）。這是本支自己犯的「保證撐不住」。
- [ ] 三個抽取器分別在 C3 轉紅（拆掉任一條的 `extractPdfLines` 接線）
- [ ] `npm test` 全綠**且** `gh pr checks` 兩個 job 都綠——⚠️ 本案就是「只在別的機器紅」，
      本機綠不算數（memory〈兩個把關者同一個盲點〉）
- [ ] 連跑同一支 CI 三次（或本地 `--test-concurrency` 加壓）不再出現間歇紅

---

## 十、規模與風險

- 程式改動：`lib/parse-limits.js` 2 行＋錯誤日誌 2 行；`lib/pdf-isolate.js` 約 4 行接縫。
- 考題改動：重寫 3 題、新增 5 題、修 2 個替身；新增 3 支 `test-doubles/pdf-child-*.js`。
- 文件：4 個程式檔的註解＋2 份契約段落。
- **已量過的反證**：修好之後 ①正常路徑輸出逐字不變（3-2 第 8 步）②`task.destroy()` 在超標之後
  2ms resolve、**不會**把我們的 400 換成別的錯（3-2 第 5 步）③子行程 `code 0` 正常退出、
  不再需要被 SIGKILL。
- 最大的殘餘風險：**C1 依賴「到達門檻比 20 秒絆索快」**（⚠️ 那條絆索是逾時值，不是斷言——
  實作時已把牆鐘斷言整條拿掉，見第六節 C1 上方的補注）。實測餘裕 5 倍以上、且慢只會更慢不會失效，
  但它終究是一個時間斷言——若審查者認為連這個都不該有，替代方案是把 C1 降級成
  「不設逾時、只斷言 code」，代價是牆若又失效，那題會等滿 30 秒才紅。
