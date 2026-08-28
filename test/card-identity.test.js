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
  parseFubon, parseTaishinPdf, parseTaishinXlsxRows, parsePdfAuto, CARD_UNRECOGNIZED_MSG,
} from '../lib/statement.js';
import { cjkPdf, nonStatementPdf } from './helpers/build-pdf.js';

/** 抓住丟出來的錯（⚠️ `assert.throws()` 回傳的是 undefined，不是那顆錯）。 */
function grab(fn) {
  try { fn(); } catch (e) { return /** @type {any} */ (e); }
  throw new assert.AssertionError({ message: '預期會丟錯，但它沒有丟' });
}

/**
 * 跑一遍分流，把四個值攤成同一種形狀（規矩②：四個值一起斷）。
 *
 * ⚠️ 錯誤路徑上的四個值**必須從實作真的產生的東西讀**，不可以寫死（Grok 2026-08-27 掃出）：
 *    前一版在 catch 裡直接回 `bank:'' / bankEvidence:'none' / rows:0`，於是「解析器忘了丟列
 *    但仍然 throw」這種壞法在四個值上**看起來一模一樣** ⇒ 規矩②對錯誤路徑是演戲。
 *    丟出來的 Error 本身帶不了這些欄位，所以改成回頭問 `parsePdfAuto`——它才是真正決定
 *    「交出幾列、掛不掛機構名」的地方。
 */
