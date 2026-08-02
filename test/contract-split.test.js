// @ts-check
// 領域契約拆分的護欄考題（2026-08-02，D4c／2c 收官；r2 依 Codex #384 r1 重寫判準）。
//
// ## 為什麼需要它
//
// `docs/contracts/` 的拆分從 2026-07-31 就開始做，但**一直沒有任何機械檢查**。
// 實測結果：拆分省下的篇幅，兩天之內被新內容吃回去一大半——
// AGENTS.md 的「一行索引」會慢慢長胖，長到跟原本的整條規則一樣長，
// 拆分就等於沒發生（而且更糟：同一條規則變成兩份，會各自漂）。
//
// ## r1 的五條假綠（Codex 實測，判準因此重寫）
//
// 第一版每一條斷言都是「**從索引出發**」——於是只要讓某一列**不再是索引**，它就從受測集合裡消失：
//   ①整列回復成 main 的「無連結原規則」⇒ `indexRows()` 收不到它 ⇒ 全綠
//   ②段落從 `##` 降成 `###` ⇒ 長度那題 `continue` 掉 ⇒ 索引超過上限也全綠
//   ③剝 `**記得同步這裡**：` 時位移算錯（用 9、實際 11）⇒ 契約內文被多算兩字 ⇒ 貼回整條規則仍全綠
//   ④路由表只驗「契約檔名有沒有出現」，完全沒驗窮舉檔案清單 ⇒ 刪掉 `lib/repo.js` 全綠
//   ⑤契約內文大幅截短，只要仍比摘要「稍長」就全綠
//
// **共同的根：判準只看得到「還乖乖當索引的那些列」。** r2 因此加了**反向**斷言：
// 從**契約檔的每一個段落**出發，要求 AGENTS 一定有一列指過來——
// 這樣「把索引拆掉」不再是逃出考題，而是製造一個沒人指的孤兒段落 ⇒ 紅。
//
// ## 誠實劃界
//
// 擋得住「索引長回原文」「拆掉索引」「連結指不到」「路由表漏檔（**檔名或函式名有出現的**）」。
// 擋不住「索引摘要寫得爛」——摘要品質是人的事。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/** 索引行的硬上限。現行最長 474（SEC 官方指標挑值那條，規則本身就密）。 */
const MAX_INDEX_LEN = 600;
/** 摘要相對契約內文的上限比例（只在內文 ≥300 字元時生效）——「稍微短一點」不算拆分（r1 假綠⑤）。 */
const MAX_SUMMARY_RATIO = 0.6;
const BODY_LABEL = '**記得同步這裡**：';

/** GitHub 的 anchor 規則：小寫、去標點、空白轉 `-`。 @param {string} h */
function slug(h) {
  return [...h.toLowerCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c) || c === ' ' || c === '-' || c === '_')
    .join('')
    .replace(/ /g, '-');
}

