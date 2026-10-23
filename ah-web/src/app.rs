//! Shared state of the running server.
use crate::cfg::Settings;
use ah_web_proto::Snapshot;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use tokio::sync::watch;

/// Everything the handlers share.
pub struct App {
    settings: RwLock<Arc<Settings>>,
    pub config_path: PathBuf,
    pub root: PathBuf,
    pub engine: PathBuf,
    pub token: String,
    pub port: u16,
    pub started: Instant,
    /// Seconds since `started` of the last request or stream event.
    pub last_active_s: AtomicU64,
    pub streams: AtomicUsize,
    pub polling: AtomicBool,
    pub last_good: Mutex<Snapshot>,
    pub tx: watch::Sender<String>,
}

impl App {
    pub fn new(settings: Settings, config_path: PathBuf, root: PathBuf, engine: PathBuf, token: String, port: u16) -> App {
        let first = serde_json::to_string(&Snapshot::default()).unwrap_or_default();
        App {
            settings: RwLock::new(Arc::new(settings)),
            config_path,
            root,
            engine,
            token,
            port,
            started: Instant::now(),
            last_active_s: AtomicU64::new(0),
            streams: AtomicUsize::new(0),
            polling: AtomicBool::new(false),
            last_good: Mutex::new(Snapshot::default()),
            tx: watch::channel(first).0,
        }
    }

    /// The current settings (a cheap clone of an `Arc`).
    pub fn settings(&self) -> Arc<Settings> {
        self.settings.read().map(|g| g.clone()).unwrap_or_else(|p| p.into_inner().clone())
    }

    /// Swap in re-read settings.
    pub fn replace_settings(&self, s: Settings) {
        match self.settings.write() {
            Ok(mut g) => *g = Arc::new(s),
            Err(p) => *p.into_inner() = Arc::new(s),
        }
    }

    /// Note activity now.
    pub fn touch(&self) {
        self.last_active_s.store(self.started.elapsed().as_secs(), std::sync::atomic::Ordering::Relaxed);
    }
}
