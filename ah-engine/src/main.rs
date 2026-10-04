//! `engine serve` = daemon, `engine hook [--fallback <hook.js>]` = hook client (hook JSON on stdin),
//! `engine ctl ping|reload|stop|status`, `engine status`, `engine reset`, `engine proj <cwd> <verb> [args]`.
use ah_engine::{client, daemon, health};

fn main() {
    std::panic::set_hook(Box::new(|_| {})); // a panic must never reach the host's stderr
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") => daemon::serve(),
        Some("hook") => std::process::exit(client::hook_main(&args[2..])),
        Some("ctl") => match client::ctl(args.get(2).map(String::as_str).unwrap_or("ping")) {
            Some(r) => println!("{r}"),
            None => {
                eprintln!("no daemon");
                std::process::exit(1);
            }
        },
        Some("status") => println!("{}", client::status()),
        Some("reset") => health::reset(),
        Some("proj") => match client::proj(
            args.get(2).map(String::as_str).unwrap_or(""),
            args.get(3).map(String::as_str).unwrap_or(""),
            &args[4.min(args.len())..].join(" "),
        ) {
            Some(r) => println!("{r}"),
            None => std::process::exit(1),
        },
        Some("check") => std::process::exit(ah_engine::checks::cli_main(args.get(2).map(String::as_str).unwrap_or(""))),
        Some("version") => println!("{}", ah_engine::version()),
        _ => eprintln!("usage: engine serve|hook [--fallback <hook.js>]|ctl <ping|reload|stop|status>|status|reset|proj <cwd> <verb> [args]|version"),
    }
}
