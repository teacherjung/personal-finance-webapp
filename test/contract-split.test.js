// @ts-check
// 領域契約拆分的護欄考題（2026-08-02，D4c／2c 收官）。
//
// ## 為什麼需要它
//
// `docs/contracts/` 的拆分從 2026-07-31 就開始做，但**一直沒有任何機械檢查**。
// 實測結果：拆分省下的篇幅，兩天之內被新內容吃回去一大半——
// AGENTS.md 的「一行索引」會慢慢長胖，長到跟原本的整條規則一樣長，
// 拆分就等於沒發生（而且更糟：同一條規則變成兩份，會各自漂）。
//
// ## 這支盯的是「行為」，不是「有沒有寫」
//
// 判準＝**索引行必須比它指向的契約段落短**。
// 有人把完整規則貼回 AGENTS 時，這個關係會反過來 ⇒ 紅。
// 另加一道硬上限，防「契約段落也一起長胖、索引跟著長胖」的合謀情形。
//
// ## 誠實劃界
//
// 擋得住「索引長回原文」與「連結指向不存在的檔案／錨點」。
// 擋不住「索引寫得爛」——摘要品質是人的事，這裡只保證它短、指得到、且真的有東西可指。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/** 索引行的硬上限。現行最長 474（SEC 官方指標挑值那條，規則本身就密）。 */
const MAX_INDEX_LEN = 600;

/** GitHub 的 anchor 規則：小寫、去標點、空白轉 `-`。 @param {string} h */
function slug(h) {
  return [...h.toLowerCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c) || c === ' ' || c === '-' || c === '_')
    .join('')
    .replace(/ /g, '-');
}

/** AGENTS.md 裡所有「指向契約檔」的同步點列。 */
function indexRows() {
  const re = /\[契約：[^\]]+\]\((docs\/contracts\/[^)#]+)#([^)]+)\)/;
  return read('AGENTS.md').split('\n')
    .filter((l) => l.startsWith('| ') && re.test(l))
    .map((line) => {
      const m = /** @type {RegExpExecArray} */ (re.exec(line));
      return { line, file: m[1], anchor: m[2] };
    });
}

test('拆分護欄｜每個索引行都指得到真實的契約檔與段落', () => {
  const rows = indexRows();
  assert.ok(rows.length >= 20, `AGENTS.md 只找到 ${rows.length} 個契約索引行，預期至少 20（拆分被回捲了？）`);

  for (const { line, file, anchor } of rows) {
    assert.ok(existsSync(join(ROOT, file)),
      `索引行指向不存在的契約檔 ${file}。\n實得：${line.slice(0, 100)}`);
    const anchors = read(file).split('\n')
      .filter((l) => l.startsWith('## ') || l.startsWith('### '))
      .map((l) => slug(l.replace(/^#+\s*/, '')));
    assert.ok(anchors.includes(anchor),
      `${file} 裡沒有 anchor \`#${anchor}\` 對應的標題——連結會落在檔頭，讀者找不到那一條。\n`
      + `該檔現有 anchor：${anchors.join('、')}`);
  }
});

test('拆分護欄｜索引行必須比它指向的契約段落**短**（否則拆分等於沒發生）', () => {
  for (const { line, file, anchor } of indexRows()) {
    const md = read(file);
    const heads = [...md.matchAll(/^## .+$/gm)];
    const i = heads.findIndex((h) => slug(h[0].replace(/^#+\s*/, '')) === anchor);
    if (i < 0) continue;   // 上一題已經負責「anchor 存在」，這裡只管長度
    const start = /** @type {number} */ (heads[i].index);
    const end = i + 1 < heads.length ? /** @type {number} */ (heads[i + 1].index) : md.length;
    const section = md.slice(start, end);

    // ⚠️ 比的是「**摘要 vs 內文**」，不是「整行 vs 整段」——
    //    整行含表格框與連結標記（約 90 字元的固定成本），短規則會被那個成本判成「沒省到」。
    //    實際踩到：`COMPOSITION 穿透表` 索引 176／段落 122，但摘要只有 40 字元、內文 80 字元。
    const summary = (line.split(' | ')[1] || '').split('——完整契約')[0];
    const bodyStart = section.indexOf('**記得同步這裡**：');
    const body = bodyStart < 0 ? section : section.slice(bodyStart + 9);

    assert.ok(summary.length < body.length,
      '索引的摘要不比契約內文短 ⇒ 整條規則被貼回 AGENTS 了，等於「兩份完整副本」，一定會各自漂。\n'
      + `摘要 ${summary.length} 字元、契約內文 ${body.length} 字元（${file}#${anchor}）\n`
      + `實得摘要：${summary.slice(0, 120)}…`);

    assert.ok(line.length <= MAX_INDEX_LEN,
      `索引行 ${line.length} 字元，超過上限 ${MAX_INDEX_LEN}。\n`
      + '⚠️ 索引行會慢慢長胖，長到跟原文一樣長時拆分就白做了（實測兩天被吃回去大半）。\n'
      + `要寫的細節請放進 ${file}，這裡只留「我改的東西碰不碰得到這條」。\n`
      + `實得：${line.slice(0, 120)}…`);
  }
});

test('拆分護欄｜路由表與契約檔互相對得上（少一邊就有人找不到規則）', () => {
  const readme = read('docs/contracts/README.md');
  // 路由表點名的契約檔都要存在
  for (const m of readme.matchAll(/\[([^\]]+\.md)\]\(([^)]+\.md)\)/g)) {
    if (m[2].startsWith('http')) continue;
    assert.ok(existsSync(join(ROOT, 'docs/contracts', m[2])),
      `路由表指向不存在的契約檔 docs/contracts/${m[2]}`);
  }
  // 反向：AGENTS 索引行用到的契約檔，路由表都要有一列
  for (const { file } of indexRows()) {
    const base = file.split('/').pop();
    assert.ok(readme.includes(`(${base})`),
      `${file} 有 AGENTS 索引行指過去，但 docs/contracts/README.md 的路由表沒有它那一列。\n`
      + '路由表是「我改的檔案該讀哪份契約」的唯一入口，漏一列＝那個領域的規則沒人會讀到。');
  }
});
