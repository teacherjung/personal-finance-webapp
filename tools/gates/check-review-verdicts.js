#!/usr/bin/env node
// 結論聯集閘（規矩 F4、F5）：每一位審查者的阻擋，在同一位用更高輪次撤銷之前都有效；
// 放行只認變更說明指定的那一位對**目前版本**說的「通過」。
//
// 為什麼要有它：原專案實測，同一支變更上出現兩則都自稱同一角色的複審、結論相反，平台上兩則
// 顯示同一個帳號，沒有任何辦法分辨。危險的不是有兩份，是「看起來一樣有效而結論相反」，於是
// 「最後一則說通過」就變成事實上的放行。所以：①每則結論第一行是機器讀得懂的標頭；②取聯集，
// 沒有「最後一則說了算」；③放行只認指定的那一位——否則實作者自己說一句通過就放行了自己的變更。
//
// 這支讓裁示者不必自己讀審查串：機器替他回答「有沒有人還在喊停、指定的那位有沒有對現在這一版點頭」。
//
// ## 身分＝角色＋來源，來源只摺疊空白
// 同一個工具跨輪次把來源打成兩種寫法，會被拆成兩位（原專案踩過：自己的阻擋撤不掉）。
// 這支不自動併身分（併了等於削弱這道閘），只在兩個來源長得像時出聲提醒。
//
// ## 標頭打錯字怎麼救（裁示者 2026-09-13 裁「甲」＝用這個簡化版；比原專案簡單很多，理由在檔尾）
// 有 🤖 記號但標頭讀不出＝擋；救法＝任何一位審查者在**新的合規留言**標頭之後緊接一行
// 「作廢上一則：<那則留言的編號>」。作廢只會把「標頭寫壞」那條阻擋降為提醒，不產生任何結論、
// 作廢不了合規的留言、也作廢不了比自己晚出現的留言。壞留言原地保留，稽核軌跡不動。
//
// 誠實劃界：它讀的是留言裡的自我宣告，不是身分證明。要繞過它，改標頭裡的來源就好——
// 那要靠獨立帳號才擋得住。它防的是混淆與遺漏，不是惡意。
//
// 退出碼：0＝指定審查者對目前版本說通過、且沒有未撤銷的阻擋／1＝未通過／2＝查不清楚（一律當未通過）。
'use strict';
const { ask, PlatformError } = require('../platform.js');
const { read: readSettings } = require('../settings-data.js');
const { fieldValue, canonicalRole, rolesOf } = require('./check-collab-fields.js');
const { leadingText, stopNote } = require('../markdown-effective.js');
const { parseInstant } = require('../time-point.js');

/** 結論只認這三種，寫別的等於沒下結論。字串與 templates/verdict-header.md、規矩 F3 逐字相同。 */
const VERDICTS = { 通過: false, 需修改後再審: true, 不可合併: true };

/**
 * 來歷標頭：刻意是可見的一行、不是註解（註解在畫面上看不見，原專案三次「藏在註解裡就繞過」）。
 * 不接受引用與清單前綴——引用別人的標頭不該算成一則新結論。只容許粗體包裝與水平空白。
 * 逐字：🤖 <角色>｜來源：<來源字串>｜審 `<短版本碼>`｜r<輪次>｜結論：<三選一>
 */
const HEADER = /^[^\S\n]*(?:\*\*|__)?[^\S\n]*🤖\s*([A-Za-z]+)｜來源：([^｜]+)｜審\s*`?([0-9a-fA-F]{7,40})`?｜r(\d+)｜結論：(\S+?)(?:\*\*|__)?\s*$/mu;
/** 作廢行：逐字「作廢上一則：<留言編號>」。 */
const VOID = /^ {0,3}作廢上一則：([A-Za-z0-9_-]+)[^\S\n]*$/u;


/** 從一則留言抽標頭。抓不到就回 null（呼叫端決定那算不算問題）。 */
function headerOf(body, roles) {
  const first = String(body || '').split('\n').find((l) => l.trim()) || '';
  const m = HEADER.exec(first);
  if (!m) return null;
  const verdict = m[5].replace(/[。．.]$/u, '');
  // 用 hasOwn 不用 in：in 會命中原型鍵，「toString」會被當成第四種結論
  if (!Object.hasOwn(VERDICTS, verdict)) return null;
  // 來源不可以是空白：兩個都漏填時會被併成同一位，第二位的通過就撤銷了第一位的阻擋
  if (!m[2].trim()) return null;
  // 角色要走 canonicalRole，不能收任意英文字：打錯字的角色會變成一位「幽靈審查者」，它的阻擋永遠撤不掉
  const role = canonicalRole(m[1], roles);
  if (!role) return null;
  return {
    role,
    source: m[2].trim().replace(/\s+/gu, ' '),
    sha: m[3].toLowerCase(),
    round: Number(m[4]),
    verdict,
    blocking: VERDICTS[verdict],
  };
}

