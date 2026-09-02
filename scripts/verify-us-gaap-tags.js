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
 * 只要有一顆 MISSING 就以非零退出。
 *
 * ## 用法
 *
 *   SEC_USER_AGENT='你的名字 你的email' node scripts/verify-us-gaap-tags.js
 *
 * SEC 要求 User-Agent 帶得到聯絡方式，**刻意不寫死在檔案裡**（本 repo 是公開的，
 * 寫死等於把私人 email 推上 GitHub）。沒設就直接停，不用假的值硬送。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMainModule } from '../lib/is-main.js';
import { SEC_METRIC_CANDIDATES } from '../lib/stock-fundamentals.js';

/** 新版檔名（us-gaap-YYYY.xsd）與舊版檔名（us-gaap-YYYY-01-31.xsd）分兩批。 */
const TAXONOMY_YEARS = /** @type {const} */ ([
  { year: 2015, file: 'us-gaap-2015-01-31.xsd' },
  { year: 2017, file: 'us-gaap-2017-01-31.xsd' },
  { year: 2019, file: 'us-gaap-2019-01-31.xsd' },
  { year: 2021, file: 'us-gaap-2021-01-31.xsd' },
  { year: 2022, file: 'us-gaap-2022.xsd' },
  { year: 2023, file: 'us-gaap-2023.xsd' },
  { year: 2024, file: 'us-gaap-2024.xsd' },
  { year: 2025, file: 'us-gaap-2025.xsd' },
  { year: 2026, file: 'us-gaap-2026.xsd' }
]);

/** SEC frames 抽樣期間：橫跨十年，才看得到「只在舊年度有資料」的已停用元素。 */
const SAMPLE_YEARS = [2013, 2015, 2017, 2019, 2021, 2023, 2024];

/**
 * 對照組：這三顆的分類是**已知答案**。跑出來不符合就代表這支自己壞了
 * （網址改版、正規式抓不到、SEC 擋人……），必須大聲停下來，
 * 而不是把每一顆都報成 MISSING、或每一顆都報成 live——兩種都是空包彈。
 */
const CONTROLS = /** @type {const} */ ([
  { tag: 'LongTermDebtNoncurrent', expect: 'live' },
  { tag: 'SalesRevenueNet', expect: 'deprecated' },
  { tag: 'LongTermDebtAndFinanceLeaseObligationsNoncurrent', expect: 'MISSING' }
]);

/**
 * **已登記、尚未處理**的 MISSING。
 *
 * 2026-09-02 這支寫出來的第一次執行就抓到這兩顆（與 noncurrentDebt 同一種病）。William 當場裁示
 * **本支只修 noncurrentDebt**，這兩顆另開一支——因為換掉它們等於挑新的替代科目
 * （資本支出可能改用 `PaymentsForCapitalImprovements`、股票回購可能改用
 * `PaymentsForRepurchaseOfEquity`），那是金額口徑的選擇，照家規要先請他裁。
 *
 * ⚠️ 這份清單的用途是**保住訊號**，不是藏東西：
 * 兩顆已知的舊帳讓這支永遠紅，人就會開始無視它，那條絆線等於沒有。
 * 所以已登記的只降級成「待修」不影響退出碼，**新冒出來的一顆就會讓退出碼變 1**。
 * 反過來，清單如果過期（那顆修好了、或已經不在候選表裡）也會紅——它不能無聲爛掉。
 */
const KNOWN_MISSING = /** @type {const} */ ([
  'PaymentsForAdditionsToPropertyPlantAndEquipment',
  'PaymentsForRepurchaseOfCommonAndPreferredStock'
]);

const CACHE_DIR = join(tmpdir(), 'us-gaap-taxonomy-cache');

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} url @param {string} userAgent */
async function fetchText(url, userAgent) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return await res.text();
}

/**
 * 下載（並快取）一份 taxonomy，回傳它宣告的元素名集合。
 * @param {string} file @param {string} userAgent @returns {Promise<Set<string>>}
 */
