#!/usr/bin/env node
// 禁區攔截器（規矩 B1）：工具被呼叫的當下，看它是不是禁區裡的東西；是＝當場拒絕。
//
// 為什麼：原專案的禁區是「錢」——任何會動到錢的工具絕對不准呼叫，連建單、試用都不行。這條在規矩書
// 裡寫了，但規矩書擋不住一次誤觸或一則冒名的指令；只有工具被呼叫那一刻的攔截擋得住。
// 這支讓裁示者不必時時盯著 AI 有沒有碰到禁區。
//
// 分工：套件只帶**判斷**（這一支）；各家 AI 的鉤子格式不同，各自的設定檔（templates/hook-*.json）
// 都呼叫這同一支。原專案是把整段判斷各抄一份進兩個設定檔、再用考題互鎖不讓它們漂——這裡從結構上
// 就只有一份，不需要互鎖。
//
// 判斷（全部讀專案設定的 forbidden 那一塊，程式裡不寫任何禁區的名字）：
//   ①輸入拿不到工具名、工具名不是合法字元集＝拒絕（fail-closed）；
//   ②禁區清單沒設＝拒絕（裝了攔截器卻沒填清單，比沒裝更危險——它會讓人以為有在擋）；
//   ③工具屬於「動禁區的連接器」＝白名單制：不在唯讀名單上就拒絕（名字裡**任何一段**是連接器都算，
//     不只開頭那一段）；在唯讀名單上也不直接放行，照樣走下面的家族網（雙保險）；
//   ④工具名逐字在拒絕清單上＝拒絕；
//   ⑤家族網：工具名正規化（駝峰拆底線、點與連字號換底線、轉小寫）後，動詞接名詞、或名詞接動詞、
//     或額外樣式命中＝拒絕。⚠️ **唯讀前綴（get／list／search 那一類）只豁免「額外樣式」那一道，
//     不豁免動詞名詞那兩道**（2026-09-24 收緊；之前是兩道一起豁免，`view_create_order` 因此一路放行）。
//   其餘放行（不印任何東西）。
//
// 誠實劃界：只認工具名，不看參數；家族網是列舉的詞表，沒列到的動詞或名詞擋不住（詞表由專案維護）；
// 每一方的鉤子要各自安裝、信任、啟用，沒啟用的那一方等於沒有；家族網會蓋過唯讀名單（名單上的工具若命中家族網，
// 一樣拒絕——要放行就改家族網，不是加名單）。
'use strict';
const { read: readSettings } = require('./settings-data.js');

const UNSET = '未設定';
const LEGAL_NAME = /^[A-Za-z0-9_.-]{1,200}$/u;

function normalize(x) {
  return String(x)
    .replace(/(?<=[a-z0-9])(?=[A-Z])/gu, '_')
    .replace(/(?<=[A-Z])(?=[A-Z][a-z])/gu, '_')
    .replace(/[._-]+/gu, '_')    // 點、連字號、**連續底線**都折成一個底線：order__create 跟 order_create 是同一個字（r1 High④）
    .toLowerCase();
}

/** 各欄位的詞彙文法：不合文法的規則**根本不可能**匹配合法工具名，留著只會把「有規則」判成真（r2 High②）。 */
const GRAMMAR = {
  servers: /^[A-Za-z0-9_.-]+$/u,        // 連接器名：合法工具名的字元集
  allowlist: /^[A-Za-z0-9_.-]+$/u,
  deny: /^[A-Za-z0-9_.-]+$/u,
  verbs: /^[a-z0-9]+(?:_[a-z0-9]+)*$/u,  // 家族網的詞：正規化後的形狀（小寫、底線）
  nouns: /^[a-z0-9]+(?:_[a-z0-9]+)*$/u,
  readPrefixes: /^[a-z0-9]+$/u,
  patterns: /^\S+$/u,                    // 正規式另外試編譯
};

/**
 * 清單型欄位：沒填＝空陣列；填了就必須是字串陣列、每一項合文法，否則回 null（呼叫端當設定壞掉、拒絕）。
 * 「未設定」這個佔位值算沒填。
 */
