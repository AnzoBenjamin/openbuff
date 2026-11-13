//! Dedicated fd3/fd4 one-shot native protocol. Target fd0/1/2 stay raw.
#[cfg(target_os = "linux")]
pub mod control;
#[cfg(target_os = "linux")]
mod entry_waiter;
#[cfg(target_os = "linux")]
mod landlock_fs;
#[cfg(target_os = "linux")]
pub mod linux_sandbox;
#[cfg(target_os = "linux")]
pub mod plan;
#[cfg(target_os = "linux")]
mod runner;

pub fn run() -> ! {
    #[cfg(target_os = "linux")]
    runner::run_native();
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("native execution enforcement unavailable on this platform");
        std::process::exit(125);
    }
}
