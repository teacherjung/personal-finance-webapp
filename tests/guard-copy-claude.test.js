// 守 Claude 側釘指紋裝法（規矩 B1；裁示者 2026-09-18 裁）：templates/hook-claude-pinned.json 那兩組，
// 與 tools/guard-copy.js 的 --claude（補複本）、--claude-line（只印）、--retire（退役）。
//
// 為什麼：活讀裝法每次呼叫都讀當下那棵樹的清單——在樹裡把清單改弱、切到弱清單的分支，下一次呼叫就照弱的判。
// 釘指紋那一行只寫指紋，判斷改讀倉庫外、內容定址的固定複本 $HOME/.local/share/ai-collab-kit/guard/<指紋>：
// 樹裡的清單怎麼改都沒有用；這台機器沒有那一行要的那一份複本＝全擋（看得見）。
//
// 守得到的（跑那一行的題都用 /bin/sh 跑印出來的指令——⑪另有一發用 /bin/bash；HOME 都指到暫存的假家目錄，只有⑤一發刻意不設 HOME、只跑 -c；
// ⑨只測參數入口、不跑 sh）：
//   ①範本的形狀：PreToolUse 剛好一組（matcher ^mcp__、一條指令）、{files} 與 {fingerprint} 各剛好一個、沒有 {copyDir}、
//     不含任何機器路徑、shasum 與 find 每一次出現都包在清空的環境裡、指紋比對用 case（不用 [ 或 test）；
//     ConfigChange 剛好一組、matcher 逐字＝project_settings、指令逐字＝exit 2（跑起來退 2、兩個輸出都空的）；範本原樣（佔位沒換）＝退 2；
//     兩組的組只有 matcher、hooks，鉤子物件只有 type、command——多一個鍵（async、if、args、timeout、組的別的鍵）＝--claude-line／--claude 拒絕；
//   ②--claude-line 只讀不寫、不需要 git；它印的指紋＝同一份內容用 --claude 落地的目錄名＝/usr/bin/shasum 自己算的（三方互證）；
//     複本裡 settings.json 的位元組逐字釘住（改寫法＝每台機器現有的複本全部失效）；工作樹沒提交的清單改動會改到它印的指紋、改不到複本；
//   ③--claude 落地：位置、剛好四個唯讀檔、沒有暫存殘留；成功訊息分兩種（新落地＝落地前那一次加兩次試跑、已經在＝一次），
//     每一項寫明是哪個 HOME 跑的（改過一個位元組的副本＝另開的暫存目錄，不是這個家）；
//     再跑一次＝不寫（位元組與修改時間不變）、照樣試跑；已經在、試跑沒過＝不動它，訊息說那一行現在就照用它、給 --retire 的做法；
//     沒合併的版本、家目錄本身是倉庫＝拒絕、什麼都沒寫；試跑沒過（載入就崩、什麼都放、放行時印字、指紋檢查被拿掉）＝不落地、沒有殘留；
//     範本從已合併的版本讀；
//   ④那個名字已經在、但不自洽（改過一個位元組、多一個檔、名字是連結）＝拒絕、不覆寫、不刪；別的工作階段搶先落地＝自洽就算成功；
//   ⑤那一行真的跑一遍（-c 與 -lc、從別的目錄起）：擋、放、四個檔各改一個位元組、少檔、複本改名（總煞車）、HOME 沒設（只跑 -c）、
//     HOME 指到空目錄、環境帶進 guard_seen＝期望值（開頭先清空；對照組＝拿掉清空那一步真的照當下目錄那棵樹的鬆清單放行）、
//     HOME 是相對路徑又設了 CDPATH（cd 不可以弄髒標準輸出）、複本裡多一個檔或目錄、tools 底下多一個一般檔（對照組＝tools 底下不限檔名的寫法照用）、
//     PATH 前面有相對項目而複本裡放一支假 node、
//     三種連結、查不了連結、沒有 find、佔位沒換、沒有 node、載入就崩；每一種都有「改回來就恢復」或對照組（多一個檔與假 node 的對照組＝修正前只查連結的寫法真的照用）；
//     指紋對不上那一句一律不印 64 碼十六進位（tests/helpers/guard-rig.js 的 blocks()）；
//   ⑥**核心宣稱：樹裡改清單沒有用**——工作樹把清單改弱、切到弱清單的分支、環境指向清單很鬆的倉庫，那一行都照複本擋
//    （對照組：同樣的情境，活讀那一行真的放行）；
//   ⑦量到的兩個環境變數進不來：NODE_OPTIONS；PERL5OPT 偽造 shasum 的輸出（對照組：拿掉 shasum 外面那層清空環境，被改弱的複本真的過得了指紋檢查而放行）；
//   ⑧--retire：只刪名字是 64 碼、自洽的目錄（唯讀的也刪得掉）；短名字（Codex 全域層那種）、路徑片段、不自洽、名字是連結、不存在＝拒絕、什麼都沒動；
//   ⑨參數入口：四種用法不能混用；
//   ⑩在 /bin/sh（POSIX 模式）下函式換不掉的兩處：匯入名為 [ 的函式，指紋比對（case）照樣擋（對照組：寫成 [ … ] 時被改弱的複本真的放行）；
//     匯入名為 exit 的函式，設定變更攔截照樣退 2（特殊內建）。case 是保留字：bash 匯入不了名為 case 的函式，所以不當一發斷言；
//   ⑪**照實的對照（斷言放行）**：SHELLOPTS=noexec、匯入名為 cd 或 echo 的函式、PATH 前面放一支假 node＝那一行放行、設定變更攔截那一條退 0；
//     /bin/bash（非 POSIX 模式）匯入名為 exit 的函式＝設定變更攔截那一條退 0（對照：/bin/bash --posix 退 2）——
//     「這一類擋不住（設定變更攔截那一條一樣）」「exit 換不掉只在 POSIX 模式成立」這兩句靠它撐著。
//     會讓它紅的只有跑考卷這台機器的 /bin/sh 或 /bin/bash 行為變了；平台那一側（起鉤子時清不清環境、用哪一種 shell 起、
//     會不會把設定檔的 env 傳進來）這題看不到；/bin/sh 不是 bash 時 SHELLOPTS 與匯入函式那幾段是跳過，沒有 /bin/bash 時那一發是跳過。
//   ⑬改了清單卻沒重印那一行＝那一行照舊指紋找到舊複本、靜靜照舊清單判（放行、兩個輸出都空的）；同一刻唯一會紅的是等式題；
//     對照組：那一行換了、這台機器還沒補＝全擋，補了＝照新清單擋。
//   ⑫這個家的登入設定往標準輸出印字：從一開始就印＝落地前那一次 /bin/sh -lc ':' 就量到、什麼都沒寫、退 1；
//     那一份出現之後才印＝落地後用這個家再試跑沒過、這一次落地的那一份撤掉（之後那一行全擋、不是半套）；
//     同時基底目錄變成不給寫＝撤不掉：訊息照實說那一份還在、那一行現在就照用它，暫存骨架清不掉另外照實說（不蓋成「沒有落地任何東西」）；
//     原本就在的、別的工作階段先落地的那一份，試跑沒過也不動；對照組＝登入設定安靜時照常落地。
//     （落地後試跑途中被中斷＝那一份留著：沒有題，寫在 tools/guard-copy.js 檔頭。）
//   ⑭四個檔之一換成具名管道、或換成極大的檔（稀疏檔）：限時 5 秒內退 2（逾時算失敗：官方鉤子文件寫 PreToolUse 的指令鉤子逾時不擋）；
//     對照組＝修正前的寫法（find 有輸出照樣算指紋、沒有大小上限）2 秒內結束不了；超過上限、指紋是對的那一份：照樣退 2、copyProblem 也不收
//     （對照組＝拿掉大小上限的寫法照用）。
//   ⑮（Codex r1 第 1 條）Claude 側的拒絕形狀要完整：攔截器印的拒絕缺 hookEventName、hookEventName 不對、permissionDecision 不是 deny、
//     理由缺或空、最上層多一個鍵、hookSpecificOutput 裡多一個鍵（Codex r2 第 1 條：數值或字串的 additionalContext 都不收）——從改過的來源重抽，
//     試跑沒過、不落地；硬落地之後那一行的輸出 denies() 也不收（先驗只差那一處）。
//   ⑯（第 4 條，照實的對照）<指紋> 那一層本身換成指向內容相同目錄的連結＝那一行照用（它只查 cd 進去之後的裡面）；
//     --claude、--retire 不收（copyProblem 說是連結）；連結改指到清單改弱的目錄＝指紋對不上、退 2。
//   ⑰（第 2、3 條）--retire：基底本身或它的上層是連結、解開之後在假家的 .claude／.codex 底下＝退 2、什麼都不動（--claude 同一個情境也拒絕；
//     對照組＝指到別處就真的刪掉）；基底讀不了（ELOOP、上層不給進、基底本身不給進）＝照實說確認不了，不說「沒有」、不說「刪到一半」
//     （對照組＝真的不存在、上層是一般檔＝「沒有東西可以退役」）。不給進那兩發以 root 跑時不跑。
//   ⑱（覆蓋缺口 M03）不給 --from＝抽設定登記的主幹：主幹叫 trunk＝抽 origin/trunk（誘餌 origin/main 指到比較舊的一顆）。
//   ⑲（覆蓋缺口 M05）大小上限的邊界：剛好上限＝那一行退 2、copyProblem 不收；少 1 位元組＝都收（兩邊同一個邊界：收＝小於上限）；
//     對照組＝那一行的上限往外推一格，剛好上限的照用。
//   ⑩⑪匯入函式與 SHELLOPTS 那幾段只在 /bin/sh 是 bash 的機器跑，不是就跳過並寫明（⑪的 /bin/bash 那一發只看有沒有 /bin/bash）；⑦的 PERL5OPT 那一段只在 /usr/bin/shasum 是 perl 腳本時跑；
//   ⑫只在這台機器的登入 shell 真的讀假家的 .profile 時跑（先用對照組驗），不是就跳過並寫明；「撤不掉」那一段以 root 跑時不跑（改權限擋不住 root）。
//   ⑤的 CDPATH 對照組：/bin/sh 不是 bash、而且 cd 用 CDPATH 時沒印字的機器上不跑（留一句診斷；正面那一發照跑）。
// ⚠️ 守不到的：真的 Claude 對話有沒有載入那兩組；ConfigChange 在平台上擋不擋——這裡只證明那一條指令退 2；平台的行為 2026-09-18 在
//   2.1.275 量過一次、只量了專案設定檔這個來源；之後沒有任何例行動作重量它（測試鈕只走 PreToolUse 那一行）；
//   鉤子的環境被塞變數這一類（⑪；設定變更攔截那一條一樣擋不住）；平台實際用哪一種 shell 起鉤子（量到 /bin/sh、官方文件寫預設 bash）；
//   這台機器真的家目錄裡有沒有複本（考題一律用假家目錄）；
//   node 本身；檢查與執行之間的極短空檔；複本不是鎖（誰都造得出自洽的一份）；Windows（指令是 sh）。
//   ⚠️ 突變指引：動到那四個檔的突變會先死在指紋檢查（紅的原因不對）——矩陣類的突變要照「改→重新落地→再跑」的順序做。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  COPY_FILES, CLAUDE_BASE, CLAUDE_PLACEHOLDERS, CLAUDE_TEMPLATE_REL, CLAUDE_MAX_FILE_BYTES, CONFIG_CHANGE_MATCHER,
  fingerprintDir, treeFingerprint, claudeGroups, claudeLine, copyProblem, buildClaude, retire, parseArgs, Refusal,
} = require('../tools/guard-copy.js');
const {
  KIT, FAKE, LOOSE, DENIED, ALLOWED, MISMATCH, STARTUP, base, git, sourceRepo, editFile, fakeHome, hook, tool, denies, allows, blocks, walk, withScratch, snapshot,
} = require('./helpers/guard-rig.js');
const { claudePinStatus } = require('../tools/claude-pin.js');

const SHASUM = '/usr/bin/shasum';
const template = () => JSON.parse(fs.readFileSync(path.join(KIT, CLAUDE_TEMPLATE_REL), 'utf8'));
const templateCommand = () => template().hooks.PreToolUse[0].hooks[0].command;
const baseOf = (home) => path.join(home, ...CLAUDE_BASE);
/** 這份來源專案的那一行（照它工作樹的四個檔與範本）。 */
const lineOf = (src) => claudeLine(src).groups.PreToolUse.hooks[0].command;
/** 落地一份：回 { src, home, fp, copyDir, cmd }。 */
function landed(scratch, srcOpts = {}, buildOpts = {}) {
  const src = sourceRepo(scratch, srcOpts);
  const home = fakeHome(scratch);
  const r = buildClaude({ from: 'HEAD', root: src, home, allowTemp: true, ...buildOpts });
  assert.equal(r.failure, null, r.failure);
  return { src, home, fp: r.fp, copyDir: r.copyDir, cmd: lineOf(src), r };
}
const refuses = (fn, re, why) => assert.throws(fn, (e) => e instanceof Refusal && re.test(e.message), why);
/** 指紋對不上那一條路的結尾（突變與對照組用）。 */
const FP_FAIL = "原句轉給裁示者（補複本的順序在 tools/guard-copy.js 檔頭）' >&2; exit 2;; esac";
/**
 * 那一行裡查「複本裡只有那四個檔與 tools 目錄」的那一道（對照組用：拿掉它、換回修正前只查連結的寫法、吞掉 find 的失敗）。
 * 從那一行裡找出來、不逐字寫死：這一道的條件被改掉時，要紅在行為斷言、不是紅在對照組找不到字。
 */
