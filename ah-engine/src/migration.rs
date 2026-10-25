//! `ah-engine status --migration [--json]` (#43): where every engine path stands in the Node-to-engine migration, generated from
//! the engine's own registries, never kept by hand.
//!
//! Each entry gets one status word (`opcli.migration_status_*`):
//!
//! | kind | source | node | partial | native |
//! |---|---|---|---|---|
//! | hook | [`crate::checks::registry`] | the check is not classified in `script.engine_only_checks` (a test fails on one) | its script has a real `return 'defer'` (`opcli.migration_defer_re`) | otherwise |
//! | duty | `devswarm_sup.duties` | the duty runs as Node's function | it runs natively but its kind is still `node` (a Node witness or remainder) | kind `native` |
//! | stage | `update_post.stages` | the stage names a Node function (`fn`) | | the stage names a native port (`native`) |
//! | verb | `cmd.*` | the command is planned (its Node script answers) | implemented, but a key of `opcli.migration_verb_node_keys` still ships | implemented |
//! | switch | `opcli.migration_switches` | | the switch is not 0 (Node may still answer) | the switch is 0 |
//!
//! An entry its source cannot classify has status `null` and counts as `missing`; the test `every_entry_has_a_status` fails on
//! one, so a new registry row cannot land without a status.
use crate::defaults::{self, V};
use serde_json::{Value, json};

/// One entry of the report: its kind, its name, its status word (`None`: not classifiable) and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// `hook`, `duty`, `stage`, `verb` or `switch` (`opcli.migration_kind_*`).
    pub kind: &'static str,
    /// The check, duty, stage, command or switch name.
    pub name: String,
    /// The status word, `None` when the source does not say.
    pub status: Option<&'static str>,
    /// What decided the status (the Node paths that remain, by reason word and key).
    pub why: Vec<String>,
}

fn word(key: &str) -> &'static str {
    defaults::text(key)
}

fn native() -> &'static str {
    word("opcli.migration_status_native")
}

fn partial() -> &'static str {
    word("opcli.migration_status_partial")
}

fn node() -> &'static str {
    word("opcli.migration_status_node")
}

/// The shipped script text of check `name` and its includes (comments removed), empty when it has none.
fn script_text(name: &str) -> String {
    let Some(root) = defaults::root() else { return String::new() };
    let dir = root.join(defaults::text("script.logic_dir"));
    let ext = defaults::text("script.ext");
    let mut names: Vec<String> = defaults::raw("script.includes").get(name).map(|v| v.strings().into_iter().map(str::to_string).collect()).unwrap_or_default();
    names.push(name.to_string());
    names.iter().filter_map(|n| std::fs::read_to_string(dir.join(format!("{n}{ext}"))).ok()).map(|t| strip_comments(&t)).collect::<Vec<_>>().join("\n")
}

