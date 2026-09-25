## 兩張樣式表：唯讀前綴豁免的範圍與代價（**正本**）

⚠️ **這一份檔案是這個機制唯一的現在式描述。**

別處（`tools/forbidden-tools.js`、`AGENTS.md`、考題檔頭、題名、產生器、PR 說明、
`test/money-boundary.test.js`）一律只用題名關鍵字「兩張樣式表」指到這裡，**不准重述**
——理由見下面「為什麼只留一份」。由 `tests/forbidden-tools.test.js` 的「⑭ 只有一份」那一題釘住。

### 現在的規則

三道判斷，差別只有「唯讀前綴（`get_`／`list_`／`view_`／`export_`… ＝ `readPrefixes`）
擋不擋得住它」：

| 判斷 | 唯讀前綴 |
|---|---|
| 家族網（動詞＋名詞、名詞＋動詞） | **不豁免** |
| `patternsReadSafe` | **不豁免** |
| `patterns` | **豁免**（有前綴就整張不跑） |

### 為什麼兩張表這樣分

`patterns` 留的是**會誤傷真唯讀工具**的兩條：①單獨成詞的 transfer／withdraw／deposit…
（要詞界；`get_transfer_log`＝讀轉帳紀錄會中它，所以需要那個閥）②寬版
`(convert|exchange|swap)_\w*?<錢名詞>`——它把 `exchange` 當動作，而本領域 `exchange`
幾乎都是名詞（**交易所**、ETF 的 exchange **traded** fund），尾巴沒詞界、通配符還跨底線。

### 代價：這是「偏安全、願意付誤擋」的取捨，**不是零代價**

本支**兩次**收緊合起來的代價 ⇒ 下列**合理的唯讀名字現在會被擋**（主幹放行、本版拒絕，逐一實測）。
⚠️ **歸因要分清**（r5 #2 更正我原本把七個全記在新表頭上）——把 `patternsReadSafe` 清空再測就分得出來：
  ・**家族網**擋的（清空新表照樣擋）：`list_open_positions`、`get_closed_positions`、
    `get_create_order_status`、`view_order_create_history`
  ・**新表**擋的（清空新表就放行）：`get_convert_currency_rate`、`get_send_money_status`、
    `list_swap_crypto_quotes`
**踩到了照既定裁示流程處理，不要在這裡自己開洞。**

誤擋有**兩個不同來源，不可以算成同一個**：㈠動詞表裡有 `open`／`close`／`buy`／`sell`
這種「既是動作也是狀態」的字（`list_open_positions` 屬這一類，跟比對是否完整 token 無關）
㈡比對用 `_?\w*?` 不是完整 token（`close` 吃到 `closed`，`get_closed_positions` 屬這一類）。

### 射程：**守不住的**（照實寫，不是保證）

只命中 `patterns`、又帶唯讀前綴的名字仍然放行：`download_transfer_funds`、
`read_withdraw_cash`。已宣告連接器上的白名單仍會擋它們，但**誤填進白名單之後就放行**
——上面連接器那段答應的「雙保險」對它們不存在（對命中家族網的 `view_create_order` 才存在）。

⚠️ `patternsReadSafe` **不是**「全部都是動作緊接錢名詞」：搬進去的原第 4、5 條仍有
`_?\w*?securit[a-z]*` 與反向的「名詞→動詞」式（`get_preview_cached_securities_status`、
`get_securities_preview_status` 都命中）。只有新加的 `(convert|swap)_<錢名詞>` 那一條要相鄰。

### 為什麼只留一份（方法，不是感想）

這個機制在 #641 改過兩次行為。前四輪複審＋一次掃描，**每一輪都有一條發現是
「我改了行為、舊的說明還用現在式留在原地」**——因為同一句話被寫在九個地方。
靠「每次改完重 grep 一次」擋不住（實測漏了兩批）。所以照 RULES K1／K3 收成一份正本、其餘只指路。

### ⚠️ 為什麼正本住在**自己的檔案**裡，而不是程式註解裡（裁示者 2026-09-25 裁丙）

守這件事的 ⑭ 原本要判「這一行在不在程式裡那段註解的範圍內」——那等於**手寫一個
JavaScript 註解剖析器**，連續四輪被打穿：①排除整支檔 ⇒ 檔內長第二份 ②`*/` 要獨佔一行
⇒ `*/ // 尾註` ③整行排除 ⇒ 結尾同行、`*//*`、假標題、字串裡的標題 ④改用裸的
`ts.createScanner()` ⇒ 一行合法的 `void /[/*]/;` 就讓 `/*` 被當成註解起點、把區塊外的重述
整個吞進免檢（`node --check` 與 TypeScript 都認為那是合法 JS）。

**正本自己一支檔 ⇒ 沒有「檔案裡的一段」要算 ⇒ 沒有邊界可以算錯。**
⑭ 現在只做一件事：**這一支檔整份免檢，其餘受版控的 js／md／json 全掃。**

⚠️ 那一題仍是**絆線不是保證**：它認的是機制字的共現，**換句話說重述抓不到**；
**指路關鍵字是全域豁免**（任何一行帶上它就免檢，含錯誤的重述）；範圍只到已追蹤的
js／md／json、排除 `data/`，不讀 PR 說明。

### 沿革（**已失效，過去式，不要照這裡判斷**）

・2026-09-24 之前：唯讀前綴**無條件跳過家族網與五條額外樣式** ⇒ `view_create_order`
  這種「查詢的皮、下單的骨」一路放行；連接器那段答應的「雙保險」對它是假的。
・同日第一次收緊：只拆家族網那兩道，五條額外樣式仍整張豁免 ⇒ `get_send_money`、
  `get_move_funds`、`view_convert_currency`、`list_swap_crypto` 當時仍放行。
・同日第二次收緊（裁示者裁庚）：拆成上面那兩張表。
・我當時寫過而**已被推翻**的兩句：「家族網是精確比對、不需要閥」（事後合理化）、
  「只命中寬樣式的才漏」（錯：五條全部被跳過，含精確的那幾條）。
