
import os
import re
import sys
import html
import json
import hmac
import base64
import sqlite3
import hashlib
import secrets
import subprocess
import threading
import getpass
import time
from collections import deque
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from threading import Lock
from typing import List, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reports  # noqa: E402  (HTML report renderers, next to this file)


# ============================================================
# CONFIGURATION
# ============================================================

# Settings and service-account credentials come from API\.env (python-dotenv;
# the file is git-ignored). SCCM_ENV_FILE may point to another file.
# Variables already set in the environment win.
ENV_FILE = os.environ.get("SCCM_ENV_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
ENV_FILE_LOADED = load_dotenv(ENV_FILE)

# Prompts are only a fallback for interactive starts; a background start
# (scheduled task, service) never waits for input. SCCM_NO_PROMPT=true
# turns them off completely.
INTERACTIVE = (
    bool(sys.stdin) and sys.stdin.isatty()
    and (os.environ.get("SCCM_NO_PROMPT") or "").strip().lower() != "true"
)
SETTING_SOURCES = {}


def _setting(name: str, prompt: str = "", secret: bool = False) -> str:
    value = os.environ.get(name)
    if value:
        SETTING_SOURCES[name] = "set"
        return value if secret else value.strip()
    if prompt and INTERACTIVE:
        try:
            entered = getpass.getpass(prompt) if secret else input(prompt).strip()
        except EOFError:
            entered = ""
        SETTING_SOURCES[name] = "prompt" if entered else "not set"
        return entered
    SETTING_SOURCES[name] = "not set"
    return ""


def _env(name: str, default: str) -> str:
    return (os.environ.get(name) or default).strip()


JUMPHOST = _env("SCCM_JUMPHOST", "ORDPGBLWTS21.global.cdk.com")
SITE_SERVER = _env("SCCM_SITE_SERVER", "ORDPGBLSCCM11.global.cdk.com")
SITE_CODE = _env("SCCM_SITE_CODE", "T01")

# RunAs endpoint registered on the jumphost (Register-PSSessionConfiguration).
SESSION_CONFIG = _env("SCCM_SESSION_CONFIG", "SCCMAutomation")

# The Automation folder on the jumphost (Run-Patching.ps1, Scripts\, Config\, Reports\).
PROJECT_ROOT = _env("SCCM_PROJECT_ROOT", r"C:\SCCM_Automation")

SCRIPTS = {
    "environment": "00-EnvironmentCheck.ps1",
    "prerequisites": "01-PrerequisiteChecks.ps1",
    "deployment": "04-DeployAndValidatePatches.ps1",
    "ad_servers": "Get-ADServers.ps1",
}

# Domains the UI may list servers from (Get-ADServers.ps1 on the jumphost).
AD_DOMAINS = [d.strip().lower() for d in _env("SCCM_AD_DOMAINS", "dslab.ad.adp.com").split(",") if d.strip()]

# Most servers one prerequisite run or deployment may target.
MAX_SERVERS_PER_RUN = int(_env("SCCM_MAX_SERVERS_PER_RUN", "50"))

# Exact membership the read-only dry run checks. Deployments use the
# allowlist in Config\TestServers.json on the jumphost instead.
ALLOWED_TARGETS = {
    "C03DGHHYPV8871",
    "C03DGHHYPV3621",
}

# Deployment creation stays off until the SCCM administrator has confirmed
# console/site compatibility and authorized writes. The jumphost's
# Config\Settings.json must also have AllowWriteOperations = true.
ALLOW_DEPLOYMENT = _env("SCCM_ALLOW_DEPLOYMENT", "false").lower() == "true"

DEPLOY_TIMEOUT_SECONDS = int(float(_env("SCCM_DEPLOY_TIMEOUT_HOURS", "12")) * 3600)

# Seconds a single PowerShell job may run before it is stopped.
JOB_TIMEOUTS = {
    "connection_test": 300,
    "environment": 900,
    "prerequisites": 1800,
    "inventory": 1800,
    "dry_run": 1800,
    "deployment": DEPLOY_TIMEOUT_SECONDS,
    "deployment_resume": DEPLOY_TIMEOUT_SECONDS,
    "deployment_lookup": 900,
    "dslab_connection_test": 300,
    "dslab_validate": 1800,
    "sugs": 2700,
    "collections": 900,
    "report_list": 300,
    "report_import": 300,
    "ad_servers": 900,
}

# Jobs whose result is a report (GET /api/reports).
REPORT_KINDS = ("environment", "prerequisites", "deployment", "deployment_resume", "report_import")

# Long-running deployments get their own worker so checks keep working.
DEPLOY_KINDS = {"deployment", "deployment_resume"}

# Inventory and dry-run results older than this cannot feed the next step.
RESULT_MAX_AGE = timedelta(hours=24)

# The maintenance window must still be open at least this long after submission.
MIN_WINDOW_REMAINING = timedelta(minutes=30)
MAX_WINDOW_START_AHEAD = timedelta(days=30)

# Longest a GET /api/jobs/{job_id}?wait=N call may hold the request open.
MAX_POLL_WAIT_SECONDS = 120
MAX_LOG_LINES_PER_RESPONSE = 1000

DB_PATH = _env(
    "SCCM_JOB_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs.db"),
)

API_KEY = _setting("SCCM_API_KEY")
if not API_KEY:
    raise RuntimeError(
        f"SCCM_API_KEY is not set. Add it to {ENV_FILE}"
        + ("" if ENV_FILE_LOADED else " (file not found)") + "."
    )

# Optional second key for admin actions (releasing the deployment lock).
# Not set: the normal API key is enough.
ADMIN_API_KEY = _setting("SCCM_ADMIN_API_KEY")

USERNAME = _setting("SCCM_USERNAME", r"Authorized domain username (e.g. GLOBAL\username): ")
PASSWORD = _setting("SCCM_PASSWORD", "Jumphost password: ", secret=True)

if not USERNAME or not PASSWORD:
    raise RuntimeError(
        "SCCM_USERNAME and SCCM_PASSWORD are required (jumphost login). Add them to the env file."
    )

# Admin account on the target servers (e.g. DSLAB\admin), passed to the
# deployment script for KB checks and restarts over WinRM. Optional: without
# it the script relies on SCCM and lets the SCCM client restart the servers.
TARGET_USERNAME = _setting(
    "SCCM_TARGET_USERNAME", r"Target server admin account (e.g. DSLAB\admin, Enter to skip): "
)
TARGET_PASSWORD = ""
if TARGET_USERNAME:
    TARGET_PASSWORD = _setting("SCCM_TARGET_PASSWORD", f"Password for {TARGET_USERNAME}: ", secret=True)
    if not TARGET_PASSWORD:
        print(f"WARNING: SCCM_TARGET_PASSWORD not set; {TARGET_USERNAME} is not used.", flush=True)
        TARGET_USERNAME = ""

# DSLAB jumphost: validates DSLAB servers from inside their own domain (as the
# server-list SOP does). The account logs on to the jumphost and to the servers.
DSLAB_JUMPHOST = _env("SCCM_DSLAB_JUMPHOST", "ordpdslwts01.dslab.ad.adp.com")
DSLAB_USERNAME = _env("SCCM_DSLAB_USERNAME", r"dslab\svc_patching_auto1")
DSLAB_SESSION_CONFIG = (os.environ.get("SCCM_DSLAB_SESSION_CONFIG") or "").strip()
DSLAB_AUTH = _env("SCCM_DSLAB_AUTH", "Negotiate")
DSLAB_DOMAIN = _env("SCCM_DSLAB_DOMAIN", "dslab.ad.adp.com")
DSLAB_PASSWORD = _setting(
    "SCCM_DSLAB_PASSWORD",
    f"Password for {DSLAB_USERNAME} on {DSLAB_JUMPHOST} (Enter to skip DSLAB checks): ",
    secret=True,
)

print(
    f"Env file: {ENV_FILE} ({'loaded' if ENV_FILE_LOADED else 'not found'})\n"
    f"Jumphost login: {USERNAME} (username: {SETTING_SOURCES.get('SCCM_USERNAME')}, "
    f"password: {SETTING_SOURCES.get('SCCM_PASSWORD')}); endpoint '{SESSION_CONFIG}' on {JUMPHOST}\n"
    f"Project root on the jumphost: {PROJECT_ROOT}\n"
    f"Target servers: {TARGET_USERNAME or (DSLAB_USERNAME + ' (DSLAB account)' if DSLAB_PASSWORD else 'no account (SCCM-only validation)')}\n"
    f"DSLAB jumphost: {DSLAB_JUMPHOST + ' as ' + DSLAB_USERNAME if DSLAB_PASSWORD else 'not configured'}\n"
    f"Admin key for release-lock: {'set' if ADMIN_API_KEY else 'not set (the API key is enough)'}",
    flush=True,
)

# Browser origins allowed to call the API (the frontend's dev/prod URLs).
CORS_ORIGINS = [
    origin.strip()
    for origin in _env(
        "SCCM_CORS_ORIGINS", "http://localhost:3000,http://localhost:5173"
    ).split(",")
    if origin.strip()
]

