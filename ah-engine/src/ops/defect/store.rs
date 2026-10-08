//! The defect store: durable, append-only NDJSON files under `~/.anti-hall/defects/`, one file per defect. Port of
//! `hooks/lib/defect-store.js`.
//!
//! The design rules are the Node module's and are unchanged: derived state only (no index file), every write verified by
//! reading the line back, every line capped, torn lines skipped and never repaired, and nothing ever deleted (archival is a
//! rename). The caps, the enums and the field limits are the plugin's `engine/defaults/defect.toml`.
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{collapse_ws, js_trim};
use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::date;
use crate::defaults;
use crate::ops::js::{Defer, cmp_semver, head16, len16, slice16};
use ring::digest;
use std::io::Write;
use std::path::{Path, PathBuf};

// ---- locations --------------------------------------------------------------------------------------------------------

/// `<home>/<base_dir>/<defects_dir>`
pub fn defects_dir(home: &str) -> PathBuf {
    Path::new(home).join(defaults::text("paths.base_dir")).join(defaults::text("defect.dir"))
}

/// The archive directory.
pub fn archive_dir(home: &str) -> PathBuf {
    defects_dir(home).join(defaults::text("defect.archive_dir"))
}

/// Where `backfill` keeps the fixed bugs imported from git history.
pub fn history_dir(home: &str) -> PathBuf {
    defects_dir(home).join(defaults::text("defect.history_dir"))
}

fn fp_file(fp: &str, home: &str) -> PathBuf {
    defects_dir(home).join(format!("{fp}{}", defaults::text("defect.file_ext")))
}

/// The `*.jsonl` files directly under `dir` in the order `fs.readdirSync` gives them (sorted by name), `None` when the
/// directory cannot be read.
pub fn jsonl_names(dir: &Path) -> Option<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Some(names.into_iter().filter(|n| n.ends_with(defaults::text("defect.file_ext"))).collect())
}

fn ensure_dir(dir: &Path) {
    // keep: a failure to create the directory shows up as the write that follows it failing, which is reported
    crate::discard::harmless(std::fs::create_dir_all(dir));
}

// ---- field handling ---------------------------------------------------------------------------------------------------

/// What `clampFieldInfo` found.
pub struct Clamped {
    pub value: String,
    pub truncated: bool,
    pub original_length: usize,
    pub marked: bool,
    pub overflow: Option<String>,
}

/// The sanitising half of `clampFieldInfo`: ANSI sequences, then control characters, then surrounding white space.
fn sanitize(value: &str) -> String {
    let no_ansi = jsre::compile(defaults::text("defect.ansi_re"), false).replace_all(value, "");
    let no_ctl = jsre::compile(defaults::text("defect.control_re"), false).replace_all(&no_ansi, "");
    js_trim(&no_ctl).to_string()
}

/// `truncationNotice(originalLength, continued)`
fn truncation_notice(original: usize, continued: bool) -> String {
    let pointer = if continued { defaults::text("defect.notice_pointer") } else { "" };
    defaults::render("defect.notice", &[("pointer", &pointer), ("n", &original)])
}

/// `clampFieldInfo(value, maxLen, {mark})`
pub fn clamp_info(value: &str, max_len: usize, mark: bool) -> Result<Clamped, Defer> {
    let s = sanitize(value);
    let original_length = len16(&s);
    if original_length <= max_len {
        return Ok(Clamped { value: s, truncated: false, original_length, marked: false, overflow: None });
    }
    if !mark {
        return Ok(Clamped { value: head16(&s, max_len)?, truncated: true, original_length, marked: false, overflow: None });
    }
    let notice = truncation_notice(original_length, true);
    let keep = max_len as isize - len16(&notice) as isize;
    if keep <= 0 {
        return Ok(Clamped { value: head16(&s, max_len)?, truncated: true, original_length, marked: false, overflow: None });
    }
    let keep = keep as usize;
    Ok(Clamped { value: head16(&s, keep)? + &notice, truncated: true, original_length, marked: true, overflow: Some(slice16(&s, keep, usize::MAX)?) })
}

