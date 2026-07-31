import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionPlayer, BUILTIN_ACTIONS, BUILTIN_PACKS, DEFAULT_PACK,
  actionVocabulary, normalizePack, validatePack,
} from '../characters.js';

const PROC_STATES = { idle: {}, happy: {}, sleepy: {}, annoyed: {}, curious: {}, away: {} };

const sheetPack = () => ({
  id: 'sheeted', name: '表', renderer: 'sheet', columns: 4, cell: { w: 100, h: 120 }, fps: 10,
  states: {
    idle: { sheet: 'a.png', frames: 8 },
    happy: { sheet: 'a.png', frames: 8 },
    sleepy: { sheet: 'a.png', frames: 8 },
    annoyed: { sheet: 'a.png', frames: 8 },
    curious: { sheet: 'a.png', frames: 8 },
    away: {},
  },
  actions: { nod: { sheet: 'b.png', frames: 5 } },
});

test('每个内置角色包都能通过校验并归一化', () => {
  for (const p of BUILTIN_PACKS) {
    assert.deepEqual(validatePack(p), [], `${p.id} 校验失败`);
    const n = normalizePack(p);
    assert.equal(n.id, p.id);
    assert.equal(n.renderer, 'procedural');
    assert.ok(n.look.palette.idle.body, `${p.id} 缺少 idle 配色`);
  }
  assert.ok(BUILTIN_PACKS.length >= 3, '至少要有三个内置角色，切换才看得出区别');
});

test('内置角色的外观互不相同', () => {
  const shapes = new Set(BUILTIN_PACKS.map((p) => normalizePack(p).look.shape));
  const colors = new Set(BUILTIN_PACKS.map((p) => normalizePack(p).look.palette.idle.body));
  assert.equal(shapes.size, BUILTIN_PACKS.length);
  assert.equal(colors.size, BUILTIN_PACKS.length);
});

test('校验会报出缺失字段', () => {
  assert.deepEqual(validatePack(null), ['pack 不是对象']);
  const e = validatePack({ name: 'x', renderer: 'webgl', states: {} });
  assert.ok(e.some((m) => m.includes('缺少 id')));
  assert.ok(e.some((m) => m.includes('renderer')));
  assert.ok(e.some((m) => m.includes('states 缺少 idle')));
});

test('sheet 包必须声明网格尺寸和每段的帧数', () => {
  const bad = { ...sheetPack(), columns: 0, cell: null };
  const e = validatePack(bad);
  assert.ok(e.some((m) => m.includes('cell')));
  assert.ok(e.some((m) => m.includes('columns')));

  const missingFrames = sheetPack();
  missingFrames.actions.nod = { sheet: 'b.png' };
  assert.ok(validatePack(missingFrames).some((m) => m.includes('actions.nod')));

  assert.deepEqual(validatePack(sheetPack()), []);
});

test('normalizePack 不合法时抛错', () => {
  assert.throws(() => normalizePack({ name: '没有 id' }), /角色包不合法/);
});

test('look 的调色板是深合并，只覆盖写到的状态', () => {
  const n = normalizePack({
    id: 'p', name: 'p', states: PROC_STATES,
    look: { shape: 'cat', palette: { idle: { body: '#ff0000', cheek: '#00ff00' } } },
  });
  assert.equal(n.look.shape, 'cat');
  assert.equal(n.look.palette.idle.body, '#ff0000');
  // 没写的状态回落到默认，否则切到 sleepy 会直接没颜色
  assert.equal(n.look.palette.sleepy.body, DEFAULT_PACK.look.palette.sleepy.body);
  assert.equal(n.look.ears, 'round');
});

test('sheet 段的 durationMs 由 frames/fps 推出来', () => {
  const n = normalizePack(sheetPack());
  // 5 帧 @ 10fps = 500ms
  assert.equal(n.actions.nod.durationMs, 500);
  assert.equal(n.actions.nod.fps, 10);
});

test('显式写的 durationMs 优先于推算值', () => {
  const p = sheetPack();
  p.actions.nod.durationMs = 1234;
  assert.equal(normalizePack(p).actions.nod.durationMs, 1234);
});

test('procedural 包不写 actions 时拿到全套内置动作', () => {
  const n = normalizePack({ id: 'p', name: 'p', states: PROC_STATES });
  assert.deepEqual(Object.keys(n.actions).sort(), Object.keys(BUILTIN_ACTIONS).sort());
});

test('动作词表带描述，是喂给模型的那份', () => {
  const vocab = actionVocabulary(normalizePack(DEFAULT_PACK));
  assert.ok(vocab.length >= 10);
  const nod = vocab.find((a) => a.name === 'nod');
  assert.ok(nod.desc.includes('同意'));
  assert.ok(vocab.every((a) => a.desc && a.desc !== a.name), '每个动作都要有中文描述');
});

