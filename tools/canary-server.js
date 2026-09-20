#!/usr/bin/env node
// 禁區攔截器的測試鈕（規矩 B1 的驗收用；裁示者 2026-09-15 裁「8a」＝清單上永久放一個無害的測試名字）。
// 這是一支**什麼都不做**的小伺服器：兩家 AI 啟動時把它掛上去，它只提供一個工具，叫它就回一句 pong。
//
// 為什麼要有它：攔截器沒裝好、沒按信任、或載入就崩的時候，看到的畫面跟「它好好地在擋」一模一樣——
// 什麼事都沒發生。要證明它活著，唯一的辦法是叫一個「照清單該擋」的工具、親眼看到那一組的拒絕理由。
// 但任何會動到禁區的真工具一律絕不可以叫來試（連唯讀的查詢也不行），所以清單上要刻意放一個
// 就算真的執行了也無害的名字——這一支就是那個名字的本體：
//
//     mcp__guard_canary__ping
//
// 怎麼裝、怎麼用：templates/canary-install.md（兩家 AI 各登記一次，名字加進 settings.json 的
// forbidden.deny），驗收順序＝tools/guard-copy.js 檔頭⓪〜⑥。
//
// 為什麼寫成這樣：MCP 的伺服器是**每個 session 一啟動就會被執行**的一支程式（不是等你叫工具才跑），
// 所以這一支刻意不 require 任何東西、不讀檔、不連網、不看環境變數、不執行別的程式——整份原始碼只有
// 「讀標準輸入的一行 JSON、往標準輸出寫一行 JSON」。考題 tests/canary-server.test.js 逐項釘住這件事。
//
// 誠實劃界：「無害」有兩層，兩層都不證明 node 自己做了什麼——①考題把這個檔的**位元組釘住**（改一個字元
// 都要重算雜湊，重算的人要負責看過改了什麼）；②考題掃原始碼裡有沒有出現取得能力的那幾個字串，
// 但**那道掃描是絆線**：不寫出那幾個字串一樣做得到（換個寫法就繞開了）。另外考題會看「跑一輪之後工作
// 目錄有沒有多出檔案」——那只看得到工作目錄。對方掛著不把輸出讀走時，回覆會排在記憶體裡（沒有背壓處理；
// 正常的客戶端會讀，這要刻意不讀才碰得到）。壞掉的一行 JSON 只丟掉那一行、不讓整支崩（崩了工具
// 就從清單上消失，驗收時會把「叫不到」誤當成「被擋」）；單一行超過上限時整段緩衝丟掉，那之後的訊息可能
// 對不齊——這一支的用途是被叫一次看有沒有被擋，不是可靠的資料通道。標準輸入關掉就自己結束（不呼叫
// process.exit：那會把還沒寫出去的回覆截斷）。
// 父行程死掉之後會不會留下孤兒行程（2026-09-20 在 macOS、Node v26 量的：把父行程強制砍掉，再看這一支還在不在）。
// ⚠️ 下面四格的前提是**閒置**——沒有還沒送出去的回覆（起來之後沒有叫過它，或叫過的都已經被讀走）：
//   ・標準輸入是父行程自己握著寫的那一頭的管線（正常的 MCP 客戶端就是這樣）＝父行程一死管線就關掉、這一支讀到結尾、
//     自己結束，沒有留下行程；標準輸出關掉或留給別人都一樣（兩種各量一次，結果相同）。
//   ・標準輸入被**刻意**接給第三者（量法：改接一條具名管道、寫的那一頭由一個跟父行程無關的行程握著）＝
//     父行程被砍掉之後這一支還活著、它的父行程編號變成 1（孤兒）；標準輸出關掉或留著也都一樣。
// 這四格**不是**「會留下來的情形」的全部。上面那句「對方掛著不把輸出讀走時，回覆會排在記憶體裡」就是另一種：
//   量過的反例（2026-09-20）＝標準輸入的寫端只有父行程握著（父一死就關），但先叫了兩萬次 ping、
//   標準輸出接到一條具名管道而第三者握著讀的那一頭卻不讀——父行程被砍掉之後這一支照樣還活著、父行程編號也是 1，
//   直到第三者把排著的 808894 位元組讀完它才自己收攤。所以「標準輸入關掉就自己結束」只在沒有待送回覆時
//   等於「馬上收攤」；回覆還排著的時候，什麼時候收攤由讀輸出的那一方決定。
// 為什麼還是不改本體：這一次評估的做法是「定期去看父行程還在不在」，那要加一個計時器，會讓上面
//   「整份原始碼只有讀標準輸入的一行 JSON、往標準輸出寫一行 JSON」那句話變成假話，所以不採用。
//   沒有評估別的做法，這裡也不宣稱別的做法不存在。
'use strict';

/** 伺服器登記名：兩家 AI 都把工具叫成 mcp__<伺服器名>__<工具名>，所以完整名字＝mcp__guard_canary__ping。 */
const SERVER = 'guard_canary';
const TOOL = 'ping';
const REPLY = 'pong';
/** 對方沒說版本、或說的不在下面這張表裡時用這個。 */
const PROTOCOL = '2025-06-18';
/**
 * 對過的協定版本：對方說的在這張表裡就照著回，否則回 PROTOCOL。
 * （MCP 的版本協商要求回一個**自己支援的**版本，不是把對方說的原樣回聲——回聲等於宣稱支援任何版本。）
 */
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** 一行的上限：壞掉的輸入不該把記憶體吃光。 */
const MAX_LINE = 1024 * 1024;

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const result = (id, r) => send({ jsonrpc: '2.0', id, result: r });
const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

/** 一則訊息的處理。沒有 id ＝通知，一律不回（回了會讓對方當成協定錯誤）。 */
function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  const id = msg.id;
  const asked = id !== undefined && id !== null;
  const method = msg.method;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  if (typeof method !== 'string') {
    if (asked) failure(id, -32600, '不是合法的請求');
    return;
  }
  if (method === 'initialize') {
    const version = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL;
    if (asked) result(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: SERVER, version: '1.0.0' } });
    return;
  }
  if (method === 'ping') {
    if (asked) result(id, {});
    return;
  }
  if (method === 'tools/list') {
    if (asked) {
      result(id, {
        tools: [{
          name: TOOL,
          description: '禁區攔截器的測試鈕：回一句 pong，什麼都不做（不讀檔、不連網、不改任何東西）。它的名字刻意放在禁區的拒絕清單上，叫它是用來確認攔截器真的在擋。',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      });
    }
    return;
  }
  if (method === 'tools/call') {
    if (!asked) return;
    if (params.name !== TOOL) {
      result(id, { content: [{ type: 'text', text: `這支伺服器只有「${TOOL}」一個工具` }], isError: true });
      return;
    }
    result(id, { content: [{ type: 'text', text: REPLY }] });
    return;
  }
  if (asked) failure(id, -32601, `不認得的方法：${String(method).slice(0, 100)}`);
}

let buffered = '';
// 對方把管線關掉時不要讓整支噴錯（它會在標準錯誤留一堆東西，看起來像攔截器出事）。
process.stdout.on('error', () => {});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  if (buffered.length > MAX_LINE) buffered = '';
  for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
    const line = buffered.slice(0, at).trim();
    buffered = buffered.slice(at + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { handle(msg); } catch { /* 一則訊息處理不了就跳過，不讓整支崩 */ }
  }
});
