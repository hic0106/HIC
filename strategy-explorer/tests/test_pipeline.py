"""End-to-end research runs on synthetic data (null process and planted behaviour)."""

import sqlite3

import numpy as np
import pytest

from strategy_explorer.config import load_config
from strategy_explorer.data.synthetic import generate_synthetic
from strategy_explorer.export import EXPORT_FILES, export_candidate
from strategy_explorer.pipeline.run import ResearchRun
from strategy_explorer.validation.holdout import HoldoutConsumedError, HoldoutError, HoldoutVault

FAST = [
    "data.provider=\"synthetic\"", "search.workers=1", "gp.population=30", "mcts.iterations=8", "mcts.roots=1",
    "selection.pool=16", "selection.max_candidates=4", "selection.sensitivity_variants=8", "walk_forward.n_folds=4",
    "stress.mc_runs=10", "sensitivity.max_variants=16", "pbo.top_k=30", "pbo.n_blocks=12", "patterns.max_patterns=6",
]


def run(tmp, extra, name):
    cfg = load_config(None, FAST + [f'experiment.workspace="{tmp}"', f'experiment.name="{name}"'] + extra)
    r = ResearchRun(cfg, root=".")
    r.run()
    return r


@pytest.fixture(scope="module")
def ws(tmp_path_factory):
    return tmp_path_factory.mktemp("ws")


@pytest.fixture(scope="module")
def planted(ws):
    # default gate thresholds: a real (planted) edge has to pass the same firewall as everything else
    return run(ws, ["data.plant=\"squeeze_breakout\"", "data.plant_strength=3.0", "data.n_bars=9000",
                    "data.seed=5", "search.max_trials=420"], "planted")


@pytest.fixture(scope="module")
def null(ws):
    return run(ws, ["data.n_bars=6000", "data.seed=21", "search.max_trials=300", "data.asset=\"NULL\""], "null")


def test_null_process_produces_no_winner(null):
    cands = null.db.candidates(null.eid)
    assert all(c["status"] != "RESEARCH_WINNER" for c in cands)
    reg = null.db.query("SELECT * FROM holdout_registry WHERE registered_by = ?", [null.eid])
    assert reg and reg[0]["status"] == "LOCKED"  # nothing earned a look at the holdout
    counts = null.db.trial_counts(null.eid)
    assert counts["budget_used"] == 300
    assert counts["total_recorded"] >= 300


def test_every_trial_is_recorded_and_ledger_is_append_only(null):
    counts = null.db.trial_counts(null.eid)
    assert counts["by_status"].get("EVALUATED", 0) > 0
    con = sqlite3.connect(null.db.path)
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("DELETE FROM trials WHERE experiment_id = ?", [null.eid])
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("UPDATE trials SET status = 'EVALUATED' WHERE status = 'NO_TRADES'")
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("UPDATE trials SET is_return = 99")
    con.close()


def test_search_never_saw_holdout(planted):
    assert len(planted.md) == planted.split.holdout_start
    with pytest.raises(PermissionError):
        planted.ev.segment_bounds("holdout")
    with pytest.raises(RuntimeError):
        planted.manager.submit([])  # search closed: no further trials
    assert int(planted.md.ts[-1]) < int(planted.split.boundaries_ms["holdout_start"])


def test_planted_behaviour_rediscovered(planted):
    md = generate_synthetic(9000, "4h", seed=5, plant="squeeze_breakout", plant_strength=3.0)
    events = np.array(md.synthetic_events)
    cands = planted.db.candidates(planted.eid)
    assert cands, "no candidates"
    best = max(cands, key=lambda c: c["robustness"])
    v = best["validation"]
    assert v["oos"]["total_return"] > 0 and v["test"]["total_return"] > 0
    # entries of the best candidate cluster right after the planted expansion bars
    from strategy_explorer.dsl.registry import Registry
    from strategy_explorer.dsl.typecheck import compile_strategy

    st = compile_strategy(best["dsl"], Registry(**planted.spec.registry_kwargs), 400, 60)
    sig = planted.ev.signals(st)
    entries = np.flatnonzero(sig.long_entry | sig.short_entry)
    near = np.mean([np.any((e - events >= -8) & (e - events <= 2)) for e in entries])
    base_rate = 11 / 110.0 * 1.6  # generous chance level for a +-window around events spaced 45..110 bars
    assert near > base_rate, (near, best["dsl"])


