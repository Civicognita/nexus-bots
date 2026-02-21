/**
 * BOTS Display System
 *
 * CLI-friendly display for job status, checkpoints, and progress.
 * Uses box-drawing characters for clean terminal output.
 */

import { Job, JobPhase, getJob, getActiveJobs } from './job-manager.js';
import {
  CheckpointNotification,
  WorkerSummary,
  FileChange,
  TestSummary
} from './gates.js';

// ============================================================================
// Box Drawing Characters
// ============================================================================

const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
  cross: '┼'
};

// ============================================================================
// Status Icons
// ============================================================================

const STATUS_ICONS = {
  pending: '○',
  running: '●',
  complete: '✓',
  failed: '✗',
  checkpoint: '◆',
  blocked: '⊘'
};

const STATUS_COLORS = {
  pending: 'dim',
  running: 'yellow',
  complete: 'green',
  failed: 'red',
  checkpoint: 'cyan',
  blocked: 'magenta'
};

// ============================================================================
// Progress Bar
// ============================================================================

/**
 * Generate a progress bar
 */
export function progressBar(current: number, total: number, width: number = 5): string {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Calculate job progress (completed phases / total phases)
 */
export function calculateProgress(job: Job): { current: number; total: number } {
  const total = job.phases.length;
  const completed = job.phases.filter(p => p.status === 'complete').length;
  return { current: completed, total };
}

// ============================================================================
// Job Status Display
// ============================================================================

/**
 * Format a single job line for status display
 */
export function formatJobLine(job: Job, width: number = 60): string {
  const status = job.status;
  const icon = STATUS_ICONS[status] || '?';
  const { current, total } = calculateProgress(job);
  const bar = progressBar(current, total);

  const maxTextLen = width - 30;
  let text = job.queueText;
  if (text.length > maxTextLen) {
    text = text.substring(0, maxTextLen - 3) + '...';
  }

  const phaseIndicator = job.currentPhase || 'Done';

  return `${job.id} ${icon} ${text.padEnd(maxTextLen)} [${bar}] ${phaseIndicator}`;
}

/**
 * Display all active jobs in a box
 */
export function displayJobsStatus(width: number = 60): string {
  const jobs = getActiveJobs();
  const lines: string[] = [];

  const title = ' BOTS ';
  const headerPadding = Math.floor((width - title.length - 2) / 2);
  lines.push(
    BOX.topLeft +
    BOX.horizontal.repeat(headerPadding) +
    title +
    BOX.horizontal.repeat(width - headerPadding - title.length - 2) +
    BOX.topRight
  );

  if (jobs.length === 0) {
    const emptyMsg = 'No active jobs';
    const padding = Math.floor((width - emptyMsg.length - 2) / 2);
    lines.push(
      BOX.vertical +
      ' '.repeat(padding) +
      emptyMsg +
      ' '.repeat(width - padding - emptyMsg.length - 2) +
      BOX.vertical
    );
  } else {
    for (const job of jobs) {
      const jobLine = formatJobLine(job, width - 4);
      lines.push(BOX.vertical + ' ' + jobLine + ' ' + BOX.vertical);
    }
  }

  lines.push(BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight);

  return lines.join('\n');
}

// ============================================================================
// Checkpoint Display
// ============================================================================

/**
 * Display a checkpoint notification
 */
export function displayCheckpoint(notification: CheckpointNotification, width: number = 70): string {
  const lines: string[] = [];

  const title = ` ${notification.jobId} `;
  const headerPadding = Math.floor((width - title.length - 2) / 2);
  lines.push(
    BOX.topLeft +
    BOX.horizontal.repeat(headerPadding) +
    title +
    BOX.horizontal.repeat(width - headerPadding - title.length - 2) +
    BOX.topRight
  );

  const phaseInfo = `Phase ${notification.phaseName} complete: ${notification.gateType} gate`;
  lines.push(BOX.vertical + ' ' + phaseInfo.padEnd(width - 3) + BOX.vertical);
  lines.push(BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft);

  if (notification.workers.length > 0) {
    lines.push(BOX.vertical + ' Workers:'.padEnd(width - 2) + BOX.vertical);
    for (const worker of notification.workers) {
      const icon = worker.status === 'complete' ? STATUS_ICONS.complete : STATUS_ICONS.failed;
      const duration = worker.duration ? ` (${Math.round(worker.duration / 1000)}s)` : '';
      const workerLine = `   ${icon} ${worker.worker}${duration}`;
      lines.push(BOX.vertical + workerLine.padEnd(width - 2) + BOX.vertical);

      if (worker.summary) {
        const summaryLine = `     ${truncate(worker.summary, width - 10)}`;
        lines.push(BOX.vertical + summaryLine.padEnd(width - 2) + BOX.vertical);
      }
    }
    lines.push(BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft);
  }

  if (notification.filesChanged.length > 0) {
    lines.push(BOX.vertical + ' Files changed:'.padEnd(width - 2) + BOX.vertical);
    for (const file of notification.filesChanged.slice(0, 5)) {
      const actionIcon = file.action === 'created' ? '+' : file.action === 'deleted' ? '-' : '~';
      const fileLine = `   ${actionIcon} ${truncate(file.path, width - 10)}`;
      lines.push(BOX.vertical + fileLine.padEnd(width - 2) + BOX.vertical);
    }
    if (notification.filesChanged.length > 5) {
      const more = `   ... and ${notification.filesChanged.length - 5} more`;
      lines.push(BOX.vertical + more.padEnd(width - 2) + BOX.vertical);
    }
    lines.push(BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft);
  }

  if (notification.testsRun) {
    const { passed, failed, total } = notification.testsRun;
    const testIcon = failed === 0 ? STATUS_ICONS.complete : STATUS_ICONS.failed;
    const testLine = ` Tests: ${testIcon} ${passed}/${total} passed`;
    lines.push(BOX.vertical + testLine.padEnd(width - 2) + BOX.vertical);
    lines.push(BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft);
  }

  lines.push(BOX.vertical + ''.padEnd(width - 2) + BOX.vertical);
  for (const option of notification.options) {
    const optionLine = ` [${option.key}] ${option.label} - ${option.description}`;
    lines.push(BOX.vertical + truncate(optionLine, width - 3).padEnd(width - 2) + BOX.vertical);
  }

  lines.push(BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight);

  return lines.join('\n');
}

// ============================================================================
// Job Completion Display
// ============================================================================

export function displayCompletion(
  jobId: string,
  steps: string[],
  configPath?: string
): string {
  const job = getJob(jobId, configPath);
  const width = 60;
  const lines: string[] = [];

  const title = ` ${jobId} COMPLETE `;
  const headerPadding = Math.floor((width - title.length - 2) / 2);
  lines.push(
    BOX.topLeft +
    BOX.horizontal.repeat(headerPadding) +
    title +
    BOX.horizontal.repeat(width - headerPadding - title.length - 2) +
    BOX.topRight
  );

  if (job) {
    const desc = truncate(job.queueText, width - 4);
    lines.push(BOX.vertical + ` "${desc}"`.padEnd(width - 2) + BOX.vertical);
    lines.push(BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft);
  }

  lines.push(BOX.vertical + ' Summary:'.padEnd(width - 2) + BOX.vertical);
  for (const step of steps) {
    const stepLine = ` ${STATUS_ICONS.complete} ${truncate(step, width - 6)}`;
    lines.push(BOX.vertical + stepLine.padEnd(width - 2) + BOX.vertical);
  }

  lines.push(BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight);

  return lines.join('\n');
}

// ============================================================================
// Phase Progress Display
// ============================================================================

export function displayPhaseProgress(jobId: string, configPath?: string): string {
  const job = getJob(jobId, configPath);
  if (!job) {
    return `Job ${jobId} not found`;
  }

  const width = 60;
  const lines: string[] = [];

  lines.push(BOX.topLeft + BOX.horizontal.repeat(width - 2) + BOX.topRight);
  lines.push(BOX.vertical + ` Job: ${job.id}`.padEnd(width - 2) + BOX.vertical);
  lines.push(BOX.vertical + ` Task: ${truncate(job.queueText, width - 10)}`.padEnd(width - 2) + BOX.vertical);
  lines.push(BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft);

  lines.push(BOX.vertical + ' Phases:'.padEnd(width - 2) + BOX.vertical);
  for (const phase of job.phases) {
    const icon = STATUS_ICONS[phase.status] || '?';
    const isCurrent = phase.id === job.currentPhase ? ' ←' : '';
    const phaseLine = `   ${icon} ${phase.id}: ${phase.name} (${phase.gate})${isCurrent}`;
    lines.push(BOX.vertical + truncate(phaseLine, width - 3).padEnd(width - 2) + BOX.vertical);

    for (const worker of phase.workers) {
      const workerLine = `      • ${worker}`;
      lines.push(BOX.vertical + workerLine.padEnd(width - 2) + BOX.vertical);
    }
  }

  lines.push(BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight);

  return lines.join('\n');
}

// ============================================================================
// Queue Display
// ============================================================================

export function displayQueuedItems(
  items: Array<{ type: 'queue' | 'next'; content: string; jobId?: string }>,
  width: number = 60
): string {
  const lines: string[] = [];

  lines.push(BOX.topLeft + BOX.horizontal.repeat(width - 2) + BOX.topRight);
  lines.push(BOX.vertical + ' Queued Work:'.padEnd(width - 2) + BOX.vertical);
  lines.push(BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft);

  for (const item of items) {
    if (item.type === 'queue') {
      const jobLine = ` ${STATUS_ICONS.pending} ${item.jobId || 'NEW'}: ${truncate(item.content, width - 15)}`;
      lines.push(BOX.vertical + jobLine.padEnd(width - 2) + BOX.vertical);
    } else {
      lines.push(BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft);
      const nextLine = ` Next frame: ${truncate(item.content, width - 15)}`;
      lines.push(BOX.vertical + nextLine.padEnd(width - 2) + BOX.vertical);
    }
  }

  lines.push(BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight);

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

// CLI support
if (typeof require !== 'undefined' && require.main === module) {
  const action = process.argv[2];

  switch (action) {
    case 'status':
      console.log(displayJobsStatus());
      break;
    case 'job':
      console.log(displayPhaseProgress(process.argv[3] || ''));
      break;
    default:
      console.log('Usage: display.ts <status|job> [jobId]');
  }
}
