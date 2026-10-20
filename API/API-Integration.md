# SCCM Patching API – Frontend Integration Guide (v4)

This guide explains how the UI talks to the SCCM Patching API: what to send, what comes back, how to poll, how to show the live log and the reports, and how to handle errors and the one-deployment-at-a-time lock.

**The patching flow the UI implements:**

1. **Environment check**: is the jumphost ready?
2. **Prerequisite checks**: are the servers ready? Shows an HTML report.
3. **Select servers**: the user ticks the READY servers to patch.
4. **Select the SUG** (software update group) from a list.
5. **Collection**: create a new one with the selected servers, or pick an existing one that holds exactly those servers. The distribution point group stays as configured on the jumphost.
6. **Maintenance window** (start + hours) and an optional **deadline**.
7. **Deploy**: live log while it deploys, installs, restarts and validates.
8. **Final report**: an HTML report, plus all older reports.

The dry-run endpoints (`/api/sccm/dry-run/*`) are for testing only and are not part of this flow.

---

## 1. Basics

| Item | Value |
|---|---|
| Base URL | `http://127.0.0.1:8000` (make it configurable, e.g. `VITE_SCCM_API_URL`) |
| Auth | Header `X-API-Key: <key>` on every request except `GET /health` |
| User | Header **`X-User: <logged-in user's name>`** on every request. It is stored as `requested_by` and shown to other users, e.g. "Deployment in progress by Yogesh Soni" |
| Request body | JSON, header `Content-Type: application/json` |
| Times | Always UTC, ISO 8601 with `Z`, e.g. `2026-10-20T06:00:00Z` |
| IDs | All IDs are **strings** (even numeric-looking ones like `"16778280"`) |

**CORS:** browser calls are accepted only from the origins in the API's `SCCM_CORS_ORIGINS` setting (default `http://localhost:3000,http://localhost:5173`). Allowed request headers: `X-API-Key`, `X-Admin-Key`, `X-User`, `Idempotency-Key`, `Content-Type`.

**API key:** anything bundled into frontend code is visible to users. That's acceptable for this local proof of concept. For production, put the key behind your own backend or proxy.

**`X-User` is not authentication.** It is a display name sent by the UI, so the API trusts whatever it receives.

---

## 2. Jobs: the one concept to understand

SCCM operations take from 15 seconds to many hours, so the API never makes the UI wait on a POST:

1. The UI sends `POST`. The API replies at once with **202** and a **job** (`status: "QUEUED"`).
2. The UI **polls** `GET /api/jobs/{job_id}?wait=N&log_after=M` until `status` is final, appending the new **log lines** each time.
3. The output is in `job.result`.

**Jobs run on the API server, not in the browser.** Closing the tab, refreshing or losing the network does **not** stop a deployment. Any user can reopen it later: `GET /api/sccm/deployments/active` returns the running job, and its full log is at `GET /api/jobs/{job_id}/log`.

### 2.1 Job object (returned by every POST and every poll)

```json
{
  "job_id": "Xy12abCD34efGH56",
  "kind": "deployment",
  "status": "RUNNING",
  "requested_by": "Yogesh Soni",
  "deployment_name": "Patch Testing Oct 2026",
  "created_at": "2026-10-20T05:58:00+00:00",
  "started_at": "2026-10-20T05:58:01+00:00",
  "finished_at": null,
  "request": { "Kind": "RunDeployment", "Servers": ["c03dghhypv8871.dslab.ad.adp.com"], "...": "..." },
  "poll_url": "/api/jobs/Xy12abCD34efGH56",
  "report_url": "/api/reports/Xy12abCD34efGH56",
  "report_html_url": "/api/reports/Xy12abCD34efGH56/html",
  "log_lines": 42,
  "log": [
    { "seq": 41, "time": "2026-10-20T06:21:07+00:00", "line": "  c03dghhypv8871.dslab.ad.adp.com    INSTALLING    SCCM: Non-compliant | enforcement: Downloading update(s)" }
  ],
  "log_next": 41,
  "log_more": false
}
```

| Field | Use in UI |
|---|---|
| `job_id` | Keep it: used for polling and as input to the next step |
| `kind` | Which polling settings to use (2.4) |
| `status` | Drive the spinner/progress state |
| `requested_by` | Who started it |
| `report_url` / `report_html_url` | Only on report jobs (environment, prerequisites, deployment, resume, imported report) |
| `log` / `log_next` / `log_more` | Only when you send `log_after` (2.3) |
| `result` | Only present once finished |

### 2.2 Statuses

| status | Final? | UI behaviour |
|---|---|---|
| `QUEUED` | no | "Waiting in queue…" |
| `RUNNING` | no | "Running on jumphost…" + live log |
| `SUCCEEDED` | yes | Show `result`. For deployments: every server **PATCHED** |
| `COMPLETED_WITH_ISSUES` | yes | **Deployments only.** It ran, but not every server is PATCHED |
| `FAILED` | yes | Show `result.errors` (array of strings) |
| `OUTCOME_UNKNOWN` | yes | **Deployments only.** The run was cut off after the deployment may have been created. Offer **Resume**. This status **keeps the deployment lock** (section 6) |

Every finished `result` also has `success`, `warnings` (show as a non-blocking banner), `run_as`, `duration_seconds` and `next_step` (a hint, for display or logging only).

### 2.3 Live log

Every job has a log: everything the PowerShell scripts print on the jumphost, line by line, as it happens.

- Send `log_after=-1` on the first poll, then `log_after=<log_next from the previous response>`.
- Each response contains only the **new** lines (`log`), at most 1000. If `log_more` is `true`, poll again immediately.
- With `log_after`, `?wait=N` returns as soon as new lines arrive (or the job finishes).
- Each line has `seq`, `time` (UTC) and `line` (plain text; may be empty or a column-aligned table row).
- Whole log (after a reload or for download): `GET /api/jobs/{job_id}/log?after=-1&limit=5000`.

**UI:** monospace, `white-space: pre`, auto-scroll (paused while the user scrolls up), "Download log". Highlight `WARNING:` (amber) and `ERROR:` (red). Lines like `5. Required deployment (SOP settings)` mark the deployment stages; use them for a step indicator (section 4.8).

### 2.4 Polling settings per endpoint

