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
    assert!(
        probe(&h, &cell(false), &[("ANTIHALL_DEVSWARM_TOKEN_OFFSET_TOLERANCE_BYTES", "0")]).contains("tok ?"),
        "configured tolerance changes actual token display"
    );
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
    let expr = "JSON.stringify([piRowParked({now:ah.clock.now()},'c1',null,null,{gates:{done:true}},null),piRowParked({now:ah.clock.now()},'c1',null,null,{unread:0}, {active:false,archived:false}),piRowParked({now:ah.clock.now()},'c1',null,null,{}, {active:true,archived:false})])";
    assert_eq!(probe(&h, expr, &[]), "[true,true,false]");
    assert_eq!(
        probe(&h, "String(piRowParked({now:ah.clock.now()},'c1',null,null,{}, {active:false,archived:false}))", &[]),
        "false",
        "unknown unread cannot prove app closure is parked"
    );
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
    assert_eq!(probe(&h, &recent, &[("ANTIHALL_DEVSWARM_PARKED_MAX_WAIT_MIN", "0")]), "false", "configured wait timeout restores flags");
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

#[test]
fn corrupt_unread_without_a_session_keeps_roster_flags() {
    for (n, (unread, fallback)) in [("'corrupt'", "0"), ("-1", "0"), ("null", "0"), ("{}", "0"), ("undefined", "undefined")].iter().enumerate() {
        let h = Home::new(&format!("corrupt-unread-{n}"));
        h.put(".anti-hall/devswarm/liveness/c1.json", r#"{"notDraining":true,"status":"stale"}"#);
        let expr = format!(
            "(function(){{ahHost.piSnap=function(){{return JSON.stringify({{readable:true,file:true,focused:null}});}};ahHost.piWs=function(){{return JSON.stringify({{id:'c1',active:false,archived:false}});}};return JSON.stringify(piRoster({{home:spawn.osHome(),key:'k',top:'/repo',primaryId:'primary',now:ah.clock.now(),sid:'s1',newest:{{known:true,value:null}}}},{{workspaces:{{c1:{{status:'stale',unread:{fallback},directUnread:{unread}}}}}}}));}})()"
        );
        let out = probe(&h, &expr, &[]);
        assert!(out.contains("\"parked\":false") && out.contains("\"notDraining\":true") && out.contains("\"status\":\"stale\""), "{unread}: {out}");
    }
}

#[test]
fn parked_wait_and_token_tolerance_have_settings_and_env_overrides() {
    let h = Home::new("gap-settings");
    let expr = "JSON.stringify([ah.settings.num('devswarm_parent.parked_max_wait_min'),ah.settings.num('devswarm_parent.token_offset_tolerance_bytes')])";
    assert_eq!(probe(&h, expr, &[]), "[60,4096]");
    h.put(".anti-hall/settings.json", r#"{"devswarm":{"parkedMaxWaitMin":12,"tokenOffsetToleranceBytes":20}}"#);
    assert_eq!(probe(&h, expr, &[]), "[12,20]");
    assert_eq!(probe(&h, expr, &[("ANTIHALL_DEVSWARM_PARKED_MAX_WAIT_MIN", "3"), ("ANTIHALL_DEVSWARM_TOKEN_OFFSET_TOLERANCE_BYTES", "8")]), "[3,8]");
}

#[test]
fn closed_roster_skips_enrichment_without_losing_mail_or_escalations() {
    for (name, app, alive, enabled, expected) in [
        ("closed", "{active:false,archived:false}", false, true, 0),
        ("live", "{active:true,archived:false}", false, true, 1),
        ("unknown", "null", false, true, 1),
        ("unreadable", "{active:false,archived:false}", false, true, 1),
        ("session-live", "{active:false,archived:false}", true, true, 1),
        ("disabled", "{active:false,archived:false}", false, false, 1),
    ] {
        let h = Home::new(&format!("closed-enrichment-{name}"));
        h.put(".anti-hall/devswarm/escalation-pending/e1.json", r#"{"parentId":"primary","childId":"c1","row":{}}"#);
        let readable = name != "unreadable";
        let expr = format!(
            r#"(function(){{
            var calls={{row:0,activity:0,finish:0,transcript:0}};
            ahHost.piRow=function(){{calls.row++;return JSON.stringify({{marker:false,app:false,closed:false,ignored:false}});}};
            ahHost.piSnap=function(){{return JSON.stringify({{readable:{readable},file:true,focused:null}});}};
            ahHost.piWs=function(){{return JSON.stringify({app});}};
            ah.mesh.sessionAlive=function(){{return {alive};}};
            ah.mesh.childBusy=function(){{calls.transcript++;return {{none:true}};}};
            ahHost.piActivity=function(){{calls.activity++;return JSON.stringify({{idleMs:0,ts:null,dormant:false,idleAlive:false}});}};
            ahHost.piFinish=function(){{calls.finish++;return JSON.stringify({{label:null}});}};
            var roster=piRoster({{home:spawn.osHome(),key:'k',top:'/repo',primaryId:'primary',now:ah.clock.now(),sid:'s1',newest:{{known:true,value:null}}}},{{workspaces:{{c1:{{worktreePath:'/repo/child',sessionId:'dead',unread:2,directUnread:2,urgencyMax:'high',oldestDirectUnreadTs:1}}}}}});
            return JSON.stringify({{calls:calls,attention:roster.attention,own:piOwnSegment(2,'primary','high',[],[],function(id){{return id;}},{{}},'mesh',ah.clock.now()),escalations:piParked(spawn.osHome(),'primary','mesh')}});
        }})()"#
        );
        let out = probe(&h, &expr, &[("ANTIHALL_DEVSWARM_SKIP_CLOSED_ENRICHMENT", if enabled { "1" } else { "0" })]);
        let value: serde_json::Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("{name}: {e}: {out}"));
        assert_eq!(value["calls"]["row"], expected, "{name}: {out}");
        assert_eq!(value["calls"]["activity"], expected, "{name}: {out}");
        assert_eq!(value["calls"]["finish"], expected, "{name}: {out}");
        assert_eq!(value["calls"]["transcript"], expected, "{name}: {out}");
        assert_eq!(value["attention"][0]["unread"], 2, "{name}: child mail: {out}");
        assert!(value["own"].as_str().unwrap().contains("2"), "{name}: parent mail: {out}");
        assert!(value["escalations"].as_str().unwrap().contains("c1"), "{name}: escalation: {out}");
    }
}

