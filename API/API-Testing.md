# SCCM Patching API – Testing Guide (v4)

- **Base URL:** `http://127.0.0.1:8000`
- **Headers:** `X-API-Key: <SCCM_API_KEY>` on every call except `/health`; `X-User: <your name>` (stored as `requested_by`)
- **Collection:** [`SCCM-Patching-API.postman_collection.json`](SCCM-Patching-API.postman_collection.json) (Postman and Thunder Client). Request names start with the step numbers used below.
- Full field-by-field reference: [API-Integration.md](API-Integration.md).

---

## 1. How every call works

Every `POST` starts a **job** and returns **202** at once with `job_id`. Then call `GET /api/jobs/{job_id}?wait=60&log_after=-1` (request **05**) until `status` is final. Pass the returned `log_next` as the next `log_after`. Each response carries the new log lines. The output is in `result`.

| status | Meaning |
|---|---|
| `QUEUED` / `RUNNING` | Waiting / running on the jumphost; watch the log |
| `SUCCEEDED` | Done; read `result`. Deployments: every server PATCHED |
| `COMPLETED_WITH_ISSUES` | Deployments: ran, but not every server is PATCHED |
| `FAILED` | Did not complete; read `result.errors` and the log |
| `OUTCOME_UNKNOWN` | Deployments: cut off after the deployment may exist. **Keeps the deployment lock** until resumed (**11**) or released (**12**) |

Jobs run inside the API process. Closing Postman or the UI does not stop them; stopping the API does.

---

## 2. Call sequence (production flow)

```
01 Health ─► 02 Connection test ─► 05
03 Environment check ─► 05 ─► 16 Report HTML
04 Prerequisites     ─► 05 (READY servers in the console) ─► 16 Report HTML     (sets precheckJobId)
06 SUG list ─► 05 (sets sugId to the first SUG; change it in Variables)         (07 = last list, instant)
08 Collection list (only to use an existing collection)
09 Deployment (servers + SUG + new collection + window + deadline + approvals) ─► 05 … until final
      ├─ 409 → someone else is deploying: 10 Active deployment
      ├─ OUTCOME_UNKNOWN → 11 Resume  (or 13 Lookup, then 12 Release lock)
      └─ final → 16 Report HTML (the detailed deployment report)
14 Reports list ─► 15 / 16 any report;  17 Jumphost reports ─► 18 Import ─► 16
```

---

## 3. Endpoints in the collection

| # | Call | Body / notes | Result |
|---|---|---|---|
| 01 | `GET /health` | no key | `deployment_enabled`, `deployment_lock` (who holds it), `running_deployment_job` |
| 02 | `POST /api/sccm/connection-test` | – | `run_as`, `scripts_folder`, `reports_folder`, `sccm` (`OK` / `FAILED: …`) |
| 03 | `POST /api/sccm/environment-check` | – | `checks[]` (`Check`, `Status`, `Detail`), `report_html_url` |
| 04 | `POST /api/sccm/prerequisites` | – | `servers[]` (`Server`, `Eligibility`, `Overall`, `Failed`, `Warnings`), `checks[]`, `server_summary`, `selectable_servers`, `report_html_url` |
| 05 | `GET /api/jobs/{jobId}?wait=60&log_after={logAfter}` | polling | job + new `log[]` + `result` when final |
| 06 | `POST /api/sccm/sugs` | `{"name_filter": "", "include_kbs": true}` | `sugs[]`: `id`, `name`, `update_count`, `kb_count`, `kbs`, `updates`, `expired_count`, `deployed`… |
| 07 | `GET /api/sccm/sugs/latest` | not a job | last SUG list (404 if none yet) |
| 08 | `POST /api/sccm/collections` | `{"name_filter": "", "include_members": true}` | `collections[]`: `id`, `name`, `member_count`, `members` |
| 09 | `POST /api/sccm/deployments` | see 3.1; needs `Idempotency-Key` | full run; final `result.servers`, `validation`, `summary`, `report_html_url` |
| 10 | `GET /api/sccm/deployments/active` | not a job | `locked`, `state`, `can_deploy`, `message`, `active_deployment` (who, latest log line) |
| 11 | `POST /api/sccm/deployments/resume` | `{"report_folder": "…"}` (optional) | like 09; allowed when the lock is `OUTCOME_UNKNOWN` |
| 12 | `POST /api/sccm/deployments/release-lock` | `{"job_id": "…", "reason": "≥10 chars"}`; `X-Admin-Key` if `SCCM_ADMIN_API_KEY` is set; `X-User` required | `released: true` (logged) |
| 13 | `POST /api/sccm/deployments/lookup` | `{"deployment_name": "…"}` | `exists`, `deployments[]` |
| 14 | `GET /api/reports?kind=&limit=50` | `kind`: environment / prerequisites / deployment | list with `headline`, `report_html_url` |
| 15 | `GET /api/reports/{jobId}` | – | `report` = the data |
| 16 | `GET /api/reports/{jobId}/html` | `?download=true` to save | HTML page; use Postman **Preview** |
| 17 | `POST /api/sccm/reports/jumphost` | `{"limit": 50}` | `reports[]`: jumphost `Reports\<timestamp>` folders |
| 18 | `POST /api/sccm/reports/jumphost/import` | `{"report_folder": "20261019_023200Z"}` | a report job; open it with 16 |
| 19 | `GET /api/jobs/{jobId}/log?after=-1&limit=5000` | – | whole log |
| 20 | `GET /api/jobs?limit=20&kind=&requested_by=` | – | recent jobs |
| 21 | `GET /api/audit` | – | deployments started/finished, blocked attempts, lock releases |
| 22–23 | DSLAB connection test / server validation | as before | – |
| 24–25 | Dry run start / continue | **testing only** | – |