| Endpoint | `kind` | Typical duration | First poll after | `?wait=` | Gap | Give up after |
|---|---|---|---|---|---|---|
| Connection test | `connection_test` | ~15 s | 2 s | 20 | 1 s | 10 min |
| Environment check | `environment` | ~15 s | 2 s | 20 | 1 s | 20 min |
| Prerequisites | `prerequisites` | 1–3 min | 2 s | 30 | 1 s | 35 min |
| SUG list | `sugs` | 1–10 min (with KBs) | 3 s | 60 | 1 s | 50 min |
| Collection list | `collections` | 20 s – 2 min | 2 s | 30 | 1 s | 20 min |
| Deployment | `deployment` | **30 min – many hours** | 2 s | 60 | 1 s | until final* |
| Deployment resume | `deployment_resume` | same | 2 s | 60 | 1 s | until final* |
| Deployment lookup | `deployment_lookup` | ~20 s | 2 s | 20 | 1 s | 20 min |
| Jumphost report list | `report_list` | ~10 s | 2 s | 20 | 1 s | 10 min |
| Jumphost report import | `report_import` | ~10 s | 2 s | 20 | 1 s | 10 min |
| DSLAB connection test | `dslab_connection_test` | ~10 s | 2 s | 20 | 1 s | 10 min |
| DSLAB server validation | `dslab_validate` | 20 s – 2 min | 2 s | 30 | 1 s | 35 min |
| Dry run (testing) | `inventory` / `dry_run` | 2–10 min | 5 s | 60 | 2 s | 35 min |

\* A deployment job waits for the maintenance window or deadline, then runs for up to 12 hours (`SCCM_DEPLOY_TIMEOUT_HOURS`). Keep polling while the screen is open. When the user leaves, stop polling; the job carries on.

```js
export const POLL_CONFIG = {
  connection_test:   { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 10 * 60_000 },
  environment:       { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 20 * 60_000 },
  prerequisites:     { firstDelayMs: 2000, waitSeconds: 30, gapMs: 1000, timeoutMs: 35 * 60_000 },
  sugs:              { firstDelayMs: 3000, waitSeconds: 60, gapMs: 1000, timeoutMs: 50 * 60_000 },
  collections:       { firstDelayMs: 2000, waitSeconds: 30, gapMs: 1000, timeoutMs: 20 * 60_000 },
  deployment:        { firstDelayMs: 2000, waitSeconds: 60, gapMs: 1000, timeoutMs: Infinity },
  deployment_resume: { firstDelayMs: 2000, waitSeconds: 60, gapMs: 1000, timeoutMs: Infinity },
  deployment_lookup: { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 20 * 60_000 },
  report_list:       { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 10 * 60_000 },
  report_import:     { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 10 * 60_000 },
  dslab_connection_test: { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 10 * 60_000 },
  dslab_validate:    { firstDelayMs: 2000, waitSeconds: 30, gapMs: 1000, timeoutMs: 35 * 60_000 },
  inventory:         { firstDelayMs: 5000, waitSeconds: 60, gapMs: 2000, timeoutMs: 35 * 60_000 },
  dry_run:           { firstDelayMs: 5000, waitSeconds: 60, gapMs: 2000, timeoutMs: 35 * 60_000 },
};
```

### 2.5 Polling algorithm

```
job = POST response;  cursor = -1
sleep(firstDelay)
loop:
    job = GET /api/jobs/{job_id}?wait={waitSeconds}&log_after={cursor}
    append job.log to the log panel;  cursor = job.log_next
    update UI with job.status
    if job.log_more → continue immediately
    if job.status is final → done
    if elapsed > timeout → stop, offer "Check again"
    sleep(gap)
```

- Network error or HTTP 5xx while polling: retry; give up after 3 failures in a row.
- HTTP 4xx while polling (401, 404): stop and show the error.
- Stop polling when the user leaves the screen (`AbortController`). This does not affect the job.
- Save `job_id` and `cursor` (state + `sessionStorage`). After a reload, load the whole log and continue polling.

Reference code is in section 9.

---

## 3. Screen flow

```
[App load / every screen]
   GET /health                          ─► API up, deployment enabled, lock holder
   GET /api/sccm/deployments/active     ─► banner "Deployment in progress by X" + disable Deploy (poll every 30 s)

[Step 1  Environment]   POST /environment-check ─► poll ─► result.checks  + [View report] (HTML)
[Step 2  Prerequisites] POST /prerequisites     ─► poll ─► result.servers + [View report] (HTML)   ── keep precheck_job_id
[Step 3  Servers]       checkbox list from result.servers (READY ones selectable; preselect result.selectable_servers)
[Step 4  SUG]           GET /sugs/latest (instant, may be old)  or  POST /sugs ─► poll ─► dropdown (KB counts, KB list)
[Step 5  Collection]    ( ) Create new: name            ( ) Use existing: POST /collections ─► poll ─► dropdown
[Step 6  Schedule]      window start (UTC) + hours, optional deadline (UTC), restart mode
[Step 7  Approvals]     change ticket, approver, reference, readiness checkbox, re-type name, final modal
[Step 8  Deploy]        POST /deployments + Idempotency-Key ─► poll with live log (any user can watch)
[Step 9  Report]        GET /api/reports/{job_id}/html  ─► show; [Download]
[Reports]               GET /api/reports ─► list (old + new) ─► open any report
                        POST /reports/jumphost ─► jumphost folders ─► [Import] ─► report
```

**Rules the UI must respect:**
- `precheck_job_id` must be a `SUCCEEDED` prerequisites job less than 24 hours old.
- Selected servers must come from that job's `servers`. Servers that are `NOT READY` need the user to confirm (`include_not_ready_servers: true`). `NOT ELIGIBLE` servers are always refused.
- Only one deployment at a time across all users (section 6).

---

## 4. Endpoint reference

### 4.1 Health: `GET /health`
No API key, returns at once (not a job).
```json
{
  "status": "ok",
  "version": "4.0.0",
  "deployment_enabled": true,
  "target_server_account": "dslab\\svc_patching_auto1",
  "running_deployment_job": "Xy12abCD34efGH56",
  "deployment_lock": { "job_id": "Xy12abCD34efGH56", "status": "RUNNING", "deployment_name": "Patch Testing Oct 2026",
                       "requested_by": "Yogesh Soni", "created_at": "...", "started_at": "..." },
  "dslab_jumphost": "ordpdslwts01.dslab.ad.adp.com"
}
```
| Field | UI |
|---|---|
| `deployment_enabled` | `false`: hide the deployment steps ("Deployment is disabled on the server") |
| `deployment_lock` | not `null`: a deployment holds the lock (details: 4.10) |
| `target_server_account` | `null`: "No server account: KB checks and restarts rely on SCCM only" |
| `dslab_jumphost` | `null`: hide the DSLAB checks |

### 4.2 Connection test: `POST /api/sccm/connection-test`
"Test connection" button. Also offer it whenever a job fails with "Access is denied". No body. **Result:** `host`, `run_as`, `project_root`, `scripts_folder`, `reports_folder`, `sccm`, `target_servers`. A value starting with `OK` is green; `FAILED: …` is red.

