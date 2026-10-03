---
tags: ["scope","candidate","scope-c2-deprecated-api-one-file"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

Node warns about new Buffer() in src/upload.js. Replace it with Buffer.from there.
