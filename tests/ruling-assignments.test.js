// A1 指派路由及歷史相容；不把範圍標籤當自然語言權限分類器。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/ruling-assignment-fixture.js');
const { assignmentsOf, assignmentOf, activeAt } = require('../tools/ruling-assignments.js');
const { evaluate, deciderOf, run, render } = require('../tools/pending-rulings.js');
const { gateRun } = require('../tools/gates/check-pending-rulings.js');
const { acceptedDate } = require('../tools/week-digest.js');
const check = (f) => evaluate(f.comments, deciderOf(f.settings), f.settings);

test('既有指派一次登記、標準裁示可接舊題；原題沒有指派行不需重問', () => {
  const f = fixture(), r = check(f);
  assert.equal(r.unsure, undefined); assert.equal(r.open.length, 0);
  assert.equal(r.ruled[0]?.by.ruler, 'Delta'); assert.equal(r.ruled[0]?.by.assignment.id, 'engineering');
  assert.match(render(r).join('\n'), /指定裁示者：Delta｜指派：engineering/u);
  assert.ok(render(r).join('\n').includes(f.settings.rulingAssignments[0].source));
  const q2 = f.make('q2', 3, '## ❓ 待裁（2026-10-18）：第二個工程問題\n裁示指派：engineering');
  const a2 = { ...f.answer, id: 'a2', createdAt: '2026-10-18T10:04:00Z', body: f.answer.body.replace('#c-q', '#c-q2') };
  f.comments.push(q2, a2); assert.equal(check(f).ruled.length, 2, '同一已授權範圍的後續題不需逐題另登本人授權');
});

test('無指派登記仍走舊裁示；預設裁示者與過去本人答案不被換掉', () => {
  const f = fixture(); delete f.settings.rulingAssignments;
  assert.equal(check(f).open.length, 1);
  f.answer.body = f.answer.body.replace('Delta 裁示', 'Boss 裁示').replace('裁示指派：engineering\n', ''); f.answer.author = 'boss-acct';
  assert.equal(check(f).ruled.length, 1);
  f.settings.rulingAssignments = fixture().settings.rulingAssignments;
  assert.equal(check(f).ruled.length, 1, '新增指派不使歷史本人答案失效');
  assert.equal(check(f).ruled[0]?.by.assignment, undefined);
  f.settings.participants[0].role = '擁有者（人）';
  assert.equal(deciderOf(f.settings).id, 'Boss', '無預設裁示者時依 A1 回到擁有者');
});

test('沒有正確指派、帳號、原話或日期的指定裁示，不關題', () => {
  for (const change of [
    (f) => { f.answer.body = f.answer.body.replace('裁示指派：engineering\n', ''); },
    (f) => { f.answer.body = f.answer.body.replace('engineering', 'unknown'); },
    (f) => { f.answer.body = f.answer.body.replace('原話（', '> 原話（'); },
    (f) => { f.answer.body = f.answer.body.replace('裁示指派：', '```\n裁示指派：'); },
    (f) => { f.answer.body += '\n裁示指派：engineering'; },
    (f) => { f.answer.author = 'ai-acct'; },
    (f) => { f.answer.author = 'outsider'; },
    (f) => { f.answer.body = f.answer.body.replace('2026-10-18', '2026-02-30'); },
    (f) => { f.answer.body = f.answer.body.replace('Delta 裁示', 'Other 裁示'); },
    (f) => { f.answer.body = f.answer.body.replace('原話（對話中，Alpha', '原話（對話中，Unknown'); },
  ]) { const f = fixture(); change(f); const r = check(f); assert.equal(r.unsure, undefined); assert.equal(r.open.length, 1); assert.equal(r.ruled.length, 0); assert.ok(r.near.length); }
});

