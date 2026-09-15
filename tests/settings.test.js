// 守「專案設定只有一份」：值住在 settings.json，PROJECT-SETTINGS.md 是產物。
//
// 為什麼：每一支機器都要讀專案設定。值若只寫在那份 Markdown 裡，機器得去解讀表格；
// 兩邊各存一份就會漂——案例簿裡「同一條規矩寫在六個地方各漏一項」是有代價的實例。
//
// 守得到的：
//   ①PROJECT-SETTINGS.md 與重新產生的結果逐字元相同（手改就紅）；
//   ②每個會被輸出的欄位都合契約（單行、非空、無空字元），並且編成字面文字；
//   ③機器啟用狀態只能填約定的那三種；
//   ④啟用表裡每一支機器標的規矩條號都真的存在（機器與規矩兩份不可以各指各的）；
//   ⑤**標籤與登記不可以互相矛盾**：本文標「靠自覺」的條號，不可以同時有一支「已啟用」的機器登記在它名下。
//     2026-09-13 稽核抓到三條（A1、A5、K1）：本文說沒有機器、登記表說已啟用。收法是兩邊各退一步——
//     合併指令不讀合併預授權，所以它只登記 H1；設定產生器守的是「值只有一份」，所以改登記 K1；
//     而 K1 確實有機器守（三份產物逐字元比對），所以標籤照實改掉，不再寫「靠自覺」。
//   ⑥本文與機器索引指名的每一份範本都要真的在，而且帶著它自己的固定小標；
//   ⑦每一支工具都要有同名的考題檔。2026-09-13 稽核抓到：整支考題檔改名或刪掉，全卷照樣退 0——
//     沒有任何東西在數考題。這一題就是那個金絲雀；
//   ⑧**閘的登記對帳（規矩 H1）**：tools/gates/ 裡的每一支閘都要登記在 settings.json 的 gates，
//     登記的每一道閘檔案都要在——磁碟與登記是兩個獨立來源，一邊漏了另一邊就紅。
//     原專案的對帳題是「腳本自報的閘名 vs 文件點名的閘名」；這裡文件是產物、閘由合併指令從登記讀，
//     所以第二個獨立來源只剩磁碟上的檔案。合併指令只跑登記的閘，所以「寫了閘卻忘了登記」正是這題要抓的。
//
//   ⑨**考題用的空白設定跟得上真設定**（2026-09-13 搬家驗屋）：「真的跑一遍指令」的題改在複本裡、配一份空白設定跑，
//     不讀本倉庫那份（專案填了真設定之後，讀它＝紅燈、問真平台、在真禁區埋假機密）。那份空白設定的欄位名與型別
//     要跟 settings.json 一模一樣，而且對外動作的欄位真的都是「未設定」——不然複本裡跑的就不是「沒填」那條路。
//
// ⚠️ 守不到的：欄位填的值對不對（填了「未設定」以外的字不代表那台機器真的裝好）、
//    「已啟用」是不是真的啟用（那要靠人去驗，驗過才把日期填上）、
//    以及機器索引 MACHINES.md 與這張啟用表有沒有漏對——那兩份的表是不同軸（一份按規矩條號、
//    一份按機器），我試過拿名字互比，結果是拿標籤定義表去比機器名，屬於誤判，已撤掉。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, read, outFile, STATES } = require('../tools/build-settings.js');
const { read: readRules } = require('../tools/build-rules.js');
const { unfilled, UNFILLED_FILE } = require('./helpers/kit-copy.js');

test('PROJECT-SETTINGS.md 與 settings.json 產生的結果逐字元相同（設定說明是產物、不要手改）', () => {
  assert.equal(
    fs.readFileSync(outFile, 'utf8'),
    build(read()),
    'PROJECT-SETTINGS.md 跟 settings.json 對不上：那份說明是產物，要改請改 settings.json，再跑 node tools/build-settings.js',
  );
});

test('啟用狀態只能填約定的那三種', () => {
  for (const machine of read().machines) {
    assert.ok(
      STATES.includes(machine.state),
      `機器「${machine.name}」的狀態是「${machine.state}」，不在 ${STATES.join('／')} 裡`,
    );
  }
});

test('啟用表裡每一支機器標的規矩條號都存在', () => {
  const ids = [];
  for (const section of readRules().sections) {
    for (const rule of section.rules) ids.push(`${section.letter}${rule.n}`);
  }
  for (const machine of read().machines) {
    const cited = machine.rules.split('、').map((x) => x.trim()).filter(Boolean);
    assert.ok(cited.length > 0, `機器「${machine.name}」沒有標任何規矩條號`);
    for (const id of cited) {
      assert.ok(ids.includes(id), `機器「${machine.name}」標了不存在的條號 ${id}`);
    }
  }
});

