[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('c03dghhypv8871.dslab.ad.adp.com','c03dghhypv3621.dslab.ad.adp.com')][string]$TargetFqdn,
    [Parameter(Mandatory=$true)][string]$SelectedSUG,
    [Parameter(Mandatory=$true)][string]$ChangeTicket,
    [Parameter(Mandatory=$true)][string]$Approver,
    [Parameter(Mandatory=$true)][ValidatePattern('^\d{2}:\d{2}$')][string]$StartUtc,
    [Parameter(Mandatory=$true)][ValidatePattern('^\d{2}:\d{2}$')][string]$EndUtc
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $root 'Modules\Common.psm1') -Force
$config = Get-ProjectConfig
$target = Resolve-Target -Fqdn $TargetFqdn -Allowlist $config.Targets
if ($StartUtc -notmatch '^([01]\d|2[0-3]):[0-5]\d$' -or $EndUtc -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {
    throw 'Maintenance times must be valid 24-hour HH:mm UTC values.'
}
if ([string]::IsNullOrWhiteSpace($ChangeTicket) -or [string]::IsNullOrWhiteSpace($Approver)) {
    throw 'Change ticket and approver are required.'
}
$run = New-RunFolder -Root $root
$packet = [pscustomobject]@{
    CreatedUtc=(Get-Date).ToUniversalTime().ToString('o')
    Status='PREPARED FOR HUMAN REVIEW - NO DEPLOYMENT EXECUTED'
    TargetFqdn=$target.Fqdn
    ExpectedIPv4=$target.ExpectedIPv4
    SelectedSUG=$SelectedSUG
    ChangeTicket=$ChangeTicket
    Approver=$Approver
    MaintenanceWindowUtc=[pscustomobject]@{Start=$StartUtc;End=$EndUtc;TimeZone='UTC'}
    RebootPolicy='Use the existing approved SCCM deployment settings; must be verified by SCCM administrator.'
    RequiredChecks=@(
        'Phase 1 report reviewed; target DNS/IP and SCCM identity match exactly',
        'Target collection test-poc exists and membership is correct',
        'SUG and exact update list approved for this target',
        'Required DP content confirmed distributed and available',
        'SCCM client health and pending reboot state reviewed',
        'Write permissions verified for the intended deployment action',
        'UTC window semantics verified against SCCM site/server timezone and supported cmdlet',
        'Existing approved reboot and user notification settings verified',
        'Change ticket and explicit deployment approval confirmed'
    )
    DeploymentExecution='DISABLED IN THIS PACKAGE'
}
$path = Join-Path $run 'Phase3_ApprovalPacket.json'
$packet | ConvertTo-Json -Depth 8 | Set-Content $path -Encoding UTF8
Write-Host "Approval packet created: $path" -ForegroundColor Yellow
Write-Host "This script does not create or deploy any SCCM objects."
Write-Host "Phase 3 deployment execution is intentionally disabled pending administrator review."
