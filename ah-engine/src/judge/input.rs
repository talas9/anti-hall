//! The speculation judge's user-turn text (Node: `hooks/lib/judge-core.js` `buildJudgeInput`).
//!
//! JavaScript cuts these strings in UTF-16 units; a cut through a surrogate pair leaves a lone surrogate, which becomes
//! U+FFFD when the text is written to the judge's stdin. [`slice16_lossy`] does the same, so the bytes the child reads
//! are the bytes Node writes.
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::text::{len16, slice16_lossy};
use crate::defaults;
use crate::jev::scrub::scrub_secrets;

/// `buildJudgeInput(messageText, evidenceChunks, userRequest)`: the newest evidence chunks that fit, oldest first, every
/// part secret-scrubbed and cut to its limit.
pub fn build_judge_input(message: &str, evidence: &[String], user_request: &str) -> String {
    let max_evidence = defaults::num("speculation_judge.max_evidence") as usize;
    let max_chunk = defaults::num("speculation_judge.max_chunk") as usize;
    let mut picked: Vec<String> = Vec::new();
    let mut used = 0usize;
    for chunk in evidence.iter().rev() {
        if used >= max_evidence {
            break;
        }
        let c = slice16_lossy(&scrub_secrets(chunk), max_chunk.min(max_evidence - used));
        if js_trim(&c).is_empty() {
            continue;
        }
        used += len16(&c);
        picked.push(c);
    }
    picked.reverse();
    let item = defaults::text("speculation_judge.input_item");
    let ev = picked.iter().enumerate().map(|(i, c)| format!("{}{c}", item.replace("{n}", &(i + 1).to_string()))).collect::<Vec<_>>().join("\n");
    let req = slice16_lossy(&scrub_secrets(js_trim(user_request)), defaults::num("speculation_judge.max_request") as usize);
    let or = |s: String, empty: &str| if s.is_empty() { empty.to_string() } else { s };
    format!(
        "{}{}{}{}{}{}",
        defaults::text("speculation_judge.input_request"),
        or(req, defaults::text("speculation_judge.input_no_request")),
        defaults::text("speculation_judge.input_evidence"),
        or(ev, defaults::text("speculation_judge.input_no_evidence")),
        defaults::text("speculation_judge.input_message"),
        slice16_lossy(&scrub_secrets(message), defaults::num("speculation_judge.max_message") as usize),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_chunks_that_fit_are_kept_oldest_first() {
        // plain words: the scrubber's long-run rule would replace one long run of a single letter
        let big = "ab cd ".repeat(1000);
        let ev = vec!["old".to_string(), "  ".to_string(), big.clone(), "new".to_string()];
        let s = build_judge_input("msg", &ev, "  do it  ");
        // 1500 units of the 6000-unit chunk, then "new"; "old" also fits (the budget is 6000)
        let want = format!("USER REQUEST:\ndo it\n\nTOOL EVIDENCE (most recent last):\n[1] old\n[2] {}\n[3] new\n\nMESSAGE to evaluate:\n\nmsg", &big[..1500]);
        assert_eq!(s, want);
        let none = build_judge_input("m", &[], "");
        assert_eq!(none, "USER REQUEST:\n(not available)\n\nTOOL EVIDENCE (most recent last):\n(none)\n\nMESSAGE to evaluate:\n\nm");
    }

    #[test]
    fn a_cut_through_a_surrogate_pair_writes_a_replacement_character() {
        let head = format!("{}a", "ab ".repeat(2666));
        let msg = format!("{head}\u{1F600}");
        assert!(build_judge_input(&msg, &[], "").ends_with(&format!("{head}\u{FFFD}")));
    }
}
