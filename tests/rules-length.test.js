// 守本文 K2：規矩正文不得超過 7,000 字（哪些字算、哪些不算只寫在 MACHINES.md 的 K2 那一列）。
//
// 裁示者 2026-09-12 先定「一頁，約三千字」，同日再裁：**只數規矩本身**——
// 節標題、開頭那句指路、條號、執行者標籤都不算，因為那些是標示、不是規矩。
// 裁示者 2026-09-25 放寬到四千、09-26 再放寬到七千，同時拿掉「加一條要先砍一條」、改成新條要過進門五問。
// 版面（擁有者定案的 A1 範本）：條號【X1】在最前面、子點攤開成清單、標籤獨立在最後一行；
// 主句、子點、標籤裡只放行兩種登記記號——**登記的角色名**與成對反引號的灰底框。
//
// ⚠️ 這一題前七版都在自己判斷「RULES.md 的哪幾行算規矩」，等於用土法重做 Markdown
//    的呈現規則，**連七輪被複審者用不同寫法繞過去**：換星號、換有序清單、縮排、
//    Tab、不換行空白、引言記號、七個井號、CR 換行。每一次我都補一種寫法，每一次都
//    撐不到下一輪。實作者在自問表裡寫下停損線：再有一種新的漏算，就不再補寫法、改成
//    「規矩存成資料、本文由它產生」。第七輪的 CR 換行觸發了它。
//
// **所以現在沒有「哪幾行算規矩」這個問題**：規矩住在 rules.json，一則一筆；RULES.md 是產物。
//
// ⚠️ 但只有「由資料產生」還不夠。第八輪實測出下一層：**不計字的欄位會跑出它該待的位置**——
//    小節標題裡塞一個換行，後面那段就變成獨立的正文段落、完全不計字；標籤裡先關括號再換行，
//    就能長出一整條沒人數的新規矩。兩種都不必動本文、產物也照樣同步。所以真正的收口是
//    **資料契約**（build-rules.js 的 validate）：每個會被輸出的欄位（含每一個子點）都要是單行純文字，
//    標籤不准帶全形括號，不計字的欄位不准帶條號記號【】，記號以外不准有落單的星號或反引號。
//    契約只有那一份，考題與產生器共用。
//
// 這一題守六件，全部量得到、不必猜任何呈現規則：
//   ①資料合契約（單行、非空、前後不帶空白，欄位不會跑出自己的位置；記號只有登記的那兩種）；
//   ②**字面編碼是完整的**：每個欄位編出去以後，拿掉合格記號，不留任何未跳脫的 ASCII 標點，
//     而且解回來與原文逐字元相同（語法只能由固定範本與兩種記號提供，文字本身不會被改掉）；
//   ③整份本文解回來就是「範本填上原文」（plain(build) === buildRaw），多不出任何東西——
//     射程：build 與 buildRaw 共用同一份範本，這一件只證明 build 沒在範本之外多／少東西，
//     證明不了範本本身對不對；範本的形狀由 tests/data-contract.test.js 的形狀題釘；
//   ④字數：由 countRules 直接對資料算（主句＋子點、去空白、只扣合格記號）；
//   ⑤每條的執行者標籤以一個**已定義**的名字開頭，那份定義的正本在 MACHINES.md，這裡跟它對帳；
//   ⑥**RULES.md 必須與產生結果逐字元相同**——手改本文就紅。
//
// ⚠️ 守不到的照實說：第⑥件只證明**本文與資料同步**，不能單靠它推出前面幾件（早一版的註解
//    這樣寫，被實測推翻）。還有一整類機器永遠看不到：作者把語意上的新規矩寫成一個仍然合格的
//    小節標題或射程說明——那要靠人與複審者。版面約定（角色兩旁留空、每處角色都粗體、
//    標籤裡不框）也刻意不檢查：留空純屬版面，不留空也呈現成粗體——CommonMark 的 `**`（不像 `__`）
//    允許貼著字用，角色名值域只有字母數字、兩個記號緊貼又由契約擋掉，所以每個 `**` 都能開或關
//    （照規格推的，本機沒有呈現器可驗）。這一題也不宣稱「任何未來的改法都繞不過」。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, buildRaw, excerpt, ruleFooter, parseCli, read, validate, inline, literal, plain, countRules, countGlossary, MARK, dataFile, outFile, glossaryFile, MIN_RULES } = require('../tools/build-rules.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const LIMIT = 7000;
const machinesFile = path.join(__dirname, '..', 'MACHINES.md');
// MACHINES.md 裡那張定義表的開頭，用來定位（標籤的正本只有那一份）。
const LABEL_TABLE_ANCHOR = '每條最後一行的執行者標籤，定義在這裡、只在這裡';

