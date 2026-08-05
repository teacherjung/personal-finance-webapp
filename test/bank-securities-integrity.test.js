// 銀行與證券匯入的「方向與金額不可靜靜失真」考題（夜班稽核第二批B，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢：以下規則都在註解裡寫明了理由（多數還標著「對抗審查」
// 或「Codex r13 複審」），弄壞之後 1487 題全綠——理由沒有考題背書。
// 這一批全部關於「錢的方向與金額」：判反正負號、覆寫別的帳戶餘額、同一筆記兩次、
// 台幣美金相加——四種都會讓畫面上出現一個「看起來很正常」的錯數字，最難察覺。
//
// 隔離：`STORE_FILE` 指向 os 暫存檔（同 bank-statement.test.js 規矩），絕不碰真實 `data/`。
//
// ⚠️ 誠實劃界：`parseBankStatement` 主入口的型別守衛（把信用卡帳單餵進銀行端點要 400）
//    需要一份真的（最小合法）PDF 才測得到——`extractPdfLines` 走子行程。那一題與
//    「兩支 PDF 座標抽取器的合成座標考題」共用同一套合成 PDF harness，一起排在夜班第四批。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-bank-sec-integrity-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { parseBankDetail } = await import('../lib/bank-statement.js');
const { previewBalancesForDb, applyBalancesToDb, applyLearnedBankToDb, previewBankTxForDb } =
  await import('../lib/services/bank-import.js');
const { reconcileFingerprintRows } = await import('../lib/services/security-trades.js');
const { buildSecuritiesPreview } = await import('../lib/services/securities-import.js');
const store = await import('../lib/store.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

/** 合成明細列（不帶寬度→走「左緣」退路）。 @param {number} y @param {[number,string][]} pairs */
const D = (y, pairs) => ({ y, cells: pairs.map(([x, s]) => ({ x, s })) });
/** 合成明細列（帶寬度 w：[x, w, s]）——右緣分欄用。 @param {number} y @param {[number,number,string][]} pairs */
const DW = (y, pairs) => ({ y, cells: pairs.map(([x, w, s]) => ({ x, w, s })) });
/** 台新明細表頭（欄位 x 與既有考題一致：支出 272／存入 331／餘額 396／備註 489／支票 240）。 */
const HEAD = D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [240, '支票號碼'],
  [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]);

// ─────────────────────────────────────────────────────────────────────────────
// 一、明細解析：方向與金額（lib/bank-statement.js 三道）
// ─────────────────────────────────────────────────────────────────────────────

