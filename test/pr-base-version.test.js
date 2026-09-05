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

// 讓 io 考題走完 main 的完整路徑用的共用配件（url 過 repo 綁定、remoteUrl 給綁定比對、fetch 免打真 gh）。
const REPO_URL = 'https://github.com/o/r';
const prOf = (/** @type {number} */ n, /** @type {string} */ body) => ({ number: n, body, url: `${REPO_URL}/pull/${n}` });
const IO_REPO = { remoteUrl: `${REPO_URL}.git` };

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
  const body = bodyWith(OLD.slice(0, 7));
  const code = main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    ...IO_REPO, log: () => {},
    find: () => prOf(1, body),
    fetch: () => body,
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
  const body = bodyWith(OLD.slice(0, 7));
  main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    ...IO_REPO, log: () => {},
    find: () => prOf(7, body),
    fetch: () => sent[0] ?? body,   // 寫入前＝原文；寫入後＝我們送出的那份（模擬無並行）
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
    ...IO_REPO, log: (s) => logs.push(s),
    find: () => prOf(9, body),
    fetch: () => body,
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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
    const REMOTE_URL = 'https://github.com/o/r.git';
    // ⚠️ $1=remote 名、$2=remote URL——git 真的會這樣呼叫 pre-push。少了它們，repo 綁定整條斷線。
    const r = spawnSync('sh', [join(ROOT, 'scripts', 'git-hooks', 'pre-push'), 'origin', REMOTE_URL], {
      encoding: 'utf8', cwd: ROOT, input: `${refs}\n`,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '' },
    });
    assert.equal(r.status, 0, `pre-push 在全關卡皆過時退出碼是 ${r.status}：\n${r.stdout}${r.stderr}`);

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const hit = lines.find((l) => l.includes('sync-pr-base-version.js'));
    assert.ok(hit, `pre-push 根本沒叫基準版本對齊：\n${lines.join('\n')}`);
    assert.ok(hit.includes(refs),
      `對齊腳本沒收到 git 給的 ref（很可能是 stdin 被前面的關卡讀走了）。實得：\n${hit}`);
    // ★remote URL 也要真的傳到（Codex r2#3：把 hook 那個 "$2" 拿掉，原本的考題照樣全綠）
    assert.ok(hit.includes(REMOTE_URL),
      `★對齊腳本沒收到 remote URL（repo 綁定斷線＝推去 A repo 可能改到 B repo 的 PR）。實得：\n${hit}`);

    // ⚠️ 反向：前面的關卡**不可以**拿到那份 ref——拿得到就表示 stdin 沒被收乾淨，
    //    誰先讀誰贏，對齊腳本會時靈時不靈（跨機器的 flaky，最難查的那種）。
    for (const l of lines.filter((x) => !x.includes('sync-pr-base-version.js'))) {
      assert.ok(!l.includes(refs), `關卡「${l.split('::')[0].trim()}」也讀到了 ref＝stdin 沒收乾淨`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 審查輪次抓到的各族（競態／綁定／逾時／唯一性）───────────────
import { pickPr, repoSlug, runWithTimeout } from '../scripts/sync-pr-base-version.js';

test('★r1#1 競態縮窗：寫入前重讀，別條線剛補的內容不得被舊快照蓋掉', () => {
  // 兩線並行編輯有真實前例（#522）。Codex 曾合成重現：concurrentMarkerSurvives:false。
  const body = bodyWith(OLD.slice(0, 7));
  const MARKER = '\n\n### 別條線在查 PR 之後補上的 Grok 掃描紀錄（不可以消失）';
  const fresh = body + MARKER;
  /** @type {string[]} */ const sent = [];
  let fetches = 0;
  main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    ...IO_REPO, log: () => {},
    find: () => prOf(3, body),                       // 快照＝還沒有 MARKER 的舊版
    fetch: () => { fetches += 1; return fetches === 1 ? fresh : (sent[0] ?? fresh); },
    edit: (_n, b) => { sent.push(b); },
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes(MARKER), '★並行編輯被舊快照蓋掉了（改動必須落在重讀後的最新版上）');
  assert.deepEqual(staleBaseProblems(sent[0], NEW), [], '對齊本身也要成立');
});

test('★documenting：重讀之後對方先寫、我方後寫 ⇒ 對方內容被蓋且**看起來像成功**（偵測不到的那一半，照實記載）', () => {
  // ⚠️ 本題**不宣稱**這個行為是對的——它用**真的遠端狀態模型**重演那一半：
  //    對方的寫入真的落在「我方重讀之後、寫入之前」，然後被我方的整份寫回蓋掉。
  //    （第一版沒有模擬遠端、MARKER 從未被寫入＝斷言「本來就不存在的字不會出現」＝假證據，
  //    Codex #519 r3 抓到。）偵測不到的根因＝GitHub API 沒有 compare-and-swap；
  //    能歸零的那天，這題應改成正向斷言。
  const body = bodyWith(OLD.slice(0, 7));
  const MARKER = '\n\n### 對方在重讀之後、我方寫入之前補的內容';
  let remote = body;                       // ★遠端的真實狀態（fetch 讀它、edit 寫它）
  /** @type {string[]} */ const logs = [];
  let fetches = 0;
  main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    ...IO_REPO, log: (s) => logs.push(s),
    find: () => prOf(3, body),
    fetch: () => {
      fetches += 1;
      if (fetches === 1) {                 // 我方重讀拿到的是「對方還沒寫」的版本……
        const seen = remote;
        remote += MARKER;                  // ……對方隨即寫入（真的改了遠端）
        return seen;
      }
      return remote;                       // 事後驗證讀到的是遠端當下的狀態
    },
    edit: (_n, b) => { remote = b; },      // 我方整份寫回 ⇒ 蓋掉對方剛寫的
  });
  assert.ok(!remote.includes(MARKER), '★對方**真的寫進遠端**的內容，在我方寫回之後不見了＝被蓋掉');
  assert.deepEqual(staleBaseProblems(remote, NEW), [], '遠端欄位是我方對齊後的樣子');
  assert.ok(logs.join('\n').includes('✅'), '★而且看起來像成功——這正是劃界要照實記載的那一半');
});

