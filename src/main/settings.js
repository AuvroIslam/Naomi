// Small persistent settings store. API keys are encrypted with the OS keychain when possible.

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { PROVIDERS, keysFromEnv } = require('./providers');

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

function seal(value) {
  if (safeStorage.isEncryptionAvailable()) {
    return { value: safeStorage.encryptString(value).toString('base64'), encrypted: true };
  }
  return { value, encrypted: false };
}

function unseal(entry) {
  if (!entry || !entry.value) return '';
  try {
    return entry.encrypted ? safeStorage.decryptString(Buffer.from(entry.value, 'base64')) : entry.value;
  } catch {
    return '';
  }
}

// Earlier versions stored a single Claude key at the top level.
function storedKeys(raw) {
  const keys = { ...(raw.keys || {}) };
  if (raw.apiKey && !keys.anthropic) keys.anthropic = { value: raw.apiKey, encrypted: !!raw.apiKeyEncrypted };
  return keys;
}

// { openai, deepseek, google, anthropic } — environment variables (.env) win over saved keys.
function getKeys() {
  const env = keysFromEnv();
  const stored = storedKeys(readRaw());
  const keys = {};
  for (const p of PROVIDERS) keys[p.id] = env[p.id] || unseal(stored[p.id]);
  return keys;
}

function setApiKey(key, provider = 'anthropic') {
  if (!PROVIDERS.some((p) => p.id === provider)) return;
  const raw = readRaw();
  raw.keys = storedKeys(raw);
  delete raw.apiKey;
  delete raw.apiKeyEncrypted;
  const trimmed = (key || '').trim();
  if (trimmed) raw.keys[provider] = seal(trimmed);
  else delete raw.keys[provider];
  writeRaw(raw);
}

// Preferences safe to hand to the renderer (never includes the keys themselves).
function getPrefs() {
  const raw = readRaw();
  const prefs = {};
  for (const k of Object.keys(DEFAULTS)) prefs[k] = raw[k] ?? DEFAULTS[k];
  const env = keysFromEnv();
  const stored = storedKeys(raw);
  prefs.keys = {};
  for (const p of PROVIDERS) prefs.keys[p.id] = env[p.id] ? 'env' : unseal(stored[p.id]) ? 'saved' : null;
  prefs.hasApiKey = Object.values(prefs.keys).some(Boolean);
  return prefs;
}

function setPrefs(patch) {
  const raw = readRaw();
  for (const k of Object.keys(DEFAULTS)) if (k in patch) raw[k] = patch[k];
  writeRaw(raw);
  return getPrefs();
}

module.exports = { getKeys, setApiKey, getPrefs, setPrefs };
