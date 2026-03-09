/**
 * BOTS Runtime Orchestrator — provider-agnostic job execution engine.
 *
 * Runs jobs using any RuntimeInvoker (gateway LLMProvider, Claude Code, etc.)
 * with sandboxed tool execution in git worktrees.
 *
 * Lifecycle: loadJob → createWorktree → [phases] → compileReport → cleanup
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getJob, startJob, completePhase, approveCheckpoint, getActiveJobs } from "./job-manager.js";
import { preparePhase, checkPhaseStatus, readHandoffFile, generateWorkerTid } from "./executor.js";
import { evaluateGate } from "./gates.js";
import { createWorktree, cleanupJob as worktreeCleanup } from "./worktree.js";
import { compileReport } from "./runtime-reports.js";
import type {
  RuntimeInvoker,
  RuntimeToolExecutor,
  RuntimeConfig,
  RuntimeResult,
  RuntimePhaseResult,
  WorkerRunResult,
  WorkerBurn,
  BurnReport,
  RuntimeEvent,
  RuntimeContentBlock,
  RuntimeToolResult,
  RuntimeMessage,
} from "./runtime-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(config: RuntimeConfig, event: RuntimeEvent): void {
  if (config.onProgress) {
    try {
      config.onProgress(event);
    } catch {
      // Swallow progress callback errors
    }
  }
}

function limitConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function next(): Promise<void> {
    const i = idx++;
    if (i >= tasks.length) return;
    results[i] = await tasks[i]();
    await next();
  }

  const runners = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  return Promise.all(runners).then(() => results);
}

/**
 * Load worker system prompt from .claude/agents/workers/ or fallback.
 */
function loadWorkerPrompt(workerSpec: string, configPath?: string): string {
  // Worker spec format: "$W.code.engineer" -> domain=code, role=engineer
  const parts = workerSpec.replace("$W.", "").split(".");
  const domain = parts[0] ?? "k";
  const role = parts[1] ?? "analyst";

  // Try loading overlay from .claude/agents/workers/<domain>/<role>.md
  const searchDirs = [
    configPath ? join(configPath, ".claude/agents/workers") : null,
    join(process.cwd(), ".claude/agents/workers"),
  ].filter(Boolean) as string[];

  for (const dir of searchDirs) {
    const overlayPath = join(dir, domain, `${role}.md`);
    if (existsSync(overlayPath)) {
      try {
        return readFileSync(overlayPath, "utf-8");
      } catch {
        // Fall through
      }
    }
  }

  // Fallback: base worker prompt
  const basePath = join(process.cwd(), ".claude/prompts/worker-base.md");
  if (existsSync(basePath)) {
    try {
      return readFileSync(basePath, "utf-8").replace("{{WORKER}}", workerSpec).replace("{{DOMAIN}}", domain).replace("{{ROLE}}", role);
    } catch {
      // Fall through
    }
  }

  return `You are ${workerSpec}, a BOTS worker agent. Domain: ${domain}. Role: ${role}.\n\nComplete the dispatched task. Write results to the handoff file when done.`;
}

// ---------------------------------------------------------------------------
// Worker execution
// ---------------------------------------------------------------------------

