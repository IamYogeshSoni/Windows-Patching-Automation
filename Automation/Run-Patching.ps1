#requires -Version 5.1
<#
.SYNOPSIS
Runs the patching phases one after another for a manual test on the jumphost.

.DESCRIPTION
Stages (in this order; choose with -Stages):

  Environment    Scripts\00-EnvironmentCheck.ps1     PowerShell, AD and ConfigMgr modules
  Prerequisites  Scripts\01-PrerequisiteChecks.ps1   SOP checks per server; READY / NOT READY
  DryRun         Scripts\02-ReadOnlyDryRun.ps1       read-only; you pick the SUG at the prompt
  Deploy         Scripts\04-DeployAndValidatePatches.ps1
                 Without -Deploy: preview only (-WhatIf), nothing is changed.
                 With -Deploy: content, maintenance window, Required deployment, install,
                 restart and KB validation. Asks for confirmation before every change.
  Validate       Scripts\04-DeployAndValidatePatches.ps1 -Mode ValidateOnly (no changes)

After each stage the result is shown and you choose whether to continue
(skip with -NoPause). A summary of all stages is printed at the end.

.EXAMPLE
# Checks, dry run and a preview of the deployment (no changes)
.\Run-Patching.ps1 -SugName 'Server - May 2026' -CollectionName 'POC Patch Testing'

.EXAMPLE
# Real deployment after approval
.\Run-Patching.ps1 -Deploy -SugName 'Server - May 2026' -CollectionName 'POC Patch Testing' `
    -DeploymentName 'Patch Testing May 2026' -ChangeTicket CHG123 -Approver jdoe -ApprovalReference APR-1 `
    -MaintenanceWindowStartUtc '2026-10-20 06:00'

.EXAMPLE
# Forget the saved server credential and enter a new one (e.g. after a password change)
.\Run-Patching.ps1 -ResetCredential

.EXAMPLE
# Continue the last deployment run after the PowerShell window was closed
.\Run-Patching.ps1 -Resume

.EXAMPLE
# Only validate servers that were patched earlier
.\Run-Patching.ps1 -Stages Validate -SugName 'Server - May 2026' -CollectionName 'POC Patch Testing' -Kb KB5087545
#>

