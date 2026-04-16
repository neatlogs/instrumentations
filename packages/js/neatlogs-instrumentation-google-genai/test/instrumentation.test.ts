import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleGenAIInstrumentation } from '../src/instrumentation.js';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

describe('GoogleGenAIInstrumentation', () => {
  let instrumentation: GoogleGenAIInstrumentation;

  afterEach(() => {
    if (instrumentation) {
      instrumentation.disable();
    }
  });

  it('should instantiate with default config', () => {
    instrumentation = new GoogleGenAIInstrumentation();
    expect(instrumentation).toBeDefined();
    expect(instrumentation.instrumentationName).toBe(
      '@neatlogs/instrumentation-google-genai',
    );
    expect(instrumentation.instrumentationVersion).toBe('0.1.0');
  });

  it('should instantiate with custom config', () => {
    instrumentation = new GoogleGenAIInstrumentation({ enabled: false });
    expect(instrumentation).toBeDefined();
    const config = instrumentation.getConfig();
    expect(config.enabled).toBe(false);
  });

  it('should return module definitions from init', () => {
    instrumentation = new GoogleGenAIInstrumentation();
    const definitions = instrumentation.getModuleDefinitions();
    expect(definitions).toBeDefined();
    expect(definitions.length).toBe(1);
    expect(definitions[0].name).toBe('@google/genai');
    expect(definitions[0].supportedVersions).toEqual(['>=0.1.0']);
  });
});

