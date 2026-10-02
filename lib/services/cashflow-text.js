// @ts-check
// 編輯銀行收支的兩行文字；帳單原文、分類、金額與去重鍵不在這裡改。
import { isCardTx } from '../../public/modules/categories.js';
import { cashflowDescriptionLines, cashflowTextKey } from '../../public/modules/cashflow-model.js';
import { CASHFLOW_TEXT_RULE_LIMIT, CASHFLOW_TEXT_RULE_LENGTH } from '../schema.js';
import { isProtoKey } from '../safe-map.js';

/** 未來匯入只看帳單原文；空字串也是使用者明確設定的替換值。 @param {any} rules @param {string} summary @param {string} remark */
export function cashflowTextOverrides(rules, summary, remark) {
  /** @type {{summary?:string,remark?:string}} */ const out = {};
  for (const [part, key] of /** @type {const} */ ([['summary', summary], ['remark', remark]])) {
    const map = rules?.[part];
    if (map && typeof map === 'object' && Object.hasOwn(map, key) && typeof map[key] === 'string') out[part] = map[key];
  }
  return out;
}

/** 單筆編輯、既有相同原文與後續匯入的規則在同一次資料庫寫入內完成。 @param {any} db @param {any} item @param {any} prev @param {{summary:boolean,remark:boolean}} selected */
export function applySameCashflowTextToDb(db, item, prev, selected) {
  if (isCardTx(item)) throw Object.assign(new Error('信用卡紀錄不能套用銀行收支文字'), { status: 400 });
  const result = { summary: 0, remark: 0 };
  const oldLines = cashflowDescriptionLines(prev);
  const rules = db.settings?.cashflowTextRules || { summary: {}, remark: {} };
  const nextRules = { summary: { ...(rules.summary || {}) }, remark: { ...(rules.remark || {}) } };
  for (const part of /** @type {const} */ (['summary', 'remark'])) {
    if (!selected[part]) continue;
    const oldText = part === 'summary' ? oldLines.summary : oldLines.note;
    const key = cashflowTextKey(prev, part);
    const next = item[part];
    if (typeof next !== 'string' || next === oldText) continue;
    if (!key || isProtoKey(key) || key.length > CASHFLOW_TEXT_RULE_LENGTH || next.length > CASHFLOW_TEXT_RULE_LENGTH) {
      throw Object.assign(new Error(`「${part === 'summary' ? '摘要' : '備註'}」無法建立套用規則：原文空白或文字過長`), { status: 400 });
    }
    const map = nextRules[part];
    if (!Object.hasOwn(map, key) && Object.keys(map).length >= CASHFLOW_TEXT_RULE_LIMIT) {
      throw Object.assign(new Error('摘要／備註的套用規則已達上限'), { status: 400 });
    }
    map[key] = next;
    for (const tx of db.transactions || []) {
      if (tx.id === item.id || isCardTx(tx) || cashflowTextKey(tx, part) !== key) continue;
      if (tx[part] !== next) { tx[part] = next; result[part]++; }
    }
  }
  db.settings = { ...db.settings, cashflowTextRules: nextRules };
  return result;
}