/**
 * 這則留言想用標頭但寫壞了——判準是**整份原文**出現 🤖，什麼都不剝（r5：剝引用、圍欄、註解、行內程式碼，
 * 每一種剝法都在某種正常寫法上把看得見的 🤖 吞掉過，而吞掉＝壞標頭被放行）。範本本來就寫明非結論留言不可含 🤖，
 * 所以不剝不增加新的寫作義務；要示範標頭長相時用文字描述，或寫錯了用「作廢上一則」救。
 */
function hasBotMark(body) {
  return /🤖/u.test(String(body || ''));
}

/**
 * 沒標頭的留言看起來像不像在下結論——**只用來提醒，不是判準**。
 * 放行判準不靠它：沒標頭的留言對這道閘沒有效力，既不能放行也不算撤銷。
 * 它防的是「有人以為自己喊了停，但因為沒帶標頭而被無視」。
 * 判法刻意簡單：開頭那一段扣掉行內程式碼之後，出現三種結論用詞之一就提醒。
 * 誤提醒的代價是一句話；原專案為了少提醒幾句寫了一百行、被繞過八輪——那些行不值得搬。
 */
function looksLikeVerdict(body) {
  // 只讀開頭那一段（tools/markdown-effective.js）再扣行內程式碼；這支只影響提醒，讀少了頂多少一句提醒
  const text = leadingText(body).replace(/(`+)[^`]*\1/gu, '');
  return Object.keys(VERDICTS).some((v) => text.includes(v));
}

/** 標頭之後緊接的收件區：只准空行隔開，碰到第一行別的內容就停。任何容器都插不進標頭與收件區之間。 */
function voidTargets(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const headerIdx = lines.findIndex((l) => l.trim());
  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const m = VOID.exec(lines[i]);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/** 兩個來源長得像不像同一位（折全形、轉小寫、只留字母數字；相等或互相包含）。只提醒不併身分。 */
function sourceLookalike(a, b) {
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const x = norm(a);
  const y = norm(b);
  if (x.length < 3 || y.length < 3) return null;
  if (x === y) return '折全形、轉小寫、只留字母與數字之後完全相同';
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short)) return '折全形、轉小寫、只留字母與數字之後，其中一個整個包在另一個裡面';
  return null;
}

/**
 * 純判斷層。
 * @param {Array<{id:string, body:string}>} comments 依時間排序的留言
 * @param {string} head 目前版本
 * @param {string|null} reviewerRole 變更說明指定的獨立審查者；null＝讀不出來
 * @param {string[]} roles 專案設定的參與者識別值
 */
