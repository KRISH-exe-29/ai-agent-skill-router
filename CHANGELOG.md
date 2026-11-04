# Changelog

## 0.1.0 — 2026-11-04

First public release.

- `skill-router`: picks skills, subagents, plugins and MCP tools before non-trivial tasks and announces the picks in one line.
- `skill-audit`: a user-triggered audit with a zero-dependency scanner. It covers Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot and Antigravity skill folders, plus MCP config names. It also offers opt-in usage stats, overlap clusters, and per-item approved apply with undo.
- `capability-auditor` subagent for Claude Code.
- Claude Code plugin with marketplace manifest and a SessionStart reminder hook.
- CI: selftests on Linux, macOS and Windows with Node 18, 20 and 22; pinned install smoke test; repository hygiene scan.