/// `clampField(value, maxLen)`
pub fn clamp_field(value: &str, max_len: usize) -> Result<String, Defer> {
    Ok(clamp_info(value, max_len, false)?.value)
}

/// `truncationCollector()`: clamps fields and remembers what was cut.
#[derive(Default)]
pub struct Collector {
    cut: Vec<(String, J)>,
    spill: Vec<(String, String)>,
}

impl Collector {
    /// `take(name, value, maxLen, mark)`
    pub fn take(&mut self, name: &str, value: &str, max_len: usize, mark: bool) -> Result<String, Defer> {
        let r = clamp_info(value, max_len, mark)?;
        if r.truncated {
            self.cut.push((
                name.to_string(),
                J::Obj(vec![
                    ("cap".into(), J::Num(max_len as f64)),
                    ("originalLength".into(), J::Num(r.original_length as f64)),
                    ("marked".into(), J::Bool(r.marked)),
                ]),
            ));
            if r.marked
                && let Some(o) = r.overflow.filter(|o| !o.is_empty())
            {
                self.spill.push((name.to_string(), o));
            }
        }
        Ok(r.value)
    }

    /// `map()`: the `{field: {cap, originalLength, marked}}` object, `None` when nothing was cut.
    pub fn map(&self) -> Option<J> {
        (!self.cut.is_empty()).then(|| J::Obj(self.cut.clone()))
    }
}

/// `normalizeComponent(p)`: the module a path names.
pub fn normalize_component(p: &str) -> Result<Option<String>, Defer> {
    let mut s = js_trim(p).replace('\\', "/");
    for step in defaults::list("defect.component_steps") {
        let (re, with) = step.split_once(defaults::text("defect.step_sep")).unwrap_or((step, ""));
        s = crate::checks::guardkit::jsre::compile(re, false).replace_all(&s, with).into_owned();
    }
    let s = jsre::compile(defaults::text("defect.control_re"), false).replace_all(&s, "").into_owned();
    let s = head16(&s, defaults::num("defect.component_cap") as usize)?;
    Ok((!s.is_empty()).then_some(s))
}

/// The optional bug-history fields of a report or a ruling, validated and clamped; `Err(outcome)` for an invalid one.
pub struct Optional {
    pub component: Option<String>,
    pub cause: Option<String>,
    pub regression_of: Option<String>,
}

/// `optionalFields(input, tr)`
pub fn optional_fields(component: Option<&str>, cause: Option<&str>, regression_of: Option<&str>, tr: &mut Collector) -> Result<Result<Optional, &'static str>, Defer> {
    let mut out = Optional { component: None, cause: None, regression_of: None };
    if let Some(c) = component.filter(|c| !c.is_empty())
        && let Some(n) = normalize_component(c)?
    {
        out.component = Some(tr.take(defaults::text("defect.key_component"), &n, defaults::num("defect.component_cap") as usize, false)?);
    }
    if let Some(c) = cause.filter(|c| !c.is_empty()) {
        if !defaults::list("defect.cause_enum").contains(&c) {
            return Ok(Err(defaults::text("defect.out_invalid_cause")));
        }
        out.cause = Some(c.to_string());
    }
    if let Some(r) = regression_of.filter(|r| !r.is_empty()) {
        let ok = r.len() == 12 && r.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !ok {
            return Ok(Err(defaults::text("defect.out_invalid_regression")));
        }
        out.regression_of = Some(r.to_string());
    }
    Ok(Ok(out))
}

// ---- fingerprint and versions -----------------------------------------------------------------------------------------

/// `normSym(sym)`
pub fn norm_sym(sym: &str) -> String {
    let lower = sym.to_lowercase();
    let c: Vec<char> = lower.chars().collect();
    let mut stripped = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].is_ascii_digit() || ('a'..='f').contains(&c[i]) {
            let mut j = i;
            while j < c.len() && (c[j].is_ascii_digit() || ('a'..='f').contains(&c[j])) {
                j += 1;
            }
            if j - i < 6 {
                stripped.extend(&c[i..j]);
            }
            i = j;
        } else {
            stripped.push(c[i]);
            i += 1;
        }
    }
    js_trim(&collapse_ws(&stripped)).to_string()
}