### 3.1 Deployment body (09)
```json
{
  "precheck_job_id": "{{precheckJobId}}",
  "servers": ["c03dghhypv8871", "c03dghhypv3621"],
  "include_not_ready_servers": false,
  "sug_id": "{{sugId}}",
  "new_collection_name": "Patch Oct 2026 - DSLAB test",
  "deployment_name": "Patch Testing Oct 2026",
  "maintenance_window_start_utc": "2026-10-20T06:00:00Z",
  "maintenance_window_hours": 6,
  "deadline_utc": "2026-10-20T06:30:00Z",
  "restart_mode": "Script",
  "change_ticket": "CHG123",
  "approver": "Approver corporate ID",
  "approval_reference": "Approval system reference",
  "readiness_confirmed": true,
  "final_confirmation": "Patch Testing Oct 2026"
}
```
- **Servers** must be in the prerequisites result. If one is `NOT READY`, the API returns 400 unless `include_not_ready_servers` is `true`.
- **Collection:** `new_collection_name` creates a collection with exactly these servers. Alternatively, use `"collection_id": "T01005ED"` for an existing collection with exactly these members.
- **Deadline:** delete the `deadline_utc` line for "as soon as possible". An empty string is a 422 error. If set, it must be at least 30 minutes before the window ends.
- The jumphost's `Config\Settings.json` must have `"AllowWriteOperations": true`, and the API must have `SCCM_ALLOW_DEPLOYMENT=true`.

---

## 4. Testing the lock (two users)

1. In Postman set `user` = `User A`, send **09**, then **05** until `RUNNING`.
2. Set `user` = `User B` and send **09** again. Expected: **409** with `detail.error = "DEPLOYMENT_IN_PROGRESS"` and `detail.active_deployment.requested_by = "User A"`, plus the latest log line.
3. **10** shows `locked: true`, `can_deploy: false` and the message "Deployment '…' is in progress, started by User A …".
4. Close Postman, reopen it, and send **10**, then **05** with the job ID: the job is still running.
5. **21** shows `deployment_started` (User A) and `deployment_blocked` (User B).
6. To test `OUTCOME_UNKNOWN`: stop the API (Ctrl+C) while 09 runs, then start it again. The job is now `OUTCOME_UNKNOWN` and **09** returns 409 `DEPLOYMENT_OUTCOME_UNKNOWN`. Run **13**, then either **11** (resume) or **12** (release, with `adminKey` and a reason). After that, **10** shows `IDLE`.

---

## 5. Postman steps

1. **Import** the collection. In **Variables**, set `apiKey`, `user` (and `adminKey` if the API has `SCCM_ADMIN_API_KEY`) → **Save**.
2. Send **01**, then **02** → **05** until `SUCCEEDED`. Every field should be `OK`.
3. Send **03** → **05**, then **16** (Preview tab) for the environment report.
4. Send **04** → **05**. The console lists the READY servers. Open **16** for the prerequisites report. `precheckJobId` is saved.
5. Send **06** → **05**. `sugId` is set to the first SUG; change it in Variables to the SUG you want (see `result.sugs`).
6. Edit **09**: the servers, `newCollectionName`, `deploymentName`, `windowStartUtc` and `deadlineUtc` (or remove the line). Send it, then keep sending **05** until final. The log streams in the console and in `log[]`.
7. Send **16**: the final deployment report.
8. Old reports: **14**, or **17** → **05**, then **18** with `reportFolder` → **05** → **16**.

Variables set by scripts: `jobId`/`logAfter` (every POST, 05), `precheckJobId` (04), `sugId` (05 after 06), `reportFolder` (05 after a deployment), `lockJobId` (10), `runId` (05 after 24).

**Thunder Client:** import the same file and create an environment with the variables above. Thunder Client may not run the scripts, so copy `job_id` → `jobId` and `log_next` → `logAfter` yourself. Raise the request timeout above 60 s.

---

## 6. Common errors

| Code / message | Meaning |
|---|---|
| 401 `Invalid API key` | Missing or wrong `X-API-Key` |
| 403 | Deployment disabled on the API, or wrong `X-Admin-Key` |
| 400 `… is NOT READY …` | Server failed prerequisites; fix it, or set `include_not_ready_servers` |
| 400 `… was not checked by prerequisites job …` | Server name not in that prerequisites result |
| 400 `deadline_utc must be at least …` | Deadline too close to (or after) the window end |
| 409 object `detail` | Deployment lock: see `detail.message` / `active_deployment` |
| 409 `That prerequisites job has no per-server results` | Run **04** again (job from an older API version) |
| 422 | Missing field or wrong type (e.g. `deadline_utc: ""`) |
| Job `FAILED`: `No deployment created. Collection '…' does not match the selected servers` | Existing collection's members differ; use a new collection |
| Job `FAILED`: `… AllowWriteOperations = false` | Enable writes in the jumphost's `Config\Settings.json` |
| `[ORDPGBLWTS21 as GLOBAL\x] Access is denied` | Folder or SCCM permission problem; run **02** |
