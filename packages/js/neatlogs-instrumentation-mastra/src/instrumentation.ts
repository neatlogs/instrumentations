/**
 * Neatlogs instrumentation for @mastra/core.
 *
 * Implements Mastra's ObservabilityBridge interface to create OTel spans at
 * Mastra span construction time and propagate OTel context into step executions.
 * This enables `trace()` calls inside Mastra workflow steps to inherit the
 * workflow's trace ID and parent correctly.
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
  type Span,
  type Context,
  SpanKind,
  SpanStatusCode,
  trace,
  context as otelContext,
  isSpanContextValid,
} from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// SpanType → OpenInference span kind mapping
// ---------------------------------------------------------------------------

const SPAN_TYPE_TO_OI_KIND: Record<string, string> = {
  // LLM spans
  model_generation: 'CHAIN',
  model_step: 'LLM',
  model_inference: 'CHAIN',
  model_chunk: 'CHAIN',
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
// NeatlogsMastraBridge
// ---------------------------------------------------------------------------

/**
 * Implements Mastra's ObservabilityBridge interface (duck-typed).
 *
 * Creates OTel spans at Mastra span construction time via `createSpan()`,
 * propagates OTel context into step executions via `executeInContext()`,
 * and finalizes spans with attributes on `span_ended` events.
 *
 * This enables `trace()` calls inside Mastra workflow steps to inherit
 * the workflow's trace ID and correct parent span.
 */
export class NeatlogsMastraBridge {
  name = 'neatlogs';
  private _tracer: Tracer;

  /**
   * Active spans keyed by OTel span ID (which equals Mastra span ID since
   * createSpan returns the OTel-generated IDs back to Mastra).
   */
  private _activeSpans: Map<string, { span: Span; context: Context; parentSpanId?: string }> = new Map();

  /** Model metadata inherited down from model_generation spans to their descendants. */
  private _modelInfo: Map<string, { model?: string; provider?: string }> = new Map();

  /** Parameters stored from model_generation/model_inference spans for inheritance by model_step. */
  private _modelParameters: Map<string, Record<string, any>> = new Map();

  constructor(tracerProvider: TracerProvider) {
    this._tracer = tracerProvider.getTracer('openinference.instrumentation.mastra');
  }

  // -------------------------------------------------------------------------
  // ObservabilityBridge: createSpan
  // -------------------------------------------------------------------------

