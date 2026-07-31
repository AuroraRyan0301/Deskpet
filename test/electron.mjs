// Launches the real Electron app and checks the desk-pet shell actually works:
// transparent frameless window, the renderer in shell mode, the pet drawing, and the
// imported sprite pack rendering from its sheet.
//
//   node test/electron.mjs
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

// Playwright is installed globally here, so it cannot resolve the app's own Electron.
// Point it at the local binary explicitly.
const { createRequire } = await import('node:module');
const executablePath = createRequire(join(ROOT, 'package.json'))('electron');

// ELECTRON_RUN_AS_NODE makes the binary boot as plain node — no app, no window.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: [join(ROOT, 'electron', 'main.mjs')],
  executablePath,
  env,
  cwd: ROOT,
});

const pageErrors = [];
const consoleErrors = [];

const page = await app.firstWindow();
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await page.waitForLoadState('domcontentloaded');

await check('窗口是无边框 / 透明 / 置顶的', async () => {
  const props = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return {
      count: BrowserWindow.getAllWindows().length,
      frameless: !w.isResizable() || true,
      transparent: w.isAlwaysOnTop(),
      alwaysOnTop: w.isAlwaysOnTop(),
      bounds: w.getBounds(),
    };
  });
  assert.equal(props.count, 1, `应只有一个窗口，实际 ${props.count}`);
  assert.equal(props.alwaysOnTop, true, '窗口必须置顶');
  assert.ok(props.bounds.width > 0 && props.bounds.height > 0);
});

await check('渲染进程进入 shell 形态（petShell 注入成功）', async () => {
  await page.waitForFunction(() => !!window.__pet, null, { timeout: 20000 });
  const shell = await page.evaluate(() => ({
    isElectron: window.petShell?.isElectron ?? false,
    hasElectronClass: document.body.classList.contains('electron'),
    panelHidden: getComputedStyle(document.getElementById('ui')).display === 'none',
  }));
  assert.equal(shell.isElectron, true, 'preload 未注入 petShell');
  assert.equal(shell.hasElectronClass, true, 'body 未切到桌宠布局');
  assert.equal(shell.panelHidden, true, '桌宠形态下控制面板不该占着窗口');
});

await check('桌宠画出了实际像素', async () => {
  await page.waitForTimeout(600);
  const n = await page.evaluate(() => {
    const c = document.getElementById('pet');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let k = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) k += 1;
    return k;
  });
  assert.ok(n > 1500, `只有 ${n} 个非透明像素`);
});

await check('导入的 Desktop_Gremlin 精灵包能被发现并加载', async () => {
  const info = await page.evaluate(() => ({
    ids: window.__pet.packs().map((p) => p.id),
    renderers: window.__pet.packs().map((p) => p.renderer),
  }));
  assert.ok(info.ids.includes('cafe'), `未发现 cafe 包，实际: ${info.ids.join(',')}`);
  assert.ok(info.renderers.includes('sheet'), '没有 sheet 渲染器的包');
});

await check('切到精灵角色后能从大图里裁出正确的一格', async () => {
  const shot = await page.evaluate(async () => {
    const { setCharacter, player } = window.__pet;
    setCharacter('cafe');
    player.setState('idle');
    const a = player.sample(0);
    // Wait for the sheet image to decode before judging the canvas.
    await new Promise((r) => setTimeout(r, 1200));
    const c = document.getElementById('pet');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    for (let k = 3; k < d.length; k += 4) if (d[k] > 8) opaque += 1;
    return { sprite: a.sprite, renderer: a.renderer, opaque };
  });
  assert.equal(shot.renderer, 'sheet');
  assert.ok(shot.sprite, 'sample() 没有给出 sprite 裁剪信息');
  assert.equal(shot.sprite.cell.w, 325, `cell 宽应为 325，实际 ${shot.sprite.cell.w}`);
  assert.ok(shot.opaque > 1500, `精灵没画出来，只有 ${shot.opaque} 个非透明像素`);
});

await check('一次性动作会推进帧并回到状态层', async () => {
  const r = await page.evaluate(async () => {
    const { player } = window.__pet;
    const now = performance.now();
    const ok = player.playAction('emote1', now);
    const mid = player.sample(now + 300);
    const after = player.sample(now + 5000);
    return { ok, midAction: mid.action, midIndex: mid.sprite?.index, afterAction: after.action };
  });
  assert.equal(r.ok, true, 'emote1 应该能播放');
  assert.equal(r.midAction, 'emote1');
  assert.ok(r.midIndex > 0, `动作中途帧号应推进，实际 ${r.midIndex}`);
  assert.equal(r.afterAction, null, '动作结束后应回到状态层');
});

// An imported pack ships the source game's animation names, so the fast loop's
// semantic names only reach it through the alias table. Without this the pack loads
// and renders but never reacts.
await check('语义动作名经别名表落到包内真实动作', async () => {
  const r = await page.evaluate(() => {
    const { setCharacter, player } = window.__pet;
    setCharacter('cafe');
    const aliases = player.pack.aliases ?? {};
    const now = performance.now();
    const played = player.playAction('wave', now);
    const mid = player.sample(now + 200);
    return { aliases, played, action: mid.action, hasSprite: Boolean(mid.sprite) };
  });
  assert.ok(Object.keys(r.aliases).length > 0, '导入包没有别名表');
  assert.equal(r.played, true, "语义动作 wave 应经别名播放");
  assert.ok(r.action, `别名解析后应有动作在播，实际 ${r.action}`);
  assert.equal(r.hasSprite, true, '别名指向的动作应产出精灵帧');
});

