// Renders Naomi's icon — a glowing orange orb, the same as her pointer — to assets/icon.png,
// assets/icon.svg and the website favicon docs/icon.png.
// Run with: npm run icon
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <defs>
    <radialGradient id="orb" cx="34%" cy="28%" r="78%">
      <stop offset="0" stop-color="#ffdcc8"/>
      <stop offset="0.24" stop-color="#ff9c5e"/>
      <stop offset="0.56" stop-color="#ff6b35"/>
      <stop offset="1" stop-color="#d9420f"/>
    </radialGradient>
    <radialGradient id="shine" cx="36%" cy="24%" r="32%">
      <stop offset="0" stop-color="#fff" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="32" cy="32" r="29" fill="url(#orb)"/>
  <circle cx="32" cy="32" r="29" fill="url(#shine)"/>
  <rect x="20.2" y="22.2" width="7.6" height="12.2" rx="3.8" fill="#2a1206"/>
  <rect x="36.2" y="22.2" width="7.6" height="12.2" rx="3.8" fill="#2a1206"/>
</svg>`;

const root = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const png = image.resize({ width: 512, height: 512 }).toPNG();

  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), png);
  fs.writeFileSync(path.join(root, 'assets', 'icon.svg'), SVG);
  fs.writeFileSync(path.join(root, 'docs', 'icon.png'), png);
  console.log('wrote assets/icon.png, assets/icon.svg, docs/icon.png');
  app.quit();
});
