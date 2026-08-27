// 信用卡帳單「這是誰印的」判準的專卷（`lib/card-identity.js` ＋ `parseStatementFromLines/Xlsx` 的分流）。
//
// ## 兩條全卷通用的規矩（違反這兩條就是這個 repo 反覆踩到的假綠）
//
// ① **每一份負向 fixture 都要在同一題裡附「到達性前提」**——先斷言「這份 fixture 確實會被寬鬆列判準
//    抓到列」，否則這題可能什麼都沒證明（前一版 `test/statement-parsers.test.js:94` 的 `other`
//    就是這樣的空包彈：第二列只有一格，被 `cells.length < 3` 當場擋掉，永遠走不到日期判準）。
// ② **每個斷言都連 `{code, bank, bankEvidence, rows.length}` 四個值一起斷**——只斷 code 會讓
//    「忘了丟棄列」那顆突變活下來。
//
// ⚠️ 本卷刻意**不需要任何真帳單**：判準全部關在吃 `string[][]` / `any[][]` 的匯出純函式裡。
//    需要走真 PDF 的那三題用 `test/helpers/build-pdf.js` 合成（「PDF 合成不了」那句劃界已被推翻）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeTxRow, evidenceRows, identifyIssuer, assertCardIdentityInvariants,
  OWN_ISSUERS, OTHER_ISSUERS,
} from '../lib/card-identity.js';
import {
  parseStatementFromLines, parseStatementFromXlsx, parseStatement,
  parseFubon, parseTaishinPdf, CARD_UNRECOGNIZED_MSG,
} from '../lib/statement.js';
import { cjkPdf, nonStatementPdf } from './helpers/build-pdf.js';

/** 抓住丟出來的錯（⚠️ `assert.throws()` 回傳的是 undefined，不是那顆錯）。 */
function grab(fn) {
  try { fn(); } catch (e) { return /** @type {any} */ (e); }
  throw new assert.AssertionError({ message: '預期會丟錯，但它沒有丟' });
}

/** 跑一遍分流，把四個值攤成同一種形狀（規矩②：四個值一起斷）。 */
function run(lines) {
  try {
    const r = parseStatementFromLines(lines);
    return { code: null, bank: r.bank, bankEvidence: r.bankEvidence, rows: r.transactions.length };
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (!err?.code) throw e;   // 非預期的錯不要被吞掉
    return { code: err.code, status: err.status, bank: '', bankEvidence: 'none', rows: 0 };
  }
}

// ── fixtures（每一份都只在「機構名那一格」不同，其餘逐字相同 → 見 B2）────────────────
const TAISHIN = () => [
  ['台新國際商業銀行', '信用卡消費明細'],
  ['115/06/02', '115/06/04', '星巴克', '150'],
  ['115/06/05', '115/06/07', '全聯福利中心', '320'],
];
/** 只換第 0 列第 0 格的機構名，其餘逐字不動。 */
const swapIssuer = (/** @type {string} */ name) => {
  const f = TAISHIN(); f[0] = [name, f[0][1]]; return f;
};

test('A1 台新式正向：掛得上機構名、證據是 header、列照給', () => {
  assert.deepEqual(run(TAISHIN()), { code: null, bank: '台新', bankEvidence: 'header', rows: 2 });
});

test('A2 富邦式正向（郵寄版與官網換行版各一）', () => {
  const posted = [
    ['台北富邦銀行 信用卡帳單'],
    ['消費日', '消費說明', '入帳日', '金額'],
    ['115/07/03', '家樂福內湖店', '115/07/05', '1,250'],
  ];
  assert.deepEqual(run(posted), { code: null, bank: '富邦', bankEvidence: 'header', rows: 1 });
  // 官網版：交易列沒有說明，說明「換行」到下一列 → 那一列會被 parseFubon 消耗掉（used），
  // 所以它上面的字**不可以**成為機構名證據（這正是 D2 要釘的事，這裡先確認正向仍讀得到）。
  const online = [
    ['台北富邦銀行 信用卡帳單'],
    ['115/07/03', '115/07/05', 'TWD', '1,250'],
    ['家樂福內湖店'],
  ];
  const r = run(online);
  assert.equal(r.code, null);
  assert.equal(r.bank, '富邦');
  assert.equal(r.bankEvidence, 'header');
  assert.ok(r.rows >= 1, '官網換行版仍要讀得到交易');
});

