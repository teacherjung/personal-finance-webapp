// 帳單「解析器」的自動考試（用合成明細列，不需真帳單）：把民國日期、兩家版式、
// 說明合併 bug、國外服務費繼承、銀行內容判斷、末四碼抽取全部鎖住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rocToIso, parseFubon, parseTaishinPdf, finalize, parsePdfAuto,
  extractLastFour, normalizeDesc, cleanStore, categorize, branchNormalize, normalizeStoreDisplay, applyDisplayLabels,
  stripDisplayLabels
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
  assert.equal(branchNormalize('健身工廠林口廠'), '健身工廠（林口廠）');   // 使用者定 2026-07-18
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
  // 麥味登（使用者定 2026-07-18）：銀行兩種寫法統一短的；分店保留
  assert.equal(normalizeStoreDisplay('麥味登早午餐'), '麥味登');
  assert.equal(normalizeStoreDisplay('麥味登'), '麥味登');
  // 台亞（加油站）品牌正規化（使用者定 2026-07）：一律「台亞加油站」，有分店才加（分店）
  assert.equal(normalizeStoreDisplay('台亞林口第二交流道南站'), '台亞加油站（林口第二交流道南站）');
  assert.equal(normalizeStoreDisplay('台亞'), '台亞加油站');                       // 無分店＝只回品牌
  assert.equal(normalizeStoreDisplay('台亞加油站'), '台亞加油站');                 // 已是品牌名＝不變（冪等）
  assert.equal(normalizeStoreDisplay('台亞加油站（林口第二交流道南站）'), '台亞加油站（林口第二交流道南站）');   // 冪等
  assert.equal(normalizeStoreDisplay('台亞加油站林口二站'), '台亞加油站（林口二站）');   // 品牌後直接接分店也切
  // 台灣普客二四（使用者定 2026-07-18：改回中文名，反轉先前的 → Times Parking）：中英寫法統一
  assert.equal(normalizeStoreDisplay('台灣普客二四'), '台灣普客二四');           // 冪等
  assert.equal(normalizeStoreDisplay('Times Parking'), '台灣普客二四');          // 舊資料英文殘留 → 統一
  assert.equal(normalizeStoreDisplay('台灣普客二四股份有'), '台灣普客二四');     // 公司字尾截斷殘尾不當分店
  assert.equal(normalizeStoreDisplay('TIMESPARKING'), '台灣普客二四');           // 無空格寫法也統一
  assert.equal(normalizeStoreDisplay('Times Square'), 'Times Square');           // 只認 Times Parking，別的 Times 開頭不誤傷
  // Codex#5：品牌正規化不可丟掉分店與外幣註記
  assert.equal(normalizeStoreDisplay('台亞加油站-林口站'), '台亞加油站（林口站）');           // 帶連字號的分店
  assert.equal(normalizeStoreDisplay('台亞林口站（USD/9.99）'), '台亞加油站（林口站）（USD/9.99）');   // 外幣尾碼保留
  assert.equal(normalizeStoreDisplay('台亞加油站（USD/9.99）'), '台亞加油站（USD/9.99）');     // 純品牌＋外幣（無分店）
});

