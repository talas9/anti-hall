//! A template in `engine/defaults` that is compared byte for byte with a shipped Node file must equal what that file
//! generates today. Drift made every DevSwarm role and read-side case defer once (the mesh route shim changed the launcher
//! and the template was not regenerated), so each such copy is generated here from the shipped source and compared.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::path::Path;
use std::process::Command;

fn plugin() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

fn node_eval(script: &str) -> String {
    let o = Command::new("node").arg("-e").arg(script).arg(plugin()).output().expect("node runs");
    assert!(o.status.success(), "node failed: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8(o.stdout).unwrap()
}

#[test]
fn the_launcher_template_equals_what_stable_launcher_generates() {
    let generated = node_eval(
        r#"const s=require(process.argv[1]+'/hooks/lib/stable-launcher.js');process.stdout.write(s.buildLauncherSource(['SEGMENTSX','devswarm.js'],'FALLBACKX'))"#,
    );
    let want = generated.replace("[\"SEGMENTSX\",\"devswarm.js\"]", "{segments}").replace("\"FALLBACKX\"", "{fallback}");
    assert_eq!(
        ah_engine::defaults::text("devswarm_role.launcher_src"),
        want,
        "devswarm_role.launcher_src is out of date: regenerate it from hooks/lib/stable-launcher.js (defaults/ and defaults.pristine/)"
    );
}
