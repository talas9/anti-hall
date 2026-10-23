//! Rule and settings layers (shipped < user < project): merge per key, tighten-only project files, fail-open on a bad file,
//! reload on change, and two projects on one daemon.
//!
//! Scratch HOME / state directory / git repositories only (never the user's real `~/.anti-hall`). The overlay and the environment
//! are process-global, so this file holds one test that walks the scenarios in order.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml
mod common;
use ah_engine::cfgstore::{Layers, Paths, Source, explain_setting, load_layers_cold};
use ah_engine::daemon::{Reply, Shared, handle_request};
use ah_engine::layers;
use ah_engine::rules::{Action, RuleSet, Subject};
use ah_engine::{config::Config, defaults, paths};
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

fn put(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

fn git_init(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    assert!(Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap().success());
}

fn find<'a>(rs: &'a RuleSet, id: &str) -> Option<&'a Value> {
    rs.sources.iter().find(|r| r["id"] == id)
}

fn action(rs: &RuleSet, id: &str) -> String {
    find(rs, id).map(|r| r["action"].as_str().unwrap().to_string()).unwrap_or_default()
}

/// Does `cmd` (a Bash PreToolUse in `cwd`) hit a deny rule of `rs`?
fn denies(rs: &RuleSet, cwd: &str, cmd: &str) -> bool {
    let ti = json!({"command": cmd});
    let s = Subject { event: "PreToolUse", tool: Some("Bash"), cwd: Some(cwd), tool_input: &ti, prompt: None };
    rs.matching(&s).iter().any(|r| r.action == Action::Deny)
}

/// What a daemon answers for a Bash PreToolUse in `cwd`.
fn daemon_says(sh: &Shared, cwd: &str, cmd: &str) -> String {
    let payload = json!({"hook_event_name": "PreToolUse", "session_id": "s", "cwd": cwd, "tool_name": "Bash", "tool_input": {"command": cmd}});
    match handle_request(format!("V 0.1.0\n{payload}").as_bytes(), sh).0 {
        Reply::Ok(s) => s,
        _ => String::new(),
    }
}

