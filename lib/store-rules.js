// @ts-check
// 店名規則「資料化」（第三帖，使用者定 2026-07-19）——純模組、零相依（不 import repo/statement，避免循環）。
//
// 病根：店名規則（哪些寫法算同一家店、品牌標準名、連鎖分店切法…）全寫死在 lib/statement.js。
// 使用者每發現一條要改，就得等 Claude 改程式→開 PR→合併→重啟。帳務體檢的鑰匙類問題
//（D1 前綴鑰匙對／D2 鑰匙吃錯店／D6 簽名相同／D7 分期分裂）因此只能「複製回報貼給 Claude」。
// 這裡把規則搬成**使用者可編輯的資料**（存 settings.storeRules），讓使用者自己加一條就生效。
//
// 三個設計決定（都為了「沒有程式背景也能安全使用」）：
// ① **不給正規表示式**：使用者填的是「純文字」＋比對方式（包含／開頭是／完全等於），
//    這裡負責跳脫成安全的 RegExp。使用者不可能寫出 `.*` 這種吃掉整個字串的樣式。
// ② **使用者規則排在內建規則前面**（優先）：自助的意義就是「內建判錯時我能蓋過它」。
//    代價＝一條寫太寬的規則會蓋掉內建的細緻判斷 → 用「套用前的全庫影響預覽」把關（見服務層）。
// ③ **分類規則（CATEGORY_RULES）刻意不開放**：`storeKeyOf` 會用 `categorize(原文)` 判「油錢→加油站」，
//    分類規則可編輯的話，改一條分類就會讓身分鑰匙漂移、既有學習全部對不上。
//    **鑰匙的判定基礎凍結在內建規則**——這是第三帖的核心不變量（考題鎖住）。
//    使用者要改分類仍走既有的「同店一起改」（學習表），那條路不動鑰匙。

/** 規則種類的中繼資料（UI 產生表單、驗證共用；改這裡＝前後端一起變）。 */
export const RULE_KINDS = {
  canon: { label: '這些寫法是同一家店', maxLen: 60, hasMode: true },
  brand: { label: '併回品牌名（保留分店）', maxLen: 60, hasMode: false },
  rename: { label: '顯示名改寫', maxLen: 60, hasMode: false },
  chains: { label: '連鎖店（沒有分隔符也要切分店）', maxLen: 20, hasMode: false },
  parkExempt: { label: '不要包成「停車費（…）」', maxLen: 40, hasMode: false }
};
/** 比對方式（只有 canon 用）。 */
export const MATCH_MODES = ['contains', 'startsWith', 'exact'];
const MAX_ENTRIES = 200;   // 每種規則的條數上限（防呆：手滑貼上大量資料時不至於把每筆交易的清理拖垮）

/** 正規表示式跳脫：使用者填的是純文字，任何符號都只當字面字元。 @param {string} s @returns {string} */
export function escapeRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 繼承自 Object.prototype 的屬性名（`__proto__`／`constructor`／`toString`／`hasOwnProperty`…）。
 * 規則的 `to` 會成為交易的 `storeKey`，而學習表是普通物件——用這些名字當 key 會去碰原型而不是建立鍵，
 * 那條學習就這樣人間蒸發（Codex r3#4 實測：`toString` 可通過驗證，整店改分類回報成功、
 * 交易也真的改了，但學習沒存下來，還把 `Object.prototype.toString.category` 寫了進去）。
 * 只擋三個名字是不夠的——**用 Object.prototype 的完整清單**，反正這些字不可能是真店名。
 * @param {string} s @returns {boolean}
 */
export function isProtoKey(s) {
  return Object.getOwnPropertyNames(Object.prototype).includes(String(s));
}

const str = (/** @type {any} */ v) => (typeof v === 'string' ? v.trim() : '');
const isObj = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * 驗證/清理使用者規則（存進 settings 前、以及櫃檯寫入時都過這裡）。壞條目直接丟棄、不讓它進資料庫。
 * 規則：match/to 都必須是非空字串且不超過長度上限；**`to` 不可為空**——空的取代字串會把店名整個抹掉
 *（BRAND_RENAME 是全域字串取代，`to:''` 等於刪字）。回傳「乾淨的純資料」，形狀與輸入相同。
 * @param {any} raw @param {string[]=} bad 壞條目收集（給呼叫端警告用）
 * @returns {{canon: {match:string,to:string,mode:string}[], brand: {match:string,to:string}[],
 *            rename: {match:string,to:string}[], chains: string[], parkExempt: string[]}}
 */
