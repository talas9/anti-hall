//! ah-hook: the thin hook launcher in front of `ah-engine hook --event <Event>`, and the thin client of every engine command
//! (`ah-hook <verb> [args...]` runs `ah-engine <verb> [args...]`, see `cli.rs`).
//!
//! The bootloader and front door of every hook call, so it is held to a stricter standard than the engine:
//! - it never panics out: `catch_unwind` around everything, every Result handled; an internal failure lets the hook through
//!   (exit 0, empty stdout, at most one stderr line) except where the hook contract requires a block;
//! - every step has a timeout and the call has a wall-clock backstop; a transient start failure is retried (never after the
//!   engine has started); the payload is streamed through a fixed buffer, only a bounded prefix is ever held;
//! - it limits itself: heap, CPU, wall time, stdin size, spawn rate, log size (soft = warn + count, hard = enforce, fail open);
//! - a SIGKILLed launcher does not leave a hung engine behind (see `proc::Reaper`).
//!
//! Every number, name and text is read from the plugin's `engine/defaults/*.toml`; `builtin.rs` is the one justified constant
//! set, used only when those files are missing or invalid.

mod blog;
mod builtin;
mod cfg;
mod cli;
mod doctor;
mod gate;
mod install;
mod integrity;
mod rec;
mod launcher;
mod limits;
mod nodeback;
mod proc;
mod selftest;
mod update;
mod util;

use std::io::Write;

#[global_allocator]
static ALLOC: limits::Counting = limits::Counting;

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    launcher::install_signal_thread();
    let code = match std::panic::catch_unwind(launcher::run) {
        Ok(c) => c,
        Err(_) => {
            launcher::internal("panic");
            0
        }
    };
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}
