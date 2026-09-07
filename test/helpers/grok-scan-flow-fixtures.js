// @ts-check
// `grok-scan.js` 主流程那一族行為考題**共用的夾具**（2026-09-08 從 test/grok-scan-flow.test.js 抽出來）。
//
// 為什麼要拆：原本 84 題全擠在一支檔案裡，而 `node --test` 是**一個檔案一個子行程**——
// 那一支自己就跑掉整卷一大半的牆上時間，而且沒有辦法平行。拆成同族五支之後，
// 它們可以同時跑（實測數字寫在拆分那支 PR 的說明裡；這裡不寫數字，數字會漂）。
// 拆的只有「題目住在哪一個檔案」：**沒有任何一題的內容被改動**。
//
// 原始檔頭的說明（照抄，射程沒變）：
// grok-scan.js 主流程的行為考題（2026-08-22，Codex #496 r1：「沒有任何考題執行 grok-scan.js 的控制流，只有路徑字串」）。
//
// 用假的 grok／轉送器／session 根目錄跑 runScan()，考每一條 fail-closed 路徑**真的退 2**，
// 而不是像第一版那樣：Grok 沒跑、轉送器中途死、零 session——全部退 0。
//
// ⚠️ 誠實劃界：
// ・非 macOS 上，沙箱套不上 ⇒ **`--version` 檢查**（它在沙箱裡跑、位置在金絲雀之前）就會先停下來；
//   有 SANDBOX_OK guard 的題直接 skip，沒有 guard 的路徑則停在那一關。所以「沙箱之前」的路徑
//   （寫死 SHA、指示檔、破口已知來源）在 CI 也考得到；之後的路徑只在 macOS 考得到。
// ・假 grok 不會真的連 xAI；它只回一段字。考的是主流程怎麼對待它的退出碼與輸出，不是掃描品質。
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EXPECTED_GROK_VERSION } from '../../scripts/grok-scan.js';
import { canApplySandbox, BOX_ROOT } from '../../scripts/grok-sandbox-canary.js';
import { createHash } from 'node:crypto';
import { PINNED_ISSUER, PINNED_CLIENT_ID } from '../../scripts/grok-auth-refresh.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');   // 本檔在 test/helpers/ ⇒ 要往上兩層才是 repo 根
export const SANDBOX_OK = (() => { const d = mkdtempSync(join(BOX_ROOT, 'grok-flow-cap-')); try { return canApplySandbox(d).ok; } finally { rmSync(d, { recursive: true, force: true }); } })();
export const SKIP_AFTER_CANARY = '金絲雀之後的路徑只在套得上沙箱的 macOS 考得到（這台套不上；金絲雀自己會退 2＝fail-closed）';

/** 沙盒專用環境：**從零組**，不是從 process.env 扣（鐵則 11；Codex r2 抓到 r1 版是 `{...process.env, GIT_DIR: undefined}`——
 *  從 linked worktree 的 pre-push 跑時會把 GIT_WORK_TREE／GIT_CONFIG_* 整族帶進 `git init`，正是 AGENTS 記載過把共用 config 寫成 bare 的事故形狀）。 */
export const CLEAN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' };
export const EXPECTED_BOX_AUTH_FIELDS = ['auth_mode', 'create_time', 'expires_at', 'key', 'oidc_client_id', 'oidc_issuer', 'user_id'];

/**
 * 破口形狀的標頭：**執行時才拼**，本檔源碼裡不留 `-----BEGIN <KIND> PRIVATE KEY-----` 的字面。
 *
 * 為什麼（#516／#530 兩支的複審後掃都判事故、都靠 William 裁示「視為誤判」才放行）：
 * ⚠️ 分兩層講，別混在一起：**這一類**假事故的成因清楚——字面材料被引用時換了呈現、逐字對不上；
 *   但 **#530 那一次具體那 36 條命中是什麼**至今未定（現場被護欄自己刪掉：退 1 不留 sessions）。
 *   本 helper 收的是前者。
 *   本檔是破口偵測器自己的考題檔，裡面的假鑰跟真鑰匙同形。字面留在檔裡，Grok 每次讀／引用本檔
 *   都可能把它帶進日誌；引用時只要換了呈現，逐字對不上就判事故。
 *   往「放寬比對」修的代價實測是排除語言從 12 條字串脹成 598 條，而最短的合法前綴只有 58 個字元、
 *   其中可以一個酬載字元都沒有（`{32,}` 的字元類含空白與反斜線＝長度下限、不是熵下限）。
 *   往這裡修則是讓爭議在源頭消失，判準一個字元都不用放寬。
 * ⚠️ 誠實劃界（兩條）：
 *   ①這只讓**源碼本身**不含命中。考題**執行後**的值若進了日誌仍會判事故——那條路本來就該判事故，
 *     本 helper 不宣稱修得掉它。
 *   ②`-----END …-----` 不經這裡：現行 BREACH_SHAPES 只從 `BEGIN` 起錨，留字面不會造出命中。
 *     這是照現行正則讀出來的，**沒有考題撐著**；正則的起錨點若改，這裡要一起重看。
 * @param {'RSA'|'OPENSSH'|'EC'|'DSA'} kind
 */
