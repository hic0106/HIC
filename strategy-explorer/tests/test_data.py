import numpy as np
import pandas as pd
import pytest

from strategy_explorer.data import MarketData, align_to_base, make_split, quality_report, resample
from strategy_explorer.data.binance import ALLOWED_PATHS, BinanceDataProvider
from strategy_explorer.data.providers import CSVProvider, GenericOHLCVProvider
from strategy_explorer.data.splits import SplitError


def test_from_frame_cleans_and_parses(tmp_path):
    df = pd.DataFrame({
        "Timestamp": ["2024-01-01 02:00", "2024-01-01 00:00", "2024-01-01 01:00", "2024-01-01 01:00",
                      "2024-01-01 03:00"],
        "Open": [3, 1, 2, 2, 4], "High": [3.5, 1.5, 2.5, 2.5, 4.5], "Low": [2.5, 0.5, 1.5, 1.5, -1],
        "Close": [3.2, 1.2, 2.2, 2.2, 4.2], "Volume": [10, 11, 12, 12, 13],
    })
    md = MarketData.from_frame(df, "X", "1h")
    assert len(md) == 3  # duplicate dropped, negative low row dropped
    assert md.cleaning.duplicates_dropped == 1
    assert md.cleaning.invalid_rows_dropped == 1
    assert np.all(np.diff(md.ts) == 3_600_000)
    p = tmp_path / "X_1h.csv"
    md.to_frame().to_csv(p, index=False)
    md2 = CSVProvider(tmp_path).load("X", "1h")
    assert np.array_equal(md2.ts, md.ts) and np.allclose(md2.close, md.close)


def test_epoch_seconds_and_ms_detected():
    base = {"open": [1, 1], "high": [1, 1], "low": [1, 1], "close": [1, 1], "volume": [1, 1]}
    a = MarketData.from_frame(pd.DataFrame({"timestamp": [1_700_000_000, 1_700_003_600], **base}), "X", "1h")
    b = MarketData.from_frame(pd.DataFrame({"timestamp": [1_700_000_000_000, 1_700_003_600_000], **base}), "X",
                              "1h")
    assert np.array_equal(a.ts, b.ts)


def test_resample_and_alignment_no_lookahead(md_1h):
    h4 = resample(md_1h, "4h")
    assert np.allclose(h4.open[0], md_1h.open[0])
    assert np.allclose(h4.close[0], md_1h.close[3])
    assert np.allclose(h4.high[0], md_1h.high[:4].max())
    al = align_to_base(md_1h.close_ts, h4.close_ts, h4.close)
    # first three 1h bars cannot see the first 4h candle; the 4th (closing at 04:00) can
    assert np.isnan(al[:3]).all()
    assert al[3] == h4.close[0]
    assert al[4] == h4.close[0] and al[7] == h4.close[1]


def test_resample_drops_incomplete_bucket(md_1h):
    part = md_1h.slice(0, 10)  # 2 full 4h buckets + 2 bars
    h4 = resample(part, "4h")
    assert len(h4) == 2


def test_split_fractions_and_dates(md_1h):
    sp = make_split(md_1h, {"mode": "fractions", "train": 0.5, "validation": 0.15, "test": 0.2})
    assert sp.train == (0, 1500) and sp.holdout[1] == len(md_1h)
    assert sp.train[1] == sp.validation[0] and sp.test[1] == sp.holdout[0]
    with pytest.raises(SplitError):
        make_split(md_1h, {"mode": "fractions", "train": 0.9, "validation": 0.1, "test": 0.1})
    sp2 = make_split(md_1h, {"mode": "dates", "train_end": "2018-02-10", "validation_end": "2018-02-20",
                             "test_end": "2018-03-15"})
    assert md_1h.ts[sp2.validation[0]] == pd.Timestamp("2018-02-11", tz="UTC").value // 1_000_000


def test_quality_report(md_1h):
    gappy = md_1h.slice(0, 100)
    keep = np.r_[0:50, 55:100]
    gappy = MarketData(gappy.asset, gappy.timeframe, gappy.ts[keep], gappy.open[keep], gappy.high[keep],
                       gappy.low[keep], gappy.close[keep], gappy.volume[keep])
    q = quality_report(gappy)
    assert q.missing_bars == 5 and q.gap_count == 1 and q.largest_gap_bars == 5
    assert q.volume_available and not q.funding_available


def test_generic_provider_filters_range(md_1h):
    prov = GenericOHLCVProvider(md_1h.to_frame())
    md = prov.load("X", "1h", start_ms=int(md_1h.ts[10]), end_ms=int(md_1h.ts[20]))
    assert len(md) == 11


def test_binance_provider_public_only_and_paginates():
    calls = []
    bar = 3_600_000

    def fake(url):
        calls.append(url)
        if "fundingRate" in url:
            return [{"fundingTime": 1_600_000_000_000 + 8 * bar, "fundingRate": "0.0001"}]
        start = int(url.split("startTime=")[1].split("&")[0])
        n = 1000 if len(calls) == 1 else 5
        return [[start + i * bar, "1", "2", "0.5", "1.5", "10", start + (i + 1) * bar - 1, "15", 7, "6", "9", "0"]
                for i in range(n)]

    prov = BinanceDataProvider(fetch=fake, pause_s=0)
    md = prov.load("BTCUSDT", "1h", 1_600_000_000_000, 1_600_000_000_000 + 2000 * bar)
    assert len(md) == 1005
    assert all(any(p in u for p in ALLOWED_PATHS) for u in calls)
    assert md.extra["funding_rate"][8] == pytest.approx(0.0001)
    assert md.has("taker_buy_volume") and md.has("number_of_trades")
    with pytest.raises(PermissionError):
        prov._get("/fapi/v1/order", {})
