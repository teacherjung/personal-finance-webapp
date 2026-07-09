#!/bin/bash
# 雙擊這個檔案就能啟動「個人理財中心」
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "第一次啟動，正在安裝必要元件…"
  npm install
fi
# 啟動後自動打開瀏覽器
( sleep 1.5; open "http://localhost:4321" ) &
npm start