function evaluate(comments, head, reviewerRole, roles) {
  const problems = [];
  const warnings = [];
  const latest = {};
  const malformed = [];
  const voids = [];
  // 先後看**留言時間**、不看清單順序（r1 Medium⑩：平台把清單反過來給，同一組事實會判出相反結果）。
  // 時間讀不出的留言＝整支判不了，交給呼叫端退 2（gateRun 先驗過；這裡再守一次）。
  // 時間走共用契約（r3 High①）：沒帶時區的時間在不同執行機器會判出不同先後，不收
  const at = (c) => { const v = parseInstant(c.createdAt); return v === null ? NaN : v; };
  if (comments.some((c) => !Number.isFinite(at(c)))) {
    return { problems: ['有留言的時間讀不出來或沒帶時區：先後判不了，不放行。'], warnings: [], reviewers: {}, unsure: true };
  }
  comments = [...comments].sort((a, b) => at(a) - at(b));
  const byId = new Map(comments.map((c, i) => [String(c.id), i]));

  comments.forEach((c, idx) => {
    const h = headerOf(c.body, roles);
    if (!h) {
      const excerpt = `「${String(c.body).replace(/\s+/g, ' ').slice(0, 60)}…」`;
      if (hasBotMark(c.body)) malformed.push({ id: String(c.id), idx, excerpt });
      else if (looksLikeVerdict(c.body)) warnings.push(`這則留言看起來在下結論，但沒有來歷標頭，這道閘不採計它：${excerpt}`);
      return;
    }
    for (const target of voidTargets(c.body)) voids.push({ target, idx, who: `${h.role}（${h.source}）` });
    const who = `${h.role}（${h.source}）`;
    const cur = latest[who];
    if (!cur || h.round > cur.round) latest[who] = { ...h, who, shas: [h.sha] };
    else if (h.round === cur.round) {
      // 同輪次：判決必須跟留言順序無關（r2 Medium⑤）。相反結論＝不明；不同版本也＝不明。
      // ⚠️ 版本要用**集合**聚合（r3 Medium③）：短碼相容不是可傳遞的——abcdef1 跟 abcdef12、abcdef13 各自相容，
      //    但後兩者互不相容；只留「第一筆代表值」再逐一比，會讓短碼先到時把矛盾的長碼都丟掉。
      //    做法：留下這一輪全部的版本碼，取最長的那一個當代表，每一個都要是它的前綴才算同一版本。
      if (cur.conflict) { /* 已經標成不明，維持 */ }
      else if (h.blocking !== cur.blocking) {
        latest[who] = { ...cur, conflict: true, blocking: true, verdict: `同一輪（r${h.round}）出現相反結論：${cur.verdict} vs ${h.verdict}` };
      } else {
        const shas = [...cur.shas, h.sha];
        const longest = shas.reduce((a, b) => (b.length > a.length ? b : a));
        if (shas.some((x) => !longest.startsWith(x))) {
          const distinct = [...new Set(shas.map((x) => x.slice(0, 8)))];
          latest[who] = { ...cur, shas, conflict: true, blocking: true, verdict: `同一輪（r${h.round}）對不同版本各給結論（${distinct.join('、')}）：不明，要更高輪次澄清` };
        } else {
          latest[who] = { ...cur, shas, sha: longest };
        }
      }
    }
  });

  // 作廢：只能中和「標頭寫壞」那條阻擋；要作廢的那則必須存在、真的是壞標頭、而且比作廢它的留言早出現
  for (const v of voids) {
    const tIdx = byId.get(v.target);
    if (tIdx === undefined) { warnings.push(`${v.who} 要作廢留言 ${v.target}，但這支變更底下沒有那一則——不生效`); continue; }
    const m = malformed.find((x) => x.idx === tIdx);
    if (!m) { warnings.push(`${v.who} 要作廢留言 ${v.target}，但那一則不是壞標頭（合規留言與沒帶記號的留言都作廢不了）——不生效`); continue; }
    // 目標要**確實比作廢者早**（時間值嚴格小於）；同一刻證明不了先後＝不生效
    if (!(at(comments[tIdx]) < at(comments[v.idx]))) { warnings.push(`${v.who} 要作廢留言 ${v.target}，但那一則不比作廢宣告早（同刻或更晚；不可以預先作廢還沒出現的留言）——不生效`); continue; }
    m.voidedBy = v.who;
  }
  for (const m of malformed) {
    if (m.voidedBy) warnings.push(`一則壞標頭留言（編號 ${m.id}）已被 ${m.voidedBy} 作廢，原地保留、只降為提醒：${m.excerpt}`);
    else {
      problems.push(`有一則留言（編號 ${m.id}）用了 🤖 記號、但標頭格式不合規（第一行要長成「🤖 角色｜來源：…｜審 \`版本碼\`｜r<n>｜結論：${Object.keys(VERDICTS).join('／')}」）：${m.excerpt}\n`
        + `    ↳ 救法：任何一位審查者在新的合規留言標頭後緊接一行「作廢上一則：${m.id}」。作廢不產生任何結論。`);
    }
  }

  const ids = Object.values(latest);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (ids[i].role !== ids[j].role) continue;
      const why = sourceLookalike(ids[i].source, ids[j].source);
      if (why) {
        warnings.push(`「${ids[i].who}」與「${ids[j].who}」的來源${why}——這兩個可能是同一位被打成兩種寫法。`
          + '這道閘不會自動併成一位，所以其中一邊的阻擋，另一邊說通過也解不掉；每一個身分各自對目前版本補一則更高輪次的結論。');
      }
    }
  }

  const passers = ids.filter((h) => !h.blocking && head.startsWith(h.sha));
  if (!reviewerRole) {
    problems.push('讀不出變更說明指定的獨立審查者是誰——放行只認指定的那一位，讀不出就不放行。');
  } else if (!passers.some((h) => h.role === reviewerRole)) {
    problems.push(passers.length
      ? `對目前版本說「通過」的是 ${passers.map((h) => h.who).join('、')}，但變更說明指定的獨立審查者是「${reviewerRole}」——放行只認指定的那一位，否則實作者自己說一句通過就放行了自己的變更。`
      : `沒有「${reviewerRole}」對目前版本（${head.slice(0, 7)}）下過「通過」的正式結論。協作欄位只證明有人被寫成審查者，證明不了審查真的發生過。`);
  }
  for (const h of ids) {
    if (h.blocking) problems.push(`${h.who} 在 r${h.round}（審 ${h.sha}）的結論是「${h.verdict}」，還沒有被同一位撤銷。取聯集、不取最後一則：別人說通過不會解除這一條。`);
    else if (!head.startsWith(h.sha)) problems.push(`${h.who} 的「${h.verdict}」是對 ${h.sha} 說的，但目前版本是 ${head.slice(0, 7)}——分支推過之後，那個結論不再適用。`);
  }
  return { problems, warnings, reviewers: latest };
}