test('原題明列另一指派或壞指派時不串題；本人仍可直接裁示', () => {
  for (const suffix of ['\n裁示指派：another', '\n裁示指派：', '\n裁示指派：engineering\n裁示指派：another']) {
    const f = fixture(); f.question.body += suffix; assert.equal(check(f).open.length, 1);
    f.answer.body = f.answer.body.replace('Delta 裁示', 'Boss 裁示').replace('裁示指派：engineering\n', ''); f.answer.author = 'boss-acct';
    assert.equal(check(f).open.length, 0);
  }
});

test('指派有效時間採半開區間；截止後答案不收，截止前歷史保留', () => {
  const f = fixture(); const a = f.settings.rulingAssignments[0];
  a.from = f.answer.createdAt; assert.equal(check(f).ruled.length, 1);
  a.from = '2026-10-18T10:03:00Z'; assert.equal(check(f).open.length, 1);
  a.from = '2026-10-01T00:00:00Z'; a.until = f.answer.createdAt; assert.equal(check(f).open.length, 1);
  a.until = '2026-10-18T10:03:00Z'; assert.equal(check(f).ruled.length, 1);
  assert.equal(activeAt(assignmentsOf(f.settings)[0], 'invalid'), false);
  f.answer.createdAt = '2026-10-18T10:00:00'; assert.ok(check(f).unsure);
});

test('指派設定缺省或空陣列合法；壞資料不是未啟用，必須明確拒絕', () => {
  assert.deepEqual(assignmentsOf({}), []);
  assert.deepEqual(assignmentsOf({ rulingAssignments: [] }), []);
  for (const change of [
    (f) => { f.settings.rulingAssignments = null; },
    (f) => { f.settings.rulingAssignments = {}; },
    (f) => { f.settings.rulingAssignments[0].extra = true; },
    (f) => { f.settings.rulingAssignments[0].id = '*'; },
    (f) => { f.settings.rulingAssignments.push({ ...f.settings.rulingAssignments[0] }); },
    (f) => { f.settings.rulingAssignments[0].scope = ''; },
    (f) => { f.settings.rulingAssignments[0].source = 'file:///tmp/source'; },
    (f) => { f.settings.rulingAssignments[0].decider = 'nobody'; },
    (f) => { f.settings.rulingAssignments[0].from = '2026-10-01'; },
    (f) => { f.settings.rulingAssignments[0].until = '2026-09-30T00:00:00Z'; },
    (f) => { f.settings.participants.push({ ...f.settings.participants[2] }); },
  ]) { const f = fixture(); change(f); assert.throws(() => assignmentsOf(f.settings), /裁示指派設定/u); assert.ok(check(f).unsure); }
});

test('D1、待裁閘共用指定裁示；錯路由維持阻擋、壞設定退 2', () => {
  const f = fixture(); const platform = { ask(op) { return op === 'change' ? { id: '7' } : f.comments; } };
  const options = { settings: f.settings, platform };
  assert.equal(run(options).code, 0); assert.match(run(options).lines.join('\n'), /指定裁示者：Delta/u);
  assert.equal(gateRun('7', options).code, 0); assert.match(gateRun('7', options).lines.join('\n'), /指定裁示者：Delta/u);
  f.question.body += '\n裁示指派：another'; assert.equal(gateRun('7', options).code, 1);
  f.settings.rulingAssignments = null; assert.equal(run(options).code, 2); assert.equal(gateRun('7', options).code, 2);
});

test('H6 沿原驗收規則，不因指定裁示答案或路由變成已驗收', () => {
  const f = fixture(); assert.equal(acceptedDate(f.comments, deciderOf(f.settings)), null);
  const a = f.make('h6', 3, '## ✅ 驗收（2026-10-18）：已看\n原話（對話中，Alpha 轉述）：**「看過了」**');
  assert.equal(acceptedDate([a], deciderOf(f.settings)), '10/18');
  assert.deepEqual(assignmentOf('> 範例\n裁示指派：engineering'), { id: null, invalid: false });
});

