#requires -Version 5.1
<#
.SYNOPSIS
Deploys a Software Update Group to the test collection, gets the updates
installed, restarts the servers and validates each KB on each server.

.DESCRIPTION
Follows the SOP "T1 Server Patch Deployment Process" end to end:

  1. Safety gates      Settings.AllowWriteOperations must be true; every collection member must be
                       one of -TargetServers (servers chosen from AD) or, without it, allowlisted in
                       Config\TestServers.json; change ticket/approver required;
                       deployment name typed again; each change asks for confirmation (-WhatIf supported).
     Collection        If -CollectionName does not exist, asks for a name (or uses -NewCollectionName) and
                       creates a device collection limited to -LimitingCollectionName containing the
                       allowlisted servers, then waits until SCCM shows them as members.
     Window input      Asks for the maintenance window start (UTC) and duration unless given as parameters.
  2. Baseline         Which SUG updates each server needs (SCCM compliance + SCCM client on the server).
     Already compliant Servers that are already compliant (baseline, or an earlier deployment of the same
                       SUG reporting Compliant) are not patched again, monitored or restarted. If every
                       server is compliant, nothing is created.
  3. Content           Downloads missing update content into -DeploymentPackageName and distributes
                       the packages to -DistributionPointGroupName, then waits until every DP reports success.
  4. Maintenance window Creates a one-time UTC window for software updates on the collection (SOP p.15-18).
  5. Deployment        Required, UTC, available and deadline "as soon as possible" (or -DeadlineUtc), Software Center with
                       restart notifications only, no install or restart outside the maintenance window,
                       restarts allowed inside it, Operations Manager alerts disabled (SOP p.4-13).
                       The created deployment is read back and any setting that differs is corrected.
  6. Install           Triggers machine policy and update evaluation, then waits until every required
                       update is installed or fails.
  7. Restart           -RestartMode Script (default): the script restarts servers with a pending reboot.
                       Sccm: waits for the SCCM client to restart them in the window. None: no restart.
  8. Validation        After a rescan, checks every required KB on every server with Get-HotFix, the SCCM
                       client update store, Windows Update history and SCCM compliance.
                       Verdict per server: PATCHED, PENDING_RESTART, NOT_PATCHED or UNVERIFIED.

Run on the jumphost as the account that can use the SCCM console. Remote checks on the servers
(WinRM) need an account with local admin rights there (-TargetCredential).

Reports and a transcript are written to Reports\<timestamp>\.

Recovery: progress is saved to Reports\<timestamp>\State.json after every step (and Reports\LastRun.json
points to it). If the window is closed, run the script again with -Resume: it reuses the collection,
maintenance window and deployment already created, keeps the original baseline and continues with
monitoring, restart and validation. If the maintenance window has ended, you are asked for a new one.

.EXAMPLE
# Preview only: shows every change without making it
.\Scripts\04-DeployAndValidatePatches.ps1 -SugName 'Server - May 2026' -CollectionName 'POC Patch Testing' `
    -DeploymentName 'Patch Testing May 2026' -ChangeTicket CHG123 -Approver jdoe -ApprovalReference APR-1 -WhatIf

.EXAMPLE
# Full run with a maintenance window starting 06:00 UTC for 4 hours
.\Scripts\04-DeployAndValidatePatches.ps1 -SugName 'Server - May 2026' -CollectionName 'POC Patch Testing' `
    -DeploymentName 'Patch Testing May 2026' -ChangeTicket CHG123 -Approver jdoe -ApprovalReference APR-1 `
    -DeploymentPackageName 'Server Updates 2026' -DistributionPointGroupName 'All DPs' `
    -MaintenanceWindowStartUtc '2026-10-20 06:00' -MaintenanceWindowHours 4 `
    -TargetCredential (Get-Credential DSLAB\admin)

.EXAMPLE
# Continue the last run after the PowerShell window was closed
.\Scripts\04-DeployAndValidatePatches.ps1 -Resume

.EXAMPLE
# Only validate servers already patched (no changes), including two specific KBs
.\Scripts\04-DeployAndValidatePatches.ps1 -Mode ValidateOnly -SugName 'Server - May 2026' `
    -CollectionName 'POC Patch Testing' -Kb KB5087545, 5031364 -TargetCredential (Get-Credential)
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidateSet('Full', 'ValidateOnly')]
    [string]$Mode = 'Full',

    # Required unless -Resume is used.
    [string]$SugName,

    # Continue the last run (Reports\LastRun.json) after the window was closed.
    [switch]$Resume,

    # Continue a specific run: its Reports\<timestamp> folder or State.json file.
    [string]$ResumeFrom,

    [string]$CollectionName,

    # FQDNs of the servers this run may patch (chosen from AD and prerequisite-checked), used
    # instead of the allowlist in Config\TestServers.json. Saved for -Resume.
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]{0,62}(\.[A-Za-z0-9][A-Za-z0-9-]{0,62})+$')]
    [string[]]$TargetServers,

    # When -CollectionName does not exist (Full mode): name of the collection to create.
    # You are prompted for it if not given. The new collection holds the allowlisted servers.
    [string]$NewCollectionName,

    # Limiting collection for a newly created collection. Default: Settings.LimitingCollectionName or 'All Systems'.
    [string]$LimitingCollectionName,

    [string]$DeploymentName,
    [string]$ChangeTicket,
    [string]$Approver,
    [string]$ApprovalReference,

    # Type the deployment name again here for unattended runs; otherwise you are prompted.
    [string]$ConfirmDeploymentName,

    # Existing software update deployment package that receives missing content.
    [string]$DeploymentPackageName,

    # DP group the content packages are distributed to when not yet distributed.
    [string]$DistributionPointGroupName,

    # 'yyyy-MM-dd HH:mm' in UTC. If not given you are asked for the start and duration.
    [string]$MaintenanceWindowStartUtc,

    [ValidateRange(1, 24)]
    [int]$MaintenanceWindowHours = 4,

    # Deployment deadline 'yyyy-MM-dd HH:mm' in UTC, inside the maintenance window.
    # Default: as soon as possible (installation still waits for the window).
    [string]$DeadlineUtc,

    # Use the collection's existing maintenance windows instead of creating one.
    [switch]$SkipMaintenanceWindow,

    [ValidateSet('Script', 'Sccm', 'None')]
    [string]$RestartMode = 'Script',

    # Extra KB numbers to validate on every server (e.g. KB5087545 or 5087545).
    [string[]]$Kb = @(),

    [pscredential]$TargetCredential,

    [ValidateRange(5, 1440)] [int]$ContentTimeoutMinutes = 120,
    [ValidateRange(10, 1440)] [int]$InstallTimeoutMinutes = 240,
    [ValidateRange(5, 240)] [int]$RestartTimeoutMinutes = 30,
    [ValidateRange(5, 1440)] [int]$ComplianceTimeoutMinutes = 60,
    [ValidateRange(30, 1800)] [int]$PollSeconds = 120
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $root 'Modules\Common.psm1') -Force
$config = Get-ProjectConfig
$settings = $config.Settings
# Use the saved server credential when none is given (saved via Run-Patching.ps1).
$TargetCredential = Resolve-TargetCredential -Credential $TargetCredential
$siteCode = [string]$settings.SiteCode
$siteServer = [string]$settings.SccmSiteServer
if (-not $CollectionName) { $CollectionName = [string]$settings.TargetCollectionName }
if (-not $DeploymentPackageName) { $DeploymentPackageName = [string](Get-PropertyValue $settings 'DeploymentPackageName') }
if (-not $DistributionPointGroupName) { $DistributionPointGroupName = [string](Get-PropertyValue $settings 'DistributionPointGroupName') }
if (-not $LimitingCollectionName) { $LimitingCollectionName = [string](Get-PropertyValue $settings 'LimitingCollectionName') }
if (-not $LimitingCollectionName) { $LimitingCollectionName = 'All Systems' }

# ------------------------------------------------------------
# Resume: restore the inputs and progress of an earlier run
# ------------------------------------------------------------
$StageOrder = @('Started', 'Baseline', 'Content', 'MaintenanceWindow', 'Deployment', 'Installed', 'Restarted', 'Done')
$SavedState = $null
$Resuming = [bool]($Resume -or $ResumeFrom)
if ($Resuming) {
    if ($ResumeFrom) {
        $stateFile = if (Test-Path -LiteralPath $ResumeFrom -PathType Container) { Join-Path $ResumeFrom 'State.json' } else { $ResumeFrom }
    } else {
        $pointer = Join-Path $root 'Reports\LastRun.json'
        if (-not (Test-Path -LiteralPath $pointer)) { throw 'Nothing to resume: Reports\LastRun.json not found. Use -ResumeFrom <Reports\timestamp folder>.' }
        $stateFile = (Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json).StateFile
    }
    if (-not (Test-Path -LiteralPath $stateFile)) { throw "State file not found: $stateFile" }
    $SavedState = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json

    $Mode = 'Full'
    foreach ($name in 'SugName', 'CollectionName', 'DeploymentName', 'ChangeTicket', 'Approver', 'ApprovalReference',
                      'MaintenanceWindowStartUtc', 'LimitingCollectionName', 'DeadlineUtc') {
        $value = [string](Get-PropertyValue $SavedState $name)
        if ($value) { Set-Variable -Name $name -Value $value }
    }
    if ($SavedState.MaintenanceWindowHours) { $MaintenanceWindowHours = [int]$SavedState.MaintenanceWindowHours }
    $SkipMaintenanceWindow = [switch][bool]$SavedState.SkipMaintenanceWindow
    if (-not $PSBoundParameters.ContainsKey('RestartMode') -and $SavedState.RestartMode) { $RestartMode = [string]$SavedState.RestartMode }
    if (-not $PSBoundParameters.ContainsKey('Kb')) { $Kb = @($SavedState.Kb | Where-Object { $_ }) }
    $savedTargets = @(Get-PropertyValue $SavedState 'TargetServers' | Where-Object { $_ })
    if ($savedTargets.Count -gt 0) { $TargetServers = [string[]]$savedTargets }
    $ConfirmDeploymentName = $DeploymentName   # confirmed when the run started
}
if (-not $SugName) { throw 'SugName is required (or use -Resume).' }

