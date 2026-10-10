//! The statusline's view of the live workspace state (feature 1). The daemon writes a compact copy of the snapshot after every
//! reconcile ([`write`]); the statusline reads only that file ([`segment`]), never the DevSwarm database, so drawing the line
//! costs one small file read. Advisory only: a copy older than the stale limit shows `?` instead of a guess.
//! Every word, limit and color is plugin config (`devswarm_rt.line_*`, `devswarm_rt.set_line_*`).
use super::state::{Activity, Lifecycle, Snapshot};
use crate::checks::git::util::Settings;
use crate::defaults;
use serde_json::{Value, json};
use std::path::PathBuf;

/// Where the copy lives.
pub fn path() -> PathBuf {
    crate::paths::dir().join(defaults::text("devswarm_rt.line_file"))
}

/// The compact copy of `snap`: one row per open workspace (lifecycle and activity words and when the activity was observed).
pub fn compact(snap: &Snapshot) -> Value {
    let rows: Vec<Value> = snap
        .workspaces
        .values()
        .filter(|w| matches!(w.lifecycle.value, Lifecycle::Active | Lifecycle::Unknown))
        .map(|w| {
            let a = match w.activity.value {
                Activity::Working => "working",
                Activity::Stuck => "stuck",
                Activity::WaitingCi => "ci",
                Activity::Done => "done",
                Activity::Unknown => "unknown",
            };
            json!([a, w.activity.observed_ms])
        })
        .collect();
    json!({"at": snap.at_ms, "readable": snap.app_readable, "ws": rows})
}

/// Persist the copy (atomic, best effort: a lost write leaves the previous copy, which goes stale and shows `?`).
pub fn write(snap: &Snapshot) {
    crate::dsact::exec::write_atomic(&path(), &compact(snap).to_string());
}

/// The resolved segment settings.
#[derive(Debug, Clone, PartialEq)]
pub struct LineCfg {
    /// Whether to show the segment.
    pub enabled: bool,
    /// The format text.
    pub format: String,
    /// Longest segment in characters.
    pub max_chars: usize,
    /// Older than this is stale.
    pub stale_ms: i64,
}

impl LineCfg {
    /// Resolve the four settings for the request environment `st`.
    pub fn read(st: &Settings) -> LineCfg {
        let get = |k: &str| crate::dsact::settings::resolve(st, defaults::raw(k));
        LineCfg {
            enabled: get("devswarm_rt.set_line_enabled").as_bool().unwrap_or(false),
            format: get("devswarm_rt.set_line_format").as_str().unwrap_or_default().to_string(),
            max_chars: get("devswarm_rt.set_line_max_chars").as_u64().unwrap_or(40) as usize,
            stale_ms: get("devswarm_rt.set_line_stale_ms").as_i64().unwrap_or(180_000),
        }
    }
}