/** 從 MACHINES.md 的標籤定義表抽名字（跟 rules-length 那題同一個來源），再判一個標籤的**名字**是哪一個。 */
function labelNames() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'MACHINES.md'), 'utf8');
  const at = text.indexOf('句尾的執行者標籤，定義在這裡、只在這裡');
  assert.ok(at >= 0, '找不到標籤定義表');
  const names = [];
  for (const line of text.slice(at).split('\n')) {
    if (!line.startsWith('|')) { if (names.length) break; continue; }
    const first = line.split('|')[1].trim();
    if (!first || first.startsWith('---') || first === '標籤') continue;
    names.push(first);
  }
  assert.ok(names.includes('靠自覺'), '定義表裡要有「靠自覺」');
  return names;
}
const labelOf = (tag, names) => names.filter((n) => tag.startsWith(n)).sort((a, b) => b.length - a.length)[0] || null;

/**
 * 標籤與登記互相矛盾的清單（空＝沒矛盾）。已安裝未啟用的也算（搬家修正 r1 B2）：專案填完設定就會把它改成已啟用——
 * 只看已啟用的話，套件倉庫裡永遠綠、專案一啟用才紅（待裁清單工具就是這樣撞上的）。只有還沒移植的不算。
 */
function contradictions(machines, tags, names) {
  const out = [];
  for (const machine of machines) {
    if (machine.state === '未移植') continue;
    for (const id of machine.rules.split('、').map((x) => x.trim()).filter(Boolean)) {
      const tag = tags.get(id);
      if (!tag) { out.push(`機器「${machine.name}」標了不存在的條號 ${id}`); continue; }
      // r1 Medium⑭：原本只比整串等於「靠自覺」，加一句射程說明（「靠自覺；尚未接線」）就繞過去了
      if (labelOf(tag, names) === '靠自覺') {
        out.push(`機器「${machine.name}」登記成${machine.state}、標的是 ${id}，但本文說 ${id} 靠自覺（「${tag}」）——兩份說法必須擇一改正，不可以並存`);
      }
    }
  }
  return out;
}

test('本文標「靠自覺」的條號，不可以同時有一支已安裝或已啟用的機器登記在它名下（看標籤的名字，不看整串）', () => {
  const names = labelNames();
  const tags = new Map();
  for (const section of readRules().sections) {
    for (const rule of section.rules) tags.set(`${section.letter}${rule.n}`, rule.tag);
  }
  assert.deepEqual(contradictions(read().machines, tags, names), []);
  // 判準本身（假資料）：已安裝未啟用的也要抓；還沒移植的不抓；標籤名字看開頭
  const fakeTags = new Map([['Z1', '靠自覺；工具只列清單'], ['Z2', '清單腳本列；照做靠自覺']]);
  const m = (state, rules = 'Z1') => ({ name: `假機器（${state}）`, rules, state });
  assert.equal(contradictions([m('已安裝未啟用')], fakeTags, names).length, 1, '已安裝未啟用、掛在靠自覺底下＝矛盾（專案一啟用就撞）');
  assert.equal(contradictions([m('已啟用')], fakeTags, names).length, 1);
  assert.equal(contradictions([m('未移植')], fakeTags, names).length, 0, '還沒移植的不算');
  assert.equal(contradictions([m('已啟用', 'Z2')], fakeTags, names).length, 0, '標籤開頭是機器名字＝不矛盾');
  assert.equal(labelOf('靠自覺；尚未接線', names), '靠自覺', '帶射程說明的標籤名字還是靠自覺');
  assert.equal(labelOf('考題只守清單一致；合理性靠自覺', names), '考題', '名字看開頭，不看後面提到的字');
});

