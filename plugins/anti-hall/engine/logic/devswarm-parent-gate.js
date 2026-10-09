// check = "devswarm-parent-gate" (Stop): the Primary's Stop gate. A Stop guard is never weaker than Node (D74): only the silent exits that
// happen in the Node hook BEFORE it reads any mailbox are answered here, in the same order: the judge-child exit, the
// `devswarm.parentGate` switch, the user skip, a supervisor that is not active, and a child workspace (a child is gated by its own hook).
// Everything else, which is every session that might be blocked, defers to the Node gate, which reads the store, the descriptors and the
// liveness files, may spawn git and keeps the forced-acknowledgement counters; the script never blocks. A hook that stops again after its
// own block (`stop_hook_active`) is allowed once the stable launchers are current. Mirrors hooks/lib/devswarm-primary-gate.js `inert` and
// `main` of hooks/devswarm-parent-gate.js. This script builds on devswarm-child-role.js (script.includes). Keys: devswarm_role.toml.
'use strict';

function decide(p, opts, event) {
  if (event !== 'Stop') return 'defer';
  if (dwJudgeChild()) return 'allow';
  if (dwUsableHome() !== null) {
    if (!ah.settings.bool('devswarm_role.sw_parent_gate')) return 'allow';
    if (ah.settings.skipped(ah.cfg('devswarm_role.gate_guard'))) return 'allow';
    if (!dwActive() || dwNonBlank(ah.cfg('devswarm_role.branch_env'))) return 'allow';
  }
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
  if (dwLaunchersCurrent(root, true) === null || !jx.isObj(p)) return 'defer';
  return p[ah.cfg('devswarm_gates.readside_stop_field')] === true ? 'allow' : 'defer';
}
