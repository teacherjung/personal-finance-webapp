// 帳單解析器的「自動考試」：把消費分類與店名清理的規則鎖住，改壞任何一條都會考不過。
// 跑法：npm test（用 Node 內建測試工具，零相依）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, cleanStore, normalizeDesc, storeKeyOf, storeKeyOfName, origFromStmtRef, isPlatformArtifactName } from '../lib/statement.js';

test('categorize：消費說明 → 正確的分類/子類', () => {
  const cases = [
    ['星巴克', ['飲食', '飲料／咖啡']],
    ['World Gym 台北', ['健康', '健身房']],
    ['大樹藥局', ['健康', '醫藥']],
    ['牙醫診所', ['健康', '牙科']],
    ['迪卡儂運動用品', ['健康', '運動用品']],
    ['摩斯漢堡', ['飲食', '餐廳']],
    ['涮乃葉新店店', ['飲食', '餐廳']],
    ['馬可先生麵包', ['飲食', '早餐／便當']],
    ['地價稅 114年', ['居住', '']],
    ['房屋稅 114年', ['居住', '']],
    ['ROBLOX', ['娛樂', '遊戲']],
    ['友邦人壽保費', ['保險', '壽險']],
    ['OMGYES.COM', ['健康', '']],
    ['悠遊卡自動加值', ['生活', '其他生活雜支']],   // 「自動加值」要排在「悠遊卡→交通」之前
    ['TAPPAY_台灣國際開發', ['交通', '停車費']],
    ['ＦＰ－石二鍋', ['飲食', '餐廳']],              // 外送前綴不影響：石二鍋仍→餐廳
    ['某不存在的神秘小店', ['其他', '未分類']],       // 認不出→其他/未分類
  ];
  for (const [desc, expected] of cases) {
    assert.deepEqual(categorize(normalizeDesc(desc)), expected, `categorize(${desc})`);
  }
});

