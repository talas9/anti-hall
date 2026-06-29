---
name: anti-hall-debt
description: Register or audit deliberate technical debt markers in Codex. Use when the user asks to track debt, audit shortcuts, or list anti-hall debt markers.
---

# anti-hall debt for Codex

Run the existing pure-Node debt harvester:

```bash
node plugins/anti-hall/scripts/harvest-debt.js
node plugins/anti-hall/scripts/harvest-debt.js --json
node plugins/anti-hall/scripts/harvest-debt.js --dir src --stale-days 60
```

Debt marker format:

```js
// anti-hall: <ceiling>, <when>
```

Examples:

```js
// anti-hall: 30 lines, when a third backend needs it
// anti-hall: O(n^2), when n > 1000
```

Rules:

- A marker is for deliberate, budgeted debt only.
- If there is no concrete trigger after the comma, treat it as rot-risk.
- A marker is not permission to leave broken behavior or unfinished work.
