//! Persisted-state migrations and sweeps (D81): what the Node doctor's repair pass (`doctor.js --repair`, `runRepairs` with
//! `migrationsOnly`) does to the files under the home directory, as the engine does it.
//!
//! Every step has the Node contract: idempotent (a second run finds nothing to do), fail-open (an error is counted and
//! reported, never thrown, and blocks the completion marker so the next run retries), and it never deletes a message or a
//! repo file. The two steps that remove files (the stale lock scratch sweep and the age-based retention sweeps) remove only
//! files older than their window, exactly as the Node ones do. A forward migration reads every earlier shape of the data it
//! owns (the repo's persisted-shape rule) and leaves a file it cannot parse exactly as it is.
//!
//! The report is Node's: one row per step `{id, action, status, msg}`, in Node's order, with Node's texts, so the two can be
//! compared byte for byte (`tests/migrate_parity.rs` does, on seeded homes, comparing the resulting file trees too).
//!
//! Scope. The steps that work on plain files are here. The steps that need the DevSwarm stores (the per-project SQLite and
//! journal stores, the workspace registry and descriptors) are not in the engine yet: while any of those directories holds an
//! entry, such a step reports `skipped`, says it is left to the Node doctor, and does not stamp its marker, so the Node doctor
//! still does it. With no DevSwarm state they report exactly what Node reports ("nothing to migrate") and stamp.
pub mod cli;
pub mod settings;
pub mod state;
pub mod sweeps;

use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::{date, num};
use crate::defaults;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

/// Why a migration step failed: the file call that failed, or a plain reason. The text of a failed step's row is the Display of
/// this (for a file call, Node's own error text), and `source()` keeps the underlying I/O error.
#[derive(Debug)]
pub enum Error {
    /// A file call failed.
    Io {
        /// The call (`open`, `rename`, `mkdir`, ...).
        call: &'static str,
        /// The path it was made on.
        path: PathBuf,
        /// What the operating system said.
        source: io::Error,
    },
    /// Anything else, as text.
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io { call, path, source } => f.write_str(&node_err(source, call, path)),
            Error::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io { source, .. } => Some(source),
            Error::Other(_) => None,
        }
    }
}

/// One report row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    /// The step.
    pub id: String,
    /// What it would do (usually the id).
    pub action: String,
    /// `fixed`, `skipped`, `failed`, or `gated`.
    pub status: String,
    /// What happened.
    pub msg: String,
}

impl Row {
    fn new(id: &str, action: &str, status: &str, msg: String) -> Row {
        Row { id: id.to_string(), action: action.to_string(), status: status.to_string(), msg }
    }

    /// The row as the JSON object Node prints.
    pub fn to_j(&self) -> J {
        let s = |v: &str| J::Str(v.to_string());
        J::Obj(vec![("id".into(), s(&self.id)), ("action".into(), s(&self.action)), ("status".into(), s(&self.status)), ("msg".into(), s(&self.msg))])
    }
}

/// What a run works on.
#[derive(Debug, Clone)]
pub struct Ctx {
    /// The home directory whose `.anti-hall` is migrated.
    pub home: String,
    /// The directory the legacy per-project state is looked for in.
    pub cwd: String,
    /// The environment of this process, snapshotted once at the command line.
    pub env: BTreeMap<String, String>,
    /// Preview only: nothing is written.
    pub dry_run: bool,
    /// The plugin version a completed migration is stamped with (`None`: nothing is stamped).
    pub version: Option<String>,
    /// The plugin root, where the manifest that declares the headline options' defaults is (`None`: unknown).
    pub plugin_root: Option<String>,
    /// What the steps met and could not put in a row: Node swallows these errors (fail-open); the engine never drops one
    /// silently, it keeps it here and the command prints it on stderr.
    pub notes: std::cell::RefCell<Vec<String>>,
}

impl Ctx {
    /// A context with no notes yet.
    pub fn new(home: String, cwd: String, env: BTreeMap<String, String>, dry_run: bool, version: Option<String>, plugin_root: Option<String>) -> Ctx {
        Ctx { home, cwd, env, dry_run, version, plugin_root, notes: std::cell::RefCell::new(Vec::new()) }
    }

