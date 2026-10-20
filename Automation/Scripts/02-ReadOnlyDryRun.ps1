
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ============================================================
# 1. Load project configuration
# ============================================================

$root = Split-Path -Parent $PSScriptRoot

Import-Module (Join-Path $root 'Modules\Common.psm1') -Force -ErrorAction Stop

$config = Get-ProjectConfig
$settings = $config.Settings

$siteCode = ([string]$settings.SiteCode).Trim()

if ([string]::IsNullOrWhiteSpace($siteCode)) {
    throw 'SiteCode is missing from Config\Settings.json.'
}

$siteServer = ([string]$settings.SiteServer).Trim()

if ([string]::IsNullOrWhiteSpace($siteServer)) {
    $siteServer = 'ORDPGBLSCCM11.global.cdk.com'
}

$modulePath = 'C:\Program Files (x86)\Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager\ConfigurationManager.psd1'

Write-Host "`nInitializing SCCM connection..." -ForegroundColor Cyan
Write-Host "Site code:   $siteCode"
Write-Host "Site server: $siteServer"

# ============================================================
# 2. Import Configuration Manager module
# ============================================================

if (-not (Test-Path -LiteralPath $modulePath)) {
    throw "Configuration Manager module not found: $modulePath"
}

Import-Module $modulePath -Force -ErrorAction Stop

if (-not (Get-Command Get-CMSite -ErrorAction SilentlyContinue)) {
    throw 'Get-CMSite is unavailable. Check the Configuration Manager console installation.'
}

# ============================================================
# 3. Create or reuse the SCCM site drive
# ============================================================

$driveName = $siteCode
$sitePath = "${driveName}:\"

$drive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue

