// @ts-check
// 領域契約拆分的護欄考題（2026-08-02，D4c／2c 收官；r3 依 Codex #384 r2 改成 manifest 精確比對）。
//
// ## 為什麼需要它
//
// `docs/contracts/` 的拆分做過三次，**一直沒有任何機械檢查**。
// 實測：拆分省下的篇幅兩天之內被吃回去大半——AGENTS.md 的「一行索引」會慢慢長胖，
// 長到跟原本的整條規則一樣長，拆分就等於沒發生（更糟：同一條規則變成兩份，會各自漂）。
//
// ## r1／r2 連兩輪被打穿，根因是同一個
//
// **我一直在「從文字推導清單」。** 推導永遠不完整，而且被推導的那份文字**自己可以改**：
//   r1：所有斷言「從索引出發」⇒ 讓某列不再是索引，它就從受測集合消失
//   r2：改成雙向，但「是不是一條規則」仍靠文字特徵（有沒有 `**記得同步這裡**：`）
//       ⇒ **marker 與索引一起刪掉，正反兩邊同時消失，四題全綠**（Codex 實測）
//       路由那題只認 `export function`，漏 `export const`／export list／API 路徑；
//       比對還用 basename 子字串，`lib/store-rules.js` 可以冒充 `lib/services/store-rules.js`
//
// ## r3：改成**宣告**，不再推導
//
// 下面的 `MANIFEST` 是**手寫的真相**：每份契約有哪些規則、哪些責任檔。判準全部改成**精確集合相等**：
//   ・契約檔裡的標題集合 **==** `rules ∪ exempt`（多一個少一個都紅——刪 marker 沒有用）
//   ・`rules` 與 AGENTS 索引列 **雙向一一對應**（拆掉索引＝紅；索引指到不存在的規則＝紅）
//   ・README 路由列的檔案集合 **==** `files`（精確路徑，不接受 basename 子字串）
//   ・契約內文提到的 repo 路徑 **⊆** `files`（新提到一個檔就強迫更新 manifest）
//
// 代價說清楚：manifest 是一份要手動維護的副本。但它的**每一種走樣都會紅**，
// 而且更新它是刻意的動作——這正是我們要的審批點。
// 相對地，「從文字推導」看起來不用維護，實際上是**永遠不知道自己漏了什麼**。
//
// ## 誠實劃界
//
// 擋得住「索引長回原文」「拆掉索引或 marker」「連結指不到」「路由表漏檔或冒充」。
// 擋不住：①索引摘要寫得爛 ②`files` 該不該包含某個檔（那是人的判斷，manifest 只保證它被明講）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 讀檔並**剝掉 HTML 註解**——註解裡的內容在畫面上根本不存在。
 *
 * ⚠️ Codex #384 r3 實測：把整段契約或整條路由列包進 `<!-- ... -->`，**六題全綠**。
 *    這與 `test/safety-docs-freshness.test.js` 今天收斂到的是同一條判準
 *    （我在那支修好了、卻沒有帶到這支來——同型錯誤要一次掃完所有現場）。
 *    剝完之後也不准有殘留的 `<!--`／`-->`：一個未閉合的註解會讓後面整片內容消失。
 * @param {string} p
 */