### 4.3 Environment check: `POST /api/sccm/environment-check`  *(Step 1)*
No body. Poll kind `environment`. **Result:**
```json
{
  "success": true,
  "host": "ORDPGBLWTS21",
  "run_as": "GLOBAL\\svc_patching_auto1",
  "checks": [
    { "Check": "Windows PowerShell 5.1", "Status": "PASS", "Detail": "5.1.20348.2849" },
    { "Check": "ActiveDirectory module", "Status": "AVAILABLE", "Detail": "C:\\Windows\\..." },
    { "Check": "Configuration Manager module", "Status": "AVAILABLE", "Detail": "C:\\Program Files (x86)\\..." }
  ],
  "report_headline": "3 checks, 0 failed",
  "report_html_url": "/api/reports/<job_id>/html",
  "output": "…script text…"
}
```
**UI:** a table of `checks` (status badge), plus **View report**, which shows the HTML (4.12).

### 4.3a Servers from AD: `POST /api/sccm/ad-servers`  *(before Step 2)*
Lists the enabled Windows servers in Active Directory (`Scripts\Get-ADServers.ps1` on the jumphost). Poll kind `ad_servers` (10 s – 2 min). `GET /api/sccm/ad-servers/latest` returns the last list at once (404 when none yet).

Body (all optional):
```json
{ "domain": "dslab.ad.adp.com", "name_filter": "C03DGH*", "search_base": "OU=Servers,DC=dslab,DC=ad,DC=adp,DC=com", "max_results": 2000 }
```
- `domain` must be one of `GET /health` → `ad_domains` (env `SCCM_AD_DOMAINS`).
- `name_filter`: letters, digits, `_ . -` and `*` wildcards.

**Result:**
```json
{
  "domain": "dslab.ad.adp.com", "count": 7, "truncated": false,
  "server_summary": { "total": 7, "selectable": 5, "unsupported_os": 1, "no_dns_name": 1, "stale": 2 },
  "selectable_servers": ["c03dghhypv3621.dslab.ad.adp.com", "..."],
  "servers": [
    { "Name": "C03DGHHYPV3621", "Fqdn": "c03dghhypv3621.dslab.ad.adp.com", "OperatingSystem": "Windows Server 2022 Datacenter",
      "Supported": true, "LastLogonUtc": "2026-10-19T06:12:00Z", "Stale": false, "OU": "dslab.ad.adp.com/Servers/Hyper-V",
      "Description": "Hyper-V host", "DistinguishedName": "CN=C03DGHHYPV3621,OU=Servers,..." }
  ]
}
```
Selectable = `Supported` (Windows Server 2016/2019/2022/2025) and has an `Fqdn`. **Keep `job_id` as `adJobId`.** At most `max_servers_per_run` servers (from `/health`) per run.

### 4.3b Change requests: `POST /api/change-requests`
Servers listed (`Allowed: true`) in `Config\TestServers.json` on the jumphost are **Test**; every other server is **Pre-prod / Prod**. The AD list job reads that file and returns it as `test_servers`. AD and prerequisite results carry `Environment` per server. A deployment that includes any pre-prod / prod server needs `change_ticket`; one with only test servers may omit it.

Body: `{ "short_description": "...", "description": "...", "change_type": "Normal", "risk": "Low", "planned_start_utc": "...", "planned_end_utc": "...", "servers": ["..."] }` → **201** `{ "number": "CHG0000001", "state": "New", "approval": "Requested", "created_at": "...", "requested_by": "..." }`. Until the ITSM API is connected the number is the fixed `CHANGE_PLACEHOLDER_NUMBER` in `app.py`.

### 4.3c Dashboard: `GET /api/dashboard?months=6`
Aggregated from the job store: `totals` (runs, by_status, success_rate, servers_patched, unique_servers_patched, kbs_installed, avg/max run time, servers_needing_attention), `months` (runs by outcome, servers patched, KBs installed per month), `top_kbs`, `attention` (latest state per server that is not READY / PATCHED) and `recent` deployments.

### 4.3d Evidence pack: `POST /api/reports/{job_id}/evidence` → `GET /api/evidence/{evidence_job_id}/download`
For a deployment report. The POST starts a job (kind `evidence`) that copies the run's `Reports\<folder>` files from the jumphost (Summary.json, Validation_KBs.csv, Transcript.txt, State.json). When it has finished, the download returns a zip: README.txt, manifest.json (SHA-256 of every file), the deployment, readiness and environment reports (HTML), the job log, the audit entries, the AD server list (selected servers marked) and `jumphost/*`.

### 4.4 Prerequisites: `POST /api/sccm/prerequisites`  *(Step 2)*
Body: `{ "ad_job_id": "<adJobId>", "servers": ["c03dghhypv8871.dslab.ad.adp.com", "C03DGHHYPV3621"] }`: checks exactly those servers, each of which must be selectable in that AD list (less than 24 h old). Without a body the API checks the allowlist in `Config\TestServers.json` on the jumphost (manual / legacy). Poll kind `prerequisites`. **Keep `job_id` as `precheckJobId`.** **Result** (real data, not file paths):
```json
{
  "success": true,
  "report_folder_name": "20261020_053000Z",
  "server_summary": { "total": 2, "ready": 1, "not_ready": 1, "eligible": 2 },
  "selectable_servers": ["c03dghhypv8871.dslab.ad.adp.com"],
  "servers": [
    { "Server": "c03dghhypv8871.dslab.ad.adp.com", "Eligibility": "ELIGIBLE", "Overall": "READY", "Failed": "", "Warnings": "" },
    { "Server": "c03dghhypv3621.dslab.ad.adp.com", "Eligibility": "ELIGIBLE", "Overall": "NOT READY", "Failed": "Disk", "Warnings": "Reboot pending" }
  ],
  "checks": [
    { "TimestampUtc": "...", "Target": "SCCM", "Check": "Site connection", "Status": "PASS", "Detail": "Site T01 ..." },
    { "TimestampUtc": "...", "Target": "c03dghhypv3621.dslab.ad.adp.com", "Check": "Free disk C: (>= 10 GB)", "Status": "FAIL", "Detail": "6.2 GB free" }
  ],
  "report_headline": "1 of 2 servers READY",
  "report_html_url": "/api/reports/<job_id>/html"
}
```
Check statuses: `PASS`, `FAIL`, `WARN`, `INFO`, `NOT VERIFIED`, `Succeeded`, `Failed`, `Request Timeout`, `ELIGIBLE`, `NOT ELIGIBLE`.

**UI:** summary cards (`server_summary`), the server table, an expandable "checks" list per server (group `checks` by `Target`), and **View report** (HTML).

