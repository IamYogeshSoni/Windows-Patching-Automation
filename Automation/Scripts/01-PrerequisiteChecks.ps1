#requires -Version 5.1
<#
.SYNOPSIS
Phase 1 prerequisite checks for the allowlisted servers, following the SOP
"List of steps performed to extract list of computer objects for SCCM patching".

.DESCRIPTION
Read-only. For every server given with -Servers (chosen from Active Directory with
Get-ADServers.ps1), or else every allowlisted server in Config\TestServers.json:

  SOP step 3   AD computer object: enabled, DNS name matches, Windows Server 2016/2019/2022/2025
               DNS resolution matches the expected IPv4
  SOP step 4   Ping (PingInfoView equivalent): Succeeded / Request Timeout
  SOP step 5   System uptime (PoshCAT "Get System Uptime" equivalent)
  SOP step 6   Patch eligibility: ping succeeded, OR ping timed out but uptime was retrieved
  SOP step 4b  Servers that fail both are flagged for a manual vCenter power-state check
  SOP step 10  SCCM client status: one device record, client installed and active, recent activity
  SOP p.15     Target collection membership and maintenance window (SOP deployment section)
  Extra        Free disk space on C: and pending reboot (patching blockers)

Writes to Reports\<timestamp>\:
  Phase1_PrerequisiteResults.csv/.json  every check
  Phase1_ServerSummary.csv              one row per server with READY / NOT READY
  EligibleServers.txt                   consolidated patch list (SOP step 6)
  EnabledServers_Above2016.csv          only with -ExportDomainServers (SOP step 3, whole domain)

.PARAMETER TargetCredential
Account with admin rights on the servers (for uptime, disk and reboot checks).
Defaults to the current account.

.PARAMETER Servers
FQDNs to check instead of Config\TestServers.json (e.g. chosen from Get-ADServers.ps1).
The DNS check then only requires the name to resolve, and target collection membership is
checked only when -CollectionName is given (each deployment gets its own collection).

.PARAMETER ExportDomainServers
Also export every enabled Windows Server 2016+ computer in -Domain, exactly as the SOP export script.

.EXAMPLE
.\Scripts\01-PrerequisiteChecks.ps1
.\Scripts\01-PrerequisiteChecks.ps1 -TargetCredential (Get-Credential DSLAB\admin) -ExportDomainServers
.\Scripts\01-PrerequisiteChecks.ps1 -Servers c03dghhypv8871.dslab.ad.adp.com, c03dghhypv3621.dslab.ad.adp.com
#>

[CmdletBinding()]
param(
    [pscredential]$TargetCredential,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]{0,62}(\.[A-Za-z0-9][A-Za-z0-9-]{0,62})+$')]
    [string[]]$Servers,
    [string]$CollectionName,
    [switch]$ExportDomainServers,
    [string]$Domain = 'dslab.ad.adp.com',
    [ValidateRange(1, 365)]
    [int]$ClientActiveWithinDays = 7,
    [ValidateRange(1, 1000)]
    [int]$MinimumFreeDiskGB = 10
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $root 'Modules\Common.psm1') -Force
$config = Get-ProjectConfig
$settings = $config.Settings
# Use the saved server credential when none is given (saved via Run-Patching.ps1).
$TargetCredential = Resolve-TargetCredential -Credential $TargetCredential
$run = New-RunFolder -Root $root
# Servers chosen from AD (-Servers) replace the allowlist file. Each deployment then gets its
# own collection, so membership of the fixed target collection is checked only on request.
$checkCollection = $true
if ($Servers) {
    $targets = @($Servers | ForEach-Object { $_.Trim().ToLowerInvariant() } | Sort-Object -Unique |
        ForEach-Object { [pscustomobject]@{ Fqdn = $_; ExpectedIPv4 = $null; Allowed = $true } })
    $checkCollection = $PSBoundParameters.ContainsKey('CollectionName')
    Write-Host "Checking $($targets.Count) server(s) given with -Servers: $(($targets | ForEach-Object { $_.Fqdn }) -join ', ')"
} else {
    $targets = @($config.Targets | Where-Object { $_.Allowed -eq $true })
    Write-Host "Checking $($targets.Count) allowlisted server(s) from Config\TestServers.json"
}
if (-not $CollectionName) { $CollectionName = [string]$settings.TargetCollectionName }