function gateRun(changeId, { settings = readSettings(), platform = { ask } } = {}) {
  const lines = [];
  if (!changeId) return { code: 2, lines: ['用法：node tools/gates/check-review-verdicts.js <變更編號>'] };
  const { usable } = rolesOf(settings);
  if (usable.length < 2) return { code: 2, lines: [`專案設定裡可用的參與者識別值只有 ${usable.length} 個：至少要兩個才判得出誰是誰，不放行。`] };
  let change;
  let comments;
  try {
    change = platform.ask('change', { change: String(changeId) }, { settings });
    comments = platform.ask('comments', { change: String(changeId) }, { settings });
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) {
      return { code: 2, lines: [`結論聯集閘：問不到平台（${e.message}）——查不到一律當未通過。`] };
    }
    throw e;
  }
  const reviewerRole = canonicalRole(fieldValue(change.body, '獨立審查者'), usable);
  const { problems, warnings, reviewers, unsure } = evaluate(comments, change.headSha, reviewerRole, usable);
  if (unsure) return { code: 2, lines: [`結論聯集閘：${problems[0]}——查不清楚一律當未通過。`] };
  const who = Object.values(reviewers).map((r) => `${r.who}=${r.verdict}`).join('、') || '（沒有任何帶標頭的結論）';
  for (const w of warnings) lines.push(`提醒（不影響結果）：${w}`);
  if (!problems.length) {
    lines.push(`結論聯集閘｜變更 ${changeId}：指定審查者對目前版本說通過、沒有未撤銷的阻擋。現況：${who}`);
    return { code: 0, lines };
  }
  lines.push(`結論聯集閘｜變更 ${changeId}：未通過`);
  for (const p of problems) lines.push(`   ・${p}`);
  if (!reviewerRole && stopNote(change.body)) lines.push(`   ↳ 讀不出指定審查者：${stopNote(change.body)}`);
  lines.push(`現況：${who}`);
  return { code: 1, lines };
}

if (require.main === module) {
  let result;
  try { result = gateRun(process.argv[2]); }
  catch (e) { result = { code: 2, lines: [`結論聯集閘：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——不放行。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

// ## 為什麼救濟比原專案簡單這麼多（裁示者 2026-09-13 看過這段後裁「甲」；也是給下一個接手的人）
//
// 原專案的救濟有兩套：「重述」（同一位審查者逐字引用壞行、自報版本與輪次，七條規則加缺版本碼例外）
// 與「豁免」（裁示者特准、逐字引文或雜湊指認、資格分三級）。它們合計約四百行、十幾輪審查，
// 而且最後是「停戰劃界」收場——文件自己承認對某些變體的覆蓋是列舉性的。
//
// 複雜來自一件事：重述會**產生一則結論**進聯集，所以要防它造出更高輪的通過、防它洗掉別人的阻擋、
// 防引文藏第二個版本碼、防隱形字元……每一條防線都是因為「重述有產出」。
//
// 這裡改成**作廢不產生任何東西**：它只把「標頭寫壞」那條阻擋降為提醒。沒有產出就沒有洗白路徑，
// 那七條規則的存在理由一起消失。用留言編號指認、不引文，白名單與雜湊那一族也一起消失。
// 「只有同一位能重述自己的」也拿掉：壞行的身分本來就讀不可靠（原專案為此才加豁免），
// 而威脅模型明寫「防打錯字不防惡意」——惡意者本來就能偽造整則合規標頭。
//
// 代價照實說：作廢比原專案寬——任何一位審查者都能作廢任何一則壞留言，不需要裁示者特准。
// 換來的是裁示者少一種要他親自特准的事，這正是他要的方向。

module.exports = { gateRun, evaluate, headerOf, hasBotMark, looksLikeVerdict, voidTargets, sourceLookalike, VERDICTS };
