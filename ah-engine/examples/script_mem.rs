//! Memory of the scripted checks' interpreter on one thread: loads every check script of the plugin's logic directory once
//! (as one worker thread does over a day) and prints the QuickJS runtime's malloc bytes after each, then the time to build
//! a context. `cargo run --release --example script_mem`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a measurement tool: a panic is the report
use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::time::Instant;

fn main() {
    ah_engine::defaults::init().expect("defaults");
    let home = std::env::temp_dir().join(format!("ah-script-mem-{}", std::process::id()));
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let h = home.to_string_lossy().to_string();
    let env = RequestEnv::from_pairs([("HOME", h.as_str())]);
    let dir = ah_engine::defaults::root().unwrap().join(ah_engine::defaults::text("script.logic_dir"));
    let mut names: Vec<String> =
        std::fs::read_dir(&dir).unwrap().flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".js").map(str::to_string)).collect();
    names.sort();
    {
        let rt = rquickjs::Runtime::new().unwrap();
        let m0 = rt.memory_usage().malloc_size;
        let ctx = rquickjs::Context::full(&rt).unwrap();
        rt.run_gc();
        let m1 = rt.memory_usage().malloc_size;
        ctx.with(|c| ah_engine::script::host::install(&c).unwrap());
        rt.run_gc();
        let m2 = rt.memory_usage().malloc_size;
        let mut libs: Vec<_> = std::fs::read_dir(dir.join("lib")).unwrap().flatten().map(|e| e.path()).collect();
        libs.sort();
        ctx.with(|c| {
            for l in &libs {
                c.eval::<(), _>(std::fs::read_to_string(l).unwrap()).unwrap();
            }
        });
        rt.run_gc();
        let m3 = rt.memory_usage().malloc_size;
        let ctx2 = rquickjs::Context::full(&rt).unwrap();
        rt.run_gc();
        let m4 = rt.memory_usage().malloc_size;
        println!(
            "{{\"runtime_kb\":{},\"context_full_kb\":{},\"host_kb\":{},\"libs_kb\":{},\"second_context_kb\":{}}}",
            m0 / 1024,
            (m1 - m0) / 1024,
            (m2 - m1) / 1024,
            (m3 - m2) / 1024,
            (m4 - m3) / 1024
        );
        drop(ctx2);
        drop(ctx);
    }
    let mut prev = 0i64;
    for n in &names {
        let t = Instant::now();
        let _ = ah_engine::script::run_forced(n, &json!({"hook_event_name": "Notification", "cwd": h}), &json!({}), "Notification", &env);
        let us = t.elapsed().as_micros();
        let (ctxs, sz, cnt, fns, code) = ah_engine::script::pool_usage().unwrap();
        println!(
            "{{\"check\":\"{n}\",\"first_call_us\":{us},\"contexts\":{ctxs},\"malloc_kb\":{},\"delta_kb\":{},\"mallocs\":{cnt},\"funcs\":{fns},\"code_kb\":{}}}",
            sz / 1024,
            (sz - prev) / 1024,
            code / 1024
        );
        prev = sz;
    }
    let t = Instant::now();
    for n in &names {
        let _ = ah_engine::script::run_forced(n, &json!({"hook_event_name": "Notification", "cwd": h}), &json!({}), "Notification", &env);
    }
    println!("{{\"warm_all_us\":{}}}", t.elapsed().as_micros());
    std::fs::remove_dir_all(&home).ok();
}
