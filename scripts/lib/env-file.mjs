// Tiny .env reader/writer for the setup scripts. Never prints values.
import fs from 'node:fs';

export function readEnvFile(path) {
  const out = {};
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function appendEnv(path, name, value) {
  const prefix = fs.existsSync(path) && !fs.readFileSync(path, 'utf8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(path, `${prefix}${name}="${value}"\n`);
}
