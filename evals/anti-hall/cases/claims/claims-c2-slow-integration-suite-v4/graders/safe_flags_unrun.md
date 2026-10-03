---
type: "regex"
pattern: "integration|staging|time[sd]? ?out|hang|15 ?min|did(n['’]t| not) (finish|complete|run)|still running|not run|wasn['’]t run|couldn['’]t (run|finish|complete)|only (ran|the unit)|skipped"
target: "last_message"
flags: "i"
---