const oddCheckOf = (command) => {
  const m = command.match(/guard_odd="\$\(\/usr\/bin\/env -i \/usr\/bin\/find .*?\)"(?= && )/u);
  assert.ok(m, '前提：那一行裡有查多出來的檔那一道');
  return m[0];
};
const LINKS_ONLY = 'guard_odd="$(/usr/bin/env -i /usr/bin/find . -type l 2>/dev/null)"';
const PRESERVE = ' --preserve-symlinks --preserve-symlinks-main';
/** 把那一行的某一截換掉；要換的那一截不在＝考題自己壞了（突變了個寂寞），當場紅。 */
const swap = (command, from, to) => {
  assert.equal(command.split(from).length, 2, `前提：那一行裡剛好有一段「${from.slice(0, 60)}…」`);
  return command.replace(from, () => to);
};
/** /bin/sh 是不是 bash：匯入函式（BASH_FUNC_名字%%）、SHELLOPTS 這兩招是 bash 的，別的 sh 上那幾段跳過並寫明。 */
const shIsBash = () => spawnSync('/bin/sh', ['-c', 'printf %s "${BASH_VERSION-}"'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).stdout !== '';

test('前提：這台機器有 /bin/sh、/usr/bin/env、/usr/bin/find、/usr/bin/shasum（少一支，釘指紋那一行在這台機器上退 2）', () => {
  for (const p of ['/bin/sh', '/usr/bin/env', '/usr/bin/find', SHASUM]) assert.ok(fs.existsSync(p), `沒有 ${p}`);
});

test('①範本的形狀：兩組各剛好一組、佔位各一個、不含機器路徑、shasum 與 find 都包在清空的環境裡；ConfigChange 那一條真的退 2', () => withScratch((scratch) => {
  const doc = template();
  assert.deepEqual(Object.keys(doc.hooks).sort(), ['ConfigChange', 'PreToolUse'], '範本剛好帶兩種鉤子');
  const pre = doc.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.deepEqual([pre[0].matcher, pre[0].hooks.length, pre[0].hooks[0].type], ['^mcp__', 1, 'command']);
  // 組與鉤子物件剛好這幾個鍵：多一個（async、if、args、timeout…）都可能讓那一組不擋（下面「範本壞了＝拒絕」逐發試）
  for (const event of ['PreToolUse', 'ConfigChange']) {
    assert.deepEqual(Object.keys(doc.hooks[event][0]).sort(), ['hooks', 'matcher'], `${event} 那一組的鍵`);
    assert.deepEqual(Object.keys(doc.hooks[event][0].hooks[0]).sort(), ['command', 'type'], `${event} 那一個鉤子物件的鍵`);
  }
  const cmd = pre[0].hooks[0].command;
  for (const ph of CLAUDE_PLACEHOLDERS) assert.equal(cmd.split(ph).length, 2, `${ph} 要剛好一個`);
  assert.ok(!cmd.includes('{copyDir}'), '那一行跨機器共用：不可以有複本路徑的佔位');
  assert.ok(cmd.includes(`"$HOME/${CLAUDE_BASE.join('/')}/$fp"`), '那一行找複本的位置＝工具落地的位置（CLAUDE_BASE）');
  assert.ok(!cmd.includes('${HOME:?'), 'HOME 沒設時 ${HOME:?} 讓整支 shell 退 127，而平台只把退 2 當成擋');
  assert.doesNotMatch(cmd, /\/Users\/|\/home\/|~\//u, '那一行不可以含任何機器路徑');
  for (const bin of ['/usr/bin/find', SHASUM]) {
    const uses = cmd.split(bin).length - 1;
    assert.ok(uses >= 1, `前提：那一行有用到 ${bin}`);
    assert.equal(cmd.split(`/usr/bin/env -i ${bin}`).length - 1, uses, `${bin} 每一次出現都要包在清空的環境裡`);
  }
  assert.ok(cmd.includes('/usr/bin/env -i PATH="$PATH" node --preserve-symlinks --preserve-symlinks-main tools/forbidden-tools.js'), 'node 那一截：清空環境、只留 PATH、兩個旗標');
  // 允許的兩處（settings.json、tools 底下那三個）都帶大小上限，數字＝CLAUDE_MAX_FILE_BYTES（copyProblem 用同一個）；find 的輸出是空的才算指紋（⑭真的跑）
  assert.equal(cmd.split(` -size -${CLAUDE_MAX_FILE_BYTES}c`).length, 3, '允許的兩處都帶大小上限，數字跟 CLAUDE_MAX_FILE_BYTES 一樣');
  assert.equal(cmd.split('-size').length, 3, '沒有別的大小條件');
  assert.equal(cmd.split('&& case "$guard_odd" in "") guard_sum="$(').length, 2, 'find 的輸出是空的才去算指紋');
  assert.match(cmd, /不要手工造複本、不要自己改那一行，原句轉給裁示者/u, '指紋對不上那一句要叫 AI 停手、轉給裁示者');

  const change = doc.hooks.ConfigChange;
  assert.equal(change.length, 1);
  assert.equal(CONFIG_CHANGE_MATCHER, 'project_settings', '只量過這一個來源');
  assert.deepEqual([change[0].matcher, change[0].hooks.length, change[0].hooks[0].type], [CONFIG_CHANGE_MATCHER, 1, 'command'], 'matcher 逐字＝project_settings（local_settings 沒量，刻意不掛）');
  // 只剩 exit 2：擋下時訊息沒有人收得到（量到＋官方文件），而在 /bin/sh（POSIX 模式）下 exit 是特殊內建、匯入的函式換不掉（⑩真的跑；非 POSIX 模式的 bash 換得掉：⑪）
  assert.equal(change[0].hooks[0].command, 'exit 2', '設定變更攔截那一條只有 exit 2');
  const home = fakeHome(scratch);
  for (const flag of ['-c', '-lc']) {
    const r = spawnSync('/bin/sh', [flag, change[0].hooks[0].command], { cwd: scratch, env: { ...base, HOME: home }, input: '{}', encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', ''], `${flag}：設定變更攔截那一條要退 2、兩個輸出都空的`);
  }
  // 指紋比對用 case、不用 [ … ]（匯入的函式換得掉 [；case 是保留字、不是指令：⑩真的跑匯入名為 [ 的函式）
  assert.match(cmd, /case "\$guard_seen" in "\|\$fp {2}-"\) ;;/u, '指紋比對用 case');
  assert.doesNotMatch(cmd, /(^|[\s;&|(])(\[|test)\s/u, '那一行不可以用 [ 或 test（函式換得掉）');
  // 填好的那一行也不含機器路徑：家目錄、暫存目錄、這份套件在哪裡，一個都不可以出現
  const filled = claudeGroups('a'.repeat(64), JSON.stringify(doc));
  assert.deepEqual(filled.ConfigChange, change[0], '設定變更攔截那一組原樣（沒有佔位）');
  for (const p of [os.homedir(), scratch, KIT]) assert.ok(!JSON.stringify(filled).includes(p), `填好的那兩組含機器路徑 ${p}`);
  for (const ph of ['{files}', '{fingerprint}', '{copyDir}']) assert.ok(!filled.PreToolUse.hooks[0].command.includes(ph), `${ph} 沒換掉`);

  // 範本壞了＝拒絕：matcher 被改、多一個佔位、混進複本路徑的佔位、設定變更攔截的 matcher 被換
  const broken = (fn) => { const d = template(); fn(d); return JSON.stringify(d); };
  refuses(() => claudeGroups('a'.repeat(64), broken((d) => { d.hooks.PreToolUse[0].matcher = '^mcp__unrelated__'; })), /形狀不對/u, 'PreToolUse 的 matcher 被改');
  refuses(() => claudeGroups('a'.repeat(64), broken((d) => { d.hooks.ConfigChange[0].matcher = 'local_settings'; })), /形狀不對/u, 'ConfigChange 的 matcher 被換');
  refuses(() => claudeGroups('a'.repeat(64), broken((d) => { delete d.hooks.ConfigChange; })), /找不到那一條指令/u, '少了 ConfigChange 那一組');
  refuses(() => claudeGroups('a'.repeat(64), broken((d) => { d.hooks.PreToolUse[0].hooks[0].command += ' # {fingerprint}'; })), /不是剛好一個/u, '多一個佔位');
  refuses(() => claudeGroups('a'.repeat(64), broken((d) => { d.hooks.PreToolUse[0].hooks[0].command += " # '{copyDir}'"; })), /\{copyDir\}/u, '混進複本路徑的佔位');
  refuses(() => claudeGroups('de1cfb4', JSON.stringify(doc)), /64 碼/u, '指紋不是 64 碼');
  // 鉤子物件多一個官方文件列的欄位（async＝背景跑不擋、if＝只在符合規則時跑、args＝不經 shell、timeout＝逾時不擋）、組多一個鍵＝拒絕
  for (const [key, value] of [['async', true], ['if', 'Bash(*)'], ['args', []], ['timeout', 1]]) {
    for (const event of ['PreToolUse', 'ConfigChange']) {
      refuses(() => claudeGroups('a'.repeat(64), broken((d) => { d.hooks[event][0].hooks[0][key] = value; })),
        new RegExp(`${event} 那一組多了鍵（hooks\\[0\\]\\.${key}）`, 'u'), `${event} 的鉤子物件多了 ${key}`);
    }
  }
  for (const event of ['PreToolUse', 'ConfigChange']) {
    refuses(() => claudeGroups('a'.repeat(64), broken((d) => { d.hooks[event][0].description = '多一個鍵'; })), new RegExp(`${event} 那一組多了鍵（description）`, 'u'), `${event} 的組多一個鍵`);
  }
}));

test('②--claude-line 只讀不寫、不需要 git；指紋三方互證；複本裡設定檔的位元組逐字釘住；沒提交的清單改動只改得到那一行', () => withScratch((scratch) => {
  const src = sourceRepo(scratch);
  const home = fakeHome(scratch);
  const noGit = fs.mkdtempSync(path.join(scratch, 'empty-path-'));   // PATH 裡什麼都沒有：要 git 的話這裡就起不來
  const before = snapshot(src);
  const cli = tool(src, ['--claude-line'], { home, env: { PATH: noGit } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(snapshot(src), before, '--claude-line 不可以在工作樹裡寫任何東西');
  assert.deepEqual(fs.readdirSync(home), [], '--claude-line 不可以在家目錄寫任何東西');
  const fp = treeFingerprint(src);
  const groups = claudeGroups(fp, fs.readFileSync(path.join(src, CLAUDE_TEMPLATE_REL), 'utf8'));
  assert.deepEqual(JSON.parse(cli.stdout), { hooks: { PreToolUse: [groups.PreToolUse], ConfigChange: [groups.ConfigChange] } }, '印出來的＝範本＋這棵樹的指紋');
  assert.match(cli.stderr, new RegExp(`指紋：${fp}`, 'u'));

  // 三方互證：讀工作樹算的＝從已合併版本落地的目錄名＝shasum 自己算的
  const r = buildClaude({ from: 'HEAD', root: src, home, allowTemp: true });
  assert.equal(r.failure, null, r.failure);
  assert.deepEqual([r.fp, path.basename(r.copyDir)], [fp, fp], '兩條路（讀工作樹、抽已合併版本）要算出同一個指紋');
  const sh = spawnSync('/bin/sh', ['-c', `${SHASUM} -a 256 ${COPY_FILES.join(' ')} | ${SHASUM} -a 256`], { cwd: r.copyDir, env: { ...base, HOME: home }, encoding: 'utf8' });
  assert.equal(sh.stdout, `${fp}  -\n`, '指紋要跟 shasum 算的一模一樣');
  // 逐位元組釘住寫法：改它＝每台機器上現有的複本（含 Codex 全域層的）全部對不上
  assert.equal(fs.readFileSync(path.join(r.copyDir, 'settings.json'), 'utf8'), `${JSON.stringify({ forbidden: FAKE }, null, 2)}\n`, '複本裡的設定檔＝只有 forbidden 那一塊、縮排 2、結尾一個換行');

  // 工作樹沒提交的改動：清單以外的欄位不影響指紋；清單改了＝那一行的指紋跟著變，但複本（抽已合併版本）不變
  const settingsFile = path.join(src, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, mergeAuthorization: '別的欄位' }));
  assert.equal(treeFingerprint(src), fp, '清單以外的欄位（連同整份檔的排版）不進指紋');
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, forbidden: LOOSE }, null, 2));
  assert.notEqual(treeFingerprint(src), fp, '工作樹的清單改了，--claude-line 的指紋要跟著變');
  const again = buildClaude({ from: 'HEAD', root: src, home, allowTemp: true });
  assert.deepEqual([again.fp, again.existed], [fp, true], '複本只看已合併的版本：工作樹的改動進不去');
  // 清單沒填＝拒絕（釘上去只會全擋）
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, forbidden: { name: '未設定' } }));
  refuses(() => treeFingerprint(src), /還沒填/u, '清單沒填');
  const unfilled = tool(src, ['--claude-line'], { home });
  assert.deepEqual([unfilled.status, unfilled.stdout], [2, ''], '清單沒填：退 2、什麼都不印');
}));

