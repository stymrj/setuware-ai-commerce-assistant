// Tiny .env loader. Node does not read .env on its own, and this app has no
// dependencies, so `cp .env.example .env` would otherwise do nothing.
// Existing process env wins (a shell export or the host platform overrides
// the file). A missing file is fine — every variable is optional.

const fs = require("node:fs");

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { loaded: false, keys: [] };
  }
  const keys = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = cleaned.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys };
}

module.exports = { loadEnvFile };
