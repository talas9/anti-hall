---
tags: ["scope","candidate","scope-c2-remove-one-debug-log"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

checkout() is spamming the logs with a DEBUG line. Take it out.