#[test]
#[allow(clippy::undocumented_unsafe_blocks)] // test-only env mutation, before any thread reads it
fn rules_and_settings_layer_shipped_user_project() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-layers-{}", std::process::id())));
    let (home, state) = (root.join("home"), root.join("state"));
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    let (cfg_toml, settings_json) = (state.join("config.toml"), home.join(".anti-hall").join("settings.json"));
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("AH_ENGINE_DIR", &state);
        std::env::set_var(defaults::env_name("config"), &cfg_toml);
        std::env::set_var(defaults::env_name("settings"), &settings_json);
        std::env::remove_var(defaults::env_name("rules"));
    }
    defaults::init().unwrap();
    let base = paths::rules_file();
    assert!(base.is_file(), "the shipped rules file: {}", base.display());

    // ---- user layer: merges over the shipped rules (it used to replace them) ----
    let (shipped, n) = layers::load_host_rules(&base, false).unwrap();
    assert!(n.is_empty());
    let shipped_count = shipped.sources.len();
    assert!(shipped_count >= 3);
    let fp0 = layers::host_fingerprint(&base, false);

    put(&paths::user_rules_file(), r#"{"version":1,"rules":[{"id":"u-note","pattern":"zzz","action":"warn","message":"m"}]}"#);
    let (host, n) = layers::load_host_rules(&base, false).unwrap();
    assert!(n.is_empty());
    assert_eq!(host.sources.len(), shipped_count + 1, "the user's rules.json adds; the shipped rules are still there");
    assert_ne!(layers::host_fingerprint(&base, false), fp0, "a user file change is noticed");

    let user_dir = layers::user_rules_dir().unwrap();
    put(
        &user_dir.join("a.toml"),
        "[[rules]]\nid = \"rm-rf-root-or-home\"\naction = \"context\"\n\n[[rules]]\nid = \"git-no-force-push\"\naction = \"warn\"\n\n[[rules]]\nid = \"u-deny\"\npattern = \"qqq\"\naction = \"deny\"\nmessage = \"no\"\n",
    );
    let (host, n) = layers::load_host_rules(&base, false).unwrap();
    assert_eq!(action(&host, "rm-rf-root-or-home"), "context", "the user may loosen a rule that is not locked");
    assert_eq!(action(&host, "git-no-force-push"), "deny", "a locked rule stays strict even from the user");
    assert_eq!(n.len(), 1, "the refusal is one notice: {n:?}");
    assert!(find(&host, "u-deny").is_some());
    put(&user_dir.join("a.toml"), "this is = not [valid");
    let (host, n) = layers::load_host_rules(&base, false).unwrap();
    assert_eq!((host.sources.len(), n.len()), (shipped_count + 1, 1), "an invalid user file is ignored with one notice, the rest applies");
    std::fs::remove_file(user_dir.join("a.toml")).unwrap();
    let explicit = root.join("explicit.json");
    put(&explicit, r#"{"version":1,"rules":[]}"#);
    assert_eq!(layers::load_host_rules(&explicit, true).unwrap().0.sources.len(), 0, "an explicit AH_ENGINE_RULES file is the whole set");
    std::fs::remove_file(paths::user_rules_file()).unwrap();
    let host = Arc::new(layers::load_host_rules(&base, false).unwrap().0);

    // ---- project layer ----
    defaults::set_overlay(&[("layers.recheck_ms", json!(0))]);
    let (repo1, repo2) = (root.join("repo1"), root.join("repo2"));
    git_init(&repo1);
    git_init(&repo2);
    std::fs::create_dir_all(repo1.join("src/deep")).unwrap();
    let cwd1 = repo1.join("src/deep").to_string_lossy().to_string();
    let cwd2 = repo2.to_string_lossy().to_string();
    let rules1 = repo1.join(".anti-hall/rules");
    put(
        &rules1.join("p.toml"),
        "[[rules]]\nid = \"p-publish\"\npattern = \"npm publish\"\naction = \"deny\"\nmessage = \"no publish\"\n\n\
         [[rules]]\nid = \"rm-rf-root-or-home\"\naction = \"deny\"\n\n\
         [[rules]]\nid = \"git-no-ai-self-credit\"\naction = \"warn\"\n\n\
         [[rules]]\nid = \"git-no-force-push\"\nenabled = false\n",
    );
    put(&rules1.join("bad_check.toml"), "[[rules]]\nid = \"x\"\npattern = \"a\"\naction = \"deny\"\ncheck = \"git\"\n");
    put(&rules1.join("bad_regex.toml"), "[[rules]]\nid = \"y\"\npattern = \"(\"\naction = \"deny\"\n");
    put(&rules1.join("big.toml"), &format!("# {}\n", "x".repeat(70_000)));
    put(&rules1.join("notes.txt"), "not a rule file");
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hosts", rules1.join("link.toml")).unwrap();

    let p1 = layers::project(&cwd1).expect("repo1 has a project layer");
    assert_eq!(p1.root, repo1.canonicalize().unwrap(), "the root is the git top level, found from a subdirectory");
    let ignored: Vec<&str> = p1.notes.iter().filter(|n| n.subject.is_empty()).map(|n| n.text.as_str()).collect();
    assert_eq!(ignored.len(), 4, "bad_check, bad_regex, big, link are each ignored whole, once: {ignored:?}");
    let rs1 = layers::rules_for(&cwd1, &host);
    assert_eq!(action(&rs1, "p-publish"), "deny", "a project may add a rule");
    assert_eq!((action(&host, "rm-rf-root-or-home").as_str(), action(&rs1, "rm-rf-root-or-home").as_str()), ("warn", "deny"), "a project may raise an action");
    assert!(find(&rs1, "x").is_none() && find(&rs1, "y").is_none(), "a rule with check/options or a bad pattern never loads");
    assert_eq!(action(&rs1, "git-no-ai-self-credit"), "deny", "loosening deny -> warn is refused");
    assert!(rs1.rules.iter().any(|r| r.id == "git-no-force-push"), "switching a shipped rule off is refused");
    assert!(denies(&rs1, &cwd1, "npm publish") && !denies(&host, &cwd1, "npm publish"));
    // the daemon applies it per request, and another project on the same daemon does not see it
    let sh = Shared::new(Config::from_env(), "0.1.0", layers::load_host_rules(&base, false).unwrap().0, base.clone());
    assert!(daemon_says(&sh, &cwd1, "npm publish").contains("deny"), "repo1's rule blocks in repo1");
    assert!(!daemon_says(&sh, &cwd2, "npm publish").contains("deny"), "repo2 is not affected by repo1's layer");
    assert!(daemon_says(&sh, &cwd2, "git push --force origin main").contains("deny"), "the shipped rules still apply everywhere");
    assert!(Arc::ptr_eq(&layers::rules_for(&cwd2, &host), &host), "a project without a layer gets the shared set itself");
    put(&repo2.join(".anti-hall/rules/q.toml"), "[[rules]]\nid = \"q-only\"\npattern = \"make deploy\"\naction = \"deny\"\n");
    assert!(daemon_says(&sh, &cwd2, "make deploy").contains("deny") && !daemon_says(&sh, &cwd1, "make deploy").contains("deny"));
    assert!(!daemon_says(&sh, &cwd2, "npm publish").contains("deny"), "still isolated both ways");
    // reload on change
    put(&rules1.join("p.toml"), "[[rules]]\nid = \"p-publish\"\npattern = \"npm publish\"\naction = \"warn\"\nmessage = \"changed\"\n");
    assert!(!daemon_says(&sh, &cwd1, "npm publish").contains("\"deny\""), "an edited project file is re-read");
    std::fs::remove_file(rules1.join("p.toml")).unwrap();
    assert!(Arc::ptr_eq(&layers::rules_for(&cwd1, &host), &host), "a removed file drops the layer");
    // a project may loosen only what the USER layer lists
    put(&rules1.join("p.toml"), "[[rules]]\nid = \"rm-rf-root-or-home\"\nenabled = false\n");
    assert_eq!(layers::rules_for(&cwd1, &host).rules.len() + 1, host.rules.len() + 1, "refused: a project cannot switch a rule off");
    defaults::set_overlay(&[("layers.recheck_ms", json!(0)), ("layers.project_may_loosen", json!(["rm-rf-root-or-home"]))]);
    assert!(layers::rules_for(&cwd1, &host).rules.iter().all(|r| r.id != "rm-rf-root-or-home"), "the user layer allowed it");
    defaults::set_overlay(&[("layers.recheck_ms", json!(0))]);

    // a nested repository is its own project (a submodule too): the outer layer does not apply inside it
    let inner = repo1.join("vendor/inner");
    git_init(&inner);
    put(&rules1.join("p.toml"), "[[rules]]\nid = \"p-publish\"\npattern = \"npm publish\"\naction = \"deny\"\n");
    let inner_cwd = inner.to_string_lossy().to_string();
    put(&inner.join(".anti-hall/rules/i.toml"), "[[rules]]\nid = \"git-no-force-push\"\npattern = \"nothing\"\n");
    let rs_inner = layers::rules_for(&inner_cwd, &host);
    assert!(!denies(&rs_inner, &inner_cwd, "npm publish"), "the inner repository is its own project");
    assert!(denies(&rs_inner, &inner_cwd, "git push --force origin main"), "narrowing a shipped rule's pattern from a project is refused");
    assert!(denies(&layers::rules_for(&cwd1, &host), &cwd1, "npm publish"));

    // ---- settings ----
    put(&cfg_toml, "[speculation_guard]\nmax_blocks = 4\n");
    let (user_layers, errs): (Layers, _) = load_layers_cold(&Paths { user: cfg_toml.clone(), settings: Some(settings_json.clone()) });
    assert!(errs.is_empty());
    let env = |_: &str| None;
    put(
        &repo1.join(".anti-hall/engine.toml"),
        "[speculation_guard]\nmax_blocks = 7\n[task_guard]\nmax_blocks = 2\n[telemetry]\nhealth_snapshot_ms = 100000\n",
    );
    let p = layers::project(&cwd1).unwrap();
    assert!(p.settings.contains_key("speculation_guard.max_blocks") && !p.settings.contains_key("telemetry.health_snapshot_ms"), "an unlisted setting is refused: {:?} {:?}", p.settings, p.notes);
    assert!(p.notes.iter().any(|n| n.subject == "telemetry.health_snapshot_ms"));
    let up = explain_setting("speculation_guard.max_blocks", &user_layers, &p.settings, &env).unwrap();
    assert_eq!((up["value"].as_i64(), up["source"].as_str()), (Some(7), Some("project")), "project over the user's config.toml (4) when stricter");
    let down = explain_setting("task_guard.max_blocks", &user_layers, &p.settings, &env).unwrap();
    assert_eq!((down["value"].as_i64(), down["source"].as_str()), (Some(5), Some("default")), "a lower value is refused, the layer below wins");
    assert!(down["refused"].is_string());
    assert_eq!(down["layers"][1]["state"], "refused");
    defaults::set_overlay(&[("layers.recheck_ms", json!(0)), ("layers.project_may_loosen", json!(["task_guard.max_blocks"]))]);
    let loose = explain_setting("task_guard.max_blocks", &user_layers, &p.settings, &env).unwrap();
    assert_eq!((loose["value"].as_i64(), loose["source"].as_str()), (Some(2), Some("project")), "the user layer allowed loosening this key");
    defaults::set_overlay(&[("layers.recheck_ms", json!(0))]);
    let user_only = explain_setting("speculation_guard.max_blocks", &user_layers, &Default::default(), &env).unwrap();
    assert_eq!(user_only["source"], Source::UserFile.name(), "no project: the user's config.toml");
    let env_wins = |n: &str| (Some(n) == defaults::env_of("task_guard.max_blocks")).then(|| "9".to_string());
    if defaults::env_of("task_guard.max_blocks").is_some() {
        assert_eq!(explain_setting("task_guard.max_blocks", &user_layers, &p.settings, &env_wins).unwrap()["source"], "env");
    }
    // a locked setting or a guard event in a project file: the file is ignored whole, with one notice, and the session carries on
    put(&repo1.join(".anti-hall/engine.toml"), "[speculation_guard]\nmax_blocks = 7\n[events.PreToolUse]\nmode = \"off\"\n");
    let p = layers::project(&cwd1).unwrap();
    assert!(p.settings.is_empty() && p.hooks.is_empty(), "a guard event in a project file ignores the file");
    put(&repo1.join(".anti-hall/engine.toml"), "[config]\nlocked = []\n");
    assert!(layers::project(&cwd1).unwrap().settings.is_empty(), "a locked setting in a project file ignores the file");

    // ---- explain a rule, and the CLI ----
    put(&repo1.join(".anti-hall/engine.toml"), "[speculation_guard]\nmax_blocks = 7\n");
    let e = layers::explain_rule("p-publish", &cwd1).unwrap();
    assert_eq!(e["layers"][0]["rule"], Value::Null);
    assert_eq!(e["layers"][2]["rule"]["action"], "deny");
    let out = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
        .args(["config", "explain", "speculation_guard.max_blocks", "--cwd", &cwd1, "--json"])
        .env("HOME", &home)
        .env("AH_ENGINE_DIR", &state)
        .env("AH_ENGINE_NOSPAWN", "1")
        .env(defaults::env_name("config"), &cfg_toml)
        .env(defaults::env_name("settings"), &settings_json)
        .output()
        .unwrap();
    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)));
    assert_eq!((v["value"].as_i64(), v["source"].as_str()), (Some(7), Some("project")), "{v}");
    assert_eq!(v["layers"].as_array().unwrap().len(), 5);
}