/// The segment for the copy `text` at time `now`, with `color(name)` giving the escape for a color name and `reset` its end.
/// Empty when disabled, when there is no copy, or when no workspace is open.
pub fn segment(text: &str, now: i64, cfg: &LineCfg, color: &dyn Fn(&str) -> String) -> String {
    if !cfg.enabled {
        return String::new();
    }
    let Ok(v) = serde_json::from_str::<Value>(text) else { return String::new() };
    let at = v["at"].as_i64().unwrap_or(0);
    let stale_text = defaults::text("devswarm_rt.line_stale_text");
    if !v["readable"].as_bool().unwrap_or(false) || now.saturating_sub(at) > cfg.stale_ms {
        return format!("{}{stale_text}{}", color("dim"), color("reset"));
    }
    let mut n = std::collections::BTreeMap::<&str, u64>::new();
    for row in v["ws"].as_array().into_iter().flatten() {
        let (a, obs) = (row[0].as_str().unwrap_or("unknown"), row[1].as_i64().unwrap_or(0));
        let part = if now.saturating_sub(obs) > cfg.stale_ms {
            "unknown" // an activity observed too long ago is not claimed
        } else {
            match a {
                "working" => "working",
                "stuck" => "stuck",
                "ci" => "ci",
                "done" => "done_open",
                _ => "unknown",
            }
        };
        *n.entry(part).or_default() += 1;
    }
    let parts_cfg = defaults::raw("devswarm_rt.line_parts");
    let colors = defaults::raw("devswarm_rt.line_colors");
    let (mut plain, mut rich) = (Vec::new(), Vec::new());
    for name in defaults::list("devswarm_rt.line_order") {
        let Some(&count) = n.get(name) else { continue };
        let t = parts_cfg.get(name).and_then(defaults::V::as_str).unwrap_or_default().replace("{n}", &count.to_string());
        rich.push(format!("{}{t}{}", color(colors.get(name).and_then(defaults::V::as_str).unwrap_or_default()), color("reset")));
        plain.push(t);
    }
    if plain.is_empty() {
        return String::new();
    }
    let flat = cfg.format.replace("{parts}", &plain.join(" "));
    if flat.chars().count() > cfg.max_chars {
        let cut: String = flat.chars().take(cfg.max_chars.saturating_sub(1)).collect();
        return format!("{}{cut}{}{}", color("dim"), defaults::text("devswarm_rt.line_ellipsis"), color("reset"));
    }
    cfg.format.replace("{parts}", &rich.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> LineCfg {
        LineCfg { enabled: true, format: "ws {parts}".into(), max_chars: 40, stale_ms: 180_000 }
    }
    fn nocolor(_: &str) -> String {
        String::new()
    }
    fn fixture(at: i64, rows: &[(&str, i64)]) -> String {
        json!({"at": at, "readable": true, "ws": rows.iter().map(|(a, o)| json!([a, o])).collect::<Vec<_>>()}).to_string()
    }

    #[test]
    fn counts_by_state_and_flags_done_but_open() {
        let t = fixture(1000, &[("working", 900), ("working", 900), ("stuck", 900), ("ci", 900), ("done", 900), ("done", 900)]);
        assert_eq!(segment(&t, 1000, &cfg(), &nocolor), "ws ▶2 ⚠1 ⏳1 ✓2 open");
    }

    #[test]
    fn a_stale_copy_or_an_unreadable_app_shows_a_question_mark_and_a_stale_row_is_unknown() {
        let t = fixture(1000, &[("working", 1000), ("working", 1000 - 200_000)]);
        assert_eq!(segment(&t, 1000, &cfg(), &nocolor), "ws ▶1 ?1");
        assert_eq!(segment(&t, 1000 + 200_000, &cfg(), &nocolor), "ws ?");
        let unreadable = json!({"at": 1000, "readable": false, "ws": []}).to_string();
        assert_eq!(segment(&unreadable, 1000, &cfg(), &nocolor), "ws ?");
    }

    #[test]
    fn disabled_empty_missing_and_cut_segments() {
        let t = fixture(10, &[("working", 10)]);
        assert_eq!(segment(&t, 10, &LineCfg { enabled: false, ..cfg() }, &nocolor), "");
        assert_eq!(segment(&fixture(10, &[]), 10, &cfg(), &nocolor), "");
        assert_eq!(segment("not json", 10, &cfg(), &nocolor), "");
        assert_eq!(segment(&t, 10, &LineCfg { max_chars: 4, ..cfg() }, &nocolor), "ws …");
    }

    #[test]
    fn the_settings_resolve_from_the_users_settings_file_then_the_default() {
        let d = std::env::temp_dir().join(format!("ah-line-{}", std::process::id()));
        std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
        let st = |home: &std::path::Path| Settings { home: home.to_string_lossy().into_owned(), env: Default::default() };
        assert_eq!(LineCfg::read(&st(&d)), cfg(), "no file: the shipped defaults (on)");
        std::fs::write(
            d.join(".anti-hall/settings.json"),
            r#"{"statusline":{"devswarm":{"enabled":false,"format":"dsw {parts}","max_chars":12,"stale_ms":5000}}}"#,
        )
        .unwrap();
        assert_eq!(LineCfg::read(&st(&d)), LineCfg { enabled: false, format: "dsw {parts}".into(), max_chars: 12, stale_ms: 5000 });
    }

    #[test]
    fn the_compact_copy_keeps_only_open_workspaces() {
        use crate::devswarm_rt::state::Snapshot;
        assert_eq!(compact(&Snapshot::default())["ws"], json!([]));
    }

    #[test]
    fn rendering_the_segment_is_well_inside_two_milliseconds() {
        let rows: Vec<(&str, i64)> = (0..50).map(|i| (["working", "stuck", "ci", "done"][i % 4], 1000)).collect();
        let t = fixture(1000, &rows);
        let c = |_: &str| String::new();
        assert!(!segment(&t, 1000, &cfg(), &c).is_empty()); // warm-up: the first call loads the shipped defaults
        let start = std::time::Instant::now();
        for _ in 0..200 {
            assert!(!segment(&t, 1000, &cfg(), &c).is_empty());
        }
        let per_ms = start.elapsed().as_secs_f64() * 1000.0 / 200.0;
        eprintln!("segment render: {per_ms:.4} ms per call (50 workspaces, debug build)");
        assert!(per_ms < 2.0, "{per_ms}");
    }
}