test('本文與機器索引指名的每一份範本都在，而且帶著自己的固定小標', () => {
  const root = path.join(__dirname, '..');
  const machines = fs.readFileSync(path.join(root, 'MACHINES.md'), 'utf8');
  const cited = [...machines.matchAll(/`(templates\/[a-z0-9-]+(?:\.(?:md|json|yml))?)`/gu)].map((m) => m[1]);
  assert.ok(cited.length >= 5, `機器索引只指到 ${cited.length} 份範本：那張表的形狀變了`);
  const onDisk = fs.readdirSync(path.join(root, 'templates')).map((f) => `templates/${f}`);
  for (const file of new Set(cited)) {
    assert.ok(onDisk.includes(file), `機器索引指到 ${file}，但檔案不在`);
  }
  for (const file of onDisk) {
    assert.ok(cited.includes(file), `${file} 在倉庫裡，但機器索引那張表沒指到它——沒人指的範本會靜靜爛掉`);
  }
  // 固定小標是規矩 E1、G3 指名的字串：範本要真的吐得出來——**在機器讀得到的行的行首**，不是藏在註解或圍欄裡
  // （r1 Medium⑮：原本用 includes，把小標改成 HTML 註解照樣綠，填範本後畫面上根本沒有那個小標）
  // 「讀哪些行」只有一份實作（r2 Medium③：這裡原本自己寫一份，三個反引號就提早關掉四個反引號的圍欄）
  // r5 之後只讀開頭那一段：固定小標要出現在範本的第一個特殊行（引用、圍欄、註解、圖片、連結定義、縮排…）之前
  const { leadingLines } = require('../tools/markdown-effective.js');
  const hasHeading = (md, re) => leadingLines(md).lines.some((l) => re.test(l));
  const must = [['templates/pr-body.md', /^### 複審後掃\s*$/u], ['templates/scan-record.md', /^\*\*掃描時序\*\*/u]];
  for (const [file, re] of must) {
    const md = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(hasHeading(md, re), `${file} 開頭那一段裡找不到固定小標 ${re}（讀到第 ${leadingLines(md).stopAt} 行就停了）`);
  }
  const H = /^### 複審後掃\s*$/u;
  assert.ok(hasHeading('a\n### 複審後掃\nb', H), '對照組：正常寫的小標要認得');
  assert.ok(!hasHeading('a\n<!--\n### 複審後掃\n-->\nb', H), '小標包在註解裡＝不算');
  assert.ok(!hasHeading('```\n### 複審後掃\n```', H), '圍欄裡的行不算');
  assert.ok(!hasHeading('````md\n範例\n```\n### 複審後掃\n````\nb', H), '四反引號圍欄（r2 反例）');
  assert.ok(!hasHeading(['```md', '<!--', '```', '-->', '```', '### 複審後掃', '```', 'b'].join('\n'), H), '交錯的註解與圍欄（r3 反例）');
  for (const f of ['```', '~~~']) {
    assert.ok(!hasHeading([`${f}md <!--`, 'x', f, `${f}md`, '-->', '### 複審後掃', f].join('\n'), H), `${f}：圍欄開頭行帶註解記號（r4 反例）`);
  }
  assert.ok(!hasHeading('> 上輪\n### 複審後掃', H), '引用後直接接小標：不在開頭那一段（r5 反例三；要寫在引用前面）');
});

test('每一支工具都有同名的考題檔（考題檔被刪掉或改名要有人發現）', () => {
  const root = path.join(__dirname, '..');
  const toolsDir = path.join(root, 'tools');
  const gatesDir = path.join(toolsDir, 'gates');
  const tools = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js')).sort();
  // 閘住在 tools/gates/，一樣要有同名考題（新增一道閘就一定被數到）
  const gates = fs.existsSync(gatesDir) ? fs.readdirSync(gatesDir).filter((f) => f.endsWith('.js')).sort() : [];
  const tests = new Set(fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')));
  assert.ok(tools.length >= 5, `tools/ 只剩 ${tools.length} 支：這一題自己的前提變了`);
  // 產生器三支共用同一份資料契約，考題另立一支；其餘一支工具對一支考題
  const shared = {
    'build-rules.js': 'rules-length.test.js',
    'build-casebook-index.js': 'casebook.test.js',
    'build-settings.js': 'settings.test.js',
    'settings-data.js': 'settings.test.js',   // 只有一個讀取函式，跟設定產生器同一支考題
  };
  for (const tool of tools) {
    const expected = shared[tool] || tool.replace(/\.js$/u, '.test.js');
    assert.ok(tests.has(expected), `工具 ${tool} 找不到對應的考題檔 ${expected}——被刪掉或改名了嗎`);
  }
  for (const gate of gates) {
    const expected = gate.replace(/\.js$/u, '.test.js');
    assert.ok(tests.has(expected), `閘 gates/${gate} 找不到對應的考題檔 ${expected}——被刪掉或改名了嗎`);
  }
  assert.ok(tests.has('data-contract.test.js'), '資料契約的負向考題不見了');
  // 跟 tests/manifest.test.js 互相盯著（r1 Medium⑫：這一支自己被刪掉時原本沒有人數考題）
  assert.ok(tests.has('manifest.test.js'), '考題清單那一支不見了');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  assert.ok(manifest.includes('settings.test.js'), '這一支要在清單上');
});

test('閘的登記對帳（規矩 H1）：磁碟上的每一支閘都有登記，登記的每一道閘都在磁碟上', () => {
  const root = path.join(__dirname, '..');
  const onDisk = fs.readdirSync(path.join(root, 'tools', 'gates')).filter((f) => f.endsWith('.js')).map((f) => `tools/gates/${f}`).sort();
  assert.ok(onDisk.length >= 5, `tools/gates/ 只剩 ${onDisk.length} 支：這一題自己的前提變了`);
  // 每一筆登記先驗形狀、再對帳；不先濾掉看不懂的登記（r1 Medium⑬：濾掉＝登記了不存在的閘也全綠）
  const registered = [];
  for (const g of read().gates) {
    assert.equal(g.command, 'node', `閘「${g.name}」的指令不是 node：登記的形狀變了`);
    assert.ok(Array.isArray(g.args) && g.args.length === 1 && typeof g.args[0] === 'string', `閘「${g.name}」的參數不是剛好一個檔案路徑`);
    assert.ok(g.args[0].startsWith('tools/gates/') && g.args[0].endsWith('.js'), `閘「${g.name}」登記的路徑「${g.args[0]}」不在 tools/gates/ 底下`);
    assert.ok(fs.existsSync(path.join(root, g.args[0])), `閘「${g.name}」登記的檔案「${g.args[0]}」不存在`);
    assert.ok(!registered.includes(g.args[0]), `閘「${g.name}」的檔案「${g.args[0]}」被登記了兩次`);
    registered.push(g.args[0]);
  }
  registered.sort();
  for (const file of onDisk) assert.ok(registered.includes(file), `磁碟上有 ${file}，但 settings.json 的 gates 沒登記它——合併指令不會跑它`);
  assert.deepEqual(registered, onDisk, '登記的集合要跟磁碟一模一樣');
});

test('⑨考題用的空白設定跟 settings.json 形狀一致，而且對外動作的欄位真的沒填', () => {
  // 形狀＝欄位名與型別；陣列只看「是陣列」（填設定會改長度）
  const shape = (v) => (Array.isArray(v) ? 'array'
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])])) : typeof v);
  assert.deepEqual(shape(unfilled()), shape(read()), `${path.basename(UNFILLED_FILE)} 的形狀跟 settings.json 不一樣：設定多了或少了一欄，空白設定要一起改`);
  assert.notDeepEqual(shape({ a: { b: 1 } }), shape({ a: { b: '1' } }), '對照組：型別變了要看得出來');
  assert.notDeepEqual(shape({ a: {} }), shape({ a: { b: [] } }), '對照組：多一欄要看得出來');

  const u = unfilled();
  const UNSET = '未設定';
  assert.equal(u.mainBranch, UNSET);
  assert.equal(u.platform.project, UNSET);
  for (const [op, argv] of Object.entries(u.platform.operations)) assert.deepEqual(argv, [UNSET], `平台動作 ${op} 要沒填`);
  assert.equal(u.forbidden.name, UNSET);
  assert.equal(u.scanner.isolation.provider, UNSET);
  assert.deepEqual(u.scanner.isolation.forbidden, [], '空白設定不可以登記任何禁區（複本裡跑試探才不會去埋）');
  assert.equal(u.mergeCommand.command, UNSET);
  assert.deepEqual(u.checks.commands, [[UNSET]]);
  for (const p of u.participants) assert.equal(p.id, UNSET, `身分「${p.role}」要沒填`);
});

