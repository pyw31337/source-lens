// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const SL = require('../shared.js');

test('esc escapes HTML special characters', () => {
  assert.strictEqual(SL.esc('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});

test('largestSrcset handles w/x descriptors and commas inside URLs', () => {
  assert.strictEqual(SL.largestSrcset('a.jpg 1x, b.jpg 2x'), 'b.jpg');
  assert.strictEqual(SL.largestSrcset('a.jpg 400w,b.jpg 1600w,c.jpg 800w'), 'b.jpg');
  assert.strictEqual(SL.largestSrcset('https://r.co/w_400,h_300/a.jpg 400w, https://r.co/w_1200,h_900/a.jpg 1200w'), 'https://r.co/w_1200,h_900/a.jpg');
  assert.strictEqual(SL.largestSrcset('only.png'), 'only.png');
  assert.strictEqual(SL.largestSrcset(''), '');
});

test('downloadName keeps a sensible extension', () => {
  assert.strictEqual(SL.downloadName({ url: 'https://a.com/p/photo.jpeg?x=1', type: 'image' }, 'www.foo.com'), 'foo.com-photo.jpg');
  assert.strictEqual(SL.downloadName({ url: 'https://a.com/img?id=3&format=webp', type: 'image' }, 'foo.com'), 'foo.com-img.webp');
  assert.strictEqual(SL.downloadName({ url: 'data:image/svg+xml,abc', type: 'svg', name: 'arrow right' }, 'foo.com'), 'foo.com-arrow-right.svg');
  assert.strictEqual(SL.downloadName({ url: 'https://v.com/stream/abc', type: 'video' }, 'v.com'), 'v.com-abc.mp4');
});

test('URL lock table: signed / locked CDNs are never rewritten', () => {
  const ig = 'https://scontent-ssn1-1.cdninstagram.com/v/t51.2885-15/1_n.jpg?stp=dst-jpg_e35&_nc_ht=x&oh=abc&oe=def';
  assert.strictEqual(SL.upgradeMediaUrl(ig), ig);
  const shop = 'https://shop-phinf.pstatic.net/2024/a.jpg?type=w860';
  assert.strictEqual(SL.upgradeMediaUrl(shop), shop);
});

test('URL rewrite table still upgrades known hosts', () => {
  assert.match(SL.upgradeMediaUrl('https://images.unsplash.com/photo-1?w=400'), /w=2400/);
  assert.match(SL.upgradeMediaUrl('https://blogfiles.pstatic.net/a/b.jpg?type=w80'), /type=w966/);
});

test('classifyUrl basics', () => {
  assert.strictEqual(SL.classifyUrl('https://x.com/a.mp4').type, 'video');
  assert.strictEqual(SL.classifyUrl('https://x.com/a.jpg').type, 'image');
  assert.ok(SL.classifyUrl('https://x.com/a.m3u8').stream);
  assert.strictEqual(SL.classifyUrl('data:image/svg+xml,<svg/>').type, 'svg');
});
