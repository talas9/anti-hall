//! PR-B shipped roster behavior through the real script runtime.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Home {
    dir: PathBuf,
}

impl Home {
    fn new(name: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("aha-iwb-{name}-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("home/.anti-hall/ah-engine")).unwrap();
        Home { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    fn put(&self, rel: &str, body: &str) {
        let p = self.home().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// The raw stdout of `ah-engine check <check>` for `payload`, with `extra` environment variables on top of a clean one.
    fn raw(&self, check: &str, payload: &serde_json::Value, extra: &[(&str, &str)]) -> String {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", check])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.envs(extra.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        String::from_utf8_lossy(&ch.wait_with_output().unwrap().stdout).to_string()
    }

    /// The model-facing text of an answer: the prompt advisory's context, else the whole stdout.
    fn check(&self, check: &str, payload: &serde_json::Value, extra: &[(&str, &str)]) -> String {
        let out = self.raw(check, payload, extra);
        serde_json::from_str::<serde_json::Value>(out.trim_end())
            .ok()
            .and_then(|v| v["hookSpecificOutput"]["additionalContext"].as_str().map(str::to_string))
            .unwrap_or(out)
    }
}

fn probe(h: &Home, expr: &str, extra: &[(&str, &str)]) -> String {
    let source =
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/logic/devswarm-parent-inbox.js")).unwrap();
    h.put(
        ".anti-hall/logic/devswarm-parent-inbox.js",
        &(source + "\nfunction decide(p) { return { advisory: text.advisoryJson('UserPromptSubmit', " + expr + ") }; }"),
    );
    h.check("devswarm-parent-inbox", &serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"s1"}), extra)
}
fn cell(parked: bool) -> String {
    format!("piPlanCell(spawn.osHome(), {{key:'p1',label:'step',extras:0}}, false, 'working', {parked})")
}
#[test]
fn missing_tokens_are_unknown_and_current_tokens_remain_visible() {
    let h = Home::new("tokens");
    assert!(probe(&h, &cell(false), &[]).contains("tok ?"), "{}", probe(&h, &cell(false), &[]));
    h.put(".anti-hall/devswarm/token-usage/p1.json", r#"{"total":12000,"file":"/missing","offset":12,"updated_at":1}"#);
    assert!(probe(&h, &cell(false), &[]).contains("tok ?"), "{}", probe(&h, &cell(false), &[]));
    let file = h.home().join("transcript.jsonl");
    std::fs::write(&file, "usage\n").unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    h.put(".anti-hall/devswarm/token-usage/p1.json", &serde_json::json!({"total":12000,"file":file,"offset":6,"updated_at":now}).to_string());
    assert!(probe(&h, &cell(false), &[]).contains("12k tok"));
    std::fs::write(&file, "usage\nnew\n").unwrap();
    assert!(probe(&h, &cell(false), &[]).contains("12k tok"), "small transcript growth stays known");
    std::fs::write(&file, "x".repeat(4102)).unwrap();
    assert!(probe(&h, &cell(false), &[]).contains("12k tok"), "tolerance boundary remains known");
    std::fs::write(&file, "x".repeat(4103)).unwrap();
    assert!(probe(&h, &cell(false), &[]).contains("tok ?"), "one byte past tolerance is unknown");
    std::fs::write(&file, "x").unwrap();
    assert!(probe(&h, &cell(false), &[]).contains("tok ?"), "truncated transcript is unknown");
    h.put(".anti-hall/devswarm/token-usage/p1.json", "{broken");
    assert!(probe(&h, &cell(false), &[]).contains("tok ?"), "corrupt sample is unknown");
    h.put(".anti-hall/devswarm/token-usage/p1.json", &serde_json::json!({"total":12000,"file":file,"offset":6,"updated_at":now}).to_string());
    std::fs::write(&file, "x".repeat(8192)).unwrap();
    assert!(probe(&h, &cell(false), &[]).contains("tok ?"), "large lag stays unknown");
    assert!(probe(&h, &cell(false), &[("ANTIHALL_DEVSWARM_TOKEN_UNKNOWN", "0")]).contains("12k tok"));
}
#[test]
fn parked_stall_is_quiet_and_live_stall_and_unproven_burn_still_fire() {
    let h = Home::new("flags");
    h.put(".anti-hall/devswarm/stray/p1.json", r#"{"active":[{"signal":"stall"}]}"#);
    assert!(!probe(&h, &cell(true), &[]).contains("STRAYING"));
    assert!(probe(&h, &cell(false), &[]).contains("STRAYING: stall"), "{}", probe(&h, &cell(false), &[]));
    h.put(".anti-hall/devswarm/stray/p1.json", r#"{"active":[{"signal":"stall"},{"signal":"burn"}]}"#);
    assert!(probe(&h, &cell(true), &[]).contains("STRAYING: burn"));
}
#[test]
fn explicit_parked_sources_and_switch_off() {
    let h = Home::new("parked");
    let expr = "JSON.stringify([piRowParked({now:ah.clock.now()},'c1',null,null,{gates:{done:true}},null),piRowParked({now:ah.clock.now()},'c1',null,null,{}, {active:false,archived:false}),piRowParked({now:ah.clock.now()},'c1',null,null,{}, {active:true,archived:false})])";
    assert_eq!(probe(&h, expr, &[]), "[true,true,false]");
    assert_eq!(probe(&h, expr, &[("ANTIHALL_DEVSWARM_PARKED_DISPLAY", "0")]), "[false,false,false]");
}

/// The full shipped roster path: the stale/backlog nudge survives for live children and clears only for explicit parked facts.
#[test]
fn roster_parks_done_held_and_waiting_children_but_live_backlog_still_nudges() {
    let h = Home::new("roster");
    if let Ok(file) = std::env::var("PRB_BASELINE_SOURCE") {
        h.put(".anti-hall/logic/devswarm-parent-inbox.js", &std::fs::read_to_string(file).unwrap());
    }
    let repo = h.home().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git").args(["init", "-q"]).arg(&repo).status().unwrap().success());
    let key = ah_engine::meshw::ident::repo_key_for_worktree(repo.to_str().unwrap()).unwrap().unwrap();
    let child = "child-1";
    let ds = ".anti-hall/devswarm";
    h.put(&format!("{ds}/liveness/{child}.json"), r#"{"status":"stale","notDraining":true}"#);
    let summary = |done: bool| serde_json::json!({"workspaces":{child:{"worktreePath":repo,"sessionId":"child-session","status":"stale","unread":1,"directUnread":1,"oldestDirectUnreadTs":1,"urgencyMax":"high","gates":{"done":done}}}});
    let run = |done: bool, extra: &[(&str, &str)]| {
        h.put(&format!("{ds}/summaries/{key}.json"), &summary(done).to_string());
        let mut env = vec![("ANTIHALL_DEVSWARM_SUPERVISOR", "on"), ("ANTIHALL_DEDUPE_WINDOW_MIN", "0")];
        env.extend_from_slice(extra);
        h.check("devswarm-parent-inbox", &serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"hi","cwd":repo}), &env)
    };
    let live = run(false, &[]);
    assert!(live.contains("need attention") || live.contains("NOT DRAINING"), "live true positive: {live}");
    let done = run(true, &[]);
    assert!(done.contains("URGENT/HIGH-priority") && done.contains("| parked |"), "done display: {done}");
    assert!(!done.contains("NOT DRAINING") && !done.contains("unread, stale"), "done must not nudge: {done}");
    let held = run(false, &[("ANTIHALL_DEVSWARM_HELD_PARTITIONS", child)]);
    assert!(held.contains("| parked |") && !held.contains("NOT DRAINING"), "held: {held}");
    h.put(&format!("{ds}/workspaces/{child}.json"), &serde_json::json!({"id":child,"worktreePath":repo,"sessionId":"child-session"}).to_string());
    let enc: String = repo.to_string_lossy().chars().map(|c| if "/\\:.".contains(c) { '-' } else { c }).collect();
    h.put(&format!(".claude/projects/{enc}/child-session.jsonl"), &format!("{}\n{}\n",serde_json::json!({"type":"user","timestamp":"2026-11-10T10:00:00.000Z","message":{"role":"user","content":"go"}}),serde_json::json!({"type":"assistant","timestamp":"2026-11-10T10:00:01.000Z","message":{"content":[{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"question":"Choose?"}}]}})));
    h.put(".claude/sessions/child.json", &serde_json::json!({"sessionId":"child-session","pid":std::process::id()}).to_string());
    let waiting = run(false, &[]);
    assert!(waiting.contains("| parked |") && !waiting.contains("NOT DRAINING"), "waiting: {waiting}");
    let off = run(false, &[("ANTIHALL_DEVSWARM_PARKED_DISPLAY", "0")]);
    assert!(!off.contains("| parked |") && (off.contains("need attention") || off.contains("NOT DRAINING")), "switch off: {off}");
}

#[test]
fn parked_normal_mail_remains_visible_without_a_stale_flag_accusation() {
    let h = Home::new("normal");
    let expr = "piUnreadSegment([{id:'c1',parked:true,unread:1,status:null,notDraining:false}],spawn.osHome(),'/cli',ah.clock.now())";
    let out = probe(&h, expr, &[]);
    assert!(out.contains("1 unread"), "{out}");
    assert!(!out.contains("CHILD NOT DRAINING") && !out.contains("wedged"), "{out}");
}

#[test]
fn closed_crashed_or_paused_unread_children_keep_flags_and_deliberate_stop_parks() {
    let h = Home::new("closed-crash");
    let expr = "(function(){ ah.mesh.sessionAlive=function(){return false;}; ah.mesh.childBusy=function(){return {none:true};}; return JSON.stringify(['stale','paused'].map(function(status){return piRowParked({home:spawn.osHome(),now:ah.clock.now()},'c1','/repo','dead',{status:status,unread:1},{active:false,archived:false});}).concat([piRowParked({home:spawn.osHome(),now:ah.clock.now()},'c1','/repo','dead',{unread:1,gates:{done:true}},{active:false,archived:false}),piRowParked({home:spawn.osHome(),now:ah.clock.now()},'c1','/repo','dead',{unread:1},{active:false,archived:false})]));})()";
    assert_eq!(probe(&h, expr, &[("ANTIHALL_DEVSWARM_HELD_PARTITIONS", "other")]), "[false,false,true,false]");
    assert!(
        probe(
            &h,
            "String(piRowParked({home:spawn.osHome(),now:ah.clock.now()},'c1',null,null,{unread:1},{active:false,archived:false}))",
            &[("ANTIHALL_DEVSWARM_HELD_PARTITIONS", "c1")]
        )
        .contains("true")
    );
}

#[test]
fn mixed_parked_and_live_mail_keeps_each_rows_instruction() {
    let h = Home::new("mixed");
    for segment in ["piUnreadSegment(rows,spawn.osHome(),'/test-cli',ah.clock.now())", "piUrgentSegment(rows,spawn.osHome(),'/test-cli')"] {
        let expr = format!(
            "(function(){{var rows=[{{id:'parked-child',parked:true,unread:1}},{{id:'live-child',parked:false,unread:2,status:'stale',notDraining:true}}];return {segment};}})()"
        );
        let out = probe(&h, &expr, &[]);
        assert!(out.contains("CHILD NOT DRAINING") && out.contains("/test-cli send") && out.to_lowercase().contains("parked rows"), "{out}");
        let live_at = out.find("live-child").unwrap();
        assert!(out[live_at..].contains("CHILD NOT DRAINING"), "live row needs its own drain instruction: {out}");
    }
}

#[test]
fn parked_rows_keep_stale_build_and_reactivation_restores_status_flags() {
    let h = Home::new("stale-build");
    h.put(".anti-hall/devswarm/heartbeats/c1.json", r#"{"version":"0.1.0"}"#);
    h.put(".anti-hall/devswarm/liveness/c1.json", r#"{"notDraining":true,"status":"stale"}"#);
    let expr = |done: bool| {
        "JSON.stringify(piRoster({home:spawn.osHome(),key:'k',top:'/repo',primaryId:'primary',now:ah.clock.now(),sid:'s1',newest:{known:true,value:{version:'9.0.0'}}},{workspaces:{c1:{status:'stale',unread:1,gates:{done:DONE}}}}))".replace("DONE", if done { "true" } else { "false" })
    };
    let parked = probe(&h, &expr(true), &[]);
    assert!(parked.contains("stale anti-hall 0.1.0") && parked.contains("staleAntiHallMessage\":\""), "{parked}");
    assert!(parked.contains("\"status\":null") && parked.contains("\"notDraining\":false"), "{parked}");
    let live = probe(&h, &expr(false), &[]);
    assert!(live.contains("\"status\":\"stale\""), "{live}");
    h.put(".anti-hall/devswarm/heartbeats/c1.json", "{broken");
    let parked = probe(&h, &expr(true), &[]);
    assert!(parked.contains("\"label\":\"parked\"") && parked.contains("\"notDraining\":false"), "{parked}");
    let resumed = probe(&h, &expr(false), &[]);
    assert!(resumed.contains("\"status\":\"stale\"") && resumed.contains("\"notDraining\":true"), "{resumed}");
}

#[test]
fn waiting_timeout_and_missing_corrupt_state_are_not_parked() {
    let h = Home::new("wait-timeout");
    let expr = "(function(){ah.mesh.sessionAlive=function(){return true;};return String(piRowParked({home:spawn.osHome(),now:ah.clock.now()},'c1','/repo','s1',{unread:1},{active:false,archived:false}));})()";
    assert_eq!(probe(&h, expr, &[]), "false", "missing transcript is not a deliberate stop");
    h.put(".claude/projects/-repo/s1.jsonl", "{\"type\":\"user\",\"timestamp\":\"2026-11-10T10:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n{\"type\":\"assistant\",\"timestamp\":\"2026-11-10T10:00:01.000Z\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"q1\",\"name\":\"AskUserQuestion\",\"input\":{\"question\":\"Choose?\"}}]}}\n");
    let waiting = "(function(){ah.mesh.sessionAlive=function(){return true;};return String(piRowParked({home:spawn.osHome(),now:ah.clock.now()+7200000},'c1','/repo','s1',{unread:1},null));})()";
    assert_eq!(probe(&h, waiting, &[]), "false", "long wait must escalate");
    let recent = waiting.replace("ah.clock.now()+7200000", "ah.clock.now()");
    assert_eq!(probe(&h, &recent, &[]), "true", "recent human wait parks");
    h.put(".claude/projects/-repo/s1.jsonl", "{broken\n");
    assert_eq!(probe(&h, &recent, &[]), "false", "parked -> unknown returns flags");
    assert_eq!(probe(&h, expr, &[]), "false", "corrupt transcript is not a deliberate stop");
}

#[test]
fn effective_folded_unread_cannot_park_and_paused_roster_keeps_flags() {
    let h = Home::new("folded-unread");
    let folded = "String(piRowParked({home:spawn.osHome(),now:ah.clock.now()},'c1',null,null,{directUnread:0},{active:false,archived:false},1))";
    assert_eq!(probe(&h, folded, &[]), "false", "folded unread must block app closure parking");
    h.put(".anti-hall/devswarm/liveness/c1.json", r#"{"notDraining":true,"status":"stale"}"#);
    let roster = "(function(){ahHost.piSnap=function(){return JSON.stringify({readable:true,file:true,focused:null});};ahHost.piWs=function(){return JSON.stringify({id:'c1',active:false,archived:false});};return JSON.stringify(piRoster({home:spawn.osHome(),key:'k',top:'/repo',primaryId:'primary',now:ah.clock.now(),sid:'s1',newest:{known:true,value:null}},{workspaces:{c1:{sessionId:'dead',status:'paused',unread:1}}}));})()";
    let out = probe(&h, roster, &[]);
    assert!(out.contains("\"parked\":false") && out.contains("\"notDraining\":true") && out.contains("\"status\":\"paused\""), "{out}");
    let mid_turn = "(function(){ah.mesh.sessionAlive=function(){return true;};ah.mesh.childBusy=function(){return {busy:true,waiting:false,seen:true};};return String(piRowParked({home:spawn.osHome(),now:ah.clock.now()},'c1','/repo','live',{unread:0},{active:false,archived:false}));})()";
    assert_eq!(probe(&h, mid_turn, &[]), "false", "closed UI does not excuse a mid-turn live session");
}
