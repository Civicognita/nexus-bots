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

## Usage

In Claude Code, type:

```
w:> Add a logout button to the dashboard header
```

BOTS automatically:
1. Parses the shortcode
2. Routes to the right worker type (code.engineer for this example)
3. Creates a WORK{JOB} with isolated worktree
4. Spawns background workers
5. Presents checkpoints for your review

### Multiple jobs

```
w:> Fix the login bug in auth.ts
w:> Add dark mode toggle to settings
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

## Project Integration

BOTS works standalone by default. To integrate with a project management tool, implement the `ProjectIntegration` interface:

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
