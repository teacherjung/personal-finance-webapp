// @ts-check
// 基準版本自動對齊（`scripts/sync-pr-base-version.js`）的行為卷。
//
// ⚠️ **這份考題的主軸是「同一把尺」**：改出來的結果一律拿**閘自己的**
//    `staleBaseProblems` 重驗，而不是拿另一份手寫的期望字串比對。
//    理由＝這支腳本唯一的職責就是「讓閘過」，用別的尺量它等於量錯東西
//    （同 blank-round 那次的教訓：對照組要先確認變因是誰）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldValue, problemsOf, staleBaseProblems } from '../scripts/check-pr-collab-fields.js';
import { rewriteBaseVersion, parsePushRefs, maskComments, baseFieldSpan, main } from '../scripts/sync-pr-base-version.js';

const OLD = 'd6c4fbd11111111111111111111111111111aaaa';
const NEW = 'f76d12b22222222222222222222222222222bbbb';

/** 五欄齊全的說明；`base` 那一段由各題自己給。 */
const bodyWith = (base) => [
  '## 這支在做什麼',
  '把欄位對齊。',
  '',
  '- **實作者**：Claude',
  '- **獨立審查者**：Codex',
  `- **基準版本**：${base}`,
  '- **預計修改的共享檔案**：scripts/git-hooks/pre-push',
  '- **這支若完全失敗，最糟失去什麼**：什麼都不會失去，退回手動改欄位。',
].join('\n');

// ── 主軸：改完一定過得了閘 ──────────────────────────────────
for (const [name, base] of [
  ['短 SHA', `\`${OLD.slice(0, 7)}\``],
  ['40 碼全長', OLD],
  ['顯示值＋連結（兩段都要換）', `[${OLD.slice(0, 7)}](https://github.com/teacherjung/personal-finance-webapp/commit/${OLD})`],
  ['兩段短 SHA 並列', `${OLD.slice(0, 7)} / ${OLD.slice(0, 8)}`],
  ['粗體包住', `**${OLD.slice(0, 9)}**`],
  ['有序清單的欄位', OLD.slice(0, 12)],
]) {
  test(`對齊｜${name}：改完拿閘自己的尺驗＝零問題`, () => {
    const r = rewriteBaseVersion(bodyWith(base), NEW);
    assert.equal(r.changed, true, `沒改動：${r.reason}`);
    assert.deepEqual(staleBaseProblems(r.body, NEW), [],
      '改完的說明仍過不了閘——這支腳本唯一的職責就是讓閘過');
  });
}

test('對齊｜連結網址裡的舊 SHA 也被換掉（只改顯示值＝閘點名的「很常見的手滑」）', () => {
  const url = `https://github.com/teacherjung/personal-finance-webapp/commit/${OLD}`;
  const r = rewriteBaseVersion(bodyWith(`[${OLD.slice(0, 7)}](${url})`), NEW);
  assert.equal(r.changed, true);
  assert.ok(!r.body.includes(OLD.slice(0, 7)), '舊 SHA 還留在說明裡');
  assert.ok(r.body.includes(NEW.slice(0, 7)) && r.body.includes(NEW), '新 SHA 沒有兩段都寫進去');
  // ⚠️ **逐字比對整個欄位值**：只斷言「新 SHA 有出現」擋不住「順手把網址其他部分也改掉」——
  //    `teacherjung`／`finance` 這些字裡本來就有十六進位字母，判準一鬆就會被當成 SHA 換掉。
  const want = `[${NEW.slice(0, 7)}](https://github.com/teacherjung/personal-finance-webapp/commit/${NEW})`;
  assert.ok(r.body.includes(`- **基準版本**：${want}`), `欄位值被改成別的樣子：\n${r.body}`);
});

test('對齊｜各段保留原本長度（人寫的版面不被機器改樣子）', () => {
  const r = rewriteBaseVersion(bodyWith(`${OLD.slice(0, 7)} / ${OLD.slice(0, 12)}`), NEW);
  assert.ok(r.body.includes(`${NEW.slice(0, 7)} / ${NEW.slice(0, 12)}`), `實得：${r.body}`);
});

// ── 不可以「補得像填過了」──────────────────────────────────
test('不動｜欄位空白＝模板沒填的真訊號，不由機器補上', () => {
  const r = rewriteBaseVersion(bodyWith(''), NEW);
  assert.equal(r.changed, false);
  assert.ok(staleBaseProblems(r.body, NEW).length > 0, '空欄位被補成通過了＝把「沒填」變成靜靜通過');
});

