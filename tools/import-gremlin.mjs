// Imports a Desktop_Gremlin character folder into a Desk Pet character pack.
//
//   node tools/import-gremlin.mjs <gremlin-char-dir> [--id myid] [--name 名字]
//
// Desktop_Gremlin layout (verified against Kritzkingvoid/Desktop_Gremlin @ HEAD):
//   config.txt              KEY=frames, plus WIDTH/HEIGHT/COLUMN
//   Actions/*.png           idle, sleep, click, grab, hover, intro, outro, runIdle
//   Emotes/emote{1..4}.png
//   Walk/walk{Up,Down,Left,Right}.png
//   Run/{runUp,runDown,runLeft,runRight,upLeft,upRight,downLeft,downRight}.png
//
// Sheets are a row-major grid of WIDTH x HEIGHT cells, COLUMN per row, and the C#
// player runs them at SPRITE_FRAMERATE (60 in the shipped config).

import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_FPS = 60;

export function parseConfig(text) {
  const cfg = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('//') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    cfg[t.slice(0, i).trim().toUpperCase()] = t.slice(i + 1).trim();
  }
  return cfg;
}

const num = (cfg, key) => {
  const v = Number(cfg[key]);
  return Number.isFinite(v) ? v : 0;
};

// Reads width/height out of a PNG IHDR, so the importer can check the declared frame
// count actually fits the sheet instead of trusting config.txt.
async function pngSize(path) {
  const buf = await readFile(path);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`不是 PNG: ${path}`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(24 - 4) };
}

// Which sheet each animation lives in, and which config key holds its frame count.
const CLIPS = [
  ['idle', 'Actions/idle.png', 'IDLE'],
  ['runIdle', 'Actions/runIdle.png', 'RUNIDLE'],
  ['hover', 'Actions/hover.png', 'HOVER'],
  ['sleep', 'Actions/sleep.png', 'SLEEP'],
  ['click', 'Actions/click.png', 'CLICK'],
  ['grab', 'Actions/grab.png', 'GRAB'],
  ['intro', 'Actions/intro.png', 'INTRO'],
  ['outro', 'Actions/outro.png', 'OUTRO'],
  ['emote1', 'Emotes/emote1.png', 'EMOTE1'],
  ['emote2', 'Emotes/emote2.png', 'EMOTE2'],
  ['emote3', 'Emotes/emote3.png', 'EMOTE3'],
  ['emote4', 'Emotes/emote4.png', 'EMOTE4'],
  ['walkDown', 'Walk/walkDown.png', 'WALKDOWN'],
  ['walkUp', 'Walk/walkUp.png', 'WALKUP'],
  ['walkLeft', 'Walk/walkLeft.png', 'WALKLEFT'],
  ['walkRight', 'Walk/walkRight.png', 'WALKRIGHT'],
  ['runDown', 'Run/runDown.png', 'RUNDOWN'],
  ['runUp', 'Run/runUp.png', 'RUNUP'],
  ['runLeft', 'Run/runLeft.png', 'RUNLEFT'],
  ['runRight', 'Run/runRight.png', 'RUNRIGHT'],
];

// Releases before v3 ship a flat folder: every sheet sits directly in the character
// directory, filenames differ, and config.txt uses another set of keys. Detected from
// disk rather than from a version string, because the version is not in the pack.
const CLIPS_FLAT = [
  ['idle', 'idle.png', 'IDLE'],
  ['idle2', 'idle2.png', 'IDLE2'],
  ['runIdle', 'wIdle.png', 'WALK_IDLE'],
  ['hover', 'hover.png', 'HOVER'],
  ['sleep', 'sleep.png', 'SLEEP'],
  ['click', 'click.png', 'CLICK'],
  ['grab', 'grab.png', 'GRAB'],
  ['pat', 'pat.png', 'PAT'],
  ['intro', 'intro.png', 'INTRO'],
  ['outro', 'outro.png', 'OUTRO'],
  ['emote1', 'emote1.png', 'EMOTE1'],
  ['emote2', 'emote2.png', 'EMOTE2'],
  ['emote3', 'emote3.png', 'EMOTE3'],
  ['emote4', 'emote4.png', 'EMOTE4'],
  ['walkDown', 'walkDown.png', 'WALK_D'],
  ['walkUp', 'walkUp.png', 'WALK_U'],
  ['walkLeft', 'walkL.png', 'WALK_L'],
  ['walkRight', 'walkR.png', 'WALK_R'],
  ['runDown', 'forward.png', 'DOWN'],
  ['runUp', 'backward.png', 'UP'],
  ['runLeft', 'left.png', 'LEFT'],
  ['runRight', 'right.png', 'RIGHT'],
];

