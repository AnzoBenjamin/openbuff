//! Role dispatch for the `openbuff-native` multi-call binary (SPEC D49).
//!
//! ONE binary, five roles: `exec`, `daemon`, `infer`, `plugin-host`, `a11y`.
//! The dispatch table lives here as pure functions so it is unit-testable
//! without spawning the binary; `main.rs` is a thin wrapper that maps a
//! [`RoleOutcome`] to stdout/stderr plus a process exit code.
//!
//! Exit-code contract (fail-loud, never silently no-op):
//! - `version`       -> 0, one version line on stdout.
//! - known role      -> 2, one structured `not_implemented` JSON line on
//!   stdout (real role implementations land with P5-T1+).
//! - unknown/missing -> 1, usage line on stderr.

/// The sidecar roles a single `openbuff-native` artifact can multiplex into
/// (SPEC D49).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Exec,
    Daemon,
    Infer,
    PluginHost,
    A11y,
}

impl Role {
    /// The exact argv spelling of this role (also the `role` field of the
    /// structured not-implemented line).
    pub fn name(self) -> &'static str {
        match self {
            Role::Exec => "exec",
            Role::Daemon => "daemon",
            Role::Infer => "infer",
            Role::PluginHost => "plugin-host",
            Role::A11y => "a11y",
        }
    }
}

/// What the dispatcher decided to do for a parsed role.
///
/// Deliberately not `Result`: a known-but-unimplemented role is a *defined*
/// outcome with a defined exit code (2), not an error path — fail-loud, but
/// structured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleOutcome {
    /// The role is recognized but not implemented yet (P5-T1+). Carries the
    /// pre-rendered JSON line for stdout.
    NotImplemented { line: String },
}

/// Parse an argv role spelling into a [`Role`]. `None` = unknown/missing.
pub fn parse_role(arg: &str) -> Option<Role> {
    match arg {
        "exec" => Some(Role::Exec),
        "daemon" => Some(Role::Daemon),
        "infer" => Some(Role::Infer),
        "plugin-host" => Some(Role::PluginHost),
        "a11y" => Some(Role::A11y),
        _ => None,
    }
}

/// Dispatch a known role. All roles are explicit `not_implemented` until the
/// real sandbox/sidecar work lands (P5-T1+).
pub fn handle_role(role: Role) -> RoleOutcome {
    let _ = role;
    RoleOutcome::NotImplemented {
        line: not_implemented_line(role.name()),
    }
}

/// The structured one-line JSON emitted for a recognized-but-unimplemented
/// role. Role names come from the fixed dispatch table, so no JSON escaping
/// is needed (and zero external deps is a charter requirement).
pub fn not_implemented_line(role_name: &str) -> String {
    format!("{{\"ok\":false,\"role\":\"{role_name}\",\"error\":\"not_implemented\"}}")
}

/// The `version` probe output: sidecar protocol version cross-checked against
/// the harness crate (compile-time path dependency), plus this crate's fixed
/// version. The host handshake (spawn -> `version` probe -> capability
/// negotiation) compares the protocol component literally.
pub fn version_line() -> String {
    format!(
        "openbuff-native protocol {} (crate version {})",
        openbuff_workspace_harness::workspace_protocol_version(),
        env!("CARGO_PKG_VERSION"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_role_parses() {
        assert_eq!(parse_role("exec"), Some(Role::Exec));
        assert_eq!(parse_role("daemon"), Some(Role::Daemon));
        assert_eq!(parse_role("infer"), Some(Role::Infer));
        assert_eq!(parse_role("plugin-host"), Some(Role::PluginHost));
        assert_eq!(parse_role("a11y"), Some(Role::A11y));
    }

    #[test]
    fn role_names_round_trip_through_parse() {
        for role in [
            Role::Exec,
            Role::Daemon,
            Role::Infer,
            Role::PluginHost,
            Role::A11y,
        ] {
            assert_eq!(parse_role(role.name()), Some(role));
        }
    }

    #[test]
    fn unknown_and_empty_roles_return_none() {
        assert_eq!(parse_role(""), None);
        assert_eq!(parse_role("bogus-role"), None);
        assert_eq!(parse_role("version"), None); // handled by main, not a role
        assert_eq!(parse_role("Exec"), None); // case-sensitive argv contract
        assert_eq!(parse_role("pluginhost"), None);
    }

    #[test]
    fn every_role_outcome_is_structured_not_implemented() {
        for role in [
            Role::Exec,
            Role::Daemon,
            Role::Infer,
            Role::PluginHost,
            Role::A11y,
        ] {
            match handle_role(role) {
                RoleOutcome::NotImplemented { line } => {
                    assert_eq!(
                        line,
                        format!(
                            "{{\"ok\":false,\"role\":\"{}\",\"error\":\"not_implemented\"}}",
                            role.name()
                        )
                    );
                }
            }
        }
    }

    #[test]
    fn not_implemented_line_is_valid_json_shape() {
        assert_eq!(
            not_implemented_line("exec"),
            "{\"ok\":false,\"role\":\"exec\",\"error\":\"not_implemented\"}"
        );
    }

    #[test]
    fn version_line_cross_checks_harness_protocol_version() {
        // Dynamic cross-check: if the harness bumps the protocol version, this
        // assertion moves with it instead of pinning a stale copy locally.
        let protocol = openbuff_workspace_harness::workspace_protocol_version();
        let line = version_line();
        assert!(
            line.starts_with(&format!("openbuff-native protocol {protocol} ")),
            "version line must lead with the harness protocol version, got: {line}"
        );
        assert!(line.contains("crate version"), "got: {line}");
    }
}
