//! Built-in `check = "model-routing"`: a port of the Node model-routing guard (PreToolUse on Agent/Task).
//!
//! Mirrors `hooks/model-routing-guard.js`: row-1/row-2 blocks are exact exit-2 JSON, advisories are exact
//! `hookSpecificOutput.additionalContext` JSON, and allows are silent.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped, read_object, stored_options};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Exact, RouteMeta, Verdict};
use crate::defaults::{self, V};
use crate::jev::{AskRequest, Env as JevEnv, Jev, Mode, Question, Trust};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

#[cfg(test)]
mod tests;

/// Model-routing built-in check.
pub struct ModelRouting;

struct Pats {
    role_word: Regex,
    research: Regex,
    write: Regex,
    write_imperative: Regex,
    write_phrase: Regex,
    readonly_override: Regex,
    deploy_strong: Regex,
    deploy_weak: Regex,
    update_node: Regex,
    update_skill_path: Regex,
    update_slash: Regex,
    planning_intent: Regex,
    readonly: Regex,
    mechanical_shape: Regex,
    review_design_verb: Regex,
    reasoning: Regex,
    handover_noun: Regex,
    handover_verb: Regex,
    code_fence: Regex,
    inline_code: Regex,
    session_safe: Regex,
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| {
        let ci = |k| jsre::compile(defaults::text(k), true);
        let re = |k| jsre::compile(defaults::text(k), false);
        Pats {
            role_word: ci("model_routing.role_word_re"),
            research: ci("model_routing.research_re"),
            write: ci("model_routing.write_re"),
            write_imperative: ci("model_routing.write_imperative_re"),
            write_phrase: ci("model_routing.write_phrase_re"),
            readonly_override: ci("model_routing.readonly_override_re"),
            deploy_strong: ci("model_routing.deploy_strong_re"),
            deploy_weak: ci("model_routing.deploy_weak_re"),
            update_node: ci("model_routing.update_node_re"),
            update_skill_path: ci("model_routing.update_skill_path_re"),
            update_slash: ci("model_routing.update_slash_re"),
            planning_intent: ci("model_routing.planning_intent_re"),
            readonly: ci("model_routing.readonly_re"),
            mechanical_shape: ci("model_routing.mechanical_shape_re"),
            review_design_verb: ci("model_routing.review_design_verb_re"),
            reasoning: ci("model_routing.reasoning_re"),
            handover_noun: ci("model_routing.handover_noun_re"),
            handover_verb: ci("model_routing.handover_verb_re"),
            code_fence: re("model_routing.code_fence_re"),
            inline_code: re("model_routing.inline_code_re"),
            session_safe: re("model_routing.session_safe_re"),
        }
    })
}

fn as_obj(v: &Value) -> Option<&serde_json::Map<String, Value>> {
    v.as_object()
}

fn input_str<'a>(input: Option<&'a serde_json::Map<String, Value>>, key: &str) -> &'a str {
    input.and_then(|m| m.get(key)).and_then(Value::as_str).unwrap_or("")
}

fn lower_trim(s: &str) -> String {
    js_trim(s).to_ascii_lowercase()
}

fn js_slice_utf16(s: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for c in s.chars() {
        let n = c.len_utf16();
        if used + n > limit {
            break;
        }
        out.push(c);
        used += n;
    }
    out
}

fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in s.nfkc().flat_map(char::to_lowercase) {
        if is_letter_or_number(c) {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn is_letter_or_number(c: char) -> bool {
    // Rust's Alphabetic property includes marks and enclosed letter symbols; JS's L/N categories do not.
    // Reuse the normalization crate's General_Category=Mark table. These are the non-mark Alphabetic symbols.
    c.is_alphanumeric() && !is_combining_mark(c) && !matches!(c, '\u{24b6}'..='\u{24e9}' | '\u{1f130}'..='\u{1f149}' | '\u{1f150}'..='\u{1f189}')
}

fn has_phrase(tokens: &[String], phrase: &str) -> bool {
    let parts: Vec<&str> = phrase.split_whitespace().collect();
    match parts.len() {
        0 => false,
        1 => tokens.iter().any(|t| t == parts[0]),
        n => tokens.windows(n).any(|w| w.iter().map(String::as_str).eq(parts.iter().copied())),
    }
}

fn count_signals(tokens: &[String], key: &str) -> usize {
    defaults::list(key).into_iter().filter(|sig| has_phrase(tokens, sig)).count()
}

fn strip_code_spans(s: &str) -> String {
    let p = pats();
    let s = p.code_fence.replace_all(s, " ");
    p.inline_code.replace_all(&s, " ").into_owned()
}

fn read_only_mechanical(corpus: &str) -> bool {
    let stripped = strip_code_spans(corpus);
    pats().readonly.is_match(corpus) && pats().mechanical_shape.is_match(corpus) && !pats().review_design_verb.is_match(&stripped)
}

fn is_reasoning_shaped(corpus: &str) -> bool {
    pats().reasoning.is_match(&strip_code_spans(corpus))
}

fn rank(model: &str) -> Option<i64> {
    defaults::raw("model_routing.model_rank").get(model).and_then(V::as_integer)
}

fn is_deploy_shaped(corpus: &str) -> bool {
    let p = pats();
    if p.deploy_strong.is_match(corpus) {
        return true;
    }
    let mut kinds = BTreeSet::new();
    for m in p.deploy_weak.captures_iter(corpus) {
        let mut k = m.get(1).map(|x| x.as_str().to_ascii_lowercase()).unwrap_or_default();
        if let Some(alias) = defaults::raw("model_routing.deploy_weak_aliases").get(&k).and_then(V::as_str) {
            k = alias.to_string();
        }
        if let Some(stripped) = k.strip_suffix('s') {
            k = stripped.to_string();
        }
        kinds.insert(k);
    }
    kinds.len() >= defaults::num("model_routing.deploy_weak_threshold") as usize
}

fn runs_update(corpus: &str) -> bool {
    let p = pats();
    let qualifier = defaults::text("model_routing.update_qualifier");
    p.update_skill_path.is_match(corpus)
        || p.update_slash.is_match(corpus)
        || (p.update_node.is_match(corpus) && corpus.to_ascii_lowercase().contains(qualifier))
}

fn tier(key: &str) -> &'static str {
    defaults::text(key)
}

fn st(env: &RequestEnv) -> Settings {
    Settings { home: env.get("HOME").unwrap_or("").to_string(), env: env.to_map() }
}

fn jev_env(env: &RequestEnv) -> JevEnv {
    JevEnv::from_pairs(env.to_map())
}

fn enum_value(v: &Value, valid_key: &str) -> Option<String> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let s = js_trim(&s).to_ascii_lowercase();
    defaults::list(valid_key).contains(&s.as_str()).then_some(s)
}

fn setting_enum(st: &Settings, env_key: &str, section: &str, key: &str, option: &str, default: &str, valid_key: &str) -> String {
    if let Some(v) = st.env.get(env_key).and_then(|raw| enum_value(&Value::String(raw.clone()), valid_key)) {
        return v;
    }
    if let Some(v) = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(section).and_then(Value::as_object).and_then(|s| s.get(key)).cloned())
        .and_then(|v| enum_value(&v, valid_key))
    {
        return v;
    }
    let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
    if let Some(raw) = st.env.get(&env_key) {
        return if js_trim(raw) == default {
            default.to_string()
        } else {
            enum_value(&Value::String(raw.clone()), valid_key).unwrap_or_else(|| default.to_string())
        };
    }
    if let Some(v) = stored_options(st).and_then(|o| o.get(option).cloned()) {
        return if matches!(&v, Value::String(s) if js_trim(s) == default) {
            default.to_string()
        } else {
            enum_value(&v, valid_key).unwrap_or_else(|| default.to_string())
        };
    }
    default.to_string()
}

fn block(text: String) -> Verdict {
    let reason = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".to_string());
    Verdict::Exact(Exact { code: 2, out: format!("{{\"decision\":\"block\",\"reason\":{reason}}}\n"), err: String::new() })
}

fn advise(text: String) -> Verdict {
    Verdict::Exact(Exact { code: 0, out: format!("{}\n", msg::advisory_json("PreToolUse", &text)), err: String::new() })
}

fn first_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_str).filter(|s| !js_trim(s).is_empty()))
}

fn bounded_component(s: &str) -> String {
    let limit = defaults::num("telemetry.token_max_len") as usize;
    let mut out = String::new();
    for c in s.chars() {
        if out.len() + c.len_utf8() > limit {
            break;
        }
        out.push(c);
    }
    out
}

