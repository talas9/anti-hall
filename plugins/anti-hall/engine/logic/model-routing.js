// check = "model-routing" (PreToolUse on Agent and Task; mirrors hooks/model-routing-guard.js). Nudges agent spawns toward the cheapest
// model that fits the task SHAPE: execution-shaped work belongs on haiku, planning-shaped work on opus or fable. An anti-waste net,
// not a security boundary: it classifies by keyword signals in the spawn's description and prompt. The block path fires only on the
// unambiguous misroute (mechanical-only work pinned to a flagship model on a generic agent, or an omitted model in strict mode), and a
// debate-role word, a research reading or a Jev relaxation downgrades it to an advisory. Every answer rides a Routed verdict: the
// verdict plus the route telemetry row the daemon records (what was asked for, what the table recommended, what the check did).
// Rows and exemptions keep the Node order. Keys, signal lists, patterns and texts: small_guards.toml (model_routing.*).
'use strict';

// The number of phrases of the list `key` that occur as consecutive tokens. `set` holds the distinct tokens, so a phrase whose first
// word is absent is dismissed at once and only the occurrences of a first word are walked (a brief is bounded but can be large).
// A case-insensitive test of the defaults pattern `key` (JavaScript syntax) by the engine's linear-time matcher: the briefs can be large.
function mrT(key, t) { return ah.re.test(ah.cfg(key), 'i', t); }

function mrSig(tokens, set, key) {
  var list = ah.cfg(key), n = 0;
  for (var i = 0; i < list.length; i++) if (mrHasPhrase(tokens, set, list[i])) n++;
  return n;
}

