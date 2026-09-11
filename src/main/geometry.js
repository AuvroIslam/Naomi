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

// Windows keeps the taskbar above every app window, so a dot drawn on a taskbar icon would be
// hidden. For targets outside the usable work area, rest the dot just inside its edge and say
// which way an arrow should point to reach the real target. The margin leaves room for the arrow
// (it reaches ~40px out from the dot) to show fully before the taskbar.
function pointerPlacement(target, workArea, margin = 46) {
  const right = workArea.x + workArea.width;
  const bottom = workArea.y + workArea.height;
  const inside = target.x >= workArea.x && target.x <= right && target.y >= workArea.y && target.y <= bottom;
  if (inside) return { x: target.x, y: target.y, edge: null };
  let edge = 'right';
  if (target.y > bottom) edge = 'down';
  else if (target.y < workArea.y) edge = 'up';
  else if (target.x < workArea.x) edge = 'left';
  return {
    x: clamp(target.x, workArea.x + margin, right - margin),
    y: clamp(target.y, workArea.y + margin, bottom - margin),
    edge,
  };
}

module.exports = {
  fitSize,
  clamp,
  imageToScreen,
  screenToImage,
  rectToImage,
  pointInRect,
  distance,
  pointerPlacement,
};
