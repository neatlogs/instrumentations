# Neatlogs Instrumentations

Neatlogs OpenTelemetry-compatible instrumentations for AI agent ecosystems.

## Packages

### Python

| Package | Target Library |
|---------|----------------|
| `neatlogs-instrumentation-azure-ai-inference` | `azure.ai.inference` |

### TypeScript / JavaScript

| Package | Target Library |
|---------|----------------|
| `@neatlogs/instrumentation-google-genai` | `@google/genai` |
| `@neatlogs/instrumentation-mastra` | `@mastra/core` |

See [`packages/js/`](packages/js/) for TypeScript package documentation and development setup.

## Install (Python)

Install from PyPI:

```bash
pip install neatlogs-instrumentations
```

If you need Azure AI Inference support:

```bash
pip install "neatlogs-instrumentations[azure-ai-inference]"
```

## Quickstart (Azure AI Inference)

This package provides an OpenTelemetry `BaseInstrumentor` for the
`azure.ai.inference.ChatCompletionsClient.complete` method.

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, ConsoleSpanExporter

from neatlogs_instrumentation_azure_ai_inference.instrumentor import (
    AzureAIInferenceInstrumentor,
)


provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))

AzureAIInferenceInstrumentor().instrument(tracer_provider=provider)
```

To confirm it is installed:

```bash
python -c "from neatlogs_instrumentation_azure_ai_inference.instrumentor import AzureAIInferenceInstrumentor; print(AzureAIInferenceInstrumentor)"
```
