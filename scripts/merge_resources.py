#!/usr/bin/env python3
"""把新增的默认资源补进现有 resources.json，不覆盖人工改过的条目。

用法：merge_resources.py <现有文件> <默认文件>

只有 defaults_version 落后时才补缺失资源；版本已经相同就完全不动，
这样管理员删掉某个默认资源后，再次 make auth 不会把它重新加回来。
"""
import json
import sys

existing_path, defaults_path = sys.argv[1], sys.argv[2]
with open(defaults_path, encoding="utf-8") as f:
    defaults_doc = json.load(f)
defaults = defaults_doc["resources"]
default_version = int(defaults_doc.get("defaults_version", 1))

try:
    with open(existing_path, encoding="utf-8") as f:
        existing = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    existing = {"resources": {}, "defaults_version": 0}

version = int(existing.get("defaults_version", 0))
if version >= default_version:
    print("auth: resources.json 已是最新（defaults_version " + str(version) + "）")
    sys.exit(0)

resources = existing.setdefault("resources", {})
added = []
for name, meta in defaults.items():
    if name not in resources:
        resources[name] = meta
        added.append(name)
existing["defaults_version"] = default_version

with open(existing_path, "w", encoding="utf-8") as f:
    json.dump(existing, f, ensure_ascii=False, indent=2)
    f.write("\n")
if added:
    print("auth: resources.json 补齐 " + ", ".join(added))
else:
    print("auth: resources.json 已是 v" + str(default_version) + "，无需补条目")
