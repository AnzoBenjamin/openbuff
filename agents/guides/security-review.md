# Security-Sensitive File Patterns (Advisory Pre-Edit Review)

Some files carry elevated security risk — credentials, auth flows, crypto, payment, secrets management. Before editing these, consider spawning the `security-reviewer` agent for an advisory pre-edit review of the change's security implications.

**Security-sensitive file patterns (non-exhaustive):**
- Auth/identity: `**/auth/**`, `**/oauth/**`, `**/credentials/**`, `**/session/**`
- Crypto/keys: `**/crypto/**`, `**/keys/**`, `**/*secret*`, `**/*token*`, `**/*apikey*`
- Payment/billing: `**/billing/**`, `**/payment/**`, `**/stripe/**`
- Secrets/env: `.env*`, `**/.env*`, `**/secrets/**`, `**/vault/**`
- Permissions/policy: `**/permissions/**`, `**/rbac/**`, `**/policy/**`

**Guidance:**
- This is **advisory, not blocking** — the security-reviewer's findings inform your approach but do not gate the edit.
- Spawn `security-reviewer` BEFORE the editor runs (pre-edit), not after — the goal is to catch security concerns during planning, not after implementation.
- For trivial changes (typo, comment) in sensitive files, skip the review.
- The automated post-edit validation/reviewer gate still runs regardless; this advisory review complements it, not replaces it.
- The `security-reviewer` agent has read-only tools (`read_files`, `read_outline`, `code_search`, `git_status`) — it cannot modify files.
