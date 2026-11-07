//! Thin binary wrapper around the `openbuff_native` role dispatcher.
//!
//! All logic lives in `src/lib.rs` (pure, unit-tested); this file only maps
//! argv + outcomes to stdout/stderr and process exit codes.

use std::process::ExitCode;

use openbuff_native::{handle_role, parse_role, version_line, RoleOutcome};

const USAGE: &str = "usage: openbuff-native <role>\n\nroles:\n  exec         job executor sandbox (P5-T1)\n  daemon       jobd supervisor (P5-T2)\n  infer        parse/inference tier (P9-T6)\n  plugin-host  plugin host (P5)\n  a11y         accessibility host (P5)\n  version      print sidecar protocol + crate version\n";

fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        // `version` is not a Role: it is the handshake probe.
        Some("version") => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        Some(arg) => match parse_role(arg) {
            Some(role) => match handle_role(role) {
                RoleOutcome::NotImplemented { line } => {
                    println!("{line}");
                    ExitCode::from(2)
                }
            },
            None => {
                eprintln!("error: unknown role '{arg}'\n\n{USAGE}");
                ExitCode::from(1)
            }
        },
        None => {
            eprintln!("error: missing role\n\n{USAGE}");
            ExitCode::from(1)
        }
    }
}
