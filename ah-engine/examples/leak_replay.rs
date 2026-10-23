//! Runs the leak sentinel's evaluator by hand on recorded samples and prints what it says.
//! `cargo run --example leak_replay -- long <long.ndjson> | sample <sample-*.json>... | synth <mb_per_h> <hours>`
//! Optional env `LEAK_WINDOW_S` shortens the window for a short recording.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a measurement tool: a panic is the report
use ah_engine::mem::leak::{HolderReading, Params, Sample, evaluate};
use serde_json::Value;

fn hms(t: &str) -> u64 {
    let p: Vec<u64> = t.split(':').map(|x| x.parse().unwrap()).collect();
    p[0] * 3600 + p[1] * 60 + p[2]
}

fn main() {
    ah_engine::defaults::init().expect("defaults");
    let a: Vec<String> = std::env::args().skip(1).collect();
    let mut ring: Vec<Sample> = Vec::new();
    match a[0].as_str() {
        "long" => {
            for l in std::fs::read_to_string(&a[1]).unwrap().lines() {
                let d: Value = serde_json::from_str(l).unwrap();
                let holders = d["ledger"]["heap"]["holders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|h| HolderReading {
                        name: h["name"].as_str().unwrap().into(),
                        bytes: h["bytes"].as_u64().unwrap(),
                        soft: h["soft"].as_u64().unwrap_or(0),
                    })
                    .collect();
                ring.push(Sample {
                    t_s: hms(d["t"].as_str().unwrap()),
                    footprint: d["footprint_kb"].as_u64().unwrap() * 1024,
                    heap: d["ledger"]["heap"]["allocated"].as_u64().unwrap(),
                    holders,
                });
            }
        }
        "sample" => {
            for f in &a[1..] {
                let d: Value = serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap();
                if d.get("t").is_none() {
                    continue; // sample-0 has the other (snapshot) shape
                }
                let holders =
                    d["holders"].as_object().unwrap().iter().map(|(k, v)| HolderReading { name: k.clone(), bytes: v.as_u64().unwrap(), soft: 0 }).collect();
                ring.push(Sample {
                    t_s: d["t"].as_u64().unwrap(),
                    footprint: d["footprint_kb"].as_u64().unwrap() * 1024,
                    heap: d["heap_live_kb"].as_u64().unwrap() * 1024,
                    holders,
                });
            }
        }
        _ => {
            let (rate, hours): (f64, f64) = (a[1].parse().unwrap(), a[2].parse().unwrap());
            let n = (hours * 60.0) as u64;
            for i in 0..=n {
                let step = if a[0] == "step" && i > n / 2 { rate } else { 0.0 };
                let mb = 90.0 + step + if a[0] == "step" { 0.0 } else { rate * i as f64 / 60.0 } + if i % 7 == 0 { 3.0 } else { -1.0 }; // a little noise
                ring.push(Sample {
                    t_s: 1_000_000 + i * 60,
                    footprint: (mb * 1_048_576.0) as u64,
                    heap: ((mb - 20.0) * 1_048_576.0) as u64,
                    holders: vec![
                        HolderReading { name: "grower".into(), bytes: ((mb - 60.0) * 1_048_576.0) as u64, soft: 0 },
                        HolderReading { name: "flat".into(), bytes: 5_000_000, soft: 0 },
                    ],
                });
            }
        }
    }
    let mut p = Params::from_defaults();
    if let Some(w) = std::env::var("LEAK_WINDOW_S").ok().and_then(|w| w.parse().ok()) {
        p.window_s = w;
    }
    let refs: Vec<&Sample> = ring.iter().collect();
    let now = ring.last().unwrap().t_s;
    println!("samples={} span_s={} window_s={}", ring.len(), now - ring[0].t_s, p.window_s);
    println!("{}", serde_json::to_string_pretty(&evaluate(&refs, now, &p).to_json()).unwrap());
}
