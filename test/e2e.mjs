// End-to-end check: serves the app, drives it in a real Chromium with a fake
// camera, and asserts the pet actually renders and the loops actually run.
// Run: node test/e2e.mjs
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The production server, not a copy: it owns the wasm MIME type and the /_llm proxy the
// slow loop posts to. An inline stand-in here silently diverged once serve.mjs grew the
// proxy, and the page then logged 404s that this file's own console check flagged.
import { startStatic } from '../serve.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const results = [];
function check(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ok  ${name}`);
    } catch (e) {
      results.push({ name, ok: false, err: e.message });
      console.log(`FAIL  ${name}\n      ${e.message}`);
    }
  })();
}

const { server, port, origin: base } = await startStatic({ root: ROOT, quiet: true });
console.log(`serving ${ROOT} on ${base}\n`);

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
  ],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1200, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => consoleErrors.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`));

await page.goto(base, { waitUntil: 'load' });

await check('页面加载且模块脚本执行（window.__pet 存在）', async () => {
  await page.waitForFunction(() => !!window.__pet, null, { timeout: 10000 });
});

await check('canvas 有实际像素输出（不是空白）', async () => {
  await page.waitForTimeout(400);
  const nonBlank = await page.evaluate(() => {
    const c = document.getElementById('pet');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n += 1;
    return n;
  });
  assert.ok(nonBlank > 2000, `只有 ${nonBlank} 个非透明像素，桌宠可能没画出来`);
});

// The puppet is model-driven now, so the e2e stubs the model: a fixed script per call,
// no network, no quota, no nondeterminism. What stays real is everything downstream —
// parseReply, the total parser, the runner, the player, the renderer.
await page.evaluate(() => {
  window.__pet.brain.opt.apiKey = 'stub';
  window.__pet.brain.fetch = async () => ({
    ok: true,
    // Both adapter shapes at once, so the stub keeps working whatever provider
    // config.local.json happens to select on this machine.
    json: async () => ({
      choices: [{ message: { content: '{"script":"mood happy; emote wave; say all right"}' } }],
      content: [{ type: 'text', text: '{"script":"mood happy; emote wave; say all right"}' }],
    }),
  });
});

await check('mock 剧本：presence 本地判定，情绪由模型 script 设置', async () => {
  await page.evaluate(() => window.__pet.startMock());
  const seen = new Set();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => window.__pet.core.state.sprite);
    seen.add(s);
    const done = await page.evaluate(() => document.getElementById('btnMock').textContent.includes('Run'));
    if (done && seen.size > 1) break;
    await page.waitForTimeout(120);
  }
  // Presence is the fast loop's only remaining judgment...
  assert.ok(seen.has('away'), `离开时应为 away，见到: ${[...seen].join(',')}`);
  // ...and the mood came through the stubbed model's `mood happy`, proving the whole
  // trigger -> prompt -> script -> setMood path, not a local detection mapping.
  assert.ok(seen.has('happy'), `模型设置的 mood 应生效，见到: ${[...seen].join(',')}`);
  assert.ok(!seen.has('annoyed'), '没有任何 script 设 annoyed，本地检测不该再写表情');
});

await check('mock 产生了可导出的日志行', async () => {
  const n = await page.evaluate(() => window.__pet.core.log.length);
  assert.ok(n > 3, `日志只有 ${n} 行`);
  const csv = await page.evaluate(() => window.__pet.core.toCsv());
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /^t,policy,trigger,sprite,/);
  assert.equal(lines.length, n + 1, 'CSV 行数应等于日志行数 + 表头');
});

await check('三种策略都能切换且 ignore 不说话', async () => {
  const silent = await page.evaluate(async () => {
    const { core, makeFeatures } = window.__pet;
    core.reset();
    core.setPolicy('ignore');
    core.opt.reactionDelayMs = 0;
    let t = 0, spoke = false;
    for (let i = 0; i < 400; i += 1) {
      const s = core.updateFast(makeFeatures({
        t: (t += 33), facePresent: true, faceCenterY: i > 60 ? 0.65 : 0.42, faceSize: 0.3,
      }));
      if (s.line) spoke = true;
    }
    core.setPolicy('honest');
    return !spoke;
  });
  assert.ok(silent, 'ignore 策略不应产生台词');
});

await check('MediaPipe 模型能在浏览器里真正载入', async () => {
  await page.evaluate(() => window.__pet.loadModels());
  await page.waitForFunction(() => window.__modelsReady === true, null, { timeout: 120000 });
});

