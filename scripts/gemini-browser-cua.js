// @ts-check
// 只在官方 CUA REPL 載入；瀏覽器權限由可信固定配方持有，模型文字只落進資料檔。
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { URL as NodeURL } from 'node:url';
import { SOURCE_ROOT, SOURCE_FILES, jobDirectory, readMail, readBoundedFile, writeOnce, mailExists, sourceDigest, browserError } from './gemini-browser-files.js';
import { URL, ORIGIN, SELECTED, DETAILS, REPLY_CAP, sha256, validateDescriptor, leaseMessage } from './gemini-browser-protocol.js';

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
  process.kill(s.d.pid, 0);
  if (sourceDigest(SOURCE_ROOT, SOURCE_FILES).sha256 !== s.d.sourceSha256
    || sha256(readBoundedFile(join(s.dir, 'prompt.txt'))) !== s.d.requestSha256
    || !equal(readMail(s.dir, 'descriptor.json'), s.d)) browserError('SOURCE_CHANGED');
}
async function step(s, action) { alive(s); return await action(); }
async function waitMail(s, name, expected) {
  const end = performance.now() + 5000;
  while (!mailExists(s.dir, name)) {
    alive(s); if (performance.now() >= end) browserError('NO_LIVE_RUNNER'); await pause();
  }
  alive(s);
  if (!equal(readMail(s.dir, name), expected)) browserError('ACK');
}
async function until(s, predicate) {
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
  if (s.tab) await s.tab.close();
  writeOnce(s.dir, 'quiescent.json', { instance: s.instance, tabClosed: !!s.tab, failed });
  s.state = 'CLOSED';
}
async function failed(s) {
  if (!mailExists(s.dir, 'adapter-failed.json')) writeOnce(s.dir, 'adapter-failed.json', { instance: s.instance });
  await cleanup(s, true);
}

export async function beginBrowserScan(browser, runId) {
  const dir = jobDirectory(runId), d = validateDescriptor(readMail(dir, 'descriptor.json'));
  if (d.runId !== runId || sessions.has(runId)) browserError('REPLAY');
  const prompt = new TextDecoder('utf-8', { fatal: true }).decode(readBoundedFile(join(dir, 'prompt.txt')));
  if (Buffer.byteLength(prompt) !== d.requestBytes || sha256(prompt) !== d.requestSha256) browserError('REQUEST');
  const s = { dir, d, prompt, instance: nonce(16), started: performance.now(), remaining: Math.min(15 * 60000, d.expiresAt - Date.now()), state: 'CLAIMING', tab: /** @type {any} */ (null) };
  alive(s);
  const claim = leaseMessage(d, s.instance, nonce(32), 'claim');
  writeOnce(dir, 'claim.json', claim);
  sessions.set(runId, s);
  try {
    await waitMail(s, 'claim-ack.json', { ...claim, stage: 'claimed' });
    s.state = 'PREPARING';
    s.tab = await step(s, () => browser.tabs.new());
    await step(s, () => s.tab.goto(URL));
    await origin(s);
    await until(s, () => button(s.tab, 'Temporary chat').isVisible());
    if (await step(s, () => responses(s.tab).count()) !== 0 || (await step(s, () => input(s.tab).textContent())).trim()) browserError('NONEMPTY');
    await step(s, () => button(s.tab, 'Temporary chat').click());
    await until(s, () => temporaryBefore(s));
    await step(s, () => main(s.tab).getByRole('button', { name: /^Open mode picker, currently / }).click());
    await until(s, () => s.tab.playwright.getByRole('menuitem', { name: /4 Argon Complex tasks/ }).isVisible());
    await step(s, () => s.tab.playwright.getByRole('menuitem', { name: /4 Argon Complex tasks/ }).click());
    await until(s, async () => (await selected(s.tab))?.includes('Argon'));
    await step(s, () => main(s.tab).getByRole('button', { name: /^Open mode picker, currently / }).click());
    await until(s, () => s.tab.playwright.getByRole('menuitem', { name: 'Thinking level', exact: true }).isVisible());
    await step(s, () => s.tab.playwright.getByRole('menuitem', { name: 'Thinking level', exact: true }).click());
    await until(s, () => s.tab.playwright.getByRole('menuitem', { name: 'High Extra thorough', exact: true }).isVisible());
    await step(s, () => s.tab.playwright.getByRole('menuitem', { name: 'High Extra thorough', exact: true }).click());
    await until(s, async () => await selected(s.tab) === SELECTED);
    await step(s, () => input(s.tab).fill(prompt));
    await until(s, async () => await input(s.tab).textContent() === prompt);
    if (!await step(s, () => temporaryBefore(s)) || await step(s, () => responses(s.tab).count()) !== 0) browserError('PRECONDITION');
    const ready = { ...leaseMessage(d, s.instance, nonce(32), 'ready'), tabId: s.tab.id, temporary: true, initialResponses: 0, selected: SELECTED };
    writeOnce(dir, 'ready.json', ready);
    const permit = { ...ready, stage: 'submit-once' };
    await waitMail(s, 'permit.json', permit);
    writeOnce(dir, 'consumed.json', permit);
    await origin(s);
    if (await step(s, () => selected(s.tab)) !== SELECTED || await step(s, () => input(s.tab).textContent()) !== prompt
      || !await step(s, () => temporaryBefore(s)) || await step(s, () => responses(s.tab).count()) !== 0) browserError('PRECONDITION');
    s.state = 'ATTEMPTED';
    await step(s, () => button(s.tab, 'Send message').click());
    s.state = 'SUBMITTED';
    writeOnce(dir, 'submitted.json', { instance: s.instance, tabId: s.tab.id, submissions: 1 });
    return { runId, state: s.state, tabId: s.tab.id };
  } catch (e) { await failed(s); throw e; }
}

