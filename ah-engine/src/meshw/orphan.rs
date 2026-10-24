//! Classification of an orphan partition for the summary projection: `companion/lib/devswarm-orphan-policy.js`
//! `makeArchivedStrandedTest` and `makeForwardedDrainedTest` over `devswarm-archive-gate.js` `resolveArchiveGate`.
//!
//! An orphan is a partition with unread mail and no live registry row. Node sorts it into `archivedStranded[]` (archived, and
//! its worktree family has no registry row at all), `forwardedDrained[]` (archived, the family has a survivor and every unread
//! row is already in the survivor's partition), `heldPartitions[]` or the plain `orphans[]`. All of it is decided here:
//!
//! * the archive gate: no marker of the id that applies, the worktree not archived under another id, a marker that names no
//!   session or the same session, or two different sessions told apart by `isSiblingPartitionLive` (and, for the id's own
//!   marker, by the descriptor being newer than the marker);
//! * the family: the registry rows whose worktree has the same canonical mesh id;
//! * the forwarded-drained proof, which needs the store ([`Classifier::with_store`]): the survivor is the freshest live row of the
//!   family and every unread row of the orphan must have the hash its forward would have in the survivor's partition. Without a
//!   store nothing is proven, which is Node's fail-open answer (the id stays in `orphans[]`).
//!
//! Where Node's answer depends on what the operating system lists first (several archive markers on one worktree), the engine
//! takes the markers in name order, the order Node sees on a sorted listing. A relative path resolves against the caller's
//! working directory, as `realpathSync` does.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::common::Inv;
use crate::meshw::ident::{self, R, Row};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::plan::{js_string, parse_js};
use crate::meshw::store::MeshStore;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// How an orphan with unread mail is sorted before the owner-held check.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Class {
    /// `archivedStranded[]`.
    Stranded,
    /// `forwardedDrained[]`: archived, its family has a survivor, and every unread row is already there.
    ForwardedDrained,
    /// Neither stranded nor forwarded-drained.
    Other,
}

/// One archive marker as the worktree index holds it: its id and session id.
struct Marked {
    id: String,
    sid: Option<String>,
}

/// Per-projection state: the registry's worktrees, the archived-worktree index and the family keys, each built at most once.
pub(crate) struct Classifier<'a> {
    home: PathBuf,
    inv: Inv,
    worktrees: Vec<String>,
    store: Option<&'a MeshStore>,
    index: Option<HashMap<String, Vec<Marked>>>,
    families: Option<HashSet<String>>,
    registry: Option<Vec<Row>>,
    survivors: HashMap<String, HashSet<String>>,
}

fn json_suffix() -> &'static str {
    defaults::text("mesh_write.json_suffix")
}

fn archived_dir(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_archived"))
}

/// A regular file holding a JSON object, as `readDescriptorPathState` accepts it (a link or a directory is no descriptor).
fn read_object(p: &Path) -> Option<OVal> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_file() => {}
        _ => return None,
    }
    let bytes = std::fs::read(p).ok()?;
    match parse_js(&String::from_utf8_lossy(&bytes))? {
        v @ OVal::Obj(_) => Some(v),
        _ => None,
    }
}

/// `x != null && String(x) !== ''` for a session id: the text, `None` for none.
fn sid_of(v: Option<&OVal>) -> Option<String> {
    match v {
        None | Some(OVal::Null) => None,
        Some(x) => Some(js_string(x)).filter(|t| !t.is_empty()),
    }
}