  createSpan(options: any): { traceId: string; spanId: string; parentSpanId?: string } | undefined {
    try {
      let parentContext: Context = otelContext.active();

      // Walk up to find the nearest non-internal parent's OTel context
      const parentId = this._getExternalParentId(options);
      if (parentId) {
        const parentEntry = this._activeSpans.get(parentId);
        if (parentEntry) {
          parentContext = parentEntry.context;
        }
      }

      const otelSpan = this._tracer.startSpan(
        options.name ?? 'mastra.span',
        { kind: SpanKind.INTERNAL },
        parentContext,
      );

      const otelSpanContext = otelSpan.spanContext();

      if (!isSpanContextValid(otelSpanContext)) {
        otelSpan.end();
        return undefined;
      }

      const spanId = otelSpanContext.spanId;
      const traceId = otelSpanContext.traceId;

      // Store with context that has this span as active
      const spanContext = trace.setSpan(parentContext, otelSpan);

      // Determine parentSpanId from parent context
      const parentSpan = trace.getSpan(parentContext);
      const parentSpanCtx = parentSpan?.spanContext();
      const parentSpanId = parentSpanCtx && isSpanContextValid(parentSpanCtx)
        ? parentSpanCtx.spanId
        : undefined;

      this._activeSpans.set(spanId, { span: otelSpan, context: spanContext, parentSpanId });

      // Store model info at creation time for model_generation spans
      if (options.type === 'model_generation') {
        const model = options.attributes?.model ?? this._extractModelFromName(options.name);
        const provider = options.attributes?.provider;
        if (model || provider) {
          this._modelInfo.set(spanId, { model, provider });
        }
      }

      // Store parameters at creation time (model_generation and model_inference set them here)
      const creationParams = options.attributes?.parameters;
      if (creationParams && typeof creationParams === 'object' && Object.keys(creationParams).length > 0) {
        this._modelParameters.set(spanId, creationParams);
      }

      return { traceId, spanId, parentSpanId };
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // ObservabilityBridge: executeInContext / executeInContextSync
  // -------------------------------------------------------------------------

  executeInContext<T>(spanId: string, fn: () => Promise<T>): Promise<T> {
    return this._executeWithSpanContext(spanId, fn);
  }

  executeInContextSync<T>(spanId: string, fn: () => T): T {
    return this._executeWithSpanContext(spanId, fn);
  }

  private _executeWithSpanContext<T>(spanId: string, fn: () => T): T {
    const entry = this._activeSpans.get(spanId);
    if (entry) {
      return otelContext.with(entry.context, fn);
    }
    return fn();
  }

  // -------------------------------------------------------------------------
  // ObservabilityBridge: exportTracingEvent (handles span_ended)
  // -------------------------------------------------------------------------

  async exportTracingEvent(event: any): Promise<void> {
    if (!event || event.type !== 'span_ended') return;
    try {
      this._handleSpanEnded(event.exportedSpan);
    } catch {
      // best-effort
    }
  }

  onTracingEvent(event: any): void | Promise<void> {
    return this.exportTracingEvent(event);
  }

  private _handleSpanEnded(mastraSpan: any): void {
    if (!mastraSpan?.id) return;

    const entry = this._activeSpans.get(mastraSpan.id);
    if (!entry) return;

    this._activeSpans.delete(mastraSpan.id);
    this._modelInfo.delete(mastraSpan.id);
    this._modelParameters.delete(mastraSpan.id);
    this._finalizeSpan(entry.span, mastraSpan, entry.parentSpanId);
  }

  // -------------------------------------------------------------------------
  // Shared finalization (attributes, status, end)
  // -------------------------------------------------------------------------

  private _finalizeSpan(otelSpan: Span, mastraSpan: any, parentSpanId?: string): void {
    const type = mastraSpan.type ?? 'generic';
    const oiKind = getOiKind(type);

    otelSpan.setAttribute('openinference.span.kind', oiKind);

    if (mastraSpan.entityName) {
      otelSpan.setAttribute('mastra.entity.name', mastraSpan.entityName);
    }
    if (mastraSpan.entityType) {
      otelSpan.setAttribute('mastra.entity.type', mastraSpan.entityType);
    }

    // Store/update model info from model_generation spans for descendant inheritance
    const attrs = mastraSpan.attributes ?? {};
    if (type === 'model_generation' && (attrs.model || attrs.responseModel || attrs.provider || attrs.metadata || mastraSpan.metadata)) {
      let model = attrs.responseModel;
      if (!model) {
        const metaSources = [mastraSpan.metadata, attrs.metadata];
        for (const raw of metaSources) {
          if (!raw) continue;
          try {
            const meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (meta?.body?.model) { model = meta.body.model; break; }
          } catch (e: unknown) {
            console.warn('[neatlogs-mastra] Failed to parse metadata for model inheritance:', e);
          }
        }
      }
      model = model ?? attrs.model;
      this._modelInfo.set(mastraSpan.id, { model, provider: attrs.provider });
    }

    // Set chunk type as attribute for UI context
    if (type === 'model_chunk') {
      const chunkType = mastraSpan.attributes?.chunkType;
      if (chunkType) {
        otelSpan.setAttribute('mastra.chunk.type', chunkType);
      }
    }

    this._setTypeAttributes(otelSpan, mastraSpan, parentSpanId);
    this._setInputOutput(otelSpan, mastraSpan);

    if (mastraSpan.errorInfo) {
      otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: mastraSpan.errorInfo.message,
      });
      otelSpan.recordException(new Error(mastraSpan.errorInfo.message));
    } else {
      otelSpan.setStatus({ code: SpanStatusCode.OK });
    }

    if (mastraSpan.metadata && Object.keys(mastraSpan.metadata).length > 0) {
      try {
        otelSpan.setAttribute('metadata', JSON.stringify(mastraSpan.metadata));
      } catch {
        // best-effort
      }
    }

    if (Array.isArray(mastraSpan.tags) && mastraSpan.tags.length > 0) {
      otelSpan.setAttribute('tag.tags', mastraSpan.tags);
    }

    // Update name if Mastra renamed the span after creation
    if (mastraSpan.name) {
      otelSpan.updateName(mastraSpan.name);
    }

    otelSpan.end(mastraSpan.endTime ? new Date(mastraSpan.endTime).getTime() : undefined);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Walk up the parent chain to find the nearest ancestor with model info. */
  private _resolveModelInfo(spanId?: string): { model?: string; provider?: string } | undefined {
    let current = spanId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const info = this._modelInfo.get(current);
      if (info) return info;
      const entry = this._activeSpans.get(current);
      current = entry?.parentSpanId;
    }
    return undefined;
  }

