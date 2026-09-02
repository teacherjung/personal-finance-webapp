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
import { cardLastFourText } from '../public/modules/card-last-four.js';

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

test('接線｜transactions-import.js 的卡片標籤全走安全網、不得再裸跑 String(c.lastFour) 或裸插值', () => {
  // ⚠️ 先去註解再掃（cashflow-bank-upload r5 阻擋②同款）：把接線改成註解＝沒接、掃字面會假綠。
  const raw = readFileSync(join(ROOT, 'public/modules/transactions-import.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.ok(/import \{ cardLastFourText \} from '\.\/card-last-four\.js'/.test(src), '★要 import 共用安全網');
  assert.ok(!/String\(c\.lastFour\)/.test(src), '★不得裸跑 String(c.lastFour)——{toString:null} 會丟 TypeError');
  assert.ok(!/\$\{c\.lastFour\}/.test(src), '★不得把 c.lastFour 直接插進模板字串——插值就是隱式 String()');
  assert.ok(!/c\.lastFour \?/.test(src), '★不得拿原值當顯示條件短路（0/false 會靜靜消失、物件會走進插值）');
  // 兩個顯示點（選卡窗 options 標籤＋預覽窗 cardOpts 下拉）都要走安全網——不數「幾處」（會漂），
  // 改釘「除了餵給 cardLastFourText 以外，原始碼不得再出現 c.lastFour 這個取值」。
  assert.ok(!/(?<!cardLastFourText\()c\.lastFour/.test(src), '★c.lastFour 只准出現在 cardLastFourText(...) 的引數位置');
});

test('接線｜lib/services/statement-import.js 的 hit 與回應顯示欄走同一支安全網（單一實作、不留兩把尺）', () => {
  const raw = readFileSync(join(ROOT, 'lib/services/statement-import.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.ok(/import \{ cardLastFourText \} from '\.\.\/\.\.\/public\/modules\/card-last-four\.js'/.test(src), '★後端 import 同一支（lib→public 前例＝card-issuers）');
  assert.ok(!/String\(c\.lastFour\)/.test(src), '★hit 不得裸跑 String(c.lastFour)');
  assert.ok(!/function lastFourText/.test(src), '★不得留一份本地複本——同一件事兩把尺是這個 repo 反覆踩到的病');
});
