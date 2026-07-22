// @ts-check
// 投資組合估值儀表：把五市場訊號與 CAPE 資料整理成 HTML，不碰 DOM、API 或頁面狀態。

import { CHART } from './theme.js';
import { ecyOf, regionTier, taiwanTier, TIER_LABELS, US_RATIO } from './signal-tiers.js';

/** @typedef {{escapeHtml:(value:any)=>string, formatPercent:(value:number, digits?:number)=>string}} ValuationFormatters */

const CAPE_PCT = [[4.8, 0], [9.6, 10], [11.6, 20], [13.7, 30], [15.5, 40], [16.9, 50], [18.9, 60], [21.2, 70], [24.4, 80], [28.4, 90], [32, 95], [44.2, 100]];
export const CAPE_MIN = 5;
export const CAPE_MAX = 45;
export const CAPE_BANDS = [
  { from: CAPE_MIN, to: 20, color: CHART.green, label: '偏低—可依紀律加碼 QQQM' },
  { from: 20, to: 28, color: CHART.yellow, label: '中性—定期定額為主' },
  { from: 28, to: 33, color: CHART.orange, label: '偏高—節制 QQQM，新資金以 CSPX／債券為主' },
  { from: 33, to: CAPE_MAX, color: CHART.red, label: '歷史高檔—不加碼 QQQM' }
];

/**
 * 美元／台幣匯率儀表（目前刻意休眠，等待日後決定頁面位置）。
 * @param {{ USD:number }} fx
 * @param {{ fxLow?:number, fxHigh?:number }} settings
 */
export function fxGaugeHtml(fx, settings) {
  const lo = Number(settings.fxLow || 28), hi = Number(settings.fxHigh || 32);
  const MIN = 26, MAX = 34;
  const rate = fx.USD;
  const marker = Math.min(Math.max(rate, MIN), MAX);
  const seg = (a, b) => ((b - a) / (MAX - MIN) * 100).toFixed(1);
  const pos = (x) => ((x - MIN) / (MAX - MIN) * 100).toFixed(1);
  return `<div class="chart-card" style="margin-bottom:16px">
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
      <span class="muted" style="font-size:12.5px">美元／台幣</span>
      <span class="stat sm">${rate.toFixed(2)}</span>
      <button class="btn-link btn-sm" id="fxBandEdit">區間調整</button>
    </div>
    <div class="gauge-wrap">
      <div class="gauge">
        <div style="width:${seg(MIN, lo)}%;background:${CHART.blue};opacity:.55"></div>
        <div style="width:${seg(lo, hi)}%;background:#bdb8ab;opacity:.55"></div>
        <div style="width:${seg(hi, MAX)}%;background:${CHART.green};opacity:.55"></div>
        <div class="gauge-marker" style="left:${((marker - MIN) / (MAX - MIN) * 100).toFixed(1)}%"></div>
      </div>
      <div class="fx-scale">
        <span class="fx-num fx-end-l">${MIN}</span>
        <span class="fx-num" style="left:${pos(lo)}%">${lo}</span>
        <span class="fx-num" style="left:${pos(hi)}%">${hi}</span>
        <span class="fx-num fx-end-r">${MAX}</span>
        <span class="fx-zone" style="left:${pos((MIN + lo) / 2)}%">（換美元區）</span>
        <span class="fx-zone" style="left:${pos((hi + MAX) / 2)}%">（換台幣區）</span>
      </div>
    </div>
  </div>`;
}

export const SIGNALS_INFO_HTML = `
  <p><b>這是什麼</b>：每月檢視五個市場的估值，換算成「檔位」——常態、加碼、重壓——據以動態調整配置。不是憑感覺，是指標換檔。</p>
  <p><b>美股（自動）</b>：ECY＝1/CAPE − 美 10 年期實質利率（FRED DFII10）。ECY 越高＝股票比安全資產多賺越多＝越值得加碼。<br>
  <b>ECY &lt; 3%</b> 常態（股債 70:30）／<b>3–5%</b> 加碼（80:20）／<b>&gt; 5%</b> 重壓（90:10）。</p>
  <p><b>區域（每月手動更新）</b>：中股滬深300 本益比、日股與韓股整體 P/B、台股大盤本益比與殖利率——這些無穩定免費 API，請每月自行查一次填入（按右上「更新區域數值」）。</p>
  <p class="muted">門檻：中股 PE &gt;13／10.5–11.5／&lt;10；日股 P/B &gt;1.3／1.1–1.2／&lt;1.0；韓股 P/B ~1.0／&lt;0.9／&lt;0.8；台股 PE 15–18／&lt;13 或殖利率&gt;4.5%／&lt;11 或&gt;5.5%。重壓訊號建議再等 VIX&gt;30 或信用利差擴大雙確認後才動手。</p>`;

