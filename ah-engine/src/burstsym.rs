//! `ah-engine diag burst-dump [--symbolize [<dump>]]`: list the burst dumps, or turn the addresses of one into function names.
//!
//! A shipped binary is stripped, so a dump (see [`crate::burst`]) holds the image and the offset of every frame whose name is not in
//! the binary. The symbols of that exact build live apart from it (a dSYM, a debug file); the dump names the build by its Mach-O
//! `LC_UUID` / ELF build-id. This module finds a symbol file for that id (beside the binary the dump names, in the sidecar
//! directory `files.symbols_dir`, or anywhere under it), CHECKS the file's own id against the dump's (a wrong build gives wrong
//! names, so a name is never trusted), and runs the platform's resolver (`atos`, `addr2line`; the commands are settings) over the
//! unresolved frames. Read-only: nothing is written or deleted.
use crate::{buildid, defaults, paths};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The report for `diag burst-dump <args>`.
pub fn run(args: &[String]) -> Value {
    let flag = defaults::text("diagnostics.symbolize_flag");
    match args.iter().position(|a| a == flag) {
        None => list(),
        Some(i) => symbolize(args.get(i + 1).map(String::as_str)),
    }
}

fn dumps_dir() -> PathBuf {
    crate::burst::dump_dir()
}

static SYMBOLS_OVERRIDE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Test seam: look for sidecar symbol files here instead of in the state directory.
pub fn set_symbols_dir(dir: Option<PathBuf>) {
    *SYMBOLS_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = dir;
}

/// Where the sidecar symbol files are kept (`<state>/<files.symbols_dir>/<build id>/`).
pub fn symbols_dir() -> PathBuf {
    SYMBOLS_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| paths::dir().join(defaults::text("files.symbols_dir")))
}

/// The dump files, newest first: (path, modified).
fn dump_files(dir: &Path) -> Vec<(PathBuf, std::time::SystemTime)> {
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == defaults::text("diagnostics.burst_dump_ext")))
                .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
                .collect()
        })
        .unwrap_or_default();
    v.sort_by_key(|a| std::cmp::Reverse(a.1));
    v
}

fn list() -> Value {
    let dir = dumps_dir();
    let me = crate::burst::identity();
    let id = me["build_id"].as_str();
    let rows: Vec<Value> = dump_files(&dir)
        .iter()
        .map(|(p, m)| {
            let doc: Option<Value> = std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok());
            let b = doc.as_ref().map_or(Value::Null, |d| d["build"].clone());
            json!({
                "file": p.display().to_string(), "age_s": m.elapsed().map_or(0, |d| d.as_secs()),
                "event": doc.as_ref().map(|d| d["event"].clone()), "growth_bytes": doc.as_ref().map(|d| d["trigger"]["growth_bytes"].clone()),
                "version": b["version"], "build_id": b["build_id"],
            })
        })
        .collect();
    json!({
        "dumps_dir": dir.display().to_string(), "dumps": rows, "this_binary": me,
        "symbols_found": id.and_then(|i| locate(i, me["exe"].as_str())).map(|p| p.display().to_string()),
        "symbols_dir": symbols_dir().display().to_string(),
        "how": defaults::render("diagnostics.msg_symbolize_how", &[("flag", &defaults::text("diagnostics.symbolize_flag"))]),
    })
}

/// The image inside a symbol file candidate: a dSYM bundle's DWARF file, or the file itself.
fn image_of(candidate: &Path) -> Option<PathBuf> {
    if candidate.is_dir() {
        let dwarf = candidate.join(defaults::text("diagnostics.symbols_dsym_dwarf"));
        return std::fs::read_dir(dwarf).ok()?.flatten().map(|e| e.path()).find(|p| p.is_file());
    }
    candidate.is_file().then(|| candidate.to_path_buf())
}

/// True when `candidate` carries the id `want`.
fn matches(candidate: &Path, want: &str) -> bool {
    image_of(candidate).and_then(|i| buildid::of_file(&i)).is_some_and(|b| buildid::normalize(&b.id) == buildid::normalize(want))
}

/// Symbol files under `dir` (its `suffixes`-named entries), looking `depth` directories down; at most `max` entries are visited.
fn scan(dir: &Path, depth: u64, suffixes: &[&str], seen: &mut u64, max: u64, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        *seen += 1;
        if *seen > max {
            return;
        }
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if suffixes.iter().any(|s| name.ends_with(s)) {
            out.push(p);
        } else if depth > 0 && p.is_dir() {
            scan(&p, depth - 1, suffixes, seen, max, out);
        }
    }
}

/// The symbol file of build `id`: beside the binary the dump names, then in `<symbols dir>/<id>/`, then anywhere under the symbols
/// directory (so a downloaded release symbol archive works wherever it was unpacked). Each candidate is verified by its own id.
pub fn locate(id: &str, exe: Option<&str>) -> Option<PathBuf> {
    let suffixes = defaults::list("diagnostics.symbols_suffixes");
    let mut cands: Vec<PathBuf> = exe.map(|e| suffixes.iter().map(|s| PathBuf::from(format!("{e}{s}"))).collect()).unwrap_or_default();
    let root = symbols_dir();
    scan(&root.join(id), 1, &suffixes, &mut 0, defaults::num("diagnostics.symbols_scan_max"), &mut cands);
    scan(&root, defaults::num("diagnostics.symbols_scan_depth"), &suffixes, &mut 0, defaults::num("diagnostics.symbols_scan_max"), &mut cands);
    cands.into_iter().find(|c| matches(c, id))
}

