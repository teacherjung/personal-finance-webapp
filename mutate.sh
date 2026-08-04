#!/bin/zsh
# 拆分護欄的突變表。
#
# ⚠️ 這支腳本本身出過三次事（都是 Codex 抓的，而且我親身踩過）：
#   ①它會 `git checkout --` 還原檔案 ⇒ **未 commit 的工作會被洗掉**（我洗掉過自己一輪的修改）
#   ②期望不符時只印 ⚠️、退出碼仍是 0 ⇒ 掛進任何自動化都是**永遠通過的假閘**
#   ③某條的標籤裡有反引號（zsh 會當成命令替換）⇒ 突變寫進檔案之後才中止、**沒有還原**，
#     而我接著就 commit ⇒ **突變被 commit 進 PR**
# 所以現在：工作樹不乾淨就拒跑（**沒有例外，本腳本自己也算**）、
# 任一條不如期望 exit 1、基準與收尾都真的 assert、**中止時 trap 還原**。
set -u
cd "$(dirname "$0")"

fail=0

restore() { git checkout -- AGENTS.md docs/contracts/ test/contract-split.test.js 2>/dev/null || true; }

# ⚠️ **髒檔檢查必須在掛 trap 之前**（2026-08-03 第四次事故，我親手踩的）：
#    原本 `trap restore EXIT` 掛在前面，於是「工作樹不乾淨 → exit 2」這條保護分支
#    **自己會觸發 EXIT trap**，restore 照樣 `git checkout` 把未 commit 的工作洗掉。
#    ——**那正是這道檢查存在的理由，它卻在拒絕執行的同時做了它要防的事。**
#    保護措施本身要先於它所保護的危險動作生效，順序不是風格問題。
dirty=$(git status --porcelain || true)
if [[ -n "$dirty" ]]; then
  echo "❌ 工作樹不乾淨，拒絕執行——這支會 git checkout 還原檔案，會洗掉你未 commit 的工作："
  echo "$dirty"
  exit 2
fi

trap restore EXIT INT TERM

run() {
  if node --test --test-reporter=dot test/contract-split.test.js >/dev/null 2>&1; then
    echo "綠"
  else
    echo "紅"
  fi
}

base=$(run)
printf "   %-46s → %s\n" "0. 未突變（基準）" "$base"
if [[ "$base" != "綠" ]]; then
  echo "❌ 基準就是紅的——突變結果全部無效（實際發生過兩次）。先把基準修綠。"
  exit 2
fi

# ⚠️ **突變本身失敗就要當場中止**（Codex #384 r23 Low）：
#    有一條的 Python 找不到目標而 raise，腳本卻繼續跑——**基準（未突變）被當成「期望綠」通過**，
#    最後還 exit 0 印「全部符合期望」。**沒有跑到的突變，不能算它通過。**
mutate() {   # mutate <說明>：後面接 heredoc；失敗立即 exit
  if ! python3 -; then
    echo "❌ 突變「$1」建置失敗——沒有跑到的突變不能算通過。"
    exit 1
  fi
}

check() {   # check <說明> <期望：紅|綠>
  local got mark
  got=$(run)
  if [[ "$got" == "$2" ]]; then mark="  "; else mark="❌"; fail=1; fi
  printf "%s %-46s → %s（期望 %s）\n" "$mark" "$1" "$got" "$2"
  restore
}

# ── 藏東西：契約與規則檔不准出現 fence 或 HTML 註解（r13 起改成「關門」）──

mutate 'A. 契約檔出現 code fence（連合法成對的也不准）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"```text\n連合法成對的也不准\n```\n\n"+s[i:], encoding="utf-8")
PY
check 'A. 契約檔出現 code fence（連合法成對的也不准）' 紅

mutate 'B. 契約檔出現 HTML 註解（連閉合的也不准）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"<!-- 連閉合的也不准 -->\n\n"+s[i:], encoding="utf-8")
PY
check 'B. 契約檔出現 HTML 註解（連閉合的也不准）' 紅

mutate 'C. AGENTS 出現 fence（另一種記號也一樣）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"~~~\n\n"+s[i:], encoding="utf-8")
PY
check 'C. AGENTS 出現 fence（另一種記號也一樣）' 紅

mutate 'D. 用 <pre> 把整節吞掉（raw HTML block）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡"); j=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"<pre>\n"+s[i:j]+"\n</pre>\n"+s[j:], encoding="utf-8")
PY
check 'D. 用 <pre> 把整節吞掉（raw HTML block）' 紅

