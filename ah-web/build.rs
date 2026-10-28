//! Derives the build version (`AH_BUILD_VERSION`) the binary reports; the logic is shared with ah-engine.
#[path = "../ah-engine/build_support/buildver.rs"]
mod buildver;

fn main() {
    println!("cargo:rerun-if-changed=src");
    buildver::emit();
}