export function sanitizeStoreRules(raw, bad) {
  const src = isObj(raw) ? raw : {};
  /** @param {string} kind @param {any} list @param {(e:any)=>any} pick */
  const take = (kind, list, pick) => {
    if (!Array.isArray(list)) { if (list !== undefined) bad?.push(`storeRules.${kind}`); return []; }
    const out = [];
    // 位置回報用**輸入的 index**（不是已收下的筆數）——混著好壞條目時，用 out.length 會報錯位置，
    // 而這串字是要拿去跟使用者說「第幾條沒收」的（自審 r3）。
    list.slice(0, MAX_ENTRIES).forEach((e, i) => {
      const v = pick(e);
      if (v) out.push(v); else bad?.push(`storeRules.${kind}[${i}]`);
    });
    // 超過上限的部分要出聲：默默吃掉 50 條規則，使用者只會覺得「怎麼有些沒生效」（自審 r3）
    if (list.length > MAX_ENTRIES) bad?.push(`storeRules.${kind}(超過 ${MAX_ENTRIES} 條上限，多的 ${list.length - MAX_ENTRIES} 條未收)`);
    return out;
  };
  const len = (/** @type {keyof typeof RULE_KINDS} */ k) => RULE_KINDS[k].maxLen;
  // 原型鍵擋掉（自審 r3）：規則的 `to` 會成為交易的 storeKey，而學習表是普通物件——
  // `newLc['__proto__'] = {...}` 不會建立鍵、而是去動原型，那條學習就這樣人間蒸發。
  // 讀取端早有 Object.hasOwn 防線（Codex#7），但這一帖是第一次讓 storeKey 由使用者決定，
  // 寫入端也得擋。這幾個字不可能是真店名，直接拒收最乾淨。
  /** @param {string} s @param {keyof typeof RULE_KINDS} k */
  const okStr = (s, k) => Boolean(s) && s.length <= len(k) && !isProtoKey(s);
  return {
    // rename 是**全域字串取代**且整理會重複執行（每次規則指紋變動、每次開 app 都可能跑），
    // 所以 `to` 不可以再命中自己的 `match`（Codex r3#5）：ABC→台灣ABC 跑第二次會變成
    // 台灣台灣ABC，第三次台灣台灣台灣ABC…名字無限膨脹。這種規則收下來只會害人，直接拒收。
    rename: take('rename', src.rename, (e) => {
      if (!isObj(e)) return null;
      const match = str(e.match), to = str(e.to);
      if (!okStr(match, 'rename') || !okStr(to, 'rename')) return null;
      return to.includes(match) ? null : { match, to };
    }),
    canon: take('canon', src.canon, (e) => {
      if (!isObj(e)) return null;
      const match = str(e.match), to = str(e.to);
      const mode = MATCH_MODES.includes(str(e.mode)) ? str(e.mode) : 'contains';
      return (okStr(match, 'canon') && okStr(to, 'canon')) ? { match, to, mode } : null;
    }),
    brand: take('brand', src.brand, (e) => {
      if (!isObj(e)) return null;
      const match = str(e.match), to = str(e.to);
      return (okStr(match, 'brand') && okStr(to, 'brand')) ? { match, to } : null;
    }),
    chains: take('chains', src.chains, (e) => (okStr(str(e), 'chains') ? str(e) : null)),
    parkExempt: take('parkExempt', src.parkExempt, (e) => (okStr(str(e), 'parkExempt') ? str(e) : null))
  };
}

/**
 * 「寫入端」的嚴格驗證（Codex r3#6）：`sanitizeStoreRules` 是**寬鬆**的（壞的丟掉、繼續跑），
 * 那對「櫃檯／匯入舊備份」是對的——不能讓一條壞規則卡死整個資料庫。
 * 但**使用者按下儲存**這條路完全相反：`saveStoreRules('oops')` 被寬鬆處理的結果是
 * 「當成空物件 → 回報成功 → 把使用者手上全部的規則清空」，一個型別打錯就毀掉所有心血。
 * 所以 API 路徑先過這裡：形狀不對就整包拒絕（400），什麼都不動。
 * 同理，非法的 `mode` 不可默默降成最寬的 `contains`——拼字錯誤會讓規則命中一大票店家。
 * @param {any} raw @returns {string[]} 錯誤訊息（空陣列＝合法）
 */
