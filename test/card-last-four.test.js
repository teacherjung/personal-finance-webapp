// @ts-check
// 卡側末四碼安全字串化（public/modules/card-last-four.js）——為什麼有這檔（Codex #541 r3#1＋r4#1）：
// `cards.lastFour` 在 CRUD 白名單、FIELD_SCHEMA 沒有型別收斂 ⇒ `{toString:null}` 這族「連 String()
// 都炸」的值可經櫃檯原樣落庫。r3 抓到後端 hit 裸 String() 炸掉整份預覽；r4 抓到後端修好之後，
// 預覽窗選卡下拉吃 /api/cards 原始資料**換到前端炸**。修法＝前後端共用同一支安全字串化。
// 端到端行為（守門＋回應欄位）在 test/statement-pipeline.test.js 的 J9d／J9e；這裡釘兩件事：
// ①helper 本身的語意 ②前端兩個顯示點**真的接上了**（接線形狀題——改成註解＝沒接，先去註解再掃）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardLastFourText, cardLastFourSuffix } from '../public/modules/card-last-four.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('cardLastFourText｜炸彈值不炸、壞值照字串化、空值回空字串', () => {
  assert.equal(cardLastFourText(JSON.parse('{"toString":null}')), '', '★{toString:null}＝炸不出 ⇒ 空字串，不丟 TypeError');
  assert.equal(cardLastFourText('1234'), '1234', '合法字串原樣');
  assert.equal(cardLastFourText(1234), '1234', '數字照字串化');
  assert.equal(cardLastFourText(['5678']), '5678', '陣列攤平＝字串化的答案（#520 裁定）');
  assert.equal(cardLastFourText(0), '0', '壞值照字串化顯示——使用者看得到垃圾才會去修');
  assert.equal(cardLastFourText(false), 'false', '同上');
  assert.equal(cardLastFourText(null), '', 'null＝沒登記＝不顯示');
  assert.equal(cardLastFourText(undefined), '', '缺欄＝沒登記＝不顯示');
  assert.equal(cardLastFourText(''), '', '空字串＝沒登記＝不顯示');
});

test('cardLastFourSuffix｜標籤後綴的行為本體：炸彈不炸、esc 有真的套、空值不出括號', () => {
  // Codex r5：接線正則抓不住等價拼法（cards[0].lastFour 換個受詞就溜）＝題名保證過大。
  // 守門改落在「真的被執行的函式」：兩個顯示點的標籤後綴由這支純函式組，考題直接餵炸彈。
  assert.equal(cardLastFourSuffix(JSON.parse('{"toString":null}')), '', '★炸彈值＝不出括號、不丟 TypeError');
  assert.equal(cardLastFourSuffix('1234'), '（1234）', '合法值出括號');
  assert.equal(cardLastFourSuffix(''), '', '沒登記＝空');
  assert.equal(cardLastFourSuffix(null), '', 'null＝空');
  assert.equal(cardLastFourSuffix(0), '（0）', '壞值照字串化顯示');
  assert.equal(cardLastFourSuffix('<b>', (t) => t.toUpperCase()), '（<B>）',
    '★escFn 要真的套在文字上（HTML 端靠它跳脫；這裡用大寫代打驗證有呼叫）');
  assert.equal(cardLastFourSuffix(JSON.parse('{"toString":null}'), () => { throw new Error('不該被呼叫'); }), '',
    '炸彈值連 escFn 都不會碰（先安全字串化、空就短路）');
});

// 行級掃描的共用刀（掃真檔＋探針都用同一把——刀自己也要被考，見下面的探針題）：
// 每一行先摘掉兩種安全形，殘留 `.lastFour`＝違規。
// ①**唯一獲摘除的安全呼叫形＝「單純識別字受詞的直接引數」**：`cardLastFourSuffix(x.lastFour)`
//   或 `cardLastFourSuffix(x.lastFour, esc)`（第二引數不得含括號）。⚠️ 刻意只認這一種形
//  （Codex r6：上一版用 `[^)]*` 摘整段呼叫，`cardLastFourSuffix(String(c.lastFour))` 的第一個
//   右括號在 `.lastFour` 之後、不安全取值被一起摘掉＝fail-open——而那種寫法在進 helper **之前**
//   就先炸了）。巢狀呼叫、複合受詞（`cards[0].lastFour`）一律不摘＝紅，紅了來讀這段再決定。
// ②r.／curR. 的取值（預覽回應＝parsed 側，後端已正規化成字串|null，安全）。
// ⚠️ 誠實劃界：抓得住所有「點取值」寫法（不限受詞拼法）；抓不住 bracket 取值（c['lastFour']）
//   與解構（const {lastFour} = c）——本檔目前一種都沒有，出現就該在複審被問「為什麼要繞」。
const stripSafeLastFour = (/** @type {string} */ line) => line
  .replace(/cardLastFourSuffix\(\s*[A-Za-z_$][\w$]*\.lastFour\s*(?:,[^()]*)?\)/g, '')
  .replace(/\b(r|curR)\.lastFour/g, '');
