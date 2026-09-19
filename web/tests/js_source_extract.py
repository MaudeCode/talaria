def extract_function(js: str, name: str, prefix: str = "function") -> str:
    marker = f"{prefix} {name}("
    start = js.find(marker)
    assert start >= 0, f"{name} function not found in static/panels.js"
    # Skip the parameter list before looking for the body brace: a default
    # argument (`opts={}`) otherwise looks like the opening brace and truncates
    # the extraction to the signature.
    paren = js.find("(", start)
    assert paren >= 0, f"{name} parameter list not found"
    depth = 1
    i = paren + 1
    while i < len(js) and depth > 0:
        if js[i] == "(":
            depth += 1
        elif js[i] == ")":
            depth -= 1
        i += 1
    assert depth == 0, f"{name} parameter list unbalanced"
    brace = js.find("{", i)
    assert brace >= 0, f"{name} opening brace not found"
    depth = 1
    in_string = None
    escaped = False
    in_line_comment = False
    in_block_comment = False
    i = brace + 1
    while i < len(js) and depth > 0:
        ch = js[i]
        nxt = js[i + 1] if i + 1 < len(js) else ""
        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
        elif in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 1
        elif in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = None
        elif ch == "/" and nxt == "/":
            in_line_comment = True
            i += 1
        elif ch == "/" and nxt == "*":
            in_block_comment = True
            i += 1
        elif ch in ("'", '"', "`"):
            in_string = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    assert depth == 0, f"{name} function braces unbalanced"
    return js[start:i]
