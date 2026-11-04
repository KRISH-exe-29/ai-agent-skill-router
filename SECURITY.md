# Security Policy

## What this project touches

| Component | Reads | Writes |
|---|---|---|
| `skill-router` | skill and tool lists already visible to your agent; `~/.skill-router/registry.md` | nothing |
| `cap-scan.mjs` | skill folders, plugin manifests, MCP config **server names only**; session logs **only if you opt in**, and then only tool names and timestamps | `~/.skill-router/*.json` (user-only permissions) |
| `capability-auditor` | the scan output files (read-only subagent: Read/Glob/Grep only) | nothing; the skill saves its report |
| `apply.mjs` | `candidates.json` | moves an approved skill folder into `~/.skill-router/trash/`, or runs `claude plugin disable/enable` |

No network calls. No telemetry. Nothing leaves your machine.

## Safety design

- **Third-party text is untrusted.** Skill descriptions are flattened, truncated to 200 characters and redacted (emails, tokens, keys, long hex/base64) before any agent sees them. Skill bodies are never read into the output.
- **Session history is opt-in.** The parser accepts only known record shapes and keeps tool names and ISO timestamps. Malformed lines are counted, never stored.
- **MCP configs:** only server names are read. Env vars, args, headers and URLs never reach the output.
- **Destructive actions need per-item approval** and are re-validated at apply time. Before acting, `apply.mjs` checks that:
  - the target is not a symlink or junction
  - it is a direct child of a known skills folder
  - its SKILL.md hash matches the scan
  - the destination doesn't already exist

  A lock prevents two runs at once. Every action is logged with its undo command.
- **No hand-edited settings.** Plugins are toggled only through the official `claude plugin` CLI.

## Residual risk

Sanitized descriptions are still up to 200 characters of third-party text, and a model reads them. In Claude Code, the auditor subagent has no write, edit, shell or web tools, so injected text has nothing to act with. On other platforms the main agent does the analysis inline with its normal tools. There, the defences are the prompt rules, the per-item approval step, and `apply.mjs` refusing anything that isn't a scanned candidate. Review proposals before approving them.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/KRISH-exe-29/ai-agent-skill-router/security/advisories/new) instead of a public issue. Expect a reply within 7 days.

## Third-party installers

`npx skills` (vercel-labs/skills) collects anonymous install telemetry by default. Every example in the README sets `DISABLE_TELEMETRY=1`. This project itself collects nothing.
