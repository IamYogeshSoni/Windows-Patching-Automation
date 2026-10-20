[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $root 'Modules\Common.psm1') -Force
$config = Get-ProjectConfig

Write-Host "`nSCCM Patching Automation - Environment Check" -ForegroundColor Cyan
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
Write-Host "Run as: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
Write-Host "Project: $root"
Write-Host "Targets: $($config.Targets.Count)"
foreach ($target in $config.Targets) {
    Write-Host ("  {0} -> {1}" -f $target.Fqdn,$target.ExpectedIPv4)
}
$checks = @()
$checks += [pscustomobject]@{Check='Windows PowerShell 5.1';Status=if($PSVersionTable.PSVersion.Major -eq 5){'PASS'}else{'WARNING'};Detail=$PSVersionTable.PSVersion.ToString()}
$ad = Get-Module -ListAvailable ActiveDirectory | Select-Object -First 1
$checks += [pscustomobject]@{Check='ActiveDirectory module';Status=if($ad){'AVAILABLE'}else{'NOT VERIFIED'};Detail=if($ad){$ad.Path}else{'Install RSAT AD PowerShell or run from an approved host with the module.'}}
$cmPath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager\ConfigurationManager.psd1'
if (-not (Test-Path $cmPath)) { $cmPath = Join-Path $env:ProgramFiles 'Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager\ConfigurationManager.psd1' }
$checks += [pscustomobject]@{Check='Configuration Manager module';Status=if(Test-Path $cmPath){'AVAILABLE'}else{'NOT VERIFIED'};Detail=$cmPath}
$checks | Format-Table -AutoSize | Out-Host
$checks | Export-Csv (Join-Path $root 'Reports\EnvironmentCheck.csv') -NoTypeInformation -Encoding UTF8
Write-Host "`nEnvironment check saved to Reports\EnvironmentCheck.csv"
