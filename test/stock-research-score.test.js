import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isScoreItemComplete,
  scorecardResult,
  updateScoreHistory
} from '../public/modules/stock-research-score.js';

function completeScorecard(scores = {}) {
  return {
    business: 4,
    financial: 5,
    valuation: 2,
    evidence: 3,
    risk: 4,
    reasons: {
      business: '商業模式仍有優勢',
      financial: '現金流穩健',
      valuation: '估值高於歷史中位',
      evidence: '已有財報證據',
      risk: '部位仍在上限內'
    },
    ...scores
  };
}

test('個股研究評分｜五項完整時依 25/25/20/20/10 算成 73 分', () => {
  const result = scorecardResult(completeScorecard());

  assert.equal(result.complete, true);
  assert.equal(result.completed, 5);
  assert.equal(result.total, 73);
  assert.equal(result.displayText, '73 分');
});

test('個股研究評分｜五項都是 0 分但都有理由時，總分 0 是合法結果', () => {
  const scorecard = completeScorecard({
    business: 0,
    financial: 0,
    valuation: 0,
    evidence: 0,
    risk: 0
  });
  const result = scorecardResult(scorecard);

  assert.equal(result.complete, true);
  assert.equal(result.total, 0);
  assert.equal(result.displayText, '0 分');
  assert.equal(isScoreItemComplete(scorecard, 'business'), true);
});

test('個股研究評分｜缺分數或缺理由時只回完成數，不洩漏部分總分', () => {
  const scorecard = completeScorecard();
  delete scorecard.risk;
  scorecard.reasons.evidence = '   ';
  const result = scorecardResult(scorecard);

  assert.equal(result.complete, false);
  assert.equal(result.completed, 3);
  assert.equal(result.total, null);
  assert.equal(result.displayText, '已評 3／5 項');
});

test('個股研究評分｜字串、負數、小數、超過 5 與非有限數都不是合法分數', () => {
  const invalidValues = ['5', -1, 1.5, 6, Number.NaN, Number.POSITIVE_INFINITY, null];

  for (const value of invalidValues) {
    const result = scorecardResult(completeScorecard({ business: value }));
    assert.equal(result.complete, false, `value=${String(value)}`);
    assert.equal(result.total, null, `value=${String(value)}`);
    assert.equal(result.completed, 4, `value=${String(value)}`);
  }
});

test('個股研究評分｜未完成評分不新增歷史', () => {
  const history = [{ date: '2026-07-23', total: 50, scores: { business: 2, financial: 3, valuation: 2, evidence: 3, risk: 3 } }];
  const incomplete = completeScorecard();
  incomplete.reasons.risk = '';

  assert.deepEqual(updateScoreHistory(history, incomplete, '2026-07-24'), history);
});

test('個股研究評分｜首次完整評分新增一筆快照', () => {
  assert.deepEqual(updateScoreHistory([], completeScorecard(), '2026-07-24'), [{
    date: '2026-07-24',
    total: 73,
    scores: {
      business: 4,
      financial: 5,
      valuation: 2,
      evidence: 3,
      risk: 4
    }
  }]);
});

test('個股研究評分｜理由改寫但分數不變時不新增歷史', () => {
  const history = updateScoreHistory([], completeScorecard(), '2026-07-23');
  const rewritten = completeScorecard();
  rewritten.reasons.business = '換一句更完整的理由';

  assert.deepEqual(updateScoreHistory(history, rewritten, '2026-07-24'), history);
});

test('個股研究評分｜分數跨日實際變動時才追加新快照', () => {
  const first = updateScoreHistory([], completeScorecard(), '2026-07-23');
  const changed = completeScorecard({ valuation: 3 });
  const result = updateScoreHistory(first, changed, '2026-07-24');

  assert.equal(result.length, 2);
  assert.deepEqual(result[1], {
    date: '2026-07-24',
    total: 77,
    scores: {
      business: 4,
      financial: 5,
      valuation: 3,
      evidence: 3,
      risk: 4
    }
  });
});

test('個股研究評分｜同日多次變動只保留當天最後一筆', () => {
  const previous = updateScoreHistory([], completeScorecard(), '2026-07-23');
  const morning = updateScoreHistory(previous, completeScorecard({ valuation: 3 }), '2026-07-24');
  const evening = updateScoreHistory(morning, completeScorecard({ valuation: 4 }), '2026-07-24');

  assert.equal(evening.length, 2);
  assert.equal(evening.filter(entry => entry.date === '2026-07-24').length, 1);
  assert.equal(evening[1].total, 81);
  assert.equal(evening[1].scores.valuation, 4);
});

test('個股研究評分｜同日改回前一日分數時移除當日冗餘快照', () => {
  const previous = updateScoreHistory([], completeScorecard(), '2026-07-23');
  const changed = updateScoreHistory(previous, completeScorecard({ risk: 1 }), '2026-07-24');
  const reverted = updateScoreHistory(changed, completeScorecard(), '2026-07-24');

  assert.deepEqual(reverted, previous);
});

test('個股研究評分｜不存在的日曆日期不寫歷史，且不修改傳入陣列或巢狀 scores', () => {
  const history = Object.freeze([
    Object.freeze({
      date: '2026-07-23',
      total: 73,
      scores: Object.freeze({ business: 4, financial: 5, valuation: 2, evidence: 3, risk: 4 })
    })
  ]);
  const before = JSON.stringify(history);
  const invalidDate = updateScoreHistory(history, completeScorecard({ risk: 3 }), '2026-02-31');

  assert.deepEqual(invalidDate, history);
  assert.notEqual(invalidDate, history);
  assert.notEqual(invalidDate[0], history[0]);
  assert.notEqual(invalidDate[0].scores, history[0].scores);
  assert.equal(JSON.stringify(history), before);
});
