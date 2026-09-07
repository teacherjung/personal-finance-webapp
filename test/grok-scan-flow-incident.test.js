// @ts-check
// `grok-scan.js` 主流程行為考題（同族五支之一）：收尾與事故檔：SIGTERM、活金絲雀、incident.json 的欄位白名單。
//
// ⚠️ 這一族**共用夾具**在 `test/helpers/grok-scan-flow-fixtures.js`（射程、劃界與「為什麼拆」都寫在那裡）。
// 同族的其他幾支：`grok-scan-flow-preflight.test.js`、`grok-scan-flow-credentials.test.js`、`grok-scan-flow-breach.test.js`、`grok-scan-flow-redaction.test.js`。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { redactWindow, runScan, shapeHitsIn } from '../scripts/grok-scan.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PEM_BEGIN, SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeAuth, fakeGrok, fakeRelay, isolated, isolatedRealHome, promptFile, quiet, readIncident, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);

test('runScan｜父程序收到 SIGTERM（呼叫它的工具逾時）→ 緊急收尾：grok 群組死、盒子／假值檔／活金絲雀都清掉、退 2（第五次正式掃描實際留下殘留）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'sleep 30; $1'));
  /** @type {string[]} */ const logs = [];
  /** @type {number[]} */ const exits = [];
  /**
   * 掃描進行中（金絲雀已建、還沒收）那一刻，**注入的**根目錄裡有什麼。
   * ⚠️ 少了這一格，下面「清乾淨」的斷言就是空包彈：注入沒接上時金絲雀跑去真家目錄建，
   *    隔離目錄從頭到尾是空的，斷言照樣通過。
   */
  /** @type {string[] | null} */ let livesDuring = null;
  const p = runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, {
    log: (m) => { logs.push(m); if (m.startsWith('掃描開始')) { livesDuring = readdirSync(iso.liveRoot); setTimeout(() => process.emit('SIGTERM'), 300); } },
    ...iso,
    repo: repo.dir,
    ...withGrok(inst),
    relayScript: fakeRelay('ok'),
    exit: (c) => {
      exits.push(c);
      assert.deepEqual(readdirSync(iso.resultsRoot), [], 'emergency 呼叫 exit 前還留下結果目錄');
      // ⚠️ 這一句要在**這裡**問：跑完才問的話，後面 finally 也會清一次，
      //    「emergency 自己有沒有清」就永遠問不出來（拿掉 emergency 那行、結尾的斷言仍然是綠的——實測過）。
      assert.deepEqual(readdirSync(iso.liveRoot), [], 'emergency 呼叫 exit 前還沒清活金絲雀');
    },
  });
  const r = await p;
  assert.deepEqual(exits, [2], '緊急收尾沒呼叫 exit(2)');
  assert.equal(r.code, 2);
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  assert.ok(box && !existsSync(box), '盒子沒清');
  assert.ok(!readdirSync(iso.authDir).some((n) => n.startsWith('dummy-bearer')), '假值檔沒清');
  assert.deepEqual(readdirSync(iso.resultsRoot), [], '緊急收尾還留下只有 launch.json 的結果目錄');
  assert.equal((livesDuring ?? []).filter((n) => n.startsWith('.grok-live-canary-')).length, 1, `掃描中金絲雀沒建在注入的根目錄（實際內容：${JSON.stringify(livesDuring)}）——liveRoot 沒接上，下一行的斷言會變空包彈`);
  assert.deepEqual(readdirSync(iso.liveRoot), [], '活金絲雀目錄沒清');
  const ps = execFileSync('/bin/ps', ['-axo', 'command'],
    // ⚠️ maxBuffer 要放大：平行跑的 xlsx 隔離考題會起一個命令列夾著大段 base64 的子行程，
    //    `ps -axo command` 的輸出因此可以衝破預設的 1MB ⇒ ENOBUFS ⇒ 本題間歇紅（與受測邏輯無關）。
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.ok(!ps.includes(box), 'grok 群組還活著');
});