/// JavaScript source without its `//` and `/* */` comments (a string that holds `//` is cut too; the defer pattern needs no such string).
fn strip_comments(src: &str) -> String {
    let block = crate::checks::lit_re(r"(?s)/\*.*?\*/");
    block.replace_all(src, "").lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

/// Whether script text holds a real deferral (`opcli.migration_defer_re`).
fn has_defer(text: &str) -> bool {
    regex::Regex::new(defaults::text("opcli.migration_defer_re")).is_ok_and(|re| re.is_match(text))
}

fn hooks() -> Vec<Entry> {
    let engine_only = defaults::list("script.engine_only_checks");
    crate::checks::registry()
        .iter()
        .map(|c| {
            let name = c.name();
            let mut why = Vec::new();
            let twin = !engine_only.contains(&name);
            if twin {
                why.push(word("opcli.migration_why_twin").to_string());
            }
            let defer = has_defer(&script_text(name));
            if defer {
                why.push(word("opcli.migration_why_defer").to_string());
            }
            let status = if twin {
                node()
            } else if defer {
                partial()
            } else {
                native()
            };
            Entry { kind: word("opcli.migration_kind_hook"), name: name.to_string(), status: Some(status), why }
        })
        .collect()
}

/// The status of one supervisor duty from its row (`None`: no row or an unknown kind).
fn duty_status(_name: &str, d: Option<&V>) -> (Option<&'static str>, Vec<String>) {
    let Some(d) = d else { return (None, vec![]) };
    let kind = d.str_field("kind");
    let has_native = d.get("native").and_then(V::as_bool) == Some(true);
    let rolled_back = false; // the Node rollback of a duty is gone (devswarm_sup.duties_off switches a duty off instead)
    if kind == native() {
        return (Some(native()), vec![]);
    }
    if kind != node() {
        return (None, vec![]);
    }
    let why = vec![word("opcli.migration_why_node_kind").to_string()];
    if has_native && !rolled_back { (Some(partial()), why) } else { (Some(node()), why) }
}

fn duties() -> Vec<Entry> {
    defaults::list("devswarm_sup.duties")
        .into_iter()
        .map(|n| {
            let row = defaults::get(&format!("{}{n}", defaults::text("opcli.migration_duty_prefix"))).map(|e| &e.value);
            let (status, why) = duty_status(n, row);
            Entry { kind: word("opcli.migration_kind_duty"), name: n.to_string(), status, why }
        })
        .collect()
}

/// The status of one post-update stage row.
fn stage_status(row: &V) -> (Option<&'static str>, Vec<String>) {
    if !row.str_field("fn").is_empty() {
        return (Some(node()), vec![format!("{}:{}", word("opcli.migration_why_fn"), row.str_field("fn"))]);
    }
    // `recon` marks a reconcile-family stage run by the engine's own port (`dssup::recon`): native, like a `native` row
    if !row.str_field("native").is_empty() || !row.str_field("recon").is_empty() {
        let fallback = row.str_field("fallback");
        if !fallback.is_empty() {
            return (Some(partial()), vec![format!("{}:{fallback}", word("opcli.migration_why_fallback"))]);
        }
        return (Some(native()), vec![]);
    }
    (None, vec![])
}

fn stages() -> Vec<Entry> {
    defaults::raw("update_post.stages")
        .as_array()
        .unwrap_or(&[])
        .iter()
        .map(|row| {
            let (status, why) = stage_status(row);
            Entry { kind: word("opcli.migration_kind_stage"), name: row.str_field("name").to_string(), status, why }
        })
        .collect()
}

/// The status of a command from its registry status word and the Node keys that still ship for it.
fn verb_status(name: &str, status: &str) -> (Option<&'static str>, Vec<String>) {
    if status.starts_with(word("opcli.migration_cmd_planned")) {
        return (Some(node()), vec![status.to_string()]);
    }
    if status != word("opcli.migration_cmd_implemented") {
        return (None, vec![]);
    }
    let keys = defaults::raw("opcli.migration_verb_node_keys").get(name).map(V::strings).unwrap_or_default();
    let left: Vec<String> = keys.into_iter().filter(|k| defaults::get(k).is_some()).map(|k| format!("{}:{k}", word("opcli.migration_why_key"))).collect();
    if left.is_empty() { (Some(native()), left) } else { (Some(partial()), left) }
}

fn verbs() -> Vec<Entry> {
    crate::cli::commands()
        .into_iter()
        .map(|c| {
            let (status, why) = verb_status(&c.name, &c.status);
            Entry { kind: word("opcli.migration_kind_verb"), name: c.name, status, why }
        })
        .collect()
}

fn switches() -> Vec<Entry> {
    defaults::raw("opcli.migration_switches")
        .as_table()
        .unwrap_or(&[])
        .iter()
        .map(|(name, key)| {
            let key = key.as_str().unwrap_or("");
            let (status, why) = match defaults::get(key).map(|e| &e.value) {
                None => (None, vec![]),
                Some(_) if defaults::num(key) == 0 => (Some(native()), vec![]),
                Some(_) => (Some(partial()), vec![format!("{}:{key}", word("opcli.migration_why_switch"))]),
            };
            Entry { kind: word("opcli.migration_kind_switch"), name: name.to_string(), status, why }
        })
        .collect()
}

/// Every entry of the report, in a fixed order (hooks, duties, stages, verbs, switches).
pub fn entries() -> Vec<Entry> {
    let mut out = hooks();
    out.extend(duties());
    out.extend(stages());
    out.extend(verbs());
    out.extend(switches());
    out
}

/// The report as JSON: the counts per status (`missing` for `null`), `compiled_logic_checks_remaining`, and every entry.
pub fn report() -> Value {
    let all = entries();
    let count = |s: Option<&str>| all.iter().filter(|e| e.status == s).count();
    let mut summary = serde_json::Map::new();
    for s in [native(), partial(), node()] {
        summary.insert(s.to_string(), json!(count(Some(s))));
    }
    summary.insert(word("opcli.migration_missing").to_string(), json!(count(None)));
    json!({
        "summary": summary,
        "compiled_logic_checks_remaining": crate::checks::compiled_logic_checks_remaining(),
        "entries": all.iter().map(|e| json!({"kind": e.kind, "name": e.name, "status": e.status, "why": e.why})).collect::<Vec<_>>(),
    })
}

/// The human form: one heading line with the counts, then one line per entry.
pub fn human(v: &Value) -> String {
    let n = |k: &str| v["summary"][k].as_u64().unwrap_or(0);
    let mut out = defaults::render(
        "opcli.migration_heading",
        &[("native", &n(native())), ("partial", &n(partial())), ("node", &n(node())), ("missing", &n(word("opcli.migration_missing")))],
    );
    out.push('\n');
    for e in v["entries"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let why: Vec<&str> = e["why"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let args: [(&str, &dyn std::fmt::Display); 4] = [
            ("kind", &e["kind"].as_str().unwrap_or("")),
            ("name", &e["name"].as_str().unwrap_or("")),
            ("status", &e["status"].as_str().unwrap_or(word("opcli.migration_missing"))),
            ("why", &why.join(", ")),
        ];
        out.push_str(&defaults::render("opcli.migration_line", &args));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_has_a_status() {
        let missing: Vec<String> = entries().into_iter().filter(|e| e.status.is_none()).map(|e| format!("{} {}", e.kind, e.name)).collect();
        assert!(missing.is_empty(), "registry entries with no migration status: {missing:?}");
    }

    #[test]
    fn report_counts_match_entries_and_carry_the_compiled_logic_gate() {
        let v = report();
        let total: u64 = v["summary"].as_object().unwrap().values().filter_map(Value::as_u64).sum();
        assert_eq!(total as usize, v["entries"].as_array().unwrap().len());
        assert_eq!(v["compiled_logic_checks_remaining"], json!(crate::checks::compiled_logic_checks_remaining()));
        assert_eq!(v["summary"][word("opcli.migration_missing")], json!(0));
        assert!(entries().iter().any(|e| e.kind == word("opcli.migration_kind_hook")), "the check registry is in the report");
    }

    #[test]
    fn an_unknown_source_row_has_no_status() {
        assert_eq!(duty_status("x", None).0, None);
        assert_eq!(verb_status("x", "someday").0, None);
        assert_eq!(stage_status(&V::Table(&[])).0, None);
    }

    #[test]
    fn classification_rules() {
        assert_eq!(verb_status("x", "planned (D1)").0, Some(node()));
        assert_eq!(verb_status("version", word("opcli.migration_cmd_implemented")).0, Some(native()));
        static FN_ROW: [(&str, V); 1] = [("fn", V::Str("nodeFn"))];
        static NATIVE_ROW: [(&str, V); 1] = [("native", V::Str("x"))];
        static RECON_ROW: [(&str, V); 1] = [("recon", V::Str("fold"))];
        assert_eq!(stage_status(&V::Table(&FN_ROW)).0, Some(node()));
        assert_eq!(stage_status(&V::Table(&NATIVE_ROW)).0, Some(native()));
        assert_eq!(stage_status(&V::Table(&RECON_ROW)).0, Some(native()));
        assert!(has_defer(&strip_comments("function decide(){ if (x) return 'defer'; }")));
        assert!(!has_defer(&strip_comments("// return 'defer'\n/* return \"defer\" */ return 'allow';")));
    }
}
