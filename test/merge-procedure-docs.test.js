// @ts-check
// 合併程序的文件一致性考題（2026-07-30；r2 依 Codex r1 重寫）。
//
// 病因：「堆疊 PR 不可用 `--delete-branch`」這條規則從 2026-07-10 就寫在 AGENTS.md，
// 但**真正被照著執行的檔案是 `REVIEW-AND-MERGE.md`**，而那裡寫的是無條件的「一律 --squash --delete-branch」。
// 規則在一個檔案、執行在另一個檔案 ⇒ 規則等於不存在。實害兩次，畫面上都是「Merged」＋CI 全綠：
//   ・2026-07-10 #3/#5 被 `--delete-branch` 連帶關閉（方向②：有人疊在我上面）
//   ・2026-07-28 #311/#312 各自合進自己的 base（方向①：我疊在別人上面）
//
// r1 教訓（Codex 實際示範）：只掃整段文字找關鍵字的考題，**用 HTML 註解就繞得過**（3/3 綠）。
// 所以 r2 的分工是：**行為由腳本考題鎖**（test/merge-gate.test.js 假 gh 五情境），
// 這裡只鎖「文件真的叫人跑那支腳本」——而且斷言收緊成三道：
//   ①指令必須出現在**剝掉 HTML 註解後的 fenced code**裡（註解與敘述都不算數）
//   ②堆疊閘必須出現在 `gh pr merge` **之前**（順序也是契約）
//   ③被指向的腳本檔必須真的存在
//
// 誠實劃界：仍是靜態考題——證明「文件指向一支存在的腳本、位置正確」，
// 證明不了「執行的人真的跑了它」。但「把閘從執行檔案裡簡化掉」擋得住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 抓出 REVIEW-AND-MERGE.md 裡「合併由 Codex 代執行」那個 blockquote 區塊。
 * 只認以 `>` 開頭的連續行——避免把後面的正文一起吃進來當成「有寫到」。
 * @param {string} md
 */
function mergeBlock(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith('>') && l.includes('合併') && l.includes('Codex 代執行'));
  assert.notEqual(start, -1, 'REVIEW-AND-MERGE.md 找不到「合併由 Codex 代執行」的區塊——合併程序被搬走或改寫了，這道考題要跟著更新');
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].startsWith('>')) end++;
  return lines.slice(start, end + 1).join('\n');
}

