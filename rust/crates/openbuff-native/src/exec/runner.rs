//! Bounded one-shot monitor. All control and waits are nonblocking.
#[cfg(target_os = "linux")]
mod native {
    use super::super::{
        control::{self, Channel, Input, NativePlan},
        linux_sandbox,
    };
    use std::{
        collections::BTreeSet,
        fs, io,
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                fs::{FileExt, MetadataExt, PermissionsExt},
                net::{UnixListener, UnixStream},
                process::CommandExt,
            },
        },
        process::{self, Command},
    };

    fn expiry(arg: Option<&String>) -> Result<Option<u64>, String> {
        match arg.map(String::as_str) {
            Some("none") => Ok(None),
            Some(s) => s.parse().map(Some).map_err(|_| "invalid expiry".into()),
            None => Err("expiry required".into()),
        }
    }
    fn identity(pid: i32) -> Option<(String, i32)> {
        let s = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields = s[s.rfind(')')? + 2..]
            .split_whitespace()
            .collect::<Vec<_>>();
        Some((fields.get(19)?.to_string(), fields.get(1)?.parse().ok()?))
    }
    fn namespace(pid: i32) -> Option<String> {
        fs::read_link(format!("/proc/{pid}/ns/pid"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
    fn absent(pid: i32, start: &str) -> bool {
        match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat
                .rfind(')')
                .and_then(|end| stat.get(end + 2..))
                .and_then(|fields| fields.split_whitespace().nth(19))
                .is_some_and(|generation| generation != start),
            Err(e) => e.kind() == io::ErrorKind::NotFound,
        }
    }
    fn same_generation(pid: i32, start: &str) -> bool {
        identity(pid).is_some_and(|v| v.0 == start)
    }
    fn original_adopted_target(target: &(i32, String), monitor: i32) -> bool {
        identity(target.0).is_some_and(|(start, parent)| start == target.1 && parent == monitor)
    }
    fn namespace_pids(pid: i32) -> Option<Vec<i32>> {
        let mut status = String::new();
        fs::File::open(format!("/proc/{pid}/status"))
            .ok()?
            .take(65537)
            .read_to_string(&mut status)
            .ok()?;
        if status.len() > 65536 {
            return None;
        }
        let values = status
            .lines()
            .find_map(|line| line.strip_prefix("NSpid:"))?
            .split_whitespace()
            .map(str::parse)
            .collect::<Result<Vec<i32>, _>>()
            .ok()?;
        if values.is_empty()
            || values.len() > 32
            || values.iter().any(|pid| *pid <= 0)
            || values.first() != Some(&pid)
        {
            None
        } else {
            Some(values)
        }
    }
    fn owned_descendant(mut pid: i32, root: i32, start: &str) -> bool {
        if !same_generation(root, start) {
            return false;
        }
        for _ in 0..64 {
            if pid == root {
                return true;
            }
            let Some((_, parent)) = identity(pid) else {
                return false;
            };
            if parent <= 0 || parent == pid {
                return false;
            }
            pid = parent;
        }
        false
    }
    fn bind_held_child(
        waiter: &(i32, String),
        local: i32,
        start: &str,
        expected_ns: &str,
    ) -> Result<(i32, String), String> {
        if local <= 0 || !same_generation(waiter.0, &waiter.1) {
            return Err("waiter generation unavailable at child binding".into());
        }
        let mut children = String::new();
        fs::File::open(format!("/proc/{}/task/{}/children", waiter.0, waiter.0))
            .map_err(|e| e.to_string())?
            .take(4097)
            .read_to_string(&mut children)
            .map_err(|e| e.to_string())?;
        let pids = children
            .split_whitespace()
            .map(str::parse::<i32>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "invalid waiter children roster")?;
        if children.len() > 4096 || pids.len() != 1 {
            return Err("held target children roster is missing/ambiguous".into());
        }
        let pid = pids[0];
        let observed = identity(pid).ok_or("held child identity unavailable")?;
        if observed.0 != start
            || observed.1 != waiter.0
            || namespace(pid).as_deref() != Some(expected_ns)
            || namespace_pids(pid).and_then(|v| v.last().copied()) != Some(local)
        {
            return Err("held target PID/generation/parent/namespace refused".into());
        }
        let image = fs::metadata(format!("/proc/{pid}/exe")).map_err(|e| e.to_string())?;
        let artifact = fs::metadata("/proc/self/fd/5").map_err(|e| e.to_string())?;
        if image.dev() != artifact.dev()
            || image.ino() != artifact.ino()
            || !same_generation(pid, start)
            || !same_generation(waiter.0, &waiter.1)
        {
            return Err("held target image/generation drift".into());
        }
        Ok((pid, observed.0))
    }
    struct NamespaceScan {
        entries: fs::ReadDir,
        namespace: String,
        depth: usize,
        members: Vec<i32>,
        seen: usize,
    }
    impl NamespaceScan {
        fn new(namespace: &str, depth: usize) -> Result<Self, String> {
            Ok(Self {
                entries: fs::read_dir("/proc").map_err(|e| e.to_string())?,
                namespace: namespace.into(),
                depth,
                members: Vec::new(),
                seen: 0,
            })
        }
        fn turn(&mut self) -> Result<Option<Vec<i32>>, String> {
            for _ in 0..64 {
                let Some(entry) = self.entries.next() else {
                    return Ok(Some(std::mem::take(&mut self.members)));
                };
                self.seen += 1;
                if self.seen > 65536 {
                    return Err("proc roster bound".into());
                }
                let entry = entry.map_err(|e| e.to_string())?;
                if let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse().ok()) {
                    match fs::read_link(format!("/proc/{pid}/ns/pid")) {
                        Ok(ns) if ns.to_str() == Some(self.namespace.as_str()) => {
                            self.members.push(pid)
                        }
                        Ok(_) => {}
                        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                        Err(e) => {
                            // UID exclusion is unnecessary. Only a stable
                            // shallower NSpid excludes
                            // an unreadable task outside the selected namespace.
                            let before = identity(pid);
                            if before.is_some()
                                && namespace_pids(pid).is_some_and(|pids| pids.len() < self.depth)
                                && identity(pid) == before
                            {
                                continue;
                            }
                            return Err(format!("unknown proc namespace membership: {e}"));
                        }
                    }
                }
            }
            Ok(None)
        }
    }
    fn artifact_hash(until: u64) -> Result<String, String> {
        let fd = unsafe { libc::dup(5) };
        if fd < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let file = unsafe { fs::File::from_raw_fd(fd) };
        let before = file.metadata().map_err(|e| e.to_string())?;
        if !before.is_file()
            || before.len() == 0
            || before.len() > 32 * 1024 * 1024
            || before.mode() & 0o111 == 0
        {
            return Err("invalid inherited ELF".into());
        }
        let mut b = vec![0; before.len() as usize];
        let mut read = 0;
        while read < b.len() {
            if control::monotonic_ns() >= until {
                return Err("native expiry during artifact read".into());
            }
            let end = (read + 64 * 1024).min(b.len());
            let n = file
                .read_at(&mut b[read..end], read as u64)
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("incomplete ELF read".into());
            }
            read += n;
        }
        let after = file.metadata().map_err(|e| e.to_string())?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
            || !b.starts_with(b"\x7fELF")
        {
            return Err("ELF drift".into());
        }
        control::sha256_before(&b, until)
    }
    fn poll(host: &Channel, listener: Option<&UnixListener>, peer: Option<&Channel>, until: u64) {
        let mut fds = Vec::new();
        if !host.eof {
            fds.push(libc::pollfd {
                fd: host.read_fd,
                events: libc::POLLIN,
                revents: 0,
            });
        }
        if host.pending() && !host.write_failed {
            fds.push(libc::pollfd {
                fd: host.write_fd,
                events: libc::POLLOUT,
                revents: 0,
            });
        }
        if let Some(l) = listener {
            fds.push(libc::pollfd {
                fd: l.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            });
        }
        if let Some(p) = peer {
            let events = (if !p.eof { libc::POLLIN } else { 0 })
                | if p.pending() && !p.write_failed {
                    libc::POLLOUT
                } else {
                    0
                };
            if events != 0 {
                fds.push(libc::pollfd {
                    fd: p.read_fd,
                    events,
                    revents: 0,
                });
            }
        }
        let wait = ((until.saturating_sub(control::monotonic_ns()) / 1_000_000) + 1).min(20) as i32;
        unsafe {
            libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, wait);
        }
    }
    fn direct(socket: &str, expiry: Option<u64>) -> io::Result<Command> {
        let mut c = Command::new("/proc/self/fd/5");
        c.args([
            "exec",
            "--entry-stub",
            socket,
            &expiry.map(|v| v.to_string()).unwrap_or("none".into()),
        ])
        .env_clear();
        unsafe {
            c.pre_exec(|| {
                if libc::syscall(
                    libc::SYS_close_range,
                    3u32,
                    u32::MAX,
                    libc::CLOSE_RANGE_CLOEXEC,
                ) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                libc::close(3);
                libc::close(4);
                if libc::fcntl(5, libc::F_SETFD, 0) < 0
                    || libc::setsid() < 0
                    || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(c)
    }

    pub fn run() -> ! {
        let start = control::monotonic_ns();
        if !cfg!(all(target_arch = "x86_64", target_env = "gnu")) {
            process::exit(125);
        }
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        }
        let args = std::env::args().skip(2).collect::<Vec<_>>();
        if args.first().map(String::as_str) == Some("--entry-stub") {
            if args.len() != 3 {
                process::exit(125);
            }
            super::super::entry_waiter::run(
                &args[1],
                expiry(args.get(2)).unwrap_or_else(|_| process::exit(125)),
                start,
            );
        }
        if args.len() != 2 || args[0] != "--expiry-ns" {
            process::exit(125);
        }
        let expires = expiry(args.get(1)).unwrap_or_else(|_| process::exit(125));
        if expires.is_some_and(|e| e <= start) {
            process::exit(125);
        }
        let setup_until = expires
            .unwrap_or(u64::MAX)
            .min(start.saturating_add(10_000_000_000));
        let mut host = Channel::new(3, 4).unwrap_or_else(|_| process::exit(125));
        unsafe {
            if libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) < 0 {
                process::exit(125);
            }
        }
        let mut initialized = false;
        let mut sha = String::new();
        let mut nonce = String::new();
        let mut digest = String::new();
        let mut json = String::new();
        let mut plan: Option<NativePlan> = None;
        let mut listener: Option<UnixListener> = None;
        let mut directory: Option<String> = None;
        let mut stream: Option<UnixStream> = None;
        let mut peer: Option<Channel> = None;
        let mut child: Option<i32> = None;
        let mut child_generation = String::new();
        let mut wait_status: Option<i32> = None;
        let mut waiter: Option<(i32, String)> = None;
        let mut waiter_ns: Option<String> = None;
        let mut target: Option<(i32, String)> = None;
        let mut target_local: Option<i32> = None;
        let mut target_wait: Option<i32> = None;
        let mut target_usage: Option<serde_json::Value> = None;
        let mut exec_closed = false;
        let mut exec_error = false;
        let mut init: Option<(i32, String)> = None;
        let mut ns: Option<String> = None;
        let mut ns_depth: Option<usize> = None;
        let mut scan: Option<NamespaceScan> = None;
        let mut scan_after_init_death = false;
        let mut namespace_absent: Option<bool> = None;
        let mut prepared = false;
        let mut committed = false;
        let mut intent = false;
        let mut entry = "not-entered";
        let mut cause: Option<String> = None;
        let mut stop: Option<u64> = None;
        let mut term = false;
        let mut kill = false;
        let mut signals = Vec::new();
        let mut termed = BTreeSet::new();
        let mut reaped = Vec::new();
        let mut all_reaped = false;
        let mut reap_count = 0usize;
        let mut cpu_us = 0u64;
        let mut rss = 0i64;
        let mut enforced = serde_json::json!([]);
        let scope_id = format!("native-scope-{}", process::id());
        let mut final_sent = false;
        let mut report_until = u64::MAX;
        loop {
            let now = control::monotonic_ns();
            if entry != "entered" && now >= setup_until {
                cause.get_or_insert("native setup deadline exhausted".into());
                stop.get_or_insert(setup_until);
            }
            if expires.is_some_and(|e| now >= e) {
                cause.get_or_insert("native original action deadline exhausted".into());
                stop.get_or_insert(expires.unwrap());
            }
            if !final_sent {
                match host.read_turn(if initialized && plan.is_none() {
                    control::PLAN_LIMIT
                } else {
                    control::FRAME_LIMIT
                }) {
                    Ok(frames) => {
                        for bytes in frames {
                            let result = (|| -> Result<(), String> {
                                match control::strict_json::<Input>(&bytes)? {
                                    Input::Initialize {
                                        protocol,
                                        workspace_protocol,
                                        artifact_sha256,
                                    } if !initialized && plan.is_none() => {
                                        if protocol!=control::PROTOCOL||workspace_protocol!=openbuff_workspace_harness::workspace_protocol_version().to_string()||!control::valid_digest(&artifact_sha256)||artifact_hash(setup_until)?!=artifact_sha256{return Err("initialize artifact/protocol mismatch".into());}
                                        sha = artifact_sha256;
                                        initialized = true;
                                        host.enqueue(&serde_json::json!({"type":"initialized","execProtocol":control::PROTOCOL,"workspaceProtocol":workspace_protocol,"crateVersion":env!("CARGO_PKG_VERSION"),"platform":"linux-x64-gnu","monotonicNs":control::monotonic_ns().to_string(),"filterDigest":control::sha256(&linux_sandbox::filter_bytes(true)),"filterDigests":{"deny":control::sha256(&linux_sandbox::filter_bytes(true)),"inherit":control::sha256(&linux_sandbox::filter_bytes(false))}}))?;
                                    }
                                    Input::Prepare {
                                        nonce: n,
                                        plan_digest: d,
                                        artifact_sha256,
                                        plan_json,
                                    } if initialized && plan.is_none() && stop.is_none() => {
                                        if n.is_empty()
                                            || n.len() > 128
                                            || !control::valid_digest(&d)
                                            || control::sha256(plan_json.as_bytes()) != d
                                            || artifact_sha256 != sha
                                        {
                                            return Err("prepare identity mismatch".into());
                                        }
                                        // Correlate refusals after envelope verification, without
                                        // granting plan admission or target-entry authority.
                                        nonce = n;
                                        digest = d;
                                        let p: NativePlan =
                                            control::strict_json(plan_json.as_bytes())?;
                                        p.validate(expires)?;
                                        if p.artifact.sha256 != sha
                                            || artifact_hash(setup_until)? != sha
                                        {
                                            return Err("prepare artifact drift".into());
                                        }
                                        let dir = std::env::temp_dir()
                                            .join(format!(".openbuff-native-{}", process::id()));
                                        fs::create_dir(&dir).map_err(|e| e.to_string())?;
                                        fs::set_permissions(
                                            &dir,
                                            fs::Permissions::from_mode(0o700),
                                        )
                                        .map_err(|e| e.to_string())?;
                                        let socket = dir.join("socket");
                                        let l = UnixListener::bind(&socket)
                                            .map_err(|e| e.to_string())?;
                                        l.set_nonblocking(true).map_err(|e| e.to_string())?;
                                        directory = Some(dir.to_string_lossy().into_owned());
                                        let launched = if p.mode == "full-access" {
                                            direct(socket.to_str().ok_or("socket path")?, expires)
                                                .map_err(|e| e.to_string())?
                                                .spawn()
                                                .map_err(|e| e.to_string())?
                                        } else {
                                            let mut sandbox = linux_sandbox::build(
                                                &p,
                                                dir.to_str().ok_or("setup path")?,
                                            )?;
                                            sandbox.command.spawn().map_err(|e| e.to_string())?
                                        };
                                        child = Some(launched.id() as i32);
                                        child_generation = identity(launched.id() as i32)
                                            .ok_or("sandbox child original identity unavailable")?
                                            .0;
                                        drop(launched);
                                        json = plan_json;
                                        plan = Some(p);
                                        listener = Some(l);
                                    }
                                    Input::Commit {
                                        nonce: n,
                                        plan_digest: d,
                                        artifact_sha256,
                                        expiry_ns,
                                    } if prepared && !committed && stop.is_none() => {
                                        if n != nonce
                                            || d != digest
                                            || artifact_sha256 != sha
                                            || expiry_ns
                                                .as_ref()
                                                .map(|s| s.parse::<u64>())
                                                .transpose()
                                                .map_err(|_| "invalid commit expiry")?
                                                != expires
                                            || expires.is_some_and(|e| control::monotonic_ns() >= e)
                                            || artifact_hash(setup_until)? != sha
                                        {
                                            return Err("commit identity/expiry drift".into());
                                        }
                                        peer.as_mut().ok_or("missing stub")?.enqueue(&serde_json::json!({"type":"commit","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"expiryNs":expires.map(|v|v.to_string())}))?;
                                        committed = true;
                                    }
                                    Input::Stop { reason } | Input::Abort { reason } => {
                                        cause.get_or_insert(reason);
                                        stop.get_or_insert(now);
                                    }
                                    _ => {
                                        return Err("control phase/repeated message refused".into())
                                    }
                                }
                                Ok(())
                            })();
                            if let Err(e) = result {
                                cause.get_or_insert(e);
                                stop.get_or_insert(control::monotonic_ns());
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        cause.get_or_insert(e);
                        stop.get_or_insert(now);
                    }
                }
                if host.eof {
                    cause.get_or_insert("host control EOF".into());
                    stop.get_or_insert(now);
                }
            }
            if stop.is_none() && peer.is_none() {
                if let Some(l) = &listener {
                    match l.accept() {
                        Ok((accepted, _)) => {
                            let result = (|| -> Result<(), String> {
                                let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
                                let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
                                if unsafe {
                                    libc::getsockopt(
                                        accepted.as_raw_fd(),
                                        libc::SOL_SOCKET,
                                        libc::SO_PEERCRED,
                                        (&mut cred as *mut libc::ucred).cast(),
                                        &mut len,
                                    )
                                } < 0
                                    || cred.uid != unsafe { libc::geteuid() }
                                    || !child.is_some_and(|pid| {
                                        owned_descendant(cred.pid, pid, &child_generation)
                                    })
                                {
                                    return Err("stub peer credentials refused".into());
                                }
                                let image = fs::metadata(format!("/proc/{}/exe", cred.pid))
                                    .map_err(|e| e.to_string())?;
                                let own =
                                    fs::metadata("/proc/self/fd/5").map_err(|e| e.to_string())?;
                                if image.dev() != own.dev() || image.ino() != own.ino() {
                                    return Err("stub artifact inode mismatch".into());
                                }
                                let (generation, parent) =
                                    identity(cred.pid).ok_or("stub identity unavailable")?;
                                let pidns =
                                    namespace(cred.pid).ok_or("stub namespace unavailable")?;
                                if plan.as_ref().unwrap().mode != "full-access" {
                                    if namespace(process::id() as i32).as_ref() == Some(&pidns)
                                        || namespace(parent).as_ref() != Some(&pidns)
                                    {
                                        return Err("stub namespace/init identity mismatch".into());
                                    }
                                    init = Some((
                                        parent,
                                        identity(parent).ok_or("init identity unavailable")?.0,
                                    ));
                                    let init_pids =
                                        namespace_pids(parent).ok_or("init NSpid unavailable")?;
                                    let monitor_pids = namespace_pids(process::id() as i32)
                                        .ok_or("monitor NSpid unavailable")?;
                                    if init_pids.last() != Some(&1)
                                        || init_pids.first() != Some(&parent)
                                        || init_pids.len() != monitor_pids.len() + 1
                                    {
                                        return Err("original namespace parent is not PID1".into());
                                    }
                                    ns_depth = Some(init_pids.len());
                                    ns = Some(pidns.clone());
                                }
                                waiter = Some((cred.pid, generation));
                                waiter_ns = Some(pidns);
                                let mut c =
                                    Channel::new(accepted.as_raw_fd(), accepted.as_raw_fd())
                                        .map_err(|e| e.to_string())?;
                                c.enqueue_prepare(&serde_json::json!({"type":"prepare","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"planJson":json}))?;
                                peer = Some(c);
                                stream = Some(accepted);
                                Ok(())
                            })();
                            listener = None;
                            if let Some(d) = &directory {
                                let _ = fs::remove_file(format!("{d}/socket"));
                            }
                            if let Err(e) = result {
                                cause.get_or_insert(e);
                                stop.get_or_insert(now);
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                        Err(e) => {
                            cause.get_or_insert(e.to_string());
                            stop.get_or_insert(now);
                        }
                    }
                }
            }
            if let Some(p) = peer.as_mut() {
                match p.read_turn(control::FRAME_LIMIT) {
                    Ok(frames) => {
                        for bytes in frames {
                            match control::strict_json::<control::PeerOutput>(&bytes).and_then(|v|serde_json::to_value(v).map_err(|e|e.to_string())) {
                                Ok(v)
                                    if v["nonce"] == nonce
                                        && v["planDigest"] == digest
                                        && v["artifactSha256"] == sha =>
                                {
                                    match v["type"].as_str() {
                                        Some("stub-prepared") if !prepared && !committed => {
                                            let selected = plan.as_ref().unwrap();
                                            if selected.mode != "full-access" && v["seccomp"] != 2 {
                                                cause.get_or_insert(
                                                    "seccomp application not observed".into(),
                                                );
                                                stop.get_or_insert(now);
                                                continue;
                                            }
                                            if selected.landlock == "required"
                                                && v["landlock"]["status"] != "fully-enforced"
                                            {
                                                cause.get_or_insert(
                                                    "required Landlock unavailable/partial".into(),
                                                );
                                                stop.get_or_insert(now);
                                                continue;
                                            }
                                            enforced=serde_json::Value::Array(["exact-env","cooperative-cancellation","filesystem-isolation","network-isolation","process-tree-containment","memory-limit","deadline-termination"].into_iter().map(|c|{let requested=selected.required.iter().chain(selected.optional.iter()).any(|v|v==c);let applied=match c{"exact-env"|"cooperative-cancellation"=>true,"filesystem-isolation"|"process-tree-containment"=>selected.mode!="full-access","network-isolation"=>selected.network=="deny","deadline-termination"=>selected.mode!="full-access"&&expires.is_some(),_=>false};serde_json::json!({"capability":c,"status":if applied{"enforced"}else if requested{"not-enforced"}else{"not-requested"},"evidenceId":scope_id})}).collect());
                                            prepared = true;
                                            if let Err(e)=host.enqueue(&serde_json::json!({"type":"prepared","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"scopeId":scope_id,"waiterPid":waiter.as_ref().map(|v|v.0),"waiterStartTime":waiter.as_ref().map(|v|&v.1),"pidNamespace":ns,"namespaceDepth":ns_depth,"enforced":enforced,"landlock":v["landlock"],"seccomp":v["seccomp"]})){cause.get_or_insert(e);stop.get_or_insert(now);}
                                        }
                                        Some("child-created")
                                            if prepared
                                                && committed
                                                && target.is_none()
                                                && v["waiterStartTime"].as_str()==waiter.as_ref().map(|v|v.1.as_str())
                                                && stop.is_none() =>
                                        {
                                            let bound = (|| -> Result<(), String> {
                                                let local = v["targetLocalPid"]
                                                    .as_i64()
                                                    .filter(|p| *p > 0 && *p <= i32::MAX as i64)
                                                    .ok_or("invalid local child PID")?
                                                    as i32;
                                                let start = v["targetStartTime"]
                                                    .as_str()
                                                    .ok_or("missing target generation")?;
                                                let child = bind_held_child(
                                                    waiter
                                                        .as_ref()
                                                        .ok_or("missing original waiter")?,
                                                    local,
                                                    start,
                                                    waiter_ns
                                                        .as_deref()
                                                        .ok_or("missing waiter namespace")?,
                                                )?;
                                                if expires
                                                    .is_some_and(|e| control::monotonic_ns() >= e)
                                                    || control::monotonic_ns() >= setup_until
                                                {
                                                    return Err(
                                                        "original expiry at child identity binding"
                                                            .into(),
                                                    );
                                                }
                                                target = Some(child);
                                                target_local = Some(local);
                                                host.enqueue(&serde_json::json!({"type":"target-created","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"scopeId":scope_id,"waiterPid":waiter.as_ref().map(|v|v.0),"waiterStartTime":waiter.as_ref().map(|v|&v.1),"targetPid":target.as_ref().map(|v|v.0),"targetLocalPid":local,"targetStartTime":start,"pidNamespace":ns,"namespaceDepth":ns_depth}))?;
                                                p.enqueue(&serde_json::json!({"type":"child-identity-accepted","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"targetPid":target.as_ref().map(|v|v.0),"targetLocalPid":local,"targetStartTime":start,"expiryNs":expires.map(|v|v.to_string())}))?;
                                                Ok(())
                                            })(
                                            );
                                            if let Err(e) = bound {
                                                cause.get_or_insert(e);
                                                stop.get_or_insert(now);
                                            }
                                        }
                                        Some("exec-intent")
                                            if prepared
                                                && committed
                                                && target.is_some()
                                                && !intent
                                                && v["targetLocalPid"].as_i64()
                                                    == target_local.map(i64::from)
                                                && v["targetStartTime"].as_str()
                                                    == target.as_ref().map(|v| v.1.as_str()) =>
                                        {
                                            intent = true;
                                            entry = "unknown";
                                        }
                                        Some("exec-closed")
                                            if target.is_some()
                                                && !exec_closed
                                                && v["targetLocalPid"].as_i64()
                                                    == target_local.map(i64::from)
                                                && v["targetStartTime"].as_str()
                                                    == target.as_ref().map(|v| v.1.as_str()) =>
                                        {
                                            exec_closed = true;
                                            if v["noError"] != true || v["released"] != true {
                                                exec_error = true;
                                                entry = "not-entered";
                                            }
                                        }
                                        Some("target-wait")
                                            if target.is_some()
                                                && target_wait.is_none()
                                                && v["targetLocalPid"].as_i64()
                                                    == target_local.map(i64::from)
                                                && v["targetStartTime"].as_str()
                                                    == target.as_ref().map(|v| v.1.as_str()) =>
                                        {
                                            if let Some(status) = v["waitStatus"]
                                                .as_i64()
                                                .filter(|s| *s >= 0 && *s <= 65535)
                                                .map(|s| s as i32)
                                                .filter(|s| {
                                                    libc::WIFEXITED(*s) || libc::WIFSIGNALED(*s)
                                                })
                                                .filter(|s| v["exitCode"].as_i64()==if libc::WIFEXITED(*s){Some(libc::WEXITSTATUS(*s)as i64)}else{None}
                                                    && v["signal"].as_i64()==if libc::WIFSIGNALED(*s){Some(libc::WTERMSIG(*s)as i64)}else{None}
                                                    && v["waitKind"].as_str()==Some(if libc::WIFEXITED(*s){"exited"}else{"signalled"})
                                                    && v["usage"]["scope"]=="actual-target-wait4; maxrss is target peak")
                                            {
                                                target_wait = Some(status);
                                                target_usage = Some(v["usage"].clone());
                                                stop.get_or_insert(control::monotonic_ns());
                                            } else {
                                                cause.get_or_insert(
                                                    "invalid genuine target wait status".into(),
                                                );
                                                stop.get_or_insert(now);
                                            }
                                        }
                                        Some("exec-error")
                                            if target.is_some()
                                                && !exec_error
                                                && v["targetLocalPid"].as_i64()
                                                    == target_local.map(i64::from)
                                                && v["targetStartTime"].as_str()
                                                    == target.as_ref().map(|v| v.1.as_str()) =>
                                        {
                                            exec_error = true;
                                            cause.get_or_insert(
                                                v["cause"]
                                                    .as_str()
                                                    .unwrap_or("stub exec failure")
                                                    .into(),
                                            );
                                            stop.get_or_insert(now);
                                            entry = "not-entered";
                                        }
                                        _ => {
                                            cause.get_or_insert("stub phase refused".into());
                                            stop.get_or_insert(now);
                                        }
                                    }
                                }
                                _ => {
                                    cause.get_or_insert("stub schema/identity mismatch".into());
                                    stop.get_or_insert(now);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        cause.get_or_insert(e);
                        stop.get_or_insert(now);
                        if committed {
                            entry = "unknown";
                        }
                    }
                }
                if let Err(e) = p.write_turn() {
                    cause.get_or_insert(e);
                    stop.get_or_insert(now);
                }
            }
            for _ in 0..16 {
                let mut status = 0;
                let mut u: libc::rusage = unsafe { std::mem::zeroed() };
                // An unreaped original child cannot be replaced while this
                // single-threaded monitor owns its wait. Witness the tuple
                // immediately before each wait; PID equality after reap alone
                // cannot distinguish a reused PID from the original target.
                let adopted_target = target
                    .as_ref()
                    .filter(|target| original_adopted_target(target, process::id() as i32))
                    .map(|target| target.0);
                let pid = unsafe { libc::wait4(-1, &mut status, libc::WNOHANG, &mut u) };
                if pid <= 0 {
                    all_reaped =
                        pid < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD);
                    break;
                }
                all_reaped = false;
                reap_count += 1;
                if reaped.len() < 128 {
                    reaped.push(pid);
                }
                cpu_us += ((u.ru_utime.tv_sec + u.ru_stime.tv_sec) as u64) * 1_000_000
                    + (u.ru_utime.tv_usec + u.ru_stime.tv_usec) as u64;
                rss = rss.max(u.ru_maxrss);
                if wait_status.is_none() && Some(pid) == child {
                    wait_status = Some(status);
                    // Descendants must consume the original normal-exit cleanup
                    // window, rather than waiting for an unrelated later expiry.
                    stop.get_or_insert(control::monotonic_ns());
                }
                if target_wait.is_none() && adopted_target == Some(pid) {
                    target_wait = Some(status);
                    target_usage = Some(
                        serde_json::json!({"cpuMicros":((u.ru_utime.tv_sec+u.ru_stime.tv_sec)as u64)*1_000_000+(u.ru_utime.tv_usec+u.ru_stime.tv_usec)as u64,"maxRssKiB":u.ru_maxrss,"scope":"actual-target-wait4; maxrss is target peak"}),
                    );
                    stop.get_or_insert(control::monotonic_ns());
                }
            }
            if intent && exec_closed && !exec_error && entry == "unknown" {
                let changed = target
                    .as_ref()
                    .filter(|(pid, start)| same_generation(*pid, start))
                    .and_then(|(pid, _)| fs::metadata(format!("/proc/{pid}/exe")).ok())
                    .zip(fs::metadata("/proc/self/fd/5").ok())
                    .is_some_and(|(a, b)| {
                        (a.dev() != b.dev() || a.ino() != b.ino())
                            && target
                                .as_ref()
                                .is_some_and(|(pid, start)| same_generation(*pid, start))
                    });
                if changed || target_wait.is_some_and(|s| libc::WIFEXITED(s)) {
                    entry = "entered";
                    if let Err(e)=host.enqueue(&serde_json::json!({"type":"target-entered","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"scopeId":scope_id,"pid":target.as_ref().map(|v|v.0),"targetPid":target.as_ref().map(|v|v.0),"targetLocalPid":target_local,"targetStartTime":target.as_ref().map(|v|&v.1),"waiterPid":waiter.as_ref().map(|v|v.0),"waiterStartTime":waiter.as_ref().map(|v|&v.1),"pidNamespace":ns,"namespaceDepth":ns_depth,"observation":if changed{"exec-image"}else{"normal-wait-after-intent-eof"}})){cause.get_or_insert(e);stop.get_or_insert(now);}
                }
            }
            if let Some(anchor) = stop {
                if !term {
                    term = true;
                    let roster = target
                        .as_ref()
                        .or(waiter.as_ref())
                        .map(|v| v.0)
                        .into_iter()
                        .collect::<Vec<_>>();
                    for pid in roster {
                        if !target.as_ref().or(waiter.as_ref()).is_some_and(
                            |(target_pid, start)| *target_pid == pid && same_generation(pid, start),
                        ) {
                            continue;
                        }
                        if init.as_ref().is_some_and(|v| v.0 == pid) {
                            continue;
                        }
                        let r = unsafe { libc::kill(pid, libc::SIGTERM) };
                        if r == 0 {
                            termed.insert((
                                pid,
                                target.as_ref().or(waiter.as_ref()).unwrap().1.clone(),
                            ));
                        }
                        if signals.len() < 128 {
                            signals.push(serde_json::json!({"signal":"SIGTERM","pid":pid,"atNs":control::monotonic_ns().to_string(),"result":if r==0{"delivered"}else{"unknown"}}));
                        }
                    }
                    if target.is_none() && waiter.is_none() {
                        if let Some(pid) = child {
                            if wait_status.is_none() && same_generation(pid, &child_generation) {
                                unsafe {
                                    libc::kill(pid, libc::SIGTERM);
                                }
                            }
                        }
                    }
                }
                if now >= anchor.saturating_add(200_000_000) && !kill {
                    kill = true;
                    if let Some((pid, s)) = &init {
                        if same_generation(*pid, s) {
                            let r = unsafe { libc::kill(*pid, libc::SIGKILL) };
                            if signals.len() < 128 {
                                signals.push(serde_json::json!({"signal":"SIGKILL","pid":pid,"atNs":control::monotonic_ns().to_string(),"result":if r==0{"delivered"}else{"unknown"}}));
                            }
                        }
                    }
                    if let Some((pid, s)) = &target {
                        if same_generation(*pid, s) {
                            unsafe {
                                libc::kill(*pid, libc::SIGKILL);
                            }
                        }
                    }
                    if let Some(pid) = child {
                        if wait_status.is_none() && same_generation(pid, &child_generation) {
                            unsafe {
                                libc::kill(pid, libc::SIGKILL);
                            }
                        }
                    }
                }
            }
            let terminal = target_wait.is_some()
                || wait_status.is_some()
                || (child.is_none() && stop.is_some());
            let init_absent = init.as_ref().map(|(pid, s)| absent(*pid, s));
            // Start the final roster only after the original init is absent and
            // direct bwrap wait is joined. Each turn checks at most 64 entries.
            if terminal && init_absent == Some(true) && !scan_after_init_death {
                scan_after_init_death = true;
                scan = None;
                namespace_absent = None;
            }
            if let Some(namespace) = ns.as_deref() {
                if (stop.is_some() || terminal) && namespace_absent.is_none() {
                    if scan.is_none() {
                        match NamespaceScan::new(namespace, ns_depth.unwrap_or(0)) {
                            Ok(s) => scan = Some(s),
                            Err(e) => {
                                cause.get_or_insert(e);
                                stop.get_or_insert(now);
                                namespace_absent = Some(false);
                            }
                        }
                    }
                    if let Some(s) = scan.as_mut() {
                        match s.turn() {
                            Ok(Some(roster)) => {
                                if scan_after_init_death {
                                    namespace_absent = Some(roster.is_empty());
                                }
                                if !kill {
                                    for pid in &roster {
                                        if self::namespace(*pid).as_deref() != Some(namespace) {
                                            continue;
                                        }
                                        if init.as_ref().is_some_and(|v| v.0 == *pid) {
                                            continue;
                                        }
                                        let Some((generation, _)) = identity(*pid) else {
                                            continue;
                                        };
                                        if termed.contains(&(*pid, generation.clone())) {
                                            continue;
                                        }
                                        let result = unsafe { libc::kill(*pid, libc::SIGTERM) };
                                        if result == 0 && termed.len() < 65536 {
                                            termed.insert((*pid, generation));
                                        }
                                        if signals.len() < 128 {
                                            signals.push(serde_json::json!({"signal":"SIGTERM","pid":pid,"atNs":control::monotonic_ns().to_string(),"result":if result==0{"delivered"}else{"unknown"}}));
                                        }
                                    }
                                }
                                scan = None;
                            }
                            Ok(None) => {}
                            Err(e) => {
                                cause.get_or_insert(e);
                                stop.get_or_insert(now);
                                namespace_absent = Some(false);
                                scan = None;
                            }
                        }
                    }
                }
            }
            let ns_absent = namespace_absent;
            if terminal && !final_sent {
                let complete = child.is_none()
                    || (wait_status.is_some()
                        && all_reaped
                        && if plan.as_ref().is_some_and(|p| p.mode != "full-access") {
                            ns_absent == Some(true) && init_absent == Some(true)
                        } else {
                            target
                                .as_ref()
                                .or(waiter.as_ref())
                                .is_some_and(|(pid, s)| absent(*pid, s))
                        });
                if complete || stop.is_some_and(|s| now >= s.saturating_add(1_400_000_000)) {
                    let wrapper_code = wait_status
                        .filter(|s| libc::WIFEXITED(*s))
                        .map(|s| libc::WEXITSTATUS(s));
                    let wrapper_signal = wait_status
                        .filter(|s| libc::WIFSIGNALED(*s))
                        .map(|s| libc::WTERMSIG(s));
                    let genuine = target_wait.filter(|_| entry == "entered");
                    let wait_source = if genuine.is_some() {
                        "native-target-wait"
                    } else {
                        "not-observed"
                    };
                    let code = genuine
                        .filter(|s| libc::WIFEXITED(*s))
                        .map(|s| libc::WEXITSTATUS(s));
                    let signal = genuine
                        .filter(|s| libc::WIFSIGNALED(*s))
                        .map(|s| libc::WTERMSIG(s));
                    if genuine.is_none() {
                        cause.get_or_insert(
                            if entry == "entered" {
                                "Genuine native target wait status unavailable"
                            } else if entry == "unknown" {
                                "Native target entry and wait status unavailable"
                            } else {
                                "Native target was not entered"
                            }
                            .into(),
                        );
                    }
                    let final_report = serde_json::json!({"type":"final","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"scopeId":scope_id,"waiterPid":waiter.as_ref().map(|v|v.0),"waiterStartTime":waiter.as_ref().map(|v|&v.1),"targetEntry":entry,"targetPid":target.as_ref().map(|v|v.0),"targetLocalPid":target_local,"targetStartTime":target.as_ref().map(|v|&v.1),"pidNamespace":ns,"namespaceDepth":ns_depth,"exitCode":code,"signal":signal,"waitStatusSource":wait_source,"wrapperExitCode":wrapper_code,"wrapperSignal":wrapper_signal,"targetUsage":if genuine.is_some(){target_usage.as_ref()}else{None},"cause":cause,"enforced":enforced,"usage":{"cpuMicros":cpu_us,"maxRssKiB":rss,"scope":"direct-and-adopted-wait4; maxrss is not aggregate tree memory"},"cleanup":{"complete":complete,"scopeTier":if ns.is_some(){"linux-pid-namespace"}else{"direct-child"},"pidNamespace":ns,"namespaceAbsent":ns_absent,"initAbsent":init_absent,"outerChildReaped":child.is_none()||wait_status.is_some(),"reapedPids":reaped,"allChildrenReaped":all_reaped,"reapCount":reap_count,"observationsTruncated":reap_count>reaped.len()||signals.len()>=128,"stopAtNs":stop.map(|s|s.to_string()),"observedAtNs":now.to_string(),"originalExpiryNs":expires.map(|s|s.to_string()),"signals":signals}});
                    if host.enqueue(&final_report).is_err() {
                        process::exit(125);
                    }
                    final_sent = true;
                    report_until = now.saturating_add(200_000_000).min(
                        stop.map(|s| s.saturating_add(1_400_000_000))
                            .unwrap_or(u64::MAX),
                    );
                }
            }
            if let Err(e) = host.write_turn() {
                cause.get_or_insert(e);
                stop.get_or_insert(now);
            }
            if final_sent && (!host.pending() || now >= report_until) {
                if let Some(d) = directory {
                    let _ = fs::remove_file(format!("{d}/socket"));
                    let _ = fs::remove_dir(d);
                }
                drop(stream);
                process::exit(if host.pending() { 125 } else { 0 });
            }
            if stop.is_some_and(|s| now >= s.saturating_add(1_400_000_000)) && !final_sent {
                process::exit(125);
            }
            let until = stop
                .map(|s| s.saturating_add(if kill { 1_400_000_000 } else { 200_000_000 }))
                .unwrap_or(if committed {
                    expires.unwrap_or(u64::MAX)
                } else {
                    setup_until
                })
                .min(report_until);
            poll(
                &host,
                if stop.is_none() {
                    listener.as_ref()
                } else {
                    None
                },
                peer.as_ref(),
                until,
            );
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn adopted_wait_requires_original_generation_and_monitor_parent_before_reap() {
            let mut child = Command::new("/usr/bin/sleep").arg("10").spawn().unwrap();
            let pid = child.id() as i32;
            let start = identity(pid).unwrap().0;
            let monitor = process::id() as i32;
            assert!(original_adopted_target(&(pid, start.clone()), monitor));
            assert!(!original_adopted_target(&(pid, "0".into()), monitor));
            assert!(!original_adopted_target(&(pid, start.clone()), monitor + 1));
            child.kill().unwrap();
            child.wait().unwrap();
            assert!(!original_adopted_target(&(pid, start), monitor));
        }
        #[test]
        fn closed_stub_read_half_does_not_busy_poll() {
            let (_host_peer, host_socket) = UnixStream::pair().unwrap();
            let (stub_peer, stub_socket) = UnixStream::pair().unwrap();
            let host = Channel::new(host_socket.as_raw_fd(), host_socket.as_raw_fd()).unwrap();
            let mut stub = Channel::new(stub_socket.as_raw_fd(), stub_socket.as_raw_fd()).unwrap();
            stub_peer.shutdown(std::net::Shutdown::Write).unwrap();
            drop(stub_peer);
            assert!(stub.read_turn(control::FRAME_LIMIT).unwrap().is_empty());
            assert!(stub.eof);
            let start = control::monotonic_ns();
            poll(&host, None, Some(&stub), start + 20_000_000);
            assert!(control::monotonic_ns() - start >= 10_000_000);
        }
    }
}

#[cfg(target_os = "linux")]
pub fn run_native() -> ! {
    native::run()
}
