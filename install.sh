#!/bin/bash
# BOTS Installer — Bolt-On Taskmaster System
#
# Usage:
#   bash /path/to/nexus-bots/install.sh
#
# Run from your project root. Installs BOTS into the current directory.

set -e

# Colors (if terminal supports them)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[BOTS]${NC} $1"; }
ok()    { echo -e "${GREEN}[BOTS]${NC} $1"; }
warn()  { echo -e "${YELLOW}[BOTS]${NC} $1"; }
fail()  { echo -e "${RED}[BOTS]${NC} $1"; exit 1; }

# Resolve BOTS source directory (where this script lives)
BOTS_SRC="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(pwd)"

info "Installing BOTS into: $PROJECT_ROOT"

# ============================================================================
# Step 1: Verify project root
# ============================================================================

if [ ! -f "$PROJECT_ROOT/package.json" ] && [ ! -d "$PROJECT_ROOT/.git" ]; then
  fail "Not a project root. Expected package.json or .git directory."
fi

# ============================================================================
# Step 2: Create directories
# ============================================================================

info "Creating directories..."
mkdir -p "$PROJECT_ROOT/.bots/lib/integrations"
mkdir -p "$PROJECT_ROOT/.bots/state"
mkdir -p "$PROJECT_ROOT/.bots/schemas"
mkdir -p "$PROJECT_ROOT/.ai/handoff"
mkdir -p "$PROJECT_ROOT/.ai/checkpoints"
mkdir -p "$PROJECT_ROOT/.claude/agents/workers/code"
mkdir -p "$PROJECT_ROOT/.claude/agents/workers/k"
mkdir -p "$PROJECT_ROOT/.claude/agents/workers/ux"
mkdir -p "$PROJECT_ROOT/.claude/agents/workers/strat"
mkdir -p "$PROJECT_ROOT/.claude/agents/workers/comm"
mkdir -p "$PROJECT_ROOT/.claude/agents/workers/ops"
mkdir -p "$PROJECT_ROOT/.claude/agents/workers/gov"
mkdir -p "$PROJECT_ROOT/.claude/agents/workers/data"
mkdir -p "$PROJECT_ROOT/.claude/prompts"
mkdir -p "$PROJECT_ROOT/scripts"

# ============================================================================
# Step 3: Copy core modules
# ============================================================================

info "Copying core modules..."
cp "$BOTS_SRC/lib/"*.ts "$PROJECT_ROOT/.bots/lib/"
cp "$BOTS_SRC/lib/integrations/"*.ts "$PROJECT_ROOT/.bots/lib/integrations/"
cp "$BOTS_SRC/tsconfig.json" "$PROJECT_ROOT/.bots/tsconfig.json"
ok "  Copied $(find "$BOTS_SRC/lib" -name '*.ts' | wc -l | tr -d ' ') TypeScript modules + tsconfig"

# ============================================================================
# Step 4: Copy workers
# ============================================================================

info "Copying worker definitions..."

# Root-level workers
for f in "$BOTS_SRC/workers/"*.md; do
  [ -f "$f" ] && cp "$f" "$PROJECT_ROOT/.claude/agents/workers/"
done

# Domain workers
for domain in code k ux strat comm ops gov data; do
  if [ -d "$BOTS_SRC/workers/$domain" ]; then
    cp "$BOTS_SRC/workers/$domain/"*.md "$PROJECT_ROOT/.claude/agents/workers/$domain/" 2>/dev/null || true
  fi
done

# Worker base template
if [ -f "$BOTS_SRC/workers/base.md" ]; then
  cp "$BOTS_SRC/workers/base.md" "$PROJECT_ROOT/.claude/prompts/worker-base.md"
fi

WORKER_COUNT=$(find "$PROJECT_ROOT/.claude/agents/workers" -name "*.md" | wc -l | tr -d ' ')
ok "  Copied $WORKER_COUNT worker definitions"

# ============================================================================
# Step 5: Copy schemas
# ============================================================================

info "Copying schemas..."
cp "$BOTS_SRC/schemas/"*.json "$PROJECT_ROOT/.bots/schemas/"
ok "  Copied $(ls "$BOTS_SRC/schemas/"*.json | wc -l | tr -d ' ') schemas"

# ============================================================================
# Step 6: Initialize state files
# ============================================================================

info "Initializing state files..."
if [ ! -f "$PROJECT_ROOT/.bots/state/taskmaster.json" ]; then
  cp "$BOTS_SRC/templates/taskmaster.json" "$PROJECT_ROOT/.bots/state/taskmaster.json"
  ok "  Created taskmaster.json"