$results = [System.Collections.Generic.List[object]]::new()
function Add-Result {
    param([string]$Target, [string]$Check, [string]$Status, [string]$Detail)
    $results.Add([pscustomobject]@{
        TimestampUtc = (Get-Date).ToUniversalTime().ToString('o')
        Target = $Target; Check = $Check; Status = $Status; Detail = $Detail
    })
}

# Opens a CIM session to a server: WinRM first, DCOM as fallback (PoshCAT uses DCOM/WMI).
function New-TargetCimSession {
    param([string]$ComputerName)
    $common = @{ ComputerName = $ComputerName; ErrorAction = 'Stop' }
    if ($TargetCredential) { $common.Credential = $TargetCredential }
    try {
        return New-CimSession @common -OperationTimeoutSec 30
    } catch {
        $wsmanError = $_.Exception.Message
        try {
            return New-CimSession @common -SessionOption (New-CimSessionOption -Protocol Dcom)
        } catch {
            throw "WinRM: $wsmanError | DCOM: $($_.Exception.Message)"
        }
    }
}

$supportedOs = 'Windows Server.*(2016|2019|2022|2025)'
$serverRows = [System.Collections.Generic.List[object]]::new()

# ------------------------------------------------------------------
# Optional SOP step 3 for the whole domain
# ------------------------------------------------------------------
$adAvailable = [bool](Get-Module -ListAvailable ActiveDirectory)
if ($adAvailable) { Import-Module ActiveDirectory -ErrorAction SilentlyContinue }

