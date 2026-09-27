## 兩張樣式表：唯讀前綴豁免的範圍與代價（**正本**）

⚠️ **這一份檔案是這個機制唯一的現在式描述。**

（正本住在套件 ai-collab-kit；2026-09-27 搬自使用專案 personal-finance-webapp 的 #641（5e0f8931，2026-09-25），下文的「本支」「r5」「前四輪複審」「#641」都指那一支。往後使用專案那一份由套件同步過去，見套件 README「搬進一個專案」第 1 步。下文的條數、詞表與具名例子的實測結果，以 personal-finance-webapp 0562e422 的 forbidden 設定為前提，**並在套件的預設名單下重量過一次**（2026-09-27 起套件的空白範本 `tests/helpers/unfilled-settings.json` 帶預設名單＝那一份設定再加下面「預設字彙表」那一節的字；判定不同的例子在各段標明）；其他使用專案要照各自的設定驗證。）

別處（`tools/forbidden-tools.js`、考題檔頭、題名、產生器、PR 說明、
使用專案自己的規則書與考題）一律只用題名關鍵字「兩張樣式表」指到這裡，**不准重述**
——理由見下面「為什麼只留一份」。由 `tests/forbidden-tools.test.js` 的「⑭ 只有一份」那一題釘住。

### 現在的規則

順序（跟 `tools/forbidden-tools.js` 檔頭的編號同一個順序）：

1. **設定壞掉一律先擋**——欄位型別錯、不合文法、登記名不是連接器的名字（`mcp` 本身、`mcp__` 開頭、
   全是底線／點／連字號：這幾種不是打錯，是填成名字裡的別段，三種為什麼不收＝`tools/forbidden-tools.js` 形狀檢查上方的註解，所以由文法擋掉）、
   同一個登記名兩欄都有（大小寫不分）。壞掉時連測試鈕拿到的理由都是「設定壞掉」那一句。
2. **逐字拒絕清單**（`deny`）——測試鈕靠它，所以不論登記在哪一欄都擋得住。
3. **登記制**（裁示者 2026-09-26 裁「沒登記且不在白名單的一律禁、只有白名單上的給過」、2026-09-27 裁
   「名單空＝全擋」；只套 `mcp__` 開頭的名字——鉤子的 matcher 是 `^mcp__`，真流量只有這種名字；不是
   `mcp__` 開頭的名字只有考題與自造名字會走到，直接走下面三道，而且 `safeServers` 對它們不算一條規則）。
   登記名＝工具名 `mcp__` 後面、下一個 `__` 前面那一段（`mcp__vendor__get_thing` 的登記名是 `vendor`），
   一個連接器一筆、逐字、沒有萬用字元（`ccd_session` 蓋不到 `ccd_session_mgmt`）。依序：

| 這個名字所屬的連接器 | 結果 |
|---|---|
| 登記在 `servers`（碰錢） | 白名單制：不在 `allowlist`＝擋；在＝**往下走三道判斷**（雙保險） |
| 登記在 `safeServers`（不碰錢） | **整個放行**，三道判斷不跑（會對外送東西但不碰錢的那一級靠自覺，不是機器守著）。放行**只認標準形狀** `mcp__<登記名>__<工具名>`（工具名非空、不以 `_` 開頭、裡面不含 `__`）或只有登記名；多一層前綴、工具名空的或以 `_` 開頭或裡面還有 `__`、登記名只出現在後段＝分不清是哪個連接器＝當沒登記擋（名字看不出像錢的，訊息教人把實際的連接器段登記進去、只在確定不碰錢時；像錢的不教）。碰錢那一欄相反：名字裡**任何分段位置**出現登記名都算（拿來擋是保守的，拿來放行就是洞——#16 r1 抓到 `mcp__<沒登記>__create_order__<safe 名>` 被當成 safe 放行） |
| 兩欄都是空的（名單空） | 擋；訊息說先填連接器名單、登記名是哪一段 |
| 兩欄都沒登記 | 擋；訊息說是哪個名字、登記名是哪一段、要登記到哪一欄、改完的手續 |

