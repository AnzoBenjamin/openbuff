//! Exact native plan and phase messages; omission never means ambient inheritance.
use super::control::PROTOCOL;
use std::collections::BTreeSet;

pub(crate) fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(deserializer)
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeArtifact {
    pub sha256: String,
    pub platform: String,
    pub crate_version: String,
    pub workspace_protocol: String,
}
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeTool {
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeMount {
    pub source: String,
    pub destination: String,
    pub write: bool,
    pub dev: String,
    pub ino: String,
}
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupLimits {
    pub term_grace_ms: u64,
    pub kill_reap_grace_ms: u64,
    pub join_grace_ms: u64,
    pub report_grace_ms: u64,
}
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputLimits {
    pub authority: String,
    pub max_retained_bytes: u64,
    pub control_frame_bytes: u64,
    pub prepare_frame_bytes: u64,
}
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativePlan {
    pub schema: String,
    pub protocol: String,
    pub launch_id: String,
    pub resource_id: String,
    pub resource_generation: String,
    pub owner_id: String,
    pub request_id: String,
    pub lease_id: String,
    pub correlation: serde_json::Value,
    pub execution_binding_digest: String,
    pub artifact: NativeArtifact,
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub policy: String,
    pub required: Vec<String>,
    pub optional: Vec<String>,
    pub mode: String,
    pub bwrap: NativeTool,
    pub mounts: Vec<NativeMount>,
    pub symlinks: Vec<(String, String)>,
    pub network: String,
    pub landlock: String,
    #[serde(deserialize_with = "required_option")]
    pub expiry_ns: Option<String>,
    pub deadlines: serde_json::Value,
    pub filter_digest: String,
    pub cleanup_limits: CleanupLimits,
    pub output_limits: OutputLimits,
}

#[derive(Debug, serde::Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Input {
    Initialize {
        protocol: String,
        workspace_protocol: String,
        artifact_sha256: String,
    },
    Prepare {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        plan_json: String,
    },
    Commit {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        #[serde(deserialize_with = "required_option")]
        expiry_ns: Option<String>,
    },
    Stop {
        reason: String,
    },
    Abort {
        reason: String,
    },
    ChildIdentityAccepted {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        target_pid: i32,
        target_local_pid: i32,
        target_start_time: String,
        #[serde(deserialize_with = "required_option")]
        expiry_ns: Option<String>,
    },
}

