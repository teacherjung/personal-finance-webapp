// 預設名單（規矩 B1）：專案 settings.json 的 forbidden 裡「擋的方向」那六個清單都要至少包含空白範本
// tests/helpers/unfilled-settings.json 的同名清單（逐字）；「放行方向」那三個不比（裁示者 2026-09-27，見 RESTRICTIVE）。
//
// 為什麼（裁示者 2026-09-26／27 原話：「我們可以有預設名單，這樣就不用同一個連接器每個專案都要填寫一遍」、
// 「錢的攔截器禁區，應該是不管哪個專案都要一樣才是！」）：預設住在空白範本裡——新專案抄它就有；套件同步進每個專案時
// 這一題跟著過去、在那邊守。沒有這一題，專案自己刪掉一個預設字、或同步時漏了套件新加的預設，沒有任何東西會紅
// ——攔截器只讀專案那一份清單，範本改了它看不到。
//
// 守得到的：
//   ①專案「擋的方向」那六個清單少了範本同名清單的任何一項（逐一比、逐字）＝紅，訊息說出是哪一欄的哪一項；
//   ②判準自己：跳過只認「未設定」（改成永遠跳過會紅）；九欄每一欄的方向逐欄釘（擋的方向少一項＝抓到、大小寫不同也算少；
//     放行方向少一項＝不算）——比對換回九欄、拿掉六欄的任何一欄、改成不分大小寫，這一題都紅；
//   ②b tests/filled-settings.test.js 那一輪（KIT_FILLED_SUITE）① 不可以跳過（它的假設定要填名字）——① 在套件倉庫只在那一輪真的比對；
//   ③範本自己要站得住：拒絕清單裡有測試鈕（驗收靠它）、碰錢與不碰錢兩欄都不是空的、換上假名餵 decide() 判得出
//     四種結果（測試鈕擋、碰錢連接器上不在白名單的擋、沒登記的擋、不碰錢的放行）、白名單上的工具一個都不被家族網誤擋、
//     範本的每一個不碰錢登記名都**不能當鑰匙**（出現在沒登記或變形過的碰錢連接器名字的尾段＝擋、理由是登記制「分不清」；
//     #16 r1 高：預設名單就是鑰匙的來源，鑰匙不能開門這件事由帶鑰匙的這一題釘；⚠️ 前提＝攔截器含 #16 合併版（32bca59）的
//     「放行只認標準形狀 mcp__<登記名>__<工具名>」，拿 #16 第一版（PR #16 歷史裡的 cf43681）跑這一段 52/52 紅——那正是它要釘的洞）；
//   ④範本自己不縮水（⑨b 式，settings.test.js）：九欄的筆數釘在題裡、碰錢連接器與拒絕清單逐字釘、不碰錢那一欄的組成
//     （6 個帳號編號＋20 個名字）釘；⑤範本跟正本逐字對：正本 docs/money-guard-two-pattern-tables.md「預設字彙表」那一節（只在那一節找、
//     整份檔同形的列只准一列）表格列的每一個字都要在範本裡、
//     「25→38」「19→30」要等於範本的長度、加的字要接在舊字後面逐字相同——範本掉一個字、正本改了範本沒跟上、範本加了字
//     正本沒改，都紅（改預設＝範本、這裡、正本三處一起改，看得見）。③④⑤合起來才是「範本壞掉＝每一個抄它的專案都壞」
//     那句的證據；④⑤之前 ③ 只釘到測試鈕、第一個連接器與 8 個自造名字碰到的 12 個字（2026-09-27 反駁抓到）。
//   ⑥再削一刀（擁有者 2026-10-08 裁 a）：範本把轉帳提款那一族搬到「兩張樣式表」裡掛唯讀開頭字也擋的那一張之後，釘量到的幾個名字——掛唯讀開頭字的動錢名擋、
//     擁有者接受的代價那幾個擋、寬版那一條照舊放行、沒有唯讀開頭字的照擋、範本白名單 0 支被誤擋；只釘這些名字，同一族的變化形與同義字
//     守不到（射程＝正本「再削一刀」那一節）。
// ⚠️ 守不到的：只比「有沒有少」，專案多加的項一律不比——放行三欄（safeServers／allowlist／readPrefixes）多加一項＝更鬆，
//   servers 多登記一個連接器也可能更鬆（白名單是所有碰錢連接器共用的一份，同名的工具會放行）；多加是改禁區清單本身，
//   照 README 第 3 步的手續（改 forbidden 那一塊＝重印指紋、補複本、重按信任），這一題看不到（不碰錢連接器那一級靠自覺＝
//   裁示者 2026-09-26；allowlist、readPrefixes 多加不在那條裁示裡）；擋的方向那六欄裡也有兩種「更嚴」的改法會被擋：
//   把碰錢連接器從 servers 整個拿掉（沒改登記到別欄＝那個連接器全擋）、把 patterns 的一條搬去 patternsReadSafe（轉帳提款那一族 2026-10-08 就是先改範本再搬的）
//   ——兩種都是看得見的紅、要先改套件範本；連接器登記名是**這個 claude.ai 帳號**的連接器編號
//   （換帳號＝把新編號補進去，碰錢那一欄的舊編號留著、不碰錢那一欄的可以拿掉；拒絕清單那兩支下單工具的名字也綁著舊編號，
//   要照新編號補一份——沒補，新編號上的下單工具仍由白名單制擋，但 deny 那一道就沒了；正本＝README「搬進一個專案」第 1 步），
//   編號對不對、有沒有漏掉某個連接器，機器看不到；
//   ④⑤釘的是筆數與正本表格：範本換掉一個字或一個登記名（筆數不變、又不在正本表格裡——例如把一個 safeServers 名字換成別的）
//   抓不到——那是看得見的 JSON diff，
//   由審查的人看；跳過判準那一題只釘函式，繞過函式直接在題身裡跳過抓不到（那是看得見的改動，由審查的人看）；
//   套件倉庫自己沒接攔截器（forbidden.name 是「未設定」）＝①在套件倉庫永遠跳過，只在使用專案裡守
//   （tests/filled-settings.test.js 巢狀那一輪填了名字，①在那一輪真的比對；②b 釘著那一輪不可以跳過）；⑤在巢狀複本裡跳過（複本不帶 docs/）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { read } = require('../tools/settings-data.js');
const { decide } = require('../tools/forbidden-tools.js');
const { unfilled, UNFILLED_FILE } = require('./helpers/kit-copy.js');

