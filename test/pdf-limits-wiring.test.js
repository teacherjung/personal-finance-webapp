// @ts-check
// 「牆蓋在路上了嗎」——PDF 資源上限與 HOSTED 連線逾時的**接線**考題（2026-07-28）。
//
// 病根（Codex 收官審查 #8）：這兩道牆本身都有考題，但**兩道的接線都沒有任何考題**——
//   ・PDF 上限：`test/parse-limits.test.js` 只直接呼叫 `assertPageLimit`／`countTextItems`
//     驗常數與訊息措辭，另加一題用**原始碼 regex** 檢查 `task.destroy()` 在 finally 裡。
//     全 repo 沒有任何一支測試餵過真的 PDF 位元組（`grep getDocument test/` 零命中）。
//     → 把三個抽取器裡的呼叫**刪掉**，`npm test` 照樣全綠。
//   ・HOSTED 逾時：只對一個假物件直接呼叫 `applyHostedTimeouts`，證明得了「helper 會賦值」，
//     證明不了「server 有呼叫 helper」。→ 把 `server.js` 那一行刪掉，照樣全綠。
//
// 這是這個 repo 反覆吃虧的同一個病：**純函式考題證明得了「牆蓋得對」，證明不了「牆蓋在路上」。**
//
// ⚠️ PDF 一向沒有考題是因為「要真 PDF、而且不進版控」。這裡改成**手工造最小合法 PDF**——
//    500 bytes 就是一頁，250 頁也才 50KB，完全不需要把二進位檔簽進 repo，
//    而且「怎麼造」本身就是下次改抽取器時最有用的工具。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MAX_PDF_PAGES } from '../lib/parse-limits.js';

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ **絕不可以把 STORE_FILE 指到 repo 的 data/**：LOCAL 模式真的會在那裡建 SQLite 檔，
//    等於考題污染使用者的資料夾（第一版就是這樣寫的，跑過一次才發現）。一律用暫存目錄。
const TMP = mkdtempSync(join(tmpdir(), 'finance-wiring-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * 拿一個**確定空著**的埠。
 *
 * ⚠️ 不可以用 `PORT=0` 讓 OS 配（我第一版就是這樣寫的，而且 CI 上一直是綠的）：
 *    `server.js` 是 `Number(process.env.PORT) || 4321`——**`Number('0')` 是 0、falsy**，
 *    於是退回 4321，撞上開發者本機正在跑的伺服器（`EADDRINUSE`）。
 *    CI 上沒人佔 4321，所以這個 bug 只在**開發者自己的機器上**炸，
 *    而那正是最容易被當成「環境怪怪的」而忽略的地方。
 * @returns {Promise<number>}
 */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = /** @type {any} */ (s.address()).port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * 把 server 當**主程式**起來，讀到啟動訊息就收工。
 * 用 spawn 而不是 spawnSync：server 起來之後不會自己結束，spawnSync 只能等到逾時
 *（實測每題白等 8 秒）。這裡改成「看到 ✅ 或超過 12 秒就殺掉」。
 * @param {Record<string,string>} env @returns {Promise<string>}
 */
function startServer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const done = () => { try { child.kill('SIGKILL'); } catch { /* 已經死了 */ } resolve(out); };
    const timer = setTimeout(done, 12_000);
    const onData = (/** @type {Buffer} */ b) => {
      out += b.toString();
      // 啟動訊息印完（LOCAL 印「按 Ctrl+C」、HOSTED 多印一行逾時）就不必再等
      if (/按 Ctrl\+C/.test(out) && (!env.NOTEASY_HOSTED || /連線逾時/.test(out))) { clearTimeout(timer); done(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
  });
}

/**
 * 手工造一份**最小的合法 PDF**，指定頁數。
 * 每頁共用同一個內容串流（`3 0 obj`），所以 250 頁也只有 50KB——
 * 這正是「檔案小不代表解析便宜」的具體例子，也是這道牆存在的理由。
 * @param {number} pages
 */
function makePdf(pages) {
  /** @type {string[]} */
  const objs = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i} 0 R`);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count ${pages} /Kids [${kids.join(' ')}] >>`;
  objs[3] = '<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 720 Td (hello world) Tj ET\nendstream';
  for (let i = 0; i < pages; i++) {
    objs[4 + i] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R '
      + '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>';
  }
  let out = '%PDF-1.4\n';
  /** @type {number[]} */
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** 三個抽取器都要驗——只修一個、漏兩個是這個 repo 出現過的事（`assertXmlRowLimits` 漏 OpenPosition）。 */
const EXTRACTORS = [
  ['信用卡帳單', async () => (await import('../lib/statement.js')).parseStatement],
  ['銀行對帳單', async () => (await import('../lib/bank-statement.js')).parseBankStatement],
  // ⚠️ 證券那支吃 PDF 的是 `parseTaishinSecuritiesPdf`；`parseTaishinSecurities` 吃的是已經抽好的行
  ['證券對帳單', async () => (await import('../lib/taishin-securities.js')).parseTaishinSecuritiesPdf],
];

