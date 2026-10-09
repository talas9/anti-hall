//! The Node witness of the native drain. Node never reads the live queue or the live store: the engine keeps a MIRROR of what it
//! drained (the raw bytes of each batch, the import time, and the rows it wrote) and, at most every
//! `devswarm_ingest.witness_every_ms`, runs Node's own `ingestPayload` over the mirrored batches against an empty scratch store in
//! a scratch HOME, then compares per batch: the message count, whether it was lossy, and every row's hash, time and body. It also
//! checks the other direction on the live store: every mirrored row is there, with the same time and body (a loss check). Every
//! comparison is one line of `devswarm_ingest.witness_file`; the scratch tree is removed afterwards.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - the witness is advisory: a mirror write that fails only loses a comparison, never changes what the drain did
use super::drain::Project;
use super::import::Imported;
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner};
use crate::meshw::store::MeshStore;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The mirror file of one project.
pub struct Mirror {
    path: PathBuf,
    home: PathBuf,
    last_run: i64,
}

fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

impl Mirror {
    /// The mirror of `repo_key` under `home` (created on first record).
    pub fn open(home: &Path, repo_key: &str) -> Option<Mirror> {
        Some(Mirror {
            path: home.join(defaults::text("devswarm_sup.witness_dir")).join(format!(
                "{}{repo_key}{}",
                defaults::text("devswarm_ingest.witness_prefix"),
                defaults::text("devswarm_ingest.ndjson_suffix")
            )),
            home: home.to_path_buf(),
            last_run: crate::health::now_ms() as i64,
        })
    }

    /// Mirror one imported batch (only batches that carry messages or were lossy; quiet polls say nothing).
    pub fn record(&mut self, raw: &str, now: i64, ing: &Imported) {
        if ing.total == 0 && !ing.lossy {
            return;
        }
        if std::fs::metadata(&self.path).is_ok_and(|m| m.len() >= defaults::num("devswarm_ingest.witness_max_bytes")) {
            return; // full: nothing more is mirrored until a comparison consumes the file
        }
        let rows: Vec<String> = ing.rows.iter().map(|r| format!("{{\"hash\":{},\"ts\":{},\"body\":{}}}", q(&r.hash), r.ts, q(&r.body))).collect();
        let line = format!("{{\"now\":{now},\"total\":{},\"lossy\":{},\"raw\":{},\"rows\":[{}]}}\n", ing.total, ing.lossy, q(raw), rows.join(","));
        if let Some(d) = self.path.parent() {
            crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the witness is advisory
        }
        crate::discard::harmless(
            std::fs::OpenOptions::new().append(true).create(true).open(&self.path).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes())),
        ); // keep: same
    }

    /// Whether a comparison is due (interval passed and something is mirrored).
    pub fn due(&self, now: i64) -> bool {
        now - self.last_run >= defaults::num("devswarm_ingest.witness_every_ms") as i64 && std::fs::metadata(&self.path).is_ok_and(|m| m.len() > 0)
    }

    /// Run Node's `ingestPayload` over the mirror in a scratch HOME and compare; log the result; consume the mirror.
    pub fn compare(&mut self, runner: &dyn Runner, root: &Path, store: &MeshStore, project: &Project, now: i64) -> Option<Value> {
        let (ws, repo_key, worktree) = (project.workspace_id.as_str(), project.repo_key.as_str(), project.worktree.as_str());
        self.last_run = now;
        let text = std::fs::read_to_string(&self.path).ok()?;
        let lines: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        if lines.is_empty() {
            return None;
        }
        let scratch = self.home.join(defaults::text("devswarm_sup.witness_dir")).join(format!(
            "{}{now}-{}",
            defaults::text("devswarm_ingest.witness_scratch"),
            std::process::id()
        ));
        std::fs::create_dir_all(&scratch).ok()?;
        let args: Vec<String> = defaults::list("devswarm_sup.node_args")
            .iter()
            .map(|s| (*s).to_string())
            .chain([defaults::text("devswarm_ingest.witness_snippet").to_string(), root.to_string_lossy().into_owned(), scratch.to_string_lossy().into_owned()])
            .chain([ws.to_string(), repo_key.to_string(), self.path.to_string_lossy().into_owned(), worktree.to_string()])
            .collect();
        let r = runner.run(&RunSpec {
            bin: Some(defaults::text("devswarm_sup.node_bin").to_string()),
            args,
            timeout_ms: defaults::num("devswarm_ingest.witness_timeout_ms"),
            cap_bytes: defaults::num("devswarm_ingest.output_cap_bytes"),
            ..RunSpec::default()
        });
        let mut rec = if r.ok {
            let theirs: Vec<Value> = r.stdout.lines().rev().find(|l| !l.trim().is_empty()).and_then(|l| serde_json::from_str(l).ok()).unwrap_or_default();
            let mut diffs: Vec<Value> = Vec::new();
            if theirs.len() != lines.len() {
                diffs.push(json!({"what": "batches", "engine": lines.len(), "node": theirs.len()}));
            }
            for (i, (mine, node)) in lines.iter().zip(theirs.iter()).enumerate() {
                if mine["total"] != node["total"] || mine["lossy"] != node["lossy"] || mine["rows"] != node["rows"] {
                    diffs.push(
                        json!({"what": "batch", "index": i, "engine": {"total": mine["total"], "lossy": mine["lossy"], "rows": mine["rows"]}, "node": node}),
                    );
                }
            }
            // the other direction: every row the engine says it wrote is in the live store with that time and body
            let mut missing = 0;
            for l in &lines {
                for row in l["rows"].as_array().into_iter().flatten() {
                    let found = store.message_by_hash(row["hash"].as_str().unwrap_or_default()).ok().flatten();
                    if found.as_ref().map(|(w, t, b)| (w.as_str(), *t, b.as_str()))
                        != Some((ws, row["ts"].as_i64().unwrap_or(0), row["body"].as_str().unwrap_or_default()))
                    {
                        missing += 1;
                    }
                }
            }
            if missing > 0 {
                diffs.push(json!({"what": "store", "missingOrDifferent": missing}));
            }
            json!({"project": repo_key, "match": diffs.is_empty(), "batches": lines.len(), "diffs": diffs})
        } else {
            json!({"project": repo_key, "match": Value::Null, "error": r.error.unwrap_or_else(|| r.stderr.chars().take(defaults::num("devswarm_sup.detail_chars") as usize).collect())})
        };
        rec["ts"] = json!(now);
        crate::dsact::exec::append_line(&self.home.join(defaults::text("devswarm_ingest.witness_file")), &rec);
        crate::discard::harmless(std::fs::remove_dir_all(&scratch)); // keep: the engine's own scratch store
        crate::discard::harmless(std::fs::remove_file(&self.path)); // keep: the engine's own mirror, consumed by this comparison
        Some(rec)
    }
}