const UNSET = '未設定';
const LISTS = ['servers', 'safeServers', 'allowlist', 'deny', 'verbs', 'nouns', 'readPrefixes', 'patterns', 'patternsReadSafe'];
/**
 * 專案要「至少包含範本」的只有擋的方向那六欄：拿掉一項多半是變鬆（拒絕清單少一支、詞表少一個字、樣式表少一條；碰錢連接器從
 * servers 拿掉再登記到不碰錢那一欄最危險——只拿掉不改登記＝那個連接器全擋，是更嚴，也照樣會紅）。放行方向那三欄（safeServers
 * 不碰錢的連接器、allowlist 碰錢連接器上准用的工具、readPrefixes 唯讀開頭字）拿掉一項＝變嚴，所以不比（裁示者 2026-09-27
 * 「全照建議」，原 ❓＝套件 #17 留言 5853012705）。多加一項不管哪一欄都不比——這一題不擋「更鬆」，見檔頭「守不到的」。
 */
const RESTRICTIVE = ['servers', 'deny', 'verbs', 'nouns', 'patterns', 'patternsReadSafe'];
/** 驗收用的測試鈕（templates/canary-install.md；裁示者 2026-09-15 裁「8a」永久放進 deny）。 */
const CANARY = 'mcp__guard_canary__ping';
/** 正本：預設字彙表那一節住在這裡（⑭ 只有一份；本檔只讀它的表格列，不重述判準）。 */
const DOC_FILE = path.join(__dirname, '..', 'docs', 'money-guard-two-pattern-tables.md');

/** 跳不跳：只有名字還是「未設定」才跳；回跳過的原因，不跳＝null。 */
function skipReason(forbidden) {
  const f = forbidden && typeof forbidden === 'object' ? forbidden : {};
  if (!f.name || f.name === UNSET) return '這個專案的 forbidden.name 還是「未設定」（沒接禁區攔截器；套件倉庫自己就是這樣）：沒有專案清單可以比';
  return null;
}

