// @ts-check
// 部署設定的考題（Codex 收官審查 #8／#12／#13）。這裡驗的是「**上線設定檔本身**」，不是程式行為——
// 因為這三個洞都不在程式裡：runtime 版本、onrender 子網域、自動部署時機，全寫在 render.yaml 與 CI。
//
// 誠實劃界：這些是**靜態考題**。它們證明得了「repo 裡寫的是對的」，證明不了
// 「Render 後台真的照這份藍圖跑」（有人手動在後台改設定就會走散）——那一題屬於 C6 部署後人工確認。
// 但**忘記改檔案**這個最常見的失誤，這裡擋得住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_NODE_VERSION, isSupportedNodeVersion, parseNodeVersion } from '../scripts/check-node-version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');
/** 去掉 `#` 註解——免得考題被 render.yaml 裡「C7 要改成…」那段示範註解騙過去。 @param {string} yaml */
const uncommented = (yaml) => yaml.split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n');

// ---- #8：runtime 版本只有一份真相 ------------------------------------------

test('Node 版本：`.node-version` 是唯一真相，且滿足 package.json 的 engines', () => {
  const pinned = read('.node-version').trim();
  assert.ok(parseNodeVersion(pinned),
    '`.node-version` 必須是完整的「主.次.修正」（Render 與 setup-node 都吃這個格式）');
  assert.equal(pinned, pinned.replace(/^v/, ''), '不要寫 v 前綴');
  assert.ok(isSupportedNodeVersion(pinned),
    `釘住的 Node（${pinned}）低於 package.json engines 要求的 ${MIN_NODE_VERSION}——上線會跑一顆連自己都不支援的 runtime`);
});

test('Node 版本：render.yaml **不可以**設 NODE_VERSION（它會蓋掉 .node-version，讓 CI 與部署再度走散）', () => {
  assert.doesNotMatch(uncommented(read('render.yaml')), /key:\s*NODE_VERSION/,
    'Render 的優先序是 NODE_VERSION 環境變數 > .node-version；設了它，CI 讀的 .node-version 就只是裝飾');
});

test('Node 版本：CI 必須讀 .node-version，不可以自己寫死一個數字當主關卡', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /node-version-file:\s*\.node-version/,
    '主關卡要跑「上線那一顆」，否則測過的與上線的不是同一個 runtime');
  // 前瞻 job 寫死版本是可以的，但不准低於 engines（那會測一顆我們自己都不支援的）
  for (const m of ci.matchAll(/node-version:\s*['"]?(\d+)(?:\.\d+\.\d+)?['"]?/g)) {
    const major = Number(m[1]);
    const minMajor = Number(String(MIN_NODE_VERSION).split('.')[0]);
    assert.ok(major >= minMajor,
      `CI 有一個 job 跑 Node ${major}，低於 engines 的 ${MIN_NODE_VERSION}`);
  }
});

// ---- #12：onrender 子網域（繞過 Cloudflare 的後門）--------------------------

test('render.yaml 必須**明寫** renderSubdomainPolicy（不寫＝預設開著，繞過 Cloudflare 的後門）', () => {
  assert.match(uncommented(read('render.yaml')), /renderSubdomainPolicy:\s*(enabled|disabled)/,
    '沒明寫＝onrender.com 子網域開著，任何人都能直連源站、繞過邊緣層的 DDoS／WAF／速率限制');
});

test('render.yaml：**一旦有了 custom domain，子網域就必須關掉**（單向斷言）', () => {
  const yaml = uncommented(read('render.yaml'));
  // ⚠️ 刻意只驗單向。反向（沒有 domains ⇒ 必須 enabled）會在「網域從 Render 後台加好、
  //    render.yaml 沒有 domains: 區塊」的正常情況下，強迫把 onrender 子網域**重新打開**才能讓 CI 綠
  //    ——那正好是這一題要防的事。C7 的檢查表另有一條人工確認（見 C6 操作手冊）。
  if (/^\s*domains:/m.test(yaml)) {
    assert.match(yaml, /renderSubdomainPolicy:\s*disabled/,
      '已經有 custom domain 了，onrender.com 子網域必須關掉——不然邊緣層等於白裝');
  }
});

// ---- #13：自動部署的時機 ---------------------------------------------------

test('render.yaml：用 autoDeployTrigger: checksPass，且不留已淘汰的 autoDeploy', () => {
  const yaml = uncommented(read('render.yaml'));
  assert.match(yaml, /autoDeployTrigger:\s*checksPass/,
    '`autoDeploy: true` ＝每個 commit 立刻上線，型別錯／考題紅也照上');
  assert.doesNotMatch(yaml, /autoDeploy:\s*(true|false)/,
    '兩個都寫時 autoDeployTrigger 勝出，舊欄位留著只會讓下一個人看錯');
});

test('render.yaml：SEC User-Agent 由部署環境提供，不把聯絡資訊硬寫成程式常數', () => {
  const yaml = uncommented(read('render.yaml'));
  assert.match(yaml, /-\s*key:\s*SEC_USER_AGENT\s*\n\s*sync:\s*false/,
    'SEC 自動請求要有可聯絡 User-Agent；實際值由 Render 環境設定，不可漏掉或寫死在程式');
  assert.match(read('docs/C6-部署與對抗審查-操作手冊.md'), /Noteasy williamjung@noteasy\.com\.tw/,
    '部署手冊要留下 William 已確認可收信的正式值，避免上線時再猜一次');
});

test('checksPass 的前提：CI 真的在 main 的每一個 commit 都跑（有路徑過濾就會靜默不部署）', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /push:\s*\n\s*branches:\s*\[main\]/,
    'CI 必須在 push 到 main 時跑，否則 checksPass 等不到任何 check');
  assert.doesNotMatch(ci, /^\s*paths(-ignore)?:/m,
    '有路徑過濾＝某些 commit 不會有 check，checksPass 會讓它們**靜默不部署**（比壞掉更難查）');
});
