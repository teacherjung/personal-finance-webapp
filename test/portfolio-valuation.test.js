import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capeBodyHtml,
  capeInfoOf,
  capePercentile,
  signalsBodyHtml,
  SIGNALS_INFO_HTML
} from '../public/modules/portfolio-valuation.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const formatPercent = (value, digits = 1) => (Number(value) || 0).toFixed(digits) + '%';
const formatters = { escapeHtml, formatPercent };

test('投資估值｜CAPE 分位、規則帶與列印摘要共用同一口徑', () => {
  assert.equal(capePercentile(4.8), 0);
  assert.equal(capePercentile(16.9), 50);
  assert.equal(capePercentile(44.2), 100);
  assert.equal(capePercentile(60), 100);

  const info = capeInfoOf({ value: 30 });
  assert.equal(info?.value, 30);
  assert.equal(Math.round(info?.percentile || 0), 92);
  assert.equal(info?.label, '偏高—節制 QQQM，新資金以 CSPX／債券為主');
  assert.equal(capeInfoOf({ value: 0 }), null);
  assert.equal(capeInfoOf(null), null);
});

test('投資估值｜五市場摘要維持美股股債比、區域加碼與重壓順序', () => {
  const html = signalsBodyHtml({ signals: {
    china: 9.9,
    japan: 1.1,
    korea: 0.95,
    taiwanYield: 4.6
  } }, { value: 20 }, { value: 1 }, formatters);

  assert.match(html, /建議股債比 80 : 20/); // ECY = 100/20 − 1 = 4 → 加碼
  assert.match(html, /美股 加碼/);
  assert.match(html, /重壓：中股/);
  assert.match(html, /加碼：日股、台股/);
  assert.match(html, /韓股（P\/B）[\s\S]*常態/);
  assert.match(html, /ECY <b>4\.0%<\/b>（CAPE 20\.0・實質利率 1\.00%）/);
});

test('投資估值｜缺 CAPE/利率誠實顯示退路，手動訊號不可注入 HTML', () => {
  const html = signalsBodyHtml({ signals: {
    china: '<img src=x onerror=alert(1)>'
  } }, null, null, formatters);

  assert.match(html, /美股 ECY 暫時無法計算/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /未輸入/);
  assert.match(SIGNALS_INFO_HTML, /ECY &lt; 3%/);
});

test('投資估值｜CAPE 儀表維持分位、標記位置、QQQM 超限與來源消毒', () => {
  const html = capeBodyHtml({ value: 30, source: '<img src=x onerror=alert(1)>' }, 31, 30, formatters);

  assert.match(html, />30\.00<\/span>/);
  assert.match(html, /歷史分位 ~92%/);
  assert.match(html, /gauge-marker" style="left:62\.5%"/);
  assert.match(html, /目前規則帶：<\/b>偏高—節制 QQQM/);
  assert.match(html, /QQQM 佔美股核心[\s\S]*31\.0%[\s\S]*上限 30%[\s\S]*已超限/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img /);

  const empty = capeBodyHtml(null, 0, 30, formatters);
  assert.match(empty, /無法自動取得 CAPE/);
  assert.match(empty, /id="capeManualBtn"/);
});
