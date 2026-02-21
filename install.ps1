# BOTS Installer - Bolt-On Taskmaster System (PowerShell)
#
# Usage:
#   pwsh /path/to/nexus-bots/install.ps1
#
# Run from your project root. Installs BOTS into the current directory.

$ErrorActionPreference = "Stop"

function Info($msg)  { Write-Host "[BOTS] $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "[BOTS] $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "[BOTS] $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "[BOTS] $msg" -ForegroundColor Red; exit 1 }

# Resolve paths
$BotsSrc = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Get-Location

Info "Installing BOTS into: $ProjectRoot"

# Step 1: Verify project root
if (-not (Test-Path "$ProjectRoot/package.json") -and -not (Test-Path "$ProjectRoot/.git")) {
    Fail "Not a project root. Expected package.json or .git directory."
}

# Step 2: Create directories
Info "Creating directories..."
$dirs = @(
    ".bots/lib", ".bots/state", ".bots/schemas",
    ".ai/handoff", ".ai/checkpoints",
    ".claude/agents/workers/code", ".claude/agents/workers/k",
    ".claude/agents/workers/ux", ".claude/agents/workers/strat",
    ".claude/agents/workers/comm", ".claude/agents/workers/ops",
    ".claude/agents/workers/gov", ".claude/agents/workers/data",
    ".claude/prompts", "scripts"
)
foreach ($d in $dirs) {
    New-Item -ItemType Directory -Path "$ProjectRoot/$d" -Force | Out-Null
}

# Step 3: Copy core modules
Info "Copying core modules..."
Copy-Item "$BotsSrc/lib/*.ts" "$ProjectRoot/.bots/lib/" -Force
$moduleCount = (Get-ChildItem "$BotsSrc/lib/*.ts").Count
Ok "  Copied $moduleCount TypeScript modules"

# Step 4: Copy workers
Info "Copying worker definitions..."
Get-ChildItem "$BotsSrc/workers/*.md" -ErrorAction SilentlyContinue | Copy-Item -Destination "$ProjectRoot/.claude/agents/workers/" -Force
foreach ($domain in @("code", "k", "ux", "strat", "comm", "ops", "gov", "data")) {
    if (Test-Path "$BotsSrc/workers/$domain") {
        Get-ChildItem "$BotsSrc/workers/$domain/*.md" -ErrorAction SilentlyContinue |
            Copy-Item -Destination "$ProjectRoot/.claude/agents/workers/$domain/" -Force
    }
}
if (Test-Path "$BotsSrc/workers/base.md") {
    Copy-Item "$BotsSrc/workers/base.md" "$ProjectRoot/.claude/prompts/worker-base.md" -Force
}
$workerCount = (Get-ChildItem "$ProjectRoot/.claude/agents/workers" -Recurse -Filter "*.md").Count
Ok "  Copied $workerCount worker definitions"

# Step 5: Copy schemas
Info "Copying schemas..."
Copy-Item "$BotsSrc/schemas/*.json" "$ProjectRoot/.bots/schemas/" -Force

# Step 6: Initialize state files
Info "Initializing state files..."
if (-not (Test-Path "$ProjectRoot/.bots/state/taskmaster.json")) {
    Copy-Item "$BotsSrc/templates/taskmaster.json" "$ProjectRoot/.bots/state/taskmaster.json"
    Ok "  Created taskmaster.json"
} else {
    Warn "  taskmaster.json already exists, skipping"
}
if (-not (Test-Path "$ProjectRoot/.bots/state/spawn-config.json")) {
    Copy-Item "$BotsSrc/templates/spawn-config.json" "$ProjectRoot/.bots/state/spawn-config.json"
    Ok "  Created spawn-config.json"
} else {
    Warn "  spawn-config.json already exists, skipping"
}

# Step 7: Install npm dev dependencies
if (Test-Path "$ProjectRoot/package.json") {
    Info "Installing npm dev dependencies..."
    $pkg = Get-Content "$ProjectRoot/package.json" | ConvertFrom-Json
    $depsToInstall = @()
    foreach ($dep in @("tsx", "typescript", "@types/node")) {
        $hasDep = ($pkg.devDependencies -and $pkg.devDependencies.PSObject.Properties[$dep]) -or
                  ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties[$dep])
        if (-not $hasDep) {
            $depsToInstall += $dep
        }
    }
    if ($depsToInstall.Count -gt 0) {
        try {
            npm install --save-dev @depsToInstall 2>$null
            Ok "  Installed: $($depsToInstall -join ', ')"
        } catch {
            Warn "  npm install failed - install tsx, typescript, @types/node manually"
        }
    } else {
        Ok "  Dependencies already present"
    }

    # Add tm scripts
    Info "Adding npm scripts..."
    $pkg = Get-Content "$ProjectRoot/package.json" -Raw | ConvertFrom-Json
    if (-not $pkg.scripts) { $pkg | Add-Member -NotePropertyName scripts -NotePropertyValue @{} }
    if (-not $pkg.scripts.tm) {
        $pkg.scripts | Add-Member -NotePropertyName tm -NotePropertyValue "npx tsx .bots/lib/cli.ts" -Force
        $pkg.scripts | Add-Member -NotePropertyName "tm:status" -NotePropertyValue "npx tsx .bots/lib/cli.ts status" -Force
        $pkg.scripts | Add-Member -NotePropertyName "tm:jobs" -NotePropertyValue "npx tsx .bots/lib/cli.ts jobs" -Force
        $pkg | ConvertTo-Json -Depth 10 | Set-Content "$ProjectRoot/package.json"
        Ok "  Added tm, tm:status, tm:jobs scripts"
    }
}

