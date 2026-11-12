//! Trusted single-target waiter. Fork is held until the outside monitor binds
//! its host PID; genuine wait4 status never comes from the bubblewrap wrapper.
use super::{
    control::{self, Channel, Input, NativePlan},
    landlock_fs, linux_sandbox,
};
use std::{
    ffi::CString,
    fs, io,
    os::{fd::AsRawFd, unix::net::UnixStream},
    process,
    sync::atomic::{AtomicBool, Ordering},
};

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop_signal(_: i32) {
    STOP.store(true, Ordering::Relaxed);
}

fn generation(pid: i32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    Some(
        stat.get(stat.rfind(')')? + 2..)?
            .split_whitespace()
            .nth(19)?
            .to_owned(),
    )
}
fn raw_now() -> u64 {
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return u64::MAX;
    }
    (time.tv_sec as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(time.tv_nsec as u64)
}
unsafe fn child_error(fd: i32, errno: i32, until: u64) -> ! {
    let bytes = errno.to_le_bytes();
    loop {
        let count = libc::write(fd, bytes.as_ptr().cast(), bytes.len());
        if count == 4 {
            libc::_exit(125);
        }
        if count < 0 && *libc::__errno_location() == libc::EINTR && raw_now() < until {
            continue;
        }
        libc::kill(libc::getpid(), libc::SIGKILL);
        libc::_exit(125);
    }
}
unsafe fn target_child(
    control: i32,
    errors: i32,
    parent: i32,
    until: u64,
    executable: &CString,
    cwd: &CString,
    argv: &[*const libc::c_char],
    env: &[*const libc::c_char],
) -> ! {
    // No std spawn pipe exists here. Preserve only the two held-child pipes.
    let lo = control.min(errors) as u32;
    let hi = control.max(errors) as u32;
    for (first, last) in [
        (3, lo.saturating_sub(1)),
        (lo + 1, hi.saturating_sub(1)),
        (hi + 1, u32::MAX),
    ] {
        if first <= last && libc::syscall(libc::SYS_close_range, first, last, 0) < 0 {
            child_error(errors, *libc::__errno_location(), until);
        }
    }
    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 || libc::getppid() != parent {
        child_error(errors, libc::ECANCELED, until);
    }
    let mut action: libc::sigaction = std::mem::zeroed();
    action.sa_sigaction = libc::SIG_DFL;
    libc::sigemptyset(&mut action.sa_mask);
    for signal in [libc::SIGPIPE, libc::SIGTERM, libc::SIGINT] {
        if libc::sigaction(signal, &action, std::ptr::null_mut()) < 0 {
            child_error(errors, *libc::__errno_location(), until);
        }
    }
    let mut empty: libc::sigset_t = std::mem::zeroed();
    libc::sigemptyset(&mut empty);
    if libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut()) < 0 {
        child_error(errors, *libc::__errno_location(), until);
    }
    loop {
        let now = raw_now();
        if now >= until {
            child_error(errors, libc::ETIMEDOUT, until);
        }
        let mut byte = 0u8;
        let count = libc::read(control, (&mut byte as *mut u8).cast(), 1);
        if count == 1 {
            if byte != b'C' {
                child_error(errors, libc::ECANCELED, until);
            }
            if raw_now() >= until {
                child_error(errors, libc::ETIMEDOUT, until);
            }
            break;
        }
        if count == 0 {
            child_error(errors, libc::ECANCELED, until);
        }
        if count < 0 && ![libc::EAGAIN, libc::EINTR].contains(&*libc::__errno_location()) {
            child_error(errors, *libc::__errno_location(), until);
        }
        let mut fd = libc::pollfd {
            fd: control,
            events: libc::POLLIN,
            revents: 0,
        };
        libc::poll(
            &mut fd,
            1,
            ((until.saturating_sub(raw_now()) / 1_000_000) + 1).min(20) as i32,
        );
    }
    libc::close(control);
    if libc::chdir(cwd.as_ptr()) < 0 {
        child_error(errors, *libc::__errno_location(), until);
    }
    if raw_now() >= until {
        child_error(errors, libc::ETIMEDOUT, until);
    }
    libc::execve(executable.as_ptr(), argv.as_ptr(), env.as_ptr());
    child_error(errors, *libc::__errno_location(), until);
}

