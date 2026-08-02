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
trap restore EXIT INT TERM

dirty=$(git status --porcelain || true)
if [[ -n "$dirty" ]]; then
  echo "❌ 工作樹不乾淨，拒絕執行——這支會 git checkout 還原檔案，會洗掉你未 commit 的工作："
  echo "$dirty"
  exit 2
fi

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

check() {   # check <說明> <期望：紅|綠>
  local got mark
  got=$(run)
  if [[ "$got" == "$2" ]]; then mark="  "; else mark="❌"; fail=1; fi
  printf "%s %-46s → %s（期望 %s）\n" "$mark" "$1" "$got" "$2"
  restore
}

# ── 藏東西：契約與規則檔不准出現 fence 或 HTML 註解（r13 起改成「關門」）──

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"```text\n連合法成對的也不准\n```\n\n"+s[i:], encoding="utf-8")
PY
check 'A. 契約檔出現 code fence（連合法成對的也不准）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"<!-- 連閉合的也不准 -->\n\n"+s[i:], encoding="utf-8")
PY
check 'B. 契約檔出現 HTML 註解（連閉合的也不准）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 月度回顧總覽卡 |")
p.write_text(s[:i]+"~~~\n\n"+s[i:], encoding="utf-8")
PY
check 'C. AGENTS 出現 fence（另一種記號也一樣）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡"); j=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"<pre>\n"+s[i:j]+"\n</pre>\n"+s[j:], encoding="utf-8")
PY
check 'D. 用 <pre> 把整節吞掉（raw HTML block）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"<div>\n\n"+s[i:], encoding="utf-8")
PY
check 'E. 行首出現 <div>（另一類 raw HTML）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.replace("## 月度回顧總覽卡","## 月度回顧[總覽卡](x.md)",1), encoding="utf-8")
PY
check 'F. 契約標題含連結（GitHub 的 anchor 會不一樣）' 紅

# ── 標題形式：會產生 anchor、卻不在原本掃描範圍裡的四種（Codex #384 r14）──
# 共同的傷害：**搶走正式標題的裸 anchor**，正式那節被 GitHub 改成 `…-1`，
# AGENTS 的索引連結就默默指到別的地方——而畫面上完全看不出來。

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"#### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'R. 同名 #### 搶走 anchor（Codex r14 實證）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"月度回顧總覽卡\n==============\n\n"+s[i:], encoding="utf-8")
PY
check 'S. 同名 Setext 標題搶走 anchor' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"  ## 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'T. 縮排兩格的同名 ##（CommonMark 仍算標題）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"# 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'U. 第二個 H1 同名（H1 原本不在掃描範圍）' 紅

# ── 容器裡的標題／語法：只看行首會全部漏掉（Codex #384 r16）──
# 三份契約現在第 3–5 行本來就在用 blockquote，所以這不是刻意構造。

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"> #### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'V. 引用裡的同名 ####（Codex r16 實證）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"- ## 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'W. 清單裡的同名 ##（剝完長得跟正式的一樣）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"> ```text\n> 引用裡的 fence 一樣不准\n> ```\n\n"+s[i:], encoding="utf-8")
PY
check 'X. 引用裡的 code fence（繞過 fence 禁令）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"> <div>\n\n"+s[i:], encoding="utf-8")
PY
check 'Y. 引用裡的 raw HTML（繞過 HTML 禁令）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.split("\n",1)[1].lstrip("\n"), encoding="utf-8")
PY
check 'Z. 契約檔第一行的 H1 整行刪掉' 紅

# ── 容器「續行」：靠縮排成立，逐行剝字首分辨不了（Codex #384 r18）──

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"- 外層\n    > #### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'AA. 清單續行裡的引用 ####（Codex r18 實證）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"- 外層\n\n    ```text\n    藏在清單續行裡\n    ```\n\n"+s[i:], encoding="utf-8")
PY
check 'AB. 清單續行裡的 fence' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"- 外層\n\t> #### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'AC. 用 Tab 縮排的巢狀容器' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
ls=p.read_text(encoding="utf-8").split("\n"); ls[0]=ls[0]+" #"
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'AD. H1 加收尾井字號（anchor 兩邊算不一樣）' 紅

# ── 誤紅方向：這幾種 GitHub 只當普通段落，**不可以**被擋（期望綠）──

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"-## 這不是標題，是普通段落\n\n"+s[i:], encoding="utf-8")
PY
check 'AE.（誤紅考題）-## 文字＝普通段落，不可擋' 綠

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"**## 粗體開頭的普通段落**\n\n"+s[i:], encoding="utf-8")
PY
check 'AF.（誤紅考題）**## 粗體**＝普通段落，不可擋' 綠

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"1.## 也是普通段落\n\n"+s[i:], encoding="utf-8")
PY
check 'AG.（誤紅考題）1.## 文字＝普通段落，不可擋' 綠

