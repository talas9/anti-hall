//! A child that ran `inbox read` on its mail and never acked the read receipt is ordered, on its next turn, to run the exact ack command for that
//! receipt (the Primary keeps seeing the mail unread until it does). The order stands every turn, clears once the receipt is acked, and is not given
//! for a read that delivered nothing or when nothing is unread. The shipped `devswarm-child-turn` check on a scratch home.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CHILD_ENV: [(&str, &str); 4] =
    [("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feat/x"), ("DEVSWARM_BUILDER_ID", "b-1"), ("DEVSWARM_AI_AGENT", "claude")];
const ORDER: &str = "devswarm-child-ack";

struct Home {
    dir: PathBuf,
}

impl Home {
    fn new(name: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("aha-childack-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
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

    fn turn(&self) -> String {
        let p = serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":self.home(),"transcript_path":self.dir.join("t.jsonl")});
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", "devswarm-child-turn"])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.envs(CHILD_ENV.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(p.to_string().as_bytes()).unwrap();
        String::from_utf8_lossy(&ch.wait_with_output().unwrap().stdout).to_string()
    }

    /// A child with one unread message (cursor at 0), or none (`unread` false: cursor at the end).
    fn inbox(&self, unread: bool) {
        let inbox = self.home().join(".anti-hall/devswarm/inbox-b-1.ndjson");
        let cursor = self.home().join(".anti-hall/devswarm/cursor-b-1");
        self.put(".anti-hall/devswarm/inbox-b-1.ndjson", "{\"id\":\"m1\",\"text\":\"a\"}\n");
        self.put(".anti-hall/devswarm/cursor-b-1", if unread { "0" } else { "1" });
        self.put(".anti-hall/devswarm/workspaces/b-1.json", &serde_json::json!({"inboxPath": inbox, "cursorPath": cursor}).to_string());
    }

    fn receipt(&self, name: &str, delivered: u32, acked: bool) {
        let body = serde_json::json!({
            "v": 1, "receiptId": name, "id": "b-1", "reader": "h:1:1", "createdAt": 1_900_000_000_000u64,
            "ops": [{"k": "own", "partition": "b-1", "target": 1, "delivered": delivered}],
            "hashes": [], "ackedAt": if acked { serde_json::json!(1_900_000_005_000u64) } else { serde_json::Value::Null }
        });
        self.put(&format!(".anti-hall/devswarm/read-receipts/b-1/{name}.json"), &body.to_string());
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

#[test]
fn an_unacked_read_receipt_is_ordered_acked_every_turn_until_it_is() {
    let h = Home::new("order");
    h.inbox(true);
    h.receipt("rmx0001", 1, false);
    let first = h.turn();
    assert!(first.contains(ORDER) && first.contains("Do now") && first.contains("inbox ack-primary b-1 --receipt rmx0001"), "got: {first}");
    assert!(h.turn().contains("--receipt rmx0001"), "the order is not deduplicated away: it stands every turn");
    h.receipt("rmx0001", 1, true);
    assert!(!h.turn().contains(ORDER), "cleared once the receipt is acked");
}

#[test]
fn no_order_for_an_empty_read_or_when_nothing_is_unread() {
    let h = Home::new("quiet");
    h.inbox(true);
    h.receipt("rmx0001", 0, false);
    assert!(!h.turn().contains(ORDER), "a read that delivered nothing needs no ack");
    h.inbox(false);
    h.receipt("rmx0002", 1, false);
    assert!(!h.turn().contains(ORDER), "nothing unread: a stale receipt is no order");
}
