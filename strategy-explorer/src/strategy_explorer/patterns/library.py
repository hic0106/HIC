"""Pattern objects and the template library behind the ``pattern_distance`` DSL primitive."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np

from .normalize import CHANNELS, channel_matrix, rms_distance_profile


@dataclass
class Pattern:
    pattern_id: str
    kind: str                      # conditional | motif | shapelet
    dsl: str                       # boolean DSL expression that reproduces the occurrences exactly
    direction: str                 # long | short (sign of the excess forward return on TRAIN)
    stats: dict
    q_value: float = 1.0
    length: int = 1
    template: list | None = None   # (m, C) for motif/shapelet
    threshold: float | None = None
    occurrences: list[int] = field(default_factory=list)   # bar indices (end bar) in TRAIN
    occurrence_ts: list[int] = field(default_factory=list)
    profile: list[dict] = field(default_factory=list)      # deviating features at occurrence
    shape: list[str] = field(default_factory=list)          # textual shape description
    regimes: dict = field(default_factory=dict)
    summary_text: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    def summary(self) -> dict:
        d = self.to_dict()
        d.pop("occurrences", None)
        d.pop("occurrence_ts", None)
        return d


class PatternLibrary:
    """Templates of motif/shapelet patterns, evaluated causally on any MarketData."""

    def __init__(self, norm_window: int = 50):
        self.norm_window = norm_window
        self.templates: dict[str, np.ndarray] = {}

    def add(self, pattern_id: str, template: np.ndarray) -> None:
        self.templates[pattern_id] = np.asarray(template, dtype=np.float64)

    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self.templates))

    def channels(self, ctx) -> np.ndarray:
        X = getattr(ctx, "_pattern_features", None)
        if X is None:
            X = channel_matrix(ctx.md, self.norm_window)
            ctx._pattern_features = X
        return X

    def distance(self, pattern_id: str, ctx) -> np.ndarray:
        if pattern_id not in self.templates:
            raise KeyError(f"unknown pattern {pattern_id}")
        return rms_distance_profile(self.channels(ctx), self.templates[pattern_id])

    def to_dict(self) -> dict:
        return {"norm_window": self.norm_window, "channels": list(CHANNELS),
                "templates": {k: v.tolist() for k, v in self.templates.items()},
                "distance": "sqrt(mean((window - template)^2)) over the last m bars and all channels"}

    @classmethod
    def from_dict(cls, d: dict) -> "PatternLibrary":
        lib = cls(int(d.get("norm_window", 50)))
        for k, v in d.get("templates", {}).items():
            lib.add(k, np.asarray(v, dtype=np.float64))
        return lib

    def subset(self, ids: list[str]) -> "PatternLibrary":
        lib = PatternLibrary(self.norm_window)
        for i in ids:
            if i in self.templates:
                lib.add(i, self.templates[i])
        return lib
