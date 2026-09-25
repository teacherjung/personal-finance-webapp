#!/usr/bin/env node
// 從 settings.json 產生 PROJECT-SETTINGS.md。**那份說明是產物、不要手改。**
//
// 為什麼也做成產物：每一支機器都要讀專案設定。如果值只寫在那份 Markdown 裡，機器就得去解讀
// 表格；如果兩邊各存一份，就會漂——這份套件的案例簿裡，「同一條規矩寫在六個地方各漏一項」
// 是有代價的實例。所以值只有一份（settings.json），人讀的那份由它產生，考題比逐字元相同。
//
// 契約與字面編碼沿用 build-rules.js 那一套（所有 ASCII 標點一律跳脫，語法只能由範本提供）；
// ⚠️ 代價照實說：這份說明裡的字因此是純文字，不能用粗體或反引號之類的排版。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { literal } = require('./build-rules.js');
// 平台介面的動作清單正本在 tools/platform.js，這裡只照它排版——不另抄一份會漂的名單
const { OPERATIONS } = require('./platform.js');

const { read, dataFile } = require('./settings-data.js');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'PROJECT-SETTINGS.md');

const LINE_BREAK = /[\n\r\u0085\u2028\u2029\v\f]/u;
const hasNul = (s) => String(s).includes('\u0000');
const STATES = ['未移植', '已安裝未啟用', '已啟用'];
const PROVIDERS = ['未設定', '無', '工具自帶', '專案自建'];

