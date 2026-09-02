// @ts-check
/**
 * 查核 `SEC_METRIC_CANDIDATES` 裡的每一顆 us-gaap 元素名**是不是真的存在**。
 *
 * ## 為什麼要有這支（2026-09-02）
 *
 * `lib/stock-fundamentals.js` 的候選表寫過三顆**查無此元素**的 tag，其中
 * `LongTermDebtAndFinanceLeaseObligationsNoncurrent` 活了好幾個月沒人發現。原因是
 * **考題餵自己假名字**：fixture 的鍵、期望輸出的 tag 欄、契約 pin 的字串，三處都是從
 * production 抄過來的同一份字串——名字是真是假，整個測試套件**結構上分不出來**，
 * 錯的名字一樣全綠。錯名字的後果是那個 tag 永遠匹配不到，畫面欄位靜靜留空。
 *
 * 唯一能分辨真假的東西在**外部**（官方 taxonomy 與 SEC 實際申報資料），所以這支要連網。
 *
 * ## ⚠️ 這是「絆線」，不是「閘」——照實說
 *
 * 它**不在** `npm test` 裡，也不是任何合併閘。沒有人跑它，它就不會響。
 * （純邏輯的部分另有離線考題 `test/verify-us-gaap-tags.test.js` 在 `npm test` 裡，
 *   但那只鎖判準，鎖不了「外面的世界長怎樣」——那部分只有跑這支才問得到。）
 * 之所以不做成自動閘：①CI 會因此依賴 FASB／SEC 兩個外部網站的可用性；
 * ②要改成離線閘就得把官方元素名快照塞進 repo，而**已停用的元素會從新版官方清單消失**
 * （`SalesRevenueNet` 就是：2021 起從 taxonomy 移除，但歷史申報裡有數千筆真資料、
 * 程式保留它當低順位退路是對的），離線快照因此必須跨年度聯集＋標註停用，每年還要維護。
 * 規矩改成：**動到 `SEC_METRIC_CANDIDATES` 的候選 tag，就手動跑一次這支**。
 *
 * ## 判準
 *
 *   live       最新版官方 taxonomy 裡有 → 正常
 *   deprecated 最新版沒有，但舊版有、或 SEC 實際申報查得到資料 → 正常（歷史資料要用）
 *   MISSING    每一版 taxonomy 都沒有，且抽樣期間 SEC 一筆資料都沒有 → **這就是那個病**
 *
 * ## 退出碼
 *
 *   0  沒有新問題
 *   1  查核**發現**：新的 MISSING，或 KNOWN_MISSING 已過期
 *   2  用法錯誤（沒設 SEC_USER_AGENT）
 *   3  對照組不符＝這支自己壞了，結果不可信
 *   4  作業失敗（網路／解析／檔案）——**與「發現」分開**，
 *      才不會把「根本沒查完」誤讀成「查過了有發現」
 *
 * ## 用法
 *
 *   SEC_USER_AGENT='你的名字 你的email' node scripts/verify-us-gaap-tags.js
 *
 * SEC 要求 User-Agent 帶得到聯絡方式，**刻意不寫死在檔案裡**（本 repo 是公開的，
 * 寫死等於把私人 email 推上 GitHub）。沒設就直接停，不用假的值硬送。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMainModule } from '../lib/is-main.js';
import { SEC_METRIC_CANDIDATES } from '../lib/stock-fundamentals.js';

/**
 * 官方 taxonomy **每一版都查，不抽樣**（2011–2026 全部）。
 * ⚠️ 檔名有兩種：2022 起是 `us-gaap-<年>.xsd`，2021 以前是 `us-gaap-<年>-01-31.xsd`。
 * 〔r1 修：原本只挑四版當「抽樣」，卻在註解與契約寫成「2015–2026 都查」——射程不足還講得比實際寬。〕
 */
const TAXONOMY_YEARS = /** @type {const} */ ([
  2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021,
  2022, 2023, 2024, 2025, 2026
]);

/** @param {number} year */
function taxonomyFile(year) {
  return year >= 2022 ? `us-gaap-${year}.xsd` : `us-gaap-${year}-01-31.xsd`;
}

