// 守待裁清單（規矩 D1、I1〜I3）。它不是閘；它讓裁示者與 AI 都不必翻留言串就知道還欠哪些答案。
//
// 守得到的：
//   ①三種留痕只認範本的形狀：問／裁示／撤回；日期要是真的日子；
//   ②裁示要由裁示者的帳號貼、要有原話那一行；別人貼的、缺原話的＝疑似，不關題；
//   ③撤回要有三選一的理由（附依據）與自報句；缺一＝疑似；
//   ④配對：裁示或撤回要引到原 ❓ 的留言編號、在引用區塊以外、而且比 ❓ 晚；引在引用區塊裡不算；先貼的不算；
//   ⑤已裁與已撤回一定印出來、附配對；長得像但形狀不合＝疑似；
//   ⑥裁示者沒填、平台問不到＝退 2；不擋任何事（沒有退 1）；掃**整個專案**的留言（allComments），題目所屬的變更關了照樣列、
//     裁示貼在別支變更上照樣配得起來（搬家驗屋 09-13：原本只掃開著的變更，真語料 12 題裡 4 題會從清單消失）；
//   ⑦三種留痕都只採計登記的貼文帳號（r1 Medium⑧：外人不可以撤掉待裁、外人的問也不入）；
//   ⑧轉述者要是登記的識別值、不帶記號；藏在 HTML 註解裡的原話行與網址不算；引用區塊的懶續行也算引用（r1 Medium⑨）；
//     原話、撤回理由、自報句、配對只讀開頭那一段（r5 之後）：碰到引用、圍欄、註解等特殊行就停，疑似的原因附停在第幾行；
//     第一行讀原文第一個非空行；留痕標題不在第一行＝疑似；行內程式碼裡提到記號照常判；
//   ⑨讀哪一段只有一份定義（r2 Medium③）：原話與配對放在程式碼圍欄、引用的懶續行裡都不算；
//   ⑩時間用時間值比（r2 Medium④）：比問題早的異時區裁示不關題；時間讀不出＝退 2、不移出待裁；
//   ⑪時間沒帶時區也不收（r3 High①）：同一份輸入在不同執行時區要判一樣；
//   ⑫圍欄裡的註解符號不可以改寫外層結構（r3 Medium②）：交錯的註解與圍欄、沒關閉的註解都不算生效；
//     圍欄開頭行後面的「<!--」也屬於圍欄（r4 Medium②）。
// ⚠️ 守不到的：整個專案的留言有沒有給齊（分頁收齊是那條登記指令的責任）；已裁是推導不是事實；原話只驗形狀。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { run, evaluate, deciderOf, cites, realDate, readPart, cliArgsProblem } = require('../tools/pending-rulings.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const D = { id: 'Boss', account: 'boss-acct', ids: ['Boss', 'Alpha'], accounts: ['boss-acct', 'ai-acct'] };
let n = 0;
// 時間用 Date.UTC 算：第 60 則以後若照舊把編號直接寫進「秒」，會變成不存在的 00:00:60，被時間契約判讀不出（整份退 2）
const c = (body, over = {}) => ({ id: `c${++n}`, author: 'ai-acct', createdAt: new Date(Date.UTC(2026, 8, 13, 0, 0, n)).toISOString(), change: '7', body, ...over });
const ask = (title = '要不要做') => c(`## ❓ 待裁（2026-09-13）：${title}\n選項：甲／乙\n建議：甲`);
const ruling = (askId, over = {}) => c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n落點：https://x/pull/7#issuecomment-${askId}`, { author: 'boss-acct', ...over });
const withdraw = (askId) => c(`## 🚫 撤回（2026-09-13）：不用問了\n撤回理由：題目依附的東西沒了（那支變更已關）\nAlpha 撤回、Boss 未回；他隨時可以要我重問\nhttps://x/pull/7#issuecomment-${askId}`);

