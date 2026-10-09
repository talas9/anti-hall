//! The normaliser: a home (a scratch mirror after a job) reduced to a map `relative path -> canonical text` that two homes can be
//! compared on byte for byte.
//!
//! * a SQLite store is dumped logically (every user table, column names then every row in storage order, with the type of each
//!   value), so two files with the same content but different pages compare equal; the `-wal`/`-shm`/`-journal` companions are
//!   not part of the content;
//! * a link count above one is part of the text (a descriptor retired by hard link is two names for one file);
//! * a symbolic link is its target;
//! * the central log is blanked where the engine and Node differ by design (entry time and writer pid), by the same masks the
//!   mesh witness uses (`devswarm_cli.log_masks`);
//! * any other file is its bytes (lossy UTF-8, which is lossless for the JSON the sweeps write).
use crate::defaults;
use rusqlite::types::ValueRef;
use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn value_text(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null => "n".to_string(),
        ValueRef::Integer(i) => format!("i:{i}"),
        ValueRef::Real(f) => format!("r:{f:?}"),
        ValueRef::Text(t) => format!("t:{}", serde_json::to_string(&String::from_utf8_lossy(t)).unwrap_or_default()),
        ValueRef::Blob(b) => format!("b:{}", crate::meshw::store::hex(b)),
    }
}

fn dump_db(db: &Path) -> String {
    let Ok(c) = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return defaults::text("devswarm_recon.norm_unreadable_db").to_string();
    };
    let tables: Vec<String> = c
        .prepare(crate::sql::RECON_TABLES)
        .and_then(|mut st| st.query_map([], |r| r.get::<_, String>(0)).map(|it| it.flatten().collect()))
        .unwrap_or_default();
    let mut out = String::new();
    for t in tables {
        let Ok(mut st) = c.prepare(&crate::sql::RECON_DUMP.replace("{table}", &t)) else {
            out.push_str(&format!("{t}: unreadable\n"));
            continue;
        };
        let cols: Vec<String> = st.column_names().iter().map(|s| (*s).to_string()).collect();
        out.push_str(&format!("[{t}] {}\n", cols.join(",")));
        let n = cols.len();
        let rows = st.query_map([], |r| Ok((0..n).map(|i| r.get_ref(i).map(value_text).unwrap_or_default()).collect::<Vec<_>>().join("|")));
        if let Ok(rows) = rows {
            for line in rows.flatten() {
                out.push_str(&line);
                out.push('\n');
            }
        }
    }
    out
}

fn is_db_companion(name: &str) -> bool {
    defaults::list("devswarm_recon.norm_db_companions").iter().any(|s| name.ends_with(s))
}

fn is_log(rel: &str) -> bool {
    let logs = format!("{}/{}/", defaults::text("mesh_write.dir_anti_hall"), defaults::text("mesh_write.dir_logs"));
    rel.starts_with(&logs) && defaults::list("devswarm_recon.norm_log_suffixes").iter().any(|s| rel.ends_with(s))
}

fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let rel = p.strip_prefix(base).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
        let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
        if md.file_type().is_symlink() {
            let target = std::fs::read_link(&p).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default();
            out.insert(rel, format!("-> {target}"));
        } else if md.is_dir() {
            walk(base, &p, out);
        } else if md.is_file() {
            let name = e.file_name().to_string_lossy().into_owned();
            if is_db_companion(&name) {
                continue;
            }
            let mut text = if name.ends_with(defaults::text("devswarm_recon.norm_db_suffix")) {
                dump_db(&p)
            } else {
                let raw = String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default()).into_owned();
                if is_log(&rel) { crate::meshw::clog::masked(&raw) } else { raw }
            };
            if md.nlink() > 1 {
                text.push_str(&format!("\n#nlink={}", md.nlink()));
            }
            out.insert(rel, text);
        }
    }
}

/// The normalised content of every file under `home`.
pub fn dump(home: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    walk(home, home, &mut out);
    out
}

/// What differs between two dumps: one entry per path, saying which side lacks it or showing the first differing line.
pub fn diff(a: &BTreeMap<String, String>, b: &BTreeMap<String, String>) -> Vec<String> {
    let mut out = Vec::new();
    let cut = |t: &str| t.chars().take(defaults::num("devswarm_recon.diff_chars") as usize).collect::<String>();
    for (k, va) in a {
        match b.get(k) {
            None => out.push(defaults::render("devswarm_recon.msg_diff_only_node", &[("path", k)])),
            Some(vb) if vb != va => out.push(match va.lines().zip(vb.lines()).find(|(x, y)| x != y) {
                Some((x, y)) => defaults::render("devswarm_recon.msg_diff_line", &[("path", k), ("node", &cut(x)), ("engine", &cut(y))]),
                None => defaults::render("devswarm_recon.msg_diff_length", &[("path", k), ("node", &va.len()), ("engine", &vb.len())]),
            }),
            Some(_) => {}
        }
    }
    for k in b.keys().filter(|k| !a.contains_key(*k)) {
        out.push(defaults::render("devswarm_recon.msg_diff_only_engine", &[("path", k)]));
    }
    out
}