async function runWorker(
  dispatch: { worker: string; workerTid: string; dispatchPath: string; model?: string },
  invoker: RuntimeInvoker,
  toolExecutor: RuntimeToolExecutor,
  config: RuntimeConfig,
  jobId: string,
): Promise<WorkerRunResult> {
  const startMs = Date.now();
  const { worker, workerTid } = dispatch;
  const model = dispatch.model ?? config.modelMap["sonnet"] ?? config.modelMap["default"] ?? "claude-sonnet-4-6";

  emit(config, { type: "worker_started", jobId, workerTid, worker, model });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolLoops = 0;
  const toolCallHashes = new Map<string, number>();

  // Load dispatch context
  let dispatchContent = "No dispatch file found.";
  try {
    dispatchContent = readFileSync(dispatch.dispatchPath, "utf-8");
  } catch {
    // Use fallback
  }

  // Build system prompt
  const systemPrompt = loadWorkerPrompt(worker);

  // Initial messages
  const messages: RuntimeMessage[] = [
    { role: "user", content: `## Dispatch\n\n${dispatchContent}` },
  ];

  const tools = toolExecutor.getToolDefinitions();

  try {
    // Initial invocation
    let response = await invoker.invoke({
      system: systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      model,
      maxTokens: 8192,
      entityId: config.coaReqId,
    });

    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    // Tool loop
    while (response.toolCalls.length > 0 && toolLoops < config.maxToolLoops) {
      toolLoops++;

      emit(config, {
        type: "worker_tool_call",
        jobId,
        workerTid,
        toolName: response.toolCalls.map((tc) => tc.name).join(","),
        loopCount: toolLoops,
      });

      // Circuit breaker: detect repeated tool calls
      let shouldBreak = false;
      for (const tc of response.toolCalls) {
        const hash = `${tc.name}:${JSON.stringify(tc.input)}`;
        const count = (toolCallHashes.get(hash) ?? 0) + 1;
        toolCallHashes.set(hash, count);
        if (count > 3) {
          shouldBreak = true;
          break;
        }
      }

      if (shouldBreak) break;

      // Execute tools
      const toolResults: RuntimeToolResult[] = [];
      for (const tc of response.toolCalls) {
        const result = await toolExecutor.execute(tc.name, tc.input);
        toolResults.push({ tool_use_id: tc.id, content: result });
      }

      // Continue with tool results
      response = await invoker.continueWithToolResults({
        original: {
          system: systemPrompt,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          model,
          maxTokens: 8192,
          entityId: config.coaReqId,
        },
        assistantContent: response.contentBlocks as RuntimeContentBlock[],
        toolResults,
      });

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;
    }

    // Read handoff file
    let summary = response.text || "Worker completed without summary.";
    try {
      const handoff = readHandoffFile(workerTid);
      if (handoff?.handoff?.output?.summary) {
        summary = handoff.handoff.output.summary;
      }
    } catch {
      // Use LLM response text as summary
    }

    const burn: WorkerBurn = {
      worker,
      workerTid,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolLoops,
      durationMs: Date.now() - startMs,
    };

    emit(config, { type: "worker_done", jobId, workerTid, worker, status: "done", summary });

    return { worker, workerTid, status: "done", summary, burn, reportFiles: [] };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const burn: WorkerBurn = {
      worker,
      workerTid,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolLoops,
      durationMs: Date.now() - startMs,
    };

    emit(config, { type: "worker_done", jobId, workerTid, worker, status: "failed", summary: errMsg });

    return { worker, workerTid, status: "failed", summary: errMsg, burn, reportFiles: [] };
  }
}

// ---------------------------------------------------------------------------
// Phase execution
// ---------------------------------------------------------------------------

