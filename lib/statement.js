// 信用卡帳單 PDF 解析：解密（密碼存卡片的 pdfPassword，本機 store.json、永不進版控）、
// 抽出消費明細、關鍵字自動分類（兩層：分類／子類）。PDF 本身不落地保存，只回傳解析結果。
// v1 支援富邦；新增銀行＝加一個 parseXxx() 並在 parseStatementPdf 依 issuer 分流。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as XLSX from 'xlsx';
import { DEFAULT_EXPENSE } from '../public/modules/categories.js';

// ---- 關鍵字 → [分類, 子類]（比對「消費說明」，由上往下先中先贏）----
// 分類字串必須對得上 public/modules/categories.js 的 EXPENSE_TREE（AGENTS.md 同步點）。
// 順序重點：特殊指定（YouTube→學習、ChatGPT/Claude/Notion→工作、汽車保險→交通）與
// 較專一的關鍵字要排在通用之前，才不會被通用規則先攔截。
const CATEGORY_RULES = [
  // 工作（軟體訂閱要在其他通用之前）
  ['工作', 'ChatGPT', ['CHATGPT', 'OPENAI']],
  ['工作', 'Claude', ['CLAUDE', 'ANTHROPIC']],
  ['工作', 'Notion', ['NOTION']],
  ['工作', 'Canva及其他工作軟體', ['CANVA', 'ADOBE', 'FIGMA', 'MICROSOFT', 'OFFICE 365', 'MICROSOFT 365', 'ELEVENLABS', 'HEYGEN', 'SYNTHESIA', 'DESCRIPT', 'ZAPIER', 'AIRTABLE']],
  ['工作', '網站／網域／雲端服務', ['GITHUB', 'DROPBOX', 'GODADDY', 'CLOUDFLARE', 'VERCEL', 'AWS', 'GOOGLE CLOUD', '網域']],
  // 學習
  ['學習', 'YouTube Premium', ['YOUTUBE']],
  ['學習', '學習型訂閱服務', ['UDEMY', 'COURSERA', 'HAHOW', '均一', '線上課程', 'MASTERCLASS', '思維槓桿', 'PRESSPLAY', '知識訂閱']],
  ['學習', '書籍', ['博客來', '讀冊', '金石堂', '誠品書', 'BOOKS']],
  ['學習', '考試／證照費', ['測驗中心', '報名費', '證照', '檢定']],
  // 交通（汽車保險要在保險之前）
  ['交通', '汽車保險', ['汽車保險', '強制險', '車體險', '車險']],
  ['交通', '油錢', ['中油', '台亞', '加油站', '加油', '福記', '柑園加油', '統一精工', '速邁樂']],
  ['交通', '停車費', ['停車', '嘟嘟房', '停車場', '城市車旅', '和雲', 'TIMES', '拖吊', '阜爾運通', '普客二四', '順康資產', '林口四維路', '綠湖', '嘟嘟房']],
  ['交通', '計程車／Uber', ['UBER TRIP', '優步', '台灣大車隊', '計程車', 'TAXI', '55688', 'YOXI', 'Q2 TAXI', 'Q２']],
  ['交通', '停車費', ['ETAG停車', 'ETAG自動儲值', '泊車', '長庚泊車']],
  ['交通', '停車費', ['TAPPAY', '台灣國際開發']],   // TapPay 第三方支付，使用者的多為停車（非停車者可於預覽/事後逐筆改）
  ['生活', '其他生活雜支', ['自動加值']],   // 悠遊卡/一卡通自動加值歸生活（要排在下面「悠遊卡→大眾運輸」之前，使用者定）
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
  ['娛樂', '興趣用品', ['誠品', '奧特萊斯', 'OUTLET', '三井', '遠東百貨', '遠百', 'SOGO', '新光三越', '百貨']],
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
  ['飲食', '餐廳', ['餐廳', '餐飲', '石二鍋', '鼎泰豐', '麥當勞', '肯德基', '摩斯', '漢堡', '火鍋', '燒肉', '燒臘', '食堂', '小吃', '拉圖爾', '12MINI', 'LADY M', 'LADY-M', '秘食', '墨爾', '炸牛', '爭鮮', '壽司', '涮涮', '鬍鬚張', '無老鍋', '精釀', '三顧茅廬', '冰室', '御園坊', '茗香園', '滷味', '牛肉麵', '拉麵', '涮乃葉']],
  ['飲食', '超市', ['統一超商', '7-ELEVEN', '全家', '萊爾富', 'OK超商', '超商']],   // 超商暫歸超市桶
  ['飲食', '外送', ['FOODPANDA', 'FP-', 'UBER EATS', 'UBEREATS', '優食', 'FP＊', 'ODDLE']],   // 保底：認不出店家的外送仍歸飲食
  // 居住
  ['居住', '', ['地價稅']],   // 地價稅歸居住（使用者定；居住無稅務子類，故不分子類）
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
  ['生活', '行政規費', ['規費', '監理', '戶政', '地政', '區公所', '地價稅', '房屋稅']],
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
  ['社交', '社交活動', ['TIMELEFT']]
];