### 4.5 Select servers  *(Step 3, UI only)*
A checkbox list over `result.servers`:
- `Overall = READY`: selectable, preselected (`selectable_servers`).
- `Overall = NOT READY`: selectable only after a warning ("Failed: Disk. Deploy anyway?"). Then send `include_not_ready_servers: true`.
- `Eligibility = NOT ELIGIBLE`: disabled.

Send the chosen `Server` values (FQDN or short name) as `servers`. The deployment patches exactly these servers: script 04 receives them as `-TargetServers` (no file allowlist).

### 4.6 SUG list: `POST /api/sccm/sugs`  *(Step 4)*
**Body** (optional): `{ "name_filter": "Server", "include_kbs": true }`. `include_kbs: false` lists names only (fast). Poll kind `sugs`.

**Instant list:** `GET /api/sccm/sugs/latest` returns the last list fetched (`{ job_id, finished_at, result }`), or 404 if there is none yet. Show it at once, and offer **Refresh**, which POSTs a new list job.

**Result:**
```json
{
  "success": true,
  "count": 2,
  "sugs": [
    {
      "id": "16778314",
      "name": "Server - Oct 2026",
      "description": "Monthly server updates",
      "created_utc": "2026-10-14T09:12:00.0000000Z",
      "modified_utc": "2026-10-15T11:02:00.0000000Z",
      "deployed": false,
      "update_count": 7,
      "kb_count": 6,
      "expired_count": 0,
      "superseded_count": 1,
      "kbs": ["KB5066835", "KB5066836"],
      "updates": [ { "kb": "KB5066835", "title": "2026-10 Cumulative Update for ...", "ci_id": "17049811", "expired": false, "superseded": false } ],
      "updates_truncated": false,
      "error": null
    }
  ]
}
```
**UI:** a searchable dropdown labelled `name — kb_count KBs (update_count updates)`, with value `id`. Below it, show the selected SUG's `kbs` and `updates`. Warn when `expired_count > 0` (expired updates do not install). `error` set: the update list could not be read for that SUG.

### 4.7 Collection  *(Step 5)*
Two options:
- **Create new** (recommended): a name field. It is sent as `new_collection_name`. The deployment job creates a device collection with **exactly the selected servers**, limited to the jumphost's `LimitingCollectionName` (or the optional `limiting_collection_name`). It waits until SCCM shows the members.
- **Use existing:** `POST /api/sccm/collections` with body `{ "name_filter": "patch", "include_members": true }`, then poll kind `collections`. **Result** `collections[]`: `id`, `name`, `member_count`, `limiting_collection`, `comment`, `members` (only with `include_members`, for collections of up to 50 members). Send `collection_id`. The collection must contain **exactly** the selected servers; otherwise the deployment fails with `No deployment created. Collection '…' does not match the selected servers…`. With `members` loaded, the UI can grey out collections that don't match. `GET /api/sccm/collections/latest` returns the last list fetched.

Distribution: content goes to the jumphost's configured `DistributionPointGroupName` and deployment package. The UI doesn't need to show this.

### 4.8 Deployment: `POST /api/sccm/deployments`  *(Steps 6–8)*

**What it does on the jumphost:**
1. Resolves the SUG by ID. Refuses if the deployment name already exists.
2. Creates the new collection with the selected servers, or checks that the existing one matches them exactly.
3. Runs `04-DeployAndValidatePatches.ps1`, unattended:
   - **Baseline:** servers that are already compliant are skipped.
   - **Content:** downloaded and distributed to the DP group.
   - **Maintenance window:** a one-time UTC window on the collection.
   - **Required deployment:** created with the SOP settings and the deadline.
   - **Install:** waits for the window or deadline and reports the status every 2 minutes.
   - **Restart and validate:** restarts the servers, then validates each KB on each server.

**Headers:** `X-API-Key`, `X-User`, `Content-Type`, **`Idempotency-Key: <uuid>`** (required; see 7.2).

| UI field | Body field | Type | Validation (do it in the UI too) |
|---|---|---|---|
| (from Step 2) | `precheck_job_id` | string | `SUCCEEDED` prerequisites job < 24 h old |
| Server checkboxes | `servers` | string[] | 1–50, from that job's `servers` |
| "Deploy to NOT READY servers" confirmation | `include_not_ready_servers` | bool | default `false` |
| SUG dropdown | `sug_id` | string | numeric ID from 4.6 |
| (display only) | `sug_name` | string | optional, for the record |
| Existing collection | `collection_id` | string | e.g. `T01005ED`. Send **either** this **or** `new_collection_name` |
| New collection name | `new_collection_name` | string | 3–100 chars, letters/digits/space `_ . - ( )`; must not exist |
| Limiting collection (advanced) | `limiting_collection_name` | string | optional, new collection only |
| Deployment name | `deployment_name` | string | 3–100 chars, letters/digits/space `_ . - ( )`; must not exist in SCCM |
| Window start (UTC) | `maintenance_window_start_utc` | ISO UTC | window still open ≥ 30 min from now; start within 30 days |
| Window length | `maintenance_window_hours` | int | 1–24 (default 4; **6–8 recommended** for Windows Server 2025) |
| Deadline (UTC), optional | `deadline_utc` | ISO UTC | empty = as soon as possible (installs when the window opens). If set: not in the past, and **at least 30 min before the window ends**. Installation starts at the later of window start and deadline |
| Restart | `restart_mode` | `"Script"` \| `"Sccm"` \| `"None"` | default `Script` |
| Extra KBs to check | `kb` | string[] | optional, `KB` + 6–8 digits |
| Change ticket / CRQ | `change_ticket` | string | 3–100 chars |
| Approver | `approver` | string | 2–100 chars |
| Approval reference | `approval_reference` | string | 2–200 chars |
| Readiness checkbox | `readiness_confirmed` | bool | must be `true` |
| Re-type the deployment name | `final_confirmation` | string | must **exactly** equal `deployment_name` |

```json
{
  "precheck_job_id": "Pq12rsTU34vwXY56",
  "servers": ["c03dghhypv8871.dslab.ad.adp.com", "c03dghhypv3621.dslab.ad.adp.com"],
  "sug_id": "16778314",
  "sug_name": "Server - Oct 2026",
  "new_collection_name": "Patch Oct 2026 - DSLAB test",
  "deployment_name": "Patch Testing Oct 2026",
  "maintenance_window_start_utc": "2026-10-20T06:00:00Z",
  "maintenance_window_hours": 6,
  "deadline_utc": "2026-10-20T06:30:00Z",
  "restart_mode": "Script",
  "change_ticket": "CHG123",
  "approver": "jdoe",
  "approval_reference": "APR-4567",
  "readiness_confirmed": true,
  "final_confirmation": "Patch Testing Oct 2026"
}
```

**Responses:** `202` + job, or `409` if another deployment holds the lock (section 6; show the banner and keep the form). Poll kind `deployment` with `log_after`.