test('★r1#1b 事後驗證：寫完發現欄位不是我們的樣子（並行編輯贏）⇒ 講一聲、絕不重試覆蓋', () => {
  const body = bodyWith(OLD.slice(0, 7));
  /** @type {string[]} */ const logs = [];
  let edits = 0;
  main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    ...IO_REPO, log: (s) => logs.push(s),
    find: () => prOf(3, body),
    // 寫入前重讀＝原文；寫入後讀回＝**對方的版本**（欄位仍是舊 SHA）
    fetch: () => body,
    edit: () => { edits += 1; },
  });
  assert.equal(edits, 1, '★重試覆蓋＝去打 #522 那種編輯戰——只准寫一次');
  assert.ok(logs.join('\n').includes('不重試'), '要講一聲，不能靜靜當作成功');
  assert.ok(!logs.join('\n').includes('✅'), '驗證不過就不可以宣稱已對齊');
});

test('★r1#3 repo 綁定：PR 不屬於這次 push 的 repo ⇒ 整批不動', () => {
  const body = bodyWith(OLD.slice(0, 7));
  /** @type {string[]} */ const logs = [];
  let edits = 0;
  main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    remoteUrl: 'git@github.com:other/elsewhere.git',   // push 去別的 repo
    log: (s) => logs.push(s),
    find: () => prOf(3, body),                          // 查到的 PR 在 o/r
    fetch: () => body,
    edit: () => { edits += 1; },
  });
  assert.equal(edits, 0, '★推去 A repo 卻改了 B repo 的 PR 說明');
  assert.ok(logs.join('\n').includes('不屬於'), '要講一聲');
  // 沒給 remoteUrl（手動呼叫）＝同向不動；⚠️ 不可讓 null === null 誤判成同 repo
  let edits2 = 0;
  main(`refs/heads/x ${NEW} refs/heads/x ${OLD}`, {
    log: () => {}, find: () => ({ number: 3, body, url: '' }), fetch: () => body, edit: () => { edits2 += 1; },
  });
  assert.equal(edits2, 0, '★兩邊都抽不出 slug 時不得誤判成「同 repo」');
});

test('★repoSlug：https／ssh／scp／.git／大小寫／帶 port 都收斂到同一個 owner/repo', () => {
  for (const u of ['https://github.com/O/R', 'https://github.com/o/r.git', 'git@github.com:o/r.git',
    'ssh://git@github.com/o/r', 'https://github.com/o/r/pull/9',
    'ssh://git@github.com:22/o/r.git']) {   // ★帶 port 的合法形（曾被誤抽成 22/o）
    assert.equal(repoSlug(u), 'o/r', u);
  }
  // ★主機必須**全等**，不是子字串（三個真實繞法：主機像、主機前綴、路徑裡藏 github.com）
  for (const u of ['https://evilgithub.com/o/r.git', 'git@evilgithub.com:o/r.git',
    'https://evil.example/github.com/o/r.git', 'ssh://git@github.com.evil.tld/o/r']) {
    assert.equal(repoSlug(u), null, `★繞法沒被擋：${u}`);
  }
  assert.equal(repoSlug('https://gitlab.com/o/r'), null, '非 GitHub 抽不出＝不動（fail-open 同向）');
  assert.equal(repoSlug(''), null);
});

