"""从正版游戏的 Naninovel AssetBundle 提取演出时间轴。"""

import json
import re
import sys
from pathlib import Path

import UnityPy


def value(field, default=""):
    if not isinstance(field, dict) or not field.get("hasValue"):
        return default
    result = field.get("value", default)
    if isinstance(result, dict) and "name" in result:
        return value(result["name"], default)
    return result


def text_id(data):
    parts = data.get("Text", {}).get("value", {}).get("parts", [])
    return parts[0].get("id", "") if parts else ""


def line_index(data):
    return data.get("playbackSpot", {}).get("lineIndex")


def image_command(kind, data):
    actor = value(data.get("Id"))
    appearance = value(data.get("AppearanceAndTransition")) or value(data.get("Appearance"))
    path = value(data.get("Path"))
    if not appearance and not path:
        return None
    return {
        "type": "command",
        "command": kind,
        "params": {"actor": actor, "appearance": appearance, "path": path},
        "lineIndex": line_index(data),
    }


def extract_script(tree):
    refs = {item["rid"]: item for item in tree["references"]["RefIds"]}
    lines = []
    for command in tree["playlist"]["commands"]:
        item = refs.get(command["rid"])
        if not item:
            continue
        kind, data = item["type"]["class"], item["data"]
        if kind in {"PrintText", "PrintTextModified"}:
            lines.append({"type": "text", "text": text_id(data), "lineIndex": line_index(data)})
        elif kind == "SetBadId":
            lines.append({
                "type": "bad-end-id",
                "id": value(data.get("CommonBadEndId"), 0),
                "lineIndex": line_index(data),
            })
        elif kind in {"SpawnExtended", "DestroySpawnedExtended"}:
            actor = value(data.get("Path"))
            if actor.startswith("Reenact_"):
                lines.append({
                    "type": "reenact",
                    "actor": actor,
                    "spawn": kind == "SpawnExtended",
                    "lineIndex": line_index(data),
                })
        elif kind == "ChoiceEvidence":
            # 审判里的「清单」：游戏弹出你此刻已解锁的证物/人物档案，唯一正确的 id 就在这条命令里。
            categories = [value(entry) for entry in (value(data.get("CategoryNames"), []) or [])]
            lines.append({
                "type": "choice-evidence",
                "categories": [item for item in categories if item],
                "correct": value(data.get("CorrectEvidenceId")),
                "lineIndex": line_index(data),
            })
        elif kind == "UpdateWitchBook":
            lines.append({
                "type": "witchbook",
                "category": value(data.get("Category")),
                "id": value(data.get("Id")),
                "version": value(data.get("Version"), 0),
                "lineIndex": line_index(data),
            })
        elif "Background" in kind or "Layered" in kind or "CutIn" in kind:
            image = image_command(kind, data)
            if image:
                lines.append(image)
    return {"id": tree["m_Name"], "type": "local-bundle", "lines": lines}


def localized(field, locale=2):
    """取本地化文本：优先简体中文，其次第一条非空。"""
    if not isinstance(field, list):
        return ""
    for entry in field:
        if entry.get("_locale") == locale and entry.get("_text"):
            return entry["_text"]
    for entry in field:
        if entry.get("_text"):
            return entry["_text"]
    return ""


