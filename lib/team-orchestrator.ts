/**
 * BOTS Team Orchestrator
 *
 * Team-mode equivalent of orchestrator.ts. Produces structured
 * instructions for the team lead to create tasks, wire dependencies,
 * and spawn teammates using Claude Code's agent teams feature.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Job,
  getActiveJobs,
  startJob,
  loadState
} from './job-manager.js';
import {
  TeamTask,
  TeamExecutionPlan,
  buildTeamExecutionPlan,
  buildTeammatePrompt,
  generateTaskCreates,
  generateDependencyWiring
} from './team-executor.js';
import { createWorktree } from './worktree.js';
import { isBound, getSyncOperation } from './project-integration.js';
import { autoDetectAndSet, getStatePath } from './integrations/detect.js';

// ============================================================================
// Types
// ============================================================================

export interface TeammateSpawnInfo {
  name: string;       // e.g., "hacker-job-001"
  prompt: string;     // full spawn prompt
  model?: string;     // model hint for lead
  planApproval: boolean;
}

export interface TeamOrchestratorResult {
  processed: number;
  teamName: string;
  tasksCreated: TeamTask[];
  teammatesNeeded: TeammateSpawnInfo[];
  errors: string[];
  projectOps: Array<{ tool: string; params: any }>;
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Orchestrate all active jobs in team mode.
 *
 * For each pending/running job:
 * 1. Build execution plan (phases -> team tasks with deps)
 * 2. Generate TaskCreate payloads
 * 3. Generate teammate spawn info
 */