function plain(value, what, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${what} 不是字串`);
  if (!allowEmpty && value.trim() === '') throw new Error(`${what} 是空的`);
  if (LINE_BREAK.test(value)) throw new Error(`${what} 裡有換行：它會跑出自己該待的位置`);
  if (hasNul(value)) throw new Error(`${what} 裡有空字元`);
  return literal(value);
}

/**
 * 一條指令（argv 陣列）排成說明書裡的一行。含空白、引號、反斜線、換行或空字串的那一格用 JSON 字串寫，
 * 換行就變成看得見的 \n——說明書那一格不能真的換行，但指令本身可以（搬家修正 r1 B1：合併範本的 --body
 * 要兩行，原本整條 join 起來送進「不准換行」的欄位，照套件倉庫的 README 抄完設定產生器就停在那裡）。
 * 只是顯示：執行用的永遠是 settings.json 裡的陣列本身。
 */
function argvText(argv) {
  return argv.map((a) => (typeof a === 'string' && a !== '' && !/[\s"'\\]/u.test(a) ? a : JSON.stringify(a))).join(' ');
}

function build(data) {
  const out = [
    '# 專案設定（每個使用這套架構的專案填一份；規矩本文與機器都從這裡取值）',
    '',
    '這是產物：值住在 settings.json，改完跑 node tools/build-settings.js。搬進專案後把每個「未設定」填掉；沒填的欄位＝那條規矩的機器退化成靠自覺。「填了設定」和「機器已啟用」是兩件事，最後一節逐支登記。',
    '',
    '本檔裡的指令是**展示**：一格一格用空白隔開，含空白、引號、反斜線或換行的那一格用 JSON 字串寫（例如換行寫成 \\n）。不要把展示文字直接貼進終端機跑——那樣 \\n 會變成字面的反斜線加 n；執行一律用 settings.json 裡的陣列、經工具入口（搬家修正 r2 T6）。',
    '',
    '## 一、參與者識別值',
    '',
    '變更說明的「實作者」「獨立審查者」兩欄、結論標頭與自評的角色格，填的是這裡的識別值，不是職稱。',
    '',
    `值域：${plain(data.identityDomain, '識別值值域')}`,
    '',
    '| 參與者 | 識別值 | 貼文帳號 |',
    '|---|---|---|',
  ];
  for (const p of data.participants) {
    out.push(`| ${plain(p.role, '參與者角色')} | ${plain(p.id, '識別值')} | ${plain(p.account, '貼文帳號')} |`);
  }
  out.push('', `貼文帳號資格：${plain(data.accountRule, '貼文帳號資格')}`, '');
  out.push('## 二、來源字串標準表（結論標頭的來源欄；寫作義務：跨輪次一字不改、不含會變的東西）', '');
  out.push('| 審查工具或工作階段 | 逐字來源字串 |', '|---|---|');
  for (const s of data.sources) {
    out.push(`| ${plain(s.tool, '審查工具')} | ${plain(s.string, '來源字串')} |`);
  }
  out.push('', '## 三、清單與正本的位置', '');
  out.push('| 項目 | 規矩 | 位置 |', '|---|---|---|');
  for (const l of data.locations) {
    out.push(`| ${plain(l.item, '項目')} | ${plain(l.rules, '規矩條號')} | ${plain(l.where, '位置')} |`);
  }
  out.push('', `主幹分支名（原閘寫死 main，規矩 H2、H3、H4）：${plain(data.mainBranch, '主幹分支名')}`, '');
  out.push('## 四、掃描發射者（規矩 A1、G4）', '');
  out.push(`- 掃描器：${plain(data.scanner.tool, '掃描器')}（沒有掃描器＝每支的掃描紀錄寫「未執行：本專案無掃描器」，由下面指定的那一方記錄並轉正式）`);
  out.push(`- 誰指派、登記在哪：${plain(data.scanner.assignedBy, '掃描發射者的指派方式')}`);
  out.push(`- 兩方都起得了時：${plain(data.scanner.tieBreak, '平手規則')}`);
  out.push(`- 沒有合格者時，誰記錄未執行、誰轉正式：${plain(data.scanner.fallback, '無合格者時的替代')}`);
  const iso = data.scanner.isolation || {};
  if (!PROVIDERS.includes(iso.provider)) throw new Error(`隔離提供者「${iso.provider}」不在 ${PROVIDERS.join('／')} 裡`);
  const wrap = Array.isArray(iso.wrap) ? iso.wrap : [];
  const forbidden = Array.isArray(iso.forbidden) ? iso.forbidden : [];
  out.push('', '隔離（規矩 G2；裁示者 2026-09-12 裁「丙」：隔離本身不在套件裡，由這裡指定誰提供；套件只帶掃前試探與掃後比對兩支小工具）：', '');
  out.push(`- 由誰提供：${plain(iso.provider, '隔離提供者')}（「無」或「未設定」＝不掃，掃描紀錄寫「未執行：無隔離」）`);
  out.push(`- 從盒內跑一條指令的前綴（{box} 會換成盒子路徑、{projectRoot} 會換成專案根目錄）：${plain(wrap.length ? argvText(wrap) : '未設定', '隔離指令前綴')}`);
  out.push(`- 盒子建在：${plain(iso.boxRoot || '未設定', '盒子位置')}（未設定＝系統暫存區）`);
  out.push(`- 盒內必須讀不到也寫不進的目錄（~ 代表家目錄；試探在每一個各埋一個假機密）：${plain(forbidden.length ? forbidden.join('、') : '未設定', '禁區清單')}`);
  out.push('- 整條鏈（每一步退非零就停，掃描紀錄寫未執行）：');
  out.push('  1. node tools/scan-probe.js：任一禁區用它的讀寫機制碰得到＝隔離是假的，不掃；連試探都做不成（含盒內起不了那個機制）＝不掃。');
  out.push('  2. node tools/scan-probe.js --plant <清單檔>：在每個禁區埋一個掃描期間才有的假機密。清單檔不要貼進任何紀錄。');
  out.push('  3. 跑掃描器（本套件不代跑）。');
  out.push('  4. node tools/scan-postmortem.js --secrets <清單檔> --reply <回覆檔> --logs <日誌目錄>：假機密或未給盒子的真值出現在任何輸出（含檔名）＝事故。');
  out.push('  5. node tools/scan-probe.js --sweep <清單檔>：把埋下去的收掉。這一步一定要跑。');
  out.push('', '## 五、平台介面（規矩 E5、H1；閘要問平台的每一件事都走這裡）', '');
  out.push('套件只定「問什麼」與「答案長什麼樣」，每個動作填一條指令，指令要把答案印成約定形狀的 JSON。翻譯是這個專案的事，套件不碰任何平台的語彙。沒登記的動作被問到時一律不放行，不會回一個空答案假裝問過了。', '');
  out.push(`平台：${plain((data.platform && data.platform.name) || '未設定', '平台名稱')}；倉庫身分（指令裡的 {project}）：${plain((data.platform && data.platform.project) || '未設定', '倉庫身分')}；問平台前要清掉的選倉環境變數：${plain((data.platform && Array.isArray(data.platform.clearEnv) && data.platform.clearEnv.length) ? data.platform.clearEnv.join('、') : '（無）', '選倉環境變數')}`, '');
  out.push('| 動作 | 要問什麼 | 登記的指令 |', '|---|---|---|');
  const ops = (data.platform && data.platform.operations) || {};
  const unknown = Object.keys(ops).filter((k) => !(k in OPERATIONS));
  if (unknown.length) throw new Error(`平台介面登記了套件沒有定義的動作：${unknown.join('、')}`);
  for (const [name, op] of Object.entries(OPERATIONS)) {
    const cmd = Array.isArray(ops[name]) && ops[name].length ? argvText(ops[name]) : '未設定';
    out.push(`| ${plain(name, '動作名稱')} | ${plain(op.what, '動作說明')} | ${plain(cmd, `動作 ${name} 的指令`)} |`);
  }
  out.push('', '## 六、三關（規矩 E2、E3、H4；跨變更試合併閘在臨時樹裡跑的就是這幾條）', '');
  const checks = data.checks || {};
  const prep = Array.isArray(checks.prepareWorktree) ? checks.prepareWorktree : [];
  const cmds = Array.isArray(checks.commands) ? checks.commands : [];
  out.push(`- 臨時樹的準備指令（在新開的臨時樹裡跑一次，例如安裝相依；沒有就填「無」）：${plain(prep.length && prep[0] !== '未設定' ? argvText(prep) : (prep[0] || '未設定'), '臨時樹準備指令')}`);
  out.push('- 三關指令（依序跑、任一非零＝紅；每一條要自己保證執行環境跟合併後的樹一致——套件驗不到這件事）：');
  cmds.forEach((cmd, i) => {
    const argv = Array.isArray(cmd) ? cmd : [String(cmd)];
    out.push(`  ${i + 1}. ${plain(argvText(argv), `第 ${i + 1} 條三關指令`)}`);
  });
  // 兩個選填登記只排版、不驗值域（三關執行器跑的時候才驗，寫錯＝退 2）
  const mainWt = checks.mainWorktree === undefined ? '未設定' : checks.mainWorktree;
  const anchors = checks.indexAnchors === undefined ? ['未設定'] : checks.indexAnchors;
  out.push(`- 主目錄布局（只有三關執行器看；填「一般工作樹」＝從連結工作樹跑三關時，前後各問一次主目錄有沒有被判成裸倉庫、打不打得開；未設定＝不問）：${plain(mainWt, '主目錄布局')}`);
  out.push(`- 索引錨點（只有三關執行器看；填一串從根目錄算起的檔案路徑＝每一個都要在跑三關那棵樹的索引裡，前後各驗一次；未設定＝不驗）：${plain(Array.isArray(anchors) ? anchors.join('、') : anchors, '索引錨點')}`);
  out.push('', '## 七、禁區（規矩 B1；攔截器的判斷讀這裡，程式裡不寫任何禁區的名字）', '');
  const fb = data.forbidden || {};
  const joinList = (xs) => (Array.isArray(xs) && xs.length ? xs.join('、') : '（空）');
  out.push(`- 禁區叫什麼：${plain(fb.name || '未設定', '禁區名稱')}（未設定＝攔截器一律拒絕）`);
  out.push(`- 會動到禁區的連接器（白名單制）：${plain(joinList(fb.servers), '禁區連接器')}`);
  out.push(`- 那些連接器上准用的唯讀工具：${plain(joinList(fb.allowlist), '唯讀名單')}`);
  out.push(`- 逐字拒絕的工具名：${plain(joinList(fb.deny), '拒絕清單')}`);
  out.push(`- 家族網的動詞：${plain(joinList(fb.verbs), '動詞')}；名詞：${plain(joinList(fb.nouns), '名詞')}；唯讀前綴（豁免到哪一道、代價與射程＝「兩張樣式表」，正本＝\`docs/money-guard-two-pattern-tables.md\`，本檔不重述）：${plain(joinList(fb.readPrefixes), '唯讀前綴')}\n- 兩張樣式表的條數：額外樣式 ${fb.patterns ? fb.patterns.length : 0} 條、patternsReadSafe ${fb.patternsReadSafe ? fb.patternsReadSafe.length : 0} 條（分工＝見「兩張樣式表」）`);
  out.push(`- 額外樣式（patterns）：${plain(joinList(fb.patterns), '額外樣式')}`);
  out.push(`- 額外樣式（patternsReadSafe）：${plain(joinList(fb.patternsReadSafe), 'patternsReadSafe')}`);
  out.push('', '## 八、合併後驗收分級（規矩 H6；分級工具讀這裡，只算不擋）', '');
  const acc = data.acceptance || {};
  out.push('| 級別（從最重到最輕） | 動作 |', '|---|---|');
  for (const t of (acc.tiers || [])) out.push(`| ${plain(t.id, '級別')} | ${plain(t.action, '動作')} |`);
  out.push('', '| 路徑家族（正規式） | 級別 |', '|---|---|');
  for (const f of (acc.families || [])) out.push(`| ${plain(f.pattern, '路徑家族')} | ${plain(f.tier, '家族的級別')} |`);
  out.push('', `沒列到的路徑一律當：${plain(acc.unknownTier || '未設定', '未知路徑的級別')}`, '');
  out.push('## 九、忽略清單登記（規矩 B4、E7；考題比對每一份的生效樣式）', '');
  for (const l of (data.ignoreLists || [])) out.push(`- ${plain(l.file, '忽略檔')}：${plain(joinList(l.patterns), '忽略樣式')}`);
  out.push('', '## 十、合併步驟登記（規矩 H1；合併指令照這個順序跑，任一道紅就停）', '');
  out.push('| 順序 | 閘 | 規矩 | 指令 | 狀態 |', '|---|---|---|---|---|');
  (data.gates || []).forEach((gate, i) => {
    if (!STATES.includes(gate.state)) throw new Error(`閘「${gate.name}」的狀態「${gate.state}」不在 ${STATES.join('／')} 裡`);
    const cmd = argvText([gate.command, ...(gate.args || [])]);
    out.push(
      `| ${i + 1} | ${plain(gate.name, '閘名稱')} | ${plain(gate.rules, '閘對應的規矩')} | ${plain(cmd, '閘的指令')} | ${plain(gate.state, '閘的狀態')} |`,
    );
  });
  const merge = data.mergeCommand || {};
  const mergeCmd = argvText([merge.command, ...(merge.args || [])]);
  out.push('', `全綠之後執行的合併指令：${plain(mergeCmd, '合併指令')}`, '');
  out.push('合併指令認得的記號：{change}（變更編號）、{sha}（按鍵前核過的版本）、{project}（platform.project）、'
    + '{reviewer}（變更說明「獨立審查者」欄那一位）、{merger}（跑 node tools/merge.js <編號> --merger <識別值> 自報的那一位）。'
    + '帶上 {reviewer}／{merger} 合併紀錄才留得下誰審、誰合（H5）；帶上 {sha} 平台才會替你擋最後一刻被推上來的新版本。認不得的記號＝不放行。', '');
  out.push('⚠️ 沒有任何一道閘登記成「已啟用」時，合併指令不放行：一支什麼都沒檢查就按合併鍵的指令比沒有更危險。', '');
  out.push('## 十一、合併預授權（規矩 A5）', '');
  out.push(`${plain(data.mergeAuthorization, '合併預授權')}。預授權不取代 A5 列的其餘條件。`, '');
  out.push('## 十二、機器啟用狀態（逐支登記；「已啟用」以外的一律當靠自覺）', '');
  out.push('| 機器 | 規矩 | 狀態 | 驗過的日期 |', '|---|---|---|---|');
  for (const m of data.machines) {
    if (!STATES.includes(m.state)) throw new Error(`機器「${m.name}」的狀態「${m.state}」不在 ${STATES.join('／')} 裡`);
    out.push(
      `| ${plain(m.name, '機器名稱')} | ${plain(m.rules, '機器對應的規矩')} | ${plain(m.state, '啟用狀態')} | ${plain(m.verified, '驗過的日期', { allowEmpty: true })} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

if (require.main === module) {
  const data = read();
  fs.writeFileSync(outFile, build(data), 'utf8');
  process.stdout.write(`寫好 PROJECT-SETTINGS.md：${data.machines.length} 支機器\n`);
}

module.exports = { build, read, dataFile, outFile, STATES, PROVIDERS };
