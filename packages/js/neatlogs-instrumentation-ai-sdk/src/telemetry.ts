import { trace, type Tracer } from '@opentelemetry/api';

/**
 * Options for {@link createAITelemetry}.
 */
export interface CreateAITelemetryOptions {
  /** Custom metadata to attach to every span emitted from this telemetry config. */
  metadata?: Record<string, unknown>;
}

/**
 * Telemetry config object compatible with the Vercel AI SDK's
 * `experimental_telemetry` option. Spread it onto any `generateText` /
 * `streamText` / `generateObject` / `streamObject` call to enable Neatlogs
 * tracing for that call:
 *
 *   await generateText({
 *     model: openai('gpt-4o'),
 *     prompt: 'Hello',
 *     experimental_telemetry: createAITelemetry(),
 *   });
 *
 * Requires `neatlogs.init()` to have been called first so that a global
 * TracerProvider is registered.
 */
export interface AITelemetryConfig {
  isEnabled: true;
  recordInputs: true;
  recordOutputs: true;
  tracer: Tracer;
  metadata: Record<string, unknown>;
}

const TRACER_NAME = 'neatlogs.ai-sdk';

export function createAITelemetry(
  opts: CreateAITelemetryOptions = {},
): AITelemetryConfig {
  const userMeta = opts.metadata ?? {};
  const metadata: Record<string, unknown> = {
    ...userMeta,
    neatlogsWrapped: true,
  };

  return {
    isEnabled: true,
    recordInputs: true,
    recordOutputs: true,
    tracer: trace.getTracer(TRACER_NAME),
    metadata,
  };
}
