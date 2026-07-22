import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  portfolioHeaderHtml,
  portfolioSummaryHtml,
  valuationPlaceholdersHtml,
  xirrSectionHtml,
  XIRR_INFO_HTML
} from '../public/modules/portfolio-overview.js';
import { CHART } from '../public/modules/theme.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const formatMoney = (value) => `${Number(value)} 元`;

const summary = (overrides = {}) => ({
  total: 1000, totalCost: 800, totalPnl: 200,
  eqV: 500, bondV: 200, cashV: 200, goldAll: 100, allBase: 1000,
  leverage: 1.2, netEquity: 700, loanTwd: 100, levCap: 1.3,
  ...overrides
});

test('投資頁首｜NT／US 切換狀態與四個主要動作維持原樣', () => {
  const twd = portfolioHeaderHtml('TWD');
  assert.match(twd, /fee-tog on" data-cur="TWD">NT/);
  assert.doesNotMatch(twd, /fee-tog on" data-cur="USD">US/);
  assert.match(twd, /id="printPortfolio"/);
  assert.match(twd, /id="ibSync"/);
  assert.match(twd, /id="refreshQuotes"/);
  assert.match(twd, /id="addHolding"/);

  const usd = portfolioHeaderHtml('USD');
  assert.match(usd, /fee-tog on" data-cur="USD">US/);
  const unknown = portfolioHeaderHtml('toString');
  assert.doesNotMatch(unknown, /fee-tog on" data-cur="(?:TWD|USD)"/);
});

test('投資摘要｜總額、四資產比例、正損益與槓桿安全色維持原口徑', () => {
  const html = portfolioSummaryHtml(summary(), { formatMoney });
  assert.match(html, />1000 元</);
  assert.match(html, /未實現損益 \+200 元/);
  assert.match(html, />50 \/ 20 \/ 20 \/ 10</);
  assert.match(html, />1\.20 倍</);
  assert.ok(html.includes(`background:${CHART.green}`));
});

test('投資摘要｜零資產不除以零；虧損、超標與負淨值警告都保留', () => {
  const zero = portfolioSummaryHtml(summary({ totalPnl: -50, eqV: 0, bondV: 0, cashV: 0, goldAll: 0, allBase: 0, leverage: 1.4 }), { formatMoney });
  assert.match(zero, /未實現損益 -50 元/);
  assert.match(zero, />0 \/ 0 \/ 0 \/ 0</);
  assert.match(zero, /stat sm neg">1\.40 倍/);

  const broken = portfolioSummaryHtml(summary({ leverage: Infinity }), { formatMoney });
  assert.match(broken, /⚠️ 淨值已為負/);
});

test('估值占位卡｜訊號與 CAPE 的載入節點及設定入口維持固定', () => {
  const html = valuationPlaceholdersHtml();
  assert.match(html, /id="signalsBody"/);
  assert.match(html, /id="signalsEdit"/);
  assert.match(html, /id="capeBody"/);
  assert.match(html, /讀取中…/);
});

test('XIRR 區塊｜成功、負報酬、未滿一年、估算與失敗原因都正確', () => {
  const gain = xirrSectionHtml({ ok: true, rate: 12.34, years: 0.5, estimated: true }, { escapeHtml });
  assert.match(gain, /class="pos">\+12\.3%/);
  assert.match(gain, /未滿 1 年僅供參考/);
  assert.match(gain, /含匯率估算/);
  assert.match(gain, /id="investChart"/);

  const loss = xirrSectionHtml({ ok: true, rate: -5.55, years: 2 }, { escapeHtml });
  assert.match(loss, /class="neg">-5\.5%/);
  assert.doesNotMatch(loss, /未滿 1 年|含匯率估算/);

  const failed = xirrSectionHtml({ ok: false, why: '<img src=x onerror=alert(1)>' }, { escapeHtml });
  assert.match(failed, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(failed, /<img /);
  assert.match(XIRR_INFO_HTML, /資金加權年化報酬/);
});
