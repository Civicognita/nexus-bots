/**
 * BOTS Orchestrator
 *
 * Autonomous work queue management:
 * - Processes pending jobs
 * - Spawns workers via dispatch files
 * - Monitors handoffs
 * - Advances phases through gates
 * - Notifies terminal of checkpoints
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Job,
  getJob,
  getActiveJobs,
  startJob,
  loadState,
  saveState,
  approveCheckpoint
} from './job-manager.js';
import {
  preparePhase,
  checkPhaseStatus,
  WorkerDispatch,
  PhaseExecutionResult
} from './executor.js';
import { evaluateGate, GateDecision } from './gates.js';
import { createWorktree, WorktreeCreateResult } from './worktree.js';
import { isBound, getSyncOperation } from './project-integration.js';
import { autoDetectAndSet, getStatePath } from './integrations/detect.js';
import {
  orchestrateTeam,
  formatTeamResult,
  generateTeamLeadInstructions,
  type TeamOrchestratorResult
} from './team-orchestrator.js';

// ============================================================================
// Types
// ============================================================================

export interface PendingWork {
  jobs: PendingJob[];
  timestamp: string;
}

export interface PendingJob {
  jobId: string;
  action: 'spawn' | 'check' | 'approve' | 'complete';
  workers?: WorkerSpawnInfo[];
  checkpoint?: CheckpointInfo;
}

export interface WorkerSpawnInfo {
  worker: string;
  workerTid: string;
  dispatchPath: string;
  model: 'haiku' | 'sonnet' | 'opus';
  prompt: string;
  background: boolean;
}

export interface CheckpointInfo {
  jobId: string;
  phaseId: string;
  phaseName: string;
  gate: string;
  workers: WorkerSummary[];
  options: string[];
}

export interface WorkerSummary {
  worker: string;
  status: string;
  summary?: string;
}

export interface OrchestratorResult {
  processed: number;
  spawned: WorkerSpawnInfo[];
  checkpoints: CheckpointInfo[];
  completed: string[];
  errors: string[];
  projectOps: Array<{ tool: string; params: any }>;
}

// ============================================================================
// Paths
// ============================================================================

function getPendingWorkPath(): string {
  return getStatePath('pending-work.json');
}
const CHECKPOINT_DIR = path.join(process.cwd(), '.ai', 'checkpoints');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Pending Work Management
// ============================================================================

export function loadPendingWork(): PendingWork {
  try {
    if (fs.existsSync(getPendingWorkPath())) {
      return JSON.parse(fs.readFileSync(getPendingWorkPath(), 'utf-8'));
    }
  } catch {}
  return { jobs: [], timestamp: new Date().toISOString() };
}

export function savePendingWork(work: PendingWork): void {
  ensureDir(path.dirname(getPendingWorkPath()));
  fs.writeFileSync(getPendingWorkPath(), JSON.stringify(work, null, 2), 'utf-8');
}

export function queueJob(jobId: string, action: PendingJob['action']): void {
  const work = loadPendingWork();
  if (!work.jobs.find(j => j.jobId === jobId && j.action === action)) {
    work.jobs.push({ jobId, action });
    work.timestamp = new Date().toISOString();
    savePendingWork(work);
  }
}

export function clearPendingWork(): void {
  if (fs.existsSync(getPendingWorkPath())) {
    fs.unlinkSync(getPendingWorkPath());
  }
}

// ============================================================================
// Worker Model Selection
// ============================================================================

function getWorkerModel(worker: string): 'haiku' | 'sonnet' | 'opus' {
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

function buildWorkerPrompt(
  job: Job,
  worker: string,
  workerTid: string,
  dispatchPath: string
): string {
  const outputPath = path.join(process.cwd(), '.ai', 'handoff', `${workerTid}.json`);
  const checkpointPath = path.join(CHECKPOINT_DIR, `${workerTid}.json`);

  // Read base template
  const basePath = path.join(process.cwd(), '.claude', 'prompts', 'worker-base.md');
  let basePrompt = '';
  try {
    basePrompt = fs.readFileSync(basePath, 'utf-8');
  } catch {
    basePrompt = `You are ${worker}, a WORKER agent. Read dispatch at ${dispatchPath}, execute task, write handoff to ${outputPath}.`;
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

  // Inject values
  let prompt = basePrompt
    .replace(/\{worker_type\}/g, worker)
    .replace(/\{worker_tid\}/g, workerTid)
    .replace(/\{job_id\}/g, job.id)
    .replace(/\{phase_id\}/g, job.currentPhase || 'P0')
    .replace(/\{worktree_path\}/g, job.worktree)
    .replace(/\{branch\}/g, job.branch)
    .replace(/\{dispatch_path\}/g, dispatchPath)
    .replace(/\{output_path\}/g, outputPath)
    .replace(/\{checkpoint_path\}/g, checkpointPath)
    .replace(/\{allowed_tools\}/g, JSON.stringify(allowedTools))
    .replace(/\{verbose_instruction\}/g, 'Output only: HANDOFF_COMPLETE\nThen terminate.');

  // Load worker overlay
  const workerType = worker.replace('$W.', '').split('.')[0];
  const workerRole = worker.replace('$W.', '').split('.').slice(1).join('.');
  const overlayPath = path.join(process.cwd(), '.claude', 'agents', 'workers', workerType, `${workerRole}.md`);

  try {
    const overlay = fs.readFileSync(overlayPath, 'utf-8');
    prompt += '\n\n---\n\n' + overlay;
  } catch {
    // No overlay found, use base only
  }

  return prompt;
}

// ============================================================================
// Orchestration
// ============================================================================

export function orchestrate(
  parentTid: string = 'BOTS',
  parentCoa: string = 'BOTS.COA'
): OrchestratorResult | TeamOrchestratorResult {
  // Check execution mode
  const state = loadState();
  const mode = (state as any).mode || process.env.BOTS_MODE || 'subagent';
  if (mode === 'team') {
    return orchestrateTeam(parentTid, parentCoa);
  }

  const result: OrchestratorResult = {
    processed: 0,
    spawned: [],
    checkpoints: [],
    completed: [],
    errors: [],
    projectOps: []
  };

  const jobs = getActiveJobs();

  for (const job of jobs) {
    try {
      result.processed++;

      switch (job.status) {
        case 'pending':
          processNewJob(job, parentTid, parentCoa, result);
          break;
        case 'running':
          processRunningJob(job, parentTid, parentCoa, result);
          break;
        case 'checkpoint':
          processCheckpoint(job, result);
          break;
      }
    } catch (error) {
      result.errors.push(`Job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

function processNewJob(
  job: Job,
  parentTid: string,
  parentCoa: string,
  result: OrchestratorResult
): void {
  const startedJob = startJob(job.id);

  const worktreeResult = createWorktree(job.id);
  if (!worktreeResult.success && !worktreeResult.error?.includes('already exists')) {
    result.errors.push(`Job ${job.id}: Failed to create worktree: ${worktreeResult.error}`);
    return;
  }

  const { dispatches } = preparePhase(job.id, parentTid, parentCoa);

  for (const dispatch of dispatches) {
    const spawnInfo: WorkerSpawnInfo = {
      worker: dispatch.worker,
      workerTid: dispatch.workerTid,
      dispatchPath: dispatch.dispatchPath,
      model: getWorkerModel(dispatch.worker),
      prompt: buildWorkerPrompt(startedJob, dispatch.worker, dispatch.workerTid, dispatch.dispatchPath),
      background: true
    };
    result.spawned.push(spawnInfo);
  }

  if (isBound(job.id)) {
    const syncOp = getSyncOperation(job.id);
    if (syncOp) {
      result.projectOps.push(syncOp);
    }
  }
}

function processRunningJob(
  job: Job,
  parentTid: string,
  parentCoa: string,
  result: OrchestratorResult
): void {
  const phaseResult = checkPhaseStatus(job.id, parentTid, parentCoa);

  if (phaseResult.status === 'complete' || phaseResult.gateTriggered) {
    const gateDecision = evaluateGate(phaseResult);

    switch (gateDecision.action) {
      case 'proceed':
        approveCheckpoint(job.id);
        const updatedJob = getJob(job.id);
        if (updatedJob && updatedJob.status === 'running') {
          processNewJob(updatedJob, parentTid, parentCoa, result);
        }
        break;

      case 'wait':
        if (gateDecision.notification) {
          result.checkpoints.push({
            jobId: job.id,
            phaseId: phaseResult.phaseId,
            phaseName: gateDecision.notification.phaseName,
            gate: gateDecision.notification.gateType,
            workers: gateDecision.notification.workers.map(w => ({
              worker: w.worker,
              status: w.status,
              summary: w.summary
            })),
            options: gateDecision.notification.options.map(o => `[${o.key}] ${o.label}`)
          });
        }
        break;

      case 'complete':
        result.completed.push(job.id);
        if (isBound(job.id)) {
          const syncOp = getSyncOperation(job.id);
          if (syncOp) {
            result.projectOps.push(syncOp);
          }
        }
        break;

      case 'fail':
        result.errors.push(`Job ${job.id}: Phase failed - ${gateDecision.reason}`);
        break;
    }
  }
}

function processCheckpoint(job: Job, result: OrchestratorResult): void {
  const phase = job.phases.find(p => p.id === job.currentPhase);
  if (!phase) return;

  if (phase.gate === 'auto') {
    approveCheckpoint(job.id);
    return;
  }

  result.checkpoints.push({
    jobId: job.id,
    phaseId: phase.id,
    phaseName: phase.name,
    gate: phase.gate,
    workers: phase.workers.map(w => ({
      worker: w,
      status: 'complete'
    })),
    options: ['[a] Approve', '[r] Reject', '[d] Diff']
  });
}

// ============================================================================
// Terminal Integration
// ============================================================================

export function generateTaskCalls(spawned: WorkerSpawnInfo[]): Array<{
  description: string;
  prompt: string;
  subagent_type: string;
  model: string;
  run_in_background: boolean;
}> {
  return spawned.map(s => ({
    description: `${s.worker} ${s.workerTid.slice(-8)}`,
    prompt: s.prompt,
    subagent_type: 'general-purpose',
    model: s.model,
    run_in_background: s.background
  }));
}

export function formatResult(result: OrchestratorResult): string {
  const lines: string[] = [];

  lines.push('┌─────────────────────────────────────────────────────────────┐');
  lines.push('│  BOTS ORCHESTRATION                                         │');
  lines.push('├─────────────────────────────────────────────────────────────┤');

  if (result.spawned.length > 0) {
    lines.push(`│  Spawning ${result.spawned.length} worker(s):`.padEnd(62) + '│');
    for (const s of result.spawned) {
      lines.push(`│    → ${s.worker} (${s.model})`.padEnd(62) + '│');
    }
  }

  if (result.checkpoints.length > 0) {
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│  Checkpoints awaiting review:'.padEnd(62) + '│');
    for (const c of result.checkpoints) {
      lines.push(`│    ◆ ${c.jobId}: ${c.phaseName} (${c.gate})`.padEnd(62) + '│');
    }
  }

  if (result.completed.length > 0) {
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│  Completed:'.padEnd(62) + '│');
    for (const id of result.completed) {
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
  autoDetectAndSet();
  const action = process.argv[2] || 'run';

  switch (action) {
    case 'run': {
      const result = orchestrate();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'display': {
      const displayResult = orchestrate();
      if ('teamName' in displayResult) {
        console.log(formatTeamResult(displayResult));
      } else {
        console.log(formatResult(displayResult));
      }
      break;
    }

    case 'tasks': {
      const tasksResult = orchestrate();
      if ('tasksCreated' in tasksResult) {
        console.log(JSON.stringify(tasksResult.tasksCreated, null, 2));
      } else {
        const tasks = generateTaskCalls(tasksResult.spawned);
        console.log(JSON.stringify(tasks, null, 2));
      }
      break;
    }

    default:
      console.log('Usage: orchestrator.ts [run|display|tasks]');
  }
}
