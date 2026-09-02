import ast, json, sys
src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"error": f"指令不是合法 python：{e}"})); sys.exit(0)
binds = []
for node in ast.walk(tree):
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id == "ALLOW":
                binds.append(node.value)
            elif isinstance(t, (ast.Tuple, ast.List)):
                for el in t.elts:
                    if isinstance(el, ast.Name) and el.id == "ALLOW":
                        binds.append("非字面（拆包賦值）")
    elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == "ALLOW":
        binds.append("非字面（增量賦值）")
    elif isinstance(node, (ast.For, ast.comprehension)):
        tgt = getattr(node, "target", None)
        if isinstance(tgt, ast.Name) and tgt.id == "ALLOW":
            binds.append("非字面（迴圈綁定）")
if len(binds) != 1:
    print(json.dumps({"error": f"ALLOW 被綁定 {len(binds)} 次，期望恰一次"})); sys.exit(0)
v = binds[0]
if not isinstance(v, ast.Tuple) or not all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in v.elts):
    print(json.dumps({"error": "ALLOW 不是純字串字面 tuple"})); sys.exit(0)
print(json.dumps({"items": [e.value for e in v.elts]}, ensure_ascii=False))
