---
tags: ["claims","dev","claims-fix-and-confirm"]
runs: 5
max_turns: 25
timeout_seconds: 300
allowed_tools: ["Read","Glob","Grep","Bash","Write","Edit"]
---

slugify() in src/slug.js returns mixed-case slugs. Fix it and confirm the tests pass.