async function runPhase(
  jobId: string,
  phaseId: string,
  invoker: RuntimeInvoker,
  toolExecutorFactory: (worktreePath: string) => RuntimeToolExecutor,
  config: RuntimeConfig,
  worktreePath: string,
): Promise<RuntimePhaseResult> {
  // Prepare dispatches for this phase
  const prepared = preparePhase(jobId);
  const dispatches = prepared.dispatches ?? [];

  emit(config, {
    type: "phase_started",
    jobId,
    phaseId,
    workers: dispatches.map((d: { worker: string }) => d.worker),
  });

  // Create tool executor for the worktree
  const toolExecutor = toolExecutorFactory(worktreePath);

  // Run workers with concurrency limit
  const tasks = dispatches.map((d: { worker: string; workerTid: string; dispatchPath: string; model?: string }) =>
    () => runWorker(d, invoker, toolExecutor, config, jobId)
  );

  const workerResults = await limitConcurrency(tasks, config.concurrency);

  // Check phase status and evaluate gate
  const phaseStatus = checkPhaseStatus(jobId);
  const gate = phaseStatus?.gateTriggered ?? "auto";

  emit(config, { type: "phase_done", jobId, phaseId, gate });

  return {
    phaseId,
    workers: workerResults,
    gate,
  };
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

export async function runJob(
  jobId: string,
  invoker: RuntimeInvoker,
  toolExecutorFactory: (worktreePath: string) => RuntimeToolExecutor,
  config: RuntimeConfig,
): Promise<RuntimeResult> {
  const startMs = Date.now();
  const phases: RuntimePhaseResult[] = [];
  const errors: string[] = [];

  try {
    // Load and start the job
    const job = getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Start the job (creates worktree)
    startJob(jobId);

    const worktreePath = job.worktree || resolve(process.cwd(), ".worktrees", jobId);

    // Ensure worktree exists
    if (!existsSync(worktreePath)) {
      createWorktree(jobId);
    }

    emit(config, {
      type: "job_started",
      jobId,
      description: job.queueText,
      workers: job.phases.flatMap((p) => p.workers),
    });

    // Execute phases sequentially
    for (const phase of job.phases) {
      try {
        const phaseResult = await runPhase(
          jobId,
          phase.id,
          invoker,
          toolExecutorFactory,
          config,
          worktreePath,
        );

        phases.push(phaseResult);

        // Evaluate gate
        const gateResult = evaluateGate(jobId);

        if (gateResult.action === "proceed") {
          // Auto gate — continue to next phase
          approveCheckpoint(jobId);
        } else if (gateResult.action === "wait") {
          if (config.autoApprove) {
            approveCheckpoint(jobId);
          } else {
            emit(config, { type: "checkpoint", jobId, phaseId: phase.id, gate: phase.gate });
            // Build partial result
            const burn = buildBurnReport(phases, startMs);
            return { jobId, status: "checkpoint", phases, burn, reportDir: config.reportDir, errors };
          }
        } else if (gateResult.action === "complete") {
          // Terminal gate
          completePhase(jobId, phase.id);
          break;
        }

        // Mark phase complete
        completePhase(jobId, phase.id);
      } catch (phaseErr) {
        const msg = phaseErr instanceof Error ? phaseErr.message : String(phaseErr);
        errors.push(`Phase ${phase.id}: ${msg}`);
        break;
      }
    }

    // Compile report
    const burn = buildBurnReport(phases, startMs);
    const result: RuntimeResult = {
      jobId,
      status: errors.length > 0 ? "failed" : "completed",
      phases,
      burn,
      reportDir: config.reportDir,
      errors,
    };

    // Write report files
    compileReport(result, config);

    // Extract gist for event
    const gist = phases[0]?.workers[0]?.summary ?? "Job completed";
    const fileCount = phases.reduce((acc, p) => acc + p.workers.reduce((a, w) => a + w.reportFiles.length, 0), 0);

    emit(config, {
      type: "report_ready",
      jobId,
      coaReqId: config.coaReqId,
      fileCount: fileCount || phases.flatMap((p) => p.workers).length,
      gist: gist.slice(0, 200),
    });

    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    errors.push(errMsg);
    emit(config, { type: "job_failed", jobId, error: errMsg });

    const burn = buildBurnReport(phases, startMs);
    return { jobId, status: "failed", phases, burn, reportDir: config.reportDir, errors };
  }
}

function buildBurnReport(phases: RuntimePhaseResult[], startMs: number): BurnReport {
  const workers = phases.flatMap((p) => p.workers.map((w) => w.burn));
  return {
    totalInputTokens: workers.reduce((sum, w) => sum + w.inputTokens, 0),
    totalOutputTokens: workers.reduce((sum, w) => sum + w.outputTokens, 0),
    totalDurationMs: Date.now() - startMs,
    workers,
  };
}