fn route_key(payload: &Value, subagent_type: &str, requested_model: &str) -> String {
    let id_fields = defaults::list("model_routing.id_fields");
    if let Some(id) = first_str(payload, &id_fields) {
        return format!("spawn-{:016x}", crate::health::fnv(&format!("id:{}", bounded_component(id))));
    }
    // No prompt, description, or other payload text: this fallback is O(1) and content-free.
    let identity = [
        bounded_component(payload.get("session_id").and_then(Value::as_str).unwrap_or("")),
        bounded_component(payload.get("agent_id").and_then(Value::as_str).unwrap_or("")),
        bounded_component(subagent_type),
        bounded_component(requested_model),
    ]
    .join("\u{1f}");
    format!("spawn-{:016x}", crate::health::fnv(&identity.to_string()))
}

fn parent_model(payload: &Value) -> String {
    // There is no resolved settings key for the parent model in the current engine or Node guard; when the hook payload
    // does not carry one, keep the documented unknown sentinel instead of inventing a source.
    first_str(payload, &["parent_model", "model"]).map(lower_trim).unwrap_or_else(|| format!("{}unknown", defaults::text("telemetry.inherit_prefix")))
}

fn selected_model(requested: &str, parent: &str, recommended: &str, outcome: &str) -> String {
    match outcome {
        "down" | "up" if rank(recommended).is_some() => recommended.to_string(),
        "exempt" if rank(recommended).is_some() && recommended != requested => recommended.to_string(),
        _ if requested.starts_with(defaults::text("telemetry.inherit_prefix")) => parent.to_string(),
        _ => requested.to_string(),
    }
}

#[derive(Clone, Copy)]
struct RouteInput<'a> {
    model: &'a str,
    omitted: bool,
    subagent_type: &'a str,
}

fn routed(v: Verdict, payload: &Value, input: RouteInput<'_>, class: &str, recommended: &str, outcome: &str) -> Verdict {
    let parent = parent_model(payload);
    let requested = if input.omitted {
        format!("{}{}", defaults::text("telemetry.inherit_prefix"), parent.strip_prefix(defaults::text("telemetry.inherit_prefix")).unwrap_or(&parent))
    } else {
        input.model.to_string()
    };
    let selected = selected_model(&requested, &parent, recommended, outcome);
    let delegate = outcome == "down" && (matches!(&v, Verdict::Exact(x) if x.code == 2) || matches!(&v, Verdict::Block(_)));
    Verdict::Routed(
        Box::new(v),
        vec![RouteMeta {
            requested_model: requested.clone(),
            parent_model: parent,
            task_class: class.to_string(),
            recommended_tier: recommended.to_string(),
            selected_model: selected,
            outcome: outcome.to_string(),
            spawn_key: route_key(payload, input.subagent_type, &requested),
            delegate,
        }],
    )
}

fn block_msg(what: String, why: &str, instead: &str, override_: &str) -> String {
    msg::message(Kind::Block, defaults::text("model_routing.guard_name"), &Parts { what: &what, why, instead, override_, ..Parts::default() })
}

fn tip(what: String, instead: &str, why: &str) -> Verdict {
    advise(msg::message(Kind::Warn, defaults::text("model_routing.message_guard"), &Parts { what: &what, instead, why, ..Parts::default() }))
}

fn one_pass(template_key: &str, args: &[(&str, &str)]) -> String {
    msg::render(template_key, args)
}

fn fallback_block(reason: &str) -> Verdict {
    let reason = serde_json::to_string(reason).unwrap_or_else(|_| "\"model-routing fail-closed\"".to_string());
    Verdict::Exact(Exact { code: 2, out: format!("{{\"decision\":\"block\",\"reason\":{reason}}}\n"), err: String::new() })
}

pub(crate) fn fail_closed() -> Verdict {
    let v = std::panic::catch_unwind(|| {
        block(block_msg(
            defaults::text("model_routing.msg_fail_closed_what").to_string(),
            defaults::text("model_routing.msg_fail_closed_why"),
            defaults::text("model_routing.msg_fail_closed_instead"),
            "",
        ))
    })
    .unwrap_or_else(|_| fallback_block("model-routing fail-closed"));
    routed(v, &Value::Null, RouteInput { model: "", omitted: true, subagent_type: "" }, "unknown", tier("model_routing.tier_main"), "deny")
}

fn model_routing_question() -> Question {
    Question::choice(
        defaults::text("model_routing.jev_question_instructions"),
        vec![
            (defaults::text("model_routing.jev_label_mechanical").to_string(), defaults::text("model_routing.jev_choice_mechanical").to_string()),
            (defaults::text("model_routing.jev_label_authoring").to_string(), defaults::text("model_routing.jev_choice_authoring").to_string()),
            (defaults::text("model_routing.jev_label_research").to_string(), defaults::text("model_routing.jev_choice_research").to_string()),
            (defaults::text("model_routing.jev_label_plan_review").to_string(), defaults::text("model_routing.jev_choice_plan_review").to_string()),
        ],
    )
}

