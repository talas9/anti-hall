# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab, choose **Report a vulnerability**, and fill in the advisory form
(<https://github.com/talas9/anti-hall/security/advisories/new>). Only the maintainer can see it.

Include, as far as you can:

- the anti-hall version (`plugins/anti-hall/.claude-plugin/plugin.json`) and whether you use the Claude plugin or the Codex port;
- your OS and Node.js version;
- what an attacker can do, and the smallest steps or hook input that reproduce it;
- any logs, with secrets removed.

## Scope

anti-hall runs local Node hooks that read and write files under `~/.anti-hall/` and the project's `.anti-hall/` directory. Reports about a guard that can be bypassed, a hook that executes untrusted input, or state that leaks secrets are in scope.

Opening an untrusted repository in Claude Code can apply that repository's own settings and hooks; this is a property of the host, not of this plugin, so open only repositories you trust.

A guard that blocks something legitimate (a false positive) is not a security issue; use the false-positive issue template.

## Supported versions

Fixes land on the latest release. Please reproduce against the current version first (`/anti-hall:update`).
