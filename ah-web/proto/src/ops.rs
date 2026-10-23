//! The wire types of the Accounts, Updates and Logs screens. No texts and no thresholds live here: they come from `web_ops.toml`.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The GET route that answers the [`OpsCfg`].
pub const OPS_CFG_PATH: &str = "/api/ops/config";
/// The GET route that answers the [`Accounts`].
pub const OPS_ACCOUNTS_PATH: &str = "/api/ops/accounts";
/// The POST route that runs the read-only update check and answers an [`UpdateCheck`].
pub const OPS_UPDATE_PATH: &str = "/api/ops/update-check";
/// The GET route (`?src=<id>&since=<ts>`) that answers a [`LogTail`].
pub const OPS_LOGS_PATH: &str = "/api/ops/logs";

/// The numbers the three screens need (from `web.ops.*`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct OpsCfg {
    pub warn_pct: f64,
    pub bad_pct: f64,
    /// A usage reading older than this is shown as stale, ms.
    pub stale_ms: u64,
    pub poll_accounts_ms: u64,
    pub tick_ms: u64,
    pub logs_poll_ms: u64,
    pub logs_view_max: usize,
    /// Level names, lowest first.
    pub levels: Vec<String>,
    /// The log sources as (id, ui text key).
    pub sources: Vec<(String, String)>,
}

/// One usage bucket (5-hour, weekly, a per-model weekly).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Bucket {
    pub id: String,
    pub label: String,
    pub percent: f64,
    /// ISO time the bucket resets; empty when unknown.
    pub resets_at: String,
}

/// The logged-in Claude account, as far as the host file shows without a credential.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ClaudeAccount {
    pub signed_in: bool,
    /// The first characters of the user id.
    pub fingerprint: String,
    /// The account's e-mail address and display name, as the host file shows them (never a token).
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    /// Allow-listed plan fields.
    pub fields: Vec<AccountField>,
}

/// One plan field: the ui text key of its name, the text shown, and the raw value when the text is a mapped label (for a tooltip).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AccountField {
    pub label_key: String,
    pub text: String,
    #[serde(default)]
    pub raw: String,
}

/// Codex's login, from the existence of its login file only.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CodexAccount {
    pub signed_in: bool,
    /// When the login file last changed, ms since the epoch.
    pub changed_ms: u64,
}

/// One agent's cost row.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CostRow {
    pub agent: String,
    pub name: String,
    pub kind: String,
    pub tokens: u64,
    pub outcomes: u64,
    pub tokens_per_outcome: u64,
    /// The text drawn in front of the name to show the nesting (tree pipes); empty for a top-level row.
    #[serde(default)]
    pub prefix: String,
    /// A project's header row: `name` is the project, the numbers its total.
    #[serde(default)]
    pub header: bool,
}

/// Everything the Accounts screen shows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Accounts {
    pub claude: ClaudeAccount,
    pub codex: CodexAccount,
    pub buckets: Vec<Bucket>,
    /// When the usage cache was read, ms since the epoch; 0 when there is no reading.
    pub usage_read_ms: u64,
    /// The usage cache could not be read or parsed.
    pub usage_error: bool,
    pub cost_total_tokens: u64,
    pub cost_total_outcomes: u64,
    pub cost_rows: Vec<CostRow>,
    pub cost_ok: bool,
}

/// The answer of the read-only update check.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct UpdateCheck {
    pub ok: bool,
    pub installed: String,
    pub latest: String,
    /// The engine's own sentence ("update available (..) ..." / "up to date").
    pub message: String,
    /// True when `latest` is newer than `installed`, as the engine judged it.
    pub available: bool,
    /// The marketplace the checked install came from (`anti-hall`, `anti-hall-engine-live`, ...).
    #[serde(default)]
    pub channel: String,
    /// The engine's verdict: `available`, `current`, `unknown`, `lagging` or `failed`.
    #[serde(default)]
    pub state: String,
    pub checked_ms: u64,
    /// The last check was reused (the minimum gap had not passed).
    pub reused: bool,
}

/// One normalised log line.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct LogLine {
    pub ts_ms: u64,
    pub level: String,
    pub comp: String,
    pub text: String,
}

/// The new lines of one log.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct LogTail {
    pub ok: bool,
    pub lines: Vec<LogLine>,
    /// The engine cut older lines off (the file is longer than it shows).
    pub truncated: bool,
    pub error: String,
}

/// The texts merged into the page's labels, by key (kept here so both sides name the type).
pub type Texts = BTreeMap<String, String>;
