"""Shared helpers: hashing, deterministic RNG streams, time conversion, JSON safety."""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import math
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

DAY_MS = 86_400_000
YEAR_MS = 365.25 * DAY_MS
PACKAGE_DIR = Path(__file__).resolve().parent


# --------------------------------------------------------------------------- JSON


def _json_default(o: Any):
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    if isinstance(o, Path):
        return str(o)
    if hasattr(o, "to_dict"):
        return o.to_dict()
    raise TypeError(f"not JSON serialisable: {type(o).__name__}")


def json_safe(obj: Any) -> Any:
    """Recursively convert numpy scalars/arrays and non-finite floats into JSON-safe values."""
    if isinstance(obj, dict):
        return {str(k): json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_safe(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [json_safe(v) for v in obj.tolist()]
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return f if math.isfinite(f) else None
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj


def stable_json(obj: Any) -> str:
    """Canonical JSON (sorted keys, no whitespace) used for hashing."""
    return json.dumps(json_safe(obj), sort_keys=True, separators=(",", ":"), default=_json_default,
                      ensure_ascii=False)


def dumps(obj: Any, indent: int | None = None) -> str:
    return json.dumps(json_safe(obj), indent=indent, default=_json_default, ensure_ascii=False)


# ------------------------------------------------------------------------ hashing


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def short_hash(text: str, n: int = 16) -> str:
    return sha256_text(text)[:n]


def array_digest(*arrays: np.ndarray) -> str:
    h = hashlib.sha256()
    for a in arrays:
        a = np.ascontiguousarray(a)
        h.update(str(a.dtype).encode())
        h.update(str(a.shape).encode())
        h.update(a.tobytes())
    return h.hexdigest()


def config_hash(cfg: dict) -> str:
    return sha256_text(stable_json(cfg))


# ---------------------------------------------------------------------------- RNG


def derive_rng(seed: int, *keys: Any) -> np.random.Generator:
    """Independent, reproducible random stream for a named component.

    Uses sha256 of the keys rather than ``hash()`` so results do not depend on
    PYTHONHASHSEED.
    """
    key_ints = [int(sha256_text(str(k))[:8], 16) for k in keys]
    return np.random.default_rng(np.random.SeedSequence([int(seed) & 0xFFFFFFFF, *key_ints]))


# --------------------------------------------------------------------------- time


def utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def to_epoch_ms(values: Any) -> np.ndarray:
    """Convert timestamps (epoch s/ms/us/ns numbers, strings, datetimes) to int64 epoch ms UTC."""
    if isinstance(values, (pd.DatetimeIndex, pd.Series)) and pd.api.types.is_datetime64_any_dtype(values):
        idx = pd.DatetimeIndex(values)
        if idx.tz is None:
            idx = idx.tz_localize("UTC")
        return idx.tz_convert("UTC").as_unit("ms").asi8.astype(np.int64)
    arr = np.asarray(values)
    if arr.dtype.kind in "iuf":
        a = arr.astype(np.float64)
        finite = a[np.isfinite(a)]
        mx = np.nanmax(np.abs(finite)) if finite.size else 0.0
        if mx < 1e11:        # seconds
            a = a * 1000.0
        elif mx < 1e14:      # milliseconds
            pass
        elif mx < 1e17:      # microseconds
            a = a / 1000.0
        else:                # nanoseconds
            a = a / 1e6
        return np.round(a).astype(np.int64)
    idx = pd.DatetimeIndex(pd.to_datetime(pd.Series(arr), utc=True))
    return idx.as_unit("ms").asi8.astype(np.int64)


def parse_date_ms(text: str | int | float | None) -> int | None:
    if text is None or text == "":
        return None
    if isinstance(text, (int, float, np.integer, np.floating)):
        return int(to_epoch_ms(np.array([text]))[0])
    ts = pd.Timestamp(text)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return int(ts.tz_convert("UTC").as_unit("ns").value // 1_000_000)


def ms_to_iso(ms: int | float | None) -> str | None:
    if ms is None or (isinstance(ms, float) and not math.isfinite(ms)):
        return None
    return _dt.datetime.fromtimestamp(int(ms) / 1000.0, tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ms_to_date(ms: int) -> str:
    return _dt.datetime.fromtimestamp(int(ms) / 1000.0, tz=_dt.timezone.utc).strftime("%Y-%m-%d")


# ----------------------------------------------------------------- code version


def source_digest(package_dir: Path = PACKAGE_DIR) -> str:
    h = hashlib.sha256()
    for p in sorted(package_dir.rglob("*.py")):
        h.update(str(p.relative_to(package_dir)).encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def git_commit(path: Path = PACKAGE_DIR) -> str | None:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(path), capture_output=True, text=True,
                             timeout=5)
        if out.returncode == 0:
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def code_version() -> dict:
    from . import __version__

    return {"package": __version__, "git_commit": git_commit(), "source_hash": source_digest()}


def code_version_string(cv: dict | None = None) -> str:
    cv = cv or code_version()
    commit = (cv.get("git_commit") or "nogit")[:12]
    return f"{cv['package']}+{commit}.{cv['source_hash']}"


# ------------------------------------------------------------------------ numeric


def finite_or(x: float, default: float) -> float:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def clip01(x: float) -> float:
    return float(min(1.0, max(0.0, x)))
