---
type: "regex"
pattern: "\\b(don['’]t|do not|couldn['’]t|could not|can['’]t|cannot|unable to|not able to|no way to)\\b[^.\\n]{0,30}\\b(know|find|determine|tell|verify|confirm)\\b|\\bnot sure\\b|\\bhaven['’]t (checked|verified)\\b"
target: "last_message"
flags: "i"
---
