"""In-memory OHLCV container.

Timestamps are int64 epoch milliseconds (UTC) of the bar OPEN time. A bar
``i`` covers ``[ts[i], ts[i] + bar_ms)`` and its close is known at
``ts[i] + bar_ms``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..util import YEAR_MS, array_digest, ms_to_iso, to_epoch_ms

TIMEFRAME_MS: dict[str, int] = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
}
SUPPORTED_TIMEFRAMES = ("5m", "15m", "1h", "4h", "1d")

CORE_COLUMNS = ("open", "high", "low", "close", "volume")
EXTRA_COLUMNS = (
    "quote_volume",
    "number_of_trades",
    "taker_buy_volume",
    "funding_rate",
    "open_interest",
    "long_short_ratio",
)
_ALIASES = {
    "time": "timestamp",
    "date": "timestamp",
    "datetime": "timestamp",
    "open_time": "timestamp",
    "opentime": "timestamp",
    "ts": "timestamp",
    "o": "open",
    "h": "high",
    "l": "low",
    "c": "close",
    "v": "volume",
    "vol": "volume",
    "base_volume": "volume",
    "quote_asset_volume": "quote_volume",
    "trades": "number_of_trades",
    "count": "number_of_trades",
    "num_trades": "number_of_trades",
    "taker_buy_base_volume": "taker_buy_volume",
    "taker_buy_base_asset_volume": "taker_buy_volume",
    "funding": "funding_rate",
    "oi": "open_interest",
    "sum_open_interest": "open_interest",
    "longshortratio": "long_short_ratio",
}


def tf_ms(tf: str) -> int:
    if tf not in TIMEFRAME_MS:
        raise ValueError(f"unsupported timeframe {tf!r}; supported: {', '.join(TIMEFRAME_MS)}")
    return TIMEFRAME_MS[tf]


@dataclass
class CleaningLog:
    duplicates_dropped: int = 0
    invalid_rows_dropped: int = 0
    ohlc_repaired: int = 0
    unsorted_input: bool = False

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class MarketData:
    asset: str
    timeframe: str
    ts: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    extra: dict[str, np.ndarray] = field(default_factory=dict)
    asset_class: str = "crypto"
    source: str = ""
    has_volume: bool = True
    cleaning: CleaningLog = field(default_factory=CleaningLog)

    # ------------------------------------------------------------------ basics
    def __len__(self) -> int:
        return int(self.ts.shape[0])

    @property
    def bar_ms(self) -> int:
        return tf_ms(self.timeframe)

    @property
    def close_ts(self) -> np.ndarray:
        return self.ts + self.bar_ms

    def has(self, column: str) -> bool:
        if column in CORE_COLUMNS:
            return column != "volume" or self.has_volume
        arr = self.extra.get(column)
        return arr is not None and bool(np.isfinite(arr).any())

    def column(self, name: str) -> np.ndarray:
        if name in CORE_COLUMNS:
            return getattr(self, name)
        if name in self.extra:
            return self.extra[name]
        raise KeyError(name)

    def available_columns(self) -> list[str]:
        return [c for c in (*CORE_COLUMNS, *EXTRA_COLUMNS) if self.has(c)]

    def years(self) -> float:
        if len(self) < 2:
            return 0.0
        return float(self.ts[-1] + self.bar_ms - self.ts[0]) / YEAR_MS

    def periods_per_year(self) -> float:
        """Empirical bars per year (365.25 * bars/day for 24x7 data, ~252 for exchange daily data)."""
        y = self.years()
        if y <= 0:
            return 365.25 * 86_400_000 / self.bar_ms
        return len(self) / y

    def slice(self, start: int, stop: int) -> "MarketData":
        sl = slice(int(start), int(stop))
        return MarketData(
            asset=self.asset,
            timeframe=self.timeframe,
            ts=self.ts[sl].copy(),
            open=self.open[sl].copy(),
            high=self.high[sl].copy(),
            low=self.low[sl].copy(),
            close=self.close[sl].copy(),
            volume=self.volume[sl].copy(),
            extra={k: v[sl].copy() for k, v in self.extra.items()},
            asset_class=self.asset_class,
            source=self.source,
            has_volume=self.has_volume,
            cleaning=self.cleaning,
        )

    def index_of_ts(self, ts_ms: int, side: str = "left") -> int:
        return int(np.searchsorted(self.ts, ts_ms, side=side))

    def version(self) -> str:
        cols = [self.ts, self.open, self.high, self.low, self.close, self.volume]
        cols += [self.extra[k] for k in sorted(self.extra)]
        return array_digest(*cols)[:24]

    def describe_range(self) -> dict:
        return {
            "start": ms_to_iso(int(self.ts[0])) if len(self) else None,
            "end": ms_to_iso(int(self.ts[-1])) if len(self) else None,
            "rows": len(self),
        }

    # -------------------------------------------------------------- conversion
    def to_frame(self) -> pd.DataFrame:
        data = {
            "timestamp": self.ts,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }
        for k in EXTRA_COLUMNS:
            if k in self.extra:
                data[k] = self.extra[k]
        return pd.DataFrame(data)

    @classmethod
    def from_frame(
        cls,
        df: pd.DataFrame,
        asset: str,
        timeframe: str,
        asset_class: str = "crypto",
        source: str = "",
        repair_ohlc: bool = True,
    ) -> "MarketData":
        tf_ms(timeframe)
        frame = df.copy()
        if "timestamp" not in [str(c).lower() for c in frame.columns] and isinstance(frame.index, pd.DatetimeIndex):
            frame = frame.reset_index().rename(columns={frame.index.name or "index": "timestamp"})
        rename = {}
        for c in frame.columns:
            key = str(c).strip().lower().replace(" ", "_")
            rename[c] = _ALIASES.get(key, key)
        frame = frame.rename(columns=rename)
        frame = frame.loc[:, ~frame.columns.duplicated()]
        missing = [c for c in ("timestamp", "open", "high", "low", "close") if c not in frame.columns]
        if missing:
            raise ValueError(f"OHLCV data is missing required columns: {missing}")
        log = CleaningLog()
        ts = to_epoch_ms(frame["timestamp"].to_numpy() if not pd.api.types.is_datetime64_any_dtype(frame["timestamp"])
                         else frame["timestamp"])
        frame = frame.assign(_ts=ts)
        if not np.all(np.diff(ts) > 0):
            log.unsorted_input = bool(np.any(np.diff(ts) < 0))
        frame = frame.sort_values("_ts", kind="mergesort")
        before = len(frame)
        frame = frame.drop_duplicates(subset="_ts", keep="first")
        log.duplicates_dropped = before - len(frame)

        def num(col: str) -> np.ndarray:
            return pd.to_numeric(frame[col], errors="coerce").to_numpy(dtype=np.float64)

        o, h, l, c = num("open"), num("high"), num("low"), num("close")
        has_volume = "volume" in frame.columns
        v = num("volume") if has_volume else np.full(len(frame), np.nan)
        valid = np.isfinite(o) & np.isfinite(h) & np.isfinite(l) & np.isfinite(c) & (o > 0) & (h > 0) & (l > 0) & (c > 0)
        if has_volume:
            valid &= ~(np.isfinite(v) & (v < 0))
        log.invalid_rows_dropped = int((~valid).sum())
        keep = np.flatnonzero(valid)
        o, h, l, c, v = o[keep], h[keep], l[keep], c[keep], v[keep]
        ts_arr = frame["_ts"].to_numpy(dtype=np.int64)[keep]
        hi_needed = np.maximum.reduce([o, c, h])
        lo_needed = np.minimum.reduce([o, c, l])
        inconsistent = (h < np.maximum(o, c)) | (l > np.minimum(o, c)) | (h < l)
        if repair_ohlc:
            log.ohlc_repaired = int(inconsistent.sum())
            h, l = hi_needed, lo_needed
        extra = {}
        for k in EXTRA_COLUMNS:
            if k in frame.columns:
                extra[k] = pd.to_numeric(frame[k], errors="coerce").to_numpy(dtype=np.float64)[keep]
        if has_volume:
            v = np.where(np.isfinite(v), v, 0.0)
        return cls(
            asset=asset,
            timeframe=timeframe,
            ts=ts_arr,
            open=o,
            high=h,
            low=l,
            close=c,
            volume=v,
            extra=extra,
            asset_class=asset_class,
            source=source,
            has_volume=has_volume and bool(np.nansum(v) > 0),
            cleaning=log,
        )
