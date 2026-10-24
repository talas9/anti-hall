//! The compatibility contract of this build: the lowest engine version the dashboard works with. A mismatch is shown on the Updates
//! page and never stops the dashboard.

/// The lowest engine version this dashboard works with.
pub const ENGINE_MIN: &str = "0.2.0";

/// The sentence for an engine older than `ENGINE_MIN` (`template` is `web.compat_msg`), or `None` when it is new enough or unknown.
pub fn engine_problem(template: &str, engine_version: &str) -> Option<String> {
    if engine_version.is_empty()
        || crate::ops::version_nums(engine_version) >= crate::ops::version_nums(ENGINE_MIN)
    {
        return None;
    }
    Some(
        template
            .replace("{web_version}", env!("AH_BUILD_VERSION"))
            .replace("{required}", ENGINE_MIN)
            .replace("{actual}", engine_version),
    )
}