  /** Walk up the parent chain to find the nearest ancestor with model parameters. */
  private _resolveModelParameters(spanId?: string): Record<string, any> | undefined {
    let current = spanId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const params = this._modelParameters.get(current);
      if (params) return params;
      const entry = this._activeSpans.get(current);
      current = entry?.parentSpanId;
    }
    return undefined;
  }

  /** Extract model name from span names like "llm: 'gpt-5-nano'" */
  private _extractModelFromName(name?: string): string | undefined {
    if (!name) return undefined;
    const match = name.match(/^llm:\s*'([^']+)'/);
    return match?.[1];
  }

  private _getExternalParentId(options: any): string | undefined {
    if (!options.parent) return undefined;
    if (options.parent.isInternal) {
      return options.parent.getParentSpanId?.(false) ?? options.parent.id;
    }
    return options.parent.id;
  }

  /** Returns the number of currently active (started but not ended) spans. */
  get activeSpanCount(): number {
    return this._activeSpans.size;
  }

  private _setTypeAttributes(otelSpan: any, span: any, parentSpanId?: string): void {
    const attrs = span.attributes ?? {};
    const type = span.type ?? '';

    if (type === 'model_generation' || type === 'model_step' || type === 'model_inference') {
      // Extract the actual model name from the API response metadata.
      // Mastra puts response metadata in span.metadata (top-level), which contains
      // the response body with the resolved model name (e.g., "gpt-5-nano-2025-08-07"
      // instead of the deployment name "gpt-5-nano").
      let responseModel = attrs.responseModel;
      if (!responseModel) {
        const metaSources = [span.metadata, attrs.metadata];
        for (const raw of metaSources) {
          if (!raw) continue;
          try {
            const meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (meta?.body?.model) { responseModel = meta.body.model; break; }
          } catch (e: unknown) {
            console.warn('[neatlogs-mastra] Failed to parse metadata for model extraction:', e);
          }
        }
      }

      const inherited = this._resolveModelInfo(parentSpanId);
      const resolvedModel = responseModel ?? inherited?.model ?? attrs.model;
      const provider = attrs.provider ?? inherited?.provider;

      if (attrs.model) {
        otelSpan.setAttribute('gen_ai.request.model', attrs.model);
      }
      if (resolvedModel) {
        otelSpan.setAttribute('llm.model_name', resolvedModel);
      }
      if (responseModel) {
        otelSpan.setAttribute('gen_ai.response.model', responseModel);
      } else if (inherited?.model) {
        otelSpan.setAttribute('gen_ai.response.model', inherited.model);
      }
      if (provider) {
        otelSpan.setAttribute('gen_ai.system', provider);
        otelSpan.setAttribute('llm.provider', provider);
      }
      if (attrs.finishReason) {
        otelSpan.setAttribute('llm.response.finish_reason', attrs.finishReason);
      }
      // Only emit token counts on model_step (per-call canonical spans).
      // model_generation carries the aggregated total across all steps — emitting
      // it would cause double-counting in cost calculation since the backend sums
      // tokens from all LLM spans in a trace.
      if (type === 'model_step') {
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
      }
      if (attrs.parameters && Object.keys(attrs.parameters).length > 0) {
        try {
          otelSpan.setAttribute('llm.invocation_parameters', JSON.stringify(attrs.parameters));
          this._modelParameters.set(span.id, attrs.parameters);
        } catch (e) {
          _warn(`Failed to set invocation parameters: ${e}`);
        }
      } else if (type === 'model_step') {
        const inherited = this._resolveModelParameters(parentSpanId);
        if (inherited) {
          try {
            otelSpan.setAttribute('llm.invocation_parameters', JSON.stringify(inherited));
          } catch (e) {
            _warn(`Failed to set inherited invocation parameters: ${e}`);
          }
        }
      }
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
    const hasStructuredMessages = type === 'model_generation' || type === 'model_step';

    if (hasStructuredMessages) {
      const input = type === 'model_generation' && span.input?.messages
        ? span.input.messages
        : span.input;
      if (Array.isArray(input) && input.length > 0) {
        flattenMessages(input, 'llm.input_messages', (k, v) =>
          otelSpan.setAttribute(k, v),
        );
      } else if (input !== undefined && input !== null) {
        otelSpan.setAttribute('input.value', _safeStringify(input));
      }

      if (Array.isArray(span.output) && span.output.length > 0) {
        flattenMessages(span.output, 'llm.output_messages', (k, v) =>
          otelSpan.setAttribute(k, v),
        );
      } else if (span.output !== undefined && span.output !== null) {
        otelSpan.setAttribute('output.value', _safeStringify(span.output));
      }
    } else {
      const isTool = type === 'tool_call' || type === 'mcp_tool_call';
      const oiKind = getOiKind(type);
      if (span.input !== undefined && span.input !== null) {
        const inputStr = _safeStringify(span.input);
        otelSpan.setAttribute('input.value', inputStr);
        if (isTool) {
          otelSpan.setAttribute('tool.input', inputStr);
          otelSpan.setAttribute('neatlogs.tool.input', inputStr);
        } else if (oiKind === 'CHAIN') {
          otelSpan.setAttribute('chain.input', inputStr);
          otelSpan.setAttribute('neatlogs.chain.input', inputStr);
        } else if (oiKind === 'WORKFLOW') {
          otelSpan.setAttribute('workflow.input', inputStr);
          otelSpan.setAttribute('neatlogs.workflow.input', inputStr);
        } else if (oiKind === 'AGENT') {
          otelSpan.setAttribute('agent.input', inputStr);
          otelSpan.setAttribute('neatlogs.agent.input', inputStr);
        }
      }
      if (span.output !== undefined && span.output !== null) {
        const outputStr = _safeStringify(span.output);
        otelSpan.setAttribute('output.value', outputStr);
        if (isTool) {
          otelSpan.setAttribute('tool.output', outputStr);
          otelSpan.setAttribute('neatlogs.tool.output', outputStr);
        } else if (oiKind === 'CHAIN') {
          otelSpan.setAttribute('chain.output', outputStr);
          otelSpan.setAttribute('neatlogs.chain.output', outputStr);
        } else if (oiKind === 'WORKFLOW') {
          otelSpan.setAttribute('workflow.output', outputStr);
          otelSpan.setAttribute('neatlogs.workflow.output', outputStr);
        } else if (oiKind === 'AGENT') {
          otelSpan.setAttribute('agent.output', outputStr);
          otelSpan.setAttribute('neatlogs.agent.output', outputStr);
        }
      }
    }
  }

  async flush(): Promise<void> {
    // No-op — active spans should not be ended on flush
  }

  async shutdown(): Promise<void> {
    for (const [_id, entry] of this._activeSpans) {
      try {
        entry.span.setStatus({ code: SpanStatusCode.UNSET });
        entry.span.end();
      } catch {
        // best-effort
      }
    }
    this._activeSpans.clear();
  }

  init?(_options: any): void {}
  __setLogger?(_logger: any): void {}
}

