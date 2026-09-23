"""Transaction-cost model applied identically to every candidate."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace

import numpy as np

EIGHT_HOURS_MS = 8 * 3_600_000


@dataclass(frozen=True)
class CostModel:
    fee_bps: float = 5.0            # per side, taker
    slippage_bps: float = 2.0       # per side, applied to the fill price
    funding_mode: str = "constant"  # none | constant | series
    funding_bps_per_8h: float = 1.0  # constant mode: 0.01% per 8h
    funding_side: str = "both_pay"  # constant mode: both_pay (conservative) | long_pays (shorts receive)

    def __post_init__(self):
        if self.funding_mode not in ("none", "constant", "series"):
            raise ValueError("funding_mode must be none|constant|series")
        if self.funding_side not in ("both_pay", "long_pays"):
            raise ValueError("funding_side must be both_pay|long_pays")
        if self.fee_bps < 0 or self.slippage_bps < 0:
            raise ValueError("costs must be non-negative")

    @property
    def fee(self) -> float:
        return self.fee_bps / 1e4

    @property
    def slippage(self) -> float:
        return self.slippage_bps / 1e4

    def is_costless(self) -> bool:
        return self.fee_bps <= 0 and self.slippage_bps <= 0

    def scaled(self, fee: float = 1.0, slippage: float = 1.0, funding: float = 1.0) -> "CostModel":
        return replace(self, fee_bps=self.fee_bps * fee, slippage_bps=self.slippage_bps * slippage,
                       funding_bps_per_8h=self.funding_bps_per_8h * funding)

    def zero(self) -> "CostModel":
        return CostModel(0.0, 0.0, "none", 0.0, self.funding_side)

    def funding_rate_per_bar(self, n: int, bar_ms: int, series: np.ndarray | None) -> tuple[np.ndarray, bool]:
        """Return (rate per bar, signed) where signed=True means longs pay +rate, shorts receive it."""
        if self.funding_mode == "none":
            return np.zeros(n), True
        if self.funding_mode == "series":
            if series is None:
                raise ValueError("funding_mode='series' needs a funding_rate column in the data")
            return np.where(np.isfinite(series), series, 0.0), True
        rate = self.funding_bps_per_8h / 1e4 * (bar_ms / EIGHT_HOURS_MS)
        return np.full(n, rate), self.funding_side == "long_pays"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> "CostModel":
        d = dict(d or {})
        keys = {"fee_bps", "slippage_bps", "funding_mode", "funding_bps_per_8h", "funding_side"}
        return cls(**{k: v for k, v in d.items() if k in keys})
