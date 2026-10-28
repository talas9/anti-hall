//! The compatibility contract of this build: the lowest engine version the launcher works with. It travels to the engine with each
//! request (`env.hook_engine_min`), which checks it against its own version and reports a mismatch in `status`, never blocking a hook.

/// The lowest engine version this launcher works with.
pub const ENGINE_MIN: &str = "0.2.0";

/// Numbers of a dotted version without the `v`, build metadata (`+branch.sha`) or pre-release tail; stops at the first non-number.
pub fn nums(v: &str) -> Vec<u64> {
    v.split(char::is_whitespace)
        .next()
        .unwrap_or("")
        .trim_start_matches('v')
        .split(['+', '-'])
        .next()
        .unwrap_or("")
        .split('.')
        .map_while(|p| p.parse().ok())
        .collect()
}

/// Compare two COMPONENT versions (engine, hook client, web server) by their numbers, except that a version at or above `floor`
/// (`launcher.legacy_scheme_floor`: the old numbering where components carried the plugin's number) is older than any below it.
/// `None` when either side has no number. The ONE comparison of this crate; plugin versions do not go through it.
pub fn component_cmp(floor: &str, a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (mut x, mut y, f) = (nums(a), nums(b), nums(floor));
    if x.is_empty() || y.is_empty() {
        return None;
    }
    let legacy = |v: &mut Vec<u64>| {
        let n = v.len().max(f.len());
        v.resize(n, 0);
        let mut ff = f.clone();
        ff.resize(n, 0);
        !f.is_empty() && *v >= ff
    };
    let (lx, ly) = (legacy(&mut x), legacy(&mut y));
    if lx != ly {
        return Some(if lx {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        });
    }
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    Some(x.cmp(&y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;
    #[test]
    fn old_numbering_is_older_than_component_versions() {
        assert_eq!(
            component_cmp("0.300.0", "0.301.1+b.abc", "0.2.0"),
            Some(Less)
        );
        assert_eq!(component_cmp("0.300.0", "0.2.0", "0.1.0"), Some(Greater));
        assert_eq!(
            component_cmp("0.300.0", "0.301.2", "0.301.1"),
            Some(Greater)
        );
        assert_eq!(component_cmp("", "0.301.1", "0.2.0"), Some(Greater));
        assert_eq!(component_cmp("0.300.0", "x", "0.2.0"), None);
    }
}
