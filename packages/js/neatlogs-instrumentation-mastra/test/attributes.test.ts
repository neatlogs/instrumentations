import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  safeJsonStringify,
  setAgentAttributes,
  setAgentResponseAttributes,
  setWorkflowAttributes,
  setToolAttributes,
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

  it('should stringify a string', () => {
    expect(safeJsonStringify('hello')).toBe('"hello"');
  });

  it('should stringify an array', () => {
    expect(safeJsonStringify([1, 2, 3])).toBe('[1,2,3]');
  });

  it('should return empty string for circular references', () => {
    const obj: any = {};
    obj.self = obj;
    expect(safeJsonStringify(obj)).toBe('');
  });

  it('should return empty string for undefined', () => {
    expect(safeJsonStringify(undefined)).toBe('');
  });

  it('should truncate to maxLength', () => {
    const longString = 'a'.repeat(20000);
    const result = safeJsonStringify(longString, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('should truncate to default maxLength of 10000', () => {
    const longString = 'a'.repeat(20000);
    const result = safeJsonStringify(longString);
    expect(result.length).toBeLessThanOrEqual(10000);
  });

  it('should not truncate short strings', () => {
    const result = safeJsonStringify({ short: true });
    expect(result).toBe('{"short":true}');
  });

  it('should return empty string for null', () => {
    // JSON.stringify(null) returns "null"
    expect(safeJsonStringify(null)).toBe('null');
  });
});

describe('setAgentAttributes', () => {
  it('should set span kind to AGENT', () => {
    const span = createMockSpan();
    setAgentAttributes(span as any, {});
    expect(span.setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'AGENT');
  });

  it('should set agent.name when present', () => {
    const span = createMockSpan();
    setAgentAttributes(span as any, { name: 'TestAgent' });
    expect(span.setAttribute).toHaveBeenCalledWith('agent.name', 'TestAgent');
  });

  it('should set agent.instructions when present', () => {
    const span = createMockSpan();
    setAgentAttributes(span as any, { instructions: 'Be helpful' });
    expect(span.setAttribute).toHaveBeenCalledWith('agent.instructions', 'Be helpful');
  });

  it('should truncate long instructions', () => {
    const span = createMockSpan();
    const longInstructions = 'x'.repeat(20000);
    setAgentAttributes(span as any, { instructions: longInstructions });
    const call = span.setAttribute.mock.calls.find(
      (c: any[]) => c[0] === 'agent.instructions'
    );
    expect(call).toBeDefined();
    expect(call![1].length).toBeLessThanOrEqual(10000);
  });

  it('should set agent.available_tools from object keys', () => {
    const span = createMockSpan();
    setAgentAttributes(span as any, {
      tools: { search: {}, calculate: {}, fetch: {} },
    });
    expect(span.setAttribute).toHaveBeenCalledWith(
      'agent.available_tools',
      'search,calculate,fetch'
    );
  });

  it('should set agent.available_tools from array', () => {
    const span = createMockSpan();
    setAgentAttributes(span as any, {
      tools: [{ name: 'search' }, { name: 'calc' }],
    });
    expect(span.setAttribute).toHaveBeenCalledWith(
      'agent.available_tools',
      'search,calc'
    );
  });

  it('should set llm.model_name from agent.model.modelId', () => {
    const span = createMockSpan();
    setAgentAttributes(span as any, {
      model: { modelId: 'gpt-4' },
    });
    expect(span.setAttribute).toHaveBeenCalledWith('llm.model_name', 'gpt-4');
  });

  it('should set llm.model_name from agent.model.model', () => {
    const span = createMockSpan();
    setAgentAttributes(span as any, {
      model: { model: 'claude-3' },
    });
    expect(span.setAttribute).toHaveBeenCalledWith('llm.model_name', 'claude-3');
  });

  it('should set llm.model_name from agent.modelId', () => {
    const span = createMockSpan();
    setAgentAttributes(span as any, {
      modelId: 'gemini-pro',
    });
    expect(span.setAttribute).toHaveBeenCalledWith('llm.model_name', 'gemini-pro');
  });

  it('should not throw on null agent', () => {
    const span = createMockSpan();
    expect(() => setAgentAttributes(span as any, null)).not.toThrow();
  });

  it('should not throw on undefined agent', () => {
    const span = createMockSpan();
    expect(() => setAgentAttributes(span as any, undefined)).not.toThrow();
  });
});

describe('setAgentResponseAttributes', () => {
  it('should set output.value from result', () => {
    const span = createMockSpan();
    setAgentResponseAttributes(span as any, { data: 'test' });
    expect(span.setAttribute).toHaveBeenCalledWith(
      'output.value',
      expect.any(String)
    );
  });

  it('should use result.text when present', () => {
    const span = createMockSpan();
    setAgentResponseAttributes(span as any, { text: 'Hello world' });
    const call = span.setAttribute.mock.calls.find(
      (c: any[]) => c[0] === 'output.value'
    );
    expect(call![1]).toBe('Hello world');
  });

  it('should set token count attributes when usage is present', () => {
    const span = createMockSpan();
    setAgentResponseAttributes(span as any, {
      text: 'response',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
    });
    expect(span.setAttribute).toHaveBeenCalledWith('llm.token_count.prompt', 10);
    expect(span.setAttribute).toHaveBeenCalledWith('llm.token_count.completion', 20);
    expect(span.setAttribute).toHaveBeenCalledWith('llm.token_count.total', 30);
  });

  it('should not throw on null result', () => {
    const span = createMockSpan();
    expect(() => setAgentResponseAttributes(span as any, null)).not.toThrow();
  });

  it('should not throw on undefined result', () => {
    const span = createMockSpan();
    expect(() => setAgentResponseAttributes(span as any, undefined)).not.toThrow();
  });

  it('should not set token counts when usage is absent', () => {
    const span = createMockSpan();
    setAgentResponseAttributes(span as any, { text: 'hello' });
    expect(span.setAttribute).not.toHaveBeenCalledWith(
      'llm.token_count.prompt',
      expect.anything()
    );
  });
});

describe('setWorkflowAttributes', () => {
  it('should set span kind to WORKFLOW', () => {
    const span = createMockSpan();
    setWorkflowAttributes(span as any, {});
    expect(span.setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'WORKFLOW');
  });

  it('should set workflow.name when present', () => {
    const span = createMockSpan();
    setWorkflowAttributes(span as any, { name: 'MyWorkflow' });
    expect(span.setAttribute).toHaveBeenCalledWith('workflow.name', 'MyWorkflow');
  });

  it('should not throw on null workflow', () => {
    const span = createMockSpan();
    expect(() => setWorkflowAttributes(span as any, null)).not.toThrow();
  });
});

describe('setToolAttributes', () => {
  it('should set span kind to TOOL', () => {
    const span = createMockSpan();
    setToolAttributes(span as any, {}, {});
    expect(span.setAttribute).toHaveBeenCalledWith('openinference.span.kind', 'TOOL');
  });

  it('should set tool.name from tool.id', () => {
    const span = createMockSpan();
    setToolAttributes(span as any, { id: 'my-tool' }, {});
    expect(span.setAttribute).toHaveBeenCalledWith('tool.name', 'my-tool');
  });

  it('should set tool.name from tool.name when id is absent', () => {
    const span = createMockSpan();
    setToolAttributes(span as any, { name: 'my-tool-name' }, {});
    expect(span.setAttribute).toHaveBeenCalledWith('tool.name', 'my-tool-name');
  });

  it('should prefer tool.id over tool.name', () => {
    const span = createMockSpan();
    setToolAttributes(span as any, { id: 'tool-id', name: 'tool-name' }, {});
    expect(span.setAttribute).toHaveBeenCalledWith('tool.name', 'tool-id');
  });

  it('should set tool.description when present', () => {
    const span = createMockSpan();
    setToolAttributes(span as any, { id: 't', description: 'A test tool' }, {});
    expect(span.setAttribute).toHaveBeenCalledWith('tool.description', 'A test tool');
  });

  it('should set input.value', () => {
    const span = createMockSpan();
    setToolAttributes(span as any, { id: 't' }, { query: 'test' });
    expect(span.setAttribute).toHaveBeenCalledWith('input.value', '{"query":"test"}');
  });

  it('should not throw on null tool', () => {
    const span = createMockSpan();
    expect(() => setToolAttributes(span as any, null, null)).not.toThrow();
  });
});
