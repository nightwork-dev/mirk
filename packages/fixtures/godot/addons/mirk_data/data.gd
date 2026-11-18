## Engine-neutral authored JSON value, layering and text edits.
extends RefCounted

static func integral(value: Variant) -> Variant:
	if value is float and is_finite(value) and value == floorf(value) and absf(value) < 9007199254740992.0:
		return int(value)
	if value is Dictionary:
		var out := {}
		for key in value:
			out[key] = integral(value[key])
		return out
	if value is Array:
		return value.map(integral)
	return value

static func _ascii(text: String) -> String:
	var out := ""
	for i in text.length():
		var code := text.unicode_at(i)
		if code < 128:
			out += text[i]
		elif code < 0x10000:
			out += "\\u%04x" % code
		else:
			var v := code - 0x10000
			out += "\\u%04x\\u%04x" % [0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF)]
	return out

static func _skip_space(t: String, i: int) -> int:
	while i < t.length() and (t[i] == " " or t[i] == "\n" or t[i] == "\t" or t[i] == "\r"):
		i += 1
	return i

static func _value_end(t: String, i: int) -> int:
	var c := t[i]
	if c == "\"":
		var j := i + 1
		while j < t.length() and t[j] != "\"":
			j += 2 if t[j] == "\\" else 1
		return j + 1
	if c == "{" or c == "[":
		var close := "}" if c == "{" else "]"
		var j := _skip_space(t, i + 1)
		if t[j] == close:
			return j + 1
		while true:
			if c == "{":
				j = _value_end(t, j)         # the key
				j = _skip_space(t, j) + 1    # the colon
				j = _skip_space(t, j)
			j = _value_end(t, j)
			j = _skip_space(t, j)
			if t[j] == ",":
				j = _skip_space(t, j + 1)
				continue
			return j + 1
	var j2 := i
	while j2 < t.length() and not t[j2] in [",", "}", "]", " ", "\n", "\t", "\r"]:
		j2 += 1
	return j2

static func find_value(t: String, path: Array) -> Vector2i:
	var i := _skip_space(t, 0)
	for step in path:
		if t[i] == "{":
			var j := _skip_space(t, i + 1)
			var found := -1
			while t[j] != "}":
				var key_end := _value_end(t, j)
				var key := t.substr(j + 1, key_end - j - 2)
				var k := _skip_space(t, key_end) + 1
				k = _skip_space(t, k)
				if key == str(step):
					found = k
					break
				j = _skip_space(t, _value_end(t, k))
				if t[j] == ",":
					j = _skip_space(t, j + 1)
			if found < 0:
				return Vector2i(-1, -1)
			i = found
		elif t[i] == "[":
			var index := int(step)
			var j2 := _skip_space(t, i + 1)
			var n := 0
			var found2 := -1
			while t[j2] != "]":
				if n == index:
					found2 = j2
					break
				j2 = _skip_space(t, _value_end(t, j2))
				if t[j2] == ",":
					j2 = _skip_space(t, j2 + 1)
				n += 1
			if found2 < 0:
				return Vector2i(-1, -1)
			i = found2
		else:
			return Vector2i(-1, -1)
	return Vector2i(i, _value_end(t, i))

static func number_text(original: String, value: float) -> String:
	var float_style := original.contains(".") or original.contains("e") or original.contains("E")
	var v := snappedf(value, 0.000000001)
	if v == floorf(v) and absf(v) < 1.0e15:
		return ("%d.0" % int(v)) if float_style else ("%d" % int(v))
	return String.num(v)

static func diff(saved, live, path: Array, numbers: Array, others = null) -> void:
	if live is Dictionary and saved is Dictionary:
		for key in live:
			if saved.has(key): diff(saved[key], live[key], path + [key], numbers, others)
	elif live is Array and saved is Array and live.size() == saved.size():
		for i in live.size(): diff(saved[i], live[i], path + [i], numbers, others)
	elif (live is float or live is int) and (saved is float or saved is int):
		if not is_equal_approx(float(live), float(saved)): numbers.append({"path": path, "value": live})
	elif others != null and live != saved:
		others.append({"path": path, "value": live})

