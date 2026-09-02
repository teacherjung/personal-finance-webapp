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
//
//   會紅（＝看得到）：在路由列**尾端**多一欄、在**路由區塊**裡放 fence（含 fence 內的假標題）。
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
// - 閘的對帳與兜底**只認 `MERGE_GATE` 這個名字**：改用別的 export 名開一道閘，這裡看不到。
// - **驗不到** Markdown 的容器與表格結構（見上一節逐條列的那幾發）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
 * 白名單文法：逐行掃區塊，只准四種行，其餘一律丟例外。
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
      + '⚠️ 這個區塊只准四種行：空行、`###` 小標、指定表頭＋緊接的 `|---|---|`、以及唯一合法的資料列。\n'
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
 * ⚠️ `r1` 用整檔 `includes`：真標題改名、別處還留著同一串字就照樣綠。
 * ⚠️ `r2` 的行首標籤子句沒有限定形狀：把 `### 三方協作框架…` 降成普通的 `三方協作框架…` 行，
 *    `startsWith(anchor)` 仍放行。⇒ 現在那一句要求**整行剛好是 `節名：`**——
 *    限定形狀是為了讓「降級成普通內文行」過不了；本檔目前只有一個錨點靠這一句
 *    （`REVIEW-AND-MERGE.md` 的 `你的角色（唯讀審查者）：`），不宣稱全 repo 沒有別的形狀。
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

/** `scripts/` **遞迴**底下的所有 .js（相對 ROOT 的路徑）。 */
function scriptFiles(/** @type {string} */ dir = 'scripts') {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...scriptFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const isCheckScript = (/** @type {string} */ p) => /(^|\/)check-[^/]*\.js$/.test(p);

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

test('⭐ 地圖每一列引的節名，都還落在該檔的標題或行首粗體標籤上', () => {
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
 * 合併前真的會擋人的閘＝**腳本自報**（`export const MERGE_GATE`），不是誰手寫的名單。
 * ⚠️ 抄 `test/collab-invariant-docs.test.js` 的教訓（`Codex #385 r9`）：手寫名單自己會漂。
 * @returns {Promise<{file: string, name: string}[]>}
 */
async function selfDeclaredGates() {
  const gates = [];
  for (const f of scriptFiles().filter(isCheckScript)) {
    const mod = await import(pathToFileURL(join(ROOT, f)).href);
    if (mod.MERGE_GATE) gates.push({ file: f, name: String(mod.MERGE_GATE.name) });
  }
  return gates;
}

test('⭐ 「合併步驟專用的閘」那張表要跟腳本自報的 MERGE_GATE 逐一對帳（名字也要對）', async () => {
  const gates = await selfDeclaredGates();
  assert.ok(gates.length > 0,
    '一支自報 MERGE_GATE 的閘都找不到——不是閘沒了，就是這個列舉壞了（壞了的話這題就是空包彈）。');
  const rows = strictRows(sectionLines(read(MAP).split('\n'), GATE_HEADING),
    GATE_TABLE_HEAD, GATE_ROW, '合併步驟專用的閘', true);
  /** @type {Map<string, string>} 腳本路徑 → 地圖左欄寫的閘名 */
  const listed = new Map();
  for (const m of rows) {
    assert.equal(m[2], m[3], `${MAP} 的閘列「${m[1]}」顯示名與實際路徑不符（「${m[2]}」vs「${m[3]}」）。`);
    listed.set(m[3], m[1]);
  }
  for (const { file, name } of gates) {
    assert.ok(listed.has(file),
      `${MAP} 的閘表格漏了「${file}」，但它自報是合併閘。\n`
      + '⚠️ 讀者會照那張表推論「表上沒有＝沒有機器在管」——漏一道就是給錯的安全感。');
    assert.equal(listed.get(file), name,
      `${MAP} 把「${file}」的閘名寫成「${listed.get(file)}」，自報的名字卻是「${name}」。左欄要照抄自報的名字。`);
  }
  for (const [file] of listed) {
    assert.ok(gates.some((g) => g.file === file),
      `${MAP} 的閘表格列了「${file}」，但它並沒有自報 MERGE_GATE。表上多一道＝同樣是假的安全感。`);
  }
});

test('⭐ scripts/ 遞迴底下非 check-*.js 的檔案不准提到 MERGE_GATE（對帳只認 check-*，這條兜底）', () => {
  for (const f of scriptFiles().filter((p) => !isCheckScript(p))) {
    assert.ok(!read(f).includes('MERGE_GATE'),
      `${f} 提到 MERGE_GATE，但對帳只掃 check-*.js ⇒ 它不會被對帳到。\n`
      + '⚠️ 這裡刻意寬到「提到就紅」：`export const MERGE_GATE`、`export { MERGE_GATE }`、\n'
      + '   放進子目錄……拼法列舉不完，所以認名字不認寫法。\n'
      + '   要嘛把它改名成 check-*，要嘛放寬對帳範圍——不要留一道「表上看不到、也沒人對帳」的閘。');
  }
});

// ───────────────────────────────── 接線與自報 ─────────────────────────────────

test('⭐ 地圖自己要找得到：CLAUDE.md 與 AGENTS.md 都要指得回它', () => {
  for (const from of ['CLAUDE.md', 'AGENTS.md']) {
    assert.ok(read(from).includes(MAP),
      `「${from}」沒有提到 ${MAP}。\n`
      + '⚠️ 沒有人指路的地圖等於不存在——CLAUDE.md 是 Claude 每個 session 唯一保證讀到的入口，\n'
      + '   AGENTS.md 是 Codex 的入口，兩邊都要指得回來。');
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
