//! Linux-only Landlock filesystem ruleset for the `exec` role (P5-T1).
//!
//! This whole module is gated behind `#[cfg(target_os = "linux")]` at its
//! declaration site (`exec/mod.rs`), so the `landlock` crate is only pulled in
//! on Linux and the rest of the crate compiles unchanged on macOS/Windows.
//!
//! The ruleset is applied to the CURRENT process BEFORE it `exec`s the target
//! (the restrictions are inherited across `exec`; see [`super::runner`]). We
//! use the widest-supported ABI (`ABI::V1`, read+write) for maximum kernel
//! compatibility in this first slice.

use std::fmt;

use landlock::{
    Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetError,
    RulesetStatus, ABI,
};

use super::plan::ExecPlan;

/// A hard configuration error building/applying the Landlock ruleset.
///
/// A kernel that simply lacks Landlock support is NOT an error — that case is
/// reported as `Ok(false)` (degraded) by [`apply_fs_ruleset`]. These variants
/// only cover genuine misconfiguration (a missing allow path, or a ruleset
/// syscall failure) so the caller never silently runs weaker than requested.
#[derive(Debug)]
pub enum LandlockError {
    /// A ruleset builder/syscall error from the `landlock` crate.
    Ruleset(RulesetError),
    /// An allow path could not be opened (e.g. it does not exist).
    PathFd { path: String, source: String },
}

impl fmt::Display for LandlockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LandlockError::Ruleset(e) => write!(f, "landlock ruleset error: {e}"),
            LandlockError::PathFd { path, source } => {
                write!(f, "cannot open allow path {path:?}: {source}")
            }
        }
    }
}

impl std::error::Error for LandlockError {}

impl From<RulesetError> for LandlockError {
    fn from(e: RulesetError) -> Self {
        LandlockError::Ruleset(e)
    }
}

/// Apply the filesystem ruleset described by `plan` to the current process.
///
/// Returns:
/// - `Ok(true)`  — ruleset enforced (fully or partially) by the kernel.
/// - `Ok(false)` — kernel lacks Landlock support; enforcement degraded (NOT an
///   error: the caller proceeds with `landlock:false, degraded:true`).
/// - `Err(_)`    — hard configuration error (missing allow path or syscall
///   failure).
pub fn apply_fs_ruleset(plan: &ExecPlan) -> Result<bool, LandlockError> {
    let abi = ABI::V1;

    let mut ruleset = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))?
        .create()?;

    for path in &plan.allow_read {
        let fd = PathFd::new(path).map_err(|source| LandlockError::PathFd {
            path: path.clone(),
            source: source.to_string(),
        })?;
        ruleset = ruleset.add_rule(PathBeneath::new(fd, AccessFs::from_read(abi)))?;
    }

    for path in &plan.allow_write {
        let fd = PathFd::new(path).map_err(|source| LandlockError::PathFd {
            path: path.clone(),
            source: source.to_string(),
        })?;
        ruleset = ruleset.add_rule(PathBeneath::new(fd, AccessFs::from_all(abi)))?;
    }

    let status = ruleset.restrict_self()?;
    Ok(!matches!(status.ruleset, RulesetStatus::NotEnforced))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_over_tmpdir_returns_ok_regardless_of_kernel_support() {
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        // Run inside a dedicated throwaway thread: `restrict_self` applies an
        // inescapable restriction to the calling thread, so isolating it here
        // keeps it from poisoning sibling test threads in this process.
        let handle = std::thread::spawn(move || {
            let plan = ExecPlan {
                cmd: "/bin/true".to_string(),
                args: Vec::new(),
                env: None,
                allow_read: vec![tmp],
                allow_write: Vec::new(),
                no_landlock: false,
            };
            apply_fs_ruleset(&plan).map_err(|e| e.to_string())
        });
        let result = handle.join().expect("landlock test thread panicked");
        // Both Ok(true) (enforced) and Ok(false) (kernel without Landlock,
        // degraded) are acceptable; only a hard config error would fail, and a
        // valid tmpdir path must not trigger one.
        assert!(result.is_ok(), "expected Ok, got {result:?}");
    }
}
