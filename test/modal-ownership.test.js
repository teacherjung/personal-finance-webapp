// @ts-check
// #modal-root 世代擁有權（P0.5 r6）：純邏輯行為題（DOM 無關）＋ app.js/modal 開啟點的接線形狀題。
// 為什麼要它：全站表單 onSubmit 有 await，回來時可能已切頁或期間開了新彈窗——舊的成功 continuation
// 不可 close() 掉後開的彈窗。owns() 用世代章判「這一格還是不是我的」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeModalOwnership } from '../public/modules/modal-ownership.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('擁有權｜新 claim 讓舊持有者的 owns() 立刻變 false；最新的一份 owns() 為 true', () => {
  let cell = 0;   // 假的共用格（＝真實碼裡 #modal-root 的 dataset.modalGen）
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const ownsA = claim();
  assert.equal(ownsA(), true, '剛 claim＝擁有');
  const ownsB = claim();   // 第二個彈窗接管
  assert.equal(ownsA(), false, '被後來的 claim 蓋章＝舊的不再擁有（舊 async close 就作廢）');
  assert.equal(ownsB(), true, '最新的一份擁有');
  const ownsC = claim();
  assert.deepEqual([ownsA(), ownsB(), ownsC()], [false, false, true], '永遠只有最新那一份 owns');
});

test('擁有權｜owns() 讀的是「當下」的章（外部把格清成 0 也不再擁有）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true);
  cell = 0;   // 例如 modal-root 被清空、dataset 沒了
  assert.equal(owns(), false, '章不見了＝不擁有（不會誤 close 空格或別人的內容）');
});

/** 去註解（接線題掃原始碼形狀，先拿掉註解）。 @param {string} raw */
function strip(raw) { return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }

test('接線｜openForm 的 async onSubmit 只在 owns() 時 close/toast；三個開啟點都 claim（切頁議題根因）', () => {
  const app = strip(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
  assert.match(app, /export function claimModalRoot\(\)/, 'claimModalRoot 存在');
  assert.match(app, /const owns = claimModalRoot\(\);/, 'openForm 要在開窗當下 claim 並留 owns');
  assert.match(app, /await onSubmit\(out\); if \(owns\(\)\) close\(\);/, 'onSubmit 後只在仍擁有時才 close');
  assert.match(app, /catch \(err\) \{ if \(owns\(\)\)/, '失敗也只在仍擁有時才 toast（不報過期錯誤）');
  // openForm＋openInfo 兩個 app.js 內的開啟點都 claim
  assert.ok((app.match(/claimModalRoot\(\)/g) || []).length >= 3, 'openForm/openInfo 都要 claim（含 export 那行共 ≥3 處）');
  const shell = strip(readFileSync(join(ROOT, 'public/modules/modal-shell.js'), 'utf8'));
  assert.match(shell, /claimModalRoot\(\)/, 'openModalShell 也要 claim（否則舊表單 async close 會清掉它）');
});
