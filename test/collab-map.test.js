// @ts-check
// **協作規矩地圖的地址要是真的**（`COLLAB-MAP.md`）。
//
// ## 這支守什麼
//
// 那份地圖只做一件事：把「我想查 X」導到「哪一份的哪一節」。
// 導錯的地圖比沒有地圖更糟——照著走的人會以為自己讀過了，實際上讀到的是別的東西，
// 或根本沒到（節被改名／檔案被搬走，地圖不會自己知道）。
//
// ## 為什麼是**白名單文法**，不是「再補一種寫法」
//
// `Codex #545 r1` 抓到三條假綠路、`r2` 又抓到五條**彼此獨立**的：註解藏列、拿掉行首 `|`、
// 插一行 `| | |` 讓真資料被當成表頭、顯示名與目的路徑不符、把標題降成普通行仍被行首標籤放行。
// 這是「列舉繞法補不完」的典型形狀——每補一種寫法，下一輪就有第六種。
// ⇒ 所以這裡**反過來做**：路由區塊只准出現列舉得完的幾種**行**（空行／`###` 小標／
// 指定表頭＋真的分隔列／唯一合法的路由列），其他一律紅。要新增寫法就要先改這份文法，
// 那是刻意的摩擦——不是繞過它的方法。
//
// ## ⚠️ 但它只是**行級**檢查，不理解 Markdown 的結構（William 2026-09-02 裁定的射程）
//
// `r3` 示範了這道牆真正的高度。**下面每一發我都自己重跑量過**（不是照抄他的清單——
// 他列的「在路由列尾端插第三欄」我實測是**紅**的，照抄就會寫出一條不實的劃界）：
//
//   仍然全綠（＝看不到）：
//   - 拿掉整張路由表的**表頭與分隔列**——表格還在不在，它不知道。
//   - 在**儲存格裡**插一個未跳脫的 `|`：畫面上變成三欄，解析仍當合法的兩欄。
//   - 用 ``` 把**閘表**整張包成程式碼區塊——那一區容許說明文字，fence 行被當說明放行。
//   - 把真錨點改名、只在 ``` 裡留一個 `**錨點**`——`anchorIsStructural()` 不知道自己在 fence 裡。
//   - 把真錨點改名、把 `**錨點**` 搬到**毫不相關的章節**底下——它只問「某處有沒有」，不問在哪一章。
//   - 拿掉路由表的表頭與分隔列、在第一格塞兩個連結、在閘區塊加 markdown 註腳——版面約定不等於考題。
//
//   會紅（＝看得到，同樣不宣稱列完）：在路由列**尾端**多一欄、在**路由區塊**裡放 fence
//   （含 fence 內的假標題）、把受稽核的節標題改名或弄成重複、閘表把同一支腳本列兩次。
//
//   還有一類**不是 markdown 花招、而是整理文件時很常見**的（`Grok #545 掃`）：
//   把某一張表的 `###` 小標**升成 `##`**，`sectionLines()` 就在那裡截斷，後面幾張表**整段退出檢查**。
//   會不會轉紅，取決於**截斷點之前有沒有集齊三份正本**：沒集齊＝「三份正本」那題碰巧紅；
//   已集齊＝後段整批退出檢查，照樣全綠。**那道紅是碰巧，不是設計**——不要當成有網子接著。
//
//   ⚠️ 上面各欄都是**量過的例子，不是完整清單**——沒有人能列完 markdown 的寫法。
//
// 要擋這些，得換成真的 GFM 解析、或改成「由結構化資料生成整份地圖」。
// **William 2026-09-02 裁定：不做**——理由是這道護欄在防的是**自然的腐爛**
// （檔案被搬走、節被改名、加了新閘沒登記），不是有人刻意把地圖寫成怪格式。
// 對非安全用途的護欄，這個 repo 的既有教訓是「劃界勝過為它造一台解析器」。
// **所以射程照實寫在這裡：容器（code fence）、表格存不存在、欄位結構，一律不在保證內。**
//
// ## 誠實劃界（不要把這支當成「地圖是對的」的保證）
//
// 它驗的是**地址與行的寫法**，不是**內容**、也不是 Markdown 結構：
// - **驗不到**「那一節是不是還在講那件事」——節名沒動、整段改寫成別的規則，這支照樣綠。
// - **驗不到**地圖有沒有把規則判準抄進去。`r1`、`r2` 兩次都是靠人讀出來的
//   （第一版抄了聯集閘與堆疊閘的判準，第二版左欄還留著考題判準）。這條紀律**只有人在守**。
// - **驗不到**地圖收得夠不夠全——它本來就宣告自己是選錄。
// - **驗不到**站外那一條（`../teaching-videos/AGENTS.md`）：別的 repo、不保證在這台機器上。
// - 「選錄，不對帳」那張表**刻意不驗**：它列的不是閘，沒有可對帳的自報來源。
// - 閘表對的是**合併步驟裡實際會跑的那一組**（與 `collab-invariant-docs` 共用 `gatesRunInMergeSteps()`）；
//   兜底則寬到「`scripts/` 遞迴底下的 `.js`／`.mjs`／`.cjs` 只要**提到** `MERGE_GATE`，就要真的在那一組裡」。
//   **副檔名以外的檔案不掃**（`.ts`、`.sh`、無副檔名的可執行檔都不在內），
//   而且兩者**都只認 `MERGE_GATE` 這個名字**——改用別的 export 名開一道閘，這裡看不到。
// - **驗不到** Markdown 的容器與表格結構（見上一節逐條列的那幾發）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatesRunInMergeSteps } from './helpers/merge-gates.js';
import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