test('①②④基準：問了沒回＝還沒回；裁示者引到編號＝已裁；別人貼的裁示＝疑似、不關題', () => {
  const q = ask();
  assert.equal(evaluate([q], D).open.length, 1);
  const r = evaluate([q, ruling(q.id)], D);
  assert.equal(r.open.length, 0); assert.equal(r.ruled.length, 1); assert.equal(r.ruled[0].by.author, 'boss-acct');
  const fake = evaluate([q, ruling(q.id, { author: 'ai-acct' })], D);
  assert.equal(fake.open.length, 1, '別人貼的裁示不可以關題');
  assert.ok(fake.near.some((x) => x.why.includes('不是裁示者的帳號')));
});

test('②裁示缺原話那一行＝疑似；識別值不是裁示者的＝不認；日期不是真的日子＝疑似', () => {
  const q = ask();
  const noQuote = c('## ⚖️ Boss 裁示（2026-09-13）：選甲\n落點 https://x#issuecomment-' + q.id, { author: 'boss-acct' });
  assert.equal(evaluate([q, noQuote], D).open.length, 1);
  const wrongId = c(`## ⚖️ Other 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}`, { author: 'boss-acct' });
  assert.equal(evaluate([q, wrongId], D).open.length, 1);
  const badDate = c(`## ⚖️ Boss 裁示（2026-99-99）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}`, { author: 'boss-acct' });
  const r = evaluate([q, badDate], D);
  assert.equal(r.open.length, 1); assert.ok(r.near.some((x) => x.why.includes('日期')));
  assert.equal(realDate('2026-02-30'), false); assert.equal(realDate('2026-02-28'), true);
  assert.equal(realDate('not-a-date'), false, '形狀不對也是假日期（這一格在流程裡走不到，但函式是公開的）');
});

test('③撤回：理由三選一附依據、自報句，缺一＝疑似；齊了＝已撤回（不是已裁）', () => {
  const q = ask();
  const ok = evaluate([q, withdraw(q.id)], D);
  assert.equal(ok.open.length, 0); assert.equal(ok.withdrawn.length, 1); assert.equal(ok.ruled.length, 0);
  const noReason = c(`## 🚫 撤回（2026-09-13）：x\nAlpha 撤回、Boss 未回；他隨時可以要我重問\n${q.id}`);
  assert.equal(evaluate([q, noReason], D).open.length, 1);
  const badReason = c(`## 🚫 撤回（2026-09-13）：x\n撤回理由：不想問了（沒依據）\nAlpha 撤回、Boss 未回；他隨時可以要我重問\n${q.id}`);
  assert.equal(evaluate([q, badReason], D).open.length, 1);
  const emptyBasis = c(`## 🚫 撤回（2026-09-13）：x\n撤回理由：問題本身問錯了（）\nAlpha 撤回、Boss 未回；他隨時可以要我重問\n${q.id}`);
  assert.equal(evaluate([q, emptyBasis], D).open.length, 1, '依據不可以是空的');
  const noSelf = c(`## 🚫 撤回（2026-09-13）：x\n撤回理由：問題本身問錯了（重複）\n${q.id}`);
  assert.equal(evaluate([q, noSelf], D).open.length, 1);
});

test('④配對：引在引用區塊裡不算；先貼的不算；編號要整個對上不是子字串', () => {
  const q = ask();
  const quoted = ruling('x'); quoted.body = `## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n> 見 ${q.id}`;
  assert.equal(evaluate([q, quoted], D).open.length, 1, '引用區塊裡的編號不算在回答它');
  const early = ruling(q.id); early.createdAt = '2026-09-12T00:00:00Z';
  assert.equal(evaluate([q, early], D).open.length, 1, '比問題早的裁示不算');
  assert.equal(cites('see c12 here', 'c1'), false, '子字串不算（後面接字）');
  assert.equal(cites('see 9c1 here', 'c1'), false, '子字串不算（前面接字）——只釘後面那格的話，前面那道邊界拿掉也不會紅');
  assert.equal(cites('see c1 here', 'c1'), true);
  assert.equal(cites('https://x/pull/7#issuecomment-5560311732', '5560311732'), true, '網址尾碼算');
});

test('⑤長得像但不合形狀＝疑似，並說原因', () => {
  const near = c('## ❓ 待裁：忘了寫日期');
  const r = evaluate([near], D);
  assert.equal(r.open.length, 0); assert.equal(r.near.length, 1);
  assert.equal(evaluate([c('普通留言')], D).near.length, 0);
});

