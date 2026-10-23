//! The daemon's resource budgets (CPU and memory), checked by the watchdog and reported in `status`, the `daemon` health event and
//! the health log.
//!
//! The limits are `diagnostics.budget_cpu_pct`, `diagnostics.budget_cpu_windows` and `diagnostics.budget_mem_mb`. CPU is the
//! percent of one core over each `daemon.cpu_check_ms` window; it breaches after `budget_cpu_windows` windows in a row at or above
//! the limit (one busy window is a burst). Memory is the figure `daemon.mem_metric` selects, and it breaches while over the limit.
//! A budget of 0 is off. Reporting only: a breach never stops or slows anything (the RSS cap and the CPU back-off are other rules).
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};

/// The daemon is past its HARD CPU limit and sheds optional work (`diagnostics.budget_cpu_hard_pct`). Process-wide so the check
/// dispatcher and the Jev client read it without a lock.
static SHEDDING: AtomicBool = AtomicBool::new(false);
/// Optional work skipped while shedding (checks of non-guard events, Jev consultations).
static SHED_SKIPPED: AtomicU64 = AtomicU64::new(0);

/// True while the hard CPU limit is crossed: optional work (advisory checks, Jev, background duties) waits.
pub fn shedding() -> bool {
    SHEDDING.load(Relaxed)
}

/// Count one piece of optional work that was skipped because of [`shedding`].
pub fn note_shed_skipped() {
    SHED_SKIPPED.fetch_add(1, Relaxed);
}

/// Answers a request's checks did not give, by `guard|optional` + reason, for THIS daemon (the lifetime counts are the
/// `answers_dropped` metric, which survives restarts); and the last event-log line per check and reason.
static DROPPED: std::sync::Mutex<BTreeMap<String, u64>> = std::sync::Mutex::new(BTreeMap::new());
static DROPPED_LOGGED: std::sync::Mutex<BTreeMap<String, u64>> = std::sync::Mutex::new(BTreeMap::new());

/// A check of `event` gave no answer, for `reason`: counted (this daemon and lifetime), and logged at most once per
/// `diagnostics.abandoned_log_interval_ms` per check and reason. A guard event's drop is its own kind (`guard_answer_dropped`) so it
/// stands out; the dispatcher then applies the check's failure policy (`script.failure_mode_by_check`).
pub fn note_dropped(guard: bool, check: &str, event: &str, reason: &str) {
    let kind = if guard { crate::defaults::text("answer_drop.kind_guard") } else { crate::defaults::text("answer_drop.kind_optional") };
    crate::metrics::bump("answers_dropped", &[("event", event), ("kind", kind), ("reason", reason)]);
    let mut m = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    if m.len() < crate::defaults::num("answer_drop.dropped_keys_max") as usize || m.contains_key(&format!("{kind}:{reason}")) {
        *m.entry(format!("{kind}:{reason}")).or_default() += 1;
    }
    drop(m);
    let (now, every) = (crate::health::now_ms(), crate::defaults::num("diagnostics.abandoned_log_interval_ms"));
    let mut seen = DROPPED_LOGGED.lock().unwrap_or_else(|e| e.into_inner());
    let key = format!("{check}:{reason}");
    if seen.len() >= crate::defaults::num("diagnostics.abandoned_log_keys_max") as usize {
        seen.clear();
    }
    if seen.get(&key).is_some_and(|last| now.saturating_sub(*last) < every) {
        return;
    }
    seen.insert(key, now);
    drop(seen);
    let line = if guard { "guard_answer_dropped" } else { "answer_dropped" };
    crate::health::log_event(line, check, &crate::defaults::render("msg.log_answer_dropped", &[("check", &check), ("event", &event), ("reason", &reason)]));
}

/// This daemon's dropped answers: `{guard: n, optional: n, by_reason: {"guard:cpu_budget": n, ...}}`.
pub fn dropped_this_daemon() -> Value {
    let m = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let sum = |kind: &str| m.iter().filter(|(k, _)| k.starts_with(&format!("{kind}:"))).map(|(_, v)| *v).sum::<u64>();
    json!({ "guard": sum(crate::defaults::text("answer_drop.kind_guard")), "optional": sum(crate::defaults::text("answer_drop.kind_optional")), "by_reason": *m })
}

/// Which budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    /// CPU, percent of one core.
    Cpu,
    /// Memory, MB.
    Mem,
}

impl Which {
    /// The name in logs and in `status`.
    pub fn name(self) -> &'static str {
        match self {
            Which::Cpu => "cpu",
            Which::Mem => "mem",
        }
    }
}

/// The budget state the watchdog updates.
#[derive(Debug, Default)]
pub struct State {
    /// CPU % of one core over the last window.
    cpu_pct: f64,
    /// Consecutive windows at or above the CPU budget.
    over_windows: u64,
    /// Memory in KB at the last sample.
    mem_kb: u64,
    /// The CPU budget is breached now.
    cpu_breached: bool,
    /// The memory budget is breached now.
    mem_breached: bool,
    /// Breaches begun since start (a breach that clears and returns counts twice).
    breaches: u64,
    /// Consecutive windows at or above the hard CPU limit.
    hard_over_windows: u64,
    /// The hard CPU limit in force at the last window (percent, 0 = off).
    hard_limit_pct: u64,
    /// Times shedding began since start.
    hard_breaches: u64,
}

/// A breach that began or ended: `(which, began)`.
pub type Edge = Option<(Which, bool)>;

