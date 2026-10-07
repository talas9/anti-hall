//! Routing telemetry and the NET savings estimate (D77, D52).
//!
//! A `route` event records a spawn decision: the model asked for (or inherited), the task class, the tier the routing
//! table recommends, and what the check did. A `spawn` event records what actually ran: the model and the tokens it
//! used. They are joined by `spawn_key` ([`chains`]). From the joined pairs, [`net`] computes, in both directions:
//!
//! * **saved**: the tokens the agent used times (price of the model asked for minus price of the model that ran), when
//!   the model that ran was cheaper;
//! * **spent up**: the same difference when it was dearer (steering a spawn to a stronger model costs money);
//!
//! and subtracts the spenders: the tokens injected into model context by hooks, and what Jev calls cost. The result is the
//! NET, not only the savings. Every figure is an ESTIMATE under one stated assumption (the model asked for would have used
//! the same tokens), priced from the config price table, which carries its own date and source. A model the table does not
//! know is counted as unpriced rather than guessed.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::event::{Event, Extras, Route, Spawn, Usage};
use crate::defaults;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

/// Prices of one model in micro-dollars per million tokens, per token class.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Price {
    /// Input tokens.
    pub input: u64,
    /// Output tokens.
    pub output: u64,
    /// Cache-read tokens.
    pub cache_read: u64,
    /// Cache-write tokens.
    pub cache_write: u64,
}

impl Price {
    /// What `u` costs at this price, in micro-dollars multiplied by a million (divide by 1e6 for micro-dollars): exact integer math.
    fn numer(&self, u: &Usage) -> u128 {
        u.input as u128 * self.input as u128
            + u.output as u128 * self.output as u128
            + u.cache_read as u128 * self.cache_read as u128
            + u.cache_write as u128 * self.cache_write as u128
    }
}

/// The price table: model name to prices, with its own date and source.
#[derive(Debug, Clone, Default)]
pub struct PriceTable {
    /// Where the prices came from (shown next to every figure).
    pub source: String,
    /// When they were taken.
    pub date: String,
    models: Vec<(String, Price)>,
}

impl PriceTable {
    /// A table from `(name, price)` pairs.
    pub fn new(date: &str, source: &str, models: Vec<(String, Price)>) -> PriceTable {
        let mut models = models;
        models.sort_by_key(|(n, _)| std::cmp::Reverse(n.len())); // the longest, most specific name matches first
        PriceTable { source: source.into(), date: date.into(), models }
    }

    /// The shipped table (`impact.price_table`).
    pub fn from_defaults() -> PriceTable {
        let t = defaults::raw("impact.price_table");
        let models = t
            .get("models")
            .and_then(defaults::V::as_table)
            .unwrap_or_default()
            .iter()
            .map(|(name, v)| {
                let f = |k: &str| v.get(k).and_then(defaults::V::as_integer).map(|n| n.max(0) as u64).unwrap_or(0);
                (name.to_string(), Price { input: f("in_uc"), output: f("out_uc"), cache_read: f("cache_read_uc"), cache_write: f("cache_write_uc") })
            })
            .collect();
        PriceTable::new(t.str_field("date"), t.str_field("source"), models)
    }

    /// The price of `model`: an exact name, else the longest table name the model name contains (so a table entry
    /// `opus` prices `claude-opus-4-5`). An `inherit:` prefix (the model was inherited, not named) is ignored. `None`
    /// when the table does not know the model.
    pub fn price(&self, model: &str) -> Option<Price> {
        let m = model.strip_prefix(defaults::text("telemetry.inherit_prefix")).unwrap_or(model);
        self.models.iter().find(|(n, _)| n == m).or_else(|| self.models.iter().find(|(n, _)| m.contains(n.as_str()))).map(|(_, p)| *p)
    }
}

/// A spawn result joined to the routing decision that started its chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chain {
    /// The first routing decision of the chain: what the agent originally asked for.
    pub origin: Route,
    /// How many routing decisions the chain holds (a blocked spawn that was re-spawned has two or more).
    pub decisions: usize,
    /// What actually ran.
    pub spawn: Spawn,
}

