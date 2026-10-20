# Configuration

## TestServers.json — allowlist
Only servers listed here with `"Allowed": true` can be patched. Every member of the target
collection must be in this list, and a newly created collection contains exactly these servers.
Change it only with approval.

| Field | Meaning |
|---|---|
| `Fqdn` | Full DNS name; the first label must match the SCCM device name |
| `ExpectedIPv4` | IP the DNS check in 01-PrerequisiteChecks expects |
| `Allowed` | `true` to include the server |

## Settings.json

| Setting | Used by | Meaning |
|---|---|---|
| `SccmSiteServer` | all | SCCM site server |
| `SiteCode` | all | SCCM site code |
| `TargetCollectionName` | 01, 02, 04 | Device collection to patch. If it does not exist, 04 (Full mode) asks for a name and creates it with the allowlisted servers |
| `LimitingCollectionName` | 04 | Limiting collection for a newly created collection (SOP: `DSLAB - All Systems`) |
| `SuggestedSUGName` | 02 | Default SUG offered in the dry run |
| `MaintenanceWindow` | 02 | Shown in the dry-run plan only; 04 takes the window from its parameters |
| `AllowWriteOperations` | 04 | Must be `true` for 04 in Full mode (also for `-WhatIf` previews). Keep `false` until the deployment is approved |
| `DeploymentPackageName` | 04 | Existing software update deployment package that receives updates not yet downloaded |
| `DistributionPointGroupName` | 04 | DP group packages are distributed to when not yet on any DP |
| `OutputRoot`, `RequireADModule`, `RequireSccmModuleForPhase1`, `Phase3ImplementationStatus` | — | Not read by any script (informational) |

Parameters given to the scripts override these settings.
