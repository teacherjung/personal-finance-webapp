// @ts-check
// 合成文字與父程序收據；不呼叫 CLI、不讀登入資料，也不替 OS 沙箱驗收背書。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { buildProjectionContext, createReviewProjection, projectReviewText, verifyReviewProjection,
  verifyTextProjection, reviewPublication } from '../scripts/grok-review-projection.js';
import { publicReply } from '../scripts/grok-review.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const BOX = '/private/tmp/grok-scan-synthetic-A1';
function fixture() {
  const expected = { project: 'example/repo', change: '108', round: 1, head: 'a'.repeat(40), base: 'b'.repeat(40), model: 'grok-4.7', effort: 'xhigh' };
  const identity = { project: expected.project, change: expected.change, round: expected.round, reviewer: 'Grok', source: 'Grok CLI' };
  const manifest = { purpose: 'review', ...identity, base: expected.base, head: expected.head, model: expected.model, effort: expected.effort };
  const manifestText = JSON.stringify(manifest);
  const selected = { ...expected, ...identity, manifestSha256: hash(manifestText), ...selection('🙂正式結論\r\n未貼\n', '中文前段\n') };
  const launch = { purpose: 'review', review: identity, repo: expected.project, head: expected.head, base: expected.base,
    model: expected.model, reasoningEffort: expected.effort, manifestSha256: selected.manifestSha256,
    sbArgv: ['-f', 'synthetic.sb', '-D', 'SCAN_DIR=' + BOX], env: { TMPDIR: BOX + '/tmp' } };
  const context = buildProjectionContext(selected, JSON.stringify(launch), manifestText, expected);
  return { expected, selected, launch, manifest, manifestText, context };
}
function selection(reply, prefix) {
  const stdout = prefix + reply + '\n';
  return { reply, stdout, replySha256: hash(reply), stdoutSha256: hash(stdout), selection: {
    schema: 'grok-final-selection/v1', cliVersion: '1.0.46', encoding: 'decoded-stdout-utf8',
    transcriptPath: encodeURIComponent(BOX + '/src') + '/00000000-0000-4000-8000-000000000001/chat_history.jsonl',
    transcriptSha256: 'f'.repeat(64), rowCount: 1, rowIndex: 0, byteStart: Buffer.byteLength(prefix),
    byteEnd: Buffer.byteLength(prefix + reply), stdoutBytes: Buffer.byteLength(stdout), replyBytes: Buffer.byteLength(reply) } };
}

test('可信 workspace 必須與父程序用途、版本、模型及 manifest 同源', () => {
  const good = fixture();
  assert.equal(good.context.box, BOX);
  assert.equal(good.context.browserJobs, realpathSync('/tmp') + '/gemini-browser-jobs-' + process.getuid());
  const cases = [
    f => { f.launch.head = 'c'.repeat(40); },
    f => { f.launch.base = 'c'.repeat(40); },
    f => { f.launch.review.change = '109'; },
    f => { f.launch.review.round = 2; },
    f => { f.launch.repo = 'example/other'; },
    f => { f.launch.model = 'grok-4.6'; },
    f => { f.launch.reasoningEffort = 'high'; },
    f => { f.launch.purpose = 'scan'; },
    f => { f.launch.manifestSha256 = '0'.repeat(64); },
    f => { f.manifestText += ' '; },
    f => { f.selected.head = 'c'.repeat(40); },
    f => { f.selected.reviewer = 'Other'; },
    f => { f.launch.sbArgv.push('-D', 'SCAN_DIR=' + BOX); },
    f => { f.launch.sbArgv[2] = '-X'; },
    f => { f.launch.sbArgv[3] = 'SCAN_DIR=/private/tmp/unrelated'; },
    f => { f.launch.env.TMPDIR += '-other'; },
    f => { f.selected.selection.transcriptPath = f.selected.selection.transcriptPath.replace('%2Fsrc/', '%2Fbase/'); },
    f => { f.selected.selection.transcriptPath = f.selected.selection.transcriptPath.replace('synthetic', 'unrelated'); },
    f => { f.selected.selection.transcriptPath = f.selected.selection.transcriptPath.replace('synthetic', '%73ynthetic'); },
    f => { f.selected.selection.transcriptPath = f.selected.selection.transcriptPath.replace('%2Fsrc/', '%2F..%2Fsrc/'); },
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    assert.throws(() => buildProjectionContext(f.selected, JSON.stringify(f.launch), f.manifestText, f.expected), /GROK_PROJECTION_/);
  }
  for (const bad of ['null', '{"private":"/Users/person/secret"']) assert.throws(() =>
    buildProjectionContext(good.selected, bad, good.manifestText, good.expected), error =>
      error.message.includes('CONTEXT_JSON') && !error.message.includes('/Users/'));
});

test('只換核定根，保留指令、檔名、行號、診斷、換行及 Unicode bytes', () => {
  const { context } = fixture();
  const input = '🙂開始\r\ncd ' + BOX + '/mutation && node test/a.js\n'
    + '`' + BOX + '/src/scripts/file.js:37` 錯誤：未找到\n'
    + 'base=' + BOX + '/base/test/case.test.js\n'
    + "mkdtemp('/tmp/browser-capacity-test-XXXXXX')\n"
    + '根 `' + BOX + '`；tmp `' + BOX + '/tmp/a.log`\n'
    + '工作 `' + context.browserJobs + '/<runId>`\n';
  const expected = '🙂開始\r\ncd [REVIEW_MUTATION] && node test/a.js\n'
    + '`[REVIEW_SRC]/scripts/file.js:37` 錯誤：未找到\n'
    + 'base=[REVIEW_BASE]/test/case.test.js\n'
    + "mkdtemp('[SYSTEM_TMP]/browser-capacity-test-XXXXXX')\n"
    + '根 `[REVIEW_BOX]`；tmp `[REVIEW_TMP]/a.log`\n'
    + '工作 `[BROWSER_JOBS]/<runId>`\n';
  const proof = projectReviewText(input, context);
  assert.equal(proof.text, expected);
  assert.equal(proof.edits[0].originalStart, Buffer.byteLength('🙂開始\r\ncd '));
  verifyTextProjection(input, expected, proof);
  assert.equal(publicReply(expected), expected);
  for (const tmp of new Set(['/tmp', context.canonicalTmp])) for (const name of ['browser-capacity-test-', 'browser-capacity-test-XXXXXX']) {
    assert.equal(projectReviewText('`' + tmp + '/' + name + '`', context).text, '`[SYSTEM_TMP]/' + name + '`');
  }
});

