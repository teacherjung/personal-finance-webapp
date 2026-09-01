/**
 * 錢的家族攔截——承重字表與探針清單的**唯一住所**（2026-09-01 自 money-boundary.test.js 抽出）
 *
 * 為什麼抽出來（Codex #536 r2 H）：Codex 側副本 .codex/hooks.json 的考題需要把
 * **完整家族矩陣直接跑在自己讀出的 command 上**——只靠「與 Claude 側逐位相同」的
 * 互鎖，會被「另一組保留完整 command 的 hook 代考」（兩側同步弱化＋Claude 側加一組
 * 原版，兩支考題都綠、實際上 submit_order 放行——r2 突變實證）。
 * ⚠️ 共用＝**共同失效點**（Codex #536 r3–r5 連五輪同族實證：刪詞、等量替換、
 * 實例 iterator、原型 iterator、**改寫取樣器本身**——同一個行程裡，任何先執行的
 * 程式碼都能污染後面的取樣與斷言，所以同行程內的釘沒有終點）。
 * William 2026-09-01 裁示位元組釘，落地方式＝**隔離行程**：
 * `test/money-family-probes-integrity.test.js` 只讀本檔的**位元組**、比對 sha256，
 * **完全不 import 本檔**（node --test 每個測試檔各自一個行程＝本檔的程式碼在那裡
 * 從未執行，改寫 fs／原型／assert 都沒有機會發生）。本檔動任何一個字元（含註解）
 * ⇒ 那支考題轉紅，必須有意識地重算雜湊＝diff 橫跨兩檔，審查者看得見。
 * 誠實劃界：這道釘證明的是「磁碟上的本檔＝被審查過的那一版」。改考題檔本身、
 * 或連雜湊一起改的人它擋不住——沒有任何 repo 內考題能防「把考題連題目一起改掉」，
 * 那層靠審查制度。探針的**行為**正確性另由兩張考卷的實跑斷言把守。
 * 探針的**行為**正確性另由兩張考卷的實跑斷言把守；**不准在別處複抄清單本體**。
 *
 * 內容逐字自 money-boundary.test.js 搬入，沿革註解原樣保留；增刪探針時
 * 兩個字面數量釘（EXPECTED_*）要跟著有意識地改。
 */
export const FORBIDDEN_TOOLS = [
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_order_instruction',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__delete_order_instruction',
];

// 換了連接器（UUID 變了）之後兩支工具的新全名——deny 清單接不到、hook 層必須接到。
export const FORBIDDEN_AFTER_RECONNECT = [
  'mcp__00000000-aaaa-bbbb-cccc-dddddddddddd__create_order_instruction',
  'mcp__00000000-aaaa-bbbb-cccc-dddddddddddd__delete_order_instruction',
];

// 家族攔截（William 2026-08-04 指示擴編；r2 改為 per-branch 生成——Codex #404 r1 M②）：
// 下面四張清單是 hook 指令裡家族正則的**承重字表複本**，考題用它們機械生成探針：
// 指令裡少任何一個動詞→「{動詞}_order」轉紅；少任何一個名詞→「place_{名詞}」轉紅；
// 少任何一個出入金詞→「initiate_{詞}」轉紅；唯讀豁免名單少任何一個→對應放行探針轉紅。
// ⚠️ 這裡與 .claude/settings.json 的指令必須同步改（兩邊都改才綠＝雙人規則）。
export const FAMILY_VERBS = ['create', 'place', 'submit', 'send', 'stage', 'preview', 'prepare', 'draft',
  'amend', 'modify', 'edit', 'update', 'cancel', 'delete', 'execute', 'close', 'open', 'buy',
  'sell', 'purchase', 'exercise', 'liquidate', 'replace', 'redeem', 'pay'];
export const FAMILY_NOUNS = ['order', 'trade', 'position', 'instruction', 'stock', 'share', 'security',
  'etf', 'option', 'future', 'bond', 'asset', 'fund', 'crypto', 'coin', 'locate', 'invoice', 'bill'];
export const FUND_KEYWORDS = ['transfer', 'withdraw', 'deposit', 'remit', 'payout', 'disburse', 'payment', 'wire'];
export const READ_VERBS = ['get', 'list', 'search', 'fetch', 'read', 'query', 'view', 'show', 'describe',
  'has', 'check', 'retrieve', 'export', 'download'];
