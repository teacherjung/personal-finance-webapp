#!/usr/bin/env node
// 待裁清單（規矩 D1、I1〜I3）：把「問了裁示者、他還沒回」的問題列出來。
//
// 為什麼：裁示者定了「沒有時限、問了就等」（I2）。那「還在等哪些」就得有東西在數，不然靠下一個
// 開工的人剛好想起來。這支讓裁示者不必自己翻留言串就知道還欠哪些答案，也讓 AI 不會重問或自己拍板。
//
// ⚠️ 這不是閘：它不擋任何事、不寫任何留言、不判「可不可以先做」。不要把它接進鉤子或合併步驟。
//
// 形狀只認範本（templates/ruling-record.md）：
//   問  ＝第一行「## ❓ 待裁（YYYY-MM-DD）：〈標題〉」
//   裁示＝第一行「## ⚖️ 〈裁示者識別值〉 裁示（YYYY-MM-DD）：〈標題〉」＋一行「原話（對話中，〈識別值〉 轉述）：**「…」**」，
//         **而且要由裁示者的貼文帳號貼的**（別人貼的裁示不算，會另列成疑似）
//   撤回＝第一行「## 🚫 撤回（YYYY-MM-DD）：〈標題〉」＋「撤回理由：〈三選一〉（依據）」＋「〈識別值〉 撤回、〈裁示者〉 未回；他隨時可以要我重問」
// 配對＝裁示或撤回的內文（引用區塊以外）出現原 ❓ 留言的編號（貼網址就自然含有），而且比 ❓ 晚。
// 已裁與已撤回一定印出來、附配對，讓錯的配對看得見；長得像但形狀不合的另列成疑似。
// 第一行＝原文第一個非空行；原話、撤回理由、自報句、配對只讀**開頭那一段**（讀到第一個引用、程式碼、表格分隔列、HTML、圖片、
// 連結定義、縮排之類的特殊行為止；規則只有一份＝tools/markdown-effective.js）。所以這些要緊接在標題下寫。
//
// 掃整個專案的留言（平台動作 allComments）：題目所屬的變更關了照樣列、裁示貼在別支照樣配（搬家驗屋 09-13 前只掃開著的變更）。
// 誠實劃界：「已裁」是推導不是事實（引了編號不等於
// 在回答它）；原話那一行只驗形狀，驗不出引號裡是不是他真的說的；分頁是那條登記指令的責任。
// 退出碼：0＝算出來了（含「沒有還沒回的」）；2＝算不出來（設定沒填、平台問不到）。刻意沒有 1。
'use strict';
const { ask, PlatformError } = require('./platform.js');
const { read: readSettings } = require('./settings-data.js');

const UNSET = '未設定';
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ASK = /^## ❓ 待裁（(\d{4}-\d{2}-\d{2})）：(\S.*)$/u;
const WITHDRAW = /^## 🚫 撤回（(\d{4}-\d{2}-\d{2})）：(\S.*)$/u;
const WITHDRAW_REASON = /^撤回理由：(題目依附的東西沒了|問題本身問錯了|跟另一則 ❓ 重複)（[^\n）]*\S[^\n）]*）[ \t]*$/mu;
const NEAR = /❓|⚖|🚫|待裁|裁示|撤回/u;
/** 疑似那一欄逐則印幾則（其餘收成一行，總數與最早日期照印）；理由見 render()。 */
const NEAR_SHOWN = 8;

