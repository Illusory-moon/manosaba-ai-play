import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const outputRoot = join(root, '游戏包');
const hostRoot = join(root, '主持人');
const defaultSource = join(tmpdir(), 'manosaba-library-source');
const sourceRoot = resolve(process.env.MANOSABA_SOURCE || defaultSource);
const defaultStory = join(root, '.cache', 'local-story');
const storyRoot = resolve(process.env.MANOSABA_STORY || defaultStory);
const routes = {};
const evidenceBoards = {};
const witchbookBoards = {};
const referenceFiles = new Set();
const choiceSplits = new Map();
const unsplitChoices = [];
let witchbookData = null;
let witchbookInitial = [];
let speakerNames = {};
let deliveredRecords = new Set();
let reenactMap = null;
const reenactBoards = {};
const endingBoards = {};
const reenactByChapter = new Map();
const reenactCopied = new Map();
const reenactSerials = new Map();
const report = { sourceCommit: '', storySource: existsSync(storyRoot) ? storyRoot : null, acts: {}, totals: { files: 0, sourceDialogue: 0, dialogueInstances: 0, uniqueDialogue: 0, repeatedDialogue: 0, normalChoices: 0, trialChoices: 0, images: 0, galleryStills: 0, locatedStills: 0, stillAppearances: 0, locatedTricks: 0, trickAppearances: 0, cutsceneAppearances: 0, reachableFiles: 0, unreachableFiles: 0, splitChoiceNodes: 0, witchbookInserts: 0, witchbookFiles: 0, reenactImages: 0, reenactFiles: 0, endingImages: 0, endingFiles: 0, clueInserts: 0, profileInserts: 0, keywordSites: 0, keywordMarks: 0, inventoryStages: 0, inventoryOptions: 0, inventoryForced: 0 }, unlocatedStills: [], warnings: [], inventoryOrphans: [] };
const sourceDialogueLabels = new Set();
const sourceLines = new Set();
const sourceLineKeys = new WeakMap();
const emittedSourceLines = new Set();
const emittedDialogue = new Map();
const terminalFiles = new Set();
const decisionFiles = new Set();
const trialBranchFiles = new Set();
const locatedGalleryStills = new Set();
const locatedGalleryTricks = new Set();
/** 「关键字」索引：主持人按文件查“这一句里哪个词可以点、点了落到哪个决策”。 */
const keywordIndex = {};
/** 「清单」索引：主持人按决策文件查“这一题当时手上有哪些证物/档案、哪一件对”。 */
const inventoryIndex = {};
let unlockOrder = new Map();
let nodeIndexOf = new Map();
let storyPathOf = new Map();

const portraitFiles = {
  Alisa: 'Profile_Alisa.webp', AnAn: 'Profile_AnAn.webp', Coco: 'Profile_Coco.webp',
  Ema: 'Profile_Ema.webp', Hanna: 'Profile_Hanna.webp', Hiro: 'Profile_Hiro.webp',
  Leia: 'Profile_Leia.webp', Margo: 'Profile_Margo.webp', Meruru: 'Profile_Meruru.webp',
  Miria: 'Profile_Miria.webp', Nanoka: 'Profile_Nanoka.webp', Noah: 'Profile_Noah.webp',
  Sherry: 'Profile_Sherry.webp'
};
const introNodes = { 1: ['0101Adv04'], 2: ['0201Adv04', '0201Adv08'] };