/** @deprecated Use NeatlogsMastraBridge instead */
export const NeatlogsMastraExporter = NeatlogsMastraBridge;

// ---------------------------------------------------------------------------
// createNeatlogsMastraObservability helper
// ---------------------------------------------------------------------------

export interface CreateObservabilityOptions {
  /** Supply a pre-built bridge instead of auto-creating one. */
  bridge?: NeatlogsMastraBridge;
  /** @deprecated Use `bridge` instead. */
  exporter?: NeatlogsMastraBridge;
  /** @internal — inject the @mastra/observability module (for testing). */
  _observabilityModule?: any;
}

/**
 * Dynamically requires @mastra/observability and constructs an Observability
 * instance wired with a NeatlogsMastraBridge.
 *
 * The bridge implements createSpan() + executeInContext() so that OTel context
 * propagates into Mastra step executions, keeping all spans in a single trace.
 *
 * Throws if @mastra/observability is unavailable or Observability is not a
 * constructor.
 */
export async function createNeatlogsMastraObservability(
  tracerProvider: TracerProvider,
  options?: CreateObservabilityOptions,
): Promise<{ observability: any; exporter: NeatlogsMastraBridge }> {
  const obsModule = options?._observabilityModule ?? await import('@mastra/observability');
  const Observability = obsModule?.Observability ?? obsModule?.default?.Observability;

  if (typeof Observability !== 'function') {
    throw new Error(
      '@mastra/observability does not export a valid Observability constructor',
    );
  }

  const bridge = options?.bridge ?? options?.exporter ?? new NeatlogsMastraBridge(tracerProvider);
  const observability = new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        bridge,
      },
    },
  });

  return { observability, exporter: bridge };
}