export const PEM_BEGIN = (kind) => `-----BEGIN ${kind} PRIVATE KEY-----`;

/** 一個最小的真 git repo（有一顆 commit），當 runScan 的 repo。 */
export function tinyRepo(/** @type {{ firstCommitFiles?: Record<string, string> }} */ o = {}) {
  const d = keep(mkdtempSync(join(tmpdir(), 'grok-flow-repo-')));
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', env: CLEAN_ENV });
  git(['init', '-q']);
  writeFileSync(join(d, 'a.txt'), 'hello\n');
  writeFileSync(join(d, 'tree-only.txt'), 'TREE-ONLY-PUBLIC-VALUE\n');   // 兩顆 commit 都有、不在 diff 裡＝只在樹裡
  mkdirSync(join(d, 'node_modules', 'eslint'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'eslint', 'package.json'), '{}');
  // firstCommitFiles：進**第一顆 commit**＝在 base 之前 ⇒ 在 head 樹裡、不在 base..head 的 diff 裡。
  // 預設不傳：把鑰匙形狀塞進共用夾具會讓每一題的樹都帶著它，反而遮蔽別的題。
  for (const [name, body] of Object.entries(o.firstCommitFiles ?? {})) { mkdirSync(dirname(join(d, name)), { recursive: true }); writeFileSync(join(d, name), body); }   // 可放巢狀路徑（如 data/store.db）
  git(['add', 'a.txt', 'tree-only.txt', ...Object.keys(o.firstCommitFiles ?? {})]);
  git(['commit', '-q', '-m', 'one']);
  const head = git(['rev-parse', 'HEAD']).trim();
  writeFileSync(join(d, 'a.txt'), 'hello world\n');
  git(['commit', '-q', '-am', 'two']);
  const head2 = git(['rev-parse', 'HEAD']).trim();
  return { dir: d, base: head, head: head2 };
}

/**
 * 假的 grok **安裝樹**（GROK_INSTALL）：bin/grok 是一支 shell script（--version 回指定版本，-p 時照指定退出碼與輸出）。
 * runScan 會把它 APFS clone 進盒子當 GROK_HOME。放在 GROK_INSTALL 是因為沙箱只放行那裡（唯讀）——
 * 假 grok 放在 tmpdir() 會被沙箱正確擋住（126），那是沙箱做對，不是考題該繞的。
 * 預設寫一個會把 session 日誌寫進 $GROK_HOME/sessions/ 的假 grok（驗屍要讀得到）。
 */
/**
 * 假的 grok 執行檔。
 * ⚠️ `reply` 是塞進 shell 的**雙引號字串**裡的，所以 `"`／`\`／`$`／`` ` `` 一律要跳脫——
 *   原本只跳脫單引號，於是帶 `"` 的回覆會被 shell 切成好幾個字、`printf '%s'` 只印第一個。
 *   那是**靜靜壞掉**：考題照樣綠，但它根本沒測到想測的東西（2026-09-01 寫「命中含機密」那題時踩到）。
 */
export function fakeGrok(/** @type {{ version?: string, status?: number, reply?: string, noSession?: boolean, noToolFootprint?: boolean }} */ o = {}) {
  const d = keep(mkdtempSync(join(tmpdir(), 'fake-grok-install-')));
  mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions')); writeFileSync(join(d, 'config.toml'), ''); writeFileSync(join(d, 'auth.json'), fakeAuth());
  const p = join(d, 'bin', 'grok');
  const session = o.noSession ? '' : `
ws="$GROK_HOME/sessions/$(printf '%s' "$PWD" | /usr/bin/sed 's|/|%2F|g')"; mkdir -p "$ws/fake-session" && printf '${o.noToolFootprint ? '{"type":"assistant","content":"x"}' : '{"type":"tool_started","tool_name":"run_terminal_command"}'}\n' > "$ws/fake-session/updates.jsonl"`;
  writeFileSync(p, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok ${o.version ?? EXPECTED_GROK_VERSION} (fake)"; exit 0; fi${session}
printf '%s' "${(o.reply ?? 'FAKE-REPLY').replace(/["\\$`]/g, '\\$&')}" # REPLY-LINE
exit ${o.status ?? 0}
`);
  chmodSync(p, 0o755);
  return d;   // 回傳 GROK_INSTALL，不是執行檔
}

