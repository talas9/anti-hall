# rust-engine prototype (throwaway, std-only, no crates)

- `src/main.rs` (146 lines): one binary. `engine serve` = daemon, `engine hook` = hook client.
- `rules.txt`: sample rules, `tool<TAB>deny|warn<TAB>substring-or-*glob<TAB>message`.
- `base.js`: node baseline doing the same check, for comparison.
- `wall.zsh`: wall-time benchmark (30 runs, median).

## Run
    cargo build --release
    # unix socket paths max ~104 bytes on macOS, so use a short HOME (symlink is fine)
    mkdir -p home/.anti-hall-proto && cp rules.txt home/.anti-hall-proto/
    ln -sfn "$PWD/home" /tmp/ahp-home; export HOME=/tmp/ahp-home
    echo '{"tool_name":"Bash","tool_input":{"command":"git push --force x"}}' | target/release/engine hook
    # (daemon auto-starts); after editing rules:  echo RELOAD | nc -U $HOME/.anti-hall-proto/engine.sock   (or kill -HUP <pid>)

Protocol (line based): CHECK <tool> <cmd> | REGISTER <id> <role> <path> | SEND <id> <text> | POLL <id> | RELOAD

## Measurements (macOS, brew rust 1.99, release build)
| | Rust client | node baseline |
|---|---|---|
| peak RSS per call (median of 10) | 1.6 MB | 46 MB |
| CPU per call | ~0.00 s | 0.01 s |
| wall per call (median of 30, daemon warm) | 2.8 ms | 19.6 ms |

Binary 372 KB; daemon RSS 1.68 MB idle, 1.71 MB after 1000 CHECKs.
Rule reload (RELOAD / SIGHUP) and the per-session mailbox verified manually.