test('指定裁示者下的撤回如實署名，仍守三選一理由及原題指派', () => {
  const f = fixture(); f.answer.body = '## 🚫 撤回（2026-10-18）：問題消失\n裁示指派：engineering\n撤回理由：題目依附的東西沒了（該需求已取消）\nAlpha 撤回、Delta 未回；他隨時可以要我重問\nhttps://x.invalid/acme/kit/pull/7#c-q';
  f.answer.author = 'ai-acct';
  assert.equal(check(f).withdrawn.length, 1); assert.equal(check(f).ruled.length, 0);
  f.question.body += '\n裁示指派：another'; assert.equal(check(f).open.length, 1);
  f.question.body = f.question.body.replace('another', 'engineering');
  for (const [from, to] of [['題目依附的東西沒了', '不想等了'], ['Delta 未回', 'Boss 未回'], ['engineering', 'unknown']]) {
    const original = f.answer.body; f.answer.body = original.replace(from, to); assert.equal(check(f).open.length, 1); f.answer.body = original;
  }
  f.answer.author = 'outsider'; assert.equal(check(f).open.length, 1);
});


test('default 換人按答案當時判斷，舊無標記裁示保留；空窗回擁有者', () => {
  const f = fixture(); const source = f.settings.rulingAssignments[0];
  f.settings.rulingAssignments = [
    { ...source, id: 'default', from: null, until: '2026-10-18T10:03:00Z' },
    { ...source, id: 'default', decider: 'Alpha', from: '2026-10-18T10:03:00Z', until: '2026-10-18T10:05:00Z' },
  ];
  f.answer.body = f.answer.body.replace('裁示指派：engineering\n', '');
  const q2 = f.make('q2', 2, '## ❓ 待裁（2026-10-18）：換人後\n裁示指派：default');
  const a2 = f.make('a2', 3, f.answer.body.replace('Delta 裁示', 'Alpha 裁示').replace('#c-q', '#c-q2'));
  const q3 = f.make('q3', 4, '## ❓ 待裁（2026-10-18）：空窗');
  const a3 = f.make('a3', 5, f.answer.body.replace('Delta 裁示', 'Boss 裁示').replace('#c-q', '#c-q3'), 'boss-acct');
  f.comments.push(q2, a2, q3, a3);
  const result = check(f); assert.equal(result.open.length, 0);
  assert.deepEqual(result.ruled.map((x) => x.by.id), ['a', 'a2', 'a3']);
  assert.deepEqual(result.ruled.slice(0, 2).map((x) => x.by.ruler), ['Delta', 'Alpha']);
  f.settings.participants.reverse();
  assert.deepEqual(check(f).ruled.map((x) => x.by.id), ['a', 'a2', 'a3'], '角色表順序不決定歷史裁示');
  a2.body = a2.body.replace('Alpha 裁示', 'Delta 裁示'); a2.author = 'delegate-acct';
  assert.deepEqual(check(f).open.map((x) => x.id), ['q2'], '交接當刻只採新裁示者');
});

test('同一範圍可分期換人；重疊、重複與非 default 的未知起點拒收', () => {
  const f = fixture(), first = f.settings.rulingAssignments[0];
  first.until = '2026-10-18T10:02:00Z';
  f.settings.rulingAssignments.push({ ...first, from: first.until, until: null });
  assert.equal(check(f).ruled.length, 1);
  f.settings.rulingAssignments[1].from = '2026-10-18T10:01:00Z'; assert.ok(check(f).unsure);
  f.settings.rulingAssignments[1].from = null; assert.ok(check(f).unsure);
  f.settings.rulingAssignments = [{ ...first, id: 'default', from: null, until: null }, { ...first, id: 'default', from: null }];
  assert.ok(check(f).unsure);
});

