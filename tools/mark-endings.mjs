import { readFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

// 给「结局类」文件末尾打标记：BAD END / ENDING（？） / TRUE END
// 集合推导：终点文件（路由为空）− 参考文件（证物栏、图鉴快照等）− 两个结局 = 坏结局
const root = resolve(import.meta.dirname, "..");
const pkg = join(root, "游戏包");
const idx = JSON.parse(readFileSync(join(root, "主持人", "路线索引.json"), "utf8"));
const rep = JSON.parse(readFileSync(join(root, "主持人", "构建报告.json"), "utf8"));
const routes = idx["路由"] || {};
const refs = new Set(rep.referenceFiles || []);

// 两个结局文件放在**本机配置**里（「哪一场是结局」属于剧透 ⇒ 不进公开仓库）：主持人/结局标记.json
const endingsPath = join(root, "主持人", "结局标记.json");
if (!existsSync(endingsPath)) {
  console.error("缺 主持人/结局标记.json —— 这份本机配置带着剧透、不入库；没有它会把两个结局误判成坏结局，所以这里直接停。");
  process.exit(2);
}
const ENDINGS = JSON.parse(readFileSync(endingsPath, "utf8"));
const BE_NOTE = "这条线到此为止。主持人会把你送回那个选择——记住它，但不必把它当成主线。";

function marker(label, note) { return "\n---\n\n> **" + label + "**（" + note + "）\n"; }

const endingFiles = new Set(ENDINGS.map(e => e.file));
const terminal = Object.entries(routes).filter(([, v]) => !v["继续"] && !v["选项"]).map(([k]) => k);
const badEnds = terminal.filter(t => !refs.has(t) && !endingFiles.has(t));

let marked = 0, skipped = 0, missing = 0;
const apply = (rel, label, note) => {
  const abs = join(root, rel);
  if (!existsSync(abs)) { console.error("⚠ 找不到文件：" + rel); missing++; return; }
  const text = readFileSync(abs, "utf8");
  if (text.includes("**" + label + "**")) { skipped++; return; }
  appendFileSync(abs, marker(label, note), "utf8");
  marked++;
};

for (const e of ENDINGS) apply(e.file, e.label, e.note);
for (const f of badEnds) apply(f, "BAD END", BE_NOTE);

console.log(JSON.stringify({
  坏结局: badEnds.length, 结局: ENDINGS.length,
  新打标记: marked, 已有标记跳过: skipped, 文件缺失: missing,
  一周目坏结局: badEnds.filter(f => f.includes("一周目")).length,
  二周目坏结局: badEnds.filter(f => f.includes("二周目")).length,
}, null, 1));
if (process.argv.includes("--list")) for (const f of badEnds) console.log("  " + f);