#!/usr/bin/env python3
"""Demo build helper (dev only, not shipped): turn plugin web_graph.toml into the JSON config the page receives, and write the
three sample graphs (30 agents, ~15-node topology, ~40-node hook pipeline). usage: gen.py <web_graph.toml> <out_dir>"""
import json, random, sys, tomllib

toml_path, out = sys.argv[1], sys.argv[2]
raw = tomllib.load(open(toml_path, "rb"))["web"]["graph"]

def flat(node, path=()):
    if isinstance(node, dict) and "value" in node and "doc" in node:
        yield path, node["value"]
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from flat(v, path + (k,))

cfg = {}
for path, v in flat(raw):
    d = cfg
    for p in path[:-1]:
        d = d.setdefault(p, {})
    d[path[-1]] = v
json.dump(cfg, open(f"{out}/config.json", "w"), indent=1)

rnd = random.Random(7)
def node(i, label, sub, kind, status="running", pin=None, pi=(), po=()):
    return {"id": i, "label": label, "sub": sub, "kind": kind, "status": status, "x": None, "y": None,
            "ports_in": [{"id": p, "label": p} for p in pi], "ports_out": [{"id": p, "label": p} for p in po]}
def edge(i, a, b, label="", rate=0.0, fp="", tp=""):
    return {"id": i, "from": a, "from_port": fp, "to": b, "to_port": tp, "label": label, "rate": rate}

# ---- agents: 30
ns, es = [], []
ns.append(node("ah-primary", "anti-hall Primary", "Primary · ♥ 2s", "primary"))
ns.append(node("sky-primary", "SkyCrew Primary", "Primary · ♥ 4s", "primary"))
es.append(edge("pp", "sky-primary", "ah-primary", "peer", 0.8))
for i, t in enumerate(["engine web", "release", "defer migration", "ci triage", "devswarm"]):
    ns.append(node(f"ws{i}", f"ws: {t}", f"Workspace · ♥ {rnd.randint(3,40)}s", "workspace", "running" if i != 4 else "waiting"))
    es.append(edge(f"ews{i}", "ah-primary", f"ws{i}", "", 0.3 + 0.2 * i))
names = ["defer-rp","defer-tick","defer-send","defer-life","defer-act","defer-app","defer-jev","defer-plan","defer-report","defer-script",
         "fix3-nosh","fix3-wake","web-1","web-api","web-io","web-graph","ci-fix","ci-classify"]
for i, nm in enumerate(names):
    parent = f"ws{i % 5}" if i % 3 else "ah-primary"
    st = rnd.choice(["running", "running", "running", "idle", "waiting"])
    ns.append(node(f"a{i}", nm, f"Subagent · sonnet · ♥ {rnd.randint(2,59)}s", "subagent", st))
    es.append(edge(f"ea{i}", parent, f"a{i}", "", round(rnd.uniform(0, 1.5), 1) if st == "running" else 0.0))
for i, nm in enumerate(["codex-review-1", "codex-review-2", "codex-diag"]):
    ns.append(node(f"c{i}", nm, "Codex · gpt-5.x", "codex", "running" if i < 2 else "idle"))
    es.append(edge(f"ec{i}", "ah-primary" if i != 2 else "sky-primary", f"c{i}", "review" if i < 2 else "", 0.4 if i < 2 else 0.0))
for i, nm in enumerate(["old-session-7f3a", "old-session-91bc"]):
    ns.append(node(f"i{i}", nm, "Session · idle 3h", "idle", "idle"))
    es.append(edge(f"ei{i}", "sky-primary", f"i{i}", "", 0.0))
assert len(ns) == 30, len(ns)
json.dump({"nodes": ns, "edges": es}, open(f"{out}/agents.json", "w"))

