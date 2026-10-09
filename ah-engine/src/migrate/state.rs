//! The forward migrations of persisted state files: the legacy root-level progress and history files, the parent-gate
//! reply-state and gate-loop state files, and the durable auto-archive record. Each reads every earlier shape of its data,
//! rewrites atomically, leaves what it cannot parse exactly as it is, and deletes nothing.
use super::{
    Ctx, Detect, Error, Row, StepResult, for_each_line, has_own, is_enoent, is_object, j_finite, j_strict_eq, j_string, j_truthy, json_ext, migration_fix,
    parse_json, read_dir_sorted, read_text, read_text_note, scratch_suffix, step, write_atomic,
};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::text::cmp16;
use crate::checks::jsport::{date, ident, num};
use crate::defaults;
use crate::reqenv::RequestEnv;
use std::path::{Path, PathBuf};

// ---- the legacy root-level files -------------------------------------------------------------------------------------

/// What one legacy file's copy came to.
enum Copy {
    NotFound,
    Skipped,
    Pending,
    Migrated,
    /// The copy could not be written.
    Failed(Error),
}

/// `repoRoot(cwd)`: the git toplevel of `cwd` unless it is the account's home, else `cwd`. `None` when the location cannot be
/// confirmed without Node (the caller then leaves the step to the Node doctor).
fn project_root(ctx: &Ctx) -> Option<PathBuf> {
    if !Path::new(&ctx.cwd).is_absolute() {
        return Some(PathBuf::from(&ctx.cwd));
    }
    let c = ident::resolve_context(&ctx.cwd, false, &RequestEnv::from(ctx.env.clone()));
    if c.unsure {
        return None;
    }
    match c.toplevel {
        Some(t) if crate::checks::jsport::home::real_home().is_none_or(|h| h != t) => Some(PathBuf::from(t)),
        _ => Some(PathBuf::from(&ctx.cwd)),
    }
}

/// Copy one legacy file into the dated history directory unless an identical copy is there.
fn copy_one(ctx: &Ctx, root: &Path, name: &str, dry_run: bool) -> Copy {
    let src = match read_text(&root.join(name)) {
        Ok(t) => t,
        Err(e) => {
            ctx.io_note("open", &root.join(name), &e);
            return Copy::NotFound;
        }
    };
    let dest_dir = root.join(defaults::text("migrate.legacy_dest"));
    let dest = dest_dir.join(name);
    if read_text_note(ctx, &dest).as_deref() == Some(src.as_str()) {
        return Copy::Skipped;
    }
    if dry_run {
        return Copy::Pending;
    }
    if let Err(source) = std::fs::create_dir_all(&dest_dir) {
        return Copy::Failed(Error::Io { call: "mkdir", path: dest_dir, source });
    }
    let tmp = dest_dir.join(format!(".{name}{}-{}-{}", defaults::text("migrate.tmp_ext"), std::process::id(), num::to_js_string(date::now_ms())));
    // the temp name is Node's (DECISIONS, atomic-write exceptions); the write is synced before the rename
    if let Err(source) = crate::atomic::stage(&tmp, &src, crate::atomic::Style::default()) {
        return Copy::Failed(Error::Io { call: "open", path: tmp, source });
    }
    if let Err(source) = std::fs::rename(&tmp, &dest) {
        if let Err(c) = std::fs::remove_file(&tmp) {
            ctx.io_note("unlink", &tmp, &c);
        }
        return Copy::Failed(Error::Io { call: "rename", path: tmp, source });
    }
    Copy::Migrated
}

/// `migrateLegacyState({dir, dryRun})`: each legacy file that differs from its copy under `.anti-hall/history/legacy/`.
fn copy_legacy(ctx: &Ctx, root: &Path, dry_run: bool) -> Vec<(String, Copy)> {
    defaults::list("migrate.legacy_files").into_iter().map(|name| (name.to_string(), copy_one(ctx, root, name, dry_run))).collect()
}

