---
tags: ["scope","candidate","scope-c2-try-catch-one-route"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

Add a try/catch to getOrders so a DB error returns 500 instead of crashing.
