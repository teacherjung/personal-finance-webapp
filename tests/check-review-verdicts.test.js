// 守結論聯集閘（規矩 F4、F5、F7、F12）。原專案實測：同一支變更上兩則都自稱同一角色的複審、結論相反，
// 平台上顯示同一個帳號、無法分辨——「最後一則說通過」變成事實上的放行。
//
// 守得到的：
//   ①取聯集：任一位的阻擋在同一位用更高輪次撤銷前都有效，別人說通過解不掉；
//   ②同一位同輪次相反結論＝fail-closed（結果不可以取決於留言順序）；
//   ③版本一變舊通過失效；放行只認PR說明指定的那一位；讀不出指定誰＝不放行；沒有任何結論＝不放行；
//   ④標頭：只認第一行、不認引用、來源不可空、角色要在名單上、結論只認三種；
//   ⑤有 🤖 記號但標頭讀不出＝擋；作廢行（緊跟合規標頭之後）可把它降為提醒——
//     但作廢不了合規留言、作廢不了不存在的、作廢不了比自己晚的，而且作廢不產生任何結論；
//   ⑥沒標頭但看起來像結論＝只提醒，不影響退出碼；兩個來源長得像＝提醒、不併身分；
//   ⑦平台問不到、設定沒填＝退 2；
//   ⑧先後看留言時間不看清單順序（r1 Medium⑩）：清單反過來給也判得一樣；同一刻證明不了先後＝作廢不生效；時間讀不出＝退 2。
//   ⑨同一位同輪次對**不同版本**各給結論＝不明、擋（r2 Medium⑤：原本同為通過時先遇到哪一則就用哪一則，
//     清單順序改變判決）；判決與清單順序無關，每一種排列都要判一樣。
//   ⑩找 🤖 讀整份原文、什麼都不剝（r5：每一種剝法都在正常寫法上吞過看得見的 🤖）；「像不像結論」的提醒與指定的複審者
//     只讀開頭那一段（tools/markdown-effective.js）；圍欄與引用裡的標頭不是結論，但裡面的 🤖 算壞標頭（救法是作廢）；
//   ⑪同輪的版本碼用集合聚合（r3 Medium③）：短碼相容不可傳遞，三則短長碼的六種排列都要判一樣；
//   ⑫時間沒帶時區不收（r3 High①）：同一份留言在不同執行時區判一樣。
//   ⑬「通過」要帶兩行固定小標（F7）：缺了那則不算數、撤不了自己先前的阻擋；只缺一行就點名那一行；小標逐字（多了字、放進引用都不算，
//     行尾空白與 CR 換行可以）；阻擋不要求；重貼合格的就放行；它算數會改變結果時（會撤掉自己較低輪的阻擋、或會是指定那一位
//     對目前版本的通過）才列成擋下的原因，否則只提醒；缺小標的通過裡的作廢行照樣生效；現況那一行照實列出不算數的那則。
//   ⑭文字快速通道（F12）：專案設定登記的擁有者（owner 那一欄，要是參與者，去前後空白比）的通過不要求小標；認擁有者不認裁示者
//     （裁示者指定給 AI 時，那個 AI 的通過照樣要小標、擁有者的原話照樣接受）；沒登記＝不豁免，訊息提醒先登記、不要替他的原話補小標；AI 的通過不跟著豁免。
// ⚠️ 更正一句錯的自陳：上一版這裡寫「拿掉排序是等價突變」。複審者用反例推翻（舊版本 01:00、目前版本 02:00、
//    反序餵入：有排序退 1、沒排序退 0）——當時同輪同結論異版本是「先遇到哪一則就用哪一則」，排序決定了誰先。
//    現在同輪異版本一律判不明，**判決**跟順序無關（⑨那題把每一種排列都跑一遍、比對整份 problems）。
//    排序仍然不是等價突變：它決定訊息裡兩個版本的先後（照時間），拿掉會讓 ⑨ 的訊息比對紅——
//    所以它是「訊息確定性」的零件，不是判決的依據。兩句都照實寫，不再宣稱「等價」。
//
// ⚠️ 守不到的：小標底下寫了什麼（只核那兩行在不在）；圍欄或 HTML 註解裡的小標行也算；這支PR是不是真的只改了文字（擁有者的通過在任何PR都豁免，
//    要靠協作欄位寫的複審者）；標頭是自我宣告不是身分證明（改來源就能冒充另一位）；留言清單有沒有少給
//    （分頁是那條登記指令的責任）；作廢比原專案寬——任何一位都能作廢任何壞留言（裁示者裁的方向）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { gateRun, evaluate, headerOf, hasBotMark, looksLikeVerdict, voidTargets, sourceLookalike, VERDICTS } = require('../tools/gates/check-review-verdicts.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const ROLES = ['Alpha', 'Beta', 'Gamma'];
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '0123456789abcdef0123456789abcdef01234567';