/// `migrate-legacy`: copy `.anti-hall-progress.md` and `.anti-hall-history.md` into the dated history structure (originals
/// stay, byte for byte).
pub(super) fn legacy_state(ctx: &Ctx, rows: &mut Vec<Row>) {
    let (id, action) = (step("legacy"), step("legacy_action"));
    let Some(root) = project_root(ctx) else {
        rows.push(Row { id: id.into(), action: action.into(), status: "skipped".into(), msg: defaults::text("migrate_msg.deferred_git").to_string() });
        return;
    };
    migration_fix(
        rows,
        ctx,
        id,
        action,
        || {
            let pending: Vec<String> = copy_legacy(ctx, &root, true).into_iter().filter(|(_, c)| matches!(c, Copy::Pending)).map(|(f, _)| f).collect();
            Ok(Detect { pending: !pending.is_empty(), detail: pending.join(", ") })
        },
        || -> StepResult<()> {
            match copy_legacy(ctx, &root, false).into_iter().find_map(|(_, c)| if let Copy::Failed(e) = c { Some(e) } else { None }) {
                Some(e) => Err(e),
                None => Ok(()),
            }
        },
    );
}

// ---- reply-state files ------------------------------------------------------------------------------------------------

/// What the migrations of one directory of state files counted.
#[derive(Default)]
struct Report {
    scanned: u64,
    migrated: u64,
    already: u64,
    pending: u64,
    errors: u64,
}

fn gate_dir(ctx: &Ctx) -> PathBuf {
    ctx.devswarm().join(defaults::text("migrate.parent_gate_dir"))
}

/// The names in a state directory; a missing directory is "nothing to migrate", any other failure is noted.
fn list_dir(ctx: &Ctx, dir: &Path) -> Vec<String> {
    match read_dir_sorted(dir) {
        Ok(n) => n,
        Err(e) => {
            ctx.io_note("scandir", dir, &e);
            Vec::new()
        }
    }
}

/// `isAppendRecord`: `{m: string, t: finite number}`.
fn is_append_record(o: &J) -> bool {
    matches!(o, J::Obj(_)) && matches!(o.get("m"), Some(J::Str(_))) && j_finite(o.get("t")).is_some()
}

/// A line this port cannot read the way JavaScript does: the file is then left as it is.
enum Line {
    Blank,
    Bad,
    Value(J),
    Unsure,
}

fn read_line(raw: &str) -> Line {
    let t = js_trim(raw);
    if t.is_empty() {
        return Line::Blank;
    }
    match json::parse(t, defaults::num("migrate.json_depth") as usize) {
        Ok(v) => Line::Value(v),
        Err(json::Fail::Invalid) => Line::Bad,
        Err(json::Fail::Unsupported) => Line::Unsure,
    }
}

/// `needsMigration(raw)`: some non-empty line is not an append record. `None` when a line cannot be read the way JavaScript
/// reads it.
fn needs_migration(raw: &str) -> Option<bool> {
    for line in raw.split('\n') {
        match read_line(line) {
            Line::Blank => {}
            Line::Bad => return Some(true),
            Line::Unsure => return None,
            Line::Value(v) => {
                if !is_append_record(&v) {
                    return Some(true);
                }
            }
        }
    }
    Some(false)
}

/// `foldReplyLog(raw)`: the latest reply per sender, from any mix of the legacy merged object and appended records.
fn fold_reply_log(raw: &str) -> Option<Vec<(String, f64)>> {
    let mut out: Vec<(String, f64)> = Vec::new();
    let mut bump = |m: &str, ts: f64| {
        if m.is_empty() || !ts.is_finite() {
            return;
        }
        match out.iter_mut().find(|(k, _)| k == m) {
            Some(slot) => {
                if ts > slot.1 {
                    slot.1 = ts;
                }
            }
            None => out.push((m.to_string(), ts)),
        }
    };
    for line in raw.split('\n') {
        match read_line(line) {
            Line::Blank | Line::Bad => {}
            Line::Unsure => return None,
            Line::Value(o) => {
                if !is_object(&o) {
                    continue;
                }
                if is_append_record(&o) {
                    if let (Some(J::Str(m)), Some(t)) = (o.get("m"), j_finite(o.get("t"))) {
                        bump(m, t);
                    }
                } else if let J::Obj(members) = &o {
                    for (k, v) in members {
                        if let Some(t) = j_finite(v.get("lastReplyTs")).filter(|_| is_object(v)) {
                            bump(k, t);
                        }
                    }
                }
            }
        }
    }
    Some(out)
}

