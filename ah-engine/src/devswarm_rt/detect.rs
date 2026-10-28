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
    /// The mode stored as a `u8` by [`Mode`]'s discriminant; anything unknown is `Off`.
    pub fn from_u8(n: u8) -> Mode {
        match n {
            x if x == Mode::On as u8 => Mode::On,
            x if x == Mode::Observe as u8 => Mode::Observe,
            _ => Mode::Off,
        }
    }
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
    /// The shipped default mode (no user layers).
    pub fn from_defaults() -> Mode {
        Mode::parse(defaults::text("devswarm_rt.mode"))
    }
    /// The mode the settings layers (environment, `settings.json`, `config.toml`, shipped default) resolve to, read from the files now.
    pub fn configured() -> Mode {
        Mode::parse(&crate::dswire::effective_text("devswarm_rt.mode"))
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
    detect_with(home, env, Mode::from_defaults())
}

/// [`detect`] with the mode the caller resolved (the daemon resolves it from its live configuration, not from the shipped default).
pub fn detect_with(home: &Path, env: &Env, mode: Mode) -> Detection {
    let app_db = ident::app_db_path(home, env).map(PathBuf::from).filter(|p| p.is_file());
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let suffix = defaults::text("mesh_write.json_suffix");
    let descriptors = std::fs::read_dir(dir).is_ok_and(|mut d| d.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy().ends_with(suffix))));
    Detection { app_db, descriptors, mode, home: home.to_path_buf() }
}