def test_holdout_evaluated_once_and_consumed(planted, ws):
    cands = planted.db.candidates(planted.eid)
    winners = [c for c in cands if c["status"] == "RESEARCH_WINNER"]
    assert winners, [c["gate"]["critical_failures"] for c in cands]
    assert all(c["holdout_status"] in ("HOLDOUT_PASSED", "HOLDOUT_FAILED", "HOLDOUT_INCONCLUSIVE") for c in winners)
    assert all(c["holdout_status"] == "NOT_ELIGIBLE" for c in cands if c["status"] != "RESEARCH_WINNER")
    key = planted.holdout_info["dataset_key"]
    vault = HoldoutVault(planted.db, key)
    row = vault.status(planted.holdout_info["window_start_ms"])
    assert row["status"] == "CONSUMED" and row["consumed_by"] == planted.eid
    evals = planted.db.query("SELECT * FROM holdout_evaluations WHERE experiment_id = ?", [planted.eid])
    assert len(evals) == len(winners)
    # a second unseal of the same window is refused
    with pytest.raises(HoldoutConsumedError):
        vault.unseal(planted.eid, planted.holdout_info["window_start_ms"], [], lambda: None, (), None, None)
    # the consumed window can never be re-locked, and evaluations are immutable
    con = sqlite3.connect(planted.db.path)
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("UPDATE holdout_registry SET status = 'LOCKED'")
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("DELETE FROM holdout_evaluations")
    con.close()
    # a new experiment on the same data cannot reuse the consumed window...
    cfg = load_config(None, FAST + [f'experiment.workspace="{ws}"', "data.plant=\"squeeze_breakout\"",
                                    "data.plant_strength=3.0", "data.n_bars=9000", "data.seed=5",
                                    "search.max_trials=40"])
    with pytest.raises(HoldoutConsumedError):
        ResearchRun(cfg, root=".").run()
    # ...but may run in prospective mode, where the holdout waits for data after the consumed window
    cfg2 = load_config(None, FAST + [f'experiment.workspace="{ws}"', "data.plant=\"squeeze_breakout\"",
                                     "data.plant_strength=3.0", "data.n_bars=9000", "data.seed=5",
                                     "search.max_trials=40", "holdout.mode=\"prospective\""])
    r2 = ResearchRun(cfg2, root=".")
    r2.run()
    assert r2.holdout_info["status"] == "AWAITING_DATA"


def test_export_recipe_files(planted, tmp_path):
    c = max(planted.db.candidates(planted.eid), key=lambda c: c["robustness"])
    out = export_candidate(planted.db, c["candidate_id"], root=".", out_dir=tmp_path)
    import json
    from pathlib import Path

    names = {Path(p).name for p in out["files"].values()}
    assert set(EXPORT_FILES) <= names
    recipe = json.loads(Path(out["folder"], "strategy_recipe.json").read_text())
    assert recipe["research_only"] is True
    assert recipe["entry_expression"] and recipe["execution"]["fill"].startswith("market order at the OPEN")
    assert recipe["reproducibility"]["random_seed"] == 42
    assert recipe["trial_accounting"]["n_trials_evaluated"] == planted.manager.budget.total_used
    assert recipe["cost_model"]["fee_bps"] > 0
    trades = Path(out["folder"], "trades.csv").read_text().splitlines()
    assert len(trades) - 1 == planted.ev.backtest(
        __import__("strategy_explorer.dsl.typecheck", fromlist=["x"]).compile_strategy(
            c["dsl"], __import__("strategy_explorer.dsl.registry", fromlist=["x"]).Registry(
                **planted.spec.registry_kwargs), 400, 60), "search")[1]["trades"]


def test_reproducible_with_different_worker_counts(tmp_path):
    extra = ["data.n_bars=4000", "data.seed=3", "search.max_trials=120", "data.asset=\"REPRO\"",
             "holdout.mode=\"prospective\""]
    a = run(tmp_path / "a", extra + ["search.workers=1"], "repro")
    b = run(tmp_path / "b", extra + ["search.workers=2"], "repro")
    qa = a.db.query("SELECT seq, strategy_hash, status, is_return, oos_return FROM trials WHERE experiment_id = ? "
                    "ORDER BY seq", [a.eid])
    qb = b.db.query("SELECT seq, strategy_hash, status, is_return, oos_return FROM trials WHERE experiment_id = ? "
                    "ORDER BY seq", [b.eid])
    assert qa == qb
    ea, eb = a.db.experiment(a.eid), b.db.experiment(b.eid)
    assert ea["config_hash"] == eb["config_hash"] and ea["data_version"] == eb["data_version"]
    ca = [(c["strategy_hash"], c["status"]) for c in a.db.candidates(a.eid)]
    cb = [(c["strategy_hash"], c["status"]) for c in b.db.candidates(b.eid)]
    assert ca == cb


def test_holdout_requires_winners(ws):
    from strategy_explorer.ledger.db import LedgerDB

    db = LedgerDB(ws / "vault_only.sqlite")
    v = HoldoutVault(db, "x:Y:4h")
    v.register("e1", 1000, 2000, "h")
    with pytest.raises(HoldoutError):
        v.unseal("e1", 1000, [{"candidate_id": 1, "status": "PROMISING", "strategy": None}], lambda: None, (), None,
                 None)
    with pytest.raises(HoldoutError):
        v.unseal("e1", 1000, [], lambda: None, (), None, None)
    assert v.status(1000)["status"] == "LOCKED"