test('⑥裁示者沒填＝退 2；平台問不到＝退 2；算出來＝退 0，掃整個專案的留言（含已關的變更）', () => {
  assert.equal(deciderOf({ participants: [{ role: '裁示者（人）', id: 'Boss', account: '未設定' }] }), null);
  assert.equal(run({ settings: { participants: [] }, platform: { ask() { throw new Error('不該問'); } } }).code, 2);
  const settings = { participants: [{ role: '裁示者（人）', id: 'Boss', account: 'boss-acct' }, { role: 'AI 甲', id: 'Alpha', account: 'ai-acct' }] };
  assert.equal(run({ settings, platform: { ask() { throw new PlatformError('x'); } } }).code, 2);
  const q = { ...ask(), change: '5' };   // 題目掛在 5 號，而 5 號已經合併關掉了
  const asked = [];
  const platform = { ask(op) { asked.push(op); if (op !== 'allComments') throw new Error(`不該問 ${op}`); return [q]; } };
  const r = run({ settings, platform });
  assert.equal(r.code, 0);
  assert.deepEqual(asked, ['allComments'], '一次問整個專案，不是逐支問開著的變更');
  assert.match(r.lines.join('\n'), /還沒回：1 則/u, '所屬的變更關了，題目還在');
  assert.match(r.lines.join('\n'), /含已關的變更/u);
  // 裁示貼在別支變更上（原專案真語料的形狀：問在 #577、裁在 #578）照樣配得起來
  const answered = run({ settings, platform: { ask: () => [q, { ...ruling(q.id), change: '6' }] } });
  assert.match(answered.lines.join('\n'), /還沒回：0 則/u);
  assert.match(answered.lines.join('\n'), /已裁：1 則/u);
  assert.throws(() => run({ settings, platform: { ask() { throw new TypeError('程式寫錯'); } } }), TypeError);
  assert.equal(runInCopy('tools/pending-rulings.js').status, 2, '空白設定的複本：設定未填');
});

test('⑦外人的撤回關不了題、外人的問不入待裁；都列成疑似', () => {
  const q = ask();
  const outsiderWithdraw = withdraw(q.id); outsiderWithdraw.author = 'outsider';
  const r = evaluate([q, outsiderWithdraw], D);
  assert.equal(r.open.length, 1, '外人撤不掉');
  assert.ok(r.near.some((x) => x.why.includes('不是登記的貼文帳號')));
  const outsiderAsk = ask(); outsiderAsk.author = 'outsider';
  const r2 = evaluate([outsiderAsk], D);
  assert.equal(r2.open.length, 0); assert.equal(r2.near.length, 1);
});

test('⑧原話署名包粗體＝不合；原話行與網址藏在 HTML 註解＝不算；寫在引用（含懶續行）之後＝不算', () => {
  const q = ask();
  const bold = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，**Alpha** 轉述）：**「甲」**\n${q.id}`, { author: 'boss-acct' });
  assert.equal(evaluate([q, bold], D).open.length, 1, '包粗體的署名範本明說不合');
  const unknownId = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Nobody 轉述）：**「甲」**\n${q.id}`, { author: 'boss-acct' });
  assert.equal(evaluate([q, unknownId], D).open.length, 1, '轉述者要是登記的識別值');
  const hidden = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n<!--\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}\n-->`, { author: 'boss-acct' });
  assert.equal(evaluate([q, hidden], D).open.length, 1, '註解裡的東西畫面上看不見，不算');
  const lazy = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n> 引用別人說的\n見 ${q.id} 這一則`, { author: 'boss-acct' });
  assert.equal(evaluate([q, lazy], D).open.length, 1, '緊接在 > 後面沒有空行隔開的行仍是引用');
  assert.equal(readPart('a\n\nb\n> c\nd'), 'a\n\nb', '讀到第一個引用就停，之後的 d 也不讀');
  const afterBlank = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n> 引用\n\n${q.id}`, { author: 'boss-acct' });
  assert.equal(evaluate([q, afterBlank], D).open.length, 1, '網址寫在引用之後＝讀不到（r5 之後只讀開頭那一段；要寫在引用前面）');
  const beforeQuote = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}\n\n> 引用`, { author: 'boss-acct' });
  assert.equal(evaluate([q, beforeQuote], D).open.length, 0, '對照組：網址在引用前面，配對成立');
});