test('runScan｜不注入 liveRoot 時，活金絲雀建在真的家目錄：掃描期間認得出本輪暗號那一個、掃完清掉', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題**刻意**讓活金絲雀落在真家目錄：金絲雀的意義就在**位置**——家目錄同時住著真 ~/.grok、
  //    ~/.grok-sandbox-auth 與真的 store.db，是破出沙箱的人第一個會翻的地方。位置只能在正式位置上考。
  //    其餘走到活金絲雀那一步的題都經 isolated() 改道到隔離根。
  //    ⚠️ 另一個會碰真家目錄的是**沙箱金絲雀**：`runCanary` 也在家目錄 mkdtemp 一個 `.grok-canary-*`，
  //    而且它的四個根寫死、沒有可注入的參數。本檔只有題名關鍵字「不注入」那一題會走到它，其餘都注入假的。
  //    ⚠️ 別在這裡寫「全檔唯一還在真家目錄建東西的題」或「每一題都會」——兩種說法都不成立。
  // ⚠️ 認身分靠**每輪隨機的暗號內容**、不數個數：別的 session／審查樹／合併閘同時在跑也認不錯。
  //    （數個數正是上一題原本的寫法，也正是本支要修掉的病。）
  // ⚠️ 暗號現在走字面比對（不編譯成正則），所以帶元字元也不會炸；randomUUID 只有十六進位與 `-`，兩種寫法都安全。
  const repo = tinyRepo();
  const liveSecret = `LIVE-CANARY-PIN-${randomUUID()}`;
  /** @type {string[]} */ let mine = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, {
    ...isolatedRealHome(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok'), liveSecret,
    log: (m) => {
      if (!m.startsWith('掃描開始')) return;   // 這一刻金絲雀一定已經建好（建立點在這行 log 之前）
      mine = readdirSync(homedir()).filter((n) => n.startsWith('.grok-live-canary-')).filter((n) => {
        try { return readFileSync(join(homedir(), n, 'store.db'), 'utf8').includes(liveSecret); }
        catch { return false; }   // 別人的金絲雀隨時可能被清掉，讀不到就跳過
      });
    },
  });
  assert.equal(r.code, 0, r.summary.join('\n'));
  assert.equal(mine.length, 1, '掃描期間在真家目錄找不到帶本輪暗號的金絲雀＝預設根目錄已經不是家目錄了（而搬走它不會有別的題轉紅）');
  assert.ok(mine[0] && !existsSync(join(homedir(), mine[0])), '掃完沒清掉真家目錄裡的金絲雀');
});

test('runScan｜Grok 掃描抓到：活金絲雀暗號只出現在 grok 的**回覆**（不在 session）→ 1、--out 不寫、sessions 不留（原本只掃 session 檔）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const liveSecret = 'LIVE-CANARY-TEST-0123456789';
  const inst = fakeGrok({ reply: `I read your store.db: ${liveSecret}` });
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok'), liveSecret });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.ok(!existsSync(out), '事故還寫了 --out');
  assert.equal(readdirSync(iso.resultsRoot).flatMap((d) => readdirSync(join(iso.resultsRoot, d))).includes('sessions'), false, '事故還保存了 sessions');
});

test('incident.json｜三族的欄位是**白名單**：DLP 與暗號族連雜湊、上下文都不可以有', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 為什麼用「鍵名白名單」而不是「值黑名單」：斷言「檔案裡沒有 sha256(REAL)」擋不住
  //    `sha256(REAL).slice(0,12)`、`base64(REAL)`、`{前四碼, 長度}` 這些同樣可反查的衍生物。
  //    DLP 針裡有低熵值（身分字串），截斷雜湊照樣查得回去，所以只能限制**能有哪些欄位**。
  const REAL = 'REAL-TOKEN-NEVER-IN-BOX-0123456789abcdef';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `leaked: ${REAL}` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const dlp = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'dlp');
  assert.ok(dlp.length >= 1, '沒有 dlp 族的命中——這一題量不到東西');
  for (const h of dlp) assert.deepEqual(Object.keys(h).sort(), ['family', 'len', 'where'], 'DLP 族多了不該有的欄位（雜湊／上下文都算）');
  assert.equal(raw.includes(REAL), false, '指紋包裡有真 token 原文');
});

test('incident.json｜形狀族要留得下判得出真假的東西：雜湊、字元組成、最近似排除項、遮蔽過的上下文', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const BODY = 'MIIEPLANTEDBODY' + 'W'.repeat(50);
  const planted = `${PEM_BEGIN('RSA')}\n${BODY}\n`;
  const repo = tinyRepo(); const iso = isolated();
  const replyText = `我編的示範：${planted}以上是示範`;
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: replyText })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const shape = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'shape');
  assert.equal(shape.length, 1, `形狀族命中數不對：${JSON.stringify(json.hits.map((/** @type {{family:string}} */ h) => h.family))}`);
  const h = shape[0];
  assert.equal(h.where, 'reply');
  // 期望值由考題自己算（拿實作的輸出回填就變成自證）；要對**回覆那份文字**算，
  // 因為私鑰那條腿的字元類含空白，命中會吃到 planted 後面緊接的空白為止。
  const expected = shapeHitsIn(replyText)[0];
  assert.ok(expected, '夾具沒產生命中');
  assert.equal(h.len, expected.length, '長度不是這條命中的');
  assert.equal(h.sha256, createHash('sha256').update(expected).digest('hex'), '雜湊不是這條命中的');
  assert.ok(h.profile.maxB64Run >= 50, `字元組成沒認出 base64 body：${JSON.stringify(h.profile)}`);
  assert.equal(typeof h.nearest.prefixLen, 'number');
  // 上下文：命中本身換成佔位符、周圍的字要在（那正是判「這是它編的示範」的依據）
  assert.equal(h.context.includes(BODY), false, '上下文把命中內容也寫進去了');
  assert.ok(h.context.includes('‹命中'), '上下文沒有佔位符');
  assert.ok(h.context.includes('我編的示範') && h.context.includes('以上是示範'), '上下文沒帶到周圍的字＝判不出真假');
  assert.equal(raw.includes(BODY), false, '指紋包裡有命中內容');
});

