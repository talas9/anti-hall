//! Rules format v1 (JSON). Evaluated in file order against a parsed hook payload.
//!
//! ```json
//! {"version":1,"rules":[{
//!   "id":"git-force-push",              // optional, for logs/tests
//!   "events":["PreToolUse"],            // optional; omitted or "*" = any event
//!   "tools":["Bash"],                   // optional; omitted or "*" = any tool (events without a tool never match a tools-scoped rule)
//!   "field":"command",                  // optional; dot path into tool_input (or "prompt"); default = the tool's natural subject
//!   "pattern":"git\\s+push\\b.*--force", // regex (regex crate syntax), unanchored
//!   "action":"deny",                    // deny | warn | context
//!   "message":"...",
//!   "paths":["/Users/me/proj"]          // optional; rule applies only when payload cwd is at/under one of these
//! }]}
//! ```
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct RawFile {
    version: u32,
    rules: Vec<RawRule>,
}

#[derive(Deserialize)]
struct RawRule {
    #[serde(default)]
    id: String,
    #[serde(default)]
    events: Vec<String>,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    field: Option<String>,
    pattern: String,
    action: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Deny,
    Warn,
    Context,
}

#[derive(Debug)]
pub struct Rule {
    pub id: String,
    events: Vec<String>,
    tools: Vec<String>,
    field: Option<String>,
    re: Regex,
    pub action: Action,
    pub message: String,
    paths: Vec<String>,
}

#[derive(Debug, Default)]
pub struct RuleSet {
    pub rules: Vec<Rule>,
}

/// What a rule is matched against; built from the hook payload by `hookio`.
pub struct Subject<'a> {
    pub event: &'a str,
    pub tool: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub tool_input: &'a Value,
    pub prompt: Option<&'a str>,
}

impl RuleSet {
    pub fn parse(json: &str) -> Result<RuleSet, String> {
        let f: RawFile = serde_json::from_str(json).map_err(|e| format!("rules json: {e}"))?;
        if f.version != 1 {
            return Err(format!("unsupported rules version {}", f.version));
        }
        let mut rules = Vec::new();
        for (i, r) in f.rules.into_iter().enumerate() {
            let action = match r.action.as_str() {
                "deny" => Action::Deny,
                "warn" => Action::Warn,
                "context" => Action::Context,
                a => return Err(format!("rule {i}: unknown action {a:?}")),
            };
            let re = Regex::new(&r.pattern).map_err(|e| format!("rule {i} ({}): {e}", r.id))?;
            rules.push(Rule { id: r.id, events: r.events, tools: r.tools, field: r.field, re, action, message: r.message, paths: r.paths });
        }
        Ok(RuleSet { rules })
    }

    pub fn load(path: &std::path::Path) -> Result<RuleSet, String> {
        let txt = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        RuleSet::parse(&txt)
    }

    /// All rules that match, in file order.
    pub fn matching<'a>(&'a self, s: &Subject) -> Vec<&'a Rule> {
        self.rules.iter().filter(|r| r.matches(s)).collect()
    }
}

fn listed(list: &[String], v: Option<&str>) -> bool {
    list.is_empty() || list.iter().any(|x| x == "*") || v.map_or(false, |v| list.iter().any(|x| x == v))
}

fn under(cwd: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    cwd == root || cwd.strip_prefix(root).map_or(false, |r| r.starts_with('/'))
}

fn lookup<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(v, |cur, k| cur.get(k))
}

fn as_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Natural subject of a tool call: shell command, edited path, pattern, url, else the whole input.
fn natural(ti: &Value) -> String {
    for k in ["command", "file_path", "path", "pattern", "url"] {
        if let Some(Value::String(s)) = ti.get(k) {
            return s.clone();
        }
    }
    if ti.is_null() { String::new() } else { ti.to_string() }
}

impl Rule {
    fn matches(&self, s: &Subject) -> bool {
        if !listed(&self.events, Some(s.event)) || !listed(&self.tools, s.tool) {
            return false;
        }
        if !self.paths.is_empty() && !s.cwd.map_or(false, |c| self.paths.iter().any(|p| under(c, p))) {
            return false;
        }
        let text = match self.field.as_deref() {
            Some("prompt") => s.prompt.unwrap_or("").to_string(),
            Some(f) => lookup(s.tool_input, f).map(as_text).unwrap_or_default(),
            None if s.event == "UserPromptSubmit" => s.prompt.unwrap_or("").to_string(),
            None => natural(s.tool_input),
        };
        self.re.is_match(&text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn subj<'a>(event: &'a str, tool: Option<&'a str>, cwd: Option<&'a str>, ti: &'a Value, prompt: Option<&'a str>) -> Subject<'a> {
        Subject { event, tool, cwd, tool_input: ti, prompt }
    }

