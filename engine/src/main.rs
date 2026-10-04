//! `engine serve` = daemon, `engine hook` = hook client (reads the hook JSON on stdin),
//! `engine ctl ping|reload|stop` = control.
use engine::{client, daemon};

fn main() {
    std::panic::set_hook(Box::new(|_| {})); // a panic must never reach the host's stderr
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") => daemon::serve(),
        Some("hook") => std::process::exit(client::hook_main()),
        Some("ctl") => match client::ctl(args.get(2).map(String::as_str).unwrap_or("ping")) {
            Some(r) => println!("{r}"),
            None => {
                eprintln!("no daemon");
                std::process::exit(1);
            }
        },
        Some("version") => println!("{}", engine::version()),
        _ => eprintln!("usage: engine serve|hook|ctl <ping|reload|stop>|version"),
    }
}