// `pat` and `idle2` only exist in the flat layout.
const ACTION_DESC_FLAT = {
  pat: 'reacting to a head pat — bashful, content',
  idle2: 'a second idle — relaxed',
};

// Continuous states pick a looping clip; `away` renders nothing.
const STATE_MAP = {
  idle: 'idle',
  happy: 'runIdle',
  curious: 'hover',
  sleepy: 'sleep',
  annoyed: 'emote4',
  away: null,
};

// Descriptions go into the model prompt, so they decide when each action gets used.
// The emote meanings are a guess per pack — run `npm run preview` and edit these.
const ACTION_DESC = {
  emote1: 'expressive animation 1 — meaning not yet confirmed; watch the preview and edit this line',
  emote2: 'expressive animation 2 — meaning not yet confirmed; watch the preview and edit this line',
  emote3: 'expressive animation 3 — meaning not yet confirmed; watch the preview and edit this line',
  emote4: 'expressive animation 4 — meaning not yet confirmed; watch the preview and edit this line',
  click: 'reacting to being clicked — acknowledging you, being poked',
  grab: 'reacting to being picked up — startled, resigned',
  intro: 'entering — a greeting, a beginning',
  outro: 'leaving — a goodbye, an ending',
  hover: 'noticing you come closer — curious, leaning in for a look',
  runIdle: 'idling brightly — in a good mood',
  walkDown: 'walking a couple of steps downward', walkUp: 'walking a couple of steps upward',
  walkLeft: 'walking a couple of steps to the left', walkRight: 'walking a couple of steps to the right',
  runDown: 'running downward', runUp: 'running upward',
  runLeft: 'running to the left', runRight: 'running to the right',
};

// Not offered to the model: continuous loops it should not one-shot.
const NOT_ACTIONS = new Set(['idle', 'sleep']);

// The fast loop reacts with semantic action names, but a Gremlin pack ships the source
// game's names, so without this bridge an imported character never moves on its own —
// only the slow loop (which sees the pack's real names) could drive it.
//
// hover/intro/outro/click are named clearly enough to trust. The emote mappings are
// guesses: run the pack, watch them, and re-point them here if they read wrong.
const ALIASES = {
  peek: 'hover',
  wave: 'intro',
  sulk: 'outro',
  nod: 'click',
  jump: 'runIdle',
  shake: 'emote4',
  cheer: 'emote1',
  tilt: 'emote2',
  stretch: 'emote3',
  spin: 'runRight',
};

