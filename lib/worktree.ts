/**
 * BOTS Worktree Utilities
 *
 * Manages git worktree creation and cleanup for WORK{JOB} isolation.
 * Each job gets its own worktree and branch.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  exists: boolean;
}

export interface WorktreeCreateResult {
  success: boolean;
  worktree: string;
  branch: string;
  error?: string;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get the repository root directory
 */
export function getRepoRoot(): string {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Ensure .worktrees directory exists
 */
export function ensureWorktreesDir(): string {
  const repoRoot = getRepoRoot();
  const worktreesDir = path.join(repoRoot, '.worktrees');

  if (!fs.existsSync(worktreesDir)) {
    fs.mkdirSync(worktreesDir, { recursive: true });

    // Add to .gitignore if not already there
    const gitignorePath = path.join(repoRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.worktrees')) {
        fs.appendFileSync(gitignorePath, '\n# BOTS job worktrees\n.worktrees/\n');
      }
    }
  }

  return worktreesDir;
}

/**
 * Create a worktree for a job
 *
 * @param jobId - The job identifier (e.g., "job-001")
 * @param baseBranch - Branch to base the worktree on (default: "main")
 */
export function createWorktree(
  jobId: string,
  baseBranch: string = 'main'
): WorktreeCreateResult {
  const repoRoot = getRepoRoot();
  ensureWorktreesDir();

  const worktreePath = path.join(repoRoot, '.worktrees', jobId);
  const branchName = `work/${jobId}`;

  // Check if worktree already exists
  if (fs.existsSync(worktreePath)) {
    return {
      success: true,
      worktree: worktreePath,
      branch: branchName,
      error: 'Worktree already exists'
    };
  }

  try {
    // Create worktree with new branch
    execSync(
      `git worktree add "${worktreePath}" -b "${branchName}" "${baseBranch}"`,
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    return {
      success: true,
      worktree: worktreePath,
      branch: branchName
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      worktree: worktreePath,
      branch: branchName,
      error: message
    };
  }
}

/**
 * Remove a worktree for a job
 */
export function removeWorktree(jobId: string, force: boolean = false): boolean {
  const repoRoot = getRepoRoot();
  const worktreePath = path.join(repoRoot, '.worktrees', jobId);

  if (!fs.existsSync(worktreePath)) {
    return true;
  }

  try {
    const forceFlag = force ? '--force' : '';
    execSync(
      `git worktree remove "${worktreePath}" ${forceFlag}`,
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Get information about a worktree
 */
export function getWorktreeInfo(jobId: string): WorktreeInfo | null {
  const repoRoot = getRepoRoot();
  const worktreePath = path.join(repoRoot, '.worktrees', jobId);

  if (!fs.existsSync(worktreePath)) {
    return null;
  }

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const commit = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    return { path: worktreePath, branch, commit, exists: true };
  } catch {
    return {
      path: worktreePath,
      branch: `work/${jobId}`,
      commit: '',
      exists: true
    };
  }
}

/**
 * List all job worktrees
 */
export function listWorktrees(): WorktreeInfo[] {
  const repoRoot = getRepoRoot();
  const worktreesDir = path.join(repoRoot, '.worktrees');

  if (!fs.existsSync(worktreesDir)) {
    return [];
  }

  const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  const worktrees: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('job-')) {
      const info = getWorktreeInfo(entry.name);
      if (info) {
        worktrees.push(info);
      }
    }
  }

  return worktrees;
}

/**
 * Merge a job's worktree branch back to target branch
 */
export function mergeWorktree(
  jobId: string,
  targetBranch: string = 'main'
): { success: boolean; error?: string } {
  const repoRoot = getRepoRoot();
  const branchName = `work/${jobId}`;

  try {
    execSync(`git checkout "${targetBranch}"`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    execSync(`git merge "${branchName}" --no-ff -m "Merge ${jobId}: completed work"`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Delete the job branch after merge
 */
export function deleteJobBranch(jobId: string): boolean {
  const repoRoot = getRepoRoot();
  const branchName = `work/${jobId}`;

  try {
    execSync(`git branch -d "${branchName}"`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Full cleanup: merge, remove worktree, delete branch
 */
export function cleanupJob(
  jobId: string,
  targetBranch: string = 'main'
): { success: boolean; steps: string[]; error?: string } {
  const steps: string[] = [];

  const mergeResult = mergeWorktree(jobId, targetBranch);
  if (!mergeResult.success) {
    return { success: false, steps, error: `Merge failed: ${mergeResult.error}` };
  }
  steps.push(`Merged work/${jobId} to ${targetBranch}`);

  if (removeWorktree(jobId)) {
    steps.push(`Removed worktree .worktrees/${jobId}`);
  } else {
    steps.push(`Warning: Could not remove worktree (may need manual cleanup)`);
  }

  if (deleteJobBranch(jobId)) {
    steps.push(`Deleted branch work/${jobId}`);
  } else {
    steps.push(`Warning: Could not delete branch (may be in use)`);
  }

  return { success: true, steps };
}

// CLI support
if (typeof require !== 'undefined' && require.main === module) {
  const action = process.argv[2];
  const arg = process.argv[3];

  switch (action) {
    case 'create':
      console.log(JSON.stringify(createWorktree(arg || 'test-job'), null, 2));
      break;
    case 'remove':
      console.log(removeWorktree(arg || ''));
      break;
    case 'info':
      console.log(JSON.stringify(getWorktreeInfo(arg || ''), null, 2));
      break;
    case 'list':
      console.log(JSON.stringify(listWorktrees(), null, 2));
      break;
    case 'cleanup':
      console.log(JSON.stringify(cleanupJob(arg || ''), null, 2));
      break;
    default:
      console.log('Usage: worktree.ts <create|remove|info|list|cleanup> [jobId]');
  }
}
