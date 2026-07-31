import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain, QuotaGuard, buildPrompt, dayKey, jsonBody, parseReply } from '../brain.js';
import { DEFAULT_PACK, actionVocabulary, normalizePack } from '../characters.js';

const VOCAB = actionVocabulary(normalizePack(DEFAULT_PACK));
const T0 = new Date(2026, 6, 31, 10, 0, 0).getTime();
const DAY = 86400000;

const okReply = (content) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
  text: async () => content,
});

test('dayKey 用本地日期，配额在用户的午夜翻页', () => {
  assert.equal(dayKey(new Date(2026, 6, 31, 23, 59).getTime()), '2026-07-31');
  assert.equal(dayKey(new Date(2026, 7, 1, 0, 1).getTime()), '2026-08-01');
  assert.equal(dayKey(new Date(2026, 0, 5).getTime()), '2026-01-05');
});

test('配额守卫会计数、耗尽、并在跨天时重置', () => {
  const q = new QuotaGuard({ quota: 3 });
  assert.equal(q.remaining(T0), 3);
  assert.equal(q.allow(T0), true);
  q.spend(T0); q.spend(T0); q.spend(T0);
  assert.equal(q.remaining(T0), 0);
  assert.equal(q.allow(T0), false);
  // 第二天自动恢复
  assert.equal(q.allow(T0 + DAY), true);
  assert.equal(q.remaining(T0 + DAY), 3);
});

test('配额守卫的存储坏掉时当作零次，而不是抛错', () => {
  const store = { get: () => 'not json {{{', set: () => {} };
  const q = new QuotaGuard({ store, quota: 5 });
  assert.equal(q.remaining(T0), 5);
});

test('配额跨进程持久化：同一个 store 换个实例还记得', () => {
  const m = new Map();
  new QuotaGuard({ store: m, quota: 10 }).spend(T0, 4);
  assert.equal(new QuotaGuard({ store: m, quota: 10 }).remaining(T0), 6);
});

test('prompt 里带上 script 协议、策略和可读的读数', () => {
  const p = buildPrompt({
    state: { slump: 0.5, leanRatio: 1.3, attention: false, blinkRate: 30, yawnCount: 2, energy: 40, gesture: 'Thumb_Up' },
    vocabulary: VOCAB, persona: '一只猫', policy: 'honest',
  });
  assert.ok(p.system.includes('一只猫'));
  // The protocol block comes from describeVerbs, which itself comes from the parser's
  // tables — the pack's action names must appear inside it.
  assert.ok(p.system.includes('nod'));
  assert.ok(p.system.includes('stretch'));
  assert.ok(/mood <state>/.test(p.system), 'mood 动词要在协议里');
  assert.ok(/{"script"/.test(p.system), '回复格式必须是 script 字段');
  assert.ok(/say what you actually see/i.test(p.system), 'honest 策略应体现在 system 里');
  assert.ok(p.user.includes('50%'), '坍塌度要转成百分比给模型');
  assert.ok(p.user.includes('1.30'));
  assert.ok(p.user.includes('turned away'), '视线偏开要给模型');
  // Classifier outputs — MediaPipe's canned gesture labels included — stay out of the
  // prompt: the model gets finger states and the annotated frame instead.
  assert.ok(!p.user.includes('Thumb_Up'));
});

test('prompt 送逐指状态，不送手型分类名', () => {
  const p = buildPrompt({
    state: { handCount: 1, handShape: 'callMe', fingersUp: ['thumb', 'pinky'] },
    vocabulary: VOCAB, persona: '', policy: 'honest',
  });
  assert.ok(p.user.includes('thumb, pinky'), '要列出哪几根手指伸着');
  assert.ok(!p.user.includes('callMe'), '分类器的猜测不该进 prompt');
  // A closed hand is still information.
  const fist = buildPrompt({ state: { handCount: 1, fingersUp: [] }, vocabulary: VOCAB, policy: 'honest' });
  assert.ok(/none \(closed hand\)/.test(fist.user));
  // No hand in frame -> no finger line at all.
  const none = buildPrompt({ state: { handCount: 0, fingersUp: [] }, vocabulary: VOCAB, policy: 'honest' });
  assert.ok(!none.user.includes('fingers extended'));
});

test('ignore 策略在 prompt 里明确要求不说话', () => {
  const p = buildPrompt({ state: {}, vocabulary: VOCAB, persona: '', policy: 'ignore' });
  assert.ok(/do not speak at all/i.test(p.system), 'ignore 策略必须明确要求闭嘴');
});

test('prompt 交代了使用场景和说话方式，而不是只丢读数', () => {
  const p = buildPrompt({ state: {}, vocabulary: VOCAB, persona: '', policy: 'honest' });
  assert.ok(/webcam/i.test(p.system), '要说清画面是摄像头来的');
  assert.ok(/not an assistant/i.test(p.system), '要说清它不是助手');
  assert.ok(/spoken english/i.test(p.system), '要求说人话');
  assert.ok(/never narrate the sensors/i.test(p.system), '要禁止复述读数');
});

test('模型被告知它只在状态罕见时被唤醒，所以别复读', () => {
  const p = buildPrompt({
    state: { slump: 0.4 }, vocabulary: VOCAB, persona: '', policy: 'honest',
    trigger: 'slump', habit: 'this has been their usual state for a while',
  });
  assert.ok(/never say the\s+same thing twice/i.test(p.system), 'system 要禁止复读');
  assert.ok(p.user.includes('usual state for a while'), '常见程度要传给模型');
  assert.ok(p.user.includes('sank down'), 'trigger 要翻成人话');
});

test('没有手势时不往 prompt 里塞 None', () => {
  const p = buildPrompt({ state: { gesture: 'None' }, vocabulary: VOCAB, persona: '', policy: 'honest' });
  assert.ok(!p.user.includes('None'));
});

test('parseReply 吃 script 协议的 JSON', () => {
  const r = parseReply('{"script":"mood happy; say nice posture; emote nod"}', { vocabulary: VOCAB });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((st) => st.verb), ['mood', 'say', 'emote']);
  assert.equal(r.line, 'nice posture');
  assert.deepEqual(r.rejected, []);
});