    #[test]
    fn rejects_bad_files() {
        assert!(RuleSet::parse("not json").is_err());
        assert!(RuleSet::parse(r#"{"version":2,"rules":[]}"#).is_err());
        assert!(RuleSet::parse(r#"{"version":1,"rules":[{"pattern":"(","action":"deny"}]}"#).is_err());
        assert!(RuleSet::parse(r#"{"version":1,"rules":[{"pattern":"x","action":"nuke"}]}"#).is_err());
    }

    #[test]
    fn tool_and_event_scoping() {
        let rs = RuleSet::parse(r#"{"version":1,"rules":[{"events":["PreToolUse"],"tools":["Bash"],"pattern":"rm","action":"deny"}]}"#).unwrap();
        let ti = json!({"command":"rm x"});
        assert_eq!(rs.matching(&subj("PreToolUse", Some("Bash"), None, &ti, None)).len(), 1);
        assert_eq!(rs.matching(&subj("PreToolUse", Some("Edit"), None, &ti, None)).len(), 0);
        assert_eq!(rs.matching(&subj("PostToolUse", Some("Bash"), None, &ti, None)).len(), 0);
        assert_eq!(rs.matching(&subj("PreToolUse", None, None, &ti, None)).len(), 0);
    }

    #[test]
    fn project_path_scoping_is_component_aware() {
        let rs = RuleSet::parse(r#"{"version":1,"rules":[{"pattern":".","action":"warn","paths":["/p/proj"]}]}"#).unwrap();
        let ti = json!({"command":"x"});
        let m = |cwd| rs.matching(&subj("PreToolUse", Some("Bash"), cwd, &ti, None)).len();
        assert_eq!(m(Some("/p/proj")), 1);
        assert_eq!(m(Some("/p/proj/sub")), 1);
        assert_eq!(m(Some("/p/proj-other")), 0);
        assert_eq!(m(None), 0);
    }

    #[test]
    fn field_and_prompt_matching() {
        let rs = RuleSet::parse(
            r#"{"version":1,"rules":[
              {"tools":["Edit"],"field":"new_string","pattern":"TODO","action":"warn"},
              {"events":["UserPromptSubmit"],"pattern":"(?i)afk","action":"context"}]}"#,
        )
        .unwrap();
        let ti = json!({"file_path":"a","new_string":"// TODO x"});
        assert_eq!(rs.matching(&subj("PreToolUse", Some("Edit"), None, &ti, None)).len(), 1);
        let null = Value::Null;
        assert_eq!(rs.matching(&subj("UserPromptSubmit", None, None, &null, Some("I'm AFK now"))).len(), 1);
    }
}

#[cfg(test)]
mod shipped_rules {
    use super::*;
    use serde_json::json;

    fn hit(rs: &RuleSet, cmd: &str) -> Vec<String> {
        let ti = json!({ "command": cmd });
        let s = Subject { event: "PreToolUse", tool: Some("Bash"), cwd: None, tool_input: &ti, prompt: None };
        rs.matching(&s).iter().map(|r| r.id.clone()).collect()
    }

    #[test]
    fn example_rules_json_behaves() {
        let rs = RuleSet::parse(include_str!("../rules.json")).unwrap();
        assert_eq!(rs.rules.len(), 3);
        for c in ["git push --force origin main", "git push -f", "git push origin +main", "git push origin main --force-with-lease"] {
            assert_eq!(hit(&rs, c), ["git-no-force-push"], "{c}");
        }
        for c in ["git push origin main", "git push -u origin feat", "git status", "echo force"] {
            assert!(hit(&rs, c).is_empty(), "{c}");
        }
        assert_eq!(hit(&rs, "git commit -m \"x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\""), ["git-no-ai-self-credit"]);
        assert!(hit(&rs, "git commit -m \"fix: thing\"").is_empty());
        assert_eq!(hit(&rs, "rm -rf ~/"), ["rm-rf-root-or-home"]);
        assert_eq!(hit(&rs, "rm -rf /"), ["rm-rf-root-or-home"]);
        assert!(hit(&rs, "rm -rf ./build").is_empty());
        assert!(hit(&rs, "rm -rf /tmp/x").is_empty());
    }
}