let seq = 0;
/** 一則留言。 */
const c = (body, id = `c${++seq}`) => ({ id, body, createdAt: new Date(Date.UTC(2026, 8, 13, 0, 0, seq)).toISOString() });
/** 「通過」那一則要帶的兩行固定小標（F7）；預設帶上，headings: false 才拿掉。 */
const HEADINGS = '\n\n### 本輪實際用的設定\n模型、推理、跑了哪些考題\n\n### 清單逐項結果\n每一項的結果';
/** 一則帶合規標頭的結論留言。 */
const verdict = ({ role = 'Beta', source = 'CLI', sha = HEAD, round = 1, verdict: v = '通過', extra = '', headings = true } = {}, id) =>
  c(`🤖 ${role}｜來源：${source}｜審 \`${sha.slice(0, 7)}\`｜r${round}｜結論：${v}${extra}${v === '通過' && headings ? HEADINGS : ''}`, id);

test('基準：指定的那一位對目前版本說通過、沒人阻擋＝通過（對照組）', () => {
  const r = evaluate([verdict()], HEAD, 'Beta', ROLES);
  assert.deepEqual(r.problems, [], r.problems.join('\n'));
});

test('①取聯集：Alpha 阻擋、Beta 通過＝仍然擋；只有 Alpha 自己用更高輪次才能撤', () => {
  const block = verdict({ role: 'Alpha', source: '桌面', verdict: '需修改後再審' });
  const pass = verdict({ role: 'Beta' });
  const r = evaluate([block, pass], HEAD, 'Beta', ROLES);
  assert.ok(r.problems.some((p) => p.includes('還沒有被同一位撤銷')), '別人說通過解不掉');
  const retract = verdict({ role: 'Alpha', source: '桌面', round: 2 });
  assert.deepEqual(evaluate([block, pass, retract], HEAD, 'Beta', ROLES).problems, []);
  // 同輪次補發不算撤銷
  const sameRound = verdict({ role: 'Alpha', source: '桌面', round: 1 });
  assert.ok(evaluate([block, pass, sameRound], HEAD, 'Beta', ROLES).problems.length > 0, '同輪次相反結論不可以放行');
});

test('②同一位同輪次相反結論＝擋，而且不取決於順序', () => {
  const a = verdict({ role: 'Beta', round: 3, verdict: '需修改後再審' });
  const b = verdict({ role: 'Beta', round: 3, verdict: '通過' });
  for (const order of [[a, b], [b, a]]) {
    const r = evaluate(order, HEAD, 'Beta', ROLES);
    assert.ok(r.problems.some((p) => p.includes('相反結論')), '兩種順序都要擋');
  }
});

test('③版本一變舊通過失效；放行只認指定的那一位；讀不出指定誰＝不放行；沒結論＝不放行', () => {
  const stale = evaluate([verdict({ sha: OLD })], HEAD, 'Beta', ROLES);
  assert.ok(stale.problems.some((p) => p.includes('不再適用')), '舊版本的通過不算');
  // ⚠️ 兩道檢查互為備援（突變驗過：拿掉其中一道，退出碼不變）。釘訊息是為了讓兩句都在——
  //    「沒有人對目前版本點頭」與「那則通過是對舊版本說的」是給人看的兩件不同的事。
  assert.ok(stale.problems.some((p) => p.includes('沒有「Beta」對目前版本')), '要說目前版本沒人點頭');
  assert.equal(stale.problems.length, 2);
  const wrongOne = evaluate([verdict({ role: 'Alpha' })], HEAD, 'Beta', ROLES);
  assert.ok(wrongOne.problems.some((p) => p.includes('放行只認指定的那一位')), '實作者自己說通過不算');
  const unknown = evaluate([verdict()], HEAD, null, ROLES);
  assert.ok(unknown.problems.some((p) => p.includes('讀不出')), '讀不出指定誰就不放行');
  const none = evaluate([c('大家好')], HEAD, 'Beta', ROLES);
  assert.ok(none.problems.some((p) => p.includes('沒有「Beta」')), '沒有任何結論不可以放行');
});

test('④標頭：只認第一行、不認引用、來源不可空、角色要在名單上、結論只認三種', () => {
  assert.ok(headerOf(`🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過`, ROLES));
  assert.equal(headerOf(`前言\n🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過`, ROLES), null, '不是第一行');
  assert.equal(headerOf(`> 🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過`, ROLES), null, '引用不算');
  assert.equal(headerOf(`🤖 Beta｜來源：   ｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過`, ROLES), null, '來源空白');
  assert.equal(headerOf(`🤖 Betta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過`, ROLES), null, '打錯的角色不可以變成幽靈審查者');
  assert.equal(headerOf(`🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：大概可以`, ROLES), null, '結論不是三選一');
  assert.equal(headerOf(`🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：toString`, ROLES), null, '原型鍵不可以變成第四種結論');
  const h = headerOf(`**🤖 Beta｜來源：CLI   xhigh｜審 ${HEAD.slice(0, 7)}｜r2｜結論：不可合併。**`, ROLES);
  assert.equal(h.source, 'CLI xhigh', '來源摺疊空白');
  assert.equal(h.verdict, '不可合併', '尾端句號要剝掉');
  assert.equal(h.blocking, true);
  assert.deepEqual(Object.keys(VERDICTS), ['通過', '需修改後再審', '不可合併'], '三個字串是規矩 F3 逐字要求的');
});

