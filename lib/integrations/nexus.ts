/**
 * BOTS Nexus Integration
 *
 * Extends TynnIntegration with Nexus-specific features:
 * - State files at .ai/.nexus/ instead of .bots/state/
 * - COA chain tracking (Worker COA extension)
 * - BAIF state awareness (gates remote ops when not ONLINE)
 * - Worker registration in .ai/.nexus/workers.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { TynnIntegration } from './tynn.js';
import { ProjectBinding, SyncOperation } from '../project-integration.js';
import { loadState, saveState } from '../job-manager.js';

// ============================================================================
// Types
// ============================================================================

type BaifState = 'ONLINE' | 'LIMBO' | 'OFFLINE' | 'UNKNOWN';

interface NexusEnv {
  STATION?: string;
  AGENT?: string;
  STATE?: BaifState;
  FOCUS?: string;
}

// ============================================================================
// NexusIntegration
// ============================================================================

export class NexusIntegration extends TynnIntegration {
  private envCache: NexusEnv | null = null;

  /**
   * Get the Nexus state directory path.
   * Nexus stores state in .ai/.nexus/ instead of .bots/state/.
   */
  getStatePath(filename: string): string {
    return path.join(process.cwd(), '.ai', '.nexus', filename);
  }

  /**
   * Read BAIF state from .ai/.env
   */
  getState(): BaifState {
    if (this.envCache?.STATE) return this.envCache.STATE;

    const env = this.loadNexusEnv();
    return env.STATE || 'UNKNOWN';
  }

  /**
   * Parse .ai/.env for BAIF variables
   */
  private loadNexusEnv(): NexusEnv {
    if (this.envCache) return this.envCache;

    const envPath = path.join(process.cwd(), '.ai', '.env');
    const env: NexusEnv = {};

    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (key === 'STATION') env.STATION = value;
        if (key === 'AGENT') env.AGENT = value;
        if (key === 'STATE') env.STATE = value as BaifState;
        if (key === 'FOCUS') env.FOCUS = value;
      }
    } catch {
      // .ai/.env not found — default to UNKNOWN
    }

    this.envCache = env;
    return env;
  }

  /**
   * Override bindJob to add COA metadata for Nexus.
   */
  override bindJob(
    jobId: string,
    refs: { task_id?: string; story_id?: string; version_id?: string },
    configPath?: string
  ): ProjectBinding | null {
    const binding = super.bindJob(jobId, refs, configPath);
    if (!binding) return null;

    // Inject COA metadata into the binding's sync_history context
    const env = this.loadNexusEnv();
    if (env.AGENT && env.STATION) {
      const state = loadState(configPath);
      const job = state.wip.jobs[jobId];
      if (job?.project) {
        // Store COA context alongside the binding
        (job.project as any).coa = {
          station: env.STATION,
          agent: env.AGENT,
          state: env.STATE
        };
        saveState(state, configPath);
      }
    }

    return binding;
  }

  /**
   * Override getSyncOperation to gate on BAIF state.
   * Remote operations only allowed when STATE=ONLINE.
   */
  override getSyncOperation(jobId: string, configPath?: string): SyncOperation | null {
    const state = this.getState();
    if (state !== 'ONLINE') {
      // Not online — skip remote sync
      return null;
    }
    return super.getSyncOperation(jobId, configPath);
  }

  /**
   * Override getPhaseCommentOperation with same state gating.
   */
  override getPhaseCommentOperation(
    jobId: string,
    phaseId: string,
    phaseName: string,
    workers: string[],
    configPath?: string
  ): SyncOperation | null {
    const state = this.getState();
    if (state !== 'ONLINE') return null;
    return super.getPhaseCommentOperation(jobId, phaseId, phaseName, workers, configPath);
  }
}
