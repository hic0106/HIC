"""Complexity score and numeric-parameter access (used by sensitivity analysis and walk-forward refits)."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .nodes import Node, Strategy, get_at, iter_nodes, replace_at
from .registry import SIG_BY_KEY, FEATURE_CATEGORIES

PARAM_LITERALS = {"#window": "window", "#float": "threshold", "#quant": "quantile"}
RISK_PARAMS = ("max_hold", "stop_loss", "take_profit")


@dataclass
class Complexity:
    nodes: int
    parameters: int
    depth: int
    operators: int
    score: float

    def to_dict(self) -> dict:
        return asdict(self)


def _visible(node: Node):
    """Iterate nodes as they appear in text (WHEN wrappers are implicit)."""
    for path, n in iter_nodes(node):
        if n.op == "WHEN":
            continue
        yield path, n


def _depth(node: Node) -> int:
    if node.op == "WHEN":
        return _depth(node.args[0])
    if not node.args:
        return 1
    return 1 + max(_depth(a) for a in node.args)


def complexity(st: Strategy, w_params: float = 0.5, w_depth: float = 0.5) -> Complexity:
    nodes = params = ops = 0
    d = 0
    for _, root in st.slot_items():
        d = max(d, _depth(root))
        for _, n in _visible(root):
            nodes += 1
            if n.op in PARAM_LITERALS:
                params += 1
            elif not n.is_literal and n.args:
                ops += 1
    params += sum(1 for r in RISK_PARAMS if getattr(st, r) is not None)
    score = nodes + w_params * params + w_depth * d
    return Complexity(nodes=nodes, parameters=params, depth=d, operators=ops, score=float(score))


@dataclass(frozen=True)
class Param:
    path: str
    kind: str
    value: float
    context: str
    name: str
    min_value: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def parameters(st: Strategy) -> list[Param]:
    out: list[Param] = []
    used: dict[str, int] = {}
    for slot, root in st.slot_items():
        for path, n in iter_nodes(root):
            if n.op not in PARAM_LITERALS:
                continue
            parent = get_at(root, path[:-1])
            psig = SIG_BY_KEY.get(parent.sig) if parent.sig else None
            kind = PARAM_LITERALS[n.op]
            min_v = float(psig.min_window) if (psig is not None and kind == "window") else None
            if parent.op in ("GT", "LT", "CROSS_ABOVE", "CROSS_BELOW") and parent.args:
                ctx_node = parent.args[0]
                base = f"{slot}.{ctx_node.op}.{kind}"
            else:
                base = f"{slot}.{parent.op}.{kind}"
            k = used.get(base, 0)
            used[base] = k + 1
            name = base if k == 0 else f"{base}{k + 1}"
            out.append(Param(path=f"{slot}/" + "/".join(map(str, path)), kind=kind, value=n.value,
                             context=parent.text, name=name, min_value=min_v))
    for r in RISK_PARAMS:
        v = getattr(st, r)
        if v is not None:
            out.append(Param(path=r, kind=r, value=v, context=r.upper(), name=r,
                             min_value=1.0 if r == "max_hold" else None))
    # disambiguate duplicate names after renumbering (first occurrence gets suffix-less name)
    return out


def set_param(st: Strategy, path: str, value: float, max_window: int = 250) -> Strategy:
    if path in RISK_PARAMS:
        if path == "max_hold":
            return st.replace(max_hold=int(max(1, min(5000, round(value)))))
        return st.replace(**{path: float(min(0.99, max(1e-4, value)))})
    slot, _, rest = path.partition("/")
    idx = tuple(int(x) for x in rest.split("/")) if rest else ()
    root = st.slot(slot)
    old = get_at(root, idx)
    if old.op == "#window":
        parent = get_at(root, idx[:-1])
        psig = SIG_BY_KEY.get(parent.sig) if parent.sig else None
        lo = psig.min_window if psig is not None else 1
        new = Node("#window", (), int(max(lo, min(max_window, round(value)))))
    elif old.op == "#quant":
        new = Node("#quant", (), float(f"{min(0.99, max(0.01, value)):.6g}"))
    elif old.op == "#float":
        new = Node("#float", (), float(f"{value:.6g}"))
    else:
        raise ValueError(f"path {path} is not a numeric parameter")
    return st.replace(**{slot: replace_at(root, idx, new)})


def primitives_used(st: Strategy, slots: tuple[str, ...] | None = None) -> list[str]:
    names = set()
    for slot, root in st.slot_items():
        if slots and slot not in slots:
            continue
        for _, n in iter_nodes(root):
            if n.op in FEATURE_CATEGORIES:
                names.add(n.op)
    return sorted(names)


def max_window(st: Strategy, slots: tuple[str, ...] | None = None) -> int:
    mx = 0
    for slot, root in st.slot_items():
        if slots and slot not in slots:
            continue
        for _, n in iter_nodes(root):
            if n.op == "#window":
                mx = max(mx, int(n.value))
    return mx
