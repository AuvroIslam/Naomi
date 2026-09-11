// Pure pixel operations on raw BGRA bitmaps (what Electron's NativeImage.toBitmap returns).

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

// Fraction (0..1) of grid cells whose brightness moved more than `threshold`.
function signatureDiff(a, b, threshold = 6) {
  if (!a || !b || a.cells.length !== b.cells.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.cells.length; i++) {
    if (Math.abs(a.cells[i] - b.cells[i]) > threshold) changed++;
  }
  return changed / a.cells.length;
}

module.exports = { maskBitmap, frameSignature, signatureDiff };
