/**
 * BOTS Job Lifecycle Manager
 *
 * Manages WORK{JOB} creation, state transitions, and phase execution.
 * Each job runs in an isolated worktree.
 */

import * as fs from 'fs';
import * as path from 'path';
import { findRoute, RouteMatch } from './router.js';
import { getStatePath } from './integrations/detect.js';

// Forward declaration - project-integration imports job-manager, so we lazy-load
let projectIntegration: typeof import('./project-integration.js') | null = null;
function getProjectIntegration() {
  if (!projectIntegration) {
    try {
      projectIntegration = require('./project-integration.js');
    } catch {
      // Project integration not available
    }
  }
  return projectIntegration;
}

// ============================================================================
// Types
// ============================================================================

export type JobStatus = 'pending' | 'running' | 'checkpoint' | 'complete' | 'failed';
export type PhaseStatus = 'pending' | 'running' | 'complete' | 'failed';
export type GateType = 'auto' | 'checkpoint' | 'terminal';

export interface JobPhase {
  id: string;
  name: string;
  workers: string[];
  gate: GateType;
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  handoffs?: string[];  // Worker TIDs that completed this phase
}

export interface ProjectBinding {
  task_id?: string;
  task_number?: number;
  story_id?: string;
  story_number?: number;
  bound_at: string;
  last_synced?: string;
  sync_history: Array<{
    timestamp: string;
    job_status: JobStatus;
    action: string;
    success: boolean;
    error?: string;
  }>;
}

export interface JobTeamBinding {
  teamName: string;
  taskIds: Record<string, string>;       // workerTid → team task ID
  phaseTaskGroups: Record<string, string[]>; // phaseId → task IDs
}

export interface Job {
  id: string;
  queueText: string;
  route: string | null;
  entryWorker: string;
  worktree: string;
  branch: string;
  phases: JobPhase[];
  currentPhase: string | null;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  project?: ProjectBinding;
  team?: JobTeamBinding;
}

export type ExecutionMode = 'subagent' | 'team';

export interface TeamConfig {
  team_name: string;
  teammate_mode: 'in-process' | 'tmux';
  max_teammates: number;
  require_plan_approval: boolean;
}

export interface TaskmasterState {
  version: string;
  mode?: ExecutionMode;
  team_config?: TeamConfig;
  wip: {
    jobs: Record<string, Job>;
    next_frame: string | null;
    job_counter: number;
  };
}

// ============================================================================
// State Management
// ============================================================================

function getDefaultConfigPath(): string {
  return getStatePath('taskmaster.json');
}

/**
 * Load taskmaster state
 */