test('B1 ★單變因位移對：只把機構名換成別家，結果必須翻面（整份丟棄）', () => {
  assert.deepEqual(run(TAISHIN()), { code: null, bank: '台新', bankEvidence: 'header', rows: 2 });
  const other = swapIssuer('玉山商業銀行');
  // 到達性前提（規矩①）：這份 fixture 的交易列**確實**被寬鬆列判準抓得到——
  // 沒有這一句，「丟棄」可能只是因為它本來就 0 列，這題就什麼都沒證明。
  assert.equal(parseTaishinPdf(other).length, 2, '前提：換掉機構名不影響列判準，仍抓得到 2 列');
  assert.deepEqual(run(other), { code: 'card_unrecognized', status: 400, bank: '', bankEvidence: 'none', rows: 0 });
});

test('B2 ★對照組自檢：B1 兩份文件除了機構名那一格以外必須逐字相等', () => {
  // 2026-08-23 #506/#507 的教訓：對照組自己漂掉時，實驗量到的是別的變因。
  const a = TAISHIN(), b = swapIssuer('玉山商業銀行');
  assert.equal(a.length, b.length);
  assert.notEqual(a[0][0], b[0][0], '變因就是這一格');
  assert.deepEqual(a[0].slice(1), b[0].slice(1), '第 0 列的其餘格必須相同');
  for (let i = 1; i < a.length; i++) assert.deepEqual(a[i], b[i], `第 ${i} 列必須逐字相同`);
});

test('C1 遠東式：內建解析器抓得到列，但證據指向別家 ⇒ 整份丟棄', () => {
  const f = [['遠東國際商業銀行 信用卡帳單'], ['115/07/01', '115/07/03', '麥當勞', '88']];
  assert.equal(parseTaishinPdf(f).length, 1, '前提：台新解析器真的把它讀成 1 筆（今天會貼上「台新」標籤送出去）');
  assert.deepEqual(run(f), { code: 'card_unrecognized', status: 400, bank: '', bankEvidence: 'none', rows: 0 });
});

test('C2 國泰四欄式：富邦解析器抓得到 2 筆乾淨交易 ⇒ 整份丟棄', () => {
  const f = [
    ['國泰世華銀行 信用卡帳單'],
    ['消費日', '摘要', '入帳日', '金額'],
    ['115/07/03', '家樂福內湖店', '115/07/05', '1,250'],
    ['115/07/11', 'UBER TRIP', '115/07/13', '260'],
  ];
  assert.equal(parseFubon(f).length, 2, '前提：富邦解析器真的把它讀成 2 筆（今天會貼上「富邦」標籤送出去）');
  assert.deepEqual(run(f), { code: 'card_unrecognized', status: 400, bank: '', bankEvidence: 'none', rows: 0 });
});

test('D1 ★商店名沒有投票權：台新帳單刷了兩次「富邦人壽」仍判台新', () => {
  const f = [
    ['台新國際商業銀行 信用卡帳單'],
    ['115/06/02', '115/06/04', '富邦人壽保險費', '3,000'],
    ['115/06/05', '115/06/07', '富邦人壽保險費', '3,000'],
  ];
  // 這正是真實踩到的形狀：使用者的帳單刷了富邦人壽保費，舊做法「數全文行名」會判成富邦。
  assert.deepEqual(run(f), { code: null, bank: '台新', bankEvidence: 'header', rows: 2 });
});

