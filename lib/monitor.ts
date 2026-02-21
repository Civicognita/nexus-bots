/**
 * BOTS Monitor
 *
 * Background monitoring for:
 * - Worker handoff completion
 * - Phase advancement through gates
 * - Job cleanup and archival
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Job,
  getJob,
  getActiveJobs,
  loadState,
  saveState,
  approveCheckpoint
} from './job-manager.js';
import { checkPhaseStatus, readHandoffFile } from './executor.js';
import { evaluateGate, handleCompletion } from './gates.js';
import { cleanupJob, mergeWorktree } from './worktree.js';
import { displayJobsStatus, displayCheckpoint, formatDuration } from './display.js';

// ============================================================================
// Types
// ============================================================================

export interface MonitorResult {
  timestamp: string;
  activeJobs: number;
  workersRunning: number;
  workersComplete: number;
  checkpointsReady: CheckpointReady[];
  jobsCompleted: string[];
  autoAdvanced: string[];
  errors: string[];
}

export interface CheckpointReady {
  jobId: string;
  phaseId: string;
  gate: string;
  workersSummary: string;
}

export interface WorkerStatus {
  workerTid: string;
  worker: string;
  jobId: string;
  status: 'running' | 'complete' | 'failed';
  checkpointPercent?: number;
  lastAction?: string;
}

// ============================================================================
// Paths
// ============================================================================

const HANDOFF_DIR = path.join(process.cwd(), '.ai', 'handoff');
const CHECKPOINT_DIR = path.join(process.cwd(), '.ai', 'checkpoints');
const ARCHIVE_DIR = path.join(process.cwd(), '.ai', 'handoff', 'archive');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Worker Status Tracking
// ============================================================================

/**
 * Get status of all workers from checkpoint files
 */
export function getWorkerStatuses(): WorkerStatus[] {
  const statuses: WorkerStatus[] = [];

  if (!fs.existsSync(CHECKPOINT_DIR)) {
    return statuses;
  }

  const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(CHECKPOINT_DIR, file), 'utf-8');
      const data = JSON.parse(content);

      if (data.checkpoint) {
        statuses.push({
          workerTid: data.checkpoint.worker_tid,
          worker: data.checkpoint.worker_type,
          jobId: data.checkpoint.job_id || 'unknown',
          status: data.checkpoint.status === 'complete' ? 'complete' :
                  data.checkpoint.status === 'failed' ? 'failed' : 'running',
          checkpointPercent: data.checkpoint.progress?.percent,
          lastAction: data.checkpoint.progress?.current_action
        });
      }
    } catch {}
  }

  return statuses;
}

/**
 * Check if a worker has completed (handoff file exists)
 */
export function isWorkerComplete(workerTid: string): boolean {
  const handoffPath = path.join(HANDOFF_DIR, `${workerTid}.json`);
  return fs.existsSync(handoffPath);
}

// ============================================================================
// Monitoring
// ============================================================================

/**
 * Run a single monitoring cycle
 */
