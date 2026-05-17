import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, SpanStatusCode, context } from '@opentelemetry/api';
import { SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { wrapAISDK } from '../src/wrap.js';

describe('wrapAISDK', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    trace.disable(); // Reset global provider so next test can set a new one
  });

  it('returns the same shape as input ai module', () => {
    const fakeAi = {
      generateText: async (_o: any) => ({ text: 'ok' }),
      streamText: (_o: any) => ({ textStream: [] }),
      generateObject: async (_o: any) => ({ object: {} }),
      streamObject: (_o: any) => ({ partialObjectStream: [] }),
      someUnknownExport: 'passthrough',
    };
    const wrapped = wrapAISDK(fakeAi as any);
    expect(typeof wrapped.generateText).toBe('function');
    expect(typeof wrapped.streamText).toBe('function');
    expect(typeof wrapped.generateObject).toBe('function');
    expect(typeof wrapped.streamObject).toBe('function');
    expect((wrapped as any).someUnknownExport).toBe('passthrough');
  });

  it('opens a parent span around generateText', async () => {
    const fakeAi = {
      generateText: async (opts: any) => {
        // assert that experimental_telemetry was injected
        expect(opts.experimental_telemetry?.isEnabled).toBe(true);
        return { text: 'hello' };
      },
    };
    const wrapped = wrapAISDK(fakeAi as any);
    const result = await wrapped.generateText({ model: 'fake', prompt: 'hi' });
    expect(result.text).toBe('hello');

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe('ai.generateText');
    expect(spans[0].attributes['openinference.span.kind']).toBe('LLM');
    expect(spans[0].status.code).toBe(SpanStatusCode.UNSET);
  });

  it('preserves user-supplied metadata while forcing neatlogsWrapped: true', async () => {
    let capturedTelemetry: any = null;
    const fakeAi = {
      generateText: async (opts: any) => {
        capturedTelemetry = opts.experimental_telemetry;
        return { text: 'hello' };
      },
    };
    const wrapped = wrapAISDK(fakeAi as any);
    await wrapped.generateText({
      model: 'fake',
      prompt: 'hi',
      experimental_telemetry: {
        metadata: { userId: 'u-7', neatlogsWrapped: false },
      },
    } as any);
    expect(capturedTelemetry.metadata.userId).toBe('u-7');
    expect(capturedTelemetry.metadata.neatlogsWrapped).toBe(true);
    expect(capturedTelemetry.isEnabled).toBe(true);
  });

  it('records exceptions and rethrows', async () => {
    const fakeAi = {
      generateText: async (_opts: any) => {
        throw new Error('boom');
      },
    };
    const wrapped = wrapAISDK(fakeAi as any);
    await expect(wrapped.generateText({ model: 'fake', prompt: 'hi' })).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe('boom');
  });

  it('captures input.value and output.value on the parent span', async () => {
    const fakeAi = {
      generateText: async (_opts: any) => ({ text: 'response-text' }),
    };
    const wrapped = wrapAISDK(fakeAi as any);
    await wrapped.generateText({ model: 'fake', prompt: 'question?' });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const inputJson = spans[0].attributes['input.value'] as string;
    const outputJson = spans[0].attributes['output.value'] as string;
    expect(JSON.parse(inputJson).prompt).toBe('question?');
    expect(JSON.parse(outputJson).text).toBe('response-text');
  });

  it('streamText returns the underlying object synchronously', () => {
    const fakeStream = { textStream: ['a', 'b', 'c'] };
    const fakeAi = {
      streamText: (opts: any) => {
        expect(opts.experimental_telemetry?.isEnabled).toBe(true);
        return fakeStream;
      },
    };
    const wrapped = wrapAISDK(fakeAi as any);
    const result = wrapped.streamText({ model: 'fake', prompt: 'hi' });
    // streamText is sync — the wrapper still must return synchronously
    expect(result).toBe(fakeStream);

    // span ends immediately for streamText (best-effort — full stream lifecycle is out of scope)
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe('ai.streamText');
  });

  it('does nothing when called on an ai module missing all known functions', () => {
    const fakeAi = { irrelevant: 'noop' };
    const wrapped = wrapAISDK(fakeAi as any);
    expect((wrapped as any).irrelevant).toBe('noop');
    // no spans because nothing was called
    expect(exporter.getFinishedSpans().length).toBe(0);
  });

  it('makes child spans nest under the parent (active context)', async () => {
    // Simulates what the AI SDK does internally: opens its own span
    // using the active tracer. With startActiveSpan, our wrapper sets
    // the parent context so this child correctly nests.
    const fakeAi = {
      generateText: async (_opts: any) => {
        const childTracer = trace.getTracer('fake-ai-internal');
        // When using startSpan with the active context, it inherits the parent
        const childSpan = childTracer.startSpan('ai.doGenerate', {}, context.active());
        childSpan.end();
        return { text: 'ok' };
      },
    };
    const wrapped = wrapAISDK(fakeAi as any);
    await wrapped.generateText({ model: 'fake', prompt: 'hi' });

    const spans = exporter.getFinishedSpans();
    // Two spans: parent ai.generateText + child ai.doGenerate
    expect(spans.length).toBe(2);

    const parent = spans.find((s) => s.name === 'ai.generateText');
    const child = spans.find((s) => s.name === 'ai.doGenerate');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();

    // The child must have its parentSpanId set to the parent's spanId
    // (this is the entire architectural purpose of the wrapper).
    expect(child!.parentSpanId).toBe(parent!.spanContext().spanId);
    // And both should share the same trace ID
    expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
  });
});
