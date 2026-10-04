//! Print the facts the transcript index derives from a transcript (the whole file is read, so the output is
//! comparable with the Node readers): `cargo run --release --example transcript_facts -- <transcript.jsonl>`.
//! `parity/run-transcript.js` runs this and `parity/transcript-facts.js` on the same files and diffs them.
use ah_engine::transcript::{Index, Limits};

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: transcript_facts <transcript.jsonl>");
        std::process::exit(64);
    };
    let mut lim = Limits::from_defaults();
    lim.initial_window = u64::MAX / 2;
    lim.max_update = u64::MAX / 2;
    lim.recent_tool_uses = usize::MAX / 2;
    lim.notifications = usize::MAX / 2;
    lim.assistant_text_max = usize::MAX / 2;
    lim.prompt_max = usize::MAX / 2;
    let mut ix = Index::with_limits(path, lim);
    if let Err(e) = ix.refresh() {
        eprintln!("{e}");
        std::process::exit(1);
    }
    println!("{}", ix.facts_json());
}