async function loadTaxonomyNames(file, userAgent) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cached = join(CACHE_DIR, file);
  let xml;
  if (existsSync(cached)) {
    xml = readFileSync(cached, 'utf8');
  } else {
    const year = file.slice('us-gaap-'.length, 'us-gaap-'.length + 4);
    xml = await fetchText(`https://xbrl.fasb.org/us-gaap/${year}/elts/${file}`, userAgent);
    writeFileSync(cached, xml);
  }
  // 官方 XSD 的屬性用**單引號**（`name='Revenues'`）——寫成雙引號會一顆都抓不到、
  // 全部報成 MISSING。CONTROLS 就是為了在這種情況下把這支釘死在紅色。
  const names = new Set([...xml.matchAll(/name='([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]));
  if (names.size < 5000) {
    throw new Error(`${file} 只解析出 ${names.size} 個元素，遠少於官方規模——解析壞了，不要相信這次結果`);
  }
  return names;
}

/**
 * 這顆 tag 在 SEC 實際申報裡抽樣得到幾筆事實。
 * @param {string} tag @param {'instant'|'duration'} periodKind @param {string} userAgent
 */
async function countSampledFacts(tag, periodKind, userAgent) {
  let total = 0;
  for (const year of SAMPLE_YEARS) {
    const frame = periodKind === 'instant' ? `CY${year}Q4I` : `CY${year}`;
    const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/${frame}.json`;
    const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (res.status === 404) { await sleep(120); continue; }   // 這個期間沒有資料
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const body = /** @type {any} */ (await res.json());
    total += Array.isArray(body?.data) ? body.data.length : 0;
    await sleep(120);   // SEC 要求節制發送速率
  }
  return total;
}

/** 把候選表攤平成「tag → 它屬於哪些指標」。 */
export function collectCandidateTags() {
  /** @type {Map<string, {metrics: string[], nature: 'instant'|'duration'}>} */
  const byTag = new Map();
  for (const [key, metric] of Object.entries(SEC_METRIC_CANDIDATES)) {
    const nature = metric.nature === 'instant' ? 'instant' : 'duration';
    for (const tag of metric.tags) {
      const entry = byTag.get(tag) || { metrics: [], nature };
      entry.metrics.push(key);
      byTag.set(tag, entry);
    }
  }
  return byTag;
}

/**
 * @param {string} tag
 * @param {number[]} foundYears 出現在哪幾版 taxonomy
 * @param {number} facts SEC 抽樣事實數
 * @param {number} newestYear
 * @returns {'live'|'deprecated'|'MISSING'}
 */
export function classify(tag, foundYears, facts, newestYear) {
  if (foundYears.includes(newestYear)) return 'live';
  if (foundYears.length > 0 || facts > 0) return 'deprecated';
  return 'MISSING';
}

async function main() {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) {
    console.error('請先設定 SEC_USER_AGENT（SEC 要求 User-Agent 帶聯絡方式）。例如：');
    console.error("  SEC_USER_AGENT='Your Name your@email' node scripts/verify-us-gaap-tags.js");
    process.exit(2);
  }

  console.log('下載官方 taxonomy（第一次會慢，之後讀快取）…');
  /** @type {Map<number, Set<string>>} */
  const taxonomies = new Map();
  for (const { year, file } of TAXONOMY_YEARS) {
    taxonomies.set(year, await loadTaxonomyNames(file, userAgent));
    process.stdout.write(`  ${year} ✓\n`);
  }
  const newestYear = TAXONOMY_YEARS[TAXONOMY_YEARS.length - 1].year;

  const byTag = collectCandidateTags();
  // 對照組必須真的被查到（其中一顆刻意不在候選表裡，是為了證明「MISSING」這一格會亮）
  const targets = new Map(byTag);
  for (const { tag } of CONTROLS) {
    if (!targets.has(tag)) targets.set(tag, { metrics: ['(對照組，不在候選表)'], nature: 'instant' });
  }

  console.log(`\n查核 ${targets.size} 顆 tag（含 ${CONTROLS.length} 顆對照組）…\n`);
  /** @type {Map<string, {status: string, foundYears: number[], facts: number, metrics: string[]}>} */
  const results = new Map();
  for (const [tag, { metrics, nature }] of targets) {
    const foundYears = [...taxonomies.entries()].filter(([, n]) => n.has(tag)).map(([y]) => y);
    // taxonomy 已經證明存在就不必再問 SEC，省下一輪外連
    const facts = foundYears.length ? -1 : await countSampledFacts(tag, nature, userAgent);
    const status = classify(tag, foundYears, facts, newestYear);
    results.set(tag, { status, foundYears, facts, metrics });
    const mark = status === 'MISSING' ? '❌' : status === 'deprecated' ? '⚠️ ' : '✅';
    const note = foundYears.length
      ? `taxonomy ${foundYears[0]}–${foundYears[foundYears.length - 1]}`
      : `taxonomy 全無、SEC 抽樣 ${facts} 筆`;
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
  console.log('\n對照組三顆都符合預期＝這支確實查得動，結果可信。');

  const missing = [...results].filter(([tag, r]) => r.status === 'MISSING'
    && !CONTROLS.some((c) => c.tag === tag && c.expect === 'MISSING'));
  const fresh = missing.filter(([tag]) => !KNOWN_MISSING.includes(/** @type {any} */ (tag)));
  const registered = missing.filter(([tag]) => KNOWN_MISSING.includes(/** @type {any} */ (tag)));

  // 清單過期＝那顆修好了、或已經被移出候選表 ⇒ 這一行也要刪掉，否則清單會慢慢變成謊言
  const stale = KNOWN_MISSING.filter((tag) => !missing.some(([t]) => t === tag));

  if (registered.length) {
    console.log(`\n⚠️  已登記待修 ${registered.length} 顆（不影響退出碼，但它們現在確實讀不到值）：`);
    for (const [tag, r] of registered) console.log(`   ・${tag}（用於 ${r.metrics.join('／')}）`);
  }
  if (stale.length) {
    console.error('\n❌ KNOWN_MISSING 已過期，請把這幾行從清單刪掉：');
    for (const tag of stale) console.error(`   ・${tag}`);
    process.exit(1);
  }
  if (fresh.length) {
    console.error(`\n❌ 新冒出 ${fresh.length} 顆查無此元素（永遠匹配不到，畫面會靜靜留空）：`);
    for (const [tag, r] of fresh) console.error(`   ・${tag}（用於 ${r.metrics.join('／')}）`);
    process.exit(1);
  }
  console.log('\n✅ 沒有新的查無此元素。');
}

if (isMainModule(import.meta.url)) {
  await main();
}
