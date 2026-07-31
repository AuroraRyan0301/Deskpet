import test from 'node:test';
import assert from 'node:assert/strict';
import { pickVoice } from '../speech.js';

// Shapes taken from what macOS actually reports through the Web Speech API.
const MAC = [
  { name: 'Eddy (Chinese (China mainland))', lang: 'zh-CN' },
  { name: 'Flo (Chinese (China mainland))', lang: 'zh-CN' },
  { name: 'Grandma (Chinese (China mainland))', lang: 'zh-CN' },
  { name: 'Tingting', lang: 'zh-CN', default: true },
  { name: 'Samantha', lang: 'en-US', default: false },
  { name: 'Kyoko', lang: 'ja-JP' },
];

test('空列表返回 null 而不是崩', () => {
  assert.equal(pickVoice([], { lang: 'zh-CN' }), null);
  assert.equal(pickVoice(null, { lang: 'zh-CN' }), null);
});

test('按角色包给的音色提示挑人', () => {
  assert.match(pickVoice(MAC, { lang: 'zh-CN', voiceHint: 'Flo' }).name, /^Flo/);
  assert.match(pickVoice(MAC, { lang: 'zh-CN', voiceHint: 'Eddy' }).name, /^Eddy/);
  assert.match(pickVoice(MAC, { lang: 'zh-CN', voiceHint: 'Grandma' }).name, /^Grandma/);
});

test('提示名匹配不区分大小写和下划线', () => {
  assert.match(pickVoice(MAC, { lang: 'zh-CN', voiceHint: 'flo' }).name, /^Flo/);
  assert.match(pickVoice(MAC, { lang: 'zh_CN', voiceHint: 'FLO' }).name, /^Flo/);
});

test('提示的音色不存在时，退回同语言的声音而不是英文', () => {
  const v = pickVoice(MAC, { lang: 'zh-CN', voiceHint: 'Zhenzhen' });
  assert.equal(v.lang, 'zh-CN');
});

test('没有提示时选同语言，绝不选到日语或英语上', () => {
  assert.equal(pickVoice(MAC, { lang: 'zh-CN' }).lang, 'zh-CN');
  assert.equal(pickVoice(MAC, { lang: 'ja-JP' }).lang, 'ja-JP');
});

test('系统只有英文音色时退回默认音色，还是能出声', () => {
  const en = [{ name: 'Alex', lang: 'en-US' }, { name: 'Daniel', lang: 'en-GB', default: true }];
  const v = pickVoice(en, { lang: 'zh-CN', voiceHint: 'Flo' });
  assert.equal(v.name, 'Daniel', '没有中文音色时该用系统默认，而不是返回 null');
});

test('zh-TW 请求下同族的 zh-CN 也能用', () => {
  const v = pickVoice(MAC, { lang: 'zh-TW' });
  assert.ok(v.lang.startsWith('zh'));
});
