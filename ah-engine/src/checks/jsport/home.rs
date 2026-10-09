//! The home directory a hook resolves, with the test guard of `companion/lib/test-home-guard.js`.
use crate::reqenv::RequestEnv;

/// The home directory of the request (`HOME`), or `None` when the Node hook's answer cannot be reproduced: no `HOME`
/// (Node falls back to the password database), or a test marker with the real home (Node's guard throws there).
pub fn resolve(env: &RequestEnv) -> Option<String> {
    let home = env.get("HOME").filter(|h| !h.is_empty())?;
    let marked = ["ANTIHALL_TEST", "ANTIHALL_TEST_ISOLATION"].iter().any(|k| env.get(k).is_some_and(|v| !v.is_empty()));
    if marked
        && env.get("ANTIHALL_ALLOW_REAL_HOME_TEST").is_none_or(str::is_empty)
        && real_home().is_some_and(|r| crate::checks::git::util::resolve(home, "", "/") == crate::checks::git::util::resolve(&r, "", "/"))
    {
        return None;
    }
    Some(home.to_string())
}

/// The home directory of the password database entry of this user (`os.userInfo().homedir`).
pub fn real_home() -> Option<String> {
    // SAFETY: getpwuid_r writes into the buffer we pass and returns a pointer into it; both outlive the use below.
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0u8; 16384];
        let mut res: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwuid_r(libc::geteuid(), &mut pwd, buf.as_mut_ptr().cast(), buf.len(), &mut res);
        if rc != 0 || res.is_null() || pwd.pw_dir.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(pwd.pw_dir).to_string_lossy().into_owned())
    }
}

/// `process.getuid()`.
pub fn uid() -> u32 {
    // SAFETY: getuid has no preconditions.
    unsafe { libc::getuid() }
}
