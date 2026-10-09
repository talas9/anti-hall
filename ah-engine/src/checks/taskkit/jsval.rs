//! JavaScript value semantics over `serde_json::Value`, for the places the Node hooks read an arbitrary JSON field with
//! `||`, `!= null`, `String(x)` or `Number(x)`. A conversion that would differ between JavaScript and this code, or that
//! throws in JavaScript, returns [`Unsure`]: the caller defers the whole call to the Node hook (D74).
use crate::checks::guardkit::text::js_trim;
use serde_json::Value;

/// The input cannot be judged exactly; the Node hook decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsure;

/// `Result` with [`Unsure`] as the error.
pub type R<T> = Result<T, Unsure>;

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `obj[key]`: `None` when `v` is not an object or the key is absent (JavaScript's `undefined`). A JSON `null` is
/// `Some(Value::Null)`, which is not `undefined`.
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(key))
}

/// `v != null` for an optional (possibly undefined) field.
pub fn not_nullish(v: Option<&Value>) -> bool {
    v.is_some_and(|x| !x.is_null())
}

/// `a || b || c ...`: the first truthy operand, else the last one.
pub fn first_truthy<'a>(ops: &[Option<&'a Value>]) -> Option<&'a Value> {
    for o in ops {
        if o.is_some_and(truthy) {
            return *o;
        }
    }
    ops.last().copied().flatten()
}

/// `String(v)` for a string, a boolean or a number JavaScript prints the same way; anything else is [`Unsure`].
pub fn scalar_string(v: &Value) -> R<String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Number(_) | Value::Null => super::js_string(v).ok_or(Unsure),
        _ => Err(Unsure),
    }
}

/// `Number(text)` for a string, as JavaScript's `Number` converts it (`NaN` when it is not a number).
pub fn number_of_str(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, r: u32| -> f64 {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        digits.chars().fold(0.0, |acc, c| acc * r as f64 + c.to_digit(r).unwrap_or(0) as f64)
    };
    for (p, r) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(d) = t.strip_prefix(p) {
            return radix(d, r);
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // StringNumericLiteral: optional sign, digits with an optional fraction and exponent; Rust's parser also takes `inf`,
    // `nan` and `infinity`, which are not numbers in JavaScript.
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if !body.chars().next().is_some_and(|c| c.is_ascii_digit() || c == '.')
        || body.chars().any(|c| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}
