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

test('接線｜transactions-import.js 的 .lastFour 點取值全掃（不限變數名）：卡側只准餵 cardLastFourSuffix', () => {
  // ⚠️ 先去註解再掃（cashflow-bank-upload r5 阻擋②同款）：把接線改成註解＝沒接、掃字面會假綠。
  // 掃法（Codex r5 重做）：不釘拼法「c.lastFour」，改掃**每一個** `.lastFour` 點取值、不限受詞——
  // 受詞名單制：r／curR＝伺服器預覽回應（parsed 側，後端已正規化成字串|null，安全）；其餘一律
  // 必須是 cardLastFourSuffix(...) 的引數（卡側原始資料）。改名／新增別名＝紅，紅了來讀這段再決定。
  // ⚠️ 誠實劃界：抓得住所有「點取值」寫法；抓不住 bracket 取值（c['lastFour']）與解構
  //（const {lastFour} = c）——那兩種寫法本檔目前一個都沒有，出現就該在複審被問「為什麼要繞」。
  const raw = readFileSync(join(ROOT, 'public/modules/transactions-import.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.ok(/import \{ cardLastFourSuffix \} from '\.\/card-last-four\.js'/.test(src), '★要 import 行為本體');
  // 行級掃描（受詞正則抓不住 cards[0].lastFour 這種非識別字受詞——一開始就用行級、不釘拼法）：
  // 每一行先摘掉兩種安全形——①cardLastFourSuffix(…) 整段呼叫（引數裡的取值＝卡側走安全網）
  // ②r.／curR. 的取值（預覽回應＝parsed 側，後端已正規化成字串|null）——摘完行內不得殘留
  // `.lastFour`。方向 fail-closed：新受詞、新拼法、巢狀括號讓摘除失手＝紅，紅了來讀這段再決定。
  // ⚠️ 誠實劃界：同一行同時有安全呼叫與另一個裸取值、bracket 取值 c['lastFour']、解構
  //（const {lastFour} = c）不在射程——本檔目前一種都沒有，出現就該在複審被問「為什麼要繞」。
  const lines = src.split('\n').filter(l => l.includes('.lastFour'));
  assert.ok(lines.length > 0, '前提：檔案裡真的有 .lastFour 取值（全刪光＝本題失去對象，回來重寫）');
  for (const line of lines) {
    const stripped = line.replace(/cardLastFourSuffix\([^)]*\)/g, '').replace(/\b(r|curR)\.lastFour/g, '');
    assert.ok(!stripped.includes('.lastFour'),
      `★裸 .lastFour 取值（卡側只准餵 cardLastFourSuffix，預覽回應側只認 r／curR）：${line.trim()}`);
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