test('不動｜欄位填了讀不出 SHA 的東西也不補（不猜）', () => {
  const r = rewriteBaseVersion(bodyWith('最新的那顆'), NEW);
  assert.equal(r.changed, false);
  assert.ok(staleBaseProblems(r.body, NEW).length > 0);
});

test('不動｜已經是這顆 commit 就不改（省掉一次沒必要的 edited 場次）', () => {
  const r = rewriteBaseVersion(bodyWith(NEW.slice(0, 7)), NEW);
  assert.equal(r.changed, false);
  assert.deepEqual(staleBaseProblems(r.body, NEW), []);
});

test('不動｜給的不是合法 40 碼 SHA 就什麼都不做', () => {
  for (const bad of ['', 'abc1234', NEW.toUpperCase(), `${NEW}f`]) {
    assert.equal(rewriteBaseVersion(bodyWith(OLD), bad).changed, false, `${bad} 被當成合法 SHA`);
  }
});

// ── HTML 註解：閘剝掉它，這支也必須當它不存在 ────────────────
test('註解｜只改真欄位，不改註解裡的填寫說明（否則真欄位還是舊的）', () => {
  // ⚠️ 形狀照抄真模板 `.github/pull_request_template.md`：**多行**註解區塊、
  //    裡面那行是行首帶項目符號的 `- **基準版本**：…`＝**匹配得到欄位正則**。
  //    而且刻意排在真欄位**前面**——不遮註解的話，第一個匹配就會落在示範文字上，
  //    機器改了註解、真欄位原封不動 ⇒ 那一輪照樣紅，只是紅得更難查。
  const body = [
    '<!--',
    '- **基準版本**：審查要釘住的 commit（短 SHA 即可），例如 abc1234def',
    '-->',
    '- **實作者**：Claude',
    '- **獨立審查者**：Codex',
    `- **基準版本**：${OLD.slice(0, 7)}`,
    '- **預計修改的共享檔案**：無',
    '- **這支若完全失敗，最糟失去什麼**：無',
  ].join('\n');
  const r = rewriteBaseVersion(body, NEW);
  assert.equal(r.changed, true, `沒改動：${r.reason}`);
  assert.deepEqual(staleBaseProblems(r.body, NEW), [], '改完仍過不了閘＝改到註解那一行去了');
  assert.ok(r.body.includes('例如 abc1234def'), '註解裡的示範被機器改掉了（那是說明文字，不是欄位）');
});

test('註解｜遮罩保留換行與長度（偏移量要 1:1，行首錨定才不會跑掉）', () => {
  const src = 'a\n<!-- x\ny -->\nb';
  const masked = maskComments(src);
  assert.equal(masked.length, src.length, '遮罩後長度變了＝偏移量對不上原字串');
  assert.deepEqual(masked.split('\n').length, src.split('\n').length, '換行被遮掉了');
});

// ── 不可以順手把「別的欄位」也放行 ──────────────────────────
test('邊界｜對齊基準版本不會讓「實作者＝審查者」變成通過', () => {
  const body = bodyWith(OLD.slice(0, 7)).replace('- **獨立審查者**：Codex', '- **獨立審查者**：Claude');
  const r = rewriteBaseVersion(body, NEW);
  assert.equal(r.changed, true);
  assert.ok(problemsOf(r.body).some((p) => p.includes('沒有任何一份產出可以由寫它的人放行')),
    '自審被這支腳本順手洗白了');
});

test('邊界｜對齊基準版本不會補上缺掉的其他四欄', () => {
  const body = `- **基準版本**：${OLD.slice(0, 7)}`;
  const r = rewriteBaseVersion(body, NEW);
  assert.equal(r.changed, true);
  assert.equal(problemsOf(r.body).filter((p) => p.startsWith('缺「')).length, 4, '缺的欄位被補掉了');
});

// ── stdin 解析 ────────────────────────────────────────────
test('stdin｜只取「推分支、非刪除」的 ref', () => {
  const zero = '0'.repeat(40);
  const got = parsePushRefs([
    `refs/heads/claude/foo ${NEW} refs/heads/claude/foo ${OLD}`,
    `refs/heads/gone ${zero} refs/heads/gone ${OLD}`,          // 刪分支
    `refs/tags/v1 ${NEW} refs/tags/v1 ${zero}`,                 // tag
    '',
    'garbage',
  ].join('\n'));
  assert.deepEqual(got, [{ branch: 'claude/foo', sha: NEW }]);
});