$run = if ($SavedState -and $SavedState.RunFolder -and (Test-Path -LiteralPath $SavedState.RunFolder)) { [string]$SavedState.RunFolder }
       else { New-RunFolder -Root $root }
$exitCode = 0
$script:ComplianceKnown = $false

function Test-StageDone([string]$Stage) {
    if (-not $SavedState) { return $false }
    return $StageOrder.IndexOf([string]$SavedState.Stage) -ge $StageOrder.IndexOf($Stage)
}

# SCCM client schedule IDs (root\ccm SMS_Client.TriggerSchedule)
$Schedule = @{
    MachinePolicy     = '{00000000-0000-0000-0000-000000000021}'
    MachinePolicyEval = '{00000000-0000-0000-0000-000000000022}'
    UpdateDeployEval  = '{00000000-0000-0000-0000-000000000108}'
    StateMessages     = '{00000000-0000-0000-0000-000000000111}'
    UpdateScan        = '{00000000-0000-0000-0000-000000000113}'
}

# ============================================================
# Helpers
# ============================================================

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 70) -ForegroundColor DarkCyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 70) -ForegroundColor DarkCyan
}

function Get-KbNumber([string]$Text) {
    if ($Text -match '(\d{6,8})') { return $Matches[1] }
    return $null
}

# Adds the first parameter name the cmdlet actually supports (names differ between
# ConfigMgr versions). Returns $false and records the setting when none exists.
function Add-SupportedParameter {
    param([hashtable]$Splat, [string]$Command, [string[]]$Names, $Value, [System.Collections.Generic.List[string]]$Unsupported)
    $available = (Get-Command $Command).Parameters.Keys
    foreach ($name in $Names) {
        if ($available -contains $name) {
            $Splat[$name] = $Value
            return $true
        }
    }
    if ($Unsupported) { $Unsupported.Add("$Command -$($Names -join '/')") }
    return $false
}

function Invoke-OnTarget {
    param([string]$ComputerName, [scriptblock]$ScriptBlock, [object[]]$ArgumentList)
    $params = @{ ComputerName = $ComputerName; ScriptBlock = $ScriptBlock; ErrorAction = 'Stop' }
    if ($ArgumentList) { $params.ArgumentList = $ArgumentList }
    if ($TargetCredential) { $params.Credential = $TargetCredential }
    Invoke-Command @params
}

