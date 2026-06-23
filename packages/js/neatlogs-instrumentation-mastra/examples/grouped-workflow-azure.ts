/**
 * Grouped Mastra Workflow Example (REAL LLM — Azure OpenAI)
 *
 * Identical grouping to grouped-workflow.ts, but swaps the mock model for
 * Azure OpenAI via @ai-sdk/azure so you can see a real LLM span with tokens
 * and cost in the UI.
 *
 * Additional devDependencies NOT already in package.json (add before running):
 *   @ai-sdk/azure  ^3.0.61
 *   ai             ^6.0.175
 *
 *   pnpm add -D @ai-sdk/azure ai
 *
 * Required env:
 *   NEATLOGS_API_KEY, NEATLOGS_ENDPOINT
 *   AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT_NAME
 *   AZURE_OPENAI_API_VERSION (optional, defaults to 2025-01-01-preview)
 *
 * Run:
 *   npx tsx examples/grouped-workflow-azure.ts
 *
 * Verified against staging on 2026-05-05 — produced 9 spans with non-zero
 * cost ($0.00046 on gpt-5-nano) and a proper LLM span under the agent run.
 */

import { init, flush, shutdown } from 'neatlogs';
import { trace, type TracerProvider } from '@opentelemetry/api';
import { createAzure } from '@ai-sdk/azure';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNeatlogsMastraObservability } from '../src/instrumentation.js';

const workflowName = process.env.NEATLOGS_WORKFLOW_NAME ?? 'mastra-grouped-workflow-azure-example';

process.env.NEATLOGS_LOG_RAW_SPANS = process.env.NEATLOGS_LOG_RAW_SPANS ?? 'true';
process.env.NEATLOGS_LOG_SPANS = process.env.NEATLOGS_LOG_SPANS ?? 'true';
process.env.NEATLOGS_LOG_RAW_SPANS_FILE = process.env.NEATLOGS_LOG_RAW_SPANS_FILE ?? 'logs/grouped-workflow-azure-raw.jsonl';
process.env.NEATLOGS_LOG_SPANS_FILE = process.env.NEATLOGS_LOG_SPANS_FILE ?? 'logs/grouped-workflow-azure-processed.jsonl';

for (const logFile of [process.env.NEATLOGS_LOG_RAW_SPANS_FILE, process.env.NEATLOGS_LOG_SPANS_FILE]) {
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    rmSync(logFile, { force: true });
  }
}

function deriveResourceNameFromEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  const match = endpoint.match(/^https?:\/\/([^.]+)\.openai\.azure\.com/i);
  return match?.[1];
}

function buildAzureModel() {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? process.env.AZURE_LLM_DEPLOYMENT ?? 'gpt-5-nano';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2025-01-01-preview';

  if (!apiKey) {
    throw new Error('AZURE_OPENAI_API_KEY is required');
  }

  const resourceName = deriveResourceNameFromEndpoint(endpoint);
  const azure = createAzure({
    apiKey,
    apiVersion,
    useDeploymentBasedUrls: true,
    ...(resourceName ? { resourceName } : { baseURL: endpoint }),
  });

  console.log(`[grouped-azure] Using Azure deployment '${deployment}' (resource='${resourceName ?? '(via baseURL)'}')`);
  return azure.chat(deployment);
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
        `Use agent insight: ${agentText.slice(0, 120)}`,
      ],
    }),
  });

  const strategist = new Agent({
    id: 'growth-strategist',
    name: 'Growth Strategist',
    instructions: 'Create concise risk-aware go-to-market recommendations in 2-3 sentences max.',
    model: buildAzureModel() as any,
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
        `Company: ${inputData.company}. Users: ${inputData.metrics.activeUsers}. Churn risk: ${inputData.metrics.churnRisk}. Return a concise 2-3 sentence plan.`,
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
    tags: ['typescript', 'mastra', 'grouped-example', 'azure-openai', 'real-llm'],
    debug: true,
  });

  const tracerProvider = trace.getTracerProvider();
  console.log(`[grouped-azure] active TracerProvider: ${tracerProvider.constructor?.name ?? 'unknown'}`);

  const { workflow } = await buildMastra(tracerProvider);
  const run = await workflow.createRun({
    runId: `grouped-azure-run-${Date.now()}`,
    resourceId: 'local-demo-account',
  });

  const result = await run.start({
    inputData: {
      accountId: 'acct-demo-001',
      company: 'Atlas Retail AI',
    },
  });

  console.log('[grouped-azure] workflow result', JSON.stringify(result, null, 2));

  await flush();
  await new Promise((r) => setTimeout(r, 3000));
  await shutdown();
}

main().catch((err) => {
  console.error('[grouped-azure] error:', err);
  process.exit(1);
});