/// `fingerprint(cls, sym)`: 12 hex characters.
pub fn fingerprint(cls: &str, sym: &str) -> String {
    let d = digest::digest(&digest::SHA256, format!("{cls}\n{}", norm_sym(sym)).as_bytes());
    d.as_ref().iter().take(defaults::num("defect.fp_len") as usize / 2).map(|b| format!("{b:02x}")).collect()
}

// ---- reading ----------------------------------------------------------------------------------------------------------

/// `readRawLines(file)`: the non-empty lines, `[]` when the file cannot be read.
pub fn read_raw_lines(file: &Path) -> Vec<String> {
    match std::fs::read(file) {
        Ok(b) => String::from_utf8_lossy(&b).split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect(),
        Err(_) => Vec::new(),
    }
}

/// `parseLines(rawLines)`: the lines that parse to an object or array; a torn line is skipped, never repaired.
pub fn parse_lines(raw: &[String]) -> Vec<J> {
    raw.iter()
        .filter_map(|l| json::parse(l, defaults::num("setup.json_max_depth") as usize).ok())
        .filter(|j| matches!(j, J::Obj(_) | J::Arr(_)))
        .collect()
}

fn str_of<'a>(o: &'a J, k: &str) -> Option<&'a str> {
    match o.get(k) {
        Some(J::Str(s)) => Some(s),
        _ => None,
    }
}

/// What `deriveState` returns, in the order the Node object has its keys.
pub struct State {
    pub status: String,
    pub occurrences: usize,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub ruling_count: usize,
    pub stale_build: bool,
    pub extra: Vec<(String, String)>,
}

impl State {
    /// The object `Object.assign({status, occurrences, ...}, extra)`.
    pub fn members(&self) -> Vec<(String, J)> {
        let s = |v: &Option<String>| v.clone().map_or(J::Null, J::Str);
        let mut o = vec![
            ("status".to_string(), J::Str(self.status.clone())),
            ("occurrences".to_string(), J::Num(self.occurrences as f64)),
            ("firstSeen".to_string(), s(&self.first_seen)),
            ("lastSeen".to_string(), s(&self.last_seen)),
            ("reportCount".to_string(), J::Num(self.occurrences as f64)),
            ("rulingCount".to_string(), J::Num(self.ruling_count as f64)),
            ("staleBuild".to_string(), J::Bool(self.stale_build)),
        ];
        for (k, v) in &self.extra {
            match o.iter_mut().find(|(n, _)| n == k) {
                Some(slot) => slot.1 = J::Str(v.clone()),
                None => o.push((k.clone(), J::Str(v.clone()))),
            }
        }
        o
    }

