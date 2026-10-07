
#[test]
fn probe_surrogate() {
    let r = super::jval::parse("{\"x\":\"\\ud800\"}");
    eprintln!("{r:?}");
    let e = serde_json::from_str::<serde_json::Value>("{\"x\":\"\\ud800\"}").unwrap_err();
    eprintln!("{e}");
}
