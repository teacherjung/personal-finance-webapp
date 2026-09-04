import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  companiesSection,
  disciplineSection,
  fxSection,
  holdingsDonut,
  layerSection,
  LAYERS,
  LAYER_ORDER,
  regionSection
} from '../public/modules/portfolio-visuals.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char] || char));
const formatters = {
  escapeHtml,
  formatMoney: value => `${Number(value).toFixed(0)} 元`,
  formatPercent: (value, digits = 1) => `${Number(value).toFixed(digits)}%`
};

test('投資視覺｜紀律檢查鎖住上限、斷頭距離、零上限與文字消毒', () => {
  const rows = [
    { symbol: '<AAPL>', layer: 'stock', valueTwd: 20 },
    { symbol: 'CSPX', layer: 'core', valueTwd: 60 }
  ];
  const caps = { equity: 90, stock: 5, china: 0, country: 15, lev: 1.3, maint: 25 };
  const html = disciplineSection(rows, { 美國: 60, 中國: 10 }, 80, 100, 1.4, caps, 100, 30, formatters);

  assert.match(html, /股票總曝險[\s\S]*80\.0%[\s\S]*90%/);
  assert.match(html, /&lt;AAPL&gt;[\s\S]*20\.0%[\s\S]*5%[\s\S]*凍結/);
  assert.match(html, /中國（穿透）[\s\S]*cb-over[\s\S]*10\.0%[\s\S]*0%/);
  assert.match(html, /IB 融資槓桿[\s\S]*1\.40x[\s\S]*1\.3x[\s\S]*停借/);
  assert.match(html, /再跌\s*<b[^>]*>60%<\/b>/);
  assert.match(html, /維持率到 35%，距離縮到 54%/);
  assert.doesNotMatch(html, /<AAPL>/);
  assert.equal(disciplineSection(rows, {}, 80, 0, 1, caps, 0, 0, formatters), '');
});

test('投資視覺｜同一個股拆成多列時只顯示一列合計曝險，與凍結判斷一致', () => {
  const html = disciplineSection([
    { symbol: 'AAPL', layer: 'stock', valueTwd: 3 },
    { symbol: ' aapl ', layer: 'stock', valueTwd: 3 }
  ], {}, 6, 100, 1, { equity: 90, stock: 5, china: 15, country: 15, lev: 1.3, maint: 25 }, 0, 0, formatters);

  assert.equal((html.match(/AAPL/g) || []).length, 1);
  assert.match(html, /AAPL[\s\S]*6\.0%[\s\S]*5%[\s\S]*凍結/);
});

test('投資視覺｜幣別曝險維持底層資產拆解、負債方向與排序', () => {
  const rows = [
    { symbol: 'AAPL', layer: 'stock', currency: 'USD', valueTwd: 100 },
    { symbol: 'GLD', layer: 'gold', currency: 'USD', valueTwd: 20 }
  ];
  const accounts = [
    { type: 'cash', currency: 'USD', balance: 10 },
    { type: 'loan', currency: 'TWD', balance: 50 }
  ];
  const html = fxSection(rows, accounts, { USD: 2, TWD: 1 }, formatters);

  assert.ok(html.indexOf('USD') < html.indexOf('黃金'));
  assert.ok(html.indexOf('黃金') < html.indexOf('TWD'));
  assert.match(html, /120 元 ＝ 股票 100 元 ＋ 現金 20 元/);
  assert.match(html, /20 元 ＝ 黃金 20 元/);
  assert.match(html, /rval neg[\s\S]*-55\.6%/);
  assert.match(html, /註解：換算匯率＝上次抓到的（Yahoo，抓不到退備援 API）或預設值/);
});

test('投資視覺｜區域曝險依金額排序並維持中國、印度說明', () => {
  const html = regionSection({ 美國: 60, 中國: 25, 印度: 15 }, 100, formatters);

  assert.ok(html.indexOf('美國') < html.indexOf('中國'));
  assert.ok(html.indexOf('中國') < html.indexOf('印度'));
  assert.match(html, /美國[\s\S]*60\.0%[\s\S]*60 元/);
  assert.match(html, /真實的中國曝險 25\.0%/);
  assert.match(html, /印度目前實佔 15\.0%/);
});

test('投資視覺｜公司穿透維持來源、排行、涵蓋率與空狀態', () => {
  const rows = [
    { symbol: 'AAPL', layer: 'stock', valueTwd: 100 },
    { symbol: 'CSPX', layer: 'core', valueTwd: 100 }
  ];
  const html = companiesSection(rows, 200, formatters);

  assert.match(html, /持股公司 Top 20/);
  assert.ok(html.indexOf('蘋果') < html.indexOf('輝達'));
  assert.match(html, /title="蘋果 ＝ AAPL 100 元、CSPX 7 元"/);
  assert.match(html, /Top 20 合計約佔股票部位 69\.2%/);
  assert.equal(companiesSection(rows, 0, formatters), '');
  assert.equal(companiesSection([{ symbol: 'XUSE', valueTwd: 100 }], 100, formatters), '');
});

