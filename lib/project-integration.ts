/**
 * BOTS Project Integration
 *
 * Pluggable interface for binding WORK{JOB}s to external project management.
 * Default: no-op (BOTS works standalone without any PM tool).
 *
 * To integrate with a PM tool (e.g., Tynn, Linear, Jira),
 * implement the ProjectIntegration interface and call setIntegration().
 */

import { JobStatus } from './job-manager.js';

// ============================================================================
// Types
// ============================================================================

export interface ProjectBinding {
  task_id?: string;
  task_number?: number;
  story_id?: string;
  story_number?: number;
  bound_at: string;
  last_synced?: string;
  sync_history: SyncEvent[];
}

export interface SyncEvent {
  timestamp: string;
  job_status: JobStatus;
  action: string;
  success: boolean;
  error?: string;
}

export interface SyncOperation {
  tool: string;
  params: Record<string, any>;
}

// ============================================================================
// Integration Interface
// ============================================================================

export interface ProjectIntegration {
  /** Check if a job is bound to a project task */
  isBound(jobId: string, configPath?: string): boolean;

  /** Bind a job to a project task */
  bindJob(
    jobId: string,
    refs: { task_id?: string; story_id?: string; version_id?: string },
    configPath?: string
  ): ProjectBinding | null;

  /** Get the sync operation for current job status */
  getSyncOperation(jobId: string, configPath?: string): SyncOperation | null;

  /** Get a comment operation for phase completion */
  getPhaseCommentOperation(
    jobId: string,
    phaseId: string,
    phaseName: string,
    workers: string[],
    configPath?: string
  ): SyncOperation | null;

  /** Record a sync event in the binding history */
  recordSyncEvent(jobId: string, event: Omit<SyncEvent, 'timestamp'>, configPath?: string): void;

  /** Get all pending sync operations */
  getPendingSyncs(configPath?: string): Array<{ jobId: string; operation: SyncOperation }>;

  /** Parse project references from queue text (e.g., #T123, @task:ULID) */
  parseReferences(queueText: string): {
    task_id?: string;
    task_number?: number;
    story_id?: string;
    story_number?: number;
  };
}

// ============================================================================
// No-Op Default (Standalone Mode)
// ============================================================================

class NoOpIntegration implements ProjectIntegration {
  isBound(): boolean {
    return false;
  }

  bindJob(): ProjectBinding | null {
    return null;
  }

  getSyncOperation(): SyncOperation | null {
    return null;
  }

  getPhaseCommentOperation(): SyncOperation | null {
    return null;
  }

  recordSyncEvent(): void {
    // No-op
  }

  getPendingSyncs(): Array<{ jobId: string; operation: SyncOperation }> {
    return [];
  }

  parseReferences(): {
    task_id?: string;
    task_number?: number;
    story_id?: string;
    story_number?: number;
  } {
    return {};
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let integration: ProjectIntegration = new NoOpIntegration();

/**
 * Set a custom project integration.
 * Call this during initialization to connect BOTS to your PM tool.
 *
 * @example
 * ```ts
 * import { setIntegration } from '.bots/lib/project-integration.js';
 * import { TynnIntegration } from './my-tynn-adapter.js';
 * setIntegration(new TynnIntegration());
 * ```
 */
export function setIntegration(impl: ProjectIntegration): void {
  integration = impl;
}

/**
 * Get the current project integration instance.
 */
export function getIntegration(): ProjectIntegration {
  return integration;
}

// Convenience re-exports that delegate to the current integration
export function isBound(jobId: string, configPath?: string): boolean {
  return integration.isBound(jobId, configPath);
}

export function bindJob(
  jobId: string,
  refs: { task_id?: string; story_id?: string; version_id?: string },
  configPath?: string
): ProjectBinding | null {
  return integration.bindJob(jobId, refs, configPath);
}

export function getSyncOperation(jobId: string, configPath?: string): SyncOperation | null {
  return integration.getSyncOperation(jobId, configPath);
}

export function getPhaseCommentOperation(
  jobId: string,
  phaseId: string,
  phaseName: string,
  workers: string[],
  configPath?: string
): SyncOperation | null {
  return integration.getPhaseCommentOperation(jobId, phaseId, phaseName, workers, configPath);
}

export function recordSyncEvent(
  jobId: string,
  event: Omit<SyncEvent, 'timestamp'>,
  configPath?: string
): void {
  integration.recordSyncEvent(jobId, event, configPath);
}

export function getPendingSyncs(
  configPath?: string
): Array<{ jobId: string; operation: SyncOperation }> {
  return integration.getPendingSyncs(configPath);
}

export function parseReferences(queueText: string): {
  task_id?: string;
  task_number?: number;
  story_id?: string;
  story_number?: number;
} {
  return integration.parseReferences(queueText);
}