/** 專案清單少了範本的哪些項（逐字）：回「<清單>: <項>」的陣列，空＝沒少；整欄不在＝那一欄每一項都算少。 */
function missingDefaults(project, defaults) {
  const out = [];
  for (const key of RESTRICTIVE) {
    const have = new Set(Array.isArray(project[key]) ? project[key] : []);
    for (const item of defaults[key] || []) if (!have.has(item)) out.push(`${key}: ${item}`);
  }
  return out;
}

test('專案 settings.json 的 forbidden 擋的方向那六個清單都至少包含空白範本的同名清單（逐字；預設名單）', (t) => {
  const project = read().forbidden;
  const reason = skipReason(project);
  if (reason) { t.skip(reason); return; }
  const missing = missingDefaults(project, unfilled().forbidden);
  assert.deepEqual(missing, [],
    `專案的禁區清單少了套件預設的這幾項（預設的正本＝${path.basename(UNFILLED_FILE)}；只比擋的方向那六欄——拿掉一項多半是變鬆，要拿掉先改套件範本並裁示；放行方向那三欄不比，專案可以自己拿掉；同步時把套件新加的預設補進來）：\n${missing.join('\n')}`);
});

test('判準自己：跳過只認「未設定」；少一項要抓到並說是哪一項；多加的不算（對照組）', () => {
  assert.equal(skipReason({ name: '錢', servers: ['x'] }), null, '名字填了就不跳');
  for (const f of [{ name: UNSET }, {}, undefined, { name: '' }]) assert.match(skipReason(f) || '', /未設定/u, `${JSON.stringify(f)}：名字沒填才跳，而且要說出原因`);
  const defaults = unfilled().forbidden;
  assert.deepEqual(missingDefaults(defaults, defaults), [], '範本跟自己比：一項都不少');
  assert.deepEqual(missingDefaults({ ...defaults, servers: [] }, defaults), defaults.servers.map((s) => `servers: ${s}`), '碰錢的連接器被拿掉要抓到（改登記到不碰錢那一欄＝最危險的放鬆）');
  // 每一欄的方向逐欄釘在這裡（寫死的表，不從 RESTRICTIVE 推——拿自己驗自己等於沒驗）：擋的方向少一項要抓到、說出是哪一項，
  // 大小寫不同也算少（逐字）；放行方向少一項、整欄清空都不算（裁示者 2026-09-27）
  const DIRECTION = { servers: '擋', deny: '擋', verbs: '擋', nouns: '擋', patterns: '擋', patternsReadSafe: '擋', safeServers: '放行', allowlist: '放行', readPrefixes: '放行' };
  assert.deepEqual(Object.keys(DIRECTION).sort(), [...LISTS].sort(), '九欄每一欄都要寫明方向');
  for (const key of LISTS) {
    const first = defaults[key][0];
    const dropped = missingDefaults({ ...defaults, [key]: defaults[key].slice(1) }, defaults);
    const cased = missingDefaults({ ...defaults, [key]: [first.toUpperCase() === first ? `${first}_X` : first.toUpperCase(), ...defaults[key].slice(1)] }, defaults);
    if (DIRECTION[key] === '擋') {
      assert.deepEqual(dropped, [`${key}: ${first}`], `${key} 是擋的方向：少一項要抓到、要說是哪一項`);
      assert.deepEqual(cased, [`${key}: ${first}`], `${key} 是擋的方向：逐字比，大小寫不同也算少`);
    } else {
      assert.deepEqual(dropped, [], `${key} 是放行方向：少一項＝更嚴，不算少`);
      assert.deepEqual(missingDefaults({ ...defaults, [key]: [] }, defaults), [], `${key} 是放行方向：整欄清空也不算少`);
    }
  }
  assert.deepEqual(missingDefaults({ ...defaults, deny: defaults.deny.filter((d) => d !== CANARY) }, defaults), [`deny: ${CANARY}`], '少了測試鈕要抓到');
  const total = Object.keys(DIRECTION).filter((k) => DIRECTION[k] === '擋').reduce((n, k) => n + defaults[k].length, 0);
  assert.equal(missingDefaults({ name: '錢' }, defaults).length, total, '擋的方向的清單整欄不在＝那一欄的每一項都算少（放行方向三欄不算）');
  assert.deepEqual(missingDefaults({ ...defaults, verbs: [...defaults.verbs, 'zzz_extra'] }, defaults), [], '專案多加的字不算少');
});

