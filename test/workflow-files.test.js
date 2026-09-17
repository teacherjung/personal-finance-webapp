// `.github/workflows/` 的兩件事（2026-09-17 搬家第 5 步從 `test/collab-invariant-docs.test.js` 拆出來）。
//
// ## 這個檔案在防什麼
//
// ① **協作欄位閘的 workflow 檔要逐字等於套件範本** `templates/collab-fields-github.yml`（含結尾換行）。
//    這道閘看的是 PR 說明、不是程式碼，所以它自己一個檔案、`types:` 要明寫 `edited`（`pull_request:` 預設事件
//    不含 edited：先填齊欄位拿綠燈、再編輯說明撤掉欄位，commit 沒變、綠燈還在）；job 的 `name:` 是分支保護
//    required check 的比對字串。這些理由都寫在範本自己的註解裡，本檔不重抄——**本檔守的是「這份檔案沒有被靜靜
//    改成跟範本不一樣」**。
//    ⚠️ 它擋的是「單邊改掉」；**擋不到「連範本一起改」**（範本是套件產物、本專案不改）——那要靠複審的眼睛。
//    ⚠️ 2026-09-17 之前這一題是「逐行等於本檔手寫的一份複本」；切換日起正本＝範本，複本刪掉。
// ② **所有 workflow 的字元集**：只准 SPACE／TAB／LF。對 `collab-fields.yml` 而言這是「與 templates/ 逐字相等」
//    之外的額外格式政策；對其他 workflow（`ci.yml`）而言，這是它們僅有的字元集合防線。判準的由來與射程見
//    `firstBadWorkflowChar()` 的檔頭；列檔→讀檔→掃描這條路的每一段各有一題釘著（漏檔、截斷、濾掉都要紅）。
//
// 倉庫根＝本檔往上一層（本檔住 `test/` 第一層）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

const GATE_WF = '.github/workflows/collab-fields.yml';
const TEMPLATE_WF = 'templates/collab-fields-github.yml';
const WF_DIR = '.github/workflows';

// ── ① 協作欄位閘的 workflow ＝ 套件範本 ────────────────────────────

test('協作欄位閘｜workflow 檔逐字等於 templates/collab-fields-github.yml（含結尾換行；擋「被靜靜改掉」，不擋「連範本一起改」）', () => {
  // ⚠️ **為什麼是整份逐字、不是解析後比對形狀**（#586 r2 Medium）：曾用同檔一支迷你 YAML 讀取器解析再比對，
  //    但那支讀取器**不是 YAML**，兩邊只要有一處認定不同，檔案的真實語意就跑出比對的射程（冒號後不留空白、
  //    縮排裡的 TAB、清單記號後多一個空白、重複的 key——補一種就冒出下一種）。⇒ 不解析，整份逐字。
  // ⚠️ **代價（刻意接受）**：以後動到那個檔案的任何一個字元都會紅，正當的改法是套件那邊改範本、本專案同步。
  //    這只保證那次改動會在 diff 上留下痕跡、不能靜靜發生；**保證不了有人真的看過**（#586 r3）。
  const canon = read(TEMPLATE_WF);
  // 先擋「兩邊都空」：兩個空字串也相等，那樣這一題什麼都沒守。
  assert.ok(canon.trim().length > 0, `${TEMPLATE_WF} 是空的——範本沒了，這一題就沒有正本可比`);
  assert.ok(canon.endsWith('\n'), `${TEMPLATE_WF} 必須以換行結尾（本 repo 只收 LF、檔尾要有換行）`);
  assert.equal(read(GATE_WF), canon,
    `${GATE_WF} 跟 ${TEMPLATE_WF} 不是逐字相同（含結尾換行）。\n`
    + '⚠️ **這一題只比對「整份逐字相等」，沒有任何一段程式在辨識下面那些寫法**——\n'
    + '   列出來是說明**為什麼要釘整份**（那一族列舉不完），不是考題認得它們：\n'
    + '  ・job 或 step 加 `if: ${{ false }}`（被 skip 的 job 在 required check 上回報 **Success**）\n'
    + '  ・`needs:` 一個會失敗的前置 job\n'
    + '  ・step 自訂 `shell`、或**根層 `defaults.run.shell`** 在外層吞掉退出碼\n'
    + '  ・更早的 step 用 `actions/github-script` 把腳本覆寫成 `process.exit(0)`\n'
    + '  ・`run:` 尾端接 `|| true`\n'
    + '  ・`types` 少了 `edited`（欄位填齊拿綠燈 → 編輯說明撤掉欄位 → commit 沒變、綠燈還在）\n'
    + '要改這道閘＝套件那邊改範本、本專案把範本逐字抄回來——那是刻意的動作。');
});

