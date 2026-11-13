//! Explicit Landlock ABI1 layer, applied only inside the native entry stub.
//!
//! This whole module is gated behind `#[cfg(target_os = "linux")]` at its
//! declaration site (`exec/mod.rs`), so the `landlock` crate is only pulled in
//! on Linux and the rest of the crate compiles unchanged on macOS/Windows.
//!
//! The ruleset is applied to the CURRENT process BEFORE it `exec`s the target
//! (the restrictions are inherited across `exec`; see [`super::runner`]). We
//! use the explicitly selected ABI1 rights (`ABI::V1`, read+write). Newer ABI
//! rights are not part of this layer's reported enforcement.

use std::fmt;

use landlock::{
    Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetError,
    RulesetStatus, ABI,
};

/// A hard configuration error building/applying the Landlock ruleset.
///
/// A kernel restriction outcome is reported separately by
/// [`apply_native_ruleset`]; errors retain their builder/syscall cause.
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

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLandlockReport {
    pub abi: u32,
    pub status: String,
    pub handled_rights: String,
    pub read_paths: Vec<String>,
    pub write_paths: Vec<String>,
}

/// The native stub records the exact V1 outcome; Partial is never upgraded to
/// fully enforced. Namespace confinement remains a distinct mechanism.
pub fn apply_native_ruleset(
    plan: &super::control::NativePlan,
) -> Result<NativeLandlockReport, LandlockError> {
    let abi = ABI::V1;
    let rights = AccessFs::from_all(abi);
    let mut ruleset = Ruleset::default().handle_access(rights)?.create()?;
    let mut read_paths = Vec::new();
    let mut write_paths = Vec::new();
    for mount in &plan.mounts {
        let fd = PathFd::new(&mount.destination).map_err(|source| LandlockError::PathFd {
            path: mount.destination.clone(),
            source: source.to_string(),
        })?;
        ruleset = ruleset.add_rule(PathBeneath::new(
            fd,
            if mount.write {
                rights
            } else {
                AccessFs::from_read(abi)
            },
        ))?;
        if mount.write {
            write_paths.push(mount.destination.clone());
        } else {
            read_paths.push(mount.destination.clone());
        }
    }
    // Namespace-local temporary storage is an explicit writable grant. Minimal
    // dev/proc access supports ordinary runtimes inside the isolated namespace.
    for path in ["/tmp", "/dev"] {
        let fd = PathFd::new(path).map_err(|source| LandlockError::PathFd {
            path: path.into(),
            source: source.to_string(),
        })?;
        ruleset = ruleset.add_rule(PathBeneath::new(fd, rights))?;
        write_paths.push(path.into());
    }
    let fd = PathFd::new("/proc").map_err(|source| LandlockError::PathFd {
        path: "/proc".into(),
        source: source.to_string(),
    })?;
    ruleset = ruleset.add_rule(PathBeneath::new(fd, AccessFs::from_read(abi)))?;
    read_paths.push("/proc".into());
    let status = ruleset.restrict_self()?;
    let status = match status.ruleset {
        RulesetStatus::FullyEnforced => "fully-enforced",
        RulesetStatus::PartiallyEnforced => "partially-enforced",
        RulesetStatus::NotEnforced => "not-enforced",
    }
    .into();
    Ok(NativeLandlockReport {
        abi: 1,
        status,
        handled_rights: format!("{rights:?}"),
        read_paths,
        write_paths,
    })
}
