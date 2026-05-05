# @neatlogs/instrumentation-mastra

OpenTelemetry instrumentation for the [Mastra AI framework](https://mastra.ai/) (`@mastra/core`).

Enriches Mastra agent, workflow, and tool spans with OpenInference-compatible attributes for Neatlogs dashboard compatibility.

## How It Works

Mastra supports custom observability backends via its `@mastra/observability` package. This instrumentor injects a `NeatlogsMastraExporter` (a `BaseExporter`) into Mastra's observability layer at construction time, so every agent, workflow, and tool span is forwarded to the Neatlogs exporter.

> **Note on `@mastra/core@1.x` compatibility:** The `@mastra/core` package exports a sealed CJS module whose `Mastra` property descriptor is `configurable: false`. This makes constructor-level monkey-patching impossible. If you call `instrumentor.instrument(...)` against a real `@mastra/core@1.x` install, a `[neatlogs]` warning will be written to stderr and no spans will be collected. Use the **direct approach** below instead.

## Installation

```bash
npm install @neatlogs/instrumentation-mastra @mastra/observability
# or
pnpm add @neatlogs/instrumentation-mastra @mastra/observability
```

## Usage

### Recommended: direct `observability` injection

Pass a pre-built `Observability` instance to the `Mastra` constructor. This is the only approach that works with the sealed `@mastra/core@1.x` CJS bundle:

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Mastra } from '@mastra/core';
import { createNeatlogsMastraObservability } from '@neatlogs/instrumentation-mastra';

const provider = new NodeTracerProvider();
provider.register();

const { observability } = createNeatlogsMastraObservability(provider);

const mastra = new Mastra({
  observability,
  // ... other Mastra options
});

// All Mastra agent/workflow/tool calls are now traced via Neatlogs
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