/// Join spawn results to routing decisions by `spawn_key` (D77). A spawn result belongs to the routing decisions with its
/// key that happened after the previous result with that key (or at most `window_ms` before it) and no later than the
/// result: the first of them is the chain's origin (the model originally asked for), so a spawn that was steered and then
/// re-spawned on another model is still compared against what it first asked for. Results without a decision are ignored.
/// Also returns how many routing decisions found no result.
pub fn chains(events: &[Event], window_ms: u64) -> (Vec<Chain>, usize) {
    let mut routes: HashMap<&str, Vec<(&Event, &Route)>> = HashMap::new();
    let mut spawns: Vec<(&Event, &Spawn)> = Vec::new();
    for e in events {
        match &e.extras {
            Extras::Route(r) => routes.entry(r.spawn_key.as_str()).or_default().push((e, r)),
            Extras::Spawn(s) => spawns.push((e, s)),
            _ => {}
        }
    }
    for v in routes.values_mut() {
        v.sort_by_key(|(e, _)| e.ts_ms);
    }
    spawns.sort_by_key(|(e, _)| e.ts_ms);
    let mut last_spawn: HashMap<&str, u64> = HashMap::new();
    let mut linked = 0;
    let mut out = Vec::new();
    for (se, s) in spawns {
        let key = s.spawn_key.as_str();
        let from = last_spawn.get(key).copied().map(|t| t + 1).unwrap_or_else(|| se.ts_ms.saturating_sub(window_ms));
        last_spawn.insert(key, se.ts_ms);
        let group: Vec<&Route> =
            routes.get(key).map(|v| v.iter().filter(|(e, _)| e.ts_ms >= from && e.ts_ms <= se.ts_ms).map(|(_, r)| *r).collect()).unwrap_or_default();
        if let Some(first) = group.first() {
            linked += group.len();
            out.push(Chain { origin: (*first).clone(), decisions: group.len(), spawn: s.clone() });
        }
    }
    let total: usize = routes.values().map(Vec::len).sum();
    (out, total.saturating_sub(linked))
}

/// Dollars of a product sum (tokens times micro-dollars per million tokens), rounded to the micro-dollar.
fn usd(numer: i128) -> f64 {
    (numer as f64 / 1e12 * 1e6).round() / 1e6
}

/// What `net` needs besides the events.
pub struct NetInput<'a> {
    /// Routing, spawn and Jev events in the window, any order.
    pub events: &'a [Event],
    /// Bytes injected into model context by hooks in the window (the `hook` counters' `ib` sum).
    pub injected_bytes: u64,
    /// Prices.
    pub prices: &'a PriceTable,
    /// How long before a spawn result a routing decision still belongs to it.
    pub link_window_ms: u64,
    /// Bytes per token used to turn injected bytes into an estimated token count.
    pub bytes_per_token: u64,
}

