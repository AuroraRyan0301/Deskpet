import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from '../pet-render.js';

// Stand-in for a canvas context: width proportional to character count, so the assertions
// are about *where it breaks*, not about font metrics.
const ctx = { measureText: (s) => ({ width: s.length * 7 }) };
const widest = (lines) => Math.max(...lines.map((l) => l.length * 7));

test('英文按词断，不会把单词切开', () => {
  const lines = wrapText(ctx, 'What are you doing over there, anyway?', 140);
  assert.ok(lines.length > 1, '这句应该换行');
  // The bug this replaced turned "anyway?" into "any" + "way?", which reads as two words.
  assert.ok(lines.every((l) => !/\ban$|\bwa$/.test(l)), `断在了词中间: ${JSON.stringify(lines)}`);
  assert.equal(lines.join(' ').replace(/\s+/g, ' '), 'What are you doing over there, anyway?',
    '拼回去必须和原文一致，不能丢字或多空格');
});

test('每行都不超宽', () => {
  for (const [text, w] of [
    ['I have been staring at this same stack trace for the better part of an hour', 140],
    ['short', 140],
    ['a b c d e f g h i j k l m n o p', 40],
  ]) {
    const lines = wrapText(ctx, text, w);
    assert.ok(widest(lines) <= w, `超宽 ${widest(lines)} > ${w}: ${JSON.stringify(lines)}`);
  }
});

test('比整行还长的单个词会被切开，而不是溢出', () => {
  const lines = wrapText(ctx, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 70);
  assert.ok(lines.length > 1);
  assert.ok(widest(lines) <= 70, '超长单词也不能溢出');
  assert.equal(lines.join(''), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '切开后不能丢字符');
});

test('中文没有空格，仍然按字断——这对中文本来就是对的', () => {
  const lines = wrapText(ctx, '坐直点吧，你都快贴到桌子上了', 70);
  assert.ok(lines.length > 1);
  assert.ok(widest(lines) <= 70);
  assert.equal(lines.join(''), '坐直点吧，你都快贴到桌子上了');
});

test('空串和纯空白不会产生垃圾行，也不会崩', () => {
  assert.deepEqual(wrapText(ctx, '', 100), ['']);
  assert.deepEqual(wrapText(ctx, '   ', 100), ['']);
  assert.doesNotThrow(() => wrapText(ctx, null, 100));
});

test('窄到放不下一个字符时也不会死循环', () => {
  const lines = wrapText(ctx, 'hello world', 1);
  assert.ok(lines.length >= 2, '应该逐字符拆开');
  assert.ok(lines.join('').includes('hello'), '内容不能丢');
});
