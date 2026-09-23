"""LLM proposer: parsing, recording/replay, refusal handling and train-only information flow."""

import json
from types import SimpleNamespace

import numpy as np
import pytest

from strategy_explorer.dsl.complexity import complexity
from strategy_explorer.dsl.registry import Registry
from strategy_explorer.dsl.typecheck import compile_strategy
from strategy_explorer.ledger.db import LedgerDB
from strategy_explorer.llm.client import (AnthropicClient, LLMRequest, LLMResponse, LLMUnavailable, RecordingClient,
                                          ReplayClient)
from strategy_explorer.llm.hypothesis import HypothesisEngine
from strategy_explorer.llm.prompts import HYPOTHESES_SCHEMA, system_prompt
from strategy_explorer.llm.reflection import summarize, summary_text, train_view
from strategy_explorer.search.trials import TrialRecord

SENTINEL = 987654.321


class FakeLLM:
    backend = "fake"
    model = "fake-model"

    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def complete_json(self, req):
        self.requests.append(req)
        return LLMResponse(self.payload, json.dumps(self.payload), self.model, self.backend, "end_turn")


def _record(i, st, is_ret, oos_ret):
    is_m = {"valid": True, "total_return": is_ret, "gross_return": is_ret + 0.05, "turnover": 10.0 + i,
            "consistency": 0.5, "trades": 30, "sharpe_bar": 0.01}
    return TrialRecord(trial_id=i, seq=i, strategy=st, hash=st.hash, status="EVALUATED", creation_method="GP",
                       operator=None, phase="explore", generation=1, parents=(), family=f"fam{i % 3}",
                       group=f"long:grp{i % 2}", is_metrics=is_m, complexity=complexity(st),
                       robustness=0.1 + 0.01 * i, violation=0.0, meta={"oos_total_return": oos_ret})


def test_reflection_uses_train_metrics_only():
    reg = Registry()
    st = compile_strategy("LONG_ENTRY: GT(return(3), 0.01)\nMAX_HOLD: 5", reg)
    recs = [_record(i, st, 0.01 * i, SENTINEL) for i in range(30)]
    v = train_view(recs[0])
    assert not any("oos" in f or "valid" in f for f in v.__dataclass_fields__ if f != "trial_id")
    text = summary_text(summarize(recs, min_group=3))
    assert str(SENTINEL) not in text and "987654" not in text
    assert "TRAIN" in text or "evaluated rules" in text


def test_llm_hypotheses_are_proposals_only_and_invalid_dsl_is_recorded(tmp_path):
    payload = {"hypotheses": [
        {"name": "ok", "rationale": "volume expansion near range highs", "pattern_ids": ["C1"],
         "dsl": "LONG_ENTRY: AND(GT(volume_zscore(20), 1.5), GT(range_position(20), 0.8))\nMAX_HOLD: 6"},
        {"name": "absolute price", "rationale": "x", "pattern_ids": [], "dsl": "LONG_ENTRY: GT(close, 50000)\nMAX_HOLD: 3"},
        {"name": "unknown fn", "rationale": "x", "pattern_ids": [], "dsl": "LONG_ENTRY: GT(rsi(14), 30)\nMAX_HOLD: 3"},
    ]}
    llm = FakeLLM(payload)
    reg = Registry()
    eng = HypothesisEngine(llm, reg.grammar_card(), "4h", "crypto", np.random.default_rng(0))
    props = eng._ask("hypothesis", "patterns...", "LLM", "explore", 0)
    assert [p.meta["name"] for p in props] == ["ok", "absolute price", "unknown fn"]
    assert all(p.text and p.strategy is None and p.creation_method == "LLM" for p in props)
    req = llm.requests[0]
    assert req.schema == HYPOTHESES_SCHEMA and "Your text is never used to score a strategy" in req.system
    # pipeline: the manager compiles each proposal; invalid ones become INVALID_DSL trials (recorded, not counted)
    from strategy_explorer.backtest import CostModel, ExecConfig
    from strategy_explorer.data import make_split
    from strategy_explorer.data.synthetic import generate_synthetic
    from strategy_explorer.dsl.typecheck import TypeChecker
    from strategy_explorer.search.budget import SearchBudget
    from strategy_explorer.search.evaluation import EvaluatorPool, SearchSpec
    from strategy_explorer.search.objectives import ConstraintConfig
    from strategy_explorer.search.trials import TrialManager

    md = generate_synthetic(3000, "4h", seed=1)
    split = make_split(md, {"mode": "fractions"})
    spec = SearchSpec(md=md.slice(0, split.holdout_start), split=split, costs=CostModel(), exec_cfg=ExecConfig(),
                      registry_kwargs=dict(columns=frozenset(md.available_columns()), base_timeframe="4h"))
    db = LedgerDB(tmp_path / "l.sqlite")
    db.create_experiment(dict(experiment_id="E", name="t", created_at="now", status="RUNNING", random_seed=1,
                              data_version="v", code_version="c", config_hash="h", config_json="{}", trial_budget=10,
                              cost_model_json="{}", split_json="{}"))
    mgr = TrialManager(db, "E", SearchBudget(10), EvaluatorPool(spec), TypeChecker(spec.registry()), CostModel(),
                       ConstraintConfig(min_trades=5))
    recs = mgr.submit(props)
    assert recs[0] is not None and recs[1] is None and recs[2] is None
    counts = db.trial_counts("E")
    assert counts["by_status"]["INVALID_DSL"] == 2 and counts["budget_used"] == 1
    with pytest.raises(PermissionError):
        mgr.oos_metrics(recs[0].trial_id)  # sealed until the search is closed
    mgr.close_search()
    assert mgr.oos_metrics(recs[0].trial_id) is not None


