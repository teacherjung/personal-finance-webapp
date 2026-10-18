// @ts-check
// 只在官方 CUA REPL 載入；瀏覽器權限由可信固定配方持有，模型文字只落進資料檔。
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { URL as NodeURL } from 'node:url';
import { isMainModule } from '../lib/is-main.js';
import { SOURCE_ROOT, SOURCE_FILES, jobDirectory, readMail, readBoundedFile, writeOnce, mailExists, sourceDigest, browserError } from './gemini-browser-files.js';
import { URL, ORIGIN, SELECTED, DETAILS, ATTACHMENT_CAP, CONTROL_CAP, OBSERVATION, REPLY_CAP, RENDERED_CAP, sha256, responseSnapshotSha256, fields, validateDescriptor, leaseMessage } from './gemini-browser-protocol.js';

const sessions = new Map();
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const nonce = n => randomBytes(n).toString('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const button = (tab, name) => tab.playwright.getByRole('button', { name, exact: true });
const main = tab => tab.playwright.getByRole('main');
const input = tab => tab.playwright.getByRole('textbox', { name: 'Enter a prompt for Gemini', exact: true });
const responses = tab => main(tab).locator('model-response-content');
const selected = tab => main(tab).getByRole('button', { name: /^Open mode picker, currently / }).getAttribute('aria-label');

function alive(s) {
  if (Date.now() >= s.d.expiresAt || performance.now() - s.started > s.remaining
    || mailExists(s.dir, 'aborted.json') || mailExists(s.dir, 'cancel.json')) browserError('ABORTED');
  if (sourceDigest(SOURCE_ROOT, SOURCE_FILES).sha256 !== s.d.sourceSha256
    || !equal(readMail(s.dir, 'descriptor.json'), s.d)) browserError('SOURCE_CHANGED');
  const control = readBoundedFile(join(s.dir, 'control.txt'), CONTROL_CAP);
  const attachment = readBoundedFile(s.attachmentPath, ATTACHMENT_CAP);
  const st = lstatSync(s.attachmentPath, { bigint: true });
  if ([st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs, st.mode, st.nlink].join(':') !== s.d.attachmentIdentity) browserError('SOURCE_CHANGED');
  if (control.length !== s.d.manifest.control.bytes || sha256(control) !== s.d.manifest.control.sha256
    || attachment.length !== s.d.manifest.attachment.bytes || sha256(attachment) !== s.d.manifest.attachment.sha256) browserError('SOURCE_CHANGED');
}
async function step(s, action, phase) { if (phase) s.phase = phase; alive(s); const result = await action(); alive(s); return result; }
async function waitMail(s, name, expected) {
  const end = performance.now() + 5000;
  while (!mailExists(s.dir, name)) {
    alive(s); if (performance.now() >= end) browserError('NO_LIVE_RUNNER'); await pause();
  }
  alive(s);
  if (!equal(readMail(s.dir, name), expected)) browserError('ACK');
}
async function until(s, predicate, phase) {
  if (phase) s.phase = phase;
  const end = performance.now() + 10000;
  while (!(await step(s, predicate))) { if (performance.now() >= end) browserError('UI_STATE'); await pause(); }
}
async function origin(s) {
  const url = await step(s, () => s.tab.url());
  if (!url || new NodeURL(url).origin !== ORIGIN) browserError('ORIGIN');
}
async function temporaryBefore(s) {
  return await main(s.tab).getByText('Just stopping by?', { exact: true }).isVisible()
    && await main(s.tab).getByText('Temporary chats', { exact: true }).isVisible();
}
async function cleanup(s, failed) {
  // close 不等於 Google 遠端取消；只在已發出的呼叫都返回後公布本地靜止。
  s.state = 'CLOSING';
  if (s.tab) await s.tab.close();
  writeOnce(s.dir, 'quiescent.json', { instance: s.instance, tabClosed: !!s.tab, failed });
  s.state = 'CLOSED';
}
async function attachmentState(s) {
  const composer = main(s.tab).locator('input-area-v2');
  if (await step(s, () => composer.count()) !== 1) browserError('ATTACHMENT_UI');
  const result = await step(s, () => composer.evaluate(element => {
    const previews = Array.from(element.querySelectorAll('uploader-file-preview'));
    const selectedFiles = Array.from(element.querySelectorAll('input[type=file]')).reduce((n, input) => n + input.files.length, 0);
    if (previews.length !== 1) return { count: previews.length, selectedFiles, name: null, ready: false };
    const preview = previews[0], containers = preview.querySelectorAll('.file-preview-container');
    const content = preview.querySelectorAll('.gem-attachment-content'), extension = preview.querySelectorAll('.gem-attachment-extension-label');
    if (containers.length !== 1) return { count: 1, selectedFiles, name: null, ready: false };
    const ids = (containers[0].getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    const name = ids.length === 1 ? element.ownerDocument.getElementById(ids[0])?.textContent : null;
    const boundedName = typeof name === 'string' && name.length <= 200 ? name : null;
    return { count: 1, selectedFiles, name: boundedName,
      ready: preview.getClientRects().length > 0 && content.length === 1 && !content[0].classList.contains('loading')
        && extension.length === 1 && extension[0].textContent === 'TXT' && preview.querySelectorAll('[role="progressbar"]').length === 0 };
  }));
  fields(result, ['count', 'selectedFiles', 'name', 'ready']);
  if (!Number.isSafeInteger(result.count) || result.count < 0 || !Number.isSafeInteger(result.selectedFiles) || result.selectedFiles < 0
    || typeof result.ready !== 'boolean' || (result.name !== null && typeof result.name !== 'string')) browserError('ATTACHMENT_UI');
  if (result.selectedFiles > 1) browserError('ATTACHMENT_UI');
  return result;
}
async function attachmentReady(s) {
  const observed = await attachmentState(s);
  return observed.count === 1 && observed.ready === true && observed.name === s.d.manifest.attachment.name;
}

function unreadSummary(s) {
  return { sampled: false, expectedCodeUnits: s.prompt.length, actualCodeUnits: null, match: false };
}
async function readback(s, key) {
  if (typeof s.prompt !== 'string') browserError('READBACK_RESULT');
  // 在 DOM 內逐字比較，避免工具回傳長字串時的截短改變完整性判斷。
  const result = await input(s.tab).evaluate((element, expected) => {
    if (typeof expected !== 'string') throw Error('GEMINI_BROWSER_READBACK_RESULT');
    const actual = element.textContent, sampled = typeof actual === 'string';
    return { sampled, expectedCodeUnits: expected.length, actualCodeUnits: sampled ? actual.length : null,
      match: sampled && actual === expected };
  }, s.prompt);
  fields(result, ['sampled', 'expectedCodeUnits', 'actualCodeUnits', 'match']);
  if (typeof result.sampled !== 'boolean' || typeof result.match !== 'boolean'
    || !Number.isSafeInteger(result.expectedCodeUnits) || result.expectedCodeUnits < 0 || result.expectedCodeUnits !== s.prompt.length
    || (!result.sampled && (result.actualCodeUnits !== null || result.match))
    || (result.sampled && (!Number.isSafeInteger(result.actualCodeUnits) || result.actualCodeUnits < 0))
    || (result.match && result.actualCodeUnits !== result.expectedCodeUnits)) browserError('READBACK_RESULT');
  s.readbacks[key] = result;
  return result.match;
}
export function visibleJsonCodeResponse(element, limits) {
  const fail = () => { throw Error('GEMINI_BROWSER_RESPONSE_DOM'); };
  const known = new Set();
  const blank = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && child.textContent.trim()) fail();
      if (![1, 3, 8].includes(child.nodeType)) fail();
    }
  };
  const mark = (node, tag, classes = []) => {
    if (!node || node.tagName !== tag || classes.some(name => !node.classList.contains(name))) fail();
    known.add(node); return node;
  };
  const children = (node, specs) => {
    blank(node);
    if (node.children.length !== specs.length) fail();
    return specs.map(([tag, classes], i) => mark(node.children[i], tag, classes));
  };
  const one = (node, tag, classes = []) => children(node, [[tag, classes]])[0];
  mark(element, 'MODEL-RESPONSE-CONTENT');
  for (const tag of ['code-block', 'pre', 'code']) if (element.querySelectorAll(tag).length !== 1) fail();
  let wrapper = one(element, 'STRUCTURED-CONTENT-CONTAINER', ['model-response-text']);
  wrapper = one(wrapper, 'DIV', ['container']);
  wrapper = one(wrapper, 'MESSAGE-CONTENT');
  wrapper = one(wrapper, 'DIV', ['markdown', 'markdown-main-panel', 'md-content']);
  wrapper = one(wrapper, 'RESPONSE-ELEMENT', ['no-md', 'md-has-block-component']);
  wrapper = one(wrapper, 'CODE-BLOCK');
  wrapper = one(wrapper, 'DIV', ['code-block']);
  wrapper = one(wrapper, 'DIV', ['formatted-code-block-internal-container']);
  wrapper = one(wrapper, 'DIV', ['animated-opacity']);
  const [header, pre] = children(wrapper, [['DIV', ['code-block-decoration', 'header-formatted']], ['PRE', []]]);
  const [label, buttons] = children(header, [['SPAN', []], ['DIV', ['buttons']]]);
  if (label.children.length || label.textContent !== 'JSON' || !label.getClientRects().length) fail();
  const controls = children(buttons, [['GEM-ICON-BUTTON', ['download-button']], ['GEM-ICON-BUTTON', ['copy-button']]]);
  for (let i = 0; i < controls.length; i++) {
    const button = one(controls[i], 'BUTTON');
    if (button.getAttribute('aria-label') !== ['Download code', 'Copy code'][i]) fail();
    const [ripple, icon, focus, touch] = children(button, [['SPAN', ['mat-mdc-button-persistent-ripple']],
      ['GEM-ICON', []], ['SPAN', ['mat-focus-indicator']], ['SPAN', ['mat-mdc-button-touch-target']]]);
    for (const leaf of [ripple, focus, touch]) children(leaf, []);
    const glyph = one(icon, 'MAT-ICON');
    if (glyph.getAttribute('role') !== 'img') fail();
    children(glyph, []);
  }
  const code = one(pre, 'CODE', ['code-container', 'formatted']);
  if (code.getAttribute('role') !== 'text' || !code.getClientRects().length || !element.getClientRects().length) fail();
  for (const child of code.children) {
    mark(child, 'SPAN');
    if (child.children.length || !child.getClientRects().length
      || !['hljs-attr', 'hljs-string', 'hljs-number'].some(name => child.classList.contains(name))) fail();
    for (const nested of child.childNodes) if (![3, 8].includes(nested.nodeType)) fail();
  }
  for (const child of code.childNodes) if (![1, 3, 8].includes(child.nodeType)) fail();
  if (known.size !== element.querySelectorAll('*').length + 1) fail();
  const codeText = code.textContent, renderedText = element.innerText;
  if (typeof codeText !== 'string' || typeof renderedText !== 'string'
    || codeText.length > limits.reply || renderedText.length > limits.rendered) fail();
  return { schema: 'visible-json-code/v1', codeText, renderedText,
    structure: { elements: known.size, highlightSpans: code.children.length, codeBlocks: 1, pre: 1, code: 1,
      codeNodes: Array.from(code.childNodes).filter(child => child.nodeType !== 8).map(child => child.nodeType === 3
        ? [3, child.textContent.length] : [1, child.textContent.length, ['hljs-attr', 'hljs-string', 'hljs-number'].filter(name => child.classList.contains(name)).join(' ')]) } };
}
async function visibleResponseParts(s, highlightSpans) {
  const container = responses(s.tab);
  const targets = [container, container.locator('.code-block-decoration.header-formatted > span'),
    container.locator('code.code-container.formatted[role="text"]')];
  for (const target of targets) if (await step(s, () => target.count()) !== 1 || !await step(s, () => target.isVisible())) browserError('RESPONSE_VISIBILITY');
  const spans = container.locator('code > span');
  if (await step(s, () => spans.count()) !== highlightSpans) browserError('RESPONSE_VISIBILITY');
  for (let i = 0; i < highlightSpans; i++) if (!await step(s, () => spans.nth(i).isVisible())) browserError('RESPONSE_VISIBILITY');
}
async function readVisibleResponse(s) {
  const sample = async () => {
    const value = await step(s, () => responses(s.tab).evaluate(visibleJsonCodeResponse,
      { reply: REPLY_CAP, rendered: RENDERED_CAP }), 'response-code');
    fields(value, ['schema', 'codeText', 'renderedText', 'structure']);
    if (value.schema !== 'visible-json-code/v1' || typeof value.codeText !== 'string' || typeof value.renderedText !== 'string'
      || !/** @type {string & {isWellFormed(): boolean}} */ (value.codeText).isWellFormed() || !/** @type {string & {isWellFormed(): boolean}} */ (value.renderedText).isWellFormed()) browserError('REPLY_ENCODING');
    const raw = Buffer.from(value.codeText), rendered = Buffer.from(value.renderedText);
    if (!raw.length || raw.length > REPLY_CAP || !rendered.length || rendered.length > RENDERED_CAP) browserError('REPLY_SIZE');
    return { raw, rendered, structure: value.structure,
      snapshotSha256: responseSnapshotSha256(value.schema, value.codeText, value.renderedText, value.structure) };
  };
  const before = await sample();
  await visibleResponseParts(s, before.structure.highlightSpans);
  const after = await sample();
  if (before.snapshotSha256 !== after.snapshotSha256) browserError('REPLY_CHANGED');
  return after;
}
async function failed(s, error) {
  const codes = ['UI_STATE', 'NO_LIVE_RUNNER', 'ACK', 'PRECONDITION', 'ORIGIN', 'NONEMPTY', 'ABORTED', 'SOURCE_CHANGED', 'READBACK_RESULT'];
  const code = codes.find(value => error instanceof Error && error.message === 'GEMINI_BROWSER_' + value) ?? 'other';
  try {
    if (!mailExists(s.dir, 'adapter-failed.json')) writeOnce(s.dir, 'adapter-failed.json', {
      instance: s.instance, phase: s.phase ?? s.state, code, readbackMethod: 'dom-textContent-equality/v1',
      readbackUnit: 'utf16-code-units', readbacks: s.readbacks,
    });
  } finally { await cleanup(s, true); }
}