// ── ② 字元集：列檔→讀檔→掃描 ──────────────────────────────────────

/**
 * workflow 檔裡第一個「不准出現」的字元；沒有就回 null。**只准 SPACE、TAB、LF。**
 *
 * ⚠️ **這一條現在守的是什麼**：`collab-fields.yml` 已由「與 templates/ 逐字相等」那題釘住，所以對它而言這條是
 *    **額外的格式政策**（本 repo 只收 LF）；對**其他 workflow**（例如 `ci.yml`）而言，這條是它們
 *    僅有的字元集合防線。
 * ⚠️ **舊版病史（判準的由來，不是現行原因）**：本條出生時，那道比對是先用一支迷你讀取器解析——
 *    它用 `text.split('\n')` 切行、又把「以 `#` 開頭的行」整行丟掉。只要讓它「看不見」一段內容，
 *    那段就不在比對範圍裡。兩條實測過的路（**兩個實測都在本機**，沒有在 GitHub 上驗過服務端解析器）：
 *    ①**換行類**（CR／NEL／LS／PS）：比對只認 LF。把它們夾在一行註解裡、後面接
 *      `continue-on-error: true` ⇒ 比對只看到一行註解、整行丟掉，**四種都靜靜通過**（2026-09-09）。
 *    ②**YAML 不認的空白**（NBSP／全形空白／各種 EN・EM SPACE）：JS 的 `\s` 認它們、YAML 只認
 *      SPACE 與 TAB。所以 `<NBSP># || true` 在 YAML 眼裡是上一個 `run:` 純量的**續行**，
 *      比對卻把它當註解丟掉——#586 r1 High：獨立審查者用真的 YAML 解析器＋真的腳本驗到
 *      **注入版 exit 0**（本機路徑；沒有在 GitHub 上推攻擊 workflow，也沒量服務端解析器）。
 * ⚠️ **不去猜下游怎麼解析，直接拒收**（這是本條的核心）：CR 在 YAML 規格裡就是換行；
 *    NEL／LS／PS 在 YAML 1.1 是換行、1.2 拿掉了，而**我沒有量過 GitHub Actions 用的是哪一版**
 *    （本機沒有 YAML 解析器可驗）。「不知道下游怎麼解讀」的正確反應是**拒收輸入**，不是猜。
 * ⚠️ **「只准這三個空白」用 JS 自己的 Unicode 空白定義（`\s`）表達，不是我列一張表**——列舉補不完。
 *    另外一律拒收 C0、DEL、C1、LS、PS。
 * ⚠️ **這扇門關到哪為止（Grok #586 掃後收窄）**：它對「**JS 空白 ∪ 控制字元區間**」是關起來的，
 *    **不是**對「凡是會讓註解起始符不再位於空白之後的字元」關起來——**格式類（`\p{Cf}`）與零寬類
 *    不在射程內**。`collab-fields.yml` 有「與 templates/ 逐字相等」那題擋著，走不進去；**`ci.yml` 只靠這把尺**。
 *    沒有順手把那兩類也拒收，是因為本 repo 的 workflow 註解用得到變體選擇符與表情符號，
 *    一律拒收會誤擋正常編輯。⇒ **記為待辦**，不在本支收。
 * ⚠️ **照實說代價**：這條會拒收 **CRLF 行尾**，而 CRLF 本身是合法 YAML——本 repo 只收 LF，
 *    所以那是**本 repo 的格式限制**、不是 YAML 錯。踩到時處置分兩種，**別一律說「改成 LF」**：
 *    行尾問題＝在編輯器轉行尾；其餘（意外貼進來的控制字元、NBSP、全形空白）＝刪掉或換成普通空白，
 *    真的要那個字元當內容就用 YAML 的跳脫寫法。**「正常編輯不會產生這些字元」是假話**
 *    （Windows／某些編輯器很容易存成 CRLF），#586 r1 點名，已改口。
 * ⚠️ 這跟 `test/comment-test-refs.test.js` 的控制字元掃描器**不是同一把尺**（⚠️ 那支在**別的檔案**，
 *    所以這裡點檔名、不用「題名關鍵字」記號——那個記號的機械閘只認同檔的題名，我先寫錯過一次、被它擋下）：
 *    那一組掃的是考題檔、而且**放行 CR**（一般文字檔有 CRLF 很正常），也不管 LS／PS 與各種空白。
 *    workflow 這裡必須更嚴，所以另立一把。
 *
 * @param {string} text @returns {{ at: number, code: number } | null}
 */
function firstBadWorkflowChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') continue;   // 僅有的三個例外
    // ⚠️ **只准這三個空白**。判準借 JS 自己的 Unicode 空白定義（`\s`），不是我列一張表——
    //    列舉補不完。YAML 的分隔空白只有 SPACE 與 TAB，所以 NBSP、全形空白、各種 EN／EM SPACE
    //    在 YAML 眼裡都**不是**空白；而 JS 的 `\s` 認它們，兩邊一分岔就是 #586 r1 那個 High。
    const bad = /\s/u.test(ch)
      || code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
      || code === 0x2028 || code === 0x2029;
    if (bad) return { at: i, code };
  }
  return null;
}

/**
 * 掃一組來源，回報「不該出現的字元」**與「實際掃過哪些檔」**。**純函式。**
 * ⚠️ 回傳形狀是物件、不是陣列——#586 r5 抓到這裡的 JSDoc 還寫著 `string[]`。
 *    `jsconfig.json` 沒有把 `test/` 納入型別檢查，所以這種錯**不會被三關的 typecheck 叫**。
 * @param {{ name: string, source: string }[]} sources
 * @returns {{ problems: string[], scanned: string[] }}
 */
function scanWorkflowChars(sources) {
  /** @type {string[]} */
  const problems = [];
  /** ⚠️ **`scanned` 一定要在迴圈裡累積**（#586 r4 Medium）：上一版是從輸入陣列 `map` 出來的，
   *  於是「讀進來了、但送進迴圈前被切掉」或「迴圈自己 `slice` 掉前面幾筆」都照樣回報成掃過。
   *  記錄要來自**實際處理過的那一筆**，才擋得住那段接縫。
   *  @type {string[]} */
  const scanned = [];
  for (const { name, source } of sources) {
    scanned.push(name);
    const hit = firstBadWorkflowChar(source);
    if (hit) {
      problems.push(`  ${name}:${source.slice(0, hit.at).split('\n').length} 有 `
        + `U+${hit.code.toString(16).padStart(4, '0').toUpperCase()}`);
    }
  }
  return { problems, scanned: scanned.sort() };
}

/**
 * 列出一個目錄裡的 workflow 檔並讀進來。
 * @param {string} dir @param {string} label 訊息裡顯示的路徑前綴
 * @returns {{ name: string, source: string }[]}
 */
const workflowSources = (dir = join(ROOT, WF_DIR), label = WF_DIR) => readdirSync(dir)
  .filter((x) => /\.ya?ml$/.test(x))
  .map((f) => ({ name: `${label}/${f}`, source: readFileSync(join(dir, f), 'utf8') }));

