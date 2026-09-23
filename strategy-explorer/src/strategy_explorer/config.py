"""Experiment configuration (TOML) with defaults, validation and a stable hash."""

from __future__ import annotations

import copy
import tomllib
from pathlib import Path
from typing import Any

from .util import config_hash

DEFAULTS: dict[str, Any] = {
    "experiment": {"name": "research-run", "random_seed": 42, "workspace": "workspace", "notes": ""},
    "data": {
        "provider": "synthetic", "path": "", "asset": "SYNTH", "asset_class": "crypto", "timeframe": "4h",
        "extra_timeframes": ["1d"], "start": "", "end": "", "n_bars": 6000, "seed": 7, "plant": "",
        "plant_strength": 1.0, "market": "usdm", "cache_dir": "",
    },
    "split": {"mode": "fractions", "train": 0.5, "validation": 0.15, "test": 0.2, "train_end": "",
              "validation_end": "", "test_end": "", "embargo_bars": 0},
    "costs": {"fee_bps": 5.0, "slippage_bps": 2.0, "funding_mode": "constant", "funding_bps_per_8h": 1.0,
              "funding_side": "both_pay"},
    "costs_by_asset_class": {"equity": {"fee_bps": 1.0, "slippage_bps": 2.0, "funding_mode": "none"},
                             "etf": {"fee_bps": 1.0, "slippage_bps": 2.0, "funding_mode": "none"}},
    "backtest": {"sizing": "fixed_fraction", "leverage": 1.0, "initial_equity": 10000.0, "notional": 10000.0,
                 "n_blocks": 6},
    "search": {"max_trials": 2000, "explore_fraction": 0.6, "workers": 0, "min_trades_train": 20,
               "directions": ["long", "short", "long_short"], "max_depth": 6, "max_nodes": 40,
               "max_generations": 300, "behavior_dim": 256, "near_duplicate": 0.95, "hypothesis_share": 0.15,
               "max_window": 200},
    "gp": {"population": 60, "p_crossover": 0.3, "p_immigrant": 0.1,
           "objectives": ["sortino", "consistency", "max_drawdown", "complexity"]},
    "mcts": {"enabled": True, "every": 2, "roots": 2, "iterations": 16, "c_uct": 1.0},
    "selection": {"objectives": ["oos_return", "sortino", "profit_factor", "max_drawdown", "turnover",
                                 "complexity", "sensitivity", "consistency"],
                  "pool": 40, "max_candidates": 10, "min_oos_trades": 5, "sensitivity_variants": 16},
    "patterns": {"enabled": True, "horizons": [1, 3, 5, 10], "primary": 5, "norm_window": 50, "use_motifs": True,
                 "use_shapelets": True, "fdr": 0.10, "template_fdr": 0.25, "max_patterns": 10, "min_events": 20},
    "regimes": {"enabled": True, "n_states": 4, "window": 20},
    "llm": {"provider": "offline", "model": "claude-opus-5", "effort": "high", "max_calls": 40, "max_tokens": 16000,
            "server_side_fallbacks": True, "reflection_every": 3, "hypotheses_per_call": 12, "vision": False,
            "mcts_expansion": False, "narratives": False},
    "memory": {"enabled": True, "min_trials": 25, "penalty": 0.5, "same_asset_only": True},
    "walk_forward": {"mode": "anchored", "n_folds": 5, "test_region": "validation+test", "refit": True,
                     "min_positive_fraction": 0.6},
    "sensitivity": {"min_positive_fraction": 0.6, "min_ratio": 0.5, "min_test_positive_fraction": 0.5,
                    "max_variants": 40},
    "stress": {"missed_trade_prob": 0.1, "mc_runs": 40, "mc_min_positive": 0.8,
               "required": ["fee_x2", "slippage_x2", "fee_x2_slippage_x2", "delay_1", "adverse_5bps"]},
    "pbo": {"top_k": 60, "n_blocks": 16, "candidate_blocks": 10},
    "gate": {"min_oos_trades": 15, "min_train_trades": 20, "max_oos_drawdown": 0.35, "dsr_min": 0.95,
             "pbo_max": 0.30, "max_trade_share": 0.50, "max_month_share": 0.50},
    "dsr": {"segment": "train", "n_trials": "effective", "cluster_threshold": 0.7, "variance": "sampling"},
    "novelty": {"known_threshold": 0.7, "hybrid_threshold": 0.4},
    "cross_asset": {"assets": []},
    "holdout": {"mode": "fixed", "auto_evaluate": True, "min_bars": 100, "min_trades": 5},
    "export": {"dir": "exports"},
}

# keys that do not change results (excluded from the config hash)
NON_SEMANTIC = (("search", "workers"), ("experiment", "workspace"), ("experiment", "notes"), ("experiment", "name"),
                ("export", "dir"))


def deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def set_dotted(cfg: dict, dotted: str, value: Any) -> None:
    keys = dotted.split(".")
    d = cfg
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value


def parse_override(text: str) -> tuple[str, Any]:
    key, _, raw = text.partition("=")
    raw = raw.strip()
    try:
        value = tomllib.loads(f"v = {raw}")["v"]
    except tomllib.TOMLDecodeError:
        value = raw
    return key.strip(), value


def load_config(path: str | Path | None = None, overrides: list[str] | dict | None = None) -> dict:
    cfg = copy.deepcopy(DEFAULTS)
    if path:
        with open(path, "rb") as f:
            cfg = deep_merge(cfg, tomllib.load(f))
    if isinstance(overrides, dict):
        cfg = deep_merge(cfg, overrides)
    elif overrides:
        for o in overrides:
            k, v = parse_override(o)
            set_dotted(cfg, k, v)
    validate(cfg)
    return cfg


def validate(cfg: dict) -> None:
    from .data.market import TIMEFRAME_MS

    d = cfg["data"]
    if d["timeframe"] not in TIMEFRAME_MS:
        raise ValueError(f"data.timeframe {d['timeframe']!r} not supported")
    for tf in d.get("extra_timeframes", []):
        if tf not in TIMEFRAME_MS or TIMEFRAME_MS[tf] % TIMEFRAME_MS[d["timeframe"]] or \
                TIMEFRAME_MS[tf] <= TIMEFRAME_MS[d["timeframe"]]:
            raise ValueError(f"extra timeframe {tf} must be a strict multiple of the base timeframe")
    s = cfg["search"]
    if int(s["max_trials"]) < 10:
        raise ValueError("search.max_trials must be >= 10")
    if not 0 <= float(s["explore_fraction"]) <= 1:
        raise ValueError("search.explore_fraction must be in [0, 1]")
    if cfg["llm"]["provider"] not in ("offline", "anthropic", "replay"):
        raise ValueError("llm.provider must be offline | anthropic | replay")
    if cfg["holdout"]["mode"] not in ("fixed", "prospective"):
        raise ValueError("holdout.mode must be fixed | prospective")
    for k in ("fee_bps", "slippage_bps"):
        if float(cfg["costs"][k]) < 0:
            raise ValueError("costs must be non-negative")


def semantic_view(cfg: dict) -> dict:
    view = copy.deepcopy(cfg)
    for sec, key in NON_SEMANTIC:
        view.get(sec, {}).pop(key, None)
    return view


def hash_config(cfg: dict) -> str:
    return config_hash(semantic_view(cfg))[:24]