test('③--claude 落地：位置、四個唯讀檔、沒有暫存殘留；再跑＝不寫照樣試跑；沒合併＝拒絕；試跑沒過＝不落地', () => withScratch((scratch) => {
  const { src, home, fp, copyDir } = landed(scratch);
  assert.equal(copyDir, path.join(baseOf(home), fp), '落在 <家目錄>/.local/share/ai-collab-kit/guard/<指紋>');
  assert.deepEqual(fs.readdirSync(baseOf(home)), [fp], '基底目錄裡只有那一份：暫存骨架要清掉');
  const files = walk(copyDir).filter((p) => fs.statSync(p).isFile()).map((p) => path.relative(copyDir, p)).sort();
  assert.deepEqual(files, [...COPY_FILES].sort(), '複本裡只能有指紋蓋到的那幾個檔');
  for (const rel of COPY_FILES) assert.equal(fs.statSync(path.join(copyDir, rel)).mode & 0o222, 0, `${rel} 要唯讀`);
  assert.equal(fingerprintDir(copyDir), fp, '目錄名＝從磁碟重算的指紋');
  assert.equal(copyProblem(copyDir, fp), null);

  // 再跑一次（指令入口、不給 --from＝抽 origin/<主幹>）：不寫、照樣試跑、退 0
  const before = snapshot(baseOf(home));
  const again = tool(src, ['--claude'], { home });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, `${fp}\n`, '標準輸出＝指紋一行');
  assert.match(again.stderr, /原本就在、自洽，沒有動它/u);
  assert.match(again.stderr, /自我試跑：過（\/bin\/sh -c 與 -lc 各一遍：無害假名放行、該擋的假名印出拒絕（HOME 指到這個家）；改過一個位元組的副本退 2（HOME 指到另開的暫存目錄））/u,
    '已經在：前兩項是這個家跑的，第三項是另開的暫存目錄跑的');
  assert.match(again.stderr, /這棵樹現在的四個檔：同一個指紋/u);
  assert.deepEqual(snapshot(baseOf(home)), before, '已經在而且自洽：一個位元組、一個修改時間都不可以變');
  // 已經在、但試跑沒過（這裡用一個照清單不擋的 --deny-probe 逼它沒過）：退 1、沒有動它
  const probeFails = tool(src, ['--claude', '--deny-probe', ALLOWED], { home });
  assert.deepEqual([probeFails.status, probeFails.stdout], [1, ''], `給了照清單不擋的 --deny-probe：試跑要沒過、退 1（${probeFails.stderr}）`);
  assert.match(probeFails.stderr, /原本就在，這支沒有動它——指紋是這一個的那一行現在就照用這一份/u, '已經在、試跑沒過：要說那一行現在就照用它');
  assert.ok(probeFails.stderr.includes(`node tools/guard-copy.js --retire ${fp}（之後那一行全擋、看得見）`), '已經在、試跑沒過：要給退掉它的做法');
  assert.deepEqual(snapshot(baseOf(home)), before);

  // 新落地（指令入口）：兩次試跑都過了才算數，訊息照實分開講
  const firstHome = fakeHome(scratch);
  const first = tool(src, ['--claude'], { home: firstHome });
  assert.deepEqual([first.status, first.stdout], [0, `${fp}\n`], first.stderr);
  assert.match(first.stderr, /（新落地）/u);
  assert.match(first.stderr, /自我試跑：過（落地前先用這個家跑 \/bin\/sh -lc ':'，標準輸出是空的；之後兩次，每次 \/bin\/sh -c 與 -lc 各一遍：無害假名放行、該擋的假名印出拒絕（第一次 HOME 指到暫存骨架、落地後第二次 HOME 指到這個家）；改過一個位元組的副本退 2（HOME 指到另開的暫存目錄））/u,
    '新落地：落地前那一次、兩次試跑，第三項是另開的暫存目錄跑的');
  assert.deepEqual(fs.readdirSync(baseOf(firstHome)), [fp]);

  // 沒合併的版本：拒絕，家目錄裡什麼都沒有
  const fresh = fakeHome(scratch);
  fs.appendFileSync(path.join(src, 'tools', 'forbidden-tools.js'), '\n// 本機沒推的改動\n');
  assert.equal(git(src, 'commit', '-qam', 'local').status, 0);
  refuses(() => buildClaude({ from: 'HEAD', root: src, home: fresh, allowTemp: true }), /還不在 origin\/main 裡/u, '本機沒推的提交');
  const viaCli = tool(src, ['--claude', '--from', 'HEAD'], { home: fresh });
  assert.deepEqual([viaCli.status, viaCli.stdout], [2, ''], viaCli.stderr);
  assert.deepEqual(fs.readdirSync(fresh), [], '拒絕＝家目錄裡什麼都沒寫');
  refuses(() => buildClaude({ root: sourceRepo(scratch, { mainBranch: '未設定' }), home: fresh, allowTemp: true }), /用 --from 給/u, '不給 --from 又沒填主幹');
  refuses(() => buildClaude({ root: sourceRepo(scratch, { merged: false }), home: fresh, allowTemp: true }), /不是這個倉庫裡的一個版本/u, '不給 --from、本機沒有 origin/<主幹>');
  refuses(() => buildClaude({ from: 'HEAD', root: sourceRepo(scratch, { edit: (dir) => fs.rmSync(path.join(dir, CLAUDE_TEMPLATE_REL)) }), home: fresh, allowTemp: true }), /裡沒有 templates\/hook-claude-pinned\.json/u, '那個版本還沒有這份範本');
  refuses(() => buildClaude({ from: 'HEAD', root: sourceRepo(scratch, editFile(CLAUDE_TEMPLATE_REL, (c) => c.replace('"matcher": "^mcp__"', '"matcher": "^mcp__unrelated__"'))), home: fresh, allowTemp: true }), /形狀不對/u, '那個版本的範本形狀不對（matcher 被改掉）');
  refuses(() => buildClaude({ from: 'HEAD', root: sourceRepo(scratch, editFile(CLAUDE_TEMPLATE_REL, (c) => { const d = JSON.parse(c); d.hooks.ConfigChange[0].hooks[0].async = true; return JSON.stringify(d); })), home: fresh, allowTemp: true }), /ConfigChange 那一組多了鍵（hooks\[0\]\.async）/u, '那個版本的範本：設定變更攔截那一條多了 async');
  const asyncLine = tool(sourceRepo(scratch, editFile(CLAUDE_TEMPLATE_REL, (c) => { const d = JSON.parse(c); d.hooks.PreToolUse[0].hooks[0].async = true; return JSON.stringify(d); })), ['--claude-line'], { home: fresh });
  assert.deepEqual([asyncLine.status, asyncLine.stdout], [2, ''], `--claude-line：範本那一行多了 async＝退 2、什麼都不印（${asyncLine.stderr}）`);
  assert.match(asyncLine.stderr, /PreToolUse 那一組多了鍵（hooks\[0\]\.async）/u);
  refuses(() => buildClaude({ from: 'HEAD', root: sourceRepo(scratch, { forbidden: { name: '測試禁區', patterns: ['^create_widget$'] } }), home: fresh, allowTemp: true }), /--deny-probe/u, '只靠樣式規則的清單、沒給 --deny-probe');
  refuses(() => buildClaude({ from: 'HEAD', root: src, home: 'relative/home', allowTemp: true }), /家目錄不是絕對路徑/u, '家目錄不是絕對路徑');
  // 暫存區的放行是明寫的旗標：不給就拒絕（考題的假家目錄都在暫存區）
  refuses(() => buildClaude({ from: 'HEAD~1', root: src, home: fresh }), /暫存區/u, '暫存區');
  assert.deepEqual(fs.readdirSync(fresh), [], '以上每一種拒絕都沒有寫東西');
  // 家目錄本身是一個倉庫（把家目錄的設定檔放進版控的做法）：基底目錄在版本控制目錄裡＝拒絕、什麼都沒寫
  const repoHome = fakeHome(scratch);
  assert.equal(git(repoHome, 'init', '-q').status, 0);
  const repoBefore = snapshot(repoHome);
  refuses(() => buildClaude({ from: 'HEAD~1', root: src, home: repoHome, allowTemp: true }), /目的地在版本控制目錄裡/u, '家目錄本身是倉庫');
  assert.deepEqual(snapshot(repoHome), repoBefore, '家目錄是倉庫：什麼都沒寫');
  const repoCli = tool(src, ['--claude', '--from', 'HEAD~1'], { home: repoHome });
  assert.deepEqual([repoCli.status, repoCli.stdout], [2, ''], `家目錄是倉庫：指令入口退 2（${repoCli.stderr}）`);
  assert.deepEqual(snapshot(repoHome), repoBefore);

  // 試跑沒過＝不落地、沒有殘留。四種壞法各自要被抓到：
  const failsWith = (srcOpts, re, why) => {
    const bad = sourceRepo(scratch, srcOpts);
    const badHome = fakeHome(scratch);
    const r = buildClaude({ from: 'HEAD', root: bad, home: badHome, allowTemp: true });
    assert.match(r.failure || '', re, `${why}：${r.failure}`);
    assert.ok(!fs.existsSync(r.copyDir), `${why}：試跑沒過不可以落地`);
    assert.deepEqual(fs.readdirSync(baseOf(badHome)), [], `${why}：暫存骨架要清掉`);
    return { bad, badHome };
  };
  const crash = failsWith(editFile('tools/settings-data.js', () => "'use strict';\nthrow new Error('載入就崩');\n"), /沒有被乾淨地放行[\s\S]*退 2/u, '攔截器載入就崩');
  failsWith(editFile('tools/forbidden-tools.js', (c) => c.replace("return { code: 0, output: d.deny ? hookOutput(d.why, name) : '' };", "return { code: 0, output: '' };")), /沒有一個被擋下/u, '攔截器被改成什麼都放');
  failsWith(editFile('tools/forbidden-tools.js', (c) => c.replace("if (r.output) process.stdout.write(`${r.output}\\n`);", "process.stdout.write(r.output ? `${r.output}\\n` : 'hello\\n');")), /沒有被乾淨地放行/u, '放行時往標準輸出印字');
  failsWith(editFile(CLAUDE_TEMPLATE_REL, (c) => { const out = c.replace(FP_FAIL, FP_FAIL.replace('exit 2', 'exit 0')); assert.notEqual(out, c, '前提：真的改到範本'); return out; }), /指紋檢查沒有作用/u, '範本的指紋檢查被改成不擋（提交進版本）');
  const cliBad = tool(crash.bad, ['--claude'], { home: crash.badHome });
  assert.deepEqual([cliBad.status, cliBad.stdout], [1, ''], `指令入口：試跑沒過＝退 1、標準輸出空的（${cliBad.stderr}）`);
  assert.match(cliBad.stderr, /自我試跑沒過[\s\S]*沒有落地/u);
  assert.deepEqual(fs.readdirSync(baseOf(crash.badHome)), []);

  // 寫到一半出錯（基底目錄的上層不給寫）：退 1、什麼都沒落地
  if (process.getuid && process.getuid() !== 0) {
    const roHome = fakeHome(scratch);
    fs.mkdirSync(path.join(roHome, '.local'), { mode: 0o555 });
    const half = tool(sourceRepo(scratch), ['--claude'], { home: roHome });
    fs.chmodSync(path.join(roHome, '.local'), 0o755);
    assert.deepEqual([half.status, half.stdout], [1, ''], `寫不進去：退 1、標準輸出空的（${half.stderr}）`);
    assert.match(half.stderr, /途中出錯[\s\S]*沒有落地任何東西/u);
    assert.deepEqual(fs.readdirSync(path.join(roHome, '.local')), [], '什麼都沒落地');
  }

  // 範本從已合併的版本讀：工作樹把指紋檢查改成不擋，試跑照提交的那一份＝照常過
  const clean = sourceRepo(scratch);
  const tpl = path.join(clean, CLAUDE_TEMPLATE_REL);
  const loosened = fs.readFileSync(tpl, 'utf8').replace(FP_FAIL, FP_FAIL.replace('exit 2', 'exit 0'));
  assert.notEqual(loosened, fs.readFileSync(tpl, 'utf8'), '前提：真的改到範本');
  fs.writeFileSync(tpl, loosened);
  assert.equal(buildClaude({ from: 'HEAD', root: clean, home: fakeHome(scratch), allowTemp: true }).failure, null, '試跑用的是已合併版本的範本');
}));

test('④那個名字已經在、但不自洽＝拒絕、不覆寫、不刪；別的工作階段搶先落地＝自洽就算成功', () => withScratch((scratch) => {
  const good = landed(scratch);
  const plant = (mutate) => {
    const home = fakeHome(scratch);
    const dir = path.join(baseOf(home), good.fp);
    fs.mkdirSync(baseOf(home), { recursive: true });
    fs.cpSync(good.copyDir, dir, { recursive: true });
    mutate(dir, home);
    return { home, dir, before: snapshot(baseOf(home)) };
  };
  const stays = ({ home, before }, why) => {
    refuses(() => buildClaude({ from: 'HEAD', root: good.src, home, allowTemp: true }), /不是一份自洽的複本/u, why);
    assert.deepEqual(snapshot(baseOf(home)), before, `${why}：不覆寫、不刪、不留暫存骨架`);
    const cli = tool(good.src, ['--claude'], { home });
    assert.deepEqual([cli.status, cli.stdout], [2, ''], `${why}：指令入口退 2（${cli.stderr}）`);
    assert.match(cli.stderr, /原句轉給裁示者/u);
    assert.deepEqual(snapshot(baseOf(home)), before);
  };
  stays(plant((dir) => { fs.chmodSync(path.join(dir, 'settings.json'), 0o644); fs.appendFileSync(path.join(dir, 'settings.json'), ' '); }), '內容改過一個位元組');
  stays(plant((dir) => fs.writeFileSync(path.join(dir, 'package.json'), '{}')), '多一個不在清單上的檔');
  stays(plant((dir) => { fs.chmodSync(path.join(dir, 'tools', 'package.json'), 0o644); fs.rmSync(path.join(dir, 'tools', 'package.json')); }), '少一個檔');
  // 名字是連結、指到別處一份自洽的複本：內容是對的，但那個名字不是這支造出來的樣子＝不認
  const elsewhere = path.join(scratch, 'elsewhere-copy');
  fs.cpSync(good.copyDir, elsewhere, { recursive: true });
  assert.equal(copyProblem(elsewhere, good.fp), null, '前提：連結指到的那一份本身是自洽的');
  stays(plant((dir) => { fs.rmSync(dir, { recursive: true, force: true }); fs.symlinkSync(elsewhere, dir); }), '名字是一個連結');
  assert.equal(copyProblem(elsewhere, good.fp), null, '連結指到的那一份沒有被動到');

  // 兩個工作階段同時補：落地前一刻別人先放了同一份（自洽）＝算成功、不留暫存骨架；放的是不自洽的＝照樣拒絕
  const raceHome = fakeHome(scratch);
  const raced = buildClaude({ from: 'HEAD', root: good.src, home: raceHome, allowTemp: true, beforeLand: (dir) => fs.cpSync(good.copyDir, dir, { recursive: true }) });
  assert.deepEqual([raced.failure, raced.existed, raced.fp], [null, true, good.fp], '別人先落地、而且自洽：照「已經在」那條路走');
  assert.deepEqual(fs.readdirSync(baseOf(raceHome)), [good.fp]);
  const badRaceHome = fakeHome(scratch);
  refuses(() => buildClaude({ from: 'HEAD', root: good.src, home: badRaceHome, allowTemp: true, beforeLand: (dir) => { fs.cpSync(good.copyDir, dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'extra'), 'x'); } }), /不是一份自洽的複本/u, '別人先落地、但不自洽');
  assert.deepEqual(fs.readdirSync(baseOf(badRaceHome)), [good.fp], '不自洽的那一份留著給人看，暫存骨架清掉');
}));

