// Screen capture for Naomi. Everything here uses the primary display.

const { desktopCapturer, screen, nativeImage } = require('electron');
const { fitSize, rectToImage, imageToScreen, screenToImage } = require('./geometry');
const { maskBitmap, frameSignature } = require('./imageops');

// Big enough for Claude to read small buttons, small enough to stay fast.
const MAX_W = 1280;
const MAX_H = 800;

function primaryDisplay() {
  return screen.getPrimaryDisplay();
}

async function grab(display, size) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source) throw new Error('No screen available to capture');
  return source.thumbnail;
}

/**
 * Screenshot for Claude, with Naomi's own window painted over.
 * @param {{maskRects?: Array<{x,y,width,height}>}} opts  rects in screen DIP
 */
async function captureForClaude({ maskRects = [] } = {}) {
  const display = primaryDisplay();
  const target = fitSize(display.bounds.width, display.bounds.height, MAX_W, MAX_H);
  const thumb = await grab(display, target);
  const { width, height } = thumb.getSize();
  const image = { width, height };

  const bitmap = thumb.toBitmap();
  maskBitmap(bitmap, width, height, maskRects.map((r) => rectToImage(r, image, display)));
  const masked = nativeImage.createFromBitmap(bitmap, { width, height });

  return {
    base64: masked.toJPEG(85).toString('base64'),
    mediaType: 'image/jpeg',
    width,
    height,
    toScreen: (pt) => imageToScreen(pt, image, display),
    toImage: (pt) => screenToImage(pt, image, display),
  };
}

// Tiny grayscale fingerprint of the screen, for "did anything change?" checks.
async function captureSignature({ maskRects = [] } = {}) {
  const display = primaryDisplay();
  const thumb = await grab(display, { width: 240, height: 135 });
  const { width, height } = thumb.getSize();
  const image = { width, height };
  const bitmap = thumb.toBitmap();
  maskBitmap(bitmap, width, height, maskRects.map((r) => rectToImage(r, image, display)), { r: 0, g: 0, b: 0 });
  return frameSignature(bitmap, width, height);
}

module.exports = { captureForClaude, captureSignature, primaryDisplay };
