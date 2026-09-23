import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from strategy_explorer.data.synthetic import generate_synthetic  # noqa: E402
from strategy_explorer.dsl.registry import Registry  # noqa: E402


@pytest.fixture(scope="session")
def md_1h():
    return generate_synthetic(3000, "1h", seed=11)


@pytest.fixture(scope="session")
def md_planted():
    return generate_synthetic(5000, "4h", seed=5, plant="squeeze_breakout", plant_strength=1.0)


@pytest.fixture(scope="session")
def reg_full():
    return Registry(columns=frozenset({"open", "high", "low", "close", "volume", "taker_buy_volume"}),
                    htf=("4h", "1d"), base_timeframe="1h")