/** 從 MACHINES.md 抽出已定義的執行者名字；抽不到就讓這題紅，不要默默放行。 */
function definedLabels() {
  const text = fs.readFileSync(machinesFile, 'utf8');
  const at = text.indexOf(LABEL_TABLE_ANCHOR);
  assert.ok(at >= 0, `MACHINES.md 找不到執行者標籤定義表的開頭（「${LABEL_TABLE_ANCHOR}」）：抽不到名單就不能判標籤合不合法`);
  const labels = [];
  for (const line of text.slice(at).split('\n')) {
    if (!line.startsWith('|')) {
      if (labels.length) break;
      continue;
    }
    const first = line.split('|')[1].trim();
    if (!first || first.startsWith('---') || first === '標籤') continue;
    labels.push(first);
  }
  assert.ok(labels.length >= 2, `MACHINES.md 的執行者標籤表只抽到 ${labels.length} 個名字：表的形狀變了`);
  return labels;
}

/** 把資料攤平成一條一筆（子點跟著）。契約由 build-rules.js 的 validate 說了算，這裡不另寫一份。 */
function allRules(data) {
  const rules = [];
  for (const section of data.sections) {
    for (const rule of section.rules) {
      rules.push({ id: `${section.letter}${rule.n}`, text: rule.text, items: (rule.items || []).map((item) => item.text), tag: rule.tag });
    }
  }
  return rules;
}

test('rules.json 合資料契約（欄位不會跑出自己的位置）', () => {
  assert.deepEqual(validate(read()), [], '資料不合契約');
});

/**
 * 每個會被輸出的欄位，配上產生器對它用的那一個編碼器：標題那幾欄只走 literal（沒有記號可拿掉）；
 * 主句、子點、標籤走 inline（第三格＝true，外洩檢查前先拿掉合格記號）。
 */
function everyField(data) {
  const fields = [
    ['本文標題', data.title, false],
    ['開頭那句指路', data.preamble, false],
  ];
  for (const section of data.sections) {
    fields.push([`小節 ${section.letter} 的標題`, section.title, false]);
    for (const rule of section.rules) {
      fields.push([`${section.letter}${rule.n} 的正文`, rule.text, true]);
      (rule.items || []).forEach((item, k) => fields.push([`${section.letter}${rule.n} 的第 ${k + 1} 個子點`, item.text, true]));
      fields.push([`${section.letter}${rule.n} 的標籤`, rule.tag, true]);
    }
  }
  return fields;
}

