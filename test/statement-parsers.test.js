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

test('finalize：真正繳款標成 isPayment，不分類', () => {
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
  assert.equal(cleanStore('MUJI無印良品A0145 TAIPEI'), 'MUJI無印良品');   // 英文起頭不切（分店格式規則）
  assert.equal(cleanStore('DECATHLON迪卡儂A0145 TAIPEI'), 'DECATHLON');   // 已進 STORE_CANON（使用者定 2026-07-18）
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
  // 加油站顯示名（使用者定 2026-07-26 改版：一律「加油站（XXX）」；取代同月稍早的「XXX加油站」）：
  // 台亞 canon 仍負責「無分隔符拆分店」，拆出的分店由 gasStationDisplay 包成 加油站（分店）
  assert.equal(normalizeStoreDisplay('台亞林口第二交流道南站'), '加油站（林口第二交流道南）');
  assert.equal(normalizeStoreDisplay('台亞'), '加油站（台亞）');                   // 無分店＝標籤放品牌
  assert.equal(normalizeStoreDisplay('台亞加油站'), '加油站（台亞）');
  assert.equal(normalizeStoreDisplay('台亞加油站（林口第二交流道南站）'), '加油站（林口第二交流道南）');
  assert.equal(normalizeStoreDisplay('加油站（林口第二交流道南）'), '加油站（林口第二交流道南）');   // 新格式冪等（自動整理重複執行不再變）
  assert.equal(normalizeStoreDisplay('林口第二交流道南加油站'), '加油站（林口第二交流道南）');       // 舊格式（07-25 版）收斂
  assert.equal(normalizeStoreDisplay('加油站'), '加油站');   // 使用者自訂名「加油站」＝逐字保留（2026-07-20 鐵則）
  assert.equal(normalizeStoreDisplay('台亞加油站林口二站'), '加油站（林口二）');   // 品牌後直接接分店（黏寫）也收
  // 定點短路（自審B#1/#2 修）：「好市多加油站」真實存在，不可被連鎖白名單重切再坍縮成光桿「加油站」
  assert.equal(normalizeStoreDisplay('好市多加油站'), '加油站（好市多）');     // 品牌保住，不變成光桿「加油站」
  assert.equal(normalizeStoreDisplay('中油-好市多站'), '加油站（好市多）');     // 分店撞連鎖詞照樣轉
  assert.equal(normalizeStoreDisplay(normalizeStoreDisplay('中油-好市多站')), '加油站（好市多）');   // 兩趟＝一趟（冪等）
  assert.equal(normalizeStoreDisplay('好市多加油站中壢店'), '加油站（中壢）');   // 前導「加油站」假分店要摘掉
  // 認得出分店用分店、認不出用品牌（使用者定 2026-07-26）：英文雜訊尾、純編號都不是分店名
  assert.equal(normalizeStoreDisplay('速邁樂加油站TAIPEI'), '加油站（速邁樂）');
  assert.equal(normalizeStoreDisplay('世新加油站2號'), '加油站（世新）');
  // 分店剝完是空（假分店「（加油站）」「（站）」）＝還原「品牌加油站」、不坍縮（自審B#1）
  assert.equal(normalizeStoreDisplay('中油（站）'), '加油站（中油）');
  // 無分隔符也無括號（Codex 複審 2026-07-26）：靠 GAS_BRANDS 品牌前綴切——不可留原樣，
  // 否則畫面同時存在「泰山加油站」與「中油」兩種格式
  assert.equal(normalizeStoreDisplay('中油'), '加油站（中油）');           // 無分店＝標籤放品牌
  assert.equal(normalizeStoreDisplay('統一精工'), '加油站（統一精工）');
  assert.equal(normalizeStoreDisplay('台塑石油'), '加油站（台塑）');       // 台塑石油＝公司名 → 站體招牌
  assert.equal(normalizeStoreDisplay('速邁樂'), '加油站（速邁樂）');
  assert.equal(normalizeStoreDisplay('台塑石油新店站'), '加油站（新店）');   // 無分隔符但有分店
  assert.equal(normalizeStoreDisplay('中油金山站'), '加油站（金山）');
  // 純編號＝使用者認不出是哪一家（「我分不出 2 號 3 號的差別」）→ 品牌；地名夾數字仍是分店
  assert.equal(normalizeStoreDisplay('中油2號站'), '加油站（中油）');
  assert.equal(normalizeStoreDisplay('中油二號站'), '加油站（中油）');
  assert.equal(normalizeStoreDisplay('中油第二站'), '加油站（中油）');
  assert.equal(normalizeStoreDisplay('中油102站'), '加油站（中油）');
  assert.equal(normalizeStoreDisplay('中油林口二站'), '加油站（林口二）');   // 地名＋數字＝分辨得出，要留
  assert.equal(normalizeStoreDisplay('中油加油站'), '加油站（中油）');     // 舊格式收斂
  assert.equal(normalizeStoreDisplay('台塑加油站'), '加油站（台塑）');
  // 設施／服務詞不是分店名 → 用品牌（使用者定 2026-07-26：「自助洗車既然不是分店名，就應該用中油」）
  assert.equal(normalizeStoreDisplay('中油自助洗車站'), '加油站（中油）');
  assert.equal(normalizeStoreDisplay('中油自助洗車'), '加油站（中油）');
  assert.equal(normalizeStoreDisplay('中油大樓'), '加油站（中油）');       // 不硬造「加油站（大樓）」，也不留原樣
  // GAS_BRANDS 刻意不進 BRAND_CANON：那張表對所有店家生效，會把台塑生醫切成「台塑加油站（生醫）」
  assert.equal(normalizeStoreDisplay('台塑生醫'), '台塑生醫');
  // 台灣普客二四（使用者定 2026-07-18：改回中文名，反轉先前的 → Times Parking）：中英寫法統一
  assert.equal(normalizeStoreDisplay('台灣普客二四'), '台灣普客二四');           // 冪等
  assert.equal(normalizeStoreDisplay('Times Parking'), '台灣普客二四');          // 舊資料英文殘留 → 統一
  assert.equal(normalizeStoreDisplay('台灣普客二四股份有'), '台灣普客二四');     // 公司字尾截斷殘尾不當分店
  assert.equal(normalizeStoreDisplay('TIMESPARKING'), '台灣普客二四');           // 無空格寫法也統一
  assert.equal(normalizeStoreDisplay('Times Square'), 'Times Square');           // 只認 Times Parking，別的 Times 開頭不誤傷
  // Codex#5：品牌正規化不可丟掉分店與外幣註記
  assert.equal(normalizeStoreDisplay('台亞加油站-林口站'), '加油站（林口）');         // 帶連字號的分店
  assert.equal(normalizeStoreDisplay('台亞林口站（USD/9.99）'), '加油站（林口）（USD/9.99）');   // 外幣尾碼＝單筆註記，先摘再接回
  assert.equal(normalizeStoreDisplay('台亞加油站（USD/9.99）'), '加油站（台亞）（USD/9.99）');   // 純品牌＋外幣（無分店）
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
  // 優食＝Uber Eats（使用者定 2026-07-18）：同一套規則，標記＝（UE）；平台名不可變成店名、鑰匙不帶標記
  const ue = (desc) => applyDisplayLabels(cleanStore(desc), { desc });
  assert.equal(ue('優食-好麥永和豆漿店'), '好麥永和豆漿店（UE）');
  assert.equal(cleanStore('優食-好麥永和豆漿店'), '好麥永和豆漿店', '鑰匙／清理後店名＝餐廳本身，不是平台');
  assert.equal(ue('優食-八方雲集林口遠雄'), '八方雲集（UE）', '外送不留分店');
  assert.equal(applyDisplayLabels('好麥永和豆漿店（UE）', { desc: '優食-好麥永和豆漿店' }), '好麥永和豆漿店（UE）', '冪等');
  // 只有平台名（沒帶餐廳）＝店家就是 Uber Eats 本身（使用者定 2026-07-26，取代原本的原樣「優食」）；
  // 沒有分隔符＝不觸發外送標記，所以不會變成「Uber Eats（UE）」這種贅字
  assert.equal(ue('優食'), 'Uber Eats');
  assert.equal(ue('優食台灣股份有限公司'), 'Uber Eats');
  assert.equal(stripDisplayLabels('好麥永和豆漿店（UE）'), '好麥永和豆漿店');
  // 優步（Uber）：叫車與外送共用商戶名 → 用「店家是不是車隊」判要不要標（使用者定 2026-07-18）
  const ub = (desc) => applyDisplayLabels(cleanStore(desc), { desc });
  assert.equal(ub('優步-好麥永和豆漿店'), '好麥永和豆漿店（UE）', '外送要標');
  assert.equal(ub('優步-傳承永和豆漿大王林口店'), '傳承永和豆漿大王（UE）', '外送不留分店');
  assert.equal(ub('優步福爾摩沙股份有公司-好麥永和豆漿'), '好麥永和豆漿店（UE）', '公司全名版同理；截斷的店名併回完整名');
  assert.equal(ub('優步-皇冠大車隊'), 'Uber（皇冠大車隊）', '叫車＝店家是 Uber、車隊當分店，不加標記');
  assert.equal(ub('優步-Q2 Taxi車隊Taipei'), 'Uber（Q2 Taxi車隊）', '英文 Taxi 也認得');
  assert.equal(ub('優步福爾摩沙股份有公司'), 'Uber', '只有平台名＝Uber');
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
  // 2026-07-26 起 eTag 停車不再豁免：統一成「停車費（場站）」＝地點優先（場站就是地點）
  assert.equal(park('eTag 停車（救國團林口運動中心）'), '停車費（救國團林口運動中心）', '場站當地點標籤，不留品牌與巢狀括號');
  // ③eTag 場站（使用者定 2026-07-18）：鑰匙只到品牌，場站名從原文補回顯示名
  const etagDesc = 'eTag停車3087-H8:救國團林口運動中心';
  assert.equal(applyDisplayLabels('eTag 停車', { desc: etagDesc, subcategory: '停車費' }), '停車費（救國團林口運動中心）');
  assert.equal(applyDisplayLabels('eTag 停車', { desc: 'eTag停車3087-H8', subcategory: '停車費' }), '停車費（eTag 停車）', '原文沒場站＝退回品牌當標籤（使用者定：都沒有地點就用品牌）');
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
  assert.equal(roundtrip('停車費（eTag停車）', 'eTag停車3087-H8:xxx', '停車費'), '停車費（xxx）', '拆掉贅包裝＋場站名從原文補回後當地點標籤（2026-07-26 新格式）');
  assert.equal(roundtrip('12MINI（FP）', 'FP-12MINI (桃O2732 Taipei', '餐廳'), '12MINI（FP）');
  // 治療路徑：包著標記的舊爛 note 一圈就修好
  assert.equal(roundtrip('停車費（eTag自動儲值）', 'eTag自動儲值3087-H8', '停車費'), 'eTag自動儲值', '被包錯的儲值拆回原名（例外白名單）');
  assert.equal(roundtrip('停車費（悠遊卡自動加值）', '悠遊卡自動加值-停車場亞東科技/TW', '停車費'), '悠遊卡自動加值', '加值同儲值：拆回原名');
  assert.equal(roundtrip('麥味登早午餐（FP）', 'FP-麥味登早午餐(未O2732 Taipei', '早餐'), '麥味登（FP）', '品牌簡稱在 FP 標記內也生效');
  assert.equal(roundtrip('停車費（停車場（Times））', '聯信-台灣普客二四股份有A0145 NEW TA', '停車費'), '停車費（台灣普客二四）');
  assert.equal(roundtrip('停車費（聯信（Times Parking股份有））', '聯信-台灣普客二四股份有A0145 TAIPEI', '停車費'), '停車費（台灣普客二四）');
  assert.equal(roundtrip('停車費（停車場（俥亭停車））', '連加*?亭停車事業股份Taipei', '停車費'), '停車費（俥亭停車）');
});

