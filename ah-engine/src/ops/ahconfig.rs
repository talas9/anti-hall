//! `ah-engine auto-handover-config`: get and set the auto-handover trigger's persisted settings (section `autoHandover` of
//! `~/.anti-hall/settings.json`). Port of `scripts/auto-handover-config.js`. The command reads the settings the way the store
//! answers them (environment, file, plugin option, default) and asks the rules script (`rules/operator-cli.js`, `ahConfigRun`)
//! what to print and which settings changed; the settings store (the one the `settings` verb writes) applies the changes, one
//! key at a time, atomically.
use super::{env_snapshot, err, home, opcli_call, opcli_cfg, out, plugin_root};
use crate::checks::jsport::json::{self, J, stringify};
use crate::cli::Parsed;
use crate::defaults;
use crate::migrate::settings as store;
use crate::migrate::{Ctx, plugin_version};
use serde_json::{Value, json};

fn parse_j(text: &str) -> Option<J> {
    json::parse(text, defaults::num("setup.json_max_depth") as usize).ok()
}

fn to_value(j: &J) -> Value {
    serde_json::from_str(&stringify(j)).unwrap_or(Value::Null)
}

pub(crate) fn run(p: &Parsed) -> i32 {
    let env = env_snapshot();
    let home = home(&env);
    let root = plugin_root(&env);
    let mut ctx = Ctx::new(home, String::new(), env.clone(), false, None, root.clone());
    ctx.version = root.as_deref().and_then(|r| plugin_version(&ctx, r));
    let section = defaults::text("opcli.ahc_section");

    // the settings as the store answers them; the schema's default stands in for a key the store does not list
    let mut values = serde_json::Map::new();
    for item in defaults::list("opcli.ahc_current") {
        let Some((name, dflt_text)) = item.split_once(':') else { continue };
        let dflt = parse_j(dflt_text).unwrap_or(J::Null);
        let v = store::find(section, name).and_then(|e| store::get(&ctx, e, Some(&dflt))).unwrap_or(dflt);
        values.insert(name.to_string(), to_value(&v));
    }
    let raw = match store::load(&ctx).get(section) {
        Some(s @ (J::Obj(_) | J::Arr(_))) => stringify(s),
        _ => "{}".to_string(),
    };
    let input = json!({
        "argv": p.raw, "values": Value::Object(values), "rawText": raw,
        "envPct": env.get(defaults::text("opcli.ahc_env_pct")), "cfg": opcli_cfg(),
    });
    let Some(r) = opcli_call("auto-handover-config", defaults::text("opcli.rules_script"), "ahConfigRun", &input) else {
        return defaults::num("opcli.fail_exit") as i32;
    };
    // the changed settings, one at a time (a refused value is not an error here, as in Node)
    for w in r.get("writes").and_then(Value::as_array).into_iter().flatten() {
        let (Some(key), Some(value)) = (w.get("key").and_then(Value::as_str), w.get("value").and_then(|v| parse_j(&v.to_string()))) else { continue };
        store::set(&ctx, section, key, &value, None, false);
    }
    let lines = |k: &str| -> Vec<String> { r.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect() };
    for l in lines("out") {
        out(&(l + "\n"));
    }
    for l in lines("err") {
        err(&(l + "\n"));
    }
    r.get("exit").and_then(Value::as_i64).unwrap_or(0) as i32
}
