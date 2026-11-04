#!/usr/bin/env node
// apply.mjs — applies ONE user-approved candidate op from candidates.json, or undoes one.
// Usage:
//   node apply.mjs --op <opId> [--dry-run]       apply an approved op
//   node apply.mjs --undo <opId>                 undo a previously applied op
//   node apply.mjs --list                        list applied ops
//   node apply.mjs --selftest
// Options: --home <dir> --out <dir>. Plugin commands use `claude plugin disable|enable`
// (override with SKILL_ROUTER_CLAUDE_CMD='["node","fake.mjs"]' for tests).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, homeDir, outDir, sha256File, atomicWrite, readJson, exists, samePath, safeId, check } from './lib/common.mjs';
import { skillRoots, scan, makeFixture } from './cap-scan.mjs';

const LOCK_STALE_MS = 60 * 60 * 1000;
const OP_RE = /^op-[a-f0-9]{12}$/;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function withLock(out, fn) {
  const lock = path.join(out, '.lock');
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await fs.open(lock, 'wx', 0o600);
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      try { return await fn(); } finally { await fs.rm(lock, { force: true }); }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = await readJson(lock, {});
      const stale = !info.pid || !pidAlive(info.pid) || Date.now() - (info.at || 0) > LOCK_STALE_MS;
      if (!stale) throw new Error(`another skill-audit run holds the lock (pid ${info.pid})`);
      // Move it aside atomically, then confirm we moved the SAME stale lock we inspected.
      // If another process already replaced it with a fresh lock, put that back and give up.
      const moved = `${lock}.stale.${process.pid}.${Date.now()}`;
      try { await fs.rename(lock, moved); } catch { continue; /* someone else recovered it; retry */ }
      const got = await readJson(moved, {});
      if (got.pid !== info.pid || got.at !== info.at) {
        try { await fs.rename(moved, lock); } catch { /* best effort */ }
        throw new Error('lock busy: another skill-audit run just started');
      }
      await fs.rm(moved, { force: true });
    }
  }
  throw new Error('could not acquire lock');
}

function claudeCmd() {
  const raw = process.env.SKILL_ROUTER_CLAUDE_CMD;
  if (raw) { const a = JSON.parse(raw); return { cmd: a[0], pre: a.slice(1) }; }
  return { cmd: 'claude', pre: [] };
}

function runClaudePlugin(action, pluginId) {
  // Strict id: no shell metacharacters can ever reach the command line.
  if (!safeId(pluginId) || !/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(pluginId)) throw new Error('invalid plugin id');
  const { cmd, pre } = claudeCmd();
  const args = [...pre, 'plugin', action, pluginId];
  let r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: 120000 });
  // npm-installed `claude` on Windows is a .cmd shim, which needs cmd.exe.
  if (r.error && process.platform === 'win32' && ['ENOENT', 'EINVAL'].includes(r.error.code)) {
    r = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { encoding: 'utf8', shell: false, timeout: 120000 });
  }
  if (r.status !== 0) throw new Error(`claude plugin ${action} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 300)}`);
  return (r.stdout || '').trim();
}

// Validate a trash target at apply time (TOCTOU-safe as far as a userland script can be).
async function validateSkillTarget(home, op) {
  const target = path.resolve(op.path);
  const st = await fs.lstat(target).catch(() => null);
  if (!st) throw new Error('target no longer exists');
  if (st.isSymbolicLink()) throw new Error('target is a symlink/junction; refusing');
  if (!st.isDirectory()) throw new Error('target is not a directory');
  // Compare canonical paths on both sides (handles Windows 8.3 short names and case).
  const real = await fs.realpath(target);
  const parentReal = await fs.realpath(path.dirname(target));
  if (!samePath(real, path.join(parentReal, path.basename(target)))) throw new Error('target resolves through a link; refusing');
  let allowed = false;
  for (const [, root] of skillRoots(home)) {
    if (!exists(root)) continue;
    if (samePath(parentReal, await fs.realpath(root))) allowed = true;
  }
  if (!allowed) throw new Error('target is not a direct child of an allowed skills root; refusing');
  const md = path.join(target, 'SKILL.md');
  const mst = await fs.lstat(md).catch(() => null);
  if (!mst || !mst.isFile()) throw new Error('SKILL.md missing or not a regular file');
  if ((await sha256File(md)) !== op.sha256) throw new Error('SKILL.md changed since the scan; re-run the scan');
  return target;
}