/** SEC frames 抽樣期間：橫跨十年，才看得到「只在舊年度有資料」的已停用元素。 */
const SAMPLE_YEARS = [2013, 2015, 2017, 2019, 2021, 2023, 2024];

/** 單次外連逾時；沒有它的話「永遠 pending」連退出碼都不會有（Codex r2）。 */
const FETCH_TIMEOUT_MS = 60_000;

/** 一份 taxonomy 至少要有這麼多元素才可能是完整檔。 */
const MIN_TAXONOMY_ELEMENTS = 5000;

/**
 * frames API 的 unit 路徑段。⚠️ 與 Company Facts 內部的寫法**不一樣**：
 * 每股在 facts 裡是 `USD/shares`，在 frames 的網址裡是 `USD-per-shares`。
 * @param {'currency'|'per-share'|'shares'} unitKind
 */
function frameUnit(unitKind) {
  if (unitKind === 'shares') return 'shares';
  if (unitKind === 'per-share') return 'USD-per-shares';
  return 'USD';
}

/**
 * 對照組：這幾顆的分類是**已知答案**。跑出來不符合就代表這支自己壞了
 * （網址改版、正規式抓不到、SEC 擋人……），必須大聲停下來，
 * 而不是把每一顆都報成 MISSING、或每一顆都報成 live——兩種都是空包彈。
 */
const CONTROLS = /** @type {const} */ ([
  { tag: 'LongTermDebtNoncurrent', expect: 'live' },
  { tag: 'SalesRevenueNet', expect: 'deprecated' },
  { tag: 'LongTermDebtAndFinanceLeaseObligationsNoncurrent', expect: 'MISSING' }
]);

/**
 * 正向 SEC 探針：這顆在這個期間必定有一大票申報，查回來是空的＝SEC 那半沒在運作。
 * ⚠️ 劃界（Codex r2）：它只證明 **`USD`／instant 這一條 route 可用**，
 * 證明不了 duration／per-share／shares 或個別 tag 路徑沒有部分故障。
 */
const SEC_PROBE = /** @type {const} */ ({
  tag: 'LongTermDebtNoncurrent', unitKind: 'currency', frame: 'CY2024Q4I', minFacts: 100
});

/**
 * **已登記、尚未處理**的 MISSING。⚠️ 綁的是 **(tag, metric) 這一對**，不是 tag 名。
 *
 * 2026-09-02 這支寫出來的第一次執行就抓到這兩顆（與 noncurrentDebt 同一種病）。William 當場裁示
 * **本支只修 noncurrentDebt**，這兩顆另開一支——因為換掉它們等於挑新的替代科目
 * （資本支出可能改用 `PaymentsForCapitalImprovements`、股票回購可能改用
 * `PaymentsForRepurchaseOfEquity`），那是金額口徑的選擇，照家規要先請他裁。
 *
 * ⚠️ **為什麼一定要綁 metric**（Codex r2 實測兩種繞法，兩種都 exit 0）：
 *   ①假 tag 放回候選表、同時加進這份清單 ⇒ 被當成「已登記」放行；
 *   ②不改清單，只把**已登記的舊帳** tag 加到別的 metric ⇒ 一樣被當成「已登記」放行。
 * 綁成一對之後，同一顆 tag 出現在**沒登記的 metric** 上就是新發現，照樣紅。
 *
 * ⚠️ 這份清單的用途是**保住訊號**，不是藏東西：兩顆已知的舊帳讓這支永遠紅，
 * 人就會開始無視它，那條絆線等於沒有。所以已登記的只降級成「待修」不影響退出碼。
 * 反過來，清單如果過期（那顆修好了、或已經不在那個 metric 上）也會紅——它不能無聲爛掉。
 *
 * ⚠️ **它是永久 allowlist，沒有到期日**：「未過期」只代表那顆還壞著，不代表有人在處理。
 * 真正的追蹤在 PR #546 描述與另開的那一支，不要把這份清單當待辦系統。
 */
const KNOWN_MISSING = /** @type {const} */ ([
  { tag: 'PaymentsForAdditionsToPropertyPlantAndEquipment', metric: 'capitalExpenditure' },
  { tag: 'PaymentsForRepurchaseOfCommonAndPreferredStock', metric: 'shareRepurchases' }
]);

const CACHE_DIR = join(tmpdir(), 'us-gaap-taxonomy-cache');

