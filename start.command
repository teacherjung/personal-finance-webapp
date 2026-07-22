#!/bin/bash
# 雙擊這個檔案就能啟動「個人理財中心」
cd "$(dirname "$0")"

pause_if_interactive() {
  if [ -t 0 ]; then
    printf "\n按 Enter 鍵關閉這個視窗…"
    read -r _
  fi
}

fail_start() {
  printf "\n無法啟動：%s\n" "$1"
  pause_if_interactive
  exit 1
}

command -v node >/dev/null 2>&1 || fail_start "找不到 Node.js。請先到 https://nodejs.org 安裝目前的 LTS 版本。"
node scripts/check-node-version.js || { pause_if_interactive; exit 1; }
command -v npm >/dev/null 2>&1 || fail_start "找不到 npm。請重新安裝 Node.js 後再試一次。"

if [ ! -d node_modules ]; then
  echo "第一次啟動，正在安裝必要元件…"
  npm install || fail_start "必要元件安裝失敗。請確認網路連線後再試一次。"
fi
# 啟動後自動打開瀏覽器
( sleep 1.5; open "http://localhost:4321" ) &
npm start
STATUS=$?
if [ "$STATUS" -ne 0 ] && [ "$STATUS" -ne 130 ]; then
  printf "\n程式啟動失敗，請保留上方訊息以便檢查。\n"
  pause_if_interactive
fi
exit "$STATUS"