# ---- topology: 15
t = [
 node("cc1", "Claude Code session A", "client · anti-hall", "client"), node("cc2", "Claude Code session B", "client · SkyCrew", "client"),
 node("cx", "Codex session", "client · review", "client"), node("ds", "DevSwarm app", "client · workspaces", "client"),
 node("hook", "ah-hook (thin client)", "launcher · 33 events", "service"), node("eng", "ah-engine daemon", "RUNNING · RC9 · 87 MB", "engine"),
 node("web", "ah-web server", "loopback · idle-exit", "service"), node("mesh", "mesh store", "SQLite WAL", "store"),
 node("cfg", "plugin TOML config", "defaults + user layer", "store"), node("state", "state dir", "tracker · ledgers", "store"),
 node("tel", "telemetry log", "NDJSON", "store"), node("tr", "session transcripts", "~/.claude/projects", "store"),
 node("gh", "GitHub", "gh CLI", "service"), node("api", "Anthropic API", "Jev judge", "service"), node("jev", "Jev classifier", "shadow · fail-open", "engine"),
]
te = [
 edge("t1","cc1","hook","hooks",6.0), edge("t2","cc2","hook","hooks",3.5), edge("t3","cx","hook","hooks",1.2), edge("t4","ds","eng","CTL",0.8),
 edge("t5","hook","eng","frames",10.0), edge("t6","eng","mesh","r/w",2.0), edge("t7","eng","cfg","watch",0.1), edge("t8","eng","state","r/w",1.5),
 edge("t9","eng","tel","append",3.0), edge("t10","eng","tr","scan",0.6), edge("t11","web","eng","CTL",0.5), edge("t12","eng","gh","gh",0.2),
 edge("t13","jev","api","judge",0.3), edge("t14","eng","jev","ask",0.4),
]
json.dump({"nodes": t, "edges": te}, open(f"{out}/topology.json", "w"))

# ---- hooks pipeline: 40 (6 events, 12 rules, 12 checks, 8 effects, 2 jev)
n, e = [], []
evs = ["UserPromptSubmit","PreToolUse","PostToolUse","Stop","SubagentStart","SessionStart"]
for i, v in enumerate(evs): n.append(node(f"ev{i}", v, "hook event", "event", "ok", po=("fire",)))
rules = ["verify-first","speculation","swarm-guard","git-guard","burn-breaker","waste-sense","spawn-gate","disk-guard","nudge-silent","task-tracker","mesh-inbox","parent-gate"]
for i, r in enumerate(rules): n.append(node(f"ru{i}", r, "rule", "rule", "ok" if i != 5 else "off", pi=("event",), po=("match","skip")))
checks = ["claim has evidence?","cites source?","whole-disk search?","force push?","CPU over bar?","quota burn > 60%?","agents > cap?","free disk < 10%?","agent silent > N min?","task list stale?","unread mesh?","parent decided?"]
for i, c in enumerate(checks): n.append(node(f"ck{i}", c, "check", "check", pi=("in",), po=("yes","no")))
effs = ["block + explain","warn","nudge agent","write ledger","stop agent","alert owner","inject reminder","count metric"]
for i, f in enumerate(effs): n.append(node(f"ef{i}", f, "effect", "effect", pi=("in",)))
for i, j in enumerate(["jev: judge claim","jev: label arrival"]): n.append(node(f"jv{i}", j, "shadow · fail-open", "jev", "ok", pi=("in",), po=("verdict",)))
assert len(n) == 40, len(n)
k = 0
for i in range(12):
    ev = {0:[0],1:[1,2],2:[1],3:[1],4:[1],5:[1,4],6:[4],7:[5,1],8:[3],9:[2,3],10:[0,5],11:[3]}[i]
    for v in ev:
        e.append(edge(f"e{k}", f"ev{v}", f"ru{i}", "", round(rnd.uniform(0.2, 3.0), 1), "fire", "event")); k += 1
    e.append(edge(f"e{k}", f"ru{i}", f"ck{i}", "match", 0.0, "match", "in")); k += 1
    e.append(edge(f"e{k}", f"ck{i}", f"ef{[0,0,2,0,4,5,2,1,2,6,6,1][i]}", "yes", 0.0, "yes", "in")); k += 1
    if i in (0, 1): e.append(edge(f"e{k}", f"ck{i}", f"jv{i}", "ask", 0.0, "no", "in")); k += 1
for i in (3, 5, 9, 10):
    e.append(edge(f"e{k}", f"ck{i}", f"ef{3 if i%2 else 7}", "no", 0.0, "no", "in")); k += 1
json.dump({"nodes": n, "edges": e}, open(f"{out}/hooks.json", "w"))
print("ok", len(ns), len(t), len(n), "nodes;", len(es), len(te), len(e), "edges")
