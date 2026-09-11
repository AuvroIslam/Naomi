// Smoke test for the live Claude connection: `npm run check`.
// Sends Naomi's real prompt + tools with a small synthetic "screen" and prints what she decides.
const path = require('node:path');
const zlib = require('node:zlib');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const AnthropicModule = require('@anthropic-ai/sdk');
const { GuideSession, DEFAULT_MODEL } = require('../src/main/guide');

const Anthropic = AnthropicModule.default || AnthropicModule;

// Minimal PNG encoder: a light "desktop" with a dark taskbar and one blue "app icon".
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function fakeScreen(w = 640, h = 400) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      let rgb = [230, 236, 245];
      if (y > h - 36) rgb = [32, 36, 48];
      if (y > h - 30 && y < h - 6 && x > 300 && x < 324) rgb = [40, 120, 230];
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { base64: png.toString('base64'), mediaType: 'image/png', width: w, height: h, toScreen: (p) => p, toImage: (p) => p };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY in .env (or your environment) first.');
    process.exit(1);
  }
  const session = new GuideSession({
    client: new Anthropic(),
    capture: async () => fakeScreen(),
    model: process.env.NAOMI_MODEL || DEFAULT_MODEL,
    effort: process.env.NAOMI_EFFORT || 'low',
  });
  const started = Date.now();
  const result = new Promise((resolve) => {
    for (const evt of ['ask', 'point', 'keys', 'finish', 'error']) session.on(evt, (data) => resolve({ evt, data }));
  });
  await session.start('How do I send an email to my granddaughter?');
  const { evt, data } = await result;
  console.log(`Naomi chose: ${evt} (${Date.now() - started} ms)${session.compat ? ' [compat mode]' : ''}`);
  console.log(JSON.stringify(data, null, 2));
  process.exit(evt === 'error' ? 1 : 0);
}

main();