test('⑤有 🤖 但標頭讀不出＝擋；作廢可降為提醒；作廢的邊界', () => {
  const bad = c('🤖 Beta｜來源：CLI｜審 ｜r1｜結論：要求修改', 'bad1');
  const good = verdict({ round: 2 });
  const blocked = evaluate([bad, good], HEAD, 'Beta', ROLES);
  assert.ok(blocked.problems.some((p) => p.includes('標頭格式不合規') && p.includes('bad1')), '壞標頭要擋，而且要點名編號');

  const voider = verdict({ role: 'Alpha', round: 2, extra: '\n\n作廢上一則：bad1\n本輪提了 0 條' });
  const cleared = evaluate([bad, good, voider], HEAD, 'Beta', ROLES);
  assert.deepEqual(cleared.problems, [], cleared.problems.join('\n'));
  assert.ok(cleared.warnings.some((w) => w.includes('已被') && w.includes('作廢')), '降為提醒');

  // 作廢不產生結論：作廢者 Alpha 自己的結論照舊是它標頭那一則；壞留言不會變成任何結論
  assert.equal(Object.keys(cleared.reviewers).length, 2);

  // 作廢不了合規留言
  const voidGood = verdict({ role: 'Alpha', round: 2, extra: `\n作廢上一則：${good.id}` });
  const r1 = evaluate([bad, good, voidGood], HEAD, 'Beta', ROLES);
  assert.ok(r1.problems.some((p) => p.includes('bad1')), '壞留言沒被作廢，仍要擋');
  assert.ok(r1.warnings.some((w) => w.includes('不是壞標頭')));
  assert.ok(Object.keys(r1.reviewers).length === 2, '合規留言不可以被作廢掉');

  // 作廢不了不存在的、作廢不了比自己晚的
  const voidNone = verdict({ role: 'Alpha', round: 2, extra: '\n作廢上一則：nope' });
  assert.ok(evaluate([bad, voidNone], HEAD, 'Beta', ROLES).warnings.some((w) => w.includes('沒有那一則')));
  // 「預先作廢」＝作廢者的**時間**比壞留言早（r1 之後先後看時間、不看清單順序）
  const early = { ...verdict({ role: 'Alpha', round: 2, extra: '\n作廢上一則：bad1' }), createdAt: '2026-09-12T00:00:00Z' };
  const r3 = evaluate([early, bad, good], HEAD, 'Beta', ROLES);
  assert.ok(r3.problems.some((p) => p.includes('bad1')), '預先作廢不生效');
  assert.ok(r3.warnings.some((w) => w.includes('不比作廢宣告早')));

  // 作廢行要緊跟在標頭後面：中間夾了別的內容就不算
  const misplaced = verdict({ role: 'Alpha', round: 2, extra: '\n本輪提了 0 條\n作廢上一則：bad1' });
  assert.ok(evaluate([bad, good, misplaced], HEAD, 'Beta', ROLES).problems.some((p) => p.includes('bad1')));
  assert.deepEqual(voidTargets('🤖 x\n\n作廢上一則：a\n作廢上一則：b\n別的\n作廢上一則：c'), ['a', 'b']);
  // 沒帶合規標頭的留言裡的作廢行不生效
  const noHeader = c('作廢上一則：bad1');
  assert.ok(evaluate([bad, good, noHeader], HEAD, 'Beta', ROLES).problems.some((p) => p.includes('bad1')));
});

test('⑤hasBotMark：整份原文有 🤖 就算，什麼都不剝（r5：每一種剝法都在正常寫法上吞過看得見的 🤖）', () => {
  assert.equal(hasBotMark('我要試 🤖 這個'), true);
  assert.equal(hasBotMark('> 🤖 引用別人的'), true, '引用裡的也算（範本：非結論留言不可含 🤖）');
  assert.equal(hasBotMark('說明：`🤖` 這個記號'), true, '行內程式碼裡的也算');
  assert.equal(hasBotMark('```\n🤖 範例\n```'), true, '圍欄裡的也算');
  assert.equal(hasBotMark('<!--\n🤖 藏起來的\n-->'), true, '註解裡的也算');
  assert.equal(hasBotMark('沒有記號的留言'), false, '對照組');
  assert.equal(hasBotMark(null), false);
});

