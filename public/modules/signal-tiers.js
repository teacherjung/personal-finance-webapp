// @ts-check
// 估值訊號「檔位」單一真相（每日洞察引擎 D3 抽出；前後端共用，仿 categories.js 前例）。
// 檔位：0 常態、1 加碼、2 重壓（越貴 tier 越低）。門檻依 [[investment-principles]]。
// ⚠️ 純模組（不可 import app.js/theme.js 這類瀏覽器專用檔）：後端 lib/services/insights.js 也 import 這份算 ECY 跳檔。
// ⚠️ 同步點：門檻改這裡一處即可（portfolio.js 儀表＋insights.js 跳檔都用它）；白話說明（SIGNALS_INFO_HTML、
//    memory 投資原則規則書）是文件，改門檻要順手對齊。

/** 檔位標籤（0/1/2）。顏色是前端 presentation，各自映射，不放這裡。 */
export const TIER_LABELS = ['常態', '加碼', '重壓'];
/** 美股檔位 → 建議股債比。 */
export const US_RATIO = ['70 : 30', '80 : 20', '90 : 10'];

/**
 * 各市場檔位（回傳 0/1/2，或 null＝未輸入/無法計算）。
 * @param {'us'|'china'|'japan'|'korea'} key @param {number|string|null|undefined} v
 * @returns {number|null}
 */
export function regionTier(key, v) {
  const n = Number(v);
  if (v == null || v === '' || !isFinite(n)) return null;
  if (key === 'us') return n > 5 ? 2 : n >= 3 ? 1 : 0;          // ECY %
  if (key === 'china') return n < 10 ? 2 : n <= 11.5 ? 1 : 0;   // 滬深300 PE
  if (key === 'japan') return n < 1.0 ? 2 : n <= 1.2 ? 1 : 0;   // 日股 P/B
  if (key === 'korea') return n < 0.8 ? 2 : n < 0.9 ? 1 : 0;    // KOSPI P/B
  return null;
}

/**
 * 台股檔位（本益比／殖利率，有一個就算）。@param {number|string} pe @param {number|string} yld @returns {number|null}
 */
export function taiwanTier(pe, yld) {
  const p = Number(pe), y = Number(yld);
  const hp = isFinite(p) && p > 0, hy = isFinite(y) && y > 0;
  if (!hp && !hy) return null;
  if ((hp && p < 11) || (hy && y > 5.5)) return 2;
  if ((hp && p < 13) || (hy && y > 4.5)) return 1;
  return 0;
}

/**
 * 美股 ECY（Excess CAPE Yield）＝1/CAPE − 美 10 年期實質利率，以百分比計。缺任一或 CAPE≤0 → null。
 * @param {number|string|null|undefined} cape @param {number|string|null|undefined} realYield @returns {number|null}
 */
export function ecyOf(cape, realYield) {
  const c = Number(cape), r = Number(realYield);
  if (!isFinite(c) || c <= 0 || realYield == null || realYield === '' || !isFinite(r)) return null;
  return 100 / c - r;
}

/**
 * 五市場檔位物件（差異引擎跳檔比對用；缺值＝null 該市場不判）。
 * @param {{signals?: any, ecy?: number|null}} arg
 * @returns {{us: number|null, china: number|null, japan: number|null, korea: number|null, taiwan: number|null}}
 */
export function computeSignalTiers({ signals = {}, ecy = null } = {}) {
  return {
    us: ecy != null ? regionTier('us', ecy) : null,
    china: regionTier('china', signals.china),
    japan: regionTier('japan', signals.japan),
    korea: regionTier('korea', signals.korea),
    taiwan: taiwanTier(signals.taiwanPE, signals.taiwanYield),
  };
}
