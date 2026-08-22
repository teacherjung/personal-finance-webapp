// @ts-check
// 機構名正規化（Stage 4，William 2026-08-20 排定「機構名別名對照表」；純模組、零 IO）。
//
// 為什麼需要：同一家銀行在不同來源的寫法不一樣——內建範本寫「台新」、AI 路線照帳單抬頭抄
// （「台新國際商業銀行」「台新銀行」「Taishin Bank」）、配方產線又照 AI 當時的答案。機構名進了
// 去重鍵 `bank2|機構|…`、帳戶的開戶機構戳 `account.bank`、定存身分鍵 `cdKey` 的機構段、疑似重複的索引鍵。
// 寫法不一致的後果各自不同、都會說謊：
//   ・去重鍵不同 ⇒ 同一份帳單換一條路線重匯＝認不出重複＝**現金流翻倍**；
//   ・機構戳不同 ⇒ matchAccount 把同一顆帳戶當成「他行」而拒配 ⇒ **裂戶**（第二顆「台新 8791」）；
//   ・cdKey 機構段不同 ⇒ 每期多建一戶定存、到期歸零找不到它；
//   ・台新走 AI 路線時抄成「台新銀行」⇒ 去重鍵走 `bank2|` 新格式、與內建範本的 `bank|` 祖父格式**對不上**。
// 解法＝所有路線在入口把機構名壓成同一個短名（`canonicalBank`），既有資料靠**比對時兩邊都正規化**
// 認親（祖父條款：存好的去重鍵與機構戳一個位元組不改）。
//
// ⚠️ 誠實劃界（兩條，都刻意）：
//   ①**白名單制**：銀行後綴只在「剝完落在已知機構短名（KNOWN_SHORT）或別名表」時才算剝成功；不在名單上的機構
//     整串原樣。**不做同義詞猜測**——把兩家銀行說成同一家是會說謊的方向，寧可漏合併（兩個短名並存、使用者看得出來）
//     也不亂合併（餘額蓋到別家帳戶）。白名單外的機構只會漏合併、不可能亂合併。
//   ②白名單與別名表都是種子、非窮舉：新機構由使用者貼帳單抬頭後加，不憑想像補。

/** 銀行後綴（由長到短，長的先剝才不會留殘尾）——**只是試剝的候選**，剝完要落在 KNOWN_SHORT 或別名表才算數。
 * ⚠️ 刻意**不含**「證券」「人壽」「投信」：那些是不同實體（台新證券≠台新銀行），剝掉＝把兩家併成一家。
 * ⚠️ 也**不含**「儲蓄銀行／商業儲蓄銀行」：台灣只有「上海商業儲蓄銀行」用它，它的短名就是全名（不在白名單＝不剝）。
 * 這張表與 parse-recipe.js 的 GENERIC_FI 回答的是**不同問題**（那邊問「是不是只剩通用詞」、要寬；
 * 這邊問「剝掉會不會變別家」、要窄），所以是兩張表、不是漂掉的複本。 */
const COMPANY_SUFFIXES = ['股份有限公司', '有限公司'];   // 公司型態字：從不帶身分，一律先剝（「中國銀行股份有限公司」＝中國銀行）
const STRIP_SUFFIXES = ['國際商業銀行', '商業銀行', '信用合作社', '信合社', '商銀', '銀行'];

/** 查表一律 Object.hasOwn（鐵則 3.5：機構名是外部文字——AI 抄的、備份帶的——`__proto__`／`constructor` 這種鍵
 * 直接 `obj[key]` 會撈到原型上的東西，下游 `.toLowerCase()` 就炸）。 @param {Record<string,string>} table @param {string} key */
const lookup = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** 縮寫 → 全名（先於剝銀行後綴查：「上海商銀」不在白名單、剝掉「商銀」也到不了任何已知短名，要靠這裡對回去）。 */
const ABBREV = /** @type {Record<string, string>} */ ({ 上海商銀: '上海商業儲蓄銀行' });

/** 別名表：鍵＝正規化比對形（NFKC、去空白與標點、小寫）；值＝正規短名。
 * 只收「剝掉後綴仍對不上」的寫法；中文短名本身不必列（剝後綴就到位）。 */
const ALIASES = /** @type {Record<string, string>} */ ({
  // ⚠️ 鍵是**剝完通用後綴之後**的形（「Taishin Bank」先剝成「Taishin」再查）——所以不列帶 bank 的寫法。
  // 台新（內建範本的祖父身分——所有寫法都要壓回這兩個字，去重鍵才會走 `bank|` 舊格式）
  taishin: '台新', richart: '台新',
  // 其他常見機構的英文寫法／暱稱
  cathayunited: '國泰世華',
  esun: '玉山',
  ctbc: '中國信託', chinatrust: '中國信託', 中信: '中國信託',
  fubon: '台北富邦', taipeifubon: '台北富邦', 北富銀: '台北富邦',
  mega: '兆豐',
  first: '第一', 一銀: '第一',
  huanan: '華南',
  sinopac: '永豐', banksinopac: '永豐',
  合庫: '合作金庫',
  花蓮第二: '花蓮二信',   // 法定名「花蓮第二信用合作社」與官方自稱「花蓮二信」是同一家
  line: 'LINE Bank',
  郵局: '中華郵政', chunghwapost: '中華郵政',
  bankoftaiwan: '台灣銀行', 台銀: '台灣銀行',   // 裸「台灣」刻意**不**列：地名不是機構
  hsbc: '滙豐', 匯豐: '滙豐',
});

