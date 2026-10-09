//! Detection: realtime DevSwarm state exists only where DevSwarm does.
use crate::defaults;
use crate::meshw::ident::{self, Env};
use crate::meshw::idlock::devswarm_root;
use std::path::{Path, PathBuf};

/// `devswarm_rt.mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Inert, as if DevSwarm were absent.
    Off,
    /// State is kept and logged; consumers must not act on it.
    Observe,
    /// State is kept and consumers use it (the default).
    On,
}

impl Mode {
    /// Parse a mode word; anything unknown is `Off` (a mistyped setting never turns the layer on by accident).
    pub fn parse(s: &str) -> Mode {
        let w = s.trim();
        if w.eq_ignore_ascii_case("on") {
            Mode::On
        } else if w.eq_ignore_ascii_case("observe") {
            Mode::Observe
        } else {
            Mode::Off
        }
    }
    /// The configured mode.
    pub fn from_defaults() -> Mode {
        Mode::parse(defaults::text("devswarm_rt.mode"))
    }
}

/// What detection found.
#[derive(Debug, Clone)]
pub struct Detection {
    /// The app database file, when it exists.
    pub app_db: Option<PathBuf>,
    /// At least one workspace descriptor exists.
    pub descriptors: bool,
    /// The configured mode.
    pub mode: Mode,
    /// The home directory the probe used.
    pub home: PathBuf,
}

impl Detection {
    /// Should the layer run at all?
    pub fn active(&self) -> bool {
        self.mode != Mode::Off && (self.app_db.is_some() || self.descriptors)
    }
}

/// Probe for DevSwarm: the app database path resolves to an existing file, or a workspace descriptor exists. Reads nothing
/// else and starts nothing.
pub fn detect(home: &Path, env: &Env) -> Detection {
    let app_db = ident::app_db_path(home, env).map(PathBuf::from).filter(|p| p.is_file());
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let suffix = defaults::text("mesh_write.json_suffix");
    let descriptors = std::fs::read_dir(dir).is_ok_and(|mut d| d.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy().ends_with(suffix))));
    Detection { app_db, descriptors, mode: Mode::from_defaults(), home: home.to_path_buf() }
}
