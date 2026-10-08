// Pure POSIX path functions with Node's `path.posix` semantics (the engine's `ah.path` covers the few the older checks needed;
// guards that normalize text paths use these). No file system access.
'use strict';
var posix = (function () {
  function normalizeString(path, allowAboveRoot) {
    var res = '', lastSegmentLength = 0, lastSlash = -1, dots = 0, code = 0;
    for (var i = 0; i <= path.length; ++i) {
      if (i < path.length) code = path.charCodeAt(i);
      else if (code === 47) break;
      else code = 47;
      if (code === 47) {
        if (lastSlash === i - 1 || dots === 1) { /* nothing */ }
        else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
            if (res.length > 2) {
              var li = res.lastIndexOf('/');
              if (li === -1) { res = ''; lastSegmentLength = 0; }
              else { res = res.slice(0, li); lastSegmentLength = res.length - 1 - res.lastIndexOf('/'); }
              lastSlash = i; dots = 0; continue;
            } else if (res.length !== 0) { res = ''; lastSegmentLength = 0; lastSlash = i; dots = 0; continue; }
          }
          if (allowAboveRoot) { res += res.length > 0 ? '/..' : '..'; lastSegmentLength = 2; }
        } else {
          if (res.length > 0) res += '/' + path.slice(lastSlash + 1, i); else res = path.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i; dots = 0;
      } else if (code === 46 && dots !== -1) { ++dots; } else { dots = -1; }
    }
    return res;
  }
  function normalize(p) {
    if (p.length === 0) return '.';
    var isAbs = p.charCodeAt(0) === 47, trailing = p.charCodeAt(p.length - 1) === 47;
    var path = normalizeString(p, !isAbs);
    if (path.length === 0) return isAbs ? '/' : (trailing ? './' : '.');
    if (trailing) path += '/';
    return isAbs ? '/' + path : path;
  }
  function dirname(p) {
    if (p.length === 0) return '.';
    var hasRoot = p.charCodeAt(0) === 47, end = -1, matched = true;
    for (var i = p.length - 1; i >= 1; --i) {
      if (p.charCodeAt(i) === 47) { if (!matched) { end = i; break; } } else matched = false;
    }
    if (end === -1) return hasRoot ? '/' : '.';
    if (hasRoot && end === 1) return '//';
    return p.slice(0, end);
  }
  function basename(p) {
    var e = p.length;
    while (e > 0 && p.charCodeAt(e - 1) === 47) e--;
    if (e === 0) return '';
    return p.slice(p.lastIndexOf('/', e - 1) + 1, e);
  }
  function join() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) if (arguments[i].length > 0) parts.push(arguments[i]);
    return parts.length === 0 ? '.' : normalize(parts.join('/'));
  }
  // `cwd` stands for process.cwd() when no argument is absolute.
  function resolveIn(cwd, args) {
    var resolved = '', abs = false;
    for (var i = args.length - 1; i >= -1 && !abs; i--) {
      var p = i >= 0 ? args[i] : cwd;
      if (p.length === 0) continue;
      resolved = p + '/' + resolved;
      abs = p.charCodeAt(0) === 47;
    }
    resolved = normalizeString(resolved, !abs);
    if (abs) return '/' + resolved;
    return resolved.length > 0 ? resolved : '.';
  }
  return { normalize: normalize, dirname: dirname, basename: basename, join: join, resolveIn: resolveIn, isAbsolute: function (p) { return p.charCodeAt(0) === 47; } };
})();