/// The NET savings report: routing saved and spent-up in both directions, the spenders, and the net. Every figure is
/// labelled an estimate and carries its method and the price table's date and source.
pub fn net(i: &NetInput<'_>) -> Value {
    let (chains, unlinked) = chains(i.events, i.link_window_ms);
    let mut outcomes: BTreeMap<&str, u64> = BTreeMap::new();
    let mut by_model: HashMap<&str, u64> = HashMap::new();
    for e in i.events {
        if let Extras::Route(r) = &e.extras {
            *outcomes.entry(r.outcome.name()).or_insert(0) += 1;
            *by_model.entry(r.parent_model.as_str()).or_insert(0) += 1;
        }
    }
    let (mut saved, mut spent_up) = (0i128, 0i128);
    let (mut saved_n, mut up_n, mut same_n, mut unpriced, mut no_usage) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut tokens = Usage::default();
    let mut unpriced_models = std::collections::BTreeSet::new();
    for c in &chains {
        let u = &c.spawn.usage;
        if u.input + u.output + u.cache_read + u.cache_write == 0 {
            no_usage += 1;
            continue;
        }
        let (Some(asked), Some(ran)) = (i.prices.price(c.origin.requested_model.as_str()), i.prices.price(c.spawn.actual_model.as_str())) else {
            for m in [c.origin.requested_model.as_str(), c.spawn.actual_model.as_str()] {
                if i.prices.price(m).is_none() {
                    unpriced_models.insert(m.to_string());
                }
            }
            unpriced += 1;
            continue;
        };
        tokens.input += u.input;
        tokens.output += u.output;
        tokens.cache_read += u.cache_read;
        tokens.cache_write += u.cache_write;
        let diff = asked.numer(u) as i128 - ran.numer(u) as i128;
        match diff.cmp(&0) {
            std::cmp::Ordering::Greater => {
                saved += diff;
                saved_n += 1;
            }
            std::cmp::Ordering::Less => {
                spent_up += -diff;
                up_n += 1;
            }
            std::cmp::Ordering::Equal => same_n += 1,
        }
    }
    // spenders: injected context (priced as input tokens of the model that read it: the most common parent model) and Jev
    let parent = by_model.iter().max_by_key(|(m, n)| (**n, std::cmp::Reverse(**m))).map(|(m, _)| *m);
    let inj_tokens = i.injected_bytes.checked_div(i.bytes_per_token.max(1)).unwrap_or(0);
    let injection = parent.and_then(|m| i.prices.price(m)).map(|p| inj_tokens as i128 * p.input as i128);
    if let (Some(m), None) = (parent, injection) {
        unpriced_models.insert(m.to_string());
    }
    let no_price: Vec<String> = unpriced_models.iter().map(|m| defaults::render("msg.no_price_for_model", &[("model", m)])).collect();
    let jev: Vec<&super::event::Jev> = i.events.iter().filter_map(|e| if let Extras::Jev(j) = &e.extras { Some(j) } else { None }).collect();
    let jev_uc: u64 = jev.iter().map(|j| j.cost_uc).sum();
    let routing_net = saved - spent_up;
    let priced_any = !chains.is_empty() && unpriced < chains.len() as u64;
    let net_numer = routing_net - injection.unwrap_or(0) - jev_uc as i128 * 1_000_000;
    let have_prices = priced_any || injection.is_some() || jev_uc > 0;
    json!({
        "label": "estimate",
        "method": defaults::text("impact.savings_method"),
        "net_method": defaults::text("telemetry.net_method"),
        "price_table": {"date": i.prices.date, "source": i.prices.source},
        "routing": {
            "decisions": outcomes.values().sum::<u64>(),
            "by_outcome": outcomes,
            "linked_spawns": chains.len(),
            "decisions_without_result": unlinked,
            "spawns_cheaper": saved_n,
            "spawns_dearer": up_n,
            "spawns_same_price": same_n,
            "unpriced_spawns": unpriced,
            "unpriced_models": no_price,
            "spawns_without_usage": no_usage,
            "tokens_compared": {"input": tokens.input, "output": tokens.output, "cache_read": tokens.cache_read, "cache_write": tokens.cache_write},
            "saved_usd": usd(saved),
            "spent_up_usd": usd(spent_up),
            "net_usd": usd(routing_net),
        },
        "spenders": {
            "injected_bytes": i.injected_bytes,
            "injected_tokens_estimate": inj_tokens,
            "injection_usd": injection.map(usd),
            "injection_priced_as": parent,
            "jev_calls": jev.len(),
            "jev_usd": jev_uc as f64 / 1e6,
        },
        "net_usd": if have_prices { json!(usd(net_numer)) } else { Value::Null },
        "complete": unpriced == 0 && (i.injected_bytes == 0 || injection.is_some()),
    })
}

#[cfg(test)]
mod tests {
    use super::super::event::{Jev, Kind, Outcome, RouteOutcome, Token};
    use super::*;

    fn t(s: &str) -> Token {
        Token::new(s).unwrap()
    }

