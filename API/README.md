# SCCM Patching Automation API (v4)

## How it works
- **Every operation is a background job.**
  - A POST returns `202` with a `job_id` straight away.
  - Poll `GET /api/jobs/{job_id}?wait=60&log_after=N` until `status` is final.
  - Jobs, logs and the audit log are stored in SQLite (`API\jobs.db`).
- **Jobs run inside the API process, not in the browser.**
  - Closing the UI does not stop a deployment. Any user can reopen it: `GET /api/sccm/deployments/active`, then the job's log.
  - Stopping the API process does stop a deployment. On the next start the job is marked `OUTCOME_UNKNOWN` (resume it).
- **Live log:** everything the PowerShell scripts print on the jumphost streams into the job log line by line.
- **One deployment at a time, across all users.**
  - A new deployment is refused with `409` (who started it, when, status, latest log line) while another one is `QUEUED`/`RUNNING`, or while the last one is `OUTCOME_UNKNOWN`.
  - The check and the job creation are a single database transaction.
  - An admin can release an `OUTCOME_UNKNOWN` lock with a reason (`POST /api/sccm/deployments/release-lock`, logged).
- **Reports as data and HTML.**
  - Environment, prerequisites and deployment jobs return structured results instead of file paths.
  - `GET /api/reports/{job_id}/html` renders a detailed HTML report.
  - `GET /api/reports` lists old and new reports.
  - Jumphost report folders (e.g. from `Run-Patching.ps1`) can be imported.

## Flow
| Step | Endpoint | Input |
|---|---|---|
| 1. Environment check | `POST /api/sccm/environment-check` | none → `checks[]` + HTML report |
| 2. Prerequisites | `POST /api/sccm/prerequisites` | none → `servers[]` (READY / NOT READY), `checks[]` + HTML report |
| 3. Select servers | (UI) | from step 2's `servers` |
| 4. SUG | `POST /api/sccm/sugs` (or `GET /api/sccm/sugs/latest`) | optional `name_filter` → SUGs with KB counts and KB lists |
| 5. Collection | new name, or `POST /api/sccm/collections` for an existing one | the collection must hold exactly the selected servers |
| 6–7. Deploy | `POST /api/sccm/deployments` | `precheck_job_id`, `servers`, `sug_id`, `new_collection_name`/`collection_id`, deployment name, window (start UTC + hours), optional `deadline_utc`, restart mode, approvals |
| 8. Report | `GET /api/reports/{job_id}/html` | – |
| Resume | `POST /api/sccm/deployments/resume` | optional `report_folder` |

**What the deployment job does on the jumphost:**
1. Resolves the SUG by ID.
2. Creates the collection with exactly the selected servers (or checks that the existing one matches them).
3. Runs `Automation\Scripts\04-DeployAndValidatePatches.ps1` unattended:
   - **Baseline:** servers that are already compliant are skipped.
   - **Content:** distributed to the configured DP group.
   - **Maintenance window:** created on the collection.
   - **Required deployment:** created with the SOP settings and the chosen deadline.
   - **Install monitoring.**
   - **Restart.**
   - **Per-KB validation.**

The dry-run endpoints (`/api/sccm/dry-run/start`, `/continue`) remain for testing only.

