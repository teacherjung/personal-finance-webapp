#!/usr/bin/env node
// 協作欄位閘（規矩 A2、E1）：變更說明的四個欄位要齊全，而且實作者不可以等於獨立審查者。
//
// 為什麼要有它：「沒有任何一份產出由寫它的人放行」這條在版本控制與平台上**不留任何痕跡**——
// 原專案量過：四十支已合併變更的「誰按的鍵」全是同一個帳號（兩個 AI 共用），平台的審查紀錄全部是零。
// 唯一還看得見分工的地方就是變更說明裡那幾欄，而它靠記憶維持，實測連續三支漏填。
// 所以範本管「寫得出來」，這支管「沒寫就合不了」。兩個都沒有的話，那條不變量只是一句話。
//
// ## 這支被繞過的每一種寫法，都對應下面一段程式碼，**不要簡化掉**
//
// ①**只讀說明開頭那一段**：從第一行讀到第一個特殊行（引用、程式碼圍欄、表格分隔列、HTML 與註解、圖片、連結定義、縮排…）為止。
//   註解、圍欄、引用裡的「範例欄位」因此都讀不到；欄位要寫在最前面（範本本來就這樣排）。讀到哪一行停，印進訊息。
//   規則只有一份＝tools/markdown-effective.js（r1〜r5 連五輪在「畫面上看得到哪些字」上中刀之後換的做法，理由在那支檔頭）。
// ②**欄名要錨在行首**：不錨的話「非實作者：某某」也會命中，整份說明一個真欄位都沒有卻judged齊全。
// ③**冒號後只吃水平空白**：吃掉換行的話，「這一欄留空」會抓到下一行的內容，空範本看起來每欄都填了。
// ④**角色要剛好命中一個，不可以用「包含」判斷**：用包含的話，「NotClaude」含有「Claude」、
//   「Claude and Codex」也含有「Claude」——同一人自審與模糊多人都繞得過。
// ⑤**正規化只做一次、做在最前面**：否則「外層乾淨、括號裡藏全形或零寬字元」會溜過去。
//   根因是同一個字串有兩種形式在流動。
// ⑥**括號裡藏第二個角色不算單一角色**：「甲（乙）」剝掉括號會變成乾淨的「甲」。
// ⑧**圍欄與引用裡的欄位不算填了**：只有程式碼範例或引用範例裡有四欄，整份說明還是空的（r2 Medium③）——由①一併擋住。
// ⑦**混用文字系統＝看不出是誰**：有些字母在螢幕上跟拉丁字母長得一樣但其實是不同的字，
//   正規化折不掉。角色名只用拉丁字母，所以拉丁詞裡混進別種字母就整欄判「看不出是誰」。
//   不做一張對照表——那種表永遠列不完。
//
// 角色名單來自專案設定的參與者識別值，不寫死。平台的事一律走 tools/platform.js。
'use strict';
const { ask, PlatformError } = require('../platform.js');
const { read: readSettings } = require('../settings-data.js');
const { leadingText, stopNote } = require('../markdown-effective.js');

const UNSET = '未設定';

/** 必填欄位。這份清單是單一真相，範本 templates/pr-body.md 照它寫。 */
const REQUIRED_FIELDS = ['實作者', '獨立審查者', '預計修改的共享檔案', '這支若完全失敗，最糟失去什麼'];

/**
 * 讀一個欄位的值。見檔頭①②③。
 * ⑧（r2 Medium③）：讀哪一段只有一份定義——程式碼圍欄裡的「範例欄位」、引用裡的「範例欄位」都不算填了（r5 之後：只讀開頭那一段）；
 *    否則整份說明只有一段範例就能通過這道閘，還替結論閘提供一位假的「指定審查者」。
 */
function fieldValue(body, field) {
  // ①：只讀開頭那一段（結論聯集閘也用這支讀「獨立審查者」，守在這裡就不會有呼叫點漏接）
  const clean = leadingText(body);
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 行首可有項目符號（含有序清單）與水平空白，欄名可被粗體記號包住，然後才是冒號。
  // 引言記號刻意不接受：那是引用範例，不該滿足這道閘。
  const re = new RegExp(`^[^\\S\\n]*(?:(?:[-*+]|\\d+[.)])[^\\S\\n]*)?(?:\\*\\*|__)?${esc}(?:\\*\\*|__)?[^\\S\\n]*[:：][^\\S\\n]*(.*)$`, 'm');
  const m = clean.match(re);
  return m ? m[1].trim().replace(/^\*+|\*+$/g, '').trim() : '';
}

