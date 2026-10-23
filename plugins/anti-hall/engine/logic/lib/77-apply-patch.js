// The Codex `apply_patch` parser shared by the guards that read a patch (api-guard, ship-it-guard, edit-guard): a translation of
// hooks/lib/codex-apply-patch.js, itself a port of Codex's own lenient parser (codex-rs/apply-patch parser.rs +
// streaming_parser.rs), so it accepts and rejects the same text Codex does. The markers are the patch grammar (a format, not a
// setting). `applyPatch.parse(text)` never throws: {ok: true, files: [{op, path, moveTo, addedLines}]} or {ok: false, error}.
// `applyPatch.targetPaths(files, base)` resolves every touched path (source and Move-to destination) onto `base`, an absolute
// directory, the way Codex joins them onto the turn cwd (an absolute path wins).
'use strict';
var applyPatch = (function () {
  var BEGIN = '*** Begin Patch', END = '*** End Patch', ADD = '*** Add File: ', DELETE = '*** Delete File: ';
  var UPDATE = '*** Update File: ', MOVE = '*** Move to: ', EOF_MARK = '*** End of File', CTX = '@@ ', CTX_EMPTY = '@@';
  var ENV_ID = '*** Environment ID:';

  function fail(error) { return { ok: false, error: error }; }

  // Rust str::lines(): split on \n, drop one trailing \r per line.
  function rustLines(s) {
    if (!s.length) return [];
    return s.split('\n').map(function (l) { return l.endsWith('\r') ? l.slice(0, -1) : l; });
  }

  function boundariesOk(lines) {
    if (!lines.length) return false;
    return lines[0].trim() === BEGIN && lines[lines.length - 1].trim() === END;
  }

  function parse(text) {
    if (typeof text !== 'string') return fail('patch text is not a string');
    var lines = rustLines(text.trim());
    if (!boundariesOk(lines)) {
      var first = lines[0], last = lines[lines.length - 1];
      if (lines.length >= 4 && (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith('EOF')) {
        lines = lines.slice(1, -1);
        if (!boundariesOk(lines)) return fail('patch must start with *** Begin Patch and end with *** End Patch');
      } else {
        return fail('patch must start with *** Begin Patch and end with *** End Patch');
      }
    }
    var files = [], mode = 'notStarted', envSeen = false, cur = null;

    function updateNotEmpty(line) {
      if (mode !== 'update' || !cur) return null;
      if (!cur.chunks.length) return "update hunk for '" + cur.file.path + "' is empty";
      var lastc = cur.chunks[cur.chunks.length - 1];
      if (lastc.old === 0 && lastc.nw === 0) {
        return line === END ? 'update hunk does not contain any lines' : 'unexpected line in update hunk: ' + line;
      }
      return null;
    }

    // true (handled), false (not a header), or a string error.
    function headers(trimmed) {
      if (mode === 'started' && trimmed.startsWith(ENV_ID)) {
        if (envSeen) return 'environment id specified more than once';
        if (!trimmed.slice(ENV_ID.length).trim()) return 'environment id cannot be empty';
        envSeen = true;
        return true;
      }
      var err;
      if (trimmed === END) {
        if ((err = updateNotEmpty(trimmed))) return err;
        mode = 'ended';
        return true;
      }
      var marks = [[ADD, 'add'], [DELETE, 'delete'], [UPDATE, 'update']];
      for (var k = 0; k < marks.length; k++) {
        var marker = marks[k][0], op = marks[k][1];
        if (trimmed.startsWith(marker)) {
          if ((err = updateNotEmpty(trimmed))) return err;
          var file = { op: op, path: trimmed.slice(marker.length), moveTo: null, addedLines: [] };
          files.push(file);
          mode = op;
          cur = op === 'update' ? { file: file, chunks: [] } : null;
          return true;
        }
      }
      return false;
    }

    function processLine(line) {
      var trimmed = line.trim(), h;
      switch (mode) {
        case 'notStarted':
          if (trimmed === BEGIN) { mode = 'started'; return null; }
          return 'first line must be *** Begin Patch';
        case 'started':
        case 'delete':
          h = headers(trimmed);
          if (h === true) return null;
          return typeof h === 'string' ? h : 'invalid hunk header: ' + trimmed;
        case 'add':
          h = headers(trimmed);
          if (h === true) return null;
          if (typeof h === 'string') return h;
          if (line.startsWith('+')) { files[files.length - 1].addedLines.push(line.slice(1)); return null; }
          return 'invalid hunk header: ' + trimmed;
        case 'update': {
          var u = line.replace(/\s+$/, '');
          h = headers(u);
          if (h === true) return null;
          if (typeof h === 'string') return h;
          var chunks = cur.chunks, lastc = chunks[chunks.length - 1];
          var emptyLast = !!lastc && lastc.old === 0 && lastc.nw === 0;
          if (lastc && lastc.eof) {
            if (!u.length) return null;
            if (u !== CTX_EMPTY && !u.startsWith(CTX)) return 'expected @@ after End of File';
          }
          if (!chunks.length && cur.file.moveTo === null && u.startsWith(MOVE)) {
            cur.file.moveTo = u.slice(MOVE.length);
            return null;
          }
          if ((u === CTX_EMPTY || u.startsWith(CTX)) && emptyLast) return 'unexpected line in update hunk: ' + line;
          if (u === CTX_EMPTY || u.startsWith(CTX)) { chunks.push({ old: 0, nw: 0, eof: false }); return null; }
          if (u === EOF_MARK) {
            if (emptyLast) return 'update hunk does not contain any lines';
            if (lastc) lastc.eof = true;
            return null;
          }
          var ensure = function () { if (!chunks.length) chunks.push({ old: 0, nw: 0, eof: false }); return chunks[chunks.length - 1]; };
          var c;
          if (!line.length || line.startsWith(' ')) { c = ensure(); c.old++; c.nw++; return null; }
          if (line.startsWith('+')) { c = ensure(); c.nw++; cur.file.addedLines.push(line.slice(1)); return null; }
          if (line.startsWith('-')) { c = ensure(); c.old++; return null; }
          return 'unexpected line in update hunk: ' + line;
        }
        case 'ended':
          return trimmed.length ? 'content after *** End Patch' : null;
        default:
          return 'parser state error';
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], err;
      if (i === lines.length - 1 && line.length) {
        if (line.trim() === END) {
          err = updateNotEmpty(line.trim());
          if (!err) mode = 'ended';
        } else {
          err = processLine(line);
        }
      } else {
        err = processLine(line);
      }
      if (err) return fail(err);
    }
    if (mode !== 'ended') return fail('last line must be *** End Patch');
    return { ok: true, files: files };
  }

  function targetPaths(files, base) {
    var out = [], res = function (q) { return ah.path.resolveAbs(ah.path.isAbsolute(q) ? q : base + '/' + q); };
    (files || []).forEach(function (f) {
      out.push(res(f.path));
      if (f.moveTo !== null && f.moveTo !== undefined) out.push(res(f.moveTo));
    });
    return out;
  }

  return { parse: parse, targetPaths: targetPaths };
})();
