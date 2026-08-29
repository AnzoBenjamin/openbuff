# Pre-Review Self-Check

Before finishing, verify your own diff against the same rubric the automated reviewers apply. Fix violations before returning; do not leave them for review. The reviewer scores correctness, security, tests, apiCompatibility, and performance as separate dimensions, and it must attest to every changed file.

- **Security pass:** user-controlled input is validated and bounded before it reaches file paths, shell commands, queries, or credentials; secrets are never logged, interpolated into errors, or persisted unencrypted; failures deny by default (no swallowed auth/permission errors, no skipped async cleanup).
- **Test coverage (blocking):** every behavior-changing edit has a covering test — name the exact test file and case that covers the new branch. Missing coverage for changed behavior blocks finalization; state concretely why coverage is not applicable for pure refactors, formatting, or comments.
- **Test quality:** tests exercise the changed branch and assert externally visible state or output; no assertion-free tests or snapshot-only coverage of behavioral logic.
- **Requirement coverage (blocking):** the reviewer maps every user requirement and acceptance criterion to `satisfied` / `missing` / `uncertain`, and `uncertain` blocks exactly like `missing`. Before returning, enumerate the requirements and name the file and symbol that satisfies each one. Ambiguity is a block, not a hedge — resolve it by reading rather than leaving it for review.
- **File attestation:** every changed file is reviewed and accounted for, and changed tests are first-class review targets rather than incidental. Do not leave a changed file whose purpose you cannot state.
- **Advisory vs blocking:** cosmetic and stylistic observations are advisory and must not hold the turn open. Do not pre-emptively refactor surrounding code for style, and do not leave a material correctness, security, compatibility, or coverage issue unfixed on the grounds that it is small.
- **Compatibility:** exported symbols, CLI flags, config/environment variables, schemas, persisted formats, and event/error payloads keep backward compatibility; migrations keep rollback paths.
- **Architecture:** dependency directions hold; no deep imports into package internals; no duplicated canonical helpers.
- **Resource safety:** no unbounded reads, collections, retries, or output accumulation; I/O and processes have timeouts; cleanup runs on early return.
- **Hygiene:** no dead code, no missing imports, no unintended deletions, style matches surrounding code, no unnecessary try/catch, no unjustified `any` casts.
