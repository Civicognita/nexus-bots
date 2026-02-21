/**
 * BOTS Integration Auto-Detection
 *
 * Probes the project environment and returns the appropriate integration:
 *   1. Nexus — .nexus/core/GOSPEL.md exists AND .ai/.nexus/ directory exists
 *   2. Tynn  — .claude/settings.local.json has "tynn" in mcpServers
 *   3. NoOp  — Neither detected (standalone mode)
 *
 * Also provides getStatePath() for path resolution based on active integration.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectIntegration, getIntegration, setIntegration } from '../project-integration.js';
import { TynnIntegration } from './tynn.js';
import { NexusIntegration } from './nexus.js';

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if the current project is a Nexus repository.
 * Requires both PRIME core and .ai/.nexus/ directory.
 */
function isNexusProject(cwd: string): boolean {
  const gospelPath = path.join(cwd, '.nexus', 'core', 'GOSPEL.md');
  const aiNexusDir = path.join(cwd, '.ai', '.nexus');
  return fs.existsSync(gospelPath) && fs.existsSync(aiNexusDir);
}

/**
 * Check if the project has Tynn MCP configured.
 * Looks for "tynn" in Claude settings mcpServers.
 */
function hasTynnMcp(cwd: string): boolean {
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);
    // Check enabledMcpjsonServers array for tynn
    if (Array.isArray(settings.enabledMcpjsonServers)) {
      return settings.enabledMcpjsonServers.some(
        (s: string) => s.toLowerCase().includes('tynn')
      );
    }
    // Check mcpServers object for tynn key
    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      return Object.keys(settings.mcpServers).some(
        k => k.toLowerCase().includes('tynn')
      );
    }
    return false;
  } catch {
    return false;
  }
}

export type DetectedIntegration = 'nexus' | 'tynn' | 'noop';

/**
 * Detect which integration to use based on project environment.
 *
 * Priority: Nexus > Tynn > NoOp
 *   - Nexus includes Tynn, so it takes priority when both signals present
 */
export function detectIntegration(cwd?: string): { type: DetectedIntegration; integration: ProjectIntegration } {
  const dir = cwd || process.cwd();

  // Priority 1: Nexus (has PRIME core + .ai/.nexus/)
  if (isNexusProject(dir)) {
    return { type: 'nexus', integration: new NexusIntegration() };
  }

  // Priority 2: Tynn MCP (has tynn in settings)
  if (hasTynnMcp(dir)) {
    return { type: 'tynn', integration: new TynnIntegration() };
  }

  // Default: standalone (keep existing NoOp)
  return { type: 'noop', integration: getIntegration() };
}

/**
 * Run detection and set the integration singleton.
 * Returns the detected type for logging/display.
 */
export function autoDetectAndSet(cwd?: string): DetectedIntegration {
  const { type, integration } = detectIntegration(cwd);
  if (type !== 'noop') {
    setIntegration(integration);
  }
  return type;
}

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve a state file path based on the active integration.
 *
 * - NexusIntegration: .ai/.nexus/<filename>
 * - Default:          .bots/state/<filename>
 */
export function getStatePath(filename: string): string {
  const integration = getIntegration();
  if (integration instanceof NexusIntegration) {
    return integration.getStatePath(filename);
  }
  return path.join(process.cwd(), '.bots', 'state', filename);
}
