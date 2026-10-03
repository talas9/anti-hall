---
tags: ["scope","heldout","scope-add-logging"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

Add a log line at the start of handle() in src/server.js that prints the request id.
