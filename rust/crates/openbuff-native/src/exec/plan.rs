//! The [`ExecPlan`]: the second stdin line (after a successful handshake)
//! describing the command to sandbox and `exec`.

/// A sandboxed command to execute.
///
/// All fields except `cmd` default (via `#[serde(default)]`) so a minimal
/// `{"cmd":"/bin/true"}` plan is valid. `env: Some(_)` means "clear the
/// environment and set exactly these pairs"; `env: None` means "inherit the
/// parent environment".
#[derive(Debug, serde::Deserialize)]
pub struct ExecPlan {
    /// The program to execute (resolved by the OS; not shell-interpreted).
    pub cmd: String,
    /// Arguments passed to `cmd` (argv[1..]).
    #[serde(default)]
    pub args: Vec<String>,
    /// Explicit environment (clear + set); `None` inherits the parent env.
    #[serde(default)]
    pub env: Option<Vec<(String, String)>>,
    /// Filesystem hierarchies the sandbox may read under (Linux/Landlock).
    #[serde(default)]
    pub allow_read: Vec<String>,
    /// Filesystem hierarchies the sandbox may read+write under (Linux/Landlock).
    #[serde(default)]
    pub allow_write: Vec<String>,
    /// Opt out of Landlock enforcement entirely (debug/escape hatch).
    #[serde(default)]
    pub no_landlock: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn representative_plan_deserializes() {
        let json = r#"{
            "cmd": "/usr/bin/node",
            "args": ["--version"],
            "env": [["PATH", "/usr/bin"], ["HOME", "/home/x"]],
            "allow_read": ["/usr", "/lib"],
            "allow_write": ["/tmp/work"],
            "no_landlock": true
        }"#;
        let plan: ExecPlan = serde_json::from_str(json).unwrap();
        assert_eq!(plan.cmd, "/usr/bin/node");
        assert_eq!(plan.args, vec!["--version"]);
        assert_eq!(
            plan.env,
            Some(vec![
                ("PATH".to_string(), "/usr/bin".to_string()),
                ("HOME".to_string(), "/home/x".to_string()),
            ])
        );
        assert_eq!(plan.allow_read, vec!["/usr", "/lib"]);
        assert_eq!(plan.allow_write, vec!["/tmp/work"]);
        assert!(plan.no_landlock);
    }

    #[test]
    fn minimal_plan_uses_defaults() {
        let plan: ExecPlan = serde_json::from_str(r#"{"cmd":"/bin/true"}"#).unwrap();
        assert_eq!(plan.cmd, "/bin/true");
        assert!(plan.args.is_empty());
        assert!(plan.env.is_none());
        assert!(plan.allow_read.is_empty());
        assert!(plan.allow_write.is_empty());
        assert!(!plan.no_landlock);
    }
}
