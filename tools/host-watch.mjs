#!/usr/bin/env node
/**
 * 主持人用的"上下文监测"：检查游玩 agent 的会话记录里有没有发生上下文压缩。
 * 用法：node tools/host-watch.mjs <agentId 或 uuid 前缀>
 * 输出：未压缩 / ⚠ 已压缩（并给出证据）；同时维护 .cache/host-watch-state.json 便于对比。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import zlib from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const base = join(process.env.USERPROFILE, ".dsh", "sessions", "--E-manosaba--");
const stateFile = join(root, ".cache", "host-watch-state.json");
const key = process.argv[2] || "";
if (!key) { console.error("用法: node tools/host-watch.mjs <agentId 或 uuid 前缀>"); process.exit(2); }

const dir = readdirSync(base).find(d => d.includes(key));
if (!dir) { console.error("找不到会话目录：" + key); process.exit(3); }
const f = join(base, dir, "session.v3.jsonl.zstd");
if (!existsSync(f)) { console.error("找不到会话记录：" + f); process.exit(4); }

const buf = readFileSync(f);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offs = [];
for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(magic, 0, 4, i, i + 4) === 0) offs.push(i);

const types = new Map(); const hits = []; let lastSeq = 0;
for (let i = 0; i < offs.length; i++) {
  const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
  let text = ""; try { text = zlib.zstdDecompressSync(buf.subarray(offs[i], end)).toString("utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue; let r; try { r = JSON.parse(line); } catch { continue; }
    const t = r.type || "?"; types.set(t, (types.get(t) || 0) + 1);
    if (typeof r.seq === "number" && r.seq > lastSeq) lastSeq = r.seq;
    // 精确信号（用第一章被压缩过 21 次的会话校准过）：
    // ① compaction/start|prune|summary|end 四类记录；② 一条带 checkpoint 文案的 user/system message
    if (/^compaction\//i.test(t)) hits.push(t + " seq" + r.seq);
    if ((r.type === "user/message" || r.type === "system/message")) {
      const s = JSON.stringify(r.data || "");
      if (/automatically generated checkpoint|condensing an earlier span|compacted summary/i.test(s)) hits.push("checkpoint 摘要 seq" + r.seq);
    }
  }
}

const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const prev = state[dir] || { lastSeq: 0, hits: 0 };
const newHits = hits.length - (prev.hits || 0);
state[dir] = { lastSeq, hits: hits.length, at: new Date().toISOString() };
writeFileSync(stateFile, JSON.stringify(state, null, 1), "utf8");

// 只在"本次新增"时提醒重发；历史压缩（已处理过）不再重复报警。
const compacted = newHits > 0;
console.log(JSON.stringify({
  会话: dir, 帧数: offs.length, 最新seq: lastSeq,
  之前的压缩迹象: prev.hits || 0, 现在的: hits.length, 本次新增: newHits,
  判定: compacted
    ? "⚠ 检测到上下文压缩迹象 —— 请重发开场包（AI开场白 + Memory + Memory-02 + 当前文件）"
    : (hits.length > 0 ? "OK（历史压缩 " + hits.length + " 条，已处理过，无需重发）" : "OK 未发现压缩"),
  证据: hits.slice(-5),
  记录类型: Object.fromEntries(types),
}, null, 1));