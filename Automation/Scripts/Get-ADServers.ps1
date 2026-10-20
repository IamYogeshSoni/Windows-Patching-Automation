#requires -Version 5.1
<#
.SYNOPSIS
Lists the Windows servers in Active Directory to choose patch targets from
(SOP "List of steps performed to extract list of computer objects", step 3).

.DESCRIPTION
Read-only. Returns every enabled computer object in -Domain whose operating
system is Windows Server, one object per server:

  Name, Fqdn, Domain, OperatingSystem, OperatingSystemVersion, Supported
  (Windows Server 2016/2019/2022/2025), LastLogonUtc, Stale (no logon for
  -StaleAfterDays), PasswordLastSetUtc, CreatedUtc, Description, OU,
  DistinguishedName

and saves the same list to Reports\ADServers_<domain>_<timestamp>.csv.

The servers chosen from this list are passed to 01-PrerequisiteChecks.ps1 and
04-DeployAndValidatePatches.ps1 with -Servers / -TargetServers instead of
Config\TestServers.json.

.PARAMETER NameFilter
Wildcard on the computer name, e.g. C03DGH* or *HYPV*.

.PARAMETER SearchBase
Only this OU (distinguished name) and below.

.PARAMETER Credential
Account for the AD query when the current account cannot read -Domain
(tried only after the current account fails).

.EXAMPLE
.\Scripts\Get-ADServers.ps1 -Domain dslab.ad.adp.com -NameFilter 'C03DGH*'
#>

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]{1,252}$')]
    [string]$Domain = 'dslab.ad.adp.com',

    [ValidatePattern('^[A-Za-z0-9*_.-]{1,64}$')]
    [string]$NameFilter,

    [ValidatePattern('^(?i)(?:(?:OU|CN|DC)=[^,;"<>\\=]+,)*DC=[^,;"<>\\=]+$')]
    [string]$SearchBase,

    [ValidateRange(1, 10000)]
    [int]$MaxResults = 2000,

    [ValidateRange(1, 3650)]
    [int]$StaleAfterDays = 30,

    [pscredential]$Credential
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Module -ListAvailable ActiveDirectory)) {
    throw 'The ActiveDirectory PowerShell module is not installed on this host (RSAT AD PowerShell).'
}
Import-Module ActiveDirectory -ErrorAction Stop

$supportedOs = 'Windows Server.*(2016|2019|2022|2025)'
$filter = "Enabled -eq 'True' -and OperatingSystem -like '*Windows Server*'"
if ($NameFilter) { $filter += " -and Name -like '$NameFilter'" }

$query = @{
    Server = $Domain
    Filter = $filter
    Properties = 'DNSHostName', 'OperatingSystem', 'OperatingSystemVersion', 'LastLogonDate',
                 'PasswordLastSet', 'whenCreated', 'Description', 'CanonicalName', 'Enabled'
    ResultSetSize = $MaxResults
    ErrorAction = 'Stop'
}
if ($SearchBase) { $query.SearchBase = $SearchBase }

Write-Host "Querying AD $Domain for enabled Windows servers$(if ($NameFilter) { " named '$NameFilter'" })$(if ($SearchBase) { " under $SearchBase" })..."
try {
    $computers = @(Get-ADComputer @query)
    Write-Host "Read as $([Security.Principal.WindowsIdentity]::GetCurrent().Name)."
} catch {
    if (-not $Credential) { throw "AD query on $Domain failed: $($_.Exception.Message)" }
    Write-Host "AD query as the current account failed ($($_.Exception.Message)); retrying as $($Credential.UserName)."
    $computers = @(Get-ADComputer @query -Credential $Credential)
}

$now = [datetime]::UtcNow
$toUtc = { param($d) if ($d) { ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }
$servers = @($computers | Sort-Object Name | ForEach-Object {
    $canonical = [string]$_.CanonicalName
    [pscustomobject]@{
        Name = ([string]$_.Name).ToUpperInvariant()
        Fqdn = if ($_.DNSHostName) { ([string]$_.DNSHostName).ToLowerInvariant() } else { $null }
        Domain = $Domain
        OperatingSystem = [string]$_.OperatingSystem
        OperatingSystemVersion = [string]$_.OperatingSystemVersion
        Supported = ([string]$_.OperatingSystem -match $supportedOs)
        LastLogonUtc = & $toUtc $_.LastLogonDate
        Stale = (-not $_.LastLogonDate) -or ($now - ([datetime]$_.LastLogonDate).ToUniversalTime()).TotalDays -gt $StaleAfterDays
        PasswordLastSetUtc = & $toUtc $_.PasswordLastSet
        CreatedUtc = & $toUtc $_.whenCreated
        Description = [string]$_.Description
        OU = if ($canonical -match '^(.*)/[^/]+$') { $Matches[1] } else { $canonical }
        DistinguishedName = [string]$_.DistinguishedName
    }
})

$supported = @($servers | Where-Object { $_.Supported -and $_.Fqdn }).Count
Write-Host ("{0} Windows servers found; {1} on Windows Server 2016+ with a DNS name; {2} not logged on for {3}+ days." -f
    $servers.Count, $supported, @($servers | Where-Object { $_.Stale }).Count, $StaleAfterDays)
if ($servers.Count -ge $MaxResults) { Write-Warning "Only the first $MaxResults servers are listed; narrow the search with -NameFilter or -SearchBase." }

try {
    $reports = Join-Path $root 'Reports'
    New-Item -ItemType Directory -Path $reports -Force | Out-Null
    $csv = Join-Path $reports ("ADServers_{0}_{1}.csv" -f $Domain, $now.ToString('yyyyMMdd_HHmmssZ'))
    $servers | Export-Csv -LiteralPath $csv -NoTypeInformation -Encoding UTF8
    Write-Host "Saved to $csv"
} catch {
    Write-Warning "List not saved to Reports: $($_.Exception.Message)"
}

$servers

