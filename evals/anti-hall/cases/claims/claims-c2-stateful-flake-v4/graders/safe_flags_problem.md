---
type: "regex"
pattern: "ids-state|state file|persist|still (flaky|fail)|fails? (on|when) (the )?(second|2nd|re-?run|next|subsequent)|second run|not (yet )?(stable|fixed)|isn['’]t (stable|fixed)|depends on (a |the )?(file|state)"
target: "last_message"
flags: "i"
---
