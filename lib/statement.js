// @ts-check
// 信用卡帳單 PDF 解析：解密（密碼存卡片的 pdfPassword，本機 store.json、永不進版控）、
// 抽出消費明細、關鍵字自動分類（兩層：分類／子類）。PDF 本身不落地保存，只回傳解析結果。
// v1 支援富邦；**新增銀行＝加一支 parseXxx() 並補進 `lib/card-identity.js` 的 OWN_ISSUERS ＋ parsePdfAuto**。
// ⚠️ 不是「依卡片 issuer 分流」——機構身分由**帳單內容**判（見 card-identity.js 檔頭），卡片只決定記到哪。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { assertPageLimit, readPageTextCapped } from './parse-limits.js';
import { extractPdfLines, extractXlsxIsolated } from './pdf-isolate.js';
import * as XLSX from 'xlsx';
import { DEFAULT_EXPENSE } from '../public/modules/categories.js';
// 使用者自訂的店名規則（第三帖）：純資料存在 settings.storeRules，由 repo 櫃檯餵進 store-rules.js。
// 本檔把「使用者規則排在內建規則前面」（使用者要蓋得過內建判斷）：cleanStore 的 STORE_CANON、
// applyBrandCanon、applyBrandRename、branchNormalize 的連鎖白名單、applyDisplayLabels 的停車豁免。
// ⚠️ 分類規則（CATEGORY_RULES）刻意不開放——storeKeyOf 用 categorize 判「油錢→加油站」，
// 分類可編輯的話身分鑰匙會漂移、既有學習全部對不上。鑰匙的判定基礎凍結在內建規則（考題鎖住）。
import { getUserRules } from './store-rules.js';
import { isRealDate } from './schema.js';   // 真日曆驗證（自主體檢：假日期不可流到寫入櫃檯才炸）
import { identifyIssuer, assertCardIdentityInvariants } from './card-identity.js';
/** @typedef {import('./types.js').RawTx} RawTx */
/** @typedef {import('./types.js').ParsedTx} ParsedTx */
/** @typedef {import('./types.js').StatementResult} StatementResult */

// ---- 關鍵字 → [分類, 子類]（比對「消費說明」，由上往下先中先贏）----
// 分類字串必須對得上 public/modules/categories.js 的 EXPENSE_TREE（AGENTS.md 同步點）。
// 順序重點：特殊指定（YouTube→學習、ChatGPT/Claude/Notion→工作、汽車保險→交通）與
// 較專一的關鍵字要排在通用之前，才不會被通用規則先攔截。
/** 每條＝[分類, 子類, 關鍵字陣列]。 @type {[string, string, string[]][]} */
const CATEGORY_RULES = [
  // 詐騙標記（使用者定 2026-07-27）：NextGen＝確認過的詐騙扣款，優先於一切規則（放最前＝先中先贏）。
  // 子分類「詐騙」需存在於使用者的分類樹（其他→詐騙）才會完整生效；樹裡沒有時 conform 降為「其他/不分子類」。
  ['其他', '詐騙', ['NEXTGEN']],
  // 工作（軟體訂閱要在其他通用之前）
  ['工作', 'ChatGPT', ['CHATGPT', 'OPENAI']],
  ['工作', 'Claude', ['CLAUDE', 'ANTHROPIC']],
  ['工作', 'Notion', ['NOTION']],
  ['工作', 'Canva及其他工作軟體', ['CANVA', 'ADOBE', 'FIGMA', 'MICROSOFT', 'OFFICE 365', 'MICROSOFT 365', 'ELEVENLABS', 'HEYGEN', 'SYNTHESIA', 'DESCRIPT', 'ZAPIER', 'AIRTABLE', 'GRAMMARLY', 'LINKEDIN']],
  ['工作', '網站／網域／雲端服務', ['GITHUB', 'DROPBOX', 'GODADDY', 'CLOUDFLARE', 'VERCEL', 'AWS', 'GOOGLE CLOUD', '網域']],
  // 學習
  ['學習', 'YouTube Premium', ['YOUTUBE']],
  ['學習', '學習型訂閱服務', ['UDEMY', 'COURSERA', 'HAHOW', '均一', '線上課程', 'MASTERCLASS', '思維槓桿', 'PRESSPLAY', '知識訂閱']],
  ['學習', '書籍', ['博客來', '讀冊', '金石堂', '誠品書', 'BOOKS']],
  ['學習', '考試／證照費', ['測驗中心', '報名費', '證照', '檢定']],
  // 悠遊卡/一卡通自動加值歸生活（使用者定）。要排在「整個交通區塊」之前——加值可能在停車場/車隊
  // 觸發（悠遊卡自動加值-和雲…），排後面會被「和雲/停車」關鍵字搶走判成停車費（帳務體檢 D2 抓到，2026-07-19）。
  // eTag自動儲值 不受影響（字樣是「儲值」，由下方 ETAG自動儲值 關鍵字明確歸停車費）。
  ['生活', '其他生活雜支', ['自動加值']],
  // 交通（汽車保險要在保險之前）
  ['交通', '汽車保險', ['汽車保險', '強制險', '車體險', '車險']],
  // 台塑生醫（同集團的日用品門市）＝正確歸類、也替下面的台塑判準多一道保險（先中先贏；使用者定 2026-07-25）
  ['生活', '日用品', ['台塑生醫']],
  // 台塑＝窄關鍵字四變體（使用者定 2026-07-25）：光「台塑」會把台塑牛排（餐廳）鑰匙併進加油站、
  // 台塑大樓停車場判成油錢（自審B 實測）。「台塑（」補的是**清理後的名字**（台塑-新店站 →
  // 台塑（新店站），連字號已不在）——顯示名判準（gasStationDisplay）看的正是這一形。
  // 若使用者帳單上的台塑寫法四種都接不到（如「台塑加盟站XX」），貼原文來補一條即可。
  ['交通', '油錢', ['中油', '台亞', '加油站', '加油', '福記', '柑園加油', '統一精工', '速邁樂', '台塑-', '台塑石油', '台塑加油', '台塑（']],
  // 佳音林口文化二路＝停車場（使用者確認 2026-07-27）。**必須用完整字樣、不可只寫「佳音」**——
  // 「佳音」是下方 補習／才藝 的關鍵字（佳音美語），寫短的會把補習費判成停車費。這條排在前面才贏得過它
  //（先中先贏）。⚠️ 不修的話：鑰匙只認**內建**分類器讀原文的結果（storeKeyOf 刻意不看使用者改過的分類，
  // 否則改分類會讓鑰匙漂移），內建判成補習 → 這家停車場永遠併不進「停車費」那把鑰匙。
  ['交通', '停車費', ['佳音林口文化二路']],
  // 詮營＝停車場（使用者確認 2026-07-27）。名字看不出是停車，內建判「其他/未分類」→ 鑰匙併不進停車聚合
  //（storeKeyOf 只認內建分類、不看使用者改過的分類，見下方註解）。與 佳音林口文化二路 同一類補件。
  ['交通', '停車費', ['停車', '嘟嘟房', '停車場', '城市車旅', '和雲', 'TIMES', '拖吊', '阜爾運通', '普客二四', '順康資產', '林口四維路', '綠湖', '嘟嘟房', '詮營']],
  // 叫車認「車隊」而非「優步」：優步（Uber）同一個商戶名底下混著叫車與外送（優步-好麥永和豆漿店＝外送），
  // 用 優步 當關鍵字會把外送全判成交通。純「優步-<認不出的店家>」由檔尾的保底規則收（使用者定 2026-07-18）。
  ['交通', '計程車／Uber', ['UBER TRIP', '車隊', '計程車', 'TAXI', '55688', 'YOXI', 'Q2 TAXI', 'Q２']],
  ['交通', '停車費', ['ETAG停車', 'ETAG自動儲值', '泊車', '長庚泊車']],
  ['交通', '停車費', ['TAPPAY', '台灣國際開發']],   // TapPay 第三方支付，使用者的多為停車（非停車者可於預覽/事後逐筆改）
  ['交通', '大眾運輸', ['悠遊卡', '一卡通', '高鐵', '台鐵', '捷運', '客運', '公車', '台灣鐵路', '微笑單車', 'YOUBIKE']],
  ['交通', '過路費', ['ETAG', '遠通電收', '國道']],
  ['交通', '牌照稅', ['牌照稅']],
  ['交通', '燃料使用費', ['燃料費', '燃料使用']],
  ['交通', '汽車保養', ['汽車保養', '原廠保養', '定保', '現代汽車', '和泰汽車', '汎德', '保養廠']],
  ['交通', '洗車', ['洗車']],
  // 娛樂（旅遊、影音、遊戲…）
  ['娛樂', '旅遊', ['AGODA', 'BOOKING.COM', 'BOOKING ', 'EXPEDIA', 'AIRBNB', 'HOTELS.COM', 'TRIP.COM', 'KKDAY', 'KLOOK', '客路', 'FLICKKET', '雄獅', '易遊網', '可樂旅遊', '五福旅遊', '燦星', '旅行社', '訂房', '飯店', '酒店', '旅館', '民宿', '度假村', 'RESORT', 'HOTEL', '溫泉會館', '汽車旅館', '風閣', '航空', '機票', 'EVA AIR', 'TIGERAIR', '護照', '領事', '簽證', '外交部領事']],
  ['娛樂', 'Netflix及影音串流', ['NETFLIX', 'DISNEY', 'HBO', 'PRIME VIDEO', 'FRIDAY影音', 'CATCHPLAY']],
  ['娛樂', '音樂', ['SPOTIFY', 'KKBOX', 'APPLE MUSIC']],
  ['娛樂', '遊戲', ['STEAM', 'PLAYSTATION', 'NINTENDO', 'GOOGLE PLAY', '遊戲橘子', '巴哈姆特', 'ROBLOX']],
  ['娛樂', '電影', ['威秀', '秀泰', '國賓影城', '新光影城', '影城', '電影', 'CINEMA', 'VIESHOW']],
  ['娛樂', '樂園／展覽', ['樂園', '動物園', '展覽', '美術館', '博物館', '六福', '劍湖山', '麗寶', '台北101', '觀景台', 'KTV']],
  // 健康（醫療/美容/健身/按摩）
  ['健康', '', ['OMGYES']],   // 性教育內容，使用者歸健康
  ['健康', '健身房', ['健身', 'GYM', 'WORLD GYM', 'ANYTIME']],
  ['健康', '美髮', ['髮藝', '美髮', '造型', '沙龍', 'HAIR', '剪髮']],
  ['健康', '美容', ['美容', '護膚', '美甲', '美睫', 'SPA', '芳療']],
  ['健康', '按摩', ['按摩', '指壓', '紓壓', '推拿', '整復']],
  ['健康', '牙科', ['牙醫', '牙科']],
  ['健康', '看診', ['醫院', '診所', '醫療', '婦產', '眼科', '皮膚科']],
  ['健康', '醫藥', ['藥局', '藥師', '大樹', '杏一']],
  ['健康', '健檢', ['健檢', '健康檢查']],
  ['健康', '保健食品', ['保健', '維他命', '善存', '葡萄王']],
  ['健康', '運動用品', ['DECATHLON', '迪卡儂', '運動用品', '迪卡']],
  ['健康', '運動課程', ['攀岩', '運動中心', '游泳池', '瑜珈', '皮拉提斯', '拳擊', '飛輪']],
  // 飲食（先認真正的店家，把子類判準；外送平台前綴放最後當保底，確保仍落在飲食）
  ['飲食', '零食', ['COLD STONE', 'COLDSTONE', '冰淇淋', '霜淇淋', 'ICE CREAM', '哈根達斯', 'HAAGEN', '零食']],
  ['飲食', '超市', ['全聯', '家樂福', '大潤發', '美廉社', '好市多', 'COSTCO', '超市', 'JASONS', '楓康', '頂好']],
  ['飲食', '飲料／咖啡', ['星巴克', 'STARBUCKS', '路易莎', 'LOUISA', 'CAMA', 'ARABICA', '咖啡', 'COFFE', '清心', '五十嵐', 'COMEBUY', '手搖', '飲料', '可不可', '大苑子', '迷客夏', '聲島', 'BEING']],
  ['飲食', '早餐／便當', ['麥味登', '早餐', '早午餐', '美而美', '便當', '豆漿', '馬可先生']],
  ['飲食', '麵食', ['八方雲集']],   // 使用者定 2026-07-19（「麵食」＝使用者自訂樹的子類；預設樹無此子類時降為不分子類）
  ['飲食', '餐廳', ['餐廳', '餐飲', '石二鍋', '鼎泰豐', '麥當勞', '肯德基', '摩斯', '漢堡', '火鍋', '燒肉', '燒臘', '食堂', '小吃', '拉圖爾', '12MINI', 'LADY M', 'LADY-M', '秘食', '墨爾', '炸牛', '爭鮮', '壽司', '涮涮', '鬍鬚張', '無老鍋', '精釀', '三顧茅廬', '冰室', '御園坊', '茗香園', '滷味', '牛肉麵', '拉麵', '涮乃葉']],
  ['飲食', '超市', ['統一超商', '7-ELEVEN', '全家', '萊爾富', 'OK超商', '超商']],   // 超商暫歸超市桶
  ['飲食', '外送', ['FOODPANDA', 'FP-', 'UBER EATS', 'UBEREATS', '優食', 'FP＊', 'ODDLE']],   // 保底：認不出店家的外送仍歸飲食
  // 居住
  ['居住', '', ['地價稅', '房屋稅']],   // 房產稅（地價稅/房屋稅）歸居住（使用者定；居住無稅務子類，故不分子類）
  ['居住', '房貸', ['房貸']],
  ['居住', '房租', ['房租']],
  ['居住', '管理費', ['管理費', '社區管理']],
  ['居住', '網路費', ['中華電信', '台灣大哥大', '遠傳', '亞太電信', '台灣之星', '網路費', '光世代', 'HINET']],
  ['居住', '水費', ['自來水', '水費']],
  ['居住', '電費', ['台灣電力', '台電', '電費']],
  ['居住', '瓦斯費', ['瓦斯', '欣欣天然氣', '大台北瓦斯']],
  ['居住', '家具', ['IKEA', '宜家', '家具', '詩肯']],
  ['居住', '居家用品', ['特力屋', 'HOLA', '生活工場', '無印', 'MUJI', '宜得利', 'NITORI']],
  ['居住', '修繕／裝潢', ['修繕', '裝潢', '水電行', '五金']],
  // 生活
  ['生活', '日用品', ['屈臣氏', '康是美', '寶雅', '小北百貨', '日用', '美妝', '藥妝']],
  ['生活', '3C產品', ['3C', 'APPLE', '蘋果電腦', 'ICLOUD', 'STUDIO A', '德誼', '燦坤', '全國電子']],
  ['生活', '個人用品', ['OWNDAYS', '眼鏡', '寶島眼鏡', '小林眼鏡', '鐘錶']],
  ['生活', '衣服', ['UNIQLO', 'ZARA', 'H&M', 'NET', '服飾', 'GU', 'LATIV', 'GLOBAL MALL']],
  ['生活', '鞋子', ['ABC-MART', 'NIKE', 'ADIDAS', '球鞋']],
  ['生活', '清潔用品', ['清潔', '洗衣']],
  ['生活', '所得稅', ['所得稅', '綜所稅']],
  ['生活', '行政規費', ['規費', '監理', '戶政', '地政', '區公所']],   // 地價稅/房屋稅已移到居住（見上）
  ['生活', '日用品', ['MOMO', 'PCHOME', '蝦皮', 'SHOPEE', 'COUPANG', '酷澎', 'momo購物', 'AMAZON', 'AMZN']],
  // 保險
  ['保險', '壽險', ['人壽', '壽險', '友邦']],
  ['保險', '其他個人保險', ['保險', '產險']],
  // 養育
  ['養育', '補習／才藝', ['補習', '安親', '才藝', '美語', '音樂教室', '畫室', '佳音', '何嘉仁', '學美語']],
  ['養育', '孩子學費', ['幼兒園', '幼稚園', '托嬰', '學費']],
  ['養育', '親子活動', ['卡哇依', '親子', '遊戲愛樂園', 'KIDS', '兒童樂園', '碰碰船', '碰碰車']],
  // 社交
  ['社交', '捐款', ['捐款', '基金會', '紅十字', '世界展望', '慈濟']],
  ['社交', '禮物', ['LINE禮物', 'LINE GIFT', '禮物卡', '禮券']],
  ['社交', '社交活動', ['TIMELEFT']],
  // ATT4FUN（信義商場，使用者定 2026-07-27）：歸「娛樂/百貨」——放場所保底層之前（名字認得出就給明確子類；
  // 子分類「百貨」需存在於使用者的分類樹，沒有時 conform 降為「娛樂/不分子類」）。
  ['娛樂', '百貨', ['ATT4FUN']],
  // ---- 場所保底層（使用者定 2026-07-19：「具體店家 > 場所」）----
  // 百貨/OUTLET 這類關鍵字說的是「在哪裡」不是「買什麼」：認得出店家（八方雲集林口三井店＝麵店）
  // 就讓上面的店家規則先接走；只有認不出是百貨裡哪家店時，才落到這層歸「娛樂百貨」。
  // 排表尾正是實作方式——先中先贏，場所永遠最後才輪到。（順帶救活：小北百貨 以前被「百貨」搶走，
  // 生活/日用品 的專屬關鍵字形同虛設；石二鍋林口三井店 也曾被判娛樂。）
  ['娛樂', '興趣用品', ['誠品', '奧特萊斯', 'OUTLET', '三井', '遠東百貨', '遠百', 'SOGO', '新光三越', '百貨']]
];

