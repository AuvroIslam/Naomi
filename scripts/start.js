// Launch Electron with a clean environment. Editors like VS Code set ELECTRON_RUN_AS_NODE,
// which would make Electron behave like plain Node and never open a window.
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});
child.on('close', (code) => process.exit(code ?? 0));
