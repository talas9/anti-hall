//! `ah-engine`: the resident hook daemon and its client and agent-facing commands (see `ah-engine docs` for the
//! generated list). All behaviour lives in the library; this file only starts it.
use ah_engine::cli;

fn main() {
    std::panic::set_hook(Box::new(|_| {})); // a panic must never reach the host's stderr
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(cli::run(&args));
}
