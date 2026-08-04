import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { stockResearchViewHtml } from '../public/modules/stock-research-view.js';

const ROOT = new URL('../', import.meta.url);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

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

  assert.match(css, /\.stock-tab-panel\s*\{[\s\S]*?border:\s*2px solid var\(--frame\)/);
  assert.match(css, /\.stock-score-track\s*\{[\s\S]*?height:\s*13px[\s\S]*?border:\s*2px solid var\(--frame\)/);
  assert.match(css, /\.stock-empty-guide\s*\{[\s\S]*?width:\s*78px[\s\S]*?height:\s*78px/);
  assert.match(css, /@media \(max-width:\s*680px\)[\s\S]*?\.stock-position-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,/);
});