**Step indicator from the log** (lines start with the number):

| Log line starts with | Stage |
|---|---|
| `SUG:` / `Creating device collection` / `Collection '…' holds exactly` | Preparing (SUG, collection) |
| `1. Connect and run safety gates` | Safety gates |
| `2. Baseline` | Baseline |
| `3. Content` | Content distribution |
| `4. Maintenance window` | Maintenance window |
| `5. Required deployment` | Deployment created |
| `6. Install` | Installing (`Waiting for the maintenance window / deployment deadline …` while waiting) |
| `7. Restart` | Restarting |
| `8. Validate` | Validating |
| `Job finished with status …` | Done |

**Final `result`:**
```json
{
  "success": true,
  "exit_code": 0,
  "deployment_name": "Patch Testing Oct 2026",
  "deployment_created": true,
  "sug": "Server - Oct 2026",
  "collection": "Patch Oct 2026 - DSLAB test",
  "collection_created": true,
  "selected_servers": ["c03dghhypv8871.dslab.ad.adp.com", "c03dghhypv3621.dslab.ad.adp.com"],
  "deadline_utc": "2026-10-20 06:30",
  "report_folder_name": "20261020_055800Z",
  "deployment": { "AssignmentID": 16777301, "StartTime": "...", "EnforcementDeadline": "...", "OverrideServiceWindows": false },
  "maintenance_window": { "Name": "Patch - Patch Testing Oct 2026 - 2026-10-20 06:00 UTC", "StartUtc": "...", "EndUtc": "..." },
  "servers": [
    { "Server": "c03dghhypv8871.dslab.ad.adp.com", "Verdict": "PATCHED", "AlreadyCompliant": false, "InstallState": "INSTALLED",
      "Restarted": true, "RequiredKbsBefore": ["KB5066835"], "MissingKbs": [], "NotFoundKbs": [], "Detail": "..." }
  ],
  "validation": [
    { "Server": "c03dghhypv8871.dslab.ad.adp.com", "KB": "KB5066835", "Title": "...", "SccmStatus": "Installed",
      "Evidence": "Get-HotFix, SCCM client", "Result": "INSTALLED", "Note": "" }
  ],
  "summary": { "Baseline": [ ], "ContentPackages": [ ], "...": "full run summary from the jumphost" },
  "report_headline": "2 of 2 servers PATCHED",
  "report_html_url": "/api/reports/Xy12abCD34efGH56/html",
  "errors": []
}
```
| `servers[].Verdict` | Meaning |
|---|---|
| `PATCHED` | All required KBs installed, no restart pending |
| `PENDING_RESTART` | Installed, restart still needed |
| `NOT_PATCHED` | KBs still missing (`MissingKbs`) |
| `UNVERIFIED` | No data to confirm |

`validation[].Result`: `INSTALLED` / `MISSING` / `NOT_REQUIRED` / `NOT_FOUND` / `UNKNOWN`.

**UI by status:**
- **SUCCEEDED** / **COMPLETED_WITH_ISSUES:** show the final report (4.12) with server cards. For issues, highlight the servers that aren't PATCHED and offer **Resume** after fixing.
- **FAILED:** show `result.errors`. `No deployment created. …` means nothing was deployed. Fix the form and resubmit with a **new** idempotency key. If `collection_created` is true, the collection now exists: select it as an existing collection next time.
- **OUTCOME_UNKNOWN:** see 7.3. The lock stays until it is resumed or released.

### 4.9 Resume: `POST /api/sccm/deployments/resume`
Continues a run that was cut off (API restarted, timeout) or completed with issues. It reuses the collection, window and deployment, keeps the baseline, and carries on with monitoring, restart and validation. **Allowed while an `OUTCOME_UNKNOWN` deployment holds the lock**; that is how the lock is cleared. **Body** (optional): `{ "report_folder": "20261020_055800Z", "restart_mode": "Script" }`. Headers as for deployments (`Idempotency-Key`, `X-User`). Poll kind `deployment_resume`.

### 4.10 Active deployment: `GET /api/sccm/deployments/active`
Not a job; it returns at once and reads only the API's job store. **Poll every 30 s** on every screen to keep the banner and the Deploy button up to date.
```json
{
  "locked": true,
  "state": "RUNNING",
  "can_deploy": false,
  "can_resume": false,
  "deployment_enabled": true,
  "message": "Deployment 'Patch Testing Oct 2026' is in progress, started by Yogesh Soni at 2026-10-20T05:58:01+00:00. A new deployment can start when it has finished.",
  "active_deployment": {
    "job_id": "Xy12abCD34efGH56", "kind": "deployment", "status": "RUNNING",
    "deployment_name": "Patch Testing Oct 2026", "requested_by": "Yogesh Soni",
    "created_at": "...", "started_at": "...", "finished_at": null,
    "servers": ["c03dghhypv8871.dslab.ad.adp.com"],
    "latest_log_line": "  c03dghhypv8871.dslab.ad.adp.com    INSTALLING    SCCM: In progress",
    "latest_log_time": "2026-10-20T06:21:07+00:00",
    "poll_url": "/api/jobs/Xy12abCD34efGH56"
  },
  "last_deployment": { "job_id": "...", "status": "RUNNING", "deployment_name": "...", "requested_by": "...", "finished_at": null, "report_html_url": "..." }
}
```
| `state` | UI |
|---|---|
| `IDLE` | Deploy enabled (if `deployment_enabled`) |
| `QUEUED` / `RUNNING` | Banner "Deployment in progress by {requested_by}", plus `latest_log_line` and a **Watch live log** button (polls `job_id`). Deploy disabled |
| `OUTCOME_UNKNOWN` | Red banner "The last deployment by {requested_by} was interrupted". Buttons: **Resume** and (admins) **Release lock**. Deploy disabled |

### 4.11 Release lock (admin): `POST /api/sccm/deployments/release-lock`
Only for an `OUTCOME_UNKNOWN` deployment, after checking SCCM (4.14). The admin confirms that nothing is still running or that it can be ignored. A `QUEUED`/`RUNNING` job cannot be released.

Headers: `X-API-Key`, **`X-Admin-Key`** (when the API has `SCCM_ADMIN_API_KEY` set), **`X-User`** (required).
```json
{ "job_id": "Xy12abCD34efGH56", "reason": "Checked SCCM: deployment exists, servers patched; validated manually." }
```
`reason`: 10–500 chars. **Response** `200`: `{ "released": true, "job_id": "...", "deployment_name": "...", "released_by": "...", "released_at": "...", "reason": "..." }`. It is recorded in the audit log (`GET /api/audit`) and in that job's log. Errors: `403` wrong admin key, `400` no `X-User`, `409` the lock is held by another job, or the job is still running.

