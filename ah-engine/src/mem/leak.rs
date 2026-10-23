//! The leak sentinel (issue #200): finds a leak by its TREND, long before any limit is reached.
//!
//! After warm-up the watchdog samples the footprint, the counted heap and every holder's bytes into a bounded ring. A robust slope
//! (the median of all pairwise slopes, Theil-Sen) over the trend window says whether memory keeps climbing: one step after a heavy
//! event moves few pairwise slopes and leaves the median alone, a steady climb moves all of them. A leak is suspected when
//!
//! * the footprint or the heap climbs faster than `mem.leak_slope_mb_per_h` over the whole window and the newer half of the window
//!   still climbs (it did not flatten), or
//! * a holder stays at or over its own soft limit, or grows in each of several consecutive windows (never plateaus).
//!
//! The report names the top-growing part and the share of the growth it explains; heap no holder claims, and footprint outside the
//! counted heap, are candidates too. The sentinel only reports: it never restarts or kills. Every number and text comes from
//! `defaults/mem.toml` (`mem.leak_*`).
use crate::defaults;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

const MB: f64 = 1_048_576.0;
const HOUR_S: f64 = 3600.0;

/// One holder's reading in a sample.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolderReading {
    /// The holder's registered name.
    pub name: String,
    /// Bytes it holds.
    pub bytes: u64,
    /// Its soft limit (0 = none).
    pub soft: u64,
}

/// One reading of the process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    /// Seconds since the epoch.
    pub t_s: u64,
    /// The footprint (the budget metric), bytes.
    pub footprint: u64,
    /// The counted heap, bytes.
    pub heap: u64,
    /// Every registered holder.
    pub holders: Vec<HolderReading>,
}

/// The thresholds, read from the plugin's config.
#[derive(Debug, Clone)]
pub struct Params {
    /// Trend window, seconds.
    pub window_s: u64,
    /// Percent of the window the samples must span for `suspected`.
    pub full_pct: u64,
    /// Fewest samples for a slope.
    pub min_samples: usize,
    /// Suspect at this MB/h.
    pub slope_mb_per_h: f64,
    /// Watch at this percent of the slope limit.
    pub watch_pct: f64,
    /// The newer half must climb at least this percent of the slope limit.
    pub flatten_pct: f64,
    /// Samples in a row a holder must sit at its soft limit.
    pub holder_over_samples: usize,
    /// Consecutive growth windows for the plateau test.
    pub holder_windows: usize,
    /// Length of one such window, seconds.
    pub holder_window_s: u64,
    /// KB/h a holder must grow by in each of them.
    pub holder_slope_kb_per_h: f64,
}

impl Params {
    /// The thresholds in force.
    pub fn from_defaults() -> Params {
        let n = |k: &str| defaults::num(k);
        Params {
            window_s: n("mem.leak_window_s"),
            full_pct: n("mem.leak_window_full_pct"),
            min_samples: n("mem.leak_min_samples") as usize,
            slope_mb_per_h: n("mem.leak_slope_mb_per_h") as f64,
            watch_pct: n("mem.leak_watch_pct") as f64,
            flatten_pct: n("mem.leak_flatten_pct") as f64,
            holder_over_samples: n("mem.leak_holder_over_samples") as usize,
            holder_windows: n("mem.leak_holder_windows") as usize,
            holder_window_s: n("mem.leak_holder_window_s"),
            holder_slope_kb_per_h: n("mem.leak_holder_slope_kb_per_h") as f64,
        }
    }
}

/// The sentinel's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Nothing grows.
    Ok,
    /// Something grows, not yet a leak.
    Watch,
    /// A leak is suspected.
    Suspected,
}

impl Level {
    /// The configured name.
    pub fn name(self) -> &'static str {
        defaults::text(match self {
            Level::Ok => "mem.leak_state_ok",
            Level::Watch => "mem.leak_state_watch",
            Level::Suspected => "mem.leak_state_suspected",
        })
    }
}

/// The part that grows most.
#[derive(Debug, Clone, PartialEq)]
pub struct Top {
    /// Holder name, or the unattributed / outside-heap label.
    pub name: String,
    /// Its growth, MB per hour.
    pub mb_per_h: f64,
    /// Percent of the basis growth it explains.
    pub share_pct: f64,
}

