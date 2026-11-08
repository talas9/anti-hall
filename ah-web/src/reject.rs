//! Requests the server refuses whatever `web.require_token` says: a Host that is not the dashboard's own loopback address (DNS rebinding)
//! and a state-changing request that another web page sent (Origin / Referer). Each refusal is counted in the engine's shared
//! counter journal as `web_request_rejected{reason}` (names and file from `web.toml`).
use crate::app::App;
use crate::cfg::Settings;
use axum::http::{HeaderMap, Method, header};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

/// Does a `Host` header name this server: a loopback name (or the bind address) plus the bound port?
pub fn host_ok(app: &App, s: &Settings, host: Option<&str>) -> bool {
    host.is_some_and(|h| {
        let (name, port) = h.rsplit_once(':').unwrap_or((h, ""));
        port == app.port.to_string() && own_name(s, name)
    })
}

fn own_name(s: &Settings, name: &str) -> bool {
    name == s.bind_host || s.loopback_names.iter().any(|n| n == name)
}

/// `scheme://authority` of a URL (the part before the path), or `None` when it has no authority.
fn origin_of(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    let end = rest
        .find(['/', '?', '#'])
        .map_or(url.len(), |i| url.len() - rest.len() + i);
    Some(&url[..end])
}

/// Is `origin` (`scheme://name:port`) this dashboard's own?
fn own_origin(app: &App, s: &Settings, origin: &str) -> bool {
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    let (name, port) = authority.rsplit_once(':').unwrap_or((authority, ""));
    scheme == s.origin_scheme && port == app.port.to_string() && own_name(s, name)
}

/// Is this request one that changes something (any method a page cannot send as a plain navigation or a read)?
fn changes_state(m: &Method) -> bool {
    !matches!(*m, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// A state-changing request is fine when it carries no Origin (and no Referer), or the one it carries is the dashboard's own.
pub fn origin_ok(app: &App, s: &Settings, method: &Method, headers: &HeaderMap) -> bool {
    if !changes_state(method) {
        return true;
    }
    let text = |h| headers.get(h).and_then(|v| v.to_str().ok());
    if let Some(o) = text(header::ORIGIN) {
        return own_origin(app, s, o);
    }
    match text(header::REFERER) {
        Some(r) => origin_of(r).is_some_and(|o| own_origin(app, s, o)),
        None => true,
    }
}

/// Count one refused request: append `<kind>\t<reason>\t<outcome>\t1\t0\t0` to the shared journal in the state directory under the
/// shared lock, as the engine's own writers do (the engine folds it). Best effort: counting never changes the answer.
pub fn count(app: &App, s: &Settings, reason: &str) {
    let Some(dir) = app.state.get() else { return };
    let journal = dir.join(&s.counters_file);
    let mut lock_name = journal.as_os_str().to_os_string();
    lock_name.push(&s.counters_lock_suffix);
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&lock_name);
    let fd = lock.as_ref().ok().map(std::os::fd::AsRawFd::as_raw_fd);
    if let Some(fd) = fd {
        // SAFETY: flock on a descriptor this function owns; a failure only means the append runs unlocked
        unsafe { libc::flock(fd, libc::LOCK_SH) };
    }
    let line = format!("{}\t{reason}\trefused\t1\t0\t0\n", s.rejected_counter);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&journal)
    {
        let _ = f.write_all(line.as_bytes()); // keep: a counter that cannot be written must not change the answer
    }
}

#[cfg(test)]
mod tests {
    use super::origin_of;

    #[test]
    fn referer_reduces_to_its_origin() {
        assert_eq!(
            origin_of("http://127.0.0.1:2/x?y=1"),
            Some("http://127.0.0.1:2")
        );
        assert_eq!(origin_of("http://127.0.0.1:2"), Some("http://127.0.0.1:2"));
        assert_eq!(origin_of("http://[::1]:2/#a"), Some("http://[::1]:2"));
        assert_eq!(origin_of("nonsense"), None);
    }
}
