#requires -Version 5.1
<#
Creates a NEW Required SCCM software update deployment for the two allowlisted test servers.
- Does not modify/delete the previously created Available deployment.
- Uses an existing, explicitly selected collection; does not create collections.
- Validates evaluated membership contains exactly the two allowlisted devices.
- Requires a real change ticket, approver, approval reference, future UTC availability/deadline,
  human confirmation of DP/content/client checks, and exact final deployment-name confirmation.
- SCCM-initiated restarts are suppressed using AllowRestart=$false and RestartServer/Workstation=$false.
- Does not prove content readiness; operator must verify it before confirming.
- Requires compatible Configuration Manager console/module and existing T01: CMSite drive.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$SiteCode = 'T01'
$SiteServer = 'ORDPGBLSCCM11.global.cdk.com'
$AllowedNames = @('C03DGHHYPV8871', 'C03DGHHYPV3621')
$ProjectRoot = 'C:\Users\soniyoge1\Downloads\SCCM_EndToEnd_Automation_Test_Package\SCCM_EndToEnd_Automation'
$ReportRoot = Join-Path $ProjectRoot 'Reports'

function Read-RequiredText([string]$Prompt) {
    do { $value = (Read-Host $Prompt).Trim() } while ([string]::IsNullOrWhiteSpace($value))
    return $value
}

function Read-UtcDateTime([string]$Prompt) {
    while ($true) {
        $raw = Read-RequiredText "$Prompt (format yyyy-MM-dd HH:mm, UTC)"
        $parsed = [datetime]::MinValue
        $ok = [datetime]::TryParseExact(
            $raw,
            'yyyy-MM-dd HH:mm',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal,
            [ref]$parsed
        )
        if ($ok) { return [datetime]::SpecifyKind($parsed, [DateTimeKind]::Utc) }
        Write-Warning 'Invalid date/time. Use yyyy-MM-dd HH:mm, for example 2026-10-17 06:00.'
    }
}

function Write-JsonReport($Object, [string]$Path) {
    $Object | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $ProjectRoot)) {
    throw "Project folder not found: $ProjectRoot. Update `$ProjectRoot in the script if your folder differs."
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'Reports'))) {
    New-Item -ItemType Directory -Path $ReportRoot -Force | Out-Null
}

$modulePath = 'C:\Program Files (x86)\Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager\ConfigurationManager.psd1'
if (-not (Test-Path -LiteralPath $modulePath)) { throw "Configuration Manager module not found: $modulePath" }
Import-Module $modulePath -ErrorAction Stop

$drive = Get-PSDrive -Name $SiteCode -ErrorAction SilentlyContinue
if (-not $drive) {
    throw "Drive $SiteCode`: is not present. Resolve the console/site version mismatch with your SCCM administrator and connect to the site drive. This script will not bypass the version check."
}
if ($drive.Provider.Name -ne 'CMSite' -or $drive.Root -ne $SiteServer) {
    throw "Drive $SiteCode`: does not point to the expected CMSite provider/root ($SiteServer)."
}
Set-Location "$SiteCode`:"
$site = Get-CMSite -ErrorAction Stop
if ($site.SiteCode -ne $SiteCode) { throw "Unexpected site '$($site.SiteCode)'." }

Write-Host "`nConnected to $($site.SiteName) ($($site.SiteCode)); site version $($site.Version)" -ForegroundColor Cyan
Write-Host 'Only these devices may be targeted:' -ForegroundColor Cyan
$AllowedNames | ForEach-Object { Write-Host "  $_" }

# Ensure each target resolves to one unique SCCM record.
$resolved = @()
foreach ($name in $AllowedNames) {
    $found = @(Get-CMDevice -Name $name -Fast -ErrorAction Stop)
    if ($found.Count -ne 1) {
        throw "Expected one SCCM device record for '$name'; found $($found.Count). No deployment created."
    }
    $resolved += $found[0]
}
$resolvedNames = @($resolved | ForEach-Object { $_.Name.ToUpperInvariant() } | Sort-Object -Unique)
if ($resolvedNames.Count -ne 2) { throw 'Allowlist did not resolve to exactly two unique devices.' }
$resolved | Select-Object Name, ResourceId, Domain, Client, IsActive | Format-Table -AutoSize

