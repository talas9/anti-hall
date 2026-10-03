# Anthropic Prompting Keynotes — Distilled Notes

Captured 2026-05-29. Two verified Anthropic talks, both widely cited and shared.

---

## Talk 1 (PRIMARY — most recent, most buzzed-about)

**Title:** Prompting 101 | Code w/ Claude
**Speakers:** Hannah Moran & Christian Ryan (both Applied AI, Anthropic)
**Event:** Code w/ Claude 2025 (Anthropic's first official developer conference)
**Date:** May 22, 2025, San Francisco, CA — published on YouTube July 31, 2025
**Duration:** 24 minutes
**YouTube:** https://www.youtube.com/watch?v=ysPbXH0LpIE
**Playlist:** https://www.youtube.com/playlist?list=PLcfpQ4tk2k0W564IUrISLhTVZ5lOVCuwm (Anthropic @ AI Engineer)
**Recap (best available):** https://dev.to/bokuno_log/anthropics-prompting-101-a-practical-guide-to-building-production-quality-claude-prompts-23k4

**Why it was buzzed-about:** Shared widely on X/Twitter, LinkedIn, and developer communities. Called "the talk from the people who built it." Multiple $300-course comparisons. Brian Roemmele, Bilgin Ibryam, and others amplified it. A follow-up session, "Prompting for Agents | Code w/ Claude" (https://www.youtube.com/watch?v=XSZP9GhhuAc) was directly recommended as the next step.

---

### Core Prompt Structure — 5 Elements

Anthropic's recommended scaffold for any production prompt:

1. **Task Description** — 1–2 sentences defining Claude's role and the specific task
2. **Dynamic Content** — Data, images, or retrieved information to process (goes in user message)
3. **Detailed Instructions** — Step-by-step guidance on approach; mirror the reasoning order a human would naturally follow
4. **Examples (Optional but high-impact)** — Few-shot samples demonstrating expected behavior; "production systems often carry dozens to hundreds of examples"
5. **Reminder of Critical Points** — Restate important rules at the end; "for long prompts, repeating critical instructions at the end is especially effective"

---

### XML Tags

- **Top recommendation:** Use XML tags as delimiters to structure information in prompts
  - `<user_preferences>{{USER_PREFERENCES}}</user_preferences>`
- Why: explicitly declares content boundaries; easier for Claude to parse; more token-efficient than Markdown; clearer than prose
- Wrap outputs in semantic XML tags too (`<final_verdict>`, `<tweets>`, `<summary>`, `<json>`) for programmatic parsing

---

### Static vs. Dynamic Content Placement

- **Static information → system prompt** — anything that never changes (form structures, background context, persona) goes in the system prompt to maximize prompt caching hit rate
- **Dynamic content → user message** — data specific to individual requests
- Key production insight: "information that will be the same every time is a great candidate for prompt caching"

---

### Order of Instructions Matters

- Mirror the reasoning order a human would naturally follow
- Example: "First, carefully examine the form and list every checked box. Then analyze the sketch (informed by form analysis). Then deliver final verdict."
- Rationale: a hand-drawn sketch alone is meaningless; context from the form makes it interpretable. Structure reasoning chains to match this dependency order.

---

### Output Format Specification

- Always specify desired output format explicitly
- Use XML tags for structured extraction: `Wrap your final verdict in <final_verdict> XML tags`
- This makes responses directly parseable by application code
- Use prefill (assistant pre-fill) to force specific format:
  ```python
  messages = [
      {"role": "user", "content": "..."},
      {"role": "assistant", "content": "<final_verdict>"}
  ]
  ```
  Claude continues from the prefilled content — eliminates preamble text like "Here is my analysis..."

---

### Few-Shot Examples (Highest Single-Technique Impact)

- "Production systems often carry dozens to hundreds of examples"
- Images can be Base64-encoded and included in examples
- Use examples to label difficult edge cases with human annotations
- One high-quality example beats multiple truncated ones
- For subjective qualities ("engaging" vs. "cringe"), include negative examples (contrasting pairs)

---

### Extended Thinking — Use as Diagnostic, Not Production Default

- Extended Thinking (Claude 3.7+) exposes reasoning in `<thinking>` tags
- **Critical warning from the talk:** "Treat Extended Thinking as a diagnostic tool, not a permanent crutch. Use it to identify where Claude struggles, then encode those reasoning steps as explicit instructions in the system prompt."
- Why: encoding reasoning as explicit instructions achieves equivalent quality with fewer tokens and lower latency
- Extended Thinking in production = constant overhead; use it to learn, then bake the learnings into the prompt

---

### Hallucination Prevention

- Specify confidence thresholds: "do not make assessment if not fully confident"
- Instruct Claude to explicitly acknowledge when information is missing rather than inventing it
- Force grounding by requiring Claude to extract relevant quotes before summarizing:
  - `<quotes>` block prefill approach: "Here are the relevant quotes:\n<quotes>"
- Grant Claude explicit permission to say "I don't know"
- Force reasoning before conclusions via `<reasoning>` blocks
- Important caveat: "hallucination cannot reach zero — production systems require validation layers, human review flows, and failure logging separate from prompting"

---

### Iterative Engineering Process

- The overarching philosophy: "Prompt engineering is an iterative empirical science. Build test cases, find failure patterns, encode fixes into the system prompt — keep running this loop to reach production quality."
- Demo showed 5 versions of one prompt, progressing from "Claude thinks it's a ski accident" to structured production output
- Use the Anthropic Console as primary iteration environment
- Include failure cases when submitting prompts for improvement

---

### Production-Readiness DO/DON'T Checklist

**DO:**
- Put static information in system prompt for caching
- Use XML tags as delimiters
- Specify output format explicitly
- Add confidence thresholds to prevent hallucination
- Include few-shot examples for edge cases
- Repeat critical instructions at the end of long prompts

**DON'T:**
- Leave the system prompt empty
- Use language-only formatting instructions without structural enforcement
- Deploy Extended Thinking constantly in production (use it to develop, not to run)
- Assume perfect user input — real traffic has typos and edge cases

---

## Talk 2 (Companion — live workshop format, also widely shared)

**Title:** Building with Anthropic's Claude — The Prompt Doctor is In
**Speakers:** Jamie Neuwirth (Head of Startup Sales, Anthropic) + Zack Witten (Staff Prompt Engineer, Anthropic)
**Event:** AI Engineer World's Fair 2024
**Date:** August 17, 2024
**Format:** Live workshop — attendees submitted real prompts via Slack; Zack iterated on them live in the Anthropic Console. "No yapping, no slop, just writing, testing, and editing prompts."
**YouTube:** https://www.youtube.com/watch?v=hkhDdcM5V94
**Detailed notes:** https://lilys.ai/en/notes/prompt-engineering-20251113/building-with-anthropic-claude-prompt-workshop

**Why it was buzzed-about:** LinkedIn/X amplification. Described as "an hour where you watch Anthropic's prompt engineer fix real prompts in real time." Widely shared among enterprise builders and applied AI teams.

---

### XML Tag Separation (Zack's #1 principle)

- "Clearly separating different parts of the prompt is the most important thing."
- Claude performs better with XML tags than Markdown due to training data exposure
- Position information above instructions, especially with lengthy documents
- Instructions followed most tightly appear near the bottom of the prompt

---

### Reliable JSON Output — Three Techniques

1. **Assistant Prefill (Most Reliable):** Use the API's assistant prefill with an opening `{`. Claude assumes it has started outputting JSON. Eliminates preamble text. Note: manually add the opening `{` back before `json.loads()` in post-processing.
2. **JSON Tags:** Wrap output in `<json>...</json>` tags, then extract with regex in post-processing.
3. **Stop Sequences:** Use API stop parameter (e.g., `</json>`) to hard-stop generation — reduces token costs, prevents explanatory text after JSON.
4. **Combined:** Merge prefill with tag strategy for maximum reliability.

---

### Multi-Shot Examples — Zack's Single Highest-Impact Technique

- "Picking the perfect examples is often more important than all other prompt engineering combined."
- Generation process: generate outputs → select best → edit them → reintegrate into prompt
- Build one comprehensive examples block (document + output) rather than dialogue-based multi-turn structures
- Include negative examples (poor vs. excellent) for subjective concepts like "engaging" or "cringe"
- Long document handling: one extremely high-quality example > multiple truncated examples

---

### Chain of Thought

- Instruct the model to reason through its approach before generating the final response
- Lightweight approach: return intermediate thinking steps (e.g., "list key document points before creating tweets")
- "Generate reasoning before responses rather than after — post-hoc rationalizations are unreliable"

---

### Tone and Style Precision

- Words like "concise" are ambiguous — replace with measurable constraints: "1–3 sentences maximum, never more than 3"
- Exclamation marks and capitalization emphasize directives to the model
- Prefer positive phrasing over negative phrasing
- If using negative instructions, apply sparingly — don't dwell on prohibited behaviors

---

### Capitalization and Grammar

- Fixing typos and using proper capitalization anecdotally improves prompt performance
- "Treat the prompt like you'd treat a spec given to a competent contractor"

---

### Role-Playing / Personas

- Create separate prompts for each persona; use code logic to route queries
- Place only the role definition in the system prompt; other instructions work better in the human turn (Zack's finding)
- Reduce meta-commentary: "Stay in character without explaining your persona"

---

### Model Grading / Evaluation

- Scale calibration: limit numerical scales to ~5 categories; models lack calibration for wide ranges (1–100)
- Provide scoring examples for each category with quality reasoning before the numerical answer
- Distinguish content quality from translation quality in rubrics (prevents conflation)

---

## Talk 3 (Context/Background — Deep Dive Roundtable)

**Title:** AI Prompt Engineering: A Deep Dive
**Speakers:** Amanda Askell (Alignment Finetuning), Alex Albert (Developer Relations), David Hershey (Applied AI), Zack Witten (Staff Prompt Engineer) — all Anthropic
**Date:** September 5, 2024
**YouTube:** https://www.youtube.com/watch?v=T9aRN5JkmL8

**Key takeaways:**
- "Treat the model like a competent person needing context, not requiring oversimplification"
- Test what happens when inputs deviate from ideal — real traffic is messy with typos and edge cases
- Give models explicit "outs" for edge cases using tags like `<unsure>`
- Use illustrative examples rather than exact replicas of test data
- Enterprise prompts: prioritize consistency, use many examples to constrain outputs; Research prompts: use fewer examples, seek diversity at model boundaries
- Amanda on future direction: "As models become expert-level, they may ask clarifying questions about edge cases, making prompting something like I'm prompting you rather than the reverse"
- On iteration speed: "sometimes hundreds of prompts in 15 minutes"
- Common failure: "assuming perfect user input when real traffic is messy with typos"
- Over-reliance on role-playing ("You are a teacher...") flagged as a common mistake

---

## Bonus: Anthropic Engineering Blog — Context Engineering (2025)

**Title:** Effective Context Engineering for AI Agents
**Authors:** Prithvi Rajasekaran, Ethan Dixon, Carly Ryan, Jeremy Hadfield + contributions from Hannah Moran et al. (Applied AI team)
**Published:** September 29, 2025
**URL:** https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

**Core thesis:** "Find the smallest set of high-signal tokens that maximize the likelihood of your desired outcome." Context engineering = the evolution of prompt engineering for agentic systems.

Key techniques:
- **System prompt "Goldilocks zone":** specific enough to guide behavior, flexible enough to be a heuristic, not brittle hardcoded logic; organize with XML tags or Markdown headers; start minimal on capable models, add instructions based on failure analysis
- **Tool design:** minimal viable tool set; self-contained, robust to error, clear descriptions; avoid overlapping tools
- **Few-shot:** diverse + canonical examples, not exhaustive edge cases; "examples are the pictures worth a thousand words for LLMs"
- **Just-in-time retrieval:** keep lightweight identifiers (file paths, URLs) and dynamically load at runtime; mirrors human cognition
- **Compaction:** summarize message history approaching context limits; preserve architectural decisions, unresolved bugs, implementation details; discard redundant tool outputs
- **Structured note-taking:** persistent memory outside context window so agents can track progress across long-horizon tasks
- **Sub-agent architectures:** specialized agents with clean context windows returning 1,000–2,000 token summaries

---

## Sources

- [Prompting 101 | Code w/ Claude (YouTube)](https://www.youtube.com/watch?v=ysPbXH0LpIE) — Hannah Moran & Christian Ryan, May 22 / July 31, 2025
- [Anthropic's Prompting 101 — DEV Community recap](https://dev.to/bokuno_log/anthropics-prompting-101-a-practical-guide-to-building-production-quality-claude-prompts-23k4)
- [Prompting for Agents | Code w/ Claude (YouTube)](https://www.youtube.com/watch?v=XSZP9GhhuAc) — recommended follow-on
- [Building with Anthropic's Claude: Prompt Workshop (YouTube)](https://www.youtube.com/watch?v=hkhDdcM5V94) — Zack Witten, AI Engineer World's Fair, Aug 17, 2024
- [Zack Witten workshop notes — lilys.ai](https://lilys.ai/en/notes/prompt-engineering-20251113/building-with-anthropic-claude-prompt-workshop)
- [AI Engineer World's Fair session page](https://wf2025.ai.engineer/worldsfair/2024/schedule/building-with-anthropics-claude-the-prompt-doctor-is-in)
- [AI Prompt Engineering: A Deep Dive (YouTube)](https://www.youtube.com/watch?v=T9aRN5JkmL8) — Anthropic roundtable, Sep 5, 2024
- [Effective Context Engineering for AI Agents — Anthropic Engineering Blog](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Code w/ Claude 2026 notes — Chris Ebert's Blog](https://chrisebert.net/notes-from-code-with-claude-2026/)
- [Anthropic Prompting Best Practices — Official Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Glen Rhodes blog — 24-min workshop article](https://glenrhodes.com/anthropic-releases-free-24-minute-prompting-workshop-with-40-techniques-taught-by-the-claude-team/)