export const FAKE_UUID = 'mcp__00000000-aaaa-bbbb-cccc-dddddddddddd__';
export const FORBIDDEN_FAMILY = [
  ...FAMILY_VERBS.map((v) => `${v}_order`),
  ...FAMILY_NOUNS.map((n) => `place_${n}`),
  ...FUND_KEYWORDS.map((k) => `initiate_${k}`),
  'move_funds', 'send_money',                                  // 片語型出入金
  'convert_currency', 'exchange_currency', 'swap_crypto',      // 換匯三動詞分支
  'exercise_options_position', 'liquidate_position',           // Codex #404 r1 的真實漏網名
  'replace_order_by_id', 'broker_place_order',                 // （Alpaca 官方 MCP 現役工具）
  'Place_Order', 'placeOrder', 'place-order',                  // 大小寫／駝峰／連字號變體（MCP 規格合法）
  'transferFunds', 'withdrawCash', 'depositFunds',              // r2 H②：出入金分支的駝峰變體
  'makePayment', 'convertCurrency', 'swapCrypto',               // （正規化後全分支都吃）
  'create_locate', 'pay_order',                                 // r2 H②：Alpaca／PayPal 現役名
  'place_order__get_status',                                    // r2 M③：唯讀豁免只看工具開頭
  'TRANSFERFunds', 'SENDMoney', 'CONVERTCurrency',              // r3 H②：縮寫駝峰（acronym→Word 邊界）
  'purchase_stock', 'request_withdrawal', 'cash_withdrawal',    // r4 H②：常見漏網名（withdrawal 詞尾、
  'send_cash', 'move_assets', 'move_securities',                //  move/send×錢名詞、名詞_動詞倒裝）
  'order_cancel', 'trade_execute',
].map((t) => `${FAKE_UUID}${t}`).concat([
  // r3 H①：CLI 實測可註冊叫 broker__get 的 server ⇒ 切分歧義；歧義處置偏 deny——
  // 每個 __ 後綴都當候選工具查一次，任何候選命中家族網就攔。
  'mcp__broker__get__place_order',
]);

// 名字長得像、但依規則 2 明文可用的工具——對這些名字「matcher 命中且回 deny」都算誤傷
// （誤擋跟漏擋一樣是病，#384 誤擋事故）。涵蓋 IBKR 現役唯讀＋提醒/觀察清單全家，
// 加上跨連接器的高危形狀（create_draft／preview_start／send_message——動詞像、名詞不像，
// 家族網若寫壞最先誤殺的就是這幾型）。
export const ALLOWED_LOOKALIKES = [
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__get_order_instructions', // 唯讀：查已存在的委託指示
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__get_account_orders',     // 唯讀：查歷史委託
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__get_account_trades',     // 唯讀：名字帶 trade 也不准誤殺
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__get_account_positions',  // 唯讀：名字帶 position 也不准誤殺
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_alert',           // 到價提醒，不涉資金
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__update_alert',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__delete_alert',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__set_alert_status',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_watchlist',       // 觀察清單，不涉資金
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__edit_watchlist',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__delete_watchlist',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__whats_new',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__provide_customer_feedback',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__search_contracts',
  'mcp__a3d22476-476d-4ed9-bc5f-9b649571fcda__create_draft',            // Gmail 草稿：動詞像、不涉錢
  'mcp__scheduled-tasks__update_scheduled_task',                        // 排程：動詞像、不涉錢
  'mcp__Claude_Browser__preview_start',                                 // preview 是家族動詞、名詞不像
  'mcp__ccd_session_mgmt__send_message',                                // send 是家族動詞、名詞不像
  `${FAKE_UUID}create_trademark`,                                       // trade+mark 撞名（名詞邊界要接住，r1 M③）
  `${FAKE_UUID}update_sharepoint_page`,                                 // share+point 撞名
  `${FAKE_UUID}firmware_update`,                                        // firm+wire 撞名
  'mcp__payments__create_customer',                                     // 伺服器名帶 payment 不牽連工具（r2 M③）
  // 唯讀豁免逐動詞探針：指令的豁免名單少掉任何一個，對應這支就會被誤攔＝本考題轉紅。
  ...READ_VERBS.map((v) => `${FAKE_UUID}${v}_transfer_log`),
];

// 數量釘（r1 M②「宣稱 19 實際 18」＋r2 M④「加法式的釘會跟著清單一起縮」——兩面教訓）：
// 兩個都是**字面數字**，改任何一張清單＝這裡要跟著手改，兩邊對得上才綠。
export const EXPECTED_READ_VERBS_COUNT = 14;
export const EXPECTED_ALLOWED_COUNT = 36;