test('stdin｜分支名含斜線不會被切斷', () => {
  const [got] = parsePushRefs(`refs/heads/claude/a/b/c ${NEW} refs/heads/claude/a/b/c ${OLD}`);
  assert.equal(got.branch, 'claude/a/b/c');
});

// ── 它不是閘：任何狀況都不准擋 push ─────────────────────────
test('不擋 push｜查 PR 爆炸也回 0，而且不改任何東西', () => {
  /** @type {string[]} */ const logs = [];
  let edits = 0;
  const code = main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    log: (s) => logs.push(s),
    find: () => { throw new Error('gh 掛了'); },
    edit: () => { edits += 1; },
  });
  assert.equal(edits, 0, '查不到 PR 卻還是去改了說明');
  assert.equal(code, 0, '這支不是閘，不該有權力擋 push');
  assert.ok(logs.join('\n').includes('gh 掛了'), '安靜吞掉了失敗——至少要講一句');
});

test('不擋 push｜改不進去也回 0', () => {
  const code = main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    log: () => {},
    find: () => ({ number: 1, body: bodyWith(OLD.slice(0, 7)) }),
    edit: () => { throw new Error('權限不足'); },
  });
  assert.equal(code, 0);
});

test('不擋 push｜還沒開 PR 是正常路徑（第一次推分支）', () => {
  /** @type {string[]} */ const logs = [];
  let edits = 0;
  const code = main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    log: (s) => logs.push(s),
    find: () => null,
    edit: () => { edits += 1; },
  });
  assert.equal(edits, 0, '沒有 PR 卻去改了說明');
  assert.equal(code, 0);
  assert.equal(logs.length, 0, '還沒開 PR 不該吵');
});

test('不擋 push｜真的有 PR 時，送出去的說明必須是驗過的那一份', () => {
  /** @type {string[]} */ const sent = [];
  main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    log: () => {},
    find: () => ({ number: 7, body: bodyWith(OLD.slice(0, 7)) }),
    edit: (n, b) => { assert.equal(n, 7); sent.push(b); },
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(staleBaseProblems(sent[0], NEW), [], '送出去的說明自己過不了閘');
});

// ── 遮罩法的已知極限：改得動、但改出來過不了閘 ⇒ 必須不動 ────
// ⚠️ 這一題是**那道「拿閘的尺回頭驗」守門的唯一證據**。沒有它，把那段 if 拆掉全卷照樣綠
//    （＝護欄自己證明不了自己有在跑）。輸入刻意刁鑽：註解夾在 SHA 中間。
//    閘會**刪掉**註解讀成一整段 `d6c4fbd1234`；這支是**遮成空白**，於是看成兩段、
//    只換得動後面那段 ⇒ 拼回去閘讀到的是 `d6c4` + 新 SHA 前綴＝對不上 head。
//    正確反應不是硬改，是**原樣留給閘**（維持今天的行為：紅一次，人來處理）。
test('極限｜註解夾在 SHA 中間：改得動但驗不過 ⇒ 什麼都不送出去', () => {
  const body = [
    '- **實作者**：Claude',
    '- **獨立審查者**：Codex',
    '- **基準版本**：d6c4<!--夾在中間-->fbd1234',
    '- **預計修改的共享檔案**：無',
    '- **這支若完全失敗，最糟失去什麼**：無',
  ].join('\n');

  // 先確認這個輸入真的踩得到那條路：rewrite 說「改動了」，但結果過不了閘
  const r = rewriteBaseVersion(body, NEW);
  assert.equal(r.changed, true, '這個輸入沒踩到守門，這一題就不是它的證據了');
  assert.ok(staleBaseProblems(r.body, NEW).length > 0, '這個輸入的結果居然過得了閘＝考題選錯輸入');

  // 真正要釘的行為：main 不可以把這份改壞的說明送出去
  /** @type {string[]} */ const logs = [];
  /** @type {string[]} */ const sent = [];
  main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    log: (s) => logs.push(s),
    find: () => ({ number: 9, body }),
    // ⚠️ **不可以在這裡 assert.fail**：`main` 把 edit 包在 try/catch 裡，丟出去會被吞掉、
    //    考題反而全綠（M3 突變實測過）。一律記下來、事後在 catch 外面斷言。
    edit: (_n, b) => { sent.push(b); },
  });
  assert.deepEqual(sent, [], '把自己都驗不過的說明送上去了——那份說明還是會紅，只是變成機器寫的');
  assert.ok(logs.join('\n').includes('驗不過'), '安靜地不做事＝下次沒人知道為什麼欄位沒動');
});