def extract_witchbook(bundle_dir, output_dir):
    """提取魔女图鉴条目：规定、记录、证物、人物档案，按版本保存。"""
    path = bundle_dir / "general-data_assets_all.bundle"
    if not path.exists():
        return 0
    environment = UnityPy.load(str(path))
    data = {}
    for obj in environment.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        name = tree.get("m_Name", "")
        if name not in ("NoteData", "RuleData", "ClueData", "ProfileData"):
            continue
        items = {}
        for entry in tree.get("_items", []):
            fields = {key.lstrip("_"): localized(field) for key, field in (entry.get("_item") or {}).items()}
            items.setdefault(str(entry.get("_id", "")), {})[str(entry.get("_version", 1))] = fields
        data[name[:-4] if name.endswith("Data") else name] = items
    (output_dir / "witchbook.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return sum(len(items) for items in data.values())


def extract_reenact(bundle_dir, output_dir):
    """审判收尾的「再現」演出：prefab 名 → 底图 sprite 名。"""
    path = bundle_dir / "naninovel-spawn_assets_all.bundle"
    if not path.exists():
        return 0
    environment = UnityPy.load(str(path))
    objects = {}
    for obj in environment.objects:
        try:
            objects[obj.path_id] = (obj.type.name, obj.read_typetree())
        except Exception:
            continue
    sprites = {pid: tree.get("m_Name", "") for pid, (kind, tree) in objects.items() if kind == "Sprite"}
    children, owner, component_of = {}, {}, {}
    for pid, (kind, tree) in objects.items():
        if kind not in ("Transform", "RectTransform"):
            continue
        go = (tree.get("m_GameObject") or {}).get("m_PathID")
        owner[pid] = go
        component_of.setdefault(go, []).append(pid)
        father = (tree.get("m_Father") or {}).get("m_PathID")
        if father:
            children.setdefault(father, []).append(pid)
    renderer_sprites = {}
    for pid, (kind, tree) in objects.items():
        if kind != "SpriteRenderer":
            continue
        go = (tree.get("m_GameObject") or {}).get("m_PathID")
        sprite = (tree.get("m_Sprite") or {}).get("m_PathID")
        if go and sprite in sprites:
            renderer_sprites.setdefault(go, []).append(sprites[sprite])
    prefabs = {}
    for pid, (kind, tree) in objects.items():
        if kind != "AssetBundle":
            continue
        for pair in (tree.get("m_Container") or []):
            entry = pair[0]
            if "Reenactment" not in entry:
                continue
            name = entry.rsplit("/", 1)[-1].replace(".prefab", "")
            prefabs[name] = (pair[1].get("asset") or {}).get("m_PathID")
    result = {}
    for name, root in prefabs.items():
        stack, seen, found = [root], set(), []
        while stack:
            go = stack.pop()
            if not go or go in seen:
                continue
            seen.add(go)
            found += renderer_sprites.get(go, [])
            for component in component_of.get(go, []):
                for child in children.get(component, []):
                    stack.append(owner.get(child))
        art = sorted(item for item in found if "kari" in item.lower())
        if art:
            result[name] = art[0]
    (output_dir / "reenact.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return len(result)


def initial_records(tree):
    """开局就装在手机里的图鉴内容：System_ResetWitchBook 里首个 Gosub 之前的解锁记录。"""
    refs = {item["rid"]: item for item in tree["references"]["RefIds"]}
    records = []
    for command in tree["playlist"]["commands"]:
        item = refs.get(command["rid"])
        if not item:
            continue
        kind, data = item["type"]["class"], item["data"]
        if kind == "Gosub":
            break
        if kind == "UpdateWitchBook":
            records.append({
                "category": value(data.get("Category")),
                "id": value(data.get("Id")),
                "version": value(data.get("Version"), 0),
            })
    return records


def main():
    if len(sys.argv) != 3:
        raise SystemExit("用法: extract-local-story.py <StandaloneWindows64目录> <输出目录>")
    bundle_dir, output_dir = map(Path, sys.argv[1:])
    output_dir.mkdir(parents=True, exist_ok=True)
    scripts = commands = 0
    initial = []
    for bundle in sorted(bundle_dir.glob("naninovel-scripts*.bundle")):
        environment = UnityPy.load(str(bundle))
        for obj in environment.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            tree = obj.read_typetree()
            name = tree.get("m_Name", "")
            if name == "System_ResetWitchBook":
                initial = initial_records(tree)
                continue
            if not (name.startswith(("Act01_Chapter", "Act02_Chapter")) or re.fullmatch(r"CommonBad\d+", name)):
                continue
            story = extract_script(tree)
            chapter = "Common" if name.startswith("CommonBad") else "_".join(name.split("_")[:2])
            target = output_dir / chapter / f"{name}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(story, ensure_ascii=False, indent=2), encoding="utf-8")
            scripts += 1
            commands += len(story["lines"])
    witchbook = extract_witchbook(bundle_dir, output_dir)
    (output_dir / "witchbook-initial.json").write_text(json.dumps(initial, ensure_ascii=False, indent=1), encoding="utf-8")
    reenact = extract_reenact(bundle_dir, output_dir)
    print(json.dumps({"scripts": scripts, "timelineEntries": commands, "witchbookEntries": witchbook, "initialRecords": len(initial), "reenactPrefabs": reenact, "output": str(output_dir)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