test('⑥沒標頭但看起來像結論＝只提醒；長得像的來源＝提醒不併身分', () => {
  const r = evaluate([c('我的看法：不可合併，還有假綠'), verdict()], HEAD, 'Beta', ROLES);
  assert.deepEqual(r.problems, [], '沒標頭的留言不影響結果');
  assert.ok(r.warnings.some((w) => w.includes('不採計')));
  assert.equal(looksLikeVerdict('```\n不可合併\n```'), false, '圍欄開頭就停，範例不提醒（只影響提醒）');
  assert.equal(looksLikeVerdict('> 不可合併'), false, '引用開頭就停，不提醒');
  assert.equal(looksLikeVerdict('說明：`不可合併` 是三選一之一'), false, '行內程式碼裡的不提醒');
  assert.equal(looksLikeVerdict('測試全綠'), false);

  const a = verdict({ role: 'Beta', source: 'codex CLI (xhigh)', verdict: '需修改後再審' });
  const b = verdict({ role: 'Beta', source: 'CLI（xhigh）', round: 2 });
  const two = evaluate([a, b], HEAD, 'Beta', ROLES);
  assert.ok(two.problems.some((p) => p.includes('還沒有被同一位撤銷')), '兩種寫法＝兩位，阻擋沒被撤');
  assert.ok(two.warnings.some((w) => w.includes('可能是同一位')), '要提醒');
  assert.equal(sourceLookalike('CLI', 'codex CLI'), '折全形、轉小寫、只留字母與數字之後，其中一個整個包在另一個裡面');
  assert.equal(sourceLookalike('桌面', '桌面版'), null, '太短不比');
  assert.equal(sourceLookalike('codex CLI', 'claude desktop'), null);
});

/** 假平台 */
function fakePlatform(answers) {
  return {
    ask(op) {
      const a = answers[op];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new PlatformError(`測試沒給 ${op}`);
      return a;
    },
  };
}
const settings = { participants: ROLES.map((id) => ({ id })) };
const change = (over = {}) => ({ headSha: HEAD, body: '- **實作者**：Alpha\n- **複審者**：Beta', ...over });

test('端到端：指定的複審者從PR說明讀；通過＝0、有阻擋＝1、提醒不影響退出碼', () => {
  const ok = gateRun('7', { settings, platform: fakePlatform({ change: change(), comments: [verdict(), c('不可合併？我只是問')] }) });
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  assert.ok(ok.lines.some((l) => l.startsWith('提醒')), '提醒要印出來');
  const bad = gateRun('7', { settings, platform: fakePlatform({ change: change(), comments: [verdict({ role: 'Alpha' })] }) });
  assert.equal(bad.code, 1);
  assert.match(bad.lines.join('\n'), /放行只認指定的那一位/u);
});

test('平台問不到＝退 2；設定沒填＝退 2；沒給編號＝退 2；不是平台的錯就炸出去', () => {
  assert.equal(gateRun('7', { settings, platform: fakePlatform({ change: new PlatformError('x') }) }).code, 2);
  assert.equal(gateRun('7', { settings, platform: fakePlatform({ change: change(), comments: new PlatformError('x') }) }).code, 2);
  assert.equal(gateRun('7', { settings: { participants: [{ id: 'Alpha' }] }, platform: fakePlatform({}) }).code, 2);
  assert.equal(gateRun(undefined, { settings, platform: fakePlatform({}) }).code, 2);
  assert.throws(() => gateRun('7', { settings, platform: fakePlatform({ change: new TypeError('程式寫錯') }) }), TypeError);
});

test('真的跑一遍指令（空白設定的複本，不讀本倉庫那份）：設定未填，退 2', () => {
  assert.equal(runInCopy('tools/gates/check-review-verdicts.js', ['7']).status, 2);
  assert.equal(runInCopy('tools/gates/check-review-verdicts.js').status, 2);
});

test('⑧先後看留言時間：清單反過來給也判得一樣；同一刻＝作廢不生效；時間讀不出＝退 2', () => {
  const bad = c('🤖 Beta｜來源：CLI｜審 ｜r1｜結論：要求修改', 'bad1');
  const good = verdict({ round: 2 });
  const voider = verdict({ role: 'Alpha', round: 2, extra: '\n\n作廢上一則：bad1' });
  const forward = evaluate([bad, good, voider], HEAD, 'Beta', ROLES);
  const reversed = evaluate([voider, good, bad], HEAD, 'Beta', ROLES);
  assert.deepEqual(forward.problems, []);
  assert.deepEqual(reversed.problems, forward.problems, '清單順序不可以改變判決');
  // 作廢者的時間比壞留言早＝預先作廢，不生效
  const early = { ...voider, createdAt: '2026-09-12T00:00:00Z' };
  assert.ok(evaluate([bad, good, early], HEAD, 'Beta', ROLES).problems.some((p) => p.includes('bad1')));
  // 同一刻＝證明不了先後＝不生效
  const same = { ...voider, createdAt: bad.createdAt };
  const r = evaluate([bad, good, same], HEAD, 'Beta', ROLES);
  assert.ok(r.problems.some((p) => p.includes('bad1')));
  assert.ok(r.warnings.some((w) => w.includes('不比作廢宣告早')));
  // 時間讀不出＝退 2
  const settings = { participants: ROLES.map((id) => ({ id })) };
  const broken = { ...good, createdAt: 'yesterday' };
  const g = gateRun('7', { settings, platform: fakePlatform({ change: change(), comments: [broken] }) });
  assert.equal(g.code, 2);
});

