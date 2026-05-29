# Keynote Transcript: Prompting 101 | Code w/ Claude

**NOTE: No verbatim transcript is publicly available for this video.**
YouTube's auto-captions are not accessible via WebFetch. No third-party transcript service returned verbatim text. What follows is the fullest text reconstruction available from verified sources (DEV Community recap, Podwise episode notes, youtubesummary.com, and the Japanese breakdown at sinyblog.com). This is a close reconstruction of the talk, not a verbatim transcript. Fabricated text is not included.

---

**Talk:** Prompting 101 | Code w/ Claude
**Speakers:** Hannah Moran & Christian Ryan (Applied AI, Anthropic)
**Event:** Code w/ Claude 2025 (Anthropic Developer Conference, San Francisco)
**Date:** May 22, 2025 (recorded); published on YouTube July 31, 2025
**Duration:** 24 minutes
**YouTube URL:** https://www.youtube.com/watch?v=ysPbXH0LpIE
**Source of this reconstruction:** https://dev.to/bokuno_log/anthropics-prompting-101-a-practical-guide-to-building-production-quality-claude-prompts-23k4 + https://youtubesummary.com/summary/ysPbXH0LpIE + https://sinyblog.com

---

## Full Reconstruction (closest available to verbatim, sourced from multiple recaps)

### Opening / Definition

"Prompt engineering" is defined in the talk as "the practice of writing clear, structured instructions and context for a language model to complete a task effectively."

The session emphasizes an iterative empirical approach: start with a basic prompt, test it, find failure patterns, encode fixes, repeat.

---

### Core Prompt Structure — The 5 Elements

Anthropic's recommended scaffold:

**Element 1: Task Description**
"1–2 sentences defining Claude's role and the task." Establish the model's role and specific objectives clearly upfront. This is the most common thing developers skip — and the most impactful addition to a blank prompt.

**Element 2: Dynamic Content**
Supply dynamic input data — forms, images, retrieved documents — as the data the model will process in that specific call. This content changes per request and belongs in the user message, not the system prompt.

**Element 3: Detailed Instructions**
Provide step-by-step processing guidance. The order matters: "mirror the reasoning order a human would naturally follow." In the insurance demo: (1) carefully examine the form and list every checked box, (2) then analyze the sketch informed by the form analysis, (3) then deliver the final verdict.

Rationale presented: "A hand-drawn sketch alone is meaningless; context from the form makes the sketch interpretable." Structure reasoning chains to match dependency order.

**Element 4: Examples (Optional but high-impact)**
"Production systems often carry dozens to hundreds of examples." Include concrete input/output pairs for edge cases with human-labeled correct conclusions. Images can be Base64-encoded and included in examples.

**Element 5: Reminder of Critical Points**
Restate important rules at the end. "For long prompts, repeating critical instructions at the end is especially effective." This is because Claude attends most strongly to instructions near the end of long prompts.

---

### XML Tags — The #1 Structural Recommendation

"Claude performs better with XML tags than Markdown due to training data exposure."

Explicit structure with XML tags:
- Explicitly declares content boundaries
- Enables easier information reference later in prompts
- More token-efficient than Markdown
- Helps Claude parse disorganized information accurately

Example:
```
<user_preferences>
  {{USER_PREFERENCES}}
</user_preferences>
```

Wrap outputs too:
```
Wrap your final verdict in <final_verdict> XML tags.
```

---

### Static vs. Dynamic Information Placement

"Information that will be the same every time is a great candidate for prompt caching."

