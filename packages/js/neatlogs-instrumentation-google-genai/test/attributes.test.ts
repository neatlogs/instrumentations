import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  safeJsonStringify,
  extractTextFromParts,
  setInputMessageAttributes,
  setOutputAttributes,
  finalizeStreamAttributes,
} from '../src/attributes.js';

function createMockSpan() {
  const attributes: Record<string, any> = {};
  return {
    setAttribute: vi.fn((key: string, value: any) => {
      attributes[key] = value;
    }),
    _attributes: attributes,
  };
}

describe('safeJsonStringify', () => {
  it('should stringify a simple object', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('should truncate output exceeding maxLength', () => {
    const longObj = { data: 'x'.repeat(20000) };
    const result = safeJsonStringify(longObj, 100);
    expect(result.length).toBe(100);
  });

  it('should use default maxLength of 10000', () => {
    const longObj = { data: 'x'.repeat(20000) };
    const result = safeJsonStringify(longObj);
    expect(result.length).toBe(10000);
  });

  it('should return empty string for objects that cannot be serialized', () => {
    const circular: any = {};
    circular.self = circular;
    expect(safeJsonStringify(circular)).toBe('');
  });

  it('should return empty string for undefined', () => {
    expect(safeJsonStringify(undefined)).toBe('');
  });

  it('should not truncate short strings', () => {
    const result = safeJsonStringify({ key: 'val' });
    expect(result).toBe('{"key":"val"}');
  });
});

describe('extractTextFromParts', () => {
  it('should concatenate text from parts', () => {
    const parts = [{ text: 'Hello' }, { text: ' world' }];
    expect(extractTextFromParts(parts)).toBe('Hello world');
  });

  it('should skip non-text parts', () => {
    const parts = [{ text: 'Hello' }, { inlineData: {} }, { text: '!' }];
    expect(extractTextFromParts(parts)).toBe('Hello!');
  });

  it('should return empty string for no text parts', () => {
    const parts = [{ inlineData: {} }];
    expect(extractTextFromParts(parts)).toBe('');
  });

  it('should return empty string for empty array', () => {
    expect(extractTextFromParts([])).toBe('');
  });
});

describe('setInputMessageAttributes', () => {
  let mockSpan: ReturnType<typeof createMockSpan>;

  beforeEach(() => {
    mockSpan = createMockSpan();
  });

  it('should set role and content for each input message', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];

    setInputMessageAttributes(mockSpan as any, contents);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'llm.input_messages.0.message.role',
      'user',
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'llm.input_messages.0.message.content',
      'Hello',
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'llm.input_messages.1.message.role',
      'model',
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'llm.input_messages.1.message.content',
      'Hi there',
    );
  });

  it('should default role to "user" when not provided', () => {
    const contents = [{ parts: [{ text: 'Hello' }] }];

    setInputMessageAttributes(mockSpan as any, contents);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'llm.input_messages.0.message.role',
      'user',
    );
  });

  it('should join multiple text parts', () => {
    const contents = [
      {
        role: 'user',
        parts: [{ text: 'Hello ' }, { text: 'world' }],
      },
    ];

    setInputMessageAttributes(mockSpan as any, contents);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'llm.input_messages.0.message.content',
      'Hello world',
    );
  });

  it('should skip non-text parts', () => {
    const contents = [
      {
        role: 'user',
        parts: [{ text: 'Hello' }, { inlineData: {} }],
      },
    ];

    setInputMessageAttributes(mockSpan as any, contents);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'llm.input_messages.0.message.content',
      'Hello',
    );
  });

  it('should handle non-array contents gracefully', () => {
    setInputMessageAttributes(mockSpan as any, 'not an array' as any);
    expect(mockSpan.setAttribute).not.toHaveBeenCalled();
  });

  it('should handle contents without parts', () => {
    const contents = [{ role: 'system' }];

    setInputMessageAttributes(mockSpan as any, contents);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'llm.input_messages.0.message.role',
      'system',
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledTimes(1);
  });

  it('should not throw on malformed input', () => {
    expect(() => {
      setInputMessageAttributes(mockSpan as any, [null, undefined, 42] as any);
    }).not.toThrow();
  });
});