const TIER_COLORS = ['var(--text-dim)', CHART.green, '#2E6B2A'];
const TIER_META = TIER_LABELS.map((label, index) => ({ label, color: TIER_COLORS[index] }));

/** @param {number} value */
export function capePercentile(value) {
  if (value <= CAPE_PCT[0][0]) return 0;
  for (let index = 1; index < CAPE_PCT.length; index++) {
    if (value <= CAPE_PCT[index][0]) {
      const [x0, y0] = CAPE_PCT[index - 1], [x1, y1] = CAPE_PCT[index];
      return y0 + (value - x0) / (x1 - x0) * (y1 - y0);
    }
  }
  return 100;
}

/** @param {number|null} tier */
function tierBadge(tier) {
  if (tier == null) return '<span class="muted" style="font-size:11px">未輸入</span>';
  const meta = TIER_META[tier];
  return `<span style="display:inline-block;padding:1px 9px;border-radius:20px;font-size:11px;font-weight:600;background:${meta.color}1f;color:${meta.color}">${meta.label}</span>`;
}

/** @param {string} label @param {string} valueText @param {number|null} tier @param {string} thresholds @param {(value:any)=>string} esc */
function signalRow(label, valueText, tier, thresholds, esc) {
  return `<div class="rrow" style="grid-template-columns:130px 1fr 64px;align-items:center">
    <span class="nowrap">${esc(label)}</span>
    <span class="muted small">${valueText}　<span style="opacity:.7">門檻 ${thresholds}</span></span>
    <span style="text-align:right">${tierBadge(tier)}</span>
  </div>`;
}

/**
 * 五市場估值訊號儀表。
 * @param {any} settings
 * @param {any} cape
 * @param {any} realYield
 * @param {Pick<ValuationFormatters, 'escapeHtml'>} formatters
 */
export function signalsBodyHtml(settings, cape, realYield, formatters) {
  const esc = formatters.escapeHtml;
  const signals = settings?.signals || {};
  const capeValue = cape && cape.value ? Number(cape.value) : null;
  const realYieldValue = realYield && realYield.value != null ? Number(realYield.value) : null;
  const ecy = ecyOf(capeValue, realYieldValue);
  const usTier = ecy != null ? regionTier('us', ecy) : null;
  const usValueText = ecy != null
    ? `ECY <b>${ecy.toFixed(1)}%</b>（CAPE ${(capeValue ?? 0).toFixed(1)}・實質利率 ${(realYieldValue ?? 0).toFixed(2)}%）`
    : 'ECY <span class="muted">無法計算（缺 CAPE 或利率）</span>';

  const taiwanTierValue = taiwanTier(signals.taiwanPE, signals.taiwanYield);
  const taiwanValue = (signals.taiwanPE || signals.taiwanYield)
    ? `PE ${signals.taiwanPE ? esc(signals.taiwanPE) : '—'}・殖利率 ${signals.taiwanYield ? esc(signals.taiwanYield) + '%' : '—'}`
    : '—';
  const rows = [
    signalRow('🇺🇸 美股（ECY）', usValueText, usTier, '&lt;3／3–5／&gt;5%', esc),
    signalRow('🇨🇳 中股（滬深300 PE）', signals.china ? `PE <b>${esc(signals.china)}</b>` : '—', regionTier('china', signals.china), '&gt;13／10.5–11.5／&lt;10', esc),
    signalRow('🇯🇵 日股（P/B）', signals.japan ? `P/B <b>${esc(signals.japan)}</b>` : '—', regionTier('japan', signals.japan), '&gt;1.3／1.1–1.2／&lt;1.0', esc),
    signalRow('🇰🇷 韓股（P/B）', signals.korea ? `P/B <b>${esc(signals.korea)}</b>` : '—', regionTier('korea', signals.korea), '~1.0／&lt;0.9／&lt;0.8', esc),
    signalRow('🇹🇼 台股（PE／殖利率）', taiwanValue, taiwanTierValue, 'PE&lt;13 或殖&gt;4.5%', esc)
  ].join('');

  const tilts = [
    ['中股', regionTier('china', signals.china)],
    ['日股', regionTier('japan', signals.japan)],
    ['韓股', regionTier('korea', signals.korea)],
    ['台股', taiwanTierValue]
  ];
  const add = tilts.filter(([, tier]) => tier === 1).map(([name]) => name);
  const overweight = tilts.filter(([, tier]) => tier === 2).map(([name]) => name);
  const summary = usTier != null
    ? `<div class="rc-block" style="margin-bottom:12px"><b>建議股債比 ${US_RATIO[usTier]}</b>（美股 ${TIER_META[usTier].label}）
       ${overweight.length ? `｜<span style="color:${TIER_META[2].color}">重壓：${overweight.join('、')}</span>` : ''}
       ${add.length ? `｜<span style="color:${TIER_META[1].color}">加碼：${add.join('、')}</span>` : ''}
       ${!add.length && !overweight.length ? '｜區域無加碼訊號' : ''}</div>`
    : '<div class="rc-block muted" style="margin-bottom:12px">美股 ECY 暫時無法計算——CAPE 或實質利率抓取失敗，可在「更新區域數值」填入手動實質利率。</div>';

  return summary + `<div class="region-rows">${rows}</div>
    <p class="muted small" style="margin-top:8px">美股自動（CAPE＋FRED 實質利率）；區域四市場為每月手動更新。加碼＝乘 1.5、重壓＝乘 2 的衛星傾斜（詳見標題說明）。</p>`;
}

