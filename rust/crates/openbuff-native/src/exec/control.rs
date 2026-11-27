//! Bounded, nonblocking private control transport. Target fd0/1/2 are never parsed.
use std::collections::{BTreeSet, VecDeque};
use std::io;

pub const PROTOCOL: &str = "openbuff.exec.v1";
pub const FRAME_LIMIT: usize = 64 * 1024;
pub const PLAN_LIMIT: usize = 1024 * 1024;
const TURN_BYTES: usize = 64 * 1024;
const QUEUE_LIMIT: usize = 2 * PLAN_LIMIT;

pub use super::plan::{valid_digest, Input, NativePlan};

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetUsage {
    pub cpu_micros: u64,
    pub max_rss_ki_b: u64,
    pub scope: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PeerOutput {
    StubPrepared {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        seccomp: i32,
        landlock: serde_json::Value,
    },
    ChildCreated {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        waiter_start_time: String,
        target_local_pid: i32,
        target_start_time: String,
    },
    ExecIntent {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        target_local_pid: i32,
        target_start_time: String,
    },
    ExecError {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        target_local_pid: i32,
        target_start_time: String,
        errno: i32,
        cause: String,
    },
    ExecClosed {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        target_local_pid: i32,
        target_start_time: String,
        no_error: bool,
        released: bool,
    },
    TargetWait {
        nonce: String,
        plan_digest: String,
        artifact_sha256: String,
        target_local_pid: i32,
        target_start_time: String,
        wait_status: i32,
        wait_kind: String,
        #[serde(deserialize_with = "crate::exec::plan::required_option")]
        exit_code: Option<i32>,
        #[serde(deserialize_with = "crate::exec::plan::required_option")]
        signal: Option<i32>,
        usage: TargetUsage,
    },
}

pub fn monotonic_ns() -> u64 {
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        std::process::exit(125);
    }
    (time.tv_sec as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(time.tv_nsec as u64)
}

pub fn nonblocking(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn cloexec(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Independent read/write halves support pipes or one Unix stream. No operation
/// blocks: fairness bounds let the owner recheck expiry/reap every poll turn.
pub struct Channel {
    pub read_fd: i32,
    pub write_fd: i32,
    input: Vec<u8>,
    output: VecDeque<Vec<u8>>,
    output_offset: usize,
    queued: usize,
    pub eof: bool,
    pub write_failed: bool,
}

impl Channel {
    pub fn new(read_fd: i32, write_fd: i32) -> io::Result<Self> {
        for fd in [read_fd, write_fd] {
            nonblocking(fd)?;
            cloexec(fd)?;
        }
        Ok(Self {
            read_fd,
            write_fd,
            input: Vec::new(),
            output: VecDeque::new(),
            output_offset: 0,
            queued: 0,
            eof: false,
            write_failed: false,
        })
    }

    pub fn pending(&self) -> bool {
        !self.output.is_empty()
    }

    pub fn enqueue<T: serde::Serialize>(&mut self, value: &T) -> Result<(), String> {
        self.enqueue_with_limit(value, FRAME_LIMIT)
    }
    pub fn enqueue_prepare<T: serde::Serialize>(&mut self, value: &T) -> Result<(), String> {
        self.enqueue_with_limit(value, PLAN_LIMIT)
    }
    fn enqueue_with_limit<T: serde::Serialize>(
        &mut self,
        value: &T,
        limit: usize,
    ) -> Result<(), String> {
        if self.write_failed {
            return Err("control writer disconnected".into());
        }
        let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if body.is_empty() || body.len() > limit || self.queued + body.len() + 4 > QUEUE_LIMIT {
            return Err("control output queue limit".into());
        }
        let mut frame = (body.len() as u32).to_le_bytes().to_vec();
        frame.extend(body);
        self.queued += frame.len();
        self.output.push_back(frame);
        Ok(())
    }

    pub fn read_turn(&mut self, limit: usize) -> Result<Vec<Vec<u8>>, String> {
        let mut consumed = 0;
        let mut frames = Vec::new();
        loop {
            while self.input.len() >= 4 && frames.len() < 8 {
                let length = u32::from_le_bytes(self.input[..4].try_into().unwrap()) as usize;
                if length == 0 || length > limit {
                    return Err("invalid control frame length".into());
                }
                if self.input.len() < length + 4 {
                    break;
                }
                frames.push(self.input[4..length + 4].to_vec());
                self.input.drain(..length + 4);
            }
            if consumed >= TURN_BYTES || frames.len() >= 8 || self.eof {
                break;
            }
            let mut bytes = [0u8; 8192];
            let count = unsafe { libc::read(self.read_fd, bytes.as_mut_ptr().cast(), bytes.len()) };
            if count > 0 {
                consumed += count as usize;
                self.input.extend_from_slice(&bytes[..count as usize]);
                if self.input.len() > PLAN_LIMIT + TURN_BYTES + 4 {
                    return Err("control input buffer limit".into());
                }
            } else if count == 0 {
                self.eof = true;
                if !self.input.is_empty() {
                    return Err("control EOF in partial frame".into());
                }
                break;
            } else {
                match io::Error::last_os_error().raw_os_error() {
                    Some(libc::EAGAIN) => break,
                    Some(libc::EINTR) => break,
                    _ => return Err(io::Error::last_os_error().to_string()),
                }
            }
        }
        Ok(frames)
    }

    pub fn write_turn(&mut self) -> Result<(), String> {
        if self.write_failed {
            return Err("control writer disconnected".into());
        }
        let mut sent = 0;
        while let Some(frame) = self.output.front() {
            if sent >= TURN_BYTES {
                break;
            }
            let bytes = &frame[self.output_offset..];
            let count = unsafe {
                libc::write(
                    self.write_fd,
                    bytes.as_ptr().cast(),
                    bytes.len().min(TURN_BYTES - sent),
                )
            };
            if count > 0 {
                let count = count as usize;
                self.output_offset += count;
                self.queued -= count;
                sent += count;
                if self.output_offset == frame.len() {
                    self.output.pop_front();
                    self.output_offset = 0;
                }
            } else {
                match io::Error::last_os_error().raw_os_error() {
                    Some(libc::EAGAIN) | Some(libc::EINTR) => break,
                    _ => {
                        self.write_failed = true;
                        return Err(io::Error::last_os_error().to_string());
                    }
                }
            }
        }
        Ok(())
    }
}

/// Reject duplicate fields at every nesting level before typed schema parsing.
pub fn strict_json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    use serde::de::{self, MapAccess, SeqAccess, Visitor};
    struct Unique;
    impl<'de> Visitor<'de> for Unique {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("JSON without duplicate fields")
        }
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
            Ok(())
        }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
            Ok(())
        }
        fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
            Ok(())
        }
        fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
            Ok(())
        }
        fn visit_str<E: de::Error>(self, _: &str) -> Result<(), E> {
            Ok(())
        }
        fn visit_unit<E: de::Error>(self) -> Result<(), E> {
            Ok(())
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<(), A::Error> {
            while a.next_element::<UniqueValue>()?.is_some() {}
            Ok(())
        }
        fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<(), A::Error> {
            let mut keys = BTreeSet::new();
            while let Some(key) = a.next_key::<String>()? {
                if !keys.insert(key) {
                    return Err(de::Error::custom("duplicate JSON field"));
                }
                a.next_value::<UniqueValue>()?;
            }
            Ok(())
        }
    }
    struct UniqueValue;
    impl<'de> serde::Deserialize<'de> for UniqueValue {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            d.deserialize_any(Unique)?;
            Ok(Self)
        }
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    <UniqueValue as serde::Deserialize>::deserialize(&mut decoder).map_err(|e| e.to_string())?;
    decoder.end().map_err(|e| e.to_string())?;
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}