/** 作業失敗（網路／解析／檔案）——與「查核發現」分開，見檔頭退出碼表。 */
export class OperationalError extends Error {}

/**
 * 把任何 IO／decode 例外統一轉成作業失敗，避免它們走原生未捕捉路徑而回 exit 1
 * （與「查核發現」撞碼——Codex r2 Medium②）。
 * @template T @param {string} what @param {() => Promise<T>|T} fn @returns {Promise<T>}
 */
async function asOperational(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OperationalError) throw err;
    throw new OperationalError(`${what}：${err instanceof Error ? err.message : String(err)}`,
      { cause: err });
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} url @param {string} userAgent @returns {Promise<Response>} */
async function httpGet(url, userAgent) {
  return await asOperational(`GET ${url}`, () => fetch(url, {
    headers: { 'User-Agent': userAgent },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  }));
}

/**
 * 一份 taxonomy 快取檔看起來完整嗎？
 * ⚠️ 只有元素數門檻擋不住**截斷檔**（Codex r2 實測：2026 版截到 2MB 仍有 6720 個元素、
 * 過得了門檻，卻已經漏掉候選表裡三顆 live tag ⇒ 下一輪會靜靜把它們降成 deprecated 並 exit 0）。
 * 所以再加兩道結構檢查：年份對得上的 targetNamespace、以及檔尾的 `</xs:schema>`。
 * @param {string} xml @param {number} year @returns {string|null} null＝看起來完整；否則回失敗原因
 */
export function taxonomyIntegrityProblem(xml, year) {
  if (!new RegExp(`targetNamespace=(['"])http://fasb\\.org/us-gaap/${year}`).test(xml)) {
    return `找不到 ${year} 年的 targetNamespace（檔案不是這一版，或前段就被截掉了）`;
  }
  if (!/<\/xs:schema>\s*$/.test(xml)) {
    return '檔尾沒有 </xs:schema>（下載中斷／磁碟寫不完／快取被截斷）';
  }
  const count = countElementNames(xml).size;
  if (count < MIN_TAXONOMY_ELEMENTS) {
    return `只解析出 ${count} 個元素（門檻 ${MIN_TAXONOMY_ELEMENTS}），解析或檔案有問題`;
  }
  return null;
}

/**
 * 抽出 XSD 宣告的元素名。
 * ⚠️ 兩種引號都要收：多數年份用單引號（`name='Revenues'`），但**官方 2018 版用雙引號**。
 * 〔r1 修：原本只認單引號，還在註解寫「官方 XSD 用單引號」——2018 版當場推翻它。〕
 * @param {string} xml @returns {Set<string>}
 */
