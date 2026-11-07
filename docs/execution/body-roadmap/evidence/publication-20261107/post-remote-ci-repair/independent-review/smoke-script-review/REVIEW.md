# Independent smoke-script supplement

Approved `rust/scripts/smoke-test-sidecar.sh` at SHA-256 `4e14f7277fff234942723c0c22399b8f66bf24b098c1797d6eb3341524f0ee81` with executable mode 0755. Root must verify Git mode 100755 when staging. This supplement leaves the separately sealed three-source semantic review and exact-candidate review unchanged.

The version and unknown-role checks remain byte-identical. The only text change updates the obsolete `exec` placeholder probe and its comments/error labels to `daemon`. Current Rust dispatch sends `exec` into the implemented initialization path and retains `daemon` in the structured `NotImplemented` branch. The original no-input exec EOF failure and failed direct smoke remain preserved with their old script hash.

The corrected script passes when directly executed against the same current-source Linux binary from the pinned Rust 1.87.0 offline/locked host build. Independent receipt/hash inspection confirms shell syntax exit 0, daemon exit 2 with exact structured JSON, direct smoke exit 0 with all three categories, and the corrected repository-root whitespace check exit 0. The earlier whitespace command had an incorrectly scoped cwd/path and receives no credit. Source maps and logs are stable and current; no build or product command was rerun by this reviewer.

The smoke script has no active accepted binding or frozen-inventory membership. The workflow and all 193 typecheck input hashes remain unchanged. This is approval of one script repair and local Linux ordinary CLI/placeholder evidence only. It grants no Rust implementation, exec payload/enforcement, Windows/Darwin execution, card acceptance or publication approval. Real remote target execution remains separate.