const MAP = 'COLLAB-MAP.md';

/** 三份正本——地圖至少要導得到它們，否則它導的是別的東西。 */
const CANON = ['AGENTS.md', 'REVIEW-AND-MERGE.md', 'CLAUDE.md'];

/** 路由區塊與閘區塊的**完整標題行**（精確比對，不是「含有關鍵字」——誘餌標題會把檢查引去別區）。 */
const ROUTE_HEADING = '## 我想查⋯⋯';
const GATE_HEADING = '### 合併步驟專用的閘';

const ROUTE_TABLE_HEAD = '| 問題 | 去哪讀 |';
const GATE_TABLE_HEAD = '| 閘 | 腳本 |';
const TABLE_SEP = '|---|---|';

/** 路由列的唯一合法寫法。顯示名與路徑必須是同一串（分開驗，見下）。 */
const ROUTE_ROW = /^\| (.+?) \| \[([^\]]+)\]\(([^)\s]+)\)「([^」]+)」 \|$/;
/** 閘列的唯一合法寫法。 */
const GATE_ROW = /^\| (.+?) \| \[([^\]]+)\]\(([^)\s]+)\) \|$/;

/**
 * 取 `<標題行>` 之後到下一個同級或更高級標題之前的行。
 * 標題行必須**完整相等且只出現一次**——`includes` 比對會被誘餌標題騙走。
 * @param {string[]} lines @param {string} heading
 */
