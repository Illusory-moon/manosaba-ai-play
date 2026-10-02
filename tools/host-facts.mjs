#!/usr/bin/env node
// 主持人用的「能力口径卡」（v3）：源＝冻结的 游戏包/ 里的【魔女图鉴·档案/记录/规定】块，
// 归因来自块头（如 【魔女图鉴·档案】雪莉（更新）），不靠正文散文猜。
// 用法: node tools/host-facts.mjs narrow <游戏包内文件> | full
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const pkg = join(root, "游戏包");
const logPath = join(root, "主持人", "主持日志.md");
const TOPICS = ["钥匙", "门锁", "上锁", "围墙", "魔女化", "时间"];
const MAX_CHARS = 6, PER_CHAR = 3, MAX_TOPIC = 3;
function walk(dir, out) {
  out = out || [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(root.length + 1).split("\\").join("/");
const read = (p) => readFileSync(p, "utf8");
const logText = existsSync(logPath) ? read(logPath) : "";
function sentDocFor(p) {
  const m = rel(p).match(/^游戏包\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)\.md$/);
  if (!m) return null;
  return join(root, "record", m[1], m[2], "体验-" + m[4] + ".md");
}
const isSent = (p) => logText.includes(rel(p)) || (sentDocFor(p) ? existsSync(sentDocFor(p)) : false);
function orderKey(p) {
  const r = rel(p);
  const ch = (r.match(/第(\d+)章/) || [0, "99"])[1];
  const kind = r.includes("魔女审判") ? 1 : 0;
  const n = (r.match(/(?:场景|审判)-(\d+)/) || [0, "0"])[1];
  return [r.split("/")[1], ch, kind, String(n).padStart(3, "0"), r].join("|");
}
const allFiles = walk(pkg).sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1));
const sentFiles = allFiles.filter(isSent);
function blocksOf(p) {
  const lines = read(p).split(/\r?\n/);
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith("<!--")) { if (cur) { out.push(cur); cur = null; } continue; }
    const t2 = t.replace(/^\*+/, "").replace(/\*+$/, "");
    const m = t2.match(/^【魔女图鉴·([^】]+)】(.*)$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { cat: m[1], name: (m[2] || "").replace(/（更新）/g, "").trim(), text: [], source: rel(p) + ":" + (i + 1) };
      continue;
    }
    if (cur) cur.text.push(t.replace(/^[>*-]+\s*/, ""));
  }
  if (cur) out.push(cur);
  return out.map((b) => ({ cat: b.cat, name: b.name, text: b.text.join(" ").slice(0, 120), source: b.source })).filter((b) => b.text.length > 2);
}
function tidy(items) {
  const seen = new Set();
  const uniq = items.filter((b) => { const k = b.text; if (seen.has(k)) return false; seen.add(k); return true; });
  const rich = uniq.filter((b) => !/^囚犯编号/.test(b.text));
  return (rich.length ? rich : uniq).slice(-PER_CHAR);
}
const ALL = [];
for (const p of sentFiles) for (const b of blocksOf(p)) ALL.push(b);
function labelsOf(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^\*\*([^*]{1,12})\*\*$/);
    if (m && m[1] !== "旁白" && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}
function show(b) {
  return "   · " + b.text + "　（" + b.cat + "·你自己写的推测｜" + b.source + "）";
}
const mode = process.argv[2] || "";
if (mode === "narrow") {
  const abs = resolve(root, process.argv[3] || "");
  if (!existsSync(abs)) { console.error("找不到文件"); process.exit(3); }
  const tRel = rel(abs), tText = read(abs);
  const chars = labelsOf(tText).concat(known(tText)).filter((v, i, a) => a.indexOf(v) === i);
  const cards = chars.map((n) => ({ n: n, items: tidy(ALL.filter((b) => b.cat === "档案" && b.name === n && b.source.indexOf(tRel) !== 0)) })).filter((c) => c.items.length);
  const topics = TOPICS.filter((k) => tText.includes(k));
  const tItems = ALL.filter((b) => b.cat !== "档案" && topics.some((k) => b.text.includes(k)) && b.source.indexOf(tRel) !== 0).slice(-MAX_TOPIC);
  if (!cards.length && !tItems.length) process.exit(0);
  console.log("（本鱼替你翻旧账：只列你读过的图鉴原话与出处，不做判断）");
  for (const c of cards.slice(0, MAX_CHARS)) { console.log("▸ " + c.n); for (const b of c.items) console.log(show(b)); }
  if (tItems.length) { console.log("▸ 物/规则"); for (const b of tItems) console.log(show(b)); }
} else if (mode === "full") {
  console.log("（全量：已发放 " + sentFiles.length + " 份，图鉴块 " + ALL.length + " 条）");
  for (const b of ALL.filter((x) => x.cat === "档案").slice(0, 60)) console.log("▸ " + b.name + "\n" + show(b));
} else { console.error("用法: node tools/host-facts.mjs narrow <文件> | full"); process.exit(2); }
function known(t) {
  const names = [];
  for (const b of ALL) if (b.name && t.includes(b.name) && !names.includes(b.name)) names.push(b.name);
  return names;
}