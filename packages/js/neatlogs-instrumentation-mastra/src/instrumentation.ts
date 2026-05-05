/**
 * Neatlogs instrumentation for @mastra/core.
 *
 * Patches the Mastra constructor to auto-inject a NeatlogsMastraExporter
 * into Mastra's observability config. The exporter implements BaseExporter
 * and receives AnyExportedSpan objects from Mastra's internal observability,
 * converting them to OpenInference-format OTel spans.
 *
 * Usage (via neatlogs SDK):
 *   neatlogs.init({ instrumentations: ['mastra'] })
 *
 * Usage (standalone):
 *   import MastraInstrumentor from '@neatlogs/instrumentation-mastra';
 *   const instr = new MastraInstrumentor();
 *   instr.instrument({ tracerProvider: myProvider });
 */

import {
  type Tracer,
  type TracerProvider,
  SpanKind,
  SpanStatusCode,
  context,
} from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// SpanType → OpenInference span kind mapping
// ---------------------------------------------------------------------------

const SPAN_TYPE_TO_OI_KIND: Record<string, string> = {
  // LLM spans
  model_generation: 'LLM',
  model_step: 'LLM',
  model_chunk: 'LLM',
  // Tool spans
  tool_call: 'TOOL',
  mcp_tool_call: 'TOOL',
  // Agent spans
  agent_run: 'AGENT',
  scorer_run: 'AGENT',
  // Workflow spans
  workflow_run: 'WORKFLOW',
  workflow_step: 'CHAIN',
  workflow_conditional: 'CHAIN',
  workflow_conditional_eval: 'CHAIN',
  workflow_parallel: 'CHAIN',
  workflow_loop: 'CHAIN',
  workflow_sleep: 'CHAIN',
  workflow_wait_event: 'CHAIN',
  // RAG spans
  rag_ingestion: 'RETRIEVER',
  rag_embedding: 'EMBEDDING',
  rag_vector_operation: 'RETRIEVER',
  rag_action: 'RETRIEVER',
  // Memory
  memory_operation: 'CHAIN',
  // Everything else
  generic: 'CHAIN',
  processor_run: 'CHAIN',
  workspace_action: 'CHAIN',
  graph_action: 'CHAIN',
  scorer_step: 'CHAIN',
};

function getOiKind(spanType: string): string {
  return SPAN_TYPE_TO_OI_KIND[spanType] ?? 'CHAIN';
}

// ---------------------------------------------------------------------------
// Message conversion helpers
// ---------------------------------------------------------------------------

/**
 * Flatten a Mastra message array (from span.input or span.output on LLM spans)
 * into flat indexed OTel attributes:
 *   llm.input_messages.0.message.role
 *   llm.input_messages.0.message.content
 *   llm.input_messages.0.message.tool_calls.0.tool_call.function.name
 *   llm.input_messages.0.message.tool_calls.0.tool_call.function.arguments
 */
