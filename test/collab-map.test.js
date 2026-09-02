// @ts-check
// **協作規矩地圖的地址要是真的**（`COLLAB-MAP.md`）。
//
// ## 這支守什麼
//
// 那份地圖只做一件事：把「我想查 X」導到「哪一份的哪一節」。
// 導錯的地圖比沒有地圖更糟——照著走的人會以為自己讀過了，實際上讀到的是別的東西，
// 或根本沒到（節被改名／檔案被搬走，地圖不會自己知道）。所以這支驗：
//   - 「我想查⋯⋯」的每一列都寫成 `[檔名](路徑)「節名」`，**格式不合就紅**（不是靜靜跳過）
//   - 指到的檔案還在
//   - 引的節名**落在該檔的標題或行首粗體標籤上**——不是隨便一句話裡提到而已
//   - 「合併步驟專用的閘」那張表跟腳本自報的 `MERGE_GATE` 對帳（含名字）
//   - `scripts/` 底下非 `check-` 開頭的檔案不准自報 `MERGE_GATE`（對帳只掃 `check-*`，這條兜底）
//   - 地圖自己找得到（`CLAUDE.md`／`AGENTS.md` 都要指得回它）
//
// ## 誠實劃界（不要把這支當成「地圖是對的」的保證）
//
// 它驗的是**地址**，不是**內容**：
// - **驗不到**「那一節是不是還在講那件事」——節名沒動、整段改寫成別的規則，這支照樣綠。
// - **驗不到**地圖有沒有偷偷把規則判準抄進去（那正是它存在要防的病，但機器讀不出
//   「這句是規則還是指路」）。`Codex #545 r1` 就是靠人讀出來的：第一版把聯集閘與堆疊閘的
//   判準抄成了說明文字。這條紀律**只有人在守**。
// - **驗不到**地圖收得夠不夠全——它本來就宣告自己是選錄。
// - **驗不到**站外那一條（`../teaching-videos/AGENTS.md`）：別的 repo、不保證在這台機器上。
//   地圖裡那一條刻意寫成非連結，本檔一併驗它有標明「驗不到」，免得讀者以為它在網子裡。
// - 「選錄，不對帳」那張表**刻意不驗**：它列的不是閘，沒有可對帳的自報來源。
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