export function runMonitorCycle(
  autoApproveAuto: boolean = true
): MonitorResult {
  const result: MonitorResult = {
    timestamp: new Date().toISOString(),
    activeJobs: 0,
    workersRunning: 0,
    workersComplete: 0,
    checkpointsReady: [],
    jobsCompleted: [],
    autoAdvanced: [],
    errors: []
  };

  const jobs = getActiveJobs();
  result.activeJobs = jobs.length;

  for (const job of jobs) {
    try {
      if (job.status === 'running') {
        const phaseResult = checkPhaseStatus(job.id, 'MONITOR', 'MONITOR.COA');

        result.workersComplete += phaseResult.workers.filter(w => w.status === 'complete').length;
        result.workersRunning += phaseResult.workers.filter(w => w.status === 'running' || w.status === 'pending').length;

        if (phaseResult.gateTriggered) {
          const gateDecision = evaluateGate(phaseResult);

          if (gateDecision.action === 'proceed' && autoApproveAuto) {
            approveCheckpoint(job.id);
            result.autoAdvanced.push(job.id);
          } else if (gateDecision.action === 'wait') {
            result.checkpointsReady.push({
              jobId: job.id,
              phaseId: phaseResult.phaseId,
              gate: phaseResult.gateTriggered,
              workersSummary: `${phaseResult.workers.length} workers complete`
            });
          } else if (gateDecision.action === 'complete') {
            result.jobsCompleted.push(job.id);
          }
        }
      } else if (job.status === 'checkpoint') {
        const phase = job.phases.find(p => p.id === job.currentPhase);
        if (phase) {
          result.checkpointsReady.push({
            jobId: job.id,
            phaseId: phase.id,
            gate: phase.gate,
            workersSummary: `${phase.workers.length} workers`
          });
        }
      }
    } catch (error) {
      result.errors.push(`Job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

/**
 * Auto-complete jobs that are at terminal gate
 */
export function autoCompleteJobs(
  jobIds: string[],
  merge: boolean = true
): { completed: string[]; errors: string[] } {
  const completed: string[] = [];
  const errors: string[] = [];

  for (const jobId of jobIds) {
    try {
      const result = handleCompletion(jobId, merge);
      if (result.success) {
        completed.push(jobId);
      } else {
        errors.push(`${jobId}: ${result.error}`);
      }
    } catch (error) {
      errors.push(`${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { completed, errors };
}

/**
 * Archive completed job handoffs
 */
export function archiveJobHandoffs(jobId: string): { archived: string[]; errors: string[] } {
  const archived: string[] = [];
  const errors: string[] = [];

  ensureDir(ARCHIVE_DIR);

  if (!fs.existsSync(HANDOFF_DIR)) {
    return { archived, errors };
  }

  const files = fs.readdirSync(HANDOFF_DIR).filter(f =>
    f.includes(jobId) && f.endsWith('.json')
  );

  for (const file of files) {
    try {
      const src = path.join(HANDOFF_DIR, file);
      const dest = path.join(ARCHIVE_DIR, file);
      fs.renameSync(src, dest);
      archived.push(file);
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (fs.existsSync(CHECKPOINT_DIR)) {
    const checkpointFiles = fs.readdirSync(CHECKPOINT_DIR).filter(f =>
      f.includes(jobId) && f.endsWith('.json')
    );

    for (const file of checkpointFiles) {
      try {
        const src = path.join(CHECKPOINT_DIR, file);
        const dest = path.join(ARCHIVE_DIR, `checkpoint-${file}`);
        fs.renameSync(src, dest);
        archived.push(`checkpoint-${file}`);
      } catch (error) {
        errors.push(`checkpoint-${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { archived, errors };
}

// ============================================================================
// Display
// ============================================================================

export function formatMonitorResult(result: MonitorResult): string {
  const lines: string[] = [];

  lines.push('┌─────────────────────────────────────────────────────────────┐');
  lines.push('│  BOTS MONITOR                                               │');
  lines.push('├─────────────────────────────────────────────────────────────┤');
  lines.push(`│  Active Jobs: ${result.activeJobs}  │  Workers: ${result.workersRunning} running, ${result.workersComplete} done`.padEnd(62) + '│');

  if (result.autoAdvanced.length > 0) {
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│  Auto-advanced (auto gates):'.padEnd(62) + '│');
    for (const id of result.autoAdvanced) {
      lines.push(`│    → ${id}`.padEnd(62) + '│');
    }
  }

  if (result.checkpointsReady.length > 0) {
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│  Checkpoints ready for review:'.padEnd(62) + '│');
    for (const cp of result.checkpointsReady) {
      lines.push(`│    ◆ ${cp.jobId} (${cp.gate}): ${cp.workersSummary}`.padEnd(62) + '│');
    }
  }

  if (result.jobsCompleted.length > 0) {
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│  Jobs ready for completion:'.padEnd(62) + '│');
    for (const id of result.jobsCompleted) {
      lines.push(`│    ✓ ${id}`.padEnd(62) + '│');
    }
  }

  if (result.errors.length > 0) {
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│  Errors:'.padEnd(62) + '│');
    for (const e of result.errors) {
      lines.push(`│    ✗ ${e.substring(0, 56)}`.padEnd(62) + '│');
    }
  }

  lines.push('└─────────────────────────────────────────────────────────────┘');

  return lines.join('\n');
}

// ============================================================================
// CLI
// ============================================================================

if (typeof require !== 'undefined' && require.main === module) {
  const action = process.argv[2] || 'check';

  switch (action) {
    case 'check':
      const result = runMonitorCycle();
      console.log(formatMonitorResult(result));
      break;

    case 'json':
      const jsonResult = runMonitorCycle();
      console.log(JSON.stringify(jsonResult, null, 2));
      break;

    case 'workers':
      const statuses = getWorkerStatuses();
      console.log(JSON.stringify(statuses, null, 2));
      break;

    case 'complete':
      const jobId = process.argv[3];
      if (jobId) {
        const completeResult = autoCompleteJobs([jobId]);
        console.log(JSON.stringify(completeResult, null, 2));
      } else {
        console.log('Usage: monitor.ts complete <jobId>');
      }
      break;

    case 'archive':
      const archiveJobId = process.argv[3];
      if (archiveJobId) {
        const archiveResult = archiveJobHandoffs(archiveJobId);
        console.log(JSON.stringify(archiveResult, null, 2));
      } else {
        console.log('Usage: monitor.ts archive <jobId>');
      }
      break;

    case 'watch':
      console.log('Starting continuous monitor (Ctrl+C to stop)...\n');
      const interval = parseInt(process.argv[3] || '5000', 10);
      setInterval(() => {
        console.clear();
        const watchResult = runMonitorCycle();
        console.log(formatMonitorResult(watchResult));
        console.log(`\nNext check in ${interval / 1000}s...`);
      }, interval);
      break;

    default:
      console.log(`
BOTS Monitor

Commands:
  check              Run single monitor cycle (default)
  json               Output monitor result as JSON
  workers            Show worker checkpoint statuses
  complete <jobId>   Complete a job (merge + cleanup)
  archive <jobId>    Archive job handoffs
  watch [interval]   Continuous monitoring (default: 5000ms)
`);
  }
}
