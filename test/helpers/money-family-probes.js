/**
 * 錢的家族攔截——承重字表與探針清單的**唯一住所**（2026-09-01 自 money-boundary.test.js 抽出）
 *
 * 為什麼抽出來（Codex #536 r2 H）：當時 Codex 側副本 .codex/hooks.json 的考題需要把
 * **完整家族矩陣直接跑在自己讀出的 command 上**——只靠「與 Claude 側逐位相同」的
 * 互鎖，會被「另一組保留完整 command 的 hook 代考」（兩側同步弱化＋Claude 側加一組
 * 原版，兩支考題都綠、實際上 submit_order 放行——r2 突變實證）。2026-09-18 第 8 步起判斷只有一份
 * （套件的 tools/forbidden-tools.js），Codex 側考題＝test/codex-global-hook.test.js，仍餵這同一張矩陣。
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
 * 字面數量釘（EXPECTED_*）要跟著有意識地改。
 *
 * 2026-09-27（⑧，套件登記制同步進來）起本檔另住三樣東西，同樣全專案只有這一份：
 *   ・`familyNetFixture()`＝家族網夾具：登記制之後，mcp__ 名字只有碰錢連接器白名單上的工具才走到家族網——
 *     掛在沒登記的連接器上＝整個被登記制擋、掛在不碰錢的連接器上＝整個放行，兩種都**沒有問到家族網**。
 *     要驗「家族網對各種寫法都擋、對長得像的名字不誤殺」，就得讓探針走碰錢白名單那條路（說明在函式上方）；
 *   ・`reasonClass()`＝拒絕理由的類別：登記制之後有一批探針「照樣擋、但擋的理由換了」，只斷言擋＝假綠，所以每一組斷言理由類別；
 *   ・`HARMLESS`＝「這一組不是全擋」的對照名字（原本三支考題各寫死一份）。
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
// 下面四張清單是家族網詞表的**承重字表複本**，考題用它們機械生成探針：
// 清單裡少任何一個動詞→「{動詞}_order」轉紅；少任何一個名詞→「place_{名詞}」轉紅（security 除外：place_security 另由 patternsReadSafe 那一張接住）；
// 少任何一個出入金詞→「initiate_{詞}」轉紅；唯讀豁免名單少任何一個→對應放行探針轉紅。
// ⚠️ 2026-09-27 起（登記制）上面這幾個「轉紅」要分開讀：這些探針掛在沒登記的假連接器上，真清單下**擋不擋由登記制決定**
// （詞表少一個詞照樣擋）；家族網在那裡只決定理由是不是名字像錢、尾句照接規則 3 那一種（kind 'registry-money'），
// 唯讀豁免那幾支放行探針在真清單下根本不放行。「擋的理由是家族網」「唯讀豁免真的放行」這兩件**只在 familyNetFixture()
// 那一份夾具下量得到**——承重的考題＝走夾具的那幾題（test/money-boundary.test.js 的家族網矩陣題、
// test/codex-global-hook.test.js ③ 的夾具那一輪與 ② 煙霧測的夾具那一輪）。
// ⚠️ 詞表正本（2026-09-18 第 8 步起只有一份）＝根目錄 settings.json 的 forbidden（verbs／nouns／readPrefixes／patterns），
// 判斷＝套件的 tools/forbidden-tools.js；本檔與那份清單之間是**單向行為耦合**——清單少一個詞幹會讓夾具下的探針轉紅，
// 但判斷程式裡多出來的語法或更窄的形態不必然有題目扣著（Claude 自審 2026-09-01 實證：
// 把那些語法逐項收窄之後兩張考卷仍全綠；已補下面四支探針把它們扣住）。
// 本檔是**探針的**唯一住所，不是詞表的正本。（09-01〜09-18 詞表曾住在 python 指令裡、而且有兩份，靠身分互鎖考題鎖同步。）
// ⚠️ **這份複本會落後正本**：守門＝`test/money-vocab-probe-coverage.test.js`（正本每個詞都要有探針扣著它）。
//   正本每個詞要有探針扣著；扣不住而且證明被樣式遮住的，點名列在那支考題的 SHADOWED（2026-10-10 起 withdrawal）。2026-09-29 補字的沿革在變更 647 的 PR 說明。
export const FAMILY_VERBS = ['create', 'place', 'submit', 'send', 'stage', 'preview', 'prepare', 'draft',
  'amend', 'modify', 'edit', 'update', 'cancel', 'delete', 'execute', 'close', 'open', 'buy',
  'sell', 'purchase', 'exercise', 'liquidate', 'replace', 'redeem', 'pay',
  'xfer', 'cash_out', 'cashout', 'encash', 'sweep', 'repay'];      // 2026-09-29 補
export const FAMILY_NOUNS = ['order', 'trade', 'position', 'instruction', 'stock', 'share', 'security',
  'etf', 'option', 'future', 'bond', 'asset', 'fund', 'crypto', 'coin', 'locate', 'invoice', 'bill',
  // 2026-09-29 補。securities／transfer／withdrawal／payment／payout 不放這裡：它們的 place_{名詞} 量不出承重
  // （實測加進來未承重名單不變），改用別的形狀補在 FORBIDDEN_FAMILY 底部。
  'cash', 'money', 'wallet', 'cheque', 'payee', 'loan', 'settlement'];
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
  // ⚠️ #641 之後這一支第一個候選 get__place_order 就命中動詞×名詞，**不再扣住「逐一試」那個迴圈**（2026-09-28 懷疑者突變：
  // 判斷改成只試第一個候選，錢的相關考題全綠）。要扣住它，得有第一個候選以唯讀字開頭、後面那段只有額外樣式接得住的名字——
  // 下面那一支就是（#643 的 Codex r1 與 Grok 複審後掃都抓到這個缺口；本專案先補探針，套件那邊的考題仍是待辦）：
  // 第一個候選 get__initiate_transfer 以唯讀字開頭、額外樣式那一張表替它脫罪，只有後面那段 initiate_transfer 接得住。
  // 2026-10-10 整批同步（套件 #55，William 10/08 裁 a：轉帳提款那一族掛了唯讀開頭字也照擋）：get__initiate_transfer 第一個候選就被擋，
  // 不再扣住「逐一試」——換成 get__convert_to_cash（第一個候選以唯讀字開頭、convert_to 不合額外樣式，只有後面那段 convert_to_cash 的家族網接得住）。
  'mcp__broker__get__place_order',
  'mcp__broker__get__convert_to_cash',
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
// 換形狀補的 13 支（2026-09-29）：上面兩張表只生成 `{動詞}_order` 與 `place_{名詞}`，正本有 13 個詞在那兩種
// 形狀下量不出承重（完整設定下刪掉那個詞，探針照樣被擋）。下面每一支都逐一量過：完整設定下擋、只刪該欄該詞就放行。
// 為什麼換形狀就量得出來＝見「兩張樣式表」那一份正本，這裡不重述。
FORBIDDEN_FAMILY.push(
  `${FAKE_UUID}get_withdraw_order`, `${FAKE_UUID}get_transfer_order`, `${FAKE_UUID}get_deposit_order`,
  `${FAKE_UUID}get_remit_order`, `${FAKE_UUID}get_wire_order`, `${FAKE_UUID}get_disburse_order`,
  `${FAKE_UUID}get_order_withdrawal`,                                  // withdrawal 改名詞位倒裝
  `${FAKE_UUID}xfer_security`, `${FAKE_UUID}xfer_securities`,          // security／securities 換動詞
  `${FAKE_UUID}get_place_transfer`, `${FAKE_UUID}get_place_withdrawal`,
  `${FAKE_UUID}get_place_payment`, `${FAKE_UUID}get_place_payout`,
);
// 再換形狀補的 10 支（2026-10-10 整批同步）：套件 #55（William 10/08 裁 a）把轉帳提款那一族的樣式也放進「唯讀開頭也不脫罪」那一張，
// 上面 get_{動詞}_order 那 6 支與 get_place_{名詞} 那 4 支改由那條樣式接走、詞表不再承重。連寫的寫法那條樣式接不到（它要詞的前後是底線或頭尾），
// 只有詞表扣得住：動詞用全小寫連寫的 {動詞}funds，名詞用 get_place{名詞}（舊探針拿掉一個底線，唯讀開頭的用意不變）。
// 每一支逐一量過：完整設定下擋、只刪那一欄那個詞就放行。動詞的 withdrawal 什麼形狀都扣不住（連寫被 withdraw 接走、帶底線被樣式接走），
// 點名例外在 test/money-vocab-probe-coverage.test.js（名詞的 withdrawal 由 get_placewithdrawal 扣著）。
FORBIDDEN_FAMILY.push(
  `${FAKE_UUID}withdrawfunds`, `${FAKE_UUID}transferfunds`, `${FAKE_UUID}depositfunds`,
  `${FAKE_UUID}remitfunds`, `${FAKE_UUID}wirefunds`, `${FAKE_UUID}disbursefunds`,
  `${FAKE_UUID}get_placetransfer`, `${FAKE_UUID}get_placewithdrawal`,
  `${FAKE_UUID}get_placepayment`, `${FAKE_UUID}get_placepayout`,
);
/** 數量釘（字面數字；2026-09-27 ⑧ 補：這張表被縮短時，走夾具的家族網矩陣題會靜靜少考幾個形狀）。
 *  2026-09-29：89 → 115。2026-10-10：115 → 125（整批同步，加 10 支連寫探針）。 */
