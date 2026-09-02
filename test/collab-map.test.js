// @ts-check
// **協作規矩地圖的地址要是真的**（`COLLAB-MAP.md`）。
//
// ## 這支守什麼
//
// 那份地圖只做一件事：把「我想查 X」導到「哪一份的哪一節」。
// 導錯的地圖比沒有地圖更糟——照著走的人會以為自己讀過了，實際上讀到的是別的東西，
// 或根本沒到（節被改名／檔案被搬走，地圖不會自己知道）。所以這支驗三件事：
//   ①地圖裡每一個連結指到的檔案還在
//   ②連結後面緊跟著「」的節名字串，在那個檔案裡還找得到
//   ③地圖自己找得到（`CLAUDE.md`／`AGENTS.md` 都要指得回它）——沒人指的地圖等於不存在
//   ④「規矩的手腳」那張表要涵蓋每一支**自報** `MERGE_GATE` 的閘——名單不手寫，跟腳本對帳
//
// ## 誠實劃界（重要，不要把這支當成「地圖是對的」的保證）
//
// 它驗的是**地址**，不是**內容**：
// - **驗不到**「那一節是不是還在講那件事」——節名沒動、整段改寫成別的規則，這支照樣綠。
// - **驗不到**地圖有沒有偷偷把規則內容抄進去（那正是它存在要防的病，但機器讀不出「這句是規則還是指路」）。
// - **驗不到**站外那一條（`../teaching-videos/AGENTS.md`）——別的 repo，不保證在這台機器上；
//   地圖裡那一條刻意寫成非連結，本檔一併驗它有被標成「驗不到」，免得讀者以為它在網子裡。
// - 節名字串只要求「檔案裡找得到」，不要求它是標題——AGENTS 有好幾條規則是粗體條列不是標題，
//   硬要求標題會逼地圖改指到比較粗的位置，那對讀者更差。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

const MAP = 'COLLAB-MAP.md';

/** 三份正本——地圖至少要導得到它們，否則它導的是別的東西。 */
const CANON = ['AGENTS.md', 'REVIEW-AND-MERGE.md', 'CLAUDE.md'];

/**
 * 抽出地圖裡的每一條路線：`[顯示名](檔案路徑)` ＋（選配）緊跟其後的 `「節名」`。
 *
 * ⚠️ 這個正規式**自己就是承重點**：抽不到東西的話下面每一題都會空掃而綠
 * （「什麼都沒做卻回報通過」比沒有護欄更糟）。所以下面第一題拿寫死的樣本先驗它會動。
 *
 * @param {string} text
 * @returns {{label: string, file: string, anchor: string | null}[]}
 */
function routes(text) {
  /** @type {{label: string, file: string, anchor: string | null}[]} */
  const out = [];
  const re = /\[([^\]\n]+)\]\(([^)\s]+)\)(?:\s*「([^」\n]+)」)?/g;
  for (const m of text.matchAll(re)) {
    if (/^https?:/.test(m[2])) continue;   // 站外網址不在射程內
    out.push({ label: m[1], file: m[2], anchor: m[3] ?? null });
  }
  return out;
}

test('⭐ 抽路線的正規式自己要先會動（防空掃而綠）', () => {
  const sample = [
    '| 誰是誰 | [AGENTS.md](AGENTS.md)「三方協作框架」 |',
    '| 手腳 | [scripts/x.js](scripts/x.js) |',
    '| 站外 | [別的](https://example.com)「不算」 |',
  ].join('\n');
  const got = routes(sample);
  assert.deepEqual(got, [
    { label: 'AGENTS.md', file: 'AGENTS.md', anchor: '三方協作框架' },
    { label: 'scripts/x.js', file: 'scripts/x.js', anchor: null },
  ], '正規式抽錯了——它抽不到路線的話，下面三題就通通是空包彈。');
});

test('⭐ 地圖指到的每一個檔案都還在', () => {
  const found = routes(read(MAP));
  assert.ok(found.length > 0, `${MAP} 裡一條路線都抽不到——不是地圖空了，就是格式被改到抽不出來。`);
  for (const { file } of found) {
    assert.ok(existsSync(join(ROOT, file)),
      `${MAP} 指到「${file}」，但這個檔案不在了。\n`
      + '⚠️ 檔案搬家／改名時，地圖不會自己跟著改——這一題就是為此存在。');
  }
});

