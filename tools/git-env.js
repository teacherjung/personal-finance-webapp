#!/usr/bin/env node
// 呼叫版本控制工具之前，先把它那一族環境變數整族清掉（規矩 E4）。
//
// 為什麼：git 有一族環境變數會讓它**不看你給的路徑、改看環境**。最要命的是 GIT_DIR——
// 它一存在，指定工作目錄就形同無效。而且不需要有人手動設：git 自己會把它放進鉤子的環境，
// 從連結工作樹推送時，推送前鉤子跑的整套考題都在那個環境下跑。原專案因此把主倉庫寫成了裸倉庫
// （套件倉庫的案例簿 bare-repo-incident；公開紀錄＝personal-finance-webapp #435），而做這件事的考題顯示通過。
//
// 為什麼按前綴整族清、不列名：列名補不完，原專案補了兩次還漏（會長的那一族：GIT_CONFIG_COUNT、
// GIT_CONFIG_KEY_n…）。列舉補不完就要關門，前綴是唯一關得起來的門。
//
// 誠實劃界：只清 GIT_ 前綴。GITHUB_ 不受影響（第四個字元不是底線；雲端靠它，寫鬆會誤殺）。
// HOME 與 PATH 刻意不動：PATH 清掉就找不到 git；HOME 清了也關不起來（還有固定路徑的排除檔），
// 只買到部分保護卻多一個讓呼叫端挑錯的入口。
'use strict';

/** 回一份新的環境，原本那份不動。 */
function gitEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('GIT_')) out[key] = value;
  }
  return out;
}

module.exports = { gitEnv };
