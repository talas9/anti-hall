#!/usr/bin/env python3
"""Generate the docs-site pages that come from shipped files, so they never drift.

Run before `mkdocs build` (stdlib only, run with `python3 -I`):

    python3 -I tools/site_gen.py

Writes (both git-ignored, rebuilt on every build):
  docs/settings/reference.md  every setting in plugins/anti-hall/hooks/lib/settings-schema.js,
                              plus the engine defaults in plugins/anti-hall/engine/defaults/*.toml
                              when that directory exists
  docs/changelog.md           CHANGELOG.md

The settings schema is a JavaScript file. It is read with a small parser for JavaScript
object literals (strings, numbers, booleans, null, arrays, objects, comments). Anything
else inside `const SECTIONS = [...]` stops the build with an error, so a schema change
the parser cannot read fails loudly instead of rendering a wrong table.
"""

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "plugins" / "anti-hall" / "hooks" / "lib" / "settings-schema.js"
ENGINE_DEFAULTS = ROOT / "plugins" / "anti-hall" / "engine" / "defaults"
CHANGELOG = ROOT / "CHANGELOG.md"
OUT_SETTINGS = ROOT / "docs" / "settings" / "reference.md"
OUT_CHANGELOG = ROOT / "docs" / "changelog.md"


# --------------------------------------------------------------------------- JS literal parser

class ParseError(Exception):
    pass


class JsLiteral:
    """Parses one JavaScript literal value (the subset the settings schema uses)."""

    IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
    NUMBER = re.compile(r"-?(?:0|[1-9][0-9_]*)(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?")
    ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}

    def __init__(self, text, pos=0):
        self.s = text
        self.i = pos

    def error(self, msg):
        line = self.s.count("\n", 0, self.i) + 1
        raise ParseError(f"{SCHEMA.name}:{line}: {msg}")

    def ws(self):
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif s.startswith("//", self.i):
                end = s.find("\n", self.i)
                self.i = len(s) if end < 0 else end + 1
            elif s.startswith("/*", self.i):
                end = s.find("*/", self.i + 2)
                if end < 0:
                    self.error("unterminated comment")
                self.i = end + 2
            else:
                break

    def value(self):
        self.ws()
        if self.i >= len(self.s):
            self.error("unexpected end of input")
        c = self.s[self.i]
        if c == "[":
            return self.array()
        if c == "{":
            return self.obj()
        if c in "'\"":
            return self.string()
        m = self.NUMBER.match(self.s, self.i)
        if m:
            self.i = m.end()
            t = m.group().replace("_", "")
            return float(t) if any(ch in t for ch in ".eE") else int(t)
        m = self.IDENT.match(self.s, self.i)
        if m:
            word = m.group()
            if word in ("true", "false", "null", "undefined"):
                self.i = m.end()
                return {"true": True, "false": False}.get(word)
            self.error(f"non-literal value {word!r} (only literals are supported)")
        self.error(f"unexpected character {c!r}")

    def string(self):
        q = self.s[self.i]
        self.i += 1
        out = []
        while True:
            if self.i >= len(self.s):
                self.error("unterminated string")
            c = self.s[self.i]
            if c == q:
                self.i += 1
                return "".join(out)
            if c == "\n":
                self.error("newline in string")
            if c == "\\":
                n = self.s[self.i + 1]
                if n == "u":
                    out.append(chr(int(self.s[self.i + 2:self.i + 6], 16)))
                    self.i += 6
                    continue
                if n == "x":
                    out.append(chr(int(self.s[self.i + 2:self.i + 4], 16)))
                    self.i += 4
                    continue
                out.append(self.ESCAPES.get(n, n))
                self.i += 2
                continue
            out.append(c)
            self.i += 1

    def array(self):
        self.i += 1
        items = []
        while True:
            self.ws()
            if self.s[self.i] == "]":
                self.i += 1
                return items
            items.append(self.value())
            self.ws()
            if self.s[self.i] == ",":
                self.i += 1
            elif self.s[self.i] != "]":
                self.error("expected ',' or ']'")

    def obj(self):
        self.i += 1
        out = {}
        while True:
            self.ws()
            if self.s[self.i] == "}":
                self.i += 1
                return out
            if self.s[self.i] in "'\"":
                key = self.string()
            else:
                m = self.IDENT.match(self.s, self.i)
                if not m:
                    self.error("expected a property name")
                key = m.group()
                self.i = m.end()
            self.ws()
            if self.s[self.i] != ":":
                self.error(f"expected ':' after {key!r} (shorthand and spread are not supported)")
            self.i += 1
            out[key] = self.value()
            self.ws()
            if self.s[self.i] == ",":
                self.i += 1
            elif self.s[self.i] != "}":
                self.error("expected ',' or '}'")


