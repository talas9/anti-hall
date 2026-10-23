//! The wire types of the Telemetry and Impact screens. The server builds them from the engine's records and the settings in
//! `web_tel.toml`; the page only draws them. No sentence lives here: every text arrives in `texts`.
use crate::NumFmt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What the page needs to draw and to format (the `web_tel.toml` values it shares with the server).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TelUi {
    /// The vendored chart library, under the static directory.
    pub apex_file: String,
    pub apex_version: String,
    /// The chart colours and sizes (`web_tel.toml` `apex`), as the JSON text the chart binding reads.
    pub apex_json: String,
    pub spark_points: usize,
    /// Where a table is downloaded from.
    pub export_path: String,
    pub fmt_us: NumFmt,
    pub fmt_bytes: NumFmt,
    pub fmt_age: NumFmt,
    pub usd_decimals: usize,
    /// The page-wide number format (12k, 1.1M).
    pub number: NumFmt,
}

/// A metric card: today's figure, its recent days and how it compares with its own usual.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Kpi {
    pub id: String,
    pub label: String,
    /// The glossary tooltip.
    pub hint: String,
    /// `count`, `us`, `bytes`, `usd` or `tokens`.
    pub unit: String,
    /// Today so far.
    pub value: f64,
    /// Oldest first; the last point is today so far.
    pub series: Vec<f64>,
    /// The median of the days before today (`None` when there are too few).
    pub usual: Option<f64>,
    /// Today projected to a whole day against the usual, in percent (`None` when it cannot be judged).
    pub delta_pct: Option<f64>,
    /// `ok`, `warn`, `bad` or `neutral`: whether the move is the good or the bad direction for this metric.
    pub tone: String,
}

/// A headline sentence.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Headline {
    /// `ok`, `warn`, `bad`, `info`.
    pub tone: String,
    pub text: String,
}

/// A metric that is far from its own usual.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Anomaly {
    pub id: String,
    pub label: String,
    /// `high` or `low`.
    pub dir: String,
    pub value: f64,
    pub projected: f64,
    pub usual: f64,
    /// Robust standard deviations from the usual.
    pub score: f64,
    pub text: String,
}

/// One row of a top-movers list.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Mover {
    pub name: String,
    pub value: f64,
    pub usual: f64,
    pub change: f64,
    pub pct: Option<f64>,
    pub series: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct MoverList {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub rows: Vec<Mover>,
}

/// The weekly-limit burn projection.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Forecast {
    pub used_pct: f64,
    /// `None` when the engine does not know when the window resets.
    pub projected_pct: Option<f64>,
    pub hours_in: Option<f64>,
    pub tone: String,
    pub text: String,
}

/// The day-by-check heatmap (checks as rows, days as columns).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Heat {
    pub checks: Vec<String>,
    pub cells: Vec<Vec<f64>>,
}

/// A table cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Cell {
    Num(f64),
    Text(String),
}

impl Default for Cell {
    fn default() -> Cell {
        Cell::Text(String::new())
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Col {
    pub key: String,
    pub label: String,
    /// `text`, `count`, `us`, `bytes`, `usd`, `ts` (epoch ms), `pct`.
    pub kind: String,
}

/// A raw-rows table (sortable, filterable, exportable).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Table {
    pub id: String,
    pub title: String,
    pub cols: Vec<Col>,
    pub rows: Vec<Vec<Cell>>,
}

/// The Telemetry screen's document.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TelDoc {
    pub generated_ms: u64,
    pub engine_ok: bool,
    pub texts: BTreeMap<String, String>,
    pub ui: TelUi,
    pub headlines: Vec<Headline>,
    pub kpis: Vec<Kpi>,
    pub anomalies: Vec<Anomaly>,
    pub movers: Vec<MoverList>,
    pub forecast: Option<Forecast>,
    /// The start of each day of the series, epoch ms (UTC), oldest first.
    pub day_ms: Vec<u64>,
    pub heat: Heat,
    pub tables: Vec<Table>,
}

/// One period's figure and the one before it.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Pair {
    pub cur: f64,
    pub prev: f64,
    /// The change per day against the period before, percent; `None` when the period before is empty.
    pub delta_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Period {
    pub id: String,
    pub label: String,
}

/// One Impact row: a figure per period.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ImpactRow {
    pub id: String,
    pub label: String,
    pub hint: String,
    /// `good` is the direction that is better: `up`, `down` or `neutral`.
    pub good: String,
    /// In the order of `ImpactDoc::periods`.
    pub pairs: Vec<Pair>,
}

/// A saving or cost, labelled for how sure it is.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Saving {
    pub id: String,
    pub label: String,
    /// `measured` or `estimate`.
    pub kind: String,
    pub usd: Option<f64>,
    /// How it is worked out.
    pub formula: String,
    pub range: String,
    pub basis: String,
}

/// One step of the spent / prevented / net waterfall.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Step {
    pub label: String,
    /// `spent`, `prevented` or `net`.
    pub kind: String,
    pub usd: f64,
}

/// A gap in what the engine or the dashboard covers.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Gap {
    pub id: String,
    pub label: String,
    pub text: String,
    pub tone: String,
}

/// The Impact screen's document.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ImpactDoc {
    pub generated_ms: u64,
    pub engine_ok: bool,
    pub texts: BTreeMap<String, String>,
    pub ui: TelUi,
    pub periods: Vec<Period>,
    pub prevention: Vec<ImpactRow>,
    pub failures: Vec<ImpactRow>,
    pub savings: Vec<Saving>,
    pub waterfall: Vec<Step>,
    pub waterfall_kind: String,
    pub gaps: Vec<Gap>,
}