### 4.12 Reports
Every environment check, prerequisites run, deployment and resume is a report. So are folders imported from the jumphost.

| Call | Returns |
|---|---|
| `GET /api/reports?kind=deployment&limit=50&offset=0` | List, newest first. `kind`: `environment`, `prerequisites`, `deployment` (optional) |
| `GET /api/reports/{job_id}` | `{ report_type, job, report, report_html_url }`; `report` is the job's result (data) |
| `GET /api/reports/{job_id}/html` | Self-contained HTML page (inline CSS, no scripts) |
| `GET /api/reports/{job_id}/html?download=true` | Same page, served as a file download |

List item:
```json
{ "job_id": "Xy12abCD34efGH56", "report_type": "deployment", "kind": "deployment", "status": "SUCCEEDED",
  "requested_by": "Yogesh Soni", "deployment_name": "Patch Testing Oct 2026",
  "created_at": "...", "finished_at": "...", "headline": "2 of 2 servers PATCHED",
  "report_folder_name": "20261020_055800Z", "report_url": "/api/reports/...", "report_html_url": "/api/reports/.../html" }
```

**What the HTML shows:**
- **Deployment report:** status banner and summary cards (servers, patched, not patched, already compliant, restarted, KBs installed/missing). Then the overview (deployment, SUG, collection, selected servers, change ticket, approver, requested by, timings), the maintenance window and deadline, and the deployment settings read back from SCCM. Then the server results, the KB validation per server, the baseline, content distribution, a timeline of the stages, and the warnings/errors from the log.
- **Prerequisites report:** summary cards, the server table, and every check grouped by server.
- **Environment report:** the checks table.

**Showing it:** the HTML endpoint needs the `X-API-Key` header, so an `<iframe src>` can't load it directly. Fetch it and use `srcdoc`:
```js
const html = await fetch(BASE_URL + report_html_url, { headers: { "X-API-Key": API_KEY } }).then(r => r.text());
iframe.srcdoc = html;          // or: window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })))
```
For **Download**, fetch `?download=true` and save the blob with the filename from `Content-Disposition`.

**Old reports on the jumphost** (runs made with `Run-Patching.ps1` or before this API version):
1. `POST /api/sccm/reports/jumphost` with body `{ "limit": 50 }`; poll kind `report_list`. The result `reports[]` has `report_folder`, `type` (`deployment`/`prerequisites`/`other`), `created_utc`, `deployment_name`, `sug`, `collection`, `servers`, `patched`, `ready` and `error`.
2. **Import** one: `POST /api/sccm/reports/jumphost/import` with body `{ "report_folder": "20261019_023200Z" }`; poll kind `report_import`. The job is then a report like any other (`GET /api/reports/{job_id}/html`) and appears in `GET /api/reports`.

### 4.13 Jobs and logs
- `GET /api/jobs/{job_id}?wait=N&log_after=M`: polling (2.3–2.5).
- `GET /api/jobs/{job_id}/log?after=-1&limit=5000`: the whole log.
- `GET /api/jobs?limit=20&kind=deployment&requested_by=Yogesh%20Soni`: recent jobs without `result` ("Recent activity").
- `GET /api/audit?limit=100`: deployments started/finished, blocked attempts and lock releases (`ts`, `action`, `user`, `job_id`, `detail`).

### 4.14 Deployment lookup: `POST /api/sccm/deployments/lookup`
Body `{ "deployment_name": "Patch Testing Oct 2026" }`, poll kind `deployment_lookup`. **Result:** `exists` and `deployments[]` (`assignment_id`, `name`, `collection_id`, `start_time`, `deadline`, `enabled`). Use it before releasing a lock.

### 4.15 DSLAB checks (optional)
- `POST /api/dslab/connection-test`: can the API log on to the DSLAB jumphost? **Result:** `host`, `domain`, `run_as`, `powershell`, `active_directory_module`, `sccm_console`.
- `POST /api/dslab/validate-servers` with body `{ "servers": [...], "kb": [...] }`: per server DNS, ping, WinRM, logon/local admin, OS/build, last boot, disk, pending reboot, SCCM client, missing updates and requested KBs. Useful as an extra check before Step 3 or after the deployment.

Both return `503` when the DSLAB account isn't configured (`/health` shows `dslab_jumphost: null`).

### 4.16 Dry run (testing only)
`POST /api/sccm/dry-run/start` (lists SUGs and collections), then `POST /api/sccm/dry-run/continue` with `{ run_id, sug_id, collection_id }` (read-only validation). Not part of the production flow; don't build UI for it.

---

## 5. Converting UI dates to UTC

The API accepts only UTC with a zone.

**A. The user enters UTC (recommended; matches the change ticket).** Label the fields "(UTC)":
```js
const toUtc = (v) => `${v}:00Z`;   // <input type="datetime-local"> "2026-10-20T06:00" → "2026-10-20T06:00:00Z"
```
**B. The user enters local time.** Convert, and show the UTC value next to the field: `new Date(v).toISOString()`.

**Show and check in the UI:**
- Window end = start + `maintenance_window_hours`.
- The window must still be open ≥ 30 min from now.
- Deadline empty = "As soon as possible (when the window opens)".
- A deadline must be ≥ now and ≤ window end − 30 min.
- Installation begins at max(window start, deadline).

---

## 6. One deployment at a time (lock)

- **Held** while a deployment or resume job is `QUEUED` or `RUNNING`, and while the **latest** deployment job is `OUTCOME_UNKNOWN`. In that case the deployment may still exist in SCCM and be installing.
- **Released** when the latest deployment ends `SUCCEEDED`, `COMPLETED_WITH_ISSUES` or `FAILED`, after a successful resume, or when an admin releases it (4.11).
- **Across all users:** the check and the job creation are one atomic step on the server, so two users clicking Deploy at the same moment can't both start one.
- A blocked `POST /api/sccm/deployments` returns **409**:
```json
{
  "detail": {
    "error": "DEPLOYMENT_IN_PROGRESS",
    "message": "Deployment 'Patch Testing Oct 2026' is in progress, started by Yogesh Soni at 2026-10-20T05:58:01+00:00. A new deployment can start when it has finished.",
    "active_deployment": { "job_id": "Xy12abCD34efGH56", "status": "RUNNING", "deployment_name": "Patch Testing Oct 2026",
                           "requested_by": "Yogesh Soni", "created_at": "...", "started_at": "...",
                           "latest_log_line": "...", "latest_log_time": "...", "poll_url": "/api/jobs/Xy12abCD34efGH56" },
    "next_step": "Poll GET /api/jobs/Xy12abCD34efGH56?log_after=-1 to follow it."
  }
}
```
  `error` is `DEPLOYMENT_IN_PROGRESS` (running) or `DEPLOYMENT_OUTCOME_UNKNOWN` (interrupted; resume or release).