export function orchestrateTeam(
  parentTid: string = 'BOTS',
  parentCoa: string = 'BOTS.COA'
): TeamOrchestratorResult {
  const state = loadState();
  const teamConfig = state.team_config;

  const result: TeamOrchestratorResult = {
    processed: 0,
    teamName: teamConfig?.team_name || 'bots-team',
    tasksCreated: [],
    teammatesNeeded: [],
    errors: [],
    projectOps: []
  };

  const jobs = getActiveJobs();

  for (const job of jobs) {
    try {
      result.processed++;

      if (job.status === 'pending') {
        processNewTeamJob(job, teamConfig, result);
      } else if (job.status === 'running') {
        processRunningTeamJob(job, teamConfig, result);
      }
      // checkpoint jobs in team mode are handled by the TaskCompleted hook
    } catch (error) {
      result.errors.push(
        `Job ${job.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return result;
}

function processNewTeamJob(
  job: Job,
  teamConfig: typeof loadState extends () => infer S ? (S extends { team_config?: infer T } ? T : never) : never,
  result: TeamOrchestratorResult
): void {
  // Start the job
  const startedJob = startJob(job.id);

  // Create worktree
  const worktreeResult = createWorktree(job.id);
  if (!worktreeResult.success && !worktreeResult.error?.includes('already exists')) {
    result.errors.push(`Job ${job.id}: Failed to create worktree: ${worktreeResult.error}`);
    return;
  }

  // Build team execution plan
  const plan = buildTeamExecutionPlan(startedJob);

  // Add tasks to result
  result.tasksCreated.push(...plan.tasks);
  result.teamName = plan.teamName;

  // Generate teammate spawn info for each task
  for (const task of plan.tasks) {
    const phase = startedJob.phases.find(p => p.id === task.metadata.phaseId);
    if (!phase) continue;

    const workerShort = task.metadata.worker.replace('$W.', '').replace(/\./g, '-');
    const name = `${workerShort}-${job.id}`;

    const spawnInfo: TeammateSpawnInfo = {
      name,
      prompt: buildTeammatePrompt(startedJob, task.metadata.worker, task.metadata.workerTid, phase),
      model: task.metadata.model,
      planApproval: (teamConfig as any)?.require_plan_approval ?? false
    };

    result.teammatesNeeded.push(spawnInfo);
  }

  // Project integration sync
  if (isBound(job.id)) {
    const syncOp = getSyncOperation(job.id);
    if (syncOp) {
      result.projectOps.push(syncOp);
    }
  }
}

function processRunningTeamJob(
  job: Job,
  teamConfig: any,
  result: TeamOrchestratorResult
): void {
  // In team mode, running jobs are managed via the shared task list.
  // The team lead monitors progress through task statuses.
  // Only generate new tasks if a phase just transitioned.
  const currentPhase = job.phases.find(p => p.id === job.currentPhase);
  if (!currentPhase || currentPhase.status !== 'running') return;

  // Check if this phase already has team tasks (via team binding)
  if (job.team?.phaseTaskGroups?.[currentPhase.id]?.length) {
    // Tasks already exist for this phase, nothing to do
    return;
  }

  // New phase needs tasks — build plan for remaining phases
  const plan = buildTeamExecutionPlan(job);
  result.tasksCreated.push(...plan.tasks);
  result.teamName = plan.teamName;

  for (const task of plan.tasks) {
    const phase = job.phases.find(p => p.id === task.metadata.phaseId);
    if (!phase) continue;

    const workerShort = task.metadata.worker.replace('$W.', '').replace(/\./g, '-');
    const name = `${workerShort}-${job.id}`;

    result.teammatesNeeded.push({
      name,
      prompt: buildTeammatePrompt(job, task.metadata.worker, task.metadata.workerTid, phase),
      model: task.metadata.model,
      planApproval: teamConfig?.require_plan_approval ?? false
    });
  }
}

// ============================================================================
// Output Formatting
// ============================================================================

/**
 * Generate structured text instructions for the team lead.
 *
 * The lead uses these to create tasks, wire dependencies, and
 * spawn teammates via the agent teams API.
 */
export function generateTeamLeadInstructions(
  result: TeamOrchestratorResult
): string {
  const lines: string[] = [];

  lines.push('# BOTS Team Orchestration');
  lines.push('');
  lines.push(`Team: **${result.teamName}**`);
  lines.push(`Tasks to create: **${result.tasksCreated.length}**`);
  lines.push(`Teammates to spawn: **${result.teammatesNeeded.length}**`);
  lines.push('');

  if (result.tasksCreated.length > 0) {
    lines.push('## Step 1: Create Tasks');
    lines.push('');
    lines.push('Create these tasks using `TaskCreate`:');
    lines.push('');

    for (const task of result.tasksCreated) {
      lines.push(`### ${task.subject}`);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify({
        subject: task.subject,
        description: task.description,
        activeForm: task.activeForm,
        metadata: task.metadata
      }, null, 2));
      lines.push('```');
      lines.push('');
    }

    // Dependency wiring instructions
    const tasksWithDeps = result.tasksCreated.filter(t => t.blockedBy.length > 0);
    if (tasksWithDeps.length > 0) {
      lines.push('## Step 2: Wire Dependencies');
      lines.push('');
      lines.push('After creating tasks, wire `blockedBy` using `TaskUpdate`:');
      lines.push('');

      for (const task of tasksWithDeps) {
        lines.push(`- **${task.subject}** is blocked by: ${task.blockedBy.join(', ')}`);
      }
      lines.push('');
      lines.push('Map workerTid references to the actual task IDs returned by TaskCreate.');
      lines.push('');
    }
  }

  if (result.teammatesNeeded.length > 0) {
    lines.push(`## Step ${result.tasksCreated.some(t => t.blockedBy.length > 0) ? '3' : '2'}: Spawn Teammates`);
    lines.push('');

    for (const tm of result.teammatesNeeded) {
      lines.push(`### ${tm.name}`);
      lines.push(`- Model: ${tm.model || 'sonnet'}`);
      lines.push(`- Plan approval: ${tm.planApproval}`);
      lines.push('');
    }
  }

  if (result.errors.length > 0) {
    lines.push('## Errors');
    lines.push('');
    for (const err of result.errors) {
      lines.push(`- ${err}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format team orchestrator result for CLI display.
 */
export function formatTeamResult(result: TeamOrchestratorResult): string {
  const lines: string[] = [];

  lines.push('┌─────────────────────────────────────────────────────────────┐');
  lines.push('│  BOTS TEAM ORCHESTRATION                                    │');
  lines.push('├─────────────────────────────────────────────────────────────┤');

  lines.push(`│  Team: ${result.teamName}`.padEnd(62) + '│');
  lines.push(`│  Tasks: ${result.tasksCreated.length}  Teammates: ${result.teammatesNeeded.length}`.padEnd(62) + '│');

  if (result.tasksCreated.length > 0) {
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│  Tasks:'.padEnd(62) + '│');
    for (const t of result.tasksCreated) {
      const dep = t.blockedBy.length > 0 ? ` (blocked by ${t.blockedBy.length})` : '';
      lines.push(`│    → ${t.subject}${dep}`.substring(0, 61).padEnd(62) + '│');
    }
  }

  if (result.teammatesNeeded.length > 0) {
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│  Teammates:'.padEnd(62) + '│');
    for (const tm of result.teammatesNeeded) {
      lines.push(`│    → ${tm.name} (${tm.model || 'sonnet'})`.padEnd(62) + '│');
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
  autoDetectAndSet();
  const action = process.argv[2] || 'run';

  switch (action) {
    case 'run': {
      const result = orchestrateTeam();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'display': {
      const result = orchestrateTeam();
      console.log(formatTeamResult(result));
      break;
    }

    case 'tasks': {
      const result = orchestrateTeam();
      const creates = generateTaskCreates(
        buildTeamExecutionPlan(getActiveJobs()[0])
      );
      console.log(JSON.stringify(creates, null, 2));
      break;
    }

    case 'instructions': {
      const result = orchestrateTeam();
      console.log(generateTeamLeadInstructions(result));
      break;
    }

    default:
      console.log('Usage: team-orchestrator.ts [run|display|tasks|instructions]');
  }
}
