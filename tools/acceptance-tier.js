#!/usr/bin/env node
// 合併後驗收分級（規矩 H6）：這一支變更動到哪些路徑家族，就算出合併後要驗到什麼程度、做哪些動作。
//
// 為什麼：不是每一支合併後都要請裁示者重啟走一遍；但要不要，靠人記會漏。分級的正本住在專案設定
// （路徑家族表＋每一級的動作），這支只算不擋。它讓裁示者少做不必要的驗收、也不漏掉必要的。
//
// 兩條規矩：①動作累積——命中幾級就做幾級的動作，回報的級別寫最重的那一級；
//           ②沒列到的路徑一律當設定裡指定的那一級（fail-closed，通常是最重的）並列出來——不確定就往重的算。
// 改名或複製前的舊路徑也算（那也是這支動到的地方）。
//
// 退出碼：0＝算出來了／2＝算不出來（設定沒填、平台問不到、沒有路徑）。⚠️ 不是閘。
'use strict';
const { ask, PlatformError } = require('./platform.js');
const { read: readSettings } = require('./settings-data.js');

const UNSET = '未設定';

/**
 * 讀設定裡的分級表；形狀不對＝null。tiers 從最重排到最輕。
 * ⚠️ **有一筆壞就整張不算**，不濾掉（搬家前準備，驗屋 AT-8）：濾掉一筆家族＝那一族的路徑靜靜落到「沒列到」那一級，
 *    表看起來還能用、級別卻可能變輕。家族樣式必須以 ^ 開頭：沒錨定的樣式會命中路徑中段（lib/ 也命中 public/lib/x）。
 *    樣式不是合法正規式也算壞（原本會在這裡丟例外）。
 */
function tableOf(settings) {
  const a = settings.acceptance || {};
  if (!Array.isArray(a.tiers) || !Array.isArray(a.families) || !a.tiers.length || !a.families.length) return null;
  const goodTier = (t) => t && typeof t.id === 'string' && t.id.trim() && t.id !== UNSET && typeof t.action === 'string' && t.action.trim() && t.action !== UNSET;
  if (!a.tiers.every(goodTier)) return null;
  const tiers = a.tiers;
  const families = [];
  for (const f of a.families) {
    if (!f || typeof f.pattern !== 'string' || !f.pattern.startsWith('^') || typeof f.tier !== 'string' || !tiers.some((t) => t.id === f.tier)) return null;
    let re;
    try { re = new RegExp(f.pattern, 'u'); } catch { return null; }
    families.push({ re, tier: f.tier });
  }
  if (typeof a.unknownTier !== 'string' || !tiers.some((t) => t.id === a.unknownTier)) return null;
  return { tiers, families, unknownTier: a.unknownTier };
}

/** 純判斷層。 */
function classify(paths, table) {
  const hits = paths.map((p) => {
    const f = table.families.find((x) => x.re.test(p));
    return f ? { path: p, tier: f.tier, known: true } : { path: p, tier: table.unknownTier, known: false };
  });
  const present = new Set(hits.map((h) => h.tier));
  const level = table.tiers.find((t) => present.has(t.id));
  const actions = table.tiers.filter((t) => present.has(t.id)).map((t) => ({ tier: t.id, action: t.action }));
  return { level: level ? level.id : null, hits, unknown: hits.filter((h) => !h.known).map((h) => h.path), actions };
}

function run(changeId, { settings = readSettings(), platform = { ask } } = {}) {
  if (!changeId) return { code: 2, lines: ['用法：node tools/acceptance-tier.js <變更編號>'] };
  const table = tableOf(settings);
  if (!table) return { code: 2, lines: ['專案設定裡的驗收分級表沒填好（tiers、families、unknownTier 要齊、unknownTier 與每個家族的 tier 都要在 tiers 裡）：算不出來。'] };
  let files;
  let change;
  try {
    change = platform.ask('change', { change: String(changeId) }, { settings });
    files = platform.ask('changedFiles', { change: String(changeId) }, { settings });
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) return { code: 2, lines: [`驗收分級：問不到平台（${e.message}）——算不出來。`] };
    throw e;
  }
  // 改名或複製的檔沒帶舊路徑＝清單不合契約（r1 Medium⑦）：舊路徑驗不到就不能只算輕的那一半
  const halfRenamed = files.find((f) => /^(renamed|copied)$/u.test(String(f.status)) && !f.previousPath);
  if (halfRenamed) return { code: 2, lines: [`檔案清單裡「${halfRenamed.path}」標成 ${halfRenamed.status} 卻沒帶舊路徑：舊路徑驗不到，算不出來。`] };
  // 平台有自報總數就對帳：少給幾筆就不能印出一個看起來很輕的級別（平台的檔案端點有筆數上限）
  let countNote = '（平台沒自報總數，清單完整性沒對帳）';
  if (change.changedFileCount !== null) {
    if (!/^\d+$/u.test(change.changedFileCount)) return { code: 2, lines: [`平台自報的檔數「${change.changedFileCount}」不是數字：對不了帳，算不出來。`] };
    if (Number(change.changedFileCount) !== files.length) return { code: 2, lines: [`平台自報這支動了 ${change.changedFileCount} 個檔，清單只拿到 ${files.length} 筆：清單不完整（可能超過平台的筆數上限），算不出來。`] };
    countNote = `（清單 ${files.length} 筆與平台自報總數相符）`;
  }
  const paths = [...new Set(files.flatMap((f) => [f.path, f.previousPath].filter(Boolean)))];
  if (!paths.length) return { code: 2, lines: ['這一支變更沒有動到任何檔案：算不出來（不猜）。'] };
  const r = classify(paths, table);
  const lines = [`驗收分級｜變更 ${changeId}：${r.level}（動到 ${paths.length} 個路徑）${countNote}`];
  for (const a of r.actions) lines.push(`  ・${a.tier}：${a.action}`);
  if (r.unknown.length) lines.push(`  ⚠️ 沒列在家族表上的路徑，一律當「${table.unknownTier}」：${r.unknown.join('、')}——改表的人要核對它們該屬哪一級。`);
  return { code: 0, lines, result: r };
}

if (require.main === module) {
  let result;
  try { result = run(process.argv[2]); } catch (e) { result = { code: 2, lines: [`驗收分級：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——算不出來。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { run, classify, tableOf };