export const EXPECTED_FORBIDDEN_FAMILY = 125;

// 名字長得像、但不該被家族網擋的工具——對這些名字「matcher 命中且回 deny」都算誤傷
// （誤擋跟漏擋一樣是病，#384 誤擋事故）。2026-09-27（⑧，登記制）起分成兩組，因為它們在真清單下的命運不同：
//   ・LOOKALIKES_REGISTERED（掛在真清單登記過的連接器上）＝真清單下要放行：IBKR 現役唯讀＋提醒/觀察清單全家
//     （碰錢白名單上、照樣走家族網雙保險），加上跨連接器的高危形狀（create_draft／update_scheduled_task／preview_start／
//     send_message——動詞像、名詞不像）。⚠️ 後四支的連接器在真清單登記為**不碰錢**＝整個放行、**家族網沒被問到**：
//     家族網若寫壞最先誤殺的就是這幾型，所以夾具把它們的連接器搬進碰錢那一欄，讓家族網真的被問到（familyNetFixture）。
//   ・LOOKALIKES_UNREGISTERED（掛在沒登記的假連接器上）＝真清單下被登記制擋（理由「沒有登記」）；
//     夾具下要放行＝家族網不誤殺（撞名、伺服器名帶錢詞、唯讀豁免逐動詞）。
export const LOOKALIKES_REGISTERED = [
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
];
export const LOOKALIKES_UNREGISTERED = [
  `${FAKE_UUID}create_trademark`,                                       // trade+mark 撞名（名詞邊界要接住，r1 M③）
  `${FAKE_UUID}update_sharepoint_page`,                                 // share+point 撞名
  `${FAKE_UUID}firmware_update`,                                        // firm+wire 撞名
  'mcp__payments__create_customer',                                     // 伺服器名帶 payment 不牽連工具（r2 M③）
  // 唯讀豁免逐動詞探針：指令的豁免名單少掉任何一個，對應這支在夾具下就會被誤攔＝走夾具的那幾題轉紅（真清單下它們被登記制擋）。
  // 2026-10-10 整批同步：原本的 `${v}_transfer_log` 在套件 #55 之後照擋（轉帳那一族唯讀開頭也不脫罪＝William 10/08 裁 a），不再是長得像的名字；
  // 換成 exchange_traded_funds（實測：夾具下 14 個唯讀動詞全放行；拿掉任一個動詞的唯讀豁免＝那一支被擋，14/14 都承重）。
  ...READ_VERBS.map((v) => `${FAKE_UUID}${v}_exchange_traded_funds`),
];

