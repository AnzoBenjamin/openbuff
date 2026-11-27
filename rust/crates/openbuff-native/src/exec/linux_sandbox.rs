//! Finite x86_64 Linux sandbox profile; no shell, ambient root bind or fallback.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::process::Command;

use super::control;
use super::control::NativePlan;

pub const FILTER_VERSION: &str = "openbuff.seccomp.x86_64.v1";

/// Classic BPF: reject foreign/x32 ABI, disallow namespace clone flags,
/// return ENOSYS for clone3 so libc may fall back to filtered clone, and deny
/// mount/namespace/ptrace/kernel mutation surfaces. Ordinary fork/exec remains.
pub fn filter_bytes(deny_network: bool) -> Vec<u8> {
    const LD: u16 = 0x20;
    const JEQ: u16 = 0x15;
    const JSET: u16 = 0x45;
    const RET: u16 = 0x06;
    const AND: u16 = 0x54;
    const KILL: u32 = 0x80000000;
    const ALLOW: u32 = 0x7fff0000;
    const ERRNO: u32 = 0x00050000;
    let mut program: Vec<(u16, u8, u8, u32)> = vec![
        (LD, 0, 0, 4),
        (JEQ, 1, 0, 0xc000003e),
        (RET, 0, 0, KILL),
        (LD, 0, 0, 0),
        (JSET, 0, 1, 0x40000000),
        (RET, 0, 0, KILL),
        (JEQ, 0, 1, 435),
        (RET, 0, 0, ERRNO | libc::ENOSYS as u32),
        (JEQ, 0, 4, 56),
        (LD, 0, 0, 16),
        (JSET, 0, 1, 0x7e020000),
        (RET, 0, 0, ERRNO | libc::EPERM as u32),
        (LD, 0, 0, 0),
    ];
    if deny_network {
        // INET/INET6 may communicate only inside the private netns. Named Unix,
        // vsock, netlink and packet sockets can address host services otherwise.
        program.extend([
            (JEQ, 0, 4, 41),
            (LD, 0, 0, 16),
            (JEQ, 2, 0, libc::AF_INET as u32),
            (JEQ, 1, 0, libc::AF_INET6 as u32),
            (RET, 0, 0, ERRNO | libc::EPERM as u32),
            (LD, 0, 0, 0),
        ]);
        // Connected anonymous stream pairs preserve subprocess stdio. Datagram
        // pairs can reconnect to named Unix peers, so are deliberately refused.
        program.extend([
            (JEQ, 0, 7, 53),
            (LD, 0, 0, 16),
            (JEQ, 1, 0, libc::AF_UNIX as u32),
            (RET, 0, 0, ERRNO | libc::EPERM as u32),
            (LD, 0, 0, 24),
            (AND, 0, 0, 0xf),
            (JEQ, 1, 0, libc::SOCK_STREAM as u32),
            (RET, 0, 0, ERRNO | libc::EPERM as u32),
            (LD, 0, 0, 0),
        ]);
        // io_uring can create/connect sockets without traversing their seccomp
        // syscall filters. No io_uring fd survives the target exec boundary.
        program.extend([(JEQ, 0, 1, 425), (RET, 0, 0, ERRNO | libc::EPERM as u32)]);
    }
    // pivot_root, ptrace, mount, umount2, swap, reboot, module/kernel handles,
    // unshare/setns, perf/bpf/userfaultfd, and new mount API syscalls.
    for number in [
        155, 101, 165, 166, 167, 168, 169, 172, 173, 174, 175, 176, 246, 248, 249, 250, 272, 298,
        303, 304, 308, 313, 321, 323, 428, 429, 430, 431, 432, 433, 438, 442,
    ] {
        program.push((JEQ, 0, 1, number));
        program.push((RET, 0, 0, ERRNO | libc::EPERM as u32));
    }
    program.push((RET, 0, 0, ALLOW));
    let mut bytes = Vec::new();
    for (code, jt, jf, k) in program {
        bytes.extend(code.to_le_bytes());
        bytes.extend([jt, jf]);
        bytes.extend(k.to_le_bytes());
    }
    bytes
}

