import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TracerProvider, Span } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { MastraInstrumentor } from '../src/instrumentation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSpan(): Span & {
  _attributes: Record<string, any>;
  _status: any;
  _ended: boolean;
  _endTime: number | undefined;
  _exceptions: any[];
} {
  const attrs: Record<string, any> = {};
  const span = {
    _attributes: attrs,
    _status: null as any,
    _ended: false,
    _endTime: undefined as number | undefined,
    _exceptions: [] as any[],
    setAttribute: vi.fn((key: string, value: any) => {
      attrs[key] = value;
      return span;
    }),
    setStatus: vi.fn((status: any) => {
      span._status = status;
      return span;
    }),
    end: vi.fn((endTime?: number) => {
      span._ended = true;
      span._endTime = endTime;
    }),
    recordException: vi.fn((err: any) => {
      span._exceptions.push(err);
    }),
    spanContext: vi.fn(() => ({
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: 1,
    })),
    isRecording: vi.fn(() => true),
    updateName: vi.fn(() => span),
    addEvent: vi.fn(() => span),
    addLink: vi.fn(() => span),
    addLinks: vi.fn(() => span),
  };
  return span as any;
}

function createMockTracerProvider(mockSpan: Span): TracerProvider {
  return {
    getTracer: vi.fn(() => ({
      startSpan: vi.fn((_name: string, _opts?: any, _ctx?: any) => mockSpan),
      startActiveSpan: vi.fn(
        (_name: string, _opts: any, fn: (span: Span) => any) => fn(mockSpan),
      ),
    })),
  } as unknown as TracerProvider;
}

/** Build a minimal AnyExportedSpan-shaped object for testing. */
function makeSpan(overrides: Record<string, any> = {}): any {
  return {
    id: 'span-1',
    traceId: 'trace-1',
    name: 'test.span',
    type: 'agent_run',
    startTime: new Date('2024-01-01T00:00:00Z'),
    endTime: new Date('2024-01-01T00:00:01Z'),
    isEvent: false,
    isRootSpan: true,
    attributes: {},
    ...overrides,
  };
}

/** Build a TracingEvent with type=span_ended wrapping the given span. */
function makeEvent(span: any): any {
  return { type: 'span_ended', exportedSpan: span };
}