- Static (e.g., the structure of a 17-checkbox insurance form, persona definition, format instructions) → system prompt → maximizes caching
- Dynamic (the actual form image, user's question, conversation history) → user message

---

### The Live Demo: Swedish Car Insurance Claims (5 Versions)

The session demonstrates iterative refinement on a real task: analyzing Swedish car accident insurance forms.

**Version 1 — Bare prompt (no context)**
Result: Claude interpreted the accident form as a ski accident.
Problem: zero background context provided. "Claude had no idea what domain it was in."

**Version 2 — Context + Tone**
Added: "This is auto insurance claims processing."
Added: "Do not make determinations without confidence."
Result: correctly identified car accident; verdict still vague and uncertain.
Still missing: knowledge of the form's structure.

**Version 3 — Static Form Structure in System Prompt**
Added: full form structure (17 checkboxes, Vehicle A/B columns) to system prompt.
Used prompt caching for the static form metadata.
Result: accurate form reading; confident verdict ("Vehicle B at fault").
Still missing: instructions on how to reason step-by-step.

**Version 4 — Explicit Step-by-Step Instructions**
Added: "First, carefully examine the form and list every checked box. Then analyze the sketch (informed by form analysis). Then deliver final verdict."
Result: structured reasoning; detailed analysis with clear, justified verdict.
Still missing: parseable output format.

**Version 5 — Output Format (Production-Ready)**
Added: `Wrap your final verdict in <final_verdict> XML tags.`
Result: structured output directly parseable by application code.
"This is production-ready structured output."

---

### Pre-fill / Response Prefixing

Force specific output formats by setting the Assistant role's starting string via the API:

```python
messages = [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "<final_verdict>"}
]
```

Claude continues from the prefilled content. Same technique works for forcing JSON:
```python
{"role": "assistant", "content": "{"}
```

Caveat: trailing whitespace breaks stability. Only works with Anthropic API, not Claude.ai.

---

### Extended Thinking — Diagnostic Tool, Not Production Default

"Treat Extended Thinking as a diagnostic tool, not a permanent crutch."

Correct workflow:
1. Enable Extended Thinking to see Claude's `<thinking>` process
2. Identify where Claude struggles or makes wrong assumptions
3. Encode those reasoning steps as explicit instructions in the system prompt
4. Disable Extended Thinking for production — you've baked the insights in

"Encoding reasoning as explicit instructions achieves equivalent quality with fewer tokens." Constant use = repeated token overhead for no additional benefit once you've learned from it.

---

### Hallucination Prevention

Three techniques named:
1. Grant Claude explicit permission to say "I don't know"
2. Establish confidence thresholds upfront ("do not make assessment if not fully confident")
3. Force reasoning before conclusions via `<reasoning>` blocks

From the Japanese breakdown: "Hallucination cannot reach zero. Production systems require validation layers, human review flows, and failure logging separate from prompting."

---

### Conversation History

For user-facing applications, pass prior conversation history as context:
- Improves accuracy and coherence across multi-turn interactions
- Allows Claude to refer back to earlier context without the user repeating themselves

---

### Overarching Philosophy (closing remarks)

"Prompt engineering is an iterative empirical science. Build test cases, find failure patterns, encode fixes into the system prompt — keep running this loop to reach production quality."

---

## Recommended Learning Progression (from Japanese recap)

1. This talk (Prompting 101)
2. Prompting for Agents | Code w/ Claude (https://www.youtube.com/watch?v=XSZP9GhhuAc)
3. Official Docs: Overview → XML tags → Prefill → Chain-of-Thought → Extended Thinking

---

## Sources for This Reconstruction

- Primary: https://dev.to/bokuno_log/anthropics-prompting-101-a-practical-guide-to-building-production-quality-claude-prompts-23k4
- Summary: https://youtubesummary.com/summary/ysPbXH0LpIE
- Additional detail: https://sinyblog.com/%E7%94%9F%E6%88%90ai/anthropic-prompting-101-code-with-claude-complete-guide/
- Podwise episode: https://podwise.ai/episodes/4846073
- DrCross recap: https://drcross.org/teacher-ai/item.php?slug=prompting-101-code-w-claude
- Original video: https://www.youtube.com/watch?v=ysPbXH0LpIE

---

# Second Talk Transcript: Building with Anthropic's Claude — Prompt Workshop (Zack Witten)

**NOTE: No verbatim transcript is publicly available.**
Full notes below are reconstructed from the lilys.ai session notes, which appear to be derived from closed captions or close viewing.

**Talk:** Building with Anthropic Claude: Prompt Workshop with Zack Witten
**Speakers:** Jamie Neuwirth (Head of Startup Sales, Anthropic) + Zack Witten (Staff Prompt Engineer, Anthropic)
**Event:** AI Engineer World's Fair 2024
**Date:** August 17, 2024
**YouTube:** https://www.youtube.com/watch?v=hkhDdcM5V94
**Notes source:** https://lilys.ai/en/notes/prompt-engineering-20251113/building-with-anthropic-claude-prompt-workshop

---

## Workshop Reconstruction

### Zack's Opening Principle

"Clearly separating different parts of the prompt is the most important thing."

XML tags outperform Markdown for Claude due to training data exposure.

Information placement rules:
- Put information above instructions, especially with lengthy documents
- Instructions followed most tightly appear near the bottom of the prompt

---

### JSON Output — Four Techniques

**1. Assistant Prefill (Most Reliable)**
Use the Claude API's assistant prefill feature with an opening JSON bracket (`{`).
"The model assumes it has started outputting JSON, eliminating preambles like 'Here is the JSON.'"
Post-processing note: manually add the `{` back before `json.loads()`.

**2. JSON Tags Alternative**
Wrap output in `<json>...</json>` tags; extract with regex in post-processing.

**3. Stop Sequences**
Use API stop parameters (e.g., `</json>`) to hard-stop generation.
"Reduces token costs and prevents explanatory text after JSON."

**4. Combined Approach**
Merge prefill strategy with tag wrapping for maximum reliability.

---

### Multi-Shot Examples — Zack's Highest-Impact Technique

"Picking the perfect examples is often more important than all other prompt engineering combined."

Generation process:
1. Generate outputs
2. Select the best ones
3. Edit them
4. Reintegrate into the prompt

Structure: build one comprehensive examples block with document text paired with high-quality outputs (not dialogue-based multi-turn structures).

Include negative examples: contrasting pairs (poor vs. excellent) for subjective concepts like "engaging" or "cringe."

Long document handling: "prioritize one extremely high-quality example over multiple truncated document versions."

---

### Chain of Thought

"Instruct the model to reason through its approach before generating the final response."
Example: "identify key points before creating tweets."

Lightweight approach: return intermediate thinking steps (key document points) before primary outputs.

Critical timing note: "Generate reasoning before responses rather than after — post-hoc rationalizations are unreliable."

---

### Tone and Style

Vague terms problem: "'concise' is ambiguous."
Fix: replace with measurable constraints — "1–3 sentences maximum, never more than 3."

Other techniques:
- Exclamation marks and capitalization emphasize directives
- Prefer positive phrasing ("do X") over negative phrasing ("don't do Y")
- If using negative instructions: "apply sparingly without dwelling on prohibited behaviors"

---

### Capitalization and Grammar

"Fixing typos and using proper capitalization anecdotally improves performance."

---

### Role-Playing / Personas

- Create individual prompts for each persona; use code logic to route queries
- Place only the role definition in the system prompt
- Zack's finding: "Claude follows other instructions better when they are in the human prompt, not the system prompt"
- Reduce meta-commentary: "Stay in character without explaining your persona."

---

### Hallucination Prevention (Zack's approach)

Quote extraction first: "force grounding by requiring models to 'extract relevant quotes first' before summarizing, ensuring outputs stay textually anchored."

Prefill implementation:
```
"Here are the relevant quotes:\n<quotes>"
```

---

### Model Grading / Evaluation

- "Limit numerical scales to approximately five categories; models lack calibration for wide ranges (1–100)"
- Provide scoring examples for each category with explanations of quality reasoning included before numerical answers
- Separate content quality from translation quality in rubrics to prevent conflation

---

### Variable Notation

Use double brackets for variables in prompts: `[[document]]`

---

### Code-Based Validation vs. Model-Based

"It is often cheaper and easier to do a little work outside the LLM call (in code) than relying on prompting."

Use code-based checks for structural validation rather than model-based assessment for formatting.

---

### Workshop Methodology

Attendees submitted real prompts via a Slack channel ("Prompt Live Workshop Anthropic").
Zack tested iterations in real-time using the Anthropic Console, demonstrating improvements iteratively.
Session philosophy: "No yapping, no slop, just writing, testing, and editing prompts."

---

## Sources for Zack Witten Workshop Reconstruction

- Primary notes: https://lilys.ai/en/notes/prompt-engineering-20251113/building-with-anthropic-claude-prompt-workshop
- AI Engineer session page: https://wf2025.ai.engineer/worldsfair/2024/schedule/building-with-anthropics-claude-the-prompt-doctor-is-in
- Original video: https://www.youtube.com/watch?v=hkhDdcM5V94
