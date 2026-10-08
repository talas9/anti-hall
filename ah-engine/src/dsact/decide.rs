//! The bridge to the decision script (`engine/logic/act/devswarm-act.js`, D88): payload in, decision out. The script returns its
//! answer as the JSON text of an `exact` verdict. A missing script, an exception or an answer of the wrong shape is an `Err`,
//! and the caller treats it as "do not act".
use crate::checks::Verdict;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// Decide one action. `home` selects the owner override directory of the script.
pub fn decide(home: &str, payload: &Value) -> Result<Value, String> {
    let env = RequestEnv::from_pairs([(defaults::env_name("home"), home)]);
    let name = defaults::text("devswarm_act.script_name");
    match crate::script::run_forced(name, payload, &Value::Null, defaults::text("devswarm_act.script_event"), &env) {
        None => Err(defaults::text("devswarm_act.msg_no_script").to_string()),
        Some(Some(Verdict::Exact(x))) => serde_json::from_str(&x.out).map_err(|e| e.to_string()),
        Some(_) => Err(defaults::text("devswarm_act.msg_no_script").to_string()),
    }
}
