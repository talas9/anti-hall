//! gzip for the retention archive, by the system `gzip` (no compression library in the engine's dependency budget). Used to
//! append one gzip member per month file, and to prove every member decompresses to exactly the bytes it was made from BEFORE
//! the rows it holds are tombstoned. A missing or failing `gzip` is a [`Defer`]: nothing is written and Node's sweep runs.
use crate::defaults;
use crate::meshw::ident::{Defer, R, defer};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

/// Run `bin args` with `input` on stdin; stdout when it exits 0.
fn pipe(bin: &str, args: &[&str], input: &[u8]) -> R<Vec<u8>> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Defer(format!("gzip-spawn:{e}")))?;
    let mut stdin = child.stdin.take().ok_or_else(|| Defer("gzip-stdin".into()))?;
    let data = input.to_vec();
    // feed on a thread: the output may be larger than a pipe buffer while the input is still being written
    let feeder = std::thread::spawn(move || stdin.write_all(&data));
    let mut out = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        so.read_to_end(&mut out).map_err(|e| Defer(format!("gzip-read:{e}")))?;
    }
    let status = child.wait().map_err(|e| Defer(format!("gzip-wait:{e}")))?;
    feeder.join().map_err(|_| Defer("gzip-feeder".into()))?.map_err(|e| Defer(format!("gzip-write:{e}")))?;
    if status.success() { Ok(out) } else { defer("gzip-status") }
}

/// One gzip member of `bytes`.
pub fn compress(bytes: &[u8]) -> R<Vec<u8>> {
    pipe(defaults::text("devswarm_sup.rt_gzip_bin"), &defaults::list("devswarm_sup.rt_gzip_args"), bytes)
}

/// The bytes of a (possibly multi-member) gzip stream.
pub fn decompress(bytes: &[u8]) -> R<Vec<u8>> {
    pipe(defaults::text("devswarm_sup.rt_gzip_bin"), &defaults::list("devswarm_sup.rt_gunzip_args"), bytes)
}

/// A gzip member of `bytes`, proven to decompress to `bytes`.
pub fn compress_verified(bytes: &[u8]) -> R<Vec<u8>> {
    let gz = compress(bytes)?;
    if decompress(&gz)? == bytes { Ok(gz) } else { defer("gzip-roundtrip") }
}