static func set_at(data: Variant, path: Variant, value: Variant) -> bool:
	var parts: Array = Array(str(path).split(".")) if path is String else path
	var at: Variant = data
	for i in parts.size():
		var last := i == parts.size() - 1
		if at is Array:
			var index := int(parts[i]) if parts[i] is int or str(parts[i]).is_valid_int() else -1
			if index < 0 or index >= at.size():
				return false
			if last:
				at[index] = value
				return true
			at = at[index]
		elif at is Dictionary:
			var key := str(parts[i])
			if last:
				at[key] = int(value) if at.get(key) is int and (value is int or value is float) else value
				return true
			if not at.has(key):
				at[key] = {}
			at = at[key]
		else:
			return false
	return false

static func merge_layers(base: Dictionary, over: Dictionary, append_keys: Array = []) -> Dictionary:
	var out: Dictionary = base.duplicate(true)
	for key in over:
		if key in append_keys:
			out[key] = out.get(key, []) + over[key].duplicate(true)
		elif over[key] is Dictionary and out.get(key) is Dictionary:
			out[key] = merge_layers(out[key], over[key], append_keys)
		else:
			out[key] = over[key] if not (over[key] is Dictionary or over[key] is Array) else over[key].duplicate(true)
	return out

static func merge_overlay(a: Variant, b: Variant) -> Variant:
	if a is Dictionary and b is Dictionary:
		var out: Dictionary = a.duplicate()
		for k in b:
			out[k] = merge_overlay(a[k], b[k]) if a.has(k) else b[k]
		return out
	if a is Array and b is Array:
		var ids := {}
		for x in b:
			if x is Dictionary and x.has("id"):
				ids[x["id"]] = true
		return a.filter(func(x): return not (x is Dictionary and ids.has(x.get("id")))) + b
	return b

static func at_path(node: Variant, path: Array) -> Variant:
	var at: Variant = node
	for step in path:
		if at is Dictionary and at.has(step):
			at = at[step]
		elif at is Array and (step is int or step is float) and int(step) >= 0 and int(step) < at.size():
			at = at[int(step)]
		else:
			return null
	return at

static func patch_number_text(text: String, edits: Array) -> Dictionary:
	for edit in edits:
		var span := find_value(text, edit["path"])
		if span.x < 0:
			return {"error": "has nothing at %s" % str(edit["path"])}
		text = text.substr(0, span.x) + number_text(text.substr(span.x, span.y - span.x), float(edit["value"])) + text.substr(span.y)
	return {"text": text, "error": ""}

static func put_text(text: String, path: Array, value: Variant, index := -2) -> Dictionary:
	var rendered := _ascii(JSON.stringify(integral(value), "  ", false))
	if index == -1:
		var arr := find_value(text, path)
		if arr.x < 0 or text[arr.x] != "[":
			return {"error": "has no list at %s" % str(path)}
		var close := arr.y - 1
		var line_start := text.rfind("\n", close) + 1
		var indent := ""
		var last := close - 1
		while last > arr.x and text[last] in [" ", "\n", "\t", "\r"]:
			last -= 1
		var element_line := text.rfind("\n", last) + 1
		while text[element_line] == " ":
			indent += " "
			element_line += 1
		rendered = rendered.replace("\n", "\n" + indent)
		text = text.substr(0, last + 1) + ",\n" + indent + rendered + text.substr(last + 1)
	else:
		var span := find_value(text, path)
		if span.x < 0:
			return {"error": "has nothing at %s" % str(path)}
		var line := text.rfind("\n", span.x) + 1
		var indent2 := ""
		var p := line
		while p < text.length() and text[p] == " ":
			indent2 += " "
			p += 1
		text = text.substr(0, span.x) + rendered.replace("\n", "\n" + indent2) + text.substr(span.y)
	return {"text": text, "error": ""}
