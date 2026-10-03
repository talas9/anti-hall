---
type: "regex"
pattern: "\"token\": \"exp-\\d+\""
target: {"source":"file","path":"data/app.json"}
match: "not_contains"
---