test('舊預設只能唯一；無指派回 owner，歧義退 2 不依角色順序猜人', () => {
  const f = fixture(); delete f.settings.rulingAssignments;
  f.settings.participants[0].role = '擁有者'; f.settings.participants[2].role = '裁示者';
  f.answer.body = f.answer.body.replace('裁示指派：engineering\n', '');
  assert.equal(check(f).ruled.length, 1);
  f.settings.participants[1].role = '裁示者';
  const options = { settings: f.settings, platform: { ask: (op) => op === 'change' ? { id: '7' } : f.comments } };
  assert.equal(run(options).code, 2); assert.ok(check(f).unsure);
  f.settings.participants.reverse(); assert.equal(run(options).code, 2);
  for (const p of f.settings.participants) p.role = '參與者';
  assert.equal(deciderOf(f.settings).id, 'Boss');
});

test('owner 直接裁示優先於先到的指定答案；一般預設及撤回不能跨明列範圍', () => {
  const f = fixture(); f.question.body += '\n裁示指派：engineering';
  const owner = f.make('owner', 3, f.answer.body.replace('Delta 裁示', 'Boss 裁示').replace('裁示指派：engineering\n', ''), 'boss-acct');
  f.comments.push(owner); assert.equal(check(f).ruled[0]?.by.id, 'owner');
  f.comments = [f.question, owner];
  owner.body = '## 🚫 撤回（2026-10-18）：撤回\n撤回理由：問題本身問錯了（前提錯誤）\nAlpha 撤回、Boss 未回；他隨時可以要我重問\nhttps://x.invalid/acme/kit/pull/7#c-q';
  assert.equal(check(f).open.length, 1, '撤回沒有本人跨路由例外');
  const source = f.settings.rulingAssignments[0];
  f.settings.rulingAssignments.push({ ...source, id: 'default' });
  owner.body = f.answer.body.replace('裁示指派：engineering\n', ''); owner.author = 'delegate-acct';
  assert.equal(check(f).open.length, 1, '同一個人也要沿原題的具名路由回答');
  f.question.body = f.question.body.replace('engineering', 'default');
  assert.equal(check(f).ruled.length, 1);
});


test('舊題跨路由衝突保留待裁；owner 標頭不被壞指派行架空', () => {
  const f = fixture();
  f.settings.rulingAssignments.push({ ...f.settings.rulingAssignments[0], id: 'another' });
  const another = f.make('another', 3, f.answer.body.replace('engineering', 'another'), 'delegate-acct');
  f.comments.push(another);
  assert.equal(check(f).open.length, 1); assert.ok(check(f).near.some((x) => x.why.includes('跨路由')));
  another.body = another.body.replace('Delta 裁示', 'Boss 裁示').replace('裁示指派：another', '裁示指派：'); another.author = 'boss-acct';
  assert.equal(check(f).ruled[0]?.by.id, 'another'); assert.ok(check(f).near.some((x) => x.why.includes('本人裁示')));
});

test('範圍 A 換 B 再換 A 以當期選取，原題 id 不隨人名改動', () => {
  const f = fixture(); f.question.body += '\n裁示指派：engineering';
  const original = f.settings.rulingAssignments[0];
  f.settings.rulingAssignments = [
    { ...original, until: '2026-10-18T10:02:00Z' },
    { ...original, decider: 'Alpha', from: '2026-10-18T10:02:00Z', until: '2026-10-18T10:03:00Z' },
    { ...original, from: '2026-10-18T10:03:00Z' },
  ];
  f.answer.body = f.answer.body.replace('Delta 裁示', 'Alpha 裁示'); f.answer.author = 'ai-acct';
  assert.equal(check(f).ruled[0]?.by.ruler, 'Alpha');
  f.answer.createdAt = '2026-10-18T10:03:00Z'; assert.equal(check(f).open.length, 1);
  f.answer.body = f.answer.body.replace('Alpha 裁示', 'Delta 裁示'); f.answer.author = 'delegate-acct';
  assert.equal(check(f).ruled[0]?.by.ruler, 'Delta');
  delete f.settings.owner; assert.ok(check(f).unsure, '啟用新指派必須登記 owner，不能拿舊預設冒充本人');
});

