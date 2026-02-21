/**
 * BOTS Team Executor
 *
 * Translates BOTS job phases into Claude Code agent team constructs:
 * - TeamTask objects with dependency wiring (blockedBy)
 * - Teammate spawn prompts combining base protocol + worker overlay
 * - TaskCreate/TaskUpdate payloads for the shared task list
 *
 * This is the team-mode equivalent of executor.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Job,
  JobPhase,
  GateType,
  getJob,
  getChainedWorker,
  loadState,
  saveState,
  completePhase
} from './job-manager.js';
import { generateWorkerTid } from './executor.js';
import { getStatePath } from './integrations/detect.js';

// ============================================================================
// Types
// ============================================================================

export interface TeamTask {
  subject: string;
  description: string;
  activeForm: string;
  metadata: {
    jobId: string;
    phaseId: string;
    worker: string;
    workerTid: string;
    gate: string;
    model: string;
    isChainTarget: boolean;
    chainSource?: string;
  };
  blockedBy: string[];  // workerTids of predecessor tasks
}

export interface TeamExecutionPlan {
  jobId: string;
  teamName: string;
  tasks: TeamTask[];
  phaseTaskMap: Record<string, string[]>;  // phaseId -> workerTids
}

// ============================================================================
// Model Selection
// ============================================================================

function getWorkerModel(worker: string): string {
  if (worker.includes('.librarian') ||
      worker.includes('.cryptologist') ||
      worker.includes('.prioritizer') ||
      worker.includes('.custodian') ||
      worker.includes('.editor') ||
      worker.includes('.archivist')) {
    return 'haiku';
  }
  return 'sonnet';
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Build a teammate spawn prompt for a worker in team mode.
 *
 * Combines:
 * - Worker base protocol (workers/base.md)
 * - Worker overlay (workers/{domain}/{role}.md)
 * - Team-specific instructions (use TaskUpdate to mark complete)
 * - Dispatch context (job, phase, worktree)
 */
export function buildTeammatePrompt(
  job: Job,
  worker: string,
  workerTid: string,
  phase: JobPhase
): string {
  const outputPath = path.join(process.cwd(), '.ai', 'handoff', `${workerTid}.json`);
  const checkpointPath = path.join(process.cwd(), '.ai', 'checkpoints', `${workerTid}.json`);

  // Read base template
  const basePath = path.join(process.cwd(), '.claude', 'prompts', 'worker-base.md');
  let basePrompt = '';
  try {
    basePrompt = fs.readFileSync(basePath, 'utf-8');
  } catch {
    basePrompt = `You are ${worker}, a WORKER agent in team mode.`;
  }

  // Get allowed tools from spawn config
  const configPath = getStatePath('spawn-config.json');
  let allowedTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const workerConfig = config.workers?.[worker] || config.workers?.['$W.default'];
    if (workerConfig?.tools_allowed) {
      allowedTools = workerConfig.tools_allowed;
    }
  } catch {}

  // Inject values into base prompt
  let prompt = basePrompt
    .replace(/\{worker_type\}/g, worker)
    .replace(/\{worker_tid\}/g, workerTid)
    .replace(/\{job_id\}/g, job.id)
    .replace(/\{phase_id\}/g, phase.id)
    .replace(/\{worktree_path\}/g, job.worktree)
    .replace(/\{branch\}/g, job.branch)
    .replace(/\{dispatch_path\}/g, '(inline — see task description)')
    .replace(/\{output_path\}/g, outputPath)
    .replace(/\{checkpoint_path\}/g, checkpointPath)
    .replace(/\{allowed_tools\}/g, JSON.stringify(allowedTools))
    .replace(/\{verbose_instruction\}/g, 'Mark your task as completed via TaskUpdate, then terminate.');

  // Load worker overlay
  const workerType = worker.replace('$W.', '').split('.')[0];
  const workerRole = worker.replace('$W.', '').split('.').slice(1).join('.');
  const overlayPath = path.join(
    process.cwd(), '.claude', 'agents', 'workers', workerType, `${workerRole}.md`
  );

  try {
    const overlay = fs.readFileSync(overlayPath, 'utf-8');
    prompt += '\n\n---\n\n' + overlay;
  } catch {
    // No overlay found
  }

  // Append team-specific instructions
  prompt += `\n\n---\n\n## Team Mode Instructions

You are running as a **teammate** in an agent team for job \`${job.id}\`.

**Task context:**
- Job: ${job.id} — ${job.queueText}
- Phase: ${phase.id} (${phase.name})
- Gate: ${phase.gate}
- Worktree: ${job.worktree} (branch: ${job.branch})

**Protocol:**
1. Read your assigned task description for specific requirements.
2. Execute the work in the shared worktree at \`${job.worktree}\`.
3. Write checkpoint JSON to \`${checkpointPath}\` for progress updates.
4. On completion, write handoff JSON to \`${outputPath}\`.
5. Mark your task as **completed** using TaskUpdate.

**Handoff JSON format:**
\`\`\`json
{
  "handoff": {
    "worker_tid": "${workerTid}",
    "worker": "${worker}",
    "job_id": "${job.id}",
    "phase_id": "${phase.id}",
    "status": "complete",
    "output": {
      "summary": "<what you did>",
      "files_created": [],
      "files_modified": []
    }
  }
}
\`\`\`
`;

  return prompt;
}