test('未知根、相近前綴、模糊尾段、URL、編碼及真實工作代號都不投影', () => {
  const { context } = fixture();
  const paths = [BOX + '-other', BOX + '/auth', BOX + '/grok-home', BOX + '/results', BOX + '/src-other',
    ...['/..', '/.', '//a', '/a/../b', '/a\\b', '/%61', '/a?x=1', '/a#fragment'].map(tail => BOX + '/src' + tail),
    'x' + BOX + '/src', 'file://' + BOX + '/src', 'https://example.test' + BOX + '/src',
    context.browserJobs + '/0123456789abcdef', context.browserJobs + '0', '/tmp/browser-capacity-test-real',
    '/tmp/browser-capacity-test-XXXXXX/file', '/tmp/browser-capacity-test-XXXXXX.bak',
    BOX.replaceAll('/', '%2F') + '%2Fsrc', BOX.replaceAll('/', '\\x2f') + '\\x2fsrc',
    '/Users/synthetic/private.txt', '/home/synthetic/private.txt'];
  for (const path of paths) {
    const text = '`' + path + '`', projected = projectReviewText(text, context);
    assert.equal(projected.text, text, path);
    assert.deepEqual(projected.edits, [], path);
    assert.throws(() => publicReply(projected.text), /本機絕對路徑/, path);
  }
});

test('UTF-8 區段證明拒收重疊、越界、字元中段與區段外改字', () => {
  const { context } = fixture(), raw = '🙂前 ' + BOX + '/src/file.js 結尾';
  const proof = projectReviewText(raw, context);
  verifyTextProjection(raw, proof.text, proof);
  for (const change of [
    p => { p.edits[0].originalStart = 1; },
    p => { p.edits[0].originalEnd = Buffer.byteLength(raw) + 1; },
    p => { p.edits.push({ ...p.edits[0] }); },
    p => { p.edits[0].projectedStart++; },
    p => { p.edits[0].replacement = '[OTHER]'; },
    p => { p.text = p.text.replace('結尾', '改字'); p.projected.sha256 = hash(p.text); },
  ]) {
    const broken = structuredClone(proof); change(broken);
    assert.throws(() => verifyTextProjection(raw, broken.text, broken), /GROK_PROJECTION_/);
  }
});

test('完整 stdout 前段與 final 分列並保留原 selection，重算不採信偽造證明', () => {
  const { context, selected } = fixture();
  const prefix = '前段🙂 `' + BOX + '/tmp/log`\r\n';
  Object.assign(selected, selection('結論 `' + BOX + '/src/a.js`\n未貼\n', prefix));
  const originalSelection = structuredClone(selected.selection);
  const result = createReviewProjection(selected, context);
  assert.equal(result.stdout.text, '前段🙂 `[REVIEW_TMP]/log`\r\n結論 `[REVIEW_SRC]/a.js`\n未貼\n\n');
  assert.equal(result.final.text, '結論 `[REVIEW_SRC]/a.js`\n未貼\n');
  assert.equal(result.correspondence.projectedStart, Buffer.byteLength('前段🙂 `[REVIEW_TMP]/log`\r\n'));
  assert.deepEqual(selected.selection, originalSelection);
  verifyReviewProjection(selected, context, result);
  for (const change of [
    p => { p.context.box = '/private/tmp/other'; },
    p => { p.contextSha256 = '0'.repeat(64); },
    p => { p.stdout.text = p.final.text; p.stdout.projected = { bytes: Buffer.byteLength(p.stdout.text), sha256: hash(p.stdout.text) }; },
    p => { p.correspondence.projectedStart++; },
    p => { p.final.edits[0].rule = 'OTHER'; },
    p => { p.final.text = p.final.text.replace('結論', '改字'); p.final.projected.sha256 = hash(p.final.text); },
  ]) {
    const broken = structuredClone(result); change(broken);
    assert.throws(() => verifyReviewProjection(selected, context, broken), /GROK_PROJECTION_/);
  }
  const body = reviewPublication(result);
  assert.ok(body.startsWith(result.final.text + '\n\n---\n### 發審者附記（非 Grok 原文）\n'));
  assert.ok(body.includes('本則為有版本的路徑去敏投影，非逐字原文；僅核准路徑區段被替換。完整原件及轉換證明私存。'));
  assert.ok(body.includes(selected.replySha256));
  assert.equal(body.includes(BOX), false);
});

test('投影不得跨 final 起點，也不得把無左界的 stdout 誤作同一份 final', () => {
  const { selected, context } = fixture();
  for (const [reply, prefix, code] of [
    ['src/file.js\n', BOX + '/', /FINAL_BOUNDARY/],
    [BOX + '/src/file.js\n', 'x', /FINAL_CORRESPONDENCE/],
  ]) {
    Object.assign(selected, selection(reply, prefix));
    assert.throws(() => createReviewProjection(selected, context), code);
  }
});