test('合併程序：審查與合併程序 的合併步驟必須「在 fenced code 裡」跑堆疊閘腳本，且在 merge 之前', () => {
  const raw = mergeBlock(read('REVIEW-AND-MERGE.md'));
  // 剝 blockquote 前綴 → 剝 HTML 註解（Codex r1 用註解讓上一版考題假綠——註解裡的字不算數）
  const unquoted = raw.split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n');
  const visible = unquoted.replace(/<!--[\s\S]*?-->/g, '');

  // ① 指令必須是 fenced code 裡「trim 後整行精確等於」的一行（r4，Codex r3 處方）——
  //    行首錨定不夠：`node scripts/check-pr-merge-gate.js <N> || true` 照樣匹配，
  //    而 `|| true` 會把閘的退出碼吞掉＝fail-closed 被拆。整行相等才算數。
  //    （HTML 註解已剝＝r1 繞法擋掉；`# node …` trim 後不等於指令＝r2 繞法擋掉；帶後綴＝r3 繞法擋掉）
  const GATE_CMD = 'node scripts/check-pr-merge-gate.js <N>';
  const fences = [...visible.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  assert.ok(
    fences.split('\n').some((l) => l.trim() === GATE_CMD),
    `合併步驟的 fenced code 裡必須有「整行精確等於」的 \`${GATE_CMD}\`——`
      + '敘述、註解（r1/r2 繞法）、帶 `|| true` 等後綴（r3 繞法：吞掉退出碼＝拆掉 fail-closed）都不算數'
  );

  // ② 順序：用「精確匹配的那一行」的行號去比，不用 indexOf 子字串——
  //    r3 繞法：註解掉原指令、把真指令搬到 merge 後面，indexOf 抓到前面敘述裡的字照樣過
  const vLines = visible.split('\n');
  const gateLine = vLines.findIndex((l) => l.trim() === GATE_CMD);
  const mergeLine = vLines.findIndex((l) => l.includes('gh pr merge'));
  assert.ok(mergeLine !== -1, '合併區塊裡找不到 gh pr merge——程序被改寫了，考題要跟著更新');
  assert.ok(gateLine !== -1 && gateLine < mergeLine, '堆疊閘那一行（精確匹配）必須在 gh pr merge 之前——放在後面＝合併完才檢查＝沒有意義');

  // ③ 被指向的腳本要真的存在（行為正確性由 test/merge-gate.test.js 的假 gh 考題鎖）
  read('scripts/check-pr-merge-gate.js');

  // ④ --delete-branch 可以留，但必須綁在閘的結果上，不可回到「一律」的無條件寫法
  if (visible.includes('--delete-branch')) {
    assert.ok(
      /退出碼 0|僅限/.test(visible),
      '`--delete-branch` 必須明寫適用條件（僅限堆疊閘退出碼 0 時），不可維持無條件寫法'
    );
  }
});

test('合併程序：AGENTS 的堆疊規則要指向堆疊閘腳本（跨檔指標不可死掉）', () => {
  const agents = read('AGENTS.md');
  const idx = agents.indexOf('堆疊 PR（base 指向另一個 PR 分支）合併時');
  assert.notEqual(idx, -1, 'AGENTS.md 找不到堆疊 PR 的 `--delete-branch` 規則');

  // 只看該規則往後一小段，避免掃到全檔其他地方剛好提過
  const near = agents.slice(idx, idx + 1200);
  assert.ok(
    near.includes('check-pr-merge-gate'),
    'AGENTS 的堆疊規則沒有指向堆疊閘腳本。'
      + '規則寫在這裡、執行的人卻讀另一份檔案——那正是這條規則失效十九天的原因'
  );
});

test('合併程序：AGENTS 三方協作框架那份「代合併步驟」也不可回到無條件（r1 漏掉的那份「唯一版本」）', () => {
  const agents = read('AGENTS.md');
  const idx = agents.indexOf('合併也由 Codex 代 William 執行');
  assert.notEqual(idx, -1, 'AGENTS.md 三方協作框架裡找不到代合併授權——被搬走的話，考題要跟著更新');
  const near = agents.slice(idx, idx + 600);
  assert.ok(
    near.includes('check-pr-merge-gate'),
    '三方協作框架的代合併步驟沒有堆疊閘——這份自稱「唯一版本」，r1 就是漏了它，'
      + '留著無條件 --delete-branch 等於在最權威的那份文件裡保留舊病'
  );
});

test('合併程序：PROJECT 若提到「勾 delete branch」，那句附近要帶堆疊例外（零命中時本題直接通過＝它不是「PROJECT 有講合併」的保證）', () => {
  // ⚠️ 誠實劃界：本題只擋「那句留著、卻沒有堆疊例外」；那句不存在時直接通過，它不守「PROJECT.md 有沒有講合併」。
  //    判定邏輯刻意與原版相同（只看第一處、±200／400 字的窗），本支只改題名與劃界句、不動判準（#575 r1：改成每處都驗＝改了通過條件，
  //    而且相鄰兩句仍會互借「堆疊」，並不比原版嚴）。
  const project = read('PROJECT.md');
  const idx = project.indexOf('delete branch');
  if (idx === -1) return;
  const near = project.slice(Math.max(0, idx - 200), idx + 400);
  assert.ok(
    near.includes('堆疊'),
    'PROJECT.md 的合併寫法提到「勾 delete branch」卻沒提堆疊例外——三份文件必須一致，不然又是一次規則漂移'
  );
});

test('合併步驟｜編號連續唯一＋具名引用指得到正確步驟（#466 r1 高③/r2#3：重編號做一半的守門）', () => {
  const doc = read('REVIEW-AND-MERGE.md');
  // 步驟清單＝合併段落裡的 `> N. `：必須從 1 開始、嚴格連續、無重號
  const steps = [...doc.matchAll(/^> (\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
  assert.ok(steps.length >= 8, `只找到 ${steps.length} 個步驟——合併步驟至少八步（2026-08-15 起）`);
  steps.forEach((s2, i) => assert.equal(s2.n, i + 1,
    `步驟編號斷裂：第 ${i + 1} 個項目標成「${s2.n}」（重號或缺號＝操作者照編號找會找錯道閘）`));
  // 具名引用：「步驟 N（某某閘）」的 N 必須等於標題含「某某閘」那一步的實際編號
  for (const m of doc.matchAll(/步驟 (\d+)（([^）]+)）/g)) {
    const [, num, name2] = m;
    const hit = steps.find((s2) => s2.title.includes(name2));
    assert.ok(hit, `引用「步驟 ${num}（${name2}）」但沒有任何步驟標題含「${name2}」`);
    assert.equal(Number(num), hit.n,
      `「步驟 ${num}（${name2}）」指錯了——「${name2}」實際是步驟 ${hit.n}（交叉引用漂了＝重演 #466 r1 高③）`);
  }
  // 易漂的裸數字引用至少要具名：delete-branch 條款必須點名堆疊閘
  assert.ok(/--delete-branch[^\n]*堆疊閘/.test(doc), 'delete-branch 的條件要具名指到堆疊閘、不可只寫裸數字');
});