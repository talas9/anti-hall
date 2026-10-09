//! Caller roles (owner feature 22): who may run which engine verb.
//!
//! The matrix, the role names, the markers and every text are plugin data (`engine/defaults/roles.toml`); this module only
//! reads them. The command line can see the process environment only, so it knows two roles: a DevSwarm workspace child
//! (`DEVSWARM_SOURCE_BRANCH` non-empty) and everything else (the main session). A subagent or a Codex session is told apart
//! from the hook payload, which the PreToolUse `engine-role-guard` check reads before the command runs. A wrapper may
//! declare a narrower role in `ANTIHALL_ROLE`; it can never widen what the environment allows.
use crate::defaults::{self, V};
use crate::reqenv::RequestEnv;

/// One verb's row of the matrix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    /// The feature area (a key of `roles.groups`).
    pub group: &'static str,
    /// The roles that may run it.
    pub roles: Vec<&'static str>,
    /// The roles limited to acting on themselves.
    pub self_only: Vec<&'static str>,
    /// Arguments that make a run owner-level.
    pub owner_args: Vec<&'static str>,
}

/// The row of `verb`, if the matrix has one.
pub fn row(verb: &str) -> Option<Row> {
    let r = defaults::raw("roles.matrix").get(verb)?;
    let list = |k: &str| r.get(k).map(V::strings).unwrap_or_default();
    Some(Row { group: r.str_field("group"), roles: list("roles"), self_only: list("self_only"), owner_args: list("owner_args") })
}

/// Every verb the matrix names, in file order.
pub fn verbs() -> Vec<&'static str> {
    defaults::raw("roles.matrix").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default()
}

/// The role names, most specific first.
pub fn names() -> Vec<&'static str> {
    defaults::list("roles.names")
}

/// The role of a command-line caller, from its environment.
pub fn role_from_env(env: &RequestEnv) -> &'static str {
    let names = names();
    let in_workspace = env.get(defaults::text("roles.branch_env")).is_some_and(|v| !v.is_empty());
    let floor = if in_workspace { "workspace" } else { "main" };
    // a declared role may only narrow: it counts when it is at least as specific as what the environment proves
    match env.get(defaults::text("roles.declared_env")).and_then(|d| names.iter().copied().find(|n| *n == d)) {
        Some(d) if names.iter().position(|n| *n == d) <= names.iter().position(|n| *n == floor) => d,
        _ => names.iter().copied().find(|n| *n == floor).unwrap_or(floor),
    }
}

/// Whether `role` may run `verb` with `args`, and the refusal text when not. A verb with no row is not this module's to
/// judge (an unknown verb fails elsewhere); the switch `context.roleGuard` is read by the caller.
pub fn check(role: &str, verb: &str, args: &[String], env: &RequestEnv) -> Result<(), String> {
    let Some(r) = row(verb) else { return Ok(()) };
    let owner = args.iter().any(|a| r.owner_args.iter().any(|o| o == a));
    let owner_roles = defaults::list("roles.owner_roles");
    let allowed_list = |owner_level: bool| {
        let pool: Vec<&str> = if owner_level { r.roles.iter().copied().filter(|x| owner_roles.contains(x)).collect() } else { r.roles.clone() };
        pool.join(", ")
    };
    if !r.roles.contains(&role) || (owner && !owner_roles.contains(&role)) {
        let why = if owner { defaults::text("roles.msg_why_owner") } else { defaults::text("roles.msg_why_other") };
        return Err(defaults::render("roles.msg_refuse", &[("verb", &verb), ("role", &role), ("allowed", &allowed_list(owner)), ("why", &why)]));
    }
    if r.self_only.contains(&role) {
        let me = env.get(defaults::text("roles.builder_env")).unwrap_or_default();
        let flags = defaults::list("roles.self_flags");
        for (i, a) in args.iter().enumerate() {
            if flags.contains(&a.as_str())
                && let Some(t) = args.get(i + 1)
                && t != me
            {
                return Err(defaults::render("roles.msg_refuse_self", &[("verb", &verb), ("target", t), ("self", &me)]));
            }
        }
    }
    Ok(())
}

/// The command-line gate: `Ok` to run, or the exit status and message to refuse with.
pub fn gate(verb: &str, args: &[String]) -> Result<(), (i32, String)> {
    let env = RequestEnv::capture();
    // the switch is the setting context.roleGuard; the command line reads it from the environment override only
    if let Some(sw) = defaults::get("roles.sw_guard")
        && let Some(name) = sw.value.get("env").and_then(V::as_str)
        && env.get(name) == Some("0")
    {
        return Ok(());
    }
    check(role_from_env(&env), verb, args, &env).map_err(|m| (defaults::num("roles.refuse_exit") as i32, m))
}
