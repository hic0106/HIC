"""Pre-committed search budget split into exploration and exploitation.

The budget is fixed before the run starts and every evaluated candidate
(including duplicates of behaviour, failures and no-trade rules) consumes it.
Neither phase can borrow from the other, so a run cannot keep "trying a bit
more" until something lucky appears.
"""

from __future__ import annotations

from dataclasses import dataclass, field

EXPLORE, EXPLOIT = "explore", "exploit"


@dataclass
class SearchBudget:
    max_trials: int
    explore_fraction: float = 0.6
    used: dict = field(default_factory=lambda: {EXPLORE: 0, EXPLOIT: 0})

    def __post_init__(self):
        if self.max_trials <= 0:
            raise ValueError("max_trials must be positive")
        if not 0.0 <= self.explore_fraction <= 1.0:
            raise ValueError("explore_fraction must be within [0, 1]")
        explore = int(round(self.max_trials * self.explore_fraction))
        self.caps = {EXPLORE: explore, EXPLOIT: self.max_trials - explore}

    def remaining(self, phase: str | None = None) -> int:
        if phase is None:
            return sum(self.remaining(p) for p in (EXPLORE, EXPLOIT))
        return max(0, self.caps[phase] - self.used[phase])

    def can_spend(self, phase: str, k: int = 1) -> bool:
        return self.remaining(phase) >= k

    def spend(self, phase: str, k: int = 1) -> None:
        if not self.can_spend(phase, k):
            raise RuntimeError(f"search budget for {phase} exhausted")
        self.used[phase] += k

    @property
    def total_used(self) -> int:
        return self.used[EXPLORE] + self.used[EXPLOIT]

    @property
    def exhausted(self) -> bool:
        return self.remaining() == 0

    def explore_share_needed(self) -> float:
        """Probability of choosing an exploration operator so that spending tracks the target split."""
        re, rx = self.remaining(EXPLORE), self.remaining(EXPLOIT)
        if re + rx == 0:
            return 0.0
        return re / (re + rx)

    def to_dict(self) -> dict:
        return {"max_trials": self.max_trials, "explore_fraction": self.explore_fraction, "caps": dict(self.caps),
                "used": dict(self.used), "remaining": self.remaining()}
