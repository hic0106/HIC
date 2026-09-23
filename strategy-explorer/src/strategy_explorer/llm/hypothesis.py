"""Hypothesis Engine: merges the NUMERIC path (pattern statistics) and the
VISUAL path (chart images) into candidate strategies expressed in the DSL.

With an LLM backend, summaries (never raw prices) are sent to the model and
its JSON answer is parsed into DSL text. Without one, deterministic templates
convert each discovered pattern into a few rule variants. Either way the
output is only a list of Proposals for the TrialManager - nothing is adopted
because a model liked it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..data.market import MarketData
from ..dsl.nodes import fmt_number
from ..patterns.library import Pattern
from ..search.budget import EXPLOIT, EXPLORE
from ..search.families import clauses
from ..search.trials import Proposal, TrialRecord
from .client import LLMRequest, LLMUnavailable
from .prompts import (EDITS_SCHEMA, HYPOTHESES_SCHEMA, hypothesis_prompt, mcts_prompt, reflection_prompt,
                      system_prompt, vision_prompt)
from .render import render_candles


@dataclass
class HypothesisConfig:
    max_per_call: int = 12
    template_variants: tuple[str, ...] = ("hold", "trend_exit", "regime", "profile_mix", "profile_only")
    vision: bool = False
    vision_images: int = 4
    vision_window: int = 60
    mcts_llm: bool = False


def _side(direction: str) -> str:
    return "LONG" if direction == "long" else "SHORT"


def best_horizon(p: Pattern) -> int:
    best, best_v = int(p.stats.get("primary_horizon", 5)), None
    for h, hs in p.stats.get("horizons", {}).items():
        if hs.get("n", 0) < 10 or "excess_mean" not in hs:
            continue
        v = hs["excess_mean"] if p.direction == "long" else -hs["excess_mean"]
        if best_v is None or v > best_v:
            best, best_v = int(h), v
    return max(1, best)


def _profile_conditions(p: Pattern, k: int = 2) -> list[str]:
    out = []
    for row in p.profile:
        if len(out) >= k or row.get("lag", 0):
            continue
        feat = row["feature"]
        thr = fmt_number(float(f"{row['event_median']:.4g}"))
        out.append(f"GT({feat}, {thr})" if row["z"] > 0 else f"LT({feat}, {thr})")
    return out


class HypothesisEngine:
    def __init__(self, llm, grammar_card: str, timeframe: str, asset_class: str, rng: np.random.Generator,
                 cfg: HypothesisConfig | None = None):
        self.llm = llm
        self.grammar = grammar_card
        self.timeframe = timeframe
        self.asset_class = asset_class
        self.rng = rng
        self.cfg = cfg or HypothesisConfig()
        self.notes: list[str] = []
        self.generated = 0

    @property
    def backend(self) -> str:
        return self.llm.backend if self.llm is not None else "offline-template"

    # ---------------------------------------------------------------- LLM call
    def _ask(self, role: str, user: str, method: str, phase: str, generation: int, images=(),
             parents: tuple[int, ...] = ()) -> list[Proposal]:
        if self.llm is None:
            return []
        req = LLMRequest(purpose=role, system=system_prompt(role, self.grammar, self.timeframe, self.asset_class),
                         user=user, schema=HYPOTHESES_SCHEMA, images=list(images))
        try:
            resp = self.llm.complete_json(req)
        except LLMUnavailable as exc:
            self.notes.append(f"{role}: LLM unavailable ({exc}); using templates")
            return []
        if resp.refused or not resp.data:
            self.notes.append(f"{role}: no usable LLM output (stop_reason={resp.stop_reason})")
            return []
        out = []
        for h in resp.data.get("hypotheses", [])[: self.cfg.max_per_call]:
            text = str(h.get("dsl", "")).strip()
            if not text:
                continue
            out.append(Proposal(text=text, creation_method=method, operator=role, phase=phase, parents=parents,
                                generation=generation,
                                meta={"name": h.get("name"), "rationale": h.get("rationale"),
                                      "pattern_ids": h.get("pattern_ids", []), "backend": resp.backend,
                                      "model": resp.model}))
        self.generated += len(out)
        return out

    # ------------------------------------------------------------ numeric path
    def template_proposals(self, patterns: list[Pattern], n: int, generation: int = 0) -> list[Proposal]:
        out: list[Proposal] = []
        for p in patterns:
            if p.direction not in ("long", "short"):
                continue
            side = _side(p.direction)
            h = best_horizon(p)
            base = {"pattern_id": p.pattern_id, "backend": "offline-template", "pattern_kind": p.kind}
            cond = p.dsl
            variants: list[tuple[str, str]] = []
            if "hold" in self.cfg.template_variants:
                variants.append(("hold", f"DIRECTION: {p.direction}\n{side}_ENTRY: ONSET({cond})\nMAX_HOLD: {h}"))
            if "trend_exit" in self.cfg.template_variants:
                w = max(3, min(20, h))
                ex = f"LT(slope(log(close), {w}), 0)" if p.direction == "long" else f"GT(slope(log(close), {w}), 0)"
                variants.append(("trend_exit", f"DIRECTION: {p.direction}\n{side}_ENTRY: ONSET({cond})\n"
                                               f"{side}_EXIT: {ex}\nMAX_HOLD: {3 * h}"))
            if "regime" in self.cfg.template_variants and p.regimes:
                k, share = max(p.regimes.items(), key=lambda kv: kv[1])
                if share >= 0.5:
                    variants.append(("regime", f"DIRECTION: {p.direction}\n{side}_ENTRY: ONSET(AND({cond}, "
                                               f"regime_is({int(k)})))\nMAX_HOLD: {h}"))
            prof = _profile_conditions(p, 2)
            if "profile_mix" in self.cfg.template_variants and p.kind != "conditional" and prof:
                variants.append(("profile_mix", f"DIRECTION: {p.direction}\n{side}_ENTRY: ONSET(AND({cond}, "
                                                f"{prof[0]}))\nMAX_HOLD: {h}"))
            if "profile_only" in self.cfg.template_variants and p.kind != "conditional" and len(prof) >= 2:
                variants.append(("profile_only", f"DIRECTION: {p.direction}\n{side}_ENTRY: ONSET(AND({prof[0]}, "
                                                 f"{prof[1]}))\nMAX_HOLD: {h}"))
            for name, text in variants:
                out.append(Proposal(text=text, creation_method="PATTERN", operator=name, phase=EXPLORE,
                                    generation=generation, meta={**base, "variant": name,
                                                                 "rationale": p.summary_text.splitlines()[0]}))
        self.generated += min(n, len(out))
        return out[:n]

    def from_patterns(self, patterns: list[Pattern], regime_desc: list[dict], memory_notes: list[str], n: int,
                      generation: int = 0) -> list[Proposal]:
        props: list[Proposal] = []
        if self.llm is not None and patterns:
            texts = [p.summary_text for p in patterns[:14]]
            regimes = [f"R{d['regime']} {d.get('label', '')}: share {100 * d['share']:.0f}%, ann. vol "
                       f"{d['ann_volatility']:.2f}, expected duration {d['expected_duration_bars']:.0f} bars"
                       for d in (regime_desc or [])]
            props = self._ask("hypothesis", hypothesis_prompt(texts, regimes, memory_notes, min(n, 12)), "LLM",
                              EXPLORE, generation)
        templates = self.template_proposals(patterns, n, generation)
        # LLM output first; templates always included so each pattern is tested in at least one form
        return (props + templates)[: max(n, len(props))]

    # -------------------------------------------------------------- reflection
    def from_reflection(self, summary_txt: str, best: list[TrialRecord], memory_notes: list[str],
                        patterns: list[Pattern], n: int, generation: int) -> list[Proposal]:
        if self.llm is not None:
            best_rules = [r.strategy.text.replace("\n", " | ") for r in best[:5] if r.strategy]
            props = self._ask("reflection", reflection_prompt(summary_txt, memory_notes, best_rules, n), "LLM",
                              EXPLORE, generation, parents=tuple(r.trial_id for r in best[:1]))
            if props:
                return props
        # offline: cross the best structures with pattern conditions (structure change, not threshold tweaks)
        out = []
        pats = [p for p in patterns if p.kind == "conditional"] or patterns
        for r in best[:3]:
            st = r.strategy
            for p in pats[:3]:
                side = "long_entry" if st.direction in ("long", "long_short") else "short_entry"
                root = st.slot(side)
                if root is None:
                    continue
                cl = [c.text for c in clauses(root)][:2]
                body = f"AND({', '.join(cl + [p.dsl])})"
                entry = f"ONSET({body})" if root.op == "ONSET" else body
                lines = [f"DIRECTION: {st.direction}", f"{side.upper()}: {entry}"]
                for s, node in st.slot_items():
                    if s != side:
                        lines.append(f"{s.upper()}: {node.text}")
                if st.max_hold:
                    lines.append(f"MAX_HOLD: {st.max_hold}")
                elif st.slot(side.replace("entry", "exit")) is None:
                    lines.append(f"MAX_HOLD: {best_horizon(p)}")
                out.append(Proposal(text="\n".join(lines), creation_method="REFLECTION", operator="cross_pattern",
                                    phase=EXPLORE, parents=(r.trial_id,), generation=generation,
                                    meta={"pattern_id": p.pattern_id, "backend": "offline-template"}))
        return out[:n]

    # ------------------------------------------------------------- visual path
    def visual_windows(self, md_train: MarketData, patterns: list[Pattern]) -> list[tuple[int, int, int]]:
        w = self.cfg.vision_window
        out = []
        for p in patterns[: self.cfg.vision_images]:
            if p.occurrences:
                e = p.occurrences[len(p.occurrences) // 2]
                out.append((max(0, e - w + 10), min(len(md_train), e + 10), e))
        while len(out) < self.cfg.vision_images and len(md_train) > 2 * w:
            e = int(self.rng.integers(w, len(md_train) - 10))
            out.append((e - w + 10, e + 10, e))
        return out

    def render_images(self, md_train: MarketData, patterns: list[Pattern]) -> list[bytes]:
        return [render_candles(md_train, s, e, marker=m, shade_from=m + 1) for s, e, m in
                self.visual_windows(md_train, patterns)]

    def from_images(self, md_train: MarketData, patterns: list[Pattern], n: int, generation: int = 0) -> list[Proposal]:
        if self.llm is None or not self.cfg.vision:
            return []
        imgs = self.render_images(md_train, patterns)
        ctx = "Each chart is centred on a TRAIN-segment bar; the yellow line marks the reference bar."
        return self._ask("vision", vision_prompt(len(imgs), ctx, n), "VISION", EXPLORE, generation, images=imgs)

    # -------------------------------------------------------------- MCTS edits
    def mcts_expander(self, actions: list[str], n: int = 3):
        if self.llm is None or not self.cfg.mcts_llm:
            return None

        def expand(rec: TrialRecord) -> list[str]:
            m = rec.is_metrics or {}
            facts = (f"net return {m.get('total_return', 0):+.2%}, trades {m.get('trades', 0)}, sortino "
                     f"{m.get('sortino', 0):.2f}, max drawdown {m.get('max_drawdown', 0):.2%}, "
                     f"sub-period consistency {m.get('consistency', 0):.2f}")
            req = LLMRequest(purpose="mcts", system=system_prompt("mcts", self.grammar, self.timeframe,
                                                                  self.asset_class),
                             user=mcts_prompt(rec.strategy.text, facts, actions, n), schema=EDITS_SCHEMA)
            try:
                resp = self.llm.complete_json(req)
            except LLMUnavailable:
                return []
            if not resp.data:
                return []
            return [str(e.get("dsl", "")) for e in resp.data.get("edits", [])[:n] if e.get("dsl")]

        return expand


__all__ = ["HypothesisConfig", "HypothesisEngine", "best_horizon", "EXPLOIT"]
