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
mkdir -p "$PROJECT_ROOT/.bots/lib"
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
ok "  Copied $(ls "$BOTS_SRC/lib/"*.ts | wc -l | tr -d ' ') TypeScript modules"

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
  warn "  taskmaster.json already exists, skipping"
fi

if [ ! -f "$PROJECT_ROOT/.bots/state/spawn-config.json" ]; then
  cp "$BOTS_SRC/templates/spawn-config.json" "$PROJECT_ROOT/.bots/state/spawn-config.json"
  ok "  Created spawn-config.json"
else
  warn "  spawn-config.json already exists, skipping"
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
      if (!pkg.scripts.tm) {
        pkg.scripts.tm = 'npx tsx .bots/lib/cli.ts';
        pkg.scripts['tm:status'] = 'npx tsx .bots/lib/cli.ts status';
        pkg.scripts['tm:jobs'] = 'npx tsx .bots/lib/cli.ts jobs';
        fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
        console.log('  Added tm, tm:status, tm:jobs scripts');
      } else {
        console.log('  tm script already exists, skipping');
      }
    " 2>/dev/null || warn "  Could not add npm scripts — add manually"
  fi
else
  warn "No package.json found. Create one with: npm init -y"
  warn "Then install: npm install --save-dev tsx typescript @types/node"
fi

# ============================================================================
# Step 8: Install hook
# ============================================================================

info "Installing hook..."
cp "$BOTS_SRC/hooks/taskmaster-hook.sh" "$PROJECT_ROOT/scripts/taskmaster-hook.sh"
chmod +x "$PROJECT_ROOT/scripts/taskmaster-hook.sh"

# Register hook in .claude/settings.local.json
SETTINGS_FILE="$PROJECT_ROOT/.claude/settings.local.json"
if [ -f "$SETTINGS_FILE" ]; then
  # Check if hook already registered
  if grep -q "taskmaster-hook" "$SETTINGS_FILE" 2>/dev/null; then
    ok "  Hook already registered"
  else
    # Add hook to existing settings
    node -e "
      const fs = require('fs');
      const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
      settings.hooks = settings.hooks || {};
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
      settings.hooks.UserPromptSubmit.push({
        type: 'command',
        command: 'bash scripts/taskmaster-hook.sh'
      });
      fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
    " 2>/dev/null && ok "  Hook registered in settings.local.json" || warn "  Could not register hook — add manually"
  fi
else
  # Create settings file with hook
  cat > "$SETTINGS_FILE" << 'SETTINGS_EOF'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "bash scripts/taskmaster-hook.sh"
      }
    ]
  }
}
SETTINGS_EOF
  ok "  Created settings.local.json with hook"
fi

# ============================================================================
# Step 9: Append BOTS section to CLAUDE.md
# ============================================================================

info "Updating CLAUDE.md..."
CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  if grep -q "BOTS.*Bolt-On Taskmaster" "$CLAUDE_MD" 2>/dev/null; then
    ok "  BOTS section already present in CLAUDE.md"
  else
    echo "" >> "$CLAUDE_MD"
    cat "$BOTS_SRC/templates/TASKMASTER.md" >> "$CLAUDE_MD"
    ok "  Appended BOTS section to CLAUDE.md"
  fi
else
  cp "$BOTS_SRC/templates/TASKMASTER.md" "$CLAUDE_MD"
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
