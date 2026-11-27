import sys, tomllib
for p in sys.argv[1:]:
    s = open(p, encoding="utf-8").read()

    def rep(old, new):
        global s
        assert s.count(old) == 1, (old[:70], s.count(old))
        s = s.replace(old, new)

    rep("a call whose redirection writes a file the rest of the command names again (> /tmp/r.sh; bash /tmp/r.sh) is not masked,",
        "a call that writes a file (a redirection that does not match `redirs_inert`: fd duplication, /dev/null) is never masked (#971 review: a later command may run or load what it wrote, however spelled: bash /tmp/x/\\\"r.sh\\\", cd /tmp/x; sh < r.sh), and in the parsed read exemption it passes only as the one writer of the list beside engine-local calls that write nothing and reads that match `after_write` (no git or gh: a repo config written under /tmp can run a pager),")
    rep("matching `redirs` and not `redirs_unless` (an allow list: fd duplication, /dev/null and files under /tmp; a config file, a relative path or a .. is held)",
        "matching `redirs` and not `redirs_unless` (an allow list: fd duplication, /dev/null in or out and files under /tmp; a config file, a relative path, a .. or a .git path is held)")
    rep("and the value of a `text_opts` option (--message, --summary) with no substitution and no unquoted expansion is data, whatever it holds.",
        "and the value of a `text_opts` option (--message, --summary) with no unquoted expansion and, inside double quotes, nothing but text and plain $NAME, ${NAME} or $1 is data, whatever it holds (#971 review: no substitution, operator, flag, subscript or modifier: zsh ${(e)X}, bash ${X@P} and an arithmetic subscript ${Z[Y]} or zsh $Z[Y] run code; a missing value or a redirection in its place exempts nothing). An unquoted ( ) < or > inside a word (a zsh multi-name function a b () .., a glob qualifier *(e:..:), a redirection joined to a word x>f), an assignment value the reading can not resolve (a substitution, a backtick, ${x:=..}, whether or not it runs), a pipeline that starts with an assignment (X=1 | git push: read as a whole), an unreadable cd, an assigning expansion and an append or element assignment (zsh commands[x]=, fpath+=) exempt nothing and mask nothing from there on.")
    rep("is an `assigners` command (export, eval, source, function, alias, hash)",
        "is an `assigners` command (export, eval, source, function, alias, hash; zsh autoload, setopt, emulate, trap, zmodload, enable, print, integer, float, functions)")
    rep("A plain read that only names the words passes:",
        "Rule config-write holds a write into the agent configuration (a redirection, tee, or the target of cp, mv, ln, install or rsync, into ~/.claude, ~/.codex, ~/.anti-hall except its work/ and history/ directories, $CLAUDE_CONFIG_DIR, $CODEX_HOME, any .claude/settings*.json or .mcp.json; ~, $HOME, ${HOME} and /Users/<name> spellings). A plain read that only names the words passes:")
    tomllib.loads(s)
    open(p, "w", encoding="utf-8").write(s)
print("ok")