else
  # Merge: add new fields from template, preserve user data (wip, routing, enforced_chains)
  node -e "
    const fs = require('fs');
    const tmpl = JSON.parse(fs.readFileSync('$BOTS_SRC/templates/taskmaster.json', 'utf-8'));
    const existing = JSON.parse(fs.readFileSync('$PROJECT_ROOT/.bots/state/taskmaster.json', 'utf-8'));
    const preserve = ['wip', 'routing', 'enforced_chains', 'dispatch_rules'];
    let added = 0;
    for (const key of Object.keys(tmpl)) {
      if (preserve.includes(key)) continue;
      if (!(key in existing)) { existing[key] = tmpl[key]; added++; }
    }
    existing.version = tmpl.version;
    fs.writeFileSync('$PROJECT_ROOT/.bots/state/taskmaster.json', JSON.stringify(existing, null, 2) + '\n');
    if (added > 0) console.log('  Merged ' + added + ' new fields into taskmaster.json');
    else console.log('  taskmaster.json up to date');
  " 2>/dev/null || warn "  Could not merge taskmaster.json"
fi

if [ ! -f "$PROJECT_ROOT/.bots/state/spawn-config.json" ]; then
  cp "$BOTS_SRC/templates/spawn-config.json" "$PROJECT_ROOT/.bots/state/spawn-config.json"
  ok "  Created spawn-config.json"
else
  cp "$BOTS_SRC/templates/spawn-config.json" "$PROJECT_ROOT/.bots/state/spawn-config.json"
  ok "  Updated spawn-config.json"
fi

# ============================================================================
# Step 7: Install npm dev dependencies
# ============================================================================

if [ -f "$PROJECT_ROOT/package.json" ]; then
  info "Installing npm dev dependencies..."

  # Check which deps are missing
  DEPS_TO_INSTALL=""
  for dep in tsx typescript @types/node; do
    if ! grep -q "\"$dep\"" "$PROJECT_ROOT/package.json" 2>/dev/null; then
      DEPS_TO_INSTALL="$DEPS_TO_INSTALL $dep"
    fi
  done

  if [ -n "$DEPS_TO_INSTALL" ]; then
    npm install --save-dev $DEPS_TO_INSTALL 2>/dev/null || warn "  npm install failed — install tsx, typescript, @types/node manually"
    ok "  Installed:$DEPS_TO_INSTALL"
  else
    ok "  Dependencies already present"
  fi

  # Add tm scripts to package.json
  info "Adding npm scripts..."
  if command -v node &> /dev/null; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.tm = 'npx tsx .bots/lib/cli.ts';
      pkg.scripts['tm:status'] = 'npx tsx .bots/lib/cli.ts status';
      pkg.scripts['tm:jobs'] = 'npx tsx .bots/lib/cli.ts jobs';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
      console.log('  Set tm, tm:status, tm:jobs scripts');
    " 2>/dev/null || warn "  Could not add npm scripts — add manually"
  fi
else
  warn "No package.json found. Create one with: npm init -y"
  warn "Then install: npm install --save-dev tsx typescript @types/node"
fi

# ============================================================================
# Step 8: Install hook
# ============================================================================

info "Installing hooks..."
cp "$BOTS_SRC/hooks/taskmaster-hook.sh" "$PROJECT_ROOT/scripts/taskmaster-hook.sh"
cp "$BOTS_SRC/hooks/team-task-completed.sh" "$PROJECT_ROOT/scripts/team-task-completed.sh"
cp "$BOTS_SRC/hooks/team-idle.sh" "$PROJECT_ROOT/scripts/team-idle.sh"
chmod +x "$PROJECT_ROOT/scripts/taskmaster-hook.sh"
chmod +x "$PROJECT_ROOT/scripts/team-task-completed.sh"
chmod +x "$PROJECT_ROOT/scripts/team-idle.sh"

# Register hook in .claude/settings.local.json
SETTINGS_FILE="$PROJECT_ROOT/.claude/settings.local.json"
if [ -f "$SETTINGS_FILE" ]; then
  # Ensure all hooks are registered (adds missing ones, preserves existing)
  node -e "
    const fs = require('fs');
    const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
    settings.hooks = settings.hooks || {};
    let added = 0;
    // UserPromptSubmit hook
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
    if (!JSON.stringify(settings.hooks.UserPromptSubmit).includes('taskmaster-hook')) {
      settings.hooks.UserPromptSubmit.push({
        hooks: [{ type: 'command', command: 'bash scripts/taskmaster-hook.sh' }]
      });
      added++;
    }
    // TaskCompleted hook (team mode)
    settings.hooks.TaskCompleted = settings.hooks.TaskCompleted || [];
    if (!JSON.stringify(settings.hooks.TaskCompleted).includes('team-task-completed')) {
      settings.hooks.TaskCompleted.push({
        hooks: [{ type: 'command', command: 'bash scripts/team-task-completed.sh' }]
      });
      added++;
    }
    // TeammateIdle hook (team mode)
    settings.hooks.TeammateIdle = settings.hooks.TeammateIdle || [];
    if (!JSON.stringify(settings.hooks.TeammateIdle).includes('team-idle')) {
      settings.hooks.TeammateIdle.push({
        hooks: [{ type: 'command', command: 'bash scripts/team-idle.sh' }]
      });
      added++;
    }
    // Enable agent teams experimental flag
    settings.env = settings.env || {};
    settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
    if (added > 0) console.log('  Registered ' + added + ' new hook(s)');
    else console.log('  All hooks already registered');
  " 2>/dev/null || warn "  Could not register hooks — add manually"
