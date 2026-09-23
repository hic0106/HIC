"""Prompt templates and JSON schemas for the LLM proposer roles.

Prompts contain TRAIN-segment statistics only. The static system prompt (role,
rules, DSL grammar) is identical for every call of an experiment so it can be
served from the prompt cache.
"""

from __future__ import annotations

HYPOTHESES_SCHEMA = {
    "type": "object",
    "properties": {
        "hypotheses": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "rationale": {"type": "string"},
                    "pattern_ids": {"type": "array", "items": {"type": "string"}},
                    "dsl": {"type": "string"},
                },
                "required": ["name", "rationale", "pattern_ids", "dsl"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["hypotheses"],
    "additionalProperties": False,
}

EDITS_SCHEMA = {
    "type": "object",
    "properties": {
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"action": {"type": "string"}, "dsl": {"type": "string"}},
                "required": ["action", "dsl"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["edits"],
    "additionalProperties": False,
}

EXPLANATION_SCHEMA = {
    "type": "object",
    "properties": {"explanation": {"type": "string"}},
    "required": ["explanation"],
    "additionalProperties": False,
}

STRATEGY_FORMAT = """Strategy text format (one section per line, expressions may span lines):
DIRECTION: long | short | long_short
LONG_ENTRY: <BOOLEAN expression, or ONSET(<BOOLEAN>) to fire only on the bar the condition becomes true>
LONG_EXIT: <BOOLEAN expression>            (optional if MAX_HOLD is given)
SHORT_ENTRY / SHORT_EXIT: same, for short or long_short strategies
MAX_HOLD: <integer bars>                    (optional time exit)
STOP_LOSS: <fraction, e.g. 0.04>            (optional, checked on bar close)
Execution: rules are evaluated at the bar close and filled at the next bar's open, net of fees and slippage.
Example (illustrative syntax only, not a recommendation):
DIRECTION: long
LONG_ENTRY: ONSET(AND(GT(volume_zscore(20), 1.5), GT(range_position(20), 0.7)))
LONG_EXIT: LT(slope(log(close), 8), 0)
MAX_HOLD: 12"""

_RULES = """Rules:
- Output only rules expressible in the DSL below; unknown functions are rejected by the compiler.
- Rules must be scale invariant: compare dimensionless features with constants, or two series of the same unit.
- Do not reproduce textbook strategies (RSI thresholds, moving-average crossovers, MACD, Bollinger bands,
  Donchian/turtle channels, plain time-series momentum). Such rules are tagged KNOWN_LIKE and are not the goal.
- Prefer few conditions (1-3 clauses) with clear economic logic tied to the evidence provided.
- Your text is never used to score a strategy. Every hypothesis is compiled, backtested out of sample, and
  judged only by walk-forward results, cost survival, parameter stability, the Deflated Sharpe Ratio and the
  Probability of Backtest Overfitting. Do not claim a strategy is good; propose testable variations.
- The statistics you receive come from the TRAIN segment only."""


def system_prompt(role: str, grammar_card: str, timeframe: str, asset_class: str) -> str:
    roles = {
        "hypothesis": "You are a quantitative research assistant. You turn statistical observations about "
                      "repeated price/volume behaviour into precise, testable trading-rule hypotheses.",
        "reflection": "You are a quantitative research assistant reviewing the results of a strategy search "
                      "generation (TRAIN data only) and proposing the next hypotheses to test.",
        "mcts": "You are a quantitative research assistant proposing small, testable edits to one trading rule.",
        "vision": "You are a quantitative research assistant looking at candlestick charts with a volume panel. "
                  "You describe recurring structures you see and turn them into testable rules. The images are "
                  "illustrations only; every rule is verified on the underlying numeric data.",
        "explain": "You explain an existing trading rule in plain language for a human reviewer, using only the "
                   "facts supplied. You never add performance claims that are not in the facts.",
    }
    return "\n\n".join([
        roles[role],
        f"Market context: base timeframe {timeframe}, asset class {asset_class}.",
        _RULES,
        STRATEGY_FORMAT,
        "DSL reference:\n" + grammar_card,
    ])


def hypothesis_prompt(pattern_texts: list[str], regime_texts: list[str], memory_notes: list[str], n: int) -> str:
    parts = ["Observed patterns (TRAIN segment):", *pattern_texts]
    if regime_texts:
        parts += ["", "Latent regimes (unsupervised HMM, TRAIN statistics):", *regime_texts]
    if memory_notes:
        parts += ["", "Research memory (earlier searches, TRAIN-only conclusions):", *memory_notes]
    parts += ["", f"Propose up to {n} distinct, testable strategy hypotheses in the strategy text format. "
                  "Reference the pattern ids you used. Vary structure (entry logic, exit logic, holding period, "
                  "direction) rather than only thresholds."]
    return "\n".join(parts)


def reflection_prompt(summary_text: str, memory_notes: list[str], best_rules: list[str], n: int) -> str:
    parts = ["Previous generation findings (TRAIN segment only):", summary_text, "",
             "Best rules so far by train robustness (for structure reference, not for copying):", *best_rules]
    if memory_notes:
        parts += ["", "Research memory:", *memory_notes]
    parts += ["", f"Propose up to {n} new hypotheses that follow promising directions and avoid families marked "
                  "weak, cost-sensitive or exhausted unless the structure changes materially."]
    return "\n".join(parts)


def mcts_prompt(dsl: str, train_facts: str, actions: list[str], n: int) -> str:
    return "\n".join([
        "Current rule:", dsl, "", "Train-segment facts:", train_facts, "",
        f"Allowed edit actions: {', '.join(actions)}.",
        f"Propose up to {n} edited versions (full strategy text each), one action per edit.",
    ])


def vision_prompt(n_images: int, context: str, n: int) -> str:
    return "\n".join([
        f"You see {n_images} candlestick charts (TRAIN segment). Grey shading marks bars after the reference "
        "point where applicable.", context, "",
        f"Describe recurring price/volume structures and propose up to {n} testable hypotheses in the strategy "
        "text format. Use only dimensionless DSL features (returns, ranges, relative volume, positions in range).",
    ])


def explanation_prompt(dsl: str, facts: str) -> str:
    return "\n".join(["Rule:", dsl, "", "Facts (computed by the backtester):", facts, "",
                      "Write a short explanation in Korean (4-6 sentences): what market situation the rule looks "
                      "for, what the entry and exit do, and what the facts say about when it worked. Do not add "
                      "claims beyond the facts."])
