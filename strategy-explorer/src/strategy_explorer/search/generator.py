"""Strongly-typed random tree generation and variation operators (GP and MCTS actions).

Trees are built only from registry signatures whose return type matches the
slot being filled, so every generated expression type-checks by construction.
Thresholds are data-driven: a comparison ``GT(x, c)`` gets ``c`` from a
quantile of ``x`` on TRAIN data, so conditions are neither vacuous nor absurd.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..dsl.complexity import FEATURE_CATEGORIES
from ..dsl.evaluator import EvalContext
from ..dsl.nodes import Node, Strategy, get_at, iter_nodes, replace_at
from ..dsl.registry import MAX_LOGIC_ARITY, SIG_BY_KEY, Registry, Sig
from ..dsl.typecheck import TypeChecker
from ..dsl.types import (BOOLEAN, DIMLESS, FLOAT, LITERAL_KINDS, PATTERN, QUANT, REGIME, SERIES, SIGNAL, TF, WINDOW,
                         DSLTypeError, T_BOOL, T_DIMLESS, T_FLOAT, T_SIGNAL, Type, S)
from .budget import EXPLOIT, EXPLORE

STRUCTURAL_OPS = ("subtree", "add_condition", "remove_condition", "exit_change", "direction", "hoist")
PARAMETRIC_OPS = ("point", "window", "threshold", "signal_type")
OP_PHASE = {**{o: EXPLORE for o in STRUCTURAL_OPS}, **{o: EXPLOIT for o in PARAMETRIC_OPS},
            "crossover": EXPLORE, "random": EXPLORE}

NAME_WEIGHTS_DEFAULT = {
    "feature": 3.0, "optional": 2.0, "terminal": 1.5, "transform": 0.7, "temporal": 0.5, "mtf": 0.5,
    "regime": 0.6, "pattern": 1.2,
}
UNIT_WEIGHTS = {"price": 1.0, "volume": 0.7, "log_price": 0.5, "log_volume": 0.4, DIMLESS: 1.0}


@dataclass
class GenConfig:
    max_depth: int = 6
    max_nodes: int = 40
    directions: tuple[str, ...] = ("long", "short", "long_short")
    direction_weights: tuple[float, ...] = (0.5, 0.25, 0.25)
    entry_clauses: tuple[float, ...] = (0.3, 0.45, 0.25)   # P(1, 2, 3 clauses)
    exit_clauses: tuple[float, ...] = (0.75, 0.25)
    p_exit_rule: float = 0.75
    p_max_hold: float = 0.6
    max_hold_grid: tuple[int, ...] = (3, 5, 8, 12, 20, 30, 50)
    p_onset: float = 0.3
    p_series_compare: float = 0.2
    p_temporal: float = 0.1
    p_regime: float = 0.08
    p_pattern: float = 0.12
    p_leaf: float = 0.65
    min_fire_rate: float = 0.003
    max_fire_rate: float = 0.6
    name_weights: dict = field(default_factory=lambda: dict(NAME_WEIGHTS_DEFAULT))
    exclude_names: tuple[str, ...] = ()


class ThresholdSampler:
    """Data-driven constants from TRAIN values only."""

    QUANTS_GT = (0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95)
    QUANTS_LT = (0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4)

    def __init__(self, ctx: EvalContext, train: tuple[int, int], rng: np.random.Generator, max_sample: int = 4000):
        self.ctx = ctx
        self.s, self.e = train
        self.rng = rng
        self.max_sample = max_sample
        self._cache: dict[str, np.ndarray] = {}

    def values(self, node: Node) -> np.ndarray:
        key = node.text
        v = self._cache.get(key)
        if v is None:
            arr = np.asarray(self.ctx.eval(node), dtype=np.float64)[self.s:self.e]
            arr = arr[np.isfinite(arr)]
            if arr.size > self.max_sample:
                idx = np.linspace(0, arr.size - 1, self.max_sample).astype(np.int64)
                arr = np.sort(arr)[idx]
            else:
                arr = np.sort(arr)
            self._cache[key] = arr
            v = arr
        return v

    @staticmethod
    def _round(x: float) -> float:
        if x == 0 or not np.isfinite(x):
            return 0.0
        return float(f"{x:.4g}")

    def at_quantile(self, node: Node, q: float) -> float | None:
        v = self.values(node)
        if v.size < 20 or v[0] == v[-1]:
            return None
        return self._round(float(np.quantile(v, float(np.clip(q, 0.001, 0.999)))))

    def quantile_of(self, node: Node, x: float) -> float:
        v = self.values(node)
        if v.size == 0:
            return 0.5
        return float(np.searchsorted(v, x) / v.size)

    def sample(self, node: Node, op: str) -> float | None:
        try:
            self.values(node)
        except (KeyError, ValueError, RuntimeError):
            return None
        if op == "GT":
            q = self.rng.choice(self.QUANTS_GT)
        elif op == "LT":
            q = self.rng.choice(self.QUANTS_LT)
        else:
            q = self.rng.uniform(0.2, 0.8)
        return self.at_quantile(node, q)

    def fire_rate(self, node: Node) -> float:
        arr = np.asarray(self.ctx.eval(node), dtype=np.float64)[self.s:self.e]
        return float(np.mean(arr == 1.0)) if arr.size else 0.0


def node_type(n: Node) -> Type:
    if n.op in ("WHEN", "ONSET"):
        return T_SIGNAL
    sig = SIG_BY_KEY.get(n.sig) if n.sig else None
    if sig is None:
        raise ValueError(f"untyped node {n.text}")
    return sig.ret


def typed_paths(root: Node) -> list[tuple[tuple[int, ...], Node, Type]]:
    out: list[tuple[tuple[int, ...], Node, Type]] = []

    def rec(n: Node, path: tuple[int, ...], t: Type) -> None:
        out.append((path, n, t))
        if n.is_literal:
            return
        sig = SIG_BY_KEY[n.sig]
        for i, a in enumerate(n.args):
            rec(a, path + (i,), sig.args[i])

    rec(root, (), node_type(root))
    return out


class TypedGenerator:
    def __init__(self, registry: Registry, sampler: ThresholdSampler, rng: np.random.Generator,
                 cfg: GenConfig | None = None, pattern_weights: dict[str, float] | None = None):
        self.reg = registry
        self.sampler = sampler
        self.rng = rng
        self.cfg = cfg or GenConfig()
        self.pattern_weights = pattern_weights or {}
        self.units = [u for u in registry.series_units()]
        self.checker = TypeChecker(registry, max_nodes=self.cfg.max_nodes + 20, max_depth=self.cfg.max_depth + 4)

    # --------------------------------------------------------------- literals
    def window(self, min_w: int) -> int:
        grid = [w for w in self.reg.window_grid if min_w <= w <= self.reg.max_window]
        if not grid:
            return max(min_w, 2)
        idx = self.rng.integers(0, len(grid))
        return int(grid[idx])

    def literal(self, t: Type, sig: Sig | None = None) -> Node:
        k = t.kind
        if k == WINDOW:
            return Node("#window", (), self.window(sig.min_window if sig else 2))
        if k == QUANT:
            return Node("#quant", (), float(self.rng.choice([0.1, 0.2, 0.25, 0.5, 0.75, 0.8, 0.9])))
        if k == TF:
            return Node("#tf", (), str(self.rng.choice(list(self.reg.htf))))
        if k == REGIME:
            return Node("#regime", (), int(self.rng.integers(0, self.reg.n_regimes)))
        if k == PATTERN:
            ids = list(self.reg.pattern_ids)
            w = np.array([self.pattern_weights.get(p, 1.0) for p in ids], dtype=float)
            return Node("#pattern", (), str(self.rng.choice(ids, p=w / w.sum())))
        if k == FLOAT:
            return Node("#float", (), 0.0)
        raise ValueError(f"no literal for {t}")

    # ----------------------------------------------------------------- trees
    FORBIDDEN_IN_TF = frozenset({"mtf", "regime", "pattern"})

    def _candidates(self, t: Type, depth: int, inside_tf: bool = False) -> list[Sig]:
        out = []
        for s in self.reg.returning(t):
            if s.category in ("compare", "logic", "signal"):
                continue
            if inside_tf and s.category in self.FORBIDDEN_IN_TF:
                continue
            if s.name in self.cfg.exclude_names:
                continue
            if self.reg.sig_min_depth(s) <= depth:
                out.append(s)
        return out

    def _pick_sig(self, cands: list[Sig], depth: int) -> Sig:
        by_name: dict[str, list[Sig]] = {}
        for s in cands:
            by_name.setdefault(s.name, []).append(s)
        names = sorted(by_name)
        w = []
        for nm in names:
            s0 = by_name[nm][0]
            base = self.cfg.name_weights.get(s0.category, 1.0)
            leafish = all(a.kind in LITERAL_KINDS for a in s0.args)
            if leafish:
                base *= 1.0 + 2.0 * self.cfg.p_leaf
            elif depth <= 2:
                base *= 0.3
            w.append(base)
        w = np.array(w, dtype=float)
        nm = names[int(self.rng.choice(len(names), p=w / w.sum()))]
        variants = by_name[nm]
        if len(variants) == 1:
            return variants[0]
        vw = []
        for s in variants:
            units = [a.unit for a in s.args if a.kind == SERIES]
            vw.append(float(np.prod([UNIT_WEIGHTS.get(u, 0.25) for u in units])) if units else 1.0)
        vw = np.array(vw)
        return variants[int(self.rng.choice(len(variants), p=vw / vw.sum()))]

    def tree(self, t: Type, depth: int, inside_tf: bool = False) -> Node:
        if t.kind in LITERAL_KINDS:
            return self.literal(t)
        if t.kind == BOOLEAN:
            return self.condition(depth, inside_tf=inside_tf)
        cands = self._candidates(t, depth, inside_tf)
        if not cands:
            cands = self._candidates(t, 10 ** 6, inside_tf)
            if not cands:
                raise DSLTypeError(f"cannot generate {t}")
        s = self._pick_sig(cands, depth)
        sub_tf = inside_tf or s.category == "mtf"
        args = []
        for a in s.args:
            if a.kind in LITERAL_KINDS:
                args.append(self.literal(a, s))
            else:
                args.append(self.tree(a, depth - 1, sub_tf))
        return Node(s.name, tuple(args), None, s.key)

    # ------------------------------------------------------------ conditions
    def _cmp(self, name: str, lhs: Node, rhs: Node, const: bool) -> Node:
        if const:
            key = f"{name}:const"
        else:
            key = f"{name}:{node_type(lhs).unit}"
        return Node(name, (lhs, rhs), None, key)

    def comparison(self, depth: int, inside_tf: bool = False) -> Node | None:
        if self.rng.random() < self.cfg.p_series_compare:
            units = [u for u in self.units if u in ("price", "volume", "log_price")] or self.units
            u = str(self.rng.choice(units))
            lhs = self.tree(S(u), max(1, depth - 1), inside_tf)
            rhs = self.tree(S(u), max(1, depth - 1), inside_tf)
            if lhs.text == rhs.text:
                return None
            op = "GT" if self.rng.random() < 0.75 else "CROSS_ABOVE"
            return self._cmp(op, lhs, rhs, False)
        lhs = self.tree(T_DIMLESS, max(1, depth - 1), inside_tf)
        r = self.rng.random()
        op = "GT" if r < 0.42 else ("LT" if r < 0.84 else ("CROSS_ABOVE" if r < 0.92 else "CROSS_BELOW"))
        thr = self.sampler.sample(lhs, op if op in ("GT", "LT") else "X")
        if thr is None:
            return None
        return self._cmp(op, lhs, Node("#float", (), thr), True)

    def condition(self, depth: int, _tries: int = 8, inside_tf: bool = False) -> Node:
        last = None
        for _ in range(_tries):
            r = self.rng.random()
            node = None
            if inside_tf:
                r = 1.0  # plain comparisons only inside tf()
            if r < self.cfg.p_regime and self.reg.n_regimes > 0:
                node = Node("regime_is", (Node("#regime", (), int(self.rng.integers(0, self.reg.n_regimes))),), None,
                            "regime_is")
            elif r < self.cfg.p_regime + self.cfg.p_pattern and self.reg.pattern_ids:
                pat = self.literal(Type(PATTERN))
                lhs = Node("pattern_distance", (pat,), None, "pattern_distance")
                thr = self.sampler.sample(lhs, "LT")
                if thr is not None:
                    node = Node("LT", (lhs, Node("#float", (), thr)), None, "LT:const")
            elif r < self.cfg.p_regime + self.cfg.p_pattern + self.cfg.p_temporal and depth >= 3:
                inner = self.comparison(depth - 1, inside_tf)
                if inner is not None:
                    name = str(self.rng.choice(["was", "held"]))
                    node = Node(name, (inner, Node("#window", (), int(self.rng.choice([2, 3, 5, 8])))), None, name)
            if node is None:
                node = self.comparison(depth, inside_tf)
            if node is None:
                continue
            try:
                rate = self.sampler.fire_rate(node)
            except (KeyError, ValueError, RuntimeError):
                continue
            last = node
            if self.cfg.min_fire_rate <= rate <= self.cfg.max_fire_rate:
                return node
        if last is None:
            lhs = Node("return", (Node("#window", (), 1),), None, "return")
            last = Node("GT", (lhs, Node("#float", (), 0.0)), None, "GT:const")
        return last

    def _logic(self, name: str, clauses: list[Node]) -> Node:
        if len(clauses) == 1:
            return clauses[0]
        clauses = clauses[:MAX_LOGIC_ARITY]
        return Node(name, tuple(clauses), None, f"{name}/{len(clauses)}")

    def rule(self, kind: str = "entry") -> Node:
        d = self.cfg.max_depth - 1
        if kind == "entry":
            k = 1 + int(self.rng.choice(len(self.cfg.entry_clauses), p=np.array(self.cfg.entry_clauses)))
            body = self._logic("AND", [self.condition(d) for _ in range(k)])
            if self.rng.random() < self.cfg.p_onset:
                return Node("ONSET", (body,), None, "ONSET")
            return Node("WHEN", (body,), None, "WHEN")
        k = 1 + int(self.rng.choice(len(self.cfg.exit_clauses), p=np.array(self.cfg.exit_clauses)))
        body = self._logic("OR", [self.condition(d) for _ in range(k)])
        return Node("WHEN", (body,), None, "WHEN")

    def strategy(self, direction: str | None = None) -> Strategy:
        if direction is None:
            dirs = list(self.cfg.directions)
            w = np.array(self.cfg.direction_weights[: len(dirs)], dtype=float)
            direction = str(self.rng.choice(dirs, p=w / w.sum()))
        kw: dict = {"direction": direction}
        need_hold = False
        for side in ("long", "short"):
            if direction not in (side, "long_short"):
                continue
            kw[f"{side}_entry"] = self.rule("entry")
            if self.rng.random() < self.cfg.p_exit_rule:
                kw[f"{side}_exit"] = self.rule("exit")
            else:
                need_hold = True
        if need_hold or self.rng.random() < self.cfg.p_max_hold:
            kw["max_hold"] = int(self.rng.choice(self.cfg.max_hold_grid))
        return Strategy(**kw)

    def finalize(self, st: Strategy) -> Strategy | None:
        try:
            return self.checker.check_strategy(st)
        except DSLTypeError:
            return None
        except (ValueError, KeyError):
            return None


class Variation:
    """Typed mutation and crossover operators. Every operator returns a new Strategy or None."""

    def __init__(self, gen: TypedGenerator, rng: np.random.Generator):
        self.gen = gen
        self.reg = gen.reg
        self.rng = rng
        self.sampler = gen.sampler

    # ------------------------------------------------------------- helpers
    def _slots(self, st: Strategy, entries_only: bool = False) -> list[str]:
        names = [s for s, _ in st.slot_items()]
        if entries_only:
            names = [s for s in names if s.endswith("entry")]
        return names

    def _pick(self, items: list):
        return items[int(self.rng.integers(0, len(items)))] if items else None

    # ----------------------------------------------------------- operators
    def subtree(self, st: Strategy) -> Strategy | None:
        slot = self._pick(self._slots(st))
        root = st.slot(slot)
        cands = [(p, n, t) for p, n, t in typed_paths(root) if p and not n.is_literal and t.kind in (BOOLEAN, SERIES)]
        pick = self._pick(cands)
        if pick is None:
            return None
        path, _, t = pick
        budget = max(2, self.gen.cfg.max_depth - len(path))
        in_tf = any(get_at(root, path[:k]).op == "tf" for k in range(len(path)))
        new = self.gen.condition(budget, inside_tf=in_tf) if t.kind == BOOLEAN else self.gen.tree(t, budget, in_tf)
        return st.replace(**{slot: replace_at(root, path, new)})

    def point(self, st: Strategy) -> Strategy | None:
        slot = self._pick(self._slots(st))
        root = st.slot(slot)
        cands = []
        for p, n, _ in typed_paths(root):
            if n.is_literal or n.op in ("WHEN", "ONSET"):
                continue
            s = SIG_BY_KEY[n.sig]
            alts = [a for a in self.reg.sigs if a.args == s.args and a.ret == s.ret and a.name != s.name
                    and a.category == s.category and a.name not in self.gen.cfg.exclude_names]
            if alts:
                cands.append((p, n, alts))
        pick = self._pick(cands)
        if pick is None:
            return None
        path, n, alts = pick
        alt = self._pick(alts)
        return st.replace(**{slot: replace_at(root, path, Node(alt.name, n.args, None, alt.key))})

    def window(self, st: Strategy) -> Strategy | None:
        slot = self._pick(self._slots(st))
        root = st.slot(slot)
        cands = [(p, n) for p, n in iter_nodes(root) if n.op == "#window"]
        pick = self._pick(cands)
        if pick is None:
            return None
        path, n = pick
        parent = get_at(root, path[:-1])
        lo = SIG_BY_KEY[parent.sig].min_window if parent.sig else 1
        grid = sorted(set(w for w in self.reg.window_grid if lo <= w <= self.reg.max_window) | {int(n.value)})
        i = grid.index(int(n.value))
        step = int(self.rng.choice([-2, -1, 1, 2]))
        j = int(np.clip(i + step, 0, len(grid) - 1))
        if j == i:
            return None
        return st.replace(**{slot: replace_at(root, path, Node("#window", (), grid[j]))})

    def threshold(self, st: Strategy) -> Strategy | None:
        slot = self._pick(self._slots(st))
        root = st.slot(slot)
        cands = []
        for p, n in iter_nodes(root):
            if n.op == "#float" and p:
                parent = get_at(root, p[:-1])
                if parent.args and not parent.args[0].is_literal:
                    cands.append((p, n, parent.args[0]))
        pick = self._pick(cands)
        if pick is None:
            return None
        path, n, lhs = pick
        q = self.sampler.quantile_of(lhs, float(n.value))
        v = self.sampler.at_quantile(lhs, q + float(self.rng.normal(0, 0.08)))
        if v is None or v == n.value:
            return None
        return st.replace(**{slot: replace_at(root, path, Node("#float", (), v))})

    def signal_type(self, st: Strategy) -> Strategy | None:
        slot = self._pick(self._slots(st, entries_only=True))
        if slot is None:
            return None
        root = st.slot(slot)
        new_op = "ONSET" if root.op == "WHEN" else "WHEN"
        return st.replace(**{slot: Node(new_op, root.args, None, new_op)})

    def add_condition(self, st: Strategy) -> Strategy | None:
        slot = self._pick(self._slots(st, entries_only=True) or self._slots(st))
        root = st.slot(slot)
        body = root.args[0]
        new = self.gen.condition(self.gen.cfg.max_depth - 2)
        name = "AND" if slot.endswith("entry") else "OR"
        if body.op == name and len(body.args) < MAX_LOGIC_ARITY:
            nb = Node(name, (*body.args, new), None, f"{name}/{len(body.args) + 1}")
        elif body.op == name:
            return None
        else:
            nb = Node(name, (body, new), None, f"{name}/2")
        return st.replace(**{slot: Node(root.op, (nb,), None, root.op)})

    def remove_condition(self, st: Strategy) -> Strategy | None:
        cands = [s for s in self._slots(st) if st.slot(s).args[0].op in ("AND", "OR")]
        slot = self._pick(cands)
        if slot is None:
            return None
        root = st.slot(slot)
        body = root.args[0]
        k = int(self.rng.integers(0, len(body.args)))
        rest = body.args[:k] + body.args[k + 1:]
        nb = rest[0] if len(rest) == 1 else Node(body.op, rest, None, f"{body.op}/{len(rest)}")
        return st.replace(**{slot: Node(root.op, (nb,), None, root.op)})

    def hoist(self, st: Strategy) -> Strategy | None:
        slot = self._pick(self._slots(st))
        root = st.slot(slot)
        paths = typed_paths(root)
        cands = []
        for p, n, t in paths:
            if not p or t.kind != BOOLEAN or n.is_literal:
                continue
            desc = [(q, m) for q, m, tt in paths if len(q) > len(p) and q[:len(p)] == p and tt.kind == BOOLEAN]
            if desc:
                cands.append((p, desc))
        pick = self._pick(cands)
        if pick is None:
            return None
        p, desc = pick
        _, m = self._pick(desc)
        return st.replace(**{slot: replace_at(root, p, m)})

    def exit_change(self, st: Strategy) -> Strategy | None:
        r = self.rng.random()
        sides = [s for s in ("long", "short") if st.direction in (s, "long_short")]
        side = self._pick(sides)
        if r < 0.4:
            return st.replace(**{f"{side}_exit": self.gen.rule("exit")})
        if r < 0.6 and st.slot(f"{side}_exit") is not None:
            mh = st.max_hold or int(self.rng.choice(self.gen.cfg.max_hold_grid))
            return st.replace(**{f"{side}_exit": None}, max_hold=mh)
        if r < 0.85:
            grid = list(self.gen.cfg.max_hold_grid)
            return st.replace(max_hold=int(self.rng.choice(grid)))
        need = any(st.slot(f"{s}_exit") is None for s in sides)
        if st.max_hold is not None and not need:
            return st.replace(max_hold=None)
        return None

    def direction(self, st: Strategy) -> Strategy | None:
        d = st.direction
        if d == "long":
            if self.rng.random() < 0.5 and "short" in self.gen.cfg.directions:
                return Strategy("short", short_entry=st.long_entry, short_exit=st.long_exit, max_hold=st.max_hold,
                                stop_loss=st.stop_loss, take_profit=st.take_profit)
            if "long_short" in self.gen.cfg.directions:
                return st.replace(direction="long_short", short_entry=self.gen.rule("entry"),
                                  short_exit=self.gen.rule("exit"))
        if d == "short":
            if "long" in self.gen.cfg.directions:
                return Strategy("long", long_entry=st.short_entry, long_exit=st.short_exit, max_hold=st.max_hold,
                                stop_loss=st.stop_loss, take_profit=st.take_profit)
        if d == "long_short":
            if self.rng.random() < 0.5 and "long" in self.gen.cfg.directions:
                return Strategy("long", long_entry=st.long_entry, long_exit=st.long_exit, max_hold=st.max_hold,
                                stop_loss=st.stop_loss, take_profit=st.take_profit)
            if "short" in self.gen.cfg.directions:
                return Strategy("short", short_entry=st.short_entry, short_exit=st.short_exit, max_hold=st.max_hold,
                                stop_loss=st.stop_loss, take_profit=st.take_profit)
        return None

    def crossover(self, a: Strategy, b: Strategy) -> Strategy | None:
        r = self.rng.random()
        if r < 0.25 and a.direction == b.direction:
            # exchange exit logic
            kw = {s: b.slot(s) for s in ("long_exit", "short_exit")}
            return a.replace(**kw, max_hold=b.max_hold if (b.max_hold or not all(kw.values())) else a.max_hold)
        slot_a = self._pick(self._slots(a))
        root_a = a.slot(slot_a)
        cands_a = [(p, n, t) for p, n, t in typed_paths(root_a) if p and not n.is_literal
                   and t.kind in (BOOLEAN, SERIES)]
        if not cands_a:
            return None
        path, _, t = self._pick(cands_a)
        donors = []
        for sb, rb in b.slot_items():
            donors.extend(n for p, n, tt in typed_paths(rb) if p and not n.is_literal and tt == t)
        donor = self._pick(donors)
        if donor is None:
            return None
        return a.replace(**{slot_a: replace_at(root_a, path, donor)})

    def apply(self, op: str, st: Strategy) -> Strategy | None:
        return getattr(self, op)(st)


def feature_names_in(st: Strategy) -> list[str]:
    names = set()
    for _, root in st.slot_items():
        for _, n in iter_nodes(root):
            if n.op in FEATURE_CATEGORIES:
                names.add(n.op)
    return sorted(names)


__all__ = ["GenConfig", "ThresholdSampler", "TypedGenerator", "Variation", "typed_paths", "node_type",
           "STRUCTURAL_OPS", "PARAMETRIC_OPS", "OP_PHASE", "T_BOOL", "T_FLOAT", "SIGNAL"]
