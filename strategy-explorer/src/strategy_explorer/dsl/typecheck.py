"""Static type checking, literal resolution and strategy validation."""

from __future__ import annotations

from .nodes import SLOTS, Node, Strategy, canonicalize, count_nodes, depth
from .parser import parse_strategy
from .registry import Registry, canonical_name
from .types import (BOOLEAN, DIMLESS, FLOAT, LITERAL_KINDS, PATTERN, QUANT, REGIME, SERIES, SIGNAL, TF, WINDOW,
                    DSLTypeError, T_BOOL, T_SIGNAL, Type)

_TYPED_LITERAL = {"#float": FLOAT, "#window": WINDOW, "#quant": QUANT, "#tf": TF, "#regime": REGIME,
                  "#pattern": PATTERN}
_LITERAL_OP = {v: k for k, v in _TYPED_LITERAL.items()}
_FORBIDDEN_IN_TF = frozenset({"tf", "regime_is", "regime_prob", "pattern_distance"})


class TypeChecker:
    def __init__(self, registry: Registry, max_nodes: int = 80, max_depth: int = 12):
        self.reg = registry
        self.max_nodes = max_nodes
        self.max_depth = max_depth

    # ------------------------------------------------------------- literals
    def _literal(self, node: Node, expected: Type) -> Node:
        kind = expected.kind
        if kind not in LITERAL_KINDS:
            raise DSLTypeError(f"literal {node.value!r} cannot be used where {expected} is required")
        if node.op in _TYPED_LITERAL:
            if _TYPED_LITERAL[node.op] != kind:
                raise DSLTypeError(f"literal of kind {_TYPED_LITERAL[node.op]} used where {kind} is required")
            raw = node.value
        else:
            raw = node.value
        if kind in (FLOAT, WINDOW, QUANT, REGIME):
            if node.op in ("#str", "#tf", "#pattern"):
                raise DSLTypeError(f"string literal {raw!r} used where a number ({kind}) is required")
            v = float(raw)
            if kind in (FLOAT, QUANT) and v == v and abs(v) != float("inf"):
                v = float(f"{v:.6g}")  # stored value == printed value, so hash identity == behaviour identity
            if kind == FLOAT:
                if v != v or v in (float("inf"), float("-inf")):
                    raise DSLTypeError("threshold must be finite")
                return Node("#float", (), float(v))
            if kind == WINDOW:
                if not float(v).is_integer():
                    raise DSLTypeError(f"window must be an integer, got {raw}")
                iv = int(v)
                if iv < 1 or iv > self.reg.max_window:
                    raise DSLTypeError(f"window {iv} outside 1..{self.reg.max_window}")
                return Node("#window", (), iv)
            if kind == QUANT:
                if not 0.0 < v < 1.0:
                    raise DSLTypeError(f"quantile must be in (0,1), got {raw}")
                return Node("#quant", (), float(v))
            iv = int(v)
            if not float(v).is_integer() or not 0 <= iv < max(self.reg.n_regimes, 0):
                raise DSLTypeError(f"regime id {raw} not in 0..{self.reg.n_regimes - 1}")
            return Node("#regime", (), iv)
        if node.op not in ("#str", "#tf", "#pattern"):
            raise DSLTypeError(f"number {raw!r} used where a string ({kind}) is required")
        s = str(raw)
        if kind == TF:
            if s not in self.reg.htf:
                raise DSLTypeError(f"timeframe {s!r} not available (higher timeframes: {list(self.reg.htf)})")
            return Node("#tf", (), s)
        if s not in self.reg.pattern_ids:
            raise DSLTypeError(f"unknown pattern id {s!r}")
        return Node("#pattern", (), s)

    # ---------------------------------------------------------- expressions
    def check_expr(self, node: Node, expected: Type | None = None, inside_tf: bool = False) -> tuple[Node, Type]:
        if node.is_literal:
            if expected is None:
                raise DSLTypeError(f"bare literal {node.value!r} is not a valid expression here")
            lit_node = self._literal(node, expected)
            return lit_node, expected
        name = canonical_name(node.op)
        if name is None:
            raise DSLTypeError(f"unknown function or series {node.op!r}")
        if inside_tf and name in _FORBIDDEN_IN_TF:
            raise DSLTypeError(f"{name} cannot be used inside tf()")
        cands = [s for s in self.reg.by_name(name) if len(s.args) == len(node.args)]
        if not cands:
            arities = sorted({len(s.args) for s in self.reg.by_name(name)})
            if not arities:
                raise DSLTypeError(f"{name} is not available for this dataset/context")
            raise DSLTypeError(f"{name} takes {arities} argument(s), got {len(node.args)}")
        typed_children: list[Node | None] = []
        child_types: list[Type | None] = []
        for a in node.args:
            if a.is_literal:
                typed_children.append(None)
                child_types.append(None)
            else:
                tn, tt = self.check_expr(a, None, inside_tf or name == "tf")
                typed_children.append(tn)
                child_types.append(tt)
        match = None
        for s in cands:
            ok = True
            for want, got in zip(s.args, child_types):
                if got is None:
                    if want.kind not in LITERAL_KINDS:
                        ok = False
                        break
                elif got != want:
                    ok = False
                    break
            if ok and (expected is None or expected == s.ret):
                match = s
                break
        if match is None:
            got_desc = ", ".join("literal" if t is None else str(t) for t in child_types)
            hint = ""
            if name in ("GT", "LT", "CROSS_ABOVE", "CROSS_BELOW") and child_types and child_types[0] is not None \
                    and child_types[0].unit != DIMLESS and len(child_types) > 1 and child_types[1] is None:
                hint = (" - absolute levels cannot be compared with constants (scale invariance); compare with"
                        " another series of the same unit or use a dimensionless transform")
            raise DSLTypeError(f"no signature {name}({got_desc}){' -> ' + str(expected) if expected else ''}{hint}")
        args = []
        for a, tn, want in zip(node.args, typed_children, match.args):
            if tn is None:
                lit_node = self._literal(a, want)
                if want.kind == WINDOW and lit_node.value < match.min_window:
                    raise DSLTypeError(f"{name} needs window >= {match.min_window}, got {lit_node.value}")
                args.append(lit_node)
            else:
                args.append(tn)
        return Node(name, tuple(args), None, match.key), match.ret

    def check_slot(self, node: Node) -> Node:
        typed, t = self.check_expr(node)
        if t == T_BOOL:
            typed = Node("WHEN", (typed,), None, "WHEN")
        elif t != T_SIGNAL:
            raise DSLTypeError(f"entry/exit rules must be BOOLEAN or SIGNAL, got {t}")
        if typed.op in ("WHEN", "ONSET") and any(n.op in ("WHEN", "ONSET") for n in _descendants(typed.args[0])):
            raise DSLTypeError("WHEN/ONSET may only appear at the root of a rule")
        return typed

    # -------------------------------------------------------------- strategy
    def check_strategy(self, strategy: Strategy) -> Strategy:
        first = {s: (self.check_slot(n) if n is not None else None) for s in SLOTS for n in [strategy.slot(s)]}
        canon = {s: (canonicalize(n) if n is not None else None) for s, n in first.items()}
        typed = {s: (self.check_slot(n) if n is not None else None) for s, n in canon.items()}
        st = strategy.replace(**typed)
        self.validate(st)
        return st

    def validate(self, st: Strategy) -> None:
        if st.direction in ("long", "long_short") and st.long_entry is None:
            raise DSLTypeError(f"direction {st.direction} requires LONG_ENTRY")
        if st.direction in ("short", "long_short") and st.short_entry is None:
            raise DSLTypeError(f"direction {st.direction} requires SHORT_ENTRY")
        if st.direction == "long" and (st.short_entry is not None or st.short_exit is not None):
            raise DSLTypeError("long-only strategy must not define SHORT rules")
        if st.direction == "short" and (st.long_entry is not None or st.long_exit is not None):
            raise DSLTypeError("short-only strategy must not define LONG rules")
        for side, exit_slot in (("long", st.long_exit), ("short", st.short_exit)):
            active = st.direction in (side, "long_short")
            if active and exit_slot is None and st.max_hold is None:
                raise DSLTypeError(f"{side} side needs an exit rule or MAX_HOLD")
        if st.max_hold is not None and not 1 <= st.max_hold <= 5000:
            raise DSLTypeError("MAX_HOLD must be within 1..5000 bars")
        for name, v in (("STOP_LOSS", st.stop_loss), ("TAKE_PROFIT", st.take_profit)):
            if v is not None and not 0.0 < v < 1.0:
                raise DSLTypeError(f"{name} must be a fraction in (0,1)")
        total = sum(count_nodes(n) for _, n in st.slot_items())
        if total > self.max_nodes:
            raise DSLTypeError(f"strategy has {total} nodes; limit is {self.max_nodes}")
        d = max(depth(n) for _, n in st.slot_items())
        if d > self.max_depth:
            raise DSLTypeError(f"rule depth {d} exceeds limit {self.max_depth}")


def _descendants(node: Node):
    yield node
    for a in node.args:
        yield from _descendants(a)


def compile_strategy(text: str, registry: Registry, max_nodes: int = 80, max_depth: int = 12) -> Strategy:
    """Parse + type check + canonicalise DSL text."""
    return TypeChecker(registry, max_nodes, max_depth).check_strategy(parse_strategy(text))


__all__ = ["TypeChecker", "compile_strategy", "DSLTypeError", "SERIES", "BOOLEAN", "SIGNAL"]
