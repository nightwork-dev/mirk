extends SceneTree

func _initialize() -> void:
	var data = load("res://addons/mirk_data/data.gd")
	var cases = JSON.parse_string(FileAccess.get_file_as_string(OS.get_cmdline_user_args()[0]))
	var count := 0
	for c in cases["overlay"]:
		assert(data.merge_overlay(c["base"], c["over"]) == c["expected"])
		count += 1
	for c in cases["layers"]:
		assert(data.merge_layers(c["base"], c["over"], c["appendKeys"]) == c["expected"])
		count += 1
	for c in cases["set"]:
		var value = c["data"].duplicate(true)
		for key in c.get("integerKeys", []):
			value[key] = int(value[key])
			c["expected"][key] = int(c["expected"][key])
		assert(data.set_at(value, c["path"], c["value"]) == c["ok"])
		if value != c["expected"]:
			printerr("SET MISMATCH ", c, " actual=", value)
			quit(1)
			return
		count += 1
	for c in cases["find"]:
		var span: Vector2i = data.find_value(c["text"], c["path"])
		assert(span == Vector2i(int(c["expected"][0]), int(c["expected"][1])))
		count += 1
	for c in cases["numbers"]:
		assert(data.number_text(c["original"], c["value"]) == c["expected"])
		count += 1
	print("MIRK_AUTHORED_DATA cases=", count, " mismatches=0 max_difference=0")
	quit()