fn jev_enabled_for_routing(st: &Settings, env: &RequestEnv) -> bool {
    let home = Path::new(&st.home);
    let sources = crate::jev::settings::Sources::load(home, jev_env(env));
    let settings = crate::jev::JevSettings::resolve(home, sources);
    settings.mode(defaults::text("model_routing.jev_id"), false) != Mode::Off
}

fn consult_model_routing_jev(corpus: &str, payload: &Value, st: &Settings, env: &RequestEnv, jev: Option<&Jev>) -> bool {
    if let Some(jev) = jev {
        return consult_model_routing_jev_with(corpus, payload, env, jev);
    }
    if !jev_enabled_for_routing(st, env) {
        return false;
    }
    let jev = Jev::new(Path::new(&st.home), jev_env(env));
    consult_model_routing_jev_with(corpus, payload, env, &jev)
}

fn consult_model_routing_jev_with(corpus: &str, payload: &Value, env: &RequestEnv, jev: &Jev) -> bool {
    let mut req = AskRequest::new(
        defaults::text("model_routing.jev_id"),
        model_routing_question(),
        &js_slice_utf16(corpus, defaults::num("model_routing.jev_state_limit") as usize),
        Trust::RelaxBlock,
        Value::Bool(true),
    );
    req.record_disagreement = true;
    req.budget_ms = Some(defaults::num("model_routing.jev_budget_ms"));
    req.session_id = payload.get("session_id").and_then(Value::as_str).map(str::to_string);
    req.env = Some(jev_env(env));
    req.judge = Some(std::sync::Arc::new(|answer| answer.to_json() == Value::String(defaults::text("model_routing.jev_label_mechanical").to_string())));
    let d = jev.ask(&req);
    d.outcome == Value::Bool(false)
}

fn handover_advisory(payload: &Value, corpus: &str, st: &Settings) -> Option<Verdict> {
    let p = pats();
    if !p.handover_noun.is_match(corpus) || !p.handover_verb.is_match(corpus) {
        return None;
    }
    if st.home.is_empty() {
        return None;
    }
    let raw = payload.get("session_id").map(|v| match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    });
    let id = raw.filter(|s| !s.is_empty()).unwrap_or_else(|| defaults::text("model_routing.unknown_session").to_string());
    let safe = p.session_safe.replace_all(&id, "_");
    let dir = Path::new(&st.home).join(defaults::text("model_routing.state_dir"));
    let file = dir.join(format!("{}{}{}", defaults::text("model_routing.handover_state_prefix"), safe, defaults::text("model_routing.handover_state_suffix")));
    if file.exists() {
        return None;
    }
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(&file, defaults::text("model_routing.handover_state_json")).ok()?;
    Some(advise(msg::message(
        Kind::Tip,
        defaults::text("model_routing.handover_guard"),
        &Parts {
            what: defaults::text("model_routing.msg_handover_what"),
            why: defaults::text("model_routing.msg_handover_why"),
            instead: defaults::text("model_routing.msg_handover_instead"),
            ..Parts::default()
        },
    )))
}

fn decide_inner(payload: &Value, env: &RequestEnv, tool_override: Option<&str>) -> Option<Verdict> {
    decide_inner_with_jev(payload, env, None, tool_override)
}

