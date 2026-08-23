// @ts-check
// 機構名正規化（Stage 4，William 2026-08-20 排定「機構名別名對照表：台新／台新銀行／TAISHIN → 同一代碼」；純模組、零 IO）。
//
// 為什麼需要：內建範本寫「台新」、AI 路線照帳單抬頭抄（「台新國際商業銀行」「台新銀行」「Taishin Bank」）。機構名進了
// 去重鍵 `bank2|機構|…`、帳戶的開戶機構戳 `account.bank`、定存身分鍵 `cdKey` 的機構段、疑似重複的索引鍵。
// 寫法不一致的後果各自不同、都會說謊：
//   ・去重鍵不同 ⇒ 同一份帳單換一條路線重匯＝認不出重複＝**現金流翻倍**；
//   ・機構戳不同 ⇒ matchAccount 把同一顆帳戶當成「他行」而拒配 ⇒ **裂戶**（第二顆「台新 8791」）；
//   ・cdKey 機構段不同 ⇒ 每期多建一戶定存、到期歸零找不到它；
//   ・台新走 AI 路線時抄成「台新銀行」⇒ 去重鍵走 `bank2|` 新格式、與內建範本的 `bank|` 祖父格式**對不上**。
// 解法＝所有路線在入口把機構名壓成同一個短名（`canonicalBank`），既有資料靠**比對時兩邊都正規化**
// 認親（祖父條款：存好的去重鍵與機構戳一個位元組不改）。
//
// ⚠️ 誠實劃界——**只認得台新**，其餘機構只做「去公司型態字＋字元正規化」：
//   把「寫法不同」壓成「同一家」的任何通用規則（剝銀行後綴、英文別名）都會在某一對**共用品牌的不同法人**上撞成
//   同一個字串（#499 審查六輪各找到一對：三家上海、中國銀行 vs 中國國際商業銀行、城市名銀行、日本樂天 vs 台灣樂天、
//   中信銀行 vs 中國信託、富邦香港 vs 台北富邦）。撞了＝餘額蓋到別家帳戶、真交易被當重複吞掉，不可逆。
//   所以身分這把尺只處理內建範本的祖父身分「台新」（它的所有寫法非壓回兩個字不可，否則去重鍵格式就對不上）；
//   其他機構兩種寫法並存＝漏合併，看得出來、**維持原形**；**疑似重複的提醒**另有一把寬鬆的尺（bank-import.js instKey），
//   那只是提醒、不動錢。要讓第二家進身分這把尺＝另案裁決（先過考題的「兩兩不同」表），本模組刻意不留別名表。

/** 公司型態字：從不帶身分，一律剝（「台新國際商業銀行股份有限公司」「Taishin Bank Co., Ltd.」）。 */
const COMPANY_SUFFIXES = ['股份有限公司', '有限公司'];
const COMPANY_SUFFIX_EN = /(?:^|[\s,])+(co\.?,?\s*ltd\.?|ltd\.?|limited|inc\.?|corp\.?|corporation)\s*$/i;   // 前面要有空白或逗號＝整個詞才剝（「Vinc」「Bancorp」的尾巴不是公司字）
/** 銀行字樣——**只用來認台新**：剝完剛好等於台新的身分鍵才採用，其他機構不剝（剝了會撞）。 */
const BANK_SUFFIXES = ['國際商業銀行', '商業銀行', '商銀', '銀行'];
const BANK_SUFFIX_EN = /\s+(international\s+)?(commercial\s+)?bank$/i;

/** 台新的身分鍵（剝完公司字與銀行字樣後的比對形：小寫、去空白與標點）。只有這幾把。 */
const TAISHIN_KEYS = new Set(['台新', 'taishin', 'richart']);
const TAISHIN = '台新';