test('parseReply 兼容退役的 line/action 格式，转成等价 script', () => {
  // Models drift back to formats they have seen; the old shape converts, never errors.
  const r = parseReply('{"line":"坐直点","action":"nod"}', { vocabulary: VOCAB });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((st) => st.verb), ['emote', 'say']);
  assert.equal(r.line, '坐直点');
});

test('parseReply 吃 markdown 围栏包着的 JSON', () => {
  const r = parseReply('```json\n{"script":"say 哦; emote tilt"}\n```', { vocabulary: VOCAB });
  assert.equal(r.line, '哦');
  assert.deepEqual(r.steps.map((st) => st.verb), ['say', 'emote']);
});

test('parseReply 吃前后带废话的 JSON', () => {
  const r = parseReply('好的，这是我的反应：\n{"script":"say 累了吧; emote stretch"}\n希望有帮助', { vocabulary: VOCAB });
  assert.equal(r.line, '累了吧');
  assert.equal(r.steps.length, 2);
});

test('模型编出来的动作被丢掉，台词留着', () => {
  const r = parseReply('{"script":"emote moonwalk; say 看我!"}', { vocabulary: VOCAB });
  assert.equal(r.line, '看我!');
  assert.deepEqual(r.steps.map((st) => st.verb), ['say'], '词表外的动作必须被解析器丢掉');
  assert.match(r.rejected[0].reason, /unknown-action/, '而且要留下被丢的原因');
});

test('完全不是 JSON 时，至少把话说出来', () => {
  const r = parseReply('你今天坐得挺直的', { vocabulary: VOCAB });
  assert.equal(r.line, '你今天坐得挺直的');
  assert.deepEqual(r.steps.map((st) => st.verb), ['say']);
  assert.equal(r.ok, false);
});

test('过长的台词被截断，气泡不会撑爆', () => {
  // The parser truncates say text at its own maxSayChars with an ellipsis.
  const long = '啊'.repeat(200);
  const r = parseReply(JSON.stringify({ script: `say ${long}` }), { vocabulary: VOCAB });
  assert.ok(r.line.length <= 91, `实际 ${r.line.length}`);
  assert.ok(r.line.endsWith('…'));
});

test('空回复没有任何步骤', () => {
  const r = parseReply('', { vocabulary: VOCAB });
  assert.deepEqual(r.steps, []);
  assert.equal(r.line, '');
  assert.equal(r.ok, false);
});

test('script 为空串是合法的沉默，不是错误', () => {
  const r = parseReply('{"script":""}', { vocabulary: VOCAB });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.rejected, []);
});

test('jsonBody 只在有图时附图，并用 low detail 省 token', () => {
  const prompt = { system: 's', user: 'u' };
  const noImg = jsonBody({ prompt, imageDataUrl: null, model: 'm', maxTokens: 10 });
  assert.equal(noImg.messages[1].content.length, 1);

  const withImg = jsonBody({ prompt, imageDataUrl: 'data:image/jpeg;base64,AAA', model: 'm', maxTokens: 10 });
  const img = withImg.messages[1].content.find((c) => c.type === 'image_url');
  assert.equal(img.image_url.url, 'data:image/jpeg;base64,AAA');
  assert.equal(img.image_url.detail, 'low');
  assert.equal(withImg.messages[0].role, 'system');
});

