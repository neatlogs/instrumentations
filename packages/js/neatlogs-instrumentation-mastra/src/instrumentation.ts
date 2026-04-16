import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';
import {
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api';
import type { MastraInstrumentationConfig } from './types.js';
import {
  setAgentAttributes,
  setAgentResponseAttributes,
  setWorkflowAttributes,
  setToolAttributes,
  safeJsonStringify,
} from './attributes.js';

const INSTRUMENTATION_NAME = '@neatlogs/instrumentation-mastra';
const INSTRUMENTATION_VERSION = '0.1.0';

export class MastraInstrumentation extends InstrumentationBase<MastraInstrumentationConfig> {
  private _agentPrototype: any = null;
  private _workflowPrototype: any = null;
  /** The module-exports object on which createTool was wrapped, for correct unpatch. */
  private _patchedToolsModule: any = null;

  constructor(config: MastraInstrumentationConfig = {}) {
    super(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION, config);
  }

  /**
   * Context-aware span helper: if Mastra's OtelBridge already created an
   * active span, enrich it with OpenInference attributes. Otherwise, create
   * our own span.
   */
  private async _getOrCreateSpan<T>(
    spanName: string,
    fn: (span: Span, isOwnSpan: boolean) => Promise<T>,
    /** When false, the caller is responsible for ending the span (e.g., streaming). */
    manageLifecycle = true,
  ): Promise<T> {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan && activeSpan.isRecording()) {
      // Mastra's OtelBridge already created a span — enrich it (don't end it)
      return fn(activeSpan, false);
    }
    // No active span — create our own
    return this.tracer.startActiveSpan(
      spanName,
      { kind: SpanKind.INTERNAL },
      async (span: Span) => {
        try {
          const result = await fn(span, true);
          if (manageLifecycle) {
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
          }
          return result;
        } catch (error: any) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
          span.recordException(error);
          span.end();
          throw error;
        }
      },
    );
  }

  /**
   * Set input.value on a span from the first argument if present.
   */
  private _setInputValue(span: Span, args: any[]): void {
    if (args.length > 0) {
      const inputValue = safeJsonStringify(args[0]);
      if (inputValue) {
        span.setAttribute('input.value', inputValue);
      }
    }
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition(
      '@mastra/core',
      ['>=1.0.0'],
      (moduleExports: any) => {
        this._patch(moduleExports);
        return moduleExports;
      },
      (moduleExports: any) => {
        this._unpatch(moduleExports);
      },
    );
  }

  /**
   * Patch Agent, Workflow, and createTool.
   *
   * Older versions of @mastra/core export everything from the root entry
   * point, so we first try patching from `moduleExports` directly.
   *
   * Newer versions (v1.25+) moved these to subpath exports
   * (@mastra/core/agent, @mastra/core/workflows, @mastra/core/tools).
   * The OTel require-in-the-middle hook resolves subpath imports to
   * internal file paths (e.g. @mastra/core/dist/agent/index.cjs) which
   * cannot be reliably matched by InstrumentationNodeModuleFile names.
   * Instead, we dynamically require the subpath modules here. Since the
   * root @mastra/core package is already resolved at this point, Node
   * will resolve the subpaths from the same package directory.
   */
  private _patch(moduleExports: any): void {
    // Try patching from root exports (works for older versions)
    this._patchAgentModule(moduleExports);
    this._patchWorkflowModule(moduleExports);
    this._patchToolsModule(moduleExports);

    // For newer versions where classes live in subpath exports,
    // dynamically require and patch each subpath module.
    if (!moduleExports?.Agent) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        this._patchAgentModule(require('@mastra/core/agent'));
      } catch {
        // Subpath not available — skip
      }
    }
    if (!moduleExports?.Workflow) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        this._patchWorkflowModule(require('@mastra/core/workflows'));
      } catch {
        // Subpath not available — skip
      }
    }
    if (!moduleExports?.createTool) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        this._patchToolsModule(require('@mastra/core/tools'));
      } catch {
        // Subpath not available — skip
      }
    }
  }

  private _unpatch(moduleExports: any): void {
    this._unpatchAgentModule(moduleExports);
    this._unpatchWorkflowModule(moduleExports);
    this._unpatchToolsModule(moduleExports);
  }

  /**
   * Patch Agent.prototype.generate and Agent.prototype.stream.
   * Works for both root module exports and @mastra/core/agent subpath.
   */
  private _patchAgentModule(moduleExports: any): void {
    const Agent = moduleExports?.Agent;
    if (Agent?.prototype) {
      this._agentPrototype = Agent.prototype;

      if (typeof Agent.prototype.generate === 'function') {
        this._wrap(Agent.prototype, 'generate', this._patchAgentGenerate());
      }

      if (typeof Agent.prototype.stream === 'function') {
        this._wrap(Agent.prototype, 'stream', this._patchAgentStream());
      }
    }
  }

  private _unpatchAgentModule(_moduleExports?: any): void {
    if (this._agentPrototype) {
      if (typeof this._agentPrototype.generate === 'function') {
        this._unwrap(this._agentPrototype, 'generate');
      }
      if (typeof this._agentPrototype.stream === 'function') {
        this._unwrap(this._agentPrototype, 'stream');
      }
      this._agentPrototype = null;
    }
  }

  /**
   * Patch Workflow.prototype.execute.
   * Works for both root module exports and @mastra/core/workflows subpath.
   */
  private _patchWorkflowModule(moduleExports: any): void {
    const Workflow = moduleExports?.Workflow;
    if (Workflow?.prototype) {
      this._workflowPrototype = Workflow.prototype;

      if (typeof Workflow.prototype.execute === 'function') {
        this._wrap(Workflow.prototype, 'execute', this._patchWorkflowExecute());
      }
    }
  }

  private _unpatchWorkflowModule(_moduleExports?: any): void {
    if (this._workflowPrototype) {
      if (typeof this._workflowPrototype.execute === 'function') {
        this._unwrap(this._workflowPrototype, 'execute');
      }
      this._workflowPrototype = null;
    }
  }

  /**
   * Patch createTool function.
   * Works for both root module exports and @mastra/core/tools subpath.
   */
  private _patchToolsModule(moduleExports: any): void {
    if (typeof moduleExports?.createTool === 'function') {
      // Store the module reference (not the original fn) so _unpatchToolsModule always
      // unwraps from the exact object that was wrapped — avoids mismatched-object bugs
      // when root and subpath exports are different objects.
      this._patchedToolsModule = moduleExports;
      this._wrap(moduleExports, 'createTool', this._patchCreateToolFn());
    }
  }

  private _unpatchToolsModule(_moduleExports?: any): void {
    if (this._patchedToolsModule) {
      this._unwrap(this._patchedToolsModule, 'createTool');
      this._patchedToolsModule = null;
    }
  }

  private _patchAgentGenerate() {
    const instrumentation = this;
    return function generatePatchFactory(original: Function) {
      return function patchedGenerate(this: any, ...args: any[]) {
        const agent = this;
        return instrumentation._getOrCreateSpan(
          'mastra.agent.generate',
          async (span: Span) => {
            setAgentAttributes(span, agent);
            instrumentation._setInputValue(span, args);

            const result = await original.apply(agent, args);
            setAgentResponseAttributes(span, result);
            return result;
          },
        );
      };
    };
  }

  private _patchAgentStream() {
    const instrumentation = this;
    return function streamPatchFactory(original: Function) {
      return function patchedStream(this: any, ...args: any[]) {
        const agent = this;
        // Pass manageLifecycle=false so the span stays open until the stream is consumed
        return instrumentation._getOrCreateSpan(
          'mastra.agent.stream',
          async (span: Span, isOwnSpan: boolean) => {
            setAgentAttributes(span, agent);
            instrumentation._setInputValue(span, args);

            const result = await original.apply(agent, args);

            // Wrap the textStream to accumulate output and set attributes on completion.
            // Mastra exposes textStream as an AsyncIterable property, not a method.
            if (result && result.textStream) {
              const originalTextStream = result.textStream;
              const chunks: string[] = [];
              let finalized = false;

              const finalizeStream = async () => {
                if (finalized) return;
                finalized = true;

                const accumulatedText = chunks.join('');
                const responseData: any = { text: accumulatedText };

                try {
                  if (result.usage && typeof result.usage.then === 'function') {
                    const usage = await result.usage;
                    responseData.usage = usage;
                  } else if (result.usage) {
                    responseData.usage = result.usage;
                  }
                } catch {
                  // ignore usage errors
                }

                setAgentResponseAttributes(span, responseData);
                // Only end the span if we created it (not borrowed from OtelBridge)
                if (isOwnSpan) {
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                }
              };

              const wrappedTextStream = {
                [Symbol.asyncIterator]() {
                  let iterator: any;
                  if (typeof originalTextStream[Symbol.asyncIterator] === 'function') {
                    iterator = originalTextStream[Symbol.asyncIterator]();
                  } else if (typeof originalTextStream.next === 'function') {
                    iterator = originalTextStream;
                  } else {
                    setAgentResponseAttributes(span, { text: '' });
                    if (isOwnSpan) {
                      span.setStatus({ code: SpanStatusCode.OK });
                      span.end();
                    }
                    finalized = true;
                    return {
                      async next() { return { done: true as const, value: undefined }; },
                    };
                  }
                  return {
                    async next() {
                      try {
                        const iterResult = await iterator.next();
                        if (!iterResult.done && iterResult.value != null) {
                          chunks.push(
                            typeof iterResult.value === 'string'
                              ? iterResult.value
                              : String(iterResult.value),
                          );
                        }
                        if (iterResult.done) {
                          await finalizeStream();
                        }
                        return iterResult;
                      } catch (error: any) {
                        if (!finalized && isOwnSpan) {
                          finalized = true;
                          span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
                          span.recordException(error);
                          span.end();
                        }
                        throw error;
                      }
                    },
                    async return(value?: any) {
                      await finalizeStream();
                      return iterator.return?.(value) ?? { done: true as const, value };
                    },
                  };
                },
              };

              return { ...result, textStream: wrappedTextStream };
            }

            // No textStream — end span normally
            if (isOwnSpan) {
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
            }
            return result;
          },
          false, // Don't auto-end span — stream wrapper or fallback handles it
        );
      };
    };
  }

  private _patchWorkflowExecute() {
    const instrumentation = this;
    return function executePatchFactory(original: Function) {
      return function patchedExecute(this: any, ...args: any[]) {
        const workflow = this;
        return instrumentation._getOrCreateSpan(
          'mastra.workflow.execute',
          async (span: Span) => {
            setWorkflowAttributes(span, workflow);
            instrumentation._setInputValue(span, args);

            const result = await original.apply(workflow, args);

            const outputValue = safeJsonStringify(result);
            if (outputValue) {
              span.setAttribute('output.value', outputValue);
            }

            return result;
          },
        );
      };
    };
  }

  private _patchCreateToolFn() {
    const instrumentation = this;
    return function createToolPatchFactory(original: Function) {
      return function patchedCreateTool(this: any, ...args: any[]) {
        const tool = original.apply(this, args);

        if (tool && typeof tool.execute === 'function') {
          const originalExecute = tool.execute;
          tool.execute = function patchedToolExecute(this: any, ...executeArgs: any[]) {
            const input = executeArgs[0];
            return instrumentation._getOrCreateSpan(
              'mastra.tool.execute',
              async (span: Span) => {
                setToolAttributes(span, tool, input);

                const result = await originalExecute.apply(this, executeArgs);

                const outputValue = safeJsonStringify(result);
                if (outputValue) {
                  span.setAttribute('output.value', outputValue);
                }

                return result;
              },
            );
          };
        }

        return tool;
      };
    };
  }
}