function flattenMessages(
  messages: any[],
  prefix: string,
  setAttr: (key: string, value: string | number) => void,
): void {
  if (!Array.isArray(messages)) return;
  messages.forEach((msg: any, i: number) => {
    if (!msg || typeof msg !== 'object') return;
    const role = msg.role ?? 'user';
    setAttr(`${prefix}.${i}.message.role`, String(role));

    // Content: string or array of content parts
    if (typeof msg.content === 'string') {
      setAttr(`${prefix}.${i}.message.content`, msg.content);
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((p: any) => p?.type === 'text' && p?.text)
        .map((p: any) => p.text)
        .join('');
      if (textParts) {
        setAttr(`${prefix}.${i}.message.content`, textParts);
      }
    }

    // Tool calls (on assistant messages)
    if (Array.isArray(msg.toolCalls) || Array.isArray(msg.tool_calls)) {
      const toolCalls = msg.toolCalls ?? msg.tool_calls;
      toolCalls.forEach((tc: any, j: number) => {
        const name = tc?.toolName ?? tc?.function?.name ?? tc?.name ?? '';
        const args = tc?.args ?? tc?.function?.arguments ?? tc?.arguments;
        if (name) {
          setAttr(
            `${prefix}.${i}.message.tool_calls.${j}.tool_call.function.name`,
            String(name),
          );
        }
        if (args !== undefined) {
          setAttr(
            `${prefix}.${i}.message.tool_calls.${j}.tool_call.function.arguments`,
            typeof args === 'string' ? args : JSON.stringify(args),
          );
        }
      });
    }

    // Tool result (on tool messages)
    if (role === 'tool' && msg.toolCallId) {
      setAttr(`${prefix}.${i}.tool_call_id`, String(msg.toolCallId));
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Best-effort warning to stderr/console; never throws. */
function _warn(msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.process?.stderr?.write === 'function') {
      g.process.stderr.write(`[neatlogs] ${msg}\n`);
    } else if (typeof g.console?.warn === 'function') {
      g.console.warn(`[neatlogs] ${msg}`);
    }
  } catch { /* best-effort */ }
}

function _safeStringify(value: any, maxLen = 100_000): string {
  if (typeof value === 'string') return value.slice(0, maxLen);
  try {
    return JSON.stringify(value).slice(0, maxLen);
  } catch {
    return String(value).slice(0, maxLen);
  }
}

// ---------------------------------------------------------------------------
// NeatlogsMastraExporter
// ---------------------------------------------------------------------------

/**
 * Implements Mastra's BaseExporter interface (duck-typed — no import needed).
 * Receives AnyExportedSpan from Mastra's internal observability,
 * converts to OpenInference OTel attributes, and creates OTel spans
 * on the provided TracerProvider.
 */
export class NeatlogsMastraExporter {
  name = 'neatlogs';
  private _tracer: Tracer;

  constructor(tracerProvider: TracerProvider) {
    this._tracer = tracerProvider.getTracer('openinference.instrumentation.mastra');
  }

  // BaseExporter interface methods
  async exportTracingEvent(event: any): Promise<void> {
    // Only process completed spans
    if (event.type !== 'span_ended') return;
    const span = event.exportedSpan;
    if (!span) return;

    try {
      this._processSpan(span);
    } catch (err) {
      // best-effort — never let exporter errors surface to user code
    }
  }

  onTracingEvent(event: any): void | Promise<void> {
    return this.exportTracingEvent(event);
  }

  private _processSpan(span: any): void {
    const oiKind = getOiKind(span.type ?? 'generic');
    const spanName = span.name ?? span.type ?? 'mastra.span';

    // Note: Mastra's span_ended events include parentSpanId but we only receive
    // completed spans. Parent-child OTel hierarchy relies on the ambient OTel
    // context; reconstructing it from Mastra trace/span IDs would require
    // processing span_started events and holding OTel spans open until span_ended.
    const otelSpan = this._tracer.startSpan(
      spanName,
      {
        kind: SpanKind.INTERNAL,
        startTime: span.startTime ? new Date(span.startTime).getTime() : undefined,
      },
      context.active(),
    );

    // Core OpenInference attributes
    otelSpan.setAttribute('openinference.span.kind', oiKind);

    // Entity info
    if (span.entityName) {
      otelSpan.setAttribute('mastra.entity.name', span.entityName);
    }
    if (span.entityType) {
      otelSpan.setAttribute('mastra.entity.type', span.entityType);
    }

    // Span-type-specific attributes
    this._setTypeAttributes(otelSpan, span);

    // Input / output
    this._setInputOutput(otelSpan, span);

    // Error handling
    if (span.errorInfo) {
      otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: span.errorInfo.message,
      });
      otelSpan.recordException(new Error(span.errorInfo.message));
    } else {
      otelSpan.setStatus({ code: SpanStatusCode.OK });
    }

    // Metadata as JSON
    if (span.metadata && Object.keys(span.metadata).length > 0) {
      try {
        otelSpan.setAttribute('metadata', JSON.stringify(span.metadata));
      } catch {
        // best-effort
      }
    }

    // Tags (root spans only)
    if (Array.isArray(span.tags) && span.tags.length > 0) {
      otelSpan.setAttribute('tag.tags', span.tags);
    }

    otelSpan.end(span.endTime ? new Date(span.endTime).getTime() : undefined);
  }

  private _setTypeAttributes(otelSpan: any, span: any): void {
    const attrs = span.attributes ?? {};
    const type = span.type ?? '';

    if (type === 'model_generation' || type === 'model_step') {
      // Model name
      if (attrs.model) {
        otelSpan.setAttribute('llm.model_name', attrs.model);
        otelSpan.setAttribute('gen_ai.request.model', attrs.model);
      }
      if (attrs.responseModel) {
        otelSpan.setAttribute('gen_ai.response.model', attrs.responseModel);
      }
      // Provider
      if (attrs.provider) {
        otelSpan.setAttribute('gen_ai.system', attrs.provider);
        otelSpan.setAttribute('llm.provider', attrs.provider);
      }
      // Finish reason
      if (attrs.finishReason) {
        otelSpan.setAttribute('llm.response.finish_reason', attrs.finishReason);
      }
      // Token usage
      const usage = attrs.usage;
      if (usage) {
        if (usage.inputTokens !== undefined) {
          otelSpan.setAttribute('llm.token_count.prompt', usage.inputTokens);
        }
        if (usage.outputTokens !== undefined) {
          otelSpan.setAttribute('llm.token_count.completion', usage.outputTokens);
        }
        if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
          otelSpan.setAttribute('llm.token_count.total', usage.inputTokens + usage.outputTokens);
        }
        const inputDetails = usage.inputDetails;
        if (inputDetails) {
          if (inputDetails.cacheRead !== undefined) {
            otelSpan.setAttribute('llm.token_count.prompt_details.cache_read', inputDetails.cacheRead);
          }
          if (inputDetails.cacheWrite !== undefined) {
            otelSpan.setAttribute('llm.token_count.prompt_details.cache_write', inputDetails.cacheWrite);
          }
          if (inputDetails.audio !== undefined) {
            otelSpan.setAttribute('llm.token_count.prompt_details.audio', inputDetails.audio);
          }
        }
        const outputDetails = usage.outputDetails;
        if (outputDetails) {
          if (outputDetails.reasoning !== undefined) {
            otelSpan.setAttribute('llm.token_count.completion_details.reasoning', outputDetails.reasoning);
          }
          if (outputDetails.audio !== undefined) {
            otelSpan.setAttribute('llm.token_count.completion_details.audio', outputDetails.audio);
          }
        }
      }
      // Model parameters
      if (attrs.parameters) {
        try {
          otelSpan.setAttribute('llm.invocation_parameters', JSON.stringify(attrs.parameters));
        } catch {
          // best-effort
        }
      }
      // TTFT (time to first token)
      if (attrs.completionStartTime && span.startTime) {
        const completionStart = new Date(attrs.completionStartTime).getTime();
        const ttft = completionStart - new Date(span.startTime).getTime();
        if (ttft >= 0) {
          otelSpan.setAttribute('mastra.completion_start_time', new Date(attrs.completionStartTime).toISOString());
          otelSpan.setAttribute('llm.time_to_first_token', ttft);
        }
      }
    }

    if (type === 'agent_run') {
      if (attrs.conversationId) {
        otelSpan.setAttribute('session.id', attrs.conversationId);
      }
      if (attrs.instructions) {
        otelSpan.setAttribute('llm.system', attrs.instructions);
      }
      if (Array.isArray(attrs.availableTools) && attrs.availableTools.length > 0) {
        otelSpan.setAttribute('mastra.agent.available_tools', attrs.availableTools.join(','));
      }
    }

    if (type === 'tool_call' || type === 'mcp_tool_call') {
      if (span.name) {
        otelSpan.setAttribute('tool.name', span.name);
      }
      if (attrs.toolDescription) {
        otelSpan.setAttribute('tool.description', attrs.toolDescription);
      }
      if (type === 'mcp_tool_call' && attrs.mcpServer) {
        otelSpan.setAttribute('mastra.mcp.server', attrs.mcpServer);
      }
    }

    if (type === 'rag_embedding') {
      if (attrs.model) {
        otelSpan.setAttribute('embedding.model_name', attrs.model);
      }
      if (attrs.provider) {
        otelSpan.setAttribute('gen_ai.system', attrs.provider);
      }
      const usage = attrs.usage;
      if (usage?.inputTokens !== undefined) {
        otelSpan.setAttribute('llm.token_count.prompt', usage.inputTokens);
      }
    }
  }

  private _setInputOutput(otelSpan: any, span: any): void {
    const type = span.type ?? '';
    const isLlmSpan = type === 'model_generation' || type === 'model_step';

    if (isLlmSpan) {
      // Flatten message arrays to indexed attributes
      if (Array.isArray(span.input) && span.input.length > 0) {
        flattenMessages(span.input, 'llm.input_messages', (k, v) =>
          otelSpan.setAttribute(k, v),
        );
      } else if (span.input !== undefined && span.input !== null) {
        // Includes empty array [] — emit as JSON so the value is not silently dropped
        otelSpan.setAttribute('input.value', _safeStringify(span.input));
      }

      if (Array.isArray(span.output) && span.output.length > 0) {
        flattenMessages(span.output, 'llm.output_messages', (k, v) =>
          otelSpan.setAttribute(k, v),
        );
      } else if (span.output !== undefined && span.output !== null) {
        // Includes empty array [] — emit as JSON so the value is not silently dropped
        otelSpan.setAttribute('output.value', _safeStringify(span.output));
      }
    } else {
      // Non-LLM spans: use input.value / output.value
      if (span.input !== undefined && span.input !== null) {
        otelSpan.setAttribute('input.value', _safeStringify(span.input));
      }
      if (span.output !== undefined && span.output !== null) {
        otelSpan.setAttribute('output.value', _safeStringify(span.output));
      }
    }
  }

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
  init?(_options: any): void {}
}

