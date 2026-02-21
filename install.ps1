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
    ".bots/lib", ".bots/lib/integrations", ".bots/state", ".bots/schemas",
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
Copy-Item "$BotsSrc/lib/integrations/*.ts" "$ProjectRoot/.bots/lib/integrations/" -Force
Copy-Item "$BotsSrc/tsconfig.json" "$ProjectRoot/.bots/tsconfig.json" -Force
$moduleCount = (Get-ChildItem "$BotsSrc/lib" -Recurse -Filter "*.ts").Count
Ok "  Copied $moduleCount TypeScript modules + tsconfig"

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
    # Merge: add new fields from template, preserve user data (wip, routing, enforced_chains)
    try {
        $tmpl = Get-Content "$BotsSrc/templates/taskmaster.json" -Raw | ConvertFrom-Json
        $existing = Get-Content "$ProjectRoot/.bots/state/taskmaster.json" -Raw | ConvertFrom-Json
        $preserve = @("wip", "routing", "enforced_chains", "dispatch_rules")
        $added = 0
        foreach ($key in $tmpl.PSObject.Properties.Name) {
            if ($preserve -contains $key) { continue }
            if (-not $existing.PSObject.Properties[$key]) {
                $existing | Add-Member -NotePropertyName $key -NotePropertyValue $tmpl.$key
                $added++
            }
        }
        $existing.version = $tmpl.version
        $existing | ConvertTo-Json -Depth 20 | Set-Content "$ProjectRoot/.bots/state/taskmaster.json"
        if ($added -gt 0) { Ok "  Merged $added new fields into taskmaster.json" }
        else { Ok "  taskmaster.json up to date" }
    } catch {
        Warn "  Could not merge taskmaster.json"
    }
}
if (-not (Test-Path "$ProjectRoot/.bots/state/spawn-config.json")) {
    Copy-Item "$BotsSrc/templates/spawn-config.json" "$ProjectRoot/.bots/state/spawn-config.json"
    Ok "  Created spawn-config.json"
} else {
    Copy-Item "$BotsSrc/templates/spawn-config.json" "$ProjectRoot/.bots/state/spawn-config.json" -Force
    Ok "  Updated spawn-config.json"
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
    $pkg.scripts | Add-Member -NotePropertyName tm -NotePropertyValue "npx tsx .bots/lib/cli.ts" -Force
    $pkg.scripts | Add-Member -NotePropertyName "tm:status" -NotePropertyValue "npx tsx .bots/lib/cli.ts status" -Force
    $pkg.scripts | Add-Member -NotePropertyName "tm:jobs" -NotePropertyValue "npx tsx .bots/lib/cli.ts jobs" -Force
    $pkg | ConvertTo-Json -Depth 10 | Set-Content "$ProjectRoot/package.json"
    Ok "  Set tm, tm:status, tm:jobs scripts"
}

# Step 8: Install hooks
Info "Installing hooks..."
Copy-Item "$BotsSrc/hooks/taskmaster-hook.sh" "$ProjectRoot/scripts/taskmaster-hook.sh" -Force
Copy-Item "$BotsSrc/hooks/team-task-completed.sh" "$ProjectRoot/scripts/team-task-completed.sh" -Force
Copy-Item "$BotsSrc/hooks/team-idle.sh" "$ProjectRoot/scripts/team-idle.sh" -Force

$settingsFile = "$ProjectRoot/.claude/settings.local.json"
if (Test-Path $settingsFile) {
    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
    if (-not $settings.hooks) { $settings | Add-Member -NotePropertyName hooks -NotePropertyValue @{} }
    $added = 0

    # Helper: check if hook array contains a command matching pattern
    function Test-HookPresent($hookArray, $pattern) {
        foreach ($h in $hookArray) {
            if ($h.hooks) { foreach ($inner in $h.hooks) { if ($inner.command -match $pattern) { return $true } } }
            if ($h.command -match $pattern) { return $true }
        }
        return $false
    }

    # UserPromptSubmit hook
    if (-not $settings.hooks.UserPromptSubmit) { $settings.hooks | Add-Member -NotePropertyName UserPromptSubmit -NotePropertyValue @() -Force }
    if (-not (Test-HookPresent $settings.hooks.UserPromptSubmit "taskmaster-hook")) {
        $settings.hooks.UserPromptSubmit += @{ hooks = @( @{ type = "command"; command = "bash scripts/taskmaster-hook.sh" } ) }
        $added++
    }

    # TaskCompleted hook
    if (-not $settings.hooks.TaskCompleted) { $settings.hooks | Add-Member -NotePropertyName TaskCompleted -NotePropertyValue @() -Force }
    if (-not (Test-HookPresent $settings.hooks.TaskCompleted "team-task-completed")) {
        $settings.hooks.TaskCompleted += @{ hooks = @( @{ type = "command"; command = "bash scripts/team-task-completed.sh" } ) }
        $added++
    }

    # TeammateIdle hook
    if (-not $settings.hooks.TeammateIdle) { $settings.hooks | Add-Member -NotePropertyName TeammateIdle -NotePropertyValue @() -Force }
    if (-not (Test-HookPresent $settings.hooks.TeammateIdle "team-idle")) {
        $settings.hooks.TeammateIdle += @{ hooks = @( @{ type = "command"; command = "bash scripts/team-idle.sh" } ) }
        $added++
    }

    # Enable agent teams experimental flag
    if (-not $settings.env) { $settings | Add-Member -NotePropertyName env -NotePropertyValue @{} }
    $settings.env | Add-Member -NotePropertyName CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -NotePropertyValue "1" -Force
    $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile
    if ($added -gt 0) { Ok "  Registered $added new hook(s)" } else { Ok "  All hooks already registered" }
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
$botsTemplate = Get-Content "$BotsSrc/templates/TASKMASTER.md" -Raw
if (Test-Path $claudeMd) {
    $content = Get-Content $claudeMd -Raw
    if ($content -match "BOTS.*Bolt-On Taskmaster") {
        # Replace existing BOTS section with latest template
        $botsStart = $content.IndexOf(($content | Select-String -Pattern "(?m)^#+\s+BOTS\b").Matches[0].Value)
        if ($botsStart -ge 0) {
            # Find the heading level of the BOTS section
            $botsHeading = ($content.Substring($botsStart) | Select-String -Pattern "^(#+)").Matches[0].Groups[1].Value
            $level = $botsHeading.Length
            # Find next same-or-higher-level heading after BOTS
            $afterBots = $content.Substring($botsStart + 1)
            $nextHeading = $afterBots | Select-String -Pattern "(?m)^#{1,$level}\s+(?!BOTS\b)"
            if ($nextHeading) {
                $botsEnd = $botsStart + 1 + $nextHeading.Matches[0].Index
                $before = $content.Substring(0, $botsStart)
                $after = $content.Substring($botsEnd)
                Set-Content $claudeMd ($before + $botsTemplate.TrimEnd() + "`n" + $after) -NoNewline
            } else {
                $before = $content.Substring(0, $botsStart)
                Set-Content $claudeMd ($before + $botsTemplate.TrimEnd() + "`n") -NoNewline
            }
            Ok "  Updated BOTS section in CLAUDE.md"
        } else {
            Add-Content $claudeMd "`n$botsTemplate"
            Ok "  Appended BOTS section (could not find section start)"
        }
    } else {
        Add-Content $claudeMd "`n$botsTemplate"
        Ok "  Appended BOTS section"
    }
} else {
    Set-Content $claudeMd $botsTemplate
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