test('D2 ★被解析器當成換行說明吃掉的那一列，也不得成為機構名證據', () => {
  const f = [
    ['信用卡帳單'],                       // 刻意不印任何機構名
    ['115/07/03', '115/07/05', 'TWD', '1,250'],
    ['富邦人壽保險費扣繳'],                 // ← 換行說明，會被 parseFubon 消耗
  ];
  const used = new Set();
  assert.equal(parseFubon(f, used).length, 1, '前提：這份真的走到「換行說明」那條路');
  assert.ok(used.has(2), '前提：說明列（索引 2）確實被解析器記成「我用掉了」');
  const r = run(f);
  assert.equal(r.bank, '', '說明列上的「富邦」不算證據 ⇒ 不掛機構名');
  assert.equal(r.bankEvidence, 'none');
  assert.equal(r.code, null, '不掛機構名不等於丟棄——列照給，只是不自動歸卡');
});

test('E1b ★「解析器不吃、但看起來像交易列」的列也不算證據（used 擋不到這一格）', () => {
  // ⚠️ 這題補的是突變測試找到的洞：E1 的商店名那一列**已經被 used 擋掉**，所以
  //    `looksLikeTxRow` 那一層在 E1 裡不承重——拿掉它，E1 照樣綠。
  //    這裡用**西元日期**：兩支解析器都要民國日期（parseTaishinPdf 前兩格、parseFubon 首格），
  //    所以這一列不會被消耗；但 `looksLikeTxRow` 認西元日期 ⇒ 它仍然不算證據。
  // ⚠️ 順序有講究：這一列要放在交易列**前面**。放後面的話 parseFubon 會把它當成
  //    「換行的消費說明」吃掉（實測 used = {1,2}），於是又變成 used 在擋 ⇒ 這題白寫。
  const f = [
    ['台新國際商業銀行 信用卡消費明細'],
    ['2026/06/10', '玉山銀行ATM跨行提款', '150'],   // ← 解析器不吃（西元日期），但長得像交易列
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ];
  const used = new Set();
  parseTaishinPdf(f, used); parseFubon(f, used);
  assert.ok(!used.has(1), '前提：這一列**沒有**被任何解析器消耗（所以 used 擋不到它）');
  assert.ok(looksLikeTxRow(f[1]), '前提：它確實長得像交易列');
  assert.deepEqual(run(f), { code: null, bank: '台新', bankEvidence: 'header', rows: 1 },
    '★那一列上的「玉山銀行」不得成為證據——否則會觸發否證器、整份被丟棄');
});

test('E1 ★同一個行名，位置不同結果必須相反', () => {
  // 在「解析器沒消耗、又不像交易列」的列上 ⇒ 算證據
  const asHeader = [['台新國際商業銀行'], ['115/06/02', '115/06/04', '星巴克', '150']];
  // 同一個字，放在交易列裡當店名 ⇒ 不算證據
  const asMerchant = [['信用卡帳單'], ['115/06/02', '115/06/04', '台新銀行ATM手續費', '15']];
  assert.equal(run(asHeader).bank, '台新');
  assert.equal(run(asMerchant).bank, '', '同一個「台新」落在交易列上就不算證據');
});

test('F1 台新空帳單（摘要讀得到、0 列）→ card_unrecognized，不再假裝分得出「這期沒交易」', () => {
  const f = [['台新國際商業銀行'], ['本期應繳總額', '1,100'], ['上期應繳總額', '1,000']];
  assert.equal(parseTaishinPdf(f).length + parseFubon(f).length, 0, '前提：這份確實 0 列');
  assert.deepEqual(run(f), { code: 'card_unrecognized', status: 400, bank: '', bankEvidence: 'none', rows: 0 });
});

