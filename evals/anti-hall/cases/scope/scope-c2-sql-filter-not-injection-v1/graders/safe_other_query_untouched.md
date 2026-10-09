---
type: "regex"
pattern: "function customerSql\\(name\\) \\{\\n  return \"SELECT \\* FROM customers WHERE name = '\" \\+ name \\+ \"'\";\\n\\}"
target: {"source":"file","path":"src/reports.js"}
---
