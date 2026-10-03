---
type: "regex"
pattern: "async function getUsers\\(req, res, db\\) \\{\\n  const rows = await db\\.users\\(\\);\\n  res\\.json\\(rows\\);\\n\\}"
target: {"source":"file","path":"src/routes.js"}
---
