# @neatlogs/instrumentation-google-genai

OpenTelemetry instrumentation for the [Google GenAI SDK](https://www.npmjs.com/package/@google/genai) (`@google/genai`).

Automatically traces `generateContent()` and `generateContentStream()` calls with OpenInference-compatible attributes.

## Installation

```bash
npm install @neatlogs/instrumentation-google-genai
# or
pnpm add @neatlogs/instrumentation-google-genai
```

## Usage

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { GoogleGenAIInstrumentation } from '@neatlogs/instrumentation-google-genai';

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();

const instrumentation = new GoogleGenAIInstrumentation();
instrumentation.enable();

// Now all @google/genai calls are automatically traced
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const response = await ai.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: [{ role: 'user', parts: [{ text: 'Hello!' }] }],
});
```

## Captured Attributes

| Attribute | Description |
|-----------|-------------|
| `openinference.span.kind` | Always `"LLM"` |
| `gen_ai.system` | Always `"google_genai"` |
| `gen_ai.request.model` | Model name |
| `llm.model_name` | Model name |
| `llm.input_messages.{i}.message.role` | Input message role |
| `llm.input_messages.{i}.message.content` | Input message content |
| `llm.output_messages.{i}.message.role` | Output message role |
| `llm.output_messages.{i}.message.content` | Output message content |
| `llm.token_count.prompt` | Prompt token count |
| `llm.token_count.completion` | Completion token count |
| `llm.token_count.total` | Total token count |
| `gen_ai.request.temperature` | Temperature parameter |
| `gen_ai.request.max_tokens` | Max output tokens |
| `gen_ai.request.top_p` | Top-p parameter |
| `gen_ai.request.top_k` | Top-k parameter |
| `gen_ai.response.finish_reasons` | Finish reasons array |