// 數量釘（r1 M②「宣稱 19 實際 18」＋r2 M④「加法式的釘會跟著清單一起縮」——兩面教訓）：
// 全是**字面數字**，改任何一張清單＝這裡要跟著手改，兩邊對得上才綠。
export const EXPECTED_READ_VERBS_COUNT = 14;
export const EXPECTED_LOOKALIKES_REGISTERED = 18;
export const EXPECTED_LOOKALIKES_UNREGISTERED = 18;


// ── 2026-09-02 v6：輸入衛生與姿態閘的探針（Claude／Codex 兩張考卷共用）──────────
// 這兩批不是「工具名清單」而是**輸入形狀**與**連接器姿態**，所以另立匯出，
// 不混進 FORBIDDEN_FAMILY（那張表的每一筆都必須是可直接餵的工具名）。

/**
 * 輸入衛生：v5 只擋「非 JSON／缺 tool_name／型別錯」，實測前後空白、全形、零寬字元、
 * `/` `:` 空白 `+` 分隔都會被當合法名走進家族網（外部掃描 2026-09-01 查出、已實測重現）。
 * v6 的修法是**宣告合法字元集**：工具名必須逐字符合 `[A-Za-z0-9_.-]`（1~200 字），
 * 不合的一律擋。一行關掉兩個缺口，「還沒想到的分隔符」整類消失。
 * ⚠️ 這裡刻意**不**先做 NFKC／剝零寬／strip 再判斷：那樣寫過一版，實測是冗餘——
 * 字元集這一層會先接住同樣的形狀，拿掉那三步考題不會紅（＝沒有考題撐著的層）。
 *
 * ⚠️⚠️ **下面三批的差別是「這一支到底證明了什麼」（Codex #540 r1 H1、r2 M1）**：
 * hook 有 matcher（`^mcp__`），**matcher 不命中就整個 hook 不執行**。所以：
 *   - `IN_MATCHER_DENY`＝工具名是字串且 matcher 命中 ⇒ 考卷**成對驗證**
 *     （matcher 接得住 ∧ handler 回合規 deny）＝真正的端到端保證。
 *   - `HANDLER_ONLY_DENY`＝輸入本身壞掉（不是 JSON／沒有 tool_name／型別不對），
 *     **沒有工具名可以拿去比 matcher**，所以考卷只驗得到 handler 的 fail-closed。
 *     ⚠️ r2 之前這三支混在 IN_MATCHER_DENY 裡、群組名與註解都宣稱「端到端」——
 *     那超出考題的實際證明力，已拆開。
 *   - `OUT_OF_MATCHER`＝matcher 根本篩掉 ⇒ **不是 hook 擋的**。
 *     它們也不是有效的 MCP 工具名（規格不允許空白／全形），呼叫本身就不會成立；
 *     本檔把它們留著是為了**釘住這個事實**，不是為了假裝 hook 擋了它們。
 */
