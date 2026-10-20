#requires -Version 5.1
<#
.SYNOPSIS
Operator client for the SCCM Patching Automation API. Run it on the Cloud PC.

.DESCRIPTION
Collects the operator's inputs, submits each step to the API as a job and
polls the job until it finishes:
  1. Inventory  - lists software update groups (SUGs) and device collections.
  2. Dry run    - read-only check of the chosen SUG and collection.
  3. Deployment - (-Mode Deploy only) creates a Required deployment.

Inputs can be typed at the prompts, picked from a grid window, or supplied in
a JSON file with -InputFile (see deployment-input.example.json). A value in the
file skips its prompt. The two final deployment confirmations are always typed
by the operator.

.EXAMPLE
.\Invoke-SccmPatchingClient.ps1 -Mode DryRun

.EXAMPLE
.\Invoke-SccmPatchingClient.ps1 -Mode Deploy -InputFile .\deployment-input.json

.EXAMPLE
.\Invoke-SccmPatchingClient.ps1 -JobId 'abc123'   # check one job again
#>

[CmdletBinding()]
param(
    [ValidateSet('DryRun', 'Deploy')]
    [string]$Mode = 'DryRun',

    [string]$ApiBaseUrl = 'http://127.0.0.1:8000',

    [string]$ApiKey = $env:SCCM_API_KEY,

    [string]$InputFile,

    [string]$JobId,

    [ValidateRange(2, 120)]
    [int]$PollSeconds = 30,

    [ValidateRange(1, 600)]
    [int]$MaxWaitMinutes = 90,

    [switch]$NoGui
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw 'Set $env:SCCM_API_KEY or pass -ApiKey.'
}

$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')
$ReportRoot = Join-Path $PSScriptRoot 'ClientReports'

$inputs = @{}
if ($InputFile) {
    $fileData = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
    foreach ($property in $fileData.PSObject.Properties) {
        if (-not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
            $inputs[$property.Name] = ([string]$property.Value).Trim()
        }
    }
}

# ============================================================
# API helpers
# ============================================================

function Invoke-Api {
    param(
        [string]$Method,
        [string]$Path,
        $Body,
        [string]$IdempotencyKey
    )

    $headers = @{ 'X-API-Key' = $ApiKey }
    if ($IdempotencyKey) { $headers['Idempotency-Key'] = $IdempotencyKey }

    $request = @{
        Uri = "$ApiBaseUrl$Path"
        Method = $Method
        Headers = $headers
        TimeoutSec = 180
    }
    if ($null -ne $Body) {
        $request.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10))
        $request.ContentType = 'application/json; charset=utf-8'
    }

    try {
        Invoke-RestMethod @request
    }
    catch {
        $detail = $_.ErrorDetails.Message
        if (-not $detail) { $detail = $_.Exception.Message }
        throw "API $Method $Path failed: $detail"
    }
}

# Polls until the job leaves QUEUED/RUNNING and returns its final state.
function Wait-ApiJob {
    param($Job)

    $stopAt = (Get-Date).AddMinutes($MaxWaitMinutes)
    Write-Host "Job $($Job.job_id) ($($Job.kind)) is $($Job.status)." -ForegroundColor Cyan

    while ($Job.status -in @('QUEUED', 'RUNNING')) {
        if ((Get-Date) -gt $stopAt) {
            throw ("Stopped waiting after $MaxWaitMinutes minutes; the job is still " +
                "$($Job.status) on the API. Check it later with -JobId $($Job.job_id).")
        }
        # The API holds the request until the job finishes or the wait ends.
        $Job = Invoke-Api GET "/api/jobs/$($Job.job_id)?wait=$PollSeconds"
        Write-Host ('  [{0:HH:mm:ss}] {1}' -f (Get-Date), $Job.status)
    }

    foreach ($warning in @($Job.result.warnings)) {
        if ($warning) { Write-Warning $warning }
    }
    return $Job
}

function Assert-JobSucceeded {
    param($Job)

    if ($Job.status -ne 'SUCCEEDED') {
        $errors = @($Job.result.errors) -join "`n"
        throw "Job $($Job.job_id) ended as $($Job.status).`n$errors"
    }
}

function Save-JobReport {
    param($Job)

    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmssZ')
    $path = Join-Path $ReportRoot "$($Job.kind)_$($stamp)_$($Job.job_id).json"
    $Job | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8
    Write-Host "Saved: $path"
}

# ============================================================
# Input helpers
# ============================================================