if ($drive) {
    Write-Host "Found existing drive ${driveName}:" -ForegroundColor Green
}
else {
    Write-Host "Creating ${driveName}: using $siteServer ..." -ForegroundColor Yellow

    # Capture the creation error without immediately terminating.
    # Verify the resulting drive and site before continuing.
    $driveCreationError = $null

    try {
        New-PSDrive `
            -Name $driveName `
            -PSProvider CMSite `
            -Root $siteServer `
            -Description 'CDK-T01' `
            -ErrorAction Continue 2>&1 |
            ForEach-Object {
                if ($_ -is [System.Management.Automation.ErrorRecord]) {
                    $driveCreationError = $_
                    Write-Warning $_.Exception.Message
                }
                else {
                    Write-Host $_
                }
            }
    }
    catch {
        $driveCreationError = $_
        Write-Warning $_.Exception.Message
    }
}

# Verify the drive actually exists.
$drive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue

if (-not $drive) {
    $detail = if ($driveCreationError) {
        $driveCreationError.Exception.Message
    }
    else {
        'No drive was returned.'
    }

    throw "SCCM drive '$driveName' could not be created. $detail"
}

if ($drive.Provider.Name -ne 'CMSite') {
    throw "Drive '$driveName' exists but is not a CMSite drive."
}

if ($drive.Root.TrimEnd('\') -ne $siteServer.TrimEnd('\')) {
    throw "Drive '$driveName' points to '$($drive.Root)', not '$siteServer'."
}

# ============================================================
# 4. Verify SCCM site and read-only collection access
# ============================================================

$verifiedSite = $null

Push-Location $sitePath
try {
    $siteInfo = @(Get-CMSite -ErrorAction Stop)

    $verifiedSite = $siteInfo |
        Where-Object { $_.SiteCode -eq $siteCode } |
        Select-Object -First 1

    if (-not $verifiedSite) {
        $foundCodes = ($siteInfo | ForEach-Object { $_.SiteCode }) -join ', '
        throw "Expected site '$siteCode' was not found. Returned site codes: $foundCodes"
    }

    # Verify that the current account can perform a read-only query.
    $null = Get-CMDeviceCollection -ErrorAction Stop
}
catch {
    throw @"
SCCM site verification failed.
Site code: $siteCode
Site server: $siteServer
Drive: $sitePath
Error: $($_.Exception.Message)

No deployment was created. Verify SCCM connectivity, permissions,
and Configuration Manager console compatibility.
"@
}
finally {
    Pop-Location
}

Write-Host "`nConnected to SCCM site:" -ForegroundColor Green

$verifiedSite |
    Select-Object SiteCode, SiteName, Version |
    Format-List

Write-Host 'Read-only collection query succeeded.' -ForegroundColor Green

# ============================================================
# 5. Create report folder and retrieve the read-only snapshot
# ============================================================

$run = New-RunFolder -Root $root

$snapshot = Get-SccmReadOnlySnapshot `
    -Settings $settings `
    -CollectionName $settings.TargetCollectionName

$sugs = @($snapshot.SUGs | Sort-Object LocalizedDisplayName)

if ($sugs.Count -eq 0) {
    throw 'No Software Update Groups were returned. Check SCCM permissions and provider access.'
}

# ============================================================
# 6. Display SUGs and prompt for selection
# ============================================================

Write-Host "`nAvailable Software Update Groups (SUGs)" -ForegroundColor Cyan

for ($i = 0; $i -lt $sugs.Count; $i++) {
    Write-Host ("[{0}] {1} (CI_ID={2})" -f `
        ($i + 1), $sugs[$i].LocalizedDisplayName, $sugs[$i].CI_ID)
}

$defaultIndex = 1

for ($i = 0; $i -lt $sugs.Count; $i++) {
    if ($sugs[$i].LocalizedDisplayName -eq $settings.SuggestedSUGName) {
        $defaultIndex = $i + 1
        break
    }
}

$selection = Read-Host "Select SUG number (suggested $defaultIndex; press Enter to accept)"

if ([string]::IsNullOrWhiteSpace($selection)) {
    $selection = [string]$defaultIndex
}

$chosenNumber = 0

if (
    -not [int]::TryParse($selection, [ref]$chosenNumber) -or
    $chosenNumber -lt 1 -or
    $chosenNumber -gt $sugs.Count
) {
    throw 'Invalid SUG selection. No changes were made.'
}

$chosen = $sugs[$chosenNumber - 1]

Write-Host "`nSelected SUG: $($chosen.LocalizedDisplayName)" -ForegroundColor Yellow

# ============================================================
# 7. Query updates for the selected SUG
# ============================================================

$updates = @()
$updateQueryStatus = 'NOT VERIFIED'

Push-Location $sitePath
try {
    $updates = @(
        Get-CMSoftwareUpdate `
            -UpdateGroupName $chosen.LocalizedDisplayName `
            -ErrorAction Stop |
        Select-Object `
            LocalizedDisplayName,
            ArticleID,
            CI_ID,
            DateRevised,
            IsDeployed,
            IsExpired,
            IsSuperseded,
            NumMissing,
            NumPresent,
            NumNotApplicable,
            PercentCompliant
    )

    $updateQueryStatus = 'QUERY SUCCEEDED'
}
catch {
    $updateQueryStatus = 'NOT VERIFIED: ' + $_.Exception.Message
    Write-Warning $updateQueryStatus
}
finally {
    Pop-Location
}

# ============================================================
# 8. Export CSV reports
# ============================================================

$sugReport = Join-Path $run 'Available_SUGs.csv'
$updateReport = Join-Path $run 'Selected_SUG_Updates.csv'

$snapshot.SUGs |
    Export-Csv $sugReport -NoTypeInformation -Encoding UTF8

$updates |
    Export-Csv $updateReport -NoTypeInformation -Encoding UTF8

# ============================================================
# 9. Build dry-run plan
# ============================================================

$collectionMatchCount = @($snapshot.CollectionMatches).Count

$plan = [pscustomobject]@{
    CreatedUtc = (Get-Date).ToUniversalTime().ToString('o')
    Mode = 'READ-ONLY DRY RUN'
    SiteCode = $siteCode
    SiteServer = $siteServer
    VerifiedSiteName = $verifiedSite.SiteName
    VerifiedSiteVersion = $verifiedSite.Version
    AllowedTargets = @(
        $config.Targets | Select-Object Fqdn, ExpectedIPv4
    )
    TargetCollection = $settings.TargetCollectionName
    CollectionExists = ($collectionMatchCount -eq 1)
    SelectedSUG = $chosen.LocalizedDisplayName
    SelectedSUGCI_ID = $chosen.CI_ID
    UpdateQueryStatus = $updateQueryStatus
    UpdatesReturned = $updates.Count
    SuggestedMaintenanceWindowUtc = $settings.MaintenanceWindow
    RebootPolicy = 'Read existing approved deployment settings; do not override.'
    DistributionPointContentReadiness = 'NOT VERIFIED - must be confirmed before deployment'
    DeploymentApproval = 'NOT GRANTED'
    WriteAccess = 'NOT VERIFIED'
    ProposedActions = @(
        'Review target device identity and collection membership'
        'Review selected SUG and update list'
        'Verify applicability, approvals, and distribution-point content'
        'Verify client health and existing reboot/deployment settings'
        'Obtain explicit change/deployment approval'
        'Only then prepare one-server patch test'
    )
    Blockers = @()
}

if (-not $plan.CollectionExists) {
    $plan.Blockers += "Target collection '$($settings.TargetCollectionName)' is missing or ambiguous; resolve it before deployment."
}

if ($updates.Count -eq 0) {
    $plan.Blockers += 'No updates returned or query unavailable; inspect Selected_SUG_Updates.csv and UpdateQueryStatus.'
}

$plan.Blockers += 'Distribution-point content readiness is not verified.'
$plan.Blockers += 'Write permissions are not verified.'
$plan.Blockers += 'Deployment approval is not granted.'

# ============================================================
# 10. Save JSON plan and print summary
# ============================================================

$planPath = Join-Path $run 'Phase2_DryRunPlan.json'

$plan |
    ConvertTo-Json -Depth 8 |
    Set-Content $planPath -Encoding UTF8

Write-Host "`nDry-run summary" -ForegroundColor Cyan

$plan |
    Select-Object `
        Mode,
        SiteCode,
        SiteServer,
        TargetCollection,
        CollectionExists,
        SelectedSUG,
        UpdatesReturned,
        UpdateQueryStatus,
        DeploymentApproval,
        WriteAccess |
    Format-List

Write-Host 'Blockers:' -ForegroundColor Cyan

if (@($plan.Blockers).Count -eq 0) {
    Write-Host 'None'
}
else {
    $plan.Blockers | ForEach-Object {
        Write-Host " - $_" -ForegroundColor Yellow
    }
}

Write-Host "`nReports saved to: $run" -ForegroundColor Green
Write-Host " - $sugReport"
Write-Host " - $updateReport"
Write-Host " - $planPath"

Write-Host "`nNo SCCM objects were created or modified." -ForegroundColor Green
