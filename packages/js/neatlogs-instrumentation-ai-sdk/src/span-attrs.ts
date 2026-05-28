import type { Span } from '@opentelemetry/api';

/**
 * Safely JSON.stringify an arbitrary value. Returns the empty string on failure.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Set input.value on the parent span, redacting only if the value cannot be
 * serialized. Mirrors how the Mastra exporter records input/output snapshots.
 */
export function setInputValue(span: Span, opts: Record<string, unknown>): void {
  const stringified = safeStringify(opts);
  if (stringified) {
    span.setAttribute('input.value', stringified);
  }
}

/**
 * Set output.value on the parent span. Skips when the result cannot be
 * serialized (e.g., an AsyncIterable from streamText).
 */
export function setOutputValue(span: Span, result: unknown): void {
  const stringified = safeStringify(result);
  if (stringified) {
    span.setAttribute('output.value', stringified);
  }
}