/** 角色偵測的唯一正規化管線。見檔頭⑤：四層各擋一類藏法，少一層就有對應的繞法。 */
function normalize(v) {
  return String(v || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Cf}/gu, '');
}

/** 把欄位值正規化成剛好一個角色；看不出來或不只一個就回 null。見檔頭④⑥⑦。 */
function canonicalRole(raw, roles) {
  const bare = normalize(raw).replace(/[`*_~]/g, '');
  if (/\p{Script=Latin}/u.test(bare)) {
    for (const ch of bare) {
      if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch) && !/\p{Script=Han}/u.test(ch)) return null;
    }
  }
  for (const inner of bare.match(/\([^)]*\)/g) || []) {
    if (roles.some((r) => inner.toLowerCase().includes(r.toLowerCase()))) return null;
  }
  const t = bare.replace(/\([^)]*\)/g, '').replace(/\s+/gu, '').trim();
  if (!t) return null;
  const hit = roles.filter((r) => r.toLowerCase() === t.toLowerCase());
  return hit.length === 1 ? hit[0] : null;
}

/**
 * 純判斷層。回傳問題清單（空陣列＝通過）。
 * @param {string} body 變更說明
 * @param {string[]} roles 專案設定裡的參與者識別值
 */
function problemsOf(body, roles) {
  const problems = [];
  const got = {};
  for (const f of REQUIRED_FIELDS) {
    got[f] = fieldValue(body, f);
    if (!got[f]) problems.push(`缺「${f}」`);
  }
  if (problems.length && stopNote(body)) problems.push(stopNote(body));
  const implRaw = got['實作者'];
  const revRaw = got['獨立審查者'];
  const impl = canonicalRole(implRaw, roles);
  const rev = canonicalRole(revRaw, roles);
  for (const [label, raw, role] of [['實作者', implRaw, impl], ['獨立審查者', revRaw, rev]]) {
    if (raw && !role) {
      problems.push(`「${label}」寫成「${raw}」，必須剛好是 ${roles.join('／')} 的其中一個（不接受加註、多人並列、或看不出是誰的寫法）`);
    }
  }
  if (impl && rev && impl === rev) {
    problems.push(`實作者與獨立審查者都是「${impl}」——沒有任何一份產出可以由寫它的人放行`);
  }
  return problems;
}

/** 從專案設定取角色名單。沒填、含未設定、非純拉丁字母都不算數（識別值的值域寫在設定裡）。 */
function rolesOf(settings) {
  const list = Array.isArray(settings.participants) ? settings.participants : [];
  const ids = list.map((p) => (p && typeof p.id === 'string' ? p.id.trim() : '')).filter(Boolean);
  const usable = ids.filter((id) => id !== UNSET && /^[A-Za-z]+$/u.test(id));
  return { ids, usable };
}

/** 跑這道閘。平台查不到、設定沒填，一律退 2。 */
function gateRun(changeId, { settings = readSettings(), platform = { ask } } = {}) {
  const lines = [];
  if (!changeId) return { code: 2, lines: ['用法：node tools/gates/check-collab-fields.js <變更編號>'] };
  const { ids, usable } = rolesOf(settings);
  if (usable.length < 2) {
    return {
      code: 2,
      lines: [`專案設定裡可用的參與者識別值只有 ${usable.length} 個（登記了 ${ids.length} 個）：`
        + '至少要兩個純拉丁字母的識別值，才判得出「實作者不等於獨立審查者」，不放行。'],
    };
  }
  let change;
  try {
    change = platform.ask('change', { change: String(changeId) }, { settings });
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) {
      lines.push(`協作欄位閘：問不到平台（${e.message}）——查不到就不是安全，不放行。`);
      return { code: 2, lines };
    }
    throw e;
  }
  const problems = problemsOf(change.body, usable);
  if (problems.length) {
    lines.push(`協作欄位閘｜變更 ${changeId}：${problems.length} 個問題`);
    for (const p of problems) lines.push(`   ・${p}`);
    lines.push('補齊再合併。範本在 templates/pr-body.md。');
    return { code: 1, lines };
  }
  lines.push(`協作欄位閘｜變更 ${changeId}：四欄齊全，實作者與獨立審查者不是同一位`);
  return { code: 0, lines };
}

if (require.main === module) {
  let result;
  try { result = gateRun(process.argv[2]); }
  catch (e) { result = { code: 2, lines: [`協作欄位閘：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——不放行。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { gateRun, problemsOf, fieldValue, canonicalRole, normalize, rolesOf, REQUIRED_FIELDS };
