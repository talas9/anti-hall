//! Times the host functions a check calls, by kind (`spans.kinds`), for the per-request spans (task #595, [`crate::obs::spans`]).
//!
//! After every `ahHost` function is installed, each one whose name has a `spans.kind_prefixes` match is replaced by a thin wrapper that
//! calls the original with the same arguments and, only while a recorded request's check is running, books the elapsed time to its
//! kind. A function no prefix matches is left alone (pure helpers cost nothing); with `spans.enabled = 0` at install nothing is
//! wrapped.
use crate::defaults;
use crate::obs::spans;
use rquickjs::function::Rest;
use rquickjs::{Ctx, Function, Object, Value};
use std::time::Instant;

/// Replace `ahHost[name]` by a timing wrapper. The original moves to the `spans.raw_global` object, which the wrapper looks up by
/// name at each call: a closure that held the original itself would hold a script value the interpreter cannot see, and the
/// runtime would refuse to shut down with it alive.
fn wrap<'js>(c: &Ctx<'js>, h: &Object<'js>, raw: &Object<'js>, raw_global: &'static str, name: &str, kind: u8) -> rquickjs::Result<()> {
    let orig: Value<'js> = h.get(name)?;
    raw.set(name, orig)?;
    let key = name.to_string();
    let w = Function::new(c.clone(), move |ctx: Ctx<'js>, args: Rest<Value<'js>>| -> rquickjs::Result<Value<'js>> {
        let f: Function<'js> = ctx.globals().get::<_, Object<'js>>(raw_global)?.get(key.as_str())?;
        if !spans::timing() {
            return f.call((args,));
        }
        let t = Instant::now();
        let r = f.call((args,));
        spans::note_host(kind, t.elapsed().as_micros() as u64);
        r
    })?;
    h.set(name, w)
}

/// Wrap the timed functions of `h`.
pub fn install<'js>(c: &Ctx<'js>, h: &Object<'js>) -> rquickjs::Result<()> {
    if defaults::num("spans.enabled") != 1 {
        return Ok(());
    }
    let raw_global = defaults::text("spans.raw_global");
    let raw = Object::new(c.clone())?;
    let names: Vec<String> = h.keys::<String>().filter_map(Result::ok).collect();
    for name in names {
        let Some(kind) = spans::kind_of(&name) else { continue };
        if h.get::<_, Value>(name.as_str())?.is_function() {
            wrap(c, h, &raw, raw_global, &name, kind)?;
        }
    }
    c.globals().set(raw_global, raw)
}
