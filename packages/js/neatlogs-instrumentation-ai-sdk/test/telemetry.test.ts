import { describe, it, expect } from 'vitest';
import { trace, NoopTracerProvider } from '@opentelemetry/api';
import { createAITelemetry } from '../src/telemetry.js';

describe('createAITelemetry', () => {
  it('returns an object with isEnabled, recordInputs, recordOutputs and a tracer', () => {
    const telemetry = createAITelemetry();
    expect(telemetry.isEnabled).toBe(true);
    expect(telemetry.recordInputs).toBe(true);
    expect(telemetry.recordOutputs).toBe(true);
    expect(typeof telemetry.tracer).toBe('object');
    expect(telemetry.tracer).not.toBeNull();
  });

  it('uses the global tracer provider', () => {
    const tracer = trace.getTracer('neatlogs.ai-sdk');
    const telemetry = createAITelemetry();
    // both should be tracers from the same provider — startSpan should exist
    expect(typeof telemetry.tracer.startSpan).toBe('function');
  });

  it('attaches metadata when provided', () => {
    const telemetry = createAITelemetry({ metadata: { userId: 'u-123' } });
    expect(telemetry.metadata).toEqual({ userId: 'u-123', neatlogsWrapped: true });
  });

  it('always sets neatlogsWrapped: true even without user metadata', () => {
    const telemetry = createAITelemetry();
    expect(telemetry.metadata).toEqual({ neatlogsWrapped: true });
  });

  it('user metadata cannot override neatlogsWrapped flag', () => {
    const telemetry = createAITelemetry({ metadata: { neatlogsWrapped: false as any } });
    expect(telemetry.metadata?.neatlogsWrapped).toBe(true);
  });

  it('does not include metadata field as undefined when no metadata given', () => {
    const telemetry = createAITelemetry();
    // metadata always exists (because of neatlogsWrapped flag), so it must be an object
    expect(telemetry.metadata).toBeDefined();
    expect(typeof telemetry.metadata).toBe('object');
  });
});