describe('setOutputAttributes', () => {
  let mockSpan: ReturnType<typeof createMockSpan>;

  beforeEach(() => {
    mockSpan = createMockSpan();
  });

  it('should set output message attributes from candidates', () => {
    const result = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'Hello!' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    };

    setOutputAttributes(mockSpan as any, result);

    expect(mockSpan._attributes['llm.output_messages.0.message.role']).toBe(
      'model',
    );
    expect(
      mockSpan._attributes['llm.output_messages.0.message.content'],
    ).toBe('Hello!');
    expect(mockSpan._attributes['gen_ai.response.finish_reasons']).toEqual([
      'STOP',
    ]);
    expect(mockSpan._attributes['llm.token_count.prompt']).toBe(10);
    expect(mockSpan._attributes['llm.token_count.completion']).toBe(5);
    expect(mockSpan._attributes['llm.token_count.total']).toBe(15);
    expect(mockSpan._attributes['gen_ai.usage.prompt_tokens']).toBe(10);
    expect(mockSpan._attributes['gen_ai.usage.completion_tokens']).toBe(5);
  });

  it('should set output.value as truncated JSON', () => {
    const result = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'ok' }] },
        },
      ],
    };

    setOutputAttributes(mockSpan as any, result);

    const outputValue = mockSpan._attributes['output.value'];
    expect(outputValue).toBeDefined();
    expect(typeof outputValue).toBe('string');
    expect(outputValue.length).toBeLessThanOrEqual(10000);
  });

  it('should default role to "model" when not provided', () => {
    const result = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Response' }],
          },
        },
      ],
    };

    setOutputAttributes(mockSpan as any, result);

    expect(mockSpan._attributes['llm.output_messages.0.message.role']).toBe(
      'model',
    );
  });

  it('should handle result with no candidates', () => {
    expect(() => {
      setOutputAttributes(mockSpan as any, {});
    }).not.toThrow();
  });

  it('should handle result with no usageMetadata', () => {
    const result = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hello' }] },
        },
      ],
    };

    setOutputAttributes(mockSpan as any, result);

    expect(mockSpan._attributes['llm.token_count.prompt']).toBeUndefined();
  });

  it('should not set finish_reasons if not present', () => {
    const result = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hello' }] },
        },
      ],
    };

    setOutputAttributes(mockSpan as any, result);

    expect(
      mockSpan._attributes['gen_ai.response.finish_reasons'],
    ).toBeUndefined();
  });
});