/// `typeof x === 'string' && x ? x : null` for a worktree path: a value that is no string is none.
fn wt_of(v: Option<&OVal>) -> Option<String> {
    match v {
        Some(OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `isLiveSessionId(sessionId)`: a session id that is not empty and not the synthetic placeholder.
fn live_session_id(sid: Option<&str>) -> bool {
    sid.is_some_and(|s| !s.is_empty() && !s.starts_with(defaults::text("mesh_write.synthetic_session_prefix")))
}

fn str_of(v: &serde_json::Value, k: &str) -> Option<String> {
    match &v[k] {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(crate::checks::jsport::num::to_js_string(other.as_f64().unwrap_or(f64::NAN))),
    }
}

/// `statSync(p).mtimeMs`, as a time that compares.
fn mtime(p: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(p).ok()?.modified().ok()
}

impl<'a> Classifier<'a> {
    /// `worktrees`: the worktree path of every registry row that names one. Without a store the forwarded-drained proof is not made.
    pub(crate) fn new(home: &Path, worktrees: Vec<String>) -> Classifier<'a> {
        let env: ident::Env = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
        let cwd = std::env::current_dir().ok().and_then(|c| c.to_str().map(str::to_string)).unwrap_or_default();
        let inv =
            Inv { home: home.to_path_buf(), write_home: home.to_path_buf(), env, cwd, now: crate::meshw::common::now_ms(), stdin: None, store_override: None };
        Classifier { home: home.to_path_buf(), inv, worktrees, store: None, index: None, families: None, registry: None, survivors: HashMap::new() }
    }

    /// [`Classifier::new`] with the store of the projection and its invocation: the forwarded-drained proof is made too.
    pub(crate) fn with_store(inv: &Inv, store: &'a MeshStore, worktrees: Vec<String>) -> Classifier<'a> {
        Classifier {
            home: inv.home.clone(),
            inv: inv.clone(),
            worktrees,
            store: Some(store),
            index: None,
            families: None,
            registry: None,
            survivors: HashMap::new(),
        }
    }

    /// `realWorktreePath(p)`: the real path, else the text as it is (a worktree that is gone). A relative path resolves against the
    /// working directory, as `realpathSync` does.
    fn real_or_raw(&self, p: &str) -> String {
        let abs = if p.starts_with('/') { p.to_string() } else { ident::resolve(&self.inv.cwd, p) };
        ident::realpath(&abs).unwrap_or_else(|| p.to_string())
    }

    /// `buildArchivedWorktreeIndex`: the real worktree path of every archive marker that names one, to the markers.
    fn index(&mut self) -> &HashMap<String, Vec<Marked>> {
        if self.index.is_none() {
            let mut out: HashMap<String, Vec<Marked>> = HashMap::new();
            let dir = archived_dir(&self.home);
            let mut names: Vec<String> = match std::fs::read_dir(&dir) {
                Ok(rd) => rd.flatten().filter_map(|e| e.file_name().into_string().ok()).collect(),
                Err(_) => Vec::new(),
            };
            names.sort();
            for n in names {
                let Some(id) = n.strip_suffix(json_suffix()) else { continue };
                if !is_safe_id(id) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(dir.join(&n)) else { continue };
                let Some(marker) = parse_js(&String::from_utf8_lossy(&bytes)) else { continue };
                let Some(wt) = wt_of(marker.get(defaults::text("mesh_write.field_worktree_path"))) else { continue };
                let sid = sid_of(marker.get(defaults::text("mesh_write.field_session_id")));
                out.entry(self.real_or_raw(&wt)).or_default().push(Marked { id: id.to_string(), sid });
            }
            self.index = Some(out);
        }
        self.index.get_or_insert_with(HashMap::new)
    }

    /// The canonical mesh ids of the registry rows (`groupRegistryByMeshId`'s keys).
    fn families(&mut self) -> R<&HashSet<String>> {
        if self.families.is_none() {
            let mut keys = HashSet::new();
            for wt in &self.worktrees {
                if let Some(k) = ident::canonical_mesh_id(wt)? {
                    keys.insert(k);
                }
            }
            self.families = Some(keys);
        }
        Ok(self.families.get_or_insert_with(HashSet::new))
    }

    /// `resolveOrphanDescriptor`: the live descriptor, else the archive marker of the id.
    fn descriptor(&self, id: &str) -> Option<OVal> {
        let file = format!("{id}{}", json_suffix());
        read_object(&devswarm_root(&self.home).join(defaults::text("mesh_write.dir_workspaces")).join(&file))
            .or_else(|| read_object(&archived_dir(&self.home).join(&file)))
    }

    /// `resolveArchiveGate(...)`: `archived && !migrateAsLive`.
    fn archived(&mut self, id: &str, desc: &OVal) -> R<bool> {
        if !is_safe_id(id) {
            return Ok(false);
        }
        let desc_wt = wt_of(desc.get(defaults::text("mesh_write.field_worktree_path")));
        let desc_sid = sid_of(desc.get(defaults::text("mesh_write.field_session_id")));
        let marker_path = archived_dir(&self.home).join(format!("{id}{}", json_suffix()));
        let mut marker: Option<OVal> = None;
        if let Ok(bytes) = std::fs::read(&marker_path) {
            match parse_js(&String::from_utf8_lossy(&bytes)) {
                Some(m @ (OVal::Obj(_) | OVal::Arr(_))) => marker = Some(m),
                _ => return Ok(true), // archived-marker-unreadable: a marker file exists, its content proves nothing; never resurrect
            }
        }
        if let (Some(m), Some(dwt)) = (&marker, &desc_wt)
            && let Some(mwt) = wt_of(m.get(defaults::text("mesh_write.field_worktree_path")))
            && self.real_or_raw(&mwt) != self.real_or_raw(dwt)
        {
            marker = None; // a new workspace reusing the id
        }
        // the session the marker names: the id's own marker, else the marker of a sibling archived on the same worktree
        let mut marker_sid = marker.as_ref().and_then(|m| sid_of(m.get(defaults::text("mesh_write.field_session_id"))));
        let mut group = false;
        if marker.is_none()
            && let Some(dwt) = &desc_wt
        {
            let real = self.real_or_raw(dwt);
            let hits: Vec<(String, Option<String>)> =
                self.index().get(&real).map(|h| h.iter().map(|x| (x.id.clone(), x.sid.clone())).collect()).unwrap_or_default();
            // the hit Node takes follows the listing order of the directory; the engine lists by name
            if let Some((_, sid)) = hits.iter().find(|(h, _)| h != id).or(hits.first()) {
                group = true;
                marker_sid = sid.clone();
            }
        }
        if marker.is_none() && !group {
            return Ok(false); // no marker of its own and no worktree-group hit: not archived
        }
        if marker_sid.is_none() || desc_sid.is_none() || marker_sid == desc_sid {
            // no discriminating identity on one side, or the same one: the archived workspace's own leftover descriptor
            return Ok(true);
        }
        // two different sessions: reuse only on positive proof of current liveness
        let live = crate::meshw::rosterrows::sibling_partition_live(&self.inv, self.inv.now as f64, id, desc_wt.as_deref(), desc_sid.as_deref())?;
        if group {
            return Ok(!live);
        }
        let active = devswarm_root(&self.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", json_suffix()));
        let newer = matches!((mtime(&marker_path), mtime(&active)), (Some(m), Some(d)) if d > m);
        Ok(!(newer && live))
    }

    /// Sort one orphan: `Stranded`, `ForwardedDrained`, or `Other` when it is neither.
    pub(crate) fn classify(&mut self, id: &str) -> R<Class> {
        let Some(desc) = self.descriptor(id) else { return Ok(Class::Other) };
        if !self.archived(id, &desc)? {
            return Ok(Class::Other);
        }
        let Some(wt) = desc.get(defaults::text("mesh_write.field_worktree_path")).filter(|v| v.truthy()).map(js_string) else { return Ok(Class::Stranded) };
        let Some(key) = ident::canonical_mesh_id(&wt)? else { return Ok(Class::Stranded) };
        if !self.families()?.contains(&key) {
            return Ok(Class::Stranded);
        }
        Ok(if self.forwarded_drained(id, &key)? { Class::ForwardedDrained } else { Class::Other })
    }

    /// The registry rows of the projection's store, read once.
    fn registry(&mut self) -> Vec<Row> {
        if self.registry.is_none() {
            let rows = self.store.and_then(|st| st.reader().roster().ok()).map(|r| ident::rows_of(&r)).unwrap_or_default();
            self.registry = Some(rows);
        }
        self.registry.clone().unwrap_or_default()
    }

    /// The hashes of the survivor's partition, read once; an unreadable partition is an empty one.
    fn survivor_hashes(&mut self, survivor: &str) -> &HashSet<String> {
        if !self.survivors.contains_key(survivor) {
            let mut set = HashSet::new();
            if let Some(st) = self.store {
                crate::discard::harmless(st.reader().for_each_message(survivor, 0, |row| {
                    if let Some(h) = row["hash"].as_str() {
                        set.insert(h.to_string());
                    }
                    true
                })); // keep: Node reads a failing partition as an empty set (no row is proven)
            }
            self.survivors.insert(survivor.to_string(), set);
        }
        self.survivors.entry(survivor.to_string()).or_default()
    }

    /// `makeForwardedDrainedTest` from the family on: the survivor is the freshest live row of the family and every unread row of
    /// `id` has, in the survivor's partition, the hash its forward would have. One row that cannot be matched, or is not a forwardable
    /// direct, fails the whole id: this only ever moves an id out of `orphans[]` on positive per-row proof.
    fn forwarded_drained(&mut self, id: &str, key: &str) -> R<bool> {
        let Some(st) = self.store else { return Ok(false) };
        let mut group: Vec<Row> = Vec::new();
        for r in self.registry() {
            if let Some(wt) = r.worktree_path.as_deref().filter(|w| !w.is_empty())
                && ident::canonical_mesh_id(wt)?.as_deref() == Some(key)
            {
                group.push(r);
            }
        }
        if group.is_empty() {
            return Ok(false);
        }
        let survivor =
            crate::meshw::diagverbs::pick_freshest(&self.inv, st.reader(), &group, &|r| Ok(live_session_id(r.session_id.as_deref())))?.map(|r| r.id.clone());
        let Some(survivor) = survivor.filter(|s| !s.is_empty() && s != id) else { return Ok(false) };
        let floor = crate::meshw::summary::store_floor(st, &self.home, id);
        let mut unread: Vec<serde_json::Value> = Vec::new();
        let read = st.reader().for_each_message(id, if floor.is_finite() && floor > 0.0 { floor as u64 } else { 0 }, |row| {
            unread.push(row.clone());
            true
        });
        if read.is_err() || unread.is_empty() {
            return Ok(false);
        }
        let prefix = format!("{}{id}{}", defaults::text("mesh_write.forward_prefix"), defaults::text("mesh_write.forward_prefix_end"));
        let hashes = self.survivor_hashes(&survivor).clone();
        for m in &unread {
            if !crate::meshw::meshgroup::is_forwardable(m) {
                return Ok(false);
            }
            let urgency = str_of(m, "urgency").filter(|u| !u.is_empty()).unwrap_or_else(|| defaults::text("mesh_write.urgency_default").to_string());
            let body = format!("{prefix}{}", str_of(m, "body").unwrap_or_default());
            let ts = m["ts"].as_f64().map(crate::checks::jsport::num::to_js_string).unwrap_or_default();
            let hash = crate::meshw::store::mesh_message_hash(
                str_of(m, "sender").as_deref(),
                Some(&survivor),
                defaults::text("mesh_write.mtype_direct"),
                &urgency,
                &body,
                &ts,
                m["needsReply"].as_bool().unwrap_or(false),
            );
            if !hashes.contains(&hash) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::store::{RegistryRow, mesh_message_hash, mesh_message_row};

    fn home(tag: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!("ah-orphan-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: a stale directory of an earlier run of this test
        for d in ["mesh_write.dir_workspaces", "mesh_write.dir_archived"] {
            std::fs::create_dir_all(devswarm_root(&h).join(defaults::text(d))).unwrap();
        }
        h
    }

    fn put(h: &Path, dir: &str, id: &str, json: &str) -> PathBuf {
        let p = devswarm_root(h).join(defaults::text(dir)).join(format!("{id}.json"));
        std::fs::write(&p, json).unwrap();
        p
    }

    fn at(p: &Path, secs: u64) {
        std::fs::File::options().write(true).open(p).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs)).unwrap();
    }

    const WS: &str = "mesh_write.dir_workspaces";
    const AR: &str = "mesh_write.dir_archived";

    fn class(h: &Path, id: &str) -> Class {
        Classifier::new(h, vec![]).classify(id).unwrap()
    }

    #[test]
    fn a_relative_worktree_path_resolves_against_the_working_directory_like_realpath() {
        let h = home("rel");
        put(&h, WS, "w1", r#"{"worktreePath":"some/rel","sessionId":"s"}"#);
        put(&h, AR, "w1", r#"{"worktreePath":"some/rel","sessionId":"s"}"#);
        assert_eq!(class(&h, "w1"), Class::Stranded);
        // the descriptor and the marker spell one worktree two ways: still the same worktree
        put(&h, AR, "w1", r#"{"worktreePath":"some/../some/rel","sessionId":"other"}"#);
        // a marker that names a different path than the descriptor is a new workspace reusing the id: not archived
        put(&h, AR, "w1", r#"{"worktreePath":"elsewhere","sessionId":"other"}"#);
        assert_eq!(class(&h, "w1"), Class::Other);
    }

    #[test]
    fn session_ids_of_any_type_compare_as_javascript_strings() {
        let h = home("sid");
        put(&h, WS, "w1", r#"{"sessionId":7}"#);
        put(&h, AR, "w1", r#"{"sessionId":"7"}"#);
        assert_eq!(class(&h, "w1"), Class::Stranded, "7 and \"7\" are one session: the leftover descriptor of the archived workspace");
        put(&h, AR, "w1", r#"{"sessionId":[7]}"#);
        assert_eq!(class(&h, "w1"), Class::Stranded, "String([7]) is \"7\"");
    }

    #[test]
    fn a_worktree_that_is_no_string_is_none_for_the_gate_and_its_text_for_the_family() {
        let h = home("wt");
        put(&h, WS, "w1", r#"{"worktreePath":5,"sessionId":"s"}"#);
        // no marker of its own and the gate sees no worktree: not archived
        assert_eq!(class(&h, "w1"), Class::Other);
        put(&h, AR, "w1", r#"{"sessionId":"s"}"#);
        // archived; the family key comes from String(5), which names no registry row
        assert_eq!(class(&h, "w1"), Class::Stranded);
    }

    #[test]
    fn a_marker_with_a_lone_surrogate_escape_is_read_not_handed_over() {
        let h = home("esc");
        put(&h, WS, "w1", r#"{"sessionId":"s"}"#);
        put(&h, AR, "w1", r#"{"sessionId":"s","note":"\ud83d"}"#);
        assert_eq!(class(&h, "w1"), Class::Stranded);
        put(&h, AR, "w1", "not json");
        assert_eq!(class(&h, "w1"), Class::Stranded, "a marker that proves nothing is never resurrected");
    }

    #[test]
    fn two_sessions_are_told_apart_by_liveness_and_the_descriptors_age() {
        let h = home("live");
        let marker = put(&h, AR, "w1", r#"{"worktreePath":"/nowhere/w","sessionId":"old"}"#);
        let desc = put(&h, WS, "w1", r#"{"worktreePath":"/nowhere/w","sessionId":"new"}"#);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        at(&marker, now - 200);
        at(&desc, now - 100);
        // a newer descriptor of a session nothing shows dead: a reuse, the id is not archived
        assert_eq!(class(&h, "w1"), Class::Other);
        // an older descriptor is the archived workspace's own leftover
        at(&desc, now - 300);
        assert_eq!(class(&h, "w1"), Class::Stranded);
        // a session that is only the auto-ensure placeholder is no proof of life
        put(&h, WS, "w1", r#"{"worktreePath":"/nowhere/w","sessionId":"unclaimed:x"}"#);
        at(&marker, now - 200);
        assert_eq!(class(&h, "w1"), Class::Stranded);
    }

    #[test]
    fn siblings_archived_on_one_worktree_decide_the_same_way_whatever_the_listing_order() {
        let h = home("group");
        put(&h, AR, "a1", r#"{"worktreePath":"/nowhere/g","sessionId":"s1"}"#);
        put(&h, AR, "a2", r#"{"worktreePath":"/nowhere/g","sessionId":"s2"}"#);
        put(&h, WS, "w3", r#"{"worktreePath":"/nowhere/g","sessionId":"s2"}"#);
        // the first marker by name is a1 (session s1 against the descriptor's s2): a live sibling is not archived
        assert_eq!(class(&h, "w3"), Class::Other);
        put(&h, WS, "w3", r#"{"worktreePath":"/nowhere/g","sessionId":"unclaimed:y"}"#);
        assert_eq!(class(&h, "w3"), Class::Stranded);
    }

    /// A family with a survivor `S` (live session) and an archived orphan `O` whose one unread row was forwarded into `S`.
    fn forward_fixture(tag: &str, forwarded: bool, extra_unread: bool) -> (PathBuf, MeshStore, Inv) {
        let h = home(tag);
        let wt = h.join("fam");
        std::fs::create_dir_all(wt.join(".git")).unwrap();
        let wt_s = std::fs::canonicalize(&wt).unwrap().to_string_lossy().into_owned();
        put(&h, AR, "O", &format!(r#"{{"worktreePath":"{wt_s}","sessionId":"so"}}"#));
        put(&h, WS, "S", &format!(r#"{{"worktreePath":"{wt_s}","sessionId":"live-s"}}"#));
        let st = MeshStore::open(&h.join(defaults::text("mesh_write.store_file"))).unwrap();
        let row = RegistryRow {
            id: "S".into(),
            worktree_path: Some(wt_s),
            session_id: Some("live-s".into()),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        st.upsert_registry(&row, 1, |a, b| a == b).unwrap();
        let m = mesh_message_row(Some("peer"), Some("O"), false, "hello", 1_000, "normal", "mesh:orig", false, None);
        st.append_mesh_row(&m).unwrap();
        if forwarded {
            let body = "[forwarded from archived O] hello";
            let hash = mesh_message_hash(Some("peer"), Some("S"), "direct", "normal", body, "1000", false);
            st.append_mesh_row(&mesh_message_row(Some("peer"), Some("S"), false, body, 1_000, "normal", &hash, false, None)).unwrap();
        }
        if extra_unread {
            st.append_mesh_row(&mesh_message_row(Some("peer"), Some("O"), false, "never forwarded", 2_000, "normal", "mesh:other", false, None)).unwrap();
        }
        let inv = Inv { home: h.clone(), write_home: h.clone(), env: Default::default(), cwd: "/".into(), now: 5_000_000, stdin: None, store_override: None };
        (h, st, inv)
    }

    #[test]
    fn an_archived_orphan_whose_every_unread_row_reached_the_survivor_is_forwarded_drained() {
        let (h, st, inv) = forward_fixture("drained", true, false);
        let wts = vec![st.reader().roster().unwrap()[0]["worktreePath"].as_str().unwrap().to_string()];
        assert_eq!(Classifier::with_store(&inv, &st, wts.clone()).classify("O").unwrap(), Class::ForwardedDrained);
        // without the store nothing is proven: Node's fail-open answer, the id stays among the orphans
        assert_eq!(Classifier::new(&h, wts).classify("O").unwrap(), Class::Other);
    }

    #[test]
    fn one_unread_row_that_never_reached_the_survivor_keeps_the_whole_id_among_the_orphans() {
        for (tag, forwarded, extra) in [("partial", true, true), ("none", false, false)] {
            let (_h, st, inv) = forward_fixture(tag, forwarded, extra);
            let wts = vec![st.reader().roster().unwrap()[0]["worktreePath"].as_str().unwrap().to_string()];
            assert_eq!(Classifier::with_store(&inv, &st, wts).classify("O").unwrap(), Class::Other, "{tag}");
        }
    }
}
