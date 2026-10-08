//! The bug history: backfill the fixed bugs of a repository's git history, group every record by component and cause, and find
//! past fixes that look like a new bug. Port of `hooks/lib/defect-history.js`.
//!
//! The keyword rules, the stop words, the thresholds, the report layout and the git invocations are the plugin's
//! `engine/defaults/defect.toml`; this file holds the logic only.
use super::store::{self, State};
use crate::checks::git::util::resolve;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::date;
use crate::checks::jsport::json::{self, J};
use crate::defaults;
use crate::ops::js::{Defer, cmp_semver, head16, len16, locale_compare};
use regex::Regex;
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn rx(key: &str, ci: bool) -> Regex {
    jsre::compile(defaults::text(key), ci)
}

// ---- classification ---------------------------------------------------------------------------------------------------

/// `classifyCause(text)`: one of the cause enum (never none).
pub fn classify_cause(text: &str) -> String {
    let s = text.to_lowercase();
    let mut best = defaults::text("defect.cause_other").to_string();
    let mut best_score = 0;
    for rule in defaults::raw("defect.cause_rules").as_array().unwrap_or_default() {
        let cause = rule.str_field("cause");
        let mut score = 0;
        for (field, ci) in [("patterns", false), ("patterns_ci", true)] {
            for p in rule.get(field).map(defaults::V::strings).unwrap_or_default() {
                if jsre::compile(p, ci).is_match(&s) {
                    score += 1;
                }
            }
        }
        if score > best_score {
            best = cause.to_string();
            best_score = score;
        }
    }
    best
}

/// One changed file of a commit.
pub struct FileChange {
    file: String,
    added: i64,
    deleted: i64,
}

/// `isSourceFile(p)`
fn is_source_file(p: &str) -> bool {
    let s = p.replace('\\', "/");
    rx("defect.source_ext", false).is_match(&s) && !rx("defect.nonsource_dir", false).is_match(&s) && !rx("defect.test_file", false).is_match(&s)
}

/// `testedModule(p)`
fn tested_module(p: &str) -> Result<Option<String>, Defer> {
    let s = p.replace('\\', "/");
    match rx("defect.tested_module", false).captures(&s) {
        Some(c) => store::normalize_component(c.get(1).map_or("", |m| m.as_str())),
        None => Ok(None),
    }
}

/// `dominantComponent(files, scope)`
fn dominant_component(files: &[FileChange], scope: Option<&str>) -> Result<Option<String>, Defer> {
    let biggest = |pred: &dyn Fn(&str) -> bool| -> Option<&str> {
        let mut best: Option<(&str, i64)> = None;
        for f in files {
            if !pred(&f.file) {
                continue;
            }
            let n = f.added + f.deleted;
            if best.is_none_or(|(_, bn)| n > bn) {
                best = Some((&f.file, n));
            }
        }
        best.map(|(f, _)| f)
    };
    if let Some(src) = biggest(&is_source_file) {
        return store::normalize_component(src);
    }
    if let Some(sc) = scope.filter(|s| !s.is_empty()) {
        return store::normalize_component(sc);
    }
    let tested = |p: &str| tested_module(p).ok().flatten().is_some();
    if let Some(t) = biggest(&tested) {
        return tested_module(t);
    }
    let skill = rx("defect.skill_file", false);
    if let Some(sk) = biggest(&|p| skill.is_match(p)) {
        return store::normalize_component(&rx("defect.skill_suffix", false).replace(sk, ""));
    }
    Ok(None)
}

// ---- git and changelog readers ----------------------------------------------------------------------------------------

/// A git failure as Node's `execFileSync` message: its first line is `Command failed: git -C <repo> <args>`.
pub struct GitFail(pub String);

fn git(repo: &str, args: &[String]) -> Result<String, GitFail> {
    let mut full = vec![defaults::text("defect.git_dir_flag").to_string(), repo.to_string()];
    full.extend(args.iter().cloned());
    let out = Command::new(defaults::text("defect.git_bin")).args(&full).stdin(Stdio::null()).output();
    match out {
        Err(_) => Err(GitFail(defaults::render("defect.git_spawn_failed", &[("bin", &defaults::text("defect.git_bin"))]))),
        Ok(o) if !o.status.success() => Err(GitFail(defaults::render("defect.git_command_failed", &[("cmd", &format!("{} {}", defaults::text("defect.git_bin"), full.join(" ")))]))),
        Ok(o) => Ok(String::from_utf8_lossy(&o.stdout).into_owned()),
    }
}

/// One fix commit.
struct Commit {
    sha: String,
    date: String,
    subject: String,
    body: String,
    scope: Option<String>,
    files: Vec<FileChange>,
}

