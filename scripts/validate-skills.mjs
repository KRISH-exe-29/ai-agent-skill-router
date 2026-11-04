#!/usr/bin/env node
// Validates every SKILL.md and agent file plus the Claude Code plugin manifests. Exit 1 on any error.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, SKILL_NAME_RE } from '../skills/skill-audit/scripts/lib/common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const ok = [];

for (const dir of await fs.readdir(path.join(root, 'skills'))) {
  const file = path.join(root, 'skills', dir, 'SKILL.md');
  let fm;
  try { fm = parseFrontmatter(await fs.readFile(file, 'utf8')); } catch { errors.push(`${dir}: SKILL.md missing`); continue; }
  if (!fm.name) errors.push(`${dir}: frontmatter "name" missing`);
  else if (!SKILL_NAME_RE.test(fm.name) || fm.name.length > 64) errors.push(`${dir}: name must be lowercase-hyphenated, <= 64 chars`);
  else if (fm.name !== dir) errors.push(`${dir}: name "${fm.name}" must equal folder name`);
  if (!fm.description) errors.push(`${dir}: frontmatter "description" missing`);
  else if (fm.description.length > 1024) errors.push(`${dir}: description exceeds 1024 chars`);
  ok.push(`skills/${dir}`);
}

for (const f of await fs.readdir(path.join(root, 'agents'))) {
  const fm = parseFrontmatter(await fs.readFile(path.join(root, 'agents', f), 'utf8'));
  if (!fm.name || !fm.description) errors.push(`agents/${f}: name and description required`);
  if (/\b(Bash|Write|Edit|NotebookEdit|WebFetch)\b/.test(fm.tools || '')) errors.push(`agents/${f}: auditor must be read-only (no Bash/Write/Edit/WebFetch)`);
  if (!fm.tools) errors.push(`agents/${f}: tools must be listed explicitly (default would grant all tools)`);
  ok.push(`agents/${f}`);
}

const plugin = JSON.parse(await fs.readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
const market = JSON.parse(await fs.readFile(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
if (!market.name || !market.owner || !Array.isArray(market.plugins)) errors.push('marketplace.json: name, owner, plugins required');
if (!market.plugins?.some(p => p.name === plugin.name)) errors.push('marketplace.json: plugin entry name must equal plugin.json name');
JSON.parse(await fs.readFile(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
ok.push('.claude-plugin/*', 'hooks/hooks.json');

if (errors.length) { console.error(errors.map(e => `✗ ${e}`).join('\n')); process.exit(1); }
console.log(`validate-skills: PASS (${ok.join(', ')})`);
