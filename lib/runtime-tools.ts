/**
 * BOTS Runtime Tools — sandboxed tool executor for worker agents.
 *
 * All file operations are restricted to the worktree root.
 * Uses only Node.js builtins (fs, path, child_process).
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { execSync } from "node:child_process";
import type { RuntimeToolDef, RuntimeToolExecutor } from "./runtime-types.js";

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

// ---------------------------------------------------------------------------
// Path sandbox
// ---------------------------------------------------------------------------

function resolveSandboxed(worktree: string, inputPath: string): string {
  const resolved = resolve(worktree, inputPath);
  const rel = relative(worktree, resolved);
  if (rel.startsWith("..") || resolve(worktree, rel) !== resolved) {
    throw new Error(`Path escapes sandbox: ${inputPath}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFS: RuntimeToolDef[] = [
  {
    name: "file_read",
    description: "Read a file from the worktree. Returns file contents as text.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path within the worktree" },
        offset: { type: "number", description: "Line number to start reading from (1-based)" },
        limit: { type: "number", description: "Number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description: "Write content to a file in the worktree. Creates parent directories if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path within the worktree" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "dir_list",
    description: "List directory contents in the worktree. Returns name, type, and size for each entry.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path within the worktree (default: '.')" },
      },
    },
  },
  {
    name: "bash_exec",
    description: "Execute a shell command with cwd set to the worktree. Returns stdout + stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in ms (default: 30000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "grep_search",
    description: "Search for a pattern in files within the worktree using grep.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Relative path to search in (default: '.')" },
        glob: { type: "string", description: "File glob filter (e.g. '*.ts')" },
      },
      required: ["pattern"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleFileRead(worktree: string, input: Record<string, unknown>): string {
  const path = resolveSandboxed(worktree, String(input.path ?? ""));
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");

  const offset = typeof input.offset === "number" ? Math.max(0, input.offset - 1) : 0;
  const limit = typeof input.limit === "number" ? input.limit : lines.length;
  const sliced = lines.slice(offset, offset + limit);

  return sliced.map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`).join("\n");
}

function handleFileWrite(worktree: string, input: Record<string, unknown>): string {
  const path = resolveSandboxed(worktree, String(input.path ?? ""));
  const content = String(input.content ?? "");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return JSON.stringify({ ok: true, path: relative(worktree, path), bytes: Buffer.byteLength(content) });
}

function handleDirList(worktree: string, input: Record<string, unknown>): string {
  const dirPath = resolveSandboxed(worktree, String(input.path ?? "."));
  const entries = readdirSync(dirPath);
  const results = entries.map((name) => {
    try {
      const stat = statSync(resolve(dirPath, name));
      return { name, type: stat.isDirectory() ? "dir" : "file", size: stat.size };
    } catch {
      return { name, type: "unknown", size: 0 };
    }
  });
  return JSON.stringify(results, null, 2);
}

function handleBashExec(worktree: string, input: Record<string, unknown>): string {
  const command = String(input.command ?? "");
  if (command.length === 0) return JSON.stringify({ error: "empty command" });
  const timeout = typeof input.timeout === "number" ? input.timeout : DEFAULT_BASH_TIMEOUT_MS;

  try {
    const output = execSync(command, {
      cwd: worktree,
      timeout,
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    return `Exit code: ${String(e.status ?? 1)}\n${stdout}\n${stderr}`.trim();
  }
}

function handleGrepSearch(worktree: string, input: Record<string, unknown>): string {
  const pattern = String(input.pattern ?? "");
  if (pattern.length === 0) return JSON.stringify({ error: "empty pattern" });

  const searchPath = resolveSandboxed(worktree, String(input.path ?? "."));
  const glob = typeof input.glob === "string" ? input.glob : "";

  const args = ["-rn", "--color=never"];
  if (glob.length > 0) args.push(`--include=${glob}`);
  args.push(pattern, searchPath);

  try {
    const output = execSync(`grep ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
      cwd: worktree,
      timeout: 15_000,
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output;
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    if (e.status === 1) return "No matches found.";
    return typeof e.stdout === "string" ? e.stdout : "grep error";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSandboxedToolExecutor(
  worktreePath: string,
  allowedTools?: string[],
): RuntimeToolExecutor {
  const resolved = resolve(worktreePath);

  const handlers: Record<string, (worktree: string, input: Record<string, unknown>) => string> = {
    file_read: handleFileRead,
    file_write: handleFileWrite,
    dir_list: handleDirList,
    bash_exec: handleBashExec,
    grep_search: handleGrepSearch,
  };

  const toolNames = allowedTools ?? Object.keys(handlers);

  return {
    async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
      const handler = handlers[toolName];
      if (handler === undefined || !toolNames.includes(toolName)) {
        return JSON.stringify({ error: `Unknown or disallowed tool: ${toolName}` });
      }
      try {
        return handler(resolved, input);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
    getToolDefinitions(): RuntimeToolDef[] {
      return TOOL_DEFS.filter((d) => toolNames.includes(d.name));
    },
  };
}