test('⑨原話與配對放在程式碼圍欄裡＝不算；原話放在引用的懶續行＝不算（讀哪一段只有一份定義）', () => {
  const q = ask();
  const fenced = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n\`\`\`md\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}\n\`\`\``, { author: 'boss-acct' });
  assert.equal(evaluate([q, fenced], D).open.length, 1, '圍欄裡的原話與網址是範例，不算');
  const quotedQuote = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n> 引用範例\n原話（對話中，Alpha 轉述）：**「甲」**\n\n${q.id}`, { author: 'boss-acct' });
  assert.equal(evaluate([q, quotedQuote], D).open.length, 1, '原話在引用的懶續行裡，不算；網址雖在最外層也不夠');
  const longFence = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n\`\`\`\`\n\`\`\`\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}\n\`\`\`\`\n`, { author: 'boss-acct' });
  assert.equal(evaluate([q, longFence], D).open.length, 1, '四反引號圍欄裡的三反引號不是關閉');
});

test('⑩時間用時間值比：異時區但其實較早的裁示不關題；時間讀不出＝退 2 且不移出待裁', () => {
  const q = ask(); q.createdAt = '2026-09-13T02:00:00Z';
  const earlier = ruling(q.id); earlier.createdAt = '2026-09-13T03:00:00+02:00';   // ＝01:00Z，比問題早
  const r = evaluate([q, earlier], D);
  assert.equal(r.open.length, 1, '字串序會排錯，時間值不會');
  const later = ruling(q.id); later.createdAt = '2026-09-13T05:00:00+02:00';   // ＝03:00Z，比問題晚
  assert.equal(evaluate([q, later], D).open.length, 0);
  const broken = ruling(q.id); broken.createdAt = 'not-a-time';
  const settings = { participants: [{ role: '裁示者（人）', id: 'Boss', account: 'boss-acct' }, { role: 'AI 甲', id: 'Alpha', account: 'ai-acct' }] };
  const platform = { ask: () => [q, broken] };
  const out = run({ settings, platform });
  assert.equal(out.code, 2);
  assert.match(out.lines.join('\n'), /時間讀不出/u);
});

test('⑪沒帶時區的裁示不收＝退 2；同一份輸入在 TZ=UTC 與 TZ=Asia/Taipei 判一樣', () => {
  const q = ask(); q.createdAt = '2026-09-13T02:00:00Z';
  const noTz = ruling(q.id); noTz.createdAt = '2026-09-13T03:00:00';
  const settings = { participants: [{ role: '裁示者（人）', id: 'Boss', account: 'boss-acct' }, { role: 'AI 甲', id: 'Alpha', account: 'ai-acct' }] };
  const platform = { ask: () => [q, noTz] };
  assert.equal(run({ settings, platform }).code, 2);
  // r4 Medium①：不存在的日子會被轉換器進位成較晚的真日子，「較晚」的裁示就把問題關掉
  const qMar = { ...q, createdAt: '2026-03-01T02:00:00Z' };
  const impossible = { ...ruling(q.id), createdAt: '2026-02-30T03:00:00Z' };
  assert.equal(run({ settings, platform: { ask: () => [qMar, impossible] } }).code, 2, '不存在的日子＝時間讀不出＝退 2、不移出待裁');
  const script = `const { evaluate } = require(${JSON.stringify(require.resolve('../tools/pending-rulings.js'))});
    const D = ${JSON.stringify(D)};
    const q = ${JSON.stringify(q)};
    const r = ${JSON.stringify({ ...ruling(q.id), createdAt: '2026-09-13T03:00:00Z' })};
    const bad = ${JSON.stringify({ ...ruling(q.id), createdAt: '2026-09-13T03:00:00' })};
    process.stdout.write(JSON.stringify([evaluate([q, r], D).open.length, evaluate([q, bad], D).unsure ? 'unsure' : 'ok']));`;
  const outs = ['UTC', 'Asia/Taipei'].map((tz) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: tz } }).stdout);
  assert.equal(outs[0], outs[1], `兩個時區結果不同：${outs.join(' | ')}`);
  assert.deepEqual(JSON.parse(outs[0]), [0, 'unsure']);
});

