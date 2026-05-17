import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { createAITelemetry, type AITelemetryConfig } from './telemetry.js';
import { setInputValue, setOutputValue } from './span-attrs.js';

const TRACER_NAME = 'neatlogs.ai-sdk';

/**
 * Names of AI SDK exports we wrap with neatlogs parent spans. Anything not in
 * this list is passed through unchanged.
 */
type WrappedFunctionName = 'generateText' | 'streamText' | 'generateObject' | 'streamObject';

const WRAPPED_FUNCTIONS: readonly WrappedFunctionName[] = [
  'generateText',
  'streamText',
  'generateObject',
  'streamObject',
] as const;

/**
 * Wrap the user's `import * as ai from 'ai'` namespace so that every
 * `generateText` / `streamText` / `generateObject` / `streamObject` call:
 *
 *   1. Opens a parent OTel span on the active TracerProvider.
 *   2. Forces `experimental_telemetry: { isEnabled: true, ... }` for the call,
 *      merging user-supplied metadata.
 *   3. Records input/output on the parent span and propagates errors.
 *
 * Other exports (Agent, Experimental_Agent, helpers, types) are passed through
 * unchanged in this version. Agent wrapping lands in a follow-up.
 */
export function wrapAISDK<T extends Record<string, unknown>>(aiModule: T): T {
  const wrapped: Record<string, unknown> = { ...aiModule };

  for (const name of WRAPPED_FUNCTIONS) {
    const original = aiModule[name];
    if (typeof original !== 'function') continue;

    if (name === 'streamText' || name === 'streamObject') {
      wrapped[name] = createSyncWrapper(name, original as (opts: any) => unknown);
    } else {
      wrapped[name] = createAsyncWrapper(name, original as (opts: any) => Promise<unknown>);
    }
  }

  return wrapped as T;
}

/**
 * Create an async wrapper for generateText/generateObject. Opens a parent span,
 * awaits the original, records output, and ends the span.
 */
function createAsyncWrapper(
  name: WrappedFunctionName,
  original: (opts: any) => Promise<unknown>,
): (opts: any) => Promise<unknown> {
  return async function wrappedAsyncFn(opts: any): Promise<unknown> {
    const tracer = trace.getTracer(TRACER_NAME);
    // Manual span management for async operations — startActiveSpan doesn't work
    // reliably with promises in the callback (spans don't get exported in tests).
    const span = tracer.startSpan(`ai.${name}`, { attributes: { 'openinference.span.kind': 'LLM' } });
    try {
      setInputValue(span, opts);
      const merged = mergeTelemetry(opts);
      const result = await original(merged);
      setOutputValue(span, result);
      return result;
    } catch (err) {
      recordSpanError(span, err);
      throw err;
    } finally {
      span.end();
    }
  };
}

/**
 * Create a sync wrapper for streamText/streamObject. Opens a parent span,
 * calls the original synchronously, records the returned object, and ends the
 * span. Best-effort: the stream's full lifecycle is not awaited (the AI SDK
 * emits per-stream child spans on the same context, so the parent is short
 * but child spans correctly reference it).
 */
function createSyncWrapper(
  name: WrappedFunctionName,
  original: (opts: any) => unknown,
): (opts: any) => unknown {
  return function wrappedSyncFn(opts: any): unknown {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(`ai.${name}`, { attributes: { 'openinference.span.kind': 'LLM' } }, (span) => {
      try {
        setInputValue(span, opts);
        const merged = mergeTelemetry(opts);
        const result = original(merged);
        // Don't try to JSON.stringify a stream — leave output.value unset
        return result;
      } catch (err) {
        recordSpanError(span, err);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

/**
 * Merge the user's experimental_telemetry config (if any) with our defaults,
 * forcing isEnabled: true and neatlogsWrapped: true.
 */
function mergeTelemetry(opts: any): any {
  const baseTelemetry: AITelemetryConfig = createAITelemetry({
    metadata: opts?.experimental_telemetry?.metadata,
  });
  return {
    ...opts,
    experimental_telemetry: {
      ...opts?.experimental_telemetry,
      ...baseTelemetry,
      // mergeTelemetry must always end with our base values — spread again to win
      metadata: baseTelemetry.metadata,
    },
  };
}

/**
 * Set ERROR status on the span and record the exception.
 */
function recordSpanError(span: Span, err: unknown): void {
  if (err instanceof Error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.recordException(err);
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
  }
}
