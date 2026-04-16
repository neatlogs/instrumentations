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

const instrumentationName = '@neatlogs/instrumentation-mastra';
const instrumentationVersion = '0.1.0';

export class MastraInstrumentation extends InstrumentationBase<MastraInstrumentationConfig> {
  private _agentPrototype: any;
  private _workflowPrototype: any;
  private _originalCreateTool: any;

  constructor(config: MastraInstrumentationConfig = {}) {
    super(instrumentationName, instrumentationVersion, config);
  }

  /**
   * Context-aware span helper: if Mastra's OtelBridge already created an
   * active span, enrich it with OpenInference attributes. Otherwise, create
   * our own span.
   */
  private async _getOrCreateSpan<T>(
    spanName: string,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan && activeSpan.isRecording()) {
      // Mastra's OtelBridge already created a span — enrich it
      return fn(activeSpan);
    }
    // No active span — create our own
    return this.tracer.startActiveSpan(
      spanName,
      { kind: SpanKind.INTERNAL },
      async (span: Span) => {
        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
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

  private _patch(moduleExports: any): void {
    // Patch Agent.prototype.generate and Agent.prototype.stream
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

    // Patch Workflow.prototype.execute
    const Workflow = moduleExports?.Workflow;
    if (Workflow?.prototype) {
      this._workflowPrototype = Workflow.prototype;

      if (typeof Workflow.prototype.execute === 'function') {
        this._wrap(Workflow.prototype, 'execute', this._patchWorkflowExecute());
      }
    }

    // Patch createTool
    if (typeof moduleExports?.createTool === 'function') {
      this._originalCreateTool = moduleExports.createTool;
      this._wrap(moduleExports, 'createTool', this._patchCreateTool());
    }
  }

  private _unpatch(moduleExports: any): void {
    if (this._agentPrototype) {
      if (typeof this._agentPrototype.generate === 'function') {
        this._unwrap(this._agentPrototype, 'generate');
      }
      if (typeof this._agentPrototype.stream === 'function') {
        this._unwrap(this._agentPrototype, 'stream');
      }
      this._agentPrototype = undefined;
    }

    if (this._workflowPrototype) {
      if (typeof this._workflowPrototype.execute === 'function') {
        this._unwrap(this._workflowPrototype, 'execute');
      }
      this._workflowPrototype = undefined;
    }

    if (moduleExports && this._originalCreateTool) {
      this._unwrap(moduleExports, 'createTool');
      this._originalCreateTool = undefined;
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

            if (args.length > 0) {
              const inputValue = safeJsonStringify(args[0]);
              if (inputValue) {
                span.setAttribute('input.value', inputValue);
              }
            }

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
        return instrumentation._getOrCreateSpan(
          'mastra.agent.stream',
          async (span: Span) => {
            setAgentAttributes(span, agent);

            if (args.length > 0) {
              const inputValue = safeJsonStringify(args[0]);
              if (inputValue) {
                span.setAttribute('input.value', inputValue);
              }
            }

            const result = await original.apply(agent, args);

            // Wrap the textStream to accumulate output and set attributes on completion.
            // Mastra exposes textStream as an AsyncIterable property, not a method.
            if (result && result.textStream) {
              const originalTextStream = result.textStream;
              const chunks: string[] = [];

              const wrappedTextStream = {
                [Symbol.asyncIterator]() {
                  const iterator =
                    typeof originalTextStream[Symbol.asyncIterator] === 'function'
                      ? originalTextStream[Symbol.asyncIterator]()
                      : originalTextStream;
                  return {
                    async next() {
                      const iterResult = await iterator.next();
                      if (!iterResult.done && iterResult.value != null) {
                        chunks.push(
                          typeof iterResult.value === 'string'
                            ? iterResult.value
                            : String(iterResult.value),
                        );
                      }
                      if (iterResult.done) {
                        // Stream completed — set response attributes
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
                      }
                      return iterResult;
                    },
                    async return(value?: any) {
                      // Early termination — still finalize
                      const accumulatedText = chunks.join('');
                      setAgentResponseAttributes(span, { text: accumulatedText });
                      return iterator.return?.(value) ?? { done: true as const, value };
                    },
                  };
                },
              };

              // Return a new result object with the wrapped textStream property
              return { ...result, textStream: wrappedTextStream };
            }

            return result;
          },
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

            if (args.length > 0) {
              const inputValue = safeJsonStringify(args[0]);
              if (inputValue) {
                span.setAttribute('input.value', inputValue);
              }
            }

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

  private _patchCreateTool() {
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