/** @param {any} cape */
export function capeInfoOf(cape) {
  const value = cape?.value ? Number(cape.value) : 0;
  if (!value) return null;
  const band = CAPE_BANDS.find(item => value < item.to) || CAPE_BANDS[CAPE_BANDS.length - 1];
  return { value, percentile: capePercentile(value), label: band.label };
}

/**
 * CAPE 估值儀表。
 * @param {any} cape
 * @param {number} qqqmShare
 * @param {number} qqqmMax
 * @param {ValuationFormatters} formatters
 */
export function capeBodyHtml(cape, qqqmShare, qqqmMax, formatters) {
  const { escapeHtml: esc, formatPercent: fmtPct } = formatters;
  const value = cape && cape.value ? Number(cape.value) : null;
  if (!value) return '<p class="muted" style="margin-top:8px">無法自動取得 CAPE。<button class="btn-link btn-sm" id="capeManualBtn">手動設定</button></p>';

  const percentile = capePercentile(value);
  const band = CAPE_BANDS.find(item => value < item.to) || CAPE_BANDS[CAPE_BANDS.length - 1];
  const clamped = Math.min(Math.max(value, CAPE_MIN), CAPE_MAX);
  const markerLeft = (clamped - CAPE_MIN) / (CAPE_MAX - CAPE_MIN) * 100;
  const qqqmOk = qqqmShare <= qqqmMax;
  return `
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-top:6px">
      <span class="stat sm">${value.toFixed(2)}</span>
      <span class="muted" style="font-size:12.5px">歷史分位 ~${percentile.toFixed(0)}%・來源 ${esc(cape.source)}
        <button class="btn-link btn-sm" id="capeManualBtn">手動設定</button></span>
    </div>
    <div class="gauge-wrap">
      <div class="gauge">
        ${CAPE_BANDS.map(item => `<div style="width:${((item.to - item.from) / (CAPE_MAX - CAPE_MIN) * 100).toFixed(1)}%;background:${item.color};opacity:.55"></div>`).join('')}
        <div class="gauge-marker" style="left:${markerLeft.toFixed(1)}%"></div>
      </div>
      <div class="gauge-scale"><span>5</span><span>20</span><span>28</span><span>33</span><span>45</span></div>
    </div>
    <p style="font-size:13px;margin-top:4px"><b style="color:${band.color}">目前規則帶：</b>${band.label}</p>
    <p class="muted small" style="margin-top:6px">QQQM 佔美股核心 <b style="color:${qqqmOk ? 'var(--pos)' : 'var(--neg)'}">${fmtPct(qqqmShare)}</b>（上限 ${qqqmMax}%）${qqqmOk ? '——在限內。' : '——已超限，漲勢中依紀律轉回 CSPX。'}
    提醒：CAPE 是 S&P 500 的估值指標，當「紀律閘門」用，不當精準擇時訊號；它可以在高檔停留很多年。</p>
  `;
}
