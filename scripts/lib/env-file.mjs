// Tiny .env reader/writer for the setup scripts. Never prints values.
import fs from 'node:fs';

export function readEnvFile(path) {
  const out = {};
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const raw = m[2].trim();
    // A quoted value ends at its closing quote; anything after it (a note or comment) is ignored.
    const quoted = raw.match(/^"([^"]*)"|^'([^']*)'/);
    out[m[1]] = quoted ? (quoted[1] ?? quoted[2]) : raw.replace(/\s+#.*$/, '');
  }
  return out;
}

export function appendEnv(path, name, value) {
  const prefix = fs.existsSync(path) && !fs.readFileSync(path, 'utf8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(path, `${prefix}${name}="${value}"\n`);
}
