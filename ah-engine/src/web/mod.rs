//! The engine side of the dashboard's data plane and actions (plan v3): `CTL pulse`, `CTL agents`, `CTL io`, and the audited action
//! verbs. The daemon has one delegating arm ([`dispatch`]); each module owns its verb.
pub mod actions;
pub mod io;
pub mod pulse;

/// Answer a dashboard `CTL` verb that needs no daemon state, `None` when `verb` is not one of them (`pulse` needs the daemon's
/// counters and is built in `daemon.rs`).
pub fn dispatch(verb: &str, args: &str) -> Option<String> {
    let want = |k: &str| args.split_whitespace().find_map(|a| a.strip_prefix(k).map(str::to_string));
    match verb {
        "io" => Some(io::snapshot(args).to_string()),
        "agents" => Some(crate::agents::web_document(want("since=").as_deref(), want("agent=").as_deref()).to_string()),
        _ => None,
    }
}
