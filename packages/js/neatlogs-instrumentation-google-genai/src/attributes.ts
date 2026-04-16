import type { Span } from '@opentelemetry/api';

const DEFAULT_MAX_LENGTH = 10000;

/**
 * Safely stringify an object to JSON with truncation.
 * Returns empty string on error or if `JSON.stringify` returns `undefined`.
 */
export function safeJsonStringify(obj: any, maxLength: number = DEFAULT_MAX_LENGTH): string {
  try {
    const str = JSON.stringify(obj);
    if (str && str.length > maxLength) {
      return str.substring(0, maxLength);
    }
    return str ?? '';
  } catch {
    return '';
  }
}

/**
 * Extract concatenated text from an array of content parts.
 * Filters to parts that have a `text` property and joins them.
 */
export function extractTextFromParts(parts: any[]): string {
  return parts
    .filter((p: any) => p.text)
    .map((p: any) => p.text)
    .join('');
}

/**
 * Set OpenInference flat-indexed input message attributes on a span.
 * Iterates over the contents array and sets role + content for each message.
 * Best-effort: errors are silently caught.
 */
export function setInputMessageAttributes(span: Span, contents: any[]): void {
  try {
    if (!Array.isArray(contents)) return;
    contents.forEach((content, i) => {
      const role = content.role || 'user';
      span.setAttribute(`llm.input_messages.${i}.message.role`, role);
      if (content.parts) {
        const textParts = extractTextFromParts(content.parts);
        if (textParts) {
          span.setAttribute(
            `llm.input_messages.${i}.message.content`,
            textParts,
          );
        }
      }
    });
  } catch {
    // Best-effort
  }
}

/**
 * Set output attributes on a span from a non-streaming generateContent result.
 * Extracts candidate content, finish reason, usage metadata, and output value.
 * Best-effort: errors are silently caught.
 */
export function setOutputAttributes(span: Span, result: any): void {
  try {
    if (result.candidates?.[0]) {
      const candidate = result.candidates[0];
      if (candidate.content?.parts) {
        const text = extractTextFromParts(candidate.content.parts);
        span.setAttribute(
          'llm.output_messages.0.message.role',
          candidate.content.role || 'model',
        );
        span.setAttribute('llm.output_messages.0.message.content', text);
      }
      if (candidate.finishReason) {
        span.setAttribute('gen_ai.response.finish_reasons', [
          candidate.finishReason,
        ]);
      }
    }
    if (result.usageMetadata) {
      const usage = result.usageMetadata;
      if (usage.promptTokenCount !== undefined) {
        span.setAttribute('llm.token_count.prompt', usage.promptTokenCount);
        span.setAttribute(
          'gen_ai.usage.prompt_tokens',
          usage.promptTokenCount,
        );
      }
      if (usage.candidatesTokenCount !== undefined) {
        span.setAttribute(
          'llm.token_count.completion',
          usage.candidatesTokenCount,
        );
        span.setAttribute(
          'gen_ai.usage.completion_tokens',
          usage.candidatesTokenCount,
        );
      }
      if (usage.totalTokenCount !== undefined) {
        span.setAttribute('llm.token_count.total', usage.totalTokenCount);
      }
    }
    span.setAttribute('output.value', safeJsonStringify(result));
  } catch {
    // Best-effort
  }
}

/**
 * Finalize span attributes from accumulated stream chunks.
 * Concatenates text from all chunks, extracts usage metadata from the last
 * chunk that has it, and extracts finish reason from the last chunk.
 * Best-effort: errors are silently caught.
 */
export function finalizeStreamAttributes(span: Span, chunks: any[]): void {
  try {
    let fullText = '';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;
    let finishReason = '';

    for (const chunk of chunks) {
      if (chunk.candidates?.[0]?.content?.parts) {
        for (const part of chunk.candidates[0].content.parts) {
          if (part.text) fullText += part.text;
        }
      }
      if (chunk.candidates?.[0]?.finishReason) {
        finishReason = chunk.candidates[0].finishReason;
      }
      if (chunk.usageMetadata) {
        totalPromptTokens =
          chunk.usageMetadata.promptTokenCount ?? totalPromptTokens;
        totalCompletionTokens =
          chunk.usageMetadata.candidatesTokenCount ?? totalCompletionTokens;
        totalTokens =
          chunk.usageMetadata.totalTokenCount ?? totalTokens;
      }
    }

    span.setAttribute('llm.output_messages.0.message.role', 'model');
    span.setAttribute('llm.output_messages.0.message.content', fullText);
    if (finishReason) {
      span.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
    }
    if (totalPromptTokens) {
      span.setAttribute('llm.token_count.prompt', totalPromptTokens);
      span.setAttribute('gen_ai.usage.prompt_tokens', totalPromptTokens);
    }
    if (totalCompletionTokens) {
      span.setAttribute(
        'llm.token_count.completion',
        totalCompletionTokens,
      );
      span.setAttribute(
        'gen_ai.usage.completion_tokens',
        totalCompletionTokens,
      );
    }
    if (totalTokens) {
      span.setAttribute('llm.token_count.total', totalTokens);
    }
  } catch {
    // Best-effort
  }
}