export function validateStoreRulesStrict(raw) {
  /** @type {string[]} */
  const errs = [];
  if (!isObj(raw)) return ['規則格式不正確（應該是一個物件）'];
  for (const [kind, meta] of Object.entries(RULE_KINDS)) {
    if (!(kind in raw)) continue;
    const list = raw[kind];
    if (!Array.isArray(list)) { errs.push(`「${meta.label}」的內容格式不正確（應該是一個清單）`); continue; }
    if (list.length > MAX_ENTRIES) errs.push(`「${meta.label}」超過 ${MAX_ENTRIES} 條上限（目前 ${list.length} 條）`);
    list.forEach((e, i) => {
      const at = `「${meta.label}」第 ${i + 1} 條`;
      const single = kind === 'chains' || kind === 'parkExempt';
      const vals = single ? [str(e)] : (isObj(e) ? [str(e.match), str(e.to)] : null);
      if (!vals) { errs.push(`${at} 格式不正確`); return; }
      if (vals.some(v => !v)) { errs.push(`${at} 有欄位是空的`); return; }
      if (vals.some(v => v.length > meta.maxLen)) { errs.push(`${at} 超過 ${meta.maxLen} 個字`); return; }
      if (vals.some(isProtoKey)) { errs.push(`${at} 用了系統保留字，請換一個名字`); return; }
      // 非法 mode 要明講，不可默默改成 contains（拼字錯誤會讓規則命中一大票店家）
      if (kind === 'canon' && isObj(e) && e.mode !== undefined && !MATCH_MODES.includes(str(e.mode))) {
        errs.push(`${at} 的比對方式不正確`); return;
      }
      if (kind === 'rename' && isObj(e) && str(e.to).includes(str(e.match))) {
        errs.push(`${at}：改成的名字裡還含有要被取代的字（「${str(e.match)}」→「${str(e.to)}」），`
          + '每整理一次就會多疊一層、名字會愈來愈長。請改成不含原字的寫法。');
      }
    });
  }
  return errs;
}

/**
 * 空規則（沒設定過＝完全走內建規則）。每次回新物件，避免呼叫端改到共用值。
 * @returns {{canon: {match:string,to:string,mode:string}[], brand: {match:string,to:string}[],
 *            rename: {match:string,to:string}[], chains: string[], parkExempt: string[]}}
 */
export function emptyStoreRules() {
  return { canon: [], brand: [], rename: [], chains: [], parkExempt: [] };
}

/**
 * 把純資料規則編譯成 statement.js 吃的形狀（RegExp）。
 * @param {any} raw
 * @returns {{canon: [string, RegExp][], brand: {prefix: RegExp, brand: string}[],
 *            rename: [RegExp, string][], chains: string[], parkExempt: RegExp[]}}
 */
