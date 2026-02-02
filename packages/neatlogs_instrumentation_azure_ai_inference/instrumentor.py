"""
Neatlogs Azure AI Inference instrumentation.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Iterator, Optional
from urllib.parse import urlparse

import wrapt
from opentelemetry import context as context_api
from opentelemetry import trace
from opentelemetry.context import get_current
from opentelemetry.instrumentation.instrumentor import BaseInstrumentor
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

logger = logging.getLogger(__name__)


def _safe_json(obj: Any) -> str:
    try:
        return json.dumps(obj, default=str)
    except Exception:
        return json.dumps(str(obj))


def _coerce_role(role: Any) -> str:
    return str(role).lower() if role is not None else ""


def _get_endpoint_from_client(client: Any) -> str:
    for path in (
        ("_config", "endpoint"),
        ("_client", "_config", "endpoint"),
        ("_client", "_endpoint"),
        ("_endpoint",),
        ("endpoint",),
    ):
        cur = client
        ok = True
        for attr in path:
            if not hasattr(cur, attr):
                ok = False
                break
            cur = getattr(cur, attr)
        if ok and isinstance(cur, str) and cur:
            return cur
    return ""


def _infer_deployment_from_endpoint(endpoint: str) -> str:
    # Azure OpenAI format: https://<resource>.openai.azure.com/openai/deployments/<deployment>
    if not endpoint:
        return ""
    try:
        p = urlparse(endpoint)
        parts = [s for s in p.path.split("/") if s]
        if "deployments" in parts:
            i = parts.index("deployments")
            if i + 1 < len(parts):
                return parts[i + 1]
    except Exception:
        pass
    return ""


def _infer_provider(endpoint: str, model: str) -> str:
    if endpoint and "openai.azure.com" in endpoint:
        return "openai"
    if model and any(model.startswith(p) for p in ("gpt-", "o1-", "o3-", "text-")):
        return "openai"
    return "azure"


def _set_message_attrs(span: Span, messages: Any, max_messages: int = 50) -> None:
    if not isinstance(messages, list):
        return
    for i, msg in enumerate(messages[:max_messages]):
        if isinstance(msg, dict):
            role = msg.get("role")
            content = msg.get("content")
        else:
            # Azure SDK message model objects
            role = getattr(msg, "role", None)
            content = getattr(msg, "content", None)
        role_s = _coerce_role(role)
        if role_s:
            span.set_attribute(f"llm.input_messages.{i}.message.role", role_s)
        if isinstance(content, str) and content:
            span.set_attribute(f"llm.input_messages.{i}.message.content", content)


def _extract_usage(obj: Any) -> Dict[str, int]:
    usage = getattr(obj, "usage", None)
    if usage is None and isinstance(obj, dict):
        usage = obj.get("usage")
    if not usage:
        return {}

    out: Dict[str, int] = {}
    for dst, src in (("prompt", "prompt_tokens"), ("completion", "completion_tokens"), ("total", "total_tokens")):
        v = getattr(usage, src, None)
        if v is None and isinstance(usage, dict):
            v = usage.get(src)
        if isinstance(v, int):
            out[dst] = v

    cache_read = getattr(usage, "cache_read_input_tokens", None)
    if cache_read is None and isinstance(usage, dict):
        cache_read = usage.get("cache_read_input_tokens")
    if isinstance(cache_read, int):
        out["cache_read"] = cache_read

    cache_write = getattr(usage, "cache_creation_input_tokens", None)
    if cache_write is None and isinstance(usage, dict):
        cache_write = usage.get("cache_creation_input_tokens")
    if isinstance(cache_write, int):
        out["cache_write"] = cache_write

    return out


def _extract_output_text(resp: Any) -> str:
    try:
        choices = getattr(resp, "choices", None)
        if not choices:
            return ""
        msg = getattr(choices[0], "message", None)
        if not msg:
            return ""
        content = getattr(msg, "content", None)
        return content if isinstance(content, str) else ""
    except Exception:
        return ""


def _extract_tool_calls(resp: Any) -> list[dict[str, Any]]:
    tool_calls: list[dict[str, Any]] = []
    try:
        choices = getattr(resp, "choices", None)
        if not choices:
            return tool_calls
        msg = getattr(choices[0], "message", None)
        if not msg:
            return tool_calls
        raw_calls = getattr(msg, "tool_calls", None)
        if not raw_calls:
            return tool_calls
        for tc in list(raw_calls)[:10]:
            call_id = getattr(tc, "id", None)
            fn = getattr(tc, "function", None)
            fn_name = getattr(fn, "name", None) if fn else None
            fn_args = getattr(fn, "arguments", None) if fn else None
            if isinstance(fn_args, (dict, list)):
                fn_args = _safe_json(fn_args)
            tool_calls.append(
                {"id": call_id, "function": {"name": fn_name, "arguments": fn_args}}
            )
    except Exception:
        return tool_calls
    return tool_calls


@dataclass
class _StreamState:
    text: str = ""
    last_update: Any = None


class _StreamingIterator(Iterator[Any]):
    def __init__(self, it: Iterable[Any], span: Span, state: _StreamState):
        self._it = iter(it)
        self._span = span
        self._state = state
        self._done = False

    def __iter__(self) -> "_StreamingIterator":
        return self

    def __next__(self) -> Any:
        token = None
        try:
            token = context_api.attach(trace.set_span_in_context(self._span, get_current()))
            update = next(self._it)
            self._state.last_update = update

            try:
                choices = getattr(update, "choices", None)
                if choices:
                    delta = getattr(choices[0], "delta", None)
                    if delta is not None:
                        chunk = getattr(delta, "content", None)
                        if isinstance(chunk, str) and chunk:
                            self._state.text += chunk
            except Exception:
                pass

            return update
        except StopIteration:
            self._finish_ok()
            raise
        except Exception as e:
            self._finish_error(e)
            raise
        finally:
            if token is not None:
                try:
                    context_api.detach(token)
                except Exception:
                    pass

    def _finish_ok(self) -> None:
        if self._done:
            return
        self._done = True
        try:
            if self._state.text:
                self._span.set_attribute("llm.output_messages.0.message.role", "assistant")
                self._span.set_attribute("llm.output_messages.0.message.content", self._state.text)

            usage = _extract_usage(self._state.last_update)
            if "prompt" in usage:
                self._span.set_attribute("llm.token_count.prompt", int(usage["prompt"]))
            if "completion" in usage:
                self._span.set_attribute("llm.token_count.completion", int(usage["completion"]))
            if "total" in usage:
                self._span.set_attribute("llm.token_count.total", int(usage["total"]))
            if "cache_read" in usage:
                self._span.set_attribute(
                    "llm.token_count.prompt_details.cache_read", int(usage["cache_read"])
                )
            if "cache_write" in usage:
                self._span.set_attribute(
                    "llm.token_count.prompt_details.cache_write", int(usage["cache_write"])
                )

            self._span.set_status(Status(StatusCode.OK))
        finally:
            self._span.end()

    def _finish_error(self, e: Exception) -> None:
        if self._done:
            return
        self._done = True
        try:
            self._span.record_exception(e)
            self._span.set_status(Status(StatusCode.ERROR, str(e)))
        finally:
            self._span.end()


class AzureAIInferenceInstrumentor(BaseInstrumentor):
    def instrumentation_dependencies(self) -> tuple[str, ...]:
        return ("azure-ai-inference>=1.0.0b0",)

    def _instrument(self, **kwargs: Any) -> None:
        tracer_provider = kwargs.get("tracer_provider")
        self._tracer = trace.get_tracer(
            "neatlogs.azure_ai_inference", "0.1.0", tracer_provider=tracer_provider
        )
        wrapt.wrap_function_wrapper(
            "azure.ai.inference",
            "ChatCompletionsClient.complete",
            self._wrap_complete,
        )

    def _uninstrument(self, **_: Any) -> None:
        try:
            wrapt.unwrap_function_wrapper(
                "azure.ai.inference", "ChatCompletionsClient.complete"
            )
        except Exception:
            pass

    def _wrap_complete(self, wrapped: Any, instance: Any, args: tuple, kwargs: dict) -> Any:
        endpoint = _get_endpoint_from_client(instance)
        deployment = _infer_deployment_from_endpoint(endpoint)
        model = kwargs.get("model") or deployment or ""
        provider = _infer_provider(endpoint, model)

        span = self._tracer.start_span("ChatCompletion", kind=SpanKind.INTERNAL)
        token = None
        try:
            token = context_api.attach(trace.set_span_in_context(span, get_current()))

            span.set_attribute("openinference.span.kind", "LLM")
            span.set_attribute("llm.request.type", "chat")
            span.set_attribute("llm.is_streaming", bool(kwargs.get("stream")))

            span.set_attribute("llm.provider", provider)
            span.set_attribute("llm.system", provider)
            if model:
                span.set_attribute("llm.model_name", model)
            if endpoint:
                span.set_attribute("gen_ai.openai.api_base", endpoint)

            _set_message_attrs(span, kwargs.get("messages"))

            inv: Dict[str, Any] = {}
            for k in (
                "temperature",
                "top_p",
                "max_tokens",
                "frequency_penalty",
                "presence_penalty",
                "seed",
                "stop",
                "tool_choice",
                "response_format",
            ):
                v = kwargs.get(k)
                if v is not None:
                    inv[k] = v
            if deployment:
                inv["deployment"] = deployment
            if kwargs.get("model") is not None:
                inv["model"] = kwargs.get("model")
            span.set_attribute("llm.invocation_parameters", _safe_json(inv))

            resp = wrapped(*args, **kwargs)

            if bool(kwargs.get("stream")):
                return _StreamingIterator(resp, span, _StreamState())

            out_text = _extract_output_text(resp)
            if out_text:
                span.set_attribute("llm.output_messages.0.message.role", "assistant")
                span.set_attribute("llm.output_messages.0.message.content", out_text)

            usage = _extract_usage(resp)
            if "prompt" in usage:
                span.set_attribute("llm.token_count.prompt", int(usage["prompt"]))
            if "completion" in usage:
                span.set_attribute("llm.token_count.completion", int(usage["completion"]))
            if "total" in usage:
                span.set_attribute("llm.token_count.total", int(usage["total"]))
            if "cache_read" in usage:
                span.set_attribute(
                    "llm.token_count.prompt_details.cache_read", int(usage["cache_read"])
                )
            if "cache_write" in usage:
                span.set_attribute(
                    "llm.token_count.prompt_details.cache_write", int(usage["cache_write"])
                )

            for i, tc in enumerate(_extract_tool_calls(resp)[:10]):
                call_id = tc.get("id")
                fn = tc.get("function") or {}
                fn_name = fn.get("name")
                fn_args = fn.get("arguments")
                if call_id:
                    span.set_attribute(
                        f"llm.output_messages.0.message.tool_calls.{i}.tool_call.id",
                        str(call_id),
                    )
                if fn_name:
                    span.set_attribute(
                        f"llm.output_messages.0.message.tool_calls.{i}.tool_call.function.name",
                        str(fn_name),
                    )
                if fn_args is not None:
                    span.set_attribute(
                        f"llm.output_messages.0.message.tool_calls.{i}.tool_call.function.arguments",
                        str(fn_args),
                    )

            span.set_status(Status(StatusCode.OK))
            return resp
        except Exception as e:
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, str(e)))
            raise
        finally:
            if token is not None:
                try:
                    context_api.detach(token)
                except Exception:
                    pass
            if not bool(kwargs.get("stream")):
                span.end()