    /// The extra string field `k`.
    pub fn extra(&self, k: &str) -> Option<&str> {
        self.extra.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
}

fn set_extra(extra: &mut Vec<(String, String)>, k: &str, v: &str) {
    match extra.iter_mut().find(|(n, _)| n == k) {
        Some(slot) => slot.1 = v.to_string(),
        None => extra.push((k.to_string(), v.to_string())),
    }
}

/// `deriveState(parsedLines)`
pub fn derive_state(lines: &[J]) -> State {
    let mut st = State { status: defaults::text("defect.status_open").to_string(), occurrences: 0, first_seen: None, last_seen: None, ruling_count: 0, stale_build: false, extra: Vec::new() };
    let mut last_ruling: Option<(String, Option<String>)> = None;
    for obj in lines {
        for k in defaults::list("defect.extra_keys") {
            if let Some(v) = str_of(obj, k).filter(|v| !v.is_empty()) {
                set_extra(&mut st.extra, k, v);
            }
        }
        let t = str_of(obj, defaults::text("defect.key_t"));
        if t == Some(defaults::text("defect.t_ruling"))
            && let Some(c) = str_of(obj, defaults::text("defect.key_commit")).filter(|c| !c.is_empty())
        {
            set_extra(&mut st.extra, defaults::text("defect.key_fix_commit"), c);
        }
        if let Some(at) = str_of(obj, defaults::text("defect.key_at")).filter(|a| !a.is_empty()) {
            if st.first_seen.is_none() {
                st.first_seen = Some(at.to_string());
            }
            st.last_seen = Some(at.to_string());
        }
        if t == Some(defaults::text("defect.t_report")) {
            st.occurrences += 1;
            if let Some((rs, Some(fixed_in))) = &last_ruling
                && rs == defaults::text("defect.status_fixed")
                && !fixed_in.is_empty()
                && let Some(cmp) = cmp_semver(str_of(obj, defaults::text("defect.key_v")).unwrap_or(""), fixed_in)
            {
                if cmp >= 0 {
                    st.status = defaults::text("defect.status_regressed").to_string();
                } else {
                    st.stale_build = true;
                }
            }
        } else if t == Some(defaults::text("defect.t_backfill")) {
            if let Some(s) = str_of(obj, defaults::text("defect.key_status")) {
                st.status = s.to_string();
            }
        } else if t == Some(defaults::text("defect.t_ruling")) {
            st.ruling_count += 1;
            if let Some(s) = str_of(obj, defaults::text("defect.key_status")) {
                st.status = s.to_string();
                last_ruling = Some((s.to_string(), str_of(obj, defaults::text("defect.key_fixed_in")).map(str::to_string)));
                st.stale_build = false;
            }
        }
    }
    st
}

/// `isUnfinished(status)`
pub fn is_unfinished(status: &str) -> bool {
    !defaults::list("defect.closed_statuses").contains(&status)
}

fn count_files(dir: &Path) -> usize {
    jsonl_names(dir).map_or(0, |n| n.len())
}

/// `countArchiveFiles(home)`: every `*.jsonl` under the archive, across the month buckets.
fn count_archive_files(home: &str) -> usize {
    let Some(months) = std::fs::read_dir(archive_dir(home)).ok().map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>()) else { return 0 };
    months.iter().map(|m| count_files(&archive_dir(home).join(m))).sum()
}

// ---- writing ----------------------------------------------------------------------------------------------------------

