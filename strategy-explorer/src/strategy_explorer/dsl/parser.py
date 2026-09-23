"""Tokenizer and parser for the Strategy DSL.

Expression grammar::

    expr    := NUMBER | STRING | IDENT [ "(" [ expr ("," expr)* ] ")" ]
    NUMBER  := -?digits[.digits][e[+-]digits]
    STRING  := "..." | '...'

Strategy file::

    DIRECTION: long | short | long_short        (optional, inferred)
    LONG_ENTRY:  <boolean or signal expression>
    LONG_EXIT:   <expression>
    SHORT_ENTRY: <expression>
    SHORT_EXIT:  <expression>
    MAX_HOLD:    <int bars>
    STOP_LOSS:   <fraction, e.g. 0.05>          (checked on bar close)
    TAKE_PROFIT: <fraction>

Lines starting with ``#`` are comments. Expressions may span several lines.
"""

from __future__ import annotations

import re

from .nodes import DIRECTIONS, Node, Strategy
from .types import DSLSyntaxError

_TOKEN = re.compile(
    r"""\s*(?:
        (?P<num>-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)
      | (?P<str>"[^"]*"|'[^']*')
      | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
      | (?P<punct>[(),])
    )""",
    re.VERBOSE,
)

SECTION_KEYS = ("DIRECTION", "LONG_ENTRY", "LONG_EXIT", "SHORT_ENTRY", "SHORT_EXIT", "MAX_HOLD", "STOP_LOSS",
                "TAKE_PROFIT")
_SECTION_RE = re.compile(r"^\s*(" + "|".join(SECTION_KEYS) + r")\s*:\s*(.*)$", re.IGNORECASE)


def tokenize(text: str) -> list[tuple[str, str]]:
    pos = 0
    out: list[tuple[str, str]] = []
    text = text.strip()
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m or m.end() == pos:
            raise DSLSyntaxError(f"unexpected character at {pos}: {text[pos:pos + 20]!r}")
        pos = m.end()
        kind = m.lastgroup
        out.append((kind, m.group(kind)))
        # allow trailing whitespace
        while pos < len(text) and text[pos].isspace():
            pos += 1
    return out


class _Parser:
    def __init__(self, tokens: list[tuple[str, str]]):
        self.toks = tokens
        self.i = 0

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else (None, None)

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def expect(self, value: str):
        kind, v = self.take()
        if v != value:
            raise DSLSyntaxError(f"expected {value!r}, got {v!r}")

    def expr(self) -> Node:
        kind, v = self.take()
        if kind == "num":
            is_int = re.fullmatch(r"-?\d+", v) is not None
            return Node("#num", (), int(v) if is_int else float(v))
        if kind == "str":
            return Node("#str", (), v[1:-1])
        if kind == "ident":
            if self.peek()[1] == "(":
                self.take()
                args: list[Node] = []
                if self.peek()[1] != ")":
                    while True:
                        args.append(self.expr())
                        k2, v2 = self.peek()
                        if v2 == ",":
                            self.take()
                            continue
                        break
                self.expect(")")
                return Node(v, tuple(args))
            return Node(v, ())
        raise DSLSyntaxError(f"unexpected token {v!r}")


def parse_expr(text: str) -> Node:
    toks = tokenize(text)
    if not toks:
        raise DSLSyntaxError("empty expression")
    p = _Parser(toks)
    node = p.expr()
    if p.i != len(toks):
        raise DSLSyntaxError(f"trailing tokens after expression: {toks[p.i:][:5]}")
    return node


def split_sections(text: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0] if raw.strip().startswith("#") else raw
        if not line.strip():
            continue
        m = _SECTION_RE.match(line)
        if m:
            current = m.group(1).upper()
            if current in sections:
                raise DSLSyntaxError(f"duplicate section {current}")
            sections[current] = [m.group(2)]
        else:
            if current is None:
                raise DSLSyntaxError(f"text outside of a section: {line.strip()[:40]!r}")
            sections[current].append(line)
    return {k: " ".join(v).strip() for k, v in sections.items()}


def parse_strategy(text: str) -> Strategy:
    """Parse strategy text into an *untyped* Strategy (use typecheck.check_strategy next)."""
    secs = split_sections(text)
    if not secs:
        raise DSLSyntaxError("no strategy sections found")
    slots = {}
    for key in ("LONG_ENTRY", "LONG_EXIT", "SHORT_ENTRY", "SHORT_EXIT"):
        if key in secs and secs[key]:
            slots[key.lower()] = parse_expr(secs[key])
    direction = secs.get("DIRECTION", "").strip().lower() or None
    if direction is None:
        has_long = "long_entry" in slots
        has_short = "short_entry" in slots
        direction = "long_short" if has_long and has_short else ("short" if has_short else "long")
    if direction not in DIRECTIONS:
        raise DSLSyntaxError(f"DIRECTION must be one of {DIRECTIONS}")

    def num(key, cast):
        if key not in secs or secs[key] == "":
            return None
        try:
            return cast(secs[key])
        except ValueError as exc:
            raise DSLSyntaxError(f"{key} must be a number") from exc

    max_hold = num("MAX_HOLD", lambda s: int(float(s)))
    return Strategy(
        direction=direction,
        long_entry=slots.get("long_entry"),
        long_exit=slots.get("long_exit"),
        short_entry=slots.get("short_entry"),
        short_exit=slots.get("short_exit"),
        max_hold=max_hold,
        stop_loss=num("STOP_LOSS", float),
        take_profit=num("TAKE_PROFIT", float),
    )