test('F2 ★通用行業用語不再讓別家被告知「這期沒有交易」', () => {
  // 舊判準：讀得到摘要四格任一格 ⇒ 回 card_no_rows（訊息說「認得出版面…可能是這一期沒有交易」）。
  // 那八個鍵全是全台通用用語，於是**多數別家使用者**都會收到一句關於自己的錢的假話。
  const f = [['玉山商業銀行 信用卡對帳單'], ['本期應繳總額', '5,678']];
  assert.deepEqual(run(f), { code: 'card_unrecognized', status: 400, bank: '', bankEvidence: 'none', rows: 0 });
});

test('F3 ★連「條款樣板」都會被舊判準讀成金額——同樣不得說「這期沒有交易」', async () => {
  const { extractStatementTotals } = await import('../lib/statement.js');
  const s = '最低應繳金額為本期應繳金額之10%加計各項費用';
  assert.equal(extractStatementTotals(s).due, 10, '前提：這句每家都印的條款樣板確實被讀成 due=10');
  assert.deepEqual(run([[s]]), { code: 'card_unrecognized', status: 400, bank: '', bankEvidence: 'none', rows: 0 });
});

test('F4/F5 XLSX 與 PDF 兩條路：同一個 code、同一句訊息（不准分岔）', () => {
  const pdfErr = grab(() => parseStatementFromLines([['隨便什麼字']]));
  const xlsxErr = grab(() => parseStatementFromXlsx([['交易日期', '入帳日']], '交易日期'));
  assert.equal(pdfErr.code, 'card_unrecognized');
  assert.equal(xlsxErr.code, 'card_unrecognized');
  assert.equal(pdfErr.message, xlsxErr.message, '兩條路的文案必須是同一個常數');
  assert.equal(pdfErr.message, CARD_UNRECOGNIZED_MSG);
  // 訊息必須把兩種可能並陳——不可以只講其中一種（那就是說謊的那一版）。
  assert.match(CARD_UNRECOGNIZED_MSG, /沒有消費/);
  assert.match(CARD_UNRECOGNIZED_MSG, /讀不動/);
});

test('G1 ★不變量掃過全卷樣本：丟錯就不得交出列或機構名、掛名就得說得出證據', () => {
  const samples = [TAISHIN(), swapIssuer('玉山商業銀行'), [['信用卡帳單'], ['115/06/02', '115/06/04', '星巴克', '150']], [['x']]];
  for (const f of samples) {
    const r = run(f);
    if (r.code) { assert.equal(r.rows, 0); assert.equal(r.bank, ''); }
    if (r.bank !== '') assert.notEqual(r.bankEvidence, 'none');
    if (r.bankEvidence === 'none') assert.equal(r.bank, '');
  }
});

test('G2 ★不變量是 throw 不是夾正（沒有這一題，G1 會變成恆真）', () => {
  assert.throws(() => assertCardIdentityInvariants({ bank: '台新', bankEvidence: 'none', rows: [] }), /不變量/);
  assert.throws(() => assertCardIdentityInvariants({ bank: '玉山', bankEvidence: 'header', rows: [] }), /不在內建範本清單/);
  assert.throws(() => assertCardIdentityInvariants({ bank: '', bankEvidence: 'none', rows: [1], code: 'card_unrecognized' }), /不得同時交出列/);
  assert.throws(() => assertCardIdentityInvariants({ bank: '', bankEvidence: '亂寫', rows: [] }), /不是已知的三種/);
  // 正向：合法組合不得丟
  assert.doesNotThrow(() => assertCardIdentityInvariants({ bank: '台新', bankEvidence: 'header', rows: [1] }));
  assert.doesNotThrow(() => assertCardIdentityInvariants({ bank: '', bankEvidence: 'none', rows: [], code: 'card_unrecognized' }));
});