function run(lines) {
  try {
    const r = parseStatementFromLines(lines);
    return { code: null, bank: r.bank, bankEvidence: r.bankEvidence, rows: r.transactions.length };
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (!err?.code) throw e;   // 非預期的錯不要被吞掉
    const p = parsePdfAuto(lines);   // ★實作真的產生了什麼（不是我在測試裡假設的）
    return { code: err.code, status: err.status, bank: p.bank, bankEvidence: p.bankEvidence, rows: p.raw.length };
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
  // ⚠️ 說明列要挑一個**現行樣式真的會命中**的名字（Codex r3#3 指出「富邦人壽」已不命中 ⇒ 這題空心）。
  const f = [
    ['信用卡帳單'],                       // 刻意不印任何機構名
    ['115/07/03', '115/07/05', 'TWD', '1,250'],
    ['台新銀行代收保險費'],                 // ← 換行說明，會被 parseFubon 消耗
  ];
  const used = new Set();
  assert.equal(parseFubon(f, used).length, 1, '前提：這份真的走到「換行說明」那條路');
  assert.ok(used.has(2), '前提：說明列（索引 2）確實被解析器記成「我用掉了」');
  const r = run(f);
  assert.equal(identifyIssuer([f[2]], new Set()).bank, '台新',
    '前提：那個說明單獨拿去判會命中台新 ⇒ 本題真的踩得到那條路');
  assert.deepEqual(r, { code: null, bank: '', bankEvidence: 'none', rows: 1 },
    '★四值一起斷：說明列上的行名不算證據 ⇒ 不掛機構名，但列照給（不是丟棄）');
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
  // 在「第一筆交易列之前」的表頭列上 ⇒ 算證據
  const asHeader = [['台新國際商業銀行'], ['115/06/02', '115/06/04', '星巴克', '150']];
  // 同一個字，放在交易列裡當店名 ⇒ 不算證據
  const asMerchant = [['信用卡帳單'], ['115/06/02', '115/06/04', '台新銀行ATM手續費', '15']];
  assert.deepEqual(run(asHeader), { code: null, bank: '台新', bankEvidence: 'header', rows: 1 });
  assert.deepEqual(run(asMerchant), { code: null, bank: '', bankEvidence: 'none', rows: 1 },
    '★四值一起斷：同一個「台新」落在交易列上就不算證據，但列照給（不是丟棄）');
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
  // ★題名說的是「不再被告知這期沒有交易」——斷言就要打在**訊息**上，不能只斷 code。
  //   ⚠️ 這一份是 0 列，走的是 `CARD_UNRECOGNIZED_MSG`（兩種可能並陳，合法）。
  //      「讀到列卻說沒消費」那條在下面的 r5#1（分支②）。
  assert.match(grab(() => parseStatementFromLines(f)).message, /讀不動/, '★必須並陳「可能讀不動」，不可以只講沒消費');
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
  assert.throws(() => assertCardIdentityInvariants({ bank: '', bankEvidence: '亂寫', rows: [] }), /不是已知的兩種/);
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

test('I2 XLSX 走與 PDF 相同的身分判準：表頭印了機構名才掛名', () => {
  const rows = [
    ['台新銀行 2026/07 信用卡明細'],
    ['消費日期', '入帳日期', '消費明細', '幣別', '金額', '', '', ''],
    ['2026/07/03', '2026/07/05', '家樂福內湖店', 'TWD', 1250, '', '', ''],
  ];
  const r = parseStatementFromXlsx(rows, '本期應繳總額 1,250');
  assert.equal(r.bank, '台新');
  assert.equal(r.bankEvidence, 'header', '★XLSX 也用同一套證據——不再有「弱證據型別」這種東西');
  assert.equal(r.transactions.length, 1);
});

test('★I2b XLSX 表頭印了**別家**：整份丟棄（欄序碰巧對上不代表是我們認得的版面）', () => {
  // Grok 2026-08-27 掃出：`parseTaishinXlsxRows` **純靠欄位位置**（第 0 欄日期、第 4 欄金額、
  // 第 2 欄說明），零身分檢查 ⇒ 別家 XLSX 欄序碰巧對上就會被標成台新並自動歸卡。
  const rows = [
    ['玉山銀行 信用卡消費明細'],
    ['消費日期', '入帳日期', '消費明細', '幣別', '金額', '', '', ''],
    ['2026/07/03', '2026/07/05', '家樂福內湖店', 'TWD', 1250, '', '', ''],
  ];
  assert.equal(parseTaishinXlsxRows(rows).length, 1, '前提：欄序對得上，解析器真的讀出 1 列（不是「反正 0 列」）');
  const e = grab(() => parseStatementFromXlsx(rows, ''));
  assert.equal(e.code, 'card_unrecognized');
  assert.match(e.message, /玉山銀行/, '★要講出是誰的帳單，不可以說「找不到消費明細」');
});

test('★I2c XLSX 表頭什麼機構名都沒印：列照給但不掛名（分支④）', () => {
  const rows = [
    ['帳單明細'],
    ['消費日期', '入帳日期', '消費明細', '幣別', '金額', '', '', ''],
    ['2026/07/03', '2026/07/05', '家樂福內湖店', 'TWD', 1250, '', '', ''],
  ];
  const r = parseStatementFromXlsx(rows, '');
  assert.equal(r.bank, '', '★認不出就不猜');
  assert.equal(r.bankEvidence, 'none');
  assert.equal(r.transactions.length, 1, '列照給');
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
  assert.notEqual(r.transactions[0].amount, 1250,
    '★若這行開始紅，**先確認是哪一種**：①有人做出了依欄名定位（好事，請一起更新本題與契約）'
    + '②有人只是改了寫死的欄位索引（那不是修好，只是換一種猜法）。硬改索引也會讓這行紅。');
});

test('K1 ★表格自檢：否證器不得與自家撞號（雙向子字串檢查）', () => {
  // 有人把「台北富邦」塞進否證器清單 ⇒ 自家帳單自己觸發否證器 ⇒ 富邦使用者全掉。
  for (const o of OTHER_ISSUERS) {
    for (const own of OWN_ISSUERS) {
      assert.ok(!own.re.test(o), `否證器「${o}」命中自家樣式 ${own.bank}`);
      // ★反方向（題名說「雙向」，前一版只有上面那半 ⇒ 題名大於斷言）：
      //   自家的**典型抬頭**不得含任何否證器字串，否則自家帳單會自己觸發否證器。
      const typical = own.bank === '台新' ? ['台新銀行信用卡帳單', 'Richart信用卡帳單']
        : ['台北富邦銀行信用卡帳單', '台北富邦商業銀行'];
      for (const t of typical) assert.ok(!t.includes(o), `自家抬頭「${t}」含否證器字串「${o}」`);
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

test('零件｜looksLikeTxRow：判準看「整列文字切出來的詞」，不是「格」（刻意往寬倒）', () => {
  assert.ok(looksLikeTxRow(['115/06/02', '星巴克', '150']));
  assert.ok(looksLikeTxRow(['2026/06/02', '星巴克', '150']), '西元日期也算——分界判太寬是安全方向');
  assert.ok(looksLikeTxRow(['115/07/01 星巴克', '100']),
    '★抽字把日期與商店塞進同一格（只有兩格）仍算交易列——前一版要求「至少三格」，於是分界往後滑、商店續行重獲投票權');
  assert.ok(looksLikeTxRow(['115/06/02', '150']), '★只有日期＋金額兩個詞也算（同上，往寬倒）');
  assert.ok(!looksLikeTxRow(['台新國際商業銀行', '信用卡消費明細']), '沒有日期也沒有金額＝不是交易列');
  assert.ok(!looksLikeTxRow(['上期應繳總額', '本期應繳總額', '1,000']), '★沒有日期樣＝摘要列仍是合法證據來源');
  assert.ok(!looksLikeTxRow(['帳單結帳日', '115/07/04', '繳款截止日', '115/07/20']), '只有日期、沒有金額＝表頭列');
  assert.ok(!looksLikeTxRow(['台', '新', '銀', '行', '綜', '合', '對', '帳', '單', '2026年01月']),
    '★真台新抬頭（一個字一格）不得被當成交易列——否則分界會滑到第 0 列、整份沒有證據');
  assert.ok(!looksLikeTxRow([]));
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
  // ⚠️ 錨定在列開頭之後，同一列不可能同時命中兩家 ⇒ 用兩列（`own` 是跨列取聯集的）。
  const both = identifyIssuer([['台新銀行聯名卡'], ['台北富邦銀行聯名卡']], new Set());
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
  // ⚠️ 商店名必須挑一個**自家樣式真的會命中**的（這裡用「台新」）。
  //    第一版用「富邦人壽」，但富邦樣式已收緊成「台北富邦」⇒ 那個字本來就不命中 ⇒ 突變測試證明
  //    （r2 之後行名還要跟佐證詞，所以這裡也從「台新人壽」改成「台新銀行ATM跨行手續費」）
  //    這題什麼都沒考（拿掉表頭區限制照樣綠）。負向題的 fixture 要自己確認「真的踩得到那條路」。
  // ⚠️ 交易列用**台新式**（前兩格都是民國日期）：用富邦式的話台新解析器 0 列 ⇒ 誤判時會被
  //    r2#3 的「自家解析器零筆＝認不得」先丟錯，這題就變成在考別的東西（Codex r3#3 指出）。
  // ⚠️ 中間那列「小計」是必要的：台新式交易列在 parseFubon 眼中沒有說明（兩個日期相鄰），
  //    它會把**下一列**當成換行說明吃掉——商店名一旦進了 `used`，這題就變成 `used` 在擋、
  //    而不是表頭區在擋（本檔 E1b 記過同一個陷阱，這裡又踩了一次）。
  //    「小計」在 parseFubon 的排除清單裡，所以它會停手，商店續行才留得住。
  const f = [
    ['信用卡帳單'],                        // 刻意不印機構名，讓證據只可能來自下面那一列
    ['115/07/03', '115/07/05', '一般店', '100'],
    ['小計'],
    ['台新銀行ATM跨行手續費'],              // ← 明細區的續行＝商店名（含自家行名＋佐證詞、在列開頭）
  ];
  const used = new Set();
  parseFubon(f, used); parseTaishinPdf(f, used);
  assert.equal(parseTaishinPdf(f).length, 1, '前提：台新解析器抓得到 ⇒ 誤判成台新時會一路走完，不會被 r2#3 擋掉');
  assert.ok(!used.has(3), '前提：商店續行沒有被任何解析器消耗');
  assert.ok(!looksLikeTxRow(f[3]), '前提：它也不長得像交易列——所以前一版的兩層過濾都擋不到它');
  assert.ok(identifyIssuer([f[3]], new Set()).bank === '台新',
    '前提：這個商店名**單獨拿去判會命中台新** ⇒ 本題真的踩得到那條路（不是「反正不命中」）');
  assert.deepEqual(run(f), { code: null, bank: '', bankEvidence: 'none', rows: 1 },
    '★四值一起斷（本卷規矩②）：它在第一筆交易列**之後** ⇒ 沒有投票權，但列照給');
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

test('★分界必須同時看 used：向**上一列**借來的說明不得變成表頭區證據', () => {
  // 台新版面的說明有時印在交易列的**上一行**。那一列在文件順序上位於第一筆交易列**之前**，
  // 所以只靠「第一列像交易列的位置」當分界會把它算進表頭區——而它是商店名。
  // 這就是分界要 `u.has(i) || looksLikeTxRow(...)` 兩個條件都看的理由（少看 used 這半邊就漏）。
  const f = [
    ['信用卡帳單'],                          // 沒印機構名
    ['玉山銀行ATM跨行手續費'],                // ← 說明印在上一行，會被 parseTaishinPdf 借走
    ['115/06/02', '115/06/05', '15'],
  ];
  const used = new Set();
  const raw = parseTaishinPdf(f, used);
  assert.equal(raw.length, 1, '前提：這份確實走到「向上一列借說明」那條路');
  assert.equal(raw[0].desc, '玉山銀行ATM跨行手續費', '前提：說明真的是那一列');
  assert.ok(used.has(1), '前提：借走的那一列已記進 used');
  assert.ok(!looksLikeTxRow(f[1]), '前提：它不長得像交易列 ⇒ 只靠 looksLikeTxRow 的分界擋不到它');
  const r = run(f);
  assert.equal(r.code, null, '★不得因為說明列上的「玉山銀行」而觸發否證器、整份丟棄');
  assert.equal(r.bank, '');
  assert.equal(r.rows, 1, '★列照給（分支④），不是丟棄（分支②）');
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


// ── Codex #518 r2 的四個實測案例 ────────────────────────────────────────────

test('★r2#1 同一列「跨格」也不得拼出行名（黏是必要的，所以改用佐證詞提高門檻）', () => {
  // 真台新抬頭在文字層是一個字一格 ⇒ 同一列**非黏不可**，這條通道堵不掉。
  // 所以改成「行名後面要跟佐證詞」：接縫上拼出的「台新戶」不算，真的「台新銀行」才算。
  // ⚠️ 交易列要用**台新式**（前兩格都是民國日期）。第一版用富邦式，於是台新解析器 0 列 ⇒
  //    被 r2#3 的「自家解析器零筆＝認不得」先擋掉 ⇒ 這題根本走不到身分判定，突變測試當場證明它沒在考。
  const f = [
    ['電子服務平台', '新戶刷卡禮'],
    ['115/07/03', '115/07/05', '一般商店', '100'],
  ];
  assert.equal(parseTaishinPdf(f).length, 1, '前提：台新解析器真的抓到 1 列（誤判成台新時會一路走完，不會被 r2#3 擋掉）');
  assert.ok(/台新/.test(evidenceRows(f, new Set([1])).join('')), '前提：黏起來確實含「台新」——本題真的踩得到那條路');
  assert.notEqual(run(f).bank, '台新', '★接縫上拼出來的不算行名');
  // 對照：真的印了行名＋佐證詞就要認得（否則上面那句只是「什麼都不認」）
  assert.equal(run([['台新銀行信用卡帳單'], ['115/07/03', '115/07/05', '一般商店', '100']]).bank, '台新');
});

test('★r2#1b 跨**列**拼字＋佐證詞：兩層各擋一半，缺一不可', () => {
  // r1#1a 那份因為佐證詞規則也被擋住 ⇒ 它證明不了「逐列比對」這一層有在跑（突變測試證實）。
  // 這一份的兩列併起來會拼出「某某平**台新銀行**推薦」——**連佐證詞一起拼出來**，
  // 所以只有「逐列比對」擋得住它。
  const f = [
    ['某某平台'],
    ['新銀行推薦'],
    ['115/07/03', '115/07/05', '一般商店', '100'],
  ];
  const rows = evidenceRows(f, new Set([2]));
  assert.deepEqual(rows, ['某某平台', '新銀行推薦'], '前提：表頭區就是這兩列');
  assert.ok(rows.every((t) => !/[台臺]新(銀行|信用卡)/.test(t)), '前提：沒有任何**單一列**含「台新銀行」');
  assert.ok(/台新銀行/.test(rows.join('')), '前提：但併起來就有——本題真的在考跨列通道');
  assert.equal(parseTaishinPdf(f).length, 1, '前提：交易列抓得到（誤判時會一路走完）');
  assert.equal(run(f).bank, '', '★兩列不得被拼成一個行名');
});

test('★否證器也必須逐列：跨列拼出別家行名不得誤觸（該認得的認不出）', () => {
  // 逐列這件事**兩邊都要**。否證器誤觸的方向雖然安全（退到不猜／丟列），但仍是缺陷：
  // own=1 時退成分支④（使用者白選一次卡）、own=0 時退成分支②（列被整批丟掉）。
  const f = [
    ['台新銀行信用卡帳單'],
    ['某某國泰'],
    ['世華中心'],
    ['115/07/03', '115/07/05', '一般商店', '100'],
  ];
  const rows = evidenceRows(f, new Set([3]));
  assert.ok(rows.every((t) => !t.includes('國泰世華')), '前提：沒有任何**單一列**含「國泰世華」');
  assert.ok(rows.join('').includes('國泰世華'), '前提：但併起來就有——本題真的在考跨列通道');
  assert.equal(run(f).bank, '台新', '★不得因為跨列拼出的「國泰世華」而否掉真正的台新');
});

test('★r2#2 抽字把日期與商店塞進同一格時，分界不得往後滑', () => {
  // 前一版 looksLikeTxRow 要求「至少三格、日期獨占一格」⇒ 壓縮成兩格的交易列不算交易列
  // ⇒ 分界滑到更後面 ⇒ 明細區的商店續行進了「表頭區」、重獲投票權。
  const f = [
    ['115/07/01 星巴克', '100'],          // ← 壓縮成兩格的交易列
    ['台新銀行ATM跨行手續費'],              // ← 明細區的商店續行
    ['115/07/03', '115/07/05', '一般商店', '200'],
  ];
  assert.ok(looksLikeTxRow(f[0]), '前提：這一列現在算交易列（分界應該停在第 0 列）');
  assert.equal(identifyIssuer([f[1]], new Set()).bank, '台新', '前提：那個商店名單獨拿去判會命中台新');
  assert.deepEqual(evidenceRows(f, new Set()), [], '★分界停在第 0 列 ⇒ 表頭區是空的');
  assert.equal(run(f).bank, '', '★商店續行不得取得投票權');
});

test('★r2#3 認出是台新、但台新解析器 0 列 ⇒ 認不得（不可改用另一家的結果）', () => {
  // Codex 實測：富邦解析器會把末格的「回饋點數 3」當金額 ⇒ 回「台新、金額 3」，真實消費是 150。
  const f = [['台新銀行信用卡帳單'], ['115/07/03', '星巴克', '150', '回饋點數', '3']];
  assert.equal(parseTaishinPdf(f).length, 0, '前提：台新解析器讀不動這個版面');
  const fubonRows = parseFubon(f);
  assert.equal(fubonRows.length, 1, '前提：富邦解析器讀得到 1 列');
  assert.equal(fubonRows[0].amount, 3, '★前提：而且它讀到的金額是「回饋點數 3」，不是消費的 150');
  assert.deepEqual(run(f), { code: 'card_unrecognized', status: 400, bank: '', bankEvidence: 'none', rows: 0 },
    '★「我知道這是誰印的、但我讀不動它的版面」＝認不得，不是換一把尺再試一次');
});


// ── Codex #518 r3 ───────────────────────────────────────────────────────────

test('★r3#1 錨定在列開頭：三個「補佐證詞補不完」的繞法全部擋掉', () => {
  // r2 只做了「行名後面要跟佐證詞」，Codex r3 當場找到三個繞法。列舉補不完 ⇒ 改成關門：
  // 真行名印在抬頭、抬頭在**列的開頭**；接縫上拼出來的一定在列中間。
  const TX = ['115/07/03', '115/07/05', '一般商店', '100'];   // 台新式（誤判時會一路走完）
  for (const [head, why] of [
    [['購物平台', '新銀座推薦'], '踩單字「銀」'],
    [['某某TAI', 'SHIN新戶推薦'], '踩沒有邊界的英文分支'],
    [['我的Rich', 'art卡回饋'], '踩 Richart'],
    [['電子服務平台', '新戶刷卡禮'], 'r2 原案'],
  ]) {
    const f = [head, TX];
    assert.equal(parseTaishinPdf(f).length, 1, `前提（${why}）：交易列抓得到，誤判時會一路走完`);
    assert.notEqual(run(f).bank, '台新', `★${why}：接縫在列中間，不算行名`);
  }
  // ★佐證詞**不可以是單字**：錨定之後「台新銀」仍會命中「台新銀座」這種列開頭。
  //   r2 原本的清單裡有單字「銀」，Codex r3#1 就是踩它進來的。
  assert.notEqual(run([['台新銀座百貨消費明細'], TX]).bank, '台新', '★佐證詞不可以放單字');
  assert.notEqual(run([['台新銀樓貴金屬'], TX]).bank, '台新');
  // 對照：真的印在列開頭就要認得（否則上面只是「什麼都不認」）
  assert.equal(run([['台新銀行綜合對帳單'], TX]).bank, '台新');
  assert.equal(run([['Richart信用卡帳單'], TX]).bank, '台新', '英文抬頭在列開頭也算');
});

test('★r3#2 卡片發卡行的比對＝同一組樣式（香港富邦不得算成台北富邦）', async () => {
  const { issuerBank } = await import('../lib/card-identity.js');
  assert.equal(issuerBank('台北富邦銀行'), '富邦');
  assert.equal(issuerBank('台北富邦商業銀行'), '富邦');
  assert.equal(issuerBank('台新銀行'), '台新');
  assert.equal(issuerBank('Richart'), '台新');
  assert.equal(issuerBank('富邦銀行（香港）有限公司'), '', '★香港富邦不是台北富邦（lib/bank-alias.js:17 記過的撞名）');
  assert.equal(issuerBank('Fubon Bank (Hong Kong) Limited'), '');
  assert.equal(issuerBank('玉山銀行'), '');
  assert.equal(issuerBank(''), '');
  assert.equal(issuerBank(null), '');
  // ★短名（Codex #518 r8：base 的 `includes` 認得，#518 一度認不得＝功能退化）。
  //   2026-08-28 起短名不再是 `issuerBank` 裡的特例，而是由可選清單的 `aka` 收。
  //   ⚠️ 這裡曾寫「行為不變」——**不準**（Codex #520 r3#1）：「台新」不變，但「台北富邦」是**新**認得的。
  //   相對 base 的完整差異表＝本檔「相對 base 的行為改變**逐項**釘住」那一題，本題不重述（重述的那份自己會漂）。
  assert.equal(issuerBank('台新'), '台新', '★卡片欄位填短名也要認得——既有卡片就是這樣填的');
  assert.equal(issuerBank('台北富邦'), '富邦', '★清單的 aka 收得住既有短名（樣式那條路要求「台北富邦…銀行」）');
  // ★★發卡行清單化**唯一收緊**的那一條（William 2026-08-28 指派的理由本身；放寬的三類見「相對 base 的行為改變逐項釘住」題）：
  //   「富邦」與「富邦銀行」被**兩家法人同時宣稱**（香港富邦官方自稱「富邦銀行」，
  //   台北富邦官方沿革同樣記載這個簡稱）⇒ 這兩個寫法從此判不出身分。
  //   ⚠️ 只有**裸的「富邦」**在 base 會被當台北富邦（`o.bank === t` 的完全相等規則）；
  //   「富邦銀行」在 base 就已經回 `''`（工作流 2026-08-28 實測推翻我原本寫的「兩個都當台北富邦」）。
  //   所以本支對「富邦銀行」**零改變**，收緊的只有「富邦」那一個寫法。猜錯的代價＝帳單自動歸到香港卡。
  //   判不出來的代價只是使用者多按一次選卡，而清單就是那張卡的永久解。
  assert.equal(issuerBank('富邦'), '', '★歧義短名不猜——挑清單上的「台北富邦銀行」或「富邦銀行（香港）」才說得清楚');
  assert.equal(issuerBank('富邦銀行'), '', '★香港富邦官方也自稱「富邦銀行」⇒ 同樣不猜');
});

test('★發卡行清單化：相對 base 的行為改變**逐項**釘住（Codex #520 r1#4）', async () => {
  // r1 的 PR 內文寫「唯一的行為改變＝『富邦』」——**那是錯的**。Codex 對 base `a3cdd6b` 與本支逐一跑過，
  // 除了「富邦」還有三類都動了，而且**三類都是放寬**（＝自動歸卡的面積變大＝錢的風險面變大），
  // 所以不可以只靠 `issuerNameKey` 的相等題代替下游行為題。下面每一條都是 `issuerBank` 的直接斷言。
  const { issuerBank } = await import('../lib/card-identity.js');

  // ①收緊（唯一一條）：歧義短名不再猜
  assert.equal(issuerBank('富邦'), '', 'base 回「富邦」（猜台北富邦）');

  // ②放寬：清單的 `aka` 收既有短名——樣式那條路要求「台北富邦…銀行」，裸的四個字對不上
  assert.equal(issuerBank('台北富邦'), '富邦', 'base 回 ""');

  // ③放寬：`issuerNameKey` 的**臺→台**。
  // ⚠️ 這一條原本寫「臺→台**與去空白**」——去空白不是本支帶來的（工作流 2026-08-28 實測）：
  //    `lib/bank-statement.js` 的 `squash` 在 base 就已經把空白全去掉，而 `issuerBank` 第一行就是它。
  //    實測拿掉 `issuerNameKey` 的去空白：本檔全部照樣綠（只有 card-issuers 那邊的**表單預選題**會紅）
  //    ⇒ 它對 `issuerBank` 零 delta（對表單預選仍承重，所以不能拿掉——只是不屬於「issuerBank 的放寬」）。
  assert.equal(issuerBank('臺新'), '台新', 'base 回 ""');
  assert.equal(issuerBank('臺 新'), '台新', 'base 回 ""——承重的是臺→台，不是去空白');

  // ④放寬：NFKC 的**相容字**射程（全形、squared CJK…）。
  // ⚠️ **裁決＝接受，不收窄**（2026-08-28）：相容字就是同一個字的另一種印法，判成同一家是對的；
  //    而且 `lib/bank-alias.js` 的 `baseForm` 早就用 NFKC ⇒ 收窄反而變成同一件事兩把尺。
  //    代價照實記：射程包含「台🈟」（U+1F21F＝squared 新）這種沒人會打的字形，它同樣會判成台新。
  //    這一條是 documenting test——它釘的是**已知的射程**，不是「這樣很理想」。
  assert.equal(issuerBank('台🈟'), '台新', '★NFKC 把 U+1F21F 正規化成「新」——射程照實記載，不宣稱它很理想');

  // 對照：**沒有**跟著放寬的（樣式那條路的輸入是 PDF 文字，不吃 issuerNameKey）
  assert.equal(issuerBank('ｒｉｃｈａｒｔ'), '', '★全形拉丁不在清單上 ⇒ 走樣式，樣式不做 NFKC（與 base 相同）');
  assert.equal(issuerBank('富邦人壽'), '', '★保險公司不是發卡行');
  // ★抬頭那條路**不得**跟著放寬（輸入是 PDF 文字，接縫假陽性靠錨定＋佐證詞擋）
  assert.equal(identifyIssuer([['台新'], ['115/06/02', '115/06/04', '星巴克', '150']], new Set()).bank, '',
    '★單獨一個「台新」當抬頭仍不算證據——兩個資料域的可接受詞彙本來就該不同');
});


// ── Grok 複審後掃（2026-08-27）───────────────────────────────────────────────

test('★掃#1 分支②讀到了列、也知道是誰 ⇒ 訊息不得說「可能是這一期真的沒有消費」', () => {
  // 這正是本支撤回 card_no_rows 的理由（對使用者的錢說假話），我卻把同一句話包進了分支②。
  const f = [
    ['國泰世華銀行 信用卡帳單'],
    ['消費日', '摘要', '入帳日', '金額'],
    ['115/07/03', '家樂福內湖店', '115/07/05', '1,250'],
    ['115/07/11', 'UBER TRIP', '115/07/13', '260'],
  ];
  assert.equal(parseFubon(f).length, 2, '前提：我們**真的讀到了 2 筆**（不是找不到）');
  const e = grab(() => parseStatementFromLines(f));
  assert.equal(e.code, 'card_unrecognized');
  assert.doesNotMatch(e.message, /沒有消費|沒有交易/, '★不可以說「這期沒有消費」——我們讀到列了');
  assert.doesNotMatch(e.message, /找不到任何消費明細/, '★也不可以說「找不到」');
  assert.match(e.message, /國泰世華/, '★要講出是誰的帳單——那是我們真的知道的事');
  // 對照：真的 0 列時仍然用並陳版（兩種可能都要講）
  assert.match(grab(() => parseStatementFromLines([['隨便什麼字']])).message, /沒有消費/);
});

test('★r5#1 回歸護欄：合法店名「KFC」不得害正確的那一支被選掉（我加過的猜測判準造成的漏帳）', () => {
  // Codex 實測：`/^[A-Z]{3}$/` 把「KFC」也當幣別 ⇒ 台新那支被扣分 ⇒ 改選富邦 ⇒
  // **漏記一筆 200、另一筆店名錯置**。「三碼大寫」不是幣別的定義。
  const f = [
    ['信用卡帳單'],
    ['KFC'],
    ['115/07/03', '115/07/05', '100'],
    ['星巴克'],
    ['115/07/09', '115/07/11', '200'],
  ];
  const t = parseTaishinPdf(f), fb = parseFubon(f);
  assert.equal(t.length, 2, '前提：台新解析器正確讀到 2 筆');
  assert.equal(fb.length, 1, '前提：富邦解析器只讀到 1 筆（而且店名錯置）');
  const r = parseStatementFromLines(f);
  assert.equal(r.transactions.length, 2, '★不得因為「KFC」被誤判成幣別而選到漏記的那一支');
  assert.deepEqual(r.transactions.map((x) => [x.desc, x.amount]), [['KFC', 100], ['星巴克', 200]]);
});

test('★r6#1 回歸護欄：幣別碼與店名的集合**本來就相交**，「HUF」是真品牌', () => {
  // Codex 實測：`HUF` 是匈牙利幣別碼，也是真的街頭服飾品牌（台北有門市）。
  // 只看「是不是幣別碼」的話，單筆 HUF 消費會讓正確的那一支被扣分 ⇒ 選錯 ⇒ 漏記一筆。
  // ⚠️ 本題**不宣稱**守住任何已撤回的判準層（那些層已隨 r7 整條撤回）。它守的是：
  //    「認不出機構時用筆數判準」在這份樣本（HUF 佔 1/2）上會選對。
  // ⚠️ 留一段歷史給後人：我曾以「突變測試證明沒有任何一題分辨得出它在不在」為由刪掉一層保護，
  //    Codex 指出**那是我的考題沒涵蓋、不是它不可證明**（這份樣本就分辨得出來）。
  //    **「現有考題沒涵蓋」≠「不可證明」**——不可以拿前者當刪除保護層的理由。
  const f = [
    ['信用卡帳單'],
    ['HUF'],
    ['115/07/03', '115/07/05', '100'],
    ['星巴克'],
    ['115/07/09', '115/07/11', '200'],
  ];
  assert.equal(parseTaishinPdf(f).length, 2, '前提：台新解析器正確讀到 2 筆');
  assert.equal(parseFubon(f).length, 1, '前提：富邦解析器只讀到 1 筆（而且店名／金額錯置）');
  const r = parseStatementFromLines(f);
  assert.equal(r.transactions.length, 2, '★單筆幣別同名店家不得讓正確的那一支被扣分');
  assert.deepEqual(r.transactions.map((x) => [x.desc, x.amount]), [['HUF', 100], ['星巴克', 200]]);
});

test('★r6#1c 回歸護欄：幣別同名店家佔 2/3 列——這是打死「覆蓋一半以上」那版的樣本', () => {
  // ⚠️ 我先前在別題的註解裡寫「真正打死 r7 那版的是 HUF／星巴克／HUF（2/3）」，**卻沒有真的寫這一題**
  //    ⇒ 指向一條不存在的考題（Codex r9#1）。現在補上。
  const f = [
    ['信用卡帳單'],
    ['HUF'], ['115/07/01', '115/07/02', '100'],
    ['星巴克'], ['115/07/03', '115/07/04', '200'],
    ['HUF'], ['115/07/05', '115/07/06', '300'],
  ];
  const t = parseTaishinPdf(f);
  assert.equal(t.length, 3, '前提：台新解析器正確讀到 3 筆');
  assert.equal(t.filter((x) => x.desc === 'HUF').length, 2, '前提：其中兩筆是幣別同名店家（2/3＝過半）');
  assert.ok(t.length > parseFubon(f).length, '前提：台新讀得比較多 ⇒ 被扣分就會選錯');
  const r = parseStatementFromLines(f);
  assert.equal(r.transactions.length, 3, '★過半也不行——「覆蓋一半以上」那版就是死在這裡');
  assert.deepEqual(r.transactions.map((x) => x.amount), [100, 200, 300]);
});

test('★r6#1b 回歸護欄：幣別同名店家去兩次（2/5 列）不得害正確的那一支被選掉', () => {
  // ⚠️ 本題**不宣稱**守住任何已撤回的判準層（那層已隨 r7 整條撤回）。它守的是：
  //    「認不出機構時用筆數判準」在**這份樣本**上會選對——有人再加一層看說明內容的猜測時，
  //    只要那層會扣「HUF」的分，這題就會紅。
  // ⚠️ 誠實劃界：本題的 HUF 只佔 2/5，所以**擋不住所有變體**——例如 r7 那版（覆蓋一半以上）
  //    在這份樣本上不會扣分、這題不會紅。打死那一版的是同檔
  //    「幣別同名店家佔 2/3 列」那題。⚠️ 這一族**不只一題**（各自守不同比例的樣本），
  //    刻意不寫數量——寫死的數字自己會漂。
  const f = [
    ['信用卡帳單'],
    ['HUF'], ['115/07/01', '115/07/02', '100'],
    ['星巴克'], ['115/07/03', '115/07/04', '200'],
    ['HUF'], ['115/07/05', '115/07/06', '300'],
    ['全聯福利中心'], ['115/07/07', '115/07/08', '400'],
    ['家樂福內湖店'], ['115/07/09', '115/07/10', '500'],
  ];
  const t = parseTaishinPdf(f);
  assert.equal(t.length, 5, '前提：台新解析器正確讀到 5 筆');
  assert.equal(t.filter((x) => x.desc === 'HUF').length, 2, '前提：其中兩筆的店名是幣別同名的「HUF」');
  assert.ok(t.length > parseFubon(f).length, '前提：台新讀得比較多 ⇒ 被扣分就會選錯');
  const r = parseStatementFromLines(f);
  assert.equal(r.transactions.length, 5, '★兩筆同名店家不足以構成「整欄同一個值」');
  assert.deepEqual(r.transactions.map((x) => x.amount), [100, 200, 300, 400, 500]);
});

test('★掃#2 documenting test：認不出機構＋兩支都抓到列 ⇒ **可能交出錯的那一支**（已知缺口，不是已修好）', () => {
  // ⚠️ 這題**釘住現況、不宣稱已修**。Grok 指出的情境：富邦官網下載版（日期｜入帳日｜TWD｜金額，
  //    說明換行）兩支解析器都會抓到列，`parseTaishinPdf` 把第三格的 `TWD` 當說明；筆數一翻面
  //    就會交出一整批 `desc:'TWD'`。
  //
  // ⚠️ 我曾為此加過一層「看說明像不像人話」的猜測判準，**三個版本都被打出真實漏帳**
  //    （`/^[A-Z]{3}$/` 誤殺 KFC／封閉幣別集誤殺 HUF／modal 覆蓋一半誤殺「HUF 星巴克 HUF」），
  //    每一次的代價都是**選錯解析器、漏記一筆**，而 base 在同樣樣本上是對的。
  //    ⇒ **整條撤回**：幣別碼與店名的集合本來就相交，任何「看說明內容猜哪一支對」的判準都會踩到真店名。
  //    真正的解＝版面錨點（知道這是哪一家、它的欄位怎麼排），留給後續批次。
  //
  // ⚠️ 這是 **base 既有行為，本支沒有改善也沒有惡化**；使用者看得到分支④的警語。
  const f = [
    ['帳單明細查詢'],                                   // 不印機構名 ⇒ 認不出 ⇒ 走筆數 tie-break
    ['115/07/03', '115/07/05', 'TWD', '1,250'],
    ['家樂福內湖店'],
    ['115/07/09', '115/07/11', 'TWD', '8,450'],
    ['本期應繳總額'],
    ['115/07/11', '115/07/13', 'TWD', '260'],
    ['全聯福利中心'],
  ];
  const t = parseTaishinPdf(f), fb = parseFubon(f);
  assert.ok(t.length > fb.length, `前提：台新解析器抓得比較多（${t.length} vs ${fb.length}）⇒ 筆數判準會選它`);
  const r = parseStatementFromLines(f);
  assert.equal(r.bank, '', '★認不出機構 ⇒ 分支④（不掛名、不自動歸卡、畫面有警語）');
  assert.ok(r.transactions.every((x) => /^[A-Z]{3}$/.test(x.desc)),
    '★現況：交出來的是幣別代碼當店名那一支（＝base 既有行為）。'
    + '**若這行開始紅，先確認是哪一種**：①有人做出了版面錨點（好事，請一起更新本題與 lib/statement.js 的劃界）'
    + '②有人又加了一層「看說明內容猜哪一支對」的判準——本支撤回過三次，每次都被真店名打出漏帳（KFC／HUF／HUF×2），'
    + '請先讀 lib/statement.js 那段歷史再決定。');
});