await check('假摄像头下快环真的在跑（fps > 0 且推理不抛错）', async () => {
  await page.evaluate(() => window.__pet.stopMock());
  await page.click('#btnCam');
  await page.waitForFunction(
    () => Number(document.getElementById('v_fps').textContent) > 0,
    null,
    { timeout: 30000 },
  );
  const infer = await page.evaluate(() => Number(document.getElementById('v_infer').textContent));
  assert.ok(Number.isFinite(infer) && infer > 0, `推理耗时读数异常: ${infer}`);
  const status = await page.textContent('#status');
  assert.ok(!/推理错误|启动失败/.test(status), `状态栏报错: ${status}`);
});

await check('假摄像头（无人脸）下不report陈旧姿势读数', async () => {
  await page.waitForTimeout(1200);
  const hud = await page.evaluate(() => ({
    sprite: document.getElementById('v_sprite').textContent,
    slump: Number(document.getElementById('v_slump').textContent),
    lean: Number(document.getElementById('v_lean').textContent),
  }));
  assert.equal(hud.sprite, 'away', `合成画面里没有人脸，应为 away，实际 ${hud.sprite}`);
  assert.equal(hud.slump, 0, `away 时 slump 应为 0，实际 ${hud.slump}`);
  assert.equal(hud.lean, 1, `away 时 leanRatio 应为 1，实际 ${hud.lean}`);
});

// The feature adapter is unit-tested against hand-written result objects, so the
// real risk is that the actual API uses different field names and the pipeline
// silently reports "no face" forever. Verify the field names against live output.
await check('detectForVideo 的返回字段名与适配器假设一致', async () => {
  const shape = await page.evaluate(async () => {
    const vision = await import('./vendor/tasks-vision/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks('./vendor/tasks-vision/wasm');
    const fl = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/face_landmarker.task' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    const gr = await vision.GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/gesture_recognizer.task' },
      runningMode: 'VIDEO',
      numHands: 1,
    });
    const cam = document.getElementById('cam');
    const f = fl.detectForVideo(cam, performance.now() + 100000);
    const g = gr.recognizeForVideo(cam, performance.now() + 100001);
    return { face: Object.keys(f), gesture: Object.keys(g) };
  });
  for (const key of ['faceLandmarks', 'faceBlendshapes', 'facialTransformationMatrixes']) {
    assert.ok(shape.face.includes(key), `FaceLandmarker 结果缺少 ${key}，实际字段: ${shape.face.join(',')}`);
  }
  assert.ok(
    shape.gesture.includes('gestures'),
    `GestureRecognizer 结果缺少 gestures，实际字段: ${shape.gesture.join(',')}`,
  );
  console.log(`      face: ${shape.face.join(', ')}`);
  console.log(`      gesture: ${shape.gesture.join(', ')}`);
});

await check('慢环未配置时不影响快环', async () => {
  const before = await page.evaluate(() => Number(document.getElementById('v_fps').textContent));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => Number(document.getElementById('v_fps').textContent));
  assert.ok(after > 0, `慢环关闭时快环停了: ${before} -> ${after}`);
  const sem = await page.textContent('#v_sem');
  assert.ok(!/失败/.test(sem), `慢环未启用却报了错: ${sem}`);
});

await check('外部 sheet 角色包真的被载入并进了角色下拉', async () => {
  await page.waitForFunction(
    () => window.__pet.packs().some((p) => p.renderer === 'sheet'),
    null,
    { timeout: 15000 },
  );
  const ids = await page.evaluate(() => window.__pet.packs().map((p) => p.id));
  const options = await page.$$eval('#charSelect option', (os) => os.map((o) => o.value));
  assert.deepEqual(options, ids, `下拉里的角色和已载入的不一致: ${options} vs ${ids}`);
  assert.ok(ids.length >= 4, `只有 ${ids.length} 个角色，外部包没进来`);
});

