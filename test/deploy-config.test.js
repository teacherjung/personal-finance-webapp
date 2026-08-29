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
  assert.match(read('docs/C6-部署與對抗審查-操作手冊.md'), /NotEasy hsiangsenjung@gmail\.com/,
    '部署手冊要留下 William 拍板的正式值，避免上線時再猜一次');
  // 產品名稱一律 `NotEasy`（不是 Noteasy／noteasy）——大小寫錯了在畫面上很醒目，
  // 而 SEC 拿這串當「這是誰的程式」的識別，寫錯等於對外自報錯名字。
  assert.doesNotMatch(read('docs/C6-部署與對抗審查-操作手冊.md'), /\bNoteasy\b/,
    '產品名稱是 NotEasy，不是 Noteasy');
});

test('checksPass 的前提：CI 真的在 main 的每一個 commit 都跑（有路徑過濾就會靜默不部署）', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /push:\s*\n\s*branches:\s*\[main\]/,
    'CI 必須在 push 到 main 時跑，否則 checksPass 等不到任何 check');
  assert.doesNotMatch(ci, /^\s*paths(-ignore)?:/m,
    '有路徑過濾＝某些 commit 不會有 check，checksPass 會讓它們**靜默不部署**（比壞掉更難查）');
});

// ============================================================================
// xlsx 的來源（William 2026-07-29 裁決）
// ============================================================================

test('xlsx 從原廠 CDN 裝，而且 lockfile 有 integrity 指紋（別「順手」改回 npm）', () => {
  // 為什麼不用 npm 上的：npm 最新只到 0.18.5（SheetJS 三年多沒再發佈到 npm），
  // 而那個版本有兩個 advisory——**上游早就修好了**（0.19.3／0.20.2），只是改由自家 CDN 發佈。
  // `fixAvailable: false` 是「買不到」，不是「沒修好」。
  //
  // ⚠️ 這一題防的是「有人看到 package.json 裡是網址覺得怪，順手改回 ^0.18.5」。
  //    改回去＝把兩個已修好的漏洞加回來。
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.dependencies.xlsx, /^https:\/\/cdn\.sheetjs\.com\/xlsx-\d+\.\d+\.\d+\//,
    'xlsx 必須指向 SheetJS 官方 CDN 的 tarball（見 docs/多人上線-施工計畫.md 裁決速查表③）');

  const lock = JSON.parse(read('package-lock.json'));
  const entry = Object.entries(lock.packages || {}).find(([k]) => k.endsWith('node_modules/xlsx'));
  assert.ok(entry, 'lockfile 裡找不到 xlsx');
  const [, v] = /** @type {any} */ (entry);
  assert.match(String(v.resolved), /^https:\/\/cdn\.sheetjs\.com\//, 'lockfile 的 resolved 要是 CDN 網址');
  // integrity 是這條路唯一的供應鏈保護：CDN 上的檔案被換掉 → 雜湊對不上 → npm ci 直接失敗。
  assert.match(String(v.integrity), /^sha512-/,
    'lockfile 一定要有 integrity 雜湊——沒有它，CDN 被換檔我們不會知道');
  assert.ok(/^0\.(19\.[3-9]|19\.\d\d|[2-9]\d*\.)/.test(String(v.version)),
    `xlsx 版本要 ≥ 0.19.3（兩個 advisory 的修正版），實際 ${v.version}`);
});