describe('GoogleGenAIInstrumentation patching', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let instrumentation: GoogleGenAIInstrumentation;
  let mockModelsProto: any;
  let MockGoogleGenAI: any;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

    instrumentation = new GoogleGenAIInstrumentation();
    instrumentation.setTracerProvider(provider);

    // Create mock module that mirrors the real @google/genai SDK structure:
    // - generateContentInternal / generateContentStreamInternal are on the prototype
    // - generateContent / generateContentStream are instance arrow functions
    //   assigned in the constructor that delegate to the internal methods
    mockModelsProto = {
      generateContentInternal: vi.fn(),
      generateContentStreamInternal: vi.fn(),
    };

    MockGoogleGenAI = function (this: any, _config: any) {
      const models = Object.create(mockModelsProto);
      // Simulate instance arrow functions that delegate to internal methods
      models.generateContent = async (...args: any[]) =>
        models.generateContentInternal(...args);
      models.generateContentStream = async (...args: any[]) =>
        models.generateContentStreamInternal(...args);
      this.models = models;
    };

    const mockModule = {
      GoogleGenAI: MockGoogleGenAI,
    };

    // Manually trigger the patch callback
    const definitions = instrumentation.getModuleDefinitions();
    const patchFn = definitions[0].patch;
    if (patchFn) {
      patchFn(mockModule, '1.0.0');
    }
  });

  afterEach(() => {
    instrumentation.disable();
    provider.shutdown();
  });

  it('should patch generateContentInternal on the Models prototype', () => {
    expect(typeof mockModelsProto.generateContentInternal).toBe('function');
    // The patched function should be different from the original mock
    expect(mockModelsProto.generateContentInternal).not.toBe(vi.fn());
  });

  it('should patch generateContentStreamInternal on the Models prototype', () => {
    expect(typeof mockModelsProto.generateContentStreamInternal).toBe('function');
  });

  describe('generateContent', () => {
    it('should create a span with correct attributes for generateContent', async () => {
      const mockResult = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Response text' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
      };

      // Set the internal method to return our mock result
      mockModelsProto.generateContentInternal = vi.fn().mockResolvedValue(mockResult);

      // Re-patch with the new mock
      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      // Create an instance — its arrow function delegates to the patched internal method
      const client = new MockGoogleGenAI({ apiKey: 'test' });
      await client.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
          { role: 'user', parts: [{ text: 'Hello' }] },
        ],
        config: {
          temperature: 0.7,
          maxOutputTokens: 1024,
          topP: 0.9,
          topK: 40,
        },
      });

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);

      const span = spans[0];
      expect(span.name).toBe('gemini-2.0-flash generate');
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.status.code).toBe(SpanStatusCode.OK);

      const attrs = span.attributes;
      expect(attrs['openinference.span.kind']).toBe('LLM');
      expect(attrs['gen_ai.system']).toBe('google_genai');
      expect(attrs['gen_ai.request.model']).toBe('gemini-2.0-flash');
      expect(attrs['llm.model_name']).toBe('gemini-2.0-flash');
      expect(attrs['gen_ai.request.temperature']).toBe(0.7);
      expect(attrs['gen_ai.request.max_tokens']).toBe(1024);
      expect(attrs['gen_ai.request.top_p']).toBe(0.9);
      expect(attrs['gen_ai.request.top_k']).toBe(40);

      // Input messages
      expect(attrs['llm.input_messages.0.message.role']).toBe('user');
      expect(attrs['llm.input_messages.0.message.content']).toBe('Hello');

      // Output messages
      expect(attrs['llm.output_messages.0.message.role']).toBe('model');
      expect(attrs['llm.output_messages.0.message.content']).toBe(
        'Response text',
      );
      expect(attrs['gen_ai.response.finish_reasons']).toEqual(['STOP']);

      // Token counts
      expect(attrs['llm.token_count.prompt']).toBe(10);
      expect(attrs['llm.token_count.completion']).toBe(20);
      expect(attrs['llm.token_count.total']).toBe(30);
      expect(attrs['gen_ai.usage.prompt_tokens']).toBe(10);
      expect(attrs['gen_ai.usage.completion_tokens']).toBe(20);
    });

    it('should handle errors in generateContent', async () => {
      mockModelsProto.generateContentInternal = vi
        .fn()
        .mockRejectedValue(new Error('API error'));

      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      const client = new MockGoogleGenAI({ apiKey: 'test' });
      await expect(
        client.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: [],
        }),
      ).rejects.toThrow('API error');

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('API error');
      expect(spans[0].events.length).toBe(1); // recordException
    });

    it('should handle model name from string request', async () => {
      mockModelsProto.generateContentInternal = vi.fn().mockResolvedValue({ candidates: [] });

      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      const client = new MockGoogleGenAI({ apiKey: 'test' });
      await client.models.generateContent('gemini-pro');

      const spans = exporter.getFinishedSpans();
      expect(spans[0].name).toBe('gemini-pro generate');
    });
  });

  describe('generateContentStream', () => {
    it('should create a span and wrap the stream iterator', async () => {
      const chunks = [
        {
          candidates: [
            { content: { parts: [{ text: 'Hello' }] } },
          ],
        },
        {
          candidates: [
            {
              content: { parts: [{ text: ' World' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 3,
            totalTokenCount: 8,
          },
        },
      ];

      const mockStream = {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            async next() {
              if (idx < chunks.length) {
                return { done: false, value: chunks[idx++] };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };

      mockModelsProto.generateContentStreamInternal = vi.fn().mockResolvedValue(mockStream);

      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      const client = new MockGoogleGenAI({ apiKey: 'test' });
      const stream = await client.models.generateContentStream({
        model: 'gemini-2.0-flash',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
        ],
      });

      // Consume the stream
      const collected: any[] = [];
      for await (const chunk of stream) {
        collected.push(chunk);
      }

      expect(collected.length).toBe(2);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);

      const span = spans[0];
      expect(span.name).toBe('gemini-2.0-flash stream');
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.status.code).toBe(SpanStatusCode.OK);

      const attrs = span.attributes;
      expect(attrs['llm.output_messages.0.message.content']).toBe(
        'Hello World',
      );
      expect(attrs['llm.output_messages.0.message.role']).toBe('model');
      expect(attrs['gen_ai.response.finish_reasons']).toEqual(['STOP']);
      expect(attrs['llm.token_count.prompt']).toBe(5);
      expect(attrs['llm.token_count.completion']).toBe(3);
      expect(attrs['llm.token_count.total']).toBe(8);
    });

    it('should handle stream errors', async () => {
      const mockStream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error('Stream error');
            },
          };
        },
      };

      mockModelsProto.generateContentStreamInternal = vi.fn().mockResolvedValue(mockStream);

      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      const client = new MockGoogleGenAI({ apiKey: 'test' });
      const stream = await client.models.generateContentStream({
        model: 'gemini-2.0-flash',
        contents: [],
      });

      await expect(async () => {
        for await (const _chunk of stream) {
          // consume
        }
      }).rejects.toThrow('Stream error');

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    });

    it('should handle early stream termination via return()', async () => {
      let nextCallCount = 0;
      const mockStream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCallCount++;
              return {
                done: false,
                value: {
                  candidates: [
                    { content: { parts: [{ text: `chunk${nextCallCount}` }] } },
                  ],
                },
              };
            },
            async return(val?: any) {
              return { done: true as const, value: val };
            },
          };
        },
      };

      mockModelsProto.generateContentStreamInternal = vi.fn().mockResolvedValue(mockStream);

      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      const client = new MockGoogleGenAI({ apiKey: 'test' });
      const stream = await client.models.generateContentStream({
        model: 'gemini-2.0-flash',
        contents: [],
      });

      // Consume only one chunk then break
      for await (const _chunk of stream) {
        break;
      }

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    });

    it('should copy non-iterator properties from original stream', async () => {
      const mockStream = {
        customProp: 'test-value',
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true, value: undefined };
            },
          };
        },
      };

      mockModelsProto.generateContentStreamInternal = vi.fn().mockResolvedValue(mockStream);

      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      const client = new MockGoogleGenAI({ apiKey: 'test' });
      const stream = await client.models.generateContentStream({
        model: 'gemini-2.0-flash',
        contents: [],
      });

      expect((stream as any).customProp).toBe('test-value');
    });
  });

  describe('stream span lifecycle', () => {
    it('should end the span even when the stream is returned but the iterator is never started', async () => {
      // Regression guard: if a caller gets the stream object but never touches its
      // asyncIterator (e.g., error in the caller before the for-await loop), the span
      // must still be ended. Without explicit cleanup, the span leaks permanently.
      const mockStream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false,
                value: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
              };
            },
            async return(val?: any) {
              return { done: true as const, value: val };
            },
          };
        },
      };

      mockModelsProto.generateContentStreamInternal = vi.fn().mockResolvedValue(mockStream);

      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      const client = new MockGoogleGenAI({ apiKey: 'test' });
      // Get the stream object but NEVER iterate it — simulate caller abandoning it
      const stream = await client.models.generateContentStream({
        model: 'gemini-2.0-flash',
        contents: [],
      });
      expect(stream).toBeDefined();

      // Without any iteration, the span would be leaked.
      // Clean up by calling return() on the iterator (what for-await does on break/gc).
      const iter = stream[Symbol.asyncIterator]();
      await iter.return?.();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    });
  });

  describe('unpatch', () => {
    it('should restore original internal methods on unpatch', () => {
      const originalGenerate = vi.fn();
      const originalStream = vi.fn();
      mockModelsProto.generateContentInternal = originalGenerate;
      mockModelsProto.generateContentStreamInternal = originalStream;

      // Re-patch with known originals
      const definitions = instrumentation.getModuleDefinitions();
      definitions[0].patch!(
        { GoogleGenAI: MockGoogleGenAI },
        '1.0.0',
      );

      // After patching, methods should be wrapped (different references)
      expect(mockModelsProto.generateContentInternal).not.toBe(originalGenerate);
      expect(mockModelsProto.generateContentStreamInternal).not.toBe(originalStream);

      const unpatchFn = definitions[0].unpatch;
      if (unpatchFn) {
        unpatchFn({ GoogleGenAI: MockGoogleGenAI }, '1.0.0');
      }

      // After unpatching, original functions should be restored
      expect(mockModelsProto.generateContentInternal).toBe(originalGenerate);
      expect(mockModelsProto.generateContentStreamInternal).toBe(originalStream);
    });
  });
});