// The grid maths is unit-tested; what only a browser can tell us is whether the blit
// actually lands on pixels. A wrong cell size draws a transparent corner of the sheet
// and the pet silently disappears.
await check('切到 sheet 角色后真的在画精灵图，而不是退回程序化身体', async () => {
  const sheetId = await page.evaluate(() => {
    const id = window.__pet.packs().find((p) => p.renderer === 'sheet')?.id;
    if (id) window.__pet.setCharacter(id);
    return id ?? null;
  });
  assert.ok(sheetId, '没有可用的 sheet 角色包');
  // Sheets decode asynchronously, so this polls rather than sampling once.
  let best = 0;
  let info = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    info = await page.evaluate(() => {
      const p = window.__pet;
      const anim = p.player.sample(performance.now());
      const c = document.getElementById('pet');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n += 1;
      return { opaque: n, sprite: anim?.sprite ?? null, state: p.player.state,
               renderer: p.player.pack.renderer, sheets: p.renderer.images.size };
    });
    best = Math.max(best, info.opaque);
    if (best > 2000 && info.sprite) break;
    await page.waitForTimeout(200);
  }
  const miss = await page.evaluate(() => window.__pet.renderer.lastFrameMiss);
  assert.equal(miss, null, `精灵表加载失败: ${miss}`);
  assert.ok(best > 2000, `切到 ${sheetId} 后只有 ${best} 个非透明像素`);
  // Pixel count alone is not enough: the procedural fallback body also fills pixels, and
  // lastFrameMiss stays null when a state has no clip at all rather than a broken one. So a
  // sheet pack sitting in the away state drew the grey blob and this check was happy. Assert
  // that a sprite frame actually resolved.
  assert.ok(info.sprite, `state=${info.state} 没有解析出精灵帧，说明退回了程序化绘制`);
  assert.ok(info.sprite.sheet, '精灵帧要指向一张图');
  assert.ok(info.sheets > 0, '应该真的加载了 sheet');
});

// 反馈日志是跨角色累积的，所以这条检查必须自己划基线，只看切到别名角色之后新增的那些
await check('模型 script 驱动动作，别名角色记的是自己的动作名', async () => {
  const { base, sheetId } = await page.evaluate(() => {
    window.__pet.stopMock();
    const id = window.__pet.packs().find((p) => p.renderer === 'sheet').id;
    window.__pet.setCharacter(id);
    const b = window.__pet.feedbackLog().length;
    window.__pet.core.reset();
    window.__pet.startMock();
    return { base: b, sheetId: id };
  });
  const deadline = Date.now() + 30000;
  let acted = [];
  while (Date.now() < deadline) {
    acted = await page.evaluate(
      (b) => window.__pet.feedbackLog().slice(b).filter((r) => r.action).map((r) => r.action),
      base,
    );
    if (acted.length >= 2) break;
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.__pet.stopMock());
  assert.ok(acted.length >= 1, `切到 ${sheetId} 后播了 ${acted.length} 个动作，script 的动作没接上`);
  const vocab = await page.evaluate(() => Object.keys(window.__pet.player.pack.actions));
  // mood rows are logged as `mood:<state>` and are not pack actions; emote rows must be.
  for (const a of acted.filter((x) => !x.startsWith('mood:'))) {
    assert.ok(vocab.includes(a), `记的是语意名 ${a}，不是 ${sheetId} 自己的动作名`);
  }
});

await check('语音合成能按角色包的英文音色挑出来', async () => {
  const info = await page.evaluate(async () => {
    const { pickVoice } = await import('./speech.js');
    const list = speechSynthesis.getVoices();
    const cfg = window.__pet.player.pack.voice;
    return {
      count: list.length,
      lang: cfg.lang,
      hint: cfg.voiceHint,
      picked: pickVoice(list, cfg)?.name ?? null,
    };
  });
  // The pack must ask for English now — that is the product behaviour, and it holds even
  // in headless Chromium, which usually ships no system voices at all.
  assert.match(info.lang, /^en/, `角色包音色语言应为英文，实际 ${info.lang}`);
  assert.ok(info.hint, '角色包应该指定音色');
  if (info.count > 0) assert.ok(info.picked, `有 ${info.count} 个音色却没挑出来`);
});

await check('界面上没有残留中文', async () => {
  const cjk = await page.evaluate(() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const t = walk.currentNode.nodeValue.trim();
      if (/[\u4e00-\u9fff]/.test(t)) out.push(t.slice(0, 60));
    }
    for (const el of document.querySelectorAll('[placeholder],[title]')) {
      for (const a of ['placeholder', 'title']) {
        const v = el.getAttribute(a);
        if (v && /[\u4e00-\u9fff]/.test(v)) out.push(`${a}=${v.slice(0, 60)}`);
      }
    }
    return out;
  });
  assert.deepEqual(cjk, [], `界面里还有中文：${cjk.join(' | ')}`);
});

await check('切回内置程序化角色仍然正常', async () => {
  await page.evaluate(() => window.__pet.setCharacter('blob'));
  await page.waitForTimeout(300);
  const px = await page.evaluate(() => {
    const c = document.getElementById('pet');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n += 1;
    return n;
  });
  assert.ok(px > 2000, `切回 blob 后只有 ${px} 个像素`);
});