export async function beginBrowserScan(browser, runId) {
  const dir = jobDirectory(runId), d = validateDescriptor(readMail(dir, 'descriptor.json'));
  if (d.runId !== runId || sessions.has(runId)) browserError('REPLAY');
  const prompt = new TextDecoder('utf-8', { fatal: true }).decode(readBoundedFile(join(dir, 'control.txt'), CONTROL_CAP));
  if (Buffer.byteLength(prompt) !== d.manifest.control.bytes || sha256(prompt) !== d.manifest.control.sha256) browserError('REQUEST');
  const s = { dir, d, prompt, attachmentPath: join(dir, d.manifest.attachment.name), uploads: 0, instance: nonce(16), started: performance.now(), remaining: Math.min(15 * 60000, d.expiresAt - Date.now()), state: 'CLAIMING', phase: 'initial-source', readbacks: {}, tab: /** @type {any} */ (null) };
  s.readbacks = { input: unreadSummary(s), submit: unreadSummary(s) };
  alive(s);
  const claim = leaseMessage(d, s.instance, nonce(32), 'claim');
  writeOnce(dir, 'claim.json', claim);
  sessions.set(runId, s);
  try {
    s.phase = 'claim-ack';
    await waitMail(s, 'claim-ack.json', { ...claim, stage: 'claimed' });
    s.state = 'PREPARING';
    await step(s, async () => { s.tab = await browser.tabs.new(); }, 'new-tab');
    await step(s, () => s.tab.goto(URL), 'navigate');
    s.phase = 'initial-origin';
    await origin(s);
    await until(s, () => button(s.tab, 'Temporary chat').isVisible(), 'initial-controls');
    await step(s, () => main(s.tab).getByRole('button', { name: /^Open mode picker, currently / }).waitFor({ state: 'visible', timeoutMs: 10000 }), 'initial-model-control');
    s.phase = 'initial-empty';
    if (await step(s, () => responses(s.tab).count()) !== 0 || (await step(s, () => input(s.tab).textContent())).trim()) browserError('NONEMPTY');
    await step(s, () => button(s.tab, 'Temporary chat').click(), 'temporary-activate');
    await until(s, () => temporaryBefore(s), 'temporary-confirm');
    await step(s, () => main(s.tab).getByRole('button', { name: /^Open mode picker, currently / }).click(), 'model-menu-open');
    await until(s, () => s.tab.playwright.getByRole('menuitem', { name: /4 Argon Complex tasks/ }).isVisible(), 'model-option-wait');
    await step(s, () => s.tab.playwright.getByRole('menuitem', { name: /4 Argon Complex tasks/ }).click(), 'model-select');
    await until(s, async () => (await selected(s.tab))?.includes('Argon'), 'model-confirm');
    await step(s, () => main(s.tab).getByRole('button', { name: /^Open mode picker, currently / }).click(), 'effort-menu-open');
    await until(s, () => s.tab.playwright.getByRole('menuitem', { name: 'Thinking level', exact: true }).isVisible(), 'effort-menu-wait');
    await step(s, () => s.tab.playwright.getByRole('menuitem', { name: 'Thinking level', exact: true }).click(), 'effort-menu-select');
    await until(s, () => s.tab.playwright.getByRole('menuitem', { name: 'High Extra thorough', exact: true }).isVisible(), 'effort-option-wait');
    await step(s, () => s.tab.playwright.getByRole('menuitem', { name: 'High Extra thorough', exact: true }).click(), 'effort-select');
    await until(s, async () => await selected(s.tab) === SELECTED, 'effort-confirm');
    const initialAttachment = await attachmentState(s);
    if (initialAttachment.count !== 0 || initialAttachment.selectedFiles !== 0) browserError('NONEMPTY');
    s.state = 'PREPARED';
    return { runId, state: s.state, tabId: s.tab.id };
  } catch (e) { await failed(s, e); throw e; }
}

