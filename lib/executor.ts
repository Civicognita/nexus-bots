/**
 * BOTS Phase Executor
 *
 * Executes phases within a WORK{JOB}, managing worker dispatch,
 * parallel execution, enforced chains, and gate transitions.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Job,
  JobPhase,
  getJob,
  completePhase,
  getChainedWorker,
  loadState,
  saveState
} from './job-manager.js';
import { createWorktree, getWorktreeInfo, WorktreeCreateResult } from './worktree.js';
import {
  isBound,
  getSyncOperation,
  getPhaseCommentOperation,
  recordSyncEvent
} from './project-integration.js';

// ============================================================================
// Types
// ============================================================================

export interface WorkerDispatch {
  jobId: string;
  phaseId: string;
  worker: string;
  workerTid: string;
  worktreePath: string;
  dispatchPath: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  handoffPath?: string;
}

export interface PhaseExecutionResult {
  jobId: string;
  phaseId: string;
  status: 'complete' | 'failed' | 'checkpoint';
  workers: WorkerDispatch[];
  gateTriggered: 'auto' | 'checkpoint' | 'terminal' | null;
  nextPhase: JobPhase | null;
  error?: string;
  projectSync?: {
    statusOp?: { tool: string; params: Record<string, any> };
    commentOp?: { tool: string; params: Record<string, any> };
  };
}

export interface DispatchMessage {
  dispatch: {
    job_id: string;
    phase_id: string;
    worker: string;
    worker_tid: string;
    worktree: {
      path: string;
      branch: string;
      base: string;
    };
    task: {
      description: string;
      scope?: string[];
      requirements?: string[];
    };
    context: {
      parent_tid: string;
      parent_coa: string;
      phase: string;
      preceding_handoff?: any;
    };
  };
}

// ============================================================================
// Dispatch File Management
// ============================================================================

const HANDOFF_DIR = '.ai/handoff';

/**
 * Ensure handoff directory exists
 */
function ensureHandoffDir(basePath: string): string {
  const handoffDir = path.join(basePath, HANDOFF_DIR);
  if (!fs.existsSync(handoffDir)) {
    fs.mkdirSync(handoffDir, { recursive: true });
  }
  return handoffDir;
}

/**
 * Generate worker TID
 */
export function generateWorkerTid(worker: string, jobId: string): string {
  const timestamp = Date.now();
  const workerName = worker.replace(/\$W\./g, '').replace(/\./g, '-');
  return `${workerName}-${jobId}-${timestamp}`;
}

/**
 * Create dispatch file for a worker
 */
export function createDispatchFile(
  dispatch: DispatchMessage,
  basePath: string
): string {
  const handoffDir = ensureHandoffDir(basePath);
  const dispatchPath = path.join(handoffDir, `dispatch-${dispatch.dispatch.worker_tid}.json`);
  fs.writeFileSync(dispatchPath, JSON.stringify(dispatch, null, 2), 'utf-8');
  return dispatchPath;
}

/**
 * Read handoff file from worker
 */