const LINK_RE = /\[契約：[^\]]+\]\((docs\/contracts\/[^)#]+)#([^)]+)\)/;

/** AGENTS.md 裡所有「指向契約檔」的同步點列。 */
function indexRows() {
  return read('AGENTS.md').split('\n')
    .filter((l) => l.startsWith('| ') && LINK_RE.test(l))
    .map((line) => {
      const m = /** @type {RegExpExecArray} */ (LINK_RE.exec(line));
      return { line, file: m[1], anchor: m[2] };
    });
}

/** 契約檔清單（`docs/contracts/*.md`，README 除外）。 */
const contractFiles = () => readdirSync(join(ROOT, 'docs/contracts'))
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .map((f) => `docs/contracts/${f}`);

/**
 * 契約檔裡的每一個規則段落。**`##` 與 `###` 都算**——
 * r1 的假綠②就是把段落降成 `###` 之後長度那題直接跳過。
 * @param {string} file
 */
function sectionsOf(file) {
  const md = read(file);
  const heads = [...md.matchAll(/^#{2,3} .+$/gm)];
  return heads.map((h, i) => {
    const start = /** @type {number} */ (h.index);
    const end = i + 1 < heads.length ? /** @type {number} */ (heads[i + 1].index) : md.length;
    const text = md.slice(start, end);
    const bs = text.indexOf(BODY_LABEL);
    return {
      anchor: slug(h[0].replace(/^#+\s*/, '')),
      heading: h[0],
      text,
      // ⚠️ 位移用**字串長度**算，不要手寫數字（r1 假綠③：寫死 9、實際 11，
      //    契約內文被多算兩個字，剛好讓「貼回整條規則」過關）。
      body: bs < 0 ? '' : text.slice(bs + BODY_LABEL.length),
      hasBody: bs >= 0,
    };
  });
}

test('拆分護欄｜每個索引行都指得到真實的契約檔與段落', () => {
  const rows = indexRows();
  assert.ok(rows.length >= 20, `AGENTS.md 只找到 ${rows.length} 個契約索引行，預期至少 20（拆分被回捲了？）`);
  for (const { line, file, anchor } of rows) {
    assert.ok(existsSync(join(ROOT, file)),
      `索引行指向不存在的契約檔 ${file}。\n實得：${line.slice(0, 100)}`);
    const anchors = sectionsOf(file).map((s) => s.anchor);
    assert.ok(anchors.includes(anchor),
      `${file} 裡沒有 anchor \`#${anchor}\` 對應的標題——連結會落在檔頭，讀者找不到那一條。\n`
      + `該檔現有 anchor：${anchors.join('、')}`);
  }
});

test('拆分護欄｜**反向**：契約裡的每個段落，AGENTS 都要有一列指過來（拆掉索引＝製造孤兒）', () => {
  // ⚠️ r1 的假綠①：把某一列回復成 main 的「無連結原規則」，它就從受測集合裡消失、全綠。
  //    根因是所有斷言都**從索引出發**。這一題從**契約**出發，把那條路堵死。
  const pointed = new Set(indexRows().map((r) => `${r.file}#${r.anchor}`));
  for (const file of contractFiles()) {
    for (const s of sectionsOf(file)) {
      if (!s.hasBody) continue;   // 沒有「記得同步這裡」的段落＝說明性小節，不是規則
      assert.ok(pointed.has(`${file}#${s.anchor}`),
        `${file} 的「${s.heading}」是一條規則，但 AGENTS.md 沒有任何一列指過來。\n`
        + '⚠️ 沒有索引的契約段落＝**孤兒**：改到相關檔案的人不會被導到這條規則。\n'
        + '（若這條規則被搬回 AGENTS，請把契約段落一起刪掉；兩邊各留一份一定會漂。）');
    }
  }
});

test('拆分護欄｜索引的摘要必須**明顯**比契約內文短（否則拆分等於沒發生）', () => {
  for (const { line, file, anchor } of indexRows()) {
    const s = sectionsOf(file).find((x) => x.anchor === anchor);
    // ⚠️ fail-closed：找不到就是紅，不可以 `continue`（r1 假綠②靠的就是那個 continue）。
    assert.ok(s, `${file} 找不到 anchor \`#${anchor}\` 的段落 ⇒ 上一題應該已經紅；這裡不放行`);
    assert.ok(s.hasBody, `${file}#${anchor} 的段落沒有「${BODY_LABEL}」——契約被掏空了？`);

    // ⚠️ 比的是「摘要 vs 內文」不是「整行 vs 整段」——整行含約 90 字元的表格框與連結標記，
    //    短規則會被那個固定成本判成「沒省到」。
    const summary = (line.split(' | ')[1] || '').split('——完整契約')[0];
    // 比例只在**長規則**上生效：短規則的「摘要」本來就接近規則本身，
    // 硬套比例會逼人把索引寫成看不懂的縮寫（實測 67 字元的規則被要求摘要 ≤40）。
    // 真正要防的是「把一大條規則整個貼回 AGENTS」，那一定是長規則。
    const limit = s.body.length >= 300 ? Math.floor(s.body.length * MAX_SUMMARY_RATIO) : s.body.length - 1;
    assert.ok(summary.length <= limit,
      `索引摘要沒有比契約內文短夠多 ⇒ 這條規則接近「兩份完整副本」，一定會各自漂。\n`
      + `摘要 ${summary.length} 字元、契約內文 ${s.body.length} 字元（上限 ${limit}＝${MAX_SUMMARY_RATIO * 100}%）`
      + `（${file}#${anchor}）\n實得摘要：${summary.slice(0, 120)}…`);

    assert.ok(line.length <= MAX_INDEX_LEN,
      `索引行 ${line.length} 字元，超過上限 ${MAX_INDEX_LEN}。\n`
      + '⚠️ 索引行會慢慢長胖，長到跟原文一樣長時拆分就白做了（實測兩天被吃回去大半）。\n'
      + `要寫的細節請放進 ${file}，這裡只留「我改的東西碰不碰得到這條」。\n`
      + `實得：${line.slice(0, 120)}…`);
  }
});

/** 掃 `lib/`＋`public/`，建「匯出名 → 定義檔」的對照表。 */
function exportIndex() {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  /** @param {string} dir */
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${e}`;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!e.endsWith('.js')) continue;
      for (const m of read(rel).matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
        map.set(m[1], [...(map.get(m[1]) || []), rel]);
      }
    }
  };
  walk('lib'); walk('public');
  return map;
}

test('拆分護欄｜路由表的檔案清單要窮舉（漏一個檔＝改那個檔的人不會被導到契約）', () => {
  // ⚠️ r1 的假綠④：這一題原本只驗「契約檔名有沒有出現在 README」，
  //    刪掉 `lib/repo.js` 照樣全綠——而 README 自己的硬規則①明寫清單是**窮舉判準**。
  //    現在兩種都驗：契約裡**點名的檔案路徑**，以及**點名的函式所定義的檔案**
  //   （Codex #384 r1 漏掉的四個檔全部是後者——契約用函式名點它們，不是用路徑）。
  const readme = read('docs/contracts/README.md');
  const rows = readme.split('\n').filter((l) => l.startsWith('| ') && /\.md\)/.test(l));
  const exports_ = exportIndex();

  for (const file of contractFiles()) {
    const base = /** @type {string} */ (file.split('/').pop());
    const row = rows.find((r) => r.includes(`(${base})`));
    assert.ok(row, `${file} 沒有出現在 docs/contracts/README.md 的路由表。\n`
      + '路由表是「我改的檔案該讀哪份契約」的唯一入口，漏一列＝那個領域的規則沒人會讀到。');

    const md = read(file);
    /** @type {Set<string>} */
    const need = new Set();
    for (const m of md.matchAll(/`((?:lib|public|test|data|db)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)) need.add(m[1]);
    for (const m of md.matchAll(/`([A-Za-z_$][\w$]{3,})`/g)) {
      const defs = exports_.get(m[1]) || [];
      // ⚠️ **只認唯一解**：同名 export 出現在多個檔案時，這條線索本來就指不出唯一責任檔，
      //    硬要求全部列進路由表會變成噪音型誤紅。撞號的交給人，不要讓考題亂猜。
      if (defs.length === 1) need.add(defs[0]);
    }
    const missing = [...need].filter((f) => !row.includes(`\`${f}\``) && !row.includes(f.split('/').pop() || ''));
    assert.deepEqual(missing, [],
      `${file} 點名了這些檔案，但 README 路由表的那一列沒有列出來：\n  ${missing.join('\n  ')}\n`
      + '⚠️ README 硬規則①：已拆領域的檔案清單＝**窮舉**，不是「典型檔案」。\n'
      + '   漏一個＝改那個檔的人不會被導到契約，正是這條規則要避免的失敗。');
  }
});