export function countElementNames(xml) {
  return new Set([...xml.matchAll(/name=(['"])([A-Za-z][A-Za-z0-9]*)\1/g)].map((m) => m[2]));
}

/**
 * 下載（並快取）一份 taxonomy，回傳它宣告的元素名集合。
 * 快取寫入走「暫存檔＋rename」＝原子替換，中途死掉不會留下半份被下一輪當成好檔讀。
 * @param {number} year @param {string} userAgent @returns {Promise<Set<string>>}
 */
async function loadTaxonomyNames(year, userAgent) {
  const file = taxonomyFile(year);
  const cached = join(CACHE_DIR, file);
  await asOperational(`建立快取目錄 ${CACHE_DIR}`, () => mkdirSync(CACHE_DIR, { recursive: true }));

  if (existsSync(cached)) {
    const xml = await asOperational(`讀取快取 ${file}`, () => readFileSync(cached, 'utf8'));
    const problem = taxonomyIntegrityProblem(xml, year);
    if (!problem) return countElementNames(xml);
    // 壞快取就丟掉重抓一次；再壞就是作業失敗，不可以拿殘檔繼續判定
    console.warn(`  ⚠️  ${file} 快取不完整（${problem}）——丟掉重抓`);
    await asOperational(`刪除壞快取 ${file}`, () => rmSync(cached, { force: true }));
  }

  const res = await httpGet(`https://xbrl.fasb.org/us-gaap/${year}/elts/${file}`, userAgent);
  if (!res.ok) throw new OperationalError(`GET ${file} → HTTP ${res.status}`);
  const xml = await asOperational(`讀取 ${file} 回應內容`, () => res.text());
  const problem = taxonomyIntegrityProblem(xml, year);
  if (problem) throw new OperationalError(`${file} 下載回來仍不完整：${problem}`);

  // 同目錄唯一暫存檔 → rename（同檔系統的 rename 是原子的）
  const tmp = `${cached}.tmp-${process.pid}`;
  await asOperational(`寫入快取 ${file}`, () => {
    writeFileSync(tmp, xml);
    renameSync(tmp, cached);
  });
  return countElementNames(xml);
}

/**
 * 問 SEC 一個 frame 有幾筆事實。404＝這個期間沒資料（正常），其他非 200＝作業失敗。
 * @param {string} tag @param {string} unit @param {string} frame @param {string} userAgent
 */
async function fetchFrameCount(tag, unit, frame, userAgent) {
  const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/${unit}/${frame}.json`;
  const res = await httpGet(url, userAgent);
  if (res.status === 404) return 0;
  if (!res.ok) throw new OperationalError(`GET ${url} → HTTP ${res.status}`);
  const body = /** @type {any} */ (await asOperational(`解析 ${url} 的 JSON`, () => res.json()));
  // 200 但 body 形狀不對＝回應格式變了，不可以當成「0 筆」靜靜吞掉
  if (!Array.isArray(body?.data)) {
    throw new OperationalError(`GET ${url} → 200 但 data 不是陣列（回應格式變了？）`);
  }
  return body.data.length;
}

/**
 * 這顆 tag 在 SEC 實際申報裡抽樣得到幾筆事實。
 * @param {string} tag @param {'instant'|'duration'} nature
 * @param {'currency'|'per-share'|'shares'} unitKind @param {string} userAgent
 */
async function countSampledFacts(tag, nature, unitKind, userAgent) {
  const unit = frameUnit(unitKind);
  let total = 0;
  for (const year of SAMPLE_YEARS) {
    const frame = nature === 'instant' ? `CY${year}Q4I` : `CY${year}`;
    total += await fetchFrameCount(tag, unit, frame, userAgent);
    await sleep(120);   // SEC 要求節制發送速率
  }
  return total;
}

/** 把候選表攤平成「tag → 它屬於哪些指標」。 */
export function collectCandidateTags() {
  /** @type {Map<string, {metrics: string[], nature: 'instant'|'duration', unitKind: 'currency'|'per-share'|'shares'}>} */
  const byTag = new Map();
  for (const [key, metric] of Object.entries(SEC_METRIC_CANDIDATES)) {
    const nature = metric.nature === 'instant' ? 'instant' : 'duration';
    const unitKind = /** @type {'currency'|'per-share'|'shares'} */ (metric.unitKind);
    for (const tag of metric.tags) {
      const entry = byTag.get(tag) || { metrics: [], nature, unitKind };
      entry.metrics.push(key);
      byTag.set(tag, entry);
    }
  }
  return byTag;
}

/**
 * @param {number[]} foundYears 出現在哪幾版 taxonomy
 * @param {number} facts SEC 抽樣事實數
 * @param {number} newestYear
 * @returns {'live'|'deprecated'|'MISSING'}
 */
export function classify(foundYears, facts, newestYear) {
  if (foundYears.includes(newestYear)) return 'live';
  if (foundYears.length > 0 || facts > 0) return 'deprecated';
  return 'MISSING';
}

/**
 * 哪些 tag 可以因為「只是對照組」而不算發現。
 * ⚠️ **只有不在候選表裡的對照組才豁免**——預期 MISSING 的那顆一旦出現在候選表，
 * 那正是本工具存在的唯一理由（假 tag 回到正式候選），絕不可以被自己的對照組掩護掉。
 * @param {Set<string>} candidateTags @returns {Set<string>}
 */
export function controlOnlyExemptions(candidateTags) {
  return new Set(
    CONTROLS
      .filter((c) => c.expect === 'MISSING' && !candidateTags.has(c.tag))
      .map((c) => /** @type {string} */ (c.tag))
  );
}

/**
 * 對照組裡預期 MISSING 的那幾顆是這支工具的**證據**，不是一般的洞。
 * 它們一旦出現在候選表，就是本工具存在的唯一理由（假 tag 回到正式候選）——
 * **不可以被 allowlist 掩護**，也不可以被登記進 `KNOWN_MISSING`。
 * 〔r2 修：Codex 實測「假 tag 進候選表＋同時加進 allowlist」⇒ exit 0。
 *   綁 (tag, metric) 擋得住「舊帳挪用到新 metric」，擋不住「連同 allowlist 一起加」，
 *   所以這一類要用「永不可豁免」處理，而不是再多一層條件。〕
 */
export const NEVER_ALLOWLISTABLE = new Set(
  CONTROLS.filter((c) => c.expect === 'MISSING').map((c) => /** @type {string} */ (c.tag))
);

/** @param {{tag: string, metric: string}} pair */
const pairKey = (pair) => `${pair.tag}@${pair.metric}`;

/**
 * 把「MISSING 的 (tag, metric) 對」分成三堆。**判準的單位是一對，不是 tag 名**。
 *
 * ⚠️ `NEVER_ALLOWLISTABLE` 裡的 tag **一律算新發現**，登記了也沒用。
 *
 * @param {{tag: string, metric: string}[]} missingPairs 這次查出來所有 MISSING 的 (tag, metric)
 * @param {readonly {tag: string, metric: string}[]} [allowlist]
 * @param {Set<string>} [neverAllowlistable]
 * @returns {{fresh: {tag: string, metric: string}[], registered: {tag: string, metric: string}[], stale: {tag: string, metric: string}[]}}
 */
export function partitionMissing(missingPairs, allowlist = KNOWN_MISSING,
  neverAllowlistable = NEVER_ALLOWLISTABLE) {
  const allowed = new Set(allowlist.map(pairKey));
  const seen = new Set(missingPairs.map(pairKey));
  const covered = (/** @type {{tag: string, metric: string}} */ p) =>
    allowed.has(pairKey(p)) && !neverAllowlistable.has(p.tag);
  return {
    fresh: missingPairs.filter((p) => !covered(p)),
    registered: missingPairs.filter(covered),
    // 過期＝登記了但這次沒查到（修好了、或那顆已經不在那個 metric 上）
    stale: allowlist.filter((p) => !seen.has(pairKey(p))).map((p) => ({ ...p }))
  };
}

async function main() {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) {
    console.error('請先設定 SEC_USER_AGENT（SEC 要求 User-Agent 帶聯絡方式）。例如：');
    console.error("  SEC_USER_AGENT='Your Name your@email' node scripts/verify-us-gaap-tags.js");
    process.exit(2);
  }

  // 自檢：有人把對照 tag 登記進 allowlist＝這支工具的證據被拆掉了，先擋下來
  const disarmed = KNOWN_MISSING.filter((p) => NEVER_ALLOWLISTABLE.has(p.tag));
  if (disarmed.length) {
    console.error('\n🛑 KNOWN_MISSING 登記了對照組的 tag，等於把這支工具的證據拆掉：');
    for (const p of disarmed) console.error(`   ・${p.tag}（登記在 ${p.metric}）`);
    console.error('   這幾顆是「假 tag 回到候選表」的判定基準，永遠不可豁免。');
    process.exit(3);
  }

  console.log(`下載官方 taxonomy ${TAXONOMY_YEARS.length} 版（第一次會慢，之後讀快取）…`);
  /** @type {Map<number, Set<string>>} */
  const taxonomies = new Map();
  for (const year of TAXONOMY_YEARS) {
    taxonomies.set(year, await loadTaxonomyNames(year, userAgent));
    process.stdout.write(`  ${year} ✓\n`);
  }
  const newestYear = TAXONOMY_YEARS[TAXONOMY_YEARS.length - 1];

  // ── 正向 SEC 探針：先證明 SEC 那半真的在運作，再去信任任何「0 筆」 ──
  const probeCount = await fetchFrameCount(
    SEC_PROBE.tag, frameUnit(SEC_PROBE.unitKind), SEC_PROBE.frame, userAgent
  );
  if (probeCount < SEC_PROBE.minFacts) {
    console.error(`\n🛑 SEC 正向探針只拿到 ${probeCount} 筆（`
      + `${SEC_PROBE.tag} ${SEC_PROBE.frame} 應有 ≥${SEC_PROBE.minFacts} 筆）。`);
    console.error('   SEC 那半沒在運作（網址搬家／被擋／路由錯），此時任何「0 筆」都不算證據。');
    process.exit(3);
  }
  console.log(`SEC 正向探針：${SEC_PROBE.tag} ${SEC_PROBE.frame} 拿到 ${probeCount} 筆 ✓`);

  const byTag = collectCandidateTags();
  const candidateTags = new Set(byTag.keys());
  const exempt = controlOnlyExemptions(candidateTags);

  // 對照組必須真的被查到（預期 MISSING 那顆刻意不在候選表裡，是為了證明「MISSING」這一格會亮）
  const targets = new Map(byTag);
  for (const { tag } of CONTROLS) {
    if (!targets.has(tag)) {
      targets.set(tag, { metrics: ['(對照組，不在候選表)'], nature: 'instant', unitKind: 'currency' });
    }
  }

  console.log(`\n查核 ${targets.size} 顆 tag…\n`);
  /** @type {Map<string, {status: string, foundYears: number[], facts: number, metrics: string[]}>} */
  const results = new Map();
  for (const [tag, { metrics, nature, unitKind }] of targets) {
    const foundYears = [...taxonomies.entries()].filter(([, n]) => n.has(tag)).map(([y]) => y);
    // taxonomy 已經證明存在就不必再問 SEC，省下一輪外連
    const facts = foundYears.length ? -1 : await countSampledFacts(tag, nature, unitKind, userAgent);
    const status = classify(foundYears, facts, newestYear);
    results.set(tag, { status, foundYears, facts, metrics });
    const mark = status === 'MISSING' ? '❌' : status === 'deprecated' ? '⚠️ ' : '✅';
    const note = foundYears.length
      ? `taxonomy ${foundYears[0]}–${foundYears[foundYears.length - 1]}`
      : `taxonomy ${TAXONOMY_YEARS.length} 版全無、SEC 抽樣 ${facts} 筆`;
    console.log(`${mark} ${status.padEnd(10)} ${tag}\n      ${note}｜用於 ${metrics.join('／')}`);
  }

  // ── 對照組先驗：這支自己有沒有在做事 ──
  /** @type {string[]} */
  const controlFailures = [];
  for (const { tag, expect } of CONTROLS) {
    const got = results.get(tag)?.status;
    if (got !== expect) controlFailures.push(`${tag} 應為 ${expect}，實際 ${got}`);
  }
  if (controlFailures.length) {
    console.error('\n🛑 對照組不符，這次查核不可信（八成是網址改版或解析壞了）：');
    for (const line of controlFailures) console.error(`   ・${line}`);
    process.exit(3);
  }
  console.log('\n對照組全部符合預期、SEC 探針有回資料（限 USD／instant 那條 route）＝結果可採信。');

  // MISSING 攤平成 (tag, metric) 對——對照組那顆不在候選表時不算數
  /** @type {{tag: string, metric: string}[]} */
  const missingPairs = [];
  for (const [tag, r] of results) {
    if (r.status !== 'MISSING' || exempt.has(tag)) continue;
    for (const metric of r.metrics) missingPairs.push({ tag, metric });
  }
  const { fresh, registered, stale } = partitionMissing(missingPairs);

  if (registered.length) {
    console.log(`\n⚠️  已登記待修 ${registered.length} 筆（不影響退出碼，但它們現在確實讀不到值）：`);
    for (const p of registered) console.log(`   ・${p.tag}（用於 ${p.metric}）`);
  }
  if (stale.length) {
    console.error('\n❌ KNOWN_MISSING 已過期，請把這幾行從清單刪掉：');
    for (const p of stale) console.error(`   ・${p.tag}（登記在 ${p.metric}）`);
    process.exit(1);
  }
  if (fresh.length) {
    console.error(`\n❌ 新冒出 ${fresh.length} 筆查無此元素（永遠匹配不到，畫面會靜靜留空）：`);
    for (const p of fresh) console.error(`   ・${p.tag}（用於 ${p.metric}）`);
    process.exit(1);
  }
  console.log('\n✅ 沒有新的查無此元素。');
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    if (err instanceof OperationalError) {
      console.error(`\n🛑 作業失敗（查不動，不代表沒問題）：${err.message}`);
      process.exit(4);
    }
    throw err;
  }
}
