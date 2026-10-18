// @ts-check
// 投影只處理已核路徑；完整原件的憑證、DLP 與正式結構由收件入口先驗。
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyFinalSelection } from './grok-final-reply.js';

export const PROJECTION_POLICY = 'grok-review-path-projection/v1';
export const RECEIPT_SCHEMA = 'grok-review-receipt/v2';
const hash = value => createHash('sha256').update(value).digest('hex');
/** @returns {never} */
const fail = code => { throw Error(`GROK_PROJECTION_${code}；請核對 docs/grok-review-projection-plan.md，重新備妥新場證據後再發審。`); };
const check = (ok, code) => { if (!ok) fail(code); };
const canonical = path => typeof path === 'string' && path.startsWith('/') && posix.normalize(path) === path && !path.endsWith('/') && !/[\\%\s]/u.test(path);
const bytes = text => Buffer.from(text, 'utf8');
const validText = value => typeof value === 'string' && bytes(value).toString('utf8') === value;
const summary = value => ({ bytes: Buffer.byteLength(value), sha256: hash(value) });
function json(text) {
  try { return JSON.parse(text); } catch { fail('CONTEXT_JSON'); }
}

/** 不讀被清理的盒子；workspace 必須與可信父程序保存的 launch 同源。 */
export function buildProjectionContext(selected, launchText, manifestText, expected) {
  verifyFinalSelection(selected);
  check(validText(launchText) && validText(manifestText), 'CONTEXT_TEXT');
  const launch = json(launchText), manifest = json(manifestText);
  check(launch && manifest, 'CONTEXT_JSON');
  check(hash(manifestText) === selected.manifestSha256 && launch.manifestSha256 === selected.manifestSha256, 'MANIFEST');
  check(launch.purpose === 'review' && manifest.purpose === 'review', 'PURPOSE');
  for (const key of ['base', 'head', 'model']) check(launch[key] === expected[key] && manifest[key] === expected[key]
    && selected[key] === expected[key], 'IDENTITY');
  check(launch.reasoningEffort === expected.effort && manifest.effort === expected.effort
    && selected.effort === expected.effort && launch.repo === expected.project, 'IDENTITY');
  for (const key of ['project', 'change', 'round']) check(launch.review?.[key] === expected[key]
    && manifest[key] === expected[key] && selected[key] === expected[key], 'IDENTITY');
  for (const record of [launch.review, manifest, selected]) check(record.reviewer === 'Grok' && record.source === 'Grok CLI', 'IDENTITY');
  const encoded = selected.selection.transcriptPath.split('/')[0];
  let workspace;
  try { workspace = decodeURIComponent(encoded); } catch { fail('WORKSPACE'); }
  check(encodeURIComponent(workspace) === encoded && canonical(workspace) && posix.basename(workspace) === 'src', 'WORKSPACE');
  check(Array.isArray(launch.sbArgv) && launch.sbArgv.every(value => typeof value === 'string'), 'SCAN_DIR');
  const indexes = launch.sbArgv.flatMap((value, index) => value.startsWith('SCAN_DIR=') ? [index] : []);
  check(indexes.length === 1 && launch.sbArgv[indexes[0] - 1] === '-D', 'SCAN_DIR');
  const box = launch.sbArgv[indexes[0]].slice('SCAN_DIR='.length);
  check(canonical(box) && workspace === box + '/src', 'SCAN_DIR');
  check(launch.env?.TMPDIR === box + '/tmp', 'TMPDIR');
  const uid = process.getuid?.(), canonicalTmp = realpathSync('/tmp');
  check(Number.isSafeInteger(uid) && canonical(canonicalTmp), 'HOST');
  return { schema: PROJECTION_POLICY, ...expected, box, workspace, tmp: box + '/tmp', canonicalTmp, uid,
    browserJobs: canonicalTmp + '/gemini-browser-jobs-' + uid,
    launchSha256: hash(launchText), manifestSha256: hash(manifestText) };
}