test('②b 巢狀那一輪 ① 不可以跳過：tests/filled-settings.test.js 的假設定要填 forbidden.name（① 在套件倉庫只在那一輪真的比對）',
  { skip: process.env.KIT_FILLED_SUITE === '1' ? false : '只在 tests/filled-settings.test.js 那一輪檢查（KIT_FILLED_SUITE；別的整卷重跑用的是根目錄的真設定，forbidden.name 是「未設定」、① 照設計跳過）' }, () => {
  assert.equal(skipReason(read().forbidden), null, '巢狀那一輪的專案設定沒填 forbidden.name：① 會靜靜跳過，比對方向反了也不會紅');
});

test('空白範本的預設自己站得住：測試鈕在拒絕清單、兩欄都有登記、換上假名餵攔截器判得出四種結果、白名單上的工具不被誤擋、不碰錢的登記名不能當鑰匙', () => {
  const defaults = unfilled().forbidden;
  assert.equal(defaults.name, UNSET, '範本的名字要保持「未設定」（settings.test.js ⑨ 也釘著；新專案填名字才算接上攔截器）');
  assert.ok(defaults.deny.includes(CANARY), `範本的拒絕清單要有測試鈕 ${CANARY}（驗收看的就是它）`);
  assert.ok(defaults.servers.length >= 1, '碰錢的連接器至少一個');
  assert.ok(defaults.safeServers.length >= 1, '不碰錢的連接器至少一個（名單空＝全擋，範本不可以是那個形狀）');
  const f = { ...defaults, name: '假禁區' };
  const money = defaults.servers[0];
  const safe = defaults.safeServers[0];
  assert.match(decide(CANARY, f).why, /在拒絕清單上/u, '測試鈕擋、理由是驗收看的那一句');
  assert.match(decide(`mcp__${money}__guard_defaults_probe_zz`, f).why, /白名單制/u, '碰錢連接器上不在白名單的擋');
  assert.match(decide('mcp__unregistered_zz__get_thing', f).why, /沒有登記/u, '沒登記的連接器擋');
  assert.equal(decide(`mcp__${safe}__guard_defaults_probe_zz`, f).deny, false, '不碰錢的連接器放行');
  for (const t of defaults.deny) assert.equal(decide(t, f).deny, true, `拒絕清單上的 ${t} 要擋`);
  const misblocked = defaults.allowlist.filter((tool) => decide(`mcp__${money}__${tool}`, f).deny);
  assert.deepEqual(misblocked, [], '白名單上的工具走雙保險時不可以被家族網誤擋（詞表加字之後要重量這一條）');
  // 預設名單就是「鑰匙」的來源（#16 r1 高：登記名出現在尾段就放行）：範本每一個不碰錢登記名 k，沒登記的連接器與
  // 變形過的碰錢連接器都不准借 k 放行；擋的理由是登記制（分不清），不是碰禁區那幾道；兩個探針名都像錢（transfer_funds、create_order_instruction）
  // ＝kind registry-money、尾句是「疑似誤觸或冒名」那一句（tests/forbidden-tools.test.js ⑮②g；裁示者 2026-09-27、2026-09-28 裁 b）。
  // ⚠️ 前提：攔截器含 #16 合併版（32bca59）的 safeConnectorOf（只認標準形狀）；拿 #16 第一版（PR #16 歷史裡的 cf43681）跑這一段 52/52 紅——那正是它要釘的洞。
  for (const k of defaults.safeServers) {
    for (const t of [`mcp__zz_unregistered__transfer_funds__${k}`, `mcp__x${money}__create_order_instruction__${k}`]) {
      const d = decide(t, f);
      assert.equal(d.deny, true, `${t}：不碰錢的登記名「${k}」出現在尾段不可以當鑰匙（前提：攔截器含 #16 合併版 32bca59，放行只認標準形狀 mcp__<登記名>__<工具名>）`);
      assert.equal(d.kind, 'registry-money', `${t}：擋的理由要是登記制、名字像錢那一種（拿到的是「${d.why}」）`);
      assert.match(d.why, /^連接器工具「[^」]+」分不清是哪個連接器/u, `${t}：擋的理由要是登記制（分不清）、不是碰到禁區（拿到的是「${d.why}」）`);
    }
  }
  // 字彙表補的那一族（裁示者 2026-09-27 裁「趕緊補進字彙表」）：這幾個自造名字補之前放行、補之後要擋——只釘量到的，
  // 這一族靠補字擋不完（正本＝docs/money-guard-two-pattern-tables.md「預設字彙表」那一節）
  for (const t of ['view_withdraw_cash', 'download_transfer_funds', 'read_withdraw_cash', 'get_transfer_money', 'list_remit_payment', 'encash_cheque', 'sweep_cash', 'repay_loan']) {
    assert.equal(decide(t, f).deny, true, `${t}：預設字彙表要擋得住`);
  }
});

