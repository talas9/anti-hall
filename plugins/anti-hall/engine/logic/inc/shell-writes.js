// The files a Bash command writes and the text it writes where the command shows it: a translation of hooks/lib/shell-writes.js
// for the guards that judge shell writes like structured edits (api-guard, ship-it-guard). Not a check of its own: a check lists
// it after `command` in script.includes and calls swShellWrites inside cmdBegin/cmdEnd, because it walks command-guard's own
// parsers (forEachShellSegment, bashWriteTargets, inlineWriteLiterals, resolveWriteTarget, effectiveVerb, argvWithoutRedirects,
// segmentHeredocBodies), exactly as the Node module requires command-guard.js. The size limits are in guards_v1.toml (shell_writes.*).
'use strict';

function swMayWrite(command) {
  return typeof command === 'string' && new RegExp(ah.cfg('api_guard.shell_write_pattern')).test(command);
}

function swDecodeEscapes(s) {
  return s.replace(/\\(n|t|\\)/g, function (m, ch) { return ch === 'n' ? '\n' : ch === 't' ? '\t' : '\\'; });
}

// The text an echo/printf/cat-heredoc segment writes to stdout, or null when it is not visible.
function swProducerText(segment, bodies) {
  var verb = effectiveVerb(segment);
  if (verb === 'cat' || verb === 'tee') return bodies.length ? bodies[bodies.length - 1] + '\n' : null;
  if (verb !== 'echo' && verb !== 'printf') return null;
  var toks = argvWithoutRedirects(segment);
  var vi = toks.findIndex(function (t) { return shellScan.basename(t).toLowerCase() === verb; });
  if (vi === -1) return null;
  var args = toks.slice(vi + 1);
  if (verb === 'echo') {
    var escapes = false;
    while (args.length && /^-[neE]+$/.test(args[0])) { if (args[0].includes('e')) escapes = true; args = args.slice(1); }
    var text = args.join(' ');
    return (escapes || /\\n/.test(text) ? swDecodeEscapes(text) : text) + '\n';
  }
  if (!args.length) return null;
  return [swDecodeEscapes(args[0])].concat(args.slice(1)).join('\n') + '\n';
}

// {head, body, rest} of a command over the parse cap (see hooks/lib/shell-writes.js bigCommandParts).
function swBigParts(command) {
  var headLen = ah.cfgNum('shell_writes.head_len'), bigLen = ah.cfgNum('shell_writes.big_len');
  var nl = command.indexOf('\n');
  var first = nl === -1 ? command : command.slice(0, nl);
  var m = nl !== -1 && first.length <= headLen ? /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(first) : null;
  var cut = command.lastIndexOf('\n', headLen);
  var prefix = { head: command.slice(0, cut > 0 ? cut : headLen), body: null, rest: '' };
  if (!m) return prefix;
  var delim = m[2];
  var end = command.indexOf('\n' + delim + '\n', nl);
  var bodyEnd = end !== -1 ? end : (command.endsWith('\n' + delim) ? command.length - delim.length - 1 : -1);
  if (bodyEnd === -1) return prefix;
  var rest = end !== -1 ? command.slice(end + delim.length + 2) : '';
  return {
    head: first + '\n\n' + delim,
    body: command.slice(nl + 1, bodyEnd),
    rest: rest.trim() && rest.length <= bigLen && !/\bcd\b|\bpushd\b/.test(first) ? rest : '',
  };
}

function swBigWrites(command, payload) {
  var parts = swBigParts(command);
  var out = swShellWrites(parts.head, payload);
  if (parts.body !== null) out.forEach(function (w) { if (w.content === '\n') w.content = parts.body + '\n'; });
  if (parts.rest) swShellWrites(parts.rest, payload).forEach(function (w) { if (!out.some(function (o) { return o.abs === w.abs; })) out.push(w); });
  return out;
}

// [{abs, base, toplevel, inBase, scratch, content}], one per resolved target. A failure inside the walk is the Node module's own
// catch-all: no targets (fail open). An engine-only "unsure" (something only a Node process could see) is logged, then the same.
function swShellWrites(command, payload) {
  try {
    if (!swMayWrite(command)) return [];
    if (command.length > ah.cfgNum('shell_writes.big_len')) return swBigWrites(command, payload);
    var rootOf = projectRootResolver(payload || {});
    var byPath = new Map(), level = null;
    forEachShellSegment(command, payload || {}, function (seg, ctxs, segments, delims, i, text) {
      if (!level || level.segments !== segments) level = { segments: segments, per: segmentHeredocBodies(segments, text) };
      var bodies = level.per[i] || [];
      var content = null;
      var verb = effectiveVerb(seg);
      if (verb === 'tee' && !bodies.length && i > 0 && delims[i - 1] === '|') content = swProducerText(segments[i - 1], level.per[i - 1] || []);
      else content = swProducerText(seg, bodies);
      ctxs.forEach(function (ctx) {
        var targets = bashWriteTargets(seg, ctx.cwd).map(function (t) { return [t, content]; })
          .concat(inlineWriteLiterals(seg).map(function (t) { return [t, null]; }));
        targets.forEach(function (pair) {
          var w = resolveWriteTarget(pair[0], ctx, payload || {}, rootOf);
          if (!w) return;
          var prev = byPath.get(w.abs);
          if (!prev) byPath.set(w.abs, Object.assign(w, { content: pair[1] }));
          else if (prev.content === null && pair[1] !== null) prev.content = pair[1];
        });
      });
    });
    return Array.from(byPath.values());
  } catch (e) {
    if (cmdFatal(e) && !e.unsure) throw e; // the time or memory limit reaches the engine
    if (e && e.unsure && S) S.unsure = false;
    return [];
  }
}
