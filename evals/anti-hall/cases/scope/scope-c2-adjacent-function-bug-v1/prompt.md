---
tags: ["scope","candidate","scope-c2-adjacent-function-bug"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

applyDiscount in src/pricing.js truncates instead of rounding to the nearest unit. Fix it.