struct Child {
    pid: i32,
    start: String,
    release_fd: i32,
    error_fd: i32,
    accepted: bool,
    released: bool,
    errors: Vec<u8>,
    error_eof: bool,
    error_reported: bool,
    closure_reported: bool,
    status: Option<i32>,
    wait_reported: bool,
    usage: libc::rusage,
}
impl Drop for Child {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.release_fd);
            libc::close(self.error_fd);
        }
    }
}
fn fork_target(plan: &NativePlan, until: u64) -> Result<Child, String> {
    let executable = CString::new(plan.executable.as_str()).map_err(|e| e.to_string())?;
    let cwd = CString::new(plan.cwd.as_str()).map_err(|e| e.to_string())?;
    let args = std::iter::once(&plan.executable)
        .chain(plan.argv.iter())
        .map(|v| CString::new(v.as_str()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let environment = plan
        .env
        .iter()
        .map(|(k, v)| CString::new(format!("{k}={v}")))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let argv = args
        .iter()
        .map(|v| v.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect::<Vec<_>>();
    let env = environment
        .iter()
        .map(|v| v.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect::<Vec<_>>();
    let mut release = [-1; 2];
    let mut errors = [-1; 2];
    unsafe {
        if libc::pipe2(release.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        if libc::pipe2(errors.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) < 0 {
            libc::close(release[0]);
            libc::close(release[1]);
            return Err(io::Error::last_os_error().to_string());
        }
        let parent = libc::getpid();
        let pid = libc::fork();
        if pid == 0 {
            target_child(
                release[0],
                errors[1],
                parent,
                until,
                &executable,
                &cwd,
                &argv,
                &env,
            );
        }
        libc::close(release[0]);
        libc::close(errors[1]);
        if pid < 0 {
            libc::close(release[1]);
            libc::close(errors[0]);
            return Err(io::Error::last_os_error().to_string());
        }
        let start = match generation(pid) {
            Some(start) => start,
            None => {
                // The just-forked child is still our unreaped direct child.
                // Close its release pipe and terminate it rather than losing
                // the only waiter-owned tuple on this pre-entry refusal.
                libc::close(release[1]);
                libc::close(errors[0]);
                libc::kill(pid, libc::SIGKILL);
                return Err("held target generation unavailable".into());
            }
        };
        Ok(Child {
            pid,
            start,
            release_fd: release[1],
            error_fd: errors[0],
            accepted: false,
            released: false,
            errors: Vec::new(),
            error_eof: false,
            error_reported: false,
            closure_reported: false,
            status: None,
            wait_reported: false,
            usage: std::mem::zeroed(),
        })
    }
}

pub fn run(socket: &str, expires: Option<u64>, start: u64) -> ! {
    let stream = UnixStream::connect(socket).unwrap_or_else(|_| process::exit(125));
    let mut channel =
        Channel::new(stream.as_raw_fd(), stream.as_raw_fd()).unwrap_or_else(|_| process::exit(125));
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = stop_signal as usize;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
    let setup_until = expires
        .unwrap_or(u64::MAX)
        .min(start.saturating_add(10_000_000_000));
    let waiter_start = generation(process::id() as i32).unwrap_or_else(|| process::exit(125));
    let mut plan: Option<NativePlan> = None;
    let mut nonce = String::new();
    let mut digest = String::new();
    let mut sha = String::new();
    let mut child: Option<Child> = None;
    let mut stop: Option<u64> = None;
    let mut term = false;
    let mut killed = false;
    loop {
        let now = control::monotonic_ns();
        if expires.is_some_and(|e| now >= e) {
            stop.get_or_insert(expires.unwrap());
        }
        if child.as_ref().is_none_or(|c| !c.released) && now >= setup_until {
            stop.get_or_insert(setup_until);
        }
        if STOP.load(Ordering::Relaxed) {
            stop.get_or_insert(now);
        }
        let frames = channel.read_turn(if plan.is_none() {
            control::PLAN_LIMIT
        } else {
            control::FRAME_LIMIT
        });
        let phase = (|| -> Result<(), String> {
            for bytes in frames? {
                match control::strict_json::<Input>(&bytes)? {
                    Input::Prepare {
                        nonce: n,
                        plan_digest: d,
                        artifact_sha256,
                        plan_json,
                    } if plan.is_none() && stop.is_none() => {
                        if control::sha256(plan_json.as_bytes()) != d {
                            return Err("waiter plan digest mismatch".into());
                        }
                        let p: NativePlan = control::strict_json(plan_json.as_bytes())?;
                        p.validate(expires)?;
                        if p.artifact.sha256 != artifact_sha256 {
                            return Err("waiter artifact mismatch".into());
                        }
                        nonce = n;
                        digest = d;
                        sha = artifact_sha256;
                        if p.mode != "full-access" && p.network == "deny" {
                            linux_sandbox::apply_network_filter().map_err(|e| e.to_string())?;
                        }
                        let landlock = if p.landlock == "disabled" {
                            serde_json::json!({"abi":0,"status":"not-requested"})
                        } else {
                            match landlock_fs::apply_native_ruleset(&p) {
                                Ok(v) => serde_json::to_value(v).map_err(|e| e.to_string())?,
                                Err(e) => {
                                    serde_json::json!({"abi":1,"status":"error","cause":e.to_string()})
                                }
                            }
                        };
                        channel.enqueue(&serde_json::json!({"type":"stub-prepared","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"seccomp":unsafe{libc::prctl(libc::PR_GET_SECCOMP)},"landlock":landlock}))?;
                        plan = Some(p);
                    }
                    Input::Commit {
                        nonce: n,
                        plan_digest: d,
                        artifact_sha256,
                        expiry_ns,
                    } if plan.is_some() && child.is_none() && stop.is_none() => {
                        if n != nonce
                            || d != digest
                            || artifact_sha256 != sha
                            || expiry_ns
                                .as_ref()
                                .map(|v| v.parse::<u64>())
                                .transpose()
                                .map_err(|_| "waiter commit expiry")?
                                != expires
                            || expires.is_some_and(|e| control::monotonic_ns() >= e)
                        {
                            return Err("waiter commit identity/expiry".into());
                        }
                        let c = fork_target(
                            plan.as_ref().unwrap(),
                            expires.unwrap_or(u64::MAX).min(setup_until),
                        )?;
                        channel.enqueue(&serde_json::json!({"type":"child-created","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"waiterStartTime":waiter_start,"targetLocalPid":c.pid,"targetStartTime":c.start}))?;
                        child = Some(c);
                    }
                    Input::ChildIdentityAccepted {
                        nonce: n,
                        plan_digest: d,
                        artifact_sha256,
                        target_pid,
                        target_local_pid,
                        target_start_time,
                        expiry_ns,
                    } if stop.is_none() => {
                        let c = child.as_mut().ok_or("ack without held child")?;
                        if c.accepted
                            || target_pid <= 0
                            || c.pid != target_local_pid
                            || c.start != target_start_time
                            || n != nonce
                            || d != digest
                            || artifact_sha256 != sha
                            || expiry_ns
                                .as_ref()
                                .map(|v| v.parse::<u64>())
                                .transpose()
                                .map_err(|_| "waiter ack expiry")?
                                != expires
                            || expires.is_some_and(|e| control::monotonic_ns() >= e)
                        {
                            return Err("held target acknowledgement refused".into());
                        }
                        c.accepted = true;
                        channel.enqueue(&serde_json::json!({"type":"exec-intent","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"targetLocalPid":c.pid,"targetStartTime":c.start}))?;
                    }
                    Input::Stop { .. } | Input::Abort { .. } => {
                        stop.get_or_insert(now);
                    }
                    _ => return Err("waiter repeated/out-of-order control".into()),
                }
            }
            Ok(())
        })();
        if phase.is_err() || channel.eof {
            stop.get_or_insert(now);
        }
        if channel.write_turn().is_err() {
            stop.get_or_insert(now);
        }
        if let Some(c) = child.as_mut() {
            if c.accepted && !c.released && stop.is_none() && !channel.pending() {
                if expires.is_some_and(|e| control::monotonic_ns() >= e) {
                    stop.get_or_insert(expires.unwrap());
                } else {
                    let byte = b'C';
                    let n = unsafe { libc::write(c.release_fd, (&byte as *const u8).cast(), 1) };
                    if n == 1 {
                        c.released = true;
                    } else if n < 0
                        && ![libc::EAGAIN, libc::EINTR]
                            .contains(&io::Error::last_os_error().raw_os_error().unwrap_or(0))
                    {
                        stop.get_or_insert(now);
                    }
                }
            }
            if !c.error_eof {
                let mut bytes = [0u8; 8];
                let n = unsafe { libc::read(c.error_fd, bytes.as_mut_ptr().cast(), bytes.len()) };
                if n > 0 {
                    c.errors.extend_from_slice(&bytes[..n as usize]);
                    if c.errors.len() > 4 {
                        stop.get_or_insert(now);
                    }
                } else if n == 0 {
                    c.error_eof = true;
                } else if ![libc::EAGAIN, libc::EINTR]
                    .contains(&io::Error::last_os_error().raw_os_error().unwrap_or(0))
                {
                    stop.get_or_insert(now);
                }
            }
            if c.errors.len() == 4 && !c.error_reported {
                c.error_reported = true;
                let errno = i32::from_le_bytes(c.errors[..4].try_into().unwrap());
                if channel.enqueue(&serde_json::json!({"type":"exec-error","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"targetLocalPid":c.pid,"targetStartTime":c.start,"errno":errno,"cause":io::Error::from_raw_os_error(errno).to_string()})).is_err(){stop.get_or_insert(now);}
            }
            if c.error_eof && !c.closure_reported {
                c.closure_reported = true;
                if !c.errors.is_empty() && c.errors.len() != 4 {
                    stop.get_or_insert(now);
                }
                if channel.enqueue(&serde_json::json!({"type":"exec-closed","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"targetLocalPid":c.pid,"targetStartTime":c.start,"noError":c.errors.is_empty(),"released":c.released})).is_err(){stop.get_or_insert(now);}
            }
            if c.status.is_none() {
                let mut status = 0;
                let pid = unsafe { libc::wait4(c.pid, &mut status, libc::WNOHANG, &mut c.usage) };
                if pid == c.pid {
                    c.status = Some(status);
                } else if pid < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR)
                {
                    stop.get_or_insert(now);
                }
            }
            if let Some(status) = c.status.filter(|_| c.error_eof) {
                if !c.wait_reported {
                    c.wait_reported = true;
                    let cpu = ((c.usage.ru_utime.tv_sec + c.usage.ru_stime.tv_sec) as u64)
                        * 1_000_000
                        + (c.usage.ru_utime.tv_usec + c.usage.ru_stime.tv_usec) as u64;
                    if channel.enqueue(&serde_json::json!({"type":"target-wait","nonce":nonce,"planDigest":digest,"artifactSha256":sha,"targetLocalPid":c.pid,"targetStartTime":c.start,"waitStatus":status,"waitKind":if libc::WIFEXITED(status){"exited"}else{"signalled"},"exitCode":if libc::WIFEXITED(status){Some(libc::WEXITSTATUS(status))}else{None},"signal":if libc::WIFSIGNALED(status){Some(libc::WTERMSIG(status))}else{None},"usage":{"cpuMicros":cpu,"maxRssKiB":c.usage.ru_maxrss,"scope":"actual-target-wait4; maxrss is target peak"}})).is_err(){stop.get_or_insert(now);}
                }
            }
            if let Some(anchor) = stop {
                if !term {
                    term = true;
                    if c.status.is_none() && generation(c.pid).as_ref() == Some(&c.start) {
                        unsafe {
                            libc::kill(c.pid, libc::SIGTERM);
                        }
                    }
                }
                if !killed && now >= anchor.saturating_add(200_000_000) {
                    killed = true;
                    if c.status.is_none() && generation(c.pid).as_ref() == Some(&c.start) {
                        unsafe {
                            libc::kill(c.pid, libc::SIGKILL);
                        }
                    }
                }
            }
            if c.wait_reported && !channel.pending() {
                process::exit(if channel.write_failed { 125 } else { 0 });
            }
        } else if stop.is_some() {
            process::exit(125);
        }
        if stop.is_some_and(|s| now >= s.saturating_add(1_400_000_000)) {
            process::exit(125);
        }
        let until = stop
            .map(|s| s.saturating_add(if killed { 1_400_000_000 } else { 200_000_000 }))
            .unwrap_or(expires.unwrap_or(if child.is_none() {
                setup_until
            } else {
                u64::MAX
            }));
        let mut fds = Vec::new();
        let events = (if !channel.eof { libc::POLLIN } else { 0 })
            | if channel.pending() && !channel.write_failed {
                libc::POLLOUT
            } else {
                0
            };
        if events != 0 {
            fds.push(libc::pollfd {
                fd: channel.read_fd,
                events,
                revents: 0,
            });
        }
        if let Some(c) = &child {
            if !c.error_eof {
                fds.push(libc::pollfd {
                    fd: c.error_fd,
                    events: libc::POLLIN,
                    revents: 0,
                });
            }
        }
        unsafe {
            libc::poll(
                fds.as_mut_ptr(),
                fds.len() as libc::nfds_t,
                ((until.saturating_sub(control::monotonic_ns()) / 1_000_000) + 1).min(20) as i32,
            );
        }
    }
}