export async function uploadBrowserScan(runId) {
  const s = sessions.get(runId);
  if (!s || s.state !== 'PREPARED') browserError('UPLOAD_ORDER');
  s.state = 'UPLOADING';
  try {
    s.phase = 'upload-precondition'; await origin(s);
    const initial = await attachmentState(s);
    if (initial.count !== 0 || initial.selectedFiles !== 0 || await step(s, () => selected(s.tab)) !== SELECTED
      || !await step(s, () => temporaryBefore(s)) || await step(s, () => responses(s.tab).count()) !== 0) browserError('PRECONDITION');
    const request = { ...leaseMessage(s.d, s.instance, nonce(32), 'upload-request'), tabId: s.tab.id, temporary: true,
      initialResponses: 0, selected: SELECTED, initialAttachments: 0, attachment: s.d.manifest.attachment };
    writeOnce(s.dir, 'upload-request.json', request);
    const permit = { ...request, stage: 'upload-once' };
    await waitMail(s, 'upload-permit.json', permit);
    writeOnce(s.dir, 'upload-consumed.json', permit);
    await step(s, () => main(s.tab).getByRole('button', { name: 'Upload & tools', exact: true }).click({ timeoutMs: 10000 }), 'upload-menu-open');
    const menu = s.tab.playwright.getByRole('menu', { name: 'Upload file options', exact: true });
    await until(s, () => menu.isVisible(), 'upload-menu-wait');
    const item = menu.getByRole('menuitem', { name: 'Upload files. Documents, data, code files', exact: true });
    if (await step(s, () => menu.count()) !== 1 || await step(s, () => item.count()) !== 1) browserError('ATTACHMENT_UI');
    let chooserPromise;
    try {
      chooserPromise = step(s, () => s.tab.playwright.waitForEvent('filechooser', { timeoutMs: 30000 }), 'chooser-event');
      chooserPromise.catch(() => {});
      await step(s, () => item.click({ timeoutMs: 30000 }), 'chooser-open');
      const chooser = await chooserPromise; alive(s);
      s.uploads = 1;
      writeOnce(s.dir, 'upload-attempted.json', { instance: s.instance, tabId: s.tab.id, uploads: 1, attachment: s.d.manifest.attachment });
      await step(s, () => chooser.setFiles([s.attachmentPath], { timeoutMs: 30000 }), 'upload-attempt');
    } finally { if (chooserPromise) await chooserPromise.catch(() => {}); }
    s.state = 'UPLOADED';
    writeOnce(s.dir, 'uploaded.json', { instance: s.instance, tabId: s.tab.id, uploads: 1, attachment: s.d.manifest.attachment });
    return { runId, state: s.state, tabId: s.tab.id };
  } catch (e) { await failed(s, e); throw e; }
}

