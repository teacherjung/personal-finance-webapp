"""從 hook 指令的 python 原始碼取出 ALLOW 白名單的字面值（fail-closed）。

判準（Codex #540 r4 M1 起、r5 M1 收斂）：`ALLOW` 這個名字在整份原始碼裡
**恰好只能被綁定一次，而且那一次必須是純字串字面 tuple**。

⚠️ r5 M1 的教訓：原本逐一列舉「Assign／AugAssign／for」這些節點型別，
於是**帶型別註記的再綁定**（AnnAssign）整型漏掉——實測可以把名單外的工具
悄悄加進有效白名單而考題全綠。列舉綁定形式補不完，改成**數綁定本身**：
python 的所有綁定最終都是 `Name` 節點帶 `Store` 情境，另加三種不經 Name 的
形式（`import … as ALLOW`、函式參數叫 ALLOW、`global/nonlocal ALLOW`）。
任何一種讓計數不等於 1，一律回 error＝考題轉紅。

輸出 JSON：{"items": [...]} 或 {"error": "..."}。
"""
import ast
import json
import sys

src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"error": f"指令不是合法 python：{e}"}, ensure_ascii=False))
    sys.exit(0)

# ① 所有「把值綁到 ALLOW」的地方——數綁定，不列舉語法形式。
stores = [
    n for n in ast.walk(tree)
    if isinstance(n, ast.Name) and n.id == "ALLOW" and isinstance(n.ctx, ast.Store)
]
# ② 不經 Name 節點的三種綁定形式。
for n in ast.walk(tree):
    if isinstance(n, ast.alias) and (n.asname or n.name.split(".")[0]) == "ALLOW":
        stores.append(n)
    elif isinstance(n, ast.arg) and n.arg == "ALLOW":
        stores.append(n)
    elif isinstance(n, (ast.Global, ast.Nonlocal)) and "ALLOW" in n.names:
        stores.append(n)
if len(stores) != 1:
    print(json.dumps({"error": f"ALLOW 被綁定 {len(stores)} 次，期望恰一次"}, ensure_ascii=False))
    sys.exit(0)

# ③ 那唯一一次必須是「單一目標的賦值」，且右邊是純字串字面 tuple。
target = stores[0]
value = None
for n in ast.walk(tree):
    if isinstance(n, ast.Assign) and len(n.targets) == 1 and n.targets[0] is target:
        value = n.value
    elif isinstance(n, ast.AnnAssign) and n.target is target:
        value = n.value
if value is None:
    print(json.dumps({"error": "ALLOW 那一次綁定不是單一目標的賦值"}, ensure_ascii=False))
    sys.exit(0)
if not isinstance(value, ast.Tuple) or not value.elts or not all(
    isinstance(e, ast.Constant) and isinstance(e.value, str) for e in value.elts
):
    print(json.dumps({"error": "ALLOW 不是非空的純字串字面 tuple"}, ensure_ascii=False))
    sys.exit(0)

print(json.dumps({"items": [e.value for e in value.elts]}, ensure_ascii=False))
