"""Type system of the Strategy DSL.

Value kinds
-----------
SERIES   float time series, tagged with a physical *unit*
BOOLEAN  boolean time series (three-valued: 1 / 0 / unknown during warm-up)
FLOAT    scalar threshold constant
SIGNAL   the root of an entry/exit slot (level trigger WHEN or edge trigger ONSET)

Parameter literal kinds (not free values, always constants in the tree)
WINDOW   integer look-back length in bars
QUANT    quantile level in (0, 1)
TF       timeframe string, e.g. "4h"
REGIME   latent regime id (integer)
PATTERN  id of a discovered pattern template, e.g. "M3"

Units implement dimensional analysis so that every rule is scale invariant:
a SERIES can be compared with a FLOAT threshold only when it is ``dimless``
(returns, z-scores, ratios, ranks ...). Absolute levels such as ``close`` or
``volume`` can only be compared with a series of the *same* unit, e.g.
``GT(close, rolling_max(high, 20))``. Hence "BTC > 50,000" is not expressible.
"""

from __future__ import annotations

from typing import NamedTuple

SERIES, BOOLEAN, FLOAT, SIGNAL = "SERIES", "BOOLEAN", "FLOAT", "SIGNAL"
WINDOW, QUANT, TF, REGIME, PATTERN = "WINDOW", "QUANT", "TF", "REGIME", "PATTERN"
LITERAL_KINDS = frozenset({FLOAT, WINDOW, QUANT, TF, REGIME, PATTERN})

DIMLESS = "dimless"
SCALE_UNITS = ("price", "volume", "qvolume", "trades", "oi")
LOG_UNITS = tuple("log_" + u for u in SCALE_UNITS)
ALL_UNITS = (*SCALE_UNITS, *LOG_UNITS, DIMLESS)


class Type(NamedTuple):
    kind: str
    unit: str | None = None

    def __str__(self) -> str:
        return f"{self.kind}[{self.unit}]" if self.unit else self.kind


def S(unit: str) -> Type:
    if unit not in ALL_UNITS:
        raise ValueError(f"unknown unit {unit}")
    return Type(SERIES, unit)


T_BOOL = Type(BOOLEAN)
T_FLOAT = Type(FLOAT)
T_SIGNAL = Type(SIGNAL)
T_WINDOW = Type(WINDOW)
T_QUANT = Type(QUANT)
T_TF = Type(TF)
T_REGIME = Type(REGIME)
T_PATTERN = Type(PATTERN)
T_DIMLESS = S(DIMLESS)


def log_of(unit: str) -> str | None:
    return "log_" + unit if unit in SCALE_UNITS else None


def std_unit(unit: str) -> str:
    """Unit of rolling_std / slope of a series with ``unit``."""
    if unit in LOG_UNITS or unit == DIMLESS:
        return DIMLESS
    return unit


def diff_unit(unit: str) -> str:
    if unit in LOG_UNITS or unit == DIMLESS:
        return DIMLESS
    return unit


class DSLTypeError(ValueError):
    """Raised when an expression is ill-typed (unknown function, wrong arity, unit mismatch...)."""


class DSLSyntaxError(ValueError):
    """Raised on malformed DSL text."""
