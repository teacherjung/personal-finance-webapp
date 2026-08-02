#!/bin/zsh
# 拆分護欄的突變表。
#
# ⚠️ 這支腳本本身出過事（Codex #384 r4 抓的，而且我親身踩過）：
#   ①它會 `git checkout --` 還原檔案 ⇒ **未 commit 的工作會被洗掉**（我洗掉過自己一輪的修改）
#   ②期望不符時只印 ⚠️、退出碼仍是 0 ⇒ 掛進任何自動化都是**永遠通過的假閘**
#   ③基準綠與收尾乾淨只是「印出來」，沒有真的斷言
# 所以現在：**工作樹不乾淨就拒跑**、**任何一條不如期望就退出碼 1**、基準與收尾都 assert。
set -u
cd "$(dirname "$0")"

fail=0

# ── 拒跑條件：工作樹必須乾淨（**沒有例外，本腳本自己也算**）──
# ⚠️ **不豁免自己**（Codex #384 r5 Medium）：原本排除 mutate.sh 自身的髒檔，
# 於是「只改這支腳本」時它不但不拒跑，還會跑完 exit 0 宣稱一切正常——
# 等於 harness 用**未提交的版本自我放行**。要改它就先 commit。
dirty=$(git status --porcelain || true)
if [[ -n "$dirty" ]]; then
  echo "❌ 工作樹不乾淨，拒絕執行——這支會 git checkout 還原檔案，會洗掉你未 commit 的工作："
  echo "$dirty"
  exit 2
fi

# ⚠️ **中止時也要還原**（2026-08-02 親身踩到）：Q 那條的標籤有語法錯誤，
# 腳本在突變已經寫進檔案之後才中止，**沒有還原**——而我接著就 commit 了，
# 於是突變被 commit 進 PR。腳本要能安全地被中斷。
restore() { git checkout -- AGENTS.md docs/contracts/ test/contract-split.test.js 2>/dev/null || true; }
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
  echo "❌ 基準就是紅的——突變結果全部無效（今晚實際發生過兩次）。先把基準修綠。"
  exit 2
fi

check() {   # check <說明> <期望：紅|綠>
  local got mark
  got=$(run)
  if [[ "$got" == "$2" ]]; then mark="  "; else mark="❌"; fail=1; fi
  printf "%s %-46s → %s（期望 %s）\n" "$mark" "$1" "$got" "$2"
  git checkout -- AGENTS.md docs/contracts/ test/contract-split.test.js 2>/dev/null || true
}

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡"); j=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"<!--\n"+s[i:j]+"\n-->\n"+s[j:], encoding="utf-8")
PY
check "A. 整段契約包進 HTML 註解" 紅

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
check "B. 無空白分隔符＋整段規則貼回索引" 紅

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
check "B2. 用跳脫的 \\| 藏在同一格＋貼回全文" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡"); j=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"```\n"+s[i:j]+"\n```\n"+s[j:], encoding="utf-8")
PY
check "B3. 整段契約包進 code fence" 紅

python3 - <<'PY'
import pathlib,re
p=pathlib.Path("AGENTS.md")
p.write_text(re.sub(r'^\| \*\*SEC 最新單季逐列期間\*\*.*\n','',p.read_text(encoding="utf-8"),flags=re.M), encoding="utf-8")
PY
check "C. 刪掉「最新單季」那條索引（原豁免項）" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 投資與 SEC"); j=s.index("\n", i)
p.write_text(s[:i]+"<!-- "+s[i:j]+" -->"+s[j:], encoding="utf-8")
PY
check "D. 整條路由列包進 HTML 註解" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); t=p.read_text(encoding="utf-8")
assert t.count("`public/modules/portfolio-symbol.js`")==1
p.write_text(t.replace("`public/modules/portfolio-symbol.js`","`portfolio-symbol.js`",1), encoding="utf-8")
PY
check "E. 路由表用短檔名冒充完整路徑" 紅