export const IN_MATCHER_DENY = [
  [JSON.stringify({ tool_name: 'mcp__x__noop\n' }), '結尾換行（r1 H1：舊 python 那組的 $ 會吃掉它、當時改用 \\Z；套件那組用逐字合法字元集判）'],
  [JSON.stringify({ tool_name: 'mcp__x__place_order\n' }), '結尾換行＋錢詞'],
  [JSON.stringify({ tool_name: 'mcp__x__place_order ' }), '尾隨空白（v5 實測放行）'],
  [JSON.stringify({ tool_name: 'mcp__x__place_order\t' }), '尾隨 tab'],
  [JSON.stringify({ tool_name: 'mcp__x__place/order' }), '斜線'],
  [JSON.stringify({ tool_name: 'mcp__x__place:order' }), '冒號'],
  [JSON.stringify({ tool_name: 'mcp__x__place order' }), '空白分隔'],
  [JSON.stringify({ tool_name: 'mcp__x__place+order' }), '加號'],
  [JSON.stringify({ tool_name: 'mcp__x__place\u200b_order' }), '字中零寬字元'],
  [JSON.stringify({ tool_name: `mcp__x__${'a'.repeat(300)}` }), '超長名（上限 200）'],
];
export const EXPECTED_IN_MATCHER_DENY = 10;

/** 輸入壞到沒有工具名可比 matcher——只驗得到 handler 自己的 fail-closed。 */
export const HANDLER_ONLY_DENY = [
  ['not json at all', '非 JSON'],
  [JSON.stringify({ no_tool_name: 1 }), '缺 tool_name'],
  [JSON.stringify({ tool_name: 12345 }), 'tool_name 不是字串'],
];
export const EXPECTED_HANDLER_ONLY_DENY = 3;

/** matcher（`^mcp__`）篩不到的形狀——hook 不會執行；它們也不是有效的 MCP 工具名。 */
export const OUT_OF_MATCHER = [
  ['', '空字串'],
  ['   ', '全空白'],
  ['\t\n', '只有 tab 與換行'],
  [' mcp__x__place_order', '前導空白（前面不是 mcp__ 開頭）'],
  ['ｍｃｐ＿＿ｘ＿＿ｐｌａｃｅ＿ｏｒｄｅｒ', '全形（整串都不是 ASCII）'],
];
export const EXPECTED_OUT_OF_MATCHER = 5;