登記制的拒絕（名單空、沒登記、分不清）分兩種尾句：
- 機器從名字**看不出**像錢的（家族網與兩張樣式表都沒命中）：尾句不接「視為誤觸或冒名、回報裁示者」那一句（接上去＝名單還沒填時
  每一次工具呼叫都會被上報成冒名），改說「機器從名字看不出這會動到錢，不當成事故：可能碰錢的連接器照規矩 B3 先通報裁示者、
  登記前先問，確定不碰才登記好再用」。**看不出不等於沒碰**：只有動詞的 `buy`、只有名詞的 `order`、名詞配沒列到的動作
  `confirm_order`、兩個字黏在一起的 `ordercreate`、錢形狀只在連接器那一段的 `mcp__place_order__run`、碰錢連接器換了編號之後的
  唯讀工具 `get_account_positions`，都判成看不出（2026-09-28 逐一實測）——所以這一種不說「不是碰到錢」。
- 名字**像**錢的（同一套家族網與兩張樣式表，但**唯讀前綴也不豁免**——這裡只決定尾句與訊息、不決定擋不擋，寧可多報）：
  照接那一句，訊息寫明「這個連接器要登記進哪一欄都先問裁示者；名字像錢的連接器絕不自己登記進 `safeServers`
  （真的會動到錢，例如券商重新連線、編號換了，就登記進 `servers`、下單類工具的新全名補進 `deny`）」（kind `registry-money`；裁示者 2026-09-27「全照建議」；
  起因：登記制上線那一版一律說「不是碰到錢、不必上報」，券商重連換編號時它的下單工具也會被那樣說，跟規矩 B2 衝突）。
  擋或放行的判定兩種尾句都一樣（改這一條時用 32,227 個名字×三種設定比過——範本預設、第一個使用專案 0562e422、名單空——擋放不同 0）。

決定擋不擋的三道判斷，對 `mcp__` 名字**只有碰錢連接器白名單上的工具**會走到（登記制的拒絕另外拿同一套判尾句，見上）；
其餘（考題用的自造名字）照舊。

三道判斷，差別只有「唯讀前綴（`get_`／`list_`／`view_`／`export_`… ＝ `readPrefixes`）
擋不擋得住它」：

| 判斷 | 唯讀前綴 |
|---|---|
| 家族網（動詞＋名詞、名詞＋動詞） | **不豁免** |
| `patternsReadSafe` | **不豁免** |
| `patterns` | **豁免**（有前綴就整張不跑） |

### 為什麼兩張表這樣分

`patterns` 留的是**會誤傷真唯讀工具**的兩條：①單獨成詞的 transfer／withdraw／deposit…
（要詞界；`get_transfer_log`＝讀轉帳紀錄會中它，所以需要那個閥。⚠️ 預設字彙表下 transfer／withdraw／deposit
**同時是家族網動詞**：前面或後面接到表上名詞時這個閥不存在——`get_transfer_log` 仍放行、`get_transfer_instructions` 被家族網擋，
代價列在下面「預設字彙表」那一節）②寬版
`(convert|exchange|swap)_\w*?<錢名詞>`——它把 `exchange` 當動作，而本領域 `exchange`
幾乎都是名詞（**交易所**、ETF 的 exchange **traded** fund），尾巴沒詞界、通配符還跨底線。

### 代價：這是「偏安全、願意付誤擋」的取捨，**不是零代價**

本支**兩次**收緊合起來的代價 ⇒ 下列**合理的唯讀名字現在會被擋**（主幹放行、本版拒絕，逐一實測）。
⚠️ **歸因要分清**（r5 #2 更正我原本把七個全記在新表頭上）——把 `patternsReadSafe` 清空再測就分得出來：
  ・**家族網**擋的（清空新表照樣擋）：`list_open_positions`、`get_closed_positions`、
    `get_create_order_status`、`view_order_create_history`
  ・**新表**擋的（清空新表就放行）：`get_convert_currency_rate`、`get_send_money_status`、
    `list_swap_crypto_quotes`
  （預設字彙表下 `get_send_money_status` 改由**家族網**擋——`send` 接上新收的名詞 `money`，清空新表照樣擋；
    其餘六個歸因不變。2026-09-27 逐一重量。）