$changeTicket = Read-RequiredText 'Approved change ticket / CRQ (must be real and approved)'
$approver = Read-RequiredText 'Approver name or corporate ID'
$approvalReference = Read-RequiredText 'Approval record/reference (record only; does not grant approval)'

# Select SUG.
$sugs = @(Get-CMSoftwareUpdateGroup -ErrorAction Stop | Sort-Object LocalizedDisplayName)
if ($sugs.Count -eq 0) { throw 'No SUGs returned from SCCM.' }
Write-Host "`nAvailable Software Update Groups:" -ForegroundColor Cyan
for ($i = 0; $i -lt $sugs.Count; $i++) {
    $n = if ($sugs[$i].LocalizedDisplayName) { $sugs[$i].LocalizedDisplayName } else { $sugs[$i].Name }
    Write-Host ('{0,3}. {1}' -f ($i + 1), $n)
}
do {
    $raw = Read-Host "Choose the approved SUG number (1-$($sugs.Count))"
    $n = 0
    $valid = [int]::TryParse($raw, [ref]$n) -and $n -ge 1 -and $n -le $sugs.Count
} while (-not $valid)
$sugObject = $sugs[$n - 1]
$sugName = if ($sugObject.LocalizedDisplayName) { $sugObject.LocalizedDisplayName } else { $sugObject.Name }

# Select existing collection.
$collections = @(Get-CMDeviceCollection | Sort-Object Name)
if ($collections.Count -eq 0) { throw 'No device collections returned.' }
Write-Host "`nDevice collections:" -ForegroundColor Cyan
for ($i = 0; $i -lt $collections.Count; $i++) {
    Write-Host ('{0,3}. {1} [{2}]' -f ($i + 1), $collections[$i].Name, $collections[$i].CollectionID)
}
do {
    $raw = Read-Host "Choose the collection number (use Yogesh_Automation_test only if its membership is correct)"
    $n = 0
    $valid = [int]::TryParse($raw, [ref]$n) -and $n -ge 1 -and $n -le $collections.Count
} while (-not $valid)
$collection = $collections[$n - 1]
$collectionName = $collection.Name

# Ensure membership is exactly the allowlist. No deployment if membership differs.
$members = @(Get-CMDevice -CollectionName $collectionName -Fast -ErrorAction Stop)
$memberNames = @($members | ForEach-Object { $_.Name.ToUpperInvariant() } | Sort-Object -Unique)
$missing = @($AllowedNames | ForEach-Object { $_.ToUpperInvariant() } | Where-Object { $_ -notin $memberNames })
$unexpected = @($memberNames | Where-Object { $_ -notin @($AllowedNames | ForEach-Object { $_.ToUpperInvariant() }) })
if ($missing.Count -gt 0 -or $unexpected.Count -gt 0 -or $memberNames.Count -ne 2) {
    throw "Collection '$collectionName' must contain exactly C03DGHHYPV8871 and C03DGHHYPV3621. Missing=[$($missing -join ',')]; unexpected=[$($unexpected -join ',')]. No deployment created."
}

$updates = @(Get-CMSoftwareUpdate -UpdateGroupName $sugName -Fast -ErrorAction Stop)
if ($updates.Count -eq 0) { throw "No updates found for SUG '$sugName'. No deployment created." }

$availableUtc = Read-UtcDateTime 'Enter availability date/time'
$deadlineUtc = Read-UtcDateTime 'Enter required installation deadline'
$nowUtc = (Get-Date).ToUniversalTime()
if ($availableUtc -le $nowUtc) { throw 'Availability must be in the future. No deployment created.' }
if ($deadlineUtc -le $availableUtc) { throw 'Deadline must be later than availability. No deployment created.' }

