import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { MastraInstrumentation } from '../src/instrumentation.js';

describe('MastraInstrumentation', () => {
  let instrumentation: MastraInstrumentation;

  beforeEach(() => {
    instrumentation = new MastraInstrumentation();
  });

  afterEach(() => {
    instrumentation.disable();
  });

  it('should instantiate with default config', () => {
    expect(instrumentation).toBeDefined();
    expect(instrumentation.instrumentationName).toBe('@neatlogs/instrumentation-mastra');
    expect(instrumentation.instrumentationVersion).toBe('0.1.0');
  });

  it('should instantiate with custom config', () => {
    const customInstrumentation = new MastraInstrumentation({ enabled: false });
    expect(customInstrumentation).toBeDefined();
    customInstrumentation.disable();
  });

  it('should return an InstrumentationNodeModuleDefinition from init', () => {
    const moduleDef = (instrumentation as any).init();
    expect(moduleDef).toBeDefined();
    expect(moduleDef.name).toBe('@mastra/core');
    // No InstrumentationNodeModuleFile entries — subpath modules are
    // dynamically required inside the root patch callback instead,
    // because require-in-the-middle resolves subpath imports to internal
    // file paths (e.g. @mastra/core/dist/agent/index.cjs) that cannot
    // be reliably matched by InstrumentationNodeModuleFile names.
    expect(moduleDef.files).toEqual([]);
  });

  describe('_getOrCreateSpan', () => {
    let provider: NodeTracerProvider;
    let exporter: InMemorySpanExporter;

    beforeEach(() => {
      exporter = new InMemorySpanExporter();
      provider = new NodeTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      provider.register();
      instrumentation.setTracerProvider(provider);
    });

    afterEach(async () => {
      exporter.reset();
      await provider.shutdown();
    });

    it('should create a new span when no active span exists', async () => {
      const result = await (instrumentation as any)._getOrCreateSpan(
        'test.span',
        async (span: any) => {
          span.setAttribute('test.attr', 'value');
          return 'result';
        },
      );

      expect(result).toBe('result');
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('test.span');
      expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    });

    it('should record error when fn throws and no active span', async () => {
      const error = new Error('test error');
      await expect(
        (instrumentation as any)._getOrCreateSpan(
          'test.error.span',
          async () => {
            throw error;
          },
        ),
      ).rejects.toThrow('test error');

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('test error');
      expect(spans[0].events.length).toBe(1); // exception event
    });

    it('should enrich existing active span when one exists', async () => {
      const tracer = provider.getTracer('test');

      const spansBeforeTest = exporter.getFinishedSpans().length;

      let innerResult: string | undefined;
      await tracer.startActiveSpan('parent.span', async (parentSpan) => {
        innerResult = await (instrumentation as any)._getOrCreateSpan(
          'should.not.be.used',
          async (span: any) => {
            span.setAttribute('enriched.attr', 'enriched-value');
            return 'enriched-result';
          },
        );
        parentSpan.end();
      });

      expect(innerResult).toBe('enriched-result');

      const spans = exporter.getFinishedSpans();
      // Only 1 new span should have been created (the parent)
      // _getOrCreateSpan should NOT create a new one since activeSpan exists
      const newSpans = spans.slice(spansBeforeTest);
      expect(newSpans.length).toBe(1);
      expect(newSpans[0].name).toBe('parent.span');
      // The enriched attribute should be on the parent span
      expect(newSpans[0].attributes['enriched.attr']).toBe('enriched-value');
    });
  });

  describe('patching', () => {
    it('should patch Agent.prototype.generate', () => {
      const originalGenerate = vi.fn();
      const mockAgent = {
        prototype: {
          generate: originalGenerate,
        },
      };
      const moduleExports = { Agent: mockAgent };
      (instrumentation as any)._patch(moduleExports);

      // The generate function should have been wrapped (not the same reference)
      expect(mockAgent.prototype.generate).not.toBe(originalGenerate);
    });

    it('should patch Workflow.prototype.execute', () => {
      const originalExecute = vi.fn();
      const mockWorkflow = {
        prototype: {
          execute: originalExecute,
        },
      };
      const moduleExports = { Workflow: mockWorkflow };
      (instrumentation as any)._patch(moduleExports);

      expect(mockWorkflow.prototype.execute).not.toBe(originalExecute);
    });

    it('should patch createTool', () => {
      const originalCreateTool = vi.fn();
      const moduleExports = { createTool: originalCreateTool };
      (instrumentation as any)._patch(moduleExports);

      expect(moduleExports.createTool).not.toBe(originalCreateTool);
    });

    it('should handle missing Agent gracefully', () => {
      const moduleExports = {};
      expect(() => (instrumentation as any)._patch(moduleExports)).not.toThrow();
    });

    it('should handle missing Workflow gracefully', () => {
      const moduleExports = {};
      expect(() => (instrumentation as any)._patch(moduleExports)).not.toThrow();
    });

    it('should handle missing createTool gracefully', () => {
      const moduleExports = {};
      expect(() => (instrumentation as any)._patch(moduleExports)).not.toThrow();
    });

    it('should patch Agent from subpath module (@mastra/core/agent)', () => {
      const originalGenerate = vi.fn();
      const mockAgent = {
        prototype: {
          generate: originalGenerate,
        },
      };
      // Simulate the subpath module exporting Agent
      const subpathExports = { Agent: mockAgent };
      (instrumentation as any)._patchAgentModule(subpathExports);

      expect(mockAgent.prototype.generate).not.toBe(originalGenerate);

      // Clean up
      (instrumentation as any)._unpatchAgentModule(subpathExports);
      expect(mockAgent.prototype.generate).toBe(originalGenerate);
    });

    it('should patch Workflow from subpath module (@mastra/core/workflows)', () => {
      const originalExecute = vi.fn();
      const mockWorkflow = {
        prototype: {
          execute: originalExecute,
        },
      };
      const subpathExports = { Workflow: mockWorkflow };
      (instrumentation as any)._patchWorkflowModule(subpathExports);

      expect(mockWorkflow.prototype.execute).not.toBe(originalExecute);

      (instrumentation as any)._unpatchWorkflowModule(subpathExports);
      expect(mockWorkflow.prototype.execute).toBe(originalExecute);
    });

    it('should patch createTool from subpath module (@mastra/core/tools)', () => {
      const originalCreateTool = vi.fn();
      const subpathExports = { createTool: originalCreateTool };
      (instrumentation as any)._patchToolsModule(subpathExports);

      expect(subpathExports.createTool).not.toBe(originalCreateTool);

      (instrumentation as any)._unpatchToolsModule(subpathExports);
      expect(subpathExports.createTool).toBe(originalCreateTool);
    });

    it('should unpatch createTool correctly even when _unpatchToolsModule is called with a DIFFERENT object', () => {
      // Regression test: _unpatchToolsModule must always unwrap from the stored module
      // reference (_patchedToolsModule), NOT from its argument. Without this fix, calling
      // _unpatch(rootExports) when createTool was patched on subpathExports would silently
      // leave the subpath wrapped — because shimmer's __unwrap closure captures the original
      // nodule at wrap time, and calling _unwrap(wrongObject, 'createTool') is a no-op.
      const originalCreateTool = vi.fn();
      const subpathExports = { createTool: originalCreateTool };
      const unrelatedExports = { createTool: vi.fn() }; // simulates root module object

      // Patch using subpath object
      (instrumentation as any)._patchToolsModule(subpathExports);
      expect(subpathExports.createTool).not.toBe(originalCreateTool); // wrapped

      // Unpatch passing a DIFFERENT object (simulates root-module unpatch callback)
      // This should still correctly unpatch from the stored subpathExports reference
      (instrumentation as any)._unpatchToolsModule(unrelatedExports);
      expect(subpathExports.createTool).toBe(originalCreateTool); // restored ✓
      expect(unrelatedExports.createTool).not.toBe(originalCreateTool); // untouched ✓
    });

    it('should attempt dynamic require fallback when root exports lack classes', () => {
      // When moduleExports (root @mastra/core) doesn't have Agent, Workflow,
      // or createTool, _patch() enters the dynamic-require fallback branches.
      // Since @mastra/core IS installed as a dev dependency, the require()
      // calls succeed and the real subpath modules get patched. We verify
      // that the fallback path fires by checking that prototypes are stored
      // from the dynamically-required modules.
      //
      // NOTE: This test depends on @mastra/core being available as a
      // devDependency. If the dependency is removed or its subpath exports
      // change, this test may need updating.
      const emptyExports = {};
      (instrumentation as any)._patch(emptyExports);

      // The dynamic require loaded the real @mastra/core subpath modules
      // and patched them, so the prototype references should be set.
      expect((instrumentation as any)._agentPrototype).not.toBeNull();
      expect((instrumentation as any)._workflowPrototype).not.toBeNull();
      expect((instrumentation as any)._patchedToolsModule).not.toBeNull();

      // Clean up: unpatch the real modules
      (instrumentation as any)._unpatch(emptyExports);
    });

    it('should skip dynamic require when root exports already contain Agent', () => {
      // When root exports have Agent, the dynamic require for @mastra/core/agent
      // should NOT fire. We verify by checking that _agentPrototype is set from
      // the root exports object.
      const originalGenerate = vi.fn();
      const mockAgent = {
        prototype: { generate: originalGenerate, stream: vi.fn() },
      };
      const moduleExports = { Agent: mockAgent };

      (instrumentation as any)._patch(moduleExports);

      // _agentPrototype should point to the root export's prototype
      expect((instrumentation as any)._agentPrototype).toBe(mockAgent.prototype);
      expect(mockAgent.prototype.generate).not.toBe(originalGenerate);

      (instrumentation as any)._unpatch(moduleExports);
    });

    it('should skip dynamic require when root exports already contain Workflow', () => {
      const originalExecute = vi.fn();
      const mockWorkflow = {
        prototype: { execute: originalExecute },
      };
      const moduleExports = { Workflow: mockWorkflow };

      (instrumentation as any)._patch(moduleExports);

      expect((instrumentation as any)._workflowPrototype).toBe(mockWorkflow.prototype);
      expect(mockWorkflow.prototype.execute).not.toBe(originalExecute);

      (instrumentation as any)._unpatch(moduleExports);
    });

    it('should skip dynamic require when root exports already contain createTool', () => {
      const originalCreateTool = vi.fn().mockReturnValue({
        id: 'tool1',
        execute: vi.fn().mockResolvedValue({}),
      });
      const moduleExports = { createTool: originalCreateTool };

      (instrumentation as any)._patch(moduleExports);

      expect((instrumentation as any)._patchedToolsModule).toBe(moduleExports);
      expect(moduleExports.createTool).not.toBe(originalCreateTool);

      (instrumentation as any)._unpatch(moduleExports);
    });

    it('should unpatch Agent prototype methods', () => {
      const originalGenerate = vi.fn();
      const originalStream = vi.fn();
      const mockAgent = {
        prototype: {
          generate: originalGenerate,
          stream: originalStream,
        },
      };
      const moduleExports = { Agent: mockAgent };
      (instrumentation as any)._patch(moduleExports);
      (instrumentation as any)._unpatch(moduleExports);

      // After unpatching, functions should be restored
      expect(mockAgent.prototype.generate).toBe(originalGenerate);
      expect(mockAgent.prototype.stream).toBe(originalStream);
    });

    it('should unpatch Workflow prototype methods', () => {
      const originalExecute = vi.fn();
      const mockWorkflow = {
        prototype: {
          execute: originalExecute,
        },
      };
      const moduleExports = { Workflow: mockWorkflow };
      (instrumentation as any)._patch(moduleExports);
      (instrumentation as any)._unpatch(moduleExports);

      expect(mockWorkflow.prototype.execute).toBe(originalExecute);
    });
  });

  describe('Agent.generate patch behavior', () => {
    let provider: NodeTracerProvider;
    let exporter: InMemorySpanExporter;

    beforeEach(() => {
      exporter = new InMemorySpanExporter();
      provider = new NodeTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      provider.register();
      instrumentation.setTracerProvider(provider);
    });

    afterEach(async () => {
      exporter.reset();
      await provider.shutdown();
    });

    it('should wrap agent.generate and set attributes', async () => {
      const generateResult = {
        text: 'Hello, world!',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };

      const mockAgentInstance = {
        name: 'TestAgent',
        instructions: 'Be helpful',
        model: { modelId: 'gpt-4' },
        tools: { search: {}, calc: {} },
      };

      const originalGenerate = vi.fn().mockResolvedValue(generateResult);
      const mockAgent = {
        prototype: {
          generate: originalGenerate,
        },
      };

      const moduleExports = { Agent: mockAgent };
      (instrumentation as any)._patch(moduleExports);

      // Call the patched generate with the agent as 'this'
      const result = await mockAgent.prototype.generate.call(
        mockAgentInstance,
        'What is 2+2?',
      );

      expect(result).toEqual(generateResult);
      expect(originalGenerate).toHaveBeenCalledWith('What is 2+2?');

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('mastra.agent.generate');
      expect(spans[0].attributes['openinference.span.kind']).toBe('AGENT');
      expect(spans[0].attributes['agent.name']).toBe('TestAgent');
      expect(spans[0].attributes['llm.model_name']).toBe('gpt-4');
      expect(spans[0].attributes['input.value']).toBe('"What is 2+2?"');
      expect(spans[0].attributes['output.value']).toBe('Hello, world!');
      expect(spans[0].attributes['llm.token_count.prompt']).toBe(10);
      expect(spans[0].attributes['llm.token_count.completion']).toBe(5);
      expect(spans[0].attributes['llm.token_count.total']).toBe(15);
    });
  });

  describe('Agent.stream patch behavior', () => {
    let provider: NodeTracerProvider;
    let exporter: InMemorySpanExporter;

    beforeEach(() => {
      exporter = new InMemorySpanExporter();
      provider = new NodeTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      provider.register();
      instrumentation.setTracerProvider(provider);
    });

    afterEach(async () => {
      exporter.reset();
      await provider.shutdown();
    });

    it('should wrap agent.stream and set attributes after consuming textStream', async () => {
      const textChunks = ['Hello', ', ', 'world', '!'];
      let chunkIndex = 0;

      const mockTextStream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (chunkIndex < textChunks.length) {
                return { done: false, value: textChunks[chunkIndex++] };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };

      const streamResult = {
        textStream: mockTextStream,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      };

      const mockAgentInstance = {
        name: 'StreamAgent',
        instructions: 'Stream responses',
        model: { modelId: 'gpt-4o' },
        tools: {},
      };

      const originalStream = vi.fn().mockResolvedValue(streamResult);
      const mockAgent = {
        prototype: {
          stream: originalStream,
          generate: vi.fn(), // needed so _patch doesn't skip Agent
        },
      };

      const moduleExports = { Agent: mockAgent };
      (instrumentation as any)._patch(moduleExports);

      const result = await mockAgent.prototype.stream.call(
        mockAgentInstance,
        'Tell me a story',
      );

      // Consume the wrapped textStream
      const collectedChunks: string[] = [];
      for await (const chunk of result.textStream) {
        collectedChunks.push(chunk);
      }

      expect(collectedChunks).toEqual(textChunks);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('mastra.agent.stream');
      expect(spans[0].attributes['openinference.span.kind']).toBe('AGENT');
      expect(spans[0].attributes['agent.name']).toBe('StreamAgent');
      expect(spans[0].attributes['llm.model_name']).toBe('gpt-4o');
      expect(spans[0].attributes['input.value']).toBe('"Tell me a story"');
      // After stream consumption, output.value should contain accumulated text
      expect(spans[0].attributes['output.value']).toBe('Hello, world!');
      expect(spans[0].attributes['llm.token_count.prompt']).toBe(20);
      expect(spans[0].attributes['llm.token_count.completion']).toBe(10);
      expect(spans[0].attributes['llm.token_count.total']).toBe(30);
    });

    it('should enrich but NOT end a borrowed active span during stream consumption', async () => {
      const textChunks = ['Hi', ' there'];
      let chunkIndex = 0;

      const mockTextStream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (chunkIndex < textChunks.length) {
                return { done: false, value: textChunks[chunkIndex++] };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };

      const streamResult = {
        textStream: mockTextStream,
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      };

      const mockAgentInstance = {
        name: 'BorrowedSpanAgent',
        model: { modelId: 'gpt-4o' },
        tools: {},
      };

      const originalStream = vi.fn().mockResolvedValue(streamResult);
      const mockAgent = {
        prototype: {
          stream: originalStream,
          generate: vi.fn(),
        },
      };

      const moduleExports = { Agent: mockAgent };
      (instrumentation as any)._patch(moduleExports);

      // Create an active span to simulate Mastra's OtelBridge
      const tracer = provider.getTracer('test');
      const otelBridgeSpan = tracer.startSpan('mastra.otelbridge.agent');
      const ctx = trace.setSpan(context.active(), otelBridgeSpan);

      // Call stream within the active span context
      const result = await context.with(ctx, async () => {
        return mockAgent.prototype.stream.call(mockAgentInstance, 'Hello');
      });

      // Consume the wrapped textStream within the same context
      const collectedChunks: string[] = [];
      await context.with(ctx, async () => {
        for await (const chunk of result.textStream) {
          collectedChunks.push(chunk);
        }
      });

      expect(collectedChunks).toEqual(textChunks);

      // The OtelBridge span should still be recording (not ended by our instrumentation)
      expect(otelBridgeSpan.isRecording()).toBe(true);

      // But attributes should have been set on it
      // End it manually now so it shows up in the exporter
      otelBridgeSpan.end();

      const spans = exporter.getFinishedSpans();
      const bridgeSpan = spans.find(s => s.name === 'mastra.otelbridge.agent');
      expect(bridgeSpan).toBeDefined();
      expect(bridgeSpan!.attributes['openinference.span.kind']).toBe('AGENT');
      expect(bridgeSpan!.attributes['agent.name']).toBe('BorrowedSpanAgent');
      expect(bridgeSpan!.attributes['output.value']).toBe('Hi there');

      // No additional span should have been created by the instrumentation
      const agentStreamSpans = spans.filter(s => s.name === 'mastra.agent.stream');
      expect(agentStreamSpans.length).toBe(0);
    });

    it('should handle stream result without textStream gracefully', async () => {
      const streamResult = { text: 'direct response' };

      const mockAgentInstance = { name: 'NoStreamAgent' };
      const originalStream = vi.fn().mockResolvedValue(streamResult);
      const mockAgent = {
        prototype: {
          stream: originalStream,
          generate: vi.fn(),
        },
      };

      const moduleExports = { Agent: mockAgent };
      (instrumentation as any)._patch(moduleExports);

      const result = await mockAgent.prototype.stream.call(
        mockAgentInstance,
        'Hello',
      );

      expect(result).toEqual(streamResult);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('mastra.agent.stream');
    });

    it('should end the span when textStream iterator is explicitly closed via return()', async () => {
      // Regression guard: if a caller gets the stream result but calls return() on the
      // textStream iterator before consuming all chunks (e.g., a break or early exit),
      // the span must be properly ended. This covers the for-await break/early-return path.
      const textChunks = ['Hello', ' world'];
      let chunkIndex = 0;

      const mockTextStream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (chunkIndex < textChunks.length) {
                return { done: false, value: textChunks[chunkIndex++] };
              }
              return { done: true, value: undefined };
            },
            async return(val?: any) {
              return { done: true as const, value: val };
            },
          };
        },
      };

      const mockAgentInstance = { name: 'EarlyExitAgent' };
      const originalStream = vi.fn().mockResolvedValue({ textStream: mockTextStream });
      const mockAgent = {
        prototype: {
          stream: originalStream,
          generate: vi.fn(),
        },
      };

      const moduleExports = { Agent: mockAgent };
      (instrumentation as any)._patch(moduleExports);

      const result = await mockAgent.prototype.stream.call(mockAgentInstance, 'Hi');

      // Get the iterator and call return() without consuming any items
      // (mirrors what for-await does on an early break/return)
      const iter = result.textStream[Symbol.asyncIterator]();
      await iter.return?.();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('mastra.agent.stream');
      expect(spans[0].status.code).toBe(SpanStatusCode.OK);
      // Output.value should be set (even with empty accumulated text)
      expect(spans[0].attributes['openinference.span.kind']).toBe('AGENT');
    });
  });

  describe('Workflow.execute patch behavior', () => {
    let provider: NodeTracerProvider;
    let exporter: InMemorySpanExporter;

    beforeEach(() => {
      exporter = new InMemorySpanExporter();
      provider = new NodeTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      provider.register();
      instrumentation.setTracerProvider(provider);
    });

    afterEach(async () => {
      exporter.reset();
      await provider.shutdown();
    });

    it('should wrap workflow.execute and set attributes', async () => {
      const executeResult = { status: 'completed', output: { data: 42 } };

      const mockWorkflowInstance = {
        name: 'DataPipeline',
      };

      const originalExecute = vi.fn().mockResolvedValue(executeResult);
      const mockWorkflow = {
        prototype: {
          execute: originalExecute,
        },
      };

      const moduleExports = { Workflow: mockWorkflow };
      (instrumentation as any)._patch(moduleExports);

      const result = await mockWorkflow.prototype.execute.call(
        mockWorkflowInstance,
        { input: 'test-data' },
      );

      expect(result).toEqual(executeResult);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('mastra.workflow.execute');
      expect(spans[0].attributes['openinference.span.kind']).toBe('WORKFLOW');
      expect(spans[0].attributes['workflow.name']).toBe('DataPipeline');
      expect(spans[0].attributes['input.value']).toBe('{"input":"test-data"}');
      expect(spans[0].attributes['output.value']).toBe(
        JSON.stringify(executeResult)
      );
    });
  });

  describe('createTool patch behavior', () => {
    let provider: NodeTracerProvider;
    let exporter: InMemorySpanExporter;

    beforeEach(() => {
      exporter = new InMemorySpanExporter();
      provider = new NodeTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      provider.register();
      instrumentation.setTracerProvider(provider);
    });

    afterEach(async () => {
      exporter.reset();
      await provider.shutdown();
    });

    it('should wrap tool.execute returned by createTool', async () => {
      const toolResult = { answer: 42 };
      const originalToolExecute = vi.fn().mockResolvedValue(toolResult);

      const originalCreateTool = vi.fn().mockReturnValue({
        id: 'calculator',
        name: 'Calculator',
        description: 'Performs calculations',
        execute: originalToolExecute,
      });

      const moduleExports = { createTool: originalCreateTool };
      (instrumentation as any)._patch(moduleExports);

      // Call createTool (patched)
      const tool = moduleExports.createTool({ id: 'calculator' });

      // Call the patched execute
      const result = await tool.execute({ expression: '2+2' });

      expect(result).toEqual(toolResult);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('mastra.tool.execute');
      expect(spans[0].attributes['openinference.span.kind']).toBe('TOOL');
      expect(spans[0].attributes['tool.name']).toBe('calculator');
      expect(spans[0].attributes['tool.description']).toBe('Performs calculations');
      expect(spans[0].attributes['input.value']).toBe('{"expression":"2+2"}');
      expect(spans[0].attributes['output.value']).toBe('{"answer":42}');
    });

    it('should handle createTool returning tool without execute', () => {
      const originalCreateTool = vi.fn().mockReturnValue({
        id: 'no-exec-tool',
      });

      const moduleExports = { createTool: originalCreateTool };
      expect(() => (instrumentation as any)._patch(moduleExports)).not.toThrow();

      const tool = moduleExports.createTool({});
      expect(tool.id).toBe('no-exec-tool');
    });
  });
});
