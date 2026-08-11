// @ts-check
// #modal-root 世代擁有權（P0.5 r6→r7）：純邏輯行為題（DOM 無關）＋ 全站開窗點的接線形狀題。
// 為什麼要它：全站表單 onSubmit 有 await，回來時可能 (1) 已切頁、或 (2) 期間開了新彈窗——
// 舊的成功 continuation 不可 close() 掉後開的彈窗、也不可在新頁報過期錯誤。owns() 用兩個判準
// 判「這一格還是不是我的」：世代章（開窗/關窗都會蓋新章）＋路由序號（切頁會前進）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
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

test('擁有權｜release() 撤銷擁有權：關窗後舊持有者的 owns() 立刻變 false（不再誤 close/toast）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true, '剛 claim＝擁有');
  claim.release();   // 關窗＝撤銷
  assert.equal(owns(), false, '關窗後舊 async 回來時 owns() 為 false＝不會對已關的窗 close/toast');
});

test('擁有權｜路由前進（切頁）讓 owns() 變 false——即使沒有任何新彈窗接管', () => {
  let cell = 0, route = 5;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; }, readRoute: () => route });
  const owns = claim();
  assert.equal(owns(), true, '同一頁、章沒動＝擁有');
  route = 6;   // 單純切頁：routeSeq 前進，但沒有人 claim（沒有新彈窗）
  assert.equal(owns(), false, '切頁後舊 async 的 close/toast 作廢——這正是 r7 Codex 指出、只靠世代章補不到的漏');
  route = 5;   // 就算路由又轉回同一個號（理論上不會，routeSeq 單調遞增），章沒被搶還是自己的
  assert.equal(owns(), true, 'routeSeq 是單調遞增，這裡只驗判準本身：路由相符＋章未被搶＝仍擁有');
});

test('擁有權｜沒給 readRoute 時退化成純世代章判準（相容舊呼叫端）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true, '沒有 readRoute＝不看路由，只看章');
});

/** 去註解（接線題掃原始碼形狀，先拿掉註解）。 @param {string} raw */
function strip(raw) { return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }

test('接線｜openForm 的 async onSubmit 只在 owns() 時 close/toast；關窗即 release；三個中央開啟點都 claim', () => {
  const app = strip(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
  assert.match(app, /export function claimModalRoot\(\)/, 'claimModalRoot 存在');
  assert.match(app, /export function releaseModalRoot\(\)/, 'releaseModalRoot 存在（關窗撤銷擁有權）');
  assert.match(app, /readRoute: \(\) => currentRouteSeq\(\)/, 'owns() 要吃路由序號（切頁作廢）；且包一層箭頭避 TDZ');
  assert.match(app, /const owns = claimModalRoot\(\);/, 'openForm 要在開窗當下 claim 並留 owns');
  assert.match(app, /await onSubmit\(out\); if \(owns\(\)\) close\(\);/, 'onSubmit 後只在仍擁有時才 close');
  assert.match(app, /catch \(err\) \{ if \(owns\(\)\)/, '失敗也只在仍擁有時才 toast（不報過期錯誤）');
  // openForm＋openInfo 的 close 都要 release（關窗撤銷）
  assert.ok((app.match(/releaseModalRoot\(\);/g) || []).length >= 2, 'openForm/openInfo 的 close 都要 releaseModalRoot');
  const shell = strip(readFileSync(join(ROOT, 'public/modules/modal-shell.js'), 'utf8'));
  assert.match(shell, /claimModalRoot\(\)/, 'openModalShell 也要 claim（否則舊表單 async close 會清掉它）');
  assert.match(shell, /releaseModalRoot\(\)/, 'openModalShell 的 close 也要 release');
});

/** 遞迴列出 public/ 底下所有 .js。 @param {string} dir @returns {string[]} */
function listJs(dir) {
  /** @type {string[]} */ const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ⭐ 關門題（Codex r7 要求：讓考題盤點所有 #modal-root writer）：任何**直接**把 modal-bg 外殼寫進
// #modal-root 的開窗點，都必須 claimModalRoot()——否則在途的 openForm(async) 回來時會誤判仍擁有、
// 清掉這個後開的窗。中央外殼（app.js 的 openForm/openInfo、modal-shell.js 的 openModalShell）本身
// 就是 claim 的實作，所以豁免；其餘檔案：claimModalRoot 次數必須 ≥ 直接開窗點次數。
// 這道題是「列舉繞法補不完就關門」：以後有人新增手刻彈窗、忘了 claim，這裡直接轉紅。
test('⭐ 接線｜每個直接寫 modal-bg 進 #modal-root 的開窗點都要 claimModalRoot（关门·防未來漏網）', () => {
  const CENTRAL = new Set(['public/app.js', 'public/modules/modal-shell.js']);
  const openerRe = /innerHTML\s*=\s*`<div class="modal-bg"/g;
  const claimRe = /claimModalRoot\(\)/g;
  let checked = 0;
  for (const f of listJs(join(ROOT, 'public'))) {
    const rel = relative(ROOT, f).split('\\').join('/');
    if (CENTRAL.has(rel)) continue;
    const src = strip(readFileSync(f, 'utf8'));
    const opens = (src.match(openerRe) || []).length;
    if (opens === 0) continue;
    const claims = (src.match(claimRe) || []).length;
    assert.ok(claims >= opens, `${rel}：${opens} 個直接開窗點但只有 ${claims} 次 claimModalRoot——每個手刻彈窗都要 claim`);
    checked += opens;
  }
  assert.ok(checked >= 3, `應至少盤到 assets(×2)＋settings-store-rules(×1)＝3 個手刻開窗點，實得 ${checked}`);
});
