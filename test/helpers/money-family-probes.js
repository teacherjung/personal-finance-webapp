/**
 * 錢的家族攔截——承重字表與探針清單的**唯一住所**（2026-09-01 自 money-boundary.test.js 抽出）
 *
 * 為什麼抽出來（Codex #536 r2 H）：Codex 側副本 .codex/hooks.json 的考題需要把
 * **完整家族矩陣直接跑在自己讀出的 command 上**——只靠「與 Claude 側逐位相同」的
 * 互鎖，會被「另一組保留完整 command 的 hook 代考」（兩側同步弱化＋Claude 側加一組
 * 原版，兩支考題都綠、實際上 submit_order 放行——r2 突變實證）。
 * ⚠️ 共用＝**共同失效點**：改這裡的字表，兩張考卷的題目跟著變。
 * 為此有一道**絆線**：`test/money-family-probes-integrity.test.js` 只讀本檔的位元組、
 * 比對 sha256，**完全不 import 本檔**（node --test 每檔一個行程）。
 * **在沒有人動取樣環境（預載、測試指令、那支考題本身…）的前提下**，本檔動任何一個
 * 字元（含註解）⇒ 那支轉紅，必須有意識地重算雜湊＝diff 橫跨兩檔，審查者看得見。
 * （r8 M②：前提原本漏寫，變成與下一句互斥的全稱保證。）
 * ⚠️ **它是絆線不是安全閘**——擋的是「改了字表沒發現題目跟著變」這種實務上真會
 * 發生的事；擋不住有辦法在該行程注入程式碼的人（Codex #536 r2–r6 連六輪實證，
 * 完整說明與「不要再往上加層」的理由寫在那支考題的檔頭）。
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
// ⚠️ 這裡與 .claude/settings.json 的指令必須同步改；2026-09-01（#536）起 .codex/hooks.json
// 的指令也在同一條線上。⚠️ **機器實際鎖住的只有「Claude／Codex 兩份 command 逐位相同」**
// （身分互鎖考題）；本檔與那兩份指令之間是**單向行為耦合**——指令少一個詞幹會讓探針轉紅，
// 但指令裡多出來的語法或更窄的形態不必然有題目扣著（Claude 自審 2026-09-01 實證：
// 把那些語法逐項收窄之後兩張考卷仍全綠；已補下面四支探針把它們扣住）。
// 生產用的詞表住在 hook 指令裡、而且有兩份；本檔是**探針的**唯一住所，不是詞表的正本。
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

// Claude 自審（2026-09-01）：指令的正規式有四個語法**沒有探針承重**——把它們逐項收窄之後
// 兩張考卷仍全綠（突變實測）。補上對應探針，讓每一段生產力都有題目扣著。
// （`s?` 由 `buyShares` 承接、`withdraw(al)?` 由 `request_withdrawal` 承接，本來就扣得住。）
FORBIDDEN_FAMILY.push(
  `${FAKE_UUID}placeorder`,             // 動詞×名詞之間的 `_?`＝分隔符可省略（連寫小寫）
  `${FAKE_UUID}place_new_order`,        // 動詞×名詞之間的 `\w*?`＝中間可夾字
  `${FAKE_UUID}initiate_remittance`,    // 出入金 `remit(tance)?` 的長形
  `${FAKE_UUID}initiate_disbursement`,  // 出入金 `disburse(ment)?` 的長形
);

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

// ── 2026-09-02 v6：輸入衛生與姿態閘的探針（Claude／Codex 兩張考卷共用）──────────
// 這兩批不是「工具名清單」而是**輸入形狀**與**連接器姿態**，所以另立匯出，
// 不混進 FORBIDDEN_FAMILY（那張表的每一筆都必須是可直接餵的工具名）。

/**
 * 輸入衛生：v5 只擋「非 JSON／缺 tool_name／型別錯」，實測空字串、全空白、
 * 前後空白、全形、零寬字元都會被當合法名走進家族網（Grok 2026-09-01 掃出、已實測重現）。
 * v6 的修法是**宣告合法字元集**：工具名必須逐字符合 `[A-Za-z0-9_.-]`（1~200 字），
 * 不合的一律擋。一行關掉兩個缺口——空字串／空白／全形／零寬／斜線／冒號／加號／超長
 * 全都不符合宣告，於是「還沒想到的分隔符」整類消失，不必再教它認第七種。
 * ⚠️ 這裡刻意**不**先做 NFKC／剝零寬／strip 再判斷：那樣寫過一版，實測是冗餘——
 * 字元集這一層會先接住同樣的形狀，拿掉那三步考題不會紅（＝沒有考題撐著的層）。
 * 少一層就少一個要維護、要解釋的東西；擋的效果一樣。
 * 每一筆都是**原始 stdin payload 字串**（不是工具名），期望一律 deny。
 */
