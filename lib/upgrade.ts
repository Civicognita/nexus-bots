/**
 * BOTS Upgrade Module
 *
 * Updates an existing BOTS installation from the source repo.
 * Copies lib, workers, schemas, hooks; migrates state; registers hooks.
 *
 * Usage:
 *   npm run tm upgrade <source-path> [--check]
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface UpgradeResult {
  fromVersion: string;
  toVersion: string;
  actions: string[];
  warnings: string[];
  errors: string[];
  counts: { lib: number; workers: number; schemas: number; hooks: number };
}

// ============================================================================
// Helpers
// ============================================================================

const WORKER_DOMAINS = ['code', 'k', 'ux', 'strat', 'comm', 'ops', 'gov', 'data'];

/** Fields in taskmaster.json that are never overwritten during upgrade. */
const PRESERVED_FIELDS = ['wip', 'routing', 'enforced_chains', 'dispatch_rules'];

function copyDir(src: string, dest: string, ext: string): number {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const file of fs.readdirSync(src)) {
    if (!file.endsWith(ext)) continue;
    const srcFile = path.join(src, file);
    if (!fs.statSync(srcFile).isFile()) continue;
    fs.copyFileSync(srcFile, path.join(dest, file));
    count++;
  }
  return count;
}

function countDir(src: string, ext: string): number {
  if (!fs.existsSync(src)) return 0;
  return fs.readdirSync(src).filter(f => f.endsWith(ext)).length;
}

// ============================================================================
// Validation
// ============================================================================

function validateSource(sourcePath: string): string[] {
  const errors: string[] = [];
  if (!fs.existsSync(sourcePath)) {
    errors.push(`Source path does not exist: ${sourcePath}`);
    return errors;
  }
  for (const required of ['lib', 'workers', 'templates/taskmaster.json']) {
    const full = path.join(sourcePath, required);
    if (!fs.existsSync(full)) {
      errors.push(`Missing expected source path: ${required}`);
    }
  }
  return errors;
}

function validateTarget(projectRoot: string): string[] {
  const errors: string[] = [];
  const botsDir = path.join(projectRoot, '.bots');
  if (!fs.existsSync(botsDir)) {
    errors.push('No .bots/ directory found — is BOTS installed here? Run install.sh first.');
  }
  return errors;
}

// ============================================================================
// State Migration
// ============================================================================

function migrateState(existing: Record<string, any>, template: Record<string, any>, toVersion: string): Record<string, any> {
  const migrated = JSON.parse(JSON.stringify(existing));

  // Add any fields from template that are missing, except preserved ones
  for (const key of Object.keys(template)) {
    if (PRESERVED_FIELDS.includes(key)) continue;
    if (!(key in migrated)) {
      migrated[key] = JSON.parse(JSON.stringify(template[key]));
    }
  }

  // Always update version
  migrated.version = toVersion;

  // Additive merge: mode (if absent, use template default)
  if (!('mode' in migrated)) {
    migrated.mode = template.mode || 'subagent';
  }

  // Additive merge: team_config (if absent, use template defaults)
  if (!('team_config' in migrated)) {
    migrated.team_config = JSON.parse(JSON.stringify(template.team_config || {
      team_name: 'bots-team',
      teammate_mode: 'in-process',
      max_teammates: 4,
      require_plan_approval: false
    }));
  }

  return migrated;
}

// ============================================================================
// Hook Registration
// ============================================================================

interface HookEntry {
  hooks: Array<{ type: string; command: string }>;
}

function registerHooks(projectRoot: string, check: boolean): { actions: string[]; warnings: string[] } {
  const actions: string[] = [];
  const warnings: string[] = [];
  const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');

  let settings: Record<string, any>;
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      warnings.push('Could not parse settings.local.json — skipping hook registration');
      return { actions, warnings };
    }
  } else {
    settings = {};
  }

  settings.hooks = settings.hooks || {};

  const hookDefs: Array<{ event: string; script: string }> = [
    { event: 'UserPromptSubmit', script: 'bash scripts/taskmaster-hook.sh' },
    { event: 'TaskCompleted', script: 'bash scripts/team-task-completed.sh' },
    { event: 'TeammateIdle', script: 'bash scripts/team-idle.sh' },
  ];

  for (const { event, script } of hookDefs) {
    settings.hooks[event] = settings.hooks[event] || [];
    const serialized = JSON.stringify(settings.hooks[event]);
    const scriptName = script.split('/').pop()!.replace('.sh', '');
    if (!serialized.includes(scriptName)) {
      const entry: HookEntry = { hooks: [{ type: 'command', command: script }] };
      if (!check) {
        settings.hooks[event].push(entry);
      }
      actions.push(`Registered hook: ${event} → ${script}`);
    }
  }

  // Ensure env vars
  settings.env = settings.env || {};
  if (!settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) {
    if (!check) {
      settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }
    actions.push('Set env: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
  }

  if (!check && actions.length > 0) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return { actions, warnings };
}