test('顯示標記｜FP 外送（使用者定 2026-07-18）：帳單原文有 FP 前綴 → 店名尾加（FP）', () => {
  const fp = (desc) => applyDisplayLabels(cleanStore(desc), { desc });
  assert.equal(fp('FP-麥味登'), '麥味登（FP）');
  assert.equal(fp('FP-石二鍋(林口家樂O2732 Taipei'), '石二鍋（FP）');   // 清理＋標記併行
  assert.equal(fp('FP*珍煮丹'), '珍煮丹（FP）');                        // 星號分隔
  assert.equal(fp('FP 21PLUS'), '21PLUS（FP）');                        // 空白分隔
  assert.equal(fp('FPGROUP企業'), 'FPGROUP企業');                       // FP 後無分隔符＝本來就叫 FPxxx，不誤傷
  assert.equal(fp('foodpanda-ECO2732 Taipei'), 'foodpanda');            // foodpanda 自家扣款（非餐廳）不標記
  // 冪等：已標記過的不再重複加
  assert.equal(applyDisplayLabels('麥味登（FP）', { desc: 'FP-麥味登' }), '麥味登（FP）');
  // storeKey（身分鑰匙）保持乾淨、不含標記
  assert.equal(cleanStore('FP-麥味登'), '麥味登');
  // 外送不留分店（使用者定 2026-07-18）：顯示名尾端的分店括號被摘掉 → 主體（FP）
  const fpDesc = 'FP-12MINI (桃O2732 Taipei';
  assert.equal(applyDisplayLabels('12MINI（桃園龜山復興一店）', { desc: fpDesc }), '12MINI（FP）');
  assert.equal(applyDisplayLabels('12MINI（新店萬家福店）', { desc: fpDesc }), '12MINI（FP）');
  assert.equal(applyDisplayLabels('12MINI（FP）', { desc: fpDesc }), '12MINI（FP）', '已是主體（FP）＝冪等');
  // 外幣註記不被當分店摘掉
  assert.equal(applyDisplayLabels('全家商店（漢中店）（USD/9.99）', { desc: 'FP-全家' }), '全家商店（FP）（USD/9.99）');
  // 優食＝Uber Eats（使用者定 2026-07-18）：同一套規則，標記換成（優食）；平台名不可變成店名
  const ue = (desc) => applyDisplayLabels(cleanStore(desc), { desc });
  assert.equal(ue('優食-好麥永和豆漿店'), '好麥永和豆漿店（優食）');
  assert.equal(cleanStore('優食-好麥永和豆漿店'), '好麥永和豆漿店', '鑰匙／清理後店名＝餐廳本身，不是平台');
  assert.equal(ue('優食-八方雲集林口遠雄'), '八方雲集（優食）', '外送不留分店');
  assert.equal(applyDisplayLabels('好麥永和豆漿店（優食）', { desc: '優食-好麥永和豆漿店' }), '好麥永和豆漿店（優食）', '冪等');
  assert.equal(ue('優食'), '優食', '只有平台名（店名救不回）＝不加贅括號');
  assert.equal(stripDisplayLabels('好麥永和豆漿店（優食）'), '好麥永和豆漿店');
});

test('顯示標記｜停車（使用者定 2026-07-18）：子類＝停車費 → 停車費（原店名）', () => {
  const park = (name) => applyDisplayLabels(name, { subcategory: '停車費' });
  // 依「分類」而非店名字面——名字沒有「停車」二字的停車場也涵蓋得到
  assert.equal(park('嘟嘟房台北西門站'), '停車費（嘟嘟房台北西門站）');
  assert.equal(park('阜爾運通'), '停車費（阜爾運通）');
  assert.equal(park('Times Parking'), '停車費（Times Parking）');
  assert.equal(park('嘟嘟房'), '停車費（嘟嘟房）');
  // 冪等：已是「停車費（…）」不再包一層
  assert.equal(park('停車費（嘟嘟房台北西門站）'), '停車費（嘟嘟房台北西門站）');
  // 例外白名單（使用者定 2026-07-18）：「儲值/加值」不是在某停車場繳費 → 維持原名不包
  assert.equal(park('eTag自動儲值'), 'eTag自動儲值');
  assert.equal(park('悠遊卡自動加值'), '悠遊卡自動加值');
  assert.equal(park('eTag 停車（救國團林口運動中心）'), 'eTag 停車（救國團林口運動中心）', '名字已是停車語意（eTag 停車）＝不再包一層');
  // ③eTag 場站（使用者定 2026-07-18）：鑰匙只到品牌，場站名從原文補回顯示名
  const etagDesc = 'eTag停車3087-H8:救國團林口運動中心';
  assert.equal(applyDisplayLabels('eTag 停車', { desc: etagDesc, subcategory: '停車費' }), 'eTag 停車（救國團林口運動中心）');
  assert.equal(applyDisplayLabels('eTag 停車', { desc: 'eTag停車3087-H8', subcategory: '停車費' }), 'eTag 停車', '原文沒場站＝維持品牌名');
  assert.equal(applyDisplayLabels('我的停車', { desc: etagDesc, subcategory: '停車費' }), '停車費（我的停車）', '使用者自訂名不被場站覆蓋（照一般停車規則包）');
  // 不是停車費子類的不套用（即使店名有「停車」二字）
  assert.equal(applyDisplayLabels('正好停車場旁小吃', { subcategory: '餐廳' }), '正好停車場旁小吃');
  // 兩個標記可併存（FP 外送的停車費，理論組合；順序＝FP 先、停車包在外層）
  assert.equal(applyDisplayLabels('某場', { desc: 'FP-某場', subcategory: '停車費' }), '停車費（某場（FP））');
});