function Read-Input {
    param([string]$Key, [string]$Prompt)

    if ($inputs.ContainsKey($Key)) {
        Write-Host "${Prompt}: $($inputs[$Key])  (from input file)"
        return $inputs[$Key]
    }
    do { $value = (Read-Host $Prompt).Trim() } while (-not $value)
    return $value
}

# Accepts 'yyyy-MM-dd HH:mm' in UTC and returns ISO 8601 with a Z suffix.
function Read-UtcInput {
    param([string]$Key, [string]$Prompt)

    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor
        [Globalization.DateTimeStyles]::AdjustToUniversal

    while ($true) {
        $raw = Read-Input $Key "$Prompt (yyyy-MM-dd HH:mm, UTC)"
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParseExact($raw, 'yyyy-MM-dd HH:mm',
                [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
            return $parsed.ToString("yyyy-MM-dd'T'HH:mm:00'Z'")
        }
        if ($inputs.ContainsKey($Key)) {
            throw "Input file value for '$Key' must use yyyy-MM-dd HH:mm."
        }
        Write-Warning 'Invalid date/time. Example: 2026-10-20 06:00'
    }
}

function Select-Item {
    param([object[]]$Items, [string]$Title, [string]$Key)

    if ($Items.Count -eq 0) { throw "The inventory returned no ${Title}s." }

    if ($inputs.ContainsKey($Key)) {
        $match = @($Items | Where-Object { [string]$_.id -eq $inputs[$Key] })
        if ($match.Count -ne 1) {
            throw "$Title ID '$($inputs[$Key])' from the input file is not in the inventory."
        }
        Write-Host "$($Title): $($match[0].name) [$($match[0].id)]  (from input file)"
        return $match[0]
    }

    if (-not $NoGui -and (Get-Command Out-GridView -ErrorAction SilentlyContinue)) {
        $picked = @($Items | Out-GridView -Title "Select one $Title" -OutputMode Single)
        if ($picked.Count -ne 1) { throw "No $Title selected." }
        Write-Host "$($Title): $($picked[0].name) [$($picked[0].id)]"
        return $picked[0]
    }

    while ($true) {
        $filter = Read-Host "Filter ${Title}s by name (Enter to list all)"
        $shown = @($Items | Where-Object { -not $filter -or $_.name -like "*$filter*" })
        if ($shown.Count -eq 0) {
            Write-Warning 'No matches.'
            continue
        }
        for ($i = 0; $i -lt $shown.Count; $i++) {
            Write-Host ('{0,4}. {1} [{2}]' -f ($i + 1), $shown[$i].name, $shown[$i].id)
        }
        $raw = Read-Host "Choose the $Title number (Enter to filter again)"
        $number = 0
        if ([int]::TryParse($raw, [ref]$number) -and $number -ge 1 -and $number -le $shown.Count) {
            return $shown[$number - 1]
        }
    }
}

# ============================================================
# Check a single job
# ============================================================

if ($JobId) {
    $job = Wait-ApiJob (Invoke-Api GET "/api/jobs/$JobId")
    $job | ConvertTo-Json -Depth 10
    return
}

# ============================================================
# Step 1: inventory
# ============================================================

Write-Host "`nStep 1 of $(if ($Mode -eq 'Deploy') { 3 } else { 2 }): SCCM inventory" -ForegroundColor Yellow
$inventory = Wait-ApiJob (Invoke-Api POST '/api/sccm/dry-run/start')
Assert-JobSucceeded $inventory
Write-Host ("Site {0} (version {1}): {2} SUGs, {3} device collections." -f
    $inventory.result.site, $inventory.result.site_version,
    @($inventory.result.sugs).Count, @($inventory.result.collections).Count)

$sug = Select-Item @($inventory.result.sugs) 'software update group' 'sug_id'
$collection = Select-Item @($inventory.result.collections) 'device collection' 'collection_id'

# ============================================================
# Step 2: read-only dry run
# ============================================================

Write-Host "`nStep 2: read-only dry run" -ForegroundColor Yellow
$dryRun = Wait-ApiJob (Invoke-Api POST '/api/sccm/dry-run/continue' @{
    run_id = $inventory.job_id
    sug_id = [string]$sug.id
    collection_id = [string]$collection.id
})
Save-JobReport $dryRun
Assert-JobSucceeded $dryRun

$plan = $dryRun.result
[pscustomobject]@{
    SUG = "$($plan.selected_sug) [$($plan.selected_sug_id)]"
    Collection = "$($plan.selected_collection) [$($plan.selected_collection_id)]"
    Targets = @($plan.targets) -join ', '
    UpdateCount = $plan.update_count
} | Format-List

@($plan.updates) | Select-Object -First 20 article_id, title | Format-Table -AutoSize
if ($plan.update_count -gt 20) { Write-Host "... $($plan.update_count - 20) more in the saved report." }

Write-Host 'Dry run passed. No SCCM objects were created or changed.' -ForegroundColor Green

if ($Mode -ne 'Deploy') {
    Write-Host "To create the deployment, run again with -Mode Deploy." -ForegroundColor Cyan
    return
}

# ============================================================
# Step 3: Required deployment
# ============================================================

Write-Host "`nStep 3: Required deployment" -ForegroundColor Yellow
$health = Invoke-Api GET '/health'
if (-not $health.deployment_enabled) {
    throw 'Deployment is disabled on the API (SCCM_ALLOW_DEPLOYMENT is not true). No deployment created.'
}

$changeTicket = Read-Input 'change_ticket' 'Approved change ticket / CRQ'
$approver = Read-Input 'approver' 'Approver name or corporate ID'
$approvalReference = Read-Input 'approval_reference' 'Approval record/reference'
$availableUtc = Read-UtcInput 'available_utc' 'Availability'
$deadlineUtc = Read-UtcInput 'deadline_utc' 'Installation deadline'
$deploymentName = Read-Input 'deployment_name' 'Unique deployment name'

Write-Host "`nREVIEW DEPLOYMENT" -ForegroundColor Yellow
[pscustomobject]@{
    DeploymentName = $deploymentName
    DeploymentType = 'Required'
    SUG = $plan.selected_sug
    UpdateCount = $plan.update_count
    Collection = $plan.selected_collection
    Targets = @($plan.targets) -join ', '
    AvailableUtc = $availableUtc
    DeadlineUtc = $deadlineUtc
    AllowRestart = $false
    ChangeTicket = $changeTicket
    Approver = $approver
    ApprovalReference = $approvalReference
} | Format-List

Write-Host ('REQUIRED HUMAN GATES: approved ticket and SUG; DP content distributed; ' +
    'client health and pending reboot reviewed; maintenance window and deadline approved; ' +
    'site/console compatibility confirmed; application owners notified.') -ForegroundColor Yellow
$ready = Read-Host 'Have all checks been completed and approved? Type YES'
if ($ready -cne 'YES') { throw 'Approval gates not confirmed. No deployment created.' }

Write-Host ('This creates a NEW REQUIRED deployment. SCCM will enforce applicable updates ' +
    'by the deadline. SCCM-initiated restart is disabled.') -ForegroundColor Red
$final = Read-Host "Type the exact deployment name to create it: $deploymentName"
if ($final -cne $deploymentName) { throw 'Final confirmation did not match. No deployment created.' }

$idempotencyKey = [guid]::NewGuid().ToString()
$body = @{
    dry_run_job_id = $dryRun.job_id
    deployment_name = $deploymentName
    available_utc = $availableUtc
    deadline_utc = $deadlineUtc
    change_ticket = $changeTicket
    approver = $approver
    approval_reference = $approvalReference
    readiness_confirmed = $true
    final_confirmation = $final
}

$deployment = Invoke-Api POST '/api/sccm/deployments' $body $idempotencyKey
Write-Host "Idempotency-Key: $idempotencyKey  (job $($deployment.job_id))"
$deployment = Wait-ApiJob $deployment
Save-JobReport $deployment

switch ($deployment.status) {
    'SUCCEEDED' {
        Write-Host "`nRequired deployment '$deploymentName' created." -ForegroundColor Green
        Write-Host 'Monitor it in SCCM: Monitoring > Deployments. Creation is not installation success.'
    }
    'OUTCOME_UNKNOWN' {
        Write-Warning ("The API could not confirm whether '$deploymentName' was created: " +
            (@($deployment.result.errors) -join ' '))
        Write-Host 'Checking SCCM for the deployment name...' -ForegroundColor Cyan
        $lookup = Wait-ApiJob (Invoke-Api POST '/api/sccm/deployments/lookup' @{
            deployment_name = $deploymentName
        })
        Assert-JobSucceeded $lookup
        if ($lookup.result.exists) {
            Write-Host "The deployment EXISTS in SCCM. Do not create it again." -ForegroundColor Yellow
            @($lookup.result.deployments) | Format-List
        }
        else {
            Write-Host 'No deployment with that name exists in SCCM. Review the error before trying again.' -ForegroundColor Yellow
        }
    }
    default {
        Assert-JobSucceeded $deployment
    }
}
