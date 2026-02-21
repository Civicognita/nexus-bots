/**
 * BOTS Gate Handlers
 *
 * Manages phase transitions based on gate types:
 * - auto: Automatically proceed to next phase
 * - checkpoint: Pause for user review
 * - terminal: Final phase, complete job
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Job,
  JobPhase,
  GateType,
  getJob,
  approveCheckpoint,
  rejectCheckpoint,
  loadState,
  saveState
} from './job-manager.js';
import { PhaseExecutionResult, WorkerDispatch, readHandoffFile } from './executor.js';
import { cleanupJob, mergeWorktree } from './worktree.js';

// ============================================================================
// Types
// ============================================================================

export interface GateDecision {
  action: 'proceed' | 'wait' | 'complete' | 'fail';
  reason: string;
  requiresApproval: boolean;
  notification?: CheckpointNotification;
}

export interface CheckpointNotification {
  jobId: string;
  phaseId: string;
  phaseName: string;
  gateType: GateType;
  summary: string;
  workers: WorkerSummary[];
  filesChanged: FileChange[];
  testsRun?: TestSummary;
  options: CheckpointOption[];
}

export interface WorkerSummary {
  worker: string;
  status: 'complete' | 'failed';
  summary: string;
  duration?: number;
}

export interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  description?: string;
}

export interface TestSummary {
  passed: number;
  failed: number;
  total: number;
  output?: string;
}

export interface CheckpointOption {
  key: string;
  label: string;
  description: string;
  action: 'approve' | 'reject' | 'diff' | 'retry';
}

// ============================================================================
// Gate Logic
// ============================================================================

/**
 * Evaluate gate and determine next action
 */
export function evaluateGate(
  phaseResult: PhaseExecutionResult,
  configPath?: string
): GateDecision {
  const { gateTriggered, status, jobId, phaseId } = phaseResult;

  // Check for failures
  if (status === 'failed') {
    return {
      action: 'fail',
      reason: 'One or more workers failed',
      requiresApproval: true,
      notification: buildFailureNotification(phaseResult, configPath)
    };
  }

  // Still running
  if (!gateTriggered) {
    return {
      action: 'wait',
      reason: 'Workers still executing',
      requiresApproval: false
    };
  }

  // Gate type determines behavior
  switch (gateTriggered) {
    case 'auto':
      return {
        action: 'proceed',
        reason: 'Auto gate - proceeding to next phase',
        requiresApproval: false
      };

    case 'checkpoint':
      return {
        action: 'wait',
        reason: 'Checkpoint gate - awaiting user review',
        requiresApproval: true,
        notification: buildCheckpointNotification(phaseResult, configPath)
      };

    case 'terminal':
      return {
        action: 'complete',
        reason: 'Terminal gate - job complete',
        requiresApproval: true,
        notification: buildTerminalNotification(phaseResult, configPath)
      };

    default:
      return {
        action: 'wait',
        reason: `Unknown gate type: ${gateTriggered}`,
        requiresApproval: true
      };
  }
}

/**
 * Handle gate approval
 */