else
  # Create settings file with hooks
  cat > "$SETTINGS_FILE" << 'SETTINGS_EOF'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/taskmaster-hook.sh"
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/team-task-completed.sh"
          }
        ]
      }
    ],
    "TeammateIdle": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/team-idle.sh"
          }
        ]
      }
    ]
  },
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
SETTINGS_EOF
  ok "  Created settings.local.json with hooks"
fi

# ============================================================================
# Step 9: Append BOTS section to CLAUDE.md
# ============================================================================

info "Updating CLAUDE.md..."
CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
BOTS_TEMPLATE="$BOTS_SRC/templates/TASKMASTER.md"
if [ -f "$CLAUDE_MD" ]; then
  if grep -q "BOTS.*Bolt-On Taskmaster" "$CLAUDE_MD" 2>/dev/null; then
    # Replace existing BOTS section with latest template
    node -e "
      const fs = require('fs');
      const content = fs.readFileSync('$CLAUDE_MD', 'utf-8');
      const template = fs.readFileSync('$BOTS_TEMPLATE', 'utf-8');
      // Find BOTS section start (## BOTS or # BOTS header)
      const botsStart = content.search(/^#+\s+BOTS\b/m);
      if (botsStart === -1) { process.exit(1); }
      // Find next same-or-higher-level heading after BOTS section
      const headerMatch = content.substring(0, botsStart).match(/^(#+)\s/m) || content.substring(botsStart).match(/^(#+)\s/m);
      const level = headerMatch ? headerMatch[1].length : 2;
      const pattern = new RegExp('^#{1,' + level + '}\\\\s+(?!BOTS\\\\b)', 'm');
      const afterBots = content.substring(botsStart + 1).search(pattern);
      const botsEnd = afterBots === -1 ? content.length : botsStart + 1 + afterBots;
      const before = content.substring(0, botsStart);
      const after = content.substring(botsEnd);
      fs.writeFileSync('$CLAUDE_MD', before + template.trim() + '\\n' + after);
      console.log('  Updated BOTS section in CLAUDE.md');
    " 2>/dev/null || {
      # Fallback: just append if replacement failed
      echo "" >> "$CLAUDE_MD"
      cat "$BOTS_TEMPLATE" >> "$CLAUDE_MD"
      ok "  Appended BOTS section to CLAUDE.md (replacement failed, appended instead)"
    }
  else
    echo "" >> "$CLAUDE_MD"
    cat "$BOTS_TEMPLATE" >> "$CLAUDE_MD"
    ok "  Appended BOTS section to CLAUDE.md"
  fi
else
  cp "$BOTS_TEMPLATE" "$CLAUDE_MD"
  ok "  Created CLAUDE.md with BOTS section"
fi

# ============================================================================
# Step 10: Update .gitignore
# ============================================================================

info "Updating .gitignore..."
GITIGNORE="$PROJECT_ROOT/.gitignore"
ENTRIES_ADDED=0
if [ -f "$GITIGNORE" ]; then
  for entry in ".bots/state/" ".ai/handoff/" ".ai/checkpoints/" ".worktrees/"; do
    if ! grep -qF "$entry" "$GITIGNORE" 2>/dev/null; then
      echo "$entry" >> "$GITIGNORE"
      ENTRIES_ADDED=$((ENTRIES_ADDED + 1))
    fi
  done
else
  cat > "$GITIGNORE" << 'GITIGNORE_EOF'
# BOTS state (ephemeral)
.bots/state/
.ai/handoff/
.ai/checkpoints/
.worktrees/
GITIGNORE_EOF
  ENTRIES_ADDED=4
fi

if [ $ENTRIES_ADDED -gt 0 ]; then
  ok "  Added $ENTRIES_ADDED entries to .gitignore"
else
  ok "  .gitignore already up to date"
fi

# ============================================================================
# Done
# ============================================================================

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  BOTS installed successfully!                                 ║"
echo "╠═══════════════════════════════════════════════════════════════╣"
echo "║                                                               ║"
echo "║  Quick start:                                                 ║"
echo "║    Type  w:> Add a logout button  in Claude Code              ║"
echo "║                                                               ║"
echo "║  CLI:                                                         ║"
echo "║    npm run tm status     Show active jobs                     ║"
echo "║    npm run tm jobs       List all jobs                        ║"
echo "║    npm run tm approve    Approve checkpoint                   ║"
echo "║                                                               ║"
echo "║  Files installed:                                             ║"
echo "║    .bots/lib/         Core modules ($(ls "$PROJECT_ROOT/.bots/lib/"*.ts 2>/dev/null | wc -l | tr -d ' ') files)                    ║"
echo "║    .claude/agents/    Worker definitions ($WORKER_COUNT files)              ║"
echo "║    .bots/schemas/     JSON schemas                            ║"
echo "║    scripts/           Hook script                             ║"
echo "║                                                               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