**踩到了照既定裁示流程處理，不要在這裡自己開洞。**

誤擋有**兩個不同來源，不可以算成同一個**：㈠動詞表裡有 `open`／`close`／`buy`／`sell`
這種「既是動作也是狀態」的字（`list_open_positions` 屬這一類，跟比對是否完整 token 無關）
㈡比對用 `_?\w*?` 不是完整 token（`close` 吃到 `closed`，`get_closed_positions` 屬這一類）。

### 射程：**守不住的**（照實寫，不是保證）

只命中 `patterns`、又帶唯讀前綴的名字仍然放行：0562e422 的詞表下是 `download_transfer_funds`、
`read_withdraw_cash`；**預設字彙表下這兩個改由家族網擋**（`transfer`→`fund`、`withdraw`→`cash`），
但這一類沒有消失，換成 `get_transfer_log`、`list_withdrawals`、`get_transfer_history`、`list_transfers`
（2026-09-27 逐一實測，預設下仍放行）。已宣告連接器上的白名單仍會擋它們，但**誤填進白名單之後就放行**
——`tools/forbidden-tools.js` 裡連接器那段答應的「雙保險」對它們不存在（對命中家族網的 `view_create_order` 才存在）。
登記制之後多一條：把碰錢的連接器登記進 `safeServers`（登記錯欄）＝它每一支標準形狀的工具**靜靜整個放行**，
三道判斷一道都不跑；登記名對不對、漏登記某個連接器，機器都看不到。登記名填成工具名那一段（合法的
登記名形狀、文法擋不了）不會靜靜放行：不碰錢那一欄把含那一段的名字當「分不清」擋、碰錢那一欄把那一段當成碰錢連接器擋、
同連接器的其餘工具兩欄都當沒登記擋——都看得見；打成不存在的名字＝那個連接器全擋、看得見
（`mcp` 本身、`mcp__` 開頭、全是符號的由文法擋掉，也看得見）。

⚠️ `patternsReadSafe` **不是**「全部都是動作緊接錢名詞」：搬進去的原第 4、5 條仍有
`_?\w*?securit[a-z]*` 與反向的「名詞→動詞」式（`get_preview_cached_securities_status`、
`get_securities_preview_status` 都命中）。只有新加的 `(convert|swap)_<錢名詞>` 那一條要相鄰。

### 預設字彙表（2026-09-27 起住在套件的空白範本）

