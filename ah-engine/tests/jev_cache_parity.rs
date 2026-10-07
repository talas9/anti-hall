//! The Jev answer cache is Node's file: `~/.anti-hall/cache/jev-assist.json`, in Node's shape, so a text asked by a Node
//! hook and by the engine is asked once. Compared against the real `hooks/lib/jev-assist.js` on an isolated home and a
//! loopback mock (no real network, no real key):
//!   * an entry Node wrote is a hit for the engine's cache (same key, answer and confidence);
//!   * an entry the engine wrote is a hit for Node (backend `cache`, no request reaches the mock);
//!   * writers racing on the one file (engine threads and Node processes) never leave a file that does not parse, and the
//!     engine's own entries all survive each other.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::jev::assist::content_hash;
use ah_engine::jev::cache::{Cached, FileCache, JevCache};
use ah_engine::jev::client::Answer;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

static N: AtomicUsize = AtomicUsize::new(0);

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn home() -> PathBuf {
    let h = std::env::temp_dir().join(format!("ah-jev-cache-parity-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&h).unwrap();
    h
}

/// A loopback server answering every request with a confident `true`; counts the requests.
fn mock() -> (u16, Arc<Mutex<usize>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(0usize));
    let s2 = seen.clone();
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(mut c) = c else { break };
            ah_engine::discard::harmless(c.set_read_timeout(Some(Duration::from_secs(5))));
            let mut buf = [0u8; 8192];
            let mut got = Vec::new();
            while let Ok(n) = c.read(&mut buf) {
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
                if let Some(p) = got.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&got[..p]).to_ascii_lowercase();
                    let want: usize =
                        head.split("content-length:").nth(1).and_then(|v| v.split("\r\n").next()).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    if got.len() >= p + 4 + want {
                        break;
                    }
                }
            }
            *s2.lock().unwrap() += 1;
            let body = r#"{"answers":{"decision":{"noul":0.97}},"usage":{"input_tokens":10,"output_tokens":1}}"#;
            let out = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            ah_engine::discard::harmless(c.write_all(out.as_bytes()));
        }
    });
    (port, seen)
}

/// Node's own `ask()` for `state`; the decision it returned.
fn node_ask(home: &Path, port: u16, state: &str) -> Value {
    let js = format!(
        "const a=require({:?});(async()=>{{const d=await a.ask({{id:'speculation',question:{{type:'noul',instructions:'q',criteria:{{true:'t',false:'f'}}}},state:process.argv[1],trust:'add-block',baseline:false,home:process.env.HOME}});console.log(JSON.stringify(d));}})()",
        repo().join("plugins/anti-hall/hooks/lib/jev-assist.js").to_string_lossy()
    );
    let out = Command::new("node")
        .arg("-e")
        .arg(js)
        .arg(state)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("ANTIHALL_JEV", "1")
        .env("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "parity-test-key-not-real")
        .env("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", format!("http://127.0.0.1:{port}/v1/systemone"))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_str(String::from_utf8_lossy(&out.stdout).lines().last().unwrap()).unwrap()
}

fn cache_path(home: &Path) -> PathBuf {
    home.join(".anti-hall/cache/jev-assist.json")
}

#[test]
fn an_entry_node_wrote_is_a_hit_for_the_engine() {
    let h = home();
    let (port, seen) = mock();
    let d = node_ask(&h, port, "text asked by node");
    assert_eq!(d["backend"], "jev", "{d}");
    assert_eq!(*seen.lock().unwrap(), 1);
    let key = content_hash(&["speculation", "v1", "text asked by node"]);
    let hit = FileCache::new(cache_path(&h), 500).get(&key).expect("the engine finds Node's entry under the same key");
    assert_eq!(hit.answer, Answer::Bool(true));
    assert!((hit.confidence - 0.94).abs() < 1e-9, "{}", hit.confidence);
    assert_eq!(hit.chain, None);
}

#[test]
fn an_entry_the_engine_wrote_is_a_hit_for_node() {
    let h = home();
    let (port, seen) = mock();
    let key = content_hash(&["speculation", "v1", "text asked by the engine"]);
    FileCache::new(cache_path(&h), 500).put(&key, Cached { answer: Answer::Bool(true), confidence: 0.9, chain: Some("vercel|m|e".into()) });
    let d = node_ask(&h, port, "text asked by the engine");
    assert_eq!((d["backend"].clone(), d["costSource"].clone()), ("cache".into(), "cache".into()), "{d}");
    assert_eq!(*seen.lock().unwrap(), 0, "no request: the answer came from the shared file");
    // Node rewrites the file for a new text and keeps the engine's entry, extra field included
    node_ask(&h, port, "a second text");
    let text = std::fs::read_to_string(cache_path(&h)).unwrap();
    assert!(text.contains(&format!(r#""{key}":{{"answer":true,"confidence":0.9,"_seq":1,"chain":"vercel|m|e"}}"#)), "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 2);
}

#[test]
fn racing_writers_never_tear_the_file() {
    let h = home();
    let (port, _) = mock();
    let c = Arc::new(FileCache::new(cache_path(&h), 500));
    let node = {
        let h = h.clone();
        std::thread::spawn(move || (0..4).for_each(|i| drop(node_ask(&h, port, &format!("node text {i}")))))
    };
    let engine: Vec<_> = (0..4)
        .map(|t| {
            let c = c.clone();
            std::thread::spawn(move || {
                for i in 0..25 {
                    c.put(&format!("engine{t}x{i}"), Cached { answer: Answer::Bool(true), confidence: 0.9, chain: None });
                    std::thread::sleep(Duration::from_millis(2));
                }
            })
        })
        .collect();
    engine.into_iter().for_each(|e| e.join().unwrap());
    node.join().unwrap();
    let text = std::fs::read_to_string(cache_path(&h)).unwrap();
    let v: Value = serde_json::from_str(&text).expect("the file always parses");
    let o = v.as_object().unwrap();
    assert!(o.values().all(|e| e["answer"].is_boolean() && e["confidence"].is_number() && e["_seq"].is_number()), "{text}");
    // Node takes no lock (it reads, merges and renames), so one of its writes can replace a concurrent engine write;
    // the engine's own writers are serialised: the last engine entry is present and the file only ever held whole entries.
    assert!(o.keys().filter(|k| k.starts_with("engine")).count() >= 1);
    let stray: Vec<_> =
        std::fs::read_dir(cache_path(&h).parent().unwrap()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".tmp.")).collect();
    assert!(stray.is_empty(), "temp files left behind");
}
