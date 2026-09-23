"""Experiment database and append-only Trial Ledger (SQLite).

Integrity rules are enforced by the database itself, not only by Python code:

* ``trials`` rows can never be deleted or updated (every tested candidate,
  including failures, invalid DSL and duplicates, stays on record).
* ``holdout_evaluations`` rows can never be deleted or updated.
* ``candidates`` rows can never be deleted.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

from ..util import dumps, utc_now_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  asset TEXT, timeframe TEXT, asset_class TEXT, data_source TEXT,
  random_seed INTEGER NOT NULL,
  data_version TEXT NOT NULL,
  holdout_data_version TEXT,
  code_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  trial_budget INTEGER NOT NULL,
  cost_model_json TEXT NOT NULL,
  split_json TEXT NOT NULL,
  quality_json TEXT,
  progress_json TEXT,
  summary_json TEXT,
  error TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS trials (
  trial_id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
  seq INTEGER NOT NULL,
  parent_trial INTEGER,
  parents_json TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  creation_method TEXT NOT NULL,
  operator TEXT,
  phase TEXT,
  strategy_hash TEXT,
  dsl TEXT NOT NULL,
  parameters_json TEXT,
  family TEXT,
  complexity_score REAL,
  complexity_json TEXT,
  is_result_json TEXT,
  oos_result_json TEXT,
  cost_json TEXT NOT NULL,
  status TEXT NOT NULL,
  counts_toward_budget INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER,
  robustness REAL,
  is_return REAL,
  oos_return REAL,
  is_sharpe_bar REAL,
  oos_sharpe_bar REAL,
  is_trades INTEGER,
  oos_trades INTEGER,
  novelty_json TEXT,
  error TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (experiment_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_trials_exp_status ON trials(experiment_id, status);
CREATE INDEX IF NOT EXISTS ix_trials_exp_hash ON trials(experiment_id, strategy_hash);
CREATE INDEX IF NOT EXISTS ix_trials_exp_rob ON trials(experiment_id, robustness);
CREATE TRIGGER IF NOT EXISTS trials_no_delete BEFORE DELETE ON trials
BEGIN SELECT RAISE(ABORT, 'Trial Ledger is append-only: trials can never be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trials_no_update BEFORE UPDATE ON trials
BEGIN SELECT RAISE(ABORT, 'Trial Ledger rows are immutable'); END;

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
  trial_id INTEGER NOT NULL REFERENCES trials(trial_id),
  strategy_hash TEXT NOT NULL,
  dsl TEXT NOT NULL,
  selection_rank INTEGER,
  pareto_rank INTEGER,
  robustness REAL,
  novelty_class TEXT,
  status TEXT NOT NULL,
  gate_json TEXT,
  validation_json TEXT,
  explanation_json TEXT,
  holdout_status TEXT NOT NULL DEFAULT 'LOCKED',
  holdout_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (experiment_id, trial_id)
);
CREATE TRIGGER IF NOT EXISTS candidates_no_delete BEFORE DELETE ON candidates
BEGIN SELECT RAISE(ABORT, 'candidates can never be deleted'); END;

CREATE TABLE IF NOT EXISTS holdout_registry (
  dataset_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  data_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  consumed_by TEXT,
  consumed_at TEXT,
  PRIMARY KEY (dataset_key, window_start)
);
CREATE TRIGGER IF NOT EXISTS holdout_registry_no_delete BEFORE DELETE ON holdout_registry
BEGIN SELECT RAISE(ABORT, 'holdout registry rows can never be deleted'); END;
CREATE TRIGGER IF NOT EXISTS holdout_registry_no_relock BEFORE UPDATE OF status ON holdout_registry
WHEN OLD.status = 'CONSUMED'
BEGIN SELECT RAISE(ABORT, 'a consumed holdout window can never be locked again'); END;

CREATE TABLE IF NOT EXISTS holdout_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  experiment_id TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  strategy_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  passed INTEGER NOT NULL,
  evaluated_at TEXT NOT NULL,
  UNIQUE (dataset_key, window_start, strategy_hash)
);
CREATE TRIGGER IF NOT EXISTS holdout_eval_no_delete BEFORE DELETE ON holdout_evaluations
BEGIN SELECT RAISE(ABORT, 'holdout evaluations can never be deleted'); END;
CREATE TRIGGER IF NOT EXISTS holdout_eval_no_update BEFORE UPDATE ON holdout_evaluations
BEGIN SELECT RAISE(ABORT, 'holdout evaluations are immutable'); END;

CREATE TABLE IF NOT EXISTS patterns (
  experiment_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  template_json TEXT,
  occurrences_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, pattern_id)
);

CREATE TABLE IF NOT EXISTS regimes (
  experiment_id TEXT PRIMARY KEY,
  model_json TEXT NOT NULL,
  description_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  experiment_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  reflection_text TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, generation)
);

CREATE TABLE IF NOT EXISTS research_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL,
  asset TEXT,
  timeframe TEXT,
  family TEXT NOT NULL,
  scope TEXT NOT NULL,
  n_trials INTEGER NOT NULL,
  stats_json TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_memory_family ON research_memory(family, scope);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT,
  purpose TEXT NOT NULL,
  backend TEXT NOT NULL,
  model TEXT,
  prompt_hash TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_llm_hash ON llm_calls(prompt_hash);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""

TRIAL_COLUMNS = (
    "experiment_id", "seq", "parent_trial", "parents_json", "generation", "creation_method", "operator", "phase",
    "strategy_hash", "dsl", "parameters_json", "family", "complexity_score", "complexity_json", "is_result_json",
    "oos_result_json", "cost_json", "status", "counts_toward_budget", "duplicate_of", "robustness", "is_return",
    "oos_return", "is_sharpe_bar", "oos_sharpe_bar", "is_trades", "oos_trades", "novelty_json", "error",
    "meta_json", "created_at",
)
_JSON_SUFFIX = "_json"


def _decode(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    for k in list(d):
        if k.endswith(_JSON_SUFFIX) and isinstance(d[k], str):
            try:
                d[k[: -len(_JSON_SUFFIX)]] = json.loads(d[k])
            except json.JSONDecodeError:
                d[k[: -len(_JSON_SUFFIX)]] = None
            del d[k]
    return d


class LedgerDB:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        with self._conn() as con:
            con.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        con = getattr(self._local, "con", None)
        if con is None:
            con = sqlite3.connect(str(self.path), timeout=60, isolation_level=None, check_same_thread=False)
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA foreign_keys=ON")
            con.execute("PRAGMA synchronous=NORMAL")
            self._local.con = con
        return con

    def close(self) -> None:
        con = getattr(self._local, "con", None)
        if con is not None:
            con.close()
            self._local.con = None

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        return self._conn().execute(sql, tuple(params))

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        return [_decode(r) for r in self._conn().execute(sql, tuple(params)).fetchall()]

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        return _decode(self._conn().execute(sql, tuple(params)).fetchone())

    # ----------------------------------------------------------- experiments
    def create_experiment(self, rec: dict) -> None:
        cols = ["experiment_id", "name", "created_at", "status", "asset", "timeframe", "asset_class", "data_source",
                "random_seed", "data_version", "holdout_data_version", "code_version", "config_hash", "config_json",
                "trial_budget", "cost_model_json", "split_json", "quality_json"]
        vals = [rec.get(c) for c in cols]
        self.execute(f"INSERT INTO experiments ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", vals)

    def update_experiment(self, experiment_id: str, **fields: Any) -> None:
        allowed = {"status", "progress_json", "summary_json", "error", "finished_at"}
        sets, vals = [], []
        for k, v in fields.items():
            if k not in allowed:
                raise ValueError(f"experiment field {k} is not updatable")
            sets.append(f"{k} = ?")
            vals.append(v if not isinstance(v, (dict, list)) else dumps(v))
        if sets:
            self.execute(f"UPDATE experiments SET {', '.join(sets)} WHERE experiment_id = ?", [*vals, experiment_id])

    def experiment(self, experiment_id: str) -> dict | None:
        return self.query_one("SELECT * FROM experiments WHERE experiment_id = ?", [experiment_id])

    def experiments(self) -> list[dict]:
        rows = self.query("SELECT experiment_id, name, created_at, status, asset, timeframe, trial_budget, "
                          "config_hash, data_version, code_version, random_seed, progress_json, summary_json, "
                          "finished_at, error FROM experiments ORDER BY created_at DESC")
        return rows

    # ---------------------------------------------------------------- trials
    def insert_trials(self, rows: list[dict]) -> list[int]:
        if not rows:
            return []
        con = self._conn()
        ids = []
        sql = f"INSERT INTO trials ({', '.join(TRIAL_COLUMNS)}) VALUES ({', '.join('?' * len(TRIAL_COLUMNS))})"
        con.execute("BEGIN")
        try:
            for r in rows:
                vals = []
                for c in TRIAL_COLUMNS:
                    v = r.get(c)
                    if c.endswith(_JSON_SUFFIX) and v is not None and not isinstance(v, str):
                        v = dumps(v)
                    vals.append(v)
                cur = con.execute(sql, vals)
                ids.append(int(cur.lastrowid))
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        return ids

    def trial(self, trial_id: int) -> dict | None:
        return self.query_one("SELECT * FROM trials WHERE trial_id = ?", [trial_id])

    def trials(self, experiment_id: str, status: str | None = None, order: str = "robustness", limit: int = 100,
               offset: int = 0, method: str | None = None) -> list[dict]:
        order_sql = {
            "robustness": "robustness DESC NULLS LAST, trial_id",
            "is_return": "is_return DESC NULLS LAST, trial_id",
            "oos_return": "oos_return DESC NULLS LAST, trial_id",
            "seq": "seq",
            "complexity": "complexity_score ASC NULLS LAST, trial_id",
        }.get(order, "robustness DESC NULLS LAST, trial_id")
        where, params = ["experiment_id = ?"], [experiment_id]
        if status:
            where.append("status = ?")
            params.append(status)
        if method:
            where.append("creation_method = ?")
            params.append(method)
        sql = f"SELECT * FROM trials WHERE {' AND '.join(where)} ORDER BY {order_sql} LIMIT ? OFFSET ?"
        return self.query(sql, [*params, int(limit), int(offset)])

    def trial_counts(self, experiment_id: str) -> dict:
        rows = self.query("SELECT status, COUNT(*) AS n, SUM(counts_toward_budget) AS budget FROM trials "
                          "WHERE experiment_id = ? GROUP BY status", [experiment_id])
        by_status = {r["status"]: int(r["n"]) for r in rows}
        methods = self.query("SELECT creation_method, COUNT(*) AS n FROM trials WHERE experiment_id = ? "
                             "GROUP BY creation_method", [experiment_id])
        return {
            "total_recorded": sum(by_status.values()),
            "budget_used": int(sum((r["budget"] or 0) for r in rows)),
            "by_status": by_status,
            "by_method": {r["creation_method"]: int(r["n"]) for r in methods},
        }

    def lineage(self, trial_id: int, max_depth: int = 64) -> list[dict]:
        chain, seen = [], set()
        frontier = [trial_id]
        while frontier and len(chain) < 500:
            tid = frontier.pop(0)
            if tid is None or tid in seen:
                continue
            seen.add(tid)
            t = self.query_one("SELECT trial_id, seq, parent_trial, parents_json, generation, creation_method, "
                               "operator, phase, strategy_hash, dsl, status, robustness, is_return, oos_return "
                               "FROM trials WHERE trial_id = ?", [tid])
            if t is None:
                continue
            chain.append(t)
            if len(seen) > max_depth * 4:
                break
            for p in (t.get("parents") or []):
                if p not in seen:
                    frontier.append(p)
        return chain

    # ------------------------------------------------------------ candidates
    def upsert_candidate(self, rec: dict) -> int:
        now = utc_now_iso()
        existing = self.query_one("SELECT candidate_id FROM candidates WHERE experiment_id = ? AND trial_id = ?",
                                  [rec["experiment_id"], rec["trial_id"]])
        jsonify = {k: (dumps(v) if isinstance(v, (dict, list)) else v) for k, v in rec.items()}
        if existing:
            fields = [k for k in jsonify if k not in ("experiment_id", "trial_id", "candidate_id")]
            self.execute(f"UPDATE candidates SET {', '.join(f'{k} = ?' for k in fields)}, updated_at = ? "
                         "WHERE candidate_id = ?", [*[jsonify[k] for k in fields], now, existing["candidate_id"]])
            return int(existing["candidate_id"])
        cols = list(jsonify) + ["created_at", "updated_at"]
        vals = list(jsonify.values()) + [now, now]
        cur = self.execute(f"INSERT INTO candidates ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                           vals)
        return int(cur.lastrowid)

    def candidate(self, candidate_id: int) -> dict | None:
        return self.query_one("SELECT * FROM candidates WHERE candidate_id = ?", [candidate_id])

    def candidates(self, experiment_id: str | None = None) -> list[dict]:
        if experiment_id:
            return self.query("SELECT * FROM candidates WHERE experiment_id = ? ORDER BY selection_rank",
                              [experiment_id])
        return self.query("SELECT * FROM candidates ORDER BY updated_at DESC")

    # ----------------------------------------------------------- misc tables
    def save_patterns(self, experiment_id: str, patterns: list[dict]) -> None:
        now = utc_now_iso()
        for p in patterns:
            self.execute("INSERT OR REPLACE INTO patterns (experiment_id, pattern_id, kind, summary_json, "
                         "template_json, occurrences_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         [experiment_id, p["pattern_id"], p["kind"], dumps(p["summary"]), dumps(p.get("template")),
                          dumps(p.get("occurrences")), now])

    def patterns(self, experiment_id: str) -> list[dict]:
        return self.query("SELECT experiment_id, pattern_id, kind, summary_json, template_json, created_at "
                          "FROM patterns WHERE experiment_id = ? ORDER BY pattern_id", [experiment_id])

    def pattern(self, experiment_id: str, pattern_id: str) -> dict | None:
        return self.query_one("SELECT * FROM patterns WHERE experiment_id = ? AND pattern_id = ?",
                              [experiment_id, pattern_id])

    def save_regimes(self, experiment_id: str, model: dict, description: list) -> None:
        self.execute("INSERT OR REPLACE INTO regimes (experiment_id, model_json, description_json, created_at) "
                     "VALUES (?, ?, ?, ?)", [experiment_id, dumps(model), dumps(description), utc_now_iso()])

    def regimes(self, experiment_id: str) -> dict | None:
        return self.query_one("SELECT * FROM regimes WHERE experiment_id = ?", [experiment_id])

    def save_generation(self, experiment_id: str, generation: int, summary: dict, reflection: str | None) -> None:
        self.execute("INSERT OR REPLACE INTO generations (experiment_id, generation, summary_json, reflection_text, "
                     "created_at) VALUES (?, ?, ?, ?, ?)",
                     [experiment_id, generation, dumps(summary), reflection, utc_now_iso()])

    def generations(self, experiment_id: str) -> list[dict]:
        return self.query("SELECT * FROM generations WHERE experiment_id = ? ORDER BY generation", [experiment_id])

    def add_memory(self, rec: dict) -> None:
        self.execute("INSERT INTO research_memory (experiment_id, asset, timeframe, family, scope, n_trials, "
                     "stats_json, conclusion, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                     [rec["experiment_id"], rec.get("asset"), rec.get("timeframe"), rec["family"], rec["scope"],
                      int(rec["n_trials"]), dumps(rec.get("stats", {})), rec["conclusion"], rec.get("note"),
                      utc_now_iso()])

    def memory(self, scope: str | None = None, asset: str | None = None, timeframe: str | None = None) -> list[dict]:
        where, params = [], []
        if scope:
            where.append("scope = ?")
            params.append(scope)
        if asset:
            where.append("asset = ?")
            params.append(asset)
        if timeframe:
            where.append("timeframe = ?")
            params.append(timeframe)
        sql = "SELECT * FROM research_memory" + (f" WHERE {' AND '.join(where)}" if where else "") + \
              " ORDER BY id DESC"
        return self.query(sql, params)

    def log_llm(self, rec: dict) -> None:
        self.execute("INSERT INTO llm_calls (experiment_id, purpose, backend, model, prompt_hash, prompt, response, "
                     "meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                     [rec.get("experiment_id"), rec["purpose"], rec["backend"], rec.get("model"), rec["prompt_hash"],
                      rec["prompt"], rec.get("response"), dumps(rec.get("meta", {})), utc_now_iso()])

    def llm_cached(self, prompt_hash: str) -> dict | None:
        return self.query_one("SELECT * FROM llm_calls WHERE prompt_hash = ? AND response IS NOT NULL "
                              "ORDER BY id LIMIT 1", [prompt_hash])

    def llm_calls(self, experiment_id: str, limit: int = 200) -> list[dict]:
        return self.query("SELECT id, purpose, backend, model, prompt_hash, created_at, meta_json FROM llm_calls "
                          "WHERE experiment_id = ? ORDER BY id DESC LIMIT ?", [experiment_id, limit])

    def log_event(self, experiment_id: str | None, level: str, message: str) -> None:
        self.execute("INSERT INTO events (experiment_id, level, message, created_at) VALUES (?, ?, ?, ?)",
                     [experiment_id, level, message[:4000], utc_now_iso()])

    def events(self, experiment_id: str, limit: int = 200) -> list[dict]:
        return self.query("SELECT * FROM events WHERE experiment_id = ? ORDER BY id DESC LIMIT ?",
                          [experiment_id, limit])

    def add_export(self, experiment_id: str, candidate_id: int, path: str, files: list[str]) -> None:
        self.execute("INSERT INTO exports (experiment_id, candidate_id, path, files_json, created_at) "
                     "VALUES (?, ?, ?, ?, ?)", [experiment_id, candidate_id, path, dumps(files), utc_now_iso()])

    def exports(self, experiment_id: str | None = None) -> list[dict]:
        if experiment_id:
            return self.query("SELECT * FROM exports WHERE experiment_id = ? ORDER BY id DESC", [experiment_id])
        return self.query("SELECT * FROM exports ORDER BY id DESC")
