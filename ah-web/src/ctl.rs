//! The engine's control socket (`CTL <verb> <args>`): one short request per connection, one framed reply
//! (`AHR2 <OK|BUSY|ERR> <len> <crc>\n<body>\nAHEND\n`). Read-only verbs only; the server never writes engine state through it.
use serde_json::Value;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

const MAGIC: &str = "AHR2";
const END: &[u8] = b"\nAHEND\n";

/// Ask the engine daemon at `sock` for `CTL <request>` and return the parsed JSON body.
pub async fn call(sock: &Path, request: &str, timeout: Duration, max_bytes: usize) -> Result<Value, String> {
    // only a socket owned by this user is trusted (the daemon's own client makes the same check)
    let meta = std::fs::symlink_metadata(sock).map_err(|e| e.to_string())?;
    // SAFETY: getuid has no arguments and cannot fail
    if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::getuid() } {
        return Err("not the engine socket".into());
    }
    let exchange = async {
        let mut s = UnixStream::connect(sock).await.map_err(|e| e.to_string())?;
        s.write_all(format!("CTL {request}\n").as_bytes()).await.map_err(|e| e.to_string())?;
        s.shutdown().await.map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        // one byte past the cap is enough to know the reply is too large
        (&mut s).take(max_bytes as u64 + 1).read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
        Ok::<_, String>(buf)
    };
    let buf = tokio::time::timeout(timeout, exchange).await.map_err(|_| "timeout".to_string())??;
    if buf.len() > max_bytes {
        return Err(format!("reply over {max_bytes} bytes"));
    }
    let body = decode(&buf)?;
    serde_json::from_str(body).map_err(|e| e.to_string())
}

/// The body of an OK frame; anything else (short, wrong length, wrong trailer, BUSY, ERR) is an error.
fn decode(buf: &[u8]) -> Result<&str, String> {
    let nl = buf.iter().take(64).position(|&b| b == b'\n').ok_or("no frame header")?;
    let head = std::str::from_utf8(&buf[..nl]).map_err(|_| "bad frame header")?;
    let mut it = head.split(' ');
    if it.next() != Some(MAGIC) {
        return Err("not a frame".into());
    }
    let kind = it.next().unwrap_or_default();
    let len: usize = it.next().and_then(|n| n.parse().ok()).ok_or("bad frame length")?;
    let body = buf.get(nl + 1..nl + 1 + len).ok_or("truncated frame")?;
    if buf.get(nl + 1 + len..) != Some(END) {
        return Err("bad frame trailer".into());
    }
    let text = std::str::from_utf8(body).map_err(|_| "reply is not text")?;
    if kind == "OK" { Ok(text) } else { Err(format!("engine said {kind}: {text}")) }
}
