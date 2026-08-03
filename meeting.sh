#!/bin/bash
# 專案會議：你 + Claude + Codex
# 請把這個檔案放在「專案資料夾」裡執行（PROJECT.md 所在的資料夾）
# 用法: ./meeting.sh "這次會議要討論的議題"
# 每輪兩個 AI 各發言一次後輪到你：
#   輸入文字 → 插話    直接按 Enter → 讓它們繼續    輸入 q → 散會並更新 PROJECT.md

TOPIC="${1:?請提供會議議題，例如: ./meeting.sh \"討論下一步先做哪個功能\"}"
LOG="meeting_$(date +%m%d_%H%M).md"

if [ ! -f PROJECT.md ]; then
  echo "❌ 這個資料夾裡沒有 PROJECT.md。請先 cd 到專案資料夾再執行。"
  exit 1
fi

echo "# 會議議題：${TOPIC}" > "$LOG"
printf '\n## William（人類負責人）\n\n%s\n' "$TOPIC" >> "$LOG"

RULES="你們是同一個專案的協作者：William（人類負責人）、Claude（AI）、Codex（AI）。專案的共同記憶在 PROJECT.md，發言前請先閱讀它，必要時也可以閱讀專案裡的其他檔案來確認事實。這是一場工作會議：請針對議題和最新的發言提出具體、可執行的建議，可以提出分工，也可以反對對方的做法，但要說明理由。這個階段只討論，禁止修改任何檔案。如果 William 剛發言過，優先回應他。用繁體中文，300字以內，直接進入重點，不要客套。"

round=1
while true; do
  echo ""
  echo "━━━━━ 第 ${round} 輪 · Claude 思考中… ━━━━━"
  CLAUDE_REPLY=$(claude -p "${RULES}

以下是本次會議記錄：

$(cat "$LOG")

（你是 Claude，請發言）")
  printf '\n## Claude\n\n%s\n' "$CLAUDE_REPLY" >> "$LOG"
  echo "$CLAUDE_REPLY"

  echo ""
  echo "━━━━━ 第 ${round} 輪 · Codex 思考中… ━━━━━"
  codex exec --skip-git-repo-check --output-last-message /tmp/codex_last.txt "${RULES}

以下是本次會議記錄：

$(cat "$LOG")

（你是 Codex，請發言）" > /dev/null 2>&1
  CODEX_REPLY=$(cat /tmp/codex_last.txt)
  printf '\n## Codex\n\n%s\n' "$CODEX_REPLY" >> "$LOG"
  echo "$CODEX_REPLY"

  echo ""
  echo "─────────────────────────────────────"
  echo "輪到你：打字插話｜Enter 讓它們繼續｜q 散會"
  printf "> "
  read -r USER_INPUT
  if [ "$USER_INPUT" = "q" ]; then
    break
  elif [ -n "$USER_INPUT" ]; then
    printf '\n## William（人類負責人）\n\n%s\n' "$USER_INPUT" >> "$LOG"
  fi
  round=$((round+1))
done

echo ""
echo "━━━━━ 散會，Claude 正在更新 PROJECT.md… ━━━━━"
claude -p --permission-mode acceptEdits "請閱讀 PROJECT.md 和會議記錄 ${LOG}。把會議中「三方有共識」的結論更新進 PROJECT.md 的對應區塊（目前狀態、待辦事項、重要決定），仍有分歧或未定案的項目不要寫入。只修改 PROJECT.md，不要動其他檔案。完成後用繁體中文簡短回報你更新了哪些內容。"

echo ""
echo "✅ 會議記錄存在：${LOG}，PROJECT.md 已更新。"
