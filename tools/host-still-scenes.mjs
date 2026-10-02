// 用法: node tools/host-still-scenes.mjs <act 1|2> <chapter 1..6>
// 把「本周目本章每个正文场景的 CG 密度」和库数据的节点标题对起来，
// 用来定位「凶手被确认」那一格（凶手自述手法 + 连着好几张插画）。
// 依赖：tools/probe-stills.py 先跑出 .cache/still-map-act0N.json。
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(process.env.MANOSABA_SOURCE || join(tmpdir(), 'manosaba-library-source'));
const [actArg, chapterArg] = process.argv.slice(2);
const act = Number(actArg), chapter = Number(chapterArg);
if (![1, 2].includes(act) || !(chapter >= 1 && chapter <= 6)) {
  throw new Error('用法: node tools/host-still-scenes.mjs <act 1|2> <chapter 1..6>');
}
function chapterOf(node) {
  const text = `${node.parentId || ''} ${node.id || ''}`;
  const match = text.match(/A[12]C([1-6])/i) || text.match(/^0[12]0([1-6])/);
  return match ? Number(match[1]) : 1;
}
const stillPath = join(root, '.cache', `still-map-act0${act}.json`);
if (!existsSync(stillPath)) {
  throw new Error(`缺 ${stillPath}——先跑 tools/probe-stills.py（见 主持人/凶手确认节点-识别法.md）`);
}
const stills = JSON.parse(await readFile(stillPath, 'utf8'));
const nodes = JSON.parse(await readFile(join(sourceRoot, 'data', `act0${act}.json`), 'utf8')).nodes;
const statsOf = new Map();
for (const [script, stats] of Object.entries(stills)) {
  const match = script.match(/^Act0([12])_Chapter(\d+)_(Adv\d+|Trial\d+|TrialAfter\d+|Bad\d+)$/);
  if (match) statsOf.set(`0${match[1]}${match[2]}${match[3]}`, stats);
}
let serial = 0;
const rows = [];
for (const node of nodes) {
  if (!(node.level > 0) || ['ti', 'tr'].includes(node.type) || /^CommonBad/i.test(node.id)) continue;
  if (chapterOf(node) !== chapter) continue;
  serial += 1;
  rows.push({ scene: `场景-${String(serial).padStart(3, '0')}`, id: node.id, title: node.title || '', stats: statsOf.get(node.id) || null });
}
const top = rows.filter(r => r.stats).sort((a, b) => b.stats.distinct - a.stats.distinct)[0];
for (const row of rows) {
  const s = row.stats;
  const mark = top && row.id === top.id ? '  ← 本章插画最密' : '';
  console.log([row.scene, row.id, s ? `n=${s.n} distinct=${s.distinct} run=${s.run}` : '-', row.title.slice(0, 34)].join(' | ') + mark);
}
console.log(`（act0${act} 第 0${chapter} 章：${rows.length} 个正文场景；审判节点的插画密度请另看 .cache/still-map-act0${act}.json）`);