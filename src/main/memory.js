// What Naomi remembers between sessions ("Alysa's email is ..."), stored locally as JSON.

const fs = require('node:fs');
const path = require('node:path');

const MAX_FACTS = 40;
// Never keep anything that looks like a secret, even if the model offers it.
const SECRET = /password|passcode|\bpin\b|cvv|otp|\b(?:\d[ -]?){12,19}\b/i;

function createMemory(file) {
  function list() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data.filter((f) => typeof f === 'string') : [];
    } catch {
      return [];
    }
  }

  function save(facts) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(facts, null, 2));
  }

  // Returns only the facts that were new.
  function add(facts) {
    const current = list();
    const seen = new Set(current.map((f) => f.toLowerCase()));
    const added = [];
    for (const raw of facts || []) {
      const fact = String(raw).trim().slice(0, 200);
      if (!fact || SECRET.test(fact) || seen.has(fact.toLowerCase())) continue;
      seen.add(fact.toLowerCase());
      added.push(fact);
    }
    if (added.length) save([...current, ...added].slice(-MAX_FACTS));
    return added;
  }

  function clear() {
    save([]);
  }

  return { list, add, clear };
}

module.exports = { createMemory };