#[test]
fn closed_enrichment_preserves_archived_marker_eligibility() {
    let h = Home::new("closed-marker");
    h.put(".anti-hall/devswarm/archived/c1.json", r#"{"sessionId":"dead"}"#);
    h.put(".anti-hall/devswarm/workspaces/c1.json", r#"{"id":"c1","sessionId":"dead","worktreePath":"/repo/child"}"#);
    let expr = r#"(function(){
        ahHost.piSnap=function(){return JSON.stringify({readable:true,file:true,focused:null});};
        ahHost.piWs=function(){return JSON.stringify({id:'c1',active:false,archived:false});};
        ah.mesh.sessionAlive=function(){return false;};
        ahHost.piRow=function(){throw Error('unexpected row enrichment');};
        ahHost.piActivity=function(){throw Error('unexpected activity enrichment');};
        ahHost.piFinish=function(){throw Error('unexpected finish enrichment');};
        ah.mesh.childBusy=function(){throw Error('unexpected transcript enrichment');};
        return JSON.stringify(piRoster({home:spawn.osHome(),key:'k',top:'/repo',primaryId:'primary',now:ah.clock.now(),sid:'s1',newest:{known:true,value:null}}, {workspaces:{c1:{sessionId:'dead',unread:2,archive_ready:true}}}));
    })()"#;
    let out = probe(&h, expr, &[("ANTIHALL_DEVSWARM_SKIP_ARCHIVED_CHILDREN", "1")]);
    let value: serde_json::Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out}"));
    assert_eq!(value["attention"].as_array().unwrap().len(), 0, "{out}");
    assert_eq!(value["archiveList"].as_array().unwrap().len(), 0, "{out}");
    assert_eq!(value["rows"][0]["unread"], 2, "raw mail remains intact: {out}");
}