/** 英文的通用後綴（大小寫不拘、只認結尾）：[0]＝公司型態字（Co., Ltd.／Limited／Inc.；一律剝）、[1]＝銀行字樣（試剝、
 * 只有剝到白名單才採用）——「Taishin Bank Co., Ltd.」要剝兩輪才到「Taishin」（Codex #499 r2#1）。 */
const STRIP_SUFFIXES_EN = [/(?:^|[\s,])+(co\.?,?\s*ltd\.?|ltd\.?|limited|inc\.?|corp\.?|corporation)\s*$/i, /\s+(international\s+)?(commercial\s+)?bank$/i];   // 公司字前面一定要有空白或逗號＝整個詞才剝（「Vinc」「Bancorp」的尾巴不是公司字）

/** **已知機構短名**（白名單）：剝銀行後綴後的核心**只有落在這裡**（或別名表的值）才算剝成功；否則整串留著不剝。
 * 為什麼改成白名單（Codex #499 r1–r5 連五輪找到不同的亂合併反例：三家上海、中國銀行 vs 中國國際商業銀行、城市名銀行、
 * 日本樂天銀行 vs 台灣樂天國際商業銀行——每一例都是「剝完剛好撞成同一個字串」）：黑名單補不完、白名單補得完。
 * 不在名單上的機構（外商、小型信合社）＝整串原樣＝同一家的兩種寫法會並存（漏合併，看得出來、可事後加進來），
 * 但**兩家不可能被壓成一家**（亂合併，會蓋餘額）。名單＝台灣常見銀行的慣用短名；新機構由使用者貼抬頭後加。
 * ⚠️ 不含地名本身（高雄銀行的短名就是「高雄銀行」）、不含「樂天」（日本樂天銀行與台灣樂天國際商業銀行是兩家）。 */
const KNOWN_SHORT = new Set([
  '台新', '國泰世華', '玉山', '中國信託', '台北富邦', '兆豐', '第一', '華南', '永豐', '合作金庫', '中華郵政', '台灣銀行',
  'LINE Bank', '凱基', '元大', '土地銀行', '華泰', '陽信', '板信', '聯邦', '遠東', '王道', '將來', '星展', '滙豐', '渣打', '花旗',
  '日盛', '安泰', '新光', '台灣企銀', '京城', '三信', '瑞興', '富邦', '花蓮二信', '台中商業銀行', '高雄銀行', '彰化商業銀行',
]);

/** 去掉分段符（去重鍵用 `|` 分段，同 bankRefBase／normalizeAiBank）、NFKC、壓空白、臺→台。 @param {string} raw */
function baseForm(raw) {
  return String(raw || '').normalize('NFKC').replace(/\|/g, '').replace(/\s+/g, ' ').trim().replace(/臺/g, '台');
}

/** 別名表的比對形：去空白與常見標點（含英文縮寫裡的點）、小寫。 @param {string} s */
function lookupKey(s) {
  return s.replace(/[\s,，、.()（）\-_/／]/g, '').toLowerCase();
}

