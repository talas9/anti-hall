//! The real HTTP transport of the Jev lane against a loopback server (D34-D38). No real network: every request goes to
//! 127.0.0.1. What is proven here is what the Node client's `fetch` settings guarantee and a mock cannot: the key goes only
//! in the Authorization header, a redirect is never followed (so the key and the text stay at the vendor), a proxy named in
//! the environment is never used, one deadline covers the whole call, and an oversized body cannot grow memory.

use ah_engine::jev::Question;
use ah_engine::jev::assist::{AskRequest, Backend, Jev, Trust};
use ah_engine::jev::breaker::SystemClock;
use ah_engine::jev::settings::Env;
use ah_engine::jev::transport::{HttpTransport, NetError, Request, Transport};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What the server saw of one request.
#[derive(Debug, Clone, Default)]
struct Seen {
    request_line: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// A loopback server answering every request with `respond(request_number, seen)` -> (status line, extra headers, body).
struct Mock {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
    hits: Arc<AtomicUsize>,
}

type Reply = (&'static str, Vec<String>, Vec<u8>);

fn read_request(s: &mut TcpStream) -> Option<Seen> {
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
    let want: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    while buf.len() < head_end + want {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Some(Seen { request_line, headers, body: String::from_utf8_lossy(&buf[head_end..]).to_string() })
}

impl Mock {
    fn start(respond: impl Fn(usize, &Seen) -> Reply + Send + Sync + 'static) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hits = Arc::new(AtomicUsize::new(0));
        let (s2, h2) = (seen.clone(), hits.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut c) = conn else { break };
                let Some(req) = read_request(&mut c) else { continue };
                let n = h2.fetch_add(1, Ordering::SeqCst);
                let (status, headers, body) = respond(n, &req);
                s2.lock().unwrap().push(req);
                let mut out = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
                for h in headers {
                    out.push_str(&h);
                    out.push_str("\r\n");
                }
                out.push_str("\r\n");
                let _ = c.write_all(out.as_bytes());
                let _ = c.write_all(&body);
            }
        });
        Mock { port, seen, hits }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

fn ok_json(body: &str) -> Reply {
    ("200 OK", vec!["Content-Type: application/json".into()], body.as_bytes().to_vec())
}

fn send(t: &HttpTransport, url: &str, body: Option<&str>, ms: u64) -> Result<ah_engine::jev::transport::RawResponse, NetError> {
    t.send(&Request { body, url, bearer: "the-secret-key", timeout: Duration::from_millis(ms) })
}

#[test]
fn a_post_carries_the_key_only_in_the_authorization_header_and_the_body_verbatim() {
    let m = Mock::start(|_, _| ok_json(r#"{"ok":true}"#));
    let r = send(&HttpTransport::new(), &m.url("/v1/systemone"), Some(r#"{"state":"hi"}"#), 3000).unwrap();
    assert_eq!((r.status, r.body.as_deref()), (200, Ok(r#"{"ok":true}"#)));
    let s = m.seen.lock().unwrap()[0].clone();
    assert!(s.request_line.starts_with("POST /v1/systemone "), "{}", s.request_line);
    assert_eq!(s.header("authorization"), Some("Bearer the-secret-key"));
    assert_eq!(s.header("content-type"), Some("application/json"));
    assert_eq!(s.body, r#"{"state":"hi"}"#);
    assert!(!s.request_line.contains("the-secret-key") && !s.body.contains("the-secret-key"), "the key never appears in the URL or the body");
}

#[test]
fn a_get_has_no_body_and_the_same_header() {
    let m = Mock::start(|_, _| ok_json("{}"));
    send(&HttpTransport::new(), &m.url("/v1/credits"), None, 3000).unwrap();
    let s = m.seen.lock().unwrap()[0].clone();
    assert!(s.request_line.starts_with("GET /v1/credits "));
    assert_eq!(s.header("authorization"), Some("Bearer the-secret-key"));
}

#[test]
fn a_redirect_is_never_followed_so_the_key_stays_at_the_vendor() {
    let target = Mock::start(|_, _| ok_json("{}"));
    let loc = target.url("/stolen");
    let origin = Mock::start(move |_, _| ("302 Found", vec![format!("Location: {loc}")], Vec::new()));
    for code in ["301 Moved Permanently", "302 Found", "307 Temporary Redirect", "308 Permanent Redirect"] {
        let loc = target.url("/stolen");
        let o = Mock::start(move |_, _| (code, vec![format!("Location: {loc}")], Vec::new()));
        assert_eq!(send(&HttpTransport::new(), &o.url("/v1/systemone"), Some("{}"), 3000), Err(NetError::Network), "{code}");
    }
    assert_eq!(send(&HttpTransport::new(), &origin.url("/v1/systemone"), Some("{}"), 3000), Err(NetError::Network));
    assert_eq!(target.hits.load(Ordering::SeqCst), 0, "the redirect target was never contacted");
}

#[test]
fn error_statuses_are_returned_with_their_body_not_raised() {
    let m = Mock::start(|_, _| ("402 Payment Required", vec![], b"Insufficient credits".to_vec()));
    let r = send(&HttpTransport::new(), &m.url("/x"), Some("{}"), 3000).unwrap();
    assert_eq!((r.status, r.body.as_deref()), (402, Ok("Insufficient credits")));
}

#[test]
fn one_deadline_covers_a_slow_server() {
    let m = Mock::start(|_, _| {
        std::thread::sleep(Duration::from_millis(1500));
        ok_json("{}")
    });
    let t0 = Instant::now();
    assert_eq!(send(&HttpTransport::new(), &m.url("/x"), Some("{}"), 250), Err(NetError::Timeout));
    assert!(t0.elapsed() < Duration::from_millis(1200), "returned at the deadline, not when the server finished: {:?}", t0.elapsed());
}

#[test]
fn a_refused_connection_is_a_network_error() {
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    assert_eq!(send(&HttpTransport::new(), &format!("http://127.0.0.1:{port}/x"), Some("{}"), 1000), Err(NetError::Network));
}

#[test]
fn a_proxy_named_in_the_environment_is_never_used() {
    let dead = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    for var in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var(var, format!("http://127.0.0.1:{dead}")) };
    }
    let m = Mock::start(|_, _| ok_json("{}"));
    let r = send(&HttpTransport::new(), &m.url("/x"), Some("{}"), 3000);
    assert_eq!(r.map(|x| x.status), Ok(200), "the request reached the server directly");
}

#[test]
fn an_oversized_body_is_cut_off_and_reads_as_unparsable() {
    let m = Mock::start(|_, _| ok_json(&format!("{{\"pad\":\"{}\"}}", "x".repeat(1_600_000))));
    let r = send(&HttpTransport::new(), &m.url("/x"), Some("{}"), 5000).unwrap();
    assert_eq!(r.status, 200);
    assert!(r.body.is_err(), "a body over jev.max_response_bytes is not read");
}

fn temp_home(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("ah-jev-http-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_whole_decision_goes_through_the_real_transport_to_a_loopback_endpoint_and_is_logged() {
    let m = Mock::start(|_, _| ok_json(r#"{"answers":{"decision":{"noul":0.97}},"usage":{"input_tokens":2000,"output_tokens":3}}"#));
    let home = temp_home("e2e");
    let env = Env::from_pairs([
        ("ANTIHALL_JEV", "1".to_string()),
        ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vercel-key".to_string()),
        ("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", m.url("/typesafe/v1/systemone")),
    ]);
    let jev = Jev::with_parts(&home, env, Arc::new(HttpTransport::new()), Arc::new(SystemClock), None, None);
    let mut req =
        AskRequest::new("speculation", Question::noul("Is it?", "yes", "no"), "token=abc123 probably fine", Trust::AddBlock, serde_json::json!(false));
    req.project = Some("p".into());
    let d = jev.ask(&req);
    assert_eq!((d.outcome, d.backend, d.cost_usd.is_some()), (serde_json::json!(true), Backend::Jev, true));
    let seen = m.seen.lock().unwrap()[0].clone();
    assert_eq!(seen.header("authorization"), Some("Bearer vercel-key"));
    assert!(seen.body.contains("token=[REDACTED] probably fine"), "the text was scrubbed before it left: {}", seen.body);
    assert!(!seen.body.contains("abc123"));
    let log = std::fs::read_to_string(home.join(".anti-hall/logs/jev-assist.ndjson")).unwrap();
    let row: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
    assert_eq!(
        (row["id"].as_str(), row["backend"].as_str(), row["transport"].as_str(), row["costSource"].as_str()),
        (Some("speculation"), Some("jev"), Some("vercel"), Some("default-price"))
    );
    assert!(!log.contains("abc123") && !log.contains("vercel-key"), "the log holds no prompt text and no key");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_localhost_override_is_dialled_as_the_loopback_literal_never_resolved() {
    let m = Mock::start(|_, _| ok_json(r#"{"answers":{"decision":{"noul":0.97}}}"#));
    let home = temp_home("localhost");
    // `127.1` and `localhost` spell the same loopback address; both are rewritten to the literal before anything is dialled
    for (i, host) in ["localhost", "127.1", "LOCALHOST"].into_iter().enumerate() {
        let url = m.url("/x").replace("127.0.0.1", host);
        let env = Env::from_pairs([
            ("ANTIHALL_JEV", "1".to_string()),
            ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk".to_string()),
            ("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", url),
        ]);
        let jev = Jev::with_parts(&home, env, Arc::new(HttpTransport::new()), Arc::new(SystemClock), None, None);
        let mut req = AskRequest::new("speculation", Question::noul("Is it?", "yes", "no"), &format!("text {i}"), Trust::AddBlock, serde_json::json!(false));
        req.project = Some("p".into());
        let d = jev.ask(&req);
        assert_eq!((d.backend, d.outcome), (Backend::Jev, serde_json::json!(true)), "{host}");
    }
    assert_eq!(m.seen.lock().unwrap().len(), 3);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_dead_endpoint_degrades_to_the_baseline_within_the_budget() {
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let home = temp_home("dead");
    let env = Env::from_pairs([
        ("ANTIHALL_JEV", "1".to_string()),
        ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "k".to_string()),
        ("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", format!("http://127.0.0.1:{port}/x")),
    ]);
    let jev = Jev::with_parts(&home, env, Arc::new(HttpTransport::new()), Arc::new(SystemClock), None, None);
    let t0 = Instant::now();
    let d = jev.ask(&AskRequest::new("speculation", Question::noul("Is it?", "yes", "no"), "text", Trust::AddBlock, serde_json::json!(false)));
    assert_eq!((d.outcome, d.backend), (serde_json::json!(false), Backend::BaselineOnly));
    assert!(t0.elapsed() < Duration::from_millis(3500));
    let _ = std::fs::remove_dir_all(&home);
}