[CmdletBinding()]
param(
    [ValidateSet('Environment', 'Prerequisites', 'DryRun', 'Deploy', 'Validate')]
    [string[]]$Stages = @('Environment', 'Prerequisites', 'DryRun', 'Deploy'),

    # Without this switch the Deploy stage only previews (-WhatIf).
    [switch]$Deploy,

    # Continue the last deployment run (after the window was closed). Runs only the Deploy stage.
    [switch]$Resume,

    [string]$SugName,
    [string]$CollectionName,
    # Used when -CollectionName does not exist and the Deploy stage creates it (prompted if empty).
    [string]$NewCollectionName,
    [string]$LimitingCollectionName,
    [string]$DeploymentName,
    [string]$ChangeTicket,
    [string]$Approver,
    [string]$ApprovalReference,
    [string]$DeploymentPackageName,
    [string]$DistributionPointGroupName,
    [string]$MaintenanceWindowStartUtc,
    [ValidateRange(1, 24)] [int]$MaintenanceWindowHours = 4,
    [ValidateSet('Script', 'Sccm', 'None')] [string]$RestartMode = 'Script',
    [string[]]$Kb = @(),

    # Admin account on the servers. If not given, the saved one is used; otherwise you are asked
    # once and can save it (encrypted for your Windows account on this server).
    [pscredential]$TargetCredential,

    # Forget the saved server credential and ask again (e.g. after a password change).
    [switch]$ResetCredential,

    # Run all stages without asking to continue in between.
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$scripts = Join-Path $root 'Scripts'
Import-Module (Join-Path $root 'Modules\Common.psm1') -Force
New-Item -ItemType Directory -Path (Join-Path $root 'Reports') -Force | Out-Null

$BoundParameters = $PSBoundParameters
if ($Resume) {
    $Stages = @('Deploy')
    $Deploy = [switch]$true
}

$order = 'Environment', 'Prerequisites', 'DryRun', 'Deploy', 'Validate'
$Stages = @($order | Where-Object { $Stages -contains $_ })
$results = [System.Collections.Generic.List[object]]::new()

function Write-Banner([string]$Text) {
    Write-Host ''
    Write-Host ('#' * 74) -ForegroundColor Magenta
    Write-Host "#  $Text" -ForegroundColor Magenta
    Write-Host ('#' * 74) -ForegroundColor Magenta
}

function Confirm-Continue([string]$Next) {
    if ($NoPause -or -not $Next) { return $true }
    do { $answer = (Read-Host "Continue with '$Next'? [Y]es / [N]o").Trim().ToUpperInvariant() } while ($answer -notin 'Y', 'N', 'YES', 'NO')
    return $answer -like 'Y*'
}

function Get-LatestReport([string]$FileName) {
    Get-ChildItem -Path (Join-Path $root 'Reports') -Recurse -Filter $FileName -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

# Builds the parameters for 04-DeployAndValidatePatches.ps1 from what was given here.
function Get-DeployParameters([string]$Mode) {
    # Only pass what was given here, so 04 can ask for the rest (e.g. the maintenance window)
    # and a resumed run keeps its saved choices.
    $p = @{}
    if ($TargetCredential) { $p.TargetCredential = $TargetCredential }
    if ($BoundParameters.ContainsKey('RestartMode')) { $p.RestartMode = $RestartMode }
    if ($Resume) { $p.Resume = $true; return $p }

    $p.Mode = $Mode
    $p.SugName = $SugName
    foreach ($name in 'CollectionName', 'NewCollectionName', 'LimitingCollectionName', 'DeploymentName', 'ChangeTicket', 'Approver', 'ApprovalReference',
                      'DeploymentPackageName', 'DistributionPointGroupName', 'MaintenanceWindowStartUtc') {
        $value = Get-Variable -Name $name -ValueOnly
        if ($value) { $p[$name] = $value }
    }
    if ($BoundParameters.ContainsKey('MaintenanceWindowHours')) { $p.MaintenanceWindowHours = $MaintenanceWindowHours }
    if ($Kb.Count -gt 0) { $p.Kb = $Kb }
    return $p
}

Write-Banner "SCCM patching test run: $($Stages -join ' > ')"
if ($Stages -contains 'Deploy') {
    if ($Deploy) {
        Write-Host 'Deploy stage is LIVE: it creates a Required deployment and restarts servers.' -ForegroundColor Red
    } else {
        Write-Host 'Deploy stage runs as a PREVIEW (-WhatIf). Add -Deploy for the real run.' -ForegroundColor Yellow
    }
}

if ($Stages | Where-Object { $_ -in 'Prerequisites', 'Deploy', 'Validate' }) {
    $TargetCredential = Resolve-TargetCredential -Credential $TargetCredential -Prompt -Reset:$ResetCredential
}

for ($i = 0; $i -lt $Stages.Count; $i++) {
    $stage = $Stages[$i]
    $next = if ($i + 1 -lt $Stages.Count) { $Stages[$i + 1] } else { $null }
    $started = Get-Date
    $status = 'PASSED'
    $detail = ''

    Write-Banner "Stage $($i + 1)/$($Stages.Count): $stage"
    try {
        switch ($stage) {
            'Environment' {
                & (Join-Path $scripts '00-EnvironmentCheck.ps1')
            }

            'Prerequisites' {
                $p = @{}
                if ($TargetCredential) { $p.TargetCredential = $TargetCredential }
                if ($CollectionName) { $p.CollectionName = $CollectionName }
                & (Join-Path $scripts '01-PrerequisiteChecks.ps1') @p

                $summaryFile = Get-LatestReport 'Phase1_ServerSummary.csv'
                if ($summaryFile -and $summaryFile.LastWriteTime -ge $started) {
                    $rows = @(Import-Csv $summaryFile.FullName)
                    $notReady = @($rows | Where-Object { $_.Overall -ne 'READY' })
                    $detail = "$($rows.Count - $notReady.Count)/$($rows.Count) servers READY"
                    if ($notReady.Count -gt 0) {
                        $status = 'WARNING'
                        $detail += "; NOT READY: $(($notReady | ForEach-Object { "$($_.Server) ($($_.Failed))" }) -join ', ')"
                    }
                } else {
                    $status = 'WARNING'; $detail = 'No server summary found.'
                }
            }

            'DryRun' {
                & (Join-Path $scripts '02-ReadOnlyDryRun.ps1')
                $plan = Get-LatestReport 'Phase2_DryRunPlan.json'
                if ($plan -and $plan.LastWriteTime -ge $started) {
                    $planData = Get-Content $plan.FullName -Raw | ConvertFrom-Json
                    $detail = "SUG '$($planData.SelectedSUG)', $($planData.UpdatesReturned) updates"
                    if (-not $SugName -and $planData.SelectedSUG) {
                        $SugName = [string]$planData.SelectedSUG
                        Write-Host "SUG for the next stages: $SugName" -ForegroundColor Cyan
                    }
                }
            }

            'Deploy' {
                if (-not $SugName -and -not $Resume) { $SugName = (Read-Host 'Software update group (SUG) name to deploy').Trim() }
                $p = Get-DeployParameters 'Full'
                if (-not $Deploy) { $p.WhatIf = $true }
                $global:LASTEXITCODE = 0
                & (Join-Path $scripts '04-DeployAndValidatePatches.ps1') @p
                $code = $LASTEXITCODE
                $detail = if ($Resume) { 'Resumed run' } elseif (-not $Deploy) { 'Preview only (-WhatIf)' } else { 'Live run' }
                if ($code -eq 1) { $status = 'WARNING'; $detail += '; not every server is PATCHED' }
                elseif ($code -ne 0) { $status = 'FAILED'; $detail += "; exit code $code" }
            }

            'Validate' {
                if (-not $SugName) { $SugName = (Read-Host 'Software update group (SUG) name to validate').Trim() }
                $p = Get-DeployParameters 'ValidateOnly'
                $global:LASTEXITCODE = 0
                & (Join-Path $scripts '04-DeployAndValidatePatches.ps1') @p
                $code = $LASTEXITCODE
                if ($code -eq 1) { $status = 'WARNING'; $detail = 'Not every server is PATCHED' }
                elseif ($code -ne 0) { $status = 'FAILED'; $detail = "Exit code $code" }
            }
        }
    } catch {
        $status = 'FAILED'
        $detail = $_.Exception.Message
        Write-Host "`n$stage failed: $detail" -ForegroundColor Red
    }

    $duration = (Get-Date) - $started
    $results.Add([pscustomobject]@{
        Stage = $stage
        Status = $status
        Duration = '{0:hh\:mm\:ss}' -f $duration
        Detail = $detail
    })
    $color = switch ($status) { 'PASSED' { 'Green' } 'WARNING' { 'Yellow' } default { 'Red' } }
    Write-Host "`n$stage : $status $(if ($detail) { "- $detail" })" -ForegroundColor $color

    if ($next -and -not (Confirm-Continue $next)) {
        foreach ($skipped in $Stages[($i + 1)..($Stages.Count - 1)]) {
            $results.Add([pscustomobject]@{ Stage = $skipped; Status = 'SKIPPED'; Duration = ''; Detail = 'Stopped by operator' })
        }
        break
    }
}

Write-Banner 'Summary'
$results | Format-Table -AutoSize -Wrap | Out-Host
Write-Host "Reports: $(Join-Path $root 'Reports')"
