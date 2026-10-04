//! The two question shapes Jev answers, and how they are written on the wire.
//!
//! A Noul question is a yes/no with a probability-like answer; a Choice question picks one labelled option. Callers in
//! the Node plugin always build `{type, instructions, criteria}` with string values, and the request body must match
//! what `JSON.stringify` produces for that object byte for byte (D31), so the question is kept as ordered parts and
//! written by hand. JavaScript orders an object's integer-like keys first and ascending (so a Choice whose labels are
//! step numbers goes out `1, 2, 10, a`), then the rest in insertion order; [`js_key_order`] reproduces that.
use super::error::JevError;
use crate::defaults;
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};

/// Which primitive a question uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Yes/no: the answer is a boolean.
    Noul,
    /// Pick one label: the answer is the chosen label.
    Choice,
}

impl Kind {
    /// The wire name of the kind.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Noul => "noul",
            Kind::Choice => "choice",
        }
    }
}

/// A question for Jev.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    /// Noul or Choice.
    pub kind: Kind,
    /// What is being asked.
    pub instructions: String,
    /// The options: for Noul the descriptions of `true` and `false`, for Choice label then description.
    pub criteria: Vec<(String, String)>,
}

/// True when `key` is a canonical array index: what JavaScript sorts to the front of an object's keys.
fn is_array_index(key: &str) -> bool {
    let canonical = key == "0" || (key.as_bytes().first().is_some_and(|b| (b'1'..=b'9').contains(b)) && key.bytes().all(|b| b.is_ascii_digit()));
    canonical && key.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

/// Order `pairs` the way a JavaScript object would enumerate them: integer-like keys ascending, then the others in the
/// order given. A repeated key keeps its first position and takes its last value, as assigning to an object does.
pub fn js_key_order(pairs: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = Vec::with_capacity(pairs.len());
    for (k, v) in pairs {
        match merged.iter_mut().find(|(mk, _)| *mk == k) {
            Some(slot) => slot.1 = v,
            None => merged.push((k, v)),
        }
    }
    let (mut ints, rest): (Vec<_>, Vec<_>) = merged.into_iter().partition(|(k, _)| is_array_index(k));
    ints.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
    ints.extend(rest);
    ints
}

/// A JSON string literal exactly as `JSON.stringify` writes it.
pub(crate) fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| String::from("\"\""))
}

impl Question {
    /// A yes/no question; `when_true` and `when_false` describe the two answers.
    pub fn noul(instructions: &str, when_true: &str, when_false: &str) -> Question {
        Question {
            kind: Kind::Noul,
            instructions: instructions.to_string(),
            criteria: js_key_order(vec![("true".into(), when_true.into()), ("false".into(), when_false.into())]),
        }
    }

    /// A pick-one question over `(label, description)` options.
    pub fn choice(instructions: &str, options: Vec<(String, String)>) -> Question {
        Question { kind: Kind::Choice, instructions: instructions.to_string(), criteria: js_key_order(options) }
    }

    /// Parse the `{type, instructions, criteria}` object a caller supplies, as JSON text so the order of `criteria` (the
    /// order in the text) is kept; a parsed `serde_json::Value` would already have sorted it.
    pub fn from_json_str(text: &str) -> Result<Question, JevError> {
        serde_json::from_str(text).map_err(|e| JevError::Request(e.to_string()))
    }

    /// The question as `JSON.stringify` would write the Node object `{type, instructions, criteria}`.
    pub fn to_wire(&self) -> String {
        let crit: Vec<String> = self.criteria.iter().map(|(k, v)| format!("{}:{}", json_str(k), json_str(v))).collect();
        format!("{{\"type\":{},\"instructions\":{},\"criteria\":{{{}}}}}", json_str(self.kind.as_str()), json_str(&self.instructions), crit.join(","))
    }
}

impl<'de> Deserialize<'de> for Question {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Question, D::Error> {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(rename = "type")]
            kind: String,
            #[serde(default)]
            instructions: String,
            #[serde(default)]
            criteria: Ordered,
        }
        let w = Wire::deserialize(d)?;
        let kind = match w.kind.as_str() {
            "noul" => Kind::Noul,
            "choice" => Kind::Choice,
            other => return Err(serde::de::Error::custom(defaults::render("msg.jev_unknown_question_type", &[("kind", &other)]))),
        };
        Ok(Question { kind, instructions: w.instructions, criteria: js_key_order(w.criteria.0) })
    }
}

/// A JSON object of strings read in text order (a plain map would sort or hash the keys).
#[derive(Debug, Default)]
struct Ordered(Vec<(String, String)>);

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Ordered, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of strings")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, String>()? {
                    out.push((k, v));
                }
                Ok(Ordered(out))
            }
        }
        d.deserialize_map(V)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_like_keys_sort_first_like_a_javascript_object() {
        let q =
            Question::choice("pick", vec![("b".into(), "B".into()), ("10".into(), "ten".into()), ("2".into(), "two".into()), ("01".into(), "zero-one".into())]);
        let keys: Vec<&str> = q.criteria.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "10", "b", "01"], "01 is not canonical, so it stays in insertion order");
    }

    #[test]
    fn a_repeated_key_keeps_its_first_position_and_last_value() {
        let q = Question::choice("p", vec![("a".into(), "1".into()), ("b".into(), "2".into()), ("a".into(), "3".into())]);
        assert_eq!(q.criteria, vec![("a".to_string(), "3".to_string()), ("b".to_string(), "2".to_string())]);
    }

    #[test]
    fn the_wire_form_is_compact_and_ordered_and_escaped_like_json_stringify() {
        let q = Question::noul("Is \"x\" a\nline?", "yes", "no");
        assert_eq!(q.to_wire(), r#"{"type":"noul","instructions":"Is \"x\" a\nline?","criteria":{"true":"yes","false":"no"}}"#);
    }

    #[test]
    fn parsing_keeps_the_text_order_of_the_criteria() {
        let q = Question::from_json_str(r#"{"type":"choice","instructions":"i","criteria":{"z":"Z","a":"A","3":"three"}}"#).unwrap();
        assert_eq!(q.to_wire(), r#"{"type":"choice","instructions":"i","criteria":{"3":"three","z":"Z","a":"A"}}"#);
        assert!(Question::from_json_str(r#"{"type":"weird"}"#).is_err());
    }
}
