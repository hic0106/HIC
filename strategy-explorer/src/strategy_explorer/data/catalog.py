"""Discover datasets stored as ``{ASSET}_{TIMEFRAME}.csv|.parquet`` in a data directory."""

from __future__ import annotations

import re
from pathlib import Path

from .market import TIMEFRAME_MS
from .providers import CSVProvider, ParquetProvider, _read_meta
from .quality import quality_report

_NAME = re.compile(r"^(?P<asset>[A-Za-z0-9\-\.]+)_(?P<tf>\d+[mhd])\.(?P<ext>csv|parquet)$")


def scan(data_dir: str | Path) -> list[dict]:
    root = Path(data_dir)
    out = []
    if not root.exists():
        return out
    for p in sorted(root.iterdir()):
        m = _NAME.match(p.name)
        if not m or m.group("tf") not in TIMEFRAME_MS:
            continue
        meta = _read_meta(p)
        out.append({
            "asset": m.group("asset"),
            "timeframe": m.group("tf"),
            "provider": m.group("ext"),
            "path": str(p),
            "asset_class": meta.get("asset_class", "crypto"),
            "size_bytes": p.stat().st_size,
        })
    return out


def load_ref(ref: dict):
    prov = CSVProvider(ref["path"]) if ref["provider"] == "csv" else ParquetProvider(ref["path"])
    prov.asset_class = ref.get("asset_class")
    return prov.load(ref["asset"], ref["timeframe"])


def describe(data_dir: str | Path) -> list[dict]:
    rows = []
    for ref in scan(data_dir):
        try:
            md = load_ref(ref)
            q = quality_report(md).to_dict()
            rows.append({**ref, "quality": q, "error": None})
        except Exception as exc:  # report unreadable files instead of failing the screen
            rows.append({**ref, "quality": None, "error": str(exc)})
    return rows