test('⭐ 地圖引用的每一個節名，在那個檔案裡都還找得到', () => {
  const anchored = routes(read(MAP)).filter((r) => r.anchor);
  assert.ok(anchored.length > 0, `${MAP} 裡沒有任何「節名」路線——地圖只剩檔名的話就導不到任何一節。`);
  for (const { file, anchor } of anchored) {
    assert.ok(read(file).includes(String(anchor)),
      `${MAP} 叫人去讀「${file}」的「${anchor}」，但那個字串在該檔已經找不到了。\n`
      + '⚠️ 多半是那一節被改名或整併了——回頭把地圖改到新的節名，不要把這一題關掉。\n'
      + '⚠️ 提醒：這一題只驗字串還在，**驗不到那一節是不是還在講同一件事**。');
  }
});

test('⭐ 三份正本都要在地圖的射程裡（否則它導的是別的東西）', () => {
  const files = new Set(routes(read(MAP)).map((r) => r.file));
  for (const doc of CANON) {
    assert.ok(files.has(doc),
      `${MAP} 完全沒有導向「${doc}」。三份正本少一份，讀者就會以為那一層的規矩不存在。`);
  }
});

test('⭐ 地圖自己要找得到：CLAUDE.md 與 AGENTS.md 都要指得回它', () => {
  for (const from of ['CLAUDE.md', 'AGENTS.md']) {
    assert.ok(read(from).includes(MAP),
      `「${from}」沒有提到 ${MAP}。\n`
      + '⚠️ 沒有人指路的地圖等於不存在——CLAUDE.md 是 Claude 每個 session 唯一保證讀到的入口，\n'
      + '   AGENTS.md 是 Codex 的入口，兩邊都要指得回來。');
  }
});

/**
 * 合併前真的會擋人的閘＝**腳本自報**（`export const MERGE_GATE`），不是誰手寫的名單。
 *
 * ⚠️ 這個做法是抄 `test/collab-invariant-docs.test.js` 的教訓（`Codex #385 r9`）：
 * 那裡原本手寫三個閘名，第四道閘加進來之後**考題把舊名單當契約、全綠也看不見**。
 * 地圖的「規矩的手腳」那一節同樣是一張名單，同樣會漂——所以這裡改成跟腳本自報對帳。
 */
async function selfDeclaredGates() {
  const files = readdirSync(join(ROOT, 'scripts')).filter((f) => f.startsWith('check-') && f.endsWith('.js'));
  /** @type {string[]} */
  const gates = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(ROOT, 'scripts', f)).href);
    if (mod.MERGE_GATE) gates.push(`scripts/${f}`);
  }
  return gates;
}

test('⭐ 「規矩的手腳」要涵蓋每一支自報 MERGE_GATE 的閘（加了新閘沒列就轉紅）', async () => {
  const gates = await selfDeclaredGates();
  assert.ok(gates.length > 0,
    '一支自報 MERGE_GATE 的閘都找不到——不是閘沒了，就是這個列舉壞了（壞了的話這題就是空包彈）。');
  const text = read(MAP);
  for (const g of gates) {
    assert.ok(text.includes(g),
      `${MAP} 的「規矩的手腳」漏了「${g}」，但它自報是合併閘。\n`
      + '⚠️ 讀者會照那張表推論「表上沒有＝沒有機器在管」——漏一道就是給錯的安全感。\n'
      + '   （名單刻意不手寫在考題裡：手寫的名單自己會漂，這正是 Codex #385 r9 的教訓。）');
  }
});

test('站外那一條要標明「驗不到」（不要讓讀者以為它在網子裡）', () => {
  const text = read(MAP);
  assert.ok(text.includes('../teaching-videos/AGENTS.md'),
    `${MAP} 少了「住在別的 repo 的那一條」——那是唯一一條正本不在本 repo 的協作規矩。`);
  assert.ok(/驗不到它/.test(text),
    `${MAP} 提到站外正本，卻沒說明本檔的考題驗不到它。\n`
    + '⚠️ 誇大的保證比缺口更糟：讀者會以為那條也有機器在盯。');
});
