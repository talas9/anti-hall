//! The build version every binary of this repo reports: `<crate version>+<branch>.<short sha>[-dirty]` (each component carries its own version), derived at build time and
//! handed to the crate as the `AH_BUILD_VERSION` compile-time variable. Shared by the build scripts of ah-engine, ah-launcher and ah-web
//! (each includes this file with `#[path]`). It is a build fact, not configuration: no tunable or message of the running program comes
//! from here. Without a git checkout (a tarball build) it is the crate's own version alone.
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(repo).args(args).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

fn sanitize(branch: &str) -> String {
    branch.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').to_string()
}

/// Print the cargo directives that set `AH_BUILD_VERSION` and re-run the script when the checkout moves.
pub fn emit() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let pkg = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    let repo = manifest.ancestors().find(|d| d.join("plugins/anti-hall/.claude-plugin/plugin.json").is_file()).map(Path::to_path_buf);
    let base = pkg;
    let version = match repo.as_ref().and_then(|r| {
        let sha = git(r, &["rev-parse", "--short=8", "HEAD"])?;
        let branch = git(r, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|b| sanitize(&b)).filter(|b| !b.is_empty() && b != "HEAD");
        // tracked source changes only: the compiled UI bundle and cargo's target dirs are tracked here and change on every build
        let dirty = git(
            r,
            &[
                "status",
                "--porcelain",
                "--untracked-files=no",
                "--",
                "ah-engine",
                "ah-launcher",
                "ah-web",
                "plugins/anti-hall",
                ":(exclude)*/target",
                ":(exclude)ah-web/ui-dist",
                ":(exclude)ah-web/ui/target",
            ],
        )
        .is_some();
        // a commit moves the branch's ref file, a checkout moves HEAD: either changes the version
        let mut watch = vec!["HEAD".to_string()];
        watch.extend(git(r, &["symbolic-ref", "-q", "HEAD"]));
        for w in watch {
            if let Some(path) = git(r, &["rev-parse", "--git-path", &w]) {
                let path = if Path::new(&path).is_absolute() { PathBuf::from(path) } else { r.join(path) };
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
        Some(format!("{}{sha}{}", branch.map(|b| format!("{b}.")).unwrap_or_default(), if dirty { "-dirty" } else { "" }))
    }) {
        Some(tail) => format!("{base}+{tail}"),
        None => base,
    };
    println!("cargo:rustc-env=AH_BUILD_VERSION={version}");
}
