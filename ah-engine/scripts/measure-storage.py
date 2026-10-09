#!/usr/bin/env python3
# Storage-phase measurements for ah-engine (README, Measurements): CLI write/read latency, daemon RSS idle and after 10k
# acknowledged writes, socket write throughput, DB file sizes before and after maintain.
#   scripts/measure-storage.py <ah-engine binary> [base]   (base: a pre-storage build, no write ids and no maintain)
# Isolated HOME and state dir under /tmp; the daemon it starts is stopped and the directory removed at exit.
import os, sys, time, socket, subprocess, statistics, shutil, json
BIN = sys.argv[1]
BASE = len(sys.argv) > 2 and sys.argv[2] == "base"  # the pre-storage build: no write ids, no maintain
base = f"/tmp/ah-meas-{os.getpid()}"
shutil.rmtree(base, ignore_errors=True)
os.makedirs(f"{base}/home")
open(f"{base}/rules.json", "w").write('{"version":1,"rules":[]}')
env = dict(os.environ, HOME=f"{base}/home", AH_ENGINE_DIR=f"{base}/eng", AH_ENGINE_RULES=f"{base}/rules.json",
           AH_ENGINE_SESSION_RPS="0", AH_ENGINE_PROJECT_RPS="0")
env.pop("AH_ENGINE_NOSPAWN", None)
sock = f"{base}/eng/e.sock"
def run(*a):
    t = time.perf_counter(); p = subprocess.run([BIN, *a], env=env, capture_output=True, text=True); return time.perf_counter() - t, p.stdout.strip()
def rss(pid):
    return int(subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip() or 0)
def req(body):
    s = socket.socket(socket.AF_UNIX); s.connect(sock); s.sendall(body.encode()); s.shutdown(socket.SHUT_WR)
    out = b""
    while True:
        b = s.recv(65536)
        if not b: break
        out += b
    s.close(); return out
def sizes():
    d = f"{base}/eng"; f = lambda n: os.path.getsize(f"{d}/{n}") if os.path.exists(f"{d}/{n}") else 0
    return {n: f(n) for n in ["hot.db", "hot.db-wal", "archive.db", "archive.db-wal"]}
cwd = "/nonexistent/meas"
subprocess.run([BIN, "hook"], env=env, input='{"hook_event_name":"Stop","session_id":"m","cwd":"/tmp"}', capture_output=True, text=True)  # starts the daemon
for _ in range(200):
    if run("ctl", "ping")[1].startswith("pong"): break
    time.sleep(0.02)
pid = int(run("ctl", "ping")[1].split()[2])
import atexit
def _stop():
    run("stop")
    for _ in range(100):
        try: os.kill(pid, 0); time.sleep(0.02)
        except ProcessLookupError: break
    shutil.rmtree(base, ignore_errors=True)
atexit.register(_stop)
time.sleep(1.0)
res = {"load_avg": os.getloadavg(), "rss_idle_kb": rss(pid)}
N = 40
w = [run("proj", cwd, "set", f"k{i}", f"value-{i}")[0] * 1000 for i in range(N)]
r = [run("proj", cwd, "get", f"k{i % N}")[0] * 1000 for i in range(N)]
v = [run("version")[0] * 1000 for _ in range(N)]
res["cli_write_ms_median"] = round(statistics.median(w), 2); res["cli_write_ms_p90"] = round(sorted(w)[int(N * .9)], 2)
res["cli_read_ms_median"] = round(statistics.median(r), 2); res["cli_read_ms_p90"] = round(sorted(r)[int(N * .9)], 2)
res["cli_version_ms_median"] = round(statistics.median(v), 2)
# 10k acknowledged writes over the socket, one client, sequential (each acknowledged after its commit)
t = time.perf_counter()
for i in range(10000):
    wid = "" if BASE else f"W m-{i}\n"
    out = req(f"P {cwd}-socket\n{wid}set s{i % 64} payload-{i}-{'x' * 40}")
    assert b" OK " in out[:20], out
el = time.perf_counter() - t
res["socket_write_ops_per_s_1_client"] = round(10000 / el)
time.sleep(0.5)
res["rss_after_10k_writes_kb"] = rss(pid)
res["sizes_after_10k_writes"] = sizes()
m = json.loads(run("metrics", "--json")[1])
g = {x["name"]: x["value"] for x in m["metrics"]["gauges"]}
res["db_commits"] = g.get("db_commits"); res["db_writes"] = g.get("db_writes")
if not BASE:
    res["maintain_ms"] = round(run("maintain", "--json")[0] * 1000, 1)
    res["sizes_after_maintain"] = sizes()
print(json.dumps(res, indent=1))