export async function submitBrowserScan(runId) {
  const s = sessions.get(runId);
  if (!s || s.state !== 'UPLOADED') browserError('SUBMIT_ORDER');
  s.state = 'PREPARING';
  const { dir, d, prompt } = s;
  try {
    await until(s, () => attachmentReady(s), 'attachment-ready');
    await step(s, () => input(s.tab).fill(prompt), 'input-fill');
    await until(s, async () => await readback(s, 'input') === true, 'input-readback');
    s.phase = 'ready-precondition';
    if (!await attachmentReady(s) || await step(s, () => selected(s.tab)) !== SELECTED
      || !await step(s, () => temporaryBefore(s)) || await step(s, () => responses(s.tab).count()) !== 0
      || !await step(s, () => button(s.tab, 'Send message').isEnabled())) browserError('PRECONDITION');
    const ready = { ...leaseMessage(d, s.instance, nonce(32), 'ready'), tabId: s.tab.id, temporary: true, initialResponses: 0, selected: SELECTED, attachmentReady: true };
    writeOnce(dir, 'ready.json', ready);
    const permit = { ...ready, stage: 'submit-once' };
    s.phase = 'permit-wait';
    await waitMail(s, 'permit.json', permit);
    writeOnce(dir, 'consumed.json', permit);
    s.phase = 'submit-precondition';
    await origin(s);
    if (!await attachmentReady(s) || !await step(s, () => button(s.tab, 'Send message').isEnabled())
      || await step(s, () => selected(s.tab)) !== SELECTED || await step(s, () => readback(s, 'submit')) !== true
      || !await step(s, () => temporaryBefore(s)) || await step(s, () => responses(s.tab).count()) !== 0) browserError('PRECONDITION');
    s.state = 'ATTEMPTED';
    await step(s, () => button(s.tab, 'Send message').click(), 'submit-attempt');
    s.state = 'SUBMITTED';
    writeOnce(dir, 'submitted.json', { instance: s.instance, tabId: s.tab.id, submissions: 1 });
    return { runId, state: s.state, tabId: s.tab.id };
  } catch (e) { await failed(s, e); throw e; }
}

