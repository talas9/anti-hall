//! gzip for the retention archive, by the system `gzip` (no compression library in the engine's dependency budget). Used to
//! append one gzip member per month file, and to prove every member decompresses to exactly the bytes it was made from BEFORE
//! the rows it holds are tombstoned. A missing or failing `gzip` is a failure of the store's sweep (Node's zlib throws the same way): nothing is written for the batch and the store's result carries the error.
use crate::defaults;
use crate::meshw::ident::{Defer, R};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

/// The failure of one gzip step, in the words of `devswarm_sup.rt_err_gzip`.
fn broke(why: impl std::fmt::Display) -> Defer {
    crate::dssup::failure(defaults::render("devswarm_sup.rt_err_gzip", &[("why", &why)]))
}

/// Run `bin args` with `input` on stdin; stdout when it exits 0.
fn pipe(bin: &str, args: &[&str], input: &[u8]) -> R<Vec<u8>> {
    let mut child = Command::new(bin).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(broke)?;
    let mut stdin = child.stdin.take().ok_or_else(|| broke(defaults::text("devswarm_sup.rt_err_gzip_stdin")))?;
    let data = input.to_vec();
    // feed on a thread: the output may be larger than a pipe buffer while the input is still being written
    let feeder = std::thread::spawn(move || stdin.write_all(&data));
    let mut out = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        so.read_to_end(&mut out).map_err(broke)?;
    }
    let status = child.wait().map_err(broke)?;
    feeder.join().map_err(|_| broke(defaults::text("devswarm_sup.rt_err_gzip_feeder")))?.map_err(broke)?;
    if status.success() { Ok(out) } else { Err(broke(status)) }
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
    if decompress(&gz)? == bytes { Ok(gz) } else { Err(broke(defaults::text("devswarm_sup.rt_err_gzip_roundtrip"))) }
}
