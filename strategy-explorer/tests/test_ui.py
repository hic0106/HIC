"""Research UI JSON API: endpoints, recipe download, path and request-origin checks."""

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

from strategy_explorer.config import load_config
from strategy_explorer.pipeline.run import ResearchRun
from strategy_explorer.ui.server import App, allowed_hosts, make_handler

from test_pipeline import FAST


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("ui")
    ws = tmp / "workspace"
    (tmp / "configs").mkdir()
    (tmp / "data").mkdir()
    cfg = load_config(None, FAST + [f'experiment.workspace="{ws}"', 'experiment.name="ui"', 'data.asset="UI"',
                                    'data.plant="squeeze_breakout"', "data.plant_strength=3.0", "data.n_bars=4000",
                                    "data.seed=5", "search.max_trials=80"])
    run = ResearchRun(cfg, root=".")
    run.run()
    app = App(ws, tmp, tmp / "data", tmp / "configs")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    yield httpd.server_address[1], run
    httpd.shutdown()
    httpd.server_close()


def req(port, method, path, body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    h = {"Host": f"127.0.0.1:{port}"}
    if body is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    c.request(method, path, body=None if body is None else json.dumps(body), headers=h)
    r = c.getresponse()
    data = r.read()
    c.close()
    ctype = r.getheader("Content-Type") or ""
    return r.status, (json.loads(data) if ctype.startswith("application/json") else data)


def test_pages_and_read_endpoints(server):
    port, run = server
    code, html = req(port, "GET", "/")
    assert code == 200 and b"AI Strategy Explorer" in html
    assert req(port, "GET", "/static/app.js")[0] == 200
    code, h = req(port, "GET", "/api/health")
    assert code == 200 and h["ok"] and "research" in h["notice"].lower()
    code, ex = req(port, "GET", "/api/experiments")
    assert run.eid in [e["experiment_id"] for e in ex["experiments"]]
    code, e = req(port, "GET", f"/api/experiments/{run.eid}")
    assert code == 200 and e["counts"]["budget_used"] == 80 and "config_json" not in e
    code, t = req(port, "GET", f"/api/experiments/{run.eid}/trials?order=robustness&limit=5")
    assert code == 200 and 0 < len(t["trials"]) <= 5
    assert all(x["complexity_score"] is not None for x in t["trials"] if x["status"] == "EVALUATED")
    for sub in ("patterns", "regimes", "generations", "llm", "exports"):
        assert req(port, "GET", f"/api/experiments/{run.eid}/{sub}")[0] == 200, sub
    code, p = req(port, "GET", f"/api/experiments/{run.eid}/patterns")
    if p["patterns"]:
        pid = p["patterns"][0]["pattern_id"]
        code, one = req(port, "GET", f"/api/experiments/{run.eid}/patterns/{pid}?occurrence=0")
        assert code == 200 and one["chart"]["bars"]
    assert req(port, "GET", "/api/memory")[0] == 200
    assert req(port, "GET", "/api/nope")[0] == 404


def test_candidate_views_and_recipe_export(server):
    port, run = server
    code, cs = req(port, "GET", f"/api/experiments/{run.eid}/candidates")
    assert code == 200 and cs["candidates"]
    card = cs["candidates"][0]
    for k in ("novelty", "closest_known", "complexity_nodes", "trades", "oos_cagr", "mdd", "sortino",
              "deflated_sharpe", "pbo", "cost_stress", "parameter_stability", "walk_forward", "regime", "status",
              "holdout_status"):
        assert k in card, k
    cid = card["candidate_id"]
    code, c = req(port, "GET", f"/api/candidates/{cid}")
    assert code == 200 and c["gate"]["status"] == c["status"] and c["card"]["dsl"] == c["dsl"]
    code, eq = req(port, "GET", f"/api/candidates/{cid}/equity")
    assert code == 200 and eq["equity"] and [s["name"] for s in eq["segments"]] == ["train", "validation", "test"]
    assert eq["segments"][-1]["to"] < eq["holdout_start"]  # the holdout is never charted
    code, exm = req(port, "GET", f"/api/candidates/{cid}/examples")
    assert code == 200 and set(exm) >= {"good", "bad", "false"}
    assert req(port, "GET", f"/api/candidates/{cid}/export/strategy_recipe.json")[0] == 404  # not exported yet
    code, out = req(port, "POST", f"/api/candidates/{cid}/export", {})
    assert code == 200 and "strategy_recipe.json" in out["files"]
    code, raw = req(port, "GET", f"/api/candidates/{cid}/export/strategy_recipe.json")
    assert code == 200 and raw["research_only"] is True  # served as application/json attachment


def test_path_traversal_is_refused(server):
    port, run = server
    assert req(port, "GET", "/static/..%2fserver.py")[0] == 404
    assert req(port, "GET", "/static/../../ledger/db.py")[0] == 404
    assert req(port, "GET", "/api/candidates/1/export/..%2f..%2fledger.sqlite")[0] == 404
    assert req(port, "GET", "/api/data/preview?path=/etc/passwd")[0] == 404
    code, _ = req(port, "POST", "/api/experiments", {"config_path": "/etc/passwd"})
    assert code == 403


def test_foreign_host_and_cross_site_posts_are_refused(server):
    port, run = server
    assert req(port, "GET", "/api/health", headers={"Host": f"attacker.example:{port}"})[0] == 403
    assert req(port, "GET", "/api/health", headers={"Host": f"localhost:{port}"})[0] == 200
    code, _ = req(port, "POST", "/api/experiments", {"overrides": ""}, headers={"Content-Type": "text/plain"})
    assert code == 403
    code, _ = req(port, "POST", "/api/experiments", {"overrides": ""}, headers={"Origin": "http://attacker.example"})
    assert code == 403
    assert allowed_hosts("0.0.0.0", 1) is None and "localhost:9" in allowed_hosts("127.0.0.1", 9)
