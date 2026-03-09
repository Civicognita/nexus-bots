/**
 * BOTS Runtime Types — provider-agnostic interfaces for the runtime orchestrator.
 *
 * These types decouple the runtime from any specific LLM provider or gateway.
 * The gateway creates adapters that implement RuntimeInvoker.
 */

// ---------------------------------------------------------------------------
// LLM abstraction
// ---------------------------------------------------------------------------

export interface RuntimeInvoker {
  invoke(params: RuntimeInvokeParams): Promise<RuntimeResponse>;
  continueWithToolResults(params: RuntimeContinuation): Promise<RuntimeResponse>;
}

export interface RuntimeInvokeParams {
  system: string;
  messages: RuntimeMessage[];
  tools?: RuntimeToolDef[];
  model?: string;
  maxTokens?: number;
  entityId?: string;
}

export interface RuntimeContinuation {
  original: RuntimeInvokeParams;
  assistantContent: RuntimeContentBlock[];
  toolResults: RuntimeToolResult[];
}

export interface RuntimeToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RuntimeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RuntimeToolResult {
  tool_use_id: string;
  content: string;
}

export interface RuntimeMessage {
  role: "user" | "assistant" | "system";
  content: string | RuntimeContentBlock[];
}

export interface RuntimeContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface RuntimeResponse {
  text: string;
  toolCalls: RuntimeToolCall[];
  contentBlocks: RuntimeContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  stopReason: string | null;
}

// ---------------------------------------------------------------------------
// Tool executor (sandboxed to workspace)
// ---------------------------------------------------------------------------

export interface RuntimeToolExecutor {
  execute(toolName: string, input: Record<string, unknown>): Promise<string>;
  getToolDefinitions(): RuntimeToolDef[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  concurrency: number;
  autoApprove: boolean;
  reportDir: string;
  coaReqId: string;
  maxToolLoops: number;
  modelMap: Record<string, string>;
  projectContext?: { path: string; name: string };
  onProgress?: (event: RuntimeEvent) => void;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface RuntimeResult {
  jobId: string;
  status: "completed" | "failed" | "checkpoint";
  phases: RuntimePhaseResult[];
  burn: BurnReport;
  reportDir: string;
  errors: string[];
}

export interface RuntimePhaseResult {
  phaseId: string;
  workers: WorkerRunResult[];
  gate: string;
}

export interface WorkerRunResult {
  worker: string;
  workerTid: string;
  status: "done" | "blocked" | "failed" | "timeout";
  summary: string;
  burn: WorkerBurn;
  reportFiles: string[];
}

export interface WorkerBurn {
  worker: string;
  workerTid: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolLoops: number;
  durationMs: number;
}

export interface BurnReport {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  workers: WorkerBurn[];
}

// ---------------------------------------------------------------------------
// Events (real-time progress)
// ---------------------------------------------------------------------------

export type RuntimeEvent =
  | { type: "job_started"; jobId: string; description: string; workers: string[] }
  | { type: "phase_started"; jobId: string; phaseId: string; workers: string[] }
  | { type: "worker_started"; jobId: string; workerTid: string; worker: string; model: string }
  | { type: "worker_tool_call"; jobId: string; workerTid: string; toolName: string; loopCount: number }
  | { type: "worker_done"; jobId: string; workerTid: string; worker: string; status: string; summary: string }
  | { type: "phase_done"; jobId: string; phaseId: string; gate: string }
  | { type: "checkpoint"; jobId: string; phaseId: string; gate: string }
  | { type: "report_ready"; jobId: string; coaReqId: string; fileCount: number; gist: string }
  | { type: "job_failed"; jobId: string; error: string };

// ---------------------------------------------------------------------------
// COA filesystem key helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a COA fingerprint for use as a filesystem directory name.
 * $A0.#E0.@A0.C001 → A0-E0-A0-C001
 */
export function sanitizeCoaForFs(fingerprint: string): string {
  return fingerprint.replace(/[$#@]/g, "").replace(/\./g, "-");
}

/**
 * Reconstruct a COA fingerprint from a filesystem-safe directory name.
 * A0-E0-A0-C001 → $A0.#E0.@A0.C001
 */
export function fsToCoaFingerprint(dirName: string): string {
  const parts = dirName.split("-");
  if (parts.length < 4) return dirName;
  return `$${parts[0]}.#${parts[1]}.@${parts[2]}.${parts.slice(3).join("-")}`;
}
