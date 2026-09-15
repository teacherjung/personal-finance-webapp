// 守協作欄位閘（規矩 A2、E1）。原專案量到：分工在版本控制與平台上不留痕跡
// （已合併變更的「誰按的鍵」全是同一個帳號、平台的審查紀錄全是零），唯一看得見的就是說明裡那幾欄。
//
// 這一支的每一題，都對應原專案實際被繞過的一種寫法。**刪掉任何一題之前，先去讀閘的檔頭。**
//
// 守得到的：四欄齊全；實作者與獨立審查者不是同一位；只讀說明開頭那一段（碰到註解、圍欄、引用等特殊行就停、指出行號）；欄名要錨在行首；
//   冒號後不吃換行；角色要剛好命中一個（不是「包含」）；括號裡藏第二個角色不算；
//   混用文字系統＝看不出是誰；平台問不到或設定沒填＝退 2。
// ⚠️ 守不到的：欄位填的內容是不是真的（寫「某某」不代表真的是某某複審的）；
//   「預計修改的共享檔案」「最糟失去什麼」兩欄只驗非空，不驗內容。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gateRun, problemsOf, fieldValue, canonicalRole, rolesOf, REQUIRED_FIELDS } = require('../tools/gates/check-collab-fields.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const ROLES = ['Alpha', 'Beta', 'Gamma'];

/** 一份四欄齊全、實作者不等於審查者的說明。 */
function goodBody(over = {}) {
  const f = { 實作者: 'Alpha', 獨立審查者: 'Beta', 預計修改的共享檔案: 'a.js', '這支若完全失敗，最糟失去什麼': '一句話', ...over };
  return REQUIRED_FIELDS.map((k) => `- **${k}**：${f[k]}`).join('\n');
}

test('基準：四欄齊全、兩個角色不同＝沒有問題（對照組）', () => {
  assert.deepEqual(problemsOf(goodBody(), ROLES), []);
});

test('缺欄位：每一欄各報一次', () => {
  for (const missing of REQUIRED_FIELDS) {
    const body = REQUIRED_FIELDS.filter((k) => k !== missing).map((k) => `- **${k}**：x`).join('\n');
    const problems = problemsOf(body, ROLES);
    assert.ok(problems.some((p) => p.includes(missing)), `${missing} 沒被報出來`);
  }
  assert.equal(problemsOf('', ROLES).filter((p) => p.startsWith('缺')).length, REQUIRED_FIELDS.length, '整份空的＝四欄都缺');
});

test('①只讀說明開頭那一段（r5 之後）：註解、圍欄、引用之後的欄位讀不到，訊息指出停在第幾行；欄位之後才出現的不影響', () => {
  const missing = (body) => problemsOf(body, ROLES).filter((p) => p.startsWith('缺')).length;
  const template = REQUIRED_FIELDS.map((k) => `- **${k}**：<!-- 請填 ${k} -->`).join('\n');
  assert.equal(missing(template), REQUIRED_FIELDS.length, '欄位值是註解＝那一行就停，四欄都沒讀到');
  const hidden = `<!--\n${goodBody()}\n-->\n沒有真的欄位`;
  assert.equal(missing(hidden), REQUIRED_FIELDS.length, '四欄整段藏在註解裡＝讀不到');
  assert.ok(problemsOf(hidden, ROLES).some((p) => /第 1 行就停了/u.test(p)), '訊息指出停在第幾行');
  assert.equal(missing(`<!--\n${goodBody()}`), REQUIRED_FIELDS.length, '沒關閉的註解也一樣');
  assert.deepEqual(problemsOf(`${goodBody()}\n<!-- 附註 -->`, ROLES), [], '欄位寫完之後才出現的註解改不了前面的欄位');
  assert.deepEqual(problemsOf(`說明裡提到 \`<!--\` 這個記號\n${goodBody()}`, ROLES), [], '行內程式碼裡提到記號不是特殊行');
  // r5 反例二：欄位之後有單行三反引號與註解——欄位在前，照常通過（後面的東西藏不了前面的欄位）
  assert.deepEqual(problemsOf(`${goodBody()}\n\n\`\`\`node --test\`\`\`\n\n<!-- 請補驗收 -->`, ROLES), []);
  // r5 反例三：引用後接小節與四欄——畫面上看得見，但不照「欄位寫在最前面」寫：擋下並指出停在第 1 行
  const quoteFirst = `> 上輪建議\n## 這次協作欄位\n${goodBody()}`;
  assert.equal(missing(quoteFirst), REQUIRED_FIELDS.length);
  assert.ok(problemsOf(quoteFirst, ROLES).some((p) => /第 1 行就停了/u.test(p)));
  assert.equal(fieldValue(quoteFirst, '實作者'), '', '結論聯集閘讀指定審查者也經過 fieldValue，同一個讀法');
});

