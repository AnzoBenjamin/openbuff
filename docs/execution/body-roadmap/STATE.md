# Current execution checkpoint

The [ledger](ledger.json) records **10 of 39 completion nodes as accepted**: B01, B02, B03, B04, B05, B08, B18, B28, B30 and B36. **29 nodes remain unaccepted. B19 is in progress.** The [plan](../../../.agents/sessions/body-capability-review-2026-11-05/PLAN.md) and [specification](../../../.agents/sessions/body-capability-review-2026-11-05/SPEC.md) define the remaining scope.

B05 was the latest promotion. Its original acceptance and predecessor renewals remain historical evidence. Current B19 changes affect accepted source scopes, which require renewal before another promotion; this checkpoint does not claim that the live ledger validator has zero errors. Preservation of receipt bytes does not renew their source bindings.

B19 now carries captured host execution policy through SDK startup, filesystem, Git, terminal, MCP, language-tool and supervision paths. The latest bounded repair restores the documented tolerant diagnostic default while preserving captured-host strict opt-in. Fixture repairs cover quiet Git read arguments, real filesystem mutation, Blender execution identity and trusted MCP continuation.

Recorded checks completed on frozen 3,071-input candidates before cleanup:

| Check | Candidate | Result |
| --- | --- | --- |
| SDK adapter regressions | Preflight 18 | 226 passed, 0 failed |
| Required seven-file repair regressions | Preflight 18 | 307 passed, 0 failed |
| Diagnostic mode controls | Preflight 18 | 114 passed, 0 failed |
| Workspace typecheck | Preflight 18 | All 11 workspaces passed |
| SDK build and CLI agent prebuild | Preflight 18 | Passed |
| CLI CI suite | Publication 19 | 4,552 passed, 146 skipped, 0 failed |

The recorded checks reported no source changes during execution. Tool definition regeneration exited successfully but changed two descriptions in four generated files; that drift is preserved in its receipt. The subsequent publication candidate includes those generated changes and has manifest SHA-256 `5cd902bebf27e91ec7fc29baa0263cf324a80adbb90b1ad93f3f35bbfc2de741`. Original failed attempts remain archived, including an invocation whose relative test filters discovered historical evidence copies.

These checks do not accept B19. Its complete producer/branch matrix, compiled cases, packed consumers, independent final reviews and affected accepted-scope renewals remain pending. The historical installed CLI artifact also does not establish installed coverage for current B19 sources.

The [researcher-web addition](researcher-web-agent-browser.md) remains registered under B33. RWEB-0 feasibility is approved for its recorded Linux toolchain; RWEB-1 through RWEB-4, B20 and B33 implementation remain pending. Integrated delivery retains the plan's prerequisites.

Required evidence and ignored build/dependency context are preserved in the [verified archive](archive/README.md). Full restoration verified all 26,776 files and their permissions, including 3,431 required evidence paths and 1,212 context paths. The unchanged ledger validator found only hash differences across 131 current source paths; it reported no missing evidence. Active B19/RWEB records are included; unreferenced historical runtime/preparation material is retained in a separate local archive. Both archives and every original slated for removal verified before 40,972 archived paths and ten saved symlinks were cleaned from the working tree.

Publication also repairs the outdated CASE13 benchmark fixture: it now launches an authenticated, owned cargo executable with an explicit child PATH and verifies deadline termination. The independent bare-kill control remains. Its focused seven tests and the post-cleanup scripts suite's 386 tests pass. Publication verification is recorded in [verification.json](archive/verification.json); this fixture repair does not renew the earlier candidate hashes.

Restore into a disposable source checkout when inspecting receipts or running the unchanged ledger validator:

```sh
python3 docs/execution/body-roadmap/archive/restore.py --check
python3 docs/execution/body-roadmap/archive/restore.py --destination /path/to/disposable-checkout --include-context
cd /path/to/disposable-checkout
python3 docs/execution/body-roadmap/validate-ledger.py
```

The restore helper verifies the pinned manifest, every part and every object before writing. It refuses different existing bytes. Restored context preserves the archived checkpoint, including current SDK outputs; source-binding differences against historical approvals remain visible. It is not an installation or acceptance command. Legacy archive helpers remain for their original inventories; they are not a substitute for the current archive.
