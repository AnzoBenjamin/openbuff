#![cfg(target_os = "linux")]
use openbuff_native::exec::control::{monotonic_ns, Channel, FRAME_LIMIT};
use std::{
    fs,
    io::Write,
    os::{
        fd::AsRawFd,
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn partial_monitor(input: &[u8], disconnect: bool) -> serde_json::Value {
    let (mut host_input, child_input) = UnixStream::pair().unwrap();
    let (host_output, child_output) = UnixStream::pair().unwrap();
    let artifact = fs::File::open(env!("CARGO_BIN_EXE_openbuff-native")).unwrap();
    let expires = monotonic_ns() + 100_000_000;
    let mut command = Command::new(env!("CARGO_BIN_EXE_openbuff-native"));
    command
        .args(["exec", "--expiry-ns", &expires.to_string()])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let fds = [
        child_input.as_raw_fd(),
        child_output.as_raw_fd(),
        artifact.as_raw_fd(),
    ];
    unsafe {
        command.pre_exec(move || {
            for (source, target) in fds.into_iter().zip([3, 4, 5]) {
                if libc::dup2(source, target) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    drop(child_input);
    drop(child_output);
    drop(artifact);
    host_input.write_all(input).unwrap();
    if disconnect {
        drop(host_input);
    }
    let mut channel = Channel::new(host_output.as_raw_fd(), host_output.as_raw_fd()).unwrap();
    let mut reports = Vec::new();
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        for frame in channel.read_turn(FRAME_LIMIT).unwrap() {
            reports.push(serde_json::from_slice::<serde_json::Value>(&frame).unwrap());
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= until {
            child.kill().unwrap();
            panic!("partial monitor exceeded finite bound");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    for frame in channel.read_turn(FRAME_LIMIT).unwrap() {
        reports.push(serde_json::from_slice::<serde_json::Value>(&frame).unwrap());
    }
    let final_report = reports
        .into_iter()
        .find(|v| v["type"] == "final")
        .expect("bounded native final");
    assert_eq!(final_report["targetEntry"], "not-entered");
    assert_eq!(
        final_report["cleanup"]["originalExpiryNs"],
        expires.to_string()
    );
    assert_eq!(final_report["cleanup"]["complete"], true);
    final_report
}
#[test]
fn startup_partial_header_does_not_disable_original_expiry() {
    let r = partial_monitor(&[32, 0], false);
    assert!(r["cause"].as_str().unwrap().contains("deadline"));
}
#[test]
fn disconnected_partial_body_is_protocol_failure_with_no_target() {
    let r = partial_monitor(&[8, 0, 0, 0, b'{'], true);
    assert!(r["cause"].as_str().unwrap().contains("partial"));
}

fn refused_prepare(
    mut plan: String,
    bad_identity: Option<&str>,
    setup_failure: bool,
) -> Vec<serde_json::Value> {
    use openbuff_native::exec::control::{sha256, PROTOCOL};
    let (mut input, child_input) = UnixStream::pair().unwrap();
    let (output, child_output) = UnixStream::pair().unwrap();
    let binary = env!("CARGO_BIN_EXE_openbuff-native");
    let artifact = fs::File::open(binary).unwrap();
    let hash = sha256(&fs::read(binary).unwrap());
    if setup_failure {
        let mut value: serde_json::Value = serde_json::from_str(&plan).unwrap();
        value["artifact"]["sha256"] = hash.clone().into();
        plan = value.to_string();
    }
    let digest = sha256(plan.as_bytes());
    let mut command = Command::new(binary);
    command
        .args(["exec", "--expiry-ns", "none"])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if setup_failure {
        command.env(
            "TMPDIR",
            format!("/proc/{}/no-native-temp", std::process::id()),
        );
    }
    // Keep all sources above destinations so dup2 cannot overwrite a source.
    let sources: Vec<_> = [
        child_input.as_raw_fd(),
        child_output.as_raw_fd(),
        artifact.as_raw_fd(),
    ]
    .into_iter()
    .map(|fd| {
        let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
        assert!(copy >= 10);
        copy
    })
    .collect();
    let inherited = sources.clone();
    unsafe {
        command.pre_exec(move || {
            for (source, target) in inherited.iter().zip([3, 4, 5]) {
                if libc::dup2(*source, target) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let spawned = command.spawn();
    for fd in sources {
        unsafe {
            libc::close(fd);
        }
    }
    let mut child = spawned.unwrap();
    drop((child_input, child_output, artifact));
    for frame in [
        serde_json::json!({"type":"initialize", "protocol":PROTOCOL,
            "workspaceProtocol":openbuff_workspace_harness::workspace_protocol_version().to_string(),
            "artifactSha256":hash}),
        serde_json::json!({"type":"prepare",
            "nonce":if bad_identity == Some("nonce") { "" } else { "refused-original-plan" },
            "planDigest":if bad_identity == Some("digest") { "0".repeat(64) } else { digest.clone() },
            "artifactSha256":if bad_identity == Some("artifact") { "0".repeat(64) } else { hash.clone() },
            "planJson":plan}),
    ] {
        let bytes = serde_json::to_vec(&frame).unwrap();
        input
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .unwrap();
        input.write_all(&bytes).unwrap();
    }
    let mut channel = Channel::new(output.as_raw_fd(), output.as_raw_fd()).unwrap();
    let mut frames = Vec::new();
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        for bytes in channel.read_turn(FRAME_LIMIT).unwrap() {
            frames.push(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap());
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= until {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("refused prepare exceeded bounded cleanup");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    for bytes in channel.read_turn(FRAME_LIMIT).unwrap() {
        frames.push(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap());
    }
    assert!(!frames.iter().any(|f| matches!(
        f["type"].as_str(),
        Some("prepared" | "target-created" | "target-entered")
    )));
    let report = frames.iter().find(|f| f["type"] == "final").unwrap();
    assert_eq!(report["artifactSha256"], hash);
    assert_eq!(report["targetEntry"], "not-entered");
    assert_eq!(report["cleanup"]["complete"], true);
    assert_eq!(
        report["nonce"],
        if bad_identity.is_some() {
            ""
        } else {
            "refused-original-plan"
        }
    );
    assert_eq!(
        report["planDigest"],
        if bad_identity.is_some() { "" } else { &digest }
    );
    frames
}

fn refusal_plan(required: Vec<&str>) -> String {
    use openbuff_native::exec::control::PROTOCOL;
    serde_json::json!({
        "schema":"openbuff.exec.plan.v1", "protocol":PROTOCOL,
        "launchId":"launch", "resourceId":"resource", "resourceGeneration":"generation",
        "ownerId":"owner", "requestId":"request", "leaseId":"lease", "correlation":{},
        "executionBindingDigest":"a".repeat(64),
        "artifact":{"sha256":"a".repeat(64), "platform":"linux-x64-gnu",
            "crateVersion":env!("CARGO_PKG_VERSION"),
            "workspaceProtocol":openbuff_workspace_harness::workspace_protocol_version().to_string()},
        "executable":"/bin/true", "argv":[], "cwd":"/", "env":[],
        "policy":"full-access", "required":required, "optional":[], "mode":"full-access",
        "bwrap":{"path":"/unused", "sha256":"a".repeat(64)}, "mounts":[], "symlinks":[],
        "network":"inherit", "landlock":"disabled", "expiryNs":null, "deadlines":{},
        "filterDigest":"a".repeat(64),
        "cleanupLimits":{"termGraceMs":200,"killReapGraceMs":200,"joinGraceMs":1000,"reportGraceMs":200},
        "outputLimits":{"authority":"host-spool","maxRetainedBytes":1024,
            "controlFrameBytes":65536,"prepareFrameBytes":1048576}
    }).to_string()
}

#[test]
fn authenticated_semantic_refusal_keeps_original_plan_correlation() {
    let frames = refused_prepare(refusal_plan(vec!["deadline-termination"]), None, false);
    assert!(frames
        .iter()
        .any(|f| f["cause"] == "required native deadline mapping unavailable"));
}

#[test]
fn authenticated_parse_refusal_keeps_original_plan_correlation() {
    refused_prepare("{}".into(), None, false);
}

#[test]
fn invalid_envelope_does_not_gain_plan_correlation_or_admission() {
    for fault in ["digest", "artifact", "nonce"] {
        refused_prepare("{}".into(), Some(fault), false);
    }
}

#[test]
fn authenticated_setup_refusal_keeps_correlation_without_target_admission() {
    let frames = refused_prepare(refusal_plan(vec!["exact-env"]), None, true);
    let cause = frames.iter().find(|f| f["type"] == "final").unwrap()["cause"]
        .as_str()
        .unwrap();
    assert!(
        !cause.contains("identity") && !cause.contains("drift"),
        "{cause}"
    );
    assert!(cause.contains("os error"), "{cause}");
}

#[test]
fn final_reader_backpressure_cannot_hold_monitor_past_report_bound() {
    let (mut host_input, child_input) = UnixStream::pair().unwrap();
    let (_stalled_output, mut child_output) = UnixStream::pair().unwrap();
    child_output.set_nonblocking(true).unwrap();
    let padding = [b'x'; 8192];
    loop {
        match child_output.write(&padding) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => panic!("prefill output: {e}"),
        }
    }
    let artifact = fs::File::open(env!("CARGO_BIN_EXE_openbuff-native")).unwrap();
    let expires = monotonic_ns() + 100_000_000;
    let mut command = Command::new(env!("CARGO_BIN_EXE_openbuff-native"));
    command
        .args(["exec", "--expiry-ns", &expires.to_string()])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let fds = [
        child_input.as_raw_fd(),
        child_output.as_raw_fd(),
        artifact.as_raw_fd(),
    ];
    unsafe {
        command.pre_exec(move || {
            for (source, target) in fds.into_iter().zip([3, 4, 5]) {
                if libc::dup2(source, target) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let start = Instant::now();
    let mut child = command.spawn().unwrap();
    drop(child_input);
    drop(child_output);
    drop(artifact);
    host_input.write_all(&[24, 0]).unwrap();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(125));
            assert!(start.elapsed() < Duration::from_millis(700));
            break;
        }
        if start.elapsed() >= Duration::from_millis(700) {
            child.kill().unwrap();
            panic!("stalled native final reader disabled original/report bound");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