if ($ExportDomainServers) {
    if (-not $adAvailable) {
        Add-Result $Domain 'Domain export of enabled Windows Server 2016+' 'NOT VERIFIED' 'ActiveDirectory module unavailable.'
    } else {
        try {
            $export = Join-Path $run 'EnabledServers_Above2016.csv'
            Get-ADComputer -Server $Domain -Filter { Enabled -eq $true } `
                -Properties OperatingSystem, OperatingSystemVersion, OperatingSystemServicePack, DNSHostName, IPv4Address,
                    Description, CanonicalName, whenCreated, whenChanged, LastLogonDate, PasswordLastSet, ManagedBy, Location, Enabled |
                Where-Object { $_.OperatingSystem -match $supportedOs } |
                Select-Object Name, DNSHostName, IPv4Address, Enabled, OperatingSystem, OperatingSystemVersion,
                    OperatingSystemServicePack, Description, Location, ManagedBy, LastLogonDate, PasswordLastSet,
                    whenCreated, whenChanged, CanonicalName |
                Sort-Object Name |
                Export-Csv -LiteralPath $export -NoTypeInformation -Encoding UTF8
            $count = @(Import-Csv -LiteralPath $export).Count
            Add-Result $Domain 'Domain export of enabled Windows Server 2016+' 'INFO' "$count servers exported to $export. Only allowlisted servers are checked below."
        } catch {
            Add-Result $Domain 'Domain export of enabled Windows Server 2016+' 'FAIL' $_.Exception.Message
        }
    }
}

# ------------------------------------------------------------------
# SCCM connection (read-only)
# ------------------------------------------------------------------
$sccmConnected = $false
$collection = $null
$collectionMembers = @()
try {
    $cmWarnings = Connect-CMSite -SiteCode $settings.SiteCode -SiteServer $settings.SccmSiteServer
    foreach ($w in $cmWarnings) { Add-Result 'SCCM' 'Configuration Manager warning' 'WARN' $w }
    Push-Location "$($settings.SiteCode):\"
    $site = Get-CMSite -ErrorAction Stop
    Add-Result 'SCCM' 'Site connection' 'PASS' "Site $($site.SiteCode) $($site.SiteName) version $($site.Version)"
    $sccmConnected = $true

    $collection = if ($checkCollection) { @(Get-CMDeviceCollection -Name $CollectionName -ErrorAction Stop) } else { $null }
    if (-not $checkCollection) {
        $collection = $null
    } elseif ($collection.Count -eq 1) {
        $collection = $collection[0]
        $collectionMembers = @(Get-CMDevice -CollectionId $collection.CollectionID -Fast -ErrorAction Stop |
            ForEach-Object { $_.Name.ToUpperInvariant() })
        Add-Result $CollectionName 'Target collection' 'PASS' "ID $($collection.CollectionID); $($collectionMembers.Count) members: $($collectionMembers -join ', ')"

        $windows = @(Get-CMMaintenanceWindow -CollectionId $collection.CollectionID -ErrorAction SilentlyContinue)
        $updateWindows = @($windows | Where-Object { $_.IsEnabled -and $_.ServiceWindowType -in 1, 4 })
        if ($updateWindows.Count -gt 0) {
            $text = ($updateWindows | ForEach-Object { "$($_.Name): $($_.Description)" }) -join ' | '
            Add-Result $CollectionName 'Maintenance window (software updates)' 'PASS' $text
        } else {
            Add-Result $CollectionName 'Maintenance window (software updates)' 'WARN' 'No enabled maintenance window for software updates. 04-DeployAndValidatePatches.ps1 creates one.'
        }
    } elseif ($collection.Count -eq 0) {
        Add-Result $CollectionName 'Target collection' 'WARN' "Collection '$CollectionName' does not exist. 04-DeployAndValidatePatches.ps1 will create it with the allowlisted servers."
        $collection = $null
    } else {
        Add-Result $CollectionName 'Target collection' 'FAIL' "Found $($collection.Count) collections named '$CollectionName'; expected exactly one."
        $collection = $null
    }
} catch {
    Add-Result 'SCCM' 'Site connection' 'NOT VERIFIED' $_.Exception.Message
}

# ------------------------------------------------------------------
# Per-server checks
# ------------------------------------------------------------------
foreach ($target in $targets) {
    $fqdn = [string]$target.Fqdn
    $short = ($fqdn -split '\.')[0].ToUpperInvariant()
    $failed = [System.Collections.Generic.List[string]]::new()
    $warned = [System.Collections.Generic.List[string]]::new()

    # --- AD computer object (SOP step 3) ---
    $adDomain = ($fqdn -split '\.', 2)[1]
    if ($adAvailable) {
        try {
            $ad = Get-ADComputer -Server $adDomain -Identity $short -ErrorAction Stop `
                -Properties DNSHostName, Enabled, OperatingSystem, OperatingSystemVersion, LastLogonDate
            $problems = @()
            if (-not $ad.Enabled) { $problems += 'disabled' }
            if ($ad.DNSHostName -ine $fqdn) { $problems += "DNSHostName '$($ad.DNSHostName)'" }
            if ($ad.OperatingSystem -notmatch $supportedOs) { $problems += "OS '$($ad.OperatingSystem)' is not Windows Server 2016+" }
            $detail = "Enabled=$($ad.Enabled); DNSHostName=$($ad.DNSHostName); OS=$($ad.OperatingSystem) $($ad.OperatingSystemVersion); LastLogonDate=$($ad.LastLogonDate)"
            if ($problems.Count -eq 0) {
                Add-Result $fqdn 'AD: enabled, DNS name, Windows Server 2016+' 'PASS' $detail
            } else {
                Add-Result $fqdn 'AD: enabled, DNS name, Windows Server 2016+' 'FAIL' "$($problems -join '; '). $detail"
                $failed.Add('AD')
            }
        } catch {
            Add-Result $fqdn 'AD: enabled, DNS name, Windows Server 2016+' 'NOT VERIFIED' "Server=$adDomain; $($_.Exception.Message)"
            $warned.Add('AD not verified')
        }
    } else {
        Add-Result $fqdn 'AD: enabled, DNS name, Windows Server 2016+' 'NOT VERIFIED' 'ActiveDirectory module unavailable.'
        $warned.Add('AD not verified')
    }

    # --- DNS ---
    try {
        $addresses = @([System.Net.Dns]::GetHostAddresses($fqdn) |
            Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
            ForEach-Object { $_.IPAddressToString })
        if (-not $target.ExpectedIPv4) {
            # Chosen from AD: no expected address on file, so the name must resolve.
            if ($addresses.Count -gt 0) {
                Add-Result $fqdn 'DNS IPv4 matches expected' 'PASS' "Resolved: $($addresses -join ', ') (no expected IPv4 on file)"
            } else {
                Add-Result $fqdn 'DNS IPv4 matches expected' 'FAIL' 'No IPv4 address resolved.'
                $failed.Add('DNS')
            }
        } elseif ($addresses -contains $target.ExpectedIPv4) {
            Add-Result $fqdn 'DNS IPv4 matches expected' 'PASS' "Resolved: $($addresses -join ', ')"
        } else {
            Add-Result $fqdn 'DNS IPv4 matches expected' 'FAIL' "Resolved: $($addresses -join ', '); expected $($target.ExpectedIPv4)"
            $failed.Add('DNS')
        }
    } catch {
        Add-Result $fqdn 'DNS IPv4 matches expected' 'FAIL' $_.Exception.Message
        $failed.Add('DNS')
    }

    # --- Ping (SOP step 4) ---
    $pingOk = $false
    try { $pingOk = [bool](Test-Connection -ComputerName $fqdn -Count 4 -Quiet -ErrorAction Stop) } catch { }
    Add-Result $fqdn 'Ping (PingInfoView)' $(if ($pingOk) { 'Succeeded' } else { 'Request Timeout' }) 'Informational; feeds the eligibility rule.'

    # --- Uptime, disk, pending reboot (SOP step 5 + blockers) ---
    $uptimeOk = $false
    $session = $null
    try {
        $session = New-TargetCimSession -ComputerName $fqdn
        $os = Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem -ErrorAction Stop
        $uptime = (Get-Date) - $os.LastBootUpTime
        $uptimeOk = $true
        Add-Result $fqdn 'System uptime (PoshCAT)' 'Succeeded' ("LastBoot={0:u}; Uptime={1}d {2}h; {3} build {4}" -f
            $os.LastBootUpTime, $uptime.Days, $uptime.Hours, $os.Caption, $os.BuildNumber)

        $disk = Get-CimInstance -CimSession $session -ClassName Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction Stop
        $freeGb = [math]::Round($disk.FreeSpace / 1GB, 1)
        if ($freeGb -ge $MinimumFreeDiskGB) {
            Add-Result $fqdn "Free disk C: (>= $MinimumFreeDiskGB GB)" 'PASS' "$freeGb GB free"
        } else {
            Add-Result $fqdn "Free disk C: (>= $MinimumFreeDiskGB GB)" 'FAIL' "$freeGb GB free"
            $failed.Add('Disk')
        }

        try {
            $reboot = Invoke-CimMethod -CimSession $session -Namespace 'root\ccm\ClientSDK' `
                -ClassName CCM_ClientUtilities -MethodName DetermineIfRebootPending -ErrorAction Stop
            if ($reboot.RebootPending -or $reboot.IsHardRebootPending) {
                Add-Result $fqdn 'Pending reboot' 'WARN' 'A reboot is already pending; restart before patching.'
                $warned.Add('Reboot pending')
            } else {
                Add-Result $fqdn 'Pending reboot' 'PASS' 'No reboot pending (SCCM client).'
            }
        } catch {
            Add-Result $fqdn 'Pending reboot' 'NOT VERIFIED' "SCCM client WMI: $($_.Exception.Message)"
        }
    } catch {
        Add-Result $fqdn 'System uptime (PoshCAT)' 'Failed' $_.Exception.Message
    } finally {
        if ($session) { Remove-CimSession $session -ErrorAction SilentlyContinue }
    }

    # --- Eligibility (SOP step 6) ---
    if ($pingOk) {
        $eligibility = 'ELIGIBLE'; $reason = 'Ping succeeded.'
    } elseif ($uptimeOk) {
        $eligibility = 'ELIGIBLE'; $reason = 'Ping timed out but uptime was retrieved.'
    } elseif ($sccmConnected -and ($recent = @(Get-CMDevice -Name $short -Fast -ErrorAction SilentlyContinue |
            Where-Object { $_ -and $_.LastActiveTime -and $_.LastActiveTime -gt (Get-Date).AddHours(-24) })).Count -eq 1) {
        # Ping/WinRM are often blocked from the GLOBAL jumphost to other domains; the SOP runs
        # these steps from the domain's own jumphost. A client that reported in the last 24 h is online.
        $eligibility = 'ELIGIBLE'
        $reason = "Ping and uptime blocked from this jumphost, but the SCCM client was active at $($recent[0].LastActiveTime). Run ping/uptime from the domain jumphost to follow the SOP exactly."
        $warned.Add('Reachability via SCCM only')
    } else {
        $eligibility = 'NOT ELIGIBLE'
        $reason = 'Ping timed out and uptime failed. Check in vCenter whether it is powered on, shut down or missing (SOP step 4).'
        $failed.Add('Reachability')
    }
    Add-Result $fqdn 'Patch eligibility (SOP step 6)' $eligibility $reason

    # --- SCCM device and client health (SOP steps 10-11) ---
    if ($sccmConnected) {
        try {
            $devices = @(Get-CMDevice -Name $short -ErrorAction Stop)
            if ($devices.Count -ne 1) {
                Add-Result $fqdn 'SCCM device record' 'FAIL' "Found $($devices.Count) records named $short; expected exactly one."
                $failed.Add('SCCM record')
            } else {
                $d = $devices[0]
                Add-Result $fqdn 'SCCM device record' 'PASS' "ResourceID=$($d.ResourceID); Domain=$($d.Domain); OS=$($d.DeviceOS)"

                $activeCutoff = (Get-Date).AddDays(-$ClientActiveWithinDays)
                $problems = @()
                if (-not $d.IsClient) { $problems += 'no SCCM client' }
                if (-not $d.IsActive -and $d.ClientActiveStatus -ne 1) { $problems += 'client inactive' }
                if ($d.LastActiveTime -and $d.LastActiveTime -lt $activeCutoff) { $problems += "last active $($d.LastActiveTime)" }
                $detail = "IsClient=$($d.IsClient); ClientActiveStatus=$($d.ClientActiveStatus); IsActive=$($d.IsActive); LastActiveTime=$($d.LastActiveTime); ClientVersion=$($d.ClientVersion)"
                if ($problems.Count -eq 0) {
                    Add-Result $fqdn "SCCM client healthy (active within $ClientActiveWithinDays days)" 'PASS' $detail
                } else {
                    Add-Result $fqdn "SCCM client healthy (active within $ClientActiveWithinDays days)" 'FAIL' "$($problems -join '; '). Troubleshoot the client (SOP step 11). $detail"
                    $failed.Add('SCCM client')
                }
            }

            if ($collection) {
                if ($collectionMembers -contains $short) {
                    Add-Result $fqdn "Member of '$CollectionName'" 'PASS' ''
                } else {
                    Add-Result $fqdn "Member of '$CollectionName'" 'FAIL' 'Not in the target collection.'
                    $failed.Add('Collection')
                }
            }
        } catch {
            Add-Result $fqdn 'SCCM device record' 'NOT VERIFIED' $_.Exception.Message
            $warned.Add('SCCM not verified')
        }
    } else {
        Add-Result $fqdn 'SCCM device record' 'NOT VERIFIED' 'No SCCM connection.'
        $warned.Add('SCCM not verified')
    }

    $serverRows.Add([pscustomobject]@{
        Server = $fqdn
        Eligibility = $eligibility
        Overall = if ($failed.Count -eq 0) { 'READY' } else { 'NOT READY' }
        Failed = $failed -join ', '
        Warnings = $warned -join ', '
    })
}

if ($sccmConnected) { Pop-Location }

# ------------------------------------------------------------------
# Reports
# ------------------------------------------------------------------
$results | Export-Csv (Join-Path $run 'Phase1_PrerequisiteResults.csv') -NoTypeInformation -Encoding UTF8
$results | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $run 'Phase1_PrerequisiteResults.json') -Encoding UTF8
$serverRows | Export-Csv (Join-Path $run 'Phase1_ServerSummary.csv') -NoTypeInformation -Encoding UTF8
@($serverRows | Where-Object { $_.Overall -eq 'READY' } | ForEach-Object { $_.Server }) |
    Set-Content (Join-Path $run 'EligibleServers.txt') -Encoding UTF8

$results | Select-Object Target, Check, Status, Detail | Format-Table -Wrap -AutoSize | Out-Host
Write-Host "`nServer summary" -ForegroundColor Cyan
$serverRows | Format-Table -AutoSize | Out-Host
Write-Host "Phase 1 report folder: $run"
Write-Host 'No SCCM objects were created or modified.'