/**
 * **正式入口**：一律掃真的 workflow 目錄；`extra` 是額外要一起掃的目錄。
 * ⚠️ **真檢查與誘餌題共用這一支**（#586 r3 Medium①）：上一版把誘餌搬去只掃暫存目錄，
 *    結果「真目錄那一條呼叫」被切成 `[]` 時誘餌照樣通過——兩條呼叫各自獨立，誰斷了另一邊都不知道。
 *    共用同一支、且 `scanned` 由**實際處理過的每一筆**累積之後，這支被掏空、真來源**從名單裡**漏掉、
 *    或在送進掃描迴圈前後被 `slice` 掉，誘餌題都會叫（#586 r3／r4 逐刀驗過）。
 * ⚠️ **照實劃界（Grok #586 掃後點名）**：`scanned` 記的是「**進了迴圈**」，不是「判準看完了這份內容」；
 *    而且真 workflow 平常是乾淨的——所以「只對真檔跳過判準、照樣掃暫存樣本」這種改法**不會**被叫。
 *    ⚠️ **這一族目前沒有東西擋**（#586 r9 Low 更正：我原本寫「位置 × 家族全掃那一題擋得到」，
 *    那是錯的——矩陣的違規字元只種在暫存樣本裡，真檔被特判跳過時它照樣綠）。
 *    「位置 × 家族全掃」守的是**固定暫存樣本經共用路徑的回報**，不是「真檔有沒有被判準看過」。
 * @param {[string, string][]} extra
 * @returns {{ problems: string[], scanned: string[] }}
 */
const scanWorkflows = (extra = []) => {
  const sources = [
    ...workflowSources(),
    ...extra.flatMap(([dir, label]) => workflowSources(dir, label)),
  ];
  // ⚠️ **連「掃了哪些檔」也回報**（#586 r3 Medium①）：只回報「找到幾個問題」的話，
  //    把真來源整組漏掉也是「零個問題」＝零個問題，兩邊都綠。掃了誰要能被斷言。
  //    ⚠️ 那份名單由 `scanWorkflowChars` **在迴圈裡**累積，不是從這裡的輸入 map 出來（#586 r4）。
  return scanWorkflowChars(sources);
};

/** 真 workflow 一定要在被掃的名單裡（每一題都斷言，漏掉整組會在這裡紅）。 */
const REAL_WF_NAMES = [`${WF_DIR}/ci.yml`, `${WF_DIR}/collab-fields.yml`];

test('⭐ workflow 的檔案清單與內容要原樣讀進來（漏檔、截斷、只讀首行都要紅）', () => {
  // ⚠️ 為什麼要單獨釘這一層（#586 r3 Medium②）：只斷言「掃出零個問題」的話，
  //    列檔或讀檔少讀了什麼**也是零個問題**。所以這裡直接釘「列到哪些檔」與「讀進來的內容
  //    等於檔案本身」。新增一支 workflow 要同時改這裡＝那是刻意的動作。
  const sources = workflowSources();
  assert.deepEqual(sources.map((x) => x.name).sort(),
    [`${WF_DIR}/ci.yml`, `${WF_DIR}/collab-fields.yml`],
    'workflow 的檔案清單跟釘住的不一樣（新增／改名／被過濾掉了）');
  for (const { name, source } of sources) {
    assert.equal(source, read(name), `${name} 沒有被原樣讀進來（截斷或只讀首行都會落在這裡）`);
  }
});