#[test]
fn closed_enrichment_full_parent_hook_delivers_mail_and_escalations_on_both_hosts() {
    for agent in ["claude", "codex"] {
        let h = Home::new(&format!("closed-full-{agent}"));
        h.put(".anti-hall/devswarm/workspaces/c1.json", r#"{"id":"c1","worktreePath":"/repo/child","sessionId":"dead"}"#);
        h.put(".anti-hall/devswarm/escalation-pending/e1.json", r#"{"parentId":"primary","childId":"c1","row":{}}"#);
        let expr = r#"(function(){
            ah.repo.context=function(){return {root:'/repo'};};
            ah.mesh.ident=function(){return {top:'/repo',own:'primary'};};
            ah.mesh.repoKey=function(){return 'k';};
            ah.mesh.sessionAlive=function(){return false;};
            ahHost.ctIngest=function(){return JSON.stringify({status:'healthy'});};
            ahHost.piSnap=function(){return JSON.stringify({readable:true,file:true,focused:null});};
            ahHost.piWs=function(){return JSON.stringify({id:'c1',active:false,archived:false});};
            ahHost.piAppChildren=function(){return JSON.stringify({children:[]});};
            ahHost.piRow=function(){throw Error('unexpected row enrichment');};
            ahHost.piActivity=function(){throw Error('unexpected activity enrichment');};
            ahHost.piFinish=function(){throw Error('unexpected finish enrichment');};
            ah.mesh.childBusy=function(){throw Error('unexpected transcript enrichment');};
            piCli=function(){return 'mesh';};
            piDriftNotice=function(){return null;};
            piReadSummary=function(){return {summary:{workspaces:{primary:{unread:3},c1:{worktreePath:'/repo/child',sessionId:'dead',unread:2,directUnread:2,urgencyMax:'high',oldestDirectUnreadTs:1}}}};};
            var answer=piDecide({cwd:'/repo',session_id:'s1',prompt:'hi'},{});
            return JSON.stringify(answer);
        })()"#;
        let out = probe(&h, expr, &[("DEVSWARM_AI_AGENT", agent), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on")]);
        assert!(out.contains("devswarm-own-inbox") && out.contains("3 unread"), "{agent}: parent mail: {out}");
        assert!(out.contains("URGENT/HIGH-priority") && out.contains("c1"), "{agent}: child mail: {out}");
        assert!(out.contains("devswarm-escalations"), "{agent}: escalation: {out}");
    }
}

#[test]
fn closed_roster_does_not_disable_unknown_wake_child_activity() {
    let h = Home::new("closed-wake-unknown");
    let expr = r#"(function(){
        var calls=0;
        ah.mesh.childBusy=function(){calls++;return {waiting:true};};
        ah.mesh.sessionAlive=function(){return true;};
        var ctx={home:spawn.osHome(),now:ah.clock.now(),closedRows:{c1:{active:false}}};
        var closed=piChildState(ctx,'c1','/repo/child','dead',false,undefined);
        var unknown=piChildState(ctx,'c2','/repo/other','live',false,undefined);
        return JSON.stringify({calls:calls,closed:closed,unknown:unknown});
    })()"#;
    let out = probe(&h, expr, &[]);
    assert_eq!(out, r#"{"calls":1,"closed":"live","unknown":"quiet"}"#);
}

#[test]
fn closed_row_with_done_gate_stays_parked_when_enrichment_is_skipped() {
    // A closed child whose done gate is set holds unread mail and a stale, not-draining liveness verdict.
    // Skipping enrichment must keep the metadata-only parking proof: no drain nag, parked label.
    for enabled in [false, true] {
        let h = Home::new(&format!("closed-done-parked-{enabled}"));
        h.put(".anti-hall/devswarm/liveness/c1.json", r#"{"status":"stale","notDraining":true}"#);
        let expr = r#"(function(){
            ahHost.piRow=function(){return JSON.stringify({marker:false,app:false,closed:false,ignored:false});};
            ahHost.piSnap=function(){return JSON.stringify({readable:true,file:true,focused:null});};
            ahHost.piWs=function(){return JSON.stringify({active:false,archived:false});};
            ahHost.piActivity=function(){return JSON.stringify({idleMs:0,ts:null,dormant:false,idleAlive:false});};
            ahHost.piFinish=function(){return JSON.stringify({label:null});};
            ah.mesh.sessionAlive=function(){return false;};
            ah.mesh.childBusy=function(){return {none:true};};
            var roster=piRoster({home:spawn.osHome(),key:'k',top:'/repo',primaryId:'primary',now:ah.clock.now(),sid:'s1',newest:{known:true,value:'9.9.9'}},{workspaces:{c1:{worktreePath:'/repo/child',sessionId:'dead',unread:2,directUnread:2,oldestDirectUnreadTs:1,gates:{done:true}}}});
            return JSON.stringify({attention:roster.attention.map(function(a){return {parked:a.parked,notDraining:a.notDraining,status:a.status};}),skipped:roster.closedRows!==null,label:roster.rows[0].label});
        })()"#;
        let out = probe(&h, expr, &[("ANTIHALL_DEVSWARM_SKIP_CLOSED_ENRICHMENT", if enabled { "1" } else { "0" })]);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out}"));
        assert_eq!(v["skipped"], enabled, "{out}");
        for a in v["attention"].as_array().unwrap() {
            assert_eq!(a["notDraining"], false, "enabled={enabled}: false drain nag: {out}");
            assert_eq!(a["parked"], true, "enabled={enabled}: {out}");
        }
        assert!(v["label"].as_str().unwrap().to_lowercase().contains("park"), "enabled={enabled}: {out}");
    }
}
