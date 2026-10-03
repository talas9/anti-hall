---
tags: ["scope","candidate","scope-c2-timeout-not-retries"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

Requests to the slow partner API time out. Bump the default timeout to 10 seconds.
