---
name: neatlogs-sdk-testing
description: Test Neatlogs standalone Python and JavaScript instrumentation packages for compatibility, telemetry correctness, packaging, patch lifecycle, and SDK isolation without editing package source during execution.
---

# Neatlogs instrumentation testing

Use this skill for Azure AI Inference, Google GenAI, AI SDK, Mastra, and future standalone instrumentation validation.

## Boundaries and contract

- Test from clean temporary consumers and record the repository branch/commit plus instrumentation and target-library versions.
- Do not modify package code or lockfiles during an execution pass.
- Never push or publish without separate authorization.
- Use fake transports for exhaustive errors and bounded live calls only for representative E2E.
- Require exact span kind/name/count, hierarchy, input/output, model/provider, usage, duration, status/error, export, and exact persistence where live ingestion is in scope.

## Required matrix

- Clean wheel/sdist/npm tarball installation.
- Minimum, representative, latest, and prerelease/nightly target-library versions when safe.
- Target module absent, imported before instrumentation, and imported after instrumentation.
- Patch, repeated patch, unpatch, repeated unpatch, and re-patch.
- Private-provider versus global-provider isolation according to the package contract.
- Non-streaming, full streaming, empty stream, early return, never consumed, and mid-stream failure.
- Tool calls, malformed values, zero/partial usage, provider errors, and target-library retries.
- Concurrent calls, independent roots, active shutdown, exporter failure, and secret/masking checks.
- CJS/ESM for JavaScript and supported Python versions for Python packages.

## Package priorities

- Give Azure AI Inference Python instrumentation a complete first-party suite because it currently lacks dedicated coverage.
- Validate Google GenAI span closure and aggregation across all stream termination modes.
- Decide and test whether AI SDK instrumentation may use the global tracer provider or must follow the private-provider isolation policy.
- Verify Mastra workflow/agent/tool hierarchy and version compatibility independently of repository hoisting.

## Reporting

Report each package/version pair, expected contract, application result, telemetry result, patch lifecycle, exporter/persistence result, compatibility classification, and actionable defect. Separate package installation failures from instrumentation semantic failures.