/// The outcome words of a write.
fn out_word(key: &'static str) -> &'static str {
    defaults::text(key)
}

/// `appendLine(file, line, {create, exclusive})`: the outcome word.
pub fn append_line(file: &Path, line: &str, create: bool, exclusive: bool) -> &'static str {
    let data = format!("{line}\n");
    if create {
        match std::fs::OpenOptions::new().append(true).create_new(true).open(file) {
            Ok(mut f) => {
                if f.write_all(data.as_bytes()).is_err() {
                    return out_word("defect.out_write_unverified");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if exclusive {
                    return out_word("defect.out_exists");
                }
                return append_line(file, line, false, false);
            }
            Err(_) => return out_word("defect.out_write_unverified"),
        }
    } else {
        if !file.exists() {
            return out_word("defect.out_not_found");
        }
        let appended = std::fs::OpenOptions::new().append(true).create(true).open(file).and_then(|mut f| f.write_all(data.as_bytes()));
        if appended.is_err() {
            return out_word("defect.out_write_unverified");
        }
    }
    if !read_raw_lines(file).iter().any(|l| l == line) {
        return out_word("defect.out_write_unverified");
    }
    if create { out_word("defect.out_recorded") } else { out_word("defect.out_occurrence_appended") }
}

/// `chunkByBytes(text, maxBytes)`: pieces of at most `max` UTF-8 bytes, split at code-point boundaries.
fn chunk_by_bytes(text: &str, max: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        if cur.len() + c.len_utf8() > max && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

fn file_size(file: &Path) -> usize {
    std::fs::metadata(file).map_or(0, |m| m.len() as usize)
}

/// `spillOverflow(file, forType, seq, overflows, atIso)`: one summary per field.
fn spill_overflow(file: &Path, for_type: &str, seq: usize, overflows: &[(String, String)], at: &str) -> J {
    let mut summaries = Vec::new();
    for (field, text) in overflows {
        let chunks = chunk_by_bytes(text, defaults::num("defect.overflow_chunk_bytes") as usize);
        let of = chunks.len();
        let mut outcome = out_word("defect.out_recorded");
        for (part, chunk) in chunks.iter().enumerate() {
            let line_obj = J::Obj(vec![
                (defaults::text("defect.key_t").into(), J::Str(defaults::text("defect.t_overflow").into())),
                (defaults::text("defect.key_at").into(), J::Str(at.into())),
                (defaults::text("defect.key_for_type").into(), J::Str(for_type.into())),
                (defaults::text("defect.key_seq").into(), J::Num(seq as f64)),
                (defaults::text("defect.key_field").into(), J::Str(field.clone())),
                (defaults::text("defect.key_part").into(), J::Num(part as f64)),
                (defaults::text("defect.key_of").into(), J::Num(of as f64)),
                (defaults::text("defect.key_text").into(), J::Str(chunk.clone())),
            ]);
            let line = json::stringify(&line_obj);
            if line.len() > defaults::num("defect.max_line_bytes") as usize {
                outcome = out_word("defect.out_too_large");
                break;
            }
            if file_size(file) + line.len() + 1 > defaults::num("defect.max_file_bytes") as usize {
                outcome = out_word("defect.out_defect_full");
                break;
            }
            let res = append_line(file, &line, false, false);
            if res != out_word("defect.out_occurrence_appended") {
                outcome = res;
                break;
            }
        }
        summaries.push(J::Obj(vec![
            (defaults::text("defect.key_field").into(), J::Str(field.clone())),
            (defaults::text("defect.key_chunks").into(), J::Num(of as f64)),
            (defaults::text("defect.key_outcome").into(), J::Str(outcome.into())),
        ]));
    }
    J::Arr(summaries)
}

/// The text a report or ruling asks the store to write.
pub struct ReportInput {
    pub class: Option<String>,
    pub sev: Option<String>,
    pub sym: String,
    pub repro: String,
    pub claimed: String,
    pub observed: String,
    pub proj: String,
    pub sid: String,
    pub v: String,
    pub component: Option<String>,
    pub cause: Option<String>,
    pub regression_of: Option<String>,
}

fn obj(pairs: Vec<(&str, J)>) -> Vec<(String, J)> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn with_trunc(mut res: Vec<(String, J)>, tr: &Collector) -> J {
    if let Some(m) = tr.map() {
        res.push((defaults::text("defect.key_truncated").into(), m));
    }
    J::Obj(res)
}

fn outcome_only(word: &str) -> J {
    J::Obj(obj(vec![(defaults::text("defect.key_outcome"), J::Str(word.into()))]))
}

fn now_iso() -> String {
    date::to_iso(date::now_ms()).unwrap_or_default()
}

/// `report(input)`
pub fn report(input: &ReportInput, home: &str) -> Result<J, Defer> {
    let Some(cls) = input.class.as_deref().filter(|c| defaults::list("defect.class_enum").contains(c)) else {
        return Ok(outcome_only(defaults::text("defect.out_invalid_class")));
    };
    let Some(sev) = input.sev.as_deref().filter(|c| defaults::list("defect.severity_enum").contains(c)) else {
        return Ok(outcome_only(defaults::text("defect.out_invalid_severity")));
    };
    let mut tr = Collector::default();
    let opt = match optional_fields(input.component.as_deref(), input.cause.as_deref(), input.regression_of.as_deref(), &mut tr)? {
        Ok(o) => o,
        Err(word) => return Ok(outcome_only(word)),
    };
    ensure_dir(&defects_dir(home));
    let caps = defaults::raw("defect.field_caps");
    let field_cap = |k: &str| caps.get(k).and_then(defaults::V::as_integer).unwrap_or(0) as usize;
    let sym = tr.take("sym", &input.sym, field_cap("sym"), false)?;
    let fp = fingerprint(cls, &sym);
    let at = now_iso();
    let big = defaults::num("defect.loose_cap") as usize;
    let mut line = vec![
        ("t".to_string(), J::Str(defaults::text("defect.t_report").into())),
        ("at".to_string(), J::Str(at.clone())),
        ("v".to_string(), J::Str(tr.take("v", &input.v, defaults::num("defect.v_cap") as usize, false)?)),
        ("proj".to_string(), J::Str(tr.take("proj", &input.proj, big, false)?)),
        ("sid".to_string(), J::Str(tr.take("sid", &input.sid, big, false)?)),
        ("class".to_string(), J::Str(cls.into())),
        ("sev".to_string(), J::Str(sev.into())),
        ("sym".to_string(), J::Str(sym)),
        ("repro".to_string(), J::Str(tr.take("repro", &input.repro, field_cap("repro"), true)?)),
        ("claimed".to_string(), J::Str(tr.take("claimed", &input.claimed, field_cap("claimed"), true)?)),
        ("observed".to_string(), J::Str(tr.take("observed", &input.observed, field_cap("observed"), true)?)),
    ];
    for (k, v) in [("component", opt.component), ("cause", opt.cause), ("regressionOf", opt.regression_of)] {
        if let Some(v) = v {
            line.push((k.to_string(), J::Str(v)));
        }
    }
    let line_str = json::stringify(&J::Obj(line));
    let fp_member = || (defaults::text("defect.key_fp").to_string(), J::Str(fp.clone()));
    let outcome_member = |w: &str| (defaults::text("defect.key_outcome").to_string(), J::Str(w.into()));
    if line_str.len() > defaults::num("defect.max_line_bytes") as usize {
        return Ok(with_trunc(vec![outcome_member(defaults::text("defect.out_too_large")), fp_member()], &tr));
    }
    let file = fp_file(&fp, home);
    let exists = file.exists();
    let spill_if_written = |res: &'static str, seq: usize, tr: &Collector| -> Vec<(String, J)> {
        let mut members = vec![fp_member(), outcome_member(res)];
        if res == defaults::text("defect.out_recorded") || res == defaults::text("defect.out_occurrence_appended") {
            let overflows = &tr.spill;
            if !overflows.is_empty() {
                members.push((defaults::text("defect.key_overflow").to_string(), spill_overflow(&file, defaults::text("defect.t_report"), seq, overflows, &at)));
            }
        }
        members
    };
    if !exists {
        if count_files(&defects_dir(home)) >= defaults::num("defect.max_open_files") as usize {
            return Ok(with_trunc(vec![outcome_member(defaults::text("defect.out_registry_full")), fp_member()], &tr));
        }
        let res = append_line(&file, &line_str, true, false);
        return Ok(with_trunc(spill_if_written(res, 0, &tr), &tr));
    }
    let parsed = parse_lines(&read_raw_lines(&file));
    let report_count = parsed.iter().filter(|p| str_of(p, "t") == Some(defaults::text("defect.t_report"))).count();
    let prior = derive_state(&parsed);
    let in_extra = prior.status == defaults::text("defect.status_fixed") || prior.status == defaults::text("defect.status_regressed");
    let max_reports = defaults::num("defect.max_report_lines") as usize;
    let cap_reports = if in_extra { max_reports + defaults::num("defect.regression_extra") as usize } else { max_reports };
    if report_count >= cap_reports {
        return Ok(with_trunc(vec![outcome_member(defaults::text("defect.out_occurrence_capped")), fp_member()], &tr));
    }
    if file_size(&file) + line_str.len() + 1 > defaults::num("defect.max_file_bytes") as usize {
        return Ok(with_trunc(vec![outcome_member(defaults::text("defect.out_defect_full")), fp_member()], &tr));
    }
    let res = append_line(&file, &line_str, false, false);
    Ok(with_trunc(spill_if_written(res, report_count, &tr), &tr))
}

/// What a ruling asks the store to write.
pub struct RuleInput {
    pub status: Option<String>,
    pub note: String,
    pub fixed_in: Option<String>,
    pub commit: Option<String>,
    pub superseded_by: Option<String>,
    pub component: Option<String>,
    pub cause: Option<String>,
    pub regression_of: Option<String>,
}

/// `rule(fp, input)`
pub fn rule(fp: &str, input: &RuleInput, home: &str) -> Result<J, Defer> {
    let file = fp_file(fp, home);
    let fp_member = || (defaults::text("defect.key_fp").to_string(), J::Str(fp.to_string()));
    let outcome_member = |w: &str| (defaults::text("defect.key_outcome").to_string(), J::Str(w.into()));
    if !file.exists() {
        return Ok(J::Obj(vec![outcome_member(defaults::text("defect.out_not_found")), fp_member()]));
    }
    let Some(status) = input.status.as_deref().filter(|s| defaults::list("defect.ruling_status_enum").contains(s)) else {
        return Ok(J::Obj(vec![outcome_member(defaults::text("defect.out_invalid_status")), fp_member()]));
    };
    let mut tr = Collector::default();
    let at = now_iso();
    let note_cap = defaults::raw("defect.field_caps").get("note").and_then(defaults::V::as_integer).unwrap_or(0) as usize;
    let mut line = vec![
        ("t".to_string(), J::Str(defaults::text("defect.t_ruling").into())),
        ("at".to_string(), J::Str(at.clone())),
        ("status".to_string(), J::Str(status.into())),
        ("note".to_string(), J::Str(tr.take("note", &input.note, note_cap, true)?)),
    ];
    if let Some(f) = input.fixed_in.as_deref().filter(|f| !f.is_empty()) {
        line.push(("fixedIn".into(), J::Str(tr.take("fixedIn", f, defaults::num("defect.v_cap") as usize, false)?)));
    }
    if let Some(c) = input.commit.as_deref().filter(|f| !f.is_empty()) {
        line.push(("commit".into(), J::Str(tr.take("commit", c, defaults::num("defect.commit_cap") as usize, false)?)));
    }
    if let Some(s) = input.superseded_by.as_deref().filter(|f| !f.is_empty()) {
        line.push(("supersededBy".into(), J::Str(tr.take("supersededBy", s, defaults::num("defect.fp_len") as usize, false)?)));
    }
    let opt = match optional_fields(input.component.as_deref(), input.cause.as_deref(), input.regression_of.as_deref(), &mut tr)? {
        Ok(o) => o,
        Err(word) => return Ok(J::Obj(vec![outcome_member(word), fp_member()])),
    };
    for (k, v) in [("component", opt.component), ("cause", opt.cause), ("regressionOf", opt.regression_of)] {
        if let Some(v) = v {
            line.push((k.to_string(), J::Str(v)));
        }
    }
    let line_str = json::stringify(&J::Obj(line));
    if line_str.len() > defaults::num("defect.max_line_bytes") as usize {
        return Ok(with_trunc(vec![outcome_member(defaults::text("defect.out_too_large")), fp_member()], &tr));
    }
    if file_size(&file) + line_str.len() + 1 > defaults::num("defect.max_file_bytes") as usize {
        return Ok(with_trunc(vec![outcome_member(defaults::text("defect.out_defect_full")), fp_member()], &tr));
    }
    let ruling_seq = parse_lines(&read_raw_lines(&file)).iter().filter(|p| str_of(p, "t") == Some(defaults::text("defect.t_ruling"))).count();
    let res = append_line(&file, &line_str, false, false);
    let outcome = if res == defaults::text("defect.out_occurrence_appended") { defaults::text("defect.out_ruled") } else { res };
    if outcome != defaults::text("defect.out_ruled") {
        return Ok(with_trunc(vec![outcome_member(outcome), fp_member()], &tr));
    }
    if tr.spill.is_empty() {
        return Ok(with_trunc(vec![outcome_member(outcome), fp_member()], &tr));
    }
    let summary = spill_overflow(&file, defaults::text("defect.t_ruling"), ruling_seq, &tr.spill, &at);
    Ok(with_trunc(vec![outcome_member(outcome), fp_member(), (defaults::text("defect.key_overflow").to_string(), summary)], &tr))
}

/// `yyyymm(ms)` (UTC).
fn yyyymm(ms: f64) -> String {
    let (y, m, _) = date::civil_from_days((ms / 86_400_000.0).floor() as i64);
    format!("{y}-{m:02}")
}

/// `archiveSweep(now)`: one `{fp, moved, ...}` per file.
pub fn archive_sweep(now_ms: f64, home: &str) -> Result<J, Defer> {
    ensure_dir(&defects_dir(home));
    let Some(names) = jsonl_names(&defects_dir(home)) else { return Ok(J::Arr(Vec::new())) };
    let mut results = Vec::new();
    let ext = defaults::text("defect.file_ext");
    for name in names {
        let fp = name.strip_suffix(ext).unwrap_or(&name).to_string();
        let file = defects_dir(home).join(&name);
        let st = derive_state(&parse_lines(&read_raw_lines(&file)));
        let row = |moved: bool, reason: Option<&str>, dest: Option<String>| {
            let mut o = vec![("fp".to_string(), J::Str(fp.clone())), ("moved".to_string(), J::Bool(moved))];
            if let Some(r) = reason {
                o.push(("reason".to_string(), J::Str(r.into())));
            }
            if let Some(d) = dest {
                o.push(("dest".to_string(), J::Str(d)));
            }
            J::Obj(o)
        };
        if is_unfinished(&st.status) {
            results.push(row(false, Some(&st.status), None));
            continue;
        }
        let last_seen = match st.last_seen.as_deref().map(date::parse) {
            Some(date::Parsed::Ms(ms)) => Some(ms),
            Some(date::Parsed::Unknown) => return Err(Defer),
            _ => None,
        };
        if last_seen.is_none_or(|ls| now_ms - ls < defaults::num("defect.archive_age_ms") as f64) {
            results.push(row(false, Some(defaults::text("defect.reason_too_recent")), None));
            continue;
        }
        if count_archive_files(home) >= defaults::num("defect.max_archive_files") as usize {
            results.push(row(false, Some(defaults::text("defect.reason_archive_full")), None));
            continue;
        }
        let dest_dir = archive_dir(home).join(yyyymm(now_ms));
        ensure_dir(&dest_dir);
        let dest = dest_dir.join(&name);
        if std::fs::rename(&file, &dest).is_err() {
            return Err(Defer); // Node throws here and the tool exits with a stack trace; the Node tool decides
        }
        results.push(row(true, None, Some(dest.to_string_lossy().into_owned())));
    }
    Ok(J::Arr(results))
}

/// `listDefects({home})`
pub fn list_defects(home: &str) -> J {
    let dir = defects_dir(home);
    let Some(names) = jsonl_names(&dir) else { return J::Arr(Vec::new()) };
    let ext = defaults::text("defect.file_ext");
    J::Arr(
        names
            .iter()
            .map(|name| {
                let fp = name.strip_suffix(ext).unwrap_or(name).to_string();
                let parsed = parse_lines(&read_raw_lines(&dir.join(name)));
                let state = derive_state(&parsed);
                let last_report = parsed.iter().rev().find(|p| str_of(p, "t") == Some(defaults::text("defect.t_report")));
                let mut o = vec![("fp".to_string(), J::Str(fp))];
                for k in ["proj", "class", "sev"] {
                    if let Some(v) = last_report.and_then(|r| r.get(k)) {
                        o.push((k.to_string(), v.clone()));
                    }
                }
                for (k, v) in state.members() {
                    match o.iter_mut().find(|(n, _)| *n == k) {
                        Some(slot) => slot.1 = v,
                        None => o.push((k, v)),
                    }
                }
                J::Obj(o)
            })
            .collect(),
    )
}

/// `showDefect(fp)`: `{fp, lines, ...state}`, `None` when no file has it.
pub fn show_defect(fp: &str, home: &str) -> Option<J> {
    let ext = defaults::text("defect.file_ext");
    let mut file = fp_file(fp, home);
    if !file.exists() {
        let mut months: Vec<String> = std::fs::read_dir(archive_dir(home)).ok().map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        months.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        let mut found = months.iter().map(|m| archive_dir(home).join(m).join(format!("{fp}{ext}"))).find(|c| c.exists());
        if found.is_none() {
            let h = history_dir(home).join(format!("{fp}{ext}"));
            if h.exists() {
                found = Some(h);
            }
        }
        file = found?;
    }
    let parsed = parse_lines(&read_raw_lines(&file));
    let state = derive_state(&parsed);
    let mut o = vec![("fp".to_string(), J::Str(fp.to_string())), ("lines".to_string(), J::Arr(parsed))];
    for (k, v) in state.members() {
        match o.iter_mut().find(|(n, _)| *n == k) {
            Some(slot) => slot.1 = v,
            None => o.push((k, v)),
        }
    }
    Some(J::Obj(o))
}
