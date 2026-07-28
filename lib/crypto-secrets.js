// @ts-check
// 機密欄位的「信封加密」（envelope encryption，C5；C0 第五節）。**只用在 HOSTED**。
//
// 白話：資料庫裡不再存 IBKR token 與 PDF 密碼（＝身分證字號）的原文，而是存一串亂碼；
// 解鎖的鑰匙（`NOTEASY_MASTER_KEY`）放在 Render 的環境變數裡、**不在資料庫裡**。
// 這樣就算整顆資料庫被拿走（備份外流、Supabase 帳號被盜、SQL 注入），拿到的也只是亂碼。
//
// 為什麼 LOCAL 不加密（裁決，不是疏漏）：你的 Mac 上檔案不出門，加密只是把鑰匙跟鎖放在同一個抽屜——
// 徒增「鑰匙掉了資料就沒了」的風險，換不到實質保護。LOCAL 一行都不動。
//
// 三個設計決定：
// ① **AES-256-GCM**（Node 內建 crypto，零新依賴）：GCM 自帶完整性驗證，別人改一個位元組就解不開，
//    不會默默解出一個「看起來像 token 的垃圾」。
// ② **AAD 綁定 `使用者 id + 欄位路徑`**：同一串密文不能從 B 的列搬到 A 的列、也不能從
//    `pdfPassword` 搬到 `flexToken`。RLS 已經擋掉跨租戶寫入，這是第二道（便宜、值得）。
// ③ **解不開時回空字串、不是炸掉**（生存優先）：鑰匙換過或掉了的話，整個 app 應該還能開、
//    只是那個欄位變成「未設定」讓使用者重新輸入一次；而不是連帳本都打不開。失敗會 console.warn，
//    **訊息只講欄位路徑、絕不含值**（那正是我們要保護的東西）。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** 密文前綴：認得出「這是加密過的」，也留了版本號給日後換演算法。 */
const PREFIX = 'enc:v1:';
const IV_LEN = 12;    // GCM 建議的 96-bit nonce
const TAG_LEN = 16;

/**
 * 主金鑰（32 bytes）。來源＝環境變數 `NOTEASY_MASTER_KEY`，內容是 base64。
 * 產生方式（給部署時用）：`openssl rand -base64 32`
 * ⚠️ 這把鑰匙**絕不可進 repo、絕不可進瀏覽器**；掉了＝所有已加密的機密都要重新輸入一次。
 * @returns {Buffer}
 */
export function masterKey() {
  const raw = String(process.env.NOTEASY_MASTER_KEY || '');
  if (!raw) throw new Error('[crypto] 缺 NOTEASY_MASTER_KEY——HOSTED 模式沒有主金鑰就不能存機密欄位');
  let key;
  try { key = Buffer.from(raw, 'base64'); }
  catch { throw new Error('[crypto] NOTEASY_MASTER_KEY 不是合法的 base64'); }
  if (key.length !== 32) {
    throw new Error(`[crypto] NOTEASY_MASTER_KEY 必須是 32 bytes 的 base64（目前 ${key.length} bytes）——用 \`openssl rand -base64 32\` 產生`);
  }
  return key;
}

/** 這個值是不是已經加密過的？（用來避免重複加密／判斷舊資料） @param {any} v @returns {boolean} */
export function isEncrypted(v) { return typeof v === 'string' && v.startsWith(PREFIX); }

/**
 * 加密一個機密字串。空字串＝「未設定」，原樣回傳（不加密空值：加密後會變成一長串亂碼，
 * 讓「有沒有設定」這件事從一眼可辨變成要解密才知道，`…Set` 布林投影會跟著失準）。
 * @param {any} plain @param {string} aad 綁定用的上下文（`${userId}|${欄位路徑}`）
 * @returns {string}
 */
export function encryptSecret(plain, aad) {
  const text = typeof plain === 'string' ? plain : '';
  if (!text) return '';
  if (isEncrypted(text)) return text;                 // 已經是密文＝不要包第二層
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/**
 * 解密。**不是密文就原樣回傳**（相容「加密上線前就存進去的舊值」與 LOCAL 的明文）。
 * 解不開＝回空字串＋警告（見檔頭③）。
 * @param {any} value @param {string} aad @returns {string}
 */
export function decryptSecret(value, aad) {
  const text = typeof value === 'string' ? value : '';
  if (!isEncrypted(text)) return text;
  try {
    const buf = Buffer.from(text.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    // ⚠️ 只講「哪個欄位」，**絕不**把值或密文放進訊息（考題會掃）
    console.warn(`[crypto] 機密欄位解密失敗（${aad}）——請在設定頁重新輸入一次。原因：${/** @type {any} */ (e)?.message || '未知'}`);
    return '';
  }
}