def read_const(text, name):
    m = re.search(r"^const\s+" + re.escape(name) + r"\s*=\s*", text, re.M)
    if not m:
        raise ParseError(f"{SCHEMA.name}: `const {name} =` not found")
    p = JsLiteral(text, m.end())
    val = p.value()
    p.ws()
    if p.s[p.i:p.i + 1] != ";":
        p.error(f"expected ';' after {name}")
    return val


# --------------------------------------------------------------------------- rendering helpers

# Trailing source annotations in schema descriptions are for maintainers, not readers:
# "[read by: hooks/x.js]", "[verified: hooks/x.js:12 - ...]".
ANNOTATION = re.compile(r"\s*\[(?:read by|verified|source|see)\b[^\]]*\]", re.I)


def cell(text):
    """Make text safe inside a Markdown table cell."""
    text = ANNOTATION.sub("", str(text)).strip()
    text = text.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ")
    # Escape angle brackets outside code spans so "<path>" is not read as HTML.
    parts = text.split("`")
    for n in range(0, len(parts), 2):
        parts[n] = parts[n].replace("<", "&lt;").replace(">", "&gt;")
    return "`".join(parts)


def code(value):
    if value is None:
        return "(none)"
    if isinstance(value, bool):
        return "`true`" if value else "`false`"
    if isinstance(value, str) and value == "":
        return '`""`'
    if isinstance(value, list):
        value = ", ".join(str(v) for v in value) if value else "[]"
    text = str(value).replace("|", "\\|")
    return "`" + text.replace("`", "'") + "`"


def type_text(s):
    t = s.get("type", "")
    if t == "enum":
        return "one of " + ", ".join(code(v) for v in s.get("values", []))
    if t == "number":
        lo, hi = s.get("min"), s.get("max")
        if lo is not None and hi is not None:
            return f"number, {lo} to {hi}"
        if lo is not None:
            return f"number, at least {lo}"
        if hi is not None:
            return f"number, at most {hi}"
        return "number"
    if t == "csv":
        return "comma-separated list"
    return t or "value"


# --------------------------------------------------------------------------- settings page

SETTINGS_INTRO = """\
---
title: Settings reference
description: Every anti-hall setting, its default and what it does, generated from the shipped schema.
---

# Settings reference

!!! info "Generated page"
    This page is built from [`settings-schema.js`]({schema_url}), the registry the plugin itself
    reads, every time the site is built, so it always matches the code on `main`.
    How to change a setting: [Changing settings](index.md).

Settings live in `~/.anti-hall/settings.json`. Change them with `/anti-hall:settings`
("set autoHandover.pct to 80") or the CLI:

```bash
node plugins/anti-hall/scripts/settings.js set autoHandover.pct 80
```

**How to read the tables**

| Mark | Meaning |
|---|---|
| :material-tune: **config** | Also shown in Claude Code's native `/config` panel. |
| :material-shield-lock: **safety** | Changing it in the risky direction needs `--confirmed` (or a direct request from you). |
| :material-cog-outline: **advanced** | A tuning knob. `settings.js show` hides it unless you pass `--all`. |

**Env** is an `ANTIHALL_*` environment variable that overrides the file value.
Precedence, highest first: environment variable, `settings.json`, the `/config` panel,
a legacy per-feature file, the default.

{count_line}

"""


def setting_marks(s):
    marks = []
    if s.get("headline"):
        marks.append(":material-tune:{ title=\"In /config\" }")
    if s.get("locked"):
        marks.append(":material-shield-lock:{ title=\"Safety: needs --confirmed\" }")
    if s.get("advanced"):
        marks.append(":material-cog-outline:{ title=\"Advanced\" }")
    return " ".join(marks)


def render_settings(sections, engine_dir, repo_url):
    total = sum(len(sec["settings"]) for sec in sections)
    lines = []
    toc = ", ".join(f"[{sec['label']}](#{sec['key'].lower()})" for sec in sections)
    count_line = f"**{total} settings in {len(sections)} sections:** {toc}."
    lines.append(SETTINGS_INTRO.format(
        schema_url=f"{repo_url}/blob/main/plugins/anti-hall/hooks/lib/settings-schema.js",
        count_line=count_line,
    ))
    for sec in sections:
        lines.append(f"## {sec['label']} {{ #{sec['key'].lower()} }}\n")
        if sec.get("description"):
            lines.append(cell(sec["description"]) + "\n")
        lines.append("| Setting | Default | Type | Env | What it does |")
        lines.append("|---|---|---|---|---|")
        for s in sec["settings"]:
            key = f"`{sec['key']}.{s['key']}`"
            marks = setting_marks(s)
            name = key + (" " + marks if marks else "")
            desc = cell(s.get("description", ""))
            if s.get("locked") and s.get("safetyNote"):
                desc += " <br>**If changed:** " + cell(s["safetyNote"]) + "."
            env = code(s["env"]) if s.get("env") else ""
            lines.append(f"| {name} | {code(s.get('default'))} | {type_text(s)} | {env} | {desc} |")
        lines.append("")
    if engine_dir is not None:
        lines.extend(render_engine(engine_dir, repo_url))
    return "\n".join(lines).rstrip() + "\n"


