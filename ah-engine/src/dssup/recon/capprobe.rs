//! The capability probe and its cache (`companion/lib/devswarm-capabilities.js` `probe` / `recordDormant`): the build of `hivecontrol`
//! is asked for its version and its `workspace` commands (read-only: `--version` and `--help` only) once per binary, and the answer
//! is written to `devswarm/capabilities.json`, keyed by the binary's path, mtime and size, so a DevSwarm upgrade (a new binary)
//! probes again. The gate in front of every `workspace list` ([`crate::meshw::hivecontrol::cap_verb`]) and the doctor read that file.
//! A build that lacks `workspace list` gets its dormant line recorded in the file, which is what makes the gate refuse the call.
// Discard triage (E3): every `.ok()` in this file is a deliberate keep, for these reasons:
// - an unreadable or unparsable cache or session record is the absent one (Node: `try { JSON.parse(...) } catch (_) { return null }`)
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner};
use crate::dssup::tick::Ctx;
use crate::meshw::hivecontrol::{cache_keys, resolve_bin};
use crate::meshw::ident::Env;
use std::path::Path;

fn s(v: &str) -> OVal {
    OVal::Str(v.to_string())
}

fn re(key: &str) -> regex::Regex {
    crate::checks::guardkit::jsre::compile(defaults::text(key), false)
}

/// `parseVersion(text)`: the first `x.y.z` in it.
fn parse_version(text: &str) -> Option<String> {
    let c = regex::Regex::new(defaults::text("devswarm_cli.hc_version_re")).ok()?.captures(text)?;
    Some(format!("{}.{}.{}", &c[1], &c[2], &c[3]))
}

/// `parseCommands(helpText)`: the verbs of the `Commands:` block with their usage and description, in the order they are listed.
fn parse_commands(help: &str) -> Vec<(String, String, String)> {
    let (header, section, row) = (re("devswarm_recon.cp_re_cmds_header"), re("devswarm_recon.cp_re_section"), re("devswarm_recon.cp_re_cmd_row"));
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut in_cmds = false;
    for line in help.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        if header.is_match(line) {
            in_cmds = true;
            continue;
        }
        if !in_cmds {
            continue;
        }
        if section.is_match(line) {
            break;
        }
        let Some(c) = row.captures(line) else { continue };
        let entry = (c[1].to_string(), js_trim(c.get(2).map_or("", |m| m.as_str())).to_string(), js_trim(c.get(3).map_or("", |m| m.as_str())).to_string());
        match out.iter_mut().find(|e| e.0 == entry.0) {
            Some(slot) => *slot = entry,
            None => out.push(entry),
        }
    }
    out
}

/// `parseVerbHelp(helpText)`: the usage line, the positional arguments and the flags of one verb's help page.
fn parse_verb_help(help: &str) -> (String, Vec<(String, bool)>, Vec<String>) {
    let usage = crate::checks::guardkit::jsre::compile_multiline(defaults::text("devswarm_recon.cp_re_usage"), false)
        .captures(help)
        .map_or(String::new(), |c| js_trim(c.get(1).map_or("", |m| m.as_str())).to_string());
    let bare = usage.replace(defaults::text("devswarm_recon.cp_options_word"), "");
    let open = defaults::text("devswarm_recon.cp_required_open");
    let args: Vec<(String, bool)> = re("devswarm_recon.cp_re_arg").captures_iter(&bare).map(|c| (c[2].to_string(), &c[1] == open)).collect();
    let (header, section, columns, flag) =
        (re("devswarm_recon.cp_re_options_header"), re("devswarm_recon.cp_re_section"), re("devswarm_recon.cp_re_columns"), re("devswarm_recon.cp_re_flag"));
    let mut flags = Vec::new();
    let mut in_opts = false;
    for line in help.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        if header.is_match(line) {
            in_opts = true;
            continue;
        }
        if !in_opts {
            continue;
        }
        if section.is_match(line) {
            break;
        }
        let head = columns.split(line).find(|p| !p.is_empty()).unwrap_or_default();
        flags.extend(flag.captures_iter(head).map(|c| c[1].to_string()));
    }
    (usage, args, flags)
}

