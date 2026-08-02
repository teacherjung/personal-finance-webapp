#!/bin/zsh
# 拆分護欄的突變表。**每一步都先驗基準**，因為今晚已經有兩次 harness 自己壞掉
# （一次永遠紅、一次永遠綠）——一個永遠同色的突變表和沒有突變表一樣沒用。
set -e
cd "$(dirname "$0")"

run() {
  if node --test --test-reporter=dot test/contract-split.test.js >/dev/null 2>&1; then
    echo "🟢 綠"
  else
    echo "🔴 紅"
  fi
}

check() {   # check <說明> <期望：紅|綠>
  local got
  got=$(run)
  local mark="  "
  [[ "$got" == *"$2"* ]] || mark="⚠️"
  printf "%s %-44s → %s（期望 %s）\n" "$mark" "$1" "$got" "$2"
  git checkout -- AGENTS.md docs/contracts/ test/contract-split.test.js 2>/dev/null || true
}

printf "   %-44s → %s\n" "0. 未突變（基準）" "$(run)"

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
p=pathlib.Path("docs/contracts/README.md")
t=p.read_text(encoding="utf-8")
assert t.count("`public/modules/portfolio-symbol.js`")==1
p.write_text(t.replace("`public/modules/portfolio-symbol.js`","`portfolio-symbol.js`",1), encoding="utf-8")
PY
check "E. 路由表用短檔名冒充完整路徑" 紅

python3 - <<'PY'
import pathlib
p=pathlib.Path("docs/contracts/收支記帳與匯入.md"); s=p.read_text(encoding="utf-8")
i=s.index("## 店家消費檔案"); j=len(s)
p.write_text(s[:i]+s[i:j].replace("**記得同步這裡**：","**同步**："), encoding="utf-8")
q=pathlib.Path("AGENTS.md"); import re
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

echo "--- 工作樹（應為空）---"
git status --short