test('新增动作会自动出现在词表里，不用改代码', () => {
  const n = normalizePack({
    id: 'p', name: 'p', states: PROC_STATES,
    actions: { ...BUILTIN_ACTIONS, dance: { durationMs: 2000, desc: '跳舞：非常高兴' } },
  });
  const vocab = actionVocabulary(n);
  assert.ok(vocab.some((a) => a.name === 'dance' && a.desc.includes('跳舞')));
  const player = new ActionPlayer(n);
  assert.equal(player.playAction('dance', 0), true);
});

test('未知动作被丢掉而不是抛错', () => {
  const p = new ActionPlayer(DEFAULT_PACK);
  assert.equal(p.playAction('breakdance', 0), false);
  assert.equal(p.busy, false);
  assert.equal(p.sample(0).action, null);
});

test('非法状态名回落到 idle', () => {
  const p = new ActionPlayer(DEFAULT_PACK);
  p.setState('exploding');
  assert.equal(p.sample(0).state, 'idle');
});

test('动作播放中默认拒绝新动作，除非要求排队', () => {
  const p = new ActionPlayer(DEFAULT_PACK);
  assert.equal(p.playAction('nod', 1000), true);
  assert.equal(p.playAction('jump', 1200), false);
  assert.equal(p.sample(1200).action, 'nod');

  assert.equal(p.playAction('jump', 1300, { queueIfBusy: true }), true);
  assert.equal(p.sample(1500).action, 'nod');
  // nod 900ms 结束后接上排队的 jump
  const after = p.sample(1000 + 900 + 1);
  assert.equal(after.action, 'jump');
});

test('动作结束后回到状态层，transform 归零', () => {
  const p = new ActionPlayer(DEFAULT_PACK);
  p.setState('happy');
  p.playAction('jump', 0);
  const mid = p.sample(350);
  assert.equal(mid.action, 'jump');
  assert.ok(Math.abs(mid.transform.dy) > 0.1, '跳的时候应该离地');

  const done = p.sample(5000);
  assert.equal(done.action, null);
  assert.equal(done.state, 'happy');
  assert.deepEqual(done.transform, { dx: 0, dy: 0, rot: 0, squash: 1 });
});

test('sample 带出渲染器需要的 look/scale/renderer', () => {
  const p = new ActionPlayer(BUILTIN_PACKS.find((x) => x.id === 'ghost'));
  const s = p.sample(0);
  assert.equal(s.renderer, 'procedural');
  assert.equal(s.look.shape, 'ghost');
  assert.equal(s.scale, 0.98);
  assert.equal(s.sprite, null, 'procedural 包不该产出 sheet 坐标');
});

test('sheet 坐标是行优先的网格切片', () => {
  const p = new ActionPlayer(sheetPack());
  p.playAction('nod', 0);
  // columns=4, cell 100x120, 5 帧: index 4 -> 第二行第一列
  const s = p.sample(0 + (4 / 5) * 500);
  assert.equal(s.sprite.index, 4);
  assert.equal(s.sprite.sx, 0);
  assert.equal(s.sprite.sy, 120);
  assert.equal(s.sprite.sheet, 'b.png');
});

test('一次性动作停在最后一帧，不会越界', () => {
  const p = new ActionPlayer(sheetPack());
  p.playAction('nod', 0);
  const last = p.sample(499);
  assert.equal(last.sprite.index, 4);
  assert.ok(last.sprite.index < 5);
});

test('循环状态跟墙上时钟走并回卷', () => {
  const p = new ActionPlayer(sheetPack());
  p.setState('idle');
  // idle 8 帧 @10fps -> 800ms 一轮
  assert.equal(p.sample(0).sprite.index, 0);
  assert.equal(p.sample(300).sprite.index, 3);
  assert.equal(p.sample(800).sprite.index, 0);
});

test('切换角色包会清掉上一只的动作状态', () => {
  const p = new ActionPlayer(DEFAULT_PACK);
  p.setState('happy');
  p.playAction('spin', 0);
  p.setPack(BUILTIN_PACKS[1]);
  const s = p.sample(10);
  assert.equal(s.action, null);
  assert.equal(s.state, 'away');
  assert.equal(s.look.shape, 'cat');
});

test('别名让语意动作名落到包自己的动作上', () => {
  const pack = {
    id: 'g', name: 'g', renderer: 'procedural', states: PROC_STATES,
    actions: { click: { durationMs: 500, desc: '被戳' }, hover: { durationMs: 600, desc: '凑近' } },
    aliases: { nod: 'click', peek: 'hover' },
  };
  const p = new ActionPlayer(pack);
  assert.equal(p.resolve('nod'), 'click');
  assert.equal(p.resolve('peek'), 'hover');
  assert.equal(p.resolve('click'), 'click', '包自己的名字优先，不经过别名');
  assert.equal(p.resolve('spin'), null, '没有别名也没有同名动作就该是 null');

  assert.equal(p.playAction('nod', 0), true);
  assert.equal(p.sample(10).action, 'click', '播放的应该是解析后的名字');
});