/// SHA256 of exact host plan bytes; no dependency or authority is inferred.
pub fn sha256(bytes: &[u8]) -> String {
    sha256_before(bytes, u64::MAX).expect("unbounded SHA256")
}
pub fn sha256_before(bytes: &[u8], until: u64) -> Result<String, String> {
    if monotonic_ns() >= until {
        return Err("native expiry during hash".into());
    }
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&((bytes.len() as u64) * 8).to_be_bytes());
    for (index, block) in padded.chunks_exact(64).enumerate() {
        if index % 1024 == 0 && monotonic_ns() >= until {
            return Err("native expiry during hash".into());
        }
        let mut w = [0u32; 64];
        for (i, chunk) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes(chunk.try_into().unwrap());
        }
        for i in 16..64 {
            let a = w[i - 15];
            let b = w[i - 2];
            w[i] = w[i - 16]
                .wrapping_add(a.rotate_right(7) ^ a.rotate_right(18) ^ (a >> 3))
                .wrapping_add(w[i - 7])
                .wrapping_add(b.rotate_right(17) ^ b.rotate_right(19) ^ (b >> 10));
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut z] = h;
        for i in 0..64 {
            let t1 = z
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            z = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, z]) {
            *x = x.wrapping_add(y);
        }
    }
    Ok(h.iter().map(|v| format!("{v:08x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    #[test]
    fn exact_hash_vectors() {
        assert_eq!(
            sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256(&vec![b'a'; 1_000_000]),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
    #[test]
    fn nested_duplicate_and_invalid_utf8_rejected() {
        assert!(strict_json::<serde_json::Value>(br#"{"x":{"a":1,"a":2}}"#).is_err());
        assert!(strict_json::<serde_json::Value>(b"\xff").is_err());
        assert!(strict_json::<serde_json::Value>(br#"{"x":[true,null,12,"s"]}"#).is_ok());
    }
    #[test]
    fn fragmented_control_and_partial_eof_are_discriminating() {
        let (mut peer, owned) = UnixStream::pair().unwrap();
        let mut channel = Channel::new(owned.as_raw_fd(), owned.as_raw_fd()).unwrap();
        let body = br#"{"type":"stop","reason":"fixture"}"#;
        let header = (body.len() as u32).to_le_bytes();
        peer.write_all(&header[..2]).unwrap();
        assert!(channel.read_turn(FRAME_LIMIT).unwrap().is_empty());
        peer.write_all(&header[2..]).unwrap();
        peer.write_all(&body[..3]).unwrap();
        assert!(channel.read_turn(FRAME_LIMIT).unwrap().is_empty());
        peer.write_all(&body[3..]).unwrap();
        assert_eq!(channel.read_turn(FRAME_LIMIT).unwrap(), vec![body.to_vec()]);
        peer.write_all(&[3, 0]).unwrap();
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        drop(peer);
        assert!(channel.read_turn(FRAME_LIMIT).is_err());
    }
    #[test]
    fn slow_reader_output_is_bounded_and_nonblocking() {
        let (_peer, owned) = UnixStream::pair().unwrap();
        let mut channel = Channel::new(owned.as_raw_fd(), owned.as_raw_fd()).unwrap();
        let value = serde_json::json!({"payload":"x".repeat(FRAME_LIMIT-64)});
        let mut count = 0;
        while channel.enqueue(&value).is_ok() {
            count += 1;
            assert!(count < 40);
        }
        assert!(count > 1);
        for _ in 0..100 {
            channel.write_turn().unwrap();
        }
        assert!(channel.pending());
        assert!(channel
            .enqueue(&serde_json::json!({"payload":"x".repeat(FRAME_LIMIT)}))
            .is_err());
    }
    #[test]
    fn expired_hash_budget_is_not_renewed() {
        assert!(sha256_before(&vec![0; 1024 * 1024], monotonic_ns()).is_err());
    }
}