/**
 * 姿態閘：已宣告會碰錢的連接器改成**白名單制**——名單外一律擋，不管工具叫什麼。
 * 這關掉的是「靠名字猜」永遠關不掉的那一類：券商最常見的 `market_order`／`limit_order`
 * 這種單側命名（v5 的動詞×名詞文法接不到）、以及任何還沒見過的新工具名。
 * ⚠️ 名單是**一組精確的工具身分**（**這裡刻意不寫幾個**——寫死的數字自己會漂；
 * 正本＝根目錄 settings.json 的 forbidden.allowlist（JSON 陣列），考題直接比對它與下面的清單集合相等
 * ——比舊制用 python AST 抽指令裡的 `ALLOW` 更緊：JSON 沒有綁定形式可以繞（09-01〜09-18 那套 AST 判準與 15 種負向形式
 * 隨 python 那組退役），比對前**不做任何正規化**（Codex #540 r1 H2：
 * 原本先把 `-` `.` 收成 `_` 再轉小寫，於是 `GET_ACCOUNT_BALANCES`／`get-account-balances`
 * 這些**不在名單上**的名字都通過了＝把名單擴張成等價類，未來新增的同形工具會繞過）。
 * ⚠️ 誠實劃界：連接器身分是那串 UUID。**重連換了 UUID＝新編號沒登記＝整個連接器被登記制擋**（連唯讀查詢也擋；
 * 名字像錢的那幾支，理由的尾句照接規則 3 那一句（當誤觸或冒名、回報裁示者）——FORBIDDEN_AFTER_RECONNECT 那兩支就是這個情境）。
 * 那時的手續（新編號登記進哪一欄、下單類新全名補到哪幾層、登記前先問 William）＝docs/money-guard-operations.md。
 * ⚠️ 白名單掃的是**每一段** `__`（與家族網的候選切法對齊，Grok #540 掃第 1 條：
 * 原本只認第一段，於是 `mcp__prefix__<uuid>__market_order` 這種多段前綴整層不開火）。
 */

/** 名單外＝一律擋，且 UUID 不在第一段時也要擋（多段前綴探針）。 */
export const MONEY_SERVER_MULTISEG_DENY = [
  ['mcp__prefix__deda1d5d-1ccc-4551-9617-156b9658d236__market_order', 'UUID 在第二段'],
  ['mcp__a__deda1d5d-1ccc-4551-9617-156b9658d236__limit_order', 'UUID 在第二段（短前綴）'],
  ['mcp__x__deda1d5d-1ccc-4551-9617-156b9658d236__buy', '單獨動詞＋多段前綴'],
];
export const EXPECTED_MONEY_SERVER_MULTISEG_DENY = 3;

/**
 * 多段前綴的**反向對照組**（Codex #540 r4 M2）：只有「多段前綴要擋」的探針時，
 * 把實作退化成「UUID 不在第一段就一律 deny」，三支擋的探針與標準前綴的放行題都仍全綠。
 * 這一批鎖住那個副作用——多段前綴下的名單內工具必須照常放行。
 */
export const MONEY_SERVER_MULTISEG_ALLOW = [
  ['mcp__prefix__deda1d5d-1ccc-4551-9617-156b9658d236__get_account_balances', 'UUID 在第二段＋名單內唯讀'],
  ['mcp__a__deda1d5d-1ccc-4551-9617-156b9658d236__create_alert', 'UUID 在第二段＋名單內提醒'],
];
export const EXPECTED_MONEY_SERVER_MULTISEG_ALLOW = 2;
export const MONEY_SERVER = 'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__';

/** 名單外＝一律擋。含 v5 實測會放行的真實券商命名、沒見過的新名、以及同形碰撞。 */
export const MONEY_SERVER_DENY = [
  'market_order', 'limit_order', 'stop_order', 'bracket_order', 'oco_order',
  'buy', 'sell', 'liquidate', 'place_orderv2', 'anything_they_add_next_year',
  'create_order_instruction', 'delete_order_instruction',
  'GET_ACCOUNT_BALANCES', 'get-account-balances', 'get.account.balances', 'Get_Account_Balances',
];
export const EXPECTED_MONEY_SERVER_DENY = 16;

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


