#!/usr/bin/env node
/**
 * Verify grouped workflow example output.
 *
 * Reads the processed JSONL log and asserts the NeatLogs-converted Mastra trace
 * contains multiple spans under one trace with parent-child relationships,
 * including the workflow root span.
 *
 * The log file is expected to be freshly written by the example run. To guard
 * against stale data, the verifier checks that the file was modified within
 * the last 5 minutes.
 *
 * Usage:
 *   node scripts/verify-grouped-example.mjs
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logPath = resolve(__dirname, '..', 'logs', 'grouped-workflow-processed.jsonl');

if (!existsSync(logPath)) {
  console.error(`Log file not found: ${logPath}`);
  console.error('Run the grouped-workflow example first:');
  console.error('NEATLOGS_DISABLE_EXPORT=true pnpm run example:grouped');
  process.exit(1);
}

// Guard against stale log files from a prior run
const staleLimitMs = 5 * 60 * 1000; // 5 minutes
const mtime = statSync(logPath).mtimeMs;
if (Date.now() - mtime > staleLimitMs) {
  console.error(`Log file is stale (last modified ${new Date(mtime).toISOString()}).`);
  console.error('Re-run the grouped-workflow example first:');
  console.error('NEATLOGS_DISABLE_EXPORT=true pnpm run example:grouped');
  process.exit(1);
}

const content = readFileSync(logPath, 'utf-8').trim();
const lines = content.split('\n').filter(Boolean);

if (lines.length === 0) {
  console.error('Log file is empty');
  process.exit(1);
}

const spans = lines.map((line, i) => {
  try {
    return JSON.parse(line);
  } catch (e) {
    console.error(`Invalid JSON on line ${i + 1}: ${line}`);
    process.exit(1);
  }
});

const traceIdOf = (span) => span.traceId ?? span.trace_id;
const spanIdOf = (span) => span.spanId ?? span.span_id;
const parentSpanIdOf = (span) => span.parentSpanId ?? span.parent_span_id ?? span.parent_id;
const kindOf = (span) => String(
  span.attributes?.['openinference.span.kind'] ??
  span.attributes?.['neatlogs.span.kind'] ??
  span.kind ??
  '',
).toUpperCase();

console.log(`Read ${spans.length} spans from ${logPath}`);

// Include ALL converted spans (including root spans without a parent).
// The hasParent check alone is sufficient for filtering Mastra-converted spans
// since all converted spans have a recognized OI kind.
const mastraConvertedSpans = spans.filter((span) => {
  const kind = kindOf(span);
  return ['WORKFLOW', 'AGENT', 'TOOL', 'LLM', 'CHAIN'].includes(kind);
});

const traces = new Map();
for (const span of mastraConvertedSpans) {
  const traceId = traceIdOf(span);
  if (!traceId) continue;
  if (!traces.has(traceId)) traces.set(traceId, []);
  traces.get(traceId).push(span);
}

let passingTrace = null;
for (const [traceId, traceSpans] of traces) {
  if (traceSpans.length < 2) continue;
  if (/^0+$/.test(traceId)) continue;

  const spanIds = new Set(traceSpans.map(spanIdOf).filter(Boolean));
  if ([...spanIds].some((id) => /^0+$/.test(id))) continue;

  // Require a workflow root span in the trace
  const hasWorkflowRoot = traceSpans.some((span) => kindOf(span) === 'WORKFLOW');
  if (!hasWorkflowRoot) continue;

  const childSpans = traceSpans.filter((span) => {
    const parentId = parentSpanIdOf(span);
    return parentId && spanIds.has(parentId);
  });

  if (childSpans.length > 0) {
    passingTrace = { traceId, traceSpans, childSpans };
    break;
  }
}

if (!passingTrace) {
  console.error('No grouped NeatLogs-converted Mastra trace found.');
  console.error('Expected a trace containing a WORKFLOW root span with parent-child relationships.');
  console.error('Trace summary:');
  for (const [traceId, traceSpans] of traces) {
    console.error(`  ${traceId}: ${traceSpans.length} converted span(s)`);
    for (const span of traceSpans) {
      console.error(`    - ${span.name} span=${spanIdOf(span)} parent=${parentSpanIdOf(span) ?? '(none)'} kind=${kindOf(span)}`);
    }
  }
  process.exit(1);
}

console.log(`All grouped converted spans share trace ID: ${passingTrace.traceId}`);
console.log(`Grouped span count: ${passingTrace.traceSpans.length}`);
console.log('No all-zero trace/span IDs');
console.log(`Found ${passingTrace.childSpans.length} child span(s) with valid parent references:`);
for (const child of passingTrace.childSpans) {
  const parent = passingTrace.traceSpans.find((span) => spanIdOf(span) === parentSpanIdOf(child));
  console.log(`  - "${child.name}" → parent "${parent?.name}"`);
}

// Verify the workflow root span is present
const workflowSpan = passingTrace.traceSpans.find((span) => kindOf(span) === 'WORKFLOW');
console.log(`Workflow root span: "${workflowSpan?.name}"`);

console.log('\nVerification PASSED: grouped workflow produces one trace with parent-child spans.');