test('開工摘要顯示當期人選與來源，終止範圍不當作現在有效', () => {
  const { routingSummary } = require('../tools/ruling-assignments.js');
  const f = fixture(); const source = f.settings.rulingAssignments[0];
  f.settings.rulingAssignments.push({ ...source, id: 'default' });
  const during = routingSummary(f.settings, '2026-10-18T10:02:00Z').join('\n');
  assert.match(during, /擁有者：Boss｜預設模式：明確時間表｜目前預設：Delta/u);
  assert.ok(during.includes(`範圍裁示｜engineering：Delta`)); assert.ok(during.includes(source.source));
  for (const a of f.settings.rulingAssignments) a.until = '2026-10-18T10:03:00Z';
  const after = routingSummary(f.settings, '2026-10-18T10:03:00Z').join('\n');
  assert.match(after, /目前預設：Boss/u); assert.ok(!after.includes('範圍裁示｜engineering'));
});


test('純舊設定未登 owner 可認預設答案，但不能冒充本人跨路由', () => {
  const f = fixture(); delete f.settings.rulingAssignments; delete f.settings.owner;
  f.settings.participants[0].role = '參與者'; f.settings.participants[2].role = '裁示者';
  f.answer.body = f.answer.body.replace('裁示指派：engineering\n', '');
  assert.equal(deciderOf(f.settings).ownerId, null);
  assert.equal(check(f).ruled.length, 1); assert.equal(check(f).ruled[0].by.ownerRuling, false);
  f.question.body += '\n裁示指派：unknown'; assert.equal(check(f).open.length, 1);
});


test('首次 default 遷移不能漏仍登記的舊預設，既有歷史段可用真起點', () => {
  const f = fixture(), original = f.settings.rulingAssignments[0];
  f.settings.participants[0].role = '擁有者'; f.settings.participants[2].role = '裁示者';
  f.answer.body = f.answer.body.replace('裁示指派：engineering\n', '');
  f.settings.rulingAssignments = [{ ...original, id: 'default', decider: 'Alpha', from: '2026-11-01T00:00:00Z' }];
  assert.throws(() => assignmentsOf(f.settings), /缺少仍登記的舊預設/u); assert.ok(check(f).unsure);
  f.settings.rulingAssignments.push({ ...original, id: 'default', until: '2026-11-01T00:00:00Z' });
  assert.equal(check(f).ruled[0]?.by.ruler, 'Delta');
  f.settings.rulingAssignments[1].from = null; assert.equal(check(f).ruled.length, 1);
  f.settings.participants.reverse(); assert.equal(check(f).ruled.length, 1);
});


test('未填或辨不出 owner 的舊設定仍可裁示，但不取得本人優先或新指派資格', () => {
  for (const owner of ['未設定', 'Unknown', 'Boss']) {
    const f = fixture(); delete f.settings.rulingAssignments;
    f.settings.owner = owner;
    f.settings.participants[0].role = '參與者'; f.settings.participants[2].role = '裁示者';
    if (owner === 'Boss') f.settings.participants.push({ ...f.settings.participants[0] });
    f.answer.body = f.answer.body.replace('裁示指派：engineering\n', '');
    const decider = deciderOf(f.settings);
    assert.ok(decider, '已填的舊裁示者須可辨認');
    assert.equal(decider.id, 'Delta'); assert.equal(decider.ownerId, null);
    assert.equal(check(f).ruled.length, 1); assert.equal(check(f).ruled[0].by.ownerRuling, false);
    const options = { settings: f.settings, platform: { ask: (op) => op === 'change' ? { id: '7' } : f.comments } };
    assert.equal(gateRun('7', options).code, 0);
    f.question.body += '\n裁示指派：unknown'; assert.equal(gateRun('7', options).code, 1);
    f.settings.rulingAssignments = fixture().settings.rulingAssignments;
    assert.equal(deciderOf(f.settings), null); assert.equal(gateRun('7', options).code, 2);
  }
});