function Invoke-ClientSchedule {
    param($Server, [string[]]$ScheduleIds)
    if (-not $Server.RemoteOk) { return }
    try {
        Invoke-OnTarget -ComputerName $Server.Fqdn -ArgumentList (, $ScheduleIds) -ScriptBlock {
            param($ids)
            foreach ($id in $ids) {
                Invoke-CimMethod -Namespace 'root\ccm' -ClassName SMS_Client -MethodName TriggerSchedule `
                    -Arguments @{ sScheduleID = $id } -ErrorAction SilentlyContinue | Out-Null
            }
        }
    } catch {
        Write-Warning "$($Server.Fqdn): could not trigger client actions: $($_.Exception.Message)"
    }
}

# Evidence gathered on the server itself.
$EvidenceScript = {
    $hotFix = @(Get-HotFix -ErrorAction SilentlyContinue | ForEach-Object { "$($_.HotFixID)".ToUpperInvariant() })

    $ccm = @()
    try {
        $ccm = @(Get-CimInstance -Namespace 'root\ccm\SoftwareUpdates\UpdatesStore' -ClassName CCM_UpdateStatus -ErrorAction Stop |
            ForEach-Object { [pscustomobject]@{ Article = "$($_.Article)"; Status = "$($_.Status)"; Title = "$($_.Title)" } })
    } catch { }

    $history = @()
    try {
        $searcher = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
        $count = $searcher.GetTotalHistoryCount()
        if ($count -gt 0) {
            # ResultCode 2 = succeeded, 3 = succeeded with errors
            $history = @($searcher.QueryHistory(0, [Math]::Min($count, 1000)) |
                Where-Object { $_.ResultCode -in 2, 3 } | ForEach-Object { "$($_.Title)" })
        }
    } catch { }

    $rebootPending = $false
    try {
        $r = Invoke-CimMethod -Namespace 'root\ccm\ClientSDK' -ClassName CCM_ClientUtilities `
            -MethodName DetermineIfRebootPending -ErrorAction Stop
        $rebootPending = [bool]($r.RebootPending -or $r.IsHardRebootPending)
    } catch {
        $rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
            (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
    }

    $os = Get-CimInstance Win32_OperatingSystem
    $ubr = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue).UBR
    [pscustomobject]@{
        HotFix = $hotFix
        CcmUpdates = $ccm
        History = $history
        RebootPending = $rebootPending
        LastBootUpTime = $os.LastBootUpTime
        OS = $os.Caption
        Build = "$($os.Version).$ubr"
    }
}

function Get-TargetEvidence($Server) {
    try {
        $evidence = Invoke-OnTarget -ComputerName $Server.Fqdn -ScriptBlock $EvidenceScript
        $Server.RemoteOk = $true
        $Server.RemoteError = $null
        return $evidence
    } catch {
        $Server.RemoteOk = $false
        $Server.RemoteError = $_.Exception.Message
        return $null
    }
}

# Is a KB installed according to the evidence from the server?
function Test-KbInstalled($Evidence, [string]$KbNumber) {
    if (-not $Evidence) { return $null }
    $sources = @()
    if (@($Evidence.HotFix) -contains "KB$KbNumber") { $sources += 'Get-HotFix' }
    if (@($Evidence.CcmUpdates | Where-Object { $_.Article -eq $KbNumber -and $_.Status -eq 'Installed' }).Count -gt 0) { $sources += 'SCCM client' }
    if (@($Evidence.History | Where-Object { $_ -match "KB$KbNumber\b" }).Count -gt 0) { $sources += 'WU history' }
    return $sources
}

function Test-KbMissingOnClient($Evidence, [string]$KbNumber) {
    if (-not $Evidence) { return $false }
    return @($Evidence.CcmUpdates | Where-Object { $_.Article -eq $KbNumber -and $_.Status -eq 'Missing' }).Count -gt 0
}

# KB-level SCCM compliance for one server (SMS_UpdateComplianceStatus.Status: 1 not required,
# 2 required, 3 installed): Required if any CI of that KB is required, else Installed if any
# is installed, else NotRequired/Unknown.
function Get-SccmKbStatus([hashtable]$Compliance, $Server, [string]$KbNumber) {
    $statuses = @($KbToCis[$KbNumber] | ForEach-Object { $Compliance["$($Server.ResourceId)|$_"] } | Where-Object { $null -ne $_ })
    if ($statuses -contains 2) { return 'Required' }
    if ($statuses -contains 3) { return 'Installed' }
    if ($statuses -contains 1) { return 'NotRequired' }
    return 'Unknown'
}

# Saves inputs and progress so a closed window can be recovered with -Resume.
function Save-State([string]$Stage) {
    if ($Mode -ne 'Full' -or $WhatIfPreference) { return }
    # Never move the recorded progress backwards (a resumed run repeats early steps).
    $current = if ($script:HighestStage) { $script:HighestStage } elseif ($SavedState) { [string]$SavedState.Stage } else { 'Started' }
    if ($StageOrder.IndexOf($Stage) -lt $StageOrder.IndexOf($current)) { $Stage = $current }
    $script:HighestStage = $Stage
    $state = [ordered]@{
        Version = 1
        Stage = $Stage
        UpdatedUtc = [datetime]::UtcNow.ToString('o')
        RunFolder = $run
        SugName = $SugName
        CollectionName = $CollectionName
        LimitingCollectionName = $LimitingCollectionName
        DeploymentName = $DeploymentName
        ChangeTicket = $ChangeTicket
        Approver = $Approver
        ApprovalReference = $ApprovalReference
        MaintenanceWindowStartUtc = $MaintenanceWindowStartUtc
        MaintenanceWindowHours = $MaintenanceWindowHours
        DeadlineUtc = $DeadlineUtc
        SkipMaintenanceWindow = [bool]$SkipMaintenanceWindow
        RestartMode = $RestartMode
        Kb = @($Kb)
        TargetServers = @($TargetServers | Where-Object { $_ })
        Servers = @($Servers | ForEach-Object {
            [ordered]@{
                Name = $_.Name
                ResourceId = $_.ResourceId
                RequiredBefore = @($_.RequiredBefore)
                BaselineKnown = $_.BaselineKnown
                BootBefore = if ($_.BootBefore) { ([datetime]$_.BootBefore).ToString('o') } else { $null }
                AlreadyCompliant = $_.AlreadyCompliant
                State = $_.State
                Restarted = $_.Restarted
            }
        })
    }
    $file = Join-Path $run 'State.json'
    $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $file -Encoding UTF8 -WhatIf:$false
    [ordered]@{ StateFile = $file; Stage = $Stage; DeploymentName = $DeploymentName; UpdatedUtc = $state.UpdatedUtc } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'Reports\LastRun.json') -Encoding UTF8 -WhatIf:$false
}

# Asks for the maintenance window; sets $MaintenanceWindowStartUtc and $MaintenanceWindowHours.
function Read-MaintenanceWindow([switch]$AskHours) {
    Write-Host "`nMaintenance window (UTC). Updates install and servers restart only inside this window." -ForegroundColor Yellow
    Write-Host ("Current time: {0:yyyy-MM-dd HH:mm} UTC = {1:yyyy-MM-dd HH:mm} local" -f [datetime]::UtcNow, (Get-Date))
    $suggested = [datetime]::UtcNow.AddMinutes(30)
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    while ($true) {
        $raw = (Read-Host ("Start (yyyy-MM-dd HH:mm UTC, Enter = {0:yyyy-MM-dd HH:mm})" -f $suggested)).Trim()
        if (-not $raw) { $raw = $suggested.ToString('yyyy-MM-dd HH:mm') }
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParseExact($raw, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) { break }
        Write-Warning 'Use the format yyyy-MM-dd HH:mm, e.g. 2026-10-20 06:00'
    }
    if ($AskHours) {
        while ($true) {
            $rawHours = (Read-Host "Duration in hours, 1-24 (Enter = $script:MaintenanceWindowHours)").Trim()
            if (-not $rawHours) { break }
            $hours = 0
            if ([int]::TryParse($rawHours, [ref]$hours) -and $hours -ge 1 -and $hours -le 24) { $script:MaintenanceWindowHours = $hours; break }
            Write-Warning 'Enter a whole number from 1 to 24.'
        }
    }
    $end = $parsed.AddHours($script:MaintenanceWindowHours)
    if ($end -le [datetime]::UtcNow) { throw 'That maintenance window would already be over.' }
    Write-Host ("Window: {0:yyyy-MM-dd HH:mm} - {1:yyyy-MM-dd HH:mm} UTC (local {2:yyyy-MM-dd HH:mm} - {3:HH:mm})" -f
        $parsed, $end, $parsed.ToLocalTime(), $end.ToLocalTime()) -ForegroundColor Green
    $script:MaintenanceWindowStartUtc = $raw
}

# Latest status of each server in any deployment of this SUG (works without WinRM and
# without the compliance query). ResourceId -> Compliant, Status, Deployment, Time.
function Get-SugDeploymentStatus {
    $result = @{}
    try {
        $assignments = @(Invoke-SmsQuery -CimSession $sms -SiteCode $siteCode -Query (
            "SELECT AssignmentID, AssignmentName FROM SMS_UpdateGroupAssignment WHERE AssignedUpdateGroup = $SugCiId"))
    } catch {
        Write-Warning "Could not list existing deployments of '$SugName': $($_.Exception.Message)"
        return $result
    }
    foreach ($a in $assignments) {
        foreach ($s in $Servers) {
            try {
                $row = @(Invoke-SmsQuery -CimSession $sms -SiteCode $siteCode -Query (
                    "SELECT * FROM SMS_SUMDeploymentAssetDetails WHERE AssignmentID = $($a.AssignmentID) AND ResourceID = $($s.ResourceId)")) |
                    Select-Object -First 1
            } catch { continue }
            if (-not $row) { continue }
            $time = Get-PropertyValue $row 'StatusTime'
            $entry = [pscustomobject]@{
                Compliant = ([int](Get-PropertyValue $row 'StatusType') -eq 1)
                Status = Get-AssetStatusText $row
                Deployment = [string]$a.AssignmentName
                Time = $time
            }
            $previous = $result[$s.ResourceId]
            if (-not $previous -or ($time -and (-not $previous.Time -or $time -gt $previous.Time))) { $result[$s.ResourceId] = $entry }
        }
    }
    return $result
}

# Deployment status of one server as text: compliance (e.g. Non-compliant) plus what the client
# is doing (enforcement: downloading, waiting for maintenance window, installing, pending restart)
# and the enforcement error code when there is one.
function Get-AssetStatusText($Asset) {
    $text = [string](Get-PropertyValue $Asset 'StatusDescription')
    $enforcement = [string](Get-PropertyValue $Asset 'LastEnforcementMessageDesc')
    $errorCode = Get-PropertyValue $Asset 'LastEnforcementErrorCode'
    if ($enforcement -and $enforcement -ne $text) { $text = "$text | enforcement: $enforcement" }
    if ($errorCode -and [long]$errorCode -ne 0) { $text += (" | error 0x{0:X8}" -f ([long]$errorCode -band 0xFFFFFFFFL)) }
    return $text
}

# Sends one SCCM client notification (fast channel; no WinRM needed) to a single device.
function Send-ClientNotification($Server, [string]$Action) {
    $params = @{ ActionType = $Action; ErrorAction = 'Stop' }
    if (-not (Add-SupportedParameter $params 'Invoke-CMClientNotification' @('DeviceId') $Server.ResourceId)) {
        $params.DeviceName = $Server.Name
    }
    try {
        Invoke-CMClientNotification @params | Out-Null
        Write-Host ("  [{0:HH:mm:ss}] Sent {1} to {2}" -f (Get-Date), $Action, $Server.Name)
    } catch {
        Write-Warning "$($Server.Name): client notification $Action failed: $($_.Exception.Message)"
    }
}

# Waits for the SCCM client to restart a server (the deployment allows restarts in the window).
# Uses the server's boot time when it is reachable, otherwise the deployment status in SCCM.
function Wait-SccmRestart($Server) {
    Write-Host "Waiting up to $RestartTimeoutMinutes min for the SCCM client to restart $($Server.Fqdn)..."
    $until = (Get-Date).AddMinutes($RestartTimeoutMinutes)
    while ((Get-Date) -lt $until) {
        Start-Sleep -Seconds 60
        $evidence = Get-TargetEvidence $Server
        if ($evidence) {
            if (($Server.BootBefore -and $evidence.LastBootUpTime -gt $Server.BootBefore) -or -not $evidence.RebootPending) {
                $Server.Restarted = $true
                return
            }
            continue
        }
        try {
            $asset = @(Invoke-SmsQuery -CimSession $sms -SiteCode $siteCode -Query (
                "SELECT * FROM SMS_SUMDeploymentAssetDetails WHERE AssignmentID = $assignmentId AND ResourceID = $($Server.ResourceId)")) |
                Select-Object -First 1
            $statusType = [int](Get-PropertyValue $asset 'StatusType')
            $statusText = Get-AssetStatusText $asset
            Write-Host ("  [{0:HH:mm:ss}] SCCM: {1}" -f (Get-Date), $statusText)
            if ($statusType -eq 1 -and $statusText -notmatch 'restart|reboot') {
                $Server.Restarted = $true
                $Server.StateDetail = "SCCM: $statusText"
                return
            }
        } catch {
            Write-Warning "$($Server.Fqdn): deployment status query failed: $($_.Exception.Message)"
        }
    }
    Write-Warning "$($Server.Fqdn) did not report a restart within $RestartTimeoutMinutes min. Check it, then rerun with -Mode ValidateOnly."
}

# Per-server compliance for the SUG's updates. Queries stay narrow (one server, a few CI_IDs)
# because broad queries on SMS_UpdateComplianceStatus can fail with "Generic failure".
# On failure compliance is treated as unknown and validation relies on the servers themselves.
function Get-Compliance {
    $map = @{}
    $failures = New-Object System.Collections.Generic.List[string]
    $ciList = @($SugCiIds | Sort-Object)

    foreach ($s in $Servers) {
        for ($i = 0; $i -lt $ciList.Count; $i += 20) {
            $chunk = $ciList[$i..([Math]::Min($i + 20, $ciList.Count) - 1)]
            $where = "ResourceID = $($s.ResourceId) AND (" + (($chunk | ForEach-Object { "CI_ID = $_" }) -join ' OR ') + ')'
            $rows = @()
            $ok = $false
            $lastError = ''
            foreach ($select in 'SELECT CI_ID, Status', 'SELECT *') {
                try {
                    $rows = @(Invoke-SmsQuery -CimSession $sms -SiteCode $siteCode -Query "$select FROM SMS_UpdateComplianceStatus WHERE $where")
                    $ok = $true
                    break
                } catch {
                    $lastError = $_.Exception.Message
                }
            }
            if (-not $ok) { $failures.Add("$($s.Name): $lastError"); continue }
            foreach ($row in $rows) { $map["$($s.ResourceId)|$($row.CI_ID)"] = [int]$row.Status }
        }
    }

    $script:ComplianceKnown = ($failures.Count -eq 0)
    if ($failures.Count -gt 0) {
        Write-Warning "SCCM compliance query failed ($($failures[0])). SCCM compliance is treated as unknown; validation uses the servers' own data where reachable."
    }
    return $map
}

# KBs from the SUG that must be installed on a server: required per SCCM or missing per the client.
function Get-RequiredKbs([hashtable]$Compliance, $Server, $Evidence) {
    $set = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($kb in $KbToCis.Keys) {
        if ((Get-SccmKbStatus $Compliance $Server $kb) -eq 'Required' -or (Test-KbMissingOnClient $Evidence $kb)) {
            [void]$set.Add($kb)
        }
    }
    return @($set | Sort-Object)
}

function Get-ValidationRows([hashtable]$Compliance, $Server, $Evidence) {
    $kbs = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($kb in @($Server.RequiredBefore)) { [void]$kbs.Add($kb) }
    foreach ($kb in $ExtraKbs) { [void]$kbs.Add($kb) }
    foreach ($kb in $KbToCis.Keys) {
        if ((Get-SccmKbStatus $Compliance $Server $kb) -in 'Required', 'Installed') { [void]$kbs.Add($kb) }
        if ($Evidence -and @($Evidence.CcmUpdates | Where-Object { $_.Article -eq $kb }).Count -gt 0) { [void]$kbs.Add($kb) }
    }

    foreach ($kb in ($kbs | Sort-Object)) {
        $sccm = if ($KbToCis.ContainsKey($kb)) { Get-SccmKbStatus $Compliance $Server $kb } else { 'NotInSUG' }
        $sources = Test-KbInstalled $Evidence $kb
        $installedOnServer = $sources -and @($sources).Count -gt 0
        $missingOnClient = Test-KbMissingOnClient $Evidence $kb

        $result = if ($installedOnServer -or $sccm -eq 'Installed') { 'INSTALLED' }
                  elseif ($missingOnClient -or $sccm -eq 'Required') { 'MISSING' }
                  elseif ($sccm -eq 'NotRequired') { 'NOT_REQUIRED' }
                  elseif ($ExtraKbs -contains $kb -and $Evidence) { 'NOT_FOUND' }   # -Kb not on the server and not reported as needed
                  else { 'UNKNOWN' }

        $note = ''
        if ($installedOnServer -and $sccm -eq 'Required') { $note = 'Installed on the server; SCCM compliance not updated yet.' }

        [pscustomobject]@{
            Server = $Server.Fqdn
            KB = "KB$kb"
            Title = if ($KbTitles.ContainsKey($kb)) { $KbTitles[$kb] } else { '' }
            RequiredBefore = if ($Mode -eq 'Full') { @($Server.RequiredBefore) -contains $kb } else { $null }
            SccmStatus = $sccm
            Evidence = if ($installedOnServer) { @($sources) -join ', ' } else { '' }
            Result = $result
            Note = $note
        }
    }
}

# ============================================================
# Main
# ============================================================

Start-Transcript -Path (Join-Path $run 'Transcript.txt') -Append -WhatIf:$false | Out-Null
if ($Resuming) {
    Write-Host "RESUMING run $run (last completed step: $($SavedState.Stage); deployment '$DeploymentName')" -ForegroundColor Yellow
}
$sms = $null
$pushed = $false
$summary = [ordered]@{
    RunUtc = (Get-Date).ToUniversalTime().ToString('o')
    Mode = $Mode
    SUG = $SugName
    Collection = $CollectionName
    DeploymentName = $DeploymentName
    ChangeTicket = $ChangeTicket
    Approver = $Approver
    ApprovalReference = $ApprovalReference
}

try {
    # ------------------------------------------------------------
    Write-Step '1. Connect and run safety gates'
    # ------------------------------------------------------------
    $cmWarnings = Connect-CMSite -SiteCode $siteCode -SiteServer $siteServer
    foreach ($w in $cmWarnings) { Write-Warning $w }
    Push-Location "$($siteCode):\"
    $pushed = $true
    $site = Get-CMSite -ErrorAction Stop
    if ($site.SiteCode -ne $siteCode) { throw "Connected to unexpected site '$($site.SiteCode)'." }
    Write-Host "Site $($site.SiteCode) $($site.SiteName) version $($site.Version)"
    $sms = New-SmsCimSession -SiteServer $siteServer -SiteCode $siteCode

    if ($Mode -eq 'Full') {
        if ($settings.AllowWriteOperations -ne $true) {
            throw 'Config\Settings.json has AllowWriteOperations = false. Set it to true only after the deployment is approved.'
        }
        if (-not $DeploymentName) { $DeploymentName = (Read-Host 'Deployment name').Trim() }
        while (-not $ChangeTicket) { $ChangeTicket = (Read-Host 'Approved change ticket / CRQ').Trim() }
        while (-not $Approver) { $Approver = (Read-Host 'Approver name or corporate ID').Trim() }
        while (-not $ApprovalReference) { $ApprovalReference = (Read-Host 'Approval reference').Trim() }
        if (-not $DeploymentName) { throw 'DeploymentName is required.' }
        # Ask for the maintenance window now, with the other inputs, before anything long runs.
        if (-not $SkipMaintenanceWindow -and -not $MaintenanceWindowStartUtc -and -not $WhatIfPreference) {
            Read-MaintenanceWindow -AskHours:(-not $PSBoundParameters.ContainsKey('MaintenanceWindowHours'))
        }
        $summary.DeploymentName = $DeploymentName
        $summary.ChangeTicket = $ChangeTicket
        $summary.Approver = $Approver
        $summary.ApprovalReference = $ApprovalReference
    }

    # SUG and its updates
    $sug = @(Get-CMSoftwareUpdateGroup -Name $SugName -ErrorAction Stop)
    if ($sug.Count -ne 1) { throw "Software update group '$SugName' found $($sug.Count) times; expected one." }
    $SugCiId = [int]$sug[0].CI_ID
    $updates = @(Get-CMSoftwareUpdate -UpdateGroupName $SugName -Fast -ErrorAction Stop)
    if ($updates.Count -eq 0) { throw "SUG '$SugName' contains no updates." }

    $SugCiIds = New-Object 'System.Collections.Generic.HashSet[int]'
    $KbToCis = @{}
    $KbTitles = @{}
    foreach ($u in $updates) {
        [void]$SugCiIds.Add([int]$u.CI_ID)
        $kb = Get-KbNumber ([string]$u.ArticleID)
        if (-not $kb) { continue }
        if (-not $KbToCis.ContainsKey($kb)) { $KbToCis[$kb] = @(); $KbTitles[$kb] = [string]$u.LocalizedDisplayName }
        $KbToCis[$kb] += [int]$u.CI_ID
    }
    $ExtraKbs = @($Kb | ForEach-Object { Get-KbNumber $_ } | Where-Object { $_ } | Sort-Object -Unique)
    Write-Host "SUG '$SugName': $($updates.Count) updates, $($KbToCis.Count) distinct KBs."
    $expired = @($updates | Where-Object { $_.IsExpired })
    if ($expired.Count -gt 0) { Write-Warning "$($expired.Count) expired updates in the SUG will not install." }

    # Servers this run may patch: short name -> FQDN. -TargetServers (chosen from AD) when given,
    # otherwise the allowlist in Config\TestServers.json.
    $allowlist = @{}
    $allowSource = if (@($TargetServers | Where-Object { $_ }).Count -gt 0) { 'the selected servers (-TargetServers)' } else { 'Config\TestServers.json' }
    $allowFqdns = if (@($TargetServers | Where-Object { $_ }).Count -gt 0) { @($TargetServers | Where-Object { $_ }) }
                  else { @($config.Targets | Where-Object { $_.Allowed -eq $true } | ForEach-Object { [string]$_.Fqdn }) }
    foreach ($f in $allowFqdns) {
        $allowlist[(([string]$f).Trim() -split '\.')[0].ToUpperInvariant()] = ([string]$f).Trim().ToLowerInvariant()
    }
    if ($allowlist.Count -eq 0) { throw "No servers to patch in $allowSource." }
    Write-Host "Servers allowed in this run ($allowSource): $(($allowlist.Values | Sort-Object) -join ', ')" 

    # Collection: use it if it exists; in Full mode create it when it does not.
    $previewMembers = $null
    $collection = @(Get-CMDeviceCollection -Name $CollectionName -ErrorAction Stop)
    if ($collection.Count -gt 1) { throw "Collection '$CollectionName' found $($collection.Count) times; expected one." }

    if ($collection.Count -eq 1) {
        $collection = $collection[0]
    } else {
        if ($Mode -ne 'Full') { throw "Collection '$CollectionName' does not exist. ValidateOnly cannot create it; run in Full mode." }

        Write-Warning "Collection '$CollectionName' does not exist. A new device collection with the allowlisted servers will be created."
        $newName = $NewCollectionName
        if (-not $newName) {
            $entered = (Read-Host "Name for the new device collection (Enter = '$CollectionName')").Trim()
            $newName = if ($entered) { $entered } else { $CollectionName }
        }

        $existing = @(Get-CMDeviceCollection -Name $newName -ErrorAction Stop)
        if ($existing.Count -gt 1) { throw "Collection '$newName' found $($existing.Count) times; expected one." }

        if ($existing.Count -eq 1) {
            Write-Host "Collection '$newName' already exists; using it."
            $collection = $existing[0]
        } else {
            $limiting = @(Get-CMDeviceCollection -Name $LimitingCollectionName -ErrorAction Stop)
            if ($limiting.Count -ne 1) {
                throw "Limiting collection '$LimitingCollectionName' found $($limiting.Count) times; expected one. Use -LimitingCollectionName."
            }

            # Every allowlisted server must have exactly one SCCM device record.
            $newMembers = @(foreach ($short in ($allowlist.Keys | Sort-Object)) {
                $found = @(Get-CMDevice -Name $short -Fast -ErrorAction Stop | Where-Object { $_ })
                if ($found.Count -ne 1) { throw "Expected one SCCM device record for '$short'; found $($found.Count). Collection not created." }
                $found[0]
            })
            $memberText = ($newMembers | ForEach-Object { $_.Name }) -join ', '

            if ($PSCmdlet.ShouldProcess("collection '$newName' (limited to '$LimitingCollectionName')", "Create device collection with $memberText")) {
                $collection = New-CMDeviceCollection -Name $newName -LimitingCollectionId $limiting[0].CollectionID `
                    -Comment "Patch collection created by 04-DeployAndValidatePatches.ps1. Change=$ChangeTicket; Approver=$Approver" -ErrorAction Stop
                foreach ($d in $newMembers) {
                    Add-CMDeviceCollectionDirectMembershipRule -CollectionId $collection.CollectionID -ResourceId ([int]$d.ResourceID) -ErrorAction Stop
                }
                Invoke-CMCollectionUpdate -Name $newName -ErrorAction SilentlyContinue | Out-Null

                # New collections take a moment to evaluate; wait until the servers show up.
                Write-Host "Collection '$newName' ($($collection.CollectionID)) created; waiting for SCCM to evaluate its membership..."
                $expected = @($newMembers | ForEach-Object { $_.Name.ToUpperInvariant() } | Sort-Object) -join ','
                $stopAt = (Get-Date).AddMinutes(10)
                do {
                    Start-Sleep -Seconds 15
                    $current = @(Get-CMDevice -CollectionId $collection.CollectionID -Fast -ErrorAction Stop |
                        ForEach-Object { $_.Name.ToUpperInvariant() } | Sort-Object) -join ','
                } while ($current -ne $expected -and (Get-Date) -lt $stopAt)
                if ($current -ne $expected) {
                    throw "Collection '$newName' was created but its membership is not evaluated after 10 minutes (has: '$current'). Rerun with -CollectionName '$newName' once it shows $memberText."
                }
                Write-Host "Collection '$newName' contains $memberText." -ForegroundColor Green
                $summary.CollectionCreated = $true
            } elseif ($WhatIfPreference) {
                # Preview: carry on with the servers the new collection would contain.
                $collection = [pscustomobject]@{ CollectionID = '(new)'; Name = $newName }
                $previewMembers = $newMembers
            } else {
                throw 'Collection creation cancelled by operator.'
            }
        }
        $CollectionName = $newName
        $summary.Collection = $newName
    }

    $members = if ($previewMembers) { $previewMembers } else { @(Get-CMDevice -CollectionId $collection.CollectionID -Fast -ErrorAction Stop) }
    if ($members.Count -eq 0) { throw "Collection '$CollectionName' has no members." }

    $notAllowed = @($members | Where-Object { -not $allowlist.ContainsKey($_.Name.ToUpperInvariant()) } | ForEach-Object { $_.Name })
    if ($notAllowed.Count -gt 0) {
        throw "Collection '$CollectionName' contains servers not in $($allowSource): $($notAllowed -join ', '). Select them as well, or use another collection."
    }

    $Servers = @($members | ForEach-Object {
        [pscustomobject]@{
            Name = $_.Name.ToUpperInvariant()
            Fqdn = $allowlist[$_.Name.ToUpperInvariant()]
            ResourceId = [int]$_.ResourceID
            RemoteOk = $false
            RemoteError = $null
            RequiredBefore = @()
            BaselineKnown = $false
            AlreadyCompliant = $false
            SccmCompliant = $false
            State = 'PENDING'
            StateDetail = ''
            BootBefore = $null
            Restarted = $false
            Verdict = $null
        }
    })
    Write-Host "Collection '$CollectionName' ($($collection.CollectionID)): $(($Servers | ForEach-Object { $_.Fqdn }) -join ', ')"
    $summary.CollectionId = $collection.CollectionID
    $summary.Servers = @($Servers | ForEach-Object { $_.Fqdn })
    Save-State 'Started'

    # ------------------------------------------------------------
    Write-Step '2. Baseline: updates each server needs'
    # ------------------------------------------------------------
    $compliance = Get-Compliance
    $baselineRows = foreach ($s in $Servers) {
        $evidence = Get-TargetEvidence $s
        if (-not $s.RemoteOk) { Write-Warning "$($s.Fqdn): no remote access ($($s.RemoteError)). Validation will rely on SCCM only." }
        $saved = if ($SavedState) { @($SavedState.Servers | Where-Object { [int]$_.ResourceId -eq $s.ResourceId }) | Select-Object -First 1 }
        if ($saved) {
            # Resume: keep the baseline from before patching started.
            $s.RequiredBefore = @($saved.RequiredBefore | Where-Object { $_ })
            $s.BaselineKnown = [bool]$saved.BaselineKnown
            $s.BootBefore = if ($saved.BootBefore) { [datetime]::Parse($saved.BootBefore, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } else { $null }
            $s.Restarted = [bool]$saved.Restarted
        } else {
            $s.BootBefore = if ($evidence) { $evidence.LastBootUpTime } else { $null }
            $s.RequiredBefore = @(Get-RequiredKbs $compliance $s $evidence)
            $s.BaselineKnown = $s.RemoteOk -or $script:ComplianceKnown
        }
        [pscustomobject]@{
            Server = $s.Fqdn
            RemoteAccess = $s.RemoteOk
            OS = if ($evidence) { "$($evidence.OS) $($evidence.Build)" } else { '' }
            RebootPending = if ($evidence) { $evidence.RebootPending } else { $null }
            RequiredKbCount = if ($s.BaselineKnown) { $s.RequiredBefore.Count } else { 'UNKNOWN' }
            RequiredKbs = if ($s.BaselineKnown) { ($s.RequiredBefore | ForEach-Object { "KB$_" }) -join ', ' } else { 'No data: SCCM compliance and remote access unavailable; progress is tracked via deployment status' }
        }
    }
    $baselineRows | Format-Table -AutoSize -Wrap | Out-Host
    $baselineRows | Export-Csv (Join-Path $run 'Baseline.csv') -NoTypeInformation -Encoding UTF8 -WhatIf:$false
    $summary.Baseline = @($baselineRows)

    # Already compliant? From the baseline, or from an earlier deployment of this SUG
    # that reports the server Compliant. Such servers are not patched, monitored or restarted.
    $sugStatus = Get-SugDeploymentStatus
    foreach ($s in $Servers) {
        $previous = $sugStatus[$s.ResourceId]
        if ($previous -and $previous.Compliant) { $s.SccmCompliant = $true }
        if ($s.BaselineKnown -and $s.RequiredBefore.Count -eq 0) {
            $s.AlreadyCompliant = $true
            $s.StateDetail = 'Already compliant: no SUG update required (baseline).'
        } elseif ($previous -and $previous.Compliant) {
            $s.AlreadyCompliant = $true
            $s.StateDetail = "Already compliant: deployment '$($previous.Deployment)' reports $($previous.Status) at $($previous.Time)."
        }
        if ($s.AlreadyCompliant) { $s.State = 'ALREADY_COMPLIANT' }
    }
    $Servers | Select-Object Fqdn, State, StateDetail | Format-Table -AutoSize -Wrap | Out-Host
    $allCompliant = @($Servers | Where-Object { -not $_.AlreadyCompliant }).Count -eq 0
    if ($Mode -eq 'Full' -and $allCompliant) {
        Write-Host 'Every server is already compliant with this SUG; nothing to deploy. Going straight to validation.' -ForegroundColor Green
    }
    Save-State 'Baseline'

    if ($Mode -eq 'Full' -and -not $allCompliant) {
        $pendingBefore = @($baselineRows | Where-Object { $_.RebootPending })
        if ($pendingBefore.Count -gt 0) {
            Write-Warning "Reboot already pending before patching on: $(($pendingBefore | ForEach-Object { $_.Server }) -join ', ')."
        }

        # --------------------------------------------------------
        Write-Step '3. Content: download and distribute'
        # --------------------------------------------------------
        if (Test-StageDone 'Content') {
            Write-Host 'Content was already checked in this run; skipping.'
        } else {
            $notDownloaded = @($updates | Where-Object { -not $_.IsContentProvisioned -and -not $_.IsExpired })
            if ($notDownloaded.Count -gt 0) {
                Write-Host "$($notDownloaded.Count) updates are not downloaded yet."
                if (-not $DeploymentPackageName) {
                    throw 'Updates are not downloaded. Give -DeploymentPackageName (an existing software update deployment package) or set DeploymentPackageName in Settings.json.'
                }
                $save = @{ SoftwareUpdateGroupName = $SugName; DeploymentPackageName = $DeploymentPackageName; ErrorAction = 'Stop' }
                [void](Add-SupportedParameter $save 'Save-CMSoftwareUpdate' @('SoftwareUpdateLanguage') @('English'))
                [void](Add-SupportedParameter $save 'Save-CMSoftwareUpdate' @('DownloadFromInternet') $true)
                if ($PSCmdlet.ShouldProcess("package '$DeploymentPackageName'", "Download $($notDownloaded.Count) updates of '$SugName'")) {
                    Save-CMSoftwareUpdate @save | Out-Null
                    $updates = @(Get-CMSoftwareUpdate -UpdateGroupName $SugName -Fast -ErrorAction Stop)
                    $stillMissing = @($updates | Where-Object { -not $_.IsContentProvisioned -and -not $_.IsExpired })
                    if ($stillMissing.Count -gt 0) {
                        throw "$($stillMissing.Count) updates are still not downloaded: $(($stillMissing | Select-Object -First 10 | ForEach-Object { "KB$($_.ArticleID)" }) -join ', ')"
                    }
                } elseif (-not $WhatIfPreference) { throw 'Download cancelled by operator.' }
            } else {
                Write-Host 'All updates in the SUG are downloaded.'
            }

            # Packages that hold the SUG content. If SCCM refuses these queries, warn and continue:
            # the content is already downloaded, and the install monitoring shows if clients cannot get it.
            $packageIds = @()
            try {
                $ciContent = Invoke-SmsQueryIn -CimSession $sms -SiteCode $siteCode `
                    -Select 'SELECT CI_ID, ContentID FROM SMS_CIToContent' -Field 'CI_ID' -Values @($SugCiIds)
                $packageRows = Invoke-SmsQueryIn -CimSession $sms -SiteCode $siteCode `
                    -Select 'SELECT ContentID, PackageID FROM SMS_PackageToContent' -Field 'ContentID' -Values @($ciContent | ForEach-Object { $_.ContentID })
                $packageIds = @($packageRows | ForEach-Object { [string]$_.PackageID } | Sort-Object -Unique)
                if ($packageIds.Count -eq 0 -and -not $WhatIfPreference) { throw 'No deployment package contains the SUG content.' }
                Write-Host "Content is in $($packageIds.Count) deployment package(s): $($packageIds -join ', ')"
            } catch {
                Write-Warning ("Could not determine the content packages ($($_.Exception.Message)). Distribution status is NOT verified; " +
                    'check Monitoring > Distribution Status > Content Status for the SUG package before the window opens.')
                $packageIds = @()
                $summary.ContentPackages = 'NOT VERIFIED'
            }

            foreach ($packageId in $packageIds) {
                $status = Get-CMDistributionStatus -Id $packageId -ErrorAction SilentlyContinue
                $targeted = [int](Get-PropertyValue $status 'Targeted')
                if ($targeted -eq 0) {
                    if (-not $DistributionPointGroupName) {
                        throw "Package $packageId is not on any distribution point. Give -DistributionPointGroupName or set it in Settings.json."
                    }
                    if ($PSCmdlet.ShouldProcess("package $packageId", "Distribute to DP group '$DistributionPointGroupName'")) {
                        Start-CMContentDistribution -DeploymentPackageId $packageId -DistributionPointGroupName $DistributionPointGroupName -ErrorAction Stop
                    } elseif (-not $WhatIfPreference) { throw 'Distribution cancelled by operator.' }
                }
            }

            if (-not $WhatIfPreference -and $packageIds.Count -gt 0) {
                $stopAt = (Get-Date).AddMinutes($ContentTimeoutMinutes)
                while ($true) {
                    $rows = foreach ($packageId in $packageIds) {
                        $status = Get-CMDistributionStatus -Id $packageId -ErrorAction SilentlyContinue
                        [pscustomobject]@{
                            PackageID = $packageId
                            Targeted = [int](Get-PropertyValue $status 'Targeted')
                            Success = [int](Get-PropertyValue $status 'NumberSuccess')
                            InProgress = [int](Get-PropertyValue $status 'NumberInProgress')
                            Errors = [int](Get-PropertyValue $status 'NumberErrors')
                            Unknown = [int](Get-PropertyValue $status 'NumberUnknown')
                        }
                    }
                    $rows | Format-Table -AutoSize | Out-Host
                    $failedPackages = @($rows | Where-Object { $_.Errors -gt 0 })
                    if ($failedPackages.Count -gt 0) {
                        throw "Content distribution failed for: $(($failedPackages | ForEach-Object { $_.PackageID }) -join ', '). Check Monitoring > Distribution Status > Content Status."
                    }
                    if (@($rows | Where-Object { $_.Targeted -eq 0 -or $_.Success -lt $_.Targeted }).Count -eq 0) {
                        Write-Host 'Content is distributed to every targeted DP.' -ForegroundColor Green
                        break
                    }
                    if ((Get-Date) -gt $stopAt) { throw "Content distribution not finished after $ContentTimeoutMinutes minutes." }
                    Start-Sleep -Seconds $PollSeconds
                }
                $summary.ContentPackages = @($rows)
            }
        }
        Save-State 'Content'

        # --------------------------------------------------------
        Write-Step '4. Maintenance window'
        # --------------------------------------------------------
        $parseWindowStart = {
            [datetime]::ParseExact($MaintenanceWindowStartUtc, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
        }
        if (-not $SkipMaintenanceWindow) {
            if (-not $MaintenanceWindowStartUtc) {
                # Only previews get here without being asked: assume 30 minutes from now.
                $MaintenanceWindowStartUtc = [datetime]::UtcNow.AddMinutes(30).ToString('yyyy-MM-dd HH:mm')
            }
            $mwStart = & $parseWindowStart
            if ($mwStart.AddHours($MaintenanceWindowHours) -le [datetime]::UtcNow) {
                Write-Warning ("The maintenance window {0:yyyy-MM-dd HH:mm} UTC ({1} h) has already ended. Enter a new one." -f $mwStart, $MaintenanceWindowHours)
                Read-MaintenanceWindow -AskHours
                $mwStart = & $parseWindowStart
            }
            $mwEnd = $mwStart.AddHours($MaintenanceWindowHours)
        }

        $existingWindows = if ($collection.CollectionID -eq '(new)') { @() }   # preview of a collection not created yet
                           else { @(Get-CMMaintenanceWindow -CollectionId $collection.CollectionID -ErrorAction SilentlyContinue) }
        foreach ($w in $existingWindows) {
            Write-Host ("Existing window: {0} | {1} | enabled={2} | type={3}" -f $w.Name, $w.Description, $w.IsEnabled, $w.ServiceWindowType)
        }

        if ($SkipMaintenanceWindow) {
            if (@($existingWindows | Where-Object { $_.IsEnabled -and $_.ServiceWindowType -in 1, 4 }).Count -eq 0) {
                throw 'No enabled maintenance window for software updates; without one the updates never install (installation outside the window is disabled per SOP).'
            }
            Write-Warning 'Using existing maintenance windows; installation starts when one of them opens.'
            $mwStart = [datetime]::UtcNow
            $mwEnd = $mwStart
        } else {
            $mwName = "Patch - $DeploymentName - {0:yyyy-MM-dd HH:mm} UTC" -f $mwStart
            if (@($existingWindows | Where-Object { $_.Name -eq $mwName }).Count -gt 0) {
                Write-Host "Window '$mwName' already exists; reusing it."
            } elseif ($PSCmdlet.ShouldProcess("collection '$CollectionName'",
                    ("Create maintenance window '{0}' {1:yyyy-MM-dd HH:mm} - {2:HH:mm} UTC for software updates" -f $mwName, $mwStart, $mwEnd))) {
                $scheduleParams = @{ Start = [datetime]::SpecifyKind($mwStart, 'Unspecified'); Nonrecurring = $true; ErrorAction = 'Stop' }
                if (-not (Add-SupportedParameter $scheduleParams 'New-CMSchedule' @('IsUtc') $true)) {
                    $scheduleParams.Start = $mwStart.ToLocalTime()
                }
                if (-not (Add-SupportedParameter $scheduleParams 'New-CMSchedule' @('End') $(if ($scheduleParams.ContainsKey('IsUtc')) { [datetime]::SpecifyKind($mwEnd, 'Unspecified') } else { $mwEnd.ToLocalTime() }))) {
                    $scheduleParams.DurationInterval = 'Hours'
                    $scheduleParams.DurationCount = $MaintenanceWindowHours
                }
                $mwSchedule = New-CMSchedule @scheduleParams

                $windowParams = @{ CollectionId = $collection.CollectionID; Name = $mwName; Schedule = $mwSchedule; ErrorAction = 'Stop' }
                if (-not (Add-SupportedParameter $windowParams 'New-CMMaintenanceWindow' @('ApplyTo') 'SoftwareUpdatesOnly')) {
                    [void](Add-SupportedParameter $windowParams 'New-CMMaintenanceWindow' @('ApplyToSoftwareUpdateOnly') $true)
                }
                New-CMMaintenanceWindow @windowParams | Out-Null

                $created = @(Get-CMMaintenanceWindow -CollectionId $collection.CollectionID -ErrorAction Stop | Where-Object { $_.Name -eq $mwName })
                if ($created.Count -ne 1) { throw "Maintenance window '$mwName' was not found after creation." }
                Write-Host ("Created: {0} | {1} | UTC={2} | type={3}" -f $created[0].Name, $created[0].Description, $created[0].IsGMT, $created[0].ServiceWindowType) -ForegroundColor Green
            } elseif (-not $WhatIfPreference) { throw 'Maintenance window creation cancelled by operator.' }
        }
        $summary.MaintenanceWindow = [ordered]@{
            Name = if ($SkipMaintenanceWindow) { 'existing windows' } else { $mwName }
            StartUtc = $mwStart.ToString('o'); EndUtc = $mwEnd.ToString('o')
        }
        Save-State 'MaintenanceWindow'

        # --------------------------------------------------------
        Write-Step '5. Required deployment (SOP settings)'
        # --------------------------------------------------------
        # An existing deployment with this name is reused when resuming, or when the user agrees
        # (e.g. the window was closed or the maintenance window ran out).
        $adoptExisting = $false
        if (@(Get-CMSoftwareUpdateDeployment -Name $DeploymentName -ErrorAction SilentlyContinue).Count -gt 0) {
            if ($Resuming) {
                $adoptExisting = $true
            } elseif ($WhatIfPreference) {
                throw "A deployment named '$DeploymentName' already exists. Use another name, or -Resume to continue it."
            } else {
                $answer = (Read-Host "A deployment named '$DeploymentName' already exists. Continue with it (monitor, restart, validate)? [Y/N]").Trim()
                if ($answer -notmatch '^(y|yes)$') { throw "A deployment named '$DeploymentName' already exists. Use another name, or -Resume to continue it." }
                $adoptExisting = $true
            }
            Write-Host "Continuing with the existing deployment '$DeploymentName'." -ForegroundColor Yellow
        }

        if (-not $adoptExisting -and -not $ConfirmDeploymentName -and -not $WhatIfPreference) {
            Write-Host 'This creates a REQUIRED deployment. The updates install in the maintenance window and the servers restart.' -ForegroundColor Red
            $ConfirmDeploymentName = Read-Host "Type the deployment name to continue: $DeploymentName"
        }
        if (-not $adoptExisting -and -not $WhatIfPreference -and $ConfirmDeploymentName -cne $DeploymentName) {
            throw 'Deployment name confirmation did not match. No deployment created.'
        }

        # "As soon as possible": available now, deadline right after. Installation still waits for the window.
        # -DeadlineUtc moves the deadline (and so the installation) to a later point inside the window.
        $availableUtc = [datetime]::UtcNow
        $deadlineAt = $availableUtc.AddMinutes(1)
        if ($DeadlineUtc -and -not $adoptExisting) {
            $deadlineAt = [datetime]::ParseExact($DeadlineUtc, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
            if (-not $SkipMaintenanceWindow -and $deadlineAt -ge $mwEnd) {
                throw ("Deadline {0:yyyy-MM-dd HH:mm} UTC is not before the maintenance window end {1:yyyy-MM-dd HH:mm} UTC; nothing would install. No deployment created." -f $deadlineAt, $mwEnd)
            }
            if ($deadlineAt -le $availableUtc) { $deadlineAt = $availableUtc.AddMinutes(1) }
            Write-Host ("Deadline: {0:yyyy-MM-dd HH:mm} UTC" -f $deadlineAt)
        }
        $description = "Change=$ChangeTicket; Approver=$Approver; ApprovalRef=$ApprovalReference; SUG=$SugName; " +
            "Targets=$(($Servers | ForEach-Object { $_.Name }) -join ', ')"
        $unsupported = New-Object System.Collections.Generic.List[string]
        $deploy = @{
            SoftwareUpdateGroupName = $SugName
            CollectionName = $CollectionName
            DeploymentName = $DeploymentName
            DeploymentType = 'Required'
            AvailableDateTime = $availableUtc
            DeadlineDateTime = $deadlineAt
            TimeBasedOn = 'Utc'
            UserNotification = 'DisplaySoftwareCenterOnly'
            SoftwareInstallation = $false
            AllowRestart = $false
            ErrorAction = 'Stop'
        }
        $cmd = 'New-CMSoftwareUpdateDeployment'
        [void](Add-SupportedParameter $deploy $cmd @('Description', 'Comment') $description $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('VerbosityLevel') 'OnlySuccessAndErrorMessages' $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('SendWakeupPacket') $false $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('ProtectedType') 'NoInstall' $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('UnprotectedType') 'UnprotectedDistributionPoint' $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('DownloadFromMicrosoftUpdate') $false $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('UseMeteredNetwork') $false $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('RequirePostRebootFullScan') $false $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('AcceptEula') $true $unsupported)
        [void](Add-SupportedParameter $deploy $cmd @('DisableOperationManager', 'DisableOperationsManagerAlert') $true $unsupported)
        foreach ($u in $unsupported) { Write-Warning "Not supported by this console version (verified/fixed after creation where possible): $u" }

        $deploymentCreated = $adoptExisting
        if ($adoptExisting) {
            # Nothing to create; the settings are read back and enforced below.
        } elseif ($PSCmdlet.ShouldProcess("collection '$CollectionName'", "Create REQUIRED deployment '$DeploymentName' of '$SugName'")) {
            New-CMSoftwareUpdateDeployment @deploy | Out-Null
            $deploymentCreated = $true
        } elseif (-not $WhatIfPreference) { throw 'Deployment cancelled by operator.' }

        if (-not $deploymentCreated) {
            Write-Host "`nWhatIf: stopping before monitoring. Baseline saved in $run." -ForegroundColor Yellow
            return
        }

        # Read the deployment back and enforce the SOP settings that matter most.
        $escapedName = $DeploymentName -replace "'", "\'"
        $assignment = @(Invoke-SmsQuery -CimSession $sms -SiteCode $siteCode -Query "SELECT * FROM SMS_UpdatesAssignment WHERE AssignmentName = '$escapedName'")
        if ($assignment.Count -ne 1) { throw "Deployment '$DeploymentName' not found after creation. Check SCCM before retrying." }
        $targetCollectionId = [string](Get-PropertyValue $assignment[0] 'TargetCollectionID')
        if ($adoptExisting -and $targetCollectionId -and $targetCollectionId -ne $collection.CollectionID) {
            throw "Existing deployment '$DeploymentName' targets collection $targetCollectionId, not '$CollectionName' ($($collection.CollectionID)). Use another deployment name."
        }
        $full = $assignment[0] | Get-CimInstance   # loads lazy properties so an update keeps them

        $desired = [ordered]@{
            OverrideServiceWindows = $false          # no installation outside the window
            RebootOutsideOfServiceWindows = $false   # no restart outside the window
            SuppressReboot = 0                       # restarts allowed on servers and workstations
            DisableMomAlerts = $true                 # Operations Manager alerts off while installing
            UseGMTTimes = $true                      # UTC
        }
        $changes = @{}
        foreach ($key in $desired.Keys) {
            $property = $full.CimInstanceProperties[$key]
            if (-not $property) { Write-Warning "Deployment has no property $key; check it in the console."; continue }
            $want = $desired[$key]
            if ($null -ne $property.Value) { $want = [System.Management.Automation.LanguagePrimitives]::ConvertTo($want, $property.Value.GetType()) }
            if ($property.Value -ne $want) { $changes[$key] = $want }
        }
        if ($changes.Count -gt 0) {
            Write-Host "Correcting deployment settings: $(($changes.Keys | ForEach-Object { "$_=$($changes[$_])" }) -join ', ')"
            Set-CimInstance -InputObject $full -Property $changes -ErrorAction Stop
        }

        $check = (Invoke-SmsQuery -CimSession $sms -SiteCode $siteCode -Query "SELECT * FROM SMS_UpdatesAssignment WHERE AssignmentName = '$escapedName'")[0]
        $wrong = @($desired.Keys | Where-Object {
            $p = $check.CimInstanceProperties[$_]
            $p -and ($null -eq $p.Value -or
                $p.Value -ne [System.Management.Automation.LanguagePrimitives]::ConvertTo($desired[$_], $p.Value.GetType()))
        })
        if ($wrong.Count -gt 0) {
            $disable = $check | Get-CimInstance
            Set-CimInstance -InputObject $disable -Property @{ Enabled = $false } -ErrorAction SilentlyContinue
            throw "Deployment settings could not be set ($($wrong -join ', ')). The deployment was DISABLED; fix it in the console before enabling it."
        }

        $assignmentId = [int]$check.AssignmentID
        $deploymentInfo = [ordered]@{
            AssignmentID = $assignmentId
            Enabled = $check.Enabled
            StartTime = "$($check.StartTime)"
            EnforcementDeadline = "$($check.EnforcementDeadline)"
            UseGMTTimes = $check.UseGMTTimes
            OverrideServiceWindows = $check.OverrideServiceWindows
            RebootOutsideOfServiceWindows = $check.RebootOutsideOfServiceWindows
            SuppressReboot = $check.SuppressReboot
            DisableMomAlerts = $check.DisableMomAlerts
            StateMessageVerbosity = Get-PropertyValue $check 'StateMessageVerbosity'
            DPLocality = Get-PropertyValue $check 'DPLocality'
        }
        [pscustomobject]$deploymentInfo | Format-List | Out-Host
        $summary.Deployment = $deploymentInfo
        Save-State 'Deployment'

        # --------------------------------------------------------
        Write-Step '6. Install: trigger clients and monitor'
        # --------------------------------------------------------
        foreach ($action in 'ClientNotificationRequestMachinePolicyNow', 'ClientNotificationSUMDeplEvalNow') {
            try {
                Invoke-CMClientNotification -DeviceCollectionId $collection.CollectionID -ActionType $action -ErrorAction Stop | Out-Null
            } catch { Write-Warning "Client notification $action failed: $($_.Exception.Message)" }
        }
        foreach ($s in $Servers) { Invoke-ClientSchedule $s @($Schedule.MachinePolicy, $Schedule.MachinePolicyEval) }

        # Installation starts at the window start, or at the deadline when that is later.
        $installFrom = $mwStart
        $waitingFor = 'the maintenance window'
        if ($DeadlineUtc) {
            $deadlineStart = [datetime]::ParseExact($DeadlineUtc, 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
            if ($deadlineStart -gt $installFrom) { $installFrom = $deadlineStart; $waitingFor = 'the deployment deadline' }
        }
        while ([datetime]::UtcNow -lt $installFrom) {
            $minutes = [math]::Ceiling(($installFrom - [datetime]::UtcNow).TotalMinutes)
            Write-Host ("[{0:HH:mm:ss}] Waiting for {1} at {2:yyyy-MM-dd HH:mm} UTC ({3} min)" -f (Get-Date), $waitingFor, $installFrom, $minutes)
            Start-Sleep -Seconds ([math]::Min($PollSeconds, [math]::Max(5, ($installFrom - [datetime]::UtcNow).TotalSeconds)))
        }
        foreach ($s in $Servers) { Invoke-ClientSchedule $s @($Schedule.MachinePolicy, $Schedule.UpdateDeployEval) }

        $stopAt = (Get-Date).AddMinutes($InstallTimeoutMinutes)
        $kick = 0
        while ($true) {
            try {
                $assetRows = @(Invoke-SmsQuery -CimSession $sms -SiteCode $siteCode -Query "SELECT * FROM SMS_SUMDeploymentAssetDetails WHERE AssignmentID = $assignmentId")
            } catch {
                $assetRows = @()
                Write-Warning "Deployment status query failed: $($_.Exception.Message). Check Monitoring > Deployments > $DeploymentName."
            }
            foreach ($s in @($Servers | Where-Object { $_.State -in 'PENDING', 'INSTALLING' })) {
                $asset = $assetRows | Where-Object { [int](Get-PropertyValue $_ 'ResourceID') -eq $s.ResourceId } | Select-Object -First 1
                $statusType = [int](Get-PropertyValue $asset 'StatusType')       # 1 success, 2 in progress, 3 req. not met, 4 unknown, 5 error
                $statusText = Get-AssetStatusText $asset
                if ($statusType -eq 1) { $s.SccmCompliant = $true }

                $evidence = Get-TargetEvidence $s
                if ($evidence) {
                    $missing = @($s.RequiredBefore | Where-Object { -not (Test-KbInstalled $evidence $_) })
                    if ($missing.Count -eq 0) {
                        $s.State = if ($evidence.RebootPending) { 'INSTALLED_PENDING_RESTART' } else { 'INSTALLED' }
                        $s.StateDetail = $statusText
                    } elseif ($statusType -eq 5) {
                        $s.State = 'FAILED'; $s.StateDetail = "$statusText; still missing: $(($missing | ForEach-Object { "KB$_" }) -join ', ')"
                    } else {
                        $s.State = 'INSTALLING'; $s.StateDetail = "$($missing.Count) KB(s) left; SCCM: $statusText"
                    }
                } else {
                    switch ($statusType) {
                        1 { $s.State = 'INSTALLED'; $s.StateDetail = "SCCM: $statusText" }
                        5 { $s.State = 'FAILED'; $s.StateDetail = "SCCM: $statusText" }
                        default {
                            if ($statusText -match 'restart|reboot') { $s.State = 'INSTALLED_PENDING_RESTART' } else { $s.State = 'INSTALLING' }
                            $s.StateDetail = "SCCM: $statusText"
                            if (-not $statusText -or $statusText -match 'unknown') {
                                # The client has not reported on this deployment yet; show when it last fetched policy.
                                $lastPolicy = try { (Get-CMDevice -ResourceId $s.ResourceId -Fast -ErrorAction Stop).LastPolicyRequest } catch { $null }
                                $s.StateDetail = "SCCM: $(if ($statusText) { $statusText } else { 'no status yet' }) - client has not reported on this deployment yet" +
                                    $(if ($lastPolicy) { "; last policy request $lastPolicy" } else { '' })
                            }
                        }
                    }
                }
            }

            # Written straight to the console so it shows immediately, also when run via Run-Patching.ps1.
            Write-Host ("`n[{0:HH:mm:ss}] Installation status (check every {1} s, gives up at {2:HH:mm}):" -f (Get-Date), $PollSeconds, $stopAt) -ForegroundColor Cyan
            foreach ($s in $Servers) {
                $color = switch ($s.State) {
                    { $_ -in 'INSTALLED', 'ALREADY_COMPLIANT' } { 'Green' }
                    'FAILED' { 'Red' }
                    'INSTALLED_PENDING_RESTART' { 'Yellow' }
                    default { 'Gray' }
                }
                Write-Host ("  {0,-34} {1,-26} {2}" -f $s.Fqdn, $s.State, $s.StateDetail) -ForegroundColor $color
            }
            if (@($Servers | Where-Object { $_.State -in 'PENDING', 'INSTALLING' }).Count -eq 0) { break }
            if ((Get-Date) -gt $stopAt) {
                Write-Warning "Installation not finished after $InstallTimeoutMinutes minutes."
                break
            }
            # Nudge unfinished clients every few polls: over WinRM when possible, otherwise through
            # SCCM's client notification channel (works without WinRM).
            if ((++$kick % 3) -eq 0) {
                foreach ($s in @($Servers | Where-Object { $_.State -in 'PENDING', 'INSTALLING' })) {
                    if ($s.RemoteOk) {
                        Invoke-ClientSchedule $s @($Schedule.MachinePolicy, $Schedule.UpdateDeployEval)
                    } else {
                        Send-ClientNotification $s 'ClientNotificationRequestMachinePolicyNow'
                        Send-ClientNotification $s 'ClientNotificationSUMDeplEvalNow'
                    }
                }
            }
            Save-State 'Deployment'   # keeps install progress for -Resume
            Start-Sleep -Seconds $PollSeconds
        }
        Save-State 'Installed'

        # --------------------------------------------------------
        Write-Step "7. Restart (mode: $RestartMode)"
        # --------------------------------------------------------
        foreach ($s in @($Servers | Where-Object { $_.State -eq 'INSTALLED_PENDING_RESTART' })) {
            switch ($RestartMode) {
                'Script' {
                    if (-not $s.RemoteOk) {
                        Write-Warning "$($s.Fqdn): no WinRM access, so the script cannot restart it; the SCCM client will (restarts are allowed in the window)."
                        Wait-SccmRestart $s
                        continue
                    }
                    if ($PSCmdlet.ShouldProcess($s.Fqdn, 'Restart server to complete patching')) {
                        Write-Host "Restarting $($s.Fqdn)..."
                        # WSMan: Windows PowerShell 5.1 otherwise sends the restart over DCOM (RPC 135),
                        # which is blocked from the jumphost; the rest of the script uses WinRM too.
                        $restart = @{
                            ComputerName = $s.Fqdn; Protocol = 'WSMan'; Force = $true; Wait = $true; For = 'PowerShell'
                            Timeout = $RestartTimeoutMinutes * 60; Delay = 15; ErrorAction = 'Stop'
                        }
                        if ($TargetCredential) { $restart.Credential = $TargetCredential }
                        try {
                            Restart-Computer @restart
                            $s.Restarted = $true
                            Write-Host "$($s.Fqdn) is back online." -ForegroundColor Green
                        } catch {
                            Write-Warning "$($s.Fqdn): restart did not complete: $($_.Exception.Message)"
                        }
                    }
                }
                'Sccm' { Wait-SccmRestart $s }
                'None' { Write-Warning "$($s.Fqdn): restart pending; not restarted (RestartMode None)." }
            }
        }

        Save-State 'Restarted'

        # After restarts: rescan and send state messages so SCCM compliance catches up.
        foreach ($s in $Servers) { Invoke-ClientSchedule $s @($Schedule.UpdateScan, $Schedule.StateMessages) }
        Start-Sleep -Seconds 60
    }

    # ------------------------------------------------------------
    Write-Step '8. Validate each KB on each server'
    # ------------------------------------------------------------
    if ($Mode -eq 'ValidateOnly') {
        foreach ($s in $Servers) { Invoke-ClientSchedule $s @($Schedule.UpdateScan, $Schedule.StateMessages) }
    }

    $stopAt = (Get-Date).AddMinutes($ComplianceTimeoutMinutes)
    while ($true) {
        $compliance = Get-Compliance
        $allRows = New-Object System.Collections.Generic.List[object]
        foreach ($s in $Servers) {
            $evidence = Get-TargetEvidence $s
            $rows = @(Get-ValidationRows $compliance $s $evidence)
            foreach ($r in $rows) { $allRows.Add($r) }

            $missing = @($rows | Where-Object { $_.Result -eq 'MISSING' })
            $unknown = @($rows | Where-Object { $_.Result -eq 'UNKNOWN' })
            $s.Verdict = if ($missing.Count -gt 0) { 'NOT_PATCHED' }
                         elseif ($evidence -and $evidence.RebootPending) { 'PENDING_RESTART' }
                         elseif (-not $evidence -and ($unknown.Count -gt 0 -or $rows.Count -eq 0)) { if ($s.SccmCompliant) { 'PATCHED' } else { 'UNVERIFIED' } }
                         else { 'PATCHED' }
            $s.StateDetail = if ($evidence) { "$($evidence.OS) build $($evidence.Build); last boot $($evidence.LastBootUpTime)" }
                             elseif ($s.SccmCompliant) { 'Compliant per SCCM deployment status (no per-KB data: no remote access / compliance query)' }
                             else { "No remote access: $($s.RemoteError)" }
        }

        # Done when SCCM agrees with the servers, or when nothing is left to wait for.
        $sccmBehind = @($allRows | Where-Object { $_.Note }).Count -gt 0
        if (-not $sccmBehind -or (Get-Date) -gt $stopAt) { break }
        Write-Host ("[{0:HH:mm:ss}] Servers report the updates installed; waiting for SCCM compliance to catch up..." -f (Get-Date))
        Start-Sleep -Seconds $PollSeconds
    }

    $allRows | Sort-Object Server, Result, KB | Format-Table Server, KB, Result, SccmStatus, Evidence, Note -AutoSize -Wrap | Out-Host
    $allRows | Export-Csv (Join-Path $run 'Validation_KBs.csv') -NoTypeInformation -Encoding UTF8 -WhatIf:$false

    Write-Host 'Server verdicts' -ForegroundColor Cyan
    $Servers | Select-Object Fqdn, Verdict, Restarted, StateDetail | Format-Table -AutoSize -Wrap | Out-Host
    $summary.Results = @(foreach ($s in $Servers) {
        [ordered]@{
            Server = $s.Fqdn
            Verdict = $s.Verdict
            AlreadyCompliant = $s.AlreadyCompliant
            InstallState = $s.State
            Restarted = $s.Restarted
            RequiredKbsBefore = @($s.RequiredBefore | ForEach-Object { "KB$_" })
            MissingKbs = @($allRows | Where-Object { $_.Server -eq $s.Fqdn -and $_.Result -eq 'MISSING' } | ForEach-Object { $_.KB })
            NotFoundKbs = @($allRows | Where-Object { $_.Server -eq $s.Fqdn -and $_.Result -eq 'NOT_FOUND' } | ForEach-Object { $_.KB })
            Detail = $s.StateDetail
        }
    })
    if (@($Servers | Where-Object { $_.Verdict -ne 'PATCHED' }).Count -gt 0) { $exitCode = 1 }
    Save-State 'Done'
}
catch {
    $exitCode = 2
    $summary.Error = $_.Exception.Message
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $run 'Summary.json') -Encoding UTF8 -WhatIf:$false
    if ($sms) { Remove-CimSession $sms -ErrorAction SilentlyContinue -WhatIf:$false }
    if ($pushed) { Pop-Location }
    Write-Host "`nReports: $run"
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}

exit $exitCode