$deploymentName = Read-RequiredText 'Enter a unique deployment name'
$description = "Required software update POC; Change=$changeTicket; Approver=$approver; ApprovalRef=$approvalReference; SUG=$sugName; Targets=$($AllowedNames -join ', '); SCCM-initiated restart suppressed."
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmssZ')
$reportPath = Join-Path $ReportRoot "RequiredPatchPOC_$stamp.json"

Write-Host "`nREVIEW DEPLOYMENT" -ForegroundColor Yellow
[pscustomobject]@{
    Site = $site.SiteCode
    SUG = $sugName
    UpdateCount = $updates.Count
    Collection = $collectionName
    Targets = ($AllowedNames -join ', ')
    DeploymentType = 'Required'
    AvailableUtc = $availableUtc.ToString('yyyy-MM-dd HH:mm')
    DeadlineUtc = $deadlineUtc.ToString('yyyy-MM-dd HH:mm')
    TimeBasis = 'UTC'
    AllowRestart = $false
    RestartServer = $false
    RestartWorkstation = $false
    ChangeTicket = $changeTicket
    Approver = $approver
    ApprovalReference = $approvalReference
} | Format-List

Write-Host 'REQUIRED HUMAN GATES: approved ticket and SUG; DP content distributed; client health and pending reboot reviewed; maintenance window and deadline approved; site/console compatibility confirmed; application owners notified.' -ForegroundColor Yellow
$ready = Read-Host 'Have all checks been completed and approved? Type YES'
if ($ready -cne 'YES') { throw 'Approval gates not confirmed. No deployment created.' }

Write-Host "`nThis will create a NEW REQUIRED deployment. SCCM will enforce applicable updates by the deadline. SCCM-initiated restart is disabled; updates that require a restart may remain pending." -ForegroundColor Red
$final = Read-Host "Type the exact deployment name to create it: $deploymentName"
if ($final -cne $deploymentName) { throw 'Final confirmation did not match. No deployment created.' }

# Use the documented cmdlet. Do not distribute content automatically.
New-CMSoftwareUpdateDeployment `
    -SoftwareUpdateGroupName $sugName `
    -CollectionName $collectionName `
    -DeploymentName $deploymentName `
    -Comment $description `
    -DeploymentType Required `
    -AvailableDateTime $availableUtc `
    -DeadlineDateTime $deadlineUtc `
    -TimeBasedOn Utc `
    -UserNotification DisplaySoftwareCenterOnly `
    -SoftwareInstallation $true `
    -AllowRestart $false `
    -RestartServer $false `
    -RestartWorkstation $false `
    -ErrorAction Stop | Out-Null

$result = [pscustomobject]@{
    CreatedUtc = (Get-Date).ToUniversalTime().ToString('o')
    SiteCode = $site.SiteCode
    SiteVersion = $site.Version
    DeploymentName = $deploymentName
    DeploymentType = 'Required'
    SUG = $sugName
    UpdateCount = $updates.Count
    CollectionName = $collectionName
    Targets = $AllowedNames
    AvailableUtc = $availableUtc.ToString('o')
    DeadlineUtc = $deadlineUtc.ToString('o')
    TimeBasedOn = 'Utc'
    AllowRestart = $false
    RestartServer = $false
    RestartWorkstation = $false
    ChangeTicket = $changeTicket
    Approver = $approver
    ApprovalReference = $approvalReference
    CreationStatus = 'Created; verify in SCCM Monitoring > Deployments'
    InstallationStatus = 'Not yet verified'
    ReportPath = $reportPath
}
Write-JsonReport $result $reportPath

Write-Host "`nRequired deployment created." -ForegroundColor Green
Write-Host "Report: $reportPath"
Write-Host "Monitor in SCCM Console: Monitoring > Deployments > $deploymentName"
Write-Host 'Verify each server and each update. Deployment creation is not installation success.'