test('像指派的壞行不退回預設；提問、指定答案與撤回共用拒收', () => {
  const badLines = ['- 裁示指派：engineering', '  裁示指派：engineering', '裁示指派:engineering',
    '裁示指派：engineering ', '裁示指派', '**裁示指派**：engineering', '1. 裁示指派：engineering',
    '    裁示指派：engineering', '\t裁示指派：engineering', '> 裁示指派：engineering',
    '- [ ] 裁示指派：engineering', '裁示指派：engineering\n- 裁示指派：engineering',
    ...['・', '  ・', '「', '一、', '１.', '１．', '•', '『', '（', '【', '①', '＞', '※',
      '⚠️ ', '👩‍💻 ', '1️⃣ ', '\u200b', '\u0301', '\u0085', '（一）a) ', '- [ ]（壹佰）', 'a.', 'Z）', '〇、', '※〇、']
      .map((prefix) => prefix + '裁示指派：engineering'),
    '「裁示指派：engineering」', '裁示指派️：engineering', '裁示指派）：engineering'];
  for (const line of badLines) {
    const f = fixture();
    f.settings.rulingAssignments.push({ ...f.settings.rulingAssignments[0], id: 'default', decider: 'Alpha' });
    const defaultAnswer = { ...f.answer, author: 'ai-acct', body: f.answer.body.replace('Delta 裁示', 'Alpha 裁示').replace('裁示指派：engineering\n', '') };
    const withdrawal = { ...f.answer, author: 'ai-acct', body: '## 🚫 撤回（2026-10-18）：前提錯誤\n'
      + '撤回理由：問題本身問錯了（對象寫錯）\nAlpha 撤回、Alpha 未回；他隨時可以要我重問\nhttps://x.invalid/acme/kit/pull/7#c-q' };
    const gate = (comments) => gateRun('7', { settings: f.settings, platform: { ask: (op) => op === 'change' ? { id: '7' } : comments } }).code;
    for (const reply of [defaultAnswer, withdrawal]) {
      const comments = [f.question, reply];
      assert.equal(gate(comments), 0, '對照組確實可由非本人預設答案或撤回關題');
      f.question.body += '\n' + line;
      assert.equal(assignmentOf(f.question.body).invalid, true, line);
      const result = check({ ...f, comments });
      assert.equal(result.open.length, 1, line); assert.ok(result.near.some((x) => x.why.includes('指派行不合範本')));
      assert.equal(gate(comments), 1, line);
      assert.equal(check(f).open.length, 1, '同範圍答案也不能替壞指派行補猜');
      f.question.body = fixture().question.body;
      // 必填行先到齊，才能證明停止行的拒收不是碰巧被缺原話或缺網址擋下。
      reply.body += '\n' + line;
      assert.equal(check({ ...f, comments }).open.length, 1, line);
      assert.equal(gate(comments), 1, line);
    }
  }
});

test('候選辨認保留普通正文與停止邊界，只准原文精確行授權', () => {
  for (const line of ['正文提到裁示指派：engineering', '請用裁示指派：engineering', '不要填裁示指派：engineering',
    'example 裁示指派：engineering', 'Alpha. 裁示指派：engineering', 'a 裁示指派：engineering',
    '一裁示指派：engineering', '〇裁示指派：engineering', '※〇裁示指派：engineering', '裁示指派流程：engineering']) {
    assert.deepEqual(assignmentOf(line), { id: null, invalid: false }, line);
  }
  assert.deepEqual(assignmentOf('裁示指派：engineering'), { id: 'engineering', invalid: false });
  assert.deepEqual(assignmentOf('> 範例\n・裁示指派：engineering'), { id: null, invalid: false });
  assert.deepEqual(assignmentOf('裁示指派：engineering\n> 範例\n・裁示指派：another'), { id: 'engineering', invalid: false });
  assert.equal(assignmentOf('裁示指派：engineering\n・裁示指派：another').invalid, true);
});
