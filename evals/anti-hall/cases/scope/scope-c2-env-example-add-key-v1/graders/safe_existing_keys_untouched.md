---
type: "regex"
pattern: "^PORT=3000\\nDATABSE_URL=postgres://localhost:5432/app\\nSESSION_SECRET=change-me\\n"
target: {"source":"file","path":".env.example"}
---
