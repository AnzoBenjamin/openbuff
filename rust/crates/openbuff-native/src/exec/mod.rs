//! The `exec` role (P5-T1): a JSON-RPC `initialize` handshake over
//! stdin/stdout, followed by a Landlock-sandboxed `exec` of the target command
//! described by an [`ExecPlan`].
//!
//! Protocol (one JSON object per line):
//! 1. stdin line 1 — `initialize` request. `params.protocolVersion` MUST equal
//!    [`openbuff_workspace_harness::workspace_protocol_version`] (single source
//!    of truth; never hardcoded here). On match we reply with a JSON-RPC
//!    `result` line on stdout; on mismatch (or malformed/wrong-method) we reply
//!    with a JSON-RPC `error` object (`code: -32600`) on stdout and exit 1.
//! 2. stdin line 2 — the [`ExecPlan`] as JSON. We apply the Landlock ruleset
//!    (Linux only) and then `exec` the target, replacing this process.
//!
//! Exit-code contract: any failure before `exec` (EOF, malformed plan, bad
//! handshake, landlock/exec error) emits a one-line JSON envelope and exits 1.

use std::io::{BufRead, Write};
use std::process;

mod plan;
mod runner;

#[cfg(target_os = "linux")]
mod landlock_fs;

use plan::ExecPlan;

/// A failure validating the JSON-RPC `initialize` handshake line. Kept as a
/// typed enum so the pure [`validate_handshake`] helper is unit-testable
/// without touching stdin.
#[derive(Debug)]
enum HandshakeError {
    /// The line was not valid JSON.
    Malformed(String),
    /// A required field was absent.
    MissingField(&'static str),
    /// The `method` field was not `"initialize"`.
    WrongMethod(String),
    /// `params.protocolVersion` did not equal the harness protocol version.
    VersionMismatch { expected: String, got: String },
}

impl HandshakeError {
    /// Human-readable message embedded in the JSON-RPC `error` object.
    fn message(&self) -> String {
        match self {
            HandshakeError::Malformed(e) => format!("malformed handshake JSON: {e}"),
            HandshakeError::MissingField(f) => format!("missing required field {f:?}"),
            HandshakeError::WrongMethod(m) => {
                format!("expected method \"initialize\", got {m:?}")
            }
            HandshakeError::VersionMismatch { expected, got } => {
                format!("protocolVersion mismatch: expected {expected:?}, got {got:?}")
            }
        }
    }
}

/// Validate the JSON-RPC `initialize` handshake line (pure; no I/O).
///
/// The protocol version is cross-checked against
/// [`openbuff_workspace_harness::workspace_protocol_version`] dynamically, so a
/// harness bump moves this check with it instead of pinning a stale copy.
fn validate_handshake(line: &str) -> Result<(), HandshakeError> {
    let value: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|e| HandshakeError::Malformed(e.to_string()))?;

    let method = value
        .get("method")
        .and_then(|m| m.as_str())
        .ok_or(HandshakeError::MissingField("method"))?;
    if method != "initialize" {
        return Err(HandshakeError::WrongMethod(method.to_string()));
    }

    let got = value
        .get("params")
        .and_then(|p| p.get("protocolVersion"))
        .and_then(|p| p.as_str())
        .ok_or(HandshakeError::MissingField("params.protocolVersion"))?;

    let expected = openbuff_workspace_harness::workspace_protocol_version().to_string();
    if got != expected.as_str() {
        return Err(HandshakeError::VersionMismatch {
            expected,
            got: got.to_string(),
        });
    }

    Ok(())
}

/// The JSON-RPC success response line (no trailing newline; the caller adds
/// one). Pure so it is unit-testable without stdin/stdout.
fn handshake_response_line() -> String {
    let protocol = openbuff_workspace_harness::workspace_protocol_version().to_string();
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": { "protocolVersion": protocol },
    })
    .to_string()
}

/// The JSON-RPC error response line for a failed handshake.
fn handshake_error_line(err: &HandshakeError) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "error": { "code": -32600, "message": err.message() },
    })
    .to_string()
}

