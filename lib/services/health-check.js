// @ts-check
// 帳務體檢（第二帖，使用者定 2026-07-19）：系統主動找可疑的鑰匙／顯示名／分類問題，
// 排成「待確認佇列」讓使用者一鍵處理——把「使用者狩獵錯誤」反轉成「系統排隊給你按確認」。
//
// 設計原則（依 2026-07-19 體檢工作流的實測校準）：
// - **純唯讀**：偵測器只讀 db、毫秒級即時算，佇列本身不落地；只有「略過」持久化
//   （settings.healthDismissed＝{指紋: ISO 時間}，資料變了指紋就變、項目自動重新出現）。
// - **修正走既有端點**：rename-store（原文級名/分類）、apply-category（品牌級分類）——
//   本檔不寫入任何資料（dismiss 除外）。鑰匙類問題（D1/D2/D6/D7）學習表改不動（鑰匙由
//   程式規則決定），一鍵動作＝產生「回報文字」貼給 Claude，等第三帖規則資料化才能真正一鍵。
// - **誤報靠「略過」收斂**：偵測器寧可多報（台北101 vs 台北101停車場 是合理的兩家），
//   使用者按略過就永久安靜；絕不自動合併/自動改。
import { createHash } from 'node:crypto';
import { getDb, saveDb } from '../repo.js';
import { categorize, origFromStmtRef, isServiceFee, stripDisplayLabels } from '../statement.js';
import { resolveImportCategory } from './categories.js';
import { DEFAULT_EXPENSE } from '../../public/modules/categories.js';

/** @typedef {{id: string, type: string, chip: string, severity: number, desc: string, data: Record<string, any>}} HealthItem */
/** 回傳含 allIds（**含已略過**的全部項目編號）——dismiss 用它驗證與修剪，前端只看 items。 */

// D3 顯示名殘雜訊樣式（＝cleanStore 該清但沒清到的鏡像檢查；normalizeBranches 查「舊資料 vs 新規則」，
// 這裡查「規則本身漏掉的樣式」——新銀行格式一出現立刻現形，不用等使用者看到）
/** @type {[RegExp, string][]} */
const NOISE_PATTERNS = [
  [/[A-Z]\d{3,4}$/, '尾端定位碼'],
  [/(NEW ?TAIPEI|TAIPEI|TAOYUAN|TAICHUNG|Taipei|Taichu)$/i, '尾端城市名'],
  [/(股份有|有限公|事業股份)$/, '公司字尾殘尾'],
  [/^(連加|聯信|藍新|點點付|騰加)[*＊\-－]/, '金流前綴殘留'],
  [/\d{8,}$/, '尾端長數字'],
  [/[?？](?![）)])/, '銀行缺字符號'],
];
const INSTALLMENT_RE = /第\d+\/\d+期/;

/** 鑰匙簽名（D6）：大小寫/全半形/分隔符差異 → 同一把。 @param {string} k @returns {string} */
const keySig = (k) => k.toUpperCase().normalize('NFKC').replace(/[\s\-*＊_.．]/g, '');
// 項目指紋（r2-Codex#5）：ID 只有「主體」的話，內容變了（分期多一期、漂移的分類換了、
// 名字的雜訊變了）舊的「略過」仍會把新問題永久蓋掉——與檔頭宣稱的「資料變了指紋就變」不符。
// 於是 ID＝主體｜內容雜湊。**D5 刻意只用店家 key**：那件的語意是「這家店不分類我 OK」，
// 筆數每月成長不該重新騷擾（使用者定的取捨，非疏漏）。
/** @param {string} s @returns {string} */
const fp = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);

/**
 * 跑全部偵測器。回傳依嚴重度排序、已濾掉「略過」的項目。
 * @param {any=} preloadedDb 已經讀出來的整包資料（只有 `dismissHealthItem` 會傳）——**不是效能優化**：
 *   那個呼叫端正處在「讀→改→寫」的中間，這裡若自己再 `await getDb()`，HOSTED 下就是一次真正的
 *   資料庫往返＝讓出事件圈、打開交錯窗口（AGENTS.md 鐵則 8③明文禁止）。LOCAL 下底層是同步 SQLite
 *   所以看不出差別——正是 C4b 必須先修掉的那一種「本機永遠不會發作」的 bug。
 * @returns {Promise<{items: HealthItem[], dismissed: number, allIds: string[]}>}
 */
