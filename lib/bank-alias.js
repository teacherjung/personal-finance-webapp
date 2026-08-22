// @ts-check
// 機構名正規化（Stage 4，William 2026-08-20 排定「機構名別名對照表」；純模組、零 IO）。
//
// 為什麼需要：同一家銀行在不同來源的寫法不一樣——內建範本寫「台新」、AI 路線照帳單抬頭抄
// （「台新國際商業銀行」「台新銀行」「Taishin Bank」）、配方產線又照 AI 當時的答案。機構名進了
// 三個地方：去重鍵 `bank2|機構|…`、帳戶的開戶機構戳 `account.bank`、疑似重複的索引鍵。
// 寫法不一致的後果各自不同、都會說謊：
//   ・去重鍵不同 ⇒ 同一份帳單換一條路線重匯＝認不出重複＝**現金流翻倍**；
//   ・機構戳不同 ⇒ matchAccount 把同一顆帳戶當成「他行」而拒配 ⇒ **裂戶**（第二顆「台新 8791」）；
//   ・台新走 AI 路線時抄成「台新銀行」⇒ 去重鍵走 `bank2|` 新格式、與內建範本的 `bank|` 祖父格式**對不上**。
// 解法＝所有路線在入口把機構名壓成同一個短名（`canonicalBank`），既有資料靠**比對時兩邊都正規化**
// 認親（祖父條款：存好的去重鍵與機構戳一個位元組不改）。
//
// ⚠️ 誠實劃界（兩條，都刻意）：
//   ①只做「剝通用後綴＋查別名表＋臺→台」，**不做同義詞猜測**——把兩家銀行說成同一家是會說謊的方向，
//     寧可漏合併（兩個短名並存、使用者看得出來）也不亂合併（餘額蓋到別家帳戶）。
//   ②別名表是種子、非窮舉：只收「剝掉後綴仍對不上」的寫法（英文名、暱稱、臺／台）；新寫法由使用者
//     貼帳單抬頭後加，不憑想像補。

/** 可以剝掉、剝掉後**身分不變**的通用後綴（由長到短，長的先剝才不會留殘尾）。
 * ⚠️ 刻意**不含**「證券」「人壽」「投信」：那些是不同實體（台新證券≠台新銀行），剝掉＝把兩家併成一家。
 * 這張表與 parse-recipe.js 的 GENERIC_FI 回答的是**不同問題**（那邊問「是不是只剩通用詞」、要寬；
 * 這邊問「剝掉會不會變別家」、要窄），所以是兩張表、不是漂掉的複本。 */
const STRIP_SUFFIXES = ['股份有限公司', '有限公司', '國際商業銀行', '商業儲蓄銀行', '商業銀行', '儲蓄銀行', '信用合作社', '信合社', '商銀', '銀行'];

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
  line: 'LINE Bank',
  郵局: '中華郵政', chunghwapost: '中華郵政',
  bankoftaiwan: '台灣銀行', 台銀: '台灣銀行', 台灣: '台灣銀行',
  // 剝掉「商業儲蓄銀行」只剩城市名的，補回慣用短名（顯示用；不補就變成「上海」）
  上海: '上海商銀',
});

/** 英文的通用後綴（同 STRIP_SUFFIXES 的中文版；大小寫不拘、只認結尾）。 */
const STRIP_SUFFIXES_EN = /\s+(international\s+)?(commercial\s+)?bank$/i;

/** 去掉分段符（去重鍵用 `|` 分段，同 bankRefBase／normalizeAiBank）、NFKC、壓空白、臺→台。 @param {string} raw */
function baseForm(raw) {
  return String(raw || '').normalize('NFKC').replace(/\|/g, '').replace(/\s+/g, ' ').trim().replace(/臺/g, '台');
}

/** 別名表的比對形：去空白與常見標點（含英文縮寫裡的點）、小寫。 @param {string} s */
function lookupKey(s) {
  return s.replace(/[\s,，、.()（）\-_/／]/g, '').toLowerCase();
}

/**
 * 機構名 → 正規短名。空輸入回 ''（呼叫端自己決定缺席語意，這裡不補預設）。
 * 順序：①基本形 ②剝通用後綴（重複剝到剝不動）③查別名表。
 * 剝到空字串（輸入只有「銀行」之類）＝回**剝之前**的形——「銀行」不是任何一家，但也不可回空讓呼叫端以為缺席。
 * @param {string} raw @returns {string}
 */
export function canonicalBank(raw) {
  const base = baseForm(raw);
  if (!base) return '';
  let core = base;
  for (;;) {
    const before = core;
    for (const suf of STRIP_SUFFIXES) if (core.endsWith(suf)) { core = core.slice(0, -suf.length).trim(); break; }
    core = core.replace(STRIP_SUFFIXES_EN, '').trim();
    if (core === before) break;
  }
  if (!core) return base;
  return ALIASES[lookupKey(core)] || core;
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
  return inst === '台新' ? `bank|${rest}` : `bank2|${inst}|${rest}`;
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