/** Create a mock @mastra/core module with a Mastra constructor. */
function createMockMastraModule() {
  function Mastra(this: any, config?: any) {
    this.config = config ?? {};
  }
  Mastra.prototype.getAgent = vi.fn();
  return { Mastra };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastraInstrumentor', () => {
  let instrumentor: MastraInstrumentor;
  let mockSpan: ReturnType<typeof createMockSpan>;
  let provider: TracerProvider;
  let mockModule: ReturnType<typeof createMockMastraModule>;

  beforeEach(() => {
    instrumentor = new MastraInstrumentor();
    mockSpan = createMockSpan();
    provider = createMockTracerProvider(mockSpan);
    mockModule = createMockMastraModule();
  });

  afterEach(() => {
    instrumentor.disable();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // instrument() basics
  // -------------------------------------------------------------------------

  describe('instrument()', () => {
    it('should gracefully no-op when Mastra class is missing from the module', () => {
      expect(() =>
        instrumentor.instrument({ tracerProvider: provider, _module: {} }),
      ).not.toThrow();
    });

    it('should patch the Mastra constructor', () => {
      const origMastra = mockModule.Mastra;
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      expect(mockModule.Mastra).not.toBe(origMastra);
    });
  });

  // -------------------------------------------------------------------------
  // Mastra constructor injection
  // -------------------------------------------------------------------------

  describe('Mastra constructor injection', () => {
    it('should inject exporter into observability config when none provided', () => {
      const mockExporter = { name: 'neatlogs', exportTracingEvent: vi.fn() };

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _exporter: mockExporter,
      });

      const instance = new (mockModule.Mastra as any)({ agents: {} });

      expect(instance.config.observability).toEqual({
        configs: {
          default: {
            serviceName: 'mastra',
            exporters: [mockExporter],
          },
        },
      });
    });

    it('should NOT override user-configured observability', () => {
      const mockExporter = { name: 'neatlogs', exportTracingEvent: vi.fn() };
      const userObservability = { custom: true };

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _exporter: mockExporter,
      });

      const instance = new (mockModule.Mastra as any)({
        agents: {},
        observability: userObservability,
      });

      expect(instance.config.observability).toBe(userObservability);
    });

    it('should preserve other config properties when injecting exporter', () => {
      const mockExporter = { name: 'neatlogs', exportTracingEvent: vi.fn() };

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _exporter: mockExporter,
      });

      const instance = new (mockModule.Mastra as any)({
        agents: { myAgent: 'agent-ref' },
        logger: false,
      });

      expect(instance.config.agents).toEqual({ myAgent: 'agent-ref' });
      expect(instance.config.logger).toBe(false);
      expect(instance.config.observability).toBeDefined();
    });

    it('should use exporters array (not bridge) in the injected config', () => {
      const mockExporter = { name: 'neatlogs', exportTracingEvent: vi.fn() };

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _exporter: mockExporter,
      });

      const instance = new (mockModule.Mastra as any)({});
      const defaultConfig = instance.config.observability?.configs?.default;

      expect(defaultConfig).toBeDefined();
      expect(Array.isArray(defaultConfig.exporters)).toBe(true);
      expect(defaultConfig.exporters).toContain(mockExporter);
      expect(defaultConfig.bridge).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // NeatlogsMastraExporter — span conversion
  // -------------------------------------------------------------------------

  describe('NeatlogsMastraExporter (via real exporter injection)', () => {
    it('should ignore non-span_ended events', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });

      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent({ type: 'span_started', exportedSpan: makeSpan() });
      await exporter.exportTracingEvent({ type: 'span_updated', exportedSpan: makeSpan() });

      const tracer = (provider.getTracer as any).mock.results[0]?.value;
      expect(tracer?.startSpan).not.toHaveBeenCalled();
    });

    it('should create an OTel span for span_ended events', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({ type: 'agent_run', name: 'my.agent' })));

      const tracer = (provider.getTracer as any).mock.results[0]?.value;
      expect(tracer.startSpan).toHaveBeenCalledWith(
        'my.agent',
        expect.any(Object),
        expect.anything(),
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'AGENT');
    });

    it('should set span kind correctly for each SpanType', async () => {
      const cases: Array<[string, string]> = [
        ['model_generation', 'LLM'],
        ['model_step', 'LLM'],
        ['tool_call', 'TOOL'],
        ['mcp_tool_call', 'TOOL'],
        ['agent_run', 'AGENT'],
        ['workflow_run', 'WORKFLOW'],
        ['workflow_step', 'CHAIN'],
        ['rag_ingestion', 'RETRIEVER'],
        ['rag_embedding', 'EMBEDDING'],
        ['generic', 'CHAIN'],
      ];

      for (const [spanType, expectedKind] of cases) {
        const localSpan = createMockSpan();
        const localProvider: TracerProvider = {
          getTracer: vi.fn(() => ({
            startSpan: vi.fn(() => localSpan),
          })),
        } as any;

        const localInstrumentor = new MastraInstrumentor();
        const localModule = createMockMastraModule();
        localInstrumentor.instrument({ tracerProvider: localProvider, _module: localModule });

        const inst = new (localModule.Mastra as any)({});
        const exp = inst.config.observability.configs.default.exporters[0];
        await exp.exportTracingEvent(makeEvent(makeSpan({ type: spanType })));

        expect(localSpan.setAttribute).toHaveBeenCalledWith('openinference.span.kind', expectedKind);
        localInstrumentor.disable();
      }
    });

    it('should set LLM attributes for model_generation spans', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'model_generation',
        attributes: {
          model: 'gpt-4o',
          provider: 'openai',
          finishReason: 'stop',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            inputDetails: { cacheRead: 10, cacheWrite: 5 },
            outputDetails: { reasoning: 20 },
          },
        },
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.model_name', 'gpt-4o');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'openai');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.response.finish_reason', 'stop');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.token_count.prompt', 100);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.token_count.completion', 50);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.token_count.total', 150);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.token_count.prompt_details.cache_read', 10);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.token_count.prompt_details.cache_write', 5);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.token_count.completion_details.reasoning', 20);
    });

    it('should flatten input messages to indexed attributes for LLM spans', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'model_generation',
        input: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello!' },
        ],
        output: [
          { role: 'assistant', content: 'Hi there!' },
        ],
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.input_messages.0.message.role', 'system');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.input_messages.0.message.content', 'You are helpful.');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.input_messages.1.message.role', 'user');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.input_messages.1.message.content', 'Hello!');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.output_messages.0.message.role', 'assistant');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('llm.output_messages.0.message.content', 'Hi there!');
    });

    it('should flatten tool calls in output messages', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'model_generation',
        output: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { toolName: 'get_weather', args: { city: 'NYC' } },
            ],
          },
        ],
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'llm.output_messages.0.message.tool_calls.0.tool_call.function.name',
        'get_weather',
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments',
        JSON.stringify({ city: 'NYC' }),
      );
    });

    it('should set input.value / output.value for non-LLM spans', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'agent_run',
        input: [{ role: 'user', content: 'Run this' }],
        output: { result: 'done' },
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'input.value',
        expect.stringContaining('Run this'),
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'output.value',
        expect.stringContaining('done'),
      );
    });

    it('should set session.id from conversationId on agent_run spans', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'agent_run',
        attributes: { conversationId: 'conv-123' },
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('session.id', 'conv-123');
    });

    it('should set tool.name for tool_call spans', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'tool_call',
        name: 'get_weather',
        attributes: { toolDescription: 'Gets weather data' },
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('tool.name', 'get_weather');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('tool.description', 'Gets weather data');
    });

    it('should record error info on failed spans', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'agent_run',
        errorInfo: { message: 'Agent crashed', name: 'Error' },
      })));

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'Agent crashed',
      });
      expect(mockSpan.recordException).toHaveBeenCalled();
    });

    it('should set OK status on successful spans', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({ type: 'agent_run' })));

      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    });

    it('should end the OTel span with the Mastra span endTime', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      const endTime = new Date('2024-06-01T12:00:05Z');
      await exporter.exportTracingEvent(makeEvent(makeSpan({ endTime })));

      expect(mockSpan.end).toHaveBeenCalledWith(endTime.getTime());
    });

    it('should set metadata as JSON attribute when present', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        metadata: { userId: 'u-1', env: 'prod' },
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'metadata',
        JSON.stringify({ userId: 'u-1', env: 'prod' }),
      );
    });

    it('should set tag.tags when tags are present', async () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability.configs.default.exporters[0];

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        tags: ['production', 'v2'],
        isRootSpan: true,
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('tag.tags', ['production', 'v2']);
    });
  });

  // -------------------------------------------------------------------------
  // disable()
  // -------------------------------------------------------------------------

  describe('disable()', () => {
    it('should not throw when called before instrument()', () => {
      expect(() => instrumentor.disable()).not.toThrow();
    });

    it('should allow re-instrumentation after disable', () => {
      instrumentor.instrument({ tracerProvider: provider, _module: mockModule });
      instrumentor.disable();
      expect(() =>
        instrumentor.instrument({ tracerProvider: provider, _module: mockModule }),
      ).not.toThrow();
    });
  });
});
