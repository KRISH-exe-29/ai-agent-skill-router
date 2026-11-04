// Shared helpers for cap-scan.mjs and apply.mjs. Node >= 18, zero dependencies.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DESC_MAX = 200;
const BOM_RE = new RegExp('^' + String.fromCharCode(0xFEFF));
export const ID_RE = /^[A-Za-z0-9:_.@/-]{1,80}$/;
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (booleans.includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

export function homeDir(override) {
  return path.resolve(override || os.homedir());
}

export function outDir(home, override) {
  return path.resolve(override || path.join(home, '.skill-router'));
}

// Minimal YAML frontmatter reader: top-level `key: value`, quoted values, and `>` / `|` block scalars.
export function parseFrontmatter(text) {
  const src = String(text).replace(BOM_RE, '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return {};
  const all = src.split('\n');
  const close = all.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  if (close === -1) return {};
  const lines = all.slice(1, close);
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let [, key, value] = m;
    const cont = () => {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      return block;
    };
    if (/^[>|][+-]?$/.test(value)) {
      value = cont().join(value.startsWith('>') ? ' ' : '\n').trim();
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { /* not a single quoted string: keep raw */ }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      // Plain scalar: indented continuation lines fold into one line.
      value = [value, ...cont()].filter(Boolean).join(' ').trim();
    }
    data[key] = value;
  }
  return data;
}

const REDACTIONS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\bhttps?:\/\/\S*[?&](?:token|key|sig|secret|password|access_token)=\S*/gi, '[url]'],
  [/\b(?:sk|pk|rk)[-_](?:live_|test_)?[A-Za-z0-9_-]{16,}/g, '[secret]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[secret]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[secret]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[secret]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[secret]'],
  [/\b[a-f0-9]{32,}\b/gi, '[secret]'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}/g, '[secret]'],
];

export function redact(s) {
  let t = String(s ?? '');
  for (const [re, rep] of REDACTIONS) t = t.replace(re, rep);
  return t;
}

// Character classes built from code points (keeps this file plain ASCII).
const cc = ranges => new RegExp('[' + ranges.map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
// Zero-width / bidi / soft-hyphen / BOM: deleted outright so they cannot split a secret.
const INVISIBLE = cc([[0x00AD, 0x00AD], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]]);
// C0/C1 controls and line/paragraph separators: become spaces.
const CONTROL = cc([[0x0000, 0x001F], [0x007F, 0x009F], [0x2028, 0x2029]]);

// Untrusted text -> short, flat, redacted data string. Never instructions, never multi-line.
// Order matters: delete invisibles, then redact, then strip markup (markers like [secret] survive).
export function sanitize(s, max = DESC_MAX) {
  let t = String(s ?? '').replace(INVISIBLE, '').replace(CONTROL, ' ');
  t = redact(t)
    .replace(/[`*_#>|<{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function safeId(s) {
  const t = String(s ?? '');
  return ID_RE.test(t) ? t : null;
}

const STOP = new Set(('a an and are as at be by can do for from has have how in into is it its of on or that the this ' +
  'to use used uses using via when where which while will with you your any all only not also such these those ' +
  'skill skills user users claude agent agents tool tools task tasks').split(' '));

export function tokenize(s) {
  return new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export async function sha256File(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

export function shortHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(BOM_RE, '')); }
  catch { return fallback; }
}

export async function listDirs(dir) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    // Include symlinks/junctions so linked skills are inventoried (callers mark them non-trashable).
    return ents.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);
  } catch { return []; }
}

export async function listFiles(dir, ext) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter(e => e.isFile() && e.name.endsWith(ext)).map(e => e.name);
  } catch { return []; }
}

export function exists(p) {
  try { fss.accessSync(p); return true; } catch { return false; }
}

// Case-insensitive on Windows/macOS default filesystems.
export function samePath(a, b) {
  const na = path.resolve(a), nb = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function check(cond, msg) {
  if (!cond) throw new Error(`selftest: ${msg}`);
}