app = FastAPI(
    title="SCCM Patching Automation API",
    version="4.0.0",
    description=(
        "Environment and prerequisite checks with HTML reports, server selection, "
        "SUG list, and Required deployments run end to end by "
        "04-DeployAndValidatePatches.ps1 on the jumphost - one deployment at a "
        "time across all users. Every operation is a background job; poll "
        "GET /api/jobs/{job_id}?wait=N&log_after=M for status and live log lines."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["X-API-Key", "X-Admin-Key", "X-User", "Idempotency-Key", "Content-Type"],
)


# ============================================================
# POWERSHELL EXECUTION
# ============================================================

# Everything the remote side prints is streamed back line by line and stored
# as the job log. The final result is one JSON line starting with this marker.
RESULT_MARKER = "##RESULT## "

POWERSHELL_WRAPPER = r"""
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$operation = $env:SCCM_OPERATION | ConvertFrom-Json

$secure = ConvertTo-SecureString $env:SCCM_PASSWORD -AsPlainText -Force
$credential = [System.Management.Automation.PSCredential]::new(
    $env:SCCM_USERNAME, $secure
)
$remoteScript = [scriptblock]::Create($env:SCCM_REMOTE_SCRIPT)
$targetCredential = $null
if ($env:SCCM_TARGET_USERNAME) {
    $targetCredential = [System.Management.Automation.PSCredential]::new(
        $env:SCCM_TARGET_USERNAME,
        (ConvertTo-SecureString $env:SCCM_TARGET_PASSWORD -AsPlainText -Force)
    )
}
$session = $null

try {
    # Which jumphost, endpoint and authentication come from the job's target
    # (the SCCM jumphost or the DSLAB jumphost).
    $sessionParams = @{
        ComputerName = $env:SCCM_JUMPHOST
        Authentication = $env:SCCM_SESSION_AUTH
        Credential = $credential
        ErrorAction = 'Stop'
    }
    if ($env:SCCM_SESSION_CONFIG) { $sessionParams.ConfigurationName = $env:SCCM_SESSION_CONFIG }
    try {
        $session = New-PSSession @sessionParams
    }
    catch {
        throw (
            "Could not open a session on $($env:SCCM_JUMPHOST) " +
            "(endpoint '$(if ($env:SCCM_SESSION_CONFIG) { $env:SCCM_SESSION_CONFIG } else { 'default' })', " +
            "$($env:SCCM_SESSION_AUTH)) as $($env:SCCM_USERNAME): " +
            $_.Exception.Message
        )
    }

    # All remote streams come back through the pipeline (*>&1) and are written
    # as plain lines, so warnings and errors appear in the job log as they
    # happen instead of as serialized XML on stderr when the process ends.
    $payload = Invoke-Command -Session $session -ErrorAction Stop `
        -ArgumentList $operation, $env:SCCM_SITE_SERVER, $env:SCCM_SITE_CODE, $targetCredential `
        -ScriptBlock $remoteScript *>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.InformationRecord]) { Write-Host "$($_.MessageData)" }
            elseif ($_ -is [System.Management.Automation.WarningRecord]) { Write-Host "WARNING: $($_.Message)" }
            elseif ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host "ERROR: $($_.Exception.Message)" }
            elseif ($_ -is [System.Management.Automation.VerboseRecord] -or $_ -is [System.Management.Automation.DebugRecord]) { }
            else { $_ }
        }

    $last = @($payload)[-1]
    '##RESULT## ' + ($last |
        Select-Object -Property * -ExcludeProperty PSComputerName, RunspaceId, PSShowComputerName |
        ConvertTo-Json -Depth 10 -Compress)
}
catch {
    '##RESULT## ' + ([pscustomobject]@{
        success = $false
        errors = @($_.Exception.Message)
    } | ConvertTo-Json -Depth 8 -Compress)
}
finally {
    if ($null -ne $session) {
        Remove-PSSession $session -ErrorAction SilentlyContinue
    }
}
"""

# The remote part: runs inside the jumphost session.
REMOTE_SCRIPT = r"""
        param($operation, $siteServer, $siteCode, $targetCredential)

        $ErrorActionPreference = 'Stop'
        $ProgressPreference = 'SilentlyContinue'

        # Say where and as whom any failure happened, e.g. to tell a
        # jumphost folder permission problem from an SCCM rights problem.
        $runAs = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        trap { throw "[$env:COMPUTERNAME as $runAs] $($_.Exception.Message)" }

        $modulePath = Join-Path ${env:ProgramFiles(x86)} `
            'Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager\ConfigurationManager.psd1'

        # Reports each access separately and never stops early, so one call
        # shows where an "access denied" comes from.
        if ($operation.Kind -eq 'ConnectionTest') {
            $root = [string]$operation.ProjectRoot

            $scriptsFolder = try {
                $count = @(Get-ChildItem -LiteralPath (Join-Path $root 'Scripts') -ErrorAction Stop).Count
                "OK: $count files"
            } catch { "FAILED: $($_.Exception.Message)" }

            $reportsFolder = try {
                $reports = Join-Path $root 'Reports'
                New-Item -ItemType Directory -Path $reports -Force -ErrorAction Stop | Out-Null
                $probe = Join-Path $reports '.api_write_test'
                Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop
                Remove-Item -LiteralPath $probe -ErrorAction Stop
                'OK: writable'
            } catch { "FAILED: $($_.Exception.Message)" }

            $sccm = try {
                Import-Module $modulePath -ErrorAction Continue 2>$null 3>$null
                if (-not (Get-Module ConfigurationManager)) { throw 'ConfigurationManager module did not load.' }
                if (-not (Get-PSDrive -Name $siteCode -PSProvider CMSite -ErrorAction SilentlyContinue)) {
                    New-PSDrive -Name $siteCode -PSProvider CMSite -Root $siteServer `
                        -ErrorAction Continue 2>$null 3>$null | Out-Null
                }
                Set-Location "$($siteCode):\"
                $site = Get-CMSite -ErrorAction Stop
                "OK: site $($site.SiteCode) version $($site.Version)"
            } catch { "FAILED: $($_.Exception.Message)" }

            $targets = if ($targetCredential) { "account $($targetCredential.UserName) supplied" } else { 'no account supplied (SCCM-only validation)' }

            return [pscustomobject]@{
                success = $true
                host = $env:COMPUTERNAME
                run_as = $runAs
                project_root = $root
                scripts_folder = $scriptsFolder
                reports_folder = $reportsFolder
                sccm = $sccm
                target_servers = $targets
            }
        }

        # Windows servers from Active Directory (Get-ADServers.ps1), to choose patch targets from.
        if ($operation.Kind -eq 'AdServerList') {
            $path = Join-Path ([string]$operation.ProjectRoot) 'Scripts\Get-ADServers.ps1'
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Script not found: $path" }
            $p = @{ Domain = [string]$operation.Domain; MaxResults = [int]$operation.MaxResults }
            if ($operation.NameFilter) { $p.NameFilter = [string]$operation.NameFilter }
            if ($operation.SearchBase) { $p.SearchBase = [string]$operation.SearchBase }
            if ($targetCredential) { $p.Credential = $targetCredential }
            Write-Host "Running $path as $runAs"
            $rows = @(& $path @p | Where-Object { $_ -and $_.PSObject.Properties['Name'] })
            return [pscustomobject]@{
                success = $true
                host = $env:COMPUTERNAME
                run_as = $runAs
                domain = $p.Domain
                name_filter = $p.NameFilter
                search_base = $p.SearchBase
                count = $rows.Count
                truncated = ($rows.Count -ge $p.MaxResults)
                servers = $rows
            }
        }

        # A new remoting session has no CMSite drive, so create it here, in
        # the global scope so the project scripts also find it. The session
        # runs under the jumphost's RunAs endpoint (SCCM_SESSION_CONFIG),
        # which holds a full logon and so avoids the Kerberos double hop.
        # The module reports a console/site version mismatch as a
        # non-terminating error. An interactive console shows it and carries
        # on, so do the same here: collect it, then fail only if the module
        # or the drive is actually missing.
        $cmWarnings = @()
        if (-not (Get-Module ConfigurationManager)) {
            Import-Module $modulePath -ErrorAction Continue `
                -ErrorVariable +cmWarnings 2>$null 3>$null
        }
        if (-not (Get-Module ConfigurationManager)) {
            throw "ConfigurationManager module failed to load: $($cmWarnings -join '; ')"
        }
        if (-not (Get-PSDrive -Name $siteCode -PSProvider CMSite -ErrorAction SilentlyContinue)) {
            New-PSDrive -Name $siteCode -PSProvider CMSite -Root $siteServer `
                -Scope Global -ErrorAction Continue `
                -ErrorVariable +cmWarnings 2>$null 3>$null | Out-Null
        }
        if (-not (Get-PSDrive -Name $siteCode -PSProvider CMSite -ErrorAction SilentlyContinue)) {
            throw "$siteCode CMSite drive could not be created: $($cmWarnings -join '; ')"
        }
        $cmWarnings = @($cmWarnings | ForEach-Object { "$_" } | Sort-Object -Unique)

        function Get-VerifiedSite {
            Set-Location "$($siteCode):\"
            $site = Get-CMSite -ErrorAction Stop
            if ($site.SiteCode -ne $siteCode) {
                throw "Unexpected site code: $($site.SiteCode)"
            }
            $site
        }

        # Resolves the SUG and collection by their stable IDs and checks the
        # collection contains exactly the allowlisted servers.
        function Get-ValidatedSelection {
            param($SugId, $CollectionId, $AllowedTargets)

            $sug = @(Get-CMSoftwareUpdateGroup -Id ([int]$SugId) -ErrorAction Stop)
            if ($sug.Count -ne 1) {
                throw "SUG ID $SugId did not resolve to exactly one software update group."
            }
            $sugName = if ($sug[0].LocalizedDisplayName) {
                $sug[0].LocalizedDisplayName
            } else {
                $sug[0].Name
            }

            $collection = @(Get-CMDeviceCollection -Id ([string]$CollectionId) -ErrorAction Stop)
            if ($collection.Count -ne 1) {
                throw "Collection ID $CollectionId did not resolve to exactly one collection."
            }

            $memberNames = @(
                Get-CMDevice -CollectionId ([string]$CollectionId) -Fast -ErrorAction Stop |
                ForEach-Object { $_.Name.ToUpperInvariant() } |
                Sort-Object -Unique
            )
            $expected = @($AllowedTargets |
                ForEach-Object { $_.ToUpperInvariant() } |
                Sort-Object -Unique)
            $missing = @($expected | Where-Object { $_ -notin $memberNames })
            $unexpected = @($memberNames | Where-Object { $_ -notin $expected })

            if ($missing.Count -gt 0 -or
                $unexpected.Count -gt 0 -or
                $memberNames.Count -ne $expected.Count) {
                throw (
                    "Collection membership mismatch. " +
                    "Missing=[$($missing -join ',')]; " +
                    "Unexpected=[$($unexpected -join ',')]."
                )
            }

            $updates = @(
                Get-CMSoftwareUpdate -UpdateGroupName $sugName `
                    -Fast -ErrorAction Stop
            )
            if ($updates.Count -eq 0) {
                throw "No updates found in SUG '$sugName'."
            }

            [pscustomobject]@{
                SugId = [string]$SugId
                SugName = [string]$sugName
                CollectionId = [string]$CollectionId
                CollectionName = [string]$collection[0].Name
                Targets = $memberNames
                Updates = $updates
            }
        }

        # Reads a Reports\<timestamp> folder: a deployment run (Summary.json,
        # Validation_KBs.csv) or a prerequisite run (Phase1_*.json/csv).
        function Read-RunReport([string]$Folder) {
            $r = [ordered]@{ report_folder = $Folder; report_folder_name = (Split-Path $Folder -Leaf); report_type = 'other' }
            $summaryFile = Join-Path $Folder 'Summary.json'
            $prereqFile = Join-Path $Folder 'Phase1_PrerequisiteResults.json'
            if (Test-Path -LiteralPath $summaryFile) {
                $r.report_type = 'deployment'
                $r.summary = Get-Content -LiteralPath $summaryFile -Raw | ConvertFrom-Json
                $csv = Join-Path $Folder 'Validation_KBs.csv'
                $r.validation = if (Test-Path -LiteralPath $csv) { @(Import-Csv -LiteralPath $csv) } else { @() }
            } elseif (Test-Path -LiteralPath $prereqFile) {
                $r.report_type = 'prerequisites'
                $parsed = Get-Content -LiteralPath $prereqFile -Raw | ConvertFrom-Json
                $r.checks = @($parsed | ForEach-Object { $_ })
                $csv = Join-Path $Folder 'Phase1_ServerSummary.csv'
                $r.servers = if (Test-Path -LiteralPath $csv) { @(Import-Csv -LiteralPath $csv) } else { @() }
            }
            $r
        }

        switch ($operation.Kind) {
            'RunFixedScript' {
                $path = $operation.Path

                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                    throw "Script not found: $path"
                }

                # Scripts expect to start from the project root, as in Run Docs.
                Set-Location (Split-Path (Split-Path $path -Parent) -Parent)

                # The server account lets 01-PrerequisiteChecks.ps1 read uptime,
                # disk and reboot state from the servers instead of "Access is denied".
                $scriptArgs = @{}
                if ($operation.PassTargetCredential -and $targetCredential) { $scriptArgs.TargetCredential = $targetCredential }
                $chosen = @($operation.Servers | Where-Object { $_ })
                if ($chosen.Count -gt 0) { $scriptArgs.Servers = [string[]]$chosen }
                Write-Host "Running $path as $runAs$(if ($scriptArgs.TargetCredential) { "; server account $($targetCredential.UserName)" } else { '; no server account' })"

                # Show every line live (job log) and keep it for the result.
                # Scripts that prompt with Read-Host are not used by this endpoint.
                $started = Get-Date
                $items = @(& $path @scriptArgs *>&1 | ForEach-Object { Write-Host "$_"; $_ })
                $text = ($items | ForEach-Object { "$_" }) -join "`n"

                $result = [ordered]@{
                    success = $true
                    warnings = $cmWarnings
                    run_as = $runAs
                    host = $env:COMPUTERNAME
                    script = $path
                    output = $text
                    errors = @()
                }

                # Return what the script wrote as data, not as a file path.
                $reportsRoot = Join-Path (Split-Path (Split-Path $path -Parent) -Parent) 'Reports'
                if ($operation.Collect -eq 'environment') {
                    $csv = Join-Path $reportsRoot 'EnvironmentCheck.csv'
                    if ((Test-Path -LiteralPath $csv) -and (Get-Item -LiteralPath $csv).LastWriteTime -ge $started.AddSeconds(-5)) {
                        $result.checks = @(Import-Csv -LiteralPath $csv)
                    }
                } elseif ($operation.Collect -eq 'prerequisites') {
                    $folder = Get-ChildItem -LiteralPath $reportsRoot -Directory -ErrorAction SilentlyContinue |
                        Where-Object { $_.CreationTime -ge $started.AddSeconds(-5) -and
                            (Test-Path -LiteralPath (Join-Path $_.FullName 'Phase1_PrerequisiteResults.json')) } |
                        Sort-Object CreationTime | Select-Object -Last 1
                    if ($folder) {
                        $report = Read-RunReport $folder.FullName
                        $result.report_folder_name = $report.report_folder_name
                        $result.checks = $report.checks
                        $result.servers = $report.servers
                    } else {
                        $result.warnings = @($cmWarnings) + 'The prerequisite report files were not found; see output.'
                    }
                }
                [pscustomobject]$result
            }

            # SUGs with their updates and KBs, for the deployment's SUG dropdown.
            'SugList' {
                $null = Get-VerifiedSite
                $filter = [string]$operation.NameFilter
                $groups = @(Get-CMSoftwareUpdateGroup -ErrorAction Stop | Where-Object {
                    -not $filter -or ([string]$_.LocalizedDisplayName) -like "*$filter*"
                } | Sort-Object LocalizedDisplayName)
                Write-Host "$($groups.Count) software update groups$(if ($filter) { " matching '$filter'" })."

                $i = 0
                $sugs = @(foreach ($g in $groups) {
                    $i++
                    $name = if ($g.LocalizedDisplayName) { [string]$g.LocalizedDisplayName } else { [string]$g.Name }
                    $updates = @()
                    $readError = $null
                    if ($operation.IncludeKbs) {
                        try { $updates = @(Get-CMSoftwareUpdate -UpdateGroupName $name -Fast -ErrorAction Stop) }
                        catch { $readError = "Updates not read: $($_.Exception.Message)" }
                    }
                    $kbs = @($updates | ForEach-Object { [string]$_.ArticleID } | Where-Object { $_ } |
                        ForEach-Object { if ($_ -match '^\d+$') { "KB$_" } else { $_ } } | Sort-Object -Unique)
                    if ($operation.IncludeKbs) {
                        Write-Host ("[{0}/{1}] {2}: {3} updates, {4} KBs" -f $i, $groups.Count, $name, $updates.Count, $kbs.Count)
                    }
                    [pscustomobject]@{
                        id = [string]$g.CI_ID
                        name = $name
                        description = [string]$g.LocalizedDescription
                        created_utc = if ($g.DateCreated) { ([datetime]$g.DateCreated).ToUniversalTime().ToString('o') } else { $null }
                        modified_utc = if ($g.DateLastModified) { ([datetime]$g.DateLastModified).ToUniversalTime().ToString('o') } else { $null }
                        deployed = [bool]$g.IsDeployed
                        update_count = if ($operation.IncludeKbs) { $updates.Count } else { $null }
                        kb_count = if ($operation.IncludeKbs) { $kbs.Count } else { $null }
                        expired_count = @($updates | Where-Object { $_.IsExpired }).Count
                        superseded_count = @($updates | Where-Object { $_.IsSuperseded }).Count
                        kbs = $kbs
                        updates = @($updates | Select-Object -First 300 | ForEach-Object {
                            [pscustomobject]@{
                                kb = if ([string]$_.ArticleID -match '^\d+$') { "KB$($_.ArticleID)" } else { [string]$_.ArticleID }
                                title = [string]$_.LocalizedDisplayName
                                ci_id = [string]$_.CI_ID
                                expired = [bool]$_.IsExpired
                                superseded = [bool]$_.IsSuperseded
                            }
                        })
                        updates_truncated = ($updates.Count -gt 300)
                        error = $readError
                    }
                })

                [pscustomobject]@{
                    success = $true
                    warnings = $cmWarnings
                    run_as = $runAs
                    count = $sugs.Count
                    sugs = $sugs
                }
            }

            'CollectionList' {
                $null = Get-VerifiedSite
                $filter = [string]$operation.NameFilter
                $collections = @(Get-CMDeviceCollection -ErrorAction Stop | Where-Object {
                    -not $filter -or ([string]$_.Name) -like "*$filter*"
                } | Sort-Object Name)
                Write-Host "$($collections.Count) device collections$(if ($filter) { " matching '$filter'" })."
                # Members only on request and for small collections (one query per collection).
                $list = @(foreach ($c in $collections) {
                    $members = $null
                    if ($operation.IncludeMembers -and [int]$c.MemberCount -le 50) {
                        $members = @(Get-CMDevice -CollectionId $c.CollectionID -Fast -ErrorAction SilentlyContinue |
                            ForEach-Object { $_.Name.ToUpperInvariant() } | Sort-Object)
                    }
                    [pscustomobject]@{
                        id = [string]$c.CollectionID
                        name = [string]$c.Name
                        member_count = [int]$c.MemberCount
                        limiting_collection = [string]$c.LimitToCollectionName
                        comment = [string]$c.Comment
                        members = $members
                    }
                })
                [pscustomobject]@{
                    success = $true
                    warnings = $cmWarnings
                    run_as = $runAs
                    count = $list.Count
                    collections = $list
                }
            }

            # Report folders on the jumphost (runs from the API and from Run-Patching.ps1).
            'ReportList' {
                $reportsRoot = Join-Path ([string]$operation.ProjectRoot) 'Reports'
                $folders = @(Get-ChildItem -LiteralPath $reportsRoot -Directory -ErrorAction Stop |
                    Where-Object { $_.Name -match '^\d{8}_\d{6}Z$' } |
                    Sort-Object Name -Descending | Select-Object -First ([int]$operation.Limit))
                $list = @(foreach ($f in $folders) {
                    $info = [ordered]@{ report_folder = $f.Name; type = 'other'; created_utc = $f.CreationTimeUtc.ToString('o') }
                    $summaryFile = Join-Path $f.FullName 'Summary.json'
                    if (Test-Path -LiteralPath $summaryFile) {
                        $info.type = 'deployment'
                        try {
                            $s = Get-Content -LiteralPath $summaryFile -Raw | ConvertFrom-Json
                            $results = @($s.Results | Where-Object { $_ })
                            $info.mode = $s.Mode
                            $info.deployment_name = $s.DeploymentName
                            $info.sug = $s.SUG
                            $info.collection = $s.Collection
                            $info.servers = $results.Count
                            $info.patched = @($results | Where-Object { $_.Verdict -eq 'PATCHED' }).Count
                            $info.error = if ($s.PSObject.Properties['Error']) { [string]$s.Error } else { $null }
                        } catch { $info.error = "Summary.json not readable: $($_.Exception.Message)" }
                    } elseif (Test-Path -LiteralPath (Join-Path $f.FullName 'Phase1_PrerequisiteResults.json')) {
                        $info.type = 'prerequisites'
                        $csv = Join-Path $f.FullName 'Phase1_ServerSummary.csv'
                        if (Test-Path -LiteralPath $csv) {
                            $rows = @(Import-Csv -LiteralPath $csv)
                            $info.servers = $rows.Count
                            $info.ready = @($rows | Where-Object { $_.Overall -eq 'READY' }).Count
                        }
                    }
                    [pscustomobject]$info
                })
                [pscustomobject]@{ success = $true; host = $env:COMPUTERNAME; count = $list.Count; reports = $list }
            }

            'ReportRead' {
                $folder = Join-Path ([string]$operation.ProjectRoot) "Reports\$($operation.ReportFolder)"
                if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw "Report folder not found: $folder" }
                $report = Read-RunReport $folder
                if ($report.report_type -eq 'other') { throw "No deployment or prerequisite report in $folder." }
                $out = [ordered]@{ success = $true; host = $env:COMPUTERNAME; run_as = $runAs }
                foreach ($key in $report.Keys) { $out[$key] = $report[$key] }
                if ($report.report_type -eq 'deployment') {
                    $s = $report.summary
                    $out.deployment_name = $s.DeploymentName
                    $out.sug = $s.SUG
                    $out.collection = $s.Collection
                    $out.collection_created = [bool]($s.PSObject.Properties['CollectionCreated'] -and $s.CollectionCreated)
                    $out.deployment = if ($s.PSObject.Properties['Deployment']) { $s.Deployment } else { $null }
                    $out.maintenance_window = if ($s.PSObject.Properties['MaintenanceWindow']) { $s.MaintenanceWindow } else { $null }
                    $out.servers = if ($s.PSObject.Properties['Results']) { @($s.Results) } else { @() }
                    $out.errors = if ($s.PSObject.Properties['Error'] -and $s.Error) { @([string]$s.Error) } else { @() }
                }
                [pscustomobject]$out
            }

            'Inventory' {
                $site = Get-VerifiedSite

                $sugs = @(
                    Get-CMSoftwareUpdateGroup -ErrorAction Stop |
                    Sort-Object LocalizedDisplayName |
                    ForEach-Object {
                        $name = if ($_.LocalizedDisplayName) {
                            $_.LocalizedDisplayName
                        } else {
                            $_.Name
                        }

                        [pscustomobject]@{
                            id = [string]$_.CI_ID
                            name = [string]$name
                        }
                    }
                )

                $collections = @(
                    Get-CMDeviceCollection -ErrorAction Stop |
                    Sort-Object Name |
                    ForEach-Object {
                        [pscustomobject]@{
                            id = [string]$_.CollectionID
                            name = [string]$_.Name
                            member_count = [int]$_.MemberCount
                        }
                    }
                )

                [pscustomobject]@{
                    success = $true
                    warnings = $cmWarnings
                    run_as = $runAs
                    host = $env:COMPUTERNAME
                    site = [string]$site.SiteCode
                    site_version = [string]$site.Version
                    sugs = $sugs
                    collections = $collections
                }
            }

            'DryRun' {
                $site = Get-VerifiedSite
                $selection = Get-ValidatedSelection `
                    $operation.SugId $operation.CollectionId $operation.AllowedTargets
                $updates = $selection.Updates

                [pscustomobject]@{
                    success = $true
                    warnings = $cmWarnings
                    run_as = $runAs
                    mode = 'READ_ONLY_DRY_RUN'
                    site = [string]$site.SiteCode
                    site_version = [string]$site.Version
                    selected_sug = $selection.SugName
                    selected_sug_id = $selection.SugId
                    selected_collection = $selection.CollectionName
                    selected_collection_id = $selection.CollectionId
                    targets = $selection.Targets
                    update_count = $updates.Count
                    updates = @(
                        $updates | Select-Object -First 100 |
                        ForEach-Object {
                            [pscustomobject]@{
                                title = [string]$_.LocalizedDisplayName
                                article_id = [string]$_.ArticleID
                                ci_id = [string]$_.CI_ID
                            }
                        }
                    )
                    update_list_truncated = ($updates.Count -gt 100)
                    deployment_created = $false
                }
            }

            # Runs the proven end-to-end script unattended: collection, content,
            # maintenance window, Required deployment, install, restart and KB
            # validation. Its console output streams back as the job log.
            'RunDeployment' {
                $root = [string]$operation.ProjectRoot
                $scriptPath = Join-Path $root 'Scripts\04-DeployAndValidatePatches.ps1'
                if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
                    throw "No deployment created. Script not found: $scriptPath"
                }

                $p = @{ Confirm = $false }
                $collectionCreated = $false
                $sugName = [string]$operation.SugName
                $collectionName = [string]$operation.CollectionName
                if ($operation.Resume) {
                    $p.Resume = $true
                    if ($operation.ReportFolder) { $p.ResumeFrom = Join-Path $root "Reports\$($operation.ReportFolder)" }
                } else {
                    $selected = @($operation.Servers | ForEach-Object { ([string]$_ -split '\.')[0].ToUpperInvariant() } | Sort-Object -Unique)
                    Push-Location "$($siteCode):\"
                    try {
                        # SUG by its stable ID (from POST /api/sccm/sugs).
                        $sug = @(Get-CMSoftwareUpdateGroup -Id ([int]$operation.SugId) -ErrorAction Stop)
                        if ($sug.Count -ne 1) { throw "No deployment created. SUG ID $($operation.SugId) did not resolve to one software update group." }
                        $sugName = if ($sug[0].LocalizedDisplayName) { [string]$sug[0].LocalizedDisplayName } else { [string]$sug[0].Name }
                        Write-Host "SUG: $sugName (ID $($operation.SugId))"

                        # The script would prompt if a deployment with this name exists;
                        # unattended, refuse up front instead.
                        $existing = @(Get-CMSoftwareUpdateDeployment -Name ([string]$operation.DeploymentName) -ErrorAction SilentlyContinue)
                        if ($existing.Count -gt 0) {
                            throw ("No deployment created. A deployment named '$($operation.DeploymentName)' already exists. " +
                                'Use a new name, or POST /api/sccm/deployments/resume to continue a run that was cut off.')
                        }

                        if ($operation.NewCollection) {
                            # New collection with exactly the servers the user selected.
                            $settings = Get-Content -LiteralPath (Join-Path $root 'Config\Settings.json') -Raw | ConvertFrom-Json
                            if ($settings.AllowWriteOperations -ne $true) {
                                throw 'No deployment created. Config\Settings.json on the jumphost has AllowWriteOperations = false.'
                            }
                            if (@(Get-CMDeviceCollection -Name $collectionName -ErrorAction Stop).Count -gt 0) {
                                throw "No deployment created. Collection '$collectionName' already exists; select it as an existing collection."
                            }
                            $limitingName = if ($operation.LimitingCollectionName) { [string]$operation.LimitingCollectionName }
                                            elseif ($settings.LimitingCollectionName) { [string]$settings.LimitingCollectionName }
                                            else { 'All Systems' }
                            $limiting = @(Get-CMDeviceCollection -Name $limitingName -ErrorAction Stop)
                            if ($limiting.Count -ne 1) { throw "No deployment created. Limiting collection '$limitingName' found $($limiting.Count) times; expected one." }
                            $devices = @(foreach ($short in $selected) {
                                $found = @(Get-CMDevice -Name $short -Fast -ErrorAction Stop | Where-Object { $_ })
                                if ($found.Count -ne 1) { throw "No deployment created. Expected one SCCM device record for '$short'; found $($found.Count)." }
                                $found[0]
                            })

                            Write-Host "Creating device collection '$collectionName' (limited to '$limitingName') with $($selected -join ', ')"
                            $newCollection = New-CMDeviceCollection -Name $collectionName -LimitingCollectionId $limiting[0].CollectionID `
                                -Comment "Patch collection created by the SCCM Patching API. Change=$($operation.ChangeTicket); Approver=$($operation.Approver); RequestedBy=$($operation.RequestedBy)" -ErrorAction Stop
                            $collectionCreated = $true
                            foreach ($d in $devices) {
                                Add-CMDeviceCollectionDirectMembershipRule -CollectionId $newCollection.CollectionID -ResourceId ([int]$d.ResourceID) -ErrorAction Stop
                            }
                            Invoke-CMCollectionUpdate -Name $collectionName -ErrorAction SilentlyContinue | Out-Null

                            $expected = $selected -join ','
                            $stopAt = (Get-Date).AddMinutes(10)
                            do {
                                Start-Sleep -Seconds 15
                                $current = @(Get-CMDevice -CollectionId $newCollection.CollectionID -Fast -ErrorAction Stop |
                                    ForEach-Object { $_.Name.ToUpperInvariant() } | Sort-Object -Unique) -join ','
                                Write-Host "  Collection members so far: $(if ($current) { $current } else { '(none yet)' })"
                            } while ($current -ne $expected -and (Get-Date) -lt $stopAt)
                            if ($current -ne $expected) {
                                throw ("No deployment created. Collection '$collectionName' ($($newCollection.CollectionID)) was created, but SCCM has not " +
                                    'evaluated its membership after 10 minutes. Start the deployment again with this collection selected.')
                            }
                            Write-Host "Collection '$collectionName' ($($newCollection.CollectionID)) contains $expected."
                        } else {
                            # Existing collection: must hold exactly the selected servers.
                            $col = @(Get-CMDeviceCollection -Id ([string]$operation.CollectionId) -ErrorAction Stop)
                            if ($col.Count -ne 1) { throw "No deployment created. Collection ID $($operation.CollectionId) did not resolve to one collection." }
                            $collectionName = [string]$col[0].Name
                            $members = @(Get-CMDevice -CollectionId $col[0].CollectionID -Fast -ErrorAction Stop |
                                ForEach-Object { $_.Name.ToUpperInvariant() } | Sort-Object -Unique)
                            $missing = @($selected | Where-Object { $_ -notin $members })
                            $extra = @($members | Where-Object { $_ -notin $selected })
                            if ($missing.Count -gt 0 -or $extra.Count -gt 0) {
                                throw ("No deployment created. Collection '$collectionName' does not match the selected servers. " +
                                    "Selected but not in the collection: [$($missing -join ', ')]; in the collection but not selected: [$($extra -join ', ')]. " +
                                    'Select a matching collection or create a new one.')
                            }
                            Write-Host "Collection '$collectionName' ($($col[0].CollectionID)) holds exactly the selected servers: $($selected -join ', ')"
                        }
                    } finally { Pop-Location }

                    $p.SugName = $sugName
                    $p.CollectionName = $collectionName
                    $p.DeploymentName = [string]$operation.DeploymentName
                    $p.ConfirmDeploymentName = [string]$operation.DeploymentName
                    $p.ChangeTicket = [string]$operation.ChangeTicket
                    $p.Approver = [string]$operation.Approver
                    $p.ApprovalReference = [string]$operation.ApprovalReference
                    $p.MaintenanceWindowStartUtc = [string]$operation.MaintenanceWindowStartUtc
                    $p.MaintenanceWindowHours = [int]$operation.MaintenanceWindowHours
                    if ($operation.DeadlineUtc) { $p.DeadlineUtc = [string]$operation.DeadlineUtc }
                    if ($operation.LimitingCollectionName) { $p.LimitingCollectionName = [string]$operation.LimitingCollectionName }
                    $kbs = @($operation.Kb | Where-Object { $_ })
                    if ($kbs.Count -gt 0) { $p.Kb = [string[]]$kbs }
                    # The run may patch exactly the selected servers (instead of Config\TestServers.json).
                    $p.TargetServers = [string[]]@($operation.Servers | Where-Object { $_ })
                }
                if ($operation.RestartMode) { $p.RestartMode = [string]$operation.RestartMode }
                if ($targetCredential) { $p.TargetCredential = $targetCredential }

                Set-Location $root
                $started = Get-Date
                Write-Host "Running $scriptPath on $env:COMPUTERNAME as $runAs$(if ($targetCredential) { "; server account $($targetCredential.UserName)" })"
                & $scriptPath @p | Out-Host
                $exitCode = $LASTEXITCODE

                # Collect the run's report (Summary.json + Validation_KBs.csv).
                $summaryFile = Get-ChildItem -LiteralPath (Join-Path $root 'Reports') -Recurse -Filter Summary.json -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -ge $started.AddSeconds(-5) } |
                    Sort-Object LastWriteTime | Select-Object -Last 1
                $summary = $null
                $validation = @()
                $folder = $null
                if ($summaryFile) {
                    $folder = $summaryFile.DirectoryName
                    $report = Read-RunReport $folder
                    $summary = $report.summary
                    $validation = @($report.validation | Where-Object { $_ })
                }
                $errorText = if ($summary -and $summary.PSObject.Properties['Error']) { [string]$summary.Error } else { $null }

                [pscustomobject]@{
                    success = ($exitCode -eq 0)
                    exit_code = $exitCode
                    warnings = $cmWarnings
                    run_as = $runAs
                    host = $env:COMPUTERNAME
                    report_folder = $folder
                    report_folder_name = if ($folder) { Split-Path $folder -Leaf } else { $null }
                    deployment_name = if ($summary) { $summary.DeploymentName } else { [string]$operation.DeploymentName }
                    deployment_created = [bool]($summary -and $summary.PSObject.Properties['Deployment'] -and $summary.Deployment)
                    sug = if ($summary) { $summary.SUG } else { $null }
                    collection = if ($summary) { $summary.Collection } else { $null }
                    collection_created = [bool]($collectionCreated -or ($summary -and $summary.PSObject.Properties['CollectionCreated'] -and $summary.CollectionCreated))
                    selected_servers = @($operation.Servers | Where-Object { $_ })
                    deadline_utc = $operation.DeadlineUtc
                    summary = $summary
                    deployment = if ($summary -and $summary.PSObject.Properties['Deployment']) { $summary.Deployment } else { $null }
                    maintenance_window = if ($summary -and $summary.PSObject.Properties['MaintenanceWindow']) { $summary.MaintenanceWindow } else { $null }
                    servers = if ($summary -and $summary.PSObject.Properties['Results']) { @($summary.Results) } else { @() }
                    validation = $validation
                    errors = if ($errorText) { @($errorText) } elseif ($exitCode -ge 2 -or -not $summary) { @("The deployment script ended with exit code $exitCode; see the job log.") } else { @() }
                }
            }

            'DeploymentLookup' {
                $null = Get-VerifiedSite
                $name = [string]$operation.DeploymentName
                $found = @(Get-CMSoftwareUpdateDeployment -Name $name -ErrorAction Stop)

                [pscustomobject]@{
                    success = $true
                    warnings = $cmWarnings
                    run_as = $runAs
                    deployment_name = $name
                    exists = ($found.Count -gt 0)
                    deployments = @(
                        $found | ForEach-Object {
                            [pscustomobject]@{
                                assignment_id = [string]$_.AssignmentID
                                name = [string]$_.AssignmentName
                                collection_id = [string]$_.TargetCollectionID
                                start_time = [string]$_.StartTime
                                deadline = [string]$_.EnforcementDeadline
                                enabled = [bool]$_.Enabled
                            }
                        }
                    )
                }
            }

            default {
                throw "Unsupported operation."
            }
        }
"""

# Runs inside the DSLAB jumphost session. Self-contained (nothing needs to be
# installed there). Servers are reached with the DSLAB account passed in
# explicitly, so no credential delegation (double hop) is needed. Read-only.
DSLAB_REMOTE_SCRIPT = r"""
        param($operation, $siteServer, $siteCode, $credential)

        $ErrorActionPreference = 'Stop'
        $ProgressPreference = 'SilentlyContinue'
        $runAs = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        trap { throw "[$env:COMPUTERNAME as $runAs] $($_.Exception.Message)" }
        Write-Host "Connected to $env:COMPUTERNAME ($env:USERDNSDOMAIN) as $runAs"

        if ($operation.Kind -eq 'DslabConnectionTest') {
            return [pscustomobject]@{
                success = $true
                host = $env:COMPUTERNAME
                domain = $env:USERDNSDOMAIN
                run_as = $runAs
                powershell = $PSVersionTable.PSVersion.ToString()
                active_directory_module = [bool](Get-Module -ListAvailable ActiveDirectory)
                sccm_console = [bool](Test-Path (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Configuration Manager\AdminConsole\bin'))
            }
        }

        if ($operation.Kind -ne 'DslabValidateServers') { throw 'Unsupported operation.' }

        $kbs = @($operation.Kb | Where-Object { $_ } | ForEach-Object { ($_ -replace '^KB', '') })

        # Collected on each server; dates as UTC text so they survive JSON.
        $collect = {
            param($kbs)
            $os = Get-CimInstance Win32_OperatingSystem
            $ubr = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue).UBR
            $hotfixes = @(Get-HotFix -ErrorAction SilentlyContinue | Sort-Object InstalledOn -Descending)
            $ccm = @()
            try { $ccm = @(Get-CimInstance -Namespace 'root\ccm\SoftwareUpdates\UpdatesStore' -ClassName CCM_UpdateStatus -ErrorAction Stop) } catch { }
            $rebootPending = $null
            try {
                $r = Invoke-CimMethod -Namespace 'root\ccm\ClientSDK' -ClassName CCM_ClientUtilities -MethodName DetermineIfRebootPending -ErrorAction Stop
                $rebootPending = [bool]($r.RebootPending -or $r.IsHardRebootPending)
            } catch {
                $rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
                    (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
            }
            $clientVersion = $null
            try { $clientVersion = (Get-CimInstance -Namespace 'root\ccm' -ClassName SMS_Client -ErrorAction Stop).ClientVersion } catch { }
            $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()

            [pscustomobject]@{
                logged_on_as = $identity.Name
                local_admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole('Administrators')
                last_boot_utc = $os.LastBootUpTime.ToUniversalTime().ToString('o')
                uptime_days = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalDays, 1)
                os = [string]$os.Caption
                build = "$($os.Version).$ubr"
                free_c_gb = [math]::Round($disk.FreeSpace / 1GB, 1)
                reboot_pending = $rebootPending
                sccm_client_version = $clientVersion
                sccm_client_service = [string](Get-Service CcmExec -ErrorAction SilentlyContinue).Status
                recent_hotfixes = @($hotfixes | Select-Object -First 10 | ForEach-Object {
                    [pscustomobject]@{ kb = [string]$_.HotFixID; installed_on = if ($_.InstalledOn) { $_.InstalledOn.ToString('yyyy-MM-dd') } else { $null } }
                })
                missing_updates = @($ccm | Where-Object { $_.Status -eq 'Missing' } | ForEach-Object { "KB$($_.Article)" } | Sort-Object -Unique)
                kbs = @(foreach ($kb in $kbs) {
                    $inHotfix = @($hotfixes | Where-Object { $_.HotFixID -eq "KB$kb" }).Count -gt 0
                    $client = @($ccm | Where-Object { $_.Article -eq $kb } | Select-Object -First 1)
                    $clientStatus = if ($client.Count) { [string]$client[0].Status } else { $null }
                    [pscustomobject]@{
                        kb = "KB$kb"
                        installed = ($inHotfix -or $clientStatus -eq 'Installed')
                        in_get_hotfix = $inHotfix
                        sccm_client_status = $clientStatus
                    }
                })
            }
        }

        $results = foreach ($server in @($operation.Servers)) {
            Write-Host ''
            Write-Host "== $server"
            $r = [ordered]@{
                server = $server; dns = $null; ip = @(); ping = $false; winrm = $false; remote_access = $null
                eligible = $false; details = $null
            }

            try {
                $r.ip = @([Net.Dns]::GetHostAddresses($server) |
                    Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork } |
                    ForEach-Object { $_.IPAddressToString })
                $r.dns = 'OK'
            } catch { $r.dns = "FAILED: $($_.Exception.Message)" }
            Write-Host "  DNS:    $($r.dns) $($r.ip -join ', ')"

            $r.ping = [bool](Test-Connection -ComputerName $server -Count 2 -Quiet -ErrorAction SilentlyContinue)
            Write-Host "  Ping:   $(if ($r.ping) { 'Succeeded' } else { 'Request Timeout' })"

            try { Test-WSMan -ComputerName $server -ErrorAction Stop | Out-Null; $r.winrm = $true } catch { }
            Write-Host "  WinRM:  $(if ($r.winrm) { 'listening' } else { 'not reachable' })"

            if ($r.winrm) {
                try {
                    $d = Invoke-Command -ComputerName $server -Credential $credential -ErrorAction Stop -ArgumentList (, $kbs) -ScriptBlock $collect
                    $r.details = $d | Select-Object -Property * -ExcludeProperty PSComputerName, RunspaceId, PSShowComputerName
                    $r.remote_access = 'OK'
                    Write-Host "  Logon:  OK as $($d.logged_on_as) (local admin: $($d.local_admin))"
                    Write-Host "  OS:     $($d.os) build $($d.build); last boot $($d.last_boot_utc) ($($d.uptime_days) days)"
                    Write-Host "  Disk:   C: $($d.free_c_gb) GB free; reboot pending: $($d.reboot_pending)"
                    Write-Host "  SCCM:   client $($d.sccm_client_version) ($($d.sccm_client_service)); missing updates: $(if (@($d.missing_updates).Count) { @($d.missing_updates) -join ', ' } else { 'none' })"
                    Write-Host "  Latest: $((@($d.recent_hotfixes) | Select-Object -First 3 | ForEach-Object { "$($_.kb) ($($_.installed_on))" }) -join ', ')"
                    foreach ($k in @($d.kbs)) { Write-Host "  $($k.kb): $(if ($k.installed) { 'INSTALLED' } else { 'NOT INSTALLED' }) (Get-HotFix: $($k.in_get_hotfix); SCCM client: $($k.sccm_client_status))" }
                } catch {
                    $r.remote_access = "FAILED: $($_.Exception.Message)"
                    Write-Host "  Logon:  $($r.remote_access)"
                }
            } else {
                $r.remote_access = 'FAILED: WinRM not reachable'
            }

            # SOP step 6: patch candidate if ping succeeded, or ping failed but the server answered remotely.
            $r.eligible = $r.ping -or $r.remote_access -eq 'OK'
            Write-Host "  Result: $(if ($r.eligible) { 'ELIGIBLE' } else { 'NOT ELIGIBLE - check in vCenter (powered on / off / missing)' })"
            [pscustomobject]$r
        }

        $results = @($results)
        [pscustomobject]@{
            success = $true
            host = $env:COMPUTERNAME
            run_as = $runAs
            servers = $results
            summary = [pscustomobject]@{
                total = $results.Count
                eligible = @($results | Where-Object { $_.eligible }).Count
                remote_access_ok = @($results | Where-Object { $_.remote_access -eq 'OK' }).Count
                reboot_pending = @($results | Where-Object { $_.details -and $_.details.reboot_pending }).Count
            }
        }
"""

# The wrapper is too long for the 32,767-character Windows command line once
# encoded, so it travels in an environment variable and the command line only
# carries this short loader. Script blocks are not subject to execution policy.
ENCODED_LOADER = base64.b64encode(
    "& ([scriptblock]::Create($env:SCCM_WRAPPER))".encode("utf-16le")
).decode("ascii")


def server_account() -> tuple:
    """Account the jumphost scripts use for the target servers: the one entered
    as target account, else the DSLAB account, else none."""
    if TARGET_USERNAME:
        return TARGET_USERNAME, TARGET_PASSWORD
    if DSLAB_PASSWORD:
        return DSLAB_USERNAME, DSLAB_PASSWORD
    return "", ""


CLIXML_MESSAGE = re.compile(r'<S S="(Error|warning)">(.*?)</S>', re.DOTALL)


def clixml_messages(text: str) -> list:
    """Warning and error lines from PowerShell's CLIXML stderr output."""
    messages = []
    for kind, body in CLIXML_MESSAGE.findall(text or ""):
        body = html.unescape(body).replace("_x000D_", "").replace("_x000A_", "\n").strip()
        for line in body.splitlines():
            if line.strip():
                messages.append(f"{'ERROR' if kind == 'Error' else 'WARNING'}: {line.strip()}")
    return messages


def run_powershell(operation: dict, timeout: int, on_line=None, target: str = "sccm") -> dict:
    """
    Run one fixed operation on a jumphost through a local PowerShell process
    that opens a remoting session: target "sccm" (SCCM jumphost, RunAs
    endpoint, Kerberos) or "dslab" (DSLAB jumphost, DSLAB account).

    The operation travels as JSON in an environment variable, so request
    data is never spliced into script text. Every output line is passed to
    on_line as it arrives; the result is the JSON line after RESULT_MARKER.
    Raises subprocess.TimeoutExpired on timeout.
    """

    env = os.environ.copy()
    env["SCCM_SITE_SERVER"] = SITE_SERVER
    env["SCCM_SITE_CODE"] = SITE_CODE
    if target == "dslab":
        env["SCCM_JUMPHOST"] = DSLAB_JUMPHOST
        env["SCCM_SESSION_CONFIG"] = DSLAB_SESSION_CONFIG
        env["SCCM_SESSION_AUTH"] = DSLAB_AUTH
        env["SCCM_USERNAME"] = DSLAB_USERNAME
        env["SCCM_PASSWORD"] = DSLAB_PASSWORD
        # The same DSLAB account connects from the jumphost to the servers.
        env["SCCM_TARGET_USERNAME"] = DSLAB_USERNAME
        env["SCCM_TARGET_PASSWORD"] = DSLAB_PASSWORD
        env["SCCM_REMOTE_SCRIPT"] = DSLAB_REMOTE_SCRIPT
    else:
        env["SCCM_JUMPHOST"] = JUMPHOST
        env["SCCM_SESSION_CONFIG"] = SESSION_CONFIG
        env["SCCM_SESSION_AUTH"] = "Kerberos"
        env["SCCM_USERNAME"] = USERNAME
        env["SCCM_PASSWORD"] = PASSWORD
        env["SCCM_TARGET_USERNAME"], env["SCCM_TARGET_PASSWORD"] = server_account()
        env["SCCM_REMOTE_SCRIPT"] = REMOTE_SCRIPT
    env["SCCM_OPERATION"] = json.dumps(operation, separators=(",", ":"))
    env["SCCM_WRAPPER"] = POWERSHELL_WRAPPER

    process = subprocess.Popen(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            ENCODED_LOADER,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        bufsize=1,
    )

    timed_out = threading.Event()

    def stop():
        timed_out.set()
        process.kill()

    timer = threading.Timer(timeout, stop)
    timer.daemon = True
    timer.start()

    # stderr carries PowerShell's serialized (CLIXML) streams; read it on the
    # side so the pipe never fills, and keep only warnings and errors.
    stderr_chunks = []
    stderr_reader = threading.Thread(target=lambda: stderr_chunks.append(process.stderr.read()), daemon=True)
    stderr_reader.start()

    result_text = None
    tail = deque(maxlen=50)
    try:
        for raw in process.stdout:
            line = raw.rstrip("\r\n")
            if line.startswith(RESULT_MARKER):
                result_text = line[len(RESULT_MARKER):]
                continue
            tail.append(line)
            if on_line:
                on_line(line)
        process.wait()
        stderr_reader.join(timeout=10)
    finally:
        timer.cancel()

    for message in clixml_messages("".join(stderr_chunks)):
        tail.append(message)
        if on_line:
            on_line(message)

    if timed_out.is_set():
        raise subprocess.TimeoutExpired(process.args, timeout)

    if result_text is None:
        last_lines = [line for line in tail if line.strip()][-10:]
        return {
            "success": False,
            "errors": [
                "\n".join(last_lines)
                or f"PowerShell exited with code {process.returncode} without a result."
            ],
        }

    try:
        result = json.loads(result_text)
    except json.JSONDecodeError:
        return {"success": False, "errors": ["PowerShell did not return valid JSON."]}

    if isinstance(result, list):
        result = next((item for item in reversed(result) if isinstance(item, dict)), None)
    if not isinstance(result, dict):
        return {"success": False, "errors": ["PowerShell returned no result object."]}

    result["powershell_exit_code"] = process.returncode
    return result


# ============================================================
# JOB STORE (SQLite), LOGS AND RUNNER
# ============================================================

# QUEUED -> RUNNING -> SUCCEEDED | COMPLETED_WITH_ISSUES | FAILED | OUTCOME_UNKNOWN
#   COMPLETED_WITH_ISSUES  deployment ran; not every server is PATCHED
#   OUTCOME_UNKNOWN        deployment jobs only: the run was cut off after the
#                          deployment may have been created; resume or check SCCM.
ACTIVE_STATUSES = ("QUEUED", "RUNNING")

DB_LOCK = Lock()
LOG_LOCK = Lock()
LOG_SEQ = {}

# SCCM reads run one at a time; deployments (hours) run on their own worker
# so checks and inventory keep working meanwhile.
READ_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sccm-read")
DEPLOY_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sccm-deploy")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with DB_LOCK, closing(db()) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                request_json TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                idempotency_key TEXT UNIQUE,
                result_json TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS job_logs (
                job_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                ts TEXT NOT NULL,
                line TEXT NOT NULL,
                PRIMARY KEY (job_id, seq)
            )
            """
        )
        # Who did what: deployments started, blocked attempts, lock releases.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                action TEXT NOT NULL,
                user TEXT,
                job_id TEXT,
                detail TEXT
            )
            """
        )
        # Columns added in v4 (databases created by earlier versions get them here).
        existing = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
        for column, declaration in (
            ("requested_by", "TEXT"),
            ("deployment_name", "TEXT"),
            ("timeout_seconds", "INTEGER"),
            ("lock_released_at", "TEXT"),
            ("lock_released_by", "TEXT"),
            ("lock_release_reason", "TEXT"),
        ):
            if column not in existing:
                conn.execute(f"ALTER TABLE jobs ADD COLUMN {column} {declaration}")

        # Jobs cut off by an API restart cannot be continued in place. A
        # deployment run may already have created the deployment: resume it.
        now = iso(utc_now())
        interrupted = json.dumps({
            "success": False,
            "errors": ["The API stopped before this job finished."],
            "next_step": "Deployment runs: POST /api/sccm/deployments/resume, or check SCCM first.",
        })
        conn.execute(
            "UPDATE jobs SET status = 'OUTCOME_UNKNOWN', finished_at = ?, result_json = ? "
            "WHERE status = 'RUNNING' AND kind IN ('deployment', 'deployment_resume')",
            (now, interrupted),
        )
        conn.execute(
            "UPDATE jobs SET status = 'FAILED', finished_at = ?, result_json = ? "
            "WHERE status IN ('QUEUED', 'RUNNING')",
            (now, interrupted),
        )
        conn.commit()


