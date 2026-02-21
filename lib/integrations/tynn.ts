/**
 * BOTS Tynn Integration
 *
 * Implements ProjectIntegration for Tynn MCP.
 * Syncs WORK{JOB} lifecycle with Tynn task status transitions.
 *
 * Status mapping:
 *   running    -> mcp__tynn__starting (task)
 *   checkpoint -> mcp__tynn__testing  (task)
 *   complete   -> mcp__tynn__finished (task)
 *   failed     -> mcp__tynn__block    (task, reason)
 */

import {
  ProjectIntegration,
  ProjectBinding,
  SyncEvent,
  SyncOperation
} from '../project-integration.js';
import { JobStatus, loadState, saveState, getJob } from '../job-manager.js';

// ============================================================================
// Types
// ============================================================================

interface TynnStatusMapping {
  job_status: JobStatus;
  tynn_action: 'starting' | 'testing' | 'finished' | 'block';
  tynn_target: 'task' | 'story';
}

const STATUS_MAPPINGS: TynnStatusMapping[] = [
  { job_status: 'running', tynn_action: 'starting', tynn_target: 'task' },
  { job_status: 'checkpoint', tynn_action: 'testing', tynn_target: 'task' },
  { job_status: 'complete', tynn_action: 'finished', tynn_target: 'task' },
  { job_status: 'failed', tynn_action: 'block', tynn_target: 'task' }
];

// ============================================================================
// TynnIntegration
// ============================================================================

export class TynnIntegration implements ProjectIntegration {
  isBound(jobId: string, configPath?: string): boolean {
    const job = getJob(jobId, configPath);
    if (!job || !job.project) return false;
    return !!(job.project.task_id || job.project.story_id);
  }

  bindJob(
    jobId: string,
    refs: { task_id?: string; story_id?: string; version_id?: string },
    configPath?: string
  ): ProjectBinding | null {
    const state = loadState(configPath);
    const job = state.wip.jobs[jobId];
    if (!job) return null;

    const binding: ProjectBinding = {
      task_id: refs.task_id,
      story_id: refs.story_id,
      bound_at: new Date().toISOString(),
      sync_history: []
    };

    job.project = binding;
    saveState(state, configPath);
    return binding;
  }

  getSyncOperation(jobId: string, configPath?: string): SyncOperation | null {
    const job = getJob(jobId, configPath);
    if (!job || !job.project?.task_id) return null;

    const mapping = STATUS_MAPPINGS.find(m => m.job_status === job.status);
    if (!mapping) return null;

    switch (mapping.tynn_action) {
      case 'starting':
        return {
          tool: 'mcp__tynn__starting',
          params: {
            a: mapping.tynn_target,
            id: job.project.task_id
          }
        };

      case 'testing':
        return {
          tool: 'mcp__tynn__testing',
          params: {
            a: mapping.tynn_target,
            id: job.project.task_id,
            note: `BOTS checkpoint: ${job.currentPhase || 'phase complete'}`
          }
        };

      case 'finished':
        return {
          tool: 'mcp__tynn__finished',
          params: {
            a: mapping.tynn_target,
            id: job.project.task_id,
            note: `BOTS: Job ${jobId} complete`
          }
        };

      case 'block':
        return {
          tool: 'mcp__tynn__block',
          params: {
            a: mapping.tynn_target,
            id: job.project.task_id,
            reason: job.error || `BOTS: Job ${jobId} failed`
          }
        };

      default:
        return null;
    }
  }

  getPhaseCommentOperation(
    jobId: string,
    phaseId: string,
    phaseName: string,
    workers: string[],
    configPath?: string
  ): SyncOperation | null {
    const job = getJob(jobId, configPath);
    if (!job?.project?.task_id) return null;

    const comment = [
      `**BOTS Phase Complete:** ${phaseName}`,
      `- Phase ID: ${phaseId}`,
      `- Workers: ${workers.join(', ')}`,
      `- Job: ${jobId}`
    ].join('\n');

    return {
      tool: 'mcp__tynn__create',
      params: {
        a: 'comment',
        on: { type: 'task', id: job.project.task_id },
        because: comment
      }
    };
  }

  recordSyncEvent(
    jobId: string,
    event: Omit<SyncEvent, 'timestamp'>,
    configPath?: string
  ): void {
    const state = loadState(configPath);
    const job = state.wip.jobs[jobId];
    if (!job?.project) return;

    job.project.sync_history.push({
      ...event,
      timestamp: new Date().toISOString()
    });
    job.project.last_synced = new Date().toISOString();
    saveState(state, configPath);
  }

  getPendingSyncs(configPath?: string): Array<{ jobId: string; operation: SyncOperation }> {
    const state = loadState(configPath);
    const results: Array<{ jobId: string; operation: SyncOperation }> = [];

    for (const [jobId, job] of Object.entries(state.wip.jobs)) {
      if (!job.project?.task_id) continue;

      // Check if already synced for current status
      const lastSync = job.project.sync_history[job.project.sync_history.length - 1];
      if (lastSync && lastSync.job_status === job.status && lastSync.success) {
        continue;
      }

      const operation = this.getSyncOperation(jobId, configPath);
      if (operation) {
        results.push({ jobId, operation });
      }
    }

    return results;
  }

  parseReferences(queueText: string): {
    task_id?: string;
    task_number?: number;
    story_id?: string;
    story_number?: number;
  } {
    const result: {
      task_id?: string;
      task_number?: number;
      story_id?: string;
      story_number?: number;
    } = {};

    // Match #T123 or T123 (task number)
    const taskNumMatch = queueText.match(/#?T(\d+)/i);
    if (taskNumMatch) {
      result.task_number = parseInt(taskNumMatch[1], 10);
    }

    // Match #S45 or S45 (story number)
    const storyNumMatch = queueText.match(/#?S(\d+)/i);
    if (storyNumMatch) {
      result.story_number = parseInt(storyNumMatch[1], 10);
    }

    // Match @task:ULID
    const taskIdMatch = queueText.match(/@task:([A-Z0-9]+)/i);
    if (taskIdMatch) {
      result.task_id = taskIdMatch[1];
    }

    // Match @story:ULID
    const storyIdMatch = queueText.match(/@story:([A-Z0-9]+)/i);
    if (storyIdMatch) {
      result.story_id = storyIdMatch[1];
    }

    return result;
  }
}