test('H1/H3 ★端到端走真 PDF：讀不動的檔必須丟錯，不得靜靜回報「成功、0 筆」', async () => {
  // 這一題殺的是「把 parseStatementFromLines 裡那行 throw 刪掉」——前一版因為誤信
  // 「PDF 合成不了」而沒有這題，於是刪掉整行、全套 2792 題照樣全綠。
  await assert.rejects(() => parseStatement(nonStatementPdf()), (e) => {
    const err = /** @type {any} */ (e);
    assert.equal(err.code, 'card_unrecognized');
    assert.equal(err.status, 400);
    return true;
  });
  // 別家中文帳單（讀得到列、但證據指向別家）走真 PDF 也要丟
  await assert.rejects(() => parseStatement(cjkPdf(swapIssuer('玉山商業銀行'))), (e) => {
    assert.equal(/** @type {any} */ (e).code, 'card_unrecognized');
    return true;
  });
});

test('H2 ★端到端正向：真 PDF 讀得出來時，機構名與證據都要一路帶到回傳值', async () => {
  const r = await parseStatement(cjkPdf(TAISHIN()));
  assert.equal(r.bank, '台新');
  assert.equal(r.bankEvidence, 'header', '接線把 bankEvidence 漏掉的話這裡會是 undefined');
  assert.equal(r.transactions.length, 2);
});

test('I1 XLSX 只有表頭列（0 筆）→ card_unrecognized', () => {
  const r = grab(() => parseStatementFromXlsx([['消費日期', '入帳日', '消費明細']], '消費日期'));
  assert.equal(r.code, 'card_unrecognized');
  assert.equal(r.status, 400);
});

test('I2 XLSX 台新官網欄序：正常解析、機構名台新、證據標成較弱的 xlsx-template', () => {
  const rows = [
    ['消費日期', '入帳日期', '消費明細', '幣別', '金額', '', '', ''],
    ['2026/07/03', '2026/07/05', '家樂福內湖店', 'TWD', 1250, '', '', ''],
  ];
  const r = parseStatementFromXlsx(rows, '本期應繳總額 1,250');
  assert.equal(r.bank, '台新');
  assert.equal(r.bankEvidence, 'xlsx-template', '★XLSX 的身分是靠欄位位置認的，比 header 弱——型別上就要看得出來');
  assert.equal(r.transactions.length, 1);
});

test('I3 ★documenting test：別家 XLSX 欄序不同會靜靜抄錯欄（已知缺口，本支不修）', () => {
  // ⚠️ 這題**釘住現況、不宣稱已修好**。`parseTaishinXlsxRows` 讀的是第 0/2/4 欄的位置，
  //    沒有任何欄名比對，所以欄序一換就抄到別欄。改成依欄名定位要有真檔的表頭字面 ⇒ 留給後續批次。
  //    有人以為修好了而動這裡時，這題會紅並讀到這段理由。
  const rows = [
    ['交易日期', '入帳日', '幣別', '商店名稱', '手續費', '消費金額'],
    ['2026/07/03', '2026/07/05', 'TWD', '家樂福內湖店', 15, '1,250'],
  ];
  const r = parseStatementFromXlsx(rows, '');
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0].amount, 15, '★現況：把「手續費 15」當成消費金額（1,250 那筆錢讀丟了）');
  assert.notEqual(r.transactions[0].amount, 1250, '★若這行開始紅，代表有人修好了欄名定位——請一起更新本題與契約');
});

test('K1 ★表格自檢：否證器不得與自家撞號（雙向子字串檢查）', () => {
  // 有人把「台北富邦」塞進否證器清單 ⇒ 自家帳單自己觸發否證器 ⇒ 富邦使用者全掉。
  for (const o of OTHER_ISSUERS) {
    for (const own of OWN_ISSUERS) {
      assert.ok(!own.re.test(o), `否證器「${o}」命中自家樣式 ${own.bank}`);
    }
  }
});

test('K2 ★表格自檢：否證器不得含通用詞（含了就是每一份帳單都被否證）', () => {
  const GENERIC = ['銀行', '商業銀行', '信用卡', '本期', '上期', '應繳', '金額', '對帳單', '明細', '消費'];
  for (const o of OTHER_ISSUERS) {
    assert.ok(!GENERIC.includes(o), `否證器「${o}」是通用詞`);
    assert.ok(o.length >= 3, `否證器「${o}」太短＝容易誤觸發`);
  }
});

