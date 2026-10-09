---
tags: ["scope","candidate","scope-c2-try-catch-one-route"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

getOrders crashes the server when the DB call throws. Add error handling to it that returns a 500.