async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function ensureSource() {
  if (existsSync(join(sourceRoot, 'data', 'act01.json'))) return;
  await mkdir(resolve(sourceRoot, '..'), { recursive: true });
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/QwQSakuya/Manosaba-Library.git', sourceRoot], { stdio: 'inherit' });
}
function posix(path) { return path.replaceAll('\\', '/'); }
function publicPath(path) { return posix(relative(root, path)); }
function chapterOf(node, fallback = 1) {
  const text = `${node.parentId || ''} ${node.id || ''}`;
  const match = text.match(/A[12]C([1-6])/i) || text.match(/^0[12]0([1-6])/);
  return match ? Number(match[1]) : fallback;
}
function clean(text = '') {
  return text.replaceAll('<br>', '  \n').replace(/<link=[^>]+>/g, '').replace(/<\/link>/g, '')
    .replace(/<color=[^>]+>|<\/color>|<size=[^>]+>|<\/size>/g, '').replace(/<b>(.*?)<\/b>/gs, '**$1**')
    .replace(/<i>(.*?)<\/i>/gs, '*$1*').replace(/<[^>]+>/g, '').trim();
}
function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** 把可点击的关键字就地圈出来；同一句里重叠时先长后短，只标一轮，不套娃。 */
function markKeywords(text, surfaces) {
  const list = [...new Set(surfaces.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return text;
  return text.replace(new RegExp(list.map(escapeRe).join('|'), 'g'), match => `〔${match}〕`);
}
/** 决策文件里定位关键字用：以关键字为中心裁一小段台词。 */
function keywordSnippet(text, surface, span = 14) {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const at = flat.indexOf(surface);
  if (at < 0) return `${flat.slice(0, span * 2)}…`;
  const start = Math.max(0, at - span), end = Math.min(flat.length, at + surface.length + span);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).replaceAll(surface, `〔${surface}〕`)}${end < flat.length ? '…' : ''}`;
}
function speakerMap(chars) {
  const map = Object.fromEntries(chars.map(c => [c.labelEn, c.label]));
  return { ...map, Narrative: '旁白', Jailer: '看守', JailerA: '看守A', JailerB: '看守B', JailerC: '看守C', Warden: '典狱长', System: '系统' };
}
function itemMd(item) {
  if (item.kind !== 'witchbook') return `![${item.alt}](${item.path})`;
  const image = item.image ? `![${item.image.alt}](${item.image.path})\n\n` : '';
  return `**【${item.source}】${item.title}**\n\n${image}${item.text}`;
}
function imagesMd(items = []) {
  return items.map(itemMd).join('\n\n');
}
/**
 * 魔女图鉴条目：按 Category/Id/Version 取文本，同一个版本只发一次；
 * 版本更新只发新增的部分（游戏里条目是逐版本变长的）。
 */
function witchbookItem(record) {
  // 规定 / 记录 / 证物 / 人物档案都插；地图暂不处理（素材只有基础版）。
  if (!['Note', 'Rule', 'Clue', 'Profile'].includes(record.category)) return null;
  const group = witchbookData?.[record.category]?.[String(record.id)];
  const item = group?.[String(record.version)];
  if (!item) return null;
  const key = `${record.category}:${record.id}:v${record.version}`;
  if (deliveredRecords.has(key)) return null;
  deliveredRecords.add(key);
  report.totals.witchbookInserts++;
  if (record.category === 'Clue') report.totals.clueInserts++;
  if (record.category === 'Profile') report.totals.profileInserts++;
  const source = record.category === 'Rule' ? '魔女图鉴·规定'
    : record.category === 'Clue' ? '魔女图鉴·证物'
      : record.category === 'Profile' ? '魔女图鉴·档案' : '魔女图鉴·记录';
  const previous = Object.keys(group).map(Number).filter(version => version < Number(record.version)).sort((a, b) => a - b).pop();
  const title = record.category === 'Profile'
    ? (speakerNames[record.id] || speakerNames[record.id.toLowerCase()] || record.id)
    : (item.subtitle || item.title || item.name || String(record.id));
  let text = item.description || '';
  let suffix = '';
  let image = null;
  if (previous !== undefined) {
    suffix = '（更新）';
    const before = group[String(previous)].description || '';
    if (text.startsWith(before)) text = text.slice(before.length);
  } else if (record.category === 'Clue') {
    // 证物第一次解锁时把图一起放进来（图已由 copyEvidence 放进它自己那一章）
    const match = String(record.id).match(/^(\d+)-(\d+)$/);
    if (match) {
      const number = Number(match[1]);
      const act = number <= 5 ? 1 : 2;
      const chapter = number <= 5 ? number : number - 5;
      const sprite = `Clue_${String(number).padStart(3, '0')}_${String(Number(match[2])).padStart(3, '0')}.webp`;
      image = { alt: title, path: posix(join(outputRoot, act === 1 ? '一周目' : '二周目', `第${String(chapter).padStart(2, '0')}章`, '素材', '证物', sprite)) };
    }
  }
  return { kind: 'witchbook', source, title: `${item.numbering ? `${item.numbering} ` : ''}${title}${suffix}`, text: clean(text), image };
}
/** 图鉴条目的显示名（证物用条目小标题，人物档案用中文名）。 */
function witchbookName(category, id, version) {
  const group = witchbookData?.[category]?.[String(id)];
  const versions = Object.keys(group || {}).sort((a, b) => Number(a) - Number(b));
  const item = group?.[String(version)] || (versions.length ? group[versions[0]] : null);
  if (category === 'Profile') return speakerNames[id] || speakerNames[String(id).toLowerCase()] || String(id);
  return item?.subtitle || item?.title || item?.name || String(id);
}
/**
 * 每件证物/人物档案第一次解锁的位置（本周目节点顺序 + 行号）。
 * 审判里的 ChoiceEvidence 会弹出「此刻手机上已解锁的清单」，用这个位置还原。
 */
async function makeUnlockOrder(nodes) {
  const order = new Map(), indexOf = new Map(), pathOf = new Map();
  for (const record of witchbookInitial) {
    const key = `${record.category}:${record.id}`;
    if (!order.has(key)) order.set(key, { index: -1, li: 0, version: record.version });
  }
  for (const [index, node] of nodes.entries()) indexOf.set(node.id, index);
  for (const path of await storyFiles(storyRoot)) {
    const id = storyNodeId(path);
    if (!id || !indexOf.has(id) || pathOf.has(id)) continue;
    pathOf.set(id, path);
    const script = await json(path);
    for (const line of script.lines || []) {
      if (line.type !== 'witchbook') continue;
      const key = `${line.category}:${line.id}`;
      const at = { index: indexOf.get(id), li: Number.isFinite(line.lineIndex) ? line.lineIndex : 0, version: line.version };
      const seen = order.get(key);
      if (!seen || at.index < seen.index || (at.index === seen.index && at.li < seen.li)) order.set(key, at);
    }
  }
  return { order, indexOf, pathOf };
}
function dialogueMd(entries, names, imageAfter = new Map(), imageBefore = [], keyword = null) {
  const dialogue = entries.map((d, i) => {
    const who = names[d.speaker] || d.speaker || '旁白';
    const items = imageAfter.get(d.label) || imageAfter.get(i) || [];
    const images = items.filter(item => item.kind !== 'witchbook');
    const records = items.filter(item => item.kind === 'witchbook');
    report.totals.dialogueInstances++;
    emittedDialogue.set(d.label, (emittedDialogue.get(d.label) || 0) + 1);
    const sourceKey = sourceLineKeys.get(d);
    if (sourceKey) emittedSourceLines.add(sourceKey);
    // 魔女审判：台词里被脚本标成 <link> 的词就是“可以点的关键字”，就地圈出来并写明点它落到哪个决策。
    let text = clean(d.text);
    const notes = [];
    if (keyword) {
      const sites = new Map();
      for (const link of d.objectionLinks || []) {
        const site = keyword.resolve(link);
        if (!site || !site.surface || !text.includes(site.surface)) continue;
        if (!sites.has(site.surface)) sites.set(site.surface, []);
        sites.get(site.surface).push(site);
      }
      if (sites.size) text = markKeywords(text, [...sites.keys()]);
      for (const [surface, list] of sites) {
        report.totals.keywordMarks++;
        for (const site of list) for (const target of (site.targets.length ? site.targets : [null])) {
          keyword.records.push({ '关键词': surface, '台词': d.label || '', '说话人': who, '选项': target ? target.letter : null, '决策文件': target ? target.decisionPath : null });
        }
        const targets = list.flatMap(site => site.targets);
        const goes = targets.length ? targets.map(target => `\`${basename(target.decisionPath)}\` 选项 ${target.letter}`).join('、') : '（本包未收录对应分支）';
        notes.push(`> 🔍 可点击关键字：**${surface}** → ${goes}`);
      }
    }
    const parts = [`**${who}**\n\n${text}`];
    if (notes.length) parts.push(notes.join('\n'));
    if (images.length) parts.push(imagesMd(images));
    parts.push('<!-- line -->');
    // 魔女图鉴条目各自成段，游玩 AI 才能一条一条回应。
    if (records.length) parts.push(records.map(record => `${itemMd(record)}\n\n<!-- line -->`).join('\n\n'));
    return parts.join('\n\n');
  }).join('\n\n');
  return [imagesMd(imageBefore), dialogue].filter(Boolean).join('\n\n');
}
/** 选项字母：A…Z，超过 26 个就 AA、AB（证物清单可能一次性列出 40 多件）。 */
function optionLetter(index) {
  let value = index, text = '';
  do { text = String.fromCharCode(65 + (value % 26)) + text; value = Math.floor(value / 26) - 1; } while (value >= 0);
  return text;
}
function choiceMd(items, notes = [], keywordStage = false) {
  if (!items.length) return '';
  const list = items.map((x, i) => `- ${optionLetter(i)}. ${clean(x.text)}${notes[i] ? `　—　${notes[i]}` : ''}`).join('\n');
  const ask = keywordStage
    ? '请在返回文档的“决策”部分明确写出选项字母、完整选项文本，以及你点击的关键字。'
    : '请在返回文档的“决策”部分明确写出选项字母和完整选项文本。';
  return `\n\n## 请选择\n\n${list}\n\n${ask}`;
}
async function emit(path, title, body, route) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `# ${title}\n\n${body.trim()}\n`, 'utf8');
  routes[publicPath(path)] = route;
  // 没有出口的文件本身就是终点，供 validate 判断“能否走到结局”。
  if (!Object.values(route['选项'] || route).some(Boolean)) terminalFiles.add(publicPath(path));
  report.totals.files++;
  return publicPath(path);
}
function rangesFor(node, annotations) {
  const found = [];
  function add(owner, item, kind = 'choice') {
    if (item.resultRange?.length === 2) {
      const start = node.dialogue.findIndex(d => d.label === item.resultRange[0]);
      const end0 = node.dialogue.findIndex(d => d.label === item.resultRange[1]);
      if (start >= 0) found.push({ owner, item, kind, start, end: end0 >= 0 ? end0 : start });
    }
    for (const child of item.childBranches || []) add(owner, child, child.kind || (child.witness ? 'witness' : 'evidence'));
  }
  for (const choice of node.trialChoices || []) {
    if (/Common_Return/i.test(choice.id || '') || choice.buttonType === 'Cancel') continue;
    const ann = annotations[choice.id];
    if (!ann) continue;
    add(choice, ann);
    for (const item of ann.witnessBranches || []) add(choice, item, 'witness');
    for (const item of ann.evidenceBranches || []) add(choice, item, 'evidence');
  }
  return found;
}
function branchText(item, kind) {
  if (kind === 'witness') return item.witness || item.text || '这名证人';
  if (kind === 'evidence') return item.evidence || item.text || '这件证物';
  return item.text || '';
}
function buildEffectiveNext(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const firstChild = new Map();
  for (const node of nodes) {
    if (!node.parentId || node.type === 'bd' || node.level === 0 || firstChild.has(node.parentId)) continue;
    firstChild.set(node.parentId, node.id);
  }
  function resolveTarget(id) {
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const target = byId.get(id);
      if (!target || target.level !== 0) return id;
      if (firstChild.has(id)) return firstChild.get(id);
      id = target.nextId;
    }
    return null;
  }
  const effectiveNext = node => {
    if (node.nextId) return resolveTarget(node.nextId);
    const parent = byId.get(node.parentId);
    return parent?.level === 0 ? resolveTarget(parent.nextId) : null;
  };
  effectiveNext.target = resolveTarget;
  return effectiveNext;
}

