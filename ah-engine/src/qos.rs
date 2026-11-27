//! #969: the scheduling class of the threads every tool call waits on.
//!
//! On a loaded machine the daemon competes for the CPU with every other process at the same priority, so a guard answer that needs
//! 25 ms of CPU can wait a second for it. macOS lets a thread ask for a higher quality-of-service class without root
//! (`pthread_set_qos_class_self_np`); the request-serving threads (the workers, the accept loop, the watchdog that writes the
//! heartbeat a waiting client reads) and the hook client's wait ask for the class named by `daemon.qos`. The class names and their
//! numeric values live in config (`daemon.qos_classes`, the values of the system's `qos_class_t`); a name not in that table (the
//! shipped `off`) changes nothing. Other systems have no per-thread QoS: the call is a no-op there.

/// The outcome of [`apply_self`], counted by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// The class was set on the calling thread.
    Set,
    /// The setting names no class (off, unknown name) or the system has no per-thread QoS: nothing changed.
    Off,
    /// The system refused the class (its error number).
    Refused(i32),
}

/// The numeric class `name` stands for in `daemon.qos_classes`; `None` = no class (off or unknown).
pub fn class_of(name: &str) -> Option<u32> {
    crate::defaults::raw("daemon.qos_classes").get(name).and_then(crate::defaults::V::as_integer).and_then(|n| u32::try_from(n).ok())
}

/// The class configured for the request-serving threads (`daemon.qos`), `None` when it is off.
pub fn configured() -> Option<u32> {
    class_of(crate::defaults::text("daemon.qos"))
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    // `qos_class_t` is an unsigned int in the C ABI; declared here with the plain type so the class value comes from config.
    fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: libc::c_int) -> libc::c_int;
    fn pthread_get_qos_class_np(thread: libc::pthread_t, qos_class: *mut u32, relative_priority: *mut libc::c_int) -> libc::c_int;
}

/// Put the calling thread in `class` (`None` = leave it as it is).
pub fn apply_class(class: Option<u32>) -> Applied {
    let Some(c) = class else { return Applied::Off };
    #[cfg(target_os = "macos")]
    {
        // SAFETY: plain integer arguments; the call only changes the calling thread's scheduling class.
        let rc = unsafe { pthread_set_qos_class_self_np(c, 0) };
        if rc == 0 { Applied::Set } else { Applied::Refused(rc) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = c;
        Applied::Off
    }
}

/// Put the calling thread in the configured class (`daemon.qos`); logged once per refusal kind, never fatal.
pub fn apply_self(site: &str) -> Applied {
    let r = apply_class(configured());
    if let Applied::Refused(rc) = r {
        crate::health::log_event("qos", site, &crate::defaults::render("daemon.qos_refused_msg", &[("rc", &rc)]));
    }
    r
}

/// The calling thread's current class (`None` off macOS or when the system does not say).
pub fn current() -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        let (mut c, mut rel) = (0u32, 0 as libc::c_int);
        // SAFETY: both out-pointers are live locals; pthread_self() is the calling thread.
        let rc = unsafe { pthread_get_qos_class_np(libc::pthread_self(), &mut c, &mut rel) };
        (rc == 0).then_some(c)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shipped setting names a class in the table, an unknown name or the off word is no class, and on macOS the class is
    /// really set on the thread; elsewhere nothing changes.
    #[test]
    fn the_configured_class_is_set_on_the_calling_thread_and_off_changes_nothing() {
        assert!(configured().is_some(), "the shipped daemon.qos names a class of daemon.qos_classes");
        assert_eq!(class_of("no-such-class"), None);
        assert_eq!(apply_class(None), Applied::Off);
        let want = configured();
        std::thread::spawn(move || {
            let r = apply_class(want);
            if cfg!(target_os = "macos") {
                assert_eq!(r, Applied::Set);
                assert_eq!(current(), want, "the thread runs in the configured class");
                // a thread it starts is NOT assumed to inherit the class: measured 2026-11-28 on macOS, a std::thread child read the
                // default class (21), so every serving thread sets its own class through apply_self
            } else {
                assert_eq!(r, Applied::Off);
                assert_eq!(current(), None);
            }
        })
        .join()
        .unwrap();
    }
}
