# BOTS — Bolt-On Taskmaster System

Multi-agent work queue orchestration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Add parallel worker execution to any project with a single install command.

## Install

```bash
git clone git@github.com:Civicognita/nexus-bots.git ~/.nexus-bots
cd my-project
bash ~/.nexus-bots/install.sh
```

**Windows (PowerShell):**
```powershell
git clone git@github.com:Civicognita/nexus-bots.git $env:USERPROFILE\.nexus-bots
cd my-project
pwsh $env:USERPROFILE\.nexus-bots\install.ps1
```

## Shortcodes

Shortcodes are prefixes you type in Claude Code to trigger BOTS. A hook intercepts your message, parses the shortcode, and routes it to the right worker — all before Claude even sees the prompt.

| Shortcode | Name | What it does |
|-----------|------|--------------|
| `w:>` | **Work** | Queue a task for background execution. BOTS creates an isolated worktree, picks the right worker, and runs the job in parallel while you keep working. |
| `n:>` | **Next** | Set a topic to work on after the current task completes. Think of it as bookmarking your next focus area. |

### Examples

**Queue a single job:**
```
w:> Add a logout button to the dashboard header
```

BOTS automatically:
1. Parses the shortcode and extracts the task description
2. Routes to the right worker type based on keywords (e.g., "Add button" routes to `code.engineer`)
3. Creates a WORK{JOB} with its own isolated git worktree
4. Spawns background workers to execute the job
5. Pauses at checkpoints for your review before merging

**Queue multiple jobs at once** — each `w:>` becomes a separate parallel job:
```
w:> Fix the login bug in auth.ts
w:> Add dark mode toggle to settings
```

**Set what to work on next** — `n:>` doesn't execute immediately, it queues a topic:
```
w:> Fix the login bug in auth.ts
n:> Review the API rate limiting proposal
```

### CLI

```bash
npm run tm status          # Show active jobs
npm run tm jobs            # List all jobs (including completed)
npm run tm approve job-001 # Approve checkpoint, continue to next phase
npm run tm reject job-001  # Reject and stop
npm run tm -- job job-001  # Show job details
```

## How It Works

```
User types "w:> Fix login bug"
    │
    ▼
Hook detects w:> shortcode
    │
    ▼
CLI creates WORK{JOB} → routes to $W.code.hacker
    │
    ▼
Orchestrator spawns worker in background
    │
    ▼
Worker executes in isolated worktree
    │
    ▼
Enforced chain: hacker → tester (auto)
    │
    ▼
Checkpoint gate → user reviews changes
    │
    ▼
Approve → merge to main, cleanup
```

## Worker Catalog

### Root Workers (8)

| Worker | Role |
|--------|------|
| analyst | Pattern recognition, research |
| coder | General implementation |
| reporter | Diagnostic reports |
| researcher | Information gathering |
| reviewer | Code review, quality |
| scribe | Documentation, summaries |
| strategist | Architecture, planning |
| tester | Validation, testing |

### Domain Workers (22)

| Domain | Workers | Description |
|--------|---------|-------------|
| **code** | engineer, hacker, reviewer, tester | Implementation pipeline |
| **k** | analyst, cryptologist, librarian, linguist | Knowledge management |
| **ux** | designer.web, designer.cli | User experience |
| **strat** | planner, prioritizer | Strategic planning |
| **comm** | writer.tech, writer.policy, editor | Communications |
| **ops** | deployer, custodian, syncer | Operations |
| **gov** | auditor, archivist | Governance |
| **data** | modeler, migrator | Data management |

### Enforced Chains

Some workers automatically trigger follow-up workers:

| Trigger Worker | Followed By |
|----------------|-------------|
| code.hacker | code.tester |
| comm.writer.* | comm.editor |
| data.modeler | k.linguist |
| gov.auditor | gov.archivist |

## Gate Types

| Gate | Behavior |
|------|----------|
| `auto` | Automatically proceed to next phase |
| `checkpoint` | Pause for user review |
| `terminal` | Job complete, offer merge |

## Integrations

BOTS auto-detects your project environment and activates the right integration at startup. No manual setup required.

### Auto-Detection

| Priority | Integration | Detection Signal | What it does |
|----------|-------------|------------------|--------------|
| 1 | **Nexus** | `.nexus/core/GOSPEL.md` + `.ai/.nexus/` dir | Tynn sync + COA tracking, BAIF state gating, `.ai/.nexus/` paths |
| 2 | **Tynn** | `"tynn"` in `.claude/settings.local.json` MCP config | Syncs job status to Tynn tasks, parses `#T123`/`@task:ULID` references |
| 3 | **NoOp** | Neither detected | Standalone mode, no PM sync |

Check which integration is active:
```bash
npm run tm detect
```

### Tynn Integration

When Tynn MCP is detected, BOTS automatically:
- Parses task references from queue text (`#T42`, `@task:01HXYZ`, `#S5`, `@story:ULID`)
- Syncs job lifecycle to Tynn task status:
  - `running` -> `mcp__tynn__starting`
  - `checkpoint` -> `mcp__tynn__testing`
  - `complete` -> `mcp__tynn__finished`
  - `failed` -> `mcp__tynn__block`
- Posts phase completion comments to bound Tynn tasks

### Nexus Integration

Extends Tynn with Nexus-specific features:
- **Path override** — State files at `.ai/.nexus/` instead of `.bots/state/`
- **COA chain tracking** — Worker COA extension metadata on bindings
- **BAIF state gating** — Remote sync operations skipped when STATE != ONLINE

### Manual Override

To use a custom integration, call `setIntegration()` before any BOTS operations:

```typescript
import { setIntegration, ProjectIntegration } from '.bots/lib/project-integration.js';

class MyPMIntegration implements ProjectIntegration {
  isBound(jobId) { /* ... */ }
  bindJob(jobId, refs) { /* ... */ }
  getSyncOperation(jobId) { /* ... */ }
  // ...
}

setIntegration(new MyPMIntegration());
```

## What Gets Installed

```
your-project/
├── .bots/
│   ├── lib/            # Core TS modules (12 files)
│   ├── state/          # Runtime state (gitignored)
│   └── schemas/        # JSON schemas
├── .claude/
│   ├── agents/workers/ # Worker definitions (30 files)
│   ├── prompts/        # Worker base template
│   └── settings.local.json  # Hook registration
├── .ai/
│   ├── handoff/        # Worker handoff files (gitignored)
│   └── checkpoints/    # Worker progress (gitignored)
├── scripts/
│   └── taskmaster-hook.sh
└── CLAUDE.md           # BOTS section appended
```

## License

MIT