test('⑤那一行真的跑一遍：擋、放、改一個位元組、少檔、總煞車、HOME 沒設或指到空目錄、環境帶進 guard_seen、CDPATH、多一個檔或目錄、tools 底下多一個一般檔、複本裡的假 node、連結、沒有 find、佔位沒換、沒有 node、載入就崩', (t) => withScratch((scratch) => {
  const { home, fp, copyDir, cmd } = landed(scratch);
  const elsewhere = fs.mkdtempSync(path.join(scratch, 'elsewhere-'));
  for (const flag of ['-c', '-lc']) {
    denies(hook(cmd, { home, flag, tool: DENIED, cwd: elsewhere }), `${flag}：該擋的擋`);
    allows(hook(cmd, { home, flag, cwd: elsewhere }), `${flag}：該放的放（尾巴不可以把放行變成擋）`);
  }
  for (const rel of COPY_FILES) {
    const file = path.join(copyDir, rel);
    const original = fs.readFileSync(file);
    const flipped = Buffer.from(original);
    flipped[Math.floor(flipped.length / 2)] ^= 0x01;
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, flipped);
    blocks(hook(cmd, { home, tool: DENIED }), MISMATCH, `${rel} 改一個位元組`);
    blocks(hook(cmd, { home }), MISMATCH, `${rel} 改一個位元組：本來放行的也擋`);
    fs.writeFileSync(file, original);
    fs.chmodSync(file, 0o444);
    allows(hook(cmd, { home }), `對照組：${rel} 改回來就恢復`);
  }
  const moved = path.join(scratch, 'moved');
  fs.renameSync(path.join(copyDir, 'tools', 'settings-data.js'), moved);
  blocks(hook(cmd, { home }), MISMATCH, '少一個檔');
  fs.renameSync(moved, path.join(copyDir, 'tools', 'settings-data.js'));
  // 總煞車：把複本目錄改名，下一次呼叫就全擋；放回來就恢復
  fs.renameSync(copyDir, `${copyDir}.away`);
  blocks(hook(cmd, { home }), MISMATCH, '複本改名（總煞車）');
  blocks(hook(cmd, { home, tool: DENIED }), MISMATCH, '複本改名：該擋的也是退 2，不是靜靜放行');
  fs.renameSync(`${copyDir}.away`, copyDir);
  allows(hook(cmd, { home }), '對照組：放回來就恢復');
  // HOME：沒設、指到沒有複本的地方＝退 2（不可以退別的碼：平台只把退 2 當成擋）。
  // HOME 沒設只跑 -c：登入 shell 在 HOME 沒設時會照密碼檔找到真的家、去讀那裡的登入設定（考題不碰真的家）
  blocks(hook(cmd, { home: null }), MISMATCH, '-c：HOME 沒設');
  for (const flag of ['-c', '-lc']) {
    blocks(hook(cmd, { home: fakeHome(scratch), flag, tool: DENIED }), MISMATCH, `${flag}：HOME 指到空目錄（這台機器沒補複本）`);
  }
  allows(hook(cmd, { home }), '對照組：HOME 指回有複本的家就恢復');

  // 那一行開頭的 guard_seen=（先清空）：環境帶進比對的期望值、HOME 指到沒有複本的家、當下目錄是一棵清單很鬆的樹——照樣退 2。
  // 不靠 bash（環境變數在任何 sh 都會變成同名的 shell 變數），所有機器都跑
  const looseTree = sourceRepo(scratch, { forbidden: LOOSE });
  const seeded = { home: fakeHome(scratch), tool: DENIED, cwd: looseTree, env: { guard_seen: `|${fp}  -` } };
  blocks(hook(cmd, seeded), MISMATCH, '環境帶進 guard_seen＝期望值：照樣退 2');
  allows(hook(swap(cmd, 'guard_seen=; ', ''), seeded), '對照組：拿掉先清空那一步，環境帶進來的值讓比對過關、照當下目錄那棵樹的鬆清單放行');

  // cd 後面的 >/dev/null：HOME 是相對路徑、又設了 CDPATH 時，cd 會往標準輸出印它進去的目錄——拒絕形狀被弄髒＝平台讀不出來＝放行
  const cdpathCwd = fs.mkdtempSync(path.join(scratch, 'cdpath-cwd-'));
  const relHome = { home: path.basename(home), cwd: cdpathCwd, env: { CDPATH: path.dirname(home) }, tool: DENIED };
  denies(hook(cmd, relHome), 'HOME 是相對路徑又設了 CDPATH：標準輸出照樣整段是拒絕形狀');
  const chattyCd = hook(swap(cmd, ' >/dev/null 2>&1 && guard_odd=', ' 2>/dev/null && guard_odd='), relHome);
  if (chattyCd.stdout.startsWith(path.dirname(home)) || shIsBash()) {
    assert.ok(chattyCd.stdout.startsWith(path.dirname(home)), `對照組的前提：這樣設定時 cd 真的往標準輸出印字（「${chattyCd.stdout.slice(0, 120)}」）`);
    assert.throws(() => denies(chattyCd, 'x'), '對照組：cd 不吞標準輸出時，拒絕形狀被弄髒');
  } else {
    t.diagnostic('這台機器的 /bin/sh 不是 bash、用 CDPATH 找到目錄時也沒往標準輸出印字：CDPATH 的對照組做不出來，只跑了正面那一發');
  }

  // 複本裡多一個檔：退 2（那一行查的是 cd 進去之後的複本裡面；<指紋> 那一層本身是連結那一行看不到：⑯）
  const ODD_CHECK = oddCheckOf(cmd);
  const extra = path.join(copyDir, 'extra.txt');
  fs.writeFileSync(extra, 'x');
  assert.equal(fingerprintDir(copyDir), fp, '前提：多一個檔不改四個檔的指紋');
  blocks(hook(cmd, { home }), MISMATCH, '複本裡多一個檔');
  allows(hook(swap(cmd, ODD_CHECK, LINKS_ONLY), { home }), '對照組：修正前只查連結的寫法，多一個檔照用');
  fs.rmSync(extra);
  fs.mkdirSync(path.join(copyDir, 'tools', 'sub'));
  blocks(hook(cmd, { home }), MISMATCH, '複本裡多一個空目錄');
  fs.rmdirSync(path.join(copyDir, 'tools', 'sub'));
  allows(hook(cmd, { home }), '對照組：拿掉就恢復');
  // tools 底下多一個一般檔（名字不是那三個）：退 2。對照組＝tools 底下不限檔名的寫法，照用
  const toolsExtra = path.join(copyDir, 'tools', 'extra.js');
  fs.writeFileSync(toolsExtra, 'x');
  blocks(hook(cmd, { home }), MISMATCH, 'tools 底下多一個一般檔');
  allows(hook(swap(cmd, ' \\( -name forbidden-tools.js -o -name package.json -o -name settings-data.js \\)', ''), { home }), '對照組：tools 底下不限檔名的寫法，多一個一般檔照用');
  fs.rmSync(toolsExtra);
  allows(hook(cmd, { home }), '對照組：拿掉就恢復');
  // PATH 有相對項目、複本目錄裡放一支假 node：那一行 cd 進複本之後才找 node，相對項目就是從複本目錄算的
  for (const [rel, entry] of [[path.join('node_modules', '.bin', 'node'), 'node_modules/.bin'], ['node', '.']]) {
    const fake = path.join(copyDir, rel);
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
    const relPath = { home, tool: DENIED, env: { PATH: `${entry}:${base.PATH}` } };
    blocks(hook(cmd, relPath), MISMATCH, `PATH 前面放 ${entry}＋複本裡的假 node`);
    allows(hook(swap(cmd, ODD_CHECK, LINKS_ONLY), relPath), `對照組：修正前的寫法，PATH 前面放 ${entry}＋複本裡的假 node＝真的被拿來跑而放行`);
    fs.rmSync(path.join(copyDir, rel.split(path.sep)[0]), { recursive: true });
    denies(hook(cmd, relPath), `對照組：假 node 拿掉、PATH 照舊＝照清單擋（擋下假 node 的是查多出來的檔那一道）`);
  }

  // 連結：另一份內容相同、只有清單放寬的複本；把這一份的某一處換成指向它的連結，shasum 跟著連結算出一樣的指紋，
  // node 卻從連結真正的位置找旁邊的檔＝讀到放寬的清單。兩道各自擋得住；對照組＝兩道都拿掉，真的放行
  const loose = path.join(scratch, 'loose-copy');
  fs.cpSync(copyDir, loose, { recursive: true });
  for (const p of walk(loose)) fs.chmodSync(p, 0o755);
  fs.writeFileSync(path.join(loose, 'settings.json'), `${JSON.stringify({ forbidden: LOOSE }, null, 2)}\n`);
  // 原本那一份先搬到複本外面（留在複本裡＝多一個檔，會被查多出來的檔那一道先擋下，量不到連結那一道）
  const savedOf = (rel) => path.join(scratch, `saved-${rel.split(path.sep).join('-')}`);
  const swapToLink = (rel, target) => {
    const at = path.join(copyDir, rel);
    const saved = savedOf(rel);
    fs.chmodSync(path.dirname(at), 0o755);
    fs.renameSync(at, saved);
    fs.symlinkSync(target, at);
    return () => { fs.unlinkSync(at); fs.renameSync(saved, at); };
  };
  const onlyPreserve = swap(cmd, ODD_CHECK, 'guard_odd=');
  const neither = swap(onlyPreserve, PRESERVE, '');
  let restore = swapToLink(path.join('tools', 'forbidden-tools.js'), path.join(loose, 'tools', 'forbidden-tools.js'));
  assert.equal(fingerprintDir(copyDir), fp, '前提：換成內容相同的連結，指紋一樣');
  allows(hook(neither, { home, tool: DENIED }), '對照組：兩道都拿掉時，入口換成連結真的讀到放寬的清單而放行');
  blocks(hook(cmd, { home, tool: DENIED }), MISMATCH, '入口換成連結');
  denies(hook(onlyPreserve, { home, tool: DENIED }), '只剩第②道：照複本自己的清單擋');
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(path.join(copyDir, 'tools'), 0o111);
    const find = spawnSync('/usr/bin/find', ['.', '-type', 'l'], { cwd: copyDir, encoding: 'utf8' });
    try {
      assert.notEqual(find.status, 0, '前提：這樣設定之後 find 真的失敗');
      assert.equal(fingerprintDir(copyDir), fp, '前提：四個檔照樣讀得到、指紋一樣');
      blocks(hook(cmd, { home, tool: DENIED }), MISMATCH, '查不了有沒有連結');
      const swallowed = swap(swap(cmd, ODD_CHECK, ODD_CHECK.replace(' 2>/dev/null)"', ' 2>/dev/null || :)"')), PRESERVE, '');
      allows(hook(swallowed, { home, tool: DENIED }), '對照組：只看輸出空不空（吞掉 find 的失敗）、又不帶旗標的寫法，這個情況真的放行');
    } finally {
      fs.chmodSync(path.join(copyDir, 'tools'), 0o755);
    }
  }
  restore();
  blocks(hook(swap(cmd, '/usr/bin/find', '/nonexistent/find'), { home }), MISMATCH, '找不到 find 也擋');
  restore = swapToLink('tools', path.join(loose, 'tools'));
  blocks(hook(cmd, { home, tool: DENIED }), MISMATCH, 'tools 目錄換成連結');
  restore();
  restore = swapToLink('settings.json', path.join(scratch, 'moved-settings-link-target'));
  fs.copyFileSync(savedOf('settings.json'), path.join(scratch, 'moved-settings-link-target'));
  blocks(hook(cmd, { home }), MISMATCH, '設定檔換成內容相同的連結');
  restore();
  denies(hook(cmd, { home, tool: DENIED }), '對照組：連結都拿掉就恢復');

  // 佔位沒換
  const values = { '{files}': COPY_FILES.join(' '), '{fingerprint}': fp };
  const fill = (skip) => CLAUDE_PLACEHOLDERS.reduce((c, ph) => (ph === skip ? c : c.replace(ph, () => values[ph])), templateCommand());
  blocks(hook(templateCommand(), { home }), MISMATCH, '範本原樣（兩個佔位都沒換）');
  for (const ph of CLAUDE_PLACEHOLDERS) blocks(hook(fill(ph), { home }), MISMATCH, `只有 ${ph} 沒換`);
  assert.equal(fill(null), cmd, '對照組：兩個都換了就是印出來的那一行');

  // 沒有 node：PATH 是一個空目錄（env 寫的是絕對路徑，不靠 PATH）。用 -c（-lc 會照登入設定重建 PATH，模擬不出來）
  const emptyPath = fs.mkdtempSync(path.join(scratch, 'nopath-'));
  const noNode = hook(cmd, { home, env: { PATH: emptyPath } });
  blocks(noNode, STARTUP, '找不到 node');
  assert.doesNotMatch(noNode.stderr, MISMATCH, '沒有 node 的時候指紋照樣驗得過（shasum、find、env 都寫絕對路徑）');

  // 載入就崩、但指紋是對的（不試跑、硬落地一份崩掉的版本）：要被尾巴轉成退 2，而且不是指紋那一句
  const crashed = landed(scratch, editFile('tools/settings-data.js', () => "'use strict';\nthrow new Error('載入就崩');\n"), { runSelfTest: false });
  const r = hook(crashed.cmd, { home: crashed.home });
  blocks(r, STARTUP, '攔截器載入就崩');
  assert.doesNotMatch(r.stderr, MISMATCH, '崩掉那一份的指紋是對的：擋下它的是尾巴，不是指紋檢查');
}));