export async function captureBrowserScan(runId) {
  const s = sessions.get(runId);
  if (!s || s.state !== 'SUBMITTED') browserError('CAPTURE_ORDER');
  // 先鎖記憶體狀態，阻止兩個同時的 capture 操作同一明細對話框。
  s.state = 'CAPTURING';
  try {
    s.phase = 'response';
    await origin(s);
    const count = await step(s, () => responses(s.tab).count());
    if (count > 1) browserError('MULTIPLE_RESPONSES');
    if (count === 0 || await step(s, () => button(s.tab, 'Stop response').isVisible())
      || !await step(s, () => button(s.tab, 'Show more options').isVisible())) {
      s.state = 'SUBMITTED'; return { runId, state: 'PENDING' };
    }
    if (await step(s, () => selected(s.tab)) !== SELECTED
      || !await step(s, () => main(s.tab).getByText('Temporary Chat', { exact: true }).isVisible())) browserError('POSTCONDITION');
    const captured = await readVisibleResponse(s), { raw, rendered } = captured;
    s.phase = 'details-menu';
    await step(s, () => button(s.tab, 'Show more options').click());
    // 保留本場選單畫面，才能分辨介面改版與控制失敗；它不是採用回覆的資格。
    writeOnce(s.dir, 'details-menu.jpg', Buffer.from(await step(s, () => s.tab.screenshot({ fullPage: false }))));
    writeOnce(s.dir, 'details-menu.json', await step(s, () => s.tab.playwright.getByRole('menu').allTextContents({ timeoutMs: 1000 })));
    const detailsItem = s.tab.playwright.getByRole('menuitem', { name: 'See response details', exact: true });
    const thinkingItem = s.tab.playwright.getByRole('menuitem', { name: 'Show thinking steps', exact: true });
    await until(s, async () => await detailsItem.isVisible() || await thinkingItem.isVisible());
    const hasDetails = await step(s, () => detailsItem.isVisible()), hasThinking = await step(s, () => thinkingItem.isVisible());
    if (hasDetails === hasThinking) browserError('DETAILS_SOURCE');
    const detailsSource = hasDetails ? 'response-details' : 'thinking-steps';
    s.phase = 'details-content';
    await step(s, () => (hasDetails ? detailsItem : thinkingItem).click());
    const sidebar = s.tab.playwright.locator('context-sidebar');
    // 只認官方側欄的 metadata，避免把回覆或思考段落中的自報模型當來源。
    const metadata = sidebar.locator('thought-summary .info-line');
    await step(s, () => metadata.waitFor({ state: 'visible', timeoutMs: 10000 }));
    if (await step(s, () => sidebar.count()) !== 1 || await step(s, () => metadata.count()) !== 1) browserError('DETAILS_SOURCE');
    const details = await step(s, () => metadata.innerText());
    if (details !== DETAILS) browserError('ACTUAL_MODEL');
    writeOnce(s.dir, 'proof.jpg', Buffer.from(await step(s, () => s.tab.screenshot({ fullPage: false }))));
    s.phase = 'details-close';
    await step(s, () => sidebar.getByRole('button', { name: 'Close sidebar', exact: true }).click());
    await step(s, () => sidebar.waitFor({ state: 'hidden', timeoutMs: 10000 }));
    s.phase = 'final-observation';
    if (await step(s, () => responses(s.tab).count()) !== 1 || (await readVisibleResponse(s)).snapshotSha256 !== captured.snapshotSha256
      || await step(s, () => selected(s.tab)) !== SELECTED || await step(s, () => button(s.tab, 'Stop response').isVisible())) browserError('REPLY_CHANGED');
    const observation = { schema: OBSERVATION, scanId: s.d.scanId, tabId: s.tab.id, origin: ORIGIN,
      initialResponses: 0, submissions: 1, finalResponses: 1, temporaryBefore: true, temporaryAfter: true,
      selectedBefore: SELECTED, selectedAfter: SELECTED, details, detailsSource, complete: true, regenerations: 0,
      requestSha256: s.d.requestSha256, controlSha256: s.d.manifest.control.sha256,
      attachment: { name: s.d.manifest.attachment.name, count: 1, ready: true, uploads: s.uploads, localSha256: s.d.manifest.attachment.sha256 }, responseSha256: sha256(raw), responseBytes: raw.length,
      bodySource: 'visible-json-code/v1', renderedSha256: sha256(rendered), renderedBytes: rendered.length, snapshotSha256: captured.snapshotSha256 };
    alive(s);
    writeOnce(s.dir, 'response-rendered.txt', rendered);
    writeOnce(s.dir, 'response-dom.json', { bodySource: observation.bodySource, structure: captured.structure, snapshotSha256: captured.snapshotSha256 });
    writeOnce(s.dir, 'response.txt', raw);
    writeOnce(s.dir, 'capture.json', { instance: s.instance, observation });
    await cleanup(s, false);
    return { runId, state: 'CAPTURED', responseBytes: raw.length, responseSha256: sha256(raw) };
  } catch (e) { await failed(s, e); throw e; }
}

export async function cancelBrowserScan(runId) {
  const s = sessions.get(runId);
  if (!s || !['CLAIMING', 'PREPARED', 'UPLOADING', 'UPLOADED', 'PREPARING', 'ATTEMPTED', 'CAPTURING', 'SUBMITTED'].includes(s.state)) browserError('CANCEL_ORDER');
  if (!mailExists(s.dir, 'cancel.json')) writeOnce(s.dir, 'cancel.json', { instance: s.instance });
  if (!['SUBMITTED', 'PREPARED', 'UPLOADED'].includes(s.state)) return { runId, state: 'CANCEL_REQUESTED' };
  s.state = 'CANCELLING';
  await cleanup(s, true);
  return { runId, state: 'CLOSED' };
}

if (typeof process !== 'undefined' && isMainModule(import.meta.url)) { process.stderr.write('GEMINI_BROWSER_CUA_REPL_REQUIRED\n'); process.exitCode = 78; }