def get_job(job_id: str) -> Optional[sqlite3.Row]:
    with closing(db()) as conn:
        return conn.execute(
            "SELECT * FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()


def append_log(job_id: str, line: str):
    with LOG_LOCK:
        if job_id not in LOG_SEQ:
            # e.g. a note added to a finished job: continue after its last line.
            LOG_SEQ[job_id] = last_log_seq(job_id)
        seq = LOG_SEQ[job_id] + 1
        LOG_SEQ[job_id] = seq
    with DB_LOCK, closing(db()) as conn:
        conn.execute(
            "INSERT INTO job_logs (job_id, seq, ts, line) VALUES (?, ?, ?, ?)",
            (job_id, seq, iso(utc_now()), line),
        )
        conn.commit()


def last_log_seq(job_id: str) -> int:
    with closing(db()) as conn:
        row = conn.execute(
            "SELECT MAX(seq) AS seq FROM job_logs WHERE job_id = ?", (job_id,)
        ).fetchone()
    return -1 if row["seq"] is None else int(row["seq"])


def get_logs(job_id: str, after: int, limit: int = MAX_LOG_LINES_PER_RESPONSE) -> list:
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT seq, ts, line FROM job_logs WHERE job_id = ? AND seq > ? "
            "ORDER BY seq LIMIT ?",
            (job_id, after, limit),
        ).fetchall()
    return [{"seq": row["seq"], "time": row["ts"], "line": row["line"]} for row in rows]


