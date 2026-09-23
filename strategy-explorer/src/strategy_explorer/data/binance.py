"""Binance PUBLIC market-data provider (read-only).

Only unauthenticated market-data GET endpoints are allowed. There is no code
path for API keys, request signing, account data or order placement, and the
HTTP layer refuses any path that is not on the whitelist below.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from .market import MarketData, tf_ms

_HOSTS = {
    "usdm": "https://fapi.binance.com",
    "spot": "https://api.binance.com",
}
# Public, unauthenticated market data endpoints only.
ALLOWED_PATHS = frozenset({
    "/fapi/v1/klines",
    "/fapi/v1/fundingRate",
    "/api/v3/klines",
})
_KLINE_PATH = {"usdm": "/fapi/v1/klines", "spot": "/api/v3/klines"}
# Documented maxima differ between doc versions (1000 vs 1500); 1000 is accepted by both.
KLINE_LIMIT = 1000
FUNDING_LIMIT = 1000

FetchFn = Callable[[str], list]


def _default_fetch(url: str) -> list:
    req = urllib.request.Request(url, headers={"User-Agent": "ai-strategy-explorer/0.1 (research, read-only)"})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https hosts only
        return json.loads(resp.read().decode("utf-8"))


class BinanceDataProvider:
    name = "binance"

    def __init__(self, market: str = "usdm", cache_dir: str | Path | None = None, fetch: FetchFn | None = None,
                 pause_s: float = 0.25):
        if market not in _HOSTS:
            raise ValueError("market must be 'usdm' or 'spot'")
        self.market = market
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self._fetch = fetch or _default_fetch
        self.pause_s = pause_s

    # ------------------------------------------------------------------ http
    def _get(self, path: str, params: dict) -> list:
        if path not in ALLOWED_PATHS:
            raise PermissionError(f"endpoint {path} is not a whitelisted public market-data endpoint")
        url = _HOSTS[self.market] + path + "?" + urllib.parse.urlencode(params)
        last_exc: Exception | None = None
        for attempt in range(4):
            try:
                return self._fetch(url)
            except Exception as exc:  # network errors are retried with backoff
                last_exc = exc
                time.sleep(min(8.0, 1.0 * 2 ** attempt) if self.pause_s else 0)
        raise RuntimeError(f"failed to fetch {path}: {last_exc}")

    # --------------------------------------------------------------- klines
    def fetch_klines(self, symbol: str, interval: str, start_ms: int, end_ms: int) -> pd.DataFrame:
        bar = tf_ms(interval)
        rows: list[list] = []
        cursor = int(start_ms)
        path = _KLINE_PATH[self.market]
        while cursor <= end_ms:
            batch = self._get(path, {"symbol": symbol, "interval": interval, "startTime": cursor,
                                     "endTime": int(end_ms), "limit": KLINE_LIMIT})
            if not batch:
                break
            rows.extend(batch)
            nxt = int(batch[-1][0]) + bar
            if nxt <= cursor:
                break
            cursor = nxt
            if len(batch) < KLINE_LIMIT:
                break
            if self.pause_s:
                time.sleep(self.pause_s)
        # Response: [openTime, open, high, low, close, volume, closeTime, quoteVolume,
        #            numberOfTrades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore]
        df = pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close", "volume", "close_time",
                                         "quote_volume", "number_of_trades", "taker_buy_volume",
                                         "taker_buy_quote_volume", "ignore"][: len(rows[0]) if rows else 12])
        if df.empty:
            return df
        now_ms = int(time.time() * 1000)
        # drop the still-forming candle (close time in the future)
        df = df[df["close_time"].astype(np.int64) < now_ms]
        return df.drop(columns=[c for c in ("close_time", "ignore", "taker_buy_quote_volume") if c in df.columns])

    def fetch_funding(self, symbol: str, start_ms: int, end_ms: int) -> pd.DataFrame:
        if self.market != "usdm":
            return pd.DataFrame(columns=["fundingTime", "fundingRate"])
        out: list[dict] = []
        cursor = int(start_ms)
        while cursor <= end_ms:
            batch = self._get("/fapi/v1/fundingRate", {"symbol": symbol, "startTime": cursor, "endTime": int(end_ms),
                                                       "limit": FUNDING_LIMIT})
            if not batch:
                break
            out.extend(batch)
            nxt = int(batch[-1]["fundingTime"]) + 1
            if nxt <= cursor or len(batch) < FUNDING_LIMIT:
                break
            cursor = nxt
            if self.pause_s:
                time.sleep(self.pause_s)
        return pd.DataFrame(out)

    # ----------------------------------------------------------------- load
    def load(self, asset: str, timeframe: str, start_ms: int | None = None, end_ms: int | None = None,
             with_funding: bool = True) -> MarketData:
        if start_ms is None:
            start_ms = 1_567_296_000_000  # 2019-09-01, early USD-M history
        if end_ms is None:
            end_ms = int(time.time() * 1000)
        df = self.fetch_klines(asset, timeframe, start_ms, end_ms)
        if df.empty:
            raise RuntimeError(f"Binance returned no klines for {asset} {timeframe}")
        md = MarketData.from_frame(df, asset=asset, timeframe=timeframe, asset_class="crypto",
                                   source=f"binance-{self.market}-public")
        if with_funding and self.market == "usdm":
            fr = self.fetch_funding(asset, start_ms, end_ms)
            md.extra["funding_rate"] = funding_per_bar(md, fr)
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            path = self.cache_dir / f"{asset}_{timeframe}.csv"
            md.to_frame().to_csv(path, index=False)
            path.with_name(path.name + ".meta.json").write_text(json.dumps({
                "asset_class": "crypto", "source": md.source, "fetched_at_ms": int(time.time() * 1000)}),
                encoding="utf-8")
        return md


def funding_per_bar(md: MarketData, funding: pd.DataFrame) -> np.ndarray:
    """Sum of funding-rate events whose timestamp falls inside each bar ``[ts, ts+bar)``; 0 otherwise.

    Bars before the first known funding event are NaN (unknown).
    """
    out = np.zeros(len(md), dtype=np.float64)
    if funding is None or funding.empty:
        return np.full(len(md), np.nan)
    t = funding["fundingTime"].astype(np.int64).to_numpy()
    r = funding["fundingRate"].astype(np.float64).to_numpy()
    idx = np.searchsorted(md.ts, t, side="right") - 1
    ok = (idx >= 0) & (t < md.ts[-1] + md.bar_ms)
    np.add.at(out, idx[ok], r[ok])
    first = int(np.searchsorted(md.ts, t.min(), side="right") - 1)
    if first > 0:
        out[:first] = np.nan
    return out
