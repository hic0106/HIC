"""Chronological TRAIN / VALIDATION / TEST / FINAL HOLDOUT split.

The split is fixed when an experiment is created. The FINAL HOLDOUT rows are
cut off before any research component receives data; only the holdout vault
(:mod:`strategy_explorer.validation.holdout`) can load them again.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from ..util import DAY_MS, ms_to_iso, parse_date_ms
from .market import MarketData

SEGMENTS = ("train", "validation", "test", "holdout")


class SplitError(ValueError):
    pass


@dataclass
class SplitPlan:
    n: int
    train: tuple[int, int]
    validation: tuple[int, int]
    test: tuple[int, int]
    holdout: tuple[int, int]
    boundaries_ms: dict
    embargo_bars: int = 0
    mode: str = "fractions"

    def segment(self, name: str) -> tuple[int, int]:
        if name == "validation+test":
            return (self.validation[0], self.test[1])
        if name == "train+validation":
            return (self.train[0], self.validation[1])
        if name == "search":  # everything the search process may ever see
            return (self.train[0], self.test[1])
        return getattr(self, name)

    @property
    def holdout_start(self) -> int:
        return self.holdout[0]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["boundaries_iso"] = {k: ms_to_iso(v) for k, v in self.boundaries_ms.items()}
        return d


def _end_of(text: str) -> int:
    """Segment end given as date -> exclusive end at the following midnight; datetime -> exclusive exact."""
    ms = parse_date_ms(text)
    if len(str(text).strip()) <= 10:
        return ms + DAY_MS
    return ms + 1


def make_split(md: MarketData, cfg: dict, min_bars: dict | None = None) -> SplitPlan:
    n = len(md)
    mode = (cfg.get("mode") or "fractions").lower()
    embargo = int(cfg.get("embargo_bars", 0))
    mins = {"train": 200, "validation": 50, "test": 50, "holdout": 0}
    if min_bars:
        mins.update(min_bars)
    if mode == "fractions":
        ft, fv, fte = float(cfg.get("train", 0.5)), float(cfg.get("validation", 0.15)), float(cfg.get("test", 0.2))
        if min(ft, fv, fte) <= 0 or ft + fv + fte > 1.0 + 1e-9:
            raise SplitError("fractions must be positive and sum to <= 1 (holdout = remainder)")
        a = int(round(n * ft))
        b = int(round(n * (ft + fv)))
        c = int(round(n * (ft + fv + fte)))
    elif mode == "dates":
        try:
            a = md.index_of_ts(_end_of(cfg["train_end"]), "left")
            b = md.index_of_ts(_end_of(cfg["validation_end"]), "left")
            c = md.index_of_ts(_end_of(cfg["test_end"]), "left") if cfg.get("test_end") else n
        except KeyError as exc:
            raise SplitError(f"split mode 'dates' requires {exc.args[0]}") from exc
    else:
        raise SplitError(f"unknown split mode {mode!r}")
    c = min(c, n)
    plan = SplitPlan(
        n=n,
        train=(0, a),
        validation=(min(a + embargo, b), b),
        test=(min(b + embargo, c), c),
        holdout=(min(c + embargo, n), n),
        boundaries_ms={
            "train_start": int(md.ts[0]) if n else 0,
            "validation_start": int(md.ts[a]) if a < n else None,
            "test_start": int(md.ts[b]) if b < n else None,
            "holdout_start": int(md.ts[c]) if c < n else (int(md.ts[-1]) + md.bar_ms if n else None),
            "data_end": int(md.ts[-1]) if n else None,
        },
        embargo_bars=embargo,
        mode=mode,
    )
    for name in ("train", "validation", "test", "holdout"):
        s, e = plan.segment(name)
        if e - s < mins[name]:
            raise SplitError(f"segment {name} has {e - s} bars; at least {mins[name]} required")
    return plan