fn parse_int_or_zero(s: &str) -> i64 {
    let t = js_trim(s);
    let end = t.char_indices().find(|(i, c)| !(c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+')))).map_or(t.len(), |(i, _)| i);
    t[..end].parse::<i64>().unwrap_or(0)
}

fn collect_fix_commits(repo: &str) -> Result<Vec<Commit>, GitFail> {
    let rs = defaults::text("defect.rs_char");
    let us = defaults::text("defect.us_char");
    let args: Vec<String> = defaults::list("defect.git_log_args").iter().map(|a| a.replace("{rs}", rs).replace("{us}", us)).collect();
    let out = git(repo, &args)?;
    let fix = rx("defect.fix_subject", true);
    let mut commits = Vec::new();
    for chunk in out.split(rs) {
        if js_trim(chunk).is_empty() {
            continue;
        }
        let parts: Vec<&str> = chunk.split(us).collect();
        if parts.len() < 5 {
            continue;
        }
        let (sha, date, subject, body) = (parts[0], parts[1], parts[2], parts[3]);
        let Some(m) = fix.captures(subject) else { continue };
        let mut files = Vec::new();
        for line in parts[4..].join(us).split('\n') {
            let t: Vec<&str> = line.split('\t').collect();
            if t.len() < 3 {
                continue;
            }
            files.push(FileChange { file: t[2..].join("\t"), added: parse_int_or_zero(t[0]), deleted: parse_int_or_zero(t[1]) });
        }
        commits.push(Commit {
            sha: sha.to_string(),
            date: date.to_string(),
            subject: subject.to_string(),
            body: js_trim(body).to_string(),
            scope: m.get(2).map(|s| s.as_str().to_string()),
            files,
        });
    }
    Ok(commits)
}

/// `releaseMap(repo)`: the earliest semver tag containing each commit.
fn release_map(repo: &str) -> Result<HashMap<String, String>, GitFail> {
    let tag_re = rx("defect.tag_re", false);
    let mut tags: Vec<String> = git(repo, &defaults::list("defect.git_tag_args").iter().map(|s| s.to_string()).collect::<Vec<_>>())?
        .split('\n')
        .map(|t| js_trim(t).to_string())
        .filter(|t| tag_re.is_match(t))
        .collect();
    let strip = |t: &str| t.strip_prefix('v').unwrap_or(t).to_string();
    tags.sort_by(|a, b| cmp_semver(&strip(a), &strip(b)).unwrap_or(0).cmp(&0));
    let mut map = HashMap::new();
    for tag in &tags {
        let args: Vec<String> = defaults::list("defect.git_revlist_args").iter().map(|a| a.replace("{tag}", tag)).collect();
        for sha in git(repo, &args)?.split('\n') {
            if !sha.is_empty() {
                map.entry(sha.to_string()).or_insert_with(|| strip(tag));
            }
        }
    }
    Ok(map)
}

/// `parseChangelog(text)`: the bullets of each `## X.Y.Z` section.
fn parse_changelog(text: &str) -> HashMap<String, Vec<String>> {
    let head = rx("defect.cl_heading", false);
    let any_head = rx("defect.cl_any_heading", false);
    let bullet_re = rx("defect.cl_bullet", false);
    let cont_re = rx("defect.cl_continuation", false);
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let mut cur: Option<String> = None;
    let mut bullet: Option<String> = None;
    fn flush(map: &mut HashMap<String, Vec<String>>, cur: &Option<String>, bullet: &mut Option<String>) {
        if let (Some(c), Some(b)) = (cur, bullet.take()) {
            let folded = crate::checks::guardkit::text::collapse_ws(&b);
            if let Some(list) = map.get_mut(c) {
                list.push(js_trim(&folded).to_string());
            }
        }
    }
    for line in text.split('\n') {
        if let Some(h) = head.captures(line) {
            flush(&mut map, &cur, &mut bullet);
            let v = h.get(1).map_or("", |m| m.as_str()).to_string();
            map.entry(v.clone()).or_default();
            cur = Some(v);
            continue;
        }
        if cur.is_none() {
            continue;
        }
        if any_head.is_match(line) {
            flush(&mut map, &cur, &mut bullet);
            continue;
        }
        if let Some(b) = bullet_re.captures(line) {
            flush(&mut map, &cur, &mut bullet);
            bullet = Some(b.get(1).map_or("", |m| m.as_str()).to_string());
            continue;
        }
        if bullet.is_some() && cont_re.is_match(line) {
            if let Some(b) = bullet.as_mut() {
                b.push(' ');
                b.push_str(js_trim(line));
            }
        } else if js_trim(line).is_empty() {
            flush(&mut map, &cur, &mut bullet);
        }
    }
    flush(&mut map, &cur, &mut bullet);
    map
}

// ---- token scoring ----------------------------------------------------------------------------------------------------

/// `tokens(text)`: lower-cased word tokens of three or more characters, plural `s` stripped, without stop words or bare numbers.
fn tokens(text: &str) -> BTreeSet<String> {
    let stop: HashSet<&str> = defaults::words("defect.stop_words").into_iter().collect();
    let mut set = BTreeSet::new();
    for raw in text.to_lowercase().split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())) {
        let mut t = raw.to_string();
        if t.len() > 4 && t.ends_with('s') && !t.ends_with("ss") {
            t.pop();
        }
        if t.len() >= 3 && !stop.contains(t.as_str()) && !t.bytes().all(|b| b.is_ascii_digit()) {
            set.insert(t);
        }
    }
    set
}

fn overlap(a: &BTreeSet<String>, b: &BTreeSet<String>) -> usize {
    a.iter().filter(|t| b.contains(*t)).count()
}

