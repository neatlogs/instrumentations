/**
 * Grouped Mastra Workflow Example
 *
 * Runs a real Mastra workflow with deterministic mock LLM output and wires
 * Mastra observability directly to the active NeatLogs TracerProvider. With the
 * lifecycle-aware NeatlogsMastraExporter, workflow/agent/tool/LLM spans are
 * grouped under one trace instead of appearing as one-span traces.
 *
 * Local-only run (no NeatLogs API key required):
 *   NEATLOGS_DISABLE_EXPORT=true pnpm run example:grouped
 *   pnpm run verify:grouped
 *
 * Remote export run:
 *   NEATLOGS_API_KEY=... NEATLOGS_ENDPOINT=https://ingest.neatlogs.com pnpm run example:grouped
 */

import { init, flush, shutdown } from 'neatlogs';
import { trace, type TracerProvider } from '@opentelemetry/api';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNeatlogsMastraObservability } from '../src/instrumentation.js';

const workflowName = process.env.NEATLOGS_WORKFLOW_NAME ?? 'mastra-grouped-workflow-example';

process.env.NEATLOGS_LOG_RAW_SPANS = process.env.NEATLOGS_LOG_RAW_SPANS ?? 'true';
process.env.NEATLOGS_LOG_SPANS = process.env.NEATLOGS_LOG_SPANS ?? 'true';
process.env.NEATLOGS_LOG_RAW_SPANS_FILE = process.env.NEATLOGS_LOG_RAW_SPANS_FILE ?? 'logs/grouped-workflow-raw.jsonl';
process.env.NEATLOGS_LOG_SPANS_FILE = process.env.NEATLOGS_LOG_SPANS_FILE ?? 'logs/grouped-workflow-processed.jsonl';

for (const logFile of [process.env.NEATLOGS_LOG_RAW_SPANS_FILE, process.env.NEATLOGS_LOG_SPANS_FILE]) {
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    rmSync(logFile, { force: true });
  }
}

async function buildMastra(tracerProvider: TracerProvider) {
  const loadAccountMetrics = createTool({
    id: 'load-account-metrics',
    description: 'Load deterministic account metrics for a sample customer.',
    inputSchema: z.object({ accountId: z.string() }),
    outputSchema: z.object({ accountId: z.string(), activeUsers: z.number(), churnRisk: z.number() }),
    execute: async ({ accountId }: { accountId: string }) => ({
      accountId,
      activeUsers: 185000,
      churnRisk: 0.18,
    }),
  });

  const summarizePlan = createTool({
    id: 'summarize-plan',
    description: 'Summarize a tactical growth plan.',
    inputSchema: z.object({ company: z.string(), agentText: z.string() }),
    outputSchema: z.object({ title: z.string(), actions: z.array(z.string()) }),
    execute: async ({ company, agentText }: { company: string; agentText: string }) => ({
      title: `${company} growth plan`,
      actions: [
        'Prioritize enterprise onboarding',
        'Instrument support deflection',
        `Use agent insight: ${agentText.slice(0, 60)}`,
      ],
    }),
  });

  const strategist = new Agent({
    id: 'growth-strategist',
    name: 'Growth Strategist',
    instructions: 'Create concise risk-aware go-to-market recommendations.',
    model: createMockModel({
      mockText: 'Focus enterprise onboarding, support deflection, and weekly expansion risk reviews.',
    }),
    tools: { loadAccountMetrics, summarizePlan },
  });

  const loadMetricsStep = createStep({
    id: 'load-metrics',
    inputSchema: z.object({ accountId: z.string(), company: z.string() }),
    outputSchema: z.object({ accountId: z.string(), company: z.string(), metrics: z.any() }),
    execute: async ({ inputData }: any) => ({
      ...inputData,
      metrics: await loadAccountMetrics.execute({ accountId: inputData.accountId }, {} as any),
    }),
  });

  const agentPlanStep = createStep({
    id: 'agent-plan',
    inputSchema: z.object({ accountId: z.string(), company: z.string(), metrics: z.any() }),
    outputSchema: z.object({ accountId: z.string(), company: z.string(), metrics: z.any(), agentText: z.string() }),
    execute: async ({ inputData }: any) => {
      const result = await strategist.generate(
        `Company: ${inputData.company}. Users: ${inputData.metrics.activeUsers}. Churn risk: ${inputData.metrics.churnRisk}. Return a short plan.`,
      );
      return { ...inputData, agentText: result.text };
    },
  });

  const finalizeStep = createStep({
    id: 'finalize-plan',
    inputSchema: z.object({ accountId: z.string(), company: z.string(), metrics: z.any(), agentText: z.string() }),
    outputSchema: z.object({ company: z.string(), plan: z.any() }),
    execute: async ({ inputData }: any) => ({
      company: inputData.company,
      plan: await summarizePlan.execute({ company: inputData.company, agentText: inputData.agentText }, {} as any),
    }),
  });

  const growthWorkflow = createWorkflow({
    id: 'growth-diagnostics-workflow',
    inputSchema: z.object({ accountId: z.string(), company: z.string() }),
    outputSchema: z.object({ company: z.string(), plan: z.any() }),
  })
    .then(loadMetricsStep)
    .then(agentPlanStep)
    .then(finalizeStep)
    .commit();

  const { observability } = createNeatlogsMastraObservability(tracerProvider);
  const mastra = new Mastra({
    observability,
    agents: { strategist },
    workflows: { growthWorkflow },
  });

  return { mastra, workflow: mastra.getWorkflow('growthWorkflow') };
}

async function main() {
  await init({
    apiKey: process.env.NEATLOGS_API_KEY ?? '',
    endpoint: process.env.NEATLOGS_ENDPOINT ?? 'https://ingest.neatlogs.com',
    workflowName,
    tags: ['typescript', 'mastra', 'grouped-example'],
    debug: true,
  });

  const tracerProvider = trace.getTracerProvider();
  console.log(`[grouped] active TracerProvider: ${tracerProvider.constructor?.name ?? 'unknown'}`);

  const { workflow } = await buildMastra(tracerProvider);
  const run = await workflow.createRun({
    runId: 'grouped-example-run-001',
    resourceId: 'local-demo-account',
  });

  const result = await run.start({
    inputData: {
      accountId: 'acct-demo-001',
      company: 'Atlas Retail AI',
    },
  });

  console.log('[grouped] workflow result', JSON.stringify(result, null, 2));

  await flush();
  await shutdown();
}

main().catch((err) => {
  console.error('[grouped] failed', err);
  process.exitCode = 1;
});
