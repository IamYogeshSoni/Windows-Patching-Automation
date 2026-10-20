# Supplied evidence incorporated into design

Files supplied by the operator included `Commands.xml`, `Start-PoshCAT.ps1`, `SharedFunctions.ps1`, `WorkerFunctions.ps1`, `PoshCAT.log`, `Pinginfo.xlsx`, and sample server lists.

Review observations:
- The PoshCAT XML lists both read-only tasks and potentially disruptive actions such as install missing updates, restart/shutdown computer, client repair/uninstall, WMI reset/salvage, cache deletion, and client setting changes. This project does not invoke PoshCAT or those actions.
- The PoshCAT configuration references a legacy SCCM server value (`HOFPDSASCCM01`); confirm current environment details rather than copying it.
- The supplied log contains historic access-denied, invalid computer-name, and WinRM failures, plus some successful uptime jobs. These are historical diagnostics only and do not verify current host state.
- PingInfo.xlsx is used as a reference for the reachability-report shape; it is not treated as current evidence for the two test targets.
- The supplied AD command was adjusted in this project to correct wildcard syntax and include enabled computer objects. OS version still requires explicit validation before a candidate can pass the Server 2016+ criterion.
