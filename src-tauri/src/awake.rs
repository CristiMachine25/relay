//! Keeps the computer from sleeping while an Autopilot run is going, so a run left alone isn't
//! paused by idle sleep. At most one holder; dropping it lets the computer sleep again.
use std::sync::Mutex;

/// Whatever keeps the computer awake (a child process or a thread). Dropping it releases it.
type Hold = Box<dyn Send>;

/// Managed state behind `system_keep_awake`.
#[derive(Default)]
pub struct KeepAwake(Mutex<Option<Hold>>);

impl KeepAwake {
    /// Keep the computer awake (`on`) or let it sleep again. Idempotent. False only when asked to
    /// keep it awake and this platform has no way to.
    pub fn set(&self, on: bool) -> bool {
        self.set_with(on, hold)
    }

    fn set_with(&self, on: bool, hold: impl FnOnce() -> Option<Hold>) -> bool {
        let mut held = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if !on {
            *held = None;
        } else if held.is_none() {
            *held = hold();
        }
        !on || held.is_some()
    }
}

/// A child process in its own process group. Dropping it kills the group (so systemd-inhibit's
/// `sleep` goes too) and reaps the child.
#[cfg(unix)]
struct Group(std::process::Child);

#[cfg(unix)]
impl Drop for Group {
    fn drop(&mut self) {
        // Not reaped yet, so the pid (and the group it leads) is still ours. Never 0 or 1: kill(0)
        // would hit our own group.
        if let Some(pid) = i32::try_from(self.0.id()).ok().filter(|p| *p > 1) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        let _ = self.0.wait();
    }
}

#[cfg(unix)]
fn spawn_group(mut cmd: std::process::Command) -> Option<Group> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
    // If Relay dies without releasing it, the inhibitor goes too instead of keeping the computer
    // awake until reboot. The signal fires when the spawning *thread* ends: the command is sync, so
    // that is the main thread, which lives as long as the app.
    #[cfg(target_os = "linux")]
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    match cmd.spawn() {
        Ok(child) => Some(Group(child)),
        Err(e) => {
            log::warn!("keep awake: could not start {:?}: {e}", cmd.get_program());
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn hold() -> Option<Hold> {
    // -i: no idle sleep. -w: caffeinate ends by itself when Relay does, even after a crash.
    let mut cmd = std::process::Command::new("/usr/bin/caffeinate");
    cmd.args(["-i", "-w", &std::process::id().to_string()]);
    spawn_group(cmd).map(|g| Box::new(g) as Hold)
}

#[cfg(target_os = "linux")]
fn hold() -> Option<Hold> {
    let program = crate::util::which("systemd-inhibit")?;
    let mut cmd = std::process::Command::new(program);
    cmd.args([&format!("--who={}", crate::APP_NAME), "--what=idle:sleep", "--why=Autopilot run", "--mode=block", "sleep", "infinity"]);
    spawn_group(cmd).map(|g| Box::new(g) as Hold)
}

/// The execution state belongs to the thread that set it, so a thread of its own holds it until
/// the returned sender is dropped.
#[cfg(windows)]
fn hold() -> Option<Hold> {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    let (release, released) = std::sync::mpsc::channel::<()>();
    let (started, ok) = std::sync::mpsc::channel::<bool>();
    let spawned = std::thread::Builder::new().name("keep-awake".into()).spawn(move || {
        let held = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } != 0;
        let _ = started.send(held);
        if held {
            let _ = released.recv(); // returns once the sender is dropped
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    });
    if let Err(e) = spawned {
        log::warn!("keep awake: {e}");
        return None;
    }
    ok.recv().unwrap_or(false).then(|| Box::new(release) as Hold)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn hold() -> Option<Hold> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Counts how often it was dropped, i.e. released.
    struct Fake(Arc<AtomicUsize>);

    impl Drop for Fake {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn keeps_one_holder_and_releases_it_once() {
        let awake = KeepAwake::default();
        let (starts, drops) = (AtomicUsize::new(0), Arc::new(AtomicUsize::new(0)));
        let start = || {
            starts.fetch_add(1, Ordering::SeqCst);
            Some(Box::new(Fake(drops.clone())) as Hold)
        };
        assert!(awake.set_with(false, start), "releasing nothing is fine");
        assert!(awake.set_with(true, start));
        assert!(awake.set_with(true, start));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert!(awake.set_with(false, start));
        assert!(awake.set_with(false, start));
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(awake.set_with(true, start));
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        drop(awake);
        assert_eq!(drops.load(Ordering::SeqCst), 2, "dropping the state releases the holder");
    }

    #[test]
    fn says_so_when_it_cannot_keep_the_computer_awake() {
        let awake = KeepAwake::default();
        assert!(!awake.set_with(true, || None));
        assert!(awake.set_with(false, || None));
    }

    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn dropping_a_group_kills_and_reaps_the_child() {
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("30");
        let group = spawn_group(cmd).expect("sleep starts");
        let pid = group.0.id();
        assert!(alive(pid));
        drop(group);
        assert!(!alive(pid));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn caffeinate_holds_the_mac_awake_until_released() {
        let running = || {
            let pattern = format!("caffeinate -i -w {}", std::process::id());
            std::process::Command::new("pgrep").args(["-f", &pattern]).output().is_ok_and(|o| o.status.success())
        };
        let awake = KeepAwake::default();
        assert!(awake.set(true));
        assert!(awake.set(true));
        assert!(running());
        assert!(awake.set(false));
        assert!(!running());
    }
}
