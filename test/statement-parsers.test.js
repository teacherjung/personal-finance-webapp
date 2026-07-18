// 帳單「解析器」的自動考試（用合成明細列，不需真帳單）：把民國日期、兩家版式、
// 說明合併 bug、國外服務費繼承、銀行內容判斷、末四碼抽取全部鎖住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rocToIso, parseFubon, parseTaishinPdf, finalize, parsePdfAuto,
  extractLastFour, normalizeDesc, cleanStore, categorize, branchNormalize, normalizeStoreDisplay
} from '../lib/statement.js';

test('rocToIso：民國日期 → 西元 ISO', () => {
  assert.equal(rocToIso('115/06/02'), '2026-06-02');   // 斜線民國
  assert.equal(rocToIso('1150602'), '2026-06-02');     // 7 碼補印版
  assert.equal(rocToIso('114/12/31'), '2025-12-31');
  assert.equal(rocToIso('abc'), null);                 // 非日期 → null
  assert.equal(rocToIso(''), null);
});

test('parseFubon：單列（消費日｜說明｜入帳日｜金額）', () => {
  const r = parseFubon([['115/06/02', '星巴克', '115/06/05', '150']]);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { date: '2026-06-02', postDate: '2026-06-05', desc: '星巴克', amount: 150 });
});

test('parseTaishinPdf：單列（消費日｜入帳日｜說明｜金額）', () => {
  const r = parseTaishinPdf([['115/06/02', '115/06/05', '星巴克', '150']]);
  assert.equal(r.length, 1);
  assert.equal(r[0].date, '2026-06-02');
  assert.equal(r[0].amount, 150);
  assert.equal(r[0].desc, '星巴克');
});

test('parseTaishinPdf：說明在上一行時「只取上一行」，不黏到下一筆（回歸保護）', () => {
  const lines = [
    ['ＦＰ－麥味登'],
    ['115/06/02', '115/06/05', '200', '6408', '0000', 'TW'],
    ['ＦＰ－珍煮丹'],
    ['115/06/03', '115/06/05', '148', '6408', '0000', 'TW'],
  ];
  const r = parseTaishinPdf(lines);
  assert.equal(r.length, 2);
  assert.equal(r[0].desc, 'FP-麥味登');
  assert.ok(!r[0].desc.includes('珍煮丹'), '第一筆不該黏到第二筆的說明');
  assert.equal(r[1].desc, 'FP-珍煮丹');
});

test('parseTaishinPdf：外幣交易把幣別/金額接進說明', () => {
  const r = parseTaishinPdf([['115/06/02', '115/06/05', 'OPENAI', '320', 'USD', '9.99']]);
  assert.equal(r.length, 1);
  assert.ok(r[0].desc.includes('USD'), '外幣註記應接進說明');
});

test('finalize：負數＝繳款/退款（isPayment），不分類', () => {
  const r = finalize([{ date: '2026-06-02', desc: '自動扣繳信用卡款', amount: -500 }], '台新');
  assert.equal(r.bank, '台新');
  assert.equal(r.transactions[0].isPayment, true);
  assert.equal(r.transactions[0].category, '繳款/退款');
});

test('finalize：國外交易服務費繼承前一筆的分類', () => {
  const r = finalize([
    { date: '2026-06-02', desc: 'OPENAI CHATGPT', amount: 320 },
    { date: '2026-06-02', desc: '國外交易服務費', amount: 5 },
  ], '台新');
  const [a, b] = r.transactions;
  assert.equal(a.category, '工作');
  assert.equal(b.category, '工作', '服務費應跟隨前一筆（OpenAI→工作）');
  assert.equal(b.subcategory, a.subcategory);
});

test('finalize：每筆都帶顯示店名 store（cleanStore 產生）', () => {
  const r = finalize([{ date: '2026-06-02', desc: '連加*阜爾運通股份有限Taipei', amount: 180 }], '台新');
  assert.equal(r.transactions[0].store, '阜爾運通');
  assert.equal(r.transactions[0].category, '交通');   // 分類仍用原始 desc（阜爾運通→停車費）
});

test('parsePdfAuto：依文件內容判斷銀行（不看卡片）', () => {
  assert.equal(parsePdfAuto([['台新銀行'], ['115/06/02', '115/06/05', '星巴克', '150']]).bank, '台新');
  assert.equal(parsePdfAuto([['台北富邦銀行'], ['115/06/02', '星巴克', '115/06/05', '150']]).bank, '富邦');
});

test('extractLastFour：各種卡號樣式抓末四碼', () => {
  assert.equal(extractLastFour('卡號末四碼 1234'), '1234');
  assert.equal(extractLastFour('末4碼：5678'), '5678');
  assert.equal(extractLastFour('**** **** **** 9012'), '9012');
  assert.equal(extractLastFour('卡號 4321-****-****-3456'), '3456');
  assert.equal(extractLastFour('這裡沒有卡號資訊'), null);
});