// ── 2026-09-27（⑧，套件登記制同步進來）：對照名字、家族網夾具、理由類別 ────────────────

/**
 * 「這一組不是全擋」的對照名字：掛在真清單登記為**不碰錢**的 terminal 底下＝整個放行（只是字串、只餵攔截器，不會真的叫任何工具）。
 * 用到它的考題先斷言前提「真清單的 safeServers 有 HARMLESS_SERVER」——拿掉了，失敗訊息才看得懂是前提變了、不是攔截器壞了。
 * （2026-09-27 之前三支考題各寫死一份 mcp__other__get_widget：登記制之後 other 沒登記＝被擋，對照組不成立。）
 */
export const HARMLESS_SERVER = 'terminal';
export const HARMLESS = `mcp__${HARMLESS_SERVER}__get_widget`;

/**
 * 探針名字拆成「連接器登記名」與「工具名那一段」：登記名＝mcp__ 後面、下一個 __ 前面那一段（套件登記制的同一把尺），
 * 工具名那一段＝其後的全部（可以還含 __，例如 mcp__broker__get__place_order 的 get__place_order）。不是這個形狀＝當場丟錯。
 * @param {string} name
 */
export function splitProbe(name) {
  const m = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (!m) throw new Error(`探針「${name}」不是 mcp__<登記名>__<工具名> 的形狀，夾具接不住它`);
  return { server: m[1], tool: m[2] };
}

/** 夾具預設要讓它走家族網的名字＝家族矩陣全部（該擋的兩組、該放的兩組）。 */
export const FAMILY_NET_PROBES = [...FORBIDDEN_AFTER_RECONNECT, ...FORBIDDEN_FAMILY, ...LOOKALIKES_REGISTERED, ...LOOKALIKES_UNREGISTERED];

/**
 * 家族網夾具（全專案只有這一份；docs/money-guard-operations.md「考題」那一則指到這裡）。
 * 為什麼：登記制之後，mcp__ 名字只有碰錢連接器白名單上的工具才走到家族網（沒登記＝整個擋、不碰錢＝整個放行，都沒問到它）。
 * 做法：把 names 裡每個名字的連接器登記成**碰錢**（servers）、工具名那一段放上白名單（allowlist），讓每個名字都走
 * 「碰錢白名單 → 家族網雙保險」那條路。原本登記在 safeServers 的連接器（跨連接器那四支）**從那一欄搬走**——
 * 只加進 servers、不從 safeServers 拿掉＝同名兩欄＝設定壞掉、全擋（大小寫不分，跟攔截器同一把尺）。
 * 詞表（verbs／nouns／readPrefixes／patterns／patternsReadSafe）、拒絕清單、名稱**照真清單一字不動**（用到的考題另外斷言這幾欄等於真清單）：
 * 真清單的 verbs 少了 FAMILY_VERBS 的任何一個、readPrefixes 少了 READ_VERBS 的任何一個、nouns 少了 FAMILY_NOUNS 的任何一個
 * ＝走夾具的題就紅（2026-09-29 逐字拿掉、用行程內 decide() 重量，走**本版完整的 115 支矩陣**：動詞 31/31、名詞 25/25）。
 * ⚠️ 只看 `place_{名詞}` 那一組時名詞是 24/25（security 例外）——那是較窄的範圍，不是本段所指的完整夾具。
 * ⚠️ 唯讀前綴 14/14 是另一組**放行**探針量的（刪前綴之後從放行變拒絕），不在這 115 支裡。
 * 正本每個詞都有探針扣著＝`test/money-vocab-probe-coverage.test.js`（裁示者 2026-09-29 裁 a）；
 * 正本比空白範本少一個字＝`tests/forbidden-defaults.test.js` ①。沿革在變更 647 的 PR 說明。
 * ⚠️ 只給考題用：只進行程內 decide()、或考題自己在暫存目錄抽的複本，**不進正式清單**（把假連接器登記進正式清單＝
 * 那些名字在真的對話裡的判法跟著變）。
 * ⚠️ 預設的 names 含 FORBIDDEN_AFTER_RECONNECT＝create_order_instruction／delete_order_instruction 也被放上白名單：
 * **不可以拿這一份去跑「白名單是精確集合」或券商白名單矩陣**（那兩種要用真清單）。
 * @param {any} forbidden 真清單（settings.json 的 forbidden 那一塊）
 * @param {string[]} [names]
 */