export function handleApproval(
  jobId: string,
  action: 'approve' | 'reject',
  reason?: string,
  configPath?: string
): { success: boolean; job: Job | null; error?: string } {
  try {
    if (action === 'approve') {
      const job = approveCheckpoint(jobId, configPath);
      return { success: true, job };
    } else {
      const job = rejectCheckpoint(jobId, reason || 'Rejected by user', configPath);
      return { success: true, job };
    }
  } catch (error) {
    return {
      success: false,
      job: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Handle job completion (terminal gate)
 */
export function handleCompletion(
  jobId: string,
  merge: boolean = true,
  configPath?: string
): { success: boolean; steps: string[]; error?: string } {
  const job = getJob(jobId, configPath);
  if (!job) {
    return { success: false, steps: [], error: `Job ${jobId} not found` };
  }

  const steps: string[] = [];

  try {
    if (merge) {
      // Merge worktree to main
      const mergeResult = mergeWorktree(jobId);
      if (mergeResult.success) {
        steps.push(`Merged ${job.branch} to main`);
      } else {
        return { success: false, steps, error: `Merge failed: ${mergeResult.error}` };
      }

      // Cleanup worktree
      const cleanupResult = cleanupJob(jobId);
      steps.push(...cleanupResult.steps);
    } else {
      steps.push('Skipped merge (branch preserved)');
    }

    // Mark job complete
    const state = loadState(configPath);
    if (state.wip.jobs[jobId]) {
      state.wip.jobs[jobId].status = 'complete';
      state.wip.jobs[jobId].completedAt = new Date().toISOString();
      saveState(state, configPath);
      steps.push('Job marked complete');
    }

    return { success: true, steps };
  } catch (error) {
    return {
      success: false,
      steps,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// ============================================================================
// Notification Builders
// ============================================================================

function buildCheckpointNotification(
  result: PhaseExecutionResult,
  configPath?: string
): CheckpointNotification {
  const job = getJob(result.jobId, configPath);
  const phase = job?.phases.find(p => p.id === result.phaseId);

  const workers = result.workers.map(w => extractWorkerSummary(w));
  const filesChanged = extractFilesChanged(result.workers);
  const testsRun = extractTestSummary(result.workers);

  return {
    jobId: result.jobId,
    phaseId: result.phaseId,
    phaseName: phase?.name || result.phaseId,
    gateType: 'checkpoint',
    summary: `Phase ${phase?.name || result.phaseId} complete`,
    workers,
    filesChanged,
    testsRun,
    options: [
      { key: 'a', label: 'Approve & Continue', description: 'Proceed to next phase', action: 'approve' },
      { key: 'd', label: 'Review Diff', description: 'Show detailed changes', action: 'diff' },
      { key: 'r', label: 'Reject', description: 'Stop job, keep branch for manual fixes', action: 'reject' }
    ]
  };
}

function buildTerminalNotification(
  result: PhaseExecutionResult,
  configPath?: string
): CheckpointNotification {
  const job = getJob(result.jobId, configPath);

  const workers = result.workers.map(w => extractWorkerSummary(w));
  const filesChanged = extractFilesChanged(result.workers);

  return {
    jobId: result.jobId,
    phaseId: result.phaseId,
    phaseName: 'Complete',
    gateType: 'terminal',
    summary: `Job ${result.jobId} complete: ${job?.queueText || 'Unknown'}`,
    workers,
    filesChanged,
    options: [
      { key: 'a', label: 'Approve & Merge', description: 'Merge to main, cleanup worktree', action: 'approve' },
      { key: 'd', label: 'Review Diff', description: 'Show all changes before merge', action: 'diff' },
      { key: 'r', label: 'Reject', description: 'Keep branch, do not merge', action: 'reject' }
    ]
  };
}

function buildFailureNotification(
  result: PhaseExecutionResult,
  configPath?: string
): CheckpointNotification {
  const job = getJob(result.jobId, configPath);
  const phase = job?.phases.find(p => p.id === result.phaseId);

  const workers = result.workers.map(w => extractWorkerSummary(w));

  return {
    jobId: result.jobId,
    phaseId: result.phaseId,
    phaseName: phase?.name || result.phaseId,
    gateType: 'checkpoint',
    summary: `Phase ${phase?.name || result.phaseId} FAILED`,
    workers,
    filesChanged: [],
    options: [
      { key: 'r', label: 'Retry Phase', description: 'Re-run failed workers', action: 'retry' },
      { key: 'd', label: 'View Details', description: 'Show failure details', action: 'diff' },
      { key: 'x', label: 'Abort Job', description: 'Mark job as failed', action: 'reject' }
    ]
  };
}

// ============================================================================
// Data Extraction Helpers
// ============================================================================

function extractWorkerSummary(dispatch: WorkerDispatch): WorkerSummary {
  let summary = 'No handoff received';
  let duration: number | undefined;

  if (dispatch.handoffPath) {
    const handoff = readHandoffFile(dispatch.handoffPath);
    if (handoff?.handoff) {
      summary = handoff.handoff.output?.summary || 'Completed';
      if (handoff.handoff.metrics?.duration_ms) {
        duration = handoff.handoff.metrics.duration_ms;
      }
    }
  }

  return {
    worker: dispatch.worker,
    status: dispatch.status === 'failed' ? 'failed' : 'complete',
    summary,
    duration
  };
}

function extractFilesChanged(dispatches: WorkerDispatch[]): FileChange[] {
  const files: FileChange[] = [];
  const seen = new Set<string>();

  for (const dispatch of dispatches) {
    if (!dispatch.handoffPath) continue;

    const handoff = readHandoffFile(dispatch.handoffPath);
    if (!handoff?.handoff?.output) continue;

    const output = handoff.handoff.output;

    if (output.files_created) {
      for (const file of output.files_created) {
        if (!seen.has(file.path)) {
          seen.add(file.path);
          files.push({ path: file.path, action: 'created', description: file.description });
        }
      }
    }

    if (output.files_modified) {
      for (const file of output.files_modified) {
        if (!seen.has(file.path)) {
          seen.add(file.path);
          files.push({ path: file.path, action: 'modified', description: file.changes_summary || file.changes });
        }
      }
    }
  }

  return files;
}

function extractTestSummary(dispatches: WorkerDispatch[]): TestSummary | undefined {
  for (const dispatch of dispatches) {
    if (!dispatch.worker.includes('tester')) continue;
    if (!dispatch.handoffPath) continue;

    const handoff = readHandoffFile(dispatch.handoffPath);
    if (!handoff?.handoff?.output?.test_run) continue;

    const testRun = handoff.handoff.output.test_run;
    return {
      passed: testRun.passed_count || 0,
      failed: testRun.failed_count || 0,
      total: testRun.total || 0,
      output: testRun.output
    };
  }

  return undefined;
}

// CLI support
if (typeof require !== 'undefined' && require.main === module) {
  const action = process.argv[2];
  const jobId = process.argv[3];
  const decision = process.argv[4];

  switch (action) {
    case 'approve':
      console.log(JSON.stringify(handleApproval(jobId, 'approve'), null, 2));
      break;
    case 'reject':
      console.log(JSON.stringify(handleApproval(jobId, 'reject', decision), null, 2));
      break;
    case 'complete':
      console.log(JSON.stringify(handleCompletion(jobId), null, 2));
      break;
    default:
      console.log('Usage: gates.ts <approve|reject|complete> <jobId> [reason]');
  }
}