- Blocked attempts are recorded in the audit log.
- Checks (environment, prerequisites, SUG list…) keep working while a deployment runs.

**UI:** keep the form filled in, show `detail.message`, a **Watch live log** link (`active_deployment.job_id`), and disable Deploy until `GET /api/sccm/deployments/active` says `can_deploy: true`.

---

## 7. Deployment safety behaviour

### 7.1 Double confirmation
1. The readiness checkbox (`readiness_confirmed`).
2. Re-typing the deployment name (`final_confirmation`). Disable paste in this field.
3. A final modal: "This creates a REQUIRED deployment to {n} servers ({names}). Updates install from {max(start, deadline)} inside the maintenance window {start}–{end} UTC and servers restart." Buttons: Cancel / Deploy.

### 7.2 Idempotency key
- Generate one with `crypto.randomUUID()` **when the user clicks Deploy**. Store it with the form data (state + `sessionStorage`).
- If the POST fails with a network error or timeout, **retry with the same key**. The API returns the original job instead of starting a second run.
- Use a **new key** for a genuinely new attempt (e.g. after `FAILED` and editing the form).
- Reusing a key with a *different* body returns `409` with a **string** `detail`.

### 7.3 OUTCOME_UNKNOWN
1. Warning: "The run was interrupted. The deployment may already be active." Do **not** offer "Deploy again"; the lock prevents it anyway.
2. Offer **Resume** (4.9) with `report_folder` = `result.report_folder_name` if present.
3. Offer **Check in SCCM** (4.14). Admins: **Release lock** (4.11) with a reason.

---

## 8. Error handling

### 8.1 HTTP errors
The body is `{"detail": ...}`. `detail` is a **string** (show it as is), a **list** (HTTP 422: show `loc[1]: msg` for each item) or an **object** (409 lock: section 6).

| Code | Meaning | UI action |
|---|---|---|
| 400 | Invalid input (server not in the precheck / NOT READY / NOT ELIGIBLE, bad SUG ID, collection choice, window, deadline, name, KB, confirmation, missing Idempotency-Key or X-User for release-lock) | Show `detail` next to the form |
| 401 | Wrong or missing API key | "Not authorised"; check configuration |
| 403 | Deployment disabled, or wrong admin key | Show the message |
| 404 | Job/report not found; no `latest` list yet | Restart that step |
| 409 | **Lock** (object `detail`, section 6); precheck job not `SUCCEEDED` / too old / without server results; report job still running; idempotency key reused with a different body | Lock: banner + Watch link. Others: show `detail` |
| 422 | Missing field or wrong type | Show the field errors |
| 503 | DSLAB account not configured | Hide DSLAB checks |
| 5xx / network | Server or connection problem | Retry (polling retries automatically) |

### 8.2 Job errors (`FAILED` / `OUTCOME_UNKNOWN`)
Show `result.errors` **and point to the log**: the last lines usually give the exact cause. Typical messages:
- `Could not open a session on ORDPGBLWTS21 … as GLOBAL\x: …`: the API couldn't log on to the jumphost.
- `[ORDPGBLWTS21 as GLOBAL\svc_patching_auto1] Access is denied`: missing permission (often the folder). Suggest **Connection test**.
- `No deployment created. A deployment named '…' already exists.`: choose another name, or Resume.
- `No deployment created. Collection '…' does not match the selected servers. …`: pick another collection or create a new one.
- `No deployment created. Expected one SCCM device record for '…'`: the server isn't (uniquely) in SCCM.
- `No deployment created. Config\Settings.json on the jumphost has AllowWriteOperations = false.`: writes aren't enabled on the jumphost.
- `Deadline … is not before the maintenance window end …`: choose an earlier deadline.
- `Timed out after N seconds.`: the run exceeded the server limit.

### 8.3 Defensive parsing
PowerShell can serialise a one-item list as a single object. Wrap every list field:
```js
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
```

---

## 9. Reference code (plain JavaScript, any framework)

