// JavaScript-exactness helpers shared by the task, reply and routing check scripts (D88 batch 6). A check script runs in the same
// language the Node hooks do, so most of the "does JavaScript read this the same way" questions the compiled ports had to answer
// do not arise; these cover the few that remain at the boundary with the engine (strings that cross it, files it caps).
'use strict';
var jx = {
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
};