test('⑧圍欄與引用裡的欄位不算填了（r2 反例：整份說明只有一段範例）', () => {
  const inFence = `\`\`\`md\n${goodBody()}\n\`\`\``;
  assert.equal(problemsOf(inFence, ROLES).filter((p) => p.startsWith('缺')).length, REQUIRED_FIELDS.length, '程式碼範例裡的欄位不算');
  const inQuote = `> 範例：\n${goodBody()}`;
  assert.equal(problemsOf(inQuote, ROLES).filter((p) => p.startsWith('缺')).length, REQUIRED_FIELDS.length, '引用的懶續行裡的欄位不算');
  const longFence = `\`\`\`\`\n\`\`\`\n${goodBody()}\n\`\`\`\``;
  assert.equal(problemsOf(longFence, ROLES).filter((p) => p.startsWith('缺')).length, REQUIRED_FIELDS.length, '四反引號圍欄裡的三反引號不是關閉');
  assert.equal(problemsOf(`${inFence}\n\n${goodBody()}`, ROLES).filter((p) => p.startsWith('缺')).length, REQUIRED_FIELDS.length, '範例放在欄位前面＝讀到範例就停（欄位要寫在最前面）');
  assert.deepEqual(problemsOf(`${goodBody()}\n\n${inFence}`, ROLES), [], '對照組：欄位在前、範例在後＝通過');
  // r3 反例：圍欄裡的註解符號跟外面的配對，把第二段圍欄翻成生效文字
  const interleaved = ['```md', '<!--', '```', '-->', '```', goodBody(), '```'].join('\n');
  assert.equal(problemsOf(interleaved, ROLES).filter((p) => p.startsWith('缺')).length, REQUIRED_FIELDS.length, '交錯的註解與圍欄裡的欄位不算');
  // r4 反例：圍欄開頭行後面的「<!--」屬於圍欄，不可以把第二段圍欄裡的欄位搬出來（兩種符號）
  for (const f of ['```', '~~~']) {
    const r4 = [`${f}md <!--`, 'code', f, `${f}md`, '-->', goodBody(), f].join('\n');
    assert.equal(problemsOf(r4, ROLES).filter((p) => p.startsWith('缺')).length, REQUIRED_FIELDS.length, `${f}：r4 反例裡的欄位是範例，不算`);
  }
});

test('②欄名要錨在行首（「非實作者」不可以命中「實作者」）', () => {
  assert.equal(fieldValue('- **非實作者**：Alpha', '實作者'), '', '前面多字就不該命中');
  assert.equal(fieldValue('前面有字 實作者：Alpha', '實作者'), '');
  // 但正常的項目符號、有序清單、粗體都要收
  assert.equal(fieldValue('- **實作者**：Alpha', '實作者'), 'Alpha');
  assert.equal(fieldValue('1. 實作者：Alpha', '實作者'), 'Alpha');
  assert.equal(fieldValue('實作者: Alpha', '實作者'), 'Alpha');
  assert.equal(fieldValue('  * __實作者__ ：Alpha', '實作者'), 'Alpha');
  // 引言記號刻意不收（那是引用範例）
  assert.equal(fieldValue('> - **實作者**：Alpha', '實作者'), '');
});