// ============================================================================
// CLAUDE.md Update
// ============================================================================

function updateClaudeMd(projectRoot: string, sourcePath: string, check: boolean): string | null {
  const claudeMd = path.join(projectRoot, 'CLAUDE.md');
  const templatePath = path.join(sourcePath, 'templates', 'TASKMASTER.md');

  if (!fs.existsSync(templatePath)) return null;

  if (fs.existsSync(claudeMd)) {
    const content = fs.readFileSync(claudeMd, 'utf-8');
    const template = fs.readFileSync(templatePath, 'utf-8');
    if (content.includes('BOTS') && content.includes('Bolt-On Taskmaster')) {
      // Replace existing BOTS section with latest template
      const botsMatch = content.match(/^(#+)\s+BOTS\b/m);
      if (botsMatch) {
        const botsStart = content.indexOf(botsMatch[0]);
        const level = botsMatch[1].length;
        const pattern = new RegExp(`^#{1,${level}}\\s+(?!BOTS\\b)`, 'm');
        const afterBots = content.substring(botsStart + 1).search(pattern);
        const botsEnd = afterBots === -1 ? content.length : botsStart + 1 + afterBots;
        if (!check) {
          const before = content.substring(0, botsStart);
          const after = content.substring(botsEnd);
          fs.writeFileSync(claudeMd, before + template.trimEnd() + '\n' + after);
        }
        return 'Updated BOTS section in CLAUDE.md';
      }
    }
    if (!check) {
      fs.appendFileSync(claudeMd, '\n' + template);
    }
    return 'Appended BOTS section to CLAUDE.md';
  } else {
    if (!check) {
      fs.copyFileSync(templatePath, claudeMd);
    }
    return 'Created CLAUDE.md with BOTS section';
  }
}

// ============================================================================
// Main Upgrade Function
// ============================================================================

export function upgrade(sourcePath: string, check: boolean = false): UpgradeResult {
  const projectRoot = process.cwd();
  const resolvedSource = path.resolve(sourcePath);

  const result: UpgradeResult = {
    fromVersion: 'unknown',
    toVersion: 'unknown',
    actions: [],
    warnings: [],
    errors: [],
    counts: { lib: 0, workers: 0, schemas: 0, hooks: 0 },
  };

  if (check) {
    result.actions.push('[DRY RUN] No files will be modified');
  }

  // --- Validate ---
  const srcErrors = validateSource(resolvedSource);
  const tgtErrors = validateTarget(projectRoot);
  if (srcErrors.length > 0 || tgtErrors.length > 0) {
    result.errors.push(...srcErrors, ...tgtErrors);
    return result;
  }

  // --- Read versions ---
  const templatePath = path.join(resolvedSource, 'templates', 'taskmaster.json');
  const statePath = path.join(projectRoot, '.bots', 'state', 'taskmaster.json');

  let template: Record<string, any>;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
    result.toVersion = template.version || 'unknown';
  } catch (e) {
    result.errors.push(`Cannot read source template: ${e}`);
    return result;
  }

  let existingState: Record<string, any> | null = null;
  if (fs.existsSync(statePath)) {
    try {
      existingState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      result.fromVersion = (existingState as any).version || 'unknown';
    } catch {
      result.warnings.push('Could not parse existing taskmaster.json — will overwrite with template');
    }
  } else {
    result.fromVersion = 'none';
    result.warnings.push('No existing state file — will create from template');
  }

  // --- Copy lib modules ---
  const libSrc = path.join(resolvedSource, 'lib');
  const libDest = path.join(projectRoot, '.bots', 'lib');
  const integSrc = path.join(resolvedSource, 'lib', 'integrations');
  const integDest = path.join(projectRoot, '.bots', 'lib', 'integrations');

  if (check) {
    result.counts.lib = countDir(libSrc, '.ts') + countDir(integSrc, '.ts');
    result.actions.push(`Would copy ${result.counts.lib} lib modules + tsconfig`);
  } else {
    result.counts.lib = copyDir(libSrc, libDest, '.ts');
    result.counts.lib += copyDir(integSrc, integDest, '.ts');
    // Copy tsconfig for type-checking support
    const tsconfigSrc = path.join(resolvedSource, 'tsconfig.json');
    if (fs.existsSync(tsconfigSrc)) {
      fs.copyFileSync(tsconfigSrc, path.join(projectRoot, '.bots', 'tsconfig.json'));
    }
    result.actions.push(`Copied ${result.counts.lib} lib modules + tsconfig`);
  }

  // --- Copy schemas ---
  const schemasSrc = path.join(resolvedSource, 'schemas');
  const schemasDest = path.join(projectRoot, '.bots', 'schemas');

  if (check) {
    result.counts.schemas = countDir(schemasSrc, '.json');
    result.actions.push(`Would copy ${result.counts.schemas} schemas`);
  } else {
    result.counts.schemas = copyDir(schemasSrc, schemasDest, '.json');
    result.actions.push(`Copied ${result.counts.schemas} schemas`);
  }

  // --- Copy workers ---
  const workersSrc = path.join(resolvedSource, 'workers');
  const workersDest = path.join(projectRoot, '.claude', 'agents', 'workers');
  let workerCount = 0;

  // Root-level workers
  if (check) {
    workerCount += countDir(workersSrc, '.md');
  } else {
    fs.mkdirSync(workersDest, { recursive: true });
    workerCount += copyDir(workersSrc, workersDest, '.md');
  }

  // Domain workers
  for (const domain of WORKER_DOMAINS) {
    const domainSrc = path.join(workersSrc, domain);
    const domainDest = path.join(workersDest, domain);
    if (check) {
      workerCount += countDir(domainSrc, '.md');
    } else {
      workerCount += copyDir(domainSrc, domainDest, '.md');
    }
  }

  // Worker base template → prompts
  const baseSrc = path.join(workersSrc, 'base.md');
  const baseDest = path.join(projectRoot, '.claude', 'prompts', 'worker-base.md');
  if (fs.existsSync(baseSrc)) {
    if (!check) {
      fs.mkdirSync(path.dirname(baseDest), { recursive: true });
      fs.copyFileSync(baseSrc, baseDest);
    }
    result.actions.push('Copied worker-base.md to .claude/prompts/');
  }

  result.counts.workers = workerCount;
  result.actions.push(`${check ? 'Would copy' : 'Copied'} ${workerCount} worker definitions`);

  // --- Copy hooks ---
  const hooksSrc = path.join(resolvedSource, 'hooks');
  const hooksDest = path.join(projectRoot, 'scripts');
  if (check) {
    result.counts.hooks = countDir(hooksSrc, '.sh');
    result.actions.push(`Would copy ${result.counts.hooks} hook scripts`);
  } else {
    result.counts.hooks = copyDir(hooksSrc, hooksDest, '.sh');
    result.actions.push(`Copied ${result.counts.hooks} hook scripts`);
  }

  // --- Migrate state ---
  if (existingState) {
    const migrated = migrateState(existingState, template, result.toVersion);
    if (!check) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(migrated, null, 2) + '\n');
    }
    result.actions.push(`${check ? 'Would migrate' : 'Migrated'} state: ${result.fromVersion} → ${result.toVersion}`);
  } else {
    if (!check) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.copyFileSync(templatePath, statePath);
    }
    result.actions.push(`${check ? 'Would create' : 'Created'} state from template (${result.toVersion})`);
  }

  // --- Register hooks ---
  const hookResult = registerHooks(projectRoot, check);
  result.actions.push(...hookResult.actions);
  result.warnings.push(...hookResult.warnings);

  // --- Update CLAUDE.md ---
  const claudeAction = updateClaudeMd(projectRoot, resolvedSource, check);
  if (claudeAction) {
    result.actions.push((check ? 'Would: ' : '') + claudeAction);
  }

  return result;
}