function read(p) {
  const raw = readFileSync(join(ROOT, p), 'utf8');
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!stripped.includes('<!--') && !stripped.includes('-->'),
    `${p} 有沒閉合（或巢狀走樣）的 HTML 註解——後面整片內容會在畫面上消失，而考題看不見。`);
  // ⚠️ 也剝掉 fenced code block（Codex #384 r4）：`\u0060\u0060\u0060` 裡的 `## 標題` 不是標題，
  //    把整段契約包進 code fence，畫面上 anchor 就消失了，而考題原本看不見。
  // ⚠️ CommonMark 的 fence 有**兩種**（Codex #384 r6）：``` 與 ~~~。
  //    只剝一種＝用另一種包起來就能讓標題與 anchor 在畫面上消失，而考題還看得到。
  const noFence = stripped.replace(/^```[\s\S]*?^```/gm, '').replace(/^~~~[\s\S]*?^~~~/gm, '');
  // ⚠️ 剝完**不准有殘留的 fence 記號**（Codex #384 r7）：忘記關 fence 是正常維護手滑，
  //    而 CommonMark 會把後面**整份文件**當成程式碼——標題與 anchor 全部消失，考題卻還看得到。
  //    同 HTML 註解那條，判準是「剝完要乾淨」，不是「剝得掉的就好」。
  assert.ok(!/^(?:```|~~~)/m.test(noFence),
    `${p} 有沒閉合的 code fence——後面整份內容在畫面上會變成程式碼區塊，標題與 anchor 全部消失。`);
  return noFence;
}

/** 索引行的硬上限。現行最長 474（SEC 官方指標挑值那條，規則本身就密）。 */
const MAX_INDEX_LEN = 600;
/** 摘要相對契約內文的上限比例（只在內文 ≥300 字元時生效）。 */
const MAX_SUMMARY_RATIO = 0.6;
const BODY_LABEL = '**記得同步這裡**：';

/**
 * **宣告的真相**（不是從文字推導的）。
 * - `rules`：每一條規則的標題原文。**每一條都必須有一列 AGENTS 索引指過來。**
 * - `exempt`：確定不是獨立規則的小節，必須逐一寫理由。
 * - `files`：這個領域的責任檔**窮舉**清單（README 路由列必須剛好是這一組）。
 */
const MANIFEST = {
  'docs/contracts/前端功能.md': {
    rules: [
      '月度回顧總覽卡',
      '訂閱續費日自動推進',
      '訂閱本月攤提',
      '訂閱狀態',
      'YYYY-MM-DD 日期解析',
      '每日洞察引擎書籤 insightState',
    ],
    exempt: [],
    files: [
      'lib/derive.js',
      'lib/repo.js',
      'lib/routes/core.js',
      'lib/routes/crud.js',
      'lib/routes/market.js',
      'lib/schema.js',
      'lib/services/insights.js',
      'lib/services/market-data.js',
      'lib/services/snapshot.js',
      'lib/services/subscriptions.js',
      'lib/store.js',
      'lib/types.js',
      'public/app.js',
      'public/modules/dashboard.js',
      'public/modules/monthly-review-card.js',
      'public/modules/subscriptions-model.js',
      'public/modules/subscriptions.js',
      'test/server.test.js',
      'test/subscriptions-model.test.js',
    ],
  },
  'docs/contracts/收支記帳與匯入.md': {
    rules: [
      'PDF 逐列抽取器',
      '信用卡負數交易的繳款與退款判斷',
      '月度回顧的消費口徑與退款配對',
      '信用卡費頁的兩種口徑',
      '銀行收支真學習的方向與內轉子分類',
      '同類同店一起改是單一原子指令',
      '停車費顯示包裝的觸發',
      '帳戶顯示名 denormalized 到交易',
      '支出分類兩層與使用者自訂',
      'CATEGORY_RULES 關鍵字順序',
      '帳單多銀行與多格式解析',
      '顯示標記 applyDisplayLabels',
      '使用者自訂店名規則 storeRules',
      '規則入櫃檯',
      '規則指紋 storeRulesHash',
      '店名規則的 API 與 UI',
      '帳單上傳免選卡自動歸卡',
      '帳單匯入批次與事後整批改卡片',
      '帳單自動學習店名與分類',
      '店家消費檔案',
    ],
    exempt: [],
    files: [
      'data/seed.json',
      'lib/bank-statement.js',
      'lib/derive.js',
      'lib/pdf-isolate.js',
      'lib/repo.js',
      'lib/routes/core.js',
      'lib/routes/crud.js',
      'lib/routes/statement.js',
      'lib/schema.js',
      'lib/services/bank-import.js',
      'lib/services/categories.js',
      'lib/services/health-check.js',
      'lib/services/learning.js',
      'lib/services/statement-import.js',
      'lib/services/store-rules.js',
      'lib/statement.js',
      'lib/store-rules.js',
      'lib/store.js',
      'lib/taishin-securities.js',
      'public/app.js',
      'public/modules/cashflow.js',
      'public/modules/categories.js',
      'public/modules/refund-attribution.js',
      'public/modules/settings-store-rules.js',
      'public/modules/settings.js',
      'public/modules/transactions-import.js',
      'public/modules/transactions.js',
      'test/refund-attribution.test.js',
      'test/refund-pairing-aggregate.test.js',
      'test/statement-pipeline.test.js',
      'test/store-rules.test.js',
    ],
  },
  'docs/contracts/投資與SEC.md': {
    rules: [
      'SEC 官方指標挑值',
      'SEC currentDebt 流動債務',
      '最新單季逐列期間',
      'SEC 全站佇列護欄',
      '重型工作名額（heavy admission）與 SEC 的關係',
      '新增 ETF 持股',
      'IB 槓桿與斷頭距離',
      '投資代號與原則上限',
      '估值訊號門檻檔位',
      'settings-signals',
    ],
    exempt: [],
    files: [
      'lib/derive.js',
      'lib/heavy-admission.js',
      'lib/http-body.js',
      'lib/pdf-isolate-child.js',
      'lib/routes/auth.js',
      'lib/routes/market.js',
      'lib/schema.js',
      'lib/services/insights.js',
      'lib/services/stock-fundamentals.js',
      'lib/stock-fundamentals.js',
      'public/modules/categories.js',
      'public/modules/portfolio-calculations.js',
      'public/modules/portfolio-exposure.js',
      'public/modules/portfolio-model.js',
      'public/modules/portfolio-risk.js',
      'public/modules/portfolio-symbol.js',
      'public/modules/portfolio-valuation-actions.js',
      'public/modules/portfolio-valuation.js',
      'public/modules/portfolio.js',
      'public/modules/signal-tiers.js',
      'server.js',
      'test/codex-r11.test.js',
      'test/heavy-admission.test.js',
      'test/stock-fundamentals-api.test.js',
    ],
  },
};


/** `exempt` 每一條的理由——寫在這裡，免得有人把不想維護的規則丟進去。 */
// ⚠️ **現在是空的，這是刻意的**（Codex #384 r3 High）：
//    我原本把「最新單季逐列期間」列進豁免，理由是「它在 AGENTS 對應的是 blockquote 不是表格列」。
//    Codex 實測把那條 blockquote 整條刪掉——**六題全綠**。豁免＝那條規則沒有任何人守。
//    正確的修法是把 AGENTS 那條 blockquote 改成正式的索引列，讓它跟其他規則走同一條路。
//    ⇒ **豁免名單保持空的**。要加一條進來，就要先說服自己「這條規則不需要被守」。
const EXEMPT_REASON = {};

/** GitHub 的 anchor 規則：小寫、去標點、空白轉 `-`。 @param {string} h */
function slug(h) {
  return [...h.toLowerCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c) || c === ' ' || c === '-' || c === '_')
    .join('')
    .replace(/ /g, '-');
}

const LINK_RE = /\[契約：[^\]]+\]\((?:\.\/)?((?:docs\/contracts\/)?[^)#]+\.md)#([^)]+)\)/;

/** AGENTS.md 裡所有「指向契約檔」的同步點列。 */
function indexRows() {
  // ⚠️ 列判準放寬到「trim 之後以 `|` 開頭」，連結目標**相對 repo 根解析**（Codex #384 r7）：
  //    合法的無空格表格列＋`./docs/contracts/…` 都是等價寫法，字面比對認不出來，
  //    於是「一條規則剛好一列」在 AGENTS 這一側形同虛設。
  return read('AGENTS.md').split('\n')
    .filter((l) => l.trim().startsWith('|') && LINK_RE.test(l))
    .map((line) => {
      const m = /** @type {RegExpExecArray} */ (LINK_RE.exec(line));
      return { line, file: normalize(m[1]), anchor: m[2] };
    });
}

/** 契約檔裡的每一個標題段落（`##` 與 `###` 都算）。 @param {string} file */
function sectionsOf(file) {
  const md = read(file);
  const heads = [...md.matchAll(/^#{2,3} .+$/gm)];
  return heads.map((h, i) => {
    const start = /** @type {number} */ (h.index);
    const end = i + 1 < heads.length ? /** @type {number} */ (heads[i + 1].index) : md.length;
    const text = md.slice(start, end);
    const bs = text.indexOf(BODY_LABEL);
    return {
      title: h[0].replace(/^#+\s*/, ''),
      anchor: slug(h[0].replace(/^#+\s*/, '')),
      // 位移用**字串長度**算，不要手寫數字（r1 就是寫死 9、實際 11）
      body: bs < 0 ? '' : text.slice(bs + BODY_LABEL.length),
    };
  });
}

const sorted = (/** @type {string[]} */ a) => [...a].sort();

test('拆分護欄｜manifest 必須涵蓋每一份契約（新拆一個領域就要在這裡登記）', () => {
  const onDisk = readdirSync(join(ROOT, 'docs/contracts'))
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => `docs/contracts/${f}`);
  assert.deepEqual(sorted(onDisk), sorted(Object.keys(MANIFEST)),
    'docs/contracts/ 底下的契約檔與 MANIFEST 的登記不一致。\n'
    + '⚠️ manifest 是宣告的真相——新拆一份契約就要在這裡登記，刪掉也要一起刪。\n'
    + '（r2 的假綠之一：契約檔整份刪掉，考題因為「從現有檔案反查」而完全不出聲。）');
  for (const e of Object.values(MANIFEST).flatMap((m) => m.exempt)) {
    assert.ok(EXEMPT_REASON[e], `exempt 的「${e}」沒有寫理由——豁免必須有名有姓，不然它就是後門`);
  }
});

test('拆分護欄｜契約裡的標題集合＝manifest 的 rules＋exempt（刪 marker 沒有用）', () => {
  // ⚠️ r2 的假綠：「是不是一條規則」原本靠「有沒有 `**記得同步這裡**：`」判斷，
  //    把 marker 與索引**一起**刪掉，正反兩邊同時消失、四題全綠（Codex 實測）。
  //    現在判準與文字特徵無關：**標題集合必須剛好等於宣告的清單**。
  for (const [file, m] of Object.entries(MANIFEST)) {
    const titles = sectionsOf(file).map((s) => s.title);
    assert.deepEqual(sorted(titles), sorted([...m.rules, ...m.exempt]),
      `${file} 的標題集合與 manifest 不符。\n`
      + '⚠️ 新增一條規則就要登記進 rules；刪掉一條就要一起刪。\n'
      + '   確定不是獨立規則的小節請放進 exempt **並在 EXEMPT_REASON 寫理由**。');
  }
});

test('拆分護欄｜rules 與 AGENTS 索引列**雙向**一一對應', () => {
  const rows = indexRows();
  for (const [file, m] of Object.entries(MANIFEST)) {
    const declared = m.rules.map((r) => slug(r));
    // ⚠️ 用**排序後的陣列**比對，不是 Set（Codex #384 r7）：
    //    Set 會把「同一條規則出現兩列索引」吃掉，而重複列正是真實的維護手滑
    //    （複製一列改一改忘了刪原本那列），讀的人照到哪一列是碰運氣。
    const pointed = rows.filter((r) => r.file === normalize(file)).map((r) => r.anchor);
    assert.deepEqual(sorted(pointed), sorted(declared),
      `${file} 的索引列與 manifest 的 rules 不是一一對應。\n`
      + `  AGENTS 指過來的：${sorted(pointed).join('、') || '（無）'}\n`
      + `  manifest 宣告的：${sorted(declared).join('、')}\n`
      + '⚠️ 少一個＝那條規則變成孤兒（改到相關檔案的人不會被導過去）；\n'
      + '   多一個＝索引指到不存在的段落（連結會落在檔頭）。');
  }
});

test('拆分護欄｜索引的摘要必須明顯比契約內文短（否則拆分等於沒發生）', () => {
  for (const { line, file, anchor } of indexRows()) {
    const s = sectionsOf(file).find((x) => x.anchor === anchor);
    assert.ok(s, `${file} 找不到 anchor \`#${anchor}\` 的段落 ⇒ 上一題應該已經紅；這裡不放行`);
    assert.ok(s.body, `${file}#${anchor} 的段落沒有「${BODY_LABEL}」——契約被掏空了？`);

    // 比的是「摘要 vs 內文」不是「整行 vs 整段」——整行含約 90 字元的表格框與連結標記。
    // ⚠️ 用**真正的表格 cell** 解析，不可依賴「一定有空白」的 `' | '`
    //    （Codex #384 r3 實測：把分隔符改成合法的無空白 `|`，摘要就讀到錯欄，貼回 275 字全文仍全綠）。
    // ⚠️ 用**未被跳脫**的 `|` 切欄（Codex #384 r4）：Markdown 的 cell 裡可以合法寫 `\|`，
    //    單純 `.split('|')` 會在那裡誤切，於是整段規則貼回摘要也讀不到 ⇒ 假綠。
    const cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((y) => y.trim());
    // ⚠️ 砍掉**結尾**的「——完整契約 → [連結]」，不是切第一個 marker（Codex #384 r6 Medium）：
    //    先放短摘要＋一個假 marker、再貼回完整內文、最後才放真 marker，
    //    切第一個就只量到那段短摘要 ⇒ 索引還是長回完整副本。
    const summary = (cells[1] || '').replace(/——完整契約\s*→\s*\[[^\]]*\]\([^)]*\)\s*$/u, '');
    // 比例只在長規則上生效：短規則的摘要本來就接近規則本身。
    // ⚠️ **比例一律適用，沒有「短規則例外」**（Codex #384 r3 之後收斂）：
    //    原本對短規則放寬成「只要比內文短一個字」，結果**整段 274 字的 body 貼回去
    //    變成 273 字的摘要照樣過**——差一個字元的「短」不是拆分。
    const limit = Math.floor(s.body.length * MAX_SUMMARY_RATIO);
    assert.ok(summary.length <= limit,
      '索引摘要沒有比契約內文短夠多 ⇒ 這條規則接近「兩份完整副本」，一定會各自漂。\n'
      + `摘要 ${summary.length} 字元、契約內文 ${s.body.length} 字元（上限 ${limit}）（${file}#${anchor}）\n`
      + `實得摘要：${summary.slice(0, 120)}…`);
    assert.ok(line.length <= MAX_INDEX_LEN,
      `索引行 ${line.length} 字元，超過上限 ${MAX_INDEX_LEN}。細節請放進 ${file}。\n`
      + `實得：${line.slice(0, 120)}…`);
  }
});

test('拆分護欄｜README 路由列的檔案集合＝manifest 的 files（精確路徑，不接受冒充）', () => {
  // ⚠️ r2 的假綠：原本用 basename 子字串比對，`lib/store-rules.js` 可以替
  //    缺掉的 `lib/services/store-rules.js` 冒充過關。現在只認**完整路徑**的精確集合相等。
  const readme = read('docs/contracts/README.md');
  // ⚠️ 判準用**解析後的連結目標**，不是原始字串（Codex #384 r6 High）：
  //    `|前端功能…|`（合法的無空格表格列）與 `[前端功能.md](./前端功能.md)`（等價相對路徑）
  //    都繞得過「以 `| ` 開頭」＋「含 `(檔名)`」這種字面比對，於是矛盾的重複列照樣過關。
  const rows = readme.split('\n').filter((l) => l.trim().startsWith('|') && /\.md\)/.test(l));
  // ⚠️ 連結要**相對該檔所在目錄解析**，不能只比 basename（Codex #384 r7）：
  //    把 README 的 `(前端功能.md)` 寫成 `(docs/contracts/前端功能.md)`
  //    ——那是從 AGENTS 複製路徑到子目錄 README 的真實手滑——實際會連到
  //    `docs/contracts/docs/contracts/…`（不存在），只比 basename 卻看不出來。
  /** @param {string} l */
  const targetsOf = (l) => [...l.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)]
    .map((m) => normalize(join('docs/contracts', m[1])));
  for (const [file, m] of Object.entries(MANIFEST)) {
    const base = /** @type {string} */ (file.split('/').pop());
    // ⚠️ **剛好一列**（Codex #384 r5 High）：原本用 `rows.find()` 只驗第一列，
    //    於是在正確列後面再加一條「同一份契約、沒有任何責任檔」的矛盾路由，六題照樣全綠。
    //    路由表有兩列指向同一份契約時，讀的人會照到哪一列是碰運氣。
    const matched = rows.filter((r) => targetsOf(r).includes(normalize(file)));
    assert.equal(matched.length, 1,
      `${file} 在 README 路由表對應到 ${matched.length} 列（必須剛好 1 列）。\n`
      + '0 列＝那個領域的規則沒人會被導到；2 列以上＝讀的人照到哪一列是碰運氣。');
    const row = matched[0];
    const listed = [...row.matchAll(/`((?:lib|public|test|data|db)\/[A-Za-z0-9_./-]+\.[a-z]+|server\.js)`/g)]
      .map((x) => x[1]);
    assert.deepEqual(sorted([...new Set(listed)]), sorted(m.files),
      `${base} 的路由列與 manifest 的 files 不一致。\n`
      + '⚠️ README 硬規則①：已拆領域的檔案清單＝**窮舉**，不是「典型檔案」。\n'
      + `  路由列有、manifest 沒有：${listed.filter((f) => !m.files.includes(f)).join('、') || '（無）'}\n`
      + `  manifest 有、路由列沒有：${m.files.filter((f) => !listed.includes(f)).join('、') || '（無）'}`);
    for (const f of m.files) {
      assert.ok(existsSync(join(ROOT, f)), `${base} 的 files 列了不存在的檔案 ${f}`);
    }
  }
});

test('拆分護欄｜契約內文提到的 repo 路徑，都要在 files 裡（提到新檔就強迫更新 manifest）', () => {
  for (const [file, m] of Object.entries(MANIFEST)) {
    const mentioned = new Set([...read(file)
      .matchAll(/`((?:lib|public|test|data|db)\/[A-Za-z0-9_./-]+\.[a-z]+|server\.js)`/g)].map((x) => x[1]));
    const missing = [...mentioned].filter((f) => !m.files.includes(f));
    assert.deepEqual(missing, [],
      `${file} 的內文點名了這些檔案，但 manifest 的 files 沒有：\n  ${missing.join('\n  ')}\n`
      + '⚠️ 這是**下限**不是上限：契約用函式名或 API 路徑點到的檔案考題看不出來，\n'
      + '   那些仍然要靠人加進 files（Codex #384 r1／r2 兩輪各抓到一批）。');
  }
});