裁示者 2026-09-26／27 裁：「我們可以有預設名單，這樣就不用同一個連接器每個專案都要填寫一遍」、
「錢的攔截器禁區，應該是不管哪個專案都要一樣才是！」，並裁「趕緊補進字彙表」（提款／現金／轉帳那一族）。
所以 `tests/helpers/unfilled-settings.json` 的 `forbidden` 從此帶預設：第一個使用專案 0562e422 的整塊
（碰錢連接器 1 個與白名單 32 個——白名單是所有碰錢連接器共用的一份——＝唯讀查詢 24＋提醒／觀察清單 7＋回饋 1（程式訊息裡叫它「唯讀名單」是沿用的舊稱；
裁示者的分類是「唯讀查詢」與「到價提醒與觀察清單不涉資金，可用」兩類）、3 筆拒絕清單＝兩支下單工具＋測試鈕、
25 動詞、19 名詞、14 唯讀前綴、兩張表 2＋4 條）、不碰錢的連接器 26 個（**這個 claude.ai 帳號**的 6 個連接器編號＋
17 個桌面內建＋3 個 Codex；換帳號＝編號不同，把新帳號的編號**補進去**；碰錢那一欄的舊編號留著（考題要求至少包含範本；
舊編號在新帳號永遠比不到、留著無害；要拿掉先改套件範本），不碰錢那一欄的舊編號可以拿掉；拒絕清單那兩支下單工具的名字也綁著
舊編號，要照新編號補一份（沒補＝新編號上的下單工具仍由白名單制擋，但拒絕清單那一道就沒了）——手續在套件 README「搬進一個專案」第 1 步；測試鈕的連接器刻意不登記，
靠拒絕清單擋），再加下面的字。`tests/forbidden-defaults.test.js` 要求每個使用專案**擋的方向那六欄**
（`servers`、`deny`、`verbs`、`nouns`、`patterns`、`patternsReadSafe`）至少包含這一份（可以多、不可以少）；**放行方向那三欄**
（`safeServers`、`allowlist`、`readPrefixes`）不比——專案可以自己拿掉（更嚴）（裁示者 2026-09-27「全照建議」）；
任何一欄**多加**一項這一題都不比：放行三欄多加、`servers` 多登記一個連接器（同名的白名單工具跟著放行）都可能更鬆，
那是改禁區清單本身，照 README 第 3 步的手續（不碰錢連接器那一級靠自覺＝裁示者 2026-09-26；`allowlist`、`readPrefixes` 多加不在那條裁示裡）；範本自己的九欄筆數、碰錢連接器與拒絕清單、不碰錢那一欄的組成、以及下面表格列的每一個字，由同一支考題
逐字對（範本掉字、正本改了範本沒跟上都紅；改預設＝範本、考題、這一節三處一起改）。
第一個使用專案（0562e422）同步這一版：對範本缺 50 項（`safeServers` 整欄 26＋verbs 13＋nouns 11）、多 0 項；考題會紅的是
verbs、nouns 那 24 項，`safeServers` 考題不比、但不補＝那台機器連內建工具都叫不了，所以一起補；
逐字補進它的 settings.json 後重跑 `node tools/build-settings.js`、重印釘指紋那一行、每台機器補複本、重按信任
——跟登記制同一次同步做，只重印一次。

**加的字**（2026-09-27 字彙表調查：10 個代理各提一組、逐組實測代價、逐組對抗找漏網）：

| 欄 | 加了 | 數 |
|---|---|---|
| verbs | withdraw、withdrawal、transfer、xfer、deposit、remit、wire、disburse、cash_out、cashout、encash、sweep、repay | 25→38 |
| nouns | cash、money、transfer、withdrawal、payment、payout、wallet、cheque、payee、loan、settlement | 19→30 |

`transfer`、`withdrawal` 兩欄都收（動詞接名詞、名詞接動詞兩個方向都要比得到）。`settlement` 是字彙表調查要收、草稿漏了的
（見下面「刻意不加的字」settle／clear 那一條），裁示者 2026-09-27 裁補。

**量到的代價＝0**：本對話看得到的 276 個 `mcp__` 真工具名（25 個連接器）加字前後判定逐一相同（擋的只有測試鈕；
兩支下單工具本對話看不到，另外餵＝擋）；範本的 32 個白名單工具走雙保險一個都不被家族網誤擋。
⚠️ 射程：這 276 個是**這一個 Claude 對話**看得到的；Codex 側與別的對話的工具名沒量。

補之前放行、補之後擋（**全是自造名字**，走家族網；`tests/forbidden-defaults.test.js` 釘著）：`view_withdraw_cash`、
`download_transfer_funds`、`read_withdraw_cash`、`get_transfer_money`、`list_remit_payment`、`encash_cheque`、
`sweep_cash`、`repay_loan`。順帶：`update_payee`（自造）也是補之前放行、補之後擋；`send_payment_reminder`（自造）
0562e422 下**本來就**由 `patterns` 第 1 條的 `payment` 擋（`send` 不是唯讀前綴）、預設下改由家族網擋——歸因換了、判定沒變，不算新擋的。

