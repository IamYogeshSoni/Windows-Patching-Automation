# SCCM Windows Server Patching Automation — Test Package

## Purpose
A staged PowerShell project for validating two explicitly allowlisted test servers, inspecting SCCM data, and producing a read-only patch dry run. Phase 3 is intentionally **approval-gated and non-executing by default**: this package does not create collections, change SUGs, distribute content, or deploy updates.

## Fixed test allowlist
- `c03dghhypv8871.dslab.ad.adp.com` — `100.78.20.19`
- `c03dghhypv3621.dslab.ad.adp.com` — `100.78.20.12`

The scripts reject targets outside this list. Never add production hosts to the test configuration.

## Environment assumptions (verify before use)
- Run on the approved Windows jumphost with Windows PowerShell 5.1 and appropriate corporate network access.
- AD checks require the Active Directory PowerShell module and permissions to read computer objects.
- SCCM read-only checks use the Configuration Manager PowerShell module on `ORDPGBLSCCM11.global.cdk.com`, site code `T01`, as previously reported. Confirm these values with your SCCM administrator before running.
- The service account's password is never stored in this project. Use interactive credentials / your approved sign-in process.
- Some checks may be `NOT VERIFIED` if permissions, provider methods, client health data, or distribution-point status are unavailable. Unknown is not a pass.

## Start here
1. Extract the ZIP to a local folder on the approved jumphost.
2. Review `Config\Settings.json` and `Config\TestServers.json`.
3. Open Windows PowerShell 5.1 in the project directory.
4. Run:
   ```powershell
   Set-ExecutionPolicy -Scope Process RemoteSigned
   .\Scripts\00-EnvironmentCheck.ps1
   .\Scripts\01-PrerequisiteChecks.ps1
   .\Scripts\02-ReadOnlyDryRun.ps1
   ```
5. Review CSV/JSON outputs under `Reports\<run timestamp>\`.
6. Do not proceed to Phase 3 until the reports have been reviewed and all required approvals are documented.

## Phases
### Phase 1 — prerequisites (read-only)
Checks PowerShell/modules, DNS-to-IP match, ICMP reachability (informational only), AD record when available, SCCM device lookup, and `test-poc` collection presence/membership. It does not create the collection.

### Phase 2 — read-only dry run
Enumerates available SUGs and provides an interactive selection for inspection. `Server - sept 2026` is the suggested initial selection, not deployment approval. It exports available update metadata where supported and creates a dry-run plan. No deployment is created.

### Phase 3 — approval packet only
`03-Prepare-ApprovedPatchTest.ps1` validates an approved plan and generates a confirmation packet for exactly one server. It does **not** deploy. Actual deployment is deliberately not implemented in this package because write access, update approval, distribution-point readiness, maintenance-window scheduling semantics, and deployment settings have not been verified. Have the SCCM administrator implement/approve the write step using your organization's supported deployment procedure.

## Maintenance window
Default suggestion is `06:00–08:00 UTC`. All input/output labels say UTC. SCCM scheduling cmdlets may interpret dates using site/server or console timezone semantics depending on the selected cmdlet and settings; do not convert this window into a live deployment until your SCCM administrator verifies the exact scheduling behavior.

## Important limitations
- Ping timeout does not prove a server is down.
- A successful DNS or ping check does not prove Windows Update/SCCM readiness.
- SUG membership does not prove the updates are applicable, approved for these servers, or distributed to every required DP.
- This package does not infer deployment approval.
- `Commands.xml` and PoshCAT scripts contain actions that can restart/shut down computers, install updates, and modify/repair/uninstall clients. They are not invoked by this project.
- Reports may contain infrastructure identifiers; store them according to company policy.