def test_recording_and_replay_reproduce_responses(tmp_path):
    db = LedgerDB(tmp_path / "l.sqlite")
    payload = {"hypotheses": [{"name": "a", "rationale": "r", "pattern_ids": [], "dsl": "LONG_ENTRY: GT(return(2), 0)\nMAX_HOLD: 3"}]}
    inner = FakeLLM(payload)
    inner.model = "claude-opus-5"
    rec = RecordingClient(inner, db, "E", max_calls=1)
    req = LLMRequest("hypothesis", "SYS", "USER", HYPOTHESES_SCHEMA)
    assert rec.complete_json(req).data == payload
    with pytest.raises(LLMUnavailable):
        rec.complete_json(req)  # call budget enforced
    rep = ReplayClient(db, "claude-opus-5")
    assert rep.complete_json(req).data == payload
    with pytest.raises(LLMUnavailable):
        rep.complete_json(LLMRequest("hypothesis", "SYS", "OTHER", HYPOTHESES_SCHEMA))


def test_anthropic_client_request_shape_and_refusal(monkeypatch):
    pytest.importorskip("anthropic")
    c = AnthropicClient(model="claude-opus-5")
    calls = []

    def fake_create(**kw):
        calls.append(kw)
        if len(calls) == 1:
            return SimpleNamespace(stop_reason="end_turn", model="claude-opus-5", usage=None,
                                   content=[SimpleNamespace(type="thinking", thinking=""),
                                            SimpleNamespace(type="text", text='{"hypotheses": []}')])
        return SimpleNamespace(stop_reason="refusal", model="claude-opus-5", usage=None, content=[])

    monkeypatch.setattr(c.client.beta.messages, "create", fake_create)
    req = LLMRequest("vision", "SYS", "USER", HYPOTHESES_SCHEMA, images=[b"\x89PNG..."])
    r = c.complete_json(req)
    assert r.data == {"hypotheses": []} and not r.refused
    kw = calls[0]
    assert kw["model"] == "claude-opus-5" and kw["fallbacks"] == "default"
    assert kw["betas"] == ["server-side-fallback-2026-07-01"]
    assert kw["thinking"] == {"type": "adaptive"}
    assert kw["output_config"]["format"]["type"] == "json_schema"
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}
    content = kw["messages"][0]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["media_type"] == "image/png"
    r2 = c.complete_json(req)
    assert r2.refused and r2.data is None


def test_system_prompt_forbids_textbook_strategies_and_embeds_grammar():
    reg = Registry(htf=("1d",), n_regimes=3)
    sp = system_prompt("hypothesis", reg.grammar_card(), "4h", "crypto")
    assert "Donchian" in sp and "KNOWN_LIKE" in sp and "TRAIN segment only" in sp
    assert "volume_zscore" in sp and "regime_is" in sp and "tf(" in sp