/// What one evaluation concluded.
#[derive(Debug, Clone)]
pub struct Verdict {
    /// The state.
    pub level: Level,
    /// Footprint slope over the window, MB/h.
    pub footprint_mb_per_h: f64,
    /// Heap slope over the window, MB/h.
    pub heap_mb_per_h: f64,
    /// Slope of the newer half of the window for the basis series, MB/h.
    pub late_mb_per_h: f64,
    /// Which series is the basis (`mem.leak_basis_*`).
    pub basis: &'static str,
    /// Samples in the window.
    pub samples: usize,
    /// Seconds the window's samples span.
    pub span_s: u64,
    /// The whole-process trend tripped (not only a holder).
    pub trend: bool,
    /// Holders flagged, with the reason text.
    pub holders: Vec<(String, &'static str)>,
    /// The part growing most.
    pub top: Option<Top>,
}

/// The median of all pairwise slopes of `pts` (x, y); `None` with fewer than two distinct x.
pub fn theil_sen(pts: &[(f64, f64)]) -> Option<f64> {
    let mut slopes = Vec::with_capacity(pts.len() * pts.len().saturating_sub(1) / 2);
    for (i, a) in pts.iter().enumerate() {
        for b in &pts[i + 1..] {
            let dx = b.0 - a.0;
            if dx > 0.0 {
                slopes.push((b.1 - a.1) / dx);
            }
        }
    }
    if slopes.is_empty() {
        return None;
    }
    slopes.sort_by(f64::total_cmp);
    let m = slopes.len() / 2;
    Some(if slopes.len() % 2 == 1 { slopes[m] } else { (slopes[m - 1] + slopes[m]) / 2.0 })
}

fn slope_of<'a>(samples: impl Iterator<Item = &'a Sample>, f: impl Fn(&Sample) -> f64) -> Option<f64> {
    let pts: Vec<(f64, f64)> = samples.map(|s| (s.t_s as f64 / HOUR_S, f(s))).collect();
    theil_sen(&pts)
}

/// Slope in MB/h of `f` over the window and over its newer half.
fn window_slopes(win: &[&Sample], f: impl Fn(&Sample) -> f64 + Copy) -> (f64, f64) {
    let all = slope_of(win.iter().copied(), f).unwrap_or(0.0) / MB;
    let late = slope_of(win[win.len() / 2..].iter().copied(), f).unwrap_or(0.0) / MB;
    (all, late)
}

fn holder_bytes(s: &Sample, name: &str) -> f64 {
    s.holders.iter().find(|h| h.name == name).map_or(0.0, |h| h.bytes as f64)
}

fn other_bytes(s: &Sample) -> f64 {
    s.heap as f64 - s.holders.iter().map(|h| h.bytes as f64).sum::<f64>()
}

/// Holders at their soft limit for the last `holder_over_samples` samples, or growing in each of the last `holder_windows` windows.
fn flagged_holders(ring: &[&Sample], p: &Params) -> Vec<(String, &'static str)> {
    let Some(last) = ring.last() else { return Vec::new() };
    let mut out = Vec::new();
    let over_n = p.holder_over_samples.max(1);
    let segs = p.holder_windows.max(2);
    for h in &last.holders {
        if h.soft > 0
            && ring.len() >= over_n
            && ring[ring.len() - over_n..].iter().all(|s| s.holders.iter().any(|x| x.name == h.name && x.bytes >= x.soft && x.soft > 0))
        {
            out.push((h.name.clone(), defaults::text("mem.leak_reason_over_soft")));
            continue;
        }
        let hw = p.holder_window_s.max(1);
        let mut every = true;
        for i in 0..segs {
            let hi = last.t_s.saturating_sub(hw * (segs - 1 - i) as u64);
            let lo = hi.saturating_sub(hw);
            let seg: Vec<&Sample> = ring.iter().copied().filter(|s| s.t_s > lo && s.t_s <= hi).collect();
            let grows = seg.len() >= 3
                && slope_of(seg.iter().copied(), |s| holder_bytes(s, &h.name)).is_some_and(|b_per_h| b_per_h >= p.holder_slope_kb_per_h * 1024.0);
            if !grows {
                every = false;
                break;
            }
        }
        if every {
            out.push((h.name.clone(), defaults::text("mem.leak_reason_no_plateau")));
        }
    }
    out
}

