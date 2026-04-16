import type { Span } from '@opentelemetry/api';

const DEFAULT_MAX_LENGTH = 10000;

/**
 * Safely JSON.stringify an object with truncation.
 * Returns empty string on error.
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
 * Set OpenInference agent attributes on a span.
 * Best-effort — never throws.
 */
export function setAgentAttributes(span: Span, agent: any): void {
  try {
    span.setAttribute('openinference.span.kind', 'AGENT');

    if (agent?.name) {
      span.setAttribute('agent.name', agent.name);
    }

    if (agent?.instructions) {
      const instructions =
        typeof agent.instructions === 'string'
          ? agent.instructions.substring(0, DEFAULT_MAX_LENGTH)
          : safeJsonStringify(agent.instructions);
      span.setAttribute('agent.instructions', instructions);
    }

    if (agent?.tools) {
      try {
        let toolNames: string[];
        if (typeof agent.tools === 'object' && agent.tools !== null) {
          if (Array.isArray(agent.tools)) {
            toolNames = agent.tools.map((t: any) => t?.name ?? t?.id ?? String(t));
          } else {
            toolNames = Object.keys(agent.tools);
          }
        } else {
          toolNames = [];
        }
        if (toolNames.length > 0) {
          span.setAttribute('agent.available_tools', toolNames.join(','));
        }
      } catch {
        // ignore
      }
    }

    const modelName =
      agent?.model?.modelId ?? agent?.model?.model ?? agent?.modelId;
    if (modelName) {
      span.setAttribute('llm.model_name', modelName);
    }
  } catch {
    // best-effort
  }
}

/**
 * Set OpenInference agent response attributes on a span.
 * Best-effort — never throws.
 */
export function setAgentResponseAttributes(span: Span, result: any): void {
  try {
    if (result == null) return;

    const outputParts: string[] = [];

    if (result.text != null) {
      outputParts.push(typeof result.text === 'string' ? result.text : safeJsonStringify(result.text));
    }

    const outputValue = outputParts.length > 0
      ? outputParts.join('\n')
      : safeJsonStringify(result);
    if (outputValue) {
      span.setAttribute('output.value', outputValue.substring(0, DEFAULT_MAX_LENGTH));
    }

    if (result.usage) {
      if (result.usage.promptTokens != null) {
        span.setAttribute('llm.token_count.prompt', result.usage.promptTokens);
      }
      if (result.usage.completionTokens != null) {
        span.setAttribute('llm.token_count.completion', result.usage.completionTokens);
      }
      if (result.usage.totalTokens != null) {
        span.setAttribute('llm.token_count.total', result.usage.totalTokens);
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Set OpenInference workflow attributes on a span.
 * Best-effort — never throws.
 */
export function setWorkflowAttributes(span: Span, workflow: any): void {
  try {
    span.setAttribute('openinference.span.kind', 'WORKFLOW');

    if (workflow?.name) {
      span.setAttribute('workflow.name', workflow.name);
    }
  } catch {
    // best-effort
  }
}

/**
 * Set OpenInference tool attributes on a span.
 * Best-effort — never throws.
 */
export function setToolAttributes(span: Span, tool: any, input: any): void {
  try {
    span.setAttribute('openinference.span.kind', 'TOOL');

    const toolName = tool?.id ?? tool?.name;
    if (toolName) {
      span.setAttribute('tool.name', toolName);
    }

    if (tool?.description) {
      span.setAttribute('tool.description', tool.description);
    }

    const inputValue = safeJsonStringify(input);
    if (inputValue) {
      span.setAttribute('input.value', inputValue);
    }
  } catch {
    // best-effort
  }
}