def render_engine(engine_dir, repo_url):
    """Engine defaults: list the values a user can override with an environment variable."""
    try:
        import tomllib
    except ModuleNotFoundError:  # Python < 3.11
        sys.exit("site_gen: reading engine defaults needs Python 3.11+ (tomllib)")
    files = sorted(engine_dir.glob("*.toml"))
    if not files:
        return []
    rows, total = [], 0
    for f in files:
        data = tomllib.loads(f.read_text(encoding="utf-8"))
        for group, entries in data.items():
            if not isinstance(entries, dict):
                continue
            for key, e in entries.items():
                if not (isinstance(e, dict) and "value" in e):
                    continue
                total += 1
                if e.get("env"):
                    rows.append((f.name, f"{group}.{key}", e))
    rel = engine_dir.relative_to(ROOT).as_posix()
    out = [
        "## Engine defaults { #engine }\n",
        f"The Rust engine reads its values from [`{rel}/`]({repo_url}/tree/main/{rel}), "
        f"{total} entries in {len(files)} files (limits, intervals, message texts, patterns). "
        "The table lists the ones you can override with an environment variable.\n",
        "| Value | Default | Env | File | What it does |",
        "|---|---|---|---|---|",
    ]
    for fname, key, e in rows:
        default = code(e["value"])
        if e.get("unit"):
            default += f" {cell(e['unit'])}"
        out.append(f"| `{key}` | {default} | {code(e['env'])} | `{fname}` | {cell(e.get('doc', ''))} |")
    out.append("")
    return out


# --------------------------------------------------------------------------- changelog page

CHANGELOG_FRONT = """\
---
title: Changelog
description: What changed in each anti-hall release.
---

"""


def render_changelog(text):
    return CHANGELOG_FRONT + text


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--engine-defaults", type=pathlib.Path, default=None,
                    help="directory of engine *.toml defaults (default: the plugin's, when present)")
    ap.add_argument("--repo-url", default="https://github.com/talas9/anti-hall")
    args = ap.parse_args()

    text = SCHEMA.read_text(encoding="utf-8")
    try:
        sections = read_const(text, "SECTIONS")
    except ParseError as e:
        sys.exit(f"site_gen: {e}")
    if not isinstance(sections, list) or not sections:
        sys.exit("site_gen: SECTIONS is empty or not an array")
    for sec in sections:
        for field in ("key", "label", "settings"):
            if field not in sec:
                sys.exit(f"site_gen: a section has no {field!r}")
        for s in sec["settings"]:
            if "key" not in s or "type" not in s:
                sys.exit(f"site_gen: a setting in {sec['key']} has no key or type")

    engine_dir = args.engine_defaults
    if engine_dir is None and ENGINE_DEFAULTS.is_dir():
        engine_dir = ENGINE_DEFAULTS
    if engine_dir is not None:
        engine_dir = engine_dir.resolve()
        if not engine_dir.is_dir():
            sys.exit(f"site_gen: {engine_dir} is not a directory")
        if not engine_dir.is_relative_to(ROOT):
            # A copy outside the repo (for testing) is shown under the shipped path.
            engine_dir = _Relabel(engine_dir)

    OUT_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    OUT_SETTINGS.write_text(render_settings(sections, engine_dir, args.repo_url), encoding="utf-8")
    OUT_CHANGELOG.write_text(render_changelog(CHANGELOG.read_text(encoding="utf-8")), encoding="utf-8")
    n = sum(len(sec["settings"]) for sec in sections)
    print(f"site_gen: {OUT_SETTINGS.relative_to(ROOT)} ({n} settings), {OUT_CHANGELOG.relative_to(ROOT)}")


class _Relabel:
    """A defaults directory outside the repo (a test copy), shown under the shipped path."""

    def __init__(self, real):
        self.real = real

    def glob(self, pattern):
        return self.real.glob(pattern)

    def relative_to(self, _root):
        return ENGINE_DEFAULTS.relative_to(ROOT)


if __name__ == "__main__":
    main()
