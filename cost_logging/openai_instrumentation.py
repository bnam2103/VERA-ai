"""Auto-capture OpenAI usage without editing every call site.

Usage::

    from cost_logging import instrument_openai_client
    instrument_openai_client(vera.client, default_model=vera.model_name)

It patches ``client.chat.completions.create`` and (when present)
``client.responses.create``. Streaming responses are proxied so usage is
captured from the final chunk when ``stream_options={"include_usage": True}``
is set; otherwise no usage is available and the call is silently skipped.

The instrumentation is idempotent — calling it twice does nothing.
"""

from __future__ import annotations

from typing import Any

from . import logger as _logger


def _record(
    response: Any,
    *,
    fallback_model: str | None,
    endpoint: str,
) -> None:
    try:
        usage = getattr(response, "usage", None)
        if usage is None and isinstance(response, dict):
            usage = response.get("usage")
        if usage is None:
            return
        model = (
            getattr(response, "model", None)
            or (response.get("model") if isinstance(response, dict) else None)
            or fallback_model
            or "unknown"
        )
        _logger.log_openai_event(
            model=str(model),
            endpoint=endpoint,
            usage=usage,
            raw_usage=usage,
        )
    except Exception as e:
        print(f"[cost_logger] OpenAI usage capture skipped: {e}")


class _CostMeteredStream:
    """Iterator wrapper that records OpenAI streaming usage on completion."""

    def __init__(self, inner: Any, *, fallback_model: str | None, endpoint: str):
        self._inner = inner
        self._fallback_model = fallback_model
        self._endpoint = endpoint
        self._usage: Any = None
        self._model: str | None = fallback_model
        self._done = False

    def __iter__(self):
        return self

    def __next__(self):
        try:
            chunk = next(self._inner)
        except StopIteration:
            self._finalize()
            raise
        try:
            cu = getattr(chunk, "usage", None)
            if cu is None and isinstance(chunk, dict):
                cu = chunk.get("usage")
            if cu is not None:
                self._usage = cu
            m = getattr(chunk, "model", None)
            if m is None and isinstance(chunk, dict):
                m = chunk.get("model")
            if m:
                self._model = m
        except Exception:
            pass
        return chunk

    def __enter__(self):
        enter = getattr(self._inner, "__enter__", None)
        if callable(enter):
            try:
                enter()
            except Exception:
                pass
        return self

    def __exit__(self, et, ev, tb):
        try:
            exit_fn = getattr(self._inner, "__exit__", None)
            if callable(exit_fn):
                return exit_fn(et, ev, tb)
        finally:
            self._finalize()
        return False

    def close(self) -> None:
        try:
            close_fn = getattr(self._inner, "close", None)
            if callable(close_fn):
                close_fn()
        finally:
            self._finalize()

    def __getattr__(self, name: str):
        # Pass through any attribute we don't override (e.g. .response, .id).
        return getattr(self._inner, name)

    def _finalize(self) -> None:
        if self._done:
            return
        self._done = True
        if self._usage is None:
            return
        try:
            _logger.log_openai_event(
                model=str(self._model or self._fallback_model or "unknown"),
                endpoint=self._endpoint,
                usage=self._usage,
                raw_usage=self._usage,
            )
        except Exception as e:
            print(f"[cost_logger] stream usage capture skipped: {e}")


def _wrap_create(orig_create, *, fallback_model: str | None, endpoint: str):
    def wrapped(*args, **kwargs):
        is_stream = bool(kwargs.get("stream"))
        try:
            result = orig_create(*args, **kwargs)
        except Exception:
            raise
        model_hint = kwargs.get("model") or fallback_model
        if is_stream:
            try:
                return _CostMeteredStream(
                    result, fallback_model=model_hint, endpoint=endpoint
                )
            except Exception as e:
                print(f"[cost_logger] could not wrap stream: {e}")
                return result
        _record(result, fallback_model=model_hint, endpoint=endpoint)
        return result

    wrapped.__name__ = getattr(orig_create, "__name__", "create")
    wrapped.__qualname__ = getattr(orig_create, "__qualname__", "create")
    return wrapped


def instrument_openai_client(client: Any, *, default_model: str | None = None) -> Any:
    """Patch ``chat.completions.create`` (and ``responses.create`` if present).

    Idempotent. Returns the client for chaining.
    """
    if client is None:
        return client
    if getattr(client, "_vera_cost_instrumented", False):
        return client
    try:
        completions = client.chat.completions
        completions.create = _wrap_create(
            completions.create,
            fallback_model=default_model,
            endpoint="chat.completions.create",
        )
    except Exception as e:
        print(f"[cost_logger] could not instrument chat.completions: {e}")
    try:
        responses = getattr(client, "responses", None)
        if responses is not None and hasattr(responses, "create"):
            responses.create = _wrap_create(
                responses.create,
                fallback_model=default_model,
                endpoint="responses.create",
            )
    except Exception as e:
        print(f"[cost_logger] could not instrument responses.create: {e}")
    try:
        client._vera_cost_instrumented = True
    except Exception:
        pass
    return client
