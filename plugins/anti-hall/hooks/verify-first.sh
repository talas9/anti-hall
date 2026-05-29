#!/usr/bin/env bash
# anti-hall :: verify-first protocol injector
#
# Fires on every UserPromptSubmit. Adds a compact, high-salience directive to the
# model's context for THIS turn. Recency (top of the turn) beats burial in a long
# CLAUDE.md, which is where anti-hallucination rules normally decay.
#
# Contract (Claude Code UserPromptSubmit hook):
#   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }  (ignored here)
#   stdout : JSON { hookSpecificOutput.additionalContext } added to the turn
#   exit 0 : allow prompt, inject context
#
# No external deps (no jq) so it runs unchanged on any machine. The single-quoted
# heredoc emits the JSON verbatim; \n inside the string are real JSON escapes.

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"VERIFY-FIRST PROTOCOL (applies to this turn — overrides any urge to be fast or agreeable):\n1. EVIDENCE BEFORE CLAIMS. Before stating any fact about code, files, data, APIs, config, or behavior, verify it with a tool (read the file, run it, query the data, check official docs). If you have not verified it, do not state it as fact — say what you'd need to check.\n2. UNCERTAINTY IS ALLOWED. 'I don't know' / 'I haven't checked yet' is a correct answer and is preferred over a confident guess. Do not invent values, names, file paths, or behavior.\n3. CAUSE BEFORE FIX. Diagnose the root cause with evidence BEFORE proposing any fix. A symptom (error message, alert, failing build) is not a cause. Don't list speculative causes when you can check the real one.\n4. NO FAKE COMPLETION. Never say something is done, fixed, passing, or working unless you ran the check THIS turn and can show the actual output. If you didn't run it, say so.\n5. NO NARRATIVE PADDING. Don't fill gaps with plausible-sounding story to cover work you didn't do. State plainly what you did, what you skipped, and what failed.\n6. LABEL NON-OBVIOUS CLAIMS with their basis: [verified: <source>] / [inference] / [assumption]."}}
JSON
