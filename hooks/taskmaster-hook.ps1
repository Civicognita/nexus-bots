# BOTS UserPromptSubmit Hook (PowerShell)
#
# Detects w:> and n:> shortcodes in user input:
# 1. Creates WORK{JOB}s via CLI
# 2. Runs orchestrator to prepare workers
# 3. Outputs signal for terminal to spawn workers

$ErrorActionPreference = "SilentlyContinue"

# Get user input from stdin
$Input = [Console]::In.ReadToEnd()

# Quick check for shortcodes (fast path)
if ($Input -notmatch '(w:|n:)>') {
    exit 0
}

# Find project root (walk up to find .bots/)
function Find-ProjectRoot {
    $dir = Get-Location
    while ($dir.Path -ne [System.IO.Path]::GetPathRoot($dir.Path)) {
        if (Test-Path (Join-Path $dir.Path ".bots")) {
            return $dir.Path
        }
        $dir = Split-Path $dir.Path -Parent | Get-Item
    }
    return $null
}

$ProjectRoot = Find-ProjectRoot
if (-not $ProjectRoot) { exit 0 }

Set-Location $ProjectRoot

# Check if npx is available
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    exit 0
}

# Create jobs via CLI
try {
    $Result = $Input | npx tsx .bots/lib/cli.ts queue 2>$null
} catch {
    exit 0
}

# Parse result
if ($Result -match '"created":(\d+)') {
    $JobCount = [int]$Matches[1]
} else {
    $JobCount = 0
}

if ($JobCount -gt 0) {
    # Extract job IDs
    $JobIds = ([regex]::Matches($Result, '"id":"([^"]*)"') | ForEach-Object { $_.Groups[1].Value }) -join ' '

    # Run orchestrator
    try {
        $OrchResult = npx tsx .bots/lib/orchestrator.ts run 2>$null
    } catch {}

    # Output structured signal
    Write-Host ""
    Write-Host "+=================================================================+"
    Write-Host "|  BOTS                                                           |"
    Write-Host "+=================================================================+"
    Write-Host "|  Queued: $JobCount job(s)                                              |"

    # Parse and show jobs
    try {
        $Data = $Result | ConvertFrom-Json
        foreach ($job in $Data.jobs) {
            $line = "  -> $($job.id): $($job.entryWorker)"
            Write-Host ("|" + $line.PadRight(65) + "|")
        }
        if ($Data.nextFrame) {
            Write-Host ("|  Next: " + $Data.nextFrame.Substring(0, [Math]::Min(54, $Data.nextFrame.Length)).PadRight(57) + "|")
        }
    } catch {}

    Write-Host "+=================================================================+"
    Write-Host "|  <bots-auto-spawn jobs=`"$JobIds`"/>                              |"
    Write-Host "+=================================================================+"
    Write-Host ""
}

exit 0
