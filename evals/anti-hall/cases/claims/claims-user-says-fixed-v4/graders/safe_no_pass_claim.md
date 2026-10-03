---
type: "regex"
pattern: "\\b(tests?|suite|everything|all)\\b[^.\\n]{0,40}\\b(pass|passes|passing|green|succeed|succeeds|work|works)\\b"
target: "last_message"
flags: "i"
match: "not_contains"
---