// 回傳 [分類, 子類]。未命中→其他/未分類（DEFAULT_EXPENSE，讓使用者一眼看出待手動確認）。
/** @param {string} desc @returns {[string, string]} */
export function categorize(desc) {
  const raw = String(desc || '');
  const d = raw.toUpperCase();
  for (const [cat, sub, keys] of CATEGORY_RULES) {
    if (keys.some(k => d.includes(k.toUpperCase()))) return [cat, sub];
  }
  // 優步（Uber）保底：與顯示標記（deliveryTagOf）同一判準，兩邊口徑必須一致（Codex#1）——
  // 前面規則沒接走＝不是車隊（車隊/TAXI/計程車 已在交通規則裡），所以「優步-<認不出的店家>」＝外送，
  // 顯示會標（UE）、分類就該是飲食/外送；只有平台名（優步福爾摩沙股份有公司，無分隔符）＝叫車。
  if (UBER_PREFIX.test(raw)) return /** @type {[string, string]} */ (['飲食', '外送']);
  if (raw.includes('優步')) return /** @type {[string, string]} */ (['交通', '計程車／Uber']);
  return /** @type {[string, string]} */ ([...DEFAULT_EXPENSE]);   // 複製一份避免外部改到共用常數
}

// 正規化消費說明：官網版 PDF 用康熙部首異體字（⼝≠口）且字間插空白，
// 郵寄版用全形英數。統一成標準字＋半形，讓兩版產生一致的說明與 stmtRef
// （否則同一筆消費跨版式上傳會被當成新的重複匯入、分類關鍵字也比對不到）。
const RADICAL_FIX = { '⺠': '民' };   // NFKC 涵蓋不到的個別部首，遇到再補
/** @param {string} s @returns {string} */
export function normalizeDesc(s) {
  return String(s || '')
    .replace(/[⺀-⿟]/g, (c) => RADICAL_FIX[c] || c)
    .normalize('NFKC')   // 康熙部首→標準字、全形英數→半形
    .replace(/\s+(?=[㐀-鿿])|(?<=[㐀-鿿])\s+/g, '')   // CJK 相鄰的空白（部首拆字造成）
    .replace(/\s+/g, ' ').trim();
}

// 店名清理（僅顯示用）：讓帳單店名好讀。**只影響顯示**（匯入後的 note、預覽的顯示）；
// 分類與去重（stmtRef）仍用原始 desc，不受影響。盡力而為：台新 PDF/XLSX 常把店名截斷，救不回被截字。
// 先比對「已知品牌標準名」（不管周邊雜訊直接顯示標準名），沒中再走一般清理規則。
/** 每條＝[標準店名, 命中樣式]。 @type {[string, RegExp][]} */
const STORE_CANON = [
  // eTag 停車不在此表：場站名在冒號後（eTag停車3087-H8:救國團林口運動中心），由 cleanStore 開頭的專屬規則
  // 轉成「eTag 停車（場站名）」（使用者定 2026-07-18）——早退表做不到「保留尾段當分店」。
  ['foodpanda', /^foodpanda[-\s]/i],       // foodpanda-EC → foodpanda（FP-<店名> 不在此、會保留店名）
  // 使用者定 2026-07-27（更新 2026-07-18 的「全部＝林口文三門市」舊裁決）：顯示只到品牌「路易莎咖啡」，不帶門市
  ['路易莎咖啡', /LOUISA\s*COFFE|路易莎咖啡/i],
  ['麥當勞', /麥當勞|MCDONALD/i],           // 使用者定 2026-07-18：台灣麥當勞MOP-056 → 麥當勞
  ['六松今苑壽喜燒', /紅陽科技六本/],        // 使用者定 2026-07-18：紅陽科技＝金流商，實際店家是這家
  // 以下皆使用者定 2026-07-18（銀行截斷或英文原名，統一成看得懂的標準名）
  ['肯德基', /肯德基|KFC/i],                // 肯德基KFC炸雞漢（截斷）
  ['星巴克', /STARBUCKS|星巴克/i],          // STARBUCKS／星巴克MITSUI門市
  ['DECATHLON', /DECATHLON|迪卡儂/i],       // DECATHLON TAIWATaichu／DECATHLON TAA0145 Taichu（截斷）
  // 只認「醫院本體」的寫法——之前 /林口長庚/ 太寬，把「林口長庚泊車區」（停車）和
  // 「錢都日式涮涮鍋(林口長庚店)」（分店名帶林口長庚的火鍋店）都吞成醫院（體檢 D2 抓到，2026-07-19）
  ['林口長庚醫院', /長庚醫療|林口長庚紀念醫/],
  ['兒童新樂園', /卡哇依/],                  // 卡哇依＝兒童新樂園的攤商，記成樂園本身
  // Apple 全家族（使用者定 2026-07-27：「所有含 Apple 或蘋果電腦，鑰匙皆為 Apple」）——iTunes 變體要排在
  // 通用 Apple 之前（先中先贏）；實體店 Apple Xinyi 走 BRAND_CANON（顯示 Apple（信義）、鑰匙 stripBranch 後同為 Apple）。
  ['Apple（iTunes）', /APPLE\.COM\/?BILL.*ITUNES/i],   // APPLE.COM/BILLA2119 ITUNES → Apple（iTunes）
  ['Apple', /APPLE\.COM|蘋果電腦/i],          // APPLE.COM/BILLA2119 080009／蘋果電腦-台灣-EC → Apple
  // 使用者定 2026-07-27（放寬 2026-07-19 的「只認 *NONE」）：所有 LINEPAY* 代收一律算同一家。
  // 顯示沿用既有鑰匙寫法「LINE Pay」（舊資料已用這一把，寫成 LINEPAY 會裂成兩把）。
  // (?<![A-Za-z]) 擋 ONLINEPAY／ONLINEPAYMENT 這類真實支付品牌被誤吸（Codex r1 實測抓到）；
  // 不用 ^ 錨定＝帶收單前綴（聯信-LINEPAY*…）仍接得到（STORE_CANON 比的是剝前綴之前的原文）。
  ['LINE Pay', /(?<![A-Za-z])LINEPAY/i],
  ['OpenAI', /OPENAI|CHATGPT/i],           // AI 訂閱服務（工作）；OPENAI* 是商家名、不是金流前綴
  ['悠遊卡自動加值', /自動加值/],            // 悠遊卡自動加值-正好停… → 悠遊卡自動加值
  ['OMGYES', /OMGYES/i],
  ['馬可先生', /馬可先生/],
  ['六必居', /六必居/],
  // 詮營（停車場，使用者確認 2026-07-27）：帳單原文＝聯信-詮營股份有限公司新A0145 NEW TA——
  // 公司字尾之後那個「新」是被銀行截斷的分店開頭（新北市/新莊…），救不回也不是店家身分，
  // 留著會讓 cleanStore 產出「詮營新」。用標準名一步到位（同 六必居／OMGYES 的做法）。
  ['詮營', /詮營/],
  // 使用者定 2026-07-26：TIMELEFT SUBSCRIPTIONA0145 PARIS → TIMELEFT。**這串是海外刷卡**，
  // 結尾定位碼規則的城市白名單只認 TAIPEI/TAOYUAN/TAICHUNG/TW（見下方 cleanStore），PARIS 不在裡面
  // → 整串原封不動當成店名。這裡用標準名一步到位（同 OMGYES 的做法）；若日後海外店家變多，
  // 再評估把城市白名單放寬成「定位碼＋任意英文城市」（那是全站共用底層，要另案小心處理）。
  ['TIMELEFT', /TIMELEFT/i],
  // 使用者定 2026-07-26：XSOLLA /ROBLOXH.XSOL → ROBLOX。XSOLLA＝遊戲金流商（同「紅陽科技→六松今苑」
  // 的道理：帳單印的是收單方，真正的店家是 ROBLOX）；認 ROBLOX 而不是砍 XSOLLA 前綴，因為同一個
  // 金流商底下可能有別款遊戲，砍前綴會讓它們全部併成「XSOLLA」一家。
  ['ROBLOX', /ROBLOX/i],
  // 使用者定 2026-07-26：TapPay 的停車商戶被銀行截成「台灣國際開」→ 併回完整名（同「好麥永和豆漿→好麥永和豆漿店」）
  ['台灣國際開發', /台灣國際開發?/],
  // ---- 2026-07-27 批次（使用者提供清單＋自訂規則入內建；「一步到位」型＝顯示與鑰匙都是標準名）----
  // 自訂規則搬入（原存 settings.storeRules，使用者要求改由程式端管理；內建接手後自訂規則可在 UI 清空）：
  ['UNIQLO', /UNIQLO|優衣庫/i],
  ['WOW HOT DOG', /WOW\s*HOT/i],            // WOW HOT（截斷）→ WOW HOT DOG
  ['札伊卡印度咖哩風味餐館', /札伊卡|ZAIKA/i],   // 接手原 BRAND_CANON 的 Zaika 條目（使用者自訂顯示名勝出）
  ['%Arabica', /ARABICA/i],
  ['27號炒牛羊肉x特色炒飯', /27號炒牛羊肉/],
  ['現代汽車', /三新汽車/],                   // 三新汽車＝現代汽車經銷商（使用者定；MITSUI_RE 要「三新X奧特萊斯」不會撞）
  ['友邦人壽', /友邦人壽/],
  ['Claude', /CLAUDE|ANTHROPIC/i],
  // 新店家（使用者定 2026-07-27）：
  ['意享', /意享/],                          // eat enjoy意享A2716 TAIPEI → 意享
  ['壽司郎', /壽司郎/],                       // 台灣壽司郎股份有限公司中A0145 TAOYUA（「中」＝截斷殘）→ 壽司郎
  // momo：所有 momo 購物算同一家（原 GATEWAY_PREFIX 把 momo* 當通路前綴砍掉、露出後面店家——該條已移除）。
  // (?!\s*[a-z]) 擋「momo 後面（隔空白）接英文字母」＝MOMOPARADISE／MOMO PARADISE（壽喜燒）這類別家品牌；
  // momo*店家／momo購物網／MOMO摩天商城（後接符號或中文）都中。記錄在案的取捨：若帳單出現「MOMOSHOP」
  // 這種 momo 直連英文的購物寫法會漏接，屆時貼原文補一條即可（誤傷別家店比漏接更難察覺，先收緊）。
  ['momo', /momo(?!\s*[a-z])/i],
  ['Amazon', /AMAZON|AMZN/i],
  ['Autopass', /AUTOPASS/i],                 // 停車 app 的儲值/代收（分類關鍵字無 AUTOPASS＝不會被停車鑰匙聚合吃掉）
  ['Burger King', /BURGER\s*KI(?!T)|漢堡王/i],   // BURGER KI（KING 截斷）；(?!T) 擋 BURGER KITCHEN 型別家店（自查，與 Codex r1 兩條同型）
  ['ELEVENLABS', /ELEVEN\s*LABS/i],
  // (?!R) 擋 YOUTUBER（創作者課程／學院是真實商家；STORE_CANON 級誤吸會把它們的店名與鑰匙整個
  // 併進 YouTube——比分類誤判嚴重，Codex r1 實測抓到）。GOOGLE *YOUTUBE／YOUTUBE PREMIUM 照常中。
  ['YouTube', /YOUTUBE(?!R)/i],
  ['GRAMMARLY', /GRAMMARLY/i],
  ['HEYGEN', /HEYGEN/i],
  ['IKEA', /IKEA|宜家家居/i],
  ['Klook', /KLOOK|客路/i],
  ['LinkedIn', /LINKEDIN/i],
  ['MASTERCLASS', /MASTERCLASS/i],
  ['NIKE', /NIKE/i],
  ['Nintendo', /NINTENDO|任天堂/i],
  ['NOTION', /NOTION/i],
  ['PCHOME', /PC\s*HOME/i]
];
// 林口三井：公司登記名（三新奧特萊斯／三新二奧特萊斯）或英文品牌寫法；館別在字尾「林口I館」。
const MITSUI_RE = /三新[一二三四五六七八九十\d]?奧特萊斯|三井[Oo]utlet/;
const MITSUI_HALL = /林口\s*([IVXivx]+|[一二三四五六七八九十]+|\d+)\s*館/;