export async function importGremlin(srcDir, { id, name, outRoot = join(ROOT, 'characters') } = {}) {
  const src = resolve(srcDir);
  const cfgPath = join(src, 'config.txt');
  if (!existsSync(cfgPath)) throw new Error(`找不到 config.txt: ${cfgPath}`);

  const cfg = parseConfig(await readFile(cfgPath, 'utf8'));
  const cell = { w: num(cfg, 'WIDTH'), h: num(cfg, 'HEIGHT') };
  const columns = num(cfg, 'COLUMN');
  if (!(cell.w > 0 && cell.h > 0 && columns > 0)) {
    throw new Error(`config.txt 缺少 WIDTH/HEIGHT/COLUMN（读到 ${JSON.stringify({ cell, columns })}）`);
  }

  // Nested layout keeps sheets under Actions/; flat keeps them beside config.txt.
  const nested = existsSync(join(src, 'Actions', 'idle.png'));
  const clipTable = nested ? CLIPS : CLIPS_FLAT;
  const descTable = nested ? ACTION_DESC : { ...ACTION_DESC, ...ACTION_DESC_FLAT };

  const packId = id ?? (basename(src).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'imported');
  const outDir = join(outRoot, packId);
  await mkdir(outDir, { recursive: true });

  const clips = {};
  const warnings = [];
  for (const [clipName, rel, key] of clipTable) {
    const abs = join(src, rel);
    if (!existsSync(abs)) continue;
    const declared = num(cfg, key);
    const { w, h } = await pngSize(abs);
    const capacity = Math.floor(w / cell.w) * Math.floor(h / cell.h);
    if (capacity <= 0) { warnings.push(`${rel}: 图幅 ${w}x${h} 装不下一个 ${cell.w}x${cell.h} 的 cell，跳过`); continue; }
    let frames = declared;
    if (frames <= 0) {
      frames = capacity;
      warnings.push(`${rel}: config.txt 未声明 ${key}，按图幅推断为 ${frames} 帧`);
    } else if (frames > capacity) {
      warnings.push(`${rel}: 声明 ${frames} 帧但图幅只装得下 ${capacity}，按 ${capacity} 处理`);
      frames = capacity;
    }
    const dest = rel.replace(/\//g, '_');
    await copyFile(abs, join(outDir, dest));
    clips[clipName] = { sheet: dest, frames };
  }

  if (Object.keys(clips).length === 0) throw new Error('没有找到任何可用的精灵图');

  const states = {};
  for (const [state, clipName] of Object.entries(STATE_MAP)) {
    if (clipName == null) { states[state] = {}; continue; }
    // Fall back through near-equivalents before giving up on idle, so a pack that
    // lacks runIdle still gets a distinct `happy` rather than collapsing to one loop.
    const FALLBACK = { runIdle: ['idle2', 'hover', 'idle'], hover: ['idle2', 'idle'],
      sleep: ['idle2', 'idle'], emote4: ['emote1', 'emote2', 'idle'] };
    const chain = [clipName, ...(FALLBACK[clipName] ?? []), 'idle'];
    const picked = chain.find((n) => clips[n]);
    const clip = picked ? clips[picked] : null;
    if (!clip) { warnings.push(`状态 ${state} 找不到对应动画，也没有 idle 兜底`); continue; }
    if (picked !== clipName) warnings.push(`状态 ${state} 想用 ${clipName}，缺失，回退到 ${picked}`);
    states[state] = { ...clip };
  }

  const actions = {};
  for (const [clipName, clip] of Object.entries(clips)) {
    if (NOT_ACTIONS.has(clipName)) continue;
    actions[clipName] = { ...clip, desc: descTable[clipName] ?? clipName };
  }

  // Drop aliases whose target this pack does not actually have, or the pack fails
  // validation and the whole character is skipped at load time.
  const aliases = {};
  for (const [from, to] of Object.entries(ALIASES)) {
    if (actions[to]) aliases[from] = to;
    else warnings.push(`别名 ${from} 想指向 ${to}，这个包没有，已省略`);
  }

  const pack = {
    id: packId,
    name: name ?? packId,
    renderer: 'sheet',
    source: 'Desktop_Gremlin',
    fps: DEFAULT_FPS,
    scale: 1,
    cell,
    columns,
    persona: '',
    voice: { lang: 'en-US', voiceHint: 'Samantha', rate: 1, pitch: 1.05 },
    aliases,
    states,
    actions,
  };

  await writeFile(join(outDir, 'character.json'), `${JSON.stringify(pack, null, 2)}\n`);
  await writeIndex(outRoot);
  return { pack, outDir, warnings, clipCount: Object.keys(clips).length };
}

// The renderer cannot list a directory over http, so installed packs are discovered
// through this index. Rewritten from disk on every import.
export async function writeIndex(outRoot = join(ROOT, 'characters')) {
  const entries = [];
  for (const e of await readdir(outRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(outRoot, e.name, 'character.json');
    if (!existsSync(p)) continue;
    const pack = JSON.parse(await readFile(p, 'utf8'));
    entries.push({ id: pack.id, name: pack.name, dir: e.name, renderer: pack.renderer });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(join(outRoot, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

export async function listPacks(outRoot = join(ROOT, 'characters')) {
  if (!existsSync(outRoot)) return [];
  const out = [];
  for (const entry of await readdir(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(outRoot, entry.name, 'character.json');
    if (existsSync(p)) out.push(JSON.parse(await readFile(p, 'utf8')));
  }
  return out;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const srcDir = args.find((a) => !a.startsWith('--'));
  const flag = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!srcDir) {
    console.error('用法: node tools/import-gremlin.mjs <gremlin角色目录> [--id myid] [--name 名字]');
    process.exit(2);
  }
  try {
    const { pack, outDir, warnings, clipCount } = await importGremlin(srcDir, {
      id: flag('id'), name: flag('name'),
    });
    console.log(`导入 ${pack.name} (${pack.id}) -> ${outDir}`);
    console.log(`  cell ${pack.cell.w}x${pack.cell.h}  columns ${pack.columns}  fps ${pack.fps}`);
    console.log(`  ${clipCount} 个动画：states ${Object.keys(pack.states).length}，actions ${Object.keys(pack.actions).length}`);
    for (const w of warnings) console.log(`  ! ${w}`);
    if (Object.keys(pack.actions).some((k) => k.startsWith('emote'))) {
      console.log('  提示：emote1-4 的含义未确认，改 character.json 里的 desc 才能让模型用对');
    }
  } catch (e) {
    console.error(`导入失败: ${e.message}`);
    process.exit(1);
  }
}