const lastFourViolations = (/** @type {string} */ src) =>
  src.split('\n').filter(l => stripSafeLastFour(l).includes('.lastFour'));

test('接線｜transactions-import.js 的 .lastFour 點取值全掃（不限變數名）：卡側只准直接餵 cardLastFourSuffix', () => {
  // ⚠️ 先去註解再掃（cashflow-bank-upload r5 阻擋②同款）：把接線改成註解＝沒接、掃字面會假綠。
  const raw = readFileSync(join(ROOT, 'public/modules/transactions-import.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.ok(/import \{ cardLastFourSuffix \} from '\.\/card-last-four\.js'/.test(src), '★要 import 行為本體');
  assert.ok(src.split('\n').some(l => l.includes('.lastFour')), '前提：檔案裡真的有 .lastFour 取值（全刪光＝本題失去對象，回來重寫）');
  assert.deepEqual(lastFourViolations(src), [],
    '★裸 .lastFour 取值（卡側只准當 cardLastFourSuffix 的直接引數，預覽回應側只認 r／curR）');
});

test('接線掃描的刀自己也要被考：已知危險形必紅、安全形必綠（Codex r6——上一版對巢狀呼叫 fail-open）', () => {
  for (const [why, bad] of [
    ['r5 的等價拼法（受詞不是 c）', 'const t = String(cards[0].lastFour);'],
    ['裸插值＝隱式 String()', 'label: c.name + (c.lastFour ? `（${c.lastFour}）` : "")'],
    ['r6 的巢狀呼叫：進 helper 之前 String() 就先炸', 'x = cardLastFourSuffix(String(c.lastFour));'],
    ['複合受詞的直接引數＝刻意 fail-closed 交複審（摘除只認單純識別字受詞）', 'x = cardLastFourSuffix(cards[0].lastFour);'],
    ['同一行安全呼叫＋另一個裸取值', 'a = cardLastFourSuffix(c.lastFour); b = d.lastFour;'],
  ]) {
    assert.equal(lastFourViolations(bad).length, 1, `★必紅：${why}`);
  }
  for (const [why, ok] of [
    ['正式線現形①', 'label: c.name + cardLastFourSuffix(c.lastFour)'],
    ['正式線現形②（HTML 端帶 esc）', '`${esc(c.name)}${cardLastFourSuffix(c.lastFour, esc)}`'],
    ['預覽回應側（parsed，後端已正規化）', 'const d = r.lastFour ? `（${r.lastFour}）` : "";'],
    ['預覽回應側（curR）', 'curR.lastFour ? 1 : 2'],
  ]) {
    assert.deepEqual(lastFourViolations(ok), [], `不得誤殺：${why}`);
  }
});

test('接線｜lib/services/statement-import.js import 同一支安全網、不留本地複本（行為守門＝J9d 端到端）', () => {
  // ⚠️ 這題只反「兩把尺」：後端換什麼拼法裸跑 String() 都會讓 statement-pipeline 的 J9d
  //   （炸彈卡端到端）直接紅，行為級守門在那邊，這裡不重做、也不宣稱抓得住等價拼法。
  const raw = readFileSync(join(ROOT, 'lib/services/statement-import.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.ok(/import \{ cardLastFourText \} from '\.\.\/\.\.\/public\/modules\/card-last-four\.js'/.test(src), '★後端 import 同一支（lib→public 前例＝card-issuers）');
  assert.ok(!/function lastFourText/.test(src), '★不得留一份本地複本——同一件事兩把尺是這個 repo 反覆踩到的病');
});
