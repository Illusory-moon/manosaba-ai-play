#!/usr/bin/env node
/**
 * 生成 loadChoiceSplits 需要的 witches_trial_data.json。
 * 原文件是本机早先生成的（上游仓库里没有），随构建源损坏而丢失 ⇒ 这里可复现地重建：
 *   ① 优先从「现行游戏包」反推 split（正文里 「## 请选择」之前有几个 <!-- line --> 块）——它等于上一次成功构建的真实切点；
 *   ② 反推不到的节点（例如包里没有对应正文）用解包行号兜底：split = 选择前出现过的台词条数。
 * 输出结构照 build.mjs 的读法：{ a: [ { s: [ { f: <脚本名>, l: [ {i}, ... ] } ] } ] }，
 * 其中 l 只需满足「前 split 条不是选择、其后 count 条是选择」。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const storyRoot = join(root, '.cache', 'local-story');
const pkgRoot = join(root, '游戏包');
const sourceRoot = resolve(process.env.MANOSABA_SOURCE || join(process.env.TEMP || '', 'manosaba-library-source'));
const outPath = join(root, '.cache', 'witches_trial_data.json');

function walk(dir, out) {
  out = out || [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}
const clean = (s) => String(s || '').replace(/^\[[^\]]*\]\s*/g, '').replace(/\s+/g, '').replace(/[「」【】〔〕]/g, '');

// ── 读上游节点（拿 choices / dialogue 长度）
const nodes = [];
for (const act of ['01', '02']) {
  const p = join(sourceRoot, 'data', 'act' + act + '.json');
  if (!existsSync(p)) continue;
  const data = JSON.parse(readFileSync(p, 'utf8'));
  for (const n of data.nodes || []) if ((n.choices || []).length) nodes.push(n);
}
const sig = (list) => list.map(clean).sort().join('|');
const bySig = new Map();
for (const n of nodes) bySig.set(sig((n.choices || []).map(c => c.text)), n);
// 关键：不能光数 <!-- line -->！包里插进去的图鉴/收录块也用同一个分隔符，
// 会让 split 偏大（实测 0101Adv07 / 0102Adv05 / 0201Adv04 / 0201Adv19 四个节点中招）。
// 所以优先拿同目录的「-后续.md」反推：后续文件的第一句就是 dialogue[split]。
const linesOf = (item) => String(item.text || '').split(/<br\s*\/?>/i).map(line => line.trim()).filter(Boolean);
function splitFromTail(node, tailPath) {
  if (!existsSync(tailPath)) return -1;
  const first = readFileSync(tailPath, 'utf8').replace(/\r\n/g, '\n').split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('<!--') && !line.startsWith('!') && !line.startsWith('>') && !line.startsWith('**'))[0];
  if (!first) return -1;
  return (node.dialogue || []).findIndex(item => linesOf(item)[0] === first);
}

// ── 从现行包里反推 split
const splitFromPkg = new Map();
const mismatches = [];
for (const p of walk(pkgRoot)) {
  if (!p.endsWith('.md') || !/[\\/]正文[\\/]/.test(p)) continue;
  const text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf('## 请选择');
  if (at < 0) continue;
  const head = text.slice(0, at);
  const body = text.slice(at);
  const opts = [...body.matchAll(/^- [A-Z]\. (.+?)(?:　—　|$)/gm)].map(m => clean(m[1].replace(/^【[^】]*】/, '')));
  if (!opts.length) continue;
  const node = bySig.get(sig(opts));
  if (!node || splitFromPkg.has(node.id)) continue;
  const naive = (head.match(/<!-- line -->/g) || []).length;
  const fromTail = splitFromTail(node, p.replace(/\.md$/, '-后续.md'));
  const split = fromTail > 0 ? fromTail : naive;
  if (split !== naive) mismatches.push(node.id + '：按分隔符 ' + naive + ' → 按后续文件 ' + split);
  splitFromPkg.set(node.id, split);
}

// ── 兜底：用解包行号算
const textBefore = new Map();
for (const p of walk(storyRoot)) {
  const stem = basename(p, '.json');
  if (!/^Act0[12]_Chapter0[1-6]_/i.test(stem)) continue;
  let json; try { json = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  let texts = 0, choices = 0, first = -1;
  for (const line of json.lines || []) {
    if (line.type === 'text' && line.text) { texts++; continue; }
    if (line.type === 'choice-button' && line.choiceId) { if (first < 0) first = texts; choices++; }
  }
  if (first > 0) textBefore.set(stem, { split: first, count: choices });
}
const stemOf = (id) => {
  const m = String(id).match(/^0([12])0([1-6])(.+)$/);
  return m ? 'Act0' + m[1] + '_Chapter0' + m[2] + '_' + m[3] : null;
};

const sections = [];
let fromPkg = 0, fromCalc = 0, fallback = 0;
for (const node of nodes) {
  const count = (node.choices || []).length;
  let split = splitFromPkg.get(node.id);
  if (split != null) fromPkg++;
  else {
    const stem = stemOf(node.id);
    const calc = stem ? textBefore.get(stem) : null;
    if (calc && calc.count === count) { split = calc.split; fromCalc++; }
    else { split = Math.max(1, Math.min((node.dialogue || []).length - 1, 1)); fallback++; }
  }
  const l = [];
  for (let i = 0; i < split; i++) l.push({ i: 'text' + i });
  for (let i = 0; i < count; i++) l.push({ i: node.id + '_Choice' + String(i + 1).padStart(3, '0') });
  sections.push({ f: stemOf(node.id) || node.id, l });
}

sections.sort((a, b) => (a.f < b.f ? -1 : 1));
const byAct = new Map();
for (const s of sections) { const act = s.f.startsWith('Act02') ? 'act02' : 'act01'; if (!byAct.has(act)) byAct.set(act, []); byAct.get(act).push(s); }
const data = { a: [...byAct.entries()].map(([act, s]) => ({ act, s })) };
writeFileSync(outPath, JSON.stringify(data), 'utf8');
console.log(JSON.stringify({ nodes: nodes.length, fromPackage: fromPkg, fromExtraction: fromCalc, coarseFallback: fallback }));
if (mismatches.length) console.log('分隔符数偏大、已按「后续」文件修正:\n  ' + mismatches.join('\n  '));