    /// Record something a step swallowed (bounded: past `migrate.max_notes` only the count grows).
    pub(crate) fn note(&self, msg: String) {
        let mut n = self.notes.borrow_mut();
        if n.len() < defaults::num("migrate.max_notes") as usize && !n.contains(&msg) {
            n.push(msg);
        }
    }

    /// Record a failed file call, unless the file is simply not there (a missing file is a normal state, and a file that
    /// vanishes between a listing and a read is a race the sweeps expect).
    pub(crate) fn io_note(&self, what: &str, path: &Path, e: &io::Error) {
        if !is_enoent(e) {
            self.note(defaults::render("migrate_msg.note_io", &[("what", &what), ("path", &path.display()), ("error", &node_err(e, what, path))]));
        }
    }

    /// The notes so far.
    pub fn take_notes(&self) -> Vec<String> {
        self.notes.borrow().clone()
    }

    /// `<home>/<base_dir>`.
    pub(crate) fn base(&self) -> PathBuf {
        Path::new(&self.home).join(defaults::text("migrate.base_dir"))
    }

    /// `<home>/<base_dir>/<devswarm_dir>`.
    pub(crate) fn devswarm(&self) -> PathBuf {
        self.base().join(defaults::text("migrate.devswarm_dir"))
    }
}

// ---- small JavaScript-semantics helpers shared by the steps ---------------------------------------------------------

/// A step id (or action word) of the report, from `migrate.ids`.
pub(crate) fn step(key: &str) -> &'static str {
    defaults::raw("migrate.ids").str_field(key)
}

/// The extension of a JSON state file.
pub(crate) fn json_ext() -> &'static str {
    defaults::text("migrate.json_ext")
}

/// `fs.readFileSync(p, 'utf8')`: invalid UTF-8 becomes U+FFFD. Bounded: a file larger than `migrate.max_file_bytes` is not read
/// (the error says so), because no state file of this kind is that large and reading one whole would cost its size in memory.
pub(crate) fn read_text(p: &Path) -> io::Result<String> {
    read_capped(p, defaults::num("migrate.max_file_bytes"))
}