test('③冒號後不吃換行（留空的欄位不可以抓到下一行）', () => {
  const body = '- **實作者**：\n- **獨立審查者**：Beta';
  assert.equal(fieldValue(body, '實作者'), '', '留空就是留空，不可以抓到下一行的 Beta');
  assert.ok(problemsOf(body, ROLES).some((p) => p.includes('實作者')));
});

test('④角色要剛好命中一個，不可以用「包含」判斷', () => {
  assert.equal(canonicalRole('NotAlpha', ROLES), null, '含有角色名不等於是那個角色');
  assert.equal(canonicalRole('Alpha and Beta', ROLES), null, '多人並列＝看不出是誰');
  assert.equal(canonicalRole('Alphabet', ROLES), null);
  assert.equal(canonicalRole('', ROLES), null);
  assert.equal(canonicalRole('誰知道', ROLES), null);
  assert.equal(canonicalRole('Alpha', ROLES), 'Alpha');
  assert.equal(canonicalRole('**Alpha**', ROLES), 'Alpha', '粗體記號要剝掉');
  assert.equal(canonicalRole('`Alpha`', ROLES), 'Alpha');
  assert.equal(canonicalRole(' alpha ', ROLES), 'Alpha', '大小寫不計');
});

test('④核心那一條：同一位不可以既是實作者又是獨立審查者', () => {
  const same = problemsOf(goodBody({ 獨立審查者: 'Alpha' }), ROLES);
  assert.ok(same.some((p) => p.includes('沒有任何一份產出可以由寫它的人放行')));
  // 「甲（已看過）」不可以因為字串不同就被當成另一個人
  const annotated = problemsOf(goodBody({ 獨立審查者: 'Alpha（已看過）' }), ROLES);
  assert.ok(annotated.length > 0, '加註過的同一人不可以通過');
});

test('⑤⑥⑦藏字元的每一種寫法都要擋下來', () => {
  const cases = [
    ['全形字母', 'Ａｌｐｈａ', 'Alpha'],
    ['帶重音', 'Alph́a', 'Alpha'],
  ];
  for (const [name, written, folded] of cases) {
    assert.equal(canonicalRole(written, ROLES), folded, `${name} 應該折回 ${folded}（折不回來就會變成「看不出是誰」而不是被抓到自審）`);
  }
  // 括號裡藏第二個角色
  for (const raw of ['Alpha(Beta)', 'Alpha（Beta）', 'Alpha(Ｂｅｔａ)', 'Alpha(Be​ta)', 'Alpha(B͏eta)']) {
    assert.equal(canonicalRole(raw, ROLES), null, `括號裡藏了第二個角色：${JSON.stringify(raw)}`);
  }
  // 混用文字系統：看起來像拉丁字母、其實不是
  assert.equal(canonicalRole('Аlpha', ROLES), null, '西里爾字母混進拉丁詞＝看不出是誰');
  assert.equal(canonicalRole('Alphа', ROLES), null);
  // ⚠️ 這一格才是「混用文字系統」那道防線真正不可取代的地方（2026-09-13 打突變才發現）：
  //    上面兩個就算沒有那道防線，也會因為「全等比對」對不上而回 null。但**括號裡**不一樣——
  //    括號那道用的是「包含」，而「Веta」（西里爾 В）不包含「Beta」，於是第二個角色溜過括號那關，
  //    剝掉括號之後剩下乾淨的「Alpha」＝通過。只有混用文字系統那道擋得住。
  assert.equal(canonicalRole('Alpha(Веta)', ROLES), null, '括號裡用長得像的字母藏第二個角色');
  assert.equal(canonicalRole('Alpha（Ｖeta）', ROLES), 'Alpha', '括號裡不是角色名就不該誤擋');
  // 中文加註不受影響（角色名是拉丁字，中文是正當的旁註）
  assert.equal(canonicalRole('Alpha', ROLES), 'Alpha');
});

