// @ts-check
// **合併步驟裡「實際被執行」的閘**——從 `REVIEW-AND-MERGE.md` 的合併步驟區塊反查。
//
// 這一份原本住在 `test/collab-invariant-docs.test.js` 裡。`Codex #545 r6` 指出
// `test/collab-map.test.js` 需要**同一個集合**（地圖的「合併步驟專用的閘」若改用「有沒有自報」
// 當判準，一支自報卻沒接進合併步驟的**幽靈閘**就會被要求列進地圖＝製造假的安全感）。
// 兩處各寫一份就是兩份會漂的複本，所以搬出來共用。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 合併步驟區塊裡**實際被執行**的閘。
 *
 * ⚠️ **只認 bash fence 裡逐字相符的指令行**（Codex #385 r12 High①）：
 * 原本用子字串比對，於是 `# node scripts/check-x.js <N>`（整行註解掉）也算「有跑」——
 * 突變後 75/75 仍全綠。`echo node …`、`false && node …` 同型。
 * 反方向也漏：`node ./scripts/x.js <N>`、`env node …`、`<PR 編號>` 都是合法寫法卻抓不到，
 * 新閘若採其中一種、又沒自報，雙向集合仍可能「相等」。
 * ⇒ 判準改成：**只在區塊內的 bash fence 裡，逐行 trim 後全等 `node <path> <N>`**。
 * 註解、前綴、非標準拼法一律不算——要進程序就寫成標準那一行。
 *
 * ⚠️ **射程**：路徑形狀限 `scripts/<名>.js`（第一層、`.js`）。子目錄或 `.mjs`／`.cjs`
 * 即使真的寫進合併步驟也抓不到——那是這個判準刻意的窄，不是漏。呼叫端要自己 fail-closed
 * （`collab-map.test.js` 的兜底題就是：自報卻不在本集合裡＝紅）。
 *
 * @returns {string[]}
 */
export function gatesRunInMergeSteps() {
  const whole = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const start = whole.indexOf('合併也由 Codex 代執行');
  assert.ok(start > 0, 'REVIEW-AND-MERGE.md 找不到合併步驟區塊');
  const stop = whole.indexOf('\n---', start);
  // ⚠️ 找不到結束錨點就**直接失敗**，不要掃到檔尾（fail-closed，Codex r12）
  assert.ok(stop > start, '合併步驟區塊找不到結束錨點 `\n---`——不要退而掃到檔尾，那不是 fail-closed');
  // ⚠️ 整段合併步驟寫在 blockquote 裡，fence 前面有 `> ` ⇒ 先剝引用前綴再抽 fence
  const block = whole.slice(start, stop).split('\n').map((l) => l.replace(/^\s*>[ \t]?/, '')).join('\n');
  // ⚠️ fence 要**錨定整行**、info string **只准 `bash`**（Codex #385 r13 High）：
  //    原本的 /```[a-z]*\n…```/ 接受任何 info string，而且沒錨定行首——
  //    正文裡寫一句「這不是 fence：```bash」就會被當成指令區塊採計，34/34 全綠。
  const FENCE = /^ {0,3}```bash[ \t]*$\n([\s\S]*?)^ {0,3}```[ \t]*$/gm;
  const fenced = [...block.matchAll(FENCE)].map((f) => f[1]).join('\n');
  const gates = [];
  for (const line of fenced.split('\n')) {
    const m2 = /^node (scripts\/[\w-]+\.js) <N>$/.exec(line.trim());
    if (m2) gates.push(m2[1]);
  }
  return [...new Set(gates)];
}