Other endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /health` | API status, including `deployment_lock` |
| `GET /api/sccm/deployments/active` | Who holds the deployment lock, if anyone |
| `POST /api/sccm/deployments/lookup` | Check SCCM for a deployment by name |
| `GET /api/jobs`, `GET /api/jobs/{id}/log` | Recent jobs; a job's whole log |
| `GET /api/audit` | Deployments started/finished, blocked attempts, lock releases |
| `POST /api/sccm/reports/jumphost`, `POST /api/sccm/reports/jumphost/import` | List and import jumphost report folders |
| `POST /api/sccm/connection-test` | Check the jumphost session and folder access |
| `POST /api/dslab/connection-test`, `POST /api/dslab/validate-servers` | DSLAB checks |

Docs: [API-Integration.md](API-Integration.md) (frontend), [API-Testing.md](API-Testing.md) (Postman / Thunder Client), [SCCM-Patching-API.postman_collection.json](SCCM-Patching-API.postman_collection.json).

## Starting the API (Cloud PC)

### 1. Env file with the service-account credentials (once)
The API reads its settings and passwords from an env file **outside the project folder**. Nothing is pasted into the terminal.
```powershell
New-Item -ItemType Directory "$env:USERPROFILE\.sccm-api" -Force | Out-Null
Copy-Item .\sccm-api.env.example "$env:USERPROFILE\.sccm-api\sccm-api.env"
notepad "$env:USERPROFILE\.sccm-api\sccm-api.env"          # fill in the values
icacls "$env:USERPROFILE\.sccm-api\sccm-api.env" /inheritance:r /grant:r "$($env:USERNAME):F"
```
- Default location: `%USERPROFILE%\.sccm-api\sccm-api.env`. Elsewhere: `$env:SCCM_ENV_FILE = 'D:\secure\sccm-api.env'`.
- The API **refuses to start** if the env file is inside the project folder.
- Required keys:
  - `SCCM_API_KEY`
  - `SCCM_USERNAME` / `SCCM_PASSWORD` (jumphost login, `SCCMAutomation` endpoint)
- Usual keys:
  - `SCCM_PROJECT_ROOT` (default `C:\SCCM_Automation`)
  - `SCCM_ALLOW_DEPLOYMENT`
  - `SCCM_DSLAB_USERNAME` / `SCCM_DSLAB_PASSWORD`
  - `SCCM_TARGET_USERNAME` / `SCCM_TARGET_PASSWORD`
  - `SCCM_ADMIN_API_KEY`
- Format: `NAME=value`, one per line. `#` starts a comment line only, so passwords may contain `#`.
- A variable already set in the session overrides the file.
- The passwords are plain text in that file, protected by its permissions (the `icacls` line). Keep it on the Cloud PC only and never commit or share it.

### 2. Start
```powershell
cd "<project>\API"
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1
```
The start-up lines show which env file was used and where each credential came from (`env file` / `environment` / `prompt` / `not set`). Missing optional values are prompted for only in an interactive terminal; set `SCCM_NO_PROMPT=true` to never prompt.

**Keep this process running during a deployment.** Closing the browser is fine. Closing this window, signing out, or the Cloud PC sleeping or restarting stops the job; resume it afterwards.

**Notes:**
- The target server account lets the deployment script check KBs on the servers and restart them over WinRM. Without it, the DSLAB account is used. If neither is set, the script relies on SCCM status and the SCCM client restarts the servers.
- Cross-domain DSLAB connection: if the DSLAB connection test fails with a Kerberos/TrustedHosts error, run this on the Cloud PC as admin: `Set-Item WSMan:\localhost\Client\TrustedHosts -Value 'ordpdslwts01.dslab.ad.adp.com' -Concatenate -Force`.
- On the jumphost, `Config\Settings.json` must have `"AllowWriteOperations": true` for deployments, and `GLOBAL\svc_patching_auto1` needs Modify on `SCCM_PROJECT_ROOT`.
- Optional overrides: `SCCM_JUMPHOST`, `SCCM_SITE_SERVER`, `SCCM_SITE_CODE`, `SCCM_SESSION_CONFIG`, `SCCM_JOB_DB`, `SCCM_DEPLOY_TIMEOUT_HOURS` (default 12; a deployment job also gets the time until its window or deadline), `SCCM_CORS_ORIGINS`. Run a single worker only.

Do not expose this API publicly; keep it bound to localhost unless your organisation approves an authenticated HTTPS gateway.

## Change to the deployment script
`04-DeployAndValidatePatches.ps1` has one new optional parameter, `-DeadlineUtc 'yyyy-MM-dd HH:mm'`. Without it, the script behaves as before (deadline as soon as possible). With it:
- the deployment deadline is set to that time, and must be inside the maintenance window;
- install monitoring waits for the later of the window start and the deadline;
- the deadline is saved in `State.json` for `-Resume`.

## Operator client
`Client\Invoke-SccmPatchingClient.ps1 -Mode Deploy` sends an old request format and does not work with this API version. Use the UI, Postman (`09`) or `Automation\Run-Patching.ps1` on the jumphost.

## Critical safety note
The deployment endpoint is disabled by default (`SCCM_ALLOW_DEPLOYMENT=false`). When enabled, it creates a **Required** deployment that installs inside the maintenance window and restarts servers. Confirm the window, content distribution, client health, change approval and console/site compatibility first.
