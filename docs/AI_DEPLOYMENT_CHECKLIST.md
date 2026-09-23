# Claude Code deployment checklist — Encore status

What is done in this repository, and what only your team (not the code) can do.
Update the status column when you complete an item.

## Pre-deployment

| # | Item | Status | Where |
| --- | --- | --- | --- |
| 1 | API keys stored securely, not in code | **Done (repo side)** | No keys in the repo; `.gitignore` blocks `.env*`, `data/`; pre-commit hook rejects key-shaped strings |
| 1 | Team access, key rotation, access logging, offboarding | **Your team** | Anthropic Console: seats, workspace keys, rotation schedule |
| 2 | Default permissions for the project | **Done** | `.claude/settings.json` (allow list for build/test/git, deny for `.env`, `data/`, `rm -rf`, force push, `psql`) |
| 2 | Team trained on the permission model | **Your team** | Walk through `.claude/settings.json` in a session |
| 3 | `.gitignore` includes Claude artifacts | **Done** | `.gitignore` |
| 3 | No credentials in CLAUDE.md | **Done** | `CLAUDE.md` contains rules only |
| 3 | PII handling and retention | **Done (product)** / your policy | Guest phone numbers and names only; automatic retention in `db.py` (`RETENTION`) |
| 4 | AI code review process, PR template | **Done** | `.github/pull_request_template.md` |
| 4 | Test coverage requirement | **Done** | 45 automated tests on PostgreSQL; the PR template requires a run |

## Security

| # | Item | Status | Where |
| --- | --- | --- | --- |
| 5 | Organization policy, MCP allowlist, audit logging | **Your team (enterprise)** | `/etc/claude-code/settings.json` on managed machines |
| 6 | Network: proxy, firewall, no sensitive data in prompts | **Your team** | Do not paste real guest data or secrets into prompts |
| 7 | No hardcoded keys, secret scanning, pre-commit hook | **Done** | `.githooks/pre-commit` — enable per clone: `git config core.hooksPath .githooks` |
| 8 | Static analysis, dependency and licence checks | **Partly** | Python compile check in the hook; one Python dependency (`psycopg`), pinned. Add a scanner in CI when you add one |

## Operational

| # | Item | Status | Where |
| --- | --- | --- | --- |
| 9 | Monitoring and observability | **Your team** | Uptime check on `/api/health` (GET or HEAD); Render logs |
| 10 | Cost management and model guidance | **Your team** | Anthropic Console budgets |
| 11 | Incident response and rollback | **Partly** | Rollback = redeploy the previous commit on Render; platform console can suspend an organization and end sessions. Write your escalation contacts here: _______ |
| 12 | Backup and recovery | **Your team** | Enable PostgreSQL backups on Render; `CLAUDE.md` is versioned in git |

## Team readiness and integration

| # | Item | Status | Where |
| --- | --- | --- | --- |
| 13 | Documentation | **Done** | `README.md`, `PRODUCTION.md`, `CLAUDE.md`, the developer guide PDF, in-app **Guide** page |
| 14 | Training | **Your team** | Use the in-app Guide for staff; the developer guide for engineers |
| 15 | Support structure | **Your team** | Name an internal champion and a support channel |
| 16 | Governance: usage policy, ownership, audit trail | **Partly** | Product keeps an audit trail (`audit`, `platform_audit`); usage policy is yours to approve |
| 17 | CI/CD | **Your team** | Render builds on push; add a CI workflow that runs `npm test` if you want gating |
| 18 | Tool integration | **Done (repo side)** | Git hooks configured; IDE integration is per developer |
| 19 | Repository setup | **Done** | `.claude/settings.json`, `CLAUDE.md`, `.gitignore`, PR template |

## Post-deployment

| # | Item | Status |
| --- | --- | --- |
| 20 | Rollout monitoring | **Your team** — collect first-week usage and feedback |
| 21 | Continuous improvement | **Your team** — review `CLAUDE.md` monthly |
| 22 | Compliance verification | **Your team** — review audit logs, cost and incidents each month |

### Enable the hooks (once per clone)

```
git config core.hooksPath .githooks
```