test('CI 對草稿也要跑：ci.yml 生效行不准出現 draft（2026-08-29 半鬆綁）', () => {
  const ci = read('.github/workflows/ci.yml');
  // ⚠️ 只掃**生效的設定**，不掃註解——註解裡寫「draft」是在講歷史與理由，不是條件。
  //    行尾註解也要剝（Grok #526 掃到：只丟「整行 # 開頭」的話，把真 types 改掉、
  //    舊列表當行尾備註留著＝types 斷言命中的是註解＝假綠）——沿用同檔的 uncommented()。
  const active = uncommented(ci).split('\n').filter((l) => l.trim() !== '');
  // ⚠️ 掃「任何生效行」而不是只掃 `if:` 行（2026-08-29 預審抓到的洞）：YAML 多行寫法
  //    （`if: >-` 換行接條件）會讓「if: 與 draft 同一行」的判準靜靜漏抓——被拆掉的那條
  //    原本就 70+ 字元，日後折行加回來剛好繞過。改成整行掃，折行、env 間接引用都逃不掉。
  const hits = active.filter((l) => /draft/i.test(l));
  assert.deepEqual(hits, [],
    'ci.yml 的生效設定又出現 draft（草稿跳過？）——省錢的理由已隨 repo 公開消失，而「草稿不考」'
      + '的代價實測過：本機三關全在 macOS，Linux 才壞的東西要到轉 ready 才現形、每修一條'
      + '重拿一張「通過」＝燒審查輪。真有正當理由要在設定裡寫 draft 的話，改這題時必須連'
      + ' REVIEW-AND-MERGE.md「省額度慣例」節與 docs/GitHub分支保護-設定與驗證.md 一起改'
      + '——別留兩種相反答案並存。');
  // ⚠️ 本題的身分＝**防「不小心加回去」的絆線，不是防惡意 YAML 的安全閘**（Codex #526
  //    r1 中①→r2 中① 兩輪釐清出來的劃界）：安全不變量「能合併的 head 一定跑過真考卷」
  //    住在 scripts/check-ci-really-ran.js——就算有人把跳過加回來，合併頭仍要有真 success
  //    才合得了；本題丟的只是「草稿期的早期訊號」（macOS/Linux 盲點回到 ready 才現形），
  //    是流程品質、不是安全。對手是「未來在成本壓力下順手加回 if 的自己人」，不是 YAML
  //    寫法高手——所以用正則收攏**常見拼法**（`if:`／`if :`／`"if":`／`'if':`，r2 抓到
  //    後兩種），不引入 YAML 解析器去追殺 flow-map、explicit-key、跳脫鍵這些沒人會
  //    不小心寫出來的形狀（列舉補不完；為非安全絆線加相依不成比例）。
  //    本檔兩個 job（required 的上線 Node＋探照燈 dev-machine）必須無條件執行；日後真需要條件（如 step 級 if: failure()）＝
  //    有意識地連同本題、ci.yml 註解與 REVIEW-AND-MERGE.md「省額度慣例」節一起改。
  //    間接層（composite action／reusable workflow）同樣掃不到——靠審查（`uses:` 本地
  //    路徑＝訊號）。
  // 清單項寫法也收（Grok #526 低）：step 級 if 常寫成 `- if: …`（dash 後才是鍵）。
  const conds = active.filter((l) => /^\s*(?:-\s*)?["']?if["']?[^\S\n]*:/.test(l));
  assert.deepEqual(conds, [],
    'ci.yml 出現 if: 條件——本檔兩個 job（required 的「上線用的 Node」＋探照燈 dev-machine，與其步驟）必須無條件執行，否則「草稿也照跑」'
      + '只是註解宣稱。2026-08-15〜08-29 的草稿跳過正是一條 job 級 if；等價寫法'
      + '（event_name/action 判斷）不含 draft 字也一樣跳過草稿場次。真有正當理由加條件，'
      + '請連本題、ci.yml 註解與 REVIEW-AND-MERGE.md「省額度慣例」節一起改。');
  // 「草稿也跑」的前提是 pull_request 事件本身有訂閱（opened/synchronize 對草稿也會發）；
  // ready_for_review 留著＝補考保險。types 列表變動＝這個前提可能被抽走，要人來看。
  // ⚠️ 只對**生效行**斷言（預審抓到）：掃全文的話，types 行被改掉、而某條註解引用舊字面
  //    （本 repo 註解慣常逐字引用退役設定，ci.yml 檔頭就有一例）＝斷言靜靜通過。
  assert.match(active.join('\n'), /types: \[opened, synchronize, reopened, ready_for_review\]/,
    'pull_request 的 types 變了——草稿期照跑靠 opened/synchronize 事件，'
      + 'ready_for_review 是「萬一沒跑成，轉正式補考一次」的保險；動這行要連同上一題的前提一起想');
});