test('雜訊主體拆殼（使用者回報 2026-07-18）：聯信／停車場被誤當主體 → 拆出真店名再正規化', () => {
  // 舊規則把收單方「聯信」、類別詞「停車場」當成主體，真店名被關進括號——整理要能治這些舊 note
  assert.equal(normalizeStoreDisplay('聯信（Times Parking股份有）'), '台灣普客二四');   // 拆殼＋修殘尾＋統一中文名
  assert.equal(normalizeStoreDisplay('停車場（Times）'), '台灣普客二四');               // 「Times」單獨出現＝普客二四舊縮寫
  assert.equal(normalizeStoreDisplay('停車場（俥亭停車）'), '俥亭停車');
  assert.equal(normalizeStoreDisplay('聯信（台灣普客二四股份有）'), '台灣普客二四');
  // 拆完是乾淨名 → 再走一圈不變（冪等）
  assert.equal(normalizeStoreDisplay('俥亭停車'), '俥亭停車');
  // 只認白名單主體：其他店名的括號分店不拆
  assert.equal(normalizeStoreDisplay('統一超商（德權）'), '統一超商（德權）');
});

test('stripDisplayLabels：把顯示標記拆回乾淨店名（店名格式整理用）', () => {
  assert.equal(stripDisplayLabels('停車費（台灣普客二四）'), '台灣普客二四');
  assert.equal(stripDisplayLabels('停車費（停車場（Times））'), '停車場（Times）');   // 巢狀括號取最外層
  assert.equal(stripDisplayLabels('12MINI（FP）'), '12MINI');
  assert.equal(stripDisplayLabels('品田牧場（FP）（USD/9.99）'), '品田牧場（USD/9.99）');   // 外幣註記保留
  assert.equal(stripDisplayLabels('停車費（某場（FP））'), '某場');                    // 兩層標記都拆
  assert.equal(stripDisplayLabels('普通店名'), '普通店名');                            // 沒標記＝不動
  // 拆→整理→重上標記＝冪等（正確的 note 走整理流程不變）
  const roundtrip = (note, desc, sub) =>
    applyDisplayLabels(normalizeStoreDisplay(stripDisplayLabels(note)), { desc, subcategory: sub });
  assert.equal(roundtrip('停車費（台灣普客二四）', '聯信-台灣普客二四股份有A0145 TAIPEI', '停車費'), '停車費（台灣普客二四）');
  assert.equal(roundtrip('停車費（eTag停車）', 'eTag停車3087-H8:xxx', '停車費'), 'eTag 停車（xxx）', '拆掉贅包裝＋場站名從原文補回（顯示層 ③）');
  assert.equal(roundtrip('12MINI（FP）', 'FP-12MINI (桃O2732 Taipei', '餐廳'), '12MINI（FP）');
  // 治療路徑：包著標記的舊爛 note 一圈就修好
  assert.equal(roundtrip('停車費（eTag自動儲值）', 'eTag自動儲值3087-H8', '停車費'), 'eTag自動儲值', '被包錯的儲值拆回原名（例外白名單）');
  assert.equal(roundtrip('停車費（悠遊卡自動加值）', '悠遊卡自動加值-停車場亞東科技/TW', '停車費'), '悠遊卡自動加值', '加值同儲值：拆回原名');
  assert.equal(roundtrip('麥味登早午餐（FP）', 'FP-麥味登早午餐(未O2732 Taipei', '早餐'), '麥味登（FP）', '品牌簡稱在 FP 標記內也生效');
  assert.equal(roundtrip('停車費（停車場（Times））', '聯信-台灣普客二四股份有A0145 NEW TA', '停車費'), '停車費（台灣普客二四）');
  assert.equal(roundtrip('停車費（聯信（Times Parking股份有））', '聯信-台灣普客二四股份有A0145 TAIPEI', '停車費'), '停車費（台灣普客二四）');
  assert.equal(roundtrip('停車費（停車場（俥亭停車））', '連加*?亭停車事業股份Taipei', '停車費'), '停車費（俥亭停車）');
});