/**
 * 取出 `## <標題>` 到下一個 `## ` 之間的內容（含子標題）。
 *
 * ⚠️ 抓不到就丟例外，不回空字串：**回空字串會讓呼叫端安安靜靜什麼都不驗**
 * （這正是 r1 被抓到的那一族假綠）。
 *
 * @param {string} text @param {string} heading
 */
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(heading));
  assert.ok(start >= 0, `${MAP} 找不到「## ${heading}」這一節——不是節被改名，就是這個切法壞了。`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * 表格的**資料列**：每列回傳去頭尾空白的儲存格。
 *
 * ⚠️ 表頭靠**結構**認（`|---|` 分隔列的前一行就是表頭），不是比對表頭文字——
 * 手寫一份表頭名單，改個欄名它就會把表頭當資料列（又一份會漂的名單）。
 * @param {string} text @returns {string[][]}
 */
function tableRows(text) {
  const lines = text.split('\n');
  const isSep = (/** @type {string} */ l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  /** @type {string[][]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim().startsWith('|') || isSep(l)) continue;
    if (i + 1 < lines.length && isSep(lines[i + 1])) continue;   // 這一行是表頭
    const cells = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length >= 2) out.push(cells);
  }
  return out;
}

/** 路由列的**唯一**合法寫法。整格必須剛好等於它——多一個字都算格式不合。 */
const ROUTE_CELL = /^\[([^\]]+)\]\(([^)\s]+)\)「([^」]+)」$/;

/**
 * 「我想查⋯⋯」底下每一列的路由。**格式不合就丟例外**（fail-closed）：
 * r1 原本讓節名是選配的，於是 `[AGENTS.md](AGENTS.md) 的「不存在的節」`
 * 會靜靜退化成「只驗檔案存在」——看起來還在檢查，其實那一列從此沒人守。
 * @returns {{file: string, anchor: string, question: string}[]}
 */
function routes() {
  const rows = tableRows(section(read(MAP), '我想查'));
  return rows.map(([question, dest]) => {
    const m = ROUTE_CELL.exec(dest);
    assert.ok(m, `${MAP} 的路由列「${question}」目的地寫成「${dest}」，不是唯一合法格式 \`[檔名](路徑)「節名」\`。\n`
      + '⚠️ 這裡刻意 fail-closed：格式一鬆，寫壞的那一列就會靜靜退化成沒人檢查。');
    return { question, file: m[2], anchor: m[3] };
  });
}

/**
 * 節名有沒有落在「結構位置」上——標題、或**行首**的粗體標籤（`**節名⋯**`、`- **節名⋯**`）。
 *
 * ⚠️ 為什麼不能只用整檔 `includes`（`Codex #545 r1` 的第二發突變）：把真正的
 * `### 三方協作框架` 標題改名、而檔內別處還留著「三方協作框架」四個字，整檔比對照樣綠——
 * 那時地圖已經導不到任何地方了。
 * ⚠️ 為什麼不能只認標題：這個 repo 有大量規則是**行首粗體條列**而不是標題
 * （`**Grok 的邊界（…）**`、`**共享檔案預約（…）**`），硬要求標題會逼地圖改指到更粗的位置，
 * 對讀者更差。所以認「標題或行首粗體標籤」，**不認句中提及**。
 *
 * @param {string} fileText @param {string} anchor
 */
function anchorIsStructural(fileText, anchor) {
  for (const raw of fileText.split('\n')) {
    if (/^#{1,6}\s/.test(raw) && raw.includes(anchor)) return true;
    // 去掉引言符號、清單記號、縮排之後，看它是不是以粗體標籤開頭
    const line = raw.replace(/^[\s>]*/, '').replace(/^(?:[-*+]|\d+\.)\s+/, '');
    const bold = /^\*\*(.+?)\*\*/.exec(line);
    if (bold && bold[1].includes(anchor)) return true;
    if (line.startsWith(anchor)) return true;          // `你的角色（唯讀審查者）：` 這種行首標籤
  }
  return false;
}

test('⭐ 路由列的格式解析自己要先會動（防空掃而綠）', () => {
  assert.deepEqual(
    tableRows('| 問題 | 去哪讀 |\n|---|---|\n| 誰是誰 | [AGENTS.md](AGENTS.md)「三方協作框架」 |'),
    [['誰是誰', '[AGENTS.md](AGENTS.md)「三方協作框架」']], '表格列抽錯了。');
  const m = ROUTE_CELL.exec('[AGENTS.md](AGENTS.md)「三方協作框架」');
  assert.ok(m && m[2] === 'AGENTS.md' && m[3] === '三方協作框架', '合法路由格式竟然比對不到。');
  for (const bad of ['[AGENTS.md](AGENTS.md) 的「三方協作框架」', '[AGENTS.md](AGENTS.md)', 'AGENTS.md「三方協作框架」']) {
    assert.equal(ROUTE_CELL.exec(bad), null, `「${bad}」不該被當成合法路由——這是 r1 那一族假綠的入口。`);
  }
});

test('⭐ 錨點判準自己要先會動：認標題與行首粗體，不認句中提及', () => {
  assert.ok(anchorIsStructural('### 三方協作框架（2026-07-24）', '三方協作框架'), '標題應該算數。');
  assert.ok(anchorIsStructural('- **Grok 的邊界（拍板）**——內文', 'Grok 的邊界'), '行首粗體標籤應該算數。');
  assert.ok(anchorIsStructural('你的角色（唯讀審查者）：', '你的角色（唯讀審查者）'), '行首標籤應該算數。');
  assert.ok(!anchorIsStructural('已由**三方協作框架 v4**（本檔上方）取代', '三方協作框架'),
    '句中的粗體提及**不該**算數——那正是「標題被改名卻照樣綠」的漏洞。');
  assert.ok(!anchorIsStructural('前面提到三方協作框架那一節', '三方協作框架'), '純句中提及不該算數。');
});

test('⭐ 地圖每一列指到的檔案都還在', () => {
  const found = routes();
  assert.ok(found.length > 0, `${MAP} 的「我想查⋯⋯」一列路由都抽不到——不是表空了，就是格式被改到抽不出來。`);
  for (const { file, question } of found) {
    assert.ok(existsSync(join(ROOT, file)),
      `${MAP} 的「${question}」指到「${file}」，但這個檔案不在了。`);
  }
});

test('⭐ 地圖每一列引的節名，都還落在該檔的標題或行首粗體標籤上', () => {
  for (const { file, anchor, question } of routes()) {
    assert.ok(anchorIsStructural(read(file), anchor),
      `${MAP} 的「${question}」叫人去讀「${file}」的「${anchor}」，\n`
      + '但那個字串在該檔已經不是標題、也不是行首粗體標籤了（可能被改名、整併，或只剩句中提及）。\n'
      + '⚠️ 請把地圖改到新的節名，不要退回整檔比對——句中提及會讓「導不到任何地方」也算綠。\n'
      + '⚠️ 提醒：這一題只驗位置，**驗不到那一節是不是還在講同一件事**。');
  }
});

test('⭐ 三份正本都要在地圖的射程裡（否則它導的是別的東西）', () => {
  const files = new Set(routes().map((r) => r.file));
  for (const doc of CANON) {
    assert.ok(files.has(doc), `${MAP} 完全沒有導向「${doc}」。三份正本少一份，讀者就會以為那一層的規矩不存在。`);
  }
});

/**
 * 合併前真的會擋人的閘＝**腳本自報**（`export const MERGE_GATE`），不是誰手寫的名單。
 *
 * ⚠️ 抄 `test/collab-invariant-docs.test.js` 的教訓（`Codex #385 r9`）：那裡原本手寫閘名，
 * 加了新閘之後**考題把舊名單當契約、全綠也看不見**。
 * @returns {Promise<{file: string, name: string}[]>}
 */
async function selfDeclaredGates() {
  const files = readdirSync(join(ROOT, 'scripts')).filter((f) => f.startsWith('check-') && f.endsWith('.js'));
  const gates = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(ROOT, 'scripts', f)).href);
    if (mod.MERGE_GATE) gates.push({ file: `scripts/${f}`, name: String(mod.MERGE_GATE.name) });
  }
  return gates;
}