test('⭐ workflow 的空白只准 SPACE／TAB／LF', () => {
  const { problems, scanned } = scanWorkflows();
  assert.deepEqual(scanned, REAL_WF_NAMES, '真的 workflow 沒有全部進到被掃的名單裡');
  assert.deepEqual(problems, [],
    'workflow 裡出現不該有的字元（位置見上）。\n'
    + '⚠️ 這不是潔癖，是兩個實測過的情形——**兩個實測都在本機**（本機 YAML 解析器＋本機 shell），\n'
    + '   **沒有在 GitHub 上驗過服務端解析器**：\n'
    + '  ①**換行類**（CR／NEL／LS／PS）：曾經的比對用 LF 切行，看不見它們。\n'
    + '  ②**YAML 不認的空白**（NBSP／全形空白／各種 EN・EM SPACE）：JS 的 `\\s` 認它們、YAML 只認\n'
    + '    SPACE 與 TAB，所以那種行在 YAML 是上一個純量的**續行**，當時的比對卻當註解丟掉。\n'
    + '    #586 r1：獨立審查者用本機 YAML 解析器＋本機 shell 驗到「該版本的腳本回傳 0」。\n'
    + '⚠️ **這一題現在守的是什麼**：`collab-fields.yml` 已由「與 templates/ 逐字相等」那題釘住，所以對它而言\n'
    + '   這條是**額外的格式政策**（本 repo 只收 LF）；對**其他 workflow**（例如 `ci.yml`）而言，\n'
    + '   這條是它們僅有的字元集合防線。\n'
    + '⚠️ **處置分兩種，別一律說「改成 LF」**：\n'
    + '  ・**行尾**是 CRLF ⇒ 在編輯器把行尾轉成 LF（CRLF 本身是合法 YAML，是本 repo 只收 LF）。\n'
    + '  ・**其餘**（意外貼進來的控制字元、NBSP、全形空白）⇒ **刪掉或換成普通空白**；\n'
    + '    真的需要那個字元當內容，請用 YAML 的跳脫寫法。');
});