/// The version the DevSwarm app recorded for itself, when the binary prints none.
fn app_version(home: &Path) -> Option<String> {
    let mut p = home.to_path_buf();
    p.extend(defaults::list("devswarm_recon.cp_sentry_rel"));
    let j = OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))?;
    match j.get(defaults::text("devswarm_recon.cp_sentry_field")) {
        Some(OVal::Str(r)) => parse_version(r),
        _ => None,
    }
}

/// One probe command: its output (stdout and stderr) when it exited 0, else nothing (`defaultSpawn`).
fn ask(runner: &dyn Runner, bin: &Path, args: Vec<String>) -> Option<String> {
    let spec = RunSpec { bin: Some(bin.to_string_lossy().into_owned()), args, timeout_ms: defaults::num("devswarm_recon.cp_timeout_ms"), ..RunSpec::default() };
    let r = runner.run(&spec);
    (r.ok && r.status == Some(0) && r.error.is_none() && !r.timed_out).then(|| format!("{}{}", r.stdout, r.stderr))
}

/// The probe of one build (`probe`, uncached): `{present, bin, version, versionSource, verbs, helpParsed}`.
fn probe(runner: &dyn Runner, home: &Path, bin: &Path) -> OVal {
    let strs = |k: &str| defaults::list(k).iter().map(|a| (*a).to_string()).collect::<Vec<_>>();
    let mut version = ask(runner, bin, strs("devswarm_recon.cp_version_args")).and_then(|o| parse_version(&o));
    let mut source = version.as_ref().map(|_| defaults::text("devswarm_recon.cp_src_binary"));
    if version.is_none() {
        version = app_version(home);
        source = version.as_ref().map(|_| defaults::text("devswarm_recon.cp_src_app"));
    }
    let cmds = parse_commands(&ask(runner, bin, strs("devswarm_recon.cp_help_args")).unwrap_or_default());
    let mut verbs: Vec<(String, OVal)> =
        cmds.iter().map(|(name, usage, desc)| (name.clone(), OVal::Obj(vec![("usage".into(), s(usage)), ("desc".into(), s(desc))]))).collect();
    for name in defaults::list("devswarm_recon.cp_verb_help_verbs") {
        let Some(slot) = verbs.iter_mut().find(|(k, _)| k == name) else { continue };
        let args: Vec<String> = strs("devswarm_recon.cp_verb_help_args").iter().map(|a| a.replace("{verb}", name)).collect();
        let Some(out) = ask(runner, bin, args).filter(|o| !o.is_empty()) else { continue };
        let (usage, args, flags) = parse_verb_help(&out);
        if let OVal::Obj(fields) = &mut slot.1 {
            fields[0].1 = s(&usage);
            fields.push((
                "args".into(),
                OVal::Arr(args.into_iter().map(|(n, r)| OVal::Obj(vec![("name".into(), s(&n)), ("required".into(), OVal::Bool(r))])).collect()),
            ));
            fields.push(("flags".into(), OVal::Arr(flags.iter().map(|f| s(f)).collect())));
        }
    }
    OVal::Obj(vec![
        ("present".into(), OVal::Bool(true)),
        ("bin".into(), s(&bin.to_string_lossy())),
        ("version".into(), version.as_deref().map_or(OVal::Null, s)),
        ("versionSource".into(), source.map_or(OVal::Null, s)),
        ("verbs".into(), OVal::Obj(verbs)),
        ("helpParsed".into(), OVal::Bool(!cmds.is_empty())),
    ])
}