test('自主體檢｜富邦官網版：店名續行末格恰為純數字 → 不可整筆蒸發；頁尾彙總不可被吸成說明', () => {
  // 修正前：續行判斷用「末格不是金額」，['全聯福利中心','1758'] 被誤判成金額列 → desc 空 → 整筆消失
  const r1 = parseFubon([['115/06/02', '115/06/03', 'TWD', '1,234'], ['全聯福利中心', '1758']]);
  assert.equal(r1.length, 1, '這筆交易不可無聲蒸發');
  assert.ok(r1[0].desc.includes('全聯福利中心'), '續行要接上說明');
  assert.equal(r1[0].amount, 1234);
  // 頁尾彙總列不可被吸成說明（改用「首格不是日期」判準後的守門）
  const r2 = parseFubon([['115/06/02', '115/06/03', 'TWD', '1,234'], ['本期應繳總金額', '5,678']]);
  assert.equal(r2.length, 0, '沒有真說明＋下一列是頁尾彙總 → 這筆維持丟棄，不可掛上「本期應繳總金額」當店名');
});

test('自主體檢｜isAmt 至少要一個數字：「,,,」「-,」不可被當成金額 0／NaN', () => {
  const r = parseFubon([['115/06/02', '115/06/03', '好店', ',,,'], ['115/06/02', '115/06/03', '壞店', '-,']]);
  assert.equal(r.length, 0, '純逗號/負號組合不是金額，整列不可解析成交易');
});