# Step 8: Install hooks
Info "Installing hooks..."
Copy-Item "$BotsSrc/hooks/taskmaster-hook.sh" "$ProjectRoot/scripts/taskmaster-hook.sh" -Force
Copy-Item "$BotsSrc/hooks/team-task-completed.sh" "$ProjectRoot/scripts/team-task-completed.sh" -Force
Copy-Item "$BotsSrc/hooks/team-idle.sh" "$ProjectRoot/scripts/team-idle.sh" -Force

$settingsFile = "$ProjectRoot/.claude/settings.local.json"
if (Test-Path $settingsFile) {
    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
    $hasHook = $false
    if ($settings.hooks -and $settings.hooks.UserPromptSubmit) {
        foreach ($h in $settings.hooks.UserPromptSubmit) {
            # Check nested hooks array format
            if ($h.hooks) {
                foreach ($inner in $h.hooks) {
                    if ($inner.command -match "taskmaster-hook") { $hasHook = $true }
                }
            }
            # Also check legacy flat format for backwards compatibility
            if ($h.command -match "taskmaster-hook") { $hasHook = $true }
        }
    }
    if (-not $hasHook) {
        if (-not $settings.hooks) { $settings | Add-Member -NotePropertyName hooks -NotePropertyValue @{} }
        if (-not $settings.hooks.UserPromptSubmit) { $settings.hooks | Add-Member -NotePropertyName UserPromptSubmit -NotePropertyValue @() -Force }
        # Claude Code requires nested { hooks: [...] } format per settings schema
        $settings.hooks.UserPromptSubmit += @{ hooks = @( @{ type = "command"; command = "bash scripts/taskmaster-hook.sh" } ) }
    }
    # Register team hooks
    if (-not $settings.hooks.TaskCompleted) { $settings.hooks | Add-Member -NotePropertyName TaskCompleted -NotePropertyValue @() -Force }
    $hasTaskCompleted = $false
    foreach ($h in $settings.hooks.TaskCompleted) {
        if ($h.hooks) { foreach ($inner in $h.hooks) { if ($inner.command -match "team-task-completed") { $hasTaskCompleted = $true } } }
    }
    if (-not $hasTaskCompleted) {
        $settings.hooks.TaskCompleted += @{ hooks = @( @{ type = "command"; command = "bash scripts/team-task-completed.sh" } ) }
    }
    if (-not $settings.hooks.TeammateIdle) { $settings.hooks | Add-Member -NotePropertyName TeammateIdle -NotePropertyValue @() -Force }
    $hasTeammateIdle = $false
    foreach ($h in $settings.hooks.TeammateIdle) {
        if ($h.hooks) { foreach ($inner in $h.hooks) { if ($inner.command -match "team-idle") { $hasTeammateIdle = $true } } }
    }
    if (-not $hasTeammateIdle) {
        $settings.hooks.TeammateIdle += @{ hooks = @( @{ type = "command"; command = "bash scripts/team-idle.sh" } ) }
    }
    # Enable agent teams experimental flag
    if (-not $settings.env) { $settings | Add-Member -NotePropertyName env -NotePropertyValue @{} }
    $settings.env | Add-Member -NotePropertyName CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -NotePropertyValue "1" -Force
    $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile
    if (-not $hasHook) { Ok "  Hooks registered" } else { Ok "  Hooks already registered (team hooks updated)" }
} else {
    # Claude Code requires nested { hooks: [...] } format per settings schema
    @{
        hooks = @{
            UserPromptSubmit = @(
                @{ hooks = @( @{ type = "command"; command = "bash scripts/taskmaster-hook.sh" } ) }
            )
            TaskCompleted = @(
                @{ hooks = @( @{ type = "command"; command = "bash scripts/team-task-completed.sh" } ) }
            )
            TeammateIdle = @(
                @{ hooks = @( @{ type = "command"; command = "bash scripts/team-idle.sh" } ) }
            )
        }
        env = @{
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
        }
    } | ConvertTo-Json -Depth 10 | Set-Content $settingsFile
    Ok "  Created settings.local.json with hooks"
}

# Step 9: Update CLAUDE.md
Info "Updating CLAUDE.md..."
$claudeMd = "$ProjectRoot/CLAUDE.md"
if (Test-Path $claudeMd) {
    $content = Get-Content $claudeMd -Raw
    if ($content -match "BOTS.*Bolt-On Taskmaster") {
        Ok "  BOTS section already present"
    } else {
        $botsSection = Get-Content "$BotsSrc/templates/TASKMASTER.md" -Raw
        Add-Content $claudeMd "`n$botsSection"
        Ok "  Appended BOTS section"
    }
} else {
    Copy-Item "$BotsSrc/templates/TASKMASTER.md" $claudeMd
    Ok "  Created CLAUDE.md with BOTS section"
}

# Step 10: Update .gitignore
Info "Updating .gitignore..."
$gitignore = "$ProjectRoot/.gitignore"
$entries = @(".bots/state/", ".ai/handoff/", ".ai/checkpoints/", ".worktrees/")
if (Test-Path $gitignore) {
    $content = Get-Content $gitignore -Raw
    $added = 0
    foreach ($entry in $entries) {
        if ($content -notmatch [regex]::Escape($entry)) {
            Add-Content $gitignore $entry
            $added++
        }
    }
    if ($added -gt 0) { Ok "  Added $added entries" } else { Ok "  Already up to date" }
} else {
    $entries | Set-Content $gitignore
    Ok "  Created .gitignore"
}

# Done
Write-Host ""
Write-Host "BOTS installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Quick start: Type  w:> Add a logout button  in Claude Code"
Write-Host "CLI: npm run tm status | npm run tm jobs | npm run tm approve <id>"
Write-Host ""
