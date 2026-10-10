"""MkDocs hooks for the anti-hall docs site (stdlib only; loaded by mkdocs.yml `hooks:`).

1. Links. The docs are written to work on GitHub, so they link to files outside docs/
   (`../CHANGELOG.md`, `../plugins/...`). On the site:
   - a link to a file the site renders from a generated page (CHANGELOG.md, the settings
     schema) goes to that page;
   - a link to any other repository file goes to that file on GitHub;
   - links inside fenced code blocks and inline code are left alone.
   Generated pages keep the links of their source file working: `docs/changelog.md` is
   resolved as if it were CHANGELOG.md at the repository root.
2. "Edit this page" on a generated page points at the source file it was built from.
3. Research notes (the Background section) get a banner saying they are not user docs.
"""

import posixpath
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
REPO_URL = "https://github.com/talas9/anti-hall"
BRANCH = "main"

# Site page (relative to docs/) -> the repository file it is generated from.
GENERATED = {
    "changelog.md": "CHANGELOG.md",
    "settings/reference.md": "plugins/anti-hall/hooks/lib/settings-schema.js",
}
ORIGIN_TO_PAGE = {origin: page for page, origin in GENERATED.items()}

RESEARCH = re.compile(
    r"^(KB-(?!jev-classifier\.md$)[^/]+|CONTEXT-PRESERVATION-KB|CODEX-KB-MIGRATION-MAP|keynote-[^/]+|opus-4-8-[^/]+"
    r"|gsd-distilled|superpowers-planning)\.md$"
)
RESEARCH_NOTE = (
    '!!! note "Research note"\n'
    "    This page is background research kept for the project's own reference. It is not "
    "user documentation, it is not kept up to date with every release, and model or product "
    "details in it may be out of date. For how anti-hall works today, start at the "
    "[home page]({home}).\n"
)

FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
INLINE_LINK = re.compile(r"(\]\()(<[^>]*>|[^)\s]+)((?:\s+\"[^\"]*\")?\))")
REF_DEF = re.compile(r"^(\s{0,3}\[[^\]]+\]:\s*)(\S+)(.*)$")
HTML_ATTR = re.compile(r"""(\b(?:href|src)=")([^"]+)(")""")
SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def _origin(src_uri):
    return GENERATED.get(src_uri, "docs/" + src_uri)


def _rewrite(href, page_src, files):
    if not href or href.startswith(("#", "/", "{")) or SCHEME.match(href):
        return href
    wrapped = href.startswith("<") and href.endswith(">")
    raw = href[1:-1] if wrapped else href
    m = re.match(r"^([^#?]*)([#?].*)?$", raw)
    path_part, suffix = m.group(1), m.group(2) or ""
    if not path_part:
        return href
    origin = _origin(page_src)
    target = posixpath.normpath(posixpath.join(posixpath.dirname(origin), unquote(path_part)))
    if target.startswith(".."):
        return href
    page_dir = posixpath.dirname(page_src) or "."

    site_target = None
    if target in ORIGIN_TO_PAGE:
        site_target = ORIGIN_TO_PAGE[target]
    elif target.startswith("docs/"):
        inner = target[len("docs/"):]
        f = files.get_file_from_path(inner)
        if f is not None and not f.inclusion.is_excluded():
            site_target = inner
    if site_target is not None:
        new = posixpath.relpath(site_target, page_dir) + suffix
    elif (ROOT / target).exists():
        kind = "tree" if (ROOT / target).is_dir() else "blob"
        new = f"{REPO_URL}/{kind}/{BRANCH}/{target}{suffix}"
    else:
        return href  # unknown target: leave it so mkdocs --strict reports it
    return f"<{new}>" if wrapped else new


def _rewrite_line(line, page_src, files):
    # Only rewrite outside inline code spans (even-numbered pieces between backticks).
    parts = line.split("`")
    for n in range(0, len(parts), 2):
        seg = parts[n]
        seg = INLINE_LINK.sub(lambda m: m.group(1) + _rewrite(m.group(2), page_src, files) + m.group(3), seg)
        seg = HTML_ATTR.sub(lambda m: m.group(1) + _rewrite(m.group(2), page_src, files) + m.group(3), seg)
        parts[n] = seg
    line = "`".join(parts)
    m = REF_DEF.match(line)
    if m:
        line = m.group(1) + _rewrite(m.group(2), page_src, files) + m.group(3)
    return line


def on_page_markdown(markdown, page, config, files, **kwargs):
    src = page.file.src_uri
    out, fence = [], None
    for line in markdown.split("\n"):
        fm = FENCE.match(line)
        if fence is None and fm:
            fence = fm.group(1)[0] * len(fm.group(1))
            out.append(line)
            continue
        if fence is not None:
            if line.strip().startswith(fence) and line.strip().strip(fence[0]) == "":
                fence = None
            out.append(line)
            continue
        out.append(_rewrite_line(line, src, files))
    text = "\n".join(out)

    if RESEARCH.match(src):
        home = posixpath.relpath("index.md", posixpath.dirname(src) or ".")
        note = RESEARCH_NOTE.format(home=home)
        h1 = re.search(r"^# .*$", text, re.M)
        if h1:
            text = text[:h1.end()] + "\n\n" + note + text[h1.end():]
        else:
            text = note + "\n" + text
    return text


def on_page_context(context, page, config, nav, **kwargs):
    origin = GENERATED.get(page.file.src_uri)
    if origin:
        page.edit_url = f"{REPO_URL}/edit/dev/{origin}"
    return context