/// Judge the ring as of `now_s`.
pub fn evaluate(ring: &[&Sample], now_s: u64, p: &Params) -> Verdict {
    let win: Vec<&Sample> = ring.iter().copied().filter(|s| s.t_s + p.window_s >= now_s).collect();
    let span_s = match (win.first(), win.last()) {
        (Some(a), Some(b)) => b.t_s - a.t_s,
        _ => 0,
    };
    let trusted = win.len() >= p.min_samples;
    let (fp, fp_late) = if win.len() >= 3 { window_slopes(&win, |s| s.footprint as f64) } else { (0.0, 0.0) };
    let (hp, hp_late) = if win.len() >= 3 { window_slopes(&win, |s| s.heap as f64) } else { (0.0, 0.0) };
    let full = span_s * 100 >= p.window_s * p.full_pct;
    let climbing = |all: f64, late: f64| all >= p.slope_mb_per_h && late >= p.slope_mb_per_h * p.flatten_pct / 100.0;
    let fp_hit = climbing(fp, fp_late);
    let hp_hit = climbing(hp, hp_late);
    let trend = trusted && full && (fp_hit || hp_hit);
    let use_fp = if fp_hit && hp_hit { fp >= hp } else { fp_hit || (!hp_hit && fp >= hp) };
    let (basis, basis_slope, late) =
        if use_fp { (defaults::text("mem.leak_basis_footprint"), fp, fp_late) } else { (defaults::text("mem.leak_basis_heap"), hp, hp_late) };
    let holders = flagged_holders(ring, p);
    let watch_at = p.slope_mb_per_h * p.watch_pct / 100.0;
    let level = if trend || !holders.is_empty() {
        Level::Suspected
    } else if trusted && (fp >= watch_at || hp >= watch_at) {
        Level::Watch
    } else {
        Level::Ok
    };

    // attribution: every holder, the heap no holder claims, and the footprint outside the counted heap
    let mut top = None;
    if win.len() >= 3 {
        let names: BTreeSet<&str> = win.iter().flat_map(|s| s.holders.iter().map(|h| h.name.as_str())).collect();
        let mut cands: Vec<(String, f64)> =
            names.into_iter().map(|n| (n.to_string(), slope_of(win.iter().copied(), |s| holder_bytes(s, n)).unwrap_or(0.0) / MB)).collect();
        cands.push((defaults::text("mem.leak_name_other").to_string(), slope_of(win.iter().copied(), other_bytes).unwrap_or(0.0) / MB));
        cands.push((
            defaults::text("mem.leak_name_outside").to_string(),
            slope_of(win.iter().copied(), |s| s.footprint as f64 - s.heap as f64).unwrap_or(0.0) / MB,
        ));
        let best = if trend || level != Level::Suspected {
            cands.into_iter().max_by(|a, b| a.1.total_cmp(&b.1))
        } else {
            // a holder-only flag: name the flagged holder that grows most
            cands.into_iter().filter(|c| holders.iter().any(|h| h.0 == c.0)).max_by(|a, b| a.1.total_cmp(&b.1))
        };
        top = best.map(|(name, mb_per_h)| {
            let share_pct = if basis_slope > 0.0 { (mb_per_h / basis_slope * 100.0).clamp(0.0, 100.0) } else { 0.0 };
            Top { name, mb_per_h, share_pct }
        });
    }
    Verdict { level, footprint_mb_per_h: fp, heap_mb_per_h: hp, late_mb_per_h: late, basis, samples: win.len(), span_s, trend, holders, top }
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

impl Verdict {
    /// The report as JSON (`status --memory`, the evidence file).
    pub fn to_json(&self) -> Value {
        json!({
            "state": self.level.name(),
            "footprint_mb_per_h": r1(self.footprint_mb_per_h), "heap_mb_per_h": r1(self.heap_mb_per_h), "late_mb_per_h": r1(self.late_mb_per_h),
            "basis": self.basis, "samples": self.samples, "span_s": self.span_s, "trend": self.trend,
            "holders": self.holders.iter().map(|(n, r)| json!({"name": n, "reason": r})).collect::<Vec<_>>(),
            "top": self.top.as_ref().map(|t| json!({"name": t.name, "mb_per_h": r1(t.mb_per_h), "share_pct": r1(t.share_pct)})),
        })
    }
}

struct State {
    ring: VecDeque<Sample>,
    last_sample_s: u64,
    last_notice_s: u64,
    last: Option<Verdict>,
}

static STATE: Mutex<State> = Mutex::new(State { ring: VecDeque::new(), last_sample_s: 0, last_notice_s: 0, last: None });

fn lock() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A notice to post.
#[derive(Debug, Clone)]
pub struct Notice {
    /// The line for the event log and the owner.
    pub text: String,
    /// The top grower's name.
    pub top: String,
}

/// Whether a sample is due: the sentinel is on, warm-up is over and `mem.leak_sample_s` has passed.
pub fn due(uptime_s: u64, now_s: u64) -> bool {
    defaults::raw("mem.leak_enabled").as_bool().unwrap_or(false)
        && uptime_s >= defaults::num("mem.leak_warmup_s")
        && now_s.saturating_sub(lock().last_sample_s) >= defaults::num("mem.leak_sample_s")
}

/// Read the process now.
pub fn collect(now_s: u64) -> Sample {
    let holders = crate::mem::global().snapshot()["holders"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|h| HolderReading {
                    name: h["name"].as_str().unwrap_or_default().to_string(),
                    bytes: h["bytes"].as_u64().unwrap_or(0),
                    soft: h["soft_bytes"].as_u64().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    Sample { t_s: now_s, footprint: crate::limits::mem_kb() * 1024, heap: crate::memstat::heap().live, holders }
}

/// Add `s` to the ring, judge it, and return the notice due (rate-limited by `mem.leak_renotify_s`).
pub fn observe(s: Sample) -> Option<Notice> {
    let now_s = s.t_s;
    let p = Params::from_defaults();
    let mut st = lock();
    st.last_sample_s = now_s;
    st.ring.push_back(s);
    let cap = defaults::num("mem.leak_ring_max") as usize;
    while st.ring.len() > cap {
        st.ring.pop_front();
    }
    let v = {
        let (a, b) = st.ring.as_slices();
        let all: Vec<&Sample> = a.iter().chain(b.iter()).collect();
        evaluate(&all, now_s, &p)
    };
    let again = st.last_notice_s == 0 || now_s.saturating_sub(st.last_notice_s) >= defaults::num("mem.leak_renotify_s");
    let notice = (v.level == Level::Suspected && again).then(|| notice_for(&v, &st.ring));
    if notice.is_some() {
        st.last_notice_s = now_s;
    }
    st.last = Some(v);
    notice
}

fn notice_for(v: &Verdict, ring: &VecDeque<Sample>) -> Notice {
    let last = ring.back();
    let footprint = last.map_or(0, |s| s.footprint) / MB as u64;
    let soft = defaults::num("mem.global_soft_bytes") / MB as u64;
    let top = v.top.as_ref().map_or_else(|| "?".to_string(), |t| t.name.clone());
    let text = if v.trend {
        let hours = format!("{:.1}", v.span_s as f64 / HOUR_S);
        let share = format!("{:.0}%", v.top.as_ref().map_or(0.0, |t| t.share_pct));
        let rate = format!("{:+.1}", v.top.as_ref().map_or(0.0, |t| t.mb_per_h));
        defaults::render(
            "mem.leak_msg_notice",
            &[("top", &top), ("mb_per_h", &rate), ("hours", &hours), ("footprint", &footprint), ("soft", &soft), ("share", &share), ("basis", &v.basis)],
        )
    } else {
        let reason = v.holders.first().map_or("", |h| h.1);
        defaults::render("mem.leak_msg_holder_notice", &[("top", &top), ("reason", &reason), ("footprint", &footprint), ("soft", &soft)])
    };
    Notice { text, top }
}

/// The ring and the last verdict as JSON, for the evidence file.
pub fn evidence() -> Value {
    let st = lock();
    let ring: Vec<Value> = st
        .ring
        .iter()
        .map(|s| {
            let h: BTreeMap<&str, u64> = s.holders.iter().map(|h| (h.name.as_str(), h.bytes)).collect();
            json!({"t": s.t_s, "footprint": s.footprint, "heap": s.heap, "holders": h})
        })
        .collect();
    json!({"ring": ring, "verdict": st.last.as_ref().map(Verdict::to_json)})
}

/// Write `<state>/<mem.leak_dir>/leak-<ts>.json` with the ring, the verdict and `memory` (the full `status --memory` report).
pub fn write_evidence(memory: Value, ts_ms: u64) -> std::io::Result<PathBuf> {
    let dir = crate::paths::dir().join(defaults::text("mem.leak_dir"));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("leak-{ts_ms}.json"));
    let mut doc = evidence();
    doc["ts_ms"] = json!(ts_ms);
    doc["memory"] = memory;
    crate::atomic::write(&path, serde_json::to_vec_pretty(&doc).unwrap_or_default())?;
    Ok(path)
}

/// The `leak` section of `status --memory` and the pulse: state, slope and top grower.
pub fn status() -> Value {
    let st = lock();
    let enabled = defaults::raw("mem.leak_enabled").as_bool().unwrap_or(false);
    match &st.last {
        Some(v) => {
            let mut j = v.to_json();
            j["enabled"] = json!(enabled);
            j["last_notice_s"] = json!(st.last_notice_s);
            j["slope_mb_per_h"] = json!(r1(if v.basis == defaults::text("mem.leak_basis_heap") { v.heap_mb_per_h } else { v.footprint_mb_per_h }));
            j
        }
        None => json!({"enabled": enabled, "state": Level::Ok.name(), "samples": 0, "slope_mb_per_h": 0.0, "top": null, "holders": [], "warming_up": true}),
    }
}
