// @ts-check
// 留痕範本 ↔ 套件解析器的整合題（搬家第 6 步，#613 r1 Medium①、r2 Medium①，2026-09-17）。
// 正本＝templates/ruling-record.md（三種留痕的第一行、裁示的原話行、撤回的三行）；讀它的機器＝tools/pending-rulings.js（RULES D1、I1〜I3；只列不擋）。
// 套件自己的考題用手寫夾具（套件 tests/pending-rulings.test.js），本專案的守表題只守分級與小標——所以「範本改一個字、解析器沒跟上」
// 時整份考卷仍綠（Codex #613 r1 實測：原話行「對話中」改「對話裡」，3589 題全綠；照新範本填的裁示卻關不了題）。
// 這裡直接讀真範本、只換佔位符、填本專案 settings.json 登記的識別值，餵正式的 evaluate()，斷言真正的分類結果。
// 樣板行**綁位置、不綁內容**（r2 Medium①：全檔找「長得對的那一行」會被別處的好範例冒充——真正那行改壞、前面留一份舊好樣板，全卷仍綠）：
// 先切出範本的三節（## 問／## 裁示落地／## 合規撤回，各剛好一節），在節裡找指示句（「第一行逐字…：」「第一段逐字照下面這行填…：」
// 「內文三行都要有：」，各剛好一句），抽**指示句下面那幾行**當樣板——不管它長什麼樣，照填餵解析器。這是切換前 test/pending-rulings.test.js（:182）
// 「固定標籤＋緊接的整行」的做法。正本不是平文字（註解、圍欄、引言、原始 HTML、刪除線、縮排式程式碼）＝直接紅，不剝。
// ⚠️ 證不到的：原話是不是他真的說的、署名是不是本人（本專案三方共用同一個貼文帳號）——沒有機器在看；
//    解析器對各種藏法（圍欄、註解、引用）的判斷是套件考題的射程，這裡只留一題對照範本自己寫的那句「網址寫在開頭那一段」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, deciderOf } from '../tools/pending-rulings.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');
const TEMPLATE = 'templates/ruling-record.md';
const settings = JSON.parse(read('settings.json'));
const D = /** @type {NonNullable<ReturnType<typeof deciderOf>>} */ (deciderOf(settings));

/** 佔位符（範本裡的字面）。 */
const PH = {
  date: 'YYYY-MM-DD',
  askTitle: '〈一句白話問題〉',
  title: '〈標題〉',
  decider: '〈裁示者識別值〉',
  relayer: '<轉述者識別值>',
  quote: '逐字',
  withdrawer: '〈撤回者識別值〉',
  reasons: '〈題目依附的東西沒了｜問題本身問錯了｜跟另一則 ❓ 重複〉',
  basis: '（非空的具體依據）',
  url: '〈原 ❓ 留言的網址（寫在開頭那一段）〉',
};

/**
 * 從正本抽七個樣板行——綁位置：節 → 指示句 → 指示句下面那幾行。回傳樣板文字（t）與它們的行號（at；保存題用來在正確的位置動刀）。
 * fail-closed：正本必須是平文字；三節各剛好一節；每個指示句在它那一節裡剛好一句；抽到的行佔位符剛好一個——不然直接紅。
 */
