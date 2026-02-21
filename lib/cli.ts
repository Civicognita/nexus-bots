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
 *   mode [mode]       Get or set execution mode (subagent|team)
 *   team-reconcile    Update BOTS state when team task completes
 *   team-pending      Check pending BOTS tasks for a teammate
 *   team-status       Show team mode status
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
import {
  reconcileTaskCompletion
} from './team-executor.js';
import {
  orchestrateTeam,
  formatTeamResult,
  generateTeamLeadInstructions
} from './team-orchestrator.js';
import { upgrade } from './upgrade.js';

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
    const state = loadState();
    const mode = state.mode || process.env.BOTS_MODE || 'subagent';

    if (mode === 'team') {
      const teamResult = orchestrateTeam();
      if (args.includes('--json')) {
        output(teamResult);
      } else if (args.includes('--tasks')) {
        output(teamResult.tasksCreated);
      } else if (args.includes('--instructions')) {
        console.log(generateTeamLeadInstructions(teamResult));
      } else {
        console.log(formatTeamResult(teamResult));
      }
      return;
    }

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
   * Get or set execution mode
   */
  mode(args: string[]) {
    const state = loadState();
    if (args.length === 0) {
      output({ mode: state.mode || 'subagent' });
      return;
    }

    const newMode = args[0];
    if (newMode !== 'subagent' && newMode !== 'team') {
      error('Invalid mode. Usage: mode [subagent|team]');
    }

    (state as any).mode = newMode;

    // Initialize team_config if switching to team mode and not yet set
    if (newMode === 'team' && !(state as any).team_config) {
      (state as any).team_config = {
        team_name: 'bots-team',
        teammate_mode: 'in-process',
        max_teammates: 4,
        require_plan_approval: false
      };
    }

    saveState(state);
    output({ mode: newMode, team_config: (state as any).team_config || null });
  },

  /**
   * Update BOTS state when a team task completes (called by TaskCompleted hook)
   */
  'team-reconcile'(args: string[]) {
    const jobId = args[0];
    const phaseId = args[1];
    const worker = args[2];
    const workerTid = args[3];

    if (!jobId || !phaseId || !worker) {
      error('Usage: team-reconcile <jobId> <phaseId> <worker> [workerTid]');
    }

    const result = reconcileTaskCompletion(jobId, phaseId, worker, workerTid);
    output(result);
  },

  /**
   * Check pending BOTS tasks for a teammate (called by TeammateIdle hook)
   */
  'team-pending'(args: string[]) {
    const teammateName = args[0];
    if (!teammateName) {
      error('Usage: team-pending <teammateName>');
    }

    // Look through active jobs for tasks assigned to this teammate
    const jobs = getActiveJobs();
    let pendingCount = 0;
    let hasHandoff = true;

    for (const job of jobs) {
      if (!job.team) continue;

      for (const [tid, taskId] of Object.entries(job.team.taskIds)) {
        // Check if this teammate name matches the worker tid pattern
        if (tid.includes(teammateName.replace(/-job-\d+$/, '').replace(/-/g, '.'))) {
          // Check if handoff file exists
          const handoffPath = path.join(process.cwd(), '.ai', 'handoff', `${tid}.json`);
          if (!fs.existsSync(handoffPath)) {
            pendingCount++;
            hasHandoff = false;
          }
        }
      }
    }

    output({ teammate: teammateName, pending: pendingCount, hasHandoff });
  },

  /**
   * Show team mode status
   */
  'team-status'(args: string[]) {
    const state = loadState();
    const mode = state.mode || 'subagent';

    if (mode !== 'team') {
      output({ mode, message: 'Not in team mode. Use: npm run tm mode team' });
      return;
    }

    const jobs = getActiveJobs();
    const teamJobs = jobs.filter(j => j.team);

    output({
      mode,
      team_config: state.team_config || null,
      active_team_jobs: teamJobs.length,
      jobs: teamJobs.map(j => ({
        id: j.id,
        status: j.status,
        team: j.team?.teamName,
        phase: j.currentPhase,
        tasks: j.team ? Object.keys(j.team.taskIds).length : 0,
        phaseGroups: j.team?.phaseTaskGroups || {}
      }))
    });
  },

  /**
   * Upgrade an existing BOTS installation from source repo
   */
  upgrade(args: string[]) {
    const check = args.includes('--check');
    const sourcePath = args.find(a => !a.startsWith('--'));

    if (!sourcePath) {
      error('No source path provided. Usage: upgrade <source-path> [--check]');
    }

    const result = upgrade(sourcePath, check);

    if (result.errors.length > 0) {
      console.error('\nErrors:');
      for (const e of result.errors) console.error(`  ✗ ${e}`);
      process.exit(1);
    }

    console.log(`\nBOTS Upgrade ${check ? '(dry run)' : ''}`);
    console.log(`  Version: ${result.fromVersion} → ${result.toVersion}`);
    console.log(`  Files: ${result.counts.lib} lib, ${result.counts.workers} workers, ${result.counts.schemas} schemas, ${result.counts.hooks} hooks\n`);

    if (result.actions.length > 0) {
      console.log('Actions:');
      for (const a of result.actions) console.log(`  • ${a}`);
    }

    if (result.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    }

    if (!check) {
      console.log('\nUpgrade complete.');
    }
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
  mode [subagent|team] Get or set execution mode
  team-reconcile      Update BOTS state on team task completion
  team-pending        Check pending tasks for a teammate
  team-status         Show team mode status
  upgrade <src> [--check]  Upgrade installation from source repo
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
