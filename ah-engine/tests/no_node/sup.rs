//! The DevSwarm supervisor duties (`devswarm_supervisor`, one tick of `src/dssup`) run with no Node on PATH, over a minimal
//! DevSwarm fixture. Each Node start the tick makes is attributed to the duty whose snippet it ran (`sup/<duty>`), and the
//! duties the tick did not start are reported with their outcome. The expected-failure list is the backlog: a duty that still
//! needs Node is listed under its surface; a lane that makes it Node-free deletes the entry.

use crate::expected;
use crate::harness::{Seen, World, cfg_int, cfg_list, cfg_str, note};

use std::time::Duration;

/// The fixture: one workspace descriptor under the DevSwarm state directory (what makes the engine treat DevSwarm as present).
fn devswarm_fixture(w: &World, cfg: &toml::Table) {
    let dir = w.home.join(cfg_str(cfg, "sup", "workspaces_dir"));
    std::fs::create_dir_all(&dir).unwrap();
    let id = cfg_str(cfg, "sup", "workspace_id");
    let body = cfg_str(cfg, "sup", "descriptor").replace("{id}", &id).replace("{cwd}", &w.project.to_string_lossy());
    std::fs::write(dir.join(format!("{id}.json")), body).unwrap();
}

/// Which duty a recorded Node argv ran: the duty whose snippet (or witness snippet) the argv contains.
fn duty_of(w: &World, argv: &str) -> String {
    let defaults = std::fs::read_to_string(w.plugin.join("engine/defaults/devswarm_sup.toml")).unwrap();
    let t: toml::Table = defaults.parse().unwrap();
    let flat = |s: &str| s.split_whitespace().collect::<String>();
    let argv = flat(argv);
    let sup = t.get("devswarm_sup").and_then(|v| v.as_table()).unwrap();
    for (key, v) in sup {
        let Some(name) = key.strip_prefix("duty.") else { continue };
        for field in ["snippet", "witness_snippet"] {
            let snippet = v.get("value").and_then(|x| x.get(field)).and_then(|x| x.as_str());
            if snippet.is_some_and(|s| argv.contains(&flat(s))) {
                return name.to_string();
            }
        }
    }
    "unattributed".to_string()
}

/// The Node function a duty's snippet calls (`reconcileSweepIfDue`), the key of its expected entry.
fn function_key(argv: &str) -> String {
    let re = regex::Regex::new(r"\b[A-Z]\.(\w+)\(").unwrap();
    re.captures(argv).map_or_else(|| "node-snippet".to_string(), |c| format!("companion/devswarm-supervisor.js#{}", &c[1]))
}

/// Every supervisor duty runs with no Node installed: whichever still starts Node is on the expected list.
#[test]
fn the_supervisor_duties_run_without_node() {
    let list = expected::load();
    let mut w = World::new("sup");
    let cfg = w.cfg.clone();
    devswarm_fixture(&w, &cfg);
    w.start_daemon();
    let timeout = Duration::from_secs(cfg_int(&cfg, "timeouts", "callsite_s"));
    let mut cmd = w.command(&w.engine, "sup/tick");
    cmd.args(["schedule", "run", &cfg_str(&cfg, "sup", "job")]);
    let o = w.run(cmd, None, timeout);
    w.settle();
    let mut seen = Seen::new();
    for h in w.hits_of("sup/tick") {
        note(&mut seen, &format!("sup/{}", duty_of(&w, &h.argv)), &function_key(&h.argv), "sup/tick");
    }
    let mut problems = expected::compare(&list, "sup/", &seen);
    if o.code != Some(0) {
        problems.push(format!("`ah-engine schedule run {}` exited {:?}: {}", cfg_str(&cfg, "sup", "job"), o.code, o.stderr.trim()));
    }
    let duties = cfg_list(&cfg, "sup", "duties");
    for d in &duties {
        if !o.stdout.contains(&format!("\"duty\":\"{d}\"")) && !o.stdout.contains(&format!("\"duty\": \"{d}\"")) {
            problems.push(format!("the tick did not report the duty `{d}`: {}", o.stdout.chars().take(400).collect::<String>()));
        }
    }
    expected::finish("sup", serde_json::json!({"tick": o.stdout, "node_paths": expected::seen_json(&seen)}), &problems);
}