/// The append-only text of a fold: one `{"m":…,"t":…}` line per sender, senders sorted as `Array.prototype.sort` does.
fn serialize_replies(folded: Vec<(String, f64)>) -> String {
    let mut f = folded;
    f.sort_by(|a, b| cmp16(&a.0, &b.0));
    f.iter().map(|(m, t)| format!("{}\n", json::stringify(&J::Obj(vec![("m".into(), J::Str(m.clone())), ("t".into(), J::Num(*t))])))).collect()
}

/// One rewrite pass of a reply-state file: write the folded text aside, re-read the source, and replace it only when the source
/// is unchanged (`Ok(true)`); when it grew, fold again from the new text (`Ok(false)`); when anything cannot be confirmed the
/// source is left as it is (`Err`).
fn rewrite_replies(ctx: &Ctx, p: &Path, current: &mut String, folded: Vec<(String, f64)>) -> Result<bool, ()> {
    let tmp = PathBuf::from(format!("{}.migrate.{}.{}", p.display(), scratch_suffix(), super::rand36()));
    let step = (|| {
        if let Err(e) = crate::atomic::stage(&tmp, serialize_replies(folded), crate::atomic::Style::default()) {
            ctx.io_note("open", &tmp, &e);
            return Err(());
        }
        let latest = read_text(p).map_err(|e| ctx.io_note("open", p, &e))?;
        if latest == *current {
            std::fs::rename(&tmp, p).map_err(|e| ctx.io_note("rename", &tmp, &e))?;
            Ok(true)
        } else {
            *current = latest;
            Ok(false)
        }
    })();
    if let Err(e) = std::fs::remove_file(&tmp)
        && !is_enoent(&e)
    {
        ctx.io_note("unlink", &tmp, &e);
    }
    step
}

/// `migrateReplyState(home, {dryRun})`.
fn migrate_reply_state(ctx: &Ctx, dry_run: bool) -> Report {
    let mut rep = Report::default();
    let dir = gate_dir(ctx);
    let re = crate::checks::lit_re(defaults::text("migrate.replies_re"));
    for name in list_dir(ctx, &dir) {
        if !re.is_match(&name) {
            continue;
        }
        let p = dir.join(&name);
        rep.scanned += 1;
        let md = match std::fs::metadata(&p) {
            Ok(m) => m,
            Err(e) => {
                ctx.io_note("stat", &p, &e);
                rep.errors += 1;
                continue;
            }
        };
        if !md.is_file() {
            rep.scanned -= 1;
            continue;
        }
        let raw = match read_text(&p) {
            Ok(r) => r,
            Err(e) => {
                ctx.io_note("open", &p, &e);
                rep.errors += 1;
                continue;
            }
        };
        match needs_migration(&raw) {
            None => {
                ctx.note(defaults::render("migrate_msg.note_unsure", &[("path", &p.display())]));
                rep.errors += 1;
                continue;
            }
            Some(false) => {
                rep.already += 1;
                continue;
            }
            Some(true) => {}
        }
        rep.pending += 1;
        if dry_run {
            continue;
        }
        // Re-read before the rename so a reply appended during the fold is folded in too; give up (file untouched) when it
        // keeps growing, or when the re-read fails: an unconfirmed source is never replaced.
        let mut current = raw;
        let mut done = false;
        for _ in 0..defaults::num("migrate.reply_passes") {
            let Some(folded) = fold_reply_log(&current) else {
                rep.errors += 1;
                done = true;
                break;
            };
            match rewrite_replies(ctx, &p, &mut current, folded) {
                Ok(true) => {
                    rep.migrated += 1;
                    done = true;
                }
                Ok(false) => {}
                Err(()) => {
                    rep.errors += 1;
                    done = true;
                }
            }
            if done {
                break;
            }
        }
        if !done {
            ctx.note(defaults::render("migrate_msg.note_growing", &[("path", &p.display())]));
            rep.errors += 1;
        }
    }
    rep
}