await check('Listen 默认开启，但失败时会自己弹回并说明原因', async () => {
  // Auto-listen is the product decision (the pet exists to be talked to); the browser's
  // own permission prompt is the consent step. In headless with no mic permission the
  // attempt fails — the box must then untick rather than pretend to listen.
  const box = await page.$('#voiceOn');
  assert.ok(box, '面板里应该有 Listen 开关');
  assert.equal(await box.isDisabled(), false, 'Listen 不该是禁用状态');
  const status = await page.textContent('#v_voice');
  const checked = await box.isChecked();
  if (!checked) {
    assert.match(status, /unavailable|failed|permission|not built/i,
      `自动开启失败时要说明原因，实际 “${status}”`);
  }
});

await check('服务器缺少 /_voice 路由时，开关弹回并说清该做什么', async () => {
  // Exactly the failure a user hits after editing serve.mjs without restarting it: the page
  // is fine, the route 404s, and the old code reported the resulting JSON parse error —
  // which says nothing about the actual cause. Kept as a test because a silent, misleading
  // failure is the expensive kind.
  const http = await import('node:http');
  const stale = http.createServer((req, res) => {
    if (req.url.startsWith('/_voice/')) { res.writeHead(404); res.end('Not Found'); return; }
    server.emit('request', req, res);
  });
  await new Promise((r) => stale.listen(0, '127.0.0.1', r));
  const stalePage = await browser.newPage();
  try {
    await stalePage.goto(`http://127.0.0.1:${stale.address().port}`);
    await stalePage.waitForFunction(() => window.__pet != null, null, { timeout: 30000 });
    await stalePage.click('#voiceOn');
    await stalePage.waitForTimeout(1200);
    assert.equal(await stalePage.isChecked('#voiceOn'), false, '起不来就该把开关弹回去');
    const msg = await stalePage.textContent('#v_voice');
    assert.match(msg, /restart/i, `提示要能指导操作，实际 “${msg}”`);
    assert.doesNotMatch(msg, /JSON|Unexpected token/i, '不该把解析错误甩给用户');
  } finally {
    await stalePage.close();
    stale.close();
  }
});

await check('说话时人物下面出现 User: 字幕，partial 就跟上', async () => {
  const out = await page.evaluate(async () => {
    const p = window.__pet;
    p.voiceLine({ type: 'partial', text: 'what are you doing' });
    await new Promise((r) => setTimeout(r, 120));
    const mid = { caption: p.renderer.caption, final: p.renderer.captionFinal };
    p.voiceLine({ type: 'final', text: 'What are you doing over there, anyway?' });
    await new Promise((r) => setTimeout(r, 120));
    return { mid, after: { caption: p.renderer.caption, final: p.renderer.captionFinal } };
  });
  // Partials drive it, which is the whole reason it tracks speech instead of trailing it by
  // the 0.4-3.4 s a final costs.
  assert.equal(out.mid.caption, 'what are you doing', 'partial 就该显示出来');
  assert.equal(out.mid.final, false, '未定稿的应该标成非 final');
  assert.equal(out.after.caption, 'What are you doing over there, anyway?');
  assert.equal(out.after.final, true, 'final 要标成定稿');
});

await check('字幕会自己消失，说完不会一直挂在人物下面', async () => {
  const gone = await page.evaluate(async () => {
    const p = window.__pet;
    p.renderer.setCaption('lingering text', performance.now(), { final: false, holdMs: 150 });
    await new Promise((r) => setTimeout(r, 500));
    // The renderer clears it while drawing, so give the loop a frame to run.
    return p.renderer.caption;
  });
  assert.equal(gone, null, '过期字幕该被清掉');
});

await check('没有 console error / pageerror', async () => {
  // MediaPipe routes TFLite's INFO lines to stderr; those are not failures.
  const benign = /favicon|^INFO:|XNNPACK delegate|Created TensorFlow Lite/i;
  const noise = consoleErrors.filter((e) => !benign.test(e));
  assert.equal(pageErrors.length, 0, `pageerror: ${pageErrors.join(' | ')}`);
  assert.equal(noise.length, 0, `console error: ${noise.join(' | ')}`);
});

await page.screenshot({ path: join(ROOT, 'test', 'screenshot.png'), fullPage: false });
console.log(`\nscreenshot -> test/screenshot.png`);

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
