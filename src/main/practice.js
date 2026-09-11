// Practice Mail window: a pretend email app where Naomi can guide someone with zero risk.

const path = require('node:path');
const { BrowserWindow } = require('electron');

function createPracticeWindow(bounds) {
  const win = new BrowserWindow({
    ...bounds,
    title: 'Practice Mail',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Come to the front when it opens (Windows won't let a background app steal focus without a
  // brief always-on-top), then become a normal window so it can never cover Naomi's island.
  win.setAlwaysOnTop(true);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'practice', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.moveTop();
    win.focus();
    setTimeout(() => {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false);
    }, 800);
  });
  return win;
}

// Center of an element in screen DIP, or null if it isn't visible right now.
async function locateIn(win, id) {
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return null;
  const p = await win.webContents.executeJavaScript(`window.naomiLocate && window.naomiLocate(${JSON.stringify(id)})`);
  if (!p) return null;
  const c = win.getContentBounds();
  return { x: c.x + p.x, y: c.y + p.y };
}

module.exports = { createPracticeWindow, locateIn };
