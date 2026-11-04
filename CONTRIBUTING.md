# Contributing

Thanks for helping make agent tool selection less chaotic.

## Ground rules

- **Zero dependencies.** Scripts run on plain Node.js 18 or newer. Please don't add npm packages.
- **Local only.** No network calls, no telemetry.
- **Every safety check has a test.** If you touch `cap-scan.mjs` or `apply.mjs`, extend its `--selftest`.
- **Honest docs.** Only document install paths you have verified against official docs, and link the source.

## Dev loop

```bash
node scripts/validate-skills.mjs
node skills/skill-audit/scripts/cap-scan.mjs --selftest
node skills/skill-audit/scripts/apply.mjs --selftest
claude plugin validate .        # if you have Claude Code
```

CI runs the same checks on Linux, macOS and Windows with Node 18, 20 and 22.

## Good first contributions

- Add another platform's skill folder or MCP config to `cap-scan.mjs`, with a fixture and an official doc link.
- Improve the router's category table in `skills/skill-router/SKILL.md`.
- Share an anonymised registry that works well for your stack in `templates/`.

## Pull requests

Keep them small and focused. Describe what you tested. By contributing, you agree your work is licensed under Apache-2.0.
