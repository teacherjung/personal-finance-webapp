// 合成工作與嚴格 API 假身只驗本機控制；實際 CUA、沙箱與服務回覆另做整鏈驗收。
import { mkdirSync, rmSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { SOURCE_ROOT, SOURCE_FILES, JOB_ROOT, sourceDigest, writeOnce, readMail } from '../../scripts/gemini-browser-files.js';
import { prepareBrowserPacket, SELECTED, DETAILS, ORIGIN, OBSERVATION, sha256 } from '../../scripts/gemini-browser-protocol.js';
import { BrowserLease } from '../../scripts/gemini-browser-runner.js';
import { beginBrowserScan, uploadBrowserScan, submitBrowserScan } from '../../scripts/gemini-browser-cua.js';
import { FILES, finding } from './gemini-native-fixture.js';

export function material() {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const text = JSON.stringify({ base, head, files: FILES, diff: 'diff --git a/lib/synthetic.js b/lib/synthetic.js\n-return n > 0;\n+return n >= 0;', prompt: 'Review synthetic code.' });
  return { text, sha256: sha256(text), base, head };
}
export function answer(packet) { return JSON.stringify({ ...packet.binding, tailChallenge: packet.tailChallenge, findings: [finding()] }); }
export function responseArtifacts(raw) {
  const rendered = 'JSON\n' + raw, structure = { elements: 29, highlightSpans: 0, codeBlocks: 1, pre: 1, code: 1, codeNodes: [[3, raw.length]] };
  const snapshotSha256 = sha256(JSON.stringify({ schema: 'visible-json-code/v1', codeText: raw, renderedText: rendered, structure }));
  return { rendered, dom: { bodySource: 'visible-json-code/v1', structure, snapshotSha256 } };
}
export function observation(packet, raw = answer(packet)) {
  const { rendered, dom } = responseArtifacts(raw);
  return { schema: OBSERVATION, scanId: packet.binding.scanId, tabId: 'test-owned', origin: ORIGIN,
    initialResponses: 0, submissions: 1, finalResponses: 1, temporaryBefore: true, temporaryAfter: true,
    selectedBefore: SELECTED, selectedAfter: SELECTED, details: DETAILS, detailsSource: 'response-details', complete: true, regenerations: 0,
    requestSha256: packet.requestSha256, controlSha256: packet.manifest.control.sha256,
    attachment: { name: packet.manifest.attachment.name, count: 1, ready: true, uploads: 1, localSha256: packet.manifest.attachment.sha256 }, responseSha256: sha256(raw), responseBytes: Buffer.byteLength(raw),
    bodySource: dom.bodySource, renderedSha256: sha256(rendered), renderedBytes: Buffer.byteLength(rendered), snapshotSha256: dom.snapshotSha256 };
}
export function jobFixture(input = material()) {
  mkdirSync(JOB_ROOT, { mode: 0o700, recursive: true });
  const runId = randomBytes(16).toString('hex'), dir = join(JOB_ROOT, runId);
  mkdirSync(dir, { mode: 0o700 });
  const packet = prepareBrowserPacket(input);
  writeOnce(dir, packet.manifest.attachment.name, packet.attachmentText);
  const st = lstatSync(join(dir, packet.manifest.attachment.name), { bigint: true });
  const attachmentIdentity = [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs, st.mode, st.nlink].join(':');
  const descriptor = { schema: 'browser-attachment-job/v1', runId, lease: randomBytes(32).toString('hex'), sourceSha256: sourceDigest(SOURCE_ROOT, SOURCE_FILES).sha256,
    requestSha256: packet.requestSha256, manifest: packet.manifest, attachmentIdentity, scanId: packet.binding.scanId, pid: process.pid, expiresAt: Date.now() + 60000 };
  writeOnce(dir, 'control.txt', packet.controlPrompt); writeOnce(dir, 'descriptor.json', descriptor);
  const lease = new BrowserLease(dir, descriptor, () => {});
  let timer, failure;
  return { runId, dir, packet, descriptor, lease,
    serve() { timer = setInterval(() => { try { lease.tick(); } catch (e) { failure = e; clearInterval(timer); } }, 10); },
    stop() { clearInterval(timer); }, error() { return failure; },
    cleanup() { clearInterval(timer); rmSync(dir, { recursive: true, force: true }); },
  };
}

// DOM 取自小附件診斷的父子鏈；jsdom 只補可見性，不冒充實際網頁驗收。
export function responseDom(raw, options = {}) {
  const window = new JSDOM().window, d = window.document;
  const add = (parent, tag, classes = '', attrs = {}) => {
    const node = d.createElement(tag); node.className = classes;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent.append(node); return node;
  };
  const root = add(d.body, 'model-response-content');
  let parent = root;
  for (const [tag, classes] of [['structured-content-container', 'model-response-text'], ['div', 'container'],
    ['message-content', ''], ['div', 'markdown markdown-main-panel md-content'], ['response-element', 'no-md md-has-block-component'],
    ['code-block', ''], ['div', 'code-block'], ['div', 'formatted-code-block-internal-container'], ['div', 'animated-opacity']]) parent = add(parent, tag, classes);
  const header = add(parent, 'div', 'code-block-decoration header-formatted');
  add(header, 'span').textContent = 'JSON';
  const buttons = add(header, 'div', 'buttons');
  for (const [cls, label] of [['download-button', 'Download code'], ['copy-button', 'Copy code']]) {
    const button = add(add(buttons, 'gem-icon-button', cls), 'button', '', { 'aria-label': label });
    add(button, 'span', 'mat-mdc-button-persistent-ripple');
    add(add(button, 'gem-icon'), 'mat-icon', '', { role: 'img' });
    add(button, 'span', 'mat-focus-indicator'); add(button, 'span', 'mat-mdc-button-touch-target');
  }
  const code = add(add(parent, 'pre'), 'code', 'code-container formatted', { role: 'text' });
  if (options.highlight) {
    code.append(d.createTextNode(raw.slice(0, 1)));
    add(code, 'span', 'hljs-string').textContent = raw.slice(1, -1);
    code.append(d.createTextNode(raw.slice(-1)));
  } else code.textContent = raw;
  if (options.mutateDom) options.mutateDom(root, d);
  for (const node of [root, ...root.querySelectorAll('*')]) node.getClientRects = () => node.hasAttribute('hidden') || node.closest('[hidden]') ? [] : [{}];
  Object.defineProperty(root, 'innerText', { value: options.rendered ?? 'JSON\n' + raw });
  return { root, close: () => window.close() };
}

export function browserFixture(job, options = {}) {
  let chooserResolve;
  const calls = [], state = { uploads: 0, temporary: false, text: '', selected: 'Open mode picker, currently Flash', responses: 0, sent: 0, menu: '', dialog: false, detailsLoaded: true, closed: false, pending: false, ...options };
  const raw = answer(job.packet);
  const locator = key => ({
    getByRole: (role, opt = {}) => locator(`${key}/${role}:${String(opt.name ?? '')}`),
    getByText: text => locator(`${key}/text:${text}`),
    locator: selector => locator(`${key}/${selector}`),
    async getAttribute(name) { assertKey(name === 'aria-label' && key.includes('Open mode picker')); return state.selected; },
    async allTextContents() { assertKey(key === 'menu:'); return state.menu ? ['synthetic response menu'] : []; },
    async count() {
      if (key.endsWith('model-response-content')) return state.responses;
      if (key.endsWith('input-area-v2')) return state.composerCount ?? 1;
      if (key === 'menu:Upload file options' || key.endsWith('menuitem:Upload files. Documents, data, code files')) return 1;
      if (key === 'context-sidebar') return state.sidebarCount ?? 1;
      if (key === 'context-sidebar/thought-summary .info-line') return state.metadataCount ?? 1;
      if (key === `text:${DETAILS}`) return 1;
      throw Error(`unexpected count ${key}`);
    },
    async textContent() { assertKey(key.includes('textbox:Enter a prompt for Gemini')); return state.text.slice(0, options.textContentCap); },
    async evaluate(fn, expected) {
      if (key.includes('textbox:Enter a prompt for Gemini')) return fn({ textContent: state.text }, expected);
      if (key.endsWith('model-response-content')) {
        const { root, close } = responseDom(state.raw ?? raw, state);
        calls.push(['response-code', key]);
        try { return fn(root, expected); } finally { close(); }
      }
      assertKey(key.endsWith('input-area-v2'));
      const container = { getAttribute: name => { assertKey(name === 'aria-describedby'); return state.descriptionId ?? 'synthetic-description'; } };
      const content = { classList: { contains: name => { assertKey(name === 'loading'); return !!state.loading; } } };
      const preview = { getClientRects: () => state.hiddenAttachment ? [] : [{}], querySelectorAll: selector => {
        if (selector === '.file-preview-container') return state.ambiguousContainer ? [container, container] : [container];
        if (selector === '.gem-attachment-content') return [content];
        if (selector === '.gem-attachment-extension-label') return [{ textContent: state.extension ?? 'TXT' }];
        if (selector === '[role="progressbar"]') return state.loading ? [{}] : [];
        throw Error('unexpected attachment selector ' + selector);
      } };
      const element = { ownerDocument: { getElementById: id => { assertKey(id === 'synthetic-description'); return { textContent: state.attachmentName ?? job.packet.manifest.attachment.name }; } },
        querySelectorAll: selector => {
          if (selector === 'uploader-file-preview') return Array.from({ length: state.attachmentCount ?? state.uploads }, () => preview);
          if (selector === 'input[type=file]') return [{ files: Array.from({ length: state.uploads }) }];
          throw Error('unexpected composer selector ' + selector);
        } };
      return fn(element, expected);
    },
    async fill(text) { calls.push(['fill', text]); state.text = options.truncate ? text.slice(0, -1) : text; },
    async innerText() {
      if (key.endsWith('model-response-content')) return state.raw ?? raw;
      if (key === 'context-sidebar/thought-summary .info-line') return state.detailsLoaded ? state.details ?? DETAILS : '';
      if (key === `text:${DETAILS}`) return state.selfReportedDetails ?? DETAILS;
      throw Error(`unexpected read ${key}`);
    },
    async isEnabled() { assertKey(key.endsWith('button:Send message')); return !state.sendDisabled; },
    async isVisible() {
      if (key === 'menu:Upload file options') return state.menu === 'upload';
      if (key === 'dialog:') return state.dialog;
      if (key.includes('Temporary chat')) return true;
      if (key.includes('Just stopping by?') || key.includes('Temporary chats')) return state.temporary;
      if (key.includes('text:Temporary Chat')) return state.temporary && state.sent > 0;
      if (key.includes('Stop response')) return state.pending;
      if (key.includes('Show more options')) return state.sent > 0 && !state.pending;
      if (key.endsWith('menuitem:See response details')) return state.menu === 'response' && state.responseMenu !== 'thinking-steps';
      if (key.endsWith('menuitem:Show thinking steps')) return state.menu === 'response' && ['thinking-steps', 'ambiguous'].includes(state.responseMenu);
      if (key.includes('menuitem:')) return !!state.menu;
      throw Error(`unexpected visibility ${key}`);
    },
    async waitFor(options) {
      if (key.includes('Open mode picker')) { assertKey(options.state === 'visible'); return; }
      if (key === 'context-sidebar') { assertKey(options.state === 'hidden' && !state.dialog); return; }
      if (key === `text:${DETAILS}`) { assertKey(options.state === 'visible'); return; }
      assertKey(key === 'context-sidebar/thought-summary .info-line' && options.state === 'visible' && state.dialog);
      if (state.metadataCount === 0) throw Error('missing official metadata');
      state.detailsLoaded = true;
    },
    async click() {
      calls.push(['click', key]);
      if (key.endsWith('button:Upload & tools')) state.menu = 'upload';
      else if (key.endsWith('menuitem:Upload files. Documents, data, code files')) { assertKey(typeof chooserResolve === 'function'); chooserResolve({ async setFiles(paths, options) {
        assertKey(paths.length === 1 && paths[0] === join(job.dir, job.packet.manifest.attachment.name) && options.timeoutMs === 30000);
        assertKey(readMail(job.dir, 'upload-consumed.json').stage === 'upload-once');
        assertKey(readMail(job.dir, 'upload-attempted.json').uploads === 1);
        assertKey(sha256(readFileSync(paths[0])) === job.packet.manifest.attachment.sha256);
        calls.push(['setFiles', paths]); state.uploads++; if (state.afterUpload) await state.afterUpload(state);
      } }); }
      else if (key.endsWith('button:Temporary chat')) state.temporary = true;
      else if (key.includes('Open mode picker')) state.menu = 'model';
      else if (key.includes('4 Argon Complex tasks')) { state.selected = 'Open mode picker, currently Argon'; state.menu = ''; }
      else if (key.endsWith('menuitem:Thinking level')) state.menu = 'effort';
      else if (key.endsWith('menuitem:High Extra thorough')) { state.selected = SELECTED; state.menu = ''; }
      else if (key.endsWith('button:Send message')) {
        const consumed = readMail(job.dir, 'consumed.json'); assertKey(consumed.stage === 'submit-once');
        state.sent++; state.responses++; state.text = ''; if (options.afterSubmit) options.afterSubmit(state);
      } else if (key.endsWith('button:Show more options')) state.menu = 'response';
      else if (key.endsWith('menuitem:See response details') || key.endsWith('menuitem:Show thinking steps')) { state.dialog = true; state.detailsLoaded = !options.detailsLoading; state.menu = ''; }
      else if (key.endsWith('button:Close sidebar')) { state.dialog = false; if (options.afterDetails) options.afterDetails(state); }
      else throw Error(`unexpected click ${key}`);
    },
  });
  const tab = { id: 'test-owned', playwright: { waitForEvent(event, options) { assertKey(event === 'filechooser' && options.timeoutMs === 30000); calls.push(['filechooser']); return new Promise(resolve => { chooserResolve = resolve; }); }, getByRole: (role, opt = {}) => locator(`${role}:${String(opt.name ?? '')}`), locator, getByText: text => locator(`text:${text}`) },
    async goto(url) { calls.push(['goto', url]); }, async url() { return state.url ?? ORIGIN + '/app'; },
    async screenshot() { calls.push(['screenshot']); return Buffer.from('synthetic screenshot'); },
    async close() { calls.push(['close', this.id]); state.closed = true; },
  };
  return { calls, state, tab, browser: { tabs: { async new() { calls.push(['new']); return tab; } } } };
}
function assertKey(ok) { if (!ok) throw Error('unexpected fixture action'); }

export async function runBrowserScanUi(browser, runId) {
  await beginBrowserScan(browser, runId);
  await uploadBrowserScan(runId);
  return await submitBrowserScan(runId);
}