test('投資視覺｜分層設定、顯示順序與高低狀態維持原口徑', () => {
  const html = layerSection({ core: 50, satellite: 25, stock: 10, bond: 15, gold: 0 }, 100, formatters);

  assert.deepEqual(LAYER_ORDER, ['core', 'satellite', 'stock', 'bond', 'gold']);
  assert.equal(LAYERS.core.label, '核心（美股）');
  const body = html.slice(html.indexOf('<tbody>'));
  assert.ok(body.indexOf('核心（美股）') < body.indexOf('衛星'));
  assert.ok(body.indexOf('衛星') < body.indexOf('個股'));
  assert.match(html, /核心（美股）[\s\S]*50\.0%[\s\S]*45–65%[\s\S]*符合/);
  assert.match(html, /衛星[\s\S]*25\.0%[\s\S]*8–20%[\s\S]*偏高/);
  assert.match(html, /黃金[\s\S]*0\.0%[\s\S]*0–10%[\s\S]*符合/);
});

test('投資視覺｜持股圓環依市值排序、保留總額且代號不可成為 HTML', () => {
  assert.equal(holdingsDonut([], 0, formatters), '');
  const html = holdingsDonut([
    { symbol: '<img src=x onerror=alert(1)>', valueTwd: 25 },
    { symbol: 'CSPX', valueTwd: 75 }
  ], 100, formatters);

  assert.match(html, /aria-label="持股佔比圓環圖"/);
  assert.ok(html.indexOf('CSPX') < html.indexOf('&lt;img src=x onerror=alert(1)&gt;'));
  assert.match(html, /CSPX\s+75 元（75\.0%）/);
  assert.match(html, />100 元<\/text>[\s\S]*>總市值<\/text>/);
  assert.doesNotMatch(html, /<img /);
});

// 逐列讀 rv-tag：跨列的 [\s\S]* 正規式只驗得到「超標列有凍結」，驗不到「上限內是 ✓」與邊界（等於上限不算超過）。
test('紀律檢查：逐列判讀——在上限內顯示 ✓、剛好等於上限不算超過、只有超過才凍結／停借', () => {
  const rows = [
    { symbol: 'AAPL', layer: 'stock', valueTwd: 20 },   // 20% > 5% → 凍結
    { symbol: 'MSFT', layer: 'stock', valueTwd: 5 },    // 5% = 5% → ✓（邊界）
    { symbol: 'NVDA', layer: 'stock', valueTwd: 2 },    // 2% < 5% → ✓
    { symbol: 'CSPX', layer: 'core', valueTwd: 60 }
  ];
  const caps = { equity: 90, stock: 5, china: 15, country: 15, lev: 1.3, maint: 25 };
  const tagsOf = (html) => {
    const cells = html.split('<div class="rrow cap-row">').slice(1);
    return (label) => {
      const r = cells.find((c) => c.includes(`<span class="nowrap">${label}</span>`));
      assert.ok(r, `找不到「${label}」那一列`);
      return (/rv-tag">([^<]*)</.exec(r) || [])[1];
    };
  };
  const tag = tagsOf(disciplineSection(rows, { 美國: 60, 中國: 10 }, 87, 100, 1.2, caps, 100, 30, formatters));
  assert.equal(tag('股票總曝險'), '✓', '87% < 90% 不可凍結');
  assert.equal(tag('AAPL'), '凍結', '20% > 5% 要凍結');
  assert.equal(tag('MSFT'), '✓', '剛好等於上限（5% / 5%）不算超過');
  assert.equal(tag('NVDA'), '✓', '2% < 5% 不可凍結');
  assert.equal(tag('中國（穿透）'), '✓', '10% < 15% 不可凍結');
  assert.equal(tag('IB 融資槓桿'), '✓', '1.2x < 1.3x 不可停借');
  // 反向：同一份資料、把上限壓低／槓桿拉高 ⇒ 該列要翻成凍結／停借（證明判斷真的看 caps）
  const tag2 = tagsOf(disciplineSection(rows, { 美國: 60, 中國: 10 }, 87, 100, 1.4, { ...caps, china: 5 }, 100, 30, formatters));
  assert.equal(tag2('中國（穿透）'), '凍結', '10% > 5% 要凍結');
  assert.equal(tag2('IB 融資槓桿'), '停借', '1.4x > 1.3x 要停借');
  assert.equal(tag2('股票總曝險'), '✓', '沒動到的列不受影響');
});