test('照 GitHub 範本填完平台動作與合併指令，設定說明書照樣產得出來；合併訊息的換行留在指令裡（搬家修正 r1 B1）', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'platform-github.json'), 'utf8'));
  const filled = JSON.parse(JSON.stringify(read()));
  filled.platform = { ...filled.platform, name: 'GitHub', project: 'owner/repo', clearEnv: tpl.clearEnv, operations: tpl.operations };
  filled.mergeCommand = tpl.mergeCommand;
  assert.ok(filled.mergeCommand.args.some((a) => a.includes('\n')), '前提：範本的合併訊息真的是兩行');
  let md;
  assert.doesNotThrow(() => { md = build(filled); }, '照範本抄完，產生器不可以停在「有換行」');
  const line = md.split('\n').find((l) => l.startsWith('全綠之後執行的合併指令：'));
  assert.ok(line, '說明書裡要有合併指令那一行');
  // 說明書把 ASCII 標點一律跳脫（字面編碼），所以比對跳脫後的樣子
  assert.ok(line.includes('Reviewed\\-By'), `說明書那一行要看得到 Reviewed-By：${line}`);
  assert.ok(line.includes('\\\\n'), '換行在說明書裡寫成看得見的 \\n（跳脫後是兩個反斜線加 n）');
  assert.ok(md.includes('allComments'), '十個動作都排得出來');
});
