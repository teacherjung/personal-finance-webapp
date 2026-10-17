// 合成工作與嚴格 API 假身只驗本機控制；實際 CUA、沙箱與服務回覆另做整鏈驗收。
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SOURCE_ROOT, SOURCE_FILES, JOB_ROOT, sourceDigest, writeOnce, readMail } from '../../scripts/gemini-browser-files.js';
import { prepareBrowserPacket, SELECTED, DETAILS, ORIGIN, sha256 } from '../../scripts/gemini-browser-protocol.js';
import { BrowserLease } from '../../scripts/gemini-browser-runner.js';
import { FILES, finding } from './gemini-native-fixture.js';

export function material() {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const text = JSON.stringify({ base, head, files: FILES, diff: 'diff --git a/lib/synthetic.js b/lib/synthetic.js\n-return n > 0;\n+return n >= 0;', prompt: 'Review synthetic code.' });
  return { text, sha256: sha256(text), base, head };
}
export function answer(packet) { return JSON.stringify({ ...packet.binding, tailChallenge: packet.tailChallenge, findings: [finding()] }); }
export function observation(packet, raw = answer(packet)) {
  return { schema: 'browser-ui/v1', scanId: packet.binding.scanId, tabId: 'test-owned', origin: ORIGIN,
    initialResponses: 0, submissions: 1, finalResponses: 1, temporaryBefore: true, temporaryAfter: true,
    selectedBefore: SELECTED, selectedAfter: SELECTED, details: DETAILS, complete: true, regenerations: 0,
    promptSha256: packet.promptSha256, responseSha256: sha256(raw), responseBytes: Buffer.byteLength(raw) };
}
export function jobFixture() {
  mkdirSync(JOB_ROOT, { mode: 0o700, recursive: true });
  const runId = randomBytes(16).toString('hex'), dir = join(JOB_ROOT, runId);
  mkdirSync(dir, { mode: 0o700 });
  const packet = prepareBrowserPacket(material());
  const descriptor = { schema: 'browser-job/v1', runId, lease: randomBytes(32).toString('hex'), sourceSha256: sourceDigest(SOURCE_ROOT, SOURCE_FILES).sha256,
    requestSha256: packet.promptSha256, requestBytes: packet.promptBytes, scanId: packet.binding.scanId, pid: process.pid, expiresAt: Date.now() + 60000 };
  writeOnce(dir, 'prompt.txt', packet.prompt); writeOnce(dir, 'descriptor.json', descriptor);
  const lease = new BrowserLease(dir, descriptor, () => {});
  let timer, failure;
  return { runId, dir, packet, descriptor, lease,
    serve() { timer = setInterval(() => { try { lease.tick(); } catch (e) { failure = e; clearInterval(timer); } }, 10); },
    stop() { clearInterval(timer); }, error() { return failure; },
    cleanup() { clearInterval(timer); rmSync(dir, { recursive: true, force: true }); },
  };
}

export function browserFixture(job, options = {}) {
  const calls = [], state = { temporary: false, text: '', selected: 'Open mode picker, currently Flash', responses: 0, sent: 0, menu: '', dialog: false, detailsLoaded: true, closed: false, pending: false, ...options };
  const raw = answer(job.packet);
  const locator = key => ({
    getByRole: (role, opt = {}) => locator(`${key}/${role}:${String(opt.name ?? '')}`),
    getByText: text => locator(`${key}/text:${text}`),
    locator: selector => locator(`${key}/${selector}`),
    async getAttribute(name) { assertKey(name === 'aria-label' && key.includes('Open mode picker')); return state.selected; },
    async allTextContents() { assertKey(key === 'menu:'); return state.menu ? ['synthetic response menu'] : []; },
    async count() { assertKey(key.endsWith('model-response-content')); return state.responses; },
    async textContent() { assertKey(key.includes('textbox:Enter a prompt for Gemini')); return state.text; },
    async fill(text) { calls.push(['fill', text]); state.text = options.truncate ? text.slice(0, -1) : text; },
    async innerText() { if (key.endsWith('model-response-content')) return state.raw ?? raw; if (key === 'dialog:') return state.detailsLoaded ? state.details ?? DETAILS : 'Response details'; throw Error(`unexpected read ${key}`); },
    async isVisible() {
      if (key === 'dialog:') return state.dialog;
      if (key.includes('Temporary chat')) return true;
      if (key.includes('Just stopping by?') || key.includes('Temporary chats')) return state.temporary;
      if (key.includes('text:Temporary Chat')) return state.temporary && state.sent > 0;
      if (key.includes('Stop response')) return state.pending;
      if (key.includes('Show more options')) return state.sent > 0 && !state.pending;
      if (key.includes('menuitem:')) return !!state.menu;
      throw Error(`unexpected visibility ${key}`);
    },
    async waitFor(options) {
      if (key === 'dialog:') { assertKey(options.state === 'hidden' && !state.dialog); return; }
      if (key === 'dialog:/text:/^Used /') { assertKey(options.state === 'visible' && state.dialog); state.detailsLoaded = true; return; }
      assertKey(key.endsWith('menuitem:See response details') && options.state === 'visible' && !!state.menu);
    },
    async click() {
      calls.push(['click', key]);
      if (key.endsWith('button:Temporary chat')) state.temporary = true;
      else if (key.includes('Open mode picker')) state.menu = 'model';
      else if (key.includes('4 Argon Complex tasks')) { state.selected = 'Open mode picker, currently Argon'; state.menu = ''; }
      else if (key.endsWith('menuitem:Thinking level')) state.menu = 'effort';
      else if (key.endsWith('menuitem:High Extra thorough')) { state.selected = SELECTED; state.menu = ''; }
      else if (key.endsWith('button:Send message')) {
        const consumed = readMail(job.dir, 'consumed.json'); assertKey(consumed.stage === 'submit-once');
        state.sent++; state.responses++; state.text = ''; if (options.afterSubmit) options.afterSubmit(state);
      } else if (key.endsWith('button:Show more options')) state.menu = 'response';
      else if (key.endsWith('menuitem:See response details')) { state.dialog = true; state.detailsLoaded = !options.detailsLoading; state.menu = ''; }
      else if (key.endsWith('button:Close sidebar')) { state.dialog = false; if (options.afterDetails) options.afterDetails(state); }
      else throw Error(`unexpected click ${key}`);
    },
  });
  const tab = { id: 'test-owned', playwright: { getByRole: (role, opt = {}) => locator(`${role}:${String(opt.name ?? '')}`) },
    async goto(url) { calls.push(['goto', url]); }, async url() { return state.url ?? ORIGIN + '/app'; },
    async screenshot() { calls.push(['screenshot']); return Buffer.from('synthetic screenshot'); },
    async close() { calls.push(['close', this.id]); state.closed = true; },
  };
  return { calls, state, browser: { tabs: { async new() { calls.push(['new']); return tab; } } } };
}
function assertKey(ok) { if (!ok) throw Error('unexpected fixture action'); }
