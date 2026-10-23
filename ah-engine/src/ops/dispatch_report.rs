//! `ah-engine dispatch-report [--json]`: read-only effectiveness metrics of the parallel-dispatch demand, the Jev dispatch tier and
//! the coordinator-work window. Port of `scripts/dispatch-report.js` (with the `summary` functions of `hooks/lib/dispatch-demand.js`,
//! `dispatch-tier.js` and `coordinator-work.js`). The command reads the metrics files and the live session files and asks the rules
//! script (`rules/operator-cli.js`, `dispatchReportRun`) for the summaries and the text.
use super::{env_snapshot, home, opcli_call, opcli_cfg, out, read_lossy};
use crate::cli::Parsed;
use crate::defaults;
use serde_json::json;
use std::path::PathBuf;

pub(crate) fn run(p: &Parsed) -> i32 {
    let base = PathBuf::from(home(&env_snapshot())).join(defaults::text("paths.base_dir"));
    let text_of = |key: &str| read_lossy(&base.join(defaults::text(key)));
    let mut sessions: Vec<String> = Vec::new();
    if let (Ok(re), Ok(rd)) = (regex::Regex::new(defaults::text("opcli.dr_cw_session_re")), std::fs::read_dir(&base)) {
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| re.is_match(n)).collect();
        names.sort();
        sessions = names.iter().filter_map(|n| read_lossy(&base.join(n))).collect();
    }
    let input = json!({
        "json": p.raw.iter().any(|a| a == defaults::text("opcli.dr_json_flag")),
        "demandText": text_of("opcli.dr_demand_file"), "metricsText": text_of("opcli.dr_cw_metrics_file"), "sessionTexts": sessions,
        "cfg": opcli_cfg(),
    });
    let Some(r) = opcli_call("dispatch-report", defaults::text("opcli.rules_script"), "dispatchReportRun", &input) else {
        return defaults::num("opcli.fail_exit") as i32;
    };
    out(r.get("text").and_then(|t| t.as_str()).unwrap_or_default());
    0
}