mutate 'E. 行首出現 <div>（另一類 raw HTML）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"<div>\n\n"+s[i:], encoding="utf-8")
PY
check 'E. 行首出現 <div>（另一類 raw HTML）' 紅

mutate 'F. 契約標題含連結（GitHub 的 anchor 會不一樣）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.replace("## 月度回顧總覽卡","## 月度回顧[總覽卡](x.md)",1), encoding="utf-8")
PY
check 'F. 契約標題含連結（GitHub 的 anchor 會不一樣）' 紅

# ── 標題形式：會產生 anchor、卻不在原本掃描範圍裡的四種（Codex #384 r14）──
# 共同的傷害：**搶走正式標題的裸 anchor**，正式那節被 GitHub 改成 `…-1`，
# AGENTS 的索引連結就默默指到別的地方——而畫面上完全看不出來。

mutate 'R. 同名 #### 搶走 anchor（Codex r14 實證）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"#### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'R. 同名 #### 搶走 anchor（Codex r14 實證）' 紅

mutate 'S. 同名 Setext 標題搶走 anchor' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"月度回顧總覽卡\n==============\n\n"+s[i:], encoding="utf-8")
PY
check 'S. 同名 Setext 標題搶走 anchor' 紅

mutate 'T. 縮排兩格的同名 ##（CommonMark 仍算標題）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"  ## 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'T. 縮排兩格的同名 ##（CommonMark 仍算標題）' 紅

mutate 'U. 第二個 H1 同名（H1 原本不在掃描範圍）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"# 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'U. 第二個 H1 同名（H1 原本不在掃描範圍）' 紅

# ── 容器裡的標題／語法：只看行首會全部漏掉（Codex #384 r16）──
# 三份契約現在第 3–5 行本來就在用 blockquote，所以這不是刻意構造。

mutate 'V. 引用裡的同名 ####（Codex r16 實證）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"> #### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'V. 引用裡的同名 ####（Codex r16 實證）' 紅

mutate 'W. 清單裡的同名 ##（剝完長得跟正式的一樣）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"- ## 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'W. 清單裡的同名 ##（剝完長得跟正式的一樣）' 紅

mutate 'X. 引用裡的 code fence（繞過 fence 禁令）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"> ```text\n> 引用裡的 fence 一樣不准\n> ```\n\n"+s[i:], encoding="utf-8")
PY
check 'X. 引用裡的 code fence（繞過 fence 禁令）' 紅

mutate 'Y. 引用裡的 raw HTML（繞過 HTML 禁令）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"> <div>\n\n"+s[i:], encoding="utf-8")
PY
check 'Y. 引用裡的 raw HTML（繞過 HTML 禁令）' 紅

mutate 'Z. 契約檔第一行的 H1 整行刪掉' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.split("\n",1)[1].lstrip("\n"), encoding="utf-8")
PY
check 'Z. 契約檔第一行的 H1 整行刪掉' 紅

# ── 容器「續行」：靠縮排成立，逐行剝字首分辨不了（Codex #384 r18）──

mutate 'AA. 清單續行裡的引用 ####（Codex r18 實證）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"- 外層\n    > #### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'AA. 清單續行裡的引用 ####（Codex r18 實證）' 紅

mutate 'AB. 清單續行裡的 fence' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"- 外層\n\n    ```text\n    藏在清單續行裡\n    ```\n\n"+s[i:], encoding="utf-8")
PY
check 'AB. 清單續行裡的 fence' 紅

mutate 'AC. 用 Tab 縮排的巢狀容器' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"- 外層\n\t> #### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'AC. 用 Tab 縮排的巢狀容器' 紅

mutate 'AD. H1 加收尾井字號（anchor 兩邊算不一樣）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
ls=p.read_text(encoding="utf-8").split("\n"); ls[0]=ls[0]+" #"
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'AD. H1 加收尾井字號（anchor 兩邊算不一樣）' 紅

# ── 誤紅方向：這幾種 GitHub 只當普通段落，**不可以**被擋（期望綠）──

mutate 'AE.（誤紅考題）-## 文字＝普通段落，不可擋' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"-## 這不是標題，是普通段落\n\n"+s[i:], encoding="utf-8")
PY
check 'AE.（誤紅考題）-## 文字＝普通段落，不可擋' 綠

mutate 'AF.（誤紅考題）**## 粗體**＝普通段落，不可擋' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"**## 粗體開頭的普通段落**\n\n"+s[i:], encoding="utf-8")
PY
check 'AF.（誤紅考題）**## 粗體**＝普通段落，不可擋' 綠