test('每個欄位都被編成字面文字：拿掉合格記號後沒有漏跳脫的標點，而且解回來與原文相同', () => {
  const data = read();
  assert.deepEqual(validate(data), [], '資料不合契約，編碼檢查不算數');
  const roles = data.roles || [];
  for (const [what, value, rich] of everyField(data)) {
    const encoded = rich ? inline(value, roles) : literal(value);
    assert.equal(plain(encoded), value, `${what} 編過再解回來跟原文不一樣：編碼把文字改掉了`);
    // 合格記號只在走 inline 的欄位裡；資料已過契約，編過的文字裡拼得出記號形狀的就只有它們
    const outside = rich ? encoded.replace(MARK, '') : encoded;
    const leaked = outside.replace(/\\[!-/:-@[-`{-~]/gu, '').match(/[!-/:-@[-`{-~]/u);
    assert.equal(leaked, null, `${what} 編出去之後還留著沒跳脫的標點「${leaked && leaked[0]}」：它在本文裡還有語法能力`);
  }
});

test('整份本文解回來，就是範本填上資料裡的原文（多不出任何東西）', () => {
  const data = read();
  assert.equal(plain(build(data)), buildRaw(data), '本文解回來跟「範本填上原文」對不上：本文裡多了或少了東西');
});

test('規矩正文不超過 7,000 字（數法見 MACHINES.md 的 K2 那一列）', () => {
  const data = read();
  assert.deepEqual(validate(data), [], '資料不合契約，字數算出來不算數');
  const rules = allRules(data);
  assert.ok(rules.length >= MIN_RULES, `只找到 ${rules.length} 條規矩：契約的地板是 ${MIN_RULES}`);
  const count = countRules(data);
  assert.ok(
    count <= LIMIT,
    `規矩正文現在 ${count} 字（${rules.length} 條），上限 ${LIMIT}（本文 K2）：先瘦身；新條要過進門五問（問法在協作套件倉庫 README.md 的「進門規則」）`,
  );
});

test('每條規矩的執行者標籤都以一個已定義的名字開頭', () => {
  const labels = definedLabels();
  const data = read();
  assert.deepEqual(validate(data), [], '資料不合契約，標籤檢查不算數');
  for (const rule of allRules(data)) {
    assert.ok(
      labels.some((l) => rule.tag.startsWith(l)),
      `${rule.id} 的標籤「${rule.tag}」沒有以已定義的執行者名字開頭（${labels.join('／')}）`,
    );
  }
});

test('RULES.md 與 rules.json 產生的結果逐字元相同（本文是產物、不要手改）', () => {
  const onDisk = fs.readFileSync(outFile, 'utf8');
  assert.equal(
    onDisk,
    build(read()),
    `RULES.md 跟 ${path.basename(dataFile)} 對不上：本文是產物，要改規矩請改資料再跑 node tools/build-rules.js`,
  );
});

// ── 按需印條文（擁有者 2026-10-12 要求做完稽核「按需載入-1」印條文那一半）──
// 合併、送審、問裁示那幾支工具在輸出後面印相關的幾條原文。要守的是：印出來的就是 RULES.md 裡那一條，
// 不是另寫的一份（K1 不複述）；印不出來時工具照常、退出碼不變。

/**
 * RULES.md 裡某一條的完整那幾行：從條號那一行起，到下一條的條號或下一節的標題之前，去掉結尾的空行。
 * 只比「出現過」不夠（Grok 掃 #88）：少了標籤行、只剩第一行的印法，前段照樣出現在本文裡。
 */
function ruleSegment(onDisk, id) {
  const lines = onDisk.split('\n');
  const starts = lines.flatMap((l, i) => (l.startsWith(`【${id}】`) ? [i] : []));
  assert.equal(starts.length, 1, `${id}：RULES.md 裡這一條的條號行要剛好一行（實際 ${starts.length} 行）`);
  let end = starts[0] + 1;
  while (end < lines.length && !lines[end].startsWith('【') && !lines[end].startsWith('## ')) end += 1;
  const seg = lines.slice(starts[0], end);
  while (seg.length && seg[seg.length - 1] === '') seg.pop();
  return seg.join('\n');
}

test('按需印條文：每一條印出來的就是 RULES.md 裡那一整條（字面編碼逐字相同、從條號到標籤一行不少、解回來就是印的原文）', () => {
  const data = read();
  const onDisk = fs.readFileSync(outFile, 'utf8');
  const ids = allRules(data).map((r) => r.id);
  assert.ok(ids.length >= MIN_RULES, `只找到 ${ids.length} 條規矩：這一題自己的前提變了`);
  for (const id of ids) {
    const md = excerpt(data, [id], { markdown: true });
    assert.equal(md, ruleSegment(onDisk, id), `${id}：印出來的字面編碼不是 RULES.md 裡那一整條（範本或編碼跟本文分岔了，或少印了幾行）`);
    assert.equal(plain(md), excerpt(data, [id]), `${id}：印給人看的原文跟本文那一條解回來的不一樣`);
  }
});

test('按需印條文：給節的字母＝整節照順序；重複的只印一次、照給的順序', () => {
  const data = read();
  const section = data.sections.find((s) => s.letter === 'I');
  assert.ok(section && section.rules.length >= 2, 'I 節不見了或只剩一條：這一題自己的前提變了');
  const one = (id) => excerpt(data, [id]);
  assert.equal(excerpt(data, ['I']), section.rules.map((r) => one(`I${r.n}`)).join('\n\n'), '整節要是那一節每一條依序接起來');
  assert.equal(excerpt(data, ['H6', 'H1', 'H6']), `${one('H6')}\n\n${one('H1')}`, '重複的只印一次、照給的順序');
  assert.equal(excerpt(data, ['I', 'I1']), excerpt(data, ['I']), '整節已經印過的那一條不再印');
  assert.ok(!excerpt(data, ['H1']).endsWith('\n'), '最後不帶空行（接在工具輸出後面才不會多空一段）');
});

test('按需印條文：條號或節不存在、沒給、資料不合契約都丟例外，不印半份', () => {
  const data = read();
  for (const bad of [['Z1'], ['H99'], ['h1'], ['H0'], ['H1x'], ['Z'], ['H1', 'Q7']]) {
    assert.throws(() => excerpt(data, bad), /不認得的條號或節/u, `${bad.join(',')}：要丟例外`);
  }
  assert.throws(() => excerpt(data, []), /沒有指定任何條號/u);
  const broken = JSON.parse(JSON.stringify(data));
  broken.sections[0].rules[0].text = '有\n換行';
  assert.throws(() => excerpt(broken, ['A1']), /不合資料契約/u);
});

test('按需印條文：工具接在後面的那幾行——印得出來接原文；印不出來只有空行加一行說明、指回 RULES.md、不帶檔案路徑、不丟例外', () => {
  const data = read();
  const ok = ruleFooter(['D1', 'I'], { load: () => data });
  assert.equal(ok[0], '', '跟工具自己的輸出隔一個空行');
  assert.match(ok[1], /D1、I 節；從 rules\.json 印出，跟 RULES\.md 同一條/u);
  assert.equal(ok[2], excerpt(data, ['D1', 'I']));
  assert.equal(ok.length, 3);
  // 讀檔錯誤的原文帶著本機絕對路徑（B5）：只說哪一類
  const fsError = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/秘密資料夾/rules.json'"), { code: 'ENOENT' });
  const unreadable = ruleFooter(['H1'], { load: () => { throw fsError; } });
  assert.deepEqual(unreadable, ['', '（這一步相關的規矩是 H1，但條文印不出來：讀不到 rules.json（ENOENT）——直接看 RULES.md 那幾條）']);
  const notJson = ruleFooter(['H1'], { load: () => JSON.parse('{ 壞掉 /Users/someone/秘密資料夾') });
  assert.deepEqual(notJson, ['', '（這一步相關的規矩是 H1，但條文印不出來：rules.json 不是合格的 JSON——直接看 RULES.md 那幾條）']);
  for (const line of [...unreadable, ...notJson]) assert.ok(!line.includes('/Users/') && !line.includes('秘密資料夾'), `不可以帶出路徑：${line}`);
  const broken = JSON.parse(JSON.stringify(data));
  broken.sections[0].rules[0].text = '有\n換行';
  assert.deepEqual(ruleFooter(['A1'], { load: () => broken }), ['', '（這一步相關的規矩是 A1，但條文印不出來：rules.json 不合資料契約，印不出條文：——直接看 RULES.md 那幾條）'], '契約不合只留第一句');
  const unknown = ruleFooter(['H99'], { load: () => data });
  assert.equal(unknown.length, 2);
  assert.match(unknown[1], /^（這一步相關的規矩是 H99，但條文印不出來：不認得的條號或節「H99」/u);
});

test('按需印條文：指令列只認「不給參數」與「--rules <條號,…>」，其餘退 2；印條文與打錯都不寫本文（打錯不會靜靜改去重寫本文）', () => {
  assert.deepEqual(parseCli([]), { mode: 'write' });
  assert.deepEqual(parseCli(['--rules', 'H1, H6,,']), { mode: 'print', ids: ['H1', 'H6'] });
  for (const bad of [['--rules'], ['--rules', ' , '], ['--rule', 'H1'], ['--rules', 'H1', 'H6'], ['H1'], ['--rules=H1']]) {
    assert.ok(parseCli(bad).error, `${bad.join(' ')}：要當用法錯`);
  }
  // 每一發都在複本裡先放一份獨一無二的本文哨兵，跑完、複本收掉之前讀回來：只印、打錯、條號不存在都要原樣留著
  const run = (args, sentinel) => runInCopy('tools/build-rules.js', args, {
    files: ['rules.json'],
    seed: sentinel === undefined ? {} : { 'RULES.md': sentinel },
    after: (dir) => (fs.existsSync(path.join(dir, 'RULES.md')) ? fs.readFileSync(path.join(dir, 'RULES.md'), 'utf8') : null),
  });
  const printed = run(['--rules', 'H1,H6'], 'SENTINEL-PRINT\n');
  assert.equal(printed.status, 0, printed.stdout + printed.stderr);
  assert.equal(printed.stdout, `${excerpt(read(), ['H1', 'H6'])}\n`, '印出來的就是那兩條的原文、沒有別的');
  assert.equal(printed.after, 'SENTINEL-PRINT\n', '--rules 只印、不可以動到本文');
  const typo = run(['--rule', 'H1'], 'SENTINEL-TYPO\n');
  assert.equal(typo.status, 2, typo.stdout + typo.stderr);
  assert.match(typo.stderr, /用法/u);
  assert.equal(typo.stdout, '', '用法錯就什麼都不印到標準輸出');
  assert.equal(typo.after, 'SENTINEL-TYPO\n', '打錯參數不可以改去重寫本文');
  const unknown = run(['--rules', 'H99'], 'SENTINEL-UNKNOWN\n');
  assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
  assert.match(unknown.stderr, /不認得的條號或節「H99」/u);
  assert.equal(unknown.after, 'SENTINEL-UNKNOWN\n', '條號不存在也不可以動到本文');
  // 本文原本不存在：只印、打錯都不可以把它生出來
  for (const args of [['--rules', 'H1'], ['--rule', 'H1']]) {
    const r = run(args);
    assert.equal(r.after, null, `${args.join(' ')}：原本沒有本文，跑完也不可以多出一份`);
  }
  // 讀不到 rules.json：兩種用法都退 2、只說哪一類，不帶複本的路徑、不印堆疊，也不生出本文（B5；Grok 掃 #88）
  for (const args of [['--rules', 'H1'], []]) {
    const r = runInCopy('tools/build-rules.js', args, {
      after: (dir) => ({ dir, made: fs.existsSync(path.join(dir, 'RULES.md')) }),
    });
    assert.equal(r.status, 2, `${args.join(' ') || '不給參數'}：${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '讀不到 rules.json（ENOENT）：沒有產生、也沒有印任何東西\n');
    assert.ok(!r.stderr.includes(r.after.dir), '不可以帶出路徑');
    assert.equal(r.after.made, false, '讀不到就什麼都不寫');
  }
  // 對照組：不給參數照舊重產本文（證明 after 讀得到工具寫的檔，上面那幾發不是因為讀不到才綠）
  const write = run([], 'SENTINEL-WRITE\n');
  assert.equal(write.status, 0, write.stdout + write.stderr);
  assert.equal(write.after, build(read()), '不給參數＝重產本文，內容跟 rules.json 產生的一樣');
  assert.doesNotMatch(write.stdout, /對照表/u, '複本未放 GLOSSARY.md 時不附對照表字數');
  // 有放 GLOSSARY.md 時，並列印出對照表去空白字數（防規矩字數瘦身卻往對照表灌水）
  assert.equal(glossaryFile, path.join(__dirname, '..', 'GLOSSARY.md'), 'glossaryFile 指向根目錄 GLOSSARY.md');
  assert.equal(countGlossary('甲 乙\n丙\t丁'), 4, 'countGlossary 數去空白後的字元數');
  const sampleGlossary = '# 用語\n\n- **甲**：乙丙\n';
  const writeWithGlossary = runInCopy('tools/build-rules.js', [], {
    files: ['rules.json'],
    seed: { 'GLOSSARY.md': sampleGlossary },
  });
  assert.equal(writeWithGlossary.status, 0, writeWithGlossary.stdout + writeWithGlossary.stderr);
  assert.match(writeWithGlossary.stdout, new RegExp(`（對照表 ${countGlossary(sampleGlossary)} 字）`, 'u'), '有 GLOSSARY.md 時並列印出對照表字數');
});