test('⭐ 「合併步驟專用的閘」那張表要跟腳本自報的 MERGE_GATE 逐一對帳（名字也要對）', async () => {
  const gates = await selfDeclaredGates();
  assert.ok(gates.length > 0,
    '一支自報 MERGE_GATE 的閘都找不到——不是閘沒了，就是這個列舉壞了（壞了的話這題就是空包彈）。');
  // ⚠️ 只在那張表格區塊裡對帳：r1 原本對整份文件做 includes，於是把某一列刪掉、
  //    只在文末註解留下腳本名，照樣算「已列入」。
  const rows = tableRows(section(read(MAP), '規矩的手腳').split('### 其他也會擋人的')[0]);
  /** @type {Map<string, string>} 腳本路徑 → 地圖左欄寫的閘名 */
  const listed = new Map();
  for (const [name, cell] of rows) {
    const m = /^\[[^\]]*\]\(([^)\s]+)\)$/.exec(cell);
    assert.ok(m, `${MAP} 的閘表格有一列目的地寫成「${cell}」，不是 \`[顯示名](腳本路徑)\`——格式一鬆就對不了帳。`);
    listed.set(m[1], name);
  }
  for (const { file, name } of gates) {
    assert.ok(listed.has(file),
      `${MAP} 的「合併步驟專用的閘」表格裡漏了「${file}」，但它自報是合併閘。\n`
      + '⚠️ 讀者會照那張表推論「表上沒有＝沒有機器在管」——漏一道就是給錯的安全感。');
    assert.equal(listed.get(file), name,
      `${MAP} 把「${file}」的閘名寫成「${listed.get(file)}」，但它自報的名字是「${name}」。\n`
      + '⚠️ 左欄要照抄自報的名字，不要另外取一個——另取的那個自己會漂。');
  }
  for (const [file] of listed) {
    assert.ok(gates.some((g) => g.file === file),
      `${MAP} 的閘表格列了「${file}」，但它並沒有自報 MERGE_GATE。表上多一道＝同樣是假的安全感。`);
  }
});

test('⭐ scripts/ 底下非 check- 開頭的檔案不准自報 MERGE_GATE（對帳只掃 check-*，這條兜底）', () => {
  const others = readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.js') && !f.startsWith('check-'));
  for (const f of others) {
    assert.ok(!/export\s+const\s+MERGE_GATE/.test(read(`scripts/${f}`)),
      `scripts/${f} 自報了 MERGE_GATE，但上面那題只掃 scripts/check-*.js ⇒ 它不會被對帳到。\n`
      + '⚠️ 要嘛把它改名成 check-*，要嘛放寬對帳範圍——不要留一道「表上看不到、也沒人對帳」的閘。');
  }
});

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
    `${MAP} 少了「住在別的 repo 的那一條」——那是唯一一條正本不在本 repo 的協作規矩。`);
  assert.ok(/驗不到它/.test(text),
    `${MAP} 提到站外正本，卻沒說明本檔的考題驗不到它。誇大的保證比缺口更糟。`);
});