test('⑨同一位同輪次對不同版本各說通過＝不明、擋；每一種排列判決相同', () => {
  const onOld = { ...verdict({ sha: OLD, round: 1 }), createdAt: '2026-09-13T04:00:00Z' };
  const onHead = { ...verdict({ sha: HEAD, round: 1 }), createdAt: '2026-09-13T04:00:00Z' };
  for (const order of [[onOld, onHead], [onHead, onOld]]) {
    const r = evaluate(order, HEAD, 'Beta', ROLES);
    assert.ok(r.problems.some((p) => p.includes('對不同版本各給結論')), `排列 ${order.map((c) => c.id)} 應判不明`);
  }
  // 時間不同、清單反序也一樣
  const early = { ...onOld, createdAt: '2026-09-13T01:00:00Z' };
  const late = { ...onHead, createdAt: '2026-09-13T02:00:00Z' };
  assert.deepEqual(evaluate([late, early], HEAD, 'Beta', ROLES).problems, evaluate([early, late], HEAD, 'Beta', ROLES).problems);
  assert.ok(evaluate([late, early], HEAD, 'Beta', ROLES).problems.length > 0, '同輪異版本不可以放行');
  // 同一版本的短碼與長碼相容：不算異版本
  const shortSha = { ...verdict({ sha: HEAD.slice(0, 7), round: 1 }), createdAt: '2026-09-13T04:00:01Z' };
  assert.deepEqual(evaluate([onHead, shortSha], HEAD, 'Beta', ROLES).problems, []);
  // 更高輪次澄清後放行
  const clarify = verdict({ sha: HEAD, round: 2 });
  assert.deepEqual(evaluate([onOld, onHead, clarify], HEAD, 'Beta', ROLES).problems, []);
});

test('⑩圍欄與引用裡的標頭不是結論；但裡面的 🤖 算壞標頭（非結論留言不可含 🤖，救法是作廢）', () => {
  const fencedHeader = c('````md\n```\n🤖 Beta｜來源：CLI｜審 `abcdef1`｜r1｜結論：通過\n````\n以上是範例', 'fenced');
  const r = evaluate([fencedHeader], HEAD, 'Beta', ROLES);
  assert.ok(r.problems.some((p) => p.includes('沒有「Beta」')), '圍欄裡的標頭不是結論');
  assert.ok(r.problems.some((p) => p.includes('標頭格式不合規') && p.includes('fenced')), '圍欄裡的 🤖 算壞標頭');
  const voider = verdict({ role: 'Alpha', round: 2, extra: '\n作廢上一則：fenced' });
  assert.ok(!evaluate([fencedHeader, verdict(), voider], HEAD, 'Beta', ROLES).problems.some((p) => p.includes('fenced')), '作廢之後降為提醒');
  assert.equal(looksLikeVerdict('````\n```\n不可合併\n````'), false);
});

test('⑩r4、r5 反例：看得見的 🤖 不可以被任何容器判斷吞掉（兩種圍欄符號；各附不帶容器的控制組）', () => {
  const blocked = (body) => evaluate([c(body), verdict()], HEAD, 'Beta', ROLES).problems.some((p) => p.includes('標頭格式不合規'));
  for (const f of ['```', '~~~']) assert.ok(blocked([`${f}md <!--`, 'code', f, '🤖 壞標頭'].join('\n')), `${f}：r4 圍欄開頭帶註解記號`);
  assert.ok(blocked('審查備註 <!-- 版本碼請用 ` 包住 -->：🤖 Beta 的結論需修改後再審，先重跑 `node --test`。'), 'r5①：註解裡的反引號跟後面的配對');
  assert.ok(blocked('```node --test```\n\n🤖 壞標頭'), 'r5②：單行三反引號');
  assert.ok(blocked('> 上輪建議\n## 本輪結論\n🤖 Beta｜來源：CLI｜審 `abcdef1`｜r2｜結論：需修改後再審'), 'r5③：引用後直接接標題');
  assert.ok(blocked('<!--\n> 舊說明\n-->\n🤖 壞標頭'), 'r5 待辦：HTML 區塊');
  assert.ok(blocked('說明\n🤖 壞標頭'), '控制組：前面沒有任何容器');
  assert.ok(!blocked('說明\n沒有記號'), '控制組：沒有 🤖 就不擋');
});