pub fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn absolute_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.contains('\0')
        && !value.split('/').any(|p| p == ".." || p == ".")
}
impl NativePlan {
    pub fn validate(&self, expiry: Option<u64>) -> Result<(), String> {
        if self.cleanup_limits.term_grace_ms != 200
            || self.cleanup_limits.kill_reap_grace_ms != 200
            || self.cleanup_limits.join_grace_ms != 1000
            || self.cleanup_limits.report_grace_ms != 200
            || !["host-spool", "unavailable"].contains(&self.output_limits.authority.as_str())
            || self.output_limits.max_retained_bytes == 0
            || self.output_limits.max_retained_bytes > 1_073_741_824
            || self.output_limits.control_frame_bytes != 65_536
            || self.output_limits.prepare_frame_bytes != 1_048_576
        {
            return Err("native output/cleanup bounds mismatch".into());
        }
        if self.schema != "openbuff.exec.plan.v1"
            || self.protocol != PROTOCOL
            || self.artifact.platform != "linux-x64-gnu"
            || self.artifact.crate_version != env!("CARGO_PKG_VERSION")
            || self.artifact.workspace_protocol
                != openbuff_workspace_harness::workspace_protocol_version().to_string()
            || !valid_digest(&self.artifact.sha256)
            || !valid_digest(&self.execution_binding_digest)
        {
            return Err("native plan protocol/build/identity mismatch".into());
        }
        for id in [
            &self.launch_id,
            &self.resource_id,
            &self.resource_generation,
            &self.owner_id,
            &self.request_id,
            &self.lease_id,
        ] {
            if id.is_empty() || id.len() > 256 || id.contains('\0') {
                return Err("invalid plan identity".into());
            }
        }
        if !absolute_path(&self.executable)
            || !absolute_path(&self.cwd)
            || self.argv.iter().any(|v| v.contains('\0'))
        {
            return Err("invalid exact target path/argv".into());
        }
        let mut keys = BTreeSet::new();
        for (key, value) in &self.env {
            if key.is_empty()
                || key.contains(['=', '\0'])
                || value.contains('\0')
                || !keys.insert(key)
            {
                return Err("invalid/duplicate exact environment entry".into());
            }
        }
        if self
            .expiry_ns
            .as_ref()
            .map(|s| s.parse::<u64>())
            .transpose()
            .map_err(|_| "invalid native expiry")?
            != expiry
        {
            return Err("plan cannot replace original native expiry".into());
        }
        let policies = [
            "read-only",
            "librarian-read-only",
            "git-commit",
            "dependency-mutation",
            "validation-diagnosis",
            "tmux-test",
            "workspace-write",
            "full-access",
        ];
        if !policies.contains(&self.policy.as_str())
            || !["linux-bwrap-seccomp", "full-access"].contains(&self.mode.as_str())
            || !["deny", "inherit"].contains(&self.network.as_str())
            || !["disabled", "optional", "required"].contains(&self.landlock.as_str())
        {
            return Err("unknown native policy".into());
        }
        let mut caps = BTreeSet::new();
        for capability in self.required.iter().chain(self.optional.iter()) {
            if ![
                "exact-env",
                "cooperative-cancellation",
                "filesystem-isolation",
                "network-isolation",
                "process-tree-containment",
                "memory-limit",
                "deadline-termination",
            ]
            .contains(&capability.as_str())
                || !caps.insert(capability)
            {
                return Err("invalid/overlapping native capabilities".into());
            }
        }
        if self.required.iter().any(|c| c == "memory-limit") {
            return Err("native aggregate memory limit unavailable".into());
        }
        if self.required.iter().any(|c| c == "deadline-termination") && expiry.is_none() {
            return Err("required native deadline mapping unavailable".into());
        }
        if self.policy == "full-access" {
            if self.mode != "full-access"
                || self.network != "inherit"
                || self.landlock != "disabled"
                || self
                    .required
                    .iter()
                    .any(|c| !["exact-env", "cooperative-cancellation"].contains(&c.as_str()))
            {
                return Err("full-access isolation/scope requirements conflict".into());
            }
        } else if self.mode != "linux-bwrap-seccomp" {
            return Err("restricted native profile requires bubblewrap+seccomp".into());
        }
        if self.required.iter().any(|c| c == "network-isolation") && self.network != "deny" {
            return Err("required network isolation unavailable".into());
        }
        let mut destinations = BTreeSet::new();
        for mount in &self.mounts {
            if !absolute_path(&mount.source)
                || !absolute_path(&mount.destination)
                || mount.source == "/"
                || ["/", "/proc", "/dev", "/tmp"].contains(&mount.destination.as_str())
                || mount.destination.starts_with("/.openbuff")
                || !destinations.insert(&mount.destination)
                || mount.dev.parse::<u64>().is_err()
                || mount.ino.parse::<u64>().is_err()
            {
                return Err("invalid native mount roster".into());
            }
            if ["read-only", "librarian-read-only"].contains(&self.policy.as_str()) && mount.write {
                return Err("read-only native policy contains writable mount".into());
            }
        }
        for (source, destination) in &self.symlinks {
            if source.contains('\0')
                || !absolute_path(destination)
                || destination == "/"
                || destination.starts_with("/.openbuff")
                || !destinations.insert(destination)
            {
                return Err("invalid native loader symlink roster".into());
            }
        }
        if self.mode != "full-access"
            && !self.mounts.iter().any(|m| {
                self.cwd == m.destination || self.cwd.starts_with(&(m.destination.clone() + "/"))
            })
        {
            return Err("cwd outside selected native mounts".into());
        }
        Ok(())
    }
}
