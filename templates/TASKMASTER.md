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

### Team Mode

BOTS can dispatch worker teams using Claude Code's **agent teams** feature. Instead of spawning isolated subagents, each worker becomes a teammate in a coordinated team with a shared task list.

**Switching modes:**
```
npm run tm mode team       # Enable team mode
npm run tm mode subagent   # Switch back to default
npm run tm mode            # Show current mode
```

**How team mode differs from subagent mode:**

| Aspect | Subagent (default) | Team |
|--------|-------------------|------|
| Workers | Ephemeral Task tool agents | Persistent teammates in an agent team |
| Communication | JSON handoff files only | Shared task list + direct messaging + handoff files |
| Phase sequencing | Orchestrator poll loop | Task `blockedBy` dependencies |
| Gate: auto | `evaluateGate()` proceeds | Next-phase tasks unblock automatically |
| Gate: checkpoint | CLI `approve` command | `TaskCompleted` hook blocks (exit 2) until approved |
| Gate: terminal | Job complete, merge offered | `TaskCompleted` hook blocks until `npm run tm complete` |

**When hook output contains `<bots-team-orchestrate jobs="..."/>`:**

1. Get the orchestration plan: `npx tsx .bots/lib/cli.ts orchestrate --instructions`
2. **Create an agent team** with the teammates listed in the plan
3. **Spawn each teammate** with their BOTS worker prompt from the plan
4. **Create tasks** in the shared task list via `TaskCreate` for each worker
5. **Wire dependencies** via `TaskUpdate` — phase N+1 tasks are `blockedBy` phase N tasks; chain targets are `blockedBy` their source worker
6. Teammates pick up tasks, execute in the worktree, and write handoff JSON
7. The `TaskCompleted` hook reconciles BOTS state and enforces gates automatically
8. The `TeammateIdle` hook keeps teammates working until they write their handoff
9. When all jobs are done: shut down teammates, then clean up the team

**Gate enforcement (automatic via hooks):**
- `auto` gate: task completes normally → next-phase tasks unblock via dependencies
- `checkpoint` gate: when all phase workers finish, hook blocks the last task (exit 2) → run `npm run tm approve <jobId>` to continue
- `terminal` gate: when all phase workers finish, hook blocks for merge → run `npm run tm complete <jobId>`

**Team mode CLI:**
```
npm run tm team-status                     Show team mode status
npm run tm orchestrate --instructions      Full orchestration plan for team lead
npm run tm orchestrate --tasks             Task payloads only
npm run tm mode                            Show current execution mode
```

**Requirements:**
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` must be set in env
- `TaskCompleted` and `TeammateIdle` hooks must be registered in `.claude/settings.local.json`
