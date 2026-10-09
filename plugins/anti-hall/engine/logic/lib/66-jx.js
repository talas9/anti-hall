// JavaScript-exactness helpers shared by the task, reply and routing check scripts (D88 batch 6). A check script runs in the same
// language the Node hooks do, so most of the "does JavaScript read this the same way" questions the compiled ports had to answer
// do not arise; these cover the few that remain at the boundary with the engine (strings that cross it, files it caps).
'use strict';
var jxReMemo = { gen: -1, map: {} };
var jx = {
  // The regular expression of the defaults entry `key` (JavaScript syntax, compiled once per defaults generation); `flags` as RegExp's.
  re: function (key, flags) {
    var g = ahHost.cfgGen();
    if (g !== jxReMemo.gen) { jxReMemo.gen = g; jxReMemo.map = {}; }
    var id = key + '/' + (flags || '');
    var r = jxReMemo.map[id];
    if (r === undefined) { r = new RegExp(ah.cfg(key), flags || ''); jxReMemo.map[id] = r; }
    r.lastIndex = 0;
    return r;
  },
  // `text.slice(0, max)` without a trailing lone high surrogate (a half pair cannot cross into the engine; the compiled ports cut at
  // whole characters).
  sliceUnits: function (t, max) {
    var s = t.slice(0, max);
    var last = s.length ? s.charCodeAt(s.length - 1) : 0;
    return last >= 0xd800 && last <= 0xdbff && t.length > s.length ? s.slice(0, -1) : s;
  },
  // ASCII-only lowercase (the compiled ports' `to_ascii_lowercase`).
  asciiLower: function (t) { return t.replace(/[A-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 32); }); },
  // The UTF-8 length of a string in bytes.
  utf8Len: function (t) { var n = 0; for (var i = 0; i < t.length; i++) { var c = t.charCodeAt(i); if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3; } return n; },
  // `text` with every match of the pattern `src` (the engine's linear-time matcher, flags as ah.re's) replaced by `repl`.
  replaceAll: function (src, flags, t, repl) {
    var hits = ah.re.findAll(src, flags, t), out = '', at = 0;
    for (var i = 0; i < hits.length; i++) { out += t.slice(at, hits[i][0]) + repl; at = hits[i][1]; }
    return out + t.slice(at);
  },
  // update.js `isSemver`: N.N.N with an optional - or + suffix, after trimming and dropping one leading v.
  isSemver: function (v) {
    var t = String(v).trim().replace(/^[vV]/, ''), i = t.search(/[-+]/);
    var core = i < 0 ? t : t.slice(0, i), suffix = i < 0 ? null : t.slice(i + 1);
    var nums = core.split('.');
    return nums.length === 3 && nums.every(function (n) { return /^[0-9]+$/.test(n); }) && (suffix === null || /^[A-Za-z0-9.-]+$/.test(suffix));
  },
  // update.js `compareVersions`: -1, 0 or 1 over the leading dotted numbers (a missing part counts as 0, unparsable as [0]).
  cmpVersions: function (a, b) {
    function parts(v) { var m = /^([0-9]+(?:\.[0-9]+)*)/.exec(String(v).trim().replace(/^[vV]/, '')); return m ? m[1].split('.').map(Number) : [0]; }
    var pa = parts(a), pb = parts(b), n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) { var x = i < pa.length ? pa[i] : 0, y = i < pb.length ? pb[i] : 0; if (x < y) return -1; if (x > y) return 1; }
    return 0;
  },
  // True when `s` holds a lone UTF-16 surrogate. Such a string cannot cross into the engine (a Rust string cannot hold one), so a
  // script that would hash it or send it to Jev defers instead.
  loneSurrogate: function (s) { return /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(s); },
  // JSON.parse mapped to {v} (a value), {invalid: true} (JavaScript rejects the text too) or {unsure: true} (the interpreter ran out
  // of stack or memory, which V8 might not: the caller defers).
  parse: function (t) {
    try { return { v: JSON.parse(t) }; } catch (e) { return e && e.name === 'SyntaxError' ? { invalid: true } : { unsure: true }; }
  },
  // A file's text: {text}, {absent: true} (missing, a directory, unreadable) or {big: true} (over the read cap: the caller defers,
  // because a capped read would show a different file).
  read: function (path) {
    var size = ah.fs.size(path);
    if (size === null) return { absent: true };
    if (size > ah.cfgNum('script.read_max_bytes')) return { big: true };
    var t = ah.fs.readText(path, size + 1);
    return t === null ? { absent: true } : { text: t };
  },
  // `typeof v === 'object' && v !== null` and not an array: what a Rust-side "is an object" test means.
  isObj: function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); },
  // `obj[key]` for an object, undefined for anything else (the compiled ports read fields only off objects).
  field: function (v, key) { return jx.isObj(v) ? v[key] : undefined; },
  // JavaScript truthiness of a JSON value.
  truthy: function (v) { return !!v; },
  // Date.parse of the one timestamp form Claude Code writes (YYYY-MM-DDTHH:MM:SS[.mmm]Z): milliseconds, NaN for text with no digit,
  // or undefined for any other form (which only V8 could read exactly: the caller defers).
  isoMs: function (s) {
    if (typeof s !== 'string') return NaN;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(s)) {
      var ms = Date.parse(s);
      var dt = new Date(ms);
      // a day past the end of its month, an hour of 24: not valid ISO, only V8 could say what it reads
      return isNaN(ms) || dt.toISOString().slice(0, 19) !== s.slice(0, 19) ? undefined : ms;
    }
    return /\d/.test(s) ? undefined : NaN;
  },
  // Date.parse of an ISO-8601 date-time with `Z` or a `+hh:mm` offset exactly as V8 reads it (a day past the end of its month rolls over;
  // an hour of 24 is only midnight): milliseconds, NaN where V8 answers NaN, or undefined for any other form (V8's legacy parser or the
  // local time zone might accept it: the caller defers).
  dateParse: function (s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(s);
    if (!m) return undefined;
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = +m[6], ms = 0, off = 0;
    if (m[7] !== undefined) for (var i = 0; i < 3; i++) ms = ms * 10 + (i < m[7].length ? +m[7].charAt(i) : 0);
    if (m[9] !== undefined) {
      var oh = +m[10], om = +m[11];
      if (oh > 23 || om > 59) return NaN;
      off = (oh * 60 + om) * (m[9] === '-' ? -1 : 1);
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || se > 59 || (h === 24 && (mi !== 0 || se !== 0 || ms !== 0))) return NaN;
    var yy = mo <= 2 ? y - 1 : y, era = Math.floor(yy / 400), yoe = yy - era * 400;
    var doy = Math.floor((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5);
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    var days = era * 146097 + doe - 719468 + (d - 1);
    return (((days * 24 + h) * 60 + mi - off) * 60 + se) * 1000 + ms;
  },
};