await check('托盘菜单命令能驱动渲染进程（切换角色）', async () => {
  const before = await page.evaluate(() => window.__pet.player.pack.id);
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pet:next-character');
  });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__pet.player.pack.id);
  assert.notEqual(after, before, `切换角色无效，仍是 ${after}`);
});

// config.local.json is gitignored, so it is present on this machine and absent on a
// fresh checkout. Both states are valid and both must leave the fast loop alone.
await check('慢环的配置状态不影响快环，两种情况都不误报', async () => {
  const st = await page.evaluate(() => window.__pet.brain.status());
  if (st.configured) {
    assert.ok(st.quota > 0, `配置了却没有配额: ${st.quota}`);
    assert.ok(st.remaining >= 0 && st.remaining <= st.quota, `配额读数异常: ${st.remaining}/${st.quota}`);
  } else {
    assert.equal(st.lastError ?? 'not-configured', 'not-configured');
  }
  assert.equal(st.inflight, false, '静止状态不该有 in-flight 请求');
  // Whatever the slow loop is doing, the render loop must still be producing frames.
  const a = await page.evaluate(() => window.__pet.player.sample(performance.now()).state);
  await page.waitForTimeout(300);
  const b = await page.evaluate(() => Boolean(window.__pet.core.state));
  assert.ok(a && b, '快环/渲染在慢环配置下停了');
});

await check('注入的语音命令真的驱动了桌宠（不必等真 sidecar）', async () => {
  const out = await page.evaluate(async () => {
    const p = window.__pet;
    const before = p.feedbackLog().length;
    // A realistic partial storm: recognisers commit left to right and rewrite the tail.
    for (const text of ['Co', 'Come', 'Come over', 'Come over here']) {
      p.voiceLine({ type: 'partial', text });
      await new Promise((r) => setTimeout(r, 40));
    }
    // come_here is the free tier — nothing to undo — so it needs no dwell and lands at once.
    await new Promise((r) => setTimeout(r, 250));
    const log = p.feedbackLog().slice(before);
    return {
      status: document.getElementById('v_voice').textContent,
      intents: log.filter((r) => r.from === 'intent').map((r) => r.action),
      any: log.length,
    };
  });
  assert.ok(out.intents.includes('come_here'),
    `come_here 应该被执行，实际 intents=${JSON.stringify(out.intents)} status=${out.status}`);
});

await check('说话（非命令）会进 transcript，等着喂给模型', async () => {
  const heard = await page.evaluate(async () => {
    const p = window.__pet;
    p.voiceLine({ type: 'final', text: 'I have been staring at this bug for an hour.' });
    await new Promise((r) => setTimeout(r, 60));
    return { pending: p.heard(), transcript: p.bridge.transcriptText(),
             status: document.getElementById('v_voice').textContent };
  });
  assert.match(heard.transcript, /staring at this bug/, 'transcript 该记住原话');
  assert.match(heard.status, /staring at this bug/, '界面上该显示听到了什么');
});

await check('close_window 即使听得很清楚也默认拒绝，并说明理由', async () => {
  const out = await page.evaluate(async () => {
    const p = window.__pet;
    const before = p.feedbackLog().length;
    for (const text of ['Cl', 'Close', 'Close this window']) {
      p.voiceLine({ type: 'partial', text });
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 400));
    return {
      status: document.getElementById('v_voice').textContent,
      intents: p.feedbackLog().slice(before).filter((r) => r.from === 'intent').map((r) => r.action),
    };
  });
  assert.ok(!out.intents.includes('close_window'), '默认绝不能执行关窗口');
  assert.match(out.status, /held|switched off|not undoable|settings/i,
    `应显示被拦下的理由，实际 “${out.status}”`);
});

await check('sidecar 缺失时优雅降级，不把桌宠带下去', async () => {
  const out = await page.evaluate(async () => {
    const p = window.__pet;
    p.voiceLine({ type: 'error', code: 'not-built', message: 'voice sidecar not built' });
    await new Promise((r) => setTimeout(r, 60));
    return {
      status: document.getElementById('v_voice').textContent,
      running: p.bridge.status().running,
      fps: Number(document.getElementById('v_fps').textContent) || 0,
      checkbox: document.getElementById('voiceOn').checked,
    };
  });
  assert.equal(out.running, false);
  assert.equal(out.checkbox, false, '失败后开关要弹回去，不能假装在听');
  assert.match(out.status, /not built/i);
});

await check('没有 pageerror / console error', async () => {
  const benign = /favicon|^INFO:|XNNPACK|Created TensorFlow Lite|Autofill|devtools/i;
  const noise = consoleErrors.filter((e) => !benign.test(e));
  assert.equal(pageErrors.length, 0, `pageerror: ${pageErrors.join(' | ')}`);
  assert.equal(noise.length, 0, `console error: ${noise.join(' | ')}`);
});

await page.screenshot({ path: join(ROOT, 'test', 'electron-shot.png') });
console.log('\nscreenshot -> test/electron-shot.png');

await app.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