/// `linkChangelog(subject, bullets)`: the bullet sharing the most tokens with the subject (at least two).
fn link_changelog(subject: &str, bullets: &[String]) -> Option<String> {
    let st = tokens(&rx("defect.fix_subject", true).replace(subject, ""));
    let mut best: Option<&String> = None;
    let mut best_n = 1;
    for b in bullets {
        let n = overlap(&st, &tokens(b));
        if n > best_n {
            best = Some(b);
            best_n = n;
        }
    }
    best.cloned()
}

fn fixed_in_for(subject: &str, tag_version: Option<&str>) -> Option<String> {
    let Some(m) = rx("defect.subject_version", true).captures(subject) else { return tag_version.map(str::to_string) };
    let v = m.get(2).map_or("", |x| x.as_str());
    let sv = if v.split('.').count() == 2 { format!("{v}.0") } else { v.to_string() };
    match tag_version {
        None => Some(sv),
        Some(t) => match cmp_semver(&sv, t) {
            Some(c) if c < 0 => Some(sv),
            _ => Some(t.to_string()),
        },
    }
}

// ---- backfill ---------------------------------------------------------------------------------------------------------

/// What `backfill` did.
pub struct Backfill {
    pub repo: String,
    pub dry_run: bool,
    pub scanned: usize,
    pub imported: usize,
    pub existing: usize,
    pub failed: usize,
}

/// `backfill({repo, dryRun})`; `Err(Ok(message))` when git could not read the history, `Err(Err(Defer))` to defer.
pub fn backfill(repo_arg: &str, dry_run: bool, home: &str) -> Result<Backfill, Result<GitFail, Defer>> {
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let repo = resolve(repo_arg, "", &cwd);
    let commits = collect_fix_commits(&repo).map_err(Ok)?;
    let releases = release_map(&repo).map_err(Ok)?;
    let changelog = std::fs::read(Path::new(&repo).join(defaults::text("defect.changelog_file"))).ok().map(|b| parse_changelog(&String::from_utf8_lossy(&b))).unwrap_or_default();
    let dir = store::history_dir(home);
    let mut res = Backfill { repo: repo.clone(), dry_run, scanned: commits.len(), imported: 0, existing: 0, failed: 0 };
    for c in &commits {
        let fixed_in = fixed_in_for(&c.subject, releases.get(&c.sha).map(String::as_str));
        let subject = store::clamp_field(&c.subject, defaults::num("defect.history_subject_cap") as usize).map_err(Err)?;
        let component = dominant_component(&c.files, c.scope.as_deref()).map_err(Err)?;
        let cause = classify_cause(&format!("{}\n{}", c.subject, c.body));
        let mut rec = vec![
            ("t".to_string(), J::Str(defaults::text("defect.t_backfill").into())),
            ("at".to_string(), J::Str(c.date.clone())),
            ("source".to_string(), J::Str(defaults::text("defect.t_backfill").into())),
            ("status".to_string(), J::Str(defaults::text("defect.status_fixed").into())),
            ("fixCommit".to_string(), J::Str(c.sha.clone())),
            ("subject".to_string(), J::Str(subject)),
            ("component".to_string(), component.map_or(J::Null, J::Str)),
            ("cause".to_string(), J::Str(cause)),
            ("fixedIn".to_string(), fixed_in.clone().map_or(J::Null, J::Str)),
        ];
        let cl = fixed_in.as_deref().and_then(|f| link_changelog(&c.subject, changelog.get(f).map_or(&[][..], |v| v.as_slice())));
        if let Some(cl) = cl {
            rec.push(("changelog".to_string(), J::Str(store::clamp_field(&cl, defaults::num("defect.history_changelog_cap") as usize).map_err(Err)?)));
        }
        let file = dir.join(format!("{}{}", &c.sha[..c.sha.len().min(defaults::num("defect.fp_len") as usize)], defaults::text("defect.file_ext")));
        if file.exists() {
            res.existing += 1;
            continue;
        }
        if dry_run {
            res.imported += 1;
            continue;
        }
        crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: a failed mkdir surfaces as the write below failing
        let w = store::append_line(&file, &json::stringify(&J::Obj(rec)), true, true);
        if w == defaults::text("defect.out_recorded") {
            res.imported += 1;
        } else if w == defaults::text("defect.out_exists") {
            res.existing += 1;
        } else {
            res.failed += 1;
        }
    }
    Ok(res)
}

// ---- loading ----------------------------------------------------------------------------------------------------------

/// One flat record for `recurring` and `similar`.
#[derive(Clone)]
pub struct Record {
    fp: String,
    source: String,
    status: String,
    component: Option<String>,
    cause: Option<String>,
    fixed_in: Option<String>,
    fix_commit: Option<String>,
    regression_of: Option<String>,
    date: Option<String>,
    subject: Option<String>,
    changelog: Option<String>,
    class: Option<String>,
}

fn s_of(o: &J, k: &str) -> Result<Option<String>, Defer> {
    match o.get(k) {
        None | Some(J::Null) => Ok(None),
        Some(J::Str(s)) => Ok(Some(s.clone())),
        Some(_) => Err(Defer),
    }
}

