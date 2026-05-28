import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TracerProvider, Span } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { MastraInstrumentor, NeatlogsMastraExporter, createNeatlogsMastraObservability } from '../src/instrumentation.js';

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

/**
 * Create a mock @mastra/core module with a Mastra constructor.
 *
 * Mimics real Mastra validation: accepts observability only when
 * typeof observability.getDefaultInstance === 'function'; otherwise
 * stores a no-op marker so tests can detect the difference.
 */
function createMockMastraModule() {
  function Mastra(this: any, config?: any) {
    const cfg = config ?? {};
    if (
      cfg.observability &&
      typeof cfg.observability.getDefaultInstance === 'function'
    ) {
      this.config = cfg;
    } else {
      // Observability is missing or invalid — store config without it
      const { observability: _dropped, ...rest } = cfg;
      this.config = { ...rest, observability: undefined };
    }
  }
  Mastra.prototype.getAgent = vi.fn();
  return { Mastra };
}

/**
 * Create a mock @mastra/observability module that provides a minimal
 * Observability constructor matching the real API shape.
 */
function createMockObservabilityModule() {
  class MockObservabilityInstance {
    private _exporters: any[];
    constructor(exporters: any[]) {
      this._exporters = exporters;
    }
    getExporters() {
      return this._exporters;
    }
    createSpan() {
      return {};
    }
  }

  class Observability {
    private _instance: MockObservabilityInstance;
    constructor(opts: any) {
      const defaultCfg = opts?.configs?.default;
      this._instance = new MockObservabilityInstance(
        defaultCfg?.exporters ?? [],
      );
    }
    getDefaultInstance() {
      return this._instance;
    }
  }
  return { Observability };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastraInstrumentor', () => {
  let instrumentor: MastraInstrumentor;
  let mockSpan: ReturnType<typeof createMockSpan>;
  let provider: TracerProvider;
  let mockModule: ReturnType<typeof createMockMastraModule>;
  let mockObsModule: ReturnType<typeof createMockObservabilityModule>;

  beforeEach(() => {
    instrumentor = new MastraInstrumentor();
    mockSpan = createMockSpan();
    provider = createMockTracerProvider(mockSpan);
    mockModule = createMockMastraModule();
    mockObsModule = createMockObservabilityModule();
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
      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _observabilityModule: mockObsModule,
      });
      expect(mockModule.Mastra).not.toBe(origMastra);
    });
  });

  // -------------------------------------------------------------------------
  // Mastra constructor injection
  // -------------------------------------------------------------------------

  describe('Mastra constructor injection', () => {
    it('should inject observability with exporter accessible via getDefaultInstance().getExporters()', () => {
      const mockExporter = new NeatlogsMastraExporter(provider);

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _exporter: mockExporter,
        _observabilityModule: mockObsModule,
      });

      const instance = new (mockModule.Mastra as any)({ agents: {} });

      // The injected observability must be a real Observability instance
      expect(instance.config.observability).toBeDefined();
      expect(typeof instance.config.observability.getDefaultInstance).toBe('function');

      const defaultInstance = instance.config.observability.getDefaultInstance();
      const exporters = defaultInstance.getExporters();
      expect(exporters).toContain(mockExporter);
    });

    it('should NOT override user-configured observability', () => {
      const mockExporter = new NeatlogsMastraExporter(provider);
      // User provides a proper Observability-shaped object
      const userObservability = {
        getDefaultInstance: () => ({
          getExporters: () => [],
        }),
        custom: true,
      };

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _exporter: mockExporter,
        _observabilityModule: mockObsModule,
      });

      const instance = new (mockModule.Mastra as any)({
        agents: {},
        observability: userObservability,
      });

      expect(instance.config.observability).toBe(userObservability);
    });

    it('should preserve other config properties when injecting exporter', () => {
      const mockExporter = new NeatlogsMastraExporter(provider);

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _exporter: mockExporter,
        _observabilityModule: mockObsModule,
      });

      const instance = new (mockModule.Mastra as any)({
        agents: { myAgent: 'agent-ref' },
        logger: false,
      });

      expect(instance.config.agents).toEqual({ myAgent: 'agent-ref' });
      expect(instance.config.logger).toBe(false);
      expect(instance.config.observability).toBeDefined();
    });

    it('should contain exporter in getDefaultInstance().getExporters() array', () => {
      const mockExporter = new NeatlogsMastraExporter(provider);

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _exporter: mockExporter,
        _observabilityModule: mockObsModule,
      });

      const instance = new (mockModule.Mastra as any)({});
      const defaultInstance = instance.config.observability.getDefaultInstance();

      expect(defaultInstance).toBeDefined();
      const exporters = defaultInstance.getExporters();
      expect(Array.isArray(exporters)).toBe(true);
      expect(exporters).toContain(mockExporter);
    });
  });

  // -------------------------------------------------------------------------
  // @mastra/observability fallback
  // -------------------------------------------------------------------------

  describe('@mastra/observability fallback', () => {
    it('should skip injection when @mastra/observability is unavailable', () => {
      // Provide an observability module that will cause require to fail
      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _observabilityModule: {}, // No Observability export
      });

      const instance = new (mockModule.Mastra as any)({ agents: {} });

      // observability should be undefined — not a plain object
      expect(instance.config.observability).toBeUndefined();
    });

    it('should skip injection when Observability is not a function', () => {
      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _observabilityModule: { Observability: 'not-a-function' },
      });

      const instance = new (mockModule.Mastra as any)({ agents: {} });
      expect(instance.config.observability).toBeUndefined();
    });

    it('should skip injection when Observability constructor throws', () => {
      const badObsModule = {
        Observability: function () {
          throw new Error('boom');
        },
      };

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _observabilityModule: badObsModule,
      });

      const instance = new (mockModule.Mastra as any)({ agents: {} });
      expect(instance.config.observability).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // NeatlogsMastraExporter — span conversion
  // -------------------------------------------------------------------------

  describe('NeatlogsMastraExporter (via real exporter injection)', () => {
    /** Instrument, create a Mastra instance, and return the injected exporter. */
    function setupExporter(): { instance: any; exporter: any } {
      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _observabilityModule: mockObsModule,
      });
      const instance = new (mockModule.Mastra as any)({});
      const exporter = instance.config.observability
        .getDefaultInstance()
        .getExporters()[0];
      return { instance, exporter };
    }

    it('should ignore span_updated events', async () => {
      const { exporter } = setupExporter();

      await exporter.exportTracingEvent({ type: 'span_updated', exportedSpan: makeSpan() });

      const tracer = (provider.getTracer as any).mock.results[0]?.value;
      expect(tracer?.startSpan).not.toHaveBeenCalled();
    });

    it('should process span_started events (opens an OTel span)', async () => {
      const { exporter } = setupExporter();

      await exporter.exportTracingEvent({ type: 'span_started', exportedSpan: makeSpan() });

      const tracer = (provider.getTracer as any).mock.results[0]?.value;
      expect(tracer?.startSpan).toHaveBeenCalledTimes(1);
      // span_started should NOT end the span — it stays active
      expect(mockSpan.end).not.toHaveBeenCalled();
    });

    it('should create an OTel span for span_ended events', async () => {
      const { exporter } = setupExporter();

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

      // NeatlogsMastraExporter is directly constructable — no need for a
      // full instrumentor/module/Mastra-instance per test case.
      for (const [spanType, expectedKind] of cases) {
        const localSpan = createMockSpan();
        const localProvider: TracerProvider = {
          getTracer: vi.fn(() => ({
            startSpan: vi.fn(() => localSpan),
          })),
        } as any;

        const exporter = new NeatlogsMastraExporter(localProvider);
        await exporter.exportTracingEvent(makeEvent(makeSpan({ type: spanType })));

        expect(localSpan.setAttribute).toHaveBeenCalledWith('openinference.span.kind', expectedKind);
      }
    });

    it('should set LLM attributes for model_generation spans', async () => {
      const { exporter } = setupExporter();

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
      const { exporter } = setupExporter();

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
      const { exporter } = setupExporter();

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
      const { exporter } = setupExporter();

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
      const { exporter } = setupExporter();

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'agent_run',
        attributes: { conversationId: 'conv-123' },
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('session.id', 'conv-123');
    });

    it('should set tool.name for tool_call spans', async () => {
      const { exporter } = setupExporter();

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'tool_call',
        name: 'get_weather',
        attributes: { toolDescription: 'Gets weather data' },
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('tool.name', 'get_weather');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('tool.description', 'Gets weather data');
    });

    it('should record error info on failed spans', async () => {
      const { exporter } = setupExporter();

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
      const { exporter } = setupExporter();

      await exporter.exportTracingEvent(makeEvent(makeSpan({ type: 'agent_run' })));

      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    });

    it('should end the OTel span with the Mastra span endTime', async () => {
      const { exporter } = setupExporter();

      const endTime = new Date('2024-06-01T12:00:05Z');
      await exporter.exportTracingEvent(makeEvent(makeSpan({ endTime })));

      expect(mockSpan.end).toHaveBeenCalledWith(endTime.getTime());
    });

    it('should set metadata as JSON attribute when present', async () => {
      const { exporter } = setupExporter();

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        metadata: { userId: 'u-1', env: 'prod' },
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'metadata',
        JSON.stringify({ userId: 'u-1', env: 'prod' }),
      );
    });

    it('should set tag.tags when tags are present', async () => {
      const { exporter } = setupExporter();

      await exporter.exportTracingEvent(makeEvent(makeSpan({
        tags: ['production', 'v2'],
        isRootSpan: true,
      })));

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('tag.tags', ['production', 'v2']);
    });
  });

  // -------------------------------------------------------------------------
  // createNeatlogsMastraObservability helper
  // -------------------------------------------------------------------------

  describe('createNeatlogsMastraObservability()', () => {
    it('should return observability and exporter', () => {
      const result = createNeatlogsMastraObservability(provider, {
        _observabilityModule: mockObsModule,
      });

      expect(result.observability).toBeDefined();
      expect(result.exporter).toBeInstanceOf(NeatlogsMastraExporter);
    });

    it('should have exporter accessible via getDefaultInstance().getExporters()', () => {
      const result = createNeatlogsMastraObservability(provider, {
        _observabilityModule: mockObsModule,
      });

      const exporters = result.observability.getDefaultInstance().getExporters();
      expect(exporters).toContain(result.exporter);
    });

    it('should use provided exporter when options.exporter is supplied', () => {
      const customExporter = new NeatlogsMastraExporter(provider);
      const result = createNeatlogsMastraObservability(provider, {
        exporter: customExporter,
        _observabilityModule: mockObsModule,
      });

      expect(result.exporter).toBe(customExporter);
      const exporters = result.observability.getDefaultInstance().getExporters();
      expect(exporters).toContain(customExporter);
    });

    it('should throw when @mastra/observability is missing', () => {
      expect(() =>
        createNeatlogsMastraObservability(provider, {
          _observabilityModule: {},
        }),
      ).toThrow('@mastra/observability does not export a valid Observability constructor');
    });

    it('should throw when Observability is not a function', () => {
      expect(() =>
        createNeatlogsMastraObservability(provider, {
          _observabilityModule: { Observability: 42 },
        }),
      ).toThrow('@mastra/observability does not export a valid Observability constructor');
    });

    it('should route exported spans to the provided tracerProvider', async () => {
      const result = createNeatlogsMastraObservability(provider, {
        _observabilityModule: mockObsModule,
      });

      // Send a span through the exporter
      await result.exporter.exportTracingEvent(makeEvent(makeSpan({
        type: 'agent_run',
        name: 'helper.test.agent',
      })));

      // Verify the provider's tracer was used
      const tracer = (provider.getTracer as any).mock.results[0]?.value;
      expect(tracer.startSpan).toHaveBeenCalledWith(
        'helper.test.agent',
        expect.any(Object),
        expect.anything(),
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'AGENT');
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Export shape test
  // -------------------------------------------------------------------------

  describe('export shape', () => {
    it('should export all public API from index', async () => {
      const mod = await import('../src/index.js');
      // Default export is the instrumentor class
      expect(typeof mod.default).toBe('function');
      expect(mod.default).toBe(MastraInstrumentor);
      // Named exports
      expect(typeof mod.MastraInstrumentor).toBe('function');
      expect(typeof mod.NeatlogsMastraExporter).toBe('function');
      expect(typeof mod.createNeatlogsMastraObservability).toBe('function');
      // Instrumentor has an instrument() method
      const inst = new mod.MastraInstrumentor();
      expect(typeof inst.instrument).toBe('function');
    });
  });

  // NOTE: ESM namespace objects (from dynamic import()) are frozen/read-only,
  // so monkey-patching `Mastra` on a true ESM namespace is not possible.
  // The instrumentation uses require() (CJS) to obtain a mutable exports
  // object.  When the export descriptor is non-configurable (e.g. CJS
  // re-exports of ESM), _patchMastraConstructor detects this and bails out.

  // -------------------------------------------------------------------------
  // Non-configurable export descriptor handling
  // -------------------------------------------------------------------------

  describe('non-configurable export descriptor', () => {
    it('should bail out gracefully when Mastra export has a non-configurable getter', () => {
      const nonConfigModule: any = {};
      Object.defineProperty(nonConfigModule, 'Mastra', {
        get: () => mockModule.Mastra,
        configurable: false,
      });

      instrumentor.instrument({
        tracerProvider: provider,
        _module: nonConfigModule,
        _observabilityModule: mockObsModule,
      });

      // The original constructor should still be in place — patch was skipped
      expect(nonConfigModule.Mastra).toBe(mockModule.Mastra);
    });

    it('should bail out when assignment silently no-ops (non-writable)', () => {
      const nonWritableModule: any = {};
      Object.defineProperty(nonWritableModule, 'Mastra', {
        value: mockModule.Mastra,
        writable: false,
        configurable: false,
      });

      instrumentor.instrument({
        tracerProvider: provider,
        _module: nonWritableModule,
        _observabilityModule: mockObsModule,
      });

      // The original constructor should still be in place
      expect(nonWritableModule.Mastra).toBe(mockModule.Mastra);
    });

    it('should bail out and warn when export is non-configurable but writable (sealed CJS bundle case)', () => {
      // This reproduces the real @mastra/core@1.25.x case: configurable:false,
      // writable:true, no getter.  The old guard (!desc.configurable && (desc.get
      // || !desc.writable)) evaluated to false here and fell through to the
      // assignment, which throws in strict mode (CJS strict) — leaving the
      // module unpatched with no user-visible warning.
      const sealedModule: any = {};
      Object.defineProperty(sealedModule, 'Mastra', {
        value: mockModule.Mastra,
        writable: true,
        configurable: false,
      });

      const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      instrumentor.instrument({
        tracerProvider: provider,
        _module: sealedModule,
        _observabilityModule: mockObsModule,
      });

      // The original constructor should still be in place — patch was skipped
      expect(sealedModule.Mastra).toBe(mockModule.Mastra);

      // A user-visible warning must have been emitted
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[neatlogs] Cannot patch @mastra/core'),
      );

      warnSpy.mockRestore();
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
      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _observabilityModule: mockObsModule,
      });
      instrumentor.disable();
      expect(() =>
        instrumentor.instrument({
          tracerProvider: provider,
          _module: mockModule,
          _observabilityModule: mockObsModule,
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // @mastra/observability warning
  // -------------------------------------------------------------------------

  describe('@mastra/observability warning', () => {
    it('should emit a warning when observability module is unavailable', () => {
      const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      instrumentor.instrument({
        tracerProvider: provider,
        _module: mockModule,
        _observabilityModule: {}, // No Observability export
      });

      // Trigger the Mastra constructor which tries to create observability
      new (mockModule.Mastra as any)({});

      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('[neatlogs] Mastra instrumentation could not activate'),
      );

      writeSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Span grouping (lifecycle-aware)
  // -------------------------------------------------------------------------

  describe('span grouping (lifecycle)', () => {
    it('span_started followed by span_ended creates exactly one OTel span and ends it', async () => {
      const exporter = new NeatlogsMastraExporter(provider);
      const spanData = makeSpan({ id: 'root-1', type: 'workflow_run', name: 'my.workflow' });

      await exporter.exportTracingEvent({ type: 'span_started', exportedSpan: spanData });
      expect(mockSpan.end).not.toHaveBeenCalled();

      await exporter.exportTracingEvent({ type: 'span_ended', exportedSpan: { ...spanData, endTime: new Date('2024-01-01T00:00:05Z') } });
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'WORKFLOW');

      // Only one OTel span was started total
      const tracer = (provider.getTracer as any).mock.results[0]?.value;
      expect(tracer.startSpan).toHaveBeenCalledTimes(1);
    });

    it('child span_started receives parent context from the parent started span', async () => {
      // Use a more detailed mock so we can track contexts
      const parentSpanObj = createMockSpan();
      const childSpanObj = createMockSpan();
      let callCount = 0;
      const tracerWithMultiSpan: any = {
        startSpan: vi.fn((_name: string, _opts?: any, _ctx?: any) => {
          callCount++;
          return callCount === 1 ? parentSpanObj : childSpanObj;
        }),
      };
      const multiProvider: TracerProvider = {
        getTracer: vi.fn(() => tracerWithMultiSpan),
      } as any;

      const exporter = new NeatlogsMastraExporter(multiProvider);

      // Start parent
      await exporter.exportTracingEvent({
        type: 'span_started',
        exportedSpan: makeSpan({ id: 'parent-1', name: 'parent' }),
      });

      // Start child referencing parent
      await exporter.exportTracingEvent({
        type: 'span_started',
        exportedSpan: makeSpan({ id: 'child-1', parentSpanId: 'parent-1', name: 'child' }),
      });

      // Verify child was started with a non-ROOT context (the parent's context)
      const childStartCall = tracerWithMultiSpan.startSpan.mock.calls[1];
      const childContext = childStartCall[2];
      // The child context should not be ROOT_CONTEXT since parent existed
      // It should contain the parent span
      expect(childContext).toBeDefined();
      // The context passed for child should not equal ROOT_CONTEXT (it has the parent span set)
      const { ROOT_CONTEXT } = await import('@opentelemetry/api');
      expect(childContext).not.toBe(ROOT_CONTEXT);
    });

    it('ended-only fallback with valid traceId and parentSpanId uses a non-recording parent context', async () => {
      const validTraceId = 'a'.repeat(32);
      const validParentSpanId = 'b'.repeat(16);

      const tracerSpy: any = {
        startSpan: vi.fn((_name: string, _opts?: any, _ctx?: any) => mockSpan),
      };
      const spyProvider: TracerProvider = {
        getTracer: vi.fn(() => tracerSpy),
      } as any;

      const exporter = new NeatlogsMastraExporter(spyProvider);

      // Send span_ended directly (no span_started) with valid parent IDs
      await exporter.exportTracingEvent({
        type: 'span_ended',
        exportedSpan: makeSpan({
          id: 'orphan-1',
          traceId: validTraceId,
          parentSpanId: validParentSpanId,
          name: 'orphan.span',
        }),
      });

      // The span should have been started with a context that is not ROOT_CONTEXT
      const startCall = tracerSpy.startSpan.mock.calls[0];
      const usedContext = startCall[2];
      const { ROOT_CONTEXT } = await import('@opentelemetry/api');
      expect(usedContext).not.toBe(ROOT_CONTEXT);
    });

    it('ended-only fallback with invalid IDs falls back to ROOT_CONTEXT', async () => {
      const tracerSpy: any = {
        startSpan: vi.fn((_name: string, _opts?: any, _ctx?: any) => mockSpan),
      };
      const spyProvider: TracerProvider = {
        getTracer: vi.fn(() => tracerSpy),
      } as any;

      const exporter = new NeatlogsMastraExporter(spyProvider);

      // Send span_ended with invalid IDs (non-hex, wrong length)
      await exporter.exportTracingEvent({
        type: 'span_ended',
        exportedSpan: makeSpan({
          id: 'orphan-2',
          traceId: 'not-valid',
          parentSpanId: 'also-invalid',
          name: 'invalid.span',
        }),
      });

      const startCall = tracerSpy.startSpan.mock.calls[0];
      const usedContext = startCall[2];
      const { ROOT_CONTEXT } = await import('@opentelemetry/api');
      expect(usedContext).toBe(ROOT_CONTEXT);
    });

    it('missing-parent child start does not throw and does not leak active state after end', async () => {
      const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exporter = new NeatlogsMastraExporter(provider);

      // Start child with non-existent parent — should not throw
      await expect(
        exporter.exportTracingEvent({
          type: 'span_started',
          exportedSpan: makeSpan({ id: 'orphan-child', parentSpanId: 'missing-parent', name: 'orphan' }),
        }),
      ).resolves.not.toThrow();

      expect(exporter.activeSpanCount).toBe(1);

      // End the orphan child
      await exporter.exportTracingEvent({
        type: 'span_ended',
        exportedSpan: makeSpan({ id: 'orphan-child', parentSpanId: 'missing-parent', name: 'orphan', endTime: new Date() }),
      });

      expect(exporter.activeSpanCount).toBe(0);
      warnSpy.mockRestore();
    });

    it('flush() does not end active spans (safe for mid-workflow calls)', async () => {
      const exporter = new NeatlogsMastraExporter(provider);

      // Start spans but don't end them
      await exporter.exportTracingEvent({
        type: 'span_started',
        exportedSpan: makeSpan({ id: 'leak-1', name: 'leaked' }),
      });
      await exporter.exportTracingEvent({
        type: 'span_started',
        exportedSpan: makeSpan({ id: 'leak-2', name: 'leaked2' }),
      });

      expect(exporter.activeSpanCount).toBe(2);

      await exporter.flush();

      // flush() should NOT end active spans — they may still be in progress
      expect(exporter.activeSpanCount).toBe(2);
      expect(mockSpan.end).not.toHaveBeenCalled();
    });

    it('shutdown() ends and clears active spans', async () => {
      const exporter = new NeatlogsMastraExporter(provider);

      await exporter.exportTracingEvent({
        type: 'span_started',
        exportedSpan: makeSpan({ id: 'shutdown-1', name: 'to-shutdown' }),
      });
      await exporter.exportTracingEvent({
        type: 'span_started',
        exportedSpan: makeSpan({ id: 'shutdown-2', name: 'to-shutdown2' }),
      });

      expect(exporter.activeSpanCount).toBe(2);

      await exporter.shutdown();

      expect(exporter.activeSpanCount).toBe(0);
      // shutdown() should end the spans
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Real in-memory provider integration test
// ---------------------------------------------------------------------------

describe('NeatlogsMastraExporter (real provider)', () => {
  it('all related Mastra spans share the same non-zero traceId with valid parent-child relationships', async () => {
    const { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');

    const memExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider();
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(memExporter));

    const exporter = new NeatlogsMastraExporter(tracerProvider);

    const now = Date.now();

    // Simulate a Mastra workflow with parent → child spans
    // 1. Start parent (workflow_run)
    await exporter.exportTracingEvent({
      type: 'span_started',
      exportedSpan: {
        id: 'wf-root',
        traceId: 'mastra-trace-1',
        name: 'my-workflow',
        type: 'workflow_run',
        startTime: new Date(now),
        isRootSpan: true,
        attributes: {},
      },
    });

    // 2. Start child 1 (agent_run)
    await exporter.exportTracingEvent({
      type: 'span_started',
      exportedSpan: {
        id: 'agent-1',
        traceId: 'mastra-trace-1',
        parentSpanId: 'wf-root',
        name: 'my-agent',
        type: 'agent_run',
        startTime: new Date(now + 10),
        isRootSpan: false,
        attributes: {},
      },
    });

    // 3. Start child 2 (tool_call, child of agent)
    await exporter.exportTracingEvent({
      type: 'span_started',
      exportedSpan: {
        id: 'tool-1',
        traceId: 'mastra-trace-1',
        parentSpanId: 'agent-1',
        name: 'get_weather',
        type: 'tool_call',
        startTime: new Date(now + 20),
        isRootSpan: false,
        attributes: {},
      },
    });

    // 4. End tool
    await exporter.exportTracingEvent({
      type: 'span_ended',
      exportedSpan: {
        id: 'tool-1',
        traceId: 'mastra-trace-1',
        parentSpanId: 'agent-1',
        name: 'get_weather',
        type: 'tool_call',
        startTime: new Date(now + 20),
        endTime: new Date(now + 50),
        isRootSpan: false,
        attributes: {},
        output: { result: 'sunny' },
      },
    });

    // 5. End agent
    await exporter.exportTracingEvent({
      type: 'span_ended',
      exportedSpan: {
        id: 'agent-1',
        traceId: 'mastra-trace-1',
        parentSpanId: 'wf-root',
        name: 'my-agent',
        type: 'agent_run',
        startTime: new Date(now + 10),
        endTime: new Date(now + 100),
        isRootSpan: false,
        attributes: {},
        output: { message: 'done' },
      },
    });

    // 6. End workflow
    await exporter.exportTracingEvent({
      type: 'span_ended',
      exportedSpan: {
        id: 'wf-root',
        traceId: 'mastra-trace-1',
        name: 'my-workflow',
        type: 'workflow_run',
        startTime: new Date(now),
        endTime: new Date(now + 150),
        isRootSpan: true,
        attributes: {},
        output: { status: 'completed' },
      },
    });

    // Force flush to ensure all spans are exported
    await tracerProvider.forceFlush();

    const spans = memExporter.getFinishedSpans();

    // Exactly 3 OTel spans produced (one per Mastra span)
    expect(spans).toHaveLength(3);

    // All share the same non-zero traceId
    const traceIds = new Set(spans.map(s => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
    const traceId = [...traceIds][0];
    expect(traceId).not.toMatch(/^0+$/);
    expect(traceId).toHaveLength(32);

    // No all-zero span IDs
    for (const span of spans) {
      expect(span.spanContext().spanId).not.toMatch(/^0+$/);
      expect(span.spanContext().spanId).toHaveLength(16);
    }

    // Verify parent-child relationships
    const rootSpan = spans.find(s => s.name === 'my-workflow')!;
    const agentSpan = spans.find(s => s.name === 'my-agent')!;
    const toolSpan = spans.find(s => s.name === 'get_weather')!;

    expect(rootSpan).toBeDefined();
    expect(agentSpan).toBeDefined();
    expect(toolSpan).toBeDefined();

    // Agent's parentSpanId should be the workflow's spanId
    expect(agentSpan.parentSpanId).toBe(rootSpan.spanContext().spanId);

    // Tool's parentSpanId should be the agent's spanId
    expect(toolSpan.parentSpanId).toBe(agentSpan.spanContext().spanId);

    // Root span should have no parent (undefined or zero-padded)
    expect(
      rootSpan.parentSpanId === undefined ||
      rootSpan.parentSpanId === '' ||
      /^0{16}$/.test(rootSpan.parentSpanId)
    ).toBe(true);

    // Cleanup
    await tracerProvider.shutdown();
  });
});