**預設字彙表下新增的誤擋類**（自造的合理唯讀／無害維護名；2026-09-27 字彙表調查 135 個自造唯讀名裡 14 個＝10.4%，本支逐一重量：
14 個都從現行放行→預設由家族網擋；其中 12 個唯讀前綴開頭的，理由帶「唯讀前綴不替它脫罪」，`update_cash_forecast`、`update_payee_label`
兩個是無害的更新（`update` 不是唯讀前綴），理由沒有那一句；歸因＝拿掉哪一邊的新字就回放行）：
  ・拿掉**新動詞**就回放行：`get_transfer_instructions`、`get_deposit_instructions`、`get_wire_instructions`、
    `list_wire_instructions`（新動詞 × 既有名詞 instruction——券商真有「入金／匯款指示」這種唯讀概念）；
    `get_transferred_funds`、`get_withdrawn_funds`、`get_transferable_funds`、`get_withdrawable_funds`、`list_withdrawn_orders`
    （完成式／-able ＋既有名詞：家族網不認過去分詞，這個形狀天生的代價）
  ・拿掉**新名詞**就回放行：`list_closed_transfers`、`update_cash_forecast`、`update_payee_label`
    （既有狀態動詞 close／update × 新錢名詞——跟害死 `list_open_positions` 的是同一個病）
  ・拿掉任一邊都回放行：`get_withdrawable_cash`、`get_deposited_cash`
  ⚠️ 上面 14 個只是字彙表調查那一組樣本的結果，不是這一類代價的全部：送審前預審另一組 21 個自造唯讀名**全部**翻轉，
  形狀比上面三組多——既有名詞在前、新動詞在後（`get_position_transfer_status`、`get_fund_transfer_history`、`get_crypto_withdrawal_fee`，
  拿掉新動詞回放行）；新名詞在前、既有動詞在後（`get_wallet_create_time`、`get_payee_update_history`、`get_loan_close_date`，
  拿掉新名詞回放行）；狀態字 open／draft 接新名詞（`get_open_payments`、`get_draft_payments`，拿掉新名詞回放行）。2026-09-27 逐一實測。
  既有代價（加字前就擋、不算本次新帳）：`list_open_positions`、`get_closed_positions`。
  今天沒有真工具長這樣（276＋32 個真名字 0 翻轉）；代價在券商新增這種唯讀工具、要加進 `allowlist` 時才付：家族網蓋過白名單
  （`tools/forbidden-tools.js` 檔頭），而考題不准專案少任何一個預設字——要放行得先改套件範本並裁示（一輪對話的代價）。
  **給裁示者的便宜選項**（調查原話「要不要削一刀」）：拿掉 `wire`、`deposit` 兩個動詞可救回 `get_deposit_instructions`、
  `get_wire_instructions`、`list_wire_instructions`、`get_deposit_options`、`get_coin_deposit_address`、`get_deposited_cash`
  （`get_transfer_instructions` 仍擋，transfer 還在）；代價＝`view_wire_money`、`download_deposit_funds` 這種「唯讀前綴＋錢名詞」
  的動錢形狀回到放行（`wire_funds`、`deposit_cash`、`wire_transfer`、`deposit_to_wallet` 仍由 `patterns` 擋）。
  調查的判斷是不削（電匯最不可逆）；裁示者 2026-09-27 裁不削（「全照建議」）。

**刻意不加的字**（各有實測代價撐著，不是憑感覺）：
- `exchange` 當動詞 ⇒ 擋掉整族 `get_exchange_traded_funds`／`list_exchange_traded_funds`（ETF 拼全稱）——投資專案不值得。
- `settle`／`clear` 當動詞 ⇒ `get_settled_trades`／`get_settled_positions`／`get_cleared_trades` 被擋（預設詞表下再加 `get_settled_cash`、
  `get_cleared_cash`；`get_settled_balance` 不會，balance 不在名詞表——2026-09-27 逐一實測，更正本支第一版舉錯的例子）：過去分詞同時是狀態字，
  跟 `open`／`close` 害死 `list_open_positions` 是同一個病；改收名詞 `settlement`（裁示者 2026-09-27 裁補；它多擋的是 `create_settlement`、`execute_settlement`、`cancel_settlement`、
  `close_settlement_period` 這種動詞＋結算的自造名，`get_settlement_status`、`list_settlements` 照放行；`confirm_settlement` 也照放行＝
  `confirm` 不在動詞表——這一族靠補字擋不完，見下面誠實劃界）。