fn normalize_record(fp: &str, parsed: &[J]) -> Result<Record, Defer> {
    let st: State = store::derive_state(parsed);
    let t_of = |p: &J| match p.get("t") {
        Some(J::Str(s)) => s.clone(),
        _ => String::new(),
    };
    let last_report = parsed.iter().rev().find(|p| t_of(p) == defaults::text("defect.t_report"));
    let bf = parsed.iter().find(|p| t_of(p) == defaults::text("defect.t_backfill"));
    let nz = |s: Option<&str>| s.filter(|v| !v.is_empty()).map(str::to_string);
    Ok(Record {
        fp: fp.to_string(),
        source: if bf.is_some() { defaults::text("defect.t_backfill") } else { defaults::text("defect.source_reported") }.to_string(),
        status: st.status.clone(),
        component: nz(st.extra("component")),
        cause: nz(st.extra("cause")),
        fixed_in: nz(st.extra("fixedIn")),
        fix_commit: nz(st.extra("fixCommit")),
        regression_of: nz(st.extra("regressionOf")),
        date: match bf {
            Some(b) => s_of(b, "at")?,
            None => st.first_seen.clone().filter(|s| !s.is_empty()),
        },
        subject: match (bf, last_report) {
            (Some(b), _) => s_of(b, "subject")?,
            (None, Some(r)) => s_of(r, "sym")?,
            (None, None) => Some(String::new()),
        },
        changelog: match bf {
            Some(b) => s_of(b, "changelog")?.filter(|s| !s.is_empty()),
            None => None,
        },
        class: match last_report {
            Some(r) => s_of(r, "class")?,
            None => None,
        },
    })
}

/// `loadAllRecords(home)`: every reported defect (open dir and archive buckets) plus every backfill record.
pub fn load_all_records(home: &str) -> Result<Vec<Record>, Defer> {
    let mut files: Vec<PathBuf> = Vec::new();
    let add = |dir: &Path, files: &mut Vec<PathBuf>| {
        for n in store::jsonl_names(dir).unwrap_or_default() {
            files.push(dir.join(n));
        }
    };
    add(&store::defects_dir(home), &mut files);
    let mut months: Vec<String> = std::fs::read_dir(store::archive_dir(home)).ok().map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    months.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    for m in &months {
        add(&store::archive_dir(home).join(m), &mut files);
    }
    add(&store::history_dir(home), &mut files);
    let mut out = Vec::new();
    for f in files {
        let parsed = store::parse_lines(&store::read_raw_lines(&f));
        if parsed.is_empty() {
            continue;
        }
        let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let fp = name.strip_suffix(defaults::text("defect.file_ext")).unwrap_or(&name).to_string();
        out.push(normalize_record(&fp, &parsed)?);
    }
    Ok(out)
}

// ---- recurring --------------------------------------------------------------------------------------------------------

fn is_version(s: &str) -> bool {
    rx("defect.version_re", false).is_match(s)
}

/// A record predicate.
type RecordFilter = Box<dyn Fn(&Record) -> bool>;

fn since_filter(since: Option<&str>) -> Result<RecordFilter, Defer> {
    let Some(since) = since.filter(|s| !s.is_empty()) else { return Ok(Box::new(|_| true)) };
    if is_version(since) {
        let v = since.strip_prefix('v').unwrap_or(since).to_string();
        return Ok(Box::new(move |r| match &r.fixed_in {
            None => true,
            Some(f) => cmp_semver(f, &v).is_some_and(|c| c >= 0),
        }));
    }
    match date::parse(since) {
        date::Parsed::Unknown => Err(Defer),
        date::Parsed::Nan => Ok(Box::new(|_| true)),
        date::Parsed::Ms(t) => Ok(Box::new(move |r| match r.date.as_deref().map(date::parse) {
            Some(date::Parsed::Ms(d)) => d >= t,
            _ => false,
        })),
    }
}

struct Span {
    versions: Vec<String>,
    first: Option<String>,
    last: Option<String>,
}

fn span(list: &[&Record]) -> Span {
    let mut versions: Vec<String> = Vec::new();
    for r in list {
        if let Some(f) = &r.fixed_in
            && !versions.contains(f)
        {
            versions.push(f.clone());
        }
    }
    versions.sort_by(|a, b| cmp_semver(a, b).unwrap_or(0).cmp(&0));
    let mut dates: Vec<&String> = list.iter().filter_map(|r| r.date.as_ref()).collect();
    dates.sort();
    Span { versions, first: dates.first().map(|s| (*s).clone()), last: dates.last().map(|s| (*s).clone()) }
}

fn span_members(sp: &Span) -> Vec<(String, J)> {
    vec![
        ("versions".into(), J::Arr(sp.versions.iter().map(|v| J::Str(v.clone())).collect())),
        ("firstDate".into(), sp.first.clone().map_or(J::Null, J::Str)),
        ("lastDate".into(), sp.last.clone().map_or(J::Null, J::Str)),
    ]
}

fn group_by<'a>(records: &[&'a Record], key: impl Fn(&Record) -> String) -> Vec<(String, Vec<&'a Record>)> {
    let mut groups: Vec<(String, Vec<&Record>)> = Vec::new();
    for r in records {
        let k = key(r);
        match groups.iter_mut().find(|(n, _)| *n == k) {
            Some(g) => g.1.push(r),
            None => groups.push((k, vec![r])),
        }
    }
    groups
}

fn lc(a: &str, b: &str) -> Result<Ordering, Defer> {
    locale_compare(a, b)
}