/// `migrate-reply-state`: normalize every `*-replies.json` to the append-only line shape, keeping each sender's latest reply.
pub(super) fn reply_state(ctx: &Ctx, rows: &mut Vec<Row>) {
    migration_fix(
        rows,
        ctx,
        step("reply"),
        step("reply"),
        || {
            let r = migrate_reply_state(ctx, true);
            Ok(Detect { pending: r.pending > 0, detail: defaults::render("migrate_msg.reply_files", &[("n", &r.pending)]) })
        },
        || {
            migrate_reply_state(ctx, false);
            Ok(())
        },
    );
}

// ---- gate-loop state files --------------------------------------------------------------------------------------------

/// `migrateGateIntentsShape(home, {dryRun})`: every gate-loop state file gains `intents: {}` and `intentAcks: 0` when it lacks
/// them, every other field kept.
fn migrate_gate_intents(ctx: &Ctx, dry_run: bool) -> Report {
    let mut rep = Report::default();
    let dir = gate_dir(ctx);
    let excluded = crate::checks::lit_re(defaults::text("migrate.gate_state_excluded_re"));
    let (k_intents, k_acks) = (defaults::text("migrate.gate_intents_key"), defaults::text("migrate.gate_acks_key"));
    for name in list_dir(ctx, &dir) {
        if !(name.ends_with(json_ext()) && !excluded.is_match(&name)) {
            continue;
        }
        let p = dir.join(&name);
        match std::fs::metadata(&p) {
            Ok(md) if md.is_file() => {}
            Ok(_) => continue,
            Err(e) => {
                ctx.io_note("stat", &p, &e);
                rep.errors += 1;
                continue;
            }
        }
        rep.scanned += 1;
        let raw = match read_text(&p) {
            Ok(r) => r,
            Err(e) => {
                ctx.io_note("open", &p, &e);
                rep.errors += 1;
                continue;
            }
        };
        let trimmed = js_trim(&raw);
        let parsed = if trimmed.is_empty() { Some(J::Obj(Vec::new())) } else { parse_json(trimmed) };
        let Some(parsed) = parsed.filter(is_object) else {
            ctx.note(defaults::render("migrate_msg.note_not_object", &[("path", &p.display())]));
            rep.errors += 1;
            continue;
        };
        let (has_intents, has_acks) = (has_own(&parsed, k_intents), has_own(&parsed, k_acks));
        if has_intents && has_acks {
            rep.already += 1;
            continue;
        }
        rep.pending += 1;
        if dry_run {
            continue;
        }
        let mut next = parsed;
        if !has_intents {
            next.set(k_intents, J::Obj(Vec::new()));
        }
        if !has_acks {
            next.set(k_acks, J::Num(defaults::num("migrate.gate_acks_default") as f64));
        }
        match write_atomic(&p, &json::stringify(&next)) {
            Ok(()) => rep.migrated += 1,
            Err(e) => {
                ctx.io_note("open", &p, &e);
                rep.errors += 1;
            }
        }
    }
    rep
}

/// `migrate-gate-intents`.
pub(super) fn gate_intents(ctx: &Ctx, rows: &mut Vec<Row>) {
    migration_fix(
        rows,
        ctx,
        step("gate"),
        step("gate"),
        || {
            let r = migrate_gate_intents(ctx, true);
            Ok(Detect { pending: r.pending > 0, detail: defaults::render("migrate_msg.gate_files", &[("n", &r.pending)]) })
        },
        || {
            migrate_gate_intents(ctx, false);
            Ok(())
        },
    );
}

// ---- the durable auto-archive record ----------------------------------------------------------------------------------

fn auto_archived_path(ctx: &Ctx) -> PathBuf {
    ctx.devswarm().join(defaults::text("migrate.auto_archived_file"))
}

