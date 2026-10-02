// 用法: node tools/scan-swallow.mjs [--all]
// 启发式全包扫描：查「回应文件把后面那个决策的分支一起印出来」这一类构建 BUG。
// 判据：决策 D → 回应 R →（继续）下一个决策 T；若 T 的某个分支回应 C 的整段台词（按顺序）
// 原样出现在 R 里 ⇒ R 吞掉了 T 的分支（玩家还没选就先看见了所有分支）。
// 排除：错误答案的回应会「继续」回到自己的决策（重试），这种自指不是 BUG。
// 注意：这是启发式，权威结果以「修好 build.mjs 后试构建与现包的差异」为准（见 主持人/重建流程.md）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const routes = JSON.parse(readFileSync(join(root, '主持人', '路线索引.主持人瘦身.json'), 'utf8')).路由 || {};
const cache = new Map();
function content(path) {
  if (!cache.has(path)) {
    let text = '';
    try { text = readFileSync(join(root, path), 'utf8'); } catch { text = ''; }
    cache.set(path, text.split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('**') && !line.startsWith('<!--')));
  }
  return cache.get(path);
}
function isSubsequence(needle, hay) {
  let i = 0;
  for (const line of hay) { if (line === needle[i]) i++; if (i === needle.length) return true; }
  return needle.length === 0;
}
const findings = [];
for (const route of Object.values(routes)) {
  const options = route && route['选项'];
  if (!options) continue;
  for (const response of Object.values(options)) {
    const next = routes[response]?.['继续'];
    const nextOptions = next && routes[next]?.['选项'];
    if (!nextOptions) continue;
    if (Object.values(nextOptions).includes(response)) continue; // 重试自指
    const parent = content(response);
    for (const [childLetter, child] of Object.entries(nextOptions)) {
      const lines = content(child);
      if (lines.length < 4) continue;
      // 库数据会把同一段 resultRange 同时记给上下两层（实测 0206Trial04 的 Choice004/005 都是 179-226）
      // ⇒ 两份文件开头一字不差，那是「重复」，不是「吞掉下一题的分支」，跳过。
      if (parent[0] && lines[0] === parent[0]) continue;
      if (isSubsequence(lines, parent)) findings.push({ response, next, childLetter, child, lines: lines.length });
    }
  }
}
writeFileSync(join(root, '.cache', 'swallow-scan.json'), JSON.stringify(findings, null, 1), 'utf8');
const byResponse = new Map();
for (const f of findings) {
  const set = byResponse.get(f.response) || new Set();
  set.add(f.child);
  byResponse.set(f.response, set);
}
console.log('受影响回应文件:', byResponse.size, '｜命中配对:', findings.length);
for (const [response, children] of byResponse) {
  const parts = response.split('/');
  console.log('  ' + parts.slice(1, 4).join('/') + '/' + parts[parts.length - 1] + '  →  吞掉 ' + children.size + ' 个分支');
}
if (process.argv.includes('--all')) for (const [response, children] of byResponse) console.log(response + '  →  ' + [...children].join(' , '));
