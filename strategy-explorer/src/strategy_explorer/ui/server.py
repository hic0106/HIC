"""Quant Research Laboratory web UI (standard-library HTTP server, JSON API).

Binds to 127.0.0.1 by default. It can start research runs (as subprocesses),
browse the ledger, patterns, candidates and validation results, and export
recipe files. It has no trading functionality of any kind.
"""

from __future__ import annotations

import json
import mimetypes
import re
import subprocess
import sys
import threading
import time
import traceback
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np

from .. import RESEARCH_ONLY_NOTICE, __version__
from ..config import hash_config, load_config
from ..data import catalog
from ..data.synthetic import generate_synthetic
from ..dsl.registry import Registry
from ..dsl.typecheck import compile_strategy
from ..ledger.db import LedgerDB
from ..pipeline.context import rebuild_context
from ..pipeline.run import new_experiment_id
from ..util import dumps, json_safe, ms_to_iso

STATIC = Path(__file__).resolve().parent / "static"


def bars_payload(md, start: int, stop: int) -> list[list]:
    start, stop = max(0, int(start)), min(len(md), int(stop))
    return [[int(md.ts[i]), float(md.open[i]), float(md.high[i]), float(md.low[i]), float(md.close[i]),
             float(md.volume[i]) if md.has_volume else 0.0] for i in range(start, stop)]