def job_view(row: sqlite3.Row) -> dict:
    view = {
        "job_id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "requested_by": row["requested_by"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "request": json.loads(row["request_json"]),
        "poll_url": f"/api/jobs/{row['id']}",
        "log_lines": last_log_seq(row["id"]) + 1,
    }
    if row["deployment_name"]:
        view["deployment_name"] = row["deployment_name"]
    if row["kind"] in REPORT_KINDS:
        view["report_url"] = f"/api/reports/{row['id']}"
        view["report_html_url"] = f"/api/reports/{row['id']}/html"
    if row["lock_released_at"]:
        view["lock_released"] = {
            "at": row["lock_released_at"],
            "by": row["lock_released_by"],
            "reason": row["lock_release_reason"],
        }
    if row["result_json"]:
        view["result"] = json.loads(row["result_json"])
    return view


def latest_log_line(job_id: str) -> Optional[dict]:
    with closing(db()) as conn:
        row = conn.execute(
            "SELECT seq, ts, line FROM job_logs WHERE job_id = ? AND TRIM(line) != '' "
            "ORDER BY seq DESC LIMIT 1",
            (job_id,),
        ).fetchone()
    return {"seq": row["seq"], "time": row["ts"], "line": row["line"]} if row else None


def audit(action: str, user: Optional[str], job_id: Optional[str], detail: str = ""):
    with DB_LOCK, closing(db()) as conn:
        conn.execute(
            "INSERT INTO audit_log (ts, action, user, job_id, detail) VALUES (?, ?, ?, ?, ?)",
            (iso(utc_now()), action, user, job_id, detail),
        )
        conn.commit()
    print(f"AUDIT {action} user={user or '-'} job={job_id or '-'} {detail}", flush=True)