# ── 不需要行首縮排就能藏東西的三族（Codex #384 r20）──

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"> - 外層\n>     #### 月度回顧總覽卡\n\n"+s[i:], encoding="utf-8")
PY
check 'AH. 引用包住的續行 ####（原始行首是 >）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 訂閱續費日自動推進")
# GitHub 一個字都不顯示，卻算進長度 ⇒ 灌大內文讓比例檢查失效
pad="[guard-padding]: # (" + "隱形"*400 + ")\n\n"
p.write_text(s[:i]+pad+s[i:], encoding="utf-8")
PY
check 'AI. 隱形 reference definition 灌大內文' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+'可見前綴 <a id="月度回顧總覽卡"></a><details><summary>展開</summary>藏起來</details>\n\n'+s[i:], encoding="utf-8")
PY
check 'AJ. 行「中」的 raw HTML（原本只擋行首）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"看不見的padding"+"​"*2000+"\n\n"+s[i:], encoding="utf-8")
PY
check 'AK. 零寬字元灌大內文' 紅

# ── 索引與契約的雙向對應 ──

python3 - <<'PY'
import pathlib
ct=pathlib.Path("docs/contracts/前端功能.md").read_text(encoding="utf-8")
i=ct.index("## 月度回顧總覽卡"); j=ct.index("\n## ", i)
b=ct[i:j].split("**記得同步這裡**：")[1].replace("\n"," ").strip()
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        ls[k]="| 月度回顧總覽卡|"+b+"——完整契約"+l.split("——完整契約")[1]; break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'G. 無空白分隔符＋整段規則貼回索引' 紅

python3 - <<'PY'
import pathlib
ct=pathlib.Path("docs/contracts/前端功能.md").read_text(encoding="utf-8")
i=ct.index("## 月度回顧總覽卡"); j=ct.index("\n## ", i)
b=ct[i:j].split("**記得同步這裡**：")[1].replace("\n"," ").strip()
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        ls[k]="| 月度回顧總覽卡 | 前半\\|後半"+b+"——完整契約"+l.split("——完整契約")[1]; break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'H. 用跳脫的直線藏在同一格＋貼回全文' 紅

python3 - <<'PY'
import pathlib
ct=pathlib.Path("docs/contracts/前端功能.md").read_text(encoding="utf-8")
i=ct.index("## 月度回顧總覽卡"); j=ct.index("\n## ", i)
b=ct[i:j].split("**記得同步這裡**：")[1].replace("\n"," ").strip()
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        ls[k]="| 月度回顧總覽卡 | 短摘要——完整契約（假的）"+b+"——完整契約"+l.split("——完整契約")[1]; break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'I. 先放假 marker 再貼回全文（切第一個會漏）' 紅

python3 - <<'PY'
import pathlib,re
p=pathlib.Path("AGENTS.md")
p.write_text(re.sub(r'^\| \*\*SEC 最新單季逐列期間\*\*.*\n','',p.read_text(encoding="utf-8"),flags=re.M), encoding="utf-8")
PY
check 'J. 刪掉「最新單季」那條索引（原豁免項）' 紅

python3 - <<'PY'
import pathlib,re
p=pathlib.Path("docs/contracts/收支記帳與匯入.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 店家消費檔案")
p.write_text(s[:i]+s[i:].replace("**記得同步這裡**：","**同步**："), encoding="utf-8")
q=pathlib.Path("AGENTS.md")
q.write_text(re.sub(r'^\| \*\*店家消費檔案\*\*.*\n','',q.read_text(encoding="utf-8"),flags=re.M), encoding="utf-8")
PY
check 'K. marker 與索引一起刪（雙向斷言的核心）' 紅

rm -f docs/contracts/前端功能.md
check 'L. 整份契約檔刪掉' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("test/contract-split.test.js")
p.write_text(p.read_text(encoding="utf-8").replace("      '月度回顧總覽卡',\n",""), encoding="utf-8")
PY
check 'M. 從 manifest 偷偷拿掉一條規則' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        ls.insert(k+1, l.replace(" | ","|").replace("(docs/contracts/","(./docs/contracts/")); break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check 'N. AGENTS 多一條等價的重複索引列' 紅

# ── 路由表 ──

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 收支記帳與匯入")
s=s[:i]+"|前端功能（重複且錯誤）|（沒有任何責任檔）|[前端功能.md](./前端功能.md)|\n"+s[i:]
p.write_text(s, encoding="utf-8")
PY
check 'O. 同一份契約多出一條矛盾路由列' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); t=p.read_text(encoding="utf-8")
assert t.count("`public/modules/portfolio-symbol.js`")==1
p.write_text(t.replace("`public/modules/portfolio-symbol.js`","`portfolio-symbol.js`",1), encoding="utf-8")
PY
check 'P. 路由表用短檔名冒充完整路徑' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.replace("[前端功能.md](前端功能.md)","[前端功能.md](docs/contracts/前端功能.md)",1), encoding="utf-8")
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