function bindTemplates(/** @type {string} */ text) {
  const src = text.replace(/\r\n?/g, '\n');
  for (const [what, re] of /** @type {[string, RegExp][]} */ ([
    ['HTML 註解', /<!--/u],
    ['圍欄', /^[ \t]*(?:`{3,}|~{3,})/mu],
    ['引言', /^[ \t]*>/mu],
    ['原始 HTML', /<[A-Za-z/!?]/u],
    ['刪除線', /~~/u],
    ['縮排式程式碼', /^(?: {4}|\t)/mu],
  ])) {
    assert.doesNotMatch(src, re, `正本 ${TEMPLATE} 出現了${what}——那一段不再是平文字，抽到的樣板可能是副本或範例，這題不剝、直接紅`);
  }
  const lines = src.split('\n');
  // 節的邊界＝二級標題，但三種留痕自己的第一行也是「## 」開頭（❓／⚖️／🚫），那些不是節
  const isBoundary = (/** @type {string} */ l) => /^## (?![❓⚖🚫])/u.test(l);
  const sectionOf = (/** @type {(l: string) => boolean} */ pick, /** @type {string} */ what) => {
    const starts = lines.map((l, i) => (isBoundary(l) && pick(l) ? i : -1)).filter((i) => i >= 0);
    assert.equal(starts.length, 1, `正本裡「${what}」這一節有 ${starts.length} 個（要剛好 1）——節名改了、或多了一份，工具與這題要一起改`);
    const next = lines.findIndex((l, i) => i > starts[0] && isBoundary(l));
    return { from: starts[0], to: next < 0 ? lines.length : next };
  };
  const anchorIn = (/** @type {{ from: number, to: number }} */ sec, /** @type {(l: string) => boolean} */ pick, /** @type {string} */ what) => {
    const hits = [];
    for (let i = sec.from; i < sec.to; i++) if (pick(lines[i])) hits.push(i);
    assert.equal(hits.length, 1, `指示句「${what}」在它那一節裡命中 ${hits.length} 處（要剛好 1）——指示句被改寫、複製或搬走了，工具與這題要一起改`);
    return hits[0];
  };
  const below = (/** @type {number} */ i, /** @type {number} */ count, /** @type {string} */ what) => {
    const out = [];
    for (let j = i + 1; j < lines.length && out.length < count; j++) if (lines[j].trim()) out.push(j);
    assert.equal(out.length, count, `指示句「${what}」下面抽不到 ${count} 行`);
    return out;
  };
  const endsWithColon = (/** @type {string} */ l) => /：[ \t]*$/u.test(l);
  const firstLine = (/** @type {string} */ l) => l.includes('第一行逐字') && endsWithColon(l);
  const askSec = sectionOf((l) => l.trim() === '## 問', '## 問');
  const ruleSec = sectionOf((l) => l.startsWith('## 裁示落地'), '## 裁示落地');
  const wdSec = sectionOf((l) => l.startsWith('## 合規撤回'), '## 合規撤回');
  const anchors = {
    ask: anchorIn(askSec, firstLine, '問：第一行逐字'),
    ruling: anchorIn(ruleSec, firstLine, '裁示：第一行逐字'),
    quote: anchorIn(ruleSec, (l) => l.startsWith('第一段逐字照下面這行填') && endsWithColon(l), '裁示：第一段逐字照下面這行填'),
    withdraw: anchorIn(wdSec, firstLine, '撤回：第一行逐字'),
    body: anchorIn(wdSec, (l) => /^內文三行都要有：[ \t]*$/u.test(l), '撤回：內文三行都要有'),
  };
  const body = below(anchors.body, 3, '撤回：內文三行都要有');
  const at = {
    ask: below(anchors.ask, 1, '問：第一行逐字')[0],
    ruling: below(anchors.ruling, 1, '裁示：第一行逐字')[0],
    quote: below(anchors.quote, 1, '裁示：第一段逐字照下面這行填')[0],
    withdraw: below(anchors.withdraw, 1, '撤回：第一行逐字')[0],
    reason: body[0],
    self: body[1],
    url: body[2],
  };
  const t = {
    ask: lines[at.ask], ruling: lines[at.ruling], quote: lines[at.quote], withdraw: lines[at.withdraw],
    reason: lines[at.reason], self: lines[at.self], url: lines[at.url],
  };
  const exactlyOne = (/** @type {string} */ line, /** @type {string} */ ph, /** @type {string} */ what) => {
    assert.equal(line.split(ph).length - 1, 1, `「${what}」指示句下面那一行的佔位符「${ph}」不是剛好一個——抽到的不是樣板、或換的位置不確定：${line}`);
  };
  exactlyOne(t.ask, PH.date, '❓ 第一行'); exactlyOne(t.ask, PH.askTitle, '❓ 第一行');
  exactlyOne(t.ruling, PH.decider, '⚖️ 第一行'); exactlyOne(t.ruling, PH.date, '⚖️ 第一行'); exactlyOne(t.ruling, PH.title, '⚖️ 第一行');
  exactlyOne(t.quote, PH.relayer, '⚖️ 原話行'); exactlyOne(t.quote, PH.quote, '⚖️ 原話行');
  exactlyOne(t.withdraw, PH.date, '🚫 第一行'); exactlyOne(t.withdraw, PH.title, '🚫 第一行');
  exactlyOne(t.reason, PH.reasons, '🚫 理由行'); exactlyOne(t.reason, PH.basis, '🚫 理由行');
  exactlyOne(t.self, PH.withdrawer, '🚫 自報句'); exactlyOne(t.self, PH.decider, '🚫 自報句');
  assert.equal(t.url.trim(), PH.url, `🚫 網址行整行就是佔位符：${t.url}`);
  return { t, at, anchors };
}

const REAL = read(TEMPLATE).replace(/\r\n?/g, '\n');
const { t: T, at: AT, anchors: ANCHORS } = bindTemplates(REAL);
const REASONS = PH.reasons.slice(1, -1).split('｜');
const DATE = '2026-09-17';
const urlOf = (/** @type {string} */ id) => `https://github.com/teacherjung/personal-finance-webapp/pull/577#issuecomment-${id}`;
let n = 0;
/** 一則留言；編號固定寬度（編號比對認前後邊界，寬度一樣才不會「5710001」撞進「57100010」）。 */
const c = (/** @type {string} */ body, over = {}) => ({
  id: `5710${String(++n).padStart(4, '0')}`,
  author: D.account,
  createdAt: new Date(Date.UTC(2026, 8, 17, 12, 0, n)).toISOString(),
  change: '577',
  body,
  ...over,
});
const ask = () => c(`${T.ask.replace(PH.date, DATE).replace(PH.askTitle, '要不要做這件事？')}\n\n選項：a／b。建議：a。類別：不屬於錢。`);
const rulingHead = (head = T.ruling) => head.replace(PH.decider, D.id).replace(PH.date, DATE).replace(PH.title, '選 a');
const quoteLineOf = (/** @type {string} */ relayer, tpl = T.quote) => tpl.replace(PH.relayer, relayer).replace(PH.quote, 'a');
const rulingBody = (/** @type {string} */ relayer, /** @type {string} */ askId, quoteLine = quoteLineOf(relayer)) =>
  `${rulingHead()}\n\n${quoteLine}\n\n原 ❓：${urlOf(askId)}\n落點：（本題無）`;
const withdrawBody = (/** @type {string} */ withdrawer, /** @type {string} */ reason, /** @type {string} */ askId) =>
  `${T.withdraw.replace(PH.date, DATE).replace(PH.title, '不用問了')}\n\n`
  + `${T.reason.replace(PH.reasons, reason).replace(PH.basis, '（#100 已經關掉）')}\n`
  + `${T.self.replace(PH.withdrawer, withdrawer).replace(PH.decider, D.id)}\n`
  + `${urlOf(askId)}`;
const whys = (/** @type {{ near: { why: string }[] }} */ r) => JSON.stringify(r.near.map((x) => x.why));

test('對照斷言：settings.json 有填好的裁示者，而且至少登記了一個別的識別值（沒有＝下面的正例迴圈是空的）', () => {
  assert.ok(D, 'settings.json 的 participants 裡沒有填好的裁示者（識別值＋貼文帳號）');
  assert.ok(D.ids.filter((x) => x !== D.id).length >= 1, '除了裁示者以外沒有登記任何識別值');
  assert.equal(REASONS.length, 3, `撤回理由的枚舉不是三個：${JSON.stringify(REASONS)}`);
});

test('❓ 照範本填＝還沒回；⚖️ 照範本填（每個登記的轉述者）＝已裁、離開待裁、不是疑似', () => {
  const q = ask();
  const alone = evaluate([q], D);
  assert.equal(alone.open.length, 1, '照範本填的 ❓ 沒被列成還沒回');
  assert.equal(alone.near.length, 0, `照範本填的 ❓ 被列成疑似：${whys(alone)}`);
  for (const relayer of D.ids) {
    const r = evaluate([q, c(rulingBody(relayer, q.id))], D);
    assert.equal(r.open.length, 0, `照範本填、轉述者「${relayer}」的裁示關不了題（範本與解析器對不上）。餵進去的是：\n${rulingBody(relayer, q.id)}\n疑似：${whys(r)}`);
    assert.equal(r.ruled.length, 1);
    assert.equal(r.near.length, 0, `關了題卻還列疑似：${whys(r)}`);
    assert.equal(r.ruled[0].ask.id, q.id);
  }
});

test('⚖️ 名單以外的轉述者、或原話行走樣＝關不了題（補集抽樣，不是「除了這些以外都收」的證明）', () => {
  const q = ask();
  for (const outsider of ['Grok', 'claude', 'William 本人', '']) {
    assert.ok(!D.ids.includes(outsider), `測試資料寫錯：「${outsider}」其實在登記名單裡`);
    assert.equal(evaluate([q, c(rulingBody(outsider, q.id))], D).open.length, 1, `「${outsider} 轉述」不在登記名單裡，不該關題`);
  }
  const who = D.ids[0];
  const good = quoteLineOf(who);
  assert.ok(T.quote.includes('**「逐字」**'), `對照斷言：原話行的引文是粗體引號包住的「逐字」，實際：${T.quote}`);
  for (const [what, line] of /** @type {[string, string][]} */ ([
    ['整行前面多一個字', `我${good}`],
    ['整行前面多一個引用符號', `> ${good}`],
    ['整行被粗體包起來', `**${good}**`],
    ['角色被粗體包起來', T.quote.replace(PH.relayer, `**${who}**`).replace(PH.quote, 'a')],
    ['角色後面多一格空白', T.quote.replace(PH.relayer, `${who} `).replace(PH.quote, 'a')],
    ['引文沒有粗體引號', T.quote.replace(PH.relayer, who).replace('**「逐字」**', 'a')],
  ])) {
    assert.equal(evaluate([q, c(rulingBody(who, q.id, line))], D).open.length, 1, `「${what}」照範本填其實關不了題，這題卻收下了：${line}`);
  }
});

test('🚫 照範本填（三種理由各一 × 每個登記的撤回者）＝已撤回，不是已裁、也不在待裁', () => {
  for (const reason of REASONS) {
    for (const withdrawer of D.ids.filter((x) => x !== D.id)) {
      const q = ask();
      const r = evaluate([q, c(withdrawBody(withdrawer, reason, q.id))], D);
      assert.equal(r.withdrawn.length, 1, `照範本填、理由「${reason}」、撤回者「${withdrawer}」的撤回沒算數。餵進去的是：\n${withdrawBody(withdrawer, reason, q.id)}\n疑似：${whys(r)}`);
      assert.equal(r.open.length, 0);
      assert.equal(r.ruled.length, 0, '撤回不是已裁');
      assert.equal(r.near.length, 0, `算數了卻還列疑似：${whys(r)}`);
    }
  }
});

test('🚫 名單以外的撤回者、理由改同義詞、依據留空＝不算數（原題仍待裁）', () => {
  const q = ask();
  const w = D.ids.find((x) => x !== D.id) ?? '';
  for (const outsider of ['Grok', 'claude', '']) {
    assert.ok(!D.ids.includes(outsider), `測試資料寫錯：「${outsider}」其實在登記名單裡`);
    assert.equal(evaluate([q, c(withdrawBody(outsider, REASONS[0], q.id))], D).open.length, 1, `「${outsider} 撤回」不在登記名單裡，不該算數`);
  }
  assert.equal(evaluate([q, c(withdrawBody(w, '題目沒了', q.id))], D).open.length, 1, '理由改成同義詞＝解析器的逐字枚舉不認');
  const empty = withdrawBody(w, REASONS[0], q.id).replace('（#100 已經關掉）', '（）');
  assert.notEqual(empty, withdrawBody(w, REASONS[0], q.id), '對照斷言：依據真的被清空了');
  assert.equal(evaluate([q, c(empty)], D).open.length, 1, '依據留空＝不算');
});

test('範本自己寫的「網址寫在開頭那一段」：網址寫在第一個引用之後＝形狀合規、但關不了題、列成疑似並說停在哪', () => {
  const q = ask();
  const body = `${rulingHead()}\n\n${quoteLineOf(D.ids[0])}\n\n> 上一輪的發現\n\n${urlOf(q.id)}`;
  const r = evaluate([q, c(body)], D);
  assert.equal(r.open.length, 1, '網址在引用之後仍關了題');
  assert.ok(r.near.some((x) => /沒有配到/u.test(x.why)), `要列成疑似並說停在哪：${whys(r)}`);
});

test('保存題：正本改字、或別處留好範例＋真正那行改壞→綁到的都是指示句下面那一行、照填關不了題；第二份指示句／第二節／不是平文字／樣板刪掉→抽樣板那步直接紅', () => {
  const L = REAL.split('\n');
  const q = ask();
  const closes = (/** @type {string} */ quoteTpl) => evaluate([q, c(`${rulingHead()}\n\n${quoteLineOf(D.ids[0], quoteTpl)}\n\n${urlOf(q.id)}`)], D).open.length === 0;
  assert.ok(closes(T.quote), '對照組：真正本照填關得了題');
  // 刀 1（Codex r1）：真正那一行改字——在它的行號上動刀，不用內容去找
  const m1 = [...L];
  m1[AT.quote] = m1[AT.quote].replace('對話中', '對話裡');
  assert.notEqual(m1[AT.quote], L[AT.quote], '對照斷言：原話行裡真的有「對話中」可改');
  assert.ok(!closes(bindTemplates(m1.join('\n')).t.quote), '範本改字後照填會關不了題（正例題就是靠這個轉紅）');
  // 刀 2（Codex r2）：前面留一段標成範例的舊好樣板、真正那一行前面加「我」——綁的必須是改壞的那一行，不是前面那份好的
  const m2 = [...L];
  m2[AT.quote] = `我${m2[AT.quote]}`;
  const decoy = `## 舊樣板範例（不是正本）\n\n${L[AT.quote]}\n\n`;
  const b2 = bindTemplates(decoy + m2.join('\n'));
  assert.ok(b2.t.quote.startsWith('我'), `綁到的要是指示句下面那一行（改壞的），不是前面的好範例：${b2.t.quote}`);
  assert.ok(!closes(b2.t.quote), '改壞的正本照填關不了題（正例題就是靠這個轉紅）');
  // 同一節裡放一份好樣板、但沒有指示句：綁的仍是指示句下面那行（改壞的）
  const m3 = [...L];
  m3[AT.quote] = `我${m3[AT.quote]}`;
  m3.splice(ANCHORS.quote, 0, '舊寫法（不是正本）：', '', L[AT.quote], '');
  assert.ok(bindTemplates(m3.join('\n')).t.quote.startsWith('我'), '節內、指示句前面的好樣板也不算正本');
  // 第二份指示句（同一節）→ 紅；第二個「## 問」節 → 紅；註解／圍欄／引言 → 紅；樣板行刪掉 → 抽到的不是樣板 → 紅；佔位符變兩個 → 紅
  const withInSection = (/** @type {string[]} */ extra) => { const m = [...L]; m.splice(AT.quote + 1, 0, '', ...extra); return m.join('\n'); };
  assert.throws(() => bindTemplates(withInSection(['第一段逐字照下面這行填（舊）：', '', L[AT.quote]])), /命中 2 處/u, '同一節裡第二個指示句 → 紅');
  assert.throws(() => bindTemplates(`## 問\n\n第一行逐字：\n\n${L[AT.ask]}\n\n${REAL}`), /「## 問」這一節有 2 個/u, '第二個「## 問」節 → 紅');
  const wrap = (/** @type {(l: string) => string} */ f) => { const m = [...L]; m[AT.quote] = f(m[AT.quote]); return m.join('\n'); };
  assert.throws(() => bindTemplates(wrap((l) => `<!-- ${l} -->`)), /HTML 註解/u, '樣板包進註解 → 紅');
  assert.throws(() => bindTemplates(wrap((l) => `\`\`\`\n${l}\n\`\`\``)), /圍欄/u, '樣板進圍欄 → 紅');
  assert.throws(() => bindTemplates(wrap((l) => `> ${l}`)), /引言/u, '樣板進引言 → 紅');
  assert.throws(() => bindTemplates(wrap(() => '')), /不是剛好一個/u, '原話行刪掉＝指示句下面抽到別的行 → 紅');
  const m4 = [...L];
  m4[AT.self] = m4[AT.self].replace(PH.withdrawer, `${PH.withdrawer}${PH.withdrawer}`);
  assert.throws(() => bindTemplates(m4.join('\n')), /不是剛好一個/u, '佔位符變兩個 → 紅');
  const m5 = [...L];
  m5[ANCHORS.quote] = '（指示句被拿掉）';
  assert.throws(() => bindTemplates(m5.join('\n')), /命中 0 處/u, '指示句拿掉 → 紅');
});