test('⑫圍欄裡的註解符號不可以改寫外層結構；沒關閉的註解一路不算', () => {
  const q = ask();
  const payload = `原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}`;
  const interleaved = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n${['```md', '<!--', '```', '-->', '```', payload, '```'].join('\n')}`, { author: 'boss-acct' });
  assert.equal(evaluate([q, interleaved], D).open.length, 1, '第二段圍欄裡的原話是範例，不算');
  const unclosed = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n<!--\n${payload}`, { author: 'boss-acct' });
  assert.equal(evaluate([q, unclosed], D).open.length, 1, '沒關閉的註解裡什麼都不算');
  for (const f of ['```', '~~~']) {
    const r4 = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n${[`${f}md <!--`, 'code', f, `${f}md`, '-->', payload, f].join('\n')}`, { author: 'boss-acct' });
    const r = evaluate([q, r4], D);
    assert.equal(r.open.length, 1, `${f}：r4 反例——第二段圍欄裡的原話是範例，不關題`);
    assert.equal(r.ruled.length, 0);
  }
});

test('⑬只讀開頭那一段（r5 之後）：原話與網址寫在特殊行之後＝疑似並指出行號；寫完之後才出現的不影響；標題不在第一行＝疑似', () => {
  const q = ask();
  const commentAfter = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}\n<!-- 附註 -->`, { author: 'boss-acct' });
  assert.equal(evaluate([q, commentAfter], D).open.length, 0, '原話與網址寫完之後的註解改不了前面');
  // r5 反例三：標題下先引用上一輪、再寫原話與網址——畫面看得見，但不照「緊接在標題下」寫：不關題、列疑似、指出行號
  const quoteFirst = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n> 上輪的問題\n## 本輪\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}`, { author: 'boss-acct' });
  const r = evaluate([q, quoteFirst], D);
  assert.equal(r.open.length, 1);
  assert.ok(r.near.some((x) => x.id === quoteFirst.id && /第 2 行就停了/u.test(x.why)), r.near.map((x) => x.why).join(' / '));
  const hiddenHeader = c(`<!--\n## ⚖️ Boss 裁示（2026-09-13）：選甲\n-->\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}`, { author: 'boss-acct' });
  const h = evaluate([q, hiddenHeader], D);
  assert.equal(h.open.length, 1, '第一行不是標題＝不是裁示');
  assert.ok(h.near.some((x) => x.id === hiddenHeader.id && /不在第一行/u.test(x.why)), '標題不在第一行也不可以靜靜不見');
  assert.equal(evaluate([q, c('前言\n  ## ⚖️ 縮排的範例標題')], D).near.length, 0, '縮排的標題是範例，不列疑似');
  const askWithComment = c('## ❓ 待裁（2026-09-13）：要不要做\n<!-- 備註 -->');
  assert.equal(evaluate([askWithComment], D).open.length, 1, '問只讀第一行，內文的特殊行不影響它在待裁裡');
  // r6 Medium①：網址放在表格分隔列以下（行內程式碼裡的豎線把格子切多、網址那格被丟掉）＝不配對；沒配到又停過＝疑似、指出第 5 行
  const inTable = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n\n| 驗證命令 | 原題 |\n| --- | --- |\n| \`printf x | cat\` | ${q.id} |`, { author: 'boss-acct' });
  const t = evaluate([q, inTable], D);
  assert.equal(t.open.length, 1, '表格裡的網址不配對');
  assert.ok(t.near.some((x) => x.id === inTable.id && /沒有配到/u.test(x.why) && /第 5 行就停了/u.test(x.why)), t.near.map((x) => x.why).join(' / '));
  // r7 Medium①：單欄表格的分隔列可以沒有豎線，網址在那格被丟掉＝一樣不配對
  for (const sep of [':---', '---:', ':---:']) {
    const oneCol = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n\n| 操作紀錄 |\n${sep}\n| \`printf x | cat\`；原題：${q.id} |`, { author: 'boss-acct' });
    const o = evaluate([q, oneCol], D);
    assert.equal(o.open.length, 1, `${sep}：單欄表格裡的網址不配對`);
    assert.ok(o.near.some((x) => x.id === oneCol.id && /第 5 行就停了/u.test(x.why)), `${sep}：${o.near.map((x) => x.why).join(' / ')}`);
  }
  const beforeTable = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}\n\n| a | b |\n| --- | --- |\n| \`x | y\` | z |`, { author: 'boss-acct' });
  assert.equal(evaluate([q, beforeTable], D).open.length, 0, '對照組：網址寫在表格前面＝配對成立');
  // r6 Low②：原話在引用前、網址在引用後＝不配對；以前靜靜留在待裁，現在列疑似並指出第 3 行
  const urlAfterQuote = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n> 上輪建議\n\n${q.id}`, { author: 'boss-acct' });
  const u = evaluate([q, urlAfterQuote], D);
  assert.equal(u.open.length, 1);
  assert.ok(u.near.some((x) => x.id === urlAfterQuote.id && /第 3 行就停了/u.test(x.why)), u.near.map((x) => x.why).join(' / '));
  // r7 Low②：同一題的第二則補充裁示配得到那一題、只是不是代表——後面有引用也不可以列成「沒有配到」
  const first = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}`, { author: 'boss-acct' });
  const second = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}\n\n補充實作依據：\n> 沿用選甲`, { author: 'boss-acct' });
  for (const order of [[q, first, second], [second, first, q]]) {
    const s2 = evaluate(order, D);
    assert.equal(s2.ruled.length, 1, '已裁一則（代表是較早那則）');
    assert.equal(s2.near.length, 0, `補充裁示配得到，不列疑似：${s2.near.map((x) => x.why).join(' / ')}`);
  }
  assert.equal(evaluate([q, second], D).ruled.length, 1, '對照組：第二則單獨存在時照常配對');
  const earlyWithQuote = { ...second, id: 'early1', createdAt: '2026-09-12T00:00:00Z' };
  assert.ok(evaluate([q, earlyWithQuote], D).near.some((x) => x.id === 'early1' && /沒有配到/u.test(x.why)), '引到的問題比它晚＝不算配到（先後要看）');
  const unmatchedNoStop = c('## ⚖️ Boss 裁示（2026-09-13）：選甲\n原話（對話中，Alpha 轉述）：**「甲」**\n別的變更上的題', { author: 'boss-acct' });
  assert.equal(evaluate([q, unmatchedNoStop], D).near.length, 0, '對照組：沒配到、但讀的那段沒停＝照舊不列（可能在回答已關掉的變更上的題）');
  const tagInTitle = c('## ❓ 待裁（2026-09-13）：要不要用 <details> 收合');
  assert.equal(evaluate([tagInTitle], D).open.length, 1, '第一行讀原文、不經過「開頭那一段」：標題裡有特殊記號也照樣是問');
  const mention = c(`## ⚖️ Boss 裁示（2026-09-13）：選甲\n背景：\`<!--\` 那個記號的事\n原話（對話中，Alpha 轉述）：**「甲」**\n${q.id}`, { author: 'boss-acct' });
  const m = evaluate([q, mention], D);
  assert.equal(m.open.length, 0, '行內程式碼裡提到記號不是特殊行、原話照常算');
  assert.equal(m.near.length, 0);
});

test('指令列不收參數：舊習慣的 --all／--pr 不可以被靜靜忽略（搬家前準備）', () => {
  assert.equal(cliArgsProblem([]), null, '對照組：不給參數正常跑');
  for (const argv of [['--all'], ['--pr', '5']]) assert.match(cliArgsProblem(argv), /不收任何參數/u, argv.join(' '));
  const r = runInCopy('tools/pending-rulings.js', ['--pr', '5']);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /不收任何參數/u, '真的跑一遍：在問平台之前就停');
});
