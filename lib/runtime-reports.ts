/**
 * BOTS Runtime Reports — compile job results into filesystem reports.
 *
 * Report structure:
 *   ~/.agi/reports/<coaReqId>/
 *     meta.json    — job metadata
 *     burn.md      — YAML frontmatter + markdown burn table
 *     <workerTid>.md — per-worker summary
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeResult, RuntimeConfig, BurnReport, WorkerBurn } from "./runtime-types.js";
import { sanitizeCoaForFs } from "./runtime-types.js";

// ---------------------------------------------------------------------------
// Cost estimation (rough per-token pricing)
// ---------------------------------------------------------------------------

function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  // Approximate USD per 1M tokens (mid-2025 pricing)
  const pricing: Record<string, { input: number; output: number }> = {
    "claude-opus": { input: 15, output: 75 },
    "claude-sonnet": { input: 3, output: 15 },
    "claude-haiku": { input: 0.25, output: 1.25 },
  };

  // Match model to pricing tier
  let tier = pricing["claude-sonnet"]!;
  if (model.includes("opus")) tier = pricing["claude-opus"]!;
  else if (model.includes("haiku")) tier = pricing["claude-haiku"]!;

  return (inputTokens * tier.input + outputTokens * tier.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Report compilation
// ---------------------------------------------------------------------------

export function compileReport(result: RuntimeResult, config: RuntimeConfig): void {
  const dirName = sanitizeCoaForFs(config.coaReqId);
  const reportDir = join(config.reportDir, dirName);

  mkdirSync(reportDir, { recursive: true });

  // 1. meta.json
  const meta = {
    coaReqId: config.coaReqId,
    jobId: result.jobId,
    status: result.status,
    project: config.projectContext ?? null,
    workers: result.phases.flatMap((p) => p.workers.map((w) => w.worker)),
    createdAt: new Date().toISOString(),
    errors: result.errors,
  };
  writeFileSync(join(reportDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  // 2. Per-worker report files
  for (const phase of result.phases) {
    for (const worker of phase.workers) {
      const filename = `${worker.workerTid}.md`;
      const content = [
        `# ${worker.worker}`,
        "",
        `**Status:** ${worker.status}`,
        `**Duration:** ${formatDuration(worker.burn.durationMs)}`,
        `**Tokens:** ${String(worker.burn.inputTokens)} in / ${String(worker.burn.outputTokens)} out`,
        `**Tool loops:** ${String(worker.burn.toolLoops)}`,
        "",
        "## Summary",
        "",
        worker.summary,
      ].join("\n");

      writeFileSync(join(reportDir, filename), content, "utf-8");
    }
  }

  // 3. burn.md
  writeBurnReport(reportDir, result.burn);
}

function writeBurnReport(reportDir: string, burn: BurnReport): void {
  const costEstimate = burn.workers.reduce(
    (sum, w) => sum + estimateCost(w.inputTokens, w.outputTokens, w.model),
    0,
  );

  const frontmatter = [
    "---",
    `totalInputTokens: ${String(burn.totalInputTokens)}`,
    `totalOutputTokens: ${String(burn.totalOutputTokens)}`,
    `costEstimate: ${costEstimate.toFixed(4)}`,
    `durationMs: ${String(burn.totalDurationMs)}`,
    "---",
  ].join("\n");

  const header = [
    "",
    "# Burn Report",
    "",
    "| Worker | Model | Input | Output | Loops | Duration |",
    "|--------|-------|-------|--------|-------|----------|",
  ];

  const rows = burn.workers.map((w: WorkerBurn) =>
    `| ${w.worker} | ${w.model} | ${formatTokens(w.inputTokens)} | ${formatTokens(w.outputTokens)} | ${String(w.toolLoops)} | ${formatDuration(w.durationMs)} |`,
  );

  const footer = [
    "",
    `**Total:** ${formatTokens(burn.totalInputTokens)} input / ${formatTokens(burn.totalOutputTokens)} output / ${formatDuration(burn.totalDurationMs)} / ~$${costEstimate.toFixed(2)}`,
  ];

  const content = [frontmatter, ...header, ...rows, ...footer].join("\n");
  writeFileSync(join(reportDir, "burn.md"), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}
