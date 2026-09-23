"""Structural families of strategies (for research memory, reflection and diversity)."""

from __future__ import annotations

from ..dsl.nodes import Node, Strategy, iter_nodes
from ..dsl.registry import FEATURE_CATEGORIES

_KEEP_LITERALS = {"#tf", "#regime", "#pattern"}


def skeleton(node: Node) -> str:
    """Expression text with numeric parameters removed: GT(volume_zscore(#), #)."""
    if node.is_literal:
        return f'"{node.value}"' if node.op in ("#tf", "#pattern") else (
            str(node.value) if node.op in _KEEP_LITERALS else "#")
    if node.op == "WHEN":
        return skeleton(node.args[0])
    if not node.args:
        return node.op
    return f"{node.op}({','.join(skeleton(a) for a in node.args)})"


def clauses(node: Node) -> list[Node]:
    body = node.args[0] if node.op in ("WHEN", "ONSET") else node
    if body.op in ("AND", "OR"):
        return list(body.args)
    return [body]


def family(st: Strategy) -> str:
    parts = []
    for slot in ("long_entry", "short_entry"):
        root = st.slot(slot)
        if root is None:
            continue
        sk = sorted(skeleton(c) for c in clauses(root))
        trig = "onset" if root.op == "ONSET" else "level"
        parts.append(f"{slot.split('_')[0]}[{trig}]:" + " & ".join(sk))
    return " | ".join(parts)


def categories(st: Strategy, slots: tuple[str, ...] = ("long_entry", "short_entry")) -> list[str]:
    cats = set()
    for slot in slots:
        root = st.slot(slot)
        if root is None:
            continue
        for _, n in iter_nodes(root):
            c = FEATURE_CATEGORIES.get(n.op)
            if c and c != "price" or n.op in ("return", "log_return"):
                cats.add(c or "price")
            if n.op == "tf":
                cats.add("multi_timeframe")
    return sorted(cats)


def group(st: Strategy) -> str:
    """Coarse family used by the reflection loop, e.g. 'long:candle+volume'."""
    cats = categories(st) or ["price"]
    return f"{st.direction}:{'+'.join(cats)}"
