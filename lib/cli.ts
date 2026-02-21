#!/usr/bin/env npx tsx
/**
 * BOTS CLI
 *
 * Command-line interface for BOTS work queue orchestration.
 * Used by hooks and dispatch commands to process shortcodes and manage jobs.
 *
 * Usage:
 *   npx tsx .bots/lib/cli.ts <command> [args]
 *
 * Commands:
 *   parse <input>     Parse shortcodes from input text
 *   queue <text>      Create a job from queue text
 *   status            Show all active jobs
 *   job <id>          Show details for a specific job
 *   start <id>        Start a pending job
 *   check <id>        Check phase status for a job
 *   approve <id>      Approve checkpoint and continue
 *   reject <id>       Reject checkpoint
 *   dispatch <id>     Get dispatch info for spawning workers
 *   next              Get/set next frame
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseShortcodes,
  hasShortcodes,
  extractQueueTexts
} from './parser.js';
import {
  findRoute,
  routeQueues
} from './router.js';
import {
  createJob,
  startJob,
  getJob,
  getActiveJobs,
  approveCheckpoint,
  rejectCheckpoint,
  setNextFrame,
  popNextFrame,
  loadState,
  saveState
} from './job-manager.js';
import {
  preparePhase,
  checkPhaseStatus,
  getSpawnCommands
} from './executor.js';
import {
  evaluateGate,
  handleApproval,
  handleCompletion
} from './gates.js';
import {
  displayJobsStatus,
  displayPhaseProgress,
  displayCheckpoint,
  displayQueuedItems
} from './display.js';
import {
  bindJob,
  parseReferences,
  getSyncOperation
} from './project-integration.js';
import { autoDetectAndSet } from './integrations/detect.js';
import {
  orchestrate,
  generateTaskCalls,
  formatResult as formatOrchResult
} from './orchestrator.js';
import {
  runMonitorCycle,
  formatMonitorResult,
  autoCompleteJobs,
  archiveJobHandoffs
} from './monitor.js';

// ============================================================================
// CLI Helpers
// ============================================================================

function output(data: any, format: 'json' | 'text' = 'json'): void {
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function error(message: string, code: number = 1): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

// ============================================================================
// Commands
// ============================================================================

const commands: Record<string, (args: string[]) => void> = {
  /**
   * Parse shortcodes from input
   */
  parse(args: string[]) {
    const input = args.join(' ') || readStdin();
    if (!input) {
      error('No input provided. Usage: parse <input> or pipe via stdin');
    }

    const result = parseShortcodes(input);
    output({
      hasShortcodes: result.queues.length > 0 || result.next !== null,
      queues: result.queues.map(q => ({
        content: q.content,
        route: findRoute(q.content)
      })),
      next: result.next?.content || null,
      raw: result.raw
    });
  },

  /**
   * Create job(s) from input with shortcodes
   */
  queue(args: string[]) {
    const input = args.join(' ') || readStdin();
    if (!input) {
      error('No input provided. Usage: queue <text with w:> shortcodes>');
    }

    const parsed = parseShortcodes(input);
    const jobs: any[] = [];

    for (const queue of parsed.queues) {
      const job = createJob(queue.content);
      jobs.push({
        id: job.id,
        queueText: job.queueText,
        route: job.route,
        entryWorker: job.entryWorker,
        project: job.project
      });
    }

    if (parsed.next) {
      setNextFrame(parsed.next.content);
    }

    output({
      created: jobs.length,
      jobs,
      nextFrame: parsed.next?.content || null
    });
  },

  /**
   * Show active jobs status
   */
  status(args: string[]) {
    const format = args.includes('--json') ? 'json' : 'text';
    const jobs = getActiveJobs();

    if (format === 'json') {
      output({ jobs, count: jobs.length });
    } else {
      console.log(displayJobsStatus());
    }
  },

  /**
   * Show specific job details
   */
  job(args: string[]) {
    const jobId = args[0];
    if (!jobId) {
      error('No job ID provided. Usage: job <id>');
    }

    const job = getJob(jobId);
    if (!job) {
      error(`Job ${jobId} not found`);
    }

    if (args.includes('--json')) {
      output(job);
    } else {
      console.log(displayPhaseProgress(jobId));
    }
  },

  /**
   * List all jobs (including completed)
   */
  jobs(args: string[]) {
    const state = loadState();
    const all = Object.values(state.wip.jobs);
    const active = all.filter(j =>
      j.status === 'pending' || j.status === 'running' || j.status === 'checkpoint'
    );
    const completed = all.filter(j => j.status === 'complete');
    const failed = all.filter(j => j.status === 'failed');

    output({
      total: all.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      jobs: all.map(j => ({
        id: j.id,
        status: j.status,
        queue: j.queueText.substring(0, 50) + (j.queueText.length > 50 ? '...' : ''),
        phase: j.currentPhase,
        worker: j.entryWorker
      }))
    });
  },

  /**
   * Start a pending job
   */
  start(args: string[]) {
    const jobId = args[0];
    if (!jobId) {
      error('No job ID provided. Usage: start <id>');
    }

    try {
      const job = startJob(jobId);
      output({
        success: true,
        job: {
          id: job.id,
          status: job.status,
          currentPhase: job.currentPhase,
          worktree: job.worktree,
          branch: job.branch
        }
      });
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  },

  /**
   * Prepare phase for execution (create dispatches)
   */
  prepare(args: string[]) {
    const jobId = args[0];
    const parentTid = args[1] || 'CLI';
    const parentCoa = args[2] || 'CLI.COA';

    if (!jobId) {
      error('No job ID provided. Usage: prepare <id> [parentTid] [parentCoa]');
    }

    try {
      const result = preparePhase(jobId, parentTid, parentCoa);
      output({
        success: true,
        worktree: result.worktree,
        dispatches: result.dispatches.map(d => ({
          worker: d.worker,
          workerTid: d.workerTid,
          dispatchPath: d.dispatchPath,
          status: d.status
        }))
      });
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  },

  /**
   * Check phase status
   */
  check(args: string[]) {
    const jobId = args[0];
    const parentTid = args[1] || 'CLI';
    const parentCoa = args[2] || 'CLI.COA';

    if (!jobId) {
      error('No job ID provided. Usage: check <id> [parentTid] [parentCoa]');
    }

    try {
      const result = checkPhaseStatus(jobId, parentTid, parentCoa);
      output({
        jobId: result.jobId,
        phaseId: result.phaseId,
        status: result.status,
        gateTriggered: result.gateTriggered,
        workersComplete: result.workers.filter(w => w.status === 'complete').length,
        workersTotal: result.workers.length,
        projectSync: result.projectSync
      });
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  },

  /**
   * Approve checkpoint
   */
  approve(args: string[]) {
    const jobId = args[0];
    if (!jobId) {
      error('No job ID provided. Usage: approve <id>');
    }

    const result = handleApproval(jobId, 'approve');
    output(result);
  },

  /**
   * Reject checkpoint
   */
  reject(args: string[]) {
    const jobId = args[0];
    const reason = args.slice(1).join(' ') || 'Rejected via CLI';

    if (!jobId) {
      error('No job ID provided. Usage: reject <id> [reason]');
    }

    const result = handleApproval(jobId, 'reject', reason);
    output(result);
  },

  /**
   * Get dispatch info for spawning workers
   */
  dispatch(args: string[]) {
    const jobId = args[0];
    if (!jobId) {
      error('No job ID provided. Usage: dispatch <id>');
    }

    const job = getJob(jobId);
    if (!job) {
      error(`Job ${jobId} not found`);
    }

    const phase = job.phases.find(p => p.id === job.currentPhase);
    if (!phase) {
      error(`No current phase for job ${jobId}`);
    }

    output({
      jobId: job.id,
      phaseId: phase.id,
      phaseName: phase.name,
      worktree: job.worktree,
      branch: job.branch,
      workers: phase.workers.map(w => ({
        worker: w,
        model: getWorkerModel(w),
        prompt: buildWorkerPrompt(job, phase, w)
      })),
      gate: phase.gate
    });
  },

  /**
   * Get/set next frame
   */
  next(args: string[]) {
    if (args.length > 0) {
      setNextFrame(args.join(' '));
      output({ set: true, content: args.join(' ') });
    } else {
      const next = popNextFrame();
      output({ next });
    }
  },

  /**
   * Bind job to project task
   */
  bind(args: string[]) {
    const jobId = args[0];
    const taskId = args[1];

    if (!jobId || !taskId) {
      error('Usage: bind <jobId> <taskId>');
    }

    const binding = bindJob(jobId, { task_id: taskId });
    output({ success: binding !== null, binding });
  },

  /**
   * Run orchestrator to process all pending work
   */
  orchestrate(args: string[]) {
    const result = orchestrate();

    if (args.includes('--json')) {
      output(result);
    } else if (args.includes('--tasks')) {
      const tasks = generateTaskCalls(result.spawned);
      output(tasks);
    } else {
      console.log(formatOrchResult(result));
    }
  },

  /**
   * Run monitor cycle
   */
  monitor(args: string[]) {
    const result = runMonitorCycle();

    if (args.includes('--json')) {
      output(result);
    } else {
      console.log(formatMonitorResult(result));
    }
  },

  /**
   * Complete a job (merge and cleanup)
   */
  complete(args: string[]) {
    const jobId = args[0];
    if (!jobId) {
      error('Usage: complete <jobId>');
    }

    const result = autoCompleteJobs([jobId], !args.includes('--no-merge'));
    output(result);
  },

  /**
   * Archive job handoffs
   */
  archive(args: string[]) {
    const jobId = args[0];
    if (!jobId) {
      error('Usage: archive <jobId>');
    }

    const result = archiveJobHandoffs(jobId);
    output(result);
  },

  /**
   * Detect which integration is active
   */
  detect() {
    const type = autoDetectAndSet();
    output({ integration: type });
  },

  /**
   * Show help
   */
  help() {
    console.log(`
BOTS CLI — Bolt-On Taskmaster System

COMMANDS:
  parse <input>       Parse shortcodes (w:>, n:>) from text
  queue <text>        Create job(s) from shortcode input
  status [--json]     Show active jobs
  jobs                List all jobs
  job <id> [--json]   Show job details
  start <id>          Start a pending job
  prepare <id>        Create dispatch files for current phase
  check <id>          Check phase completion status
  approve <id>        Approve checkpoint, continue to next phase
  reject <id> [msg]   Reject checkpoint, stop job
  dispatch <id>       Get worker spawn info for terminal
  next [text]         Get or set next frame
  bind <job> <task>   Bind job to project task
  orchestrate         Process all pending work (auto-spawn)
  monitor             Check job/worker status
  complete <id>       Complete job (merge + cleanup)
  archive <id>        Archive job handoffs
  detect              Show detected integration (nexus/tynn/noop)
  help                Show this help

SHORTCODE SYNTAX:
  w:> <work>          Queue work for parallel execution
  n:> <frame>         Set next frame after current work

EXAMPLES:
  # Parse user input
  echo "w:> Fix bug in login n:> Review dashboard" | npm run tm parse

  # Create and start job
  npm run tm queue "w:> Add logout button"
  npm run tm start job-001

  # Check status
  npm run tm status
`);
  }
};

// ============================================================================
// Worker Helpers
// ============================================================================

function getWorkerModel(worker: string): string {
  if (worker.includes('.engineer') || worker.includes('.hacker')) {
    return 'sonnet';
  }
  if (worker.includes('.analyst') || worker.includes('.strategist')) {
    return 'sonnet';
  }
  if (worker.includes('.librarian')) {
    return 'haiku';
  }
  return 'sonnet';
}

function buildWorkerPrompt(job: any, phase: any, worker: string): string {
  return `Worker: ${worker}
Job: ${job.id} - ${job.queueText}
Phase: ${phase.id} - ${phase.name}
Worktree: ${job.worktree}
Branch: ${job.branch}`;
}

// ============================================================================
// Stdin Helper
// ============================================================================

function readStdin(): string {
  try {
    if (!process.stdin.isTTY) {
      return fs.readFileSync(0, 'utf-8').trim();
    }
  } catch {}
  return '';
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  // Auto-detect integration at CLI boot
  autoDetectAndSet();

  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const commandArgs = args.slice(1);

  if (commands[command]) {
    commands[command](commandArgs);
  } else {
    console.error(`Unknown command: ${command}`);
    commands.help([]);
    process.exit(1);
  }
}

main();
