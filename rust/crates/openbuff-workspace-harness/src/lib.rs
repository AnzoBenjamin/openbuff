//! Shared constants and helpers for the OpenBuff Rust sidecar crates.
//!
//! Deliberately minimal: this crate exists so the workspace builds and tests
//! green from day one (PC-6: never a build-only path) and so later crates
//! (shim, jobd, index, lanes, pty, infer) have a place for genuinely shared
//! code without each redefining it.

/// Protocol version spoken between the TS host and the Rust sidecars.
///
/// This is a plain constant, not a capability system: the sidecar handshake
/// (spawn → `version` probe → capability negotiation, per the X-3b charter's
/// loading pattern) compares this value literally and a mismatch degrades with
/// a recorded failure, never silently.
pub fn workspace_protocol_version() -> &'static str {
    "1"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_1() {
        assert_eq!(workspace_protocol_version(), "1");
    }
}
