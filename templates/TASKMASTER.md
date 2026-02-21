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