const realDate = (s) => { const m = DATE.exec(s); if (!m) return false; const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const { leadingText, stopNote } = require('./markdown-effective.js');
/**
 * 讀哪一段只有一份定義（r2 Medium③ 起共用；r5 之後換成「只讀開頭那一段」，理由在 tools/markdown-effective.js 檔頭）：
 * 原話、撤回理由、自報句、配對全部從同一段取；引用、圍欄、註解裡的範例因此都讀不到。
 */
const clean = (body) => leadingText(body);
/** 第一行＝原文第一個非空行（跟結論閘的標頭同一條窄路，不經過上面那一段的判斷）。 */
const firstLine = (body) => String(body || '').replace(/\r\n?/g, '\n').split('\n').find((l) => l.trim()) || '';
const readPart = clean;
const TRACE_HEAD = /^## (?:❓|⚖|🚫)/mu;
// 編號要整個對上：前後不可以再接字母或數字（c1 不可以命中 c12）；但連字號與底線算邊界——網址尾碼是「issuecomment-<編號>」。
const cites = (body, id) => new RegExp(`(?<![0-9A-Za-z])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`, 'u').test(readPart(body));

const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 裁示者：角色以「裁示者」開頭的那一位；識別值與帳號都要填。順便帶回全部登記的識別值與帳號。 */
function deciderOf(settings) {
  const all = Array.isArray(settings.participants) ? settings.participants : [];
  const p = all.find((x) => x && typeof x.role === 'string' && x.role.startsWith('裁示者'));
  if (!p || !p.id || p.id === UNSET || !p.account || p.account === UNSET) return null;
  const ids = all.map((x) => x && x.id).filter((v) => typeof v === 'string' && v && v !== UNSET);
  const accounts = all.map((x) => x && x.account).filter((v) => typeof v === 'string' && v && v !== UNSET);
  return { id: p.id, account: p.account, ids, accounts };
}

/**
 * 純判斷層。comments＝[{ id, author, body, createdAt, change }]（change＝所屬變更編號，只用來印）。
 */
const { parseInstant } = require('./time-point.js');
// 時間走共用契約（r3 High①）：沒帶時區的時間在不同執行機器會判出不同先後，不收
const at = (c) => { const v = parseInstant(c.createdAt); return v === null ? NaN : v; };

function evaluate(comments, decider) {
  // 時間契約（r2 Medium④）：每一則的時間都要讀得出，先後用時間值比——字串比會讓不同時區的合法寫法排錯，
  // 一則其實比問題早的裁示會把後來的問題關掉。讀不出＝整份算不出來，由呼叫端退 2。
  if (comments.some((c) => !Number.isFinite(at(c)))) return { open: [], ruled: [], withdrawn: [], near: [], unsure: '有留言的時間讀不出來或沒帶時區' };
  const ids = decider.ids && decider.ids.length ? decider.ids : [decider.id];
  const accounts = new Set(decider.accounts && decider.accounts.length ? decider.accounts : [decider.account]);
  const idAlt = `(?:${ids.map(esc).join('|')})`;
  const rulingRe = new RegExp(`^## ⚖️? ${esc(decider.id)} 裁示（(\\d{4}-\\d{2}-\\d{2})）：(\\S.*)$`, 'u');
  // 轉述者的識別值必須是登記過的、不帶任何記號（範本明說角色包粗體＝不合；r1 Medium⑨）
  const quoteRe = new RegExp(`^原話（對話中，${idAlt} 轉述）：\\*\\*「.+」\\*\\*[ \\t]*$`, 'mu');
  const withdrawSelf = new RegExp(`^${idAlt} 撤回、${esc(decider.id)} 未回；他隨時可以要我重問[ \\t]*$`, 'mu');
  const asks = [];
  const rulings = [];
  const withdraws = [];
  const near = [];
  const sorted = [...comments].sort((a, b) => at(a) - at(b));
  for (const c of sorted) {
    const first = firstLine(c.body);
    // 三種留痕都只採計登記過的貼文帳號（設定的貼文帳號資格；r1 Medium⑧：原本只有裁示看帳號，外人能撤掉待裁）
    if (!accounts.has(c.author) && (ASK.test(first) || WITHDRAW.test(first) || rulingRe.test(first))) {
      near.push({ ...c, why: `不是登記的貼文帳號貼的（${c.author}），不採計` });
      continue;
    }
    const a = ASK.exec(first);
    if (a) {
      if (!realDate(a[1])) { near.push({ ...c, why: '日期不是真的日子' }); continue; }
      asks.push({ ...c, date: a[1], title: a[2].trim() });
      continue;
    }
    const r = rulingRe.exec(first);
    if (r) {
      if (!realDate(r[1])) { near.push({ ...c, why: '日期不是真的日子' }); continue; }
      if (c.author !== decider.account) { near.push({ ...c, why: `裁示不是裁示者的帳號貼的（${c.author}）` }); continue; }
      if (!quoteRe.test(clean(c.body))) { near.push({ ...c, why: `少了「原話（對話中，〈登記的識別值〉 轉述）：**「…」**」那一行（轉述者要是登記的識別值、不帶記號）${stopNote(c.body)}` }); continue; }
      rulings.push({ ...c, date: r[1], title: r[2].trim() });
      continue;
    }
    const w = WITHDRAW.exec(first);
    if (w) {
      if (!realDate(w[1])) { near.push({ ...c, why: '日期不是真的日子' }); continue; }
      if (!WITHDRAW_REASON.test(clean(c.body))) { near.push({ ...c, why: `撤回理由不是三選一、或沒有具體依據${stopNote(c.body)}` }); continue; }
      if (!withdrawSelf.test(clean(c.body))) { near.push({ ...c, why: `少了「〈登記的識別值〉 撤回、〈裁示者〉 未回；他隨時可以要我重問」那一行${stopNote(c.body)}` }); continue; }
      withdraws.push({ ...c, date: w[1], title: w[2].trim() });
      continue;
    }
    if (NEAR.test(first)) near.push({ ...c, why: '第一行長得像留痕、但形狀不合範本' });
    else if (TRACE_HEAD.test(c.body)) near.push({ ...c, why: '內文有留痕的標題、但不在第一行（標題前面不可以有別的字）' });
  }
  const open = [];
  const ruled = [];
  const withdrawn = [];
  for (const q of asks) {
    const later = (x) => at(x) > at(q);
    const r = rulings.find((x) => later(x) && cites(x.body, q.id));
    if (r) { ruled.push({ ask: q, by: r }); continue; }
    const w = withdraws.find((x) => later(x) && cites(x.body, q.id));
    if (w) { withdrawn.push({ ask: q, by: w }); continue; }
    open.push(q);
  }
  // r6 Low②：形狀合格、卻沒配到任何問題的裁示或撤回，讀的那段又有停下來＝多半是網址寫在停止點之後。列疑似、說停在第幾行，
  // 不然題目只是靜靜留在待裁、看不出為什麼。沒停下來的照舊不列（可能在回答已關掉的變更上的題）。
  // r7 Low②：「配得到」要看它能不能命中**任一**比它早的問題，不能借用上面選出來的代表——同一題的第二則補充裁示不是代表，卻配得到
  const matchesAny = (x) => asks.some((q) => at(x) > at(q) && cites(x.body, q.id));
  for (const x of [...rulings, ...withdraws]) {
    if (!matchesAny(x) && stopNote(x.body)) near.push({ ...x, why: `沒有配到任何比它早的問題${stopNote(x.body)}` });
  }
  // 疑似是分兩輪蒐集的（上面那一輪照時間、這一輪接在尾巴），所以 near 裡的位置**不是**平台給的順序。
  // 印法在同一秒時要靠平台順序決定誰後到，所以在這裡把平台給的原始位置帶上（判斷完全不看它）。
  const posOf = new Map(comments.map((c, i) => [c.id, i]));
  for (const n of near) n.pos = posOf.has(n.id) ? posOf.get(n.id) : -1;
  return { open, ruled, withdrawn, near };
}

function render({ open, ruled, withdrawn, near }) {
  const lines = [];
  const where = (c) => `變更 ${c.change}｜留言 ${c.id}`;
  lines.push(`還沒回：${open.length} 則`);
  for (const q of open) lines.push(`  ・${q.date}｜${q.title}｜${where(q)}`);
  lines.push(`已裁：${ruled.length} 則（配對是推導，錯的看得見）`);
  for (const { ask: q, by } of ruled) lines.push(`  ・${q.title}｜問：${where(q)}｜裁：${by.date}，${where(by)}`);
  lines.push(`已撤回：${withdrawn.length} 則`);
  for (const { ask: q, by } of withdrawn) lines.push(`  ・${q.title}｜問：${where(q)}｜撤：${by.date}，${where(by)}`);
  if (near.length) {
    // 這一欄的用途是「**今天**寫壞的那一則要被看見」（寫壞＝配不到題，那一題會一直掛在還沒回，
    // 而貼的人以為早就回完了）。所以照時間**新到舊**排、只逐則印最近 NEAR_SHOWN 則，其餘收成一行——
    // 照留言原本的順序印時最舊的在最上面，今天那一則排在最後，這一欄等於失效（第一個使用專案真語料 38 則）。
    // 為什麼不是「哪一天換範本之前算舊的」（裁示者 2026-09-20 裁 a）：那要在每個專案的設定多一格切換日，
    // 每個使用專案都得補、補之前它自己的考卷會紅，而且那個日期本身是要維護的事實。這裡只用新舊排序，
    // **不宣稱**分得出「換範本以前的」與「今天寫錯的」。
    // ⚠️ **守不到（照實寫，不要擴大也不要縮小）**：收起來的那些只交代「有幾則、最早哪一天」，
    //   ①排序用留言的**建立**時間、事後編輯不改它 ⇒ 一則舊留言被編輯成寫壞的裁示紀錄，整份輸出**可能
    //     逐字相同**（連總數與最早日期都沒變）——審查者實測過兩種：它本來就在疑似裡又排不進最近幾則
    //     （被收起來），以及它**有**逐則列出、但改的是逐則那一行印不到的地方（逐則只印日期、位置、
    //     原因、第一行前 60 字——原話改一個字、內文改一段，都看不出來）。
    //     反過來也不是必然：本來是合格的裁示／合格的 ❓／普通留言時，編輯之後還沒回、已裁或疑似的
    //     數字會變，輸出就不一樣；「疑似一增一減抵銷總數」是**另一種**情形（兩則對沖）。
    //     所以「靠總數變動察覺」是假的，不要這樣宣稱。
    //     ⚠️ 同一秒時，把一則從第一輪疑似改成第二輪疑似（或反過來）會換掉它在平台順序裡的相對位置嗎？
    //     不會——決勝鍵讀的是**平台給的原始位置**（evaluate 帶上來的 pos），不是它在 near 裡的位置。
    //   ②「要被看見」**不等於**「一定在最上面」：只要還有更新的疑似，今天那一則就排在它們後面；
    //     更新的超過 NEAR_SHOWN 則時，今天那一則一樣會被收進那一行。
    //   ③同一秒：下面用「平台給的順序在後面的算後到」當決勝鍵（GitHub 的留言照建立時間遞增給）
    //     ——那是**推論不是保證**，平台改順序就不成立。
    //   ④每一則前面與收合行的日期都是 **UTC 日**（排序比的是瞬間值、不受影響）：台北 00:00〜07:59
    //     貼的會印成前一天。這樣印是為了讓輸出不跟著機器時區跑，考題才釘得住。
    const day = (c) => (Number.isFinite(at(c)) ? new Date(at(c)).toISOString().slice(0, 10) : '時間讀不出來');
    // 新到舊；同一秒時「平台給的原始順序在後面的」排前面（守不到③），不然剛貼的那一則會被擠進收合行。
    // ⚠️ 用 evaluate 帶上來的 `pos`（＝平台原始位置），**不可以**用它在 near 裡的位置：疑似是分兩輪蒐集的，
    //   第二輪那一族接在尾巴，拿 near 的位置當決勝鍵會把剛貼的那一則擠出清單（#628 複審後掃 r3 的回歸）。
    const posOf = (x) => (Number.isFinite(x.pos) ? x.pos : -1);
    const sorted = [...near].sort((a, b) => (at(b) - at(a)) || (posOf(b) - posOf(a)));
    const shown = sorted.slice(0, NEAR_SHOWN);
    const rest = sorted.slice(NEAR_SHOWN);
    lines.push(`疑似（長得像留痕但不採計）：${near.length} 則${rest.length ? `，以下列最近 ${shown.length} 則` : ''}`);
    for (const n of shown) lines.push(`  ・${day(n)}｜${where(n)}：${n.why}——「${firstLine(n.body).slice(0, 60)}」`);
    // 收合那一行**不說「更早」**（r1 第 2 條）：同一秒的留言可能剛好跨過上限，第 NEAR_SHOWN+1 則其實與前面同時。
    if (rest.length) lines.push(`  ・另有 ${rest.length} 則（最早 ${day(rest[rest.length - 1])}），不逐則列`);
  }
  return lines;
}

function run({ settings = readSettings(), platform = { ask } } = {}) {
  const decider = deciderOf(settings);
  if (!decider) return { code: 2, lines: ['專案設定裡的裁示者識別值或貼文帳號還沒填：分不出誰的裁示算數，算不出來。'] };
  // 掃整個專案的留言，不是只掃開著的變更（搬家驗屋 09-13：題目問在某支變更上、那一支先合併了而裁示者還沒回，
  // 只掃開著的就讓那一題從清單消失、印「還沒回：0 則」；原專案真語料 12 題裡 4 題是這個形狀）
  let comments;
  try {
    comments = platform.ask('allComments', {}, { settings });
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) return { code: 2, lines: [`待裁清單：問不到平台（${e.message}）——算不出來。`] };
    throw e;
  }
  const result = evaluate(comments, decider);
  if (result.unsure) return { code: 2, lines: [`待裁清單：${result.unsure}——先後判不了，算不出來（不會把任何題移出待裁）。`] };
  const changes = new Set(comments.map((c) => c.change));
  const lines = [`待裁清單（掃了整個專案 ${changes.size} 支變更、${comments.length} 則留言；含已關的變更）`, ...render(result)];
  return { code: 0, lines };
}

/**
 * 指令列不收任何參數（搬家前準備）：原專案的同名工具有 --all／--pr，搬過來的人照舊習慣打 --pr 5，
 * 原本會被靜靜忽略、印出整個專案的清單，讓人以為那是只看那一支的結果。不認得就退 2 並說清楚。
 */
function cliArgsProblem(argv) {
  return argv.length ? `待裁清單不收任何參數（收到：${argv.join(' ')}）：它一律掃整個專案的留言。用法：node tools/pending-rulings.js` : null;
}

if (require.main === module) {
  let result;
  const argProblem = cliArgsProblem(process.argv.slice(2));
  try { result = argProblem ? { code: 2, lines: [argProblem] } : run(); } catch (e) { result = { code: 2, lines: [`待裁清單：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——算不出來。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { run, evaluate, render, deciderOf, cites, realDate, readPart, cliArgsProblem };
