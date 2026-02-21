## BOTS — Bolt-On Taskmaster System

**Autonomous Work Queue:** Type `w:>` followed by a task description to queue background work. Workers execute in parallel while you continue interactive work.

### Shortcode Syntax

```
w:> <task description>    Queue work (creates WORK{JOB})
n:> <frame topic>         Set next frame after current work
```

### Auto-Processing

When hook output contains `<bots-auto-spawn jobs="..."/>`:
1. Parse job IDs from the signal
2. Run orchestrator: `npx tsx .bots/lib/orchestrator.ts run`
3. For each worker in `spawned[]`, use Task tool to spawn:
   ```
   Task(
     subagent_type: "general-purpose",
     model: <worker.model>,
     prompt: <worker.prompt>,
     run_in_background: true,
     description: <worker.worker>
   )
   ```
4. Display checkpoints if any require approval

### Gate Types

- `auto` — Proceed automatically to next phase
- `checkpoint` — Pause for user review (show options: approve/reject/diff)
- `terminal` — Job complete (offer merge/archive)

### CLI Commands

```
npm run tm status          Show active jobs
npm run tm jobs            List all jobs
npm run tm approve <id>    Approve checkpoint
npm run tm reject <id>     Reject and stop job
```

### Worker Domains

| Domain | Workers |
|--------|---------|
| code   | engineer, hacker, reviewer, tester |
| k      | analyst, cryptologist, librarian, linguist |
| ux     | designer.web, designer.cli |
| strat  | planner, prioritizer |
| comm   | writer.tech, writer.policy, editor |
| ops    | deployer, custodian, syncer |
| gov    | auditor, archivist |
| data   | modeler, migrator |

### Enforced Chains

| Trigger | Followed By |
|---------|-------------|
| hacker  | tester      |
| writer.*| editor      |
| modeler | linguist    |
| auditor | archivist   |

### Team Mode (Experimental)

BOTS supports an alternative **team mode** that uses Claude Code's agent teams feature for richer collaboration between workers.

**Switching modes:**
```
npm run tm mode team       # Enable team mode
npm run tm mode subagent   # Switch back to default
npm run tm mode            # Show current mode
```

**How team mode differs from subagent mode:**

| Aspect | Subagent (default) | Team |
|--------|-------------------|------|
| Workers | Ephemeral Task tool agents | Persistent teammates |
| Communication | JSON files only | Shared task list + JSON files |
| Phase sequencing | Orchestrator loop | Task dependencies (blockedBy) |
| Gate: auto | `evaluateGate()` proceeds | Tasks unblock automatically |
| Gate: checkpoint | CLI `approve` command | `TaskCompleted` hook blocks (exit 2) |
| Gate: terminal | Job complete, merge offered | `TaskCompleted` hook triggers merge review |
| Monitoring | Filesystem polling | Shared task list is source of truth |

**When hook output contains `<bots-team-orchestrate jobs="..."/>`:**
1. Run orchestrator: `npx tsx .bots/lib/cli.ts orchestrate --instructions`
2. Create tasks via `TaskCreate` for each worker in the plan
3. Wire dependencies via `TaskUpdate` (phase N+1 blocked by phase N)
4. Spawn teammates with the generated prompts
5. The `TaskCompleted` hook enforces gates automatically

**Team mode CLI:**
```
npm run tm team-status     Show team mode status
npm run tm mode            Show current execution mode
```

**Requirements:**
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` must be set
- `TaskCompleted` and `TeammateIdle` hooks must be registered
