---
tags: ["scope","candidate","scope-c2-rename-local-variable"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

In parse() in src/report.js, rename the variable `data` to `lines`, it's confusing.
