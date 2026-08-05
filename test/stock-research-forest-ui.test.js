import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { icon } from '../public/modules/icons.js';
import { STOCK_RESEARCH_TABS, stockResearchViewHtml } from '../public/modules/stock-research-view.js';

const ROOT = new URL('../', import.meta.url);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function cssRule(css, selector, startAt = 0) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleStart = new RegExp(`^\\s*${escapedSelector}\\s*\\{`, 'gm');
  ruleStart.lastIndex = startAt;
  const match = ruleStart.exec(css);
  assert.ok(match, `missing CSS selector: ${selector}`);
  const openAt = css.indexOf('{', match.index);
  const closeAt = css.indexOf('}', openAt);
  assert.notEqual(openAt, -1, `missing CSS rule start: ${selector}`);
  assert.notEqual(closeAt, -1, `missing CSS rule end: ${selector}`);
  return css.slice(openAt + 1, closeAt);
}

function cssHexToken(css, name) {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing CSS token: ${name}`);
  return match[1];
}

function cssPx(rule, property) {
  const match = rule.match(new RegExp(`${property}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
  assert.ok(match, `missing pixel declaration: ${property}`);
  return Number(match[1]);
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map(value => Number.parseInt(value, 16) / 255);
  const linear = channels.map(value => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function researchModel(overrides = {}) {
  const research = {
    symbol: 'AAPL',
    thesis: '服務收入與生態系黏著度',
    risks: '估值與區域集中',
    lastReviewedAt: '2026-08-03',
    scorecard: {
      business: 4,
      financial: 5,
      valuation: 2,
      evidence: 3,
      risk: 4,
      reasons: {
        business: '護城河仍在',
        financial: '現金流穩健',
        valuation: '估值偏高',
        evidence: '財報支持',
        risk: '部位符合上限'
      }
    },
    valuationScenarios: {
      currency: 'USD',
      bear: 160,
      base: 200,
      bull: 250,
      assumptions: '合成測試資料'
    },
    checkpoints: [],
    watchMetrics: [],
    catalysts: [],
    thesisBreakers: [],
    scoreHistory: [],
    sources: []
  };

  return {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    position: {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      currency: 'USD',
      quantity: 10,
      costTwd: 500000,
      valueTwd: 620000,
      pnlTwd: 120000,
      held: true
    },
    allocation: { pct: 4.5, capPct: 5, frozen: false },
    status: { value: 'valid', label: '持有論點成立' },
    availability: { state: 'ready', label: '研究資料已建立', canEdit: true, canCreate: false },
    research,
    scorecard: research.scorecard,
    valuationScenarios: research.valuationScenarios,
    ...overrides
  };
}

test('個股研究森林工作面｜六個頁籤共用單一厚框工作面且只顯示目前頁', () => {
  const html = stockResearchViewHtml({
    model: researchModel(),
    activeTab: 'overview'
  }, { esc });

  assert.equal((html.match(/class="stock-tab(?: active)?"/g) || []).length, 6);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.equal((html.match(/class="stock-tab-panel"/g) || []).length, 1);
  assert.match(html, /class="stock-research-workspace"/);
  assert.match(html, /data-stock-tab="overview"/);
  assert.match(html, /目前部位/);
});

test('個股研究森林工作面｜頁籤有固定圖示且選中頁與內容面板視覺相接', async () => {
  assert.deepEqual(STOCK_RESEARCH_TABS.map(tab => tab.icon), [
    'dashboard', 'file', 'star', 'pie', 'bulb', 'repeat'
  ]);
  const html = stockResearchViewHtml({
    model: researchModel(),
    activeTab: 'thesis'
  }, { esc });
  const tabs = html.match(/<nav class="stock-tabs"[\s\S]*?<\/nav>/)?.[0] || '';
  const css = await readFile(new URL('public/stock-research.css', ROOT), 'utf8');

  assert.equal((tabs.match(/<svg class="ic"/g) || []).length, 6);
  assert.equal((tabs.match(/aria-label="[^"]+" title="[^"]+"/g) || []).length, 6);
  assert.equal((tabs.match(/class="stock-tab-ear stock-tab-ear-left" aria-hidden="true"/g) || []).length, 6);
  assert.equal((tabs.match(/class="stock-tab-ear stock-tab-ear-right" aria-hidden="true"/g) || []).length, 6);
  for (const tab of STOCK_RESEARCH_TABS) {
    assert.doesNotMatch(icon(tab.icon), /aria-hidden="true"><\/svg>/, `${tab.key} icon must not be empty`);
  }
  assert.doesNotMatch(icon('arrow-left'), /aria-hidden="true"><\/svg>/);
  assert.match(tabs, /id="stock-tab-thesis" class="stock-tab active"[\s\S]*aria-current="page"/);
  assert.doesNotMatch(cssRule(css, '.stock-tabs'), /border-bottom/);
  assert.match(cssRule(css, '.stock-tabs'), /position:\s*relative/);
  assert.match(cssRule(css, '.stock-tabs'), /z-index:\s*2/);
  assert.match(cssRule(css, '.stock-tab'), /background:\s*var\(--card-2\)/);
  assert.match(cssRule(css, '.stock-tab'), /border:\s*2px solid var\(--frame\)/);
  assert.match(cssRule(css, '.stock-tab'), /border-radius:\s*16px 16px 0 0/);
  assert.match(cssRule(css, '.stock-tab:focus-visible'), /outline:\s*3px solid var\(--accent\)/);
  assert.equal(cssPx(cssRule(css, '.stock-tab:focus-visible'), 'outline-offset'), -5);
  assert.match(cssRule(css, '.stock-tab.active'), /border-color:\s*var\(--frame\)/);
  assert.match(cssRule(css, '.stock-tab.active'), /border-bottom:\s*none/);
  assert.match(cssRule(css, '.stock-tab.active'), /border-radius:\s*16px 16px 0 0/);
  assert.match(cssRule(css, '.stock-tab.active'), /color:\s*var\(--accent-hover\)/);
  assert.match(cssRule(css, '.stock-tab.active::before'), /bottom:\s*6px/);
  assert.match(cssRule(css, '.stock-tab.active::after'), /right:\s*0/);
  assert.match(cssRule(css, '.stock-tab.active::after'), /bottom:\s*-5px/);
  assert.match(cssRule(css, '.stock-tab.active::after'), /left:\s*0/);
  assert.match(cssRule(css, '.stock-tab.active::after'), /height:\s*7px/);
  assert.match(cssRule(css, '.stock-tab.active::after'), /background:\s*var\(--card\)/);
  assert.match(cssRule(css, '.stock-tab-ear'), /pointer-events:\s*none/);
  assert.match(cssRule(css, '.stock-tab.active .stock-tab-ear'), /display:\s*block/);
  assert.match(cssRule(css, '.stock-tab-ear-left'), /left:\s*-18px/);
  assert.match(cssRule(css, '.stock-tab-ear-left'), /circle at 0 0/);
  assert.match(cssRule(css, '.stock-tab-ear-right'), /right:\s*-18px/);
  assert.match(cssRule(css, '.stock-tab-ear-right'), /circle at 100% 0/);
  assert.match(cssRule(css, '.stock-tab-panel'), /margin-top:\s*-2px/);

  const bridgeRule = cssRule(css, '.stock-tab.active::after');
  const tabRule = cssRule(css, '.stock-tab');
  const panelRule = cssRule(css, '.stock-tab-panel');
  const panelBorder = cssPx(panelRule, 'border');
  assert.ok(cssPx(bridgeRule, 'bottom') < 0);
  assert.ok(cssPx(bridgeRule, 'height') > panelBorder);
  assert.equal(Math.abs(cssPx(tabRule, 'margin-right')), panelBorder);
  assert.equal(Math.abs(cssPx(tabRule, 'margin-bottom')), panelBorder);
  assert.equal(Math.abs(cssPx(panelRule, 'margin-top')), panelBorder);

  const sharedCss = await readFile(new URL('public/styles.css', ROOT), 'utf8');
  const accent = cssHexToken(sharedCss, '--accent');
  for (const background of ['--card', '--card-2']) {
    assert.ok(
      contrastRatio(accent, cssHexToken(sharedCss, background)) >= 3,
      `focus outline must keep 3:1 contrast against ${background}`
    );
  }
});

test('個股研究森林工作面｜估值保留三情境語意並可單獨辨識基準列', () => {
  const html = stockResearchViewHtml({
    model: researchModel(),
    activeTab: 'valuation',
    quote: { price: 220, currency: 'USD' }
  }, { esc });

  assert.match(html, /class="stock-valuation-row bear"[\s\S]*保守/);
  assert.match(html, /class="stock-valuation-row base"[\s\S]*基準/);
  assert.match(html, /class="stock-valuation-row bull"[\s\S]*樂觀/);
});

test('個股研究森林工作面｜小森森只在真正空狀態出現', async () => {
  const full = stockResearchViewHtml({ model: researchModel(), activeTab: 'overview' }, { esc });
  const empty = stockResearchViewHtml({
    model: researchModel({
      research: null,
      scorecard: null,
      valuationScenarios: null,
      availability: { state: 'position-only', label: '尚未建立研究', canCreate: true }
    }),
    activeTab: 'score'
  }, { esc });

  assert.doesNotMatch(full, /stock-empty-guide/);
  assert.match(empty, /class="stock-empty-guide"/);
  assert.match(empty, /src="assets\/guide-return-neutral\.webp"/);
  await access(new URL('public/assets/guide-return-neutral.webp', ROOT));
});

test('個股研究森林工作面｜專用樣式鎖住厚框、評分條與手機兩欄摘要', async () => {
  const css = await readFile(new URL('public/stock-research.css', ROOT), 'utf8');
  const mobileAt = css.indexOf('@media (max-width: 680px)');
  const panelRule = cssRule(css, '.stock-tab-panel');
  const scoreRule = cssRule(css, '.stock-score-track');

  assert.match(panelRule, /border:\s*2px solid var\(--frame\)/);
  assert.match(panelRule, /overflow:\s*hidden/);
  assert.match(scoreRule, /height:\s*13px/);
  assert.match(scoreRule, /border:\s*2px solid var\(--frame\)/);
  assert.doesNotMatch(
    panelRule.replace(/border:\s*2px solid var\(--frame\);?/, ''),
    /border:\s*2px solid var\(--frame\)/
  );
  assert.doesNotMatch(
    scoreRule.replace(/border:\s*2px solid var\(--frame\);?/, ''),
    /border:\s*2px solid var\(--frame\)/
  );
  assert.match(cssRule(css, '.stock-empty-guide'), /width:\s*78px/);
  assert.match(cssRule(css, '.stock-empty-guide'), /height:\s*78px/);
  assert.notEqual(mobileAt, -1);
  assert.match(cssRule(css, '.stock-position-grid', mobileAt), /grid-template-columns:\s*repeat\(2,/);
  assert.match(cssRule(css, '.stock-tab', mobileAt), /flex:\s*0 0 52px/);
  assert.match(cssRule(css, '.stock-tab.active', mobileAt), /flex-basis:\s*104px/);
  assert.match(cssRule(css, '.stock-tab-label', mobileAt), /display:\s*none/);
  assert.match(cssRule(css, '.stock-tab.active .stock-tab-label', mobileAt), /display:\s*inline/);
});

test('個股研究森林工作面｜部位帶內距與負邊距成對避免整頁橫向溢出', async () => {
  const css = await readFile(new URL('public/stock-research.css', ROOT), 'utf8');
  const mobileAt = css.indexOf('@media (max-width: 680px)');

  assert.match(cssRule(css, '.stock-tab-panel'), /padding:\s*26px 28px 32px/);
  assert.match(cssRule(css, '.stock-position'), /margin:\s*8px -28px 30px/);
  assert.match(cssRule(css, '.stock-position'), /padding:\s*20px 28px 0/);
  assert.match(cssRule(css, '.stock-tab-panel', mobileAt), /padding:\s*20px 16px 26px/);
  assert.match(cssRule(css, '.stock-position', mobileAt), /margin-right:\s*-16px/);
  assert.match(cssRule(css, '.stock-position', mobileAt), /margin-left:\s*-16px/);
  assert.match(cssRule(css, '.stock-position', mobileAt), /padding:\s*16px 16px 3px/);
});

test('個股研究森林工作面｜工作面與部位帶只用米色紙張底', async () => {
  const [css, sharedCss] = await Promise.all([
    readFile(new URL('public/stock-research.css', ROOT), 'utf8'),
    readFile(new URL('public/styles.css', ROOT), 'utf8')
  ]);

  assert.match(cssRule(css, 'body.stock-research-route'), /background-color:\s*var\(--bg\)/);
  assert.match(cssRule(css, '.stock-position'), /background:\s*var\(--card\)/);
  assert.match(cssRule(css, '.stock-valuation-row.base'), /background:\s*var\(--card-2\)/);
  assert.doesNotMatch(css, /background:\s*(?:color-mix\([^;]*--accent-soft|var\(--accent-soft\))/);
  assert.match(cssRule(css, '.stock-position .stock-eyebrow'), /color:\s*var\(--accent-hover\)/);
  assert.match(cssRule(css, '.stock-position-item .info-link'), /color:\s*var\(--accent-hover\)/);
  const background = cssHexToken(sharedCss, '--card');
  for (const token of ['--accent-hover', '--text-dim', '--pos', '--neg']) {
    assert.ok(
      contrastRatio(cssHexToken(sharedCss, token), background) >= 4.5,
      `${token} must keep 4.5:1 contrast on the position band`
    );
  }
});