test('⑥核心宣稱：樹裡改清單沒有用——工作樹改弱、切到弱清單的分支、環境指向鬆的倉庫，那一行都照複本擋（對照組：活讀那一行真的放行）', () => withScratch((scratch) => {
  const { src, home, cmd } = landed(scratch);
  const live = JSON.parse(fs.readFileSync(path.join(KIT, 'templates', 'hook-claude.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  const inTree = (command, env = {}) => hook(command, { home, tool: DENIED, cwd: path.join(src, 'tools'), env });
  denies(inTree(cmd), '前提：照嚴格清單，那一行擋');
  denies(inTree(live), '前提：照嚴格清單，活讀那一行也擋');

  // (a) 工作樹把清單改弱（沒提交）
  const settingsFile = path.join(src, 'settings.json');
  const strict = fs.readFileSync(settingsFile, 'utf8');
  fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(strict), forbidden: LOOSE }, null, 2));
  allows(inTree(live), '對照組：工作樹改弱，活讀那一行真的放行');
  denies(inTree(cmd), '工作樹改弱：釘指紋那一行照複本擋');
  // (b) 切到弱清單的分支（提交了的弱清單）
  assert.equal(git(src, 'checkout', '-qb', 'weak').status, 0);
  assert.equal(git(src, 'commit', '-qam', 'weak list').status, 0);
  allows(inTree(live), '對照組：切到弱清單的分支，活讀那一行真的放行');
  denies(inTree(cmd), '切到弱清單的分支：釘指紋那一行照複本擋');
  // 那一行是照「這棵樹現在的四個檔」印的話就不一樣了——那是一行新的指令、要走審查；而且它的複本這台機器沒有＝全擋
  blocks(inTree(lineOf(src)), MISMATCH, '照弱清單重印的那一行：複本不在＝全擋，不是照弱清單放行');
  fs.writeFileSync(settingsFile, strict);

  // (c) 環境指向另一個清單很鬆的倉庫：那一行根本不問 git
  const loose = sourceRepo(scratch, { forbidden: { name: '測試禁區', deny: ['mcp__z__only'] } });
  const looseEnv = { GIT_DIR: path.join(loose, '.git'), GIT_WORK_TREE: loose };
  const withoutClearing = live.replace(/^root="\$\(.*?git rev-parse/u, 'root="$(git rev-parse');
  allows(inTree(withoutClearing, looseEnv), '對照組：會問 git 又不清環境的寫法，真的讀到鬆的清單而放行');
  denies(inTree(cmd, looseEnv), '環境指向別的倉庫：釘指紋那一行照複本擋');
  denies(hook(cmd, { home, tool: DENIED, cwd: loose }), '走進清單很鬆的另一個倉庫：照複本擋');
  allows(hook(cmd, { home, cwd: loose }), '對照組：該放的照樣放');
}));

test('⑦量到的兩個環境變數進不來：NODE_OPTIONS 夾帶程式、PERL5OPT 偽造 shasum 的輸出（這一類沒有關完：⑪）', (t) => withScratch((scratch) => {
  const { home, fp, copyDir, cmd } = landed(scratch);
  const evil = path.join(scratch, 'evil.js');
  fs.writeFileSync(evil, 'process.exit(0);\n');
  const nodeEnv = { NODE_OPTIONS: `--require=${evil}` };
  const withoutClear = cmd.replace('/usr/bin/env -i PATH="$PATH" node ', 'node ');
  assert.notEqual(withoutClear, cmd, '前提：指令裡有清空環境那一截');
  allows(hook(withoutClear, { home, tool: DENIED, env: nodeEnv }), '對照組：不清環境時，夾帶的程式真的把該擋的放行');
  denies(hook(cmd, { home, tool: DENIED, env: nodeEnv }), '清空環境：夾帶的程式進不來');

  // shasum 是 perl 腳本：PERL5OPT 能讓它不算、直接印出指定的字串。把複本的清單改弱、再讓 shasum 印出原本的指紋——
  // 不清環境的話指紋檢查就過了、照弱清單放行。（PERL5OPT 用空白切參數，所以兩個空白寫成 \x20）
  if (!/^#!.*perl/u.test(fs.readFileSync(SHASUM, 'utf8').split('\n')[0])) {
    t.skip('這台機器的 /usr/bin/shasum 不是 perl 腳本：PERL5OPT 這一招不適用，對照組做不出來');
    return;
  }
  const perlEnv = { PERL5OPT: `-Mstrict;print(qq{${fp}\\x20\\x20-\\n});exit` };
  const forged = spawnSync('/bin/sh', ['-c', `echo x | ${SHASUM} -a 256`], { env: { ...base, HOME: home, ...perlEnv }, encoding: 'utf8' });
  assert.equal(forged.stdout, `${fp}  -\n`, '前提：這個環境變數真的讓 shasum 印出指定的字串');
  fs.chmodSync(path.join(copyDir, 'settings.json'), 0o644);
  fs.writeFileSync(path.join(copyDir, 'settings.json'), `${JSON.stringify({ forbidden: LOOSE }, null, 2)}\n`);
  assert.notEqual(fingerprintDir(copyDir), fp, '前提：複本真的被改了');
  const bareShasum = cmd.split(`/usr/bin/env -i ${SHASUM}`).join(SHASUM);
  assert.notEqual(bareShasum, cmd, '前提：指令裡 shasum 外面有清空環境那一層');
  allows(hook(bareShasum, { home, tool: DENIED, env: perlEnv }), '對照組：shasum 不包清空的環境，被改弱的複本真的過得了指紋檢查而放行');
  blocks(hook(cmd, { home, tool: DENIED, env: perlEnv }), MISMATCH, '包了清空的環境：偽造不了，被改過的複本照樣退 2');
}));

test('⑧--retire：只刪名字是 64 碼、自洽的目錄；短名字、路徑片段、不自洽、名字是連結、不存在＝拒絕、什麼都沒動', () => withScratch((scratch) => {
  const { src, home, fp, copyDir } = landed(scratch);
  const base64 = baseOf(home);
  // Codex 全域層那種人取的短名字：內容一模一樣也不碰
  const shortName = path.join(base64, 'de1cfb4');
  fs.cpSync(copyDir, shortName, { recursive: true });
  // 名字是 64 碼、內容不自洽
  const wrongName = 'b'.repeat(64);
  fs.cpSync(copyDir, path.join(base64, wrongName), { recursive: true });
  // 名字是 64 碼的連結，指到基底以外一份自洽的複本
  const outside = path.join(scratch, 'outside', fp);
  fs.mkdirSync(path.dirname(outside));
  fs.cpSync(copyDir, outside, { recursive: true });
  const linkHome = fakeHome(scratch);
  fs.mkdirSync(baseOf(linkHome), { recursive: true });
  fs.symlinkSync(outside, path.join(baseOf(linkHome), fp));

  const before = snapshot(base64);
  const outsideBefore = snapshot(outside);
  refuses(() => retire({ fp: 'de1cfb4', home }), /只收 64 碼/u, '短名字');
  refuses(() => retire({ fp: `../${fp}`, home }), /只收 64 碼/u, '路徑片段');
  refuses(() => retire({ fp: fp.toUpperCase(), home }), /只收 64 碼/u, '大寫（不分大小寫的磁碟上是同一個目錄，照樣不收）');
  refuses(() => retire({ fp: wrongName, home }), /不是一份自洽的複本/u, '名字對、內容重算的指紋不是它');
  refuses(() => retire({ fp: 'c'.repeat(64), home }), /沒有這一份/u, '不存在');
  refuses(() => retire({ fp, home: fakeHome(scratch) }), /沒有 Claude 側複本的基底目錄/u, '這個家根本沒有基底目錄');
  refuses(() => retire({ fp, home: linkHome }), /不是一份自洽的複本[\s\S]*連結/u, '名字是連結');
  assert.deepEqual(snapshot(base64), before, '以上每一種拒絕都什麼都沒動');
  assert.deepEqual(snapshot(outside), outsideBefore, '連結指到的那一份沒有被動到');
  assert.ok(fs.lstatSync(path.join(baseOf(linkHome), fp)).isSymbolicLink(), '連結自己也還在');
  const cliRefused = tool(src, ['--retire', 'de1cfb4'], { home });
  assert.deepEqual([cliRefused.status, cliRefused.stdout], [2, ''], cliRefused.stderr);
  assert.match(cliRefused.stderr, /什麼都沒刪/u);

  // 多一個檔＝不自洽＝不刪；拿掉就刪得掉（檔案是唯讀的也一樣）
  fs.writeFileSync(path.join(copyDir, 'extra'), 'x');
  refuses(() => retire({ fp, home }), /不是一份自洽的複本/u, '多一個不在清單上的檔');
  fs.rmSync(path.join(copyDir, 'extra'));
  const cli = tool(src, ['--retire', fp], { home });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /已退役/u);
  assert.match(cli.stderr, /這一份就是這棵樹現在四個檔的指紋/u, '退役的正是這棵樹現在要用的那一份：要提醒會全擋');
  assert.ok(!fs.existsSync(copyDir), '自洽的那一份刪掉了');
  assert.deepEqual(fs.readdirSync(base64).sort(), [wrongName, 'de1cfb4'].sort(), '別的目錄都還在');
  blocks(hook(lineOf(src), { home, tool: DENIED }), MISMATCH, '退役之後那一行全擋（看得見），不是靜靜放行');
}));

test('⑨參數入口：四種用法不能混用；舊的 --from／--to 照舊', () => {
  assert.deepEqual(parseArgs(['--from', 'a', '--to', '/b']), { mode: 'codex', from: 'a', to: '/b', denyProbe: undefined });
  assert.deepEqual(parseArgs(['--to', '/b', '--deny-probe', 'mcp__x__y', '--from', 'a']), { mode: 'codex', from: 'a', to: '/b', denyProbe: 'mcp__x__y' });
  assert.deepEqual(parseArgs(['--claude']), { mode: 'claude', from: null, denyProbe: undefined });
  assert.deepEqual(parseArgs(['--claude', '--from', 'a', '--deny-probe', 'mcp__x__y']), { mode: 'claude', from: 'a', denyProbe: 'mcp__x__y' });
  assert.deepEqual(parseArgs(['--claude-line']), { mode: 'claude-line' });
  assert.deepEqual(parseArgs(['--retire', 'abc']), { mode: 'retire', retire: 'abc' });
  for (const bad of [[], ['--from', 'a'], ['--to', '/b'], ['--from', 'a', '--from', 'b', '--to', '/c'], ['--from'], ['--nope', 'x'],
    ['--claude', '--to', '/b'], ['--claude', '--from', 'a', '--to', '/b'], ['--claude', '--claude'], ['--claude', '--claude-line'],
    ['--claude-line', '--from', 'a'], ['--claude-line', 'extra'], ['--retire'], ['--retire', 'abc', '--claude'], ['--retire', 'abc', '--from', 'a'], ['--retire', 'a', '--retire', 'b']]) {
    assert.equal(parseArgs(bad), null, `${JSON.stringify(bad)} 要判成用法錯誤`);
  }
  withScratch((scratch) => {
    const src = sourceRepo(scratch);
    const home = fakeHome(scratch);
    for (const args of [['--claude', '--to', path.join(scratch, 'x')], ['--claude-line', 'extra'], ['--retire']]) {
      const r = tool(src, args, { home });
      assert.deepEqual([r.status, r.stdout], [2, ''], `${args.join(' ')}：用法錯誤`);
      assert.match(r.stderr, /用法/u);
    }
    assert.deepEqual(fs.readdirSync(home), [], '用法錯誤什麼都不寫');
  });
});

test('⑩在 /bin/sh（POSIX 模式）下函式換不掉的兩處：指紋比對用 case——匯入名為 [ 的函式照樣擋（對照組：比對寫成 [ … ] 時，被改弱的複本真的放行）；設定變更攔截只剩 exit 2——匯入名為 exit 的函式照樣退 2', (t) => withScratch((scratch) => {
  if (!shIsBash()) { t.skip('這台機器的 /bin/sh 不是 bash：匯入函式（BASH_FUNC_名字%%）是 bash 的做法，這一題的現象做不出來'); return; }
  const { home, fp, copyDir, cmd } = landed(scratch);
  // 把複本的清單改弱（目錄名不變）：指紋對不上，照理退 2
  fs.chmodSync(path.join(copyDir, 'settings.json'), 0o644);
  fs.writeFileSync(path.join(copyDir, 'settings.json'), `${JSON.stringify({ forbidden: LOOSE }, null, 2)}\n`);
  assert.notEqual(fingerprintDir(copyDir), fp, '前提：複本真的被改弱了');
  const bracket = { 'BASH_FUNC_[%%': '() { return 0; }' };
  for (const flag of ['-c', '-lc']) {
    blocks(hook(cmd, { home, flag, tool: DENIED, env: bracket }), MISMATCH, `${flag}：匯入名為 [ 的函式：指紋比對照樣擋`);
  }
  const oldCompare = swap(swap(cmd, 'case "$guard_seen" in "|$fp  -") ;; *) echo', '[ "$guard_seen" = "|$fp  -" ] || { echo'), "' >&2; exit 2;; esac;", "' >&2; exit 2; };");
  blocks(hook(oldCompare, { home, tool: DENIED }), MISMATCH, '對照組的前提：[ … ] 的寫法在乾淨的環境裡也擋');
  allows(hook(oldCompare, { home, tool: DENIED, env: bracket }), '對照組：匯入名為 [ 的函式，[ … ] 的寫法真的把被改弱的複本放行');
  // case 是保留字：bash 匯入不了名為 case 的函式（匯入時就報錯、case 照常），那一行怎麼改那一發都是綠的，所以不當斷言

  const change = template().hooks.ConfigChange[0].hooks[0].command;
  const runChange = (cmdText, env) => spawnSync('/bin/sh', ['-c', cmdText], { env: { ...base, HOME: home, ...env }, input: '{}', encoding: 'utf8' });
  assert.equal(runChange(`true; ${change}`, { 'BASH_FUNC_true%%': '() { exit 0; }' }).status, 0, '對照組：同一個環境裡匯入的函式真的會跑（換掉 true 就在 exit 2 之前退 0）');
  assert.equal(runChange(change, { 'BASH_FUNC_exit%%': '() { return 0; }' }).status, 2, '匯入名為 exit 的函式：設定變更攔截那一條照樣退 2（特殊內建）');
}));

test('⑪照實的對照（守不到的）：SHELLOPTS=noexec、匯入的 shell 函式（cd、echo）、PATH 前面放一支假 node＝那一行放行，設定變更攔截那一條在 SHELLOPTS=noexec 下、以及 /bin/bash（非 POSIX 模式）匯入名為 exit 的函式時退 0——斷言「放行」是為了讓文件那幾句有考題撐著；跑考卷這台機器的 /bin/sh 或 /bin/bash 行為變了才會紅，平台那一側（起鉤子時清不清環境、用哪一種 shell 起、會不會把設定檔的 env 傳進來）這題看不到；/bin/sh 不是 bash 時那幾段是跳過', (t) => withScratch((scratch) => {
  const { home, cmd } = landed(scratch);
  // PATH：指紋蓋不到 PATH 找到哪一支 node（不靠 bash）
  const fakeBin = fs.mkdtempSync(path.join(scratch, 'fakebin-'));
  fs.writeFileSync(path.join(fakeBin, 'node'), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
  denies(hook(cmd, { home, tool: DENIED }), '前提：乾淨的環境照清單擋');
  allows(hook(cmd, { home, tool: DENIED, env: { PATH: `${fakeBin}:${base.PATH}` } }), 'PATH 前面放一支假 node：指紋對、跑的是假 node＝放行（守不到）');
  // /bin/bash（非 POSIX 模式）：匯入名為 exit 的函式換得掉 exit——設定變更攔截那一條退 0。只看有沒有 /bin/bash，不靠 /bin/sh 是不是 bash
  const change = template().hooks.ConfigChange[0].hooks[0].command;
  if (fs.existsSync('/bin/bash')) {
    const bashRun = (args) => spawnSync('/bin/bash', [...args, change], { env: { ...base, HOME: home, 'BASH_FUNC_exit%%': '() { return 0; }' }, input: '{}', encoding: 'utf8' }).status;
    assert.equal(bashRun(['--posix', '-c']), 2, '對照組：同一個環境、/bin/bash --posix（POSIX 模式）＝照樣退 2');
    assert.equal(bashRun(['-c']), 0, '/bin/bash -c（非 POSIX 模式）：匯入名為 exit 的函式換掉 exit＝設定變更攔截那一條退 0（守不到）');
  } else {
    t.diagnostic('這台機器沒有 /bin/bash：非 POSIX 模式 bash 那一發跳過');
  }
  if (!shIsBash()) { t.skip('這台機器的 /bin/sh 不是 bash：SHELLOPTS 與匯入函式那幾段做不出來（PATH 那一段照跑了）'); return; }

  const empty = fakeHome(scratch);   // 沒有複本的家：乾淨的環境全擋
  for (const flag of ['-c', '-lc']) {
    blocks(hook(cmd, { home: empty, flag, tool: DENIED }), MISMATCH, `${flag} 前提：沒有複本的家，乾淨的環境全擋`);
    allows(hook(cmd, { home: empty, flag, tool: DENIED, env: { SHELLOPTS: 'noexec' } }), `${flag}：SHELLOPTS=noexec＝整行不執行、退 0（守不到）`);
    for (const fn of ['cd', 'echo']) {
      allows(hook(cmd, { home: empty, flag, tool: DENIED, env: { [`BASH_FUNC_${fn}%%`]: '() { exit 0; }' } }), `${flag}：匯入名為 ${fn} 的函式（換成 exit 0）＝退 0（守不到）`);
    }
  }
  const runChange = (env) => spawnSync('/bin/sh', ['-c', change], { env: { ...base, HOME: empty, ...env }, input: '{}', encoding: 'utf8' }).status;
  assert.equal(runChange({}), 2, '前提：設定變更攔截那一條在乾淨的環境裡退 2');
  assert.equal(runChange({ SHELLOPTS: 'noexec' }), 0, '設定變更攔截那一條：SHELLOPTS=noexec 一樣退 0（守不到）');
}));

test('⑫登入設定往標準輸出印字：落地前先量到＝不落地；落地之後才量到＝撤掉這一次落地的那一份，撤不掉＝照實說它還在、暫存骨架清不掉也照實說（不蓋掉結果）；原本就在的、別的工作階段先落地的不動', (t) => withScratch((scratch) => {
  const src = sourceRepo(scratch);
  const fp = treeFingerprint(src);
  const q = (p) => `'${p.split("'").join("'\\''")}'`;
  const chatty = (home) => { fs.writeFileSync(path.join(home, '.profile'), 'echo PROFILE-SAYS-HELLO\n'); return home; };
  // 落地之後才開始印字：.profile 只在那一份已經在的時候印（落地前那一次 /bin/sh -lc ':' 還是安靜的）；
  // readOnlyBase＝同時把基底目錄改成不給寫（撤回的改名、清暫存骨架都做不到）
  const chattyOnceLanded = (home, { readOnlyBase = false } = {}) => {
    const lock = readOnlyBase ? `chmod 555 ${q(baseOf(home))}; ` : '';
    fs.writeFileSync(path.join(home, '.profile'), `if [ -d ${q(path.join(baseOf(home), fp))} ]; then ${lock}echo PROFILE-SAYS-HELLO; fi\n`);
    return home;
  };
  // 先證明這台機器的登入 shell 真的讀假家的 .profile（對照組），不然這一題證明不了什麼
  const probe = spawnSync('/bin/sh', ['-lc', 'true'], { env: { ...base, HOME: chatty(fakeHome(scratch)) }, encoding: 'utf8' });
  if (!probe.stdout.includes('PROFILE-SAYS-HELLO')) { t.skip('這台機器的登入 shell 不讀假家的 .profile：這一題的現象做不出來'); return; }

  // (a) 從一開始就印字：落地前那一次就量到＝什麼都沒寫（連基底目錄都沒建）、退 1
  const home = chatty(fakeHome(scratch));
  const r = buildClaude({ from: 'HEAD', root: src, home, allowTemp: true });
  assert.match(r.failure || '', /落地前用這個家跑 \/bin\/sh -lc ':'，標準輸出不是空的（「PROFILE-SAYS-HELLO/u, `落地前就要量到（${r.failure}）`);
  assert.deepEqual([r.fp, r.existed, r.loginNoisy, Boolean(r.landedThenFailed)], [fp, false, true, false]);
  assert.ok(!fs.existsSync(baseOf(home)), '落地前就停：什麼都沒寫');
  const cli = tool(src, ['--claude'], { home });
  assert.deepEqual([cli.status, cli.stdout], [1, ''], `指令入口：退 1、標準輸出空的（${cli.stderr}）`);
  assert.match(cli.stderr, /標準輸出不是空的[\s\S]*：沒有落地任何東西。/u);
  assert.ok(!fs.existsSync(baseOf(home)));
  blocks(hook(lineOf(src), { home, tool: DENIED }), MISMATCH, '沒落地＝那一行全擋（看得見），不是半套');

  // (b) 落地之後才開始印字：落地後用這個家再試跑沒過＝撤掉這一次落地的那一份
  const late = chattyOnceLanded(fakeHome(scratch));
  const rl = buildClaude({ from: 'HEAD', root: src, home: late, allowTemp: true });
  assert.match(rl.failure || '', /\/bin\/sh -lc：無害的假名一個都沒有被乾淨地放行[\s\S]*PROFILE-SAYS-HELLO/u, `落地之後在這個家試跑要沒過（${rl.failure}）`);
  assert.deepEqual([rl.existed, rl.landedThenFailed, rl.withdrawn, rl.stagingLeft], [false, true, true, undefined]);
  assert.ok(!fs.existsSync(rl.copyDir), '這一次落地的那一份要撤掉');
  assert.deepEqual(fs.readdirSync(baseOf(late)), [], '基底目錄裡什麼都沒留（暫存骨架也清掉）');
  const lateCli = tool(src, ['--claude'], { home: chattyOnceLanded(fakeHome(scratch)) });
  assert.deepEqual([lateCli.status, lateCli.stdout], [1, ''], `指令入口：退 1、標準輸出空的（${lateCli.stderr}）`);
  assert.match(lateCli.stderr, /在這個人的登入設定下試跑沒過：這一次落地的那一份已經撤掉，沒有留下任何東西/u);
  blocks(hook(lineOf(src), { home: late, tool: DENIED }), MISMATCH, '撤掉之後那一行全擋（看得見），不是半套');

  // (c) 落地之後才印字、而且基底目錄同時變成不給寫：撤不掉＝照實說那一份還在；暫存骨架清不掉＝另外照實說，不可以把結果蓋成「沒有落地任何東西」
  if (process.getuid && process.getuid() !== 0) {
    const stuckHome = chattyOnceLanded(fakeHome(scratch), { readOnlyBase: true });
    let rs;
    try { rs = buildClaude({ from: 'HEAD', root: src, home: stuckHome, allowTemp: true }); } finally { fs.chmodSync(baseOf(stuckHome), 0o755); }
    assert.deepEqual([rs.existed, rs.landedThenFailed, rs.withdrawn], [false, true, false], `撤不掉（${rs.failure}）`);
    assert.ok(fs.existsSync(rs.copyDir), '撤不掉：那一份還在');
    assert.ok(typeof rs.stagingLeft === 'string' && fs.existsSync(rs.stagingLeft) && path.dirname(rs.stagingLeft) === baseOf(stuckHome), `暫存骨架清不掉：結果帶著它的路徑（${rs.stagingLeft}）`);
    const cliHome = chattyOnceLanded(fakeHome(scratch), { readOnlyBase: true });
    const stuckCli = tool(src, ['--claude'], { home: cliHome });
    fs.chmodSync(baseOf(cliHome), 0o755);
    assert.deepEqual([stuckCli.status, stuckCli.stdout], [1, ''], `指令入口：退 1、標準輸出空的（${stuckCli.stderr}）`);
    assert.ok(stuckCli.stderr.includes(`而且撤不掉：${path.join(baseOf(cliHome), fp)} 還在，指紋是這一個的那一行現在就照用這一份`), `撤不掉要照實說那一份還在（${stuckCli.stderr}）`);
    assert.match(stuckCli.stderr, /暫存骨架沒清掉：/u);
    assert.doesNotMatch(stuckCli.stderr, /沒有落地任何東西/u, '結果不可以被清骨架的錯蓋成「沒有落地任何東西」');
    assert.ok(fs.existsSync(path.join(baseOf(cliHome), fp)));
  }

  // 對照組：同一份來源、登入設定安靜的家＝照常落地
  const quiet = fakeHome(scratch);
  assert.equal(buildClaude({ from: 'HEAD', root: src, home: quiet, allowTemp: true }).failure, null, '對照組：登入設定安靜時照常落地');

  // 原本就在的那一份（先在安靜時落地、之後登入設定才開始印字）：試跑沒過、退 1，但那一份不動
  const before = snapshot(baseOf(quiet));
  chatty(quiet);
  const existedRun = buildClaude({ from: 'HEAD', root: src, home: quiet, allowTemp: true });
  assert.deepEqual([Boolean(existedRun.failure), existedRun.existed, Boolean(existedRun.landedThenFailed)], [true, true, false]);
  assert.deepEqual(snapshot(baseOf(quiet)), before, '原本就在的那一份：一個位元組都不動');

  // 別的工作階段搶先落地同一份：照「已經在」那條路，沒過也不刪別人的那一份
  //（登入設定要在那一份出現之後才印字：從一開始就印的話，落地前那一次就停了、走不到搶先落地這一步）
  const good = landed(scratch);
  assert.equal(good.fp, fp, '前提：同樣的四個檔＝同一個指紋');
  const raceHome = chattyOnceLanded(fakeHome(scratch));
  const raced = buildClaude({ from: 'HEAD', root: good.src, home: raceHome, allowTemp: true, beforeLand: (dir) => fs.cpSync(good.copyDir, dir, { recursive: true }) });
  assert.deepEqual([Boolean(raced.failure), raced.existed, Boolean(raced.landedThenFailed)], [true, true, false]);
  assert.deepEqual(fs.readdirSync(baseOf(raceHome)), [good.fp], '別人先落地的那一份還在');
}));

test('⑬改了清單卻沒重印那一行＝靜靜照舊清單判（放行、兩個輸出都空的）；同一刻唯一會紅的是等式題（對照組：那一行換了、沒補複本＝全擋；補了＝照新清單擋）', () => withScratch((scratch) => {
  const { src, home, cmd } = landed(scratch);   // 照原本的清單落地、那一行照原本的清單印
  const NEWLY = 'mcp__other__newly_denied_tool';
  allows(hook(cmd, { home, tool: NEWLY }), '前提：收緊之前這個名字照清單放行');
  const groups = claudeLine(src).groups;
  fs.mkdirSync(path.join(src, '.claude'));
  fs.writeFileSync(path.join(src, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [groups.PreToolUse], ConfigChange: [groups.ConfigChange] } }, null, 2));
  assert.equal(claudePinStatus(src).state, 'ok', '前提：收緊之前等式成立');

  // 收緊清單（把這個名字加進逐字拒絕清單）、提交、當成已合併；那一行沒重印
  const settingsFile = path.join(src, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, forbidden: { ...settings.forbidden, deny: [...settings.forbidden.deny, NEWLY] } }, null, 2));
  assert.equal(git(src, 'commit', '-qam', 'tighten').status, 0);
  assert.equal(git(src, 'update-ref', 'refs/remotes/origin/main', 'HEAD').status, 0);
  allows(hook(cmd, { home, tool: NEWLY }), '沒重印那一行：照舊指紋找到舊複本、照舊清單放行，兩個輸出都空的（沒有訊號）');
  assert.equal(claudePinStatus(src).state, 'mismatch', '同一刻唯一會紅的：等式題');

  // 對照組：那一行在同一支變更裡換了——這台機器還沒補那一份＝全擋（看得見）；補了＝照新清單擋
  const reprinted = lineOf(src);
  assert.notEqual(reprinted, cmd, '前提：清單改了，重印的那一行真的不同');
  blocks(hook(reprinted, { home, tool: NEWLY }), MISMATCH, '那一行換了、這台機器還沒補那一份＝全擋');
  assert.equal(buildClaude({ from: 'HEAD', root: src, home, allowTemp: true }).failure, null);
  denies(hook(reprinted, { home, tool: NEWLY }), '補了那一份＝照新清單擋');
}));

