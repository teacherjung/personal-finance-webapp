// @ts-check
// 「使用者文字當 key 的 map」安全存取（Codex r4#1，高）——純模組、零相依。
//
// 這個 app 有好幾張以**使用者輸入**為鍵的表：學習表（店名／帳單原文 → 分類）、
// 分類別名（舊分類名 → 新分類名）、子類別名。它們都是普通 JS 物件，於是有兩個坑：
//
// ①**讀**：`map['__proto__']` 在「沒有同名自有屬性」時回傳的是 `Object.prototype` 本人。
//   接著那句常見的 `const e = map[key] || {}; e.category = '飲食'; map[key] = e;`
//   就等於 `Object.prototype.category = '飲食'`——**這個行程裡每一個物件**都突然有了 category。
//   實測後果不只是資料錯：污染後連 pdfjs 都當場崩潰（`Object.defineProperty called on non-object`），
//   整個帳單解析掛掉。
// ②**寫**：`map['__proto__'] = e` 不會建立鍵，而是去換掉 map 自己的原型——那條資料就此蒸發
//   （寫入回報成功、事後查無此鍵）。
//
// JSON 來回一趟會讓 null-prototype 退化成普通物件，所以**光靠 `Object.create(null)` 不夠**，
// 讀寫兩端都要用這裡的函式。這些名字（`__proto__`／`toString`／`hasOwnProperty`…）不可能是
// 真的店名或分類名，一律拒收最乾淨。

/** `Object.prototype` 的所有屬性名——拿它當 key 一定出事。 @param {any} k @returns {boolean} */
export function isProtoKey(k) {
  return Object.getOwnPropertyNames(Object.prototype).includes(String(k));
}

/** 建一張新的、沒有原型的 map（外部資料進來時搭配 `safeMap` 使用）。 */
export function emptyMap() {
  return /** @type {Record<string, any>} */ (Object.create(null));
}

/**
 * 只讀「自有屬性」——沒有就回 undefined，絕不掉到原型上。
 * @param {any} map @param {string} key @returns {any}
 */
export function getOwn(map, key) {
  return (map && typeof map === 'object' && Object.hasOwn(map, key)) ? map[key] : undefined;
}

/**
 * 寫入一個以使用者文字為鍵的欄位；鍵是原型名就**拒絕並回 false**（呼叫端可據此略過/回報）。
 * @param {any} map @param {string} key @param {any} value @returns {boolean} 是否真的寫進去
 */
export function setOwn(map, key, value) {
  if (!map || typeof map !== 'object' || isProtoKey(key)) return false;
  map[key] = value;
  return true;
}

/**
 * 把「來路不明的物件」重建成安全的 map：null prototype ＋ 丟掉所有原型名的鍵。
 * 用在資料從資料庫/備份讀進來、或整張表重建的時候（`JSON.parse('{"__proto__":…}')`
 * 是真的做得出「自有的 __proto__ 鍵」的，所以不能只靠 `Object.create(null)`）。
 * @param {any} src @param {string[]=} dropped 被丟掉的鍵（呼叫端可警告）
 * @returns {Record<string, any>}
 */
export function safeMap(src, dropped) {
  const out = emptyMap();
  if (!src || typeof src !== 'object') return out;
  for (const [k, v] of Object.entries(src)) {
    if (isProtoKey(k)) { dropped?.push(k); continue; }
    out[k] = v;
  }
  return out;
}