mutate 'AG.（誤紅考題）1.## 文字＝普通段落，不可擋' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"1.## 也是普通段落\n\n"+s[i:], encoding="utf-8")
PY
check 'AG.（誤紅考題）1.## 文字＝普通段落，不可擋' 綠

# ── 不需要行首縮排就能藏東西的三族（Codex #384 r20）──

mutate 'AH. 引用包住的續行 ####（原始行首是 >）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"> - 外層\n>     #### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'AH. 引用包住的續行 ####（原始行首是 >）' 紅

mutate 'AI. 隱形 reference definition 灌大內文' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 訂閱續費日自動推進")
# GitHub 一個字都不顯示，卻算進長度 ⇒ 灌大內文讓比例檢查失效
pad="[guard-padding]: # (" + "隱形"*400 + ")\n\n"
p.write_text(s[:i]+pad+s[i:], encoding="utf-8")
PY
check 'AI. 隱形 reference definition 灌大內文' 紅

mutate 'AJ. 行「中」的 raw HTML（原本只擋行首）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+'可見前綴 <a id="月度回顧總覽卡"></a><details><summary>展開</summary>藏起來</details>\n\n'+s[i:], encoding="utf-8")
PY
check 'AJ. 行「中」的 raw HTML（原本只擋行首）' 紅

mutate 'AK. 零寬字元灌大內文' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"看不見的padding"+"​"*2000+"\n\n"+s[i:], encoding="utf-8")
PY
check 'AK. 零寬字元灌大內文' 紅

# ── r23：容器裡的隱形 padding、不等長反引號、AGENTS 行中 <details> ──

mutate 'AL. 引用裡的 reference definition（原本行首判斷看不到）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"> [guard-padding]: # (" + "隱形"*400 + ")\n\n"+s[i:], encoding="utf-8")
PY
check 'AL. 引用裡的 reference definition（原本行首判斷看不到）' 紅

mutate 'AM. 開一個反引號關兩個（GFM 不算 code span）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+'可見文字 `<a id="月度回顧總覽卡"></a>`` 後面\n\n'+s[i:], encoding="utf-8")
PY
check 'AM. 開一個反引號關兩個（GFM 不算 code span）' 紅

mutate 'AN. AGENTS 行「中」的 details 把同步點表摺起來' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
j=s.rindex("\n", 0, i)
p.write_text(s[:j]+" <details><summary>展開</summary>"+s[j:], encoding="utf-8")
PY
check 'AN. AGENTS 行「中」的 details 把同步點表摺起來' 紅

# ── r25：Codex 給的兩個 GFM 反例＋漏掉的責任檔 ──

mutate 'AP. 開三個反引號關兩個（正規式會回溯）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+'可見文字 ```<a id="月度回顧總覽卡"></a>`` 後面\n\n'+s[i:], encoding="utf-8")
PY
check 'AP. 開三個反引號關兩個（正規式會回溯）' 紅

mutate 'AQ. 跳脫的反引號包住 details（AGENTS 同步點表被摺起來）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
j=s.rindex("\n", 0, i)
p.write_text(s[:j]+"\n\n\\`<details><summary>隱藏同步點</summary>\\`\n"+s[j:], encoding="utf-8")
PY
check 'AQ. 跳脫的反引號包住 details（AGENTS 同步點表被摺起來）' 紅

mutate 'AR. 弱化凍結標的判準（責任檔原本不在 manifest）' <<'PY'
import pathlib
p=pathlib.Path("test/contract-split.test.js"); s=p.read_text(encoding="utf-8")
a="      'public/modules/portfolio-forms.js',\n"
assert s.count(a)==1
p.write_text(s.replace(a,""), encoding="utf-8")
PY
check 'AR. 弱化凍結標的判準（責任檔原本不在 manifest）' 紅

mutate 'AS. 索引列用 video 把兩格清空（Codex r27 實測）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
j=s.index("\n", i)
row=s[i:j]
cells=row.split("|")
cells[1]="<video>"+cells[1]+"</video>"
p.write_text(s[:i]+"|".join(cells)+s[j:], encoding="utf-8")
PY
check 'AS. 索引列用 video 把兩格清空（Codex r27 實測）' 紅

# ── r29：索引列的封閉形狀契約（判準用 GitHub /markdown API 校準過）──

mutate 'AT. 索引列前面插空行（GitHub 會把它移出表格）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"\n"+s[i:], encoding="utf-8")
PY
check 'AT. 索引列前面插空行（GitHub 會把它移出表格）' 紅

