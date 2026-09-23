"""Data-quality report shown on the DATA screen."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np

from ..util import ms_to_iso
from .market import EXTRA_COLUMNS, MarketData
from .providers import expected_bars, gap_sizes


@dataclass
class QualityReport:
    asset: str
    timeframe: str
    asset_class: str
    source: str
    start: str | None
    end: str | None
    rows: int
    calendar: str
    expected_rows: int | None
    missing_bars: int | None
    missing_pct: float | None
    gap_count: int
    largest_gap_bars: int
    duplicates_dropped: int
    invalid_rows_dropped: int
    ohlc_repaired: int
    zero_volume_bars: int
    volume_available: bool
    funding_available: bool
    extra_columns: list[str] = field(default_factory=list)
    extra_coverage: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def quality_report(md: MarketData) -> QualityReport:
    calendar = "24x7" if md.asset_class == "crypto" else "exchange"
    gaps = gap_sizes(md)
    gap_mask = gaps > 0
    if calendar == "24x7":
        exp = expected_bars(md)
        missing = int(max(0, exp - len(md)))
        missing_pct = (100.0 * missing / exp) if exp else 0.0
    else:
        # weekends / holidays are expected on exchange calendars; count only unusually long gaps
        exp, missing, missing_pct = None, None, None
        gap_mask = gaps > (3 if md.timeframe == "1d" else 72)
    extra_cols = [k for k in EXTRA_COLUMNS if md.has(k)]
    coverage = {k: float(np.isfinite(md.extra[k]).mean()) for k in md.extra}
    return QualityReport(
        asset=md.asset,
        timeframe=md.timeframe,
        asset_class=md.asset_class,
        source=md.source,
        start=ms_to_iso(int(md.ts[0])) if len(md) else None,
        end=ms_to_iso(int(md.ts[-1])) if len(md) else None,
        rows=len(md),
        calendar=calendar,
        expected_rows=exp,
        missing_bars=missing,
        missing_pct=None if missing_pct is None else round(missing_pct, 4),
        gap_count=int(gap_mask.sum()),
        largest_gap_bars=int(gaps.max()) if gaps.size else 0,
        duplicates_dropped=md.cleaning.duplicates_dropped,
        invalid_rows_dropped=md.cleaning.invalid_rows_dropped,
        ohlc_repaired=md.cleaning.ohlc_repaired,
        zero_volume_bars=int((md.volume <= 0).sum()) if md.has_volume else len(md),
        volume_available=md.has_volume,
        funding_available=md.has("funding_rate"),
        extra_columns=extra_cols,
        extra_coverage=coverage,
    )
