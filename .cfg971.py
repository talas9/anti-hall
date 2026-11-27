import sys, tomllib
p = sys.argv[1]
s = open(p, encoding="utf-8").read()


def rep(old, new):
    global s
    assert s.count(old) == 1, (old[:60], s.count(old))
    s = s.replace(old, new)


# redirections: < /dev/null input is harmless; a .git path under /tmp is repo config
rep(r"""redirs = '\A(?:[0-9]*>&(?:[0-9]+|-)|[0-9]*<&-|(?:[0-9]*|&)>>?\|?(?:/dev/null|/(?:private/)?tmp/[A-Za-z0-9._/+=@%,:-]+))\z'""",
    r"""redirs = '\A(?:[0-9]*>&(?:[0-9]+|-)|[0-9]*<&-|[0-9]*</dev/null|(?:[0-9]*|&)>>?\|?(?:/dev/null|/(?:private/)?tmp/[A-Za-z0-9._/+=@%,:-]+))\z', redirs_inert = '\A(?:[0-9]*>&(?:[0-9]+|-)|[0-9]*<&-|[0-9]*</dev/null|(?:[0-9]*|&)>>?\|?/dev/null)\z', after_write = '\A[ \t]*(?:echo|printf|grep|egrep|fgrep|rg|cat|head|tail|wc|ls|ps|pgrep|du|df|uptime|stat|which)(?:[ \t][^;&|`$()<>\r\n]*)?(?:[ \t]*\|[ \t]*(?:echo|printf|grep|egrep|fgrep|rg|cat|head|tail|wc|ls|cut|tr|column|nl|tac|rev)(?:[ \t][^;&|`$()<>\r\n]*)?)*\z'""")
rep(r"""redirs_unless = '(?:\A|/)\.\.(?:/|\z)'""",
    r"""redirs_unless = '(?:\A|/)\.\.(?:/|\z)|/\.git(?:/|\z)'""")
# commands that rebind a name or run code later (zsh and bash)
rep('''"function", "alias", "hash"]''',
    '''"function", "alias", "hash", "autoload", "unfunction", "unalias", "unhash", "enable", "disable", "zmodload", "setopt", "unsetopt", "emulate", "trap", "print", "integer", "float", "functions"]''')
rep('''"AH_*", "ANTIHALL_*", "GIT_*"]''',
    '''"AH_*", "ANTIHALL_*", "GIT_*", "commands", "functions", "aliases", "galiases", "saliases", "builtins", "options", "parameters", "nameddirs", "dis_*"]''')

# config-write hold rule: a write into the agent configuration
home = r"""(?:~|\$\{?HOME\}?|/Users/[^/\s;&|'"]+|/home/[^/\s;&|'"]+|/root)"""
ah_alts = r"""[^wh]|w(?:[^o]|\z)|wo(?:[^r]|\z)|wor(?:[^k]|\z)|work(?:[^/]|\z)|h(?:[^i]|\z)|hi(?:[^s]|\z)|his(?:[^t]|\z)|hist(?:[^o]|\z)|histo(?:[^r]|\z)|histor(?:[^y]|\z)|history(?:[^/]|\z)|(?:work|history)/[^\s;&|]*\.\.|\z"""
target = (r"""(?:""" + home + r"""/(?:\.(?:claude|codex)\b|\.anti-hall(?:/(?:""" + ah_alts + r""")|[^/]|\z))"""
          r"""|\$\{?(?:CLAUDE_CONFIG_DIR|CODEX_HOME)\b|\.claude/settings[^/\s;&|]*\.json|\.mcp\.json)""")
word = r"""[^\s;&|<>'"]*?"""
rule = (r"""(?:>|<>)[>|]?[ \t]*['"]?""" + word + target
        + r"""|\btee\b[^|;&\n]*?[\s'"=]""" + word + target
        + r"""|\b(?:cp|mv|ln|install|rsync)\b[^|;&\n]*[\s'"=]""" + word + target + r"""[^\s;&|'"]*['"]?[ \t]*(?:\z|[;&|\n)])"""
        + r"""|\b(?:cp|mv|ln|install)\b[^|;&\n]*\s(?:-t[ \t]*|--target-directory[= \t]+)['"]?""" + word + target)
assert "'" in rule
# a TOML literal string can not hold a single quote: use a basic string
basic = rule.replace("\\", "\\\\").replace('"', '\\"')
rep("""rules = { git-push = ""","""rules = { config-write = \"""" + basic + """\", git-push = """)

d = tomllib.loads(s)
v = d["dispatch"]["capacity_hold"]["value"]
assert v["rules"]["config-write"] == rule
open(p, "w", encoding="utf-8").write(s)
print("ok")
