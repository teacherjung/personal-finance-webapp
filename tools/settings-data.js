#!/usr/bin/env node
// 專案設定的**資料來源**，只有讀取這一件事。
//
// 為什麼單獨一支：平台介面（tools/platform.js）與設定產生器（tools/build-settings.js）都要讀它，
// 而產生器又要跟平台介面拿動作清單來排版。三者若擠在兩支檔裡就會互相 require 成一個圈
// （實際發生過，Node 印了循環相依的警告，而循環相依會讓其中一邊在載入當下拿到半個空物件——
// 那正是「靜靜壞掉」的形狀）。把「讀」抽出來，相依方向就只剩一條線：
//   settings-data ← platform ← build-settings
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataFile = path.join(root, 'settings.json');

function read() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

module.exports = { read, dataFile };