test('⑤自審藏在藏字元裡：折回來之後要被抓到，不是被放過', () => {
  // ⚠️ 最後那個用的是「預設不顯示」的填充字元（不是組合記號、也不是格式控制字元）——
  //    正規化少掉那一層的話，它會變成「看不出是誰」而不是「自審」，訊息會把人指向錯的方向。
  for (const reviewer of ['Ａｌｐｈａ', 'Alph́a', 'A​lpha', 'Aㅤlpha']) {
    const problems = problemsOf(goodBody({ 獨立審查者: reviewer }), ROLES);
    assert.ok(problems.length > 0, `${JSON.stringify(reviewer)} 不可以通過`);
    assert.ok(
      problems.some((p) => p.includes('由寫它的人放行')),
      `${JSON.stringify(reviewer)} 折回來就是同一位，要判成自審（判成「看不出是誰」也算擋下來，但訊息會誤導）`,
    );
  }
});

test('角色名單來自專案設定，不是寫死的', () => {
  const other = ['Xray', 'Yankee'];
  assert.equal(canonicalRole('Alpha', other), null, 'Alpha 不在這個專案的名單上');
  assert.equal(canonicalRole('Xray', other), 'Xray');
  assert.deepEqual(rolesOf({ participants: [{ id: 'Xray' }, { id: 'Yankee' }] }).usable, other);
});

test('設定沒填、識別值不合值域、只有一位：都退 2，而且不會去問平台', () => {
  const platform = { asked: 0, ask() { this.asked += 1; return { body: goodBody() }; } };
  for (const participants of [
    undefined,
    [],
    [{ id: '未設定' }, { id: '未設定' }, { id: '未設定' }],
    [{ id: 'Alpha' }],
    [{ id: 'Alpha' }, { id: '有中文的識別值' }],
  ]) {
    const r = gateRun('7', { settings: { participants }, platform });
    assert.equal(r.code, 2, JSON.stringify(participants));
    assert.match(r.lines.join('\n'), /參與者識別值/u);
  }
  assert.equal(platform.asked, 0, '設定沒填就不該去問平台');
});

test('平台問不到＝退 2；沒給編號＝退 2；不是平台的錯就讓它炸出去', () => {
  const settings = { participants: ROLES.map((id) => ({ id })) };
  const bad = { ask() { throw new PlatformError('沒登記'); } };
  const r = gateRun('7', { settings, platform: bad });
  assert.equal(r.code, 2);
  assert.match(r.lines.join('\n'), /查不到就不是安全/u);
  assert.equal(gateRun(undefined, { settings, platform: bad }).code, 2);
  assert.throws(() => gateRun('7', { settings, platform: { ask() { throw new TypeError('程式寫錯'); } } }), TypeError);
});

test('端到端：四欄齊全＝退 0；自審＝退 1 並說明理由', () => {
  const settings = { participants: ROLES.map((id) => ({ id })) };
  const ok = gateRun('7', { settings, platform: { ask: () => ({ body: goodBody() }) } });
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  const self = gateRun('7', { settings, platform: { ask: () => ({ body: goodBody({ 獨立審查者: 'Alpha' }) }) } });
  assert.equal(self.code, 1);
  assert.match(self.lines.join('\n'), /由寫它的人放行/u);
});

test('真的跑一遍指令（空白設定的複本，不讀本倉庫那份）：識別值未設定，退 2 不放行', () => {
  assert.equal(runInCopy('tools/gates/check-collab-fields.js', ['7']).status, 2);
  assert.equal(runInCopy('tools/gates/check-collab-fields.js').status, 2);
});