/// A sort that may defer: the comparator can fail on text it has no collation weight for.
fn sort_by_try<T>(v: &mut [T], mut cmp: impl FnMut(&T, &T) -> Result<Ordering, Defer>) -> Result<(), Defer> {
    let mut failed = false;
    v.sort_by(|a, b| match cmp(a, b) {
        Ok(o) => o,
        Err(_) => {
            failed = true;
            Ordering::Equal
        }
    });
    if failed { Err(Defer) } else { Ok(()) }
}

/// The `recurring` report, as an object, and the same data for the text layout.
pub struct Recurring {
    pub json: J,
    total: usize,
    since: Option<String>,
    by_component: Vec<ByComponent>,
    by_cause: Vec<ByCause>,
    hotspots: Vec<Hotspot>,
    regressions: Vec<Regression>,
}

struct ByComponent {
    component: String,
    count: usize,
    causes: Vec<(String, usize)>,
    sp: Span,
}
struct ByCause {
    cause: String,
    count: usize,
    components: usize,
    sp: Span,
}
struct Hotspot {
    kind: String,
    component: String,
    cause: Option<String>,
    count: usize,
    sp: Span,
}
struct Regression {
    explicit: bool,
    fp: String,
    fix_commit: Option<String>,
    component: Option<String>,
    cause: Option<String>,
    fixed_in: Option<String>,
    subject: Option<String>,
    earlier_fp: String,
    earlier_commit: Option<String>,
    earlier_fixed_in: Option<String>,
    distance: Option<usize>,
}