test('cleanStore：帳單店名清理（涵蓋使用者指定的 14 條規則）', () => {
  const cases = [
    ['Apple Xinyi A第03/12期/TW', 'Apple Xinyi A第03/12期'],
    ['連加*阜爾運通股份有限Taipei', '阜爾運通'],
    ['21PLUS、21O2732 Taipei', '21PLUS'],
    ['摩斯漢堡Mos BO2732 Taipei', '摩斯漢堡'],
    ['OMGYESA2716 OMGYES', 'OMGYES'],
    // eTag 停車（使用者定 2026-07-18）：身分鑰匙只到品牌（所有場站＝同一家）；場站名屬顯示層（applyDisplayLabels ③）
    ['eTag停車3087-H8:救國團林口運動中心', 'eTag 停車'],
    ['eTag停車3087-H8:?亭新店行政園區', 'eTag 停車'],
    ['eTag停車3087-H8', 'eTag 停車'],
    // 健身工廠（使用者定 2026-07-18）：進 BRANCH_CHAINS 白名單 → 無分隔符也切分店
    ['連加*連加*健身工廠林口廠', '健身工廠（林口廠）'],
    ['悠遊卡自動加值-正好停—正好停— /TW', '悠遊卡自動加值'],
    ['柑園加油站有限公司林口二站TAIPEI', '柑園加油站林口二站'],
    ['foodpanda-ECO2732 Taipei', 'foodpanda'],
    ['騰加數位*馬可先生新莊店', '馬可先生'],
    ['五桐號WooTEA0145 Taipei', '五桐號'],
    ['順康資產管理顧問有限公司', '順康資產管理顧問'],
    ['六必居潮州一品沙A0145', '六必居'],
    ['FP-石二鍋(林口家樂O2732 Taipei', '石二鍋'],   // cleanStore 砍掉 FP 前綴＝乾淨身分；「（FP）」標記在顯示層
    // 額外：OPENAI* 不當金流前綴、外幣註記保留、截斷只能到某處
    ['OPENAI* CHATGPT CREDITOPENAI', 'OpenAI'],
    ['COURSERA.ORGO5190 COURSE（USD/17.00）', 'COURSERA.ORGO5190 COURSE（USD/17.00）'],
    ['TAPPAY_台灣國際開A2716 TAIPEI', '台灣國際開'],
    // 停車三案（使用者回報 2026-07-18）：聯信＝收單方前綴要砍、公司字尾截斷殘尾要修、「?亭」＝俥亭缺字
    ['聯信-台灣普客二四股份有A0145 TAIPEI', '台灣普客二四'],   // 聯信-＋股份有（截斷）都是雜訊
    ['聯信-台灣普客二四股份有A0145 NEW TA', '台灣普客二四'],
    ['連加*?亭停車事業股份Taipei', '俥亭停車'],               // ?＝「俥」超出 Big5 的銀行缺字；事業股份＝截斷殘尾
    ['聯信-%Arabica象A0145 TAIPEI', '%Arabica象'],            // 聯信- 砍掉後其餘照常清理
    // 金流前綴疊兩層（使用者回報 2026-07-18）：連加*連加*… 要剔到乾淨，不可遺留一個
    ['連加*連加*摩斯漢堡APP', '摩斯漢堡'],
    // 國外交易服務費（使用者定 2026-07-18）：帶出對應簽帳金額 →（-金額）；台新/富邦兩種寫法；無金額不變
    ['國外交易服務費(簽帳15,925 )', '國外交易服務費（-15,925）'],
    ['國外交易服務費-3781.00', '國外交易服務費（-3,781）'],
    ['國外交易服務費', '國外交易服務費'],
    // 路易莎（使用者定 2026-07-18）：LOUISA COFFE（銀行截斷）全部＝林口文三門市
    ['LOUISA COFFEA0145 NEW TA', '路易莎咖啡（林口文三門市）'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(cleanStore(raw), expected, `cleanStore(${raw})`);
  }
});

test('categorize：優步（Uber）叫車 vs 外送（使用者定 2026-07-18）', () => {
  // 「優步」不再當叫車關鍵字（會把外送全判成交通）；叫車認「車隊/Taxi」，認不出店家才走檔尾保底
  assert.deepEqual(categorize('優步-好麥永和豆漿店'), ['飲食', '早餐／便當']);
  assert.deepEqual(categorize('優步-傳承永和豆漿大王林口店'), ['飲食', '早餐／便當']);
  assert.deepEqual(categorize('優步-皇冠大車隊'), ['交通', '計程車／Uber']);
  assert.deepEqual(categorize('優步-Yoxi車隊'), ['交通', '計程車／Uber']);
  assert.deepEqual(categorize('優步福爾摩沙股份有公司'), ['交通', '計程車／Uber'], '保底：認不出店家＝叫車');
});

test('cleanStore：分類仍用原始說明、不受清理影響', () => {
  // FP-石二鍋 清成身分名「石二鍋」（「（FP）」是顯示層標記），分類仍用原始字串判斷 → 飲食/餐廳
  assert.equal(cleanStore('FP-石二鍋(林口家樂O2732 Taipei'), '石二鍋');
  assert.deepEqual(categorize('FP-石二鍋(林口家樂O2732 Taipei'), ['飲食', '餐廳']);
});

test('normalizeDesc：全形英數→半形、去 CJK 間多餘空白', () => {
  assert.equal(normalizeDesc('ＡＢＣ１２３'), 'ABC123');
  assert.equal(normalizeDesc('台  北  富  邦'), '台北富邦');
});

test('身分鑰匙 storeKeyOf：品牌層（不含分店）＋加油站聚合（使用者定 2026-07-18）', () => {
  // 顯示名帶分店、鑰匙只到品牌——兩者分工
  const cases = [
    ['統一超商-百福A2716 TAIPEI', '統一超商（百福）', '統一超商'],
    ['全家便利商店-三重新陽店A0145 TAIPEI', '全家商店（三重新陽店）', '全家商店'],
    ['八方雲集林口遠雄A0145 TAIPEI', '八方雲集（林口遠雄）', '八方雲集'],
    ['少年家宵夜食堂新北林口A0145 TAIPEI', '少年家宵夜食堂（新北林口）', '少年家宵夜食堂'],
    ['石二鍋林口家樂福A0145 TAIPEI', '石二鍋（林口家樂福）', '石二鍋'],
    ['三顧茅廬-林口文O2732 Taipei', '三顧茅廬（林口文）', '三顧茅廬'],
    ['無老鍋-台北永康店A0145 TAIPEI', '無老鍋（台北永康店）', '無老鍋'],
    ['台北101-室內觀景台A0145 TAIPEI', '台北101（室內觀景台）', '台北101'],
    ['LOUISA COFFEA0145 NEW TA', '路易莎咖啡（林口文三門市）', '路易莎咖啡'],
    ['台灣麥當勞MOP-056', '麥當勞', '麥當勞'],
    ['紅陽科技六本木', '六松今苑壽喜燒', '六松今苑壽喜燒'],
    // 加油站：各品牌顯示名照舊，鑰匙一律「加油站」（使用者定：所有加油站算同一件事）
    ['中油-林口工三站A0145 TAIPEI', '中油（林口工三站）', '加油站'],
    ['台亞林口中山站', '台亞加油站（林口中山站）', '加油站'],
    ['車容坊加油站-文二站A0145 TAIPEI', '車容坊加油站（文二站）', '加油站'],
    ['柑園加油站有限公司林口二站TAIPEI', '柑園加油站林口二站', '加油站'],
    ['世新加油站A0145 TAIPEI', '世新加油站', '加油站'],
    // 好市多（使用者定 2026-07-18）：無分隔符連鎖白名單
    ['好市多中和店A0145 TAIPEI', '好市多（中和店）', '好市多'],
    ['好市多北投店A0145 TAIPEI', '好市多（北投店）', '好市多'],
    // 標準名（使用者定 2026-07-18）：銀行截斷／英文原名 → 看得懂的名字，鑰匙同值
    ['肯德基KFC炸雞漢A0145 TAIPEI', '肯德基', '肯德基'],
    ['STARBUCKSA0145 TAIPEI', '星巴克', '星巴克'],
    ['星巴克MITSUI門市A0145 TAIPEI', '星巴克', '星巴克'],
    ['DECATHLON TAIWATaichu', 'DECATHLON', 'DECATHLON'],
    ['DECATHLON迪卡儂A0145 TAIPEI', 'DECATHLON', 'DECATHLON'],
    ['長庚醫療財團法人林口長庚紀念醫', '林口長庚醫院', '林口長庚醫院'],
    ['三新奧特萊斯林口I館A0145 TAIPEI', '林口三井', '林口三井'],
    ['卡哇依A0145 TAIPEI', '兒童新樂園', '兒童新樂園'],
    // 威秀影城＝分店白名單（顯示留分店、鑰匙只到品牌）
    ['威秀影城信義分A0145 TAIPEI', '威秀影城（信義分）', '威秀影城'],
    ['威秀影城新店A0145 TAIPEI', '威秀影城（新店）', '威秀影城'],
    // 金流／平台前綴（使用者定 2026-07-18）：藍新＝金流商、點點付＝金流商、優步＝Uber 平台
    ['藍新-聲島咖啡BeingCa', '聲島咖啡', '聲島咖啡'],
    ['點點付-水灣餐廳_碧潭店A2716 TAIPEI', '水灣餐廳（碧潭店）', '水灣餐廳'],   // 底線也切分店
    ['蘋果電腦-台灣-ECA0145 Taipei', '蘋果電腦', '蘋果電腦'],
    // 優步＝Uber：底下混著叫車與外送，平台名不可當店家（否則全部共用一把鑰匙）
    ['優步-皇冠大車隊', 'Uber（皇冠大車隊）', 'Uber'],           // 叫車＝店家是 Uber，車隊當分店
    ['優步-Q2 Taxi車隊Taipei', 'Uber（Q2 Taxi車隊）', 'Uber'],
    ['優步福爾摩沙股份有公司', 'Uber', 'Uber'],                    // 只有平台名（沒帶店家）
    ['優步-好麥永和豆漿店', '好麥永和豆漿店', '好麥永和豆漿店'],   // 外送＝店家是餐廳
    ['優步福爾摩沙股份有公司-傳承永和豆漿', '傳承永和豆漿', '傳承永和豆漿'],
    ['優步-傳承永和豆漿大王林口店', '傳承永和豆漿大王（林口店）', '傳承永和豆漿大王'],
  ];
  for (const [raw, display, key] of cases) {
    assert.equal(cleanStore(raw), display, `顯示名(${raw})`);
    assert.equal(storeKeyOf(raw), key, `身分鑰匙(${raw})`);
  }
  // 外幣註記不可被當分店摘掉
  assert.equal(storeKeyOfName('品田牧場（USD/9.99）'), '品田牧場（USD/9.99）');
  // 沒有分店的名字＝原樣
  assert.equal(storeKeyOfName('石二鍋'), '石二鍋');
  assert.equal(storeKeyOf('eTag停車3087-H8:救國團林口運動中心'), 'eTag 停車', '場站屬顯示層，鑰匙只到品牌');
});

test('origFromStmtRef：從 stmtRef 取回帳單原文（原文可含「|」）', () => {
  assert.equal(origFromStmtRef('c1|2026-07-15|55|統一超商-百福A2716'), '統一超商-百福A2716');
  assert.equal(origFromStmtRef('c1|2026-07-15|55|A|B'), 'A|B');
  assert.equal(origFromStmtRef('c1|2026-07-15|55'), '');
  assert.equal(origFromStmtRef(''), '');
  assert.equal(origFromStmtRef(undefined), '');
});

test('假自訂名 isPlatformArtifactName（使用者定 2026-07-18）：平台被當店名時留下的殘骸', () => {
  assert.equal(isPlatformArtifactName('優食（UE）'), true, '店名被外送規則吃掉、只剩平台＋標記');
  assert.equal(isPlatformArtifactName('優食（永和豆漿大王林口店）'), true, '舊版把平台當主體時使用者跟著取的名字');
  assert.equal(isPlatformArtifactName('優步（皇冠大車隊）'), true);
  assert.equal(isPlatformArtifactName('優食'), true);
  assert.equal(isPlatformArtifactName('好麥永和豆漿店'), false, '真的自訂名不可誤判');
  assert.equal(isPlatformArtifactName('Uber Eats'), false);
  assert.equal(isPlatformArtifactName('優食堂'), false, '店名剛好以平台名開頭但不是「平台（…）」格式');
  assert.equal(isPlatformArtifactName(''), false);
  assert.equal(isPlatformArtifactName(undefined), false);
});