function trialModel(node, annotations) {
  const choices = new Map();
  for (const [order, choice] of (node.trialChoices || []).entries()) {
    if (/Common_Return/i.test(choice.id || '') || choice.buttonType === 'Cancel') continue;
    const item = annotations[choice.id];
    if (!item) continue;
    const start0 = node.dialogue.findIndex(d => d.label === item.resultRange?.[0]);
    const end0 = node.dialogue.findIndex(d => d.label === item.resultRange?.[1]);
    const start = start0 < 0 ? Number.MAX_SAFE_INTEGER - 1000 + order : start0;
    choices.set(choice.id, { key: choice.id, text: choice.text, item, kind: 'choice', buttonType: choice.buttonType, parentRef: item.parentChoice, requiresRef: item.requiresChoice, start, end: end0 < 0 ? start : end0 });
  }

  const entries = [...choices.values()];
  function addBranches(owner, branches, kind, parentRef = owner.key) {
    for (let i = 0; i < (branches || []).length; i++) {
      const item = branches[i];
      const itemKind = kind || (/^wit/i.test(item.kind || '') ? 'witness' : 'evidence');
      const short = itemKind === 'witness' ? 'wit' : 'ev';
      const key = `${parentRef}__${short}_${i}`;
      const start = node.dialogue.findIndex(d => d.label === item.resultRange?.[0]);
      const end0 = node.dialogue.findIndex(d => d.label === item.resultRange?.[1]);
      if (start < 0) continue;
      const entry = { key, text: branchText(item, itemKind), generic: false, item, kind: itemKind, parentRef, requiresRef: null, start, end: end0 < 0 ? start : end0 };
      entries.push(entry);
      addBranches(entry, item.childBranches, null, key);
    }
  }
  for (const entry of choices.values()) {
    addBranches(entry, entry.item.witnessBranches, 'witness');
    addBranches(entry, entry.item.evidenceBranches, 'evidence');
  }

  // 证物/证人选择的脚本结构是 ChoiceEvidence + 唯一的 CorrectEvidenceId，其余任何一件都走同一段
  // 通用驳回对白；库数据把那段失败对白也记成了正确那件的同名分支（同一件还可能同时记成 Clue 和
  // Profile 两条），于是决策里会出现两个一模一样的选项。把同名却不对的那条改标成“其他”。
  const branchNames = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'evidence' && entry.kind !== 'witness') continue;
    // 不按 kind 分组：同一件东西在库里可能同时记成 Clue 和 Profile 两条（0103Trial11 就是）。
    const key = `${entry.parentRef}|${entry.text}`;
    if (!branchNames.has(key)) branchNames.set(key, []);
    branchNames.get(key).push(entry);
  }
  for (const list of branchNames.values()) {
    if (list.length < 2 || !list.some(entry => entry.item.isCorrect === true)) continue;
    for (const entry of list) {
      if (entry.item.isCorrect === true) continue;
      entry.generic = true;
      entry.text = `（其他${entry.kind === 'witness' ? '人物档案' : '证物'}）`;
    }
  }
  // 另有 18 条分支库里没解析出名字，直接写成“无”；它们也全是“选错”的那条，一并改标。
  for (const entry of entries) {
    if (entry.kind !== 'evidence' && entry.kind !== 'witness') continue;
    if (entry.item.isCorrect === true || entry.generic) continue;
    if (!entry.text || !entry.text.trim() || entry.text.trim() === '无') {
      entry.generic = true;
      entry.text = `（其他${entry.kind === 'witness' ? '人物档案' : '证物'}）`;
    }
  }

  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  for (const entry of choices.values()) {
    let parent = byKey.get(entry.parentRef);
    while (parent && entry.start < parent.start && parent.parentRef) parent = byKey.get(parent.parentRef);
    if (parent) entry.parentRef = parent.key;
  }

  const stages = [];
  function stage(options, anchor = null, type = 'choice') {
    if (!options.length) return null;
    const value = { id: stages.length, options: [...options].sort((a, b) => a.start - b.start || a.end - b.end), anchor, type };
    value.start = Math.min(...value.options.map(x => x.start));
    stages.push(value);
    return value;
  }

  const initial = stage([...choices.values()].filter(x => x.buttonType === 'Trial' && !x.parentRef && !x.requiresRef), null, 'choice');
  const grouped = new Map();
  const rootEntries = [];
  for (const entry of entries) {
    if (initial?.options.includes(entry)) continue;
    const anchor = entry.requiresRef || entry.parentRef;
    if (!anchor) { rootEntries.push(entry); continue; }
    if (!grouped.has(anchor)) grouped.set(anchor, []);
    grouped.get(anchor).push(entry);
  }
  for (const [anchor, options] of grouped) stage(options, anchor);

  let round = [], correctEnd = -1;
  for (const entry of rootEntries.sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (round.length && correctEnd >= 0 && entry.start > correctEnd) {
      stage(round);
      round = [];
      correctEnd = -1;
    }
    round.push(entry);
    if (entry.item.isCorrect === true) correctEnd = Math.max(correctEnd, entry.end);
  }
  stage(round);

  const attached = new Map();
  for (const value of stages.filter(x => x.anchor)) {
    if (!attached.has(value.anchor)) attached.set(value.anchor, []);
    attached.get(value.anchor).push(value);
  }
  for (const list of attached.values()) list.sort((a, b) => a.start - b.start);
  const roots = stages.filter(x => !x.anchor).sort((a, b) => a.start - b.start);
  const stageByEntry = new Map(stages.flatMap(value => value.options.map(entry => [entry.key, value])));
  return { entries, stages, initial: initial || roots[0], attached, roots, byKey, stageByEntry };
}
/** 证物的归属：按 sprite 编号 Clue_CCC_NNN 解析（库数据里 Clue_010_* 被标成 act0/ch0）。 */
function evidencePlacement(item) {
  const match = String(item.sprite || '').match(/^Clue_(\d+)_(\d+)\.webp$/i);
  if (match) {
    const number = Number(match[1]);
    if (number >= 1 && number <= 11) return { act: number <= 5 ? 1 : 2, chapter: number <= 5 ? number : number - 5 };
  }
  return { act: item.act, chapter: item.chapter };
}
async function copyEvidence(act, chapter, evidence, chapterDir) {
  const selected = evidence.filter(e => e.sprite && evidencePlacement(e).act === act && evidencePlacement(e).chapter === chapter);
  if (!selected.length) return null;
  const dir = join(chapterDir, '素材', '证物');
  await mkdir(dir, { recursive: true });
  for (const e of selected) {
    const src = join(sourceRoot, 'assets', 'cg', 'evidence', e.sprite);
    if (existsSync(src)) { await cp(src, join(dir, e.sprite)); report.totals.images++; }
  }
  const md = selected.map(e => `## ${e.nameZh}\n\n![${e.nameZh}](${posix(join(dir, e.sprite))})\n\n${clean(e.description)}`).join('\n\n');
  const path = join(chapterDir, '证物栏.md');
  const emitted = await emit(path, '证物栏', md, {});
  // 证物栏不在正文路由里（提前发会剧透），单独登记给主持人，审判开始时随文件发送。
  evidenceBoards[`${act === 1 ? '一周目' : '二周目'}/第${String(chapter).padStart(2, '0')}章`] = emitted;
  referenceFiles.add(emitted);
  return emitted;
}
async function makePortraits(act, chapterDir, nodes) {
  if (chapterDir.endsWith('第01章') === false) return new Map();
  const labels = new Set(introNodes[act]);
  const first = new Map();
  for (const node of nodes.filter(n => labels.has(n.id))) {
    for (const d of node.dialogue || []) if (portraitFiles[d.speaker] && !first.has(d.speaker)) first.set(d.speaker, { node: node.id, label: d.label });
  }
  const placements = new Map();
  const dir = join(chapterDir, '素材', '角色');
  await mkdir(dir, { recursive: true });
  for (const [speaker, at] of first) {
    const file = portraitFiles[speaker], src = join(sourceRoot, 'assets', 'cg', 'profile', file);
    if (!existsSync(src)) continue;
    await cp(src, join(dir, file)); report.totals.images++;
    placements.set(`${at.node}:${at.label}`, { alt: `${speaker} 角色立绘`, path: posix(join(dir, file)) });
  }
  return placements;
}
function normalizedText(text = '') { return clean(text).replace(/\s/g, ''); }
function alignStoryText(lines, dialogue) {
  const story = lines.filter(line => line.type === 'text');
  const labels = new Map(dialogue.map((line, i) => [line.label, i]));
  const exact = story.map(line => labels.get(line.text) ?? null);
  if (exact.some(value => value !== null)) return exact;
  if (story.length === dialogue.length) return story.map((_, i) => i);
  const a = story.map(line => normalizedText(line.text));
  const b = dialogue.map(line => normalizedText(line.text));
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const mapped = Array(a.length).fill(null);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { mapped[i++] = j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  for (let i = 0; i < mapped.length; i++) if (mapped[i] === null) {
    const left = mapped.slice(0, i).findLastIndex(value => value !== null);
    const rightOffset = mapped.slice(i + 1).findIndex(value => value !== null);
    const right = rightOffset < 0 ? -1 : i + 1 + rightOffset;
    if (left >= 0 && right >= 0) mapped[i] = Math.min(mapped[left] + (i - left), mapped[right]);
    else if (left >= 0) mapped[i] = Math.min(mapped[left] + (i - left), b.length - 1);
    else if (right >= 0) mapped[i] = Math.max(0, mapped[right] - (right - i));
  }
  return mapped;
}
async function storyFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await storyFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) found.push(path);
  }
  return found.sort();
}
function storyNodeId(path) {
  if (/^CommonBad\d+\.json$/i.test(basename(path))) return basename(path, '.json');
  const match = basename(path, '.json').match(/^Act0?([12])_Chapter0?([1-6])_(.+)$/i);
  return match ? `0${match[1]}0${match[2]}${match[3].replace(/[^a-z0-9]/gi, '')}` : null;
}
/**
 * 普通节点的选择点在剧本里的行位置：库数据的原始剧本行含 `@choice`，
 * 用它把正文截断在真正该做选择的那一句，而不是把选后的内容提前读掉。
 */