fn symbolize(file: Option<&str>) -> Value {
    let path = match file {
        Some(f) => PathBuf::from(f),
        None => match dump_files(&dumps_dir()).into_iter().next() {
            Some((p, _)) => p,
            None => return json!({"error": defaults::render("diagnostics.msg_symbolize_no_dump", &[("dir", &dumps_dir().display())])}),
        },
    };
    let Some(doc) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return json!({"error": defaults::render("diagnostics.msg_symbolize_bad_dump", &[("file", &path.display())])});
    };
    let build = doc["build"].clone();
    let (id, exe) = (build["build_id"].as_str(), build["exe"].as_str());
    let found = id.and_then(|i| locate(i, exe));
    let mut doc = doc;
    let Some(sym) = found else {
        let hint = defaults::render(
            "diagnostics.msg_symbolize_no_symbols",
            &[("id", &id.unwrap_or("none")), ("version", &build["version"].as_str().unwrap_or("?")), ("dir", &symbols_dir().display())],
        );
        return json!({"file": path.display().to_string(), "build": build, "symbols": null, "hint": hint});
    };
    let Some(image) = image_of(&sym) else { return json!({"error": defaults::render("diagnostics.msg_symbolize_unreadable", &[("file", &sym.display())])}) };
    // the unresolved frames of this build's own binary: (ip, offset) as numbers
    let base = hex(&build["image_base"]);
    let mut want: Vec<(u64, u64)> = Vec::new();
    for site in doc["sites"].as_array().into_iter().flatten() {
        for f in site["frames"].as_array().into_iter().flatten() {
            if f["function"].is_null()
                && base.is_some()
                && hex(&f["image_base"]) == base
                && let (Some(ip), Some(off)) = (hex(&f["ip"]), hex(&f["offset"]))
            {
                // the call site is the byte before the return address, as the dump's own lookup takes it
                let site = (ip.saturating_sub(1), off.saturating_sub(1));
                if !want.contains(&site) {
                    want.push(site);
                }
            }
        }
    }
    let lines = resolve(&image, &build, &want);
    let mut resolved = 0u64;
    if let Some(sites) = doc["sites"].as_array_mut() {
        for site in sites {
            for f in site["frames"].as_array_mut().into_iter().flatten() {
                if f["function"].is_null()
                    && hex(&f["image_base"]) == base
                    && let Some(ip) = hex(&f["ip"]).map(|v| v.saturating_sub(1))
                    && let Some(l) = lines.as_ref().ok().and_then(|m| m.get(&ip))
                {
                    f["resolved"] = json!(l);
                    resolved += 1;
                }
            }
        }
    }
    let mut out =
        json!({"file": path.display().to_string(), "build": build, "symbols": sym.display().to_string(), "resolved_frames": resolved, "sites": doc["sites"]});
    if let Err(e) = lines {
        out["error"] = json!(e);
    }
    out
}

fn hex(v: &Value) -> Option<u64> {
    u64::from_str_radix(v.as_str()?.trim_start_matches("0x"), 16).ok()
}

/// Run the platform's resolver over `addrs` (call-site ip, offset into the image): one output line per address, keyed by ip.
fn resolve(image: &Path, build: &Value, addrs: &[(u64, u64)]) -> Result<std::collections::BTreeMap<u64, String>, String> {
    let os = build["os"].as_str().unwrap_or(std::env::consts::OS);
    // literal keys, one per platform (a key built with format! is invisible to the defaults-keys scan)
    let tpl = match os {
        "macos" => defaults::list("diagnostics.symbolize_cmd_macos"),
        "linux" => defaults::list("diagnostics.symbolize_cmd_linux"),
        _ => Vec::new(),
    };
    let Some((program, rest)) = tpl.split_first() else { return Err(defaults::render("diagnostics.msg_symbolize_no_tool", &[("os", &os)])) };
    if addrs.is_empty() {
        return Ok(std::collections::BTreeMap::new());
    }
    let arch = build["arch"].as_str().unwrap_or(std::env::consts::ARCH);
    let arch = defaults::list("diagnostics.symbolize_arch").iter().find_map(|p| p.split_once('=').filter(|(k, _)| *k == arch).map(|(_, v)| v)).unwrap_or(arch);
    let base = build["image_base"].as_str().unwrap_or("0x0");
    let mut cmd = std::process::Command::new(program);
    for a in rest {
        match *a {
            "{ips}" => {
                cmd.args(addrs.iter().map(|(ip, _)| format!("{ip:#x}")));
            }
            "{offsets}" => {
                cmd.args(addrs.iter().map(|(_, off)| format!("{off:#x}")));
            }
            other => {
                cmd.arg(other.replace("{file}", &image.display().to_string()).replace("{base}", base).replace("{arch}", arch));
            }
        }
    }
    let out = crate::proc::run(cmd, program, defaults::millis("diagnostics.symbolize_ms"), defaults::millis("health.probe_poll_ms"))
        .map_err(|e| defaults::render("diagnostics.msg_symbolize_failed", &[("tool", program), ("err", &format!("{e:?}"))]))?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(addrs.iter().zip(text.lines()).map(|((ip, _), l)| (*ip, l.trim().to_string())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_reads_the_dump_notation() {
        assert_eq!(hex(&json!("0x1f")), Some(31));
        assert_eq!(hex(&json!(null)), None);
    }

    #[test]
    fn a_candidate_with_another_builds_id_is_not_a_match() {
        let exe = std::env::current_exe().expect("exe");
        let own = buildid::of_file(&exe);
        if let Some(own) = own {
            assert!(matches(&exe, &own.id), "a file matches its own id");
            assert!(!matches(&exe, "00000000-0000-0000-0000-000000000000"), "another id never matches");
        }
    }
}