function sectionLines(lines, heading) {
  const hits = lines.filter((l) => l === heading).length;
  assert.equal(hits, 1, `${MAP} 裡「${heading}」出現 ${hits} 次，必須剛好一次（0＝節被改名／>1＝有誘餌標題）。`);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const rest = lines.slice(lines.indexOf(heading) + 1);
  const end = rest.findIndex((l) => /^#+\s/.test(l) && (l.match(/^#+/)?.[0].length ?? 9) <= level);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * 白名單文法：逐行掃區塊，只放行列舉得完的幾種行，其餘一律丟例外。
 * ⚠️ `allowProse` 是**宣告過的例外**（閘區塊要放說明文字），不要把本函式說成「只准四種行」。
 *
 * @param {string[]} lines 區塊內容
 * @param {string} tableHead 這個區塊唯一合法的表頭行
 * @param {RegExp} rowRe 這個區塊唯一合法的資料列寫法
 * @param {string} where 錯誤訊息用的區塊名
 * @param {boolean} [allowProse] 這個區塊容不容許說明文字（閘區塊有；路由區塊沒有）。
 *   即使容許，**任何含有 markdown 連結 `](` 的行仍必須是合法資料列**——
 *   「拿掉行首 `|`」那一發就是靠這條擋下來的（`Codex #545 r2`）。
 * @returns {RegExpExecArray[]} 依序抽到的資料列
 */
function strictRows(lines, tableHead, rowRe, where, allowProse = false) {
  /** @type {RegExpExecArray[]} */
  const rows = [];
  let prevWasHead = false;
  for (const line of lines) {
    if (line.trim() === '') { prevWasHead = false; continue; }
    if (/^#{3,6}\s\S/.test(line)) { prevWasHead = false; continue; }        // 小標
    if (allowProse && !line.trimStart().startsWith('|') && !line.includes('](')) { prevWasHead = false; continue; }
    if (line === tableHead) { prevWasHead = true; continue; }
    if (line === TABLE_SEP) {
      assert.ok(prevWasHead, `${MAP}（${where}）出現分隔列「${TABLE_SEP}」，但上一行不是表頭。`);
      prevWasHead = false; continue;
    }
    const m = rowRe.exec(line);
    assert.ok(m, `${MAP}（${where}）出現不合文法的一行：\n    ${line}\n`
      + '⚠️ 這個區塊只放行：空行、`###` 小標、指定表頭＋緊接的 `|---|---|`、唯一合法的資料列，\n'
      + '   以及（僅限有宣告 allowProse 的區塊）不含 markdown 連結的說明文字。\n'
      + '   註解、少一個 `|`、`| | |`、多欄、換寫法……一律不准——**列舉繞法補不完，所以這裡關門**。\n'
      + '   真的要新增寫法，請先改 test/collab-map.test.js 的文法，那是刻意的摩擦。');
    prevWasHead = false;
    rows.push(m);
  }
  return rows;
}

/** @returns {{question: string, file: string, anchor: string}[]} */
function routes() {
  const lines = read(MAP).split('\n');
  return strictRows(sectionLines(lines, ROUTE_HEADING), ROUTE_TABLE_HEAD, ROUTE_ROW, '我想查⋯⋯')
    .map((m) => {
      assert.equal(m[2], m[3],
        `${MAP} 的路由列「${m[1]}」顯示名是「${m[2]}」、實際連到「${m[3]}」——讀者看到的檔名在說謊。`);
      return { question: m[1], file: m[3], anchor: m[4] };
    });
}

/**
 * 節名有沒有落在「結構位置」上——標題、**行首**粗體標籤、或整行就是 `節名：`。
 *
 * ⚠️ **射程只到「整份檔案某處有這樣一行」**（`Codex #545 r4`）：它不檢查那一行在哪一章、
 *    還隸不隸屬原本的父節。實測——把 `AGENTS.md` 真標題改名、再把 `**三方協作框架**`
 *    搬到毫不相關的「投資領域語意」底下，本檔仍全綠。這是**另一類**盲點（位置關係），
 *    不是再一種 markdown 寫法，所以單獨記在這裡。
 *
 * ⚠️ `r1` 用整檔 `includes`：真標題改名、別處還留著同一串字就照樣綠。
 * ⚠️ `r2` 的行首標籤子句沒有限定形狀：把 `### 三方協作框架…` 降成普通的 `三方協作框架…` 行，
 *    `startsWith(anchor)` 仍放行。⇒ 該子句改為要求**整行剛好是 `節名：`**——
 *    限定形狀是為了讓「降級成普通內文行」過不了。收這一種是因為 `REVIEW-AND-MERGE.md`
 *    有 `你的角色（唯讀審查者）：` 這種沒有標題的行首標籤；不宣稱全 repo 沒有別的形狀。
 *
 * @param {string} fileText @param {string} anchor
 */
function anchorIsStructural(fileText, anchor) {
  for (const raw of fileText.split('\n')) {
    if (/^#{1,6}\s/.test(raw) && raw.includes(anchor)) return true;
    const line = raw.replace(/^[\s>]*/, '').replace(/^(?:[-*+]|\d+\.)\s+/, '');
    const bold = /^\*\*(.+?)\*\*/.exec(line);
    if (bold && bold[1].includes(anchor)) return true;
    if (line === `${anchor}：`) return true;
  }
  return false;
}

/**
 * `scripts/` **遞迴**底下的所有 JS 檔（相對 ROOT 的路徑）。
 * ⚠️ 副檔名要含 `.mjs`／`.cjs`：只收 `.js` 的話，一支標準 ESM 的 `verify-extra-gate.mjs`
 *    自報 `MERGE_GATE` 也不會被看到（`Codex #545 r5` 實證）。
 */
function scriptFiles(/** @type {string} */ dir = 'scripts') {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...scriptFiles(p));
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}


// ───────────────────────── 解析器自己的對照斷言（防上面每一題空掃而綠）─────────────────────────

test('⭐ 白名單文法自己要先會動：合法的收、每一種繞法都要丟例外', () => {
  const ok = ['', '### 誰能做什麼', ROUTE_TABLE_HEAD, TABLE_SEP,
    '| 誰是誰 | [AGENTS.md](AGENTS.md)「三方協作框架」 |'];
  assert.equal(strictRows(ok, ROUTE_TABLE_HEAD, ROUTE_ROW, 'fixture').length, 1, '合法區塊應該剛好抽到一列。');

  const bad = {
    '註解藏列': '<!-- | 誰是誰 | [AGENTS.md](AGENTS.md)「三方協作框架」 | -->',
    '少了行首豎線': '誰是誰 | [AGENTS.md](AGENTS.md)「三方協作框架」 |',
    '假分隔列': '| | |',
    '節名脫勾': '| 誰是誰 | [AGENTS.md](AGENTS.md) 的「三方協作框架」 |',
    '沒有節名': '| 誰是誰 | [AGENTS.md](AGENTS.md) |',
    '不是連結': '| 誰是誰 | AGENTS.md「三方協作框架」 |',
  };
  for (const [name, line] of Object.entries(bad)) {
    assert.throws(() => strictRows([ROUTE_TABLE_HEAD, TABLE_SEP, line], ROUTE_TABLE_HEAD, ROUTE_ROW, 'fixture'),
      `「${name}」竟然沒被文法擋下來——這正是 r1／r2 那一族假綠的入口。`);
  }
  assert.throws(() => strictRows([TABLE_SEP], ROUTE_TABLE_HEAD, ROUTE_ROW, 'fixture'),
    '沒有表頭的分隔列應該紅（否則 `| | |` 那一發又通了）。');

  // 閘區塊容許說明文字，但**帶連結的行仍受文法管**（否則「拿掉行首 |」那一發又通了）
  assert.equal(strictRows(['這一段是說明文字，沒有連結。'], GATE_TABLE_HEAD, GATE_ROW, 'fixture', true).length, 0,
    '純說明文字在容許散文的區塊裡應該放行。');
  assert.throws(() => strictRows(['協作欄位 | [scripts/x.js](scripts/x.js) |'], GATE_TABLE_HEAD, GATE_ROW, 'fixture', true),
    '少了行首豎線、但含有連結的行，即使在容許散文的區塊也要紅。');
});

test('⭐ 切節自己要先會動：完整比對、抓不到或重複都要紅', () => {
  const lines = ['## 我想查⋯⋯', '內容 A', '## 下一節', '內容 B'];
  assert.deepEqual(sectionLines(lines, '## 我想查⋯⋯'), ['內容 A'], '應該只取到本節內容。');
  assert.throws(() => sectionLines(['## 我想查⋯⋯（誘餌）'], '## 我想查⋯⋯'),
    '「含有關鍵字」不該算命中——誘餌標題會把檢查引去別區。');
  assert.throws(() => sectionLines(['## 我想查⋯⋯', '## 我想查⋯⋯'], '## 我想查⋯⋯'), '重複的標題要紅。');
});

test('⭐ 錨點判準自己要先會動：認標題與行首粗體，不認句中提及、不認降級的普通行', () => {
  assert.ok(anchorIsStructural('### 三方協作框架（2026-07-24）', '三方協作框架'), '標題應該算數。');
  assert.ok(anchorIsStructural('- **Grok 的邊界（拍板）**——內文', 'Grok 的邊界'), '行首粗體標籤應該算數。');
  assert.ok(anchorIsStructural('你的角色（唯讀審查者）：', '你的角色（唯讀審查者）'), '整行就是「節名：」應該算數。');
  assert.ok(!anchorIsStructural('三方協作框架（William 2026-07-24 裁決定稿）', '三方協作框架'),
    '把標題降成普通內文行**不該**算數——那是 r2 抓到的假綠路。');
  assert.ok(!anchorIsStructural('已由**三方協作框架 v4**（本檔上方）取代', '三方協作框架'), '句中的粗體提及不該算數。');
  assert.ok(!anchorIsStructural('前面提到三方協作框架那一節', '三方協作框架'), '純句中提及不該算數。');
});

// ───────────────────────────────────── 地圖本體 ─────────────────────────────────────

test('⭐ 地圖裡不准有 HTML 註解（看不見的內容不該影響任何檢查）', () => {
  assert.ok(!read(MAP).includes('<!--'),
    `${MAP} 出現 HTML 註解。註解在頁面上看不見，卻能藏掉一整列路由——一律不准。`);
});

test('⭐ 地圖每一列指到的檔案都還在', () => {
  const found = routes();
  assert.ok(found.length > 0, `${MAP} 的「${ROUTE_HEADING}」一列路由都抽不到——不是表空了，就是文法被改到抽不出來。`);
  for (const { file, question } of found) {
    assert.ok(existsSync(join(ROOT, file)), `${MAP} 的「${question}」指到「${file}」，但這個檔案不在了。`);
  }
});

test('⭐ 地圖每一列引的節名，都還落在該檔的標題／行首粗體標籤／整行「節名：」上', () => {
  for (const { file, anchor, question } of routes()) {
    assert.ok(anchorIsStructural(read(file), anchor),
      `${MAP} 的「${question}」叫人去讀「${file}」的「${anchor}」，\n`
      + '但那個字串在該檔已經不是標題、也不是行首標籤了（可能被改名、整併，或降級成普通內文）。\n'
      + '⚠️ 請把地圖改到新的節名，不要放寬判準——放寬之後「導不到任何地方」也會算綠。');
  }
});

test('⭐ 三份正本都要在地圖的射程裡（否則它導的是別的東西）', () => {
  const files = new Set(routes().map((r) => r.file));
  for (const doc of CANON) {
    assert.ok(files.has(doc), `${MAP} 完全沒有導向「${doc}」。三份正本少一份，讀者就會以為那一層的規矩不存在。`);
  }
});

// ───────────────────────────────── 閘的對帳 ─────────────────────────────────

/**
 * 這張表要對帳的是**合併步驟裡實際會跑的閘**，不是「有沒有自報」。
 *
 * ⚠️ 為什麼不是自報（`Codex #545 r6`）：自報只代表那支腳本**宣稱**自己是閘。
 * 他做了兩發突變——`scripts/check-ghost-gate.mjs` 與 `scripts/gates/check-ghost-gate.js`，
 * 都只自報、**沒有接進 `REVIEW-AND-MERGE.md` 的合併步驟**，各補一列地圖之後全綠。
 * 那就是這一節最想避免的東西：地圖上掛著一道**永遠不會跑**的閘。
 * ⇒ 判準改成跟合併程序同一個集合：`gatesRunInMergeSteps()`（正本在 test/helpers/merge-gates.js，
 * 與 `test/collab-invariant-docs.test.js` **共用同一份**——各寫一份就是兩份會漂的複本）。
 *
 * @returns {Promise<{file: string, name: string}[]>}
 */
async function gatesToList() {
  const gates = [];
  for (const f of gatesRunInMergeSteps()) {
    const mod = await import(pathToFileURL(join(ROOT, f)).href);
    assert.ok(mod.MERGE_GATE,
      `${f} 寫進了合併步驟卻沒有自報 MERGE_GATE——名字無從對帳。（盤點的正本＝test/collab-invariant-docs.test.js）`);
    gates.push({ file: f, name: String(mod.MERGE_GATE.name) });
  }
  return gates;
}

test('⭐ 「合併步驟專用的閘」那張表＝合併步驟裡實際會跑的那幾支，逐一對帳（名字也要對）', async () => {
  const gates = await gatesToList();
  assert.ok(gates.length > 0,
    '合併步驟裡一支閘都抽不到——不是閘沒了，就是那個反查壞了（壞了的話這題就是空包彈）。');
  const rows = strictRows(sectionLines(read(MAP).split('\n'), GATE_HEADING),
    GATE_TABLE_HEAD, GATE_ROW, '合併步驟專用的閘', true);
  /** @type {Map<string, string>} 腳本路徑 → 地圖左欄寫的閘名 */
  const listed = new Map();
  for (const m of rows) {
    assert.equal(m[2], m[3], `${MAP} 的閘列「${m[1]}」顯示名與實際路徑不符（「${m[2]}」vs「${m[3]}」）。`);
    // ⚠️ 先拒絕重複路徑，`set` 才是「逐一對帳」（`Codex #545 r5`）：
    //    原本直接 set，於是「錯名的那一列＋後面正確的那一列」會被後者覆寫、整題照樣綠。
    //    這是**列的基數**盲點，不是另一種 markdown 寫法。
    assert.ok(!listed.has(m[3]),
      `${MAP} 的閘表格把「${m[3]}」列了不只一次。一支腳本只能有一列——`
      + '重複的話，後面那一列會蓋掉前面那一列，錯的名字就檢查不出來。');
    listed.set(m[3], m[1]);
  }
  for (const { file, name } of gates) {
    assert.ok(listed.has(file),
      `${MAP} 的閘表格漏了「${file}」，但合併步驟裡實際會跑它。\n`
      + '⚠️ 讀者會照那張表推論「表上沒有＝沒有機器在管」——漏一道就是給錯的安全感。');
    assert.equal(listed.get(file), name,
      `${MAP} 把「${file}」的閘名寫成「${listed.get(file)}」，自報的名字卻是「${name}」。左欄要照抄自報的名字。`);
  }
  for (const [file] of listed) {
    assert.ok(gates.some((g) => g.file === file),
      `${MAP} 的閘表格列了「${file}」，但合併步驟裡根本不會跑它（幽靈閘）。表上多一道＝同樣是假的安全感。`);
  }
});

test('⭐ scripts/ 底下每一支提到 MERGE_GATE 的 js/mjs/cjs，都要真的出現在合併步驟裡（幽靈閘兜底）', () => {
  const running = new Set(gatesRunInMergeSteps());
  for (const f of scriptFiles()) {
    if (!read(f).includes('MERGE_GATE')) continue;
    assert.ok(running.has(f),
      `${f} 提到 MERGE_GATE，但它**不在合併步驟實際會跑的那一組**裡。\n`
      + '⚠️ 這就是幽靈閘：自報自己是閘、卻永遠不會被執行。留著它，地圖與盤點都會給錯的安全感。\n'
      + '   要嘛把它寫進 REVIEW-AND-MERGE.md 合併步驟的標準指令行（`node scripts/<名>.js <N>`，\n'
      + '   限第一層、限 .js——那是 gatesRunInMergeSteps() 刻意的窄射程），要嘛不要自報 MERGE_GATE。\n'
      + '⚠️ 這裡刻意寬到「提到就算」：`export const`／`export { }`／子目錄／.mjs／.cjs 拼法列舉不完，\n'
      + '   所以認名字不認寫法。');
  }
});

// ───────────────────────────────── 接線與自報 ─────────────────────────────────

/**
 * 三份正本各自那**一行**指路的**指定形狀**（三份長同一個樣子，人才找得到、才好比對）。
 */
const POINTER_LINE = /^(?:> )?\*\*規矩住在哪＝\[COLLAB-MAP\.md\]\(COLLAB-MAP\.md\)\*\*（.+）。$/;

/** 指路那一行必須自己講明的幾件事（少一個，讀者就可能把路由表當權威索引）。 */
const POINTER_WORDS = ['只指路', '不是正本', '無規則效力'];

/** 只給那一行用的目的地——用它把渲染出來的 `<a>` **綁回那一行**。 */
const SENTINEL = 'COLLAB-MAP-POINTER-SENTINEL';

/**
 * **那一行指路本身**，在整份文件的脈絡裡，有沒有**渲染出**一個指向地圖的 `<a>`。
 *
 * 做法：把**那一行**的目的地換成 sentinel，整份丟給 `marked` 渲染，
 * 再看輸出裡有沒有 `href="<sentinel>"`。
 *
 * ⚠️ 為什麼問**輸出**、不問 token 樹（`Codex #548 r8`）：token 存在不等於會渲染成連結。
 * 把指路行包成圖片的 alt 文字（`![⋯指路行⋯](cover.png)`），image token 底下確實有 link token，
 * 但 alt 只會變成純文字，輸出裡沒有任何 `<a>`。走 token 樹會**走過頭**，補欄位也補不完
 * （漏走＝誤擋、走過頭＝假綠，兩邊都踩過）。⇒ 不走了，直接問渲染結果。
 *
 * ⚠️ 為什麼問輸出仍然安全（這是 `Codex #548 r6` 當初的疑慮）：`marked` 不 sanitize，
 * 註解裡的 raw HTML 會原樣留著——但那些誘餌的 href 是 `COLLAB-MAP.md`，**不是 sentinel**。
 * sentinel 只可能由**被替換的那一行**產生，所以歸屬是定義上的。
 *
 * ⚠️ 前提是 sentinel **真的不碰撞**（`Codex #548 r8`②）：原文件若自己就含有那個字串
 * （例如有人先放一個 `[誘餌](COLLAB-MAP-POINTER-SENTINEL)`），歸屬證明就失效 ⇒ 這裡 fail-closed。
 *
 * @param {string[]} lines 整份文件的每一行
 * @param {number} at 指路行的索引
 */
function pointerRendersAsLink(lines, at) {
  const doc = lines.join('\n');
  assert.ok(!doc.includes(SENTINEL),
    `這份文件本身就含有 sentinel「${SENTINEL}」，無法證明渲染出來的連結來自指路行。這裡 fail-closed。`);
  const patched = lines.slice();
  patched[at] = patched[at].replace(`](${MAP})`, `](${SENTINEL})`);
  // ⚠️ 先確認真的改到——改不到的話下面必然回 false，會變成「永遠誤擋」的空包彈。
  assert.notEqual(patched[at], lines[at], '指路行沒有可替換的連結目的地，sentinel 綁定失效。');
  return String(marked.parse(patched.join('\n'), { async: false })).includes(`href="${SENTINEL}"`);
}

test('⭐ 渲染判準自己要先會動：藏起來的不算、真的看得到的不可以誤擋', () => {
  const good = '**規矩住在哪＝[COLLAB-MAP.md](COLLAB-MAP.md)**（路由表：它**只指路、不是正本、無規則效力**）。';
  assert.ok(POINTER_LINE.test(good) && POINTER_LINE.test(`> ${good}`), 'fixture 的指路行形狀就不對。');
  assert.ok(POINTER_WORDS.every((w) => good.includes(w)), 'fixture 自己就少了免責詞。');

  /** @param {string} md */
  const check = (md) => {
    const L = md.split('\n');
    const i = L.findIndex((l) => l.includes(`](${MAP})`));
    return i >= 0 && pointerRendersAsLink(L, i);   // 連可綁的連結都沒有＝本來就不算數
  };

  assert.ok(check(good), '正常的指路行應該算數。');
  assert.ok(check(`> ${good}`), '寫在引言裡應該算數。');
  // ⚠️ 表格 header 那發是**誤擋**方向（`Codex #548 r7`①）：漏走 header 會把真的可點連結判成沒有。
  assert.ok(check(`${good}\n| --- |`), '表格 header 裡的連結是真的可點，不可以誤擋。');

  const hidden = {
    '單行 HTML 註解': `<!-- ${good} -->`,
    '註解裡另塞 raw <a> 誘餌': `<!--\n${good.replace('）。', ' <a href="COLLAB-MAP.md">誘餌</a>）。')}\n-->\n\n## H`,
    '未閉合註解＋後面另放真連結': `<!--\n${good.replace('）。', '　-->）。')}\n\n另外參考 [COLLAB-MAP.md](COLLAB-MAP.md)。`,
    'code span 包住＋旁邊放誘餌': `\`\n${good}\n\` [誘餌](COLLAB-MAP.md)\n\n## H`,
    '三反引號圍欄': `\`\`\`\n${good}\n\`\`\``,
    '四反引號外框包三反引號': `\`\`\`\`markdown\n\`\`\`\n${good}\n\`\`\`\n\`\`\`\``,
    '波浪號圍欄': `~~~\n${good}\n~~~`,
    '四個空白縮排': `    ${good}`,
    '引言裡的圍欄': `> \`\`\`bash\n> ${good}\n> \`\`\``,
    '註解夾在連結中間': '**規矩住在哪＝[COLLAB-MAP.md]<!-- x -->(COLLAB-MAP.md)**（路由表）。',
    '包成圖片的 alt 文字（token 在、<a> 不在）': `![替代文字\n${good}\n](cover.png)\n\n## H`,
  };
  for (const [name, md] of Object.entries(hidden)) {
    assert.ok(!check(md), `「${name}」不該算成「指路行有變成連結」。`);
  }

  // sentinel 碰撞＝歸屬證明失效 ⇒ 必須 fail-closed（丟例外），不可以靜靜回 true
  assert.throws(() => check(`[誘餌](${SENTINEL})\n\n${good}`),
    '原文件已含 sentinel 時要 fail-closed，不可以讓別處的誘餌頂替。');
});

test('⭐ 地圖自己要找得到：三份正本各要有一行指定形狀的指路，而且它自己渲染成一個真的連結', () => {
  // ⚠️ 這裡刻意**沿用 CANON**、不另外手寫一份名單：手寫的第二份名單自己會漂
  //    （同 `test/collab-invariant-docs.test.js` 的 `Codex #385 r9` 教訓）。
  //    ⚠️ 誠實劃界（`Grok #548 掃`②）：`CANON` 同時當「地圖要導到這三份」與「這三份要指回地圖」
  //    的開關——**一個開關關掉兩張網**。有人把某一份從 CANON 拿掉，兩題會一起失去那份的覆蓋而照樣全綠。
  //
  // ⚠️ **為什麼用真的 markdown 渲染器**（William 2026-09-03 裁定）：前幾輪用字串比對想證明
  //    「讀者看得到一個可點的連結」，補了三輪都還有洞——註解、`~~~`、四反引號外框、縮排、
  //    引言裡的圍欄、把註解夾進連結中間。那是「列舉繞法補不完」的形狀。
  //    渲染器直接回答原本要問的問題：**渲染出來到底有沒有那個 `<a>`**。
  //
  // ⚠️ **這一題保證到哪裡**（`Codex #548 r7`③ 要求收窄）：那一行**形狀對**、**在第一個字面 `## ` 之前**、
  //    而且**它自己**渲染成一個 link token。**它不保證「讀者一開檔就看得到」**——
  //    把指路行放進預設收合的 `<details>`（仍在前言），上面每一條都成立，讀者卻要先展開才看得到。
  //    實測確認擋不到。要守到那種程度就得再去追「哪些容器會遮住前言」，那是另一場列舉；
  //    這裡選擇**把宣稱縮到實況**，不追。
  //
  // ⚠️ 仍然驗不到的：那句話的**意思**。把括號內容改成「這幾個詞都是錯的、地圖才是正本」，
  //    形狀、連結、三個詞都還在 ⇒ 照樣綠（`Codex #548 r3` 實證）。語意要靠人讀。
  for (const from of CANON) {
    const lines = read(from).split('\n');
    const hits = lines.filter((l) => POINTER_LINE.test(l)).length;
    assert.equal(hits, 1,
      `「${from}」的指路行有 ${hits} 行，必須剛好一行。\n`
      + '⚠️ 沒有人指路的地圖等於不存在。三份正本各自是不同讀者的入口\n'
      + '   （CLAUDE.md＝Claude 每個 session 自動載入、AGENTS.md＝Codex、REVIEW-AND-MERGE.md＝正在審查或合併的人）。');

    const at = lines.findIndex((l) => POINTER_LINE.test(l));

    // 指路要在**前言**（第一個字面 `## ` 標題之前）——這是**位置**，不是可見性。
    // ⚠️ 這一條**不是**渲染問題——搬到檔尾照樣渲染成可點的連結，是**找不找得到**的問題。
    //    `^## ` 的判斷精確、不是近似，所以留著。找不到任何 `## ` 就 fail-closed：
    //    邊界無從界定時不可以退成「整份都算前言」（那等於這一格沒在檢查）。
    const firstH2 = lines.findIndex((l) => /^## /.test(l));
    assert.ok(firstH2 > 0, `「${from}」找不到任何 \`## \` 標題，「前言」的邊界無從界定。這裡 fail-closed。`);
    assert.ok(at < firstH2,
      `「${from}」的指路行在第一個 \`## \` 標題之後（第 ${at + 1} 行）。指路要放在**前言**。`);

    for (const word of POINTER_WORDS) {
      assert.ok(lines[at].includes(word),
        `「${from}」的指路行沒有寫明「${word}」。\n`
        + '⚠️ 讀者若把路由表當權威索引，就會拿一份刻意不完整的摘要去代替正本。\n'
        + '⚠️ 誠實劃界：這只鎖那幾個詞出現在同一行，**鎖不住整句話的意思**。');
    }

    assert.ok(pointerRendersAsLink(lines, at),
      `「${from}」的指路行沒有渲染成一個真的連結。\n`
      + '⚠️ 字面寫著檔名不算數——被註解吞掉、包在圍欄裡、四個空白縮排，讀者都點不到。\n'
      + '⚠️ 檔案別處另有一個地圖連結也不算：判準是把**這一行**的目的地換成唯一 sentinel 再找它。');
  }
});

test('地圖要自報「不完整」與「站外那條驗不到」（不要讓讀者以為表上沒有＝不存在）', () => {
  const text = read(MAP);
  assert.ok(/表上沒有 ≠ 規矩不存在/.test(text),
    `${MAP} 沒有明寫它不完整。讀者會把「表上沒有」推成「沒這條規定」——那是路由表最貴的失敗形態。`);
  assert.ok(text.includes('../teaching-videos/AGENTS.md'),
    `${MAP} 少了 ../teaching-videos/AGENTS.md 這個站外地址——本題要保留的就是這一條已知的站外正本。`);
  assert.ok(/驗不到它/.test(text),
    `${MAP} 提到站外正本，卻沒說明本檔的考題驗不到它。誇大的保證比缺口更糟。`);
});