describe('finalizeStreamAttributes', () => {
  let mockSpan: ReturnType<typeof createMockSpan>;

  beforeEach(() => {
    mockSpan = createMockSpan();
  });

  it('should accumulate text from multiple chunks', () => {
    const chunks = [
      {
        candidates: [
          { content: { parts: [{ text: 'Hello' }] } },
        ],
      },
      {
        candidates: [
          { content: { parts: [{ text: ' world' }] } },
        ],
      },
    ];

    finalizeStreamAttributes(mockSpan as any, chunks);

    expect(
      mockSpan._attributes['llm.output_messages.0.message.content'],
    ).toBe('Hello world');
    expect(mockSpan._attributes['llm.output_messages.0.message.role']).toBe(
      'model',
    );
  });

  it('should use finish reason from the last chunk that has one', () => {
    const chunks = [
      {
        candidates: [
          {
            content: { parts: [{ text: 'Hi' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      },
      {
        candidates: [
          {
            content: { parts: [{ text: '!' }] },
            finishReason: 'STOP',
          },
        ],
      },
    ];

    finalizeStreamAttributes(mockSpan as any, chunks);

    expect(mockSpan._attributes['gen_ai.response.finish_reasons']).toEqual([
      'STOP',
    ]);
  });

  it('should extract usage metadata from the last chunk that has it', () => {
    const chunks = [
      {
        candidates: [{ content: { parts: [{ text: 'A' }] } }],
      },
      {
        candidates: [{ content: { parts: [{ text: 'B' }] } }],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 10,
          totalTokenCount: 30,
        },
      },
    ];

    finalizeStreamAttributes(mockSpan as any, chunks);

    expect(mockSpan._attributes['llm.token_count.prompt']).toBe(20);
    expect(mockSpan._attributes['llm.token_count.completion']).toBe(10);
    expect(mockSpan._attributes['llm.token_count.total']).toBe(30);
    expect(mockSpan._attributes['gen_ai.usage.prompt_tokens']).toBe(20);
    expect(mockSpan._attributes['gen_ai.usage.completion_tokens']).toBe(10);
  });

  it('should handle empty chunks array', () => {
    expect(() => {
      finalizeStreamAttributes(mockSpan as any, []);
    }).not.toThrow();

    expect(mockSpan._attributes['llm.output_messages.0.message.role']).toBe(
      'model',
    );
    expect(
      mockSpan._attributes['llm.output_messages.0.message.content'],
    ).toBe('');
  });

  it('should not set token counts when usage metadata is absent', () => {
    const chunks = [
      {
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
      },
    ];

    finalizeStreamAttributes(mockSpan as any, chunks);

    expect(mockSpan._attributes['llm.token_count.prompt']).toBeUndefined();
    expect(
      mockSpan._attributes['llm.token_count.completion'],
    ).toBeUndefined();
    expect(mockSpan._attributes['llm.token_count.total']).toBeUndefined();
  });

  it('should handle chunks with no candidates', () => {
    // Only totalTokenCount is present — prompt and completion should NOT be set
    // (writing 0 for absent fields would fabricate data the API never returned).
    const chunks = [{ usageMetadata: { totalTokenCount: 5 } }];

    expect(() => {
      finalizeStreamAttributes(mockSpan as any, chunks);
    }).not.toThrow();

    expect(mockSpan._attributes['llm.token_count.total']).toBe(5);
    // Fields absent from usageMetadata must remain unset — not written as 0
    expect(mockSpan._attributes['llm.token_count.prompt']).toBeUndefined();
    expect(mockSpan._attributes['llm.token_count.completion']).toBeUndefined();
    expect(mockSpan._attributes['gen_ai.usage.prompt_tokens']).toBeUndefined();
    expect(mockSpan._attributes['gen_ai.usage.completion_tokens']).toBeUndefined();
  });

  it('should set token counts to 0 when API returns zero (valid data, should not be suppressed)', () => {
    // When the API explicitly returns 0 for token counts (e.g., a model that reports
    // zero prompt tokens for a cached request), the attribute should be SET to 0,
    // not omitted. Zero is a valid data point distinguishable from "no data".
    const chunks = [
      {
        candidates: [{ content: { parts: [{ text: 'test' }] } }],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
      },
    ];

    finalizeStreamAttributes(mockSpan as any, chunks);

    expect(mockSpan._attributes['llm.token_count.prompt']).toBe(0);
    expect(mockSpan._attributes['llm.token_count.completion']).toBe(0);
    expect(mockSpan._attributes['llm.token_count.total']).toBe(0);
    expect(mockSpan._attributes['gen_ai.usage.prompt_tokens']).toBe(0);
    expect(mockSpan._attributes['gen_ai.usage.completion_tokens']).toBe(0);
  });

  it('should use the final chunk token counts even when they override earlier non-zero values', () => {
    // If chunk1 reports 10 prompt tokens and chunk2 reports 0 (e.g., incremental API),
    // the last chunk's values (0) should be respected — ?? only skips null/undefined.
    const chunks = [
      {
        candidates: [{ content: { parts: [{ text: 'A' }] } }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
      {
        candidates: [{ content: { parts: [{ text: 'B' }] } }],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
      },
    ];

    finalizeStreamAttributes(mockSpan as any, chunks);

    // The second chunk's explicit 0 values override chunk1's values via ??
    // and should be emitted as attributes (0 is valid, not absent).
    expect(mockSpan._attributes['llm.token_count.prompt']).toBe(0);
    expect(mockSpan._attributes['llm.token_count.completion']).toBe(0);
    expect(mockSpan._attributes['llm.token_count.total']).toBe(0);
  });
});