test('⑥再削一刀：轉帳提款那一族掛了唯讀開頭字也照擋、其他家族不動；範本的真工具（白名單、兩支下單工具）判定不變（擁有者 2026-10-08 裁 a）', () => {
  // 範圍、代價、射程＝「兩張樣式表」（正本＝docs/money-guard-two-pattern-tables.md）；這裡只釘量到的名字，不重述判準。
  // 全走碰錢連接器白名單那條路：登記制之後，mcp__ 名字只有這條路會被家族網與兩張樣式表決定擋不擋。
  // 本機看得到的全部工具名不放進這一題：考題會同步進公開的使用專案，那份名單看得出擁有者用哪些服務（B5，判不出＝算）。
  const defaults = unfilled().forbidden;
  const f = { ...defaults, name: '假禁區' };
  const money = defaults.servers[0];
  const onMoney = (tool) => decide(`mcp__${money}__${tool}`, { ...f, allowlist: [...f.allowlist, tool] });
  // 動錢的名字掛唯讀開頭字（後面不接表上的錢名詞，家族網湊不成）：搬之前放行、搬之後擋，理由要說出唯讀開頭字不算數
  for (const t of ['read_withdraw', 'read_withdraw_now', 'get_transfer', 'view_wire', 'download_payout', 'export_remit', 'fetch_deposit', 'query_disburse']) {
    const d = onMoney(t);
    assert.equal(d.deny, true, `${t}：轉帳提款那一族掛了唯讀開頭字也要擋（擁有者 2026-10-08 裁 a）`);
    assert.match(d.why, /唯讀前綴不替它脫罪/u, `${t}：理由要說出唯讀開頭字不算數（拿到的是「${d.why}」）`);
  }
  // 擁有者接受的代價（「列出轉帳紀錄」這類無害查詢）：釘著讓代價看得見；要放行照裁示流程，不在這裡開洞
  for (const t of ['list_transfers', 'get_transfer_log', 'get_payment_methods', 'list_deposits']) {
    assert.equal(onMoney(t).deny, true, `${t}：再削一刀的代價，這一版擋（要放行先問擁有者、改套件範本）`);
  }
  // 對照：其他家族的唯讀放行不動（寬版 convert／exchange／swap 那一條仍吃唯讀豁免）；沒有唯讀開頭字的本來就擋
  for (const t of ['list_exchange_traded_funds', 'get_exchange_traded_fund_list']) {
    assert.equal(onMoney(t).deny, false, `${t}：寬版那一條不在這次裁示裡，唯讀開頭字照舊放行`);
  }
  for (const t of ['withdraw', 'transfer_now', 'wire']) assert.equal(onMoney(t).deny, true, `${t}：沒有唯讀開頭字，搬之前搬之後都擋`);
  // 範本的真工具：白名單 32 支（第一個使用專案的券商唯讀工具）走雙保險 0 支被誤擋；拒絕清單那兩支真下單工具照擋
  const misblocked = defaults.allowlist.filter((tool) => decide(`mcp__${money}__${tool}`, f).deny);
  assert.deepEqual(misblocked, [], '白名單上的真工具不可以因為再削一刀被誤擋');
  for (const t of defaults.deny.filter((d) => d.startsWith(`mcp__${money}__`))) assert.equal(decide(t, f).deny, true, `${t}：真下單工具照擋`);
});