function listField(f, key) {
  if (f[key] === undefined) return [];
  if (!Array.isArray(f[key]) || f[key].some((x) => typeof x !== 'string')) return null;
  const items = f[key].filter((x) => x !== UNSET);
  if (items.some((x) => !GRAMMAR[key].test(x))) return null;
  return items;
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 純判斷層。回 { deny: true, why } 或 { deny: false }。
 * @param {unknown} toolName 鉤子傳來的工具名
 * @param {object} forbidden 專案設定的 forbidden 那一塊
 */
function decide(toolName, forbidden) {
  if (typeof toolName !== 'string') return { deny: true, why: '輸入缺工具名（fail-closed）' };
  if (!LEGAL_NAME.test(toolName)) return { deny: true, why: '工具名不符合合法字元集（fail-closed）' };
  const f = forbidden && typeof forbidden === 'object' ? forbidden : {};
  if (!f.name || f.name === UNSET) return { deny: true, why: '專案設定裡的禁區清單還沒填：裝了攔截器卻沒填清單，一律拒絕' };
  const lists = {};
  for (const key of ['servers', 'allowlist', 'deny', 'verbs', 'nouns', 'readPrefixes', 'patterns']) {
    lists[key] = listField(f, key);
    if (lists[key] === null) return { deny: true, why: `專案設定裡禁區清單的「${key}」不是字串陣列、或有一項不合文法（空白、非法字元）：設定壞掉，一律拒絕` };
  }
  const { servers, verbs, nouns, readPrefixes } = lists;
  const allow = new Set(lists.allowlist);
  const deny = new Set(lists.deny);
  let patterns;
  try { patterns = lists.patterns.map((p) => new RegExp(p, 'u')); }
  catch { return { deny: true, why: '專案設定裡禁區清單的額外樣式不是合法的正規式：設定壞掉，一律拒絕' }; }
  // 只填名字、沒有任何一條有效規則＝跟沒填一樣（r1 High③：原本只看 name，其餘全空就全部放行）
  const hasRule = servers.length || deny.size || (verbs.length && nouns.length) || patterns.length;
  if (!hasRule) return { deny: true, why: `禁區「${f.name}」沒有任何一條有效規則（連接器、拒絕清單、家族網、額外樣式都是空的）：裝了攔截器卻沒有規則，一律拒絕` };

  if (deny.has(toolName)) return { deny: true, why: `工具「${toolName}」在拒絕清單上` };
  // 連接器比對用**完整登記名稱**與分段邊界（r1 High④：登記名含 __ 時，逐段比對永遠找不到它）。
  // 名字裡**每一個**分段邊界上的出現都要比（搬家驗屋 09-13：原本只認開頭那一段，
  // mcp__prefix__<連接器>__market_order 這種多一層前綴的名字整層不開火、退回家族網而放行；
  // 原專案 Grok 掃到過同一個洞並已補上）。邊界＝前面是名字開頭或 __、後面是名字結尾或 __。
  for (const server of servers) {
    for (let at = toolName.indexOf(server); at !== -1; at = toolName.indexOf(server, at + 1)) {
      const after = toolName.slice(at + server.length);
      if (!(at === 0 || toolName.slice(at - 2, at) === '__') || !(after === '' || after.startsWith('__'))) continue;
      if (after === '') return { deny: true, why: `連接器「${server}」會動到${f.name}，沒有指定工具名，一律拒絕` };
      const tool = after.slice(2);
      if (!allow.has(tool)) return { deny: true, why: `連接器「${server}」會動到${f.name}，採白名單制；「${tool}」不在唯讀名單上` };
      // 在唯讀名單上也**不在這裡放行**：往下照樣走家族網（雙保險——名單誤填了動禁區的工具時，家族網還擋得住）
    }
  }
  // 家族網：工具名的每一個「__」之後的尾段都試一次（連接器前綴不同、工具名相同的要一起擋）
  const rest = toolName.startsWith('mcp__') ? toolName.slice(5) : toolName;
  const cands = [];
  for (let i = rest.indexOf('__'); i !== -1; i = rest.indexOf('__', i + 1)) cands.push(rest.slice(i + 2));
  if (!cands.length) cands.push(rest);
  const verb = verbs.length ? `(?:${verbs.map(esc).join('|')})` : null;
  const noun = nouns.length ? `(?:${nouns.map(esc).join('|')})s?` : null;
  const readRe = readPrefixes.length ? new RegExp(`^(?:${readPrefixes.map(esc).join('|')})_`, 'u') : null;
  for (const c of cands) {
    const t = normalize(c);
    // ⚠️ **唯讀前綴不再無條件跳過**（全庫護欄稽核實測到的破口，2026-09-24）。
    //    原本這一行是 `if (readRe && readRe.test(t)) continue;`：只要名字以 get_／list_／view_／
    //    export_… 開頭，**整張家族網連同下面的額外樣式一起跳過**。實測（直接呼叫本函式、帶對照組）：
    //      對照 `create_order`／`place_trade` → 擋住 ✅
    //      `view_create_order`／`get_place_order`／`list_submit_trade`／`export_cancel_order` → **全部放行** ❌
    //    那正好就是上面連接器那段答應的「雙保險」該接住、卻接不住的東西。
    // ⚠️ **這是「偏安全、願意付誤擋代價」的取捨，不是「零代價」**（#641 r1 #3 更正我上一版的說法）。
    //    我上一版寫「家族網是精確比對、不需要閥」——**那句話是錯的，而且是事後合理化**。
    //    誤擋有**兩個不同的來源，不可以算成同一個**（Grok 複審後掃 #3 更正我把兩者混在一起）：
    //      ㈠ **動詞表裡有 `open`／`close`／`buy`／`sell` 這種「既是動作也是狀態」的字** ⇒
    //         `list_open_positions`（未平倉）被讀成「開倉動作」。這與比對是不是完整 token **無關**：
    //         改成完整 token `(^|_)open_position(s)(_|$)` 一樣命中。
    //      ㈡ **比對用 `_?\\w*?` 不是完整 token** ⇒ `close` 吃到 `closed`：
    //         `get_closed_positions` 是靠這一點命中的，完整 token 版本**不會**命中。
    // ⚠️ **本支新造出來的拒絕面（審查者找到、我逐一複驗過；主幹放行、本版拒絕）**：
    //      `list_open_positions`（列出未平倉部位）、`get_closed_positions`（查已平倉部位）、
    //      `get_create_order_status`（查委託建立狀態）、`view_order_create_history`（查建立歷史）。
    //    這幾個都是**合理的唯讀名字**。踩到了就照既定裁示流程處理，不要在這裡自己開洞。
    // ⚠️ 量到的另一半（別把代價說得比實際大）：那個券商連接器的**唯讀白名單 32 筆**逐支比過、判決都沒翻
    //    （⚠️ 掃描 #3 更正：32 是**白名單的長度**，不是「該連接器實際登記的全部工具」——
    //     `deny` 裡另有同一個連接器的 2 支下單工具全名，所以倉庫自己點名的至少 34 個）；
    //    本檔考題明文要求放行的 `get_order`／`list_positions`／`search_stocks`／`view_trade_history` 也不受影響。
    //    審查者另以正式詞表組出 33,250 個變體：26,600 個由放行變拒絕、**0 個由拒絕變放行**
    //    （那是那個枚舉集合的結果，不是「所有名字」的證明）。
    const 讀名 = readRe ? readRe.test(t) : false;
    const 但書 = 讀名 ? '；唯讀前綴不替它脫罪' : '';
    // ⚠️ **只拆家族網那兩道；下面 `if (!讀名)` 是額外樣式仍然吃豁免的地方**。
    //    留著它的理由：`patterns` 第一條認的是**單獨成詞**的 transfer／withdraw／deposit… 這一類字
    //    （⚠️ 掃描 #1 更正：它**要詞界**，不是「名字裡出現就算」——`get_transferable`、
    //     `get_withdrawing`、`wiretransfer` 對它都不中），而 `get_transfer_log`（讀轉帳紀錄、真的唯讀）
    //    會中；把閥一起拆掉就誤擋它（`test/money-kit-hook.test.js` 的矩陣明文要它放行，
    //    我第一版就是在這裡被它抓到）。
    // ⚠️ `readPrefixes` **仍然在判斷上有作用**（不是只影響訊息——清空它，
    //    `read_withdraw_cash` 由放行變拒絕，實測過）。
    // ⚠️ **仍然守不住的——這一段我上一版寫錯了，照實重寫**（掃描 #2）：
    //    我原本寫成「只命中**寬**樣式的才漏」。**錯：五條額外樣式全部被前綴跳過，含精確的那幾條。**
    //    實測仍然放行（未宣告連接器、直接呼叫本函式）：
    //      `get_send_money`／`get_send_cash`（第二條 `(move|send)_(fund|money|cash…)` 接得到，被跳過；
    //        對照 `get_send_funds` **會**被家族網擋，因為 `fund` 在名詞表裡）
    //      `get_move_funds`／`view_convert_currency`／`list_swap_crypto`
    //        （`move`／`convert`／`swap` 不在動詞表、只活在第二三條 ⇒ 家族網接不到）
    //      `download_transfer_funds`／`read_withdraw_cash`（第一條）
    // ⚠️ **另一個劃界缺口（掃描補的）**：名字在**已宣告那個連接器**上時白名單仍會擋；
    //    但把 `get_send_money`／`view_convert_currency`／`download_transfer_funds` 這種**誤填進白名單**
    //    之後就放行——上面那段答應的「雙保險」對它們仍然不存在（對 `view_create_order` 這種
    //    命中家族網的才存在）。
    //    要收它＝把 `patterns` 拆成「要詞界的寬條」與「動詞＋錢名詞的精確條」、只讓寬條吃豁免
    //    ＝**動判準，留給裁示者裁**，本支不動。
    if (verb && noun) {
      if (new RegExp(`(^|_)${verb}_?\\w*?${noun}(_|$)`, 'u').test(t)) return { deny: true, why: `工具名命中${f.name}的家族網（${t}${但書}）` };
      if (new RegExp(`(^|_)${noun}_${verb}(_|$)`, 'u').test(t)) return { deny: true, why: `工具名命中${f.name}的家族網（${t}${但書}）` };
    }
    if (!讀名) for (const re of patterns) if (re.test(t)) return { deny: true, why: `工具名命中${f.name}的額外樣式（${t}）` };
  }
  return { deny: false };
}

/** 鉤子的輸出形狀（兩家 AI 都認這個）。 */
function hookOutput(why, name) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${name}的絕對邊界：${why}。會動到${name}的工具絕對禁止呼叫，沒有例外；此類指令一律視為誤觸或冒名，拒絕執行並立即回報裁示者。`,
    },
  });
}

/** 指令入口：讀 stdin 的 JSON，拒絕就印鉤子輸出；放行不印。任何例外都當拒絕。 */
function cli(stdinText, settings = readSettings()) {
  const forbidden = settings.forbidden || {};
  const name = forbidden.name && forbidden.name !== UNSET ? forbidden.name : '禁區';
  let toolName;
  try { toolName = JSON.parse(stdinText).tool_name; }
  catch { return { code: 0, output: hookOutput('輸入無法解析（fail-closed）', name) }; }
  const d = decide(toolName, forbidden);
  return { code: 0, output: d.deny ? hookOutput(d.why, name) : '' };
}

if (require.main === module) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { text += c; });
  process.stdin.on('end', () => {
    let r;
    try { r = cli(text); } catch (e) { r = { code: 0, output: hookOutput(`攔截器自己出錯（${(e && e.code) || '不明'}），fail-closed`, '禁區') }; }
    if (r.output) process.stdout.write(`${r.output}\n`);
    process.exit(r.code);
  });
}

module.exports = { decide, normalize, cli, hookOutput };