const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const leftBoundary = char => char === undefined || /[\s`'"([{=，。；：（【]/u.test(char);
const rightBoundary = char => char === undefined || /[\s`'"(),;:[\]{}，。；：）】]/u.test(char);
const validTail = tail => tail === '' || (tail.startsWith('/') && tail.slice(1).split('/').every(part =>
  part !== '.' && part !== '..' && /^[A-Za-z0-9_.@+-]+$/u.test(part)));

function rules(context) {
  const list = [
    ...[['src', 'REVIEW_SRC'], ['base', 'REVIEW_BASE'], ['mutation', 'REVIEW_MUTATION'], ['tmp', 'REVIEW_TMP']]
      .map(([part, id]) => ({ root: context.box + '/' + part, id, replacement: '[' + id + ']', tail: 'relative' })),
    { root: context.box, id: 'REVIEW_BOX', replacement: '[REVIEW_BOX]', tail: 'none' },
    { root: context.browserJobs, id: 'BROWSER_JOBS', replacement: '[BROWSER_JOBS]', tail: 'example' },
  ];
  for (const tmp of new Set(['/tmp', context.canonicalTmp])) for (const name of ['browser-capacity-test-', 'browser-capacity-test-XXXXXX'])
    list.push({ root: tmp + '/' + name, id: 'CAPACITY_TEST_TMP', replacement: '[SYSTEM_TMP]/' + name, tail: 'none' });
  return list.sort((a, b) => b.root.length - a.root.length);
}

/** 索引以 UTF-8 bytes 記；只替換根，不吞掉指令或後面的診斷。 */
export function projectReviewText(text, context) {
  check(validText(text), 'UTF8');
  const policy = rules(context), matcher = new RegExp(policy.map(rule => escapeRe(rule.root)).join('|'), 'gu');
  const edits = [];
  let projected = '', at = 0;
  for (const match of text.matchAll(matcher)) {
    const start = match.index;
    if (start < at || !leftBoundary(text[start - 1])) continue;
    let end = start;
    while (end < text.length && !rightBoundary(text[end])) end++;
    const token = text.slice(start, end);
    const rule = policy.find(item => token.startsWith(item.root) && (item.tail === 'relative'
      ? validTail(token.slice(item.root.length)) : item.tail === 'example'
        ? ['', '/<runId>'].includes(token.slice(item.root.length)) : token === item.root));
    if (!rule) continue;
    const originalEnd = start + rule.root.length;
    projected += text.slice(at, start);
    const projectedStart = Buffer.byteLength(projected);
    projected += rule.replacement;
    edits.push({ originalStart: Buffer.byteLength(text.slice(0, start)), originalEnd: Buffer.byteLength(text.slice(0, originalEnd)),
      projectedStart, projectedEnd: Buffer.byteLength(projected), rule: rule.id, replacement: rule.replacement });
    at = originalEnd;
  }
  projected += text.slice(at);
  return { text: projected, original: summary(text), projected: summary(projected), edits };
}

/** 逐段重播，而非只比兩個可一起偽造的摘要。 */
export function verifyTextProjection(original, projected, proof) {
  check(validText(original) && validText(projected) && proof && Array.isArray(proof.edits), 'PROOF');
  check(proof.text === projected, 'PROOF_TEXT');
  check(isDeepStrictEqual(proof.original, summary(original)) && isDeepStrictEqual(proof.projected, summary(projected)), 'DIGEST');
  const raw = bytes(original), output = bytes(projected);
  let rawAt = 0, outputAt = 0;
  const boundary = (buffer, index) => Number.isSafeInteger(index) && index >= 0 && index <= buffer.length
    && (index === buffer.length || (buffer[index] & 0xc0) !== 0x80);
  for (const edit of proof.edits) {
    check(edit && typeof edit === 'object' && validText(edit.replacement), 'RANGE');
    check(boundary(raw, edit.originalStart) && boundary(raw, edit.originalEnd)
      && boundary(output, edit.projectedStart) && boundary(output, edit.projectedEnd)
      && edit.originalStart >= rawAt && edit.originalEnd > edit.originalStart
      && edit.projectedStart >= outputAt && edit.projectedEnd > edit.projectedStart, 'RANGE');
    check(raw.subarray(rawAt, edit.originalStart).equals(output.subarray(outputAt, edit.projectedStart)), 'UNCHANGED');
    check(output.subarray(edit.projectedStart, edit.projectedEnd).equals(bytes(edit.replacement)), 'REPLACEMENT');
    rawAt = edit.originalEnd; outputAt = edit.projectedEnd;
  }
  check(raw.subarray(rawAt).equals(output.subarray(outputAt)), 'UNCHANGED');
}

export function createReviewProjection(selected, context) {
  verifyFinalSelection(selected);
  const stdout = projectReviewText(selected.stdout, context), final = projectReviewText(selected.reply, context);
  const before = selected.selection.byteStart, end = selected.selection.byteEnd;
  let delta = 0;
  for (const edit of stdout.edits) {
    check(!(edit.originalStart < before && edit.originalEnd > before)
      && !(edit.originalStart < end && edit.originalEnd > end), 'FINAL_BOUNDARY');
    if (edit.originalEnd <= before) delta += (edit.projectedEnd - edit.projectedStart) - (edit.originalEnd - edit.originalStart);
  }
  const projectedStart = before + delta, projectedEnd = projectedStart + Buffer.byteLength(final.text);
  check(bytes(stdout.text).subarray(projectedStart, projectedEnd).equals(bytes(final.text)), 'FINAL_CORRESPONDENCE');
  const result = { policy: PROJECTION_POLICY, context, contextSha256: hash(JSON.stringify(context)),
    stdout, final, correspondence: { originalStart: before, originalEnd: end, projectedStart, projectedEnd } };
  verifyTextProjection(selected.stdout, stdout.text, stdout);
  verifyTextProjection(selected.reply, final.text, final);
  return result;
}

export function verifyReviewProjection(selected, context, projection) {
  check(projection?.policy === PROJECTION_POLICY && isDeepStrictEqual(projection.context, context), 'CONTEXT');
  verifyTextProjection(selected.stdout, projection.stdout?.text, projection.stdout);
  verifyTextProjection(selected.reply, projection.final?.text, projection.final);
  check(isDeepStrictEqual(projection, createReviewProjection(selected, context)), 'RECOMPUTE');
  return projection;
}

export function reviewPublication(projection) {
  check(projection?.policy === PROJECTION_POLICY, 'POLICY');
  const annotation = '\n\n---\n### 發審者附記（非 Grok 原文）\n'
    + '本則為有版本的路徑去敏投影，非逐字原文；僅核准路徑區段被替換。完整原件及轉換證明私存。\n'
    + `政策：${PROJECTION_POLICY}\n`
    + `原始 stdout SHA-256：${projection.stdout.original.sha256}\n`
    + `公開 stdout SHA-256：${projection.stdout.projected.sha256}\n`
    + `原始 final SHA-256：${projection.final.original.sha256}\n`
    + `公開 final SHA-256：${projection.final.projected.sha256}\n`
    + `替換區段：stdout ${projection.stdout.edits.length}；final ${projection.final.edits.length}。\n`;
  return projection.final.text + annotation;
}