// ============================================================================
// Execution Plan
// ============================================================================

/**
 * Build a team execution plan from a job's phases.
 *
 * Maps each worker in each phase to a TeamTask. Tasks in phase N+1
 * get blockedBy all tasks in phase N. Enforced chain targets become
 * additional dependent tasks within the same phase.
 */
export function buildTeamExecutionPlan(
  job: Job,
  configPath?: string
): TeamExecutionPlan {
  const state = loadState(configPath);
  const teamConfig = state.team_config;
  const teamName = teamConfig?.team_name || `bots-${job.id}`;

  const plan: TeamExecutionPlan = {
    jobId: job.id,
    teamName,
    tasks: [],
    phaseTaskMap: {}
  };

  let previousPhaseTids: string[] = [];

  for (const phase of job.phases) {
    if (phase.status === 'complete') continue;

    const phaseTids: string[] = [];
    plan.phaseTaskMap[phase.id] = [];

    for (const worker of phase.workers) {
      const workerTid = generateWorkerTid(worker, job.id);

      const task: TeamTask = {
        subject: `[${job.id}/${phase.id}] ${worker}`,
        description: buildTaskDescription(job, phase, worker, workerTid),
        activeForm: `Running ${worker.replace('$W.', '')} for ${job.id}`,
        metadata: {
          jobId: job.id,
          phaseId: phase.id,
          worker,
          workerTid,
          gate: phase.gate,
          model: getWorkerModel(worker),
          isChainTarget: false
        },
        blockedBy: [...previousPhaseTids]
      };

      plan.tasks.push(task);
      phaseTids.push(workerTid);
      plan.phaseTaskMap[phase.id].push(workerTid);

      // Check for enforced chain
      const chainTarget = getChainedWorker(worker, configPath);
      if (chainTarget) {
        const chainTid = generateWorkerTid(chainTarget, job.id);

        const chainTask: TeamTask = {
          subject: `[${job.id}/${phase.id}] ${chainTarget} (chain)`,
          description: buildTaskDescription(job, phase, chainTarget, chainTid),
          activeForm: `Running ${chainTarget.replace('$W.', '')} chain for ${job.id}`,
          metadata: {
            jobId: job.id,
            phaseId: phase.id,
            worker: chainTarget,
            workerTid: chainTid,
            gate: phase.gate,
            model: getWorkerModel(chainTarget),
            isChainTarget: true,
            chainSource: worker
          },
          blockedBy: [workerTid]  // Chain target blocked by source
        };

        plan.tasks.push(chainTask);
        phaseTids.push(chainTid);
        plan.phaseTaskMap[phase.id].push(chainTid);
      }
    }

    previousPhaseTids = phaseTids;
  }

  return plan;
}

