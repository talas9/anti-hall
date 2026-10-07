//! Unit tests of the api-guard check. The full Node-vs-engine comparison is `parity/run-api-guard.js`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn settings(pairs: &[(&str, &str)]) -> Settings {
    Settings { home: "/nonexistent-home".to_string(), env: pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
}

fn write(file: &str, code: &str) -> Value {
    json!({"tool_name": "Write", "tool_input": {"file_path": file, "content": code}})
}

#[test]
fn language_follows_the_extension_like_node() {
    for (f, l) in [("a.py", Some(Lang::Python)), ("a.PYI", Some(Lang::Python)), ("x/a.b.js", Some(Lang::Js)), ("a.TSX", Some(Lang::Js)), ("a.mjs", Some(Lang::Js))] {
        assert_eq!(lang_for(f), l, "{f}");
    }
    for f in ["a.rs", "a.py.txt", "a.pyc", "a.js ", "a.py\n", ""] {
        assert_eq!(lang_for(f), None, "{f:?}");
    }
}

#[test]
fn python_code_that_names_no_verifiable_module_is_a_certain_allow() {
    assert!(!py_may_verify("x = 1\nprint(x)\n", false));
    assert!(!py_may_verify("os.fakefn()\n", false), "no import statement");
    assert!(!py_may_verify("import numpy as np\nnp.zeros([1])\n", false), "third party is off");
    assert!(py_may_verify("import numpy as np\nnp.zeros([1])\n", true), "third party on");
    assert!(py_may_verify("import os\nos.path.join('a')\n", false));
    assert!(py_may_verify("from collections import OrderedDict\n", false));
    assert!(!py_may_verify("important = os\n", false), "import must be a whole word");
}

#[test]
fn javascript_code_is_checked_for_globals_and_requires() {
    assert!(!js_may_verify("const a = 1;\nconsole.log(a);\n", false));
    assert!(js_may_verify("Array.isArray(x)", false));
    assert!(js_may_verify("const fs = require('fs');\n", false));
    assert!(!js_may_verify("const q = require('lodash');\n", false), "third party is off and no builtin is named");
    assert!(js_may_verify("const q = require('lodash');\n", true));
    assert!(js_may_verify("MyMath.y", false), "a longer word that ends in a global followed by a dot is still a superset hit");
}

#[test]
fn a_call_that_reaches_no_probe_is_allowed_and_one_that_may_defers() {
    let st = settings(&[]);
    assert_eq!(decide(&write("a.rs", "import os\nos.fakefn()\n"), &st), Verdict::Allow, "not a checked language");
    assert_eq!(decide(&write("a.py", "x = 1\n"), &st), Verdict::Allow);
    assert_eq!(decide(&write("a.py", "import os\nos.fakefn()\n"), &st), Verdict::Defer);
    assert_eq!(decide(&write("a.js", "Array.fakeStatic()\n"), &st), Verdict::Defer);
    assert_eq!(decide(&json!({"tool_name": "Read", "tool_input": {"file_path": "a.py"}}), &st), Verdict::Allow);
    assert_eq!(decide(&json!({"tool_name": "Write", "tool_input": {"file_path": ["a.py"], "content": "import os\n"}}), &st), Verdict::Defer, "an array path stringifies in JavaScript");
    let multi = json!({"tool_name": "MultiEdit", "tool_input": {"file_path": "a.py", "edits": [{"new_string": "x = 1"}, null, {"new_string": "import os\nos.x"}]}});
    assert_eq!(decide(&multi, &st), Verdict::Defer);
}

#[test]
fn shell_writes_naming_a_code_file_are_never_decided_here() {
    let st = settings(&[]);
    let bash = |c: &str| json!({"tool_name": "Bash", "tool_input": {"command": c}});
    for c in [
        "cat > a.py <<'EOF'\nimport os\nos.fakefn()\nEOF",
        "echo 'import os; os.fake' | tee a.py",
        "sed -i 's/x/os.fake()/' a.py",
        "python3 -c \"open('a.py','w').write('import os')\"",
        "printf x >> dir/a.TS",
        "echo x > a.jsx",
        "x=.py; echo y > a$x.py",
    ] {
        assert_eq!(decide(&bash(c), &st), Verdict::Defer, "{c}");
    }
    for c in ["ls", "echo hi > out.txt", "cat > a.sh <<EOF\nimport os\nEOF", ""] {
        assert_eq!(decide(&bash(c), &st), Verdict::Allow, "{c}");
    }
    assert_eq!(decide(&bash("cat > a.py"), &settings(&[("ANTIHALL_SHELL_WRITE_CHECKS", "0")])), Verdict::Allow, "the shell switch is off");
    let patch = json!({"tool_name": "apply_patch", "tool_input": {"command": "*** Begin Patch\n*** Add File: a.py\n+import os\n*** End Patch"}});
    assert_eq!(decide(&patch, &st), Verdict::Defer);
}

#[test]
fn the_guard_switch_and_the_third_party_switch_are_honoured() {
    assert_eq!(decide(&write("a.py", "import os\nos.fakefn()\n"), &settings(&[])), Verdict::Defer);
    let third = write("a.py", "import numpy as np\nnp.zeros\n");
    assert_eq!(decide(&third, &settings(&[])), Verdict::Allow);
    assert_eq!(decide(&third, &settings(&[("ANTIHALL_API_GUARD_THIRDPARTY", "1")])), Verdict::Defer);
}