fn decide_inner_with_jev(payload: &Value, env: &RequestEnv, jev: Option<&Jev>, _tool_override: Option<&str>) -> Option<Verdict> {
    let st = st(env);
    if is_skipped(&st, defaults::text("model_routing.guard_name")) {
        return None;
    }
    let input = payload.get("tool_input").and_then(as_obj);
    let model = lower_trim(input_str(input, "model"));
    let model_omitted = !input.and_then(|m| m.get("model")).and_then(Value::as_str).is_some_and(|s| !js_trim(s).is_empty());
    let subagent_type = js_trim(input_str(input, "subagent_type")).to_string();
    let route_input = RouteInput { model: &model, omitted: model_omitted, subagent_type: &subagent_type };
    let routing_mode = setting_enum(
        &st,
        defaults::text("model_routing.mode_env"),
        defaults::text("model_routing.setting_section"),
        defaults::text("model_routing.setting_key"),
        defaults::text("model_routing.mode_option"),
        defaults::text("model_routing.routing_mode_default"),
        "model_routing.mode_values",
    );
    if routing_mode == defaults::text("model_routing.off_mode") {
        return Some(routed(Verdict::Allow, payload, route_input, "unknown", if model_omitted { tier("model_routing.tier_inherit") } else { &model }, "allow"));
    }
    let description = input_str(input, "description");
    let prompt = input_str(input, "prompt");
    let joined = format!("{description}\n{prompt}");
    let corpus = js_slice_utf16(&joined, defaults::num("model_routing.scan_limit") as usize);
    let corpus = corpus.as_str();

    if get_bool(&st, defaults::raw("model_routing.update_setting")) && runs_update(corpus) {
        return Some(routed(
            block(block_msg(
                defaults::text("model_routing.msg_update_what").to_string(),
                defaults::text("model_routing.msg_update_why"),
                defaults::text("model_routing.msg_update_instead"),
                "",
            )),
            payload,
            route_input,
            "update",
            tier("model_routing.tier_main"),
            "exempt",
        ));
    }
    if let Some(v) = handover_advisory(payload, corpus, &st) {
        return Some(routed(v, payload, route_input, "handover", tier("model_routing.tier_main"), "exempt"));
    }

    let tokens = tokenize(corpus);
    let mechanical = count_signals(&tokens, "model_routing.mechanical");
    let complex = count_signals(&tokens, "model_routing.complex");
    let is_mechanical_only = mechanical > 0 && complex == 0 && !is_reasoning_shaped(corpus);
    let strict = routing_mode != defaults::text("model_routing.advisory_mode");
    let exempt = pats().role_word.is_match(description);
    let hard_execution = count_signals(&tokens, "model_routing.hard_execution") > 0;
    let research_exempt = !hard_execution && pats().research.is_match(corpus);
    let is_generic = subagent_type.is_empty() || subagent_type == defaults::text("model_routing.generic_type");
    let is_custom = !subagent_type.is_empty() && subagent_type != defaults::text("model_routing.generic_type");
    let is_flagship = defaults::list("model_routing.flagship_models").contains(&model.as_str());

    let mut suppress_haiku_rows = false;
    let deploy_floor = setting_enum(
        &st,
        defaults::text("model_routing.deploy_floor_env"),
        defaults::text("model_routing.setting_section"),
        defaults::text("model_routing.deploy_floor_key"),
        defaults::text("model_routing.deploy_floor_option"),
        defaults::text("model_routing.deploy_floor_default"),
        "model_routing.deploy_floor_values",
    );
    if deploy_floor != defaults::text("model_routing.deploy_floor_off") && is_deploy_shaped(corpus) {
        let floor = if rank(&deploy_floor).is_some() { deploy_floor.as_str() } else { defaults::text("model_routing.deploy_floor_default") };
        if model_omitted {
            let instead = one_pass("model_routing.msg_deploy_omitted_instead", &[("floor", floor)]);
            return Some(routed(
                tip(defaults::text("model_routing.msg_deploy_omitted_what").to_string(), &instead, defaults::text("model_routing.msg_deploy_why")),
                payload,
                route_input,
                "deploy",
                floor,
                "up",
            ));
        }
        if rank(&model).zip(rank(floor)).is_some_and(|(m, f)| m < f) {
            let extra =
                if model == tier("model_routing.tier_haiku") && !read_only_mechanical(corpus) && pats().planning_intent.is_match(&strip_code_spans(corpus)) {
                    defaults::text("model_routing.msg_deploy_low_extra")
                } else {
                    ""
                };
            let what = one_pass("model_routing.msg_deploy_low_what", &[("model", &model)]);
            let instead = one_pass("model_routing.msg_deploy_low_instead", &[("floor", floor), ("extra", extra)]);
            return Some(routed(tip(what, &instead, defaults::text("model_routing.msg_deploy_why")), payload, route_input, "deploy", floor, "up"));
        }
        suppress_haiku_rows = true;
    }

    if !suppress_haiku_rows && is_mechanical_only && !model_omitted && is_flagship && is_generic {
        let reason = block_msg(
            one_pass("model_routing.msg_row1_what", &[("model", &model)]),
            defaults::text("model_routing.msg_row1_why"),
            defaults::text("model_routing.msg_row1_instead"),
            "",
        );
        if exempt {
            return Some(routed(
                tip(one_pass("model_routing.msg_row1_role_what", &[("model", &model)]), defaults::text("model_routing.msg_row1_role_instead"), ""),
                payload,
                route_input,
                "mechanical",
                tier("model_routing.tier_haiku"),
                "down",
            ));
        }
        if research_exempt {
            return Some(routed(
                tip(one_pass("model_routing.msg_row1_research_what", &[("model", &model)]), "", ""),
                payload,
                route_input,
                "research",
                &model,
                "exempt",
            ));
        }
        if consult_model_routing_jev(corpus, payload, &st, env, jev) {
            return Some(routed(
                tip(one_pass("model_routing.msg_row1_jev_what", &[("model", &model)]), defaults::text("model_routing.msg_row1_jev_instead"), ""),
                payload,
                route_input,
                "mechanical",
                tier("model_routing.tier_haiku"),
                "exempt",
            ));
        }
        return Some(routed(block(reason), payload, route_input, "mechanical", tier("model_routing.tier_haiku"), "down"));
    }

    if is_mechanical_only && model_omitted && is_generic {
        if strict {
            if consult_model_routing_jev(corpus, payload, &st, env, jev) {
                return Some(routed(
                    tip(defaults::text("model_routing.msg_row2_jev_what").to_string(), defaults::text("model_routing.msg_row2_jev_instead"), ""),
                    payload,
                    route_input,
                    "mechanical",
                    tier("model_routing.tier_haiku"),
                    "exempt",
                ));
            }
            return Some(routed(
                block(block_msg(
                    defaults::text("model_routing.msg_row2_block_what").to_string(),
                    defaults::text("model_routing.msg_row2_block_why"),
                    defaults::text("model_routing.msg_row2_block_instead"),
                    defaults::text("model_routing.msg_row2_block_override"),
                )),
                payload,
                route_input,
                "mechanical",
                tier("model_routing.tier_haiku"),
                "down",
            ));
        }
        return Some(routed(
            tip(
                defaults::text("model_routing.msg_row2_adv_what").to_string(),
                defaults::text("model_routing.msg_row2_adv_instead"),
                defaults::text("model_routing.msg_row2_adv_why"),
            ),
            payload,
            route_input,
            "mechanical",
            tier("model_routing.tier_haiku"),
            "down",
        ));
    }

    if !suppress_haiku_rows && is_mechanical_only && !model_omitted && is_flagship && is_custom {
        return Some(routed(
            tip(
                one_pass("model_routing.msg_row3_what", &[("model", &model), ("subagent_type", &subagent_type)]),
                defaults::text("model_routing.msg_row3_instead"),
                "",
            ),
            payload,
            route_input,
            "mechanical",
            tier("model_routing.tier_haiku"),
            "down",
        ));
    }

    let stripped = strip_code_spans(corpus);
    if model == tier("model_routing.tier_haiku") && !read_only_mechanical(corpus) && pats().planning_intent.is_match(&stripped) {
        return Some(routed(
            tip(defaults::text("model_routing.msg_row4_what").to_string(), defaults::text("model_routing.msg_row4_instead"), ""),
            payload,
            route_input,
            "planning",
            tier("model_routing.tier_opus"),
            "up",
        ));
    }

    let write_shaped = pats().write_phrase.is_match(corpus)
        || (!pats().readonly_override.is_match(corpus) && (pats().write.is_match(corpus) || pats().write_imperative.is_match(corpus)));
    if is_generic && pats().research.is_match(corpus) && !write_shaped {
        return Some(routed(
            tip(
                defaults::text("model_routing.msg_row6_what").to_string(),
                defaults::text("model_routing.msg_row6_instead"),
                defaults::text("model_routing.msg_row6_why"),
            ),
            payload,
            route_input,
            "research",
            defaults::text("model_routing.explore_type"),
            "exempt",
        ));
    }

    Some(routed(Verdict::Allow, payload, route_input, "unknown", if model_omitted { tier("model_routing.tier_inherit") } else { &model }, "allow"))
}

#[cfg(test)]
fn decide(payload: &Value, env: &RequestEnv) -> Option<Verdict> {
    match std::panic::catch_unwind(|| decide_inner(payload, env, None)) {
        Ok(v) => v,
        Err(_) => Some(fail_closed()),
    }
}

impl Check for ModelRouting {
    fn name(&self) -> &'static str {
        "model-routing"
    }

    fn summary(&self) -> &'static str {
        defaults::text("model_routing.summary")
    }

    fn run(&self, _subject: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        None
    }

    fn run_env(&self, subject: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        match std::panic::catch_unwind(|| decide_inner(payload, env, subject.tool)) {
            Ok(v) => v,
            Err(_) => Some(fail_closed()),
        }
    }
}