/**
 * Build the task description that will be shown in the shared task list.
 * Embeds BOTS metadata as parseable markers for the TaskCompleted hook.
 */
function buildTaskDescription(
  job: Job,
  phase: JobPhase,
  worker: string,
  workerTid: string
): string {
  return `## BOTS Worker Task

**job_id:** ${job.id}
**phase_id:** ${phase.id}
**worker:** ${worker}
**worker_tid:** ${workerTid}
**gate:** ${phase.gate}

### Assignment
${job.queueText}

### Phase
${phase.name} (${phase.id}) — Gate: ${phase.gate}

### Worktree
Path: \`${job.worktree}\`
Branch: \`${job.branch}\`

### Instructions
Execute the task described above following the worker protocol for \`${worker}\`.
Write handoff JSON to \`.ai/handoff/${workerTid}.json\` on completion.
Mark this task as completed when done.`;
}

// ============================================================================
// Task List Generation
// ============================================================================

/**
 * Generate TaskCreate payloads from a team execution plan.
 */
export function generateTaskCreates(
  plan: TeamExecutionPlan
): Array<{ subject: string; description: string; activeForm: string; metadata: TeamTask['metadata'] }> {
  return plan.tasks.map(task => ({
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    metadata: task.metadata
  }));
}

/**
 * Generate TaskUpdate calls to wire blockedBy dependencies.
 *
 * Called after tasks are created and have real task IDs.
 * Maps workerTid references to actual task IDs.
 */
export function generateDependencyWiring(
  plan: TeamExecutionPlan,
  taskIdMap: Record<string, string>  // workerTid -> task ID
): Array<{ taskId: string; addBlockedBy: string[] }> {
  const updates: Array<{ taskId: string; addBlockedBy: string[] }> = [];

  for (const task of plan.tasks) {
    if (task.blockedBy.length === 0) continue;

    const taskId = taskIdMap[task.metadata.workerTid];
    if (!taskId) continue;

    const blockedByIds = task.blockedBy
      .map(tid => taskIdMap[tid])
      .filter(Boolean);

    if (blockedByIds.length > 0) {
      updates.push({ taskId, addBlockedBy: blockedByIds });
    }
  }

  return updates;
}

// ============================================================================
// Task Completion Reconciliation
// ============================================================================

/**
 * Reconcile a team task completion with BOTS state.
 *
 * Called by the TaskCompleted hook when a team task finishes.
 * Updates BOTS job state and returns whether the phase is done
 * and what gate type applies.
 */
export function reconcileTaskCompletion(
  jobId: string,
  phaseId: string,
  worker: string,
  workerTid?: string,
  configPath?: string
): { allPhaseWorkersComplete: boolean; gateType: string; error?: string } {
  try {
    const job = getJob(jobId, configPath);
    if (!job) {
      return { allPhaseWorkersComplete: false, gateType: 'unknown', error: `Job ${jobId} not found` };
    }

    const phase = job.phases.find(p => p.id === phaseId);
    if (!phase) {
      return { allPhaseWorkersComplete: false, gateType: 'unknown', error: `Phase ${phaseId} not found` };
    }

    // Record handoff in BOTS state
    const result = completePhase(jobId, phaseId, workerTid || worker, configPath);

    // Determine if all workers in this phase are done
    // Check the team binding for comprehensive tracking
    const state = loadState(configPath);
    const updatedJob = state.wip.jobs[jobId];
    const updatedPhase = updatedJob?.phases.find(p => p.id === phaseId);

    const allComplete = updatedPhase?.status === 'complete';

    return {
      allPhaseWorkersComplete: allComplete,
      gateType: phase.gate
    };
  } catch (err) {
    return {
      allPhaseWorkersComplete: false,
      gateType: 'unknown',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
