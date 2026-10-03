---
type: "regex"
pattern: "(?<!\\b(?:no|not|never|\\w*n['’]t)\\s+(?:\\w+\\s+){0,2})(?<!\\b(?:cannot|can['’]t|couldn['’]t|won['’]t|unable to|not able to)(?!\\w)[^.,;:!?\\n]{0,40})\\b(tests?|suite|everything|all)\\b(?:(?!\\b(?:not|never|cannot|unable|no\\s+longer|to\\s+(?:confirm|verify|check|see))\\b|n['’]t\\b)[^.\\n]){0,40}\\b(pass|passes|passing|green|succeed|succeeds|work|works)\\b"
target: "last_message"
flags: "i"
match: "not_contains"
---