python3 - <<'PY'
import pathlib,re
p=pathlib.Path("docs/contracts/收支記帳與匯入.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 店家消費檔案")
p.write_text(s[:i]+s[i:].replace("**記得同步這裡**：","**同步**："), encoding="utf-8")
q=pathlib.Path("AGENTS.md")
q.write_text(re.sub(r'^\| \*\*店家消費檔案\*\*.*\n','',q.read_text(encoding="utf-8"),flags=re.M), encoding="utf-8")
PY
check "F. marker 與索引一起刪（r2 的假綠）" 紅

rm -f docs/contracts/前端功能.md
check "G. 整份契約檔刪掉" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("test/contract-split.test.js")
p.write_text(p.read_text(encoding="utf-8").replace("      '月度回顧總覽卡',\n",""), encoding="utf-8")
PY
check "H. 從 manifest 偷偷拿掉一條規則" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 收支記帳與匯入")
s=s[:i]+"| 前端功能（重複且錯誤） | （沒有任何責任檔） | [前端功能.md](前端功能.md) |\n"+s[i:]
p.write_text(s, encoding="utf-8")
PY
check "I. 同一份契約多出一條矛盾路由列" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡"); j=s.index("## 訂閱續費日自動推進")
p.write_text(s[:i]+"~~~\n"+s[i:j]+"\n~~~\n"+s[j:], encoding="utf-8")
PY
check "J. 整段契約包進 ~~~ fence（另一種合法 fence）" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
i=s.index("| 收支記帳與匯入")
s=s[:i]+"|前端功能（重複且錯誤）|（沒有任何責任檔）|[前端功能.md](./前端功能.md)|\n"+s[i:]
p.write_text(s, encoding="utf-8")
PY
check "K. 無空格表格列＋相對路徑連結的重複路由" 紅

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
check "L. 先放假 marker 再貼回全文（切第一個會漏）" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"~~~\n"+s[i:], encoding="utf-8")   # 只開不關
PY
check "M. 忘記關 fence（正常手滑，後面整份變程式碼）" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/README.md"); s=p.read_text(encoding="utf-8")
p.write_text(s.replace("[前端功能.md](前端功能.md)","[前端功能.md](docs/contracts/前端功能.md)",1), encoding="utf-8")
PY
check "N. README 連結誤用 repo-root 路徑（連到不存在）" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("AGENTS.md"); ls=p.read_text(encoding="utf-8").split("\n")
for k,l in enumerate(ls):
    if l.startswith("| 月度回顧總覽卡 |"):
        dup=l.replace(" | ","|").replace("(docs/contracts/","(./docs/contracts/")
        ls.insert(k+1, dup); break
p.write_text("\n".join(ls), encoding="utf-8")
PY
check "O. AGENTS 多一條等價的重複索引列" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
p.write_text(s[:i]+"  ~~~\n"+s[i:], encoding="utf-8")   # CommonMark 允許 1–3 個前置空格，且只開不關
PY
check "P. 縮排的 fence＋忘記關（合法縮排的手滑）" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
# 用四個 backtick 開、三個收——CommonMark 規定關的不能比開的短，所以其實沒關到
p.write_text(s[:i]+"````markdown\n範例內容\n```\n\n"+s[i:], encoding="utf-8")
PY
check 'Q. 四個反引號開、三個收（關的比開的短＝沒關到）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
# 合法的成對 fence：不該被誤擋
p.write_text(s[:i]+"```text\n這是正常的程式碼範例\n```\n\n"+s[i:], encoding="utf-8")
PY
check "R. 正常成對的 fence（誤紅檢查）" 綠

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
# 關 fence 後面貼到一個 NBSP（U+00A0）——CommonMark 認為沒關到，JS 的 trim() 卻會吃掉它
p.write_text(s[:i]+"```text\n範例\n``` \n\n"+s[i:], encoding="utf-8")
PY
check 'S. 關 fence 後面有 NBSP（複製貼上就會發生）' 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/前端功能.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 月度回顧總覽卡")
# 依 CommonMark，反引號 fence 的 info string 不可含反引號 → 這一行是行內 code，不是 fence
p.write_text(s[:i]+"``` aa ```\n\n"+s[i:], encoding="utf-8")
PY
check 'T. 行首的行內 code（不是 fence，誤紅檢查）' 綠

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
