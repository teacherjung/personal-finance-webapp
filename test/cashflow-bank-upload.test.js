// @ts-check
// 上傳銀行對帳單：密碼欄告知文案的模式分流（#437 r2 審查者抓到的 main 既有問題）。
//
// 病根：openBankUpload 的密碼欄舊文案寫「只在這台電腦解密、不會上傳、不會儲存」，
// 但預覽／套用都是把 PDF 與密碼 POST 給 app 伺服器——LOCAL 那台伺服器就是這台電腦、
// 句子成立；HOSTED 是營運方的遠端伺服器＝「不會上傳」是反方向誤導。
// 修法＝比照匯出告知（backup-export.js exportNotice）：`GET /api/mode` 分流兩句，
// 保守預設方向相反（問不到＝當雲端講；理由見 cashflow-model.js bankPasswordLabel 註解）。
//
// ⚠️ 誠實劃界：本檔鎖的是「挑句判準」與「cashflow.js 真的接了這條線」。
//   ・「/api/mode 回應只有 hosted、HOSTED 掛在 authGate 後面」由 test/server.test.js 那組守；
//   ・「密碼在伺服器端只進記憶體、不落檔」是 lib 層行為，不歸本檔（收支契約
//     「帳戶完整帳號與餘額匯入」節）；
//   ・瀏覽器端「真的發出這次問答」的端到端行為本檔不跑（cashflow.js 頂層 import app.js，
//     node 環境載不動整頁），接線題退而掃去註解後的原始碼——與 backup-export.test.js
//     的設定頁接線題同一種取捨。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BANK_PW_NOTICE_LOCAL, BANK_PW_NOTICE_HOSTED, bankPasswordLabel,
} from '../public/modules/cashflow-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('挑句｜只有明確 hosted:false 才講「這台電腦」，其他一律當雲端講（保守方向與匯出相反）', () => {
  assert.equal(bankPasswordLabel({ hosted: false }), BANK_PW_NOTICE_LOCAL, 'LOCAL 明確回 false ⇒ 才可以講本機那句');
  assert.equal(bankPasswordLabel({ hosted: true }), BANK_PW_NOTICE_HOSTED, 'HOSTED 明確回 true ⇒ 雲端那句');
  // 問不到／形狀不合法＝一律雲端那句：這裡猜錯若是「以為沒上傳」＝把密碼騙上雲（正是要修的病）；
  // 反過來只是把本機使用者多嚇一跳。方向與 exportNotice 相反、原則相同（往安全的方向錯）。
  assert.equal(bankPasswordLabel(null), BANK_PW_NOTICE_HOSTED, '問不到模式 ⇒ 當雲端講');
  assert.equal(bankPasswordLabel(undefined), BANK_PW_NOTICE_HOSTED, '同上');
  assert.equal(bankPasswordLabel({}), BANK_PW_NOTICE_HOSTED, '回應沒有 hosted 欄位 ⇒ 同樣保守');
  assert.equal(bankPasswordLabel({ hosted: 'false' }), BANK_PW_NOTICE_HOSTED, '字串 "false" 不算 false（型別鬆掉就會講反）');
  assert.equal(bankPasswordLabel({ hosted: 0 }), BANK_PW_NOTICE_HOSTED, '0 也不算 false——只認布林');
});

test('文案｜雲端那句要坦白「會上傳」，而且不可殘留本機的宣稱', () => {
  // 這幾條鎖的是「誠實的骨架」，不是逐字措辭——William 改字不會誤紅，換回舊謊話一定紅。
  assert.match(BANK_PW_NOTICE_HOSTED, /上傳/, '雲端那句必須明講會上傳');
  assert.match(BANK_PW_NOTICE_HOSTED, /伺服器/, '雲端那句必須講去了伺服器');
  assert.doesNotMatch(BANK_PW_NOTICE_HOSTED, /只在這台電腦|不會上傳|不會傳上網路/, '雲端那句殘留任何本機宣稱＝舊病復發');
  assert.match(BANK_PW_NOTICE_LOCAL, /這台電腦/, '本機那句才可以講這台電腦');
  // 「不會儲存」兩句都講＝伺服器端現況（銀行對帳單密碼單次使用）。
  // ⚠️ 日後 P0.5 改成可選儲存時，這兩條要跟著那支 PR 一起改——它們在這裡就是絆線。
  assert.match(BANK_PW_NOTICE_LOCAL, /不會儲存/);
  assert.match(BANK_PW_NOTICE_HOSTED, /不會儲存/);
  assert.notEqual(BANK_PW_NOTICE_LOCAL, BANK_PW_NOTICE_HOSTED, '兩句相同＝分流白做');
});

/** 去註解（接線題讀原始碼文字，照 AGENTS 的硬規則先把註解拿掉）。抄自 backup-export.test.js。 @param {string} raw */
function stripComments(raw) {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

test('接線｜cashflow.js 的密碼欄真的走共用挑句函式，先問模式、舊謊話已絕跡', () => {
  // ⚠️ 先去註解：把接線改成註解就等於沒接，掃原始字面會給假綠（backup-export.test.js r5 阻擋②同款）。
  const src = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(src, /label:\s*bankPasswordLabel\(mode\)/,
    '密碼欄 label 要用共用挑句函式——寫死一句的話 William 審改只會改到一邊、模式判斷也會走散');
  assert.match(src, /defaultWithTimeout\(\s*api\('\/mode'\)\s*,\s*MODE_TIMEOUT_MS\s*\)/,
    '開窗前要問 /api/mode 而且要有等待上限——沒上限＝伺服器不回話時連上傳窗都開不出來（匯出 r5 阻擋①同款病）');
  assert.doesNotMatch(src, /只在這台電腦解密、不會上傳/,
    '舊文案逐字回歸＝雲端版把「不會上傳」講給正在上傳的人聽');
  assert.doesNotMatch(src, /對帳單密碼（/,
    'cashflow.js 裡不准再出現手寫的密碼欄告知句——兩句與挑句判準只住 cashflow-model.js 一處');
});