// 回傳 [分類, 子類]。未命中→其他/未分類（DEFAULT_EXPENSE，讓使用者一眼看出待手動確認）。
export function categorize(desc) {
  const d = String(desc || '').toUpperCase();
  for (const [cat, sub, keys] of CATEGORY_RULES) {
    if (keys.some(k => d.includes(k.toUpperCase()))) return [cat, sub];
  }
  return [...DEFAULT_EXPENSE];
}

// 正規化消費說明：官網版 PDF 用康熙部首異體字（⼝≠口）且字間插空白，
// 郵寄版用全形英數。統一成標準字＋半形，讓兩版產生一致的說明與 stmtRef
// （否則同一筆消費跨版式上傳會被當成新的重複匯入、分類關鍵字也比對不到）。
const RADICAL_FIX = { '⺠': '民' };   // NFKC 涵蓋不到的個別部首，遇到再補
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
const STORE_CANON = [
  ['eTag停車', /eTag停車|ETAG停車/i],       // eTag停車3087-H8:xxx → eTag停車
  ['foodpanda', /^foodpanda[-\s]/i],       // foodpanda-EC → foodpanda（FP-<店名> 不在此、會保留店名）
  ['悠遊卡自動加值', /自動加值/],            // 悠遊卡自動加值-正好停… → 悠遊卡自動加值
  ['OMGYES', /OMGYES/i],
  ['馬可先生', /馬可先生/],
  ['六必居', /六必居/]
];
export function cleanStore(desc) {
  const raw = String(desc || '');
  for (const [canon, re] of STORE_CANON) if (re.test(raw)) return canon;
  const s = raw
    .replace(/^[A-Za-z0-9一-鿿]{1,12}[*＊_]\s*/, '')                                        // 金流/通路前綴：連加*、騰加數位*、OPENAI*、TAPPAY_
    .replace(/^FP-/i, '')                                                                          // 外送前綴（FP-<店名> 保留店名）
    .replace(/[（(].*$/, '')                                                                        // 截斷的括號分店：石二鍋(林口家樂 → 石二鍋
    .replace(/、.*$/, '')                                                                           // 21PLUS、21 → 21PLUS
    .replace(/\s*\d{3,4}-[A-Z0-9]{1,4}\s*$/, '')                                                    // 結尾設備碼：eTag自動儲值3087-H8 → eTag自動儲值
    .replace(/(股份有限公司|有限公司|股份有限|股份公司|有限合夥)/g, '')                                 // 公司型態字眼
    .replace(/\s*[\/／](TW|US|JP|HK|SG|GB|CN|KR)\s*$/i, '')                                         // 結尾 /TW 等國別碼
    .replace(/\s*[A-Z]\d{3,4}\s*(NEW\s*TAI?P?E?I?|New\s*Tai?p?e?i?|TAIPEI|Taipei|TW)?\s*$/i, '')   // 結尾分店定位碼(＋城市)
    .replace(/\s*(NEW\s*TAI?P?E?I?|New\s*Tai?p?e?i?|TAIPEI|Taipei)\s*$/i, '')                       // 結尾殘留城市
    .replace(/\d{8,}\s*$/, '')                                                                     // 結尾長數字(統編/序號)
    .replace(/([一-鿿])[A-Za-z][A-Za-z0-9 .&]*$/, '$1')                                    // 中文店名後的殘留英文：摩斯漢堡Mos B → 摩斯漢堡
    .replace(/[\s（(＊*－\-:：]+$/, '')                                                              // 收尾多餘標點/空白
    .trim();
  return s || raw;
}

// 民國日期 → 西元 ISO。支援 115/01/13（斜線，富邦/台新新版）與 1150113（7 碼，台新補印版）
function rocToIso(s) {
  let str = String(s || '').trim();
  if (/^1\d{6}$/.test(str)) str = `${str.slice(0, 3)}/${str.slice(3, 5)}/${str.slice(5)}`;
  const m = str.match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
}

// PDF → 每頁文字列（依 y 分行、x 排序重建表格；cells 為該列的文字片段陣列）
async function extractLines(data, password) {
  // pdfjs 會「detach」傳入的 ArrayBuffer（把呼叫端的 data 清空）。免選卡「試密碼」會對
  // 同一份 bytes 連續解析多次，第 2 次起就會拿到已 detach 的空 buffer→「Cannot transfer
  // object of unsupported type」，害所有需要密碼的加密帳單開不了。傳「副本」進去即可避免。
  const task = getDocument({ data: new Uint8Array(data), password, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (String(e?.name).includes('Password')) {
      throw new Error(password
        ? 'PDF 密碼錯誤（請到卡片追蹤確認「帳單 PDF 密碼」）'
        : '這份 PDF 有加密，請先到卡片追蹤設定這張卡的「帳單 PDF 密碼」');
    }
    throw new Error('PDF 無法開啟：' + (e.message || e));
  }
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const rows = {};
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str.trim() });
    }
    for (const [, cells] of Object.entries(rows).sort((a, b) => b[0] - a[0])) {
      lines.push(cells.sort((a, b) => a.x - b.x).map(c => c.s));
    }
  }
  await task.destroy();
  return lines;
}