export async function runHealthCheck(preloadedDb) {
  const db = preloadedDb || await getDb();
  const stmt = (db.transactions || []).filter(t => t.source === 'stmt' && t.stmtRef);
  const lc = db.learnedCategories || {};
  /** @type {HealthItem[]} */
  const items = [];

  // 共用彙整：每筆的原文；每把鑰匙的原文集合/筆數；每個原文的代表交易（最新一筆）與筆數
  /** @type {Map<string, {key: string, txs: any[], orig: string}>} */
  const byOrig = new Map();
  /** @type {Map<string, {origs: Set<string>, count: number}>} */
  const byKey = new Map();
  for (const t of stmt) {
    const orig = origFromStmtRef(t.stmtRef);
    if (!orig) continue;
    const key = String(t.storeKey || '').trim();
    const o = byOrig.get(orig) || { key, txs: [], orig };
    o.txs.push(t); o.key = key || o.key;
    byOrig.set(orig, o);   // 代表交易在下面依日期挑（r2-Codex#6：以前直接取 txs[0]＝碰運氣的第一筆）
    if (key) {
      const g = byKey.get(key) || { origs: new Set(), count: 0 };
      g.origs.add(orig); g.count++;
      byKey.set(key, g);
    }
  }

  // 每個原文的代表交易＝**最新一筆**（日期→匯入時間），與檔頭說明一致（r2-Codex#6）
  const newest = (/** @type {any[]} */ txs) => txs.reduce((a, b) =>
    (String(b.date || '') + String(b.importedAt || '')) > (String(a.date || '') + String(a.importedAt || '')) ? b : a);

  // ---- D5 未分類佇列（實測零誤報；訂閱型放著每月+1，排最前面）----
  {
    /** @type {Map<string, {count: number, total: number, note: string, last: string}>} */
    const un = new Map();
    for (const t of stmt) {
      if (t.category !== DEFAULT_EXPENSE[0]) continue;
      const key = String(t.storeKey || t.note || '').trim();
      if (!key || isServiceFee(key)) continue;
      const g = un.get(key) || { count: 0, total: 0, note: String(t.note || key), last: '' };
      g.count++; g.total += Number(t.amount) || 0;
      if (String(t.date || '') > g.last) { g.last = String(t.date || ''); g.note = String(t.note || key); }
      un.set(key, g);
    }
    for (const [key, g] of [...un.entries()].sort((a, b) => b[1].count * b[1].total - a[1].count * a[1].total)) {
      items.push({ id: `D5|${key}`, type: 'uncategorized', chip: '未分類', severity: 2,
        desc: `「${g.note}」有 ${g.count} 筆落在「其他／未分類」——設定分類後，未來匯入也會自動歸對`,
        data: { key, note: g.note, count: g.count } });
    }
  }

  // ---- D2 鑰匙吃錯店（B 段＝分類異質，高信度；實測抓到林口長庚吃進火鍋店）----
  for (const [key, g] of byKey) {
    if (g.origs.size < 2 || isServiceFee(key)) continue;
    /** @type {Map<string, string>} 大類 → 代表原文 */
    const cats = new Map();
    for (const o of g.origs) {
      const [c] = categorize(o);
      if (c !== DEFAULT_EXPENSE[0]) cats.set(c, o);   // 認不出的不參與異質判定
    }
    if (cats.size >= 2) {
      const sample = [...cats.entries()].map(([c, o]) => `「${o}」（${c}）`).slice(0, 3).join('、');
      items.push({ id: `D2|${key}|${fp([...cats.keys()].sort().join(',') + [...g.origs].sort().join(','))}`, type: 'key-mixed', chip: '鑰匙吃錯店', severity: 3,
        desc: `鑰匙「${key}」底下混著不同性質的消費：${sample}——同一家店的分店不可能一個吃飯一個看病，多半是規則把不相干的店家吃進來了`,
        data: { key, report: `鑰匙「${key}」混進了不同分類的原文：${sample}。請檢查 STORE_CANON/規則是不是比對太寬。` } });
    }
  }

  // ---- D1 鑰匙尾巴雜訊（A 是 B 的前綴；共同前綴 ≥3 字）----
  {
    const keys = [...byKey.keys()];
    for (let i = 0; i < keys.length; i++) for (let j = 0; j < keys.length; j++) {
      if (i === j) continue;
      const a = keys[i], b = keys[j];
      if (a.length >= 3 && b.length > a.length && b.startsWith(a)) {
        const rest = b.slice(a.length);
        if (INSTALLMENT_RE.test(b)) continue;   // 分期歸 D7
        items.push({ id: `D1|${a}↔${b}`, type: 'key-prefix', chip: '同店兩把鑰匙？', severity: 2,
          desc: `「${a}」（${byKey.get(a)?.count} 筆）和「${b}」（${byKey.get(b)?.count} 筆）可能是同一家店（差在「${rest}」）——若是，統計會被拆成兩半；若真是兩家（如 台北101 vs 台北101停車場），按略過即可`,
          data: { keys: [a, b], report: `「${a}」與「${b}」疑似同店不同鑰匙，請評估是否加規則併回（BRAND_CANON 截斷併回或 STORE_CANON）。` } });
      }
    }
  }

  // ---- D6 簽名相同的鑰匙（大小寫/全半形/分隔符差異；實測抓到 LINEPAY*none vs *NONE）----
  {
    /** @type {Map<string, string[]>} */
    const sigMap = new Map();
    for (const k of byKey.keys()) {
      const sig = keySig(k);
      sigMap.set(sig, [...(sigMap.get(sig) || []), k]);
    }
    for (const [, ks] of sigMap) {
      if (ks.length < 2) continue;
      const sorted = [...ks].sort();
      items.push({ id: `D6|${sorted.join('↔')}`, type: 'key-dup', chip: '寫法分家', severity: 2,
        desc: `${sorted.map(k => `「${k}」`).join('和')} 只差大小寫或符號，被算成不同店家`,
        data: { keys: sorted, report: `鑰匙 ${sorted.join(' / ')} 疑似同店（僅大小寫/符號差異），請加正規化規則合併。` } });
    }
  }

  // ---- D7 分期分裂（Apple Xinyi A第03/12期 → 一筆分期 N 把鑰匙）----
  {
    /** @type {Map<string, {keys: Set<string>, count: number}>} */
    const inst = new Map();
    for (const [k, g] of byKey) {
      if (!INSTALLMENT_RE.test(k)) continue;
      const base = k.replace(INSTALLMENT_RE, '').replace(/[\s\-－]+$/, '').trim() || k;
      const e = inst.get(base) || { keys: new Set(), count: 0 };
      e.keys.add(k); e.count += g.count;
      inst.set(base, e);
    }
    for (const [base, e] of inst) {
      items.push({ id: `D7|${base}|${fp([...e.keys].sort().join(','))}`, type: 'installment', chip: '分期分裂', severity: 2,
        desc: `「${base}」的分期被期數拆成 ${e.keys.size} 把鑰匙（共 ${e.count} 筆）——店家檔案看不到這筆分期的全貌`,
        data: { base, keys: [...e.keys], report: `分期期數進了鑰匙（${base} 共 ${e.keys.size} 把），請加規則：鑰匙摘掉「第N/M期」、顯示名保留。` } });
    }
  }

  // ---- D4 分類漂移（現值≠現行完整自動、且學習表沒記＝多半是舊規則誤判的殘留）----
  for (const [orig, o] of byOrig) {
    if (isServiceFee(orig)) continue;
    const [ac0, as0] = categorize(orig);
    if (ac0 === DEFAULT_EXPENSE[0]) continue;              // 自動也認不出 → 歸 D5，不算漂移
    const [ac, asub] = resolveImportCategory(db, ac0, as0); // 完整鏈（含別名/生效樹；只比 categorize 會把別名誤報成漂移）
    const learned = lc[orig]?.category || (o.key && lc[o.key]?.category);
    if (learned) continue;                                  // 使用者學過＝故意的
    const drifted = o.txs.filter(t => t.category !== ac || (t.subcategory || '') !== (asub || ''));
    if (!drifted.length) continue;
    // autoCat 留底（#114 後匯入的才有）：現值≠匯入時自動＝人碰過 → 預設方向反轉為「保留」
    const t0 = newest(drifted);
    const humanLikely = t0.autoCat ? (t0.category !== t0.autoCat || (t0.subcategory || '') !== (t0.autoSub || '')) : null;
    items.push({ id: `D4|${orig}|${fp(`${t0.category}/${t0.subcategory || ''}→${ac}/${asub || ''}|${drifted.length}`)}`, type: 'cat-drift', chip: '分類漂移', severity: 1,
      desc: `「${String(t0.note || orig)}」有 ${drifted.length} 筆分類是「${t0.category}${t0.subcategory ? `·${t0.subcategory}` : ''}」，但現行規則會判「${ac}${asub ? `·${asub}` : ''}」${humanLikely === true ? '——留底顯示你改過，建議保留' : humanLikely === false ? '——留底顯示是舊規則判的，建議改成自動' : ''}`,
      data: { orig, note: String(t0.note || ''), count: drifted.length,
        current: { category: String(t0.category || ''), subcategory: String(t0.subcategory || '') },
        auto: { category: ac, subcategory: asub || '' }, humanLikely } });
  }

  // ---- D3 顯示名殘雜訊 ----
  for (const [orig, o] of byOrig) {
    if (isServiceFee(orig)) continue;
    // 檢查這個原文的**所有**不同顯示名（r2-Codex#6：只看代表那筆會漏——第一筆乾淨、後一筆有雜訊就整個漏報）
    let note = '', hit = null;
    for (const n of new Set(o.txs.map(t => String(t.note || '')))) {
      const h = NOISE_PATTERNS.find(([re]) => re.test(stripDisplayLabels(n)));
      if (h) { note = n; hit = h; break; }
    }
    if (!hit) continue;
    items.push({ id: `D3|${orig}|${fp(note)}`, type: 'note-noise', chip: '名字有雜訊', severity: 1,
      desc: `「${note}」看起來殘留了${hit[1]}——若這其實是正常店名，按略過即可`,
      data: { orig, note, pattern: String(hit[1]),
        report: `顯示名「${note}」（原文「${orig}」）殘留${hit[1]}，請評估補清理規則。` } });
  }

  // 濾掉已略過的 → 依嚴重度排序（大→小），同級維持偵測器順序
  const dismissed = db.settings?.healthDismissed || {};
  const visible = items.filter(it => !Object.hasOwn(dismissed, it.id));
  visible.sort((a, b) => b.severity - a.severity);
  return { items: visible, dismissed: items.length - visible.length, allIds: items.map(it => it.id) };
}