    fn route(ts: u64, key: &str, asked: &str, parent: &str, outcome: RouteOutcome) -> Event {
        Event {
            ts_ms: ts,
            kind: Kind::Route,
            h: t("model-routing"),
            e: t("PreToolUse"),
            o: Outcome::Advise,
            ms: 1,
            ib: 0,
            extras: Extras::Route(Route {
                requested_model: t(asked),
                parent_model: t(parent),
                task_class: t("mechanical"),
                recommended_tier: t("haiku"),
                selected_model: t("haiku"),
                outcome,
                spawn_key: t(key),
            }),
        }
    }

    fn spawn(ts: u64, key: &str, ran: &str, usage: Usage) -> Event {
        Event {
            ts_ms: ts,
            kind: Kind::Spawn,
            h: t("model-routing"),
            e: t("PostToolUse"),
            o: Outcome::Allow,
            ms: 0,
            ib: 0,
            extras: Extras::Spawn(Spawn { spawn_key: t(key), actual_model: t(ran), usage }),
        }
    }

    fn jev(cost: u64) -> Event {
        Event {
            ts_ms: 5,
            kind: Kind::Jev,
            h: t("jev"),
            e: t("PreToolUse"),
            o: Outcome::Advise,
            ms: 90,
            ib: 0,
            extras: Extras::Jev(Jev { integration: t("speculation"), mode: t("on"), verdict: t("keep"), cost_uc: cost }),
        }
    }

    /// Fixture prices in micro-dollars per million tokens: opus $15 in / $75 out, haiku $1 in / $5 out.
    fn prices() -> PriceTable {
        let p = |i, o| Price { input: i, output: o, cache_read: i / 10, cache_write: i + i / 4 };
        PriceTable::new("fixture", "fixture", vec![("opus".into(), p(15_000_000, 75_000_000)), ("haiku".into(), p(1_000_000, 5_000_000))])
    }

    fn u(i: u64, o: u64) -> Usage {
        Usage { input: i, output: o, cache_read: 0, cache_write: 0 }
    }

    #[test]
    fn the_shipped_table_prices_opus_5_5_and_nothing_else() {
        let t = PriceTable::from_defaults();
        let p = t.price("claude-opus-5-5").expect("opus 5.5 is priced");
        assert_eq!((p.input, p.output, p.cache_read, p.cache_write), (4_000_000, 20_000_000, 200_000, 8_000_000));
        assert!(t.price("claude-sonnet-5-5").is_none() && t.price("claude-haiku-4-5-20251001").is_none(), "other models stay unpriced, never guessed");
        assert_eq!(defaults::render("msg.no_price_for_model", &[("model", &"claude-sonnet-5-5")]), "no price for model claude-sonnet-5-5");
    }

