"""LLM clients.

The LLM is only a *proposer*: every response is parsed into DSL text and then
compiled, backtested and statistically evaluated like any other candidate.
Nothing an LLM says about a strategy enters its score.

Backends
--------
* ``anthropic`` - Claude via the official ``anthropic`` SDK (optional dependency).
  Structured JSON output (``output_config.format``), adaptive thinking, a cached
  static system prompt, and server-side refusal fallbacks (``fallbacks="default"``).
* ``offline``   - no network; the hypothesis engine uses deterministic templates.
* ``replay``    - returns previously recorded responses by prompt hash (reproducible reruns).

Every call (prompt, response, model, purpose) is written to the ``llm_calls`` table.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Protocol

from ..ledger.db import LedgerDB
from ..util import sha256_text, stable_json

DEFAULT_MODEL = "claude-opus-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMUnavailable(RuntimeError):
    pass


@dataclass
class LLMRequest:
    purpose: str
    system: str
    user: str
    schema: dict
    images: list[bytes] = field(default_factory=list)

    def prompt_hash(self, model: str) -> str:
        img = [sha256_text(base64.b64encode(b).decode()) for b in self.images]
        return sha256_text(stable_json({"m": model, "p": self.purpose, "s": self.system, "u": self.user,
                                        "schema": self.schema, "img": img}))


@dataclass
class LLMResponse:
    data: dict | None
    text: str
    model: str
    backend: str
    stop_reason: str | None = None
    refused: bool = False
    usage: dict = field(default_factory=dict)
    cached: bool = False


class LLMClient(Protocol):
    backend: str
    model: str

    def complete_json(self, req: LLMRequest) -> LLMResponse: ...


class AnthropicClient:
    """Claude client. Requires ``pip install anthropic`` and credentials (ANTHROPIC_API_KEY or ``ant auth login``)."""

    backend = "anthropic"

    def __init__(self, model: str = DEFAULT_MODEL, effort: str = "high", max_tokens: int = 16000,
                 timeout: float = 600.0, max_retries: int = 3, use_fallbacks: bool = True):
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise LLMUnavailable("the 'anthropic' package is not installed: pip install 'ai-strategy-explorer[llm]'") \
                from exc
        self._anthropic = anthropic
        self.client = anthropic.Anthropic(timeout=timeout, max_retries=max_retries)
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens
        self.use_fallbacks = use_fallbacks

    def complete_json(self, req: LLMRequest) -> LLMResponse:
        anthropic = self._anthropic
        content: list[dict] = []
        for img in req.images:
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                        "data": base64.standard_b64encode(img).decode("utf-8")}})
        content.append({"type": "text", "text": req.user})
        kwargs = dict(
            model=self.model,
            max_tokens=self.max_tokens,
            # static per experiment (role, rules, DSL grammar) -> cached prefix
            system=[{"type": "text", "text": req.system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
            thinking={"type": "adaptive"},
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": req.schema}},
        )
        try:
            if self.use_fallbacks:
                resp = self.client.beta.messages.create(betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
            else:
                resp = self.client.messages.create(**kwargs)
        except anthropic.AuthenticationError as exc:
            raise LLMUnavailable("Anthropic authentication failed (set ANTHROPIC_API_KEY or run `ant auth login`)") \
                from exc
        except anthropic.PermissionDeniedError as exc:
            raise LLMUnavailable(f"Anthropic permission denied: {exc}") from exc
        except anthropic.NotFoundError as exc:
            raise LLMUnavailable(f"model {self.model!r} not found: {exc}") from exc
        except anthropic.BadRequestError as exc:
            raise LLMUnavailable(f"request rejected: {exc}") from exc
        except anthropic.RateLimitError as exc:
            raise LLMUnavailable(f"rate limited after retries: {exc}") from exc
        except anthropic.APIStatusError as exc:
            raise LLMUnavailable(f"Anthropic API error {exc.status_code}: {exc}") from exc
        except anthropic.APIConnectionError as exc:
            raise LLMUnavailable(f"cannot reach the Anthropic API: {exc}") from exc
        usage = {}
        if getattr(resp, "usage", None) is not None:
            u = resp.usage
            usage = {k: getattr(u, k, None) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
                                                      "cache_creation_input_tokens")}
        served_by = getattr(resp, "model", self.model)
        if resp.stop_reason == "refusal":
            return LLMResponse(None, "", served_by, self.backend, "refusal", True, usage)
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        data = None
        if resp.stop_reason != "max_tokens":
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = _extract_json(text)
        return LLMResponse(data, text, served_by, self.backend, resp.stop_reason, False, usage)


class OfflineClient:
    """Marker backend: no network access; callers fall back to deterministic templates."""

    backend = "offline"
    model = "offline-template"

    def complete_json(self, req: LLMRequest) -> LLMResponse:
        raise LLMUnavailable("offline backend has no language model")


class ReplayClient:
    """Serves recorded responses; used to re-run an experiment reproducibly without new LLM calls."""

    backend = "replay"

    def __init__(self, db: LedgerDB, model: str = DEFAULT_MODEL):
        self.db = db
        self.model = model

    def complete_json(self, req: LLMRequest) -> LLMResponse:
        row = self.db.llm_cached(req.prompt_hash(self.model))
        if row is None:
            raise LLMUnavailable("no recorded response for this prompt (replay mode)")
        text = row.get("response") or ""
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = _extract_json(text)
        return LLMResponse(data, text, row.get("model") or self.model, "replay", cached=True)


class RecordingClient:
    """Wraps a client: logs every call to the ledger and enforces a call budget."""

    def __init__(self, inner, db: LedgerDB, experiment_id: str, max_calls: int = 50):
        self.inner = inner
        self.db = db
        self.experiment_id = experiment_id
        self.max_calls = max_calls
        self.calls = 0
        self.backend = inner.backend
        self.model = inner.model

    def complete_json(self, req: LLMRequest) -> LLMResponse:
        if self.calls >= self.max_calls:
            raise LLMUnavailable(f"LLM call budget ({self.max_calls}) exhausted")
        self.calls += 1
        ph = req.prompt_hash(self.inner.model)
        try:
            resp = self.inner.complete_json(req)
        except LLMUnavailable as exc:
            self.db.log_llm({"experiment_id": self.experiment_id, "purpose": req.purpose, "backend": self.backend,
                             "model": self.model, "prompt_hash": ph, "prompt": req.user[:20000], "response": None,
                             "meta": {"error": str(exc), "images": len(req.images)}})
            raise
        self.db.log_llm({"experiment_id": self.experiment_id, "purpose": req.purpose, "backend": resp.backend,
                         "model": resp.model, "prompt_hash": ph, "prompt": req.user[:20000], "response": resp.text,
                         "meta": {"stop_reason": resp.stop_reason, "refused": resp.refused, "usage": resp.usage,
                                  "images": len(req.images), "cached": resp.cached}})
        return resp


def _extract_json(text: str) -> dict | None:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


def make_client(cfg: dict, db: LedgerDB, experiment_id: str):
    """Build the configured client wrapped in a RecordingClient, or None for the offline backend."""
    backend = (cfg.get("provider") or "offline").lower()
    model = cfg.get("model") or DEFAULT_MODEL
    if backend == "offline":
        return None
    if backend == "replay":
        inner = ReplayClient(db, model)
    elif backend == "anthropic":
        inner = AnthropicClient(model=model, effort=cfg.get("effort", "high"),
                                max_tokens=int(cfg.get("max_tokens", 16000)),
                                use_fallbacks=bool(cfg.get("server_side_fallbacks", True)))
    else:
        raise ValueError(f"unknown llm provider {backend!r} (offline | anthropic | replay)")
    return RecordingClient(inner, db, experiment_id, int(cfg.get("max_calls", 40)))