export function familyNetFixture(forbidden, names = FAMILY_NET_PROBES) {
  const parts = names.map(splitProbe);
  const servers = [...new Set(parts.map((p) => p.server))];
  const moved = new Set(servers.map((s) => s.toLowerCase()));
  const tools = [...new Set(parts.map((p) => p.tool))];
  return {
    ...forbidden,
    servers: [...forbidden.servers, ...servers.filter((s) => !forbidden.servers.includes(s))],
    safeServers: forbidden.safeServers.filter((s) => !moved.has(s.toLowerCase())),
    allowlist: [...forbidden.allowlist, ...tools.filter((t) => !forbidden.allowlist.includes(t))],
  };
}

/**
 * 拒絕理由的類別。認的是套件 tools/forbidden-tools.js 的理由文字（decide() 只有登記制那一種拒絕帶 kind，其他類別只能用文字認）；
 * 給 decide() 的 why、或鉤子輸出的 permissionDecisionReason 都可以（後者開頭多了「<禁區名>的絕對邊界：」，reasonClass 先剝掉）。
 * 都只認**開頭**：登記制的理由中段會引述家族網命中了什麼，開頭才分得出是哪一層擋的。
 *   denylist＝逐字拒絕清單；whitelist＝碰錢連接器的白名單制；registry＝登記制「沒有登記」（名字像不像錢都是這一類，差在 kind 與尾句）；
 *   family＝家族網或額外樣式；charset＝工具名不合法字元集；badInput＝輸入壞到沒有工具名。
 */
export const REASON_CLASSES = Object.freeze({
  denylist: /^工具「[^」]*」在拒絕清單上/u,
  whitelist: /^連接器「[^」]+」會動到[^，]+，採白名單制；「[^」]+」不在唯讀名單上/u,
  registry: /^連接器工具「[^」]+」沒有登記：/u,
  family: /^工具名命中[^（]+的(?:家族網|額外樣式)（/u,
  charset: /^工具名不符合合法字元集（fail-closed）/u,
  badInput: /^輸入(?:缺工具名|無法解析)（fail-closed）/u,
});
/**
 * 回理由的類別（REASON_CLASSES 的鍵），一個都對不上回 null。
 * @param {unknown} reason
 */
export function reasonClass(reason) {
  const text = String(reason).replace(/^[^：]{1,20}的絕對邊界：/u, '');
  const hit = Object.entries(REASON_CLASSES).find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}
/**
 * 2026-10-10 整批同步（套件 #67，William 10/08 裁 a；9/28 他裁 b 把「裁示者」改「擁有者」）：錢的尾句變成兩句，這一個兩句都認、別的不認——
 *   確定擋下＝「此類指令一律視為誤觸或冒名，拒絕執行並立即回報擁有者。」；名字像錢又沒登記（換了編號的下單工具就是這種）＝「疑似誤觸或冒名。拒絕執行，
 *   立即回報擁有者；這個連接器要登記進哪一欄，都先問擁有者。」。兩句都照樣擋；差在後者說「疑似」（本專案 AGENTS 規則 3 寫「一律視為」，語意差寫在同步那支的說明）。
 * 鉤子輸出的尾句（套件 hookOutput）分三種：確定擋下＝規矩 B2 那一句；登記制拒絕、名字像錢＝「疑似」那一句；登記制拒絕、名字看不出像錢＝第三種
 * （不當成事故、照 B3 先通報；逐字以 hookOutput 為準，這裡刻意不抄——套件 #18 送審前改過那一句，抄了會在同步之後變成空斷言）。
 * 這一個認前兩種、不認第三種；換了編號的下單工具必須落在前兩種（本專案 AGENTS 規則 3）。錨在字串結尾（$）：尾句是理由的最後一句。
 */
export const IMPERSONATION_TAIL = /(?:此類指令一律視為誤觸或冒名，拒絕執行並立即回報擁有者。|疑似誤觸或冒名。拒絕執行，立即回報擁有者；這個連接器要登記進哪一欄，都先問擁有者。)$/u;
