// Batch-3 additions to the `ah` API (per-session state files). Shaped from the raw `ahHost` functions the engine installs.
'use strict';
ah.sessionState = {
  // `session_key`: every character outside letters, digits, dot, underscore and hyphen becomes `_` (one per UTF-16 unit),
  // cut to `guardkit.session_key_max` units.
  key: function (sid) { return String(sid).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, ah.cfgNum('guardkit.session_key_max')); },
  homeOk: function () { return ahHost.stateHomeOk(); },
  get: function (ns, key) { return ahNull(ahHost.stateGet(ns, key)); },
  // Whether the state file can be read exactly as Node reads it.
  probe: function (ns, key) { return ahHost.stateProbe(ns, key); },
  // Atomic read-modify-write: fn(current text or null) returns the new text, or null to leave the file as it is.
  update: function (ns, key, fn) { return ahHost.stateUpdate(ns, key, function (cur) { return ahNull(fn(ahNull(cur))); }); },
};
// Shell-command scanning and platform (raw primitives; the rules that use them live in the check scripts).
ah.shell = {
  // A heredoc opener at code point `i` of `cmd` (not inside arithmetic): {end, openerLen} in code points, or null.
  heredocAt: function (cmd, i) { var r = ahHost.shellHeredocAt(cmd, i); return r === undefined || r === null ? null : { end: r[0], openerLen: r[1] }; },
};
ah.platform = function () { return ahHost.platform(); };
// Transcript tail, quoted-text masking and Jev (raw primitives; the questions and rules live in the check scripts).
ah.fs.readTail = function (p, window) { return ahNull(ahHost.readTail(p, window)); };
// The lines of that window (`split('\n')`, or `split(/\r?\n/)` with `crlf`), only those holding one of `needles` when given: null when unreadable.
// Whether that window holds one of `needles`, or its lower-cased text one of `lowerNeedles` (already lower case): null when unreadable.
ah.fs.tailHasAny = function (p, window, needles, lowerNeedles) { return ahNull(ahHost.tailHasAny(p, window, needles || [], lowerNeedles || [])); };
ah.fs.tailLines = function (p, window, crlf, needles) { return ahNull(ahHost.tailLines(p, window, !!crlf, needles || [])); };
// The same lines, newest first, at most `max` of them (0 = all): for a script that wants only the newest of some kind.
ah.fs.tailLinesNewest = function (p, window, crlf, needles, max) { return ahNull(ahHost.tailLinesNewest(p, window, !!crlf, needles || [], max || 0)); };
ah.text = { maskQuoted: function (t) { return ahHost.maskQuoted(t); } };
Object.assign(ah.jev, {
  mode: function (id) { return ahHost.jevMode(id); },
  // spec: {id, question:{type,instructions,criteria:[[k,t]...]}, state, trust, baseline, ...}; detached unless spec.sync.
  ask: function (spec) { var r = ahHost.jevAskSpec(JSON.stringify(spec)); return r === undefined || r === null ? null : JSON.parse(r); },
});
// The speculation judge's model call (raw primitive; the decision and the state live in the check script). spec: {transcript, message}.
// Returns {decision} (the model's parsed answer, or null when the call produced none), or null when the call cannot be made here: this
// process may not wait for a model (check `canBlock` first), or a transcript line cannot be read exactly as Node reads it.
ah.judge = {
  // Whether this process may wait seconds for the model call (a one-shot dispatcher or command); the daemon may not.
  canBlock: function () { return ahHost.judgeBlockingAllowed() === true; },
  cli: function (spec) { var r = ahHost.judgeCliCall(JSON.stringify(spec)); return r === undefined || r === null ? null : JSON.parse(r); },
};