test('★逾時是行為不是形狀：睡著的子行程在 50ms 就被 SIGKILL 收掉', () => {
  // 把 timeout 拿掉的突變：子行程睡滿 30 秒後正常結束、這裡等不到丟錯 ⇒ 轉紅（上限 30 秒，不會掛住）。
  // ⚠️ 2026-09-05 流程體檢：原本睡 1s、上界 900ms，機器忙時 spawn＋SIGKILL 的牆上時間也可能過 900ms＝假紅。
  //    設定＝睡 30s、上界 5s：壞路徑（沒逾時＝睡滿）一定 ≥ 30s，是上界的 6 倍——判別餘裕由這兩個設定值決定。
  //    好路徑要多久是觀測值（本機幾十 ms），記憶體吃緊時 spawn 可能拖到秒級，5s 是給它的空間、不是保證。
  const t0 = Date.now();
  let err = null;
  try { runWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], 50); }
  catch (e) { err = /** @type {any} */ (e); }
  assert.ok(err, '★沒有逾時保護——真掛住的 gh 會讓 push 無限等');
  assert.ok(err.code === 'ETIMEDOUT' || err.signal === 'SIGKILL', `要因逾時而死，實得 code=${err.code} signal=${err.signal}`);
  assert.ok(Date.now() - t0 < 5_000, '逾時要在設定值附近觸發，不是等子行程自己結束（子行程要睡 30s）');
});

test('★r1#3c 分支名取 remote-ref：push 本地名:遠端名 要查「遠端名」的 PR', () => {
  const got = parsePushRefs(`refs/heads/local-name ${NEW} refs/heads/pr-name ${OLD}`);
  assert.deepEqual(got, [{ branch: 'pr-name', sha: NEW }],
    '★PR 掛在遠端分支名上——拿本地名去查會改到別支同名分支的 PR');
});

test('★r1#4 pickPr：同名多支不猜、fork 的 PR 一律不動（「恰好一支」要有行為題）', () => {
  const mk = (/** @type {number} */ n, /** @type {object} */ extra = {}) =>
    ({ number: n, body: `b${n}`, url: `${REPO_URL}/pull/${n}`, headRefName: 'x', isCrossRepository: false, ...extra });
  // 恰好一支 ⇒ 取它
  assert.equal(pickPr([mk(1)], 'x')?.number, 1);
  // ★同名兩支（都非 fork）⇒ null——「非空取第一支」的退化在這裡轉紅
  assert.equal(pickPr([mk(1), mk(2)], 'x'), null, '★>1 支必須不猜');
  // ★只有 fork 的那支 ⇒ null（不是我們推的 head 的 PR，改它＝改到別人的說明）
  assert.equal(pickPr([mk(1, { isCrossRepository: true })], 'x'), null, '★fork 不動');
  // fork＋一支自家 ⇒ 取自家那支
  assert.equal(pickPr([mk(1, { isCrossRepository: true }), mk(2)], 'x')?.number, 2);
  // headRefName 對不上（gh --head 的寬鬆比對）⇒ 濾掉
  assert.equal(pickPr([mk(1, { headRefName: 'x-other' })], 'x'), null);
  // 形狀防呆
  assert.equal(pickPr('not-a-list', 'x'), null);
  assert.equal(pickPr([{ number: 1 }], 'x'), null, '缺 body/url＝不動');
});

test('★GH_TIMEOUT_MS 必須是正的有限值（=0 在 Node 語意＝沒有逾時）', async () => {
  const { GH_TIMEOUT_MS } = await import('../scripts/sync-pr-base-version.js');
  assert.ok(Number.isFinite(GH_TIMEOUT_MS) && GH_TIMEOUT_MS > 0, `實得 ${GH_TIMEOUT_MS}`);
  assert.ok(GH_TIMEOUT_MS <= 60_000, '單次上限超過一分鐘＝實質上就是掛住 push');
});