mutate 'AU. 索引列縮排（GitHub 會渲染成程式碼區塊）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"    "+s[i:], encoding="utf-8")
PY
check 'AU. 索引列縮排（GitHub 會渲染成程式碼區塊）' 紅

mutate 'AV. 契約連結被反斜線跳脫（畫面上點不了）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |"); j=s.index("\n", i)
row=s[i:j].replace("[契約：", "\\[契約：", 1)
p.write_text(s[:i]+row+s[j:], encoding="utf-8")
PY
check 'AV. 契約連結被反斜線跳脫（畫面上點不了）' 紅

mutate 'AW. 索引列第一格清空（畫面上那格是空的）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"|  |"+s[i+len("| 月度回顧總覽卡 |"):], encoding="utf-8")
PY
check 'AW. 索引列第一格清空（畫面上那格是空的）' 紅

# ── r31：Codex 用 GitHub /markdown 實證的四種「連結還在、畫面上看不到」──

mutate 'AX. 連結包進雙反引號（渲染成 code、不是連結）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |"); j=s.index("\n", i)
row=s[i:j]
k=row.index("[契約：")
e=row.index(")", k)+1          # 連結結束的位置（不含列尾的 " |"）
p.write_text(s[:i]+row[:k]+"``"+row[k:e]+"``"+row[e:]+s[j:], encoding="utf-8")
PY
check 'AX. 連結包進雙反引號（渲染成 code、不是連結）' 紅

mutate 'AY. 連結藏到第三格（兩欄表格會直接丟掉）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |"); j=s.index("\n", i)
row=s[i:j]
k=row.index("[契約：")
p.write_text(s[:i]+row[:k]+"| "+row[k:]+s[j:], encoding="utf-8")
PY
check 'AY. 連結藏到第三格（兩欄表格會直接丟掉）' 紅

mutate 'AZ. 第一格用空連結（渲染成空的 a）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
a="| 月度回顧總覽卡 |"
p.write_text(s.replace(a,"| [](https://example.com) |",1), encoding="utf-8")
PY
check 'AZ. 第一格用空連結（渲染成空的 a）' 紅

mutate 'BA. 第一格用 HTML entity 的零寬字元' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
a="| 月度回顧總覽卡 |"
p.write_text(s.replace(a,"| &#x200B; |",1), encoding="utf-8")
PY
check 'BA. 第一格用 HTML entity 的零寬字元' 紅

mutate 'BB. 第一格用 reference-style 空連結（沒有 ]( 所以躲過前一版）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
a="| 月度回顧總覽卡 |"
p.write_text(s.replace(a,"| [][blank] |",1)+"\n[blank]: https://example.com\n", encoding="utf-8")
PY
check 'BB. 第一格用 reference-style 空連結（沒有 ]( 所以躲過前一版）' 紅

# ── r35：四條核心承諾的實質缺口（Codex 用 GitHub /markdown 逐條實證）──

mutate 'BC. 表格中間插一個 ###（後續索引列被移出表格）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"### 中途插一個標題\n"+s[i:], encoding="utf-8")
PY
check 'BC. 表格中間插一個 ###（後續索引列被移出表格）' 紅

mutate 'BD. 表格中間插一個清單項' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"- 中途插一個清單\n"+s[i:], encoding="utf-8")
PY
check 'BD. 表格中間插一個清單項' 紅

mutate 'BE. 契約標題改成分解式組合符（slug 會丟掉、GitHub 會保留）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.replace("## 訂閱狀態","## 訂閱狀a\u0301態",1), encoding="utf-8")
PY
check 'BE. 契約標題改成分解式組合符（slug 會丟掉、GitHub 會保留）' 紅

mutate 'BF. 契約加長網址、摘要貼回全部可見內文' <<'PY'
import pathlib,re
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡"); j=s.index("\n## ", i)
sec=s[i:j]
body=sec.split("**記得同步這裡**：")[1]
pad="（[來源](https://example.com/"+"x"*900+")）"
s=s[:i]+sec+pad+s[j:]
q=pathlib.Path("AGENTS.md"); t=q.read_text(encoding="utf-8")
k=t.index("| 月度回顧總覽卡 |"); e=t.index("\n", k)
row=t[k:e]; m=re.search(r"——完整契約\s*→\s*\[[^\]]*\]\([^)]*\)", row)
q.write_text(t[:k]+"| 月度回顧總覽卡 | "+body.replace("\n"," ").strip()+" "+m.group(0)+" |"+t[e:], encoding="utf-8")
p.write_text(s, encoding="utf-8")
PY
check 'BF. 契約加長網址、摘要貼回全部可見內文' 紅