test('没配 key 时不发请求', async () => {
  let called = 0;
  const b = new Brain({ apiKey: '', fetch: async () => { called += 1; return okReply('{}'); }, now: () => T0 });
  assert.equal(await b.think({ state: {}, vocabulary: VOCAB }), null);
  assert.equal(called, 0);
  assert.equal(b.status().lastError, 'not-configured');
});

test('成功时返回可执行的 steps，并扣一次配额', async () => {
  const b = new Brain({
    apiKey: 'k', dailyQuota: 5, now: () => T0,
    fetch: async () => okReply('{"script":"mood annoyed; say 坐直"}'),
  });
  const out = await b.think({ state: { slump: 0.4 }, vocabulary: VOCAB, persona: '', policy: 'honest' });
  assert.deepEqual(out.steps.map((st) => st.verb), ['mood', 'say']);
  assert.equal(out.line, '坐直');
  assert.equal(b.status().remaining, 4);
  assert.equal(b.status().lastError, null);
});

test('空 script 回复是合法结果而不是 null，因为沉默是决定', async () => {
  const b = new Brain({ apiKey: 'k', now: () => T0, fetch: async () => okReply('{"script":""}') });
  const out = await b.think({ state: {}, vocabulary: VOCAB });
  assert.ok(out, '不该是 null');
  assert.deepEqual(out.steps, []);
});

test('配额耗尽后不再发请求，且错误信息说得清', async () => {
  let called = 0;
  const b = new Brain({
    apiKey: 'k', dailyQuota: 2, now: () => T0,
    fetch: async () => { called += 1; return okReply('{"line":"a","action":"nod"}'); },
  });
  await b.think({ state: {}, vocabulary: VOCAB });
  await b.think({ state: {}, vocabulary: VOCAB });
  assert.equal(called, 2);
  assert.equal(await b.think({ state: {}, vocabulary: VOCAB }), null);
  assert.equal(called, 2, '耗尽后必须一个请求都不发');
  assert.match(b.status().lastError, /daily-quota-exhausted \(2\/day\)/);
});

test('HTTP 报错时返回 null 但配额照扣（上游已经消耗了）', async () => {
  const b = new Brain({
    apiKey: 'k', dailyQuota: 5, now: () => T0,
    fetch: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
  });
  assert.equal(await b.think({ state: {}, vocabulary: VOCAB }), null);
  assert.match(b.status().lastError, /HTTP 429/);
  assert.equal(b.status().remaining, 4);
});

test('网络抛异常时不冒泡，快环不受影响', async () => {
  const b = new Brain({
    apiKey: 'k', now: () => T0,
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(await b.think({ state: {}, vocabulary: VOCAB }), null);
  assert.match(b.status().lastError, /ECONNREFUSED/);
  assert.equal(b.status().inflight, false, '异常后必须解锁，否则慢环永久卡死');
});

test('同时只允许一个在飞的请求', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let called = 0;
  const b = new Brain({
    apiKey: 'k', dailyQuota: 9, now: () => T0,
    fetch: async () => { called += 1; await gate; return okReply('{"line":"x","action":"nod"}'); },
  });
  const first = b.think({ state: {}, vocabulary: VOCAB });
  // BUSY, not null: the caller must be able to tell "lost the race, retry" apart from
  // "failed" without reading the shared lastError, which the colliding call rewrites.
  const second = await b.think({ state: {}, vocabulary: VOCAB });
  assert.equal(second, Brain.BUSY);
  assert.equal(second.busy, true);
  assert.equal(called, 1);
  release();
  const done = await first;
  assert.equal(done.line, 'x');
  assert.equal(b.status().remaining, 8, '被拒的那次不该扣配额');
});

test('回复不是 JSON 时仍然把台词交出去', async () => {
  const b = new Brain({ apiKey: 'k', now: () => T0, fetch: async () => okReply('喝口水吧') });
  const out = await b.think({ state: {}, vocabulary: VOCAB });
  assert.equal(out.line, '喝口水吧');
  assert.deepEqual(out.steps.map((st) => st.verb), ['say']);
  assert.equal(b.status().lastError, 'reply-not-json');
});

test('回复完全为空文本时给出零步骤的结果', async () => {
  const b = new Brain({ apiKey: 'k', now: () => T0, fetch: async () => okReply('   ') });
  const out = await b.think({ state: {}, vocabulary: VOCAB });
  assert.deepEqual(out.steps, []);
});

test('configure 能同时改端点和配额上限', () => {
  const b = new Brain({ apiKey: 'k', dailyQuota: 100, now: () => T0 });
  b.configure({ dailyQuota: 5, model: 'gpt-4o' });
  assert.equal(b.opt.model, 'gpt-4o');
  assert.equal(b.status().quota, 5);
  assert.equal(b.status().remaining, 5);
});