    #[test]
    fn a_route_event_joins_the_spawn_result_that_shares_its_key() {
        let ev = vec![
            route(100, "k1", "opus", "opus", RouteOutcome::Down),
            route(110, "k2", "opus", "opus", RouteOutcome::Allow),
            spawn(200, "k1", "haiku", u(10, 10)),
            route(5_000_000, "k3", "opus", "opus", RouteOutcome::Allow), // no result yet
        ];
        let (c, unlinked) = chains(&ev, 3_600_000);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].origin.spawn_key.as_str(), c[0].spawn.actual_model.as_str(), c[0].decisions), ("k1", "haiku", 1));
        assert_eq!(unlinked, 2, "k2 and k3 have no result");
    }

    #[test]
    fn a_blocked_then_respawned_spawn_is_compared_against_what_it_first_asked_for() {
        // asked for opus, was steered down, re-spawned with the same description on haiku (the second decision is an allow)
        let ev = vec![
            route(100, "k", "opus", "opus", RouteOutcome::Down),
            route(150, "k", "haiku", "opus", RouteOutcome::Allow),
            spawn(300, "k", "haiku", u(1000, 1000)),
        ];
        let (c, _) = chains(&ev, 3_600_000);
        assert_eq!((c.len(), c[0].decisions, c[0].origin.requested_model.as_str()), (1, 2, "opus"));
        // a later spawn with the same key starts a new chain
        let mut ev = ev;
        ev.push(route(400, "k", "opus", "opus", RouteOutcome::Allow));
        ev.push(spawn(500, "k", "opus", u(1, 1)));
        let (c, _) = chains(&ev, 3_600_000);
        assert_eq!(c.len(), 2);
        assert_eq!(c[1].decisions, 1);
        // a decision older than the window does not belong to the result
        let (c, unlinked) = chains(&[route(0, "z", "opus", "opus", RouteOutcome::Down), spawn(10_000, "z", "haiku", u(1, 1))], 1000);
        assert_eq!((c.len(), unlinked), (0, 1));
    }

    #[test]
    fn net_math_on_a_fixture_is_exact_in_both_directions() {
        let ev = vec![
            // down: asked opus, ran haiku, 1M in + 100k out -> opus 15 + 7.5 = 22.5 ; haiku 1 + 0.5 = 1.5 ; saved 21
            route(100, "down", "opus", "opus", RouteOutcome::Down),
            spawn(200, "down", "haiku", u(1_000_000, 100_000)),
            // up: asked haiku, ran opus, 200k in + 10k out -> haiku 0.2+0.05 = 0.25 ; opus 3 + 0.75 = 3.75 ; spent up 3.5
            route(300, "up", "haiku", "opus", RouteOutcome::Up),
            spawn(400, "up", "opus", u(200_000, 10_000)),
            // same model: no change
            route(500, "same", "opus", "opus", RouteOutcome::Allow),
            spawn(600, "same", "opus", u(5, 5)),
            jev(2_500_000), // $2.50
        ];
        // 400k injected bytes at 4 bytes per token = 100k tokens, priced at the parent (opus) input $15/M = $1.50
        let p = prices();
        let v = net(&NetInput { events: &ev, injected_bytes: 400_000, prices: &p, link_window_ms: 3_600_000, bytes_per_token: 4 });
        let r = &v["routing"];
        assert_eq!((r["saved_usd"].as_f64(), r["spent_up_usd"].as_f64(), r["net_usd"].as_f64()), (Some(21.0), Some(3.5), Some(17.5)));
        assert_eq!((r["spawns_cheaper"].as_u64(), r["spawns_dearer"].as_u64(), r["spawns_same_price"].as_u64()), (Some(1), Some(1), Some(1)));
        assert_eq!(r["by_outcome"]["down"], 1);
        assert_eq!(r["by_outcome"]["up"], 1);
        let s = &v["spenders"];
        assert_eq!((s["injection_usd"].as_f64(), s["jev_usd"].as_f64(), s["jev_calls"].as_u64()), (Some(1.5), Some(2.5), Some(1)));
        assert_eq!(v["net_usd"].as_f64(), Some(13.5), "17.5 routing net - 1.5 injected context - 2.5 Jev");
        assert_eq!(v["label"], "estimate");
        assert_eq!(v["complete"], true);
    }

    #[test]
    fn unknown_models_are_counted_as_unpriced_not_guessed() {
        let ev = vec![route(1, "k", "mystery-model", "opus", RouteOutcome::Allow), spawn(2, "k", "haiku", u(100, 100))];
        let v = net(&NetInput { events: &ev, injected_bytes: 0, prices: &prices(), link_window_ms: 1000, bytes_per_token: 4 });
        assert_eq!(v["routing"]["unpriced_spawns"], 1);
        assert_eq!(v["routing"]["saved_usd"].as_f64(), Some(0.0));
        assert_eq!(v["complete"], false);
        // with no table at all there is no figure
        let none = PriceTable::default();
        let v = net(&NetInput { events: &ev, injected_bytes: 0, prices: &none, link_window_ms: 1000, bytes_per_token: 4 });
        assert!(v["net_usd"].is_null());
    }

    #[test]
    fn a_family_name_prices_a_full_model_name_and_an_inherited_prefix_is_ignored() {
        let p = prices();
        assert_eq!(p.price("claude-opus-4-5"), p.price("opus"));
        assert_eq!(p.price("inherit:opus"), p.price("opus"));
        assert_eq!(p.price("haiku"), p.price("claude-haiku-4-5-20251001"));
        assert!(p.price("gpt-x").is_none());
    }
}