mutate 'BG. 整段原文塞進契約連結的 label' <<'PY'
import pathlib,re
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |"); j=s.index("\n", i)
row=s[i:j]
p.write_text(s[:i]+re.sub(r"\[契約：[^\]]*\]", "[契約：這裡塞一整段原文，畫面上會完整顯示，而摘要計算會把整個連結剝掉]", row)+s[j:], encoding="utf-8")
PY
check 'BG. 整段原文塞進契約連結的 label' 紅

mutate 'BH. 契約頁首指到別人的 README 列' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.replace("路由表「前端功能」列","路由表「投資與 SEC」列",1), encoding="utf-8")
PY
check 'BH. 契約頁首指到別人的 README 列' 紅

# ── r37：表格狀態、括號網址、精確 domain、圖片連結、entity ──

mutate 'BI. 先插清單、再接普通續文（前一行看起來無害）' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"- 維護說明\n普通續文\n"+s[i:], encoding="utf-8")
PY
check 'BI. 先插清單、再接普通續文（前一行看起來無害）' 紅

mutate 'BJ. 用帶空白的分隔線 _ _ _ 中斷表格' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"_ _ _\n"+s[i:], encoding="utf-8")
PY
check 'BJ. 用帶空白的分隔線 _ _ _ 中斷表格' 紅

mutate 'BK. 括號型來源網址撐大分母＋摘要貼回全部內文' <<'PY'
import pathlib,re
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡"); j=s.index("\n## ", i)
sec=s[i:j]; body=sec.split("**記得同步這裡**：")[1]
pad="（[來源](https://example.com/report(section)?utm_source="+"x"*900+")）"
p.write_text(s[:i]+sec+pad+s[j:], encoding="utf-8")
q=pathlib.Path("AGENTS.md"); t=q.read_text(encoding="utf-8")
k=t.index("| 月度回顧總覽卡 |"); e=t.index("\n", k)
m=re.search(r"——完整契約\s*→\s*\[[^\]]*\]\([^)]*\)", t[k:e])
q.write_text(t[:k]+"| 月度回顧總覽卡 | "+body.replace("\n"," ").strip()+" "+m.group(0)+" |"+t[e:], encoding="utf-8")
PY
check 'BK. 括號型來源網址撐大分母＋摘要貼回全部內文' 紅

mutate 'BL. 契約頁首把領域名寫短（startsWith 會放過）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.replace("路由表「前端功能」列","路由表「前端」列",1), encoding="utf-8")
PY
check 'BL. 契約頁首把領域名寫短（startsWith 會放過）' 紅

mutate 'BM. 契約連結改成圖片形式' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |"); j=s.index("\n", i)
p.write_text(s[:i]+s[i:j].replace("[契約：","![契約：",1)+s[j:], encoding="utf-8")
PY
check 'BM. 契約連結改成圖片形式' 紅

mutate 'BN. 契約 body 塞 HTML entity 撐大分母' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/frontend-features.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"&ZeroWidthSpace;"*60+"\n\n"+s[i:], encoding="utf-8")
PY
check 'BN. 契約 body 塞 HTML entity 撐大分母' 紅

mutate 'BO. README 第一格加括號後綴（前綴比對會放過）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
a="| 前端功能 |"
assert s.count(a)==1
p.write_text(s.replace(a,"| 前端功能（完全不同的領域）|",1), encoding="utf-8")
PY
check 'BO. README 第一格加括號後綴（前綴比對會放過）' 紅

# ── 索引與契約的雙向對應 ──

mutate 'G. 無空白分隔符＋整段規則貼回索引' <<'PY'
import pathlib
ct=pathlib.Path("docs/contracts/frontend-features.md").read_text(encoding="utf-8")
i=ct.index("## 月度回顧總覽卡"); j=ct.index("\n## ", i)
b=ct[i:j].split("**記得同步這裡**：")[1].replace("\n"," ").strip()
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        ls[k]="| 月度回顧總覽卡|"+b+"——完整契約"+l.split("——完整契約")[1]; break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'G. 無空白分隔符＋整段規則貼回索引' 紅