// ── 接線：pre-push 真的把 ref 餵給它 ────────────────────────
// ⚠️ 這是**行為題不是形狀題**：真的跑一次正式的 `scripts/git-hooks/pre-push`
//    （node／npm 用 stub 換掉，所以不必真的跑三關），再問「那支腳本收到了什麼」。
//    只斷言 hook 檔案裡有那行字的話，`$_refs` 被寫錯、stdin 被 npm test 讀光這兩種
//    真正會發生的壞法都看不出來。
//    ⚠️ 關卡**順序**由 test/worktree-integrity.test.js 那題釘（deepEqual 全序列），
//       這裡只釘「有沒有拿到 stdin」，兩題不重疊。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('接線｜pre-push 把 git 給的 ref 原樣餵進基準版本對齊', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-basever-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'calls.log');
    // stub：把「被呼叫的指令」與「它收到的 stdin」一起記下來
    for (const name of ['node', 'npm']) {
      const stub = join(bin, name);
      writeFileSync(stub, `#!/bin/sh\nin=$(cat)\nprintf '%s :: %s\\n' "${name} $*" "$in" >> ${JSON.stringify(log)}\nexit 0\n`);
      chmodSync(stub, 0o755);
    }
    const refs = `refs/heads/claude/demo ${NEW} refs/heads/claude/demo ${OLD}`;
    const r = spawnSync('sh', [join(ROOT, 'scripts', 'git-hooks', 'pre-push')], {
      encoding: 'utf8', cwd: ROOT, input: `${refs}\n`,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '' },
    });
    assert.equal(r.status, 0, `pre-push 在全關卡皆過時退出碼是 ${r.status}：\n${r.stdout}${r.stderr}`);

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const hit = lines.find((l) => l.includes('sync-pr-base-version.js'));
    assert.ok(hit, `pre-push 根本沒叫基準版本對齊：\n${lines.join('\n')}`);
    assert.ok(hit.includes(refs),
      `對齊腳本沒收到 git 給的 ref（很可能是 stdin 被前面的關卡讀走了）。實得：\n${hit}`);

    // ⚠️ 反向：前面的關卡**不可以**拿到那份 ref——拿得到就表示 stdin 沒被收乾淨，
    //    誰先讀誰贏，對齊腳本會時靈時不靈（跨機器的 flaky，最難查的那種）。
    for (const l of lines.filter((x) => !x.includes('sync-pr-base-version.js'))) {
      assert.ok(!l.includes(refs), `關卡「${l.split('::')[0].trim()}」也讀到了 ref＝stdin 沒收乾淨`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 同一把尺：手抄的欄位正則不可以跟閘漂開 ──────────────────
// ⚠️ `BASE_LINE_RE` 是 `check-pr-collab-fields.js` 那支 `fieldValue` 的**手抄本**
//    （抄的理由：閘只回傳值，這支要**改回原位**，需要偏移量）。
//    手抄本會漂，所以這一題直接兩邊對帳：同一份說明，兩把尺必須讀到同一個值。
//    漂開的後果很具體——閘讀 A 行、機器改 B 行，欄位永遠對不齊而且查不出為什麼。
test('同一把尺｜欄位定位與閘的 fieldValue 讀到同一個值', () => {
  const shapes = [
    `- **基準版本**：${OLD.slice(0, 7)}`,
    `* __基準版本__: ${OLD}`,
    `1. **基準版本**：\`${OLD.slice(0, 8)}\``,
    `2) 基準版本：${OLD.slice(0, 9)}`,
    `基準版本：**${OLD.slice(0, 10)}**`,
    `  - **基準版本** ：  ${OLD.slice(0, 11)}  `,
    `<!--\n- **基準版本**：例如 abc1234def\n-->\n- **基準版本**：${OLD.slice(0, 7)}`,
    '- **基準版本**：',
  ];
  for (const body of shapes) {
    const span = baseFieldSpan(body);
    const theirs = fieldValue(body, '基準版本');
    const mine = (span?.value ?? '').trim().replace(/^\*+|\*+$/g, '').trim();
    assert.equal(mine, theirs, `兩把尺讀到不同的值。說明：\n${body}\n閘讀到「${theirs}」、這支讀到「${mine}」`);
  }
});