export function readHandoffFile(handoffPath: string): any | null {
  try {
    if (fs.existsSync(handoffPath)) {
      const content = fs.readFileSync(handoffPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`Error reading handoff ${handoffPath}:`, error);
  }
  return null;
}

/**
 * Check if handoff file exists (worker completed)
 */
export function handoffExists(workerTid: string, basePath: string): boolean {
  const handoffPath = path.join(basePath, HANDOFF_DIR, `${workerTid}.json`);
  return fs.existsSync(handoffPath);
}

// ============================================================================
// Worker Dispatch
// ============================================================================

/**
 * Create dispatch for a single worker
 */
export function createWorkerDispatch(
  job: Job,
  phase: JobPhase,
  worker: string,
  parentTid: string,
  parentCoa: string,
  precedingHandoff?: any
): WorkerDispatch {
  const workerTid = generateWorkerTid(worker, job.id);
  const basePath = process.cwd();

  const dispatchMessage: DispatchMessage = {
    dispatch: {
      job_id: job.id,
      phase_id: phase.id,
      worker: worker,
      worker_tid: workerTid,
      worktree: {
        path: job.worktree,
        branch: job.branch,
        base: 'main'
      },
      task: {
        description: job.queueText,
        scope: (phase as any).scope,
        requirements: (phase as any).requirements
      },
      context: {
        parent_tid: parentTid,
        parent_coa: parentCoa,
        phase: phase.id,
        preceding_handoff: precedingHandoff
      }
    }
  };

  const dispatchPath = createDispatchFile(dispatchMessage, basePath);

  return {
    jobId: job.id,
    phaseId: phase.id,
    worker,
    workerTid,
    worktreePath: job.worktree,
    dispatchPath,
    status: 'pending'
  };
}

/**
 * Get all workers needed for a phase (including enforced chains)
 */
export function getPhaseWorkers(
  phase: JobPhase,
  configPath?: string
): string[] {
  const workers: string[] = [...phase.workers];
  const seen = new Set<string>(workers);

  // Add enforced chain targets
  for (const worker of phase.workers) {
    const chainTarget = getChainedWorker(worker, configPath);
    if (chainTarget && !seen.has(chainTarget)) {
      // Enforced chains are added inline (same phase, sequential)
      // They'll be handled specially in execution
    }
  }

  return workers;
}

// ============================================================================
// Phase Execution
// ============================================================================

/**
 * Execution state for tracking dispatched workers
 */
interface ExecutionState {
  jobId: string;
  phaseId: string;
  dispatches: WorkerDispatch[];
  pendingChains: Array<{ from: string; to: string; handoff: any }>;
}

/**
 * Load or create execution state
 */
function loadExecutionState(jobId: string, basePath: string): ExecutionState | null {
  const statePath = path.join(basePath, HANDOFF_DIR, `execution-${jobId}.json`);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch {}
  return null;
}

/**
 * Save execution state
 */
function saveExecutionState(state: ExecutionState, basePath: string): void {
  const statePath = path.join(basePath, HANDOFF_DIR, `execution-${state.jobId}.json`);
  ensureHandoffDir(basePath);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Prepare a phase for execution
 *
 * Creates worktree (if needed) and dispatch files for all workers.
 * Returns dispatches ready to be executed.
 */
export function preparePhase(
  jobId: string,
  parentTid: string,
  parentCoa: string,
  configPath?: string
): { dispatches: WorkerDispatch[]; worktree: WorktreeCreateResult } {
  const job = getJob(jobId, configPath);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  const phase = job.phases.find(p => p.id === job.currentPhase);
  if (!phase) {
    throw new Error(`Current phase ${job.currentPhase} not found in job ${jobId}`);
  }

  // Create worktree if needed
  const worktreeResult = createWorktree(job.id);
  if (!worktreeResult.success && !worktreeResult.error?.includes('already exists')) {
    throw new Error(`Failed to create worktree: ${worktreeResult.error}`);
  }

  // Create dispatches for each worker
  const dispatches: WorkerDispatch[] = [];
  for (const worker of phase.workers) {
    const dispatch = createWorkerDispatch(job, phase, worker, parentTid, parentCoa);
    dispatches.push(dispatch);
  }

  // Save execution state
  const state: ExecutionState = {
    jobId,
    phaseId: phase.id,
    dispatches,
    pendingChains: []
  };
  saveExecutionState(state, process.cwd());

  return { dispatches, worktree: worktreeResult };
}

/**
 * Check phase completion status
 *
 * Looks for handoff files from all dispatched workers.
 * Handles enforced chains by dispatching chain targets.
 */
export function checkPhaseStatus(
  jobId: string,
  parentTid: string,
  parentCoa: string,
  configPath?: string
): PhaseExecutionResult {
  const basePath = process.cwd();
  const state = loadExecutionState(jobId, basePath);

  if (!state) {
    throw new Error(`No execution state found for job ${jobId}`);
  }

  const job = getJob(jobId, configPath);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  const phase = job.phases.find(p => p.id === state.phaseId);
  if (!phase) {
    throw new Error(`Phase ${state.phaseId} not found`);
  }

  // Check each dispatch for completion
  let allComplete = true;
  let anyFailed = false;

  for (const dispatch of state.dispatches) {
    if (dispatch.status === 'complete' || dispatch.status === 'failed') {
      continue;
    }

    const handoffPath = path.join(basePath, HANDOFF_DIR, `${dispatch.workerTid}.json`);
    if (fs.existsSync(handoffPath)) {
      const handoff = readHandoffFile(handoffPath);
      dispatch.status = handoff?.handoff?.status === 'failed' ? 'failed' : 'complete';
      dispatch.completedAt = new Date().toISOString();
      dispatch.handoffPath = handoffPath;

      if (dispatch.status === 'failed') {
        anyFailed = true;
      }

      // Check for enforced chain
      const chainTarget = getChainedWorker(dispatch.worker, configPath);
      if (chainTarget && dispatch.status === 'complete') {
        state.pendingChains.push({
          from: dispatch.worker,
          to: chainTarget,
          handoff: handoff
        });
      }
    } else {
      allComplete = false;
    }
  }

  // Process pending chains
  for (const chain of state.pendingChains) {
    // Check if chain target already dispatched
    const alreadyDispatched = state.dispatches.some(
      d => d.worker === chain.to && d.status !== 'failed'
    );

    if (!alreadyDispatched) {
      // Dispatch chain target
      const chainDispatch = createWorkerDispatch(
        job,
        phase,
        chain.to,
        parentTid,
        parentCoa,
        chain.handoff
      );
      state.dispatches.push(chainDispatch);
      allComplete = false;
    }
  }
  state.pendingChains = [];

  // Save updated state
  saveExecutionState(state, basePath);

  // Determine result
  if (!allComplete) {
    return {
      jobId,
      phaseId: phase.id,
      status: 'checkpoint', // Still running
      workers: state.dispatches,
      gateTriggered: null,
      nextPhase: null
    };
  }

  if (anyFailed) {
    return {
      jobId,
      phaseId: phase.id,
      status: 'failed',
      workers: state.dispatches,
      gateTriggered: null,
      nextPhase: null,
      error: 'One or more workers failed'
    };
  }

  // Phase complete - trigger gate
  const completionResult = completePhase(
    jobId,
    phase.id,
    state.dispatches[0]?.workerTid || 'unknown',
    configPath
  );

  // Build project sync operations if job is bound
  let projectSync: PhaseExecutionResult['projectSync'];
  if (isBound(jobId, configPath)) {
    const statusOp = getSyncOperation(jobId, configPath);
    const workerNames = state.dispatches.map(d => d.worker);
    const commentOp = getPhaseCommentOperation(
      jobId,
      phase.id,
      phase.name,
      workerNames,
      configPath
    );
    if (statusOp || commentOp) {
      projectSync = {
        statusOp: statusOp || undefined,
        commentOp: commentOp || undefined
      };
    }
  }

  return {
    jobId,
    phaseId: phase.id,
    status: completionResult.gateTriggered === 'checkpoint' ? 'checkpoint' : 'complete',
    workers: state.dispatches,
    gateTriggered: completionResult.gateTriggered,
    nextPhase: completionResult.nextPhase,
    projectSync
  };
}

/**
 * Get dispatch commands for spawning workers
 *
 * Returns shell commands or Task tool invocations for each worker.
 */
export function getSpawnCommands(dispatches: WorkerDispatch[]): string[] {
  return dispatches.map(d => {
    return `Task: ${d.worker} | Dispatch: ${d.dispatchPath} | Worktree: ${d.worktreePath}`;
  });
}

// ============================================================================
// Exports for CLI usage
// ============================================================================

export {
  ExecutionState,
  loadExecutionState,
  saveExecutionState
};

// CLI support
if (typeof require !== 'undefined' && require.main === module) {
  const action = process.argv[2];
  const jobId = process.argv[3];

  switch (action) {
    case 'prepare':
      const result = preparePhase(jobId, 'CLI', 'CLI.COA');
      console.log(JSON.stringify(result, null, 2));
      break;
    case 'check':
      const status = checkPhaseStatus(jobId, 'CLI', 'CLI.COA');
      console.log(JSON.stringify(status, null, 2));
      break;
    default:
      console.log('Usage: executor.ts <prepare|check> <jobId>');
  }
}