class App:
    def __init__(self, workspace: Path, root: Path, data_dir: Path, configs_dir: Path):
        self.ws = workspace.resolve()
        self.ws.mkdir(parents=True, exist_ok=True)
        self.root = root.resolve()
        self.data_dir = (self.root / data_dir).resolve() if not data_dir.is_absolute() else data_dir
        self.configs_dir = (self.root / configs_dir).resolve() if not configs_dir.is_absolute() else configs_dir
        self.db = LedgerDB(self.ws / "ledger.sqlite")
        self._ctx: OrderedDict[str, object] = OrderedDict()
        self._lock = threading.Lock()
        self.runs: dict[str, dict] = {}

    # ------------------------------------------------------------ contexts
    def ctx(self, eid: str):
        with self._lock:
            c = self._ctx.get(eid)
            if c is None:
                c = rebuild_context(self.db, eid, self.root)
                self._ctx[eid] = c
                while len(self._ctx) > 3:
                    self._ctx.popitem(last=False)
            else:
                self._ctx.move_to_end(eid)
            return c

    def strategy(self, cand: dict, ctx):
        return compile_strategy(cand["dsl"], Registry(**ctx.registry_kwargs), 400, 60)

    # -------------------------------------------------------------- routes
    def health(self, q):
        return {"ok": True, "version": __version__, "notice": RESEARCH_ONLY_NOTICE, "workspace": str(self.ws)}

    def datasets(self, q):
        rows = catalog.describe(self.data_dir)
        return {"data_dir": str(self.data_dir), "datasets": rows}

    def data_preview(self, q):
        path = q.get("path", [""])[0]
        limit = int(q.get("limit", ["1500"])[0])
        if path == "synthetic":
            md = generate_synthetic(3000, q.get("tf", ["4h"])[0], "SYNTH", 7, plant="squeeze_breakout")
        else:
            refs = {r["path"]: r for r in catalog.scan(self.data_dir)}
            if path not in refs:
                raise FileNotFoundError("dataset not found in the data directory")
            md = catalog.load_ref(refs[path])
        end = int(q.get("end", [str(len(md))])[0])
        start = max(0, end - limit)
        return {"asset": md.asset, "timeframe": md.timeframe, "rows": len(md), "start": start,
                "bars": bars_payload(md, start, end)}

    def configs(self, q):
        out = []
        if self.configs_dir.exists():
            for p in sorted(self.configs_dir.glob("*.toml")):
                try:
                    cfg = load_config(p)
                    out.append({"path": str(p), "name": p.name, "experiment": cfg["experiment"]["name"],
                                "data": {k: cfg["data"][k] for k in ("provider", "asset", "timeframe", "path")},
                                "max_trials": cfg["search"]["max_trials"], "llm": cfg["llm"]["provider"],
                                "config_hash": hash_config(cfg)})
                except Exception as exc:  # show broken configs instead of hiding them
                    out.append({"path": str(p), "name": p.name, "error": str(exc)})
        return {"configs": out}

    def experiments(self, q):
        rows = self.db.experiments()
        for r in rows:
            run = self.runs.get(r["experiment_id"])
            if run:
                r["process_running"] = run["proc"].poll() is None
        pending = [{"experiment_id": k, "status": "STARTING", "name": v.get("name"), "created_at": v.get("started"),
                    "process_running": v["proc"].poll() is None, "log": v.get("log")}
                   for k, v in self.runs.items() if not any(r["experiment_id"] == k for r in rows)]
        return {"experiments": pending + rows}

    def experiment(self, q, eid):
        e = self.db.experiment(eid)
        if e is None:
            run = self.runs.get(eid)
            if run:
                log = Path(run["log"]).read_text(encoding="utf-8", errors="replace")[-4000:] if run.get("log") else ""
                return {"experiment_id": eid, "status": "STARTING" if run["proc"].poll() is None else "FAILED_TO_START",
                        "log_tail": log}
            raise FileNotFoundError("unknown experiment")
        e.pop("config_json", None)
        e["counts"] = self.db.trial_counts(eid)
        e["events"] = self.db.events(eid, 60)
        run = self.runs.get(eid)
        if run and run.get("log"):
            e["log_tail"] = Path(run["log"]).read_text(encoding="utf-8", errors="replace")[-3000:]
        return e

    def trials(self, q, eid):
        rows = self.db.trials(eid, status=q.get("status", [None])[0] or None, order=q.get("order", ["seq"])[0],
                              limit=min(500, int(q.get("limit", ["100"])[0])), offset=int(q.get("offset", ["0"])[0]),
                              method=q.get("method", [None])[0] or None)
        slim = []
        for t in rows:
            slim.append({k: t.get(k) for k in ("trial_id", "seq", "generation", "creation_method", "operator",
                                                "phase", "status", "robustness", "is_return", "oos_return",
                                                "is_trades", "oos_trades", "complexity_score", "family", "dsl",
                                                "duplicate_of", "error", "parent_trial", "strategy_hash")}
                        | {"tags": (t.get("meta") or {}).get("tags", []), "group": (t.get("meta") or {}).get("group"),
                           "rationale": (t.get("meta") or {}).get("rationale"),
                           "backend": (t.get("meta") or {}).get("backend")})
        return {"trials": slim, "counts": self.db.trial_counts(eid)}

    def trial(self, q, tid):
        t = self.db.trial(int(tid))
        if t is None:
            raise FileNotFoundError("unknown trial")
        t["lineage"] = self.db.lineage(int(tid))
        return t

    def patterns(self, q, eid):
        rows = self.db.patterns(eid)
        return {"patterns": [{"pattern_id": r["pattern_id"], "kind": r["kind"], **(r.get("summary") or {})}
                             for r in rows]}

    def pattern(self, q, eid, pid):
        row = self.db.pattern(eid, pid)
        if row is None:
            raise FileNotFoundError("unknown pattern")
        occ = (row.get("occurrences") or {}).get("idx", [])
        out = {"pattern_id": pid, "kind": row["kind"], **(row.get("summary") or {}), "occurrence_count": len(occ)}
        k = int(q.get("occurrence", ["-1"])[0])
        ctx = self.ctx(eid)
        length = int(out.get("length") or 1)
        out["occurrences"] = [{"i": i, "index": int(o), "time": ms_to_iso(int(ctx.md_search.ts[o]))}
                              for i, o in enumerate(occ[:400])]
        if occ:
            k = k if 0 <= k < len(occ) else 0
            end = int(occ[k])
            s, e = max(0, end - length - 40), min(len(ctx.md_search), end + 25)
            out["chart"] = {"bars": bars_payload(ctx.md_search, s, e), "highlight": [end - length + 1, end],
                            "offset": s, "occurrence": k, "forward_end": min(end + 10, e - 1)}
        return out

    def regimes(self, q, eid):
        r = self.db.regimes(eid)
        return r or {}

    def generations(self, q, eid):
        return {"generations": self.db.generations(eid)}

    def candidates(self, q, eid):
        out = []
        for c in self.db.candidates(eid):
            v = c.get("validation") or {}
            out.append(card(c, v))
        return {"candidates": out}

    def candidate(self, q, cid):
        c = self.db.candidate(int(cid))
        if c is None:
            raise FileNotFoundError("unknown candidate")
        c["card"] = card(c, c.get("validation") or {})
        c["exports"] = [e for e in self.db.exports(c["experiment_id"]) if e["candidate_id"] == int(cid)]
        return c

    def candidate_equity(self, q, cid):
        c = self.db.candidate(int(cid))
        ctx = self.ctx(c["experiment_id"])
        st = self.strategy(c, ctx)
        ev = ctx.evaluator
        s, e = ctx.split.segment("search")
        res, _ = ev.backtest(st, (s, e))
        n = res.n
        step = max(1, n // 1500)
        ts = ctx.md_search.ts[s:e]
        pts = [[int(ts[i]), float(res.equity[i])] for i in range(0, n, step)]
        bench = ctx.md_search.close[s:e] / ctx.md_search.close[s] * res.initial_equity
        bpts = [[int(ts[i]), float(bench[i])] for i in range(0, n, step)]
        segs = []
        for name in ("train", "validation", "test"):
            a, b = ctx.split.segment(name)
            segs.append({"name": name, "from": int(ctx.md_search.ts[a]), "to": int(ctx.md_search.ts[b - 1])})
        return {"equity": pts, "benchmark": bpts, "segments": segs,
                "holdout_start": ctx.split.boundaries_ms.get("holdout_start")}

    def candidate_examples(self, q, cid):
        c = self.db.candidate(int(cid))
        ctx = self.ctx(c["experiment_id"])
        st = self.strategy(c, ctx)
        ev = ctx.evaluator
        s, e = ctx.split.segment("search")
        res, _ = ev.backtest(st, (s, e))
        trades = res.trades
        if not trades:
            return {"good": [], "bad": [], "false": []}
        by_ret = sorted(trades, key=lambda t: t.ret)
        winners_mfe = [t.mfe for t in trades if t.net_pnl > 0] or [t.mfe for t in trades]
        mfe_ref = float(np.median(winners_mfe))
        false = sorted([t for t in trades if t.net_pnl <= 0 and t.mfe < 0.25 * mfe_ref], key=lambda t: t.mfe)
        md = ctx.md_search

        def seg_of(i):
            for name in ("train", "validation", "test"):
                a, b = ctx.split.segment(name)
                if a <= i < b:
                    return name
            return "?"

        def pack(t):
            a, b = max(0, t.signal_idx - 30), min(len(md), t.exit_idx + 15)
            return {"side": "long" if t.side == 1 else "short", "entry_time": ms_to_iso(int(md.ts[t.entry_idx])),
                    "exit_time": ms_to_iso(int(md.ts[t.exit_idx])), "return": t.ret, "mfe": t.mfe, "mae": t.mae,
                    "reason": t.reason, "bars_held": t.bars_held, "segment": seg_of(t.entry_idx),
                    "bars": bars_payload(md, a, b), "offset": a, "signal": t.signal_idx, "entry": t.entry_idx,
                    "exit": t.exit_idx, "entry_price": t.entry_price, "exit_price": t.exit_price}

        return {"good": [pack(t) for t in by_ret[::-1][:4]], "bad": [pack(t) for t in by_ret[:4]],
                "false": [pack(t) for t in false[:4]], "false_signal_rule":
                    "losing trade whose best favourable excursion stayed below 25% of the median winner excursion",
                "trades_total": len(trades)}

    def memory(self, q):
        scope = q.get("scope", [None])[0] or None
        return {"memory": self.db.memory(scope=scope)}

    def llm_calls(self, q, eid):
        return {"calls": self.db.llm_calls(eid)}

    def exports_list(self, q, eid):
        return {"exports": self.db.exports(eid)}

    # ------------------------------------------------------------- actions
    def start_run(self, body: dict):
        cfg_path = body.get("config_path") or None
        if cfg_path:
            p = Path(cfg_path).resolve()
            if self.configs_dir not in p.parents:
                raise PermissionError("config must live in the configs directory")
            cfg_path = str(p)
        overrides = [o.strip() for o in (body.get("overrides") or "").splitlines() if o.strip() and "=" in o]
        overrides.append(f'experiment.workspace="{self.ws}"')
        cfg = load_config(cfg_path, overrides)
        eid = new_experiment_id(hash_config(cfg))
        log = self.ws / "logs" / f"{eid}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        cmd = [sys.executable, "-m", "strategy_explorer", "--workspace", str(self.ws), "--root", str(self.root), "run",
               "--experiment-id", eid]
        if cfg_path:
            cmd += ["--config", cfg_path]
        for o in overrides:
            cmd += ["--set", o]
        fh = open(log, "w", encoding="utf-8")
        env = dict(__import__("os").environ)
        src = str(Path(__file__).resolve().parents[2])
        env["PYTHONPATH"] = src + (":" + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        proc = subprocess.Popen(cmd, cwd=str(self.root), stdout=fh, stderr=subprocess.STDOUT, env=env)
        self.runs[eid] = {"proc": proc, "log": str(log), "name": cfg["experiment"]["name"],
                          "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        return {"experiment_id": eid, "pid": proc.pid, "log": str(log)}

    def export(self, cid: str, body: dict):
        from ..export.recipe import export_candidate

        c = self.db.candidate(int(cid))
        if c is None:
            raise FileNotFoundError("unknown candidate")
        out = export_candidate(self.db, int(cid), root=self.root, out_dir=self.ws / "exports")
        return {"folder": out["folder"], "files": sorted(out["files"]), "strategy_name": out["strategy_name"]}

    def export_file(self, cid: str, name: str) -> tuple[bytes, str]:
        rows = [e for e in self.db.query("SELECT * FROM exports WHERE candidate_id = ? ORDER BY id DESC", [int(cid)])]
        if not rows:
            raise FileNotFoundError("candidate not exported yet")
        folder = Path(rows[0]["path"]).resolve()
        if name not in (rows[0].get("files") or []):
            raise FileNotFoundError("file not part of the export")
        p = (folder / name).resolve()
        if folder not in p.parents:
            raise PermissionError("invalid path")
        ctype = mimetypes.guess_type(name)[0] or "text/plain"
        return p.read_bytes(), ctype


def card(c: dict, v: dict) -> dict:
    """Candidate card fields (spec #41)."""
    oos = v.get("oos", {})
    gate = c.get("gate") or {}
    checks = {x["name"]: x["passed"] for x in gate.get("checks", [])}
    works = v.get("regimes", {}).get("works_in") or []
    names = {r["regime"]: r["label"] for r in v.get("regimes", {}).get("regimes", [])}
    return {
        "candidate_id": c["candidate_id"], "trial_id": c["trial_id"], "experiment_id": c["experiment_id"],
        "novelty": v.get("novelty_level"), "novelty_class": c.get("novelty_class"),
        "closest_known": (v.get("known_strategy") or {}).get("closest"),
        "complexity_nodes": (v.get("complexity") or {}).get("nodes"), "trades": oos.get("trades"),
        "oos_cagr": oos.get("cagr"), "oos_return": oos.get("total_return"), "mdd": oos.get("max_drawdown"),
        "sortino": oos.get("sortino"), "deflated_sharpe": (v.get("dsr") or {}).get("dsr"),
        "pbo": (v.get("pbo_experiment") or {}).get("pbo"),
        "cost_stress": "PASS" if checks.get("transaction_cost_survival") else "FAIL",
        "parameter_stability": "PASS" if checks.get("parameter_stability") else "FAIL",
        "walk_forward": "PASS" if checks.get("walk_forward_survival") else "FAIL",
        "regime": ", ".join(names.get(k, f"R{k}") for k in works) or "-",
        "status": c["status"], "holdout_status": c["holdout_status"], "robustness": c.get("robustness"),
        "dsl": c["dsl"], "warnings": gate.get("warnings", []),
        "explanation": (c.get("explanation") or {}).get("text"),
        "failed_checks": [x["name"] for x in gate.get("checks", []) if not x["passed"]],
    }


ROUTES_GET = [
    (re.compile(r"^/api/health$"), "health"),
    (re.compile(r"^/api/datasets$"), "datasets"),
    (re.compile(r"^/api/data/preview$"), "data_preview"),
    (re.compile(r"^/api/configs$"), "configs"),
    (re.compile(r"^/api/experiments$"), "experiments"),
    (re.compile(r"^/api/experiments/([\w\-]+)$"), "experiment"),
    (re.compile(r"^/api/experiments/([\w\-]+)/trials$"), "trials"),
    (re.compile(r"^/api/experiments/([\w\-]+)/patterns$"), "patterns"),
    (re.compile(r"^/api/experiments/([\w\-]+)/patterns/(\w+)$"), "pattern"),
    (re.compile(r"^/api/experiments/([\w\-]+)/regimes$"), "regimes"),
    (re.compile(r"^/api/experiments/([\w\-]+)/generations$"), "generations"),
    (re.compile(r"^/api/experiments/([\w\-]+)/candidates$"), "candidates"),
    (re.compile(r"^/api/experiments/([\w\-]+)/llm$"), "llm_calls"),
    (re.compile(r"^/api/experiments/([\w\-]+)/exports$"), "exports_list"),
    (re.compile(r"^/api/trials/(\d+)$"), "trial"),
    (re.compile(r"^/api/candidates/(\d+)$"), "candidate"),
    (re.compile(r"^/api/candidates/(\d+)/equity$"), "candidate_equity"),
    (re.compile(r"^/api/candidates/(\d+)/examples$"), "candidate_examples"),
    (re.compile(r"^/api/memory$"), "memory"),
]


WILDCARD_HOSTS = ("", "0.0.0.0", "::")
LOCAL_NAMES = ("127.0.0.1", "localhost", "[::1]")


def allowed_hosts(bound_host: str, port: int) -> set[str] | None:
    """Accepted ``Host`` header values; None when bound to a wildcard address (the user opted into remote access)."""
    if bound_host in WILDCARD_HOSTS:
        return None
    names = set(LOCAL_NAMES) | {f"[{bound_host}]" if ":" in bound_host else bound_host}
    return {f"{h}:{port}" for h in names}


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"AIStrategyExplorer/{__version__}"

        def log_message(self, fmt, *args):  # quiet
            pass

        def _check_host(self):
            """Reject requests whose Host header is not this server (DNS-rebinding defence)."""
            host, port = self.server.server_address[:2]
            allowed = allowed_hosts(str(host), int(port))
            got = (self.headers.get("Host") or "").strip().lower()
            if allowed is not None and got not in allowed:
                raise PermissionError("unexpected Host header")

        def _check_post(self):
            """State-changing requests must be same-origin JSON (a cross-site form or text/plain POST is refused)."""
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise PermissionError("POST requires Content-Type: application/json")
            origin = self.headers.get("Origin")
            if origin is not None and urlparse(origin).netloc.lower() != (self.headers.get("Host") or "").lower():
                raise PermissionError("cross-origin request refused")

        def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8",
                  extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code: int = 200):
            self._send(code, dumps(json_safe(obj)).encode("utf-8"))

        def _error(self, exc: Exception):
            code = HTTPStatus.NOT_FOUND if isinstance(exc, (FileNotFoundError, KeyError)) else (
                HTTPStatus.FORBIDDEN if isinstance(exc, PermissionError) else HTTPStatus.BAD_REQUEST)
            self._json({"error": f"{type(exc).__name__}: {exc}",
                        "trace": traceback.format_exc()[-1500:] if code == HTTPStatus.BAD_REQUEST else None}, code)

        def do_GET(self):
            url = urlparse(self.path)
            path = unquote(url.path)
            q = parse_qs(url.query)
            try:
                self._check_host()
                if path in ("/", "/index.html"):
                    return self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
                if path.startswith("/static/"):
                    p = (STATIC / path[len("/static/"):]).resolve()
                    if STATIC not in p.parents or not p.is_file():
                        raise FileNotFoundError(path)
                    return self._send(200, p.read_bytes(), (mimetypes.guess_type(p.name)[0] or "text/plain") +
                                      "; charset=utf-8")
                m = re.match(r"^/api/candidates/(\d+)/export/([\w\.\-]+)$", path)
                if m:
                    data, ctype = app.export_file(m.group(1), m.group(2))
                    return self._send(200, data, ctype, {"Content-Disposition": f'attachment; filename="{m.group(2)}"'})
                for rx, name in ROUTES_GET:
                    m = rx.match(path)
                    if m:
                        return self._json(getattr(app, name)(q, *m.groups()))
                raise FileNotFoundError(path)
            except Exception as exc:
                self._error(exc)

        def do_POST(self):
            url = urlparse(self.path)
            path = unquote(url.path)
            try:
                self._check_host()
                self._check_post()
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
                if path == "/api/experiments":
                    return self._json(app.start_run(body))
                m = re.match(r"^/api/candidates/(\d+)/export$", path)
                if m:
                    return self._json(app.export(m.group(1), body))
                raise FileNotFoundError(path)
            except Exception as exc:
                self._error(exc)

    return Handler


def serve(host: str = "127.0.0.1", port: int = 8765, workspace: Path = Path("workspace"), root: Path = Path("."),
          data_dir: Path = Path("data"), configs_dir: Path = Path("configs")) -> None:
    app = App(workspace, root, data_dir, configs_dir)
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    print(f"AI Strategy Explorer UI on http://{host}:{port}  (workspace {app.ws})")
    print(RESEARCH_ONLY_NOTICE)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