function mrHasPhrase(tokens, set, phrase) {
  var parts = phrase.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || !set.has(parts[0])) return false;
  if (parts.length === 1) return true;
  for (var at = tokens.indexOf(parts[0]); at >= 0 && at + parts.length <= tokens.length; at = tokens.indexOf(parts[0], at + 1)) {
    var ok = true;
    for (var j = 1; j < parts.length; j++) if (tokens[at + j] !== parts[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// NFKC fold, lowercase, split on anything that is not a letter or digit (Unicode-aware), so a phrase matches on whole words.
function mrTokenize(s) {
  if (typeof s !== 'string' || s.length === 0) return [];
  // plain ASCII (the common brief) needs no folding and splits on a cheap class; the Unicode property class below is the slow path
  if (!/[^\x00-\x7f]/.test(s)) return s.toLowerCase().match(/[a-z0-9]+/g) || [];
  var t = s;
  try { t = t.normalize('NFKC'); } catch (e) { /* keep the raw text on bad input */ }
  return t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function mrStrip(s) { return s.replace(jx.re('model_routing.code_fence_re'), ' ').replace(jx.re('model_routing.inline_code_re'), ' '); }

function mrReadOnlyMechanical(corpus) {
  return mrT('model_routing.readonly_re', corpus) && mrT('model_routing.mechanical_shape_re', corpus) &&
    !mrT('model_routing.review_design_verb_re', mrStrip(corpus));
}

function mrReasoning(corpus) { return mrT('model_routing.reasoning_re', mrStrip(corpus)); }

function mrRank(model) { var t = ah.cfg('model_routing.model_rank'); return Object.prototype.hasOwnProperty.call(t, model) ? t[model] : null; }

function mrDeployShaped(corpus) {
  if (mrT('model_routing.deploy_strong_re', corpus)) return true;
  var kinds = {}, count = 0, aliases = ah.cfg('model_routing.deploy_weak_aliases');
  var hits = ah.re.findAll(ah.cfg('model_routing.deploy_weak_re'), 'i', corpus);
  for (var i = 0; i < hits.length; i++) {
    var k = corpus.slice(hits[i][0], hits[i][1]).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(aliases, k)) k = aliases[k];
    k = k.replace(/s$/, '');
    if (!kinds[k]) { kinds[k] = true; count++; }
  }
  return count >= ah.cfgNum('model_routing.deploy_weak_threshold');
}

function mrRunsUpdate(corpus) {
  return mrT('model_routing.update_skill_path_re', corpus) || mrT('model_routing.update_slash_re', corpus) ||
    (mrT('model_routing.update_node_re', corpus) && corpus.toLowerCase().indexOf(ah.cfg('model_routing.update_qualifier')) >= 0);
}

// The tier an omitted model inherits: the payload's parent model, else the newest assistant entry of the transcript tail whose
// model names a known family (session_model_families, first match). null when unknown.
function mrFamily(id) {
  var m = String(id || '').toLowerCase(), fams = ah.cfg('model_routing.session_model_families');
  for (var i = 0; i < fams.length; i++) if (m.indexOf(fams[i]) >= 0) return fams[i];
  return null;
}

function mrInheritedTier(p) {
  var direct = mrFirstStr(p, ['parent_model', 'model']);
  if (direct !== null) return mrFamily(direct);
  return mrTranscriptFamily(p);
}

// The family of the newest assistant entry of the transcript tail (the session's own model), null when unknown or unreadable.
function mrTranscriptFamily(p) {
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (!tp || !ah.path.isAbsolute(tp)) return null;
  var r = ah.transcript.tailEntries(tp, ah.cfgNum('model_routing.session_model_window_bytes'), ah.cfgNum('model_routing.session_model_line_max_bytes'),
    [['type'], ['message', 'model']], ah.cfgNum('model_routing.session_model_max_lines'));
  if (r === null || !r.lines) return null;
  for (var i = r.lines.length - 1; i >= 0; i--) {
    var e = r.lines[i][1];
    if (typeof e === 'string') { try { e = JSON.parse(e); } catch (x) { continue; } }
    if (!jx.isObj(e) || e.type !== 'assistant' || !jx.isObj(e.message) || typeof e.message.model !== 'string') continue;
    var f = mrFamily(e.message.model);
    if (f !== null) return f;
  }
  return null;
}

function mrBlock(t) { return { exact: { code: 2, out: text.blockJson(t), err: '' } }; }
function mrAdvise(t) { return { exact: { code: 0, out: text.advisoryJson('PreToolUse', t) + '\n', err: '' } }; }

function mrBlockMsg(what, why, instead, override) {
  return text.message('block', ah.cfg('model_routing.guard_name'), { what: what, why: why, instead: instead, override: override });
}

// tip(what, instead, why) -> the advisory verdict in the shared warn layout.
function mrTip(what, instead, why) {
  return mrAdvise(text.message('warn', ah.cfg('model_routing.message_guard'), { what: what, instead: instead, why: why }));
}

function mrPass(key, args) { return text.render(ah.cfg(key), args); }

function mrBounded(s) {
  var limit = ah.cfgNum('telemetry.token_max_len'), out = '', used = 0;
  var cps = Array.from(s);
  for (var i = 0; i < cps.length; i++) {
    var n = jx.utf8Len(cps[i]);
    if (used + n > limit) break;
    out += cps[i];
    used += n;
  }
  return out;
}

// The spawn identity a retry keeps: the session, the parent agent, the subagent type and a hash of a bounded prefix of the prompt
// (hashed, never stored).
function mrRouteKey(p, subagentType) {
  var inp = jx.field(p, 'tool_input');
  var prompt = typeof jx.field(inp, 'prompt') === 'string' ? inp.prompt : '';
  var keep = ah.cfgNum('model_routing.key_prefix_chars');
  var prefix = Array.from(prompt.slice(0, keep * 2)).slice(0, keep).join(''); // code points, without spreading a large brief
  var sid = typeof p.session_id === 'string' ? p.session_id : '', aid = typeof p.agent_id === 'string' ? p.agent_id : '';
  var identity = [mrBounded(sid), mrBounded(aid), mrBounded(subagentType), ah.fnv(prefix)].join('\u001f');
  return 'spawn-' + ah.fnv(identity);
}

function mrFirstStr(p, keys) {
  for (var i = 0; i < keys.length; i++) { var v = jx.field(p, keys[i]); if (typeof v === 'string' && v.trim()) return v; }
  return null;
}

function mrParentModel(p) {
  var m = mrFirstStr(p, ['parent_model', 'model']);
  if (m !== null) return jx.asciiLower(m.trim());
  // the payload names no model: the session model the transcript records (newest assistant entry), else unknown
  var fam = mrTranscriptFamily(p);
  return fam !== null ? fam : ah.cfg('telemetry.inherit_prefix') + 'unknown';
}

function mrSelected(requested, parent, recommended, outcome) {
  var prefix = ah.cfg('telemetry.inherit_prefix');
  if ((outcome === 'down' || outcome === 'up') && mrRank(recommended) !== null) return recommended;
  if (outcome === 'exempt' && mrRank(recommended) !== null && recommended !== requested) return recommended;
  if (requested.indexOf(prefix) === 0) return parent;
  return requested;
}

// The verdict `v` wrapped with its route row.
function mrRouted(v, p, input, cls, recommended, outcome) {
  var prefix = ah.cfg('telemetry.inherit_prefix');
  var parent = mrParentModel(p);
  var requested = input.omitted ? prefix + (parent.indexOf(prefix) === 0 ? parent.slice(prefix.length) : parent) : input.model;
  var blocked = !!(v && v.exact && v.exact.code === 2);
  return {
    routed: {
      verdict: v,
      meta: [{
        requested_model: requested, parent_model: parent, task_class: cls, recommended_tier: recommended,
        selected_model: mrSelected(requested, parent, recommended, outcome), outcome: outcome, spawn_key: mrRouteKey(p, input.subagentType),
        delegate: outcome === 'down' && blocked, blocked: blocked,
      }],
    },
  };
}

// The handover-delegation advisory: once per session, independent of the model table. A verdict, or null when it does not apply.
function mrHandover(p, corpus) {
  if (!mrT('model_routing.handover_noun_re', corpus) || !mrT('model_routing.handover_verb_re', corpus)) return null;
  var home = ah.home();
  if (!home) return null;
  var sid = p.session_id !== undefined && p.session_id !== null ? String(p.session_id) : '';
  var safe = (sid || ah.cfg('model_routing.unknown_session')).replace(jx.re('model_routing.session_safe_re', 'g'), '_');
  var rel = ah.cfg('model_routing.state_dir') + '/' + ah.cfg('model_routing.handover_state_prefix') + safe + ah.cfg('model_routing.handover_state_suffix');
  if (ah.fs.kind(home + '/' + rel) !== null) return null; // already advised this session
  if (!ah.state.writeAtomic(rel, ah.cfg('model_routing.handover_state_json'))) return null; // cannot persist the cap: stay silent
  return mrAdvise(text.message('tip', ah.cfg('model_routing.handover_guard'), {
    what: ah.cfg('model_routing.msg_handover_what'), why: ah.cfg('model_routing.msg_handover_why'), instead: ah.cfg('model_routing.msg_handover_instead'),
  }));
}

// True when Jev, asked in `on` mode within its budget, judged the spawn non-mechanical (so the block is relaxed to an advisory).
function mrJevRelaxes(corpus, p) {
  var id = ah.cfg('model_routing.jev_id');
  if (ah.jev.mode(id) === 'off') return false;
  var state = jx.sliceUnits(corpus, ah.cfgNum('model_routing.jev_state_limit'));
  var r = ah.jev.ask({
    id: id, sync: true, trust: 'relax_block', baseline: true, recordDisagreement: true, budgetMs: ah.cfgNum('model_routing.jev_budget_ms'),
    judgeLabel: ah.cfg('model_routing.jev_label_mechanical'), state: state,
    sessionId: typeof p.session_id === 'string' ? p.session_id : undefined,
    question: {
      type: 'choice', instructions: ah.cfg('model_routing.jev_question_instructions'),
      criteria: [
        [ah.cfg('model_routing.jev_label_mechanical'), ah.cfg('model_routing.jev_choice_mechanical')],
        [ah.cfg('model_routing.jev_label_authoring'), ah.cfg('model_routing.jev_choice_authoring')],
        [ah.cfg('model_routing.jev_label_research'), ah.cfg('model_routing.jev_choice_research')],
        [ah.cfg('model_routing.jev_label_plan_review'), ah.cfg('model_routing.jev_choice_plan_review')],
      ],
    },
  });
  return r === false;
}

function decide(p) {
  if (ah.settings.skipped(ah.cfg('model_routing.guard_name'))) return 'allow';
  if (p === null || typeof p !== 'object') p = {};
  var inp = jx.isObj(p.tool_input) ? p.tool_input : null;
  var rawModel = inp !== null && typeof inp.model === 'string' ? inp.model : '';
  var model = jx.asciiLower(rawModel.trim());
  var omitted = !(inp !== null && typeof inp.model === 'string' && inp.model.trim().length > 0);
  var subagentType = inp !== null && typeof inp.subagent_type === 'string' ? inp.subagent_type.trim() : '';
  var input = { model: model, omitted: omitted, subagentType: subagentType };
  var tierMain = ah.cfg('model_routing.tier_main'), tierHaiku = ah.cfg('model_routing.tier_haiku'), tierOpus = ah.cfg('model_routing.tier_opus');
  var routingMode = ah.settings.enum('model_routing.mode_setting');
  if (routingMode === ah.cfg('model_routing.off_mode')) {
    return mrRouted('allow', p, input, 'unknown', omitted ? ah.cfg('model_routing.tier_inherit') : model, 'allow');
  }
  var description = inp !== null && typeof inp.description === 'string' ? inp.description : '';
  var prompt = inp !== null && typeof inp.prompt === 'string' ? inp.prompt : '';
  var corpus = jx.sliceUnits(description + '\n' + prompt, ah.cfgNum('model_routing.scan_limit'));

  if (ah.settings.bool('model_routing.update_setting') && mrRunsUpdate(corpus)) {
    return mrRouted(mrBlock(mrBlockMsg(ah.cfg('model_routing.msg_update_what'), ah.cfg('model_routing.msg_update_why'), ah.cfg('model_routing.msg_update_instead'), '')),
      p, input, 'update', tierMain, 'exempt');
  }
  var handover = mrHandover(p, corpus);
  if (handover !== null) return mrRouted(handover, p, input, 'handover', tierMain, 'exempt');

  var tokens = mrTokenize(corpus);
  var tokenSet = new Set(tokens);
  var mechanical = mrSig(tokens, tokenSet, 'model_routing.mechanical'), complex = mrSig(tokens, tokenSet, 'model_routing.complex');
  // any planning signal (or heavy reading) vetoes the rows that steer to haiku
  var mechanicalOnly = mechanical > 0 && complex === 0 && !mrReasoning(corpus);
  var strict = routingMode !== ah.cfg('model_routing.advisory_mode');
  var exempt = mrT('model_routing.role_word_re', description);
  var researchExempt = !(mrSig(tokens, tokenSet, 'model_routing.hard_execution') > 0) && mrT('model_routing.research_re', corpus);
  var generic = subagentType === '' || subagentType === ah.cfg('model_routing.generic_type');
  var custom = subagentType !== '' && subagentType !== ah.cfg('model_routing.generic_type');
  var flagship = ah.cfg('model_routing.flagship_models').indexOf(model) >= 0;

  var suppressHaiku = false;
  var floorName = ah.settings.enum('model_routing.deploy_floor_setting');
  if (floorName !== ah.cfg('model_routing.deploy_floor_off') && mrDeployShaped(corpus)) {
    var floor = mrRank(floorName) !== null ? floorName : ah.cfg('model_routing.deploy_floor_default');
    // an omitted model inherits the session's: at or above the floor it is no cheap model (only an unknown or lower tier is advised)
    var inherited = omitted ? mrInheritedTier(p) : null;
    var inheritOk = inherited !== null && mrRank(inherited) !== null && mrRank(floor) !== null && mrRank(inherited) >= mrRank(floor);
    if (omitted && !inheritOk) {
      return mrRouted(mrTip(ah.cfg('model_routing.msg_deploy_omitted_what'), mrPass('model_routing.msg_deploy_omitted_instead', { floor: floor }), ah.cfg('model_routing.msg_deploy_why')),
        p, input, 'deploy', floor, 'up');
    }
    var mr = mrRank(model), fr = mrRank(floor);
    if (mr !== null && fr !== null && mr < fr) {
      var extra = model === tierHaiku && !mrReadOnlyMechanical(corpus) && mrT('model_routing.planning_intent_re', mrStrip(corpus))
        ? ah.cfg('model_routing.msg_deploy_low_extra') : '';
      return mrRouted(mrTip(mrPass('model_routing.msg_deploy_low_what', { model: model }), mrPass('model_routing.msg_deploy_low_instead', { floor: floor, extra: extra }),
        ah.cfg('model_routing.msg_deploy_why')), p, input, 'deploy', floor, 'up');
    }
    suppressHaiku = true;
  }

  // Row 1: mechanical-only on an explicit flagship model of a generic agent.
  if (!suppressHaiku && mechanicalOnly && !omitted && flagship && generic) {
    var reason = mrBlockMsg(mrPass('model_routing.msg_row1_what', { model: model }), ah.cfg('model_routing.msg_row1_why'), ah.cfg('model_routing.msg_row1_instead'), '');
    if (exempt) {
      return mrRouted(mrTip(mrPass('model_routing.msg_row1_role_what', { model: model }), ah.cfg('model_routing.msg_row1_role_instead'), ''), p, input, 'mechanical', tierHaiku, 'down');
    }
    if (researchExempt) {
      return mrRouted(mrTip(mrPass('model_routing.msg_row1_research_what', { model: model }), '', ''), p, input, 'research', model, 'exempt');
    }
    if (mrJevRelaxes(corpus, p)) {
      return mrRouted(mrTip(mrPass('model_routing.msg_row1_jev_what', { model: model }), ah.cfg('model_routing.msg_row1_jev_instead'), ''), p, input, 'mechanical', tierHaiku, 'exempt');
    }
    return mrRouted(mrBlock(reason), p, input, 'mechanical', tierHaiku, 'down');
  }

  // Row 2: mechanical-only, model omitted, generic agent.
  if (!suppressHaiku && mechanicalOnly && omitted && generic) { // a deploy-shaped spawn inheriting a model at or above the floor is never pushed to haiku
    if (strict) {
      if (mrJevRelaxes(corpus, p)) {
        return mrRouted(mrTip(ah.cfg('model_routing.msg_row2_jev_what'), ah.cfg('model_routing.msg_row2_jev_instead'), ''), p, input, 'mechanical', tierHaiku, 'exempt');
      }
      return mrRouted(mrBlock(mrBlockMsg(ah.cfg('model_routing.msg_row2_block_what'), ah.cfg('model_routing.msg_row2_block_why'), ah.cfg('model_routing.msg_row2_block_instead'),
        ah.cfg('model_routing.msg_row2_block_override'))), p, input, 'mechanical', tierHaiku, 'down');
    }
    return mrRouted(mrTip(ah.cfg('model_routing.msg_row2_adv_what'), ah.cfg('model_routing.msg_row2_adv_instead'), ah.cfg('model_routing.msg_row2_adv_why')), p, input, 'mechanical', tierHaiku, 'down');
  }

  // Row 3: mechanical-only on an explicit flagship model of a named custom agent.
  if (!suppressHaiku && mechanicalOnly && !omitted && flagship && custom) {
    return mrRouted(mrTip(mrPass('model_routing.msg_row3_what', { model: model, subagent_type: subagentType }), ah.cfg('model_routing.msg_row3_instead'), ''), p, input, 'mechanical', tierHaiku, 'down');
  }

  // Row 4: a genuine planning-intent phrase on an explicit haiku.
  if (model === tierHaiku && !mrReadOnlyMechanical(corpus) && mrT('model_routing.planning_intent_re', mrStrip(corpus))) {
    return mrRouted(mrTip(ah.cfg('model_routing.msg_row4_what'), ah.cfg('model_routing.msg_row4_instead'), ''), p, input, 'planning', tierOpus, 'up');
  }

  // Row 6: a research-shaped generic spawn that writes nothing is nudged toward Explore, which cannot recurse.
  var writeShaped = mrT('model_routing.write_phrase_re', corpus) || mrT('model_routing.commit_phrase_re', corpus.replace(jx.re('model_routing.negated_commit_re', 'gi'), ' ')) ||
    mrT('model_routing.strong_write_re', corpus.replace(jx.re('model_routing.negated_write_re', 'gi'), ' ')) ||
    (!mrT('model_routing.readonly_override_re', corpus) && (mrT('model_routing.write_re', corpus) || mrT('model_routing.write_imperative_re', corpus)));
  if (generic && mrT('model_routing.research_re', corpus) && !writeShaped) {
    return mrRouted(mrTip(ah.cfg('model_routing.msg_row6_what'), ah.cfg('model_routing.msg_row6_instead'), ah.cfg('model_routing.msg_row6_why')), p, input, 'research', ah.cfg('model_routing.explore_type'), 'exempt');
  }
  return mrRouted('allow', p, input, 'unknown', omitted ? ah.cfg('model_routing.tier_inherit') : model, 'allow');
}