/// The machine's installed DevSwarm app is ignored (its `hivecontrol` location is emptied in the plugin copy), but the probe of a
/// hivecontrol found some other way is NOT: a controlled fixture `hivecontrol` that execs Node, saved where the engine looks for
/// the user's own, is still probed under the simulated absence and its Node start is recorded, so the harness would fail on it.
#[test]
fn a_hivecontrol_that_needs_node_is_still_caught_under_the_simulated_absence() {
    let mut w = World::new("sup-neg");
    let cfg = w.cfg.clone();
    for key in cfg_list(&cfg, "absent", "settings") {
        for dir in ["engine/defaults", "engine/defaults.pristine"] {
            let Ok(rd) = std::fs::read_dir(w.plugin.join(dir)) else { continue };
            for e in rd.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "toml")) {
                let text = std::fs::read_to_string(e.path()).unwrap();
                let Some(at) = text.lines().position(|l| l.trim() == format!("[{key}]")) else { continue };
                let value = text.lines().skip(at + 1).take_while(|l| !l.starts_with('[')).find(|l| l.starts_with("value =")).unwrap();
                assert_eq!(value, "value = []", "{key} is emptied in the plugin copy ({})", e.path().display());
            }
        }
    }
    let src = std::fs::read_to_string(crate::harness::plugin_src().join("engine/defaults/mesh_write.toml")).unwrap();
    let at = src.lines().position(|l| l.trim() == "[mesh_write.hivecontrol_known_locations]").unwrap();
    let kept = src.lines().skip(at + 1).take_while(|l| !l.starts_with('[')).find(|l| l.starts_with("value =")).unwrap();
    assert_ne!(kept, "value = []", "the checkout itself keeps the app location; only the harness copy is emptied");

    devswarm_fixture(&w, &cfg);
    let timeout = Duration::from_secs(cfg_int(&cfg, "timeouts", "callsite_s"));
    // control: with nothing saved, the same verb finds no hivecontrol at all (the machine's real app is not looked at) and starts no Node
    let mut cmd = w.command(&w.engine, "neg/none");
    cmd.args(["mesh", "reconcile-registry"]);
    w.run(cmd, None, timeout);
    assert!(w.hits_of("neg/none").is_empty(), "no hivecontrol resolves, so no Node start: {:?}", w.hits_of("neg/none"));

    // a hivecontrol the user saved (resolve_bin's second source), which needs Node for everything it is asked
    let marker = "hivecontrol-needs-node-marker.js";
    let fake = w.dir.join("fake-hivecontrol");
    std::fs::write(&fake, format!("#!/bin/sh\nexec node /nonexistent/{marker} \"$@\"\n")).unwrap();
    std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let saved = w.home.join(".anti-hall").join("devswarm");
    std::fs::create_dir_all(&saved).unwrap();
    std::fs::write(saved.join("hivecontrol-path.json"), format!("{{\"hivecontrol\": \"{}\"}}", fake.display())).unwrap();

    // the roster verb reads `hivecontrol workspace list` behind the capability gate, which probes an unknown build first
    let mut cmd = w.command(&w.engine, "neg/rr");
    cmd.args(["mesh", "reconcile-registry"]);
    w.run(cmd, None, timeout);
    w.settle();
    let hits: Vec<String> = w.hits_of("neg/rr").into_iter().map(|h| h.argv).collect();
    assert!(hits.iter().any(|a| a.contains(marker)), "the Node start of the fixture hivecontrol was recorded under the absence: {hits:?}");
}