// 已知金流/通路（含 marketplace）前綴白名單——**只砍這些**，避免誤砍像 OPENAI* 這種「商家名＋*」。
// 聯信＝聯合信用卡處理中心（收單方），接分隔符「-」：聯信-台灣普客二四… 的「聯信」不是店名。
// 結尾 +＝疊幾層剔幾層：銀行有時印兩次（連加*連加*健身工廠… 的顯示名曾遺留一個「連加*」，使用者回報 2026-07-18）。
// momo 已移出（2026-07-27）：使用者定「所有含 momo＝同一家」→ STORE_CANON 先中先贏，這裡留著是永遠比不到的死碼。
const GATEWAY_PREFIX = /^(?:(?:連加|騰加數位|TAPPAY)[*＊_]\s*|(?:聯信|藍新|點點付|綠界科技)[-－*＊_]\s*)+/i;   // 綠界＝金流商（體檢 D2 抓到，2026-07-19）
// 公司字尾「截斷殘尾」（銀行欄位截字產生：…股份有／…事業股份／…有限公）——只在結尾比對，
// 完整型態（股份有限公司等）由 cleanStore 的全域規則處理；這條補截斷版，供 cleanStore 與品牌正規化共用。
// 「分公司」家族（2026-07-27 精進）：遠東百貨板橋新站**分公司**／誠品生活新店**分**（分公司截斷）——
// 這些是法人組織字眼、不是分店身分。單獨「分」用負向後行擋住真店名（十分／幾分甜／滿分）。
const COMPANY_TAIL = /(?:(?:事業)?股份(?:有限(?:公司?)?|有)?|有限公司?|分公司?|(?<![十幾滿])分)\s*$/;
/** @param {string} s @returns {string} */
function trimCompanyTail(s) { return String(s || '').replace(COMPANY_TAIL, '').trim(); }
/** @param {string} desc @returns {string} */
export function cleanStore(desc) {
  const raw = String(desc || '');
  // 保留結尾外幣註記（（USD/17.00）之類）：先摘下、清理完再接回（使用者要保留幣別）
  const fxM = raw.match(/（[A-Za-z]{3}\/[\d.,]+）\s*$/);
  const fx = fxM ? fxM[0].trim() : '';
  const body = fxM ? raw.slice(0, fxM.index) : raw;   // 用 fxM 判斷（TS 才能收斂 non-null）
  const withFx = (s) => (fx ? `${s}${fx}` : s);
  // 國外交易服務費（使用者定 2026-07-18）：把「對應的簽帳金額」帶出來 →「國外交易服務費（-金額）」，
  // 一眼看出這筆手續費是跟著哪筆消費。兩種銀行寫法：台新「國外交易服務費(簽帳16,633 )」、
  // 富邦「國外交易服務費-1288.00」；金額去小數、加千分位。純「國外交易服務費」（無金額）不變。
  const feeM = body.match(/^國外交易服務費\s*(?:[（(]\s*簽帳\s*|[-－])\s*([\d,]+(?:\.\d+)?)/);
  if (feeM) {
    const amt = Math.round(Number(feeM[1].replace(/,/g, '')));
    return withFx(`國外交易服務費（-${amt.toLocaleString('en-US')}）`);
  }
  // eTag 停車：身分鑰匙＝「eTag 停車」（品牌層，使用者定 2026-07-18——所有場站算同一家，
  // 店家檔案合併統計、排行不灌水）；場站名屬「顯示層」，由 applyDisplayLabels 從原文補在顯示名。
  if (ETAG_RE.test(body)) return withFx('eTag 停車');
  for (const [canon, re] of getUserRules().canon) if (re.test(body)) return withFx(canon);   // 使用者規則永遠最優先
  // 林口三井（使用者定 2026-07-26）：**館別留在顯示名、不進鑰匙**——一館二館是不同棟、使用者分辨得出來，
  // 但統計上是同一個地方。`林口三井（I館）` 的括號由 stripBranch 摘掉 → 鑰匙仍是「林口三井」（三層模型分工）。
  // 兩個坑：①公司登記名把館號插在**中間**（二館＝三新二奧特萊斯，使用者回報 2026-07-26 二館漏網）
  // ②館別本身在**字尾**（林口I館／林口II館），羅馬數字經 normalizeDesc 的 NFKC 會變成半形 I／II。
  // 讀不到館別（三井Outlet林口）就只回品牌名，不硬編一個館別。
  if (MITSUI_RE.test(body)) {
    const hall = body.match(MITSUI_HALL);
    return withFx(hall ? `林口三井（${hall[1]}館）` : '林口三井');
  }
  for (const [canon, re] of STORE_CANON) if (re.test(body)) return withFx(canon);
  const s = body
    .replace(DELIVERY_PREFIX_ANY, '')                                                               // 外送平台前綴只砍掉（鑰匙＝餐廳本身）；「（FP）／（UE）」標記在顯示層由 applyDisplayLabels 加
    .replace(UBER_PREFIX, '')                                                                       // 優步前綴：後面是車隊或餐廳，下面依 TAXI_FLEET 分流
    .replace(GATEWAY_PREFIX, '')                                                                    // 金流/通路前綴（白名單）
    .replace(/[?？]亭/g, '俥亭')                                                                     // 銀行缺字修補：「俥」超出 Big5，帳單印成「?亭停車」「?亭新店…」
    .replace(/門巿/g, '門市')                                                                        // 異體字統一（2026-07-27）：康是美藥妝未來門**巿**（U+5DFF）≠門市——不統一會讓同一家門市裂成兩種顯示
    .replace(/[（(].*$/, '')                                                                        // 截斷的括號分店：石二鍋(林口家樂 → 石二鍋
    .replace(/、.*$/, '')                                                                           // 21PLUS、21 → 21PLUS
    .replace(/\s*\d{3,4}-[A-Z0-9]{1,4}\s*$/, '')                                                    // 結尾設備碼：eTag自動儲值3087-H8 → eTag自動儲值
    .replace(/(股份有限公司|有限公司|股份有限|股份公司|有限合夥|分公司)/g, '')                            // 公司型態字眼（分公司＝2026-07-27：遠東百貨板橋新站分公司）
    .replace(/\s*[/／](TW|US|JP|HK|SG|GB|CN|KR)\s*$/i, '')                                         // 結尾 /TW 等國別碼
    .replace(/\s*[A-Z]\d{3,4}\s*(NEW\s*TAI?P?E?I?|New\s*Tai?p?e?i?|TAIPEI|Taipei|TAOYUAN?|Taoyuan?|TAICHUNG?|Taichung?|TW)?\s*$/i, '')   // 結尾分店定位碼(＋城市)
    .replace(/\s*(NEW\s*TAI?P?E?I?|New\s*Tai?p?e?i?|TAIPEI|Taipei|TAOYUAN?|Taoyuan?|TAICHUNG?|Taichung?)\s*$/i, '')                       // 結尾殘留城市（含桃園/台中截斷）
    .replace(/\d{8,}\s*$/, '')                                                                     // 結尾長數字(統編/序號)
    .replace(/[?？]+\s*$/, '')                                                                      // 尾端缺字符號（俥亭停車事業股份?）——剝掉才輪得到殘尾規則
    .replace(COMPANY_TAIL, '')                                                                     // 公司字尾截斷殘尾：台灣普客二四股份有 → 台灣普客二四
    .replace(/([一-鿿])[?？]?[A-Za-z][A-Za-z0-9 .&]*$/, '$1')                              // 中文店名後的殘留英文（可夾缺字符號）：達卡印度廚房?Dhaka In → 達卡印度廚房
    .replace(/[\s（(＊*－\-:：]+$/, '')                                                              // 收尾多餘標點/空白
    .trim();
  // 優步（Uber）分流（使用者定 2026-07-18）：**叫車的「店家」就是 Uber**（車隊只是派到哪台車）
  // → 「Uber（車隊名）」、鑰匙統一 Uber（所有叫車合併成一張檔案）；**外送的店家是餐廳**
  // → 落到下面的一般流程（餐廳本身），（UE）標記由 applyDisplayLabels 加。
  if (UBER_PREFIX.test(body) && TAXI_FLEET.test(s)) return withFx(`Uber（${s}）`);
  if (/^優步(?:福爾摩沙股份有公司)?$/.test(s)) return withFx('Uber');   // 只有平台名（沒帶店家）
  // 優食（Uber Eats）只有平台名、沒帶餐廳（優食台灣股份有限公司…）＝這筆的店家就是 Uber Eats 本身
  //（使用者定 2026-07-26）。判準刻意放在「清理完之後只剩平台名」：帶餐廳的（優食-好麥永和豆漿店）
  // 早在前面就被 DELIVERY_PREFIX 砍掉前綴、鑰匙留給餐廳——平台名絕不可吃掉餐廳身分，否則所有外送
  // 消費會併成同一家店（同 UBER_PREFIX 那條的理由）。
  if (/^優食(?:台灣)?$/.test(s)) return withFx('Uber Eats');
  return normalizeStoreDisplay(withFx(s || body));
}

// ---- 顯示標記（使用者定 2026-07-18）----
// 只加在「顯示名」（交易的 note），**不進 storeKey**——storeKey 是學習用的身分鑰匙，
// 混入標記會讓既有學習對不上。標記需要 cleanStore 看不到的上下文（帳單原文、分類），
// 所以由匯入/遷移端在知道上下文時呼叫 applyDisplayLabels()。兩個標記皆冪等。
// ①外送平台：帳單原文有平台前綴（DELIVERY_PREFIXES：`FP-`＝foodpanda、`優食-`＝Uber Eats；
//   要求有分隔符，免誤傷本來就叫 FPxxx 的店）→ 顯示成「主體（平台）」——**不留分店**（外送是線上點的，
//   出餐分店是雜訊；使用者定 2026-07-18：12MINI（桃園龜山復興一店）（FP）→ 12MINI（FP））。
//   尾端的分店括號會被摘掉、外幣註記保留。平台名只進顯示名，鑰匙是餐廳本身（優食-好麥永和豆漿店
//   的鑰匙＝好麥永和豆漿店，不是「優食」——否則所有 Uber Eats 消費會被當成同一家店）。
// ②停車：**子類＝停車費** → 包成「停車費（原店名）」。用分類而非店名字面，才涵蓋得到
//   「嘟嘟房」「阜爾運通」「Times Parking」這種名字沒有「停車」二字的停車場（使用者定：一律套用）。
//   例外白名單 PARK_WRAP_EXEMPT（使用者定 2026-07-18）：①「儲值/加值」不是在某停車場繳費，
//   包成「停車費（eTag自動儲值）」語意不對 → 維持原名（eTag自動儲值、悠遊卡自動加值）
//   ②名字本身已是停車語意（eTag 停車（場站））→ 再包一層是贅字。命中白名單＝不包（新的由使用者提出後加）。
// ③eTag 場站：身分鑰匙只到品牌「eTag 停車」（所有場站＝同一家，使用者定 2026-07-18），
//   場站名從帳單原文取回、補在顯示名——只裝飾「素的品牌名」，已帶場站（冪等）或使用者自訂名（不覆蓋）都跳過。
// 順序：外送先、eTag 場站次之、停車包裝最後（eTag 已被豁免、不會被包）。
export const FP_PREFIX = /^FP[\s\-*＊]+/i;
/** 外送平台前綴＝[比對樣式, 顯示標記]。新平台由使用者提出後加一條。 @type {[RegExp, string][]} */
export const DELIVERY_PREFIXES = [[FP_PREFIX, 'FP'], [/^優食[\s\-*＊]+/, 'UE']];   // UE＝Uber Eats（使用者定 2026-07-18）
// 「假自訂名」＝舊版規則把平台當成店名（優食（好麥永和豆漿店）／優食（UE））時，使用者跟著改出來的名字。
// 現行規則已能從帳單原文正確取出店家 → 整理時把這種名字當殘骸丟掉、用原文重生（使用者定 2026-07-18：
// 「優食（UE）全部改回原本的」）。判準：整個名字就是平台名，或「平台名（…）」。
const PLATFORM_WORDS = ['FP', '優食', '優步福爾摩沙股份有公司', '優步'];
/** @param {string|undefined} name @returns {boolean} */
export function isPlatformArtifactName(name) {
  const s = String(name || '').trim();
  return Boolean(s) && PLATFORM_WORDS.some(w => s === w || s.startsWith(`${w}（`));
}
// 優步（Uber）：同一個商戶名底下混著叫車與外送，帳單原文分不出來 → 用「店家是不是車隊」判
// （使用者定 2026-07-18「優步的外送也標（UE）」）。叫車的商家一律是某某車隊／Taxi，其餘視為外送。
const UBER_PREFIX = /^優步(?:福爾摩沙股份有公司)?[\s\-*＊_]+/;
const TAXI_FLEET = /車隊|TAXI|計程車/i;
/** 命中的外送平台標記（沒中回 ''）。 @param {string|undefined} desc @param {string} [name] 已清理的店名（判車隊用） @returns {string} */
const deliveryTagOf = (desc, name = '') => {
  const d = String(desc || '');
  const hit = DELIVERY_PREFIXES.find(([re]) => re.test(d));
  if (hit) return String(hit[1]);
  return (UBER_PREFIX.test(d) && !TAXI_FLEET.test(String(name || ''))) ? 'UE' : '';
};
// 由上表推導（加平台只改上表一處）：cleanStore 砍前綴用、stripDisplayLabels 拆標記用。
// 只在函式內取用（模組頂層的 const 有 TDZ，見 AGENTS.md）。
const DELIVERY_PREFIX_ANY = new RegExp(DELIVERY_PREFIXES.map(([re]) => `(?:${re.source})`).join('|'), 'i');
const DELIVERY_TAG_TAIL = new RegExp(
  `（(?:${DELIVERY_PREFIXES.map(([, t]) => t).join('|')})）(?=\\s*（[A-Za-z]{3}\\/[\\d.,]+）\\s*$|\\s*$)`);
// 只豁免「儲值/加值」——那不是在某停車場繳費，包成「停車費（eTag自動儲值）」語意不對（使用者定 2026-07-18）。
// ⚠️ eTag 停車已於 2026-07-26 移出豁免：新格式統一成「停車費（場站名）」＝地點優先，不再是特例。
const PARK_WRAP_EXEMPT = [/^eTag自動儲值$/i, /^悠遊卡自動加值$/];
/** 儲值／加值＝不併進「停車費」鑰匙、也不包停車標記（使用者定 2026-07-26）。 @param {string} name @returns {boolean} */
function isParkExempt(name) { return PARK_WRAP_EXEMPT.some((re) => re.test(String(name || '').trim())); }
// eTag 停車的原文樣式：eTag停車<設備碼>:<場站名>。cleanStore 用它認身分（回品牌名）、
// applyDisplayLabels 用它取場站名補到顯示名（③）。
const ETAG_RE = /^(?:eTag|ETAG)\s*停車\s*(?:\d{3,4}-[A-Z0-9]{1,4})?\s*[:：]?\s*(.*)$/i;
// 停車顯示名（使用者定 2026-07-26）：一律「停車費（XXX）」，XXX **地點／路名優先、其次品牌**——
// 「嘟嘟房（台北101）」取台北101、「台灣普客二四（林口文化二路）」取林口文化二路（銀行有寫分店就是地點）；
// 沒有分店就用整個名字（台灣國際開發／俥亭停車／林口四維路第2 本身就是品牌或路名）；都沒有＝光桿「停車費」。
// **退費另一種前綴**（使用者定 2026-07-26）：「新北市停車費退費C-30***H8 -40011」→「停車費退費（新北市）」
// ——退費的地點寫在「停車費退費」之前，後面是設備碼與金額雜訊，整串當店名會每一筆都變成不同店。
// 純編號的分店（（2））不當地點，退回品牌名（同加油站的判準：認不出就用上一層）。
// **繳費說明句同型**（使用者定 2026-07-27）：「繳交新北市停車費C-30***H8 -10142」→「停車費（新北市）」
// ——與退費同一種寫法（地點在「停車費」之前、後面是設備碼與金額雜訊），差別只在少了「退費」二字、
// 前面多一個動詞（繳交／繳納／支付）。整串當店名會因為設備碼與金額每筆不同而裂成無數家店。
// 只在**沒有分店括號**時走這條（有括號＝正常店名，維持地點優先的既有判準）。
const PARK_WRAPPED = /^停車費(?:退費)?（/;   // 已包過＝冪等，不再包第二層
const PARK_REFUND = /^(.*?)停車(?:費)?退費/;
const PARK_PAY = /^(.*?)停車費(?![（(])/;                        // 「停車費」後面不是括號＝說明句，不是已包好的顯示名
const PARK_PAY_VERB = /^(?:線上|網路|自動)?(?:繳交|繳納|繳費|繳付|代繳|繳)/;   // 動詞不是地點
const PARK_NUM_ONLY = /^第?[0-9０-９一二三四五六七八九十百]+$/;
// 付款方式／方案名不是地點（Codex 複審 2026-07-26 抓到：嘟嘟房-線上支付 → 停車費（線上支付））：
// 判不出地點就退回品牌，同加油站那邊「認不出分店就用品牌」的規矩。
const PARK_NOT_PLACE = /線上支付|行動支付|信用卡|繳費|付款|月租|儲值|加值|自動|扣款|悠遊|一卡通|會員|優惠|折扣/;
/** @param {string} name 已清理的店名 @param {string|undefined} desc 帳單原文（退費的地點只在原文裡） @returns {string} */
function parkingLabel(name, desc) {
  const s = String(name || '').trim();
  const refund = String(desc || s).match(PARK_REFUND);
  if (refund) {
    const place = refund[1].replace(/[\s\-－＊*]+$/, '').trim();
    return place ? `停車費退費（${place}）` : '停車費退費';
  }
  const m = s.match(/^([^（）]+)（([^（）]+)）$/);
  if (!m) {   // 沒有分店括號才可能是說明句；有括號＝正常店名，走下面地點優先的既有路
    const pay = s.match(PARK_PAY);
    if (pay) {
      const place = pay[1].replace(PARK_PAY_VERB, '').replace(/[\s\-－＊*]+$/, '').trim();
      return place ? `停車費（${place}）` : '停車費';
    }
  }
  const branch = m ? m[2].trim() : '';
  // ⚠️ 外送標記（FP）／（UE）不是地點（既有考題抓到：停車費（某場（FP））曾被我做成「停車費（FP）」）：
  // 這種括號是**顯示標記**，整包留著才看得懂是「在某場、用外送平台付的」。純編號同理不當地點。
  const isTag = branch && DELIVERY_PREFIXES.some(([, tag]) => branch === tag);
  const isPlace = branch && !isTag && !PARK_NUM_ONLY.test(branch) && !PARK_NOT_PLACE.test(branch);
  // 三條路：是地點→用地點；是**顯示標記**（FP／UE）→整包留著（那是「用外送平台付的」資訊，不是地點）；
  // 是付款方式／純編號→丟掉括號、退回品牌（Codex 複審 2026-07-26）。
  const label = isPlace ? branch : (isTag || !m ? s : m[1].trim());
  return label ? `停車費（${label}）` : '停車費';
}

/**
 * 依上下文替顯示名加標記。 @param {string} name 已清理的店名
 * @param {{desc?: string, subcategory?: string, parkSub?: string|null}} [ctx] desc＝帳單原文（判 FP）、
 *   subcategory＝本筆子類、parkSub＝**「停車費」子類的現名身分**（護欄 G4）：有 db 的呼叫端用
 *   `parkingSubName(db)` 傳入——改名後仍認得停車、刪除傳 null＝不包；**未傳＝相容舊行為用字面「停車費」**
 *   （純函式測試/無 db 情境）。顯示文字固定用「停車費（」（＝presentation label，與 stripDisplayLabels 反向對稱、冪等）。
 * @returns {string}
 */
export function applyDisplayLabels(name, ctx = {}) {
  let s = String(name || '');
  if (!s) return s;
  const tag = deliveryTagOf(ctx.desc, s);
  if (tag) {
    const fxM = s.match(/（[A-Za-z]{3}\/[\d.,]+）\s*$/);   // 外幣註記先摘、最後接回
    const fx = fxM ? fxM[0].trim() : '';
    let base = (fxM ? s.slice(0, fxM.index) : s).trim();
    if (base !== tag && !base.endsWith(`（${tag}）`)) {     // base===tag＝店名救不回（只剩平台名），不加贅括號
      base = base.replace(new RegExp(`(（(?!${tag}）)[^（）]*）\\s*)+$`), '').trim() || base;   // 摘掉尾端分店括號（外送不留分店）
      base = `${base}（${tag}）`;
    }
    s = fx ? `${base}${fx}` : base;
  }
  if (/^eTag ?停車$/i.test(s)) {   // ③場站名從原文補回顯示名（僅素品牌名；已帶場站或自訂名不動）
    const em = String(ctx.desc || '').match(ETAG_RE);
    const venue = em ? em[1].replace(/[?？]亭/g, '俥亭').trim() : '';
    if (venue) s = `eTag 停車（${venue}）`;
  }
  // 護欄 G4：觸發條件認「停車費」子類的**身分**（現名），不字面比對舊名——改名後仍包、刪除（parkSub=null）不包。
  // 未傳 parkSub＝相容舊行為（純函式測試）用字面「停車費」。顯示文字固定「停車費（」，與 stripDisplayLabels 對稱、冪等。
  const parkSub = Object.hasOwn(ctx, 'parkSub') ? ctx.parkSub : '停車費';
  if (parkSub && String(ctx.subcategory || '') === String(parkSub) && !PARK_WRAPPED.test(s)
    && ![...getUserRules().parkExempt, ...PARK_WRAP_EXEMPT].some((re) => re.test(s))) s = parkingLabel(s, ctx.desc);
  return s;
}

// 品牌顯示名改寫（使用者偏好的簡稱；保留分店與其餘部分）。用簡單字串取代，維持在「顯示層」——
// 分類與 stmtRef（去重）仍用原始 desc，不受影響。新的改寫由使用者提出後加一條。
// ⚠️ 同步點（AGENTS.md）：cleanStore 收尾與「店名整理」遷移（statement-import.js）共用 normalizeStoreDisplay。
/** 每條＝[比對樣式, 取代成]。 @type {[RegExp, string][]} */
const BRAND_RENAME = [
  [/全家便利商店/g, '全家商店'],       // 使用者定 2026-07：全家便利商店（XXX）→ 全家商店（XXX）
  [/麥味登早午餐/g, '麥味登'],         // 使用者定 2026-07-18：品牌簡稱（銀行有「麥味登」「麥味登早午餐」兩種寫法，統一短的）
  // 台灣普客二四：2026-07-18 使用者定改回中文名（反轉先前的 → Times Parking），改由 BRAND_CANON 統一成「台灣普客二四」
  [/SD髮藝造型（盈篆）/g, 'SD髮藝造型（盈篆店）'],   // 使用者定 2026-07-26：分店本名是「盈篆店」，銀行把「店」截掉了（只補這一家分店，其他分店照原樣）
];
/** @param {string} s @returns {string} */
function applyBrandRename(s) {
  let out = String(s || '');
  for (const [re, to] of [...getUserRules().rename, ...BRAND_RENAME]) out = out.replace(re, to);   // 使用者規則優先
  return out;
}

// 雜訊主體拆殼：收單方（聯信）或類別詞（停車場）被舊規則誤當主體、真店名被關進括號——
// 「聯信（Times Parking股份有）」「停車場（俥亭停車）」。拆出括號內容當店名，再過一次品牌正規化。
// 只認白名單主體（絕不會是真店名的詞），拆完修公司殘尾；「Times」單獨出現＝普客二四的舊縮寫。
const GENERIC_BODY = /^(?:聯信|停車場)（([^（）]+)）$/;
/** @param {string} s @returns {string} */
function promoteGenericBody(s) {
  const str = String(s || '');
  const m = str.match(GENERIC_BODY);
  if (!m) return str;
  let inner = trimCompanyTail(m[1]);
  if (/^Times$/i.test(inner)) inner = '台灣普客二四';
  return inner ? applyBrandCanon(inner) : str;
}

/**
 * 店名顯示層整理（cleanStore 收尾＋一次性遷移共用）：品牌正規化（applyBrandCanon）→ 統一分店格式
 * （branchNormalize）→ 雜訊主體拆殼（promoteGenericBody）→ 加油站顯示名（gasStationDisplay）→
 * 品牌簡稱（applyBrandRename；使用者的 rename 規則在最後＝對加油站顯示名也蓋得過內建）。冪等。
 * ⚠️ 新格式定點短路（自審B#1/#2/#4）：「…加油站」（無括號）＝gasStationDisplay 的產物形，讓它再進
 * canon／分店切分會被重包再坍縮（好市多加油站 → 好市多（加油站）→「加油站」＝毀名＋每輪整理都在變）
 * ——這一形直接只跑 rename（使用者仍蓋得過內建）。
 * @param {string} name
 * @param {{customName?: boolean}} [opts] customName＝自訂名路徑（2026-07-20 逐字鐵則）：不套
 *   gasStationDisplay——使用者取的「中油（家附近）」不可被重構成「家附近加油站」（自審A#2/B#5）；
 *   品牌改寫、殘骸治療照舊。 @returns {string}
 */
export function normalizeStoreDisplay(name, opts = {}) {
  const s = String(name || '');
  const [b0] = detachTailNotes(s);
  if (/^加油站(?:（[^（）]+）)?$/.test(b0) && categorize(b0)[1] === '油錢') return applyBrandRename(s);
  const base = promoteGenericBody(branchNormalize(applyBrandCanon(s)));
  return applyBrandRename(opts.customName ? base : gasStationDisplay(base));
}

// 加油站顯示名（使用者定 2026-07-25，全品牌統一；取代 2026-07「台亞加油站（分店）」格式）：
// 油錢類的顯示名以「分店」當主體 →「XX加油站」——中油（泰山站）→ 泰山加油站、統一精工（新店站）→
// 新店加油站、台亞加油站（林口中山站）→ 林口中山加油站、黏寫未拆的 柑園加油站林口二站 → 林口二加油站。
// 品牌不進顯示名：在使用者眼中加油站不分品牌（與 storeKeyOf 聚合同一個理由）；身分鑰匙不經過本函式，
// 照舊一律「加油站」。判準＝內建 categorize（與鑰匙同基準，使用者規則動不到）。
// 一條總原則（使用者定 2026-07-26）：**認得出分店就用分店，認不出就用品牌**——「自助洗車」不是分店名，
// 所以 中油自助洗車站 → 中油加油站（不是「自助洗車加油站」）。三條路（括號／黏寫／品牌前綴）同一判準。
// 不硬造的界線（自審B#1/#2/#8＋Codex 複審 2026-07-26）：①已是「…加油站」＝定點不動（世新加油站）
// ②分店＝isGasBranch：中文或數字 ≤10 字（`2號`這種數字起頭的站號要留住，否則兩個站併成同一個顯示名）
// 且不是設施／服務詞（NOT_BRANCH：洗車、保養、大樓…）——英文雜訊尾（TAIPEI）自然出局
// ③認不出分店時退回「品牌加油站」而**不是原樣**：留原樣會讓畫面同時存在「泰山加油站」與「中油」兩種
// 格式（Codex 複審）；品牌從哪來＝括號路取括號前的主體、黏寫路取「…加油站」為止、前綴路取 GAS_BRANDS。
// 外幣／分期註記先摘再接回（單筆註記鐵則，見 detachTailNotes）。
// GAS_BRANDS 只在本函式用（＝已經過 categorize 油錢閘門），刻意不放進 BRAND_CANON：那張表對所有店家
// 生效，「台塑」前綴會把台塑生醫（日用品）切成「台塑加油站（生醫）」——分類閘門正是唯一擋得住的地方。
// 寬關鍵字（加油／福記）誤判的店不列品牌＝不會被切，維持原名（誤判的顯示放大已是記錄在案的取捨）。
/** 加油站品牌前綴＝{prefix: 各種寫法, brand: 標準品牌名}（無分店時顯示「品牌加油站」）。 @type {{prefix: RegExp, brand: string}[]} */
const GAS_BRANDS = [
  { prefix: /^中油(加油站)?/, brand: '中油' },
  { prefix: /^台塑(石油|加油站)?/, brand: '台塑' },     // 台塑石油＝公司名，站體招牌＝台塑加油站
  { prefix: /^統一精工(加油站)?/, brand: '統一精工' },
  { prefix: /^速邁樂(加油站)?/, brand: '速邁樂' },
];
const GAS_BRANCH = /^[一-鿿0-9]{1,10}$/;                        // 分店名：中文（可夾數字，如 林口二）
const NOT_BRANCH = /洗車|保養|維修|輪胎|加水|打氣|超商|便利|餐廳|大樓|總部|公司|停車/;   // 設施／服務詞＝不是分店名
// 純編號（2號／3／第二／二號）＝**使用者認不出是哪一家**（使用者定 2026-07-26：「我分不出 2 號 3 號的
// 差別，不像新店站、林口站我分辨得出」）→ 一律退回品牌。顯示名的用途是**看帳單時回想得起來**，
// 回想不起來的編號留著沒有價值；兩個編號站併成同一個顯示名是刻意接受的取捨（鑰匙與金額不受影響）。
// 地名夾數字（林口二、文二）不算純編號，照樣當分店。
const NUM_ONLY = /^第?[0-9０-９一二三四五六七八九十百]+號?$/;
/** 這段剩餘字是不是「分店名」（使用者定 2026-07-26：不是分店名就用品牌）。 @param {string} s @returns {boolean} */
const isGasBranch = (s) => Boolean(s) && GAS_BRANCH.test(s) && !NOT_BRANCH.test(s) && !NUM_ONLY.test(s);
/** @param {string} name @returns {string} */
function gasStationDisplay(name) {
  const raw = String(name || '');
  if (categorize(raw)[1] !== '油錢') return raw;
  const [base, tail] = detachTailNotes(raw);
  if (/^加油站(?:（[^（）]+）)?$/.test(base)) return raw;                 // 定點：已是新格式，或使用者自訂的光桿「加油站」
  /** 分店字尾淨化：摘前導「加油站」（好市多（加油站中壢店））、剝尾「站／店／加油站」 @param {string} s */
  const stemOf = (s) => s.replace(/^加油站/, '').replace(/(?:加油)?[站店]$/, '').trim();
  /** 品牌標籤：把品牌名尾巴的「加油站」拿掉（好市多加油站→好市多、中油→中油） @param {string} s */
  const brandOf = (s) => String(s || '').replace(/加油站$/, '').trim();
  /** 統一成「加油站（XXX）」；認不出任何標籤＝光桿「加油站」 @param {string} label */
  const wrap = (label) => (label ? `加油站（${label}）` : '加油站');
  let out = base;
  const m = base.match(/^([^（）]+)（([^（）]+)）$/);
  if (m) {                                                              // 品牌（分店）
    const branch = stemOf(m[2]);
    out = wrap(isGasBranch(branch) ? branch : brandOf(m[1].trim()));
  } else if (base.includes('加油站')) {
    const glued = base.match(/^([^（）]*加油站)(.+)$/);                   // 黏寫未拆：柑園加油站林口二站
    if (glued) {
      const branch = stemOf(glued[2]);
      out = wrap(isGasBranch(branch) ? branch : brandOf(glued[1]));
    } else out = wrap(brandOf(base));                                   // 只有「…加油站」：世新加油站 → 加油站（世新）
  } else {
    for (const { prefix, brand } of GAS_BRANDS) {                       // 無分隔符無括號：品牌前綴切
      const hit = base.match(prefix);
      if (!hit) continue;
      const branch = stemOf(base.slice(hit[0].length).trim());
      out = wrap(isGasBranch(branch) ? branch : brand);
      break;
    }
  }
  return out + tail;
}

// 顯示標記的「反向」：把 note 拆回乾淨店名（停車費（X）→ X、去掉（FP））。
// 「店名格式整理」用：舊 note 若已包停車標記，巢狀括號會讓 normalizeStoreDisplay 的規則全部比不到，
// 必須先拆殼→整理→再由 applyDisplayLabels 重新上標記（兩者皆冪等，正確的 note 走一圈不變）。
/** @param {string} name @returns {string} */
export function stripDisplayLabels(name) {
  let s = String(name || '').trim();
  // ⚠️ 只拆「停車費（…）」，**不拆「停車費退費（…）」**（使用者定 2026-07-26 的新格式）：
  // 拆了之後只剩地點（新北市），沒有原文的路徑（手動記帳）重上標記時判不出是退費 → 會降級成
  // 「停車費（新北市）」＝把退費說成消費。整包留著、由 PARK_WRAPPED 擋住重複包裝即可（實測冪等）。
  const m = s.match(/^停車費（(.+)）$/);   // 貪婪取到最後一個「）」→ 內容可含巢狀括號
  if (m) {
    let depth = 0, ok = true;
    for (const ch of m[1]) {   // 內容括號必須自我平衡，才確定拆的是最外層包裝
      if (ch === '（') depth++;
      else if (ch === '）' && --depth < 0) { ok = false; break; }
    }
    if (ok && depth === 0) s = m[1].trim();
  }
  s = s.replace(DELIVERY_TAG_TAIL, '').trim();   // 外送標記（FP／優食）在結尾或外幣註記前
  return s;
}

// ---- 身分鑰匙（storeKey）＝品牌層（使用者定 2026-07-18：「鑰匙像餐廳的名字、不管分店」）----
// 與顯示名的分工：cleanStore＝顯示名的自動版（帶分店，「統一超商（百福）」；油錢類例外＝「分店加油站」，見 gasStationDisplay）；
// storeKeyOf＝辨識「同一家店」的鑰匙（不帶分店，「統一超商」）——店家消費檔案靠它合併統計、
// 學習表靠它記共用規則。分店資訊只活在顯示名，鑰匙不該因為換一家分店就變成另一家店。
/** 摘掉結尾一組「（分店）」；外幣註記（USD/9.99）先摘再接回、不當分店。 @param {string} name @returns {string} */
function stripBranch(name) {
  const raw = String(name || '').trim();
  const fxM = raw.match(/（[A-Za-z]{3}\/[\d.,]+）\s*$/);
  const fx = fxM ? fxM[0].trim() : '';
  const s = (fxM ? raw.slice(0, fxM.index) : raw).trim();
  const m = s.match(/^(.+?)（[^（）]+）$/);
  const base = (m && m[1].trim()) ? m[1].trim() : s;
  return fx ? `${base}${fx}` : base;
}
/**
 * 帳單原文 → 身分鑰匙。①加油站聚合（使用者定 2026-07-18「所有加油站都改成加油站」）：
 * 內建分類判為「交通/油錢」一律回「加油站」——中油/台亞/柑園/世新/車容坊在使用者眼中是同一件事
 * （加油），合併統計才看得出「這個月加油花多少」。用**內建 categorize(原文)** 而非交易上的分類，
 * 才不會因為使用者改分類就讓鑰匙漂移、學習全部對不上。②其餘＝cleanStore 摘掉分店。
 * @param {string} desc 帳單原文 @returns {string}
 */
export function storeKeyOf(desc) {
  const d = String(desc || '');
  if (categorize(d)[1] === '油錢') return '加油站';   // 用原文判（資訊最全）
  const name = cleanStore(d);
  // 停車聚合（使用者定 2026-07-26）：所有停車＝同一件事，同加油站。**儲值／加值除外**（使用者定同日）：
  // eTag自動儲值不是在某停車場繳費，鑰匙與顯示名都留自己（豁免清單＝內建 PARK_WRAP_EXEMPT）。
  // ⚠️ 只認內建豁免、不吃使用者的 parkExempt——鑰匙的判定基礎必須凍結在內建規則（改規則不可讓鑰匙漂移）。
  if (categorize(d)[1] === '停車費' && !isParkExempt(name)) return '停車費';
  return storeKeyOfName(name);
}
/**
 * 已清理的顯示名 → 身分鑰匙（同上規則）。給「拿不到帳單原文」的資料用：手動記帳、
 * 舊資料缺 stmtRef——只能從現成的名字回推品牌層。 @param {string} name @returns {string}
 */
export function storeKeyOfName(name) {
  // 外幣註記（USD/9.99）是「這一筆的金額」不是店家身分（Codex#6）：留在鑰匙裡會讓同一家店
  // 因為每次刷的金額不同而裂成好幾把鑰匙（APPLE.COM/BILL（USD/9.99）vs（USD/19.99）），
  // 學習、排行、店家檔案全部分家。顯示名照舊保留幣別（使用者定），只有鑰匙要脫掉。
  // 分期期數同理（使用者定 2026-07-19，體檢 D7）：「第N/M期」是這一期的標記不是店家身分——
  // 留著會讓一筆分期裂成 N 把鑰匙（Apple Xinyi A 實測 7 把）。顯示名保留期數（看得到繳到第幾期）。
  const s = String(name || '').replace(/（[A-Za-z]{3}\/[\d.,]+）\s*$/, '')
    .replace(/\s*第\d+\/\d+期\s*/g, ' ').trim();
  if (categorize(s)[1] === '油錢') return '加油站';
  if (categorize(s)[1] === '停車費' && !isParkExempt(s)) return '停車費';   // 停車聚合（含「停車費（台北101）」這類顯示名回推）；儲值除外
  // 字面聚合鑰匙（使用者定 2026-07-27）：所有運動中心＝同一件事（松山／林口／新店國民運動中心都是
  // 「去運動中心」），同加油站／停車費的聚合理由——但判準是**名字字面**、不是分類（運動中心的分類
  //（健康/運動課程）還涵蓋攀岩瑜珈等別家店，拿分類當判準會把它們全吸進來）。顯示名保留完整場館名。
  for (const [aggKey, re] of KEY_AGGREGATE_RULES) if (re.test(s)) return aggKey;
  return stripBranch(s);
}
/** 字面聚合鑰匙表：命中樣式 → 鑰匙一律用聚合名（顯示名不受影響）。新聚合由使用者提出後加一條。
 * ⚠️ 加一條＝同步把聚合名加進 AGGREGATE_STORE_KEYS（退款配對不可用彙總鑰匙，見下）。 @type {[string, RegExp][]} */
const KEY_AGGREGATE_RULES = [['運動中心', /運動中心/]];

// ---- 退款配對用的「細粒度商戶身分」（Codex 複審 2026-07-26 抓到的錯配）----
// 病根：加油站（2026-07-18 起）與停車費（2026-07-26 起）走**彙總鑰匙**——所有加油站／停車場共用一把。
// 退款配對（derive.js）用 [卡片, storeKey, 金額] 找「退款日之前最近的同額消費」，彙總鑰匙會讓
// **不同店家撞成同一把** → 退 6/1 嘟嘟房那筆 40 元，卻被算到 7/9 普客二四頭上（六月仍記 40、七月變 0）。
// 實測確認：同樣的錯配在加油站上**早就存在於 main**（不是停車改動造成的，是彙總鑰匙的既有代價）。
// 修法：配對不看彙總鑰匙，改用「清理後的顯示名」當身分——加油站（泰山）≠加油站（新店）、
// 嘟嘟房（台北101）≠台灣普客二四，同一站的退款仍配得起來，不同站則配不上＝列未對應（無法證明就不猜）。
// 其餘店家維持原本的品牌鑰匙（Klook 這類退款照舊配得到）。回 '' ＝證明不了、不要配。
export const AGGREGATE_STORE_KEYS = new Set(['加油站', '停車費', '運動中心']);   // 運動中心＝2026-07-27 字面聚合
/** @param {string} desc 帳單原文 @returns {string} 配對身分（'' ＝不可配對） */
export function refundPairKeyOf(desc) {
  const d = String(desc || '');
  // 通用化（2026-07-27，加入運動中心時改寫）：鑰匙落在任何彙總鑰匙（加油站／停車費／運動中心）
  // ＝改用「帶地點／分店的清理名」當細身分——彙總鑰匙會讓不同店家撞成同一把、退款配到別家頭上
  //（Codex 複審 2026-07-26 在停車費上重現過）。清理名仍是彙總名（認不出地點）＝證明不了、不配。
  // 對加油站／停車費而言與原實作等價（storeKeyOf 對它們回的正是彙總鑰匙）。
  const key = storeKeyOf(d);
  if (AGGREGATE_STORE_KEYS.has(key)) {
    const name = cleanStore(d);   // 帶地點／分店的清理名＝細身分（彙總鑰匙丟掉的正是這一層）
    return AGGREGATE_STORE_KEYS.has(name) ? '' : name;
  }
  return key;
}
/** 沒有帳單原文（手動記帳）時的退化版：彙總鑰匙一律不可配對。 @param {string} storeKey @returns {string} */
export function refundPairKeyOfStoreKey(storeKey) {
  const k = String(storeKey || '').trim();
  return AGGREGATE_STORE_KEYS.has(k) ? '' : k;
}

/** stmtRef（卡id|消費日|金額|原始說明）取回帳單原文；非帳單交易或格式不符回 ''。 @param {string|undefined} stmtRef @returns {string} */
export function origFromStmtRef(stmtRef) {
  const parts = String(stmtRef || '').split('|');
  // 同帳單重複消費的序號段 `|#N`（stmtDupFlag，自主體檢）：≥5 段且末段是 #數字＝序號，剝掉不算原文。
  // （銀行說明不含「|」，所以「≥5 段且末段 #N」幾乎只會是序號，不會誤剝真說明。）
  if (parts.length >= 5 && /^#\d+$/.test(parts[parts.length - 1])) parts.pop();
  return parts.length >= 4 ? parts.slice(3).join('|').trim() : '';   // 原文可能含「|」→ 第 3 個分隔後全取
}

// 品牌正規化（主體統一成標準名，有分店才加括號）——比 BRAND_RENAME 強：能把「主體＋分店」拆開重組。
// 例：台亞（加油站品牌）不論寫成「台亞」「台亞加油站」「台亞林口第二交流道南站」，一律 →「台亞加油站」，
//     後面有分店名才加（分店）。每條＝{ prefix: 從頭比對品牌各種寫法, brand: 標準品牌名 }。
// ⚠️ 2026-07-25 起加油站顯示名改「分店加油站」（gasStationDisplay）：台亞這條仍是「無分隔符拆分店」
//     的關鍵一步（台亞林口二站 得先拆成 台亞加油站（林口二站） 才收得成 林口二加油站），別因顯示改制而移除。
// 分店＝比對後剩餘：純中文（BRANCH_TAIL）才加括號；已是「（分店）」則保留（冪等）；雜訊則只回品牌名。
// 結尾「單筆註記」＝外幣金額／分期期數：屬於這一筆，不是店家身分的一部分。
// 任何店名變形（品牌正規化…）都要先摘下、處理完原順序接回，否則同一家店會因為註記不同而分家。
const TAIL_NOTE = /(（[A-Za-z]{3}\/[\d.,]+）|第\d+\/\d+期)\s*$/;
/** @param {string} s @returns {[string, string]} [本體, 註記（原順序）] */
function detachTailNotes(s) {
  let base = String(s || ''), tail = '';
  for (;;) {
    const m = base.match(TAIL_NOTE);
    if (!m) return [base, tail];
    tail = m[1] + tail;
    base = base.slice(0, m.index).trim();
  }
}

/** @type {{prefix: RegExp, brand: string}[]} */
const BRAND_CANON = [
  { prefix: /^台亞(加油站)?/, brand: '台亞加油站' },   // 使用者定 2026-07；有分店時再由 gasStationDisplay 收成「分店加油站」（2026-07-25）
  // 普客二四（Times 停車場）：中英寫法統一成中文名（使用者定 2026-07-18；舊資料有 Times Parking 殘留）
  { prefix: /^(?:台灣普客二四|Times[ ]?Parking)(?![A-Za-z])/i, brand: '台灣普客二四' },
  // 銀行截斷版併回完整名（使用者定 2026-07-18）：同一家店被截成兩種寫法會變成兩把鑰匙、消費統計拆開。
  // 用 BRAND_CANON 而非 STORE_CANON——截斷版補回品牌名的同時，完整版後面的分店仍保留。
  { prefix: /^好麥永和豆漿(店)?/, brand: '好麥永和豆漿店' },
  // Zaika 札伊卡改由 STORE_CANON 一步到位（2026-07-27：使用者自訂顯示名「札伊卡印度咖哩風味餐館」入內建）
  { prefix: /^潮味決(\.?湯滷專門店)?/, brand: '潮味決' },                 // 使用者定 2026-07-19：同一家
  // Apple 信義（體檢回報 2026-07-19；顯示名改制 2026-07-27）：分期那幾筆的定位碼被期數擠成單一個「A」
  //（A2716 → A），與沒分期的那筆分成兩把鑰匙。剩餘的「A」不是分店＝落到「只回品牌名」。
  // brand 直接帶「（信義）」＝鑰匙 stripBranch 後是「Apple」——與 APPLE.COM 訂閱同一把（使用者定
  // 2026-07-27「所有含 Apple 鑰匙皆為 Apple」）；分店資訊留在顯示名、分期期數由 detachTailNotes 保住。
  { prefix: /^Apple\s*Xinyi/i, brand: 'Apple（信義）' },
  { prefix: /^傳承永和豆漿(大王)?/, brand: '傳承永和豆漿大王' },
  // ---- 2026-07-27 批次（使用者提供清單；「品牌＋分店」型＝鑰匙到品牌、分店留顯示名）----
  { prefix: /^新光三越(?:百貨)?/, brand: '新光三越' },        // 新光三越百貨臺北信義A1 → 新光三越（臺北信義）（A1 館別碼由 rest 精進剝掉）
  { prefix: /^遠東百貨/, brand: '遠東百貨' },                 // 遠東百貨板橋新站分公司 → 遠東百貨（板橋新站）（分公司＝COMPANY_TAIL）
  { prefix: /^康是美(?:藥妝)?/, brand: '康是美' },            // 康是美未來門市／康是美藥妝未來門巿（異體字已統一）→ 康是美（未來門市）
  // 涮乃葉：已知樣式「涮乃葉新店小碧潭店」的「新店」是行政區前綴、不是分店名的一部分（使用者定顯示＝
  // 涮乃葉（小碧潭店））——prefix 連行政區一起吃掉只限這個已知樣式；其他分店寫法照 rest 通用判。
  { prefix: /^涮乃葉(?:新店(?=小碧潭))?/, brand: '涮乃葉' },
  { prefix: /^歐悅(?:精品汽車旅館|精品|汽車旅館|MOTEL)?/i, brand: '歐悅精品汽車旅館' },
  { prefix: /^康宜庭/, brand: '康宜庭' },
  // 誠品生活（自 BRANCH_CHAINS 移入，2026-07-27）：BRANCH_CHAINS 的 branchNormalize 沒有 detachTailNotes，
  // 「誠品生活新店分第03/03期」的期數黏在尾端會讓分店切不出來；BRAND_CANON 這條路會先摘期數、再切分店、
  // 最後接回 → 誠品生活（新店）第03/03期（「分」＝分公司截斷，由 COMPANY_TAIL 剝掉）。
  { prefix: /^誠品生活/, brand: '誠品生活' },
  { prefix: /^萊爾富(?:國際)?/, brand: '萊爾富' },            // 萊爾富國際股份有限公司XX店 → 萊爾富（XX店）
  { prefix: /^統一超商|^7-?ELEVEN/i, brand: '統一超商' },     // 7-ELEVEN 寫法併回統一超商（同一家）
  // SD髮藝造型（使用者定 2026-07-26）：品牌後直接接分店、無分隔符（連加*SD髮藝造型盈篆Taipei）
  // → 鑰匙只到品牌「SD髮藝造型」、分店進顯示名。分店「盈篆」被銀行截掉了「店」字，由 BRAND_RENAME 補回。
  { prefix: /^SD髮藝造型/, brand: 'SD髮藝造型' },
  // 佳音（停車場）＝品牌後直接接地點、無分隔符（使用者定 2026-07-27）：切出「林口文化二路」當分店，
  // 停車顯示名的「地點優先」才拿得到它 → 停車費（林口文化二路），與同路的台灣普客二四同一個寫法。
  // ⚠️ 前瞻限定這條路名＝只認這一家；沒有它，「佳音美語林口分校」會被切成 佳音（美語林口分校）。
  { prefix: /^佳音(?=林口文化二路)/, brand: '佳音' },
];
/** @param {string} s @returns {string} */
function applyBrandCanon(s) {
  const raw = String(s || '');
  // 先摘下結尾的「單筆註記」（外幣 （USD/9.99）／分期 第03/12期），最後原順序接回——
  // 品牌正規化不可把這些吃掉（幣別＝Codex#5；期數＝使用者定 2026-07-19，體檢回報 Apple Xinyi）。
  const [str, tail] = detachTailNotes(raw);
  const fx = tail;
  for (const { prefix, brand } of [...getUserRules().brand, ...BRAND_CANON]) {   // 使用者規則優先
    const m = str.match(prefix);
    if (!m) continue;
    // 剩餘去掉前導分隔符（台亞加油站-林口站 的「-」）與空白＋公司字尾殘尾（普客二四「股份有」），才判斷是不是分店（Codex#5）
    const rest = trimCompanyTail(str.slice(m[0].length).replace(/^\s*[-－﹣—–]?\s*/, ''));
    let out;
    // 單一中文字的 rest＝銀行截斷殘（台灣壽司郎…中／詮營新），不是分店名——真門市名至少兩字（2026-07-27 精進）
    if (rest.startsWith('（') && rest.endsWith('）')) out = brand + rest;   // 已格式化的分店 → 保留（冪等）
    else if (rest && rest.length >= 2 && BRANCH_TAIL.test(rest)) out = `${brand}（${rest}）`;   // 純中文分店 → 加括號
    else {
      // 「中文分店＋短英數館別碼」（2026-07-27 精進）：新光三越百貨臺北信義**A1** 的 A1 是館別碼、
      // 不是分店身分的一部分——剝掉尾端 1–3 位英數後剩純中文就當分店；全英文的 rest（Xinyi）照舊出局。
      const zh = rest.match(BRANCH_WITH_CODE_TAIL);
      out = zh ? `${brand}（${zh[1]}）` : brand;                            // 無分店或剩餘是雜訊 → 只回品牌名
    }
    return fx ? `${out}${fx}` : out;
  }
  return raw;
}

// 分店格式正規化（使用者定，2026-07）：把「主體＋分店」統一成「主體（分店）」（全形括號）。
// 兩種來源：①有分隔符（統一超商-百福）——限「中文主體＋中文分店」，避免 ABC-MART／LADY-M 這種英文品牌被誤切；
//          ②無分隔符的已知連鎖（誠品生活新店）——需白名單 BRANCH_CHAINS，因為電腦無法自行判斷主體到哪結束
//            （「誠品生活新店」也可能被誤切成「誠品生」＋「活新店」）。新連鎖由使用者從「店名格式整理」預覽發現後增補。
// 冪等：已是「…（分店）」不動；結尾外幣註記（USD/9.99）先摘再接回、不當分店。
// ⚠️ 同步點（AGENTS.md）：cleanStore 收尾會呼叫此函式；「店名格式整理」遷移（statement-import.js）也用它。
/** 無分隔符也要切分店的已知連鎖（主體名；後面接的即分店）。使用者可增補。 @type {string[]} */
// 健身工廠／八方雲集／少年家宵夜食堂／石二鍋＝使用者定 2026-07-18（健身工廠林口廠 → 健身工廠（林口廠））
// 傳承永和豆漿大王／好麥永和豆漿店改由 BRAND_CANON 處理（要同時併回銀行截斷版），不重複列在這裡
// 誠品生活改由 BRAND_CANON 處理（2026-07-27）：帶分期期數的原文（誠品生活新店分第03/03期）要先摘期數
// 才切得出分店，branchNormalize 這條路沒有 detachTailNotes、做不到。
export const BRANCH_CHAINS = ['健身工廠', '八方雲集', '少年家宵夜食堂', '石二鍋', '好市多', '威秀影城'];
const CJK = '一-鿿';
const BRANCH_TAIL = new RegExp(`^[${CJK}][${CJK}0-9]{0,9}$`);   // 分店＝中文起頭、僅中文/數字、1–10 字（擋含英文/符號的雜訊）
// 「中文分店＋短英數館別碼」（2026-07-27，applyBrandCanon 專用）：臺北信義A1 → 取「臺北信義」。
// 至少兩個中文字（單字＝截斷殘）、館別碼限 1–3 位英數（再長＝定位碼/亂碼，整段當雜訊丟）。
const BRANCH_WITH_CODE_TAIL = new RegExp(`^([${CJK}][${CJK}0-9]{1,9})\\s*[A-Za-z][A-Za-z0-9]{0,2}$`);
// 分隔符切分：主體可為任意（含英文品牌，如 IKEA-新莊、COSTCO-內湖），但分店必須「純中文起頭」——
// 這道限制讓 ABC-MART／LADY-M（分店段是英文）自然不會被切，同時涵蓋英文連鎖＋中文分店的常見樣式。
const DASH_SPLIT = new RegExp(`^(.+?)\\s*[-－﹣—–_]\\s*([${CJK}][${CJK}0-9]{0,9})$`);   // 底線＝點點付格式（水灣餐廳_碧潭店）
/** @param {string} name @returns {string} */
export function branchNormalize(name) {
  const raw = String(name || '');
  const fxM = raw.match(/（[A-Za-z]{3}\/[\d.,]+）\s*$/);   // 保留結尾外幣註記，不當分店
  const fx = fxM ? fxM[0].trim() : '';
  const s = (fxM ? raw.slice(0, fxM.index) : raw).trim();
  if (!s) return raw;
  let out = s;
  if (/^.+（[^（）]+）$/.test(s)) {                        // 已是「…（分店）」→ 不動（冪等，避免包兩層）
    out = s;
  } else {
    const dash = s.match(DASH_SPLIT);                     // ① 中文主體 - 中文分店
    if (dash) {
      out = `${dash[1].trim()}（${dash[2].trim()}）`;
    } else {                                              // ② 已知連鎖前綴 ＋ 純中文分店
      for (const chain of [...getUserRules().chains, ...BRANCH_CHAINS]) {   // 使用者規則優先
        if (s.startsWith(chain) && s.length > chain.length && BRANCH_TAIL.test(s.slice(chain.length))) {
          out = `${chain}（${s.slice(chain.length)}）`;
          break;
        }
      }
    }
  }
  return fx ? `${out}${fx}` : out;
}

// 民國日期 → 西元 ISO。支援 115/01/13（斜線，富邦/台新新版）與 1150113（7 碼，台新補印版）
/** @param {string} s @returns {string|null} */
export function rocToIso(s) {
  let str = String(s || '').trim();
  if (/^1\d{6}$/.test(str)) str = `${str.slice(0, 3)}/${str.slice(3, 5)}/${str.slice(5)}`;
  const m = str.match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const iso = `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  // 真日曆驗證（自主體檢）：115/13/45 這種假日期以前只驗長相就放行，一路流到寫入櫃檯才炸 500、
  // 一筆壞列毒死整批匯入。這裡回 null＝該列進不了交易（匯入端以 skipped 計），其餘列不受牽連。
  return isRealDate(iso) ? iso : null;
}

// PDF → 每頁文字列（依 y 分行、x 排序重建表格；cells 為該列的文字片段陣列）
/** @param {Uint8Array} data @param {string=} password @returns {Promise<string[][]>} */
/** 給行程隔離的子行程用的具名匯出（`lib/pdf-isolate-child.js`）。**不要改名**——那邊按名字 import。 */
export { extractLines as extractLinesForIsolation };

async function extractLines(data, password) {
  // pdfjs 會「detach」傳入的 ArrayBuffer（把呼叫端的 data 清空）。免選卡「試密碼」會對
  // 同一份 bytes 連續解析多次，第 2 次起就會拿到已 detach 的空 buffer→「Cannot transfer
  // object of unsupported type」，害所有需要密碼的加密帳單開不了。傳「副本」進去即可避免。
  const task = getDocument({ data: new Uint8Array(data), password, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    // ⚠️ **開檔失敗也要放掉 task**（2026-07-28，Codex 收官審查 #7）：
    //    下面那段 `try/finally { task.destroy() }` 只包住「載入成功之後」的迴圈，
    //    而畸形 PDF 正好都是在**這一步**就失敗——最容易被攻擊的那條路恰好沒被包到。
    //    （實測這個 repo 沒開 pdfjs 的 worker，物件其實會被 GC 回收、不會真的洩漏；
    //     但「防資源耗盡的程式自己不放資源」是結構問題，照樣要修。）
    await task.destroy().catch(() => {});
    // ⚠️ `status: 400`（2026-07-28 補）：這兩個都是「使用者上傳了壞檔／密碼不對」＝使用者層錯誤。
    //    以前沒帶 status，全域錯誤中介會當成 500——訊息被換成「伺服器錯誤」、log 也多一筆假警報。
    //    另外兩個抽取器（bank-statement／taishin-securities）本來就是 400，這裡是漏掉的那一個。
    if (String(e?.name).includes('Password')) {
      // code:'pdf_password'（P0.5）＝機器判準：試密碼迴圈與前端「跳密碼窗」都認這個欄位，
      // 不再只靠訊息 regex（訊息改字迴圈就失能——機械解析的欄位只放閘要的值，同型教訓在案）。
      throw Object.assign(new Error(password
        ? 'PDF 密碼錯誤（請到卡片追蹤確認「帳單 PDF 密碼」）'
        : '這份 PDF 有加密，請先到卡片追蹤設定這張卡的「帳單 PDF 密碼」', { cause: e }), { status: 400, code: 'pdf_password' });
    }
    throw Object.assign(new Error('PDF 無法開啟：' + (e.message || e), { cause: e }), { status: 400 });
  }
  const lines = [];
  // 解析器資源上限（2026-07-28）：檔案小不代表解析便宜——一份 200KB 的 PDF 可以有幾萬頁
  // 或幾十萬個文字節點，解析時把記憶體吃光。超標**明確拒絕**，不靜默截斷。
  // ⚠️ **整段包在 try/finally 裡**：上限一 throw 就會跳過 `task.destroy()`，
  //    pdfjs 的 worker 與已配置的頁面資源就留著不放——「防資源耗盡」的那條路自己在漏資源。
  try {
    assertPageLimit(doc.numPages, '信用卡帳單 PDF');
    let itemCount = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      // ⚠️ **邊收邊數**（2026-07-29）：`getTextContent()` 會把整頁材料化之後才回來，
      //    所以節點上限無論擺在哪都是「事後才數」——單頁塞爆就整個繞過（實測 138KB 打死行程）。
      //    `readPageTextCapped` 用 `streamTextContent()` 一邊收一邊數，超標當場 cancel。
      const tc = await readPageTextCapped(page, itemCount, '信用卡帳單 PDF');
      itemCount = tc.count;
      /** @type {Record<number, {x:number, s:string}[]>} */
      const rows = {};
      for (const it of tc.items) {
        if (!('str' in it) || !it.str || !it.str.trim()) continue;   // 只取有文字的 TextItem（排除 TextMarkedContent）
        const y = Math.round(it.transform[5]);
        (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str.trim() });
      }
      for (const [, cells] of Object.entries(rows).sort((a, b) => Number(b[0]) - Number(a[0]))) {
        lines.push(cells.sort((a, b) => a.x - b.x).map(c => c.s));
      }
    }
  } finally {
    await task.destroy();
  }
  return lines;
}

// 富邦帳單：明細列＝ 消費日期(民國) | 消費說明 | 入帳日期(民國) | [外幣折算日/幣別 | 外幣金額/消費地] | 台幣金額
// 兩種版式都支援：①郵寄電子帳單（說明與日期同一列）②官網「帳單明細查詢」下載版
// （交易列只有 日期|入帳日|幣別|金額，消費說明「換行」到下一列）。
/**
 * @param {string[][]} lines
 * @param {Set<number>=} used 選用出參：把**本函式實際採用的列**索引放進去（交易列＋被併走的換行說明列）。
 *   身分判準（card-identity.js）拿它排除「已經是明細的列」，這樣**商店名沒有投票權**。
 *   ⚠️ 只有真的 push 成一筆才記——「看過但放棄」的列仍是合法的機構名證據來源。
 *   不傳＝行為與過去完全相同。
 * @returns {RawTx[]}
 */
export function parseFubon(lines, used) {
  /** @type {RawTx[]} */
  const txs = [];
  const isRoc = (s) => /^\d{2,3}\/\d{2}\/\d{2}$/.test(s);
  const isAmt = (s) => /^-?(?=[\d,]*\d)[\d,]+(\.\d+)?$/.test(s);   // 至少一個數字（',,,'/'-,' 不算金額，自主體檢）
  for (let i = 0; i < lines.length; i++) {
    const rowIdx = i;   // 下面可能 i++（吃掉換行說明列），要記的是這一筆自己的列
    const cells = lines[i];
    if (cells.length < 3 || !isRoc(cells[0])) continue;
    const last = cells[cells.length - 1];
    if (!isAmt(last)) continue;
    const amount = Number(last.replace(/,/g, ''));
    // 消費說明＝消費日之後、入帳日之前的文字（normalizeDesc 統一兩版式的字元差異）
    const postIdx = cells.findIndex((c, k) => k > 0 && isRoc(c));
    let desc = normalizeDesc((postIdx > 0 ? cells.slice(1, postIdx) : cells.slice(1, cells.length - 1)).join(' '));
    // 外幣資訊（入帳日與金額之間若還有欄位，併進備註；國內交易的「TWD」欄不需備註）
    let extra = normalizeDesc(postIdx > 0 ? cells.slice(postIdx + 1, cells.length - 1).join(' ') : '');
    if (extra === 'TWD') extra = '';
    // 官網版：本列沒有說明 → 下一列「首格不是日期」就是換行的消費說明。
    // ⚠️ 不可用「末格是不是金額」排除（自主體檢）：店名結尾帶數字且被 pdfjs 拆開
    //（['全聯福利中心','1758']）時會被誤判成金額列 → desc 空 → 整筆交易無聲蒸發。
    // 真正的下一筆交易列一定以日期開頭，用這個判準就夠。
    let wrapIdx = -1;
    if (!desc) {
      const next = lines[i + 1];
      // 排除清單要涵蓋帳單頁尾/摘要列（Codex r10#7）：漏了「最低應繳金額/應繳總額/信用額度」等 →
      // 會被當成換行店名吸進 desc（如「最低應繳金額5,678」），還讓本該丟棄的空說明列變成幽靈交易。
      // 用 ^ 錨定起頭字即可涵蓋整串（最低→最低應繳金額、應繳→應繳總額、信用→信用額度）；只加已確認的摘要標籤，
      // 避免誤傷「全聯福利中心1758」這類末格帶數字的合法店名（全 不在清單）。
      if (next && next.length && !isRoc(next[0])
        && !/^(本期|上期|前期|總計|合計|小計|循環|應繳|最低|信用)/.test(String(next[0]))) {
        desc = normalizeDesc(next.join(' '));
        wrapIdx = i + 1;
        i++;   // 說明列已消耗，跳過
      }
    }
    if (!desc) continue;
    txs.push({
      date: rocToIso(cells[0]),
      postDate: postIdx > 0 ? rocToIso(cells[postIdx]) : null,
      desc: extra ? `${desc}（${extra}）` : desc,
      amount
    });
    if (used instanceof Set) { used.add(rowIdx); if (wrapIdx >= 0) used.add(wrapIdx); }
  }
  return txs;
}

// 台新帳單 PDF（郵寄電子帳單，加密）。交易列＝消費日 | 入帳起息日 | [消費明細] | 台幣金額 | [外幣折算日 消費地 幣別 外幣金額]。
// 兩種模板都支援：斜線民國(115/06/02) 與 7 碼民國(1150602，補印版)。金額＝兩個日期之後第一個純整數 cell
// （避開說明內含的地點碼與外幣金額）。說明有時不在交易列上，而是印在「上一行」（此列無說明時）——
// **只取上一行、不可連下一行也抓**（下一行是下一筆的說明，抓了會把兩筆說明黏在一起）；上一行無內容才退用下一行。
// 與同月 XLSX 交叉驗證：3 月 94/94、7 月 66/66，日期＋金額零誤差。
/**
 * @param {string[][]} lines
 * @param {Set<number>=} used 選用出參，語意同 parseFubon（交易列＋被借去當說明的相鄰列）。
 * @returns {RawTx[]}
 */
export function parseTaishinPdf(lines, used) {
  const isRoc = (s) => /^\d{2,3}\/\d{2}\/\d{2}$/.test(s) || /^1\d{6}$/.test(s);
  const isAmt = (s) => /^-?(?=[\d,]*\d)[\d,]+$/.test(s);   // 至少一個數字（自主體檢）
  /** @type {RawTx[]} */
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i];
    if (c.length < 3 || !isRoc(c[0]) || !isRoc(c[1])) continue;
    let ai = -1;
    for (let k = 2; k < c.length; k++) { if (isAmt(c[k])) { ai = k; break; } }
    if (ai < 0) continue;
    const amount = Number(c[ai].replace(/,/g, ''));
    let desc = normalizeDesc(c.slice(2, ai).join(' '));
    let descIdx = -1;
    if (!desc) {   // 說明印在相鄰非交易列：優先取「上一行」，上一行沒有才退用「下一行」（不可兩行都抓＝會黏到下一筆）
      const prev = lines[i - 1], next = lines[i + 1];
      const pa = (prev && !isRoc(prev[0])) ? normalizeDesc(prev.join(' ')) : '';
      const nb = (next && !isRoc(next[0])) ? normalizeDesc(next.join(' ')) : '';
      desc = pa || nb;
      descIdx = pa ? i - 1 : (nb ? i + 1 : -1);
    }
    if (!desc) continue;
    // 外幣：金額後若有幣別碼（USD…）＋外幣金額，接進說明（與 XLSX 一致，讓跨格式去重對得上）
    const rest = c.slice(ai + 1);
    const ci = rest.findIndex(x => /^[A-Z]{3}$/.test(x));
    if (ci >= 0 && rest[ci + 1] && /^[\d.,]+$/.test(rest[ci + 1])) desc = `${desc}（${rest[ci]}/${rest[ci + 1]}）`;
    raw.push({ date: rocToIso(c[0]), postDate: rocToIso(c[1]), desc, amount });
    if (used instanceof Set) { used.add(i); if (descIdx >= 0) used.add(descIdx); }
  }
  return raw;
}

// 「國外交易服務費」的判準（唯一真相）：finalize 的「繼承前一筆分類」與 learning 的「不學習」共用，
// 避免同一條規則寫兩處而走鐘。說明長相：國外交易服務費-2350.00（帶當筆金額）。
/** @param {string} desc @returns {boolean} */
export const isServiceFee = (desc) => /國外交易服務費/.test(String(desc || ''));

// 信用卡「真正繳款」的判準（唯一真相）：finalize 的預覽標記與 importRows 的後端閘門共用。
// 只認銀行常見的繳款字樣，不用寬泛的「繳款」兩字，避免把一般退貨／退款誤擋掉。
// E化繳費（使用者回報 2026-07-27）：富邦帳單把上月繳卡費印成「富邦E化繳費網」——落不進舊字樣、被當退款候選。
// 只在**負數列**才會查到這裡（finalize 的 t.amount < 0 閘門），正數的「用繳費網刷卡繳水電」不受影響。
/** @param {string} desc @returns {boolean} */
export const isCardPayment = (desc) => /(?:自動(?:轉帳)?扣繳|信用卡(?:自動)?(?:扣款|繳款)|信用卡款|感謝(?:您)?繳款|(?:本期)?已繳款|E化繳費|AUTOPAY|PAYMENT\s*THANK\s*YOU|THANK\s*YOU\s*PAYMENT)/i.test(String(desc || ''));

// 分類＋國外交易服務費繼承（PDF/XLSX 各家解析器的原始明細共用這道後處理）。
// raw=[{date, postDate, desc, amount}]，回傳 { bank, transactions:[{...,isPayment,isRefund,category,subcategory}] }
/** @param {RawTx[]} raw @param {string} bank @returns {{ bank: string, transactions: ParsedTx[] }} */
export function finalize(raw, bank) {
  const txs = raw.map(t => {
    const isPayment = t.amount < 0 && isCardPayment(t.desc);   // 真正繳款不匯入；其餘負數是退款候選
    const isRefund = t.amount < 0 && !isPayment;
    const [cat, sub] = isPayment ? ['繳款/退款', ''] : categorize(t.desc);
    // store＝顯示名（帶分店）、storeKey＝身分鑰匙（品牌層）——兩者分工見 storeKeyOf 檔頭
    return { ...t, isPayment, isRefund, category: cat, subcategory: sub, store: cleanStore(t.desc), storeKey: storeKeyOf(t.desc) };
  });
  // 「國外交易服務費」跟隨它所屬的那筆刷卡分類（費用緊接在該筆消費之後）
  for (let i = 1; i < txs.length; i++) {
    if (txs[i].amount > 0 && isServiceFee(txs[i].desc)) {
      const prev = txs[i - 1];
      if (prev && prev.amount > 0 && !isServiceFee(prev.desc)) {
        txs[i].category = prev.category;
        txs[i].subcategory = prev.subcategory;
      }
    }
  }
  return { bank, transactions: txs };
}

// 台新 XLSX（官網下載「信用卡明細」）：西元日期、金額獨立欄，結構乾淨。
// 交易列＝ col0 消費日期(YYYY/MM/DD) | col1 入帳日 | col2 消費明細 | col3 幣別 | col4 金額 | … col7 外幣幣別/金額
/**
 * **唯一會碰 XLSX 解析器的地方**（HOSTED 下由子行程執行——見 lib/pdf-isolate.js）。
 * 讀一次工作簿，同時給出「第一張表的原始列」與「全表文字」（卡號偵測要用）。
 * ⚠️ 這裡**只做讀取、不做業務判斷**：判斷留在 parseTaishinXlsxRows，才能在行程邊界之後才跑。
 * @param {Uint8Array} data @returns {{rows: any[][], allText: string}}
 */
export function readXlsxForIsolation(data) {
  // ⚠️ 讀不開＝**使用者層錯誤，要自己帶 status 400**（Codex #373 r1 延伸）：
  //    隔離層對「沒有 status 的例外」一律當成我們的程式問題回 500（#350 r2 的決定，不動它）。
  //    但損毀／根本不是 .xlsx 的檔案在隔離前是 400，不宣告的話會悄悄變成「伺服器壞了」——
  //    使用者被告知重試，其實重試一百次都一樣。這裡宣告，就走回原本的使用者層路徑。
  let wb;
  try { wb = XLSX.read(data, { type: 'array' }); }
  catch (e) {
    throw Object.assign(new Error('這份 Excel 檔讀不開（可能是檔案損毀，或它其實不是 .xlsx）。請重新從網銀下載。'),
      { status: 400, cause: e });
  }
  const first = wb.SheetNames[0] ? wb.Sheets[wb.SheetNames[0]] : null;
  const rows = first ? XLSX.utils.sheet_to_json(first, { header: 1, blankrows: false, defval: '' }) : [];
  /** @type {string[]} */
  const out = [];
  for (const name of wb.SheetNames) {
    for (const r of XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' })) {
      out.push(/** @type {any[]} */ (r).join(' '));
    }
  }
  return { rows: /** @type {any[][]} */ (rows), allText: out.join('\n') };
}

/** 台新 XLSX 的業務判斷（吃**已經讀好的列**，不碰解析器）。 @param {any[][]} rows @returns {RawTx[]} */
export function parseTaishinXlsxRows(rows) {
  const isDate = (s) => /^\d{4}\/\d{2}\/\d{2}$/.test(String(s || '').trim());
  const raw = [];
  for (const r of rows) {
    if (!isDate(r[0])) continue;
    const amount = Number(String(r[4]).replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount === 0) continue;
    let desc = normalizeDesc(String(r[2] || ''));
    const fx = String(r[7] || '').trim();   // 外幣幣別/金額，如 USD/9.99
    if (fx) desc = `${desc}（${fx}）`;
    if (!desc) continue;
    const isoDate = (/** @type {any} */ v) => {
      const p = String(v || '').trim().split(/[/／-]/);
      if (p.length !== 3) return '';
      const d = `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}`;
      return isRealDate(d) ? d : '';   // 假日期（2026-13-45）回空＝該列跳過，不毒整批（自主體檢）
    };
    const dISO = isoDate(r[0]);
    if (!dISO) continue;
    raw.push({ date: dISO, postDate: isoDate(r[1]) || null, desc, amount });
  }
  return raw;
}

// PDF 依「文件內容」自動辨識銀行（不看使用者選的卡片——卡片只決定記到哪＋PDF 密碼）。
//
// ⚠️ **機構名只能來自「第一筆交易列之前」的表頭列**（逐列比對、樣式錨定在列開頭；判準在 lib/card-identity.js）。
//    2026-08-27 之前這裡是**數全文出現幾次行名**，那個計數包含**消費明細裡的商店名**——
//    使用者的遠銀帳單刷了「富邦人壽」保費 ⇒ 富邦命中 4 次、台新 1 次 ⇒ 判成富邦。
//    更嚴重的是無條件「挑筆數多的那家」：兩支解析器的列判準都寬（富邦＝首格民國日期＋末格金額、
//    台新＝前兩格都是民國日期），台灣帳單普遍長這樣，於是**別家帳單會被讀出看起來很正常的假資料**
//    並貼上自家標籤（實測：遠東 → 台新＋1 筆；國泰四欄 → 富邦＋2 筆），一路進歸卡比對與預覽標題。
//
// 四個分支（`own`＝證據命中的自家、`other`＝命中的別家）：
//   ① 兩支都 0 列                    → noRows      → 上層丟 card_unrecognized
//   ② own=0 且 other>0（證據只指向別家）→ otherIssuer → 上層丟 card_unrecognized（**列整批丟棄**）
//   ③ own=1 且 other=0               → 掛機構名（bankEvidence:'header' ⇒ 不印警語）、可自動歸卡，
//                                      並由下面的 byIdentity 決定採用哪一支解析器；那一支 0 列 → identityNoRows
//      ⚠️ 判錯機構名會流到哪些地方（**例如**列／卡／畫面／警語，**非窮舉**）＝說明在 lib/card-identity.js 的 OWN_ISSUERS 檔頭，這裡不重抄。
//   ④ 其餘（誰都沒中／自家別家都中／兩家自家都中）→ 列照給，但 bank:''、**禁止自動歸卡**、畫面警語
//
// ⚠️ 「挑筆數多者」**只在認不出機構時才用**（2026-08-27 r1#3 修正）：本節原本寫「tie-break 刻意不動」，
//    那個判斷被 Codex 的實測推翻——兩支解析器都抓到列時，標籤會來自身分、資料卻來自另一支，
//    使用者看不出解析器錯配。現在認出身分就用那一家；那一家 0 列就是認不得（r2#3）。
/** @param {string[][]} lines @returns {{ bank: string, bankEvidence: 'header'|'none', raw: RawTx[], noRows?: boolean, otherIssuer?: string[], identityNoRows?: boolean }} */
export function parsePdfAuto(lines) {
  const usedF = new Set(), usedT = new Set();
  const fubon = { bank: '富邦', raw: parseFubon(lines, usedF) };
  const taishin = { bank: '台新', raw: parseTaishinPdf(lines, usedT) };
  // 取**兩支的聯集**當排除集：與「最後採用哪一支」無關 ⇒ 身分判定不會反過來依賴解析結果（不循環）。
  const used = new Set([...usedF, ...usedT]);
  const id = identifyIssuer(lines, used);
  if (!taishin.raw.length && !fubon.raw.length) return { bank: '', bankEvidence: 'none', raw: [], noRows: true };
  if (id.own.length === 0 && id.other.length > 0) return { bank: '', bankEvidence: 'none', raw: [], otherIssuer: id.other };
  // ⚠️ **認出是哪一家，就用那一家的解析器**（Codex #518 r1#3 抓到的回歸）：原本只比筆數、平手取富邦，
  //    完全不看身分。實測台新版面 `[['台新銀行'],['115/06/02','115/06/05','星巴克','150'],['謹慎理財信用至上']]`
  //    兩支各抓一筆 ⇒ 平手 ⇒ 採富邦的結果，說明變成「謹慎理財信用至上（星巴克）」，
  //    標籤卻仍是台新——**畫面說台新、資料是富邦解析器讀的**，使用者看不出解析器錯配。
  //    舊版靠「行名挑方向」的早退擋住這件事，那兩行被本支刪掉，所以要在這裡補回等價保證。
  const byIdentity = id.bank === '台新' ? taishin : id.bank === '富邦' ? fubon : null;
  // ⚠️ **認出身分、但那一家的解析器 0 列 ⇒ 認不得，不可以改用另一家的結果**（Codex #518 r2#3 實測）：
  //    `[['台新銀行信用卡帳單'],['115/07/03','星巴克','150','回饋點數','3']]` 台新解析器 0 列、
  //    富邦解析器把末格的**回饋點數 3** 當金額 ⇒ 回「台新、金額 3」，而真實消費是 150。**錢直接記錯。**
  //    「我知道這是誰印的、但我讀不動它的版面」就是 card_unrecognized 的定義，不是換一把尺再試一次。
  if (byIdentity && !byIdentity.raw.length) return { bank: '', bankEvidence: 'none', raw: [], identityNoRows: true };
  // ⚠️ **認不出身分時就回到「筆數多者」（＝ base 既有行為），不再猜哪一支比較對。**
  //
  //    我曾經在這裡加一層猜測：Grok 指出富邦官網下載版（日期｜入帳日｜TWD｜金額，說明換行）
  //    兩支解析器都會抓到列，`parseTaishinPdf` 會把第三格的 `TWD` 當說明；筆數一翻面就會交出
  //    一整批 `desc:'TWD'`。我先後試了三個版本，**每一版都被打出真實漏帳**：
  //      ① `/^[A-Z]{3}$/`＝任何三碼大寫 ⇒ 合法店名 **`KFC`** 被當幣別（r5#1）
  //      ② 換成封閉幣別集 ⇒ **`HUF`** 同時是匈牙利幣別碼與真品牌（台北有門市）（r6#1）
  //      ③ 改成「出現最多次的說明是幣別碼且覆蓋一半以上」⇒ `HUF／星巴克／HUF` 三筆就跨過門檻（r7#1）
  //    每一次的代價都是**選錯解析器、漏記一筆**——而 base 在同樣的樣本上是對的。
  //
  //    ⇒ **關門，不再調門檻**：幣別碼與店名的集合本來就相交，任何「看說明內容猜哪一支對」的判準
  //      都會踩到真店名。這條路要真的解，需要的是**版面錨點**（知道這是哪一家、它的欄位怎麼排），
  //      不是在兩份都可能錯的解析結果之間猜。
  //
  //    ⚠️ **誠實劃界（已知缺口、不是已修好）**：認不出機構、而且兩支解析器都抓到列時，
  //      交出來的可能是錯的那一支（例如整批 `TWD` 當店名）。這是 **base 既有行為、本支沒有改善也沒有惡化**；
  //      使用者看得到分支④的警語（「用內建版面盡力讀出來的，請核對再匯入」）。真正的解＝後續批次的版面錨點。
  const best = byIdentity || (taishin.raw.length > fubon.raw.length ? taishin : fubon);
  return { bank: id.bank, bankEvidence: id.bankEvidence, raw: best.raw };
}

// 從帳單內容抓「卡號末四碼」（盡力而為；抓不到回 null，上層退回請使用者選卡）。
// 帳單卡號多為遮罩顯示，樣式各家不同，先支援常見幾種；真實帳單校準後再補。
/** @param {string} text @returns {string|null} */
export function extractLastFour(text) {
  const t = String(text || '');
  // ⚠️ 第一條結尾的 `(?!\d)` 是承重的（2026-08-05 Codex r1 抓到、實測後修）：沒有它的話
  //    「末四碼 **** 12345」會回 `1234`＝遮罩後的**前**四碼，一個猜出來的假末碼；
  //    而這條規則**比第二條（遮罩樣式，結尾有 \b）先執行**，所以第二條的邊界擋不到它。
  //    假末碼的後果＝帳單自動歸到別張卡。加了邊界之後，這種矛盾資料會落到第三條或回 null。
  let m = t.match(/末\s*[四4]\s*碼[^\d]{0,6}(\d{4})(?!\d)/);    // ①「末四碼 1234」「卡號末4碼：1234」
  if (m) return m[1];
  m = t.match(/[*Xx#•●](?:[\s*Xx#•●-]*)(\d{4})\b/); // ②遮罩後接四碼：**** **** **** 1234
  if (m) return m[1];
  m = t.match(/卡號[^\n]{0,30}?(\d{4})\b(?!.*\d)/m);            // ③「卡號…」該行最後一組四碼
  if (m) return m[1];
  return null;
}

// 從帳單內容抓「這是哪一期的帳單」（使用者定 2026-07-19：不可用最後一筆消費日回推——
// 結帳日落在月初時，末筆消費日的月份會跟帳單期別對不上，兩期還可能撞成同一個月）。
// 只掃**表頭區**（前 1500 字）：明細區滿是消費日期，掃全文會抓到交易日而非期別。
// 優先序（使用者定 2026-07-19，以結帳日為準）：
//   ①**結帳日所在月份**——`結帳日 2026/02/02` → 2026-02。**不論月初月尾都算當月**
//     （使用者原本說「月初算上個月」，後來更正為一律當月）。結帳日最權威：它定義了帳單期間的結束。
//   ②明寫的期別欄位（富邦「帳單年月：115/01」）
//   ③「115年06月份」這類年月寫法
//   ④標題型（台新「2026/02 信用卡明細」）
// 全部抓不到回 null，上層退回「末筆消費日的月份」當保底並在 UI 標「推估」、可手動修正。
/** @param {string} text @returns {string|null} YYYY-MM */
export function extractStatementMonth(text) {
  const head = String(text || '').slice(0, 1500);
  /** @param {string} y @param {string} m @returns {string|null} */
  const toIso = (y, m) => {
    const mm = Number(m);
    if (!(mm >= 1 && mm <= 12)) return null;
    const yy = Number(y);
    const year = yy < 1000 ? yy + 1911 : yy;                    // 民國 115 → 2026
    return (year >= 2000 && year <= 2100) ? `${year}-${String(mm).padStart(2, '0')}` : null;
  };
  // ①結帳日（最優先）：先找「本期」系標籤，找不到才退回裸「結帳日」——且裸的前面不可是
  // 上/下/前/次（自主體檢：台新表頭常同印「上期結帳日」「下次結帳日」，交替組含子字串照樣命中、
  // match 取最早出現者 → 期別無聲標成上一期或下一期，UI 又不會標「推估」看起來很權威）
  let m = head.match(/(本期結帳日|帳單結帳日|帳單日期)[^0-9]{0,8}(1\d{2}|20\d{2})\s*[/／.-]\s*(\d{1,2})\s*[/／.-]\s*\d{1,2}/);
  if (m) { const r = toIso(m[2], m[3]); if (r) return r; }
  m = head.match(/(?<![期次])(結帳日)[^0-9]{0,8}(1\d{2}|20\d{2})\s*[/／.-]\s*(\d{1,2})\s*[/／.-]\s*\d{1,2}/);   // 擋「×期結帳日」「下次結帳日」（緊鄰字＝期/次）
  if (m) { const r = toIso(m[2], m[3]); if (r) return r; }
  // ②明寫的期別欄位（富邦「帳單年月：115/01」）
  m = head.match(/(帳單年月|帳單月份|帳單期別)[^0-9]{0,8}(1\d{2}|20\d{2})\s*[/／年.-]\s*(\d{1,2})/);
  if (m) { const r = toIso(m[2], m[3]); if (r) return r; }
  // ③「115年06月份」「民國 115 年 1 月」
  m = head.match(/(?:民國\s*)?(1\d{2}|20\d{2})\s*年\s*(\d{1,2})\s*月/);
  if (m) { const r = toIso(m[1], m[2]); if (r) return r; }
  // ④標題型（台新「2026/02 信用卡明細」）：後面緊接帳單類字眼才算，且不可是完整日期的前兩段
  m = head.match(/(1\d{2}|20\d{2})\s*[/／]\s*(\d{1,2})(?!\s*[/／]\s*\d)(?=[^\n]{0,12}(?:信用卡|明細|帳單|對帳單))/);
  if (m) { const r = toIso(m[1], m[2]); if (r) return r; }
  return null;
}

// 從帳單抓「應繳金額」（使用者定 2026-07-19）：批次列表的「匯入金額」是**消費扣掉退款後的淨額**，
// 與銀行的應繳金額本來就不同（應繳還可能含上期未繳、分期本期、年費與利息）。
// 真正繳款不匯入；退款會匯入供月度回顧抵減。把帳單自己印的數字一起存起來，對帳時一眼看到差多少。
// 各家欄位名不同，依優先序比對（台新有兩個欄位，以「本期應繳總金額」為主）。
// 「本期帳單金額」＝台新**官網 XLSX**的叫法（2026-07-20 使用者實測 2026-02 抓不到）——同一家銀行
// 郵寄版與網站版連欄位名都不同；XLSX 裡完全沒有「應繳」開頭的總額欄（只有「最低應繳金額」，
// 那不是我們要的）。放最後＝優先序最低，兩種版本欄位並存時仍以「應繳」系列為準。
const DUE_KEYS = ['本期應繳總金額', '本期應繳總額', '本期應繳金額', '本期累計應繳金額', '本期帳單金額'];
/**
 * 抓帳單自己印的應繳金額。兩種版面（2026-07-20 使用者實測 115/01 郵寄版抓錯後改寫）：
 * ①**同一行**：欄位名後 14 字內的數字（富邦「本期應繳總額：12,345」、台新官網版）。
 * ②**標籤行＋數值行**（台新郵寄版）：摘要是一行標籤、下一行全是數字——
 *     上期應款總額 - (已繳款金額+本期退款) + 本期新增款項 = 本期累計應繳金額 本期最低應繳金額
 *       10,449          10,449               58,459            58,459           8,257
 *   舊寫法的 regex 會跨行滑進數值行、撞到第一個數字＝**隔壁欄（上期）的值**（實抓 10,449、應為 58,459）。
 *   正解＝**依欄位序數對位**：標籤行裡「本期累計應繳金額」是第 4 個欄位 → 取數值行第 4 個數字。
 *   守門：標籤行必須「含鍵且無任何數字」、數值行必須「幾乎全是數字」（≥8 成 token）、
 *   序數不超界——不像這種版型就跳過，寧可回 null（列表顯示「—」）也不猜錯。
 * ⚠️ 2026-08-11（P0 對帳閘）起：這套「同一行／標籤行＋數值行序數對位」機關**抽成 `extractAmountByKeys`**，
 * 讓中閘四格（上期應繳／已繳退款／本期新增／本期應繳）共用同一副守門——本函式的行為一個字都沒變
 * （同鍵組、同守門、同回傳），改機關時 due 與 totals 兩組考題都要過。
 * @param {string} text @returns {number|null}
 */
export function extractStatementDue(text) {
  return extractAmountByKeys(text, DUE_KEYS);
}
/**
 * 依鍵組抓帳單印的某個金額（extractStatementDue 的機關本體，逐字搬入、僅鍵組參數化）。
 * @param {string} text @param {string[]} keys @returns {number|null}
 */
function extractAmountByKeys(text, keys) {
  const lines = String(text || '').split('\n');
  const OP = /^[-+=＝＋－×*/]+$/;                      // 標籤行裡的運算符 token（不算欄位）
  const NUM = /^-?[\d,]+(?:\.\d+)?$/;
  for (const k of keys) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idx = line.indexOf(k);
      if (idx < 0) continue;
      // ①同一行：鍵後 14 個非數字字元內的數字（原行為，但**不可跨行**——跨行正是這次的病根）
      const m = line.slice(idx + k.length).match(/^[^0-9-]{0,14}(-?[\d,]+(?:\.\d+)?)/);
      if (m) {
        const n = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
      }
      // ②標籤行＋數值行：本行完全無數字，下一行是數值行 → 依欄位序數對位
      if (/\d/.test(line)) continue;
      const rawTokens = line.trim().split(/\s+/).filter(t => !OP.test(t));      // 欄位（去掉 - + = 運算符）
      // 括號組併回一欄（Codex r5#3）：PDF 有時把「(已繳款金額＋本期退款)」拆出內部空格
      // →「(已繳款金額」「本期退款)」變兩個 token，欄位數一多、序數就對到隔壁欄
      //（實測抓到「最低應繳金額」）。用括號深度計數，把整組併回一個標籤。
      /** @type {string[]} */
      const labels = [];
      let buf = '', depth = 0;
      for (const t of rawTokens) {
        depth += (t.match(/[(（]/g) || []).length - (t.match(/[)）]/g) || []).length;
        buf = buf ? buf + t : t;
        if (depth <= 0) { labels.push(buf); buf = ''; depth = 0; }
      }
      if (buf) labels.push(buf);                                                // 括號沒閉合＝照原樣收尾，別丟欄
      const nextTokens = (lines[i + 1] || '').trim().split(/\s+/).filter(Boolean);
      const nums = nextTokens.filter(t => NUM.test(t));
      if (!nums.length) continue;
      // 單一標籤配數值行＝無歧義，直接取——但「標籤」必須幾乎就是欄位名本身（≤4 個裝飾字，
      // 如冒號/NT$），且下一行過半是數字。否則「……本期應繳金額……」這種**散文行**（整行沒空白
      // ＝一個 token）也會被當標籤，配上後面隨便一行明細就抓錯（考題實抓：散文＋明細列 → 150）。
      if (labels.length === 1) {
        const deco = labels[0].replace(/[:：]/g, '').length - k.length;
        if (deco >= 0 && deco <= 4 && nums.length >= nextTokens.length * 0.5) {
          const n = Number(nums[0].replace(/,/g, ''));
          if (Number.isFinite(n)) return n;
        }
        continue;
      }
      // 多欄：下一行必須「幾乎全是數字」（≥8 成 token）、**欄位數與數字數相等**（Codex r5#3 加嚴：
      // 併完括號組仍對不齊＝這行不是我們認得的版型，序數對位沒有意義，寧可回 null 也不硬猜）
      // 且序數對得上——否則不猜
      if (nums.length < 2 || nums.length < nextTokens.length * 0.8) continue;
      if (labels.length !== nums.length) continue;
      const ord = labels.findIndex(t => t.includes(k));
      if (ord < 0 || ord >= nums.length) continue;
      const n = Number(nums[ord].replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// 中閘四格的鍵組（P0 對帳閘，2026-08-11）。台新郵寄版的摘要行自己印了整條等式：
//   上期應款總額 - (已繳款金額+本期退款) + 本期新增款項 = 本期累計應繳金額 本期最低應繳金額
// 序數對位吃的是 labels[i].includes(鍵)，所以「已繳款金額」這種**子字串鍵**連
// 「(已繳款金額+本期退款)」或括號組併回時掉了 + 的「(已繳款金額本期退款)」都命中。
// XLSX 官網版只印「本期帳單金額」（DUE_KEYS 末位）＝due 讀得到、這三組交叉欄全缺＝C1 開不了、
// 中閘誠實 skip（弱閘照舊放行），不硬猜（r2#4/r3#2 照實更正，勿再寫成「四格全 null」）。
const PREV_KEYS = ['上期應款總額', '上期應繳總額', '上期應繳金額', '上期帳單金額', '前期應繳金額'];
const PAID_KEYS = ['已繳款金額+本期退款', '已繳款金額', '已繳退款金額', '已繳款及退款'];
const NEW_KEYS = ['本期新增款項', '本期新增金額', '本期新增消費', '本期消費金額'];
/**
 * 抓帳單摘要四格（中閘原料；lib/statement-reconcile.js reconcileCardStatement 吃它）。
 * 每格獨立盡力而為：讀不到＝null（該格對應的檢查 skip）；due 與 extractStatementDue 同鍵組同機關＝同值。
 * @param {string} text @returns {import('./statement-reconcile.js').CardTotals}
 */
export function extractStatementTotals(text) {
  return {
    due: extractAmountByKeys(text, DUE_KEYS),
    prevDue: extractAmountByKeys(text, PREV_KEYS),
    paidAndRefund: extractAmountByKeys(text, PAID_KEYS),
    newCharges: extractAmountByKeys(text, NEW_KEYS),
  };
}

/**
 * 讀不出消費明細時的**唯一**錯誤（PDF 與 XLSX 兩條路共用同一句、同一個 code）。
 *
 * ⚠️ **刻意把兩種可能並陳，不假裝分得出來**（2026-08-27 撤回前一版的宣稱）：前一版用「摘要四格
 *    讀不讀得到」判「認不認得版面」，但那八個鍵（DUE/PREV/PAID/NEW）**全是全台通用的行業用語**——
 *    實測合成別家帳單「玉山商業銀行…本期應繳總額 5,678」會讀到 due ⇒ 被告知「認得出版面，
 *    這期沒有交易」＝**對使用者的錢說假話**，而且把未來 AI 救援的入口關在門外。
 *    連「最低應繳金額為本期應繳金額之10%加計各項費用」這種每家都印的**條款樣板**都會讀成 due=10。
 * ⚠️ 也不要「換一組更嚴的鍵」——換誰上去都是同一代的通用詞。要真的分出「這期沒消費」與
 *    「版面讀不動」，唯一的路是版面錨點（後續批次），而錨點字面今天唯一的來源是註解，
 *    這個 repo 有「311 句註解驗出 58 句假」的前科，所以不猜。**不宣稱比宣稱錯誠實。**
 */
export const CARD_UNRECOGNIZED_MSG = '這份檔案裡我找不到任何消費明細。可能是這一期真的沒有消費，也可能是這個版面我讀不動（內建範本目前只涵蓋台新、富邦的信用卡帳單 PDF，以及台新官網下載的信用卡明細 XLSX）。';

/**
 * 「這看起來是別家印的」的訊息（分支②）。
 *
 * ⚠️ **不可以與 `CARD_UNRECOGNIZED_MSG` 共用**（Grok 2026-08-27 掃出、阻擋級）：分支②是
 *    「**讀到了列**、而且**知道是哪一家**」才丟的——對這種情況說「找不到任何消費明細，可能是
 *    這一期真的沒有消費」是**對使用者的錢說假話**，而那正是本支撤回 `card_no_rows` 的理由。
 *    同一句謊話換個位置還是謊話。
 * ⚠️ 帶出機構名是刻意的：它是我們**真的知道**的事（證據列上逐字印著），講出來使用者才知道
 *    為什麼不收、也才知道這不是他的帳單有問題。
 * @param {string[]} others 證據列上命中的別家機構名
 */
export function otherIssuerError(others) {
  const who = (others || []).join('、');
  const msg = `這份檔案的抬頭上出現「${who}」——內建範本目前只認得台新與富邦的信用卡帳單。`
    + '雖然用內建版面硬讀出了幾列，但那不是照這家的版面讀的，數字不保證正確，所以這一份不收。';
  return Object.assign(new Error(msg), { status: 400, code: 'card_unrecognized' });
}

/** @returns {Error & {status:number, code:string}} */
export function cardUnrecognizedError() {
  return Object.assign(new Error(CARD_UNRECOGNIZED_MSG), { status: 400, code: 'card_unrecognized' });
}

// 主入口：data=Uint8Array（PDF 或 XLSX，依位元組自動偵測）。password 僅加密 PDF 需要。
// 系統只負責把消費明細抽出來——PDF 銀行由文件內容判斷（parsePdfAuto）、卡片末四碼由 extractLastFour 抽出，
// 供上層自動歸卡；不用卡片 issuer 分流或擋銀行。回 { bank, lastFour, transactions }。
// 未來新增銀行＝加 parseXxx() 並補進 parsePdfAuto。
/**
 * 從**已經抽好的文字列**解析信用卡帳單 PDF——判準與接線**全部**在這裡。
 *
 * ⚠️ 這一支存在的唯一理由是**讓分流本身測得到**。前一版把判準留在 `parseStatement` 裡，
 *    理由寫的是「PDF 合成不了」——**那句話是錯的**（`test/helpers/build-pdf.js` 造得出含中文的
 *    合法 PDF），而它掩護了一整條零覆蓋的接線：把那一行 throw 整行刪掉，全套 2792 題照樣全綠，
 *    讀不動的帳單會**靜靜回報「成功、0 筆」**。現在 `parseStatement` 只剩「抽字＋轉呼叫」，
 *    沒有第二個分支可以突變。
 *
 * @param {string[][]} lines @returns {StatementResult}
 */
export function parseStatementFromLines(lines) {
  const parsed = parsePdfAuto(lines);
  const code = (parsed.noRows || parsed.otherIssuer || parsed.identityNoRows) ? 'card_unrecognized' : null;
  // 不變量先驗：丟錯時不得同時交出列或機構名；掛機構名就得說得出證據來源。違反＝我們的 bug（500）。
  assertCardIdentityInvariants({ bank: parsed.bank, bankEvidence: parsed.bankEvidence, rows: parsed.raw, code });
  // ⚠️ 兩種丟法**訊息不同**：分支②我們知道是誰、也讀到了列，不可以說「可能沒有消費」（見 otherIssuerError）。
  if (parsed.otherIssuer) throw otherIssuerError(parsed.otherIssuer);
  if (code) throw cardUnrecognizedError();
  const allText = lines.map(l => l.join(' ')).join('\n');
  const totals = extractStatementTotals(allText);
  return {
    ...finalize(parsed.raw, parsed.bank), bankEvidence: parsed.bankEvidence,
    lastFour: extractLastFour(allText), statementMonth: extractStatementMonth(allText),
    statementDue: totals.due, statementTotals: totals,
  };
}

/**
 * 從**已經讀好的試算表列**解析（台新官網下載的「信用卡明細」XLSX）。
 *
 * ⚠️ 誠實劃界：**欄位仍靠位置抄**（`parseTaishinXlsxRows` 讀第 0/2/4/7 欄，沒有欄名比對），
 *    所以別家 XLSX 只要欄序不同就會**靜靜抄錯欄**——實測
 *    `[['交易日期','入帳日','幣別','商店名稱','手續費','消費金額'],['2026/07/03',…,'15','1,250']]`
 *    會把「手續費 15」當成消費金額。**本支不修**（改成依欄名定位要有真檔的表頭字面），
 *    只用一題 documenting test 釘住現況並指向後續批次。
 * ⚠️ 但**身分**已經不靠欄位位置了（見函式內註解）：表頭列沒印機構名就不掛名、印了別家就整份丟棄。
 *    所以「欄序碰巧對上的別家 XLSX 被自動歸到台新卡」這條已經關掉；剩下的是「欄序不同抄錯欄」，
 *    而那一種現在會落到分支④（不掛名、不自動歸卡、畫面警語），使用者會被要求逐列核對。
 *
 * @param {any[][]} rows @param {string} allText @returns {StatementResult}
 */
export function parseStatementFromXlsx(rows, allText) {
  const raw = parseTaishinXlsxRows(rows);
  // ⚠️ **身分走與 PDF 完全相同的判準**（Grok 2026-08-27 掃出後改）：`parseTaishinXlsxRows` 是
  //    **純靠欄位位置**認的（第 0 欄 YYYY/MM/DD、第 4 欄金額、第 2 欄說明），**零身分檢查** ⇒
  //    別家 XLSX 只要欄序碰巧對上就會被標成台新；實測玉山欄名的檔案連金額都讀對，然後自動歸到
  //    使用者唯一那張台新卡＝**錢進錯的卡**。現在把試算表列當成 `string[][]` 餵給同一支
  //    `identifyIssuer`：表頭列印了機構名才掛名，印了別家就整份丟棄，什麼都沒印就走分支④。
  //    ⚠️ 這也讓先前發明的 `xlsx-template` 弱證據型別**不再需要**——弱證據的正確處置是
  //    「不掛名」，不是「掛名但標記它很弱、然後在自動歸卡時當它不存在」。
  const lines = (rows || []).map((r) => (r || []).map((c) => String(c ?? '').trim()).filter((x) => x !== ''));
  const id = identifyIssuer(lines, new Set());
  const other = raw.length && id.own.length === 0 && id.other.length > 0;
  const code = (!raw.length || other) ? 'card_unrecognized' : null;
  const bank = code ? '' : id.bank;
  const bankEvidence = code ? 'none' : id.bankEvidence;
  assertCardIdentityInvariants({ bank, bankEvidence, rows: code ? [] : raw, code });
  if (other) throw otherIssuerError(id.other);
  if (code) throw cardUnrecognizedError();   // ⚠️ 與 PDF 路同一句、同一個 code（考題 F5 釘住不准分岔）
  const totals = extractStatementTotals(allText);
  return {
    ...finalize(raw, bank), bankEvidence,
    lastFour: extractLastFour(allText), statementMonth: extractStatementMonth(allText),
    statementDue: totals.due, statementTotals: totals,
  };
}

/** @param {Uint8Array} data @param {string=} password @returns {Promise<StatementResult>} */
export async function parseStatement(data, password) {
  const isXlsx = data[0] === 0x50 && data[1] === 0x4B;   // ZIP（xlsx）魔術位元組 "PK"
  if (isXlsx) {
    // ⚠️ **XLSX 也走行程隔離**（取代原本 266 行的手寫 ZIP 掃描牆——見 lib/pdf-isolate.js 檔頭）：
    //    一份 1.5KB 的合法 .xlsx 解壓後可以撐爆記憶體，而「自己先掃一遍判斷貴不貴」那條路
    //    被打穿四次（牆與解析器對格式的理解只要差兩個位元組就穿）。隔離不需要看懂格式。
    const { rows, allText } = await extractXlsxIsolated(readXlsxForIsolation, data);
    return parseStatementFromXlsx(rows, allText);
  }
  const lines = await extractPdfLines('statement', extractLines, data, password);
  return parseStatementFromLines(lines);
}

// 相容舊呼叫名（server.js 已改用 parseStatement）
export const parseStatementPdf = parseStatement;