// 富邦帳單：明細列＝ 消費日期(民國) | 消費說明 | 入帳日期(民國) | [外幣折算日/幣別 | 外幣金額/消費地] | 台幣金額
// 兩種版式都支援：①郵寄電子帳單（說明與日期同一列）②官網「帳單明細查詢」下載版
// （交易列只有 日期|入帳日|幣別|金額，消費說明「換行」到下一列）。
function parseFubon(lines) {
  const txs = [];
  const isRoc = (s) => /^\d{2,3}\/\d{2}\/\d{2}$/.test(s);
  const isAmt = (s) => /^-?[\d,]+(\.\d+)?$/.test(s);
  for (let i = 0; i < lines.length; i++) {
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
    // 官網版：本列沒有說明 → 下一列若非日期列也非金額列，就是換行的消費說明
    if (!desc) {
      const next = lines[i + 1];
      if (next && next.length && !isRoc(next[0]) && !isAmt(next[next.length - 1])) {
        desc = normalizeDesc(next.join(' '));
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
  }
  return txs;
}

// 台新帳單 PDF（郵寄電子帳單，加密）。交易列＝消費日 | 入帳起息日 | [消費明細] | 台幣金額 | [外幣折算日 消費地 幣別 外幣金額]。
// 兩種模板都支援：斜線民國(115/06/02) 與 7 碼民國(1150602，補印版)。金額＝兩個日期之後第一個純整數 cell
// （避開說明內含的地點碼與外幣金額）。說明有時不在交易列上，而是印在「上一行」（此列無說明時）——
// **只取上一行、不可連下一行也抓**（下一行是下一筆的說明，抓了會把兩筆說明黏在一起）；上一行無內容才退用下一行。
// 與同月 XLSX 交叉驗證：3 月 94/94、7 月 66/66，日期＋金額零誤差。
function parseTaishinPdf(lines) {
  const isRoc = (s) => /^\d{2,3}\/\d{2}\/\d{2}$/.test(s) || /^1\d{6}$/.test(s);
  const isAmt = (s) => /^-?[\d,]+$/.test(s);
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i];
    if (c.length < 3 || !isRoc(c[0]) || !isRoc(c[1])) continue;
    let ai = -1;
    for (let k = 2; k < c.length; k++) { if (isAmt(c[k])) { ai = k; break; } }
    if (ai < 0) continue;
    const amount = Number(c[ai].replace(/,/g, ''));
    let desc = normalizeDesc(c.slice(2, ai).join(' '));
    if (!desc) {   // 說明印在相鄰非交易列：優先取「上一行」，上一行沒有才退用「下一行」（不可兩行都抓＝會黏到下一筆）
      const prev = lines[i - 1], next = lines[i + 1];
      const pa = (prev && !isRoc(prev[0])) ? normalizeDesc(prev.join(' ')) : '';
      const nb = (next && !isRoc(next[0])) ? normalizeDesc(next.join(' ')) : '';
      desc = pa || nb;
    }
    if (!desc) continue;
    // 外幣：金額後若有幣別碼（USD…）＋外幣金額，接進說明（與 XLSX 一致，讓跨格式去重對得上）
    const rest = c.slice(ai + 1);
    const ci = rest.findIndex(x => /^[A-Z]{3}$/.test(x));
    if (ci >= 0 && rest[ci + 1] && /^[\d.,]+$/.test(rest[ci + 1])) desc = `${desc}（${rest[ci]}/${rest[ci + 1]}）`;
    raw.push({ date: rocToIso(c[0]), postDate: rocToIso(c[1]), desc, amount });
  }
  return raw;
}