test('⑩指定的複審者只從說明開頭那一段讀；讀不到就不放行', () => {
  const run = (body) => gateRun('7', { settings, platform: fakePlatform({ change: change({ body }), comments: [verdict()] }) });
  const quoteFirst = run('> 上輪建議\n## 協作欄位\n- **實作者**：Alpha\n- **複審者**：Beta');
  assert.equal(quoteFirst.code, 1, quoteFirst.lines.join('\n'));
  assert.match(quoteFirst.lines.join('\n'), /讀不出PR說明指定的複審者/u);
  assert.match(quoteFirst.lines.join('\n'), /第 1 行就停了/u, 'r6 Low②：結論閘自己也說停在第幾行');
  const later = run('- **實作者**：Alpha\n- **複審者**：Beta\n<!-- 附註 -->');
  assert.equal(later.code, 0, `控制組：欄位在前、註解在後：${later.lines.join('\n')}`);
});

test('⑪短碼相容不可傳遞：abcdef1／abcdef12／abcdef13 同輪各說通過，六種排列全部判不明', () => {
  const head12 = 'abcdef12' + '0'.repeat(32);
  // ⚠️ 這裡不能用 verdict()：它把版本碼切成七碼，三個樣本就變成同一個字（第一版考題就這樣假綠過）
  const mk = (sha) => ({ ...c(`🤖 Beta｜來源：CLI｜審 \`${sha}\`｜r1｜結論：通過${HEADINGS}`), createdAt: '2026-09-13T04:00:00Z' });
  const a = mk('abcdef1'); const b = mk('abcdef12'); const d = mk('abcdef13');
  const perms = [[a, b, d], [a, d, b], [b, a, d], [b, d, a], [d, a, b], [d, b, a]];
  for (const p of perms) {
    const r = evaluate(p, head12, 'Beta', ROLES);
    assert.ok(r.problems.some((x) => x.includes('對不同版本各給結論')), `排列 ${p.map((c) => c.body.match(/審 `([^`]+)`/)[1])} 應判不明`);
  }
  // 只有相容的短碼＋長碼：兩種排列都放行，代表值取最長的那一個
  for (const p of [[a, b], [b, a]]) assert.deepEqual(evaluate(p, head12, 'Beta', ROLES).problems, [], '相容的短長碼不是異版本');
  // 短碼＋一個不匹配目前版本的長碼：兩種排列都要擋（不可以短碼先到就放行）
  for (const p of [[a, d], [d, a]]) assert.ok(evaluate(p, head12, 'Beta', ROLES).problems.length > 0, '代表值是長碼，跟目前版本對不上');
  // 更高輪次澄清後放行
  assert.deepEqual(evaluate([a, b, d, verdict({ sha: head12, round: 2 })], head12, 'Beta', ROLES).problems, []);
});

test('⑫沒帶時區的留言時間不收＝退 2；同一份留言在 TZ=UTC 與 TZ=Asia/Taipei 判一樣', () => {
  const bad = c('🤖 Beta｜來源：CLI｜審 ｜r1｜結論：要求修改', 'bad1'); bad.createdAt = '2026-09-13T02:00:00Z';
  const good = verdict({ round: 2 }); good.createdAt = '2026-09-13T02:30:00Z';
  const voider = verdict({ role: 'Alpha', round: 2, extra: '\n\n作廢上一則：bad1' });
  const settings = { participants: ROLES.map((id) => ({ id })) };
  const noTz = { ...voider, createdAt: '2026-09-13T03:00:00' };
  assert.equal(gateRun('7', { settings, platform: fakePlatform({ change: change(), comments: [bad, good, noTz] }) }).code, 2);
  // r4 Medium①：不存在的日子會被轉換器進位成較晚的真日子，壞標頭就被「較晚」的作廢蓋掉
  const badMar = { ...bad, createdAt: '2026-03-01T02:00:00Z' };
  const goodMar = { ...good, createdAt: '2026-03-01T02:30:00Z' };
  const impossible = { ...voider, createdAt: '2026-02-30T03:00:00Z' };
  assert.equal(gateRun('7', { settings, platform: fakePlatform({ change: change(), comments: [badMar, goodMar, impossible] }) }).code, 2, '不存在的日子＝時間讀不出＝退 2');
  const withTz = { ...voider, createdAt: '2026-09-13T03:00:00Z' };
  const script = `const { evaluate } = require(${JSON.stringify(require.resolve('../tools/gates/check-review-verdicts.js'))});
    const r = evaluate(${JSON.stringify([bad, good, withTz])}, ${JSON.stringify(HEAD)}, 'Beta', ${JSON.stringify(ROLES)});
    process.stdout.write(JSON.stringify(r.problems));`;
  const outs = ['UTC', 'Asia/Taipei'].map((tz) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: tz } }).stdout);
  assert.equal(outs[0], outs[1], `兩個時區判決不同：${outs.join(' | ')}`);
  assert.deepEqual(JSON.parse(outs[0]), [], '帶時區的作廢在兩個時區都生效');
});

test('⑬「通過」要帶兩行固定小標（F7）：缺了那則不算數、撤不了自己的阻擋；阻擋不要求；重貼合格的就放行', () => {
  const bare = verdict({ headings: false });
  const r = evaluate([bare], HEAD, 'Beta', ROLES);
  assert.ok(r.problems.some((p) => p.includes('缺固定小標「### 本輪實際用的設定」「### 清單逐項結果」')), r.problems.join('\n'));
  assert.ok(r.problems.some((p) => p.includes('沒有「Beta」對目前版本')), '缺小標的通過不能算成放行');
  // 只缺一行：點名缺的那一行
  const half = c(`🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n設定`);
  const rh = evaluate([half], HEAD, 'Beta', ROLES);
  assert.ok(rh.problems.some((p) => p.includes('缺固定小標「### 清單逐項結果」') && !p.includes('「### 本輪實際用的設定」')), rh.problems.join('\n'));
  // 小標那一行要逐字：多了字、放進引用都不算；行尾空白（含定位字元）與 CR 換行可以
  const extra = c(`🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定（補）\n\n### 清單逐項結果`);
  const re = evaluate([extra], HEAD, 'Beta', ROLES);
  assert.ok(re.problems.some((p) => p.includes('缺固定小標「### 本輪實際用的設定」：')), `多了字的那一行不算、只點名它：${re.problems.join('\n')}`);
  const quoted = c(`🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過\n\n> ### 本輪實際用的設定\n> x\n\n> ### 清單逐項結果\n> y`);
  assert.ok(evaluate([quoted], HEAD, 'Beta', ROLES).problems.some((p) => p.includes('缺固定小標「### 本輪實際用的設定」「### 清單逐項結果」')), '引用裡的小標不算');
  const trailing = c(`🤖 Beta｜來源：CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過\r\n\r\n### 本輪實際用的設定  \t\r\nx\r\n\r\n### 清單逐項結果 \r\ny`);
  assert.deepEqual(evaluate([trailing], HEAD, 'Beta', ROLES).problems, [], '行尾空白、定位字元、CR 換行都可以');
  // 缺小標的通過撤不了同一位先前的阻擋
  const block = verdict({ verdict: '需修改後再審' });
  const r2 = evaluate([block, verdict({ round: 2, headings: false })], HEAD, 'Beta', ROLES);
  assert.ok(r2.problems.some((p) => p.includes('還沒有被同一位撤銷')), '不算數的通過不撤銷阻擋');
  // 阻擋不要求小標（對照組：上面那則阻擋沒有小標，照樣擋）
  assert.ok(evaluate([block], HEAD, 'Beta', ROLES).problems.some((p) => p.includes('還沒有被同一位撤銷')));
  // 重貼一則合格的（同輪也可以）就放行，前一則降為提醒
  const fixed = evaluate([bare, verdict()], HEAD, 'Beta', ROLES);
  assert.deepEqual(fixed.problems, [], fixed.problems.join('\n'));
  assert.ok(fixed.warnings.some((w) => w.includes('缺固定小標')), '不算數的那一則要留一句提醒');
  // 不是指定那一位的缺小標通過：只提醒（它本來就不放行）
  const other = evaluate([verdict(), verdict({ role: 'Alpha', source: '桌面', headings: false })], HEAD, 'Beta', ROLES);
  assert.deepEqual(other.problems, [], other.problems.join('\n'));
  assert.ok(other.warnings.some((w) => w.includes('Alpha（桌面）') && w.includes('缺固定小標')));
  // 它算數就會撤掉自己較低輪的阻擋：列成擋下的原因（不只提醒）——不是指定那一位、或是指定那一位的另一個來源都一樣
  const p1 = evaluate([verdict({ role: 'Alpha', source: '桌面', verdict: '需修改後再審' }), verdict(), verdict({ role: 'Alpha', source: '桌面', round: 2, headings: false })], HEAD, 'Beta', ROLES);
  assert.ok(p1.problems.some((p) => p.includes('Alpha（桌面） 在 r2') && p.includes('缺固定小標')), p1.problems.join('\n'));
  assert.ok(!p1.warnings.some((w) => w.includes('缺固定小標')), '它是擋下的原因，不可以印成不影響結果的提醒');
  const p2 = evaluate([verdict({ source: 'CLI', verdict: '需修改後再審' }), verdict({ source: '桌面' }), verdict({ source: 'CLI', round: 2, headings: false })], HEAD, 'Beta', ROLES);
  assert.ok(p2.problems.some((p) => p.includes('Beta（CLI） 在 r2') && p.includes('缺固定小標')), p2.problems.join('\n'));
  // 被同一位更高輪的阻擋蓋過：它算不算數都改變不了什麼，只提醒
  const p3 = evaluate([verdict({ headings: false }), verdict({ round: 2, verdict: '需修改後再審' })], HEAD, 'Beta', ROLES);
  assert.ok(!p3.problems.some((p) => p.includes('缺固定小標')), p3.problems.join('\n'));
  assert.ok(p3.warnings.some((w) => w.includes('缺固定小標')));
  assert.ok(p3.problems.some((p) => p.includes('還沒有被同一位撤銷')), '擋下的原因是那則更高輪的阻擋');
  // 缺小標的通過裡的作廢行照樣生效（那是救別則的）
  const badOne = c('🤖 Beta｜來源：CLI｜審 ｜r1｜結論：要求修改', 'bad13');
  const voidInBare = verdict({ round: 2, headings: false, extra: '\n\n作廢上一則：bad13' });
  const rv = evaluate([badOne, voidInBare, verdict({ round: 3 })], HEAD, 'Beta', ROLES);
  assert.deepEqual(rv.problems, [], rv.problems.join('\n'));
  assert.ok(rv.warnings.some((w) => w.includes('已被') && w.includes('作廢')), '作廢要生效');
});

test('⑭「文字快速通道」：專案設定登記的擁有者的「通過」是原話逐字、不要求小標；認擁有者不認裁示者；沒登記＝不豁免', () => {
  const ownerPass = verdict({ role: 'Gamma', source: 'Gamma 本人', headings: false });
  assert.deepEqual(evaluate([ownerPass], HEAD, 'Gamma', ROLES, { ownerRole: 'Gamma' }).problems, []);
  assert.ok(evaluate([ownerPass], HEAD, 'Gamma', ROLES).problems.some((p) => p.includes('缺固定小標')), '沒給 ownerRole＝不豁免');
  // AI 的通過不因為有人被豁免就跟著豁免
  assert.ok(evaluate([verdict({ headings: false })], HEAD, 'Beta', ROLES, { ownerRole: 'Gamma' }).problems.some((p) => p.includes('缺固定小標')));
  // 端到端：擁有者＝設定的 owner 那一欄（要是登記的參與者）
  const people = { participants: [{ role: '裁示者（人）', id: 'Gamma', account: 'g' }, { role: 'AI 甲', id: 'Alpha', account: 'a' }, { role: 'AI 乙', id: 'Beta', account: 'a' }], owner: 'Gamma' };
  const fast = change({ body: '- **實作者**：Alpha\n- **複審者**：Gamma' });
  assert.equal(gateRun('7', { settings: people, platform: fakePlatform({ change: fast, comments: [ownerPass] }) }).code, 0);
  // 擁有者把裁示者指定給某個 AI（A1）：那個 AI 不帶小標的通過照樣不算數，擁有者的原話照樣接受（#32 r1）
  const delegated = { participants: [{ role: '擁有者（人）', id: 'Gamma', account: 'g' }, { role: '裁示者（AI）', id: 'Beta', account: 'a' }, { role: 'AI 甲', id: 'Alpha', account: 'a' }], owner: 'Gamma' };
  const toBeta = change({ body: '- **實作者**：Alpha\n- **複審者**：Beta' });
  assert.equal(gateRun('7', { settings: delegated, platform: fakePlatform({ change: toBeta, comments: [verdict({ headings: false })] }) }).code, 1, '裁示者是 AI 時，它的通過照樣要小標');
  assert.equal(gateRun('7', { settings: delegated, platform: fakePlatform({ change: fast, comments: [ownerPass] }) }).code, 0, '擁有者的原話照樣接受');
  // 沒登記擁有者（未設定、欄位不見、登記的不是參與者）＝不豁免，訊息提醒先登記、不要替他的原話補小標
  for (const owner of ['未設定', undefined, 'Nobody']) {
    const blocked = gateRun('7', { settings: { ...people, owner }, platform: fakePlatform({ change: fast, comments: [ownerPass] }) });
    assert.equal(blocked.code, 1, `owner=${owner}：不豁免、看得見地擋下`);
    assert.match(blocked.lines.join('\n'), /專案設定還沒登記擁有者，所以沒有豁免，先登記擁有者，不要替他的原話補小標/u);
    assert.match(blocked.lines.join('\n'), /現況：Gamma（Gamma 本人）=通過（r1，缺小標、不算數）/u, '現況照實列出不算數的那則');
  }
  // 有登記擁有者時，AI 缺小標的訊息不提那一句
  const ai = gateRun('7', { settings: people, platform: fakePlatform({ change: change(), comments: [verdict({ headings: false })] }) });
  assert.doesNotMatch(ai.lines.join('\n'), /還沒登記擁有者/u);
  // 識別值前後帶空白：跟 rolesOf 一樣去掉再比，照樣豁免
  assert.equal(gateRun('7', { settings: { ...people, owner: ' Gamma ' }, platform: fakePlatform({ change: fast, comments: [ownerPass] }) }).code, 0);
});
