"""Registry of typed DSL operators.

Every operator is enumerated as *concrete* signatures (one per unit it accepts),
e.g. ``rolling_mean:price`` = (SERIES[price], WINDOW) -> SERIES[price]. This
makes type checking a signature lookup and lets the GP generate only
well-typed trees. Famous strategies (RSI, MACD, Donchian, ...) are deliberately
NOT operators; only generic mathematical/market-geometry building blocks are.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from . import primitives as P
from .types import (ALL_UNITS, BOOLEAN, DIMLESS, LITERAL_KINDS, LOG_UNITS, SCALE_UNITS, T_BOOL, T_FLOAT,
                    T_PATTERN, T_QUANT, T_REGIME, T_SIGNAL, T_TF, T_WINDOW, S, Type, diff_unit, log_of,
                    std_unit)

MAX_LOGIC_ARITY = 6
DEFAULT_WINDOW_GRID = (2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 30, 40, 50, 60, 80, 100, 120, 150, 200)


@dataclass(frozen=True)
class Sig:
    key: str
    name: str
    args: tuple[Type, ...]
    ret: Type
    impl: Callable
    category: str
    requires: frozenset = frozenset()
    min_window: int = 1
    doc: str = ""
    lazy: bool = False


_SIGS: list[Sig] = []


def _add(key, name, args, ret, impl, category, requires=(), min_window=1, doc="", lazy=False):
    _SIGS.append(Sig(key, name, tuple(args), ret, impl, category, frozenset(requires), min_window, doc, lazy))


# ------------------------------------------------------------------ terminals
_TERMINALS = {
    "open": ("price", "open"), "high": ("price", "high"), "low": ("price", "low"), "close": ("price", "close"),
    "volume": ("volume", "volume"), "quote_volume": ("qvolume", "quote_volume"),
    "number_of_trades": ("trades", "number_of_trades"), "taker_buy_volume": ("volume", "taker_buy_volume"),
    "funding_rate": (DIMLESS, "funding_rate"), "open_interest": ("oi", "open_interest"),
    "long_short_ratio": (DIMLESS, "long_short_ratio"),
}
for _name, (_unit, _col) in _TERMINALS.items():
    _add(_name, _name, (), S(_unit), (lambda col: (lambda ctx: ctx.col(col)))(_col), "terminal", (_col,),
         doc=f"raw {_col} column ({_unit})")

# --------------------------------------------------------- generic transforms
for u in ALL_UNITS:
    su = S(u)
    _add(f"lag:{u}", "lag", (su, T_WINDOW), su, lambda ctx, x, n: P.lag(x, n), "transform", min_window=1,
         doc="value n bars ago")
    _add(f"rolling_mean:{u}", "rolling_mean", (su, T_WINDOW), su, lambda ctx, x, n: P.rolling_mean(x, n),
         "transform", min_window=2, doc="mean of last n values")
    _add(f"rolling_max:{u}", "rolling_max", (su, T_WINDOW), su, lambda ctx, x, n: P.rolling_max(x, n),
         "transform", min_window=2, doc="max of last n values")
    _add(f"rolling_min:{u}", "rolling_min", (su, T_WINDOW), su, lambda ctx, x, n: P.rolling_min(x, n),
         "transform", min_window=2, doc="min of last n values")
    _add(f"rolling_quantile:{u}", "rolling_quantile", (su, T_WINDOW, T_QUANT), su,
         lambda ctx, x, n, q: P.rolling_quantile(x, n, q), "transform", min_window=3,
         doc="q-quantile of last n values")
    _add(f"rolling_std:{u}", "rolling_std", (su, T_WINDOW), S(std_unit(u)), lambda ctx, x, n: P.rolling_std(x, n),
         "transform", min_window=3, doc="sample std of last n values")
    _add(f"slope:{u}", "slope", (su, T_WINDOW), S(std_unit(u)), lambda ctx, x, n: P.slope(x, n), "transform",
         min_window=3, doc="OLS slope per bar over last n values")
    _add(f"zscore:{u}", "zscore", (su, T_WINDOW), S(DIMLESS), lambda ctx, x, n: P.zscore(x, n), "transform",
         min_window=3, doc="(x - rolling mean) / rolling std over last n values")
    _add(f"rank:{u}", "rank", (su, T_WINDOW), S(DIMLESS), lambda ctx, x, n: P.rank(x, n), "transform",
         min_window=3, doc="percentile rank (0,1] of x within last n values")
    _add(f"difference:{u}", "difference", (su, su), S(diff_unit(u)), lambda ctx, x, y: P.difference(x, y),
         "transform", doc="x - y (same unit)")
    for u2 in ALL_UNITS:
        _add(f"correlation:{u}:{u2}", "correlation", (su, S(u2), T_WINDOW), S(DIMLESS),
             lambda ctx, x, y, n: P.correlation(x, y, n), "transform", min_window=5,
             doc="rolling Pearson correlation over n bars")
for u in SCALE_UNITS:
    _add(f"log:{u}", "log", (S(u),), S(log_of(u)), lambda ctx, x: P.log_(x), "transform", doc="natural log")
    _add(f"ratio:{u}", "ratio", (S(u), S(u)), S(DIMLESS), lambda ctx, x, y: P.ratio(x, y), "transform",
         doc="x / y (same unit, dimensionless result)")
_add("ratio:dimless", "ratio", (S(DIMLESS), S(DIMLESS)), S(DIMLESS), lambda ctx, x, y: P.ratio(x, y), "transform",
     doc="x / y")
_add("abs:dimless", "abs", (S(DIMLESS),), S(DIMLESS), lambda ctx, x: P.abs_(x), "transform", doc="absolute value")

# ------------------------------------------------------------- comparisons
for u in ALL_UNITS:
    su = S(u)
    _add(f"GT:{u}", "GT", (su, su), T_BOOL, lambda ctx, a, b: P.gt(a, b), "compare", doc="a > b")
    _add(f"LT:{u}", "LT", (su, su), T_BOOL, lambda ctx, a, b: P.lt(a, b), "compare", doc="a < b")
    _add(f"CROSS_ABOVE:{u}", "CROSS_ABOVE", (su, su), T_BOOL, lambda ctx, a, b: P.cross_above(a, b), "compare",
         doc="a crosses above b on this bar")
    _add(f"CROSS_BELOW:{u}", "CROSS_BELOW", (su, su), T_BOOL, lambda ctx, a, b: P.cross_below(a, b), "compare",
         doc="a crosses below b on this bar")
_add("GT:const", "GT", (S(DIMLESS), T_FLOAT), T_BOOL, lambda ctx, a, c: P.gt(a, c), "compare",
     doc="dimensionless series > constant")
_add("LT:const", "LT", (S(DIMLESS), T_FLOAT), T_BOOL, lambda ctx, a, c: P.lt(a, c), "compare",
     doc="dimensionless series < constant")
_add("CROSS_ABOVE:const", "CROSS_ABOVE", (S(DIMLESS), T_FLOAT), T_BOOL, lambda ctx, a, c: P.cross_above(a, c),
     "compare", doc="series crosses above constant")
_add("CROSS_BELOW:const", "CROSS_BELOW", (S(DIMLESS), T_FLOAT), T_BOOL, lambda ctx, a, c: P.cross_below(a, c),
     "compare", doc="series crosses below constant")

# ------------------------------------------------------------------ logic
for k in range(2, MAX_LOGIC_ARITY + 1):
    _add(f"AND/{k}", "AND", (T_BOOL,) * k, T_BOOL, lambda ctx, *xs: P.and_(*xs), "logic", doc="all true")
    _add(f"OR/{k}", "OR", (T_BOOL,) * k, T_BOOL, lambda ctx, *xs: P.or_(*xs), "logic", doc="any true")
_add("NOT", "NOT", (T_BOOL,), T_BOOL, lambda ctx, x: P.not_(x), "logic", doc="negation")

# --------------------------------------------------------------- temporal
_add("was", "was", (T_BOOL, T_WINDOW), T_BOOL, lambda ctx, b, n: P.was(b, n), "temporal", min_window=2,
     doc="condition true on any of the last n bars")
_add("held", "held", (T_BOOL, T_WINDOW), T_BOOL, lambda ctx, b, n: P.held(b, n), "temporal", min_window=2,
     doc="condition true on all of the last n bars")
_add("count_true", "count_true", (T_BOOL, T_WINDOW), S(DIMLESS), lambda ctx, b, n: P.count_true(b, n), "temporal",
     min_window=2, doc="number of the last n bars on which the condition was true")
_add("bars_since", "bars_since", (T_BOOL,), S(DIMLESS), lambda ctx, b: P.bars_since(b), "temporal",
     doc="bars since the condition was last true")

# ----------------------------------------------------------------- signal
_add("WHEN", "WHEN", (T_BOOL,), T_SIGNAL, lambda ctx, b: b, "signal", doc="level trigger (implicit)")
_add("ONSET", "ONSET", (T_BOOL,), T_SIGNAL, lambda ctx, b: P.onset(b), "signal",
     doc="edge trigger: only the bar the condition becomes true")

# ------------------------------------------------------------ multi-timeframe
for u in ALL_UNITS:
    _add(f"tf:{u}", "tf", (T_TF, S(u)), S(u), lambda ctx, tf, node: ctx.eval_htf(tf, node), "mtf", lazy=True,
         doc="evaluate x on a higher timeframe using only fully closed candles")
_add("tf:bool", "tf", (T_TF, T_BOOL), T_BOOL, lambda ctx, tf, node: ctx.eval_htf(tf, node), "mtf", lazy=True,
     doc="evaluate a condition on a higher timeframe using only fully closed candles")

# ------------------------------------------------------- regime / patterns
_add("regime_is", "regime_is", (T_REGIME,), T_BOOL, lambda ctx, k: ctx.regime_is(k), "regime",
     doc="causal (filtered) HMM regime equals k")
_add("regime_prob", "regime_prob", (T_REGIME,), S(DIMLESS), lambda ctx, k: ctx.regime_prob(k), "regime",
     doc="causal (filtered) HMM probability of regime k")
_add("pattern_distance", "pattern_distance", (T_PATTERN,), S(DIMLESS), lambda ctx, p: ctx.pattern_distance(p),
     "pattern", doc="RMS distance of the last m normalised bars to a discovered pattern template")

# ---------------------------------------------------------- feature library
_W, _W2 = (T_WINDOW,), (T_WINDOW, T_WINDOW)


def _feat(name, fn, windows=(), unit=DIMLESS, requires=("close",), min_window=2, doc="", category="feature"):
    _add(name, name, windows, S(unit), fn, category, requires, min_window, doc)


# price
_feat("return", lambda ctx, n: P.ret_n(ctx.c, n), _W, min_window=1, doc="close / close[n] - 1")
_feat("log_return", lambda ctx, n: P.log_ret_n(ctx.c, n), _W, min_window=1, doc="ln(close / close[n])")
# candle geometry
_OHLC = ("open", "high", "low", "close")
_feat("body_size", lambda ctx: P.body_size(ctx.o, ctx.c), requires=_OHLC, doc="|close-open| / open")
_feat("body_ratio", lambda ctx: P.body_ratio(ctx.o, ctx.h, ctx.l, ctx.c), requires=_OHLC,
      doc="|close-open| / (high-low)")
_feat("upper_wick", lambda ctx: P.upper_wick(ctx.o, ctx.h, ctx.l, ctx.c), requires=_OHLC,
      doc="(high - max(open,close)) / (high-low)")
_feat("lower_wick", lambda ctx: P.lower_wick(ctx.o, ctx.h, ctx.l, ctx.c), requires=_OHLC,
      doc="(min(open,close) - low) / (high-low)")
_feat("wick_to_body", lambda ctx: P.wick_to_body(ctx.o, ctx.h, ctx.l, ctx.c), requires=_OHLC,
      doc="total wick length / (body + 1% of range)")
_feat("close_location_in_range", lambda ctx: P.close_location_in_range(ctx.h, ctx.l, ctx.c), requires=_OHLC,
      doc="(close-low) / (high-low) of the current bar")
_feat("high_low_range", lambda ctx: P.high_low_range(ctx.h, ctx.l, ctx.c), requires=_OHLC,
      doc="(high-low) / close")
_feat("gap", lambda ctx: P.gap(ctx.o, ctx.c), requires=_OHLC, doc="open / previous close - 1")
_feat("true_range", lambda ctx: P.true_range(ctx.h, ctx.l, ctx.c), requires=_OHLC,
      doc="true range / previous close")
_feat("range_expansion", lambda ctx, n: P.range_expansion(ctx.h, ctx.l, n), _W, requires=_OHLC,
      doc="(high-low) / mean range of the prior n bars")
_feat("range_contraction", lambda ctx, n: P.range_contraction(ctx.h, ctx.l, n), _W, requires=_OHLC,
      doc="mean range of last n bars / mean range of last 4n bars (<1 = contracting)")
_feat("range_position", lambda ctx, n: P.range_position(ctx.h, ctx.l, ctx.c, n), _W, requires=_OHLC,
      doc="position of close inside the n-bar high-low range (0..1)")
# volume
_V = ("close", "volume")
_feat("volume_return", lambda ctx, n: P.volume_return(ctx.v, n), _W, requires=_V, min_window=1,
      doc="ln(volume / volume[n])")
_feat("volume_ratio", lambda ctx, n: P.volume_ratio(ctx.v, n), _W, requires=_V,
      doc="volume / mean volume of prior n bars")
_feat("volume_zscore", lambda ctx, n: P.volume_zscore(ctx.v, n), _W, requires=_V, min_window=3,
      doc="(volume - mean) / std of prior n bars")
_feat("rolling_volume_mean", lambda ctx, n: P.rolling_mean(ctx.v, n), _W, unit="volume", requires=_V,
      doc="mean volume of last n bars (volume unit)")
_feat("rolling_volume_std", lambda ctx, n: P.rolling_std(ctx.v, n), _W, unit="volume", requires=_V, min_window=3,
      doc="std of volume of last n bars (volume unit)")
_feat("price_volume_correlation", lambda ctx, n: P.price_volume_correlation(ctx.c, ctx.v, n), _W, requires=_V,
      min_window=5, doc="correlation of log returns and log volume changes over n bars")
_feat("volume_acceleration", lambda ctx, n: P.volume_acceleration(ctx.v, n), _W, requires=_V, min_window=3,
      doc="change of the log-volume slope versus n bars ago")
_feat("relative_volume", lambda ctx, n: P.relative_volume(ctx.v, ctx.ts, ctx.bar_ms, n), _W, requires=_V,
      doc="volume / mean volume at the same time of day over prior n days")
# volatility
_feat("realized_volatility", lambda ctx, n: P.realized_volatility(ctx.c, n), _W, min_window=3,
      doc="std of log returns over n bars")
_feat("range_volatility", lambda ctx, n: P.range_volatility(ctx.h, ctx.l, n), _W, requires=_OHLC,
      doc="Parkinson high-low volatility over n bars")
_feat("volatility_ratio", lambda ctx, n1, n2: P.volatility_ratio(ctx.c, n1, n2), _W2, min_window=3,
      doc="realized_volatility(n1) / realized_volatility(n2)")
_feat("volatility_change", lambda ctx, n: P.volatility_change(ctx.c, n), _W, min_window=3,
      doc="realized_volatility(n) / realized_volatility(n)[n] - 1")
# market structure
_feat("distance_from_recent_high", lambda ctx, n: P.distance_from_recent_high(ctx.h, ctx.c, n), _W,
      requires=_OHLC, doc="close / n-bar high - 1")
_feat("distance_from_recent_low", lambda ctx, n: P.distance_from_recent_low(ctx.l, ctx.c, n), _W,
      requires=_OHLC, doc="close / n-bar low - 1")
_feat("higher_high_count", lambda ctx, n: P.higher_high_count(ctx.h, n), _W, requires=_OHLC,
      doc="number of bars in last n with high > previous high")
_feat("lower_low_count", lambda ctx, n: P.lower_low_count(ctx.l, n), _W, requires=_OHLC,
      doc="number of bars in last n with low < previous low")
_feat("trend_slope", lambda ctx, n: P.trend_slope(ctx.c, n), _W, min_window=3,
      doc="slope of log close / std of log returns over n bars")
_feat("compression_score", lambda ctx, n: P.compression_score(ctx.h, ctx.l, ctx.c, n), _W, requires=_OHLC,
      doc="1 - percentile rank of the n-bar range within the last 5n bars")
_feat("breakout_distance", lambda ctx, n: P.breakout_distance(ctx.h, ctx.l, ctx.c, n), _W, requires=_OHLC,
      doc="(close - prior n-bar high) / prior n-bar ATR")
# optional data
_feat("taker_buy_ratio", lambda ctx, n: P.taker_buy_ratio(ctx.col("taker_buy_volume"), ctx.v, n), _W,
      requires=("volume", "taker_buy_volume"), min_window=1, doc="mean taker-buy share of volume over n bars",
      category="optional")
_feat("funding_sum", lambda ctx, n: P.funding_sum(ctx.col("funding_rate"), n), _W, requires=("funding_rate",),
      min_window=1, doc="sum of funding rates over n bars", category="optional")
_feat("oi_change", lambda ctx, n: P.oi_change(ctx.col("open_interest"), n), _W, requires=("open_interest",),
      min_window=1, doc="open interest / open interest[n] - 1", category="optional")

ALL_SIGS: tuple[Sig, ...] = tuple(_SIGS)
SIG_BY_KEY: dict[str, Sig] = {s.key: s for s in ALL_SIGS}
if len(SIG_BY_KEY) != len(ALL_SIGS):  # pragma: no cover
    raise RuntimeError("duplicate signature keys")

# names whose DSL spelling differs only by case
_CANON = {}
for s in ALL_SIGS:
    _CANON.setdefault(s.name.lower(), s.name)


def canonical_name(name: str) -> str | None:
    return _CANON.get(name.lower())


FEATURE_CATEGORIES = {
    "return": "price", "log_return": "price",
    "body_size": "candle", "body_ratio": "candle", "upper_wick": "candle", "lower_wick": "candle",
    "wick_to_body": "candle", "close_location_in_range": "candle", "high_low_range": "candle", "gap": "candle",
    "true_range": "candle", "range_expansion": "candle", "range_contraction": "candle", "range_position": "structure",
    "volume_return": "volume", "volume_ratio": "volume", "volume_zscore": "volume", "rolling_volume_mean": "volume",
    "rolling_volume_std": "volume", "price_volume_correlation": "volume", "volume_acceleration": "volume",
    "relative_volume": "volume", "volume": "volume",
    "realized_volatility": "volatility", "range_volatility": "volatility", "volatility_ratio": "volatility",
    "volatility_change": "volatility",
    "distance_from_recent_high": "structure", "distance_from_recent_low": "structure",
    "higher_high_count": "structure", "lower_low_count": "structure", "trend_slope": "structure",
    "compression_score": "structure", "breakout_distance": "structure",
    "taker_buy_ratio": "orderflow", "funding_sum": "derivatives", "oi_change": "derivatives",
    "funding_rate": "derivatives", "open_interest": "derivatives", "long_short_ratio": "derivatives",
    "taker_buy_volume": "orderflow", "quote_volume": "volume", "number_of_trades": "volume",
    "open": "price", "high": "price", "low": "price", "close": "price",
    "regime_is": "regime", "regime_prob": "regime", "pattern_distance": "pattern",
}


@dataclass
class Registry:
    """Operators usable in one research context (available columns, timeframes, regimes, patterns)."""

    columns: frozenset = frozenset({"open", "high", "low", "close", "volume"})
    htf: tuple[str, ...] = ()
    n_regimes: int = 0
    pattern_ids: tuple[str, ...] = ()
    max_window: int = 250
    window_grid: tuple[int, ...] = DEFAULT_WINDOW_GRID
    base_timeframe: str = "1h"
    sigs: tuple[Sig, ...] = field(init=False)

    def __post_init__(self):
        out = []
        for s in ALL_SIGS:
            if not s.requires <= self.columns:
                continue
            if s.category == "mtf" and not self.htf:
                continue
            if s.category == "regime" and self.n_regimes <= 0:
                continue
            if s.category == "pattern" and not self.pattern_ids:
                continue
            out.append(s)
        self.sigs = tuple(out)
        self._by_name: dict[str, list[Sig]] = {}
        self._by_ret: dict[Type, list[Sig]] = {}
        for s in self.sigs:
            self._by_name.setdefault(s.name, []).append(s)
            self._by_ret.setdefault(s.ret, []).append(s)
        self._min_depth = self._compute_min_depth()

    # --------------------------------------------------------------- lookup
    def by_name(self, name: str) -> list[Sig]:
        return self._by_name.get(name, [])

    def returning(self, t: Type) -> list[Sig]:
        return self._by_ret.get(t, [])

    def has(self, key: str) -> bool:
        return any(s.key == key for s in self.sigs)

    def literal_available(self, t: Type) -> bool:
        if t == T_TF:
            return bool(self.htf)
        if t == T_REGIME:
            return self.n_regimes > 0
        if t == T_PATTERN:
            return bool(self.pattern_ids)
        return t.kind in LITERAL_KINDS

    def _compute_min_depth(self) -> dict[Type, int]:
        md: dict[Type, int] = {}
        for t in (T_FLOAT, T_WINDOW, T_QUANT, T_TF, T_REGIME, T_PATTERN):
            if self.literal_available(t):
                md[t] = 0
        changed = True
        while changed:
            changed = False
            for s in self.sigs:
                if all(a in md for a in s.args):
                    d = 1 + max((md[a] for a in s.args), default=0)
                    if d < md.get(s.ret, 10 ** 9):
                        md[s.ret] = d
                        changed = True
        return md

    def min_depth(self, t: Type) -> int:
        return self._min_depth.get(t, 10 ** 9)

    def sig_min_depth(self, s: Sig) -> int:
        return 1 + max((self.min_depth(a) for a in s.args), default=0)

    def series_units(self) -> list[str]:
        return [u for u in ALL_UNITS if S(u) in self._min_depth]

    # ---------------------------------------------------------- documentation
    def grammar_card(self) -> str:
        """Compact description of the language for LLM prompts and the UI."""
        seen = set()
        lines = []
        for s in self.sigs:
            if s.category in ("terminal",):
                continue
            if s.name in seen:
                continue
            seen.add(s.name)
            variants = self.by_name(s.name)
            if s.category in ("transform", "compare", "mtf") or len(variants) > 1:
                arg_desc = _poly_desc(s.name, variants)
            else:
                arg_desc = f"{s.name}({', '.join(str(a) for a in s.args)}) -> {s.ret}"
            lines.append(f"- {arg_desc}: {s.doc}")
        terms = [s.name for s in self.sigs if s.category == "terminal"]
        head = [
            "Types: SERIES[unit], BOOLEAN, FLOAT (threshold), SIGNAL (slot root), WINDOW (int bars), QUANT (0..1),",
            "       TF (timeframe string), REGIME (int), PATTERN (string id).",
            "Units: price, volume, qvolume, trades, oi, log_<unit>, dimless.",
            "Rule: a SERIES may be compared with a FLOAT only if it is dimless; otherwise compare two series of the",
            "      same unit (scale invariance). log(price) is log_price; slope/rolling_std of log units is dimless.",
            f"Terminals: {', '.join(terms)}",
            f"Windows: integers {min(self.window_grid)}..{self.max_window}.",
        ]
        if self.htf:
            head.append(f"Higher timeframes for tf(\"TF\", x): {', '.join(self.htf)} (base {self.base_timeframe}).")
        if self.n_regimes:
            head.append(f"Regimes: 0..{self.n_regimes - 1}.")
        if self.pattern_ids:
            head.append(f"Pattern ids: {', '.join(self.pattern_ids)}.")
        return "\n".join(head + ["Operators:"] + lines)


def _poly_desc(name: str, variants: list[Sig]) -> str:
    if name in ("AND", "OR"):
        return f"{name}(BOOLEAN, BOOLEAN, ... up to {MAX_LOGIC_ARITY}) -> BOOLEAN"
    if name in ("GT", "LT", "CROSS_ABOVE", "CROSS_BELOW"):
        return f"{name}(SERIES[u], SERIES[u]) | {name}(SERIES[dimless], FLOAT) -> BOOLEAN"
    if name == "tf":
        return "tf(TF, SERIES[u]) -> SERIES[u] | tf(TF, BOOLEAN) -> BOOLEAN"
    s = variants[0]
    args = ", ".join("SERIES[u]" if a.kind == "SERIES" else str(a) for a in s.args)
    ret = s.ret
    if name in ("rolling_std", "slope"):
        rs = "SERIES[u] (dimless for log_/dimless inputs)"
    elif name in ("zscore", "rank", "correlation", "ratio"):
        rs = "SERIES[dimless]"
    elif name == "log":
        rs = "SERIES[log_u]"
    elif name == "difference":
        rs = "SERIES[u] (dimless for log_/dimless inputs)"
    elif ret.kind == "SERIES":
        rs = "SERIES[u]" if ret.unit != DIMLESS else "SERIES[dimless]"
    else:
        rs = str(ret)
    return f"{name}({args}) -> {rs}"


def default_registry(**kw) -> Registry:
    return Registry(**kw)


__all__ = ["Sig", "Registry", "ALL_SIGS", "SIG_BY_KEY", "canonical_name", "default_registry", "FEATURE_CATEGORIES",
           "DEFAULT_WINDOW_GRID", "MAX_LOGIC_ARITY", "BOOLEAN", "LOG_UNITS"]
