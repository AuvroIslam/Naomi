// Small persistent settings store. AI keys are never entered by the person using Naomi:
// they come from the app's .env (set up once by whoever builds/installs Naomi).

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { PROVIDERS, allKeysFromEnv } = require('./providers');

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

// { openai: [...], deepseek: [...], google: [...], anthropic: [...] } from the environment (.env),
// main key first, then any spares (…_FALLBACK).
function getKeys() {
  return allKeysFromEnv();
}

// Preferences safe to hand to the renderer (says which AIs are configured, never the keys).
function getPrefs() {
  const raw = readRaw();
  const prefs = {};
  for (const k of Object.keys(DEFAULTS)) prefs[k] = raw[k] ?? DEFAULTS[k];
  const keys = getKeys();
  prefs.keys = {};
  for (const p of PROVIDERS) prefs.keys[p.id] = keys[p.id] ? 'env' : null;
  prefs.hasApiKey = Object.values(prefs.keys).some(Boolean);
  return prefs;
}

function setPrefs(patch) {
  const raw = readRaw();
  for (const k of Object.keys(DEFAULTS)) if (k in patch) raw[k] = patch[k];
  writeRaw(raw);
  return getPrefs();
}

module.exports = { getKeys, getPrefs, setPrefs };
