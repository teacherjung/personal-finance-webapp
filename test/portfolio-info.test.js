import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disciplineInfoHtml, totalValueInfoHtml } from '../public/modules/portfolio-info.js';

const formatMoney = value => `${value / 10_000} 萬`;

test('投資說明｜總市值列出股債金，並明說不含現金與融資', () => {
  const html = totalValueInfoHtml({
    total: 4_000_000,
    equity: 2_000_000,
    bond: 1_500_000,
    gold: 500_000
  }, { formatMoney });

  assert.match(html, /總市值 ＝ 股票市值 \+ 債券市值 \+ 黃金市值/);
  assert.match(html, /400 萬 ＝ 股票 200 萬 \+ 債券 150 萬 \+ 黃金 50 萬/);
  assert.match(html, /不包含現金，也不扣除融資/);
});

test('投資說明｜紀律檢查維持淨資產、穿透、軟上限與生存優先口徑', () => {
  const html = disciplineInfoHtml({
    stock: 5,
    equity: 90,
    country: 15,
    china: 12,
    lev: 1.3,
    maint: 25
  });

  assert.match(html, /% 淨資產/);
  assert.match(html, /國家曝險採<b>穿透<\/b>計算/);
  assert.match(html, /軟上限/);
  assert.match(html, /單一個股 5%・股票總曝險 90%・單一國家 15%（中國 12%）・IB 融資槓桿 1\.3x/);
  assert.match(html, /維持保證金率（25%/);
  assert.match(html, /即時自動強制平倉，不打電話、無寬限期/);
  assert.match(html, /要一個在所有環境都活著的系統/);
});