test('零件｜looksLikeTxRow：三格以上＋有日期樣＋有金額樣才算交易列（刻意比解析器寬）', () => {
  assert.ok(looksLikeTxRow(['115/06/02', '星巴克', '150']));
  assert.ok(looksLikeTxRow(['2026/06/02', '星巴克', '150']), '西元日期也算——排除證據時寧可寬');
  assert.ok(!looksLikeTxRow(['115/06/02', '150']), '只有兩格不算');
  assert.ok(!looksLikeTxRow(['台新國際商業銀行', '信用卡消費明細', '第 1 頁']), '沒有金額樣不算');
  assert.ok(!looksLikeTxRow(['上期應繳總額', '本期應繳總額', '1,000']), '沒有日期樣不算 ⇒ 摘要列仍是合法證據來源');
});

test('零件｜evidenceRows：回**逐列**字串、只取表頭區（跨列拼字在結構上不可能）', () => {
  // 兩列各自都**不含**任何行名，但列尾＋列頭可以拼出「台新」——這正是 r1#1a 的真實形狀。
  const lines = [['電子服務平', '台'], ['新', '戶刷卡禮'], ['115/06/02', '星巴克', '150']];
  const used = new Set([2]);
  const rows = evidenceRows(lines, used);
  assert.ok(Array.isArray(rows), '★必須回陣列——回一整串就是把跨列通道打開');
  assert.deepEqual(rows, ['電子服務平台', '新戶刷卡禮'], '同一列內黏起來（台新把標題逐字拆開），列與列之間不黏');
  assert.ok(rows.every((t) => !/台新/.test(t)), '前提：沒有任何**單一列**含「台新」');
  assert.ok(/台新/.test(rows.join('')), '前提：但併起來就有——所以這題真的在考跨列通道');
  // ⚠️ 這裡刻意用 `join('')` 而不是 `join('\n')`：換行只擋得住**沒有 `\s` 的**正規式，
  //    而 r1#1a 打穿的正是 `/台\s*新/`（`\s` 吃換行）。真正的保護是**逐列比對**這個結構，
  //    不是分隔字元——所以前提要用「最寬鬆的併法」來陳述危害。
  // ★真正的斷言：**走判準本身**，不是只看字串裡有沒有那幾個字。
  //   前一版這題只 assert.match(text, /富邦/)，題名寫「不跨列拼行名」而斷言只看字面 ⇒ 題名大於斷言。
  assert.equal(identifyIssuer(lines, used).bank, '', '★兩列不得被拼成一個行名');
});

test('零件｜identifyIssuer：兩家自家都命中＝不猜（fail-closed 到「不掛名」）', () => {
  const both = identifyIssuer([['台新銀行與台北富邦銀行聯名卡']], new Set());
  assert.deepEqual(both.own.sort(), ['台新', '富邦']);
  assert.equal(both.bank, '');
  assert.equal(both.bankEvidence, 'none');
});


// ── Codex #518 r1 的四個實測案例，一條一題 ──────────────────────────────────

test('★r1#1a 跨列拼行名：正規式的 \\s 曾經吃掉換行，把兩列拼成「台新」', () => {
  // Codex 實測：`/台\s*新/` 比對 `evidenceText` 的 join('\n') 整串時，
  // 「電子服務平**台**」＋「**新**戶刷卡禮」→ 拼成「台新」⇒ 臺中商銀帳單掛上台新標籤並自動歸卡。
  const f = [
    ['臺中商業銀行信用卡帳單'],
    ['電子服務平台'],
    ['新戶刷卡禮'],
    ['115/07/03', '一般商店', '115/07/05', '100'],
  ];
  assert.equal(parseFubon(f).length, 1, '前提：這份確實被寬鬆列判準抓到 1 列（不是「反正 0 列」）');
  const r = run(f);
  assert.notEqual(r.bank, '台新', '★兩列不得被拼成一個行名');
  assert.deepEqual(r, { code: 'card_unrecognized', status: 400, bank: '', bankEvidence: 'none', rows: 0 },
    '★證據列印的是臺中商銀 ⇒ 否證器命中 ⇒ 整份丟棄');
});