export const INPUT_HYGIENE_DENY = [
  [JSON.stringify({ tool_name: '' }), '空字串'],
  [JSON.stringify({ tool_name: '   ' }), '全空白'],
  [JSON.stringify({ tool_name: '\t\n' }), '只有 tab 與換行'],
  [JSON.stringify({ tool_name: 'mcp__x__place_order ' }), '尾隨空白（v5 實測放行）'],
  [JSON.stringify({ tool_name: ' mcp__x__place_order' }), '前導空白'],
  [JSON.stringify({ tool_name: 'mcp__x__place_order\t' }), '尾隨 tab'],
  [JSON.stringify({ tool_name: 'ｍｃｐ＿＿ｘ＿＿ｐｌａｃｅ＿ｏｒｄｅｒ' }), '全形（NFKC 後才認得出）'],
  [JSON.stringify({ tool_name: 'mcp__x__place\u200b_order' }), '字中零寬字元'],
  [JSON.stringify({ tool_name: 'mcp__x__place/order' }), '斜線（非法字元集）'],
  [JSON.stringify({ tool_name: 'mcp__x__place:order' }), '冒號'],
  [JSON.stringify({ tool_name: 'mcp__x__place order' }), '空白分隔'],
  [JSON.stringify({ tool_name: 'mcp__x__place+order' }), '加號'],
  [JSON.stringify({ tool_name: `mcp__x__${'a'.repeat(300)}` }), '超長名（上限 200）'],
  ['not json at all', '非 JSON'],
  [JSON.stringify({ no_tool_name: 1 }), '缺 tool_name'],
  [JSON.stringify({ tool_name: 12345 }), 'tool_name 不是字串'],
];
export const EXPECTED_INPUT_HYGIENE = 16;

/**
 * 姿態閘：已宣告會碰錢的連接器改成**白名單制**——名單外一律擋，不管工具叫什麼。
 * 這關掉的是「靠名字猜」永遠關不掉的那一類：券商最常見的 `market_order`／`limit_order`
 * 這種單側命名（v5 的動詞×名詞文法接不到）、以及任何還沒見過的新工具名。
 * ⚠️ 誠實劃界：連接器身分是那串 UUID，**重連換 UUID 這一層就失效、退回家族網**——
 * 那時要回來更新 MONEY_SERVERS（AGENTS「錢的絕對邊界」規則 4 的通報義務接住這件事）。
 */
export const MONEY_SERVER = 'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__';

/** 名單外＝一律擋。前八個是 v5 實測會放行的真實券商命名，後兩個是「沒見過的名字」。 */
export const MONEY_SERVER_DENY = [
  'market_order', 'limit_order', 'stop_order', 'bracket_order', 'oco_order',
  'buy', 'sell', 'liquidate', 'place_orderv2', 'anything_they_add_next_year',
  'create_order_instruction', 'delete_order_instruction',
];
export const EXPECTED_MONEY_SERVER_DENY = 12;

/** 名單內＝照常放行（William 現用的唯讀查詢與明文允許的提醒／觀察清單）。 */
export const MONEY_SERVER_ALLOW = [
  'get_account_balances', 'get_account_orders', 'get_account_positions',
  'get_account_summary', 'get_account_trades', 'get_alert', 'get_alerts',
  'get_combo_identifier', 'get_company_connections', 'get_company_themes',
  'get_option_data', 'get_option_parameters', 'get_order_instructions',
  'get_pa_allocation', 'get_pa_performance_all_periods', 'get_price_history',
  'get_price_snapshot', 'get_theme_details', 'get_watchlist', 'get_watchlists',
  'search_contracts', 'search_futures', 'search_investment_topics', 'whats_new',
  'provide_customer_feedback', 'create_alert', 'update_alert', 'delete_alert',
  'set_alert_status', 'create_watchlist', 'edit_watchlist', 'delete_watchlist',
];
export const EXPECTED_MONEY_SERVER_ALLOW = 32;