test('明細｜餘額差是方向的權威：x 幾何判成「存入」但帳戶餘額變少 → 最後必須是支出', () => {
  // ⚠️ 這一條是註解自己標成「⚠️方向以 running 餘額為權威（對抗審查）」的裁決，
  //    理由是實測 x 幾何會把小額手續費判反。direction 決定這筆進「收入」還是「支出」＝
  //    現金流的正負號；判反的後果是一筆手續費被算成收入，月結餘與所有比例跟著錯。
  //    整段校正拿掉時 1487 題全綠——因為現有 fixture 的 x 座標剛好都判對，這條從未被驗證。
  const lines = [
    HEAD,
    // 第一列：建立基準餘額（每帳戶第一列沒有前一列可比，走 x 幾何）
    D(100, [[53, '900100****3301'], [124, '2026/06/11'], [177, '轉帳存入'], [349, '$10,000'], [418, '$50,000']]),
    // 第二列：x=349 落在「存入欄」⇒ x 幾何判 in；但餘額 50,000→49,970 減少 30，
    //         |差|＝金額 ⇒ 餘額差權威必須把它糾正成 out（典型的小額手續費）
    D(83, [[53, '900100****3301'], [124, '2026/06/12'], [177, '手續費'], [349, '$30'], [418, '$49,970']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 2);
  assert.equal(txs[0].direction, 'in', '第一列照 x 幾何（沒有前一列可比）');
  assert.equal(txs[1].amount, 30);
  assert.equal(txs[1].direction, 'out',
    '餘額從 50,000 掉到 49,970＝這 30 元是出去的；x 幾何判成存入時要被餘額差糾正'
    + '（拿掉校正＝手續費被算成收入，現金流正負翻面且無聲）');
});

test('明細｜大額支出的左緣越過支出欄表頭，但仍在中線左側 → 判支出（界是中線不是欄頭）', () => {
  // ⚠️ 註解：「金額右對齊，大額左緣會越過表頭左緣，用中線才不翻面」。
  //    界若改用 xOut，大額支出的左緣一越過就被判成存入＝支出變收入。
  //    既有考題只測「退路存在」，沒有測「界要用中線」。
  const lines = [
    HEAD,
    // 右緣 260+8=268 落在支出欄左外側（<272）＝右緣分不出欄 ⇒ 走退路；
    // 左緣 260 已越過支出欄表頭 272 之外側？（260 < 272）——這一列先確立退路可用
    DW(100, [[53, 0, '900200****3302'], [124, 0, '2026/06/11'], [177, 0, '現金支出'], [260, 8, '$1,234']]),
    // 關鍵列：大額七位數，左緣 290 已**越過** xOut(272)，但仍在中線 (272+331)/2=301.5 **左側**
    //         ⇒ 界用中線＝out（正確）；界若改用 xOut＝in（支出被算成收入）
    DW(83, [[53, 0, '900200****3302'], [124, 0, '2026/06/12'], [177, 0, '媒體轉出'], [290, 6, '$1,615,555']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 2);
  assert.equal(txs[1].amount, 1615555);
  assert.equal(txs[1].direction, 'out',
    '左緣越過支出欄表頭、但還在中線左側＝仍是支出（界改成欄頭就會翻成收入）');
});

test('明細｜支票號碼欄的純數字不可被當成金額（否則帳上憑空多一筆支出）', () => {
  // ⚠️ 註解明講「純數字支票號碼被當金額」是這道排除存在的理由。
  //    目前所有 fixture 都沒有帶支票號碼的列，所以這道排除從未被驗證過。
  const lines = [
    HEAD,
    // 支票號碼 0123456（右緣 244+20=264 落在 [xChk 240, xOut 272) ⇒ 必須忽略）
    // 真正的支出金額右緣 300+25=325 落在 [xOut 272, xIn 331) ⇒ 這才是金額
    DW(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '票據交換'],
      [244, 20, '0123456'], [300, 25, '$8,500'], [400, 30, '$41,500']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].amount, 8500, '要抓真正的金額 8,500，不可抓成票號 123,456');
  assert.equal(txs[0].direction, 'out');
});

test('明細｜換行備註距離太遠就不黏（寧留白，不亂黏到別筆交易）', () => {
  // ⚠️ 備註是分箱判準（內轉／劃撥判全文／繳卡費空分類）。距離上限失效時，
  //    跨頁或密集列的孤兒備註會被黏到最近的任一筆交易上＝把交易分到錯的箱子。
  const lines = [
    HEAD,
    D(100, [[53, '900100****3301'], [124, '2026/06/11'], [177, '轉帳存入'], [349, '$36,669'], [418, '$36,669']]),
    // 孤兒備註：高 x（在備註欄）、無帳號，但 y 距離最近交易列 100 遠達 500（跨頁的典型位移）
    D(-400, [[450, 'ATM 806 別筆的備註']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].note, '',
    'y 距離超過上限的孤兒備註不可黏上來——黏錯會讓這筆被分到錯的箱子（內轉／劃撥都靠備註判）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、餘額匯入與方向：服務層（lib/services/bank-import.js 三道）
// ─────────────────────────────────────────────────────────────────────────────

/** 合成一份「概要區」解析結果（只含餘額匯入需要的欄位）。 @param {object[]} accounts */
const parsedBank = (accounts) => ({ referenceDate: '2026-06-30', accounts, accountCurrency: {}, transactions: [] });

test('餘額匯入｜末碼與前綴都相同的「非現金」帳戶不可被覆寫（負債翻成資產）', () => {
  // ⚠️ matchAccount 的 docstring 編號①，理由逐字寫著：「否則尾碼碰巧相同的負債/保單/投資帳戶
  //    餘額會被覆蓋、負債翻成資產、淨資產算錯」。②（可見前綴也要對）有考題守著，①沒有。
  //    這一題刻意讓前綴與末碼**都相同**，只差 type ⇒ 只有「只比對現金帳戶」那道擋得住。
  const db = {
    ...store.emptyDb(),
    accounts: [
      { id: 'loan1', name: '房貸', type: 'loan', class: '負債', currency: 'TWD', accountNo: '900100****3301', balance: -6900000 },
    ],
  };
  const parsed = parsedBank([
    { suffix: '3301', masked: '900100****3301', balance: 23, currency: 'TWD', label: '新臺幣活存', note: '' },
  ]);
  const preview = previewBalancesForDb(db, parsed);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].action, 'create',
    '同末碼同前綴但 type 是負債＝不是同一個帳戶，只能新建現金帳戶，不可判成「更新」');
  applyBalancesToDb(db, parsed);
  const loan = db.accounts.find(a => a.id === 'loan1');
  assert.equal(loan?.balance, -6900000, '房貸餘額一分都不可被帳單的活儲餘額覆寫（覆寫＝負債翻成資產）');
  assert.equal(loan?.type, 'loan', '型別也不可被改');
});

test('方向｜舊資料的 bankRef 方向優先於可能被改錯的 type（套用學習規則時不可誤改）', () => {
  // ⚠️ txDirection 的 docstring 優先序：①dir ②bankRef 第 4 段 ③才從 type 推。理由（Codex r13 複審#1）：
  //    bankRef 是匯入當下寫死的去重鍵、不隨使用者改分類而變，比可能被改錯的 type 可靠。
  //    優先序對調的後果＝這類舊資料會被「同類一起改」誤套成收入，出帳無聲變收入＝毀現金流。
  const db = {
    ...store.emptyDb(),
    learnedBank: { '手續費': { type: 'income', category: '被動', subcategory: '利息', name: '' } },
    transactions: [{
      id: 't1', date: '2026-06-12', type: 'income',            // ← type 被存錯成收入（舊批次的不一致）
      category: '其他', subcategory: '', amount: 30, source: 'bank',
      ledger: 'cashflow', bankKey: '手續費',
      bankRef: '900100****3301|2026-06-12|30|out|49970',       // ← 第 4 段是 out（匯入當下的真相）
    }],
  };
  const r = applyLearnedBankToDb(db, '手續費');
  assert.equal(r.changed, 0, '收入規則不可套到「bankRef 說是出帳」的那筆上');
  assert.equal(r.skipped, 1, '要算成略過（方向不符）——這正是逐筆方向護欄要做的事');
  assert.equal(db.transactions[0].category, '其他', '分類不可被改動');
});

test('顯示說明｜帶「-」的他行帳號不可被翻成「自己的帳戶名」（錢給外人不能講成內部搬錢）', () => {
  // ⚠️ ownAccountNameByAcct 的規則：「帶「-」的他行代碼帳號不查（824-…6146 是對方在他行的帳號，
  //    末碼撞到自己帳戶純屬巧合、不可誤標「轉入到：」）」。這是**事實陳述**錯誤（不是視覺格式），
  //    使用者對帳時會據此誤判「這筆錢還在自己手上」。
  const db = {
    ...store.emptyDb(),
    accounts: [{ id: 'a1', name: '台新活儲（Richart）', type: 'cash', class: '現金', currency: 'TWD', accountNo: '900100****6146', balance: 1000 }],
  };
  const parsed = {
    referenceDate: '2026-06-30', accounts: [], accountCurrency: {},
    transactions: [{
      acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-06-20', summary: '媒體轉帳',
      direction: 'out', amount: 5000, balance: 1000,
      note: '轉出 824-00001110****6146 Wei',      // 他行帳號，末碼與自己帳戶相同（純屬巧合）
    }],
  };
  const preview = previewBankTxForDb(db, parsed);
  const row = preview.rows?.[0] ?? preview.items?.[0];
  assert.ok(row, '預覽要有那一筆');
  const shown = String(row.displayNote ?? row.note ?? '');
  assert.doesNotMatch(shown, /台新活儲（Richart）/,
    '他行帳號末碼撞到自己帳戶時，不可把「錢給了外人」講成「轉出自／轉入到自己的帳戶」');
  assert.match(shown, /6146/, '他行帳號本身要照樣看得到（只是不可翻成自己的帳戶名）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、證券：同一筆不可記兩次、幣別不可相加（兩道）
// ─────────────────────────────────────────────────────────────────────────────

test('證券去重｜補印帳單改了手續費（非鍵欄）仍是同一筆：按數量抵銷判重複、不可新增', () => {
  // ⚠️ reconcileFingerprintRows 的第二段（剩餘按數量抵銷）是檔頭宣告的「S2 自審三條 HIGH 的根治」：
  //    第一段只配「完整內容相等」的列，來源修訂（台新重印把手續費 142 改成 100）就配不中，
  //    全靠第二段才不會被當新交易。拿掉之後同一筆 10 萬元的成交會入帳兩次（自審曾用真程式重現 60 萬記兩次）。
  const base = '台新|2026-01-13|0050|buy|1000|104';
  const existing = [{
    sourceRef: `${base}|#1`, tradeDate: '2026-01-13', symbol: '0050', side: 'buy', rawType: '現買',
    quantity: 1000, price: 104, grossAmount: 104000, commission: 142, tax: 0, feeDiscount: 0,
    otherFees: null, netSettlement: 104148, currency: 'TWD', settlementDate: '2026-01-15', name: '元大台灣50',
  }];
  // ⚠️ 批列的 sourceRef ＝**沒有序號的 base**（序號是庫內身分、由對帳計畫決定要不要配新的）
  const batch = [{ ...existing[0], sourceRef: base, commission: 100 }];   // ← 只有非鍵欄不同（補印修訂）
  const plan = reconcileFingerprintRows(existing, batch);
  assert.equal(plan.duplicate[0], true,
    '同 base 指紋、只有非鍵欄有差＝同一筆的修訂版，必須判重複（判不出來就會重複入帳）');
  assert.equal(plan.insertRefs[0], null, '重複的列不可再配一個新序號（|#2＝同一筆被記兩次）');
});

test('證券預覽｜台幣與美金必須分桶，任一桶都不可等於兩者之和', () => {
  // ⚠️ 「金額一律保留原幣、不同幣別不可默默加總」是藍圖拍板鐵則①，
  //    而前端「買進總額／賣出總額」明文與後端 byCurrency 同口徑——這是使用者拿去跟對帳單核對的數字。
  //    相加之後會得到一個「看起來很正常」的數字，永遠對不上帳單、又最難察覺。
  const db = { ...store.emptyDb() };
  const twdBuy = { tradeDate: '2026-01-13', settlementDate: '2026-01-15', rawType: '現買', symbol: '0050', name: '元大台灣50',
    quantity: 1000, price: 104, grossAmount: 104000, commission: 50, feeDiscount: 0, tax: 0, otherFees: null,
    netSettlement: 104050, currency: 'TWD' };
  const usdBuy = { tradeDate: '2026-01-14', settlementDate: '2026-01-16', rawType: '現買', symbol: 'VOO', name: 'Vanguard S&P 500',
    quantity: 4, price: 500, grossAmount: 2000, commission: 5, feeDiscount: 0, tax: 0, otherFees: null,
    netSettlement: 2005, currency: 'USD' };
  const p = buildSecuritiesPreview(db, {
    stmtMonth: '2026-01', accountRaw: '9001-900100', headerFound: true,
    trades: [twdBuy, usdBuy],
    groups: [{ date: '2026-01-15', total: null, tradeCount: 2, sumMatches: true }],
  });
  assert.deepEqual(Object.keys(p.byCurrency).sort(), ['TWD', 'USD'], '兩個幣別要各自成桶');
  assert.equal(p.byCurrency.TWD.buy, 104050, '台幣桶只放台幣');
  assert.equal(p.byCurrency.USD.buy, 2005, '美金桶只放美金');
  assert.notEqual(p.byCurrency.TWD.buy, 104050 + 2005, '⚠️ 兩幣別相加＝與對帳單永遠對不上的假數字');
  assert.equal(p.byCurrency.TWD.buyCount, 1, '筆數也要分幣別');
  assert.equal(p.byCurrency.USD.buyCount, 1);
});