/**
 * 略過一個項目（持久化；資料變了指紋就變、會自動重新出現）／或清空全部略過。
 * 只收「目前真的存在的項目編號」並順手修剪失效指紋（r2-Codex#7）——原本任何字串都能寫進去、
 * 且規則/鑰匙變動後的舊指紋永遠累積。修剪放在這裡（本來就是寫入操作），GET 維持純唯讀。
 * @param {string=} id @param {boolean=} clearAll
 */
export async function dismissHealthItem(id, clearAll = false) {
  const db = await getDb();
  if (clearAll) {
    const n = Object.keys(db.settings?.healthDismissed || {}).length;
    db.settings = { ...db.settings, healthDismissed: {} };
    await saveDb(db);
    return { ok: true, dismissed: 0, pruned: n };
  }
  const k = String(id || '');
  if (!k) throw Object.assign(new Error('缺少項目編號'), { status: 400 });
  // ⚠️ 傳入上面剛讀出來的 db（C4b）：這裡在「讀→改→寫」的中間，不可以再開一次資料庫往返。
  const { allIds } = await runHealthCheck(db);
  const live = new Set(allIds);
  if (!live.has(k)) throw Object.assign(new Error('這個體檢項目已經不存在（可能剛被修好或資料已變動）'), { status: 400 });
  const cur = { ...(db.settings?.healthDismissed || {}) };
  let pruned = 0;
  for (const old of Object.keys(cur)) if (!live.has(old)) { delete cur[old]; pruned++; }   // 失效指紋順手清掉
  cur[k] = new Date().toISOString();
  db.settings = { ...db.settings, healthDismissed: cur };
  await saveDb(db);
  return { ok: true, dismissed: Object.keys(cur).length, pruned };
}