test('别名指向不存在的动作会被校验拦下', () => {
  const e = validatePack({
    id: 'g', name: 'g', states: PROC_STATES,
    actions: { click: { durationMs: 500 } },
    aliases: { nod: 'clickk' },
  });
  assert.ok(e.some((m) => m.includes('aliases.nod') && m.includes('clickk')));
});

test('导入的 cafe 包能过校验，且快环的全部触发都有动作可播', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(new URL('../characters/cafe/character.json', import.meta.url), 'utf8'));
  assert.deepEqual(validatePack(raw), []);
  const p = new ActionPlayer(raw);
  // 快环会发这些语意名字；一个解析不到就意味着那个反馈在这只角色身上静默消失
  for (const want of ['nod', 'shake', 'peek', 'wave', 'sulk', 'jump', 'cheer', 'tilt', 'stretch', 'spin']) {
    assert.ok(p.resolve(want), `cafe 包解析不出 ${want}，这个反馈会静默消失`);
  }
});

test('sheet 包的动作都有正时长，状态都有 fps', () => {
  const n = normalizePack(sheetPack());
  for (const [name, def] of Object.entries(n.actions)) {
    assert.ok(def.durationMs > 0, `动作 ${name} 时长为 ${def.durationMs}`);
  }
  // 状态是循环的，不需要时长，但取帧要用 fps —— 缺了就退化成 pack 级默认值
  for (const [name, def] of Object.entries(n.states)) {
    if (!def.sheet) continue;
    assert.ok(def.fps > 0, `状态 ${name} 没有 fps`);
  }
});

test('导入的 cafe 包里每段都能取到帧，不会出现空格子', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(new URL('../characters/cafe/character.json', import.meta.url), 'utf8'));
  const p = new ActionPlayer(raw);
  for (const name of Object.keys(p.pack.actions)) {
    p.action = null;
    assert.equal(p.playAction(name, 0), true, `${name} 播不起来`);
    const def = p.pack.actions[name];
    // 抽最后一帧：越界的话渲染器会去 blit 图幅外的区域，画出空白
    const s = p.sample(def.durationMs - 1);
    assert.ok(s.sprite, `${name} 没有产出 sheet 坐标`);
    assert.ok(s.sprite.index < def.frames, `${name} 帧号 ${s.sprite.index} 越界（共 ${def.frames} 帧）`);
    const rows = Math.ceil(def.frames / p.pack.columns);
    assert.ok(s.sprite.sy < rows * p.pack.cell.h, `${name} 的 sy 落在图幅外`);
  }
});

test('没有对应动画的状态回退到 idle，而不是画不出东西', () => {
  // Real shape of an imported Desktop_Gremlin pack: the source game has no "away"
  // animation, so the importer leaves it empty. Before the fallback existed, a sheet pack
  // in the away state drew nothing and the renderer degraded to the procedural body — so
  // anyone who opened the page before starting the camera saw a grey blob instead of the
  // character they picked.
  // Shaped like a real imported pack, columns and all — an under-specified fixture would be
  // rejected by normalizePack and the test would prove nothing about the fallback.
  const pack = normalizePack({
    id: 'sheetish', name: 'Sheetish', renderer: 'sheet',
    cell: { w: 300, h: 300 }, columns: 10, fps: 60,
    states: {
      idle: { sheet: 'idle.png', frames: 150 },
      happy: { sheet: 'hover.png', frames: 150 },
      curious: { sheet: 'hover.png', frames: 150 },
      sleepy: { sheet: 'sleep.png', frames: 90 },
      annoyed: { sheet: 'idle.png', frames: 150 },
      away: {},
    },
    actions: { hover: { sheet: 'hover.png', frames: 150, desc: 'hovering' } },
  });
  const player = new ActionPlayer(pack);

  player.setState('away');
  const away = player.sample(1000);
  assert.ok(away.sprite, 'away 状态必须还是画得出画面');
  assert.equal(away.sprite.sheet, 'idle.png', 'away 应该退回 idle 的图');

  player.setState('happy');
  assert.equal(player.sample(1000).sprite.sheet, 'hover.png', '有自己图的状态不该被改掉');
});

test('程序化角色不受这个回退影响', () => {
  // Procedural packs legitimately have empty state defs — they are drawn from `look`, not
  // from a sheet — so the fallback must not rewrite them.
  const player = new ActionPlayer(normalizePack(BUILTIN_PACKS[0]));
  player.setState('away');
  assert.doesNotThrow(() => player.sample(1000));
  assert.equal(player.sample(1000).sprite, null, '程序化角色本来就没有 sprite');
});
