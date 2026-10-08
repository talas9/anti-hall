//! Shared shell-text helpers of the compiled checks that have not moved to scripts yet. The git guard itself (force pushes,
//! remote ref deletion, AI self-credit, handover commits, launcher-directory writes, aliases, runners, heredocs) and its
//! PostToolUse audit decide in plugin script logic (`engine/logic/git.js`, `engine/logic/git-audit.js`, D88); what stays here is
//! the generic part another check reads: the heredoc opener parser and arithmetic-context scan ([`tokenize`]) and the POSIX path
//! helpers and request environment snapshot ([`util`]).
pub mod tokenize;
pub mod util;