test('⭐ 列檔→讀檔→掃描整條路：暫存目錄裡的違規檔要抓到，近似副檔名不可誤抓', () => {
  // ⚠️ 這一題與題名關鍵字「workflow 的空白只准 SPACE」那一題**走同一支 `scanWorkflows`**，
  //    所以正式入口被掏空時這裡也會紅。
  // ⚠️ 涵蓋 #586 r3 Medium② 點名的四種退化：只認 `.yml`（漏 `.yaml`）、列檔被截斷、
  //    讀檔被截斷（違規字元在後段）、過濾正則掉了尾端 `$`（誤抓 `.yaml.txt`）。
  const dir = mkdtempSync(join(tmpdir(), 'wf-probe-'));
  try {
    // ⚠️ 暫存目錄開在系統 tmp、**不開在 repo 裡**：開在 repo 裡會被別的掃描器數到（併發假紅）。
    const CR = String.fromCharCode(0x0d);
    writeFileSync(join(dir, 'a-bad.yml'), `name: x\n# probe${CR}continue-on-error: true\n`);
    writeFileSync(join(dir, 'b-late.yaml'), `name: y\n${'# filler\n'.repeat(40)}tail${CR}\n`);
    writeFileSync(join(dir, 'zz-last.yml'), `name: z\nrun: ok${CR}\n`);
    writeFileSync(join(dir, 'c-good.yml'), 'name: fine\n  run: ok\n');
    writeFileSync(join(dir, 'd-ignored.txt'), `not a workflow${CR}\n`);
    writeFileSync(join(dir, 'e-probe.yaml.txt'), `also not one${CR}\n`);
    // ⚠️ 沒有副檔名：把過濾正則裡的 `\.` 寫成 `.`（萬用字元）就會把它誤算成 workflow（#586 r4 Low）
    writeFileSync(join(dir, 'f-probe-yaml'), `no extension${CR}\n`);
    // ── 下面三支是 #586 r5 點名的「讀進來之後、送進判準之前」那段接縫，每支各釘一種退化 ──
    const NBSP = String.fromCharCode(0xa0);
    // ⚠️ 違規字元是**整個檔案的最後一個字元、後面沒有換行**：`source.slice(0, -1)` 會漏掉它
    writeFileSync(join(dir, 'g-eof.yml'), `name: g\n# probe${CR}`);
    // ⚠️ 違規字元在**很後面**（超過 8 KiB）：任何 `slice(0, 8192)` 之類的截斷都會漏掉它
    writeFileSync(join(dir, 'h-far.yml'), `name: h\n# ${'x'.repeat(9000)}${NBSP}\n`);
    // ⚠️ 違規字元**不是 CR**：只回報 CR 的過濾、或送判準前把 NBSP 換成普通空白，都會漏掉它
    writeFileSync(join(dir, 'i-nbsp.yml'), `name: i\n# note${NBSP}\n`);
    // ⚠️ 大寫副檔名：本 repo 的政策是**只收小寫** `.yml`／`.yaml`；過濾正則加上 `i` 旗標
    //    就會把它列進來（#586 r5 Low）。它含違規字元，所以誤收會讓問題清單多一筆。
    writeFileSync(join(dir, 'j-UPPER.YAML'), `name: j\n# upper${CR}\n`);
    // ⚠️ 違規字元在**第 0 個位置**（檔案第一個字元）：判準迴圈從 1 開始、送判準前 `slice(1)`、
    //    或把命中判成 `if (hit?.at)`（位置 0 是 falsy）都會漏掉它。碼位同時 **> U+00FF**，
    //    所以「只回報 U+00FF 以內」「把非 Latin-1 換成空白」「只認已出現過的碼位」也一起釘住。
    writeFileSync(join(dir, 'k-bom.yml'), `${String.fromCharCode(0xfeff)}name: k\n`);
    // ⚠️ 另一個 > U+00FF 的違規字元，而且**不在第 0 個位置**（跟上一支分開釘，失敗訊息才看得出是哪一種）
    writeFileSync(join(dir, 'l-wide.yml'), `name: l\n# probe${String.fromCharCode(0x2003)}\n`);
    const { problems, scanned } = scanWorkflows([[dir, 'probe']]);
    assert.deepEqual(scanned, [...REAL_WF_NAMES, 'probe/a-bad.yml', 'probe/b-late.yaml',
      'probe/c-good.yml', 'probe/g-eof.yml', 'probe/h-far.yml', 'probe/i-nbsp.yml',
      'probe/k-bom.yml', 'probe/l-wide.yml', 'probe/zz-last.yml'].sort(),
      '被掃的名單不對：真 workflow 漏掉了，或把不是 workflow 的檔也列進來');
    assert.deepEqual(problems.sort(), [
      '  probe/a-bad.yml:2 有 U+000D',
      '  probe/b-late.yaml:42 有 U+000D',
      '  probe/g-eof.yml:2 有 U+000D',
      '  probe/h-far.yml:2 有 U+00A0',
      '  probe/i-nbsp.yml:2 有 U+00A0',
      '  probe/k-bom.yml:1 有 U+FEFF',
      '  probe/l-wide.yml:2 有 U+2003',
      '  probe/zz-last.yml:2 有 U+000D',
    ], '列檔／讀檔／掃描這條路上有一段沒做事（或把命中結果過濾掉了）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 位置 × 家族全掃：違規字元插在**每一個位置**，走完整條路都要回報得一模一樣', () => {
  // ⚠️ **為什麼要有這一題（#586 r1〜r6 的收斂點）**：前六輪每一輪都是「誘餌少了某一種形狀」——
  //    位置 0、檔尾沒換行、超過 8 KiB、不是 CR、碼位大於 U+00FF…**形狀是無窮的，列不完**。
  //    所以這裡不再加形狀，改成**把位置掃完**：拿一份乾淨的小 workflow，把一個違規字元插進
  //    **每一個可能的位置**（含最前面與最後面），每次都走**正式入口**（列檔→讀檔→掃描→回報），
  //    斷言問題清單逐字相符。**在這份固定樣本與這組代表字元的矩陣內**，「某個位置被切掉／換掉／濾掉」
  //    這一族就關門了。
  // ⚠️ **照實寫兩題的證據範圍**（#586 r7 Low：我原本說得太滿）：
  //    ・題名關鍵字「整個家族都要拒收」那一題：C0 與 C1 是**逐碼位**掃過的，
  //      **Unicode 空白只取代表值**——U+2001／U+2002／U+2004／U+2006〜U+2009 就沒進到那一題。
  //    ・本題：**固定樣本的每一個插入位置**，各家族代表字元，走完整入口比對回報。
  //    ⇒ 兩題是**互補**，不是「射程不同、不重複」：那一題本身也測位置與檔尾，兩者有重疊。
  const base = 'name: probe\n# comment\nrun: ok\n';
  const FAMILIES = [0x00, 0x0d, 0x7f, 0x85, 0xa0, 0x2003, 0x2028, 0xfeff];
  const dir = mkdtempSync(join(tmpdir(), 'wf-sweep-'));
  try {
    for (const code of FAMILIES) {
      const label = `U+${code.toString(16).padStart(4, '0').toUpperCase()}`;
      for (let at = 0; at <= base.length; at += 1) {
        const text = base.slice(0, at) + String.fromCharCode(code) + base.slice(at);
        writeFileSync(join(dir, 'probe.yml'), text);
        const { problems, scanned } = scanWorkflows([[dir, 'sweep']]);
        const line = text.slice(0, at).split('\n').length;
        assert.deepEqual(problems, [`  sweep/probe.yml:${line} 有 ${label}`],
          `${label} 插在第 ${at} 個位置（第 ${line} 行）沒有被原樣回報——`
          + '這條路上有一段把它切掉、換掉或濾掉了');
        assert.ok(scanned.includes('sweep/probe.yml') && scanned.length === REAL_WF_NAMES.length + 1,
          `${label} 插在第 ${at} 個位置時，被掃的名單不對：${scanned.join('｜')}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 判準本身：整個家族都要拒收、位置要報對、正常內容要放行', () => {
  const ok = 'name: x\n  run: y\t# 註解\n中文與 emoji 🚦 都正常\n';
  assert.equal(firstBadWorkflowChar(ok), null, 'SPACE／TAB／LF／一般文字被誤擋了');

  // ── 逐一點名的（每一個都是實測過或規格上的夾帶路徑）
  for (const [label, code] of /** @type {[string, number][]} */ ([
    ['CR U+000D', 0x0d], ['NEL U+0085', 0x85], ['LS U+2028', 0x2028], ['PS U+2029', 0x2029],
    ['NBSP U+00A0', 0xa0], ['EM SPACE U+2003', 0x2003], ['IDEOGRAPHIC SPACE U+3000', 0x3000],
    ['NUL U+0000', 0x00], ['VT U+000B', 0x0b], ['FF U+000C', 0x0c], ['DEL U+007F', 0x7f],
    ['ZWNBSP U+FEFF', 0xfeff],
  ])) {
    const hit = firstBadWorkflowChar(`# 註解${String.fromCharCode(code)}continue-on-error: true\n`);
    assert.ok(hit && hit.code === code, `${label} 沒有被拒收——那就是夾帶進來的那條路`);
  }

  // ── **整個家族**，不是只有點名的那幾個（#586 r1 Medium：把區間改成只判 0x85 也全綠）
  for (const [label, codes] of /** @type {[string, number[]][]} */ ([
    ['C0（0x00–0x1F，扣掉 TAB／LF）', [...Array(0x20).keys()].filter((c) => c !== 0x09 && c !== 0x0a)],
    ['C1（0x80–0x9F，含兩端）', [...Array(0x20).keys()].map((c) => c + 0x80)],
    ['Unicode 空白分隔（含兩端與中間）', [0x1680, 0x2000, 0x2005, 0x200a, 0x202f, 0x205f]],
  ])) {
    for (const code of codes) {
      const hit = firstBadWorkflowChar(`a${String.fromCharCode(code)}b`);
      assert.ok(hit && hit.code === code, `${label} 裡的 U+${code.toString(16).toUpperCase()} 沒被拒收`);
    }
  }

  // ── 位置要對，而且**最後一個字元**也要掃到（把迴圈寫成 length - 1 就會漏）
  assert.deepEqual(firstBadWorkflowChar('ab\r'), { at: 2, code: 0x0d }, '檔尾的違規字元漏掃了');
  assert.deepEqual(firstBadWorkflowChar(`ab${String.fromCharCode(0xa0)}cd`), { at: 2, code: 0xa0 },
    '回報的位置不對——訊息會指到錯的行');
  assert.equal(firstBadWorkflowChar(`${'x'.repeat(9000)}\r`)?.at, 9000, '晚位置的違規字元漏掃了');
});
