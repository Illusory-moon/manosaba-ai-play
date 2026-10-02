"""只读探针：把每个剧本里「事件插画（CG）」的出现顺序抠出来。

用法（PYTHONPATH 指向本地 UnityPy）：
  $env:PYTHONPATH='E:\manosaba\.cache\unitypy'
  python tools\probe-stills.py '<游戏 StreamingAssets\aa\StandaloneWindows64>' 'act01_chapter02' '.cache\still-map-act01.json'

判据：游戏里的 CG 是挂在演员 Id="Stills" 上的 ModifyBackgroundExtended / ModifyCharacterExtended，
Appearance 就是插画（如 421_5）。同一个剧本里连着换好几张 = 「凶手自述手法」那一格的典型特征。
输出 JSON：{剧本名: {n: 换图次数, distinct: 不同插画数, run: 同系列最长连击, seq: [[lineIndex, 插画], ...]}}
第三个参数省略时只打印不落盘。
"""
import json, sys
from pathlib import Path
import UnityPy


def value(field, default=""):
    if not isinstance(field, dict) or not field.get("hasValue"):
        return default
    result = field.get("value", default)
    if isinstance(result, dict) and "name" in result:
        return value(result["name"], default)
    return result


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    bundle_dir, only = Path(sys.argv[1]), sys.argv[2]
    out = {}
    for bundle in sorted(bundle_dir.glob("naninovel-scripts*" + only + "*.bundle")):
        environment = UnityPy.load(str(bundle))
        for obj in environment.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            tree = obj.read_typetree()
            name = tree.get("m_Name", "")
            if not (name.startswith(("Act01_Chapter", "Act02_Chapter")) or name.startswith("CommonBad")):
                continue
            refs = {item["rid"]: item for item in tree["references"]["RefIds"]}
            seq = []
            for command in tree["playlist"]["commands"]:
                item = refs.get(command["rid"])
                if not item:
                    continue
                data = item["data"]
                if value(data.get("Id")) != "Stills":
                    continue
                appearance = value(data.get("AppearanceAndTransition")) or value(data.get("Appearance"))
                if not appearance:
                    continue
                seq.append([(data.get("playbackSpot") or {}).get("lineIndex"), appearance])
            if not seq:
                continue
            apps = [item[1] for item in seq]
            best = run = 1
            for i in range(1, len(apps)):
                run = run + 1 if apps[i].split("_")[0] == apps[i - 1].split("_")[0] else 1
                best = max(best, run)
            out[name] = {"n": len(seq), "distinct": len(set(apps)), "run": best, "seq": seq}
    if len(sys.argv) > 3:
        Path(sys.argv[3]).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    for name, stats in sorted(out.items(), key=lambda kv: -kv[1]["run"]):
        if stats["run"] >= 3 or stats["distinct"] >= 5:
            print(f'{name}  n={stats["n"]} distinct={stats["distinct"]} run={stats["run"]}')
    print("scripts with stills:", len(out))


if __name__ == "__main__":
    main()