/// `readAutoArchivedState`: `{id: [{doneHead, at}]}`, `{}` when the file is missing, unreadable or not an object.
fn read_auto_archived(ctx: &Ctx) -> J {
    match super::read_json_note(ctx, &auto_archived_path(ctx)) {
        Some(j @ J::Obj(_)) => j,
        _ => J::Obj(Vec::new()),
    }
}

/// A list entry that is truthy (`e && ...`): an object, a non-empty string, a non-zero number, `true`.
fn is_truthy_entry(e: &J) -> bool {
    j_truthy(Some(e))
}

/// `autoArchivedStateAppend(home, id, doneHead, at)`: append one record unless one for the same head is there.
fn auto_archived_append(ctx: &Ctx, id: &str, done_head: &J, at: f64) {
    let p = auto_archived_path(ctx);
    let mut state = read_auto_archived(ctx);
    let mut list = match state.get(id) {
        Some(J::Arr(a)) => a.clone(),
        _ => Vec::new(),
    };
    if list.iter().any(|e| is_truthy_entry(e) && j_strict_eq(e.get("doneHead"), Some(done_head))) {
        return;
    }
    list.push(J::Obj(vec![("doneHead".into(), done_head.clone()), ("at".into(), J::Num(at))]));
    state.set(id, J::Arr(list));
    if let Some(dir) = p.parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        ctx.io_note("mkdir", dir, &e);
        return;
    }
    if let Err(e) = write_atomic(&p, &json::stringify(&state)) {
        ctx.io_note("open", &p, &e);
    }
}

/// The `at` of a record to seed: the record's own `at` when it is a finite number, else its `ts` parsed, else now.
fn seed_time(r: &J) -> f64 {
    let at = match r.get("at") {
        Some(a) if !matches!(a, J::Null) => match a {
            J::Num(n) => *n,
            _ => f64::NAN,
        },
        _ => match r.get("ts") {
            Some(t) if j_truthy(Some(t)) => match date::parse(&j_string(t)) {
                date::Parsed::Ms(ms) => ms,
                _ => f64::NAN,
            },
            _ => date::now_ms(),
        },
    };
    if at.is_finite() { at } else { date::now_ms() }
}

/// `migrateAutoArchivedState(home, {dryRun})`: seed the durable record from every successful `auto-archive` line of the log,
/// read one line at a time.
fn migrate_auto_archived(ctx: &Ctx, dry_run: bool) -> Report {
    let mut rep = Report::default();
    let log = ctx.base().join(defaults::text("migrate.logs_dir")).join(defaults::text("migrate.auto_archive_log"));
    let mut existing = read_auto_archived(ctx);
    let action = defaults::text("migrate.auto_archive_action");
    let mut each = |l: &str| {
        let Some(r) = parse_json(l) else {
            rep.errors += 1;
            return;
        };
        let wanted = matches!(r.get("action"), Some(J::Str(a)) if a == action) && matches!(r.get("ok"), Some(J::Bool(true))) && j_truthy(r.get("id"));
        if !wanted {
            return;
        }
        rep.scanned += 1;
        let key = j_string(r.get("id").unwrap_or(&J::Null));
        let list = match existing.get(&key) {
            Some(J::Arr(a)) => a.clone(),
            _ => Vec::new(),
        };
        let done_head = r.get("doneHead");
        if list.iter().any(|e| is_truthy_entry(e) && j_strict_eq(e.get("doneHead"), done_head)) {
            return;
        }
        rep.pending += 1;
        if dry_run {
            return;
        }
        let at = seed_time(&r);
        let head = if j_truthy(done_head) { done_head.cloned().unwrap_or(J::Null) } else { J::Null };
        auto_archived_append(ctx, &key, &head, at);
        let mut list = list;
        list.push(J::Obj(vec![("doneHead".into(), head), ("at".into(), J::Num(at))]));
        existing.set(&key, J::Arr(list));
        rep.migrated += 1;
    };
    match for_each_line(&log, &mut each) {
        Ok(too_long) => {
            if too_long > 0 {
                ctx.note(defaults::render("migrate_msg.note_long_lines", &[("path", &log.display()), ("n", &too_long)]));
                rep.errors += too_long;
            }
        }
        Err(e) => ctx.io_note("open", &log, &e),
    }
    rep
}

