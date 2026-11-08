// #547: `sh|bash <script>` is judged by the body of the script, so a wrapper and its raw command get the same verdict (the host reads the
// script as git-guard does, up to script.read_max_bytes). Pure helpers of command.js; its per-check scope is private, so command.js
// passes the call state and the helpers it owns (scriptRunToken, effectiveVerb, resolveScriptPath, T) in.
'use strict';
var wrapScript = {
  // The working directory the script path resolves against: the session's absolute cwd, else '' (the feature is then off).
  cwd: function (payload) {
    return (payload && typeof payload.cwd === 'string' && payload.cwd.charAt(0) === '/') ? payload.cwd : '';
  },
  // The body of the script `seg` runs, or null when the call is no literal shell-script run, the setting is off, or the script cannot
  // be read (the wrapper is then judged as written).
  body: function (seg, S, scriptRunToken, effectiveVerb, resolveScriptPath, T) {
    if (!S || !S.wrapCwd || !ah.settings.bool('command.sw_resolve_wrapper_scripts')) return null;
    var run = null, verb = '';
    try { run = scriptRunToken(seg); verb = effectiveVerb(seg).replace(/["']/g, ''); } catch (_) { return null; }
    if (!run || run.direct || !T.scriptShells.has(verb)) return null;
    var r = resolveScriptPath(run.token, { cwd: S.wrapCwd, cwdUnknown: false });
    if (!r || r.unresolvable) return null;
    var size = ah.fs.size(r.real), cap = ah.cfgNum('script.read_max_bytes');
    if (size === null || size > cap) return null;
    return ah.fs.readText(r.real, cap);
  },
  // Records whether the script's verdict (`heavy`) differs from the wrapper's; returns `heavy`.
  note: function (S, heavy) {
    if (S && S.wrapResolved !== 'differs') S.wrapResolved = heavy ? 'differs' : 'same';
    return heavy;
  },
  // Counts the resolved wrapper once per call.
  count: function (S) {
    if (S.wrapResolved) { try { ah.metric('command_wrapper_resolved', ['verdict', S.wrapResolved]); } catch (e) { /* counting never fails a hook */ } }
  }
};
