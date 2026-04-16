# @neatlogs/instrumentation-mastra

OpenTelemetry instrumentation for the [Mastra AI framework](https://mastra.ai/) (`@mastra/core`).

Enriches Mastra agent, workflow, and tool spans with OpenInference-compatible attributes for Neatlogs dashboard compatibility.

## How It Works

Mastra already has built-in OpenTelemetry tracing via `@mastra/otel-bridge`. This instrumentor uses a **context-aware approach**:

- **When Mastra's OtelBridge is active**: enriches existing spans with OpenInference attributes (no duplicate spans)
- **When OtelBridge is not configured**: creates its own spans with full attribute coverage

This means you can use this instrumentor alongside Mastra's built-in tracing without conflicts.

## Installation

```bash
npm install @neatlogs/instrumentation-mastra
# or
pnpm add @neatlogs/instrumentation-mastra
```

## Usage

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { MastraInstrumentation } from '@neatlogs/instrumentation-mastra';

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();

const instrumentation = new MastraInstrumentation();
instrumentation.enable();

// Now all Mastra agent/workflow/tool calls are automatically traced
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
