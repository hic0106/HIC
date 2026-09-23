"""Shared experiment plumbing: data loading, split planning (with the holdout
vault), cost models, and rebuilding a finished experiment's evaluation
context for export / UI / holdout checks."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..backtest.costs import CostModel
from ..backtest.engine import ExecConfig
from ..data.market import MarketData
from ..data.providers import provider_from_config
from ..data.splits import SplitError, SplitPlan, make_split
from ..ledger.db import LedgerDB
from ..patterns.library import PatternLibrary
from ..regimes.detector import RegimeModel
from ..search.evaluation import SearchSpec, StrategyEvaluator
from ..util import parse_date_ms
from ..validation.holdout import PROSPECTIVE_HASH, HoldoutVault, dataset_key, holdout_hash

OPEN_END = 2 ** 62


def load_market_data(cfg: dict, root: Path | None = None) -> MarketData:
    d = dict(cfg["data"])
    if d.get("path") and root is not None and not Path(d["path"]).is_absolute():
        d["path"] = str((root / d["path"]).resolve())
    if d.get("cache_dir") and root is not None and not Path(d["cache_dir"]).is_absolute():
        d["cache_dir"] = str((root / d["cache_dir"]).resolve())
    prov = provider_from_config(d)
    md = prov.load(d["asset"], d["timeframe"], parse_date_ms(d.get("start") or None), parse_date_ms(d.get("end") or None))
    if d.get("asset_class"):
        md.asset_class = d["asset_class"]
    if len(md) == 0:
        raise ValueError("data provider returned no bars")
    return md


def costs_for(cfg: dict, asset_class: str) -> CostModel:
    base = dict(cfg["costs"])
    base.update(cfg.get("costs_by_asset_class", {}).get(asset_class, {}))
    return CostModel.from_dict(base)


def exec_config(cfg: dict) -> ExecConfig:
    b = cfg["backtest"]
    return ExecConfig(sizing=b["sizing"], leverage=float(b["leverage"]), initial_equity=float(b["initial_equity"]),
                      notional=float(b["notional"]))


def split_from_dict(d: dict) -> SplitPlan:
    return SplitPlan(n=int(d["n"]), train=tuple(d["train"]), validation=tuple(d["validation"]), test=tuple(d["test"]),
                     holdout=tuple(d["holdout"]), boundaries_ms=d["boundaries_ms"],
                     embargo_bars=int(d.get("embargo_bars", 0)), mode=d.get("mode", "fractions"))


def plan_split(md: MarketData, cfg: dict, db: LedgerDB, experiment_id: str) -> tuple[SplitPlan, dict]:
    """Chronological split + holdout registration. Returns (plan, holdout_info)."""
    hcfg = cfg["holdout"]
    key = dataset_key(md.source, md.asset, md.timeframe)
    vault = HoldoutVault(db, key)
    n = len(md)
    consumed = vault.consumed_until()
    if hcfg["mode"] == "prospective" and consumed is not None:
        c = md.index_of_ts(consumed + md.bar_ms, "left")
        pre = md.slice(0, c)
        s = cfg["split"]
        tot = float(s["train"]) + float(s["validation"]) + float(s["test"])
        sub = {"mode": "fractions", "train": float(s["train"]) / tot, "validation": float(s["validation"]) / tot,
               "test": float(s["test"]) / tot - 1e-12, "embargo_bars": s.get("embargo_bars", 0)}
        p = make_split(pre, sub, {"holdout": 0})
        plan = SplitPlan(n=n, train=p.train, validation=p.validation, test=(p.test[0], c), holdout=(c, n),
                         boundaries_ms={**p.boundaries_ms, "holdout_start": int(consumed + md.bar_ms),
                                        "data_end": int(md.ts[-1])}, embargo_bars=p.embargo_bars, mode="prospective")
    else:
        min_h = int(hcfg["min_bars"]) if hcfg["mode"] == "fixed" else 0
        try:
            plan = make_split(md, cfg["split"], {"holdout": min_h})
        except SplitError as exc:
            raise SplitError(f"{exc}. Increase the data range or use holdout.mode = 'prospective'.") from exc
    c = plan.holdout_start
    start_ms = int(plan.boundaries_ms["holdout_start"])
    bars = n - c
    if hcfg["mode"] == "prospective":
        vault.register(experiment_id, start_ms, OPEN_END, PROSPECTIVE_HASH)
        status = "LOCKED" if bars >= int(hcfg["min_bars"]) else "AWAITING_DATA"
        h_hash = holdout_hash(md, c, n) if bars else None
    else:
        h_hash = holdout_hash(md, c, n)
        vault.register(experiment_id, start_ms, int(md.ts[-1]), h_hash)
        status = "LOCKED"
    return plan, {"dataset_key": key, "window_start_ms": start_ms, "bars": bars, "status": status,
                  "mode": hcfg["mode"], "data_hash": h_hash}


@dataclass
class ExperimentContext:
    experiment_id: str
    cfg: dict
    record: dict
    split: SplitPlan
    md_search: MarketData
    htf: tuple[str, ...]
    regime_model: RegimeModel | None
    pattern_library: PatternLibrary | None
    costs: CostModel
    exec_cfg: ExecConfig
    _evaluator: StrategyEvaluator | None = None

    @property
    def registry_kwargs(self) -> dict:
        return dict(columns=frozenset(self.md_search.available_columns()), htf=self.htf,
                    n_regimes=self.regime_model.n_states if self.regime_model else 0,
                    pattern_ids=self.pattern_library.ids() if self.pattern_library else (),
                    max_window=int(self.cfg["search"].get("max_window", 200)),
                    base_timeframe=self.md_search.timeframe)

    def spec(self) -> SearchSpec:
        s = self.cfg["search"]
        return SearchSpec(md=self.md_search, split=self.split, costs=self.costs, exec_cfg=self.exec_cfg, htf=self.htf,
                          registry_kwargs=self.registry_kwargs, regime_model=self.regime_model,
                          pattern_library=self.pattern_library, n_blocks=int(self.cfg["backtest"]["n_blocks"]),
                          behavior_dim=int(s["behavior_dim"]), max_nodes=int(s["max_nodes"]) + 40,
                          max_depth=int(s["max_depth"]) + 6)

    @property
    def evaluator(self) -> StrategyEvaluator:
        if self._evaluator is None:
            self._evaluator = StrategyEvaluator(self.spec())
        return self._evaluator


def rebuild_context(db: LedgerDB, experiment_id: str, root: Path | None = None) -> ExperimentContext:
    rec = db.experiment(experiment_id)
    if rec is None:
        raise KeyError(f"unknown experiment {experiment_id}")
    cfg = rec["config"]
    md = load_market_data(cfg, root)
    split = split_from_dict(rec["split"])
    md_search = md.slice(0, split.holdout_start)
    if md_search.version() != rec["data_version"]:
        raise RuntimeError("the data source no longer matches the experiment's data_version (history changed)")
    rm = None
    reg = db.regimes(experiment_id)
    if reg and reg.get("model"):
        rm = RegimeModel.from_dict(reg["model"])
    lib = None
    pats = db.query("SELECT pattern_id, template_json FROM patterns WHERE experiment_id = ?", [experiment_id])
    templates = {p["pattern_id"]: p["template"] for p in pats if p.get("template")}
    if templates:
        lib = PatternLibrary(int(cfg["patterns"].get("norm_window", 50)))
        for k, v in templates.items():
            import numpy as np

            lib.add(k, np.asarray(v, dtype=np.float64))
    return ExperimentContext(experiment_id=experiment_id, cfg=cfg, record=rec, split=split, md_search=md_search,
                             htf=tuple(cfg["data"].get("extra_timeframes", [])), regime_model=rm, pattern_library=lib,
                             costs=costs_for(cfg, md.asset_class), exec_cfg=exec_config(cfg))