// ---------------------------------------------------------------------------
// createNeatlogsMastraObservability helper
// ---------------------------------------------------------------------------

export interface CreateObservabilityOptions {
  /** Supply a pre-built exporter instead of auto-creating one. */
  exporter?: NeatlogsMastraExporter;
  /** @internal — inject the @mastra/observability module (for testing). */
  _observabilityModule?: any;
}

/**
 * Dynamically requires @mastra/observability and constructs an Observability
 * instance wired with a NeatlogsMastraExporter.
 *
 * Returns `{ observability, exporter }` where `observability` is a real
 * Observability instance whose `getDefaultInstance().getExporters()` contains
 * the exporter.
 *
 * Throws if @mastra/observability is unavailable or Observability is not a
 * constructor.
 */
export function createNeatlogsMastraObservability(
  tracerProvider: TracerProvider,
  options?: CreateObservabilityOptions,
): { observability: any; exporter: NeatlogsMastraExporter } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const obsModule = options?._observabilityModule ?? require('@mastra/observability');
  const Observability = obsModule?.Observability ?? obsModule?.default?.Observability;

  if (typeof Observability !== 'function') {
    throw new Error(
      '@mastra/observability does not export a valid Observability constructor',
    );
  }

  const exporter = options?.exporter ?? new NeatlogsMastraExporter(tracerProvider);
  const observability = new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [exporter],
      },
    },
  });

  return { observability, exporter };
}

