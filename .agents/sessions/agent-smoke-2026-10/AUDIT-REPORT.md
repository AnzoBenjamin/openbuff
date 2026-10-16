# Audit Report — agent-smoke-2026-10

Generated 2026-10-08. Synthesized from 1 shard finding files.

## Top 10 highest-leverage fixes
1. [HIGH] Correctness — ../scratch-utils.ts — Fix add() to add not subtract
2. [LOW] Test coverage gaps — ../scratch-utils.ts — Add unit tests for greet()

(Fewer than 10 findings found; list truncated to actual findings.)

## Cross-cutting findings (span multiple shards)
- None. Only one shard file was present, so no issue spans 2+ shards.

## Findings by domain

### Security
- (none reported)

### Correctness
- [HIGH] ../scratch-utils.ts — `add()` subtracts instead of adding — Risk: any caller relying on add() gets wrong arithmetic results — Fix: change the subtraction to addition; shard reports it was confirmed by reading the file (see Needs follow-up)

### State mutation
- (none reported)

### Error handling
- (none reported)

### Performance
- (none reported)

### Dependency hygiene
- (none reported)

### Test coverage gaps
- [LOW] ../scratch-utils.ts — `greet()` has no test coverage — Risk: regressions in greet() go undetected — Fix: add a unit test for greet()

### API/ABI contract breaks
- (none reported)

## Coverage
- sample-shard.md: 2 findings
- Total: 2 findings across 1 shard.

## Needs follow-up
- Evidence paths are relative (`../scratch-utils.ts`), i.e. outside the findings directory; this synthesis did not (and may not) read source, so the S1 "confirmed by reading the file" claim is taken on trust and should be re-verified by a human against the actual source location.
- Only one shard file was present; a fuller audit would require the remaining shard findings (if any were intended).