/// `recurring(allRecords, {since})`
pub fn recurring(all: &[Record], since: Option<&str>) -> Result<Recurring, Defer> {
    let pass = since_filter(since)?;
    let records: Vec<&Record> = all.iter().filter(|r| pass(r)).collect();
    let unclassified = defaults::text("defect.unclassified");
    let comp = |r: &Record| r.component.clone().unwrap_or_else(|| unclassified.to_string());
    let cause = |r: &Record| r.cause.clone().unwrap_or_else(|| unclassified.to_string());

    let mut by_component: Vec<ByComponent> = group_by(&records, comp)
        .into_iter()
        .map(|(component, list)| {
            let causes = group_by(&list, cause).into_iter().map(|(k, v)| (k, v.len())).collect();
            ByComponent { component, count: list.len(), causes, sp: span(&list) }
        })
        .collect();
    sort_by_try(&mut by_component, |a, b| Ok(b.count.cmp(&a.count).then(lc(&a.component, &b.component)?)))?;

    let mut by_cause: Vec<ByCause> = group_by(&records, cause)
        .into_iter()
        .map(|(c, list)| {
            let comps: HashSet<String> = list.iter().map(|r| comp(r)).collect();
            ByCause { cause: c, count: list.len(), components: comps.len(), sp: span(&list) }
        })
        .collect();
    sort_by_try(&mut by_cause, |a, b| Ok(b.count.cmp(&a.count).then(lc(&a.cause, &b.cause)?)))?;

    let comp_min = defaults::num("defect.hotspot_component_min") as usize;
    let pair_min = defaults::num("defect.hotspot_pair_min") as usize;
    let window = defaults::num("defect.regression_window") as usize;
    let mut hotspots: Vec<Hotspot> = Vec::new();
    for c in &by_component {
        if c.component == unclassified {
            continue;
        }
        if c.count >= comp_min {
            let list: Vec<&Record> = records.iter().copied().filter(|r| comp(r) == c.component).collect();
            hotspots.push(Hotspot { kind: defaults::text("defect.kind_component").into(), component: c.component.clone(), cause: None, count: c.count, sp: span(&list) });
        }
    }
    let sep = defaults::text("defect.pair_sep");
    let classified: Vec<&Record> = records.iter().copied().filter(|r| r.component.is_some() && r.cause.is_some()).collect();
    let pairs = group_by(&classified, |r| format!("{}{sep}{}", r.component.clone().unwrap_or_default(), r.cause.clone().unwrap_or_default()));
    for (k, list) in &pairs {
        if list.len() < pair_min {
            continue;
        }
        let (component, c) = k.split_once(sep).unwrap_or((k, ""));
        hotspots.push(Hotspot { kind: defaults::text("defect.kind_pair").into(), component: component.to_string(), cause: Some(c.to_string()), count: list.len(), sp: span(list) });
    }
    let kind_component = defaults::text("defect.kind_component");
    sort_by_try(&mut hotspots, |a, b| {
        let kind_rank = |h: &Hotspot| if h.kind == kind_component { -1 } else { 1 };
        Ok(b.count.cmp(&a.count).then((kind_rank(a) - kind_rank(b)).cmp(&0)).then(lc(&a.component, &b.component)?))
    })?;

    let mut rel: Vec<String> = Vec::new();
    for r in &records {
        if let Some(f) = &r.fixed_in
            && !rel.contains(f)
        {
            rel.push(f.clone());
        }
    }
    rel.sort_by(|a, b| cmp_semver(a, b).unwrap_or(0).cmp(&0));
    let idx = |r: &Record| r.fixed_in.as_ref().map_or(rel.len(), |f| rel.iter().position(|x| x == f).unwrap_or(0));
    let mut regressions: Vec<Regression> = Vec::new();
    let by_fp: HashMap<&str, &Record> = all.iter().map(|r| (r.fp.as_str(), r)).collect();
    for r in &records {
        if let Some(of) = &r.regression_of {
            let e = by_fp.get(of.as_str());
            regressions.push(Regression {
                explicit: true,
                fp: r.fp.clone(),
                fix_commit: r.fix_commit.clone(),
                component: r.component.clone(),
                cause: r.cause.clone(),
                fixed_in: r.fixed_in.clone(),
                subject: r.subject.clone(),
                earlier_fp: of.clone(),
                earlier_commit: e.and_then(|e| e.fix_commit.clone()),
                earlier_fixed_in: e.and_then(|e| e.fixed_in.clone()),
                distance: None,
            });
        }
    }
    for (_, list) in &pairs {
        let mut fixed: Vec<&Record> = list.iter().copied().filter(|r| r.status == defaults::text("defect.status_fixed") || r.source == defaults::text("defect.t_backfill")).collect();
        sort_by_try(&mut fixed, |a, b| {
            let da = a.date.clone().unwrap_or_else(|| defaults::text("defect.null_word").to_string());
            let db = b.date.clone().unwrap_or_else(|| defaults::text("defect.null_word").to_string());
            Ok(idx(a).cmp(&idx(b)).then(lc(&da, &db)?))
        })?;
        for i in 1..fixed.len() {
            let cur = fixed[i];
            if regressions.iter().any(|g| g.fp == cur.fp) {
                continue;
            }
            let prev = fixed[i - 1];
            let d = idx(cur) as i64 - idx(prev) as i64;
            if d >= 1 && d as usize <= window {
                regressions.push(Regression {
                    explicit: false,
                    fp: cur.fp.clone(),
                    fix_commit: cur.fix_commit.clone(),
                    component: cur.component.clone(),
                    cause: cur.cause.clone(),
                    fixed_in: cur.fixed_in.clone(),
                    subject: cur.subject.clone(),
                    earlier_fp: prev.fp.clone(),
                    earlier_commit: prev.fix_commit.clone(),
                    earlier_fixed_in: prev.fixed_in.clone(),
                    distance: Some(d as usize),
                });
            }
        }
    }
    let opt_s = |v: &Option<String>| v.clone().map_or(J::Null, J::Str);
    let n = |v: usize| J::Num(v as f64);
    let json = J::Obj(vec![
        ("total".into(), n(records.len())),
        ("since".into(), since.filter(|s| !s.is_empty()).map_or(J::Null, |s| J::Str(s.into()))),
        (
            "byComponent".into(),
            J::Arr(
                by_component
                    .iter()
                    .map(|c| {
                        let mut o = vec![
                            ("component".to_string(), J::Str(c.component.clone())),
                            ("count".to_string(), n(c.count)),
                            ("causes".to_string(), J::Obj(c.causes.iter().map(|(k, v)| (k.clone(), n(*v))).collect())),
                        ];
                        o.extend(span_members(&c.sp));
                        J::Obj(o)
                    })
                    .collect(),
            ),
        ),
        (
            "byCause".into(),
            J::Arr(
                by_cause
                    .iter()
                    .map(|c| {
                        let mut o = vec![("cause".to_string(), J::Str(c.cause.clone())), ("count".to_string(), n(c.count)), ("components".to_string(), n(c.components))];
                        o.extend(span_members(&c.sp));
                        J::Obj(o)
                    })
                    .collect(),
            ),
        ),
        (
            "hotspots".into(),
            J::Arr(
                hotspots
                    .iter()
                    .map(|h| {
                        let mut o = vec![
                            ("kind".to_string(), J::Str(h.kind.clone())),
                            ("component".to_string(), J::Str(h.component.clone())),
                            ("cause".to_string(), opt_s(&h.cause)),
                            ("count".to_string(), n(h.count)),
                        ];
                        o.extend(span_members(&h.sp));
                        J::Obj(o)
                    })
                    .collect(),
            ),
        ),
        (
            "regressions".into(),
            J::Arr(
                regressions
                    .iter()
                    .map(|g| {
                        J::Obj(vec![
                            ("explicit".into(), J::Bool(g.explicit)),
                            ("fp".into(), J::Str(g.fp.clone())),
                            ("fixCommit".into(), opt_s(&g.fix_commit)),
                            ("component".into(), opt_s(&g.component)),
                            ("cause".into(), opt_s(&g.cause)),
                            ("fixedIn".into(), opt_s(&g.fixed_in)),
                            ("subject".into(), opt_s(&g.subject)),
                            ("earlierFp".into(), J::Str(g.earlier_fp.clone())),
                            ("earlierCommit".into(), opt_s(&g.earlier_commit)),
                            ("earlierFixedIn".into(), opt_s(&g.earlier_fixed_in)),
                            ("distance".into(), g.distance.map_or(J::Null, n)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    Ok(Recurring { json, total: records.len(), since: since.filter(|s| !s.is_empty()).map(str::to_string), by_component, by_cause, hotspots, regressions })
}

// ---- similar ----------------------------------------------------------------------------------------------------------

fn component_matches(rec: Option<&str>, want: &str) -> bool {
    rec.is_some_and(|r| r == want || r.ends_with(&format!("/{want}")) || want.ends_with(&format!("/{r}")))
}

/// A scored record.
pub struct Scored {
    score: usize,
    rec: Record,
}

/// `similar(records, text, {component, top})`
pub fn similar(records: &[Record], text: &str, component: Option<&str>, top: usize) -> Result<Vec<Scored>, Defer> {
    let want = match component.filter(|c| !c.is_empty()) {
        Some(c) => store::normalize_component(c)?,
        None => None,
    };
    let q = tokens(text);
    let mut scored: Vec<Scored> = Vec::new();
    for r in records {
        let hay_text = [
            r.subject.clone().unwrap_or_default(),
            r.changelog.clone().unwrap_or_default(),
            r.component.as_deref().map(|c| c.replace(['/', '-'], " ")).unwrap_or_default(),
            r.cause.as_deref().map(|c| c.replace('-', " ")).unwrap_or_default(),
        ]
        .join(" ");
        let hay = tokens(&hay_text);
        let mut score = overlap(&q, &hay);
        if let Some(w) = &want
            && component_matches(r.component.as_deref(), w)
        {
            score += 5;
        }
        if score > 0 {
            scored.push(Scored { score, rec: r.clone() });
        }
    }
    sort_by_try(&mut scored, |a, b| {
        let da = a.rec.date.clone().unwrap_or_else(|| defaults::text("defect.null_word").to_string());
        let db = b.rec.date.clone().unwrap_or_else(|| defaults::text("defect.null_word").to_string());
        Ok(b.score.cmp(&a.score).then(lc(&db, &da)?))
    })?;
    scored.truncate(top);
    Ok(scored)
}

/// The JSON of a `similar` result.
pub fn similar_json(list: &[Scored]) -> J {
    let s = |v: &Option<String>| v.clone().map_or(J::Null, J::Str);
    J::Arr(
        list.iter()
            .map(|x| {
                let r = &x.rec;
                J::Obj(vec![
                    ("score".into(), J::Num(x.score as f64)),
                    ("fp".into(), J::Str(r.fp.clone())),
                    ("source".into(), J::Str(r.source.clone())),
                    ("status".into(), J::Str(r.status.clone())),
                    ("component".into(), s(&r.component)),
                    ("cause".into(), s(&r.cause)),
                    ("fixedIn".into(), s(&r.fixed_in)),
                    ("fixCommit".into(), s(&r.fix_commit)),
                    ("regressionOf".into(), s(&r.regression_of)),
                    ("date".into(), s(&r.date)),
                    ("subject".into(), s(&r.subject)),
                    ("changelog".into(), s(&r.changelog)),
                    ("class".into(), s(&r.class)),
                ])
            })
            .collect(),
    )
}

// ---- plain-text formatting --------------------------------------------------------------------------------------------

/// `pad(s, n)`: `s` in an `n`-wide column, always leaving one separating space.
fn pad(s: &str, n: usize) -> Result<String, Defer> {
    let l = len16(s);
    if l >= n {
        Ok(head16(s, n - 2)? + defaults::text("defect.pad_cut"))
    } else {
        Ok(format!("{s}{}", " ".repeat(n - l)))
    }
}

fn vspan(v: &[String]) -> String {
    match v {
        [] => defaults::text("defect.dash").to_string(),
        [one] => one.clone(),
        [first, .., last] => format!("{first}{}{last}", defaults::text("defect.span_sep")),
    }
}

fn dspan(a: &Option<String>, b: &Option<String>) -> Result<String, Defer> {
    match a {
        None => Ok(defaults::text("defect.dash").to_string()),
        Some(a) => Ok(format!("{}{}{}", head16(a, 10)?, defaults::text("defect.span_sep"), head16(b.as_deref().unwrap_or(defaults::text("defect.null_word")), 10)?)),
    }
}

fn short(sha: &Option<String>) -> Result<String, Defer> {
    match sha {
        Some(s) if !s.is_empty() => head16(s, defaults::num("defect.short_sha") as usize),
        _ => Ok(defaults::text("defect.dash").to_string()),
    }
}

/// `formatRecurring(rep, {top})`
pub fn format_recurring(rep: &Recurring, top: usize) -> Result<String, Defer> {
    let comp_min = defaults::num("defect.hotspot_component_min");
    let pair_min = defaults::num("defect.hotspot_pair_min");
    let window = defaults::num("defect.regression_window");
    let ind = defaults::text("defect.indent");
    let h = |k: &str| defaults::text(k);
    let mut l: Vec<String> = Vec::new();
    let since = rep.since.as_ref().map_or(String::new(), |s| defaults::render("defect.rec_since", &[("since", s)]));
    l.push(defaults::render("defect.rec_total", &[("total", &rep.total), ("since", &since)]));
    l.push(String::new());
    l.push(defaults::render("defect.rec_hotspots", &[("component_min", &comp_min), ("pair_min", &pair_min)]));
    if rep.hotspots.is_empty() {
        l.push(format!("{ind}{}", h("defect.none")));
    } else {
        l.push(format!("{ind}{}{}{}{}{}", pad(h("defect.col_count"), 6)?, pad(h("defect.col_component"), 38)?, pad(h("defect.col_cause"), 24)?, pad(h("defect.col_versions"), 18)?, h("defect.col_dates")));
        for x in rep.hotspots.iter().take(top) {
            l.push(format!(
                "{ind}{}{}{}{}{}",
                pad(&x.count.to_string(), 6)?,
                pad(&x.component, 38)?,
                pad(x.cause.as_deref().unwrap_or(h("defect.any_word")), 24)?,
                pad(&vspan(&x.sp.versions), 18)?,
                dspan(&x.sp.first, &x.sp.last)?
            ));
        }
    }
    l.push(String::new());
    l.push(defaults::render("defect.rec_regressions", &[("window", &window)]));
    if rep.regressions.is_empty() {
        l.push(format!("{ind}{}", h("defect.none")));
    } else {
        for g in rep.regressions.iter().take(top) {
            let what = if g.fix_commit.as_deref().is_some_and(|s| !s.is_empty()) { short(&g.fix_commit)? } else { g.fp.clone() };
            let was = if g.earlier_commit.as_deref().is_some_and(|s| !s.is_empty()) { short(&g.earlier_commit)? } else { g.earlier_fp.clone() };
            let explicit = if g.explicit { h("defect.explicit_word") } else { "" };
            l.push(defaults::render(
                "defect.rec_regression_row",
                &[
                    ("what", &pad(&what, 12)?),
                    ("fixed", &pad(g.fixed_in.as_deref().filter(|s| !s.is_empty()).unwrap_or(h("defect.unreleased")), 11)?),
                    ("was", &pad(&was, 12)?),
                    ("earlier", &pad(g.earlier_fixed_in.as_deref().filter(|s| !s.is_empty()).unwrap_or(h("defect.dash")), 9)?),
                    ("component", &g.component.as_deref().unwrap_or("")),
                    ("cause", &g.cause.as_deref().unwrap_or("")),
                    ("explicit", &explicit),
                ],
            ));
        }
        if rep.regressions.len() > top {
            l.push(defaults::render("defect.rec_more", &[("n", &(rep.regressions.len() - top))]));
        }
    }
    l.push(String::new());
    l.push(h("defect.rec_by_component").to_string());
    l.push(format!("{ind}{}{}{}{}{}", pad(h("defect.col_count"), 6)?, pad(h("defect.col_component"), 38)?, pad(h("defect.col_top_cause"), 24)?, pad(h("defect.col_versions"), 18)?, h("defect.col_dates")));
    for c in rep.by_component.iter().take(top) {
        let tc = c.causes.iter().fold(None::<&(String, usize)>, |best, x| match best {
            Some(b) if b.1 >= x.1 => Some(b),
            _ => Some(x),
        });
        let tc_s = tc.map_or(h("defect.dash").to_string(), |(k, v)| format!("{k} ({v})"));
        l.push(format!("{ind}{}{}{}{}{}", pad(&c.count.to_string(), 6)?, pad(&c.component, 38)?, pad(&tc_s, 24)?, pad(&vspan(&c.sp.versions), 18)?, dspan(&c.sp.first, &c.sp.last)?));
    }
    l.push(String::new());
    l.push(h("defect.rec_by_cause").to_string());
    l.push(format!("{ind}{}{}{}{}{}", pad(h("defect.col_count"), 6)?, pad(h("defect.col_cause"), 24)?, pad(h("defect.col_components"), 12)?, pad(h("defect.col_versions"), 18)?, h("defect.col_dates")));
    for c in &rep.by_cause {
        l.push(format!("{ind}{}{}{}{}{}", pad(&c.count.to_string(), 6)?, pad(&c.cause, 24)?, pad(&c.components.to_string(), 12)?, pad(&vspan(&c.sp.versions), 18)?, dspan(&c.sp.first, &c.sp.last)?));
    }
    Ok(l.join("\n") + "\n")
}

/// `formatSimilar(list)`
pub fn format_similar(list: &[Scored]) -> Result<String, Defer> {
    let h = |k: &str| defaults::text(k);
    if list.is_empty() {
        return Ok(h("defect.sim_none").to_string() + "\n");
    }
    let ind = defaults::text("defect.indent");
    let mut l = vec![format!(
        "{ind}{}{}{}{}{}{}",
        pad(h("defect.col_score"), 6)?,
        pad(h("defect.col_commit"), 9)?,
        pad(h("defect.col_version"), 11)?,
        pad(h("defect.col_component"), 34)?,
        pad(h("defect.col_cause"), 23)?,
        h("defect.col_summary")
    )];
    for x in list {
        let r = &x.rec;
        let subj = crate::checks::guardkit::text::collapse_ws(r.subject.as_deref().unwrap_or(""));
        let sum = head16(&subj, defaults::num("defect.summary_cap") as usize)?;
        let commit = if r.fix_commit.as_deref().is_some_and(|s| !s.is_empty()) { short(&r.fix_commit)? } else { r.fp.clone() };
        let version = match r.fixed_in.as_deref().filter(|s| !s.is_empty()) {
            Some(v) => v.to_string(),
            None if r.source == defaults::text("defect.t_backfill") => h("defect.unreleased").to_string(),
            None => r.status.clone(),
        };
        l.push(format!(
            "{ind}{}{}{}{}{}{sum}",
            pad(&x.score.to_string(), 6)?,
            pad(&commit, 9)?,
            pad(&version, 11)?,
            pad(r.component.as_deref().unwrap_or(h("defect.dash")), 34)?,
            pad(r.cause.as_deref().unwrap_or(h("defect.dash")), 23)?
        ));
    }
    Ok(l.join("\n") + "\n")
}