export async function captureBrowserScan(runId) {
  const s = sessions.get(runId);
  if (!s || s.state !== 'SUBMITTED') browserError('CAPTURE_ORDER');
  // 先鎖記憶體狀態，阻止兩個同時的 capture 操作同一明細對話框。
  s.state = 'CAPTURING';
  try {
    await origin(s);
    const count = await step(s, () => responses(s.tab).count());
    if (count > 1) browserError('MULTIPLE_RESPONSES');
    if (count === 0 || await step(s, () => button(s.tab, 'Stop response').isVisible())
      || !await step(s, () => button(s.tab, 'Show more options').isVisible())) {
      s.state = 'SUBMITTED'; return { runId, state: 'PENDING' };
    }
    if (await step(s, () => selected(s.tab)) !== SELECTED
      || !await step(s, () => main(s.tab).getByText('Temporary Chat', { exact: true }).isVisible())) browserError('POSTCONDITION');
    const response = await step(s, () => responses(s.tab).innerText());
    if (typeof response !== 'string' || !/** @type {string & {isWellFormed(): boolean}} */ (response).isWellFormed()) browserError('REPLY_ENCODING');
    const raw = Buffer.from(response);
    if (!raw.length || raw.length > REPLY_CAP) browserError('REPLY_SIZE');
    await step(s, () => button(s.tab, 'Show more options').click());
    await until(s, () => s.tab.playwright.getByRole('menuitem', { name: 'See response details', exact: true }).isVisible());
    await step(s, () => s.tab.playwright.getByRole('menuitem', { name: 'See response details', exact: true }).click());
    const dialog = s.tab.playwright.getByRole('dialog');
    await until(s, () => dialog.isVisible());
    const details = await step(s, () => dialog.innerText());
    if (details !== DETAILS) browserError('ACTUAL_MODEL');
    writeOnce(s.dir, 'proof.jpg', Buffer.from(await step(s, () => s.tab.screenshot({ fullPage: false }))));
    await step(s, () => dialog.getByRole('button', { name: 'Close sidebar', exact: true }).click());
    await until(s, async () => !await dialog.isVisible());
    if (await step(s, () => responses(s.tab).count()) !== 1 || sha256(await step(s, () => responses(s.tab).innerText())) !== sha256(raw)
      || await step(s, () => selected(s.tab)) !== SELECTED || await step(s, () => button(s.tab, 'Stop response').isVisible())) browserError('REPLY_CHANGED');
    const observation = { schema: 'browser-ui/v1', scanId: s.d.scanId, tabId: s.tab.id, origin: ORIGIN,
      initialResponses: 0, submissions: 1, finalResponses: 1, temporaryBefore: true, temporaryAfter: true,
      selectedBefore: SELECTED, selectedAfter: SELECTED, details, complete: true, regenerations: 0,
      promptSha256: s.d.requestSha256, responseSha256: sha256(raw), responseBytes: raw.length };
    alive(s);
    writeOnce(s.dir, 'response.txt', raw);
    writeOnce(s.dir, 'capture.json', { instance: s.instance, observation });
    await cleanup(s, false);
    return { runId, state: 'CAPTURED', responseBytes: raw.length, responseSha256: sha256(raw) };
  } catch (e) { await failed(s); throw e; }
}

export async function cancelBrowserScan(runId) {
  const s = sessions.get(runId);
  if (!s || !['CLAIMING', 'PREPARING', 'ATTEMPTED', 'CAPTURING', 'SUBMITTED'].includes(s.state)) browserError('CANCEL_ORDER');
  writeOnce(s.dir, 'cancel.json', { instance: s.instance });
  if (s.state !== 'SUBMITTED') return { runId, state: 'CANCEL_REQUESTED' };
  s.state = 'CANCELLING';
  await cleanup(s, true);
  return { runId, state: 'CLOSED' };
}