test('④範本自己不縮水：九欄筆數釘在這裡、碰錢連接器與拒絕清單逐字、不碰錢那一欄＝6 個帳號編號＋20 個名字、沒有重複', () => {
  const defaults = unfilled().forbidden;
  // 改預設＝範本、這裡、正本「預設字彙表」三處一起改（看得見）；只改範本＝這裡紅
  const COUNTS = { servers: 1, safeServers: 26, allowlist: 32, deny: 3, verbs: 38, nouns: 30, readPrefixes: 14, patterns: 1, patternsReadSafe: 5 };
  assert.deepEqual(Object.fromEntries(LISTS.map((k) => [k, defaults[k].length])), COUNTS, '範本九欄的筆數跟這裡釘的不一樣：範本縮水、或加了預設沒改這裡');
  for (const k of LISTS) assert.equal(new Set(defaults[k]).size, defaults[k].length, `${k} 有重複的項（重複會讓筆數騙人）`);
  assert.deepEqual(defaults.servers, ['deda1d5d-1ccc-4551-9617-156b9658d236'], '碰錢連接器逐字（第一個使用專案 0562e422 的券商連接器）');
  assert.deepEqual(defaults.deny, [
    'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_order_instruction',
    'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__delete_order_instruction',
    CANARY,
  ], '拒絕清單逐字：兩支下單工具＋測試鈕（少一支＝碰錢連接器上仍由白名單制擋，但 deny 那一道就沒了）');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const ids = defaults.safeServers.filter((s) => UUID.test(s));
  assert.equal(ids.length, 6, `不碰錢那一欄：這個 claude.ai 帳號的連接器編號要是 6 個（現在 ${ids.length}）`);
  assert.equal(defaults.safeServers.length - ids.length, 20, `不碰錢那一欄：桌面內建 17＋Codex 3＝20 個名字（現在 ${defaults.safeServers.length - ids.length}）`);
});

// ⚠️ 巢狀複本不帶 docs/（跟 tests/forbidden-tools.test.js ⑭ 同一個旗標、同一個理由）：真正的一輪＝倉庫根目錄那次 npm test
test('⑤範本跟正本逐字對：正本「預設字彙表」表格列的每一個字都在範本裡、N→M 等於範本長度、加的字接在舊字後面逐字相同',
  { skip: process.env.KIT_NESTED_SUITE === '1' ? '巢狀複本不帶 docs/，沒有正本可以對' : false }, () => {
  const defaults = unfilled().forbidden;
  const doc = fs.readFileSync(DOC_FILE, 'utf8');
  const start = doc.indexOf('\n### 預設字彙表');
  assert.ok(start >= 0, `正本 ${path.basename(DOC_FILE)} 裡找不到「### 預設字彙表」這一節（要是一行標題）`);
  const rest = doc.slice(start + 1);
  const next = rest.indexOf('\n### ');
  const section = next < 0 ? rest : rest.slice(0, next);
  for (const col of ['verbs', 'nouns']) {
    const all = doc.match(new RegExp(`^\\| ${col} \\| .+? \\| \\d+→\\d+ \\|$`, 'gmu')) || [];
    assert.equal(all.length, 1, `整份正本「| ${col} | 字、… | N→M |」這種列要剛好一列（現在 ${all.length} 列）：多一列會讓這一題比錯列`);
    const m = section.match(new RegExp(`^\\| ${col} \\| (.+?) \\| (\\d+)→(\\d+) \\|$`, 'mu'));
    assert.ok(m, `正本「預設字彙表」那一節找不到「| ${col} | 字、字、… | N→M |」這一列`);
    const words = m[1].split('、').map((w) => w.trim());
    const from = Number(m[2]);
    const to = Number(m[3]);
    assert.equal(defaults[col].length, to, `正本寫 ${col} ${from}→${to}，範本是 ${defaults[col].length} 個：範本掉字、或正本改了範本沒跟上`);
    assert.equal(words.length, to - from, `正本 ${col} 那一列列了 ${words.length} 個字，但 ${from}→${to} 是 ${to - from} 個：表格列跟數字對不上`);
    assert.deepEqual(defaults[col].slice(from), words, `範本 ${col} 從第 ${from + 1} 個起要逐字等於正本表格列的加字（舊字在前、新字接後；順序也釘）`);
  }
});