- 單字 `cash` 當動詞 ⇒ 擋 `get_cash_positions`（`get_cash_balance` 不會，balance 不在名詞表——2026-09-27 實測，更正第一版的例子）；
  改收 `cash_out`／`cashout`（名詞 `cash` 有收）。
- 單字 `account`／`card`／美式 `check` ⇒ 分別擋 `update_account_settings`／`edit_scorecard`／`update_health_check`。
- `credit`／`fund`／`load`／`pull`／`take` 當動詞 ⇒ 本版預設下逐一實測會誤擋：`get_credit_payments`、`get_fund_positions`、
  `load_order_history`、`pull_trade_history`、`get_take_profit_orders`（2026-09-27 重量；調查當時舉的 `get_load_balance`、`pull_transactions`
  在本版預設下不會被擋——balance、transactions 不在名詞表——所以換掉）。

**誠實劃界：這一族靠補字彙表補不完。** 調查做了 3170 個機械變形（五組）：調查當時（0562e422 的攔截器與詞表＋這批新字，
登記制之前）**2470 個（78%）仍逃得掉**、三組 100% 逃脫；本版（#16 登記制＋範本預設，2026-09-27 用同一批造名重量）
**2340 個（74%）**、兩組 100%——五組依序 780／780、1040／480、910／770、260／130、180／180，少掉的 130 個全是
`mcp__<動作_名詞>__run` 這種形狀，被登記制當沒登記的連接器擋下，不是字表變強（`<動作_名詞>__confirm` 那一半照樣放行）
——判準要「動詞在表上＋名詞在表上＋相對位置＋詞界」四件同時成立，破一件就過，而動作的同義字與名詞後綴是開放集合。
**任何地方都不准寫「提款轉帳那一族已經擋住了」。** 真正關得起來的門是**登記制**：登記過的碰錢連接器上，
不在白名單的工具一律當場擋、跟名字長怎樣無關；名字裡**任何分段位置**都沒有登記名的連接器一支工具都不准叫
（名字某一段帶著碰錢登記名的，照碰錢連接器判＝只有白名單上的工具名放行、照樣走家族網——`tests/forbidden-tools.test.js` ⑩ 釘著）。
以後任何會碰到錢的新連接器（銀行、支付、匯款），第一件事是先登記進 `servers`，不要指望字表猜得出它的工具叫什麼；
白名單是所有碰錢連接器共用的一份，登記前先看新連接器有沒有跟白名單同名的工具（同名就放行）。
登記成不碰錢的連接器裡有幾個是**通用操作**工具（`claude-in-chrome`、`Claude_Browser`、`terminal`、`computer-use`、`node_repl`）：
它們打得開券商網頁、跑得了程式，機器對它們整個放行、看不到它們在做什麼——「不碰錢」這個標籤機器撐不住，這一層的錢的邊界
靠 AI 自覺與規矩 B 節（登記它們是為了連內建工具都叫不了的那個代價，裁示者 2026-09-26 的「不做全域逐支白名單」）。

沒收的可選收緊（代理稱「乙案」：把 `patterns` 第 1 條搬進 `patternsReadSafe`）：同一批 3170 個造名可再關 1024 個
（調查當時報的「420」只是第一組 780 個裡再關的數；調查當時與本版量到的都一樣）、本對話 276 個真工具新增誤擋 0、
32 個白名單誤擋 0，代價是 135 個自造唯讀名裡被擋的從 16 升到 30（`list_transfers`、`get_transfer_history`、`list_withdrawals`）——削不削要裁示者拍，本支不動。

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
