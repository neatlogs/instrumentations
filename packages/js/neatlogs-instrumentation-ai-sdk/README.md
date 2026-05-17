# @neatlogs/instrumentation-ai-sdk

Neatlogs instrumentation for the [Vercel AI SDK](https://sdk.vercel.ai/) (`ai` package).

Wraps `generateText`, `streamText`, `generateObject`, and `streamObject` so that every call produces a Neatlogs trace with full input/output capture, token counts, model name, and tool-call attribution — without monkey-patching the `ai` package.

## How It Works

The `ai` package emits OpenTelemetry spans natively when `experimental_telemetry` is enabled. This package's `wrapAISDK(ai)` helper:

1. Opens a parent OTel span on the active `TracerProvider` (set by `neatlogs.init()`).
2. Forces `experimental_telemetry: { isEnabled: true, ... }` for the call.
3. Captures the call's input options and result on the parent span.
4. Propagates errors with `SpanStatusCode.ERROR`.

Native AI SDK child spans (`ai.doGenerate`, `ai.toolCall`) nest under the parent automatically. The Neatlogs SDK's normalization pipeline maps `ai.*` attributes to the canonical `neatlogs.*` namespace.

## Installation

```bash
npm install @neatlogs/instrumentation-ai-sdk ai
# or
pnpm add @neatlogs/instrumentation-ai-sdk ai
```

`ai` is an optional peer dependency; install it only if you use `wrapAISDK`.

## Usage

### Recommended: `wrapAISDK`

```typescript
import { init, flush, shutdown } from 'neatlogs';
import { wrapAISDK } from '@neatlogs/instrumentation-ai-sdk';
import * as ai from 'ai';
import { openai } from '@ai-sdk/openai';

await init({
  apiKey: process.env.NEATLOGS_API_KEY,
  workflowName: 'ai-sdk-demo',
});

const { generateText, streamText } = wrapAISDK(ai);

const { text } = await generateText({
  model: openai('gpt-4o-mini'),
  prompt: 'What is the capital of France?',
});

console.log(text);

await flush();
await shutdown();
```

### Lower-level: `createAITelemetry`

When you want to set telemetry per call without wrapping the whole module:

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createAITelemetry } from '@neatlogs/instrumentation-ai-sdk';

await generateText({
  model: openai('gpt-4o-mini'),
  prompt: 'Hello',
  experimental_telemetry: createAITelemetry({ metadata: { userId: 'u-123' } }),
});
```

## Captured Attributes

The Vercel AI SDK emits attributes under the `ai.*` namespace; the Neatlogs SDK's `UnifiedAttributeProcessor` maps these to `neatlogs.*`:

| AI SDK attribute | Neatlogs attribute |
|------------------|-------------------|
| `ai.model.id` | `neatlogs.llm.model_name` |
| `ai.usage.promptTokens` | `neatlogs.llm.token_count.prompt` |
| `ai.usage.completionTokens` | `neatlogs.llm.token_count.completion` |
| `ai.prompt.messages` | `neatlogs.llm.input_messages.{i}.{role,content}` |
| `ai.response.text` | `neatlogs.llm.output_messages.0.content` |
| `ai.response.toolCalls` | `neatlogs.llm.output_messages.0.tool_calls.{i}.*` |
| `ai.toolCall.name` / `args` / `result` | `tool.name` / `input.value` / `output.value` |

## Compatibility

- AI SDK v3, v4, v5, v6 (peer dependency: `"ai": ">=3 <7"`)
- Node.js 18+
- ESM and CJS

## License

MIT
