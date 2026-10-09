//! Test doubles shared by the Jev unit tests: a scripted transport.
use super::transport::{NetError, RawResponse, Request, Transport};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// A transport that answers from a script (an empty script is a network error) and records every request.
pub(crate) struct Fake {
    pub script: Mutex<Vec<Result<RawResponse, NetError>>>,
    /// (url, bearer, body) of each request.
    pub seen: Mutex<Vec<(String, String, Option<String>)>>,
    /// The deadline each request was given.
    pub timeouts: Mutex<Vec<std::time::Duration>>,
}

impl Fake {
    pub(crate) fn new(script: Vec<Result<RawResponse, NetError>>) -> Fake {
        Fake { script: Mutex::new(script), seen: Mutex::new(Vec::new()), timeouts: Mutex::new(Vec::new()) }
    }
}

impl Transport for Fake {
    fn send(&self, req: &Request<'_>) -> Result<RawResponse, NetError> {
        self.seen.lock().unwrap().push((req.url.to_string(), req.bearer.to_string(), req.body.map(str::to_string)));
        self.timeouts.lock().unwrap().push(req.timeout);
        let mut s = self.script.lock().unwrap();
        if s.is_empty() { Err(NetError::Network) } else { s.remove(0) }
    }
}

/// A response with a readable body.
pub(crate) fn ok(status: u16, body: &str) -> Result<RawResponse, NetError> {
    Ok(RawResponse { status, body: Ok(body.to_string()) })
}

/// A resident lane for `home` over a scripted transport (default clock-free, file log under `home`), installed as the
/// shared lane the checks ask through. The env pairs are the lane's own default environment.
pub(crate) fn install_scripted(home: &Path, env: &[(&str, &str)], script: Vec<Result<RawResponse, NetError>>) -> (Arc<super::Jev>, Arc<Fake>) {
    let f = Arc::new(Fake::new(script));
    let jev =
        super::Jev::with_parts(home, super::Env::from_pairs(env.iter().copied()), f.clone(), Arc::new(super::breaker::ManualClock::default()), None, None);
    super::shared::install(home, jev.clone());
    (jev, f)
}

/// The decision-log rows under `home`, parsed, oldest first.
pub(crate) fn log_rows(home: &Path) -> Vec<serde_json::Value> {
    let p = home.join(".anti-hall/logs/jev-assist.ndjson");
    std::fs::read_to_string(p).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}
