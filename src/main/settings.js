// Small persistent settings store. The API key is encrypted with the OS keychain when possible.

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  voice: true,
  spotlight: true,
  textSize: 'large', // 'large' | 'xlarge'
  effort: 'low',
};

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

function writeRaw(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const raw = readRaw();
  if (!raw.apiKey) return '';
  try {
    return raw.apiKeyEncrypted && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(raw.apiKey, 'base64'))
      : raw.apiKey;
  } catch {
    return '';
  }
}

function setApiKey(key) {
  const raw = readRaw();
  const trimmed = (key || '').trim();
  if (!trimmed) {
    delete raw.apiKey;
    delete raw.apiKeyEncrypted;
  } else if (safeStorage.isEncryptionAvailable()) {
    raw.apiKey = safeStorage.encryptString(trimmed).toString('base64');
    raw.apiKeyEncrypted = true;
  } else {
    raw.apiKey = trimmed;
    raw.apiKeyEncrypted = false;
  }
  writeRaw(raw);
}

// Preferences safe to hand to the renderer (never includes the key itself).
function getPrefs() {
  const raw = readRaw();
  const prefs = {};
  for (const k of Object.keys(DEFAULTS)) prefs[k] = raw[k] ?? DEFAULTS[k];
  prefs.hasApiKey = !!getApiKey();
  prefs.keyFromEnv = !!process.env.ANTHROPIC_API_KEY;
  return prefs;
}

function setPrefs(patch) {
  const raw = readRaw();
  for (const k of Object.keys(DEFAULTS)) if (k in patch) raw[k] = patch[k];
  writeRaw(raw);
  return getPrefs();
}

module.exports = { getApiKey, setApiKey, getPrefs, setPrefs };
