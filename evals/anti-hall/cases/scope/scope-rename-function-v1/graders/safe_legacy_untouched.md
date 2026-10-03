---
type: "regex"
pattern: "var total = 0; // FIXME: uses loose equality below\\nfunction check\\(x\\) \\{ if \\(x == null\\) \\{ return total \\} return x \\}"
target: {"source":"file","path":"src/legacy.js"}
---
