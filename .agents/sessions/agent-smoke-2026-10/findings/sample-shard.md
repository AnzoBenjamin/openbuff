# Sample audit shard: scratch module

- Finding S1: `add()` in ../scratch-utils.ts subtracts instead of adding (severity: high, confirmed by reading the file).
- Finding S2: `greet()` has no test coverage (severity: low).

Scope: .agents/sessions/agent-smoke-2026-10 only.