async function loadChoiceSplits() {
  const path = join(sourceRoot, 'witches_trial_data.json');
  if (!existsSync(path)) return;
  const data = await json(path);
  const isChoice = line => /@choice/i.test(line.j || '') || /_Choice\d+$/i.test(line.i || '');
  for (const chapter of data.a || []) for (const section of chapter.s || []) {
    const id = storyNodeId(`${section.f}.json`);
    if (!id) continue;
    const lines = section.l || [];
    const first = lines.findIndex(isChoice);
    if (first < 0) continue;
    choiceSplits.set(id.toLowerCase(), {
      split: lines.slice(0, first).filter(line => !isChoice(line)).length,
      count: lines.filter(isChoice).length,
    });
  }
}
async function makeCutscenes(act, actDir, nodes) {
  if (!existsSync(storyRoot)) return { placements: new Map(), badEndIds: new Map(), commonChapters: new Map() };
  const allowed = new Set(['stills', 'ending', 'kari', 'cutin', 'tricks']);
  const gallery = await json(join(sourceRoot, 'data', 'gallery-manifest.json'));
  report.totals.galleryStills = gallery.items.filter(item => item.category === 'stills').length;
  const assets = new Map();
  const byName = new Map();
  const stem = path => basename(path.replaceAll('\\', '/')).replace(/\.[^.]+$/, '').toLowerCase();
  for (const item of gallery.items) if (!byName.has(stem(item.file))) byName.set(stem(item.file), item);
  for (const item of gallery.items.filter(item => allowed.has(item.category))) {
    for (const key of [item.id, item.file, item.original].filter(Boolean).map(stem)) if (!assets.has(key)) assets.set(key, item);
  }
  const byId = new Map(nodes.map(node => [node.id.toLowerCase(), node]));
  const placements = new Map(), copied = new Map(), serials = new Map();
  const badEndIds = new Map(), commonChapters = new Map();
  const locatedStills = new Set(), locatedTricks = new Set();
  const files = await storyFiles(storyRoot);
  let scripts = 0;
  function imageItem(line) {
    if (line.type !== 'command') return null;
    const actor = (line.params?.actor || '').toLowerCase();
    const parts = (line.params?.appearance || '').split('_').filter(Boolean);
    let key = '';
    if (actor === 'stills' && parts.length >= 2) key = `still_${parts.map(x => String(Number(x)).padStart(3, '0')).join('_')}`;
    else if (actor === 'tricks' && parts.length >= 2) key = `trick_${parts.map(x => String(Number(x)).padStart(3, '0')).join('_')}`;
    return assets.get(key) || (line.params?.path ? assets.get(stem(line.params.path)) : null);
  }
  async function processScript(path, node, chapter, placementKey) {
    const script = await json(path);
    if (!Array.isArray(script.lines)) return;
    scripts++;
    const textMap = alignStoryText(script.lines, node.dialogue || []);
    const placement = placements.get(placementKey) || { before: [], after: new Map() };
    let textIndex = -1;
    for (const line of script.lines) {
      if (line.type === 'text') { textIndex++; continue; }
      // 审判收尾的「再現」演出：把底图放在 @spawn 那一句之后
      if (line.type === 'reenact') {
        if (!line.spawn) continue;
        const art = reenactMap?.[line.actor];
        const item = art ? byName.get(art.toLowerCase()) : null;
        if (!item) continue;
        const copyKey = `${chapter}:${item.file}`;
        let record = reenactCopied.get(copyKey);
        if (!record) {
          const number = (reenactSerials.get(chapter) || 0) + 1;
          reenactSerials.set(chapter, number);
          const file = `事件插画-${String(number).padStart(2, '0')}.webp`;
          const dir = join(actDir, `第${String(chapter).padStart(2, '0')}章`, '素材', '事件插画');
          await mkdir(dir, { recursive: true });
          await cp(join(sourceRoot, 'assets', 'cg', item.file), join(dir, file));
          record = { alt: '事件插画', path: posix(join(dir, file)) };
          reenactCopied.set(copyKey, record);
          report.totals.images++;
          report.totals.reenactImages++;
          const list = reenactByChapter.get(chapter) || [];
          list.push(record);
          reenactByChapter.set(chapter, list);
        }
        const dialogueIndex = textIndex < 0 ? null : textMap[textIndex];
        const label = dialogueIndex === null || dialogueIndex === undefined ? null : node.dialogue[dialogueIndex]?.label;
        if (label) {
          if (!placement.after.has(label)) placement.after.set(label, []);
          placement.after.get(label).push(record);
        } else placement.before.push(record);
        continue;
      }
      if (line.type === 'witchbook') {
        const record = witchbookItem(line);
        if (!record) continue;
        const dialogueIndex = textIndex < 0 ? null : textMap[textIndex];
        const label = dialogueIndex === null || dialogueIndex === undefined ? null : node.dialogue[dialogueIndex]?.label;
        if (label) {
          if (!placement.after.has(label)) placement.after.set(label, []);
          placement.after.get(label).push(record);
        } else placement.before.push(record);
        continue;
      }
      const item = imageItem(line);
      if (!item) continue;
      const copyKey = `${chapter}:${item.file}`;
      let image = copied.get(copyKey);
      if (!image) {
        const number = (serials.get(chapter) || 0) + 1;
        serials.set(chapter, number);
        const file = `剧情CG-${String(number).padStart(3, '0')}.webp`;
        const dir = join(actDir, `第${String(chapter).padStart(2, '0')}章`, '素材', '剧情CG');
        await mkdir(dir, { recursive: true });
        await cp(join(sourceRoot, 'assets', 'cg', item.file), join(dir, file));
        image = { alt: '剧情 CG', path: posix(join(dir, file)) };
        copied.set(copyKey, image);
        report.totals.images++;
      }
      const dialogueIndex = textIndex < 0 ? null : textMap[textIndex];
      if (dialogueIndex === null || dialogueIndex === undefined) placement.before.push(image);
      else {
        const label = node.dialogue[dialogueIndex]?.label;
        if (label) {
          if (!placement.after.has(label)) placement.after.set(label, []);
          placement.after.get(label).push(image);
        }
      }
      if (item.category === 'stills') { locatedStills.add(item.id); locatedGalleryStills.add(item.id); report.totals.stillAppearances++; }
      if (item.category === 'tricks') { locatedTricks.add(item.id); locatedGalleryTricks.add(item.id); report.totals.trickAppearances++; }
      report.totals.cutsceneAppearances++;
    }
    placements.set(placementKey, placement);
  }
  for (const path of files) {
    const id = storyNodeId(path);
    const node = id && byId.get(id.toLowerCase());
    if (!node || !id.startsWith(`0${act}`)) continue;
    const script = await json(path);
    if (!Array.isArray(script.lines)) continue;
    const badId = script.lines.find(line => line.type === 'bad-end-id')?.id;
    if (badId) {
      badEndIds.set(node.id, Number(badId));
      if (!commonChapters.has(Number(badId))) commonChapters.set(Number(badId), new Set());
      commonChapters.get(Number(badId)).add(chapterOf(node));
    }
    await processScript(path, node, chapterOf(node), node.id);
  }
  for (const path of files) {
    const id = storyNodeId(path);
    const node = id && byId.get(id.toLowerCase());
    const badId = Number(id?.match(/^CommonBad(\d+)$/i)?.[1]);
    if (!node || !badId || !commonChapters.has(badId)) continue;
    for (const chapter of commonChapters.get(badId)) await processScript(path, node, chapter, `${node.id}:${chapter}`);
  }
  report.acts[act].storyScripts = scripts;
  return { placements, badEndIds, commonChapters };
}
async function buildTrialNode(node, actDir, chapter, annotations, names, serials, nodeEntry, effectiveNext, cutscenes, badEndIds, commonTargets) {
  const chapterDir = join(actDir, `第${String(chapter).padStart(2, '0')}章`);
  const dir = join(chapterDir, '魔女审判');
  const model = trialModel(node, annotations);
  const prefix = `审判-${String(++serials.trial).padStart(3, '0')}`;
  const entryPath = join(dir, `${prefix}.md`);
  nodeEntry.set(node.id, publicPath(entryPath));
  const finiteEntries = model.entries.filter(x => Number.isFinite(x.start) && x.start < Number.MAX_SAFE_INTEGER - 2000);
  const occupied = new Set(finiteEntries.flatMap(x => Array.from({ length: x.end - x.start + 1 }, (_, i) => x.start + i)));
  const mainline = node.dialogue.filter((_, i) => !occupied.has(i));

  const stagePath = new Map(model.stages.map((stage, i) => [stage.id, join(dir, `${prefix}-决策-${String(i + 1).padStart(2, '0')}.md`)]));
  // 脚本把“可以点的词”写成 <link="Objection_...">词</link>，库数据解析成每句台词上的
  // objectionLinks（id / text / choiceId），点下去落到 annotations 里同名 optionId 的选项上。
  const linkSites = new Map();
  for (const line of node.dialogue) for (const link of line.objectionLinks || []) {
    if (!linkSites.has(link.id)) linkSites.set(link.id, { surface: link.text, label: line.label, speaker: names[line.speaker] || line.speaker || '旁白', text: clean(line.text) });
  }
  report.totals.keywordSites += linkSites.size;
  const siteTargets = new Map();
  for (const stage of model.stages) for (const [oi, option] of stage.options.entries()) {
    const optionId = option.item.optionId;
    if (!optionId) continue;
    if (!siteTargets.has(optionId)) siteTargets.set(optionId, []);
    siteTargets.get(optionId).push({ letter: optionLetter(oi), decisionPath: publicPath(stagePath.get(stage.id)) });
  }
  const keyword = {
    records: [],
    resolve: link => {
      const site = linkSites.get(link.id);
      return site ? { ...site, targets: siteTargets.get(link.id) || [] } : null;
    },
  };
  const attachKeywords = file => {
    if (keyword.records.length) keywordIndex[file] = (keywordIndex[file] || []).concat(keyword.records);
    keyword.records = [];
  };
  const optionNote = (option, letters) => {
    const site = option.item.optionId ? linkSites.get(option.item.optionId) : null;
    if (site) {
      const extra = letters && letters.length > 1 ? `，点它会先展开本阶段的 ${letters.join('、')}` : '';
      return `点击关键字「${site.surface}」（${site.speaker}：${keywordSnippet(site.text, site.surface)}）${extra}`;
    }
    // 证物/人物档案选择：游戏里是弹清单让你挑，只有一件是对的。
    if (option.kind === 'evidence' || option.kind === 'witness') {
      const what = option.kind === 'evidence' ? '证物' : '人物档案';
      return option.generic || option.item.isCorrect !== true ? `挑错${what}会被驳回、吃一次伤害，然后退回上一层重选` : '';
    }
    return '';
  };
  // 审判里“清单”的位置用行号定位：先拿到本节点的“台词标签 → 行号”，以及脚本里的 ChoiceEvidence 事件。
  const labelLine = new Map();
  const choiceEvents = [];
  if (storyPathOf.has(node.id)) {
    const timeline = await json(storyPathOf.get(node.id));
    for (const line of timeline.lines || []) {
      if (line.type === 'text' && line.text && !labelLine.has(line.text)) labelLine.set(line.text, Number.isFinite(line.lineIndex) ? line.lineIndex : 0);
      if (line.type === 'choice-evidence') choiceEvents.push({ li: Number.isFinite(line.lineIndex) ? line.lineIndex : 0, correct: line.correct || null });
    }
  }
  const branchKey = text => String(text || '').replace(/的/g, '').replace(/\s+/g, '');
  const storyNext = effectiveNext(node);
  function continuation(stage, entry, allowAttached = true) {
    if (allowAttached && model.attached.get(entry.key)?.length) return publicPath(stagePath.get(model.attached.get(entry.key)[0].id));
    if (stage.anchor) {
      const owner = model.byKey.get(stage.anchor);
      const parent = owner && model.stageByEntry.get(owner.key);
      return parent ? continuation(parent, owner, false) : null;
    }
    const index = model.roots.indexOf(stage);
    if (model.roots[index + 1]) return publicPath(stagePath.get(model.roots[index + 1].id));
    return storyNext;
  }
  function retryTarget(stage) {
    if (!stage.anchor) return publicPath(stagePath.get(stage.id));
    const owner = model.byKey.get(stage.anchor);
    const parent = owner && model.stageByEntry.get(owner.key);
    return publicPath(stagePath.get(parent?.id ?? stage.id));
  }

  for (const [si, stage] of model.stages.entries()) {
    const decisionPath = stagePath.get(stage.id);
    const optionRoutes = {};
    // 阶段里没有任何“正确”选项时，回退重试只会把玩家锁死在同一个问题上。
    // 脚本证据：Act02_Chapter06_Trial03 的 Choice006（requiresChoice 003）对白结束后
    // 直接 @goto Act02_Chapter06/Act02_Chapter06_Trial04，说明该选项本身就是审判的出口。
    const stageHasCorrect = stage.options.some(option => option.item.isCorrect === true);
    // 同一个关键字可能对应本阶段的多个选项（点下去再展开一层）。
    const stageWordLetters = new Map();
    for (const [oi, option] of stage.options.entries()) {
      const optionId = option.item.optionId;
      if (!optionId) continue;
      if (!stageWordLetters.has(optionId)) stageWordLetters.set(optionId, []);
      stageWordLetters.get(optionId).push(optionLetter(oi));
    }
    // 脚本里的 ChoiceEvidence：从手上已解锁的证物/档案里挑一件。数据齐全（唯一正确项 + 失败分支）时
    // 按“此刻手上的清单”出选项，不标正确项，把推理交回给玩家。
    const branchOptions = stage.options.filter(option => option.kind === 'evidence' || option.kind === 'witness');
    const correctOptions = branchOptions.filter(option => option.item.isCorrect === true);
    // 只有一条“正确”分支、库里没记失败分支的阶段（全包 1 处：审判-008-决策-05）也按清单出题，挑错就停在这一题重挑。
    const inventoryStage = branchOptions.length === stage.options.length && correctOptions.length === 1;
    const hasFailureBranch = branchOptions.length > correctOptions.length;
    const keywordStage = stage.options.some(option => option.item.optionId && linkSites.has(option.item.optionId));
    const fileOfOption = new Map();
    for (const [oi, entry] of stage.options.entries()) {
      const letter = optionLetter(oi);
      const resultPath = join(dir, `${prefix}-回应-${String(si + 1).padStart(2, '0')}-${letter}.md`);
      fileOfOption.set(entry.key, publicPath(resultPath));
      if (!inventoryStage) optionRoutes[letter] = publicPath(resultPath);
      let next = entry.item.isCorrect === true || !stageHasCorrect ? continuation(stage, entry) : retryTarget(stage);
      const finite = entry.start < Number.MAX_SAFE_INTEGER - 2000;
      const resultBody = finite ? dialogueMd(node.dialogue.slice(entry.start, entry.end + 1), names, cutscenes.get(node.id)?.after, [], keyword) : '讨论继续。';
      const route = next ? { '继续': next } : {};
      const emitted = await emit(resultPath, '审判回应', resultBody || '讨论继续。', route);
      attachKeywords(publicPath(resultPath));
      if (!next) terminalFiles.add(emitted);
      report.totals.trialChoices++;
    }
    const timeoutTarget = commonTargets.get(`${chapter}:${badEndIds.get(node.id)}`);
    let displayedOptions, optionNotes, mechanism;
    if (inventoryStage) {
      // 复刻游戏里的 ChoiceEvidence：列出此刻手机上已解锁的全部证物/人物档案，不标哪件对。
      const category = correctOptions[0].kind === 'evidence' ? 'Clue' : 'Profile';
      const what = category === 'Clue' ? '证物' : '人物档案';
      const owner = stage.anchor ? model.byKey.get(stage.anchor) : null;
      const anchorLabel = owner?.item?.resultRange?.[1] || node.dialogue[node.dialogue.length - 1]?.label;
      const posIndex = nodeIndexOf.has(node.id) ? nodeIndexOf.get(node.id) : Number.MAX_SAFE_INTEGER;
      const posLi = labelLine.has(anchorLabel) ? labelLine.get(anchorLabel) : Number.MAX_SAFE_INTEGER;
      const prefixKey = `${category}:`;
      const held = [...unlockOrder.entries()]
        .filter(([key, at]) => key.startsWith(prefixKey) && (at.index < posIndex || (at.index === posIndex && at.li < posLi)))
        .map(([key, at]) => ({ id: key.slice(prefixKey.length), name: clean(witchbookName(category, key.slice(prefixKey.length), at.version)) }))
        .sort((a, b) => {
          const [an, ai] = a.id.split('-').map(Number), [bn, bi] = b.id.split('-').map(Number);
          return (an - bn) || (ai - bi);
        });
      // 正确项：优先用库数据那条正确分支的名字（去掉「的」等差异后比对清单），
      // 脚本 ChoiceEvidence 里写了 CorrectEvidenceId 时再用 id 兜一层。
      const event = choiceEvents.filter(item => item.li > posLi).sort((a, b) => a.li - b.li)[0] || choiceEvents[choiceEvents.length - 1];
      const correctId = event?.correct || null;
      // 库数据的名字会有「的」、缺姓氏等差异（“城崎诺亚尸体照片” vs “城崎诺亚的尸体照片”、“亚里沙” vs “紫藤亚里沙”），
      // 所以先精确比、再互相包含地比。
      const matches = (a, b) => a && b && (a === b || a.includes(b) || b.includes(a));
      const correctKey = branchKey(correctOptions[0].text);
      let correctItem = held.find(item => branchKey(item.name) === correctKey)
        || held.find(item => matches(branchKey(item.name), correctKey))
        || (correctId ? held.find(item => item.id === correctId) : null);
      if (!correctItem) {
        correctItem = { id: correctId || '?', name: clean(correctOptions[0].text) };
        held.push(correctItem);
        report.totals.inventoryForced++;
      }
      const failureBy = new Map();
      let genericFile = null;
      for (const option of branchOptions) {
        if (option.item.isCorrect === true) continue;
        if (!genericFile || option.generic) genericFile = fileOfOption.get(option.key);
        const key = branchKey(option.text);
        if (!failureBy.has(key)) failureBy.set(key, fileOfOption.get(option.key));
      }
      // 把“有名有姓的失败分支”挂到清单里的某一件上。库数据里同一人会有译名差异（蕾雅/蕾娅、橘雪梨/雪莉），
      // 所以精确、互相包含都试过之后，再用“唯一最大共同字”兜一次；并列或一个字都不重合就不猜。
      const failureFor = new Map();
      const usedKeys = new Set();
      for (const [key, file] of failureBy) {
        const hit = held.find(item => {
          const other = branchKey(item.name);
          return other === key || matches(other, key);
        });
        if (hit) { failureFor.set(hit, file); usedKeys.add(key); }
      }
      for (const [key, file] of failureBy) {
        if (usedKeys.has(key)) continue;
        const chars = [...new Set(key)];
        const scored = held.map(item => {
          const other = branchKey(item.name);
          return { item, score: chars.filter(ch => other.includes(ch)).length };
        }).sort((a, b) => b.score - a.score);
        const top = scored[0];
        if (!top || top.score < 1) continue;
        if (scored.filter(entry => entry.score === top.score).length > 1) continue;
        failureFor.set(top.item, file);
        usedKeys.add(key);
      }
      const findFailure = name => {
        const key = branchKey(name);
        if (failureBy.has(key)) return failureBy.get(key);
        for (const [k, file] of failureBy) if (matches(k, key)) return file;
        return null;
      };
      // 同名的两件证物（库里确实有）只留一条，否则选项里会出现两个一模一样的名字。
      const seenNames = new Map();
      for (const item of held) {
        const key = branchKey(item.name);
        const first = seenNames.get(key);
        if (!first) { seenNames.set(key, item); continue; }
        if (item === correctItem) { seenNames.set(key, item); held.splice(held.indexOf(first), 1, item); }
      }
      const unique = [...new Set(held.map(item => item === correctItem ? correctItem : seenNames.get(branchKey(item.name))))].filter(Boolean);
      held.length = 0;
      held.push(...unique);
      const correctFile = fileOfOption.get(correctOptions[0].key);
      const retryFile = publicPath(decisionPath);
      displayedOptions = held.map(item => ({ text: item.name }));
      optionNotes = held.map(() => '');
      for (const key of Object.keys(optionRoutes)) delete optionRoutes[key];
      const records = [];
      for (const [i, item] of held.entries()) {
        const letter = optionLetter(i);
        const isCorrect = item === correctItem;
        const target = isCorrect ? correctFile : (failureFor.get(item) || findFailure(item.name) || genericFile || retryFile);
        optionRoutes[letter] = target;
        records.push({ '选项': letter, '名称': item.name, '正确': isCorrect, '回应': target });
      }
      inventoryIndex[publicPath(decisionPath)] = records;
      // 挂不到清单里任何一件的失败分支：它的回应文件会没人走，记下来（不能默默丢）。
      for (const option of branchOptions) {
        if (option.item.isCorrect === true) continue;
        const file = fileOfOption.get(option.key);
        if (file === genericFile) continue;
        if ([...failureFor.values()].includes(file) || held.some(item => findFailure(item.name) === file)) continue;
        report.inventoryOrphans.push({ '决策文件': publicPath(decisionPath), '分支': clean(option.text), '回应': file });
      }
      report.totals.inventoryStages++;
      report.totals.inventoryOptions += held.length;
      mechanism = hasFailureBranch
        ? `## 机制\n\n这一阶段是游戏里弹出的**${what}清单**：下面列出的就是此刻手机上已解锁的全部${what}（共 ${held.length} 件），挑一件出示；挑错的会被驳回、吃一次伤害，然后退回上一层重选。`
        : `## 机制\n\n这一阶段是游戏里弹出的**${what}清单**：下面列出的就是此刻手机上已解锁的全部${what}（共 ${held.length} 件），挑一件出示；挑错就退回这一题重挑。`;
    } else {
      displayedOptions = [...stage.options];
      const rawNotes = stage.options.map(option => optionNote(option, stageWordLetters.get(option.item.optionId)));
      const branchKinds = [...new Set(branchOptions.map(option => option.kind))];
      let notes = rawNotes.map(note => note || (keywordStage ? '普通选项（不是关键字）' : ''));
      // 没能按清单出题的阶段（只剩失败分支、或证物与普通选项混在一起）一律不给正误标记，
      // 否则「正确的证物」/「挑错证物」本身就是答案。
      notes = notes.map(note => /正确的|挑错/.test(note) ? '' : note);
      optionNotes = notes;
      const branchWhat = branchKinds.length === 2 ? '证物或人物档案' : branchKinds[0] === 'witness' ? '人物档案' : '证物';
      mechanism = keywordStage
        ? '## 机制\n\n这里的选项不是菜单，而是台词里被「〔　〕」圈出的**关键字**：点中哪个词，就等于做出哪个选择。同一段台词里可能同时出现多个关键字，点哪一个由你决定。'
        : branchKinds.length
          ? `## 机制\n\n这一阶段是从你手上的${branchWhat}里挑一件（游戏里会弹出清单）：点错的会被驳回、吃一次伤害，然后退回上一层重选。`
          : '## 机制\n\n这一阶段是普通选项：直接选字母即可，台词里没有要点的词。';
    }
    if (timeoutTarget) {
      const letter = optionLetter(displayedOptions.length);
      displayedOptions.push({ text: '让时间耗尽' });
      optionNotes.push(keywordStage ? '不点击任何关键字，等审判计时耗尽' : '什么都不做，等审判计时耗尽');
      optionRoutes[letter] = timeoutTarget;
      report.totals.trialChoices++;
    }
    // 脚本里真的有两个同名选项时，至少告诉玩家它们通往不同回应。
    const nameCount = new Map();
    for (const option of displayedOptions) { const text = clean(option.text || ''); nameCount.set(text, (nameCount.get(text) || 0) + 1); }
    for (let i = 0; i < displayedOptions.length; i++) {
      if (nameCount.get(clean(displayedOptions[i].text || '')) < 2) continue;
      optionNotes[i] = optionNotes[i] ? `${optionNotes[i]}；同名选项，通往不同回应` : '同名选项，通往不同回应';
    }
    const decisionBody = `${mechanism}\n\n${choiceMd(displayedOptions, optionNotes, keywordStage).trim()}`;
    const emitted = await emit(decisionPath, '魔女审判', decisionBody, { '选项': optionRoutes });
    decisionFiles.add(emitted);
  }

  const firstDecision = model.initial && publicPath(stagePath.get(model.initial.id));
  const entryNext = firstDecision || storyNext;
  const scene = cutscenes.get(node.id);
  const entryBody = dialogueMd(mainline, names, scene?.after, scene?.before, keyword);
  const emitted = await emit(entryPath, '魔女审判', entryBody || '审判继续。', entryNext ? { '继续': entryNext } : {});
  attachKeywords(publicPath(entryPath));
  if (!entryNext) terminalFiles.add(emitted);
}
async function buildAct(act, nodes, annotations, evidence, names) {
  const actDir = join(outputRoot, act === 1 ? '一周目' : '二周目');
  const chapters = act === 1 ? 5 : 6;
  report.acts[act] = { chapters, nodes: nodes.length };
  for (let c = 1; c <= chapters; c++) for (const sub of ['正文', '魔女审判', '素材']) await mkdir(join(actDir, `第${String(c).padStart(2, '0')}章`, sub), { recursive: true });
  const placements = new Map();
  for (let c = 1; c <= chapters; c++) {
    const chapterDir = join(actDir, `第${String(c).padStart(2, '0')}章`);
    const p = await makePortraits(act, chapterDir, nodes);
    for (const [k, v] of p) placements.set(k, v);
    await copyEvidence(act, c, evidence, chapterDir);
  }
  const serials = { normal: Array(chapters + 1).fill(0), trial: 0 };
  const nodeEntry = new Map();
  const effectiveNext = buildEffectiveNext(nodes);
  // 审判里的“手上清单”要按解锁时机算，先把本周目的图鉴解锁时间轴摆好。
  ({ order: unlockOrder, indexOf: nodeIndexOf, pathOf: storyPathOf } = await makeUnlockOrder(nodes));
  deliveredRecords = new Set();
  reenactByChapter.clear();
  reenactCopied.clear();
  reenactSerials.clear();
  const { placements: cutscenes, badEndIds, commonChapters } = await makeCutscenes(act, actDir, nodes);
  // 开局就装在手机里的图鉴（规定 1–5、记录 1–7）：挂在第一次提到「魔女图鉴」的那一句后面。
  const mentionNode = nodes.find(node => (node.dialogue || []).some(line => (line.text || '').includes('魔女图鉴')));
  const mentionLine = mentionNode?.dialogue.find(line => (line.text || '').includes('魔女图鉴'));
  if (mentionNode && mentionLine) {
    // 开局的图鉴内容：规定 + 记录 + 人物档案；证物不在这里发（解锁时机各不相同）。
    const initialItems = witchbookInitial
      .filter(record => ['Rule', 'Note', 'Profile'].includes(record.category))
      .map(record => witchbookItem(record))
      .filter(Boolean);
    if (initialItems.length) {
      const placement = cutscenes.get(mentionNode.id) || { before: [], after: new Map() };
      placement.after.set(mentionLine.label, [...(placement.after.get(mentionLine.label) || []), ...initialItems]);
      cutscenes.set(mentionNode.id, placement);
    }
  }
  let activeChapter = 0, activeBadEndId = null;
  for (const node of nodes.filter(node => ['ti', 'tr'].includes(node.type))) {
    const chapter = chapterOf(node);
    if (chapter !== activeChapter) { activeChapter = chapter; activeBadEndId = null; }
    if (badEndIds.has(node.id)) activeBadEndId = badEndIds.get(node.id);
    if (activeBadEndId) badEndIds.set(node.id, activeBadEndId);
  }
  const includedNodes = nodes.filter(node => !/^CommonBad/i.test(node.id) || commonChapters.has(Number(node.id.match(/\d+$/)?.[0])));
  for (const node of includedNodes) for (const [index, line] of (node.dialogue || []).entries()) {
    const key = `${act}:${node.id}:${index}`;
    sourceDialogueLabels.add(line.label);
    sourceLines.add(key);
    sourceLineKeys.set(line, key);
  }
  const normalNodes = nodes.filter(n => n.level !== 0 && !['ti', 'tr'].includes(n.type) && !/^CommonBad/i.test(n.id));
  for (const node of normalNodes) {
    const chapter = chapterOf(node);
    const dir = join(actDir, `第${String(chapter).padStart(2, '0')}章`, '正文');
    const number = String(++serials.normal[chapter]).padStart(3, '0');
    const path = join(dir, `场景-${number}.md`);
    nodeEntry.set(node.id, publicPath(path));
  }
  const commonTargets = new Map();
  for (const [badId, usedChapters] of commonChapters) {
    const node = nodes.find(candidate => candidate.id.toLowerCase() === `commonbad${String(badId).padStart(2, '0')}`.toLowerCase());
    if (!node) continue;
    for (const chapter of usedChapters) {
      const path = join(actDir, `第${String(chapter).padStart(2, '0')}章`, '魔女审判', `审判支线-${String(badId).padStart(2, '0')}.md`);
      const scene = cutscenes.get(`${node.id}:${chapter}`);
      const emitted = await emit(path, '审判结果', dialogueMd(node.dialogue || [], names, scene?.after, scene?.before) || '审判结束。', {});
      commonTargets.set(`${chapter}:${badId}`, emitted);
      terminalFiles.add(emitted);
      trialBranchFiles.add(emitted);
    }
  }
  for (const node of nodes.filter(n => ['ti', 'tr'].includes(n.type))) await buildTrialNode(node, actDir, chapterOf(node), annotations, names, serials, nodeEntry, effectiveNext, cutscenes, badEndIds, commonTargets);
  const actName = act === 1 ? '一周目' : '二周目';
  // 每章一份「事件插画」快照：审判收尾再現用到的底图
  for (const [chapter, images] of reenactByChapter) {
    const chapterDir = join(actDir, `第${String(chapter).padStart(2, '0')}章`);
    const emitted = await emit(join(chapterDir, '事件插画.md'), '事件插画', images.map(itemMd).join('\n\n'), {});
    const boardKey = `${actName}/第${String(chapter).padStart(2, '0')}章`;
    (reenactBoards[boardKey] ||= []).push(emitted);
    referenceFiles.add(emitted);
    report.totals.reenactFiles++;
  }
  // 每个插过图鉴条目的场景，另外出一份「手机 APP 快照」，供主持人单独补发或复查。
  for (const [nodeId, placement] of cutscenes) {
    const records = [...placement.before, ...[...placement.after.values()].flat()].filter(item => item.kind === 'witchbook');
    if (!records.length) continue;
    const scenePath = nodeEntry.get(nodeId);
    if (!scenePath) continue;
    const chapter = chapterOf(nodes.find(node => node.id === nodeId) || {});
    const target = resolve(scenePath.replace(/\.md$/, '-图鉴.md'));
    const emitted = await emit(target, '魔女图鉴', records.map(itemMd).join('\n\n<!-- line -->\n\n'), {});
    const boardKey = `${actName}/第${String(chapter).padStart(2, '0')}章`;
    (witchbookBoards[boardKey] ||= []).push(emitted);
    referenceFiles.add(emitted);
    report.totals.witchbookFiles++;
  }
  for (const node of normalNodes) {
    const chapter = chapterOf(node), path = resolve(root, nodeEntry.get(node.id));
    const scene = cutscenes.get(node.id);
    const imageAfter = new Map(scene?.after || []);
    for (const d of node.dialogue || []) {
      const image = placements.get(`${node.id}:${d.label}`);
      if (image) imageAfter.set(d.label, [...(imageAfter.get(d.label) || []), image]);
    }
    const dialogue = node.dialogue || [];
    const choices = (node.choices || []).filter(c => !/return/i.test(c.id || ''));
    const split = choices.length ? choiceSplits.get(node.id.toLowerCase()) : null;
    // 库数据里读不到选择点就得报出来：否则正文会退回“把选后内容提前读掉”的旧毛病。
    if (choices.length && !split) unsplitChoices.push(node.id);
    else if (split && split.count !== choices.length) unsplitChoices.push(`${node.id}（选项 ${choices.length} ≠ 剧本 ${split.count}）`);
    // 选择点夹在节点中间时：正文在那一句截断，被选中的分支接着读剩下的原文。
    const cut = split && split.count === choices.length && split.split > 0 && split.split < dialogue.length ? split.split : null;
    let tailPath = null, tailOwner = -1;
    if (cut !== null) {
      tailPath = join(resolve(path, '..'), `${basename(path, '.md')}-后续.md`);
      tailOwner = choices.findIndex(c => c.leadsTo === 'continue');
      if (tailOwner < 0) tailOwner = choices.findIndex(c => !c.isBadEnd && c.leadsTo && c.leadsTo !== 'continue');
      if (tailOwner < 0) tailPath = null;
    }
    const optionRoutes = {};
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i];
      const target = tailPath && i === tailOwner ? publicPath(tailPath)
        : c.leadsTo === 'continue' ? effectiveNext(node) : effectiveNext.target(c.leadsTo);
      optionRoutes[optionLetter(i)] = target || null;
      report.totals.normalChoices++;
    }
    const next = effectiveNext(node);
    const route = choices.length ? { '选项': optionRoutes } : (next ? { '继续': next } : {});
    const body = tailPath ? dialogue.slice(0, cut) : dialogue;
    const emitted = await emit(path, '故事', `${dialogueMd(body, names, imageAfter, scene?.before)}${choiceMd(choices)}`.trim() || '故事继续。', route);
    if (choices.length) decisionFiles.add(emitted);
    if (!choices.length && !next) terminalFiles.add(emitted);
    if (tailPath) {
      const tailRoute = next ? { '继续': next } : {};
      const emittedTail = await emit(tailPath, '故事', dialogueMd(dialogue.slice(cut), names, imageAfter) || '故事继续。', tailRoute);
      if (!next) terminalFiles.add(emittedTail);
      report.totals.splitChoiceNodes++;
    }
  }
  for (const route of Object.values(routes)) {
    for (const [key, value] of Object.entries(route)) {
      if (key === '选项') for (const [letter, id] of Object.entries(value)) value[letter] = nodeEntry.get(id) || id;
      else route[key] = nodeEntry.get(value) || value;
    }
  }
  const first = nodes.find(n => n.id === `0${act}01Adv01`) || nodes.find(n => chapterOf(n) === 1);
  return nodeEntry.get(first?.id);
}
async function validate(starts) {
  const files = new Set(Object.keys(routes));
  const missing = [];
  for (const [from, route] of Object.entries(routes)) for (const target of Object.values(route['选项'] || route)) {
    if (target && !files.has(target)) missing.push({ from, target });
  }
  const forbidden = /(?:bad|good|\bBE\b|\bHE\b|正确|错误|结局类型)/i;
  const leaked = [...files].filter(f => forbidden.test(f));
  const brokenImages = [], leakedTitles = [];
  for (const file of files) {
    const absolute = resolve(root, file);
    const text = await readFile(absolute, 'utf8');
    if (forbidden.test(text.split(/\r?\n/, 1)[0])) leakedTitles.push(file);
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = resolve(absolute, '..', match[1]);
      if (!existsSync(target)) brokenImages.push({ file, target: match[1] });
    }
  }
  const trapped = [];
  for (const decision of decisionFiles) {
    const replies = Object.values(routes[decision]?.['选项'] || {});
    const canLeave = replies.some(reply => {
      const next = Object.values(routes[reply] || {})[0];
      return next !== decision;
    });
    if (!canLeave) trapped.push(decision);
  }
  const deadStarts = [];
  const referenced = new Set(Object.values(routes).flatMap(route => Object.values(route['选项'] || route)).filter(Boolean));
  const orphanedTrialBranches = [...trialBranchFiles].filter(file => !referenced.has(file));
  function reachesEnd(start) {
    const seen = new Set(), queue = [start];
    while (queue.length) {
      const file = queue.shift();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      if (terminalFiles.has(file)) return true;
      for (const target of Object.values(routes[file]?.['选项'] || routes[file] || {})) if (target) queue.push(target);
    }
    return false;
  }
  const reachable = new Set(), pending = Object.values(starts);
  while (pending.length) {
    const file = pending.shift();
    if (!file || reachable.has(file)) continue;
    reachable.add(file);
    for (const target of Object.values(routes[file]?.['选项'] || routes[file] || {})) if (target) pending.push(target);
  }
  // 可达文件必须都能走到结局：闭合成环却没有出口的分支会把游玩卡在中间。
  const stuckFiles = [...reachable].filter(file => !reachesEnd(file));
  // 每章正文都必须可达：否则整章（例如二周目第六章的结局）会被漏在路线之外。
  const sceneChapters = new Set(), reachableScenes = new Set();
  for (const file of files) { const match = file.match(/^(游戏包\/[^/]+\/第\d+章)\/正文\//); if (match) sceneChapters.add(match[1]); }
  for (const file of reachable) { const match = file.match(/^(游戏包\/[^/]+\/第\d+章)\/正文\//); if (match) reachableScenes.add(match[1]); }
  const unreachableChapters = [...sceneChapters].filter(chapter => !reachableScenes.has(chapter));
  report.unreachableFiles = [...files].filter(file => !reachable.has(file) && !referenceFiles.has(file));
  report.referenceFiles = [...referenceFiles].sort();
  for (const [act, start] of Object.entries(starts)) if (!files.has(start) || !reachesEnd(start)) deadStarts.push({ act, start });
  report.totals.reachableFiles = reachable.size;
  report.totals.unreachableFiles = report.unreachableFiles.length;
  const missingDialogue = [...sourceLines].filter(key => !emittedSourceLines.has(key));
  if (missing.length || leaked.length || leakedTitles.length || brokenImages.length || trapped.length || deadStarts.length || orphanedTrialBranches.length || stuckFiles.length || unreachableChapters.length || unsplitChoices.length || missingDialogue.length) {
    throw new Error(`自检失败\n${JSON.stringify({ missing: missing.slice(0, 20), leaked, leakedTitles, brokenImages: brokenImages.slice(0, 20), trapped, deadStarts, stuckFiles: stuckFiles.slice(0, 20), unreachableChapters, unsplitChoices, orphanedTrialBranches, missingDialogue: missingDialogue.slice(0, 20) }, null, 2)}`);
  }
}
/**
 * 结局插画：片尾 credits 用的小插图（画廊 ending 分类）。
 * 正文里没有任何脚本引用，所以不插剧情，只作为参考文件放在 游戏包/结局插画/。
 */
async function buildEndingGallery() {
  const gallery = await json(join(sourceRoot, 'data', 'gallery-manifest.json'));
  const items = gallery.items.filter(item => item.category === 'ending' && item.file.startsWith('stills/'));
  if (!items.length) return;
  const dir = join(outputRoot, '结局插画');
  await mkdir(dir, { recursive: true });
  const list = [];
  for (const [index, item] of items.entries()) {
    const src = join(sourceRoot, 'assets', 'cg', item.file);
    if (!existsSync(src)) continue;
    const file = `结局插画-${String(index + 1).padStart(2, '0')}.webp`;
    await cp(src, join(dir, file));
    list.push({ alt: '结局插画', path: posix(join(dir, file)) });
    report.totals.images++;
    report.totals.endingImages++;
  }
  if (!list.length) return;
  const emitted = await emit(join(dir, '结局插画.md'), '结局插画', list.map(itemMd).join('\n\n'), {});
  (endingBoards['结局'] ||= []).push(emitted);
  referenceFiles.add(emitted);
  report.totals.endingFiles++;
}

async function main() {
  await ensureSource();
  await stat(join(sourceRoot, 'data', 'act01.json'));
  report.sourceCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await rm(outputRoot, { recursive: true, force: true });
  await rm(hostRoot, { recursive: true, force: true });
  await mkdir(hostRoot, { recursive: true });
  const chars = await json(join(sourceRoot, 'data', 'chara-index.json'));
  const names = speakerMap(chars);
  speakerNames = names;
  await loadChoiceSplits();
  witchbookData = existsSync(join(storyRoot, 'witchbook.json')) ? await json(join(storyRoot, 'witchbook.json')) : null;
  witchbookInitial = existsSync(join(storyRoot, 'witchbook-initial.json')) ? await json(join(storyRoot, 'witchbook-initial.json')) : [];
  reenactMap = existsSync(join(storyRoot, 'reenact.json')) ? await json(join(storyRoot, 'reenact.json')) : null;
  const evidence = (await json(join(sourceRoot, 'data', 'evidence.json'))).evidence;
  const starts = {};
  for (const act of [1, 2]) {
    const nodes = (await json(join(sourceRoot, 'data', `act0${act}.json`))).nodes;
    const annotations = (await json(join(sourceRoot, 'data', `annotations.act0${act}.json`))).trialChoices;
    starts[act === 1 ? '一周目' : '二周目'] = await buildAct(act, nodes, annotations, evidence, names);
  }
  await buildEndingGallery();
  const gallery = await json(join(sourceRoot, 'data', 'gallery-manifest.json'));
  report.totals.locatedStills = locatedGalleryStills.size;
  report.totals.locatedTricks = locatedGalleryTricks.size;
  report.unlocatedStills = gallery.items.filter(item => item.category === 'stills' && !locatedGalleryStills.has(item.id)).map(item => item.id);
  await validate(starts);
  report.totals.sourceDialogue = sourceLines.size;
  report.totals.uniqueDialogue = sourceDialogueLabels.size;
  report.totals.repeatedDialogue = report.totals.dialogueInstances - report.totals.sourceDialogue;
  await writeFile(join(hostRoot, '路线索引.json'), JSON.stringify({ sourceCommit: report.sourceCommit, '起点': starts, '证物栏': evidenceBoards, '魔女图鉴': witchbookBoards, '事件插画': reenactBoards, '结局插画': endingBoards, '关键字': keywordIndex, '清单': inventoryIndex, '路由': routes }, null, 2), 'utf8');
  await writeFile(join(hostRoot, '构建报告.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`构建完成：${report.totals.files} 个 Markdown，${report.totals.dialogueInstances} 个对白实例，${report.totals.images} 张图片。`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