/** 假轉送器：印 READY 然後活著；或照指定行為死掉。 */
export function fakeRelay(/** @type {'ok' | 'die-before-ready' | 'die-after-ready'} */ mode = 'ok') {
  const d = keep(mkdtempSync(join(tmpdir(), 'fake-relay-')));
  const p = join(d, 'relay.js');
  writeFileSync(p, mode === 'die-before-ready' ? 'process.exit(1);'
    : mode === 'die-after-ready' ? "process.stdout.write('READY 1\\n'); setTimeout(() => process.exit(1), 200);"
    : "process.stdout.write('READY 1\\n'); setInterval(() => {}, 1000);");
  return p;
}

/** @param {string} [extra] 附加到指示檔內容後面；指示檔會進 materials，**永遠不會進受掃樹**——要單獨考「材料那條路」就靠它 */
export function promptFile(extra) { const d = keep(mkdtempSync(join(tmpdir(), 'fake-prompt-'))); const p = join(d, 'p.txt'); writeFileSync(p, '【界線】測試用\n' + (extra ?? '')); return p; }
/**
 * isolated() 建過的暫存根，跑完整支考題檔一起清。
 * ⚠️ **這三個根本身 `runScan` 不會刪**（它只清自己在根底下建的東西；盒子根本不住這裡，是在 BOX_ROOT）——
 *    根是考題建的、要考題自己收。沒有這個 hook，每呼叫一次 isolated() 就在使用者暫存區多留三個目錄，
 *    而且走得夠遠的題還會**留著內容**：`fake-auth-` 的假 auth.json、`fake-results-` 的整包結果（launch.json＋sessions）；
 *    早早退場的題（例如 base／head 不是寫死 SHA 那題）則三個都還是空的。
 *    （Codex #516 r1 抓到我新加的 `fake-live-` 那一族；`fake-auth-`／`fake-results-` 兩族是既有的，
 *    同一個 helper 建的、沒有道理分開清。）
 */
export const TEMP_ROOTS = /** @type {string[]} */ ([]);
export const keep = (/** @type {string} */ dir) => { TEMP_ROOTS.push(dir); return dir; };
/** 這一族的每一支考題檔都要 `after(cleanupTempRoots)`：暫存目錄由 `keep()` 登記在本模組，
 *  而 `node --test` 每個檔案各跑一個子行程 ⇒ 每支各自持有一份 TEMP_ROOTS，互不干擾。 */
/** 讀事故指紋包（`incident` 與 `redaction` 兩支都用到，所以住在共用夾具）；沒有就直接讓題目說清楚；沒有就直接讓題目說清楚（不要在後面才 undefined 爆掉） */
export const readIncident = (/** @type {string} */ resultsRoot) => {
  const dirs = readdirSync(resultsRoot);
  assert.equal(dirs.length, 1, `結果根應該只有一個事故包，實際 ${dirs.length} 個`);
  const p = join(resultsRoot, dirs[0], 'incident.json');
  assert.ok(existsSync(p), '事故沒有留下 incident.json——證據又沒了');
  return { dir: join(resultsRoot, dirs[0]), json: JSON.parse(readFileSync(p, 'utf8')), raw: readFileSync(p, 'utf8') };
};

export function cleanupTempRoots() {
  for (const d of TEMP_ROOTS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 盡力 */ } }
}

/**
 * 假的第②步金絲雀：流程考題只需要「它回什麼、runScan 就怎麼反應」。
 * 為什麼非換掉不可：真的那一支是**全機共用資源的使用者**（搶系統唯一那份剪貼簿、在幾個共用位置開誘餌目錄）。
 * ⚠️ 規格與代價（秒數、探針數、位置清單）只寫在 `scripts/grok-scan.js` 的 `runCanary` 那格 JSDoc——
 *   這裡刻意不複述：同一組會漂的數字有兩個家，日後一定只改到一邊。
 * ⚠️ 沙箱**是不是真的有效**由題名關鍵字「金絲雀」那一族在 `test/grok-sandbox.test.js` 證明，不是本檔——
 *   本檔用假的 ⇒ 這裡不對沙箱有效性提供任何證據，那是刻意的分工。
 * @param {0|1|2} [code]
 * @param {string[]} [lines] 有題把「金絲雀印出第一行」當時序鉤子，那種題就地傳自己要的行，別讓預設值偷偷去滿足它
 */