// ---------------------------------------------------------------------------
// MastraInstrumentor
// ---------------------------------------------------------------------------

export interface MastraInstrumentorOptions {
  tracerProvider: TracerProvider;
  /** @internal — for testing only; inject the module instead of require(). */
  _module?: any;
  /** @internal — for testing only; inject a pre-built bridge instance. */
  _exporter?: any;
  /** @internal — for testing only; inject the @mastra/observability module. */
  _observabilityModule?: any;
}

/**
 * Instrumentor for @mastra/core. Patches the Mastra constructor to
 * auto-inject NeatlogsMastraBridge into Mastra's observability config.
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

  private _patchFailed(reason: string): void {
    this._origMastraConstructor = null;
    this._mastraModule = null;
    _warn(
      `Cannot patch @mastra/core: ${reason}. ` +
      'Mastra spans will not be collected. ' +
      'Use `createNeatlogsMastraObservability()` and pass the result to ' +
      'new Mastra({ observability: ... }) directly instead.',
    );
  }

  disable(): void {
    if (this._mastraModule && this._origMastraConstructor) {
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
          // best-effort
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

    const PatchedMastra = function (this: any, config?: any) {
      const cfg = config ?? {};

      if (!cfg.observability) {
        try {
          const obsModule = options._observabilityModule ?? (() => { throw new Error('sync path unavailable'); })();
          const Obs = obsModule?.Observability ?? obsModule?.default?.Observability;
          if (typeof Obs === 'function') {
            const bridge = options._exporter ?? new NeatlogsMastraBridge(provider);
            cfg.observability = new Obs({
              configs: { default: { serviceName: 'mastra', bridge } },
            });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          _warn(
            `Mastra instrumentation could not activate: ${msg}. ` +
            'Use getMastraObservability() from neatlogs for ESM projects.',
          );
        }
      }

      return Reflect.construct(origConstructor, [cfg], new.target ?? origConstructor);
    };

    PatchedMastra.prototype = MastraClass.prototype;
    Object.setPrototypeOf(PatchedMastra, MastraClass);

    for (const key of Object.getOwnPropertyNames(MastraClass)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue;
      try {
        const desc = Object.getOwnPropertyDescriptor(MastraClass, key);
        if (desc) Object.defineProperty(PatchedMastra, key, desc);
      } catch {
        // best-effort
      }
    }

    const desc = Object.getOwnPropertyDescriptor(mastraModule, 'Mastra');
    if (desc && !desc.configurable) {
      this._patchFailed(
        'the "Mastra" export is non-configurable ' +
        '(module exports are sealed). Constructor patching is not possible',
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
        this._patchFailed(
          'all attempts to replace the "Mastra" ' +
          'export on the module object threw errors',
        );
        return;
      }
    }

    if (mastraModule.Mastra !== PatchedMastra) {
      this._patchFailed(
        'the "Mastra" export was not replaced ' +
        'after assignment (silent no-op)',
      );
    }
  }
}

export default MastraInstrumentor;