/** 純拉丁字母名摺疊成大寫當比對形（同一家的「HSBC」「hsbc」不可被當兩家）。 @param {string} s */
function foldLatin(s) { return /^[A-Za-z0-9 .&'-]+$/.test(s) ? s.toUpperCase() : s; }

/**
 * 剝後綴的核心（正式路徑的中段）。回 { base, legal, hit, key }：
 *   base＝基本形；legal＝剝掉公司型態字之後的形（公司字從不帶身分，一律剝）；
 *   hit＝已經決定的答案（縮寫／剝到白名單或別名）；key＝最後一次去查別名表的鍵（接縫用）。
 * 剝銀行後綴是**試剝**：每剝一層就看核心是不是白名單短名或別名表的鍵，是就採用；剝到底都不是＝放棄剝，回 legal。
 * @param {string} raw */
function stripCore(raw) {
  const base = baseForm(raw);
  if (!base) return { base, legal: '', hit: '', key: '' };
  let legal = base;
  for (let again = true; again;) {
    again = false;
    for (const suf of COMPANY_SUFFIXES) if (legal.endsWith(suf)) { legal = legal.slice(0, -suf.length).trim(); again = true; break; }
    if (!again) { const t = legal.replace(STRIP_SUFFIXES_EN[0], '').trim(); if (t && t !== legal) { legal = t; again = true; } }
  }
  if (!legal) return { base, legal: base, hit: base, key: '' };
  const abbr = lookup(ABBREV, legal);
  if (abbr) return { base, legal, hit: abbr, key: '' };
  let core = legal, key = lookupKey(legal);
  for (;;) {
    const direct = KNOWN_SHORT.has(core) ? core : lookup(ALIASES, lookupKey(core));
    if (direct) return { base, legal, hit: direct, key: lookupKey(core) };
    let next = core;
    for (const suf of STRIP_SUFFIXES) if (next.endsWith(suf)) { next = next.slice(0, -suf.length).trim(); break; }
    if (next === core) next = next.replace(STRIP_SUFFIXES_EN[1], '').trim();
    if (next === core || !next) break;
    core = next; key = lookupKey(core);
  }
  return { base, legal, hit: '', key };
}

/**
 * 機構名 → 正規短名。空輸入回 ''（呼叫端自己決定缺席語意，這裡不補預設）。
 * 順序：①基本形 ②公司型態字一律剝 ③縮寫表（整串比對）④銀行後綴**試剝**：每剝一層看核心是不是白名單短名
 * 或別名表的鍵，是就採用；剝到底都不是＝放棄剝、回②的形 ⑤純拉丁字母名摺疊成大寫。
 * 「銀行」之類只剩通用詞的輸入＝回原形——它不是任何一家，但也不可回空讓呼叫端以為缺席。
 * @param {string} raw @returns {string}
 */
export function canonicalBank(raw) {
  const { base, legal, hit } = stripCore(raw);
  if (!base) return '';
  if (hit) return hit;
  return foldLatin(legal);   // 剝不到已知短名＝整串（去掉公司字）原樣：漏合併的方向，不是亂合併
}

/** 兩個機構名是不是同一家（兩邊都正規化後相等）。空字串與任何名字都**不**同家——缺席的語意由呼叫端決定。
 * @param {string} a @param {string} b */
export function sameBank(a, b) {
  const ca = canonicalBank(a), cb = canonicalBank(b);
  return ca !== '' && ca === cb;
}

/** 去重鍵的**比對形**（祖父條款的核心）：存好的去重鍵一個位元組不改，比對時把機構段壓成正規短名——
 * 正規短名是台新就改寫成 `bank|` 舊格式（內建範本一直都這樣拼），否則 `bank2|正規短名|…`。
 * 只在 `existing` 集合的建立與查詢兩端各過一次；舊格式 `bank|…` 與不認得的形狀原樣回。
 * @param {string} ref */
export function canonRef(ref) {
  const s = String(ref || '');
  if (!s.startsWith('bank2|')) return s;
  const i = s.indexOf('|', 6);
  if (i < 0) return s;
  const inst = canonicalBank(s.slice(6, i));
  const rest = s.slice(i + 1);
  // 台新改寫成 `bank|` 只在帳號段**真的是遮罩帳號**（含星號）時做：`bank|<純末碼>|…` 是更早的末碼祖父鍵
  // （bankRefLegacy）的命名空間，`bank2|台新|3301|…` 這種帳號段沒星號的列改寫過去會冒充它、把同末碼不同前綴的
  // 真交易吞成重複（Codex #499 r1#2）。內建範本與 AI 路線的台新列帳號段一律帶星號，所以正常資料都走得到改寫。
  const j = rest.indexOf('|');
  const acct = j < 0 ? rest : rest.slice(0, j);
  return (inst === '台新' && /[*＊]/.test(acct)) ? `bank|${rest}` : `bank2|${inst}|${rest}`;
}

/** 定存身分鍵 `機構|末碼|幣別|起迄日|金額|#序` 的**比對形**：只把第一段（機構）壓成正規短名，其餘原樣。
 * 與 canonRef 同一個祖父條款：存好的 cdKey 不改，比對時兩邊都過這裡——舊戶的「第一銀行|…」與
 * 新一期算出的「第一|…」要認得出是同一筆定存（認不出＝每期多建一戶、到期歸零也找不到它）。
 * @param {string} key */
export function canonCdKey(key) {
  const s = String(key || '');
  const i = s.indexOf('|');
  if (i < 0) return s;
  return `${canonicalBank(s.slice(0, i)) || s.slice(0, i)}|${s.slice(i + 1)}`;
}

/** 測試接縫：別名表的每一條（鍵＝比對形、值＝短名）＋「某個寫法在正式路徑上會去查表的那把鍵」——
 * 讓「別名表每一條都有考題」變成機械保證（鍵要**精確相等**，不是前綴／後綴包含：Codex #499 r4#1 用 `taiwan`
 * 被 `bankoftaiwan` 誤認為已覆蓋證明了包含判定會假綠）。正式呼叫端不用。 */
export function aliasEntriesForTest() {
  return {
    entries: Object.entries(ALIASES),
    /** 正式路徑最後去查別名表的那把鍵；中途命中縮寫或白名單＝回 hit 前那把鍵（仍是正式路徑算出來的）。 @param {string} raw */
    lookupKeyOf: (raw) => stripCore(raw).key,
  };
}
