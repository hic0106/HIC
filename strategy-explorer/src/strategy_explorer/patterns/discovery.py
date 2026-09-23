"""Pattern Discovery Engine: runs conditional mining, motif discovery and
shapelet discovery on TRAIN data only and returns Pattern objects plus the
template library used by ``pattern_distance``."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..data.market import MarketData
from ..dsl.evaluator import EvalContext
from ..dsl.registry import Registry
from ..util import derive_rng
from .describe import feature_profile, shape_description, summary_text
from .library import Pattern, PatternLibrary
from .mining import MiningConfig, compile_features, mine_conditional
from .motifs import MotifConfig, ShapeletConfig, discover_motifs, discover_shapelets
from .normalize import channel_matrix
from .stats import forward_returns


@dataclass
class PatternConfig:
    enabled: bool = True
    horizons: tuple[int, ...] = (1, 3, 5, 10)
    primary: int = 5
    norm_window: int = 50
    template_fdr: float = 0.25
    mining: MiningConfig = field(default_factory=MiningConfig)
    motifs: MotifConfig = field(default_factory=MotifConfig)
    shapelets: ShapeletConfig = field(default_factory=ShapeletConfig)
    use_motifs: bool = True
    use_shapelets: bool = True


def discover_patterns(md_train: MarketData, registry: Registry, cfg: PatternConfig, seed: int,
                      regime_labels: np.ndarray | None = None,
                      htf: tuple[str, ...] = ()) -> tuple[list[Pattern], PatternLibrary]:
    """``md_train`` must be the TRAIN slice only (callers pass split.train)."""
    rng = derive_rng(seed, "patterns")
    ctx = EvalContext(md_train, htf)
    fwd = forward_returns(md_train.open, tuple(cfg.horizons))
    cfg.mining.horizons = tuple(cfg.horizons)
    cfg.mining.primary = cfg.primary
    raw: list[dict] = []
    raw.extend(mine_conditional(ctx, registry, fwd, cfg.mining))
    X = channel_matrix(md_train, cfg.norm_window)
    if cfg.use_motifs:
        raw.extend(r for r in discover_motifs(X, fwd, cfg.primary, cfg.motifs) if r.get("q", 1) <= cfg.template_fdr)
    if cfg.use_shapelets:
        raw.extend(r for r in discover_shapelets(X, fwd, cfg.primary, cfg.shapelets, rng)
                   if r.get("q", 1) <= cfg.template_fdr)
    values = {text: np.asarray(ctx.eval(node), dtype=np.float64) for text, node in compile_features(registry)}
    counters = {"conditional": 0, "motif": 0, "shapelet": 0}
    prefix = {"conditional": "C", "motif": "M", "shapelet": "S"}
    lib = PatternLibrary(cfg.norm_window)
    patterns: list[Pattern] = []
    for r in raw:
        counters[r["kind"]] += 1
        pid = f"{prefix[r['kind']]}{counters[r['kind']]}"
        ev = np.asarray(r["events"], dtype=np.int64)
        d = {"pattern_id": pid, "kind": r["kind"], "stats": r["stats"], "q_value": float(r.get("q", 1.0)),
             "length": int(r.get("length", 1))}
        if r["kind"] == "conditional":
            dsl = r["dsl"]
            d["profile"] = feature_profile(values, ev, 0)
            d["shape"] = []
        else:
            template = np.asarray(r["template"])
            lib.add(pid, template)
            dsl = f'LT(pattern_distance("{pid}"), {r["threshold"]})'
            prof = feature_profile(values, ev, 0)
            pre = feature_profile(values, ev, max(1, int(r["length"]) // 2))
            d["profile"] = (prof[:3] + pre[:2])
            d["shape"] = shape_description(template)
        d["dsl"] = dsl
        if regime_labels is not None and ev.size:
            lab = regime_labels[ev[ev < regime_labels.shape[0]]]
            lab = lab[np.isfinite(lab)].astype(int)
            if lab.size:
                vals, cnt = np.unique(lab, return_counts=True)
                d["regimes"] = {int(k): float(c / lab.size) for k, c in zip(vals, cnt)}
        d["summary_text"] = summary_text(d)
        patterns.append(Pattern(
            pattern_id=pid, kind=r["kind"], dsl=dsl, direction=r["stats"]["direction"], stats=r["stats"],
            q_value=d["q_value"], length=d["length"],
            template=np.asarray(r["template"]).tolist() if r["kind"] != "conditional" else None,
            threshold=r.get("threshold"), occurrences=[int(x) for x in ev.tolist()],
            occurrence_ts=[int(md_train.ts[i]) for i in ev.tolist()], profile=d["profile"], shape=d["shape"],
            regimes=d.get("regimes", {}), summary_text=d["summary_text"]))
    return patterns, lib
