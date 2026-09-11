// Pure geometry helpers. Three coordinate spaces meet in Naomi:
//  - "image" space: pixels of the screenshot we send to Claude
//  - "screen" space: Electron DIP coordinates of the display
//  - "overlay" space: DIP coordinates relative to the overlay window's origin

function fitSize(srcW, srcH, maxW, maxH) {
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// display: { bounds: {x, y, width, height} } in DIP; image: {width, height}
function imageToScreen(pt, image, display) {
  const { bounds } = display;
  return {
    x: Math.round(bounds.x + (clamp(pt.x, 0, image.width) * bounds.width) / image.width),
    y: Math.round(bounds.y + (clamp(pt.y, 0, image.height) * bounds.height) / image.height),
  };
}

function screenToImage(pt, image, display) {
  const { bounds } = display;
  return {
    x: Math.round(((pt.x - bounds.x) * image.width) / bounds.width),
    y: Math.round(((pt.y - bounds.y) * image.height) / bounds.height),
  };
}

function rectToImage(rect, image, display) {
  const a = screenToImage({ x: rect.x, y: rect.y }, image, display);
  const b = screenToImage({ x: rect.x + rect.width, y: rect.y + rect.height }, image, display);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

function pointInRect(pt, rect, margin = 0) {
  return (
    pt.x >= rect.x - margin &&
    pt.x <= rect.x + rect.width + margin &&
    pt.y >= rect.y - margin &&
    pt.y <= rect.y + rect.height + margin
  );
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

module.exports = {
  fitSize,
  clamp,
  imageToScreen,
  screenToImage,
  rectToImage,
  pointInRect,
  distance,
};