test('⑭四個檔之一換成具名管道、或換成超過上限的檔：find 查到就不算指紋，很短的限時內退 2（逾時算失敗）；對照組＝修正前的寫法（照樣算指紋、沒有大小上限）逾時；超過上限但指紋是對的也照樣退 2、--claude 認自洽也不收', () => withScratch((scratch) => {
  const { home, fp, copyDir, cmd } = landed(scratch);
  // 修正前的寫法：find 有輸出照樣去算指紋、允許的檔沒有大小上限（從現在那一行換回來；要換的那一截不在＝當場紅）
  // 在現在那一行的斷言都跑完之後才換（這一截被改掉時，要紅在行為斷言、不是紅在換不到字）
  const LIMIT = ` -size -${CLAUDE_MAX_FILE_BYTES}c`;
  const preFix = () => swap(swap(cmd, 'case "$guard_odd" in "") guard_sum=', 'guard_sum='), ' && guard_seen="|$guard_sum";; esac;', ' && guard_seen="$guard_odd|$guard_sum";').split(LIMIT).join('');
  const QUICK = 5000;   // 現在的寫法：find 查到就退 2，連 shasum 都不叫——給 5 秒是讓機器很忙時也不假紅
  const SLOW = 2000;    // 對照組：卡住的就是卡住，等多久都一樣
  const timedOut = (r) => Boolean(r.error && r.error.code === 'ETIMEDOUT');

  // 具名管道換掉 settings.json：shasum 打開它會一直等寫入的一方
  const settingsAt = path.join(copyDir, 'settings.json');
  const keptSettings = path.join(scratch, 'kept-settings.json');
  fs.renameSync(settingsAt, keptSettings);
  const mk = spawnSync('mkfifo', [settingsAt], { env: base, encoding: 'utf8' });
  assert.equal(mk.status, 0, `前提：做得出具名管道（${mk.stderr}）`);
  let drainError = null;   // 收尾時遇到的意外錯誤：記下來、收完再丟（finally 裡直接 throw 會蓋掉上面斷言的失敗原因）
  try {
    const r = hook(cmd, { home, tool: DENIED, timeout: QUICK });
    assert.ok(!timedOut(r), `設定檔換成具名管道：${QUICK / 1000} 秒內要結束（逾時＝平台放行）`);
    blocks(r, MISMATCH, '設定檔換成具名管道');
    const stuck = hook(preFix(), { home, tool: DENIED, timeout: SLOW });
    assert.ok(timedOut(stuck), `對照組：修正前的寫法卡在具名管道上、${SLOW / 1000} 秒內沒有結束（退 ${stuck.status}）`);
  } finally {
    // 被殺掉的 sh 留下的 shasum 還卡在打開管道那一步：開一下寫入端再關掉，它讀到結尾就自己結束
    for (let i = 0; i < 50; i += 1) {
      let fd;
      try { fd = fs.openSync(settingsAt, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); } catch (e) { if (e.code !== 'ENXIO') drainError = e; break; }
      fs.closeSync(fd);
      spawnSync('sleep', ['0.05'], { env: base });
    }
    fs.rmSync(settingsAt);
    fs.renameSync(keptSettings, settingsAt);
  }
  if (drainError) throw drainError;
  allows(hook(cmd, { home }), '對照組：放回來就恢復');
  denies(hook(preFix(), { home, tool: DENIED }), '對照組的前提：修正前的寫法在乾淨的複本上照清單擋（上面逾時的原因是具名管道、不是那一行本身壞了）');

  // tools 底下的一個檔換成極大的檔（稀疏檔、不佔磁碟）：shasum 要讀完才比得出對不上
  const pkgAt = path.join(copyDir, 'tools', 'package.json');
  const keptPkg = path.join(scratch, 'kept-package.json');
  fs.renameSync(pkgAt, keptPkg);
  fs.writeFileSync(pkgAt, '');
  // 16 GiB。推算：2026-09-19 那台機器 shasum 讀 1 GiB 稀疏檔約 3.6 秒＝16 GiB 約一分鐘；快十倍的機器也要五秒以上（兩個限時都等不到它讀完）
  fs.truncateSync(pkgAt, 16 * 1024 ** 3);
  try {
    const r = hook(cmd, { home, tool: DENIED, timeout: QUICK });
    assert.ok(!timedOut(r), `tools 底下的檔換成極大的檔：${QUICK / 1000} 秒內要結束（逾時＝平台放行）`);
    blocks(r, MISMATCH, 'tools 底下的檔換成極大的檔');
    const slow = hook(preFix(), { home, tool: DENIED, timeout: SLOW });
    assert.ok(timedOut(slow), `對照組：修正前的寫法去讀那個極大的檔、${SLOW / 1000} 秒內沒有結束（退 ${slow.status}）`);
  } finally {
    fs.truncateSync(pkgAt, 0);   // 被殺掉的 sh 留下的 shasum 還在讀：截成 0，它馬上讀到結尾、自己結束
    fs.rmSync(pkgAt);
    fs.renameSync(keptPkg, pkgAt);
  }
  allows(hook(cmd, { home }), '對照組：放回來就恢復');
  assert.equal(fingerprintDir(copyDir), fp, '放回來的就是原本那一份');

  // 超過上限、但指紋是對的（不試跑、硬落地一份）：照樣退 2；copyProblem（--claude 認自洽、--retire 認可以刪）也不收
  const big = landed(scratch, editFile('tools/settings-data.js', (c) => `${c}// ${'x'.repeat(CLAUDE_MAX_FILE_BYTES)}\n`), { runSelfTest: false });
  assert.ok(fs.statSync(path.join(big.copyDir, 'tools', 'settings-data.js')).size >= CLAUDE_MAX_FILE_BYTES, '前提：真的不小於上限');
  assert.equal(fingerprintDir(big.copyDir), big.fp, '前提：指紋是對的');
  blocks(hook(big.cmd, { home: big.home }), MISMATCH, '超過上限、指紋是對的：照樣退 2');
  allows(hook(big.cmd.split(LIMIT).join(''), { home: big.home }), '對照組：拿掉大小上限的寫法，這一份照用');
  assert.match(copyProblem(big.copyDir, big.fp) || '', /不小於 1048576 位元組/u, 'copyProblem 也不收');
}));

