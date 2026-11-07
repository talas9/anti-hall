// Depth-bound reader of the wide-search guard (wide-search-guard.js): the depth limit of a find/bfs/rg/fd command, read by ALLOWLIST.
// The limit counts only when every word of the command is understood: the tool name, a flag listed in the command's
// wide_search.commands.<name>.safe_flags (each with how it takes its value), the depth flag itself, or a plain positional (a pattern or
// a path). Any other flag, an unknown cluster letter, an unlisted `=` form, `--`, or a stray word after a find expression voids the
// limit (null: the search is judged as if it had none). Lists and forms: lane_waste.toml (wide_search.*). Pure: no file system access.
'use strict';
var wideWalk = {
  // The limit (a number) of `words` (words[0] the command) per `spec`, or null when it carries none or any word is not allow-listed.
  // The last depth flag wins, as the tools do. A depth value that is not a plain number is no limit.
  depth: function (words, spec) {
    var depthFlags = spec.depth_flags, safe = spec.safe_flags, n = words.length, last = null, seenFlag = false, i, j;
    if (!depthFlags || depthFlags.length === 0 || !safe) return null;
    var numRe = ah.cfg('wide_search.depth_value_re'), exprStart = ah.cfg('wide_search.expr_start');
    for (i = 1; i < n; i++) {
      var w = words[i];
      if (w.charAt(0) !== '-' || w.length < 2) {
        // a positional: a pattern or a path; a find-style command takes none after its expression starts
        if (spec.style === 'paths-first' && (seenFlag || exprStart.indexOf(w) >= 0)) return null;
        continue;
      }
      seenFlag = true;
      var v = null, isDepth = false;
      for (j = 0; j < depthFlags.length && !isDepth; j++) {
        if (w === depthFlags[j]) {
          if (i + 1 >= n) return null;
          v = words[++i]; isDepth = true;
        } else if (depthFlags[j].indexOf('--') === 0 && w.indexOf(depthFlags[j] + '=') === 0) {
          v = w.slice(depthFlags[j].length + 1); isDepth = true;
        }
      }
      if (isDepth) { last = ah.re.test(numRe, 'r', v) ? parseInt(v, 10) : null; continue; }
      var step = wideWalk.safeStep(w, safe);
      if (step < 0) return null;
      if (step === 1) { if (i + 1 >= n) return null; i++; }
    }
    return last;
  },
  // How the allow-listed flag word `w` consumes words: 0 = alone (or its value is inside it), 1 = the NEXT word is its value,
  // -1 = not allow-listed (the caller voids the limit).
  safeStep: function (w, safe) {
    var has = Object.prototype.hasOwnProperty, e, forms, k;
    if (has.call(safe, w)) {
      e = safe[w];
      if (e === '0') return 0;
      return e.split('+').indexOf('sep') >= 0 ? 1 : -1;
    }
    if (w.charAt(1) === '-') {
      k = w.indexOf('=');
      if (k > 0 && has.call(safe, w.slice(0, k)) && safe[w.slice(0, k)].split('+').indexOf('eq') >= 0) return 0;
      return -1;
    }
    // short flags: `-td` (a value flag with its value attached), or a cluster whose every letter is a flag without a value
    if (w.length > 2 && has.call(safe, w.slice(0, 2)) && safe[w.slice(0, 2)] !== '0') {
      forms = safe[w.slice(0, 2)].split('+');
      return forms.indexOf('att') >= 0 ? 0 : -1;
    }
    for (k = 1; k < w.length; k++) if (!has.call(safe, '-' + w.charAt(k)) || safe['-' + w.charAt(k)] !== '0') return -1;
    return w.length > 2 ? 0 : -1;
  },
};