export function loadState(configPath?: string): TaskmasterState {
  const filePath = configPath || getDefaultConfigPath();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load taskmaster state from ${filePath}: ${error}`);
  }
}

/**
 * Save taskmaster state
 */
export function saveState(state: TaskmasterState, configPath?: string): void {
  const filePath = configPath || getDefaultConfigPath();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Load enforced chains from config
 */
export function loadEnforcedChains(configPath?: string): Record<string, string> {
  const state = loadState(configPath);
  return (state as any).enforced_chains || {};
}

// ============================================================================
// Job Lifecycle
// ============================================================================

/**
 * Generate a new job ID
 */
export function generateJobId(state: TaskmasterState): string {
  const counter = state.wip.job_counter + 1;
  return `job-${String(counter).padStart(3, '0')}`;
}

/**
 * Create a new job from queue text
 *
 * If a project integration is configured, automatically parses references
 * from queue text (e.g., #T123, @task:ULID).
 */
export function createJob(
  queueText: string,
  configPath?: string
): Job {
  const state = loadState(configPath);
  const route = findRoute(queueText, configPath);

  const jobId = generateJobId(state);
  state.wip.job_counter++;

  const job: Job = {
    id: jobId,
    queueText,
    route: route?.route || null,
    entryWorker: route?.entry || '$W.k.analyst',
    worktree: `.worktrees/${jobId}`,
    branch: `work/${jobId}`,
    phases: [],  // Populated by entry worker's spec
    currentPhase: null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  // Auto-parse project references from queue text
  const pi = getProjectIntegration();
  if (pi) {
    const refs = pi.parseReferences(queueText);
    if (refs.task_id || refs.task_number || refs.story_id || refs.story_number) {
      job.project = {
        task_id: refs.task_id,
        task_number: refs.task_number,
        story_id: refs.story_id,
        story_number: refs.story_number,
        bound_at: new Date().toISOString(),
        sync_history: []
      };
    }
  }

  // Create initial phase for entry worker
  job.phases.push({
    id: 'P0',
    name: 'entry',
    workers: [job.entryWorker],
    gate: job.entryWorker.includes('.engineer') ? 'auto' : 'checkpoint',
    status: 'pending'
  });
  job.currentPhase = 'P0';

  state.wip.jobs[jobId] = job;
  saveState(state, configPath);

  return job;
}

/**
 * Start a job (create worktree, begin first phase)
 */
export function startJob(
  jobId: string,
  configPath?: string
): Job {
  const state = loadState(configPath);
  const job = state.wip.jobs[jobId];

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (job.status !== 'pending') {
    throw new Error(`Job ${jobId} is not pending (status: ${job.status})`);
  }

  job.status = 'running';
  job.startedAt = new Date().toISOString();

  // Mark first phase as running
  if (job.phases.length > 0) {
    job.phases[0].status = 'running';
    job.phases[0].startedAt = new Date().toISOString();
  }

  saveState(state, configPath);
  return job;
}

/**
 * Update job with phases from entry worker's spec
 */
export function setJobPhases(
  jobId: string,
  phases: Omit<JobPhase, 'status' | 'startedAt' | 'completedAt' | 'handoffs'>[],
  configPath?: string
): Job {
  const state = loadState(configPath);
  const job = state.wip.jobs[jobId];

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Replace phases (keeping P0 entry phase as complete)
  const entryPhase = job.phases[0];
  if (entryPhase) {
    entryPhase.status = 'complete';
    entryPhase.completedAt = new Date().toISOString();
  }

  job.phases = [
    entryPhase,
    ...phases.map((p, i) => ({
      ...p,
      id: p.id || `P${i + 1}`,
      status: 'pending' as PhaseStatus
    }))
  ].filter(Boolean) as JobPhase[];

  // Set current phase to first non-complete phase
  const nextPhase = job.phases.find(p => p.status === 'pending');
  job.currentPhase = nextPhase?.id || null;

  saveState(state, configPath);
  return job;
}

/**
 * Complete a phase and advance to next (or trigger gate)
 */
export function completePhase(
  jobId: string,
  phaseId: string,
  workerTid: string,
  configPath?: string
): { job: Job; gateTriggered: GateType | null; nextPhase: JobPhase | null } {
  const state = loadState(configPath);
  const job = state.wip.jobs[jobId];

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  const phase = job.phases.find(p => p.id === phaseId);
  if (!phase) {
    throw new Error(`Phase ${phaseId} not found in job ${jobId}`);
  }

  // Record handoff
  phase.handoffs = phase.handoffs || [];
  phase.handoffs.push(workerTid);

  // Check if all workers in phase are done
  const allWorkersDone = phase.handoffs.length >= phase.workers.length;

  if (allWorkersDone) {
    phase.status = 'complete';
    phase.completedAt = new Date().toISOString();

    // Find next phase
    const phaseIndex = job.phases.findIndex(p => p.id === phaseId);
    const nextPhase = job.phases[phaseIndex + 1];

    if (nextPhase) {
      // Check gate type
      if (phase.gate === 'checkpoint') {
        job.status = 'checkpoint';
        return { job, gateTriggered: 'checkpoint', nextPhase };
      } else if (phase.gate === 'terminal') {
        job.status = 'checkpoint';
        return { job, gateTriggered: 'terminal', nextPhase };
      } else {
        // Auto gate - proceed to next phase
        nextPhase.status = 'running';
        nextPhase.startedAt = new Date().toISOString();
        job.currentPhase = nextPhase.id;
        saveState(state, configPath);
        return { job, gateTriggered: null, nextPhase };
      }
    } else {
      // No more phases - job complete
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
      job.currentPhase = null;
      saveState(state, configPath);
      return { job, gateTriggered: 'terminal', nextPhase: null };
    }
  }

  saveState(state, configPath);
  return { job, gateTriggered: null, nextPhase: null };
}

/**
 * Approve checkpoint and continue to next phase
 */
export function approveCheckpoint(
  jobId: string,
  configPath?: string
): Job {
  const state = loadState(configPath);
  const job = state.wip.jobs[jobId];

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (job.status !== 'checkpoint') {
    throw new Error(`Job ${jobId} is not at checkpoint (status: ${job.status})`);
  }

  // Find next pending phase
  const nextPhase = job.phases.find(p => p.status === 'pending');

  if (nextPhase) {
    nextPhase.status = 'running';
    nextPhase.startedAt = new Date().toISOString();
    job.currentPhase = nextPhase.id;
    job.status = 'running';
  } else {
    job.status = 'complete';
    job.completedAt = new Date().toISOString();
  }

  saveState(state, configPath);
  return job;
}

/**
 * Reject checkpoint and fail the job
 */
export function rejectCheckpoint(
  jobId: string,
  reason: string,
  configPath?: string
): Job {
  const state = loadState(configPath);
  const job = state.wip.jobs[jobId];

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  job.status = 'failed';
  job.error = reason;
  job.completedAt = new Date().toISOString();

  saveState(state, configPath);
  return job;
}

/**
 * Get the next worker in an enforced chain (if any)
 */
export function getChainedWorker(
  worker: string,
  configPath?: string
): string | null {
  const chains = loadEnforcedChains(configPath);

  // Check exact match
  if (chains[worker]) {
    return chains[worker];
  }

  // Check wildcard patterns (e.g., $W.comm.writer.*)
  for (const [pattern, target] of Object.entries(chains)) {
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      if (worker.startsWith(prefix)) {
        return target;
      }
    }
  }

  return null;
}

/**
 * Get all active jobs
 */
export function getActiveJobs(configPath?: string): Job[] {
  const state = loadState(configPath);
  return Object.values(state.wip.jobs).filter(
    job => job.status === 'pending' || job.status === 'running' || job.status === 'checkpoint'
  );
}

/**
 * Get job by ID
 */
export function getJob(jobId: string, configPath?: string): Job | null {
  const state = loadState(configPath);
  return state.wip.jobs[jobId] || null;
}

/**
 * Set next frame content
 */
export function setNextFrame(
  content: string,
  configPath?: string
): void {
  const state = loadState(configPath);
  state.wip.next_frame = content;
  saveState(state, configPath);
}

/**
 * Get and clear next frame
 */
export function popNextFrame(configPath?: string): string | null {
  const state = loadState(configPath);
  const next = state.wip.next_frame;
  state.wip.next_frame = null;
  saveState(state, configPath);
  return next;
}

// CLI support
if (typeof require !== 'undefined' && require.main === module) {
  const action = process.argv[2];
  const arg = process.argv[3];

  switch (action) {
    case 'create':
      console.log(JSON.stringify(createJob(arg || 'test job'), null, 2));
      break;
    case 'list':
      console.log(JSON.stringify(getActiveJobs(), null, 2));
      break;
    case 'get':
      console.log(JSON.stringify(getJob(arg || ''), null, 2));
      break;
    default:
      console.log('Usage: job-manager.ts <create|list|get> [arg]');
  }
}