async function log(out, line) {
  await fs.appendFile(path.join(out, 'audit-log.md'), `- ${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

export async function applyOp({ home, out, opId, dryRun = false }) {
  home = homeDir(home); out = outDir(home, out);
  if (!OP_RE.test(String(opId))) throw new Error('invalid op id');
  const cands = await readJson(path.join(out, 'candidates.json'), null);
  if (!cands || !Array.isArray(cands.ops)) throw new Error('candidates.json missing; run cap-scan.mjs first');
  const op = cands.ops.find(o => o.op === opId);
  if (!op) throw new Error('op not found in candidates.json');
  const record = path.join(out, 'ops', `${opId}.json`);
  return withLock(out, async () => {
    if (exists(record)) {
      const prev = await readJson(record, {});
      if (!prev.undoneAt) throw new Error('op already applied; undo it first');
    }
    if (op.type === 'TRASH_SKILL') {
      const from = await validateSkillTarget(home, op);
      const to = path.join(out, 'trash', opId, path.basename(from));
      if (exists(to)) throw new Error('trash destination already exists; refusing to overwrite');
      await fs.mkdir(out, { recursive: true });
      if ((await fs.stat(out)).dev !== (await fs.stat(path.dirname(from))).dev) {
        throw new Error('~/.skill-router is on a different drive than the skill; use --out on the same drive');
      }
      if (dryRun) return { dryRun: true, type: op.type, from, to };
      await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await fs.rename(from, to);
      await atomicWrite(record, JSON.stringify({ op: opId, type: op.type, from, to, sha256: op.sha256, appliedAt: new Date().toISOString() }, null, 2));
      await log(out, `APPLY ${opId} TRASH_SKILL ${op.target} → trash · undo: node apply.mjs --undo ${opId}`);
      return { type: op.type, from, to };
    }
    if (op.type === 'DISABLE_PLUGIN') {
      if (dryRun) return { dryRun: true, type: op.type, plugin: op.target };
      runClaudePlugin('disable', op.target);
      await atomicWrite(record, JSON.stringify({ op: opId, type: op.type, plugin: op.target, appliedAt: new Date().toISOString() }, null, 2));
      await log(out, `APPLY ${opId} DISABLE_PLUGIN ${op.target} · undo: node apply.mjs --undo ${opId}`);
      return { type: op.type, plugin: op.target };
    }
    throw new Error(`unsupported op type ${op.type}`);
  });
}

export async function undoOp({ home, out, opId }) {
  home = homeDir(home); out = outDir(home, out);
  if (!OP_RE.test(String(opId))) throw new Error('invalid op id');
  const record = path.join(out, 'ops', `${opId}.json`);
  return withLock(out, async () => {
    const rec = await readJson(record, null);
    if (!rec) throw new Error('no applied op with that id');
    if (rec.undoneAt) throw new Error('op already undone');
    if (rec.op !== opId) throw new Error('op record does not match its id');
    if (rec.type === 'TRASH_SKILL') {
      // Never trust the record's paths: re-derive containment for both ends.
      const trashDir = path.join(out, 'trash', opId);
      if (typeof rec.to !== 'string' || typeof rec.from !== 'string') throw new Error('corrupt op record');
      if (!samePath(path.dirname(path.resolve(rec.to)), trashDir) || path.basename(rec.to) !== path.basename(rec.from)) {
        throw new Error('op record points outside its trash folder; refusing');
      }
      const fromParent = path.dirname(path.resolve(rec.from));
      let allowed = false;
      for (const [, root] of skillRoots(home)) {
        if (exists(root) && exists(fromParent) && samePath(await fs.realpath(fromParent), await fs.realpath(root))) allowed = true;
      }
      if (!allowed) throw new Error('op record restores outside an allowed skills root; refusing');
      if (exists(rec.from)) throw new Error('original path is occupied; move it away first');
      const st = await fs.lstat(rec.to).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error('trashed folder missing or replaced');
      await fs.rename(rec.to, rec.from);
    } else if (rec.type === 'DISABLE_PLUGIN') {
      runClaudePlugin('enable', rec.plugin);
    } else throw new Error('unsupported op record');
    rec.undoneAt = new Date().toISOString();
    await atomicWrite(record, JSON.stringify(rec, null, 2));
    await log(out, `UNDO ${opId} ${rec.type}`);
    return rec;
  });
}

async function listOps(out) {
  const dir = path.join(out, 'ops');
  let files = [];
  try { files = await fs.readdir(dir); } catch { /* none */ }
  return Promise.all(files.filter(f => f.endsWith('.json')).map(f => readJson(path.join(dir, f), {})));
}

// ---------------------------------------------------------------- selftest
async function selftest() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-router-apply-'));
  try {
    const H = await makeFixture(root);
    const out = path.join(root, 'out');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'config.json'), JSON.stringify({ exclude: ['style'] }));
    let r = await scan({ home: H, out });
    const opFor = name => r.ops.find(o => o.target === name);
    const rejects = async (p, re, msg) => {
      try { await p; } catch (e) { check(re.test(e.message), `${msg} (got: ${e.message})`); return; }
      throw new Error(`selftest: ${msg} (did not throw)`);
    };

    // dry run changes nothing
    const a = opFor('alpha-review');
    const dry = await applyOp({ home: H, out, opId: a.op, dryRun: true });
    check(dry.dryRun && exists(a.path), 'dry-run leaves files');

    // happy path + undo
    const res = await applyOp({ home: H, out, opId: a.op });
    check(!exists(a.path) && exists(res.to), 'trash moves folder');
    await rejects(applyOp({ home: H, out, opId: a.op }), /already applied/, 'double apply blocked');
    await undoOp({ home: H, out, opId: a.op });
    check(exists(path.join(a.path, 'SKILL.md')), 'undo restores folder');
    await rejects(undoOp({ home: H, out, opId: a.op }), /already undone/, 'double undo blocked');

    // TOCTOU: content changed after scan
    const b = opFor('beta-review');
    await fs.appendFile(path.join(b.path, 'SKILL.md'), '\nchanged');
    await rejects(applyOp({ home: H, out, opId: b.op }), /changed since the scan/, 'hash mismatch rejected');

    // path outside allowed roots (tampered candidates.json)
    const outside = path.join(root, 'elsewhere', 'victim');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'SKILL.md'), 'x');
    const cands = JSON.parse(await fs.readFile(path.join(out, 'candidates.json'), 'utf8'));
    cands.ops.push({ op: 'op-0000000000aa', type: 'TRASH_SKILL', target: 'victim', path: outside, sha256: await sha256File(path.join(outside, 'SKILL.md')) });
    // nested (not a direct child of root)
    const nested = path.join(H, '.claude', 'skills', 'gamma', 'inner');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'SKILL.md'), 'y');
    cands.ops.push({ op: 'op-0000000000bb', type: 'TRASH_SKILL', target: 'inner', path: nested, sha256: await sha256File(path.join(nested, 'SKILL.md')) });
    // symlink/junction inside a root pointing outside
    const link = path.join(H, '.claude', 'skills', 'linked');
    let linkMade = true;
    try { await fs.symlink(outside, link, 'junction'); } catch { linkMade = false; }
    if (linkMade) cands.ops.push({ op: 'op-0000000000cc', type: 'TRASH_SKILL', target: 'linked', path: link, sha256: await sha256File(path.join(outside, 'SKILL.md')) });
    await fs.writeFile(path.join(out, 'candidates.json'), JSON.stringify(cands));
    await rejects(applyOp({ home: H, out, opId: 'op-0000000000aa' }), /allowed skills root/, 'outside path rejected');
    await rejects(applyOp({ home: H, out, opId: 'op-0000000000bb' }), /allowed skills root/, 'nested path rejected');
    if (linkMade) await rejects(applyOp({ home: H, out, opId: 'op-0000000000cc' }), /symlink|link/, 'symlink/junction rejected');
    check(exists(path.join(outside, 'SKILL.md')), 'outside target untouched');
    await rejects(applyOp({ home: H, out, opId: '../../etc' }), /invalid op id/, 'op id validated');

    // collision: trash destination already exists
    r = await scan({ home: H, out });
    const g = opFor('gamma-docs');
    await fs.mkdir(path.join(out, 'trash', g.op, 'gamma-docs'), { recursive: true });
    await rejects(applyOp({ home: H, out, opId: g.op }), /already exists/, 'trash collision rejected');

    // undo blocked when original path is re-occupied
    const e = opFor('evil');
    await applyOp({ home: H, out, opId: e.op });
    await fs.mkdir(e.path, { recursive: true });
    await rejects(undoOp({ home: H, out, opId: e.op }), /occupied/, 'undo refuses to overwrite');

    // tampered op record: undo must not move arbitrary folders
    const fo = opFor('folded');
    await applyOp({ home: H, out, opId: fo.op });
    const recPath = path.join(out, 'ops', `${fo.op}.json`);
    const rec = JSON.parse(await fs.readFile(recPath, 'utf8'));
    const victim = path.join(root, 'victim-dir');
    await fs.mkdir(victim, { recursive: true });
    await fs.writeFile(recPath, JSON.stringify({ ...rec, to: victim, from: path.join(root, 'stolen') }));
    await rejects(undoOp({ home: H, out, opId: fo.op }), /outside its trash folder|outside an allowed/, 'tampered undo (to) rejected');
    await fs.writeFile(recPath, JSON.stringify({ ...rec, from: path.join(root, 'elsewhere', 'folded') }));
    await rejects(undoOp({ home: H, out, opId: fo.op }), /outside an allowed skills root/, 'tampered undo (from) rejected');
    check(exists(victim) && !exists(path.join(root, 'stolen')), 'victim folder untouched');
    await fs.writeFile(recPath, JSON.stringify(rec));
    await undoOp({ home: H, out, opId: fo.op });
    check(exists(path.join(fo.path, 'SKILL.md')), 'untampered undo works');
    r = await scan({ home: H, out });

    // locks: live lock blocks, stale lock recovered
    const f = opFor('folded');
    await fs.writeFile(path.join(out, '.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await rejects(applyOp({ home: H, out, opId: f.op }), /holds the lock/, 'live lock blocks');
    await fs.writeFile(path.join(out, '.lock'), JSON.stringify({ pid: 999999, at: Date.now() - 2 * LOCK_STALE_MS }));
    await applyOp({ home: H, out, opId: f.op });
    check(!exists(path.join(out, '.lock')), 'stale lock recovered and released');

    // plugin disable/enable through a fake claude CLI
    const fake = path.join(root, 'fake-claude.mjs');
    const calls = path.join(root, 'calls.txt');
    await fs.writeFile(fake, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');`);
    process.env.SKILL_ROUTER_CLAUDE_CMD = JSON.stringify([process.execPath, fake]);
    const p = opFor('plug-a@mkt');
    await applyOp({ home: H, out, opId: p.op });
    await undoOp({ home: H, out, opId: p.op });
    const callLog = await fs.readFile(calls, 'utf8');
    check(callLog.includes('plugin disable plug-a@mkt') && callLog.includes('plugin enable plug-a@mkt'), 'plugin disable/enable via CLI');
    check(!r.ops.some(o => o.target === 'style@mkt'), 'excluded plugin never offered');
    const logText = await fs.readFile(path.join(out, 'audit-log.md'), 'utf8');
    check(/undo: node apply\.mjs --undo/.test(logText), 'log carries undo command');
    delete process.env.SKILL_ROUTER_CLAUDE_CMD;
    console.log(`apply selftest: PASS${linkMade ? '' : ' (symlink case skipped: link creation not permitted)'}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['dry-run', 'selftest', 'list']);
  if (args.selftest) return selftest();
  const home = homeDir(args.home), out = outDir(home, args.out);
  let res;
  if (args.list) res = await listOps(out);
  else if (args.undo) res = await undoOp({ home, out, opId: args.undo });
  else if (args.op) res = await applyOp({ home, out, opId: args.op, dryRun: Boolean(args['dry-run']) });
  else throw new Error('usage: apply.mjs --op <id> [--dry-run] | --undo <id> | --list | --selftest');
  console.log(JSON.stringify(res, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`error: ${e.message}`); process.exit(1); });
}
