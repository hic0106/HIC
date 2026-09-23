"""Data provider abstraction.

The research engine only ever sees :class:`MarketData`; where the bars came from
is irrelevant to it. Providers are read-only.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from .market import MarketData, tf_ms


@dataclass
class DatasetRef:
    provider: str
    asset: str
    timeframe: str
    asset_class: str = "crypto"
    path: str | None = None


def _filter_range(md: MarketData, start_ms: int | None, end_ms: int | None) -> MarketData:
    lo = 0 if start_ms is None else md.index_of_ts(start_ms, "left")
    hi = len(md) if end_ms is None else md.index_of_ts(end_ms, "right")
    return md.slice(lo, hi)


class DataProvider(ABC):
    name = "abstract"

    @abstractmethod
    def load(self, asset: str, timeframe: str, start_ms: int | None = None, end_ms: int | None = None) -> MarketData:
        """Return bars with open time in [start_ms, end_ms] (inclusive), sorted, de-duplicated."""


def _read_meta(path: Path) -> dict:
    meta = path.with_name(path.name + ".meta.json")
    if meta.exists():
        return json.loads(meta.read_text(encoding="utf-8"))
    return {}


class CSVProvider(DataProvider):
    """CSV files with columns timestamp, open, high, low, close[, volume, extras...].

    ``path`` may be a file or a directory holding ``{ASSET}_{TIMEFRAME}.csv`` files.
    Timestamps may be ISO strings or epoch s/ms/us/ns and denote the bar open time.
    """

    name = "csv"
    suffix = ".csv"

    def __init__(self, path: str | Path, asset_class: str | None = None):
        self.path = Path(path)
        self.asset_class = asset_class

    def _file_for(self, asset: str, timeframe: str) -> Path:
        if self.path.is_file():
            return self.path
        cand = self.path / f"{asset}_{timeframe}{self.suffix}"
        if not cand.exists():
            raise FileNotFoundError(f"no {self.suffix} file for {asset} {timeframe} in {self.path}")
        return cand

    def _read(self, file: Path) -> pd.DataFrame:
        return pd.read_csv(file)

    def load(self, asset: str, timeframe: str, start_ms: int | None = None, end_ms: int | None = None) -> MarketData:
        file = self._file_for(asset, timeframe)
        meta = _read_meta(file)
        asset_class = self.asset_class or meta.get("asset_class", "crypto")
        md = MarketData.from_frame(self._read(file), asset=asset, timeframe=timeframe, asset_class=asset_class,
                                   source=f"{self.name}:{file.name}")
        return _filter_range(md, start_ms, end_ms)


class ParquetProvider(CSVProvider):
    name = "parquet"
    suffix = ".parquet"

    def _read(self, file: Path) -> pd.DataFrame:
        try:
            return pd.read_parquet(file)
        except ImportError as exc:  # pragma: no cover - depends on optional pyarrow
            raise ImportError("ParquetProvider needs pyarrow: pip install 'ai-strategy-explorer[parquet]'") from exc


class GenericOHLCVProvider(DataProvider):
    """Wrap an in-memory DataFrame or a callable ``(asset, timeframe, start, end) -> DataFrame``."""

    name = "generic"

    def __init__(self, source: pd.DataFrame | Callable[..., pd.DataFrame], asset_class: str = "crypto"):
        self.source = source
        self.asset_class = asset_class

    def load(self, asset: str, timeframe: str, start_ms: int | None = None, end_ms: int | None = None) -> MarketData:
        df = self.source(asset, timeframe, start_ms, end_ms) if callable(self.source) else self.source
        md = MarketData.from_frame(df, asset=asset, timeframe=timeframe, asset_class=self.asset_class,
                                   source="generic")
        return _filter_range(md, start_ms, end_ms)


class SyntheticProvider(DataProvider):
    """Deterministic synthetic data (see :mod:`.synthetic`). Clearly labelled as synthetic."""

    name = "synthetic"

    def __init__(self, n_bars: int = 6000, seed: int = 7, start: str = "2018-01-01", plant: str | None = None,
                 plant_strength: float = 1.0):
        self.n_bars = n_bars
        self.seed = seed
        self.start = start
        self.plant = plant
        self.plant_strength = plant_strength

    def load(self, asset: str, timeframe: str, start_ms: int | None = None, end_ms: int | None = None) -> MarketData:
        from .synthetic import generate_synthetic

        md = generate_synthetic(self.n_bars, timeframe=timeframe, asset=asset, seed=self.seed, start=self.start,
                                plant=self.plant, plant_strength=self.plant_strength)
        return _filter_range(md, start_ms, end_ms)


def provider_from_config(cfg: dict) -> DataProvider:
    kind = (cfg.get("provider") or "csv").lower()
    if kind == "csv":
        return CSVProvider(cfg["path"], cfg.get("asset_class"))
    if kind == "parquet":
        return ParquetProvider(cfg["path"], cfg.get("asset_class"))
    if kind == "synthetic":
        return SyntheticProvider(
            n_bars=int(cfg.get("n_bars", 6000)),
            seed=int(cfg.get("seed", 7)),
            start=cfg.get("synthetic_start", "2018-01-01"),
            plant=cfg.get("plant") or None,
            plant_strength=float(cfg.get("plant_strength", 1.0)),
        )
    if kind == "binance":
        from .binance import BinanceDataProvider

        return BinanceDataProvider(market=cfg.get("market", "usdm"), cache_dir=cfg.get("cache_dir"))
    raise ValueError(f"unknown data provider {kind!r}")


def check_timeframe(tf: str) -> None:
    tf_ms(tf)


def expected_bars(md: MarketData) -> int:
    if len(md) == 0:
        return 0
    return int((md.ts[-1] - md.ts[0]) // md.bar_ms) + 1


def gap_sizes(md: MarketData) -> np.ndarray:
    if len(md) < 2:
        return np.zeros(0, dtype=np.int64)
    return (np.diff(md.ts) // md.bar_ms).astype(np.int64) - 1
