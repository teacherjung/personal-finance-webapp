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
 * ## 退出碼
 *
 *   0  沒有新問題
 *   1  查核**發現**：新的 MISSING，或 KNOWN_MISSING 已過期
 *   2  用法錯誤（沒設 SEC_USER_AGENT）
 *   3  對照組不符＝這支自己壞了，結果不可信
 *   4  作業失敗（網路／解析）——**與「發現」分開**，才不會把「查不動」誤讀成「查過了沒事」
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

/**
 * 官方 taxonomy **每一版都查，不抽樣**（2011–2026 全部）。
 * ⚠️ 檔名有兩種：2022 起是 `us-gaap-<年>.xsd`，2021 以前是 `us-gaap-<年>-01-31.xsd`。
 * 〔r1 修：原本只挑 2015／2017／2019／2021 四版當「抽樣」，卻在註解與契約寫成
 *   「2015–2026 都查」——射程不足還講得比實際寬。漏版的代價是實際存在於漏掉那一版的
 *   歷史 tag 會被誤判成 MISSING，所以改成全查。〕
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

/**
 * frames API 的 unit 路徑段。⚠️ 與 Company Facts 內部的寫法**不一樣**：
 * 每股在 facts 裡是 `USD/shares`，在 frames 的網址裡是 `USD-per-shares`。
 * 〔r1 修：原本三種 unitKind 一律查 `/USD/`，per-share 與 shares 因此永遠 404。
 *   目前那兩顆都查得到 taxonomy 所以走不到 SEC，但只要哪天有一顆每股類的 tag 被停用，
 *   就會被誤判成 MISSING。〕
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
 *
 * ⚠️ `secProbe` 是**正向探針**：強迫真的去問一次 SEC，而且必須拿回非空資料。
 * 〔r1 修：原本三顆對照組裡，taxonomy 查得到的兩顆根本不問 SEC，唯一問 SEC 的那顆
 *   又「預期七次都 404」——所以整站 404（網址搬家、路由錯）時這支照樣宣稱「結果可信」。〕
 */
const CONTROLS = /** @type {const} */ ([
  { tag: 'LongTermDebtNoncurrent', expect: 'live' },
  { tag: 'SalesRevenueNet', expect: 'deprecated' },
  { tag: 'LongTermDebtAndFinanceLeaseObligationsNoncurrent', expect: 'MISSING' }
]);

/** 正向 SEC 探針：這顆在這個期間必定有一大票申報，查回來是空的＝SEC 那半沒在運作。 */
const SEC_PROBE = /** @type {const} */ ({
  tag: 'LongTermDebtNoncurrent', unitKind: 'currency', frame: 'CY2024Q4I', minFacts: 100
});

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
 *
 * ⚠️ **它是永久 allowlist，沒有到期日**（Codex r1 提醒）：「未過期」只代表那顆還壞著，
 * 不代表有人在處理。真正的追蹤在 PR #546 描述與另開的那一支，不要把這份清單當待辦系統。
 */
const KNOWN_MISSING = /** @type {const} */ ([
  'PaymentsForAdditionsToPropertyPlantAndEquipment',
  'PaymentsForRepurchaseOfCommonAndPreferredStock'
]);

const CACHE_DIR = join(tmpdir(), 'us-gaap-taxonomy-cache');

/** 作業失敗（網路／解析）——與「查核發現」分開，見檔頭退出碼表。 */
class OperationalError extends Error {}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} url @param {string} userAgent */
async function fetchText(url, userAgent) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new OperationalError(`GET ${url} → HTTP ${res.status}`);
  return await res.text();
}

/**
 * 下載（並快取）一份 taxonomy，回傳它宣告的元素名集合。
 * @param {number} year @param {string} userAgent @returns {Promise<Set<string>>}
 */
async function loadTaxonomyNames(year, userAgent) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = taxonomyFile(year);
  const cached = join(CACHE_DIR, file);
  let xml;
  if (existsSync(cached)) {
    xml = readFileSync(cached, 'utf8');
  } else {
    xml = await fetchText(`https://xbrl.fasb.org/us-gaap/${year}/elts/${file}`, userAgent);
    writeFileSync(cached, xml);
  }
  // ⚠️ 兩種引號都要收：多數年份的屬性用單引號（`name='Revenues'`），但**官方 2018 版用雙引號**。
  // 〔r1 修：原本只認單引號，還在註解寫「官方 XSD 用單引號」——2018 版當場推翻它。
  //   當時 2018 沒被查所以沒炸，等於那句保證從來沒被驗過。〕
  const names = new Set(
    [...xml.matchAll(/name=(['"])([A-Za-z][A-Za-z0-9]*)\1/g)].map((m) => m[2])
  );
  if (names.size < 5000) {
    throw new OperationalError(
      `${file} 只解析出 ${names.size} 個元素，遠少於官方規模——解析壞了，不要相信這次結果`
    );
  }
  return names;
}

/**
 * 問 SEC 一個 frame 有幾筆事實。404＝這個期間沒資料（正常），其他非 200＝作業失敗。
 * @param {string} tag @param {string} unit @param {string} frame @param {string} userAgent
 */
async function fetchFrameCount(tag, unit, frame, userAgent) {
  const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/${unit}/${frame}.json`;
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (res.status === 404) return 0;
  if (!res.ok) throw new OperationalError(`GET ${url} → HTTP ${res.status}`);
  const body = /** @type {any} */ (await res.json());
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
 * 〔r1 修：原本只按 tag 名豁免，Codex 實測把假 tag 放回候選表 ⇒ 印出 MISSING 卻仍 exit 0。〕
 * @param {Set<string>} candidateTags
 * @returns {Set<string>}
 */
export function controlOnlyExemptions(candidateTags) {
  return new Set(
    CONTROLS
      .filter((c) => c.expect === 'MISSING' && !candidateTags.has(c.tag))
      .map((c) => /** @type {string} */ (c.tag))
  );
}

async function main() {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) {
    console.error('請先設定 SEC_USER_AGENT（SEC 要求 User-Agent 帶聯絡方式）。例如：');
    console.error("  SEC_USER_AGENT='Your Name your@email' node scripts/verify-us-gaap-tags.js");
    process.exit(2);
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
  console.log('\n對照組全部符合預期、SEC 探針有回資料＝這支確實查得動，結果可信。');

  const missing = [...results].filter(([tag, r]) => r.status === 'MISSING' && !exempt.has(tag));
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
