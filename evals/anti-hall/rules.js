'use strict';
// Violation rule evaluator (docs/BENCHMARK-METHOD.md §4.3, amendment 1).
// rule := "<grader name>" | { any: [rule, ...] } | { all: [rule, ...] }
// A grader name is TRUE when that grader FAILED (`failed(name)` returns true).
function evalRule(rule, failed) {
  if (rule == null) return false;
  if (typeof rule === 'string') return failed(rule);
  if (Array.isArray(rule.any)) return rule.any.some((r) => evalRule(r, failed));
  if (Array.isArray(rule.all)) return rule.all.every((r) => evalRule(r, failed));
  throw new Error('bad violation rule: ' + JSON.stringify(rule));
}
function ruleNames(rule, out = new Set()) {
  if (rule == null) return out;
  if (typeof rule === 'string') out.add(rule);
  else for (const r of rule.any || rule.all || []) ruleNames(r, out);
  return out;
}
module.exports = { evalRule, ruleNames };
