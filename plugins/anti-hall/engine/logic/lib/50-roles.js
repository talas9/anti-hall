// Caller roles (owner feature 22): who is calling, which engine verbs that role may run, and the refusal text. The matrix, the
// markers and every text are in roles.toml (roles.*). Mirrors ah-engine src/roles.rs, which gates the command line.
'use strict';
var roles = {
  // 'subagent' | 'workspace' | 'codex' | 'main'; the payload tells a subagent, the environment a workspace child.
  detect: function (p, host) {
    if (coordinator.subagentByPayload(p)) return 'subagent';
    var branch = ah.env.get(ah.cfg('roles.branch_env'));
    if (branch !== null && branch !== '') return 'workspace';
    return host === 'codex' || coordinator.payloadIsCodex(p) ? 'codex' : 'main';
  },
  row: function (verb) {
    var m = ah.cfg('roles.matrix');
    return Object.prototype.hasOwnProperty.call(m, verb) ? m[verb] : null;
  },
  verbsFor: function (role) {
    var m = ah.cfg('roles.matrix');
    return Object.keys(m).filter(function (v) { return m[v].roles.indexOf(role) >= 0; });
  },
  // null when the role may run it, else the refusal text.
  refusal: function (role, verb, args) {
    var r = roles.row(verb);
    if (r === null) return null;
    var ownerRoles = ah.cfg('roles.owner_roles');
    var owner = (r.owner_args || []).some(function (o) { return args.indexOf(o) >= 0; });
    if (r.roles.indexOf(role) < 0 || (owner && ownerRoles.indexOf(role) < 0)) {
      var pool = owner ? r.roles.filter(function (x) { return ownerRoles.indexOf(x) >= 0; }) : r.roles;
      return text.render(ah.cfg('roles.msg_refuse'), {
        verb: verb, role: role, allowed: pool.join(', '),
        why: ah.cfg(owner ? 'roles.msg_why_owner' : 'roles.msg_why_other'),
      });
    }
    if ((r.self_only || []).indexOf(role) >= 0) {
      var me = ah.env.get(ah.cfg('roles.builder_env')) || '';
      var flags = ah.cfg('roles.self_flags');
      for (var i = 0; i < args.length; i++) {
        if (flags.indexOf(args[i]) >= 0 && i + 1 < args.length && args[i + 1] !== me) {
          return text.render(ah.cfg('roles.msg_refuse_self'), { verb: verb, target: args[i + 1], self: me });
        }
      }
    }
    return null;
  },
  // The quoted spans of a Bash command as { s, e, kind } (kind "'" or '"', s the opening quote, e one past the closing one or
  // the end of the text). A heredoc body is a span of kind "h" (`quoted`: its delimiter is quoted, so nothing in it is expanded):
  // it is text for `cat`/`tee`, and runs only where a shell or script word reads it (quotedRuns).
  quotedSpans: function (cmd) {
    var spans = [], n = cmd.length, j = 0;
    while (j < n) {
      var c = cmd[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '<' && cmd[j + 1] === '<') {
        var h = shellScan.parseHeredocRaw(cmd, j);
        if (h) { spans.push({ s: j, e: h.end, kind: 'h', quoted: h.quoted }); j = Math.max(h.end, j + 2); continue; }
        j += 2; continue;
      }
      if (c === "'" || c === '"') {
        var k = j + 1;
        while (k < n && cmd[k] !== c) k += c === '"' && cmd[k] === '\\' ? 2 : 1;
        spans.push({ s: j, e: Math.min(k + 1, n), kind: c });
        j = k + 1; continue;
      }
      j++;
    }
    return spans;
  },
  // Whether the engine name at `at` inside quoted span `q` runs: a `$(` or backtick before it in a double-quoted span (a command
  // substitution), or a span that is the script of a shell or of one of roles.script_words in the same simple command
  // (`sh -c '...'`, `eval "..."`). Anything else in quotes is text, such as a commit message that names a verb.
  quotedRuns: function (cmd, q, at) {
    if ((q.kind === '"' || (q.kind === 'h' && !q.quoted)) && /\$\(|`/.test(cmd.slice(q.s + 1, at))) return true;
    var head = cmd.slice(0, q.s), cut = Math.max(head.lastIndexOf(';'), head.lastIndexOf('&'), head.lastIndexOf('|'), head.lastIndexOf('\n'), head.lastIndexOf('('));
    var words = head.slice(cut + 1).split(/\s+/), shells = shellScan.shellVerbs(), extra = ah.cfg('roles.script_words');
    return words.some(function (w) { var b = shellScan.basename(w.replace(/^["']+|["']+$/g, '')); return shells.has(b) || extra.indexOf(b) >= 0; });
  },
  // Every engine invocation in a Bash command as { verb, args }, leading flags such as --json skipped. An engine name inside
  // quoted text counts only where the shell would run it (quotedRuns).
  invocations: function (cmd) {
    var out = [], hits = ah.re.findAll(ah.cfg('roles.bash_re'), 'r', cmd), spans = null, bin = ah.cfg('roles.engine_bin');
    for (var i = 0; i < hits.length; i++) {
      var at = cmd.lastIndexOf(bin, hits[i][1]);
      if (spans === null) spans = roles.quotedSpans(cmd);
      var q = spans.find(function (x) { return at > x.s && at < x.e; });
      if (q && !roles.quotedRuns(cmd, q, at)) continue;
      var rest = cmd.slice(hits[i][1]);
      var cut = rest.search(/[;&|\n)`]/);
      if (cut >= 0) rest = rest.slice(0, cut);
      // a word that closes the quote it ran in (`sh -c "ah-engine stop"`) loses that quote
      var toks = rest.split(/\s+/).map(function (t) { return t.replace(/^["']+|["']+$/g, ''); }).filter(function (t) { return t !== ''; });
      while (toks.length > 0 && toks[0].charAt(0) === '-') toks.shift();
      if (toks.length > 0) out.push({ verb: toks[0], args: toks.slice(1) });
    }
    return out;
  },
};
