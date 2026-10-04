// Throwaway prototype: std-only engine. `engine serve` = daemon, `engine hook` = client.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

struct Rule { tool: String, action: String, pat: String, msg: String }
#[derive(Default)]
struct Session { role: String, project: String, inbox: Vec<String> }

static HUP: AtomicBool = AtomicBool::new(false);
extern "C" { fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize; }
extern "C" fn on_hup(_: i32) { HUP.store(true, Ordering::SeqCst); }

fn dir() -> String { format!("{}/.anti-hall-proto", std::env::var("HOME").unwrap_or_default()) }
fn sock_path() -> String { format!("{}/engine.sock", dir()) }

fn load_rules() -> Vec<Rule> {
    let txt = std::fs::read_to_string(format!("{}/rules.txt", dir())).unwrap_or_default();
    txt.lines().filter_map(|l| {
        let p: Vec<&str> = l.splitn(4, '\t').collect();
        if p.len() < 4 { return None; }
        Some(Rule { tool: p[0].into(), action: p[1].into(), pat: p[2].into(), msg: p[3].into() })
    }).collect()
}

// Substring match; `*` in the pattern means "these pieces, in order".
fn matches(pat: &str, s: &str) -> bool {
    let mut pos = 0;
    for part in pat.split('*').filter(|p| !p.is_empty()) {
        match s[pos..].find(part) { Some(i) => pos += i + part.len(), None => return false }
    }
    true
}

fn handle(stream: UnixStream, rules: Arc<RwLock<Vec<Rule>>>, sess: Arc<Mutex<HashMap<String, Session>>>) {
    let mut w = stream.try_clone().unwrap();
    for line in BufReader::new(stream).lines().map_while(Result::ok) {
        let mut it = line.splitn(3, ' ');
        let reply = match (it.next().unwrap_or(""), it.next(), it.next()) {
            ("CHECK", Some(tool), Some(cmd)) => {
                let rs = rules.read().unwrap();
                match rs.iter().find(|r| (r.tool == tool || r.tool == "*") && matches(&r.pat, cmd)) {
                    Some(r) if r.action == "deny" => format!("DENY {}", r.msg),
                    Some(r) => format!("WARN {}", r.msg),
                    None => "ALLOW".into(),
                }
            }
            ("REGISTER", Some(id), Some(rest)) => {
                let (role, project) = rest.split_once(' ').unwrap_or((rest, ""));
                let ok = ["rick", "meeseek", "plain"].contains(&role);
                if ok { let mut m = sess.lock().unwrap(); let s = m.entry(id.into()).or_default();
                    s.role = role.into(); s.project = project.into(); }
                if ok { "OK".into() } else { "ERR bad role".into() }
            }
            ("SEND", Some(id), Some(text)) => match sess.lock().unwrap().get_mut(id) {
                Some(s) => { s.inbox.push(text.into()); "OK".into() }
                None => "ERR unknown session".into(),
            },
            ("POLL", Some(id), _) => match sess.lock().unwrap().get_mut(id) {
                Some(s) => { let m = std::mem::take(&mut s.inbox); format!("MSGS {}", m.join(" | ")) }
                None => "ERR unknown session".into(),
            },
            ("RELOAD", _, _) => { *rules.write().unwrap() = load_rules(); "OK".into() }
            _ => "ERR bad command".into(),
        };
        if writeln!(w, "{}", reply).is_err() { break; }
    }
}

fn serve() {
    std::fs::create_dir_all(dir()).unwrap();
    let _ = std::fs::remove_file(sock_path());
    let l = UnixListener::bind(sock_path()).expect("bind");
    std::fs::set_permissions(sock_path(), std::fs::Permissions::from_mode(0o600)).unwrap();
    let rules = Arc::new(RwLock::new(load_rules()));
    let sess = Arc::new(Mutex::new(HashMap::new()));
    unsafe { signal(1, on_hup); } // SIGHUP
    let r2 = rules.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        if HUP.swap(false, Ordering::SeqCst) { *r2.write().unwrap() = load_rules(); }
    });
    for s in l.incoming().flatten() {
        let (r, m) = (rules.clone(), sess.clone());
        std::thread::spawn(move || handle(s, r, m));
    }
}

// Minimal scan for `"key": "<string>"`; unescapes \" \\ \n \t.
fn scan(json: &str, key: &str) -> Option<String> {
    let i = json.find(&format!("\"{}\"", key))? + key.len() + 2;
    let rest = json[i..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let (mut out, mut esc) = (String::new(), false);
    for c in rest.chars() {
        if esc { out.push(match c { 'n' => ' ', 't' => ' ', o => o }); esc = false; }
        else if c == '\\' { esc = true } else if c == '"' { return Some(out) } else { out.push(c) }
    }
    None
}

fn ask(line: &str) -> Option<String> {
    let mut s = UnixStream::connect(sock_path()).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(500))).ok()?;
    writeln!(s, "{}", line).ok()?;
    let mut r = String::new();
    BufReader::new(s).read_line(&mut r).ok()?;
    Some(r.trim_end().to_string())
}

fn hook() {
    let mut inp = String::new();
    let _ = std::io::stdin().read_to_string(&mut inp);
    let (Some(tool), Some(cmd)) = (scan(&inp, "tool_name"), scan(&inp, "command")) else { return };
    let line = format!("CHECK {} {}", tool, cmd);
    let mut resp = ask(&line);
    if resp.is_none() {
        let exe = std::env::current_exe().unwrap();
        let _ = Command::new(exe).arg("serve").stdin(Stdio::null()).stdout(Stdio::null())
            .stderr(Stdio::null()).process_group(0).spawn();
        for _ in 0..20 { // up to 200 ms for the socket
            std::thread::sleep(Duration::from_millis(10));
            if UnixStream::connect(sock_path()).is_ok() { break; }
        }
        resp = ask(&line);
    }
    if let Some(r) = resp {
        if let Some(msg) = r.strip_prefix("DENY ") {
            let esc = msg.replace('\\', "\\\\").replace('"', "\\\"");
            println!("{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"{}\"}}}}", esc);
        }
    } // WARN/ALLOW/daemon-down: print nothing, exit 0 (fail open)
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("serve") => serve(),
        Some("hook") => hook(),
        _ => eprintln!("usage: engine serve|hook"),
    }
}