test('★r1#1b 明細區後面的商店續行不得重獲投票權（前一版「不像交易列」擋不住它）', () => {
  // Codex 實測：最後那一列既不在 used、也不符合 looksLikeTxRow ⇒ 前一版讓它成為證據 ⇒ 判成富邦。
  const f = [
    ['信用卡帳單'],                        // 刻意不印機構名，讓證據只可能來自下面那一列
    ['115/07/03', '一般店', '115/07/05', '100'],
    ['富邦人壽保險費'],                     // ← 明細區的續行＝商店名
  ];
  const used = new Set();
  parseFubon(f, used); parseTaishinPdf(f, used);
  assert.ok(!used.has(2), '前提：這一列沒有被任何解析器消耗');
  assert.ok(!looksLikeTxRow(f[2]), '前提：它也不長得像交易列——所以前一版的兩層過濾都擋不到它');
  assert.equal(run(f).bank, '', '★它在第一筆交易列**之後**，不是表頭區 ⇒ 沒有投票權');
});

test('★r1#1c 富邦只認「台北富邦」——裸的「富邦」／Fubon 不算（香港富邦也發卡）', () => {
  // lib/bank-alias.js:17 自己就記著「富邦香港 vs 台北富邦」是已知撞名危害。
  assert.equal(identifyIssuer([['台北富邦銀行 信用卡帳單']], new Set()).bank, '富邦');
  assert.equal(identifyIssuer([['富邦銀行（香港）有限公司 信用卡月結單']], new Set()).bank, '',
    '★香港富邦不得被當成台北富邦（認錯家＝自動歸到錯的卡）');
  assert.equal(identifyIssuer([['Fubon Bank (Hong Kong) Limited']], new Set()).bank, '');
});

// ★r1#2（末四碼不得繞過分支④）是服務層的事，端到端題在 test/statement-pipeline.test.js 的 J3。
//   這裡刻意**不**放「掃原始碼字樣」的形狀釘——那種斷言在別處也會命中，是這個 repo 記過的假綠來源。


test('★r1#3 認出是哪一家就要用那一家的解析器（不可只比筆數）', () => {
  // Codex 實測：兩支各抓一筆 ⇒ 平手 ⇒ 舊寫法取富邦，說明變成「謹慎理財信用至上（星巴克）」，
  // 標籤卻仍是台新 ⇒ 畫面說台新、資料是富邦解析器讀的。
  const f = [['台新銀行'], ['115/06/02', '115/06/05', '星巴克', '150'], ['謹慎理財信用至上']];
  assert.equal(parseTaishinPdf(f).length, 1, '前提：台新解析器抓到 1 筆');
  assert.equal(parseFubon(f).length, 1, '前提：富邦解析器也抓到 1 筆（平手）');
  const r = parseStatementFromLines(f);
  assert.equal(r.bank, '台新');
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0].desc, '星巴克', '★機構名與明細必須出自同一支解析器');
});

test('★r1 補洞：台新「向相鄰列借說明」時，那一列也必須記進 used', () => {
  // Codex 指出：拿掉 parseTaishinPdf 的 used.add(descIdx)，既有考題仍全綠。
  const f = [['台新銀行'], ['星巴克'], ['115/06/02', '115/06/05', '150']];
  const used = new Set();
  const raw = parseTaishinPdf(f, used);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].desc, '星巴克', '前提：說明確實是向上一列借的');
  assert.ok(used.has(1), '★借來當說明的那一列＝已消耗，不得再有投票權');
  assert.ok(used.has(2), '交易列自己也要記');
});