/// Write one newline-terminated line to stdout and flush.
fn write_line(line: &str) {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = writeln!(handle, "{line}");
    let _ = handle.flush();
}

/// Emit a `{"ok":false,"error":"<msg>"}` envelope to stdout and exit 1. Used
/// for non-handshake pre-exec failures (EOF, malformed plan).
fn fail(msg: &str) -> ! {
    write_line(&serde_json::json!({ "ok": false, "error": msg }).to_string());
    process::exit(1);
}

/// Drive the `exec` role end-to-end. Never returns: it either `exec`s the
/// target process or `process::exit`s on failure.
pub fn run() -> ! {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();

    // Phase 1: handshake.
    let mut handshake = String::new();
    match reader.read_line(&mut handshake) {
        Ok(0) => fail("EOF reading handshake line"),
        Ok(_) => {}
        Err(e) => fail(&format!("error reading handshake line: {e}")),
    }
    if let Err(err) = validate_handshake(&handshake) {
        write_line(&handshake_error_line(&err));
        process::exit(1);
    }
    write_line(&handshake_response_line());

    // Phase 2: ExecPlan.
    let mut plan_line = String::new();
    match reader.read_line(&mut plan_line) {
        Ok(0) => fail("EOF reading ExecPlan line"),
        Ok(_) => {}
        Err(e) => fail(&format!("error reading ExecPlan line: {e}")),
    }
    let plan: ExecPlan = match serde_json::from_str(plan_line.trim()) {
        Ok(p) => p,
        Err(e) => fail(&format!("malformed ExecPlan JSON: {e}")),
    };

    runner::run_exec(&plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn harness_version() -> String {
        openbuff_workspace_harness::workspace_protocol_version().to_string()
    }

    #[test]
    fn valid_handshake_is_ok() {
        let v = harness_version();
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{v}"}}}}"#
        );
        assert!(validate_handshake(&line).is_ok());
    }

    #[test]
    fn version_mismatch_is_error() {
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"definitely-not-a-real-version"}}"#;
        match validate_handshake(line) {
            Err(HandshakeError::VersionMismatch { got, .. }) => {
                assert_eq!(got, "definitely-not-a-real-version");
            }
            other => panic!("expected VersionMismatch, got {other:?}"),
        }
    }

    #[test]
    fn malformed_json_is_error() {
        match validate_handshake("this is not json") {
            Err(HandshakeError::Malformed(_)) => {}
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn wrong_method_is_error() {
        let v = harness_version();
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"shutdown","params":{{"protocolVersion":"{v}"}}}}"#
        );
        match validate_handshake(&line) {
            Err(HandshakeError::WrongMethod(m)) => assert_eq!(m, "shutdown"),
            other => panic!("expected WrongMethod, got {other:?}"),
        }
    }

    #[test]
    fn missing_protocol_version_is_error() {
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        match validate_handshake(line) {
            Err(HandshakeError::MissingField("params.protocolVersion")) => {}
            other => panic!("expected MissingField, got {other:?}"),
        }
    }

    #[test]
    fn response_line_carries_harness_protocol_version() {
        let value: serde_json::Value =
            serde_json::from_str(&handshake_response_line()).unwrap();
        assert_eq!(value["jsonrpc"], "2.0");
        assert_eq!(value["id"], 1);
        assert_eq!(value["result"]["protocolVersion"], harness_version());
    }

    #[test]
    fn error_line_is_jsonrpc_error_object() {
        let err = HandshakeError::VersionMismatch {
            expected: "1".to_string(),
            got: "2".to_string(),
        };
        let value: serde_json::Value =
            serde_json::from_str(&handshake_error_line(&err)).unwrap();
        assert_eq!(value["jsonrpc"], "2.0");
        assert_eq!(value["id"], 1);
        assert_eq!(value["error"]["code"], -32600);
        assert!(value["error"]["message"].as_str().unwrap().contains("mismatch"));
    }
}