impl State {
    fn set(&mut self, which: Which, on: bool) -> Edge {
        let slot = match which {
            Which::Cpu => &mut self.cpu_breached,
            Which::Mem => &mut self.mem_breached,
        };
        if *slot == on {
            return None;
        }
        *slot = on;
        if on {
            self.breaches += 1;
        }
        Some((which, on))
    }

    /// One CPU window of `pct` percent of one core against the budget (`limit_pct` 0 = off, `windows` in a row to breach).
    pub fn cpu_window(&mut self, pct: f64, limit_pct: u64, windows: u64) -> Edge {
        self.cpu_pct = pct;
        if limit_pct == 0 {
            self.over_windows = 0;
            return self.set(Which::Cpu, false);
        }
        self.over_windows = if pct >= limit_pct as f64 { self.over_windows + 1 } else { 0 };
        self.set(Which::Cpu, self.over_windows >= windows.max(1))
    }

    /// One CPU window of `pct` against the HARD limit (`hard_pct` 0 = off, `windows` in a row to cross it). Shedding ends on the first
    /// window under `soft_pct` (the hard limit when the soft bar is off). `Some(true)` shedding began, `Some(false)` it ended.
    pub fn cpu_hard_window(&mut self, pct: f64, hard_pct: u64, soft_pct: u64, windows: u64) -> Option<bool> {
        self.hard_limit_pct = hard_pct;
        let now = SHEDDING.load(Relaxed);
        if hard_pct == 0 {
            self.hard_over_windows = 0;
            SHEDDING.store(false, Relaxed);
            return now.then_some(false);
        }
        self.hard_over_windows = if pct >= hard_pct as f64 { self.hard_over_windows + 1 } else { 0 };
        let recover_below = if soft_pct > 0 { soft_pct } else { hard_pct } as f64;
        if !now && self.hard_over_windows >= windows.max(1) {
            self.hard_breaches += 1;
            SHEDDING.store(true, Relaxed);
            return Some(true);
        }
        if now && pct < recover_below {
            SHEDDING.store(false, Relaxed);
            return Some(false);
        }
        None
    }

    /// One memory sample of `mem_kb` against the budget (`limit_mb` 0 = off).
    pub fn mem_sample(&mut self, mem_kb: u64, limit_mb: u64) -> Edge {
        self.mem_kb = mem_kb;
        self.set(Which::Mem, limit_mb != 0 && mem_kb > limit_mb.saturating_mul(1024))
    }

    /// The breach mask for the health event: bit 0 CPU, bit 1 memory.
    pub fn mask(&self) -> u64 {
        u64::from(self.cpu_breached) | (u64::from(self.mem_breached) << 1)
    }

    /// CPU over the last window, in permille of one core (the health event carries integers).
    pub fn cpu_permille(&self) -> u64 {
        (self.cpu_pct * 10.0).round().max(0.0) as u64
    }

    /// The report for `status`, with the budgets now in force.
    pub fn report(&self, cpu_budget_pct: u64, mem_budget_mb: u64) -> Value {
        let breached: Vec<&str> =
            [(self.cpu_breached, Which::Cpu), (self.mem_breached, Which::Mem)].into_iter().filter(|(on, _)| *on).map(|(_, w)| w.name()).collect();
        json!({
            "cpu_pct": (self.cpu_pct * 100.0).round() / 100.0,
            "cpu_budget_pct": cpu_budget_pct,
            "cpu_over_windows": self.over_windows,
            "mem_mb": self.mem_kb / 1024,
            "mem_budget_mb": mem_budget_mb,
            "breached": breached,
            "breaches": self.breaches,
            "cpu_hard_budget_pct": self.hard_limit_pct,
            "shedding": shedding(),
            "cpu_hard_breaches": self.hard_breaches,
            "shed_skipped": SHED_SKIPPED.load(Relaxed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_breaches_after_consecutive_windows_and_clears_on_one_quiet_window() {
        let mut s = State::default();
        assert_eq!(s.cpu_window(5.0, 2, 2), None, "one busy window is a burst");
        assert_eq!(s.cpu_window(5.0, 2, 2), Some((Which::Cpu, true)));
        assert_eq!(s.cpu_window(9.0, 2, 2), None, "already breached: no second event");
        assert_eq!(s.mask(), 1);
        assert_eq!(s.cpu_window(0.5, 2, 2), Some((Which::Cpu, false)));
        assert_eq!(s.cpu_window(5.0, 2, 2), None, "the count restarted");
        assert_eq!(s.report(2, 100)["breaches"], 1);
    }

    #[test]
    fn memory_breaches_while_over_and_a_zero_budget_is_off() {
        let mut s = State::default();
        assert_eq!(s.mem_sample(100 * 1024, 100), None, "at the limit is within it");
        assert_eq!(s.mem_sample(100 * 1024 + 1, 100), Some((Which::Mem, true)));
        assert_eq!(s.mask(), 2);
        assert_eq!(s.mem_sample(90 * 1024, 100), Some((Which::Mem, false)));
        assert_eq!(s.mem_sample(900 * 1024, 0), None, "0 turns the budget off");
        assert_eq!(s.cpu_window(500.0, 0, 1), None);
        assert_eq!(s.mask(), 0);
    }

    #[test]
    fn the_report_names_the_breached_budgets() {
        let mut s = State::default();
        s.cpu_window(7.25, 2, 1);
        s.mem_sample(200 * 1024, 100);
        let r = s.report(2, 100);
        assert_eq!(r["breached"], json!(["cpu", "mem"]));
        assert_eq!(r["mem_mb"], 200);
        assert_eq!(s.cpu_permille(), 73);
    }
}