/// `migrate-auto-archived-state`.
pub(super) fn auto_archived(ctx: &Ctx, rows: &mut Vec<Row>) {
    migration_fix(
        rows,
        ctx,
        step("archived"),
        step("archived"),
        || {
            let r = migrate_auto_archived(ctx, true);
            Ok(Detect { pending: r.pending > 0, detail: defaults::render("migrate_msg.archive_records", &[("n", &r.pending)]) })
        },
        || {
            migrate_auto_archived(ctx, false);
            Ok(())
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn ctx(name: &str) -> Ctx {
        let home = std::env::temp_dir().join(format!("ah-state-unit-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&home).expect("temp home");
        Ctx::new(home.to_string_lossy().into_owned(), home.to_string_lossy().into_owned(), BTreeMap::new(), false, None, None)
    }

    fn cleanup(c: &Ctx) {
        std::fs::remove_dir_all(&c.home).expect("cleanup");
    }

    #[test]
    fn a_reply_file_needs_migration_only_when_a_line_is_not_an_append_record() {
        assert_eq!(needs_migration(""), Some(false));
        assert_eq!(needs_migration("  \n\n"), Some(false));
        assert_eq!(needs_migration("{\"m\":\"a\",\"t\":1}\n{\"m\":\"b\",\"t\":2}\n"), Some(false));
        assert_eq!(needs_migration("{\"a\":{\"lastReplyTs\":1}}"), Some(true));
        assert_eq!(needs_migration("{\"m\":\"a\",\"t\":1}\njunk"), Some(true));
        assert_eq!(needs_migration("{\"m\":\"a\",\"t\":\"1\"}"), Some(true), "a string timestamp is not a record");
    }

    #[test]
    fn the_fold_keeps_each_senders_latest_and_reads_every_prior_shape() {
        let raw = "{\"a\":{\"lastReplyTs\":10},\"b\":{\"lastReplyTs\":5}}\n{\"m\":\"a\",\"t\":30}\n{\"m\":\"a\",\"t\":20}\nnot json\n[1]\n";
        let mut folded = fold_reply_log(raw).expect("readable");
        folded.sort_by(|x, y| x.0.cmp(&y.0));
        assert_eq!(folded, vec![("a".to_string(), 30.0), ("b".to_string(), 5.0)]);
        // the same fold of its own output is the same (idempotent)
        let once = serialize_replies(folded.clone());
        let again = serialize_replies(fold_reply_log(&once).expect("readable"));
        assert_eq!(once, again);
    }

    #[test]
    fn senders_sort_by_utf16_unit_like_array_sort() {
        // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FFFF in UTF-16 but after it by code point
        let out = serialize_replies(vec![("\u{FFFF}".to_string(), 1.0), ("\u{1F600}".to_string(), 2.0)]);
        assert!(out.find('\u{1F600}').expect("a") < out.find('\u{FFFF}').expect("b"));
    }

    #[test]
    fn gate_files_gain_the_new_keys_once_and_a_corrupt_one_is_left_alone() {
        let c = ctx("gate");
        let dir = gate_dir(&c);
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("a.json"), "{\"blocks\":2}").expect("write");
        std::fs::write(dir.join("bad.json"), "{nope").expect("write");
        let first = migrate_gate_intents(&c, false);
        assert_eq!((first.pending, first.migrated, first.errors), (1, 1, 1));
        assert_eq!(std::fs::read_to_string(dir.join("a.json")).expect("read"), "{\"blocks\":2,\"intents\":{},\"intentAcks\":0}");
        assert_eq!(std::fs::read_to_string(dir.join("bad.json")).expect("read"), "{nope", "left exactly as it was");
        let second = migrate_gate_intents(&c, false);
        assert_eq!((second.pending, second.migrated, second.already), (0, 0, 1), "a second run finds nothing to do");
        assert!(!c.take_notes().is_empty(), "the corrupt file is reported, not swallowed");
        cleanup(&c);
    }
}