export function compileStoreRules(raw) {
  const r = sanitizeStoreRules(raw);
  return {
    // canon＝STORE_CANON 同形狀 [標準名, 樣式]；contains 最寬（帳單前後常有雜訊），故為預設
    canon: r.canon.map(e => /** @type {[string, RegExp]} */ ([e.to, new RegExp(
      e.mode === 'exact' ? `^${escapeRe(e.match)}$` : e.mode === 'startsWith' ? `^${escapeRe(e.match)}` : escapeRe(e.match), 'i')])),
    // brand＝BRAND_CANON 同形狀：一律從頭比對（品牌在前、分店在後，才切得出分店）。
    // ⚠️ 比對「完整品牌名 or 使用者填的（截斷）寫法」兩種，且**長的排前面**：
    // 這條規則最常見的用途是「把銀行截斷的寫法併回完整名」（禾豐日式料 → 禾豐日式料理），
    // 若只比對截斷版，完整版「禾豐日式料理-林口店」會在「禾豐日式料」處切開，剩下「理-林口店」
    // 不是合法分店名 → 分店整個被丟掉。內建規則是用 `^好麥永和豆漿(店)?` 這種選擇性群組解決的，
    // 而使用者不會寫（也不該寫）正規表示式——所以由編譯器替他補上這個選擇。
    // **長的排前面**是關鍵（JS 的 | 取先中的，不是最長的）：使用者也可能反向填
    //（match=長寫法、to=短品牌名，如「Zaika札伊卡印度咖哩風味」→「Zaika札伊卡」），
    // 短的排前面時「…印度咖哩風味-林口店」會在短品牌處切開，把「印度咖哩風味」當成分店、
    // 真正的分店反而不見（自審 r3 抓到）。排序後兩個方向都對。
    brand: r.brand.map(e => {
      const alts = [e.to, e.match].sort((a, b) => b.length - a.length).map(escapeRe);
      return { prefix: new RegExp(`^(?:${alts.join('|')})`, 'i'), brand: e.to };
    }),
    // rename＝BRAND_RENAME 同形狀：全域字串取代（保留分店與其餘部分）。
    // `to` 也要跳脫（自審 r3）：它進的是 String.replace 的**取代字串**，裡面的 `$&`／`` $` ``／`$'`／`$$`
    // 是有意義的樣式（`$'` ＝比中處之後的全部）。使用者打「X$'Y」會複製半個店名進去。
    // 取代字串的跳脫規則是把 `$` 寫成 `$$`。
    rename: r.rename.map(e => /** @type {[RegExp, string]} */ (
      [new RegExp(escapeRe(e.match), 'g'), e.to.replace(/\$/g, '$$$$')])),
    chains: r.chains.slice(),
    parkExempt: r.parkExempt.map(s => new RegExp(`^${escapeRe(s)}$`, 'i'))
  };
}

// ---- 目前生效的使用者規則（模組級單例）----
// statement.js 是純函式模組（測試直接 import、不碰資料庫），所以它不自己讀 settings，
// 而是讀這裡的「目前值」。預設空＝只有內建規則，測試環境天然拿到乾淨的內建行為。
// **誰負責餵進來**：`lib/repo.js` 的 getDb()/getSettings()（「規則入櫃檯」，見 AGENTS.md 同步點）——
// 任何要用到店名規則的程式碼，一定得先向櫃檯拿資料，所以在櫃檯同步就不可能忘記、也不必額外讀檔。
let currentRaw = emptyStoreRules();
let currentRawJson = JSON.stringify(currentRaw);
let compiled = compileStoreRules(currentRaw);

/**
 * 設定目前生效的使用者規則（值沒變就不重編譯——櫃檯每次讀取都會呼叫，要夠便宜）。
 * @param {any} raw @returns {boolean} 是否真的變了
 */
export function setUserRules(raw) {
  const clean = sanitizeStoreRules(raw);
  const json = JSON.stringify(clean);
  if (json === currentRawJson) return false;
  currentRaw = clean;
  currentRawJson = json;
  compiled = compileStoreRules(clean);
  return true;
}

// ---- 預覽用的「暫時覆蓋」----
// 為什麼需要它：規則入櫃檯之後，**任何一次 getDb() 都會把規則重設回 settings 裡的值**。
// 預覽（用候選規則跑一次全庫）內部一定會呼叫 getDb()，若只是先 setUserRules(候選) 再跑，
// 候選規則會在第一次讀取資料時就被櫃檯洗掉，預覽永遠顯示「0 筆變動」（自審實測踩到）。
// 覆蓋層優先於櫃檯值，且**只在預覽期間存在**（服務層 try/finally 保證清掉）。
/** @type {ReturnType<typeof compileStoreRules> | null} */
let overrideCompiled = null;

/** 設定/清除預覽覆蓋（傳 null＝清除，回到櫃檯餵進來的規則）。 @param {any} raw */
export function setRulesOverride(raw) {
  overrideCompiled = raw === null || raw === undefined ? null : compileStoreRules(raw);
}

/** 目前生效的使用者規則（已編譯，statement.js 用）：預覽覆蓋優先。 */
export function getUserRules() { return overrideCompiled || compiled; }

/** 目前生效的使用者規則（純資料，UI 顯示與規則指紋用）。 */
export function getUserRulesRaw() { return currentRaw; }

/** 規則指紋的一部分：使用者規則的正規化字串（改了規則 → 開 app 自動重跑店名整理）。 */
export function userRulesFingerprint() { return currentRawJson; }
