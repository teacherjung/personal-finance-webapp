// 守禁區攔截器（規矩 B1）。原專案的禁區＝錢：連建單、試用都不行；規矩書擋不住誤觸，攔截擋得住。
//
// 守得到的：
//   ①輸入拿不到工具名、工具名不合法＝拒絕；②禁區清單沒設＝拒絕（裝了卻沒填比沒裝更危險）；
//   ③動禁區的連接器採白名單制；④逐字拒絕清單；⑤家族網（動詞名詞、名詞動詞、額外樣式），
//     ⚠️ 唯讀前綴的豁免範圍與代價＝`tools/forbidden-tools.js` 的「**兩張樣式表**」那一段（正本，這裡不重述）；
//     駝峰、點、連字號都正規化；
//     連接器前綴不同、工具名相同一起擋；
//   ⑥四份接線範本（Claude 活讀、Claude 釘指紋、Codex 專案層、Codex 全域層）都只呼叫同一支判斷（不抄判斷＝不會漂）；指令入口：壞輸入也拒絕、放行不印；
//   ⑩連接器在名字的任何一段都認得（多一層前綴照樣白名單制；邊界要真的是邊界）；
//   ⑪雙保險：唯讀名單誤放了動禁區的工具，家族網照樣擋；
//   ⑫接線範本真的跑一遍：從子目錄、別的專案起照樣判；找不到檔、沒有 node、載入就崩、Git 找不到工作樹根、清環境用的 env／sed 不在＝退 2 帶錯誤輸出
//     （Codex 全域層與 Claude 釘指紋這裡只守「範本原樣＝退 2」；複本、指紋、真的跑一遍在 tests/guard-copy.test.js、tests/guard-copy-claude.test.js）。
//   ⑦只填名字、沒有任何有效規則＝拒絕（r1 High③）；清單欄位型別錯＝拒絕；
//   ⑧連接器名含 __ 也比得到（r1 High④）；order__create 跟 order_create 是同一個字；
//   ⑨規則要合各欄位的文法：含空白、非法字元的規則不可能匹配合法工具名，留著只會把「有規則」判成真（r2 High②）＝拒絕。
// ⚠️ 守不到的：只認工具名不看參數；詞表沒列到的動詞或名詞擋不住；沒啟用的那一方等於沒有；
//   ⑫是用 /bin/sh 模擬鉤子，**這裡不證明真的 Claude Code／Codex session 有載入、有照做**（要由使用專案用測試鈕驗；
//     第一個使用專案 2026-09-16／17 兩家都驗過擋得住，放行面在 Codex 真對話還沒直接量）；鉤子逾時兩家都不擋。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decide, normalize, cli } = require('../tools/forbidden-tools.js');
const { gitEnv } = require('../tools/git-env.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const HOOK_TEMPLATES = ['hook-claude.json', 'hook-claude-pinned.json', 'hook-codex.json', 'hook-codex-global.json'];
const FAIL_CLOSED_TAIL = "|| { echo '禁區攔截器起不來（找不到檔、沒有 node、載入就崩）：一律當成拒絕' >&2; exit 2; }";
const FORBIDDEN = {
  name: '錢', servers: ['broker-x'], allowlist: ['get_account_balances', 'get_watchlist', 'create_alert'],
  // ⚠️ 逐字清單要放一個**家族網抓不到**的名字，不然拿掉逐字清單也照樣被擋、那道檢查等於沒考（突變驗過）
  deny: ['mcp__other__place_order_now', 'mcp__other__harmless_looking_tool'],
  verbs: ['create', 'place', 'submit', 'cancel', 'buy', 'sell', 'transfer'],
  nouns: ['order', 'trade', 'position', 'stock', 'fund'],
  readPrefixes: ['get', 'list', 'search', 'view'],
  patterns: ['(^|_)(withdraw|deposit)(_|$)'],
  // 「連唯讀前綴也擋」的那一組（裁示者 2026-09-24 裁庚）：動作字**緊接**錢名詞的精確片語。
  patternsReadSafe: ['(^|_)(convert|swap)_(fund|money|cash|crypto)s?(_|$)'],
};

test('①輸入不合法＝拒絕；②清單沒設＝拒絕', () => {
  assert.equal(decide(undefined, FORBIDDEN).deny, true);
  assert.equal(decide(42, FORBIDDEN).deny, true);
  assert.equal(decide('bad name with space', FORBIDDEN).deny, true);
  assert.equal(decide('x'.repeat(201), FORBIDDEN).deny, true);
  for (const bad of [{}, { name: '未設定' }, undefined]) {
    const d = decide('mcp__anything__get_something', bad);
    assert.equal(d.deny, true, JSON.stringify(bad));
    assert.match(d.why, /還沒填/u);
  }
});

test('⑦只填名字沒有規則＝拒絕；清單型別錯＝拒絕；額外樣式不是合法正規式＝拒絕', () => {
  const nameOnly = decide('mcp__vendor__create_order', { name: 'test zone' });
  assert.equal(nameOnly.deny, true, '只填名字等於沒填');
  assert.match(nameOnly.why, /沒有任何一條有效規則/u);
  assert.equal(decide('mcp__vendor__create_order', { name: 'x', servers: [], deny: [], verbs: [], nouns: [], patterns: [] }).deny, true);
  assert.equal(decide('mcp__vendor__anything', { name: 'x', servers: ['vendor'] }).deny, true, '只有連接器清單也算一條規則：白名單空＝全拒');
  assert.equal(decide('mcp__any__harmless', { name: 'x', deny: ['mcp__z'] }).deny, false, '有一條規則就正常判');
  for (const bad of [{ name: 'x', servers: 'broker' }, { name: 'x', deny: [1] }, { name: 'x', verbs: [['a']], nouns: ['b'] }]) {
    assert.equal(decide('mcp__any__harmless', bad).deny, true, JSON.stringify(bad));
  }
  assert.equal(decide('mcp__any__harmless', { name: 'x', patterns: ['('] }).deny, true, '壞正規式＝設定壞掉＝拒絕');
});

test('⑨不合文法的規則不算規則：空白項、含空白的連接器、含空白的逐字名，都讓整份設定判壞掉＝拒絕', () => {
  for (const bad of [
    { name: 'zone', servers: [' '] },
    { name: 'zone', servers: ['broker paper'] },
    { name: 'zone', deny: ['\t'] },
    { name: 'zone', deny: ['has space'] },
    { name: 'zone', verbs: ['Create'], nouns: ['order'] },   // 大寫不是正規化後的形狀
    { name: 'zone', verbs: ['create'], nouns: ['or der'] },
    { name: 'zone', readPrefixes: ['get_'] },
    { name: 'zone', patterns: ['a b'] },
  ]) {
    const d = decide('mcp__vendor__create_order', bad);
    assert.equal(d.deny, true, JSON.stringify(bad));
    assert.match(d.why, /設定壞掉|沒有任何一條有效規則/u);
  }
  // 「未設定」佔位值算沒填，不算壞：只剩它＝沒有規則＝拒絕；旁邊有真規則＝正常判
  assert.equal(decide('mcp__vendor__create_order', { name: 'zone', servers: ['未設定'] }).deny, true);
  assert.equal(decide('mcp__any__harmless', { name: 'zone', servers: ['未設定'], deny: ['mcp__z'] }).deny, false);
});

test('⑧連接器名含 __ 也比得到；分隔符的等價寫法一起擋', () => {
  const f = { name: '錢', servers: ['broker__paper'], allowlist: ['get_balance'] };
  assert.equal(decide('mcp__broker__paper__get_balance', f).deny, false);
  assert.equal(decide('mcp__broker__paper__market_order', f).deny, true, '登記名含 __ 時原本永遠比不到（r1 High④）');
  assert.equal(decide('mcp__broker__paper', f).deny, true, '只有連接器沒有工具名也拒絕');
  assert.equal(decide('mcp__brokerx__paper__get_balance', f).deny, false, '不是那個連接器就不套白名單');
  for (const t of ['mcp__any__order__create', 'mcp__any__create__order', 'mcp__any__order-create', 'mcp__any__create___order']) {
    assert.equal(decide(t, FORBIDDEN).deny, true, `${t} 是 create_order 的等價寫法`);
  }
});

test('③動禁區的連接器採白名單制：唯讀名單上的放行、其餘拒絕', () => {
  assert.equal(decide('mcp__broker-x__get_account_balances', FORBIDDEN).deny, false);
  assert.equal(decide('mcp__broker-x__create_alert', FORBIDDEN).deny, false, '名單上明列的准用');
  assert.equal(decide('mcp__broker-x__create_order_instruction', FORBIDDEN).deny, true);
  assert.equal(decide('mcp__broker-x__whats_new_today', FORBIDDEN).deny, true, '不在名單上就拒絕，不管名字多無害');
  assert.equal(decide('mcp__broker-x__get_account_balances__extra', FORBIDDEN).deny, true, '多一段就不是名單上那一個');
});

test('⑩連接器不在開頭那一段也要認得：多一層前綴照樣白名單制（搬家驗屋 09-13）', () => {
  // 原專案的探針搬過來、連接器換成考題的假名。market_order／limit_order／buy 家族網接不到（單側命名），
  // 所以只有「認出這是連接器」擋得住——原本只比開頭那一段，這三個全放行。
  for (const t of ['mcp__prefix__broker-x__market_order', 'mcp__a__broker-x__limit_order', 'mcp__x__broker-x__buy', 'mcp__a__b__broker-x__sell']) {
    assert.equal(decide(t, FORBIDDEN).deny, true, `${t}：連接器在第二段以後也是那個連接器`);
    assert.equal(decide(t.replace(/^mcp__[^_]+(?:__[^_]+)?__broker-x__/u, 'mcp__other__'), FORBIDDEN).deny, false, `對照組：同一個工具名不在連接器底下，家族網接不到＝放行（${t}）`);
  }
  assert.equal(decide('mcp__x___broker-x__market_order', FORBIDDEN).deny, true, '三個底線：邊界照樣認得（寧可認成連接器）');
  assert.equal(decide('mcp__a__broker-x', FORBIDDEN).deny, true, '多一層前綴、沒有工具名＝拒絕');
  assert.equal(decide('mcp__p__broker__paper__market_order', { name: '錢', servers: ['broker__paper'], allowlist: ['get_balance'] }).deny, true, '登記名含 __ 又多一層前綴');
  // 反向對照組：多一層前綴下，名單內的唯讀工具照常放行（不可以退化成「不在開頭就一律拒絕」）
  for (const t of ['mcp__prefix__broker-x__get_account_balances', 'mcp__a__broker-x__create_alert']) {
    assert.equal(decide(t, FORBIDDEN).deny, false, `${t}：名單內要放行`);
  }
  // 邊界要真的是邊界：名字只是「包含」連接器名，不算那個連接器
  for (const t of ['mcp__xbroker-x__market_order', 'mcp__broker-xy__market_order', 'mcp__a__broker-x_v2__market_order']) {
    assert.equal(decide(t, FORBIDDEN).deny, false, `${t}：不是那個連接器（家族網也接不到）`);
  }
});

test('⑪雙保險：唯讀名單誤放了動禁區的工具，家族網照樣擋（搬家驗屋 09-13）', () => {
  const misfilled = { ...FORBIDDEN, allowlist: [...FORBIDDEN.allowlist, 'create_order_instruction'] };
  assert.equal(decide('mcp__broker-x__create_order_instruction', misfilled).deny, true, '名單上有它，家族網還是要擋');
  assert.equal(decide('mcp__prefix__broker-x__create_order_instruction', misfilled).deny, true, '多一層前綴也一樣');
  assert.equal(decide('mcp__broker-x__get_watchlist', misfilled).deny, false, '對照組：名單內、家族網接不到的照常放行');
  // ⚠️ **這一顆是「雙保險」真正該接住的那一種**（2026-09-24 全庫護欄稽核抓到）：
  //    沿革與現行範圍＝「**兩張樣式表**」那一段。當時誤填進唯讀名單的 `view_create_order`
  //    一路放行——上面那句「雙保險」對它是假的。舊版這一行會紅。
  const 誤填唯讀開頭 = { ...FORBIDDEN, allowlist: [...FORBIDDEN.allowlist, 'view_create_order'] };
  assert.equal(decide('mcp__broker-x__view_create_order', 誤填唯讀開頭).deny, true,
    '唯讀前綴開頭也一樣：名單誤填了它，家族網要接住');
});

test('⑫「動作名」不因為前面掛了查詢字就放行：命中**家族網**就擋（範圍＝「兩張樣式表」）', () => {
  // ## 這一題在防什麼
  // 這一題守的是「**兩張樣式表**」那一段裡「家族網不豁免」那一列。
  // ⚠️ 下面那句「完全不受檢查」講的是**修正前**的行為（r6 #3 抓到它讀起來跟上一行相反）。
  // 於是 `view_create_order` 這種「查詢的皮、下單的骨」完全不受檢查。
  // ⚠️ 這一題自己就是那個破口的絆線：把那個無條件 `continue` 放回去，下面每一發都會紅。
  for (const t of ['view_create_order', 'get_place_trade', 'list_cancel_position', 'search_submit_stock',
    'view_order_create']) {
    assert.equal(decide(`mcp__any__${t}`, FORBIDDEN).deny, true, `${t}：唯讀前綴不可以替動作名脫罪`);
  }
  // ── 以下兩組都是**現況特徵測試（現況／待裁）**，不是安全規格 ───────────────────────
  // ⚠️ **它們證明的是「這一版是這樣」，不證明「這樣是安全的」**（#641 r1 #4）。
  //    將來裁准收緊時，**應該同步改掉這幾行**——不可以拿「考題紅了」當理由拒絕安全修正。
  //
  // 現況 A：對應「**兩張樣式表**」那一段的 `patterns` 那一列。
  //   ⚠️ **本檔夾具的樣式是 `(^|_)(withdraw|deposit)(_|$)`——它要詞界**，不是「出現就算」
  //      （掃描 #1 更正我上一版的寫法：`withdrawal`／`get_withdrawing`／`prewithdraw`
  //       就算清空唯讀前綴也仍然放行）。
  //   ⚠️ **「拆掉閥會誤擋 `get_transfer_log`」那句話是正式設定的後果，不是本夾具的**
  //      （掃描 #1 抓到我又把兩份設定混在一起）：本夾具把 `transfer` 列為**動詞**、
  //      樣式裡也沒有 `transfer` ⇒ 清空 `readPrefixes` 之後 `get_transfer_log` 在這裡**仍然放行**。
  //      正式設定才有那一條，`test/money-kit-hook.test.js` 的矩陣也在那邊要求它放行。
  for (const t of ['search_withdraw', 'get_deposit']) {
    assert.equal(decide(`mcp__any__${t}`, FORBIDDEN).deny, false,
      `${t}：命中本夾具的額外樣式、沒命中家族網 ⇒ **目前**仍放行（現況，非安全保證；要收＝拆 patterns＝動判準，待裁）`);
  }
  assert.equal(decide('mcp__any__withdraw', FORBIDDEN).deny, true, '對照：沒有唯讀前綴時，額外樣式照擋');
  assert.equal(decide('mcp__any__get_withdrawing', { ...FORBIDDEN, readPrefixes: [] }).deny, false,
    '對照（掃描 #1）：樣式要詞界——`get_withdrawing` 連把前綴表清空都不中，所以它不是靠「兩張樣式表」的那個閥才放行的');

  // 現況 B：**本支新造出來的拒絕面**（#641 r1 #3 找到、我逐一複驗；主幹放行、本版拒絕）。
  //   這幾個都是**合理的唯讀名字**，被擋是本支偏安全的取捨要付的代價，不是「零代價」。
  //   釘在這裡是為了讓代價**看得見**：哪天判準改了、或誰想放寬，這幾行會先紅、逼人正面處理。
  //   ⚠️ **用本檔夾具真的成立的例子**：審查者舉的 `list_open_positions`／`get_closed_positions`
  //      是**正式設定**才擋（`open`／`close` 在正式動詞表裡、夾具沒有），已另外直接呼叫 `decide()`
  //      對正式設定複驗過——**兩份設定不可互換當證據**（#641 r1 #4 點名，我在這裡又差點犯一次）。
  for (const t of ['buy_orders_get', 'sell_trades_view']) {
    assert.equal(decide(`mcp__any__${t}`, FORBIDDEN).deny, true, `${t}：對照——不帶唯讀前綴時本來就擋`);
  }
  for (const t of ['get_buy_orders', 'view_sell_trades']) {
    assert.equal(decide(`mcp__any__${t}`, FORBIDDEN).deny, true,
      `${t}：本支**新增**的拒絕（主幹放行）。「查我的買單」是合理的唯讀名字，屬刻意付出的誤擋代價（現況，踩到照裁示流程處理）`);
  }
  // ⚠️ **對照組（沒有這幾發，上面那七發證明不了「不是全部都擋」）**：真正的唯讀名字仍要放行，
  //    否則這一題可以靠「把所有唯讀前綴的東西都擋掉」作弊通過。
  for (const t of ['get_order', 'list_positions', 'search_stocks', 'view_trade_history', 'get_account_balances']) {
    assert.equal(decide(`mcp__any__${t}`, FORBIDDEN).deny, false, `${t}：真的唯讀工具不可以被誤擋`);
  }
  // 訊息要說得出「有唯讀前綴、但不算數」，否則踩到的人看不懂為什麼一個 get_ 開頭的東西被擋
  assert.match(decide('mcp__any__view_create_order', FORBIDDEN).why, /唯讀前綴不替它脫罪/u);
  assert.doesNotMatch(decide('mcp__any__create_order', FORBIDDEN).why, /唯讀前綴/u, '沒有唯讀前綴的不要多印那句');
});

test('④逐字拒絕清單；⑤家族網與唯讀前綴；駝峰、點、連字號正規化', () => {
  assert.equal(decide('mcp__other__place_order_now', FORBIDDEN).deny, true, '逐字在清單上');
  assert.equal(decide('mcp__other__harmless_looking_tool', FORBIDDEN).deny, true, '逐字在清單上，家族網抓不到它——只有逐字清單擋得住');
  assert.equal(decide('mcp__other__harmless_looking_tool_v2', FORBIDDEN).deny, false, '逐字就是逐字，不做前綴比對');
  // ⚠️ 唯讀前綴只認**開頭**：中段或尾段出現 get 不可以替前面的動詞名詞脫罪。
  // ⚠️ **原本這裡寫「突變驗過：不錨定開頭的話這一個會被放行」——2026-09-24 收緊之後那句已失效**
  //    （#641 r2 #1 抓到）：這一行現在根本不吃家族網豁免，把 `readRe` 的 `^` 拿掉，這一題照樣 pass。
  //    真正守那件事的是題名關鍵字「不因為前面掛了查詢字就放行」那一題（K3 指路：
  //    r3／r4 都抓到我原本寫「下面的 ⑫」——方向錯（它在上面），而且下面另有一題也叫 ⑫）。
  //    這一行留著只是「唯讀字在後面不算唯讀」的例子。
  assert.equal(decide('mcp__any__create_order_get_confirmation', FORBIDDEN).deny, true, '唯讀字在後面不算唯讀');
  for (const t of ['mcp__any__create_order', 'mcp__any__order_create', 'mcp__any__placeOrder', 'mcp__any__submit-trade', 'mcp__any__sell.stock', 'mcp__any__cancel_open_position', 'mcp__any__transfer_funds', 'mcp__any__withdraw_cash']) {
    assert.equal(decide(t, FORBIDDEN).deny, true, `${t} 應該被擋`);
  }
  for (const t of ['mcp__any__get_order', 'mcp__any__list_positions', 'mcp__any__search_stocks', 'mcp__any__view_trade_history', 'mcp__any__summarize_report', 'mcp__any__create_note']) {
    assert.equal(decide(t, FORBIDDEN).deny, false, `${t} 不該被擋`);
  }
  assert.equal(normalize('placeOrderNow'), 'place_order_now');
  assert.equal(normalize('HTTPOrder'), 'http_order');
  assert.equal(normalize('a.b-c'), 'a_b_c');
});

test('⑬兩張樣式表照正本的分工生效（裁示者 2026-09-24 裁庚）', () => {
  // ## 為什麼要兩張表
  // 為什麼要兩張表、哪一張吃豁免、代價與射程＝「**兩張樣式表**」那一段（正本）。**這裡不重述。**
  // 下面的輸入與斷言才是這一題的內容。
  //
  // ⚠️ **這一題也是「不可能變鬆」那個結構性質的絆線**（見下面第三段）。

  // ①有唯讀前綴時，`patternsReadSafe` 仍然擋
  // ⚠️ 四發都必須真的帶**本夾具的**唯讀前綴（`get`／`list`／`search`／`view`）——
  //    原本第四發寫 `download_swap_cash`，`download` 不在本夾具的前綴表裡 ⇒ 它證明不了「有前綴也擋」（r4 #1）。
  for (const t of ['get_convert_funds', 'view_swap_crypto', 'list_convert_money', 'search_swap_cash']) {
    assert.equal(decide(`mcp__any__${t}`, FORBIDDEN).deny, true, `${t}：patternsReadSafe 連唯讀前綴也要擋`);
  }
  // ②對應「**兩張樣式表**」那一段的 `patterns` 那一列（`get_transfer_log` 不被誤擋的原因）
  for (const t of ['search_withdraw', 'get_deposit']) {
    assert.equal(decide(`mcp__any__${t}`, FORBIDDEN).deny, false, `${t}：patterns 那一張仍吃豁免（現況，見上面 ⑫）`);
  }
  // ③**沒有唯讀前綴時，兩張表的聯集一律生效**——這是「不可能變鬆」的那一半：
  //   拆表之前那五條全部無條件生效，拆完之後沒有前綴的路徑跑的是聯集 ⊇ 原本五條。
  for (const t of ['withdraw', 'deposit', 'convert_funds', 'swap_crypto']) {
    assert.equal(decide(`mcp__any__${t}`, FORBIDDEN).deny, true, `${t}：沒有唯讀前綴 ⇒ 兩張表都要生效`);
  }
  // ④**空的新表不可以讓判斷變寬**（相容性：別處的夾具沒填這一欄）
  const 沒填 = { ...FORBIDDEN };
  delete 沒填.patternsReadSafe;
  // ⚠️ **兩條路都要走**（r4 #1：原本只測「本來就不命中」的名字 ⇒ 突變成「缺欄就放行」仍全綠；
  //    r5 #1：只測「缺欄」還不夠 ⇒ 突變成「**明填空陣列**就放行」也仍全綠。
  //    明填 `[]` 不是杜撰的非法設定——本倉庫 `tests/filled-settings.test.js` 就是明填 `[]`）。
  const 空表 = { ...FORBIDDEN, patternsReadSafe: [] };
  for (const [名, 設定] of [['缺欄', 沒填], ['明填空陣列', 空表]]) {
    assert.equal(decide('mcp__any__create_order', 設定).deny, true, `${名}時，家族網照樣要擋（不可以變成全部放行）`);
    assert.equal(decide('mcp__any__withdraw', 設定).deny, true, `${名}時，舊 patterns 照樣要擋`);
    assert.equal(decide('mcp__any__get_convert_funds', 設定).deny, false, `${名}＝回到舊行為（前綴豁免），不是報錯`);
    assert.equal(decide('mcp__any__convert_funds', 設定).deny, false, `${名}時 convert_funds 不在舊 patterns 裡 ⇒ 放行（對照組，證明上面那發不是碰巧）`);
  }
  // ⑤新表壞掉＝設定壞掉＝拒絕（fail-closed，跟舊表同一個口徑）
  assert.equal(decide('mcp__any__harmless', { ...FORBIDDEN, patternsReadSafe: ['('] }).deny, true, '新表是壞正規式＝拒絕');
  assert.equal(decide('mcp__any__harmless', { ...FORBIDDEN, patternsReadSafe: 'not-an-array' }).deny, true, '新表不是陣列＝拒絕');
  // ⚠️ **非法陣列項也要擋**（r4 #1：我原本只測壞正規式與非陣列 ⇒ 跳過新欄的 GRAMMAR 驗證仍全綠）：
  //    `'a b'` 可以編譯成正規式，但不合這一欄的文法（不准有空白）。
  assert.equal(decide('mcp__any__harmless', { ...FORBIDDEN, patternsReadSafe: ['a b'] }).deny, true, '新表有不合文法的項＝拒絕');
  assert.equal(decide('mcp__any__harmless', { ...FORBIDDEN, patternsReadSafe: [123] }).deny, true, '新表有非字串項＝拒絕');
  // ⚠️ **兩種「常見的容錯改法」會靜靜取消這裡承諾的 fail-closed，各放過兩個壞值**（r6 #2；r8 #3 抓到我這句寫成「四種改法」）：
  //    ・把 falsy 當缺欄（`if (!f[key]) return [];`）⇒ `''`、`null` 被放過
  //    ・把非法空項靜靜清掉（`.map(x => x.trim()).filter(Boolean)`）⇒ `[' ']`、`['']` 被放過
  //    對照名字用 `harmless`（不被任何其他規則碰巧擋住），所以紅一定是因為「壞設定沒被擋」。
  for (const 壞 of ['', null, [' '], ['']]) {
    assert.equal(decide('mcp__any__harmless', { ...FORBIDDEN, patternsReadSafe: 壞 }).deny, true,
      `新表是 ${JSON.stringify(壞)} ＝壞設定，一律拒絕（fail-closed）`);
  }
  // ⚠️ **第三種退化**（r7 #2）：只 `trim()` 每一項、**不刪空項** ⇒ 把本來不合法的
  //    「非空但帶前後空白」的項靜靜正規化成合法 regex。`[' ']` 變 `['']` 仍被 GRAMMAR 擋、
  //    `['a b']` 內部有空白也仍被擋 ⇒ 上面四發都辨別不出來。
  for (const 壞 of [[' unrelated '], ['\tunrelated\t']]) {
    assert.equal(decide('mcp__any__harmless', { ...FORBIDDEN, patternsReadSafe: 壞 }).deny, true,
      `新表有「非空但帶前後空白」的項 ${JSON.stringify(壞)} ＝壞設定，一律拒絕（不可以靜靜 trim 成合法）`);
  }
  // ⚠️ **第四種退化**（r8 #2）：把佔位值的**精確相等**改成**包含判斷**
  //    （`filter((x) => x !== UNSET)` → `filter((x) => !x.includes(UNSET))`）
  //    ⇒ 非法項先被刪掉，後面的文法與編譯驗證就看不到它。
  //    下面兩發是「**含佔位文字、但不等於佔位值**」的壞設定，精確相等會擋、包含判斷會放行。
  for (const 壞 of [['未設定('], [' 未設定 ']]) {
    assert.equal(decide('mcp__any__harmless', { ...FORBIDDEN, patternsReadSafe: 壞 }).deny, true,
      `新表有 ${JSON.stringify(壞)}（含佔位文字但不等於它）＝壞設定，一律拒絕`);
  }
  // 對照：`['未設定']` 是既有的合法佔位語意，**不可以**被當成壞設定
  assert.equal(decide('mcp__any__harmless', { ...FORBIDDEN, patternsReadSafe: ['未設定'] }).deny, false,
    '佔位值是合法的，不可以誤判成壞設定（對照組，證明上面那四發不是靠「一律拒絕」作弊）');
  // ⑥只填新表也算「有規則」（不可以因為舊表空了就當成沒設清單）
  // ⚠️ **必須有對照組**（r4 #1 抓到）：只斷言「命中者被擋」的話，`hasRule` 那個條件被拿掉時
  //    會走 fail-closed（沒規則＝一律拒絕），命中者照樣被擋 ⇒ **fail-closed 冒充了「新表生效」**。
  //    加上「不命中者要放行」才分得出「真的有規則」與「當成沒規則所以全擋」。
  const 只有新表 = { name: '錢', patternsReadSafe: ['(^|_)convert_funds(_|$)'] };
  assert.equal(decide('mcp__any__convert_funds', 只有新表).deny, true, '只有新表也要生效');
  assert.equal(decide('mcp__any__harmless', 只有新表).deny, false,
    '同一份設定下不命中者必須放行——這一發才證明是「新表生效」而不是「當成沒有規則所以全擋」');
});

// ⚠️ **巢狀整卷裡跳過**（跟 `tests/filled-settings.test.js` 同一個旗標）：那份複本只帶
//    `tools`／`tests`／`templates` 三個目錄、也沒有 `node_modules`。①全庫散文掃描在部分複本裡
//    **本來就沒有意義**（`AGENTS.md`、`test/`、`docs/` 都不在，會空跑成假綠）②`typescript` 載不進來。
//    真正的一輪＝倉庫根目錄那次 `npm test`，那一次它一定跑。
test('⑭ 只有一份：這個機制的現在式描述只准住在正本，別處一律指路（#641 r7 的 F10：邊界問解析器）',
  { skip: process.env.KIT_NESTED_SUITE === '1' ? '巢狀複本只帶部分檔案、且無 node_modules ⇒ 全庫散文掃描沒有意義' : false }, () => {
  // ## 這一題在防什麼
  //
  // #641 改過兩次行為。**前四輪複審＋一次掃描，每一輪都有一條發現是同一件事**：
  // 我改了行為，別處的說明還用現在式留在原地。原因不是忘記 grep，是同一句話被寫在九個地方。
  // 本倉庫早有這條規矩（RULES K1／K3）：**正本只有一份，別處只指路**。這一題把它變成機器。
  //
  // ## ⚠️ 邊界不自己算，問解析器（r5→r6→r7 連三輪被打穿之後的 F10 換法）
  //
  // 我原本用「行」當單位判「這一行在不在正本註解裡」——那是**手寫一個 JS 註解剖析器**。
  // 三輪三種打法：①排除整支正本檔 ②`*/` 要獨佔一行 ③**整行**排除（`*/ // 重述`）、
  // `*//* 重述 */`、標題行自己結束註解、假的早期標題、連字串字面值裡的標題都能擴張免檢範圍。
  // ⇒ 單位錯了：**註解的邊界是字元位置，不是行號**。改成用 `ts` 取註解範圍、比對命中的字元位置。
  //
  // ⚠️ **這一題的射程沒有因此變大**（三條照舊）：
  //    ①它認的是「機制字＋動作字同一行」⇒ **換句話說重述抓不到**。
  //    ②**指路詞是全域豁免**：任何受管行帶上「兩張樣式表」就免檢，**含錯誤的重述**。
  //    ③範圍只到「已追蹤的 js／md／json、排除 data」；不讀 PR 說明，讀檔失敗直接略過。
  //       「受管檔數 > 50」證明不了完整性。解析器只回答「哪裡是註解」，不判斷語意。
  const { execFileSync } = require('node:child_process');
  const { readFileSync } = require('node:fs');
  const { join, dirname } = require('node:path');
  const ts = require('typescript');
  const ROOT = join(dirname(__filename), '..');
  const 正本檔 = 'tools/forbidden-tools.js';
  const 指路詞 = '兩張樣式表';
  const 標題 = '## 兩張樣式表';
  const 機制 = /唯讀[^，。、\n]{0,4}前綴/gu;
  const 動作 = /豁免|跳過/u;
  const 違規 = (line) => 機制.test(line) && 動作.test(line) && !line.includes(指路詞);

  // ⓪偵測器自我測試（含**指路詞豁免那條分支**——r5 #3 抓到前三發測不到它）
  assert.equal(違規('唯讀前綴會跳過額外樣式那一道'), true, '偵測器對「重述」要回 true');  // 兩張樣式表
  assert.equal(違規(`唯讀前綴的範圍＝見「${指路詞}」`), false, '偵測器對「指路」要回 false');
  assert.equal(違規('這一行跟這個機制無關'), false, '偵測器不可以亂抓');
  assert.equal(違規(`唯讀前綴會跳過額外樣式那一道（見「${指路詞}」）`), false,  // 兩張樣式表
    '同時有機制字、動作字與指路詞 ⇒ 放行（刻意的全域豁免，見上面射程②）');

  /** 用解析器取出一份原始碼裡所有註解的字元範圍。 */
  const 註解範圍 = (src) => {
    const out = [];
    const sc = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src);
    for (let k = sc.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = sc.scan()) {
      if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) {
        out.push([sc.getTokenStart(), sc.getTokenEnd()]);
      }
    }
    return out;
  };

  // ①正本必須是**剛好一個**帶那個標題的註解（這一步同時驗起點：
  //   假的早期標題會變成兩個 ⇒ 這裡先紅；字串字面值不是註解 ⇒ 不會被當起點）
  const 正本原文 = readFileSync(join(ROOT, 正本檔), 'utf8');
  const 帶標題的註解 = 註解範圍(正本原文).filter(([a, b]) => 正本原文.slice(a, b).includes(標題));
  assert.equal(帶標題的註解.length, 1,
    `${正本檔} 裡帶「${標題}」的**註解**要剛好一個，實得 ${帶標題的註解.length} 個 ⇒ 正本起點不唯一，免檢範圍算不準`);
  const [免檢起, 免檢迄] = 帶標題的註解[0];

  // ②受版控的文字檔一律只准指路；正本檔只有**那個註解節點的字元範圍內**免檢
  const 受管 = execFileSync('git', ['ls-files'], { cwd: ROOT, env: gitEnv(), encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && /\.(js|md|json)$/u.test(f) && !f.startsWith('data/'));
  assert.ok(受管.length > 50, `只列到 ${受管.length} 個檔，git ls-files 壞了？`);
  const 犯規 = [];
  for (const f of 受管) {
    let txt;
    try { txt = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    機制.lastIndex = 0;
    for (let m = 機制.exec(txt); m; m = 機制.exec(txt)) {
      if (f === 正本檔 && m.index >= 免檢起 && m.index < 免檢迄) continue;   // 註解節點內：這裡才准用現在式
      const 行首 = txt.lastIndexOf('\n', m.index) + 1;
      let 行尾 = txt.indexOf('\n', m.index); if (行尾 < 0) 行尾 = txt.length;
      const line = txt.slice(行首, 行尾);
      if (!動作.test(line) || line.includes(指路詞)) continue;
      const n = txt.slice(0, 行首).split('\n').length;
      const 記 = `${f}:${n}　${line.trim().slice(0, 70)}`;
      if (!犯規.includes(記)) 犯規.push(記);
    }
  }
  assert.deepEqual(犯規, [],
    `這些地方重述了「唯讀前綴豁免到哪一道」，而正本在 ${正本檔} 的「兩張樣式表」那一段。\n`
    + `**改成指路**（句子裡帶上那個關鍵字），不要在這裡重寫一份會漂的副本：\n`
    + 犯規.join('\n'));
});

test('⑤連接器前綴不同、工具名相同也一起擋（尾段逐一試）', () => {
  assert.equal(decide('mcp__vendor__sub__create_order', FORBIDDEN).deny, true);
  assert.equal(decide('mcp__vendor__get__create_order', FORBIDDEN).deny, true, '中段的唯讀字不可以替尾段脫罪');
});

test('⑥四份接線範本都只呼叫同一支判斷，範本裡不抄判斷；起不來的尾巴一致', () => {
  for (const f of HOOK_TEMPLATES) {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', f), 'utf8'));
    const cmds = doc.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => x.command));
    assert.equal(cmds.length, 1, `${f} 要剛好一條指令`);
    assert.equal(cmds[0].split('tools/forbidden-tools.js').length, 2, `${f} 要呼叫同一支、而且只呼叫一次`);
    // 全域層在尾巴之後還有一截「拒絕改退 2」（tests/guard-copy.test.js 真的跑過），所以這裡看「剛好一個」，不看「結尾是」
    assert.equal(cmds[0].split(FAIL_CLOSED_TAIL).length, 2, `${f} 要剛好一個把起不來轉成退 2 的尾巴`);
    if (f !== 'hook-codex-global.json') assert.ok(cmds[0].endsWith(FAIL_CLOSED_TAIL), `${f} 的尾巴要把起不來轉成退 2`);
    assert.ok(!JSON.stringify(doc).includes('python3'), `${f} 不可以自己抄一份判斷`);
    // PreToolUse 以外的鉤子（Claude 釘指紋那份另帶一組設定變更攔截）不可以碰判斷：判斷只在工具被呼叫的那一刻跑
    const others = Object.entries(doc.hooks).filter(([event]) => event !== 'PreToolUse').flatMap(([, groups]) => groups.flatMap((h) => h.hooks.map((x) => x.command)));
    for (const c of others) assert.ok(!c.includes('forbidden-tools'), `${f} 的其他鉤子不可以呼叫判斷`);
  }
});

