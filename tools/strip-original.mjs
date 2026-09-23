#!/usr/bin/env node
/**
 * 把「感想文档」变成可公开版本：把逐句引用的原文换成「第 N 句」。
 *
 * 用法：node tools/strip-original.mjs <源文档> <输出目录> [--drop-section "## 9"]
 *
 * 规矩（很重要）：
 *   - 只读源文档，绝不回写；输出目录落在 record/ 里会直接拒绝。
 *   - 主持人生成的提示（含「请选择」/「## 机制」/「可点击关键字」的引用块）保留原样。
 *   - 其余「**原文**」后面的引用块整段换成「（第 N 句原文已省略）」。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [src, outDir, ...flags] = process.argv.slice(2);
if (!src || !outDir) {
  console.error('用法: node tools/strip-original.mjs <源文档> <输出目录> [--drop-section "## 9"]');
  process.exit(2);
}
const dropIndex = flags.indexOf('--drop-section');
const dropSection = dropIndex >= 0 ? flags[dropIndex + 1] : null;

const source = resolve(src);
const target = resolve(outDir);
if (/(^|[\\/])record([\\/]|$)/.test(target)) {
  console.error('输出目录落在 record/ 里，拒绝执行（感想原稿只读）。');
  process.exit(3);
}

const lines = readFileSync(source, 'utf8').split(/\r?\n/);
const out = [];
let stripped = 0, kept = 0, dropped = 0, currentNumber = null, index = 0;

while (index < lines.length) {
  const line = lines[index];
  const heading = line.match(/^###\s+(\d+)/);
  if (heading) currentNumber = heading[1];
  if (dropSection && line.startsWith(dropSection)) {
    dropped++;
    index++;
    while (index < lines.length && !lines[index].startsWith('## ')) index++;
    continue;
  }
  if (line.trim() === '**原文**') {
    out.push(line);
    index++;
    const block = [];
    while (index < lines.length) {
      const next = lines[index];
      if (next.startsWith('>')) { block.push(next); index++; continue; }
      if (next.trim() === '' && lines[index + 1] && lines[index + 1].startsWith('>')) { index++; continue; }
      break;
    }
    if (!block.length) continue;
    const body = block.join('\n');
    out.push('');
    if (/请选择|##\s*机制|可点击关键字/.test(body)) { out.push(body); kept++; }
    else { out.push('> （第 ' + (currentNumber || '?') + ' 句原文已省略）'); stripped++; }
    continue;
  }
  out.push(line);
  index++;
}

const banner = [
  '> **公开样本**：为不重新发布原作文本，逐句引用的原文已省略为「第 N 句」；主持人生成的提示（决策清单等）保留原样。',
  '> 本文档是 AI 游玩记录，含剧透。'
  , ''
].join('\n');
mkdirSync(target, { recursive: true });
const file = join(target, basename(source));
writeFileSync(file, banner + out.join('\n').replace(/^\n+/, ''), 'utf8');
console.log(JSON.stringify({ source, output: file, strippedBlocks: stripped, keptPromptBlocks: kept, droppedSections: dropped }, null, 1));