test('incident.json｜同一次掃描兩族都中刀時，族別不可以被標成同一種', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 沒有這一題，「照第一個中刀的族別標全部」與「只要有形狀命中就全部加雜湊」兩種突變都會過。
  const REAL = 'REAL-TOKEN-NEVER-IN-BOX-0123456789abcdef';
  const planted = `${PEM_BEGIN('EC')}\nMIIEBOTHFAMILIES${'Q'.repeat(50)}\n`;
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `${REAL} 與 ${planted}` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json } = readIncident(iso.resultsRoot);
  const fams = new Set(json.hits.map((/** @type {{family: string}} */ h) => h.family));
  assert.ok(fams.has('dlp') && fams.has('shape'), `兩族沒有各自標到：${[...fams].join('、')}`);
  for (const h of json.hits.filter((/** @type {{family: string}} */ x) => x.family === 'dlp')) assert.deepEqual(Object.keys(h).sort(), ['family', 'len', 'where']);
  for (const h of json.hits.filter((/** @type {{family: string}} */ x) => x.family === 'shape')) assert.ok(h.sha256 && h.context, '形狀族少了判定要用的欄位');
});

test('incident.json｜暗號族：欄位白名單、charOffset 是真的字元位置、整包不留任何可查表的衍生物', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題補的是 r1 抓到的假綠：原本只有 dlp 族有白名單，暗號族沒有
  //    ⇒ 幫暗號族加上 sha256(liveSecret) 的突變當時 4 題全綠。
  //    而且約束要套到**整包**，不是只套在 hits[]：頂層的 replySha256、sessionFiles[].sha256、
  //    被遮蔽的 where，任何一格留下可查表的衍生物都算破口。
  const SECRET = 'LIVE-CANARY-OFFSET-0123456789';
  const repo = tinyRepo(); const iso = isolated();
  // 暗號出現兩次，且第一次不在開頭——序號（0、1）與真位置就分得出來了
  const inst = fakeGrok({ reply: `前面墊一段話讓位置不是零。${SECRET} 中間 ${SECRET} 結束` });
  // 再讓 Grok 用**暗號當檔名**建一個 session 檔（內容也放暗號，才會走到那兩條事故訊息）：
  // 那條路徑會被回聲進 summary＝**公開的** PR 描述，所以 summary 與 incident 兩個輸出面都要斷言。
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf '${SECRET}\n' > "$ws/fake-session/${SECRET}.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok'), liveSecret: SECRET });
  assert.equal(r.code, 1, r.summary.join('\n'));
  // ⚠️ summary 會被抄進公開的 PR 描述——受控路徑在這裡回聲，遮了 incident 也沒用
  assert.equal(r.summary.join('\n').includes(SECRET), false, '公開摘要回聲了受控路徑裡的暗號');
  const { json, raw } = readIncident(iso.resultsRoot);
  const live = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'live');
  assert.ok(live.length >= 2, `暗號族命中數不對：${JSON.stringify(json.hits.map((/** @type {{family:string}} */ h) => h.family))}`);
  for (const h of live) assert.deepEqual(Object.keys(h).sort(), ['charOffset', 'family', 'len', 'where'], '暗號族多了不該有的欄位');
  assert.ok(live[0].charOffset > 0, `charOffset 是陣列序號不是字元位置：${live[0].charOffset}`);
  assert.notEqual(live[0].charOffset, live[1].charOffset, '兩次命中的位置一樣＝記的不是位置');
  // 整包：值本身、完整雜湊、截斷雜湊都不可以出現
  const full = createHash('sha256').update(SECRET).digest('hex');
  assert.equal(raw.includes(SECRET), false, '指紋包裡有暗號原文');
  assert.equal(raw.includes(full), false, '指紋包裡有暗號的完整雜湊');
  assert.equal(raw.includes(full.slice(0, 12)), false, '指紋包裡有暗號的截斷雜湊（一樣可查表）');
  assert.equal(json.replySha256, null, '回覆裡有已知機密，雜湊還是寫了');
  // 路徑那一格：遮蔽後的字串必須**就只有**記號與長度。
  // ⚠️ 不能靠上面那幾條「暗號的雜湊不出現」來守它——redactPath 雜湊的是**路徑**、不是暗號，
  //    兩者的 SHA 不一樣，那幾條斷言對這一格完全沒有射程（我第一版就是這樣守錯的）。
  //    路徑短、熵低，截斷雜湊對一個已知候選清單就是可查表的，所以只准留長度。
  const masked = json.sessionFiles.filter((/** @type {{rp: string}} */ f) => f.rp.startsWith('‹路徑已遮蔽'));
  assert.equal(masked.length, 1, `含暗號的路徑沒有被遮：${JSON.stringify(json.sessionFiles.map((/** @type {{rp:string}} */ f) => f.rp))}`);
  assert.match(masked[0].rp, /^‹路徑已遮蔽，長 \d+›$/, '遮蔽後的路徑帶了長度以外的東西（雜湊也算）');
});

