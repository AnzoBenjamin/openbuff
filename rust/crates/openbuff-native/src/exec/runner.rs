//! Builds and `exec`s the target process described by an [`ExecPlan`].
//!
//! On Linux the Landlock ruleset is applied to THIS process first (see
//! [`super::landlock_fs`]); the subsequent `exec` inherits those restrictions.
//! We never fork — order matters: restrict, then `exec`.

use std::io::Write;
use std::process::{self, Command};

use super::plan::ExecPlan;

/// Execute the plan, replacing the current process image on success.
///
/// Diverges: on unix a successful `exec` never returns; any error path emits a
/// one-line `{"ok":false,"error":...}` envelope to stdout and `process::exit(1)`.
pub fn run_exec(plan: &ExecPlan) -> ! {
    // `mut`/mutation only happens on Linux; keep the binding uniform across
    // targets without a spurious `unused_mut` warning elsewhere.
    #[allow(unused_mut)]
    let mut enforced = false;

    #[cfg(target_os = "linux")]
    if !plan.no_landlock {
        enforced = super::landlock_fs::apply_fs_ruleset(plan)
            .unwrap_or_else(|e| fail(&format!("landlock error: {e}")));
    }

    // Pre-exec status line to STDERR; stdout is reserved for JSON-RPC frames.
    eprintln!("{}", status_line(enforced));

    let mut command = Command::new(&plan.cmd);
    command.args(&plan.args);
    if let Some(env) = &plan.env {
        command.env_clear();
        for (key, value) in env {
            command.env(key, value);
        }
    }

    exec_command(command)
}

/// Build the pre-exec status line JSON. Pure so it is unit-testable without
/// applying a ruleset or execing.
fn status_line(enforced: bool) -> String {
    serde_json::json!({
        "ok": true,
        "landlock": enforced,
        "degraded": !enforced,
    })
    .to_string()
}

/// Emit a `{"ok":false,"error":"<msg>"}` envelope to stdout and exit 1.
fn fail(msg: &str) -> ! {
    let line = serde_json::json!({ "ok": false, "error": msg }).to_string();
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = writeln!(handle, "{line}");
    let _ = handle.flush();
    process::exit(1);
}

#[cfg(unix)]
fn exec_command(mut command: Command) -> ! {
    use std::os::unix::process::CommandExt;
    // `exec` only returns on failure (success replaces the process image), so
    // everything after it is the error path.
    let err = command.exec();
    fail(&format!("exec failed: {err}"));
}

#[cfg(not(unix))]
fn exec_command(mut command: Command) -> ! {
    // No `exec`-replace on non-unix: spawn, wait, and forward the exit code.
    match command.status() {
        Ok(status) => process::exit(status.code().unwrap_or(1)),
        Err(e) => fail(&format!("spawn failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_line_enforced_is_not_degraded() {
        let value: serde_json::Value = serde_json::from_str(&status_line(true)).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["landlock"], true);
        assert_eq!(value["degraded"], false);
    }

    #[test]
    fn status_line_unenforced_is_degraded() {
        let value: serde_json::Value = serde_json::from_str(&status_line(false)).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["landlock"], false);
        assert_eq!(value["degraded"], true);
    }
}