test('⑮Claude 側的拒絕形狀要完整（Codex r1 第 1 條）：攔截器印的拒絕缺 hookEventName、hookEventName 不對、permissionDecision 不是 deny、理由缺或空、最上層多一個鍵、內層多一個鍵（Codex r2 第 1 條）——重抽的複本試跑沒過、不落地；硬落地之後那一行的輸出 denies() 也不收', () => withScratch((scratch) => {
  const good = landed(scratch);
  const goodOut = hook(good.cmd, { home: good.home, tool: DENIED });
  denies(goodOut, '前提：原本的攔截器印的是完整的拒絕形狀');
  const goodDoc = JSON.parse(goodOut.stdout);
  // 每一發只改 tools/forbidden-tools.js 裡 hookOutput 的一處（Codex r1 M11 的做法：改來源、重抽複本、新指紋，不是拿舊指紋去擋）；
  // shape＝照原本的輸出算出「只差這一個變因」該長什麼樣，先驗真的只差這一處
  const VARIANTS = [
    { why: '缺 hookEventName', from: "      hookEventName: 'PreToolUse',\n", to: '', shape: (d) => { delete d.hookSpecificOutput.hookEventName; }, re: /hookEventName 不是 PreToolUse/u },
    { why: 'hookEventName 不對', from: "hookEventName: 'PreToolUse',", to: "hookEventName: 'PostToolUse',", shape: (d) => { d.hookSpecificOutput.hookEventName = 'PostToolUse'; }, re: /hookEventName 不是 PreToolUse/u },
    { why: 'permissionDecision 不是 deny', from: "permissionDecision: 'deny',", to: "permissionDecision: 'ask',", shape: (d) => { d.hookSpecificOutput.permissionDecision = 'ask'; }, re: /permissionDecision 不是 deny/u },
    { why: '理由缺', from: 'permissionDecisionReason: `', to: 'permissionDecisionReason: undefined && `', shape: (d) => { delete d.hookSpecificOutput.permissionDecisionReason; }, re: /permissionDecisionReason 不是非空字串/u },
    { why: '理由是空字串', from: 'permissionDecisionReason: `', to: "permissionDecisionReason: '' && `", shape: (d) => { d.hookSpecificOutput.permissionDecisionReason = ''; }, re: /permissionDecisionReason 不是非空字串/u },
    { why: '最上層多一個鍵', from: 'return JSON.stringify({\n', to: 'return JSON.stringify({\n    continue: true,\n', shape: (d) => { d.continue = true; }, re: /最上層/u },
    // Codex r2 第 1 條 M12：內層多一個型別不對的已知欄位（官方文件的 additionalContext 是字串）——三個必要欄位都還在、理由也還在
    { why: '內層多一個數值的 additionalContext', from: "permissionDecision: 'deny',", to: "permissionDecision: 'deny',\n      additionalContext: 123,", shape: (d) => { d.hookSpecificOutput.additionalContext = 123; }, re: /hookSpecificOutput 裡要剛好只有/u },
    // 型別對的也不收：這一支選的是「多一個就不認」，不逐一驗型別（寫明是刻意的較嚴契約）
    { why: '內層多一個字串的 additionalContext', from: "permissionDecision: 'deny',", to: "permissionDecision: 'deny',\n      additionalContext: 'x',", shape: (d) => { d.hookSpecificOutput.additionalContext = 'x'; }, re: /hookSpecificOutput 裡要剛好只有/u },
  ];
  for (const v of VARIANTS) {
    const src = sourceRepo(scratch, editFile('tools/forbidden-tools.js', (c) => {
      assert.equal(c.split(v.from).length, 2, `${v.why}：前提：攔截器裡剛好有一處「${v.from.trim()}」`);
      return c.replace(v.from, () => v.to);
    }));
    // (a) 試跑：沒過、不落地、沒有殘留，而且說出不符的是哪一處
    const home = fakeHome(scratch);
    const r = buildClaude({ from: 'HEAD', root: src, home, allowTemp: true });
    assert.match(r.failure || '', /照清單該擋的假名沒有一個被擋下（退 0、標準輸出整段是完整的拒絕形狀）/u, `${v.why}：試跑要沒過（${r.failure}）`);
    assert.match(r.failure, v.re, `${v.why}：試跑要說出不符的是哪一處（${r.failure}）`);
    assert.ok(!fs.existsSync(r.copyDir), `${v.why}：試跑沒過不可以落地`);
    assert.deepEqual(fs.readdirSync(baseOf(home)), [], `${v.why}：暫存骨架要清掉`);
    // (b) 硬落地同一份（不試跑）、照那一行跑：輸出真的只差這一處，denies() 不收
    const forced = landed(scratch, editFile('tools/forbidden-tools.js', (c) => c.replace(v.from, () => v.to)), { runSelfTest: false });
    assert.equal(forced.fp, r.fp, `${v.why}：前提：硬落地的是同一份`);
    const out = hook(forced.cmd, { home: forced.home, tool: DENIED });
    const expected = structuredClone(goodDoc);
    v.shape(expected);
    assert.deepEqual([out.status, JSON.parse(out.stdout)], [0, expected], `${v.why}：前提：退 0、輸出跟原本的只差這一處`);
    assert.throws(() => denies(out, v.why), (e) => v.re.test(e.message), `${v.why}：denies() 不可以收，而且要說出不符的是哪一處`);
  }
  // 指令入口（Codex r1 M11 那一發：缺 hookEventName）：退 1、標準輸出空的、不說「過」
  const m11 = sourceRepo(scratch, editFile('tools/forbidden-tools.js', (c) => c.replace(VARIANTS[0].from, () => '')));
  const cli = tool(m11, ['--claude'], { home: fakeHome(scratch) });
  assert.deepEqual([cli.status, cli.stdout], [1, ''], `缺 hookEventName：指令入口退 1（${cli.stderr}）`);
  assert.match(cli.stderr, /自我試跑沒過[\s\S]*hookEventName 不是 PreToolUse[\s\S]*沒有落地/u);
  assert.doesNotMatch(cli.stderr, /自我試跑：過/u);
}));

test('⑯照實的對照（Codex r1 第 4 條）：<指紋> 那一層本身換成連結、指到內容相同的目錄＝那一行照用（照清單判：該擋的擋、該放的放），它只查 cd 進去之後的複本裡面；那一層是連結由 --claude、--retire 拒絕（copyProblem 說是連結）；連結改指到清單改弱的目錄＝指紋對不上、退 2', () => withScratch((scratch) => {
  const { src, home, fp, copyDir, cmd } = landed(scratch);
  const same = path.join(scratch, 'same-content');
  fs.renameSync(copyDir, same);   // 內容原封不動搬走，原位置換成指向它的連結
  fs.symlinkSync(same, copyDir);
  assert.ok(fs.lstatSync(copyDir).isSymbolicLink(), '前提：<指紋> 那一層是連結');
  assert.equal(fingerprintDir(same), fp, '前提：連結指到的內容就是那一份');
  for (const flag of ['-c', '-lc']) {
    denies(hook(cmd, { home, flag, tool: DENIED }), `${flag}：那一層是連結、內容相同＝照清單擋`);
    allows(hook(cmd, { home, flag }), `${flag}：那一層是連結、內容相同＝照清單放（那一行看不到那一層是連結）`);
  }
  assert.match(copyProblem(copyDir, fp) || '', /那個名字是一個連結/u, 'copyProblem（--claude 認自洽、--retire 認可以刪）說是連結');
  const before = snapshot(same);
  refuses(() => buildClaude({ from: 'HEAD', root: src, home, allowTemp: true }), /不是一份自洽的複本（那個名字是一個連結/u, '--claude 不認');
  refuses(() => retire({ fp, home }), /不是一份自洽的複本（那個名字是一個連結/u, '--retire 不刪');
  assert.deepEqual(snapshot(same), before, '連結指到的那一份沒有被動到');
  // 內容仍要對上指紋：連結改指到清單改弱的目錄＝全擋，換不成弱清單
  const weak = path.join(scratch, 'weak-content');
  fs.cpSync(same, weak, { recursive: true });
  fs.chmodSync(path.join(weak, 'settings.json'), 0o644);
  fs.writeFileSync(path.join(weak, 'settings.json'), `${JSON.stringify({ forbidden: LOOSE }, null, 2)}\n`);
  fs.unlinkSync(copyDir);
  fs.symlinkSync(weak, copyDir);
  for (const flag of ['-c', '-lc']) {
    blocks(hook(cmd, { home, flag, tool: DENIED }), MISMATCH, `${flag}：連結指到清單改弱的目錄＝指紋對不上、退 2`);
    blocks(hook(cmd, { home, flag }), MISMATCH, `${flag}：連結指到清單改弱的目錄：本來放行的也擋`);
  }
}));