test('incident.json｜兩條形狀命中靠在一起時，不可以透過彼此的上下文把對方原文帶出去', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ r1 抓到：redactWindow 原本只挖掉「自己那一條」，於是 A 的視窗完整包含 B、B 的視窗完整包含 A。
  //    原本的形狀族考題只有單一命中，所以量不到。
  const A = 'MIIEFIRSTHIT' + 'A'.repeat(50);
  const B = 'MIIESECONDHIT' + 'B'.repeat(50);
  const both = `${PEM_BEGIN('RSA')}\n${A}\n!間隔!${PEM_BEGIN('EC')}\n${B}\n`;
  const repo = tinyRepo(); const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: both })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const shape = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'shape');
  assert.equal(shape.length, 2, `這一題要兩條命中才量得到東西，實際 ${shape.length} 條`);
  assert.ok(shape.every((/** @type {{context: string}} */ h) => h.context.includes('‹另一條命中')), '視窗沒有遮掉另一條命中');
  assert.equal(raw.includes(A), false, '第一條命中的內容被另一條的上下文帶出去了');
  assert.equal(raw.includes(B), false, '第二條命中的內容被另一條的上下文帶出去了');
});

test('redactWindow｜壓在視窗邊界上的東西**連半截都不准留**（純函式，平台無關，CI 也跑）', () => {
  // ⚠️ r1 抓到「先切後替換會留半截」，我改成往外加寬——r2 證明那只是**把邊界往外移**：
  //    新邊界上照樣切得到半截。所以改成在原文上算區間、凡與視窗相交就整段換掉。
  //    這一題要守的是「半截」，不是「完整原文」——只斷言完整原文不出現，加寬版也會過。
  {
    const secret = 'BOUNDARY-SECRET-VALUE';
    const text = `${'x'.repeat(30)}${secret}${'y'.repeat(20)}HITHITHIT尾巴`;
    const w = redactWindow(text, text.indexOf('HITHITHIT'), 9, [secret], 25);   // span 25 ⇒ secret 壓在邊界
    assert.equal(w.includes(secret), false, '跨邊界的已知機密沒被遮掉');
    // 半截：任何長度 8 以上的連續片段都不准出現在視窗裡
    for (let i = 0; i + 8 <= secret.length; i++) assert.equal(w.includes(secret.slice(i, i + 8)), false, `視窗裡留下了機密的半截：位移 ${i}`);
    assert.ok(w.includes('‹已遮蔽›'), '沒有遮蔽記號＝根本沒切到那一段');
  }
  {
    // 長形狀命中跨過視窗外邊界：目標命中的視窗不可以帶出它的尾巴
    const longBody = 'MIIELONGONE' + 'A'.repeat(280);
    const longHit = `${PEM_BEGIN('RSA')}\n${longBody}\n`;
    const target = `${PEM_BEGIN('EC')}\nMIIETARGET${'B'.repeat(60)}\n`;
    const text = `${longHit}!間隔!${target}尾巴`;
    const idx = text.indexOf(PEM_BEGIN('EC'));
    const w = redactWindow(text, idx, shapeHitsIn(target)[0].length, [], 40);   // span 40 ⇒ 長命中橫跨外邊界
    assert.equal(w.includes('A'.repeat(20)), false, '長命中的尾巴被帶進視窗了');
    assert.ok(w.includes('‹另一條命中'), '相交的另一條命中沒有被整段換掉');
  }
});