/** 去掉分段符（去重鍵用 `|` 分段，同 bankRefBase／normalizeAiBank）、NFKC、壓空白、臺→台。 @param {string} raw */
function baseForm(raw) {
  return String(raw || '').normalize('NFKC').replace(/\|/g, '').replace(/\s+/g, ' ').trim().replace(/臺/g, '台');
}
/** 比對形：去空白與常見標點（含英文縮寫裡的點）、小寫。 @param {string} s */
function lookupKey(s) { return s.replace(/[\s,，、.()（）\-_/／]/g, '').toLowerCase(); }
/** 純拉丁字母名摺疊成大寫當比對形（同一家的「HSBC」「hsbc」不可被當兩家）。 @param {string} s */
function foldLatin(s) { return /^[A-Za-z0-9 .&'-]+$/.test(s) ? s.toUpperCase() : s; }

/** 剝公司型態字（中英、重複到剝不動）。 @param {string} s */
function stripCompany(s) {
  let out = s;
  for (let again = true; again;) {
    again = false;
    for (const suf of COMPANY_SUFFIXES) if (out.endsWith(suf)) { out = out.slice(0, -suf.length).trim(); again = true; break; }
    if (!again) { const t = out.replace(COMPANY_SUFFIX_EN, '').trim(); if (t && t !== out) { out = t; again = true; } }
  }
  return out || s;
}

/** 剝一層銀行字樣；剝不動回原字串。 @param {string} s */
function stripBankOnce(s) {
  for (const suf of BANK_SUFFIXES) if (s.endsWith(suf)) return s.slice(0, -suf.length).trim();
  return s.replace(BANK_SUFFIX_EN, '').trim();
}

/**
 * 機構名 → 正規短名。空輸入回 ''（呼叫端自己決定缺席語意，這裡不補預設）。
 * ①基本形 ②剝公司型態字 ③逐層剝銀行字樣、每層看是不是台新的身分鍵——是就回「台新」；剝到底都不是＝回②的形
 * （純拉丁字母名摺疊成大寫）。所以「台新證券」→「台新證券」（證券不是銀行字樣）、「玉山商業銀行」→「玉山商業銀行」
 * （不剝：玉山不是台新）、「銀行」→「銀行」（它不是任何一家，但也不可回空讓呼叫端以為缺席）。
 * @param {string} raw @returns {string}
 */
export function canonicalBank(raw) {
  const base = baseForm(raw);
  if (!base) return '';
  const legal = stripCompany(base);
  let core = legal;
  for (;;) {
    if (TAISHIN_KEYS.has(lookupKey(core))) return TAISHIN;
    const next = stripBankOnce(core);
    if (next === core || !next) break;
    core = next;
  }
  return foldLatin(legal);
}

/** 兩個機構名是不是同一家（兩邊都正規化後相等）。空字串與任何名字都**不**同家——缺席的語意由呼叫端決定。
 * @param {string} a @param {string} b */
export function sameBank(a, b) {
  const ca = canonicalBank(a), cb = canonicalBank(b);
  return ca !== '' && ca === cb;
}

/** 去重鍵的**比對形**（祖父條款的核心）：存好的去重鍵一個位元組不改，比對時把機構段壓成正規短名——
 * 正規短名是台新就改寫成 `bank|` 舊格式（內建範本一直都這樣拼），否則 `bank2|正規短名|…`。
 * 只在 `existing` 集合的建立端過一次；舊格式 `bank|…` 與不認得的形狀原樣回。
 * @param {string} ref */
export function canonRef(ref) {
  const s = String(ref || '');
  if (!s.startsWith('bank2|')) return s;
  const i = s.indexOf('|', 6);
  if (i < 0) return s;
  const inst = canonicalBank(s.slice(6, i));
  const rest = s.slice(i + 1);
  // 台新改寫成 `bank|` 只在帳號段**真的是遮罩帳號**（含星號）時做：`bank|純末碼|…` 是更早的末碼祖父鍵
  // （bankRefLegacy）的命名空間，`bank2|台新|3301|…` 這種帳號段沒星號的列改寫過去會冒充它、把同末碼不同前綴的
  // 真交易吞成重複（Codex #499 r1#2）。內建範本的台新列帳號段一律帶星號（含沒遮罩時自己補的 `x****末碼`）；
  // AI 路線「帳單本來就沒遮」的完整帳號（至少五碼、無星號）由 bankRefBase 直接寫成 `bank|完整號|…`，不經這裡改寫，
  // 也撞不到末碼祖父鍵（那是 3～4 碼）。
  const j = rest.indexOf('|');
  const acct = j < 0 ? rest : rest.slice(0, j);
  return (inst === TAISHIN && /[*＊]/.test(acct)) ? `bank|${rest}` : `bank2|${inst}|${rest}`;
}

/** 定存身分鍵 `機構|末碼|幣別|起迄日|金額|#序` 的**比對形**：只把第一段（機構）壓成正規短名，其餘原樣。
 * 與 canonRef 同一個祖父條款：存好的 cdKey 不改，比對時兩邊都過這裡。 @param {string} key */
export function canonCdKey(key) {
  const s = String(key || '');
  const i = s.indexOf('|');
  if (i < 0) return s;
  return `${canonicalBank(s.slice(0, i)) || s.slice(0, i)}|${s.slice(i + 1)}`;
}

/** **疑似重複提醒**用的寬鬆比對鍵（只給 bank-import.js 的 similarTxIndex／similarKey；**不碰身分**）：
 * 先過 canonicalBank，再套機構維度之前那把既有的啟發式（去公司型態字、剝結尾的「（國際）（商業）銀行」、小寫）——
 * 「台中銀行」「台中商業銀行」在這裡算同一家，在身分那把尺上仍是兩個短名。提醒猜錯的代價只是多問使用者一句
 * （預設勾跳過、可取消），不動錢；身分猜錯的代價是蓋餘額、吞交易。兩把尺刻意不同。 @param {string} bank */
export function looseBankKey(bank) {
  return canonicalBank(bank).toLowerCase()
    .replace(/股份有限公司|有限公司/g, '')
    .replace(/(國際)?(商業)?銀行$/, '')
    .trim();
}
