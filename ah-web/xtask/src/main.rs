//! `cargo run --release --manifest-path ah-web/xtask/Cargo.toml -- ui [--out <dir>] [--only lite|full]`
//!
//! Builds the page (`ah-web/ui`) once per tier and runs wasm-bindgen on each result, so there is no shell step and no separate
//! wasm-bindgen install: the tool is a crate. Lite is the page without the `full` feature (no wgpu in the binary); Full has it.
//! The output goes to `<out>/lite` and `<out>/full` (default: `plugins/anti-hall/web/pkg`), the directory `web.pkg_dir` names.
//! Run it under your slot's cargo lock; `CARGO_TARGET_DIR` is honoured.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn main() {
    if let Err(e) = run() {
        eprintln!("xtask: {e}");
        std::process::exit(1);
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("ui") {
        return Err("usage: xtask ui [--out <dir>] [--only lite|full]".into());
    }
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ui = here.join("../ui/Cargo.toml");
    let out = arg(&args, "--out").map(PathBuf::from).unwrap_or_else(|| here.join("../../plugins/anti-hall/web/pkg"));
    let only = arg(&args, "--only");
    for (tier, features) in [("lite", None), ("full", Some("full"))] {
        if only.as_deref().is_some_and(|o| o != tier) {
            continue;
        }
        let wasm = build(&ui, features)?;
        let dir = out.join(tier);
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        wasm_bindgen_cli_support::Bindgen::new()
            .input_path(&wasm)
            .web(true)
            .map_err(|e| e.to_string())?
            .typescript(false)
            .out_name("ah_web_ui")
            .generate(&dir)
            .map_err(|e| e.to_string())?;
        let size = |f: &str| std::fs::metadata(dir.join(f)).map(|m| m.len()).unwrap_or(0);
        println!("{tier}: {} ({} bytes wasm, {} bytes glue)", dir.display(), size("ah_web_ui_bg.wasm"), size("ah_web_ui.js"));
    }
    Ok(())
}

/// `cargo build --release` of the page for wasm32, returning the wasm file cargo reports (not a guessed path).
fn build(manifest: &Path, features: Option<&str>) -> Result<PathBuf, String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut cmd = Command::new(cargo);
    cmd.args(["build", "--release", "--lib", "--target", "wasm32-unknown-unknown", "-j4", "--message-format=json-render-diagnostics", "--manifest-path"]).arg(manifest);
    if let Some(f) = features {
        cmd.args(["--features", f]);
    }
    let output = cmd.stdout(Stdio::piped()).stderr(Stdio::inherit()).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("cargo build failed ({})", output.status));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|m| m["reason"] == "compiler-artifact" && m["target"]["name"] == "ah_web_ui")
        .flat_map(|m| m["filenames"].as_array().cloned().unwrap_or_default())
        .filter_map(|f| f.as_str().map(PathBuf::from))
        .find(|p| p.extension().is_some_and(|e| e == "wasm"))
        .ok_or_else(|| "cargo reported no wasm file".to_string())
}
