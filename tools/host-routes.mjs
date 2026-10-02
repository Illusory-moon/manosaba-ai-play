#!/usr/bin/env node
/**
 * 主持人用的小工具：
 *   1) slim —— 从 主持人/路线索引.json 抽出只含 起点/路由 的瘦身版（去掉清单、关键字等答案字段）
 *   2) next —— 读玩家体验文档里的「## 决策」，算出下一份该发的文件
 * 用法：
 *   node tools/host-routes.mjs slim
 *   node tools/host-routes.mjs next "游戏包/一周目/第02章/魔女审判/审判-027-决策-04.md"
 *   （参数是**游戏包里的那一份**；工具会自己推出她对应的 `record/…/体验-<同名>.md` 去读「## 决策」。
 *     传 record 路径会报「路由里没有这份文件」——2026-09-25 深夜 本鱼踩过一次，特此写明。）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const indexPath = join(root, "主持人", "路线索引.json");
const slimPath = join(root, "主持人", "路线索引.主持人瘦身.json");

function loadIndex() {
  if (!existsSync(indexPath)) {
    console.error("找不到 主持人/路线索引.json —— 先构建一次游戏包。");
    process.exit(2);
  }
  return JSON.parse(readFileSync(indexPath, "utf8"));
}

function slim() {
  const index = loadIndex();
  const routes = index["路由"] || {};
  const repPath = join(root, "主持人", "构建报告.json");
  const refs = new Set(existsSync(repPath) ? (JSON.parse(readFileSync(repPath, "utf8")).referenceFiles || []) : []);
  // 「哪一场是结局」属于剧透 ⇒ 从本机配置读（缺了就只当普通终点，不猜）。
  const endingsPath = join(root, "主持人", "结局标记.json");
  const endingList = existsSync(endingsPath) ? JSON.parse(readFileSync(endingsPath, "utf8")) : [];
  const endings = endingList.map(e => e.file);
  const terminal = Object.entries(routes).filter(([, v]) => !v["继续"] && !v["选项"]).map(([k]) => k);
  const badEnds = terminal.filter(t => !refs.has(t) && !endings.includes(t));
  const out = {
    说明: "主持人瘦身版：只有起点、路由与结局标记，不含 清单/关键字 等答案字段。玩家不可见。",
    起点: index["起点"] || {},
    结局: Object.fromEntries(endingList.map(e => [e["周目"], { file: e.file, label: e.label }])),
    坏结局: badEnds,
    路由: routes,
  };
  writeFileSync(slimPath, JSON.stringify(out, null, 1), "utf8");
  console.log(JSON.stringify({ slim: slimPath, files: Object.keys(routes).length, starts: out.起点 }, null, 1));
}

function readDecision(docPath) {
  const abs = resolve(root, docPath);
  if (!existsSync(abs)) { console.error("找不到文档：" + docPath); process.exit(2); }
  const text = readFileSync(abs, "utf8");
  // 重选是「只增不改」⇒ 以**最后一节** `## 决策` 为准（旧决策留在文档里做历史）。
  const headings = [...text.matchAll(/^## 决策.*$/gm)];
  const at = headings.length ? headings[headings.length - 1].index : -1;
  const section = at >= 0 ? text.slice(at) : "";
  const picks = [...section.matchAll(/选择[：:]\s*([A-Z]+)[.、]?\s*([^\n]*)/g)].map(m => ({ letter: m[1], text: (m[2] || "").trim() }));
  const keywords = [...section.matchAll(/点击的关键字[：:]\s*[「"]([^」"]+)[」"]/g)].map(m => m[1]);
  const unique = []; const seenL = new Set();
  for (const p of picks) { if (seenL.has(p.letter)) continue; seenL.add(p.letter); unique.push(p); }
  return { picks: unique, letters: unique.map(p => p.letter), keywords };
}

const normText = s => String(s || "").replace(/[\s\u3000*"“”「」『』（）()，。！？；：、…—\-]/g, "");

// 读当前这份决策文件里的 字母 → 选项文字（AI 重建后字母可能漂移，所以按文字认最稳）
function optionTexts(routePath) {
  const abs = resolve(root, routePath);
  const map = new Map();
  if (!existsSync(abs)) return map;
  for (const l of readFileSync(abs, "utf8").split(/\r?\n/)) {
    const m = l.match(/^-\s*([A-Z]+)\.\s*(.+)$/);
    if (m) map.set(m[1], m[2].split("　—　")[0].trim());
  }
  return map;
}

function playerDocOf(routePath) {
  const m = routePath.match(/^游戏包\/([^/]+)\/(第\d+章)\/(?:正文|魔女审判)\/(.+)\.md$/);
  if (!m) return null;
  return "record/" + m[1] + "/" + m[2] + "/体验-" + m[3] + ".md";
}

function next(docPath) {
  const index = loadIndex();
  const routes = index["路由"] || {};
  const doc = docPath.replaceAll(String.fromCharCode(92), "/");
  const route = routes[doc];
  if (!route) {
    console.error("路由里没有这份文件：" + doc);
    const base = doc.split("/").pop();
    const near = Object.keys(routes).filter(k => k.endsWith(base)).slice(0, 5);
    if (near.length) console.error("相近的：\n  " + near.join("\n  "));
    process.exit(3);
  }
  const playerDoc = arg2 || playerDocOf(doc);
  if (!playerDoc) console.error("提示：这份文件推不出玩家文档路径，需要手动传 --decision。");
  const decision = playerDoc ? readDecision(playerDoc) : { letters: [], keywords: [] };
  const options = route["选项"];
  let target = null, how = null;
  if (options) {
    if (!decision.letters.length) {
      console.error("这份文件有选项，但" + (playerDoc || "（未给玩家文档）") + " 里没读到「选择：X」——请人工确认或问玩家。");
      console.log(JSON.stringify({ doc, options }, null, 1));
      process.exit(4);
    }
    const texts = optionTexts(doc);
    const first = decision.picks[0];
    let letter = first ? first.letter : null;
    let matchedBy = "按字母";
    if (first && first.text) {
      const want = normText(first.text);
      for (const [l, t] of texts) {
        const have = normText(t);
        if (have && want && (have === want || have.includes(want) || want.includes(have))) {
          if (l !== letter) matchedBy = "按文字（字母漂移：" + letter + " → " + l + "）";
          else matchedBy = "按文字（与字母一致）";
          letter = l;
          break;
        }
      }
    }
    if (!(letter in options)) {
      console.error("⚠ 选出的字母 " + letter + " 不在当前路由选项里（" + Object.keys(options).join("") + "）——请人工核对版本。");
      process.exit(7);
    }
    target = options[letter] || null;
    how = "选项 " + letter + "｜" + matchedBy;
    if (!target) { console.error("选项 " + decision.letters[0] + " 没有对应文件。"); process.exit(5); }
  } else if (route["继续"]) {
    target = route["继续"]; how = "继续";
  } else {
    console.error("这份文件是终点，没有下一份。");
    process.exit(6);
  }
  console.log(JSON.stringify({ doc, how, picked: decision.picks[0] || null, keywords: decision.keywords, next: target }, null, 1));
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = argv[1];
const di = argv.indexOf("--decision");
const arg2 = di >= 0 ? argv[di + 1] : null;
if (cmd === "slim") slim();
else if (cmd === "next") next(arg || "");
else { console.log("用法: node tools/host-routes.mjs slim | next \"<文档路径>\""); process.exit(1); }