# Audit findings: coverage-allow-position-correction

- Subsystems: scripts
- Features: m3-t2-hot-paths-benchmark
- Files covered: 1

## [LOW] test-coverage — scripts/.coverage-allow:14 — CORRECTION: .coverage-allow sorted position is after investigate-user.ts / before query-minimax-cache-stats.ts (not between fireworks-deployment-stats.ts and get-changelog.ts)
- **Risk:** Following the earlier shard's instruction (after fireworks-deployment-stats.ts / before get-changelog.ts) would violate the file's keep-sorted rule: g < i < m, so the entry belongs after investigate-user.ts, not before get-changelog.ts.
- **Fix:** Insert 'measure-m3-t2-hot-paths.ts' on its own line immediately after 'investigate-user.ts' and before 'query-minimax-cache-stats.ts'.
- **Evidence:** Live file lines 12-16: fireworks-deployment-stats.ts (12), get-changelog.ts (13), investigate-user.ts (14), query-minimax-cache-stats.ts (15), query-usage-stats.ts (16). Correct insertion: between investigate-user.ts and query-minimax-cache-stats.ts. Supersedes the erroneous position claim in shard site-verification.md.

## Coverage receipt

### Subsystems
- scripts

### Features
- m3-t2-hot-paths-benchmark

### Files
- scripts/.coverage-allow

### Domains
- test-coverage
