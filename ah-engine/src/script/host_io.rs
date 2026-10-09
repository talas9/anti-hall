//! More generic primitives of the host API (D88): time, process id, directory and file facts, a hash, the scoped file
//! operations of [`super::host::scoped`] with an explicit root, and the settings chain with a caller's fallback. Like the rest
//! of `ahHost` they hold no rule, text, threshold or decision: a script decides, these only do the IO it asks for.
//!
//! | raw function | what it does |
//! |---|---|
//! | `home()` | the request's home directory |
//! | `pid()` | the engine's process id |
//! | `kind(path)` | `"file"`, `"dir"`, `"link"` (not followed) or `null` |
//! | `mtimeMs(path)` | the modification time with its fraction, or `null` |
//! | `listDir(path)` | the names in a directory sorted by bytes (as `fs.readdirSync`), or `null` |
//! | `fileOp(root, rel, text, op)` | `op` `write`, `after_reply`, `append`, `mkdir`, `remove`, `rename`: see [`super::host::scoped`] |
//! | `settingGet(key, dfltJson, pluginRoot)` | `get(section, key, dflt)` of the settings chain: `[status, valueJson]`, status 0 = a value, 1 = nothing, 2 = undecidable |
use super::host::{Op, err, scoped, with_settings};
use crate::checks::guardkit::settings;
use crate::defaults;
use rquickjs::{Function, Object};
use serde_json::Value;

fn op_of(s: &str) -> rquickjs::Result<Op> {
    Ok(match s {
        "write" => Op::Write,
        "after_reply" => Op::WriteAfterReply,
        "append" => Op::Append,
        "rename" => Op::Rename,
        "mkdir" => Op::Mkdir,
        "remove" => Op::Remove,
        _ => return Err(err("fileOp", defaults::render("script.msg_unknown_op", &[("op", &s)]))),
    })
}

/// Install the functions on `h`.
pub fn install<'a>(c: &rquickjs::Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("home", Function::new(c.clone(), || -> rquickjs::Result<String> { with_settings(|st| st.home.clone()) })?)?;
    h.set("pid", Function::new(c.clone(), || f64::from(std::process::id()))?)?;
    h.set(
        "kind",
        Function::new(c.clone(), |p: String| -> Option<&'static str> {
            let m = std::fs::symlink_metadata(p).ok()?;
            Some(if m.file_type().is_symlink() {
                "link"
            } else if m.is_dir() {
                "dir"
            } else {
                "file"
            })
        })?,
    )?;
    h.set("mtimeMs", Function::new(c.clone(), |p: String| crate::checks::agent_scan::mtime_ms(std::path::Path::new(&p)))?)?;
    h.set(
        "listDir",
        Function::new(c.clone(), |p: String| -> Option<Vec<String>> {
            let mut names: Vec<String> = std::fs::read_dir(p).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            Some(names)
        })?,
    )?;
    h.set(
        "fileOp",
        Function::new(c.clone(), |root: String, rel: String, text: String, op: String| -> rquickjs::Result<bool> { scoped(&root, &rel, &text, op_of(&op)?) })?,
    )?;
    h.set(
        "settingGet",
        Function::new(c.clone(), |key: String, dflt: String, root: String| -> rquickjs::Result<String> {
            let e = defaults::get(&key).ok_or_else(|| err("settingGet", defaults::render("script.msg_unknown_key", &[("key", &key)])))?;
            let dflt: Option<Value> = if dflt.is_empty() { None } else { serde_json::from_str(&dflt).ok() };
            with_settings(|st| match settings::get_setting(st, &e.value, dflt, &root) {
                Ok(Some(v)) => format!("[0,{v}]"),
                Ok(None) => "[1,null]".to_string(),
                Err(settings::Undecidable) => "[2,null]".to_string(),
            })
        })?,
    )?;
    Ok(())
}
