// Pure pixel operations on raw BGRA bitmaps (what Electron's NativeImage.toBitmap returns),
// plus small "signatures" of the screen used to notice when something really changed.

// Paint rectangles (image-space) a flat color so Claude never sees Naomi's own window.
function maskBitmap(buf, width, height, rects, color = { r: 120, g: 120, b: 128 }) {
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        buf[i] = color.b;
        buf[i + 1] = color.g;
        buf[i + 2] = color.r;
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

// Downsample a bitmap into a small grid of average luminance values.
function frameSignature(buf, width, height, cols = 48, rows = 27) {
  const sig = new Float32Array(cols * rows);
  const counts = new Uint32Array(cols * rows);
  // Sample every 2nd pixel on each axis: plenty for change detection, 4x cheaper.
  for (let y = 0; y < height; y += 2) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x += 2) {
      const col = Math.min(cols - 1, Math.floor((x * cols) / width));
      const i = (y * width + x) * 4;
      const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
      const cell = row * cols + col;
      sig[cell] += lum;
      counts[cell]++;
    }
  }
  for (let c = 0; c < sig.length; c++) sig[c] = counts[c] ? sig[c] / counts[c] : 0;
  return { cols, rows, cells: sig };
}

const same = (a, b) => a && b && a.cells.length === b.cells.length;

// Fraction (0..1) of grid cells whose brightness moved more than `threshold`,
// skipping cells flagged in `ignore` (e.g. a playing video).
function signatureDiff(a, b, threshold = 6, ignore = null) {
  if (!same(a, b)) return 1;
  let changed = 0;
  let counted = 0;
  for (let i = 0; i < a.cells.length; i++) {
    if (ignore && ignore[i]) continue;
    counted++;
    if (Math.abs(a.cells[i] - b.cells[i]) > threshold) changed++;
  }
  return counted ? changed / counted : 0;
}

// Cells that flicker between consecutive samples — video, animations, blinking ads.
function volatileCells(samples, threshold = 6) {
  const mask = new Uint8Array(samples[0].cells.length);
  for (let s = 1; s < samples.length; s++) markVolatile(mask, samples[s - 1], samples[s], threshold);
  return mask;
}

function markVolatile(mask, a, b, threshold = 6) {
  if (!same(a, b)) return mask;
  for (let i = 0; i < mask.length; i++) if (Math.abs(a.cells[i] - b.cells[i]) > threshold) mask[i] = 1;
  return mask;
}

// A real change stays put: different from the baseline in two samples, and steady between them.
function persistentChange(base, a, b, threshold = 6, ignore = null) {
  if (!same(base, a) || !same(a, b)) return 0;
  let changed = 0;
  let counted = 0;
  for (let i = 0; i < base.cells.length; i++) {
    if (ignore && ignore[i]) continue;
    counted++;
    const fromBaseA = Math.abs(a.cells[i] - base.cells[i]);
    const fromBaseB = Math.abs(b.cells[i] - base.cells[i]);
    if (fromBaseA > threshold && fromBaseB > threshold && Math.abs(a.cells[i] - b.cells[i]) <= threshold) changed++;
  }
  return counted ? changed / counted : 0;
}

// A plus-shaped mark centred on (cx, cy): used to show the AI exactly where it is about to point.
function drawCross(buf, width, height, cx, cy, arm, thickness, color = { r: 235, g: 30, b: 30 }) {
  const half = Math.floor(thickness / 2);
  return maskBitmap(buf, width, height, [
    { x: cx - arm, y: cy - half, width: arm * 2 + 1, height: thickness },
    { x: cx - half, y: cy - arm, width: thickness, height: arm * 2 + 1 },
  ], color);
}

module.exports = { maskBitmap, frameSignature, signatureDiff, volatileCells, markVolatile, persistentChange, drawCross };