/// Fill the capability cache for the binary `env` resolves when it has no current entry (a missing file, another build's key, or a
/// probe that found no binary), and record the dormant line of `workspace list` when the build lacks it. Returns whether the file was
/// written. Never fails: a probe that cannot run leaves the cache as it was and the call goes through, as Node's does.
pub fn fill(ctx: &Ctx, env: &Env, runner: &dyn Runner) -> bool {
    let Ok(Some(bin)) = resolve_bin(env, ctx.home) else { return false };
    let Some(key) = cache_keys(&bin).into_iter().next() else { return false };
    let path = ctx
        .home
        .join(defaults::text("mesh_write.dir_anti_hall"))
        .join(defaults::text("mesh_write.dir_devswarm"))
        .join(defaults::text("mesh_write.hivecontrol_cache_file"));
    let prev = std::fs::read(&path).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))).filter(|v| matches!(v, OVal::Obj(_)));
    let same_build = prev.as_ref().and_then(|p| p.get("key")).is_some_and(|k| matches!(k, OVal::Str(x) if cache_keys(&bin).contains(x)));
    let fresh = prev.as_ref().and_then(|p| p.get("probe")).filter(|p| same_build && p.get("present").is_some_and(OVal::truthy)).cloned();
    let probe = fresh.clone().unwrap_or_else(|| probe(runner, ctx.home, &bin));
    let mut dormant = match prev.as_ref().and_then(|p| p.get("dormantLog")) {
        Some(OVal::Obj(o)) if same_build => o.clone(),
        _ => Vec::new(),
    };
    let help_parsed = probe.get("helpParsed").is_some_and(OVal::truthy);
    // a probe whose help could not be read says nothing about the verbs: it is cached (not asked again for this build) but records no dormant line
    let lacks_list = help_parsed && !probe.get("verbs").and_then(|v| v.get(defaults::text("mesh_write.hivecontrol_list_verb"))).is_some_and(OVal::truthy);
    let (cap, line) = (defaults::text("mesh_write.hivecontrol_list_cap"), defaults::text("mesh_write.hivecontrol_dormant_line"));
    let mut changed = fresh.is_none();
    if lacks_list && !dormant.iter().any(|(k, v)| k == cap && matches!(v, OVal::Str(l) if l == line)) {
        match dormant.iter_mut().find(|(k, _)| k == cap) {
            Some(slot) => slot.1 = s(line),
            None => dormant.push((cap.to_string(), s(line))),
        }
        changed = true;
    }
    if !changed {
        return false;
    }
    let checked = crate::jev::assist::iso_ms(ctx.now.max(0) as u64);
    let doc = OVal::Obj(vec![("key".into(), s(&key)), ("checkedAt".into(), s(&checked)), ("probe".into(), probe), ("dormantLog".into(), OVal::Obj(dormant))]);
    if let Some(dir) = path.parent() {
        crate::discard::logged("dssup_capprobe_dir", std::fs::create_dir_all(dir));
    }
    crate::atomic::write(&path, doc.stringify_pretty()).is_ok()
}

