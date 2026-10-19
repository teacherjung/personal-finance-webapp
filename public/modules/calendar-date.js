// @ts-check
// 日曆判準與資料庫消毒器共用，避免瀏覽器自行猜測不存在的日期。
export const isRealDate = (/** @type {any} */ v) => {
  if (typeof v !== 'string') return false;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  // 用 UTC 建構再比對，避開本地時區在月初/月底的位移（這裡只驗「這個日子存不存在」）
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
};