test('★CLI 端到端：真的跑腳本、gh 用 PATH 假身替換（生產接線的行為題）', () => {
  // ⚠️ 接線題的 stub 攔掉了**全部 node**，從不跑這支 JS——於是「entry 漏帶 argv[2]」與
  //    「findPr 繞過 pickPr」兩顆突變都全綠（Grok 掃④）。這裡讓真 CLI 跑起來，只假 gh。
  const dir = mkdtempSync(join(tmpdir(), 'basever-cli-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const ghLog = join(dir, 'gh.log'), editFile = join(dir, 'edit.body');
    const listOne = join(dir, 'list1.json'), listTwo = join(dir, 'list2.json'), viewF = join(dir, 'view.json');
    const body = bodyWith(OLD.slice(0, 7));
    const pr = { number: 5, body, url: `${REPO_URL}/pull/5`, headRefName: 'x', isCrossRepository: false };
    writeFileSync(listOne, JSON.stringify([pr]));
    writeFileSync(listTwo, JSON.stringify([pr, { ...pr, number: 6, url: `${REPO_URL}/pull/6` }]));
    writeFileSync(viewF, JSON.stringify({ body }));
    const gh = join(bin, 'gh');
    writeFileSync(gh, `#!/bin/sh
echo "ARGS::$*" >> ${JSON.stringify(ghLog)}
echo "GITDIR::\${GIT_DIR:-none}" >> ${JSON.stringify(ghLog)}
prev=""
for a in "$@"; do
  if [ "$prev" = "--body" ]; then printf '%s' "$a" > ${JSON.stringify(editFile)}; fi
  prev="$a"
done
case "$*" in
  *"pr list"*) cat "$FAKE_LIST" ;;
  *"pr view"*) cat ${JSON.stringify(viewF)} ;;
esac
exit 0
`);
    chmodSync(gh, 0o755);
    const refs = `refs/heads/x ${NEW} refs/heads/x ${OLD}\n`;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_LIST: listOne, GIT_DIR: '/tmp/絕對不該外洩的髒GIT_DIR' };   // ★鐵則 11：gitEnv 要把它清掉
    // ① 正常：一支同 repo PR ⇒ 真的 edit、內容過閘、退出碼 0
    let r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-pr-base-version.js'), `${REPO_URL}.git`],
      { encoding: 'utf8', cwd: ROOT, input: refs, env });
    assert.equal(r.status, 0, r.stderr);
    const edited = readFileSync(editFile, 'utf8');
    assert.deepEqual(staleBaseProblems(edited, NEW), [], '★真 CLI 送出的說明要過閘的尺');
    assert.ok(readFileSync(ghLog, 'utf8').includes('GITDIR::none'),
      '★髒 GIT_DIR 傳進 gh 了＝gitEnv() 沒接上（gh 會去讀另一棵樹的 PR）');
    // ② 不帶 remote URL（argv 漏接）⇒ 不動
    rmSync(editFile, { force: true }); rmSync(ghLog, { force: true });
    r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-pr-base-version.js')],
      { encoding: 'utf8', cwd: ROOT, input: refs, env });
    assert.equal(r.status, 0);
    assert.ok(!existsSync(editFile), '★沒有 remote URL＝綁定不成立＝一定不動（entry 漏帶 argv[2] 在這裡轉紅）');
    // ③ 同名兩支 PR ⇒ 不猜（真路徑必須經過 pickPr 的唯一性）
    r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-pr-base-version.js'), `${REPO_URL}.git`],
      { encoding: 'utf8', cwd: ROOT, input: refs, env: { ...env, FAKE_LIST: listTwo } });
    assert.equal(r.status, 0);
    assert.ok(!existsSync(editFile), '★同名兩支還去改＝findPr 沒走 pickPr 的唯一性');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★hook fail-open：對齊腳本以非零死掉，pre-push 仍放行並講一聲', () => {
  // 殺「把 || echo 改成 || exit 1（讓文書工具變成閘）」那顆突變（Grok 掃①：原本沒有行為題）。
  const dir = mkdtempSync(join(tmpdir(), 'prepush-failopen-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    for (const name of ['node', 'npm']) {
      const stub = join(bin, name);
      writeFileSync(stub, `#!/bin/sh
cat > /dev/null
case "$*" in *sync-pr-base-version.js*) exit 7 ;; esac
exit 0
`);
      chmodSync(stub, 0o755);
    }
    const r = spawnSync('sh', [join(ROOT, 'scripts', 'git-hooks', 'pre-push'), 'origin', 'https://github.com/o/r.git'], {
      encoding: 'utf8', cwd: ROOT, input: `refs/heads/x ${NEW} refs/heads/x ${OLD}\n`,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '' },
    });
    assert.equal(r.status, 0, `★文書工具死掉不可以擋 push（實得退出碼 ${r.status}）：\n${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes('沒跑成功'), '★失敗要講一聲，不能靜靜吞掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