// 分類＋國外交易服務費繼承（PDF/XLSX 各家解析器的原始明細共用這道後處理）。
// raw=[{date, postDate, desc, amount}]，回傳 { bank, transactions:[{...,isPayment,category,subcategory}] }
function finalize(raw, bank) {
  const txs = raw.map(t => {
    const isPayment = t.amount < 0;   // 負數＝繳款/退款，預設不匯入記帳
    const [cat, sub] = isPayment ? ['繳款/退款', ''] : categorize(t.desc);
    return { ...t, isPayment, category: cat, subcategory: sub, store: cleanStore(t.desc) };
  });
  // 「國外交易服務費」跟隨它所屬的那筆刷卡分類（費用緊接在該筆消費之後）
  for (let i = 1; i < txs.length; i++) {
    if (!txs[i].isPayment && /國外交易服務費/.test(txs[i].desc)) {
      const prev = txs[i - 1];
      if (prev && !prev.isPayment && !/國外交易服務費/.test(prev.desc)) {
        txs[i].category = prev.category;
        txs[i].subcategory = prev.subcategory;
      }
    }
  }
  return { bank, transactions: txs };
}

// 台新 XLSX（官網下載「信用卡明細」）：西元日期、金額獨立欄，結構乾淨。
// 交易列＝ col0 消費日期(YYYY/MM/DD) | col1 入帳日 | col2 消費明細 | col3 幣別 | col4 金額 | … col7 外幣幣別/金額
function parseTaishinXlsx(data) {
  const wb = XLSX.read(data, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
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
    raw.push({ date: String(r[0]).replace(/\//g, '-'), postDate: String(r[1] || '').replace(/\//g, '-') || null, desc, amount });
  }
  return raw;
}

// PDF 依「文件內容」自動辨識銀行（不看使用者選的卡片——卡片只決定記到哪＋PDF 密碼）。
// 兩家版式結構本就不同（台新每列開頭兩個民國日期、富邦一個），且帳單一定印自家行名；
// 先用行名關鍵字判斷方向，命中的解析器有結果就採用，否則挑解析到較多筆的那家。
function parsePdfAuto(lines) {
  const text = lines.map(l => l.join(' ')).join('\n');
  const taishinHits = (text.match(/台\s*新|Taishin|Richart/gi) || []).length;
  const fubonHits = (text.match(/富\s*邦|Fubon/gi) || []).length;
  const fubon = { bank: '富邦', raw: parseFubon(lines) };
  const taishin = { bank: '台新', raw: parseTaishinPdf(lines) };
  if (taishinHits > fubonHits && taishin.raw.length) return taishin;
  if (fubonHits > taishinHits && fubon.raw.length) return fubon;
  return taishin.raw.length > fubon.raw.length ? taishin : fubon;   // 行名不明時挑筆數多者（皆 0 → 上層報錯）
}

// 從帳單內容抓「卡號末四碼」（盡力而為；抓不到回 null，上層退回請使用者選卡）。
// 帳單卡號多為遮罩顯示，樣式各家不同，先支援常見幾種；真實帳單校準後再補。
function extractLastFour(text) {
  const t = String(text || '');
  let m = t.match(/末\s*[四4]\s*碼[^\d]{0,6}(\d{4})/);          // ①「末四碼 1234」「卡號末4碼：1234」
  if (m) return m[1];
  m = t.match(/[*Xx#•●](?:[\s*Xx#•●-]*)(\d{4})\b/); // ②遮罩後接四碼：**** **** **** 1234
  if (m) return m[1];
  m = t.match(/卡號[^\n]{0,30}?(\d{4})\b(?!.*\d)/m);            // ③「卡號…」該行最後一組四碼
  if (m) return m[1];
  return null;
}

// XLSX 全表文字（供 extractLastFour 掃卡號；交易列以外的表頭也要看）。
function xlsxAllText(data) {
  try {
    const wb = XLSX.read(data, { type: 'array' });
    const out = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
      for (const r of rows) out.push(r.join(' '));
    }
    return out.join('\n');
  } catch { return ''; }
}

// 主入口：data=Uint8Array（PDF 或 XLSX，依位元組自動偵測）。password 僅加密 PDF 需要。
// 系統只負責把消費明細抽出來——PDF 銀行由文件內容判斷（parsePdfAuto）、卡片末四碼由 extractLastFour 抽出，
// 供上層自動歸卡；不用卡片 issuer 分流或擋銀行。回 { bank, lastFour, transactions }。
// 未來新增銀行＝加 parseXxx() 並補進 parsePdfAuto。
export async function parseStatement(data, password) {
  const isXlsx = data[0] === 0x50 && data[1] === 0x4B;   // ZIP（xlsx）魔術位元組 "PK"
  if (isXlsx) {
    const raw = parseTaishinXlsx(data);
    if (!raw.length) throw new Error('這份 XLSX 找不到消費明細——目前 XLSX 支援台新官網下載的「信用卡明細」格式。');
    return { ...finalize(raw, '台新'), lastFour: extractLastFour(xlsxAllText(data)) };
  }
  const lines = await extractLines(data, password);
  const { bank, raw } = parsePdfAuto(lines);
  if (!raw.length) throw new Error('找不到消費明細——PDF 目前支援富邦與台新兩家的帳單格式，或該期沒有交易。');
  return { ...finalize(raw, bank), lastFour: extractLastFour(lines.map(l => l.join(' ')).join('\n')) };
}

// 相容舊呼叫名（server.js 已改用 parseStatement）
export const parseStatementPdf = parseStatement;
