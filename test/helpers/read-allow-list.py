"""從 hook 指令的 python 原始碼取出 ALLOW 白名單的字面值（fail-closed）。

判準（Codex #540 r4→r7 三度收斂）：`ALLOW` 這個名字在整份原始碼裡**恰好只能出現兩次**
——一次是那個字面 tuple 的賦值目標，一次是 `tool not in ALLOW` 的讀取。

⚠️ 為什麼是「數名字」而不是「列舉綁定形式」（r5、r7 各被打穿一次的教訓）：
  r4 版列舉 Assign／AugAssign／for ⇒ 漏掉 AnnAssign（帶型別註記的再綁定）。
  r5 版改成「Name(Store) 加三種例外」⇒ 仍漏掉 except…as、match capture／star、
  函式／類別名稱、wildcard import——那些綁定不走 Name 節點。
  列舉補不完（本 repo 的老教訓）。改成**遍歷每個 AST 節點的每個欄位**，
  凡是字串欄位的值等於 "ALLOW" 就計數——不管它是哪一種節點的哪一個欄位。
  這樣新的語法形式出現時，判準自動涵蓋（多一處綁定＝多一次出現＝計數不等於 2＝紅）。
  另外單獨擋 `from … import *`：它不含 "ALLOW" 字面，卻能把名字帶進來。

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

# ① wildcard import 能把名字帶進來卻不留下 "ALLOW" 字面——單獨擋。
for node in ast.walk(tree):
    if isinstance(node, ast.ImportFrom) and any(a.name == "*" for a in node.names):
        print(json.dumps({"error": "指令含 wildcard import，無法確定 ALLOW 的來源"}, ensure_ascii=False))
        sys.exit(0)

# ② 數「ALLOW 這個名字」在整棵樹的每個欄位出現幾次——不列舉節點型別。
occurrences = 0
for node in ast.walk(tree):
    for _field, value in ast.iter_fields(node):
        if isinstance(value, str):
            occurrences += value == "ALLOW"
        elif isinstance(value, list):
            occurrences += sum(1 for v in value if isinstance(v, str) and v == "ALLOW")
if occurrences != 2:
    print(json.dumps(
        {"error": f"ALLOW 這個名字出現 {occurrences} 次，期望恰兩次（一次賦值目標、一次讀取）"},
        ensure_ascii=False))
    sys.exit(0)

# ③ 那兩次必須恰好是「一個 Store 目標」與「一個 Load 讀取」。
stores = [n for n in ast.walk(tree)
          if isinstance(n, ast.Name) and n.id == "ALLOW" and isinstance(n.ctx, ast.Store)]
loads = [n for n in ast.walk(tree)
         if isinstance(n, ast.Name) and n.id == "ALLOW" and isinstance(n.ctx, ast.Load)]
if len(stores) != 1 or len(loads) != 1:
    print(json.dumps(
        {"error": f"ALLOW 的用法不是「恰一次賦值＋恰一次讀取」（store={len(stores)} load={len(loads)}）"},
        ensure_ascii=False))
    sys.exit(0)

# ④ 那一次賦值必須是單一目標，右值是非空的純字串字面 tuple。
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
