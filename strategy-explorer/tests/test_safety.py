"""Hard guarantees: no trading code, no dependency on the existing trading program."""

import ast
import re
from pathlib import Path

PKG = Path(__file__).resolve().parents[1] / "src" / "strategy_explorer"
FORBIDDEN = [
    r"/fapi/v1/order", r"/api/v3/order", r"/fapi/v1/algoOrder", r"/fapi/v1/leverage", r"/fapi/v1/positionSide",
    r"/fapi/v2/account", r"/fapi/v2/balance", r"listenKey", r"X-MBX-APIKEY", r"hmac\.new", r"api_secret",
    r"secretKey", r"newClientOrderId", r"place_order", r"create_order",
]


def _sources():
    return [p for p in PKG.rglob("*") if p.suffix in (".py", ".js", ".html") and p.is_file()]


def test_no_order_or_account_code_anywhere():
    for p in _sources():
        text = p.read_text(encoding="utf-8")
        for pat in FORBIDDEN:
            assert not re.search(pat, text), f"{pat} found in {p}"


def test_binance_provider_is_public_market_data_only():
    from strategy_explorer.data.binance import ALLOWED_PATHS

    assert ALLOWED_PATHS == {"/fapi/v1/klines", "/fapi/v1/fundingRate", "/api/v3/klines"}
    src = (PKG / "data" / "binance.py").read_text(encoding="utf-8")
    assert "signature" not in src.lower() and "apikey" not in src.lower().replace("_", "")


def test_no_imports_from_the_trading_terminal():
    for p in PKG.rglob("*.py"):
        tree = ast.parse(p.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                assert not node.module.split(".")[0] in ("server", "public", "tools"), (p, node.module)
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name.split(".")[0] not in ("server", "public", "tools"), (p, alias.name)
    for p in _sources():
        text = p.read_text(encoding="utf-8")
        assert "../server" not in text and "strategiesTradfi" not in text and "controllerEngine" not in text


def test_ui_binds_localhost_by_default():
    import inspect

    from strategy_explorer.ui.server import serve

    assert inspect.signature(serve).parameters["host"].default == "127.0.0.1"