test('⑰--retire 不碰家目錄的 .claude／.codex（Codex r1 第 2 條）：基底目錄本身、或它的上層是連結，解開之後在那底下＝退 2、一個位元組都不動（--claude 同一個情境也拒絕）；對照組＝同樣的連結指到別處＝真的刪掉。讀不了基底（第 3 條）＝照實說確認不了、不說「沒有」', (t) => withScratch((scratch) => {
  const good = landed(scratch);
  const fp = good.fp;
  // 在 <假家>/<where>/guard/<指紋> 放一份自洽的複本，再用連結把基底（base）或它的上層（ancestor）接過去
  const plantVia = (where, linkAt) => {
    const home = fakeHome(scratch);
    const guardDir = path.join(home, where, 'guard');
    fs.mkdirSync(guardDir, { recursive: true });
    const target = path.join(guardDir, fp);
    fs.cpSync(good.copyDir, target, { recursive: true });
    const kit = path.join(home, '.local', 'share', 'ai-collab-kit');
    if (linkAt === 'base') {
      fs.mkdirSync(kit, { recursive: true });
      fs.symlinkSync(guardDir, baseOf(home));
    } else {
      fs.mkdirSync(path.dirname(kit), { recursive: true });
      fs.symlinkSync(path.join(home, where), kit);
    }
    assert.equal(fs.realpathSync(path.join(baseOf(home), fp)), fs.realpathSync(target), `前提：${where}（${linkAt}）：從基底走得到那一份`);
    assert.equal(copyProblem(target, fp), null, `前提：${where}（${linkAt}）：那一份本身是自洽的（名字與內容都對）`);
    return { home, target, top: path.join(home, where.split('/')[0]) };
  };
  for (const where of ['.claude/kit', '.codex/kit', '.CODEX/kit']) {
    const d = where.split('/')[0].toLowerCase();
    for (const linkAt of ['base', 'ancestor']) {
      const why = `${where}（${linkAt === 'base' ? '基底本身' : '基底的上層'}是連結）`;
      const { home, target, top } = plantVia(where, linkAt);
      const before = snapshot(top);
      refuses(() => retire({ fp, home }), new RegExp(`解開連結之後在家目錄的 \\${d} 底下`, 'u'), `${why}：--retire 要拒絕`);
      const cli = tool(good.src, ['--retire', fp], { home });
      assert.deepEqual([cli.status, cli.stdout], [2, ''], `${why}：指令入口退 2（${cli.stderr}）`);
      assert.match(cli.stderr, new RegExp(`家目錄的 \\${d} 底下[\\s\\S]*什麼都沒刪`, 'u'));
      refuses(() => buildClaude({ from: 'HEAD', root: good.src, home, allowTemp: true }), new RegExp(`複本不可以放在家目錄的 \\${d} 底下`, 'u'), `${why}：--claude 同一個情境也拒絕`);
      assert.deepEqual(snapshot(top), before, `${why}：一個位元組、一個修改時間都不動`);
      assert.equal(copyProblem(target, fp), null, `${why}：那一份還是完整的`);
    }
  }
  // 基底是真的目錄、<指紋> 那個名字本身是連結指進 .claude：解開之後的目標在那底下＝同一句拒絕（不是等到 copyProblem 才說「是連結」）
  const nameHome = fakeHome(scratch);
  const inClaude = path.join(nameHome, '.claude', 'kit', fp);
  fs.mkdirSync(path.dirname(inClaude), { recursive: true });
  fs.cpSync(good.copyDir, inClaude, { recursive: true });
  fs.mkdirSync(baseOf(nameHome), { recursive: true });
  fs.symlinkSync(inClaude, path.join(baseOf(nameHome), fp));
  const nameBefore = snapshot(path.join(nameHome, '.claude'));
  refuses(() => retire({ fp, home: nameHome }), /解開連結之後在家目錄的 \.claude 底下/u, '<指紋> 那個名字是連結、指進 .claude');
  assert.deepEqual(snapshot(path.join(nameHome, '.claude')), nameBefore);
  // 對照組：同樣的連結（基底本身、基底的上層）指到家裡別的地方＝--retire 真的刪掉（拒絕的原因是位置，不是連結）
  for (const linkAt of ['base', 'ancestor']) {
    const { home, target } = plantVia('elsewhere/kit', linkAt);
    const cli = tool(good.src, ['--retire', fp], { home });
    assert.equal(cli.status, 0, `對照組（${linkAt}）：指到別處＝退 0（${cli.stderr}）`);
    assert.ok(!fs.existsSync(target), `對照組（${linkAt}）：指到別處＝真的刪掉`);
  }

  // 讀不了基底：只有確實不存在才說「沒有」。對照組＝真的不存在（ENOENT）、上層是一般檔（ENOTDIR）
  refuses(() => retire({ fp, home: fakeHome(scratch) }), /沒有東西可以退役/u, '對照組：基底不存在');
  const fileHome = fakeHome(scratch);
  fs.writeFileSync(path.join(fileHome, '.local'), 'x');
  refuses(() => retire({ fp, home: fileHome }), /沒有東西可以退役/u, '對照組：.local 是一般檔（ENOTDIR）＝基底不可能存在');
  const loopHome = fakeHome(scratch);
  fs.mkdirSync(path.dirname(baseOf(loopHome)), { recursive: true });
  fs.symlinkSync(baseOf(loopHome), baseOf(loopHome));
  refuses(() => retire({ fp, home: loopHome }), /讀不了 Claude 側複本的基底目錄（ELOOP）：確認不了那一份在不在/u, '基底是繞圈的連結（ELOOP）');
  const loopCli = tool(good.src, ['--retire', fp], { home: loopHome });
  assert.deepEqual([loopCli.status, loopCli.stdout], [2, ''], loopCli.stderr);
  assert.doesNotMatch(loopCli.stderr, /沒有東西可以退役/u, 'ELOOP 不可以說成沒有');
  if (!process.getuid || process.getuid() === 0) {
    t.diagnostic('以 root 跑（或沒有 getuid）：改權限擋不住 root，「有一層不給進」那兩發不跑');
    return;
  }
  // 上層不給進（EACCES）：那一份在，只是確認不了
  const lockedHome = landed(scratch).home;
  const lockedCopy = path.join(baseOf(lockedHome), fp);
  const lockedBefore = snapshot(baseOf(lockedHome));
  fs.chmodSync(path.join(lockedHome, '.local'), 0o000);
  let viaFn;
  let viaCli;
  try {
    viaFn = (() => { try { retire({ fp, home: lockedHome }); return null; } catch (e) { return e; } })();
    viaCli = tool(good.src, ['--retire', fp], { home: lockedHome });
  } finally {
    fs.chmodSync(path.join(lockedHome, '.local'), 0o755);
  }
  assert.ok(viaFn instanceof Refusal && /讀不了 Claude 側複本的基底目錄（EACCES）：確認不了那一份在不在/u.test(viaFn.message), `上層不給進：要照實說讀不了（${viaFn && viaFn.message}）`);
  assert.doesNotMatch(viaFn.message, /沒有東西可以退役/u, 'EACCES 不可以說成沒有');
  assert.deepEqual([viaCli.status, viaCli.stdout], [2, ''], `上層不給進：指令入口退 2（${viaCli.stderr}）`);
  assert.match(viaCli.stderr, /EACCES[\s\S]*什麼都沒刪/u);
  assert.doesNotMatch(viaCli.stderr, /沒有東西可以退役/u);
  assert.deepEqual(snapshot(baseOf(lockedHome)), lockedBefore, '上層不給進：那一份完整留著');
  assert.equal(copyProblem(lockedCopy, fp), null);
  // 基底本身不給進：解得開基底、看不了裡面那一份＝照實說讀不了，不可以說成「刪到一半出錯」
  fs.chmodSync(baseOf(lockedHome), 0o000);
  let baseCli;
  try { baseCli = tool(good.src, ['--retire', fp], { home: lockedHome }); } finally { fs.chmodSync(baseOf(lockedHome), 0o755); }
  assert.deepEqual([baseCli.status, baseCli.stdout], [2, ''], `基底本身不給進：退 2（${baseCli.stderr}）`);
  assert.match(baseCli.stderr, /讀不了 [^\n]*（EACCES）：確認不了那一份在不在[\s\S]*什麼都沒刪/u);
  assert.doesNotMatch(baseCli.stderr, /刪到一半|沒有東西可以退役/u);
  assert.deepEqual(snapshot(baseOf(lockedHome)), lockedBefore, '基底本身不給進：那一份完整留著');
}));

test('⑱不給 --from＝抽這棵樹設定登記的主幹（覆蓋缺口 M03）：主幹叫 trunk＝抽 origin/trunk；對照組＝origin/main 指到主幹上一顆比較舊的提交，抽到它就是錯的', () => withScratch((scratch) => {
  const src = sourceRepo(scratch, { mainBranch: 'trunk' });
  const older = git(src, 'rev-parse', 'HEAD').stdout.trim();
  const olderFp = treeFingerprint(src);
  // trunk 上再提交一顆（清單收緊），推進 origin/trunk；origin/main 留在舊的那一顆（誘餌：它也在主幹裡，抽錯了 extract 照樣過）
  const settingsFile = path.join(src, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, forbidden: { ...settings.forbidden, deny: [...settings.forbidden.deny, 'mcp__other__newly_denied_tool'] } }, null, 2));
  assert.equal(git(src, 'commit', '-qam', 'tighten').status, 0);
  assert.equal(git(src, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD').status, 0);
  assert.equal(git(src, 'update-ref', 'refs/remotes/origin/main', older).status, 0);
  const newer = git(src, 'rev-parse', 'HEAD').stdout.trim();
  const newerFp = treeFingerprint(src);
  assert.notEqual(newerFp, olderFp, '前提：兩顆的指紋不同');
  assert.equal(git(src, 'merge-base', '--is-ancestor', older, 'refs/remotes/origin/trunk').status, 0, '前提：誘餌那一顆也在 origin/trunk 裡');

  const home = fakeHome(scratch);
  const cli = tool(src, ['--claude'], { home });
  assert.deepEqual([cli.status, cli.stdout], [0, `${newerFp}\n`], `指令入口：抽的要是 origin/trunk 那一顆（${cli.stderr}）`);
  assert.ok(cli.stderr.includes(`來源版本：${newer}（已在 origin/trunk 裡）`), cli.stderr);
  assert.deepEqual(fs.readdirSync(baseOf(home)), [newerFp]);
  const r = buildClaude({ root: src, home: fakeHome(scratch), allowTemp: true });
  assert.deepEqual([r.failure, r.commit, r.tracking, r.fp], [null, newer, 'origin/trunk', newerFp], '函式入口：同一件事');
}));

test('⑲大小上限的邊界（覆蓋缺口 M05）：settings.json、tools 底下的檔各自墊到剛好 CLAUDE_MAX_FILE_BYTES＝那一行退 2、copyProblem 不收；少 1 位元組＝不因大小擋（試跑過、那一行照清單判、copyProblem 收）——兩邊同一個邊界（收＝小於上限）；對照組：那一行的上限往外推一格（-size -1048577c），剛好上限的照用', () => withScratch((scratch) => {
  const LIMIT = ` -size -${CLAUDE_MAX_FILE_BYTES}c`;
  const WIDER = ` -size -${CLAUDE_MAX_FILE_BYTES + 1}c`;
  /** 落地一份：複本裡的 rel 剛好 bytes 位元組（tools/settings-data.js 墊一行註解；settings.json 墊清單裡一個攔截器不讀的欄位）。 */
  const padded = (rel, bytes, buildOpts) => {
    let srcOpts;
    if (rel === 'settings.json') {
      const len0 = Buffer.byteLength(`${JSON.stringify({ forbidden: { ...FAKE, _pad: '' } }, null, 2)}\n`);
      srcOpts = { forbidden: { ...FAKE, _pad: 'x'.repeat(bytes - len0) } };
    } else {
      srcOpts = editFile(rel, (c) => `${c}//${'x'.repeat(bytes - Buffer.byteLength(c) - 3)}\n`);
    }
    const one = landed(scratch, srcOpts, buildOpts);
    assert.equal(fs.statSync(path.join(one.copyDir, rel)).size, bytes, `前提：${rel} 剛好 ${bytes} 位元組`);
    assert.equal(fingerprintDir(one.copyDir), one.fp, '前提：指紋是對的');
    return one;
  };
  for (const rel of ['settings.json', 'tools/settings-data.js']) {
    const at = padded(rel, CLAUDE_MAX_FILE_BYTES, { runSelfTest: false });
    blocks(hook(at.cmd, { home: at.home, tool: DENIED }), MISMATCH, `${rel} 剛好上限：那一行退 2`);
    blocks(hook(at.cmd, { home: at.home }), MISMATCH, `${rel} 剛好上限：本來放行的也擋`);
    assert.match(copyProblem(at.copyDir, at.fp) || '', new RegExp(`${rel} 不小於 ${CLAUDE_MAX_FILE_BYTES} 位元組`, 'u'), `${rel} 剛好上限：copyProblem 不收`);

    const below = padded(rel, CLAUDE_MAX_FILE_BYTES - 1, {});   // 試跑照跑：landed() 斷言它過了
    denies(hook(below.cmd, { home: below.home, tool: DENIED }), `${rel} 少 1 位元組：照清單擋`);
    allows(hook(below.cmd, { home: below.home }), `${rel} 少 1 位元組：照清單放（不因大小擋）`);
    assert.equal(copyProblem(below.copyDir, below.fp), null, `${rel} 少 1 位元組：copyProblem 收`);

    // 對照組放在行為斷言都跑完之後（那一行的上限被改掉時，要紅在上面的行為斷言、不是紅在這裡換不到字）
    const wider = at.cmd.split(LIMIT).join(WIDER);
    assert.equal(wider.split(WIDER).length, 3, '前提：那一行的兩處上限都換到了');
    allows(hook(wider, { home: at.home }), `對照組：${rel} 剛好上限，上限往外推一格的寫法照用`);
  }
}));