// ---------------------------------------------------------------------------
// MastraInstrumentor
// ---------------------------------------------------------------------------

export interface MastraInstrumentorOptions {
  tracerProvider: TracerProvider;
  /** @internal — for testing only; inject the module instead of require(). */
  _module?: any;
  /** @internal — for testing only; inject a pre-built exporter instance. */
  _exporter?: any;
  /** @internal — for testing only; inject the @mastra/observability module. */
  _observabilityModule?: any;
}

/**
 * Instrumentor for @mastra/core. Patches the Mastra constructor to
 * auto-inject NeatlogsMastraExporter into Mastra's observability config.
 *
 * Compatible with the neatlogs SDK instrumentation manager interface:
 *   instrumentor.instrument({ tracerProvider })
 *   instrumentor.disable()
 */
export class MastraInstrumentor {
  private _provider: TracerProvider | null = null;
  private _origMastraConstructor: Function | null = null;
  private _mastraModule: any = null;

  instrument(options: MastraInstrumentorOptions): void {
    this._provider = options.tracerProvider;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mastraModule = options._module ?? require('@mastra/core');
      this._patchMastraConstructor(mastraModule, options);
    } catch (e) {
      // @mastra/core not installed — no-op
    }
  }

  disable(): void {
    if (this._mastraModule && this._origMastraConstructor) {
      // Restore the original constructor on the module export.
      // ES module exports may be read-only, so fall back to Object.defineProperty.
      try {
        this._mastraModule.Mastra = this._origMastraConstructor;
      } catch {
        try {
          Object.defineProperty(this._mastraModule, 'Mastra', {
            value: this._origMastraConstructor,
            writable: true,
            configurable: true,
          });
        } catch {
          // best-effort — module exports may be non-configurable in some environments
        }
      }
    }
    this._origMastraConstructor = null;
    this._mastraModule = null;
    this._provider = null;
  }

  private _patchMastraConstructor(mastraModule: any, options: MastraInstrumentorOptions): void {
    const MastraClass = mastraModule.Mastra;
    if (!MastraClass) return;

    const provider = this._provider!;
    const origConstructor = MastraClass;
    this._origMastraConstructor = origConstructor;
    this._mastraModule = mastraModule;

    // Replace the Mastra constructor with a wrapper that injects our exporter
    const PatchedMastra = function (this: any, config?: any) {
      const cfg = config ?? {};

      // Only inject if user hasn't configured their own observability
      if (!cfg.observability) {
        try {
          const result = createNeatlogsMastraObservability(provider, {
            exporter: options._exporter,
            _observabilityModule: options._observabilityModule,
          });
          cfg.observability = result.observability;
        } catch (e) {
          // @mastra/observability unavailable or invalid — skip injection,
          // construct original Mastra without adding an invalid plain object.
          // Emit a visible warning so users know Mastra spans won't be produced.
          const msg = e instanceof Error ? e.message : String(e);
          _warn(
            `Mastra instrumentation could not activate: ${msg}. ` +
            'Install @mastra/observability to enable Mastra span collection.',
          );
        }
      }

      // Call the original constructor with the (possibly modified) config
      return Reflect.construct(origConstructor, [cfg], new.target ?? origConstructor);
    };

    // Preserve prototype chain so instanceof checks still work
    PatchedMastra.prototype = MastraClass.prototype;
    Object.setPrototypeOf(PatchedMastra, MastraClass);

    // Copy static properties
    for (const key of Object.getOwnPropertyNames(MastraClass)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue;
      try {
        const desc = Object.getOwnPropertyDescriptor(MastraClass, key);
        if (desc) Object.defineProperty(PatchedMastra, key, desc);
      } catch {
        // best-effort
      }
    }

    // Replace the Mastra constructor on the module with the wrapper.
    // Some module exports (e.g. CJS bundles, ESM re-exports) may have
    // non-configurable property descriptors.  We check first and bail early
    // rather than letting assignment/defineProperty throw unpredictably.
    const desc = Object.getOwnPropertyDescriptor(mastraModule, 'Mastra');
    if (desc && !desc.configurable) {
      // Non-configurable property — neither direct assignment (throws in strict
      // mode) nor Object.defineProperty (throws TypeError) can replace it.
      // This includes CJS bundles whose exports namespace is sealed, where the
      // descriptor has configurable:false, writable:true but no getter —
      // assignment still throws in strict mode and defineProperty is blocked.
      this._origMastraConstructor = null;
      this._mastraModule = null;
      _warn(
        'Cannot patch @mastra/core: the "Mastra" export is non-configurable ' +
        '(module exports are sealed). Constructor patching is not possible. ' +
        'Mastra spans will not be collected. ' +
        'Use `createNeatlogsMastraObservability()` and pass the result to ' +
        'new Mastra({ observability: ... }) directly instead.',
      );
      return;
    }

    try {
      mastraModule.Mastra = PatchedMastra;
    } catch {
      try {
        Object.defineProperty(mastraModule, 'Mastra', {
          value: PatchedMastra,
          writable: true,
          configurable: true,
        });
      } catch {
        // best-effort — module exports may be non-configurable in some environments
        this._origMastraConstructor = null;
        this._mastraModule = null;
        _warn(
          'Cannot patch @mastra/core: all attempts to replace the "Mastra" ' +
          'export on the module object threw errors. ' +
          'Mastra spans will not be collected. ' +
          'Use `createNeatlogsMastraObservability()` and pass the result to ' +
          'new Mastra({ observability: ... }) directly instead.',
        );
        return;
      }
    }

    // Verify the patch actually took effect (guards against silent no-ops)
    if (mastraModule.Mastra !== PatchedMastra) {
      this._origMastraConstructor = null;
      this._mastraModule = null;
      _warn(
        'Cannot patch @mastra/core: the "Mastra" export was not replaced ' +
        'after assignment (silent no-op). ' +
        'Mastra spans will not be collected. ' +
        'Use `createNeatlogsMastraObservability()` and pass the result to ' +
        'new Mastra({ observability: ... }) directly instead.',
      );
    }
  }
}

export default MastraInstrumentor;
