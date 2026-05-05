# @neatlogs/instrumentation-mastra

OpenTelemetry instrumentation for the [Mastra AI framework](https://mastra.ai/) (`@mastra/core`).

Enriches Mastra agent, workflow, and tool spans with OpenInference-compatible attributes for Neatlogs dashboard compatibility.

## How It Works

Mastra supports custom observability backends via its `@mastra/observability` package. This instrumentor injects a `NeatlogsMastraExporter` (a `BaseExporter`) into Mastra's observability layer at construction time, so every agent, workflow, and tool span is forwarded to the Neatlogs exporter.

The exporter is **lifecycle-aware**: it processes `span_started` events to open OTel spans immediately and stores their context so that child spans (which reference `parentSpanId`) are correctly parented under the same trace. On `span_ended`, the stored span is finalized with attributes, status, and timing. This produces **one grouped trace with proper parent-child relationships** for an entire Mastra workflow execution.

> **Note on `@mastra/core@1.x` compatibility:** The `@mastra/core` package exports a sealed CJS module whose `Mastra` property descriptor is `configurable: false`. This makes constructor-level monkey-patching impossible. If you call `instrumentor.instrument(...)` against a real `@mastra/core@1.x` install, a `[neatlogs]` warning will be written to stderr and no spans will be collected. Use the **direct approach** below instead.

## Installation

```bash
npm install @neatlogs/instrumentation-mastra @mastra/observability
# or
pnpm add @neatlogs/instrumentation-mastra @mastra/observability
```

## Usage

### Recommended: direct `observability` injection (active provider pattern)

Pass a pre-built `Observability` instance to the `Mastra` constructor. This is the only approach that works with the sealed `@mastra/core@1.x` CJS bundle, and it ensures that Mastra lifecycle events (`span_started`/`span_ended`) produce properly grouped traces:

```typescript
import { init, flush, shutdown } from 'neatlogs';
import { trace } from '@opentelemetry/api';
import { Mastra } from '@mastra/core';
import { createNeatlogsMastraObservability } from '@neatlogs/instrumentation-mastra';

// 1. Initialize NeatLogs first so its TracerProvider is active
await init({
  apiKey: process.env.NEATLOGS_API_KEY,
  endpoint: process.env.NEATLOGS_ENDPOINT,
  workflowName: 'mastra-grouped-workflow',
});

// 2. Reuse the active provider that NeatLogs installed
const provider = trace.getTracerProvider();
const { observability } = createNeatlogsMastraObservability(provider);

// 3. Pass observability directly to Mastra
const mastra = new Mastra({
  observability,
  agents: { /* ... */ },
  workflows: { /* ... */ },
});

// All Mastra agent/workflow/tool calls now produce grouped OTel traces
// with proper parent-child relationships in a single traceId.

await flush();
await shutdown();
```

### Using `NeatlogsMastraExporter` directly

For advanced use cases where you need direct control over the exporter:

```typescript
import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { NeatlogsMastraExporter } from '@neatlogs/instrumentation-mastra';

// Setup a provider (e.g., with in-memory exporter for testing)
const memExporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(memExporter));

// Create the exporter — it handles span_started/span_ended lifecycle
const mastraExporter = new NeatlogsMastraExporter(provider);

// Wire it into Mastra's observability (using @mastra/observability)
// or call mastraExporter.exportTracingEvent(event) directly for testing.
```

### Alternative: using `MastraInstrumentor` (for patchable environments)

`MastraInstrumentor` attempts to replace the `Mastra` export at the module level. This works only in environments where the module descriptor is configurable (e.g., mocked modules in tests):

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import MastraInstrumentor from '@neatlogs/instrumentation-mastra';

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();

const instrumentor = new MastraInstrumentor();
instrumentor.instrument({ tracerProvider: provider });

// If @mastra/core exports are sealed, a [neatlogs] warning is emitted
// and no patching occurs. Use the direct approach above instead.
```

## Span Grouping

The exporter maintains a map of active Mastra spans keyed by their Mastra `span.id`. When a `span_started` event arrives:

1. **Root spans** (no `parentSpanId`) start from `ROOT_CONTEXT`.
2. **Child spans** look up the stored parent's context and start as children of that OTel span.
3. **Orphan spans** (parent not yet available due to out-of-order events) start from root with a bounded warning.

When `span_ended` arrives, the stored span is finalized and removed.

For **ended-only streams** (no `span_started` received), the exporter falls back:
- If a stored parent context exists, it uses it.
- If valid 32-hex `traceId` and 16-hex non-zero `parentSpanId` are provided, it constructs a non-recording parent context.
- Otherwise, it exports from `ROOT_CONTEXT` (ended-only streams cannot always be tree-grouped).

The `flush()` and `shutdown()` methods end and clear any active spans to prevent memory leaks.

## Captured Attributes

### Agent Spans (`openinference.span.kind = "AGENT"`)

| Attribute | Description |
|-----------|-------------|
| `agent.name` | Agent name |
| `agent.instructions` | Agent instructions (truncated to 10K chars) |
| `agent.available_tools` | Comma-separated tool names |
| `llm.model_name` | Model name |
| `input.value` | Input messages (JSON, truncated) |
| `output.value` | Response (JSON, truncated) |
| `llm.token_count.prompt` | Prompt token count |
| `llm.token_count.completion` | Completion token count |
| `llm.token_count.total` | Total token count |

### Workflow Spans (`openinference.span.kind = "WORKFLOW"`)

| Attribute | Description |
|-----------|-------------|
| `workflow.name` | Workflow name |
| `input.value` | Workflow input (JSON, truncated) |
| `output.value` | Workflow output (JSON, truncated) |

### Tool Spans (`openinference.span.kind = "TOOL"`)

| Attribute | Description |
|-----------|-------------|
| `tool.name` | Tool ID |
| `tool.description` | Tool description |
| `input.value` | Tool input (JSON, truncated) |
| `output.value` | Tool output (JSON, truncated) |

## Examples

### Grouped Workflow (local, no credentials)

```bash
# Run the grouped workflow example
NEATLOGS_DISABLE_EXPORT=true pnpm run example:grouped

# Verify the output
pnpm run verify:grouped
```

This produces a JSONL log in `logs/` demonstrating one trace with multiple parent-child spans.
