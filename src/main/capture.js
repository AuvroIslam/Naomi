// Screen capture for Naomi. Everything here uses the primary display.

const { desktopCapturer, screen, nativeImage } = require('electron');
const { fitSize, clamp, rectToImage, imageToScreen, screenToImage } = require('./geometry');
const { maskBitmap, frameSignature } = require('./imageops');

// Big enough for Claude to read small buttons, small enough to stay fast.
const MAX_W = 1280;
const MAX_H = 800;
// Zoomed crops are shown up to this size (and magnified up to 4x).
const ZOOM_W = 1024;
const ZOOM_H = 768;

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

/**
 * A magnified view of part of the screen, captured at full physical resolution.
 * @param {{x,y,width,height}} rect  area in screen DIP
 */
async function captureRegion(rect, { maskRects = [] } = {}) {
  const display = primaryDisplay();
  const full = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
  const thumb = await grab(display, full);
  const size = thumb.getSize();
  const r = rectToImage(rect, size, display);
  const crop = {
    x: clamp(r.x, 0, size.width - 1),
    y: clamp(r.y, 0, size.height - 1),
  };
  crop.width = clamp(r.width, 1, size.width - crop.x);
  crop.height = clamp(r.height, 1, size.height - crop.y);

  const piece = thumb.crop(crop);
  const bitmap = piece.toBitmap();
  const masks = maskRects
    .map((m) => rectToImage(m, size, display))
    .map((m) => ({ x: m.x - crop.x, y: m.y - crop.y, width: m.width, height: m.height }));
  maskBitmap(bitmap, crop.width, crop.height, masks);

  const scale = Math.min(ZOOM_W / crop.width, ZOOM_H / crop.height, 4);
  const out = { width: Math.round(crop.width * scale), height: Math.round(crop.height * scale) };
  const zoomed = nativeImage.createFromBitmap(bitmap, { width: crop.width, height: crop.height }).resize({ ...out, quality: 'best' });

  return { base64: zoomed.toJPEG(88).toString('base64'), mediaType: 'image/jpeg', ...out };
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

module.exports = { captureForClaude, captureRegion, captureSignature, primaryDisplay };