// ============================================================================
// 一、PDF 頁數上限：真的餵 PDF 位元組進去
// ============================================================================

test('三個抽取器都擋得住「頁數超標」的真 PDF（接線被拆掉就會紅）', async () => {
  const tooMany = makePdf(MAX_PDF_PAGES + 50);
  assert.ok(tooMany.length < 120 * 1024,
    `攻擊檔要小得可笑才有說服力（實際 ${Math.round(tooMany.length / 1024)}KB）——這就是「檔案大小擋不到」的意思`);

  for (const [what, load] of EXTRACTORS) {
    const parse = await load();
    const err = await /** @type {any} */ (parse)(tooMany).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, `${what}：${MAX_PDF_PAGES + 50} 頁的 PDF 竟然通過了——頁數上限沒接在這條路上`);
    assert.match(String(err.message), /頁/, `${what}：擋下來了，但不是頁數上限擋的（${err.message}）`);
    assert.equal(err.status, 400, `${what}：要回 400（使用者層錯誤），不是 500`);
  }
});

test('正常頁數的 PDF 不會被頁數上限擋掉（防止把牆訂到誤殺）', async () => {
  // 真實帳單 2–15 頁。這份 3 頁的 PDF 沒有消費明細，所以會因為「找不到明細」失敗——
  // 那是對的；重點是**不可以因為頁數被擋**。
  const normal = makePdf(3);
  for (const [what, load] of EXTRACTORS) {
    const parse = await load();
    const err = await /** @type {any} */ (parse)(normal).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(!err || !/頁數|頁/.test(String(err.message)),
      `${what}：3 頁的正常 PDF 被頁數上限擋了——門檻訂太緊（${err?.message}）`);
  }
});

test('畸形 PDF（開檔階段就失敗）三個抽取器都給得出可讀訊息，而且不洩漏堆疊', async () => {
  const junk = new Uint8Array([0x25, 0x50, 0x44, 0x46]);   // 只有 "%PDF" 四個位元組
  for (const [what, load] of EXTRACTORS) {
    const parse = await load();
    const err = await /** @type {any} */ (parse)(junk).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, `${what}：畸形 PDF 應該失敗`);
    assert.equal(err.status, 400, `${what}：畸形輸入是使用者層錯誤`);
    assert.ok(!/\/Users\/|node_modules|at Object\./.test(String(err.message)),
      `${what}：錯誤訊息洩漏了伺服器路徑或堆疊：${err.message}`);
  }
});

// ============================================================================
// 二、HOSTED 連線逾時：證明「server 有呼叫 helper」，不是「helper 會賦值」
// ============================================================================

test('HOSTED 啟動時真的把連線逾時套到 server 上（把 server.js 那一行刪掉就會紅）', async () => {
  // ⚠️ 這一題**一定要真的把 server 當主程式啟動**。舊考題對一個假物件呼叫 helper，
  //    所以 `server.js` 的接線刪掉也不會紅——那正是 Codex #8 指出來的假考題。
  const out = await startServer({
    NOTEASY_HOSTED: '1',
    PORT: String(await freePort()),              // ⚠️ 不可以用 '0'：Number('0') 是 falsy，會退回 4321
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SITE_ORIGIN: 'https://example.com',
    NOTEASY_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'),
    STORE_FILE: join(TMP, 'hosted.db'),
  });
  assert.match(out, /連線逾時（HOSTED）/,
    `HOSTED 啟動後沒有印出實際套用的連線逾時——代表 applyHostedTimeouts 沒被呼叫。\n輸出：\n${out.slice(0, 600)}`);
  // 而且值要合理（防止有人把 helper 改成賦 0 ＝等於關掉逾時）
  const m = out.match(/headers (\d+)ms／request (\d+)ms／keepAlive (\d+)ms/);
  assert.ok(m, `逾時那一行的格式對不上：${out.slice(0, 600)}`);
  assert.ok(Number(m[1]) > 0 && Number(m[2]) >= 60_000 && Number(m[3]) > 0,
    `套用的逾時值不合理（headers=${m[1]} request=${m[2]} keepAlive=${m[3]}）——`
    + 'requestTimeout 低於 60 秒會誤殺「上傳大備份」那條路');
});

test('LOCAL 啟動不套 HOSTED 逾時（零改動契約），啟動訊息也維持原樣', async () => {
  const out = await startServer({ NOTEASY_HOSTED: '', PORT: String(await freePort()), STORE_FILE: join(TMP, 'local.db') });
  assert.doesNotMatch(out, /連線逾時（HOSTED）/, 'LOCAL 不該套 HOSTED 的連線逾時');
  assert.match(out, /資料只存在本機/, 'LOCAL 的啟動訊息維持原樣（零改動契約）');
});
