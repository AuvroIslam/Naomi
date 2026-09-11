// Renders Naomi's face to assets/icon.png (and a favicon for the website).
// Run with: npx electron scripts/make-icon.js   (via `npm run icon`)
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <defs>
    <radialGradient id="face" cx="35%" cy="30%" r="80%">
      <stop offset="0" stop-color="#ffb199"/><stop offset="0.6" stop-color="#ff6a4d"/><stop offset="1" stop-color="#e2482b"/>
    </radialGradient>
  </defs>
  <circle cx="32" cy="32" r="30" fill="url(#face)"/>
  <circle cx="18" cy="38" r="5" fill="#ff8f78" opacity="0.7"/>
  <circle cx="46" cy="38" r="5" fill="#ff8f78" opacity="0.7"/>
  <ellipse cx="23" cy="28" rx="3.6" ry="4.6" fill="#1d2140"/>
  <ellipse cx="41" cy="28" rx="3.6" ry="4.6" fill="#1d2140"/>
  <path d="M22 40 Q32 48 42 40" stroke="#1d2140" stroke-width="3.4" fill="none" stroke-linecap="round"/>
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

  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), image.resize({ width: 512, height: 512 }).toPNG());
  fs.writeFileSync(path.join(root, 'assets', 'icon.svg'), SVG);
  console.log('wrote assets/icon.png and assets/icon.svg');
  app.quit();
});
