// 名詞統一（William 2026-08-14 拍板）：同一份內容在不同畫面叫不同名字，使用者對帳時要翻譯。
//
// 拍板的兩層規則＝**名詞跟著資料的出身走**：
// ・對帳單**預覽**表（每一列都來自帳單）→ 欄名「摘要・備註」＝帳單上那兩欄照抄合併，
//   拿紙本核對時逐字對得上（間隔號與既有的「金流・分類」同一個字元「・」）。
// ・銀行收支頁的明細表（**混著手動帳**、且改過名的列顯示自訂名）→ **保留**「收支說明」
//   ——表頭寫「摘要・備註」會對手動列與已學列說謊（#454 磨了九輪的同一課：
//   表頭不可宣稱內容撐不住的出身）；出身差異由 ⓘ 就地解釋講清楚。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8');

test('預覽表欄名＝「摘要・備註」，跟著帳單用語走（間隔號同「金流・分類」）', () => {
  assert.match(src, /<th>日期<\/th><th>帳戶<\/th><th>摘要・備註<\/th><th>金流・分類<\/th>/u,
    '★預覽表那一欄要叫「摘要・備註」——內容就是帳單那兩欄照抄，名字對齊帳單＝核對時不用翻譯');
  assert.doesNotMatch(src, /<th>說明<\/th>/u, '★預覽表不可再用籠統的「說明」');
});

test('收支明細**保留**「收支說明」——那張表混著手動帳與已學名，換名字會說謊', () => {
  assert.match(src, /th\('note', '收支說明'\)/u,
    '★收支明細的欄名保留「收支說明」（拍板的兩層規則：這張表的內容撐不起「摘要・備註」）');
  assert.doesNotMatch(src, /th\('note', '摘要・備註'\)/u,
    '★不可把「摘要・備註」套到混出身的表上——手動列根本沒有摘要備註');
});

test('就地解釋接上：按鈕存在、綁得到，三種出身都講、且點名預覽窗的對應欄名', () => {
  assert.match(src, /id="noteNamingInfo"/u, '沒有 ⓘ 按鈕');
  assert.match(src, /byId\('noteNamingInfo'\)\.onclick = openNoteNamingInfo;/u, '按鈕沒綁上——看得到點不動');
  const start = src.indexOf('function openNoteNamingInfo()');
  assert.ok(start >= 0, '找不到說明窗函式');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.match(body, /手動記的帳/u, '要講手動帳這種出身');
  assert.match(body, /「摘要」與「備註」兩欄<strong>照抄合併<\/strong>/u,
    '★要點破銀行列的預設＝帳單兩欄照抄——不講，使用者會以為是 app 自己寫的說明');
  assert.match(body, /「摘要・備註」/u, '★要點名預覽窗的對應欄名——兩個畫面同一份內容，名字要接得起來');
  assert.match(body, /「已學」/u, '要講改過名的列（顯示自訂名＋已學標籤）');
});
