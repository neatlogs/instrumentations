import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';
import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { GoogleGenAIInstrumentationConfig } from './types.js';
import {
  setInputMessageAttributes,
  setOutputAttributes,
  finalizeStreamAttributes,
} from './attributes.js';

const INSTRUMENTATION_NAME = '@neatlogs/instrumentation-google-genai';
const INSTRUMENTATION_VERSION = '0.1.0';

export class GoogleGenAIInstrumentation extends InstrumentationBase<GoogleGenAIInstrumentationConfig> {
  private _modelsProto: any = null;

  constructor(config: GoogleGenAIInstrumentationConfig = {}) {
    super(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION, config);
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition(
      '@google/genai',
      ['>=0.1.0'],
      (moduleExports: any, _moduleVersion?: string) => {
        this._patchModule(moduleExports);
        return moduleExports;
      },
      (_moduleExports: any, _moduleVersion?: string) => {
        this._unpatchModule();
      },
    );
  }

  private _findModelsPrototype(genaiModule: any): any {
    try {
      // Try direct class access first
      if (genaiModule.Models?.prototype) {
        return genaiModule.Models.prototype;
      }
      // Try creating a temporary instance to find the prototype
      const tempClient = new genaiModule.GoogleGenAI({ apiKey: 'temp' });
      if (tempClient.models) {
        return Object.getPrototypeOf(tempClient.models);
      }
    } catch {
      // Ignore — library may not be installed or API changed
    }
    return null;
  }

  private _patchModule(moduleExports: any): void {
    const ModelsProto = this._findModelsPrototype(moduleExports);
    if (!ModelsProto) {
      this._diag.debug(
        '@google/genai Models prototype not found, skipping patch',
      );
      return;
    }

    this._modelsProto = ModelsProto;

    // The @google/genai SDK assigns generateContent and generateContentStream
    // as instance arrow functions in the Models constructor. These arrow
    // functions delegate to generateContentInternal / generateContentStreamInternal
    // which ARE on the prototype. Patching the internal methods means all
    // instances are automatically instrumented without constructor wrapping.
    if (typeof ModelsProto.generateContentInternal === 'function') {
      this._wrap(
        ModelsProto,
        'generateContentInternal',
        this._patchGenerateContent(),
      );
    }

    if (typeof ModelsProto.generateContentStreamInternal === 'function') {
      this._wrap(
        ModelsProto,
        'generateContentStreamInternal',
        this._patchGenerateContentStream(),
      );
    }
  }

  private _unpatchModule(): void {
    if (this._modelsProto) {
      if (typeof this._modelsProto.generateContentInternal === 'function') {
        this._unwrap(this._modelsProto, 'generateContentInternal');
      }
      if (typeof this._modelsProto.generateContentStreamInternal === 'function') {
        this._unwrap(this._modelsProto, 'generateContentStreamInternal');
      }
      this._modelsProto = null;
    }
  }

  /**
   * Eagerly patch a pre-loaded @google/genai module.
   * Call this after enable() with the resolved module to handle ESM dynamic
   * imports where OTel module hooks don't fire.
   */
  patchEager(moduleExports: any): boolean {
    if (this._modelsProto) return true;
    this._patchModule(moduleExports);
    return this._modelsProto !== null;
  }

  /**
   * Set common request attributes on a span (shared between generate and stream).
   */
  private _setCommonRequestAttributes(
    span: Span,
    model: string,
    contents: any,
    request: any,
  ): void {
    span.setAttribute('openinference.span.kind', 'LLM');
    span.setAttribute('gen_ai.system', 'google_genai');
    span.setAttribute('gen_ai.request.model', model);
    span.setAttribute('llm.model_name', model);

    setInputMessageAttributes(span, contents);

    if (typeof contents === 'string') {
      span.setAttribute('input.value', contents);
    } else if (Array.isArray(contents)) {
      span.setAttribute('input.value', JSON.stringify(contents));
    }

    if (request.config) {
      const config = request.config;
      if (config.temperature !== undefined) {
        span.setAttribute('gen_ai.request.temperature', config.temperature);
      }
      if (config.maxOutputTokens !== undefined) {
        span.setAttribute('gen_ai.request.max_tokens', config.maxOutputTokens);
      }
      if (config.topP !== undefined) {
        span.setAttribute('gen_ai.request.top_p', config.topP);
      }
      if (config.topK !== undefined) {
        span.setAttribute('gen_ai.request.top_k', config.topK);
      }
      if (config.systemInstruction) {
        const sysText = typeof config.systemInstruction === 'string'
          ? config.systemInstruction
          : config.systemInstruction?.parts?.map((p: any) => p.text).join('') ?? '';
        if (sysText) {
          span.setAttribute('llm.system', sysText);
        }
      }
    }
  }

  private _patchGenerateContent() {
    const instrumentation = this;
    return (original: Function) => {
      return async function (this: any, ...args: any[]) {
        const request = args[0] || {};
        const model =
          typeof request === 'string'
            ? request
            : request.model || 'unknown';
        const contents = request.contents || [];
        const spanName = `${model} generate`;

        return instrumentation.tracer.startActiveSpan(
          spanName,
          { kind: SpanKind.CLIENT },
          async (span: Span) => {
            try {
              instrumentation._setCommonRequestAttributes(
                span,
                model,
                contents,
                request,
              );

              const result = await original.apply(this, args);

              setOutputAttributes(span, result);
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return result;
            } catch (error: any) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error?.message,
              });
              span.recordException(error);
              span.end();
              throw error;
            }
          },
        );
      };
    };
  }

  private _patchGenerateContentStream() {
    const instrumentation = this;
    return (original: Function) => {
      return async function (this: any, ...args: any[]) {
        const request = args[0] || {};
        const model =
          typeof request === 'string'
            ? request
            : request.model || 'unknown';
        const contents = request.contents || [];
        const spanName = `${model} stream`;

        return instrumentation.tracer.startActiveSpan(
          spanName,
          { kind: SpanKind.CLIENT },
          async (span: Span) => {
            try {
              instrumentation._setCommonRequestAttributes(
                span,
                model,
                contents,
                request,
              );

              const streamResult = await original.apply(this, args);

              return instrumentation._wrapStream(span, streamResult);
            } catch (error: any) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error?.message,
              });
              span.recordException(error);
              span.end();
              throw error;
            }
          },
        );
      };
    };
  }

  private _wrapStream(span: Span, originalStream: any): any {
    const chunks: any[] = [];
    let ended = false;

    const endSpan = () => {
      if (ended) return;
      ended = true;
      finalizeStreamAttributes(span, chunks);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    };

    const wrappedStream = {
      [Symbol.asyncIterator]() {
        const iterator = originalStream[Symbol.asyncIterator]();
        return {
          async next() {
            try {
              const result = await iterator.next();
              if (!result.done && result.value) {
                chunks.push(result.value);
              }
              if (result.done) {
                endSpan();
              }
              return result;
            } catch (error: any) {
              if (!ended) {
                ended = true;
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: error?.message,
                });
                span.recordException(error);
                span.end();
              }
              throw error;
            }
          },
          async return(value?: any) {
            endSpan();
            return iterator.return?.(value) ?? { done: true as const, value };
          },
        };
      },
    };

    // Copy non-iterator properties from the original stream
    for (const key of Object.keys(originalStream)) {
      (wrappedStream as any)[key] = originalStream[key];
    }

    return wrappedStream;
  }
}