test('categorize：各大類都命中一個代表商家（防止規則被誤刪）', () => {
  const cases = [
    ['ChatGPT Plus', '工作'], ['YouTube Premium', '學習'], ['中油加油站', '交通'],
    ['Netflix', '娛樂'], ['World Gym', '健康'], ['星巴克', '飲食'],
    ['台電電費', '居住'], ['屈臣氏', '生活'], ['人壽保費', '保險'],
    ['幼兒園學費', '養育'], ['紅十字捐款', '社交'],
  ];
  for (const [desc, cat] of cases) assert.equal(categorize(normalizeDesc(desc))[0], cat, desc);
});

test('cleanStore：更多雜訊清理樣式', () => {
  // 中文主體-中文分店：cleanStore 收尾把分隔符轉全形括號＋品牌簡稱（全家便利商店→全家商店，使用者定 2026-07）
  assert.equal(cleanStore('全家便利商店-三重新陽店A0145 TAIPEI'), '全家商店（三重新陽店）');
  assert.equal(cleanStore('統一超商-德權A2716 TAIPEI'), '統一超商（德權）');
  assert.equal(cleanStore('DECATHLON迪卡儂A0145 TAIPEI'), 'DECATHLON迪卡儂');   // 英文起頭不切
  assert.equal(cleanStore('momo*印用製所TAIPEI'), '印用製所');           // marketplace 前綴
  assert.equal(cleanStore('eTag自動儲值3087-H8'), 'eTag自動儲值');       // 結尾設備碼
});

test('branchNormalize：分店統一成「主體（分店）」（使用者定 2026-07）', () => {
  // ① 分隔符（中文主體＋中文分店）
  assert.equal(branchNormalize('統一超商-百福'), '統一超商（百福）');
  assert.equal(branchNormalize('統一超商-德權'), '統一超商（德權）');
  assert.equal(branchNormalize('統一超商－百福'), '統一超商（百福）');   // 全形破折號
  assert.equal(branchNormalize('IKEA-新莊'), 'IKEA（新莊）');           // 英文品牌＋中文分店也切（分店限純中文）
  assert.equal(branchNormalize('COSTCO-內湖'), 'COSTCO（內湖）');
  // ② 無分隔符的已知連鎖（BRANCH_CHAINS 白名單）
  assert.equal(branchNormalize('誠品生活新店'), '誠品生活（新店）');
  assert.equal(branchNormalize('誠品生活林口'), '誠品生活（林口）');
  // 冪等：已是「…（分店）」不重複包
  assert.equal(branchNormalize('統一超商（百福）'), '統一超商（百福）');
  assert.equal(branchNormalize('誠品生活（新店）'), '誠品生活（新店）');
  // 外幣註記保留、不被當分店
  assert.equal(branchNormalize('統一超商-百福（USD/9.99）'), '統一超商（百福）（USD/9.99）');
  // 不誤切：英文品牌的連字號、未知連鎖的無分隔中文、空字串
  assert.equal(branchNormalize('ABC-MART'), 'ABC-MART');
  assert.equal(branchNormalize('LADY-M'), 'LADY-M');
  assert.equal(branchNormalize('柑園加油站林口二站'), '柑園加油站林口二站');   // 非白名單連鎖，不猜切
  assert.equal(branchNormalize(''), '');
});

test('normalizeStoreDisplay：分店格式＋品牌簡稱（全家便利商店→全家商店，使用者定 2026-07）', () => {
  // 品牌簡稱保留分店
  assert.equal(normalizeStoreDisplay('全家便利商店（漢中店）'), '全家商店（漢中店）');
  // 與分店切分組合：先切分店、再套簡稱
  assert.equal(normalizeStoreDisplay('全家便利商店-三重新陽店'), '全家商店（三重新陽店）');
  // 冪等：已是簡稱不再變
  assert.equal(normalizeStoreDisplay('全家商店（漢中店）'), '全家商店（漢中店）');
  // 不影響其他店家
  assert.equal(normalizeStoreDisplay('統一超商-德權'), '統一超商（德權）');
  // 台亞（加油站）品牌正規化（使用者定 2026-07）：一律「台亞加油站」，有分店才加（分店）
  assert.equal(normalizeStoreDisplay('台亞林口第二交流道南站'), '台亞加油站（林口第二交流道南站）');
  assert.equal(normalizeStoreDisplay('台亞'), '台亞加油站');                       // 無分店＝只回品牌
  assert.equal(normalizeStoreDisplay('台亞加油站'), '台亞加油站');                 // 已是品牌名＝不變（冪等）
  assert.equal(normalizeStoreDisplay('台亞加油站（林口第二交流道南站）'), '台亞加油站（林口第二交流道南站）');   // 冪等
  assert.equal(normalizeStoreDisplay('台亞加油站林口二站'), '台亞加油站（林口二站）');   // 品牌後直接接分店也切
  // 台灣普客二四 → Times Parking
  assert.equal(normalizeStoreDisplay('台灣普客二四'), 'Times Parking');
});