export const fakeCanary = (code = 0, lines = [`（假金絲雀：code ${code}）`]) => async () => ({ code, lines });
/**
 * 每題獨立的沙箱 auth 目錄、結果根與活金絲雀根（絕不碰真的 ~/.grok-sandbox-auth／~/.grok-scan-results／家目錄），
 * **並注入上面那個假金絲雀**——所以凡是用 `isolated()` 的題都走不到真的第②步；要考「不注入時走哪一支」，
 * 得自己把 `runCanary` 這一格拿掉（見題名關鍵字「不注入」那題）。
 * `liveRoot` 是 2026-08-26 加的：正式路徑的金絲雀住**真家目錄**，而家目錄是**跨程序共用**的——
 * 另一個 session、審查樹、合併閘同時跑考題時，在那裡數 `.grok-live-canary-*` 會互相誤紅。
 */
export const isolated = () => ({ runCanary: fakeCanary(), authDir: keep(mkdtempSync(join(tmpdir(), 'fake-auth-'))), resultsRoot: keep(mkdtempSync(join(tmpdir(), 'fake-results-'))), liveRoot: keep(mkdtempSync(join(tmpdir(), 'fake-live-'))), fetchImpl: noFetch });
/**
 * 同 isolated()，但**刻意不給 liveRoot**——要考「預設落在真家目錄」就只能走預設那條路。
 * 寫成覆蓋為 undefined（不是 delete）：isolated() 日後多欄位會自動跟上；而欄位若被改名，
 * 這裡蓋到的是舊名、新名照樣流進去 ⇒ `test/grok-scan-flow-incident.test.js` 裡那題（題名含「不注入 liveRoot」）
 * 會直接紅，不會靜靜放行。⚠️ 這裡刻意**不用**題名關鍵字的路標形狀：那個形狀只在**同一支檔案**裡找目標，
 * 拆檔之後目標在別支 ⇒ 寫成路標反而會被判成「指不到東西」（#581 r1 P2）。
 */
export const isolatedRealHome = () => ({ ...isolated(), liveRoot: undefined });
/** 假 grok 的 sha256（r4：runScan 對盒內副本驗 hash；考題要把假 grok 自己的 hash 傳進去） */
export const shaOf = (/** @type {string} */ installDir) => createHash('sha256').update(readFileSync(join(installDir, 'bin', 'grok'))).digest('hex');
export const quiet = { log: () => {} };
/**
 * 假的 OIDC auth.json（跟真的同形：issuer／client_id／refresh_token／expires_at／key／user_id／create_time＋身分欄位）。
 * 預設到期在一天後＝不會觸發 refresh。email／first_name 是「沒給盒子」的欄位（r6：DLP 針；first_name 刻意放材料裡有的字）。
 */
export const fakeAuth = (/** @type {{ key?: string, refresh?: string, expiresInMs?: number, issuer?: string, clientId?: string, extra?: Record<string, unknown> }} */ o = {}) => JSON.stringify({
  [`${o.issuer ?? PINNED_ISSUER}::${o.clientId ?? PINNED_CLIENT_ID}`]: {
    oidc_issuer: o.issuer ?? PINNED_ISSUER, oidc_client_id: o.clientId ?? PINNED_CLIENT_ID,
    key: o.key ?? 'ACCESS-TOKEN-VALUE-0123456789abcdef', refresh_token: o.refresh ?? 'REFRESH-TOKEN-VALUE-0123456789abcdef',
    expires_at: new Date(Date.now() + (o.expiresInMs ?? 86_400_000)).toISOString(), auth_mode: 'oidc',
    user_id: '0ed1fd13-5d15-4f01-9a1e-2d9cb2f1f111', create_time: '2026-08-01T00:00:00.000000Z',
    email: 'fake-owner@example.test', first_name: '測試用', ...(o.extra ?? {}),
  },
});
/** 不該被呼叫的 fetch（憑證還新時 refresh 不能發生） */
export const noFetch = /** @type {typeof fetch} */ (async () => { throw new Error('不該呼叫 fetch：憑證還新'); });
/** 把假安裝樹與它的 hash 一起給 runScan */
export const withGrok = (/** @type {string} */ inst) => ({ grokInstall: inst, expectedSha256: shaOf(inst) });

