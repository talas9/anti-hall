//! Shared state of the running server: the settings, the connection counts and the model every stream reads.
use crate::cfg::Settings;
use crate::model::Model;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

/// Everything the handlers share.
pub struct App {
    settings: RwLock<Arc<Settings>>,
    pub config_path: PathBuf,
    pub root: PathBuf,
    pub engine: PathBuf,
    /// The engine daemon's control socket.
    pub socket: PathBuf,
    pub token: String,
    pub port: u16,
    pub started: Instant,
    /// Seconds since `started` of the last request.
    pub last_active_s: AtomicU64,
    /// Open streams by tier; the poller runs while either is above zero and follows the faster tier.
    pub full_streams: AtomicUsize,
    pub lite_streams: AtomicUsize,
    pub polling: AtomicBool,
    pub model: Mutex<Model>,
    /// The hook wiring read from `describe`, with the time it was read.
    pub live_map: Mutex<Option<(Instant, ah_web_proto::LiveMap)>>,
}

impl App {
    pub fn new(settings: Settings, config_path: PathBuf, root: PathBuf, engine: PathBuf, socket: PathBuf, token: String, port: u16) -> App {
        let model = Model::new(settings.delta_ring, settings.feed_max, settings.live_backfill);
        App {
            settings: RwLock::new(Arc::new(settings)),
            config_path,
            root,
            engine,
            socket,
            token,
            port,
            started: Instant::now(),
            last_active_s: AtomicU64::new(0),
            full_streams: AtomicUsize::new(0),
            lite_streams: AtomicUsize::new(0),
            polling: AtomicBool::new(false),
            model: Mutex::new(model),
            live_map: Mutex::new(None),
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

    /// Streams open now, both tiers.
    pub fn streams(&self) -> usize {
        self.full_streams.load(std::sync::atomic::Ordering::SeqCst) + self.lite_streams.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The model, even after a panic elsewhere poisoned the lock (the data in it is plain values).
    pub fn model(&self) -> std::sync::MutexGuard<'_, Model> {
        self.model.lock().unwrap_or_else(|p| p.into_inner())
    }
}
