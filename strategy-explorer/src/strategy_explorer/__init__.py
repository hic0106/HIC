"""AI Strategy Explorer.

Research-only laboratory: discovers repeated price/volume behaviour in OHLCV data,
turns it into rules expressed in a strongly-typed Strategy DSL, and filters the
resulting hypotheses with deterministic, cost-aware backtests and an overfitting
firewall.

This package never places orders, never uses exchange trading permissions,
never touches live accounts and never deploys strategies. Surviving strategies
are exported as recipe files for human review only.
"""

__version__ = "0.1.0"

RESEARCH_ONLY_NOTICE = (
    "AI Strategy Explorer is a research tool. It performs no live trading, holds no "
    "exchange credentials and never deploys strategies. Exported recipes must be "
    "reviewed by a human before any use elsewhere."
)