```js
const BASE_URL = import.meta.env.VITE_SCCM_API_URL ?? "http://127.0.0.1:8000";
const API_KEY = import.meta.env.VITE_SCCM_API_KEY;
const FINAL = ["SUCCEEDED", "COMPLETED_WITH_ISSUES", "FAILED", "OUTCOME_UNKNOWN"];
export const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
let currentUser = "";                                   // set after login
export const setUser = (name) => { currentUser = name; };

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
  get lock() { return typeof this.body?.detail === "object" && this.body.detail?.active_deployment ? this.body.detail : null; }
}

async function api(method, path, { body, headers = {}, signal, raw = false } = {}) {
  const res = await fetch(BASE_URL + path, {
    method, signal,
    headers: {
      "X-API-Key": API_KEY,
      ...(currentUser && { "X-User": currentUser }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw && res.ok) return res;
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const d = data?.detail;
    const msg = typeof d === "string" ? d
      : Array.isArray(d) ? d.map((e) => `${(e.loc || []).slice(1).join(".")}: ${e.msg}`).join("; ")
      : d?.message ?? (d ? JSON.stringify(d) : res.statusText);
    throw new ApiError(res.status, msg, data);
  }
  return data;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

/** Polls a job until final, streaming its log. Returns the final job. */
export async function pollJob(job, { onUpdate, onLog, signal, cursor = -1 } = {}) {
  onUpdate?.(job);
  const cfg = POLL_CONFIG[job.kind];                    // section 2.4
  const stopAt = Date.now() + cfg.timeoutMs;
  let failures = 0;
  if (!FINAL.includes(job.status)) await sleep(cfg.firstDelayMs, signal);
  for (;;) {
    try {
      job = await api("GET", `/api/jobs/${job.job_id}?wait=${cfg.waitSeconds}&log_after=${cursor}`, { signal });
      failures = 0;
      const lines = asArray(job.log);
      if (lines.length) { onLog?.(lines); cursor = job.log_next; }
      onUpdate?.(job);
      if (job.log_more) continue;
      if (FINAL.includes(job.status)) return job;
    } catch (e) {
      if (e.name === "AbortError" || (e instanceof ApiError && e.status < 500)) throw e;
      if (++failures >= 3) throw e;
    }
    if (Date.now() > stopAt) throw Object.assign(new Error("Still running – check again later"), { job, cursor });
    await sleep(cfg.gapMs, signal);
  }
}

// ---- endpoint wrappers ----
export const health            = () => api("GET", "/health");
export const activeDeployment  = () => api("GET", "/api/sccm/deployments/active");
export const getJob            = (id) => api("GET", `/api/jobs/${id}`);
export const getJobLog         = (id, after = -1) => api("GET", `/api/jobs/${id}/log?after=${after}&limit=5000`);
export const listJobs          = (limit = 20) => api("GET", `/api/jobs?limit=${limit}`);
export const connectionTest    = () => api("POST", "/api/sccm/connection-test");
export const environmentCheck  = () => api("POST", "/api/sccm/environment-check");
export const prerequisites     = () => api("POST", "/api/sccm/prerequisites");
export const listSugs          = (opts = {}) => api("POST", "/api/sccm/sugs", { body: { include_kbs: true, ...opts } });
export const latestSugs        = () => api("GET", "/api/sccm/sugs/latest");
export const listCollections   = (opts = {}) => api("POST", "/api/sccm/collections", { body: opts });
export const latestCollections = () => api("GET", "/api/sccm/collections/latest");
export const lookupDeployment  = (name) => api("POST", "/api/sccm/deployments/lookup", { body: { deployment_name: name } });
export const listReports       = (kind, limit = 50, offset = 0) =>
  api("GET", `/api/reports?limit=${limit}&offset=${offset}${kind ? `&kind=${kind}` : ""}`);
export const getReport         = (id) => api("GET", `/api/reports/${id}`);
export const getReportHtml     = async (id) => (await api("GET", `/api/reports/${id}/html`, { raw: true })).text();
export const downloadReport    = async (id) => (await api("GET", `/api/reports/${id}/html?download=true`, { raw: true })).blob();
export const listJumphostReports  = (limit = 50) => api("POST", "/api/sccm/reports/jumphost", { body: { limit } });
export const importJumphostReport = (folder) => api("POST", "/api/sccm/reports/jumphost/import", { body: { report_folder: folder } });
export const auditLog          = (limit = 100) => api("GET", `/api/audit?limit=${limit}`);

export const startDeployment = (f, idempotencyKey) =>
  api("POST", "/api/sccm/deployments", {
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      precheck_job_id: f.precheckJobId,
      servers: f.servers,
      include_not_ready_servers: !!f.includeNotReady,
      sug_id: f.sugId,
      sug_name: f.sugName,
      ...(f.newCollectionName ? { new_collection_name: f.newCollectionName } : { collection_id: f.collectionId }),
      deployment_name: f.deploymentName,
      maintenance_window_start_utc: f.windowStartUtc,
      maintenance_window_hours: f.windowHours,
      ...(f.deadlineUtc && { deadline_utc: f.deadlineUtc }),
      restart_mode: f.restartMode ?? "Script",
      kb: f.kbs?.length ? f.kbs : undefined,
      change_ticket: f.changeTicket,
      approver: f.approver,
      approval_reference: f.approvalReference,
      readiness_confirmed: f.readinessConfirmed,
      final_confirmation: f.finalConfirmation,
    },
  });

export const resumeDeployment = (reportFolder, idempotencyKey) =>
  api("POST", "/api/sccm/deployments/resume", {
    headers: { "Idempotency-Key": idempotencyKey },
    body: reportFolder ? { report_folder: reportFolder } : {},
  });

export const releaseLock = (jobId, reason, adminKey) =>
  api("POST", "/api/sccm/deployments/release-lock", {
    headers: adminKey ? { "X-Admin-Key": adminKey } : {},
    body: { job_id: jobId, reason },
  });
```

### 9.1 Prerequisites → server selection
```js
const pre = await pollJob(await prerequisites(), { onLog: appendLog });
if (pre.status !== "SUCCEEDED") return showErrors(asArray(pre.result?.errors));
setPrecheckJobId(pre.job_id);
setServers(asArray(pre.result.servers));                   // checkbox list
setSelected(asArray(pre.result.selectable_servers));       // READY ones preselected
showReport(await getReportHtml(pre.job_id));               // iframe.srcdoc
```

### 9.2 SUG dropdown (instant, then refresh)
```js
try { setSugs(asArray((await latestSugs()).result.sugs)); } catch (e) { if (e.status !== 404) throw e; }
const fresh = await pollJob(await listSugs());
if (fresh.status === "SUCCEEDED") setSugs(asArray(fresh.result.sugs));
```

### 9.3 Deploy with live log and lock handling
```js
const key = sessionStorage.getItem("deployKey") ?? crypto.randomUUID();
sessionStorage.setItem("deployKey", key);
let started;
try {
  started = await startDeployment(form, key);
} catch (e) {
  if (e.lock) return showLockBanner(e.lock);                // 409: someone else is deploying
  throw e;
}
sessionStorage.setItem("deployJob", started.job_id);
const job = await pollJob(started, { onUpdate: (j) => setStatus(j.status), onLog: (ls) => appendLog(ls.map((l) => l.line)) });
sessionStorage.removeItem("deployKey");
showReport(await getReportHtml(job.job_id));                // the final detailed report
if (job.status === "OUTCOME_UNKNOWN") offerResume(job.result?.report_folder_name);
```

### 9.4 Reopen the running deployment (any user, any time)
```js
const active = await activeDeployment();
if (active.locked && ["QUEUED", "RUNNING"].includes(active.state)) {
  const id = active.active_deployment.job_id;
  const full = await getJobLog(id);
  appendLog(asArray(full.log).map((l) => l.line));
  await pollJob(await getJob(id), { cursor: full.log_next, onLog: (ls) => appendLog(ls.map((l) => l.line)) });
}
```

---

## 10. Integration checklist

- [ ] Base URL and API key from configuration; origin in `SCCM_CORS_ORIGINS`; `X-User` sent on every request
- [ ] Every POST is followed by polling with the per-`kind` settings, **with `log_after`**
- [ ] Live log panel: monospace, auto-scroll, WARNING/ERROR highlighting, download; stage indicator from the log
- [ ] Banner from `GET /api/sccm/deployments/active` on every screen (poll every 30 s); Deploy disabled unless `can_deploy`
- [ ] 409 lock response shows who is deploying, the latest log line and a Watch link; the form is kept
- [ ] Prerequisites: server table, checks per server, HTML report; only READY servers preselected; NOT READY needs confirmation; NOT ELIGIBLE disabled
- [ ] SUG dropdown with KB counts and KB list; instant list from `/sugs/latest` plus refresh
- [ ] Collection: "create new" (name) or "use existing" (must match the selected servers)
- [ ] Window start (UTC) + hours, optional deadline with the 30-minute rule; end and install start shown
- [ ] Readiness checkbox, re-typed name and final modal; idempotency key per attempt, reused on retry
- [ ] Final report shown (srcdoc) with Download; Reports page lists old and new reports and can import jumphost folders
- [ ] `OUTCOME_UNKNOWN`: Resume, Check in SCCM, Release lock (admin, with reason)
- [ ] All list fields go through `asArray()`
