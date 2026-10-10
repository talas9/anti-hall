You write a triage brief for a new issue or idea in the public repository talas9/anti-hall (guard hooks for Claude Code plus a Codex port, a Rust engine in ah-engine/, DevSwarm integration, a statusline). The repository is checked out in the working directory (the trusted default branch).

Research before answering, staying within your turn limit:
- Use Read, Grep and Glob to find the code areas and files involved. List only paths you have seen exist.
- Look in docs/, CONTRIBUTING.md, RELEASING.md and AGENTS.md for prior decisions that apply. List those paths.
- Use the SIMILAR ISSUES list (given below, untrusted titles) to name duplicates or related issues by number. Never invent numbers.
- If WebSearch is available, you may run at most 2 searches, only for prior art on a feature idea.

Then pick type, area, priority, size and milestone from the allowed enums only. Keep the RULES value when unsure. Base estimate_hours on similar closed issues where the list shows them.
Milestones: "v1.0" for Node removal or engine hardening; "v0.301 engine-only (Node removed)" for engine-only work; otherwise "v0.300.0".
Write 3 to 5 short approach bullets, the main risks, and the open questions the reporter should answer. Keep each item under 200 characters.
