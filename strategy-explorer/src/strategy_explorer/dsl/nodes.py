"""Expression-tree nodes and the Strategy container, with canonical printing and hashing."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Iterator

from ..util import short_hash

LITERAL_OPS = frozenset({"#num", "#str", "#float", "#window", "#quant", "#tf", "#regime", "#pattern"})
TERMINAL_NAMES = frozenset({
    "open", "high", "low", "close", "volume", "quote_volume", "number_of_trades", "taker_buy_volume",
    "funding_rate", "open_interest", "long_short_ratio",
})
SLOTS = ("long_entry", "long_exit", "short_entry", "short_exit")
DIRECTIONS = ("long", "short", "long_short")


def fmt_number(v: Any) -> str:
    if isinstance(v, bool):
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    f = float(v)
    if f == 0:
        return "0"
    if f.is_integer() and abs(f) < 1e15:
        return str(int(f))
    return f"{f:.6g}"


@dataclass(frozen=True)
class Node:
    op: str
    args: tuple["Node", ...] = ()
    value: Any = None
    sig: str | None = field(default=None, compare=False, hash=False, repr=False)

    @property
    def is_literal(self) -> bool:
        return self.op in LITERAL_OPS

    @property
    def text(self) -> str:
        t = self.__dict__.get("_text")
        if t is None:
            t = to_text(self)
            object.__setattr__(self, "_text", t)
        return t

    def with_args(self, args: tuple["Node", ...]) -> "Node":
        """Same operator with new children; keeps the resolved signature (callers keep types compatible)."""
        return Node(self.op, tuple(args), self.value, self.sig)

    def __str__(self) -> str:
        return self.text


def lit(op: str, value: Any) -> Node:
    return Node(op, (), value)


def to_text(node: Node) -> str:
    op = node.op
    if op in ("#num", "#float", "#quant", "#window", "#regime"):
        return fmt_number(node.value)
    if op in ("#str", "#tf", "#pattern"):
        return f'"{node.value}"'
    if op == "WHEN":
        return to_text(node.args[0])
    if not node.args and op in TERMINAL_NAMES:
        return op
    return f"{op}({', '.join(to_text(a) for a in node.args)})"


def pretty(node: Node, indent: int = 4, width: int = 72, level: int = 0) -> str:
    one = to_text(node)
    pad = " " * (indent * level)
    if len(pad) + len(one) <= width or not node.args or node.is_literal:
        return pad + one
    if node.op == "WHEN":
        return pretty(node.args[0], indent, width, level)
    inner = ",\n".join(pretty(a, indent, width, level + 1) for a in node.args)
    return f"{pad}{node.op}(\n{inner}\n{pad})"


# ------------------------------------------------------------------ traversal


def iter_nodes(node: Node, path: tuple[int, ...] = ()) -> Iterator[tuple[tuple[int, ...], Node]]:
    yield path, node
    for i, a in enumerate(node.args):
        yield from iter_nodes(a, path + (i,))


def get_at(node: Node, path: tuple[int, ...]) -> Node:
    for i in path:
        node = node.args[i]
    return node


def replace_at(node: Node, path: tuple[int, ...], new: Node) -> Node:
    if not path:
        return new
    i = path[0]
    args = list(node.args)
    args[i] = replace_at(args[i], path[1:], new)
    return node.with_args(tuple(args))


def depth(node: Node) -> int:
    if not node.args:
        return 1
    return 1 + max(depth(a) for a in node.args)


def count_nodes(node: Node) -> int:
    return 1 + sum(count_nodes(a) for a in node.args)


def contains_op(node: Node, ops: set[str] | frozenset[str]) -> bool:
    return any(n.op in ops for _, n in iter_nodes(node))


# ----------------------------------------------------------- canonical form


def _is_numeric_literal(n: Node) -> bool:
    return n.op in ("#num", "#float")


def canonicalize(node: Node) -> Node:
    """Algebraic normal form used for hashing and duplicate detection.

    * AND/OR are flattened, de-duplicated and sorted (commutative, associative, idempotent)
    * NOT(NOT(x)) -> x
    * LT(a, b) with two series -> GT(b, a);  CROSS_BELOW(a, b) with two series -> CROSS_ABOVE(b, a)
    """
    if node.is_literal:
        return Node(node.op, (), node.value)
    args = tuple(canonicalize(a) for a in node.args)
    op = node.op
    if op in ("AND", "OR"):
        flat: list[Node] = []
        for a in args:
            flat.extend(a.args if a.op == op else (a,))
        uniq = {a.text: a for a in flat}
        ordered = tuple(uniq[k] for k in sorted(uniq))
        if len(ordered) == 1:
            return ordered[0]
        return Node(op, ordered)
    if op == "NOT" and args and args[0].op == "NOT":
        return args[0].args[0]
    if op == "LT" and len(args) == 2 and not _is_numeric_literal(args[1]):
        return Node("GT", (args[1], args[0]))
    if op == "CROSS_BELOW" and len(args) == 2 and not _is_numeric_literal(args[1]):
        return Node("CROSS_ABOVE", (args[1], args[0]))
    return Node(op, args, node.value)


# ------------------------------------------------------------------ strategy


@dataclass(frozen=True)
class Strategy:
    direction: str
    long_entry: Node | None = None
    long_exit: Node | None = None
    short_entry: Node | None = None
    short_exit: Node | None = None
    max_hold: int | None = None
    stop_loss: float | None = None
    take_profit: float | None = None

    def slot(self, name: str) -> Node | None:
        return getattr(self, name)

    def slot_items(self) -> list[tuple[str, Node]]:
        return [(s, getattr(self, s)) for s in SLOTS if getattr(self, s) is not None]

    def replace(self, **kw: Any) -> "Strategy":
        return dataclasses.replace(self, **kw)

    @property
    def sides(self) -> tuple[int, ...]:
        return {"long": (1,), "short": (-1,), "long_short": (1, -1)}[self.direction]

    def to_text(self, pretty_print: bool = False) -> str:
        lines = [f"DIRECTION: {self.direction}"]
        for s, node in self.slot_items():
            if pretty_print:
                body = pretty(node, level=1)
                lines.append(f"{s.upper()}:\n{body}")
            else:
                lines.append(f"{s.upper()}: {to_text(node)}")
        if self.max_hold is not None:
            lines.append(f"MAX_HOLD: {int(self.max_hold)}")
        if self.stop_loss is not None:
            lines.append(f"STOP_LOSS: {fmt_number(self.stop_loss)}")
        if self.take_profit is not None:
            lines.append(f"TAKE_PROFIT: {fmt_number(self.take_profit)}")
        return "\n".join(lines)

    @property
    def text(self) -> str:
        t = self.__dict__.get("_text")
        if t is None:
            t = self.to_text()
            object.__setattr__(self, "_text", t)
        return t

    @property
    def hash(self) -> str:
        return short_hash(self.text, 16)

    def canonical(self) -> "Strategy":
        kw = {s: (canonicalize(n) if n is not None else None) for s in SLOTS for n in [getattr(self, s)]}
        return self.replace(**kw)
