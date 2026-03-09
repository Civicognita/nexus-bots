/**
 * BOTS — Bolt-On Taskmaster System
 *
 * Multi-agent work queue orchestration for Claude Code projects.
 * Install into any project to enable parallel worker execution.
 *
 * @module bots
 */

// Parser - shortcode extraction
import { parseShortcodes as _parseShortcodes } from './parser.js';
import { createJob as _createJob, setNextFrame as _setNextFrame } from './job-manager.js';
export {
  parseShortcodes,
  hasShortcodes,
  extractQueueTexts,
  type ParsedQueue,
  type ParsedNext,
  type ParsedItem,
  type ParseResult
} from './parser.js';

// Router - keyword analysis and entry worker selection
export {
  loadRoutingRules,
  clearRoutingCache,
  findRoute,
  getEntryWorker,
  routeQueues,
  type RoutingRule,
  type RouteMatch
} from './router.js';

// Job Manager - lifecycle and state management
export {
  loadState,
  saveState,
  loadEnforcedChains,
  generateJobId,
  createJob,
  startJob,
  setJobPhases,
  completePhase,
  approveCheckpoint,
  rejectCheckpoint,
  getChainedWorker,
  getActiveJobs,
  getJob,
  setNextFrame,
  popNextFrame,
  type JobStatus,
  type PhaseStatus,
  type GateType,
  type JobPhase,
  type Job,
  type TaskmasterState,
  type ProjectBinding,
  type ExecutionMode,
  type TeamConfig,
  type JobTeamBinding
} from './job-manager.js';

// Worktree - git worktree management
export {
  getRepoRoot,
  ensureWorktreesDir,
  createWorktree,
  removeWorktree,
  getWorktreeInfo,
  listWorktrees,
  mergeWorktree,
  deleteJobBranch,
  cleanupJob,
  type WorktreeInfo,
  type WorktreeCreateResult
} from './worktree.js';

// Executor - phase execution and worker dispatch
export {
  generateWorkerTid,
  createDispatchFile,
  readHandoffFile,
  handoffExists,
  createWorkerDispatch,
  getPhaseWorkers,
  preparePhase,
  checkPhaseStatus,
  getSpawnCommands,
  type WorkerDispatch,
  type PhaseExecutionResult,
  type DispatchMessage
} from './executor.js';

// Gates - phase transition handling
export {
  evaluateGate,
  handleApproval,
  handleCompletion,
  type GateDecision,
  type CheckpointNotification,
  type WorkerSummary,
  type FileChange,
  type TestSummary,
  type CheckpointOption
} from './gates.js';

// Display - CLI output formatting
export {
  progressBar,
  calculateProgress,
  formatJobLine,
  displayJobsStatus,
  displayCheckpoint,
  displayCompletion,
  displayPhaseProgress,
  displayQueuedItems,
  formatDuration
} from './display.js';

// Project Integration - pluggable PM sync
export {
  setIntegration,
  getIntegration,
  isBound,
  bindJob,
  getSyncOperation,
  getPhaseCommentOperation,
  recordSyncEvent,
  getPendingSyncs,
  parseReferences,
  type ProjectIntegration,
  type ProjectBinding as IntegrationBinding,
  type SyncEvent,
  type SyncOperation
} from './project-integration.js';

// Integration implementations
export { TynnIntegration } from './integrations/tynn.js';
export { NexusIntegration } from './integrations/nexus.js';
export {
  detectIntegration,
  autoDetectAndSet,
  getStatePath,
  type DetectedIntegration
} from './integrations/detect.js';

// Orchestrator - autonomous work management
export {
  orchestrate,
  loadPendingWork,
  savePendingWork,
  queueJob,
  clearPendingWork,
  generateTaskCalls,
  formatResult,
  type PendingWork,
  type PendingJob,
  type WorkerSpawnInfo,
  type CheckpointInfo,
  type OrchestratorResult
} from './orchestrator.js';

// Team Executor - agent team task translation
export {
  buildTeamExecutionPlan,
  buildTeammatePrompt,
  generateTaskCreates,
  generateDependencyWiring,
  reconcileTaskCompletion,
  type TeamTask,
  type TeamExecutionPlan
} from './team-executor.js';

// Team Orchestrator - agent team orchestration
export {
  orchestrateTeam,
  generateTeamLeadInstructions,
  formatTeamResult,
  type TeamOrchestratorResult,
  type TeammateSpawnInfo
} from './team-orchestrator.js';

// Upgrade - installation upgrade from source
export {
  upgrade,
  type UpgradeResult
} from './upgrade.js';

// Monitor - background job tracking
export {
  runMonitorCycle,
  getWorkerStatuses,
  isWorkerComplete,
  autoCompleteJobs,
  archiveJobHandoffs,
  formatMonitorResult,
  type MonitorResult,
  type CheckpointReady,
  type WorkerStatus
} from './monitor.js';

// Runtime - provider-agnostic job execution engine
export { runJob } from './runtime.js';
export { compileReport } from './runtime-reports.js';
export { createSandboxedToolExecutor } from './runtime-tools.js';
export {
  sanitizeCoaForFs,
  fsToCoaFingerprint,
  type RuntimeInvoker,
  type RuntimeInvokeParams,
  type RuntimeContinuation,
  type RuntimeToolDef,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type RuntimeMessage,
  type RuntimeContentBlock,
  type RuntimeResponse,
  type RuntimeToolExecutor,
  type RuntimeConfig,
  type RuntimeResult,
  type RuntimePhaseResult,
  type WorkerRunResult,
  type WorkerBurn,
  type BurnReport,
  type RuntimeEvent,
} from './runtime-types.js';

/**
 * Process user input containing BOTS shortcodes
 *
 * Main entry point for BOTS processing.
 * Parses input, creates jobs, and returns what was queued.
 *
 * @example
 * ```ts
 * const result = processInput(`
 *   w:> Add logout button to dashboard
 *   w:> Fix README typo
 *   n:> Review analytics
 * `);
 * // result.jobs = [Job, Job]
 * // result.next = "Review analytics"
 * ```
 */
export function processInput(input: string, configPath?: string): {
  jobs: import('./job-manager.js').Job[];
  next: string | null;
  hasWork: boolean;
} {
  const parsed = _parseShortcodes(input);
  const jobs: import('./job-manager.js').Job[] = [];

  for (const queue of parsed.queues) {
    const job = _createJob(queue.content, configPath);
    jobs.push(job);
  }

  if (parsed.next) {
    _setNextFrame(parsed.next.content, configPath);
  }

  return {
    jobs,
    next: parsed.next?.content || null,
    hasWork: jobs.length > 0 || parsed.next !== null
  };
}
