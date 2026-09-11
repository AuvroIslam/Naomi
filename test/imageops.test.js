const test = require('node:test');
const assert = require('node:assert/strict');
const { maskBitmap, frameSignature, signatureDiff } = require('../src/main/imageops');

function solid(width, height, v) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = v;
    buf[i + 1] = v;
    buf[i + 2] = v;
    buf[i + 3] = 255;
  }
  return buf;
}

const px = (buf, width, x, y) => [...buf.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test('maskBitmap paints only inside the rect (BGRA order), clipped to bounds', () => {
  const w = 10;
  const h = 10;
  const buf = solid(w, h, 255);
  maskBitmap(buf, w, h, [{ x: 8, y: 8, width: 5, height: 5 }], { r: 10, g: 20, b: 30 });
  assert.deepEqual(px(buf, w, 9, 9), [30, 20, 10, 255]);
  assert.deepEqual(px(buf, w, 7, 7), [255, 255, 255, 255]);
});

test('identical frames have zero diff', () => {
  const buf = solid(96, 54, 128);
  const a = frameSignature(buf, 96, 54);
  const b = frameSignature(Buffer.from(buf), 96, 54);
  assert.equal(signatureDiff(a, b), 0);
});

test('a changed region shows up as a proportional diff', () => {
  const w = 96;
  const h = 54;
  const before = solid(w, h, 200);
  const after = Buffer.from(before);
  maskBitmap(after, w, h, [{ x: 0, y: 0, width: w / 2, height: h }], { r: 20, g: 20, b: 20 });
  const d = signatureDiff(frameSignature(before, w, h), frameSignature(after, w, h));
  assert.ok(d > 0.45 && d < 0.55, `diff was ${d}`);
});

test('missing or mismatched signatures count as fully changed', () => {
  const a = frameSignature(solid(96, 54, 1), 96, 54);
  assert.equal(signatureDiff(a, null), 1);
  assert.equal(signatureDiff(a, frameSignature(solid(96, 54, 1), 96, 54, 10, 10)), 1);
});
