Set-StrictMode -Version Latest

function Get-ProjectRoot {
    return (Split-Path -Parent $PSScriptRoot)
}
function Get-ProjectConfig {
    $root = Get-ProjectRoot
    $settings = Get-Content -LiteralPath (Join-Path $root 'Config\Settings.json') -Raw | ConvertFrom-Json
    $targets = Get-Content -LiteralPath (Join-Path $root 'Config\TestServers.json') -Raw | ConvertFrom-Json
    return [pscustomobject]@{ Root=$root; Settings=$settings; Targets=@($targets) }
}
function New-RunFolder {
    param([string]$Root)
    $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmssZ')
    $path = Join-Path $Root ("Reports\" + $timestamp)
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}
function Write-JsonReport {
    param([object]$Data,[string]$Path)
    $Data | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}
function Resolve-Target {
    param([string]$Fqdn,[object[]]$Allowlist)
    $matches = @($Allowlist | Where-Object { $_.Fqdn -ieq $Fqdn -and $_.Allowed -eq $true })
    if ($matches.Count -ne 1) { throw "Target '$Fqdn' is not uniquely present in the fixed allowlist." }
    return $matches[0]
}

# Value of a property, or $null when the object does not have it (safe under strict mode).
function Get-PropertyValue {
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

# Imports the ConfigurationManager module and creates the CMSite drive. A
# console/site version mismatch is reported as a non-terminating error; like
# the interactive console, carry on and return it as a warning. Fails only if
# the module or the drive is really missing.
function Connect-CMSite {
    param([string]$SiteCode, [string]$SiteServer)

    $importErrors = @()
    $driveErrors = @()

    if (-not (Get-Module ConfigurationManager)) {
        $modulePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager\ConfigurationManager.psd1'
        if (-not (Test-Path -LiteralPath $modulePath)) {
            $modulePath = Join-Path $env:ProgramFiles 'Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager\ConfigurationManager.psd1'
        }
        if (-not (Test-Path -LiteralPath $modulePath)) {
            throw 'Configuration Manager module not found on this machine. Run on the jumphost with the SCCM console installed.'
        }
        Import-Module $modulePath -Global -ErrorAction Continue -ErrorVariable importErrors 2>$null 3>$null
        if (-not (Get-Module ConfigurationManager)) {
            throw "ConfigurationManager module failed to load: $($importErrors -join '; ')"
        }
    }

    if (-not (Get-PSDrive -Name $SiteCode -PSProvider CMSite -ErrorAction SilentlyContinue)) {
        New-PSDrive -Name $SiteCode -PSProvider CMSite -Root $SiteServer -Scope Global `
            -ErrorAction Continue -ErrorVariable driveErrors 2>$null 3>$null | Out-Null
    }
    if (-not (Get-PSDrive -Name $SiteCode -PSProvider CMSite -ErrorAction SilentlyContinue)) {
        throw "$SiteCode CMSite drive could not be created: $(@($importErrors) + @($driveErrors) -join '; ')"
    }

    return @(@($importErrors) + @($driveErrors) | ForEach-Object { "$_" } | Sort-Object -Unique)
}

# CIM session to the SMS Provider for direct WMI queries (compliance, content,
# deployment state). DCOM is what the console itself uses.
function New-SmsCimSession {
    param([string]$SiteServer, [string]$SiteCode)

    $option = New-CimSessionOption -Protocol Dcom
    $session = New-CimSession -ComputerName $SiteServer -SessionOption $option -ErrorAction Stop

    # The provider may live on another machine; follow SMS_ProviderLocation.
    $location = @(Get-CimInstance -CimSession $session -Namespace 'root\SMS' -ClassName SMS_ProviderLocation -ErrorAction SilentlyContinue |
        Where-Object { $_.SiteCode -eq $SiteCode } | Select-Object -First 1)
    if ($location.Count -eq 1 -and $location[0].Machine -and
        ($location[0].Machine -split '\.')[0] -ine ($SiteServer -split '\.')[0]) {
        Remove-CimSession $session
        $session = New-CimSession -ComputerName $location[0].Machine -SessionOption $option -ErrorAction Stop
    }
    return $session
}

function Invoke-SmsQuery {
    param($CimSession, [string]$SiteCode, [string]$Query)
    return @(Get-CimInstance -CimSession $CimSession -Namespace "root\SMS\site_$SiteCode" -Query $Query -ErrorAction Stop)
}

# Runs "SELECT ... WHERE (Field = v1 OR Field = v2 ...)" in chunks; WQL has no IN.
function Invoke-SmsQueryIn {
    param($CimSession, [string]$SiteCode, [string]$Select, [string]$Field, [object[]]$Values, [switch]$Quote, [int]$ChunkSize = 40)

    $results = New-Object System.Collections.Generic.List[object]
    $unique = @($Values | Where-Object { $null -ne $_ -and "$_" -ne '' } | Sort-Object -Unique)
    for ($i = 0; $i -lt $unique.Count; $i += $ChunkSize) {
        $chunk = $unique[$i..([Math]::Min($i + $ChunkSize, $unique.Count) - 1)]
        $terms = $chunk | ForEach-Object {
            if ($Quote) { "$Field = '" + ("$_" -replace "'", "\'") + "'" } else { "$Field = $_" }
        }
        foreach ($row in (Invoke-SmsQuery -CimSession $CimSession -SiteCode $SiteCode -Query "$Select WHERE ($($terms -join ' OR '))")) {
            $results.Add($row)
        }
    }
    # ToArray(): @($results) on a List[object] throws "Argument types do not match" in PowerShell 5.1.
    return $results.ToArray()
}

# ------------------------------------------------------------
# Saved server credential
# Stored with Export-Clixml, i.e. encrypted by Windows DPAPI: only the same Windows user on the
# same machine can decrypt it. Kept in the user profile, never in the project folder.
# The file holds either a PSCredential or the text 'CurrentAccount' (use the logged-on account).
# ------------------------------------------------------------
function Get-CredentialStorePath {
    return (Join-Path $env:LOCALAPPDATA 'SccmPatchingAutomation\TargetCredential.xml')
}

function Get-StoredTargetCredential {
    $path = Get-CredentialStorePath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return Import-Clixml -LiteralPath $path
    } catch {
        Write-Warning "The saved server credential could not be read ($($_.Exception.Message)); you will be asked again."
        return $null
    }
}

function Save-TargetCredential {
    param([Parameter(Mandatory = $true)] $Credential)   # PSCredential or 'CurrentAccount'
    $path = Get-CredentialStorePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    $Credential | Export-Clixml -LiteralPath $path -Force

    # Only the current user may read the file (no inherited permissions).
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $path -AclObject $acl
}

function Remove-StoredTargetCredential {
    Remove-Item -LiteralPath (Get-CredentialStorePath) -Force -ErrorAction SilentlyContinue
}

# Credential for the target servers: the one given, else the saved one, else (with -Prompt) asks
# once and offers to save the answer. Returns $null to mean "use the current account".
function Resolve-TargetCredential {
    param([pscredential]$Credential, [switch]$Prompt, [switch]$Reset)

    if ($Credential) { return $Credential }
    if ($Reset) { Remove-StoredTargetCredential }

    $stored = Get-StoredTargetCredential
    if ($stored -is [pscredential]) {
        Write-Host "Using the saved server credential: $($stored.UserName) (use -ResetCredential to change it)"
        return $stored
    }
    if ("$stored" -eq 'CurrentAccount') {
        Write-Host 'Using your current account for the servers (saved choice; use -ResetCredential to change it)'
        return $null
    }
    if (-not $Prompt) { return $null }

    Write-Host 'Admin account on the target servers (Cancel = use your current account):'
    $entered = $null
    try { $entered = Get-Credential -Message 'Admin account on the target servers (e.g. DSLAB\admin)' } catch { $entered = $null }

    $answer = (Read-Host 'Save this for future runs on this server? Encrypted; only your Windows account can use it. [Y/N]').Trim()
    if ($answer -match '^(y|yes)$') {
        if ($entered) { Save-TargetCredential -Credential $entered } else { Save-TargetCredential -Credential 'CurrentAccount' }
        Write-Host "Saved to $(Get-CredentialStorePath)"
    }
    return $entered
}

function Get-SccmReadOnlySnapshot {
    param([object]$Settings,[string]$CollectionName)
    $server = [string]$Settings.SccmSiteServer
    $siteCode = [string]$Settings.SiteCode
    # Creates a local PowerShell drive only; no SCCM object is written.
    $null = Connect-CMSite -SiteCode $siteCode -SiteServer $server
    Push-Location ($siteCode + ':\')
    try {
        $collections = @(Get-CMDeviceCollection -ErrorAction Stop | Select-Object Name,CollectionID,MemberCount,LimitingCollectionName)
        $targetCollection = @($collections | Where-Object { $_.Name -ieq $CollectionName })
        $sugs = @(Get-CMSoftwareUpdateGroup -ErrorAction Stop | Select-Object LocalizedDisplayName,CI_ID,DateCreated,LastModifiedBy,DateLastModified)
        $devices = foreach ($target in (Get-ProjectConfig).Targets) {
            $shortName = ($target.Fqdn -split '\.')[0]
            $found = @(Get-CMDevice -Name $shortName -Fast -ErrorAction SilentlyContinue |
                Select-Object Name,ResourceId,Domain,Client,ClientVersion,IsActive,LastActiveTime,DeviceOS)
            [pscustomobject]@{ Fqdn=$target.Fqdn; ExpectedIPv4=$target.ExpectedIPv4; ShortName=$shortName; Matches=$found }
        }
        return [pscustomobject]@{
            SiteServer=$server; SiteCode=$siteCode; CollectionName=$CollectionName
            CollectionMatches=$targetCollection; Collections=$collections; SUGs=$sugs; Devices=@($devices)
        }
    } finally { Pop-Location }
}

Export-ModuleMember -Function Get-ProjectRoot,Get-ProjectConfig,New-RunFolder,Write-JsonReport,Resolve-Target,
    Get-PropertyValue,Connect-CMSite,New-SmsCimSession,Invoke-SmsQuery,Invoke-SmsQueryIn,Get-SccmReadOnlySnapshot,
    Get-CredentialStorePath,Get-StoredTargetCredential,Save-TargetCredential,Remove-StoredTargetCredential,Resolve-TargetCredential