/// [`read_text`] with the limit given.
fn read_capped(p: &Path, cap: u64) -> io::Result<String> {
    use std::io::Read;
    let f = std::fs::File::open(p)?;
    let mut bytes = Vec::new();
    f.take(cap + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Err(io::Error::new(io::ErrorKind::InvalidData, defaults::render("migrate_msg.too_large", &[("cap", &cap)])));
    }
    // valid UTF-8 (the usual case) reuses the buffer; only a file with invalid bytes pays for the replacement copy
    Ok(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

/// [`read_text`] for a file whose absence is normal: `None` when it is missing, and every other failure is noted.
pub(crate) fn read_text_note(ctx: &Ctx, p: &Path) -> Option<String> {
    match read_text(p) {
        Ok(t) => Some(t),
        Err(e) => {
            ctx.io_note("open", p, &e);
            None
        }
    }
}

/// A JSON state file: `None` when it is missing, or unreadable or unparseable (the latter two are noted, and the caller
/// leaves the file exactly as it is).
pub(crate) fn read_json_note(ctx: &Ctx, p: &Path) -> Option<J> {
    let text = read_text_note(ctx, p)?;
    let parsed = parse_json(&text);
    if parsed.is_none() {
        ctx.note(defaults::render("migrate_msg.note_unparseable", &[("path", &p.display())]));
    }
    parsed
}

/// Feed each non-empty line of a file (without its `\n`) to `f`, reading one line at a time. Returns how many lines were
/// longer than `migrate.max_line_bytes`: those are skipped, never buffered whole.
pub(crate) fn for_each_line(p: &Path, f: impl FnMut(&str)) -> io::Result<u64> {
    lines_capped(p, defaults::num("migrate.max_line_bytes"), f)
}

/// [`for_each_line`] with the limit given.
fn lines_capped(p: &Path, cap: u64, mut f: impl FnMut(&str)) -> io::Result<u64> {
    use std::io::{BufRead, BufReader, Read};
    let mut r = BufReader::new(std::fs::File::open(p)?);
    let (mut buf, mut too_long) = (Vec::new(), 0u64);
    loop {
        buf.clear();
        if r.by_ref().take(cap + 1).read_until(b'\n', &mut buf)? == 0 {
            return Ok(too_long);
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
        } else if buf.len() as u64 > cap {
            too_long += 1;
            loop {
                let (done, used) = {
                    let rest = r.fill_buf()?;
                    match rest.iter().position(|b| *b == b'\n') {
                        Some(i) => (true, i + 1),
                        None => (rest.is_empty(), rest.len()),
                    }
                };
                r.consume(used);
                if done {
                    break;
                }
            }
            continue;
        }
        if !buf.is_empty() {
            f(&String::from_utf8_lossy(&buf));
        }
    }
}

/// `JSON.parse` of a file's text; `None` when it throws (or holds JSON this port does not reproduce).
pub(crate) fn parse_json(text: &str) -> Option<J> {
    json::parse(text, defaults::num("migrate.json_depth") as usize).ok()
}

/// `String(v)` of a parsed value.
pub(crate) fn j_string(v: &J) -> String {
    match v {
        J::Null => "null".into(),
        J::Bool(b) => b.to_string(),
        J::Num(n) => num::to_js_string(*n),
        J::Str(s) => s.clone(),
        J::Arr(a) => a.iter().map(|x| if matches!(x, J::Null) { String::new() } else { j_string(x) }).collect::<Vec<_>>().join(","),
        J::Obj(_) => "[object Object]".into(),
    }
}

/// `Number(v)` of a parsed value.
pub(crate) fn j_number(v: &J) -> f64 {
    match v {
        J::Null => 0.0,
        J::Bool(b) => f64::from(u8::from(*b)),
        J::Num(n) => *n,
        J::Str(s) => str_number(s),
        J::Arr(_) => str_number(&j_string(v)),
        J::Obj(_) => f64::NAN,
    }
}

/// `Number(s)` of a string: trimmed, empty is 0, anything that is not a number is NaN.
pub(crate) fn str_number(s: &str) -> f64 {
    let t = crate::checks::guardkit::text::js_trim(s);
    match num::parse_js_number(t) {
        num::JsNum::Val(v) => v,
        _ => f64::NAN,
    }
}

/// Truthiness of a parsed value.
pub(crate) fn j_truthy(v: Option<&J>) -> bool {
    match v {
        None | Some(J::Null) => false,
        Some(J::Bool(b)) => *b,
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Number.isFinite(v)` of an optional parsed value: only a number counts.
pub(crate) fn j_finite(v: Option<&J>) -> Option<f64> {
    match v {
        Some(J::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// `a === b` for two optional parsed values: scalars by value, objects and arrays never (they are distinct objects).
pub(crate) fn j_strict_eq(a: Option<&J>, b: Option<&J>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(J::Null), Some(J::Null)) => true,
        (Some(J::Bool(x)), Some(J::Bool(y))) => x == y,
        (Some(J::Num(x)), Some(J::Num(y))) => x == y,
        (Some(J::Str(x)), Some(J::Str(y))) => x == y,
        _ => false,
    }
}

/// A plain object (not an array): the shape every state file must have.
pub(crate) fn is_object(v: &J) -> bool {
    matches!(v, J::Obj(_))
}

/// `Object.prototype.hasOwnProperty.call(o, key)`.
pub(crate) fn has_own(v: &J, key: &str) -> bool {
    v.get(key).is_some()
}

/// The text of the Node error for a failed file call (`ENOENT: no such file or directory, scandir '/x'`).
pub(crate) fn node_err(e: &io::Error, syscall: &str, path: &Path) -> String {
    let errno = e.raw_os_error().map(i64::from);
    let hit = defaults::raw("migrate.errnos").as_array().unwrap_or_default().iter().find(|t| t.get("errno").and_then(defaults::V::as_integer) == errno);
    let table = hit.unwrap_or_else(|| defaults::raw("migrate.errno_fallback"));
    defaults::render(
        "migrate_msg.node_error",
        &[("code", &table.str_field("code")), ("text", &table.str_field("text")), ("syscall", &syscall), ("path", &path.display())],
    )
}

/// True when the error is "no such file or directory".
pub(crate) fn is_enoent(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::NotFound
}

/// `fs.readdirSync(dir)`: the names, sorted bytewise as libuv does. Bounded by `migrate.max_dir_entries`: a larger directory is an
/// error (so the step reports it) rather than a list that costs its size in memory; the retention sweeps stream instead.
pub(crate) fn read_dir_sorted(dir: &Path) -> io::Result<Vec<String>> {
    let cap = defaults::num("migrate.max_dir_entries") as usize;
    let mut names: Vec<String> = Vec::new();
    for e in std::fs::read_dir(dir)? {
        if names.len() >= cap {
            return Err(io::Error::new(io::ErrorKind::InvalidData, defaults::render("migrate_msg.dir_too_large", &[("cap", &cap)])));
        }
        names.push(e?.file_name().to_string_lossy().into_owned());
    }
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(names)
}

/// A unique suffix for a scratch file: `<pid>.<ms>`.
pub(crate) fn scratch_suffix() -> String {
    format!("{}.{}", std::process::id(), num::to_js_string(date::now_ms()))
}

/// A short random base-36 string (`Math.random().toString(36).slice(2)`).
pub(crate) fn rand36() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(date::now_ms() as u64);
    h.write_u32(std::process::id());
    let mut n = h.finish();
    let mut out = String::new();
    while n > 0 && out.len() < 11 {
        out.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
    }
    out
}

/// Write `text` to `path` atomically ([`crate::atomic::write`]: a uniquely named temporary file beside it, flushed to disk,
/// then renamed), as every Node writer here writes through a scratch file and a rename. The temporary file does not outlive
/// a failure.
pub(crate) fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    crate::atomic::write(path, text)
}

// ---- the completion markers -----------------------------------------------------------------------------------------

/// The marker file: `update-sweep-state.json`, shared with the Node update and supervisor.
pub(crate) fn marker_path(home: &str) -> PathBuf {
    Path::new(home).join(defaults::text("migrate.base_dir")).join(defaults::text("migrate.markers_file"))
}

/// `readMarkers`: the marker object, `{}` when the file is missing, unreadable or not an object (the latter two are noted).
pub(crate) fn read_markers(ctx: &Ctx) -> J {
    match read_json_note(ctx, &marker_path(&ctx.home)) {
        Some(j @ J::Obj(_)) => j,
        _ => J::Obj(Vec::new()),
    }
}

/// `isApplied(state, key, version)`.
pub(crate) fn is_applied(state: &J, key: &str, version: Option<&str>) -> bool {
    let Some(v) = version.filter(|v| !v.is_empty()) else { return false };
    state.get(key).and_then(|s| s.get("completedVersion")).is_some_and(|c| matches!(c, J::Str(s) if s == v))
}

/// `markApplied`: re-read the file, set this key's stamp, write it back (other keys kept).
pub(crate) fn mark_applied(ctx: &Ctx, key: &str, version: Option<&str>) -> bool {
    let Some(version) = version.filter(|v| !v.is_empty()) else { return false };
    let mut state = read_markers(ctx);
    let mut entry = match state.get(key) {
        Some(e @ J::Obj(_)) => e.clone(),
        _ => J::Obj(Vec::new()),
    };
    for (k, v) in [
        ("completedVersion", J::Str(version.to_string())),
        ("completedTs", J::Num(date::now_ms())),
        ("pendingVersion", J::Null),
        ("pendingHashes", J::Arr(Vec::new())),
        ("lastCompletedHash", J::Null),
    ] {
        entry.set(k, v);
    }
    state.set(key, entry);
    let file = marker_path(&ctx.home);
    if let Some(dir) = file.parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        ctx.io_note("mkdir", dir, &e);
        return false;
    }
    match write_atomic(&file, &json::stringify(&state)) {
        Ok(()) => true,
        Err(e) => {
            ctx.io_note("open", &file, &e);
            false
        }
    }
}

// ---- the DevSwarm state this port does not migrate --------------------------------------------------------------------

/// True when any DevSwarm directory the engine does not migrate holds an entry (see the module docs). A directory that cannot be
/// read counts as holding one: the step is then left to the Node doctor rather than reported done on a guess.
pub(crate) fn devswarm_state_present(ctx: &Ctx) -> bool {
    defaults::list("migrate.devswarm_state_dirs").iter().any(|d| {
        let dir = ctx.devswarm().join(d);
        match std::fs::read_dir(&dir) {
            Ok(mut r) => r.next().is_some(),
            Err(e) if is_enoent(&e) => false,
            Err(e) => {
                ctx.io_note("scandir", &dir, &e);
                true
            }
        }
    })
}

/// The names of the store directories (`store/<hash>`), as `listStoreHashes`.
pub(crate) fn list_store_hashes(ctx: &Ctx) -> Vec<String> {
    let res: Vec<regex::Regex> = defaults::list("migrate.store_hash_res").iter().map(|p| crate::checks::lit_re(p)).collect();
    let dir = ctx.devswarm().join(defaults::text("migrate.store_dir"));
    match read_dir_sorted(&dir) {
        Ok(names) => names.into_iter().filter(|n| res.iter().any(|r| r.is_match(n))).collect(),
        Err(e) => {
            ctx.io_note("scandir", &dir, &e);
            Vec::new()
        }
    }
}

// ---- the pass ---------------------------------------------------------------------------------------------------------

/// What a detect step found.
pub(crate) struct Detect {
    pub pending: bool,
    pub detail: String,
}

/// A step's detect or apply half.
pub(crate) type StepResult<T> = Result<T, Error>;

/// `migrationFix`: detect, preview or apply, detect again; one row.
pub(crate) fn migration_fix(
    rows: &mut Vec<Row>,
    ctx: &Ctx,
    id: &str,
    action: &str,
    mut detect: impl FnMut() -> StepResult<Detect>,
    mut apply: impl FnMut() -> StepResult<()>,
) {
    let mut push = |status: &str, msg: String| rows.push(Row::new(id, action, status, msg));
    let mut run = || -> StepResult<(String, String)> {
        let before = detect()?;
        if !before.pending {
            return Ok(("skipped".into(), defaults::text("migrate_msg.nothing").to_string()));
        }
        if ctx.dry_run {
            return Ok(("skipped".into(), defaults::render("migrate_msg.dry_run", &[("detail", &before.detail)])));
        }
        apply()?;
        let after = detect()?;
        if !after.pending {
            Ok(("fixed".into(), defaults::render("migrate_msg.migrated", &[("detail", &before.detail)])))
        } else {
            Ok(("failed".into(), defaults::render("migrate_msg.still_pending", &[("detail", &after.detail)])))
        }
    };
    match run() {
        Ok((status, msg)) => push(&status, msg),
        Err(e) => push("failed", defaults::render("migrate_msg.raised", &[("id", &id), ("error", &e.to_string())])),
    }
}

/// The deferral row of a step that needs the DevSwarm stores while DevSwarm state is present.
fn deferred(id: &str, action: &str) -> Row {
    Row::new(id, action, "skipped", defaults::text("migrate_msg.deferred").to_string())
}

/// The registry of all-store forward-migrations (`runMigrations`): each is a store-backed step, so with no DevSwarm state it
/// reports "nothing to migrate" and stamps its marker, and with DevSwarm state it is deferred to the Node doctor.
fn run_registry(ctx: &Ctx, rows: &mut Vec<Row>) {
    let state = read_markers(ctx);
    let version = ctx.version.as_deref();
    for entry in defaults::list("migrate.registry") {
        let (id, key) = entry.split_once(':').unwrap_or((entry, entry));
        if is_applied(&state, key, version) {
            rows.push(Row::new(id, id, "skipped", defaults::render("migrate_msg.already_applied", &[("version", &version.unwrap_or(""))])));
            continue;
        }
        if devswarm_state_present(ctx) {
            rows.push(deferred(id, id));
            continue;
        }
        // a preview stamps nothing; a run stamps when it can, and says so when it could not
        let stamp_failed = !ctx.dry_run && version.is_some() && !mark_applied(ctx, key, version);
        let tail = if stamp_failed { defaults::text("migrate_msg.marker_failed") } else { "" };
        rows.push(Row::new(id, id, "skipped", format!("{}{tail}", defaults::text("migrate_msg.nothing"))));
    }
}

/// The store-backed `migrationFix` steps that sit outside the registry (`migrate-devswarm-store`, `fold-mesh-duplicates`,
/// `owner-key-migrate`, `recover-archive-intent`): "nothing to migrate" with no DevSwarm state, else deferred.
fn store_fix(ctx: &Ctx, rows: &mut Vec<Row>, id: &str) {
    if devswarm_state_present(ctx) {
        rows.push(deferred(id, id));
    } else {
        rows.push(Row::new(id, id, "skipped", defaults::text("migrate_msg.nothing").to_string()));
    }
}

/// `heal-registry-rows`: sweeps every per-project store; with none it has nothing to check.
fn heal_registry_rows(ctx: &Ctx, rows: &mut Vec<Row>) {
    let id = step("heal");
    if ctx.dry_run {
        rows.push(Row::new(id, id, "skipped", defaults::text("migrate_msg.heal_dry_run").to_string()));
    } else if !list_store_hashes(ctx).is_empty() {
        rows.push(deferred(id, id));
    } else {
        rows.push(Row::new(id, id, "skipped", defaults::text("migrate_msg.heal_none").to_string()));
    }
}

/// The repair pass of `doctor --repair --migrations-only`: the stamped data migrations, then the home sweeps. Rows are in
/// the order `runRepairs` pushes them.
pub fn run(ctx: &Ctx) -> Vec<Row> {
    let mut rows = Vec::new();
    state::legacy_state(ctx, &mut rows);
    store_fix(ctx, &mut rows, step("store"));
    state::reply_state(ctx, &mut rows);
    state::gate_intents(ctx, &mut rows);
    state::auto_archived(ctx, &mut rows);
    sweeps::lock_scratch(ctx, &mut rows);
    store_fix(ctx, &mut rows, step("mesh"));
    run_registry(ctx, &mut rows);
    if !ctx.dry_run {
        settings::settings_migration(ctx, &mut rows);
    }
    settings::jev_triage_cache(ctx, &mut rows);
    store_fix(ctx, &mut rows, step("owner"));
    store_fix(ctx, &mut rows, step("recover"));
    heal_registry_rows(ctx, &mut rows);
    sweeps::all(ctx, &mut rows);
    statusline_upgrade(ctx, &mut rows);
    rows
}

/// Engine only (Node's repair pass has no such step): a status line command that anti-hall installed in the Node-only form runs
/// the engine first from now on. A row is reported only when a file is changed (or would be, on a dry run, or could not be), so a
/// home with nothing to upgrade reports exactly what Node reports.
fn statusline_upgrade(ctx: &Ctx, rows: &mut Vec<Row>) {
    let id = step("statusline");
    for u in crate::ops::slcfg::upgrade_commands(&ctx.home, &ctx.cwd, &ctx.env, ctx.dry_run) {
        rows.push(Row::new(id, id, u.status, u.msg));
    }
}

/// The report `doctor.js --repair --migrations-only` prints: `{ok, action, version, error, repairs}`.
pub fn report(version: &str, rows: &[Row], error: Option<&str>) -> J {
    let failed = rows.iter().filter(|r| r.status == "failed").count();
    J::Obj(vec![
        ("ok".into(), J::Bool(error.is_none() && failed == 0)),
        ("action".into(), J::Str(defaults::text("migrate.action").to_string())),
        ("version".into(), J::Str(version.to_string())),
        ("error".into(), error.map_or(J::Null, |e| J::Str(e.to_string()))),
        ("repairs".into(), J::Arr(rows.iter().map(Row::to_j).collect())),
    ])
}

/// The plugin version at `plugin_root` (its manifest's `version`), `None` when unreadable (the reason is noted).
pub fn plugin_version(ctx: &Ctx, plugin_root: &str) -> Option<String> {
    match read_json_note(ctx, &Path::new(plugin_root).join(defaults::text("migrate.plugin_manifest")))?.get("version") {
        Some(J::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-migrate-unit-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).expect("temp dir");
        d
    }

    #[test]
    fn lines_are_streamed_blank_ones_skipped_and_over_long_ones_counted() {
        let d = tmp("lines");
        let p = d.join("f.log");
        std::fs::write(&p, "one\r\n\n\ntwo\n0123456789\nexactly10!\nlast no newline").expect("write");
        let mut got = Vec::new();
        let long = lines_capped(&p, 10, |l| got.push(l.to_string())).expect("read");
        assert_eq!(got, vec!["one\r", "two", "0123456789", "exactly10!"]);
        assert_eq!(long, 1, "only the final, longer line is over the limit");
        std::fs::remove_dir_all(&d).expect("cleanup");
    }

    #[test]
    fn a_line_of_exactly_the_limit_is_kept_and_a_file_without_a_final_newline_is_read() {
        let d = tmp("edge");
        let p = d.join("f.log");
        std::fs::write(&p, "abcde\nfghij").expect("write");
        let mut got = Vec::new();
        let long = lines_capped(&p, 5, |l| got.push(l.to_string())).expect("read");
        assert_eq!((got, long), (vec!["abcde".to_string(), "fghij".to_string()], 0));
        std::fs::remove_dir_all(&d).expect("cleanup");
    }

    #[test]
    fn a_file_over_the_limit_is_not_read_and_invalid_utf8_is_replaced() {
        let d = tmp("cap");
        let p = d.join("f");
        std::fs::write(&p, "0123456789").expect("write");
        let e = read_capped(&p, 5).expect_err("over the limit");
        assert_eq!(e.kind(), io::ErrorKind::InvalidData);
        assert_eq!(read_capped(&p, 10).expect("at the limit"), "0123456789");
        std::fs::write(&p, b"a\xffb".as_slice()).expect("write");
        assert_eq!(read_capped(&p, 10).expect("lossy"), "a\u{fffd}b");
        std::fs::remove_dir_all(&d).expect("cleanup");
    }

    #[test]
    fn the_error_keeps_the_source_and_prints_nodes_text() {
        use std::error::Error as _;
        let e = Error::Io { call: "rename", path: PathBuf::from("/x/y"), source: io::Error::from_raw_os_error(13) };
        assert_eq!(e.to_string(), "EACCES: permission denied, rename '/x/y'");
        assert!(e.source().is_some());
        assert!(Error::Other("x".into()).source().is_none());
    }

    #[test]
    fn javascript_conversions_follow_the_language() {
        assert_eq!(j_string(&J::Arr(vec![J::Num(1.0), J::Null, J::Str("a".into())])), "1,,a");
        assert_eq!(j_string(&J::Obj(Vec::new())), "[object Object]");
        assert_eq!(j_number(&J::Str("  12 ".into())), 12.0);
        assert!(j_number(&J::Str("12px".into())).is_nan());
        assert_eq!(j_number(&J::Str(String::new())), 0.0);
        assert!(j_strict_eq(None, None));
        assert!(!j_strict_eq(Some(&J::Null), None), "null is not undefined");
        assert!(!j_strict_eq(Some(&J::Arr(Vec::new())), Some(&J::Arr(Vec::new()))), "two arrays are two objects");
    }
}
