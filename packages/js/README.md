# Neatlogs JS/TS Instrumentations

OpenTelemetry-compatible TypeScript instrumentations for AI frameworks and LLM providers.

## Packages

| Package | Description | Target Library |
|---------|-------------|----------------|
| `@neatlogs/instrumentation-google-genai` | Google GenAI SDK instrumentation | `@google/genai` |
| `@neatlogs/instrumentation-mastra` | Mastra AI framework instrumentation | `@mastra/core` |

## Development

This workspace uses [pnpm](https://pnpm.io/) for package management.

### Setup

```bash
cd packages/js
pnpm install
```

### Build

```bash
pnpm run build
```

### Test

```bash
pnpm run test
```

## Architecture

Each instrumentation package follows the [OpenInference JS conventions](https://github.com/Arize-ai/openinference/tree/main/js):

- Extends `InstrumentationBase` from `@opentelemetry/instrumentation`
- Monkey-patches target library methods to emit OpenTelemetry spans
- Sets OpenInference-compatible attributes for Neatlogs dashboard compatibility
- Ships dual CJS/ESM output with TypeScript declarations