def update_job(job_id: str, **fields):
    columns = ", ".join(f"{name} = ?" for name in fields)
    with DB_LOCK, closing(db()) as conn:
        conn.execute(
            f"UPDATE jobs SET {columns} WHERE id = ?",
            (*fields.values(), job_id),
        )
        conn.commit()


def submit_job(kind: str, operation: dict, idempotency_key: str = "",
               requested_by: Optional[str] = None, deployment_name: Optional[str] = None,
               guard=None, timeout: Optional[int] = None) -> dict:
    """
    Store a job and queue it. Reusing an idempotency key with the same
    request returns the existing job; with a different request it is a 409.

    guard(conn) runs in the same write transaction as the insert and may
    raise (e.g. the deployment lock), so check and creation are one step:
    two simultaneous requests cannot both pass.
    """

    request_json = json.dumps(operation, sort_keys=True, separators=(",", ":"))
    request_hash = hashlib.sha256(
        f"{kind}|{request_json}".encode("utf-8")
    ).hexdigest()
    key = idempotency_key.strip() or None

    with DB_LOCK, closing(db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            if key:
                existing = conn.execute(
                    "SELECT * FROM jobs WHERE idempotency_key = ?", (key,)
                ).fetchone()
                if existing:
                    if existing["request_hash"] != request_hash:
                        raise HTTPException(
                            status_code=409,
                            detail="Idempotency-Key was already used for a different request.",
                        )
                    conn.rollback()
                    return job_view(existing)

            if guard:
                guard(conn)

            job_id = secrets.token_urlsafe(12)
            conn.execute(
                "INSERT INTO jobs (id, kind, status, request_json, request_hash, idempotency_key, "
                "created_at, requested_by, deployment_name, timeout_seconds) "
                "VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?)",
                (job_id, kind, request_json, request_hash, key, iso(utc_now()),
                 requested_by, deployment_name, timeout),
            )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise

    executor = DEPLOY_EXECUTOR if kind in DEPLOY_KINDS else READ_EXECUTOR
    executor.submit(run_job, job_id, kind, operation, timeout or JOB_TIMEOUTS[kind])
    return job_view(get_job(job_id))


NEXT_STEPS = {
    "inventory": (
        "Testing: pick one entry from 'sugs' and one from 'collections', then "
        "POST /api/sccm/dry-run/continue with run_id '{job_id}'."
    ),
    "dry_run": (
        "Review targets and updates. When approved, POST /api/sccm/deployments "
        "with the SUG ID, the collection and precheck_job_id."
    ),
    "prerequisites": (
        "Select servers from 'servers' (Overall READY; 'selectable_servers' lists them) "
        "and POST /api/sccm/deployments with precheck_job_id '{job_id}'. "
        "HTML report: GET /api/reports/{job_id}/html."
    ),
    "sugs": "Pick one SUG ('id') and pass it as sug_id to POST /api/sccm/deployments.",
    "ad_servers": (
        "Pick servers from 'selectable_servers' (Windows Server 2016+ with a DNS name) and "
        "POST /api/sccm/prerequisites with ad_job_id '{job_id}' and servers."
    ),
    "collections": (
        "Pick a collection whose members are exactly the selected servers (collection_id), "
        "or give new_collection_name to create one."
    ),
}


def add_report_details(kind: str, result: dict):
    """Computed fields that make the UI simpler (counts, selectable servers)."""
    if kind == "prerequisites":
        servers = [s for s in as_list(result.get("servers")) if isinstance(s, dict)]
        ready = [s for s in servers if str(s.get("Overall")).upper() == "READY"]
        result["server_summary"] = {
            "total": len(servers),
            "ready": len(ready),
            "not_ready": len(servers) - len(ready),
            "eligible": sum(1 for s in servers if str(s.get("Eligibility")).upper() == "ELIGIBLE"),
        }
        result["selectable_servers"] = [s.get("Server") for s in ready]
    if kind == "ad_servers":
        servers = [s for s in as_list(result.get("servers")) if isinstance(s, dict)]
        result["servers"] = servers
        result["selectable_servers"] = [s["Fqdn"] for s in servers if s.get("Supported") and s.get("Fqdn")]
        result["server_summary"] = {
            "total": len(servers),
            "selectable": len(result["selectable_servers"]),
            "unsupported_os": sum(1 for s in servers if not s.get("Supported")),
            "no_dns_name": sum(1 for s in servers if not s.get("Fqdn")),
            "stale": sum(1 for s in servers if s.get("Stale")),
        }
    if kind in REPORT_KINDS:
        result["report_headline"] = reports.report_headline(kind, result)


def deployment_status(result: dict) -> str:
    """Final status of a deployment job from the script's result."""
    if result.get("success"):
        return "SUCCEEDED"
    if result.get("exit_code") == 1:
        return "COMPLETED_WITH_ISSUES"
    errors = " ".join(str(error) for error in result.get("errors", []))
    if "No deployment created." in errors or (
        "exit_code" in result and not result.get("deployment_created")
    ):
        return "FAILED"
    return "OUTCOME_UNKNOWN"


def run_job(job_id: str, kind: str, operation: dict, timeout: int):
    update_job(job_id, status="RUNNING", started_at=iso(utc_now()))
    started = utc_now()
    row = get_job(job_id)
    who = row["requested_by"] if row and row["requested_by"] else "unknown user"
    append_log(job_id, f"Job {job_id} ({kind}) started on the API at {iso(started)} for {who}.")

    def on_line(line: str):
        try:
            append_log(job_id, line)
        except Exception:
            pass  # a log write must never stop the job

    try:
        result = run_powershell(
            operation, timeout=timeout, on_line=on_line,
            target="dslab" if kind.startswith("dslab_") else "sccm",
        )
    except subprocess.TimeoutExpired:
        result = {
            "success": False,
            "errors": [f"Timed out after {timeout} seconds."],
        }
    except Exception as exc:  # keep the worker alive for the next job
        result = {"success": False, "errors": [f"{type(exc).__name__}: {exc}"]}

    if kind in DEPLOY_KINDS:
        status = deployment_status(result)
        if status == "OUTCOME_UNKNOWN":
            result["next_step"] = (
                "The run was cut off after the deployment may have been created. "
                "POST /api/sccm/deployments/resume to continue it, or check SCCM "
                "with POST /api/sccm/deployments/lookup."
            )
        elif status == "COMPLETED_WITH_ISSUES":
            result["next_step"] = (
                "Check 'servers' and 'validation' for servers not PATCHED; "
                "fix and POST /api/sccm/deployments/resume, or validate later."
            )
    elif result.get("success"):
        status = "SUCCEEDED"
        if kind in NEXT_STEPS:
            result["next_step"] = NEXT_STEPS[kind].format(job_id=job_id)
    else:
        status = "FAILED"

    result["duration_seconds"] = round((utc_now() - started).total_seconds(), 2)
    try:
        add_report_details(kind, result)
    except Exception as exc:  # a report detail must never lose the result
        result.setdefault("warnings", [])
        result["warnings"] = as_list(result["warnings"]) + [f"Report details not added: {exc}"]
    if kind in REPORT_KINDS:
        result["report_html_url"] = f"/api/reports/{job_id}/html"
    append_log(job_id, f"Job finished with status {status} after {result['duration_seconds']} s.")
    fields = {"status": status, "finished_at": iso(utc_now()), "result_json": json.dumps(result)}
    if kind in DEPLOY_KINDS and result.get("deployment_name") and not (row and row["deployment_name"]):
        fields["deployment_name"] = str(result["deployment_name"])
    update_job(job_id, **fields)
    if kind in DEPLOY_KINDS:
        audit("deployment_finished", row["requested_by"] if row else None, job_id, f"status={status}")
    with LOG_LOCK:
        LOG_SEQ.pop(job_id, None)


def require_succeeded_job(job_id: str, kind: str, label: str) -> dict:
    """Return a finished, recent job's view, or raise a 4xx explaining why not."""

    row = get_job(job_id)
    if not row or row["kind"] != kind:
        raise HTTPException(status_code=404, detail=f"{label} job not found.")
    if row["status"] != "SUCCEEDED":
        raise HTTPException(
            status_code=409,
            detail=f"{label} job is {row['status']}; it must be SUCCEEDED.",
        )
    finished = datetime.fromisoformat(row["finished_at"])
    if utc_now() - finished > RESULT_MAX_AGE:
        raise HTTPException(
            status_code=409,
            detail=f"{label} job is older than {RESULT_MAX_AGE}; run it again.",
        )
    return job_view(row)


# ------------------------------------------------------------
# Deployment lock: one deployment at a time, across all users.
# Held while a deployment job is QUEUED or RUNNING, and while the latest
# deployment job is OUTCOME_UNKNOWN (the deployment may still exist and be
# installing) until it is resumed or an admin releases the lock.
# Released when the latest deployment ends SUCCEEDED, COMPLETED_WITH_ISSUES
# or FAILED.
# ------------------------------------------------------------

def deployment_blocker(conn) -> Optional[sqlite3.Row]:
    kinds = tuple(DEPLOY_KINDS)
    marks = ",".join("?" * len(kinds))
    row = conn.execute(
        f"SELECT * FROM jobs WHERE kind IN ({marks}) AND status IN ('QUEUED', 'RUNNING') "
        "ORDER BY created_at, rowid LIMIT 1",
        kinds,
    ).fetchone()
    if row:
        return row
    row = conn.execute(
        f"SELECT * FROM jobs WHERE kind IN ({marks}) ORDER BY created_at DESC, rowid DESC LIMIT 1",
        kinds,
    ).fetchone()
    if row and row["status"] == "OUTCOME_UNKNOWN" and not row["lock_released_at"]:
        return row
    return None


def current_blocker() -> Optional[sqlite3.Row]:
    with closing(db()) as conn:
        return deployment_blocker(conn)


def running_deployment() -> Optional[str]:
    row = current_blocker()
    return row["id"] if row and row["status"] in ACTIVE_STATUSES else None


def lock_info(row: sqlite3.Row) -> dict:
    last = latest_log_line(row["id"])
    request = json.loads(row["request_json"])
    return {
        "job_id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "deployment_name": row["deployment_name"] or request.get("DeploymentName"),
        "requested_by": row["requested_by"] or "unknown",
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "servers": request.get("Servers"),
        "latest_log_line": last["line"] if last else None,
        "latest_log_time": last["time"] if last else None,
        "poll_url": f"/api/jobs/{row['id']}",
    }


def lock_message(info: dict) -> str:
    name = info["deployment_name"] or "(resume)"
    if info["status"] in ACTIVE_STATUSES:
        since = info["started_at"] or info["created_at"]
        return (f"Deployment '{name}' is in progress, started by {info['requested_by']} at {since}. "
                "A new deployment can start when it has finished.")
    return (f"The last deployment '{name}' (started by {info['requested_by']}) ended with OUTCOME_UNKNOWN: "
            "it may still exist in SCCM and be installing. Resume it (POST /api/sccm/deployments/resume) "
            "or have an admin release the lock (POST /api/sccm/deployments/release-lock).")


def lock_conflict(row: sqlite3.Row) -> HTTPException:
    info = lock_info(row)
    running = info["status"] in ACTIVE_STATUSES
    return HTTPException(status_code=409, detail={
        "error": "DEPLOYMENT_IN_PROGRESS" if running else "DEPLOYMENT_OUTCOME_UNKNOWN",
        "message": lock_message(info),
        "active_deployment": info,
        "next_step": (
            f"Poll GET /api/jobs/{info['job_id']}?log_after=-1 to follow it."
            if running else
            "POST /api/sccm/deployments/resume, or POST /api/sccm/deployments/release-lock "
            f"with job_id '{info['job_id']}' and a reason."
        ),
    })


def deployment_guard(allow_outcome_unknown: bool):
    """Guard for submit_job: refuses while another deployment holds the lock.
    A resume may run after OUTCOME_UNKNOWN (that is how the lock is cleared)."""
    def guard(conn):
        blocker = deployment_blocker(conn)
        if blocker and (blocker["status"] in ACTIVE_STATUSES or not allow_outcome_unknown):
            raise lock_conflict(blocker)
    return guard


def submit_deployment(kind: str, operation: dict, idempotency_key: str, user: Optional[str],
                      deployment_name: Optional[str], allow_outcome_unknown: bool,
                      timeout: Optional[int] = None) -> dict:
    try:
        job = submit_job(kind, operation, idempotency_key, requested_by=user,
                         deployment_name=deployment_name,
                         guard=deployment_guard(allow_outcome_unknown), timeout=timeout)
    except HTTPException as exc:
        if exc.status_code == 409 and isinstance(exc.detail, dict):
            blocker = exc.detail.get("active_deployment", {})
            audit("deployment_blocked", user, blocker.get("job_id"),
                  f"requested '{deployment_name or 'resume'}'; {exc.detail.get('error')}")
        raise
    audit("deployment_started" if kind == "deployment" else "deployment_resume_started",
          user, job["job_id"], deployment_name or "")
    return job


init_db()


# ============================================================
# AUTHENTICATION / REQUEST MODELS
# ============================================================

def authorize(x_api_key: str):
    if not hmac.compare_digest(x_api_key or "", API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")


def authorize_admin(x_admin_key: str):
    """Admin actions need X-Admin-Key when SCCM_ADMIN_API_KEY is set."""
    if ADMIN_API_KEY and not hmac.compare_digest(x_admin_key or "", ADMIN_API_KEY):
        raise HTTPException(status_code=403, detail="Admin key (X-Admin-Key) required.")


USER_UNSAFE = re.compile(r"[^\w .@\\\-]")


def requester(x_user: str) -> Optional[str]:
    """Display name of the UI user (X-User header), stored as requested_by."""
    value = USER_UNSAFE.sub("", (x_user or "").strip())[:100].strip()
    return value or None


class DryRunContinueRequest(BaseModel):
    """Select by ID or by exact name from the dry-run/start result."""
    run_id: str = Field(min_length=1, max_length=64)
    sug_id: Optional[str] = Field(default=None, max_length=30)
    sug_name: Optional[str] = Field(default=None, max_length=300)
    collection_id: Optional[str] = Field(default=None, max_length=30)
    collection_name: Optional[str] = Field(default=None, max_length=300)


def as_list(value) -> list:
    """PowerShell JSON can hold a one-item list as a bare object."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def pick_from_inventory(items, item_id: Optional[str],
                        item_name: Optional[str], label: str) -> dict:
    """Resolve one inventory entry by ID, or by case-insensitive exact name."""

    items = as_list(items)
    item_id = (item_id or "").strip()
    item_name = (item_name or "").strip()
    if bool(item_id) == bool(item_name):
        raise HTTPException(
            status_code=400,
            detail=f"Give exactly one of {label}_id or {label}_name.",
        )

    if item_id:
        matches = [item for item in items if str(item["id"]) == item_id]
    else:
        matches = [
            item for item in items
            if str(item["name"]).casefold() == item_name.casefold()
        ]

    if not matches:
        raise HTTPException(
            status_code=400,
            detail=f"{label} '{item_id or item_name}' is not in the dry-run/start result.",
        )
    if len(matches) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"More than one {label} is named '{item_name}'; use {label}_id.",
        )
    return matches[0]


class DeploymentRequest(BaseModel):
    """
    Required deployment run end to end by 04-DeployAndValidatePatches.ps1.

    servers: chosen from the prerequisites result (precheck_job_id).
    sug_id: from POST /api/sccm/sugs.
    collection: an existing collection_id whose members are exactly the
    selected servers, or new_collection_name to create one with them.
    """
    precheck_job_id: str = Field(min_length=1, max_length=64)
    servers: List[str] = Field(min_length=1, max_length=50)
    include_not_ready_servers: bool = False
    sug_id: str = Field(min_length=1, max_length=30)
    sug_name: Optional[str] = Field(default=None, max_length=300)
    collection_id: Optional[str] = Field(default=None, max_length=30)
    new_collection_name: Optional[str] = Field(default=None, min_length=3, max_length=100)
    limiting_collection_name: Optional[str] = Field(default=None, max_length=300)
    deployment_name: str = Field(min_length=3, max_length=100)
    maintenance_window_start_utc: datetime
    maintenance_window_hours: int = Field(default=4, ge=1, le=24)
    # Optional: installation starts at the deadline (inside the window).
    # Empty = as soon as possible, i.e. when the window opens.
    deadline_utc: Optional[datetime] = None
    restart_mode: str = Field(default="Script")
    kb: Optional[List[str]] = None
    change_ticket: str = Field(min_length=3, max_length=100)
    approver: str = Field(min_length=2, max_length=100)
    approval_reference: str = Field(min_length=2, max_length=200)
    readiness_confirmed: bool
    final_confirmation: str = Field(min_length=1, max_length=100)


class DeploymentResumeRequest(BaseModel):
    """Continue a deployment run that was cut off (window closed, API restarted)."""
    report_folder: Optional[str] = Field(default=None, max_length=40)
    restart_mode: Optional[str] = None


class DeploymentLookupRequest(BaseModel):
    deployment_name: str = Field(min_length=1, max_length=200)


class ReleaseLockRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=10, max_length=500)


class ListRequest(BaseModel):
    name_filter: Optional[str] = Field(default=None, max_length=100)


class SugListRequest(ListRequest):
    include_kbs: bool = True


class CollectionListRequest(ListRequest):
    include_members: bool = False


class AdServerListRequest(BaseModel):
    domain: Optional[str] = Field(default=None, max_length=253)
    name_filter: Optional[str] = Field(default=None, max_length=64)
    search_base: Optional[str] = Field(default=None, max_length=400)
    max_results: int = Field(default=2000, ge=1, le=10000)


class PrerequisitesRequest(BaseModel):
    # Servers chosen from a successful POST /api/sccm/ad-servers job. Without
    # them the allowlist in Config\TestServers.json on the jumphost is checked.
    ad_job_id: Optional[str] = Field(default=None, max_length=64)
    servers: Optional[List[str]] = Field(default=None, max_length=1000)


class JumphostReportListRequest(BaseModel):
    limit: int = Field(default=50, ge=1, le=500)


class JumphostReportImportRequest(BaseModel):
    report_folder: str = Field(min_length=1, max_length=40)


class DslabValidateRequest(BaseModel):
    """Servers to check from the DSLAB jumphost (short names get the DSLAB domain)."""
    servers: Optional[List[str]] = None
    kb: Optional[List[str]] = None


SERVER_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,62}(\.[A-Za-z0-9][A-Za-z0-9-]{0,62})*$")
MAX_DSLAB_SERVERS = 50


def require_dslab():
    if not DSLAB_PASSWORD:
        raise HTTPException(
            status_code=503,
            detail="DSLAB jumphost account not configured. Restart the API and enter the password "
                   f"for {DSLAB_USERNAME} (or set SCCM_DSLAB_PASSWORD).",
        )


RESTART_MODES = {"script": "Script", "sccm": "Sccm", "none": "None"}
KB_PATTERN = re.compile(r"^(KB)?\d{6,8}$", re.IGNORECASE)
REPORT_FOLDER_PATTERN = re.compile(r"^\d{8}_\d{6}Z$")
SAFE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9 _.\-()]+$")


def restart_mode_value(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    mode = RESTART_MODES.get(value.strip().lower())
    if not mode:
        raise HTTPException(status_code=400, detail="restart_mode must be Script, Sccm or None.")
    return mode


# ============================================================
# API ENDPOINTS
# ============================================================

@app.get("/health")
def health():
    blocker = current_blocker()
    lock = None
    if blocker:
        info = lock_info(blocker)
        lock = {key: info[key] for key in ("job_id", "status", "deployment_name", "requested_by", "created_at", "started_at")}
    return {
        "status": "ok",
        "version": app.version,
        "sccm_site_code": SITE_CODE,
        "sccm_site_server": SITE_SERVER,
        "jumphost": JUMPHOST,
        "ad_domains": AD_DOMAINS,
        "max_servers_per_run": MAX_SERVERS_PER_RUN,
        "deployment_enabled": ALLOW_DEPLOYMENT,
        "target_server_account": server_account()[0] or None,
        "running_deployment_job": running_deployment(),
        "deployment_lock": lock,
        "dslab_jumphost": DSLAB_JUMPHOST if DSLAB_PASSWORD else None,
    }


@app.get("/api/jobs/{job_id}")
def get_job_status(
    job_id: str,
    wait: int = 0,
    log_after: Optional[int] = None,
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    """
    Job status and, once finished, its result.

    ?wait=N (max 120): hold the request until the job finishes, or - when
    log_after is given - until new log lines arrive, for up to N seconds.
    ?log_after=M: include log lines with seq > M (use -1 for the first call,
    then the returned log_next).
    """
    authorize(x_api_key)
    row = get_job(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")

    stop_at = time.monotonic() + max(0, min(wait, MAX_POLL_WAIT_SECONDS))
    while row["status"] in ACTIVE_STATUSES and time.monotonic() < stop_at:
        if log_after is not None and last_log_seq(job_id) > log_after:
            break
        time.sleep(1)
        row = get_job(job_id)

    view = job_view(row)
    if log_after is not None:
        lines = get_logs(job_id, log_after)
        view["log"] = lines
        view["log_next"] = lines[-1]["seq"] if lines else log_after
        view["log_more"] = view["log_next"] < view["log_lines"] - 1
    return view


@app.get("/api/jobs/{job_id}/log")
def get_job_log(
    job_id: str,
    after: int = -1,
    limit: int = MAX_LOG_LINES_PER_RESPONSE,
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    """Log lines of a job (seq > after), e.g. to load or download the full log."""
    authorize(x_api_key)
    if not get_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found.")
    lines = get_logs(job_id, after, max(1, min(limit, 5000)))
    return {
        "job_id": job_id,
        "log": lines,
        "log_next": lines[-1]["seq"] if lines else after,
        "log_lines": last_log_seq(job_id) + 1,
    }


@app.get("/api/jobs")
def list_jobs(
    limit: int = 20,
    kind: Optional[str] = None,
    requested_by: Optional[str] = None,
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    authorize(x_api_key)
    limit = max(1, min(limit, 200))
    where, args = [], []
    if kind:
        where.append("kind = ?")
        args.append(kind)
    if requested_by:
        where.append("requested_by = ?")
        args.append(requested_by)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with closing(db()) as conn:
        rows = conn.execute(
            f"SELECT * FROM jobs {clause} ORDER BY created_at DESC, rowid DESC LIMIT ?", (*args, limit)
        ).fetchall()
    jobs = []
    for row in rows:
        view = job_view(row)
        view.pop("result", None)
        jobs.append(view)
    return {"jobs": jobs}


@app.post("/api/sccm/connection-test", status_code=202)
def connection_test(
    x_api_key: str = Header(default="", alias="X-API-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """Which account the jumphost session runs as, and what it can reach."""
    authorize(x_api_key)
    return submit_job("connection_test", {
        "Kind": "ConnectionTest",
        "ProjectRoot": PROJECT_ROOT,
        "RequestedAt": iso(utc_now()),
    }, requested_by=requester(x_user))


@app.post("/api/sccm/environment-check", status_code=202)
def environment_check(
    x_api_key: str = Header(default="", alias="X-API-Key"),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """Jumphost readiness. result.checks holds the checks; HTML: GET /api/reports/{job_id}/html."""
    authorize(x_api_key)
    return submit_job("environment", {
        "Kind": "RunFixedScript",
        "Path": os.path.join(PROJECT_ROOT, "Scripts", SCRIPTS["environment"]),
        "Collect": "environment",
    }, idempotency_key, requested_by=requester(x_user))


@app.post("/api/sccm/prerequisites", status_code=202)
def prerequisites(
    request: Optional[PrerequisitesRequest] = None,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    SOP prerequisite checks for the servers chosen from AD (ad_job_id from
    POST /api/sccm/ad-servers plus servers), or, without a body, for the
    allowlist in Config\\TestServers.json. result.servers is the per-server
    summary (Overall READY / NOT READY) to select servers from, result.checks
    every check; HTML: GET /api/reports/{job_id}/html.
    """
    authorize(x_api_key)
    request = request or PrerequisitesRequest()
    operation = {
        "Kind": "RunFixedScript",
        "Path": os.path.join(PROJECT_ROOT, "Scripts", SCRIPTS["prerequisites"]),
        "PassTargetCredential": True,
        "Collect": "prerequisites",
    }
    timeout = None
    if request.servers:
        operation["Servers"] = ad_selected_servers(request.ad_job_id, request.servers)
        operation["AdJobId"] = request.ad_job_id
        # About two minutes per server when it does not answer (ping, WinRM and DCOM timeouts).
        timeout = max(JOB_TIMEOUTS["prerequisites"], 120 * len(operation["Servers"]) + 600)
    elif request.ad_job_id:
        raise HTTPException(status_code=400, detail="servers is required with ad_job_id.")
    return submit_job("prerequisites", operation, idempotency_key,
                      requested_by=requester(x_user), timeout=timeout)


def ad_selected_servers(ad_job_id: Optional[str], names: List[str]) -> List[str]:
    """FQDNs of the requested servers, each of which must be listed (Windows
    Server 2016+, with a DNS name) by a recent successful AD list job."""
    if not ad_job_id:
        raise HTTPException(status_code=400, detail="ad_job_id is required: choose servers from POST /api/sccm/ad-servers.")
    listed = require_succeeded_job(ad_job_id, "ad_servers", "AD server list")["result"]
    by_name = {}
    for s in as_list(listed.get("servers")):
        if isinstance(s, dict) and s.get("Fqdn"):
            by_name[str(s["Fqdn"]).lower()] = s
            by_name.setdefault(str(s.get("Name") or "").lower(), s)
    chosen = []
    for name in names:
        name = (name or "").strip()
        if not SERVER_NAME_PATTERN.match(name):
            raise HTTPException(status_code=400, detail=f"'{name}' is not a valid server name.")
        row = by_name.get(name.lower())
        if not row:
            raise HTTPException(status_code=400, detail=f"'{name}' is not in AD list job {ad_job_id} (domain {listed.get('domain')}).")
        if not row.get("Supported"):
            raise HTTPException(status_code=400, detail=f"{row['Fqdn']} runs '{row.get('OperatingSystem')}', not Windows Server 2016+.")
        fqdn = str(row["Fqdn"]).lower()
        if fqdn not in chosen:
            chosen.append(fqdn)
    if len(chosen) > MAX_SERVERS_PER_RUN:
        raise HTTPException(status_code=400, detail=f"At most {MAX_SERVERS_PER_RUN} servers per run (SCCM_MAX_SERVERS_PER_RUN); {len(chosen)} selected.")
    return chosen


AD_NAME_FILTER_PATTERN = re.compile(r"^[A-Za-z0-9*_.\-]{1,64}$")
AD_SEARCH_BASE_PATTERN = re.compile(r'^(?:(?:OU|CN|DC)=[^,;"<>\\=]+,)*DC=[^,;"<>\\=]+$', re.IGNORECASE)


@app.post("/api/sccm/ad-servers", status_code=202)
def list_ad_servers(
    request: Optional[AdServerListRequest] = None,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    Enabled Windows servers in Active Directory (Get-ADServers.ps1 on the
    jumphost) to choose patch targets from: Name, Fqdn, OperatingSystem,
    Supported (Server 2016+), LastLogonUtc, Stale, OU, Description...
    domain must be one of SCCM_AD_DOMAINS; name_filter is a wildcard
    (e.g. C03DGH*); search_base an OU distinguished name.
    """
    authorize(x_api_key)
    request = request or AdServerListRequest()
    domain = (request.domain or AD_DOMAINS[0] if AD_DOMAINS else "").strip().lower()
    if domain not in AD_DOMAINS:
        raise HTTPException(status_code=400, detail=f"domain must be one of: {', '.join(AD_DOMAINS)} (SCCM_AD_DOMAINS).")
    name_filter = (request.name_filter or "").strip() or None
    if name_filter and not AD_NAME_FILTER_PATTERN.match(name_filter):
        raise HTTPException(status_code=400, detail="name_filter may contain letters, digits, _ . - and * only (e.g. C03DGH*).")
    search_base = (request.search_base or "").strip() or None
    if search_base and not AD_SEARCH_BASE_PATTERN.match(search_base):
        raise HTTPException(status_code=400, detail="search_base must be a distinguished name, e.g. OU=Servers,DC=dslab,DC=ad,DC=adp,DC=com.")
    return submit_job("ad_servers", {
        "Kind": "AdServerList",
        "ProjectRoot": PROJECT_ROOT,
        "Domain": domain,
        "NameFilter": name_filter,
        "SearchBase": search_base,
        "MaxResults": request.max_results,
        "RequestedAt": iso(utc_now()),
    }, requested_by=requester(x_user))


@app.get("/api/sccm/ad-servers/latest")
def latest_ad_servers(x_api_key: str = Header(default="", alias="X-API-Key")):
    """The last AD server list fetched (no AD query)."""
    authorize(x_api_key)
    return latest_result("ad_servers")


def name_filter_value(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip()
    if value and not SAFE_NAME_PATTERN.match(value):
        raise HTTPException(status_code=400, detail="name_filter may contain letters, digits, spaces and _ . - ( ) only.")
    return value or None


def latest_result(kind: str) -> dict:
    with closing(db()) as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE kind = ? AND status = 'SUCCEEDED' ORDER BY finished_at DESC LIMIT 1",
            (kind,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"No successful {kind} job yet; POST to start one.")
    view = job_view(row)
    return {"job_id": view["job_id"], "finished_at": view["finished_at"], "result": view.get("result")}


@app.post("/api/sccm/sugs", status_code=202)
def list_sugs(
    request: Optional[SugListRequest] = None,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    Software update groups for the SUG dropdown: id, name, description,
    created/modified, deployed, update/KB/expired/superseded counts, KB list
    and updates (first 300). include_kbs=false is faster (names only).
    """
    authorize(x_api_key)
    request = request or SugListRequest()
    return submit_job("sugs", {
        "Kind": "SugList",
        "NameFilter": name_filter_value(request.name_filter),
        "IncludeKbs": request.include_kbs,
        "RequestedAt": iso(utc_now()),
    }, requested_by=requester(x_user))


@app.get("/api/sccm/sugs/latest")
def latest_sugs(x_api_key: str = Header(default="", alias="X-API-Key")):
    """The last SUG list fetched (no SCCM call), e.g. to fill the dropdown at once."""
    authorize(x_api_key)
    return latest_result("sugs")


@app.post("/api/sccm/collections", status_code=202)
def list_collections(
    request: Optional[CollectionListRequest] = None,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """Device collections (id, name, member count; members on request for collections up to 50)."""
    authorize(x_api_key)
    request = request or CollectionListRequest()
    return submit_job("collections", {
        "Kind": "CollectionList",
        "NameFilter": name_filter_value(request.name_filter),
        "IncludeMembers": request.include_members,
        "RequestedAt": iso(utc_now()),
    }, requested_by=requester(x_user))


@app.get("/api/sccm/collections/latest")
def latest_collections(x_api_key: str = Header(default="", alias="X-API-Key")):
    authorize(x_api_key)
    return latest_result("collections")


@app.post("/api/sccm/dry-run/start", status_code=202)
@app.post("/api/sccm/inventory", status_code=202, include_in_schema=False)
def start_dry_run(
    x_api_key: str = Header(default="", alias="X-API-Key"),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    Testing only. Lists SUGs and device collections. The returned job_id is
    the run_id for dry-run/continue.
    """
    authorize(x_api_key)
    return submit_job("inventory", {"Kind": "Inventory"}, idempotency_key,
                      requested_by=requester(x_user))


@app.post("/api/sccm/dry-run/continue", status_code=202)
def continue_dry_run(
    request: DryRunContinueRequest,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    Testing only. Dry run, part 2: read-only validation of the SUG and
    collection picked from the part 1 result. Nothing is created in SCCM.
    """
    authorize(x_api_key)

    inventory = require_succeeded_job(
        request.run_id, "inventory", "dry-run/start"
    )["result"]

    sug = pick_from_inventory(
        inventory.get("sugs"), request.sug_id, request.sug_name, "sug"
    )
    collection = pick_from_inventory(
        inventory.get("collections"),
        request.collection_id, request.collection_name, "collection",
    )

    return submit_job("dry_run", {
        "Kind": "DryRun",
        "SugId": str(sug["id"]),
        "CollectionId": str(collection["id"]),
        "AllowedTargets": sorted(ALLOWED_TARGETS),
    }, idempotency_key, requested_by=requester(x_user))


@app.post("/api/sccm/deployments", status_code=202)
@app.post("/api/sccm/deployments/start", status_code=202, include_in_schema=False)
def start_deployment(
    request: DeploymentRequest,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    Runs the full patching flow on the jumphost for the selected servers:
    collection (new one with exactly those servers, or an existing matching
    one), then 04-DeployAndValidatePatches.ps1 - content distribution,
    maintenance window, Required deployment (optional deadline) with SOP
    settings, install monitoring, restart and KB validation. Servers already
    compliant are skipped. Only one deployment runs at a time (409 with the
    active deployment otherwise). The job runs on the API server, so closing
    the UI does not stop it. Poll the job with log_after for the live log.
    """
    authorize(x_api_key)

    if not ALLOW_DEPLOYMENT:
        raise HTTPException(
            status_code=403,
            detail="Deployment is disabled. Set SCCM_ALLOW_DEPLOYMENT=true "
                   "only after the SCCM administrator approves writes.",
        )
    if not idempotency_key.strip():
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key header is required for deployments.",
        )
    if not request.readiness_confirmed:
        raise HTTPException(
            status_code=400,
            detail="readiness_confirmed must be true: DP content, client "
                   "health, maintenance window and approvals checked.",
        )

    deployment_name = request.deployment_name.strip()
    if request.final_confirmation != deployment_name:
        raise HTTPException(
            status_code=400,
            detail="final_confirmation must exactly match deployment_name.",
        )
    if not SAFE_NAME_PATTERN.match(deployment_name):
        raise HTTPException(
            status_code=400,
            detail="deployment_name may contain letters, digits, spaces and _ . - ( ) only.",
        )

    # Fail fast with the lock details (the binding check is repeated atomically on submit).
    blocker = current_blocker()
    if blocker:
        conflict = lock_conflict(blocker)
        audit("deployment_blocked", requester(x_user), blocker["id"],
              f"requested '{deployment_name}'; {conflict.detail['error']}")
        raise conflict

    # Servers: chosen from a recent, successful prerequisites run.
    precheck = require_succeeded_job(request.precheck_job_id, "prerequisites", "Prerequisites")["result"]
    checked = [s for s in as_list(precheck.get("servers")) if isinstance(s, dict) and s.get("Server")]
    if not checked:
        raise HTTPException(
            status_code=409,
            detail="That prerequisites job has no per-server results (older API version or the report "
                   "was not found). Run POST /api/sccm/prerequisites again.",
        )
    by_short = {str(s["Server"]).split(".")[0].upper(): s for s in checked}
    servers = []
    for name in request.servers:
        name = name.strip()
        if not SERVER_NAME_PATTERN.match(name):
            raise HTTPException(status_code=400, detail=f"'{name}' is not a valid server name.")
        row = by_short.get(name.split(".")[0].upper())
        if not row:
            raise HTTPException(
                status_code=400,
                detail=f"'{name}' was not checked by prerequisites job {request.precheck_job_id}. "
                       f"Choose from: {', '.join(str(s['Server']) for s in checked)}.",
            )
        if str(row.get("Eligibility")).upper() != "ELIGIBLE":
            raise HTTPException(
                status_code=400,
                detail=f"{row['Server']} is {row.get('Eligibility')} (SOP step 6); it cannot be patched.",
            )
        if str(row.get("Overall")).upper() != "READY" and not request.include_not_ready_servers:
            raise HTTPException(
                status_code=400,
                detail=f"{row['Server']} is {row.get('Overall')} (failed: {row.get('Failed') or '-'}). "
                       "Fix it and run prerequisites again, or set include_not_ready_servers=true to deploy anyway.",
            )
        if row["Server"] not in servers:
            servers.append(str(row["Server"]))
    if len(servers) > MAX_SERVERS_PER_RUN:
        raise HTTPException(status_code=400, detail=f"At most {MAX_SERVERS_PER_RUN} servers per deployment (SCCM_MAX_SERVERS_PER_RUN).")

    sug_id = request.sug_id.strip()
    if not sug_id.isdigit():
        raise HTTPException(status_code=400, detail="sug_id must be the numeric SUG ID from POST /api/sccm/sugs.")

    new_name = (request.new_collection_name or "").strip()
    collection_id = (request.collection_id or "").strip()
    if bool(new_name) == bool(collection_id):
        raise HTTPException(
            status_code=400,
            detail="Give either collection_id (existing collection holding exactly the selected servers) "
                   "or new_collection_name (created with the selected servers).",
        )
    if new_name and not SAFE_NAME_PATTERN.match(new_name):
        raise HTTPException(
            status_code=400,
            detail="new_collection_name may contain letters, digits, spaces and _ . - ( ) only.",
        )
    if collection_id and not re.match(r"^[A-Za-z0-9]{3,12}$", collection_id):
        raise HTTPException(status_code=400, detail="collection_id must look like T01005ED.")

    start = request.maintenance_window_start_utc
    if start.tzinfo is None:
        raise HTTPException(
            status_code=400,
            detail="maintenance_window_start_utc must include a time zone, e.g. 2026-10-20T06:00:00Z.",
        )
    start = start.astimezone(timezone.utc).replace(second=0, microsecond=0)
    end = start + timedelta(hours=request.maintenance_window_hours)
    if end < utc_now() + MIN_WINDOW_REMAINING:
        raise HTTPException(
            status_code=400,
            detail=f"The maintenance window must still be open at least {MIN_WINDOW_REMAINING} from now.",
        )
    if start > utc_now() + MAX_WINDOW_START_AHEAD:
        raise HTTPException(
            status_code=400,
            detail=f"maintenance_window_start_utc must be within {MAX_WINDOW_START_AHEAD.days} days.",
        )

    # Deadline: optional; installation starts at the deadline, so it must
    # leave time inside the window.
    deadline = None
    if request.deadline_utc is not None:
        deadline = request.deadline_utc
        if deadline.tzinfo is None:
            raise HTTPException(status_code=400, detail="deadline_utc must include a time zone, e.g. 2026-10-20T07:00:00Z.")
        deadline = deadline.astimezone(timezone.utc).replace(second=0, microsecond=0)
        if deadline < utc_now() - timedelta(minutes=1):
            raise HTTPException(status_code=400, detail="deadline_utc is in the past; leave it empty for as soon as possible.")
        if deadline + MIN_WINDOW_REMAINING > end:
            raise HTTPException(
                status_code=400,
                detail=f"deadline_utc must be at least {MIN_WINDOW_REMAINING} before the maintenance window ends "
                       f"({end.strftime('%Y-%m-%d %H:%M')} UTC), or nothing can install.",
            )

    kbs = []
    for kb in request.kb or []:
        kb = kb.strip()
        if not KB_PATTERN.match(kb):
            raise HTTPException(status_code=400, detail=f"'{kb}' is not a KB number (e.g. KB5087545).")
        kbs.append(kb.upper() if kb.upper().startswith("KB") else f"KB{kb}")

    # The job waits for the window (or deadline), then needs up to the usual deploy time.
    install_from = max(start, deadline or start)
    timeout = DEPLOY_TIMEOUT_SECONDS + max(0, int((install_from - utc_now()).total_seconds()))

    user = requester(x_user)
    return submit_deployment("deployment", {
        "Kind": "RunDeployment",
        "ProjectRoot": PROJECT_ROOT,
        "PrecheckJobId": request.precheck_job_id,
        "Servers": servers,
        "SugId": sug_id,
        "SugName": (request.sug_name or "").strip() or None,
        "CollectionId": collection_id or None,
        "CollectionName": new_name or None,
        "NewCollection": bool(new_name),
        "LimitingCollectionName": (request.limiting_collection_name or "").strip() or None,
        "DeploymentName": deployment_name,
        "MaintenanceWindowStartUtc": start.strftime("%Y-%m-%d %H:%M"),
        "MaintenanceWindowHours": request.maintenance_window_hours,
        "DeadlineUtc": deadline.strftime("%Y-%m-%d %H:%M") if deadline else None,
        "RestartMode": restart_mode_value(request.restart_mode),
        "Kb": kbs,
        "ChangeTicket": request.change_ticket.strip(),
        "Approver": request.approver.strip(),
        "ApprovalReference": request.approval_reference.strip(),
        "RequestedBy": user,
    }, idempotency_key, user, deployment_name, allow_outcome_unknown=False, timeout=timeout)


@app.post("/api/sccm/deployments/resume", status_code=202)
def resume_deployment(
    request: DeploymentResumeRequest,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    Continues the last deployment run on the jumphost (or report_folder, e.g.
    '20261019_023200Z' from result.report_folder_name): reuses its collection,
    window and deployment, keeps its baseline, and carries on with
    monitoring, restart and validation. Allowed while the lock is held by an
    OUTCOME_UNKNOWN deployment (resuming is how that is cleared).
    """
    authorize(x_api_key)
    if not ALLOW_DEPLOYMENT:
        raise HTTPException(status_code=403, detail="Deployment is disabled (SCCM_ALLOW_DEPLOYMENT).")

    folder = (request.report_folder or "").strip() or None
    if folder and not REPORT_FOLDER_PATTERN.match(folder):
        raise HTTPException(status_code=400, detail="report_folder must look like 20261019_023200Z.")

    # Name shown in the lock while resuming: the deployment being continued.
    blocker = current_blocker()
    name = None
    if blocker and blocker["status"] == "OUTCOME_UNKNOWN":
        name = lock_info(blocker)["deployment_name"]

    user = requester(x_user)
    return submit_deployment("deployment_resume", {
        "Kind": "RunDeployment",
        "ProjectRoot": PROJECT_ROOT,
        "Resume": True,
        "ReportFolder": folder,
        "RestartMode": restart_mode_value(request.restart_mode),
        "RequestedAt": iso(utc_now()),
        "RequestedBy": user,
    }, idempotency_key, user, name, allow_outcome_unknown=True)


@app.get("/api/sccm/deployments/active")
def active_deployment(x_api_key: str = Header(default="", alias="X-API-Key")):
    """
    Is a deployment holding the lock? For the UI banner ("Deployment in
    progress by X") and to disable the Deploy button. Reads the job store
    only (no SCCM call), so it can be polled.
    """
    authorize(x_api_key)
    with closing(db()) as conn:
        blocker = deployment_blocker(conn)
        kinds = tuple(DEPLOY_KINDS)
        last = conn.execute(
            f"SELECT * FROM jobs WHERE kind IN ({','.join('?' * len(kinds))}) "
            "ORDER BY created_at DESC, rowid DESC LIMIT 1",
            kinds,
        ).fetchone()
    info = lock_info(blocker) if blocker else None
    state = info["status"] if info else "IDLE"
    return {
        "locked": bool(info),
        "state": state,
        "can_deploy": ALLOW_DEPLOYMENT and not info,
        "can_resume": ALLOW_DEPLOYMENT and (not info or state == "OUTCOME_UNKNOWN"),
        "deployment_enabled": ALLOW_DEPLOYMENT,
        "message": lock_message(info) if info else (
            "No deployment is running." if ALLOW_DEPLOYMENT else "Deployments are disabled on this API."
        ),
        "active_deployment": info,
        "last_deployment": None if not last else {
            "job_id": last["id"],
            "kind": last["kind"],
            "status": last["status"],
            "deployment_name": last["deployment_name"],
            "requested_by": last["requested_by"],
            "finished_at": last["finished_at"],
            "report_html_url": f"/api/reports/{last['id']}/html",
        },
    }


@app.post("/api/sccm/deployments/release-lock")
def release_lock(
    request: ReleaseLockRequest,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    x_admin_key: str = Header(default="", alias="X-Admin-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    Admin: release the lock held by an OUTCOME_UNKNOWN deployment after
    checking SCCM (POST /api/sccm/deployments/lookup). A QUEUED/RUNNING job
    cannot be released. Who, when and why are logged (audit log, job log).
    """
    authorize(x_api_key)
    authorize_admin(x_admin_key)
    user = requester(x_user)
    if not user:
        raise HTTPException(status_code=400, detail="X-User header (your name) is required to release the lock.")
    reason = request.reason.strip()

    with DB_LOCK, closing(db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        blocker = deployment_blocker(conn)
        if not blocker:
            conn.rollback()
            return {"released": False, "message": "No deployment lock is held."}
        if blocker["id"] != request.job_id:
            conn.rollback()
            raise HTTPException(status_code=409, detail=f"The lock is held by job {blocker['id']}, not {request.job_id}.")
        if blocker["status"] in ACTIVE_STATUSES:
            conn.rollback()
            raise HTTPException(
                status_code=409,
                detail=f"Job {blocker['id']} is {blocker['status']}; a running deployment cannot be released. "
                       "If the API was restarted, the job becomes OUTCOME_UNKNOWN on start-up.",
            )
        now = iso(utc_now())
        conn.execute(
            "UPDATE jobs SET lock_released_at = ?, lock_released_by = ?, lock_release_reason = ? WHERE id = ?",
            (now, user, reason, blocker["id"]),
        )
        conn.execute(
            "INSERT INTO audit_log (ts, action, user, job_id, detail) VALUES (?, ?, ?, ?, ?)",
            (now, "lock_released", user, blocker["id"], reason),
        )
        conn.commit()

    append_log(blocker["id"], f"Deployment lock released by {user} at {now}: {reason}")
    print(f"AUDIT lock_released user={user} job={blocker['id']} {reason}", flush=True)
    return {
        "released": True,
        "job_id": blocker["id"],
        "deployment_name": blocker["deployment_name"],
        "released_by": user,
        "released_at": now,
        "reason": reason,
    }


@app.get("/api/audit")
def audit_entries(
    limit: int = 100,
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    """Deployments started/finished, blocked attempts and lock releases."""
    authorize(x_api_key)
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (max(1, min(limit, 1000)),)
        ).fetchall()
    return {"entries": [dict(row) for row in rows]}


# ------------------------------------------------------------
# Reports: every environment, prerequisites and deployment job is a report;
# old reports on the jumphost can be imported.
# ------------------------------------------------------------

def report_job(job_id: str) -> dict:
    row = get_job(job_id)
    if not row or row["kind"] not in REPORT_KINDS:
        raise HTTPException(status_code=404, detail="Report not found.")
    if row["status"] in ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail=f"Job is {row['status']}; the report is ready when it finishes.")
    return job_view(row)


@app.get("/api/reports")
def list_reports(
    kind: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    """
    Old and new reports, newest first. kind: environment, prerequisites,
    deployment (includes resumes and imported deployment reports).
    """
    authorize(x_api_key)
    limit = max(1, min(limit, 200))
    marks = ",".join("?" * len(REPORT_KINDS))
    with closing(db()) as conn:
        rows = conn.execute(
            f"SELECT * FROM jobs WHERE kind IN ({marks}) AND status NOT IN ('QUEUED', 'RUNNING') "
            "ORDER BY created_at DESC, rowid DESC",
            REPORT_KINDS,
        ).fetchall()
    items = []
    for row in rows:
        result = json.loads(row["result_json"]) if row["result_json"] else {}
        rtype = reports.report_type(row["kind"], result)
        if kind and rtype != kind:
            continue
        items.append({
            "job_id": row["id"],
            "report_type": rtype,
            "kind": row["kind"],
            "status": row["status"],
            "requested_by": row["requested_by"],
            "deployment_name": row["deployment_name"] or result.get("deployment_name"),
            "created_at": row["created_at"],
            "finished_at": row["finished_at"],
            "headline": result.get("report_headline") or reports.report_headline(row["kind"], result),
            "report_folder_name": result.get("report_folder_name"),
            "report_url": f"/api/reports/{row['id']}",
            "report_html_url": f"/api/reports/{row['id']}/html",
        })
    return {"total": len(items), "reports": items[offset:offset + limit]}


@app.get("/api/reports/{job_id}")
def get_report(job_id: str, x_api_key: str = Header(default="", alias="X-API-Key")):
    """The report as data (the job's result) plus the HTML link."""
    authorize(x_api_key)
    view = report_job(job_id)
    result = view.pop("result", {}) or {}
    return {
        "report_type": reports.report_type(view["kind"], result),
        "job": view,
        "report": result,
        "report_html_url": f"/api/reports/{job_id}/html",
    }


@app.get("/api/reports/{job_id}/html", response_class=HTMLResponse)
def get_report_html(
    job_id: str,
    download: bool = False,
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    """Self-contained HTML report (inline CSS, no scripts). ?download=true to save it as a file."""
    authorize(x_api_key)
    view = report_job(job_id)
    logs = get_logs(job_id, -1, 20000) if view["kind"] in DEPLOY_KINDS else []
    page = reports.render_report(view, logs)
    headers = {}
    if download:
        rtype = reports.report_type(view["kind"], view.get("result") or {})
        headers["Content-Disposition"] = f'attachment; filename="{rtype}-report-{job_id}.html"'
    return HTMLResponse(content=page, headers=headers)


@app.post("/api/sccm/reports/jumphost", status_code=202)
def list_jumphost_reports(
    request: Optional[JumphostReportListRequest] = None,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """Report folders on the jumphost (Reports\\<timestamp>), including runs made outside the API."""
    authorize(x_api_key)
    request = request or JumphostReportListRequest()
    return submit_job("report_list", {
        "Kind": "ReportList",
        "ProjectRoot": PROJECT_ROOT,
        "Limit": request.limit,
        "RequestedAt": iso(utc_now()),
    }, requested_by=requester(x_user))


@app.post("/api/sccm/reports/jumphost/import", status_code=202)
def import_jumphost_report(
    request: JumphostReportImportRequest,
    x_api_key: str = Header(default="", alias="X-API-Key"),
    x_user: str = Header(default="", alias="X-User"),
):
    """
    Loads one jumphost report folder (deployment or prerequisites) into the
    report store; then GET /api/reports/{job_id} and /html like any report.
    """
    authorize(x_api_key)
    folder = request.report_folder.strip()
    if not REPORT_FOLDER_PATTERN.match(folder):
        raise HTTPException(status_code=400, detail="report_folder must look like 20261019_023200Z.")
    return submit_job("report_import", {
        "Kind": "ReportRead",
        "ProjectRoot": PROJECT_ROOT,
        "ReportFolder": folder,
        "RequestedAt": iso(utc_now()),
    }, requested_by=requester(x_user))


@app.post("/api/dslab/connection-test", status_code=202)
def dslab_connection_test(
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    """Can the API reach the DSLAB jumphost with the DSLAB account? Read-only."""
    authorize(x_api_key)
    require_dslab()
    return submit_job("dslab_connection_test", {
        "Kind": "DslabConnectionTest",
        "Jumphost": DSLAB_JUMPHOST,
        "RequestedAt": iso(utc_now()),
    })


@app.post("/api/dslab/validate-servers", status_code=202)
def dslab_validate_servers(
    request: DslabValidateRequest,
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    """
    From the DSLAB jumphost, checks each server: DNS, ping, WinRM, logon and
    local admin, OS/build, last boot, free disk, pending reboot, SCCM client,
    recent and missing updates, and the given KBs. Read-only.
    Default servers: the allowlisted test servers.
    """
    authorize(x_api_key)
    require_dslab()

    names = request.servers or sorted(ALLOWED_TARGETS)
    if len(names) > MAX_DSLAB_SERVERS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_DSLAB_SERVERS} servers per request.")
    servers = []
    for name in names:
        name = name.strip().lower()
        if not SERVER_NAME_PATTERN.match(name):
            raise HTTPException(status_code=400, detail=f"'{name}' is not a valid server name.")
        servers.append(name if "." in name else f"{name}.{DSLAB_DOMAIN}")

    kbs = []
    for kb in request.kb or []:
        kb = kb.strip()
        if not KB_PATTERN.match(kb):
            raise HTTPException(status_code=400, detail=f"'{kb}' is not a KB number (e.g. KB5087545).")
        kbs.append(kb.upper() if kb.upper().startswith("KB") else f"KB{kb}")

    return submit_job("dslab_validate", {
        "Kind": "DslabValidateServers",
        "Jumphost": DSLAB_JUMPHOST,
        "Servers": sorted(set(servers)),
        "Kb": kbs,
        "RequestedAt": iso(utc_now()),
    })


@app.post("/api/sccm/deployments/lookup", status_code=202)
def lookup_deployment(
    request: DeploymentLookupRequest,
    x_api_key: str = Header(default="", alias="X-API-Key"),
):
    """Check SCCM for a deployment by name, e.g. after OUTCOME_UNKNOWN."""
    authorize(x_api_key)
    return submit_job("deployment_lookup", {
        "Kind": "DeploymentLookup",
        "DeploymentName": request.deployment_name.strip(),
    })