test('⑫接線範本真的跑一遍：不管從哪個目錄起、起不來一律擋（搬家驗屋 09-13）', () => {
  // 原本三份範本都是 node tools/forbidden-tools.js（相對路徑）：鉤子在 AI 當下所在的目錄執行，
  // 從子目錄或別的專案起就找不到檔、退 1——兩家 AI 都把退 1 當「不擋」。
  const cmd = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', f), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-hook-'));
  const proj = path.join(scratch, 'proj');
  const elsewhere = path.join(scratch, 'elsewhere');
  const broken = path.join(scratch, 'broken');
  try {
    for (const dir of [proj, broken]) {
      fs.cpSync(path.join(__dirname, '..', 'tools'), path.join(dir, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ forbidden: FORBIDDEN }));
    }
    fs.mkdirSync(elsewhere);
    // 載入就崩的那一份：根目錄宣告 type:module、工具目錄的宣告拿掉
    fs.writeFileSync(path.join(broken, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.rmSync(path.join(broken, 'tools', 'package.json'));
    for (const dir of [proj, broken]) {
      const git = spawnSync('git', ['init', '-q'], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
      assert.equal(git.status, 0, `前提：暫存專案要是版本控制目錄（${git.stderr}）`);
    }
    const notRepo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: elsewhere, env: gitEnv(), encoding: 'utf8' });
    assert.notEqual(notRepo.status, 0, '前提：另一個目錄不在任何版本控制目錄裡');

    const base = gitEnv();
    delete base.CLAUDE_PROJECT_DIR;
    const sh = (command, { cwd, env = {}, tool = 'mcp__prefix__broker-x__market_order' }) =>
      spawnSync('/bin/sh', ['-c', command], { cwd, env: { ...base, ...env }, input: JSON.stringify({ tool_name: tool }), encoding: 'utf8' });
    const denies = (r, why) => {
      assert.equal(r.status, 0, `${why}：${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', why);
    };
    const blocks = (r, why) => {
      assert.equal(r.status, 2, `${why}：退出碼 ${r.status}（${r.stderr}）`);
      assert.equal(r.stdout, '', why);
      assert.match(r.stderr, /起不來/u, `${why}：退 2 要帶錯誤輸出（Codex 要有才擋）`);
    };
    const subdir = path.join(proj, 'tools');

    // 環境裡的 GIT_DIR 指向另一個清單很鬆的倉庫：找根目錄前沒清的話會讀到它的清單而放行（搬家修正 r1 T5）
    const loose = path.join(scratch, 'loose');
    fs.cpSync(path.join(__dirname, '..', 'tools'), path.join(loose, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(loose, 'settings.json'), JSON.stringify({ forbidden: { name: '錢', deny: ['mcp__z__only'] } }));
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: loose, env: gitEnv(), encoding: 'utf8' }).status, 0);
    const looseEnv = { GIT_DIR: path.join(loose, '.git'), GIT_WORK_TREE: loose };
    const withoutClearing = (command) => command.replace(/^root="\$\(.*?git rev-parse/u, 'root="$(git rev-parse');
    /** 只放 node、git、env、sed 四支（少一支就不放）的 PATH：其他一概找不到。 */
    const binWithout = (missing) => {
      const bin = fs.mkdtempSync(path.join(scratch, 'bin-'));
      for (const tool of ['node', 'git', 'env', 'sed']) {
        if (tool === missing) continue;
        const real = tool === 'node' ? process.execPath : spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        assert.ok(real, `前提：找得到 ${tool}`);
        fs.symlinkSync(real, path.join(bin, tool));
      }
      return bin;
    };

    // Claude 側與 Codex 專案層現在是同一招（問版本控制根目錄）：平台給的專案目錄變數跟著「從哪個目錄開 Claude」走
    //（2026-09-16 實測從子目錄開＝指到子目錄），所以這裡刻意**不給**那個變數、也給一個指到別處的，結果都要一樣
    for (const [f, who] of [['hook-claude.json', 'Claude'], ['hook-codex.json', 'Codex 專案層']]) {
      const command = cmd(f);
      denies(sh(command, { cwd: subdir }), `${who}：從子目錄起`);
      denies(sh(command, { cwd: subdir, env: { CLAUDE_PROJECT_DIR: elsewhere } }), `${who}：平台的專案目錄變數指到別處也不理它`);
      const allowed = sh(command, { cwd: subdir, tool: 'mcp__broker-x__get_watchlist' });
      assert.deepEqual([allowed.status, allowed.stdout], [0, ''], `${who} 對照組：該放行的照樣放行（尾巴不可以把放行變成擋）`);
      const viaLoose = sh(withoutClearing(command), { cwd: subdir, env: looseEnv });
      assert.deepEqual([viaLoose.status, viaLoose.stdout], [0, ''], `${who} 對照組：不清環境的寫法真的會讀到鬆的清單而放行`);
      denies(sh(command, { cwd: subdir, env: looseEnv }), `${who}：環境指向別的倉庫也照自己的清單判`);
      blocks(sh(command, { cwd: elsewhere }), `${who}：不在版本控制目錄裡`);
      blocks(sh(command, { cwd: subdir, env: { PATH: elsewhere } }), `${who}：找不到 node 與 git`);
      // 清環境用的 env／sed 不在、但 node 與 git 都在：清不掉就不可以往下問根目錄（不然環境指向別的倉庫時會讀到它的清單而放行）
      blocks(sh(command, { cwd: subdir, env: { PATH: binWithout('env'), ...looseEnv } }), `${who}：沒有 env`);
      blocks(sh(command, { cwd: subdir, env: { PATH: binWithout('sed'), ...looseEnv } }), `${who}：沒有 sed`);
      denies(sh(command, { cwd: subdir, env: { PATH: binWithout(null), ...looseEnv } }), `${who} 對照組：四支工具都在、環境指向別的倉庫也照自己的清單判`);
      blocks(sh(command, { cwd: broken }), `${who}：攔截器載入就崩`);
    }

    // 全域層讀固定複本、指令裡寫死指紋（裁示 6a＋7b）：真的跑一遍的題在 tests/guard-copy.test.js；這裡只守範本原樣＝擋
    const global = cmd('hook-codex-global.json');
    for (const ph of ['{copyDir}', '{files}', '{fingerprint}']) assert.equal(global.split(ph).length, 2, `全域層要剛好留一個 ${ph} 給 tools/guard-copy.js 填`);
    const raw = sh(global, { cwd: elsewhere });
    assert.deepEqual([raw.status, raw.stdout], [2, ''], `Codex 全域層：佔位沒換＝退 2（${raw.stderr}）`);
    assert.match(raw.stderr, /指紋對不上/u, 'Codex 全域層：退 2 要帶錯誤輸出');

    // Claude 側釘指紋裝法同一招（只寫指紋、複本的位置從 HOME 算）：真的跑一遍的題在 tests/guard-copy-claude.test.js；這裡只守範本原樣＝擋。
    // HOME 指到空的暫存目錄：不可以去看真的家目錄
    const pinned = cmd('hook-claude-pinned.json');
    for (const ph of ['{files}', '{fingerprint}']) assert.equal(pinned.split(ph).length, 2, `Claude 釘指紋要剛好留一個 ${ph} 給 tools/guard-copy.js 填`);
    assert.ok(!pinned.includes('{copyDir}'), 'Claude 釘指紋那一行跨機器共用：不可以有複本路徑的佔位');
    const rawPinned = sh(pinned, { cwd: subdir, env: { HOME: elsewhere } });
    assert.deepEqual([rawPinned.status, rawPinned.stdout], [2, ''], `Claude 釘指紋：佔位沒換＝退 2（${rawPinned.stderr}）`);
    assert.match(rawPinned.stderr, /指紋對不上/u, 'Claude 釘指紋：退 2 要帶錯誤輸出');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('指令入口：壞輸入也拒絕；放行不印任何東西；輸出是鉤子認得的形狀', () => {
  const settings = { forbidden: FORBIDDEN };
  const denied = cli(JSON.stringify({ tool_name: 'mcp__any__create_order' }), settings);
  const parsed = JSON.parse(denied.output);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /錢的絕對邊界/u);
  assert.equal(cli(JSON.stringify({ tool_name: 'mcp__any__get_order' }), settings).output, '', '放行不印');
  assert.equal(JSON.parse(cli('not json', settings).output).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(cli(JSON.stringify({}), settings).output).hookSpecificOutput.permissionDecision, 'deny');
  // 真的跑一遍（在複本裡，不讀本倉庫那份）：空白設定＝一律拒絕；填了清單＝照清單判。
  // 兩種設定結果不同，才證明指令入口真的讀了給它的那份（填了真設定的專案跑這題也照樣綠）
  const probe = JSON.stringify({ tool_name: 'mcp__any__get_order' });
  const r = runInCopy('tools/forbidden-tools.js', [], { input: probe });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /還沒填/u);
  const filled = runInCopy('tools/forbidden-tools.js', [], { input: probe, settings: { forbidden: FORBIDDEN } });
  assert.deepEqual([filled.status, filled.stdout], [0, ''], '對照組：填了清單、唯讀工具放行');
});
