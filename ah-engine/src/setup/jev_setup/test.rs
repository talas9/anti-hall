//! `jev-setup test`: one real gateway call per configured transport, each on its own (a working fallback never masks a broken
//! primary or the reverse; no breaker, no retry). The question, the text and every line are in `operator_cli.toml`.
use super::{Ctx, SetupError, resolve_fallback, resolve_settings};
use crate::defaults;
use crate::jev::breaker::SystemClock;
use crate::jev::client::JevClient;
use crate::jev::error::Reason;
use crate::jev::question::Question;
use crate::jev::settings::{JevSettings, Vendor};
use crate::jev::transport::HttpTransport;
use crate::setup::jsfmt::to_fixed2;
use crate::setup::out;
use std::sync::Arc;

/// The settings of one pinned call: only `vendor` is tried, as the primary (the vendor-less test endpoint) or as the backup.
fn pinned(s: &JevSettings, vendor: Vendor, as_fallback: bool) -> JevSettings {
    let mut p = s.clone();
    p.transport = vendor;
    p.fallback = None;
    if as_fallback {
        p.endpoint_override = None;
    }
    p
}

pub(super) fn cmd_test(cx: &mut Ctx) -> Result<(), SetupError> {
    let s = resolve_settings(cx);
    if !s.enabled {
        cx.fail(defaults::text("opcli.test_not_enabled"));
        return Ok(());
    }
    let primary = s.transport;
    let fallback = resolve_fallback(&s, primary);
    let q = defaults::raw("opcli.test_question");
    let question = Question::noul(q.str_field("instructions"), q.str_field("when_true"), q.str_field("when_false"));
    let state = defaults::text("opcli.test_state");
    let client = JevClient::new(Arc::new(HttpTransport::new()), Arc::new(SystemClock));

    let mut targets = vec![(defaults::text("opcli.test_label_primary"), pinned(&s, primary, false), primary)];
    if let Some(f) = fallback {
        targets.push((defaults::text("opcli.test_label_fallback"), pinned(&s, f, true), f));
    }
    let many = targets.len() > 1;
    let rejected = regex::Regex::new(defaults::text("opcli.test_rejected_re")).ok();
    for (label, settings, vendor) in targets {
        let r = client.decide(&settings, &question, state, None);
        let transport = vendor.as_str();
        let tag = if many {
            defaults::render("opcli.test_tag_two", &[("label", &label), ("transport", &transport)])
        } else {
            defaults::render("opcli.test_tag_one", &[("transport", &transport)])
        };
        if r.ok() {
            out(&defaults::render("opcli.test_ok", &[("ms", &r.ms), ("confidence", &to_fixed2(r.confidence)), ("tag", &tag)]))?;
            continue;
        }
        let reason = r.reason.unwrap_or(Reason::Error);
        let text = reason.to_string();
        out(&defaults::render("opcli.test_failed", &[("reason", &text), ("tag", &tag)]))?;
        if reason == Reason::NoKey {
            out(defaults::text("setup.msg_no_key_notice"))?;
        } else if rejected.as_ref().is_some_and(|re| re.is_match(&text)) {
            out(defaults::text("opcli.test_rejected_hint"))?;
        }
        cx.code = 1;
    }
    Ok(())
}