/// The gate in front of a `workspace <verb>` call that is about to run (`can('workspace.<verb>')`): fill the cache for the binary `env`
/// resolves when it holds no current entry (`probe`), and record the verb's dormant line when the build's help lists commands but not
/// this one (`recordDormant`), so [`crate::meshw::hivecontrol::cap_verb`] then answers from the cache. A build whose help could not
/// be read records nothing (the call goes through). Never fails.
pub fn ensure(home: &Path, now: i64, env: &Env, runner: &dyn Runner, verb: &str) {
    let Ok(Some(bin)) = resolve_bin(env, home) else { return };
    let Some(key) = cache_keys(&bin).into_iter().next() else { return };
    let path = home
        .join(defaults::text("mesh_write.dir_anti_hall"))
        .join(defaults::text("mesh_write.dir_devswarm"))
        .join(defaults::text("mesh_write.hivecontrol_cache_file"));
    let prev = std::fs::read(&path).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))).filter(|v| matches!(v, OVal::Obj(_)));
    let same_build = prev.as_ref().and_then(|p| p.get("key")).is_some_and(|k| matches!(k, OVal::Str(x) if cache_keys(&bin).contains(x)));
    let fresh = prev.as_ref().and_then(|p| p.get("probe")).filter(|p| same_build && p.get("present").is_some_and(OVal::truthy)).cloned();
    let probe = fresh.clone().unwrap_or_else(|| probe(runner, home, &bin));
    let mut dormant = match prev.as_ref().and_then(|p| p.get("dormantLog")) {
        Some(OVal::Obj(o)) if same_build => o.clone(),
        _ => Vec::new(),
    };
    let mut changed = fresh.is_none();
    let help_parsed = probe.get("helpParsed").is_some_and(OVal::truthy);
    if help_parsed && !probe.get("verbs").and_then(|v| v.get(verb)).is_some_and(OVal::truthy) {
        let version = match probe.get("version") {
            Some(OVal::Str(v)) if !v.is_empty() => Some(v.as_str()),
            _ => None,
        };
        let (_, line) = crate::meshw::hivecontrol::dormant_line(verb, None, None, version, false);
        let name = format!("{}{verb}", defaults::text("devswarm_cli.hc_cap_prefix"));
        if !dormant.iter().any(|(k, v)| *k == name && matches!(v, OVal::Str(l) if *l == line)) {
            match dormant.iter_mut().find(|(k, _)| *k == name) {
                Some(slot) => slot.1 = s(&line),
                None => dormant.push((name, s(&line))),
            }
            changed = true;
        }
    }
    if !changed {
        return;
    }
    // a fresh probe writes a new entry; recording a dormant line rewrites the cached entry as it was read (`recordDormant`)
    let doc = match (fresh.is_some(), prev) {
        (true, Some(OVal::Obj(mut fields))) => {
            match fields.iter_mut().find(|(k, _)| k == "dormantLog") {
                Some(slot) => slot.1 = OVal::Obj(dormant),
                None => fields.push(("dormantLog".into(), OVal::Obj(dormant))),
            }
            OVal::Obj(fields)
        }
        _ => {
            let checked = crate::jev::assist::iso_ms(now.max(0) as u64);
            OVal::Obj(vec![("key".into(), s(&key)), ("checkedAt".into(), s(&checked)), ("probe".into(), probe), ("dormantLog".into(), OVal::Obj(dormant))])
        }
    };
    if let Some(dir) = path.parent() {
        crate::discard::logged("dssup_capprobe_dir", std::fs::create_dir_all(dir));
    }
    crate::discard::logged("dssup_capprobe_write", crate::atomic::write(&path, doc.stringify_pretty()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::git::util::Settings;
    use crate::dsact::runner::RunResult;
    use crate::meshw::hivecontrol::{Cap, cap_verb};
    use std::cell::Cell;

    const HELP: &str = "Usage: hivecontrol workspace [options] [command]\n\nWorkspace operations\n\nOptions:\n  -h, --help  display help\n\nCommands:\n  list [options]  List every workspace in the current repository.\n  archive [options] [idOrBranch]  Archive a Workspace.\n  delete [options] [idOrBranch]  Permanently delete an archived Workspace.\n  help [command]  display help for command\n";
    const ARCHIVE: &str = "Usage: hivecontrol workspace archive [options] [idOrBranch]\n\nArchive a Workspace.\n\nOptions:\n  --reparent-children  move children\n  -h, --help  display help\n";

    /// A runner that answers the probe's commands from canned output and counts the calls.
    struct Canned {
        help: Option<&'static str>,
        calls: Cell<usize>,
    }
    impl Runner for Canned {
        fn run(&self, spec: &RunSpec) -> RunResult {
            self.calls.set(self.calls.get() + 1);
            let out = match spec.args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
                ["--version"] => Some("hivecontrol 2.5.7\n"),
                ["workspace", "--help"] => self.help,
                ["workspace", "archive", "--help"] => Some(ARCHIVE),
                _ => None,
            };
            match out {
                Some(o) => RunResult { ok: true, status: Some(0), stdout: o.to_string(), ..RunResult::default() },
                None => RunResult { ok: false, status: Some(1), ..RunResult::default() },
            }
        }
    }

    struct Fix {
        _dir: crate::db::TempDir,
        home: std::path::PathBuf,
        st: Settings,
        env: Env,
    }

    fn fix(tag: &str) -> Fix {
        crate::defaults::init().unwrap();
        let dir = crate::db::TempDir::new(tag);
        let home = dir.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let bin = dir.0.join("hivecontrol");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let mut env = Env::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert(defaults::text("mesh_write.env_hivecontrol").into(), bin.to_string_lossy().into_owned());
        let st = Settings { home: home.to_string_lossy().into_owned(), env: env.clone() };
        Fix { _dir: dir, home, st, env }
    }

    impl Fix {
        fn ctx(&self) -> Ctx<'_> {
            Ctx { home: &self.home, root: &self.home, st: &self.st, now: 1_760_000_000_000, engine_pokes: true }
        }
        fn cache(&self) -> Option<Value> {
            let p = self.home.join(".anti-hall/devswarm/capabilities.json");
            std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok())
        }
    }
    use serde_json::Value;

    #[test]
    fn dssup_recon_capprobe_writes_the_cache_the_gate_reads() {
        let f = fix("capprobe-ok");
        let runner = Canned { help: Some(HELP), calls: Cell::new(0) };
        assert_eq!(cap_verb(&f.env, &f.home, "list", None, None), Cap::Probe, "no cache yet");
        assert!(fill(&f.ctx(), &f.env, &runner));
        let c = f.cache().expect("the cache is written");
        assert_eq!(c["probe"]["version"], "2.5.7");
        assert_eq!(c["probe"]["versionSource"], "hivecontrol");
        assert_eq!(c["probe"]["helpParsed"], true);
        assert_eq!(c["probe"]["verbs"]["list"]["usage"], "[options]");
        assert_eq!(c["probe"]["verbs"]["archive"]["usage"], "hivecontrol workspace archive [options] [idOrBranch]");
        assert_eq!(c["probe"]["verbs"]["archive"]["args"][0], serde_json::json!({"name": "idOrBranch", "required": false}));
        assert_eq!(c["probe"]["verbs"]["archive"]["flags"], serde_json::json!(["--reparent-children", "-h", "--help"]));
        assert_eq!(c["checkedAt"], "2025-10-09T08:53:20.000Z");
        assert_eq!(c["dormantLog"], serde_json::json!({}));
        // the engine's own gate takes it as the cache of this build, and a build with the verb is let through
        assert_eq!(cap_verb(&f.env, &f.home, "list", None, None), Cap::Ok);
        // a current entry is not probed again
        let calls = runner.calls.get();
        assert!(!fill(&f.ctx(), &f.env, &runner));
        assert_eq!(runner.calls.get(), calls);
    }

    #[test]
    fn dssup_recon_capprobe_records_the_dormant_line_of_a_build_without_list() {
        let f = fix("capprobe-dormant");
        let runner = Canned { help: Some("Commands:\n  info [options]  Get details\n"), calls: Cell::new(0) };
        assert!(fill(&f.ctx(), &f.env, &runner));
        let c = f.cache().unwrap();
        assert_eq!(c["dormantLog"]["workspace.list"], defaults::text("mesh_write.hivecontrol_dormant_line"));
        assert!(matches!(cap_verb(&f.env, &f.home, "list", None, None), Cap::Dormant(_)), "the gate refuses the call now");
        assert!(!fill(&f.ctx(), &f.env, &runner), "nothing new to write");
    }

    #[test]
    fn dssup_recon_capprobe_a_help_that_cannot_be_read_is_cached_but_never_refuses() {
        let f = fix("capprobe-nohelp");
        let runner = Canned { help: None, calls: Cell::new(0) };
        assert!(fill(&f.ctx(), &f.env, &runner));
        let c = f.cache().unwrap();
        assert_eq!((c["probe"]["helpParsed"].as_bool(), c["probe"]["verbs"].as_object().map(serde_json::Map::len)), (Some(false), Some(0)));
        assert_eq!(c["dormantLog"], serde_json::json!({}));
        assert_eq!(cap_verb(&f.env, &f.home, "list", None, None), Cap::Probe, "the call goes through");
        let calls = runner.calls.get();
        assert!(!fill(&f.ctx(), &f.env, &runner));
        assert_eq!(runner.calls.get(), calls, "not probed again for this build");
    }
}