mutate 'H. 用跳脫的直線藏在同一格＋貼回全文' <<'PY'
import pathlib
ct=pathlib.Path("docs/contracts/frontend-features.md").read_text(encoding="utf-8")
i=ct.index("## 月度回顧總覽卡"); j=ct.index("\n## ", i)
b=ct[i:j].split("**記得同步這裡**：")[1].replace("\n"," ").strip()
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        ls[k]="| 月度回顧總覽卡 | 前半\\|後半"+b+"——完整契約"+l.split("——完整契約")[1]; break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'H. 用跳脫的直線藏在同一格＋貼回全文' 紅

mutate 'I. 先放假 marker 再貼回全文（切第一個會漏）' <<'PY'
import pathlib
ct=pathlib.Path("docs/contracts/frontend-features.md").read_text(encoding="utf-8")
i=ct.index("## 月度回顧總覽卡"); j=ct.index("\n## ", i)
b=ct[i:j].split("**記得同步這裡**：")[1].replace("\n"," ").strip()
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        ls[k]="| 月度回顧總覽卡 | 短摘要——完整契約（假的）"+b+"——完整契約"+l.split("——完整契約")[1]; break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'I. 先放假 marker 再貼回全文（切第一個會漏）' 紅

mutate 'J. 刪掉「最新單季」那條索引（原豁免項）' <<'PY'
import pathlib,re
p=pathlib.Path("AGENTS.md")
p.write_text(re.sub(r'^\| \*\*SEC 最新單季逐列期間\*\*.*\n','',p.read_text(encoding="utf-8"),flags=re.M), encoding="utf-8")
PY
check 'J. 刪掉「最新單季」那條索引（原豁免項）' 紅

mutate 'K. marker 與索引一起刪（雙向斷言的核心）' <<'PY'
import pathlib,re
p=pathlib.Path("docs/contracts/income-expense.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 店家消費檔案")
p.write_text(s[:i]+s[i:].replace("**記得同步這裡**：","**同步**："), encoding="utf-8")
q=pathlib.Path("AGENTS.md")
q.write_text(re.sub(r'^\| \*\*店家消費檔案\*\*.*\n','',q.read_text(encoding="utf-8"),flags=re.M), encoding="utf-8")
PY
check 'K. marker 與索引一起刪（雙向斷言的核心）' 紅

rm -f docs/contracts/frontend-features.md
check 'L. 整份契約檔刪掉' 紅

mutate 'M. 從 manifest 偷偷拿掉一條規則' <<'PY'
import pathlib
p=pathlib.Path("test/contract-split.test.js")
p.write_text(p.read_text(encoding="utf-8").replace("      '月度回顧總覽卡',\n",""), encoding="utf-8")
PY
check 'M. 從 manifest 偷偷拿掉一條規則' 紅

mutate 'N. AGENTS 多一條等價的重複索引列' <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        ls.insert(k+1, l.replace(" | ","|").replace("(docs/contracts/","(./docs/contracts/")); break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'N. AGENTS 多一條等價的重複索引列' 紅

# ── 路由表 ──

mutate 'O. 同一份契約多出一條矛盾路由列' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 收支記帳與匯入")
s=s[:i]+"|前端功能（重複且錯誤）|（沒有任何責任檔）|[frontend-features.md](./frontend-features.md)|\n"+s[i:]
p.write_text(s, encoding="utf-8")
PY
check 'O. 同一份契約多出一條矛盾路由列' 紅

mutate 'P. 路由表用短檔名冒充完整路徑' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); t=p.read_text(encoding="utf-8")
assert t.count("`public/modules/portfolio-symbol.js`")==1
p.write_text(t.replace("`public/modules/portfolio-symbol.js`","`portfolio-symbol.js`",1), encoding="utf-8")
PY
check 'P. 路由表用短檔名冒充完整路徑' 紅

mutate 'Q. README 連結誤用 repo-root 路徑（連到不存在）' <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.replace("[frontend-features.md](frontend-features.md)","[frontend-features.md](docs/contracts/frontend-features.md)",1), encoding="utf-8")
PY
check 'Q. README 連結誤用 repo-root 路徑（連到不存在）' 紅

# ── 收尾：真的 assert，不是印出來就算 ──
leftover=$(git status --porcelain || true)
if [[ -n "$leftover" ]]; then
  echo "❌ 收尾沒乾淨（突變沒還原）："
  echo "$leftover"
  fail=1
fi
if [[ "$(run)" != "綠" ]]; then
  echo "❌ 跑完之後基準變紅了——有突變沒還原乾淨。"
  fail=1
fi

[[ $fail -eq 0 ]] && echo "✅ 全部符合期望，收尾乾淨" || echo "❌ 有不符合期望的項目（見上）"
exit $fail