/// Stack the network guard only after the trusted stub connected its private
/// transport. The base filter already applies at bwrap exec; the connected
/// Unix stream is closed at target exec and no target Unix socket can be made.
pub fn apply_network_filter() -> io::Result<()> {
    let bytes = filter_bytes(true);
    let filters = bytes
        .chunks_exact(8)
        .map(|b| libc::sock_filter {
            code: u16::from_le_bytes([b[0], b[1]]),
            jt: b[2],
            jf: b[3],
            k: u32::from_le_bytes([b[4], b[5], b[6], b[7]]),
        })
        .collect::<Vec<_>>();
    let program = libc::sock_fprog {
        len: filters.len() as u16,
        filter: filters.as_ptr() as *mut _,
    };
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0
        || unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn sealed_filter(bytes: &[u8]) -> io::Result<File> {
    let fd = unsafe {
        libc::memfd_create(
            c"openbuff-seccomp".as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let mut offset = 0;
    while offset < bytes.len() {
        let count =
            unsafe { libc::write(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset) };
        if count <= 0 {
            return Err(io::Error::last_os_error());
        }
        offset += count as usize;
    }
    if unsafe { libc::lseek(fd, 0, libc::SEEK_SET) } < 0
        || unsafe {
            libc::fcntl(
                fd,
                libc::F_ADD_SEALS,
                libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL,
            )
        } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

pub fn verified_file(path: &str, expected: &str, executable: bool) -> Result<File, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file()
        || before.len() > 32 * 1024 * 1024
        || (executable && before.mode() & 0o111 == 0)
    {
        return Err("invalid executable file identity".into());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    if bytes.len() as u64 != before.len()
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime_nsec() != after.ctime_nsec()
        || before.mtime() != after.mtime()
        || before.ctime() != after.ctime()
        || control::sha256(&bytes) != expected
    {
        return Err("executable generation/checksum changed".into());
    }
    if executable && !bytes.starts_with(b"\x7fELF") {
        return Err("executable must be an ELF".into());
    }
    Ok(file)
}

pub struct SandboxCommand {
    pub command: Command,
    // Keep mount/filter/tool fds live across Command::spawn; mounted artifact is
    // the inherited held fd5 generation, never the installation pathname.
    _files: Vec<File>,
}

pub fn build(plan: &NativePlan, socket_dir: &str) -> Result<SandboxCommand, String> {
    if !cfg!(target_arch = "x86_64") {
        return Err("Linux seccomp architecture unavailable".into());
    }
    let tool = verified_file(&plan.bwrap.path, &plan.bwrap.sha256, true)?;
    let bytes = filter_bytes(plan.network == "deny");
    if control::sha256(&bytes) != plan.filter_digest {
        return Err("seccomp filter generation mismatch".into());
    }
    // The base guard permits the stub's authenticated Unix connection. The
    // stricter deny variant is stacked inside the stub before preparation.
    let filter = sealed_filter(&filter_bytes(false)).map_err(|e| e.to_string())?;
    let socket = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(socket_dir)
        .map_err(|e| e.to_string())?;
    let mut files = vec![tool, filter, socket];
    let mut command = Command::new(format!("/proc/self/fd/{}", files[0].as_raw_fd()));
    command.env_clear().env("LANG", "C").env("LC_ALL", "C");
    command.args([
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--new-session",
        "--die-with-parent",
        "--cap-drop",
        "ALL",
    ]);
    if plan.network == "deny" {
        command.arg("--unshare-net");
    }
    command.args(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
    // An empty root with explicit mounts only. Destination ancestors are
    // created by bubblewrap, not by a broad root bind.
    for mount in &plan.mounts {
        let canonical = fs::canonicalize(&mount.source).map_err(|e| e.to_string())?;
        if canonical.to_str() != Some(&mount.source) {
            return Err("mount source canonical generation changed".into());
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW)
            .open(&mount.source)
            .map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if meta.dev().to_string() != mount.dev
            || meta.ino().to_string() != mount.ino
            || meta.file_type().is_symlink()
        {
            return Err("mount inode generation changed".into());
        }
        command
            .arg(if mount.write {
                "--bind-fd"
            } else {
                "--ro-bind-fd"
            })
            .arg(file.as_raw_fd().to_string())
            .arg(&mount.destination);
        files.push(file);
    }
    // Conventional loader symlinks are explicit; supplied mounts may instead
    // use /lib and /lib64 directly on distributions where these are real dirs.
    for (source, destination) in &plan.symlinks {
        command.args(["--symlink", source, destination]);
    }
    command.args(["--dir", "/.openbuff"]);
    command
        .arg("--ro-bind-fd")
        .arg("5")
        .arg("/.openbuff/native");
    command
        .arg("--ro-bind-fd")
        .arg(files[2].as_raw_fd().to_string())
        .arg("/.openbuff/control");
    command
        .arg("--seccomp")
        .arg(files[1].as_raw_fd().to_string());
    command.args([
        "--",
        "/.openbuff/native",
        "exec",
        "--entry-stub",
        "/.openbuff/control/socket",
    ]);
    command.arg(plan.expiry_ns.as_deref().unwrap_or("none"));
    let mut keep = files.iter().map(AsRawFd::as_raw_fd).collect::<Vec<_>>();
    keep.push(5);
    keep.sort_unstable();
    keep.dedup();
    // bwrap does forward unrelated inherited fds on the exercised host.
    // CLOEXEC preserves std's exec-error pipe until its intended exec boundary;
    // closing unknown fds in pre_exec would destroy that discriminating pipe.
    // Host controls close immediately; other fds close on bwrap exec.
    unsafe {
        command.pre_exec(move || {
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
            for fd in &keep {
                if *fd < 3 {
                    continue;
                }
                if libc::fcntl(*fd, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(SandboxCommand {
        command,
        _files: files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_filter_is_native_bpf_and_identity_is_stable() {
        let b = filter_bytes(true);
        assert_eq!(b.len() % 8, 0);
        assert_eq!(b[0..8], [0x20, 0, 0, 0, 4, 0, 0, 0]);
        assert_eq!(control::sha256(&b).len(), 64);
        assert!(b.len() < 4096 * 8);
        assert_eq!(
            control::sha256(&b),
            "9dd8d9f9dff7061c7678ef8a7c73187c0bd95b23b845f5a33643c2f9610418b1"
        );
        assert_eq!(
            control::sha256(&filter_bytes(false)),
            "e37993f735cb14741f6323ca75ec941189dfbb26e301796f0799858b80799bf7"
        );
    }
    #[test]
    #[cfg(target_arch = "x86_64")]
    fn kernel_network_filter_denies_named_routes_but_preserves_stream_pairs() {
        use std::os::unix::net::UnixListener;
        let directory = std::env::temp_dir().join(format!("b21-filter-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let socket = directory.join("socket");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let socket_path = socket.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            let bytes = filter_bytes(true);
            let mut filters = bytes
                .chunks_exact(8)
                .map(|b| libc::sock_filter {
                    code: u16::from_le_bytes([b[0], b[1]]),
                    jt: b[2],
                    jf: b[3],
                    k: u32::from_le_bytes(b[4..8].try_into().unwrap()),
                })
                .collect::<Vec<_>>();
            let program = libc::sock_fprog {
                len: filters.len() as u16,
                filter: filters.as_mut_ptr(),
            };
            assert_eq!(
                unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
                0
            );
            assert_eq!(
                unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) },
                0
            );
            for domain in [
                libc::AF_UNIX,
                libc::AF_NETLINK,
                libc::AF_VSOCK,
                libc::AF_PACKET,
            ] {
                assert_eq!(unsafe { libc::socket(domain, libc::SOCK_STREAM, 0) }, -1);
                assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPERM));
            }
            for domain in [libc::AF_INET, libc::AF_INET6] {
                let fd = unsafe { libc::socket(domain, libc::SOCK_STREAM, 0) };
                assert!(fd >= 0);
                unsafe {
                    libc::close(fd);
                }
            }
            let mut pair = [-1; 2];
            assert_eq!(
                unsafe {
                    libc::socketpair(
                        libc::AF_UNIX,
                        libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
                        0,
                        pair.as_mut_ptr(),
                    )
                },
                0
            );
            let message = b"anonymous IPC";
            assert_eq!(
                unsafe { libc::write(pair[0], message.as_ptr().cast(), message.len()) },
                message.len() as isize
            );
            let mut reply = [0u8; 13];
            assert_eq!(
                unsafe { libc::read(pair[1], reply.as_mut_ptr().cast(), reply.len()) },
                13
            );
            assert_eq!(&reply, message);
            let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
            address.sun_family = libc::AF_UNIX as libc::sa_family_t;
            for (dst, src) in address.sun_path.iter_mut().zip(socket_path.as_bytes()) {
                *dst = *src as libc::c_char;
            }
            assert_eq!(
                unsafe {
                    libc::connect(
                        pair[0],
                        (&address as *const libc::sockaddr_un).cast(),
                        std::mem::size_of_val(&address) as libc::socklen_t,
                    )
                },
                -1
            );
            address.sun_family = libc::AF_UNSPEC as libc::sa_family_t;
            assert_eq!(
                unsafe {
                    libc::connect(
                        pair[0],
                        (&address as *const libc::sockaddr_un).cast(),
                        std::mem::size_of_val(&address) as libc::socklen_t,
                    )
                },
                -1
            );
            unsafe {
                libc::close(pair[0]);
                libc::close(pair[1]);
            }
            assert_eq!(
                unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_DGRAM, 0, pair.as_mut_ptr()) },
                -1
            );
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPERM));
            let mut params = [0u8; 256];
            assert_eq!(
                unsafe { libc::syscall(libc::SYS_io_uring_setup, 1u32, params.as_mut_ptr()) },
                -1
            );
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPERM));
        })
        .join()
        .unwrap();
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(listener);
        fs::remove_file(socket).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
