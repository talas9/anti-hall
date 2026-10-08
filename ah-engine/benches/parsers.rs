//! Benchmarks for the pattern matcher and the shell tokenizers (`cargo bench --bench parsers`). The `**/**/**` groups
//! are the worst case for a backtracking glob: time must stay flat-linear in the text length.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::checks::command::shell;
use ah_engine::hookcfg::when::glob_match;
use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use std::hint::black_box;

fn glob(c: &mut Criterion) {
    let mut g = c.benchmark_group("glob_match");
    g.bench_function("typical_hit", |b| b.iter(|| glob_match(black_box("src/**/*.rs"), black_box("src/checks/git/tokenize.rs"))));
    g.bench_function("typical_miss", |b| b.iter(|| glob_match(black_box("src/**/*.rs"), black_box("src/checks/git/tokenize.js"))));
    // Worst cases for a backtracking matcher: `reps` wildcard-then-literal units against a text that cannot match.
    // The old recursive matcher was O(text^reps) here; the matcher must stay linear in text length.
    for reps in [2usize, 4, 5] {
        for (name, unit) in [("star_a", "*a"), ("dstar_a", "**a"), ("dstar_slash_a", "**/a")] {
            let pat = unit.repeat(reps) + "b";
            let text = "a".repeat(40);
            g.bench_with_input(BenchmarkId::new(name, reps), &(pat, text), |b, (p, t)| b.iter(|| glob_match(black_box(p), black_box(t))));
        }
    }
    for len in [40usize, 400, 4000] {
        let pat = "**a".repeat(8) + "b";
        let text = "a".repeat(len);
        g.bench_with_input(BenchmarkId::new("dstar_a_x8_text_len", len), &(pat, text), |b, (p, t)| b.iter(|| glob_match(black_box(p), black_box(t))));
    }
    g.finish();
}

fn tokenizers(c: &mut Criterion) {
    let small = "git -C /repo commit -m 'fix: thing' && git push origin main | tee out.log";
    let heredoc = "cat <<'EOF' > notes.md\nline one\nline two with $(not run)\nEOF\ngit add notes.md && git commit -F notes.md";
    let big = format!("{small} ; {heredoc}\n").repeat(40);
    let mut g = c.benchmark_group("tokenize");
    for (name, text) in [("small", small.to_string()), ("heredoc", heredoc.to_string()), ("big", big)] {
        g.bench_with_input(BenchmarkId::new("shell_split_detailed", name), &text, |b, t| b.iter(|| shell::split_detailed(black_box(t))));
        g.bench_with_input(BenchmarkId::new("shell_heredoc_bodies", name), &text, |b, t| b.iter(|| shell::heredoc_bodies_in(black_box(t))));
    }
    g.finish();
}

criterion_group!(benches, glob, tokenizers);
criterion_main!(benches);
